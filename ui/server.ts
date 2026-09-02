/**
 * HTTP + SSE 后端事件桥：把 AgentLoop / runVerified 的 TurnEvent 流暴露给浏览器，
 * 并支持任务提交与审批应答。Node 内置模块，零第三方依赖。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, extname, dirname, delimiter, resolve, basename, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { AgentLoop } from "../src/loop.js";
import {
  configuredExecutionStatus,
  createExecutionBroker,
  parseExecutionPolicy,
} from "../src/execution-broker.js";
import {
  runVerified,
  runPlanned,
  plannedStopReason,
  planParallelWidth,
  createResourceCoordinator,
  AUTO_CONCURRENCY_CAP,
  type VerifiedRunResult,
} from "../src/orchestrate.js";
import { createModelClientFromEnv, type ResolvedProvider } from "../src/provider.js";
import {
  createFallbackClientIfConfigured,
  FallbackModelClient,
  type FallbackInfo,
} from "../src/model-fallback.js";
import { getPack, selectPackTools, PACKS, RULE_PRECEDENCE_DISCIPLINE, type DomainPack } from "../src/presets.js";
import { connectMcpServers, loadMcpConfig, type McpRuntime } from "../src/mcp.js";
import { createWorkdirScopedMemoryTools, MEMORY_TOOL_NAMES } from "../src/memory.js";
import { DEFAULT_VERIFIER_MAX_TURNS } from "../src/verifier.js";
import { resolvePlannerMaxTurns } from "../src/planner.js";
import type { Plan, SubTask } from "../src/planner.js";
import type Anthropic from "@anthropic-ai/sdk";
import { bashTool, SHELL_DESC } from "../src/tools/bash.js";
import { ASK_USER_TOOL_NAME, createAskUserTool } from "../src/tools/ask-user.js";
import {
  FINISH_TASK_TOOL_NAME,
  withTaskCompletion,
} from "../src/task-completion.js";
import { createDescribeImageTool } from "../src/tools/describe-image.js";
import { fetchUrlTool } from "../src/tools/fetch-url.js";
import { readFileTool } from "../src/tools/read-file.js";
import { writeFileTool } from "../src/tools/write-file.js";
import { resolveInWorkdir } from "../src/tools/fs-util.js";
import { appendRunLedger, buildLedgerEntry, ledgerErrorClass, ledgerPath, tallyToolCall, type ToolTally } from "../src/ledger.js";
import {
  RunHistoryWriter,
  historyKeepCount,
  historyRootPath,
  loadArchivedMetas,
  pruneHistory,
  readArchivedEvents,
  readArchivedState,
  readArchivedTranscript,
  readArchivedTrace,
  type ArchivedApprovalGrant,
  type ArchivedCheckpoint,
  type ArchivedMeta,
} from "./history.js";
import {
  initialRunState,
  recoveryActionForPhase,
  transitionRunState,
  type DurablePlanSnapshot,
  type DurableRunState,
  type RunStateEvent,
} from "../src/run-state.js";
import {
  endSpan,
  exportRedactedTrace,
  hashToolSchemas,
  playbackSummary,
  projectTurnEventToSpans,
  resolveGitCommit,
  startSpan,
  type TraceSpan,
} from "../src/trace.js";
import { readFileSync } from "node:fs";
import { EFFORT_LEVELS } from "../src/types.js";
import type {
  ModelClient,
  TurnEvent,
  AgentConfig,
  Tool,
  Effort,
  SharedRunBudget,
  ExecutionBroker,
  ExecutionBoundaryStatus,
} from "../src/types.js";
import type { Verdict } from "../src/verifier.js";

// ------------------------------------------------------
// Types
// ------------------------------------------------------

/**
 * `source` 是自由字符串而非字面量联合：并行编排（runPlanned）的来源形如
 * "s1/main"、"s1/verifier"，本轮虽不接，但契约先放开，避免日后破坏性变更。
 */
interface SSEEvent {
  seq: number;
  source: string;
  /** 服务端接收时刻——审批等待时长 = ts(approval_resolved) − ts(approval_request) */
  ts: number;
  event: Record<string, unknown>;
}

interface PendingApproval {
  toolUseId: string;
  name: string;
  input: unknown;
  /** 规范化 JSON 的 SHA-256；常驻规则只能复用完全相同的输入 */
  inputHash: string;
  /** 当前宿主工具定义的授权上限；客户端不能扩大 */
  grantPolicy: ResolvedApprovalGrantPolicy;
  /** 工具 schema/权限/描述摘要；工具定义变化即失效 */
  toolFingerprint?: string;
  /** 发出该请求的事件 seq —— 审批的唯一键，见 approvalId() */
  requestSeq: number;
  at: number;
  respond: (decision: "allow" | "deny", reason?: string) => void;
}

interface ResolvedApproval {
  decision: "allow" | "deny";
  reason?: string;
  at: number;
}

type ExactInputApprovalRule = ArchivedApprovalGrant;

interface ResolvedApprovalGrantPolicy {
  maxScope: "once" | "exact-input";
  maxTtlMs: number;
  maxUses: number;
}

export const APPROVAL_CANONICALIZATION_VERSION = 1 as const;
export const APPROVAL_GRANT_POLICY_VERSION = 1 as const;
export const DEFAULT_APPROVAL_GRANT_TTL_MS = 15 * 60_000;
export const MAX_APPROVAL_GRANT_TTL_MS = 60 * 60_000;
export const DEFAULT_APPROVAL_GRANT_MAX_USES = 5;
export const MAX_APPROVAL_GRANT_MAX_USES = 100;
export const MAX_APPROVAL_GRANTS_PER_RUN = 100;

/**
 * outcome 值域的唯一事实源（B1 的教训：同一枚举写两处必漂移）。
 * RunEndInfo.outcome 从这里派生；/metrics 按它逐值输出 outcome 标签——
 * 新增一个 outcome 值时这里不加，赋值处直接类型报错，指标不会静默漏一档。
 */
export const RUN_OUTCOMES = ["completed", "partial", "blocked", "error", "closed", "rejected"] as const;

/**
 * token 计数的角色与档位全集（与 RUN_OUTCOMES 同款纪律：唯一事实源 +
 * /metrics 稳定序列集）。role 按事件来源归并：verifier（含 sN/verifier）→
 * verification，planner → planner，describe_image 的视觉调用 → vision，
 * 其余（main / 子任务 / clarifier）→ execution。
 */
export const TOKEN_ROLES = ["execution", "verification", "planner", "vision"] as const;
export const TOKEN_KINDS = ["input", "output", "cache_read", "cache_creation"] as const;

/** 本地日界（操作员心智里的"今天"），YYYY-MM-DD。日预算的翻页判据 */
export function localDayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 把 ModelClient 包成"每次调用把 usage 交给回调"的版本（评审 2026-08-24
 * real-bug：describe_image 拿到 turn 只取文本，usage 原地丢弃——视觉调用发生
 * 在工具执行内部，不经 done/verification 任何记账路径，带 base64 图片的
 * input 动辄数千上万 token，恰是成本告警要抓的对象，却全程隐形）。
 */
export function meterModelClient(
  client: ModelClient,
  onUsage: (u: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }) => void,
): ModelClient {
  return {
    // 三个参数必须原样透传。此前这里只接 `req`：`onDelta` 被吞掉等于 Web 上
    // 没有流式（直播条与对话末尾的实时段全空），`signal` 被吞掉等于停止按钮
    // 掐不掉在飞的那个请求——ModelClient 的签名注释里写得很清楚"没有它，
    // 停止就只是句空话"。装饰器最容易犯的错就是收窄被装饰者的契约。
    send: async (req, onDelta, signal) => {
      const turn = await client.send(req, onDelta, signal);
      onUsage({
        inputTokens: turn.usage.input_tokens,
        outputTokens: turn.usage.output_tokens,
        cacheReadTokens: turn.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: turn.usage.cache_creation_input_tokens ?? 0,
      });
      return turn;
    },
  };
}

/** run 级终止信息，由 startPlainRun/startVerifiedRun 算出后交给 finalizeRun */
interface RunEndInfo {
  /**
   * closed = 宿主关停导致的终止（run 本身没跑完），与 run 自己跑完区分开；
   * rejected = 计划确认门被否决——**不是 error**：那是委托方的决定，不是失败。
   * 混进 error 会让界面说谎（V-04 的教训：stopReason 不能压值域）。
   */
  outcome: (typeof RUN_OUTCOMES)[number];
  mainStopReason?: string;
  /**
   * 经 ledgerErrorClass（= classifyApiError 首行）后的错误类。
   * stopReason=error / execution_unavailable 时必填——台账靠它做失败 taxonomy。
   */
  error?: string | null;
}

interface StoredRun {
  id: string;
  task: string;
  status: "running" | "done";
  verify: boolean;
  createdAt: number;
  finishedAt?: number;
  events: SSEEvent[];
  /**
   * 键是 approvalId（`toolUseId#requestSeq`）而非裸 toolUseId：返工轮会复用同一个
   * toolUseId，按裸 id 存会让后一轮覆盖前一轮，应答时也无法区分是哪一轮的卡片。
   */
  pendingApprovals: Map<string, PendingApproval>;
  respondedApprovals: Map<string, ResolvedApproval>;
  /** 裸 toolUseId 维度的已应答集合，仅用于 409 判定（兼容不带 #seq 的旧式请求） */
  respondedToolUseIds: Set<string>;
  sseClients: Set<ServerResponse>;
  /** 段计数：每个 main/rework 的 done 递增一次，用于把日志按段归属 */
  segmentIndex: number;
  /** 核查运行的完整结果（含 executionUsage / reworks / 全部裁决），run_end 用 */
  outcome?: VerifiedRunResult;
  /**
   * 本 run（single/verified 模式）在宿主级资源表里整体持有的独占标签——
   * 准入时按包声明占用，finalize 释放。plan 模式不走这里：资源按子任务
   * 粒度由调度器经同一张表管理。
   */
  heldResources?: string[];
  /** 最终交付那一段的终止原因，列表接口直接读（不必等客户端订阅） */
  mainStopReason?: string;
  /**
   * 逐段完整会话（V-23）。`done` 事件的 result.messages 一直存在，只是从没
   * 透出过——SSE 里只带 messageCount，几 MB 的会话不能进事件缓冲。
   * 存在这里供 GET /api/runs/:id/transcript 按需拉。
   */
  transcript: { index: number; source: string; messages: unknown[] }[];
  /**
   * 按角色分的工具调用直方图（L6 运行台账）。
   * 在事件旁路里逐条累加，而不是收尾时回扫 `run.events`——续跑会让
   * 事件缓冲跨越多段，回扫容易把上一段的数重复计进来。
   */
  toolTally: ToolTally;
  /** 核查是否撞过轮次上限（"预算不够"这个嫌疑要有据可查，见案例 #8 的三层归因） */
  verifierHitBudget?: boolean;
  /** 本 run 主执行者换端点的次数（MODEL-01a）。未配降级链时恒 0 */
  fallbacks?: number;
  /**
   * 中止闸。**逐 run 一个**——停止的是这一次运行，不是整个宿主。
   * 人按下停止即 abort()，编排层把它传给 AgentLoop，循环在下一次模型调用
   * 之前收手。已经在飞的那个请求不撤（HTTP 已经发出去了，钱已经花了），
   * 所以"停止"的准确语义是**不再往下走**，不是"当场消失"。
   */
  abort?: AbortController;
  /** SAFE-05：逐 run 固定，绝不把全局 bashTool 变成共享可变执行域。 */
  executionBroker?: ExecutionBroker;
  /** 最近一次功能探测/执行边界状态，进入 run_config 与持久事件。 */
  executionBoundaryStatus?: ExecutionBoundaryStatus;
  /**
   * 当前活 run 内的精确输入放行 grant。
   *
   * 四条边界，缺一条这个功能就从"省事"变成"把审批门拆了"：
   *   ① **逐 run**，archive fork/new run 绝不继承 active grant；
   *   ② 键绑定 **工具名 + 规范化输入 SHA-256**。同名 bash 换 command、写文件换
   *      path、硬件工具换 device 都必须重新审批；仅对象 key 顺序不同可以复用；
   *   ③ 固定 TTL + 最大使用次数，工具定义 fingerprint 改变立即失效；
   *   ④ 自动放行**照样进事件流**（actor: "auto-rule"），且留下 grantId/hash。
   */
  autoAllow?: Map<string, ExactInputApprovalRule>;
  /** 本次运行的装配（V-24：可逐 run 覆盖，不再是进程级常量） */
  packName?: string;
  effort?: Effort;
  rubric?: string;
  /** V-27：编排模式。plan = 走 runPlanned（planner 拆解 + 依赖调度 + 并行） */
  mode?: "single" | "plan";
  concurrency?: number | "auto";
  /**
   * V-28 多轮对话：会话正史与复用的 loop 实例。
   *
   * loop 留着而不是每轮新建，是为了让 ContextManager 的水位记忆延续——
   * 新建实例的 lastInputTokens 归零，压缩判据会在续跑第一轮失准。
   */
  loop?: AgentLoop;
  history?: Anthropic.MessageParam[];
  /** 已进行的对话轮数（第 1 轮 = 建 run 时那次提交） */
  conversationTurn: number;
  /** V-29：本次运行的工作目录（工具写入圈禁根），必来自白名单 */
  workdir?: string;
  /** V-30：本次运行是否启用已配置的独立角色模型 */
  useVerifierModel?: boolean;
  usePlannerModel?: boolean;
  /**
   * 计划确认门（backlog §5.1）：planner 出计划后阻塞，等委托方批准才开跑。
   *
   * **默认关**，逐 run 显式开。不默认开的理由是宿主也被脚本化驱动（eval、
   * 契约测试、无人值守跑批）——默认阻塞会把那些场景全部挂死，而"挂死等人"
   * 正是 V-01 修掉的那类失效。
   *
   * 语义上这是 docs 里"一人公司"那条路线的签字位：人上移为定义任务、
   * 定验收标准、担责，可程序化的执行交给 agent。`runPlanned` 的 onPlan
   * 本来就是 await 的（orchestrate.ts），文档字符串写着"宿主可展示计划、
   * 做人工把关"——harness 侧零改动，缺的一直只是宿主接这条线。
   */
  planGate?: boolean;
  /** 计划门挂起态；同一 run 至多一次（计划只出一次，不像审批会跨返工轮复用） */
  pendingPlan?: PendingPlan;
  planDecision?: { decision: "approve" | "reject"; at: number };
  /**
   * §5.2：给执行者装 `ask_user`。**默认关**（决定 1）——宿主也被脚本化驱动，
   * 默认开会让无人值守的运行挂死等一个不会来的人。
   */
  askUser?: boolean;
  /** 当前提问挂起态；计划并发下其它提问进入 questionQueue，不能覆盖这一项。 */
  pendingQuestion?: PendingQuestion;
  /** 多执行者并发调用 ask_user 时的宿主级串行队列。 */
  questionQueue?: QueuedQuestion[];
  /**
   * 本 run 的 ask_user 工具实例。**必须缓存**：配额是逐实例计数的，
   * buildConfig 每次新造一个等于配额永远用不完（决定 2 当场作废）。
   */
  askUserTool?: Tool;
  // ---- B2 运行历史落盘 ----
  /** 本次进程内的落盘写入器；无历史根或显式关闭时缺省（history 一名已被会话正史占用） */
  archiveWriter?: RunHistoryWriter;
  /** true = 从磁盘恢复的归档运行：父档案只读；有检查点时可派生新 run 续跑。 */
  archived?: true;
  /** 归档目录（events/transcript 按需读的来源） */
  archiveDir?: string;
  /** 归档的懒加载：首次访问 events/transcript 时才付读盘代价，且只付一次 */
  hydration?: Promise<void>;
  /** 归档的裁决摘要（列表列用）；活 run 走 outcome，两者在 runSummary 合流 */
  archivedOutcome?: { finalPassed: boolean | null; reworks: number | null; verdict: Verdict | null };
  /** 最近一个完整 main 段的可恢复检查点；归档本身保持只读，续跑会派生新 run。 */
  checkpoint?: ArchivedCheckpoint;
  /** 从 checkpoint 恢复的只读授权审计；永不装进 autoAllow。 */
  archivedApprovalGrantAudit?: ArchivedApprovalGrant[];
  /** 派生谱系。continuedFrom 是直接父级，rootRunId 是最初祖先。 */
  continuedFrom?: string;
  rootRunId?: string;
  /** 仅供刚派生的新 run 装配首轮；完成后 checkpoint 会从真实 done 事件重建。 */
  resumeBudget?: SharedRunBudget;
  initialContextInputTokens?: number;
  /**
   * RUN-01 / ADR-003：进程内 Durable RunState 游标；与 `state.json` 同步。
   * 归档恢复只读；崩溃相按 recoveryActionForPhase 收成 closed/interrupted，
   * **从不**把 archived 冒充成可同 run 热续跑。
   */
  durableState?: DurableRunState;
  // ---- OBS-01 trace ----
  /** 本 run 根 span id；子 span 挂在其下 */
  traceRunSpanId?: string;
  /** tool_call → tool_result 开闭配对 */
  openToolSpans?: Map<string, TraceSpan>;
}

interface PendingPlan {
  requestSeq: number;
  at: number;
  /** 由 waitForPlanDecision 装填：应答或过期时结束等待 */
  settle: (decision: "approve" | "reject" | "expired") => void;
}

/**
 * §5.2 需求澄清的挂起态。与计划门同构（同一套挂起/应答/过期三事件），
 * 但**可以出现多次**——配额内每问一次挂一次，所以带 `id` 区分。
 */
interface PendingQuestion {
  id: string;
  requestSeq: number;
  at: number;
  /** 一次打断里的一组问题（决定 6）——贵的是打断人，不是问题本身 */
  questions: { question: string; options: string[]; fallback: string }[];
  /**
   * 逐题答复，与 questions 对齐；整体 null = 这次打断没得到任何应答。
   * **都不是错误**——见 ask-user.ts 决定 4。
   */
  settle: (answers: (string | null)[] | null) => void;
}

interface QueuedQuestion {
  questions: PendingQuestion["questions"];
  resolve: (answers: (string | null)[] | null) => void;
}

/** 计划被否决的哨兵——不是错误，是决定，所以要与 error 路径区分开 */
class PlanRejectedError extends Error {
  constructor(readonly cause_: "rejected" | "expired") {
    super(cause_ === "rejected" ? "计划被委托方否决" : "计划确认门未应答即结束");
    this.name = "PlanRejectedError";
  }
}

/**
 * 计划门两种收场的 stopReason：否决与未应答必须分开——没人拒绝过的计划
 * 不能写成"未获批准"（把宿主收尾说成委托方的决定，V-04 同族）。
 * 提成纯函数是因为 expired 的唯一触发路径是宿主关停：SSE 已断、HTTP 已关，
 * 集成测试观测不到那条缓冲事件，只能在这一层钉住映射（B2 落盘后它会浮出水面）。
 */
export function planGateStopReason(
  cause: "rejected" | "expired",
): "plan_rejected" | "plan_gate_expired" {
  return cause === "expired" ? "plan_gate_expired" : "plan_rejected";
}

/** 审批唯一键：同一 toolUseId 在返工轮再次出现时，靠 requestSeq 区分 */
function approvalId(toolUseId: string, requestSeq: number): string {
  return `${toolUseId}#${requestSeq}`;
}

/**
 * 递归规范化 JSON：对象键逐层排序，数组顺序保持不变。
 *
 * 先走一次原生 JSON 序列化/解析，是为了继承 JSON 对 undefined、稀疏数组、
 * -0 等边界的既有语义；循环引用、BigInt 等非 JSON 输入继续抛错并 fail closed。
 * 工具输入来自模型 JSON 协议，正常路径不会包含这些非 JSON 值。
 */
export function canonicalizeApprovalInput(input: unknown): string {
  const json = JSON.stringify(input);
  if (json === undefined) throw new TypeError("Approval input must be JSON-serializable");
  const normalized = JSON.parse(json) as unknown;

  const encode = (value: unknown): string => {
    if (value === null || typeof value !== "object") {
      const primitive = JSON.stringify(value);
      if (primitive === undefined) throw new TypeError("Approval input must contain JSON values only");
      return primitive;
    }
    if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`)
      .join(",")}}`;
  };

  return encode(normalized);
}

/** 审计字段只哈希输入；运行期规则键另行绑定工具名，避免同参数跨工具串权。 */
export function approvalInputHash(input: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalizeApprovalInput(input)).digest("hex")}`;
}

/** 长度前缀避免工具名与 hash 的字符串拼接出现边界歧义。 */
export function exactInputApprovalKey(name: string, inputHash: string): string {
  return `${name.length}:${name}:${inputHash}`;
}

/** 工具定义变化后旧 grant 必须失效；摘要不包含 execute 函数或任何 secret。 */
export function approvalToolFingerprint(tool: Tool): string {
  const definition = canonicalizeApprovalInput({
    policyVersion: APPROVAL_GRANT_POLICY_VERSION,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    permission: tool.permission,
    parallelSafe: tool.parallelSafe,
    approvalPolicy: tool.approvalPolicy ?? { maxScope: "once" },
  });
  return `sha256:${createHash("sha256").update(definition).digest("hex")}`;
}

/**
 * verifier 来源判定。写成前缀/后缀两用是为并行编排预留——那里的来源形如
 * "s1/verifier"，若只比对字面量 "verifier"，子任务的 verifier 审批会被
 * 错误地挂进待办表，而它内部已自答 → 双响。
 */
function isVerifierSource(source: string): boolean {
  return source === "verifier" || source.endsWith("/verifier");
}

/** planner/verifier 都在各自 drain 循环里自答 deny；宿主不得抢答或为其建 grant。 */
function isInternallyResolvedApprovalSource(source: string): boolean {
  return isVerifierSource(source) || source === "planner" || source.endsWith("/planner");
}

/** decodeURIComponent 对畸形百分号编码会抛错——路径参数是外部输入，不能让它炸掉请求 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export interface UiServerOptions {
  modelClient?: ModelClient;
  workdir?: string;
  /**
   * V-29：允许逐 run 选择的工作目录白名单。
   *
   * 为什么是白名单而不是自由输入：workdir 同时是**工具的写入圈禁边界**
   * （ToolExecutor 拿它当根）。让浏览器随意指定等于让任何能访问 UI 的人
   * 往任意目录写文件。按 P6「护栏是宿主的责任」，合法集合由宿主在启动时
   * 声明，浏览器只在其中选。缺省 = 只有 workdir 一个。
   */
  workdirs?: string[];
  packName?: string;
  /** 测试注入：覆盖默认工具池 */
  tools?: Tool[];
  /**
   * L6 运行台账落点。缺省行为见 `ledgerFile` 的注释：
   * **注入了 modelClient 就默认不记**（那是假模型的路径，记了就是假证据）。
   * `false` = 显式关闭；字符串 = 指定文件。
   */
  ledger?: false | string;
  /**
   * B2 运行历史落点（每 run 一个目录）。缺省逻辑同 `ledger`：注入了
   * modelClient 就默认不存（测试与脚本驱动的运行不该污染真档案）。
   * `false` = 显式关闭；字符串 = 指定根目录。
   */
  history?: false | string;
  /** 历史保留数（判据③），缺省 env AGENT_RUN_HISTORY_KEEP > DEFAULT_HISTORY_KEEP */
  historyKeep?: number;
  /** exact-input grant 的宿主级硬 TTL；工具还可声明更短上限。 */
  approvalGrantTtlMs?: number;
  /** exact-input grant 可自动复用的宿主级次数上限。 */
  approvalGrantMaxUses?: number;
  /** 仅供确定性测试；授权安全判断不得复用客户端时间。 */
  approvalClock?: () => number;
  /**
   * 主执行者是否必须调用 finish_task。真实宿主默认开；注入 fake model 的测试默认关，
   * 需要验证该能力的测试显式传 true，避免改写数百条旧脚本的 wire 预期。
   */
  taskCompletion?: boolean;
  /** API 访问令牌。false = 即使环境里配置了也显式关闭（只建议注入测试）。 */
  accessToken?: string | false;
  /** 可跨源调用 API 的精确 Origin 白名单；同源请求天然允许。 */
  allowedOrigins?: string[];
  /** 可信 Host/X-Forwarded-Host 名单（仅主机名，不带端口）；用于阻断 DNS rebinding。 */
  allowedHosts?: string[];
  /** 单个 HTTP 请求体硬上限；真实宿主默认 32 MiB（覆盖 20 MiB 文件上传的 base64 开销）。 */
  requestBodyMaxBytes?: number;
  /** 同时处于 running 的 run 上限；真实宿主默认 4。 */
  maxActiveRuns?: number;
  /**
   * 宿主级日 token 预算（非 cache_read 口径，与成本告警同口径）。超限后**新的
   * 执行准入**（新建 run / 追问续跑 / 归档派生）一律 429，在飞 run 永不掐；
   * 本地日翻页自动恢复。缺省不启用——这是操作员的显式防线，不是隐形限速。
   * 进程态计数：宿主重启当日账本归零（与 /metrics 同边界，runbook 已写明）。
   */
  dailyTokenBudget?: number;
  /**
   * 同 workdir 并发 run 时拒绝新准入（缺省只在运维日志告警）。
   * workdir 同时是写入圈禁边界，两个并发 run 互踩产物是静默数据损坏。
   * env: AGENT_UI_EXCLUSIVE_WORKDIR=1（仅 realHost 读取）。
   */
  exclusiveWorkdir?: boolean;
  /** 内存中保留的运行（含事件/正文）上限；磁盘历史仍按 historyKeep 独立保留。 */
  maxStoredRuns?: number;
  /** 单一远端地址每分钟可发出的 POST 数；真实宿主默认 120。 */
  mutationRateLimitPerMinute?: number;
  /** 优雅关停等待历史/MCP/连接的最长时间。 */
  shutdownTimeoutMs?: number;
  /** SSE 注释心跳间隔；防止反向代理在长模型空窗中回收连接。 */
  sseHeartbeatMs?: number;
  /** 是否把任意命令执行工具装进工具面；远程宿主应由 launcher 默认关闭。 */
  enableBash?: boolean;
  /** SAFE-05 测试/宿主注入：每个 run 必须得到独立、绑定 runId/workdir 的 broker。 */
  executionBrokerFactory?: (runId: string, workdir: string) => ExecutionBroker;
  /** 启动/readiness 功能探针注入；缺省由同一 factory 创建。 */
  executionProbeBroker?: ExecutionBroker;
  /**
   * 独立于 modelClient 的执行策略注入口。安全语义绝不能用“是否注入模型”推断；
   * 测试若要隔离宿主环境，应显式传 `{ AGENT_EXECUTION_ISOLATION: "off" }`。
   */
  executionEnv?: NodeJS.ProcessEnv;
  /**
   * 端点降级链（MODEL-01a）的配置源。与 `executionEnv` 同一条仪器纪律：
   * **不用"是否注入了 modelClient"去推断该不该武装这条防线**。
   * 测试要么显式传一份自己的 env，要么就得接受宿主 `.env` 里那条真实链——
   * 后者意味着一次瞬时错误会把假模型的请求转发到真端点上去。
   */
  fallbackEnv?: NodeJS.ProcessEnv;
  /** 只在宿主确实位于可信反向代理之后时读取 X-Forwarded-Proto/Host。 */
  trustProxy?: boolean;
}

/**
 * stopReason → run 级结果必须 fail-closed。只有明确的 completed 才能标绿；新增
 * stopReason 若尚未在这里分类，会安全地落到 error，而不是被默认冒充完成。
 */
export function runOutcomeForStopReason(reason?: string): RunEndInfo["outcome"] {
  switch (reason) {
    case "completed":
      return "completed";
    case "partial":
      return "partial";
    case "blocked":
      return "blocked";
    case "aborted":
    case "plan_gate_expired":
      return "closed";
    case "plan_rejected":
      return "rejected";
    default:
      return "error";
  }
}

/** Plan → DurablePlanSnapshot（DAG 边 = dependsOn）。 */
export function durablePlanFromPlan(
  plan: Plan,
  protocol: DurablePlanSnapshot["protocol"] = "freeform",
): DurablePlanSnapshot {
  const edges: Record<string, string[]> = {};
  for (const t of plan.subtasks) {
    edges[t.id] = [...(t.dependsOn ?? [])];
  }
  return {
    protocol,
    taskIds: plan.subtasks.map((t) => t.id),
    edges,
    approvedAt: null,
    rejectedAt: null,
  };
}

/**
 * 崩溃档案按 ADR-003 表收成终态：不恢复 grant、不热续跑。
 * 返回应用后的 state（调用方落盘）；只读相原样返回。
 */
export function recoverDurableStateOnCrash(
  state: DurableRunState,
  at = Date.now(),
): DurableRunState {
  const action = recoveryActionForPhase(state.phase);
  if (action === "readonly") return state;
  if (action === "close_archive") {
    return transitionRunState(state, { type: "close" }, at) ?? { ...state, phase: "closed", updatedAt: at };
  }
  return (
    transitionRunState(state, { type: "interrupt" }, at) ?? {
      ...state,
      phase: "interrupted",
      updatedAt: at,
      pendingApprovalIds: [],
      pendingQuestionIds: [],
    }
  );
}

export interface UiServerHandle {
  server: Server;
  close(): Promise<void>;
}

// ------------------------------------------------------
// Helpers
// ------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, "public");
const PHOSPHOR_RELATIVE = join("@phosphor-icons", "web", "src", "regular");
const PHOSPHOR_DIR = [
  // 源码态：<repo>/ui/server.ts → <repo>/node_modules
  join(__dirname, "..", "node_modules", PHOSPHOR_RELATIVE),
  // 编译态：<repo>/dist/ui/server.js → <repo>/node_modules
  join(__dirname, "..", "..", "node_modules", PHOSPHOR_RELATIVE),
  // npm 安装后从包根启动时的兜底
  join(process.cwd(), "node_modules", PHOSPHOR_RELATIVE),
].find((candidate) => existsSync(candidate))
  ?? join(__dirname, "..", "node_modules", PHOSPHOR_RELATIVE);

/**
 * UI 图标走本地、固定版本的 Phosphor 字体，不依赖运行时 CDN。
 *
 * 这里只暴露实际用到的四个静态文件；不能把 node_modules 整棵目录挂到 HTTP
 * 根下。这样既保留离线可用性，也不把依赖包里的源码与元数据意外暴露出去。
 */
const VENDOR_STATIC = new Map<string, string>([
  ["vendor/phosphor/style.css", join(PHOSPHOR_DIR, "style.css")],
  ["vendor/phosphor/Phosphor.woff2", join(PHOSPHOR_DIR, "Phosphor.woff2")],
  ["vendor/phosphor/Phosphor.woff", join(PHOSPHOR_DIR, "Phosphor.woff")],
  ["vendor/phosphor/Phosphor.ttf", join(PHOSPHOR_DIR, "Phosphor.ttf")],
]);

function firstForwarded(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim() || undefined;
}

function requestAuthority(req: IncomingMessage, trustProxy = false): string | undefined {
  return trustProxy
    ? firstForwarded(req.headers["x-forwarded-host"]) ?? req.headers.host
    : req.headers.host;
}

function requestHostname(req: IncomingMessage, trustProxy = false): string | null {
  const authority = requestAuthority(req, trustProxy);
  if (!authority) return null;
  try {
    return new URL(`http://${authority}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");
}

function sameOriginOf(req: IncomingMessage, trustProxy = false): string | null {
  const host = requestAuthority(req, trustProxy);
  if (!host) return null;
  const encrypted = Boolean((req.socket as typeof req.socket & { encrypted?: boolean }).encrypted);
  const forwardedProto = trustProxy ? firstForwarded(req.headers["x-forwarded-proto"]) : undefined;
  const protocol = forwardedProto === "https" || forwardedProto === "http"
    ? forwardedProto
    : encrypted ? "https" : "http";
  return `${protocol}://${host}`;
}

function originAllowed(
  req: IncomingMessage,
  allowedOrigins: readonly string[],
  trustProxy = false,
): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // CLI/native clients do not send Origin; token still applies separately.
  return origin === sameOriginOf(req, trustProxy)
    || allowedOrigins.includes("*")
    || allowedOrigins.includes(origin);
}

function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigins: readonly string[],
  trustProxy = false,
): void {
  const origin = req.headers.origin;
  if (!origin || !originAllowed(req, allowedOrigins, trustProxy)) return;
  if (allowedOrigins.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin !== sameOriginOf(req, trustProxy) && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Last-Event-ID, X-Agent-Token",
  );
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

function readHarnessVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const HARNESS_VERSION = readHarnessVersion();

class RequestBodyTooLargeError extends Error {}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      reject(new RequestBodyTooLargeError(`Request body exceeds ${maxBytes} bytes`));
      return;
    }
    req.on("data", (value: Buffer | string) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > maxBytes) {
        settled = true;
        chunks.length = 0;
        reject(new RequestBodyTooLargeError(`Request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function notFound(res: ServerResponse, detail?: string): void {
  json(res, 404, { error: detail ?? "Not found" });
}

function badRequest(res: ServerResponse, detail: string): void {
  json(res, 400, { error: detail });
}

function requestBodyFailure(res: ServerResponse, error: unknown): void {
  if (error instanceof RequestBodyTooLargeError) {
    json(res, 413, { error: error.message });
    return;
  }
  badRequest(res, "Failed to read request body");
}

function secureStringEqual(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join("="));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function requestAccessToken(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  const explicit = req.headers["x-agent-token"];
  if (typeof explicit === "string") return explicit;
  return cookieValue(req, "agent_ui_access");
}

function operationalLog(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

const SHA256_FIELD = /^sha256:[0-9a-f]{64}$/;

/** meta/checkpoint 是外部输入；坏 grant 逐条丢弃，绝不影响普通会话恢复。 */
function archivedApprovalGrantFromUnknown(value: unknown): ArchivedApprovalGrant | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    raw.canonicalizationVersion !== APPROVAL_CANONICALIZATION_VERSION ||
    raw.policyVersion !== APPROVAL_GRANT_POLICY_VERSION ||
    typeof raw.grantId !== "string" || raw.grantId.length < 1 || raw.grantId.length > 128 ||
    typeof raw.approvalId !== "string" || raw.approvalId.length < 1 || raw.approvalId.length > 512 ||
    typeof raw.boundRunId !== "string" || raw.boundRunId.length < 1 || raw.boundRunId.length > 128 ||
    raw.scope !== "run" ||
    typeof raw.name !== "string" || raw.name.length < 1 || raw.name.length > 512 ||
    raw.inputScope !== "exact-input" ||
    typeof raw.inputHash !== "string" || !SHA256_FIELD.test(raw.inputHash) ||
    typeof raw.toolFingerprint !== "string" || !SHA256_FIELD.test(raw.toolFingerprint) ||
    !nonNegativeInteger(raw.issuedAt) ||
    !nonNegativeInteger(raw.expiresAt) ||
    raw.expiresAt <= raw.issuedAt ||
    !nonNegativeInteger(raw.maxUses) || raw.maxUses < 1 || raw.maxUses > MAX_APPROVAL_GRANT_MAX_USES ||
    !nonNegativeInteger(raw.usedUses) || raw.usedUses > raw.maxUses
  ) {
    return undefined;
  }
  return {
    version: 1,
    canonicalizationVersion: APPROVAL_CANONICALIZATION_VERSION,
    policyVersion: APPROVAL_GRANT_POLICY_VERSION,
    grantId: raw.grantId,
    approvalId: raw.approvalId,
    boundRunId: raw.boundRunId,
    scope: "run",
    name: raw.name,
    inputScope: "exact-input",
    inputHash: raw.inputHash,
    toolFingerprint: raw.toolFingerprint,
    issuedAt: raw.issuedAt,
    expiresAt: raw.expiresAt,
    maxUses: raw.maxUses,
    usedUses: raw.usedUses,
  };
}

/** meta.json 是可被手工修改的外部输入；恢复前不能只信 TypeScript cast。 */
function checkpointFromUnknown(value: unknown): ArchivedCheckpoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const budget = raw.runBudget;
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) return undefined;
  const b = budget as Record<string, unknown>;
  if (
    !nonNegativeInteger(raw.segmentIndex) ||
    !nonNegativeInteger(raw.conversationTurn) ||
    raw.conversationTurn < 1 ||
    !nonNegativeInteger(raw.contextInputTokens) ||
    !nonNegativeInteger(b.usedTurns) ||
    !nonNegativeInteger(b.usedTokens) ||
    (b.maxTurns !== undefined && (!nonNegativeInteger(b.maxTurns) || b.maxTurns < 1)) ||
    (b.maxTokens !== undefined && (!nonNegativeInteger(b.maxTokens) || b.maxTokens < 1))
  ) {
    return undefined;
  }
  const approvalGrants = Array.isArray(raw.approvalGrants)
    ? raw.approvalGrants
        .slice(0, MAX_APPROVAL_GRANTS_PER_RUN)
        .map(archivedApprovalGrantFromUnknown)
        .filter((grant): grant is ArchivedApprovalGrant => Boolean(grant))
    : [];
  return {
    segmentIndex: raw.segmentIndex,
    conversationTurn: raw.conversationTurn,
    contextInputTokens: raw.contextInputTokens,
    runBudget: {
      ...(b.maxTurns !== undefined ? { maxTurns: b.maxTurns as number } : {}),
      ...(b.maxTokens !== undefined ? { maxTokens: b.maxTokens as number } : {}),
      usedTurns: b.usedTurns,
      usedTokens: b.usedTokens,
    },
    ...(approvalGrants.length ? { approvalGrants } : {}),
  };
}

function stricterLimit(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** 重启不能成为放宽旧上限或绕过当前宿主新上限的办法。 */
function restoredBudget(
  checkpoint: ArchivedCheckpoint,
  current: Pick<AgentConfig, "maxTotalTurns" | "maxTokensBudget">,
): SharedRunBudget {
  const maxTurns = stricterLimit(checkpoint.runBudget.maxTurns, current.maxTotalTurns);
  const maxTokens = stricterLimit(checkpoint.runBudget.maxTokens, current.maxTokensBudget);
  return {
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    usedTurns: checkpoint.runBudget.usedTurns,
    usedTokens: checkpoint.runBudget.usedTokens,
  };
}

function exhaustedBudgetReason(budget: SharedRunBudget): string | null {
  if (budget.maxTurns !== undefined && budget.usedTurns >= budget.maxTurns) {
    return `执行谱系的总轮次预算已用尽（${budget.usedTurns}/${budget.maxTurns}）`;
  }
  if (budget.maxTokens !== undefined && budget.usedTokens >= budget.maxTokens) {
    return `执行谱系的总 token 预算已用尽（${budget.usedTokens}/${budget.maxTokens}）`;
  }
  return null;
}

function isMessageHistory(value: unknown): value is Anthropic.MessageParam[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return false;
      const raw = message as Record<string, unknown>;
      if (raw.role !== "user" && raw.role !== "assistant") return false;
      if (typeof raw.content === "string") return true;
      return (
        Array.isArray(raw.content) &&
        raw.content.every(
          (block) =>
            Boolean(block) &&
            typeof block === "object" &&
            !Array.isArray(block) &&
            typeof (block as Record<string, unknown>).type === "string",
        )
      );
    })
  );
}

/** 把 TurnEvent 投影为可序列化对象，approval_request 去掉 respond 回调 */
function serializeEvent(
  _source: string,
  event: TurnEvent,
  segmentIndex: number,
): Record<string, unknown> {
  switch (event.type) {
    case "approval_request":
      return {
        type: event.type,
        toolUseId: event.toolUseId,
        name: event.name,
        input: event.input,
      };
    case "done":
      return {
        type: event.type,
        stopReason: event.result.stopReason,
        usage: event.result.usage,
        ...(event.result.completion ? { completion: event.result.completion } : {}),
        ...(event.result.runBudget ? { runBudget: event.result.runBudget } : {}),
        ...(event.result.contextInputTokens !== undefined
          ? { contextInputTokens: event.result.contextInputTokens }
          : {}),
        // V-04：错误详情此前被整条丢弃，前端只能写死一句"运行异常终止"
        ...(event.result.error
          ? { error: { name: event.result.error.name, message: event.result.error.message } }
          : {}),
        // 会话正史不进 SSE（可达数 MB，全量缓冲会爆内存）——只给条数，正文走
        // GET /api/runs/:id/transcript 按需拉
        messageCount: event.result.messages.length,
        // V-01：段终止 ≠ run 终止。带上段身份，让前端能区分"这一段结束了"
        // 与"整个 run 结束了"——后者只由 run_end 宣告
        segment: { index: segmentIndex, source: _source },
      };
    default:
      return { ...event };
  }
}

/**
 * 产物预览的 MIME。只列真的会被生成出来的那几类；认不出的一律
 * `application/octet-stream` + nosniff —— 让浏览器下载而不是猜着执行。
 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
};

export function contentTypeOf(name: string): string {
  const ext = extname(name).toLowerCase();
  if (CONTENT_TYPES[ext]) return CONTENT_TYPES[ext]!;
  // 源码一律按纯文本预览：按扩展名猜 MIME 容易把 .ts 之类当成别的东西
  if (/\.(ts|tsx|js|jsx|py|c|h|cpp|rs|go|java|sh|yml|yaml|toml|ini|xml)$/i.test(name)) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

/**
 * "在文件管理器里选中它"的平台命令。**返回参数数组而不是命令串**——
 * 拼串就等于把文件名交给命令行解析器去解释。
 */
export function revealCommand(
  abs: string,
  kind: "file" | "directory" = "file",
): { file: string; args: string[] } | null {
  if (process.platform === "win32") {
    return kind === "directory"
      ? { file: "explorer.exe", args: [abs] }
      : { file: "explorer.exe", args: [`/select,${abs}`] };
  }
  if (process.platform === "darwin") {
    return kind === "directory" ? { file: "open", args: [abs] } : { file: "open", args: ["-R", abs] };
  }
  if (process.platform === "linux") {
    return { file: "xdg-open", args: [kind === "directory" ? abs : dirname(abs)] };
  }
  return null;
}

/** `file.ts:12:4` 这类显示引用在文件系统里仍指向 `file.ts`。 */
export function localPathTarget(value: string): string {
  return String(value ?? "").trim().replace(/:\d+(?::\d+)?$/, "");
}

const BUILTIN_POOL: Tool[] = [bashTool, fetchUrlTool, readFileTool, writeFileTool];

/** 上传落点：工作目录下的固定子目录，便于人和 agent 都一眼知道东西在哪 */
const UPLOAD_SUBDIR = "uploads";
const UPLOAD_MAX_BYTES = 20_000_000;
const DEFAULT_SYSTEM_PROMPT = `You are a capable autonomous agent operating in a local working directory.
Complete the user's task end to end using the available tools.
Ground every claim of progress in an actual tool result.

You have a persistent memory that survives across sessions. The current memory index is provided in the <context> block of the first message. Consult relevant memories (memory_read) before starting work. When you learn a durable fact, user preference, or lesson worth reusing — a correction you received, a project constant, an approach that worked — save it with memory_write (one fact per file, first line = summary). Update or delete memories that turn out to be wrong. Do not store transient task state or things already recorded in the repository.` + RULE_PRECEDENCE_DISCIPLINE;

// ------------------------------------------------------
// Server factory
// ------------------------------------------------------

export function createUiServer(options: UiServerOptions = {}): UiServerHandle {
  const realHost = options.modelClient === undefined;
  const positiveInteger = (value: number | undefined, name: string): number | undefined => {
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const positiveIntegerEnv = (name: string): number | undefined => {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return undefined;
    return positiveInteger(Number(raw), name);
  };
  const accessToken = options.accessToken === false
    ? null
    : (typeof options.accessToken === "string"
        ? options.accessToken
        : realHost
          ? process.env.AGENT_UI_ACCESS_TOKEN
          : undefined)?.trim() || null;
  const allowedOrigins = [...new Set(
    options.allowedOrigins ?? (realHost
      ? (process.env.AGENT_UI_ALLOWED_ORIGINS ?? process.env.AGENT_UI_CORS_ORIGIN ?? "")
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean)
      : []),
  )];
  const allowedHosts = new Set([
    ...(options.allowedHosts ?? []),
    ...allowedOrigins.flatMap((origin) => {
      if (origin === "*") return [];
      try { return [new URL(origin).hostname]; } catch { return []; }
    }),
  ].map((host) => host.toLowerCase().replace(/^\[|\]$/g, "")));
  if (allowedOrigins.includes("*") && !accessToken) {
    throw new Error("Wildcard CORS requires AGENT_UI_ACCESS_TOKEN");
  }
  const requestBodyMaxBytes = positiveInteger(options.requestBodyMaxBytes, "requestBodyMaxBytes")
    ?? positiveIntegerEnv("AGENT_UI_REQUEST_BODY_MAX_BYTES")
    ?? 32 * 1024 * 1024;
  const approvalGrantTtlMs = positiveInteger(options.approvalGrantTtlMs, "approvalGrantTtlMs")
    ?? (realHost ? positiveIntegerEnv("AGENT_APPROVAL_GRANT_TTL_MS") : undefined)
    ?? DEFAULT_APPROVAL_GRANT_TTL_MS;
  if (approvalGrantTtlMs > MAX_APPROVAL_GRANT_TTL_MS) {
    throw new Error(`approvalGrantTtlMs must be <= ${MAX_APPROVAL_GRANT_TTL_MS}`);
  }
  const approvalGrantMaxUses = positiveInteger(options.approvalGrantMaxUses, "approvalGrantMaxUses")
    ?? (realHost ? positiveIntegerEnv("AGENT_APPROVAL_GRANT_MAX_USES") : undefined)
    ?? DEFAULT_APPROVAL_GRANT_MAX_USES;
  if (approvalGrantMaxUses > MAX_APPROVAL_GRANT_MAX_USES) {
    throw new Error(`approvalGrantMaxUses must be <= ${MAX_APPROVAL_GRANT_MAX_USES}`);
  }
  const approvalClock = options.approvalClock ?? Date.now;
  const maxActiveRuns = positiveInteger(options.maxActiveRuns, "maxActiveRuns")
    ?? positiveIntegerEnv("AGENT_UI_MAX_ACTIVE_RUNS")
    ?? (realHost ? 4 : Number.MAX_SAFE_INTEGER);
  // 缺省不启用（undefined）：日预算是操作员显式立的防线，不做隐形缺省。
  // 0 = 今日封盘（恒拒新准入）——所以不能用 positiveInteger（会把 0 拒成配置
  // 错误炸启动，评审实测确认）。env 只在 realHost 读：与台账/历史同一条仪器
  // 纪律——开发机残留的 AGENT_UI_DAILY_TOKEN_BUDGET 不该武装注入测试模型的宿主，
  // 否则全套测试会在消耗积累后冒出无法归因的 429（评审点名的测试污染缝）。
  const dailyTokenBudgetInput =
    options.dailyTokenBudget ??
    (realHost && process.env.AGENT_UI_DAILY_TOKEN_BUDGET?.trim()
      ? Number(process.env.AGENT_UI_DAILY_TOKEN_BUDGET)
      : undefined);
  if (
    dailyTokenBudgetInput !== undefined &&
    (!Number.isInteger(dailyTokenBudgetInput) || dailyTokenBudgetInput < 0)
  ) {
    throw new Error("dailyTokenBudget must be a non-negative integer (0 = closed for today)");
  }
  const dailyTokenBudget = dailyTokenBudgetInput;
  /**
   * 跨 run 独占资源表（审计 2026-08-24 high ④：互斥此前只在单个 runPlanned 内
   * 生效，两个并发 run 同用 stm32 包会同时抢探针——case-01 僵尸风暴的形态）。
   * single/verified 模式按包声明在准入时整体占用；plan 模式把这张表注入调度器，
   * 子任务粒度互斥、被外部持有时等待而非 skip。
   */
  const hostResources = createResourceCoordinator();
  // 同 workdir 并发 run：workdir 同时是写入圈禁边界，互踩是静默数据损坏。
  // 缺省告警（现状兼容），AGENT_UI_EXCLUSIVE_WORKDIR=1 升为拒绝。env 只武装
  // realHost（仪器纪律同日预算）。
  const exclusiveWorkdir =
    options.exclusiveWorkdir ?? (realHost && process.env.AGENT_UI_EXCLUSIVE_WORKDIR === "1");
  const mutationRateLimitPerMinute = positiveInteger(
    options.mutationRateLimitPerMinute,
    "mutationRateLimitPerMinute",
  ) ?? positiveIntegerEnv("AGENT_UI_MUTATIONS_PER_MINUTE")
    ?? (realHost ? 120 : Number.MAX_SAFE_INTEGER);
  const shutdownTimeoutMs = positiveInteger(options.shutdownTimeoutMs, "shutdownTimeoutMs")
    ?? positiveIntegerEnv("AGENT_UI_SHUTDOWN_TIMEOUT_MS")
    ?? 15_000;
  const sseHeartbeatMs = positiveInteger(options.sseHeartbeatMs, "sseHeartbeatMs")
    ?? positiveIntegerEnv("AGENT_UI_SSE_HEARTBEAT_MS")
    ?? 15_000;
  const bashEnabled = options.enableBash ?? (realHost ? process.env.AGENT_UI_ENABLE_BASH !== "0" : true);
  const trustProxy = options.trustProxy ?? (realHost && process.env.AGENT_UI_TRUST_PROXY === "1");

  // F1: 缺省模型从环境变量读取，compat 取自 createModelClientFromEnv 返回值
  const resolved = createModelClientFromEnv(process.env.AGENT_MODEL ?? "claude-opus-4-8");
  /**
   * 端点降级链（MODEL-01a）。**只包主执行者**——verifier / planner / vision
   * 三个角色模型不进链：它们是被显式指定的端点，"核查者应 ≥ 执行者"是一条
   * 设计约束，静默把核查换到另一家会让那条约束在无人知晓时失效。
   *
   * 归属靠 AsyncLocalStorage 而不是一个可变的"当前 run"引用：换端点发生在
   * `FallbackModelClient.send` 内部，而这台宿主允许多个 run 并发在飞
   * （maxActiveRuns），单个可变引用会在两次 send 交错时把降级记到别人账上。
   * ALS 的存储沿 await 链传播，谁发起的 send 就记到谁头上。
   */
  const fallbackSink = new AsyncLocalStorage<(info: FallbackInfo) => void>();
  const fallbackClient = createFallbackClientIfConfigured(
    { name: process.env.AGENT_MODEL ?? "claude-opus-4-8", client: options.modelClient ?? resolved.client },
    options.fallbackEnv ?? process.env,
    (info) => fallbackSink.getStore()?.(info),
  );
  const fallbackChain = fallbackClient instanceof FallbackModelClient ? fallbackClient.chain() : null;
  // 日账本逐调用实时计量（评审 b62f6a5：段粒度落账让预算门的 TOCTOU 窗口有
  // 整段宽——最坏 4 条 lineage 在账本过线前全部准入；跨午夜大段还会整段挤占
  // 新日额度）。metrics.tokens 的 role 记账仍走事件路径（每段独立 usage、归属
  // 清晰），这层只喂日账本——两本账职责分开，互不双计。
  // 计量包在降级之**外**：哪个端点应答的都要计进日额度，账本关心的是花了多少钱。
  const modelClient = meterModelClient(fallbackClient, (u) => bumpDaily(u));
  const taskCompletionEnabled =
    options.taskCompletion ?? (options.modelClient ? false : process.env.AGENT_REQUIRE_FINISH_TASK !== "0");
  /**
   * L6 运行台账开关。**注入了 modelClient 就默认不记。**
   *
   * 这条不是洁癖，是仪器纪律：`options.modelClient` 是测试与脚本驱动的注入口，
   * 那些运行用的是 FakeModelClient——它的裁决**永远可解析**。首次上线时忘了这条，
   * 一跑测试套就往台账里灌了 86 条假运行、22 次裁决全是 `direct`，
   * 正好会把 §2.1 的判据推向"关掉"。**用假模型的数去判模型行为，是最坏的一种假证据。**
   * 显式传 `ledger` 可以覆盖（真机驱动脚本若注入 client 又想记账时用）。
   */
  const ledgerFile: string | null =
    options.ledger === false
      ? null
      : typeof options.ledger === "string"
        ? options.ledger
        : options.modelClient
          ? null
          : ledgerPath();
  // B2 运行历史根。缺省逻辑与台账同一条仪器纪律：注入 modelClient 的运行
  // （测试/脚本）默认不落档案——假模型的"历史"混进真档案同样是假证据
  const historyRoot: string | null =
    options.history === false
      ? null
      : typeof options.history === "string"
        ? resolve(options.history)
        : options.modelClient
          ? null
          : historyRootPath();
  const historyKeep = options.historyKeep ?? historyKeepCount();
  const maxStoredRuns = positiveInteger(options.maxStoredRuns, "maxStoredRuns")
    ?? positiveIntegerEnv("AGENT_UI_MAX_STORED_RUNS")
    ?? (realHost ? Math.max(100, historyKeep) : Number.MAX_SAFE_INTEGER);
  const envCompat = resolved.compat;
  // 在源头就归一：workdir 参与白名单比对、侧栏分组键、工具圈禁根三处，
  // 三处必须是同一个字符串形态。`D:/a/b` 与 `D:` 指同一个目录，
  // 但字符串不等——不在源头 resolve 的话，默认路径会过不了自己的白名单
  const workdir = resolve(options.workdir ?? process.cwd());
  const allowedWorkdirs = [...new Set([workdir, ...(options.workdirs ?? [])].map((d) => resolve(d)))];
  const memoryHost = createWorkdirScopedMemoryTools(
    (runWorkdir) => process.env.AGENT_MEMORY_DIR ?? join(runWorkdir, ".agent-memory"),
  );
  const memoryTools = memoryHost.tools;
  const defaultMemoryDir = process.env.AGENT_MEMORY_DIR ?? join(workdir, ".agent-memory");
  // modelClient 是 provider 注入口，不是“测试模式”安全开关；用它推断 off 会让
  // 嵌入式真实 client 在 required 配置下静默退回宿主。测试隔离必须显式传 env。
  const executionEnv: NodeJS.ProcessEnv = options.executionEnv ?? process.env;
  const executionPolicy = parseExecutionPolicy(executionEnv);
  const mcpEnabled = process.env.AGENT_UI_MCP === "1";
  // 先过跨能力边界，再创建/启动任何 OCI probe。否则构造函数随后 throw 时调用方
  // 拿不到 handle，也就没有机会 dispose 已启动的 canary。
  if (executionPolicy.mode === "required" && mcpEnabled) {
    throw new Error(
      "AGENT_EXECUTION_ISOLATION=required cannot enable shared host stdio MCP; " +
      "disable AGENT_UI_MCP or use a managed gateway",
    );
  }
  const executionBrokerFactory = options.executionBrokerFactory ??
    ((runId: string, runWorkdir: string) => createExecutionBroker({
      boundaryId: runId,
      workdir: runWorkdir,
      env: executionEnv,
    }));
  const processProbeBroker = bashEnabled
    ? (options.executionProbeBroker
        ?? executionBrokerFactory("process-capability-probe", workdir))
    : undefined;
  let processExecutionStatus = processProbeBroker?.status()
    ?? configuredExecutionStatus(executionEnv, "process");
  let executionHealthy = !bashEnabled || processExecutionStatus.requestedMode !== "required";
  // 已从 runs 表淘汰、但仍在清理的 broker 必须保留强引用；否则 cleanup
  // 失败后既不能重试，也会让下一次 admission 错误地恢复为 healthy。
  const detachedExecutionBrokers = new Set<ExecutionBroker>();
  const detachedExecutionTasks = new Set<Promise<void>>();
  function markProcessExecutionFailed(reason: string): void {
    processExecutionStatus = {
      ...processExecutionStatus,
      effectiveState: "failed",
      resolvedBackend: null,
      probe: {
        state: "unavailable",
        candidate: processExecutionStatus.probe.candidate,
        reason,
      },
      coverage: [],
      filesystem: "unavailable: execution boundary is not ready",
      network: "unavailable",
      identity: "unavailable",
      resources: "unavailable",
    };
    executionHealthy = processExecutionStatus.requestedMode !== "required";
  }
  function detachAndDisposeExecutionBroker(run: StoredRun): void {
    const broker = run.executionBroker;
    if (!broker) return;
    // continuation 必须重新建 broker 并重新 admission；不能复用已进入 dispose 的实例。
    delete run.executionBroker;
    if (!broker.dispose) return;
    detachedExecutionBrokers.add(broker);
    const cleanup = broker.dispose().then(
      () => { detachedExecutionBrokers.delete(broker); },
      (err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        markProcessExecutionFailed(`Detached execution cleanup failed: ${detail}`);
        operationalLog("error", "detached_execution_cleanup_failed", {
          runId: run.id,
          error: detail,
        });
      },
    );
    detachedExecutionTasks.add(cleanup);
    void cleanup.finally(() => detachedExecutionTasks.delete(cleanup)).catch(() => {});
  }
  async function refreshExecutionHealth(force = false): Promise<void> {
    if (!processProbeBroker) return;
    try {
      const status = await processProbeBroker.probe(force);
        processExecutionStatus = status;
        executionHealthy = status.requestedMode !== "required"
          || (status.effectiveState === "partial" && status.resolvedBackend === "oci");
        if (detachedExecutionBrokers.size > 0) {
          markProcessExecutionFailed(
            `Cleanup is still unconfirmed for ${detachedExecutionBrokers.size} detached execution broker(s)`,
          );
        }
    } catch (err: unknown) {
        markProcessExecutionFailed(err instanceof Error ? err.message : String(err));
    }
  }
  function executionAdmissionBlockReason(): string | null {
    // 路由入口的 process probe 与真正启动之间可能隔着慢请求体、MCP 装配等 await。
    // 这期间别的 run 一旦进入 detached cleanup，旧的 healthy 快照就已失效。
    // 必须在每个 per-run probe 之后，以当前集合重验；成功清理会先从集合删除，
    // pending/failed 则都保持占位，因此这里不靠异步状态传播，也没有漏放窗口。
    if (detachedExecutionBrokers.size > 0) {
      return `Cleanup is still unconfirmed for ${detachedExecutionBrokers.size} detached execution broker(s)`;
    }
    if (!executionHealthy) {
      return processExecutionStatus.probe.reason ?? "required isolation backend unavailable";
    }
    return null;
  }
  const executionReady: Promise<void> = refreshExecutionHealth(true);
  const pack = options.packName ? getPack(options.packName) : undefined;
  const injectedTools = options.tools;

  /**
   * V-30 角色模型：verifier / planner 各自可用独立端点（口径与 src/cli.ts 一致）。
   *
   * 密钥只在服务端解析，**绝不下发浏览器**——快照里只报模型名与 provider。
   * 浏览器能做的是"这次用不用独立角色模型"，不是"用哪个 key 连哪个端点"。
   *
   * 值得配的依据是实测而非直觉：D2 —— 强 verifier 的确定优势是核查效率
   * （约 1/3 成本）。反过来 B3 已经证伪了"更强 planner 能稳住拆分摇摆"，
   * 所以 planner 这一路留给实验，界面不该暗示它更好。
   */
  function resolveRole(prefix: string): { name: string; provider: ResolvedProvider } | null {
    const name = process.env[`AGENT_${prefix}_MODEL`];
    if (!name) return null;
    const pv = process.env[`AGENT_${prefix}_PROVIDER`];
    const baseURL = process.env[`AGENT_${prefix}_BASE_URL`];
    const apiKey = process.env[`AGENT_${prefix}_API_KEY`];
    return {
      name,
      provider: createModelClientFromEnv(name, {
        ...(pv ? { provider: pv as "anthropic" | "openai" } : {}),
        ...(baseURL ? { baseURL } : {}),
        ...(apiKey ? { apiKey } : {}),
      }),
    };
  }

  const verifierRole = resolveRole("VERIFIER");
  const plannerRole = resolveRole("PLANNER");
  /**
   * 视觉模型是第四个角色（V-31）。配了才有 describe_image 工具——
   * 没配就不该在工具面上摆一个一调用就报错的工具，那是在骗模型。
   */
  const visionRole = resolveRole("VISION");
  const visionTool = visionRole
    ? createDescribeImageTool({
        // 计量包裹：视觉调用不经 done/verification 记账路径，只能在客户端边界抓。
        // 视觉是独立 client（不在主 modelClient 的日账包裹之内），日账本也在这里喂
        client: meterModelClient(visionRole.provider.client, (u) => {
          growTokens("vision", u);
          bumpDaily(u);
        }),
        modelName: visionRole.name,
      })
    : null;
  const enabledBuiltinPool = bashEnabled
    ? BUILTIN_POOL
    : BUILTIN_POOL.filter((tool) => tool.name !== bashTool.name);
  const toolPool: Tool[] = visionTool ? [...enabledBuiltinPool, visionTool] : enabledBuiltinPool;

  const runs = new Map<string, StoredRun>();
  const startedAt = Date.now();
  let historyHealthy = true;
  let shuttingDown = false;
  let pendingAdmissions = 0;
  const mutationWindows = new Map<string, { startedAt: number; count: number }>();
  const detachedArchiveFlushes = new Set<Promise<unknown>>();
  const metrics = {
    httpRequests: 0,
    httpStatuses: new Map<number, number>(),
    runsStarted: 0,
    // 按 outcome 分档（审计 2026-08-24 high：无成败率指标，runbook 的
    // "run errors 超基线即回滚"条款没有任何可查询的数据支撑）
    runsFinished: new Map<RunEndInfo["outcome"], number>(),
    // token 累计，键 "role/kind"（审计 2026-08-24 high：无跨 run 成本观测）
    tokens: new Map<string, number>(),
    budgetRejected: 0,
    resourceRejected: 0,
    workdirRejected: 0,
    originRejected: 0,
    authRejected: 0,
    hostRejected: 0,
    bodyRejected: 0,
    rateRejected: 0,
    capacityRejected: 0,
    historyErrors: 0,
  };

  /** 日预算账本（进程态；宿主重启当日归零，与 /metrics 同边界） */
  let dailyTokens = { day: localDayKey(), used: 0 };

  /** 日账本落账（非 cache_read 口径，与成本告警一致；cache_read 量大价低，
   * 计入会让长循环任务两小时吃光名义预算，防线沦为噪声）。由 meterModelClient
   * 按**每次模型调用**喂入——不等段收尾。 */
  function bumpDaily(u: { inputTokens: number; outputTokens: number; cacheCreationTokens: number }): void {
    const n = u.inputTokens + u.outputTokens + u.cacheCreationTokens;
    if (n <= 0) return;
    const today = localDayKey();
    if (dailyTokens.day !== today) dailyTokens = { day: today, used: 0 };
    dailyTokens.used += n;
  }

  /** token 计数累加（AggregateUsage → role 四档）。全部记账路径共用这一个入口 */
  function growTokens(
    role: (typeof TOKEN_ROLES)[number],
    u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number },
  ): void {
    const grow = (kind: (typeof TOKEN_KINDS)[number], n: number) => {
      const key = `${role}/${kind}`;
      metrics.tokens.set(key, (metrics.tokens.get(key) ?? 0) + n);
    };
    grow("input", u.inputTokens);
    grow("output", u.outputTokens);
    grow("cache_read", u.cacheReadTokens);
    grow("cache_creation", u.cacheCreationTokens);
    // 日账本不在这里累：它由 meterModelClient 逐调用喂入（见 bumpDaily）。
    // 在这条事件路径上再累一遍就是双计。
  }

  function reportHistoryError(error: Error): void {
    historyHealthy = false;
    metrics.historyErrors += 1;
    operationalLog("error", "history_write_failed", { error: error.message });
  }

  function createArchiveWriter(runId: string): RunHistoryWriter | undefined {
    if (!historyRoot) return undefined;
    return new RunHistoryWriter(join(historyRoot, runId), reportHistoryError);
  }

  // ---- B2 运行历史落盘 ----

  /** run → meta.json 的形状。创建 / 追加轮开始 / 收尾各整写一次 */
  function persistMeta(run: StoredRun): void {
    if (!run.archiveWriter) return;
    const meta: ArchivedMeta = {
      version: 1,
      runId: run.id,
      task: run.task,
      status: run.status,
      verify: run.verify,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt ?? null,
      packName: run.packName ?? pack?.name ?? null,
      mode: run.mode ?? "single",
      effort: run.effort ?? null,
      rubric: run.rubric ?? null,
      workdir: run.workdir ?? workdir,
      conversationTurn: run.conversationTurn,
      planGate: Boolean(run.planGate),
      planDecision: run.planDecision ?? null,
      mainStopReason: run.mainStopReason ?? null,
      askUser: Boolean(run.askUser),
      checkpoint: run.checkpoint ?? null,
      continuedFrom: run.continuedFrom ?? null,
      rootRunId: run.rootRunId ?? null,
      outcome: run.outcome
        ? {
            finalPassed: run.outcome.finalPassed,
            reworks: run.outcome.reworks,
            verdict: run.outcome.verifications.at(-1)?.verdict ?? null,
          }
        : null,
    };
    run.archiveWriter.writeMeta(meta);
  }

  /** RUN-01：初始化 durable 游标并落盘（建 run / 派生 fork 时）。 */
  function seedDurableState(run: StoredRun): void {
    const state = initialRunState(run.id, run.createdAt);
    state.rootRunId = run.rootRunId ?? null;
    state.continuedFrom = run.continuedFrom ?? null;
    run.durableState = state;
    run.archiveWriter?.writeState(state);
  }

  /**
   * RUN-01：应用迁移并写 state.json。非法迁移 fail-closed 记日志，不打断 run。
   * 调用方保证先落相关事件（appendEvent）再调本函数——writer 同链保序。
   */
  function applyDurableTransition(run: StoredRun, event: RunStateEvent, at = Date.now()): void {
    if (!run.durableState) seedDurableState(run);
    const current = run.durableState!;
    const next = transitionRunState(current, event, at);
    if (!next) {
      if (realHost) {
        operationalLog("warn", "run_state_transition_rejected", {
          runId: run.id,
          phase: current.phase,
          event: event.type,
        });
      }
      return;
    }
    run.durableState = next;
    run.archiveWriter?.writeState(next);
  }

  /** 收尾时把游标收到终态（已终态则幂等跳过）。 */
  function finalizeDurableState(run: StoredRun, endInfo: RunEndInfo): void {
    const phase = run.durableState?.phase;
    if (phase && ["completed", "failed", "closed", "interrupted"].includes(phase)) return;
    const reason = endInfo.mainStopReason;
    if (reason === "plan_rejected" || endInfo.outcome === "rejected") {
      applyDurableTransition(run, { type: "close" });
      return;
    }
    if (reason === "plan_gate_expired" || endInfo.outcome === "closed" || reason === "aborted") {
      // 宿主关停 / 门过期 / 委托方停止：中断，不是"跑完了"
      applyDurableTransition(run, { type: "interrupt" });
      return;
    }
    if (endInfo.outcome === "error" || reason === "error" || reason === "execution_unavailable") {
      applyDurableTransition(run, { type: "fail" });
      return;
    }
    // 同进程还可追问的 completed：保持 executing，不标 completed——
    // 否则 startContinuation 的 segment_begin 会被非法迁移挡住。
    const structurallyContinuable =
      !run.verify && run.mode !== "plan" && Boolean(run.loop && run.history?.length);
    if (structurallyContinuable && endInfo.outcome === "completed") {
      if (run.durableState) run.archiveWriter?.writeState(run.durableState);
      return;
    }
    applyDurableTransition(run, { type: "complete" });
  }

  /**
   * 启动时恢复档案（判据①②）。先修剪再恢复；坏档案已在 loadArchivedMetas
   * 里被跳过。恢复出来的 run 一律 status=done + archived——**没有任何一个
   * 归档 run 是"在跑的"**：跑到一半宿主没了的，按异常终止归档（见 hydrate
   * 的 run_end 合成），绝不显示成还在跑。
   */
  async function restoreArchivedRuns(): Promise<void> {
    if (!historyRoot) return;
    try {
      await pruneHistory(historyRoot, historyKeep);
      for (const a of await loadArchivedMetas(historyRoot)) {
        if (runs.has(a.meta.runId)) continue;
        const crashed = a.meta.status === "running";
        const parsedCheckpoint = checkpointFromUnknown(a.meta.checkpoint);
        // checkpoint 中夹入其它 run 的 grant 只能作为篡改/复制痕迹丢弃；预算与正史仍可恢复。
        const archivedApprovalGrantAudit = parsedCheckpoint?.approvalGrants
          ?.filter((grant) => grant.boundRunId === a.meta.runId)
          .map((grant) => ({ ...grant })) ?? [];
        const checkpoint = parsedCheckpoint
          ? {
              ...parsedCheckpoint,
              ...(archivedApprovalGrantAudit.length
                ? { approvalGrants: archivedApprovalGrantAudit }
                : { approvalGrants: undefined }),
            }
          : undefined;
        // RUN-01：读 state.json；崩溃相按 ADR 表收成 closed/interrupted 并回写。
        let durableState = await readArchivedState(a.dir);
        if (durableState && crashed) {
          const recovered = recoverDurableStateOnCrash(durableState);
          if (recovered !== durableState && recovered.phase !== durableState.phase) {
            durableState = recovered;
            try {
              const writer = new RunHistoryWriter(a.dir, reportHistoryError);
              writer.writeState(recovered);
              await writer.flush();
            } catch {
              // 回写失败不阻断启动；内存仍持恢复后的 phase 供 API 诚实展示
            }
          } else {
            durableState = recovered;
          }
        } else if (!durableState && crashed) {
          // 旧档案无 state.json：合成 interrupted，仍不冒充在跑
          durableState = recoverDurableStateOnCrash(initialRunState(a.meta.runId, a.meta.createdAt));
        }
        runs.set(a.meta.runId, {
          id: a.meta.runId,
          task: a.meta.task,
          status: "done",
          verify: a.meta.verify,
          createdAt: a.meta.createdAt,
          ...(a.meta.finishedAt !== null ? { finishedAt: a.meta.finishedAt } : {}),
          events: [],
          pendingApprovals: new Map(),
          respondedApprovals: new Map(),
          respondedToolUseIds: new Set(),
          sseClients: new Set(),
          segmentIndex: 0,
          transcript: [],
          conversationTurn: a.meta.conversationTurn,
          toolTally: {},
          archived: true,
          archiveDir: a.dir,
          ...(typeof a.meta.packName === "string" && a.meta.packName
            ? { packName: a.meta.packName }
            : {}),
          ...(a.meta.mode === "plan" ? { mode: "plan" as const } : {}),
          ...(typeof a.meta.effort === "string" &&
          (EFFORT_LEVELS as readonly string[]).includes(a.meta.effort)
            ? { effort: a.meta.effort as Effort }
            : {}),
          ...(typeof a.meta.rubric === "string" && a.meta.rubric
            ? { rubric: a.meta.rubric }
            : {}),
          ...(typeof a.meta.workdir === "string" && a.meta.workdir
            ? { workdir: a.meta.workdir }
            : {}),
          ...(a.meta.planGate ? { planGate: true } : {}),
          ...(a.meta.planDecision ? { planDecision: a.meta.planDecision } : {}),
          ...(a.meta.askUser ? { askUser: true } : {}),
          ...(checkpoint ? { checkpoint } : {}),
          ...(archivedApprovalGrantAudit.length ? { archivedApprovalGrantAudit } : {}),
          ...(typeof a.meta.continuedFrom === "string" && a.meta.continuedFrom
            ? { continuedFrom: a.meta.continuedFrom }
            : {}),
          ...(typeof a.meta.rootRunId === "string" && a.meta.rootRunId
            ? { rootRunId: a.meta.rootRunId }
            : {}),
          ...(durableState ? { durableState } : {}),
          // 崩溃档案（meta 还停在 running）：没人正常收过尾，按宿主级异常归档
          ...(crashed
            ? { mainStopReason: "error" }
            : a.meta.mainStopReason
              ? { mainStopReason: a.meta.mainStopReason }
              : {}),
          ...(a.meta.outcome
            ? {
                archivedOutcome: {
                  finalPassed: a.meta.outcome.finalPassed,
                  reworks: a.meta.outcome.reworks,
                  verdict: (a.meta.outcome.verdict as Verdict | null) ?? null,
                },
              }
            : {}),
        });
      }
      pruneStoredRuns();
    } catch (error) {
      // 不阻断宿主启动，但 readiness 必须降级，不能把数据保护失效伪装成健康。
      reportHistoryError(error instanceof Error ? error : new Error(String(error)));
    }
  }
  /** 所有 API 路由在此就绪后才应答——启动后的第一个 GET /api/runs 就要看得到档案 */
  const historyReady: Promise<void> = restoreArchivedRuns();

  /**
   * 归档懒加载：events/transcript 首次被要时才读盘，且只读一次。
   * 崩溃档案的事件流没有 run_end——合成一条（outcome=error），否则重放出来
   * 的界面会永远"运行中"，那是档案在对人说谎。
   */
  function hydrateArchive(run: StoredRun): Promise<void> {
    if (!run.archived || !run.archiveDir) return Promise.resolve();
    run.hydration ??= (async () => {
      const dir = run.archiveDir!;
      run.events = (await readArchivedEvents(dir)) as SSEEvent[];
      run.transcript = (await readArchivedTranscript(dir)) as StoredRun["transcript"];
      const hasRunEnd = run.events.some((e) => (e.event as { type?: string } | undefined)?.type === "run_end");
      if (!hasRunEnd) {
        const lastTs = run.events.at(-1)?.ts ?? run.createdAt;
        run.events.push({
          seq: run.events.length,
          source: "host",
          ts: lastTs,
          event: {
            type: "run_end",
            outcome: "error",
            mainStopReason: "error",
            finishedAt: lastTs,
            // 观测者要分得清"它当时崩了"与"宿主没能归档收尾"——后者才是事实
            synthesized: "host_not_finalized",
          },
        });
      }
    })().catch(() => {
      // 读盘失败：events/transcript 留空，列表元数据仍可用
    });
    return run.hydration;
  }

  /**
   * 只从 checkpoint 指定的 main 段恢复，不拿“最后一段”猜。归档里可能同时有
   * verifier/rework 段，按数组尾部取会把独立核查上下文误接进主会话。
   */
  function archivedCheckpointHistory(run: StoredRun): Anthropic.MessageParam[] | undefined {
    const checkpoint = run.checkpoint;
    if (!checkpoint) return undefined;
    const segment = run.transcript.find(
      (candidate) => candidate.index === checkpoint.segmentIndex && candidate.source === "main",
    );
    if (!segment || !isMessageHistory(segment.messages)) return undefined;
    // 子 run 可以压缩自己的正史；父档案的内存投影也必须保持不可变。
    return structuredClone(segment.messages);
  }

  /**
   * 全局生命周期流的订阅者（V-10）。
   *
   * 存在的理由：侧栏此前靠 `setInterval(loadRuns, 3000)` 保持新鲜，而那次轮询会
   * 整体重建列表——实测焦点停在运行项上 3.6 秒后就变成 BODY。改成推送之后，
   * 侧栏只在真的有变化时更新，而且更新走键控补丁，不再摧毁焦点。
   * 这条流只广播"哪个 run 变了"，不带事件载荷——详情仍走 per-run 的 SSE。
   */
  const lifecycleClients = new Set<ServerResponse>();

  /**
   * 归档续跑不是“有 checkpoint 字段就放行”。当前宿主仍是安全边界：
   * 工作目录必须还在白名单内、领域包必须仍然存在、旧/新两套总预算都不能
   * 被重启绕过。返回值既供 API 409，也供列表提前算 canContinue。
   */
  function archivedForkBlockReason(r: StoredRun): string | null {
    if (!r.archived) return "该运行不是归档运行";
    if (r.verify) return "开启独立核查的归档不能派生续跑：追加会绕过已出具的裁决";
    if (r.mode === "plan") return "计划编排的归档不能派生续跑：runPlanned 没有检查点续跑入口";
    if (!r.checkpoint) return "该归档没有可恢复检查点（旧格式或主执行段未完整结束）";
    if (r.packName && !getPack(r.packName)) {
      return `归档使用的领域包 \"${r.packName}\" 在当前宿主中不存在`;
    }
    let target: string;
    try {
      target = resolve(r.workdir ?? workdir);
    } catch {
      return "归档工作目录无效，不能交给当前宿主执行";
    }
    if (!allowedWorkdirs.includes(target)) {
      return `归档工作目录不在当前宿主白名单内：${target}`;
    }
    const budget = restoredBudget(r.checkpoint, { maxTotalTurns, maxTokensBudget });
    return exhaustedBudgetReason(budget);
  }

  /**
   * 列表项摘要。V-14：元数据由服务端算好，侧栏不再依赖"这个 run 是否被订阅过"
   * ——此前核查结论一列只有打开过的 run 才有值。
   */
  function runSummary(r: StoredRun): Record<string, unknown> {
    const liveStructurallyContinuable =
      !r.archived &&
      r.status === "done" &&
      !r.verify &&
      r.mode !== "plan" &&
      Boolean(r.loop && r.history?.length);
    const liveBudgetBlockReason = liveStructurallyContinuable && r.checkpoint
      ? exhaustedBudgetReason(r.checkpoint.runBudget)
      : null;
    const liveCanContinue = liveStructurallyContinuable && liveBudgetBlockReason === null;
    const archiveBlockReason = r.archived ? archivedForkBlockReason(r) : null;
    const archiveCanFork = Boolean(r.archived && archiveBlockReason === null);
    const grantCanStillBeCalled = !r.archived && (r.status === "running" || liveCanContinue);
    const activeApprovalGrants = grantCanStillBeCalled
      ? approvalGrantCheckpointSnapshot(r, approvalClock()).length
      : 0;
    return {
      runId: r.id,
      task: r.task,
      status: r.status,
      verify: r.verify,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt ?? null,
      packName: r.packName ?? pack?.name ?? null,
      stopReason: r.mainStopReason ?? null,
      // 活 run 走 outcome，归档 run 走 meta 里的摘要——列表列不因重启而变
      finalPassed: r.outcome?.finalPassed ?? r.archivedOutcome?.finalPassed ?? null,
      reworks: r.outcome?.reworks ?? r.archivedOutcome?.reworks ?? null,
      pendingApprovals: r.pendingApprovals.size,
      approvalGrants: {
        active: activeApprovalGrants,
        archivedAudit: r.archivedApprovalGrantAudit?.length ?? 0,
        restorable: false,
        ...(r.archivedApprovalGrantAudit?.length ? { inactiveReason: "archived_run" } : {}),
      },
      // V-14 口径：需要人介入的事项由服务端持有，不取决于该 run 有没有被订阅过。
      // 计划门挂起时侧栏就该显示"需你决定"，而不是点进去才发现
      planGate: Boolean(r.planGate),
      awaitingPlanApproval: Boolean(r.pendingPlan),
      // §5.2：挂起的提问要能被列表/底栏看见——阻塞式交互不可见等于运行卡死
      awaitingQuestion: r.pendingQuestion
        ? { id: r.pendingQuestion.id, questions: r.pendingQuestion.questions }
        : null,
      askUser: Boolean(r.askUser),
      planDecision: r.planDecision?.decision ?? null,
      verdict: r.outcome?.verifications.at(-1)?.verdict ?? r.archivedOutcome?.verdict ?? null,
      mode: r.mode ?? "single",
      // B2：父档案恒只读；有完整检查点时可派生子 run，不能把两者冒充成
      // “原进程无缝继续”。continuationMode 是这个环境边界的显式契约。
      ...(r.archived ? { archived: true } : {}),
      conversationTurn: r.conversationTurn,
      continuedFrom: r.continuedFrom ?? null,
      rootRunId: r.rootRunId ?? null,
      // RUN-01：编排游标诚实展示。有 state 就报 phase + 崩溃恢复策略；
      // 明确 sameRunResume=false——Phase 1 只 fork/checkpoint，不热续跑。
      durablePhase: r.durableState?.phase ?? null,
      durableRecovery: r.durableState ? recoveryActionForPhase(r.durableState.phase) : null,
      sameRunResume: false,
      // V-32：侧栏按工作目录分组。workdir 是工具的写入圈禁边界，
      // 也就是"这段工作触碰的范围"——它是这个 harness 自己长出来的分组键，
      // 不是从别家侧栏照搬来的层级
      workdir: r.workdir ?? workdir,
      // 能否追加：让界面据此决定要不要显示输入框，而不是点了才报错。
      canContinue: liveCanContinue || archiveCanFork,
      continuationMode: archiveCanFork ? "fork" : liveCanContinue ? "same" : null,
      continuationBlockReason:
        !archiveCanFork && r.archived ? archiveBlockReason : liveBudgetBlockReason,
    };
  }

  function broadcastLifecycle(type: string, run: StoredRun): void {
    if (lifecycleClients.size === 0) return;
    const frame = `data: ${JSON.stringify({ type, run: runSummary(run) })}\n\n`;
    for (const client of lifecycleClients) {
      try {
        client.write(frame);
      } catch {
        lifecycleClients.delete(client);
      }
    }
  }

  function broadcastLifecycleRemoval(runId: string): void {
    if (lifecycleClients.size === 0) return;
    const frame = `data: ${JSON.stringify({ type: "run_removed", runId })}\n\n`;
    for (const client of lifecycleClients) {
      try { client.write(frame); } catch { lifecycleClients.delete(client); }
    }
  }

  function pruneStoredRuns(): void {
    if (runs.size <= maxStoredRuns) return;
    const completed = [...runs.values()]
      .filter((candidate) => candidate.status === "done")
      .sort((left, right) =>
        (left.finishedAt ?? left.createdAt) - (right.finishedAt ?? right.createdAt),
      );
    while (runs.size > maxStoredRuns && completed.length > 0) {
      const oldest = completed.shift()!;
      if (!runs.delete(oldest.id)) continue;
      if (oldest.archiveWriter) {
        const flush = oldest.archiveWriter.flush();
        detachedArchiveFlushes.add(flush);
        void flush.finally(() => detachedArchiveFlushes.delete(flush));
      }
      detachAndDisposeExecutionBroker(oldest);
      broadcastLifecycleRemoval(oldest.id);
    }
  }

  // 思考预算档：非法值当场抛错而不是静默退回默认——静默降级会让"我明明设了 max"
  // 与实际行为长期不一致（口径与 src/cli.ts 一致，CLI 是 exit 1，库里改成抛错）
  const effortEnv = process.env.AGENT_EFFORT;
  if (effortEnv && !(EFFORT_LEVELS as readonly string[]).includes(effortEnv)) {
    throw new Error(
      `AGENT_EFFORT="${effortEnv}" 无效。可选值: ${EFFORT_LEVELS.join(" | ")}`,
    );
  }
  const effort = effortEnv as Effort | undefined;

  // 额外只读根（安全边界：agent 能读到工作目录之外的哪里）
  const readRoots = (process.env.AGENT_READ_ROOTS ?? "")
    .split(delimiter)
    .map((s) => s.trim())
    .filter(Boolean);

  // 护栏优先级：显式 env > 领域包默认 > 全局默认（照抄 cli.ts 口径）
  const contextTokenLimit = process.env.AGENT_CONTEXT_LIMIT
    ? Number(process.env.AGENT_CONTEXT_LIMIT)
    : pack?.guardrails?.contextTokenLimit;
  const maxTokens = process.env.AGENT_MAX_TOKENS
    ? Number(process.env.AGENT_MAX_TOKENS)
    : pack?.guardrails?.maxTokens;
  const maxTurns = pack?.guardrails?.maxTurns;
  const integerEnv = (name: string, min: number): number | undefined => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min) {
      throw new Error(`${name}="${raw}" 无效：需为 ≥${min} 的整数`);
    }
    return value;
  };
  // 真实常驻宿主必须有跨 continuation / rework / plan 子任务共享的硬上限；
  // 注入 fake model 的测试保留原契约，避免用生产默认值改写研究用例。
  const maxTotalTurns = integerEnv("AGENT_TOTAL_MAX_TURNS", 1) ?? (realHost ? 120 : undefined);
  const maxTokensBudget = integerEnv("AGENT_TOTAL_TOKEN_BUDGET", 1) ?? (realHost ? 500_000 : undefined);
  const progressExtensionTurns = integerEnv("AGENT_PROGRESS_EXTENSION_TURNS", 0);
  const stagnationWindow = integerEnv("AGENT_STAGNATION_WINDOW", 0);
  /** §5.2 打断次数上限（决定 2/6）。 */
  const maxAskRounds = integerEnv("AGENT_MAX_ASK_ROUNDS", 1);

  // 任务级评分表优先于领域包声明（rubric 是任务属性，包只提供缺省）
  const rubric = process.env.AGENT_VERIFY_RUBRIC ?? pack?.verify.rubric;

  /**
   * MCP 接入状态。**默认不连**，需 AGENT_UI_MCP=1 显式开。
   *
   * 理由不是保守：stm32-debug 这类包声明了 swd-probe 独占资源，而 UI server 是
   * 常驻进程——默认连接就等于一个长期攥着调试探针的会话，正是案例 #3 里
   * 害得整块板子连不上的那种形态。要用就显式开，用完关掉宿主。
   */
  const mcpConfigPath = process.env.AGENT_MCP_CONFIG ?? join(workdir, "mcp.json");

  /**
   * MCP 运行时（**懒连接**）。
   *
   * 此前这里只有一个布尔量在装样子：`ui/server.ts` 连 `src/mcp.js` 都没 import，
   * `selectPackTools(pack, POOL, [])` 永远传空的 MCP 工具表——`AGENT_UI_MCP=1`
   * 只是把状态快照里的一句 reason 去掉。后果不是"少个功能"：**stm32-debug 这类
   * 全 MCP 工具面的包在 Web 宿主下等于废的**，agent 只拿得到 read_file/write_file。
   * （案例 #8 开跑前撞出来的，第七个"harness 有、宿主没接"。）
   *
   * 为什么是懒连接而不是启动即连：上面那条独占资源的顾虑成立——stm32-debug 声明
   * swd-probe，MCP server 进程一起来就有机会攥住探针。首个真正需要 MCP 的运行
   * 开始时才连，把常驻进程持有独占资源的窗口压到最短。用完仍要关宿主。
   */
  let mcpRuntime: McpRuntime | undefined;
  let mcpTools: Tool[] = [];
  let mcpConnecting: Promise<void> | undefined;
  let mcpError: string | undefined;

  async function ensureMcp(): Promise<void> {
    if (!mcpEnabled || mcpRuntime || mcpError) return;
    mcpConnecting ??= (async () => {
      try {
        const cfg = await loadMcpConfig(mcpConfigPath);
        if (!cfg) {
          mcpError = `未找到 MCP 配置：${mcpConfigPath}`;
          return;
        }
        const warnings: string[] = [];
        mcpRuntime = await connectMcpServers(cfg, (m) => warnings.push(m));
        mcpTools = mcpRuntime.tools;
        if (warnings.length) mcpError = warnings.join("；");
      } catch (err) {
        mcpError = err instanceof Error ? err.message : String(err);
      }
    })();
    await mcpConnecting;
  }

  function mcpSnapshot(): Record<string, unknown> {
    return {
      configured: existsSync(mcpConfigPath),
      configPath: mcpConfigPath,
      enabled: mcpEnabled,
      connected: Boolean(mcpRuntime),
      servers: mcpRuntime ? Object.entries(mcpRuntime.summary).map(([name, n]) => ({ name, tools: n })) : [],
      toolCount: mcpTools.length,
      ...(mcpError ? { error: mcpError } : {}),
      // reason 三态互斥，不能含糊：没开 / 开了还没轮到 / 试过了但失败。
      // 失败时若还显示"尚未连接"，人会以为再等等就好——那是在骗人（V-04 同族）
      ...(!mcpEnabled
        ? { reason: "Web 宿主默认不接 MCP（设 AGENT_UI_MCP=1 开启）——常驻进程持有独占资源有风险" }
        : mcpRuntime || mcpError
          ? {}
          : { reason: "已开启，但尚未连接——首个需要 MCP 的运行开始时才连（缩短常驻进程持有独占资源的窗口）" }),
    };
  }

  /**
   * 装配一次运行的配置。
   *
   * V-24：pack 与 effort 从进程级常量改为**逐 run 可覆盖**——同一个宿主进程
   * 里跑不同领域的任务是常态，此前只能靠重启换 AGENT_PACK。
   * 未指定时回落到进程级默认（env 装配的那套），行为与改动前一致。
   */
  function buildConfig(
    run?: StoredRun,
    options: { bindExecutionBroker?: boolean } = {},
  ): AgentConfig {
    const runPack = run?.packName ? getPack(run.packName) : pack;
    const runEffort = run?.effort ?? effort;
    const runWorkdir = run?.workdir ?? workdir;
    const systemPrompt = runPack?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    // MCP 工具按包的 includeTools 收窄（selectPackTools 负责）。mcpTools 在
    // ensureMcp 之后才非空——所有 start*Run 都先 await 它，不会拿到半截工具面
    const baseTools = injectedTools ?? (runPack
      ? selectPackTools(runPack, toolPool, mcpTools)
      : [...toolPool, ...mcpTools]);
    /**
     * §5.2：逐 run 显式开启才装（决定 1）。工具实例挂在 run 上而不是每次新造——
     * 配额是逐实例计数的，重造等于配额永不耗尽。
     * verifier/planner 拿不到它：`withoutAskUser` 在 harness 层剔除（决定 3），
     * 宿主这边不必也不该重复实现那道闸。
     */
    const tools = run?.askUser
      ? [...appendMemoryTools(baseTools), (run.askUserTool ??= makeAskUserTool(run))]
      : appendMemoryTools(baseTools);
    // plan 可在 planner 产出后换包。即使初始包（如 stm32-debug）没有 bash，
    // 子任务仍可能选择 python/ts/stm32-coding 并引入 bash；broker 必须在首次
    // planner 模型调用前就按 runId/workdir 固定，不能到子任务里落 legacy lane。
    const planMayIntroduceBash = run?.mode === "plan"
      && (injectedTools ?? enabledBuiltinPool).some((tool) => tool.name === "bash");
    const executionBroker = options.bindExecutionBroker !== false && run && (
      tools.some((tool) => tool.name === "bash") || planMayIntroduceBash
    )
      ? (run.executionBroker ??= executionBrokerFactory(run.id, runWorkdir))
      : undefined;
    const cfg: AgentConfig = {
      systemPrompt,
      tools,
      workdir: runWorkdir,
      ...(executionBroker ? { executionBroker } : {}),
      compat: envCompat,
      // 此前这里只设四个字段，pack 的护栏、只读根、effort 全部丢失
      ...(runEffort ? { effort: runEffort } : {}),
      ...(readRoots.length ? { readRoots } : {}),
      ...(contextTokenLimit !== undefined ? { contextTokenLimit } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...((run?.packName ? runPack?.guardrails?.maxTurns : maxTurns) !== undefined
        ? { maxTurns: (run?.packName ? runPack?.guardrails?.maxTurns : maxTurns) as number }
        : {}),
      ...(maxTotalTurns !== undefined ? { maxTotalTurns } : {}),
      ...(maxTokensBudget !== undefined ? { maxTokensBudget } : {}),
      ...(run?.resumeBudget ? { runBudget: run.resumeBudget } : {}),
      ...(run?.initialContextInputTokens !== undefined
        ? { initialContextInputTokens: run.initialContextInputTokens }
        : {}),
    };
    return taskCompletionEnabled
      ? withTaskCompletion(cfg, {
          ...(progressExtensionTurns !== undefined ? { progressExtensionTurns } : {}),
          ...(stagnationWindow !== undefined ? { stagnationWindow } : {}),
        })
      : cfg;
  }

  function appendMemoryTools(tools: Tool[]): Tool[] {
    const names = new Set(tools.map((tool) => tool.name));
    return [...tools, ...memoryTools.filter((tool) => !names.has(tool.name))];
  }

  async function buildRunConfig(
    run?: StoredRun,
    options: { bindExecutionBroker?: boolean } = {},
  ): Promise<AgentConfig> {
    const cfg = buildConfig(run, options);
    const runWorkdir = run?.workdir ?? workdir;
    return {
      ...cfg,
      dynamicContext: {
        date: new Date().toISOString().slice(0, 10),
        platform: process.platform,
        shell: bashEnabled ? SHELL_DESC : "bash disabled",
        workdir: runWorkdir,
        ...(processExecutionStatus
          ? {
              execution_isolation:
                `${processExecutionStatus.effectiveState}/${processExecutionStatus.resolvedBackend ?? "none"}/${processExecutionStatus.policyDigest}`,
            }
          : {}),
        ...(readRoots.length ? { read_only_roots: readRoots.join("; ") } : {}),
        memory_index: await memoryHost.indexBlock(runWorkdir),
      },
    };
  }

  function toolOrigin(name: string): "builtin" | "memory" | "mcp" {
    if (MEMORY_TOOL_NAMES.has(name)) return "memory";
    if (toolPool.some((builtin) => builtin.name === name)) return "builtin";
    return "mcp";
  }

  function approvalGrantPolicyFor(
    run: StoredRun,
    name: string,
    knownTool?: Tool,
  ): { policy: ResolvedApprovalGrantPolicy; toolFingerprint?: string } {
    const tool = knownTool ?? buildConfig(run).tools.find((candidate) => candidate.name === name);
    const declared = tool?.approvalPolicy;
    const declaredTtl = declared?.maxTtlMs;
    const declaredUses = declared?.maxUses;
    const invalidDeclaredTtl = declaredTtl !== undefined &&
      (!Number.isInteger(declaredTtl) || declaredTtl < 1);
    const invalidDeclaredUses = declaredUses !== undefined &&
      (!Number.isInteger(declaredUses) || declaredUses < 1);
    // 插件/自定义工具是运行时输入；exact-input 的任一限制值畸形时必须退回 once，
    // 不能把 0/NaN 当成“未声明”后反而套用更宽的宿主默认值。
    const maxScope = declared?.maxScope === "exact-input" &&
      !invalidDeclaredTtl && !invalidDeclaredUses
      ? "exact-input"
      : "once";
    const maxTtlMs = Math.min(
      approvalGrantTtlMs,
      Number.isInteger(declaredTtl) && (declaredTtl as number) >= 1
        ? (declaredTtl as number)
        : approvalGrantTtlMs,
    );
    const maxUses = Math.min(
      approvalGrantMaxUses,
      Number.isInteger(declaredUses) && (declaredUses as number) >= 1
        ? (declaredUses as number)
        : approvalGrantMaxUses,
    );
    return {
      policy: { maxScope, maxTtlMs, maxUses },
      ...(tool ? { toolFingerprint: approvalToolFingerprint(tool) } : {}),
    };
  }

  function approvalGrantFailure(
    run: StoredRun,
    grant: ExactInputApprovalRule,
    name: string,
    inputHash: string,
    toolFingerprint: string | undefined,
    at: number,
  ): "run_id_mismatch" | "input_mismatch" | "tool_changed" | "clock_rollback" | "ttl_expired" | "uses_exhausted" | null {
    if (grant.boundRunId !== run.id) return "run_id_mismatch";
    if (grant.name !== name || grant.inputHash !== inputHash) return "input_mismatch";
    if (!toolFingerprint || grant.toolFingerprint !== toolFingerprint) return "tool_changed";
    if (at < grant.issuedAt) return "clock_rollback";
    if (at >= grant.expiresAt) return "ttl_expired";
    if (grant.usedUses >= grant.maxUses) return "uses_exhausted";
    return null;
  }

  function approvalGrantFailureEvent(
    grant: ExactInputApprovalRule,
    failure: Exclude<ReturnType<typeof approvalGrantFailure>, null>,
    at: number,
  ): Record<string, unknown> {
    return {
      type: failure === "ttl_expired" || failure === "clock_rollback"
        ? "approval_grant_expired"
        : "approval_grant_invalidated",
      grantId: grant.grantId,
      boundRunId: grant.boundRunId,
      name: grant.name,
      inputScope: grant.inputScope,
      inputHash: grant.inputHash,
      expiresAt: grant.expiresAt,
      cause: failure,
      actor: "system",
      at,
    };
  }

  /** 新建 grant 前清扫所有陈旧项，避免不同 input 的过期记录永久占满 run 上限。 */
  function sweepInvalidApprovalGrants(run: StoredRun, at: number): void {
    if (!run.autoAllow) return;
    for (const [key, grant] of run.autoAllow) {
      const current = approvalGrantPolicyFor(run, grant.name);
      const failure = approvalGrantFailure(
        run,
        grant,
        grant.name,
        grant.inputHash,
        current.toolFingerprint,
        at,
      );
      if (!failure) continue;
      run.autoAllow.delete(key);
      pushSyntheticEvent(run, "host", approvalGrantFailureEvent(grant, failure, at));
    }
  }

  /** 只把完整 main 段结束时仍有效、仍匹配当前工具定义的 grant 放进审计快照。 */
  function approvalGrantCheckpointSnapshot(run: StoredRun, at: number): ArchivedApprovalGrant[] {
    if (!run.autoAllow) return [];
    const grants: ArchivedApprovalGrant[] = [];
    for (const grant of run.autoAllow.values()) {
      const current = approvalGrantPolicyFor(run, grant.name);
      if (approvalGrantFailure(run, grant, grant.name, grant.inputHash, current.toolFingerprint, at)) continue;
      grants.push({ ...grant });
      if (grants.length >= MAX_APPROVAL_GRANTS_PER_RUN) break;
    }
    return grants;
  }

  /**
   * 核查选项装配（V-06）。
   *
   * 此前调 runVerified 只传了 onEvent——verifyInstructions / readOnlyCommands /
   * rubric 一个没传。后果不是"少显示点东西"：verifier 因此在 Web 上处于**无白名单**
   * 状态，bash 全被拒，只能靠间接证据核查，正是案例 #4 那个 22 轮空转的核查饥饿
   * 配置；rubric 失效则让 advisory 永远为空。
   */
  /** 核查预算：env > 包 > 默认 15（口径同 src/cli.ts 与其它护栏） */
  const envVerifyMaxTurns = process.env.AGENT_VERIFY_MAX_TURNS
    ? Number(process.env.AGENT_VERIFY_MAX_TURNS)
    : undefined;
  const verifyMaxTurnsOf = (p?: DomainPack): number | undefined => {
    if (envVerifyMaxTurns !== undefined && Number.isInteger(envVerifyMaxTurns) && envVerifyMaxTurns >= 1) {
      return envVerifyMaxTurns;
    }
    return p?.verify.maxTurns;
  };

  /**
   * planner 探索预算：env > 包菜单声明取最大 > 默认 12（B0，口径同 src/cli.ts）。
   * 与核查预算的一处结构差异：planner 的菜单是**全部包**（runPlanned 收
   * Object.values(PACKS)），预算跟菜单走，与逐 run 选中的默认包无关。
   */
  const envPlanMaxTurns = (() => {
    const raw = process.env.AGENT_PLAN_MAX_TURNS;
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 ? n : undefined;
  })();
  const plannerBudgetTurns = (): number => resolvePlannerMaxTurns(Object.values(PACKS), envPlanMaxTurns);
  const plannerBudgetSource = (): "env" | "pack" | "default" =>
    envPlanMaxTurns !== undefined
      ? "env"
      : Object.values(PACKS).some((p) => p.plan?.maxTurns !== undefined)
        ? "pack"
        : "default";

  function buildVerifyOptions(run?: StoredRun) {
    const runPack = run?.packName ? getPack(run.packName) : pack;
    // rubric 是任务属性，包只提供缺省：逐 run > env > 包（口径同 src/cli.ts）
    const runRubric = run?.rubric || rubric || runPack?.verify.rubric;
    // 角色模型默认启用（配了就用，口径同 CLI）；逐 run 可显式关掉做 A/B 对照
    const useVerifier = run?.useVerifierModel ?? true;
    return {
      ...(runPack?.verify.instructions ? { verifyInstructions: runPack.verify.instructions } : {}),
      ...(runPack?.verify.readOnlyCommands ? { verifyReadOnlyCommands: runPack.verify.readOnlyCommands } : {}),
      ...(runRubric ? { verifyRubric: runRubric } : {}),
      ...(verifyMaxTurnsOf(runPack) !== undefined ? { verifyMaxTurns: verifyMaxTurnsOf(runPack)! } : {}),
      ...(verifierRole && useVerifier
        ? { verifierModel: { client: verifierRole.provider.client, compat: verifierRole.provider.compat } }
        : {}),
    };
  }

  /**
   * 计划确认门：发出请求事件并挂起，直到委托方应答或 run 收尾。
   *
   * 挂起点选在 onPlan 里（orchestrate 的 `await opts.onPlan?.(plan)`），
   * 所以此时**一个子任务都还没发射**——否决 = 零副作用地停下，这正是
   * 签字位应有的位置。
   *
   * 与工具审批共用的硬性质（都是 V-01/V-02/V-05 的教训）：
   *   · 决策必须进事件流，刷新/重连后仍能看到谁在什么时候批的；
   *   · run 收尾时必须宣告过期并解除挂起，否则编排协程永远吊在这里。
   */
  function waitForPlanDecision(run: StoredRun): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const requestSeq = pushSyntheticEvent(run, "host", {
        type: "plan_approval_request",
        at: Date.now(),
      });
      run.pendingPlan = {
        requestSeq,
        at: Date.now(),
        settle: (decision) => {
          delete run.pendingPlan;
          if (decision === "approve") resolve();
          else reject(new PlanRejectedError(decision === "reject" ? "rejected" : "expired"));
        },
      };
      broadcastLifecycle("run_updated", run);
    });
  }

  /**
   * §5.2 的宿主侧接线：造一个绑定到本 run 的 `ask_user`。
   *
   * 三件事与计划确认门逐条同构（同样是 V-01/V-02/V-05 的教训）：
   *   · 提问与答复都进事件流——刷新/重连后仍看得到问了什么、谁答的；
   *   · run 收尾时必须宣告过期并解除挂起，否则执行协程永远吊在 execute 里；
   *   · 未应答**不是错误**（决定 4）——工具那边会回"按你的最佳判断继续"。
   */
  function pumpQuestionQueue(run: StoredRun): void {
    if (run.pendingQuestion) return;
    const queued = run.questionQueue?.shift();
    if (!queued) return;
    if (run.status === "done" || run.abort?.signal.aborted) {
      queued.resolve(null);
      pumpQuestionQueue(run);
      return;
    }

    const id = `q${run.events.length}`;
    const requestSeq = pushSyntheticEvent(run, "host", {
      type: "user_question_request",
      id,
      questions: queued.questions,
      at: Date.now(),
    });
    applyDurableTransition(run, { type: "question_wait", questionId: id });
    run.pendingQuestion = {
      id,
      requestSeq,
      at: Date.now(),
      questions: queued.questions,
      settle: (answers) => {
        if (run.pendingQuestion?.id === id) delete run.pendingQuestion;
        applyDurableTransition(run, { type: "question_resolved", questionId: id });
        queued.resolve(answers);
        // 计划模式可有多个执行者同时提问；一次只向界面挂一组，答完再开下一组。
        pumpQuestionQueue(run);
      },
    };
    broadcastLifecycle("run_updated", run);
  }

  function makeAskUserTool(run: StoredRun): Tool {
    return createAskUserTool({
      ...(maxAskRounds !== undefined ? { maxRounds: maxAskRounds } : {}),
      ask: (req: { questions: { question: string; options: string[]; fallback: string }[] }) =>
        new Promise<(string | null)[] | null>((resolve) => {
          (run.questionQueue ??= []).push({ questions: req.questions, resolve });
          pumpQuestionQueue(run);
        }),
    });
  }

  /**
   * 解除挂起的提问且**不带答案**的唯一出口。
   *
   * 有两条路会走到这里（收尾、委托方按停止），此前它们各写各的——
   * 结果是停止那条只 settle 不发事件，挂起态消失了却没有任何记录。
   * 挂起态的每一种收场都必须进事件流（V-02 的口径），所以收敛成一个函数。
   */
  function expireQuestion(run: StoredRun, cause: "run_finished" | "stopped"): void {
    // 当前问题之后排队的也必须一起解除；否则并发子任务的 execute promise 会泄漏。
    for (const queued of run.questionQueue?.splice(0) ?? []) queued.resolve(null);
    const pending = run.pendingQuestion;
    if (!pending) return;
    pushSyntheticEvent(run, "host", {
      type: "user_question_expired",
      requestSeq: pending.requestSeq,
      id: pending.id,
      cause,
    });
    // settle 内会 question_resolved + 清 pending；过期事件已先落盘
    pending.settle(null);
  }

  /** 向 run 的所有 SSE 客户端推送一条事件 */
  function broadcastSSE(run: StoredRun, data: string): void {
    for (const client of run.sseClients) {
      try {
        client.write(data);
      } catch {
        run.sseClients.delete(client);
      }
    }
  }

  /**
   * SSE 帧。带 `id:` 是为了让浏览器断线重连时自动带上 Last-Event-ID，
   * 服务端据此只补发缺口而不是整条重放。
   */
  function frameFor(sseEvent: SSEEvent): string {
    return `id: ${sseEvent.seq}\ndata: ${JSON.stringify(sseEvent)}\n\n`;
  }

  /** 推送一条 TurnEvent 到 run 的缓冲与在线 SSE 客户端（不负责完成/关闭逻辑） */
  function pushEvent(run: StoredRun, source: string, event: TurnEvent): number {
    // V-15：流式增量走命名通道，不占 seq、不进 run.events。
    // 此前它和其它事件一样被全量缓冲——一次长运行几万条 delta，晚订阅或重连
    // 时全部重放一遍，纯粹是带宽与内存的浪费（而前端还主动丢弃它们）。
    if (event.type === "text_delta" || event.type === "thinking_delta") {
      // kind 区分文本/思考：两者都不占 seq、都不进缓冲（否则重连重放会把几万条
      // 增量全喷一遍），但前端要分开显示——"它在想什么"与"它在说什么"混成一条
      // 直播条会前言不搭后语
      broadcastSSE(
        run,
        `event: delta\ndata: ${JSON.stringify({
          source,
          kind: event.type === "thinking_delta" ? "thinking" : "text",
          text: event.text,
        })}\n\n`,
      );
      return -1;
    }

    const seq = run.events.length;
    const sseEvent: SSEEvent = {
      seq,
      source,
      ts: Date.now(),
      event: serializeEvent(source, event, run.segmentIndex),
    };
    run.events.push(sseEvent);
    // approval_request 可能同步生成 resolved/expired 等宿主事件；先暂存，确保原始
    // request 自己先进入 durable stream，避免归档出现 seq 倒序或缺口。
    const deferredHostEvents: Record<string, unknown>[] = [];

    // L6 运行台账：按角色累加工具调用。放在这里而不是收尾时回扫 run.events，
    // 是因为续跑会让事件缓冲跨越多段，回扫容易把上一段的数重复计进来。
    if (event.type === "tool_call") tallyToolCall(run.toolTally, source, event.name);
    // OBS-01：事件旁路投影 span（失败不打断 run）
    try {
      if (!run.openToolSpans) run.openToolSpans = new Map();
      const spans = projectTurnEventToSpans({
        runId: run.id,
        source,
        event,
        parentSpanId: run.traceRunSpanId ?? null,
        openTools: run.openToolSpans,
        ts: sseEvent.ts,
      });
      for (const span of spans) run.archiveWriter?.appendTraceSpan(span);
    } catch {
      // 仪器纪律：trace 投影失败不得影响执行
    }
    // 核查撞轮次上限要留痕：案例 #8 的三层归因里，"预算不够"是第二嫌疑，
    // 而此前它只在日志里一闪而过，事后无从统计
    if (event.type === "done" && isVerifierSource(source) && event.result.stopReason === "max_turns") {
      run.verifierHitBudget = true;
    }

    // 成本观测（审计 2026-08-24 high：token 消耗无跨 run 聚合，失控只能等账单）。
    // 挂在事件入口而非收尾回扫：与上面工具台账同一个理由——续跑让缓冲跨段，
    // 回扫会把上一段重复计进来；且长任务的消耗按段落账，不必等 run 收尾。
    // done 的 usage 是每段独立值（loop 每次 run/continuation 各自从零累计），
    // 逐段求和即真实总量。**归属权分工**：verifier 来源在此显式跳过——它的
    // done 被 orchestrate 压掉（runVerifierWithEvents），usage 由 onVerification
    // /plan steps 记账；这里若也记，将来解除压制的那天就是双计的第一天。
    if (event.type === "done" && event.result.usage && !isVerifierSource(source)) {
      growTokens(source === "planner" ? "planner" : "execution", event.result.usage);
    }

    // planner/verifier 的 approval_request 不进 pendingApprovals：二者在内部只读
    // drain 中自答 deny。宿主若先答 allow 或留下 reusable grant，会打穿只读边界。
    if (event.type === "approval_request" && !isInternallyResolvedApprovalSource(source)) {
      const inputHash = approvalInputHash(event.input);
      const ruleKey = exactInputApprovalKey(event.name, inputHash);
      const current = approvalGrantPolicyFor(run, event.name);
      Object.assign(sseEvent.event, {
        inputHash,
        grantPolicy: current.policy,
      });
      /**
       * 精确输入 grant：除 name/hash 外还绑定 runId、工具 fingerprint、绝对 TTL
       * 与最大使用次数。任何一项失配都删除 active grant 并重新挂起。
       */
      let autoApproved = false;
      const grant = run.autoAllow?.get(ruleKey);
      if (grant) {
        const at = approvalClock();
        const failure = approvalGrantFailure(
          run,
          grant,
          event.name,
          inputHash,
          current.toolFingerprint,
          at,
        );
        if (failure) {
          run.autoAllow!.delete(ruleKey);
          deferredHostEvents.push(approvalGrantFailureEvent(grant, failure, at));
        } else {
          grant.usedUses += 1;
          const remainingUses = grant.maxUses - grant.usedUses;
          if (remainingUses === 0) run.autoAllow!.delete(ruleKey);
          event.respond("allow");
          autoApproved = true;
          deferredHostEvents.push({
            type: "approval_resolved",
            requestSeq: seq,
            toolUseId: event.toolUseId,
            name: event.name,
            decision: "allow",
            actor: "auto-rule",
            scope: "run",
            inputScope: "exact-input",
            inputHash,
            grantId: grant.grantId,
            boundRunId: grant.boundRunId,
            issuedAt: grant.issuedAt,
            expiresAt: grant.expiresAt,
            maxUses: grant.maxUses,
            usedUses: grant.usedUses,
            remainingUses,
            at,
          });
          if (remainingUses === 0) {
            deferredHostEvents.push({
              type: "approval_grant_exhausted",
              grantId: grant.grantId,
              boundRunId: grant.boundRunId,
              name: grant.name,
              inputScope: grant.inputScope,
              inputHash: grant.inputHash,
              maxUses: grant.maxUses,
              actor: "system",
              at,
            });
          }
        }
      }
      if (!autoApproved) {
        run.pendingApprovals.set(approvalId(event.toolUseId, seq), {
          toolUseId: event.toolUseId,
          name: event.name,
          input: event.input,
          inputHash,
          grantPolicy: current.policy,
          ...(current.toolFingerprint ? { toolFingerprint: current.toolFingerprint } : {}),
          requestSeq: seq,
          at: sseEvent.ts,
          respond: event.respond,
        });
        // 侧栏的"待审批"计数靠这条推送保鲜，不必再轮询
        broadcastLifecycle("run_updated", run);
      }
    }

    // 段计数在 done 之后递增：done 自身属于刚结束的那一段
    if (event.type === "done") {
      const segment = {
        index: run.segmentIndex,
        source,
        messages: event.result.messages ?? [],
      };
      run.transcript.push(segment);
      // B2 判据①：正文与事件流分开落盘（可达数 MB/段，不能混进重放流）
      run.archiveWriter?.appendTranscriptSegment(segment);
      run.segmentIndex += 1;
      // V-28：留下会话正史，下一轮 runContinuation 要接在它后面。
      // 只认主线（main）——verifier 是全新上下文的独立复核，它的正史不属于对话
      if (source === "main" && event.result.messages?.length) {
        run.history = event.result.messages;
        if (event.result.runBudget) {
          const fallbackContextTokens =
            event.result.usage.inputTokens +
            event.result.usage.cacheCreationTokens +
            event.result.usage.cacheReadTokens;
          run.checkpoint = {
            // segmentIndex 已在上面递增；检查点必须指向刚落盘的真实段号。
            segmentIndex: segment.index,
            conversationTurn: run.conversationTurn,
            contextInputTokens:
              event.result.contextInputTokens ?? fallbackContextTokens,
            runBudget: { ...event.result.runBudget },
            ...(() => {
              const approvalGrants = approvalGrantCheckpointSnapshot(run, approvalClock());
              return approvalGrants.length ? { approvalGrants } : {};
            })(),
          };
        }
      }
    }

    // B2：durable 事件逐条落盘（delta 在上面早已 return——本来就不进缓冲）
    run.archiveWriter?.appendEvent(sseEvent);
    // RUN-01：事件落盘后再迁游标（ADR 写序）。段起点 / 审批挂起。
    if (
      run.durableState &&
      (run.durableState.segmentSource !== source || run.durableState.segmentIndex !== run.segmentIndex) &&
      ["executing", "reworking", "verifying"].includes(run.durableState.phase)
    ) {
      applyDurableTransition(
        run,
        { type: "segment_begin", index: run.segmentIndex, source },
        sseEvent.ts,
      );
    }
    if (
      event.type === "approval_request" &&
      !isInternallyResolvedApprovalSource(source) &&
      run.pendingApprovals.has(approvalId(event.toolUseId, seq))
    ) {
      applyDurableTransition(
        run,
        { type: "approval_wait", approvalId: approvalId(event.toolUseId, seq) },
        sseEvent.ts,
      );
    }
    // 推送给在线 SSE 客户端
    broadcastSSE(run, frameFor(sseEvent));
    for (const deferred of deferredHostEvents) pushSyntheticEvent(run, "host", deferred);
    return seq;
  }

  /**
   * 在本 run 的归属域里跑一段执行（MODEL-01a）。
   *
   * 降级发生在 L0 的 `FallbackModelClient.send` 内部，宿主看不到轮内的事；
   * 唯一能把"这次换端点属于哪个 run"接起来的地方就是发起执行的这一层。
   * 未配降级链时不建域——不为一条没启用的防线给每个 run 加一层 ALS 上下文。
   */
  function withFallbackAttribution<T>(run: StoredRun, body: () => Promise<T>): Promise<T> {
    if (!fallbackChain) return body();
    return fallbackSink.run((info) => {
      run.fallbacks = (run.fallbacks ?? 0) + 1;
      // 来源记 "model"：它既不是模型说的话（main），也不是宿主的决定（host），
      // 而是 L0 这一层的事实。混进 host 会让"谁做的决定"这件事失真。
      pushSyntheticEvent(run, "model", {
        type: "model_fallback",
        from: info.from,
        to: info.to,
        reason: info.reason,
        turn: info.turn,
      });
    }, body);
  }

  /** 推送合成事件（如 verdict / approval_resolved / run_end）到缓冲与在线客户端 */
  function pushSyntheticEvent(run: StoredRun, source: string, event: Record<string, unknown>): number {
    const seq = run.events.length;
    const sseEvent: SSEEvent = { seq, source, ts: Date.now(), event };
    run.events.push(sseEvent);
    run.archiveWriter?.appendEvent(sseEvent);
    broadcastSSE(run, frameFor(sseEvent));
    return seq;
  }

  /**
   * 标记 run 完成并关闭所有 SSE 连接。
   *
   * 顺序是契约的一部分：先把仍挂起的审批逐条宣告过期，再发 run_end，最后才断流。
   * run_end 恒为最后一条 durable 事件——它同时是"整个 run 结束了"的唯一权威信号
   * （段级 done 不是）与客户端"可以主动 close，不要再自动重连"的信号。
   */
  function finalizeRun(run: StoredRun, endInfo: RunEndInfo): void {
    if (run.status === "done") return; // 幂等：异常路径可能重复调用

    for (const pending of run.pendingApprovals.values()) {
      pushSyntheticEvent(run, "host", {
        type: "approval_expired",
        requestSeq: pending.requestSeq,
        toolUseId: pending.toolUseId,
        name: pending.name,
        cause: "run_finished",
      });
    }
    run.pendingApprovals.clear();

    // §5.2 提问同理：挂着不解除，执行协程会永远吊在 ask_user 的 execute 里。
    // 过期走 settle(null) 而不是抛——那是"没人答"，不是故障（决定 4）
    expireQuestion(run, "run_finished");

    // 计划门同理：挂着不解除，编排协程会永远吊在 onPlan 里（V-01 那类失效）
    if (run.pendingPlan) {
      const pendingPlan = run.pendingPlan;
      pushSyntheticEvent(run, "host", {
        type: "plan_approval_expired",
        requestSeq: pendingPlan.requestSeq,
        cause: "run_finished",
      });
      pendingPlan.settle("expired");
    }

    run.status = "done";
    run.finishedAt = Date.now();
    const liveGrantCanContinue =
      !run.verify &&
      run.mode !== "plan" &&
      Boolean(run.loop && run.history?.length) &&
      !(run.checkpoint && exhaustedBudgetReason(run.checkpoint.runBudget));
    if (!liveGrantCanContinue && run.autoAllow?.size) {
      const at = approvalClock();
      for (const grant of run.autoAllow.values()) {
        pushSyntheticEvent(run, "host", {
          type: "approval_grant_invalidated",
          grantId: grant.grantId,
          boundRunId: grant.boundRunId,
          name: grant.name,
          inputScope: grant.inputScope,
          inputHash: grant.inputHash,
          expiresAt: grant.expiresAt,
          cause: "run_not_continuable",
          actor: "system",
          at,
        });
      }
      run.autoAllow.clear();
    }
    // 独占资源随收尾释放（release 按 holder 幂等；追问续跑会重新占用）。
    // 释放后清掉字段：留着旧数组会让它的语义从"当前持有"漂成"最后一次持有"，
    // 后续把它当持有状态读的代码会拿到假数据（评审 de6ddef）
    if (run.heldResources?.length) {
      hostResources.release(run.heldResources, run.id);
      delete run.heldResources;
    }
    if (endInfo.mainStopReason) run.mainStopReason = endInfo.mainStopReason;
    // run_end 之前即启动 worker 回收。清理失败会被全局准入门锁存；继续对话时
    // 也只能在回收完成后创建一个全新的 per-run broker。
    detachAndDisposeExecutionBroker(run);
    metrics.runsFinished.set(endInfo.outcome, (metrics.runsFinished.get(endInfo.outcome) ?? 0) + 1);
    if (realHost) {
      operationalLog("info", "run_finished", {
        runId: run.id,
        outcome: endInfo.outcome,
        stopReason: endInfo.mainStopReason ?? null,
        durationMs: run.finishedAt - run.createdAt,
      });
    }

    // OBS-01：关闭 run 根 span
    if (run.traceRunSpanId && run.archiveWriter) {
      try {
        const closed = endSpan(
          startSpan({
            kind: "run",
            name: "run",
            runId: run.id,
            spanId: run.traceRunSpanId,
            ts: run.createdAt,
            attrs: {},
          }),
          endInfo.outcome === "error" ? "error" : "ok",
          {
            outcome: endInfo.outcome,
            stopReason: endInfo.mainStopReason ?? null,
          },
          run.finishedAt,
        );
        run.archiveWriter.appendTraceSpan(closed);
      } catch {
        // ignore
      }
    }

    // V-07：成本必须用 executionUsage（全部执行轮合计，含被否掉的中间轮）。
    // 前端此前用最后一条 done 的 usage——返工场景下那只是最后一轮，主轮与
    // verifier 的开销全部漏计。核查开销单独列出，口径不混。
    const o = run.outcome;
    const verificationUsage = o
      ? o.verifications.reduce(
          (acc, v) => ({
            inputTokens: acc.inputTokens + v.usage.inputTokens,
            cacheCreationTokens: acc.cacheCreationTokens + v.usage.cacheCreationTokens,
            cacheReadTokens: acc.cacheReadTokens + v.usage.cacheReadTokens,
            outputTokens: acc.outputTokens + v.usage.outputTokens,
            turns: acc.turns + v.usage.turns,
            cacheHitRatio: 0,
          }),
          { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, turns: 0, cacheHitRatio: 0 },
        )
      : undefined;

    pushSyntheticEvent(run, "host", {
      type: "run_end",
      finishedAt: run.finishedAt,
      outcome: endInfo.outcome,
      ...(endInfo.mainStopReason ? { mainStopReason: endInfo.mainStopReason } : {}),
      ...(o
        ? {
            finalPassed: o.finalPassed,
            reworks: o.reworks,
            executionUsage: o.executionUsage,
            verificationUsage,
            verifications: o.verifications.map((v, i) => ({
              round: i,
              verdict: v.verdict,
              usage: v.usage,
              raw: v.raw,
              recovery: v.recovery,
            })),
          }
        : {}),
    });

    for (const client of run.sseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    run.sseClients.clear();

    broadcastLifecycle("run_finished", run);

    /**
     * L6 运行台账（fire-and-forget，永不影响本次运行）。
     *
     * 这一行就是 §2.1 与 9.9 "等证据"能不能等到的全部区别：在此之前
     * `recovery` 只活在内存 Map 里，进程一重启样本归零。
     */
    if (ledgerFile) {
      void appendRunLedger(
        buildLedgerEntry({
        at: run.finishedAt ?? Date.now(),
        runId: run.id,
        host: "web",
        task: run.task,
        pack: run.packName ?? pack?.name ?? null,
        model: process.env.AGENT_MODEL ?? null,
        effort: run.effort ?? null,
        mode: run.mode ?? "single",
        verify: run.verify,
        rubric: run.rubric ?? null,
        stopReason: endInfo.mainStopReason ?? null,
        error:
          endInfo.error ??
          (endInfo.mainStopReason === "error" || endInfo.mainStopReason === "execution_unavailable"
            ? ledgerErrorClass(endInfo.mainStopReason)
            : null),
        turns: o?.executionUsage?.turns ?? null,
        reworks: o?.reworks ?? null,
        finalPassed: o?.finalPassed ?? null,
        verifications: o?.verifications ?? [],
        verifierBudgetTurns: verifyMaxTurnsOf(run.packName ? getPack(run.packName) : pack) ?? null,
        verifierHitBudget: run.verifierHitBudget ?? false,
          fallbackChain,
          fallbacks: run.fallbacks ?? 0,
          tools: run.toolTally,
          durationMs: (run.finishedAt ?? Date.now()) - run.createdAt,
        }),
        ledgerFile,
      );
    }

    // B2：收尾状态整写进档案，然后修剪（判据③）。在跑的 run 受保护不删。
    // 修剪排在本 run 的写入链上：直接 fire-and-forget 会与自己的 meta 写赛跑，
    // 读盘时档案未成形、计数不足就漏剪
    finalizeDurableState(run, endInfo);
    persistMeta(run);
    if (historyRoot && run.archiveWriter) {
      const running = new Set(
        [...runs.values()].filter((r) => r.status === "running").map((r) => r.id),
      );
      run.archiveWriter.schedule(() => pruneHistory(historyRoot, historyKeep, running));
    }
    pruneStoredRuns();
  }

  /** 启动一次不带核查的运行 */
  async function startPlainRun(run: StoredRun): Promise<void> {
    await ensureMcp(); // 必须在 buildConfig 之前：工具面要么齐要么别开跑
    if (!(await pushRunConfig(run))) {
      finalizeRun(run, {
        outcome: "error",
        mainStopReason: "execution_unavailable",
        error: ledgerErrorClass("execution_unavailable"),
      });
      return;
    }
    applyDurableTransition(run, { type: "start" });
    const cfg = await buildRunConfig(run);
    // V-28：实例留给后续对话轮复用——重建的话 ContextManager 的 lastInputTokens
    // 归零，续跑第一轮的压缩判据会失准
    const loop = new AgentLoop(cfg, modelClient);
    run.loop = loop;
    let mainStopReason: string | undefined;
    let mainError: string | null = null;
    try {
      for await (const event of loop.run(run.task, run.abort?.signal)) {
        if (event.type === "done") {
          mainStopReason = event.result.stopReason;
          if (event.result.stopReason === "error" && event.result.error) {
            mainError = ledgerErrorClass(event.result.error);
          }
        }
        pushEvent(run, "main", event);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errorEvent: TurnEvent = {
        type: "done",
        result: {
          stopReason: "error",
          messages: [],
          usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, turns: 0, cacheHitRatio: 0 },
          error: new Error(errorMsg),
        },
      };
      mainStopReason = "error";
      mainError = ledgerErrorClass(err);
      pushEvent(run, "main", errorEvent);
    } finally {
      finalizeRun(run, {
        outcome: runOutcomeForStopReason(mainStopReason),
        ...(mainStopReason ? { mainStopReason } : {}),
        ...(mainError || mainStopReason === "error" ? { error: mainError ?? ledgerErrorClass("error") } : {}),
      });
    }
  }

  /**
   * 追加一轮对话（V-28）。
   *
   * `AgentLoop.runContinuation` 早就存在——它是为返工的 inherit 模式建的，
   * 文档字符串写着"在已有会话正史之上追加一条 user 反馈继续执行"。
   * 也就是说多轮对话在 harness 层一直可行，只是 Web 宿主从没接。
   *
   * 每段 maxTurns 重新起算；AGENT_TOTAL_MAX_TURNS / AGENT_TOTAL_TOKEN_BUDGET
   * 绑定在同一个 AgentLoop 上累计，不会被追加对话重置。
   */
  async function startContinuation(run: StoredRun, feedback: string): Promise<void> {
    const loop = run.loop;
    const history = run.history;
    if (!loop || !history) return;

    run.status = "running";
    delete run.finishedAt;
    run.conversationTurn += 1;
    persistMeta(run); // 追加轮开始也要进档案：轮数与"回到运行中"都是状态

    // 追加的这句话本身要进事件流：它是会话的一部分，也是"这一段为什么开始"的解释
    pushSyntheticEvent(run, "host", {
      type: "user_message",
      turn: run.conversationTurn,
      text: feedback,
      at: Date.now(),
    });
    broadcastLifecycle("run_updated", run);

    // finalizeRun 已把上一段的 broker 从 run 上摘除并启动回收。续跑保留同一个
    // AgentLoop（从而保留 ContextManager 与累计预算），但执行器必须在模型可能
    // 发出下一条 bash tool_use 之前换成一个经过强制探针的新 broker。否则它会
    // 继续持有已 dispose 的旧实例，既错误失败，也绕过本段的 workdir canary。
    if (!(await pushRunConfig(run))) {
      finalizeRun(run, {
        outcome: "error",
        mainStopReason: "execution_unavailable",
        error: ledgerErrorClass("execution_unavailable"),
      });
      return;
    }
    loop.setExecutionBroker(run.executionBroker);

    let mainStopReason: string | undefined;
    let mainError: string | null = null;
    try {
      for await (const event of loop.runContinuation(history, feedback, run.abort?.signal)) {
        if (event.type === "done") {
          mainStopReason = event.result.stopReason;
          if (event.result.stopReason === "error" && event.result.error) {
            mainError = ledgerErrorClass(event.result.error);
          }
        }
        pushEvent(run, "main", event);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      mainStopReason = "error";
      mainError = ledgerErrorClass(err);
      pushSyntheticEvent(run, "main", {
        type: "done",
        stopReason: "error",
        error: { name: "Error", message: errorMsg },
        messageCount: 0,
        usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, turns: 0, cacheHitRatio: 0 },
      });
    } finally {
      finalizeRun(run, {
        outcome: runOutcomeForStopReason(mainStopReason),
        ...(mainStopReason ? { mainStopReason } : {}),
        ...(mainError || mainStopReason === "error" ? { error: mainError ?? ledgerErrorClass("error") } : {}),
      });
    }
  }

  /**
   * 从磁盘检查点派生一次续跑。
   *
   * 这不是把 archived run “复活”：父档案没有 loop/AbortController，也不应再
   * 接收事件。新 run 只继承可序列化的会话正史、上下文水位、累计预算与任务
   * 装配选择；模型/工具/策略取当前宿主，审批放行与 ask_user 已用配额全部重置。
   */
  async function startForkedContinuation(
    run: StoredRun,
    feedback: string,
    parentApprovalGrants: readonly ArchivedApprovalGrant[] = [],
  ): Promise<void> {
    const history = run.history;
    const inheritedBudget = run.resumeBudget;
    if (!history?.length || !inheritedBudget || !run.continuedFrom) {
      pushSyntheticEvent(run, "host", {
        type: "run_fork_failed",
        reason: "派生 run 缺少正史、预算或父级标识",
        at: Date.now(),
      });
      finalizeRun(run, {
        outcome: "error",
        mainStopReason: "error",
        error: ledgerErrorClass("派生 run 缺少正史、预算或父级标识"),
      });
      return;
    }

    applyDurableTransition(run, { type: "start" });

    // 第一条 durable 事件就是环境边界；即使 MCP 连接很慢，人也能立刻看懂
    // 这是从哪里来的、继承了什么、哪些权限状态已清零。
    pushSyntheticEvent(run, "host", {
      type: "run_forked",
      parentRunId: run.continuedFrom,
      rootRunId: run.rootRunId ?? run.continuedFrom,
      boundary: "从归档检查点派生新运行；会话正史与累计预算延续，模型、工具和策略使用当前宿主，父档案保持只读。",
      checkpoint: {
        conversationTurn: run.conversationTurn - 1,
        contextInputTokens: run.initialContextInputTokens ?? 0,
        runBudget: { ...inheritedBudget },
      },
      reset: ["审批放行规则", "挂起交互", "ask_user 已用配额"],
      at: Date.now(),
    });
    // run_forked 必须保持第一条 durable 事件；随后逐条说明父 grant 为什么没有
    // 变成 child capability，最后才记录本轮 user_message。
    for (const grant of parentApprovalGrants) {
      pushSyntheticEvent(run, "host", {
        type: "approval_grant_not_inherited",
        grantId: grant.grantId,
        boundRunId: grant.boundRunId,
        childRunId: run.id,
        name: grant.name,
        inputScope: grant.inputScope,
        inputHash: grant.inputHash,
        expiresAt: grant.expiresAt,
        reason: "run_id_mismatch",
        actor: "system",
        at: approvalClock(),
      });
    }
    pushSyntheticEvent(run, "host", {
      type: "user_message",
      turn: run.conversationTurn,
      text: feedback,
      at: Date.now(),
    });
    broadcastLifecycle("run_updated", run);

    await ensureMcp();
    if (!(await pushRunConfig(run))) {
      finalizeRun(run, {
        outcome: "error",
        mainStopReason: "execution_unavailable",
        error: ledgerErrorClass("execution_unavailable"),
      });
      return;
    }
    const cfg = await buildRunConfig(run);
    const loop = new AgentLoop(cfg, modelClient);
    run.loop = loop;

    let mainStopReason: string | undefined;
    let mainError: string | null = null;
    try {
      for await (const event of loop.runContinuation(history, feedback, run.abort?.signal)) {
        if (event.type === "done") {
          mainStopReason = event.result.stopReason;
          if (event.result.stopReason === "error" && event.result.error) {
            mainError = ledgerErrorClass(event.result.error);
          }
        }
        pushEvent(run, "main", event);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      mainStopReason = "error";
      mainError = ledgerErrorClass(err);
      pushSyntheticEvent(run, "main", {
        type: "done",
        stopReason: "error",
        error: { name: "Error", message: errorMsg },
        messageCount: history.length,
        usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, turns: 0, cacheHitRatio: 0 },
        runBudget: { ...inheritedBudget },
        contextInputTokens: run.initialContextInputTokens ?? 0,
      });
    } finally {
      finalizeRun(run, {
        outcome: runOutcomeForStopReason(mainStopReason),
        ...(mainStopReason ? { mainStopReason } : {}),
        ...(mainError || mainStopReason === "error" ? { error: mainError ?? ledgerErrorClass("error") } : {}),
      });
    }
  }

  /**
   * 启动一次编排运行（V-27）。
   *
   * runPlanned 一直存在却从没接过——服务端只 import 了 runVerified。
   * 三件事必须由宿主装配，缺一个都会让编排退化：
   *   ① packs：planner 的菜单，也是子任务 pack 名的校验依据
   *   ② resolveSubtask：按子任务的包换工具面/prompt/护栏/独占资源。
   *      不给的话每个子任务都用同一份基础配置，"按域分工"就名存实亡；
   *      resources 更是真机域的安全线——同标签子任务必须强制串行，
   *      无锁并发 = 抢探针事故（案例 #3 实录）。
   *   ③ onPlan / 结果合成事件：计划与调度结果不进 TurnEvent 流，
   *      不显式发出来前端就永远看不到 DAG 与并行收益。
   */
  async function startPlannedRun(run: StoredRun): Promise<void> {
    await ensureMcp();
    if (!(await pushRunConfig(run))) {
      finalizeRun(run, {
        outcome: "error",
        mainStopReason: "execution_unavailable",
        error: ledgerErrorClass("execution_unavailable"),
      });
      return;
    }
    applyDurableTransition(run, { type: "plan_begin" });
    const baseCfg = await buildRunConfig(run);
    const startedAt = Date.now();
    let planReadyAt = startedAt;
    const concurrency = run.concurrency ?? "auto";
    let effectiveConcurrency = typeof concurrency === "number" ? concurrency : 1;
    let mainStopReason: string | undefined;
    let mainError: string | null = null;

    try {
      const usePlanner = run.usePlannerModel ?? true;
      const outcome = await runPlanned(baseCfg, modelClient, run.task, {
        packs: Object.values(PACKS),
        concurrency,
        ...(run.abort ? { signal: run.abort.signal } : {}),
        ...(envPlanMaxTurns !== undefined ? { planMaxTurns: envPlanMaxTurns } : {}),
        ...(plannerRole && usePlanner
          ? { plannerModel: { client: plannerRole.provider.client, compat: plannerRole.provider.compat } }
          : {}),
        onPlan: async (plan: Plan) => {
          planReadyAt = Date.now();
          if (concurrency === "auto") {
            effectiveConcurrency = Math.min(AUTO_CONCURRENCY_CAP, planParallelWidth(plan.subtasks));
          }
          const protocol =
            process.env.AGENT_PLAN_PROTOCOL === "structured" ? "structured" : "freeform";
          pushSyntheticEvent(run, "host", {
            type: "plan",
            concurrency: effectiveConcurrency,
            concurrencyMode: concurrency === "auto" ? "auto" : "fixed",
            plannerMs: planReadyAt - startedAt,
            subtasks: plan.subtasks.map((t) => ({
              id: t.id,
              title: t.title,
              pack: t.pack ?? null,
              description: t.description,
              acceptance: t.acceptance,
              dependsOn: t.dependsOn,
              resources: t.resources ?? (t.pack ? getPack(t.pack)?.resources ?? [] : []),
            })),
            /** 门开着时前端要知道"这份计划还在等签字"，而不是以为已经在跑了 */
            gated: Boolean(run.planGate),
          });
          applyDurableTransition(
            run,
            {
              type: "plan_ready",
              plan: durablePlanFromPlan(plan, protocol),
              gated: Boolean(run.planGate),
            },
            planReadyAt,
          );
          // 签字位：计划已发出、一个子任务都还没发射，此时停下是零副作用的
          if (run.planGate) await waitForPlanDecision(run);
        },
        resolveSubtask: (sub: SubTask) => {
          const sp = sub.pack ? getPack(sub.pack) : undefined;
          if (sub.pack && !sp) {
            // 未知包不静默吞：降级用默认配置，但必须让界面看见这次降级
            pushSyntheticEvent(run, "host", {
              type: "plan_warning",
              subtaskId: sub.id,
              message: `未知领域包 "${sub.pack}"，该子任务用默认配置执行`,
            });
          }
          const runRubric = run.rubric || rubric || sp?.verify.rubric;
          // 领域包只收窄业务工具；交互/完成控制面必须随执行者进入每个子任务。
          const controlTools = baseCfg.tools.filter(
            (tool) =>
              tool.name === ASK_USER_TOOL_NAME
              || tool.name === FINISH_TASK_TOOL_NAME
              || MEMORY_TOOL_NAMES.has(tool.name),
          );
          const domainTools = injectedTools ?? selectPackTools(sp, enabledBuiltinPool, mcpTools);
          return {
            cfg: {
              ...baseCfg,
              systemPrompt: sp?.systemPrompt ?? baseCfg.systemPrompt,
              // 逐子任务按各自的包收窄 MCP 工具面：stm32-coding 的 mcp:false
              // 拿不到任何 MCP 工具，stm32-debug 才拿到它 includeTools 里那些
              tools: [...domainTools, ...controlTools].filter(
                (tool, i, all) => all.findIndex((candidate) => candidate.name === tool.name) === i,
              ),
              ...(sp?.guardrails?.maxTurns !== undefined ? { maxTurns: sp.guardrails.maxTurns } : {}),
              ...(sp?.guardrails?.maxTokens !== undefined && maxTokens === undefined
                ? { maxTokens: sp.guardrails.maxTokens }
                : {}),
            },
            verify: {
              ...(sp?.verify.instructions ? { verifyInstructions: sp.verify.instructions } : {}),
              ...(sp?.verify.readOnlyCommands ? { verifyReadOnlyCommands: sp.verify.readOnlyCommands } : {}),
              ...(runRubric ? { verifyRubric: runRubric } : {}),
              // 逐子任务按各自的包取核查预算：编排下 s1(coding) 与 s2(debug)
              // 的核查工作量差一个量级，共用一个数就是案例 #8 那个失效
              ...(verifyMaxTurnsOf(sp) !== undefined ? { verifyMaxTurns: verifyMaxTurnsOf(sp)! } : {}),
            },
            // 独占资源：调度器对同标签子任务强制串行。真机域的探针是全局单件。
            // 兜底链含宿主默认包（评审 de6ddef）：planner 漏写/写错 pack 的子任务
            // 会降级到默认配置执行——工具面照样拿到探针类 MCP 工具，资源声明
            // 却是空的，等于绕过互斥表。与 single 模式按 admissionPack 占用同口径
            ...(sub.resources ?? sp?.resources ?? pack?.resources
              ? { resources: (sub.resources ?? sp?.resources ?? pack?.resources)! }
              : {}),
          };
        },
        onEvent: (source, event) => {
          pushEvent(run, source, event);
        },
        // 核查成本逐轮记账（子任务 verifier 的 done 被 orchestrate 压掉不经
        // pushEvent；此前从返回值 steps 收尾回扫——宿主级异常时已完成轮次
        // 整体漏记，长 run 期间成本指标到收尾才跳变，违背入口记账原则）
        onVerification: (_subtaskId, _round, vo) => {
          growTokens("verification", vo.usage);
        },
        // 跨 run 资源互斥：把宿主表注入调度器——子任务粒度互斥，被别的 run
        // 持有时等待而非 skip；holder 前缀 = runId，冲突诊断可读
        resources: hostResources,
        resourceHolder: run.id,
      });

      const finishedAt = Date.now();
      const stepSum = outcome.steps.reduce((n, st) => n + st.durationMs, 0);
      const subtaskWall = finishedAt - planReadyAt;
      mainStopReason = plannedStopReason(outcome);
      if (mainStopReason === "error") {
        const failed = outcome.steps.find((st) => st.result.main.stopReason === "error");
        mainError = failed?.result.main.error
          ? ledgerErrorClass(failed.result.main.error)
          : ledgerErrorClass(outcome.planOutcome.failureSummary ?? "plan_failed");
      }

      // 并行收益的口径必须写清：子任务阶段墙钟排除 planner，"节省"是相对
      // 串行全序和而言的。不标口径的数字等于没有数字。
      pushSyntheticEvent(run, "host", {
        type: "plan_result",
        completed: outcome.completed,
        planned: Boolean(outcome.plan),
        plannerRaw: outcome.plan ? undefined : outcome.planOutcome.raw.slice(0, 400),
        // B0：计划的获得路径与 fail-closed 过程摘要。没有摘要时，"planner 胡言
        // 乱语"与"探索没来得及收口"在界面上长得一模一样，返工策略却完全不同
        plannerRecovery: outcome.planOutcome.recovery ?? null,
        ...(outcome.planOutcome.failureSummary
          ? { plannerFailure: outcome.planOutcome.failureSummary }
          : {}),
        plannerUsage: outcome.planOutcome.usage,
        ...(outcome.clarification
          ? {
              clarification: {
                task: outcome.clarification.task,
                acceptance: outcome.clarification.acceptance,
                assumptions: outcome.clarification.assumptions,
                asked: outcome.clarification.asked,
                usage: outcome.clarification.usage,
              },
            }
          : {}),
        ...(outcome.planOutcome.inventory ? { inventory: outcome.planOutcome.inventory } : {}),
        steps: outcome.steps.map((st) => ({
          id: st.sub.id,
          title: st.sub.title,
          pack: st.sub.pack ?? null,
          durationMs: st.durationMs,
          passed: st.result.finalPassed,
          reworks: st.result.reworks,
          stopReason: st.result.main.stopReason,
          ...(st.result.main.completion ? { completion: st.result.main.completion } : {}),
          verdict: st.result.verifications.at(-1)?.verdict ?? null,
          usage: st.result.executionUsage,
        })),
        skipped: outcome.skipped.map((t) => ({ id: t.id, title: t.title })),
        timing: {
          totalMs: finishedAt - startedAt,
          plannerMs: planReadyAt - startedAt,
          subtaskWallMs: subtaskWall,
          stepSumMs: stepSum,
          savedMs: Math.max(0, stepSum - subtaskWall),
        },
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      // 计划被否决不是失败，是决定——单独一个终止原因，不混进 error。
      // 混进去界面会显示"异常终止"，那是在对委托方自己的决定说谎（V-04）。
      // B1 收口时发现此前两种 cause 都写成 plan_rejected，前端的
      // plan_gate_expired 分档从未触发过；分流的理由见 planGateStopReason。
      mainStopReason =
        err instanceof PlanRejectedError ? planGateStopReason(err.cause_) : "error";
      if (mainStopReason === "error") mainError = ledgerErrorClass(err);
      pushSyntheticEvent(run, "main", {
        type: "done",
        stopReason: mainStopReason,
        ...(err instanceof PlanRejectedError
          ? {}
          : { error: { name: "Error", message: errorMsg } }),
        ...(err instanceof PlanRejectedError ? { reason: errorMsg } : {}),
        messageCount: 0,
        usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, turns: 0, cacheHitRatio: 0 },
      });
    } finally {
      finalizeRun(run, {
        // 门未应答归 closed、明确否决归 rejected；与其它 stopReason 共用唯一映射。
        outcome: runOutcomeForStopReason(mainStopReason),
        ...(mainStopReason ? { mainStopReason } : {}),
        ...(mainError || mainStopReason === "error" ? { error: mainError ?? ledgerErrorClass("error") } : {}),
      });
    }
  }

  /** 启动一次带核查的运行 */
  async function startVerifiedRun(run: StoredRun): Promise<void> {
    await ensureMcp();
    if (!(await pushRunConfig(run))) {
      finalizeRun(run, {
        outcome: "error",
        mainStopReason: "execution_unavailable",
        error: ledgerErrorClass("execution_unavailable"),
      });
      return;
    }
    applyDurableTransition(run, { type: "start" });
    const cfg = await buildRunConfig(run);
    let mainStopReason: string | undefined;
    let mainError: string | null = null;
    try {
      const outcome = await runVerified(cfg, modelClient, run.task, {
        ...buildVerifyOptions(run),
        ...(run.abort ? { signal: run.abort.signal } : {}),
        onEvent: (source, event) => {
          // 只记主/返工段的终止原因：verifier 的 done 已被 orchestrate 压掉，
          // 这里取到的最后一个就是最终交付那一段的
          if (event.type === "done") {
            mainStopReason = event.result.stopReason;
            if (event.result.stopReason === "error" && event.result.error) {
              mainError = ledgerErrorClass(event.result.error);
            }
          }
          pushEvent(run, source, event);
        },
        // V-08：逐轮裁决实时透出。只发末轮的话，"为什么要返工"（中间轮的 issues）
        // 在界面上永远看不到
        onVerification: (round, vo) => {
          // verifier 的 done 不经 pushEvent（被 orchestrate 压掉），核查成本在此记账
          growTokens("verification", vo.usage);
          pushSyntheticEvent(run, "verifier", {
            type: "verification",
            round,
            verdict: vo.verdict,
            usage: vo.usage,
            // 裁决是怎么拿到的（direct/wrapup/reformat/failed）——让 fail-closed
            // 的三种误伤形态可计量，也是 §2.1 该不该做的判据
            recovery: vo.recovery,
          });
        },
      });
      run.outcome = outcome;
      // 追加 verdict 合成事件（末轮裁决，保持既有契约）
      const lastVerdict = outcome.verifications.at(-1)?.verdict;
      if (lastVerdict) {
        pushSyntheticEvent(run, "verifier", { type: "verdict", verdict: lastVerdict });
      }
      if (!mainStopReason) mainStopReason = outcome.main.stopReason;
      if (mainStopReason === "error" && !mainError && outcome.main.error) {
        mainError = ledgerErrorClass(outcome.main.error);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      mainStopReason = "error";
      mainError = ledgerErrorClass(err);
      pushSyntheticEvent(run, "main", {
        type: "done",
        stopReason: "error",
        error: { name: "Error", message: errorMsg },
        messageCount: 0,
        usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, turns: 0, cacheHitRatio: 0 },
      });
    } finally {
      finalizeRun(run, {
        outcome: runOutcomeForStopReason(mainStopReason),
        ...(mainStopReason ? { mainStopReason } : {}),
        ...(mainError || mainStopReason === "error" ? { error: mainError ?? ledgerErrorClass("error") } : {}),
      });
    }
  }

  /** SSE 事件流：先重放缓冲，再实时推送 */
  function keepSseAlive(req: IncomingMessage, res: ServerResponse, onClose: () => void): void {
    const timer = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(": heartbeat\n\n");
    }, sseHeartbeatMs);
    timer.unref?.();
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      onClose();
    };
    req.once("close", cleanup);
    res.once("close", cleanup);
  }

  function serveSSE(req: IncomingMessage, res: ServerResponse, run: StoredRun): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // 断点续传：浏览器重连时自带 Last-Event-ID，只补发缺口而非整条重放。
    // 前端 reducer 另有 lastSeq 幂等兜底，所以即使这里退化为全量重放也不会串状态。
    const lastEventId = Number(req.headers["last-event-id"]);
    const from = Number.isFinite(lastEventId) ? lastEventId : -1;

    for (const evt of run.events) {
      if (evt.seq <= from) continue;
      res.write(frameFor(evt));
    }

    if (run.status === "done") {
      // run 已结束：重放完即关闭
      res.end();
      return;
    }

    // run 仍在进行：加入在线客户端列表，实时接收新事件
    run.sseClients.add(res);

    // 客户端断开时清理
    keepSseAlive(req, res, () => run.sseClients.delete(res));
  }

  /**
   * 宿主真相快照（V-18 的数据源）。
   *
   * 回答的是"这次运行里模型能做什么、核查者能查什么、边界在哪"——
   * 领域包工具面、MCP 状态、只读根、护栏、effort、核查白名单。这些此前在
   * Web 上完全不可见，用户只能猜。**不含任何密钥**，只暴露 baseURL 级别的信息。
   */
  /** 领域包的对外投影：只给边界与策略，不泄露 systemPrompt */
  function packView(p: ReturnType<typeof getPack>): Record<string, unknown> {
    if (!p) {
      return {
        name: null, description: null, resources: [],
        verify: { enabled: false, mode: null, hasInstructions: false, readOnlyCommands: [], rubricSource: null },
      };
    }
    return {
      name: p.name,
      description: p.description,
      resources: p.resources ?? [],
      verify: {
        enabled: p.verify.enabled,
        mode: p.verify.mode,
        hasInstructions: Boolean(p.verify.instructions),
        readOnlyCommands: p.verify.readOnlyCommands ?? [],
        rubricSource: process.env.AGENT_VERIFY_RUBRIC ? "env" : p.verify.rubric ? "pack" : null,
      },
    };
  }

  /**
   * 本次运行的实际装配（V-24）。
   *
   * 必须逐 run 发一份：pack 现在可以逐 run 覆盖，而 /api/harness 是进程级快照。
   * 若 Tools 面继续读进程默认，用户选了 python-coding 却会看到默认包的工具面与
   * 白名单——界面说谎，正是本项目最忌讳的那类错误。
   */
  function failedRunExecutionBoundary(
    runId: string,
    reason: string,
    base: ExecutionBoundaryStatus = processExecutionStatus,
  ): ExecutionBoundaryStatus {
    return {
      ...base,
      boundaryId: runId,
      effectiveState: "failed",
      resolvedBackend: null,
      probe: {
        state: "unavailable",
        candidate: base.probe.candidate,
        reason,
      },
      coverage: [],
      filesystem: "unavailable: execution admission failed",
      network: "unavailable",
      identity: "unavailable",
      resources: "unavailable",
    };
  }

  function pushRunConfigSnapshot(
    run: StoredRun,
    runPack: ReturnType<typeof getPack>,
    cfg: AgentConfig,
    executionBoundary: ExecutionBoundaryStatus | null,
  ): void {
    pushSyntheticEvent(run, "host", {
      type: "run_config",
      pack: packView(runPack),
      effort: run.effort ?? effort ?? null,
      effortApplies: Boolean(run.effort ?? effort) && !envCompat,
      rubricSource: run.rubric ? "run" : process.env.AGENT_VERIFY_RUBRIC ? "env" : runPack?.verify.rubric ? "pack" : null,
      // 核查预算不再是常数（9.1）：逐 run 按各自的包取，并说明来源——
      // 只报数字而不报来源，人就无法判断"这个值是不是我想要的那个"
      verifierBudgetTurns: verifyMaxTurnsOf(runPack) ?? DEFAULT_VERIFIER_MAX_TURNS,
      verifierBudgetSource: envVerifyMaxTurns !== undefined
        ? "env"
        : runPack?.verify.maxTurns !== undefined
          ? "pack"
          : "default",
      // planner 预算同款（B0）：报数字必须带来源，否则无从判断"这是不是我要的值"
      plannerBudgetTurns: plannerBudgetTurns(),
      plannerBudgetSource: plannerBudgetSource(),
      workdir: cfg.workdir,
      executionIsolation: executionBoundary,
      roleModels: {
        executor: process.env.AGENT_MODEL ?? "claude-opus-4-8",
        // 报的是本 run 实际用了什么，而不是配了什么——两者可以不同
        verifier: verifierRole && (run.useVerifierModel ?? true) ? verifierRole.name : null,
        planner: plannerRole && (run.usePlannerModel ?? true) ? plannerRole.name : null,
        vision: visionRole?.name ?? null,
      },
      /**
       * 端点降级链（MODEL-01a）。未配置时 **null 而不是空数组**：
       * "没有这条防线"与"链上零个备用端点"在界面上必须能分开。
       * 只报名字——链上第二家的 baseURL / key 与角色模型同规格，绝不下发。
       */
      fallbackChain,
      // 三个角色模型不在链上（见装配处的理由）；界面照实说，别让人以为核查也保了底
      fallbackScope: fallbackChain ? "executor" : null,
      guardrails: {
        maxTurns: cfg.maxTurns ?? null,
        maxTokens: cfg.maxTokens ?? null,
        contextTokenLimit: cfg.contextTokenLimit ?? null,
        maxTotalTurns: cfg.maxTotalTurns ?? null,
        maxTokensBudget: cfg.maxTokensBudget ?? null,
      },
      tools: cfg.tools.map((tool) => ({
        name: tool.name,
        permission: tool.permission,
        parallelSafe: tool.parallelSafe,
        // 已有 tool 实例时不要再 buildConfig；早拒路径必须保持 broker factory=0。
        approvalPolicy: approvalGrantPolicyFor(run, tool.name, tool).policy,
        origin: toolOrigin(tool.name),
      })),
    });
  }

  async function pushRunConfig(run: StoredRun): Promise<boolean> {
    const runPack = run.packName ? getPack(run.packName) : pack;
    // 若 cleanup 在路由预检之后、进入本启动函数之前已经挂起，连 per-run
    // canary worker 都不应创建。这里必须早于 buildConfig：后者会按需构造 broker。
    const preProbeBlockReason = executionAdmissionBlockReason();
    if (preProbeBlockReason) {
      // 早拒也必须先落 durable run_config。用不绑定 broker 的纯配置投影，避免
      // 为了 UI/审计真值反过来创建本应被准入门挡住的 worker capability。
      const cfg = buildConfig(run, { bindExecutionBroker: false });
      const failedBoundary = failedRunExecutionBoundary(run.id, preProbeBlockReason);
      run.executionBoundaryStatus = failedBoundary;
      pushRunConfigSnapshot(run, runPack, cfg, failedBoundary);
      pushSyntheticEvent(run, "host", {
        type: "execution_boundary_failed",
        boundaryId: run.id,
        policyDigest: failedBoundary.policyDigest,
        reason: preProbeBlockReason,
      });
      return false;
    }
    const cfg = buildConfig(run);
    const executionBoundary = cfg.executionBroker
      ? await cfg.executionBroker.probe(true)
      : null;
    if (executionBoundary) run.executionBoundaryStatus = executionBoundary;
    // 所有会触发模型的入口（plain / verified / plan / continuation / archive fork）
    // 都汇聚于此。canary 自己也会 await，所以完成后还要再读一次宿主 cleanup
    // gate，封住“pre-check 通过 → probe 期间另一 run 开始清理”的第二个窗口。
    const admissionBlockReason = executionAdmissionBlockReason();
    const failureReason = executionBoundary?.effectiveState === "failed"
      ? executionBoundary.probe.reason ?? "required isolation backend unavailable"
      : admissionBlockReason;
    const reportedBoundary = failureReason
      ? failedRunExecutionBoundary(run.id, failureReason, executionBoundary ?? processExecutionStatus)
      : executionBoundary;
    if (reportedBoundary) run.executionBoundaryStatus = reportedBoundary;
    pushRunConfigSnapshot(run, runPack, cfg, reportedBoundary);
    if (failureReason) {
      pushSyntheticEvent(run, "host", {
        type: "execution_boundary_failed",
        boundaryId: reportedBoundary?.boundaryId ?? run.id,
        policyDigest: reportedBoundary?.policyDigest ?? processExecutionStatus.policyDigest,
        reason: failureReason,
      });
      return false;
    }
    return true;
  }

  function harnessSnapshot(): Record<string, unknown> {
    const tools = buildConfig().tools;
    return {
      model: process.env.AGENT_MODEL ?? "claude-opus-4-8",
      provider: process.env.AGENT_PROVIDER ?? "anthropic",
      compat: envCompat,
      // compat 模式下第三方端点不认识 output_config.effort，harness 不会发送它——
      // 界面必须说清楚，否则用户以为自己设的档位生效了
      effort: effort ?? null,
      effortApplies: Boolean(effort) && !envCompat,
      shell: bashEnabled ? SHELL_DESC : null,
      executionIsolation: bashEnabled ? processExecutionStatus : null,
      workdir,
      readRoots,
      memory: {
        enabled: true,
        dir: defaultMemoryDir,
        toolCount: memoryTools.length,
      },
      guardrails: {
        maxTurns: maxTurns ?? null,
        maxTokens: maxTokens ?? null,
        contextTokenLimit: contextTokenLimit ?? null,
        maxTotalTurns: maxTotalTurns ?? null,
        maxTokensBudget: maxTokensBudget ?? null,
      },
      hostLimits: {
        requestBodyMaxBytes,
        maxActiveRuns,
        maxStoredRuns,
        mutationRateLimitPerMinute,
        bashEnabled,
        approvalGrantTtlMs,
        approvalGrantMaxUses,
      },
      compactWatermark: 0.8,
      uploadSubdir: UPLOAD_SUBDIR,
      uploadMaxBytes: UPLOAD_MAX_BYTES,
      // V-24：提交表单要能列出可选领域包。只给名字与描述，不泄露 systemPrompt
      availablePacks: Object.entries(PACKS).map(([name, p]) => ({
        name,
        description: p.description,
        verifyMode: p.verify.mode ?? null,
        hasRubric: Boolean(p.verify.rubric),
      })),
      effortLevels: [...EFFORT_LEVELS],
      // V-29：合法工作目录集合由宿主声明，浏览器只在其中选
      availableWorkdirs: allowedWorkdirs,
      /**
       * V-30 角色模型。**只报模型名与 provider，绝不下发密钥或 baseURL** ——
       * 浏览器能决定的是"这次用不用独立角色模型"，不是"用哪个 key 连哪个端点"。
       */
      roleModels: {
        executor: { model: process.env.AGENT_MODEL ?? "claude-opus-4-8", provider: process.env.AGENT_PROVIDER ?? "anthropic" },
        verifier: verifierRole
          ? { model: verifierRole.name, provider: verifierRole.provider.provider, configured: true }
          : { configured: false },
        planner: plannerRole
          ? { model: plannerRole.name, provider: plannerRole.provider.provider, configured: true }
          : { configured: false },
        vision: visionRole
          ? { model: visionRole.name, provider: visionRole.provider.provider, configured: true }
          : { configured: false },
      },
      // MODEL-01a：进程级降级链快照（逐 run 的同名字段走 run_config）。
      // null = 未配置这条防线，与"链上只有主端点"不是一回事
      fallbackChain,
      fallbackScope: fallbackChain ? "executor" : null,
      // 核查预算与执行者解耦，但**不是常数**（9.1）：领域包可用 verify.maxTurns
      // 覆盖。这里报进程级默认包的值；逐 run 的真实值走 run_config
      verifierBudgetTurns: verifyMaxTurnsOf(pack) ?? DEFAULT_VERIFIER_MAX_TURNS,
      verifierBudgetSource: envVerifyMaxTurns !== undefined
        ? "env"
        : pack?.verify.maxTurns !== undefined
          ? "pack"
          : "default",
      plannerBudgetTurns: plannerBudgetTurns(),
      plannerBudgetSource: plannerBudgetSource(),
      pack: packView(pack),
      tools: tools.map((t) => ({
        name: t.name,
        permission: t.permission,
        parallelSafe: t.parallelSafe,
        approvalPolicy: t.approvalPolicy ?? { maxScope: "once" },
        origin: toolOrigin(t.name),
      })),
      mcp: mcpSnapshot(),
    };
  }

  function activeRunCount(): number {
    let count = 0;
    for (const run of runs.values()) if (run.status === "running") count += 1;
    return count;
  }

  /** 预留一个启动槽，覆盖“检查上限”到 runs.set/status=running 之间的竞态窗口。 */
  function acquireRunAdmission(): (() => void) | null {
    if (activeRunCount() + pendingAdmissions >= maxActiveRuns) return null;
    pendingAdmissions += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pendingAdmissions = Math.max(0, pendingAdmissions - 1);
    };
  }

  function rejectAtCapacity(res: ServerResponse): void {
    metrics.capacityRejected += 1;
    res.setHeader("Retry-After", "1");
    json(res, 429, {
      error: `Active run limit reached (${maxActiveRuns})`,
      activeRuns: activeRunCount(),
    });
  }

  /**
   * 日预算门（审计 2026-08-24 high 的执行半边：此前唯一防线是操作员肉眼看账）。
   * 只拦**新的执行准入**——在飞 run 永不掐：掐半截既毁产物又不省多少钱。
   * 返回 null = 未启用 / 有余量 / 账本已翻日。
   */
  function dailyBudgetRefusal(): { used: number; budget: number; now: Date } | null {
    if (dailyTokenBudget === undefined) return null;
    // 判定与 Retry-After 计算共用同一个 now：拒绝路径若各取时刻，跨午夜的
    // 毫秒级竞态会把 Retry-After 指到后天零点（评审点名）
    const now = new Date();
    if (dailyTokens.day !== localDayKey(now)) return null;
    return dailyTokens.used >= dailyTokenBudget
      ? { used: dailyTokens.used, budget: dailyTokenBudget, now }
      : null;
  }

  /**
   * 独占资源准入（single/verified 模式）：包声明的资源被别的 run 持有 → 429
   * 附持有者；全部空闲 → 以 runId 为 holder 整体占用。plan 模式不走这里。
   * 返回 null 表示已占用成功（或无资源要占）。
   */
  function acquireRunResources(
    res: ServerResponse,
    runId: string,
    tags: string[],
  ): "acquired" | "refused" {
    if (tags.length === 0 || hostResources.tryAcquire(tags, runId)) return "acquired";
    const conflict = tags.find((t) => {
      const h = hostResources.holderOf(t);
      return h !== undefined && h !== runId;
    })!;
    metrics.resourceRejected += 1;
    json(res, 429, {
      error:
        `Exclusive resource "${conflict}" is held by run ${hostResources.holderOf(conflict)}. ` +
        "Wait for that run to finish (or stop it), then retry.",
      resource: conflict,
      heldBy: hostResources.holderOf(conflict),
    });
    return "refused";
  }

  /** 与目标 workdir 相同的在飞 run（resolve 后精确比对，口径同白名单校验） */
  function runningWorkdirConflict(targetWorkdir: string, excludeRunId?: string): StoredRun | undefined {
    const target = resolve(targetWorkdir);
    for (const r of runs.values()) {
      if (r.status !== "running" || r.id === excludeRunId) continue;
      if (resolve(r.workdir ?? workdir) === target) return r;
    }
    return undefined;
  }

  /** 同 workdir 并发：exclusive 时 409 拒绝（返回 true 表示已拒），否则告警放行 */
  function refuseOrWarnSharedWorkdir(
    res: ServerResponse,
    runId: string,
    targetWorkdir: string,
    excludeRunId?: string,
  ): boolean {
    const conflict = runningWorkdirConflict(targetWorkdir, excludeRunId);
    if (!conflict) return false;
    if (exclusiveWorkdir) {
      metrics.workdirRejected += 1;
      json(res, 409, {
        error:
          `Workdir is in use by running run ${conflict.id}. Concurrent runs sharing a workdir ` +
          "can silently overwrite each other's artifacts; give each run its own workdir " +
          "(AGENT_UI_WORKDIRS) or wait for the other run.",
        conflictRunId: conflict.id,
      });
      return true;
    }
    operationalLog("warn", "workdir_shared", {
      runId,
      conflictRunId: conflict.id,
      workdir: resolve(targetWorkdir),
    });
    return false;
  }

  function rejectAtDailyBudget(res: ServerResponse, info: { used: number; budget: number; now: Date }): void {
    metrics.budgetRejected += 1;
    const now = info.now;
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((midnight.getTime() - now.getTime()) / 1000))));
    json(res, 429, {
      error:
        `Daily token budget exhausted: ${info.used} of ${info.budget} non-cache-read tokens used today. ` +
        "Running tasks are unaffected; admission reopens tomorrow, or raise AGENT_UI_DAILY_TOKEN_BUDGET and restart.",
      dailyTokensUsed: info.used,
      dailyTokenBudget: info.budget,
    });
  }

  function mutationRetryAfter(req: IncomingMessage): number | null {
    if (mutationRateLimitPerMinute === Number.MAX_SAFE_INTEGER) return null;
    const key = req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    let window = mutationWindows.get(key);
    if (!window && mutationWindows.size >= 10_000) {
      for (const [candidate, value] of mutationWindows) {
        if (now - value.startedAt >= 60_000) mutationWindows.delete(candidate);
      }
      // 不让攻击者用无限源地址把 limiter 自己变成内存泄漏；表满时新来源先退避。
      if (mutationWindows.size >= 10_000) return 60;
    }
    if (!window || now - window.startedAt >= 60_000) {
      window = { startedAt: now, count: 0 };
      mutationWindows.set(key, window);
    }
    if (window.count >= mutationRateLimitPerMinute) {
      return Math.max(1, Math.ceil((60_000 - (now - window.startedAt)) / 1_000));
    }
    window.count += 1;
    return null;
  }

  function healthBody(ready: boolean): Record<string, unknown> {
    return {
      status: ready ? "ready" : "degraded",
      uptimeMs: Date.now() - startedAt,
      shuttingDown,
      activeRuns: activeRunCount(),
      history: {
        enabled: Boolean(historyRoot),
        healthy: historyHealthy,
        // 公共探针不回显可能带绝对路径的底层错误。
        error: historyHealthy ? null : "history_write_failed",
      },
      execution: {
        enabled: bashEnabled,
        healthy: executionHealthy,
        // /ready 默认未认证；只报稳定枚举，不回显 runtime/socket/workdir 绝对路径。
        status: {
          requestedMode: processExecutionStatus.requestedMode,
          requestedBackend: processExecutionStatus.requestedBackend,
          effectiveState: processExecutionStatus.effectiveState,
          resolvedBackend: processExecutionStatus.resolvedBackend,
          probe: {
            state: processExecutionStatus.probe.state,
            candidate: processExecutionStatus.probe.candidate,
            code: executionHealthy ? null : "execution_backend_unavailable",
          },
          coverage: [...processExecutionStatus.coverage],
        },
      },
    };
  }

  function prometheusMetrics(): string {
    // 5xx 序列预注册为 0（评审 2026-08-24）："见过才存在"的序列首次出现时
    // 以非零值出生，rate() 把出生初值记 0 增量——两次抓取间隔内的一次 5xx
    // 爆发若随后恢复，HighHttpErrorRate 告警永远看不到那段增量。与
    // runs_finished 的六档全集输出同一个道理。
    const statuses = new Map<number, number>([[500, 0], [502, 0], [503, 0], [504, 0]]);
    for (const [status, count] of metrics.httpStatuses) statuses.set(status, count);
    const statusLines = [...statuses.entries()]
      .sort(([left], [right]) => left - right)
      .map(([status, count]) => `agent_harness_http_responses_total{status="${status}"} ${count}`);
    return [
      "# TYPE agent_harness_http_requests_total counter",
      `agent_harness_http_requests_total ${metrics.httpRequests}`,
      "# TYPE agent_harness_http_responses_total counter",
      ...statusLines,
      "# TYPE agent_harness_active_runs gauge",
      `agent_harness_active_runs ${activeRunCount()}`,
      "# TYPE agent_harness_ready gauge",
      `agent_harness_ready ${historyHealthy && executionHealthy && !shuttingDown ? 1 : 0}`,
      "# TYPE agent_harness_runs_started_total counter",
      `agent_harness_runs_started_total ${metrics.runsStarted}`,
      "# TYPE agent_harness_runs_finished_total counter",
      // 全部 outcome 逐值输出（含 0）：错误率的 PromQL 比值查询需要稳定的序列集，
      // "出现过才有序列"会让告警在第一次错误前后看到不同的向量形状
      ...RUN_OUTCOMES.map(
        (o) => `agent_harness_runs_finished_total{outcome="${o}"} ${metrics.runsFinished.get(o) ?? 0}`,
      ),
      "# TYPE agent_harness_tokens_total counter",
      // 12 序列全集恒在场（role × kind，含 0），与 runs_finished 六档同一个道理
      ...TOKEN_ROLES.flatMap((role) =>
        TOKEN_KINDS.map(
          (kind) => `agent_harness_tokens_total{role="${role}",kind="${kind}"} ${metrics.tokens.get(`${role}/${kind}`) ?? 0}`,
        ),
      ),
      "# TYPE agent_harness_security_rejections_total counter",
      `agent_harness_security_rejections_total{reason="origin"} ${metrics.originRejected}`,
      `agent_harness_security_rejections_total{reason="auth"} ${metrics.authRejected}`,
      `agent_harness_security_rejections_total{reason="host"} ${metrics.hostRejected}`,
      `agent_harness_security_rejections_total{reason="body"} ${metrics.bodyRejected}`,
      `agent_harness_security_rejections_total{reason="rate"} ${metrics.rateRejected}`,
      `agent_harness_security_rejections_total{reason="capacity"} ${metrics.capacityRejected}`,
      `agent_harness_security_rejections_total{reason="budget"} ${metrics.budgetRejected}`,
      `agent_harness_security_rejections_total{reason="resource"} ${metrics.resourceRejected}`,
      `agent_harness_security_rejections_total{reason="workdir"} ${metrics.workdirRejected}`,
      "# TYPE agent_harness_daily_tokens_used gauge",
      // 非 cache_read 口径的当日消耗（本地日界；进程重启归零）。配了日预算时
      // 运维靠它直读余量，没配时它就是当日烧量的直接读数
      `agent_harness_daily_tokens_used ${dailyTokens.day === localDayKey() ? dailyTokens.used : 0}`,
      "# TYPE agent_harness_history_errors_total counter",
      `agent_harness_history_errors_total ${metrics.historyErrors}`,
      "",
    ].join("\n");
  }

  /**
   * 把 URL 里的 approvalRef 解析为挂起审批。
   * - `toolUseId#seq`：精确匹配某一轮的那张卡（前端一律用这种形式）
   * - `toolUseId`：取该 id 下 requestSeq 最大的挂起项（兼容形式）
   */
  function resolveApprovalRef(
    run: StoredRun,
    ref: string,
  ): { key?: string; pending?: PendingApproval } {
    if (ref.includes("#")) {
      const pending = run.pendingApprovals.get(ref);
      return pending ? { key: ref, pending } : {};
    }
    let best: { key: string; pending: PendingApproval } | undefined;
    for (const [key, pending] of run.pendingApprovals) {
      if (pending.toolUseId !== ref) continue;
      if (!best || pending.requestSeq > best.pending.requestSeq) best = { key, pending };
    }
    return best ?? {};
  }

  // ------------------------------------------------------
  // Route matching
  // ------------------------------------------------------

  function matchRoute(
    method: string,
    url: string,
  ):
    | { type: "static"; filePath: string }
    | { type: "health" }
    | { type: "ready" }
    | { type: "metrics" }
    | { type: "harness" }
    | { type: "runsList" }
    | { type: "lifecycleStream" }
    | { type: "transcript"; runId: string }
    | { type: "trace"; runId: string }
    | { type: "inspectPaths"; runId: string }
    | { type: "artifact"; runId: string; path: string; download: boolean }
    | { type: "reveal"; runId: string }
    | { type: "stop"; runId: string }
    | { type: "followUp"; runId: string }
    | { type: "upload" }
    | { type: "createRun" }
    | { type: "events"; runId: string }
    | { type: "approval"; runId: string; toolUseId: string }
    | { type: "planApproval"; runId: string }
    | { type: "answer"; runId: string }
    | { type: "malformed" } {
    if (method === "GET" && url === "/health") return { type: "health" };
    if (method === "GET" && url === "/ready") return { type: "ready" };
    if (method === "GET" && url === "/metrics") return { type: "metrics" };
    if (method === "GET" && (url === "/" || url === "/index.html")) {
      return { type: "static", filePath: "index.html" };
    }
    if (method === "GET" && url.startsWith("/") && !url.startsWith("/api/")) {
      const file = url.slice(1);
      if (file.includes("..")) return { type: "malformed" };
      return { type: "static", filePath: file };
    }

    if (method === "GET" && url === "/api/harness") {
      return { type: "harness" };
    }

    if (method === "GET" && url === "/api/runs") {
      return { type: "runsList" };
    }

    if (method === "GET" && url === "/api/stream") {
      return { type: "lifecycleStream" };
    }

    const transcriptMatch = method === "GET" && url.match(/^\/api\/runs\/([^/]+)\/transcript$/);
    if (transcriptMatch) {
      return { type: "transcript", runId: transcriptMatch[1]! };
    }
    const traceMatch = method === "GET" && url.match(/^\/api\/runs\/([^/]+)\/trace$/);
    if (traceMatch) {
      return { type: "trace", runId: traceMatch[1]! };
    }

    const inspectPathsMatch =
      method === "POST" && url.match(/^\/api\/runs\/([^/]+)\/paths\/inspect$/);
    if (inspectPathsMatch) {
      return { type: "inspectPaths", runId: inspectPathsMatch[1]! };
    }

    /**
     * 产物取件（委托方："最终生成的文件有没有办法有超链接给用户直接点击打开"）。
     *
     * 不能用 `file://`——浏览器一律拦截 http 页面跳本地文件协议。所以要经宿主：
     * 它知道这次运行的 workdir，也只肯在那个圈里取文件。
     */
    const artifactMatch = method === "GET" && url.match(/^\/api\/runs\/([^/]+)\/artifact\?(.*)$/);
    if (artifactMatch) {
      const q = new URLSearchParams(artifactMatch[2]!);
      const wanted = q.get("path");
      if (!wanted) return { type: "malformed" };
      return {
        type: "artifact",
        runId: artifactMatch[1]!,
        path: wanted,
        download: q.get("download") === "1",
      };
    }

    const revealMatch = method === "POST" && url.match(/^\/api\/runs\/([^/]+)\/reveal$/);
    if (revealMatch) {
      return { type: "reveal", runId: revealMatch[1]! };
    }

    const stopMatch = method === "POST" && url.match(/^\/api\/runs\/([^/]+)\/stop$/);
    if (stopMatch) {
      return { type: "stop", runId: stopMatch[1]! };
    }

    if (method === "POST" && url === "/api/upload") {
      return { type: "upload" };
    }

    const followUpMatch = method === "POST" && url.match(/^\/api\/runs\/([^/]+)\/messages$/);
    if (followUpMatch) {
      return { type: "followUp", runId: followUpMatch[1]! };
    }

    if (method === "POST" && url === "/api/runs") {
      return { type: "createRun" };
    }

    const eventsMatch = method === "GET" && url.match(/^\/api\/runs\/([^/]+)\/events$/);
    if (eventsMatch) {
      return { type: "events", runId: eventsMatch[1]! };
    }

    const planApprovalMatch = method === "POST" && url.match(/^\/api\/runs\/([^/]+)\/plan-approval$/);
    if (planApprovalMatch) {
      return { type: "planApproval", runId: planApprovalMatch[1]! };
    }

    // §5.2：委托方回答 agent 的澄清问题（或显式跳过）
    const answerMatch = method === "POST" && url.match(/^\/api\/runs\/([^/]+)\/answer$/);
    if (answerMatch) {
      return { type: "answer", runId: answerMatch[1]! };
    }

    const approvalMatch = method === "POST" && url.match(/^\/api\/runs\/([^/]+)\/approvals\/([^/]+)$/);
    if (approvalMatch) {
      // approvalId 形如 `toolUseId#seq`；`#` 在 URL 里是片段分隔符，客户端必须
      // encodeURIComponent 后再拼路径，这里对应解码
      return {
        type: "approval",
        runId: approvalMatch[1]!,
        toolUseId: safeDecode(approvalMatch[2]!),
      };
    }

    return { type: "malformed" };
  }

  // ------------------------------------------------------
  // HTTP handler
  // ------------------------------------------------------

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    metrics.httpRequests += 1;
    res.once("finish", () => {
      const status = res.statusCode;
      metrics.httpStatuses.set(status, (metrics.httpStatuses.get(status) ?? 0) + 1);
      if (status === 413) metrics.bodyRejected += 1;
    });
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url, sameOriginOf(req, trustProxy) ?? "http://localhost");
    } catch {
      return badRequest(res, "Malformed request URL");
    }
    const hostname = requestHostname(req, trustProxy);
    if (!hostname || (!isLoopbackHostname(hostname) && !allowedHosts.has(hostname))) {
      metrics.hostRejected += 1;
      if (realHost) {
        operationalLog("warn", "request_rejected", { reason: "host", method, path: parsedUrl.pathname });
      }
      return json(res, 421, { error: "Untrusted Host header" });
    }

    // 令牌宿主的浏览器引导：令牌只在首次 URL 中出现，校验后写 HttpOnly cookie
    // 并立刻 303 到无查询串地址。EventSource 随后可沿同源 cookie 完成认证。
    if (
      method === "GET" &&
      (parsedUrl.pathname === "/" || parsedUrl.pathname === "/index.html") &&
      parsedUrl.searchParams.has("access_token")
    ) {
      const supplied = parsedUrl.searchParams.get("access_token") ?? undefined;
      if (!accessToken || !secureStringEqual(supplied, accessToken)) {
        res.setHeader("WWW-Authenticate", "Bearer");
        return json(res, 401, { error: "Invalid access token" });
      }
      const secure = sameOriginOf(req, trustProxy)?.startsWith("https://") ? "; Secure" : "";
      res.setHeader(
        "Set-Cookie",
        `agent_ui_access=${encodeURIComponent(accessToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}`,
      );
      res.writeHead(303, { Location: parsedUrl.pathname });
      res.end();
      return;
    }

    // CORS 头本身不会阻止 text/plain/no-cors 副作用；因此在任何路由执行前
    // 主动拒绝不受信 Origin。该检查与访问令牌互为独立安全边界。
    if (!originAllowed(req, allowedOrigins, trustProxy)) {
      metrics.originRejected += 1;
      if (realHost) {
        operationalLog("warn", "request_rejected", { reason: "origin", method, path: parsedUrl.pathname });
      }
      return json(res, 403, { error: `Origin not allowed: ${req.headers.origin}` });
    }
    applyCors(req, res, allowedOrigins, trustProxy);
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const route = matchRoute(method, url);

    if (accessToken && (parsedUrl.pathname.startsWith("/api/") || route.type === "metrics")) {
      if (!secureStringEqual(requestAccessToken(req), accessToken)) {
        metrics.authRejected += 1;
        if (realHost) {
          operationalLog("warn", "request_rejected", { reason: "auth", method, path: parsedUrl.pathname });
        }
        res.setHeader("WWW-Authenticate", "Bearer");
        return json(res, 401, { error: "Authentication required" });
      }
    }

    if (method === "POST") {
      const retryAfter = mutationRetryAfter(req);
      if (retryAfter !== null) {
        metrics.rateRejected += 1;
        res.setHeader("Retry-After", String(retryAfter));
        return json(res, 429, { error: "Mutation rate limit exceeded" });
      }
      const jsonRoute = new Set([
        "upload",
        "followUp",
        "inspectPaths",
        "reveal",
        "createRun",
        "planApproval",
        "answer",
        "approval",
      ]).has(route.type);
      const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
      if (jsonRoute && !/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/.test(contentType)) {
        return json(res, 415, { error: "Content-Type must be application/json" });
      }
    }

    // B2：档案恢复完成前不应答 API——启动后的第一个 GET /api/runs 就要看得到
    // 历史，否则界面会先画一份空列表再闪一次（静态资源不用等）
    if (route.type !== "static" && route.type !== "health" && route.type !== "metrics") {
      await Promise.all([historyReady, executionReady]);
    }

    switch (route.type) {
      case "malformed":
        return notFound(res, `Unknown route: ${method} ${url}`);

      case "health":
        return json(res, 200, { status: "ok", uptimeMs: Date.now() - startedAt });

      case "ready": {
        // readiness 是运行时事实，但端点本身未认证：走 broker 的短 TTL + 并发
        // 去重，避免公网探针把 dockerd 放大成每请求一个 canary container。
        if (!shuttingDown) await refreshExecutionHealth(false);
        const ready = historyHealthy && executionHealthy && !shuttingDown;
        return json(res, ready ? 200 : 503, healthBody(ready));
      }

      case "metrics":
        res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
        res.end(prometheusMetrics());
        return;

      case "harness":
        return json(res, 200, harnessSnapshot());

      case "runsList": {
        // V-13：按 createdAt 降序。此前是插入顺序（最旧在上），而客户端提交后把
        // 新任务 unshift 到顶——3 秒后一轮询它就从顶跳到底。
        const list = [...runs.values()]
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(runSummary);
        return json(res, 200, list);
      }

      case "upload": {
        /**
         * V-34 上传：文件一律落进**工作目录之内**，而且只落在白名单声明过的
         * 那些目录里。上传是宿主侧的写入（用户自己在写，不是 agent），所以
         * 不走审批门；但写入边界一步都不能放松——它和工具的圈禁根是同一条线。
         */
        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let parsed: { name?: string; data?: string; workdir?: string };
        try {
          parsed = JSON.parse(body);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }
        if (typeof parsed.name !== "string" || !parsed.name.trim()) {
          return badRequest(res, 'Missing or invalid "name" field');
        }
        if (typeof parsed.data !== "string") {
          return badRequest(res, 'Missing or invalid "data" field (base64)');
        }

        // 默认值也必须 resolve：allowedWorkdirs 存的是规范化后的绝对路径，
        // 而 options.workdir 可能是 `D:/a/b` 这种正斜杠写法——不归一的话
        // 默认路径会过不了自己的白名单（实测踩到，单测因为 mkdtemp 本来就
        // 返回规范化路径而没抓到）
        const target = resolve(parsed.workdir || workdir);
        if (!allowedWorkdirs.includes(target)) {
          return badRequest(res, `工作目录不在白名单内：${target}`);
        }

        // 文件名消毒：只留基名，剥掉一切分隔符与 `..`。
        // 用户可控字符串直接拼路径是最经典的穿越面——这里不给它任何机会。
        const safeName = basename(parsed.name).replace(/[\/:*?"<>|]/g, "_").replace(/^\.+/, "");
        if (!safeName) return badRequest(res, "文件名无效");

        let bytes: Buffer;
        try {
          bytes = Buffer.from(parsed.data, "base64");
        } catch {
          return badRequest(res, "data 不是合法的 base64");
        }
        if (bytes.length > UPLOAD_MAX_BYTES) {
          return badRequest(
            res,
            `文件过大：${(bytes.length / 1_000_000).toFixed(1)}MB 超过 ${(UPLOAD_MAX_BYTES / 1_000_000).toFixed(0)}MB 上限`,
          );
        }

        const dir = join(target, UPLOAD_SUBDIR);
        const dest = join(dir, safeName);
        // 双保险：消毒之后再验一次落点确实在目标目录内
        if (!resolve(dest).startsWith(resolve(dir) + sep)) {
          return badRequest(res, "文件名解析后逃出了上传目录");
        }
        try {
          await mkdir(dir, { recursive: true });
          await writeFile(dest, bytes);
        } catch (err) {
          return json(res, 500, { error: `写入失败：${err instanceof Error ? err.message : String(err)}` });
        }

        // 返回**相对工作目录**的路径——那正是 agent 的工具能直接用的形式
        return json(res, 200, {
          path: `${UPLOAD_SUBDIR}/${safeName}`,
          absolutePath: dest,
          bytes: bytes.length,
        });
      }

      case "followUp": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);

        // 边界要说清，不能含糊地失败：
        //  · 运行中不接受追加——两条指令并发进同一个会话会互相踩
        //  · live run 复用原 loop；archived run 只能从检查点派生新 run
        //  · 核查/编排都没有安全的续跑入口，不能绕过裁决或调度重新接主线
        if (run.archived) {
          const blockReason = archivedForkBlockReason(run);
          if (blockReason) return json(res, 409, { error: blockReason });
        } else {
          if (run.status === "running") {
            return json(res, 409, { error: "运行进行中，请等它这一轮结束再追加指令" });
          }
          if (run.mode === "plan") {
            return json(res, 409, {
              error: "计划编排的运行不支持追加指令：runPlanned 每次都从拆解开始，没有续跑入口",
            });
          }
          if (run.verify) {
            return json(res, 409, {
              error: "开启独立核查的运行不支持追加指令：runVerified 无续跑入口，追加会绕过已出具的裁决",
            });
          }
          if (!run.loop || !run.history?.length) {
            return json(res, 409, { error: "该运行没有可续跑的会话正史（可能是执行阶段就失败了）" });
          }
          const budgetBlockReason = run.checkpoint
            ? exhaustedBudgetReason(run.checkpoint.runBudget)
            : null;
          if (budgetBlockReason) return json(res, 409, { error: budgetBlockReason });
        }

        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let parsed: { text?: string };
        try {
          parsed = JSON.parse(body);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }
        if (!parsed.text || typeof parsed.text !== "string" || !parsed.text.trim()) {
          return badRequest(res, 'Missing or invalid "text" field');
        }
        const feedback = parsed.text.trim();
        // 状态门在 readBody 之前查过一次——await 期间另一条并发 followUp 可能
        // 已把 run 置回 running。不复查的话同一 AgentLoop 会被两条 continuation
        // 并发驱动（资源门因同 holder 幂等恰好拦不住），先收尾的一段还会把
        // 在用探针提前释放（评审 de6ddef 双镜头各自独立抓出的 real-bug）
        if (!run.archived && run.status === "running") {
          return json(res, 409, { error: "运行进行中，请等它这一轮结束再追加指令" });
        }
        // 续跑也是新的执行 segment：绕过 createRun 路由不等于绕过隔离准入。
        await refreshExecutionHealth(true);
        if (!executionHealthy) {
          return json(res, 503, {
            error:
              `Required command isolation is unavailable: ${processExecutionStatus.probe.reason ?? "backend probe failed"}`,
            executionIsolation: processExecutionStatus,
          });
        }
        // 追问/归档派生同属新的执行准入：日预算门先于并发门（拒因更具体）
        const budgetRefusal = dailyBudgetRefusal();
        if (budgetRefusal) return rejectAtDailyBudget(res, budgetRefusal);
        const releaseAdmission = acquireRunAdmission();
        if (!releaseAdmission) return rejectAtCapacity(res);

        if (run.archived) {
          try {
            await hydrateArchive(run);
            const history = archivedCheckpointHistory(run);
            const checkpoint = run.checkpoint!;
            if (!history) {
              return json(res, 409, {
                error: `归档检查点损坏：transcript 中找不到 main 段 ${checkpoint.segmentIndex}`,
              });
            }

            const id = randomUUID();
            const rootRunId = run.rootRunId ?? run.id;
            // 派生子 run 是新的执行：独占资源与 workdir 冲突同样过门
            const childPack = run.packName ? getPack(run.packName) : pack;
            const childResources = childPack?.resources ?? [];
            if (acquireRunResources(res, id, childResources) === "refused") return;
            if (refuseOrWarnSharedWorkdir(res, id, run.workdir ?? workdir, run.id)) {
              hostResources.release(childResources, id);
              return;
            }
            const child: StoredRun = {
              id,
              // 子 run 仍是同一项任务；新增指令由 user_message 事件精确记录。
              task: run.task,
              status: "running",
              verify: false,
              createdAt: Date.now(),
              events: [],
              pendingApprovals: new Map(),
              respondedApprovals: new Map(),
              respondedToolUseIds: new Set(),
              sseClients: new Set(),
              segmentIndex: 0,
              transcript: [],
              conversationTurn: checkpoint.conversationTurn + 1,
              toolTally: {},
              abort: new AbortController(),
              history,
              continuedFrom: run.id,
              rootRunId,
              resumeBudget: restoredBudget(checkpoint, { maxTotalTurns, maxTokensBudget }),
              initialContextInputTokens: checkpoint.contextInputTokens,
              // 继承任务选择，不继承任何活权限状态；模型/工具由 buildConfig 取当前宿主。
              ...(run.packName ? { packName: run.packName } : {}),
              ...(run.effort ? { effort: run.effort } : {}),
              ...(run.rubric ? { rubric: run.rubric } : {}),
              ...(run.workdir ? { workdir: resolve(run.workdir) } : { workdir }),
              ...(run.askUser ? { askUser: true } : {}),
              ...(childResources.length ? { heldResources: childResources } : {}),
            };
            if (historyRoot) {
              child.archiveWriter = createArchiveWriter(id);
              persistMeta(child);
              seedDurableState(child);
            } else {
              seedDurableState(child);
            }
            runs.set(id, child);
            metrics.runsStarted += 1;
            if (realHost) {
              operationalLog("info", "run_started", {
                runId: id,
                mode: "single",
                verify: false,
                continuation: "fork",
              });
            }
            broadcastLifecycle("run_created", child);
            void withFallbackAttribution(child, () =>
              startForkedContinuation(child, feedback, run.archivedApprovalGrantAudit ?? []),
            );
            return json(res, 200, {
              runId: id,
              conversationTurn: child.conversationTurn,
              continuedFrom: run.id,
              rootRunId,
              continuationMode: "fork",
              run: runSummary(child),
            });
          } finally {
            releaseAdmission();
          }
        }

        // 追问续跑重启执行：finalize 时已释放的资源要重新占——否则另一个持有
        // 同资源的 run 与本次续跑会同时上探针
        const resumePack = run.packName ? getPack(run.packName) : pack;
        const resumeResources = run.mode === "plan" ? [] : (resumePack?.resources ?? []);
        if (acquireRunResources(res, run.id, resumeResources) === "refused") {
          releaseAdmission();
          return;
        }
        if (refuseOrWarnSharedWorkdir(res, run.id, run.workdir ?? workdir, run.id)) {
          hostResources.release(resumeResources, run.id);
          releaseAdmission();
          return;
        }
        if (resumeResources.length) run.heldResources = resumeResources;
        // startContinuation 在第一个 await 之前就把轮数加过了，这里不能再 +1
        void withFallbackAttribution(run, () => startContinuation(run, feedback));
        releaseAdmission();
        return json(res, 200, {
          runId: run.id,
          conversationTurn: run.conversationTurn,
          continuationMode: "same",
          run: runSummary(run),
        });
      }

      case "transcript": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);
        await hydrateArchive(run); // 归档 run 的正文在磁盘上，首次访问才读
        // 按需拉：会话正文可达数 MB，不能进 SSE 缓冲（那会让每个晚订阅的
        // 客户端都重放一遍）。这里只在用户真的切到对话视图时才付这笔代价。
        return json(res, 200, {
          runId: run.id,
          task: run.task,
          segments: run.transcript,
        });
      }

      case "trace": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);
        await hydrateArchive(run);
        const dir = run.archiveDir ?? (historyRoot ? join(historyRoot, run.id) : null);
        let spans: TraceSpan[] = [];
        if (dir) {
          // flush in-flight writer so just-finished runs expose their last spans
          if (run.archiveWriter) await run.archiveWriter.flush();
          const rows = await readArchivedTrace(dir);
          spans = rows.filter(
            (r): r is TraceSpan =>
              !!r &&
              typeof r === "object" &&
              (r as TraceSpan).version === 1 &&
              typeof (r as TraceSpan).spanId === "string",
          ) as TraceSpan[];
        }
        const exported = exportRedactedTrace(spans);
        return json(res, 200, {
          runId: run.id,
          ...exported,
          playback: playbackSummary(spans),
        });
      }

      /**
       * 把模型正文里的“疑似路径”升级成链接之前，先做一次只读确认。
       *
       * 前端只负责语法初筛；这里按**该 run 自己的 workdir**解析并 stat，且只回
       * 相对路径与 file/directory 两值。不存在、越界或特殊文件都返回 exists=false，
       * 页面便继续把它画成普通行内代码，不制造一个点开必坏的假链接。
       */
      case "inspectPaths": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);
        let parsed: { paths?: unknown };
        try {
          parsed = JSON.parse(await readBody(req, requestBodyMaxBytes));
        } catch (error) {
          if (error instanceof RequestBodyTooLargeError) return requestBodyFailure(res, error);
          return badRequest(res, "Body must be JSON with a paths array");
        }
        if (!Array.isArray(parsed.paths)) return badRequest(res, "paths must be an array");
        if (parsed.paths.length > 64) return badRequest(res, "paths accepts at most 64 items");

        const root = run.workdir ?? workdir;
        const inputs = [...new Set(parsed.paths.map((p) => String(p ?? "").trim()))];
        const inspected = await Promise.all(
          inputs.map(async (input) => {
            if (!input || input.length > 1024) return { input, exists: false as const };
            let abs: string;
            try {
              abs = resolveInWorkdir(root, localPathTarget(input));
            } catch {
              return { input, exists: false as const };
            }
            try {
              const st = await stat(abs);
              const kind = st.isFile() ? "file" : st.isDirectory() ? "directory" : null;
              if (!kind) return { input, exists: false as const };
              const rel = relative(resolve(root), abs).split(sep).join("/") || ".";
              return { input, exists: true as const, path: rel, kind };
            } catch {
              return { input, exists: false as const };
            }
          }),
        );
        return json(res, 200, { paths: inspected });
      }

      /**
       * 取一件产物：预览或下载。
       *
       * 三道闸，缺一不可：
       *   ① run 必须存在，且路径按**这次运行自己的 workdir** 解析——
       *      不同运行可以在不同工作目录，拿 A 的 id 取不到 B 的文件；
       *   ② `resolveInWorkdir` 拒绝 `..` 逃逸与工作区外的绝对路径
       *      （与写类工具共用同一个圈禁函数，判据只有一处）；
       *   ③ 只回文件，目录一律 404——否则等于开了目录浏览。
       */
      case "artifact": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);
        const root = run.workdir ?? workdir;
        let abs: string;
        try {
          abs = resolveInWorkdir(root, route.path);
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
        try {
          const st = await stat(abs);
          if (!st.isFile()) return notFound(res, "Not a file");
          const body = await readFile(abs);
          const name = basename(abs);
          res.writeHead(200, {
            "Content-Type": contentTypeOf(name),
            "Content-Length": String(body.length),
            // 预览走 inline，下载走 attachment；文件名按 RFC 5987 编码，
            // 中文名不编码会在 header 里变成乱码或被截断
            "Content-Disposition": `${route.download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
            // 产物是本地文件，不该被任何中间层缓存住旧版本
            "Cache-Control": "no-store",
            // 预览的是模型生成的 HTML——**不可信内容**。禁掉脚本与外链，
            // 否则等于让它在宿主同源下执行任意 JS（能读同源的 /api/*）
            "Content-Security-Policy":
              "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src data:",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(body);
          return;
        } catch {
          return notFound(res, `Artifact not found: ${route.path}`);
        }
      }

      /**
       * 在系统文件管理器里选中这个文件。
       *
       * 这条是**从网页请求启动本机进程**，所以圈禁必须比取件更严：同一套
       * `resolveInWorkdir` + 必须真实存在 + **参数数组传给 spawn，绝不拼 shell 串**
       * （拼串就等于把文件名交给命令行解析器）。服务只绑 127.0.0.1，
       * 但这不构成放松的理由——绑定是部署事实，圈禁是代码事实。
       */
      case "reveal": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);
        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let wanted: string;
        try {
          wanted = String(JSON.parse(body).path ?? "");
        } catch {
          return json(res, 400, { error: "Body must be JSON with a path field" });
        }
        if (!wanted) return json(res, 400, { error: "path is required" });
        const root = run.workdir ?? workdir;
        let abs: string;
        try {
          abs = resolveInWorkdir(root, wanted);
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
        let targetKind: "file" | "directory" = "file";
        try {
          const st = await stat(abs);
          targetKind = st.isDirectory() ? "directory" : "file";
        } catch {
          return notFound(res, `Artifact not found: ${wanted}`);
        }
        const cmd = revealCommand(abs, targetKind);
        if (!cmd) return json(res, 501, { error: `Unsupported platform: ${process.platform}` });
        try {
          spawn(cmd.file, cmd.args, { detached: true, stdio: "ignore" }).unref();
        } catch (err) {
          return json(res, 500, { error: `Failed to reveal: ${(err as Error).message}` });
        }
        return json(res, 200, { revealed: abs });
      }

      /**
       * 停止这次运行。
       *
       * **幂等**：已经结束的 run 返回 409 而不是假装停了——"我按了但它还在跑"
       * 与"我按了它早就停了"是两件事，混成一个 200 会让人不知道自己那一下有没有用。
       * 已挂起的审批与计划门由 finalizeRun 统一宣告过期，不在这里重复处理。
       */
      case "stop": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);
        if (run.status === "done") {
          return json(res, 409, { error: "Run already finished" });
        }
        if (!run.abort) {
          return json(res, 409, { error: "This run does not support stopping" });
        }
        run.abort.abort();
        // 挂起的审批/计划门要立刻解除，否则协程仍吊在 await 上，abort 传不进去
        for (const pending of run.pendingApprovals.values()) {
          try { pending.respond("deny", "委托方已停止这次运行"); } catch { /* 已应答过 */ }
        }
        run.pendingApprovals.clear();
        if (run.pendingPlan) {
          try { run.pendingPlan.settle("reject"); } catch { /* 已决 */ }
        }
        // §5.2 提问同理。settle(null) 而不是抛——停止是委托方的决定，
        // 工具那边会回"按你的最佳判断继续"，不是把它当故障（决定 4）
        try { expireQuestion(run, "stopped"); } catch { /* 已应答 */ }
        broadcastLifecycle("run_updated", run);
        return json(res, 200, { stopping: true });
      }

      case "lifecycleStream": {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        // 先发一份当前快照，订阅者不必再额外拉一次 /api/runs
        res.write(
          `data: ${JSON.stringify({
            type: "snapshot",
            runs: [...runs.values()].sort((a, b) => b.createdAt - a.createdAt).map(runSummary),
          })}\n\n`,
        );
        lifecycleClients.add(res);
        keepSseAlive(req, res, () => lifecycleClients.delete(res));
        return;
      }

      case "createRun": {
        // 先在 admission 重新探测，daemon/image/profile 启动后失效时模型调用必须为 0。
        await refreshExecutionHealth(true);
        if (!executionHealthy) {
          return json(res, 503, {
            error:
              `Required command isolation is unavailable: ${processExecutionStatus.probe.reason ?? "backend probe failed"}`,
            executionIsolation: processExecutionStatus,
          });
        }
        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let parsed: {
          task?: string; verify?: boolean; pack?: string; effort?: string; rubric?: string;
          mode?: string; concurrency?: number | string;
          workdir?: string; useVerifierModel?: boolean; usePlannerModel?: boolean;
          planGate?: boolean; askUser?: boolean;
        };
        try {
          parsed = JSON.parse(body);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }
        if (!parsed.task || typeof parsed.task !== "string") {
          return badRequest(res, 'Missing or invalid "task" field');
        }
        // V-24：外部输入一律当场校验拒绝，不静默降级——静默降级会让"我明明选了
        // python-coding"与实际行为长期不一致，查起来很贵（口径同 src/cli.ts 对
        // AGENT_EFFORT 的处理）
        if (parsed.pack !== undefined && parsed.pack !== "" && !getPack(parsed.pack)) {
          return badRequest(res, `未知领域包 "${parsed.pack}"。可选：${Object.keys(PACKS).join(" | ")}`);
        }
        if (
          parsed.effort !== undefined && parsed.effort !== "" &&
          !(EFFORT_LEVELS as readonly string[]).includes(parsed.effort)
        ) {
          return badRequest(res, `effort "${parsed.effort}" 无效。可选：${EFFORT_LEVELS.join(" | ")}`);
        }

        if (parsed.mode !== undefined && parsed.mode !== "single" && parsed.mode !== "plan") {
          return badRequest(res, `mode "${parsed.mode}" 无效。可选：single | plan`);
        }
        // 计划门只在编排模式下有意义（单跑没有计划这一步）。不静默忽略——
        // 静默会让"我明明勾了确认门"与实际行为长期不一致（口径同 V-24）
        if (parsed.planGate === true && parsed.mode !== "plan") {
          return badRequest(res, "planGate 仅在 mode=plan 下有意义：单跑模式没有计划这一步");
        }
        let concurrency: number | "auto" | undefined;
        if (parsed.concurrency !== undefined && parsed.concurrency !== "") {
          if (parsed.concurrency === "auto") concurrency = "auto";
          else {
            const n = Number(parsed.concurrency);
            if (!Number.isInteger(n) || n < 1 || n > 8) {
              return badRequest(res, `concurrency "${parsed.concurrency}" 无效。可选：auto 或 1..8`);
            }
            concurrency = n;
          }
        }

        // V-29：工作目录必须命中白名单。规范化后逐条比对绝对路径——
        // 只做字符串前缀判断会被 `..` 穿出去，而这是工具的写入边界
        let runWorkdir: string | undefined;
        if (parsed.workdir !== undefined && parsed.workdir !== "") {
          const asked = resolve(parsed.workdir);
          if (!allowedWorkdirs.includes(asked)) {
            return badRequest(
              res,
              `工作目录不在白名单内。可选：${allowedWorkdirs.join(" | ")}（用 AGENT_UI_WORKDIRS 声明）`,
            );
          }
          runWorkdir = asked;
        }

        const verify = parsed.verify === true;
        // §5.2 决定 1：默认关，逐 run 显式开
        const askUser = parsed.askUser === true;
        const budgetRefusal = dailyBudgetRefusal();
        if (budgetRefusal) return rejectAtDailyBudget(res, budgetRefusal);
        const id = randomUUID();
        // 跨 run 独占资源：single/verified 按包声明在准入时整体占用；
        // plan 模式由调度器经同一张宿主表按子任务粒度管理，此处不占
        const admissionPack = parsed.pack ? getPack(parsed.pack) : pack;
        const packResources = parsed.mode === "plan" ? [] : (admissionPack?.resources ?? []);
        if (acquireRunResources(res, id, packResources) === "refused") return;
        if (refuseOrWarnSharedWorkdir(res, id, runWorkdir ?? workdir)) {
          hostResources.release(packResources, id);
          return;
        }
        const releaseAdmission = acquireRunAdmission();
        if (!releaseAdmission) {
          hostResources.release(packResources, id);
          return rejectAtCapacity(res);
        }
        const run: StoredRun = {
          id,
          task: parsed.task,
          status: "running",
          verify,
          createdAt: Date.now(),
          events: [],
          pendingApprovals: new Map(),
          respondedApprovals: new Map(),
          respondedToolUseIds: new Set(),
          sseClients: new Set(),
          segmentIndex: 0,
          transcript: [],
          conversationTurn: 1,
          toolTally: {},
          abort: new AbortController(),
          ...(parsed.pack ? { packName: parsed.pack } : {}),
          ...(parsed.effort ? { effort: parsed.effort as Effort } : {}),
          ...(parsed.rubric ? { rubric: parsed.rubric } : {}),
          ...(parsed.mode === "plan" ? { mode: "plan" as const } : {}),
          ...(concurrency !== undefined ? { concurrency } : {}),
          ...(runWorkdir ? { workdir: runWorkdir } : {}),
          ...(parsed.useVerifierModel === false ? { useVerifierModel: false } : {}),
          ...(parsed.usePlannerModel === false ? { usePlannerModel: false } : {}),
          ...(parsed.planGate === true ? { planGate: true } : {}),
          ...(askUser ? { askUser: true } : {}),
          ...(packResources.length ? { heldResources: packResources } : {}),
        };
        // B2：建档要在第一条事件之前——writer 的写入链从 mkdir 开始保序
        if (historyRoot) {
          run.archiveWriter = createArchiveWriter(id);
          persistMeta(run);
          seedDurableState(run);
          // OBS-01：run 根 span + 版本指纹（commit/model/pack/tool schema）
          try {
            const toolsForHash = [
              { name: bashTool.name, inputSchema: bashTool.inputSchema },
              { name: readFileTool.name, inputSchema: readFileTool.inputSchema },
              { name: writeFileTool.name, inputSchema: writeFileTool.inputSchema },
            ];
            const root = startSpan({
              kind: "run",
              name: "run",
              runId: id,
              ts: run.createdAt,
              attrs: {
                harnessVersion: HARNESS_VERSION,
                gitCommit: resolveGitCommit(),
                packName: run.packName ?? pack?.name ?? null,
                model: process.env.AGENT_MODEL ?? null,
                toolSchemaHash: hashToolSchemas(toolsForHash),
                mode: run.mode ?? "single",
                verify,
              },
            });
            run.traceRunSpanId = root.spanId;
            run.openToolSpans = new Map();
            run.archiveWriter?.appendTraceSpan(root);
          } catch {
            // ignore
          }
        } else {
          seedDurableState(run);
        }
        runs.set(id, run);
        releaseAdmission();
        metrics.runsStarted += 1;
        if (realHost) {
          operationalLog("info", "run_started", {
            runId: id,
            mode: run.mode ?? "single",
            verify,
            continuation: null,
          });
        }
        broadcastLifecycle("run_created", run);

        if (run.mode === "plan") {
          void withFallbackAttribution(run, () => startPlannedRun(run));
        } else if (verify) {
          void withFallbackAttribution(run, () => startVerifiedRun(run));
        } else {
          void withFallbackAttribution(run, () => startPlainRun(run));
        }

        return json(res, 200, { runId: id });
      }

      case "events": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);
        await hydrateArchive(run); // 归档 run 的事件流在磁盘上，重放前先装回缓冲
        return serveSSE(req, res, run);
      }

      case "planApproval": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);

        // 幂等与状态门，口径同工具审批（R-01）：已决 / 已收尾一律 409，
        // 不是静默成功——签字位上"我到底批没批"必须有确定答案
        if (run.planDecision) {
          return json(res, 409, { error: "Plan already decided" });
        }
        if (run.status === "done" || !run.pendingPlan) {
          return json(res, 409, { error: "No plan awaiting approval for this run" });
        }

        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let parsed: { decision?: string };
        try {
          parsed = JSON.parse(body);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }
        if (parsed.decision !== "approve" && parsed.decision !== "reject") {
          return badRequest(res, 'decision must be "approve" or "reject"');
        }

        // 日预算门（评审：签字位是零副作用停点——批准即并行发射全部子任务，
        // 却曾是唯一不过预算门的执行入口）。只拦 approve：拒绝不花钱，永远可拒。
        // 429 时计划保持挂起——预算说的是"今天不行"，不是"这个计划不行"。
        if (parsed.decision === "approve") {
          const budgetRefusal = dailyBudgetRefusal();
          if (budgetRefusal) return rejectAtDailyBudget(res, budgetRefusal);
        }

        const pendingPlan = run.pendingPlan;
        const at = Date.now();
        run.planDecision = { decision: parsed.decision, at };
        // 决策进事件流：刷新/重连后仍能看到谁在什么时候签的（V-02 的口径）
        pushSyntheticEvent(run, "host", {
          type: "plan_approval_resolved",
          requestSeq: pendingPlan.requestSeq,
          decision: parsed.decision,
          actor: "user",
          at,
        });
        applyDurableTransition(
          run,
          parsed.decision === "approve"
            ? { type: "plan_approved", at }
            : { type: "plan_rejected", at },
          at,
        );
        pendingPlan.settle(parsed.decision);
        broadcastLifecycle("run_updated", run);
        return json(res, 200, { acknowledged: true });
      }

      /**
       * §5.2 澄清答复。状态门口径同计划门（R-01）：没有挂起的问题就 409，
       * 不是静默成功——"我到底答没答"必须有确定答案。
       */
      case "answer": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);
        if (run.status === "done" || !run.pendingQuestion) {
          return json(res, 409, { error: "No question awaiting an answer for this run" });
        }

        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let parsed: { answers?: unknown; skip?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }

        const pendingQuestion = run.pendingQuestion;
        const count = pendingQuestion.questions.length;
        /**
         * skip = 委托方明确表示"你自己定"（整轮）。与超时同归 null，但**来源不同**，
         * 事件里照实记——把主动跳过写成"未应答"就是对委托方说谎（V-04）。
         */
        const skipped = parsed.skip === true;
        let answers: (string | null)[] | null = null;
        if (!skipped) {
          if (!Array.isArray(parsed.answers) || parsed.answers.length !== count) {
            return badRequest(
              res,
              `answers must be an array of ${count} items (null for unanswered), or pass {"skip": true}`,
            );
          }
          answers = parsed.answers.map((a) =>
            typeof a === "string" && a.trim() !== "" ? a.trim() : null,
          );
          // 一题都没答 = 等同整轮跳过，但不静默转换：让委托方显式点「让它自己定」
          if (!answers.some((a) => a !== null)) {
            return badRequest(res, 'at least one answer required, or pass {"skip": true}');
          }
        }

        pushSyntheticEvent(run, "host", {
          type: "user_question_resolved",
          requestSeq: pendingQuestion.requestSeq,
          id: pendingQuestion.id,
          answers,
          skipped,
          actor: "user",
          at: Date.now(),
        });
        pendingQuestion.settle(answers);
        broadcastLifecycle("run_updated", run);
        return json(res, 200, { acknowledged: true });
      }

      case "approval": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);

        // approvalRef 二义解析：带 `#seq` 走精确匹配（前端一律用这种）；
        // 不带则取该 toolUseId 下最新的挂起项——保持对裸 toolUseId 调用方的兼容
        const { key, pending } = resolveApprovalRef(run, route.toolUseId);

        if (!pending) {
          // 不在 pending 中：检查是否已应答或 run 已结束（R-01 幂等 + 状态不允许）
          const bareId = route.toolUseId.split("#")[0]!;
          if (run.respondedApprovals.has(route.toolUseId) || run.respondedToolUseIds.has(bareId)) {
            return json(res, 409, { error: "Approval already decided" });
          }
          if (run.status === "done") {
            return json(res, 409, { error: "Run already finished; approvals are no longer accepted" });
          }
          return notFound(res, `Approval not found: ${route.toolUseId}`);
        }

        // R-01: 运行结束后任何审批 POST 返回 409
        if (run.status === "done") {
          return json(res, 409, { error: "Run already finished; approvals are no longer accepted" });
        }

        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let parsed: { decision?: string; reason?: string; scope?: string };
        try {
          parsed = JSON.parse(body);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }
        if (parsed.decision !== "allow" && parsed.decision !== "deny") {
          return badRequest(res, 'decision must be "allow" or "deny"');
        }
        if (parsed.scope !== undefined && parsed.scope !== "conversation") {
          return badRequest(res, 'scope must be omitted or "conversation"');
        }
        // resolveApprovalRef 发生在 await readBody 之前。两个并发 POST 都可能先拿到
        // 同一 pending 引用；在任何授权/应答副作用前原子复查，只有先恢复执行的
        // 那一个能赢，另一个稳定返回 409。
        if (!key || run.pendingApprovals.get(key) !== pending) {
          return json(res, 409, { error: "Approval already decided" });
        }

        /**
         * API 保留 `scope: "conversation"` 兼容名称；内部授权事实明确绑定当前
         * runId。archive continuation 是新 run，绝不继承。工具策略是最高权限，
         * 客户端 body 不能把 once 扩大成 exact-input。
         */
        const createsExactRule = parsed.decision === "allow" && parsed.scope === "conversation";
        if (createsExactRule && pending.grantPolicy.maxScope !== "exact-input") {
          return json(res, 409, {
            error: `Tool policy for "${pending.name}" permits one-time approval only`,
            maxScope: "once",
          });
        }
        if (createsExactRule && !pending.toolFingerprint) {
          return json(res, 409, {
            error: `Cannot create reusable approval for unknown tool definition: ${pending.name}`,
          });
        }
        const exactKey = exactInputApprovalKey(pending.name, pending.inputHash);
        const at = approvalClock();
        if (createsExactRule) sweepInvalidApprovalGrants(run, at);
        const existingGrant = createsExactRule ? run.autoAllow?.get(exactKey) : undefined;
        if (
          createsExactRule &&
          !existingGrant &&
          (run.autoAllow?.size ?? 0) >= MAX_APPROVAL_GRANTS_PER_RUN
        ) {
          return json(res, 409, { error: "Active approval grant limit reached" });
        }

        let resolvedGrant: ExactInputApprovalRule | undefined;
        let grantAction: "created" | "reused" | undefined;
        if (createsExactRule) {
          if (existingGrant) {
            resolvedGrant = existingGrant;
            grantAction = "reused";
          } else {
            resolvedGrant = {
              version: 1,
              canonicalizationVersion: APPROVAL_CANONICALIZATION_VERSION,
              policyVersion: APPROVAL_GRANT_POLICY_VERSION,
              grantId: randomUUID(),
              approvalId: approvalId(pending.toolUseId, pending.requestSeq),
              boundRunId: run.id,
              scope: "run",
              name: pending.name,
              inputScope: "exact-input",
              inputHash: pending.inputHash,
              toolFingerprint: pending.toolFingerprint!,
              issuedAt: at,
              expiresAt: at + pending.grantPolicy.maxTtlMs,
              maxUses: pending.grantPolicy.maxUses,
              usedUses: 0,
            };
            grantAction = "created";
            (run.autoAllow ??= new Map()).set(exactKey, resolvedGrant);
          }
        }
        pending.respond(parsed.decision, parsed.reason);
        run.respondedApprovals.set(key!, {
          decision: parsed.decision,
          ...(parsed.reason ? { reason: parsed.reason } : {}),
          at,
        });
        run.respondedToolUseIds.add(pending.toolUseId);
        run.pendingApprovals.delete(key!);
        broadcastLifecycle("run_updated", run);

        // V-02：决策进事件流。此前只写在浏览器内存里，刷新后已允许的审批
        // 会显示成"已过期"——审计记录必须由服务端持有，任意客户端重放一致
        pushSyntheticEvent(run, "host", {
          type: "approval_resolved",
          requestSeq: pending.requestSeq,
          toolUseId: pending.toolUseId,
          name: pending.name,
          decision: parsed.decision,
          ...(parsed.reason ? { reason: parsed.reason } : {}),
          actor: "user",
          ...(resolvedGrant
            ? {
                scope: resolvedGrant.scope,
                inputScope: resolvedGrant.inputScope,
                inputHash: resolvedGrant.inputHash,
                grantId: resolvedGrant.grantId,
                boundRunId: resolvedGrant.boundRunId,
                canonicalizationVersion: resolvedGrant.canonicalizationVersion,
                policyVersion: resolvedGrant.policyVersion,
                toolFingerprint: resolvedGrant.toolFingerprint,
                issuedAt: resolvedGrant.issuedAt,
                expiresAt: resolvedGrant.expiresAt,
                maxUses: resolvedGrant.maxUses,
                usedUses: resolvedGrant.usedUses,
                remainingUses: resolvedGrant.maxUses - resolvedGrant.usedUses,
                grantAction,
              }
            : {}),
          at,
        });
        applyDurableTransition(run, {
          type: "approval_resolved",
          approvalId: key!,
        }, at);

        const exactRules = run.autoAllow ? [...run.autoAllow.values()] : [];
        return json(res, 200, {
          acknowledged: true,
          // 旧客户端仍可读工具名数组；新客户端用 autoAllowExact 看真实匹配边界。
          ...(exactRules.length
            ? {
                autoAllow: [...new Set(exactRules.map((rule) => rule.name))],
                autoAllowExact: exactRules.map((rule) => ({
                  ...rule,
                })),
              }
            : {}),
        });
      }

      case "static": {
        const filePath = VENDOR_STATIC.get(route.filePath) ?? join(PUBLIC_DIR, route.filePath);
        if (!existsSync(filePath)) {
          return notFound(res, `File not found: ${route.filePath}`);
        }
        try {
          const content = await readFile(filePath);
          const ext = extname(filePath).toLowerCase();
          const contentType = MIME[ext] ?? "application/octet-stream";
          res.writeHead(200, { "Content-Type": contentType });
          res.end(content);
        } catch {
          return notFound(res, `Failed to read: ${route.filePath}`);
        }
        return;
      }
    }
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      operationalLog("error", "http_handler_failed", {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        error: message,
      });
      if (!res.headersSent) json(res, 500, { error: "Internal server error" });
      else res.destroy(error instanceof Error ? error : undefined);
    });
  });
  let closePromise: Promise<void> | null = null;

  return {
    server,
    close(): Promise<void> {
      if (closePromise) return closePromise;
      shuttingDown = true;
      closePromise = (async () => {
        if (realHost) operationalLog("info", "host_shutdown_started", { activeRuns: activeRunCount() });
        // 走正规的 finalizeRun 而不是直接掀桌：宿主关停时仍挂起的审批要被
        // 显式宣告过期、run_end 要落进事件流。否则在线客户端只会看到连接莫名断掉，
        // 而它按设计是会自动重连的——语义上就成了"运行还在，只是连不上"。
        for (const run of runs.values()) {
          run.abort?.abort();
          finalizeRun(run, { outcome: "closed" });
        }
        // 全局生命周期 SSE 不是某个 run 的客户端，finalizeRun 不会替它收尾。
        // 必须主动 end；否则 server.close 会永远等待这条 keep-alive 连接。
        for (const client of lifecycleClients) {
          try { client.end(); } catch { /* 连接已由对端关闭 */ }
        }
        lifecycleClients.clear();
        // B2：等档案写入链走完再关——收尾刚排进队列的 approval_expired /
        // run_end / meta 不能丢在半路，否则重启后的档案缺最关键的那几行
        const flushes = [...runs.values()]
          .map((r) => r.archiveWriter?.flush())
          .filter((p): p is Promise<unknown> => Boolean(p));
        const executionBrokers = new Set<ExecutionBroker>([
          ...[...runs.values()].flatMap((r) => r.executionBroker ? [r.executionBroker] : []),
          ...(processProbeBroker ? [processProbeBroker] : []),
          ...detachedExecutionBrokers,
        ]);
        const executionCleanup = [...executionBrokers]
          .map((broker) => broker.dispose?.()?.then(() => {
            detachedExecutionBrokers.delete(broker);
          }))
          .filter((p): p is Promise<void> => Boolean(p));
        // MCP 子进程必须显式断开：留着就是常驻的僵尸 server，stm32 那种还攥着
        // 探针（案例 #3 的事故原型）。给落盘与断开一个有界窗口，超时后仍释放 HTTP。
        const cleanup = Promise.allSettled([
          ...flushes,
          ...detachedArchiveFlushes,
          ...detachedExecutionTasks,
          ...executionCleanup,
          ...(mcpRuntime ? [mcpRuntime.close()] : []),
        ]);
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        const cleanupOutcome = await Promise.race([
          cleanup.then((results) => ({ kind: "settled" as const, results })),
          new Promise<{ kind: "timeout" }>((resolveTimeout) => {
            cleanupTimer = setTimeout(() => resolveTimeout({ kind: "timeout" }), shutdownTimeoutMs);
          }),
        ]);
        if (cleanupTimer) clearTimeout(cleanupTimer);
        let cleanupFailure: Error | undefined;
        if (cleanupOutcome.kind === "timeout") {
          cleanupFailure = new Error(`Host shutdown cleanup exceeded ${shutdownTimeoutMs}ms`);
        } else {
          const rejected = cleanupOutcome.results.filter(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          if (rejected.length > 0) {
            cleanupFailure = new Error(
              `Host shutdown cleanup failed (${rejected.length}): ${rejected
                .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason))
                .join("; ")}`,
            );
          }
        }
        runs.clear();
        mutationWindows.clear();

        if (server.listening) {
          await new Promise<void>((resolveClose, rejectClose) => {
            const forceTimer = setTimeout(() => {
              server.closeAllConnections();
            }, shutdownTimeoutMs);
            server.close((error) => {
              clearTimeout(forceTimer);
              if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
                rejectClose(error);
              } else {
                resolveClose();
              }
            });
          });
        }
        if (cleanupFailure) {
          if (realHost) operationalLog("error", "host_shutdown_cleanup_failed", {
            error: cleanupFailure.message,
          });
          throw cleanupFailure;
        }
        if (realHost) operationalLog("info", "host_shutdown_completed");
      })();
      return closePromise;
    },
  };
}

/**
 * HTTP + SSE 后端事件桥：把 AgentLoop / runVerified 的 TurnEvent 流暴露给浏览器，
 * 并支持任务提交与审批应答。Node 内置模块，零第三方依赖。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, extname, dirname, delimiter, resolve, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { AgentLoop } from "../src/loop.js";
import {
  runVerified,
  runPlanned,
  plannedStopReason,
  planParallelWidth,
  AUTO_CONCURRENCY_CAP,
  type VerifiedRunResult,
} from "../src/orchestrate.js";
import { createModelClientFromEnv, type ResolvedProvider } from "../src/provider.js";
import { getPack, selectPackTools, PACKS, type DomainPack } from "../src/presets.js";
import { connectMcpServers, loadMcpConfig, type McpRuntime } from "../src/mcp.js";
import { DEFAULT_VERIFIER_MAX_TURNS } from "../src/verifier.js";
import { resolvePlannerMaxTurns } from "../src/planner.js";
import type { Plan, SubTask } from "../src/planner.js";
import type Anthropic from "@anthropic-ai/sdk";
import { bashTool, SHELL_DESC } from "../src/tools/bash.js";
import { createDescribeImageTool } from "../src/tools/describe-image.js";
import { fetchUrlTool } from "../src/tools/fetch-url.js";
import { readFileTool } from "../src/tools/read-file.js";
import { writeFileTool } from "../src/tools/write-file.js";
import { resolveInWorkdir } from "../src/tools/fs-util.js";
import { appendRunLedger, buildLedgerEntry, ledgerPath, tallyToolCall, type ToolTally } from "../src/ledger.js";
import { EFFORT_LEVELS } from "../src/types.js";
import type { ModelClient, TurnEvent, AgentConfig, Tool, Effort } from "../src/types.js";
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

/** run 级终止信息，由 startPlainRun/startVerifiedRun 算出后交给 finalizeRun */
interface RunEndInfo {
  /**
   * closed = 宿主关停导致的终止（run 本身没跑完），与 run 自己跑完区分开；
   * rejected = 计划确认门被否决——**不是 error**：那是委托方的决定，不是失败。
   * 混进 error 会让界面说谎（V-04 的教训：stopReason 不能压值域）。
   */
  outcome: "completed" | "error" | "closed" | "rejected";
  mainStopReason?: string;
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
  /**
   * 中止闸。**逐 run 一个**——停止的是这一次运行，不是整个宿主。
   * 人按下停止即 abort()，编排层把它传给 AgentLoop，循环在下一次模型调用
   * 之前收手。已经在飞的那个请求不撤（HTTP 已经发出去了，钱已经花了），
   * 所以"停止"的准确语义是**不再往下走**，不是"当场消失"。
   */
  abort?: AbortController;
  /**
   * 本次对话内**常驻放行**的工具名（委托方："每次都要人手点击很麻烦"）。
   *
   * 三条边界，缺一条这个功能就从"省事"变成"把审批门拆了"：
   *   ① **逐 run**，不跨 run、不落盘——下一次对话从零开始问；
   *   ② **逐工具名**，不是"全部放行"——你放行的是 read_file，不等于放行 bash；
   *   ③ 自动放行**照样进事件流**（actor: "auto-rule"），审计记录里看得出
   *      这一次没有人真的点过。第 ③ 条最重要：省掉的是点击，不是记录。
   */
  autoAllow?: Set<string>;
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
}

interface PendingPlan {
  requestSeq: number;
  at: number;
  /** 由 waitForPlanDecision 装填：应答或过期时结束等待 */
  settle: (decision: "approve" | "reject" | "expired") => void;
}

/** 计划被否决的哨兵——不是错误，是决定，所以要与 error 路径区分开 */
class PlanRejectedError extends Error {
  constructor(readonly cause_: "rejected" | "expired") {
    super(cause_ === "rejected" ? "计划被委托方否决" : "计划确认门未应答即结束");
    this.name = "PlanRejectedError";
  }
}

/** 审批唯一键：同一 toolUseId 在返工轮再次出现时，靠 requestSeq 区分 */
function approvalId(toolUseId: string, requestSeq: number): string {
  return `${toolUseId}#${requestSeq}`;
}

/**
 * verifier 来源判定。写成前缀/后缀两用是为并行编排预留——那里的来源形如
 * "s1/verifier"，若只比对字面量 "verifier"，子任务的 verifier 审批会被
 * 错误地挂进待办表，而它内部已自答 → 双响。
 */
function isVerifierSource(source: string): boolean {
  return source === "verifier" || source.endsWith("/verifier");
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

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
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
export function revealCommand(abs: string): { file: string; args: string[] } | null {
  if (process.platform === "win32") return { file: "explorer.exe", args: [`/select,${abs}`] };
  if (process.platform === "darwin") return { file: "open", args: ["-R", abs] };
  if (process.platform === "linux") return { file: "xdg-open", args: [dirname(abs)] };
  return null;
}

const BUILTIN_POOL: Tool[] = [bashTool, fetchUrlTool, readFileTool, writeFileTool];

/** 上传落点：工作目录下的固定子目录，便于人和 agent 都一眼知道东西在哪 */
const UPLOAD_SUBDIR = "uploads";
const UPLOAD_MAX_BYTES = 20_000_000;
const DEFAULT_SYSTEM_PROMPT = `You are a capable autonomous agent operating in a local working directory.
Complete the user's task end to end using the available tools.
Ground every claim of progress in an actual tool result.`;

// ------------------------------------------------------
// Server factory
// ------------------------------------------------------

export function createUiServer(options: UiServerOptions = {}): UiServerHandle {
  // F1: 缺省模型从环境变量读取，compat 取自 createModelClientFromEnv 返回值
  const resolved = createModelClientFromEnv(process.env.AGENT_MODEL ?? "claude-opus-4-8");
  const modelClient = options.modelClient ?? resolved.client;
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
  const envCompat = resolved.compat;
  // 在源头就归一：workdir 参与白名单比对、侧栏分组键、工具圈禁根三处，
  // 三处必须是同一个字符串形态。`D:/a/b` 与 `D:` 指同一个目录，
  // 但字符串不等——不在源头 resolve 的话，默认路径会过不了自己的白名单
  const workdir = resolve(options.workdir ?? process.cwd());
  const allowedWorkdirs = [...new Set([workdir, ...(options.workdirs ?? [])].map((d) => resolve(d)))];
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
    ? createDescribeImageTool({ client: visionRole.provider.client, modelName: visionRole.name })
    : null;
  const toolPool: Tool[] = visionTool ? [...BUILTIN_POOL, visionTool] : BUILTIN_POOL;

  const runs = new Map<string, StoredRun>();

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
   * 列表项摘要。V-14：元数据由服务端算好，侧栏不再依赖"这个 run 是否被订阅过"
   * ——此前核查结论一列只有打开过的 run 才有值。
   */
  function runSummary(r: StoredRun): Record<string, unknown> {
    return {
      runId: r.id,
      task: r.task,
      status: r.status,
      verify: r.verify,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt ?? null,
      packName: r.packName ?? pack?.name ?? null,
      stopReason: r.mainStopReason ?? null,
      finalPassed: r.outcome?.finalPassed ?? null,
      reworks: r.outcome?.reworks ?? null,
      pendingApprovals: r.pendingApprovals.size,
      // V-14 口径：需要人介入的事项由服务端持有，不取决于该 run 有没有被订阅过。
      // 计划门挂起时侧栏就该显示"需你决定"，而不是点进去才发现
      planGate: Boolean(r.planGate),
      awaitingPlanApproval: Boolean(r.pendingPlan),
      planDecision: r.planDecision?.decision ?? null,
      verdict: r.outcome?.verifications.at(-1)?.verdict ?? null,
      mode: r.mode ?? "single",
      conversationTurn: r.conversationTurn,
      // V-32：侧栏按工作目录分组。workdir 是工具的写入圈禁边界，
      // 也就是"这段工作触碰的范围"——它是这个 harness 自己长出来的分组键，
      // 不是从别家侧栏照搬来的层级
      workdir: r.workdir ?? workdir,
      // 能否追加：让界面据此决定要不要显示输入框，而不是点了才报错
      canContinue:
        r.status === "done" && !r.verify && r.mode !== "plan" && Boolean(r.loop && r.history?.length),
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

  // 任务级评分表优先于领域包声明（rubric 是任务属性，包只提供缺省）
  const rubric = process.env.AGENT_VERIFY_RUBRIC ?? pack?.verify.rubric;

  /**
   * MCP 接入状态。**默认不连**，需 AGENT_UI_MCP=1 显式开。
   *
   * 理由不是保守：stm32-debug 这类包声明了 swd-probe 独占资源，而 UI server 是
   * 常驻进程——默认连接就等于一个长期攥着调试探针的会话，正是案例 #3 里
   * 害得整块板子连不上的那种形态。要用就显式开，用完关掉宿主。
   */
  const mcpEnabled = process.env.AGENT_UI_MCP === "1";
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
  function buildConfig(run?: StoredRun): AgentConfig {
    const runPack = run?.packName ? getPack(run.packName) : pack;
    const runEffort = run?.effort ?? effort;
    const runWorkdir = run?.workdir ?? workdir;
    const systemPrompt = runPack?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    // MCP 工具按包的 includeTools 收窄（selectPackTools 负责）。mcpTools 在
    // ensureMcp 之后才非空——所有 start*Run 都先 await 它，不会拿到半截工具面
    const tools = injectedTools ?? (runPack
      ? selectPackTools(runPack, toolPool, mcpTools)
      : [...toolPool, ...mcpTools]);
    return {
      systemPrompt,
      tools,
      workdir: runWorkdir,
      compat: envCompat,
      // 此前这里只设四个字段，pack 的护栏、只读根、effort 全部丢失
      ...(runEffort ? { effort: runEffort } : {}),
      ...(readRoots.length ? { readRoots } : {}),
      ...(contextTokenLimit !== undefined ? { contextTokenLimit } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...((run?.packName ? runPack?.guardrails?.maxTurns : maxTurns) !== undefined
        ? { maxTurns: (run?.packName ? runPack?.guardrails?.maxTurns : maxTurns) as number }
        : {}),
    };
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

    // L6 运行台账：按角色累加工具调用。放在这里而不是收尾时回扫 run.events，
    // 是因为续跑会让事件缓冲跨越多段，回扫容易把上一段的数重复计进来。
    if (event.type === "tool_call") tallyToolCall(run.toolTally, source, event.name);
    // 核查撞轮次上限要留痕：案例 #8 的三层归因里，"预算不够"是第二嫌疑，
    // 而此前它只在日志里一闪而过，事后无从统计
    if (event.type === "done" && isVerifierSource(source) && event.result.stopReason === "max_turns") {
      run.verifierHitBudget = true;
    }

    // F2: verifier 的 approval_request 不进 pendingApprovals（verifier 内部已自答）
    if (event.type === "approval_request" && !isVerifierSource(source)) {
      /**
       * 常驻放行：本次对话里已经对这个工具说过"以后都行"，就直接放。
       *
       * **仍然写一条 approval_resolved 进事件流**（actor: "auto-rule"）——
       * 省掉的是点击，不是记录。事后回看必须看得出"这一步没有人真的点过"，
       * 否则审计里的"已允许"就分不清是人还是规则，那比多点几下危险得多。
       */
      if (run.autoAllow?.has(event.name)) {
        event.respond("allow");
        pushSyntheticEvent(run, "host", {
          type: "approval_resolved",
          requestSeq: seq,
          toolUseId: event.toolUseId,
          name: event.name,
          decision: "allow",
          actor: "auto-rule",
          at: Date.now(),
        });
        return seq;
      }
      run.pendingApprovals.set(approvalId(event.toolUseId, seq), {
        toolUseId: event.toolUseId,
        name: event.name,
        input: event.input,
        requestSeq: seq,
        at: sseEvent.ts,
        respond: event.respond,
      });
      // 侧栏的"待审批"计数靠这条推送保鲜，不必再轮询
      broadcastLifecycle("run_updated", run);
    }

    // 段计数在 done 之后递增：done 自身属于刚结束的那一段
    if (event.type === "done") {
      run.transcript.push({
        index: run.segmentIndex,
        source,
        messages: event.result.messages ?? [],
      });
      run.segmentIndex += 1;
      // V-28：留下会话正史，下一轮 runContinuation 要接在它后面。
      // 只认主线（main）——verifier 是全新上下文的独立复核，它的正史不属于对话
      if (source === "main" && event.result.messages?.length) {
        run.history = event.result.messages;
      }
    }

    // 推送给在线 SSE 客户端
    broadcastSSE(run, frameFor(sseEvent));
    return seq;
  }

  /** 推送合成事件（如 verdict / approval_resolved / run_end）到缓冲与在线客户端 */
  function pushSyntheticEvent(run: StoredRun, source: string, event: Record<string, unknown>): number {
    const seq = run.events.length;
    const sseEvent: SSEEvent = { seq, source, ts: Date.now(), event };
    run.events.push(sseEvent);
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
    if (endInfo.mainStopReason) run.mainStopReason = endInfo.mainStopReason;

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
        error: null,
        turns: o?.executionUsage?.turns ?? null,
        reworks: o?.reworks ?? null,
        finalPassed: o?.finalPassed ?? null,
        verifications: o?.verifications ?? [],
        verifierBudgetTurns: verifyMaxTurnsOf(run.packName ? getPack(run.packName) : pack) ?? null,
        verifierHitBudget: run.verifierHitBudget ?? false,
          tools: run.toolTally,
          durationMs: (run.finishedAt ?? Date.now()) - run.createdAt,
        }),
        ledgerFile,
      );
    }
  }

  /** 启动一次不带核查的运行 */
  async function startPlainRun(run: StoredRun): Promise<void> {
    await ensureMcp(); // 必须在 buildConfig 之前：工具面要么齐要么别开跑
    pushRunConfig(run);
    const cfg = buildConfig(run);
    // V-28：实例留给后续对话轮复用——重建的话 ContextManager 的 lastInputTokens
    // 归零，续跑第一轮的压缩判据会失准
    const loop = new AgentLoop(cfg, modelClient);
    run.loop = loop;
    let mainStopReason: string | undefined;
    try {
      for await (const event of loop.run(run.task, run.abort?.signal)) {
        if (event.type === "done") mainStopReason = event.result.stopReason;
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
      pushEvent(run, "main", errorEvent);
    } finally {
      finalizeRun(run, {
        outcome: mainStopReason === "error" ? "error" : "completed",
        ...(mainStopReason ? { mainStopReason } : {}),
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
   * 轮次预算按 runContinuation 的既有语义**每轮重新起算**（不是累计），
   * 这一点必须让界面说清楚，否则用户会误以为 maxTurns 是整场对话的总额。
   */
  async function startContinuation(run: StoredRun, feedback: string): Promise<void> {
    const loop = run.loop;
    const history = run.history;
    if (!loop || !history) return;

    run.status = "running";
    delete run.finishedAt;
    run.conversationTurn += 1;

    // 追加的这句话本身要进事件流：它是会话的一部分，也是"这一段为什么开始"的解释
    pushSyntheticEvent(run, "host", {
      type: "user_message",
      turn: run.conversationTurn,
      text: feedback,
      at: Date.now(),
    });
    broadcastLifecycle("run_updated", run);

    let mainStopReason: string | undefined;
    try {
      for await (const event of loop.runContinuation(history, feedback, run.abort?.signal)) {
        if (event.type === "done") mainStopReason = event.result.stopReason;
        pushEvent(run, "main", event);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      mainStopReason = "error";
      pushSyntheticEvent(run, "main", {
        type: "done",
        stopReason: "error",
        error: { name: "Error", message: errorMsg },
        messageCount: 0,
        usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, turns: 0, cacheHitRatio: 0 },
      });
    } finally {
      finalizeRun(run, {
        outcome: mainStopReason === "error" ? "error" : "completed",
        ...(mainStopReason ? { mainStopReason } : {}),
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
    pushRunConfig(run);
    const baseCfg = buildConfig(run);
    const startedAt = Date.now();
    let planReadyAt = startedAt;
    const concurrency = run.concurrency ?? "auto";
    let effectiveConcurrency = typeof concurrency === "number" ? concurrency : 1;
    let mainStopReason: string | undefined;

    try {
      const usePlanner = run.usePlannerModel ?? true;
      const outcome = await runPlanned(baseCfg, modelClient, run.task, {
        packs: Object.values(PACKS),
        concurrency,
        ...(envPlanMaxTurns !== undefined ? { planMaxTurns: envPlanMaxTurns } : {}),
        ...(plannerRole && usePlanner
          ? { plannerModel: { client: plannerRole.provider.client, compat: plannerRole.provider.compat } }
          : {}),
        onPlan: async (plan: Plan) => {
          planReadyAt = Date.now();
          if (concurrency === "auto") {
            effectiveConcurrency = Math.min(AUTO_CONCURRENCY_CAP, planParallelWidth(plan.subtasks));
          }
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
          return {
            cfg: {
              ...baseCfg,
              systemPrompt: sp?.systemPrompt ?? baseCfg.systemPrompt,
              // 逐子任务按各自的包收窄 MCP 工具面：stm32-coding 的 mcp:false
              // 拿不到任何 MCP 工具，stm32-debug 才拿到它 includeTools 里那些
              tools: injectedTools ?? selectPackTools(sp, BUILTIN_POOL, mcpTools),
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
            // 独占资源：调度器对同标签子任务强制串行。真机域的探针是全局单件
            ...(sub.resources ?? sp?.resources ? { resources: sub.resources ?? sp!.resources! } : {}),
          };
        },
        onEvent: (source, event) => {
          pushEvent(run, source, event);
        },
      });

      const finishedAt = Date.now();
      const stepSum = outcome.steps.reduce((n, st) => n + st.durationMs, 0);
      const subtaskWall = finishedAt - planReadyAt;
      mainStopReason = plannedStopReason(outcome);

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
        ...(outcome.planOutcome.inventory ? { inventory: outcome.planOutcome.inventory } : {}),
        steps: outcome.steps.map((st) => ({
          id: st.sub.id,
          title: st.sub.title,
          pack: st.sub.pack ?? null,
          durationMs: st.durationMs,
          passed: st.result.finalPassed,
          reworks: st.result.reworks,
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
      mainStopReason = err instanceof PlanRejectedError ? "plan_rejected" : "error";
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
        outcome:
          mainStopReason === "error"
            ? "error"
            : mainStopReason === "plan_rejected"
              ? "rejected"
              : "completed",
        ...(mainStopReason ? { mainStopReason } : {}),
      });
    }
  }

  /** 启动一次带核查的运行 */
  async function startVerifiedRun(run: StoredRun): Promise<void> {
    await ensureMcp();
    pushRunConfig(run);
    const cfg = buildConfig(run);
    let mainStopReason: string | undefined;
    try {
      const outcome = await runVerified(cfg, modelClient, run.task, {
        ...buildVerifyOptions(run),
        ...(run.abort ? { signal: run.abort.signal } : {}),
        onEvent: (source, event) => {
          // 只记主/返工段的终止原因：verifier 的 done 已被 orchestrate 压掉，
          // 这里取到的最后一个就是最终交付那一段的
          if (event.type === "done") mainStopReason = event.result.stopReason;
          pushEvent(run, source, event);
        },
        // V-08：逐轮裁决实时透出。只发末轮的话，"为什么要返工"（中间轮的 issues）
        // 在界面上永远看不到
        onVerification: (round, vo) => {
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
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      mainStopReason = "error";
      pushSyntheticEvent(run, "main", {
        type: "done",
        stopReason: "error",
        error: { name: "Error", message: errorMsg },
        messageCount: 0,
        usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, turns: 0, cacheHitRatio: 0 },
      });
    } finally {
      finalizeRun(run, {
        outcome: mainStopReason === "error" ? "error" : "completed",
        ...(mainStopReason ? { mainStopReason } : {}),
      });
    }
  }

  /** SSE 事件流：先重放缓冲，再实时推送 */
  function serveSSE(req: IncomingMessage, res: ServerResponse, run: StoredRun): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
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
    req.on("close", () => {
      run.sseClients.delete(res);
    });
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
  function pushRunConfig(run: StoredRun): void {
    const runPack = run.packName ? getPack(run.packName) : pack;
    const cfg = buildConfig(run);
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
      roleModels: {
        executor: process.env.AGENT_MODEL ?? "claude-opus-4-8",
        // 报的是本 run 实际用了什么，而不是配了什么——两者可以不同
        verifier: verifierRole && (run.useVerifierModel ?? true) ? verifierRole.name : null,
        planner: plannerRole && (run.usePlannerModel ?? true) ? plannerRole.name : null,
        vision: visionRole?.name ?? null,
      },
      guardrails: {
        maxTurns: cfg.maxTurns ?? null,
        maxTokens: cfg.maxTokens ?? null,
        contextTokenLimit: cfg.contextTokenLimit ?? null,
      },
      tools: cfg.tools.map((t) => ({
        name: t.name,
        permission: t.permission,
        parallelSafe: t.parallelSafe,
        origin: toolPool.some((b) => b.name === t.name) ? "builtin" : "mcp",
      })),
    });
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
      shell: SHELL_DESC,
      workdir,
      readRoots,
      guardrails: {
        maxTurns: maxTurns ?? null,
        maxTokens: maxTokens ?? null,
        contextTokenLimit: contextTokenLimit ?? null,
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
        origin: toolPool.some((b) => b.name === t.name) ? "builtin" : "mcp",
      })),
      mcp: mcpSnapshot(),
    };
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
    | { type: "harness" }
    | { type: "runsList" }
    | { type: "lifecycleStream" }
    | { type: "transcript"; runId: string }
    | { type: "artifact"; runId: string; path: string; download: boolean }
    | { type: "reveal"; runId: string }
    | { type: "stop"; runId: string }
    | { type: "followUp"; runId: string }
    | { type: "upload" }
    | { type: "createRun" }
    | { type: "events"; runId: string }
    | { type: "approval"; runId: string; toolUseId: string }
    | { type: "planApproval"; runId: string }
    | { type: "malformed" } {
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
    const route = matchRoute(method, url);

    switch (route.type) {
      case "malformed":
        return notFound(res, `Unknown route: ${method} ${url}`);

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
          body = await readBody(req);
        } catch {
          return badRequest(res, "Failed to read request body");
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
        //  · 核查/编排模式没有续跑入口（runVerified / runPlanned 都从头开始），
        //    这是本轮明确不做的部分，不是 bug，界面要照实说
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

        let body: string;
        try {
          body = await readBody(req);
        } catch {
          return badRequest(res, "Failed to read request body");
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

        // startContinuation 在第一个 await 之前就把轮数加过了，这里不能再 +1
        void startContinuation(run, parsed.text.trim());
        return json(res, 200, { runId: run.id, conversationTurn: run.conversationTurn });
      }

      case "transcript": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);
        // 按需拉：会话正文可达数 MB，不能进 SSE 缓冲（那会让每个晚订阅的
        // 客户端都重放一遍）。这里只在用户真的切到对话视图时才付这笔代价。
        return json(res, 200, {
          runId: run.id,
          task: run.task,
          segments: run.transcript,
        });
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
        const body = await readBody(req);
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
        try {
          await stat(abs);
        } catch {
          return notFound(res, `Artifact not found: ${wanted}`);
        }
        const cmd = revealCommand(abs);
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
        broadcastLifecycle("run_updated", run);
        return json(res, 200, { stopping: true });
      }

      case "lifecycleStream": {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        // 先发一份当前快照，订阅者不必再额外拉一次 /api/runs
        res.write(
          `data: ${JSON.stringify({
            type: "snapshot",
            runs: [...runs.values()].sort((a, b) => b.createdAt - a.createdAt).map(runSummary),
          })}\n\n`,
        );
        lifecycleClients.add(res);
        req.on("close", () => {
          lifecycleClients.delete(res);
        });
        return;
      }

      case "createRun": {
        let body: string;
        try {
          body = await readBody(req);
        } catch {
          return badRequest(res, "Failed to read request body");
        }
        let parsed: {
          task?: string; verify?: boolean; pack?: string; effort?: string; rubric?: string;
          mode?: string; concurrency?: number | string;
          workdir?: string; useVerifierModel?: boolean; usePlannerModel?: boolean;
          planGate?: boolean;
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
        const id = randomUUID();
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
        };
        runs.set(id, run);
        broadcastLifecycle("run_created", run);

        if (run.mode === "plan") {
          void startPlannedRun(run);
        } else if (verify) {
          void startVerifiedRun(run);
        } else {
          void startPlainRun(run);
        }

        return json(res, 200, { runId: id });
      }

      case "events": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);
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
          body = await readBody(req);
        } catch {
          return badRequest(res, "Failed to read request body");
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
        pendingPlan.settle(parsed.decision);
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
          body = await readBody(req);
        } catch {
          return badRequest(res, "Failed to read request body");
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

        /**
         * `scope: "conversation"` = 本次对话内此后同名工具自动放行。
         * 只对 allow 有意义——"以后都拒绝"没有用例：模型拿到 deny 会换做法，
         * 常驻拒绝等于让它反复撞同一堵墙。
         */
        if (parsed.decision === "allow" && parsed.scope === "conversation") {
          (run.autoAllow ??= new Set()).add(pending.name);
        }
        pending.respond(parsed.decision, parsed.reason);
        const at = Date.now();
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
          ...(parsed.scope === "conversation" ? { scope: "conversation" } : {}),
          at,
        });

        return json(res, 200, {
          acknowledged: true,
          ...(run.autoAllow?.size ? { autoAllow: [...run.autoAllow] } : {}),
        });
      }

      case "static": {
        const filePath = join(PUBLIC_DIR, route.filePath);
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

  const server = createServer(handleRequest);

  return {
    server,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        // 走正规的 finalizeRun 而不是直接掀桌：宿主关停时仍挂起的审批要被
        // 显式宣告过期、run_end 要落进事件流。否则在线客户端只会看到连接莫名断掉，
        // 而它按设计是会自动重连的——语义上就成了"运行还在，只是连不上"。
        for (const run of runs.values()) {
          finalizeRun(run, { outcome: "closed" });
        }
        runs.clear();
        // MCP 子进程必须显式断开：留着就是常驻的僵尸 server，stm32 那种还攥着
        // 探针（案例 #3 的事故原型）。close() 不等它完成——服务器该关就关，
        // 但断开动作要发出去
        void mcpRuntime?.close().catch(() => {});
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

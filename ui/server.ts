/**
 * HTTP + SSE 后端事件桥：把 AgentLoop / runVerified 的 TurnEvent 流暴露给浏览器，
 * 并支持任务提交与审批应答。Node 内置模块，零第三方依赖。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile, writeFile, mkdir, stat, open, readdir, realpath, access, rm } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join, extname, dirname, delimiter, resolve, basename, relative, sep, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { AgentLoop, DEFAULT_MAX_TOKENS, DEFAULT_MAX_TURNS } from "../src/loop.js";
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
  continuationVerifyTask,
  verdictFeedbackSummary,
  AUTO_CONCURRENCY_CAP,
  type VerifiedRunOptions,
  type VerifiedRunResult,
} from "../src/orchestrate.js";
import { createModelClientFromEnv, type ResolvedProvider } from "../src/provider.js";
import {
  ROLE_KEYS,
  MODEL_STORE_FILENAME,
  isValidModelName,
  loadModelStore,
  normalizeBaseUrl,
  redactStore,
  roleEntryOf,
  saveModelStore,
  synthesizeStoreFromEnv,
  testModelEndpoint,
  validateModelConfig,
  type ModelConfigInput,
  type ModelEntry,
  type ModelStore,
} from "./model-config.js";
import {
  WORKDIRS_FILENAME,
  WORKDIRS_SCHEMA_VERSION,
  loadWorkdirStore,
  mergeRunReadRoots,
  parseExtraWorkdirs,
  saveWorkdirStore,
  isSafeFolderName,
} from "./workdirs.js";
import {
  instrumentModelClient,
  modelCallSeconds,
  modelTtftSeconds,
  obsRegistry,
  observeWaitSeconds,
  preregisterObservability,
  waitSeconds,
  WAIT_KINDS,
  costUnpricedTokensTotal,
  costUsdTotal,
  type MetricRole,
} from "../src/metrics.js";
import {
  computeCost,
  loadPriceTable,
  lookupModelPrice,
  sumRunCost,
  type CostResult,
  type PriceTable,
} from "../src/pricing.js";
import {
  createFallbackClientIfConfigured,
  createRoleFallbackClient,
  executorBackupEndpoints,
  FallbackModelClient,
  readFallbackEnv,
  sharedBreakerRegistry,
  stripThinkingFromMessages,
  type CircuitState,
  type FallbackEndpoint,
  type FallbackInfo,
  type FallbackRouting,
} from "../src/model-fallback.js";
import {
  capabilityStorePath,
  configureCapabilityStore,
  endpointIdentityKey,
  getStickyCapabilities,
  learnContextWindow,
  probeEndpointCapabilities,
  probeVisionSupport,
  shouldRunModelProbe,
  type EndpointCapabilities,
  type EndpointIdentity,
} from "../src/model-capability.js";
import {
  planContextBudget,
  readContextLimitEnv,
  readContextWindowEnv,
  resolveContextWindow,
  validateRunContextBudget,
  type ContextPlan,
} from "../src/context-window.js";
import { allPacks, clearFilePacks, getPack, selectPackTools, PACKS, DEFAULT_HOST_DISCIPLINES, type DomainPack } from "../src/presets.js";
import {
  discardDraftPack,
  filePackListView,
  installDraftPack,
  listFilePacks,
  loadInstalledFilePacksSync,
  packsRootFromEnv,
  writeDraftPack,
} from "../src/pack-files.js";
import { draftDomainPackTool } from "../src/tools/draft-domain-pack.js";
import { routeToPack } from "../src/router.js";
import {
  DESIGN_TABS,
  designRouteForRunConfig,
  installedFilePacksFrom,
  publicDesignCatalog,
  routeDesignTask,
  seedsToCopy,
  shouldSeedDesignTemplate,
  shouldWriteBlankDesignIndex,
  writeBlankDesignIndex,
  writeDesignBundleHub,
  type DesignRoute,
} from "../src/design-mode.js";
import {
  decideDesignDraftsSelection,
  isHarnessPackageName,
  packageNameFromJson,
  resolveDesignDraftsDir,
  sameWorkdirPath,
} from "../src/design-workdir.js";
import {
  convertDeckHtmlToPptx,
  DECK_PPTX_NO_SLIDES,
  deckSlideTitle,
  isDeckPptxError,
  joinHtmlRelative,
  pptxRelPathForHtml,
  relativeStylesheetHrefs,
} from "../src/deck-pptx.js";
import {
  CARD_PNG_CAPTURE_UNAVAILABLE,
  CARD_PNG_NO_FRAMES,
  capturePngFramesWithPlaywright,
  fixturePngCapture,
  isCardPngError,
  pngRelPathsForHtml,
  requirePngFrames,
  type PngCaptureFn,
} from "../src/card-png.js";
import {
  connectMcpServers,
  filterMcpConfigForPack,
  loadMcpConfig,
  mergeMcpRuntimes,
  type McpRuntime,
} from "../src/mcp.js";
import { packAcceptsHostGithub } from "../src/mcp-github.js";
import {
  DirtyWorktreeError,
  formatWorkspaceGitLine,
  probeWorkspaceGit,
  publicWorkspaceGit,
  switchWorkspaceBranch,
  type PublicWorkspaceGit,
  type WorkspaceDirtyAction,
} from "../src/workspace-git.js";
import { resolveRunTitle, sanitizeGeneratedTitle, summarizeTitle, titleSourceText, TITLE_SYSTEM } from "./title.js";
import { appendSiteHooks } from "./public/features/review-mode.js";
import { buildStoreZip, zipEntryName } from "./zip.js";
import {
  copyDesignTemplate,
  designTemplatesRootFromRepo,
  listDesignTemplates,
  parseDesignPalette,
  readDesignMd,
} from "./design-templates.js";
import {
  buildFreshTurnBackground,
  buildContinuationAnchor,
  buildExecutorSwitchBriefing,
  buildThreadSketch,
  buildWorkspaceGitBriefing,
  formatSiblingBootContext,
  isRelativeContinuation,
  shouldTreatAsExecutorSwitch,
  withBootContext,
  type ThreadEventLike,
} from "./conversation-context.js";
import {
  formatCiteBlock,
  oneLineTask,
  parseCitedRunIds,
  resolveCiteArtifacts,
  visibleCiteRuns,
  type CiteRef,
} from "./cite.js";
import { aggregateUsage, parseLedgerLines } from "./usage.js";
import { envUpdatesFromStore, upsertEnvKeys } from "./env-sync.js";
import {
  applyMcpServerPatch,
  parseMcpConfigFile,
  publicMcpServers,
  serializeMcpConfig,
} from "./mcp-config-file.js";
import { createWorkdirScopedMemoryTools, MEMORY_TOOL_NAMES, MemoryStore, resolveMemoryDir } from "../src/memory.js";
import {
  annotateMemoryEntries,
  createProjectStatusTool,
  formatProjectStatusBlock,
  isSharedMemoryDir,
  projectSlugFromWorkdir,
  readProjectStatus,
  scopedMemoryIndex,
} from "../src/project-status.js";
import { DEFAULT_VERIFIER_MAX_TURNS, resolveVerifierReadOnlyCommands } from "../src/verifier.js";
import type { Plan, PlanNodeState, SubTask } from "../src/planner.js";
import {
  durableNodeFromPlanNode,
  durablePlanFromPlan,
  handoffsFromPlanNodes,
  planFromNodes,
  planNodesFromDurable,
  planNodesFromSubtasks,
  resolvePlannerMaxTurns,
} from "../src/planner.js";
import { resolveRecoveryPolicy } from "../src/recovery.js";
import {
  matchPermissionMode,
  permissionModeSwitches,
  PERMISSION_MODES,
  type PermissionMode,
} from "../src/permission-mode.js";
import type Anthropic from "@anthropic-ai/sdk";
import { bashTool, SHELL_DESC } from "../src/tools/bash.js";
import { ASK_USER_TOOL_NAME, createAskUserTool, type UserQuestion } from "../src/tools/ask-user.js";
import { createProposeHandoffTool } from "../src/tools/propose-handoff.js";
import { createSpawnTaskTool } from "../src/tools/spawn-task.js";
import { runSpawnedTask } from "../src/spawn.js";
import {
  buildHandoffPlan,
  buildHandoffTask,
  findHandoffAmong,
} from "../src/handoff.js";
import {
  FINISH_TASK_TOOL_NAME,
  withTaskCompletion,
} from "../src/task-completion.js";
import { createDescribeImageTool } from "../src/tools/describe-image.js";
import { createGenerateImageTool } from "../src/tools/generate-image.js";
import { createOpenAIImageClient, DEFAULT_OPENAI_IMAGE_BASE } from "../src/image-client.js";
import { createWebSearchTool, isWebSearchConfigured } from "../src/tools/web-search.js";
import { fetchUrlTool } from "../src/tools/fetch-url.js";
import { editFileTool } from "../src/tools/edit-file.js";
import { globTool } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";
import { readFileTool } from "../src/tools/read-file.js";
import { writeFileTool } from "../src/tools/write-file.js";
import { writePptxTool } from "../src/tools/write-pptx.js";
import { updateProgressTool } from "../src/tools/update-progress.js";
import { resolveInWorkdir } from "../src/tools/fs-util.js";
import { DEFAULT_TOOL_RESULT_MAX_CHARS } from "../src/tools/registry.js";
import {
  appendRunLedger,
  buildLedgerEntry,
  emptyCompactionTally,
  emptyHooksTally,
  emptyRecoveryTally,
  isExecutorSource,
  ledgerErrorClass,
  ledgerPath,
  emptyApprovalsTally,
  tallyApprovalOutcome,
  tallyCompaction,
  tallyHookEvent,
  tallyRecoveryDecision,
  tallyToolCall,
  type LedgerApprovalsTally,
  type LedgerCompactionTally,
  type LedgerHooksTally,
  type LedgerRecoveryTally,
  type ToolTally,
} from "../src/ledger.js";
import { createHookRuntime, resolveHooksFromEnv, type NormalizedHookSpec } from "../src/hooks.js";
import {
  agentMdView,
  loadAgentMd,
  mergeAgentMdContext,
  resolveAgentMdMaxChars,
  type AgentMdBundle,
} from "../src/agent-md.js";
import {
  DEFAULT_HISTORY_KEEP,
  RunHistoryWriter,
  historyKeepCount,
  historyRootPath,
  loadArchivedMetas,
  pruneHistory,
  removeHistoryDir,
  readArchivedEvents,
  readArchivedState,
  readArchivedTranscript,
  readArchivedTrace,
  type ArchivedApprovalGrant,
  type ArchivedCheckpoint,
  type ArchivedMeta,
  parseArchiveHost,
} from "./history.js";
import {
  applyFileRevert,
  captureBeforeWrite,
  conversationTurnFromEvents,
  loadRewindSnapshots,
  parseRewindFromMeta,
  parseRewindRequest,
  persistRewindSnapshot,
  pickTranscriptForRewind,
  truncateEventsToSeq,
  wrapToolsWithRewindSnapshots,
  writesAfterSeq,
  type FileRewindRecord,
} from "./conversation-rewind.js";
import {
  ScheduleRunner,
  SCHEDULE_TICK_MS,
  advanceAfterMiss,
  computeNextRunAt,
  isMissed,
  loadSchedules,
  parseScheduleSpec,
  saveSchedules,
  schedulesFilePath,
  type ScheduleEntry,
} from "./scheduler.js";
import {
  canReopenSameRun,
  canRestorePlanGate,
  canSameRunResume,
  initialRunState,
  planResumeFacts,
  recoveryActionForPhase,
  transitionRunState,
  type DurableBudgetSnapshot,
  type DurableGrantAuditEntry,
  type DurablePlanNode,
  type DurablePlanSnapshot,
  type DurableRunState,
  type RunStateEvent,
} from "../src/run-state.js";
import { findToolTx, type DurableToolTx, type ToolTxController } from "../src/tool-tx.js";
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
import {
  hostPlanEvent,
  hostPlanReplanEvent,
  hostPlanResultEvent,
  hostPlanResumeEvent,
  hostPlanSubtaskViews,
  serializeTurnEventForArchive,
} from "../src/archive-event.js";
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
  RecoveryPolicy,
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
  /**
   * 最近一次**核查过的那一轮**的完整结果（含 executionUsage / reworks / 全部裁决）。
   * 会话中心化之后核查是逐轮选项：`outcomeTurn` 记它属于哪一轮——run_end / 台账只在
   * 本轮确实核查过时才带它，列表列则始终报最近一次裁决并标明轮号。
   */
  outcome?: VerifiedRunResult;
  outcomeTurn?: number;
  /**
   * plan 模式收尾时的结构化摘要（子任务 / 结局 / 交接摘要 / 裁决）。计划编排没有
   * 单一执行者正史可续，下一轮对话以它为种子、按单执行者跑——"续的是对话，
   * 不是 DAG"。归档恢复时从 plan / plan_result 事件重建。
   */
  planSummary?: string;
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
  /** 执行者谱系的恢复决策计数（续跑/停滞/强制收口），与 toolTally 同在事件旁路累加 */
  recoveryTally?: LedgerRecoveryTally;
  /** 上下文压缩计数（全部角色；常规 / 反应式 / 置换块 / 折叠轮），同在事件旁路累加 */
  compactionTally?: LedgerCompactionTally;
  /** 外部 hooks 计数；仅武装时累加。未武装的 run 不建这个字段。 */
  hooksTally?: LedgerHooksTally;
  /** 工具审批结局；在 approval_resolved / approval_expired 旁路累加（不是请求）。 */
  approvalsTally?: LedgerApprovalsTally;
  /**
   * 本对话轮执行者谱系（main / rework / 子任务 main）各段 done.usage.turns 之和。
   * 台账 `turns` 此前只在带核查时有值（读 outcome.executionUsage），裸跑一律 null——
   * 而 max_turns 的 Web 行恰好全是裸跑，"用了多少轮 vs 护栏"就永远算不出来。
   * 每个对话轮起点归零，口径与 executionUsage.turns（本轮各执行段之和）一致。
   */
  turnExecutorTurns?: number;
  /**
   * OBS-02：逐次记账事件的成本折算结果（execution / verification / planner）。
   * 与 toolTally 同一条纪律——事件旁路逐条累加，不在收尾回扫。
   * **视觉不在内**：describe_image 的 client 是宿主级的，调用发生在工具内部，
   * 拿不到是哪个 run 在用它；它只进 /metrics 的成本曲线（与现有 token 记账同边界）。
   */
  costParts?: Array<{ role: string; cost: CostResult }>;
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
  /** 侧栏短标题（启发式或首轮后的模型摘要） */
  title?: string;
  /** 自动匹配领域包时 router 的决定，给界面照实说 */
  packRoute?: { pack: string | null; reason: string };
  effort?: Effort;
  rubric?: string;
  /**
   * 逐 run 上下文预算（MEM-01 窗口 / 预算分离；请求体 `contextTokenLimit`）。建 run 时已按
   * [32k, 窗口 − maxTokens − 边际] 校验过；缺省 = env > 包 > 默认 150k。续跑 / 派生沿用。
   */
  contextTokenLimit?: number;
  /** 最近一次 buildConfig 解析出的窗口 / 预算计划（台账记的是它，不是收尾时重算的） */
  contextPlan?: ContextPlan;
  /** 档案来源。cli = CLI 写下的；缺省 = Web。列表只在 cli 时标徽章。 */
  host?: "cli" | "web";
  /** V-27：编排模式。plan = 走 runPlanned；design = 设计模式门面（单执行者） */
  mode?: "single" | "plan" | "design";
  /** 侧栏办公/编码脸；旧档案缺省，列表按 packName=design 回退 */
  workspace?: "office" | "code";
  /** 设计模式路由结果，给界面照实说 */
  designRoute?: {
    id: string | null;
    reason: string;
    seed: string;
    kind: string;
    bundle?: string | null;
    extraSeeds?: string[];
  };
  concurrency?: number | "auto";
  /**
   * 谱系 token/轮次硬顶。缺省 true（真实宿主默认 2M / 120）。
   * false = 本 run 不注入 maxTokensBudget / maxTotalTurns，不会 budget_exhausted。
   */
  lineageBudget?: boolean;
  /**
   * 日预算门。缺省 true（若宿主配了 AGENT_UI_DAILY_TOKEN_BUDGET）。
   * false = 本请求与后续追问跳过 dailyBudgetRefusal。
   */
  dailyBudget?: boolean;
  /**
   * V-28 多轮对话：会话正史（执行者谱系 main/rework 最后一段的完整消息）与本轮的
   * loop 实例。会话中心化之后每轮**新建** AgentLoop：预算与 Context 水位从检查点
   * 延续（与归档派生 / 同 run 热恢复同一口径），不再靠"活对象还在"才能续——
   * 那正是"执行阶段失败就再也续不上"的来源之一。
   */
  loop?: AgentLoop;
  history?: Anthropic.MessageParam[];
  /** 写出这段正史的执行者角色 id（模型库 roles.executor） */
  lastExecutorRoleId?: string;
  /** 写出这段正史的端点身份键（provider|model|origin） */
  lastExecutorIdentityKey?: string;
  /** 写出这段正史时的模型名——换模型 briefing 用 */
  lastExecutorModel?: string;
  /**
   * 信息队列·排队指令（委托方："等队列结束后再发送"）。运行中收到、本轮结束后
   * 由宿主拼成一条自动续跑（见 finalizeRun 尾部的 flushQueuedMessagesAfterDone）。
   * 崩溃恢复由 events.jsonl 里的 message_queued / message_queue_updated 重放重建。
   */
  messageQueue?: string[];
  /**
   * 信息队列·插队指令（"插队重新让 agent 思考"）。loop 在下一次模型调用前
   * drain 进正史；本轮没赶上的余量在收尾时并入自动续跑——消息不丢。
   */
  steeringQueue?: string[];
  /** 已进行的对话轮数（第 1 轮 = 建 run 时那次提交） */
  conversationTurn: number;
  /**
   * 对话轮驱动世代。follow-up / flush / 首轮各占一段；finalize 必须带同一世代，
   * 否则不得发 run_end、不得拆 execution broker。真机事故：planner 抢先收尾
   * 把还在跑的执行者 bash 拆成 "Execution broker is disposed."
   */
  turnDriverEpoch?: number;
  /** 当前是否有一段对话轮驱动在飞（比 status=running 更早立上，挡住 TOCTOU） */
  turnDriverActive?: boolean;
  /** V-29：本次运行的工作目录（工具写入圈禁根），必来自白名单 */
  workdir?: string;
  /** 工作区 git 身份（不带 remote URL）。跟 workdir 走，换包不消失。 */
  workspaceGit?: PublicWorkspaceGit;
  /** 勾选的额外白名单目录（提示焦点）。写入圈是整份白名单，不靠这一项放行。 */
  extraWorkdirs?: string[];
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
  /**
   * 交互式 Web：本 run 自动放行执行者工具。默认关（API / 脚本不能悄悄变成 --yes）。
   * 工作目录圈禁与只读核查边界仍在。
   */
  autoApprove?: boolean;
  /**
   * D3：若请求带了 permissionMode，记下档名；装配条仍展开真实开关。
   * 未带模式、或开关与预设不符时为 undefined（自定义）。
   */
  permissionMode?: "manual" | "plan" | "auto";
  /** 当前提问挂起态；计划并发下其它提问进入 questionQueue，不能覆盖这一项。 */
  pendingQuestion?: PendingQuestion;
  /** 多执行者并发调用 ask_user 时的宿主级串行队列。 */
  questionQueue?: QueuedQuestion[];
  /**
   * 本 run 的 ask_user 工具实例。**必须缓存**：配额是逐实例计数的，
   * buildConfig 每次新造一个等于配额永远用不完（决定 2 当场作废）。
   */
  askUserTool?: Tool;
  /**
   * 不挡对话的「下一步」提议。工具立刻返回；人点同意才开子 run。
   * 文案以包声明为准，不采信模型自己写的按钮字。
   */
  handoffProposal?: HandoffProposalState;
  proposeHandoffTool?: Tool;
  /** AGENT-02：spawn_task 实例缓存（与 ask_user 同款理由） */
  spawnTaskTool?: Tool;
  /** 宿主注入的计划（handoff 同意后）：跳过 planner，也不开计划确认门 */
  injectedPlan?: Plan;
  /**
   * AGENT-01：上一份计划的节点状态 + 已通过节点交接摘要。
   * 重规划时喂给 runPlanned.replan；普通追问不碰。
   */
  planNodes?: PlanNodeState[];
  planHandoffs?: Record<string, string>;
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
  archivedOutcome?: {
    finalPassed: boolean | null;
    reworks: number | null;
    verdict: Verdict | null;
    judgedTurn?: number;
  };
  /** 最近一个完整 main 段的可恢复检查点；归档本身保持只读，续跑会派生新 run。 */
  checkpoint?: ArchivedCheckpoint;
  /** 从 checkpoint 恢复的只读授权审计；永不装进 autoAllow。 */
  archivedApprovalGrantAudit?: ArchivedApprovalGrant[];
  /** 派生谱系。continuedFrom 是直接父级，rootRunId 是最初祖先。 */
  continuedFrom?: string;
  rootRunId?: string;
  /** 本轮收尾摘要（执行者最后一段正文的首句）；列表与 fort 续跑沿用 */
  conversationRecap?: string;
  /**
   * 新开 run 时宿主装配的开机背景（同 workdir 最近会话等）。
   * 只进执行者首轮任务书 / fresh 续跑反馈，不改写委托方原话、不冒充正史。
   */
  bootContext?: string;
  /** 委托方点名引用的【引用】块；与 sibling boot 分开，不改 formatSiblingBootContext。 */
  citeContext?: string;
  /** 本 run 点名引用的会话（进 run_config，供界面画出引用了谁/哪些文件） */
  cited?: Array<{ runId: string; title: string; artifacts: string[] }>;
  /** 仅供刚派生的新 run 装配首轮；完成后 checkpoint 会从真实 done 事件重建。 */
  resumeBudget?: SharedRunBudget;
  initialContextInputTokens?: number;
  /**
   * RUN-01 / ADR-003：进程内 Durable RunState 游标；与 `state.json` 同步。
   * 崩溃相收成 closed/interrupted；Phase 2 在 interrupted+checkpoint 时可同
   * runId 段边界续跑（不恢复 live loop / active grant）。
   */
  durableState?: DurableRunState;
  // ---- OBS-01 trace ----
  /**
   * 对话回退：子 run 是裁到 parent.seq 的快照；谱系拼聊天时在这一头截断，
   * 不再把父 run 裁点之后的轮次拼回来。
   */
  rewindFrom?: { parentRunId: string; seq: number; revertFiles: boolean };
  /** write_file 等调用前的 before 镜像（进程内）；落盘在档案 rewinds/ */
  fileRewindSnapshots?: FileRewindRecord[];
  fileRewindBlobs?: Map<string, Buffer>;
  /** 本 run 根 span id；子 span 挂在其下 */
  traceRunSpanId?: string;
  /** tool_call → tool_result 开闭配对 */
  openToolSpans?: Map<string, TraceSpan>;
  /** model_call_start → model_call_end 开闭配对 */
  openModelSpans?: Map<string, TraceSpan>;
}

interface PendingPlan {
  requestSeq: number;
  at: number;
  /** 由 waitForPlanDecision 装填：应答或过期时结束等待 */
  settle: (decision: "approve" | "reject" | "expired") => void;
}

interface HandoffProposalState {
  status: "pending" | "accepted" | "declined";
  id: string;
  handoffId: string;
  summary: string;
  label: string;
  declineLabel: string;
  requestSeq: number;
  childRunId?: string;
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
  questions: UserQuestion[];
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

/**
 * SSE 重放时：档案里还没标 autoResolved 的 request，只要后面已有
 * resolved/expired，就在出站帧上补上。客户端即使被 500ms 超时切批，
 * 也不会先画出一张已决的幽灵卡。不回写 run.events。
 */
export function annotateApprovalReplay<T extends { seq: number; event: Record<string, unknown> }>(
  events: readonly T[],
): T[] {
  const resolved = new Map<string, Record<string, unknown>>();
  const byTool = new Map<string, Record<string, unknown>[]>();
  for (const item of events) {
    const ev = item.event;
    if (ev.type !== "approval_resolved" && ev.type !== "approval_expired") continue;
    const toolUseId = String(ev.toolUseId ?? "");
    if (!toolUseId) continue;
    const requestSeq = Number(ev.requestSeq);
    if (Number.isFinite(requestSeq)) resolved.set(`${toolUseId}#${requestSeq}`, ev);
    else {
      const list = byTool.get(toolUseId) ?? [];
      list.push(ev);
      byTool.set(toolUseId, list);
    }
  }
  if (resolved.size === 0 && byTool.size === 0) return events.slice();
  return events.map((item) => {
    const ev = item.event;
    if (ev.type !== "approval_request" || ev.autoResolved === true) return item;
    const toolUseId = String(ev.toolUseId ?? "");
    const exact = resolved.get(`${toolUseId}#${item.seq}`);
    const fallback = byTool.get(toolUseId);
    const hit = exact ?? (fallback?.length === 1 ? fallback[0] : undefined);
    if (!hit) return item;
    return {
      ...item,
      event: {
        ...ev,
        autoResolved: true,
        decision: hit.type === "approval_expired" ? "deny" : (hit.decision ?? "allow"),
        actor: hit.actor,
        ...(hit.type === "approval_expired" ? { expired: true } : {}),
      },
    };
  });
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

/**
 * 执行者谱系（会话中心化的核心概念）：main 与 rework 段——含续跑段，它们也以
 * main 发出——构成**对话**；verifier / planner / 计划子任务（sN/…）不属于对话。
 * 会话正史与检查点只从这些段捕获：返工段的正史此前根本没被记，返工后再续跑
 * 接的是陈旧正史。
 */
export function isExecutorLineageSource(source: string): boolean {
  return source === "main" || source === "rework";
}

/**
 * meta.json 里的裁决是落盘再读回的 unknown（restoreArchivedRuns 只做了类型断言）。
 * 拿它给执行者写摘要之前先验形状：坏档案该让派生少一段话，不该炸掉派生本身。
 */
export function isVerdictShape(value: unknown): value is Verdict {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.passed === "boolean" && typeof v.summary === "string" && Array.isArray(v.issues);
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

/**
 * T5 /api/memory/:name 的合法记忆名：与 MemoryStore.NAME_RE 对齐（允许嵌套
 * lessons/foo.md）。路径穿越仍由 ".." 与 resolvePath 双保险挡住。
 */
/** T5 单条记忆读取上限：超出截断并在响应里标注 truncated */
const MEMORY_READ_MAX_BYTES = 256 * 1024;

// ------------------------------------------------------------------
// T6 全局搜索（/api/search）：标题 + 正文
// ------------------------------------------------------------------

/** 查询词最短长度：单字符子串匹配信噪比太低（一个汉字几乎命中所有档案） */
const SEARCH_MIN_QUERY_CHARS = 2;
/** 结果 run 数默认上限与硬上限 */
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;
/** 扫描 run 数上限：兜底总耗时，超出截断并在响应里标注 truncatedRuns */
const SEARCH_RUN_SCAN_CAP = 500;
/** 每个 run 最多返回的正文命中条数 */
const SEARCH_SNIPPETS_PER_RUN = 3;
/** 命中片段前后各带的上下文字符数 */
const SEARCH_SNIPPET_CONTEXT_CHARS = 60;
/** 单条 transcript 只搜前 10MB：超大档案不拖垮整次搜索 */
const SEARCH_TRANSCRIPT_MAX_BYTES = 10 * 1024 * 1024;

export interface SearchSnippet {
  text: string;
  lineHint: string;
}

export interface SearchRunResult {
  runId: string;
  title: string;
  workdir: string | null;
  status: string;
  updatedAt: number;
  titleHit: boolean;
  snippets: SearchSnippet[];
}

export interface SearchHistoryResponse {
  query: string;
  results: SearchRunResult[];
  truncatedRuns: boolean;
}

/**
 * 只读文件前 maxBytes 字节并解码 UTF-8。截断点可能落在多字节字符中间，
 * toString 会在末尾留下替换符——替换符不可能匹配任何查询词，于搜索无害。
 * 文件不存在/读失败返回空串（档案坏一条不该拖垮整次搜索，同 loadArchivedMetas 纪律）。
 */
async function readFileHeadUtf8(file: string, maxBytes: number): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(file, "r");
    const size = (await handle.stat()).size;
    const length = Math.min(size, maxBytes);
    if (length <= 0) return "";
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, 0);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * 从一行 transcript.jsonl 提取可搜索正文。
 * 段形状：{ index, source, messages: [{ role, content }] }——content 是字符串
 * （user）或块数组（assistant 的 text/thinking 块）。坏行返回空串（追加中断
 * 可能留下半行，同 readJsonLines 的跳行纪律）。
 */
function transcriptLineSearchText(line: string): string {
  let segment: unknown;
  try {
    segment = JSON.parse(line);
  } catch {
    return "";
  }
  if (!segment || typeof segment !== "object") return "";
  const messages = (segment as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return "";
  const parts: string[] = [];
  for (const message of messages) {
    const content = (message as { content?: unknown } | null)?.content;
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as { text?: unknown; thinking?: unknown } | null;
        if (typeof b?.text === "string") parts.push(b.text);
        else if (typeof b?.thinking === "string") parts.push(b.thinking);
      }
    }
  }
  return parts.join("\n");
}

/** 在 text 里取一条命中片段：命中词前后各约 CONTEXT 字符，截断处加省略号 */
function makeSnippet(text: string, hitAt: number, queryLength: number): string {
  const start = Math.max(0, hitAt - SEARCH_SNIPPET_CONTEXT_CHARS);
  const end = Math.min(text.length, hitAt + queryLength + SEARCH_SNIPPET_CONTEXT_CHARS);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

/**
 * T6 全局搜索主体。只读、串行读盘；圈禁在历史根目录**平铺**的 run 目录内——
 * 目录名来自 readdir 而非客户端输入，且含分隔符/点号的异常条目直接跳过，
 * 没有任何路径参数能把读取引出 root。
 */
async function searchRunHistory(
  root: string,
  query: string,
  limit: number,
): Promise<SearchHistoryResponse> {
  const queryLower = query.toLowerCase();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return { query, results: [], truncatedRuns: false }; // 根目录不存在 = 还没有历史
  }
  const truncatedRuns = entries.length > SEARCH_RUN_SCAN_CAP;
  const results: SearchRunResult[] = [];
  let scanned = 0;
  for (const name of entries) {
    if (scanned >= SEARCH_RUN_SCAN_CAP) break;
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) continue;
    scanned += 1;
    const dir = join(root, name);
    let meta: ArchivedMeta;
    try {
      meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as ArchivedMeta;
      if (!meta || meta.version !== 1 || typeof meta.runId !== "string" || meta.runId === "") continue;
    } catch {
      continue; // 半写目录/损坏 meta/无关文件：逐条跳过
    }
    const title = typeof meta.task === "string" ? meta.task : "";
    const titleHit = title.toLowerCase().includes(queryLower);
    const snippets: SearchSnippet[] = [];
    const transcript = await readFileHeadUtf8(join(dir, "transcript.jsonl"), SEARCH_TRANSCRIPT_MAX_BYTES);
    if (transcript) {
      const lines = transcript.split("\n");
      for (let i = 0; i < lines.length && snippets.length < SEARCH_SNIPPETS_PER_RUN; i++) {
        const line = lines[i]!.trim();
        if (!line) continue;
        const text = transcriptLineSearchText(line);
        const hitAt = text.toLowerCase().indexOf(queryLower);
        if (hitAt < 0) continue;
        snippets.push({
          text: makeSnippet(text, hitAt, query.length),
          lineHint: `transcript.jsonl 第 ${i + 1} 行`,
        });
      }
    }
    if (!titleHit && snippets.length === 0) continue;
    results.push({
      runId: meta.runId,
      title,
      workdir: typeof meta.workdir === "string" ? meta.workdir : null,
      status: typeof meta.status === "string" ? meta.status : "done",
      updatedAt:
        typeof meta.finishedAt === "number"
          ? meta.finishedAt
          : typeof meta.createdAt === "number"
            ? meta.createdAt
            : 0,
      titleHit,
      snippets,
    });
  }
  results.sort((a, b) => b.updatedAt - a.updatedAt);
  return { query, results: results.slice(0, limit), truncatedRuns };
}

// ------------------------------------------------------------------
// T8 变更审查（/api/runs/:id/changes）：这次运行触碰了哪些文件
// ------------------------------------------------------------------

/**
 * 能从 tool_call 入参直接读出目标路径的写盘工具 → 操作标签。
 * 与 src/tools/ 的实际注册名一一对应（write_file / write_pptx / edit_file）。
 * bash 不在其中：它的写入藏在任意命令串里，从入参读不出路径——
 * 这与 app.js deriveArtifacts 的口径一致，宁缺勿假。
 * memory_write 有自己的面板（T5），不混入"工作目录变更"。
 */
const CHANGE_TOOL_OPS: Record<string, "write" | "edit"> = {
  write_file: "write",
  write_pptx: "write",
  edit_file: "edit",
};

/** git 子进程硬上限：不可用/超时一律静默降级为 git: null（Supervisor 视图缺了 diff 也要能开） */
const GIT_PROBE_TIMEOUT_MS = 3000;

export interface ChangeGitInfo {
  /** porcelain 归一状态："M" 修改 / "A" 新增（含已暂存）/ "??" 未跟踪 / "D" 已删除 */
  status: string;
  /** `git diff --stat HEAD -- <path>` 的增删行数；无 diff（未跟踪/无变化）为 null */
  added: number | null;
  deleted: number | null;
}

export interface RunChangeEntry {
  /** 相对 run workdir 的正斜杠路径；越界路径保留工具入参原文 */
  path: string;
  ops: string[];
  count: number;
  /** 最后一次触碰的服务端接收时刻（事件包络 ts），无时间戳为 null */
  lastAt: number | null;
  outOfScope: boolean;
  exists: boolean;
  sizeBytes: number | null;
  mtimeMs: number | null;
  git: ChangeGitInfo | null;
}

/** 从事件流聚合写盘工具的触碰路径。事件形状见 pushEvent：{ seq, source, ts, event } 包络。 */
export function collectTouchedPaths(
  events: unknown[],
): { input: string; ops: Set<string>; count: number; lastAt: number | null }[] {
  const groups = new Map<
    string,
    { input: string; ops: Set<string>; count: number; lastAt: number | null }
  >();
  for (const envelope of events) {
    const ev = (envelope as { event?: unknown } | null)?.event as
      | { type?: unknown; name?: unknown; input?: unknown }
      | undefined;
    if (!ev || ev.type !== "tool_call" || typeof ev.name !== "string") continue;
    const op = CHANGE_TOOL_OPS[ev.name];
    if (!op) continue;
    const raw = (ev.input as { path?: unknown } | null | undefined)?.path;
    if (typeof raw !== "string" || !raw.trim()) continue;
    const input = raw.trim();
    const ts = (envelope as { ts?: unknown } | null)?.ts;
    const at = typeof ts === "number" && Number.isFinite(ts) ? ts : null;
    let group = groups.get(input);
    if (!group) {
      group = { input, ops: new Set(), count: 0, lastAt: null };
      groups.set(input, group);
    }
    group.ops.add(op);
    group.count += 1;
    if (at !== null) group.lastAt = at;
  }
  return [...groups.values()];
}

/** porcelain 行首两个字符 → 归一状态。优先级：未跟踪 > 删除 > 新增 > 修改 > 其他原样首字符。 */
export function parseGitPorcelainStatus(line: string): string | null {
  if (!line || line.length < 2) return null;
  const xy = line.slice(0, 2);
  if (xy === "??") return "??";
  if (xy.includes("D")) return "D";
  if (xy.includes("A")) return "A";
  if (xy.includes("M")) return "M";
  const first = xy.trim().charAt(0);
  return first || null;
}

/** 解析 `git diff --stat` 的汇总行：「 1 file changed, 5 insertions(+), 3 deletions(-)」。 */
export function parseDiffStatSummary(text: string): { added: number | null; deleted: number | null } {
  const m = /(\d+)\s+files?\s+changed/.exec(text);
  if (!m) return { added: null, deleted: null };
  const ins = /(\d+)\s+insertions?\(\+\)/.exec(text);
  const del = /(\d+)\s+deletions?\(-\)/.exec(text);
  return {
    added: ins ? Number(ins[1]) : 0,
    deleted: del ? Number(del[1]) : 0,
  };
}

const execFileAsync = promisify(execFile);

/** 单文件 git 探针：porcelain 状态 + diff 统计。任何失败/超时 → null（静默降级）。 */
async function probeGitForFile(root: string, relPath: string): Promise<ChangeGitInfo | null> {
  try {
    const statusOut = await execFileAsync("git", ["status", "--porcelain", "--", relPath], {
      cwd: root,
      timeout: GIT_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      // Windows 上 execFile 不经 shell：参数按数组逐个传递，没有转义面
      windowsHide: true,
    });
    const firstLine = statusOut.stdout.split("\n").find((l) => l.trim().length > 0) ?? "";
    const status = parseGitPorcelainStatus(firstLine);
    if (!status) return null; // 干净文件（已提交且无改动）不挂徽章
    let added: number | null = null;
    let deleted: number | null = null;
    if (status !== "??") {
      // HEAD 口径同时覆盖已暂存与未暂存改动；未跟踪文件无 diff 可言
      const diffOut = await execFileAsync("git", ["diff", "--stat", "HEAD", "--", relPath], {
        cwd: root,
        timeout: GIT_PROBE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      ({ added, deleted } = parseDiffStatSummary(diffOut.stdout));
    }
    return { status, added, deleted };
  } catch {
    return null; // git 不在 PATH、非仓库、超时、被杀——一律降级，视图照样能开
  }
}

/** workdir 是否 git 仓库（.git 存在即可，文件或目录都算——worktree 的 .git 是文件）。 */
async function detectGitRepo(root: string): Promise<boolean> {
  try {
    await stat(join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * 按字节上限截断 UTF-8 文本，回退到完整字符边界——
 * 直接 Buffer.subarray 会在多字节字符中间下刀，解码出替换符导致结果反而超上限。
 */
function utf8SafeHead(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8").subarray(0, maxBytes);
  let end = buf.length;
  for (let i = Math.max(0, buf.length - 4); i < buf.length; i++) {
    const b = buf[i]!;
    const seqLen = b < 0x80 ? 1 : b < 0xc0 ? 0 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
    if (seqLen === 0) continue; //  continuation byte：归属前面的序列
    if (i + seqLen > buf.length) { end = i; break; } // 序列伸出截断点 → 整段丢弃
  }
  return buf.subarray(0, end).toString("utf8");
}

export interface UiServerOptions {
  modelClient?: ModelClient;
  workdir?: string;
  /**
   * V-29：允许逐 run 选择的工作目录白名单。
   *
   * 为什么是白名单而不是自由输入：workdir 同时是**工具的写入圈禁边界**
   * （ToolExecutor 拿它当根）。让浏览器随意指定等于让任何能访问 UI 的人
   * 往任意目录写文件。按 P6「护栏是宿主的责任」，合法集合由宿主声明，
   * 浏览器只在其中选。缺省 = 只有 workdir 一个。
   *
   * 声明有两个时刻：启动时（本参数 / AGENT_UI_WORKDIRS env）与运行时
   * （用户经本机 UI 的「添加目录」显式加入，loopback 门后落
   * .agent-workdirs.json，重启后仍在）。后者同样是宿主级声明——它只是把
   * 「宿主表态」从命令行挪到了本机界面上。
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
  /** 历史保留数（判据③），缺省 env AGENT_RUN_HISTORY_KEEP（仅真实宿主读）> DEFAULT_HISTORY_KEEP */
  historyKeep?: number;
  /**
   * 端点能力缓存（撞 400 学到的上下文窗口）落点。缺省逻辑同 `ledger`：注入了 modelClient
   * 就只在进程内记（`false` 同义）；字符串 = 指定文件；真实宿主缺省 <cwd>/.agent-capabilities.json。
   */
  capabilityCache?: false | string;
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
  /**
   * 单一远端地址每分钟可发出的**状态变更**请求数；真实宿主默认 120。
   * 路径探活、在文件夹中显示不计入；澄清/审批/计划门/停止也不拦。
   */
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
   * 端点降级链（MODEL-01a）的配置源。缺省：真实宿主读 `process.env`；**注入了
   * modelClient 的宿主读一份空 env**（同 `roleEnv`，见那条的仪器纪律）——
   * 假模型的请求绝不该因为开发机残留的 AGENT_FALLBACK_* 被转发到真端点上去。
   * 要武装就显式传（测试传自己的一份，嵌入式真实 client 传 `process.env`）。
   * 注意与 `executionEnv` 的区别：隔离策略是安全语义，不按注入推断；降级链与
   * 角色模型是可选装备，缺省不装才是对假模型诚实。
   */
  fallbackEnv?: NodeJS.ProcessEnv;
  /**
   * 角色模型（verifier / planner / vision 的 AGENT_<ROLE>_MODEL 及同组后缀）的配置源。
   *
   * 仪器纪律（与台账 / 历史落盘同一条）：`options.modelClient` 是测试与脚本的注入口，
   * 注入宿主跑的是假模型，**不该被 shell 里残留的 env 武装**——曾有一次
   * AGENT_VERIFIER_MODEL 残留让假模型驱动的核查轮真的去连端点，10 条 ui-server
   * 测试当场红、而且无法从失败信息归因。缺省：真实宿主读 `process.env`，注入宿主读空 env；
   * 要在测试里验证角色模型装配，显式传一份自己的 env。
   */
  roleEnv?: NodeJS.ProcessEnv;
  /**
   * 模型库文件（MODEL-02，.agent-models.json）落点。缺省：真实宿主
   * `<workdir>/.agent-models.json`；**注入了 modelClient 的宿主缺省 null**
   * （纯内存库，仪器纪律同 roleEnv——假模型宿主不该被开发机残留的库文件武装）。
   * 显式传路径可在测试里验证持久化与重装配。
   */
  modelStoreFile?: string | null;
  /** 「同步到 .env」的落点。缺省真实宿主 `<cwd>/.env`；注入宿主缺省不写。 */
  envFile?: string | null;
  /** mcp.json 落点。缺省 `AGENT_MCP_CONFIG` 或 `<workdir>/mcp.json`。测试应显式传入，避免改仓库文件。 */
  mcpConfigFile?: string;
  /**
   * 文件领域包根目录（drafts/ + installed/）。
   * 缺省：真实宿主读 `AGENT_PACKS_DIR` 或 `<cwd>/.agent-packs`；
   * **注入了 modelClient 的宿主缺省 null**——假模型路径不该被开发机草稿武装。
   * 显式 `null` = 不装文件包；字符串 = 指定根。
   */
  packsDir?: string | null;
  /**
   * 运行时工作目录清单文件（V-29 扩展，.agent-workdirs.json）落点。缺省：真实宿主
   * `<workdir>/.agent-workdirs.json`；**注入了 modelClient 的宿主缺省 null**
   * （不落盘、不读残留，仪器纪律同 modelStoreFile）。显式传路径可在测试里验证
   * 运行时添加目录的持久化与 round-trip。
   */
  workdirStoreFile?: string | null;
  /** 只在宿主确实位于可信反向代理之后时读取 X-Forwarded-Proto/Host。 */
  trustProxy?: boolean;
  /**
   * SAFE-06 测试钩子：tool_prepared 落盘后、副作用前崩溃。
   * 返回 true 时抛 ToolTxCrashError；宿主收成 interrupted 且不 finalize 完成态。
   */
  crashAfterToolPrepared?: (runId: string, tx: DurableToolTx) => boolean;
  /**
   * design 模板根目录（内含 deck-basic/ 等）。缺省探测仓库 `templates/design`；
   * 显式 `null` = 关闭模板 API（测试可隔离）。
   */
  designTemplatesDir?: string | null;
  /**
   * 设计模式独立稿目录。缺省：真实宿主 `AGENT_DESIGN_DRAFTS_DIR` 或 `~/Fathom`；
   * 注入宿主缺省落在该实例 workdir 下的 Fathom-drafts，避免测试写进操作员家目录。
   */
  designDraftsDir?: string;
  /**
   * 方图 PNG 截图器。缺省：真实宿主走 Playwright；注入宿主用 1×1 夹具，
   * 避免测试套启动 Chromium。
   */
  capturePngFrames?: PngCaptureFn;
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

export {
  durableNodeFromPlanNode,
  durablePlanFromPlan,
  handoffsFromPlanNodes,
  planNodesFromDurable,
};

function evidenceFromVerifiedStep(result: {
  finalPassed: boolean;
  main: { completion?: { summary?: string; artifacts?: string[] } | null };
  verifications: Array<{ verdict?: { summary?: string; issues?: string[] } | null }>;
}): string | undefined {
  const parts: string[] = [];
  const completion = result.main.completion;
  if (completion?.summary) parts.push(completion.summary);
  if (completion?.artifacts?.length) parts.push(`产物：${completion.artifacts.join("、")}`);
  const verdict = result.verifications.at(-1)?.verdict;
  if (verdict?.summary) parts.push(`裁决：${verdict.summary}`);
  if (verdict?.issues?.length) parts.push(`问题：${verdict.issues.join("；")}`);
  return parts.length ? parts.join(" · ") : undefined;
}

/** plan_result 步骤 → PlanNodeState（重规划种子） */
export function planNodesFromOutcome(input: {
  subtasks: SubTask[];
  steps: Array<{
    id: string;
    passed: boolean;
    completion?: { summary?: string; artifacts?: string[] } | null;
    verdict?: { summary?: string; issues?: string[] } | null;
  }>;
  skipped: { id: string }[];
}): { nodes: PlanNodeState[]; handoffs: Record<string, string> } {
  const stepById = new Map(input.steps.map((s) => [s.id, s]));
  const skipped = new Set(input.skipped.map((s) => s.id));
  const handoffs: Record<string, string> = {};
  const nodes: PlanNodeState[] = input.subtasks.map((t) => {
    const st = stepById.get(t.id);
    let status: PlanNodeState["status"] = "pending";
    if (skipped.has(t.id)) status = "skipped";
    else if (st) status = st.passed ? "passed" : "failed";
    const evidenceParts: string[] = [];
    if (st?.completion?.summary) evidenceParts.push(st.completion.summary);
    if (st?.completion?.artifacts?.length) evidenceParts.push(`产物：${st.completion.artifacts.join("、")}`);
    if (st?.verdict?.summary) evidenceParts.push(`裁决：${st.verdict.summary}`);
    if (st?.verdict?.issues?.length) evidenceParts.push(`问题：${st.verdict.issues.join("；")}`);
    const evidenceSummary = evidenceParts.length ? evidenceParts.join(" · ") : undefined;
    if (st?.passed && st.completion?.summary) {
      handoffs[t.id] = st.completion.summary;
    } else if (st?.passed && evidenceSummary) {
      handoffs[t.id] = evidenceSummary;
    }
    return {
      id: t.id,
      title: t.title,
      pack: t.pack ?? null,
      description: t.description,
      acceptance: [...t.acceptance],
      dependsOn: [...t.dependsOn],
      ...(t.resources ? { resources: [...t.resources] } : {}),
      status,
      ...(evidenceSummary ? { evidenceSummary } : {}),
    };
  });
  return { nodes, handoffs };
}

/**
 * 崩溃档案按 ADR-003 表收成终态：不恢复 grant。
 * Phase 2：executing→interrupted 后，若有 checkpoint 可由 canSameRunResume
 * 在同 runId 续跑；本函数只负责相迁移，不执行续跑。
 * 返回应用后的 state（调用方落盘）；只读相原样返回。
 */
export function recoverDurableStateOnCrash(
  state: DurableRunState,
  at = Date.now(),
): DurableRunState {
  const action = recoveryActionForPhase(state.phase);
  if (action === "readonly" || action === "restore_gate") return state;
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
  // 检查点里的旧上限必须跟着档案走——重启宿主（甚至不再配 env）不能洗掉旧账。
  // 旧上限不再是死路：用尽后发送会自动续一段跑道（autoExtendIfExhausted）。
  const maxTurns = stricterLimit(checkpoint.runBudget.maxTurns, current.maxTotalTurns);
  const maxTokens = stricterLimit(checkpoint.runBudget.maxTokens, current.maxTokensBudget);
  return {
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    usedTurns: checkpoint.runBudget.usedTurns,
    usedTokens: checkpoint.runBudget.usedTokens,
  };
}

/**
 * 预算耗尽是会话唯一会被挡住的结构性原因，所以文案必须说清**哪个预算、怎么提**：
 * 只报"用尽"等于把人晾在那里。
 *
 * 2026-09-04：主路径改成「追加预算 / 同目录新开对话」——要求改 env 并重启宿主
 * 对长任务太狠（委托方截图：594k/500k 卡死、只能另起或重启）。env 名仍写出，
 * 但是作为**抬默认上限**的后手，不是当场续跑的唯一办法。
 */
export function exhaustedBudgetReason(budget: SharedRunBudget): string | null {
  if (budget.maxTurns !== undefined && budget.usedTurns >= budget.maxTurns) {
    return (
      `执行谱系的总轮次预算已用尽（${budget.usedTurns}/${budget.maxTurns}）。` +
      "已完成的写入不会回滚。要继续这场对话请点「追加预算」后再发指令；" +
      "或「新建对话」在同一工作目录开新会话（产物还在）。" +
      "若希望默认上限更高，设置 AGENT_TOTAL_MAX_TURNS 后重启宿主"
    );
  }
  if (budget.maxTokens !== undefined && budget.usedTokens >= budget.maxTokens) {
    return (
      `执行谱系的总 token 预算已用尽（${budget.usedTokens}/${budget.maxTokens}）。` +
      "已完成的写入不会回滚。要继续这场对话请点「追加预算」后再发指令；" +
      "或「新建对话」在同一工作目录开新会话（产物还在）。" +
      "若希望默认上限更高，设置 AGENT_TOTAL_TOKEN_BUDGET 后重启宿主"
    );
  }
  return null;
}

/**
 * 给执行谱系**当场**加一段跑道：新上限 = 已用量 + 追加量。
 * 这样无论当前 max 是否已被 used 超过，追加后一定解除 exhaustedBudgetReason。
 * 纯函数——服务端接线与单测共用。
 */
/**
 * 续跑时若谱系额度已尽，当场续一段跑道再放行——不要把「发下一条」变成
 * 先点「追加预算」的两步手续。日预算门仍是跨 run 总闸，这里只解会话卡死。
 */
export function autoExtendIfExhausted(
  budget: SharedRunBudget,
  defaults: { addTokens: number; addTurns: number },
): { budget: SharedRunBudget; extended: boolean } {
  const tokenOut = budget.maxTokens !== undefined && budget.usedTokens >= budget.maxTokens;
  const turnOut = budget.maxTurns !== undefined && budget.usedTurns >= budget.maxTurns;
  if (!tokenOut && !turnOut) return { budget, extended: false };
  return {
    budget: extendSharedRunBudget(budget, {
      ...(tokenOut ? { addTokens: defaults.addTokens } : {}),
      ...(turnOut ? { addTurns: defaults.addTurns } : {}),
    }),
    extended: true,
  };
}

export function extendSharedRunBudget(
  budget: SharedRunBudget,
  opts: { addTokens?: number; addTurns?: number },
): SharedRunBudget {
  const next: SharedRunBudget = {
    usedTurns: budget.usedTurns,
    usedTokens: budget.usedTokens,
    ...(budget.maxTurns !== undefined ? { maxTurns: budget.maxTurns } : {}),
    ...(budget.maxTokens !== undefined ? { maxTokens: budget.maxTokens } : {}),
  };
  const addTokens = opts.addTokens ?? 0;
  const addTurns = opts.addTurns ?? 0;
  if (addTokens > 0) {
    next.maxTokens = next.usedTokens + addTokens;
  }
  if (addTurns > 0) {
    next.maxTurns = next.usedTurns + addTurns;
  }
  return next;
}

interface PlanSummarySubtask {
  id: string;
  title?: string;
  pack?: string | null;
  description?: string;
}

interface PlanSummaryStep {
  id: string;
  title?: string;
  pack?: string | null;
  passed?: boolean;
  reworks?: number;
  stopReason?: string;
  completion?: { summary?: string; artifacts?: string[] } | null;
  verdict?: { passed?: boolean; summary?: string; issues?: string[] } | null;
}

/**
 * 计划编排的对话种子（会话中心化语义 B）。plan run 没有单一执行者正史可续——
 * 续的是**对话**，不是 DAG：下一轮以这份结构化摘要开局，按单执行者执行。
 * 只放事实（子任务 / 结局 / 交接摘要 / 裁决 / 未执行项），不替执行者下结论。
 * 纯函数：活 run 收尾时与归档重建时共用，两边看到的是同一份文本。
 */
export function buildPlanSummary(input: {
  task: string;
  stopReason?: string | undefined;
  subtasks: PlanSummarySubtask[];
  steps: PlanSummaryStep[];
  skipped: { id: string; title?: string }[];
  completed: boolean;
  plannerFailure?: string | undefined;
}): string {
  const byId = new Map(input.subtasks.map((s) => [s.id, s]));
  const lines: string[] = [
    `【本对话此前是一次计划编排】原任务：${input.task}`,
    `编排结局：${input.completed ? "全部子任务执行并通过核查" : "未全部完成"}` +
      (input.stopReason ? `（终止原因 ${input.stopReason}）` : ""),
  ];
  if (input.plannerFailure) lines.push(`拆解未产出可执行计划：${input.plannerFailure}`);
  if (input.steps.length > 0) {
    lines.push("已执行的子任务：");
    for (const st of input.steps) {
      const sub = byId.get(st.id);
      const title = st.title ?? sub?.title ?? "";
      const pack = st.pack ?? sub?.pack;
      const head =
        `- ${st.id}${title ? ` ${title}` : ""}${pack ? `（包 ${pack}）` : ""}：` +
        `${st.passed ? "核查通过" : "核查未通过"}` +
        `${st.reworks ? ` · 返工 ${st.reworks} 轮` : ""}` +
        `${st.stopReason ? ` · 执行终止 ${st.stopReason}` : ""}`;
      lines.push(head);
      if (st.completion?.summary) lines.push(`  交接摘要：${st.completion.summary}`);
      if (st.completion?.artifacts?.length) lines.push(`  产物：${st.completion.artifacts.join("、")}`);
      if (st.verdict?.summary) lines.push(`  裁决：${st.verdict.summary}`);
      if (st.verdict?.issues?.length) lines.push(`  裁决列出的问题：${st.verdict.issues.join("；")}`);
    }
  }
  if (input.skipped.length > 0) {
    lines.push(`未执行的子任务：${input.skipped.map((s) => `${s.id}${s.title ? ` ${s.title}` : ""}`).join("、")}`);
  }
  lines.push(
    "从本轮起你以单一执行者继续这场对话；上述子任务的产物就在工作目录里，请据实核对后再动手，不要凭摘要臆断。",
  );
  return lines.join("\n");
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
/** 档案投影与 CLI 共用（delta 不占 seq；done 不带正史）。 */
function serializeEvent(
  _source: string,
  event: TurnEvent,
  segmentIndex: number,
): Record<string, unknown> {
  return serializeTurnEventForArchive(_source, event, segmentIndex);
}

/**
 * 信息队列的崩溃恢复重建：message_queued(mode:"queue") 追加、
 * message_queue_updated 整表替换（含自动续跑成功后的清空）——重放结束的
 * pending 就是崩溃那一刻仍排队的消息。steer 已注入正史的不可撤，不在此重建。
 */
export function rebuildMessageQueue(events: ReadonlyArray<{ event: unknown }>): string[] {
  const pending: string[] = [];
  for (const e of events) {
    const ev = e.event as { type?: string; mode?: string; text?: unknown; pending?: unknown } | undefined;
    if (ev?.type === "message_queued" && ev.mode === "queue" && typeof ev.text === "string") {
      pending.push(ev.text);
    } else if (ev?.type === "message_queue_updated" && Array.isArray(ev.pending)) {
      pending.length = 0;
      pending.push(...ev.pending.map(String));
    }
  }
  return pending;
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
 * 整站预览 MIME：`.js` 必须是可执行脚本类型，不能走 contentTypeOf 的 text/plain。
 * 仅用于 `/site/*`；单文件 artifact 预览仍用 contentTypeOf（禁脚本 CSP）。
 */
export function siteContentTypeOf(name: string): string {
  const ext = extname(name).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    return "text/javascript; charset=utf-8";
  }
  if (ext === ".wasm") return "application/wasm";
  if (CONTENT_TYPES[ext]) return CONTENT_TYPES[ext]!;
  if (/\.(map)$/i.test(name)) return "application/json; charset=utf-8";
  return contentTypeOf(name);
}

/** 整站预览 CSP：允许同源脚本/样式/资源；仍禁外链与 form。配合 iframe 无 allow-same-origin。 */
export const SITE_PREVIEW_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");

/**
 * 把 workdir 相对路径编成整站预览 URL（路径段编码，相对引用才能解析）。
 * `demos/a/index.html` → `/api/runs/<id>/site/demos/a/index.html`
 */
export function sitePreviewUrl(runId: string, relativePath: string): string {
  const normalized = String(relativePath ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
  if (!normalized) throw new Error("site preview path is empty");
  const segments = normalized.split("/").map((seg) => encodeURIComponent(seg)).join("/");
  return `/api/runs/${encodeURIComponent(runId)}/site/${segments}`;
}

/** 解码 `/site/` 后的路径段；拒绝空段与 `.`/`..`（圈禁前先挡一层）。 */
export function decodeSitePreviewPath(encodedPath: string): string {
  const raw = String(encodedPath ?? "").replace(/^\/+/, "");
  if (!raw) throw new Error("site preview path is empty");
  const parts = raw.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      throw new Error("site preview path is not valid URI encoding");
    }
    if (decoded === "." || decoded === ".." || decoded.includes("\0") || /[\\/]/.test(decoded)) {
      throw new Error("site preview path contains illegal segment");
    }
    out.push(decoded);
  }
  if (out.length === 0) throw new Error("site preview path is empty");
  return out.join("/");
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

const WORKDIR_WALK_SKIP = new Set(["node_modules", ".git", ".agent-run-history"]);

/**
 * 裸文件名在工作目录里唯一时，把它解析成相对路径。
 * 两处同名就不猜——猜错比标「未找到」更糟。
 */
export async function findUniqueWorkdirFile(
  root: string,
  basename: string,
  opts: { maxDepth?: number; maxVisits?: number } = {},
): Promise<string | null> {
  const name = String(basename ?? "").trim();
  if (!name || /[\\/]/.test(name) || name === "." || name === ".." || name.includes("\0")) return null;
  const maxDepth = opts.maxDepth ?? 8;
  const maxVisits = opts.maxVisits ?? 4000;
  const rootAbs = resolve(root);
  const hits: string[] = [];
  let visits = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (hits.length > 1 || visits >= maxVisits || depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (hits.length > 1 || visits >= maxVisits) return;
      visits += 1;
      if (ent.name === "." || ent.name === "..") continue;
      const next = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (WORKDIR_WALK_SKIP.has(ent.name)) continue;
        await walk(next, depth + 1);
        continue;
      }
      if (!ent.isFile() && !ent.isSymbolicLink()) continue;
      if (ent.name !== name) continue;
      const rel = relative(rootAbs, next).split(sep).join("/");
      if (!rel || rel.startsWith("..")) continue;
      hits.push(rel);
    }
  };

  await walk(rootAbs, 0);
  return hits.length === 1 ? hits[0]! : null;
}

const BUILTIN_POOL: Tool[] = [
  bashTool,
  fetchUrlTool,
  readFileTool,
  writeFileTool,
  writePptxTool,
  editFileTool,
  globTool,
  grepTool,
  updateProgressTool,
];

/** 上传落点：工作目录下的固定子目录，便于人和 agent 都一眼知道东西在哪 */
const UPLOAD_SUBDIR = "uploads";
const UPLOAD_MAX_BYTES = 20_000_000;
/** 文件预览取件上限：超出直接 413——预览不是下载通道，超大文件走「在文件夹中显示」 */
const FILE_PREVIEW_MAX_BYTES = 10_000_000;
const DEFAULT_SYSTEM_PROMPT = `You are a capable assistant in a local working directory.
If the user is just talking, talk back in their language. If they asked you to do work, complete it with the available tools and ground claims of progress in tool results.

You have a persistent memory that survives across sessions. The current memory index is provided in the <context> block of the first message and is scoped to this project (plus global lessons). When starting a task, or when a memory is likely relevant, consult it with memory_read. When you learn a durable fact, user preference, or lesson worth reusing — a correction you received, a project constant, an approach that worked — save it with memory_write (one fact per file, first line = summary). Update or delete memories that turn out to be wrong. Do not store transient task state in memory_write; use project_status for the in-progress board (who is waiting, next gate, open decisions). Do not store things already recorded in the repository.` + DEFAULT_HOST_DISCIPLINES;

// ------------------------------------------------------
// Server factory
// ------------------------------------------------------

export function createUiServer(options: UiServerOptions = {}): UiServerHandle {
  const realHost = options.modelClient === undefined;
  const packsRoot = options.packsDir === null
    ? null
    : typeof options.packsDir === "string"
      ? options.packsDir
      : realHost
        ? packsRootFromEnv()
        : null;
  if (packsRoot) loadInstalledFilePacksSync(packsRoot);
  else clearFilePacks();
  let pack = options.packName ? getPack(options.packName) : undefined;
  const packsReady = Promise.resolve();
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
  const crashAfterToolPrepared = options.crashAfterToolPrepared;

  /**
   * 可选装备（角色模型 / 降级链 / 能力探针）的 env 来源。真实宿主读 process.env；
   * 注入了 modelClient 的宿主缺省读空 env——见 UiServerOptions.roleEnv 的仪器纪律。
   * 台账、历史落盘、日预算门都按同一条纪律缺省关闭，这里补齐的是模型装配这一面。
   */
  const armamentEnv: NodeJS.ProcessEnv = realHost ? process.env : {};
  /**
   * hooks 只武装真实宿主。测试宿主读空 env——残留 AGENT_HOOKS_CONFIG 不得把假模型跑偏。
   * 设了但文件缺失 / JSON 非法：fail-closed，启动即抛（与 AGENT_CONTEXT_WINDOW 同款）。
   */
  const hookSpec: NormalizedHookSpec | null = resolveHooksFromEnv(armamentEnv);
  const agentMdMaxChars = resolveAgentMdMaxChars(armamentEnv);

  function agentMdForRun(run?: StoredRun): AgentMdBundle | null {
    return loadAgentMd({
      workdir: run?.workdir ?? workdir,
      userHome: realHost ? homedir() : null,
      extraDirs: run?.extraWorkdirs,
      maxChars: agentMdMaxChars,
      ...(realHost ? { onWarn: (message) => console.warn(message) } : {}),
    });
  }
  const fallbackEnv = options.fallbackEnv ?? armamentEnv;
  const roleEnv = options.roleEnv ?? armamentEnv;
  const routingPolicy: FallbackRouting = readFallbackEnv(fallbackEnv).routing;

  /**
   * MODEL-02 模型库（默认 <workdir>/.agent-models.json）。生效优先级：运行时库 > env——
   * 库文件在且 executor 有效就以库为准；否则把 env 现状合成一份初始库
   * （AGENT_MODEL 与 AGENT_<ROLE>_* 都经 synthesizeStoreFromEnv 桥接，语义与旧
   * resolveRole 逐条一致）。注入 modelClient 的宿主默认不落盘（modelStoreFile=null），
   * 仪器纪律同 roleEnv：假模型宿主不该被开发机残留的库文件武装。
   */
  const modelStoreFile = options.modelStoreFile !== undefined
    ? options.modelStoreFile
    : realHost
      ? join(resolve(options.workdir ?? process.cwd()), MODEL_STORE_FILENAME)
      : null;
  const envFile = options.envFile !== undefined
    ? options.envFile
    : realHost
      ? join(process.cwd(), ".env")
      : null;
  let modelStoreState: { store: ModelStore; source: "store" | "env" } = (() => {
    if (modelStoreFile) {
      const loaded = loadModelStore(modelStoreFile);
      if (loaded.store?.roles.executor) {
        if (loaded.recoveredFromCorrupt) {
          operationalLog("warn", "model_store_recovered", { file: modelStoreFile });
        }
        return { store: loaded.store, source: "store" as const };
      }
    }
    return { store: synthesizeStoreFromEnv(process.env, roleEnv), source: "env" as const };
  })();

  // MODEL-01b：Web 启动保持同步装配（createUiServer 契约）；compat 仍可名称猜测，
  // 粘性探针在下方异步填充供 prefer_healthy；探针结果若与名称猜不一致则重装配
  // （进行中的 run 手持旧 client 引用——与 MODEL-02 PUT /api/models 同款）。
  let executorCapabilities: EndpointCapabilities | null = null;
  /** 识图探针结果；未探 / fail-open 时 null（工具仍按"配了就注册"） */
  let visionProbe: { supportsVision: boolean; reason?: string } | null = null;
  /**
   * 端点降级链（MODEL-01a/b）。执行者 AGENT_FALLBACK_*；角色可 own / inherit。
   * 熔断按端点身份经 sharedBreakerRegistry 共享；装饰器实例按角色隔离。
   *
   * 归属靠 AsyncLocalStorage：换端点发生在 FallbackModelClient.send 内部，
   * 宿主允许多 run 并发，单个可变"当前 run"引用会记错账。
   */
  const fallbackSink = new AsyncLocalStorage<(info: FallbackInfo) => void>();
  const onFallback = (info: FallbackInfo) => fallbackSink.getStore()?.(info);

  /**
   * 执行者当前装配（MODEL-02 可重入）。PUT /api/models 成功后 assembleExecutor
   * 重建本组变量；进行中的 run 手持旧 client 引用继续跑完——配置只对新任务生效。
   * 注入了 modelClient 的宿主锁定执行者（假模型的语义由注入方掌控，不被库改写）。
   *
   * 执行者端点身份（provider|model|origin，不含 key）：降级链熔断、探针粘性、
   * 学到的上下文窗口都按它做键。
   *
   * `probedCompat`：异步探针回写用。名称猜错时（claude 别名挂 compat 端点等）
   * 用探针结果重建 client；不传则仍名称猜。
   */
  let executorModelName = "";
  let resolved!: ResolvedProvider;
  let executorIdentity!: EndpointIdentity;
  let fallbackChain: string[] | null = null;
  let executorBackups: FallbackEndpoint[] = [];
  let modelClient!: ModelClient;
  let envCompat = true;

  function assembleExecutor(entry: ModelEntry | null, probedCompat?: boolean): void {
    executorModelName = entry?.model ?? process.env.AGENT_MODEL ?? "claude-opus-4-8";
    const compatOverride =
      probedCompat !== undefined ? { compat: probedCompat } : {};
    resolved = entry
      ? createModelClientFromEnv(entry.model, {
          provider: entry.provider,
          ...(entry.baseUrl ? { baseURL: entry.baseUrl } : {}),
          ...(entry.apiKey ? { apiKey: entry.apiKey } : {}),
          ...compatOverride,
        })
      : createModelClientFromEnv(executorModelName, compatOverride);
    envCompat = resolved.compat;
    const envBaseURL = process.env.ANTHROPIC_BASE_URL || process.env.OPENAI_BASE_URL
      ? resolved.provider === "openai"
        ? process.env.OPENAI_BASE_URL
        : process.env.ANTHROPIC_BASE_URL
      : undefined;
    const identityBaseURL = entry?.baseUrl || envBaseURL;
    executorIdentity = {
      provider: resolved.provider,
      model: executorModelName,
      ...(identityBaseURL ? { baseURL: identityBaseURL } : {}),
    };
    const fallbackClient = createFallbackClientIfConfigured(
      {
        name: executorModelName,
        client: options.modelClient ?? resolved.client,
        identity: executorIdentity,
      },
      fallbackEnv,
      onFallback,
      { role: "executor", breakerRegistry: sharedBreakerRegistry },
    );
    fallbackChain = fallbackClient instanceof FallbackModelClient ? fallbackClient.chain() : null;
    executorBackups = executorBackupEndpoints(fallbackClient);
    // 日账本逐调用实时计量（评审 b62f6a5：段粒度落账让预算门的 TOCTOU 窗口有
    // 整段宽——最坏 4 条 lineage 在账本过线前全部准入；跨午夜大段还会整段挤占
    // 新日额度）。metrics.tokens 的 role 记账仍走事件路径（每段独立 usage、归属
    // 清晰），这层只喂日账本——两本账职责分开，互不双计。
    // 计量包在降级之**外**：哪个端点应答的都要计进日额度，账本关心的是花了多少钱。
    // OBS-02 的延迟仪表再包一层，位置同理：TTFT 要量的是**委托方等了多久**，
    // 中途换了端点也照样算在这一次调用头上。
    modelClient = instrumentModelClient(
      meterModelClient(fallbackClient, (u) => bumpDaily(u)),
      { role: "execution", model: executorModelName },
    );
  }
  assembleExecutor(roleEntryOf(modelStoreState.store, "executor"));

  /** 异步粘性探针（不挡 createUiServer）：填充 prefer_healthy 用的健康位；compat 不一致则重装配。 */
  function probeExecutorEndpoint(entry: ModelEntry | null): void {
    if (options.modelClient) return;
    const envApiKey = resolved.provider === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
    const apiKey = entry?.apiKey || envApiKey;
    void probeEndpointCapabilities({
      identity: executorIdentity,
      ...(apiKey ? { apiKey } : {}),
      env: fallbackEnv,
    })
      .then((caps) => {
        executorCapabilities = caps;
        // MODEL-01 残余：探针学到的 compat 与启动名称猜不一致 → 重装执行者 client。
        // 进行中的 run 仍握着旧引用（同 MODEL-02）；只影响此后新任务。
        if (caps.compat !== envCompat) {
          assembleExecutor(entry, caps.compat);
          // 执行者备用端点对象换了，inherit 角色要跟着重建
          assembleRoles();
        }
      })
      .catch(() => {
        /* 探针失败不影响宿主启动——fail-open */
      });
  }
  probeExecutorEndpoint(roleEntryOf(modelStoreState.store, "executor"));
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
  // 保留数同一条纪律：注入宿主不读 AGENT_RUN_HISTORY_KEEP（残留的 "1" 会让测试里第二个
  // 档案刚落盘就被剪掉）；历史根本就只在真实宿主读 AGENT_RUN_HISTORY_DIR（上一行）
  const historyKeep = options.historyKeep ?? (realHost ? historyKeepCount() : DEFAULT_HISTORY_KEEP);
  /**
   * 端点能力缓存（学到的上下文窗口）落点。同一条仪器纪律：注入 modelClient 的宿主缺省只在
   * 进程内记（假模型撞出来的"窗口"不该写进真缓存）；真实宿主落 <cwd>/.agent-capabilities.json
   * （AGENT_CAPABILITY_CACHE 可改）。跨 run 同进程的学习不依赖落盘——内存表就够。
   */
  const capabilityCacheFile: string | null =
    options.capabilityCache === false
      ? null
      : typeof options.capabilityCache === "string"
        ? resolve(options.capabilityCache)
        : options.modelClient
          ? null
          : capabilityStorePath();
  configureCapabilityStore({ file: capabilityCacheFile });
  const maxStoredRuns = positiveInteger(options.maxStoredRuns, "maxStoredRuns")
    ?? positiveIntegerEnv("AGENT_UI_MAX_STORED_RUNS")
    ?? (realHost ? Math.max(100, historyKeep) : Number.MAX_SAFE_INTEGER);
  // envCompat 已由 assembleExecutor 维护（MODEL-02：随执行者重装配更新）
  // 在源头就归一：workdir 参与白名单比对、侧栏分组键、工具圈禁根三处，
  // 三处必须是同一个字符串形态。`D:/a/b` 与 `D:` 指同一个目录，
  // 但字符串不等——不在源头 resolve 的话，默认路径会过不了自己的白名单
  const workdir = resolve(options.workdir ?? process.cwd());
  const designDraftsDir = resolve(
    options.designDraftsDir
      ?? (realHost ? resolveDesignDraftsDir(process.env, homedir()) : join(workdir, "Fathom-drafts")),
  );
  const hostWorkdirIsHarness = (() => {
    try {
      return isHarnessPackageName(packageNameFromJson(readFileSync(join(workdir, "package.json"), "utf8")));
    } catch {
      return false;
    }
  })();
  /**
   * design 模板目录：真实宿主 / 未显式关闭时探测仓库 templates/design。
   * 注入测试可传绝对路径或 null。
   */
  const designTemplatesDir =
    options.designTemplatesDir === null
      ? null
      : typeof options.designTemplatesDir === "string"
        ? resolve(options.designTemplatesDir)
        : (() => {
            for (const candidate of [join(__dirname, ".."), join(__dirname, "..", "..")]) {
              const root = designTemplatesRootFromRepo(candidate);
              if (existsSync(root)) return root;
            }
            return null;
          })();
  const capturePngFrames: PngCaptureFn =
    options.capturePngFrames
    ?? (realHost ? capturePngFramesWithPlaywright : fixturePngCapture);
  /**
   * V-29 白名单的活集合。env 声明（宿主 workdir + options.workdirs）与运行时
   * 添加（本机 UI 显式加入，持久化在 .agent-workdirs.json）分两本账——删除
   * 只允许动运行时那本，env 那本归宿主启动纪律管。两个 Set 都是 resolve
   * 归一化口径；`allowedWorkdirs` 是它们的并集视图，所有校验点只读它。
   */
  const workdirStoreFile = options.workdirStoreFile !== undefined
    ? options.workdirStoreFile
    : realHost
      ? join(workdir, WORKDIRS_FILENAME)
      : null;
  const envWorkdirs = new Set([workdir, ...(options.workdirs ?? [])].map((d) => resolve(d)));
  const runtimeWorkdirs = new Set<string>();
  if (workdirStoreFile) {
    const loaded = loadWorkdirStore(workdirStoreFile);
    if (loaded.recoveredFromCorrupt) {
      operationalLog("warn", "workdir_store_recovered", { file: workdirStoreFile });
    }
    for (const d of loaded.store?.workdirs ?? []) runtimeWorkdirs.add(d);
  }
  const allowedWorkdirs = new Set<string>([...envWorkdirs, ...runtimeWorkdirs]);

  /** 运行时清单落盘（原子写）。workdirStoreFile 为 null 的注入宿主是 no-op。 */
  function persistRuntimeWorkdirs(): void {
    if (!workdirStoreFile) return;
    saveWorkdirStore(workdirStoreFile, {
      schemaVersion: WORKDIRS_SCHEMA_VERSION,
      workdirs: [...runtimeWorkdirs],
    });
  }

  /** 在飞 run（status === "running"）有没有正用着这个目录——删除保护用。 */
  function workdirInFlight(target: string): boolean {
    for (const r of runs.values()) {
      if (r.status === "running" && resolve(r.workdir ?? workdir) === target) return true;
    }
    return false;
  }
  const memoryHost = createWorkdirScopedMemoryTools(
    (runWorkdir) => resolveMemoryDir(runWorkdir),
  );
  const memoryTools = [
    ...memoryHost.tools,
    createProjectStatusTool(
      (runWorkdir) => new MemoryStore(resolveMemoryDir(runWorkdir)),
      { sharedFor: (runWorkdir) => isSharedMemoryDir(runWorkdir, resolveMemoryDir(runWorkdir)) },
    ),
  ];
  const defaultMemoryDir = resolveMemoryDir(workdir);
  /**
   * T5 记忆面板的数据源：与 /api/harness 的 memory.dir 同一个目录（默认 workdir
   * 作用域，AGENT_MEMORY_DIR 可覆盖）。只读——面板起步不提供编辑/删除。
   */
  const defaultMemoryStore = new MemoryStore(defaultMemoryDir);
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
  const injectedTools = options.tools;

  /**
   * V-30 角色模型（MODEL-02 起由模型库驱动）：verifier / planner / vision / image 各自
   * 可指向库中任意条目；roles 里 null = 跟随执行（vision / image 的 null = 不配置）。
   *
   * 密钥只在服务端解析，**绝不下发浏览器**——快照里只报模型名与 provider。
   * 浏览器能做的是"这次用不用独立角色模型"，不是"用哪个 key 连哪个端点"。
   *
   * 值得配的依据是实测而非直觉：D2 —— 强 verifier 的确定优势是核查效率
   * （约 1/3 成本）。反过来 B3 已经证伪了"更强 planner 能稳住拆分摇摆"，
   * 所以 planner 这一路留给实验，界面不该暗示它更好。
   *
   * 整组变量由 assembleRoles 重建（PUT /api/models 触发）；进行中的 run 手持
   * 旧 client 引用继续跑完——配置只对新任务生效。
   */
  interface ResolvedRole {
    name: string;
    provider: ResolvedProvider;
    baseURL?: string;
  }
  let verifierRole: ResolvedRole | null = null;
  let plannerRole: ResolvedRole | null = null;
  let visionRole: ResolvedRole | null = null;
  let imageRole: { name: string; provider: "anthropic" | "openai" } | null = null;
  let verifierClient: ModelClient | null = null;
  let plannerClient: ModelClient | null = null;
  let visionClient: ModelClient | null = null;
  let visionTool: Tool | null = null;
  let imageTool: Tool | null = null;

  /** 降级链的角色名 → 指标口径的角色名（verifier 与 verification 是同一个东西） */
  const METRIC_ROLE_OF: Record<"verifier" | "planner" | "vision", MetricRole> = {
    verifier: "verification",
    planner: "planner",
    vision: "vision",
  };

  function wrapRoleClient(
    role: "verifier" | "planner" | "vision",
    resolvedRole: ResolvedRole,
    baseURL: string | undefined,
  ): ModelClient {
    return instrumentModelClient(
      createRoleFallbackClient({
        role,
        primary: {
          name: resolvedRole.name,
          client: resolvedRole.provider.client,
          identity: {
            provider: resolvedRole.provider.provider,
            model: resolvedRole.name,
            ...(baseURL ? { baseURL } : {}),
          },
        },
        env: fallbackEnv,
        executorFallbacks: executorBackups,
        onFallback,
        breakerRegistry: sharedBreakerRegistry,
      }),
      { role: METRIC_ROLE_OF[role], model: resolvedRole.name },
    );
  }

  /**
   * 库条目 → 角色解析。env 底座已在启动时合成进库（source="env" 时条目即
   * env 现状的镜像），所以这里只看库，不再单独读 AGENT_<ROLE>_*。
   */
  function resolveRoleFromLibrary(role: "verifier" | "planner" | "vision"): ResolvedRole | null {
    const entry = roleEntryOf(modelStoreState.store, role);
    if (!entry) return null;
    return {
      name: entry.model,
      provider: createModelClientFromEnv(entry.model, {
        provider: entry.provider,
        ...(entry.baseUrl ? { baseURL: entry.baseUrl } : {}),
        ...(entry.apiKey ? { apiKey: entry.apiKey } : {}),
      }),
      ...(entry.baseUrl ? { baseURL: entry.baseUrl } : {}),
    };
  }

  const webSearchTool = isWebSearchConfigured() ? createWebSearchTool() : null;
  const draftPackTool = packsRoot ? draftDomainPackTool(packsRoot) : null;
  const enabledBuiltinPool = [
    ...(bashEnabled ? BUILTIN_POOL : BUILTIN_POOL.filter((tool) => tool.name !== bashTool.name)),
    ...(draftPackTool ? [draftPackTool] : []),
  ];
  /** 工具面随角色装配重建：vision 配了才有 describe_image；image 配了才有 generate_image */
  let toolPool: Tool[] = [];

  function resolveImageRoleFromLibrary(): {
    name: string;
    provider: "anthropic" | "openai";
    baseURL: string;
    apiKey: string;
  } | null {
    const entry = roleEntryOf(modelStoreState.store, "image");
    if (!entry) return null;
    const baseURL = (
      entry.baseUrl
      || process.env.AGENT_IMAGE_BASE_URL
      || (entry.provider === "openai" ? process.env.OPENAI_BASE_URL : undefined)
      || DEFAULT_OPENAI_IMAGE_BASE
    ).replace(/\/+$/, "");
    const apiKey = entry.apiKey
      || process.env.AGENT_IMAGE_API_KEY
      || (entry.provider === "openai" ? process.env.OPENAI_API_KEY ?? "" : "");
    return { name: entry.model, provider: entry.provider, baseURL, apiKey };
  }

  function assembleRoles(): void {
    verifierRole = resolveRoleFromLibrary("verifier");
    plannerRole = resolveRoleFromLibrary("planner");
    visionRole = resolveRoleFromLibrary("vision");
    verifierClient = verifierRole ? wrapRoleClient("verifier", verifierRole, verifierRole.baseURL) : null;
    plannerClient = plannerRole ? wrapRoleClient("planner", plannerRole, plannerRole.baseURL) : null;
    visionClient = visionRole ? wrapRoleClient("vision", visionRole, visionRole.baseURL) : null;

    /**
     * OBS-02 首抓盲区：被告警引用的直方图必须在开机时就有 0 值序列，否则
     * `histogram_quantile(rate(...))` 在第一次观测之前匹配不到任何向量，
     * 而第一次观测又以非零值出生——那一段增量永远看不见（5xx 序列同一条结论）。
     * 只铺**这台宿主真的装配了**的角色，不铺笛卡尔积。重装配时增量登记新角色即可。
     */
    preregisterObservability([
      { role: "execution" as const, model: executorModelName },
      ...(verifierRole ? [{ role: "verification" as const, model: verifierRole.name }] : []),
      ...(plannerRole ? [{ role: "planner" as const, model: plannerRole.name }] : []),
      ...(visionRole ? [{ role: "vision" as const, model: visionRole.name }] : []),
    ]);

    visionTool = visionRole && visionClient && visionProbe?.supportsVision !== false
      ? createDescribeImageTool({
          // 计量包裹：视觉调用不经 done/verification 记账路径，只能在客户端边界抓。
          // 视觉是独立 client（不在主 modelClient 的日账包裹之内），日账本也在这里喂
          client: meterModelClient(visionClient, (u) => {
            growTokens("vision", u);
            bumpDaily(u);
          }),
          modelName: visionRole.name,
        })
      : null;
    // 生图不走 ModelClient / 降级链 / token 计量——Images API 不是 chat usage。
    const imageResolved = resolveImageRoleFromLibrary();
    imageRole = imageResolved
      ? { name: imageResolved.name, provider: imageResolved.provider }
      : null;
    imageTool = imageResolved
      ? createGenerateImageTool({
          client: createOpenAIImageClient({
            model: imageResolved.name,
            baseURL: imageResolved.baseURL,
            apiKey: imageResolved.apiKey,
          }),
          modelName: imageResolved.name,
        })
      : null;
    toolPool = [
      ...enabledBuiltinPool,
      ...(webSearchTool ? [webSearchTool] : []),
      ...(visionTool ? [visionTool] : []),
      ...(imageTool ? [imageTool] : []),
    ];
  }
  assembleRoles();

  /**
   * 识图探针（MODEL-01 残余）：AGENT_MODEL_PROBE=1 时对 vision 端点塞一张最小图。
   * supportsVision=false → 卸掉 describe_image（与"没配视觉就不注册"同纪律）；
   * 未开探针 / 判不清 → fail-open 保留工具。
   */
  function probeVisionEndpoint(): void {
    if (options.modelClient || !visionRole) return;
    if (!shouldRunModelProbe(fallbackEnv)) return;
    const entry = roleEntryOf(modelStoreState.store, "vision");
    const envApiKey =
      visionRole.provider.provider === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
    const apiKey = entry?.apiKey || envApiKey;
    void probeVisionSupport({
      identity: {
        provider: visionRole.provider.provider,
        model: visionRole.name,
        ...(visionRole.baseURL ? { baseURL: visionRole.baseURL } : {}),
      },
      ...(apiKey ? { apiKey } : {}),
      env: fallbackEnv,
    })
      .then((result) => {
        visionProbe = { supportsVision: result.supportsVision, ...(result.reason ? { reason: result.reason } : {}) };
        if (result.supportsVision === false) {
          // 卸工具即可；roleModels 仍报 configured（配了但端点不会看图）——
          // 装配条读 tools 列表比读 configured 更诚实，见 deriveAssemblyBar。
          visionTool = null;
          toolPool = [
            ...enabledBuiltinPool,
            ...(webSearchTool ? [webSearchTool] : []),
            ...(imageTool ? [imageTool] : []),
          ];
        }
      })
      .catch(() => {
        /* fail-open：探针失败不卸工具 */
      });
  }
  probeVisionEndpoint();

  /**
   * 降级链快照全部现算（MODEL-02：PUT /api/models 后旧常量会撒谎）。
   * 未配置时 **null 而不是空数组**："没有这条防线"与"链上零个备用端点"
   * 在界面上必须能分开。只报名字——链上第二家的 baseURL / key 绝不下发。
   */
  function roleFallbackChainsView(): {
    executor: string[] | null;
    verifier: string[] | null;
    planner: string[] | null;
    vision: string[] | null;
  } {
    return {
      executor: fallbackChain,
      verifier: verifierClient instanceof FallbackModelClient ? verifierClient.chain() : null,
      planner: plannerClient instanceof FallbackModelClient ? plannerClient.chain() : null,
      vision: visionClient instanceof FallbackModelClient ? visionClient.chain() : null,
    };
  }
  function anyRoleFallbackNow(): boolean {
    const chains = roleFallbackChainsView();
    return Boolean(chains.verifier || chains.planner || chains.vision);
  }
  /** 有任一角色链时 scope=roles；仅执行者 = executor；未配 = null */
  function fallbackScopeNow(): "roles" | "executor" | null {
    return fallbackChain || anyRoleFallbackNow()
      ? anyRoleFallbackNow()
        ? "roles"
        : "executor"
      : null;
  }

  /**
   * 链健康只读面（MODEL-01 残余）：粘性探针 + 熔断状态。
   * **不改路由语义**——界面看得见，调度仍按 AGENT_FALLBACK_ROUTING。
   */
  function endpointHealthView(): Array<{
    model: string;
    healthy: boolean;
    circuit: CircuitState;
    latencyMs?: number;
    reason?: string;
  }> {
    const seen = new Set<string>();
    const rows: Array<{
      model: string;
      healthy: boolean;
      circuit: CircuitState;
      latencyMs?: number;
      reason?: string;
    }> = [];
    const pushEp = (name: string, identity: EndpointIdentity) => {
      const key = endpointIdentityKey(identity);
      if (seen.has(key)) return;
      seen.add(key);
      const sticky = getStickyCapabilities(key);
      const circuit = sharedBreakerRegistry.state(key) ?? "closed";
      const healthy = sticky ? sticky.healthy : true;
      rows.push({
        model: name,
        healthy,
        circuit,
        ...(sticky?.latencyMs != null ? { latencyMs: sticky.latencyMs } : {}),
        ...(sticky?.reason ? { reason: sticky.reason } : !sticky ? { reason: "unprobed" } : {}),
      });
    };
    pushEp(executorModelName, executorIdentity);
    for (const ep of executorBackups) {
      pushEp(ep.name, ep.identity ?? { provider: "anthropic", model: ep.name });
    }
    // 角色自有链的 primary（inherit 的备用已在 executorBackups）
    for (const role of [
      { client: verifierClient, resolved: verifierRole },
      { client: plannerClient, resolved: plannerRole },
      { client: visionClient, resolved: visionRole },
    ] as const) {
      if (!role.resolved) continue;
      const identity: EndpointIdentity = {
        provider: role.resolved.provider.provider,
        model: role.resolved.name,
        ...(role.resolved.baseURL ? { baseURL: role.resolved.baseURL } : {}),
      };
      pushEp(role.resolved.name, identity);
    }
    return rows;
  }

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

  /**
   * OBS-02 单价表。读不到 / 格式坏 → **整体停用折算**（cost 一律 null，界面写
   * "单价未登记"），而不是静默退回内置表：运维改了价却没生效，记出来的每一笔
   * 都是错的，比没有数字危险得多。也不因此拒绝启动——观测装置不该掐掉被观测对象。
   */
  let priceTableError: string | null = null;
  let priceTable: PriceTable | null = null;
  try {
    priceTable = loadPriceTable(process.env, (p) => readFileSync(p, "utf8"));
  } catch (error) {
    priceTableError = (error as Error).message;
    if (realHost) operationalLog("error", "price_table_load_failed", { error: priceTableError });
  }

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

  /**
   * OBS-02：角色 → 这次运行**实际用的**模型与 wire 协议。
   * 没配独立角色模型时该角色就跑在执行者客户端上——报执行者的模型才是实话
   * （同 run_config 报"本 run 实际用了什么"而不是"配了什么"的口径）。
   */
  function endpointOfRole(role: (typeof TOKEN_ROLES)[number]): { model: string; provider: string } {
    const executor = { model: executorModelName, provider: resolved.provider as string };
    if (role === "verification") {
      return verifierRole
        ? { model: verifierRole.name, provider: verifierRole.provider.provider }
        : executor;
    }
    if (role === "planner") {
      return plannerRole ? { model: plannerRole.name, provider: plannerRole.provider.provider } : executor;
    }
    if (role === "vision") {
      return visionRole ? { model: visionRole.name, provider: visionRole.provider.provider } : executor;
    }
    return executor;
  }

  /** token 计数累加（AggregateUsage → role 四档）。全部记账路径共用这一个入口 */
  function growTokens(
    role: (typeof TOKEN_ROLES)[number],
    u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number },
    run?: StoredRun,
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

    // OBS-02 成本归属：与 token 走同一个入口，两条曲线口径天然一致。
    // 单价未登记的量走另一条计数器——**绝不按 0 计入成本曲线**。
    const { model, provider } = endpointOfRole(role);
    const cost = computeCost(u, lookupModelPrice(priceTable, provider, model));
    if (cost.usd !== null) {
      costUsdTotal.inc({ role, provider, model }, cost.usd);
    } else if (cost.unpricedTokens > 0) {
      costUnpricedTokensTotal.inc({ role, provider, model }, cost.unpricedTokens);
    }
    if (run) {
      const tally = (run.costParts ??= []);
      tally.push({ role, cost });
    }
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

  function rememberFileRewindSnapshot(
    run: StoredRun,
    record: FileRewindRecord,
    blob?: Buffer,
  ): void {
    (run.fileRewindSnapshots ??= []).push(record);
    if (blob) (run.fileRewindBlobs ??= new Map()).set(record.toolUseId, blob);
    const archiveDir = run.archiveWriter?.dir ?? run.archiveDir;
    if (archiveDir) {
      const persist = () => persistRewindSnapshot(archiveDir, record, blob);
      if (run.archiveWriter) run.archiveWriter.schedule(persist);
      else void persist();
    }
    pushSyntheticEvent(run, "host", {
      type: "file_rewind_snapshot",
      toolUseId: record.toolUseId,
      tool: record.tool,
      path: record.path,
      existed: record.existed,
      bytes: record.bytes,
      ...(record.skipped ? { skipped: record.skipped } : {}),
      at: record.at,
    });
  }

  async function ensureFileRewindSnapshots(run: StoredRun): Promise<void> {
    if (run.fileRewindSnapshots?.length) return;
    const dir = run.archiveWriter?.dir ?? run.archiveDir;
    if (!dir) return;
    const loaded = await loadRewindSnapshots(dir);
    if (!loaded.records.length) return;
    run.fileRewindSnapshots = loaded.records;
    run.fileRewindBlobs = loaded.blobs;
  }

  // ---- B2 运行历史落盘 ----

  /** run → meta.json 的形状。创建 / 追加轮开始 / 收尾各整写一次 */
  function persistMeta(run: StoredRun): void {
    if (!run.archiveWriter) return;
    const meta: ArchivedMeta = {
      version: 1,
      runId: run.id,
      task: run.task,
      ...(run.title ? { title: run.title } : {}),
      status: run.status,
      verify: run.verify,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt ?? null,
      packName: run.packName ?? pack?.name ?? null,
      // 档案 mode 仍是 plan | single：设计模式是单执行者门面，不另开归档形状
      mode: run.mode === "plan" ? "plan" : "single",
      workspace: run.workspace === "office" || run.workspace === "code"
        ? run.workspace
        : (run.mode === "design" || run.packName === "design" ? "office" : "code"),
      effort: run.effort ?? null,
      rubric: run.rubric ?? null,
      workdir: run.workdir ?? workdir,
      ...(run.extraWorkdirs?.length ? { extraWorkdirs: run.extraWorkdirs } : {}),
      conversationTurn: run.conversationTurn,
      planGate: Boolean(run.planGate),
      planDecision: run.planDecision ?? null,
      mainStopReason: run.mainStopReason ?? null,
      askUser: Boolean(run.askUser),
      contextTokenLimit: run.contextTokenLimit ?? null,
      checkpoint: run.checkpoint ?? null,
      host: run.host === "cli" ? "cli" : run.archived ? parseArchiveHost(run.host) : "web",
      continuedFrom: run.continuedFrom ?? null,
      rootRunId: run.rootRunId ?? null,
      ...(run.rewindFrom ? { rewindFrom: run.rewindFrom } : {}),
      recap: run.conversationRecap || recapFromRunEvents(run) || null,
      ...(run.lastExecutorRoleId ? { lastExecutorRoleId: run.lastExecutorRoleId } : {}),
      ...(run.lastExecutorIdentityKey
        ? { lastExecutorIdentityKey: run.lastExecutorIdentityKey }
        : {}),
      ...(run.lastExecutorModel ? { lastExecutorModel: run.lastExecutorModel } : {}),
      outcome: run.outcome
        ? {
            finalPassed: run.outcome.finalPassed,
            reworks: run.outcome.reworks,
            verdict: run.outcome.verifications.at(-1)?.verdict ?? null,
            judgedTurn: run.outcomeTurn ?? null,
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
    // 会话中心化：收尾一律进终态。此前"还可追问的 completed 保持 executing"是为了
    // 让下一轮的 segment_begin 不被非法迁移挡住——现在下一轮由 `reopen` 显式把
    // 游标从终态拉回 executing，state.json 在两轮之间说的就是实话：这一轮完了。
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
          let recovered = recoverDurableStateOnCrash(durableState);
          // meta 说在跑、盘上 state 却已是终态：新一轮的 reopen 还没落盘就崩了（meta 先写、
          // 先到）。按 meta 走——它是"当时在跑"的事实源；有检查点就能同 run 热恢复。
          // 只看**盘上原相**：plan_gated 崩溃保持在门上（restore_gate），不许改写成 interrupted
          if (["completed", "failed", "closed"].includes(durableState.phase)) {
            recovered = {
              ...recovered,
              phase: "interrupted",
              pendingApprovalIds: [],
              pendingQuestionIds: [],
              updatedAt: Date.now(),
            };
          }
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
          ...(typeof a.meta.title === "string" && a.meta.title ? { title: a.meta.title } : {}),
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
          ...(a.meta.workspace === "office" || a.meta.workspace === "code"
            ? { workspace: a.meta.workspace }
            : a.meta.packName === "design"
              ? { workspace: "office" as const }
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
          ...(Array.isArray(a.meta.extraWorkdirs)
            ? {
                extraWorkdirs: a.meta.extraWorkdirs.filter((p): p is string => typeof p === "string" && p.trim() !== ""),
              }
            : {}),
          ...(a.meta.planGate ? { planGate: true } : {}),
          ...(a.meta.planDecision ? { planDecision: a.meta.planDecision } : {}),
          ...(a.meta.askUser ? { askUser: true } : {}),
          // 逐 run 预算随档案回来（派生时按当前窗口重新夹紧；坏值忽略 = 回落 env / 包 / 默认）
          ...(typeof a.meta.contextTokenLimit === "number" && Number.isInteger(a.meta.contextTokenLimit) && a.meta.contextTokenLimit > 0
            ? { contextTokenLimit: a.meta.contextTokenLimit }
            : {}),
          ...(parseArchiveHost(a.meta.host) === "cli" ? { host: "cli" as const } : {}),
          ...(checkpoint ? { checkpoint } : {}),
          ...(archivedApprovalGrantAudit.length ? { archivedApprovalGrantAudit } : {}),
          ...(typeof a.meta.continuedFrom === "string" && a.meta.continuedFrom
            ? { continuedFrom: a.meta.continuedFrom }
            : {}),
          ...(typeof a.meta.rootRunId === "string" && a.meta.rootRunId
            ? { rootRunId: a.meta.rootRunId }
            : {}),
          ...(parseRewindFromMeta(a.meta.rewindFrom)
            ? { rewindFrom: parseRewindFromMeta(a.meta.rewindFrom) }
            : {}),
          ...(typeof a.meta.recap === "string" && a.meta.recap
            ? { conversationRecap: a.meta.recap }
            : {}),
          ...(typeof a.meta.lastExecutorRoleId === "string" && a.meta.lastExecutorRoleId
            ? { lastExecutorRoleId: a.meta.lastExecutorRoleId }
            : {}),
          ...(typeof a.meta.lastExecutorIdentityKey === "string" && a.meta.lastExecutorIdentityKey
            ? { lastExecutorIdentityKey: a.meta.lastExecutorIdentityKey }
            : {}),
          ...(typeof a.meta.lastExecutorModel === "string" && a.meta.lastExecutorModel
            ? { lastExecutorModel: a.meta.lastExecutorModel }
            : {}),
          ...(durableState ? { durableState } : {}),
          ...(durableState?.plan?.nodes?.length
            ? {
                planNodes: planNodesFromDurable(durableState.plan.nodes),
                planHandoffs: handoffsFromPlanNodes(planNodesFromDurable(durableState.plan.nodes)),
                injectedPlan: planFromNodes(planNodesFromDurable(durableState.plan.nodes)),
              }
            : {}),
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
                  ...(nonNegativeInteger(a.meta.outcome.judgedTurn)
                    ? { judgedTurn: a.meta.outcome.judgedTurn }
                    : {}),
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
      // 信息队列重建：message_queued(mode:queue) 追加、message_queue_updated 整表
      // 替换——重放结束时的 pending 就是崩溃时刻仍排队的消息，刷新后 chips 不丢。
      run.messageQueue = rebuildMessageQueue(run.events);
    })().catch(() => {
      // 读盘失败：events/transcript 留空，列表元数据仍可用
    });
    return run.hydration;
  }

  /**
   * 只从 checkpoint 指定的执行者段恢复，不拿“最后一段”猜。归档里可能同时有
   * verifier 段，按数组尾部取会把独立核查上下文误接进主会话。执行者谱系含
   * rework：返工后的正史才是执行者手里的现状。
   */
  function archivedCheckpointHistory(run: StoredRun): Anthropic.MessageParam[] | undefined {
    const checkpoint = run.checkpoint;
    if (!checkpoint) return undefined;
    const segment = run.transcript.find(
      (candidate) =>
        candidate.index === checkpoint.segmentIndex && isExecutorLineageSource(candidate.source),
    );
    if (!segment || !isMessageHistory(segment.messages)) return undefined;
    // 子 run 可以压缩自己的正史；父档案的内存投影也必须保持不可变。
    return structuredClone(segment.messages);
  }

  /**
   * 归档 plan run 的对话种子：从事件流里的 plan / plan_result 重建结构化摘要
   * （活 run 收尾时已算好存在 run.planSummary；归档没有内存态，读事件重建）。
   */
  function archivedPlanSummary(run: StoredRun): string | undefined {
    if (run.mode !== "plan") return undefined;
    let planEvent: Record<string, unknown> | undefined;
    let resultEvent: Record<string, unknown> | undefined;
    for (const e of run.events) {
      const ev = e.event as Record<string, unknown>;
      if (ev.type === "plan") planEvent = ev;
      else if (ev.type === "plan_result") resultEvent = ev;
    }
    return buildPlanSummary({
      task: run.task,
      stopReason: run.mainStopReason,
      subtasks: Array.isArray(planEvent?.subtasks) ? (planEvent!.subtasks as PlanSummarySubtask[]) : [],
      steps: Array.isArray(resultEvent?.steps) ? (resultEvent!.steps as PlanSummaryStep[]) : [],
      skipped: Array.isArray(resultEvent?.skipped) ? (resultEvent!.skipped as { id: string; title?: string }[]) : [],
      completed: resultEvent?.completed === true,
      plannerFailure: typeof resultEvent?.plannerFailure === "string" ? resultEvent.plannerFailure : undefined,
    });
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
   *
   * 会话中心化：核查 / 编排 / 无检查点**都不再是拒绝理由**——封的是裁决的
   * 适用范围（它只对核查过的那一轮负责，事件流里带 judgedTurn），不是对话。
   * 无检查点的归档派生出来的是一次"无正史的新一轮"（plan 归档以计划摘要为种子），
   * 与活 run 上执行阶段就失败后再追问同一口径。
   */
  /** 活 run 追加的唯一结构性阻断：执行谱系预算耗尽（检查点里的累计读数） */
  function liveBudgetBlockReasonOf(r: StoredRun): string | null {
    // 检查点里钉着的上限就是武装状态本身：重启后宿主不再配 env 也不能洗掉旧账
    //（见「重启不能移除检查点里的旧上限」）。未配预算的 run 检查点里没有上限，
    // exhaustedBudgetReason 自然返回 null，不需要 lineageBudgetArmed 再挡一道。
    if (r.lineageBudget === false) return null;
    return r.checkpoint ? exhaustedBudgetReason(r.checkpoint.runBudget) : null;
  }

  /**
   * 归档派生只拦「当前宿主上限也挡着」——旧检查点钉着 50 万、宿主已经 200 万
   * 时不该把整场对话判死。重启把上限收得更严（used ≥ 当前 env）仍拒绝。
   */
  function hostBoundExhaustedReason(budget: SharedRunBudget): string | null {
    if (maxTotalTurns !== undefined && budget.usedTurns >= maxTotalTurns) {
      return exhaustedBudgetReason({ ...budget, maxTurns: maxTotalTurns });
    }
    if (maxTokensBudget !== undefined && budget.usedTokens >= maxTokensBudget) {
      return exhaustedBudgetReason({ ...budget, maxTokens: maxTokensBudget });
    }
    return null;
  }

  function resumeBudgetForContinuation(checkpoint: NonNullable<StoredRun["checkpoint"]>): SharedRunBudget {
    const restored = restoredBudget(checkpoint, { maxTotalTurns, maxTokensBudget });
    return autoExtendIfExhausted(restored, {
      addTokens: maxTokensBudget ?? 2_000_000,
      addTurns: maxTotalTurns ?? 40,
    }).budget;
  }

  function archivedForkBlockReason(r: StoredRun): string | null {
    if (!r.archived) return "该运行不是归档运行";
    if (r.packName && !getPack(r.packName)) {
      return `归档使用的领域包 \"${r.packName}\" 在当前宿主中不存在`;
    }
    let target: string;
    try {
      target = resolve(r.workdir ?? workdir);
    } catch {
      return "归档工作目录无效，不能交给当前宿主执行";
    }
    if (!allowedWorkdirs.has(target)) {
      return `归档工作目录不在当前宿主白名单内：${target}`;
    }
    if (!r.checkpoint) return null; // 无正史的新一轮：预算按当前宿主上限从零起算
    const budget = restoredBudget(r.checkpoint, { maxTotalTurns, maxTokensBudget });
    return hostBoundExhaustedReason(budget);
  }

  /**
   * 列表项摘要。V-14：元数据由服务端算好，侧栏不再依赖"这个 run 是否被订阅过"
   * ——此前核查结论一列只有打开过的 run 才有值。
   */
  function clipConversationRecap(text: string, max = 72): string {
    const cleaned = String(text ?? "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return "";
    const sentence = cleaned.split(/(?<=[。！？.!?])\s+/)[0] ?? cleaned;
    return sentence.length <= max ? sentence : `${sentence.slice(0, max)}…`;
  }

  function recapFromRunEvents(run: StoredRun): string {
    let last = "";
    for (const item of run.events) {
      const ev = item.event as Record<string, unknown>;
      if (ev?.type === "assistant_text" && item.source !== "verifier" && item.source !== "planner") {
        last = String(ev.text ?? "");
      }
    }
    if (!last) {
      const summary = run.outcome?.verifications.at(-1)?.verdict?.summary;
      if (typeof summary === "string") last = summary;
    }
    return clipConversationRecap(last);
  }

  function runSummary(r: StoredRun): Record<string, unknown> {
    // 会话中心化：活 run 只要收了尾就能追加——核查 / 编排 / 无正史都不是封印，
    // 唯一的结构性阻断是执行谱系预算耗尽（且文案说清怎么提）。
    const liveBudgetBlockReason = liveBudgetBlockReasonOf(r);
    // 活 run 收了尾就能追加。谱系额度用尽不再卡对话——followUp 会自动续一段跑道。
    const liveCanContinue = !r.archived && r.status === "done";
    const archiveBlockReason = r.archived ? archivedForkBlockReason(r) : null;
    const archiveCanFork = Boolean(r.archived && archiveBlockReason === null);
    // same-run 仅 interrupted（崩溃收口）+ checkpoint；完成态档案仍走 fork
    const archiveCanSameRun = Boolean(
      r.archived &&
        r.durableState &&
        archiveBlockReason === null &&
        canSameRunResume({
          phase: r.durableState.phase,
          hasCheckpoint: Boolean(r.checkpoint),
          verify: r.verify,
          mode: r.mode === "plan" ? "plan" : "single",
          budgetExhausted: false,
          ...(r.mode === "plan" ? { plan: planResumeFacts(r.durableState.plan) } : {}),
        }),
    );
    const archiveRestoreGate = Boolean(
      r.archived &&
        r.durableState &&
        archiveBlockReason === null &&
        canRestorePlanGate({
          phase: r.durableState.phase,
          plan: r.durableState.plan,
        }),
    );
    const archiveCanReopen = Boolean(
      r.archived &&
        r.durableState &&
        archiveBlockReason === null &&
        !archiveCanSameRun &&
        !archiveRestoreGate &&
        r.durableState.phase !== "completed" &&
        canReopenSameRun({
          phase: r.durableState.phase,
          hasTask: Boolean(String(r.task ?? "").trim()),
        }),
    );
    const grantCanStillBeCalled = !r.archived && (r.status === "running" || liveCanContinue);
    const activeApprovalGrants = grantCanStillBeCalled
      ? approvalGrantCheckpointSnapshot(r, approvalClock()).length
      : 0;
    const handoff = effectiveHandoff(r);
    return {
      runId: r.id,
      task: r.task,
      title: resolveRunTitle(r.title, r.task),
      status: r.status,
      verify: r.verify,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt ?? null,
      packName: r.packName ?? pack?.name ?? null,
      workspace: r.workspace === "office" || r.workspace === "code"
        ? r.workspace
        : (r.mode === "design" || r.packName === "design" ? "office" : "code"),
      ...(r.packRoute ? { packRoute: r.packRoute } : {}),
      stopReason: r.mainStopReason ?? null,
      // 活 run 走 outcome，归档 run 走 meta 里的摘要——列表列不因重启而变
      finalPassed: r.outcome?.finalPassed ?? r.archivedOutcome?.finalPassed ?? null,
      reworks: r.outcome?.reworks ?? r.archivedOutcome?.reworks ?? null,
      // 裁决只对它核查的那一轮负责：列表报最近一次裁决时必须带轮号，
      // 否则"第 1 轮通过、第 3 轮没核查"会被读成"这场对话通过了"
      verdictTurn: r.outcome ? (r.outcomeTurn ?? null) : (r.archivedOutcome?.judgedTurn ?? null),
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
      awaitingHandoff: handoff?.status === "pending"
        ? { id: handoff.id, summary: handoff.summary, label: handoff.label }
        : null,
      askUser: Boolean(r.askUser),
      autoApprove: Boolean(r.autoApprove),
      planDecision: r.planDecision?.decision ?? null,
      verdict: r.outcome?.verifications.at(-1)?.verdict ?? r.archivedOutcome?.verdict ?? null,
      mode: r.mode ?? "single",
      ...(r.designRoute ? { designRoute: r.designRoute } : {}),
      // 只在明确是 CLI 时标 cli；旧档案缺字段保持 null，不猜成 Web。
      host: r.host === "cli" ? "cli" : r.archived ? null : "web",
      // B2：父档案恒只读；有完整检查点时可派生子 run，不能把两者冒充成
      // “原进程无缝继续”。continuationMode 是这个环境边界的显式契约。
      ...(r.archived ? { archived: true } : {}),
      conversationTurn: r.conversationTurn,
      recap: r.conversationRecap || recapFromRunEvents(r) || null,
      continuedFrom: r.continuedFrom ?? null,
      rootRunId: r.rootRunId ?? null,
      ...(r.rewindFrom ? { rewindFrom: r.rewindFrom } : {}),
      // RUN-01 Phase 2：sameRunResume 仅在 interrupted+checkpoint 且边界放行时为 true
      durablePhase: r.durableState?.phase ?? null,
      durableRecovery: r.durableState ? recoveryActionForPhase(r.durableState.phase) : null,
      sameRunResume: archiveCanSameRun,
      durableBudget: r.durableState?.budget ?? r.checkpoint?.runBudget ?? null,
      durableGrantAuditCount: r.durableState?.grantAudit?.length ?? 0,
      lastSameRunResumeAt: r.durableState?.lastSameRunResumeAt ?? null,
      // V-32：侧栏按工作目录分组。workdir 是工具的写入圈禁边界，
      // 也就是"这段工作触碰的范围"——它是这个 harness 自己长出来的分组键，
      // 不是从别家侧栏照搬来的层级
      workdir: r.workdir ?? workdir,
      effort: r.effort ?? null,
      // 能否追加：让界面据此决定要不要显示输入框，而不是点了才报错。
      canContinue: liveCanContinue || archiveCanSameRun || archiveCanFork || archiveRestoreGate || archiveCanReopen,
      continuationMode: archiveRestoreGate
        ? "restore-gate"
        : archiveCanSameRun
          ? "same-run"
        : archiveCanReopen
          ? "reopen"
        : archiveCanFork
          ? "fork"
          : liveCanContinue
            ? "same"
            : null,
      continuationBlockReason:
        !archiveCanSameRun && !archiveCanFork && !archiveRestoreGate && !archiveCanReopen && r.archived
          ? archiveBlockReason
          : liveBudgetBlockReason,
      // 预算耗尽时可调用 POST .../extend-budget，不必改 env 重启
      budgetExhausted: Boolean(liveBudgetBlockReason),
      canExtendBudget: Boolean(
        !r.archived && r.status === "done" && r.checkpoint?.runBudget && liveBudgetBlockReason,
      ),
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

  const compactSummaryOn = (() => {
    const v = process.env.AGENT_COMPACT_SUMMARY?.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
  })();
  const maxTokens = process.env.AGENT_MAX_TOKENS
    ? Number(process.env.AGENT_MAX_TOKENS)
    : pack?.guardrails?.maxTokens;
  /**
   * 上下文窗口（事实）与预算（策略）分开解析（MEM-01，口径同 cli.ts）。
   * 窗口 env AGENT_CONTEXT_WINDOW > learned（撞过的 400）> registry > unknown——每次装配都重新解析，
   * 这样同进程里上一个 run 学到的窗口下一个 run 就能用上；预算 run（请求体）> env > 包 > 默认 150k，
   * 再夹进 窗口 − maxTokens − 边际。env 非法值在这里抛（口径同 AGENT_EFFORT：库里抛错，CLI 才 exit 1）。
   */
  const envContextLimit = readContextLimitEnv();
  // 两条 env 都在**启动时**先读一遍：窗口那条只在 contextPlanFor 里用，不在这里验的话
  // 非法值要等到第一次 /api/harness 才炸成 500——护栏 env 的非法值必须启动即失败（fail-closed）
  readContextWindowEnv();
  const contextPlanFor = (runPack?: DomainPack, runLimit?: number, tokens?: number): ContextPlan => {
    const windowInfo = resolveContextWindow(executorIdentity);
    return planContextBudget({
      window: windowInfo.window,
      windowSource: windowInfo.windowSource,
      maxTokens: tokens ?? maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(runLimit !== undefined ? { runLimit } : {}),
      ...(envContextLimit !== undefined ? { envLimit: envContextLimit } : {}),
      ...(runPack?.guardrails?.contextTokenLimit !== undefined
        ? { packLimit: runPack.guardrails.contextTokenLimit }
        : {}),
    });
  };
  /** 进程级快照用（/api/harness）：默认包、无逐 run 覆盖 */
  const processContextPlan = (): ContextPlan => contextPlanFor(pack);
  /** run_config / harness 的投影——七个字段一次给全，界面不许自己推算其中任何一个 */
  const contextView = (plan: ContextPlan) => ({
    window: plan.window,
    windowSource: plan.windowSource,
    budget: plan.budget,
    budgetSource: plan.budgetSource,
    requestedBudget: plan.requestedBudget,
    maxBudget: plan.maxBudget,
    maxTokens: plan.maxTokens,
    clamped: plan.clamped,
    warning: plan.warning,
  });
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
  // 谱系硬顶只在 env 显式设置时武装。真实宿主不再默认 120 轮 / 200 万 token——
  // 长对话会被自己的默认值卡死（184/120），委托方已明确不要这条限定。
  const maxTotalTurns = integerEnv("AGENT_TOTAL_MAX_TURNS", 1);
  const maxTokensBudget = integerEnv("AGENT_TOTAL_TOKEN_BUDGET", 1);
  const lineageBudgetArmed = maxTotalTurns !== undefined || maxTokensBudget !== undefined;
  const compactSummaryMaxTokens = integerEnv("AGENT_COMPACT_SUMMARY_MAX_TOKENS", 64);
  // 单个 tool_result 入口截断上限（MEM-01 Phase C，口径同 CLI）；缺省 40k
  const toolResultMaxChars = integerEnv("AGENT_TOOL_RESULT_MAX_CHARS", 1000);
  /**
   * 恢复策略三级解析：env > 包 `recovery` > 默认（口径同 verifyMaxTurnsOf / planner 预算）。
   * env 侧逐字段：只写了 AGENT_STAGNATION_WINDOW 时另两个仍落到包/默认。
   * 此前第三个字段（maxStagnationRecoveries）连 env 都没有，包更覆盖不了。
   */
  const envProgressExtensionTurns = integerEnv("AGENT_PROGRESS_EXTENSION_TURNS", 0);
  const envStagnationWindow = integerEnv("AGENT_STAGNATION_WINDOW", 0);
  const envMaxStagnationRecoveries = integerEnv("AGENT_MAX_STAGNATION_RECOVERIES", 0);
  const envRecovery: RecoveryPolicy = {
    ...(envProgressExtensionTurns !== undefined ? { progressExtensionTurns: envProgressExtensionTurns } : {}),
    ...(envStagnationWindow !== undefined ? { stagnationWindow: envStagnationWindow } : {}),
    ...(envMaxStagnationRecoveries !== undefined
      ? { maxStagnationRecoveries: envMaxStagnationRecoveries }
      : {}),
  };
  const recoveryFor = (p?: DomainPack) => resolveRecoveryPolicy({ explicit: envRecovery, pack: p?.recovery });
  /**
   * 快照/run_config 用的恢复策略投影：数字 + 逐字段来源 + **armed**。
   * armed=false（完成门关着）时数字照报但 loop 根本不会用它们——不带这个标记，
   * 界面会把"配了 8 轮续跑"画成"有 8 轮续跑"，而实际到 maxTurns 就停。
   */
  const recoverySnapshot = (p?: DomainPack) => {
    const r = recoveryFor(p);
    return { armed: taskCompletionEnabled, ...r.policy, sources: r.sources };
  };
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
  const mcpConfigPath = options.mcpConfigFile ?? process.env.AGENT_MCP_CONFIG ?? join(workdir, "mcp.json");

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
  let mcpConnecting: Promise<void> = Promise.resolve();
  let mcpError: string | undefined;
  let mcpConnectWarnings: string[] = [];

  async function ensureMcp(runPack?: DomainPack): Promise<void> {
    if (!mcpEnabled) return;
    const work = async () => {
      if (mcpError && !mcpRuntime) return;
      try {
        const cfg = await loadMcpConfig(mcpConfigPath);
        if (!cfg) {
          mcpError = `未找到 MCP 配置：${mcpConfigPath}`;
          return;
        }
        const slice = filterMcpConfigForPack(cfg, runPack?.mcp, {
          hostGithub: packAcceptsHostGithub(runPack),
        });
        if (!slice) return;
        const already = new Set([
          ...Object.keys(mcpRuntime?.summary ?? {}),
          ...Object.keys(mcpRuntime?.skipped ?? {}),
          ...Object.keys(mcpRuntime?.failed ?? {}),
        ]);
        const pending = {
          servers: Object.fromEntries(
            Object.entries(slice.servers).filter(([name]) => !already.has(name)),
          ),
        };
        if (Object.keys(pending.servers).length === 0) return;
        const warnings: string[] = [];
        const added = await connectMcpServers(pending, (m) => warnings.push(m));
        mcpRuntime = mergeMcpRuntimes(mcpRuntime, added);
        mcpTools = mcpRuntime.tools;
        if (warnings.length) mcpConnectWarnings = [...mcpConnectWarnings, ...warnings];
      } catch (err) {
        mcpError = err instanceof Error ? err.message : String(err);
      }
    };
    mcpConnecting = mcpConnecting.then(work, work);
    await mcpConnecting;
  }

  function mcpSnapshot(): Record<string, unknown> {
    const servers = [
      ...Object.entries(mcpRuntime?.summary ?? {}).map(([name, n]) => ({
        name,
        status: "connected",
        toolCount: n,
        tools: n,
      })),
      ...Object.entries(mcpRuntime?.skipped ?? {}).map(([name, reason]) => ({
        name,
        status: "skipped",
        reason,
      })),
      ...Object.entries(mcpRuntime?.failed ?? {}).map(([name, reason]) => ({
        name,
        status: "failed",
        reason,
      })),
    ];
    return {
      configured: existsSync(mcpConfigPath),
      configPath: mcpConfigPath,
      enabled: mcpEnabled,
      connected: Object.keys(mcpRuntime?.summary ?? {}).length > 0,
      servers,
      toolCount: mcpTools.length,
      ...(mcpError ? { error: mcpError } : {}),
      ...(mcpConnectWarnings.length ? { warnings: mcpConnectWarnings } : {}),
      // reason 三态互斥，不能含糊：没开 / 开了还没轮到 / 试过了但失败。
      // 失败时若还显示"尚未连接"，人会以为再等等就好——那是在骗人（V-04 同族）
      ...(!mcpEnabled
        ? { reason: "Web 宿主默认不接 MCP（设 AGENT_UI_MCP=1 开启）——常驻进程持有独占资源有风险" }
        : mcpError || mcpRuntime
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
    const allowlistRoots = mergeRunReadRoots([...allowedWorkdirs], run?.extraWorkdirs, runWorkdir);
    const runReadRoots = mergeRunReadRoots(readRoots, allowlistRoots, runWorkdir);
    const runWriteRoots = allowlistRoots;
    const systemPrompt = runPack?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    // MCP 工具按包的 includeTools 收窄（selectPackTools 负责）。mcpTools 在
    // ensureMcp 之后才非空——所有 start*Run 都先 await 它，不会拿到半截工具面
    const baseTools = injectedTools ?? selectPackTools(runPack, toolPool, mcpTools);
    /**
     * §5.2：逐 run 显式开启才装（决定 1）。工具实例挂在 run 上而不是每次新造——
     * 配额是逐实例计数的，重造等于配额永不耗尽。
     * verifier/planner 拿不到它：`withoutAskUser` 在 harness 层剔除（决定 3），
     * 宿主这边不必也不该重复实现那道闸。
     */
    let tools = run?.askUser
      ? [...appendMemoryTools(baseTools), (run.askUserTool ??= makeAskUserTool(run))]
      : appendMemoryTools(baseTools);
    /**
     * 下一步提议：包声明了 handoffs 才装。不挡对话（工具立刻返回），
     * 也不走 --ask 开关——那是另一件事。verifier/planner 由 withoutAskUser 剔除。
     */
    if (run && runPack?.handoffs?.length) {
      tools = [...tools, (run.proposeHandoffTool ??= makeProposeHandoffTool(run))];
    }
    // AGENT-02：默认关；AGENT_SPAWN_TASK=1 才装。verifier/planner 由 withoutAskUser 剥掉。
    if (run && process.env.AGENT_SPAWN_TASK === "1") {
      tools = [...tools, (run.spawnTaskTool ??= makeSpawnTaskTool(run))];
    }
    if (run) {
      tools = wrapToolsWithRewindSnapshots(tools, async (name, input, ctx) => {
        const rel = typeof (input as { path?: unknown } | null)?.path === "string"
          ? String((input as { path: string }).path).trim()
          : "";
        if (!rel) return;
        const captured = await captureBeforeWrite(runWorkdir, runWriteRoots, rel, ctx.toolUseId, name);
        rememberFileRewindSnapshot(run, captured.record, captured.blob);
      });
    }
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
    // 窗口 / 预算：逐 run 解析（包可能不同、请求体可能带预算、上一个 run 可能刚学到窗口）
    const contextPlan = contextPlanFor(runPack, run?.contextTokenLimit);
    if (run) run.contextPlan = contextPlan;
    const cfg: AgentConfig = {
      systemPrompt,
      tools,
      workdir: runWorkdir,
      ...(executionBroker ? { executionBroker } : {}),
      compat: envCompat,
      // 此前这里只设四个字段，pack 的护栏、只读根、effort 全部丢失
      ...(runEffort ? { effort: runEffort } : {}),
      ...(runReadRoots.length ? { readRoots: runReadRoots } : {}),
      ...(runWriteRoots.length ? { writeRoots: runWriteRoots } : {}),
      contextTokenLimit: contextPlan.budget,
      /**
       * 窗口学习钩子：loop 撞 400 学到的窗口记到执行者端点名下（内存表 + 真实宿主落盘）。
       * 同进程的下一个 run 在 contextPlanFor 里立刻拿到 learned 来源；编排层会给独立
       * verifier / planner 模型剥掉这个钩子（它们的 400 说的是自己的窗口）。
       */
      onContextWindowLearned: (windowTokens) => {
        learnContextWindow(executorIdentity, windowTokens);
      },
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...((run?.packName ? runPack?.guardrails?.maxTurns : maxTurns) !== undefined
        ? { maxTurns: (run?.packName ? runPack?.guardrails?.maxTurns : maxTurns) as number }
        : {}),
      // 谱系预算可关：关则不注入硬顶，不会走到 budget_exhausted
      ...(run?.lineageBudget !== false && maxTotalTurns !== undefined ? { maxTotalTurns } : {}),
      ...(run?.lineageBudget !== false && maxTokensBudget !== undefined ? { maxTokensBudget } : {}),
      ...(toolResultMaxChars !== undefined ? { toolResultMaxChars } : {}),
      ...(compactSummaryOn && realHost
        ? {
            compactSummaryClient: modelClient,
            ...(compactSummaryMaxTokens !== undefined
              ? { compactSummaryMaxTokens }
              : {}),
          }
        : {}),
      ...(run?.resumeBudget ? { runBudget: run.resumeBudget } : {}),
      ...(run?.initialContextInputTokens !== undefined
        ? { initialContextInputTokens: run.initialContextInputTokens }
        : {}),
      // SAFE-06：逐 run 武装 idempotency + durable toolTx
      ...(hookSpec
        ? { hooks: createHookRuntime(hookSpec, { workdir: runWorkdir }) }
        : {}),
      ...(run
        ? {
            runId: run.id,
            toolTx: makeToolTxController(run),
          }
        : {}),
    };
    return taskCompletionEnabled
      ? withTaskCompletion(cfg, recoveryFor(runPack).policy)
      : cfg;
  }

  function appendMemoryTools(tools: Tool[]): Tool[] {
    const names = new Set(tools.map((tool) => tool.name));
    return [...tools, ...memoryTools.filter((tool) => !names.has(tool.name))];
  }

  /** SAFE-06：按 run 装配事务控制器——查 durableState.toolTx，prepared 刷盘。 */
  function makeToolTxController(run: StoredRun): ToolTxController {
    return {
      runId: run.id,
      get: (key) => findToolTx(run.durableState?.toolTx, key),
      notify: async (phase, tx) => {
        applyDurableTransition(run, { type: "tool_tx", tx }, tx.updatedAt);
        // prepared 必须在副作用前落盘——崩溃注入才能证明不丢意图
        if (phase === "prepared" && run.archiveWriter) {
          await run.archiveWriter.flush();
        }
      },
      ...(crashAfterToolPrepared
        ? {
            injectCrashAfterPrepared: () => {
              const prepared = [...(run.durableState?.toolTx ?? [])]
                .reverse()
                .find((t) => t.status === "prepared");
              return prepared ? crashAfterToolPrepared(run.id, prepared) : false;
            },
          }
        : {}),
    };
  }

  async function buildRunConfig(
    run?: StoredRun,
    options: { bindExecutionBroker?: boolean } = {},
  ): Promise<AgentConfig> {
    const cfg = buildConfig(run, options);
    const runWorkdir = run?.workdir ?? workdir;
    const allowlistRoots = mergeRunReadRoots([...allowedWorkdirs], run?.extraWorkdirs, runWorkdir);
    const runReadRoots = mergeRunReadRoots(readRoots, allowlistRoots, runWorkdir);
    return {
      ...cfg,
      dynamicContext: mergeAgentMdContext({
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
        ...(runReadRoots.length ? { read_only_roots: runReadRoots.join("; ") } : {}),
        ...(allowlistRoots.length ? { writable_roots: allowlistRoots.join("; ") } : {}),
        memory_index: await scopedMemoryIndex(new MemoryStore(resolveMemoryDir(runWorkdir)), runWorkdir),
        project_status: formatProjectStatusBlock(
          await readProjectStatus(
            new MemoryStore(resolveMemoryDir(runWorkdir)),
            runWorkdir,
            isSharedMemoryDir(runWorkdir, resolveMemoryDir(runWorkdir)),
          ),
        ),
        workspace_git: formatWorkspaceGitLine(
          (run?.workspaceGit ?? publicWorkspaceGit(await probeWorkspaceGit(runWorkdir))),
        ),
      }, agentMdForRun(run)),
    };
  }

  async function refreshWorkspaceGit(run: StoredRun): Promise<PublicWorkspaceGit> {
    const snap = publicWorkspaceGit(await probeWorkspaceGit(run.workdir ?? workdir));
    run.workspaceGit = snap;
    return snap;
  }

  function listedWorkdir(raw: unknown): { ok: true; path: string } | { ok: false; status: number; error: string } {
    if (typeof raw !== "string" || !raw.trim()) {
      return { ok: false, status: 400, error: "缺少工作目录（workdir）" };
    }
    let asked: string;
    try {
      asked = resolve(raw.trim());
    } catch {
      return { ok: false, status: 400, error: "工作目录无效" };
    }
    if (!allowedWorkdirs.has(asked)) {
      return {
        ok: false,
        status: 403,
        error: `工作目录不在白名单内。可选：${[...allowedWorkdirs].join(" | ")}`,
      };
    }
    return { ok: true, path: asked };
  }

  /**
   * 追问轮把底栏旋钮写进这一轮：工作目录 / 额外可写根 / 领域包 / 思考强度 / 评分表。
   * 运行中的插队只带文本，不走这里——在飞 loop 已经按旧装配造好了。
   */
  async function applyFollowUpAssembly(
    target: StoredRun,
    parsed: {
      pack?: unknown;
      autoPack?: unknown;
      workdir?: unknown;
      extraWorkdirs?: unknown;
      effort?: unknown;
      rubric?: unknown;
    },
    routeText: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (parsed.effort !== undefined && parsed.effort !== "" && parsed.effort !== null) {
      if (!(EFFORT_LEVELS as readonly string[]).includes(String(parsed.effort))) {
        return { ok: false, error: `effort "${parsed.effort}" 无效。可选：${EFFORT_LEVELS.join(" | ")}` };
      }
      target.effort = String(parsed.effort) as Effort;
    }
    if (typeof parsed.rubric === "string") {
      const trimmed = parsed.rubric.trim();
      if (trimmed) target.rubric = trimmed;
      else delete target.rubric;
    }
    if (parsed.workdir !== undefined && parsed.workdir !== "") {
      const asked = resolve(String(parsed.workdir));
      if (!allowedWorkdirs.has(asked)) {
        return {
          ok: false,
          error: `工作目录不在白名单内。可选：${[...allowedWorkdirs].join(" | ")}（可点工作目录下拉的「＋ 添加目录…」即时加入）`,
        };
      }
      target.workdir = asked;
    }
    if (parsed.extraWorkdirs !== undefined) {
      const extraParsed = parseExtraWorkdirs(
        parsed.extraWorkdirs,
        allowedWorkdirs,
        target.workdir ?? workdir,
      );
      if (!extraParsed.ok) return { ok: false, error: extraParsed.error };
      if (extraParsed.extraWorkdirs.length) target.extraWorkdirs = extraParsed.extraWorkdirs;
      else delete target.extraWorkdirs;
    }
    if (parsed.autoPack === true && (parsed.pack === undefined || parsed.pack === "")) {
      try {
        const outcome = await routeToPack(
          { systemPrompt: "router", tools: [], workdir: target.workdir ?? workdir, compat: envCompat },
          modelClient,
          routeText,
          allPacks(),
        );
        if (outcome.decision.pack && getPack(outcome.decision.pack)) {
          target.packName = outcome.decision.pack;
        }
      } catch {
        /* 路由失败保持原包，与新建 run 的 fail-open 同向 */
      }
    } else if (typeof parsed.pack === "string") {
      if (parsed.pack === "") {
        delete target.packName;
      } else if (!getPack(parsed.pack)) {
        return { ok: false, error: `未知领域包 "${parsed.pack}"。可选：${packNamesLine()}` };
      } else {
        target.packName = parsed.pack;
      }
    }
    return { ok: true };
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
   * allPacks()：内置 + 已安装文件包），预算跟菜单走，与逐 run 选中的默认包无关。
   */
  const envPlanMaxTurns = (() => {
    const raw = process.env.AGENT_PLAN_MAX_TURNS;
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 ? n : undefined;
  })();
  const plannerBudgetTurns = (): number => resolvePlannerMaxTurns(allPacks(), envPlanMaxTurns);
  const plannerBudgetSource = (): "env" | "pack" | "default" =>
    envPlanMaxTurns !== undefined
      ? "env"
      : allPacks().some((p) => p.plan?.maxTurns !== undefined)
        ? "pack"
        : "default";

  /**
   * 核查白名单：包说了算（没声明也不补）；**无包**才用 AGENT_VERIFY_READONLY_COMMANDS > 通用缺省
   * （委托方批准的例外——无包核查者连 ls/cat 都被拒，3 行文件核查 7 轮 153 s 落 unverified）。
   * 仪器纪律：env 只武装真实宿主；注入模型的宿主读空 env（缺省即通用缺省）。
   */
  const readOnlyFor = (p?: DomainPack) =>
    resolveVerifierReadOnlyCommands(p, realHost ? process.env.AGENT_VERIFY_READONLY_COMMANDS : undefined);

  function buildVerifyOptions(run?: StoredRun) {
    const runPack = run?.packName ? getPack(run.packName) : pack;
    // rubric 是任务属性，包只提供缺省：逐 run > env > 包（口径同 src/cli.ts）
    const runRubric = run?.rubric || rubric || runPack?.verify.rubric;
    // 角色模型默认启用（配了就用，口径同 CLI）；逐 run 可显式关掉做 A/B 对照
    const useVerifier = run?.useVerifierModel ?? true;
    const readOnly = readOnlyFor(runPack);
    return {
      ...(runPack?.verify.instructions ? { verifyInstructions: runPack.verify.instructions } : {}),
      ...(readOnly.commands.length ? { verifyReadOnlyCommands: readOnly.commands } : {}),
      ...(runRubric ? { verifyRubric: runRubric } : {}),
      ...(verifyMaxTurnsOf(runPack) !== undefined ? { verifyMaxTurns: verifyMaxTurnsOf(runPack)! } : {}),
      ...(verifierRole && useVerifier
        ? { verifierModel: { client: verifierClient!, compat: verifierRole.provider.compat } }
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

  function handoffFromEvents(run: StoredRun): HandoffProposalState | null {
    let current: HandoffProposalState | null = null;
    for (const item of run.events) {
      const ev = item.event as { type?: string; [k: string]: unknown };
      if (ev.type === "handoff_proposal") {
        current = {
          status: "pending",
          id: String(ev.id ?? ""),
          handoffId: String(ev.handoffId ?? ""),
          summary: String(ev.summary ?? ""),
          label: String(ev.label ?? ""),
          declineLabel: String(ev.declineLabel ?? ""),
          requestSeq: item.seq,
        };
      }
      if (ev.type === "handoff_resolved" && current) {
        const decision = ev.decision === "accept" ? "accepted" : "declined";
        current = {
          ...current,
          status: decision,
          ...(typeof ev.childRunId === "string" ? { childRunId: ev.childRunId } : {}),
        };
      }
    }
    return current;
  }

  function effectiveHandoff(run: StoredRun): HandoffProposalState | null {
    if (run.handoffProposal) return run.handoffProposal;
    const rebuilt = handoffFromEvents(run);
    if (rebuilt) run.handoffProposal = rebuilt;
    return rebuilt;
  }

  function makeProposeHandoffTool(run: StoredRun): Tool {
    return createProposeHandoffTool({
      resolveHandoff: (id) => findHandoffAmong(allPacks(), id),
      onPropose: (proposal) => {
        const id = randomUUID();
        const at = Date.now();
        const requestSeq = pushSyntheticEvent(run, "host", {
          type: "handoff_proposal",
          id,
          handoffId: proposal.handoffId,
          summary: proposal.summary,
          label: proposal.label,
          declineLabel: proposal.declineLabel,
          at,
        });
        run.handoffProposal = {
          status: "pending",
          id,
          handoffId: proposal.handoffId,
          summary: proposal.summary,
          label: proposal.label,
          declineLabel: proposal.declineLabel,
          requestSeq,
        };
        broadcastLifecycle("run_updated", run);
      },
    });
  }

  function makeAskUserTool(run: StoredRun): Tool {
    return createAskUserTool({
      ...(maxAskRounds !== undefined ? { maxRounds: maxAskRounds } : {}),
      ask: (req: { questions: UserQuestion[] }) =>
        new Promise<(string | null)[] | null>((resolve) => {
          (run.questionQueue ??= []).push({ questions: req.questions, resolve });
          pumpQuestionQueue(run);
        }),
    });
  }

  /**
   * AGENT-02：同谱系支线。子事件 source=`spawn/<title>`，不回灌父正史；
   * 子正史若有 archiveWriter 则随父 run 旁路记入（events 流可见）。
   */
  function makeSpawnTaskTool(run: StoredRun): Tool {
    return createSpawnTaskTool({
      depth: 0,
      onStart: (request) => {
        pushSyntheticEvent(run, "host", {
          type: "spawn_start",
          title: request.title,
          at: Date.now(),
        });
      },
      onDone: (request, result) => {
        pushSyntheticEvent(run, "host", {
          type: "spawn_done",
          title: request.title,
          passed: result.passed,
          summary: result.summary,
          ...(result.error ? { error: result.error } : {}),
          ...(result.turns !== undefined ? { turns: result.turns } : {}),
          at: Date.now(),
        });
      },
      spawn: async (request) => {
        const budget = run.loop?.getRunBudget();
        if (!budget) {
          return { summary: "", passed: false, error: "父 loop 尚未就绪，无法共享预算" };
        }
        const parentCfg = await buildRunConfig(run);
        const childId = `${run.id}-spawn-${randomUUID().slice(0, 8)}`;
        const spawnSource = `spawn/${request.title.slice(0, 40)}`;
        return runSpawnedTask({
          parentConfig: parentCfg,
          modelClient,
          runBudget: budget,
          request,
          childRunId: childId,
          signal: run.abort?.signal,
          onEvent: async (event) => {
            // 旁路进事件流（可观测）；不进父会话正史（ContextManager 是子 loop 自己的）
            pushEvent(run, spawnSource, event);
          },
        });
      },
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

  /**
   * 在 delta 命名通道上广播一帧 `kind:"reset"`：同一轮即将重流（重试 / 换端点），
   * 失败那次尝试流出的半截增量作废。与 text/thinking 增量同通道、同 source 口径——
   * 前端只消费 main 的直播流，verifier/planner 的重试不该清主对话的缓冲。
   * reset 同样是瞬态帧（不占 seq、不进缓冲）：断线期间的 reset 丢了没关系，
   * durable 流里那条 api_retry / model_fallback 重放时前端会再清一次。
   */
  function broadcastDeltaReset(run: StoredRun, source: string): void {
    broadcastSSE(run, `event: delta\ndata: ${JSON.stringify({ source, kind: "reset" })}\n\n`);
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

    // 同轮重试（api_retry）= 同一请求即将幂等重发，模型会**从头再流一遍**正文。
    // delta 是瞬态追加语义，失败那次流出来的半截文字前端无法自己识别——
    // 必须在重流开始之前显式宣告"清缓冲"，否则直播条会把同一段文字再播一遍
    // （委托方截图：直播文字鬼畜地一直生成）。reset 帧走在 durable 帧之前，
    // TCP 保序，前端收到的次序就是"旧增量 → reset → 重流增量"。
    if (event.type === "api_retry") broadcastDeltaReset(run, source);

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
    // 恢复决策同款：领域包该声明几轮续跑，只能从"续跑真的发生过几次"读出来
    if (event.type === "recovery_decision") {
      tallyRecoveryDecision((run.recoveryTally ??= emptyRecoveryTally()), source, event);
    }
    // 压缩计数同款：反应式救回超长请求的代价（模型补读被置换掉的事实）此前只在事件流里可见
    if (event.type === "compaction") {
      tallyCompaction((run.compactionTally ??= emptyCompactionTally()), event);
    }
    if (hookSpec && event.type === "hook") {
      tallyHookEvent((run.hooksTally ??= emptyHooksTally()), event);
    }
    // OBS-01：事件旁路投影 span（失败不打断 run）
    try {
      if (!run.openToolSpans) run.openToolSpans = new Map();
      if (!run.openModelSpans) run.openModelSpans = new Map();
      const spans = projectTurnEventToSpans({
        runId: run.id,
        source,
        event,
        parentSpanId: run.traceRunSpanId ?? null,
        openTools: run.openToolSpans,
        openModels: run.openModelSpans,
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
      growTokens(source === "planner" ? "planner" : "execution", event.result.usage, run);
    }
    // 台账 turns 的裸跑口径：执行者谱系各段轮次之和（planner / verifier 各有独立预算，不混）
    if (event.type === "done" && isExecutorSource(source)) {
      run.turnExecutorTurns = (run.turnExecutorTurns ?? 0) + (event.result.usage?.turns ?? 0);
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
      const rememberAutoDecision = (decision: "allow" | "deny") => {
        // 自动放行从不进 pending 表。不记 responded 的话，界面那张卡再点一次
        // 会走「Approval not found」404，而不是已决的 409。
        const key = approvalId(event.toolUseId, seq);
        run.respondedApprovals.set(key, { decision, at: Date.now() });
        run.respondedToolUseIds.add(event.toolUseId);
      };
      if (run.autoApprove) {
        event.respond("allow");
        autoApproved = true;
        rememberAutoDecision("allow");
        Object.assign(sseEvent.event, {
          autoResolved: true,
          decision: "allow",
        });
        deferredHostEvents.push({
          type: "approval_resolved",
          requestSeq: seq,
          toolUseId: event.toolUseId,
          name: event.name,
          decision: "allow",
          actor: "auto-run",
          at: Date.now(),
        });
      }
      const grant = run.autoAllow?.get(ruleKey);
      if (!autoApproved && grant) {
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
          rememberAutoDecision("allow");
          Object.assign(sseEvent.event, {
            autoResolved: true,
            decision: "allow",
          });
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
      // 只认执行者谱系（main / rework）——verifier 是全新上下文的独立复核，
      // 它的正史不属于对话；返工段属于对话：返工后执行者手里的现状就是它
      if (isExecutorLineageSource(source) && event.result.messages?.length) {
        run.history = event.result.messages;
        rememberExecutorFingerprint(run);
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
    // RUN-01：事件落盘后再迁游标（ADR 写序）。段起点 / 审批挂起 / 预算与 grant。
    if (
      event.type === "done" &&
      isExecutorLineageSource(source) &&
      run.checkpoint?.runBudget &&
      run.durableState
    ) {
      applyDurableTransition(run, {
        type: "budget_snapshot",
        budget: { ...run.checkpoint.runBudget } as DurableBudgetSnapshot,
      }, sseEvent.ts);
      for (const g of run.checkpoint.approvalGrants ?? []) {
        applyDurableTransition(run, {
          type: "grant_audit",
          entry: {
            grantId: g.grantId,
            approvalId: g.approvalId,
            name: g.name,
            inputHash: g.inputHash,
            issuedAt: g.issuedAt,
            expiresAt: g.expiresAt,
            maxUses: g.maxUses,
            usedUses: g.usedUses,
            outcome: "checkpointed",
            at: sseEvent.ts,
          } satisfies DurableGrantAuditEntry,
        }, sseEvent.ts);
      }
    }
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
    if (!fallbackChain && !anyRoleFallbackNow()) return body();
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
        ...(info.role ? { role: info.role } : {}),
        ...(info.routing ? { routing: info.routing } : {}),
      });
    }, body);
  }

  /** 推送合成事件（如 verdict / approval_resolved / run_end）到缓冲与在线客户端 */
  function pushSyntheticEvent(run: StoredRun, source: string, event: Record<string, unknown>): number {
    // 端点降级（model_fallback）与 api_retry 同型：换一个端点重发同一请求，
    // 上一个端点流出来的半截正文作废。这条事件的 source 是 "model"（L0 层的事实），
    // 而 delta 通道按**角色**归属——role 缺省即主执行者，与 loop 推 delta 时的
    // source="main" 是同一个直播缓冲。
    if (event.type === "model_fallback") {
      const role = typeof event.role === "string" && event.role ? event.role : "main";
      broadcastDeltaReset(run, role);
    }
    if (event.type === "approval_resolved" || event.type === "approval_expired") {
      tallyApprovalOutcome((run.approvalsTally ??= emptyApprovalsTally()), event);
    }
    const seq = run.events.length;
    const sseEvent: SSEEvent = { seq, source, ts: Date.now(), event };
    run.events.push(sseEvent);
    run.archiveWriter?.appendEvent(sseEvent);
    broadcastSSE(run, frameFor(sseEvent));
    return seq;
  }

  /**
   * 信息队列·运行中入口（followUp 路由的主门与 readBody 后的复查共用）。
   * steer = 插队（loop 下一轮模型调用前 drain 进正史）；queue = 排队（本轮
   * 结束后自动续跑）。两条都落 message_queued durable 事件——刷新 / 崩溃
   * 重放后队列状态不丢。202：已受理，本轮内不作为独立对话轮执行。
   */
  function enqueueRunningMessage(
    res: ServerResponse,
    run: StoredRun,
    text: string,
    qMode: "steer" | "queue",
  ): void {
    const queue = qMode === "steer" ? (run.steeringQueue ??= []) : (run.messageQueue ??= []);
    queue.push(text);
    pushSyntheticEvent(run, "host", { type: "message_queued", mode: qMode, text, at: Date.now() });
    json(res, 202, { runId: run.id, mode: qMode, queued: queue.length });
  }

  /**
   * 续跑前的谱系预算处置——followUp 路由与"排队自动续跑"共用同一口径：
   * 逐 run 显式关掉谱系预算的只留账（used）；额度已尽的当场续一段跑道再放行
   * （重启没配 env 也洗不掉旧上限，耗尽不再是死路）。
   */
  function prepareLineageBudgetForContinuation(run: StoredRun): void {
    if (!run.checkpoint?.runBudget) return;
    if (run.lineageBudget === false) {
      // 逐 run 显式关掉谱系预算：只留账（used），不带上限
      const stripped = {
        usedTurns: run.checkpoint.runBudget.usedTurns,
        usedTokens: run.checkpoint.runBudget.usedTokens,
      };
      run.checkpoint = { ...run.checkpoint, runBudget: stripped };
      if (run.durableState?.budget) {
        run.durableState = {
          ...run.durableState,
          budget: { ...stripped } as typeof run.durableState.budget,
        };
      }
      run.resumeBudget = { ...stripped };
      return;
    }
    const slice = autoExtendIfExhausted(run.checkpoint.runBudget, {
      addTokens: maxTokensBudget ?? 2_000_000,
      addTurns: maxTotalTurns ?? 40,
    });
    if (slice.extended) {
      run.checkpoint = { ...run.checkpoint, runBudget: slice.budget };
      if (run.durableState?.budget) {
        run.durableState = {
          ...run.durableState,
          budget: { ...slice.budget } as typeof run.durableState.budget,
        };
      }
      run.resumeBudget = { ...slice.budget };
    }
  }

  /**
   * 排队消息的自动续跑内部入口（T9 同款纪律：与 followUp 路由的活 run 分支
   * 共用全部闸门语义——预算续跑道 / 执行健康 / 日预算 / 并发准入 / 独占资源 /
   * workdir 冲突），差别只是没有 res 可写：拒绝以返回值告知调用方，由它把
   * 消息放回队列（不丢）。核查 / 编排沿用该 run 上一轮自己的设置（run.verify），
   * 与缺省 followUp（不带逐轮开关）同口径。
   */
  async function followUpLiveRunInternal(
    run: StoredRun,
    text: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (run.archived || run.status !== "done" || run.turnDriverActive) {
      return { ok: false, error: "run 不在可续跑状态（已归档或仍在运行）" };
    }
    const epoch = tryClaimTurnDriver(run);
    if (epoch == null) {
      return { ok: false, error: "run 不在可续跑状态（已归档或仍在运行）" };
    }
    prepareLineageBudgetForContinuation(run);
    // 与路由同序：执行健康先于日预算，日预算先于并发准入（拒因更具体的先说）
    await refreshExecutionHealth(true);
    if (!executionHealthy) {
      releaseTurnDriver(run, epoch);
      return {
        ok: false,
        error: `Required command isolation is unavailable: ${processExecutionStatus.probe.reason ?? "backend probe failed"}`,
      };
    }
    if (run.dailyBudget !== false) {
      const budgetRefusal = dailyBudgetRefusal();
      if (budgetRefusal) {
        releaseTurnDriver(run, epoch);
        return { ok: false, error: `日 token 预算已用尽（${budgetRefusal.used}/${budgetRefusal.budget}）` };
      }
    }
    const releaseAdmission = acquireRunAdmission();
    if (!releaseAdmission) {
      releaseTurnDriver(run, epoch);
      return { ok: false, error: "并发容量已满" };
    }
    try {
      const resumePack = run.packName ? getPack(run.packName) : pack;
      const resumeResources = resumePack?.resources ?? [];
      const resourceOutcome = tryAcquireRunResources(run.id, resumeResources);
      if (resourceOutcome !== "acquired") {
        releaseTurnDriver(run, epoch);
        return {
          ok: false,
          error: `Exclusive resource "${resourceOutcome.conflict}" is held by run ${resourceOutcome.heldBy}`,
        };
      }
      const workdirRejection = sharedWorkdirRejection(run.id, run.workdir ?? workdir);
      if (workdirRejection) {
        hostResources.release(resumeResources, run.id);
        releaseTurnDriver(run, epoch);
        return { ok: false, error: `Workdir is in use by running run ${workdirRejection.conflictRunId}` };
      }
      if (resumeResources.length) run.heldResources = resumeResources;
      if (realHost) {
        operationalLog("info", "run_started", {
          runId: run.id,
          mode: run.mode ?? "single",
          verify: run.verify,
          continuation: "queued",
        });
      }
      void withFallbackAttribution(run, () =>
        startConversationTurn(run, text, { verify: run.verify, driverEpoch: epoch }),
      );
      return { ok: true };
    } finally {
      releaseAdmission();
    }
  }

  /**
   * 信息队列收尾（finalizeRun 的唯一自动续跑挂钩）：本轮结束后把排队指令
   * 拼成一条（'\n\n' 连接）自动续跑；steeringQueue 里没来得及注入的余量
   * 也并入——**消息不许丢**。续跑被闸门拒绝时消息放回队列并发
   * message_queue_updated，界面上的排队 chips 原样回来，人再决定重发或取消。
   */
  async function flushQueuedMessagesAfterDone(run: StoredRun): Promise<void> {
    const queued = (run.messageQueue ?? []).splice(0);
    const steerLeftover = (run.steeringQueue ?? []).splice(0);
    const parts = [...queued, ...steerLeftover];
    if (!parts.length) return;
    const result = await followUpLiveRunInternal(run, parts.join("\n\n"));
    if (result.ok) {
      pushSyntheticEvent(run, "host", { type: "message_queue_updated", pending: [], at: Date.now() });
      return;
    }
    run.messageQueue = parts;
    pushSyntheticEvent(run, "host", {
      type: "message_queue_updated",
      pending: [...parts],
      sendError: result.error,
      at: Date.now(),
    });
  }

  function tryClaimTurnDriver(run: StoredRun): number | null {
    if (run.turnDriverActive) return null;
    run.turnDriverActive = true;
    run.turnDriverEpoch = (run.turnDriverEpoch ?? 0) + 1;
    return run.turnDriverEpoch;
  }

  function releaseTurnDriver(run: StoredRun, epoch: number): void {
    if (run.turnDriverEpoch !== epoch) return;
    run.turnDriverActive = false;
  }

  function turnDriverInFlight(run: StoredRun): boolean {
    return run.status === "running" || Boolean(run.turnDriverActive);
  }

  function conversationHasCompletedPlan(run: StoredRun): boolean {
    return Boolean(run.planSummary) || Boolean(run.planNodes?.length);
  }

  /**
   * 标记 run 完成并关闭所有 SSE 连接。
   *
   * 顺序是契约的一部分：先把仍挂起的审批逐条宣告过期，再发 run_end，最后才断流。
   * run_end 恒为最后一条 durable 事件——它同时是"整个 run 结束了"的唯一权威信号
   * （段级 done 不是）与客户端"可以主动 close，不要再自动重连"的信号。
   *
   * `driverEpoch`：这段驱动收尾时必须仍是当前世代。过期的 finally（另一段
   * planner/执行者已经接着跑，或宿主已权威 stop）不得拆还在用的 broker。
   * 不传 epoch = 权威收尾（停止 / 关停），仍受 status===done 幂等保护。
   */
  function finalizeRun(run: StoredRun, endInfo: RunEndInfo, driverEpoch?: number): void {
    if (driverEpoch !== undefined && driverEpoch !== run.turnDriverEpoch) return;
    if (run.status === "done") return; // 幂等：异常路径可能重复调用
    run.turnDriverActive = false;

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
    // 活 run 收尾后对话还能续（谱系额度尽了 followUp 会自动续一段跑道），
    // 本次对话放行跟着对话走，不再因预算清掉。归档 / 关停另清。
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
    // 会话中心化：run.outcome 是**最近一次核查过的那一轮**的结果；本轮没核查时
    // run_end / 台账不得挂上一轮的裁决——那是拿旧裁决为新产物担保
    const o = run.outcome && run.outcomeTurn === run.conversationTurn ? run.outcome : undefined;
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

    /**
     * OBS-02 本次运行的 USD 成本。口径与 usage 脚注一致（逐段记账之和，
     * 含被否掉的中间轮），但**任一角色单价未登记，合计就是 null**——
     * 把能算的加起来当"本次成本"是一句长得像总额的半真话。
     */
    const costParts = run.costParts ?? [];
    const runCost = sumRunCost(costParts);
    // 一条记账都没有 ≠ 花了 0 元。前者是"没读数"，后者是个断言——
    // 在第一次模型调用之前就 error 终止的 run 正落在这个缝里
    const noUsage = costParts.length === 0;
    const costFace = {
      usd: noUsage ? null : runCost.usd,
      byRole: runCost.byRole,
      unpricedRoles: runCost.unpricedRoles,
      unpricedTokens: runCost.unpricedTokens,
      // 折算为什么没数：没记账 / 单价未登记 / 价表本身坏了，三件事界面上要分得开
      reason: noUsage
        ? "no_usage"
        : priceTableError
          ? "price_table_error"
          : runCost.usd === null
            ? "model_not_listed"
            : "ok",
      pack: run.packName ?? pack?.name ?? null,
    };

    pushSyntheticEvent(run, "host", {
      type: "run_end",
      finishedAt: run.finishedAt,
      outcome: endInfo.outcome,
      cost: costFace,
      ...(endInfo.mainStopReason ? { mainStopReason: endInfo.mainStopReason } : {}),
      ...(o
        ? {
            finalPassed: o.finalPassed,
            reworks: o.reworks,
            executionUsage: o.executionUsage,
            verificationUsage,
            // 裁决只对它核查的那一轮负责——run_end 里的每条裁决都带轮号
            judgedTurn: run.conversationTurn,
            verifications: o.verifications.map((v, i) => ({
              round: i,
              judgedTurn: run.conversationTurn,
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
    // 台账要记的窗口 / 预算计划。算在门外是刻意的：`if (ledgerFile)` 与 `appendRunLedger` 之间
    // 不许插语句——test/ledger.test.ts 用文本邻接锁住"写入被这个开关罩住"，插一行就等于松开那把锁。
    // 纯函数、无 I/O，记账关掉时白算一次可以忽略。
    const ledgerContextPlan =
      run.contextPlan ?? contextPlanFor(run.packName ? getPack(run.packName) : pack, run.contextTokenLimit);
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
        mode: run.mode === "plan" ? "plan" : "single",
        verify: run.verify,
        rubric: run.rubric ?? null,
        stopReason: endInfo.mainStopReason ?? null,
        error:
          endInfo.error ??
          (endInfo.mainStopReason === "error" || endInfo.mainStopReason === "execution_unavailable"
            ? ledgerErrorClass(endInfo.mainStopReason)
            : null),
        // 带核查读 outcome（含被否掉的中间轮）；裸跑读事件旁路累加的执行段轮次——
        // 此前裸跑恒 null，max_turns 的 Web 行全是裸跑，比值永远算不出
        turns: o?.executionUsage?.turns ?? run.turnExecutorTurns ?? null,
        reworks: o?.reworks ?? null,
        finalPassed: o?.finalPassed ?? null,
        verifications: o?.verifications ?? [],
        verifierBudgetTurns: verifyMaxTurnsOf(run.packName ? getPack(run.packName) : pack) ?? null,
        verifierHitBudget: run.verifierHitBudget ?? false,
          fallbackChain,
          fallbacks: run.fallbacks ?? 0,
          tools: run.toolTally,
          durationMs: (run.finishedAt ?? Date.now()) - run.createdAt,
          // 分母与策略快照（口径同 CLI）：plan 模式 turns 是各子任务之和，记 null
          maxTurns: run.mode === "plan"
            ? null
            : ((run.packName ? getPack(run.packName)?.guardrails?.maxTurns : maxTurns) ?? DEFAULT_MAX_TURNS),
          recoveryPolicy: taskCompletionEnabled
            ? recoveryFor(run.packName ? getPack(run.packName) : pack).policy
            : null,
          recovery: run.recoveryTally ?? emptyRecoveryTally(),
          compaction: run.compactionTally ?? emptyCompactionTally(),
          hooks: hookSpec ? (run.hooksTally ?? emptyHooksTally()) : null,
          agentMd: (() => {
            const bundle = agentMdForRun(run);
            return bundle
              ? { files: bundle.files.length, chars: bundle.chars, truncated: bundle.truncated }
              : null;
          })(),
          // 档位跟实际开关走，不跟 run.permissionMode 标签（用户点完档位再拨开关会过期）。
          permissionMode: matchPermissionMode({
            approvalDefault: run.autoApprove ? "auto" : "ask",
            planMode: run.mode === "plan",
            planGate: Boolean(run.planGate),
            autoYes: Boolean(run.autoApprove),
          }),
          approvals: run.approvalsTally ?? emptyApprovalsTally(),
          // 窗口 / 预算各带来源（口径同 CLI）：记**这次运行实际按哪份计划跑的**（buildConfig 留下的），
          // 不是收尾时重算的——本次才学到的窗口属于下一次运行
          context: {
            window: ledgerContextPlan.window,
            windowSource: ledgerContextPlan.windowSource,
            budget: ledgerContextPlan.budget,
            budgetSource: ledgerContextPlan.budgetSource,
          },
          // OBS-02：成本与界面读的是同一份 costFace，两处不许各算一遍
          cost: costFace,
        }),
        ledgerFile,
      );
    }

    // B2：收尾状态整写进档案，然后修剪（判据③）。在跑的 run 受保护不删。
    // 修剪排在本 run 的写入链上：直接 fire-and-forget 会与自己的 meta 写赛跑，
    // 读盘时档案未成形、计数不足就漏剪
    run.conversationRecap = recapFromRunEvents(run);
    if (!run.title) run.title = summarizeTitle(run.task);
    finalizeDurableState(run, endInfo);
    persistMeta(run);
    if (realHost && run.conversationTurn === 1) {
      void refineRunTitle(run);
    }
    if (historyRoot && run.archiveWriter) {
      const running = new Set(
        [...runs.values()].filter((r) => r.status === "running").map((r) => r.id),
      );
      run.archiveWriter.schedule(() => pruneHistory(historyRoot, historyKeep, running));
    }
    pruneStoredRuns();

    /**
     * 信息队列：本轮正常收尾后把排队指令自动续跑（steer 余量一并并入）。
     * closed（宿主关停）不续——那不是 run 自己跑完，是进程要没了。
     * 放在收尾**最后**：flush 内部会把 run 重新置回 running 并开启新一轮，
     * 上面的台账 / 档案修剪都必须还按"这一轮已结束"的口径记。
     */
    if (endInfo.outcome !== "closed") {
      void flushQueuedMessagesAfterDone(run).catch((error) => {
        operationalLog("warn", "queue_flush_failed", {
          runId: run.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  async function refineRunTitle(run: StoredRun): Promise<void> {
    const fallback = summarizeTitle(run.task);
    // 附件行会把整段 task 撑过 24 字，不能拿它决定要不要花一次模型。
    if (titleSourceText(run.task).length <= 24) {
      run.title = fallback;
      persistMeta(run);
      return;
    }
    try {
      const turn = await modelClient.send({
        system: [{ type: "text", text: TITLE_SYSTEM }],
        messages: [{ role: "user", content: titleSourceText(run.task).slice(0, 800) || String(run.task).slice(0, 800) }],
        tools: [],
        maxTokens: 48,
        effort: "low",
      });
      const text = (turn.message.content ?? [])
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      run.title = resolveRunTitle(sanitizeGeneratedTitle(text) ?? undefined, run.task);
    } catch {
      run.title = fallback;
    }
    persistMeta(run);
    broadcastLifecycle("run_updated", run);
  }

  /** 启动一次不带核查的运行 */
  async function startPlainRun(run: StoredRun): Promise<void> {
    const epoch = tryClaimTurnDriver(run);
    if (epoch == null) return;
    await ensureMcp(run.packName ? getPack(run.packName) : pack); // 必须在 buildConfig 之前：工具面要么齐要么别开跑
    if (!(await pushRunConfig(run))) {
      finalizeRun(run, {
        outcome: "error",
        mainStopReason: "execution_unavailable",
        error: ledgerErrorClass("execution_unavailable"),
      }, epoch);
      return;
    }
    applyDurableTransition(run, { type: "start" });
    const cfg = await buildRunConfig(run);
    // 信息队列·插队：drain 直接读 run 上的队列（取空语义），loop 在每次模型调用前取
    cfg.steering = { drain: () => (run.steeringQueue ?? []).splice(0) };
    // V-28：实例留给后续对话轮复用——重建的话 ContextManager 的 lastInputTokens
    // 归零，续跑第一轮的压缩判据会失准
    const loop = new AgentLoop(cfg, modelClient);
    run.loop = loop;
    let mainStopReason: string | undefined;
    let mainError: string | null = null;
    try {
      for await (const event of loop.run(firstTurnPrompt(run), run.abort?.signal)) {
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
      }, epoch);
    }
  }

  /**
   * 判了 previousTurn 那一轮的裁决——裁决只对它核查的那一轮负责，隔着一轮未核查的
   * 对话就不再附给执行者。活 run 读内存里的 outcome；归档父级读 meta 落盘的
   * outcome（含 judgedTurn）。同进程追加与重启后派生**必须从这一个口径取**，
   * 否则执行者听到的话会因为宿主重启过而少一段。
   */
  function verdictJudging(run: StoredRun, previousTurn: number): Verdict | undefined {
    if (run.outcome) {
      const lastVerdict = run.outcome.verifications.at(-1)?.verdict;
      return lastVerdict && run.outcomeTurn === previousTurn ? lastVerdict : undefined;
    }
    const archived = run.archivedOutcome;
    if (archived?.judgedTurn === previousTurn && isVerdictShape(archived.verdict)) return archived.verdict;
    return undefined;
  }

  /**
   * 本轮交给执行者的完整反馈 = 委托方这句话 + 它需要知道的上下文：
   *   · 上一轮若核查过 → 附裁决摘要（执行者要知道刚才被判了什么，正史里没有它）；
   *   · 无正史可续（执行阶段就失败 / 计划编排）→ 附原任务或计划摘要作开局背景。
   * 委托方的原话原样在最前面；事件流里 user_message 只记原话，附加段是宿主的装配。
   * 同进程追加 / 归档派生两条入口共用；派生时裁决来自父档案，由调用方传入。
   */
  /**
   * 新开「继续」类任务：从同 workdir 最近一条非相对指代会话抽开机背景。
   * 不继承正史，只防模型空口说「没有任何任务记录」。
   */
  function resolveSiblingBootContext(task: string, runWorkdir: string, selfId: string): string | undefined {
    if (!isRelativeContinuation(task)) return undefined;
    const root = resolve(runWorkdir);
    let best: StoredRun | undefined;
    for (const r of runs.values()) {
      if (r.id === selfId) continue;
      if (resolve(r.workdir ?? workdir) !== root) continue;
      if (isRelativeContinuation(r.task)) continue;
      if (!best || r.createdAt > best.createdAt) best = r;
    }
    if (!best) return undefined;
    return formatSiblingBootContext({
      title: resolveRunTitle(best.title, best.task),
      task: best.task,
      recap: best.conversationRecap || recapFromRunEvents(best) || null,
      conversationTurn: best.conversationTurn,
    });
  }

  /** 首轮任务书 = 原话 + 点名引用 + sibling boot。两段分开装配，不改 sibling 默认文案。 */
  function firstTurnPrompt(run: StoredRun): string {
    const extras = [run.citeContext, run.bootContext].filter((s): s is string => Boolean(s?.trim()));
    return withBootContext(run.task, extras.length ? extras.join("\n\n") : undefined);
  }

  async function assembleCitedRefs(
    citedRunIds: string[],
    targetWorkdir: string,
  ): Promise<{ block: string; refs: NonNullable<StoredRun["cited"]> }> {
    if (!citedRunIds.length) return { block: "", refs: [] };
    const root = resolve(targetWorkdir);
    const artifacts = await resolveCiteArtifacts(root);
    const refs: CiteRef[] = [];
    for (const id of citedRunIds) {
      const r = runs.get(id);
      if (!r) continue;
      if (resolve(r.workdir ?? workdir) !== root) continue;
      refs.push({
        runId: r.id,
        title: resolveRunTitle(r.title, r.task),
        task: oneLineTask(r.task),
        recap: r.conversationRecap || recapFromRunEvents(r) || null,
        artifacts,
      });
    }
    return {
      block: formatCiteBlock(refs),
      refs: refs.map((c) => ({ runId: c.runId, title: c.title, artifacts: c.artifacts })),
    };
  }

  function executorSwitchOf(run: StoredRun): {
    changed: boolean;
    fromModel: string | null;
    toModel: string;
  } {
    const roleId = modelStoreState.store.roles.executor ?? "";
    const identityKey = endpointIdentityKey(executorIdentity);
    const changed = shouldTreatAsExecutorSwitch(
      { roleId: run.lastExecutorRoleId, identityKey: run.lastExecutorIdentityKey },
      { roleId, identityKey },
    );
    return { changed, fromModel: run.lastExecutorModel ?? null, toModel: executorModelName };
  }

  function rememberExecutorFingerprint(run: StoredRun): void {
    const roleId = modelStoreState.store.roles.executor;
    if (roleId) run.lastExecutorRoleId = roleId;
    run.lastExecutorIdentityKey = endpointIdentityKey(executorIdentity);
    run.lastExecutorModel = executorModelName;
  }

  function historyForContinuation(
    run: StoredRun,
    switchInfo: { changed: boolean },
  ): Anthropic.MessageParam[] | undefined {
    const raw = run.history?.length ? run.history : undefined;
    if (!raw) return undefined;
    // 思考块带上一家的 signature；原样转给新模型轻则被忽略、重则整段 400，
    // 看起来就像「换模型等于新开对话」。同模型续跑必须留签名（Claude 多轮需要）。
    return switchInfo.changed ? stripThinkingFromMessages(raw) : raw;
  }

  function composeTurnFeedback(
    run: StoredRun,
    feedback: string,
    previousTurn: number,
    history: Anthropic.MessageParam[] | undefined,
    lastVerdict: Verdict | undefined = verdictJudging(run, previousTurn),
    opts: { executorChanged?: boolean } = {},
  ): string {
    const parts = [feedback];
    if (lastVerdict) parts.push(verdictFeedbackSummary(lastVerdict, previousTurn));
    const planSummary = run.planSummary ?? archivedPlanSummary(run);
    const sketch = buildThreadSketch(
      run.events.map((item) => ({ source: item.source, event: item.event as ThreadEventLike["event"] })),
    );
    const recap = run.conversationRecap || recapFromRunEvents(run) || null;
    const relative = isRelativeContinuation(feedback);
    if (opts.executorChanged) {
      const sw = executorSwitchOf(run);
      parts.push(
        buildExecutorSwitchBriefing({
          task: run.task,
          fromModel: sw.fromModel,
          toModel: sw.toModel,
          conversationRecap: recap,
          threadSketch: sketch || null,
        }),
      );
      if (!history) {
        parts.push(
          buildFreshTurnBackground({
            task: run.task,
            planSummary,
            conversationRecap: recap,
            threadSketch: sketch || null,
            bootContext: run.bootContext ?? null,
          }),
        );
      }
      const gitBriefOnSwitch = buildWorkspaceGitBriefing(run.workspaceGit);
      if (gitBriefOnSwitch) parts.push(gitBriefOnSwitch);
      return parts.join("\n\n");
    }
    // 无正史 → 完整开局背景。
    // 有正史也必须钉本对话锚点：只认「继续」会漏掉「还能再优化吗」这类省略问句，
    // 模型就去 workdir 里找「它」（liquid-demo 站点 vs 本场 PPT）。
    // 编排追问不喂正史、只喂 feedback，缺锚点时同目录另一场会话会填坑。
    if (!history) {
      parts.push(
        buildFreshTurnBackground({
          task: run.task,
          planSummary,
          conversationRecap: recap,
          threadSketch: sketch || null,
          bootContext: run.bootContext ?? null,
        }),
      );
    } else if (relative || feedback.trim().length <= 80) {
      parts.push(
        buildContinuationAnchor({
          task: run.task,
          planSummary,
          conversationRecap: recap,
          threadSketch: sketch || null,
        }),
      );
    }
    const gitBrief = buildWorkspaceGitBriefing(run.workspaceGit);
    if (gitBrief) parts.push(gitBrief);
    return parts.join("\n\n");
  }

  /**
   * 追加一轮对话（V-28 → 会话中心化）。
   *
   * `AgentLoop.runContinuation` 早就存在——它是为返工的 inherit 模式建的；多轮
   * 对话在 harness 层一直可行，只是 Web 宿主从没接。现在的语义（委托方拍板）：
   *   · **error 只结束这一轮**，不结束对话——没正史就从头开一轮，不再 409；
   *   · **核查 / 编排是逐轮选项**，不是 run 级封印：核查过的轮次续跑接执行者
   *     最后一段（返工过就接返工段）的正史，裁决留在事件流里带 judgedTurn；
   *     plan run 以计划摘要为种子按单执行者继续（续的是对话，不是 DAG）；
   *   · 每轮可选是否核查（缺省沿用上一轮）；核查者仍是全新上下文。
   *
   * 每轮**新建** AgentLoop：预算与 Context 水位从检查点延续（fork / 同 run 热恢复
   * 同一口径），单段 maxTurns 重新起算，AGENT_TOTAL_* 沿执行谱系累计不重置。
   */
  async function startConversationTurn(
    run: StoredRun,
    feedback: string,
    turn: {
      verify: boolean;
      orchestrate?: boolean;
      planGate?: boolean;
      concurrency?: number | "auto";
      /** AGENT-01：带着上一份节点状态重跑 planner，而不是单执行者追问 */
      replan?: boolean;
      /** 路由已占住的驱动世代；缺省则本函数自己占 */
      driverEpoch?: number;
    },
  ): Promise<void> {
    const epoch = turn.driverEpoch !== undefined
      ? (run.turnDriverActive && run.turnDriverEpoch === turn.driverEpoch ? turn.driverEpoch : null)
      : tryClaimTurnDriver(run);
    if (epoch == null) return;
    const previousTurn = run.conversationTurn;
    const switchInfo = executorSwitchOf(run);
    const history = historyForContinuation(run, switchInfo);

    run.status = "running";
    delete run.finishedAt;
    run.conversationTurn += 1;
    run.turnExecutorTurns = 0; // 台账 turns 按对话轮计，新一轮从零累计
    run.verify = turn.verify;
    const previousMode = run.mode;
    const doReplan = Boolean(turn.replan && run.planNodes?.length);
    if (turn.orchestrate || doReplan) {
      run.mode = "plan";
      run.concurrency = turn.concurrency ?? (turn.planGate ? 1 : "auto");
      run.planGate = Boolean(turn.planGate);
    } else {
      delete run.mode;
      delete run.concurrency;
      delete run.planGate;
    }
    // 上一轮按了停止的话 abort 位还立着；新一轮是新的决定，要新的闸
    const abort = new AbortController();
    run.abort = abort;
    // meta 必须是新一轮的**第一笔**落盘：崩溃恢复靠 meta.status=running 判"当时在跑"。
    // 先写 state(reopen) 再写 meta 的话，两笔之间被硬杀 → meta 还说 done、state 已说
    // executing，重启后会被当成一个正常收尾的档案（CI 实测抓到的窗口）
    persistMeta(run); // 追加轮开始也要进档案：轮数与"回到运行中"都是状态
    // 等它真的落盘再往下：写链是异步的，不等的话新一轮的事件可能已经通过 SSE 被人看见、
    // 宿主随即被杀，而盘上 meta 还停在上一轮的 done——恢复时就会把一个"跑到一半"的
    // run 当成正常收尾的档案（CI 实测）。代价是一次 rename 的等待，在任何模型调用之前
    await run.archiveWriter?.flush();
    // 终态 → executing：state.json 在两轮之间说"这一轮完了"，新一轮显式 reopen
    applyDurableTransition(run, { type: "reopen" });

    // 追加的这句话本身要进事件流：它是会话的一部分，也是"这一段为什么开始"的解释。
    // verify 是本轮的核查设置（前端 reducer 据此判断 done 是不是 run 终止）；
    // continues 说清这一轮接的是什么：正史 / 计划摘要 / 重规划 / 从头
    pushSyntheticEvent(run, "host", {
      type: "user_message",
      turn: run.conversationTurn,
      text: feedback,
      verify: turn.verify,
      continues: doReplan
        ? "replan"
        : turn.orchestrate
          ? "fresh"
          : history
            ? "history"
            : previousMode === "plan"
              ? "plan-summary"
              : "fresh",
      ...(switchInfo.changed ? { executorSwitched: true } : {}),
      at: Date.now(),
    });
    broadcastLifecycle("run_updated", run);

    // 预算与水位从检查点延续。本请求若已自动续过跑道（或点过「追加预算」），
    // resumeBudget 已经是新上限——再用 restoredBudget 按宿主默认夹回去，
    // 「发送即续」等于没续。归档派生仍走 restoredBudget，重启不能洗掉旧账。
    if (run.checkpoint) {
      run.resumeBudget =
        run.resumeBudget ?? restoredBudget(run.checkpoint, { maxTotalTurns, maxTokensBudget });
      run.initialContextInputTokens = run.checkpoint.contextInputTokens;
    }
    const executorFeedback = composeTurnFeedback(
      run,
      feedback,
      previousTurn,
      history,
      verdictJudging(run, previousTurn),
      { executorChanged: switchInfo.changed },
    );
    if (doReplan) {
      await startPlannedRun(run, executorFeedback, {
        replan: {
          originalTask: run.task,
          feedback,
          nodes: run.planNodes!,
          handoffs: run.planHandoffs ?? {},
        },
        skipClarifier: true,
        driverEpoch: epoch,
      });
      return;
    }
    if (turn.orchestrate) {
      await startPlannedRun(run, executorFeedback, { skipClarifier: true, driverEpoch: epoch });
      return;
    }
    await executeTurn(run, {
      history,
      feedback,
      executorFeedback,
      verify: turn.verify,
      signal: abort.signal,
      driverEpoch: epoch,
    });
  }

  /**
   * 一轮执行的公共尾部——同进程追加 / 归档派生 / 同 run 热恢复三条入口共用：
   * 装配（MCP / 准入探针 / 配置）→ 核查轮或普通轮 → 收尾。
   * 调用方已把本轮的 user_message 与谱系事件推进事件流、把 run 置为 running。
   *
   * finalizeRun 已把上一段的 broker 从 run 上摘除并启动回收；本轮由 buildRunConfig
   * 绑一个经过强制探针的新 broker，不复用已 dispose 的旧实例。
   */
  async function executeTurn(
    run: StoredRun,
    turn: {
      history: Anthropic.MessageParam[] | undefined;
      /** 委托方原话——核查者的核查对象 */
      feedback: string;
      /** 交给执行者的完整输入（原话 + 裁决摘要 / 开局背景） */
      executorFeedback: string;
      verify: boolean;
      signal: AbortSignal;
      driverEpoch: number;
    },
  ): Promise<void> {
    await ensureMcp(run.packName ? getPack(run.packName) : pack);
    if (!(await pushRunConfig(run))) {
      finalizeRun(run, {
        outcome: "error",
        mainStopReason: "execution_unavailable",
        error: ledgerErrorClass("execution_unavailable"),
      }, turn.driverEpoch);
      return;
    }
    const cfg = await buildRunConfig(run);
    // 信息队列·插队：drain 直接读 run 上的队列（取空语义）；核查轮由
    // runVerifiedTurn 自己挂（核查者的配置必须在 orchestrate 里剥掉它）
    cfg.steering = { drain: () => (run.steeringQueue ?? []).splice(0) };

    if (turn.verify) {
      // 核查者核查的是本轮指令（原任务只作背景）；执行者在正史上续跑或从头开一轮
      await runVerifiedTurn(run, cfg, continuationVerifyTask(run.task, turn.feedback), {
        ...(turn.history ? { history: turn.history } : {}),
        feedback: turn.executorFeedback,
      }, turn.driverEpoch);
      return;
    }

    const loop = new AgentLoop(cfg, modelClient);
    run.loop = loop;
    let mainStopReason: string | undefined;
    let mainError: string | null = null;
    try {
      const events = turn.history
        ? loop.runContinuation(turn.history, turn.executorFeedback, turn.signal)
        : loop.run(turn.executorFeedback, turn.signal);
      for await (const event of events) {
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
        messageCount: turn.history?.length ?? 0,
        usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, turns: 0, cacheHitRatio: 0 },
      });
    } finally {
      finalizeRun(run, {
        outcome: runOutcomeForStopReason(mainStopReason),
        ...(mainStopReason ? { mainStopReason } : {}),
        ...(mainError || mainStopReason === "error" ? { error: mainError ?? ledgerErrorClass("error") } : {}),
      }, turn.driverEpoch);
    }
  }

  /**
   * Phase 2：同 runId 从检查点热恢复。
   *
   * 与 fork 的差别：不新建 run、不写 continuedFrom、首条事件是 run_resumed。
   * 诚实边界：不恢复 AbortController 以外的"原进程"——loop 是新建的；
   * active grant 一律不继承。
   * 单执行者：从最后提交的 main checkpoint 续跑。
   * 半截 DAG：注入同一张图，跳过 passed；不重跑 planner、不重开计划门。
   */
  async function startSameRunResume(
    run: StoredRun,
    feedback: string,
    parentApprovalGrants: readonly ArchivedApprovalGrant[] = [],
    turn: {
      verify: boolean;
      orchestrate?: boolean;
      planGate?: boolean;
      concurrency?: number | "auto";
    } = { verify: false },
  ): Promise<void> {
    const switchInfo = executorSwitchOf(run);
    const history = historyForContinuation(run, switchInfo);
    const dagFacts = run.mode === "plan" ? planResumeFacts(run.durableState?.plan) : undefined;
    const dagResume = Boolean(
      dagFacts?.approved && dagFacts.hasPassedNode && !dagFacts.hasFailedNode && dagFacts.hasRemainingNode,
    );
    const inheritedBudget = run.resumeBudget ?? run.durableState?.budget ?? undefined;
    if (dagResume) {
      const nodes =
        run.planNodes ??
        (run.durableState?.plan?.nodes ? planNodesFromDurable(run.durableState.plan.nodes) : []);
      if (!nodes.length) {
        pushSyntheticEvent(run, "host", {
          type: "run_resume_failed",
          reason: "半截 DAG 恢复缺少节点快照",
          at: Date.now(),
        });
        finalizeRun(run, {
          outcome: "error",
          mainStopReason: "error",
          error: ledgerErrorClass("半截 DAG 恢复缺少节点快照"),
        });
        return;
      }
      run.planNodes = nodes;
      run.planHandoffs = run.planHandoffs ?? handoffsFromPlanNodes(nodes);
      run.injectedPlan = planFromNodes(nodes);
      if (!run.resumeBudget && run.durableState?.budget) {
        run.resumeBudget = { ...run.durableState.budget };
      }
    } else if (!history?.length || !inheritedBudget) {
      pushSyntheticEvent(run, "host", {
        type: "run_resume_failed",
        reason: "同 run 恢复缺少正史或预算快照",
        at: Date.now(),
      });
      finalizeRun(run, {
        outcome: "error",
        mainStopReason: "error",
        error: ledgerErrorClass("同 run 恢复缺少正史或预算快照"),
      });
      return;
    }

    const epoch = tryClaimTurnDriver(run);
    if (epoch == null) return;

    const resumeAt = Date.now();
    applyDurableTransition(run, { type: "resume", at: resumeAt });

    pushSyntheticEvent(run, "host", {
      type: "run_resumed",
      runId: run.id,
      rootRunId: run.rootRunId ?? run.id,
      boundary: dagResume
        ? "同 run 热恢复：按已落盘的计划节点续发射半截 DAG；已通过的子任务不重跑；不恢复原进程 loop/审批回调/active grant；不重开计划确认门。"
        : "同 run 热恢复：从最后提交的 main 检查点续跑；不恢复原进程 loop/审批回调/active grant；" +
          "SAFE-06 toolTx 从 state.json 种子化（同 key 不重复 commit）；续跑入口仍是 checkpoint 段号；" +
          "若正史末条悬空 tool_use，AgentLoop 按 mid-tool 计划幂等重放 / bash fail-closed。",
      checkpoint: {
        conversationTurn: run.conversationTurn - 1,
        contextInputTokens: run.initialContextInputTokens ?? 0,
        segmentIndex: run.checkpoint?.segmentIndex ?? null,
        runBudget: inheritedBudget ? { ...inheritedBudget } : { usedTurns: 0, usedTokens: 0 },
      },
      reset: ["审批放行规则", "挂起交互", "ask_user 已用配额", "AbortController", "AgentLoop"],
      at: resumeAt,
    });
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
        reason: "same_run_resume_no_active_grant",
        actor: "system",
        at: approvalClock(),
      });
    }
    pushSyntheticEvent(run, "host", {
      type: "user_message",
      turn: run.conversationTurn,
      text: feedback,
      verify: turn.verify,
      continues: "history",
      ...(switchInfo.changed ? { executorSwitched: true } : {}),
      at: Date.now(),
    });
    broadcastLifecycle("run_updated", run);

    if (dagResume && run.planNodes?.length) {
      const kept = run.planNodes.filter((n) => n.status === "passed").map((n) => n.id);
      const remaining = run.planNodes
        .filter((n) => n.status === "pending" || n.status === "running")
        .map((n) => n.id);
      pushSyntheticEvent(run, "host", hostPlanResumeEvent({ kept, remaining, reason: feedback }));
      persistMeta(run);
      await startPlannedRun(run, firstTurnPrompt(run), {
        resume: { nodes: run.planNodes, handoffs: run.planHandoffs ?? {} },
        driverEpoch: epoch,
      });
      return;
    }

    if (turn.orchestrate) {
      run.mode = "plan";
      run.concurrency = turn.concurrency ?? (turn.planGate ? 1 : "auto");
      run.planGate = Boolean(turn.planGate);
      persistMeta(run);
      await startPlannedRun(run, feedback, { skipClarifier: true, driverEpoch: epoch });
      return;
    }

    await executeTurn(run, {
      history,
      feedback,
      executorFeedback: switchInfo.changed
        ? composeTurnFeedback(
            run,
            feedback,
            run.conversationTurn - 1,
            history,
            undefined,
            { executorChanged: true },
          )
        : feedback,
      verify: turn.verify,
      signal: run.abort?.signal ?? new AbortController().signal,
      driverEpoch: epoch,
    });
  }

  function historySnapshotForFork(parent: StoredRun): Anthropic.MessageParam[] | undefined {
    if (parent.history?.length) return structuredClone(parent.history);
    const fromCheckpoint = archivedCheckpointHistory(parent);
    if (fromCheckpoint?.length) return fromCheckpoint;
    const last = [...parent.transcript].reverse().find((seg) => isExecutorLineageSource(seg.source));
    if (last && isMessageHistory(last.messages)) return structuredClone(last.messages);
    return undefined;
  }

  /**
   * Cursor 式分叉：复制当前对话快照成一条新的已完成 run，不启动模型。
   * 父 run 原样不动（运行中也不掐）。后续追问走子 run 的 /messages。
   */
  async function snapshotConversationFork(parent: StoredRun): Promise<StoredRun> {
    await hydrateArchive(parent);
    const id = randomUUID();
    const now = Date.now();
    const events = parent.events.map((item, index) => {
      const clone = structuredClone(item) as SSEEvent;
      return { ...clone, seq: index };
    });
    const history = historySnapshotForFork(parent);
    const checkpoint = parent.checkpoint
      ? (() => {
          const copy = structuredClone(parent.checkpoint);
          delete copy.approvalGrants;
          return copy;
        })()
      : undefined;
    const child: StoredRun = {
      id,
      task: parent.task,
      ...(parent.title ? { title: parent.title } : {}),
      status: "done",
      verify: parent.verify,
      createdAt: now,
      finishedAt: now,
      events,
      pendingApprovals: new Map(),
      respondedApprovals: new Map(),
      respondedToolUseIds: new Set(),
      sseClients: new Set(),
      segmentIndex: parent.segmentIndex,
      transcript: parent.transcript.map((seg) => structuredClone(seg)),
      conversationTurn: parent.conversationTurn,
      toolTally: { ...parent.toolTally },
      continuedFrom: parent.id,
      rootRunId: parent.rootRunId ?? parent.id,
      mainStopReason: parent.mainStopReason ?? "completed",
      ...(history ? { history } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(parent.conversationRecap ? { conversationRecap: parent.conversationRecap } : {}),
      ...(parent.planSummary ? { planSummary: parent.planSummary } : {}),
      ...(parent.packName ? { packName: parent.packName } : {}),
      ...(parent.effort ? { effort: parent.effort } : {}),
      ...(parent.rubric ? { rubric: parent.rubric } : {}),
      ...(parent.workdir ? { workdir: parent.workdir } : {}),
      ...(parent.extraWorkdirs?.length ? { extraWorkdirs: [...parent.extraWorkdirs] } : {}),
      ...(parent.askUser ? { askUser: true } : {}),
      ...(parent.autoApprove ? { autoApprove: true } : {}),
      ...(parent.permissionMode ? { permissionMode: parent.permissionMode } : {}),
      ...(parent.mode === "plan" ? { mode: "plan" as const } : parent.mode === "design" ? { mode: "design" as const } : {}),
      ...(parent.workspace === "office" || parent.workspace === "code"
        ? { workspace: parent.workspace }
        : parent.mode === "design" || parent.packName === "design"
          ? { workspace: "office" as const }
          : { workspace: "code" as const }),
      ...(parent.contextTokenLimit !== undefined ? { contextTokenLimit: parent.contextTokenLimit } : {}),
      ...(parent.lastExecutorRoleId ? { lastExecutorRoleId: parent.lastExecutorRoleId } : {}),
      ...(parent.lastExecutorIdentityKey ? { lastExecutorIdentityKey: parent.lastExecutorIdentityKey } : {}),
      ...(parent.lastExecutorModel ? { lastExecutorModel: parent.lastExecutorModel } : {}),
      ...(parent.outcome ? { outcome: structuredClone(parent.outcome) } : {}),
      ...(parent.outcomeTurn !== undefined ? { outcomeTurn: parent.outcomeTurn } : {}),
    };
    if (historyRoot) {
      child.archiveWriter = createArchiveWriter(id);
      persistMeta(child);
      seedDurableState(child);
      applyDurableTransition(child, { type: "complete" });
      for (const ev of events) child.archiveWriter?.appendEvent(ev);
      for (const seg of child.transcript) child.archiveWriter?.appendTranscriptSegment(seg);
    } else {
      seedDurableState(child);
      applyDurableTransition(child, { type: "complete" });
    }
    runs.set(id, child);
    metrics.runsStarted += 1;
    if (realHost) {
      operationalLog("info", "run_forked_snapshot", {
        runId: id,
        parentRunId: parent.id,
        events: events.length,
      });
    }
    broadcastLifecycle("run_created", child);
    return child;
  }

  /**
   * 回到某条消息：复制父对话但只留 seq 及之前的事件。
   * 父 run 原样不动。可选按写盘快照还原工作区（bash 不保证）。
   */
  async function snapshotConversationRewind(
    parent: StoredRun,
    seq: number,
    revertFiles: boolean,
  ): Promise<{ child: StoredRun; files: Awaited<ReturnType<typeof applyFileRevert>> | null }> {
    await hydrateArchive(parent);
    await ensureFileRewindSnapshots(parent);
    const kept = truncateEventsToSeq(parent.events, seq);
    const events = kept.map((item, index) => {
      const clone = structuredClone(item) as SSEEvent;
      return { ...clone, seq: index };
    });
    const picked = pickTranscriptForRewind(kept, parent.transcript);
    const conversationTurn = conversationTurnFromEvents(kept);
    const history = picked.history as Anthropic.MessageParam[] | undefined;
    const checkpoint =
      parent.checkpoint
      && parent.checkpoint.conversationTurn <= conversationTurn
      && parent.checkpoint.segmentIndex < picked.segmentIndex
        ? (() => {
            const copy = structuredClone(parent.checkpoint);
            delete copy.approvalGrants;
            return copy;
          })()
        : undefined;

    let files: Awaited<ReturnType<typeof applyFileRevert>> | null = null;
    if (revertFiles) {
      const writes = writesAfterSeq(parent.events, seq);
      const snapshots = new Map(
        (parent.fileRewindSnapshots ?? []).map((record) => [
          record.toolUseId,
          { record, blob: parent.fileRewindBlobs?.get(record.toolUseId) },
        ]),
      );
      const root = parent.workdir ?? workdir;
      const gitOk = await detectGitRepo(root);
      files = await applyFileRevert({
        workdir: root,
        writeRoots: mergeRunReadRoots([...allowedWorkdirs], parent.extraWorkdirs, root),
        gitRoot: gitOk ? root : null,
        writes,
        snapshots,
      });
    }

    const id = randomUUID();
    const now = Date.now();
    const rewindFrom = { parentRunId: parent.id, seq, revertFiles };
    const child: StoredRun = {
      id,
      task: parent.task,
      ...(parent.title ? { title: parent.title } : {}),
      status: "done",
      verify: parent.verify,
      createdAt: now,
      finishedAt: now,
      events,
      pendingApprovals: new Map(),
      respondedApprovals: new Map(),
      respondedToolUseIds: new Set(),
      sseClients: new Set(),
      segmentIndex: picked.segmentIndex,
      transcript: picked.transcript.map((seg) => structuredClone(seg)),
      conversationTurn,
      toolTally: { ...parent.toolTally },
      continuedFrom: parent.id,
      rootRunId: parent.rootRunId ?? parent.id,
      rewindFrom,
      mainStopReason: parent.mainStopReason ?? "completed",
      ...(history ? { history } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(conversationTurn === parent.conversationTurn && parent.conversationRecap
        ? { conversationRecap: parent.conversationRecap }
        : {}),
      ...(parent.planSummary && kept.some((e) => e.event?.type === "plan_result")
        ? { planSummary: parent.planSummary }
        : {}),
      ...(parent.packName ? { packName: parent.packName } : {}),
      ...(parent.effort ? { effort: parent.effort } : {}),
      ...(parent.rubric ? { rubric: parent.rubric } : {}),
      ...(parent.workdir ? { workdir: parent.workdir } : {}),
      ...(parent.extraWorkdirs?.length ? { extraWorkdirs: [...parent.extraWorkdirs] } : {}),
      ...(parent.askUser ? { askUser: true } : {}),
      ...(parent.autoApprove ? { autoApprove: true } : {}),
      ...(parent.permissionMode ? { permissionMode: parent.permissionMode } : {}),
      ...(parent.mode === "plan" ? { mode: "plan" as const } : parent.mode === "design" ? { mode: "design" as const } : {}),
      ...(parent.workspace === "office" || parent.workspace === "code"
        ? { workspace: parent.workspace }
        : parent.mode === "design" || parent.packName === "design"
          ? { workspace: "office" as const }
          : { workspace: "code" as const }),
      ...(parent.contextTokenLimit !== undefined ? { contextTokenLimit: parent.contextTokenLimit } : {}),
      ...(parent.lastExecutorRoleId ? { lastExecutorRoleId: parent.lastExecutorRoleId } : {}),
      ...(parent.lastExecutorIdentityKey ? { lastExecutorIdentityKey: parent.lastExecutorIdentityKey } : {}),
      ...(parent.lastExecutorModel ? { lastExecutorModel: parent.lastExecutorModel } : {}),
      ...(parent.outcome && (parent.outcomeTurn ?? 1) <= conversationTurn
        ? { outcome: structuredClone(parent.outcome), outcomeTurn: parent.outcomeTurn }
        : {}),
    };

    const keptIds = new Set(
      kept
        .filter((e) => e.event?.type === "file_rewind_snapshot" || e.event?.type === "tool_call")
        .map((e) => String((e.event as { toolUseId?: unknown }).toolUseId ?? ""))
        .filter(Boolean),
    );
    if (parent.fileRewindSnapshots?.length) {
      child.fileRewindSnapshots = parent.fileRewindSnapshots.filter((r) => keptIds.has(r.toolUseId));
      child.fileRewindBlobs = new Map(
        [...(parent.fileRewindBlobs ?? [])].filter(([id]) => keptIds.has(id)),
      );
    }

    const rewindEvent: SSEEvent = {
      seq: events.length,
      source: "host",
      ts: now,
      event: {
        type: "conversation_rewound",
        parentRunId: parent.id,
        seq,
        revertFiles,
        ...(files
          ? {
              restored: files.restored,
              deleted: files.deleted,
              gitRestored: files.gitRestored,
              skipped: files.skipped,
            }
          : {}),
      },
    };
    events.push(rewindEvent);
    child.events = events;

    if (historyRoot) {
      child.archiveWriter = createArchiveWriter(id);
      persistMeta(child);
      seedDurableState(child);
      applyDurableTransition(child, { type: "complete" });
      for (const ev of events) child.archiveWriter?.appendEvent(ev);
      for (const seg of child.transcript) child.archiveWriter?.appendTranscriptSegment(seg);
      if (child.fileRewindSnapshots?.length && child.archiveWriter) {
        for (const record of child.fileRewindSnapshots) {
          const blob = child.fileRewindBlobs?.get(record.toolUseId);
          child.archiveWriter.schedule(() => persistRewindSnapshot(child.archiveWriter!.dir, record, blob));
        }
      }
    } else {
      seedDurableState(child);
      applyDurableTransition(child, { type: "complete" });
    }
    runs.set(id, child);
    metrics.runsStarted += 1;
    if (realHost) {
      operationalLog("info", "run_rewound", {
        runId: id,
        parentRunId: parent.id,
        seq,
        revertFiles,
        events: events.length,
      });
    }
    broadcastLifecycle("run_created", child);
    return { child, files };
  }

  /**
   * 从磁盘档案派生一次续跑。
   *
   * 这不是把 archived run “复活”：父档案没有 loop/AbortController，也不应再
   * 接收事件。新 run 只继承可序列化的会话正史、上下文水位、累计预算与任务
   * 装配选择；模型/工具/策略取当前宿主，审批放行与 ask_user 已用配额全部重置。
   *
   * 会话中心化：父档案没有检查点（执行阶段就失败 / 计划编排 / 旧格式）时也能派生
   * ——子 run 以"无正史的新一轮"开局（plan 父档案以计划摘要为种子），预算按当前
   * 宿主上限从零起算；run_forked 事件里 checkpoint 为 null，照实说没继承正史。
   */
  async function startForkedContinuation(
    run: StoredRun,
    feedback: string,
    parentApprovalGrants: readonly ArchivedApprovalGrant[] = [],
    /** previousVerdict：父档案里判了被续那一轮的裁决（调用方按 verdictJudging 取） */
    turn: {
      verify: boolean;
      previousVerdict?: Verdict;
      orchestrate?: boolean;
      planGate?: boolean;
      concurrency?: number | "auto";
    } = { verify: false },
  ): Promise<void> {
    const switchInfo = executorSwitchOf(run);
    const history = historyForContinuation(run, switchInfo);
    const inheritedBudget = run.resumeBudget;
    if (!run.continuedFrom || (history && !inheritedBudget)) {
      pushSyntheticEvent(run, "host", {
        type: "run_fork_failed",
        reason: "派生 run 缺少父级标识，或有正史却缺预算快照",
        at: Date.now(),
      });
      finalizeRun(run, {
        outcome: "error",
        mainStopReason: "error",
        error: ledgerErrorClass("派生 run 缺少父级标识，或有正史却缺预算快照"),
      });
      return;
    }

    const epoch = tryClaimTurnDriver(run);
    if (epoch == null) return;

    applyDurableTransition(run, { type: "start" });

    // 第一条 durable 事件就是环境边界；即使 MCP 连接很慢，人也能立刻看懂
    // 这是从哪里来的、继承了什么、哪些权限状态已清零。
    const parentForRecap = run.continuedFrom ? runs.get(run.continuedFrom) : undefined;
    const priorRecap = parentForRecap
      ? (parentForRecap.conversationRecap || recapFromRunEvents(parentForRecap))
      : "";
    pushSyntheticEvent(run, "host", {
      type: "run_forked",
      parentRunId: run.continuedFrom,
      rootRunId: run.rootRunId ?? run.continuedFrom,
      priorRecap,
      priorTurns: parentForRecap?.conversationTurn ?? 0,
      boundary: history
        ? "从归档检查点派生新运行；会话正史与累计预算延续，模型、工具和策略使用当前宿主，父档案保持只读。"
        : "从无检查点的归档派生新运行：没有可续的执行正史，本轮从头开始（以原任务/计划摘要为背景）；预算按当前宿主上限从零起算，父档案保持只读。",
      checkpoint: history && inheritedBudget
        ? {
            conversationTurn: run.conversationTurn - 1,
            contextInputTokens: run.initialContextInputTokens ?? 0,
            runBudget: { ...inheritedBudget },
          }
        : null,
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
      verify: turn.verify,
      continues: history ? "history" : run.planSummary ? "plan-summary" : "fresh",
      ...(switchInfo.changed ? { executorSwitched: true } : {}),
      at: Date.now(),
    });
    broadcastLifecycle("run_updated", run);

    // 与同进程追加同一个装配函数：原话 + 上一轮裁决摘要 + 无正史时的开局背景
    // （计划摘要 / 原任务）。重启前后执行者必须听到同一套话。
    if (turn.orchestrate) {
      run.mode = "plan";
      run.concurrency = turn.concurrency ?? (turn.planGate ? 1 : "auto");
      run.planGate = Boolean(turn.planGate);
      persistMeta(run);
      await startPlannedRun(run, feedback, { skipClarifier: true, driverEpoch: epoch });
      return;
    }
    await executeTurn(run, {
      history,
      feedback,
      executorFeedback: composeTurnFeedback(
        run,
        feedback,
        run.conversationTurn - 1,
        history,
        turn.previousVerdict,
        { executorChanged: switchInfo.changed },
      ),
      verify: turn.verify,
      signal: run.abort?.signal ?? new AbortController().signal,
      driverEpoch: epoch,
    });
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
  async function startPlannedRun(
    run: StoredRun,
    taskText = firstTurnPrompt(run),
    extras?: {
      replan?: {
        originalTask: string;
        feedback: string;
        nodes: PlanNodeState[];
        handoffs: Record<string, string>;
      };
      resume?: {
        nodes: PlanNodeState[];
        handoffs: Record<string, string>;
      };
      skipClarifier?: boolean;
      driverEpoch?: number;
    },
  ): Promise<void> {
    const epoch = extras?.driverEpoch !== undefined
      ? (run.turnDriverActive && run.turnDriverEpoch === extras.driverEpoch ? extras.driverEpoch : null)
      : tryClaimTurnDriver(run);
    if (epoch == null) return;
    await ensureMcp(run.packName ? getPack(run.packName) : pack);
    if (!(await pushRunConfig(run))) {
      finalizeRun(run, {
        outcome: "error",
        mainStopReason: "execution_unavailable",
        error: ledgerErrorClass("execution_unavailable"),
      }, epoch);
      return;
    }
    if (!extras?.resume) applyDurableTransition(run, { type: "plan_begin" });
    const baseCfg = await buildRunConfig(run);
    const startedAt = Date.now();
    let planReadyAt = startedAt;
    const concurrency = run.concurrency ?? "auto";
    let effectiveConcurrency = typeof concurrency === "number" ? concurrency : 1;
    let mainStopReason: string | undefined;
    let mainError: string | null = null;

    try {
      const usePlanner = run.usePlannerModel ?? true;
      // 重规划不能跳过 planner；半截 DAG 续发射注入同一张图；二者与对方互斥
      const injectPlan = extras?.replan
        ? undefined
        : extras?.resume
          ? planFromNodes(extras.resume.nodes)
          : run.injectedPlan;
      const persistPlanNodes = (nodes: PlanNodeState[]) => {
        run.planNodes = nodes;
        if (!run.durableState?.plan) return;
        applyDurableTransition(run, { type: "plan_progress", nodes: nodes.map(durableNodeFromPlanNode) });
      };
      const outcome = await runPlanned(baseCfg, modelClient, taskText, {
        packs: allPacks(),
        concurrency,
        ...(injectPlan ? { plan: injectPlan } : {}),
        ...(extras?.replan ? { replan: extras.replan } : {}),
        ...(extras?.resume ? { resume: extras.resume } : {}),
        ...(extras?.skipClarifier ? { skipClarifier: true } : {}),
        ...(run.abort ? { signal: run.abort.signal } : {}),
        ...(envPlanMaxTurns !== undefined ? { planMaxTurns: envPlanMaxTurns } : {}),
        ...(plannerRole && usePlanner
          ? { plannerModel: { client: plannerClient!, compat: plannerRole.provider.compat } }
          : {}),
        onReplan: async (diff) => {
          pushSyntheticEvent(run, "host", hostPlanReplanEvent(diff));
        },
        onPlan: async (plan: Plan) => {
          planReadyAt = Date.now();
          if (concurrency === "auto") {
            effectiveConcurrency = Math.min(AUTO_CONCURRENCY_CAP, planParallelWidth(plan.subtasks));
          }
          if (extras?.resume) return;
          const protocol =
            process.env.AGENT_PLAN_PROTOCOL === "structured" ? "structured" : "freeform";
          const pending = planNodesFromSubtasks(plan.subtasks, "pending");
          run.planNodes = pending;
          pushSyntheticEvent(
            run,
            "host",
            hostPlanEvent({
              concurrency: effectiveConcurrency,
              concurrencyMode: concurrency === "auto" ? "auto" : "fixed",
              plannerMs: planReadyAt - startedAt,
              subtasks: hostPlanSubtaskViews(plan.subtasks, (name) => getPack(name)?.resources),
              /** 门开着时前端要知道"这份计划还在等签字"，而不是以为已经在跑了 */
              gated: Boolean(run.planGate),
              ...(extras?.replan ? { replanned: true } : {}),
            }),
          );
          applyDurableTransition(
            run,
            {
              type: "plan_ready",
              plan: durablePlanFromPlan(plan, protocol, pending),
              gated: Boolean(run.planGate),
            },
            planReadyAt,
          );
          // 签字位：计划已发出、一个子任务都还没发射，此时停下是零副作用的
          if (run.planGate) await waitForPlanDecision(run);
        },
        onSubtaskStart: (sub) => {
          const current = run.planNodes ?? [];
          const nodes = current.map((n) =>
            n.id === sub.id ? { ...n, status: "running" as const } : n,
          );
          if (!current.some((n) => n.id === sub.id)) {
            nodes.push({ ...planNodesFromSubtasks([sub], "running")[0]! });
          }
          persistPlanNodes(nodes);
        },
        onSubtaskSettled: (sub, result) => {
          const evidence = evidenceFromVerifiedStep(result);
          const current = run.planNodes ?? [];
          const nodes = current.map((n) =>
            n.id === sub.id
              ? {
                  ...n,
                  status: result.finalPassed ? ("passed" as const) : ("failed" as const),
                  ...(evidence ? { evidenceSummary: evidence } : {}),
                }
              : n,
          );
          if (!current.some((n) => n.id === sub.id)) {
            nodes.push({
              ...planNodesFromSubtasks([sub], result.finalPassed ? "passed" : "failed")[0]!,
              ...(evidence ? { evidenceSummary: evidence } : {}),
            });
          }
          persistPlanNodes(nodes);
          if (result.finalPassed && evidence) {
            run.planHandoffs = { ...(run.planHandoffs ?? {}), [sub.id]: evidence };
          }
          const budget = result.main.runBudget;
          if (budget) {
            applyDurableTransition(run, {
              type: "budget_snapshot",
              budget: { ...budget } as DurableBudgetSnapshot,
            });
            run.resumeBudget = { ...budget };
          }
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
          const domainTools = injectedTools ?? selectPackTools(sp, toolPool, mcpTools);
          const proposeForSub = sp?.handoffs?.length
            ? [(run.proposeHandoffTool ??= makeProposeHandoffTool(run))]
            : [];
          return {
            cfg: {
              ...baseCfg,
              systemPrompt: sp?.systemPrompt ?? baseCfg.systemPrompt,
              // 逐子任务按各自的包收窄 MCP 工具面：stm32-coding 的 mcp:false
              // 拿不到任何 MCP 工具，stm32-debug 才拿到它 includeTools 里那些
              tools: [...domainTools, ...controlTools, ...proposeForSub].filter(
                (tool, i, all) => all.findIndex((candidate) => candidate.name === tool.name) === i,
              ),
              ...(sp?.guardrails?.maxTurns !== undefined ? { maxTurns: sp.guardrails.maxTurns } : {}),
              ...(sp?.guardrails?.maxTokens !== undefined && maxTokens === undefined
                ? { maxTokens: sp.guardrails.maxTokens }
                : {}),
              // 逐子任务按各自的包取恢复策略（与核查预算同款）；完成门关着时不装
              ...(baseCfg.requireTerminalTool ? { recovery: recoveryFor(sp).policy } : {}),
            },
            verify: {
              ...(sp?.verify.instructions ? { verifyInstructions: sp.verify.instructions } : {}),
              // 无包子任务同样拿通用缺省（planner 漏写 pack 的子任务就是无包）
              ...(readOnlyFor(sp).commands.length ? { verifyReadOnlyCommands: readOnlyFor(sp).commands } : {}),
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
          growTokens("verification", vo.usage, run);
        },
        // 跨 run 资源互斥：把宿主表注入调度器——子任务粒度互斥，被别的 run
        // 持有时等待而非 skip；holder 前缀 = runId，冲突诊断可读
        resources: hostResources,
        resourceHolder: run.id,
      });

      const finishedAt = Date.now();
      mainStopReason = plannedStopReason(outcome);
      if (mainStopReason === "error") {
        const failed = outcome.steps.find((st) => st.result.main.stopReason === "error");
        mainError = failed?.result.main.error
          ? ledgerErrorClass(failed.result.main.error)
          : ledgerErrorClass(outcome.planOutcome.failureSummary ?? "plan_failed");
      }

      // 并行收益的口径必须写清：子任务阶段墙钟排除 planner，"节省"是相对
      // 串行全序和而言的。不标口径的数字等于没有数字。
      pushSyntheticEvent(
        run,
        "host",
        hostPlanResultEvent(outcome, { startedAt, planReadyAt, finishedAt }),
      );

      // 会话中心化：下一轮对话的种子——续的是对话，不是 DAG。与归档重建走同一个纯函数。
      run.planSummary = buildPlanSummary({
        task: run.task,
        stopReason: mainStopReason,
        subtasks: (outcome.plan?.subtasks ?? []).map((t) => ({
          id: t.id, title: t.title, pack: t.pack ?? null, description: t.description,
        })),
        steps: outcome.steps.map((st) => ({
          id: st.sub.id,
          title: st.sub.title,
          pack: st.sub.pack ?? null,
          passed: st.result.finalPassed,
          reworks: st.result.reworks,
          stopReason: st.result.main.stopReason,
          completion: st.result.main.completion
            ? { summary: st.result.main.completion.summary, artifacts: st.result.main.completion.artifacts }
            : null,
          verdict: st.result.verifications.at(-1)?.verdict ?? null,
        })),
        skipped: outcome.skipped.map((t) => ({ id: t.id, title: t.title })),
        completed: outcome.completed,
        plannerFailure: outcome.planOutcome.failureSummary,
      });
      // AGENT-01：节点状态落内存，供下一轮 replan:true 使用
      if (outcome.plan) {
        const seeded = planNodesFromOutcome({
          subtasks: outcome.plan.subtasks,
          steps: outcome.steps.map((st) => ({
            id: st.sub.id,
            passed: st.result.finalPassed,
            completion: st.result.main.completion
              ? { summary: st.result.main.completion.summary, artifacts: st.result.main.completion.artifacts }
              : null,
            verdict: st.result.verifications.at(-1)?.verdict ?? null,
          })),
          skipped: outcome.skipped.map((t) => ({ id: t.id })),
        });
        run.planNodes = seeded.nodes;
        run.planHandoffs = seeded.handoffs;
      }
      // 全部子任务共用一份执行总账（planExecutionBudget）；任一步的收尾快照就是
      // 整场编排的累计读数——下一轮单执行者从这里接着记，续跑不重置总账
      const planBudget = outcome.steps.at(-1)?.result.main.runBudget;
      if (planBudget) run.resumeBudget = { ...planBudget };
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
      // 编排没跑起来（计划被否 / 宿主级异常）也要留下对话种子：下一轮从头开一轮，
      // 但执行者得知道"之前那次编排为什么没成"
      run.planSummary = buildPlanSummary({
        task: run.task,
        stopReason: mainStopReason,
        subtasks: [],
        steps: [],
        skipped: [],
        completed: false,
        plannerFailure: err instanceof PlanRejectedError ? errorMsg : `编排异常终止：${errorMsg}`,
      });
    } finally {
      finalizeRun(run, {
        // 门未应答归 closed、明确否决归 rejected；与其它 stopReason 共用唯一映射。
        outcome: runOutcomeForStopReason(mainStopReason),
        ...(mainStopReason ? { mainStopReason } : {}),
        ...(mainError || mainStopReason === "error" ? { error: mainError ?? ledgerErrorClass("error") } : {}),
      }, epoch);
    }
  }

  /** 启动一次带核查的运行 */
  async function startVerifiedRun(run: StoredRun): Promise<void> {
    const epoch = tryClaimTurnDriver(run);
    if (epoch == null) return;
    await ensureMcp(run.packName ? getPack(run.packName) : pack);
    if (!(await pushRunConfig(run))) {
      finalizeRun(run, {
        outcome: "error",
        mainStopReason: "execution_unavailable",
        error: ledgerErrorClass("execution_unavailable"),
      }, epoch);
      return;
    }
    applyDurableTransition(run, { type: "start" });
    const cfg = await buildRunConfig(run);
    // 信息队列·插队（核查轮同口径；核查者的配置在 orchestrate 里被剥掉这个钩子）
    cfg.steering = { drain: () => (run.steeringQueue ?? []).splice(0) };
    await runVerifiedTurn(run, cfg, firstTurnPrompt(run), undefined, epoch);
  }

  /**
   * 跑一轮带核查的执行并收尾——首轮（task 即任务）与续跑轮（continuation 给正史与
   * 本轮反馈，task 是 continuationVerifyTask 组好的核查任务书）共用。
   *
   * 裁决带 `judgedTurn`：核查是逐轮选项之后，一份裁决只对它核查的那一轮负责，
   * 事件流里必须写明它判的是第几轮，否则第 1 轮的"通过"会被读成整场对话的通过。
   */
  async function runVerifiedTurn(
    run: StoredRun,
    cfg: AgentConfig,
    task: string,
    continuation?: VerifiedRunOptions["continuation"],
    driverEpoch?: number,
  ): Promise<void> {
    const judgedTurn = run.conversationTurn;
    let mainStopReason: string | undefined;
    let mainError: string | null = null;
    try {
      const outcome = await runVerified(cfg, modelClient, task, {
        ...buildVerifyOptions(run),
        ...(run.abort ? { signal: run.abort.signal } : {}),
        ...(continuation ? { continuation } : {}),
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
          growTokens("verification", vo.usage, run);
          pushSyntheticEvent(run, "verifier", {
            type: "verification",
            round,
            judgedTurn,
            verdict: vo.verdict,
            usage: vo.usage,
            // 裁决是怎么拿到的（direct/wrapup/reformat/failed）——让 fail-closed
            // 的三种误伤形态可计量，也是 §2.1 该不该做的判据
            recovery: vo.recovery,
          });
        },
      });
      run.outcome = outcome;
      run.outcomeTurn = judgedTurn;
      // 追加 verdict 合成事件（末轮裁决，保持既有契约）
      const lastVerdict = outcome.verifications.at(-1)?.verdict;
      if (lastVerdict) {
        pushSyntheticEvent(run, "verifier", { type: "verdict", judgedTurn, verdict: lastVerdict });
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
      }, driverEpoch);
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

    for (const evt of annotateApprovalReplay(run.events)) {
      if (evt.seq <= from) continue;
      res.write(frameFor(evt));
    }
    // 历史重放结束标记。切会话时 EventSource 会把缓冲拆成多帧；前端先攒着，
    // 收到这帧再一次性 reduce，避免审批卡先画出再被 resolved 抹掉。
    res.write(`event: replay_done\ndata: ${JSON.stringify({ lastSeq: run.events.at(-1)?.seq ?? from })}\n\n`);

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
    const allowlistRoots = mergeRunReadRoots([...allowedWorkdirs], run.extraWorkdirs, cfg.workdir);
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
      // 恢复策略同款：逐 run 按包解析，三字段各带来源 + armed（完成门关着时数字无效）
      recovery: recoverySnapshot(runPack),
      // 核查白名单的生效值 + 来源：无包运行拿通用缺省，界面若只读 pack.verify.readOnlyCommands
      // 会显示"白名单 0 · 核查饥饿"——而实际核查者手里有 13 条
      verifierReadOnlyCommands: readOnlyFor(runPack).commands,
      verifierReadOnlySource: readOnlyFor(runPack).source,
      workdir: cfg.workdir,
      extraWorkdirs: run.extraWorkdirs ?? [],
      writeRoots: allowlistRoots,
      readRoots: mergeRunReadRoots(readRoots, allowlistRoots, cfg.workdir),
      executionIsolation: executionBoundary,
      roleModels: {
        executor: executorModelName,
        // 报的是本 run 实际用了什么，而不是配了什么——两者可以不同
        verifier: verifierRole && (run.useVerifierModel ?? true) ? verifierRole.name : null,
        planner: plannerRole && (run.usePlannerModel ?? true) ? plannerRole.name : null,
        vision: visionRole?.name ?? null,
        image: imageRole?.name ?? null,
      },
      /**
       * 端点降级链（MODEL-01a）。未配置时 **null 而不是空数组**：
       * "没有这条防线"与"链上零个备用端点"在界面上必须能分开。
       * 只报名字——链上第二家的 baseURL / key 与角色模型同规格，绝不下发。
       */
      fallbackChain,
      fallbackChains: roleFallbackChainsView(),
      // 有任一角色链时 scope=roles；仅执行者 = executor；未配 = null
      fallbackScope: fallbackScopeNow(),
      fallbackRouting: fallbackChain || anyRoleFallbackNow() ? routingPolicy : null,
      compatSource: executorCapabilities?.source ?? "name",
      endpointHealth: endpointHealthView(),
      supportsVision: visionRole
        ? visionProbe
          ? visionProbe.supportsVision
          : null
        : false,
      guardrails: {
        maxTurns: cfg.maxTurns ?? null,
        maxTokens: cfg.maxTokens ?? null,
        // 生效预算（可能已被夹紧）——与 context.budget 同一个数；窗口那一侧看 context
        contextTokenLimit: cfg.contextTokenLimit ?? null,
        maxTotalTurns: cfg.maxTotalTurns ?? null,
        maxTokensBudget: cfg.maxTokensBudget ?? null,
        toolResultMaxChars: cfg.toolResultMaxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS,
      },
      /**
       * 上下文窗口（事实）与预算（策略）分开报（MEM-01）：窗口带来源（env / learned / registry /
       * unknown），预算带来源（run / env / pack / default）与夹紧前原值、上限、maxTokens。
       * 界面的三段水位条（已用 / 预算 / 窗口）全部从这里取数，不自己推算。
       */
      context: contextView(contextPlanFor(runPack, run.contextTokenLimit, cfg.maxTokens)),
      tools: cfg.tools.map((tool) => ({
        name: tool.name,
        permission: tool.permission,
        parallelSafe: tool.parallelSafe,
        // 已有 tool 实例时不要再 buildConfig；早拒路径必须保持 broker factory=0。
        approvalPolicy: approvalGrantPolicyFor(run, tool.name, tool).policy,
        origin: toolOrigin(tool.name),
      })),
      // 谱系 / 日预算装配：界面按本次真实装配画，不按 env 撒谎
      budgets: {
        lineage: run.lineageBudget !== false,
        daily: run.dailyBudget !== false,
        dailyConfigured: dailyTokenBudget !== undefined,
      },
      // D3：展开真实开关；mode 对得上预设才报档名，否则 null（自定义）
      permission: (() => {
        const switches = {
          approvalDefault: run.autoApprove ? ("auto" as const) : ("ask" as const),
          planMode: run.mode === "plan",
          planGate: Boolean(run.planGate),
          autoYes: Boolean(run.autoApprove),
        };
        // 档位只跟实际开关走，不跟用户点过的标签（追问改编排后标签会过期）。
        const matched = matchPermissionMode(switches);
        return {
          mode: matched,
          ...switches,
        };
      })(),
      ...(run.packRoute ? { packRoute: run.packRoute } : {}),
      mode: run.mode ?? "single",
      ...(run.designRoute ? { designRoute: run.designRoute } : {}),
      hooks: hookSpec
        ? { timeoutMs: hookSpec.timeoutMs, events: ["PreToolUse", "PostToolUse", "Stop"] }
        : null,
      agentMd: agentMdView(agentMdForRun(run)),
      workspaceGit: run.workspaceGit ?? { present: false },
      cited: Array.isArray(run.cited) && run.cited.length
        ? run.cited.map((c) => ({
            runId: c.runId,
            title: c.title,
            artifacts: Array.isArray(c.artifacts) ? c.artifacts.map(String) : [],
          }))
        : null,
    });
  }

  async function pushRunConfig(run: StoredRun): Promise<boolean> {
    const runPack = run.packName ? getPack(run.packName) : pack;
    // 若 cleanup 在路由预检之后、进入本启动函数之前已经挂起，连 per-run
    // canary worker 都不应创建。这里必须早于 buildConfig：后者会按需构造 broker。
    await refreshWorkspaceGit(run);
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

  /**
   * V-30 角色模型快照（/api/harness 与 /api/models 共用一份视图，两处口径永不漂移）。
   * **只报模型名与 provider，绝不下发密钥或 baseURL** ——浏览器能决定的是
   * "这次用不用独立角色模型"，不是"用哪个 key 连哪个端点"。
   */
  function roleModelsView(): Record<string, unknown> {
    return {
      executor: { model: executorModelName, provider: resolved.provider },
      verifier: verifierRole
        ? { model: verifierRole.name, provider: verifierRole.provider.provider, configured: true }
        : { configured: false },
      planner: plannerRole
        ? { model: plannerRole.name, provider: plannerRole.provider.provider, configured: true }
        : { configured: false },
      vision: visionRole
        ? { model: visionRole.name, provider: visionRole.provider.provider, configured: true }
        : { configured: false },
      image: imageRole
        ? { model: imageRole.name, provider: imageRole.provider, configured: true }
        : { configured: false },
    };
  }

  /** GET /api/models 出栈：库脱敏视图 + 当前角色装配快照 + 窗口预览。 */
  function modelsApiPayload(): Record<string, unknown> {
    const redacted = redactStore(modelStoreState.store, modelStoreState.source);
    const byId = new Map(modelStoreState.store.models.map((m) => [m.id, m]));
    return {
      ...redacted,
      models: redacted.models.map((pub) => {
        const full = byId.get(pub.id);
        const identity: EndpointIdentity = {
          provider: pub.provider,
          model: pub.model,
          ...(full?.baseUrl ? { baseURL: full.baseUrl } : {}),
        };
        const win = resolveContextWindow(identity);
        return {
          ...pub,
          contextWindow: {
            window: win.window,
            windowSource: win.windowSource,
          },
        };
      }),
      roleModels: roleModelsView(),
      /** 当前执行者装配下的窗口/水位——换模型后立刻可读，不必另拉 /api/harness */
      context: contextView(processContextPlan()),
    };
  }

  function availablePacksView(): Array<Record<string, unknown>> {
    return allPacks().map((p) => ({
      name: p.name,
      description: p.description,
      source: PACKS[p.name] ? "builtin" : "installed",
      verifyMode: p.verify.mode ?? null,
      hasRubric: Boolean(p.verify.rubric),
      groundedConsult: p.name === "consult",
      wantsWebSearch: Array.isArray(p.builtinTools) && p.builtinTools.includes("web_search"),
    }));
  }

  function packNamesLine(): string {
    return allPacks().map((p) => p.name).join(" | ");
  }

  function harnessSnapshot(): Record<string, unknown> {
    const tools = buildConfig().tools;
    return {
      model: executorModelName,
      provider: resolved.provider,
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
      // B2 运行历史的真实落点（/health 只报 enabled 不报路径——那条端点未认证）。
      // 装配状态条报的是"这台宿主实际存到哪、留几个"，不是 env 里配了什么
      history: {
        enabled: Boolean(historyRoot),
        dir: historyRoot,
        keep: historyKeep,
      },
      guardrails: {
        maxTurns: maxTurns ?? null,
        maxTokens: maxTokens ?? null,
        // 进程级默认包的生效预算（已夹紧）；逐 run 的真实值走 run_config
        contextTokenLimit: processContextPlan().budget,
        maxTotalTurns: maxTotalTurns ?? null,
        maxTokensBudget: maxTokensBudget ?? null,
        toolResultMaxChars: toolResultMaxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS,
      },
      budgets: {
        lineageDefault: maxTokensBudget !== undefined || maxTotalTurns !== undefined,
        dailyConfigured: dailyTokenBudget !== undefined,
        dailyTokenBudget: dailyTokenBudget ?? null,
      },
      /**
       * 窗口 / 预算（MEM-01）：进程级默认包的解析结果，**每次快照时重算**——上一个 run 撞 400
       * 学到窗口后，下一次刷新页面就该看到 learned。提交表单的逐 run 预算控件用 maxBudget
       * 做上限、用 window 判断"窗口未知"。
       */
      context: contextView(processContextPlan()),
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
      availablePacks: availablePacksView(),
      designMode: {
        tabs: [...DESIGN_TABS],
        catalog: publicDesignCatalog(),
        installedFilePacks: installedFilePacksFrom(allPacks()).map((p) => ({
          name: p.name,
          description: p.description,
        })),
        draftsWorkdir: designDraftsDir,
        hostWorkdirIsHarness,
      },
      webSearchConfigured: isWebSearchConfigured(),
      effortLevels: [...EFFORT_LEVELS],
      // V-29：合法工作目录集合由宿主声明，浏览器只在其中选（运行时经
      // 本机 UI 添加的也在这个集合里——集合是活的，快照时铺平）
      availableWorkdirs: [...allowedWorkdirs],
      roleModels: roleModelsView(),
      // MODEL-01a：进程级降级链快照（逐 run 的同名字段走 run_config）。
      // null = 未配置这条防线，与"链上只有主端点"不是一回事
      fallbackChain,
      fallbackChains: roleFallbackChainsView(),
      fallbackScope: fallbackScopeNow(),
      fallbackRouting: fallbackChain || anyRoleFallbackNow() ? routingPolicy : null,
      compatSource: executorCapabilities?.source ?? "name",
      // MODEL-01 残余：链健康只读面（粘性探针 + 熔断）；不改路由
      endpointHealth: endpointHealthView(),
      // null = 配了但尚未探完；false = 明确不会看图（工具已卸）
      supportsVision: visionRole
        ? visionProbe
          ? visionProbe.supportsVision
          : null
        : false,
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
      // 恢复策略：进程级默认包的值；逐 run 的真实值走 run_config（口径同核查预算）
      recovery: recoverySnapshot(pack),
      // 核查白名单生效值 + 来源（无包 = 通用缺省 / env；有包 = 包声明或 none）
      verifierReadOnlyCommands: readOnlyFor(pack).commands,
      verifierReadOnlySource: readOnlyFor(pack).source,
      pack: packView(pack),
      tools: tools.map((t) => ({
        name: t.name,
        permission: t.permission,
        parallelSafe: t.parallelSafe,
        approvalPolicy: t.approvalPolicy ?? { maxScope: "once" },
        origin: toolOrigin(t.name),
      })),
      mcp: mcpSnapshot(),
      hooks: hookSpec
        ? { timeoutMs: hookSpec.timeoutMs, events: ["PreToolUse", "PostToolUse", "Stop"] }
        : null,
      // 进程级只报上限与层次；实际加载了哪几个文件是逐 run 的（workdir 不同）
      agentMd: { maxChars: agentMdMaxChars, layers: ["user", "project", "rules", "subdir"] },
      /**
       * OBS-02：直方图分位数。没有样本是 null，不是 0。
       * 模型曲线用执行者角色+当前装配模型；等待按 kind。本切片不发明仪表盘。
       */
      latency: {
        modelCall: modelCallSeconds.quantiles({ role: "execution", model: executorModelName }),
        modelTtft: modelTtftSeconds.quantiles({ role: "execution", model: executorModelName }),
        wait: Object.fromEntries(WAIT_KINDS.map((kind) => [kind, waitSeconds.quantiles({ kind })])),
      },
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
    json(res, 429, capacityRejectionPayload());
  }

  /** 容量拒绝的响应体（T9：调度器内部发起 run 走同一条准入门，但没有 res 可写） */
  function capacityRejectionPayload(): { error: string; activeRuns: number } {
    return {
      error: `Active run limit reached (${maxActiveRuns})`,
      activeRuns: activeRunCount(),
    };
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
   * 独占资源准入（single/verified 模式）：包声明的资源被别的 run 持有 → 拒绝
   * 附持有者；全部空闲 → 以 runId 为 holder 整体占用。plan 模式不走这里。
   * 返回 "acquired" 表示已占用成功（或无资源要占）。
   * 纯判定 + 占用副作用分离出来：T9 调度器内部发起 run 走同一条门，但没有 res 可写。
   */
  function tryAcquireRunResources(
    runId: string,
    tags: string[],
  ): "acquired" | { conflict: string; heldBy: string | undefined } {
    if (tags.length === 0 || hostResources.tryAcquire(tags, runId)) return "acquired";
    const conflict = tags.find((t) => {
      const h = hostResources.holderOf(t);
      return h !== undefined && h !== runId;
    })!;
    return { conflict, heldBy: hostResources.holderOf(conflict) };
  }

  function acquireRunResources(
    res: ServerResponse,
    runId: string,
    tags: string[],
  ): "acquired" | "refused" {
    const outcome = tryAcquireRunResources(runId, tags);
    if (outcome === "acquired") return "acquired";
    metrics.resourceRejected += 1;
    json(res, 429, {
      error:
        `Exclusive resource "${outcome.conflict}" is held by run ${outcome.heldBy}. ` +
        "Wait for that run to finish (or stop it), then retry.",
      resource: outcome.conflict,
      heldBy: outcome.heldBy,
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

  /**
   * 同 workdir 并发判定：exclusive 时返回冲突 runId（调用方负责 409），
   * 否则告警放行返回 null。判定与响应分离：T9 调度器内部发起 run 没有 res 可写。
   */
  function sharedWorkdirRejection(
    runId: string,
    targetWorkdir: string,
    excludeRunId?: string,
  ): { conflictRunId: string } | null {
    const conflict = runningWorkdirConflict(targetWorkdir, excludeRunId);
    if (!conflict) return null;
    if (exclusiveWorkdir) return { conflictRunId: conflict.id };
    operationalLog("warn", "workdir_shared", {
      runId,
      conflictRunId: conflict.id,
      workdir: resolve(targetWorkdir),
    });
    return null;
  }

  /** 同 workdir 并发：exclusive 时 409 拒绝（返回 true 表示已拒），否则告警放行 */
  function refuseOrWarnSharedWorkdir(
    res: ServerResponse,
    runId: string,
    targetWorkdir: string,
    excludeRunId?: string,
  ): boolean {
    const rejection = sharedWorkdirRejection(runId, targetWorkdir, excludeRunId);
    if (!rejection) return false;
    metrics.workdirRejected += 1;
    json(res, 409, {
      error:
        `Workdir is in use by running run ${rejection.conflictRunId}. Concurrent runs sharing a workdir ` +
        "can silently overwrite each other's artifacts; give each run its own workdir " +
        "(AGENT_UI_WORKDIRS) or wait for the other run.",
      conflictRunId: rejection.conflictRunId,
    });
    return true;
  }

  /** 日预算拒绝的响应体 + Retry-After 秒数（与 rejectAtDailyBudget 同一份数据，T9 调度器复用） */
  function dailyBudgetRejection(info: { used: number; budget: number; now: Date }): {
    retryAfterSeconds: number;
    payload: { error: string; dailyTokensUsed: number; dailyTokenBudget: number };
  } {
    const midnight = new Date(info.now.getFullYear(), info.now.getMonth(), info.now.getDate() + 1);
    return {
      retryAfterSeconds: Math.max(1, Math.ceil((midnight.getTime() - info.now.getTime()) / 1000)),
      payload: {
        error:
          `Daily token budget exhausted: ${info.used} of ${info.budget} non-cache-read tokens used today. ` +
          "Running tasks are unaffected; admission reopens tomorrow, or raise AGENT_UI_DAILY_TOKEN_BUDGET and restart.",
        dailyTokensUsed: info.used,
        dailyTokenBudget: info.budget,
      },
    };
  }

  function rejectAtDailyBudget(res: ServerResponse, info: { used: number; budget: number; now: Date }): void {
    metrics.budgetRejected += 1;
    const rejection = dailyBudgetRejection(info);
    res.setHeader("Retry-After", String(rejection.retryAfterSeconds));
    json(res, 429, rejection.payload);
  }

  /**
   * 突变额度只计会改宿主/run 状态的写操作。
   * 不计路径探活、在资源管理器中显示——那些是 POST 只因要带 body，
   * 对话每刷一次就会打，跟「新建任务」抢额度会把提问卡锁死。
   * 人闸（澄清/审批/计划门/停止）另算：解开挂起的 agent 不得被旁路 POST 挤掉。
   */
  const MUTATION_QUOTA_ROUTES = new Set([
    "createRun",
    "followUp",
    "forkConversation",
    "rewindConversation",
    "upload",
    "uploadDelete",
    "autoApprove",
    "modelsPut",
    "modelsRolesPatch",
    "modelsTest",
    "modelsSyncEnv",
    "mcpPut",
    "packsDraft",
    "packsInstall",
    "packsDiscard",
    "workdirAdd",
    "designDraftsWorkdir",
    "workdirRemove",
    "fsMkdir",
    "workspaceGitCheckout",
    "seedTemplate",
    "exportPptx",
    "exportPng",
    "scheduleCreate",
    "scheduleUpdate",
    "scheduleDelete",
    "scheduleRun",
    "deleteRun",
    "extendBudget",
    "messageQueue",
  ]);

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
      // OBS-02：**当前**挂着的最久的一次人工等待（秒）。直方图只在应答那一刻
      // 落桶，所以"现在有人已经等了 40 分钟"在直方图上完全看不见——而那正是
      // 唯一值得半夜叫醒运维的形态。没有挂起项时是 0，不是缺失序列。
      "# TYPE agent_harness_pending_wait_seconds gauge",
      ...WAIT_KINDS.filter((k) => k !== "resource").map(
        (kind) => `agent_harness_pending_wait_seconds{kind="${kind}"} ${oldestPendingWaitSeconds(kind)}`,
      ),
      ...obsRegistry.renderLines(),
      "",
    ].join("\n");
  }

  /**
   * 最久的一个挂起等待，秒。三种挂起态各自的挂起时刻都记在 `at` 上
   * （PendingApproval / PendingPlan / PendingQuestion 同款字段）。
   */
  function oldestPendingWaitSeconds(kind: (typeof WAIT_KINDS)[number]): number {
    const now = Date.now();
    let oldest = now;
    for (const run of runs.values()) {
      if (run.status !== "running") continue;
      if (kind === "approval") {
        for (const p of run.pendingApprovals.values()) oldest = Math.min(oldest, p.at);
      } else if (kind === "plan_gate") {
        if (run.pendingPlan) oldest = Math.min(oldest, run.pendingPlan.at);
      } else if (kind === "question") {
        if (run.pendingQuestion) oldest = Math.min(oldest, run.pendingQuestion.at);
      }
    }
    return Math.max(0, Math.round((now - oldest) / 1000));
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
    | { type: "modelsGet" }
    | { type: "modelsPut" }
    | { type: "modelsRolesPatch" }
    | { type: "modelsTest" }
    | { type: "modelsSyncEnv" }
    | { type: "usageGet" }
    | { type: "mcpGet" }
    | { type: "mcpPut" }
    | { type: "packsGet" }
    | { type: "packsDraft" }
    | { type: "packsInstall"; name: string }
    | { type: "packsDiscard"; name: string }
    | { type: "workdirsList" }
    | { type: "workdirAdd" }
    | { type: "designDraftsWorkdir" }
    | { type: "citeCandidates"; workdir: string | null }
    | { type: "workdirRemove" }
    | { type: "workspaceGitGet"; workdir: string | null }
    | { type: "workspaceGitCheckout" }
    | { type: "fsList"; path: string | null }
    | { type: "fsMkdir" }
    | { type: "memoryList"; scope: "current" | "all"; workdir?: string }
    | { type: "memoryRead"; name: string }
    | { type: "searchRuns"; query: string; limit: string | null }
    | { type: "runChanges"; runId: string }
    | { type: "runsList" }
    | { type: "lifecycleStream" }
    | { type: "transcript"; runId: string }
    | { type: "trace"; runId: string }
    | { type: "inspectPaths"; runId: string }
    | { type: "artifact"; runId: string; path: string; download: boolean }
    | { type: "site"; runId: string; path: string; inspect: boolean; deck: boolean; print: boolean }
    | { type: "siteZip"; runId: string; path: string }
    | { type: "designTemplates" }
    | { type: "designMd"; runId: string }
    | { type: "seedTemplate"; runId: string }
    | { type: "exportPptx"; runId: string }
    | { type: "exportPng"; runId: string }
    | { type: "filePreview"; path: string; workdir: string | null; download: boolean }
    | { type: "reveal"; runId: string }
    | { type: "stop"; runId: string }
    | { type: "deleteRun"; runId: string }
    | { type: "followUp"; runId: string }
    | { type: "forkConversation"; runId: string }
    | { type: "rewindConversation"; runId: string }
    | { type: "messageQueue"; runId: string }
    | { type: "extendBudget"; runId: string }
    | { type: "upload" }
    | { type: "uploadDelete" }
    | { type: "createRun" }
    | { type: "schedulesList" }
    | { type: "scheduleCreate" }
    | { type: "scheduleUpdate"; scheduleId: string }
    | { type: "scheduleDelete"; scheduleId: string }
    | { type: "scheduleRun"; scheduleId: string }
    | { type: "events"; runId: string }
    | { type: "approval"; runId: string; toolUseId: string }
    | { type: "autoApprove"; runId: string }
    | { type: "planApproval"; runId: string }
    | { type: "handoff"; runId: string }
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

    /**
     * MODEL-02 模型库端点。路由层只管形状；校验（provider 枚举 / 模型名 /
     * baseUrl 白名单 / roles 引用完整性）全部在 model-config.ts 的
     * validateModelConfig —— 与 schedules 的"路由管形状、处理器管语义"同模式。
     */
    if (method === "GET" && url === "/api/models") {
      return { type: "modelsGet" };
    }
    if (method === "PUT" && url === "/api/models") {
      return { type: "modelsPut" };
    }
    /** 只改角色分配（composer 快捷换执行模型）；不动库条目与密钥。 */
    if (method === "PATCH" && url === "/api/models/roles") {
      return { type: "modelsRolesPatch" };
    }
    if (method === "POST" && url === "/api/models/test") {
      return { type: "modelsTest" };
    }
    if (method === "POST" && url === "/api/models/sync-env") {
      return { type: "modelsSyncEnv" };
    }
    if (method === "GET" && url === "/api/usage") {
      return { type: "usageGet" };
    }
    if (method === "GET" && url === "/api/mcp") {
      return { type: "mcpGet" };
    }
    if (method === "PUT" && url === "/api/mcp") {
      return { type: "mcpPut" };
    }
    if (method === "GET" && url === "/api/packs") {
      return { type: "packsGet" };
    }
    if (method === "POST" && url === "/api/packs/drafts") {
      return { type: "packsDraft" };
    }
    const packInstallMatch = method === "POST" && url.match(/^\/api\/packs\/drafts\/([^/]+)\/install$/);
    if (packInstallMatch) {
      return { type: "packsInstall", name: decodeURIComponent(packInstallMatch[1]!) };
    }
    const packDiscardMatch = method === "DELETE" && url.match(/^\/api\/packs\/drafts\/([^/]+)$/);
    if (packDiscardMatch) {
      return { type: "packsDiscard", name: decodeURIComponent(packDiscardMatch[1]!) };
    }

    /**
     * V-29 运行时白名单扩展（委托方："工作目录切换只能重启宿主，很麻烦——
     * 新建对话的时候就开始选目录"）。路由层只管形状；校验（绝对路径 / 存在 /
     * 是目录 / env 声明不可删 / 在飞保护）与 loopback 门都在处理器里——
     * 与 /api/models 的"路由管形状、处理器管语义"同模式。
     */
    if (method === "GET" && url === "/api/workdirs") {
      return { type: "workdirsList" };
    }
    if (method === "POST" && url === "/api/workdirs") {
      return { type: "workdirAdd" };
    }
    if (method === "POST" && url === "/api/design-drafts-workdir") {
      return { type: "designDraftsWorkdir" };
    }
    const citeCandidatesMatch = method === "GET" && url.match(/^\/api\/cite-candidates(?:\?(.*))?$/);
    if (citeCandidatesMatch) {
      const params = new URLSearchParams(citeCandidatesMatch[1] ?? "");
      return { type: "citeCandidates", workdir: params.get("workdir") };
    }
    if (method === "DELETE" && url === "/api/workdirs") {
      return { type: "workdirRemove" };
    }
    const workspaceGitMatch = method === "GET" && url.match(/^\/api\/workspace\/git(?:\?(.*))?$/);
    if (workspaceGitMatch) {
      const params = new URLSearchParams(workspaceGitMatch[1] ?? "");
      return { type: "workspaceGitGet", workdir: params.get("workdir") };
    }
    if (method === "POST" && url === "/api/workspace/git/checkout") {
      return { type: "workspaceGitCheckout" };
    }

    /**
     * 目录浏览（给「添加目录」浮层供数）。只列目录不列文件，隐藏目录（.开头）
     * 不列；path 省略时给常用起点。读权限问题与符号链接归一都在处理器里。
     */
    const fsListMatch = method === "GET" && url.match(/^\/api\/fs\/list(?:\?(.*))?$/);
    if (fsListMatch) {
      const params = new URLSearchParams(fsListMatch[1] ?? "");
      return { type: "fsList", path: params.get("path") };
    }
    if (method === "POST" && url === "/api/fs/mkdir") {
      return { type: "fsMkdir" };
    }

    /**
     * T5 记忆面板（L5 可审查化）：只读暴露默认 workdir 作用域的 .agent-memory/。
     * name 与 MemoryStore.NAME_RE 对齐（含嵌套路径）；捕获 catch-all 段并 decode，
     * ".." 与 resolvePath 仍防穿越。注意顺序：/:name 在精确 /api/memory 之后。
     */
    if (method === "GET" && (url === "/api/memory" || url.startsWith("/api/memory?"))) {
      const params = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");
      const scopeRaw = String(params.get("scope") ?? "current").trim().toLowerCase();
      const scope = scopeRaw === "all" ? "all" : "current";
      const asked = params.get("workdir");
      return {
        type: "memoryList",
        scope,
        ...(asked ? { workdir: asked } : {}),
      };
    }
    const memoryReadMatch = method === "GET" && url.match(/^\/api\/memory\/([^?#]+)$/);
    if (memoryReadMatch) {
      const name = safeDecode(memoryReadMatch[1]!).replaceAll("\\", "/");
      if (!MemoryStore.NAME_RE.test(name) || name.includes("..")) return { type: "malformed" };
      return { type: "memoryRead", name };
    }

    /**
     * T6 全局搜索：q/limit 经查询串传入，具体校验（最短长度/上限钳位）在
     * 处理器里做——路由层只管形状，不管语义（与 /api/runs/:id/artifact 同模式）。
     */
    const searchMatch = method === "GET" && url.match(/^\/api\/search(?:\?(.*))?$/);
    if (searchMatch) {
      const params = new URLSearchParams(searchMatch[1] ?? "");
      return { type: "searchRuns", query: params.get("q") ?? "", limit: params.get("limit") };
    }

    /**
     * T8 变更审查：聚合一个 run 的写盘工具触碰。路由层只管形状；
     * 圈禁（resolveInWorkdir）与 git 降级都在处理器里。
     */
    const changesMatch = method === "GET" && url.match(/^\/api\/runs\/([^/]+)\/changes$/);
    if (changesMatch) {
      return { type: "runChanges", runId: changesMatch[1]! };
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

    /**
     * 整站预览：路径式取件，使 HTML 内相对 CSS/JS 能解析到同目录资源。
     * 仍圈在 run workdir；CSP 允许同源脚本，但 iframe 故意无 allow-same-origin。
     * 查询串（?v=、?inspect=1、?deck=1）必须先剥掉再解码路径。
     */
    const siteQ = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
    const sitePathOnly = url.split("?", 1)[0]!;
    const siteZipMatch = method === "GET" && sitePathOnly.match(/^\/api\/runs\/([^/]+)\/site-zip$/);
    if (siteZipMatch) {
      const qs = new URLSearchParams(siteQ);
      const wanted = qs.get("path");
      if (!wanted) return { type: "malformed" };
      return { type: "siteZip", runId: siteZipMatch[1]!, path: wanted };
    }
    if (method === "GET" && url === "/api/design-templates") {
      return { type: "designTemplates" };
    }
    const designMdMatch = method === "GET" && sitePathOnly.match(/^\/api\/runs\/([^/]+)\/design-md$/);
    if (designMdMatch) {
      return { type: "designMd", runId: designMdMatch[1]! };
    }
    const seedTemplateMatch =
      method === "POST" && sitePathOnly.match(/^\/api\/runs\/([^/]+)\/seed-template$/);
    if (seedTemplateMatch) {
      return { type: "seedTemplate", runId: seedTemplateMatch[1]! };
    }
    const exportPptxMatch =
      method === "POST" && sitePathOnly.match(/^\/api\/runs\/([^/]+)\/export\/pptx$/);
    if (exportPptxMatch) {
      return { type: "exportPptx", runId: exportPptxMatch[1]! };
    }
    const exportPngMatch =
      method === "POST" && sitePathOnly.match(/^\/api\/runs\/([^/]+)\/export\/png$/);
    if (exportPngMatch) {
      return { type: "exportPng", runId: exportPngMatch[1]! };
    }
    const siteMatch = method === "GET" && sitePathOnly.match(/^\/api\/runs\/([^/]+)\/site\/(.+)$/);
    if (siteMatch) {
      try {
        const qs = new URLSearchParams(siteQ);
        return {
          type: "site",
          runId: siteMatch[1]!,
          path: decodeSitePreviewPath(siteMatch[2]!),
          inspect: qs.get("inspect") === "1",
          deck: qs.get("deck") === "1",
          print: qs.get("print") === "1",
        };
      } catch {
        return { type: "malformed" };
      }
    }

    /**
     * V-35 文件预览：不绑定 run 的只读取件——上传完还没有 run、或要看的
     * 文件不属于当前会话时走这里。圈禁口径与上传同一条线（白名单工作目录），
     * 具体校验在处理器里——路由层只管形状，与 artifact 同模式。
     */
    const filePreviewMatch = method === "GET" && url.match(/^\/api\/file-preview\?(.*)$/);
    if (filePreviewMatch) {
      const q = new URLSearchParams(filePreviewMatch[1]!);
      const wanted = q.get("path");
      if (!wanted) return { type: "malformed" };
      return {
        type: "filePreview",
        path: wanted,
        workdir: q.get("workdir"),
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

    const deleteMatch = method === "DELETE" && url.match(/^\/api\/runs\/([^/]+)$/);
    if (deleteMatch) {
      return { type: "deleteRun", runId: deleteMatch[1]! };
    }

    if (method === "POST" && url === "/api/upload") {
      return { type: "upload" };
    }

    // 附件清单的删除：与上传同一条圈禁线，且只许碰 uploads/ 子目录内的文件
    if (method === "DELETE" && url === "/api/upload") {
      return { type: "uploadDelete" };
    }

    const followUpMatch = method === "POST" && url.match(/^\/api\/runs\/([^/]+)\/messages$/);
    if (followUpMatch) {
      return { type: "followUp", runId: followUpMatch[1]! };
    }

    const forkMatch = method === "POST" && url.match(/^\/api\/runs\/([^/]+)\/fork$/);
    if (forkMatch) {
      return { type: "forkConversation", runId: forkMatch[1]! };
    }

    const rewindMatch = method === "POST" && url.match(/^\/api\/runs\/([^/]+)\/rewind$/);
    if (rewindMatch) {
      return { type: "rewindConversation", runId: rewindMatch[1]! };
    }

    // 信息队列：取消排队中的消息。body 可带 { index } 取消单条；空 body = 清空整队
    const queueMatch = method === "DELETE" && url.match(/^\/api\/runs\/([^/]+)\/queue$/);
    if (queueMatch) {
      return { type: "messageQueue", runId: queueMatch[1]! };
    }

    const extendBudgetMatch = method === "POST" && url.match(/^\/api\/runs\/([^/]+)\/extend-budget$/);
    if (extendBudgetMatch) {
      return { type: "extendBudget", runId: extendBudgetMatch[1]! };
    }

    if (method === "POST" && url === "/api/runs") {
      return { type: "createRun" };
    }

    /**
     * T9 定时任务：/api/schedules CRUD + 手动触发。路由层只管形状；
     * 校验（task 非空 / workdir 白名单 / schedule 合法）都在处理器里，
     * 与 /api/runs 的"路由管形状、处理器管语义"同模式。
     */
    if (method === "GET" && url === "/api/schedules") {
      return { type: "schedulesList" };
    }
    if (method === "POST" && url === "/api/schedules") {
      return { type: "scheduleCreate" };
    }
    const scheduleRunMatch = method === "POST" && url.match(/^\/api\/schedules\/([^/]+)\/run$/);
    if (scheduleRunMatch) {
      return { type: "scheduleRun", scheduleId: scheduleRunMatch[1]! };
    }
    const schedulePatchMatch = method === "PATCH" && url.match(/^\/api\/schedules\/([^/]+)$/);
    if (schedulePatchMatch) {
      return { type: "scheduleUpdate", scheduleId: schedulePatchMatch[1]! };
    }
    const scheduleDeleteMatch = method === "DELETE" && url.match(/^\/api\/schedules\/([^/]+)$/);
    if (scheduleDeleteMatch) {
      return { type: "scheduleDelete", scheduleId: scheduleDeleteMatch[1]! };
    }

    const eventsMatch = method === "GET" && url.match(/^\/api\/runs\/([^/]+)\/events$/);
    if (eventsMatch) {
      return { type: "events", runId: eventsMatch[1]! };
    }

    const planApprovalMatch = method === "POST" && url.match(/^\/api\/runs\/([^/]+)\/plan-approval$/);
    if (planApprovalMatch) {
      return { type: "planApproval", runId: planApprovalMatch[1]! };
    }

    const handoffMatch = method === "POST" && url.match(/^\/api\/runs\/([^/]+)\/handoff$/);
    if (handoffMatch) {
      return { type: "handoff", runId: handoffMatch[1]! };
    }

    // §5.2：委托方回答 agent 的澄清问题（或显式跳过）
    const answerMatch = method === "POST" && url.match(/^\/api\/runs\/([^/]+)\/answer$/);
    if (answerMatch) {
      return { type: "answer", runId: answerMatch[1]! };
    }

    const autoApproveMatch = method === "POST" && url.match(/^\/api\/runs\/([^/]+)\/auto-approve$/);
    if (autoApproveMatch) {
      return { type: "autoApprove", runId: autoApproveMatch[1]! };
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
  // T9 定时任务：createRun 的统一内部入口 + 调度器
  // ------------------------------------------------------

  async function applyUiDesignSeed(route: DesignRoute, destRoot: string): Promise<void> {
    try {
      if (shouldSeedDesignTemplate(route)) {
        if (!designTemplatesDir) return;
        for (const seed of seedsToCopy(route)) {
          await copyDesignTemplate({
            templatesRoot: designTemplatesDir,
            templateId: seed,
            destRoot,
          });
        }
        if (route.bundle === "spec-plus-deck") {
          await writeDesignBundleHub(destRoot);
        }
        return;
      }
      if (shouldWriteBlankDesignIndex(route)) {
        await writeBlankDesignIndex(destRoot);
      }
    } catch {
      /* 播种失败不挡会话；agent 仍可自己写 index.html */
    }
  }

  /** POST /api/runs 的请求体形状（HTTP 层只负责 JSON 解析，语义校验全在 createRunFromBody） */
  interface RunCreateBody {
    task?: string; verify?: boolean; pack?: string; effort?: string; rubric?: string;
    mode?: string; concurrency?: number | string;
    workdir?: string; extraWorkdirs?: unknown; useVerifierModel?: boolean; usePlannerModel?: boolean;
    planGate?: boolean; askUser?: boolean; autoApprove?: boolean; contextTokenLimit?: number | string;
    multiAgent?: boolean;
    autoPack?: boolean;
    lineageBudget?: boolean; dailyBudget?: boolean;
    /** D3：manual | plan | auto；给出则覆盖 plan/autoApprove 为预设开关 */
    permissionMode?: string;
    designId?: string;
    designTab?: string;
    designTemplate?: string;
    designFilePack?: string;
    citedRunIds?: unknown;
    workspace?: string;
  }

  /** 准入结果：HTTP 处理器把它写成响应；调度器把非 200 记成 lastTrigger=error */
  interface RunAdmissionOutcome {
    status: number;
    payload: unknown;
    headers?: Record<string, string>;
  }

  /**
   * 新建 run 的完整准入 + 发起流程（原 case "createRun" 的全部语义）。
   *
   * T9 调度器到期触发时构造 { task, workdir, verify } 走这同一个函数——
   * 校验、白名单、容量/资源/日预算门、建档、启动（startPlainRun 等）一处不改。
   * 注意：隔离健康重探（refreshExecutionHealth）不在本函数内——HTTP 路径必须在
   * readBody **之前**完成它（SAFE-05 慢 body 测试依赖这个顺序）；调度器路径的
   * launch 回调自己做同一道门。
   */
  async function createRunFromBody(
    parsed: RunCreateBody,
    extras?: { injectedPlan?: Plan; parentRunId?: string },
  ): Promise<RunAdmissionOutcome> {
    if (parsed.mode === "design") {
      if (parsed.task !== undefined && parsed.task !== null && typeof parsed.task !== "string") {
        return { status: 400, payload: { error: 'Missing or invalid "task" field' } };
      }
      parsed.task = typeof parsed.task === "string" ? parsed.task : "";
    } else if (!parsed.task || typeof parsed.task !== "string") {
      return { status: 400, payload: { error: 'Missing or invalid "task" field' } };
    }
    // V-24：外部输入一律当场校验拒绝，不静默降级——静默降级会让"我明明选了
    // python-coding"与实际行为长期不一致，查起来很贵（口径同 src/cli.ts 对
    // AGENT_EFFORT 的处理）
    if (parsed.pack !== undefined && parsed.pack !== "" && !getPack(parsed.pack)) {
      return { status: 400, payload: { error: `未知领域包 "${parsed.pack}"。可选：${packNamesLine()}` } };
    }
    /**
     * 逐 run 上下文预算（MEM-01 窗口 / 预算分离）：区间 [32k, 窗口 − maxTokens − 边际]
     * （窗口未知时上限取硬顶）。越界 **400 并报出区间**，不静默夹紧——夹紧是对 env / 包这类
     * 操作员配置的处置；请求体是这一次的显式意图，填了 900k 却被悄悄改成 60k 就是界面说谎。
     * 校验用的窗口 / maxTokens 按本 run 的包算（包可改 maxTokens），与 buildConfig 同一口径。
     */
    let runContextTokenLimit: number | undefined;
    if (parsed.contextTokenLimit !== undefined && parsed.contextTokenLimit !== "" && parsed.contextTokenLimit !== null) {
      const admissionPackForContext = parsed.pack ? getPack(parsed.pack) : pack;
      const plan = contextPlanFor(admissionPackForContext);
      const checked = validateRunContextBudget(parsed.contextTokenLimit, plan.maxBudget);
      if (!checked.ok) {
        return {
          status: 400,
          payload: {
            error: checked.error,
            contextTokenLimit: { min: checked.min, max: checked.max, window: plan.window, windowSource: plan.windowSource, maxTokens: plan.maxTokens },
          },
        };
      }
      runContextTokenLimit = checked.value;
    }
    if (
      parsed.effort !== undefined && parsed.effort !== "" &&
      !(EFFORT_LEVELS as readonly string[]).includes(parsed.effort)
    ) {
      return { status: 400, payload: { error: `effort "${parsed.effort}" 无效。可选：${EFFORT_LEVELS.join(" | ")}` } };
    }

    if (
      parsed.mode !== undefined &&
      parsed.mode !== "single" &&
      parsed.mode !== "plan" &&
      parsed.mode !== "design"
    ) {
      return { status: 400, payload: { error: `mode "${parsed.mode}" 无效。可选：single | plan | design` } };
    }
    if (
      parsed.workspace !== undefined &&
      parsed.workspace !== "" &&
      parsed.workspace !== "office" &&
      parsed.workspace !== "code"
    ) {
      return { status: 400, payload: { error: `workspace "${parsed.workspace}" 无效。可选：office | code` } };
    }
    let permissionMode: PermissionMode | undefined;
    if (parsed.permissionMode !== undefined && parsed.permissionMode !== "") {
      if (!(PERMISSION_MODES as readonly string[]).includes(String(parsed.permissionMode))) {
        return {
          status: 400,
          payload: { error: `permissionMode "${parsed.permissionMode}" 无效。可选：${PERMISSION_MODES.join(" | ")}` },
        };
      }
      permissionMode = parsed.permissionMode as PermissionMode;
      const switches = permissionModeSwitches(permissionMode);
      // 档位只填没写明的旋钮。Web 上计划编排与自动放行是正交开关；
      // 用档名盖掉勾选，就会出现「自动放行开着却仍逐条问」。
      if (parsed.mode === undefined && parsed.multiAgent !== true) {
        if (switches.planMode) parsed.mode = "plan";
      }
      if (parsed.planGate === undefined) parsed.planGate = switches.planGate;
      if (parsed.autoApprove === undefined) {
        parsed.autoApprove = switches.autoYes || switches.approvalDefault === "auto";
      }
    }
    // 多 agent 与计划确认门正交。planGate 必须配 mode=plan 或 multiAgent，
    // 单独传 planGate 拒绝——静默忽略会让界面与实际行为长期不一致。
    const multiAgent = parsed.multiAgent === true;
    const planGateRequested = parsed.planGate === true;
    const wantsOrchestrate = multiAgent || parsed.mode === "plan";
    const wantsDesign = parsed.mode === "design" && !wantsOrchestrate;
    if (planGateRequested && !wantsOrchestrate) {
      return { status: 400, payload: { error: "planGate 仅在编排（mode=plan 或 multiAgent）下有意义：单跑模式没有计划这一步" } };
    }
    let concurrency: number | "auto" | undefined;
    if (parsed.concurrency !== undefined && parsed.concurrency !== "") {
      if (parsed.concurrency === "auto") concurrency = "auto";
      else {
        const n = Number(parsed.concurrency);
        if (!Number.isInteger(n) || n < 1 || n > 8) {
          return { status: 400, payload: { error: `concurrency "${parsed.concurrency}" 无效。可选：auto 或 1..8` } };
        }
        concurrency = n;
      }
    } else if (wantsOrchestrate) {
      // 多 agent 开 → auto；仅计划门 / 串行编排 → 1
      concurrency = multiAgent ? "auto" : 1;
    }

    const lineageBudget = parsed.lineageBudget !== false;
    const dailyBudget = parsed.dailyBudget !== false;

    // V-29：工作目录必须命中白名单。规范化后逐条比对绝对路径——
    // 只做字符串前缀判断会被 `..` 穿出去，而这是工具的写入边界
    let runWorkdir: string | undefined;
    if (parsed.workdir !== undefined && parsed.workdir !== "") {
      const asked = resolve(parsed.workdir);
      if (!allowedWorkdirs.has(asked)) {
        return {
          status: 400,
          payload: { error: `工作目录不在白名单内。可选：${[...allowedWorkdirs].join(" | ")}（可点工作目录下拉的「＋ 添加目录…」即时加入）` },
        };
      }
      runWorkdir = asked;
    }

    const extraParsed = parseExtraWorkdirs(
      parsed.extraWorkdirs,
      allowedWorkdirs,
      runWorkdir ?? workdir,
    );
    if (!extraParsed.ok) {
      return { status: 400, payload: { error: extraParsed.error } };
    }
    const extraWorkdirs = extraParsed.extraWorkdirs;
    const admittedWorkspace: "office" | "code" | undefined =
      parsed.workspace === "office" || parsed.workspace === "code"
        ? parsed.workspace
        : undefined;

    let packRoute: { pack: string | null; reason: string } | undefined;
    let admittedDesignRoute: DesignRoute | undefined;
    if (wantsDesign) {
      const installed = installedFilePacksFrom(allPacks());
      const installedNames = installed.map((p) => p.name);
      // 设计模式锁定后端包为 design，除非点了已安装文件包。内置工程包忽略。
      if (parsed.pack && PACKS[parsed.pack] && !installedNames.includes(parsed.pack)) {
        parsed.pack = undefined;
      }
      const explicitFilePack =
        typeof parsed.designFilePack === "string" && installedNames.includes(parsed.designFilePack)
          ? parsed.designFilePack
          : typeof parsed.pack === "string" && installedNames.includes(parsed.pack)
            ? parsed.pack
            : undefined;
      admittedDesignRoute = await routeDesignTask({
        cfg: { systemPrompt: "router", tools: [], workdir: runWorkdir ?? workdir, compat: envCompat },
        model: modelClient,
        task: parsed.task,
        explicitId: typeof parsed.designId === "string" ? parsed.designId : undefined,
        explicitTab: typeof parsed.designTab === "string" ? parsed.designTab : undefined,
        explicitTemplate: typeof parsed.designTemplate === "string" ? parsed.designTemplate : undefined,
        explicitFilePack,
        installedFilePacks: installed,
      });
      if (admittedDesignRoute.kind === "r2") {
        return {
          status: 409,
          payload: {
            error: admittedDesignRoute.reason,
            designRoute: {
              ...designRouteForRunConfig(admittedDesignRoute),
              tab: admittedDesignRoute.tab ?? null,
            },
          },
        };
      }
      parsed.pack = admittedDesignRoute.pack;
    } else if (parsed.autoPack === true && !parsed.pack && !wantsOrchestrate) {
      try {
        const outcome = await routeToPack(
          { systemPrompt: "router", tools: [], workdir: runWorkdir ?? workdir, compat: envCompat },
          modelClient,
          parsed.task,
          allPacks(),
        );
        packRoute = outcome.decision;
        if (outcome.decision.pack && getPack(outcome.decision.pack)) {
          parsed.pack = outcome.decision.pack;
        }
      } catch (error) {
        packRoute = {
          pack: null,
          reason: `路由失败，未选包：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    const verify = parsed.verify === true;
    // §5.2 决定 1：默认关，逐 run 显式开
    const askUser = parsed.askUser === true;
    if (dailyBudget) {
      const budgetRefusal = dailyBudgetRefusal();
      if (budgetRefusal) {
        metrics.budgetRejected += 1;
        const rejection = dailyBudgetRejection(budgetRefusal);
        return { status: 429, payload: rejection.payload, headers: { "Retry-After": String(rejection.retryAfterSeconds) } };
      }
    }
    const id = randomUUID();
    // 跨 run 独占资源：single/verified 按包声明在准入时整体占用；
    // plan 模式由调度器经同一张宿主表按子任务粒度管理，此处不占
    const admissionPack = parsed.pack ? getPack(parsed.pack) : pack;
    const packResources = wantsOrchestrate ? [] : (admissionPack?.resources ?? []);
    const resourceOutcome = tryAcquireRunResources(id, packResources);
    if (resourceOutcome !== "acquired") {
      metrics.resourceRejected += 1;
      return {
        status: 429,
        payload: {
          error:
            `Exclusive resource "${resourceOutcome.conflict}" is held by run ${resourceOutcome.heldBy}. ` +
            "Wait for that run to finish (or stop it), then retry.",
          resource: resourceOutcome.conflict,
          heldBy: resourceOutcome.heldBy,
        },
      };
    }
    const workdirRejection = sharedWorkdirRejection(id, runWorkdir ?? workdir);
    if (workdirRejection) {
      hostResources.release(packResources, id);
      metrics.workdirRejected += 1;
      return {
        status: 409,
        payload: {
          error:
            `Workdir is in use by running run ${workdirRejection.conflictRunId}. Concurrent runs sharing a workdir ` +
            "can silently overwrite each other's artifacts; give each run its own workdir " +
            "(AGENT_UI_WORKDIRS) or wait for the other run.",
          conflictRunId: workdirRejection.conflictRunId,
        },
      };
    }
    const releaseAdmission = acquireRunAdmission();
    if (!releaseAdmission) {
      hostResources.release(packResources, id);
      metrics.capacityRejected += 1;
      return { status: 429, payload: capacityRejectionPayload(), headers: { "Retry-After": "1" } };
    }
    const run: StoredRun = {
      id,
      task: parsed.task,
      title: summarizeTitle(parsed.task),
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
      ...(packRoute ? { packRoute } : {}),
      ...(parsed.effort ? { effort: parsed.effort as Effort } : {}),
      ...(parsed.rubric ? { rubric: parsed.rubric } : {}),
      workspace: admittedWorkspace ?? (wantsDesign ? "office" : "code"),
      ...(wantsOrchestrate
        ? { mode: "plan" as const }
        : wantsDesign
          ? {
              mode: "design" as const,
              ...(admittedDesignRoute
                ? { designRoute: designRouteForRunConfig(admittedDesignRoute) }
                : {}),
            }
          : {}),
      ...(concurrency !== undefined ? { concurrency } : {}),
      ...(runWorkdir ? { workdir: runWorkdir } : {}),
      ...(extraWorkdirs.length ? { extraWorkdirs } : {}),
      ...(parsed.useVerifierModel === false ? { useVerifierModel: false } : {}),
      ...(parsed.usePlannerModel === false ? { usePlannerModel: false } : {}),
      ...(planGateRequested ? { planGate: true } : {}),
      ...(askUser ? { askUser: true } : {}),
      ...(parsed.autoApprove === true ? { autoApprove: true } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(runContextTokenLimit !== undefined ? { contextTokenLimit: runContextTokenLimit } : {}),
      ...(packResources.length ? { heldResources: packResources } : {}),
      ...(lineageBudget ? {} : { lineageBudget: false }),
      ...(dailyBudget ? {} : { dailyBudget: false }),
    };
    if (extras?.injectedPlan) run.injectedPlan = extras.injectedPlan;
    if (extras?.parentRunId) run.continuedFrom = extras.parentRunId;
    const boot = resolveSiblingBootContext(parsed.task, run.workdir ?? workdir, id);
    if (boot) run.bootContext = boot;
    const citedIds = parseCitedRunIds(parsed.citedRunIds);
    if (citedIds.length) {
      const assembled = await assembleCitedRefs(citedIds, run.workdir ?? workdir);
      if (assembled.block) run.citeContext = assembled.block;
      if (assembled.refs.length) run.cited = assembled.refs;
    }
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
        // 窗口 / 预算随 trace 根 span 走：事后回放"这次在窗口的几分之几处压缩"不必再翻台账
        const tracePlan = contextPlanFor(run.packName ? getPack(run.packName) : pack, run.contextTokenLimit);
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
            contextWindow: tracePlan.window,
            contextWindowSource: tracePlan.windowSource,
            contextBudget: tracePlan.budget,
            contextBudgetSource: tracePlan.budgetSource,
          },
        });
        run.traceRunSpanId = root.spanId;
        run.openToolSpans = new Map();
        run.openModelSpans = new Map();
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

    if (admittedDesignRoute) {
      await applyUiDesignSeed(admittedDesignRoute, run.workdir ?? workdir);
    }

    if (run.mode === "plan") {
      void withFallbackAttribution(run, () => startPlannedRun(run));
    } else if (verify) {
      void withFallbackAttribution(run, () => startVerifiedRun(run));
    } else {
      void withFallbackAttribution(run, () => startPlainRun(run));
    }

    return { status: 200, payload: { runId: id } };
  }

  /**
   * T9 调度器装配：
   * - 状态一份：scheduleEntries 数组由 REST 处理器与 ScheduleRunner 共享（不设副本）；
   * - 发起 run 走 createRunFromBody——与 POST /api/runs 完全相同的内部入口；
   * - 落盘串行链：REST 变更与 tick 的 onChange 都排进同一条链，写盘不互相踩；
   * - 持久化文件 <workdir>/.agent-schedules.json（AGENT_SCHEDULES_FILE 可覆盖，
   *   测试隔离用）；启动容错：坏文件备份 .bak 后空表（scheduler.ts 判据①）。
   */
  const schedulesFile = schedulesFilePath(process.env, workdir);
  const scheduleEntries: ScheduleEntry[] = [];
  let schedulePersistChain: Promise<void> = Promise.resolve();
  const persistSchedules = (): void => {
    schedulePersistChain = schedulePersistChain
      .then(() => saveSchedules(schedulesFile, scheduleEntries))
      .catch((error: unknown) => {
        if (realHost) {
          operationalLog("warn", "schedules_persist_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
  };
  const scheduleRunner = new ScheduleRunner({
    entries: scheduleEntries,
    launch: async (entry) => {
      // 与 HTTP 路径同一道隔离健康门（scheduler.ts 判据⑤：失败记 error 并顺推）
      await refreshExecutionHealth(true);
      if (!executionHealthy) {
        return {
          ok: false,
          error: `Required command isolation is unavailable: ${processExecutionStatus.probe.reason ?? "backend probe failed"}`,
        };
      }
      const outcome = await createRunFromBody({
        task: entry.task,
        workdir: entry.workdir,
        verify: entry.verify,
      });
      if (outcome.status === 200) {
        return { ok: true, runId: (outcome.payload as { runId: string }).runId };
      }
      const message = (outcome.payload as { error?: unknown } | null)?.error;
      return {
        ok: false,
        error: typeof message === "string" ? message : `准入失败（HTTP ${outcome.status}）`,
      };
    },
    isRunActive: (runId) => runs.get(runId)?.status === "running",
    onChange: persistSchedules,
  });
  const schedulesReady: Promise<void> = (async () => {
    const loaded = await loadSchedules(schedulesFile);
    scheduleEntries.push(...loaded.entries);
    if (loaded.recovered && realHost) {
      operationalLog("warn", "schedules_recovered", { file: schedulesFile });
    }
    // 启动处置（scheduler.ts 判据③）：补算缺失的 nextRunAt；
    // 停机期间错过超过 24h 的 once/daily 标 missed 不补跑
    const now = Date.now();
    let changed = loaded.recovered;
    for (const entry of scheduleEntries) {
      if (entry.enabled && entry.nextRunAt === null) {
        entry.nextRunAt = computeNextRunAt(entry.schedule, now, entry.lastRunAt ?? entry.createdAt);
        changed = true;
      }
      if (isMissed(entry, now)) {
        entry.lastTrigger = { at: now, outcome: "missed", runId: null, note: "宿主停机期间错过触发超过 24 小时，未补跑" };
        advanceAfterMiss(entry, now);
        changed = true;
      }
    }
    if (changed) persistSchedules();
  })();
  const scheduleTimer = setInterval(() => {
    void scheduleRunner.tick();
  }, SCHEDULE_TICK_MS);
  // 不挡进程退出（测试宿主 close 前进程就该能走）；首轮 tick 等加载完成后立刻跑
  scheduleTimer.unref?.();
  void schedulesReady.then(() => scheduleRunner.tick());

  /** 列表端点的 DTO：原样透出 + 服务端当前时刻（前端倒计时以它为锚，不赌客户端时钟） */
  function scheduleListPayload(): { schedules: ScheduleEntry[]; serverTime: number } {
    return { schedules: scheduleEntries, serverTime: Date.now() };
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

    if (MUTATION_QUOTA_ROUTES.has(route.type)) {
      const retryAfter = mutationRetryAfter(req);
      if (retryAfter !== null) {
        metrics.rateRejected += 1;
        res.setHeader("Retry-After", String(retryAfter));
        return json(res, 429, { error: "Mutation rate limit exceeded" });
      }
    }

    if (method === "POST" || method === "PUT" || method === "PATCH"
      || (method === "DELETE" && (route.type === "workdirRemove" || route.type === "uploadDelete"))) {
      const jsonRoute = new Set([
        "upload",
        "uploadDelete",
        "followUp",
        "forkConversation",
        "rewindConversation",
        "inspectPaths",
        "reveal",
        "createRun",
        "scheduleCreate",
        "planApproval",
        "handoff",
        "answer",
        "approval",
        "autoApprove",
        "modelsPut",
        "modelsRolesPatch",
        "modelsTest",
        "workdirAdd",
        "designDraftsWorkdir",
        "workdirRemove",
        "fsMkdir",
        "workspaceGitCheckout",
        "seedTemplate",
        "exportPptx",
        "exportPng",
        "packsDraft",
      ]).has(route.type);
      const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
      if (jsonRoute && !/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/.test(contentType)) {
        return json(res, 415, { error: "Content-Type must be application/json" });
      }
    }

    // B2：档案恢复完成前不应答 API——启动后的第一个 GET /api/runs 就要看得到
    // 历史，否则界面会先画一份空列表再闪一次（静态资源不用等）
    if (route.type !== "static" && route.type !== "health" && route.type !== "metrics") {
      await Promise.all([historyReady, executionReady, packsReady]);
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

      /**
       * MODEL-02 模型库端点。
       *
       * GET：整库脱敏出栈（apiKey 只进不出，只回 hasApiKey）+ 当前角色装配快照。
       * PUT：整表替换。校验全过 → 先落盘（原子写）→ 再重装配；任何一步失败都
       * 不动在跑的配置。apiKey 三态：省略 = 保持不变；"" = 清除（走环境变量）；
       * 非空 = 更新。重装配只影响**新** run——进行中的 run 手持旧 client 引用。
       * POST /test：1 token 的最小请求验证 端点/key/模型名 三元组，10s 超时。
       */
      case "modelsGet":
        return json(res, 200, modelsApiPayload());

      case "modelsPut": {
        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }
        const result = validateModelConfig(parsed as ModelConfigInput, modelStoreState.store);
        if (!result.ok) {
          return json(res, 400, { error: result.errors[0], errors: result.errors });
        }
        if (modelStoreFile) {
          try {
            saveModelStore(modelStoreFile, result.store);
          } catch (error) {
            return json(res, 500, {
              error: `模型库写盘失败：${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
        modelStoreState = { store: result.store, source: modelStoreFile ? "store" : "env" };
        try {
          // 注入 modelClient 的宿主锁定执行者（假模型语义由注入方掌控）；
          // 角色（verifier/planner/vision）始终可重装配。
          if (!options.modelClient) {
            const entry = roleEntryOf(result.store, "executor");
            assembleExecutor(entry);
            probeExecutorEndpoint(entry);
          }
          visionProbe = null;
          assembleRoles();
          probeVisionEndpoint();
        } catch (error) {
          return json(res, 500, {
            error: `模型装配失败：${error instanceof Error ? error.message : String(error)}`,
          });
        }
        if (realHost) {
          operationalLog("info", "models_updated", {
            source: modelStoreState.source,
            modelCount: result.store.models.length,
          });
        }
        return json(res, 200, modelsApiPayload());
      }

      case "modelsRolesPatch": {
        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          return badRequest(res, "Invalid JSON body");
        }
        const nextRoles = { ...modelStoreState.store.roles };
        for (const key of ROLE_KEYS) {
          if (!(key in parsed)) continue;
          const v = parsed[key];
          if (key === "executor") {
            if (typeof v !== "string" || !v) {
              return badRequest(res, "executor 必须指向库中的模型 id");
            }
            if (!modelStoreState.store.models.some((m) => m.id === v)) {
              return badRequest(res, `executor 引用了不存在的模型 id：${v}`);
            }
            nextRoles.executor = v;
            continue;
          }
          if (v === null) {
            nextRoles[key] = null;
            continue;
          }
          if (typeof v !== "string" || !v) {
            return badRequest(res, `${key} 必须是模型 id 或 null`);
          }
          if (!modelStoreState.store.models.some((m) => m.id === v)) {
            return badRequest(res, `${key} 引用了不存在的模型 id：${v}`);
          }
          nextRoles[key] = v;
        }
        if (!nextRoles.executor) {
          return badRequest(res, "executor 不能为空");
        }
        const nextStore = { ...modelStoreState.store, roles: nextRoles };
        if (modelStoreFile) {
          try {
            saveModelStore(modelStoreFile, nextStore);
          } catch (error) {
            return json(res, 500, {
              error: `模型库写盘失败：${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
        modelStoreState = { store: nextStore, source: modelStoreFile ? "store" : "env" };
        try {
          if (!options.modelClient) {
            const entry = roleEntryOf(nextStore, "executor");
            assembleExecutor(entry);
            probeExecutorEndpoint(entry);
          }
          visionProbe = null;
          assembleRoles();
          probeVisionEndpoint();
        } catch (error) {
          return json(res, 500, {
            error: `模型装配失败：${error instanceof Error ? error.message : String(error)}`,
          });
        }
        if (realHost) {
          const plan = processContextPlan();
          operationalLog("info", "models_roles_updated", {
            executor: nextRoles.executor,
            contextWindow: plan.window,
            windowSource: plan.windowSource,
          });
        }
        return json(res, 200, modelsApiPayload());
      }

      case "modelsTest": {
        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(body);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }
        if (parsed.provider !== "anthropic" && parsed.provider !== "openai") {
          return badRequest(res, 'provider 只能是 "anthropic" 或 "openai"');
        }
        if (typeof parsed.model !== "string" || !isValidModelName(parsed.model)) {
          return badRequest(res, "model 无效：不能为空、不能带首尾空白或控制字符，且最长 200 字符");
        }
        let baseUrl = "";
        try {
          baseUrl = normalizeBaseUrl(parsed.baseUrl);
        } catch (error) {
          return badRequest(res, error instanceof Error ? error.message : String(error));
        }
        // key 解析顺序：表单显式值 > 该 provider 的环境变量；都没有就当场说清楚，
        // 不发一个注定 401 的请求
        const envKey = parsed.provider === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
        const apiKey = (typeof parsed.apiKey === "string" && parsed.apiKey) || envKey || "";
        if (!apiKey) {
          return json(res, 200, {
            ok: false,
            error: `缺少 API Key：请在表单中填写，或配置环境变量 ${parsed.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"}`,
          });
        }
        const testResult = await testModelEndpoint({
          provider: parsed.provider,
          model: parsed.model,
          baseUrl,
          apiKey,
          timeoutMs: 10_000,
        });
        return json(res, 200, testResult);
      }

      case "modelsSyncEnv": {
        if (!hostname || !isLoopbackHostname(hostname)) {
          return json(res, 403, { error: "同步到 .env 仅本机（loopback）可用" });
        }
        if (!envFile) {
          return json(res, 409, { error: "当前宿主未配置 .env 落点（注入宿主默认不写）" });
        }
        const updates = envUpdatesFromStore({
          models: modelStoreState.store.models.map((m) => ({
            id: m.id,
            provider: m.provider,
            model: m.model,
            baseUrl: m.baseUrl,
          })),
          roles: { ...modelStoreState.store.roles },
        });
        let existing = "";
        try {
          existing = await readFile(envFile, "utf8");
        } catch {
          existing = "";
        }
        const synced = upsertEnvKeys(existing, updates);
        await writeFile(envFile, synced.text, "utf8");
        if (realHost) operationalLog("info", "env_synced", { file: envFile, changed: synced.changed });
        return json(res, 200, { ok: true, file: envFile, changed: synced.changed });
      }

      case "usageGet": {
        if (!ledgerFile) {
          return json(res, 200, aggregateUsage([]));
        }
        let text = "";
        try {
          text = await readFile(ledgerFile, "utf8");
        } catch {
          text = "";
        }
        return json(res, 200, aggregateUsage(parseLedgerLines(text)));
      }

      case "mcpGet": {
        let servers: Record<string, unknown> = {};
        try {
          servers = parseMcpConfigFile(await readFile(mcpConfigPath, "utf8")).servers;
        } catch {
          servers = {};
        }
        return json(res, 200, {
          path: mcpConfigPath,
          enabled: mcpEnabled,
          servers: publicMcpServers(servers),
        });
      }

      case "packsGet": {
        if (!packsRoot) {
          return json(res, 200, { drafts: [], installed: [], root: null });
        }
        const listed = await listFilePacks(packsRoot);
        return json(res, 200, { ...filePackListView(listed), root: packsRoot });
      }

      case "packsDraft": {
        if (!hostname || !isLoopbackHostname(hostname)) {
          return json(res, 403, { error: "领域包草稿仅本机（loopback）可写" });
        }
        if (!packsRoot) {
          return json(res, 400, { error: "文件包目录未配置" });
        }
        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let parsed: { name?: unknown; description?: unknown; systemPrompt?: unknown; verifyInstructions?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }
        try {
          const rec = await writeDraftPack(packsRoot, {
            name: String(parsed.name ?? ""),
            description: String(parsed.description ?? ""),
            systemPrompt: String(parsed.systemPrompt ?? ""),
            ...(typeof parsed.verifyInstructions === "string"
              ? { verifyInstructions: parsed.verifyInstructions }
              : {}),
          });
          const listed = await listFilePacks(packsRoot);
          return json(res, 200, {
            ok: true,
            draft: { name: rec.name, description: rec.manifest.description, dir: rec.dir },
            ...filePackListView(listed),
            root: packsRoot,
          });
        } catch (error) {
          return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }

      case "packsInstall": {
        if (!hostname || !isLoopbackHostname(hostname)) {
          return json(res, 403, { error: "安装领域包仅本机（loopback）可用" });
        }
        if (!packsRoot) {
          return json(res, 400, { error: "文件包目录未配置" });
        }
        try {
          const rec = await installDraftPack(packsRoot, route.name);
          const listed = await listFilePacks(packsRoot);
          return json(res, 200, {
            ok: true,
            installedPack: { name: rec.name, description: rec.manifest.description },
            ...filePackListView(listed),
            root: packsRoot,
            availablePacks: availablePacksView(),
          });
        } catch (error) {
          return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }

      case "packsDiscard": {
        if (!hostname || !isLoopbackHostname(hostname)) {
          return json(res, 403, { error: "丢弃草稿仅本机（loopback）可用" });
        }
        if (!packsRoot) {
          return json(res, 400, { error: "文件包目录未配置" });
        }
        try {
          await discardDraftPack(packsRoot, route.name);
          const listed = await listFilePacks(packsRoot);
          return json(res, 200, { ok: true, ...filePackListView(listed), root: packsRoot });
        } catch (error) {
          return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }

      case "mcpPut": {
        if (!hostname || !isLoopbackHostname(hostname)) {
          return json(res, 403, { error: "MCP 配置仅本机（loopback）可用" });
        }
        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let parsed: { name?: unknown; server?: unknown; remove?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }
        if (typeof parsed.name !== "string" || !parsed.name.trim()) {
          return badRequest(res, '"name" 必须是非空字符串');
        }
        let current: Record<string, unknown> = {};
        try {
          current = parseMcpConfigFile(await readFile(mcpConfigPath, "utf8")).servers;
        } catch {
          current = {};
        }
        try {
          current = applyMcpServerPatch(
            current,
            parsed.name,
            parsed.remove === true ? null : (parsed.server as Parameters<typeof applyMcpServerPatch>[2] ?? {}),
          );
        } catch (error) {
          return badRequest(res, error instanceof Error ? error.message : String(error));
        }
        await writeFile(mcpConfigPath, serializeMcpConfig(current), "utf8");
        if (realHost) operationalLog("info", "mcp_updated", { name: parsed.name, removed: parsed.remove === true });
        return json(res, 200, {
          path: mcpConfigPath,
          enabled: mcpEnabled,
          servers: publicMcpServers(current),
        });
      }

      /**
       * V-29 运行时白名单扩展。工作目录是工具写入圈禁根，这组端点等于在改
       * 圈禁边界——所以**仅 loopback 可用**：能摸到这个端点 = 坐在宿主机器前，
       * 与「宿主声明」同一信任级。非 loopback 一律 403（host 白名单放行的
       * 远程来源也不行，这条线与 origin 边界相互独立）。
       */
      case "workdirsList": {
        if (!hostname || !isLoopbackHostname(hostname)) {
          return json(res, 403, { error: "工作目录管理仅本机（loopback）可用" });
        }
        return json(res, 200, {
          workdirs: [...allowedWorkdirs],
          source: { env: [...envWorkdirs], stored: [...runtimeWorkdirs] },
        });
      }

      case "workdirAdd": {
        if (!hostname || !isLoopbackHostname(hostname)) {
          return json(res, 403, { error: "工作目录管理仅本机（loopback）可用" });
        }
        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let parsed: { path?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }
        if (typeof parsed.path !== "string" || !parsed.path.trim()) {
          return badRequest(res, '缺少目录路径（path）');
        }
        const raw = parsed.path.trim();
        if (!isAbsolute(raw)) {
          return badRequest(res, `需要绝对路径：${raw}`);
        }
        const asked = resolve(raw);
        let st;
        try {
          st = await stat(asked);
        } catch {
          return notFound(res, `目录不存在：${asked}`);
        }
        if (!st.isDirectory()) {
          return badRequest(res, `不是目录：${asked}`);
        }
        // 软链接/junction 归一：落进集合的必须是真实路径形态，否则同一个
        // 目录能以两个名字各占一条白名单（比对口径是字符串精确相等）
        let canonical: string;
        try {
          canonical = resolve(await realpath(asked));
        } catch {
          canonical = asked;
        }
        if (allowedWorkdirs.has(canonical)) {
          return json(res, 200, {
            added: false,
            workdir: canonical,
            workdirs: [...allowedWorkdirs],
            source: { env: [...envWorkdirs], stored: [...runtimeWorkdirs] },
          });
        }
        runtimeWorkdirs.add(canonical);
        allowedWorkdirs.add(canonical);
        try {
          persistRuntimeWorkdirs();
        } catch (error) {
          // 落盘失败就回滚内存态——否则界面以为加成功了，重启后又消失
          runtimeWorkdirs.delete(canonical);
          allowedWorkdirs.delete(canonical);
          return json(res, 500, {
            error: `工作目录清单写盘失败：${error instanceof Error ? error.message : String(error)}`,
          });
        }
        if (realHost) {
          operationalLog("info", "workdir_added", { workdir: canonical });
        }
        return json(res, 200, {
          added: true,
          workdir: canonical,
          workdirs: [...allowedWorkdirs],
          source: { env: [...envWorkdirs], stored: [...runtimeWorkdirs] },
        });
      }

      /**
       * 设计模式稿目录：mkdir + 加入白名单。当前目录是宿主仓库才建议切过去；
       * 用户已选别的目录不抢。
       */
      case "designDraftsWorkdir": {
        if (!hostname || !isLoopbackHostname(hostname)) {
          return json(res, 403, { error: "工作目录管理仅本机（loopback）可用" });
        }
        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let parsed: { currentWorkdir?: unknown };
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          return badRequest(res, "Invalid JSON");
        }
        const currentRaw = typeof parsed.currentWorkdir === "string" ? parsed.currentWorkdir.trim() : "";
        let currentAbs = currentRaw ? resolve(currentRaw) : "";
        if (currentAbs && !allowedWorkdirs.has(currentAbs)) {
          const hit = [...allowedWorkdirs].find((w) => sameWorkdirPath(w, currentAbs));
          currentAbs = hit ?? "";
        }
        try {
          await mkdir(designDraftsDir, { recursive: true });
        } catch (err) {
          return json(res, 500, {
            error: `无法创建设计稿目录：${(err as Error).message ?? String(err)}`,
          });
        }
        let canonical = designDraftsDir;
        try {
          canonical = resolve(await realpath(designDraftsDir));
        } catch {
          canonical = resolve(designDraftsDir);
        }
        const already = allowedWorkdirs.has(canonical);
        if (!already) {
          runtimeWorkdirs.add(canonical);
          allowedWorkdirs.add(canonical);
          try {
            persistRuntimeWorkdirs();
          } catch (error) {
            runtimeWorkdirs.delete(canonical);
            allowedWorkdirs.delete(canonical);
            return json(res, 500, {
              error: `工作目录清单写盘失败：${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
        let currentIsHarness = false;
        const probe = currentAbs || workdir;
        try {
          currentIsHarness = isHarnessPackageName(
            packageNameFromJson(await readFile(join(probe, "package.json"), "utf8")),
          );
        } catch { /* 没有 package.json 就不是宿主仓库 */ }
        const decision = decideDesignDraftsSelection({
          currentWorkdir: currentAbs || null,
          draftsDir: canonical,
          currentIsHarness,
        });
        return json(res, 200, {
          workdir: canonical,
          added: !already,
          select: decision.select,
          reason: decision.reason,
          workdirs: [...allowedWorkdirs],
        });
      }

      case "workdirRemove": {
        if (!hostname || !isLoopbackHostname(hostname)) {
          return json(res, 403, { error: "工作目录管理仅本机（loopback）可用" });
        }
        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let parsed: { path?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }
        if (typeof parsed.path !== "string" || !parsed.path.trim()) {
          return badRequest(res, '缺少目录路径（path）');
        }
        const target = resolve(parsed.path.trim());
        if (envWorkdirs.has(target)) {
          return json(res, 403, {
            error: "该目录由宿主启动时声明（默认工作目录或 AGENT_UI_WORKDIRS），不能从界面删除；要移除请改启动配置",
          });
        }
        if (!runtimeWorkdirs.has(target)) {
          return notFound(res, `不在运行时添加的目录列表里：${target}`);
        }
        if (workdirInFlight(target)) {
          return json(res, 409, { error: `有正在运行的对话在使用该目录，不能删除：${target}` });
        }
        runtimeWorkdirs.delete(target);
        allowedWorkdirs.delete(target);
        try {
          persistRuntimeWorkdirs();
        } catch (error) {
          runtimeWorkdirs.add(target);
          allowedWorkdirs.add(target);
          return json(res, 500, {
            error: `工作目录清单写盘失败：${error instanceof Error ? error.message : String(error)}`,
          });
        }
        if (realHost) {
          operationalLog("info", "workdir_removed", { workdir: target });
        }
        return json(res, 200, {
          removed: true,
          workdir: target,
          workdirs: [...allowedWorkdirs],
          source: { env: [...envWorkdirs], stored: [...runtimeWorkdirs] },
        });
      }

      case "workspaceGitGet": {
        const listed = listedWorkdir(route.workdir);
        if (!listed.ok) return json(res, listed.status, { error: listed.error });
        return json(res, 200, publicWorkspaceGit(await probeWorkspaceGit(listed.path)));
      }

      case "workspaceGitCheckout": {
        if (!hostname || !isLoopbackHostname(hostname)) {
          return json(res, 403, { error: "切换分支仅本机（loopback）可用" });
        }
        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let parsed: { workdir?: unknown; branch?: unknown; dirtyAction?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }
        const listed = listedWorkdir(parsed.workdir);
        if (!listed.ok) return json(res, listed.status, { error: listed.error });
        const branch = typeof parsed.branch === "string" ? parsed.branch.trim() : "";
        if (!branch) return badRequest(res, "缺少分支名（branch）");
        let dirtyAction: WorkspaceDirtyAction | undefined;
        if (parsed.dirtyAction !== undefined && parsed.dirtyAction !== null && parsed.dirtyAction !== "") {
          if (parsed.dirtyAction !== "stash" && parsed.dirtyAction !== "discard") {
            return badRequest(res, "dirtyAction 只能是 stash 或 discard");
          }
          dirtyAction = parsed.dirtyAction;
        }
        const current = await probeWorkspaceGit(listed.path);
        if (!current.present) {
          return json(res, 409, { error: "当前工作目录不是 git 仓库", present: false });
        }
        if (!current.branches.includes(branch)) {
          return badRequest(res, `本地没有分支 ${branch}`);
        }
        if (current.dirty && !dirtyAction) {
          return json(res, 409, {
            error: "工作区有未提交改动，切换前需要先选择如何处理",
            code: "dirty_worktree",
            dirty: true,
            branch: current.branch,
          });
        }
        try {
          const next = await switchWorkspaceBranch(listed.path, branch, dirtyAction ? { dirtyAction } : {});
          return json(res, 200, publicWorkspaceGit(next));
        } catch (error) {
          if (error instanceof DirtyWorktreeError) {
            return json(res, 409, {
              error: error.message,
              code: error.code,
              dirty: true,
              branch: current.branch,
            });
          }
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith("非法分支名")) return badRequest(res, message);
          return json(res, 409, { error: message });
        }
      }

      case "fsList": {
        if (!hostname || !isLoopbackHostname(hostname)) {
          return json(res, 403, { error: "目录浏览仅本机（loopback）可用" });
        }
        /**
         * 目录浏览只给「添加目录」浮层供数：只列目录不列文件；.开头的隐藏目录
         * 不列；读不了的跳过而不是让整个列表失败。path 省略 = 给常用起点
         * （宿主 workdir + 现有白名单 + 系统盘符/根）。
         */
        if (route.path === null || route.path.trim() === "") {
          const roots: { name: string; path: string }[] = [];
          const seenRoots = new Set<string>();
          const pushRoot = (p: string, name: string) => {
            const key = resolve(p);
            if (seenRoots.has(key)) return;
            seenRoots.add(key);
            roots.push({ name, path: key });
          };
          pushRoot(workdir, "宿主工作目录");
          for (const d of allowedWorkdirs) {
            if (d !== workdir) pushRoot(d, "白名单目录");
          }
          try {
            const home = homedir();
            if (home) {
              pushRoot(home, "用户主目录");
              for (const [folder, label] of [
                ["Desktop", "桌面"],
                ["Documents", "文档"],
                ["Downloads", "下载"],
                ["桌面", "桌面"],
                ["文档", "文档"],
                ["下载", "下载"],
              ] as const) {
                const place = join(home, folder);
                try {
                  await access(place);
                  pushRoot(place, label);
                } catch { /* 这台机器没有这个常用目录 */ }
              }
            }
          } catch { /* homedir 不可用时仍有盘符/白名单 */ }
          if (process.platform === "win32") {
            for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
              const drive = `${letter}:\\`;
              try {
                await access(drive);
                pushRoot(drive, `${letter}: 盘`);
              } catch { /* 盘符不存在，跳过 */ }
            }
          } else {
            pushRoot("/", "根目录");
          }
          return json(res, 200, { path: null, parent: null, dirs: roots, separator: sep });
        }
        const asked = resolve(route.path.trim());
        let st;
        try {
          st = await stat(asked);
        } catch {
          return notFound(res, `目录不存在或读不了：${asked}`);
        }
        if (!st.isDirectory()) {
          return badRequest(res, `不是目录：${asked}`);
        }
        let entries;
        try {
          entries = await readdir(asked, { withFileTypes: true });
        } catch {
          return json(res, 403, { error: `没有权限读取该目录：${asked}` });
        }
        const dirs: { name: string; path: string }[] = [];
        for (const entry of entries) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          if (entry.name.startsWith(".")) continue;
          const abs = join(asked, entry.name);
          try {
            // realpath 一石三鸟：解符号链接（点进去落在真实位置）、
            // 顺带验证子目录真实存在且可读、过滤 dangling link
            const real = resolve(await realpath(abs));
            const sub = await stat(real);
            if (!sub.isDirectory()) continue;
            await access(real);
            dirs.push({ name: entry.name, path: real });
          } catch { /* 读不了/断链的目录跳过 */ }
        }
        dirs.sort((a, b) => a.name.localeCompare(b.name));
        const parent = dirname(asked);
        return json(res, 200, {
          path: asked,
          parent: parent === asked ? null : parent,
          dirs,
          separator: sep,
        });
      }

      case "fsMkdir": {
        if (!hostname || !isLoopbackHostname(hostname)) {
          return json(res, 403, { error: "新建文件夹仅本机（loopback）可用" });
        }
        let mkdirBody: string;
        try {
          mkdirBody = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let mkdirParsed: { path?: unknown; name?: unknown };
        try {
          mkdirParsed = JSON.parse(mkdirBody);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }
        if (typeof mkdirParsed.path !== "string" || !mkdirParsed.path.trim()) {
          return badRequest(res, "缺少父目录路径（path）");
        }
        if (typeof mkdirParsed.name !== "string" || !isSafeFolderName(mkdirParsed.name)) {
          return badRequest(res, "文件夹名不合法（不能含路径分隔符或 \\ / : * ? \" < > |）");
        }
        const parent = resolve(mkdirParsed.path.trim());
        try {
          const parentStat = await stat(parent);
          if (!parentStat.isDirectory()) {
            return badRequest(res, `不是目录：${parent}`);
          }
        } catch {
          return notFound(res, `目录不存在或读不了：${parent}`);
        }
        const target = join(parent, mkdirParsed.name.trim());
        if (resolve(dirname(target)) !== parent) {
          return badRequest(res, "文件夹名不合法");
        }
        try {
          await mkdir(target, { recursive: false });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EEXIST") {
            return json(res, 409, { error: `已经有这个文件夹：${target}` });
          }
          return json(res, 500, {
            error: `新建失败：${error instanceof Error ? error.message : String(error)}`,
          });
        }
        return json(res, 200, { path: target, parent, name: mkdirParsed.name.trim() });
      }

      case "citeCandidates": {
        const listed = listedWorkdir(route.workdir);
        if (!listed.ok) return json(res, listed.status, { error: listed.error });
        const root = listed.path;
        const artifacts = await resolveCiteArtifacts(root);
        const rows = [...runs.values()]
          .filter((r) => resolve(r.workdir ?? workdir) === root)
          .map((r) => ({
            runId: r.id,
            title: resolveRunTitle(r.title, r.task),
            task: oneLineTask(r.task),
            conversationRecap: r.conversationRecap || recapFromRunEvents(r) || null,
            continuedFrom: r.continuedFrom ?? null,
            createdAt: r.createdAt,
            artifacts,
          }));
        const candidates = visibleCiteRuns(rows)
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(({ continuedFrom: _c, createdAt: _t, ...rest }) => rest);
        return json(res, 200, { workdir: root, candidates });
      }

      case "memoryList": {
        /**
         * T5 记忆面板：默认 current = 当前项目 + 全局教训 + 进行中看板。
         * 目录不存在 = 还没有记忆，返回空列表而不是报错（与 MemoryStore.list 同口径）。
         */
        let targetWorkdir = workdir;
        if (route.workdir) {
          const listed = listedWorkdir(route.workdir);
          if (!listed.ok) return json(res, listed.status, { error: listed.error });
          targetWorkdir = listed.path;
        }
        const memDir = resolveMemoryDir(targetWorkdir);
        const store = memDir === defaultMemoryDir ? defaultMemoryStore : new MemoryStore(memDir);
        const shared = isSharedMemoryDir(targetWorkdir, memDir);
        const project = projectSlugFromWorkdir(targetWorkdir);
        const annotated = await annotateMemoryEntries(store, targetWorkdir);
        const visible = route.scope === "all"
          ? annotated
          : annotated.filter((entry) => entry.scope !== "other");
        const withMtime = await Promise.all(
          visible.map(async (entry) => {
            let mtimeMs: number | null = null;
            try {
              mtimeMs = (await stat(join(memDir, entry.name))).mtimeMs;
            } catch { /* 列出后被并发删掉：mtime 降级为 null，不拖垮整个列表 */ }
            return { name: entry.name, summary: entry.summary, sizeBytes: entry.sizeBytes, scope: entry.scope, mtimeMs };
          }),
        );
        const status = await readProjectStatus(store, targetWorkdir, shared);
        return json(res, 200, {
          dir: memDir,
          project,
          shared,
          status,
          entries: withMtime,
        });
      }

      case "memoryRead": {
        /**
         * T5 单条记忆全文（只读）。名字已在路由层按 MemoryStore.NAME_RE 校验
         * （含嵌套路径）；resolvePath 再做一次逃逸校验（双保险）。
         */
        let content: string;
        try {
          content = await defaultMemoryStore.read(route.name);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | null)?.code;
          if (code === "ENOENT") return notFound(res, `Memory not found: ${route.name}`);
          return badRequest(res, error instanceof Error ? error.message : String(error));
        }
        const sizeBytes = Buffer.byteLength(content, "utf8");
        let truncated = false;
        if (sizeBytes > MEMORY_READ_MAX_BYTES) {
          content = utf8SafeHead(content, MEMORY_READ_MAX_BYTES);
          truncated = true;
        }
        return json(res, 200, { name: route.name, content, sizeBytes, truncated });
      }

      case "searchRuns": {
        /**
         * T6 全局搜索：历史档案的标题（meta.task）+ 正文（transcript.jsonl）
         * 大小写不敏感子串匹配。只读；无历史根（注入 modelClient 的测试宿主
         * 缺省不落盘）时返回空结果而不是报错，与 memoryList 同口径。
         */
        const query = route.query.trim();
        if (query.length < SEARCH_MIN_QUERY_CHARS) {
          return badRequest(res, `Query must be at least ${SEARCH_MIN_QUERY_CHARS} characters`);
        }
        if (!historyRoot) {
          return json(res, 200, { query, results: [], truncatedRuns: false });
        }
        let limit = SEARCH_DEFAULT_LIMIT;
        if (route.limit !== null) {
          const parsed = Number(route.limit);
          if (Number.isInteger(parsed) && parsed >= 1) {
            limit = Math.min(parsed, SEARCH_MAX_LIMIT);
          }
        }
        return json(res, 200, await searchRunHistory(historyRoot, query, limit));
      }

      /**
       * T8 变更审查：这次运行触碰了哪些文件。
       *
       * 数据源是 run 的事件流（在飞 run 的内存缓冲 / 归档 run 的 events.jsonl，
       * hydrateArchive 统一成同一份），只聚合 write_file / write_pptx / edit_file 的 tool_call
       * 入参路径——bash 写盘从入参读不出路径，宁缺勿假。
       *
       * 圈禁与产物取件同一条纪律：路径按**该 run 自己的 workdir** 用
       * resolveInWorkdir 解析；越界路径（含 workdir 已被删导致无法校验）标
       * outOfScope: true，不 stat、不提供 git 信息，前端因此不给预览。
       * git 是增强不是门槛：非仓库 / git 不可用 / 单文件探针超 3 秒，一律
       * 静默降级为 git: null。
       */
      case "runChanges": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);
        await hydrateArchive(run); // 归档 run 的事件在磁盘上，首次访问才读
        const root = run.workdir ?? workdir;
        const isRepo = await detectGitRepo(root);
        const resolvedRoot = resolve(root);
        const touched = collectTouchedPaths(run.events);
        const changes: RunChangeEntry[] = await Promise.all(
          touched.map(async (t) => {
            let abs: string | null = null;
            try {
              abs = resolveInWorkdir(root, t.input);
            } catch { /* 越界：不 stat、不探 git，只如实回报入参原文 */ }
            const outOfScope = abs === null;
            const relPath = abs
              ? relative(resolvedRoot, abs).split(sep).join("/") || "."
              : t.input;
            let exists = false;
            let sizeBytes: number | null = null;
            let mtimeMs: number | null = null;
            if (abs) {
              try {
                const st = await stat(abs);
                if (st.isFile()) {
                  exists = true;
                  sizeBytes = st.size;
                  mtimeMs = st.mtimeMs;
                }
              } catch { /* 写完又被删：exists=false 也是事实 */ }
            }
            const git = isRepo && abs ? await probeGitForFile(root, relPath) : null;
            return {
              path: relPath,
              ops: [...t.ops],
              count: t.count,
              lastAt: t.lastAt,
              outOfScope,
              exists,
              sizeBytes,
              mtimeMs,
              git,
            };
          }),
        );
        // 最近触碰的排最前：审查视线先看"最后动了什么"
        changes.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
        return json(res, 200, { runId: run.id, workdir: root, git: isRepo, changes });
      }

      case "runsList": {
        // V-13：按 createdAt 降序。此前是插入顺序（最旧在上），而客户端提交后把
        // 新任务 unshift 到顶——3 秒后一轮询它就从顶跳到底。
        const list = [...runs.values()]
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(runSummary);
        return json(res, 200, list);
      }

      /**
       * T9 定时任务端点。持久化 <workdir>/.agent-schedules.json（原子写）；
       * 到期触发与手动触发都走 createRunFromBody——与 POST /api/runs 同一条
       * 准入链（白名单 / 容量 / 日预算 / 隔离健康），没有第二份逻辑。
       */
      case "schedulesList": {
        await schedulesReady;
        return json(res, 200, scheduleListPayload());
      }

      case "scheduleCreate": {
        await schedulesReady;
        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let parsed: {
          name?: string; task?: string; workdir?: string; verify?: boolean;
          enabled?: boolean; schedule?: unknown;
        };
        try {
          parsed = JSON.parse(body);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }
        if (!parsed.task || typeof parsed.task !== "string" || !parsed.task.trim()) {
          return badRequest(res, '任务描述（task）不能为空');
        }
        if (parsed.name !== undefined && typeof parsed.name !== "string") {
          return badRequest(res, '名称（name）必须是字符串');
        }
        // 工作目录与 /api/runs 同一条白名单（V-29）：resolve 后精确比对
        let scheduleWorkdir = workdir;
        if (parsed.workdir !== undefined && parsed.workdir !== "") {
          const asked = resolve(parsed.workdir);
          if (!allowedWorkdirs.has(asked)) {
            return badRequest(
              res,
              `工作目录不在白名单内。可选：${[...allowedWorkdirs].join(" | ")}（可点工作目录下拉的「＋ 添加目录…」即时加入）`,
            );
          }
          scheduleWorkdir = asked;
        }
        const schedule = parseScheduleSpec(parsed.schedule);
        if (!schedule) {
          return badRequest(
            res,
            '调度规则（schedule）不合法。支持：{kind:"once",at} / {kind:"daily",hhmm:"HH:MM"} / {kind:"interval",everyMs≥60000}',
          );
        }
        const now = Date.now();
        if (schedule.kind === "once" && schedule.at <= now) {
          return badRequest(res, "一次性任务的触发时间已过——请选一个未来的时刻");
        }
        const entry: ScheduleEntry = {
          id: randomUUID(),
          name: (parsed.name ?? "").trim() || parsed.task.trim().slice(0, 24),
          task: parsed.task.trim(),
          workdir: scheduleWorkdir,
          verify: parsed.verify === true,
          schedule,
          enabled: parsed.enabled !== false,
          createdAt: now,
          lastRunAt: null,
          lastRunId: null,
          nextRunAt: null,
          lastTrigger: null,
        };
        if (entry.enabled) {
          entry.nextRunAt = computeNextRunAt(entry.schedule, now, null);
        }
        scheduleEntries.push(entry);
        persistSchedules();
        if (realHost) {
          operationalLog("info", "schedule_created", { scheduleId: entry.id, kind: schedule.kind });
        }
        return json(res, 201, { schedule: entry });
      }

      case "scheduleUpdate": {
        await schedulesReady;
        const entry = scheduleEntries.find((e) => e.id === route.scheduleId);
        if (!entry) return notFound(res, `Schedule not found: ${route.scheduleId}`);
        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let parsed: { name?: unknown; task?: unknown; enabled?: unknown; schedule?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }
        let reschedule = false;
        if (parsed.name !== undefined) {
          if (typeof parsed.name !== "string" || !parsed.name.trim()) {
            return badRequest(res, '名称（name）不能为空字符串');
          }
          entry.name = parsed.name.trim();
        }
        if (parsed.task !== undefined) {
          if (typeof parsed.task !== "string" || !parsed.task.trim()) {
            return badRequest(res, '任务描述（task）不能为空');
          }
          entry.task = parsed.task.trim();
        }
        if (parsed.schedule !== undefined) {
          const schedule = parseScheduleSpec(parsed.schedule);
          if (!schedule) {
            return badRequest(res, "调度规则（schedule）不合法");
          }
          if (schedule.kind === "once" && schedule.at <= Date.now()) {
            return badRequest(res, "一次性任务的触发时间已过——请选一个未来的时刻");
          }
          entry.schedule = schedule;
          reschedule = true;
        }
        if (parsed.enabled !== undefined) {
          if (typeof parsed.enabled !== "boolean") {
            return badRequest(res, 'enabled 必须是布尔值');
          }
          if (entry.enabled !== parsed.enabled) {
            entry.enabled = parsed.enabled;
            reschedule = true;
          }
        }
        if (reschedule) {
          // 改时间 / 重新启用都按当下重排：禁用过久的 daily 不会从旧 nextRunAt 补跑
          const now = Date.now();
          entry.nextRunAt = entry.enabled
            ? computeNextRunAt(entry.schedule, now, entry.lastRunAt ?? entry.createdAt)
            : null;
        }
        persistSchedules();
        return json(res, 200, { schedule: entry });
      }

      case "scheduleDelete": {
        await schedulesReady;
        const index = scheduleEntries.findIndex((e) => e.id === route.scheduleId);
        if (index < 0) return notFound(res, `Schedule not found: ${route.scheduleId}`);
        scheduleEntries.splice(index, 1);
        persistSchedules();
        if (realHost) {
          operationalLog("info", "schedule_deleted", { scheduleId: route.scheduleId });
        }
        return json(res, 200, { deleted: true });
      }

      case "scheduleRun": {
        await schedulesReady;
        const entry = scheduleEntries.find((e) => e.id === route.scheduleId);
        if (!entry) return notFound(res, `Schedule not found: ${route.scheduleId}`);
        const outcome = await scheduleRunner.triggerNow(entry);
        if (outcome === "skipped") {
          return json(res, 409, {
            error: "上一次运行仍在进行，本次跳过",
            outcome,
            runId: entry.lastRunId,
          });
        }
        if (outcome === "missed") {
          // 已终结的一次性任务（已跑过/已错过）：没有"下一次"可顺推，拒绝重放
          return json(res, 409, { error: "一次性任务已终结，不能再次手动触发", outcome });
        }
        if (outcome === "error") {
          return json(res, 502, {
            error: entry.lastTrigger?.note ?? "启动失败",
            outcome,
          });
        }
        return json(res, 200, { runId: entry.lastRunId, outcome });
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
        if (!allowedWorkdirs.has(target)) {
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

      case "uploadDelete": {
        /**
         * 附件清单里那一下 ✕：把还没发出去的附件从盘上删掉。
         *
         * 这不是一个任意删文件的端点，两道闸缺一不可：
         *   ① 目标必须落在**白名单工作目录**之内（绝对路径逐一试
         *      `resolveInWorkdir`，相对路径按 workdir 参数解析并验白名单，
         *      与 filePreview 同一把尺）；
         *   ② 解析结果必须落在该工作目录的 `uploads/` 子目录之内——
         *      只许删上传落进去的东西，别的一个字节都不碰。
         * 已被某次提交用掉的文件客户端不会再调这里；真撞上了（404/409）
         * 客户端只做清单移除，盘上的留着。
         */
        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let parsed: { path?: unknown; workdir?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }
        if (typeof parsed.path !== "string" || !parsed.path.trim()) {
          return badRequest(res, '缺少文件路径（path）');
        }
        const wanted = localPathTarget(parsed.path.trim());

        let abs = "";
        let uploadsRoot = "";
        if (isAbsolute(wanted)) {
          for (const root of allowedWorkdirs) {
            try {
              const candidate = resolveInWorkdir(root, wanted);
              abs = candidate;
              uploadsRoot = join(resolve(root), UPLOAD_SUBDIR);
              break;
            } catch { /* 不在这个白名单目录里，试下一个 */ }
          }
          if (!abs) {
            return json(res, 403, { error: `路径不在任何白名单工作目录内：${wanted}` });
          }
        } else {
          const root = resolve(
            typeof parsed.workdir === "string" && parsed.workdir.trim() ? parsed.workdir : workdir,
          );
          if (!allowedWorkdirs.has(root)) {
            return json(res, 403, { error: `工作目录不在白名单内：${root}` });
          }
          try {
            abs = resolveInWorkdir(root, wanted);
          } catch (err) {
            return json(res, 403, { error: (err as Error).message });
          }
          uploadsRoot = join(root, UPLOAD_SUBDIR);
        }

        // 第二道闸：落点必须在 uploads/ 子目录之内（含 symlink 真实路径校验，
        // resolveInWorkdir 已做；这里再按前缀复验一次子目录边界）
        const resolvedUploads = resolve(uploadsRoot);
        if (!resolve(abs).startsWith(resolvedUploads + sep)) {
          return json(res, 403, { error: `只允许删除 ${UPLOAD_SUBDIR}/ 子目录内的文件` });
        }
        try {
          const st = await stat(abs);
          if (!st.isFile()) {
            return json(res, 400, { error: "只删文件，不删目录" });
          }
        } catch {
          return notFound(res, `File not found: ${wanted}`);
        }
        try {
          await rm(abs);
        } catch (err) {
          return json(res, 500, { error: `删除失败：${err instanceof Error ? err.message : String(err)}` });
        }
        return json(res, 200, { deleted: true, path: relative(resolvedUploads, abs).split(sep).join("/") });
      }

      case "extendBudget": {
        /**
         * 当场给执行谱系加一段 token/轮次跑道——不改 env、不重启宿主。
         * 委托方痛点：长任务撞 AGENT_TOTAL_TOKEN_BUDGET 后只能「重启或另起」，
         * 已写产物与正史都还在，却被文案逼去改环境变量。
         */
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);
        if (run.archived) {
          return json(res, 409, { error: "归档运行不能追加预算；请新建对话或从归档派生续跑" });
        }
        if (run.status === "running") {
          return json(res, 409, { error: "运行进行中，请等这一轮结束再追加预算" });
        }
        if (!run.checkpoint?.runBudget) {
          return json(res, 409, { error: "这次运行没有可追加的谱系预算（无检查点）" });
        }
        let body = "";
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let parsed: { addTokens?: unknown; addTurns?: unknown } = {};
        if (body.trim()) {
          try {
            parsed = JSON.parse(body);
          } catch {
            return badRequest(res, "Invalid JSON body");
          }
        }
        const defaultAdd = maxTokensBudget ?? 2_000_000;
        const addTokens =
          typeof parsed.addTokens === "number" && Number.isFinite(parsed.addTokens) && parsed.addTokens > 0
            ? Math.floor(parsed.addTokens)
            : defaultAdd;
        const addTurns =
          typeof parsed.addTurns === "number" && Number.isFinite(parsed.addTurns) && parsed.addTurns > 0
            ? Math.floor(parsed.addTurns)
            : undefined;
        // 单次追加上限：宿主默认的 5 倍，防误触一次加到天文数字
        const tokenCap = defaultAdd * 5;
        if (addTokens > tokenCap) {
          return badRequest(res, `单次追加 token 不得超过 ${tokenCap}（宿主默认的 5 倍）`);
        }
        if (addTurns !== undefined && addTurns > 500) {
          return badRequest(res, "单次追加轮次不得超过 500");
        }
        const before = { ...run.checkpoint.runBudget };
        const after = extendSharedRunBudget(before, {
          addTokens,
          ...(addTurns !== undefined ? { addTurns } : {}),
        });
        run.checkpoint = { ...run.checkpoint, runBudget: after };
        if (run.durableState?.budget) {
          run.durableState = {
            ...run.durableState,
            budget: { ...after } as typeof run.durableState.budget,
          };
        }
        // 下一轮装配会读 resumeBudget；没有也写一份，避免仍用旧上限
        run.resumeBudget = { ...after };
        return json(res, 200, {
          runId: run.id,
          before,
          after,
          continuationBlockReason: liveBudgetBlockReasonOf(run),
          canContinue: liveBudgetBlockReasonOf(run) === null && run.status === "done",
        });
      }

      case "followUp": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);

        /**
         * 信息队列（委托方："可以选择插队重新让 agent 重新思考，或者等待队列结束后再发送"）：
         * 运行中**不再 409**——按请求体 mode 二选一：
         *   · "steer"：进 steeringQueue，loop 在下一次模型调用前注入正史（插队重想）；
         *   · "queue"（缺省）：进 messageQueue，本轮结束后由宿主拼成一条自动续跑。
         * 两条都落 message_queued durable 事件——刷新 / 崩溃重放后队列状态不丢。
         * 编排类选项（planMode / multiAgent / mode:"plan"）只能开启新的一轮，
         * 运行中塞不进去，当场 400 说清楚，不静默降级成普通排队。
         */
        if (!run.archived && turnDriverInFlight(run)) {
          let earlyBody: string;
          try {
            earlyBody = await readBody(req, requestBodyMaxBytes);
          } catch (error) {
            return requestBodyFailure(res, error);
          }
          let earlyParsed: { text?: unknown; mode?: unknown; planMode?: unknown; multiAgent?: unknown };
          try {
            earlyParsed = JSON.parse(earlyBody);
          } catch {
            return badRequest(res, "Invalid JSON body");
          }
          if (typeof earlyParsed.text !== "string" || !earlyParsed.text.trim()) {
            return badRequest(res, 'Missing or invalid "text" field');
          }
          const earlyMode = earlyParsed.mode ?? "queue";
          if (earlyMode !== "steer" && earlyMode !== "queue") {
            return badRequest(res, '运行中 mode 只接受 "steer"（插队重想）或 "queue"（排队等待，缺省）；编排模式的追加请等本轮结束');
          }
          const earlyWantsPlan =
            earlyParsed.planMode === true || earlyParsed.multiAgent === true || earlyParsed.mode === "plan";
          // 完成态计划对话勾着计划旋钮不算重开 DAG——按普通排队收，不 409。
          if (earlyWantsPlan && !conversationHasCompletedPlan(run)) {
            return json(res, 409, { error: "运行进行中，编排模式的追加请等本轮结束（或改用排队/插队）" });
          }
          return enqueueRunningMessage(res, run, earlyParsed.text.trim(), earlyMode);
        }

        // 会话中心化（委托方："对话一出错就只能新开，为什么不能一直用"）：
        // 一场对话只会被两件事挡住——**这一轮还在跑**（上方已转为入队），或**执行谱系预算耗尽**
        // （文案说清哪个预算、怎么提）。核查 / 编排 / 执行阶段就失败 / 归档无
        // 检查点，都不再是 409：封的是裁决的适用范围（裁决带 judgedTurn 只对它
        // 核查的那一轮负责），不是对话本身。归档仍受宿主边界约束（包 / 白名单 / 预算）。
        if (run.archived) {
          const blockReason = archivedForkBlockReason(run);
          if (blockReason) return json(res, 409, { error: blockReason });
        } else {
          prepareLineageBudgetForContinuation(run);
        }

        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let parsed: {
          text?: string;
          verify?: unknown;
          autoApprove?: unknown;
          planMode?: unknown;
          multiAgent?: unknown;
          planGate?: unknown;
          mode?: unknown;
          replan?: unknown;
          pack?: unknown;
          autoPack?: unknown;
          workdir?: unknown;
          extraWorkdirs?: unknown;
          effort?: unknown;
          rubric?: unknown;
        };
        try {
          parsed = JSON.parse(body);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }
        if (!parsed.text || typeof parsed.text !== "string" || !parsed.text.trim()) {
          return badRequest(res, 'Missing or invalid "text" field');
        }
        // 逐轮核查开关：缺省沿用这个 run 上一轮的设置；非布尔值当场拒绝，不静默降级（V-24 口径）
        if (parsed.verify !== undefined && typeof parsed.verify !== "boolean") {
          return badRequest(res, '"verify" 必须是布尔值');
        }
        if (parsed.autoApprove !== undefined && typeof parsed.autoApprove !== "boolean") {
          return badRequest(res, '"autoApprove" 必须是布尔值');
        }
        if (parsed.planMode !== undefined && typeof parsed.planMode !== "boolean") {
          return badRequest(res, '"planMode" 必须是布尔值');
        }
        if (parsed.multiAgent !== undefined && typeof parsed.multiAgent !== "boolean") {
          return badRequest(res, '"multiAgent" 必须是布尔值');
        }
        if (parsed.replan !== undefined && typeof parsed.replan !== "boolean") {
          return badRequest(res, '"replan" 必须是布尔值');
        }
        if (parsed.replan === true && !run.planNodes?.length) {
          return badRequest(res, "replan 需要上一份计划的节点状态；本对话还没有可重规划的计划");
        }
        const wantsNewPlan = parsed.multiAgent === true || parsed.planMode === true || parsed.mode === "plan";
        // 完成态 plan 追问续的是对话不是 DAG。权限档「计划」会让界面一直带 planMode，
        // 再开 planner 的 run_end 会拆掉还在跑的执行者 broker。要重开编排请传 replan。
        const turnOrchestrate = wantsNewPlan && !conversationHasCompletedPlan(run);
        const turnPlanGate =
          (parsed.planMode === true || parsed.planGate === true) &&
          (turnOrchestrate || parsed.replan === true);
        if (turnPlanGate && !turnOrchestrate && parsed.replan !== true) {
          return badRequest(res, "planGate 仅在编排（planMode 或 multiAgent）下有意义");
        }
        const turnConcurrency: number | "auto" | undefined = parsed.multiAgent === true
          ? "auto"
          : turnOrchestrate || parsed.replan === true
            ? 1
            : undefined;
        const feedback = parsed.text.trim();
        const turnVerify = typeof parsed.verify === "boolean" ? parsed.verify : run.verify;
        // 勾选是本轮意图，不是父档案遗产。不设的话归档派生会看起来"开着自动放行"却仍逐条问。
        const applyTurnAutoApprove = (target: StoredRun) => {
          if (typeof parsed.autoApprove === "boolean") target.autoApprove = parsed.autoApprove;
        };
        // 状态门在 readBody 之前查过一次——await 期间另一条并发 followUp 可能
        // 已把 run 置回 running。不复查的话同一 AgentLoop 会被两条 continuation
        // 并发驱动（资源门因同 holder 幂等恰好拦不住），先收尾的一段还会把
        // 在用探针提前释放（评审 de6ddef 双镜头各自独立抓出的 real-bug）。
        // 信息队列之后这里也不再 409：与主门同口径按 mode 入队（编排类选项
        // 塞不进在跑的一轮，那条路径在 readBody 前的 400 已经说清了——能走到
        // 这儿的编排请求同样拒绝，不静默降级）。
        if (!run.archived && turnDriverInFlight(run)) {
          if (turnOrchestrate) {
            return json(res, 409, { error: "运行进行中，编排模式的追加请等本轮结束（或改用排队/插队）" });
          }
          const raceMode = parsed.mode === "steer" ? "steer" : "queue";
          return enqueueRunningMessage(res, run, feedback, raceMode);
        }
        let claimedEpoch: number | undefined;
        if (!run.archived) {
          const epoch = tryClaimTurnDriver(run);
          if (epoch == null) {
            if (turnOrchestrate) {
              return json(res, 409, { error: "运行进行中，编排模式的追加请等本轮结束（或改用排队/插队）" });
            }
            const raceMode = parsed.mode === "steer" ? "steer" : "queue";
            return enqueueRunningMessage(res, run, feedback, raceMode);
          }
          claimedEpoch = epoch;
        }
        const releaseClaimedDriver = (): void => {
          if (claimedEpoch !== undefined) releaseTurnDriver(run, claimedEpoch);
        };
        // 续跑也是新的执行 segment：绕过 createRun 路由不等于绕过隔离准入。
        await refreshExecutionHealth(true);
        if (!executionHealthy) {
          releaseClaimedDriver();
          return json(res, 503, {
            error:
              `Required command isolation is unavailable: ${processExecutionStatus.probe.reason ?? "backend probe failed"}`,
            executionIsolation: processExecutionStatus,
          });
        }
        // 追问/归档派生同属新的执行准入：日预算门先于并发门（拒因更具体）
        if (run.dailyBudget !== false) {
          const budgetRefusal = dailyBudgetRefusal();
          if (budgetRefusal) {
            releaseClaimedDriver();
            return rejectAtDailyBudget(res, budgetRefusal);
          }
        }
        const releaseAdmission = acquireRunAdmission();
        if (!releaseAdmission) {
          releaseClaimedDriver();
          return rejectAtCapacity(res);
        }

        if (run.archived) {
          try {
            await hydrateArchive(run);
            const checkpoint = run.checkpoint;
            // 有检查点就必须能读回正史——读不回是档案损坏，不能静默降级成"从头开一轮"
            // 冒充续跑；没检查点则光明正大地开一轮无正史的新对话轮
            const history = checkpoint ? archivedCheckpointHistory(run) : undefined;
            if (checkpoint && !history) {
              return json(res, 409, {
                error: `归档检查点损坏：transcript 中找不到执行者段 ${checkpoint.segmentIndex}`,
              });
            }
            const planSeed = archivedPlanSummary(run);
            const nextTurn = (checkpoint?.conversationTurn ?? run.conversationTurn) + 1;

            const planFacts = run.mode === "plan" ? planResumeFacts(run.durableState?.plan) : undefined;
            const restoreGate = Boolean(
              run.durableState &&
                canRestorePlanGate({
                  phase: run.durableState.phase,
                  plan: run.durableState.plan,
                }),
            );
            const preferSameRun = Boolean(
              run.durableState &&
                canSameRunResume({
                  phase: run.durableState.phase,
                  hasCheckpoint: Boolean(run.checkpoint),
                  verify: run.verify,
                  mode: run.mode === "plan" ? "plan" : "single",
                  budgetExhausted: false,
                  ...(planFacts ? { plan: planFacts } : {}),
                }),
            );
            const dagResume = Boolean(
              preferSameRun &&
                planFacts?.approved &&
                planFacts.hasPassedNode &&
                planFacts.hasRemainingNode &&
                !planFacts.hasFailedNode,
            );

            if (restoreGate) {
              const assembled = await applyFollowUpAssembly(run, parsed, feedback);
              if (!assembled.ok) {
                return badRequest(res, assembled.error);
              }
              const gatePack = run.packName ? getPack(run.packName) : pack;
              const gateResources = gatePack?.resources ?? [];
              if (acquireRunResources(res, run.id, gateResources) === "refused") return;
              if (refuseOrWarnSharedWorkdir(res, run.id, run.workdir ?? workdir, run.id)) {
                hostResources.release(gateResources, run.id);
                return;
              }
              const nodes =
                run.planNodes ??
                (run.durableState?.plan?.nodes
                  ? planNodesFromDurable(run.durableState.plan.nodes)
                  : []);
              if (nodes.length) {
                run.planNodes = nodes;
                run.planHandoffs = run.planHandoffs ?? handoffsFromPlanNodes(nodes);
                run.injectedPlan = planFromNodes(nodes);
              }
              delete run.archived;
              run.status = "running";
              delete run.finishedAt;
              run.verify = turnVerify;
              applyTurnAutoApprove(run);
              run.abort = new AbortController();
              run.mode = "plan";
              run.planGate = true;
              run.pendingApprovals = new Map();
              run.respondedApprovals = new Map();
              run.respondedToolUseIds = new Set();
              delete run.autoAllow;
              if (gateResources.length) run.heldResources = gateResources;
              if (run.archiveDir && historyRoot) {
                run.archiveWriter = new RunHistoryWriter(run.archiveDir, reportHistoryError);
              }
              persistMeta(run);
              if (realHost) {
                operationalLog("info", "run_started", {
                  runId: run.id,
                  mode: "plan",
                  verify: turnVerify,
                  continuation: "restore-gate",
                });
              }
              broadcastLifecycle("run_updated", run);
              void withFallbackAttribution(run, () =>
                startConversationTurn(run, feedback, {
                  verify: turnVerify,
                  orchestrate: true,
                  planGate: true,
                  concurrency: 1,
                }),
              );
              return json(res, 200, {
                runId: run.id,
                conversationTurn: run.conversationTurn,
                continuationMode: "restore-gate",
                sameRunResume: false,
                restorePlanGate: true,
                run: runSummary(run),
              });
            }

            if (preferSameRun && (dagResume || (checkpoint && history))) {
              // Phase 2：同 runId 复活——追加原目录，不派生 child
              const assembled = await applyFollowUpAssembly(run, parsed, feedback);
              if (!assembled.ok) {
                return badRequest(res, assembled.error);
              }
              const resumePack = run.packName ? getPack(run.packName) : pack;
              const resumeResources = resumePack?.resources ?? [];
              if (acquireRunResources(res, run.id, resumeResources) === "refused") return;
              if (refuseOrWarnSharedWorkdir(res, run.id, run.workdir ?? workdir, run.id)) {
                hostResources.release(resumeResources, run.id);
                return;
              }
              delete run.archived;
              run.status = "running";
              delete run.finishedAt;
              run.verify = turnVerify;
              applyTurnAutoApprove(run);
              run.abort = new AbortController();
              if (dagResume) {
                if (run.durableState?.budget) run.resumeBudget = { ...run.durableState.budget };
                run.conversationTurn = (run.conversationTurn ?? 1) + 1;
                run.segmentIndex = run.transcript.length;
              } else if (checkpoint && history) {
                run.history = history;
                run.resumeBudget = resumeBudgetForContinuation(checkpoint);
                run.initialContextInputTokens = checkpoint.contextInputTokens;
                run.conversationTurn = checkpoint.conversationTurn + 1;
                run.segmentIndex = run.transcript.length;
              }
              run.pendingApprovals = new Map();
              run.respondedApprovals = new Map();
              run.respondedToolUseIds = new Set();
              delete run.autoAllow;
              if (resumeResources.length) run.heldResources = resumeResources;
              if (run.archiveDir && historyRoot) {
                run.archiveWriter = new RunHistoryWriter(run.archiveDir, reportHistoryError);
              }
              persistMeta(run);
              if (realHost) {
                operationalLog("info", "run_started", {
                  runId: run.id,
                  mode: dagResume ? "plan" : "single",
                  verify: turnVerify,
                  continuation: "same-run",
                });
              }
              broadcastLifecycle("run_updated", run);
              void withFallbackAttribution(run, () =>
                startSameRunResume(run, feedback, run.archivedApprovalGrantAudit ?? [], {
                  verify: turnVerify,
                  ...(turnOrchestrate && !dagResume
                    ? {
                        orchestrate: true,
                        planGate: turnPlanGate,
                        ...(turnConcurrency !== undefined ? { concurrency: turnConcurrency } : {}),
                      }
                    : {}),
                }),
              );
              return json(res, 200, {
                runId: run.id,
                conversationTurn: run.conversationTurn,
                continuationMode: "same-run",
                sameRunResume: true,
                run: runSummary(run),
              });
            }

            const reopenSame = Boolean(
              run.durableState &&
                run.durableState.phase !== "completed" &&
                canReopenSameRun({
                  phase: run.durableState.phase,
                  hasTask: Boolean(String(run.task ?? "").trim()),
                }),
            );
            if (reopenSame) {
              const assembled = await applyFollowUpAssembly(run, parsed, feedback);
              if (!assembled.ok) {
                return badRequest(res, assembled.error);
              }
              const reopenPack = run.packName ? getPack(run.packName) : pack;
              const reopenResources =
                turnOrchestrate || parsed.replan === true ? [] : (reopenPack?.resources ?? []);
              if (acquireRunResources(res, run.id, reopenResources) === "refused") return;
              if (refuseOrWarnSharedWorkdir(res, run.id, run.workdir ?? workdir, run.id)) {
                hostResources.release(reopenResources, run.id);
                return;
              }
              delete run.archived;
              run.status = "running";
              delete run.finishedAt;
              run.verify = turnVerify;
              applyTurnAutoApprove(run);
              run.abort = new AbortController();
              run.pendingApprovals = new Map();
              run.respondedApprovals = new Map();
              run.respondedToolUseIds = new Set();
              delete run.autoAllow;
              if (reopenResources.length) run.heldResources = reopenResources;
              if (run.archiveDir && historyRoot) {
                run.archiveWriter = new RunHistoryWriter(run.archiveDir, reportHistoryError);
              }
              persistMeta(run);
              if (realHost) {
                operationalLog("info", "run_started", {
                  runId: run.id,
                  mode: run.mode ?? "single",
                  verify: turnVerify,
                  continuation: "reopen",
                });
              }
              broadcastLifecycle("run_updated", run);
              void withFallbackAttribution(run, () =>
                startConversationTurn(run, feedback, {
                  verify: turnVerify,
                  ...(parsed.replan === true ? { replan: true, planGate: turnPlanGate } : {}),
                  ...(turnOrchestrate
                    ? {
                        orchestrate: true,
                        planGate: turnPlanGate,
                        ...(turnConcurrency !== undefined ? { concurrency: turnConcurrency } : {}),
                      }
                    : {}),
                }),
              );
              return json(res, 200, {
                runId: run.id,
                conversationTurn: run.conversationTurn,
                continuationMode: "reopen",
                sameRunResume: false,
                run: runSummary(run),
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
              // 逐轮核查设置随对话走：缺省沿用父档案上一轮的设置
              verify: turnVerify,
              createdAt: Date.now(),
              events: [],
              pendingApprovals: new Map(),
              respondedApprovals: new Map(),
              respondedToolUseIds: new Set(),
              sseClients: new Set(),
              segmentIndex: 0,
              transcript: [],
              conversationTurn: nextTurn,
              toolTally: {},
              abort: new AbortController(),
              ...(history ? { history } : {}),
              ...(run.lastExecutorRoleId ? { lastExecutorRoleId: run.lastExecutorRoleId } : {}),
              ...(run.lastExecutorIdentityKey
                ? { lastExecutorIdentityKey: run.lastExecutorIdentityKey }
                : {}),
              ...(run.lastExecutorModel ? { lastExecutorModel: run.lastExecutorModel } : {}),
              continuedFrom: run.id,
              rootRunId,
              // 有检查点：正史/预算/水位延续；无检查点：无正史新一轮，预算按当前上限从零起算
              ...(checkpoint
                ? {
                    resumeBudget: resumeBudgetForContinuation(checkpoint),
                    initialContextInputTokens: checkpoint.contextInputTokens,
                  }
                : {}),
              // 子 run 是单执行者对话（plan 父档案的计划摘要作种子，不再重跑 DAG）
              ...(planSeed ? { planSummary: planSeed } : {}),
              // 继承任务选择，不继承任何活权限状态；模型/工具由 buildConfig 取当前宿主。
              ...(run.packName ? { packName: run.packName } : {}),
              ...(run.effort ? { effort: run.effort } : {}),
              ...(run.rubric ? { rubric: run.rubric } : {}),
              ...(run.workdir ? { workdir: resolve(run.workdir) } : { workdir }),
              ...(run.extraWorkdirs?.length ? { extraWorkdirs: run.extraWorkdirs } : {}),
              ...(run.askUser ? { askUser: true } : {}),
              ...(parsed.autoApprove === true ? { autoApprove: true } : {}),
              ...(turnOrchestrate ? { mode: "plan" as const } : {}),
              ...(turnConcurrency !== undefined ? { concurrency: turnConcurrency } : {}),
              ...(turnPlanGate ? { planGate: true } : {}),
              // 逐 run 预算随对话走；buildConfig 会按当前窗口重新夹紧（窗口可能在父 run 之后学到）
              ...(run.contextTokenLimit !== undefined ? { contextTokenLimit: run.contextTokenLimit } : {}),
              ...(childResources.length ? { heldResources: childResources } : {}),
            };
            const childAssembled = await applyFollowUpAssembly(child, parsed, feedback);
            if (!childAssembled.ok) {
              hostResources.release(childResources, id);
              return badRequest(res, childAssembled.error);
            }
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
                verify: turnVerify,
                continuation: "fork",
              });
            }
            broadcastLifecycle("run_created", child);
            // 被续那一轮若核查过，裁决摘要随派生一起交给执行者——口径与同进程追加
            // 相同（verdictJudging），只是来源换成父档案 meta 里落盘的 outcome
            const previousVerdict = verdictJudging(run, nextTurn - 1);
            void withFallbackAttribution(child, () =>
              startForkedContinuation(child, feedback, run.archivedApprovalGrantAudit ?? [], {
                verify: turnVerify,
                ...(previousVerdict ? { previousVerdict } : {}),
                ...(turnOrchestrate
                  ? {
                      orchestrate: true,
                      planGate: turnPlanGate,
                      ...(turnConcurrency !== undefined ? { concurrency: turnConcurrency } : {}),
                    }
                  : {}),
              }),
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
        // 同资源的 run 与本次续跑会同时上探针。本轮若开编排，资源改回调度器
        // 按子任务粒度管，这里不整占（与 createRun 同口径）。
        const liveAssembled = await applyFollowUpAssembly(run, parsed, feedback);
        if (!liveAssembled.ok) {
          releaseClaimedDriver();
          releaseAdmission();
          return badRequest(res, liveAssembled.error);
        }
        const resumePack = run.packName ? getPack(run.packName) : pack;
        const resumeResources = (turnOrchestrate || parsed.replan === true) ? [] : (resumePack?.resources ?? []);
        if (acquireRunResources(res, run.id, resumeResources) === "refused") {
          releaseClaimedDriver();
          releaseAdmission();
          return;
        }
        if (refuseOrWarnSharedWorkdir(res, run.id, run.workdir ?? workdir, run.id)) {
          hostResources.release(resumeResources, run.id);
          releaseClaimedDriver();
          releaseAdmission();
          return;
        }
        if (resumeResources.length) run.heldResources = resumeResources;
        applyTurnAutoApprove(run);
        if (realHost) {
          operationalLog("info", "run_started", {
            runId: run.id,
            mode: run.mode ?? "single",
            verify: turnVerify,
            continuation: "same",
          });
        }
        // startConversationTurn 在第一个 await 之前就把轮数加过了，这里不能再 +1
        void withFallbackAttribution(run, () => startConversationTurn(run, feedback, {
          verify: turnVerify,
          ...(claimedEpoch !== undefined ? { driverEpoch: claimedEpoch } : {}),
          ...(parsed.replan === true ? { replan: true, planGate: turnPlanGate } : {}),
          ...(turnOrchestrate
            ? {
                orchestrate: true,
                planGate: turnPlanGate,
                ...(turnConcurrency !== undefined ? { concurrency: turnConcurrency } : {}),
              }
            : {}),
        }));
        releaseAdmission();
        return json(res, 200, {
          runId: run.id,
          conversationTurn: run.conversationTurn,
          verify: turnVerify,
          continuationMode: "same",
          run: runSummary(run),
        });
      }

      case "forkConversation": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);
        let rawBody = "";
        try {
          rawBody = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        if (rawBody.trim()) {
          try {
            JSON.parse(rawBody);
          } catch {
            return badRequest(res, "Invalid JSON body");
          }
        }
        const child = await snapshotConversationFork(run);
        return json(res, 200, {
          runId: child.id,
          continuedFrom: run.id,
          rootRunId: child.rootRunId ?? run.id,
          continuationMode: "snapshot",
          started: false,
          conversationTurn: child.conversationTurn,
          run: runSummary(child),
        });
      }

      case "rewindConversation": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);
        if (run.status === "running") {
          return json(res, 409, { error: "对话还在跑，先停止再回退" });
        }
        let rawBody = "";
        try {
          rawBody = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let parsedBody: unknown = {};
        if (rawBody.trim()) {
          try {
            parsedBody = JSON.parse(rawBody);
          } catch {
            return badRequest(res, "Invalid JSON body");
          }
        }
        const parsed = parseRewindRequest(parsedBody);
        if (!parsed.ok) return badRequest(res, parsed.error);
        await hydrateArchive(run);
        if (parsed.seq !== -1 && !run.events.some((e) => e.seq === parsed.seq)) {
          return badRequest(res, `没有序号为 ${parsed.seq} 的消息`);
        }
        const { child, files } = await snapshotConversationRewind(run, parsed.seq, parsed.revertFiles);
        return json(res, 200, {
          runId: child.id,
          continuedFrom: run.id,
          rootRunId: child.rootRunId ?? run.id,
          continuationMode: "rewind",
          started: false,
          conversationTurn: child.conversationTurn,
          rewindFrom: child.rewindFrom,
          ...(files ? { files } : {}),
          run: runSummary(child),
        });
      }

      /**
       * 信息队列：取消排队中的消息。body 带 { index } 取消单条，空 body = 清空整队。
       * 只管 messageQueue——steer 已注入的不可撤（它可能已进正史并发射了 steering
       * 事件，假装能撤就是界面说谎）。变更落 message_queue_updated durable 事件，
       * 刷新 / 重放后排队的终态由最后一条整表替换决定。
       */
      case "messageQueue": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);
        let rawBody = "";
        try {
          rawBody = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let index: number | undefined;
        if (rawBody.trim()) {
          let parsedQueue: { index?: unknown };
          try {
            parsedQueue = JSON.parse(rawBody);
          } catch {
            return badRequest(res, "Invalid JSON body");
          }
          if (parsedQueue.index !== undefined) {
            if (!Number.isInteger(parsedQueue.index)) {
              return badRequest(res, '"index" 必须是整数');
            }
            index = parsedQueue.index as number;
          }
        }
        const queue = (run.messageQueue ??= []);
        if (index !== undefined) {
          if (index < 0 || index >= queue.length) {
            return badRequest(res, `index ${index} 超出排队范围（当前 ${queue.length} 条）`);
          }
          queue.splice(index, 1);
        } else {
          queue.length = 0;
        }
        pushSyntheticEvent(run, "host", {
          type: "message_queue_updated",
          pending: [...queue],
          at: Date.now(),
        });
        return json(res, 200, { runId: run.id, pending: [...queue] });
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
              const target = localPathTarget(input);
              if (!/[\\/]/.test(target)) {
                const found = await findUniqueWorkdirFile(root, target);
                if (found) return { input, exists: true as const, path: found, kind: "file" as const };
              }
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
       * 整站预览取件：相对路径按 run workdir 圈禁；目录则回 index.html。
       * MIME 用 siteContentTypeOf（.js 可执行）；CSP 允许同源脚本/样式。
       * `?inspect=1` 仅对 HTML 注入点选钩子（保留页面脚本），相对资源仍同源可取。
       */
      case "site": {
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
          let st = await stat(abs);
          if (st.isDirectory()) {
            abs = resolveInWorkdir(root, route.path.replace(/\/?$/, "/") + "index.html");
            st = await stat(abs);
          }
          if (!st.isFile()) return notFound(res, "Not a file");
          if (st.size > FILE_PREVIEW_MAX_BYTES) {
            return json(res, 413, {
              error: `文件过大：${(st.size / 1_000_000).toFixed(1)}MB 超过 ${(FILE_PREVIEW_MAX_BYTES / 1_000_000).toFixed(0)}MB 预览上限`,
            });
          }
          let body = await readFile(abs);
          const name = basename(abs);
          const type = siteContentTypeOf(name);
          if (type.startsWith("text/html")) {
            const text = body.toString("utf8");
            const looksLikeDeck = /\bslide\b[\s\S]{0,120}data-slide|data-slide[\s\S]{0,80}\bslide\b/i.test(text);
            body = Buffer.from(
              appendSiteHooks(text, {
                deck: route.deck || looksLikeDeck,
                inspect: route.inspect,
                print: route.print,
              }),
              "utf8",
            );
          }
          res.writeHead(200, {
            "Content-Type": type,
            "Content-Length": String(body.length),
            "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
            "Cache-Control": "no-store",
            "Content-Security-Policy": SITE_PREVIEW_CSP,
            "X-Content-Type-Options": "nosniff",
          });
          res.end(body);
          return;
        } catch {
          return notFound(res, `Site asset not found: ${route.path}`);
        }
      }

      /**
       * 整站 ZIP：以入口 HTML 所在目录为根打包（圈禁 run workdir）。
       */
      case "siteZip": {
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
          let st = await stat(abs);
          if (st.isDirectory()) {
            abs = resolveInWorkdir(root, route.path.replace(/\/?$/, "/") + "index.html");
            st = await stat(abs);
          }
          if (!st.isFile()) return notFound(res, "Not a file");
          const dir = dirname(abs);
          const entries: { name: string; data: Buffer }[] = [];
          let total = 0;
          const maxFiles = 200;
          const maxBytes = 20_000_000;

          async function walk(current: string, prefix: string): Promise<void> {
            const kids = await readdir(current, { withFileTypes: true });
            for (const kid of kids) {
              if (entries.length >= maxFiles) throw new Error("too many files");
              const childAbs = join(current, kid.name);
              const childName = prefix ? `${prefix}/${kid.name}` : kid.name;
              if (kid.isDirectory()) {
                if (kid.name === "node_modules" || kid.name === ".git") continue;
                await walk(childAbs, childName);
                continue;
              }
              if (!kid.isFile()) continue;
              const data = await readFile(childAbs);
              total += data.length;
              if (total > maxBytes) throw new Error("archive too large");
              entries.push({ name: zipEntryName(childName), data });
            }
          }

          await walk(dir, "");
          if (entries.length === 0) return notFound(res, "Empty site directory");
          const zip = buildStoreZip(entries);
          const zipName = `${basename(dir) || "site"}.zip`;
          res.writeHead(200, {
            "Content-Type": "application/zip",
            "Content-Length": String(zip.length),
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(zip);
          return;
        } catch (err) {
          const msg = (err as Error).message ?? "";
          if (msg === "too many files" || msg === "archive too large") {
            return json(res, 413, { error: msg });
          }
          return notFound(res, `Site zip failed: ${route.path}`);
        }
      }

      case "designTemplates": {
        if (!designTemplatesDir) {
          return json(res, 200, { templates: [], disabled: true });
        }
        const templates = await listDesignTemplates(designTemplatesDir);
        return json(res, 200, { templates });
      }

      case "designMd": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);
        const root = run.workdir ?? workdir;
        try {
          const doc = await readDesignMd(root);
          if (!doc) return json(res, 200, { found: false });
          const palette = parseDesignPalette(doc.text);
          return json(res, 200, {
            found: true,
            path: doc.path,
            text: doc.text,
            palette,
          });
        } catch (err) {
          return json(res, 413, { error: (err as Error).message });
        }
      }

      case "seedTemplate": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);
        if (!designTemplatesDir) {
          return json(res, 503, { error: "design templates unavailable" });
        }
        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (err) {
          return json(res, 413, { error: (err as Error).message });
        }
        let parsed: { template?: unknown; dest?: unknown; force?: unknown };
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          return badRequest(res, "Invalid JSON");
        }
        const templateId = typeof parsed.template === "string" ? parsed.template : "";
        const destName = typeof parsed.dest === "string" ? parsed.dest : undefined;
        const force = parsed.force === true;
        try {
          const result = await copyDesignTemplate({
            templatesRoot: designTemplatesDir,
            templateId,
            destRoot: run.workdir ?? workdir,
            destName,
            force,
          });
          return json(res, 200, result);
        } catch (err) {
          const msg = (err as Error).message ?? String(err);
          if (msg.startsWith("目标已存在")) return json(res, 409, { error: msg });
          if (msg.startsWith("非法模板") || msg.startsWith("模板不存在") || msg.startsWith("模板缺少")) {
            return badRequest(res, msg);
          }
          return badRequest(res, msg);
        }
      }

      /**
       * 从幻灯 HTML 派生 PPTX。圈在 run workdir；零 .slide 拒绝写盘。
       * 有损版式写进 lossy，不假装像素还原。
       */
      case "exportPptx": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);
        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (err) {
          return json(res, 413, { error: (err as Error).message });
        }
        let parsed: { htmlPath?: unknown };
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          return badRequest(res, "Invalid JSON");
        }
        const root = run.workdir ?? workdir;
        let htmlRel = typeof parsed.htmlPath === "string" ? parsed.htmlPath.trim() : "";
        if (!htmlRel) {
          try {
            const absIndex = resolveInWorkdir(root, "index.html");
            if (existsSync(absIndex)) htmlRel = "index.html";
          } catch { /* 下面再找唯一入口 */ }
          if (!htmlRel) {
            const found = await findUniqueWorkdirFile(root, "index.html");
            if (!found) {
              return badRequest(res, "未指定 htmlPath，且工作目录没有唯一的 index.html");
            }
            htmlRel = found;
          }
        }
        htmlRel = htmlRel.replace(/\\/g, "/");
        if (!/\.html?$/i.test(htmlRel.split("/").pop() ?? "")) {
          return badRequest(res, "htmlPath 必须是 .html 幻灯入口");
        }
        let htmlAbs: string;
        try {
          htmlAbs = resolveInWorkdir(root, htmlRel);
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
        let html: string;
        try {
          const st = await stat(htmlAbs);
          if (!st.isFile()) return badRequest(res, "htmlPath 不是文件");
          html = await readFile(htmlAbs, "utf8");
        } catch {
          return notFound(res, `HTML not found: ${htmlRel}`);
        }
        const cssParts: string[] = [];
        for (const href of relativeStylesheetHrefs(html)) {
          try {
            const cssAbs = resolveInWorkdir(root, joinHtmlRelative(htmlRel, href));
            cssParts.push(await readFile(cssAbs, "utf8"));
          } catch { /* 缺样式仍转，色板走默认 */ }
        }
        let designMd: string | undefined;
        for (const cand of [...new Set([joinHtmlRelative(htmlRel, "DESIGN.md"), "DESIGN.md"])]) {
          try {
            const mdAbs = resolveInWorkdir(root, cand);
            designMd = await readFile(mdAbs, "utf8");
            break;
          } catch { /* 下一候选 */ }
        }
        try {
          const { ir, bytes } = await convertDeckHtmlToPptx({
            html,
            css: cssParts.join("\n"),
            designMd,
          });
          const pptxRel = pptxRelPathForHtml(htmlRel).replace(/\\/g, "/");
          const pptxAbs = resolveInWorkdir(root, pptxRel);
          await writeFile(pptxAbs, bytes);
          return json(res, 200, {
            path: pptxRel,
            slides: ir.slides.length,
            titles: ir.slides.map(deckSlideTitle),
            lossy: ir.lossy,
          });
        } catch (err) {
          if (isDeckPptxError(err) && err.code === DECK_PPTX_NO_SLIDES) {
            return json(res, 422, { error: err.message, code: err.code });
          }
          return json(res, 400, { error: (err as Error).message ?? String(err) });
        }
      }

      /**
       * 从方图 HTML 派生 PNG。只截 [data-card]，零契约拒绝写盘。
       */
      case "exportPng": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);
        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (err) {
          return json(res, 413, { error: (err as Error).message });
        }
        let parsed: { htmlPath?: unknown };
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          return badRequest(res, "Invalid JSON");
        }
        const root = run.workdir ?? workdir;
        let htmlRel = typeof parsed.htmlPath === "string" ? parsed.htmlPath.trim() : "";
        if (!htmlRel) {
          try {
            const absIndex = resolveInWorkdir(root, "index.html");
            if (existsSync(absIndex)) htmlRel = "index.html";
          } catch { /* 下面再找唯一入口 */ }
          if (!htmlRel) {
            const found = await findUniqueWorkdirFile(root, "index.html");
            if (!found) {
              return badRequest(res, "未指定 htmlPath，且工作目录没有唯一的 index.html");
            }
            htmlRel = found;
          }
        }
        htmlRel = htmlRel.replace(/\\/g, "/");
        if (!/\.html?$/i.test(htmlRel.split("/").pop() ?? "")) {
          return badRequest(res, "htmlPath 必须是 .html 入口");
        }
        let htmlAbs: string;
        try {
          htmlAbs = resolveInWorkdir(root, htmlRel);
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
        let html: string;
        try {
          const st = await stat(htmlAbs);
          if (!st.isFile()) return badRequest(res, "htmlPath 不是文件");
          html = await readFile(htmlAbs, "utf8");
        } catch {
          return notFound(res, `HTML not found: ${htmlRel}`);
        }
        let frames;
        try {
          frames = requirePngFrames(html);
        } catch (err) {
          if (isCardPngError(err) && err.code === CARD_PNG_NO_FRAMES) {
            return json(res, 422, { error: err.message, code: err.code });
          }
          return json(res, 400, { error: (err as Error).message ?? String(err) });
        }
        try {
          const shots = await capturePngFrames({ htmlAbs, frames });
          const rels = pngRelPathsForHtml(htmlRel, shots.length);
          const paths: string[] = [];
          for (let i = 0; i < shots.length; i++) {
            const rel = (rels[i] ?? `${htmlRel}-${i + 1}.png`).replace(/\\/g, "/");
            const abs = resolveInWorkdir(root, rel);
            await writeFile(abs, shots[i]!.bytes);
            paths.push(rel);
          }
          return json(res, 200, {
            paths,
            count: paths.length,
            lossy: ["截的是契约卡渲染，不是通用整页长图"],
          });
        } catch (err) {
          if (isCardPngError(err) && err.code === CARD_PNG_NO_FRAMES) {
            return json(res, 422, { error: err.message, code: err.code });
          }
          if (isCardPngError(err) && err.code === CARD_PNG_CAPTURE_UNAVAILABLE) {
            return json(res, 503, { error: err.message, code: err.code });
          }
          return json(res, 400, { error: (err as Error).message ?? String(err) });
        }
      }

      /**
       * V-35 文件预览取件：不绑定 run 的只读预览/下载。
       *
       * 圈禁口径与上传同一条线（白名单工作目录），判据与 artifact 同一把尺：
       *   ① 相对路径按 `workdir` 参数（缺省 = 宿主默认工作目录）解析，
       *      该目录必须在白名单内，否则 403；
       *   ② 绝对路径必须落在**某个**白名单工作目录之内——逐一试
       *      `resolveInWorkdir`（与写类工具共用圈禁函数，含 symlink/junction
       *      真实路径校验），全部拒绝即 403；
       *   ③ 只回文件，目录一律 404——否则等于开了目录浏览；
       *   ④ 超过 FILE_PREVIEW_MAX_BYTES 一律 413——预览不是下载通道。
       * 响应头纪律照搬 artifact：CSP 禁脚本与外链 + nosniff + no-store。
       */
      case "filePreview": {
        const wanted = localPathTarget(route.path);
        let abs = "";
        if (isAbsolute(wanted)) {
          for (const root of allowedWorkdirs) {
            try {
              abs = resolveInWorkdir(root, wanted);
              break;
            } catch { /* 不在这个白名单目录里，试下一个 */ }
          }
          if (!abs) {
            return json(res, 403, { error: `路径不在任何白名单工作目录内：${wanted}` });
          }
        } else {
          // 与上传同一教训（v2-33）：白名单存的是 resolve() 后的规范化路径，
          // 比较前必须归一，否则默认路径会过不了自己的白名单
          const root = resolve(route.workdir || workdir);
          if (!allowedWorkdirs.has(root)) {
            return json(res, 403, { error: `工作目录不在白名单内：${root}` });
          }
          try {
            abs = resolveInWorkdir(root, wanted);
          } catch (err) {
            return json(res, 403, { error: (err as Error).message });
          }
        }
        try {
          const st = await stat(abs);
          if (!st.isFile()) return notFound(res, "Not a file");
          if (st.size > FILE_PREVIEW_MAX_BYTES) {
            return json(res, 413, {
              error: `文件过大：${(st.size / 1_000_000).toFixed(1)}MB 超过 ${(FILE_PREVIEW_MAX_BYTES / 1_000_000).toFixed(0)}MB 预览上限`,
            });
          }
          const body = await readFile(abs);
          const name = basename(abs);
          res.writeHead(200, {
            "Content-Type": contentTypeOf(name),
            "Content-Length": String(body.length),
            "Content-Disposition": `${route.download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
            "Cache-Control": "no-store",
            // 预览的可能是模型生成的 HTML——**不可信内容**。禁掉脚本与外链，
            // 否则等于让它在宿主同源下执行任意 JS（能读同源的 /api/*）
            "Content-Security-Policy":
              "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src data:",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(body);
          return;
        } catch {
          return notFound(res, `File not found: ${route.path}`);
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
        // 兼容端点 / 无视 signal 的工具：abort 后仍可能卡在 await。
        // 点了停止超过 1.5s 还 running，就强制收尾——按钮不能停比没有更糟。
        const stoppingId = run.id;
        setTimeout(() => {
          const still = runs.get(stoppingId);
          if (!still || still.status !== "running" || !still.abort?.signal.aborted) return;
          finalizeRun(still, { outcome: "closed", mainStopReason: "aborted" });
        }, 1500);
        broadcastLifecycle("run_updated", run);
        return json(res, 200, { stopping: true });
      }

      case "deleteRun": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);
        if (run.status === "running") {
          return json(res, 409, { error: "运行进行中，请先停止再删除" });
        }
        if (run.archiveWriter) {
          const flush = run.archiveWriter.flush();
          detachedArchiveFlushes.add(flush);
          void flush.finally(() => detachedArchiveFlushes.delete(flush));
        }
        detachAndDisposeExecutionBroker(run);
        runs.delete(run.id);
        const dirRoot = historyRoot ?? (run.archiveDir ? dirname(run.archiveDir) : null);
        if (dirRoot) {
          void removeHistoryDir(dirRoot, run.id);
        }
        broadcastLifecycleRemoval(run.id);
        return json(res, 200, { deleted: true, runId: run.id });
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
        /**
         * 语义全在 createRunFromBody（T9 起与调度器共用同一内部入口）；
         * 这里只剩 HTTP 外壳。顺序纪律：隔离健康重探必须在 readBody **之前**——
         * SAFE-05 的慢 body 测试只发请求头不发体，靠的就是先过 admission 再
         * 确定性停在 readBody；调换顺序会让该探测永远等不到。
         */
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
        let parsed: RunCreateBody;
        try {
          parsed = JSON.parse(body);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }
        const outcome = await createRunFromBody(parsed);
        if (outcome.headers) {
          for (const [name, value] of Object.entries(outcome.headers)) {
            res.setHeader(name, value);
          }
        }
        return json(res, outcome.status, outcome.payload);
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
        if (parsed.decision === "approve" && run.dailyBudget !== false) {
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
        // OBS-02：计划确认门把整场 run 挂在这儿等一个人（同 approval 的口径）
        observeWaitSeconds("plan_gate", Date.now() - pendingPlan.at);
        pendingPlan.settle(parsed.decision);
        broadcastLifecycle("run_updated", run);
        return json(res, 200, { acknowledged: true });
      }

      case "handoff": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);

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
        if (parsed.decision !== "accept" && parsed.decision !== "decline") {
          return badRequest(res, 'decision must be "accept" or "decline"');
        }

        const proposal = effectiveHandoff(run);
        if (!proposal || proposal.status !== "pending") {
          return json(res, 409, { error: "当前没有待确认的下一步" });
        }
        if (parsed.decision === "accept" && run.status === "running") {
          return json(res, 409, { error: "等这次调试结束再换段" });
        }

        if (parsed.decision === "decline") {
          const at = Date.now();
          run.handoffProposal = { ...proposal, status: "declined" };
          pushSyntheticEvent(run, "host", {
            type: "handoff_resolved",
            id: proposal.id,
            decision: "decline",
            at,
          });
          broadcastLifecycle("run_updated", run);
          return json(res, 200, { acknowledged: true });
        }

        if (run.dailyBudget !== false) {
          const budgetRefusal = dailyBudgetRefusal();
          if (budgetRefusal) return rejectAtDailyBudget(res, budgetRefusal);
        }

        const spec = findHandoffAmong(allPacks(), proposal.handoffId);
        if (!spec) {
          return json(res, 409, { error: "这份提议已经失效（领域包不再提供该下一步）" });
        }
        const sketch = buildThreadSketch(
          run.events.map((item) => ({ source: item.source, event: item.event as ThreadEventLike["event"] })),
        );
        const ctx = {
          summary: proposal.summary,
          parentTask: run.task,
          ...(sketch ? { sketch } : {}),
        };
        const injectedPlan = buildHandoffPlan(spec, ctx);
        const child = await createRunFromBody(
          {
            task: buildHandoffTask(ctx),
            mode: "plan",
            planGate: false,
            concurrency: 1,
            verify: true,
            ...(run.workdir ? { workdir: run.workdir } : {}),
            ...(run.extraWorkdirs ? { extraWorkdirs: run.extraWorkdirs } : {}),
            ...(run.effort ? { effort: run.effort } : {}),
            ...(run.contextTokenLimit !== undefined ? { contextTokenLimit: run.contextTokenLimit } : {}),
            ...(run.autoApprove ? { autoApprove: true } : {}),
          },
          { injectedPlan, parentRunId: run.id },
        );
        if (child.status !== 200) {
          if (child.headers) {
            for (const [name, value] of Object.entries(child.headers)) {
              res.setHeader(name, value);
            }
          }
          return json(res, child.status, child.payload);
        }
        const childRunId = (child.payload as { runId?: string }).runId;
        const at = Date.now();
        run.handoffProposal = {
          ...proposal,
          status: "accepted",
          ...(childRunId ? { childRunId } : {}),
        };
        pushSyntheticEvent(run, "host", {
          type: "handoff_resolved",
          id: proposal.id,
          decision: "accept",
          ...(childRunId ? { childRunId } : {}),
          at,
        });
        broadcastLifecycle("run_updated", run);
        return json(res, 200, { acknowledged: true, runId: childRunId });
      }

      /**
       * §5.2 澄清答复。状态门口径同计划门（R-01）：没有挂起的问题就 409，
       * 不是静默成功——"我到底答没答"必须有确定答案。
       */
      case "autoApprove": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);
        if (run.archived) return json(res, 409, { error: "归档运行不能改自动放行" });
        if (run.status !== "running") return json(res, 409, { error: "只有运行中的对话能改自动放行" });
        let body: string;
        try {
          body = await readBody(req, requestBodyMaxBytes);
        } catch (error) {
          return requestBodyFailure(res, error);
        }
        let parsed: { enabled?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }
        if (typeof parsed.enabled !== "boolean") {
          return badRequest(res, 'enabled must be a boolean');
        }
        run.autoApprove = parsed.enabled;
        if (parsed.enabled) {
          const at = Date.now();
          for (const [key, pending] of [...run.pendingApprovals]) {
            observeWaitSeconds("approval", at - pending.at);
            pending.respond("allow");
            run.respondedApprovals.set(key, { decision: "allow", at });
            run.respondedToolUseIds.add(pending.toolUseId);
            run.pendingApprovals.delete(key);
            pushSyntheticEvent(run, "host", {
              type: "approval_resolved",
              requestSeq: pending.requestSeq,
              toolUseId: pending.toolUseId,
              name: pending.name,
              decision: "allow",
              actor: "auto-run",
              at,
            });
            applyDurableTransition(run, { type: "approval_resolved", approvalId: key }, at);
          }
        }
        broadcastLifecycle("run_updated", run);
        persistMeta(run);
        return json(res, 200, { acknowledged: true, autoApprove: run.autoApprove });
      }

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
        observeWaitSeconds("question", Date.now() - pendingQuestion.at);
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
        // OBS-02：人做决定花了多久。只量真的做了决定的那些——run 结束时被判
        // expired 的挂起项没有终点，补一个"到关机为止"就是把宿主的作息编进曲线
        observeWaitSeconds("approval", Date.now() - pending.at);
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
        // T9：先停调度器 tick 并等已排队的落盘走完，再进入 run 收尾——
        // 关停中途又触发一个新 run 是自相矛盾的
        clearInterval(scheduleTimer);
        await schedulePersistChain.catch(() => {});
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

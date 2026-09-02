/**
 * 核心类型定义 — 与 docs/03-interfaces.md 一一对应。
 * 约定：wire 格式一律复用 SDK 导出类型，这里只定义 harness 自身的概念。
 */
import type Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------- L2: 工具契约

/** JSON Schema 对象（工具输入约束），直接使用 SDK 的 InputSchema 形状 */
export type JSONSchema = Anthropic.Tool.InputSchema;

/** SAFE-05：执行策略与具体隔离后端正交，避免 `auto` 被误解成宿主降级。 */
export type ExecutionIsolationMode = "off" | "report" | "required";
export type ExecutionBackendPreference = "auto" | "oci" | "bwrap";
export type ExecutionEffectiveState = "direct" | "report-only" | "partial" | "failed";

/**
 * 一份可以直接进入 API/事件/审计记录的执行边界证明。
 *
 * 刻意没有 `sandboxed: boolean`：候选 runtime 可用、bash 已进容器、整个 run
 * 全面隔离是三个不同事实，压成一个布尔值一定会产生虚假安全声明。
 */
export interface ExecutionBoundaryStatus {
  schemaVersion: 1;
  boundaryId: string;
  requestedMode: ExecutionIsolationMode;
  requestedBackend: ExecutionBackendPreference;
  effectiveState: ExecutionEffectiveState;
  resolvedBackend: "host" | "oci" | null;
  policyDigest: string;
  probe: {
    state: "not-run" | "ready" | "unavailable" | "not-required";
    candidate: "oci" | "bwrap" | null;
    reason?: string;
    runtimeVersion?: string;
  };
  /** 当前真正由这条边界覆盖的能力；首个纵切只有 bash。 */
  coverage: string[];
  filesystem: string;
  network: string;
  identity: string;
  resources: string;
}

export interface ShellExecutionRequest {
  command: string;
  shell?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBufferBytes: number;
  signal: AbortSignal;
  windowsHide: boolean;
  toolUseId: string;
}

export interface ShellExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  outputLimitExceeded: boolean;
  cleanup: "not-needed" | "best-effort" | "runtime-rm" | "confirmed" | "failed";
  status: ExecutionBoundaryStatus;
  error?: string;
}

/** 逐 run 固定的命令执行边界；实现不得在 required 下回退到宿主。 */
export interface ExecutionBroker {
  readonly boundaryId: string;
  status(): ExecutionBoundaryStatus;
  /** force=true 用于 readiness/admission，绕过短 TTL 重新取得运行时回执。 */
  probe(force?: boolean): Promise<ExecutionBoundaryStatus>;
  executeShell(request: ShellExecutionRequest): Promise<ShellExecutionResult>;
  dispose?(): Promise<void>;
}

export interface ToolContext {
  /** 工作目录（路径校验的根，所有文件类工具不得逃逸） */
  workdir: string;
  /**
   * 额外只读根（可选）：read_file 可读取这些目录下的绝对路径（写类工具不受益）。
   * 用于领域素材库（如 KiCad 官方符号/封装库）在工作区之外的场景。
   */
  readRoots?: string[];
  /** 本次调用的 tool_use_id，用于日志关联 */
  toolUseId: string;
  /** 取消信号：护栏触发或用户中断时，长时间运行的工具应尽快退出 */
  signal: AbortSignal;
  /** SAFE-05：本 run 的命令执行边界；未注入时仅允许显式的 legacy local broker。 */
  executionBroker?: ExecutionBroker;
}

export interface ToolResult {
  /** 回填给模型的内容。错误信息要写给模型看（可操作、指明修正方向） */
  content: string;
  /** true = 以 is_error: true 回传，模型据此调整策略；不会中断循环 */
  isError?: boolean;
}

/**
 * 宿主对“相同参数再次执行”授权的最高边界。
 *
 * 客户端只能在这条策略以内选择，不能通过 approval body 把单次审批扩大成
 * conversation grant。未声明策略的 ask 工具按最严格的 `once` 处理。
 */
export interface ToolApprovalPolicy {
  /** once = 只允许当前调用；exact-input = 可在 TTL/次数内复用完全相同的输入 */
  maxScope: "once" | "exact-input";
  /** 工具级 TTL 上限；宿主还会再与全局上限取更严格值 */
  maxTtlMs?: number;
  /** 自动复用次数上限；不含最初由人批准的那一次 */
  maxUses?: number;
}

export interface Tool {
  name: string;
  /** 必须写清"何时调用"（触发条件），不只是"做什么" */
  description: string;
  inputSchema: JSONSchema;
  /** auto = 直接执行；ask = 发 approval_request 事件，等宿主应答后执行 */
  permission: "auto" | "ask";
  /** true = 可与其他 parallelSafe 工具并发执行（典型：只读工具） */
  parallelSafe: boolean;
  /** 缺省为 once；高副作用工具不应开放 exact-input 复用 */
  approvalPolicy?: ToolApprovalPolicy;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

// ---------------------------------------------------------------- L0: 模型客户端

/**
 * 思考预算档位，对应 Anthropic `output_config.effort`。
 * "max" 自 SDK 0.115 起可用（升级窗口 7c8ae75 附带发现）。
 * 仅在非 compat（原生 Claude 端点）下实际发送——第三方兼容端点不认识该字段。
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** 运行时校验用（CLI 解析 AGENT_EFFORT 等外部输入时使用） */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * 工具选择约束。两种取值解决的是**相反**的两件事：
 *
 * - `"none"`（B0b）：结构化禁工具，收口段只许写结论。
 * - `{type:"tool",name}`（§2.1）：**强制**调用指定工具——把"交付裁决/计划"
 *   从一段自由文本变成一次 schema 受检的工具调用。
 *
 * 为什么是强制工具而不是 `response_format: json_schema`（backlog §2.1 原案）：
 * 台账 52 次裁决的分布是 **wrapup 69.2% / reformat 1.9%**——主要失效形态不是
 * "写了散文不是 JSON"（那才是 response_format 治的病，只占 1.9%），而是
 * **跑满预算从没写出任何结论**。后者的根因是"停止取证、开始下结论"这个转换
 * 在自由文本契约下没有任何着力点；给它一个显式的工具，模型才有"我完成了"
 * 这个动作可做，harness 也才有地方强制它做（P6）。
 *
 * 两个 wire 都原生支持：Anthropic `{type:"tool",name}`、
 * OpenAI `{type:"function",function:{name}}`。
 */
export type ToolChoice = "none" | { type: "tool"; name: string };

export interface ModelRequest {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  maxTokens: number;
  effort: Effort;
  /**
   * 见 ToolChoice。工具面**始终保留在请求里**——历史含 tool_use 块时不能撤
   * tools 声明，且强制调用的那个工具本来就得在面上才能被点名。
   */
  toolChoice?: ToolChoice;
}

/** 归一化后的一次模型往返 */
export interface ModelTurn {
  message: Anthropic.Message;
  stopReason: Anthropic.Message["stop_reason"];
  usage: Anthropic.Usage;
}

/**
 * 流式增量。**带 kind 而不是两个回调**：调用方十有八九要把它们送进同一条通道
 * （事件流 / 直播条），分成两个回调只会让每个宿主各写一遍分发。
 *
 * `thinking` 需要 SDK 的 `stream.on("thinking")`——compat 端点未必吐它，
 * 吐不出来就只是没有思考增量，不影响文本增量与控制流。
 */
export interface StreamDelta {
  kind: "text" | "thinking";
  text: string;
}

export interface ModelClient {
  /**
   * 一律流式发送；增量通过 onDelta 旁路（仅供渲染），控制流只依赖最终 ModelTurn。
   *
   * `signal` 透传给底层 SDK 的请求选项。**没有它，"停止"就只是句空话**：
   * 循环只在每轮模型调用之前查中止位，而一次长生成就是一次调用——
   * 人按下停止之后仍要等这一整轮吐完（实测按下 8 秒后 run 仍在 running）。
   * 传下去才能真的把在飞的那个 HTTP 请求掐掉。
   */
  send(
    req: ModelRequest,
    onDelta?: (delta: StreamDelta) => void,
    signal?: AbortSignal,
  ): Promise<ModelTurn>;
}

// ---------------------------------------------------------------- L1: 循环与事件

/**
 * 跨 segment / continuation 共享的硬预算。
 *
 * `AgentRunResult.usage` 仍然描述【这一段】（否则 orchestrate 现有的 sumUsage 会
 * 重复计数）；这个对象描述【同一执行谱系】已经花掉的总量。它是有意可变的：
 * 多个 AgentLoop 实例拿到同一个引用，才能让返工、瞬时续跑与收口段共同扣账。
 */
export interface SharedRunBudget {
  maxTurns?: number;
  maxTokens?: number;
  usedTurns: number;
  usedTokens: number;
}

/** 主执行者的结构化交付。三态不能压成 completed：那会让界面再次说谎。 */
export interface TaskCompletion {
  status: "completed" | "partial" | "blocked";
  summary: string;
  artifacts: string[];
  verification: string[];
  assumptions: string[];
  blockers: string[];
}

/** 终结工具入参经角色自己的语义校验后，告诉 loop 应如何收尾。 */
export interface TerminalResolution {
  stopReason: "completed" | "partial" | "blocked";
  completion?: TaskCompletion;
}

export interface RecoveryPolicy {
  /** 正在产生新证据但撞执行轮次时，允许同上下文追加的短段。0 = 关闭 */
  progressExtensionTurns?: number;
  /** 同工具+同入参+同结果连续多少轮算停滞。0 = 关闭 */
  stagnationWindow?: number;
  /** 停滞后允许“换策略”几次，再出现就强制结构化收口 */
  maxStagnationRecoveries?: number;
}

export interface AgentConfig {
  /** 默认 "claude-opus-4-8" */
  model?: string;
  /** 冻结；禁止含时间戳等易变内容 */
  systemPrompt: string;
  tools: Tool[];
  /** 默认 "high" */
  effort?: Effort;
  /** 默认 64000（流式） */
  maxTokens?: number;
  /** 默认 50，单执行段硬护栏 */
  maxTurns?: number;
  /** 可选：同一执行谱系的累计轮次上限；continuation / 返工不得清零 */
  maxTotalTurns?: number;
  /** 可选：同一执行谱系的累计 token 上限（input+cacheCreation+cacheRead+output） */
  maxTokensBudget?: number;
  /** 高阶装配口：多个 AgentLoop 共享同一个实例；通常由 orchestrate 自动创建 */
  runBudget?: SharedRunBudget;
  workdir: string;
  /** 逐 run 固定；所有任意命令工具必须经它执行。 */
  executionBroker?: ExecutionBroker;
  /** 额外只读根（见 ToolContext.readRoots）。CLI 经 AGENT_READ_ROOTS 注入 */
  readRoots?: string[];
  /**
   * 第三方 Anthropic 兼容端点模式（DeepSeek/GLM/Kimi 等）：
   * 去掉 Claude 专属参数（adaptive thinking / output_config.effort / cache_control）。
   * 缺省时由宿主按模型名推断（非 claude-* 即 true）。
   */
  compat?: boolean;
  /** 上下文 token 上限（触发 compact 的依据，按上一轮实际输入衡量）。默认 150_000 */
  contextTokenLimit?: number;
  /** 从持久化检查点恢复时注入的上一轮实际输入水位；全新会话不得设置 */
  initialContextInputTokens?: number;
  /**
   * 结构化禁工具（B0b，案例 #9 第二跑实弹催生）：收口续跑的"别再调工具"
   * 不能靠模型自觉——实测收口提示被无视、2 轮收口预算全烧在继续取证上。
   * 设 "none" 时：① 请求下发 tool_choice=none；② loop 对仍然返回的 tool_use
   * **不执行**，回一条可操作的拒绝让模型改写结论（双保险：端点可能只收不认）。
   * 设 `{type:"tool",name}` 时反过来——强制交付（§2.1），见 ToolChoice。
   */
  toolChoice?: ToolChoice;
  /**
   * 终结工具（§2.1）：模型调用它 = 提交业务状态。loop 发 `tool_call` 事件把入参
   * 交出去、回一条确认 tool_result 保持正史合法，再按角色的 resolveTerminal
   * 映射为 `completed` / `partial` / `blocked`；旧角色不提供解析器时仍按 completed。
   *
   * 该工具**必须同时出现在 `tools` 里**——否则 `tool_choice` 点名一个不存在的
   * 工具会被端点判 400。装配责任在调用方（verifier/planner）。
   */
  terminalTool?: string;
  /**
   * 终结工具的语义校验。undefined = 沿用旧语义（调用即 completed）；
   * 返回 undefined = 入参无效，loop 回 is_error 并继续，绝不假装交付完成。
   */
  resolveTerminal?: (input: unknown) => TerminalResolution | undefined;
  /** end_turn / max_tokens 不能收尾，必须先调用 terminalTool；主执行者与澄清门使用 */
  requireTerminalTool?: boolean;
  /** 未调用必需终结工具时回给模型的动作提示 */
  terminalReminder?: string;
  /** 目标级恢复策略；未设置时保持传统的“到 maxTurns 即停”语义 */
  recovery?: RecoveryPolicy;
  /**
   * loop 层对瞬时 API 错误（网络/超时/429/5xx）的同轮重试次数，默认 1。
   * 与 SDK 内置的 HTTP 重试是两层：SDK 耗尽后 loop 再兜一次，避免整个 run 因
   * 一次抖动作废（A/B 实测：基建错误占 hard 套件失败的 1/3）。设 0 关闭。
   */
  errorRetries?: number;
  /** 重试退避基数毫秒（第 n 次重试等 n×此值）。默认 1500；测试可设 0 */
  errorRetryBackoffMs?: number;
  /** 动态上下文（时间/环境等易变信息）：注入首条 user 消息，绝不进 system（P3） */
  dynamicContext?: Record<string, string>;
}

export interface AggregateUsage {
  /** 未缓存部分 */
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  turns: number;
  /** cacheRead / (input + cacheCreation + cacheRead)，无输入时为 0 */
  cacheHitRatio: number;
}

export interface AgentRunResult {
  /**
   * 未启用完成门时 completed 可由 end_turn 产生；启用后 completed/partial/blocked
   * 只能来自合法终结工具。max_tokens = 末轮输出撞单次上限被截断；
   * incomplete/stalled = 宿主有界恢复后仍未能业务收口。
   */
  stopReason:
    | "completed"
    | "max_tokens"
    | "max_turns"
    | "budget_exhausted"
    | "partial"
    | "blocked"
    | "incomplete"
    | "stalled"
    | "refusal"
    /**
     * 宿主主动中止（人按了停止）。**与 error 分开**：那是委托方的决定，不是失败。
     * 混进 error 会让界面把"我叫停的"画成"它崩了"——V-04 那条教训的同族
     * （计划门否决当初也是这么分出去的）。
     */
    | "aborted"
    | "error";
  /** 完整会话历史（SDK 类型），可用于持久化或子代理接力 */
  messages: Anthropic.MessageParam[];
  usage: AggregateUsage;
  /** requireTerminalTool 的结构化交付；非主执行角色通常为空 */
  completion?: TaskCompletion;
  /** 跨段预算的收尾快照，便于宿主解释“为什么这段还没满却停了” */
  runBudget?: SharedRunBudget;
  /** 最后一轮实际输入水位；宿主恢复 ContextManager 时用于首个请求前的压缩判定 */
  contextInputTokens?: number;
  /** stopReason = "error" 时的宿主级错误；工具错误不会出现在这里 */
  error?: Error;
}

/**
 * run 级终止原因**全集**——三处口径一致锁的唯一事实源（backlog B1）。
 * = loop 的十一值（AgentRunResult.stopReason）+ 宿主计划门两值：
 * plan_rejected / plan_gate_expired 由 Web 宿主在计划确认门路径写入
 * run 级 stopReason，AgentLoop 永远不会发射它们。
 * 加新值**先加这里**——ui/public/app.js 的 classifyStopReason 与
 * docs/03-interfaces.md 由回归锁（test/ui-app.test.ts「B1 · 终止原因
 * 三处口径一致锁」）逼着逐值跟上，写死的计数会过期，枚举不会。
 */
export const STOP_REASONS = [
  "completed",
  "max_tokens",
  "max_turns",
  "budget_exhausted",
  "partial",
  "blocked",
  "incomplete",
  "stalled",
  "refusal",
  "aborted",
  "error",
  "plan_rejected",
  "plan_gate_expired",
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

type MustBeTrue<T extends true> = T;
/** 类型层锁：loop 的值必须落在全集内——往 AgentRunResult 加值而漏进 STOP_REASONS 时这行编译不过 */
export type LoopStopReasonsAreCanonical = MustBeTrue<
  AgentRunResult["stopReason"] extends StopReason ? true : false
>;

/** loop 对外发射的结构化事件——日志、UI、审批门都是它的消费者 */
export type TurnEvent =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; text: string }
  | { type: "assistant_text"; text: string }
  | { type: "tool_call"; toolUseId: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; result: ToolResult; durationMs: number }
  | {
      type: "approval_request";
      toolUseId: string;
      name: string;
      input: unknown;
      /** 宿主必须调用 respond 才能让 loop 继续；deny 时可附给模型的理由 */
      respond: (decision: "allow" | "deny", reason?: string) => void;
    }
  | { type: "usage"; turn: number; usage: Anthropic.Usage }
  | { type: "compaction"; droppedBlocks: number }
  /**
   * 思考增量（逐字）。与 `assistant_thinking`（turn 级整块）互补：
   * 这条用于"运行中看它在想什么"，那条用于事后回看。
   * 与 text_delta 同族——不占 seq、不进事件缓冲，走 SSE 命名通道。
   */
  | { type: "thinking_delta"; text: string }
  /** backoffMs = 本次实际等待毫秒（含抖动）——不带它宿主就看不出重试到底等了多久 */
  | { type: "api_retry"; turn: number; attempt: number; reason: string; backoffMs: number }
  /**
   * 端点降级（MODEL-01a）。**唯一一条不由 AgentLoop 发射的 TurnEvent**：
   * 换端点发生在 L0（FallbackModelClient.send 内部），循环那一层只认识
   * ModelClient 接口，按设计不知道这次调用换了一家服务商。宿主在装配模型
   * 客户端时挂 onFallback，收到就合成这条事件推进自己的事件流。
   *
   * 放进 TurnEvent 而不是各宿主各定义一个形状：CLI 与 Web 必须渲染同一件事，
   * 两边各写一遍字段名就是下一次"界面少显示一行且不报错"的温床。
   *
   * reason 是**离开上一个端点的原因**（HTTP 状态+消息，或 `circuit_open`
   * 表示它还在熔断隔离期被跳过）；turn 是该客户端的第几次 send，
   * 与 loop 的轮次不是同一个计数器（一轮可能重发多次）。
   */
  | { type: "model_fallback"; from: string; to: string; reason: string; turn: number }
  | {
      /** 目标级恢复决策：不是模型散文，而是 harness 的确定性分支 */
      type: "recovery_decision";
      reason:
        | "end_turn_without_completion"
        | "max_tokens_without_completion"
        | "max_turns"
        | "stagnation";
      action:
        | "request_completion"
        | "continue_with_context"
        | "change_strategy"
        | "force_completion";
      detail: string;
      extraTurns?: number;
    }
  /**
   * 段级续跑（9.8）：整段因**瞬时**宿主级错误终止后，带着已有正史再续一次，
   * 而不是把整段工作作废。与 api_retry 是两回事——那个是同一轮内重发同一个请求，
   * 这个是一整段已经死了、靠正史接着往下走。
   * 必须显式发出来：否则宿主会看到一个 `done(error)` 之后又冒出一堆事件，
   * 完全读不懂（V-01 那条「段终止 ≠ run 终止」的同族）。
   */
  | { type: "segment_resume"; attempt: number; reason: string; priorTurns: number }
  /**
   * 模型的思考块（turn 级整块）。与 `thinking_delta`（逐字）**互补，不是替代**：
   * 这条是事后回看的完整记录并进日志，那条是运行中的直播、不占 seq。
   * 数据一直在 message.content 里，但此前只进会话正史，而正史每段结束才落盘，
   * 于是运行过程中完全看不见。redacted = 服务端加密的思考，内容取不到但事实要可见。
   */
  | { type: "assistant_thinking"; turn: number; text: string; redacted: boolean }
  | { type: "done"; result: AgentRunResult };

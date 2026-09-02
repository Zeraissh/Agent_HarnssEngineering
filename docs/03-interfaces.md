# 03 — 核心接口定义（TypeScript 蓝本）

本文件是 v0.2 实现的直接蓝本：只定义类型与契约，不含实现体。

**总约定**：凡是 API 数据结构，一律复用 SDK 导出类型（`Anthropic.MessageParam`、`Anthropic.Tool`、`Anthropic.ToolUseBlock`、`Anthropic.Message`、`Anthropic.Usage` 等），本框架**不**重复定义等价类型。下文自定义的类型都是 harness 自己的概念（工具契约、事件、护栏），与 wire 格式正交。

```ts
import type Anthropic from "@anthropic-ai/sdk";
```

---

## L2 — 工具契约

```ts
/** JSON Schema 对象（工具输入约束）。直接使用 SDK 的 Tool.InputSchema 形状。 */
type JSONSchema = Anthropic.Tool.InputSchema;

interface ToolContext {
  /** 工作目录（路径校验的根，所有文件类工具不得逃逸） */
  workdir: string;
  /** 本次调用的 tool_use_id，用于日志关联 */
  toolUseId: string;
  /** 取消信号：护栏触发或用户中断时，长时间运行的工具应尽快退出 */
  signal: AbortSignal;
  /** 本 run 固定的任意命令边界；bash 不得绕过它 */
  executionBroker?: ExecutionBroker;
}

interface ExecutionBroker {
  readonly boundaryId: string;
  /** requested/probe/effective/coverage 分开报告，禁止单一 sandboxed 布尔值 */
  status(): ExecutionBoundaryStatus;
  /** 功能探测，不以 which/version 冒充可用；admission/execute 用 force=true */
  probe(force?: boolean): Promise<ExecutionBoundaryStatus>;
  executeShell(request: ShellExecutionRequest): Promise<ShellExecutionResult>;
  dispose?(): Promise<void>;
}

interface ToolResult {
  /** 回填给模型的内容。错误信息要写给模型看（可操作、指明修正方向），不是写给人看 */
  content: string;
  /** true = 以 is_error: true 回传，模型据此调整策略；不会中断循环 */
  isError?: boolean;
}

interface ToolApprovalPolicy {
  /** once = 仅当前调用；exact-input = 可在 TTL/次数内复用完全相同的输入 */
  maxScope: "once" | "exact-input";
  /** 工具上限；宿主还会与自己的全局上限取更严格值 */
  maxTtlMs?: number;
  /** 自动复用次数，不含最初由人批准的那次 */
  maxUses?: number;
}

interface Tool {
  name: string;
  /** 必须写清“何时调用”（触发条件），不只是“做什么”——直接影响模型触发率 */
  description: string;
  inputSchema: JSONSchema;
  /** auto = 直接执行；ask = 发 approval_request 事件，等宿主应答后执行 */
  permission: "auto" | "ask";
  /** true = 可与其他 parallelSafe 工具并发执行（典型：只读工具） */
  parallelSafe: boolean;
  /** 缺省 once；高副作用工具不应开放 exact-input 复用 */
  approvalPolicy?: ToolApprovalPolicy;
  /** input 为 JSON.parse 后的对象；实现内部自行做 schema 校验与收窄 */
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

interface ToolRegistry {
  register(tool: Tool): void;
  get(name: string): Tool | undefined;
  /** 确定性序列化：按 name 排序输出 SDK tools 参数（顺序稳定 = 缓存前缀稳定） */
  toApiTools(): Anthropic.Tool[];
}
```

---

## L0 — 模型客户端

```ts
interface ModelRequest {
  system: Anthropic.TextBlockParam[];      // 已含 cache_control 标记（由 L3 决定位置）
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  maxTokens: number;
  effort: "low" | "medium" | "high" | "xhigh";
}

/** 归一化后的一次模型往返 */
interface ModelTurn {
  message: Anthropic.Message;              // 完整 assistant 消息（含全部 content 块）
  stopReason: Anthropic.Message["stop_reason"];
  usage: Anthropic.Usage;
}

interface ModelClient {
  /**
   * 一律流式发送；流式 text delta 通过 onDelta 旁路给调用方（仅供渲染），
   * 控制流只依赖返回的最终 ModelTurn。
   */
  send(req: ModelRequest, onDelta?: (text: string) => void): Promise<ModelTurn>;
}
```

---

## L3 — 上下文管理

```ts
interface CompactResult {
  messages: Anthropic.MessageParam[];
  /** 本次被置换为占位文本的 tool_result 块数；0 = 未压缩 */
  droppedBlocks: number;
  /** MEM-01：结构化账本事实条数（约束/决策/失败/证据/副作用） */
  ledgerEntries: number;
  /** MEM-01：写入正史的 durable ledger；未压缩时为空 */
  ledger: CompactLedger;
}

interface ContextManager {
  /** 冻结的 system prompt（构造后不可变） */
  readonly systemPrompt: string;

  /**
   * 组装一次请求：放置缓存断点（system 尾块 + 最近 user 消息尾块）。
   * compat 模式（cacheBreakpoints=false）下不打任何标记。
   */
  render(messages: Anthropic.MessageParam[], tools: Anthropic.Tool[]): ModelRequest;

  /** loop 每轮喂入实际 usage —— compact 的触发依据（上一轮 input+cacheW+cacheR） */
  noteUsage(usage: Anthropic.Usage): void;

  /** 最近一轮实际输入水位；持久化检查点恢复首请求的 compact 判据 */
  checkpointInputTokens(): number;

  /**
   * v0.3 + MEM-01：上一轮输入超过 contextTokenLimit 的 80% 时，把保护窗口
   * （protectRecent，默认 6 条）之外的大体积 tool_result 置换为语义占位，
   * 并 upsert `[compact_ledger]`（约束/决策/失败/证据/副作用）。结构不变
   * （tool_use_id 配对保持），幂等（已压缩块不重复计数）。loop 用返回值替换
   * 正史（一次性、确定性），保证后续请求前缀稳定不抖缓存。启发式非 LLM 摘要。
   */
  compact(messages: Anthropic.MessageParam[]): CompactResult;
}

/** 动态上下文注入规范（P3）：易变信息进首条 user 消息，绝不进 system */
function userMessageWithContext(
  userInput: string,
  context: Record<string, string>,
): Anthropic.MessageParam;
```

---

## L1 — Agent 循环与事件流

```ts
interface AgentConfig {
  model: string;                          // 默认 "claude-opus-4-8"
  systemPrompt: string;                   // 冻结；禁止含时间戳等易变内容
  tools: Tool[];
  executionBroker?: ExecutionBroker;      // 逐 run 固定，经 Loop/Executor 传播
  effort?: "low" | "medium" | "high" | "xhigh";   // 默认 "high"
  maxTokens?: number;                     // 默认 64000（流式）
  maxTurns?: number;                      // 默认 50，单执行段护栏
  maxTotalTurns?: number;                 // 可选：continuation/返工共用的总轮次上限
  maxTokensBudget?: number;               // 可选：整个执行 lineage 的累计 token 上限
  runBudget?: SharedRunBudget;             // 宿主注入：跨 AgentLoop 实例共享同一总账
  workdir: string;
  compat?: boolean;                       // 第三方 Anthropic 兼容端点：去掉 Claude 专属参数
  contextTokenLimit?: number;             // 触发 compact 的上下文上限，默认 150000
  initialContextInputTokens?: number;     // 从持久化检查点恢复的上一轮输入水位
  dynamicContext?: Record<string, string>; // 易变信息（时间/环境）注入首条 user 消息
}

/** loop 对外发射的结构化事件——日志、UI、审批门都是它的消费者（原则 P4） */
type TurnEvent =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; text: string }                       // 流式渲染用
  | { type: "assistant_text"; text: string }                   // 一轮的完整文本
  | { type: "tool_call"; toolUseId: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; result: ToolResult; durationMs: number }
  | { type: "approval_request"; toolUseId: string; name: string; input: unknown;
      /** 宿主必须调用 respond 才能让 loop 继续；deny 时可附给模型的理由 */
      respond: (decision: "allow" | "deny", reason?: string) => void }
  | { type: "usage"; turn: number; usage: Anthropic.Usage }
  | { type: "compaction"; droppedBlocks: number; ledgerEntries?: number }
  | { type: "recovery_decision";
      reason: "end_turn_without_completion" | "max_tokens_without_completion" | "max_turns" | "stagnation";
      action: "request_completion" | "continue_with_context" | "change_strategy" | "force_completion";
      detail: string; extraTurns?: number }
  | { type: "done"; result: AgentRunResult };

interface SharedRunBudget {
  maxTurns?: number;
  maxTokens?: number;
  usedTurns: number;
  usedTokens: number;
}

interface TaskCompletion {
  status: "completed" | "partial" | "blocked";
  summary: string;
  artifacts: string[];
  verification: string[];
  assumptions: string[];
  blockers: string[];
}

interface AggregateUsage {
  inputTokens: number;            // 未缓存部分
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  turns: number;
  /** 判断缓存是否生效的关键指标：cacheRead / (input + cacheCreation + cacheRead) */
  cacheHitRatio: number;
}

interface AgentRunResult {
  /**
   * 具名值全集与分层以 src/types.ts 的 STOP_REASONS 为准（三处口径一致锁的
   * 事实源，test/ui-app.test.ts 有逐值锁）。loop 只发射下面十一值；
   * `"plan_rejected"` 与 `"plan_gate_expired"` 是 run 级值，由 Web 宿主在
   * 计划确认门路径写入，不会出现在这里。
   */
  stopReason: "completed" | "partial" | "blocked" | "incomplete" | "stalled"
    | "max_tokens" | "max_turns" | "budget_exhausted" | "refusal" | "aborted" | "error";
  /** 完整会话历史（SDK 类型），可用于持久化或子代理接力 */
  messages: Anthropic.MessageParam[];
  usage: AggregateUsage;
  /** finish_task 的结构化交付；预算/中止/协议失败等路径可能缺省 */
  completion?: TaskCompletion;
  /** 当前执行 lineage 的累计总账快照 */
  runBudget?: SharedRunBudget;
  /** 最后一轮实际输入水位；宿主与 transcript 段号一起写入检查点 */
  contextInputTokens?: number;
  /** stopReason = "error" 时的宿主级错误（API 不可达等；工具错误不会出现在这里） */
  error?: Error;
}

interface AgentLoop {
  /**
   * 事件驱动契约：宿主 for-await 消费事件即驱动循环前进。
   * - approval_request 事件挂起循环直到 respond 被调用；
   * - abort signal 触发时，当前工具收到取消信号，循环以 stopReason="aborted" 尽快结束
   *   （人叫停是决定不是故障，与 "error" 分开——混在一起界面会把"我停的"画成"它崩了"）；
   * - 事件流最后一个事件恒为 done。
   */
  run(userInput: string, signal?: AbortSignal): AsyncIterable<TurnEvent>;
}
```

Web 归档续跑契约：`POST /api/runs/:id/messages` 对进程内 live run 返回同一 `runId`
（`continuationMode: "same"`）；对带完整检查点的 archived run 创建并返回新的子
`runId`（`continuationMode: "fork"`、`continuedFrom`、`rootRunId`）。父归档不追加
事件。子 run 首条 durable 事件为 `run_forked`；当前宿主的模型/工具/策略重新装配，
审批状态重置，共享预算的已用量延续，旧/新上限取更严格者。

---

## L4 — 验证与编排（v0.4）

```ts
interface Verdict {
  passed: boolean;
  issues: string[];   // 未通过时的问题清单（会拼进返工输入）
  summary: string;
}

interface VerifyOutcome { verdict: Verdict; usage: AggregateUsage; raw: string; }

/**
 * 干净上下文核查：与父级同 system/tools（缓存前缀一致），不共享会话历史；
 * 内部对一切 approval_request 自动 deny（verifier 只读，硬约束）；
 * 裁决 JSON 宽容解析，解析失败 = 不通过（fail-closed）。
 */
function runVerifier(cfg: AgentConfig, model: ModelClient, opts: {
  task: string;
  executorReport: string;   // 不可信输入——verifier 的职责就是不信它
}): Promise<VerifyOutcome>;

/** 主 run → 核查 → 未通过带问题清单返工（默认最多 1 轮） */
function runVerified(cfg: AgentConfig, model: ModelClient, task: string, opts?: {
  maxReworks?: number;
  onEvent?: (source: "main" | "rework" | "verifier", event: TurnEvent) => void | Promise<void>;
}): Promise<{
  main: AgentRunResult;
  verifications: VerifyOutcome[];
  reworks: number;
  finalPassed: boolean;
}>;
```

---

## L5 — 跨会话记忆（v0.5）

```ts
interface MemoryEntry { name: string; summary: string; sizeBytes: number; }

class MemoryStore {
  constructor(readonly dir: string);
  list(): Promise<MemoryEntry[]>;        // 摘要实时取自文件首行——索引不落盘、永不漂移
  read(name: string): Promise<string>;
  write(name: string, content: string): Promise<void>;  // 名字正则 + 圈禁校验 + 64KB 上限
  delete(name: string): Promise<void>;
  indexBlock(): Promise<string>;         // 注入 dynamicContext.memory_index 的索引文本
}

/** 工厂：memory_list / memory_read（parallelSafe）+ memory_write / memory_delete，全部 auto */
function createMemoryTools(store: MemoryStore): Tool[];
```

宿主接入约定：`dynamicContext: { ..., memory_index: await store.indexBlock() }` + system prompt 中一段**静态**的记忆使用纪律（何时写、何时删、不存什么）。

---

## 契约要点（实现必须遵守的行为语义）

1. **完整 push assistant content**：每轮把 `ModelTurn.message.content` 原样加入历史——丢弃 tool_use / thinking 块会导致下一次请求 400 或行为退化。
2. **tool_result 单条合并**：一轮内所有 ToolResult（含 error 的）合并为一条 user 消息；每个 `tool_use_id` 必须有且仅有一个对应 result。
3. **审批语义**：`approval_request` 的 `respond("deny", reason)` 不终止循环——生成 `is_error: true` 的 tool_result（内容含 reason）回传模型。
4. **护栏优先级**：轮数/预算检查发生在每次模型调用**之前**；`maxTurns` 约束单段，`runBudget` 约束 continuation/返工共用总账。共享轮次在发送前预占；token 按完整响应结算，显式 token 上限会串行化同一总账下的模型调用，允许最后一次响应自然越界，但禁止并发轨基于旧余额同时起跑。触发时以对应 stopReason 收尾并发 done 事件。
5. **compact 触发点**：由 loop 在 render 前根据累计输入 token 估算决定是否调用 `compact()`；触发时发 `compaction` 事件保证可观测。
6. **业务完成不等于 wire 结束**：启用完成门时，`end_turn` / `stop_sequence` 只表示本次生成结束；只有合法 `finish_task` 才能产生 `"completed"`、`"partial"` 或 `"blocked"`。重复文字收尾会被路由到有界强制收口，不能标绿。

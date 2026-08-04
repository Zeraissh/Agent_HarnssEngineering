# 核心模块参考

> 基于源码自动生成，覆盖 `src/` 下 6 个核心模块。每节含职责、导出签名、设计决策三部分。

---

## loop.ts

### 职责

Agent 主循环（L1）—— harness 的心脏。所有控制流决策（stop_reason 分支、护栏、事件流、审批挂起）均在此模块完成。

### 导出签名

```ts
class AgentLoop {
  constructor(cfg: AgentConfig, model: ModelClient);
  run(userInput: string, signal?: AbortSignal): AsyncIterable<TurnEvent>;
  runContinuation(
    history: Anthropic.MessageParam[],
    feedback: string,
    signal?: AbortSignal,
  ): AsyncIterable<TurnEvent>;
}
```

### 设计决策

1. **事件驱动契约**：`run()` 返回 `AsyncIterable<TurnEvent>`，宿主使用 `for-await` 消费；`approval_request` 事件会挂起循环，直到宿主调用 `respond`；最后一个事件恒为 `done`。（来源：文件头部 JSDoc）

2. **续跑（runContinuation）**：在已有会话正史之上追加一条 user 反馈继续执行，轮次预算重新起算。用途是"返工继承上下文"——agent 保留此前的探索/工具结果，不必从零重烧（A/B 实测 fresh 返工最贵一例白烧 127k tokens）。上下文增长由 compact 兜底。（来源：`runContinuation` JSDoc）

3. **续跑用户消息合并**：若正史末条是 `user`（例如 `max_turns` 停在 `tool_result` 后），反馈合并进同一条 user 消息，避免连续两条 user——Anthropic 官方允许，但第三方兼容端点未必。（来源：`drive()` 内行内注释）

4. **同轮重试机制**：SDK 的 HTTP 重试耗尽后，loop 层对瞬时网络错误再兜 `errorRetries` 次。请求是幂等的（同一 request 重发），非瞬时错误（认证/4xx/abort）立即终止。（来源：`drive()` 内重试循环前的行内注释）

5. **stop_reason 分支语义**：
   - `refusal`：不用同一 prompt 重试（API 硬约束 7）；
   - `max_tokens`：优雅终止而非报废整轮——部分 assistant 内容已入历史、`assistant_text` 已发出，都得以保留。`max_tokens` 是刻意的护栏（防本地模型跑飞/上下文预算），撞上限说明本轮输出需要更多空间——提高 `maxTokens` 即可，而非丢弃已完成的工作；
   - `pause_turn`：原样重发，不追加任何用户文本（API 硬约束 2）；
   - `tool_use`：所有 `tool_result` 合并进**同一条** user 消息（API 硬约束 1）。
  （来源：`drive()` 内各 `case` 分支的行内/行间注释）

6. **护栏检查**：发生在每次模型调用之前（契约 4），包括 `AbortSignal` 和中止和 `maxTokensBudget` 预算耗尽检查。（来源：`drive()` 内 `for` 循环顶部注释）

7. **压缩替换正史**：`compact()` 返回的结果**替换**正史（而非仅用于本次渲染），保证压缩一次性、确定性，后续请求前缀稳定（来源：`drive()` 内 `compacted` 调用处的行内注释）

8. **AsyncEventQueue**：push 式异步事件队列，让 loop 在 await 模型/工具期间也能实时发事件。内部用 `buffer` + `waiters` 实现生产者-消费者模式。（来源：`AsyncEventQueue` 类头部注释）

---

## context.ts

### 职责

上下文管理器（L3）——决定模型每次看到什么内容。负责 system prompt 组装、缓存断点标记、以及对话历史的压缩（compact）。

### 导出签名

```ts
interface ContextConfig {
  systemPrompt: string;
  maxTokens: number;
  effort: Effort;
  cacheBreakpoints?: boolean;
  contextTokenLimit?: number;
  protectRecent?: number;
}

interface CompactResult {
  messages: Anthropic.MessageParam[];
  droppedBlocks: number;
}

class DefaultContextManager {
  constructor(cfg: ContextConfig);
  noteUsage(usage: Anthropic.Usage): void;
  render(messages: Anthropic.MessageParam[], tools: Anthropic.Tool[]): ModelRequest;
  compact(messages: Anthropic.MessageParam[]): CompactResult;
}

function userMessageWithContext(
  userInput: string,
  context: Record<string, string>,
): Anthropic.MessageParam;
```

### 设计决策

1. **缓存断点策略**：两个断点——① system 尾块（连同前面的 tools 一起缓存）② 最近一条消息的最后一个可缓存块（会话增量缓存）。`render()` 不原地修改传入的 `messages`。（来源：`render()` JSDoc）

2. **system prompt 冻结（P3）**：构造时冻结，此后任何路径都不得修改 system prompt。`systemPrompt` 在构造函数内赋值后不再变化。（来源：`constructor` 内行内注释）

3. **上下文规模信号**：`lastInputTokens`（上一轮的实际输入规模 = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`）是"上下文有多大"的唯一可靠信号，也是 `compact()` 的触发依据。（来源：`lastInputTokens` 字段 JSDoc 及 `noteUsage()` 内计算逻辑注释）

4. **v0.3 压缩策略**：上一轮输入超过水位线（`contextTokenLimit * 0.8`）时，把"保护窗口之外"的大体积 `tool_result` 内容替换为占位文本。结构保持不变（每个 `tool_use_id` 仍有对应 `tool_result`），只有内容被置换——不会破坏 API 约束。小于 500 字符的 `tool_result` 不值得压缩。loop 会用返回值**替换**正史（而非仅用于本次渲染）——压缩只发生一次、结果确定，后续请求前缀保持稳定，避免每轮重压缩导致的缓存抖动。（来源：`compact()` JSDoc 及内部常量 `COMPACT_WATERMARK`、`MIN_COMPACTABLE_CHARS` 的行内注释）

5. **动态上下文注入规范（P3）**：易变信息（时间、环境）以独立 text 块进 messages，绝不写进 system prompt——system 变一个字节，其后缓存全灭。注入点在首条 user 消息，run 期间保持不变，因此 messages 前缀依然稳定。（来源：`userMessageWithContext()` JSDoc）

---

## model-client.ts

### 职责

模型客户端（L0）——Messages API 的唯一出入口。封装 Anthropic SDK 调用，统一处理流式请求、compat 模式、错误分类。

### 导出签名

```ts
interface ModelClientOptions {
  compat?: boolean;
}

class AnthropicModelClient implements ModelClient {
  constructor(model: string, client?: Anthropic, opts?: ModelClientOptions);
  send(req: ModelRequest, onDelta?: (text: string) => void): Promise<ModelTurn>;
}

function isTransientApiError(err: unknown): boolean;
function classifyApiError(err: unknown): string;
```

### 设计决策

1. **一律流式**：所有模型请求均使用 `client.messages.stream()`，不暴露已移除的采样参数（temperature/top_p 等）。（来源：文件头部 JSDoc）

2. **adaptive thinking 显式开启**：在 Claude 上省略 `thinking` 参数等于不思考，必须显式传入 `{ type: "adaptive" }`；第三方兼容端点（compat 模式）不认识 `thinking` / `output_config` 字段，此时不发送这些参数，避免被拒。（来源：`send()` 内扩展运算符处的行内注释）

3. **零参构造兼容**：`Anthropic` SDK 可零参构造，自行解析 `ANTHROPIC_API_KEY` / `AUTH_TOKEN` / `ANTHROPIC_BASE_URL` 环境变量。（来源：`constructor` 内行内注释）

4. **SDK 内置重试与 loop 层重试分层**：429/5xx 指数退避重试由 SDK 内置处理；耗尽后异常向上抛给 loop 的 `classifyApiError` 分类，loop 层再决定是否同轮重试。（来源：`send()` 内 `stream.finalMessage()` 前的行内注释）

5. **瞬时错误判定原则**：`isTransientApiError()` 供 loop 层决定"这次失败值不值得同轮重试"。网络抖动/超时/限流/服务端 5xx 是瞬时；认证/404/4xx 请求类错误重试无意义；宿主主动 abort 绝不重试。非 Anthropic SDK 的错误按 `status` 数字判，没有 `status` 的一律视为网络类瞬时错误。（来源：`isTransientApiError()` JSDoc）

6. **宿主级错误分类**：`classifyApiError()` 提供中文可读报错信息，loop 用它决定报错内容，不用字符串匹配。（来源：`classifyApiError()` JSDoc）

---

## model-client-openai.ts

### 职责

L0 备选实现——将 harness 内部的 Anthropic 形状请求翻译成 OpenAI chat completions 格式，响应再翻译回来。是原则 P1（分层可替换）的终极检验：换掉整个 wire 协议，L1 loop / L2 工具 / L3 上下文零改动——它们只认识 `ModelClient` 接口。

### 导出签名

```ts
interface OpenAIClientOptions {
  baseURL?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

class OpenAIModelClient implements ModelClient {
  constructor(model: string, opts?: OpenAIClientOptions, client?: OpenAI);
  send(req: ModelRequest, onDelta?: (text: string) => void): Promise<ModelTurn>;
}

function toOpenAIMessages(
  req: ModelRequest,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[];

function toOpenAITools(
  tools: Anthropic.Tool[],
): OpenAI.Chat.Completions.ChatCompletionTool[];

interface AccumulatedCompletion {
  id: string;
  model: string;
  text: string;
  calls: { id: string; name: string; args: string }[];
  finish: string | null;
  usage: OpenAI.CompletionUsage | undefined;
}

function fromAccumulated(acc: AccumulatedCompletion): ModelTurn;
```

### 设计决策

1. **请求方向翻译要点**：
   - Anthropic 的 `tool_result` 块（合并在一条 user 消息里）→ OpenAI 的多条 `role:"tool"` 消息（必须紧跟对应的 assistant `tool_calls` 消息）；
   - Anthropic 的 `tool_use` 块 → OpenAI 的 `assistant.tool_calls`（input 序列化为 JSON 串）；
   - `is_error` 标志在 OpenAI 协议里不存在 → 降级为内容前缀 `"[tool error] "`；
   - `thinking` 块（如 Ollama 产生）→ 丢弃（OpenAI 协议无对应物）。
  （来源：`toOpenAIMessages()` 内部各行内注释）

2. **响应方向翻译要点**：
   - `finish_reason` 映射：`tool_calls` → `"tool_use"`，`length` → `"max_tokens"`，其余 → `"end_turn"`；
   - 缓存命中识别：优先取 OpenAI 规范字段 `prompt_tokens_details.cached_tokens`；DeepSeek 另有 `prompt_cache_hit_tokens`（含义相同，谁在用谁）；
   - `input_tokens` 需扣除缓存命中部分：`prompt_tokens - cacheRead`。
  （来源：`fromAccumulated()` 内部各行内/行间注释）

3. **流式手写 SSE 分片累积**：文本 delta 旁路给 `onDelta`；tool_calls 按 `index` 拼装（ID、函数名、参数分别累积）。（来源：`send()` 内 `for await` 循环的行内注释及文件头部 JSDoc）

4. **safeParseArgs**：模型拼出来的 JSON 串可能残缺；解析失败回传空对象（含 `__malformed_arguments` 标记），让工具的输入校验给出可操作报错，而非直接抛异常。（来源：`safeParseArgs()` JSDoc）

---

## provider.ts

### 职责

Provider 工厂——按环境变量选择 L0 实现（Anthropic 或 OpenAI），CLI 与 eval 共用。封装环境变量读取与客户端实例化逻辑。

### 导出签名

```ts
interface ResolvedProvider {
  client: ModelClient;
  provider: "anthropic" | "openai";
  compat: boolean;
}

interface ProviderOverrides {
  provider?: "anthropic" | "openai";
  baseURL?: string;
  apiKey?: string;
}

function createModelClientFromEnv(
  model: string,
  overrides?: ProviderOverrides,
): ResolvedProvider;
```

### 设计决策

1. **环境变量驱动的协议选择**：
   - `AGENT_PROVIDER=anthropic`（默认）→ `AnthropicModelClient`，通过 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` 连接 Anthropic 官方或任意 Anthropic 兼容端点；
   - `AGENT_PROVIDER=openai` → `OpenAIModelClient`，通过 `OPENAI_BASE_URL`（如 `https://api.deepseek.com`）/ `OPENAI_API_KEY` 连接，API Key 缺省复用 `ANTHROPIC_API_KEY`——同一家的 key 两种协议通用。
  （来源：文件头部 JSDoc）

2. **端点覆盖（ProviderOverrides）**：用于在同一进程里创建指向不同端点的第二个客户端。典型场景："执行者用本地 Ollama、verifier 用云端强模型"的跨强度核查实验。（来源：`ProviderOverrides` JSDoc）

3. **通用旋钮**：`AGENT_TIMEOUT_MS` 和 `AGENT_MAX_RETRIES` 两个环境变量对两种 provider 均生效，分别控制超时和最大重试次数。（来源：文件头部 JSDoc 及 `createModelClientFromEnv()` 内变量读取逻辑）

4. **Anthropic 端 SDK 客户端按需构造**：仅当 `timeoutMs`、`maxRetries`、`baseURL`、`apiKey` 任一覆盖值非空时才显式创建 `Anthropic` SDK 实例；否则传 `undefined` 给 `AnthropicModelClient`，由其零参构造。（来源：`createModelClientFromEnv()` 内 `needsCustomSdk` 判定及注释）

---

## types.ts

### 职责

核心类型定义——与 `docs/03-interfaces.md` 一一对应。约定：wire 格式一律复用 SDK 导出类型（`Anthropic.MessageParam`、`Anthropic.Tool` 等），这里只定义 harness 自身的概念。

### 导出签名

```ts
type JSONSchema = Anthropic.Tool.InputSchema;

interface ToolContext {
  workdir: string;
  toolUseId: string;
  signal: AbortSignal;
}

interface ToolResult {
  content: string;
  isError?: boolean;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  permission: "auto" | "ask";
  parallelSafe: boolean;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

type Effort = "low" | "medium" | "high" | "xhigh";

interface ModelRequest {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  maxTokens: number;
  effort: Effort;
}

interface ModelTurn {
  message: Anthropic.Message;
  stopReason: Anthropic.Message["stop_reason"];
  usage: Anthropic.Usage;
}

interface ModelClient {
  send(req: ModelRequest, onDelta?: (text: string) => void): Promise<ModelTurn>;
}

interface AgentConfig {
  model?: string;
  systemPrompt: string;
  tools: Tool[];
  effort?: Effort;
  maxTokens?: number;
  maxTurns?: number;
  maxTokensBudget?: number;
  workdir: string;
  compat?: boolean;
  contextTokenLimit?: number;
  errorRetries?: number;
  errorRetryBackoffMs?: number;
  dynamicContext?: Record<string, string>;
}

interface AggregateUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  turns: number;
  cacheHitRatio: number;
}

interface AgentRunResult {
  stopReason: "completed" | "max_tokens" | "max_turns" | "budget_exhausted" | "refusal" | "error";
  messages: Anthropic.MessageParam[];
  usage: AggregateUsage;
  error?: Error;
}

type TurnEvent =
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
      respond: (decision: "allow" | "deny", reason?: string) => void;
    }
  | { type: "usage"; turn: number; usage: Anthropic.Usage }
  | { type: "compaction"; droppedBlocks: number }
  | { type: "api_retry"; turn: number; attempt: number; reason: string }
  | { type: "done"; result: AgentRunResult };
```

### 设计决策

1. **wire 格式复用约定**：所有与 API 通信相关的类型（消息、content block、usage）一律复用 `@anthropic-ai/sdk` 的导出类型，harness 自身只定义与业务逻辑相关的概念（配置、事件、结果）。（来源：文件头部 JSDoc）

2. **Tool.description 必须写清触发条件**：不只是"做什么"，更要写清"何时调用"。（来源：`Tool.description` 字段 JSDoc）

3. **Tool.permission 两级权限**：`"auto"` = 直接执行；`"ask"` = 发 `approval_request` 事件，等宿主应答后执行。（来源：`Tool.permission` 字段 JSDoc）

4. **ToolResult.isError 不中断循环**：`isError: true` 以 `is_error: true` 回传给模型，模型据此调整策略；但不会导致循环终止。错误信息要写给模型看，做到可操作、指明修正方向。（来源：`ToolResult` 各字段 JSDoc）

5. **AgentConfig.systemPrompt 必须冻结**：禁止含时间戳等易变内容——这些应放入 `dynamicContext`。（来源：`AgentConfig.systemPrompt` 字段 JSDoc）

6. **AgentConfig.errorRetries 双层重试**：loop 层对瞬时 API 错误的同轮重试次数，默认 1。与 SDK 内置的 HTTP 重试是两层：SDK 耗尽后 loop 再兜一次，避免整个 run 因一次抖动作废（A/B 实测：基建错误占 hard 套件失败的 1/3）。设 0 关闭。（来源：`AgentConfig.errorRetries` 字段 JSDoc）

7. **dynamicContext 注入规则**：动态上下文（时间/环境等易变信息）注入首条 user 消息，绝不进 system（P3）。（来源：`AgentConfig.dynamicContext` 字段 JSDoc）

8. **AgentRunResult.stopReason 语义**：`completed` = 正常结束；`max_tokens` = 末轮输出撞单次上限被截断（**非错误**：已生成内容保留在 messages 中，提高 `maxTokens` 可让其写完）；其余为护栏/拒绝/宿主错误。`error` 字段仅在 `stopReason = "error"` 时有值，工具错误不会出现在这里。（来源：`AgentRunResult` 各字段 JSDoc）

9. **AggregateUsage.cacheHitRatio 计算**：`cacheRead / (inputTokens + cacheCreationTokens + cacheReadTokens)`，无输入时为 0。（来源：`AggregateUsage.cacheHitRatio` 字段 JSDoc 及 `loop.ts` 中 `finish()` 内的计算逻辑）

10. **ModelClient.send 一律流式**：text delta 通过 `onDelta` 旁路（仅供渲染），控制流只依赖最终 `ModelTurn`。（来源：`ModelClient.send` 字段 JSDoc）

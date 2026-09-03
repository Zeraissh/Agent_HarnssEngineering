/**
 * L0 — ModelClient：Messages API 的唯一出入口。
 * 决策（docs/02）：一律流式；adaptive thinking 显式开启；不暴露已移除的采样参数。
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ModelClient, ModelRequest, ModelTurn, StreamDelta, ToolChoice } from "./types.js";

/**
 * ToolChoice → Anthropic wire。纯函数单独提出来是为了能被单测钉住：
 * 这一行 spread 映射写错了不会报错，只会静默变成"没约束"——
 * B0b 那一轮在 OpenAI 侧留下的正是这种没锁住的映射。
 */
export function toAnthropicToolChoice(choice: ToolChoice): Anthropic.ToolChoice {
  return choice === "none" ? { type: "none" } : { type: "tool", name: choice.name };
}

export interface ModelClientOptions {
  /**
   * 第三方 Anthropic 兼容端点（DeepSeek/GLM/Kimi 等）：不发送 Claude 专属的
   * thinking / output_config 参数，避免被拒。缺省按模型名推断。
   */
  compat?: boolean;
}

export class AnthropicModelClient implements ModelClient {
  private client: Anthropic;
  private readonly compat: boolean;
  /** 端点拒绝过强制工具就记住，后续请求直接不带（见 send 的降级臂） */
  private forcedToolUnsupported = false;

  constructor(
    private readonly model: string,
    client?: Anthropic,
    opts?: ModelClientOptions,
  ) {
    // 零参构造：SDK 自行解析 ANTHROPIC_API_KEY / AUTH_TOKEN / ANTHROPIC_BASE_URL
    this.client = client ?? new Anthropic();
    this.compat = opts?.compat ?? !model.startsWith("claude");
  }

  /**
   * 请求体构造（纯函数化，便于测试与降级重发共用）。
   *
   * **强制工具与思考模式互斥**（2026-08-15 真机探针实测）：
   * DeepSeek 兼容端点对 `tool_choice:{type:"tool"}` + 思考模式直接 400
   * 「Thinking mode does not support this tool_choice」；显式
   * `thinking:{type:"disabled"}` 后同一请求 200 且真的返回 tool_use。
   *
   * 这**不是端点的怪癖，是 Anthropic 协议本身的约束**——扩展思考开启时
   * tool_choice 不允许点名具体工具。所以两条路径统一处理，不做端点特判。
   *
   * 语义上也正好对：需要强制交付的只有收口段，那一段本来就不该再思考——
   * 它只是把手里已有的证据写成结构化交付（B0b 同款理由）。
   */
  private buildParams(req: ModelRequest, dropToolChoice: boolean): Anthropic.MessageStreamParams {
    const toolChoice = dropToolChoice ? undefined : req.toolChoice;
    const forcedTool = toolChoice !== undefined && toolChoice !== "none";
    return {
      model: this.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      // 工具选择约束。非 Claude 专属参数，compat 端点也发（DeepSeek 实测接受）
      ...(toolChoice ? { tool_choice: toAnthropicToolChoice(toolChoice) } : {}),
      // Claude 专属参数：Opus 4.8 上省略 thinking = 不思考，必须显式开启 adaptive；
      // 第三方兼容端点不认识这些字段，compat 模式下不发送。
      // **例外**：强制工具时必须显式关思考（见上），这一条对两种模式都成立。
      ...(forcedTool
        ? { thinking: { type: "disabled" as const } }
        : this.compat
          ? {}
          : { thinking: { type: "adaptive" as const }, output_config: { effort: req.effort } }),
    } as Anthropic.MessageStreamParams;
  }

  async send(
    req: ModelRequest,
    onDelta?: (delta: StreamDelta) => void,
    signal?: AbortSignal,
  ): Promise<ModelTurn> {
    try {
      return await this.stream(this.buildParams(req, this.forcedToolUnsupported), onDelta, signal);
    } catch (err) {
      /**
       * 降级臂（§2.1）：端点拒绝强制工具时**剥掉它重发一次**，而不是把整段烧掉。
       *
       * 为什么必须在 wire 层做：400 是永久性错误，loop 的重试分类会直接
       * `finish("error")`——于是"强制交付"这个增强反而会杀死收口救援，
       * 比不做还糟。端点能力差异归 L0，上面几层不该知道（P1）。
       * 记住结论：同一个端点不必每轮撞一次墙。
       */
      if (this.forcedToolUnsupported || !isForcedToolRejection(err, req)) throw err;
      this.forcedToolUnsupported = true;
      return await this.stream(this.buildParams(req, true), onDelta, signal);
    }
  }

  private stream(
    params: Anthropic.MessageStreamParams,
    onDelta?: (delta: StreamDelta) => void,
    signal?: AbortSignal,
  ): Promise<ModelTurn> {
    // 第二参是请求选项：signal 进到这里，abort 才能掐掉在飞的 HTTP 请求
    const stream = this.client.messages.stream(params, signal ? { signal } : undefined);

    if (onDelta) {
      stream.on("text", (delta) => onDelta({ kind: "text", text: delta }));
      // 思考增量：compat 端点未必吐，吐不出来就只是没有这一路，不影响其它
      stream.on("thinking", (delta) => onDelta({ kind: "thinking", text: delta }));
    }

    // 重试（429/5xx 指数退避）由 SDK 内置处理；耗尽后异常向上抛给 loop 分类
    return stream
      .finalMessage()
      .then((message) => ({ message, stopReason: message.stop_reason, usage: message.usage }));
  }
}

/**
 * 这个错误是不是"端点不接受强制工具"。
 *
 * 只在本轮**确实带了**强制工具时才认——否则会把无关的 400 也吞掉重发一次，
 * 白烧一次调用还掩盖真正的错误。判据取宽（400 且提到 tool_choice/thinking）：
 * 各家兼容端点的措辞不统一，而误判的代价只是多发一次不带强制的请求。
 */
export function isForcedToolRejection(err: unknown, req: ModelRequest): boolean {
  if (req.toolChoice === undefined || req.toolChoice === "none") return false;
  const status = (err as { status?: number })?.status;
  if (status !== 400) return false;
  const msg = String((err as { message?: unknown })?.message ?? "").toLowerCase();
  return msg.includes("tool_choice") || msg.includes("thinking");
}

/**
 * 瞬时错误判定：loop 层决定"这次失败值不值得同轮重试"。
 * 原则：网络抖动/超时/限流/服务端 5xx 是瞬时；认证/404/4xx 请求类错误重试无意义；
 * 宿主主动 abort 绝不重试。非 Anthropic SDK 的错误（OpenAI 客户端/底层网络）按
 * status 数字判，没有 status 的一律视为网络类瞬时错误。
 */
export function isTransientApiError(err: unknown): boolean {
  if (err instanceof Anthropic.APIUserAbortError) return false;
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    err instanceof Anthropic.NotFoundError ||
    err instanceof Anthropic.BadRequestError ||
    err instanceof Anthropic.UnprocessableEntityError
  ) {
    return false;
  }
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.APIConnectionError) {
    return true; // 含 APIConnectionTimeoutError（其子类）
  }
  if (err instanceof Anthropic.APIError) {
    const s = err.status;
    return s === undefined || s >= 500 || s === 408 || s === 409 || s === 429;
  }
  const s = (err as { status?: unknown }).status;
  if (typeof s === "number") return s >= 500 || s === 408 || s === 409 || s === 429;
  return true;
}

/**
 * 上下文超长判定（MEM-01 Phase C 反应式压缩的触发器）。
 *
 * 两条 wire 的形状都认：
 *  - Anthropic：400 invalid_request_error，message「prompt is too long: N tokens > M maximum」；
 *  - OpenAI / 兼容端点：400，`code: "context_length_exceeded"`，或 message
 *    「This model's maximum context length is N tokens…」（DeepSeek 等措辞略有出入）。
 * 只在 400/413（或 SDK 没给 status 但 code 命中）时认——它是永久性错误的一个**子类**，
 * 与瞬时判定正交：isTransientApiError 仍返回 false，只是 loop 在报错之前多一次硬压缩重发。
 * 判据取宽（措辞各家不同），误判的代价只是多做一次压缩再重发一次同样的请求。
 */
export function isContextOverflowError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  const code = readErrorCode(err);
  const message = String((err as { message?: unknown }).message ?? "").toLowerCase();
  const codeHit = code === "context_length_exceeded" || code === "context_window_exceeded";
  const messageHit =
    /prompt is too long/.test(message) ||
    /context[_ ]length/.test(message) ||
    /maximum context length/.test(message) ||
    /context window/.test(message) ||
    /too many tokens/.test(message) ||
    /input (is )?too long/.test(message);
  if (typeof status === "number") return (status === 400 || status === 413) && (codeHit || messageHit);
  return codeHit || (status === undefined && messageHit && message.includes("token"));
}

function readErrorCode(err: object): string | undefined {
  const direct = (err as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const nested = (err as { error?: { code?: unknown; error?: { code?: unknown } } }).error;
  if (nested && typeof nested === "object") {
    if (typeof nested.code === "string") return nested.code;
    if (nested.error && typeof nested.error === "object" && typeof nested.error.code === "string") {
      return nested.error.code;
    }
  }
  return undefined;
}

/** classifyApiError 对上下文超长的固定前缀——台账 taxonomy 与宿主文案都靠它识别 */
export const CONTEXT_OVERFLOW_ERROR_PREFIX = "context_overflow";

/**
 * 指标标签用的错误类（OBS-02）。
 *
 * 与 `classifyApiError` 分工明确：那个返回**给人看的中文句子**（还带端点原文），
 * 直接当 Prometheus 标签用会把基数炸到每条错误消息一个序列。这里返回固定枚举，
 * 值域先写死——新增一档要改这里，指标不会静默多长出一根曲线。
 */
export const API_ERROR_CLASSES = [
  "context_overflow",
  "auth",
  "permission",
  "rate_limit",
  "not_found",
  "bad_request",
  "timeout",
  "network",
  "server",
  "aborted",
  "unknown",
] as const;
export type ApiErrorClass = (typeof API_ERROR_CLASSES)[number];

export function apiErrorClass(err: unknown): ApiErrorClass {
  if (isContextOverflowError(err)) return "context_overflow";
  if (err instanceof Anthropic.APIUserAbortError) return "aborted";
  if (err instanceof Anthropic.AuthenticationError) return "auth";
  if (err instanceof Anthropic.PermissionDeniedError) return "permission";
  if (err instanceof Anthropic.RateLimitError) return "rate_limit";
  if (err instanceof Anthropic.NotFoundError) return "not_found";
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (err instanceof Anthropic.APIConnectionError) return "network";
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.UnprocessableEntityError) {
    return "bad_request";
  }
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number") {
    if (status === 401) return "auth";
    if (status === 403) return "permission";
    if (status === 404) return "not_found";
    if (status === 408) return "timeout";
    if (status === 429) return "rate_limit";
    if (status >= 500) return "server";
    if (status >= 400) return "bad_request";
  }
  const name = (err as { name?: unknown })?.name;
  if (name === "AbortError") return "aborted";
  if (name === "TimeoutError") return "timeout";
  return "unknown";
}

/** 宿主级错误分类：loop 用它决定报错信息，不用字符串匹配 */
export function classifyApiError(err: unknown): string {
  if (isContextOverflowError(err)) {
    const msg = String((err as { message?: unknown }).message ?? "").split("\n")[0] ?? "";
    return `${CONTEXT_OVERFLOW_ERROR_PREFIX}：请求超出模型上下文窗口，反应式压缩后仍装不下（${msg.slice(0, 160)}）`;
  }
  if (err instanceof Anthropic.AuthenticationError) return "认证失败：检查 ANTHROPIC_API_KEY 或运行 ant auth login";
  if (err instanceof Anthropic.RateLimitError) return "限流：SDK 重试已耗尽，请稍后再试";
  if (err instanceof Anthropic.NotFoundError) return "模型或端点不存在：检查 model 配置";
  if (err instanceof Anthropic.APIConnectionTimeoutError)
    return "请求超时：模型在时限内未响应（本地慢速模型常见——调大 AGENT_TIMEOUT_MS，或检查服务端是否有排队/卡住的请求）";
  if (err instanceof Anthropic.APIConnectionError) return "网络错误：无法连接 API 端点";
  if (err instanceof Anthropic.APIError) return `API 错误 ${err.status ?? "?"}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * L0 — ModelClient：Messages API 的唯一出入口。
 * 决策（docs/02）：一律流式；adaptive thinking 显式开启；不暴露已移除的采样参数。
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ModelClient, ModelRequest, ModelTurn } from "./types.js";

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

  constructor(
    private readonly model: string,
    client?: Anthropic,
    opts?: ModelClientOptions,
  ) {
    // 零参构造：SDK 自行解析 ANTHROPIC_API_KEY / AUTH_TOKEN / ANTHROPIC_BASE_URL
    this.client = client ?? new Anthropic();
    this.compat = opts?.compat ?? !model.startsWith("claude");
  }

  async send(req: ModelRequest, onDelta?: (text: string) => void): Promise<ModelTurn> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      // Claude 专属参数：Opus 4.8 上省略 thinking = 不思考，必须显式开启 adaptive；
      // 第三方兼容端点不认识这些字段，compat 模式下不发送
      ...(this.compat
        ? {}
        : { thinking: { type: "adaptive" as const }, output_config: { effort: req.effort } }),
    });

    if (onDelta) {
      stream.on("text", (delta) => onDelta(delta));
    }

    // 重试（429/5xx 指数退避）由 SDK 内置处理；耗尽后异常向上抛给 loop 分类
    const message = await stream.finalMessage();
    return { message, stopReason: message.stop_reason, usage: message.usage };
  }
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

/** 宿主级错误分类：loop 用它决定报错信息，不用字符串匹配 */
export function classifyApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "认证失败：检查 ANTHROPIC_API_KEY 或运行 ant auth login";
  if (err instanceof Anthropic.RateLimitError) return "限流：SDK 重试已耗尽，请稍后再试";
  if (err instanceof Anthropic.NotFoundError) return "模型或端点不存在：检查 model 配置";
  if (err instanceof Anthropic.APIConnectionTimeoutError)
    return "请求超时：模型在时限内未响应（本地慢速模型常见——调大 AGENT_TIMEOUT_MS，或检查服务端是否有排队/卡住的请求）";
  if (err instanceof Anthropic.APIConnectionError) return "网络错误：无法连接 API 端点";
  if (err instanceof Anthropic.APIError) return `API 错误 ${err.status ?? "?"}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

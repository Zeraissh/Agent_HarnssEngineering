/**
 * Provider 工厂：按环境变量选择 L0 实现，CLI 与 eval 共用。
 *
 *   AGENT_PROVIDER=anthropic（默认）→ AnthropicModelClient
 *     ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY（Anthropic 官方或任意 Anthropic 兼容端点）
 *   AGENT_PROVIDER=openai → OpenAIModelClient
 *     OPENAI_BASE_URL（如 https://api.deepseek.com）
 *     OPENAI_API_KEY（必须显式配置；不同 provider 之间绝不隐式复用密钥）
 *
 * 通用旋钮：AGENT_TIMEOUT_MS / AGENT_MAX_RETRIES
 */
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicModelClient } from "./model-client.js";
import { OpenAIModelClient } from "./model-client-openai.js";
import type { ModelClient } from "./types.js";

export interface ResolvedProvider {
  client: ModelClient;
  provider: "anthropic" | "openai";
  /** OpenAI 协议或非 claude-* 模型 → 不发 Claude 专属参数/缓存标记 */
  compat: boolean;
}

/**
 * 端点覆盖：用于在同一进程里创建指向不同端点的第二个客户端
 * （如"执行者用本地 Ollama、verifier 用云端强模型"的跨强度核查实验）。
 */
export interface ProviderOverrides {
  provider?: "anthropic" | "openai";
  baseURL?: string;
  apiKey?: string;
}

export function createModelClientFromEnv(
  model: string,
  overrides: ProviderOverrides = {},
): ResolvedProvider {
  const provider =
    overrides.provider ?? ((process.env.AGENT_PROVIDER ?? "anthropic") as "anthropic" | "openai");
  const timeoutMs = process.env.AGENT_TIMEOUT_MS ? Number(process.env.AGENT_TIMEOUT_MS) : undefined;
  const maxRetries = process.env.AGENT_MAX_RETRIES ? Number(process.env.AGENT_MAX_RETRIES) : undefined;

  if (provider === "openai") {
    return {
      provider,
      compat: true,
      client: new OpenAIModelClient(model, {
        baseURL: overrides.baseURL ?? process.env.OPENAI_BASE_URL,
        apiKey: overrides.apiKey ?? process.env.OPENAI_API_KEY,
        timeoutMs,
        maxRetries,
      }),
    };
  }

  const needsCustomSdk =
    timeoutMs !== undefined ||
    maxRetries !== undefined ||
    overrides.baseURL !== undefined ||
    overrides.apiKey !== undefined;
  const sdkClient = needsCustomSdk
    ? new Anthropic({
        ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
        ...(maxRetries !== undefined ? { maxRetries } : {}),
        ...(overrides.baseURL !== undefined ? { baseURL: overrides.baseURL } : {}),
        ...(overrides.apiKey !== undefined ? { apiKey: overrides.apiKey } : {}),
      })
    : undefined;

  return {
    provider,
    compat: !model.startsWith("claude"),
    client: new AnthropicModelClient(model, sdkClient),
  };
}

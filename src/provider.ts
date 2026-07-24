/**
 * Provider 工厂：按环境变量选择 L0 实现，CLI 与 eval 共用。
 *
 *   AGENT_PROVIDER=anthropic（默认）→ AnthropicModelClient
 *     ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY（Anthropic 官方或任意 Anthropic 兼容端点）
 *   AGENT_PROVIDER=openai → OpenAIModelClient
 *     OPENAI_BASE_URL（如 https://api.deepseek.com）
 *     OPENAI_API_KEY（缺省复用 ANTHROPIC_API_KEY——同一家的 key 两种协议通用）
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

export function createModelClientFromEnv(model: string): ResolvedProvider {
  const provider = (process.env.AGENT_PROVIDER ?? "anthropic") as "anthropic" | "openai";
  const timeoutMs = process.env.AGENT_TIMEOUT_MS ? Number(process.env.AGENT_TIMEOUT_MS) : undefined;
  const maxRetries = process.env.AGENT_MAX_RETRIES ? Number(process.env.AGENT_MAX_RETRIES) : undefined;

  if (provider === "openai") {
    return {
      provider,
      compat: true,
      client: new OpenAIModelClient(model, {
        baseURL: process.env.OPENAI_BASE_URL,
        apiKey: process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY,
        timeoutMs,
        maxRetries,
      }),
    };
  }

  const sdkClient =
    timeoutMs !== undefined || maxRetries !== undefined
      ? new Anthropic({
          ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
          ...(maxRetries !== undefined ? { maxRetries } : {}),
        })
      : undefined;

  return {
    provider,
    compat: !model.startsWith("claude"),
    client: new AnthropicModelClient(model, sdkClient),
  };
}

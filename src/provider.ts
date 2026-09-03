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
 * MODEL-01b：`createModelClientWithProbe` 在 loopback / AGENT_MODEL_PROBE=1 时
 * 用轻量请求代替名称猜 compat；失败 fail-open 回退名称猜测。
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  probeEndpointCapabilities,
  type EndpointCapabilities,
} from "./model-capability.js";
import { AnthropicModelClient } from "./model-client.js";
import { OpenAIModelClient } from "./model-client-openai.js";
import { assertSafeProviderEndpoint } from "./provider-config.js";
import type { ModelClient } from "./types.js";

export interface ResolvedProvider {
  client: ModelClient;
  provider: "anthropic" | "openai";
  /** OpenAI 协议或非 claude-* 模型 → 不发 Claude 专属参数/缓存标记 */
  compat: boolean;
}

export interface ResolvedProviderWithCapabilities extends ResolvedProvider {
  capabilities: EndpointCapabilities;
}

/**
 * 端点覆盖：用于在同一进程里创建指向不同端点的第二个客户端
 * （如"执行者用本地 Ollama、verifier 用云端强模型"的跨强度核查实验）。
 */
export interface ProviderOverrides {
  provider?: "anthropic" | "openai";
  baseURL?: string;
  apiKey?: string;
  /**
   * 覆盖名称猜测的 compat（MODEL-01b 探针结果）。
   * 不传则仍按 `!model.startsWith("claude")` / openai→true。
   */
  compat?: boolean;
}

export function createModelClientFromEnv(
  model: string,
  overrides: ProviderOverrides = {},
): ResolvedProvider {
  if (!model || model.length > 200 || model !== model.trim() || /[\u0000-\u001f\u007f]/.test(model)) {
    throw new Error("AGENT_MODEL/角色模型名无效：不能为空、不能带首尾空白或控制字符，且最长 200 字符");
  }
  const rawProvider = overrides.provider ?? process.env.AGENT_PROVIDER ?? "anthropic";
  if (rawProvider !== "anthropic" && rawProvider !== "openai") {
    throw new Error('AGENT_PROVIDER 无效：只能是 "anthropic" 或 "openai"');
  }
  const provider = rawProvider;
  const timeoutMs = process.env.AGENT_TIMEOUT_MS ? Number(process.env.AGENT_TIMEOUT_MS) : undefined;
  const maxRetries = process.env.AGENT_MAX_RETRIES ? Number(process.env.AGENT_MAX_RETRIES) : undefined;

  if (provider === "openai") {
    const configuredBaseURL = overrides.baseURL ?? process.env.OPENAI_BASE_URL;
    const baseURL = configuredBaseURL?.trim() || undefined;
    assertSafeProviderEndpoint(baseURL, "OPENAI_BASE_URL");
    return {
      provider,
      compat: true,
      client: new OpenAIModelClient(model, {
        baseURL,
        apiKey: overrides.apiKey ?? process.env.OPENAI_API_KEY,
        timeoutMs,
        maxRetries,
      }),
    };
  }

  const configuredAnthropicBaseURL = overrides.baseURL ?? process.env.ANTHROPIC_BASE_URL;
  const anthropicBaseURL = configuredAnthropicBaseURL?.trim() || undefined;
  assertSafeProviderEndpoint(anthropicBaseURL, "ANTHROPIC_BASE_URL");

  const needsCustomSdk =
    timeoutMs !== undefined ||
    maxRetries !== undefined ||
    anthropicBaseURL !== undefined ||
    overrides.apiKey !== undefined;
  const sdkClient = needsCustomSdk
    ? new Anthropic({
        ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
        ...(maxRetries !== undefined ? { maxRetries } : {}),
        ...(anthropicBaseURL !== undefined ? { baseURL: anthropicBaseURL } : {}),
        ...(overrides.apiKey !== undefined ? { apiKey: overrides.apiKey } : {}),
      })
    : undefined;

  const compat = overrides.compat ?? !model.startsWith("claude");
  return {
    provider,
    compat,
    client: new AnthropicModelClient(model, sdkClient, { compat }),
  };
}

/**
 * 先探针再装配：compat 以探针为准（失败则名称猜测）。
 * 未触发探针条件时行为与 createModelClientFromEnv 一致，capabilities.source="name"。
 */
export async function createModelClientWithProbe(
  model: string,
  overrides: ProviderOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedProviderWithCapabilities> {
  const rawProvider = overrides.provider ?? env.AGENT_PROVIDER ?? "anthropic";
  if (rawProvider !== "anthropic" && rawProvider !== "openai") {
    throw new Error('AGENT_PROVIDER 无效：只能是 "anthropic" 或 "openai"');
  }
  const provider = rawProvider;
  const rawBase =
    overrides.baseURL ??
    (provider === "openai" ? env.OPENAI_BASE_URL : env.ANTHROPIC_BASE_URL);
  const baseURL = rawBase?.trim() || undefined;
  const apiKey =
    overrides.apiKey ??
    (provider === "openai" ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY);

  const capabilities = await probeEndpointCapabilities({
    identity: {
      provider,
      model,
      ...(baseURL ? { baseURL } : {}),
    },
    ...(apiKey ? { apiKey } : {}),
    env,
  });

  const resolved = createModelClientFromEnv(model, {
    ...overrides,
    ...(provider === "anthropic" ? { compat: capabilities.compat } : {}),
  });
  return { ...resolved, capabilities };
}

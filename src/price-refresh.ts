/**
 * 价表刷新：只按**具名别名**吃 LiteLLM 编译表，不把 OpenRouter 加价当官方价，
 * 也不把 deepseek-chat 映射到 deepseek-v4-*。
 *
 * LiteLLM 未列缓存价时：cacheWrite / cacheRead 按输入价登记（偏保守，不猜折扣）。
 */

import type { ModelPrice } from "./pricing.js";

export const PRICE_CACHE_FILENAME = ".agent-price-cache.json";
export const LITELLM_PRICE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export interface LitellmAlias {
  keys: readonly string[];
  model: string;
  vendor: string;
}

/** 只映射我们登记过、且能对上官方模型名的条目。 */
export const LITELLM_ALIASES: readonly LitellmAlias[] = [
  { keys: ["moonshot/kimi-k3", "kimi-k3", "moonshot/kimi-k3-preview"], model: "kimi-k3", vendor: "kimi" },
  { keys: ["openai/gpt-4.1", "gpt-4.1"], model: "gpt-4.1", vendor: "openai" },
  { keys: ["openai/gpt-4.1-mini", "gpt-4.1-mini"], model: "gpt-4.1-mini", vendor: "openai" },
  { keys: ["openai/gpt-4o-mini", "gpt-4o-mini"], model: "gpt-4o-mini", vendor: "openai" },
  { keys: ["anthropic/claude-sonnet-4-6", "claude-sonnet-4-6"], model: "claude-sonnet-4-6", vendor: "anthropic" },
  { keys: ["anthropic/claude-opus-4-8", "claude-opus-4-8"], model: "claude-opus-4-8", vendor: "anthropic" },
  { keys: ["anthropic/claude-haiku-4-5", "claude-haiku-4-5"], model: "claude-haiku-4-5", vendor: "anthropic" },
  { keys: ["deepseek/deepseek-v4-flash", "deepseek-v4-flash"], model: "deepseek-v4-flash", vendor: "deepseek" },
  { keys: ["deepseek/deepseek-v4-pro", "deepseek-v4-pro"], model: "deepseek-v4-pro", vendor: "deepseek" },
];

function per1M(perToken: unknown): number | null {
  if (typeof perToken !== "number" || !Number.isFinite(perToken) || perToken < 0) return null;
  const n = perToken * 1_000_000;
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function litellmRowToPrice(
  raw: unknown,
  model: string,
  vendor: string,
  asOf: string,
): ModelPrice | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const input = per1M(o.input_cost_per_token);
  const output = per1M(o.output_cost_per_token);
  if (input == null || output == null) return null;
  const cacheRead = per1M(o.cache_read_input_token_cost) ?? input;
  const cacheWrite = per1M(o.cache_creation_input_token_cost) ?? input;
  return {
    provider: "*",
    vendor,
    model,
    inputPer1M: input,
    outputPer1M: output,
    cacheReadPer1M: cacheRead,
    cacheWritePer1M: cacheWrite,
    source: LITELLM_PRICE_URL,
    asOf,
    note: "LiteLLM 具名别名；缓存价缺列时按输入价（不猜折扣）",
  };
}

export function applyLitellmPrices(
  catalog: unknown,
  asOf: string,
): { prices: ModelPrice[]; matched: string[]; missing: string[] } {
  if (!catalog || typeof catalog !== "object") {
    return { prices: [], matched: [], missing: LITELLM_ALIASES.map((a) => a.model) };
  }
  const bag = catalog as Record<string, unknown>;
  const prices: ModelPrice[] = [];
  const matched: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const alias of LITELLM_ALIASES) {
    if (seen.has(alias.model)) continue;
    let row: unknown;
    for (const key of alias.keys) {
      if (bag[key] != null) {
        row = bag[key];
        break;
      }
    }
    const price = litellmRowToPrice(row, alias.model, alias.vendor, asOf);
    if (!price) {
      missing.push(alias.model);
      continue;
    }
    seen.add(alias.model);
    prices.push(price);
    matched.push(alias.model);
  }
  return { prices, matched, missing };
}

export function serializePriceCache(prices: ModelPrice[], refreshedAt: string): string {
  return `${JSON.stringify({ version: 1, refreshedAt, source: LITELLM_PRICE_URL, prices }, null, 2)}\n`;
}

export function readPriceCacheMeta(text: string): { refreshedAt: string | null } {
  try {
    const parsed = JSON.parse(text) as { refreshedAt?: unknown };
    return { refreshedAt: typeof parsed.refreshedAt === "string" ? parsed.refreshedAt : null };
  } catch {
    return { refreshedAt: null };
  }
}

export async function fetchLitellmCatalog(
  fetchImpl: typeof fetch,
  url = LITELLM_PRICE_URL,
): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`价表源 ${res.status}`);
  }
  return res.json();
}

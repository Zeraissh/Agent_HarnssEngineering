/**
 * 厂家预设：填一家的 Key，就把该厂登记过的模型写进模型库。
 *
 * 价只登记有公开列价可引的条目；查不到的模型仍可接入，花费写「单价未登记」。
 * 厂家 ≠ wire 协议：DeepSeek / Kimi 都走 anthropic 兼容端点。
 */

interface CatalogModelEntry {
  id: string;
  label: string;
  provider: "anthropic" | "openai";
  model: string;
  baseUrl: string;
  apiKey: string;
}

export interface CatalogModelStore {
  schemaVersion: number;
  models: CatalogModelEntry[];
  roles: {
    executor: string | null;
    planner: string | null;
    verifier: string | null;
    vision: string | null;
    image: string | null;
  };
}

function normalizeEndpoint(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).href.replace(/\/$/, "");
  } catch {
    return raw.replace(/\/$/, "");
  }
}

export type VendorId = "deepseek" | "kimi" | "anthropic" | "openai";

export interface VendorListedModel {
  model: string;
  label: string;
  /** null = 可接入但不登记单价 */
  inputPer1M: number | null;
  outputPer1M: number | null;
  cacheReadPer1M: number | null;
  cacheWritePer1M: number | null;
  priceSource: string;
  priceAsOf: string;
}

export interface VendorPreset {
  id: VendorId;
  label: string;
  hint: string;
  provider: "anthropic" | "openai";
  baseUrl: string;
  envKey: string;
  models: readonly VendorListedModel[];
}

const DEEPSEEK_PRICE = "https://api-docs.deepseek.com/quick_start/pricing-details-usd";
const ANTHROPIC_PRICE = "https://platform.claude.com/docs/en/build-with-claude/prompt-caching";
const KIMI_K3_PRICE = "https://platform.moonshot.ai/docs/pricing/chat-k3";
const OPENAI_PRICE = "https://developers.openai.com/api/docs/pricing";

function priced(
  model: string,
  label: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  source: string,
  asOf: string,
): VendorListedModel {
  return {
    model,
    label,
    inputPer1M: input,
    outputPer1M: output,
    cacheReadPer1M: cacheRead,
    cacheWritePer1M: cacheWrite,
    priceSource: source,
    priceAsOf: asOf,
  };
}

function unpriced(model: string, label: string, source: string, asOf: string): VendorListedModel {
  return {
    model,
    label,
    inputPer1M: null,
    outputPer1M: null,
    cacheReadPer1M: null,
    cacheWritePer1M: null,
    priceSource: source,
    priceAsOf: asOf,
  };
}

export const VENDOR_PRESETS: readonly VendorPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    hint: "官方 Anthropic 兼容端点。填一把 Key，Flash / Pro / 视觉都进库。",
    provider: "anthropic",
    baseUrl: "https://api.deepseek.com/anthropic",
    envKey: "ANTHROPIC_API_KEY",
    models: [
      priced("deepseek-v4-flash", "DeepSeek V4 Flash", 0.14, 0.28, 0.0028, 0.14, DEEPSEEK_PRICE, "2026-09-03"),
      priced("deepseek-v4-pro", "DeepSeek V4 Pro", 0.435, 0.87, 0.003625, 0.435, DEEPSEEK_PRICE, "2026-09-03"),
      priced("deepseek-v4-flash-vision-exp", "DeepSeek V4 Flash 视觉", 0.14, 0.28, 0.0028, 0.14, DEEPSEEK_PRICE, "2026-09-03"),
    ],
  },
  {
    id: "kimi",
    label: "Kimi / Moonshot",
    hint: "国内站 api.moonshot.cn。K3 已登记官方美元价；K2.x 能接入但单价未登记。",
    provider: "anthropic",
    baseUrl: "https://api.moonshot.cn/anthropic",
    envKey: "ANTHROPIC_API_KEY",
    models: [
      priced("kimi-k3", "Kimi K3", 3, 15, 0.3, 3, KIMI_K3_PRICE, "2026-09-15"),
      unpriced("kimi-k2.6", "Kimi K2.6", "https://platform.moonshot.cn/docs/guide/faq", "2026-09-15"),
      unpriced("kimi-k2.7-code", "Kimi K2.7 Code", "https://platform.moonshot.cn/docs/guide/faq", "2026-09-15"),
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    hint: "官方 Claude。填 ANTHROPIC_API_KEY 或专用 Key。",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    envKey: "ANTHROPIC_API_KEY",
    models: [
      priced("claude-sonnet-4-6", "Claude Sonnet 4.6", 3, 15, 0.3, 3.75, ANTHROPIC_PRICE, "2026-09-03"),
      priced("claude-opus-4-8", "Claude Opus 4.8", 5, 25, 0.5, 6.25, ANTHROPIC_PRICE, "2026-09-03"),
      priced("claude-haiku-4-5", "Claude Haiku 4.5", 1, 5, 0.1, 1.25, ANTHROPIC_PRICE, "2026-09-03"),
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    hint: "官方 Chat Completions。填 OPENAI_API_KEY。",
    provider: "openai",
    baseUrl: "https://api.openai.com",
    envKey: "OPENAI_API_KEY",
    models: [
      priced("gpt-4.1", "GPT-4.1", 2, 8, 0.5, 2, OPENAI_PRICE, "2026-09-15"),
      priced("gpt-4.1-mini", "GPT-4.1 mini", 0.4, 1.6, 0.1, 0.4, OPENAI_PRICE, "2026-09-15"),
      priced("gpt-4o-mini", "GPT-4o mini", 0.15, 0.6, 0.075, 0.15, OPENAI_PRICE, "2026-09-15"),
    ],
  },
];

const HOST_VENDOR: Array<{ host: RegExp; id: VendorId }> = [
  { host: /(^|\.)deepseek\.com$/i, id: "deepseek" },
  { host: /(^|\.)(moonshot\.(cn|ai)|kimi\.ai)$/i, id: "kimi" },
  { host: /(^|\.)anthropic\.com$/i, id: "anthropic" },
  { host: /(^|\.)openai\.com$/i, id: "openai" },
];

/** 转售 / 聚合端点：模型名可能和官方一样，单价却不是官方价——查不到就未登记。 */
const RESELLER_HOSTS = [
  /(^|\.)siliconflow\.cn$/i,
  /(^|\.)openrouter\.ai$/i,
  /(^|\.)bigmodel\.cn$/i,
  /(^|\.)together\.ai$/i,
];

export function isKnownReseller(baseUrl: string | null | undefined): boolean {
  const raw = String(baseUrl ?? "").trim();
  if (!raw) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return RESELLER_HOSTS.some((re) => re.test(host));
  } catch {
    return false;
  }
}

export function vendorById(id: string): VendorPreset | null {
  return VENDOR_PRESETS.find((v) => v.id === id) ?? null;
}

/** 从 Base URL 认厂家。认不出就 null——不靠模型名前缀猜硅基流动这种转售。 */
export function inferVendorFromBaseUrl(baseUrl: string | null | undefined): VendorId | null {
  const raw = String(baseUrl ?? "").trim();
  if (!raw) return null;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    for (const row of HOST_VENDOR) {
      if (row.host.test(host)) return row.id;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 计价用的厂家提示：先认端点，端点空时才用模型名前缀（官方默认端点）。
 * 不把 deepseek-* 猜成硅基流动。
 */
export function inferVendorHint(baseUrl: string | null | undefined, model: string | null | undefined): string | null {
  const fromUrl = inferVendorFromBaseUrl(baseUrl);
  if (fromUrl) return fromUrl;
  if (isKnownReseller(baseUrl)) return "unlisted";
  if (baseUrl && String(baseUrl).trim()) return null;
  const name = String(model ?? "").trim().toLowerCase();
  if (name.startsWith("deepseek-")) return "deepseek";
  if (name.startsWith("kimi-")) return "kimi";
  if (name.startsWith("claude-")) return "anthropic";
  if (/^(gpt-|o1-|o3-|o4-)/.test(name)) return "openai";
  return null;
}

export function vendorLabel(id: string | null | undefined): string {
  if (!id) return "";
  return vendorById(id)?.label || id;
}

function sameVendorEndpoint(entry: CatalogModelEntry, vendor: VendorPreset): boolean {
  const listed = vendor.models.some((m) => m.model === entry.model);
  if (!listed) return false;
  if (!entry.baseUrl) return inferVendorHint("", entry.model) === vendor.id;
  return normalizeEndpoint(entry.baseUrl) === normalizeEndpoint(vendor.baseUrl)
    || inferVendorFromBaseUrl(entry.baseUrl) === vendor.id;
}

export function applyVendorPreset(
  store: CatalogModelStore,
  vendor: VendorPreset,
  apiKey: string | undefined,
  newId: () => string,
): { store: CatalogModelStore; added: number; updated: number } {
  const next: CatalogModelStore = {
    schemaVersion: store.schemaVersion,
    models: store.models.map((m) => ({ ...m })),
    roles: { ...store.roles },
  };
  let added = 0;
  let updated = 0;
  const key = apiKey === undefined ? undefined : String(apiKey);

  for (const spec of vendor.models) {
    const existing = next.models.find((m) => sameVendorEndpoint(m, vendor) && m.model === spec.model);
    if (existing) {
      existing.provider = vendor.provider;
      existing.baseUrl = vendor.baseUrl;
      if (!existing.label.startsWith("环境变量")) existing.label = spec.label;
      if (key !== undefined) existing.apiKey = key;
      updated += 1;
      continue;
    }
    const id = newId();
    next.models.push({
      id,
      label: spec.label,
      provider: vendor.provider,
      model: spec.model,
      baseUrl: vendor.baseUrl,
      apiKey: key ?? "",
    });
    added += 1;
  }

  if (!next.roles.executor) {
    const first = next.models.find((m) => sameVendorEndpoint(m, vendor));
    if (first) next.roles.executor = first.id;
  }

  return { store: next, added, updated };
}

export function vendorConnected(store: CatalogModelStore | null | undefined, vendor: VendorPreset): boolean {
  if (!store) return false;
  return store.models.some((m) => sameVendorEndpoint(m, vendor));
}

/** GET /api/vendors 出栈：不含密钥。 */
export function publicVendorCatalog(store: CatalogModelStore | null | undefined) {
  return VENDOR_PRESETS.map((v) => ({
    id: v.id,
    label: v.label,
    hint: v.hint,
    provider: v.provider,
    baseUrl: v.baseUrl,
    envKey: v.envKey,
    connected: vendorConnected(store, v),
    models: v.models.map((m) => ({
      model: m.model,
      label: m.label,
      priced: m.inputPer1M != null && m.outputPer1M != null,
      inputPer1M: m.inputPer1M,
      outputPer1M: m.outputPer1M,
      asOf: m.priceAsOf,
    })),
  }));
}

export function vendorPriceRows(): Array<{
  provider: "*";
  vendor: VendorId;
  model: string;
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M: number;
  cacheWritePer1M: number;
  source: string;
  asOf: string;
}> {
  const out = [];
  for (const vendor of VENDOR_PRESETS) {
    for (const m of vendor.models) {
      if (m.inputPer1M == null || m.outputPer1M == null || m.cacheReadPer1M == null || m.cacheWritePer1M == null) {
        continue;
      }
      out.push({
        provider: "*" as const,
        vendor: vendor.id,
        model: m.model,
        inputPer1M: m.inputPer1M,
        outputPer1M: m.outputPer1M,
        cacheReadPer1M: m.cacheReadPer1M,
        cacheWritePer1M: m.cacheWritePer1M,
        source: m.priceSource,
        asOf: m.priceAsOf,
      });
    }
  }
  return out;
}

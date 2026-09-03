/**
 * OBS-02 — 单价表与 USD 折算。
 *
 * 一条纪律压过其它所有考虑：**没登记单价就不折算，绝不猜**。
 * 未登记的模型 `usd = null`，界面写"单价未登记"，指标走
 * `agent_harness_cost_unpriced_tokens_total` 而不是往成本曲线上加 0——
 * 一个按 0 计的模型在账单来之前都长得像"不花钱"，那是最坏的一种假读数
 * （同台账 `fallbackChain: null` 与 `maxTurns: null` 的口径纪律）。
 *
 * **键为什么是 `provider/model` 且内置表一律用 `*`**：本仓的 `provider` 是
 * **wire 协议**（anthropic / openai），不是厂商——DeepSeek 两条协议都能走，
 * Kimi/GLM 也从 anthropic 兼容端点进来。拿协议当厂商去键控，同一个模型会因为
 * 换了条协议就查不到价。所以内置条目按模型名登记（`provider: "*"`），
 * 而运维覆盖表可以钉死 provider（自建网关按协议区分定价时用）。
 *
 * **单价会变，代码不会天天发版**：`AGENT_PRICE_TABLE` 指向一份 JSON，
 * 运维不发版就能改价。内置表只是"开箱有个数"，每条都带 `source` 与 `asOf`，
 * 过期与否一眼可查。
 */

export type TokenKindPrice = "inputPer1M" | "outputPer1M" | "cacheReadPer1M" | "cacheWritePer1M";

export interface ModelPrice {
  /** wire 协议限定；`*` = 不限定（内置表一律如此，见文件头） */
  provider: string;
  model: string;
  inputPer1M: number;
  outputPer1M: number;
  /** 缓存命中的输入单价。各家差异极大（0.1×~0.025× 不等），必须单列不许按比例推 */
  cacheReadPer1M: number;
  /** 缓存写入单价。Anthropic 5 分钟档 = 1.25× 输入；不单独计费的厂商填输入价 */
  cacheWritePer1M: number;
  /** provenance：这个数是从哪抄来的。没有它，半年后没人知道该不该信 */
  source: string;
  /** 抄写日期 YYYY-MM-DD */
  asOf: string;
  note?: string;
}

export interface UsageForCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export type CostReason = "ok" | "model_not_listed" | "incomplete_price" | "table_unavailable";

export interface CostResult {
  /** 折算不出来就是 null——不是 0，也不是"部分成本" */
  usd: number | null;
  reason: CostReason;
  price: ModelPrice | null;
  /** 折算不出来时这些 token 就是"没算进钱里的量"（非 cache_read 口径，同日预算） */
  unpricedTokens: number;
}

const ANTHROPIC_DOCS = "https://platform.claude.com/docs/en/build-with-claude/prompt-caching";
const DEEPSEEK_DOCS = "https://api-docs.deepseek.com/quick_start/pricing-details-usd";

/** Anthropic 家族：cacheWrite 取 5 分钟档（1.25× 输入），本 harness 用的就是 ephemeral */
function anthropic(model: string, input: number, output: number, cacheRead: number, cacheWrite: number): ModelPrice {
  return {
    provider: "*",
    model,
    inputPer1M: input,
    outputPer1M: output,
    cacheReadPer1M: cacheRead,
    cacheWritePer1M: cacheWrite,
    source: ANTHROPIC_DOCS,
    asOf: "2026-09-03",
    note: "cache write = 5 分钟档（1.25× 输入）；1 小时档为 2×，本 harness 不用",
  };
}

/**
 * DeepSeek：官方按 cache miss / cache hit 两档计输入，**不单独对缓存写入计费**，
 * 所以 cacheWrite 填与输入同价（OpenAI wire 下 `cache_creation_input_tokens` 恒 0，
 * 这个数实际不参与折算，填它只是为了不留一个含义不明的空洞）。
 * 已知不确定性：有第三方来源报 2026-08-16 起分峰谷计价（谷价约为此表 1.5×，峰价 2×）。
 * 官方文档未见该口径，故**按官方平价登记**并把分歧写在这里——真要按峰谷算，
 * 用 AGENT_PRICE_TABLE 覆盖，不要让代码去猜现在是不是峰段。
 */
function deepseek(model: string, input: number, output: number, cacheRead: number): ModelPrice {
  return {
    provider: "*",
    model,
    inputPer1M: input,
    outputPer1M: output,
    cacheReadPer1M: cacheRead,
    cacheWritePer1M: input,
    source: DEEPSEEK_DOCS,
    asOf: "2026-09-03",
    note: "官方平价；第三方报 2026-08-16 起分峰谷，官方文档未见，未采纳——需要就用 AGENT_PRICE_TABLE 覆盖",
  };
}

/**
 * 内置单价表。**只登记有公开列价可引的模型**——本仓真正跑过的那几个
 * （deepseek 三件套 + claude 家族），其余一律未登记。
 * 宁可少登记也不猜：漏一个只是界面上一句"单价未登记"，猜错一个是一个假账。
 */
export const BUILTIN_PRICE_TABLE: readonly ModelPrice[] = [
  // Anthropic —— 官方 prompt caching 文档的价目表
  anthropic("claude-opus-5", 5, 25, 0.5, 6.25),
  anthropic("claude-opus-4-8", 5, 25, 0.5, 6.25),
  anthropic("claude-opus-4-7", 5, 25, 0.5, 6.25),
  anthropic("claude-opus-4-6", 5, 25, 0.5, 6.25),
  anthropic("claude-opus-4-5", 5, 25, 0.5, 6.25),
  anthropic("claude-sonnet-5", 2, 10, 0.2, 2.5),
  anthropic("claude-sonnet-4-6", 3, 15, 0.3, 3.75),
  anthropic("claude-sonnet-4-5", 3, 15, 0.3, 3.75),
  anthropic("claude-haiku-4-5", 1, 5, 0.1, 1.25),
  // Fable / Mythos 5.1 的缓存命中是 0.025×（不是家族通用的 0.1×）——
  // 这正是"cacheRead 必须单列、不许按比例推"那条注释的现实来源
  anthropic("claude-fable-5-1", 10, 50, 0.25, 12.5),
  anthropic("claude-mythos-5-1", 10, 50, 0.25, 12.5),
  anthropic("claude-mythos-5", 10, 50, 1, 12.5),

  // DeepSeek —— 本仓日常执行 / 核查 / 视觉都在这条端点上
  deepseek("deepseek-v4-pro", 0.435, 0.87, 0.003625),
  deepseek("deepseek-v4-flash", 0.14, 0.28, 0.0028),
  deepseek("deepseek-v4-flash-vision-exp", 0.14, 0.28, 0.0028),
];

export interface PriceTable {
  /** 键 `provider/model`，全小写 */
  readonly byKey: ReadonlyMap<string, ModelPrice>;
  readonly source: "builtin" | "builtin+override";
  readonly overridePath: string | null;
  readonly entries: number;
}

function priceKey(provider: string, model: string): string {
  return `${provider.trim().toLowerCase()}/${model.trim().toLowerCase()}`;
}

const NUMERIC_FIELDS: TokenKindPrice[] = [
  "inputPer1M",
  "outputPer1M",
  "cacheReadPer1M",
  "cacheWritePer1M",
];

/**
 * 覆盖表条目校验。**缺一个价就整条拒收**，不做"缺的按 0"或"缺的按内置"——
 * 半张价目表折算出来的数字看着像钱，但它不是。拒收时报清楚是哪条、缺什么。
 */
export function parsePriceEntry(raw: unknown, index: number): ModelPrice {
  if (!raw || typeof raw !== "object") throw new Error(`价表第 ${index} 条不是对象`);
  const o = raw as Record<string, unknown>;
  const model = typeof o.model === "string" ? o.model.trim() : "";
  if (!model) throw new Error(`价表第 ${index} 条缺 model`);
  const provider = typeof o.provider === "string" && o.provider.trim() ? o.provider.trim() : "*";
  const out: Record<string, unknown> = {
    provider,
    model,
    source: typeof o.source === "string" && o.source.trim() ? o.source.trim() : "AGENT_PRICE_TABLE",
    asOf: typeof o.asOf === "string" && o.asOf.trim() ? o.asOf.trim() : "unknown",
    ...(typeof o.note === "string" ? { note: o.note } : {}),
  };
  for (const field of NUMERIC_FIELDS) {
    const v = o[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new Error(`价表条目 ${provider}/${model} 的 ${field} 必须是非负有限数字（当前 ${JSON.stringify(v)}）`);
    }
    out[field] = v;
  }
  return out as unknown as ModelPrice;
}

/** JSON 文本 → 条目数组。接受 `{version,prices:[…]}` 与裸数组两种形状 */
export function parsePriceTableJson(text: string): ModelPrice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`价表 JSON 解析失败：${(err as Error).message}`);
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { prices?: unknown })?.prices)
      ? ((parsed as { prices: unknown[] }).prices)
      : null;
  if (!rows) throw new Error('价表必须是数组，或形如 {"prices":[…]} 的对象');
  return rows.map((row, i) => parsePriceEntry(row, i));
}

export function buildPriceTable(
  overrides: readonly ModelPrice[] = [],
  overridePath: string | null = null,
): PriceTable {
  const byKey = new Map<string, ModelPrice>();
  for (const p of BUILTIN_PRICE_TABLE) byKey.set(priceKey(p.provider, p.model), p);
  // 覆盖在后：同键直接顶掉内置（运维改价的唯一手段）
  for (const p of overrides) byKey.set(priceKey(p.provider, p.model), p);
  return {
    byKey,
    source: overrides.length > 0 ? "builtin+override" : "builtin",
    overridePath,
    entries: byKey.size,
  };
}

/**
 * 读 `AGENT_PRICE_TABLE`（JSON 文件路径）。
 * **读失败就抛**：静默回退到内置表等于拿一份运维认为已经改掉的价去记账。
 * 调用方决定怎么处置（宿主的选择是"记下错误并整体停用折算"，不是崩）。
 */
export function loadPriceTable(
  env: NodeJS.ProcessEnv,
  readFileSync: (p: string) => string,
): PriceTable {
  const path = env.AGENT_PRICE_TABLE?.trim();
  if (!path) return buildPriceTable();
  let text: string;
  try {
    text = readFileSync(path);
  } catch (err) {
    throw new Error(`AGENT_PRICE_TABLE 读不到：${path}（${(err as Error).message}）`);
  }
  return buildPriceTable(parsePriceTableJson(text), path);
}

/**
 * 先查 `provider/model`，再退到通配 provider（`"*"`）下的同名模型。
 * 查不到返回 null——**不做前缀 / 模糊匹配**：`claude-opus-4-8-20260528` 猜成
 * `claude-opus-4-8` 这次恰好对，下一个带日期后缀却换了价的模型就悄悄记错账。
 */
export function lookupModelPrice(
  table: PriceTable | null,
  provider: string | null | undefined,
  model: string | null | undefined,
): ModelPrice | null {
  if (!table || !model) return null;
  if (provider) {
    const exact = table.byKey.get(priceKey(provider, model));
    if (exact) return exact;
  }
  return table.byKey.get(priceKey("*", model)) ?? null;
}

/** 非 cache_read 口径的 token 量（与日预算、TokenBurnRate 告警同口径） */
export function billableTokens(u: UsageForCost): number {
  return Math.max(0, u.inputTokens) + Math.max(0, u.outputTokens) + Math.max(0, u.cacheCreationTokens);
}

/**
 * 折算。四档单价分别乘各自的 token 数——`cacheRead` 与 `cacheWrite` 单列，
 * 拿输入价去乘缓存量会让长循环任务的账面成本翻十倍以上（cache_read 是量最大的一档）。
 */
export function computeCost(usage: UsageForCost, price: ModelPrice | null): CostResult {
  if (!price) {
    return { usd: null, reason: "model_not_listed", price: null, unpricedTokens: billableTokens(usage) };
  }
  for (const field of NUMERIC_FIELDS) {
    const v = price[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return { usd: null, reason: "incomplete_price", price, unpricedTokens: billableTokens(usage) };
    }
  }
  const usd =
    (Math.max(0, usage.inputTokens) * price.inputPer1M +
      Math.max(0, usage.outputTokens) * price.outputPer1M +
      Math.max(0, usage.cacheReadTokens) * price.cacheReadPer1M +
      Math.max(0, usage.cacheCreationTokens) * price.cacheWritePer1M) /
    1_000_000;
  return { usd, reason: "ok", price, unpricedTokens: 0 };
}

/**
 * 多角色合计。**任一角色算不出价，合计就是 null**——把能算的加起来当"本次运行
 * 成本"是partial 谎话：它长得像总额，但少了一块，而且少多少没人知道。
 * 能算的那部分仍逐角色留在 byRole 里，界面照实分开说。
 */
export function sumRunCost(
  parts: Array<{ role: string; cost: CostResult }>,
): { usd: number | null; byRole: Record<string, number>; unpricedRoles: string[]; unpricedTokens: number } {
  const byRole: Record<string, number> = {};
  const unpricedRoles: string[] = [];
  let total = 0;
  let unpricedTokens = 0;
  for (const { role, cost } of parts) {
    if (cost.usd === null) {
      if (!unpricedRoles.includes(role)) unpricedRoles.push(role);
      unpricedTokens += cost.unpricedTokens;
      continue;
    }
    byRole[role] = (byRole[role] ?? 0) + cost.usd;
    total += cost.usd;
  }
  return { usd: unpricedRoles.length > 0 ? null : total, byRole, unpricedRoles, unpricedTokens };
}

/** 界面 / 日志用的金额文案。null 一律说"单价未登记"，不许显示 $0.00 */
export function formatUsd(usd: number | null): string {
  if (usd === null) return "单价未登记";
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

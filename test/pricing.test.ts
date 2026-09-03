import { describe, expect, it } from "vitest";
import {
  BUILTIN_PRICE_TABLE,
  buildPriceTable,
  computeCost,
  formatUsd,
  loadPriceTable,
  lookupModelPrice,
  parsePriceTableJson,
  sumRunCost,
} from "../src/pricing.js";

const usage = (
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
) => ({ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens });

describe("OBS-02 · 单价表", () => {
  it("内置表每条都带 provenance，四档单价齐全且非负", () => {
    expect(BUILTIN_PRICE_TABLE.length).toBeGreaterThan(0);
    for (const p of BUILTIN_PRICE_TABLE) {
      expect(p.source, `${p.model} 缺 source`).toMatch(/^https?:\/\//);
      expect(p.asOf, `${p.model} 缺 asOf`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const f of ["inputPer1M", "outputPer1M", "cacheReadPer1M", "cacheWritePer1M"] as const) {
        expect(typeof p[f], `${p.model}.${f}`).toBe("number");
        expect(p[f]).toBeGreaterThanOrEqual(0);
      }
      // 缓存命中必须比标准输入便宜——填反了会让长循环任务的账翻十倍
      expect(p.cacheReadPer1M).toBeLessThanOrEqual(p.inputPer1M);
    }
  });

  it("查不到就是查不到：不做前缀 / 模糊匹配", () => {
    const table = buildPriceTable();
    expect(lookupModelPrice(table, "anthropic", "claude-opus-4-8")?.inputPer1M).toBe(5);
    // 带日期后缀的快照名**不匹配**——猜对一次不代表下一个也对
    expect(lookupModelPrice(table, "anthropic", "claude-opus-4-8-20260528")).toBeNull();
    expect(lookupModelPrice(table, "openai", "gpt-nonexistent")).toBeNull();
    expect(lookupModelPrice(null, "anthropic", "claude-opus-4-8")).toBeNull();
    expect(lookupModelPrice(table, "anthropic", null)).toBeNull();
    // provider 是 wire 协议不是厂商：deepseek 走哪条协议都查得到同一个价
    expect(lookupModelPrice(table, "anthropic", "deepseek-v4-pro")?.outputPer1M).toBe(0.87);
    expect(lookupModelPrice(table, "openai", "deepseek-v4-pro")?.outputPer1M).toBe(0.87);
  });

  /**
   * 这条是整个成本面的判据：**未登记 → null，绝不当 0**。
   * 按 0 计的模型在账单来之前都长得像不花钱。
   */
  it("未登记的模型：usd 为 null，且把没折算的 token 量如实报出来", () => {
    const table = buildPriceTable();
    const r = computeCost(usage(1000, 500, 200, 100), lookupModelPrice(table, "openai", "mystery-9b"));
    expect(r.usd).toBeNull();
    expect(r.reason).toBe("model_not_listed");
    expect(r.unpricedTokens).toBe(1600); // 非 cache_read 口径：1000+500+100
  });

  it("四档单价各乘各的量——拿输入价去乘 cache_read 会把长循环的账吹上天", () => {
    const price = {
      provider: "*",
      model: "m",
      inputPer1M: 5,
      outputPer1M: 25,
      cacheReadPer1M: 0.5,
      cacheWritePer1M: 6.25,
      source: "test",
      asOf: "2026-09-03",
    };
    // 1M input, 1M output, 1M cacheRead, 1M cacheWrite → 5 + 25 + 0.5 + 6.25
    const r = computeCost(usage(1_000_000, 1_000_000, 1_000_000, 1_000_000), price);
    expect(r.usd).toBeCloseTo(36.75, 9);
    expect(r.reason).toBe("ok");
    // 若 cache_read 按输入价算，同一份用量会变成 41.25——差额就是被吹出来的部分
    expect(r.usd).not.toBeCloseTo(41.25, 6);
  });

  it("单价缺一档就整条不折算（半张价目表算出来的数字长得像钱，但不是）", () => {
    const broken = { provider: "*", model: "m", inputPer1M: 1, outputPer1M: 2, source: "t", asOf: "x" };
    const r = computeCost(usage(1000, 1000), broken as never);
    expect(r.usd).toBeNull();
    expect(r.reason).toBe("incomplete_price");
  });

  it("多角色合计：任一角色算不出价 → 合计 null，但能算的仍逐角色照实说", () => {
    const ok = { usd: 0.25, reason: "ok" as const, price: null, unpricedTokens: 0 };
    const bad = { usd: null, reason: "model_not_listed" as const, price: null, unpricedTokens: 900 };
    const mixed = sumRunCost([
      { role: "execution", cost: ok },
      { role: "verification", cost: bad },
    ]);
    expect(mixed.usd).toBeNull();
    expect(mixed.byRole).toEqual({ execution: 0.25 });
    expect(mixed.unpricedRoles).toEqual(["verification"]);
    expect(mixed.unpricedTokens).toBe(900);

    const clean = sumRunCost([
      { role: "execution", cost: ok },
      { role: "planner", cost: { ...ok, usd: 0.75 } },
    ]);
    expect(clean.usd).toBeCloseTo(1, 9);
  });

  it("AGENT_PRICE_TABLE：覆盖顶掉内置价；条目缺字段整条拒收并指名道姓", () => {
    const json = JSON.stringify({
      version: 1,
      prices: [
        {
          provider: "*",
          model: "claude-opus-4-8",
          inputPer1M: 1,
          outputPer1M: 2,
          cacheReadPer1M: 0.1,
          cacheWritePer1M: 1.25,
          source: "内部协议价",
          asOf: "2026-09-01",
        },
      ],
    });
    const table = loadPriceTable({ AGENT_PRICE_TABLE: "/prices.json" } as NodeJS.ProcessEnv, () => json);
    expect(table.source).toBe("builtin+override");
    expect(lookupModelPrice(table, "anthropic", "claude-opus-4-8")?.inputPer1M).toBe(1);
    // 未被覆盖的条目仍在
    expect(lookupModelPrice(table, "anthropic", "deepseek-v4-flash")?.inputPer1M).toBe(0.14);

    expect(() => parsePriceTableJson('[{"model":"x","inputPer1M":1}]')).toThrow(/outputPer1M/);
    expect(() => parsePriceTableJson('[{"inputPer1M":1}]')).toThrow(/缺 model/);
    expect(() => parsePriceTableJson("not json")).toThrow(/JSON 解析失败/);
    expect(() => parsePriceTableJson('{"nope":1}')).toThrow(/必须是数组/);
  });

  it("读不到价表就抛——静默退回内置表 = 拿运维已经改掉的价去记账", () => {
    expect(() =>
      loadPriceTable({ AGENT_PRICE_TABLE: "/nope.json" } as NodeJS.ProcessEnv, () => {
        throw new Error("ENOENT");
      }),
    ).toThrow(/AGENT_PRICE_TABLE 读不到/);
    // 没配就是内置表，不抛
    expect(loadPriceTable({} as NodeJS.ProcessEnv, () => "").source).toBe("builtin");
  });

  it("formatUsd：null 一律写「单价未登记」，永远不显示 $0.00 冒充", () => {
    expect(formatUsd(null)).toBe("单价未登记");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.00012345)).toBe("$0.0001");
    expect(formatUsd(1.239)).toBe("$1.24");
  });
});

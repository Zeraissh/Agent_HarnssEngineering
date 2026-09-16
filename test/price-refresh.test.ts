import { describe, expect, it } from "vitest";
import { applyLitellmPrices, litellmRowToPrice } from "../src/price-refresh.js";

describe("价表刷新", () => {
  it("只吃具名别名，不把 deepseek-chat 映射到 v4", () => {
    const catalog = {
      "deepseek/deepseek-chat": {
        input_cost_per_token: 0.00000014,
        output_cost_per_token: 0.00000028,
      },
      "moonshot/kimi-k3": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        cache_read_input_token_cost: 0.0000003,
      },
    };
    const { prices, matched, missing } = applyLitellmPrices(catalog, "2026-09-15");
    expect(matched).toContain("kimi-k3");
    expect(matched).not.toContain("deepseek-chat");
    expect(prices.find((p) => p.model === "kimi-k3")?.inputPer1M).toBeCloseTo(3, 9);
    expect(prices.find((p) => p.model.startsWith("deepseek-v4"))).toBeUndefined();
    expect(missing).toContain("gpt-4.1");
  });

  it("缺数字的行整条丢掉，不猜价", () => {
    expect(litellmRowToPrice({ output_cost_per_token: 0.00001 }, "x", "openai", "2026-09-15")).toBeNull();
    expect(litellmRowToPrice({ input_cost_per_token: -1, output_cost_per_token: 1 }, "x", "openai", "d")).toBeNull();
  });
});

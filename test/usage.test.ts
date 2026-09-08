import { describe, expect, it } from "vitest";
import { aggregateUsage, parseLedgerLines } from "../ui/usage.js";

describe("parseLedgerLines", () => {
  it("跳过半截行，收下合法对象", () => {
    const rows = parseLedgerLines('{"at":1,"model":"a"}\nnot-json\n{"at":2}\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.model).toBe("a");
  });
});

describe("aggregateUsage", () => {
  it("未登记单价与 0 元分开", () => {
    const report = aggregateUsage([
      { at: Date.parse("2026-09-01T10:00:00"), model: "flash", turns: 3, cost: { usd: 0 } },
      { at: Date.parse("2026-09-01T12:00:00"), model: "pro", turns: 5, cost: null },
      { at: Date.parse("2026-09-02T09:00:00"), model: "flash", turns: 2, cost: { usd: 0.12 } },
    ]);
    expect(report.totalRuns).toBe(3);
    expect(report.totalTurns).toBe(10);
    expect(report.totalUsd).toBeCloseTo(0.12);
    expect(report.unpricedRuns).toBe(1);
    const flash = report.byModel.find((r) => r.model === "flash");
    expect(flash?.runs).toBe(2);
    expect(flash?.usd).toBeCloseTo(0.12);
    expect(flash?.unpricedRuns).toBe(0);
    const pro = report.byModel.find((r) => r.model === "pro");
    expect(pro?.usd).toBeNull();
    expect(pro?.unpricedRuns).toBe(1);
    expect(report.byDay[0]?.day).toBe("2026-09-02");
  });

  it("空台账不是 0 元", () => {
    expect(aggregateUsage([])).toEqual({
      totalRuns: 0,
      totalTurns: 0,
      totalUsd: null,
      unpricedRuns: 0,
      byDay: [],
      byModel: [],
    });
  });
});

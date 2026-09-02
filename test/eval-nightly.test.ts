import { describe, expect, it } from "vitest";
import {
  cellsFromAbLog,
  compareNightly,
  summarizeCells,
  type NightlyBaseline,
  type NightlyCellSummary,
} from "../eval/compare-baseline.js";
import { parseTokenCap, wouldExceedOrMeetCap } from "../eval/token-cap.js";

describe("parseTokenCap", () => {
  it("accepts positive integers", () => {
    expect(parseTokenCap("1000")).toBe(1000);
    expect(parseTokenCap(" 42.9 ")).toBe(42);
  });
  it("rejects empty / non-positive / NaN", () => {
    expect(parseTokenCap(undefined)).toBeUndefined();
    expect(parseTokenCap("")).toBeUndefined();
    expect(parseTokenCap("0")).toBeUndefined();
    expect(parseTokenCap("-5")).toBeUndefined();
    expect(parseTokenCap("nope")).toBeUndefined();
  });
});

describe("wouldExceedOrMeetCap", () => {
  it("is inert without a cap", () => {
    expect(wouldExceedOrMeetCap(1e9, 1e9, undefined)).toBe(false);
  });
  it("trips when spent+next >= cap", () => {
    expect(wouldExceedOrMeetCap(90, 10, 100)).toBe(true);
    expect(wouldExceedOrMeetCap(99, 0, 100)).toBe(false);
    expect(wouldExceedOrMeetCap(100, 0, 100)).toBe(true);
    expect(wouldExceedOrMeetCap(50, 20, 100)).toBe(false);
  });
});

const BASE: NightlyBaseline = {
  version: 1,
  cases: ["write-basic", "sum-numbers"],
  arms: ["baseline"],
  minPassRate: 0.8,
  caseMinPassRate: { "write-basic": 1 },
  maxTotalTokens: 10_000,
  maxTotalWallMs: 60_000,
};

function cell(
  caseId: string,
  arm: string,
  pass: number,
  reps: number,
  tokens = 100,
  wallMs = 1000,
): NightlyCellSummary {
  return { caseId, arm, pass, reps, tokens, wallMs };
}

describe("compareNightly", () => {
  it("passes a complete green matrix", () => {
    const cells = [
      cell("write-basic", "baseline", 1, 1, 500, 2000),
      cell("sum-numbers", "baseline", 1, 1, 500, 2000),
    ];
    const r = compareNightly(cells, BASE);
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.observed.passRate).toBe(1);
  });

  it("fails on missing cell", () => {
    const r = compareNightly([cell("write-basic", "baseline", 1, 1)], BASE);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("missing cell: sum-numbers"))).toBe(true);
  });

  it("fails on passRate floor", () => {
    const cells = [
      cell("write-basic", "baseline", 1, 1),
      cell("sum-numbers", "baseline", 0, 1),
    ];
    // overall 0.5 < 0.8; write-basic still 1.0
    const r = compareNightly(cells, BASE);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.startsWith("passRate"))).toBe(true);
  });

  it("fails on caseMinPassRate", () => {
    const cells = [
      cell("write-basic", "baseline", 0, 1),
      cell("sum-numbers", "baseline", 1, 1),
    ];
    const r = compareNightly(cells, { ...BASE, minPassRate: 0 });
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("write-basic"))).toBe(true);
  });

  it("fails on token / wall ceilings", () => {
    const cells = [
      cell("write-basic", "baseline", 1, 1, 9000, 1000),
      cell("sum-numbers", "baseline", 1, 1, 2000, 1000),
    ];
    const r = compareNightly(cells, BASE);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("totalTokens"))).toBe(true);
  });
});

describe("cellsFromAbLog + summarizeCells", () => {
  it("aggregates reps for the same case×arm", () => {
    const cells = cellsFromAbLog([
      { case: "a", arm: "baseline", pass: true, tokens: 10, wallMs: 100 },
      { case: "a", arm: "baseline", pass: false, tokens: 20, wallMs: 200 },
      { case: "b", arm: "baseline", pass: true, tokens: 5, wallMs: 50 },
    ]);
    expect(cells).toHaveLength(2);
    const a = cells.find((c) => c.caseId === "a")!;
    expect(a.pass).toBe(1);
    expect(a.reps).toBe(2);
    expect(a.tokens).toBe(30);
    const s = summarizeCells(cells);
    expect(s.passRate).toBeCloseTo(2 / 3);
    expect(s.completedCells).toBe(2);
  });
});

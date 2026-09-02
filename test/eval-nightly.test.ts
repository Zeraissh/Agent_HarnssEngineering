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

describe("checked-in baselines (EVAL-03c)", () => {
  it("nightly and release share the same case×arm matrix", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const nightly = JSON.parse(
      await readFile(resolve("eval/baselines/nightly.json"), "utf8"),
    ) as NightlyBaseline;
    const release = JSON.parse(
      await readFile(resolve("eval/baselines/release.json"), "utf8"),
    ) as NightlyBaseline;
    expect(nightly.version).toBe(1);
    expect(release.version).toBe(1);
    expect(release.cases).toEqual(nightly.cases);
    expect(release.arms).toEqual(nightly.arms);
    // Release must not be looser than nightly on quality/cost/latency.
    expect(release.minPassRate).toBeGreaterThanOrEqual(nightly.minPassRate);
    expect(release.maxTotalTokens ?? Infinity).toBeLessThanOrEqual(
      nightly.maxTotalTokens ?? Infinity,
    );
    expect(release.maxTotalWallMs ?? Infinity).toBeLessThanOrEqual(
      nightly.maxTotalWallMs ?? Infinity,
    );
    // Evidence-backed floors after nightly #33646201722 (6/6 @ 52k / 28s).
    expect(nightly.minPassRate).toBe(1);
    expect(nightly.maxTotalTokens).toBe(150_000);
    expect(nightly.maxTotalWallMs).toBe(300_000);
    for (const id of nightly.cases) {
      expect(nightly.caseMinPassRate?.[id]).toBe(1);
      expect(release.caseMinPassRate?.[id]).toBe(1);
    }
  });

  it("post-evidence floors reject the pre-tighten ceilings", () => {
    const floors: NightlyBaseline = {
      version: 1,
      cases: [
        "ho-write-marker",
        "ho-arith-product",
        "ho-pkg-name",
        "ho-count-md",
        "ho-pkg-license",
        "ho-filter-h2",
      ],
      arms: ["baseline"],
      minPassRate: 1,
      maxTotalTokens: 150_000,
      maxTotalWallMs: 300_000,
    };
    // Old loose ceilings (0.8 / 400k / 30min) would have passed a 5/6 + 200k run;
    // new floors must fail both miss and token blow-up.
    const almost = [
      cell("ho-write-marker", "baseline", 1, 1, 20_000, 5_000),
      cell("ho-arith-product", "baseline", 1, 1, 20_000, 5_000),
      cell("ho-pkg-name", "baseline", 1, 1, 20_000, 5_000),
      cell("ho-count-md", "baseline", 1, 1, 20_000, 5_000),
      cell("ho-pkg-license", "baseline", 1, 1, 20_000, 5_000),
      cell("ho-filter-h2", "baseline", 0, 1, 20_000, 5_000),
    ];
    expect(compareNightly(almost, floors).ok).toBe(false);
    const bloated = almost.map((c) =>
      c.caseId === "ho-filter-h2"
        ? { ...c, pass: 1, tokens: 100_000 }
        : { ...c, tokens: 20_000 },
    );
    // 200k tokens > 150k ceiling
    expect(compareNightly(bloated, floors).ok).toBe(false);
    expect(
      compareNightly(
        bloated.map((c) => ({ ...c, tokens: 8_000, wallMs: 4_000, pass: 1 })),
        floors,
      ).ok,
    ).toBe(true);
  });
});

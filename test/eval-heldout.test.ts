/**
 * EVAL-01 held-out registry locks.
 * Instrument only — do not retune prompts to chase these scores in the same change.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cases, type EvalCase } from "../eval/cases.js";
import {
  HELDOUT_ALL_IDS,
  HELDOUT_NIGHTLY_IDS,
  heldoutCases,
  resolveHeldoutCases,
} from "../eval/cases-heldout.js";
import type { NightlyBaseline } from "../eval/compare-baseline.js";
import { resolveAbSuite } from "../eval/suite.js";

describe("EVAL-01 held-out suite", () => {
  it("has 20–50 cases with unique ho- ids", () => {
    expect(heldoutCases.length).toBeGreaterThanOrEqual(20);
    expect(heldoutCases.length).toBeLessThanOrEqual(50);
    const ids = heldoutCases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith("ho-")).toBe(true);
  });

  it("does not share ids with the research suite", () => {
    const research = new Set(cases.map((c) => c.id));
    for (const id of HELDOUT_ALL_IDS) {
      expect(research.has(id)).toBe(false);
    }
  });

  it("nightly subset is exactly six known held-out cases", () => {
    expect(HELDOUT_NIGHTLY_IDS).toHaveLength(6);
    for (const id of HELDOUT_NIGHTLY_IDS) {
      expect(heldoutCases.some((c) => c.id === id)).toBe(true);
    }
  });

  it("resolveHeldoutCases fails closed on unknown ids", () => {
    expect(() => resolveHeldoutCases(["ho-write-marker", "nope"])).toThrow(/unknown/);
    expect(resolveHeldoutCases(["ho-write-marker"])).toHaveLength(1);
  });

  it("AB_SUITE selects research vs heldout vs all", () => {
    const research: EvalCase[] = [
      { id: "r1", covers: "r", task: "t", check: async () => ({ pass: true, note: "" }) },
    ];
    const heldout: EvalCase[] = [
      { id: "ho-a", covers: "h", task: "t", check: async () => ({ pass: true, note: "" }) },
    ];
    expect(resolveAbSuite("research", research, heldout).map((c) => c.id)).toEqual(["r1"]);
    expect(resolveAbSuite("heldout", research, heldout).map((c) => c.id)).toEqual(["ho-a"]);
    expect(resolveAbSuite("all", research, heldout).map((c) => c.id).sort()).toEqual([
      "ho-a",
      "r1",
    ]);
    expect(resolveAbSuite(undefined, research, heldout).map((c) => c.id)).toEqual(["r1"]);
    expect(resolveAbSuite("nope", research, heldout).map((c) => c.id)).toEqual(["r1"]);
  });

  it("checked-in baselines track held-out nightly ids", async () => {
    const nightly = JSON.parse(
      await readFile(resolve("eval/baselines/nightly.json"), "utf8"),
    ) as NightlyBaseline;
    const release = JSON.parse(
      await readFile(resolve("eval/baselines/release.json"), "utf8"),
    ) as NightlyBaseline;
    expect(nightly.cases).toEqual([...HELDOUT_NIGHTLY_IDS]);
    expect(release.cases).toEqual([...HELDOUT_NIGHTLY_IDS]);
    expect(release.minPassRate).toBeGreaterThanOrEqual(nightly.minPassRate);
  });

  it("covers required surfaces (edit/multi/recovery/permission/mcp-absent)", () => {
    const blob = heldoutCases.map((c) => `${c.id} ${c.covers} ${c.task}`).join("\n");
    expect(blob).toMatch(/ho-write-/);
    expect(blob).toMatch(/ho-multi-|two-titles|alpha\.txt/);
    expect(blob).toMatch(/fallback|missing/);
    expect(blob).toMatch(/escape|圈禁|workdir/);
    expect(blob).toMatch(/mcp|tools-absent/);
  });
});

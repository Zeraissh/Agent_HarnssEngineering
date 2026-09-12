// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  changedLineCoverage,
  coverageInclude,
  parseLcov,
  parseUnifiedDiff,
} from "../scripts/changed-line-coverage.mjs";

const lcov = [
  "SF:src/foo.ts",
  "DA:10,3",
  "DA:11,0",
  "DA:12,1",
  "end_of_record",
  "SF:ui/server.ts",
  "DA:20,8",
  "end_of_record",
].join("\n");

describe("TEST-01 changed-line coverage", () => {
  it("只收 src/ 与 ui 根下的 .ts，不收 public / test", () => {
    expect(coverageInclude("src/loop.ts")).toBe(true);
    expect(coverageInclude("ui/server.ts")).toBe(true);
    expect(coverageInclude("ui/history.ts")).toBe(true);
    expect(coverageInclude("ui/public/app.js")).toBe(false);
    expect(coverageInclude("test/loop.test.ts")).toBe(false);
    expect(coverageInclude("scripts/changed-line-coverage.mjs")).toBe(false);
  });

  it("unified diff 只把 + 行记到新文件行号", () => {
    const diff = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -10,2 +10,3 @@",
      " keep",
      "+added",
      " also",
    ].join("\n");
    const map = parseUnifiedDiff(diff);
    expect([...map.get("src/foo.ts")!].sort()).toEqual([11]);
  });

  it("改到的 DA 行 hit>0 通过；hit=0 失败", () => {
    const ok = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -10,0 +10,1 @@",
      "+covered",
    ].join("\n");
    expect(changedLineCoverage({ lcovText: lcov, diffText: ok })).toMatchObject({
      ok: true,
      checked: 1,
    });

    const bad = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -11,0 +11,1 @@",
      "+uncovered",
    ].join("\n");
    const report = changedLineCoverage({ lcovText: lcov, diffText: bad });
    expect(report.ok).toBe(false);
    expect(report.uncovered).toEqual([{ file: "src/foo.ts", line: 11, hits: 0 }]);
  });

  it("没有 DA 的行（注释/空行）不算未覆盖；不在 include 里的文件忽略", () => {
    const diff = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -99,0 +99,1 @@",
      "+// comment only",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,0 +1,1 @@",
      "+docs",
    ].join("\n");
    expect(changedLineCoverage({ lcovText: lcov, diffText: diff })).toMatchObject({
      ok: true,
      checked: 0,
      skippedUninstrumented: 1,
    });
  });

  it("改了 src 文件但 lcov 里没有这份 → fail-closed", () => {
    const diff = [
      "--- a/src/new-file.ts",
      "+++ b/src/new-file.ts",
      "@@ -0,0 +1,1 @@",
      "+export const x = 1;",
    ].join("\n");
    const report = changedLineCoverage({ lcovText: lcov, diffText: diff });
    expect(report.ok).toBe(false);
    expect(report.missingFiles).toEqual(["src/new-file.ts"]);
  });

  it("parseLcov 认 Windows 路径分隔", () => {
    const win = parseLcov("SF:D:\\repo\\src\\foo.ts\nDA:3,2\nend_of_record\n");
    expect(win.get("D:/repo/src/foo.ts")?.get(3)).toBe(2);
  });
});

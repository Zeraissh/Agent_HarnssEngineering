import { describe, expect, it } from "vitest";
import {
  COMPACT_LEDGER_MARKER,
  emptyCompactLedger,
  extractConstraintsFromText,
  extractDecisionsFromText,
  extractFromToolExchange,
  formatCompactLedger,
  formatSemanticPlaceholder,
  ledgerEntryCount,
  mergeCompactLedgers,
  parseCompactLedgerText,
} from "../src/compact-ledger.js";

describe("compact-ledger pure helpers (MEM-01)", () => {
  it("extracts user constraints (zh/en)", () => {
    const text = [
      "任务说明",
      "必须使用 bit 12 作为 CRCEN",
      "不得 flash 用户备份区",
      "Acceptance: must not reset the board",
    ].join("\n");
    const c = extractConstraintsFromText(text);
    expect(c.some((x) => /bit 12|CRCEN/i.test(x))).toBe(true);
    expect(c.some((x) => /不得 flash|must not reset/i.test(x))).toBe(true);
  });

  it("extracts assistant decisions", () => {
    const d = extractDecisionsFromText("分析后决定采用曼哈顿分层布线。\nAlso decided to keep via count ≤ 80.");
    expect(d.length).toBeGreaterThan(0);
    expect(d.some((x) => /曼哈顿|via count/i.test(x))).toBe(true);
  });

  it("extracts write_file side-effect + failure from tool exchange", () => {
    const ok = extractFromToolExchange(
      { name: "write_file", input: { path: "src/crc.c", content: "..." } },
      "Wrote 128 bytes to src/crc.c",
      false,
    );
    expect(ok.sideEffects).toContain("write_file src/crc.c");
    expect(ok.evidence.some((e) => /Wrote 128 bytes/.test(e))).toBe(true);

    const fail = extractFromToolExchange(
      { name: "bash", input: { command: "rm -rf build && cmake --build build" } },
      "Error: LIBUSB_ERROR_ACCESS\nprobe busy",
      true,
    );
    expect(fail.failures.some((f) => /LIBUSB_ERROR_ACCESS/.test(f))).toBe(true);
    expect(fail.sideEffects.some((s) => /bash:/.test(s))).toBe(true);
  });

  it("format/parse round-trip preserves buckets", () => {
    const ledger = mergeCompactLedgers(emptyCompactLedger(), {
      constraints: ["必须 ERC=0"],
      decisions: ["决定采用 structured planner"],
      failures: ["bash: denied"],
      evidence: ["0x7189AAB5"],
      sideEffects: ["write_file report.md"],
    });
    const text = formatCompactLedger(ledger);
    expect(text.startsWith(COMPACT_LEDGER_MARKER)).toBe(true);
    const parsed = parseCompactLedgerText(text);
    expect(parsed).toEqual(ledger);
    expect(ledgerEntryCount(parsed)).toBe(5);
  });

  it("semantic placeholder keeps local residue and stays marked compacted", () => {
    const text = formatSemanticPlaceholder({
      originalChars: 2400,
      toolName: "bash",
      local: {
        ...emptyCompactLedger(),
        failures: ["bash: timeout"],
        evidence: ["0x08000000"],
        sideEffects: ["bash: cmake --build ."],
      },
    });
    expect(text.startsWith("[compacted]")).toBe(true);
    expect(text).toContain("failure: bash: timeout");
    expect(text).toContain("evidence: 0x08000000");
    expect(text).toContain("side-effect: bash: cmake --build .");
  });

  it("变异锁：空解析不得发明事实（假绿=parse 恒返回样例）", () => {
    expect(parseCompactLedgerText("no marker here")).toEqual(emptyCompactLedger());
    expect(ledgerEntryCount(parseCompactLedgerText("no marker here"))).toBe(0);
  });
});

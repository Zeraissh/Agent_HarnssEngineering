import { describe, expect, it } from "vitest";
import {
  COMPACT_LEDGER_MARKER,
  EXCERPT_MAX_CHARS,
  countLines,
  emptyCompactLedger,
  excerptToolResult,
  extractConstraintsFromText,
  extractDecisionsFromText,
  extractFromToolExchange,
  formatCompactLedger,
  formatSemanticPlaceholder,
  ledgerEntryCount,
  mergeCompactLedgers,
  parseCompactLedgerText,
  parseSemanticPlaceholderExcerpt,
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
      narrative: "assistant weighed Manhattan vs free-angle",
    });
    const text = formatCompactLedger(ledger);
    expect(text.startsWith(COMPACT_LEDGER_MARKER)).toBe(true);
    expect(text).toContain("summary:");
    const parsed = parseCompactLedgerText(text);
    expect(parsed.constraints).toEqual(ledger.constraints);
    expect(parsed.decisions).toEqual(ledger.decisions);
    expect(parsed.failures).toEqual(ledger.failures);
    expect(parsed.evidence).toEqual(ledger.evidence);
    expect(parsed.sideEffects).toEqual(ledger.sideEffects);
    expect(parsed.narrative).toBe(ledger.narrative);
    expect(ledgerEntryCount(parsed)).toBe(5);
  });

  it("semantic placeholder keeps local residue and stays marked compacted", () => {
    const text = formatSemanticPlaceholder({
      originalChars: 2400,
      originalLines: 3,
      toolName: "bash",
      excerpt: "FILE-001 :: the lighthouse keeper counted thirty-seven gulls at dawn :: code M519",
      local: {
        ...emptyCompactLedger(),
        failures: ["bash: timeout"],
        evidence: ["0x08000000"],
        sideEffects: ["bash: cmake --build ."],
      },
    });
    expect(text.startsWith("[compacted]")).toBe(true);
    expect(text.split("\n")[0]).toContain("was 2400 chars, 3 lines");
    expect(text).toContain("tool: bash");
    expect(text).toContain("excerpt: FILE-001 :: the lighthouse keeper counted thirty-seven gulls at dawn :: code M519");
    expect(text).toContain("failure: bash: timeout");
    expect(text).toContain("evidence: 0x08000000");
    expect(text).toContain("side-effect: bash: cmake --build .");
    // 老调用方（不传摘录 / 行数）仍合法：没有 excerpt 行，头部形状不变
    const legacy = formatSemanticPlaceholder({ originalChars: 2400, local: emptyCompactLedger() });
    expect(legacy.split("\n")[0]).toBe("[compacted] semantic elision (was 2400 chars). Re-run the tool if you need full output.");
    expect(legacy).not.toContain("excerpt:");
  });

  /**
   * 2026-09-03 真机：反应式压缩救回 987k 超长请求，但 72 个占位符里没有一个字的原文——
   * 模型只能 `read_file limit=1` 补读 72 次（8 轮）。摘录行就是为了让"这次读到了什么"不用重跑。
   */
  describe("excerptToolResult：原文首行摘录（≤100 字符）", () => {
    it("取首个非空行，空白折叠；空串 → 空", () => {
      expect(excerptToolResult("\n\n  FILE-001 :: the   lighthouse\tkeeper :: code M519\nsecond line")).toBe(
        "FILE-001 :: the lighthouse keeper :: code M519",
      );
      expect(excerptToolResult("")).toBe("");
      expect(excerptToolResult("\n \n")).toBe("");
    });

    it("超过 100 字符截到恰好 100，末位省略号；恰好 100 不截", () => {
      const long = "L".repeat(300);
      const cut = excerptToolResult(long);
      expect(cut.length).toBe(EXCERPT_MAX_CHARS);
      expect(cut.endsWith("…")).toBe(true);
      expect(cut.startsWith("L".repeat(99))).toBe(true);
      expect(excerptToolResult("E".repeat(100))).toBe("E".repeat(100));
    });

    it("is_error 时优先取像错误的那一行（错误不在首行的形状）；没有就退回首行", () => {
      const out = "Command output:\n\nError: LIBUSB_ERROR_ACCESS probe held by PID 4242\nretrying…";
      expect(excerptToolResult(out, true)).toBe("Error: LIBUSB_ERROR_ACCESS probe held by PID 4242");
      // 非错误结果里即使有 "error" 字样也不挑——首行才是"读到了什么"
      expect(excerptToolResult(out, false)).toBe("Command output:");
      expect(excerptToolResult("denied: write outside workdir\nx", true)).toBe("denied: write outside workdir");
      expect(excerptToolResult("just text\nnothing alarming here", true)).toBe("just text");
    });

    it("含 [compact_ledger] 字面量时打断它——摘录会进 text 块，原样放进去整块会被当账本改写", () => {
      const ex = excerptToolResult(`export const COMPACT_LEDGER_MARKER = "${COMPACT_LEDGER_MARKER}";`);
      expect(ex).not.toContain(COMPACT_LEDGER_MARKER);
      expect(ex).toContain("compact_ledger");
    });

    it("countLines：末尾一个换行不多算；CRLF 同款；空串 0", () => {
      expect(countLines("a\nb\nc")).toBe(3);
      expect(countLines("a\nb\nc\n")).toBe(3);
      expect(countLines("a\r\nb\r\n")).toBe(2);
      expect(countLines("single")).toBe(1);
      expect(countLines("")).toBe(0);
    });
  });

  describe("parseSemanticPlaceholderExcerpt：折叠时把摘录取回来", () => {
    it("round-trip：format 写进去的摘录原样取回；摘录里有换行 / 多余空白也被归一", () => {
      const text = formatSemanticPlaceholder({
        originalChars: 640,
        originalLines: 2,
        toolName: "read_file",
        excerpt: "FILE-007 :: the archive   basement floods :: code R302",
        local: emptyCompactLedger(),
      });
      expect(parseSemanticPlaceholderExcerpt(text)).toBe("FILE-007 :: the archive basement floods :: code R302");
    });

    it("本版之前写下的占位符（没有 excerpt 行）→ undefined；非占位符文本即使含 'excerpt:' 也不认", () => {
      const legacy = formatSemanticPlaceholder({ originalChars: 640, toolName: "bash", local: emptyCompactLedger() });
      expect(parseSemanticPlaceholderExcerpt(legacy)).toBeUndefined();
      expect(parseSemanticPlaceholderExcerpt("plain tool output\nexcerpt: not a placeholder")).toBeUndefined();
      expect(parseSemanticPlaceholderExcerpt("[compacted] x\nexcerpt:   ")).toBeUndefined();
    });

    it("变异锁：格式化时丢掉摘录行 → 取回为空（摘录不是可选装饰，它就是这次读到的事实）", () => {
      const text = formatSemanticPlaceholder({
        originalChars: 640,
        toolName: "read_file",
        excerpt: "FILE-001 :: code M519",
        local: emptyCompactLedger(),
      });
      const lines = text.split("\n");
      expect(lines.filter((l) => l.startsWith("excerpt: "))).toHaveLength(1);
      expect(parseSemanticPlaceholderExcerpt(text)).toBe("FILE-001 :: code M519");
    });
  });

  it("变异锁：空解析不得发明事实（假绿=parse 恒返回样例）", () => {
    expect(parseCompactLedgerText("no marker here")).toEqual(emptyCompactLedger());
    expect(ledgerEntryCount(parseCompactLedgerText("no marker here"))).toBe(0);
  });
});

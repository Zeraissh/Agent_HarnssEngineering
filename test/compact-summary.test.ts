import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { COMPACT_LEDGER_MARKER, emptyCompactLedger, parseCompactLedgerText } from "../src/compact-ledger.js";
import {
  collectCompactExcerpts,
  mergeSummaryIntoLedger,
  parseCompactSummaryResponse,
  summarizeForCompact,
} from "../src/compact-summary.js";
import { DefaultContextManager } from "../src/context.js";
import { AgentLoop } from "../src/loop.js";
import type { ModelClient, ModelRequest, ModelTurn } from "../src/types.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock, toolUseBlock } from "./helpers.js";

const usage = (n: number) =>
  ({ input_tokens: n, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }) as Anthropic.Usage;

function bigToolResultMsg(id: string, chars = 2000): Anthropic.MessageParam {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "x".repeat(chars) }],
  };
}

describe("compact-summary pure helpers (MEM-01 Phase B)", () => {
  it("parses additive JSON and clips narrative", () => {
    const parsed = parseCompactSummaryResponse(`{
      "constraints": ["prefer DAPLink over ST-Link"],
      "decisions": [],
      "failures": [],
      "evidence": ["0x08000042"],
      "sideEffects": [],
      "narrative": "${"n".repeat(500)}"
    }`);
    expect(parsed).not.toBeNull();
    expect(parsed!.additions.constraints).toContain("prefer DAPLink over ST-Link");
    expect(parsed!.additions.evidence).toContain("0x08000042");
    expect(parsed!.narrative!.length).toBeLessThanOrEqual(400);
  });

  it("reject empty / non-JSON fail-open to null", () => {
    expect(parseCompactSummaryResponse("")).toBeNull();
    expect(parseCompactSummaryResponse("sorry I cannot")).toBeNull();
    expect(parseCompactSummaryResponse('{"constraints":[],"decisions":[]}')).toBeNull();
  });

  it("mergeSummaryIntoLedger unions buckets and never drops Phase A facts", () => {
    const base = {
      ...emptyCompactLedger(),
      constraints: ["必须 ERC=0"],
      sideEffects: ["write_file a.sch"],
    };
    const merged = mergeSummaryIntoLedger(base, {
      additions: {
        ...emptyCompactLedger(),
        constraints: ["prefer soft reset"],
        decisions: ["decided to keep via ≤ 80"],
      },
      narrative: "assistant reasoned about routing without keyword hits",
    });
    expect(merged.constraints).toEqual(expect.arrayContaining(["必须 ERC=0", "prefer soft reset"]));
    expect(merged.sideEffects).toContain("write_file a.sch");
    expect(merged.decisions.some((d) => /via/.test(d))).toBe(true);
    expect(merged.narrative).toMatch(/assistant reasoned/);
  });

  it("变异锁：若用摘要桶替换 Phase A 桶，本测试必须红", () => {
    const base = {
      ...emptyCompactLedger(),
      constraints: ["必须保留 Phase A 约束"],
      evidence: ["0xDEAD"],
    };
    const merged = mergeSummaryIntoLedger(base, {
      additions: { ...emptyCompactLedger(), decisions: ["only from summary"] },
    });
    expect(merged.constraints).toContain("必须保留 Phase A 约束");
    expect(merged.evidence).toContain("0xDEAD");
    expect(merged.decisions).toContain("only from summary");
  });

  it("collectCompactExcerpts skips ledger/placeholder and respects budget", () => {
    const text = collectCompactExcerpts([
      { role: "user", text: "[compact_ledger]\nconstraints:\n- x" },
      { role: "assistant", text: "Long reasoning without decision keywords: " + "a".repeat(200) },
      { role: "user", text: "[compacted] elided" },
    ]);
    expect(text).toContain("Long reasoning");
    expect(text).not.toContain("[compact_ledger]");
    expect(text).not.toContain("[compacted]");
  });
});

describe("compactAsync + FakeModelClient (MEM-01 Phase B)", () => {
  it("default OFF path: no summary client → Phase A only, summaryApplied false", async () => {
    const m = new DefaultContextManager({
      systemPrompt: "frozen",
      maxTokens: 8000,
      effort: "high",
      contextTokenLimit: 1000,
      protectRecent: 1,
    });
    m.noteUsage(usage(900));
    const out = await m.compactAsync([
      { role: "user", content: "必须使用 DAPLink" },
      bigToolResultMsg("tu", 800),
      { role: "user", content: "end" },
    ]);
    expect(out.droppedBlocks).toBe(1);
    expect(out.summaryApplied).toBe(false);
    expect(JSON.stringify(out.messages)).toContain(COMPACT_LEDGER_MARKER);
  });

  it("summary merges into ledger and sets summaryApplied", async () => {
    const summaryClient = new FakeModelClient([
      fakeMessage(
        [
          textBlock(
            JSON.stringify({
              constraints: ["prefer soft-reset before flash"],
              decisions: ["chose Manhattan layering after weighing via count"],
              failures: [],
              evidence: [],
              sideEffects: [],
              narrative: "assistant spent many tokens weighing layering options",
            }),
          ),
        ],
        "end_turn",
      ),
    ]);
    const m = new DefaultContextManager({
      systemPrompt: "frozen",
      maxTokens: 8000,
      effort: "high",
      contextTokenLimit: 1000,
      protectRecent: 1,
      summaryClient,
      summaryMaxTokens: 256,
    });
    m.noteUsage(usage(900));
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: "Task note without keyword hits: keep the netlist baseline intact.",
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text:
              "After comparing fanout vs serial, I am leaning toward Manhattan layering " +
              "because via count stays under eighty. " +
              "a".repeat(200),
          },
          toolUseBlock("tu", "reader", {}),
        ],
      },
      bigToolResultMsg("tu", 900),
      { role: "user", content: "continue" },
    ];
    const out = await m.compactAsync(messages);
    expect(out.droppedBlocks).toBe(1);
    expect(out.summaryApplied).toBe(true);
    expect(summaryClient.requests).toHaveLength(1);
    expect(summaryClient.requests[0]!.tools).toEqual([]);
    expect(summaryClient.requests[0]!.maxTokens).toBe(256);
    expect(summaryClient.requests[0]!.toolChoice).toBe("none");

    const flat = JSON.stringify(out.messages);
    expect(flat).toContain(COMPACT_LEDGER_MARKER);
    expect(flat).toMatch(/Manhattan|soft-reset|via count|layering/i);
    const ledgerMsg = out.messages.find((msg) => JSON.stringify(msg).includes(COMPACT_LEDGER_MARKER))!;
    const ledgerText =
      typeof ledgerMsg.content === "string"
        ? ledgerMsg.content
        : (ledgerMsg.content as Anthropic.TextBlockParam[]).map((b) => ("text" in b ? b.text : "")).join("\n");
    const parsed = parseCompactLedgerText(ledgerText);
    expect(parsed.decisions.some((d) => /Manhattan|via/i.test(d))).toBe(true);
    expect(parsed.narrative).toMatch(/assistant spent/i);
  });

  it("fail-open: summary throw keeps Phase A ledger and summaryApplied false", async () => {
    class BoomClient implements ModelClient {
      send(_req: ModelRequest): Promise<ModelTurn> {
        throw new Error("summary endpoint down");
      }
    }
    const m = new DefaultContextManager({
      systemPrompt: "frozen",
      maxTokens: 8000,
      effort: "high",
      contextTokenLimit: 1000,
      protectRecent: 0,
      summaryClient: new BoomClient(),
    });
    m.noteUsage(usage(900));
    const out = await m.compactAsync([
      { role: "user", content: "必须 ERC=0" },
      {
        role: "assistant",
        content: [toolUseBlock("tu", "write_file", { path: "a.sch", content: "x" })],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu",
            content: `Wrote 1 bytes to a.sch\n${"z".repeat(700)}`,
          },
        ],
      },
    ]);
    expect(out.droppedBlocks).toBe(1);
    expect(out.summaryApplied).toBe(false);
    expect(out.ledgerEntries).toBeGreaterThan(0);
    expect(JSON.stringify(out.messages)).toMatch(/必须 ERC=0|write_file a\.sch/);
  });

  it("AgentLoop emits summaryApplied on compaction when Phase B succeeds", async () => {
    const summaryClient = new FakeModelClient(
      Array.from({ length: 8 }, () =>
        fakeMessage(
          [
            textBlock(
              JSON.stringify({
                constraints: [],
                decisions: ["decided to keep reading"],
                failures: [],
                evidence: [],
                sideEffects: [],
              }),
            ),
          ],
          "end_turn",
        ),
      ),
    );
    // Enough tool rounds that messages leave the default protectRecent=6 window
    // (same shape as Phase A AgentLoop compaction integration).
    const loopModel = new FakeModelClient([
      ...Array.from({ length: 5 }, (_, i) =>
        fakeMessage([toolUseBlock(`tu_${i}`, "reader", {})], "tool_use", { input_tokens: 5000 }),
      ),
      fakeMessage([textBlock("done")], "end_turn", { input_tokens: 5000 }),
    ]);
    const loop = new AgentLoop(
      {
        systemPrompt: "frozen",
        tools: [
          makeTool({
            name: "reader",
            execute: async () => ({ content: "y".repeat(3000) }),
          }),
        ],
        workdir: process.cwd(),
        contextTokenLimit: 5000,
        compactSummaryClient: summaryClient,
      },
      loopModel,
    );

    const events = [];
    for await (const e of loop.run("go")) events.push(e);
    const compactions = events.filter((e) => e.type === "compaction");
    expect(compactions.length).toBeGreaterThan(0);
    expect(compactions.some((c) => c.type === "compaction" && c.summaryApplied === true)).toBe(true);
    expect(summaryClient.requests.length).toBeGreaterThan(0);
  });
});

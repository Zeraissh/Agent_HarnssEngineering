import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunHistoryWriter, readArchivedTrace } from "../ui/history.js";
import {
  endSpan,
  exportRedactedTrace,
  hashPayload,
  hashToolSchemas,
  parseTraceJsonl,
  playbackSummary,
  projectTurnEventToSpans,
  redactValue,
  resolveGitCommit,
  startSpan,
  type TraceSpan,
} from "../src/trace.js";

describe("OBS-01 trace core", () => {
  it("redacts secret keys and hashes stable payloads", () => {
    const red = redactValue({ api_key: "sk-secret", nested: { Authorization: "Bearer x" }, ok: 1 });
    expect(red).toEqual({ api_key: "[redacted]", nested: { Authorization: "[redacted]" }, ok: 1 });
    expect(hashPayload({ b: 1, a: 2 })).toBe(hashPayload({ a: 2, b: 1 }));
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
  });

  it("hashes tool schemas by name order", () => {
    const h1 = hashToolSchemas([
      { name: "b", inputSchema: { type: "object" } },
      { name: "a", inputSchema: { type: "object" } },
    ]);
    const h2 = hashToolSchemas([
      { name: "a", inputSchema: { type: "object" } },
      { name: "b", inputSchema: { type: "object" } },
    ]);
    expect(h1).toBe(h2);
  });

  it("projects tool_call/result and done into spans", () => {
    const open = new Map<string, TraceSpan>();
    const call = projectTurnEventToSpans({
      runId: "r1",
      source: "main",
      parentSpanId: "root",
      openTools: open,
      event: {
        type: "tool_call",
        toolUseId: "t1",
        name: "bash",
        input: { command: "echo hi", api_key: "nope" },
      },
    });
    expect(call).toHaveLength(1);
    expect(call[0]!.kind).toBe("tool");
    expect(call[0]!.status).toBe("running");
    expect(String(call[0]!.attrs.inputHash)).toMatch(/^[a-f0-9]{64}$/);
    expect(open.size).toBe(1);

    const result = projectTurnEventToSpans({
      runId: "r1",
      source: "main",
      parentSpanId: "root",
      openTools: open,
      event: {
        type: "tool_result",
        toolUseId: "t1",
        durationMs: 12,
        result: { content: "hi", isError: false },
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("ok");
    expect(open.size).toBe(0);

    const done = projectTurnEventToSpans({
      runId: "r1",
      source: "main",
      parentSpanId: "root",
      openTools: open,
      event: {
        type: "done",
        result: {
          stopReason: "completed",
          messages: [],
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            turns: 2,
            cacheHitRatio: 0,
          },
        } as any,
      },
    });
    expect(done[0]!.kind).toBe("segment");
    expect(done[0]!.status).toBe("ok");
  });

  it("exportRedactedTrace + playbackSummary round-trip", () => {
    const span = endSpan(
      startSpan({ kind: "run", name: "run", runId: "r", attrs: { token: "secret-value" } }),
      "ok",
    );
    const exported = exportRedactedTrace([span]);
    expect(exported.spans[0]!.attrs.token).toBe("[redacted]");
    const summary = playbackSummary([span]);
    expect(summary.byKind.run).toBe(1);
    expect(summary.errors).toEqual([]);
  });

  it("parseTraceJsonl skips corrupt lines", () => {
    const good = startSpan({ kind: "model", name: "api_retry", runId: "r" });
    const text = `${JSON.stringify(good)}\n{not json\n`;
    expect(parseTraceJsonl(text)).toHaveLength(1);
  });

  it("resolveGitCommit reads AGENT_GIT_COMMIT first", () => {
    expect(resolveGitCommit({ AGENT_GIT_COMMIT: "abc123" })).toBe("abc123");
    expect(resolveGitCommit({})).toBeNull();
  });

  it("RunHistoryWriter persists trace.jsonl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trace-"));
    const w = new RunHistoryWriter(dir);
    const span = startSpan({ kind: "run", name: "run", runId: "r1" });
    w.appendTraceSpan(span);
    await w.flush();
    const rows = await readArchivedTrace(dir);
    expect(rows).toHaveLength(1);
    expect((rows[0] as TraceSpan).spanId).toBe(span.spanId);
    const raw = await readFile(join(dir, "trace.jsonl"), "utf8");
    expect(raw).toContain('"kind":"run"');
  });
});

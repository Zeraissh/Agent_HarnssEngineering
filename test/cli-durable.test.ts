import { describe, expect, it } from "vitest";
import {
  extractPendingToolUses,
  planMidToolReplay,
} from "../src/mid-tool-replay.js";
import { canonicalInputHash, type DurableToolTx } from "../src/tool-tx.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCliDurable } from "../src/cli-durable.js";

describe("mid-tool replay", () => {
  it("replays idempotent prepared write_file; fail-closes bash; skips committed", () => {
    const input = { path: "a.txt", content: "x" };
    const hash = canonicalInputHash(input);
    const toolTx: DurableToolTx[] = [
      {
        idempotencyKey: "run1:tu_w",
        toolUseId: "tu_w",
        name: "write_file",
        inputHash: hash,
        status: "prepared",
        retryPolicy: "idempotent_retry",
        preparedAt: 1,
        updatedAt: 1,
      },
      {
        idempotencyKey: "run1:tu_b",
        toolUseId: "tu_b",
        name: "bash",
        inputHash: canonicalInputHash({ command: "echo hi" }),
        status: "running",
        retryPolicy: "fail_closed_no_retry",
        preparedAt: 1,
        updatedAt: 2,
      },
      {
        idempotencyKey: "run1:tu_c",
        toolUseId: "tu_c",
        name: "write_file",
        inputHash: canonicalInputHash({ path: "b.txt", content: "y" }),
        status: "committed",
        retryPolicy: "idempotent_retry",
        preparedAt: 1,
        updatedAt: 3,
        resultContent: "wrote b.txt",
      },
    ];
    const plan = planMidToolReplay({
      runId: "run1",
      pendingToolUses: [
        { id: "tu_w", name: "write_file", input },
        { id: "tu_b", name: "bash", input: { command: "echo hi" } },
        { id: "tu_c", name: "write_file", input: { path: "b.txt", content: "y" } },
      ],
      toolTx,
    });
    expect(plan).toEqual([
      expect.objectContaining({ action: "replay", toolUseId: "tu_w" }),
      expect.objectContaining({ action: "synthesize_error", toolUseId: "tu_b" }),
      expect.objectContaining({ action: "skip_committed", toolUseId: "tu_c", content: "wrote b.txt" }),
    ]);
  });

  it("extractPendingToolUses reads assistant tool_use blocks", () => {
    const pending = extractPendingToolUses({
      role: "assistant",
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", id: "1", name: "bash", input: { command: "true" } },
      ],
    } as never);
    expect(pending).toEqual([{ id: "1", name: "bash", input: { command: "true" } }]);
  });
});

describe("CLI durable", () => {
  it("writes state.json with toolTx on notify", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cli-durable-"));
    try {
      const handle = createCliDurable({
        runId: "cli-test-1",
        historyRoot: root,
      });
      expect(handle.getState().phase).toBe("executing");
      await handle.toolTx.notify("prepared", {
        idempotencyKey: "cli-test-1:tu1",
        toolUseId: "tu1",
        name: "write_file",
        inputHash: "abc",
        status: "prepared",
        retryPolicy: "idempotent_retry",
        preparedAt: Date.now(),
        updatedAt: Date.now(),
      });
      // writer 链是异步的——稍等
      await new Promise((r) => setTimeout(r, 50));
      handle.markCompleted();
      await new Promise((r) => setTimeout(r, 50));
      const raw = await readFile(path.join(root, "cli-test-1", "state.json"), "utf8");
      const state = JSON.parse(raw) as { phase: string; toolTx: unknown[] };
      expect(state.toolTx.length).toBe(1);
      expect(state.phase).toBe("completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

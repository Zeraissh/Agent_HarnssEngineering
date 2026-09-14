/**
 * D2 设计门面档案诚实 + D6 在飞列表清 stopReason + D9 transcript/recap。
 * FakeModelClient only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiServer, type UiServerHandle } from "../ui/server.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock } from "./helpers.js";
import { resetObservabilityMetrics } from "../src/metrics.js";
import { clearCapabilityCache } from "../src/model-capability.js";
import type { ModelClient, ModelRequest, ModelTurn } from "../src/types.js";

let handle: UiServerHandle | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  resetObservabilityMetrics();
  clearCapabilityCache();
});

async function startServer(): Promise<string> {
  const port = await new Promise<number>((ok, reject) => {
    handle!.server.listen(0, "127.0.0.1", () => {
      const addr = handle!.server.address();
      if (addr && typeof addr === "object") ok(addr.port);
      else reject(new Error("no address"));
    });
  });
  return `http://127.0.0.1:${port}`;
}

async function waitForDone(base: string, runId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const list = (await (await fetch(`${base}/api/runs`)).json()) as { runId: string; status: string }[];
    if (list.find((r) => r.runId === runId)?.status === "done") return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Run ${runId} did not finish`);
}

async function waitForRow(
  base: string,
  runId: string,
  pred: (row: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const list = (await (await fetch(`${base}/api/runs`)).json()) as Record<string, unknown>[];
    const row = list.find((r) => r.runId === runId);
    if (row && pred(row)) return row;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Run ${runId} did not match`);
}

describe("D2 设计门面档案", () => {
  it("meta.mode 仍是 single；facade+designRoute 在档案与追问后列表可见", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "design-face-"));
    const history = await mkdtemp(join(tmpdir(), "design-hist-"));
    tempDirs.push(workdir, history);
    handle = createUiServer({
      modelClient: new FakeModelClient([
        fakeMessage([textBlock("First design page is ready.")], "end_turn"),
        fakeMessage([textBlock("Follow-up still the same landing.")], "end_turn"),
      ]),
      tools: [makeTool({ name: "noop", permission: "auto", parallelSafe: true })],
      workdir,
      history,
    });
    const base = await startServer();
    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "做一页产品规格落地页",
        mode: "design",
        designId: "pm-spec",
      }),
    });
    expect(created.status).toBe(200);
    const { runId } = (await created.json()) as { runId: string };
    await waitForDone(base, runId);

    const first = await waitForRow(base, runId, (r) => r.status === "done");
    expect(first.mode).toBe("design");
    expect(first.facade).toBe("design");
    expect(first.designRoute).toMatchObject({ id: "pm-spec" });

    const meta = JSON.parse(await readFile(join(history, runId, "meta.json"), "utf8")) as {
      mode: string;
      facade?: string;
      designRoute?: { id?: string };
    };
    expect(meta.mode).toBe("single");
    expect(meta.facade).toBe("design");
    expect(meta.designRoute?.id).toBe("pm-spec");

    const follow = await fetch(`${base}/api/runs/${runId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "再改一版标题" }),
    });
    expect(follow.status).toBe(200);
    const live = await waitForRow(base, runId, (r) => r.conversationTurn === 2);
    expect(live.mode).toBe("single");
    expect(live.facade).toBe("design");
    expect(live.designRoute).toMatchObject({ id: "pm-spec" });
    await waitForDone(base, runId);
    const after = await waitForRow(base, runId, (r) => r.status === "done" && r.conversationTurn === 2);
    expect(after.mode).toBe("single");
    expect(after.facade).toBe("design");
    expect(after.designRoute).toMatchObject({ id: "pm-spec" });
    expect(after.recap).toMatch(/Follow-up still the same landing/);
  });
});

describe("D6 在飞列表清上一轮终止因", () => {
  it("追问 running 时 stopReason/finalPassed 为空，上一轮进 lastStopReason", async () => {
    const dir = await mkdtemp(join(tmpdir(), "list-stale-"));
    tempDirs.push(dir);
    let release!: () => void;
    const held = new Promise<void>((ok) => {
      release = ok;
    });
    let n = 0;
    const script = [
      fakeMessage([textBlock("Turn one unique recap.")], "end_turn"),
      fakeMessage([textBlock("Turn two unique recap.")], "end_turn"),
    ];
    const model: ModelClient = {
      async send(req: ModelRequest): Promise<ModelTurn> {
        n += 1;
        if (n === 2) await held;
        const message = script[n - 1];
        if (!message) throw new Error(`script exhausted at ${n}`);
        return { message, stopReason: message.stop_reason, usage: message.usage };
      },
    };
    handle = createUiServer({
      modelClient: model,
      tools: [makeTool({ name: "noop", permission: "auto", parallelSafe: true })],
      workdir: dir,
    });
    const base = await startServer();
    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "先做完第一轮" }),
    });
    const { runId } = (await created.json()) as { runId: string };
    await waitForDone(base, runId);
    const doneRow = await waitForRow(base, runId, (r) => r.status === "done");
    expect(doneRow.stopReason).toBe("completed");

    const mid = await fetch(`${base}/api/runs/${runId}/transcript`);
    const midBody = (await mid.json()) as { sealedOnly?: boolean; segments: unknown[] };
    expect(midBody.sealedOnly).toBe(true);
    expect(midBody.segments.length).toBeGreaterThan(0);

    const follow = await fetch(`${base}/api/runs/${runId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "第二轮开始" }),
    });
    expect(follow.status).toBe(200);
    const running = await waitForRow(
      base,
      runId,
      (r) => r.status === "running" && r.conversationTurn === 2,
    );
    expect(running.stopReason).toBeNull();
    expect(running.finalPassed).toBeNull();
    expect(running.verdictTurn).toBeNull();
    expect(running.lastStopReason).toBe("completed");

    const liveTranscript = (await (await fetch(`${base}/api/runs/${runId}/transcript`)).json()) as {
      sealedOnly?: boolean;
      segments: unknown[];
    };
    expect(liveTranscript.sealedOnly).toBe(true);

    release();
    await waitForDone(base, runId);
    const again = await waitForRow(base, runId, (r) => r.status === "done" && r.conversationTurn === 2);
    expect(again.stopReason).toBe("completed");
    expect(again.recap).toMatch(/Turn two unique recap/);
  });
});

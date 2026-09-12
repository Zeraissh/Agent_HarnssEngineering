import { afterEach, describe, expect, it } from "vitest";
import { createUiServer, type UiServerHandle } from "../ui/server.js";
import { FIX_THEN_VERIFY } from "../src/handoff.js";
import { PROPOSE_HANDOFF_TOOL_NAME } from "../src/tools/propose-handoff.js";
import type { ModelClient, ModelRequest, ModelTurn } from "../src/types.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock, toolUseBlock } from "./helpers.js";
import type Anthropic from "@anthropic-ai/sdk";

function startServer(handle: UiServerHandle): Promise<number> {
  return new Promise((resolve, reject) => {
    handle.server.listen(0, () => {
      const addr = handle.server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("Could not get server port"));
    });
    handle.server.on("error", reject);
  });
}

/** 脚本用尽后一律 end_turn，避免子 run 把未处理拒绝抛到测试进程 */
class PaddingModelClient implements ModelClient {
  readonly inner: FakeModelClient;
  constructor(script: Anthropic.Message[]) {
    this.inner = new FakeModelClient(script);
  }
  send(req: ModelRequest): Promise<ModelTurn> {
    const before = this.inner.requests.length;
    try {
      return this.inner.send(req);
    } catch (err) {
      if (err instanceof Error && err.message.includes("script exhausted")) {
        const message = fakeMessage([textBlock("pad")], "end_turn");
        return Promise.resolve({ message, stopReason: message.stop_reason, usage: message.usage });
      }
      throw err;
    } finally {
      void before;
    }
  }
}

async function waitForEvent(
  base: string,
  runId: string,
  predicate: (e: Record<string, unknown>) => boolean,
  timeoutMs = 8000,
): Promise<Record<string, unknown> | undefined> {
  const res = await fetch(`${base}/api/runs/${runId}/events`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: false }>((r) =>
          setTimeout(() => r({ value: undefined, done: false }), 80),
        ),
      ]);
      if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines: string[] = [];
        let eventName = "message";
        for (const line of block.split("\n")) {
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          else if (line.startsWith("event:")) eventName = line.slice(6).trim();
        }
        if (dataLines.length === 0 || eventName !== "message") continue;
        const ev = JSON.parse(dataLines.join("\n")) as { event?: Record<string, unknown> };
        if (predicate(ev)) return ev;
      }
      if (chunk.done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return undefined;
}

async function waitForDone(base: string, runId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/runs`);
    const list: { runId: string; status: string }[] = await res.json();
    if (list.find((r) => r.runId === runId)?.status === "done") return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Run ${runId} did not finish in time`);
}

function eventOf(frame: Record<string, unknown> | undefined): Record<string, unknown> {
  return (frame?.event ?? {}) as Record<string, unknown>;
}

const proposeThenClose: Anthropic.Message[] = [
  fakeMessage(
    [
      toolUseBlock("tu_h", PROPOSE_HANDOFF_TOOL_NAME, {
        handoff: FIX_THEN_VERIFY,
        summary: "main.c:27 除零，CFSR 对得上",
      }),
    ],
    "tool_use",
  ),
  fakeMessage([textBlock("根因已记下，报告写在 crc.md")], "end_turn"),
];

describe("下一步提议（不挡对话）", () => {
  let handle: UiServerHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function startDebugRun(script: Anthropic.Message[] = proposeThenClose) {
    const model = new PaddingModelClient(script);
    handle = createUiServer({
      modelClient: model,
      tools: [
        makeTool({ name: "noop", permission: "auto" }),
        makeTool({ name: "stall", permission: "ask" }),
      ],
      workdir: process.cwd(),
    });
    const base = `http://127.0.0.1:${await startServer(handle)}`;
    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "查板上 CRC 为什么是 0",
        pack: "stm32-debug",
        verify: false,
      }),
    });
    expect(created.status).toBe(200);
    const { runId } = (await created.json()) as { runId: string };
    const proposal = await waitForEvent(
      base,
      runId,
      (e) => eventOf(e).type === "handoff_proposal",
    );
    expect(proposal, "应收到 handoff_proposal").toBeTruthy();
    return { base, runId, proposal };
  }

  it("工具记下提议后对话继续，列表能看见待确认的下一步", async () => {
    const { base, runId, proposal } = await startDebugRun();
    expect(eventOf(proposal).summary).toContain("除零");
    expect(String(eventOf(proposal).label)).not.toMatch(/stm32-coding|stm32-debug|切包/);

    await waitForDone(base, runId);
    const list = (await (await fetch(`${base}/api/runs`)).json()) as Array<{
      runId: string;
      status: string;
      awaitingHandoff: { summary: string } | null;
    }>;
    const row = list.find((r) => r.runId === runId);
    expect(row?.status).toBe("done");
    expect(row?.awaitingHandoff?.summary).toContain("除零");
  });

  it("调试还在跑时同意被拒绝——探针可能还占着", async () => {
    const { base, runId } = await startDebugRun([
      fakeMessage(
        [
          toolUseBlock("tu_h", PROPOSE_HANDOFF_TOOL_NAME, {
            handoff: FIX_THEN_VERIFY,
            summary: "main.c:27 除零，CFSR 对得上",
          }),
        ],
        "tool_use",
      ),
      fakeMessage([toolUseBlock("tu_stall", "stall", {})], "tool_use"),
      fakeMessage([textBlock("收口")], "end_turn"),
    ]);
    await waitForEvent(base, runId, (e) => eventOf(e).type === "approval_request");
    const tooSoon = await fetch(`${base}/api/runs/${runId}/handoff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "accept" }),
    });
    expect(tooSoon.status).toBe(409);
    expect(await tooSoon.text()).toContain("等这次调试结束再换段");
  });

  it("结束后拒绝只撤卡，不开新 run", async () => {
    const { base, runId } = await startDebugRun();
    await waitForDone(base, runId);
    const before = ((await (await fetch(`${base}/api/runs`)).json()) as { runId: string }[]).length;
    const res = await fetch(`${base}/api/runs/${runId}/handoff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "decline" }),
    });
    expect(res.status).toBe(200);
    const again = await fetch(`${base}/api/runs/${runId}/handoff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "decline" }),
    });
    expect(again.status).toBe(409);
    const list = (await (await fetch(`${base}/api/runs`)).json()) as Array<{
      runId: string;
      awaitingHandoff: unknown;
    }>;
    expect(list).toHaveLength(before);
    expect(list.find((r) => r.runId === runId)?.awaitingHandoff).toBeNull();
  });

  it("结束后同意开一场注入计划：改固件再复测，跳过确认门", async () => {
    const { base, runId } = await startDebugRun();
    await waitForDone(base, runId);
    const res = await fetch(`${base}/api/runs/${runId}/handoff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "accept" }),
    });
    expect(res.status).toBe(200);
    const { runId: childId } = (await res.json()) as { runId: string };
    expect(childId).toBeTruthy();
    expect(childId).not.toBe(runId);

    const planFrame = await waitForEvent(
      base,
      childId,
      (e) => eventOf(e).type === "plan",
    );
    const plan = eventOf(planFrame);
    expect(plan.gated).toBe(false);
    const subs = plan.subtasks as Array<{ id: string; pack: string; dependsOn: string[] }>;
    expect(subs.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(subs[0]!.pack).toBe("stm32-coding");
    expect(subs[1]!.pack).toBe("stm32-debug");
    expect(subs[1]!.dependsOn).toEqual(["s1"]);

    const parentList = (await (await fetch(`${base}/api/runs`)).json()) as Array<{
      runId: string;
      awaitingHandoff: unknown;
    }>;
    expect(parentList.find((r) => r.runId === runId)?.awaitingHandoff).toBeNull();
  });
});

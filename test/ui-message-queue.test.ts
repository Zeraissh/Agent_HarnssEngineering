/**
 * 信息队列·server 层契约测试（独立文件，不动 ui-server.test.ts）。
 *
 * 覆盖（委托方："可以选择插队重新让 agent 重新思考，或者等待队列结束后再发送"）：
 *   · 运行中 POST /api/runs/:id/messages 不再 409：
 *     - mode:"steer" → 202 + message_queued(steer) 事件 + loop 下一次模型请求带新指令
 *     - mode:"queue"（缺省）→ 202 + 本轮结束后拼成一条自动续跑（消息不丢）
 *   · 运行结束后 steeringQueue 余量并入自动续跑
 *   · DELETE /api/runs/:id/queue 清空排队（单条 index / 整队）
 *   · mode 校验：非法值 400
 *   · rebuildMessageQueue：崩溃恢复从事件重放重建队列
 *
 * 全用注入的假模型（GatedModelClient：第一次 send 吊住，构造"运行中"窗口）。
 */
import { afterEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createUiServer,
  rebuildMessageQueue,
  type UiServerHandle,
} from "../ui/server.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock, toolUseBlock } from "./helpers.js";
import type { ModelClient, ModelRequest, ModelTurn } from "../src/types.js";

// ------------------------------------------------------------------ helpers

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 8000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(40);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/**
 * 第一次 send 吊住的假模型：给测试一个稳定的"运行中"窗口来发插队/排队请求。
 * release() 放行后按脚本吐响应。
 */
class GatedModelClient implements ModelClient {
  requests: ModelRequest[] = [];
  private index = 0;
  private gateResolve: (() => void) | null = null;
  private gate: Promise<void> | null = null;

  constructor(private readonly script: Anthropic.Message[]) {}

  /** 吊住第 1 次 send（拿到请求之后、返回响应之前） */
  holdFirstCall(): void {
    this.gate = new Promise<void>((resolve) => {
      this.gateResolve = resolve;
    });
  }

  release(): void {
    this.gateResolve?.();
  }

  async send(req: ModelRequest): Promise<ModelTurn> {
    this.requests.push(structuredClone(req));
    this.index += 1;
    const message = this.script[this.index - 1];
    if (!message) throw new Error(`GatedModelClient script exhausted at call ${this.index}`);
    if (this.index === 1 && this.gate) await this.gate;
    return { message, stopReason: message.stop_reason, usage: message.usage };
  }
}

/** 连接事件流（先重放缓冲再收实时），直到谓词命中；超时返回 undefined */
async function waitForEvent(
  base: string,
  runId: string,
  predicate: (ev: Record<string, unknown>, seen: Record<string, unknown>[]) => boolean,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>[] | undefined> {
  const res = await fetch(`${base}/api/runs/${runId}/events`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const seen: Record<string, unknown>[] = [];
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: false }>((r) =>
          setTimeout(() => r({ value: undefined, done: false }), 100),
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
        const ev = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
        seen.push(ev);
        if (predicate(ev, seen)) return seen;
      }
      if (chunk.done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return undefined;
}

const eventOf = (ev: Record<string, unknown>) =>
  (ev.event ?? {}) as Record<string, unknown>;

async function createRun(base: string, task: string): Promise<string> {
  const res = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { runId: string };
  return body.runId;
}

async function postMessage(
  base: string,
  runId: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/runs/${runId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ------------------------------------------------------------------ tests

describe("信息队列 · 运行中发消息", () => {
  let handle: UiServerHandle | undefined;
  let workdir: string | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    if (workdir) await rm(workdir, { recursive: true, force: true });
    workdir = undefined;
  });

  it("mode=steer：202 + message_queued(steer) 事件 + 指令注入下一次模型请求", async () => {
    const model = new GatedModelClient([
      fakeMessage([toolUseBlock("tu_1", "ping", {})], "tool_use"),
      fakeMessage([textBlock("收到，按新方向来")], "end_turn"),
    ]);
    model.holdFirstCall();
    workdir = await mkdtemp(join(tmpdir(), "agent-queue-"));
    handle = createUiServer({
      modelClient: model,
      tools: [makeTool({ name: "ping" })],
      workdir,
    });
    const base = `http://127.0.0.1:${await startServer(handle)}`;

    const runId = await createRun(base, "先调查一下");
    await waitFor(() => model.requests.length === 1, 8000, "first model call in flight");

    const steer = await postMessage(base, runId, { text: "别调查了，直接写结论", mode: "steer" });
    expect(steer.status).toBe(202);
    expect(steer.body).toMatchObject({ runId, mode: "steer", queued: 1 });

    model.release();
    // 第二轮模型调用发生（插队指令注入后）
    await waitFor(() => model.requests.length === 2, 8000, "second model call");
    const secondReq = model.requests[1]!;
    const last = secondReq.messages.at(-1)!;
    expect(last.role).toBe("user");
    const text = (last.content as Anthropic.ContentBlockParam[])
      .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    expect(text).toContain("别调查了，直接写结论");

    // 事件流：message_queued(steer) 与 steering 都在 durable 流里（重放可得）
    let sawSteering = false;
    const events = await waitForEvent(base, runId, (ev, seen) => {
      if (eventOf(ev).type === "steering" && eventOf(ev).text === "别调查了，直接写结论") {
        sawSteering = true;
      }
      return sawSteering && seen.some((e) => eventOf(e).type === "run_end");
    });
    expect(events, "steering 事件与 run_end 都应在事件流里").toBeDefined();
    const queued = events!.filter((e) => eventOf(e).type === "message_queued");
    expect(queued).toHaveLength(1);
    expect(eventOf(queued[0]!)).toMatchObject({ mode: "steer", text: "别调查了，直接写结论" });
  });

  it("mode=queue（缺省）：202 + 本轮结束后拼成一条自动续跑，队列清空有事件", async () => {
    const model = new GatedModelClient([
      fakeMessage([textBlock("第一轮完成")], "end_turn"),
      fakeMessage([textBlock("第二轮完成")], "end_turn"),
    ]);
    model.holdFirstCall();
    workdir = await mkdtemp(join(tmpdir(), "agent-queue-"));
    handle = createUiServer({ modelClient: model, tools: [], workdir });
    const base = `http://127.0.0.1:${await startServer(handle)}`;

    const runId = await createRun(base, "跑一个长任务");
    await waitFor(() => model.requests.length === 1, 8000, "first model call in flight");

    const q1 = await postMessage(base, runId, { text: "排队指令A", mode: "queue" });
    expect(q1.status).toBe(202);
    expect(q1.body).toMatchObject({ mode: "queue", queued: 1 });
    // 不带 mode = 缺省 queue
    const q2 = await postMessage(base, runId, { text: "排队指令B" });
    expect(q2.status).toBe(202);
    expect(q2.body).toMatchObject({ mode: "queue", queued: 2 });

    model.release();
    // 等第二轮（自动续跑）的 user_message：两条排队消息拼成一条（'\n\n' 连接）
    const combined = "排队指令A\n\n排队指令B";
    let runEnds = 0;
    const events = await waitForEvent(
      base,
      runId,
      (ev) => eventOf(ev).type === "run_end" && ++runEnds === 2,
      15_000,
    );
    expect(events, "自动续跑轮应完整跑完（第二条 run_end）").toBeDefined();

    const userMsg = events!.find(
      (e) => eventOf(e).type === "user_message" && eventOf(e).text === combined,
    );
    expect(userMsg, "排队消息应拼成一条自动续跑").toBeDefined();
    const cleared = events!.find(
      (e) =>
        eventOf(e).type === "message_queue_updated" &&
        Array.isArray(eventOf(e).pending) &&
        (eventOf(e).pending as unknown[]).length === 0,
    );
    expect(cleared, "自动续跑成功后队列清空要落事件").toBeDefined();
    // 第二次模型调用真的收到了拼好的指令
    expect(model.requests).toHaveLength(2);
    const secondText = JSON.stringify(model.requests[1]!.messages.at(-1));
    expect(secondText).toContain("排队指令A");
    expect(secondText).toContain("排队指令B");
  });

  it("DELETE /queue：整队清空后本轮结束不再自动续跑；带 index 取消单条", async () => {
    const model = new GatedModelClient([
      fakeMessage([toolUseBlock("tu_1", "ping", {})], "tool_use"),
      fakeMessage([textBlock("第一轮完成")], "end_turn"),
    ]);
    model.holdFirstCall();
    workdir = await mkdtemp(join(tmpdir(), "agent-queue-"));
    handle = createUiServer({
      modelClient: model,
      tools: [makeTool({ name: "ping" })],
      workdir,
    });
    const base = `http://127.0.0.1:${await startServer(handle)}`;

    const runId = await createRun(base, "跑一个长任务");
    await waitFor(() => model.requests.length === 1, 8000, "first model call in flight");

    await postMessage(base, runId, { text: "要取消的", mode: "queue" });
    await postMessage(base, runId, { text: "要保留的", mode: "queue" });

    // 取消单条（index 0）
    const delOne = await fetch(`${base}/api/runs/${runId}/queue`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index: 0 }),
    });
    expect(delOne.status).toBe(200);
    expect(((await delOne.json()) as { pending: string[] }).pending).toEqual(["要保留的"]);

    // 越界 index → 400
    const delBad = await fetch(`${base}/api/runs/${runId}/queue`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index: 5 }),
    });
    expect(delBad.status).toBe(400);

    // 整队清空（空 body）
    const delAll = await fetch(`${base}/api/runs/${runId}/queue`, { method: "DELETE" });
    expect(delAll.status).toBe(200);
    expect(((await delAll.json()) as { pending: string[] }).pending).toEqual([]);

    model.release();
    // 等本轮收尾，再确认没有自动续跑
    const firstEnd = await waitForEvent(base, runId, (ev) => eventOf(ev).type === "run_end");
    expect(firstEnd).toBeDefined();
    await sleep(600); // 给"错误的自动续跑"一个出现的机会
    const after = await waitForEvent(base, runId, (ev, seen) => seen.some(
      (e) => eventOf(e).type === "user_message",
    ), 1500);
    expect(
      after?.filter((e) => eventOf(e).type === "user_message") ?? [],
      "队列已清空，不得再自动续跑",
    ).toHaveLength(0);
    // 模型只被调用脚本内的轮次（tool_use → end_turn 共 2 次），没有第三轮
    expect(model.requests).toHaveLength(2);
  });

  it("运行结束才来及不到的 steer 余量并入自动续跑（消息不丢）", async () => {
    const model = new GatedModelClient([
      fakeMessage([textBlock("单轮直接完")], "end_turn"),
      fakeMessage([textBlock("续跑完成")], "end_turn"),
    ]);
    model.holdFirstCall();
    workdir = await mkdtemp(join(tmpdir(), "agent-queue-"));
    handle = createUiServer({ modelClient: model, tools: [], workdir });
    const base = `http://127.0.0.1:${await startServer(handle)}`;

    const runId = await createRun(base, "一句话任务");
    await waitFor(() => model.requests.length === 1, 8000, "first model call in flight");

    // 模型调用在飞：steer 赶不上这一轮（drain 只在模型调用前发生）
    const steer = await postMessage(base, runId, { text: "来不及插队的补充", mode: "steer" });
    expect(steer.status).toBe(202);

    model.release();
    let runEnds = 0;
    const events = await waitForEvent(
      base,
      runId,
      (ev) => eventOf(ev).type === "run_end" && ++runEnds === 2,
      15_000,
    );
    expect(events, "steer 余量应触发一次自动续跑").toBeDefined();
    const followUp = events!.find(
      (e) => eventOf(e).type === "user_message" && eventOf(e).text === "来不及插队的补充",
    );
    expect(followUp, "没来得及注入的 steer 必须并入自动续跑，不许丢").toBeDefined();
    expect(model.requests).toHaveLength(2);
  });

  it("运行中传非法 mode → 400，不说谎入队", async () => {
    const model = new GatedModelClient([fakeMessage([textBlock("完")], "end_turn")]);
    model.holdFirstCall();
    workdir = await mkdtemp(join(tmpdir(), "agent-queue-"));
    handle = createUiServer({ modelClient: model, tools: [], workdir });
    const base = `http://127.0.0.1:${await startServer(handle)}`;

    const runId = await createRun(base, "任务");
    await waitFor(() => model.requests.length === 1, 8000, "first model call in flight");

    const bad = await postMessage(base, runId, { text: "x", mode: "plan" });
    expect(bad.status).toBe(400);
    const missing = await fetch(`${base}/api/runs/${runId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "queue" }),
    });
    expect(missing.status).toBe(400);

    model.release();
    const ended = await waitForEvent(base, runId, (ev) => eventOf(ev).type === "run_end");
    expect(ended).toBeDefined();
    // 被拒的请求没有留下任何队列痕迹
    expect(ended!.some((e) => eventOf(e).type === "message_queued")).toBe(false);
  });
});

describe("rebuildMessageQueue · 崩溃恢复的队列重建", () => {
  const ev = (event: Record<string, unknown>) => ({ event });

  it("message_queued(queue) 追加、message_queue_updated 整表替换", () => {
    const events = [
      ev({ type: "message_queued", mode: "queue", text: "甲" }),
      ev({ type: "message_queued", mode: "steer", text: "插队不算" }),
      ev({ type: "message_queued", mode: "queue", text: "乙" }),
      ev({ type: "message_queue_updated", pending: ["乙"] }),
      ev({ type: "message_queued", mode: "queue", text: "丙" }),
    ];
    expect(rebuildMessageQueue(events)).toEqual(["乙", "丙"]);
  });

  it("自动续跑成功后的清空（pending []）压掉此前全部排队", () => {
    const events = [
      ev({ type: "message_queued", mode: "queue", text: "甲" }),
      ev({ type: "message_queue_updated", pending: [] }),
      ev({ type: "user_message", text: "甲" }),
    ];
    expect(rebuildMessageQueue(events)).toEqual([]);
  });

  it("没有队列事件 → 空队列（旧档案兼容）", () => {
    expect(rebuildMessageQueue([ev({ type: "turn_start", turn: 1 })])).toEqual([]);
  });
});

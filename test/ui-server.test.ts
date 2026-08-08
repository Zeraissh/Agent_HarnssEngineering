/**
 * ui/server.ts 契约测试——全用注入的 FakeModelClient，不碰真实端点、不需要 API key。
 *
 * 覆盖率:
 *   a. verify=false run → SSE 收到 turn_start…done，seq 单调递增
 *   b. approval_request → POST allow → 继续至 done
 *   c. approval_request → POST deny → tool_result isError(含拒绝理由)，运行正常收尾
 *   d. verify=true → source="verifier" 事件 + verdict 合成事件（含 unverified/advisory）
 *   e. SSE 晚订阅（run 已结束后）→ 重放全部缓冲事件含 verdict
 *   f. GET /api/runs 列表状态正确；未知 runId 返回 404
 *   g. verifier 的 approval_request 不进 pendingApprovals → POST 返回 404（F2）
 *   h. R-01 幂等: 同一 toolUseId 二次 POST 返回 409，respond 仅调用一次
 *   i. R-01 run 结束后审批 POST 返回 409
 *   j. R-01 GET /api/runs 返回 createdAt/finishedAt（字段存在+单调性）
 *   k. 执行失败: 模型抛错不崩 → done/stopReason=error + 列表 status=done/finishedAt 非 null
 *   l. 核查未通过: 末尾 verdict 合成事件 passed=false + issues 非空 + source="rework" 事件出现
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createUiServer, contentTypeOf, revealCommand, type UiServerHandle } from "../ui/server.js";
import {
  FakeModelClient,
  fakeMessage,
  makeTool,
  textBlock,
  toolUseBlock,
} from "./helpers.js";
import type { Tool, ModelClient, ModelRequest, ModelTurn, StreamDelta } from "../src/types.js";

// ------------------------------------------------------
// Helpers
// ------------------------------------------------------

function startServer(handle: UiServerHandle): Promise<number> {
  return new Promise((resolve, reject) => {
    handle.server.listen(0, () => {
      const addr = handle.server.address();
      if (addr && typeof addr === "object") {
        resolve(addr.port);
      } else {
        reject(new Error("Could not get server port"));
      }
    });
    handle.server.on("error", reject);
  });
}

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** 流式读取 SSE 事件（逐个 yield） */
async function* readSSE(
  response: Response,
): AsyncGenerator<Record<string, unknown>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });

    // 提取完整的 SSE 事件（\n\n 分隔）。
    // 一帧可含多个字段（id: / event: / data:），顺序不限——只按 "data: " 前缀
    // 判断整块会漏掉带 id 的帧（断点续传需要 id），所以按行解析。
    while (true) {
      const idx = buffer.indexOf("\n\n");
      if (idx === -1) break;
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      const dataLines: string[] = [];
      let eventName = "message";
      for (const line of block.split("\n")) {
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        else if (line.startsWith("event:")) eventName = line.slice(6).trim();
      }
      if (dataLines.length === 0) continue;
      // 命名通道（如 event: delta）不是 durable 事件流的一部分，跳过
      if (eventName !== "message") continue;
      yield JSON.parse(dataLines.join("\n"));
    }

    if (done) break;
  }
}

/** 一次性读完整 SSE 流（run 已结束时用） */
async function readSSEAll(response: Response): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for await (const e of readSSE(response)) {
    events.push(e);
  }
  return events;
}

/**
 * 在**运行中**的 run 上等待某条事件出现。
 * 不能用 readSSEAll——运行中的流不会自行结束，会一直读到测试超时。
 */
async function waitForEvent(
  base: string,
  runId: string,
  predicate: (e: Record<string, unknown>) => boolean,
  timeoutMs = 4000,
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
        const ev = JSON.parse(dataLines.join("\n"));
        if (predicate(ev)) return ev;
      }
      if (chunk.done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return undefined;
}

/**
 * 取一个**运行中** run 的已缓冲事件快照。
 * readSSEAll 会一直读到流结束，对没跑完的 run 会挂到超时；这里读到静默即收。
 */
async function readSSESnapshot(
  base: string,
  runId: string,
  quietMs = 250,
): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${base}/api/runs/${runId}/events`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Record<string, unknown>[] = [];
  let buffer = "";
  let lastData = Date.now();
  try {
    while (Date.now() - lastData < quietMs) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: false }>((r) =>
          setTimeout(() => r({ value: undefined, done: false }), 50),
        ),
      ]);
      if (chunk.value) {
        buffer += decoder.decode(chunk.value, { stream: true });
        lastData = Date.now();
      }
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
        events.push(JSON.parse(dataLines.join("\n")));
      }
      if (chunk.done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return events;
}

/** 等待 run 变为 done */
async function waitForDone(base: string, runId: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${base}/api/runs`);
    const list: { runId: string; status: string }[] = await res.json();
    const entry = list.find((r) => r.runId === runId);
    if (entry?.status === "done") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Run ${runId} did not finish in time`);
}

/** 创建一个模拟工具（默认 permission=auto） */
function autoTool(name: string): Tool {
  return makeTool({ name, permission: "auto", parallelSafe: true });
}

/** 创建一个需要审批的工具 */
function askTool(name: string): Tool {
  return makeTool({ name, permission: "ask", parallelSafe: false });
}

// ------------------------------------------------------
// Tests
// ------------------------------------------------------

describe("ui-server", () => {
  let handle: UiServerHandle | undefined;
  let port = 0;
  let base = "";

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  // ---- a. verify=false run → 完整事件序列，seq 单调递增 ----
  it("a. verify=false: 收到 turn_start → done 事件序列，seq 单调递增", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock("task complete")], "end_turn"),
    ]);
    handle = createUiServer({
      modelClient: model,
      tools: [autoTool("alpha")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const createRes = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "do something", verify: false }),
    });
    expect(createRes.status).toBe(200);
    const { runId } = await createRes.json() as { runId: string };

    const sseRes = await fetch(`${base}/api/runs/${runId}/events`);
    expect(sseRes.status).toBe(200);
    const events = await readSSEAll(sseRes);

    expect(events.length).toBeGreaterThanOrEqual(2);

    for (let i = 1; i < events.length; i++) {
      expect((events[i] as any).seq).toBeGreaterThan((events[i - 1] as any).seq);
    }

    const types = events.map((e) => (e as any).event.type);
    expect(types).toContain("turn_start");
    expect(types).toContain("done");

    const doneEvent = events.find((e) => (e as any).event.type === "done");
    expect(doneEvent).toBeDefined();
    expect((doneEvent as any).event.stopReason).toBe("completed");
    expect((doneEvent as any).event.usage).toBeDefined();
    expect((doneEvent as any).source).toBe("main");
  });

  // ---- b. 含 approval_request 的 run：SSE 收到审批事件 → POST allow → 继续至 done ----
  it("b. approval_request → allow: 审批通过后运行继续至 done", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_1", "danger", { cmd: "rm -rf /" })], "tool_use"),
      fakeMessage([textBlock("approved and completed")], "end_turn"),
    ]);
    handle = createUiServer({
      modelClient: model,
      tools: [askTool("danger")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const createRes = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "risky operation", verify: false }),
    });
    const { runId } = await createRes.json() as { runId: string };

    const sseRes = await fetch(`${base}/api/runs/${runId}/events`);
    expect(sseRes.status).toBe(200);

    const events: Record<string, unknown>[] = [];
    let approved = false;
    for await (const e of readSSE(sseRes)) {
      events.push(e);
      const evt = (e as any).event;
      if (!approved && evt.type === "approval_request") {
        approved = true;
        const appRes = await fetch(
          `${base}/api/runs/${runId}/approvals/${evt.toolUseId}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision: "allow" }),
          },
        );
        expect(appRes.status).toBe(200);
      }
      if (evt.type === "done") break;
    }

    const appEvent = events.find((e) => (e as any).event.type === "approval_request");
    expect(appEvent).toBeDefined();
    expect((appEvent as any).event.respond).toBeUndefined();
    expect((appEvent as any).event.toolUseId).toBe("tu_1");
    expect((appEvent as any).event.name).toBe("danger");

    const trEvent = events.find((e) => (e as any).event.type === "tool_result");
    expect(trEvent).toBeDefined();
    expect((trEvent as any).event.result.isError).toBeFalsy();

    const doneEvent = events.find((e) => (e as any).event.type === "done");
    expect(doneEvent).toBeDefined();
    expect((doneEvent as any).event.stopReason).toBe("completed");
  });

  // ---- c. approval deny → tool_result isError(含拒绝理由)，运行仍正常收尾 ----
  it("c. approval_request → deny: 工具结果 isError 且内容含拒绝理由，运行正常收尾", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_2", "risky", {})], "tool_use"),
      fakeMessage([textBlock("handled denial gracefully")], "end_turn"),
    ]);
    handle = createUiServer({
      modelClient: model,
      tools: [askTool("risky")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const createRes = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "risky", verify: false }),
    });
    const { runId } = await createRes.json() as { runId: string };

    const sseRes = await fetch(`${base}/api/runs/${runId}/events`);
    const events: Record<string, unknown>[] = [];
    let denied = false;
    for await (const e of readSSE(sseRes)) {
      events.push(e);
      const evt = (e as any).event;
      if (!denied && evt.type === "approval_request") {
        denied = true;
        await fetch(
          `${base}/api/runs/${runId}/approvals/${evt.toolUseId}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision: "deny", reason: "too dangerous" }),
          },
        );
      }
      if (evt.type === "done") break;
    }

    const trEvent = events.find((e) => (e as any).event.type === "tool_result");
    expect(trEvent).toBeDefined();
    expect((trEvent as any).event.result.isError).toBe(true);

    // AC-10: 拒绝理由必须在工具结果中可见
    const result = (trEvent as any).event.result;
    const content = typeof result.content === "string" ? result.content : "";
    expect(content).toContain("too dangerous");

    const doneEvent = events.find((e) => (e as any).event.type === "done");
    expect(doneEvent).toBeDefined();
    expect((doneEvent as any).event.stopReason).toBe("completed");

    for (let i = 1; i < events.length; i++) {
      expect((events[i] as any).seq).toBeGreaterThan((events[i - 1] as any).seq);
    }
  });

  // ---- d. verify=true → source="verifier" 事件 + verdict 合成事件 ----
  it("d. verify=true: 收到 source=verifier 的事件与末尾 verdict 合成事件（含 unverified/advisory）", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock("I completed the task")], "end_turn"),
      fakeMessage(
        [
          textBlock(
            JSON.stringify({
              passed: true,
              issues: [],
              unverified: ["need manual review of line count"],
              advisory: ["code quality | good | sampled 3 files"],
              summary: "客观项全过",
            }),
          ),
        ],
        "end_turn",
      ),
    ]);
    handle = createUiServer({
      modelClient: model,
      tools: [autoTool("probe")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const createRes = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "verify me", verify: true }),
    });
    const { runId } = await createRes.json() as { runId: string };

    await waitForDone(base, runId);

    const sseRes = await fetch(`${base}/api/runs/${runId}/events`);
    const events = await readSSEAll(sseRes);

    const verifierEvents = events.filter((e) => (e as any).source === "verifier");
    expect(verifierEvents.length).toBeGreaterThan(0);

    const verdictEvent = events.find((e) => (e as any).event.type === "verdict");
    expect(verdictEvent).toBeDefined();
    expect((verdictEvent as any).source).toBe("verifier");

    const verdict = (verdictEvent as any).event.verdict;
    expect(verdict.passed).toBe(true);
    expect(verdict.unverified).toEqual(["need manual review of line count"]);
    expect(verdict.advisory).toEqual(["code quality | good | sampled 3 files"]);
    expect(verdict.summary).toBe("客观项全过");

    for (let i = 1; i < events.length; i++) {
      expect((events[i] as any).seq).toBeGreaterThan((events[i - 1] as any).seq);
    }
  });

  // ---- e. SSE 晚订阅（run 已结束）→ 重放全部缓冲事件含 verdict ----
  it("e. SSE 晚订阅: run 已结束后订阅，重放全部缓冲事件含 verdict", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock("done")], "end_turn"),
      fakeMessage(
        [
          textBlock(
            JSON.stringify({
              passed: true,
              issues: [],
              unverified: ["late check item"],
              advisory: ["style | ok"],
              summary: "passed",
            }),
          ),
        ],
        "end_turn",
      ),
    ]);
    handle = createUiServer({
      modelClient: model,
      tools: [autoTool("x")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const createRes = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "late", verify: true }),
    });
    const { runId } = await createRes.json() as { runId: string };

    await waitForDone(base, runId);

    const listRes = await fetch(`${base}/api/runs`);
    const list: { runId: string; status: string }[] = await listRes.json();
    const entry = list.find((r) => r.runId === runId);
    expect(entry?.status).toBe("done");

    const sseRes = await fetch(`${base}/api/runs/${runId}/events`);
    expect(sseRes.status).toBe(200);
    const events = await readSSEAll(sseRes);

    const types = events.map((e) => (e as any).event.type);
    expect(types).toContain("turn_start");
    expect(types).toContain("done");
    expect(types).toContain("verdict");

    const verdictEvent = events.find((e) => (e as any).event.type === "verdict");
    expect(verdictEvent).toBeDefined();
    expect((verdictEvent as any).event.verdict.unverified).toEqual(["late check item"]);
    expect((verdictEvent as any).event.verdict.advisory).toEqual(["style | ok"]);

    expect((events[0] as any).seq).toBe(0);
    for (let i = 1; i < events.length; i++) {
      expect((events[i] as any).seq).toBeGreaterThan((events[i - 1] as any).seq);
    }
  });

  // ---- f. GET /api/runs 列表状态正确；未知 runId 返回 404 ----
  it("f. 列表状态正确 + 未知 runId 返回 404", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock("ok")], "end_turn"),
    ]);
    handle = createUiServer({
      modelClient: model,
      tools: [autoTool("a")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const r1 = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "task1", verify: false }),
    });
    const { runId: id1 } = await r1.json() as { runId: string };

    const r2 = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "task2", verify: true }),
    });
    const { runId: id2 } = await r2.json() as { runId: string };

    await waitForDone(base, id1);
    await waitForDone(base, id2);

    const listRes = await fetch(`${base}/api/runs`);
    const list: { runId: string; task: string; status: string; verify: boolean }[] =
      await listRes.json();
    expect(list).toHaveLength(2);
    const e1 = list.find((r) => r.runId === id1);
    const e2 = list.find((r) => r.runId === id2);
    expect(e1).toBeDefined();
    expect(e2).toBeDefined();
    expect(e1!.status).toBe("done");
    expect(e2!.status).toBe("done");
    expect(e1!.task).toBe("task1");
    expect(e2!.task).toBe("task2");
    expect(e1!.verify).toBe(false);
    expect(e2!.verify).toBe(true);

    const badEvents = await fetch(`${base}/api/runs/nonexistent/events`);
    expect(badEvents.status).toBe(404);
    const badEventsBody = await badEvents.json();
    expect(badEventsBody.error).toBeDefined();

    const badApp = await fetch(`${base}/api/runs/nonexistent/approvals/tu_x`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow" }),
    });
    expect(badApp.status).toBe(404);
    const badAppBody = await badApp.json();
    expect(badAppBody.error).toBeDefined();
  });

  // ---- g. verifier 的 approval_request 不进 pendingApprovals → POST 返回 404（F2） ----
  it("g. verifier 的 approval_request: POST approvals 返回 404（不进 pendingApprovals）", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock("task done")], "end_turn"),
      fakeMessage([toolUseBlock("vtu_99", "risky", { cmd: "check" })], "tool_use"),
      fakeMessage(
        [textBlock(JSON.stringify({ passed: true, issues: [], summary: "ok" }))],
        "end_turn",
      ),
    ]);
    handle = createUiServer({
      modelClient: model,
      tools: [askTool("risky"), autoTool("read")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const createRes = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "check me", verify: true }),
    });
    const { runId } = await createRes.json() as { runId: string };

    const sseRes = await fetch(`${base}/api/runs/${runId}/events`);
    expect(sseRes.status).toBe(200);

    let verifierApprovalToolUseId: string | undefined;
    for await (const e of readSSE(sseRes)) {
      const evt = (e as any);
      if (
        evt.source === "verifier" &&
        evt.event.type === "approval_request"
      ) {
        verifierApprovalToolUseId = evt.event.toolUseId;
        const appRes = await fetch(
          `${base}/api/runs/${runId}/approvals/${verifierApprovalToolUseId}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision: "allow" }),
          },
        );
        // F2: verifier 审批在 running 时返回 404（不在 pendingApprovals 中）
        // 若 run 已结束则返回 409（状态不允许），两种情况均合理
        expect([404, 409]).toContain(appRes.status);
        if (appRes.status === 404) {
          const body = await appRes.json();
          expect(body.error).toBeDefined();
        }
      }
      if (evt.event.type === "verdict") break;
    }

    expect(verifierApprovalToolUseId).toBeDefined();
    expect(verifierApprovalToolUseId).toBe("vtu_99");
  });

  // ---- h. R-01 幂等: 同一审批二次 POST 返回 409，respond 仅调用一次 ----
  it("h. R-01 幂等: 同一 toolUseId 二次 POST 返回 409", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_idem", "sensitive", { op: "delete" })], "tool_use"),
      fakeMessage([textBlock("done")], "end_turn"),
    ]);
    handle = createUiServer({
      modelClient: model,
      tools: [askTool("sensitive")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const createRes = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "idempotent test", verify: false }),
    });
    const { runId } = await createRes.json() as { runId: string };

    // 流式读取 SSE，等待 approval_request 出现
    const sseRes = await fetch(`${base}/api/runs/${runId}/events`);
    expect(sseRes.status).toBe(200);

    let toolUseId: string | undefined;
    for await (const e of readSSE(sseRes)) {
      const evt = (e as any).event;
      if (evt.type === "approval_request") {
        toolUseId = evt.toolUseId;
        break;
      }
    }

    expect(toolUseId).toBeDefined();
    expect(toolUseId).toBe("tu_idem");

    // 第一次 POST → 200
    const res1 = await fetch(`${base}/api/runs/${runId}/approvals/${toolUseId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow" }),
    });
    expect(res1.status).toBe(200);

    // 第二次 POST（同一 toolUseId）→ 409（幂等）
    const res2 = await fetch(`${base}/api/runs/${runId}/approvals/${toolUseId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "deny", reason: "changed my mind" }),
    });
    expect(res2.status).toBe(409);
    const body2 = await res2.json();
    expect(body2.error).toBeDefined();

    // 验证 run 仍正常完成（第一次 respond 生效，第二次被拒）
    await waitForDone(base, runId);
  });

  // ---- i. R-01 run 结束后审批 POST 返回 409 ----
  it("i. R-01 run 结束后审批 POST 返回 409", async () => {
    // 场景：创建一个不带审批的 run，等它完成后，对任意 toolUseId POST → 409
    const model = new FakeModelClient([
      fakeMessage([textBlock("done quickly")], "end_turn"),
    ]);
    handle = createUiServer({
      modelClient: model,
      tools: [autoTool("fast")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const createRes = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "fast finish", verify: false }),
    });
    const { runId } = await createRes.json() as { runId: string };

    // 等待 run 完成
    await waitForDone(base, runId);

    // 确认 run 状态为 done
    const listRes = await fetch(`${base}/api/runs`);
    const list: { runId: string; status: string }[] = await listRes.json();
    const entry = list.find((r) => r.runId === runId);
    expect(entry?.status).toBe("done");

    // 对 done 的 run 发任意审批 POST → 409
    const appRes = await fetch(`${base}/api/runs/${runId}/approvals/any_tool_id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow" }),
    });
    expect(appRes.status).toBe(409);
    const body = await appRes.json();
    expect(body.error).toBeDefined();
    expect(body.error).toContain("finished");
  });

  // ---- j. R-01 GET /api/runs 返回 createdAt/finishedAt ----
  it("j. R-01 GET /api/runs 返回 createdAt/finishedAt 且 running 时 finishedAt 为 null", async () => {
    // 使用 askTool 让 run 卡在审批等待，以便捕获 running 状态
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_ts", "stuck", {})], "tool_use"),
    ]);
    handle = createUiServer({
      modelClient: model,
      tools: [askTool("stuck")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const beforeCreate = Date.now();
    const createRes = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "timestamp test", verify: false }),
    });
    const afterCreate = Date.now();
    const { runId } = await createRes.json() as { runId: string };

    // 轮询直到 run 出现（running 状态）
    let runningEntry: any;
    for (let i = 0; i < 20; i++) {
      const listRunning = await fetch(`${base}/api/runs`);
      const runningList: any[] = await listRunning.json();
      runningEntry = runningList.find((r: any) => r.runId === runId);
      if (runningEntry) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(runningEntry).toBeDefined();
    expect(runningEntry.status).toBe("running");
    expect(runningEntry.createdAt).toBeTypeOf("number");
    expect(runningEntry.createdAt).toBeGreaterThanOrEqual(beforeCreate);
    expect(runningEntry.createdAt).toBeLessThanOrEqual(afterCreate);
    // running 时 finishedAt 为 null
    expect(runningEntry.finishedAt).toBeNull();

    // 通过 SSE 获取 toolUseId 并 allow 以让 run 完成
    const sseRes = await fetch(`${base}/api/runs/${runId}/events`);
    let toolUseId: string | undefined;
    for await (const e of readSSE(sseRes)) {
      const evt = (e as any).event;
      if (evt.type === "approval_request") {
        toolUseId = evt.toolUseId;
        break;
      }
    }
    expect(toolUseId).toBeDefined();

    // 允许审批，让 run 完成
    await fetch(`${base}/api/runs/${runId}/approvals/${toolUseId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow" }),
    });

    await waitForDone(base, runId);

    const listDone = await fetch(`${base}/api/runs`);
    const doneList: any[] = await listDone.json();
    const doneEntry = doneList.find((r: any) => r.runId === runId);
    expect(doneEntry).toBeDefined();
    expect(doneEntry.status).toBe("done");
    expect(doneEntry.createdAt).toBeTypeOf("number");
    expect(doneEntry.finishedAt).toBeTypeOf("number");
    // finishedAt ≥ createdAt（单调性）
    expect(doneEntry.finishedAt).toBeGreaterThanOrEqual(doneEntry.createdAt);
  });

  // ---- k. 执行失败: 模型抛错不崩 + done/stopReason=error + 列表状态/finishedAt 正确 ----
  it("k. 执行失败: 模型抛错不崩，SSE 含 done/stopReason=error，列表 status=done 且 finishedAt 非 null", async () => {
    // 使用一个会在 send 时抛错的模型
    class ThrowingClient implements ModelClient {
      requests: ModelRequest[] = [];
      async send(req: ModelRequest): Promise<ModelTurn> {
        this.requests.push(structuredClone(req));
        throw new Error("simulated model crash");
      }
    }

    handle = createUiServer({
      modelClient: new ThrowingClient(),
      tools: [autoTool("probe")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const createRes = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "will crash", verify: false }),
    });
    expect(createRes.status).toBe(200);
    const { runId } = await createRes.json() as { runId: string };

    await waitForDone(base, runId);

    // SSE 事件流必须包含 done 事件且 stopReason=error
    const sseRes = await fetch(`${base}/api/runs/${runId}/events`);
    const events = await readSSEAll(sseRes);

    const doneEvent = events.find((e) => (e as any).event.type === "done");
    expect(doneEvent).toBeDefined();
    expect((doneEvent as any).source).toBe("main");
    expect((doneEvent as any).event.stopReason).toBe("error");

    // 服务不得崩溃——事件流能完整读取就是证据
    expect(events.length).toBeGreaterThanOrEqual(1);

    // GET /api/runs 列表: status=done, finishedAt 非 null
    const listRes = await fetch(`${base}/api/runs`);
    const list: any[] = await listRes.json();
    const entry = list.find((r: any) => r.runId === runId);
    expect(entry).toBeDefined();
    expect(entry.status).toBe("done");
    expect(entry.finishedAt).toBeTypeOf("number");
    expect(entry.finishedAt).toBeGreaterThan(0);
  });

  // ---- l. 核查未通过: 末尾 verdict 合成事件 passed=false + issues 非空 + source="rework" 事件出现 ----
  it("l. 核查未通过: 末尾 verdict 合成事件 passed=false + issues 非空 + source=rework 出现在流中", async () => {
    // 脚本化编排: main → verifier(failed) → rework → verifier(再次 failed)
    // 关键：末尾 verdict 必须 passed=false（两次核查均不通过），且 source=rework 事件在流中
    const model = new FakeModelClient([
      // round 1: main 完成任务
      fakeMessage([textBlock("task done, results produced")], "end_turn"),
      // round 1: verifier 裁决不通过（passed=false, issues 非空）
      fakeMessage(
        [
          textBlock(
            JSON.stringify({
              passed: false,
              issues: ["文件行数不符：期望 10 实际 8", "输出格式错误"],
              unverified: [],
              advisory: ["建议检查边界条件"],
              summary: "客观项 2 条不符，需返工",
            }),
          ),
        ],
        "end_turn",
      ),
      // round 2: rework 尝试修复
      fakeMessage([textBlock("attempted to fix issues")], "end_turn"),
      // round 2: verifier 再次裁决不通过（passed=false, issues 仍非空）
      fakeMessage(
        [
          textBlock(
            JSON.stringify({
              passed: false,
              issues: ["输出格式错误", "缺少必要元数据字段"],
              unverified: ["人工判断修复是否充分"],
              advisory: ["建议重新生成输出"],
              summary: "返工后仍有 2 条不符，核查未通过",
            }),
          ),
        ],
        "end_turn",
      ),
    ]);

    handle = createUiServer({
      modelClient: model,
      tools: [autoTool("read")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const createRes = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "verify with rework and final fail", verify: true }),
    });
    const { runId } = await createRes.json() as { runId: string };

    await waitForDone(base, runId);

    const sseRes = await fetch(`${base}/api/runs/${runId}/events`);
    const events = await readSSEAll(sseRes);

    // === 核心断言：末尾 verdict 合成事件 passed=false 且 issues 非空 ===
    const verdictEvents = events.filter((e) => (e as any).event.type === "verdict");
    expect(verdictEvents.length).toBeGreaterThanOrEqual(1);

    const lastVerdict = verdictEvents[verdictEvents.length - 1] as any;
    // AC5: 末尾 verdict.passed 必须为 false
    expect(lastVerdict.event.verdict.passed).toBe(false);
    // AC5: issues 非空
    expect(lastVerdict.event.verdict.issues).toBeInstanceOf(Array);
    expect(lastVerdict.event.verdict.issues.length).toBeGreaterThan(0);
    expect(lastVerdict.event.verdict.issues).toContain("输出格式错误");
    expect(lastVerdict.event.verdict.summary).toBe("返工后仍有 2 条不符，核查未通过");
    expect(lastVerdict.source).toBe("verifier");

    // === 返工阶段断言：source="rework" 事件出现在流中 ===
    const reworkEvents = events.filter((e) => (e as any).source === "rework");
    expect(reworkEvents.length).toBeGreaterThan(0);
    const reworkTypes = reworkEvents.map((e) => (e as any).event.type);
    expect(reworkTypes).toContain("turn_start");

    // === 来源区分：main / verifier / rework 三者均在流中 ===
    const sources = new Set(events.map((e) => (e as any).source));
    expect(sources.has("main")).toBe(true);
    expect(sources.has("verifier")).toBe(true);
    expect(sources.has("rework")).toBe(true);

    // === seq 单调递增 ===
    for (let i = 1; i < events.length; i++) {
      expect((events[i] as any).seq).toBeGreaterThan((events[i - 1] as any).seq);
    }
  });

  // ================================================================
  // v2 / R1 — 状态机与审批审计契约
  // ================================================================

  // ---- V-01 死锁回归锁：返工轮的审批必须仍可应答 ----
  it("v2-1. 返工轮审批可应答：主轮 done 之后出现的审批仍能放行，运行正常收尾", async () => {
    // 事件序列：main(完成) → verifier(不通过) → rework(请求审批) → verifier(通过)
    const model = new FakeModelClient([
      fakeMessage([textBlock("首轮交付")], "end_turn"),
      fakeMessage(
        [textBlock(JSON.stringify({ passed: false, issues: ["缺少收尾"], summary: "未通过" }))],
        "end_turn",
      ),
      fakeMessage([toolUseBlock("tu_rework", "sensitive", { op: "fix" })], "tool_use"),
      fakeMessage([textBlock("返工完成")], "end_turn"),
      fakeMessage(
        [textBlock(JSON.stringify({ passed: true, issues: [], summary: "通过" }))],
        "end_turn",
      ),
    ]);

    handle = createUiServer({
      modelClient: model,
      tools: [askTool("sensitive")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const createRes = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "rework needs approval", verify: true }),
    });
    const { runId } = await createRes.json() as { runId: string };

    // 等返工轮的审批请求出现（它在主轮 done 之后——旧实现正是在这里把前端锁死的）
    const approval: any = await waitForEvent(
      base,
      runId,
      (e: any) => e.event.type === "approval_request" && e.source === "rework",
    );
    expect(approval, "返工轮应发出 approval_request").toBeDefined();

    // 该审批出现在 main 的 done 之后——这正是旧实现判定"run 已结束"的时点
    const mainDone: any = await waitForEvent(
      base,
      runId,
      (e: any) => e.event.type === "done" && e.source === "main",
    );
    expect(mainDone).toBeDefined();
    expect(approval.seq).toBeGreaterThan(mainDone.seq);

    // 精确形式应答：approvalId = toolUseId#requestSeq
    const approvalRef = `${approval.event.toolUseId}#${approval.seq}`;
    const postRes = await fetch(
      `${base}/api/runs/${runId}/approvals/${encodeURIComponent(approvalRef)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "allow" }),
      },
    );
    expect(postRes.status).toBe(200);

    // 放行后运行必须能收尾——旧实现下 respond 永不被调用，这里会超时
    await waitForDone(base, runId);

    const final = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    const resolved = final.find((e: any) => e.event.type === "approval_resolved");
    expect(resolved).toBeDefined();
    expect((resolved as any).event.decision).toBe("allow");
    expect((resolved as any).event.requestSeq).toBe(approval.seq);
  });

  // ---- V-02 审批决策进事件流（刷新后审计不失真） ----
  it("v2-2. approval_resolved 进缓冲：重放事件流可复原决策/主体/时间", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_audit", "sensitive", { op: "write" })], "tool_use"),
      fakeMessage([textBlock("done")], "end_turn"),
    ]);
    handle = createUiServer({
      modelClient: model,
      tools: [askTool("sensitive")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "audit trail", verify: false }),
    })).json() as { runId: string };

    const req: any = await waitForEvent(
      base,
      runId,
      (e: any) => e.event.type === "approval_request",
    );
    expect(req).toBeDefined();

    await fetch(
      `${base}/api/runs/${runId}/approvals/${encodeURIComponent(`tu_audit#${req.seq}`)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "deny", reason: "路径不在白名单" }),
      },
    );
    await waitForDone(base, runId);

    // 关键：全新订阅（等价于浏览器刷新）重放后，决策仍在
    const replayed = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    const resolved = replayed.find((e: any) => e.event.type === "approval_resolved") as any;
    expect(resolved).toBeDefined();
    expect(resolved.event.decision).toBe("deny");
    expect(resolved.event.reason).toBe("路径不在白名单");
    expect(resolved.event.actor).toBe("user");
    expect(typeof resolved.event.at).toBe("number");
    expect(resolved.event.toolUseId).toBe("tu_audit");
  });

  // ---- run_end 恒为最后一条 durable 事件，且在段级 done 之后 ----
  it("v2-3a. run_end 是最后一条 durable 事件，排在段级 done 之后", async () => {
    const model = new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]);
    handle = createUiServer({ modelClient: model, tools: [autoTool("noop")], workdir: process.cwd() });
    port = await startServer(handle);
    base = baseUrl(port);

    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "ordering", verify: false }),
    })).json() as { runId: string };
    await waitForDone(base, runId);

    const final = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    const last = final[final.length - 1] as any;
    expect(last.event.type).toBe("run_end");
    expect(last.event.outcome).toBe("completed");
    expect(last.event.mainStopReason).toBe("completed");
    expect(typeof last.event.finishedAt).toBe("number");

    const doneIdx = final.findIndex((e: any) => e.event.type === "done");
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    expect(final.length - 1).toBeGreaterThan(doneIdx);
  });

  // ---- V-02 审批过期由服务端宣告（宿主关停路径） ----
  it("v2-3b. approval_expired：宿主关停时仍挂起的审批被逐条宣告过期", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_never", "sensitive", { op: "x" })], "tool_use"),
    ]);
    handle = createUiServer({
      modelClient: model,
      tools: [askTool("sensitive")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "never answered", verify: false }),
    })).json() as { runId: string };

    const req = await waitForEvent(base, runId, (e: any) => e.event.type === "approval_request");
    expect(req).toBeDefined();

    // 开一条常驻订阅，然后关停宿主——关停帧应当先于断流被写出
    const live = await fetch(`${base}/api/runs/${runId}/events`);
    const reader = live.body!.getReader();
    const decoder = new TextDecoder();

    const closing = handle.close();
    handle = undefined; // 已关，afterEach 不要再关一次

    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) break;
    }
    await closing;

    const types = buffer
      .split("\n\n")
      .map((b) => b.split("\n").find((l) => l.startsWith("data:")))
      .filter((l): l is string => Boolean(l))
      .map((l) => JSON.parse(l.slice(5).trimStart()));

    const expired = types.find((e: any) => e.event.type === "approval_expired") as any;
    expect(expired, "关停时挂起的审批必须被宣告过期").toBeDefined();
    expect(expired.event.toolUseId).toBe("tu_never");
    expect(expired.event.cause).toBe("run_finished");
    expect(expired.event.requestSeq).toBe((req as any).seq);

    const runEnd = types.find((e: any) => e.event.type === "run_end") as any;
    expect(runEnd).toBeDefined();
    expect(runEnd.event.outcome).toBe("closed");
    // 过期宣告必须排在 run_end 之前：先说清每张卡的下场，再宣布收工
    expect(types.indexOf(expired)).toBeLessThan(types.indexOf(runEnd));
  });

  // ---- V-04 / done 载荷补全 ----
  it("v2-4. done 事件透出 error.message 与 segment 身份", async () => {
    const model: ModelClient = {
      send(_req: ModelRequest): Promise<ModelTurn> {
        return Promise.reject(new Error("上游端点 502"));
      },
    };
    handle = createUiServer({ modelClient: model, tools: [autoTool("noop")], workdir: process.cwd() });
    port = await startServer(handle);
    base = baseUrl(port);

    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "boom", verify: false }),
    })).json() as { runId: string };
    await waitForDone(base, runId);

    const events = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    const done = events.find((e: any) => e.event.type === "done") as any;
    expect(done).toBeDefined();
    expect(done.event.stopReason).toBe("error");
    // 此前 error 被整条丢弃，前端只能写死"运行异常终止"
    expect(done.event.error?.message).toContain("502");
    expect(done.event.segment).toEqual({ index: 0, source: "main" });
    expect(typeof done.ts).toBe("number");
  });

  // ---- V-05 断点续传 ----
  it("v2-5. Last-Event-ID 续传：只补发 seq 更大的事件", async () => {
    const model = new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]);
    handle = createUiServer({ modelClient: model, tools: [autoTool("noop")], workdir: process.cwd() });
    port = await startServer(handle);
    base = baseUrl(port);

    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "resume", verify: false }),
    })).json() as { runId: string };
    await waitForDone(base, runId);

    const all = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    expect(all.length).toBeGreaterThan(2);

    const cut = (all[1] as any).seq;
    const resumed = await readSSEAll(
      await fetch(`${base}/api/runs/${runId}/events`, { headers: { "Last-Event-ID": String(cut) } }),
    );
    expect(resumed.length).toBe(all.length - 2);
    expect((resumed[0] as any).seq).toBe(cut + 1);
  });

  // ---- V-03 审批引用二义解析 ----
  it("v2-6. approvalRef 二义：裸 toolUseId 与 id#seq 都能应答，且互不串卡", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_dup", "sensitive", { n: 1 })], "tool_use"),
      fakeMessage([textBlock("ok")], "end_turn"),
    ]);
    handle = createUiServer({
      modelClient: model,
      tools: [askTool("sensitive")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "bare ref", verify: false }),
    })).json() as { runId: string };

    expect(
      await waitForEvent(base, runId, (e: any) => e.event.type === "approval_request"),
    ).toBeDefined();

    // 裸 toolUseId：兼容形式，取该 id 下最新的挂起项
    const bare = await fetch(`${base}/api/runs/${runId}/approvals/tu_dup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow" }),
    });
    expect(bare.status).toBe(200);
    await waitForDone(base, runId);

    // 已应答后再来一次（无论哪种形式）都是 409，respond 只调一次
    const again = await fetch(`${base}/api/runs/${runId}/approvals/tu_dup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "deny" }),
    });
    expect(again.status).toBe(409);
  });

  // ================================================================
  // v2 / R2 — 数据面透出
  // ================================================================

  // ---- V-06 领域包核查三件套真实生效（本轮最重要的一条） ----
  it("v2-7. pack 的只读白名单真实到达 verifier：合规命令被放行而非一律拒绝", async () => {
    // verifier 第一步跑一条白名单内的命令，第二步交裁决
    const model = new FakeModelClient([
      fakeMessage([textBlock("已实现")], "end_turn"),
      fakeMessage([toolUseBlock("v_bash", "bash", { command: "python -m pytest -q" })], "tool_use"),
      fakeMessage(
        [textBlock(JSON.stringify({ passed: true, issues: [], summary: "门禁全绿" }))],
        "end_turn",
      ),
    ]);

    handle = createUiServer({
      modelClient: model,
      packName: "python-coding",
      // 注入一个假 bash（permission=ask，与真 bashTool 同）：verifier 对 ask 类工具
      // 默认全 deny，只有命中包白名单才放行
      tools: [makeTool({ name: "bash", permission: "ask", parallelSafe: false,
        execute: async () => ({ content: "916 passed" }) })],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "whitelist reaches verifier", verify: true }),
    })).json() as { runId: string };
    await waitForDone(base, runId);

    const events = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    const vResult = events.find(
      (e: any) => e.source === "verifier" && e.event.type === "tool_result",
    ) as any;
    expect(vResult, "verifier 应当真的跑了那条命令").toBeDefined();
    // 关键：不是"Verifier is read-only"的拒绝消息，而是命令的真实产出。
    // 白名单没传到时，这里会是 deny 文案——正是案例 #4 那个 22 轮空转的起点
    expect(vResult.event.result.isError).toBeFalsy();
    expect(vResult.event.result.content).toContain("916 passed");
  });

  // ---- V-18 宿主真相快照 ----
  it("v2-8. GET /api/harness 暴露包/工具面/护栏/只读根/effort，且不含密钥", async () => {
    handle = createUiServer({
      modelClient: new FakeModelClient([]),
      packName: "python-coding",
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const snap = await (await fetch(`${base}/api/harness`)).json() as any;

    expect(snap.pack.name).toBe("python-coding");
    // 与 CLI 同源：护栏取自领域包
    expect(snap.guardrails.maxTurns).toBe(30);
    expect(snap.pack.verify.readOnlyCommands.length).toBeGreaterThan(0);
    expect(snap.pack.verify.mode).toBeTruthy();
    expect(snap.verifierBudgetTurns).toBe(15);
    // planner 预算同款（B0）：数字 + 来源，缺一不可
    expect(snap.plannerBudgetTurns).toBe(12);
    expect(snap.plannerBudgetSource).toBe("default");
    expect(snap.compactWatermark).toBe(0.8);
    expect(Array.isArray(snap.tools)).toBe(true);
    expect(snap.tools.every((t: any) => t.name && t.permission)).toBe(true);
    expect(snap.shell).toBeTruthy();
    // MCP 默认关（常驻宿主持有独占资源有风险），且如实说明原因
    expect(snap.mcp.enabled).toBe(false);
    expect(snap.mcp.reason).toContain("AGENT_UI_MCP");
    // 绝不泄漏密钥
    const asText = JSON.stringify(snap);
    expect(asText).not.toContain("apiKey");
    expect(asText).not.toContain("sk-");
  });

  // ---- V-07 / V-08 成本口径与逐轮裁决 ----
  it("v2-9. run_end 带 executionUsage/verifications/reworks，且逐轮 verification 实时发出", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock("首轮")], "end_turn"),
      fakeMessage(
        [textBlock(JSON.stringify({ passed: false, issues: ["漏了收尾"], summary: "未通过" }))],
        "end_turn",
      ),
      fakeMessage([textBlock("返工完成")], "end_turn"),
      fakeMessage(
        [textBlock(JSON.stringify({ passed: true, issues: [], summary: "通过" }))],
        "end_turn",
      ),
    ]);
    handle = createUiServer({ modelClient: model, tools: [autoTool("noop")], workdir: process.cwd() });
    port = await startServer(handle);
    base = baseUrl(port);

    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "cost accounting", verify: true }),
    })).json() as { runId: string };
    await waitForDone(base, runId);

    const events = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));

    // 逐轮裁决实时发出：两轮核查 = 两条 verification 事件，中间轮的 issues 可见
    const verifications = events.filter((e: any) => e.event.type === "verification") as any[];
    expect(verifications).toHaveLength(2);
    expect(verifications[0].event.verdict.passed).toBe(false);
    expect(verifications[0].event.verdict.issues).toContain("漏了收尾");
    expect(verifications[1].event.verdict.passed).toBe(true);

    const runEnd = events[events.length - 1] as any;
    expect(runEnd.event.type).toBe("run_end");
    expect(runEnd.event.reworks).toBe(1);
    expect(runEnd.event.finalPassed).toBe(true);
    expect(runEnd.event.verifications).toHaveLength(2);

    // 成本口径：executionUsage 覆盖两个执行轮，必然多于最后一条 done 的 usage
    const dones = events.filter((e: any) => e.event.type === "done") as any[];
    const lastDoneTurns = dones[dones.length - 1].event.usage.turns;
    expect(runEnd.event.executionUsage.turns).toBeGreaterThan(lastDoneTurns);
    expect(runEnd.event.verificationUsage.turns).toBeGreaterThan(0);
  });

  // ---- V-13 / V-14 列表口径 ----
  it("v2-10. GET /api/runs 按 createdAt 降序且带 verdict/stopReason 等元数据", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock("a")], "end_turn"),
      fakeMessage([textBlock("b")], "end_turn"),
    ]);
    handle = createUiServer({ modelClient: model, tools: [autoTool("noop")], workdir: process.cwd() });
    port = await startServer(handle);
    base = baseUrl(port);

    const mk = async (task: string) =>
      (await (await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, verify: false }),
      })).json() as { runId: string }).runId;

    const first = await mk("older");
    await waitForDone(base, first);
    await new Promise((r) => setTimeout(r, 5));
    const second = await mk("newer");
    await waitForDone(base, second);

    const list = await (await fetch(`${base}/api/runs`)).json() as any[];
    // 最新在前——此前是插入顺序，新任务提交后会从列表顶跳到底
    expect(list[0].runId).toBe(second);
    expect(list[1].runId).toBe(first);
    // 元数据不再依赖"这个 run 是否被订阅过"
    expect(list[0].stopReason).toBe("completed");
    expect(list[0]).toHaveProperty("verdict");
    expect(list[0]).toHaveProperty("pendingApprovals");
  });

  // ---- V-15 流式增量不进持久缓冲 ----
  it("v2-11. text_delta 不占 seq、不进事件缓冲（走命名通道）", async () => {
    let deltasEmitted = 0;
    const model: ModelClient = {
      async send(_req: ModelRequest, onDelta?: (delta: StreamDelta) => void): Promise<ModelTurn> {
        // 增量经 send 的第二个参数旁路发出（见 src/types.ts 的 ModelClient 契约）。
        // 思考增量与文本增量同族：都不占 seq、都走命名通道
        onDelta?.({ kind: "text", text: "流式" });
        onDelta?.({ kind: "text", text: "片段" });
        onDelta?.({ kind: "thinking", text: "想一想" });
        deltasEmitted += 2;
        const message = fakeMessage([textBlock("最终文本")], "end_turn");
        return { message, stopReason: message.stop_reason, usage: message.usage };
      },
    };
    handle = createUiServer({ modelClient: model, tools: [autoTool("noop")], workdir: process.cwd() });
    port = await startServer(handle);
    base = baseUrl(port);

    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "streaming", verify: false }),
    })).json() as { runId: string };
    await waitForDone(base, runId);

    // 先确认 delta 确实产生过，否则这条测试是"因为没触发所以通过"的假绿
    expect(deltasEmitted).toBeGreaterThan(0);

    const events = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    expect(events.find((e: any) => e.event.type === "text_delta")).toBeUndefined();
    // seq 仍然连续（delta 不占号）
    events.forEach((e: any, i: number) => expect(e.seq).toBe(i));
  });

  // ---- V-23 会话正史按需拉 ----
  it("v2-13. GET /api/runs/:id/transcript 返回逐段会话，且不进 SSE 缓冲", async () => {
    handle = createUiServer({
      modelClient: new FakeModelClient([fakeMessage([textBlock("done")], "end_turn")]),
      tools: [autoTool("noop")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "transcript 探针", verify: false }),
    })).json() as { runId: string };
    await waitForDone(base, runId);

    const t = await (await fetch(`${base}/api/runs/${runId}/transcript`)).json() as any;
    expect(t.runId).toBe(runId);
    expect(Array.isArray(t.segments)).toBe(true);
    expect(t.segments.length).toBeGreaterThan(0);
    // 至少含最初那条 user 任务
    const first = t.segments[0];
    expect(first.source).toBe("main");
    expect(first.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(first.messages)).toContain("transcript 探针");

    // 关键：会话正文不得混进事件流（几 MB 的内容会让每个晚订阅者重放一遍）
    const events = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    const doneEvt = events.find((e: any) => e.event.type === "done") as any;
    expect(doneEvt.event.messages).toBeUndefined();
    expect(typeof doneEvt.event.messageCount).toBe("number");
  });

  it("v2-14. 未知 runId 的 transcript 返回 404", async () => {
    handle = createUiServer({ modelClient: new FakeModelClient([]), tools: [], workdir: process.cwd() });
    port = await startServer(handle);
    base = baseUrl(port);
    const res = await fetch(`${baseUrl(port)}/api/runs/nope/transcript`);
    expect(res.status).toBe(404);
  });

  // ---- V-24 逐 run 装配 ----
  it("v2-15. 提交时可逐 run 指定 pack / effort / rubric，非法值当场 400", async () => {
    handle = createUiServer({
      modelClient: new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]),
      tools: [autoTool("noop")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const post = (body: unknown) =>
      fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    // 静默降级是长期成本：设了 python-coding 却跑成默认配置，查起来很贵
    const badPack = await post({ task: "t", pack: "不存在的包" });
    expect(badPack.status).toBe(400);
    expect((await badPack.json() as any).error).toContain("未知领域包");

    const badEffort = await post({ task: "t", effort: "turbo" });
    expect(badEffort.status).toBe(400);
    expect((await badEffort.json() as any).error).toContain("effort");

    const ok = await post({ task: "t", pack: "python-coding", effort: "low", rubric: "可读性" });
    expect(ok.status).toBe(200);
  });

  it("v2-16. /api/harness 列出可选领域包与 effort 档位（前端不硬编码）", async () => {
    handle = createUiServer({ modelClient: new FakeModelClient([]), tools: [], workdir: process.cwd() });
    port = await startServer(handle);
    const snap = await (await fetch(`${baseUrl(port)}/api/harness`)).json() as any;

    expect(Array.isArray(snap.availablePacks)).toBe(true);
    expect(snap.availablePacks.length).toBeGreaterThan(0);
    for (const p of snap.availablePacks) {
      expect(typeof p.name).toBe("string");
      // 只给名字与描述，不泄露 systemPrompt
      expect(p).not.toHaveProperty("systemPrompt");
    }
    expect(snap.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  // ---- V-27 计划编排 ----
  it("v2-17. mode=plan 走 runPlanned：发出 plan / plan_result，来源带子任务前缀", async () => {
    const planJson = JSON.stringify({
      subtasks: [
        { id: "s1", title: "第一步", description: "做 A", acceptance: ["A 完成"], dependsOn: [] },
        { id: "s2", title: "第二步", description: "做 B", acceptance: ["B 完成"], dependsOn: ["s1"] },
      ],
    });
    // runPlanned 对**每个**子任务都跑 runVerified —— 核查是编排的固有环节，
    // 不受请求体里的 verify 开关影响。所以脚本必须为每个子任务备好
    // 「执行一发 + 合法裁决一发」，否则裁决解析失败会 fail-closed 触发快速
    // 失败，下游子任务被 skipped（初稿正是这么写错的：给了八条"完成"，
    // 于是 s1 判未通过、s2 根本没跑）。
    const pass = () =>
      fakeMessage([textBlock(JSON.stringify({ passed: true, issues: [], summary: "通过" }))], "end_turn");
    const script = [
      fakeMessage([textBlock(["```json", planJson, "```"].join("\n"))], "end_turn"),
      fakeMessage([textBlock("s1 完成")], "end_turn"), pass(),
      fakeMessage([textBlock("s2 完成")], "end_turn"), pass(),
    ];
    handle = createUiServer({
      modelClient: new FakeModelClient(script),
      tools: [autoTool("noop")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "两步任务", verify: false, mode: "plan", concurrency: 2 }),
    })).json() as { runId: string };
    await waitForDone(base, runId);

    const events = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));

    const plan = events.find((e: any) => e.event.type === "plan") as any;
    expect(plan, "未发出 plan 事件").toBeDefined();
    expect(plan.event.subtasks.map((t: any) => t.id)).toEqual(["s1", "s2"]);
    expect(plan.event.subtasks[1].dependsOn).toEqual(["s1"]);
    expect(plan.event.concurrency).toBe(2);

    // 来源必须带子任务前缀，否则并行下的日志完全读不懂谁在说话
    const sources = new Set(events.map((e: any) => e.source));
    expect([...sources].some((x) => String(x).startsWith("s1/"))).toBe(true);
    expect(sources.has("planner")).toBe(true);

    const result = events.find((e: any) => e.event.type === "plan_result") as any;
    expect(result, "未发出 plan_result 事件").toBeDefined();
    expect(result.event.plannerRecovery).toBe("direct"); // B0：计划获得路径随事件透出
    expect(result.event.steps.map((st: any) => st.id)).toEqual(["s1", "s2"]);
    // 每个数字都要有口径：子任务阶段墙钟排除 planner，节省是相对串行全序和
    for (const k of ["totalMs", "plannerMs", "subtaskWallMs", "stepSumMs", "savedMs"]) {
      expect(typeof result.event.timing[k], `timing.${k} 缺失`).toBe("number");
    }
    expect(result.event.timing.totalMs).toBeGreaterThanOrEqual(result.event.timing.subtaskWallMs);
  });

  it("v2-18. planner 产不出可解析计划时 fail-closed：planned=false 且零子任务执行", async () => {
    handle = createUiServer({
      modelClient: new FakeModelClient([
        fakeMessage([textBlock("我觉得这个任务不需要拆分。")], "end_turn"),
        fakeMessage([textBlock("还是不拆。")], "end_turn"),
      ]),
      tools: [autoTool("noop")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "不可拆的任务", mode: "plan" }),
    })).json() as { runId: string };
    await waitForDone(base, runId);

    const events = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    const result = events.find((e: any) => e.event.type === "plan_result") as any;
    expect(result.event.planned).toBe(false);
    expect(result.event.steps).toEqual([]);
    // 原始输出要留给人看——"为什么没拆"是可诊断的，不该只剩一个空结果
    expect(typeof result.event.plannerRaw).toBe("string");
    // B0：fail-closed 必须带过程摘要，且零探索的失败要单独措辞——
    // "根本没探索"与"探索没来得及收口"的返工策略完全不同
    expect(result.event.plannerRecovery).toBe("failed");
    expect(String(result.event.plannerFailure)).toContain("零工具调用");
    // 计划作废即一个子任务都不执行
    expect(events.some((e: any) => String(e.source).includes("/"))).toBe(false);
  });

  it("v2-19. mode / concurrency 非法值当场 400", async () => {
    handle = createUiServer({ modelClient: new FakeModelClient([]), tools: [], workdir: process.cwd() });
    port = await startServer(handle);
    base = baseUrl(port);
    const post = (body: unknown) =>
      fetch(`${base}/api/runs`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });

    expect((await post({ task: "t", mode: "turbo" })).status).toBe(400);
    expect((await post({ task: "t", mode: "plan", concurrency: 99 })).status).toBe(400);
    expect((await post({ task: "t", mode: "plan", concurrency: "many" })).status).toBe(400);
    // planGate 只在编排模式下有意义——静默忽略会让界面与实际行为长期不一致
    expect((await post({ task: "t", planGate: true })).status).toBe(400);
    expect((await post({ task: "t", mode: "single", planGate: true })).status).toBe(400);
  });

  // ---- §5.1 计划确认门 ----

  /** 两子任务计划 + 每个子任务「执行一发 + 合法裁决一发」的完整脚本 */
  function gatedPlanScript() {
    const planJson = JSON.stringify({
      subtasks: [
        { id: "s1", title: "第一步", description: "做 A", acceptance: ["A 完成"], dependsOn: [] },
        { id: "s2", title: "第二步", description: "做 B", acceptance: ["B 完成"], dependsOn: ["s1"] },
      ],
    });
    const pass = () =>
      fakeMessage([textBlock(JSON.stringify({ passed: true, issues: [], summary: "通过" }))], "end_turn");
    return [
      fakeMessage([textBlock(["```json", planJson, "```"].join("\n"))], "end_turn"),
      fakeMessage([textBlock("s1 完成")], "end_turn"), pass(),
      fakeMessage([textBlock("s2 完成")], "end_turn"), pass(),
    ];
  }

  async function startGatedRun() {
    handle = createUiServer({
      modelClient: new FakeModelClient(gatedPlanScript()),
      tools: [autoTool("noop")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);
    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "需要签字的任务", mode: "plan", planGate: true }),
    })).json() as { runId: string };
    return runId;
  }

  /** 轮询直到计划门挂起（列表元数据由服务端持有，不必订阅 SSE——V-14 口径） */
  async function waitForPlanGate(runId: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const list = await (await fetch(`${base}/api/runs`)).json() as any[];
      const r = list.find((x) => x.runId === runId);
      if (r?.awaitingPlanApproval) return;
      if (r?.status === "done") throw new Error("run 已收尾但从未挂起计划门");
      await new Promise((r2) => setTimeout(r2, 20));
    }
    throw new Error("等待计划门超时");
  }

  it("v2-31. 计划门挂起时一个子任务都没发射；批准后照常跑完", async () => {
    const runId = await startGatedRun();
    await waitForPlanGate(runId);

    // 关键断言：此刻计划已产出，但零副作用——来源里不该有任何子任务前缀
    const midEvents = await readSSESnapshot(base, runId);
    expect(midEvents.some((e: any) => e.event.type === "plan"), "计划应已发出").toBe(true);
    expect(
      midEvents.some((e: any) => String(e.source).includes("/")),
      "签字前不得有任何子任务开跑",
    ).toBe(false);
    const req = midEvents.find((e: any) => e.event.type === "plan_approval_request");
    expect(req, "未发出 plan_approval_request").toBeDefined();
    // 门开着这件事要写进 plan 事件，否则前端会以为已经在跑了
    expect((midEvents.find((e: any) => e.event.type === "plan") as any).event.gated).toBe(true);

    const res = await fetch(`${base}/api/runs/${runId}/plan-approval`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(res.status).toBe(200);
    await waitForDone(base, runId);

    const events = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    // 决策进事件流（V-02 口径）：刷新后仍看得到谁在什么时候批的
    const resolved = events.find((e: any) => e.event.type === "plan_approval_resolved") as any;
    expect(resolved.event.decision).toBe("approve");
    expect(resolved.event.actor).toBe("user");
    expect(typeof resolved.event.at).toBe("number");
    // 批准之后子任务确实跑了
    expect(events.some((e: any) => String(e.source).startsWith("s1/"))).toBe(true);
    const result = events.find((e: any) => e.event.type === "plan_result") as any;
    expect(result.event.steps.map((st: any) => st.id)).toEqual(["s1", "s2"]);
  });

  it("v2-32. 否决 = 零子任务执行，且终止原因是 plan_rejected 而不是 error", async () => {
    const runId = await startGatedRun();
    await waitForPlanGate(runId);

    const res = await fetch(`${base}/api/runs/${runId}/plan-approval`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "reject" }),
    });
    expect(res.status).toBe(200);
    await waitForDone(base, runId);

    const events = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    expect(
      events.some((e: any) => String(e.source).includes("/")),
      "否决后不得有任何子任务执行",
    ).toBe(false);

    // 必须按 source 取：planner 自己那一轮也会发 done（stopReason=completed），
    // 不限定来源会取到它，测试就变成在断言 planner 的终止原因
    const done = events.find(
      (e: any) => e.event.type === "done" && e.source === "main",
    ) as any;
    expect(done, "未发出 main 段的 done").toBeDefined();
    // 否决是决定不是失败：混进 error 会让界面显示"异常终止"，那是对
    // 委托方自己的决定说谎（V-04 的教训）
    expect(done.event.stopReason).toBe("plan_rejected");
    expect(done.event.error, "否决不该带 error 负载").toBeUndefined();

    const end = events.find((e: any) => e.event.type === "run_end") as any;
    expect(end.event.outcome).toBe("rejected");
    expect(end.event.mainStopReason).toBe("plan_rejected");

    const list = await (await fetch(`${base}/api/runs`)).json() as any[];
    const summary = list.find((x) => x.runId === runId);
    expect(summary.stopReason).toBe("plan_rejected");
    expect(summary.planDecision).toBe("reject");
    expect(summary.awaitingPlanApproval).toBe(false);
  });

  it("v2-33. 计划门幂等：二次应答 409，且不改已记录的决策", async () => {
    const runId = await startGatedRun();
    await waitForPlanGate(runId);

    const post = (decision: string) =>
      fetch(`${base}/api/runs/${runId}/plan-approval`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });

    expect((await post("approve")).status).toBe(200);
    // 抢答/重复点击不能翻转已经签下的字
    expect((await post("reject")).status).toBe(409);
    await waitForDone(base, runId);

    const events = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    const resolvedAll = events.filter((e: any) => e.event.type === "plan_approval_resolved");
    expect(resolvedAll).toHaveLength(1);
    expect((resolvedAll[0] as any).event.decision).toBe("approve");

    expect((await post("approve")).status).toBe(409); // run 已收尾
    expect((await fetch(`${base}/api/runs/${runId}/plan-approval`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "maybe" }),
    })).status).toBe(409);
  });

  // ---- Web 宿主的 MCP 接线（案例 #8 前置修复）----

  it("v2-35. 默认不接 MCP，且快照如实说明原因（不是假装连上）", async () => {
    handle = createUiServer({ modelClient: new FakeModelClient([]), tools: [], workdir: process.cwd() });
    port = await startServer(handle);
    base = baseUrl(port);
    const snap = await (await fetch(`${base}/api/harness`)).json() as any;
    expect(snap.mcp.enabled).toBe(false);
    expect(snap.mcp.connected).toBe(false);
    expect(snap.mcp.toolCount).toBe(0);
    expect(String(snap.mcp.reason)).toContain("AGENT_UI_MCP");
  });

  it("v2-36. 开了 MCP 但配置读不到：失败必须看得见，不静默给出空工具面", async () => {
    /**
     * 这条锁的正是修复前的形态：`AGENT_UI_MCP=1` 只改快照文案，
     * `selectPackTools(pack, POOL, [])` 永远传空——于是 stm32-debug 那种
     * 全 MCP 工具面的包在 Web 宿主下静默变成"只有 read_file/write_file"，
     * 而界面还显示 MCP 已开启。静默降级比报错难查得多。
     */
    process.env.AGENT_UI_MCP = "1";
    process.env.AGENT_MCP_CONFIG = join(tmpdir(), "__no_such_mcp_config__.json");
    try {
      handle = createUiServer({
        modelClient: new FakeModelClient([fakeMessage([textBlock("done")], "end_turn")]),
        tools: [autoTool("noop")],
        workdir: process.cwd(),
      });
      port = await startServer(handle);
      base = baseUrl(port);

      // 连接是懒的：首个运行开始时才尝试
      const before = await (await fetch(`${base}/api/harness`)).json() as any;
      expect(before.mcp.enabled).toBe(true);
      expect(before.mcp.connected).toBe(false);
      expect(String(before.mcp.reason)).toContain("尚未连接");

      const { runId } = await (await fetch(`${base}/api/runs`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "触发一次连接尝试" }),
      })).json() as { runId: string };
      await waitForDone(base, runId);

      const after = await (await fetch(`${base}/api/harness`)).json() as any;
      expect(after.mcp.connected).toBe(false);
      expect(after.mcp.error, "配置读不到必须在快照里说出来").toBeDefined();
      expect(String(after.mcp.error)).toContain("MCP 配置");
      // 且不能再显示"尚未连接"——那会让人以为还没轮到它
      expect(after.mcp.reason).toBeUndefined();
    } finally {
      delete process.env.AGENT_UI_MCP;
      delete process.env.AGENT_MCP_CONFIG;
    }
  });

  it("v2-34. 宿主关停时计划门被宣告过期（挂着不解除，编排协程会永远吊在 onPlan）", async () => {
    const runId = await startGatedRun();
    await waitForPlanGate(runId);

    // 关停前先把连接开着——过期与 run_end 是关停途中推的，事后再拉就没了
    const res = await fetch(`${base}/api/runs/${runId}/events`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const seen: Record<string, unknown>[] = [];
    const drain = () => {
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = block.split("\n").filter((l) => l.startsWith("data:"));
        const name = block.split("\n").find((l) => l.startsWith("event:"));
        if (data.length === 0 || name) continue;
        seen.push(JSON.parse(data.map((l) => l.slice(5).trimStart()).join("\n")));
      }
    };
    // 先把已缓冲的重放读掉，确认门确实挂着
    const first = await reader.read();
    if (first.value) buffer += decoder.decode(first.value, { stream: true });
    drain();
    expect(seen.some((e: any) => e.event.type === "plan_approval_request")).toBe(true);

    await handle!.close();
    handle = undefined; // afterEach 不要再关一次

    // 读到流结束，收集关停途中推的事件
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      drain();
      if (done) break;
    }

    const expired = seen.find((e: any) => e.event.type === "plan_approval_expired") as any;
    expect(expired, "关停时未宣告计划门过期").toBeDefined();
    expect(expired.event.cause).toBe("run_finished");
    const end = seen.find((e: any) => e.event.type === "run_end") as any;
    expect(end.event.outcome).toBe("closed");
  });

  // ---- V-28 多轮对话 ----
  it("v2-20. 追加指令续跑同一会话：正史被带上，且第二轮能看到第一轮说过的话", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock("第一轮：我记住了暗号 alpha-7")], "end_turn"),
      fakeMessage([textBlock("第二轮：暗号是 alpha-7")], "end_turn"),
    ]);
    handle = createUiServer({ modelClient: model, tools: [autoTool("noop")], workdir: process.cwd() });
    port = await startServer(handle);
    base = baseUrl(port);

    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "记住暗号 alpha-7", verify: false }),
    })).json() as { runId: string };
    await waitForDone(base, runId);

    // 列表应报出"可以追加"——界面据此决定显示输入框，而不是点了才吃 409
    const list1 = await (await fetch(`${base}/api/runs`)).json() as any[];
    expect(list1.find((r) => r.runId === runId).canContinue).toBe(true);
    expect(list1.find((r) => r.runId === runId).conversationTurn).toBe(1);

    const res = await fetch(`${base}/api/runs/${runId}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "暗号是什么？" }),
    });
    expect(res.status).toBe(200);
    await waitForDone(base, runId);

    // 要害：第二次请求必须带着第一轮的正史，否则"多轮"只是两次独立单轮
    const secondReq = model.requests.at(-1)!;
    const flat = JSON.stringify(secondReq.messages);
    expect(flat, "第二轮没带上第一轮的正史").toContain("alpha-7");
    expect(flat).toContain("暗号是什么？");

    const events = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    const um = events.find((e: any) => e.event.type === "user_message") as any;
    expect(um, "追加的指令必须自己进事件流").toBeDefined();
    expect(um.event.text).toBe("暗号是什么？");
    expect(um.event.turn).toBe(2);

    const t = await (await fetch(`${base}/api/runs/${runId}/transcript`)).json() as any;
    expect(t.segments.length).toBeGreaterThanOrEqual(2);
  });

  it("v2-21. 追加的边界一律显式 409，并说清为什么", async () => {
    // ① 核查模式：runVerified 无续跑入口，追加会绕过已出具的裁决
    handle = createUiServer({
      modelClient: new FakeModelClient([
        fakeMessage([textBlock("done")], "end_turn"),
        fakeMessage([textBlock(JSON.stringify({ passed: true, issues: [], summary: "ok" }))], "end_turn"),
      ]),
      tools: [autoTool("noop")], workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);
    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "带核查", verify: true }),
    })).json() as { runId: string };
    await waitForDone(base, runId);

    const res = await fetch(`${base}/api/runs/${runId}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "再改一点" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toContain("裁决");

    const list = await (await fetch(`${base}/api/runs`)).json() as any[];
    expect(list.find((r) => r.runId === runId).canContinue).toBe(false);
  });

  it("v2-22. 空文本 400、未知 run 404", async () => {
    handle = createUiServer({
      modelClient: new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]),
      tools: [autoTool("noop")], workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);
    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "t", verify: false }),
    })).json() as { runId: string };
    await waitForDone(base, runId);

    const empty = await fetch(`${base}/api/runs/${runId}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    expect(empty.status).toBe(400);

    const missing = await fetch(`${base}/api/runs/nope/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });
    expect(missing.status).toBe(404);
  });

  // ---- V-29 工作目录白名单 ----
  it("v2-23. 工作目录只能从白名单里选，穿越尝试一律 400", async () => {
    const allowed = process.cwd();
    handle = createUiServer({
      modelClient: new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]),
      tools: [autoTool("noop")],
      workdir: allowed,
      workdirs: [join(allowed, "test")],
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const post = (body: unknown) =>
      fetch(`${base}/api/runs`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });

    // workdir 是工具的写入圈禁根——白名单外一律拒绝，且不能靠字符串前缀判定
    const outside = await post({ task: "t", workdir: "C:\Windows\System32" });
    expect(outside.status).toBe(400);
    expect((await outside.json() as any).error).toContain("白名单");

    // `..` 穿越必须在规范化后被挡住，而不是因为字面量不同才恰好被挡住
    const traversal = await post({ task: "t", workdir: join(allowed, "test", "..", "..") });
    expect(traversal.status).toBe(400);

    // 白名单内的路径放行
    expect((await post({ task: "t", workdir: join(allowed, "test") })).status).toBe(200);
  });

  it("v2-24. 快照列出合法工作目录；未声明时只有启动目录一个", async () => {
    handle = createUiServer({ modelClient: new FakeModelClient([]), tools: [], workdir: process.cwd() });
    port = await startServer(handle);
    const snap = await (await fetch(`${baseUrl(port)}/api/harness`)).json() as any;
    expect(snap.availableWorkdirs).toEqual([resolve(process.cwd())]);
  });

  it("v2-25. 本 run 的工作目录进 run_config，Tools 面据此报真值", async () => {
    const allowed = process.cwd();
    const sub = join(allowed, "test");
    handle = createUiServer({
      modelClient: new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]),
      tools: [autoTool("noop")], workdir: allowed, workdirs: [sub],
    });
    port = await startServer(handle);
    base = baseUrl(port);
    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "t", workdir: sub }),
    })).json() as { runId: string };
    await waitForDone(base, runId);

    const events = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    const rc = events.find((e: any) => e.event.type === "run_config") as any;
    expect(rc.event.workdir).toBe(resolve(sub));
  });

  // ---- V-30 角色模型 ----
  it("v2-26. 角色模型快照只报名字与 provider，绝不下发密钥或 baseURL", async () => {
    process.env.AGENT_VERIFIER_MODEL = "strong-verifier";
    process.env.AGENT_VERIFIER_API_KEY = "sk-must-not-leak";
    process.env.AGENT_VERIFIER_BASE_URL = "https://secret.internal/v1";
    try {
      handle = createUiServer({ modelClient: new FakeModelClient([]), tools: [], workdir: process.cwd() });
      port = await startServer(handle);
      const raw = await (await fetch(`${baseUrl(port)}/api/harness`)).text();

      const snap = JSON.parse(raw);
      expect(snap.roleModels.verifier).toEqual({
        model: "strong-verifier", provider: "anthropic", configured: true,
      });
      expect(snap.roleModels.planner.configured).toBe(false);
      // 整份快照的字节里都不能出现密钥或内网端点
      expect(raw).not.toContain("sk-must-not-leak");
      expect(raw).not.toContain("secret.internal");
    } finally {
      delete process.env.AGENT_VERIFIER_MODEL;
      delete process.env.AGENT_VERIFIER_API_KEY;
      delete process.env.AGENT_VERIFIER_BASE_URL;
    }
  });

  it("v2-27. run_config 报的是本 run 实际用的角色模型——关掉后应为 null", async () => {
    process.env.AGENT_VERIFIER_MODEL = "strong-verifier";
    try {
      handle = createUiServer({
        modelClient: new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]),
        tools: [autoTool("noop")], workdir: process.cwd(),
      });
      port = await startServer(handle);
      base = baseUrl(port);
      const start = async (body: unknown) => {
        const { runId } = await (await fetch(`${base}/api/runs`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        })).json() as { runId: string };
        await waitForDone(base, runId);
        const events = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
        return (events.find((e: any) => e.event.type === "run_config") as any).event.roleModels;
      };

      expect((await start({ task: "默认启用" })).verifier).toBe("strong-verifier");
      // A/B 对照臂：显式关掉就该报"与执行者同一个"，配了什么不等于用了什么
      expect((await start({ task: "显式关掉", useVerifierModel: false })).verifier).toBeNull();
    } finally {
      delete process.env.AGENT_VERIFIER_MODEL;
    }
  });

  // ---- V-31 视觉模型（第四个角色） ----
  it("v2-28. 配了 AGENT_VISION_MODEL 才注册 describe_image；没配就不该摆在工具面上", async () => {
    // 没配：工具面里不该出现一个一调用就报错的工具，那是在骗模型说自己能看图
    handle = createUiServer({ modelClient: new FakeModelClient([]), workdir: process.cwd() });
    port = await startServer(handle);
    let snap = await (await fetch(`${baseUrl(port)}/api/harness`)).json() as any;
    expect(snap.tools.map((t: any) => t.name)).not.toContain("describe_image");
    expect(snap.roleModels.vision.configured).toBe(false);
    await handle.close();

    // 配上（Kimi 形态：OpenAI 兼容端点）
    process.env.AGENT_VISION_MODEL = "moonshot-v1-8k-vision-preview";
    process.env.AGENT_VISION_PROVIDER = "openai";
    process.env.AGENT_VISION_BASE_URL = "https://api.moonshot.cn/v1";
    process.env.AGENT_VISION_API_KEY = "sk-vision-must-not-leak";
    try {
      handle = createUiServer({ modelClient: new FakeModelClient([]), workdir: process.cwd() });
      port = await startServer(handle);
      const raw = await (await fetch(`${baseUrl(port)}/api/harness`)).text();
      snap = JSON.parse(raw);

      const vision = snap.tools.find((t: any) => t.name === "describe_image");
      expect(vision, "配了视觉模型却没注册工具").toBeDefined();
      expect(vision.origin).toBe("builtin");
      // 把本地文件送到另一个端点，属于要审批的动作
      expect(vision.permission).toBe("ask");

      expect(snap.roleModels.vision).toEqual({
        model: "moonshot-v1-8k-vision-preview", provider: "openai", configured: true,
      });
      // 密钥与端点一律不下发
      expect(raw).not.toContain("sk-vision-must-not-leak");
      expect(raw).not.toContain("api.moonshot.cn");
    } finally {
      for (const k of ["MODEL", "PROVIDER", "BASE_URL", "API_KEY"]) {
        delete process.env[`AGENT_VISION_${k}`];
      }
    }
  });

  // ---- V-34 附件上传 ----
  it("v2-29. 上传落进工作目录下的 uploads/，返回相对路径", async () => {
    const dir = await mkdtemp(join(tmpdir(), "upload-"));
    try {
      handle = createUiServer({ modelClient: new FakeModelClient([]), tools: [], workdir: dir });
      port = await startServer(handle);
      base = baseUrl(port);

      const res = await fetch(`${base}/api/upload`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "shot.png", data: Buffer.from("hello").toString("base64") }),
      });
      expect(res.status).toBe(200);
      const info = await res.json() as any;
      // 返回相对路径——那正是 agent 的工具能直接用的形式
      expect(info.path).toBe("uploads/shot.png");
      expect(info.bytes).toBe(5);
      expect(await readFile(join(dir, "uploads", "shot.png"), "utf8")).toBe("hello");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * 文件名是完全用户可控的字符串，直接拼路径是最经典的穿越面。
   * 上传虽然是"用户自己在写"（不走审批门），但写入边界一步都不能放松——
   * 它和工具的圈禁根是同一条线。
   */
  it("v2-30. 文件名穿越一律被消毒，写不出 uploads/ 之外", async () => {
    const dir = await mkdtemp(join(tmpdir(), "upload-"));
    try {
      handle = createUiServer({ modelClient: new FakeModelClient([]), tools: [], workdir: dir });
      port = await startServer(handle);
      base = baseUrl(port);
      const put = (name: string) =>
        fetch(`${baseUrl(port)}/api/upload`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, data: Buffer.from("x").toString("base64") }),
        });

      for (const evil of ["../escaped.txt", "../../escaped.txt", "sub/dir/escaped.txt", "..\\escaped.txt"]) {
        const r = await put(evil);
        expect([200, 400], `${evil} 应被消毒或拒绝`).toContain(r.status);
        if (r.status === 200) {
          const info = await r.json() as any;
          expect(info.path.startsWith("uploads/"), `${evil} 逃出了 uploads/`).toBe(true);
          expect(info.path).not.toContain("..");
          expect(resolve(info.absolutePath).startsWith(resolve(join(dir, "uploads")))).toBe(true);
        }
      }
      // 工作目录里除 uploads/ 外不该多出任何东西
      const top = await readdir(dir);
      expect(top).toEqual(["uploads"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("v2-31. 上传目标目录也受白名单约束", async () => {
    const dir = await mkdtemp(join(tmpdir(), "upload-"));
    try {
      handle = createUiServer({ modelClient: new FakeModelClient([]), tools: [], workdir: dir });
      port = await startServer(handle);
      const res = await fetch(`${baseUrl(port)}/api/upload`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "a.txt", data: "eA==", workdir: tmpdir() }),
      });
      expect(res.status).toBe(400);
      expect((await res.json() as any).error).toContain("白名单");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("v2-32. 超限与畸形输入给出可读拒绝", async () => {
    const dir = await mkdtemp(join(tmpdir(), "upload-"));
    try {
      handle = createUiServer({ modelClient: new FakeModelClient([]), tools: [], workdir: dir });
      port = await startServer(handle);
      const post = (body: unknown) =>
        fetch(`${baseUrl(port)}/api/upload`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });

      expect((await post({ data: "eA==" })).status).toBe(400);
      expect((await post({ name: "a.txt" })).status).toBe(400);
      const big = await post({ name: "big.bin", data: Buffer.alloc(21_000_000).toString("base64") });
      expect(big.status).toBe(400);
      expect((await big.json() as any).error).toContain("过大");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * 实测踩到的：allowedWorkdirs 存的是 resolve() 后的绝对路径，而 options.workdir
   * 可能写成 `D:/a/b`（正斜杠）。不在源头归一的话，**默认工作目录会过不了
   * 自己的白名单**。单测此前没抓到，是因为 mkdtemp 本来就返回规范化路径。
   */
  it("v2-33. 非规范写法的 workdir 在源头归一，默认路径不会自己拒绝自己", async () => {
    const dir = await mkdtemp(join(tmpdir(), "norm-"));
    try {
      // 故意用正斜杠 + 末尾斜杠的写法
      const messy = dir.split(sep).join("/") + "/";
      handle = createUiServer({ modelClient: new FakeModelClient([]), tools: [], workdir: messy });
      port = await startServer(handle);
      base = baseUrl(port);

      const snap = await (await fetch(`${base}/api/harness`)).json() as any;
      expect(snap.availableWorkdirs).toEqual([resolve(dir)]);

      // 不传 workdir 的上传必须成功——这正是之前失败的那条路径
      const res = await fetch(`${base}/api/upload`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "a.txt", data: "eA==" }),
      });
      expect(res.status, await res.text()).toBe(200);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ---- V-10 全局生命周期流（取代 3 秒轮询）----
  it("v2-12. /api/stream 先发快照，再推 run_created / run_finished", async () => {
    handle = createUiServer({
      modelClient: new FakeModelClient([fakeMessage([textBlock("done")], "end_turn")]),
      tools: [autoTool("noop")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const res = await fetch(`${base}/api/stream`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const seen: Record<string, unknown>[] = [];

    // 后台读取循环：不能用 Promise.race(read, timer) 去"轮询"——输掉比赛的那个
    // read 仍会 resolve，它带回的 chunk 就被静默丢弃了（首版这么写，结果只收到快照）
    let buffer = "";
    const pumping = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const line = block.split("\n").find((l) => l.startsWith("data:"));
            if (line) seen.push(JSON.parse(line.slice(5).trimStart()));
          }
        }
      } catch {
        // reader.cancel() 会让 read 抛错，属正常收尾
      }
    })();

    const waitFor = async (pred: () => boolean, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && !pred()) {
        await new Promise((r) => setTimeout(r, 25));
      }
    };

    try {
      await waitFor(() => seen.length > 0, 1000);
      // 订阅即得当前快照——客户端不必额外拉一次 /api/runs
      expect((seen[0] as any).type).toBe("snapshot");
      expect(Array.isArray((seen[0] as any).runs)).toBe(true);

      await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "lifecycle", verify: false }),
      });
      await waitFor(() => seen.some((s: any) => s.type === "run_finished"));
    } finally {
      await reader.cancel().catch(() => {});
      await pumping;
    }

    const created = seen.find((s: any) => s.type === "run_created") as any;
    const finished = seen.find((s: any) => s.type === "run_finished") as any;
    expect(created).toBeDefined();
    expect(created.run.task).toBe("lifecycle");
    expect(created.run.status).toBe("running");
    expect(finished).toBeDefined();
    expect(finished.run.status).toBe("done");
    // 列表元数据由服务端算好：侧栏不再依赖"这个 run 是否被订阅过"
    expect(finished.run.finishedAt).not.toBeNull();
    expect(finished.run).toHaveProperty("stopReason");
    expect(finished.run).toHaveProperty("pendingApprovals");
  });
});

// ================================================================
// 产物取件（委托方："生成的文件有没有办法有超链接直接点击打开"）
// ================================================================

describe("产物取件：圈禁比功能更要紧", () => {
  let handle: Awaited<ReturnType<typeof createUiServer>>;
  let base: string;
  let dir: string;
  let runId: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "artifact-"));
    await writeFile(join(dir, "report.html"), "<h1>产物</h1>", "utf8");
    await writeFile(join(dir, "notes.md"), "# 标题", "utf8");
    await mkdir(join(dir, "sub"), { recursive: true });

    handle = createUiServer({
      modelClient: new FakeModelClient([fakeMessage([textBlock("done")], "end_turn")]),
      workdir: dir,
    });
    const port = await startServer(handle);
    base = baseUrl(port);
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "生成报告" }),
    });
    runId = (await res.json()).runId;
  });

  afterAll(async () => {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  });

  const get = (path: string, extra = "") =>
    fetch(`${base}/api/runs/${runId}/artifact?path=${encodeURIComponent(path)}${extra}`);

  it("取回文件内容，并按扩展名给出 content-type", async () => {
    const res = await get("report.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("产物");
  });

  it("download=1 走 attachment，默认走 inline（预览与下载是两件事）", async () => {
    expect((await get("notes.md")).headers.get("content-disposition")).toMatch(/^inline/);
    expect((await get("notes.md", "&download=1")).headers.get("content-disposition")).toMatch(/^attachment/);
  });

  /**
   * 预览的是**模型生成的 HTML**。不加 CSP 就等于让它在宿主同源下执行任意 JS，
   * 而同源意味着它能读 `/api/*`——包括别的运行的会话正文。
   */
  it("预览响应带 CSP 且禁脚本，并带 nosniff", async () => {
    const res = await get("report.html");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it.each([
    ["../outside.txt", "上跳一级"],
    ["../../etc/passwd", "上跳多级"],
    ["sub/../../outside.txt", "绕一圈再跳"],
    ["C:\\\\Windows\\\\win.ini", "Windows 绝对路径"],
    ["/etc/passwd", "POSIX 绝对路径"],
  ])("拒绝逃出工作目录的路径：%s（%s）", async (p) => {
    const res = await get(p);
    expect([400, 404]).toContain(res.status);
    const body = await res.text();
    expect(body).not.toContain("root:");
    expect(body).not.toContain("[fonts]");
  });

  it("目录一律 404——否则等于开了目录浏览", async () => {
    expect((await get("sub")).status).toBe(404);
    expect((await get(".")).status).toBe(404);
  });

  it("不存在的文件 404 而不是 500", async () => {
    expect((await get("nope.txt")).status).toBe(404);
  });

  it("未知 runId 取不到任何东西（路径按该 run 自己的 workdir 解析）", async () => {
    const res = await fetch(`${base}/api/runs/not-a-run/artifact?path=report.html`);
    expect(res.status).toBe(404);
  });

  it("缺 path 参数不当成一次取件——落到未知路由（404），不会去读任何文件", async () => {
    // 与静态资源的 `..` 一样归入 malformed：判据统一在一处，不为这一个参数另开分支
    expect((await fetch(`${base}/api/runs/${runId}/artifact?`)).status).toBe(404);
  });

  it("认不出的扩展名按 octet-stream + nosniff，让浏览器下载而不是猜着执行", async () => {
    await writeFile(join(dir, "blob.weird"), "x", "utf8");
    const res = await get("blob.weird");
    expect(res.headers.get("content-type")).toContain("application/octet-stream");
  });
});

describe("在文件夹中显示：从网页请求启动本机进程，圈禁只能更严", () => {
  let handle: Awaited<ReturnType<typeof createUiServer>>;
  let base: string;
  let dir: string;
  let runId: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "reveal-"));
    await writeFile(join(dir, "ok.txt"), "x", "utf8");
    handle = createUiServer({ modelClient: new FakeModelClient([fakeMessage([textBlock("done")], "end_turn")]), workdir: dir });
    const port = await startServer(handle);
    base = baseUrl(port);
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "t" }),
    });
    runId = (await res.json()).runId;
  });

  afterAll(async () => {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  });

  const reveal = (path: unknown) =>
    fetch(`${base}/api/runs/${runId}/reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });

  it.each([
    ["../../secret.txt", "上跳"],
    ["/etc/passwd", "绝对路径"],
  ])("拒绝逃出工作目录：%s（%s）", async (p) => {
    expect((await reveal(p)).status).toBe(400);
  });

  it("文件不存在 → 404，不启动任何进程", async () => {
    expect((await reveal("nope.txt")).status).toBe(404);
  });

  it("缺 path / 非 JSON 体 → 400", async () => {
    expect((await reveal("")).status).toBe(400);
    const res = await fetch(`${base}/api/runs/${runId}/reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  /**
   * 命令**必须以参数数组的形式**交给 spawn。拼成 shell 串就等于把文件名
   * 交给命令行解析器——一个含 `&` 或反引号的文件名即可执行任意命令。
   */
  it("revealCommand 返回参数数组，且不含 shell 元字符拼接", () => {
    const cmd = revealCommand("/tmp/a b & c.txt");
    if (!cmd) return; // 不支持的平台返回 null，本身就是安全的
    expect(Array.isArray(cmd.args)).toBe(true);
    expect(cmd.file).not.toContain(" ");
    // 文件名原样落在某个参数里，而不是被拼进一条串
    expect(cmd.args.some((a) => a.includes("a b & c.txt"))).toBe(true);
  });

  it("contentTypeOf：源码按纯文本，未知按 octet-stream", () => {
    expect(contentTypeOf("x.html")).toContain("text/html");
    expect(contentTypeOf("x.ts")).toContain("text/plain");
    expect(contentTypeOf("x.py")).toContain("text/plain");
    expect(contentTypeOf("x.bin")).toContain("application/octet-stream");
    // 大小写不敏感
    expect(contentTypeOf("X.PNG")).toContain("image/png");
  });
});

describe("凭据装载：npm 脚本必须自己读 .env", () => {
  /**
   * 实测事故：key 只活在"启动那个服务的那个终端"里。终端找不回来之后，
   * 运行中的服务还在用它，而任何人（包括我）都无法再起一个等价的实例——
   * 于是"更新到新版"变成了"先丢掉凭据再丢掉历史"。
   * **凭据的存放位置本身就该是可复现的。**
   *
   * 用 Node 自带的 `--env-file-if-exists`：零依赖，且文件不存在时照旧走进程
   * 环境变量（不能因为没有 .env 就把已经配好环境的用户挡在外面）。
   */
  it("所有会调模型的入口都带 --env-file-if-exists", () => {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8"),
    );
    for (const name of ["cli", "ui", "eval", "ab", "lab", "smoke:local"]) {
      expect(pkg.scripts[name], `${name} 不会读 .env`).toContain("--env-file-if-exists=.env");
    }
  });

  it(".env 必须被 gitignore——凭据绝不进仓库", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const ignored = readFileSync(join(root, ".gitignore"), "utf-8").split(/\r?\n/);
    expect(ignored).toContain(".env");
    // 而模板要进仓库：新机器上得知道该填哪些字段
    expect(existsSync(join(root, ".env.example"))).toBe(true);
  });

  it("模板里所有敏感字段都是空值——不能提交一个填着真 key 的样例", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const text = readFileSync(join(root, ".env.example"), "utf-8");
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("#") || !line.includes("=")) continue;
      const [k, v] = line.split("=", 2);
      if (/KEY|TOKEN|SECRET/i.test(k!)) {
        expect(v!.trim(), `${k} 在模板里有值`).toBe("");
      }
    }
  });
});

describe("本次对话常驻放行：省的是点击，不是记录", () => {
  let handle: Awaited<ReturnType<typeof createUiServer>>;
  let base: string;

  afterEach(async () => {
    await handle?.close();
  });

  /** 每次调用都要审批的工具；模型连着调它三次 */
  const askEvery = (name: string) => makeTool({ name, permission: "ask", parallelSafe: false });

  async function startRunCallingThrice(): Promise<{ runId: string }> {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("t1", "danger", {})], "tool_use"),
      fakeMessage([toolUseBlock("t2", "danger", {})], "tool_use"),
      fakeMessage([toolUseBlock("t3", "danger", {})], "tool_use"),
      fakeMessage([textBlock("done")], "end_turn"),
    ]);
    handle = createUiServer({ modelClient: model, tools: [askEvery("danger")], workdir: process.cwd() });
    base = baseUrl(await startServer(handle));
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "连着调三次" }),
    });
    return { runId: (await res.json()).runId };
  }

  const firstPending = async (runId: string) => {
    for (let i = 0; i < 60; i++) {
      const list = await (await fetch(`${base}/api/runs`)).json();
      const r = list.find((x: any) => x.runId === runId);
      if (r?.pendingApprovals > 0) {
        const evs = await readSSESnapshot(base, runId);
        const req = evs.filter((e: any) => (e.event as any)?.type === "approval_request").at(-1) as any;
        return `${req.event.toolUseId}#${req.seq}`;
      }
      await new Promise((r2) => setTimeout(r2, 50));
    }
    throw new Error("没等到审批请求");
  };

  it("建规则之后同名工具不再挂起，run 自己跑完", async () => {
    const { runId } = await startRunCallingThrice();
    const ref = await firstPending(runId);
    const res = await fetch(`${base}/api/runs/${runId}/approvals/${encodeURIComponent(ref)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow", scope: "conversation" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).autoAllow).toContain("danger");

    await waitForDone(base, runId);
    const list = await (await fetch(`${base}/api/runs`)).json();
    expect(list.find((x: any) => x.runId === runId).pendingApprovals).toBe(0);
  });

  /**
   * **这条是这个功能能不能上的分界线。**
   * 自动放行必须照样进事件流并标 `actor: "auto-rule"`——
   * 事后回看要分得清哪一步是人点的、哪一步是规则放的。
   * 分不清的审计记录比多点几下危险得多。
   */
  it("自动放行照样进事件流，且标明不是人点的", async () => {
    const { runId } = await startRunCallingThrice();
    const ref = await firstPending(runId);
    await fetch(`${base}/api/runs/${runId}/approvals/${encodeURIComponent(ref)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow", scope: "conversation" }),
    });
    await waitForDone(base, runId);

    const evs = await readSSESnapshot(base, runId);
    const resolved = evs.filter((e: any) => (e.event as any)?.type === "approval_resolved") as any[];
    expect(resolved.length, "三次调用应当有三条决策记录").toBe(3);
    expect(resolved[0].event.actor, "第一次是人点的").toBe("user");
    expect(resolved[0].event.scope, "建规则那次要标出来").toBe("conversation");
    for (const r of resolved.slice(1)) {
      expect(r.event.actor, "自动放行必须标 auto-rule，不能冒充人点的").toBe("auto-rule");
      expect(r.event.decision).toBe("allow");
    }
  });

  /** 规则**逐工具名**——放行 read_file 不等于放行 bash */
  it("规则只覆盖同名工具，别的照样问", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("t1", "alpha", {})], "tool_use"),
      fakeMessage([toolUseBlock("t2", "beta", {})], "tool_use"),
      fakeMessage([textBlock("done")], "end_turn"),
    ]);
    handle = createUiServer({
      modelClient: model,
      tools: [askEvery("alpha"), askEvery("beta")],
      workdir: process.cwd(),
    });
    base = baseUrl(await startServer(handle));
    const runId = (await (await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "两个不同工具" }),
    })).json()).runId;

    const ref = await firstPending(runId);
    await fetch(`${base}/api/runs/${runId}/approvals/${encodeURIComponent(ref)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow", scope: "conversation" }),
    });
    // beta 不在规则里，必须仍然挂起等人
    const ref2 = await firstPending(runId);
    expect(ref2.startsWith("t2"), "beta 应当照样问").toBe(true);
  });

  /** "以后都拒绝"没有用例：模型拿到 deny 会换做法，常驻拒绝等于让它反复撞墙 */
  it("scope 只对 allow 生效，deny 不建规则", async () => {
    const { runId } = await startRunCallingThrice();
    const ref = await firstPending(runId);
    const res = await fetch(`${base}/api/runs/${runId}/approvals/${encodeURIComponent(ref)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "deny", reason: "不行", scope: "conversation" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).autoAllow).toBeUndefined();
    // 下一次调用仍要人点
    await firstPending(runId);
  });
});

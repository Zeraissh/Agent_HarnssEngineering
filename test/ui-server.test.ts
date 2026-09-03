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
import { request as httpRequest } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createUiServer,
  contentTypeOf,
  localPathTarget,
  planGateStopReason,
  meterModelClient,
  revealCommand,
  runOutcomeForStopReason,
  canonicalizeApprovalInput,
  approvalInputHash,
  type UiServerHandle,
} from "../ui/server.js";
import { resolvePlannerMaxTurns } from "../src/planner.js";
import { PLAN_TOOL_NAME } from "../src/planner.js";
import { REQUIREMENTS_TOOL_NAME } from "../src/clarifier.js";
import { FINISH_TASK_TOOL_NAME } from "../src/task-completion.js";
import { VERDICT_TOOL_NAME } from "../src/verifier.js";
import { PACKS } from "../src/presets.js";
import { bashTool } from "../src/tools/bash.js";
import { DEFAULT_HISTORY_KEEP, historyKeepCount, historyRootPath } from "../ui/history.js";
import { startMockProvider } from "../eval/mock-provider.js";
import {
  FakeModelClient,
  fakeMessage,
  makeTool,
  textBlock,
  toolUseBlock,
} from "./helpers.js";
import type {
  Tool,
  ModelClient,
  ModelRequest,
  ModelTurn,
  StreamDelta,
  ExecutionBroker,
  ExecutionBoundaryStatus,
} from "../src/types.js";

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

describe("SSE reverse-proxy keepalive", () => {
  let handle: UiServerHandle | undefined;
  afterEach(async () => { await handle?.close(); handle = undefined; });

  it("生命周期流禁用 nginx buffering，并在空窗发送注释心跳", async () => {
    handle = createUiServer({
      modelClient: new FakeModelClient([]), tools: [], workdir: process.cwd(), sseHeartbeatMs: 20,
    });
    const base = baseUrl(await startServer(handle));
    const controller = new AbortController();
    const response = await fetch(`${base}/api/stream`, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 2000;
    while (!text.includes(": heartbeat\n\n") && Date.now() < deadline) {
      const { value } = await reader.read();
      if (value) text += decoder.decode(value);
    }
    controller.abort();
    expect(text).toContain(": heartbeat\n\n");

    const created = await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "sse header" }),
    });
    const { runId } = await created.json() as { runId: string };
    const events = await fetch(`${base}/api/runs/${runId}/events`);
    expect(events.headers.get("x-accel-buffering")).toBe("no");
    await events.body?.cancel();
  });
});

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

/**
 * 等待 run 变为 done。截止线 15s 而非固定 50 次轮询：旧预算 ~2.5s 在
 * 满载 CI 跑道上会把慢跑误伤成失败（2026-08-24 CI 实测一例，本地与
 * 重跑均绿）；真卡死的 run 仍然会在截止线处红。
 */
async function waitForDone(base: string, runId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
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

  it("静态图标库只读本地固定文件，CSS 与字体 MIME 正确", async () => {
    handle = createUiServer({
      modelClient: new FakeModelClient([]),
      tools: [],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const css = await fetch(`${base}/vendor/phosphor/style.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toContain('font-family: "Phosphor"');

    const font = await fetch(`${base}/vendor/phosphor/Phosphor.woff2`);
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toContain("font/woff2");
    expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(1000);

    const hiddenDependency = await fetch(`${base}/vendor/phosphor/selection.json`);
    expect(hiddenDependency.status).toBe(404);
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
    // planner 预算同款（B0）：数字 + 来源，缺一不可。
    // 不写死数字（初版写 12，kicad 声明 plan.maxTurns 当天就过期了）——
    // 锁的是"快照与解析器同答案"这条装配一致性，数字归 presets 管
    expect(snap.plannerBudgetTurns).toBe(resolvePlannerMaxTurns(Object.values(PACKS)));
    expect(snap.plannerBudgetSource).toBe(
      Object.values(PACKS).some((p) => p.plan?.maxTurns !== undefined) ? "pack" : "default",
    );
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

  it("v2-8b. Web 宿主接入 memory 工具与快照", async () => {
    handle = createUiServer({
      modelClient: new FakeModelClient([]),
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const snap = await (await fetch(`${base}/api/harness`)).json() as any;
    const memoryTools = snap.tools.filter((t: { name: string }) => t.name.startsWith("memory_"));
    expect(memoryTools.map((t: { name: string }) => t.name).sort()).toEqual([
      "memory_delete",
      "memory_list",
      "memory_read",
      "memory_write",
    ]);
    expect(memoryTools.every((t: { origin: string }) => t.origin === "memory")).toBe(true);
    expect(snap.memory.enabled).toBe(true);
    expect(snap.memory.toolCount).toBe(4);
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

  it("planner 的自答 deny 不进入 Web 审批表，宿主不能抢答或创建 grant", async () => {
    let executed = 0;
    let releaseSecond!: () => void;
    let markSecondEntered!: () => void;
    const secondGate = new Promise<void>((resolveGate) => { releaseSecond = resolveGate; });
    const secondEntered = new Promise<void>((resolveEntered) => { markSecondEntered = resolveEntered; });
    const planJson = JSON.stringify({
      subtasks: [{ id: "s1", title: "只读计划", description: "完成任务", acceptance: ["完成"], dependsOn: [] }],
    });
    const script = [
      fakeMessage([toolUseBlock("planner_danger", "danger", { target: "same" })], "tool_use"),
      fakeMessage([textBlock(planJson)], "end_turn"),
      fakeMessage([textBlock("s1 done")], "end_turn"),
      fakeMessage([textBlock(JSON.stringify({ passed: true, issues: [], summary: "通过" }))], "end_turn"),
    ];
    let call = 0;
    const model: ModelClient = {
      send: async () => {
        const index = call++;
        const message = script[index];
        if (!message) throw new Error(`planner approval script exhausted at ${index + 1}`);
        if (index === 1) {
          markSecondEntered();
          await secondGate;
        }
        return { message, stopReason: message.stop_reason, usage: message.usage };
      },
    };
    const danger = makeTool({
      name: "danger",
      permission: "ask",
      approvalPolicy: { maxScope: "exact-input", maxTtlMs: 60_000, maxUses: 5 },
      execute: async () => { executed += 1; return { content: "must not execute" }; },
    });
    handle = createUiServer({ modelClient: model, tools: [danger], workdir: process.cwd() });
    port = await startServer(handle);
    base = baseUrl(port);
    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "planner 只读审批", mode: "plan", concurrency: 1 }),
    })).json() as { runId: string };

    await secondEntered;
    try {
      const snapshot = await readSSESnapshot(base, runId) as any[];
      const request = snapshot.find((item) => item.source === "planner" && item.event.type === "approval_request");
      expect(request, "planner approval_request 应保留为只读审计事件").toBeDefined();
      const summary = ((await (await fetch(`${base}/api/runs`)).json()) as any[])
        .find((item) => item.runId === runId);
      expect(summary.pendingApprovals).toBe(0);
      const attempted = await fetch(
        `${base}/api/runs/${runId}/approvals/${encodeURIComponent(`${request.event.toolUseId}#${request.seq}`)}`,
        {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: "allow", scope: "conversation" }),
        },
      );
      expect(attempted.status).toBe(404);
      expect(executed).toBe(0);
    } finally {
      releaseSecond();
    }
    await waitForDone(base, runId);
    const events = await readSSESnapshot(base, runId) as any[];
    expect(events.some((item) => item.event.grantId || item.event.actor === "auto-rule")).toBe(false);
    expect(executed).toBe(0);
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

  /**
   * B1 顺带修出的缺陷：此前 PlanRejectedError 的两种 cause 都被写成
   * plan_rejected，前端 plan_gate_expired 分档从未触发。expired 的唯一触发
   * 路径是宿主关停——关停后 SSE 已断、HTTP 已关，集成层观测不到那条缓冲
   * 事件（B2 运行历史落盘后才会浮出水面），所以映射在纯函数层钉住。
   */
  it("计划门两种收场必须分开：否决 → plan_rejected，未应答 → plan_gate_expired", () => {
    expect(planGateStopReason("rejected")).toBe("plan_rejected");
    expect(planGateStopReason("expired")).toBe("plan_gate_expired");
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

  it("SAFE-05. Web 为 run 固定独立 broker，并把真实 boundary 写进 run_config", async () => {
    const calls: { runId: string; workdir: string; command?: string }[] = [];
    const brokers = new Map<string, ExecutionBroker>();
    handle = createUiServer({
      modelClient: new FakeModelClient([
        fakeMessage([toolUseBlock("tu_exec", "bash", { command: "echo broker" })], "tool_use"),
        fakeMessage([textBlock("done")], "end_turn"),
      ]),
      tools: [{ ...bashTool, permission: "auto" }],
      workdir: process.cwd(),
      executionBrokerFactory: (runId, runWorkdir) => {
        calls.push({ runId, workdir: runWorkdir });
        const boundary: ExecutionBoundaryStatus = {
          schemaVersion: 1,
          boundaryId: runId,
          requestedMode: "required",
          requestedBackend: "oci",
          effectiveState: "partial",
          resolvedBackend: "oci",
          policyDigest: "d".repeat(64),
          probe: { state: "ready", candidate: "oci", runtimeVersion: "fake" },
          coverage: ["bash"],
          filesystem: "ro root + rw workdir",
          network: "none",
          identity: "uid 65532",
          resources: "limited",
        };
        const broker: ExecutionBroker = {
          boundaryId: runId,
          status: () => boundary,
          probe: async () => boundary,
          executeShell: async (request) => {
            calls.push({ runId, workdir: request.cwd, command: request.command });
            return {
              stdout: "broker-ok\n", stderr: "", exitCode: 0, signal: null,
              timedOut: false, aborted: false, outputLimitExceeded: false,
              cleanup: "runtime-rm", status: boundary,
            };
          },
        };
        brokers.set(runId, broker);
        return broker;
      },
    });
    port = await startServer(handle);
    base = baseUrl(port);
    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "broker binding" }),
    })).json() as { runId: string };
    await waitForDone(base, runId);
    const events = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    const rc = events.find((event: any) => event.event.type === "run_config") as any;
    expect(rc.event.executionIsolation).toMatchObject({
      boundaryId: runId,
      effectiveState: "partial",
      resolvedBackend: "oci",
      coverage: ["bash"],
    });
    expect(brokers.get(runId)).toBeDefined();
    expect(calls.filter((call) => call.command)).toEqual([
      { runId, workdir: resolve(process.cwd()), command: "echo broker" },
    ]);
    expect(calls.filter((call) => !call.command)).toEqual([
      { runId: "process-capability-probe", workdir: resolve(process.cwd()) },
      { runId, workdir: resolve(process.cwd()) },
    ]);
  });

  it("SAFE-05. 已完成 run 的 follow-up 换用新 broker，绝不复用已释放实例", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock("first done")], "end_turn"),
      fakeMessage([toolUseBlock("tu_followup_bash", "bash", { command: "echo follow-up" })], "tool_use"),
      fakeMessage([textBlock("follow-up done")], "end_turn"),
    ]);
    const boundaryFor = (boundaryId: string): ExecutionBoundaryStatus => ({
      schemaVersion: 1,
      boundaryId,
      requestedMode: "required",
      requestedBackend: "oci",
      effectiveState: "partial",
      resolvedBackend: "oci",
      policyDigest: "7".repeat(64),
      probe: { state: "ready", candidate: "oci" },
      coverage: ["bash"],
      filesystem: "ro root + rw workdir",
      network: "none",
      identity: "uid 65532",
      resources: "limited",
    });
    const processBoundary = boundaryFor("process-probe");
    const processBroker: ExecutionBroker = {
      boundaryId: processBoundary.boundaryId,
      status: () => processBoundary,
      probe: async () => processBoundary,
      executeShell: async (request) => ({
        stdout: "", stderr: "", exitCode: 0, signal: null,
        timedOut: false, aborted: request.signal.aborted, outputLimitExceeded: false,
        cleanup: "runtime-rm", status: processBoundary,
      }),
    };
    const created: Array<{
      runId: string;
      disposed: boolean;
      commands: string[];
    }> = [];

    handle = createUiServer({
      modelClient: model,
      tools: [{ ...bashTool, permission: "auto" }],
      workdir: process.cwd(),
      executionProbeBroker: processBroker,
      executionBrokerFactory: (runId) => {
        const state = { runId, disposed: false, commands: [] as string[] };
        created.push(state);
        const boundary = boundaryFor(runId);
        return {
          boundaryId: runId,
          status: () => boundary,
          probe: async () => boundary,
          executeShell: async (request) => {
            if (state.disposed) throw new Error("disposed broker was reused");
            state.commands.push(request.command);
            return {
              stdout: "follow-up-ok\n", stderr: "", exitCode: 0, signal: null,
              timedOut: false, aborted: request.signal.aborted, outputLimitExceeded: false,
              cleanup: "runtime-rm", status: boundary,
            };
          },
          dispose: async () => { state.disposed = true; },
        };
      },
    });
    port = await startServer(handle);
    base = baseUrl(port);

    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "first segment", verify: false }),
    })).json() as { runId: string };
    await waitForDone(base, runId);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ runId, disposed: true, commands: [] });

    const follow = await fetch(`${base}/api/runs/${runId}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "run the follow-up command" }),
    });
    expect(follow.status).toBe(200);
    await waitForDone(base, runId);

    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ runId, disposed: true, commands: [] });
    expect(created[1]).toMatchObject({
      runId,
      disposed: true,
      commands: ["echo follow-up"],
    });
    expect(model.requests).toHaveLength(3);
  });

  it("SAFE-05. 初始无 bash 的 pack 规划到含 bash 子任务时仍走同一 per-run broker", async () => {
    const plan = JSON.stringify({
      subtasks: [{
        id: "s1", title: "Python step", pack: "python-coding",
        description: "运行检查", acceptance: ["检查通过"], dependsOn: [],
      }],
    });
    const model = new FakeModelClient([
      fakeMessage([textBlock(plan)], "end_turn"),
      fakeMessage([toolUseBlock("tu_planned_bash", "bash", { command: "python -m pytest -q" })], "tool_use"),
      fakeMessage([textBlock("subtask done")], "end_turn"),
      fakeMessage([textBlock(JSON.stringify({ passed: true, issues: [], summary: "通过" }))], "end_turn"),
    ]);
    const commands: Array<{ runId: string; command: string }> = [];
    const boundaryFor = (boundaryId: string): ExecutionBoundaryStatus => ({
      schemaVersion: 1, boundaryId, requestedMode: "required", requestedBackend: "oci",
      effectiveState: "partial", resolvedBackend: "oci", policyDigest: "e".repeat(64),
      probe: { state: "ready", candidate: "oci" }, coverage: ["bash"],
      filesystem: "rw workdir", network: "none", identity: "uid 65532", resources: "limited",
    });
    const brokerFor = (boundaryId: string): ExecutionBroker => ({
      boundaryId, status: () => boundaryFor(boundaryId), probe: async () => boundaryFor(boundaryId),
      executeShell: async (request) => {
        commands.push({ runId: boundaryId, command: request.command });
        return {
          stdout: "ok", stderr: "", exitCode: 0, signal: null, timedOut: false,
          aborted: request.signal.aborted, outputLimitExceeded: false, cleanup: "runtime-rm",
          status: boundaryFor(boundaryId),
        };
      },
      dispose: async () => {},
    });
    const processBroker = brokerFor("process-probe");
    const createdRunBrokers: string[] = [];
    handle = createUiServer({
      modelClient: model,
      // 不注入 tools：让 stm32-debug → python-coding 的真实 pack 工具选择发生。
      workdir: process.cwd(),
      executionEnv: {
        AGENT_EXECUTION_ISOLATION: "required", AGENT_EXECUTION_BACKEND: "oci",
        AGENT_EXECUTION_OCI_IMAGE: `sha256:${"e".repeat(64)}`,
      },
      executionProbeBroker: processBroker,
      executionBrokerFactory: (runId) => {
        createdRunBrokers.push(runId);
        return brokerFor(runId);
      },
    });
    port = await startServer(handle);
    base = baseUrl(port);
    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "跨包计划", mode: "plan", pack: "stm32-debug", concurrency: 1 }),
    })).json() as { runId: string };
    const approval = await waitForEvent(
      base,
      runId,
      (event: any) => event.event.type === "approval_request" && event.event.toolUseId === "tu_planned_bash",
    ) as any;
    expect(approval.event.name).toBe("bash");
    expect((await fetch(`${base}/api/runs/${runId}/approvals/${approval.event.toolUseId}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow" }),
    })).status).toBe(200);
    await waitForDone(base, runId);
    expect(createdRunBrokers).toEqual([runId]);
    expect(commands).toEqual([{ runId, command: "python -m pytest -q" }]);
  });

  it("SAFE-05. 初始无 bash 的 plan 若 per-run boundary 失败，planner 也保持零模型调用", async () => {
    const model = new FakeModelClient([fakeMessage([textBlock("must not plan")], "end_turn")]);
    const ready: ExecutionBoundaryStatus = {
      schemaVersion: 1, boundaryId: "process-probe", requestedMode: "required", requestedBackend: "oci",
      effectiveState: "partial", resolvedBackend: "oci", policyDigest: "1".repeat(64),
      probe: { state: "ready", candidate: "oci" }, coverage: ["bash"], filesystem: "rw",
      network: "none", identity: "uid 65532", resources: "limited",
    };
    const failed = (boundaryId: string): ExecutionBoundaryStatus => ({
      ...ready, boundaryId, effectiveState: "failed", resolvedBackend: null,
      probe: { state: "unavailable", candidate: "oci", reason: "run workdir canary failed" },
      coverage: [], filesystem: "unavailable", network: "unavailable",
      identity: "unavailable", resources: "unavailable",
    });
    const processBroker: ExecutionBroker = {
      boundaryId: ready.boundaryId, status: () => ready, probe: async () => ready,
      executeShell: async (request) => ({
        stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false,
        aborted: request.signal.aborted, outputLimitExceeded: false, cleanup: "runtime-rm", status: ready,
      }), dispose: async () => {},
    };
    handle = createUiServer({
      modelClient: model,
      workdir: process.cwd(),
      executionEnv: {
        AGENT_EXECUTION_ISOLATION: "required", AGENT_EXECUTION_BACKEND: "oci",
        AGENT_EXECUTION_OCI_IMAGE: `sha256:${"1".repeat(64)}`,
      },
      executionProbeBroker: processBroker,
      executionBrokerFactory: (runId) => ({
        boundaryId: runId, status: () => failed(runId), probe: async () => failed(runId),
        executeShell: async (request) => ({
          stdout: "", stderr: "", exitCode: null, signal: null, timedOut: false,
          aborted: request.signal.aborted, outputLimitExceeded: false, cleanup: "not-needed",
          status: failed(runId), error: "must not execute",
        }), dispose: async () => {},
      }),
    });
    port = await startServer(handle);
    base = baseUrl(port);
    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "blocked cross-pack plan", mode: "plan", pack: "stm32-debug" }),
    })).json() as { runId: string };
    await waitForDone(base, runId);
    const events = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    expect(events.some((event: any) => event.event.type === "execution_boundary_failed")).toBe(true);
    expect(model.requests).toHaveLength(0);
  });

  it("SAFE-05. required 探针失败时 liveness 存活、readiness 与新 run 均 503", async () => {
    const failed: ExecutionBoundaryStatus = {
      schemaVersion: 1,
      boundaryId: "process-probe",
      requestedMode: "required",
      requestedBackend: "oci",
      effectiveState: "failed",
      resolvedBackend: null,
      policyDigest: "f".repeat(64),
      probe: {
        state: "unavailable",
        candidate: "oci",
        reason: "docker daemon unavailable at /private/runtime/docker.sock",
      },
      coverage: [],
      filesystem: "unavailable",
      network: "unavailable",
      identity: "unavailable",
      resources: "unavailable",
    };
    const failedBroker: ExecutionBroker = {
      boundaryId: failed.boundaryId,
      status: () => failed,
      probe: async () => failed,
      executeShell: async (request) => ({
        stdout: "", stderr: "", exitCode: null, signal: null,
        timedOut: false, aborted: request.signal.aborted, outputLimitExceeded: false,
        cleanup: "not-needed", status: failed, error: "must not run",
      }),
    };
    handle = createUiServer({
      modelClient: new FakeModelClient([]),
      tools: [{ ...bashTool, permission: "auto" }],
      workdir: process.cwd(),
      executionProbeBroker: failedBroker,
      executionBrokerFactory: () => failedBroker,
    });
    port = await startServer(handle);
    base = baseUrl(port);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const ready = await fetch(`${base}/ready`);
    expect(ready.status).toBe(503);
    const readyText = await ready.text();
    expect(readyText).not.toContain("/private/runtime/docker.sock");
    expect((JSON.parse(readyText) as any).execution.status).toMatchObject({
      effectiveState: "failed",
      probe: { code: "execution_backend_unavailable" },
    });
    const create = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "must not reach model" }),
    });
    expect(create.status).toBe(503);
    expect((await create.json() as any).error).toContain("docker daemon unavailable");
  });

  it("SAFE-05. 注入 modelClient 不能把 required 配置静默降为测试直跑，失败时模型零调用", async () => {
    const model = new FakeModelClient([fakeMessage([textBlock("must not run")], "end_turn")]);
    handle = createUiServer({
      modelClient: model,
      tools: [{ ...bashTool, permission: "auto" }],
      workdir: process.cwd(),
      executionEnv: {
        AGENT_EXECUTION_ISOLATION: "required",
        AGENT_EXECUTION_BACKEND: "oci",
        AGENT_EXECUTION_OCI_IMAGE: `sha256:${"8".repeat(64)}`,
      },
    });
    port = await startServer(handle);
    base = baseUrl(port);
    expect((await fetch(`${base}/ready`)).status).toBe(503);
    const create = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "model must stay untouched" }),
    });
    expect(create.status).toBe(503);
    expect(model.requests).toHaveLength(0);
  });

  it("SAFE-05. ready 后 backend 失效会立即阻断 readiness 与同 run 续跑，模型零新增调用", async () => {
    const model = new FakeModelClient([fakeMessage([textBlock("first done")], "end_turn")]);
    let backendReady = true;
    const makeBoundary = (boundaryId: string): ExecutionBoundaryStatus => ({
      schemaVersion: 1,
      boundaryId,
      requestedMode: "required",
      requestedBackend: "oci",
      effectiveState: backendReady ? "partial" : "failed",
      resolvedBackend: backendReady ? "oci" : null,
      policyDigest: "9".repeat(64),
      probe: backendReady
        ? { state: "ready", candidate: "oci" }
        : { state: "unavailable", candidate: "oci", reason: "runtime went down" },
      coverage: backendReady ? ["bash"] : [],
      filesystem: backendReady ? "rw workdir" : "unavailable",
      network: backendReady ? "none" : "unavailable",
      identity: backendReady ? "uid 65532" : "unavailable",
      resources: backendReady ? "limited" : "unavailable",
    });
    const brokerFor = (boundaryId: string): ExecutionBroker => ({
      boundaryId,
      status: () => makeBoundary(boundaryId),
      probe: async () => makeBoundary(boundaryId),
      executeShell: async (request) => ({
        stdout: "", stderr: "", exitCode: 0, signal: null,
        timedOut: false, aborted: request.signal.aborted, outputLimitExceeded: false,
        cleanup: "runtime-rm", status: makeBoundary(boundaryId),
      }),
      dispose: async () => {},
    });
    handle = createUiServer({
      modelClient: model,
      tools: [{ ...bashTool, permission: "auto" }],
      workdir: process.cwd(),
      executionEnv: {
        AGENT_EXECUTION_ISOLATION: "required",
        AGENT_EXECUTION_BACKEND: "oci",
        AGENT_EXECUTION_OCI_IMAGE: `sha256:${"9".repeat(64)}`,
      },
      executionProbeBroker: brokerFor("process-probe"),
      executionBrokerFactory: (runId) => brokerFor(runId),
    });
    port = await startServer(handle);
    base = baseUrl(port);
    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "first", verify: false }),
    })).json() as { runId: string };
    await waitForDone(base, runId);
    expect(model.requests).toHaveLength(1);

    backendReady = false;
    expect((await fetch(`${base}/ready`)).status).toBe(503);
    const follow = await fetch(`${base}/api/runs/${runId}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "continue" }),
    });
    expect(follow.status).toBe(503);
    expect(model.requests).toHaveLength(1);
  });

  it("SAFE-05. run broker 清理未确认会锁住全局新准入，不能只污染旧 run", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_cleanup", "bash", { command: "false" })], "tool_use"),
      fakeMessage([textBlock("handled")], "end_turn"),
      fakeMessage([textBlock("must not run")], "end_turn"),
    ]);
    const readyBoundary = (boundaryId: string): ExecutionBoundaryStatus => ({
      schemaVersion: 1, boundaryId, requestedMode: "required", requestedBackend: "oci",
      effectiveState: "partial", resolvedBackend: "oci", policyDigest: "a".repeat(64),
      probe: { state: "ready", candidate: "oci" }, coverage: ["bash"],
      filesystem: "rw workdir", network: "none", identity: "uid 65532", resources: "limited",
    });
    const processBroker: ExecutionBroker = {
      boundaryId: "process-probe", status: () => readyBoundary("process-probe"),
      probe: async () => readyBoundary("process-probe"),
      executeShell: async (request) => ({
        stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false,
        aborted: request.signal.aborted, outputLimitExceeded: false, cleanup: "runtime-rm",
        status: readyBoundary("process-probe"),
      }),
      dispose: async () => {},
    };
    let cleanupAttempts = 0;
    const runBroker = (runId: string): ExecutionBroker => ({
      boundaryId: runId, status: () => readyBoundary(runId), probe: async () => readyBoundary(runId),
      executeShell: async (request) => ({
        stdout: "", stderr: "command failed", exitCode: 1, signal: null,
        timedOut: false, aborted: request.signal.aborted, outputLimitExceeded: false,
        cleanup: "failed", status: readyBoundary(runId), error: "cleanup receipt missing",
      }),
      dispose: async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw new Error("worker still present");
      },
    });
    handle = createUiServer({
      modelClient: model,
      tools: [{ ...bashTool, permission: "auto" }],
      workdir: process.cwd(),
      executionEnv: {
        AGENT_EXECUTION_ISOLATION: "required", AGENT_EXECUTION_BACKEND: "oci",
        AGENT_EXECUTION_OCI_IMAGE: `sha256:${"a".repeat(64)}`,
      },
      executionProbeBroker: processBroker,
      executionBrokerFactory: (runId) => runBroker(runId),
    });
    port = await startServer(handle);
    base = baseUrl(port);
    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "cleanup fail", verify: false }),
    })).json() as { runId: string };
    await waitForDone(base, runId);
    await new Promise((resolveDone) => setTimeout(resolveDone, 0));
    const second = await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "must be blocked", verify: false }),
    });
    expect(second.status).toBe(503);
    expect(model.requests).toHaveLength(2);
  });

  it("SAFE-05. 慢 create body 通过旧检查后遇到 detached cleanup，启动重验保持零 canary/模型执行", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_finish_first", "hold_op", { op: "finish" })], "tool_use"),
      fakeMessage([textBlock("first finished")], "end_turn"),
    ]);
    const boundaryFor = (boundaryId: string): ExecutionBoundaryStatus => ({
      schemaVersion: 1, boundaryId, requestedMode: "required", requestedBackend: "oci",
      effectiveState: "partial", resolvedBackend: "oci", policyDigest: "6".repeat(64),
      probe: { state: "ready", candidate: "oci" }, coverage: ["bash"],
      filesystem: "rw workdir", network: "none", identity: "uid 65532", resources: "limited",
    });

    let armSlowAdmissionProbe = false;
    let signalSlowAdmissionProbe!: () => void;
    const slowAdmissionProbePassed = new Promise<void>((resolveProbe) => {
      signalSlowAdmissionProbe = resolveProbe;
    });
    const processBroker: ExecutionBroker = {
      boundaryId: "process-probe",
      status: () => boundaryFor("process-probe"),
      probe: async () => {
        if (armSlowAdmissionProbe) {
          armSlowAdmissionProbe = false;
          signalSlowAdmissionProbe();
        }
        return boundaryFor("process-probe");
      },
      executeShell: async (request) => ({
        stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false,
        aborted: request.signal.aborted, outputLimitExceeded: false, cleanup: "runtime-rm",
        status: boundaryFor("process-probe"),
      }),
      dispose: async () => {},
    };

    let releaseFirstCleanup!: () => void;
    const firstCleanup = new Promise<void>((resolveCleanup) => {
      releaseFirstCleanup = resolveCleanup;
    });
    const runBrokers: Array<{ runId: string; probes: number; executions: number }> = [];
    handle = createUiServer({
      modelClient: model,
      tools: [askTool("hold_op"), { ...bashTool, permission: "auto" }],
      workdir: process.cwd(),
      executionEnv: {
        AGENT_EXECUTION_ISOLATION: "required", AGENT_EXECUTION_BACKEND: "oci",
        AGENT_EXECUTION_OCI_IMAGE: `sha256:${"6".repeat(64)}`,
      },
      executionProbeBroker: processBroker,
      executionBrokerFactory: (runId) => {
        const state = { runId, probes: 0, executions: 0 };
        runBrokers.push(state);
        return {
          boundaryId: runId,
          status: () => boundaryFor(runId),
          probe: async () => {
            state.probes += 1;
            return boundaryFor(runId);
          },
          executeShell: async (request) => {
            state.executions += 1;
            return {
              stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false,
              aborted: request.signal.aborted, outputLimitExceeded: false, cleanup: "runtime-rm",
              status: boundaryFor(runId),
            };
          },
          // 第一个 run 的回收保持 pending；第二个（被准入门拦下）的 broker 可正常收掉。
          dispose: async () => {
            if (runBrokers[0] === state) await firstCleanup;
          },
        };
      },
    });
    port = await startServer(handle);
    base = baseUrl(port);

    try {
      const first = await fetch(`${base}/api/runs`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "first run waits for approval", verify: false }),
      });
      const { runId: firstRunId } = await first.json() as { runId: string };
      const approval = await waitForEvent(
        base,
        firstRunId,
        (event: any) => event.event.type === "approval_request" && event.event.toolUseId === "tu_finish_first",
      ) as any;

      // B 只发送请求头：process admission 已通过，处理器随后确定性停在 readBody。
      armSlowAdmissionProbe = true;
      let slowRequest!: ReturnType<typeof httpRequest>;
      const slowResponse = new Promise<{ status: number; body: string }>((resolveResponse, rejectResponse) => {
        slowRequest = httpRequest({
          host: "127.0.0.1", port, path: "/api/runs", method: "POST",
          headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
        }, (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { body += chunk; });
          response.on("end", () => resolveResponse({ status: response.statusCode!, body }));
        });
        slowRequest.on("error", rejectResponse);
        slowRequest.flushHeaders();
      });
      await slowAdmissionProbePassed;

      // A 此时收尾并进入永不自行完成的 detached cleanup，制造旧检查后的状态翻转。
      expect((await fetch(`${base}/api/runs/${firstRunId}/approvals/${approval.event.toolUseId}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "allow" }),
      })).status).toBe(200);
      await waitForDone(base, firstRunId);

      slowRequest.end(JSON.stringify({ task: "must stop after per-run probe", verify: false }));
      const secondResponse = await slowResponse;
      expect(secondResponse.status).toBe(200);
      const { runId: secondRunId } = JSON.parse(secondResponse.body) as { runId: string };
      await waitForDone(base, secondRunId);

      const secondEvents = await readSSEAll(await fetch(`${base}/api/runs/${secondRunId}/events`));
      const configIndex = secondEvents.findIndex((event: any) => event.event.type === "run_config");
      const blockedIndex = secondEvents.findIndex(
        (event: any) => event.event.type === "execution_boundary_failed",
      );
      expect(configIndex).toBeGreaterThanOrEqual(0);
      expect(blockedIndex).toBeGreaterThan(configIndex);
      expect((secondEvents[configIndex] as any).event.executionIsolation).toMatchObject({
        boundaryId: secondRunId,
        effectiveState: "failed",
        resolvedBackend: null,
        probe: {
          state: "unavailable",
          reason: expect.stringContaining("Cleanup is still unconfirmed"),
        },
        coverage: [],
      });
      const blocked = secondEvents.find((event: any) => event.event.type === "execution_boundary_failed") as any;
      expect(blocked.event.reason).toContain("Cleanup is still unconfirmed");
      // gate 早于 buildConfig；第二个 run 连 broker/canary 都不得创建。
      expect(runBrokers).toHaveLength(1);
      expect(runBrokers.find((broker) => broker.runId === secondRunId)?.probes ?? 0).toBe(0);
      expect(runBrokers.reduce((total, broker) => total + broker.executions, 0)).toBe(0);
      expect(model.requests).toHaveLength(2);
    } finally {
      releaseFirstCleanup();
      await new Promise((resolveDone) => setTimeout(resolveDone, 0));
    }
  });

  it("SAFE-05. required+host MCP 在任何 broker/probe 创建前即拒绝", () => {
    const prior = process.env.AGENT_UI_MCP;
    process.env.AGENT_UI_MCP = "1";
    const factoryCalls: string[] = [];
    try {
      expect(() => createUiServer({
        modelClient: new FakeModelClient([]),
        tools: [{ ...bashTool, permission: "auto" }],
        workdir: process.cwd(),
        executionEnv: {
          AGENT_EXECUTION_ISOLATION: "required", AGENT_EXECUTION_BACKEND: "oci",
          AGENT_EXECUTION_OCI_IMAGE: `sha256:${"b".repeat(64)}`,
        },
        executionBrokerFactory: (runId) => {
          factoryCalls.push(runId);
          throw new Error("must not construct");
        },
      })).toThrow(/cannot enable shared host stdio MCP/);
      expect(factoryCalls).toEqual([]);
    } finally {
      if (prior === undefined) delete process.env.AGENT_UI_MCP;
      else process.env.AGENT_UI_MCP = prior;
    }
  });

  it("SAFE-05. close 会关闭 HTTP 且把 broker 清理失败作为拒绝返回", async () => {
    const boundary: ExecutionBoundaryStatus = {
      schemaVersion: 1, boundaryId: "close-probe", requestedMode: "required", requestedBackend: "oci",
      effectiveState: "partial", resolvedBackend: "oci", policyDigest: "c".repeat(64),
      probe: { state: "ready", candidate: "oci" }, coverage: ["bash"], filesystem: "rw",
      network: "none", identity: "uid 65532", resources: "limited",
    };
    const broker: ExecutionBroker = {
      boundaryId: boundary.boundaryId, status: () => boundary, probe: async () => boundary,
      executeShell: async (request) => ({
        stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false,
        aborted: request.signal.aborted, outputLimitExceeded: false, cleanup: "runtime-rm", status: boundary,
      }),
      dispose: async () => { throw new Error("cleanup proof unavailable"); },
    };
    handle = createUiServer({
      modelClient: new FakeModelClient([]), tools: [{ ...bashTool, permission: "auto" }],
      workdir: process.cwd(), executionProbeBroker: broker, executionBrokerFactory: () => broker,
    });
    port = await startServer(handle);
    base = baseUrl(port);
    const closing = handle.close();
    handle = undefined;
    await expect(closing).rejects.toThrow(/cleanup proof unavailable/);
    await expect(fetch(`${base}/health`)).rejects.toThrow();
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
      expect(vision.approvalPolicy).toEqual({ maxScope: "once" });

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

  it("正文路径探测只确认工作目录内真实存在的文件与目录", async () => {
    const res = await fetch(`${base}/api/runs/${runId}/paths/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paths: ["report.html", "report.html:12:4", "sub/", "nope.txt", "../outside.txt"],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const byInput = new Map(body.paths.map((item: any) => [item.input, item]));
    expect(byInput.get("report.html")).toMatchObject({ exists: true, path: "report.html", kind: "file" });
    expect(byInput.get("report.html:12:4")).toMatchObject({ exists: true, path: "report.html", kind: "file" });
    expect(byInput.get("sub/")).toMatchObject({ exists: true, path: "sub", kind: "directory" });
    expect(byInput.get("nope.txt")).toEqual({ input: "nope.txt", exists: false });
    expect(byInput.get("../outside.txt")).toEqual({ input: "../outside.txt", exists: false });
  });

  it("正文路径探测有批量上限，不能把接口变成目录扫描器", async () => {
    const res = await fetch(`${base}/api/runs/${runId}/paths/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: Array.from({ length: 65 }, (_, i) => `f${i}.txt`) }),
    });
    expect(res.status).toBe(400);
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
    // 三个平台分支全部钉死（stub process.platform 而不是跟着宿主走）：
    // 修前断言"文件名必落参数"——Linux 分支打开的是所在目录，文件名本就不在，
    // 测试只在 Windows/macOS 上有意义（CI 首跑实测：本机绿、ubuntu 红）。
    const dangerous = "/tmp/a b & c.txt";
    const withPlatform = (platform: string, fn: () => void) => {
      const desc = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: platform });
      try {
        fn();
      } finally {
        Object.defineProperty(process, "platform", desc);
      }
    };
    for (const platform of ["win32", "darwin"]) {
      withPlatform(platform, () => {
        const cmd = revealCommand(dangerous);
        expect(cmd).not.toBeNull();
        expect(Array.isArray(cmd!.args)).toBe(true);
        expect(cmd!.file).not.toContain(" ");
        // 文件名原样落在某个参数里，而不是被拼进一条串
        expect(cmd!.args.some((a) => a.includes("a b & c.txt"))).toBe(true);
      });
    }
    withPlatform("linux", () => {
      // Linux 没有"选中文件"的标准动词：打开所在目录，目录路径原样落参
      const cmd = revealCommand(dangerous);
      expect(cmd).not.toBeNull();
      expect(cmd!.file).toBe("xdg-open");
      expect(cmd!.args).toEqual(["/tmp"]);
    });
    withPlatform("freebsd", () => {
      expect(revealCommand(dangerous)).toBeNull(); // 不支持的平台返回 null，本身就是安全的
    });
  });

  it("目录与文件的系统动作不同：目录直接打开，文件定位到所在文件夹", () => {
    const target = resolve("some folder");
    const file = revealCommand(target, "file");
    const directory = revealCommand(target, "directory");
    if (!file || !directory) return;
    expect(directory.args).not.toEqual(file.args);
    expect(directory.args.some((arg) => arg.includes(target))).toBe(true);
    expect(localPathTarget("src/main.ts:12:4")).toBe("src/main.ts");
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
    for (const name of [".env.example", ".env.production.example"]) {
      const text = readFileSync(join(root, name), "utf-8");
      for (const line of text.split(/\r?\n/)) {
        if (line.startsWith("#") || !line.includes("=")) continue;
        const [k, v] = line.split("=", 2);
        if (/(?:API_KEY|ACCESS_TOKEN|SECRET|PASSWORD)$/i.test(k!)) {
          expect(v!.trim(), `${name}: ${k} 在模板里有值`).toBe("");
        }
      }
    }
  });
});

describe("本次对话精确输入放行：省的是重复点击，不是扩大权限", () => {
  let handle: Awaited<ReturnType<typeof createUiServer>>;
  let base: string;

  afterEach(async () => {
    await handle?.close();
  });

  /** 每次调用都要审批的工具；模型连着调它三次 */
  const askEvery = (name: string) => makeTool({
    name,
    permission: "ask",
    parallelSafe: false,
    approvalPolicy: { maxScope: "exact-input", maxTtlMs: 60_000, maxUses: 5 },
  });

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

  it("建规则之后同一工具 + 相同输入不再挂起，run 自己跑完", async () => {
    const { runId } = await startRunCallingThrice();
    const ref = await firstPending(runId);
    const res = await fetch(`${base}/api/runs/${runId}/approvals/${encodeURIComponent(ref)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow", scope: "conversation" }),
    });
    expect(res.status).toBe(200);
    const response = await res.json() as any;
    expect(response.autoAllow).toContain("danger"); // 旧 API 形状保留
    expect(response.autoAllowExact).toEqual([
      expect.objectContaining({
        name: "danger",
        scope: "run",
        inputScope: "exact-input",
        boundRunId: runId,
        expiresAt: expect.any(Number),
        maxUses: 5,
        inputHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      }),
    ]);

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
    expect(evs.filter((e: any) => (e.event as any)?.type === "approval_request"))
      .toHaveLength(3);
    expect(evs.map((e: any) => e.seq), "durable 事件序号必须连续且保持 request 在 resolution 之前")
      .toEqual(evs.map((_: unknown, index: number) => index));
    const resolved = evs.filter((e: any) => (e.event as any)?.type === "approval_resolved") as any[];
    expect(resolved.length, "三次调用应当有三条决策记录").toBe(3);
    expect(resolved[0].event.actor, "第一次是人点的").toBe("user");
    expect(resolved[0].event.scope, "建规则那次要标出来").toBe("run");
    expect(resolved[0].event.boundRunId).toBe(runId);
    expect(resolved[0].event.expiresAt).toBeGreaterThan(resolved[0].event.issuedAt);
    expect(resolved[0].event.inputScope).toBe("exact-input");
    expect(resolved[0].event.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (const r of resolved.slice(1)) {
      expect(r.event.actor, "自动放行必须标 auto-rule，不能冒充人点的").toBe("auto-rule");
      expect(r.event.decision).toBe("allow");
      expect(r.event.scope).toBe("run");
      expect(r.event.inputScope).toBe("exact-input");
      expect(r.event.inputHash).toBe(resolved[0].event.inputHash);
    }
  });

  it("递归 canonicalization 与 SHA-256 稳定：对象 key 顺序不同仍是同一输入", () => {
    const left = { command: "echo ok", options: { cwd: "x", env: { B: "2", A: "1" } }, args: [1, 2] };
    const right = { args: [1, 2], options: { env: { A: "1", B: "2" }, cwd: "x" }, command: "echo ok" };
    expect(canonicalizeApprovalInput(left)).toBe(canonicalizeApprovalInput(right));
    expect(approvalInputHash(left)).toBe(approvalInputHash(right));
    expect(approvalInputHash(left)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(approvalInputHash({ ...right, args: [2, 1] })).not.toBe(approvalInputHash(left));
  });

  it("同一工具的对象 key 顺序不同可复用规则", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("t1", "danger", { command: "echo ok", nested: { b: 2, a: 1 } })], "tool_use"),
      fakeMessage([toolUseBlock("t2", "danger", { nested: { a: 1, b: 2 }, command: "echo ok" })], "tool_use"),
      fakeMessage([textBlock("done")], "end_turn"),
    ]);
    handle = createUiServer({ modelClient: model, tools: [askEvery("danger")], workdir: process.cwd() });
    base = baseUrl(await startServer(handle));
    const runId = (await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "同参数重排" }),
    })).json()).runId;

    const ref = await firstPending(runId);
    await fetch(`${base}/api/runs/${runId}/approvals/${encodeURIComponent(ref)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow", scope: "conversation" }),
    });
    await waitForDone(base, runId);

    const events = await readSSESnapshot(base, runId);
    expect(events.filter((e: any) => e.event.type === "approval_request")).toHaveLength(2);
    const auto = events.find((e: any) => e.event.type === "approval_resolved" && e.event.actor === "auto-rule") as any;
    expect(auto?.event.toolUseId).toBe("t2");
    expect(auto?.event.inputScope).toBe("exact-input");
  });

  it("command/path/device 任一参数变化都必须再次审批", async () => {
    const inputs = [
      { command: "flash", path: "fw-a.bin", device: "probe-a" },
      { command: "verify", path: "fw-a.bin", device: "probe-a" },
      { command: "verify", path: "fw-b.bin", device: "probe-a" },
      { command: "verify", path: "fw-b.bin", device: "probe-b" },
    ];
    const model = new FakeModelClient([
      ...inputs.map((input, i) => fakeMessage([toolUseBlock(`t${i + 1}`, "bash", input)], "tool_use")),
      fakeMessage([textBlock("done")], "end_turn"),
    ]);
    handle = createUiServer({ modelClient: model, tools: [askEvery("bash")], workdir: process.cwd() });
    base = baseUrl(await startServer(handle));
    const runId = (await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "参数变化" }),
    })).json()).runId;

    for (let i = 0; i < inputs.length; i++) {
      const ref = await firstPending(runId);
      expect(ref.startsWith(`t${i + 1}#`)).toBe(true);
      const response = await fetch(`${base}/api/runs/${runId}/approvals/${encodeURIComponent(ref)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "allow", scope: "conversation" }),
      });
      expect(response.status).toBe(200);
    }
    await waitForDone(base, runId);
    const events = await readSSESnapshot(base, runId);
    expect(events.filter((e: any) => e.event.type === "approval_request")).toHaveLength(inputs.length);
    expect(events.some((e: any) => e.event.actor === "auto-rule")).toBe(false);
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

  it("工具策略是权限上限：once 工具拒绝客户端扩大为 conversation grant", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("t_once", "danger", {})], "tool_use"),
      fakeMessage([textBlock("done")], "end_turn"),
    ]);
    handle = createUiServer({ modelClient: model, tools: [askTool("danger")], workdir: process.cwd() });
    base = baseUrl(await startServer(handle));
    const runId = (await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "单次策略" }),
    })).json()).runId;
    const ref = await firstPending(runId);

    const expanded = await fetch(`${base}/api/runs/${runId}/approvals/${encodeURIComponent(ref)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow", scope: "conversation" }),
    });
    expect(expanded.status).toBe(409);
    expect((await expanded.json()).maxScope).toBe("once");

    const once = await fetch(`${base}/api/runs/${runId}/approvals/${encodeURIComponent(ref)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow" }),
    });
    expect(once.status).toBe(200);
    await waitForDone(base, runId);
  });

  it("畸形 exact-input 限制 fail closed 为 once，0 不能反向套用宿主默认值", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("t_invalid", "danger", {})], "tool_use"),
      fakeMessage([textBlock("done")], "end_turn"),
    ]);
    const malformed = makeTool({
      name: "danger",
      permission: "ask",
      approvalPolicy: { maxScope: "exact-input", maxTtlMs: 0, maxUses: 0 },
    });
    handle = createUiServer({ modelClient: model, tools: [malformed], workdir: process.cwd() });
    base = baseUrl(await startServer(handle));
    const runId = (await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "畸形策略" }),
    })).json()).runId;
    const ref = await firstPending(runId);
    const expanded = await fetch(`${base}/api/runs/${runId}/approvals/${encodeURIComponent(ref)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow", scope: "conversation" }),
    });
    expect(expanded.status).toBe(409);
    expect((await expanded.json()).maxScope).toBe("once");
    await fetch(`${base}/api/runs/${runId}/approvals/${encodeURIComponent(ref)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow" }),
    });
    await waitForDone(base, runId);
  });

  it("同一审批的并发双 POST 只有一个能决策，不能重复发 grant/审计事件", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("t_race", "danger", {})], "tool_use"),
      fakeMessage([textBlock("done")], "end_turn"),
    ]);
    handle = createUiServer({ modelClient: model, tools: [askEvery("danger")], workdir: process.cwd() });
    const port = await startServer(handle);
    base = baseUrl(port);
    const runId = (await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "双击审批" }),
    })).json()).runId;
    const ref = await firstPending(runId);
    const body = JSON.stringify({ decision: "allow", scope: "conversation" });
    const path = `/api/runs/${runId}/approvals/${encodeURIComponent(ref)}`;

    const beginSlowPost = () => {
      let request!: ReturnType<typeof httpRequest>;
      const result = new Promise<number>((resolveStatus, reject) => {
        request = httpRequest({
          host: "127.0.0.1",
          port,
          path,
          method: "POST",
          headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
        }, (response) => {
          response.resume();
          response.on("end", () => resolveStatus(response.statusCode!));
        });
        request.on("error", reject);
        request.write(body.slice(0, 1));
      });
      return { request, result };
    };

    const left = beginSlowPost();
    const right = beginSlowPost();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
    left.request.end(body.slice(1));
    right.request.end(body.slice(1));
    expect((await Promise.all([left.result, right.result])).sort()).toEqual([200, 409]);

    await waitForDone(base, runId);
    const events = await readSSESnapshot(base, runId) as any[];
    expect(events.filter((item) => item.event.type === "approval_resolved" && item.event.actor === "user"))
      .toHaveLength(1);
  });

  it("创建不同输入的新 grant 前会清扫已过期项，不让陈旧记录永久占槽", async () => {
    let now = 1_000;
    let executions = 0;
    const tool = makeTool({
      name: "danger",
      permission: "ask",
      approvalPolicy: { maxScope: "exact-input", maxTtlMs: 1_000, maxUses: 5 },
      execute: async () => {
        executions += 1;
        if (executions === 1) now = 2_000;
        return { content: "ok" };
      },
    });
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("t_old", "danger", { target: "old" })], "tool_use"),
      fakeMessage([toolUseBlock("t_new", "danger", { target: "new" })], "tool_use"),
      fakeMessage([textBlock("done")], "end_turn"),
    ]);
    handle = createUiServer({
      modelClient: model,
      tools: [tool],
      workdir: process.cwd(),
      approvalClock: () => now,
    });
    base = baseUrl(await startServer(handle));
    const runId = (await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "清扫过期 grant" }),
    })).json()).runId;
    const oldRef = await firstPending(runId);
    await fetch(`${base}/api/runs/${runId}/approvals/${encodeURIComponent(oldRef)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow", scope: "conversation" }),
    });

    const newRef = await firstPending(runId);
    const created = await fetch(`${base}/api/runs/${runId}/approvals/${encodeURIComponent(newRef)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow", scope: "conversation" }),
    });
    expect(created.status).toBe(200);
    const body = await created.json() as any;
    expect(body.autoAllowExact).toHaveLength(1);
    expect(body.autoAllowExact[0].inputHash).toBe(approvalInputHash({ target: "new" }));
    await waitForDone(base, runId);
    const events = await readSSESnapshot(base, runId) as any[];
    expect(events.find((item) => item.event.type === "approval_grant_expired")?.event.cause)
      .toBe("ttl_expired");
  });

  it("同一轮相同参数的两个 pending 复用一个 grantId，不重置 TTL/次数", async () => {
    const model = new FakeModelClient([
      fakeMessage([
        toolUseBlock("t_parallel_1", "danger", { target: "same" }),
        toolUseBlock("t_parallel_2", "danger", { target: "same" }),
      ], "tool_use"),
      fakeMessage([textBlock("done")], "end_turn"),
    ]);
    const tool = makeTool({
      name: "danger",
      permission: "ask",
      parallelSafe: true,
      approvalPolicy: { maxScope: "exact-input", maxTtlMs: 60_000, maxUses: 5 },
    });
    handle = createUiServer({ modelClient: model, tools: [tool], workdir: process.cwd() });
    base = baseUrl(await startServer(handle));
    const runId = (await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "并发同参" }),
    })).json()).runId;

    for (let i = 0; i < 60; i++) {
      const summary = ((await (await fetch(`${base}/api/runs`)).json()) as any[])
        .find((item) => item.runId === runId);
      if (summary?.pendingApprovals === 2) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    const requests = (await readSSESnapshot(base, runId) as any[])
      .filter((item) => item.event.type === "approval_request")
      .sort((left, right) => left.seq - right.seq);
    expect(requests).toHaveLength(2);
    const approve = async (request: any) => {
      const ref = `${request.event.toolUseId}#${request.seq}`;
      const response = await fetch(`${base}/api/runs/${runId}/approvals/${encodeURIComponent(ref)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "allow", scope: "conversation" }),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<any>;
    };
    const first = await approve(requests[0]);
    const second = await approve(requests[1]);
    expect(first.autoAllowExact).toHaveLength(1);
    expect(second.autoAllowExact).toHaveLength(1);
    expect(second.autoAllowExact[0].grantId).toBe(first.autoAllowExact[0].grantId);
    expect(second.autoAllowExact[0].issuedAt).toBe(first.autoAllowExact[0].issuedAt);

    await waitForDone(base, runId);
    const events = await readSSESnapshot(base, runId) as any[];
    const userGrants = events.filter(
      (item) => item.event.type === "approval_resolved" && item.event.actor === "user" && item.event.grantId,
    );
    expect(userGrants.map((item) => item.event.grantAction)).toEqual(["created", "reused"]);
    expect(new Set(userGrants.map((item) => item.event.grantId)).size).toBe(1);
  });

  it("TTL 是硬边界：now === expiresAt 时失效，自动使用不会续期", async () => {
    let now = 1_000;
    let executions = 0;
    const tool = makeTool({
      name: "danger",
      permission: "ask",
      parallelSafe: false,
      approvalPolicy: { maxScope: "exact-input", maxTtlMs: 1_000, maxUses: 5 },
      execute: async () => {
        executions += 1;
        if (executions === 1) now = 2_000;
        return { content: "ok" };
      },
    });
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("t1", "danger", {})], "tool_use"),
      fakeMessage([toolUseBlock("t2", "danger", {})], "tool_use"),
      fakeMessage([textBlock("done")], "end_turn"),
    ]);
    handle = createUiServer({
      modelClient: model,
      tools: [tool],
      workdir: process.cwd(),
      approvalGrantTtlMs: 1_000,
      approvalClock: () => now,
    });
    base = baseUrl(await startServer(handle));
    const runId = (await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "TTL" }),
    })).json()).runId;
    const first = await firstPending(runId);
    await fetch(`${base}/api/runs/${runId}/approvals/${encodeURIComponent(first)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow", scope: "conversation" }),
    });

    const second = await firstPending(runId);
    expect(second.startsWith("t2#")).toBe(true);
    const events = await readSSESnapshot(base, runId) as any[];
    const expired = events.find((item) => item.event.type === "approval_grant_expired");
    expect(expired?.event.cause).toBe("ttl_expired");
    expect(expired?.event.at).toBe(2_000);
    expect(events.filter((item) => item.event.actor === "auto-rule")).toHaveLength(0);

    await fetch(`${base}/api/runs/${runId}/approvals/${encodeURIComponent(second)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow" }),
    });
    await waitForDone(base, runId);
  });

  it("工具定义变化会使旧 fingerprint grant 失效，相同输入也必须重新审批", async () => {
    let executions = 0;
    let tool!: Tool;
    tool = makeTool({
      name: "danger",
      description: "definition-v1",
      permission: "ask",
      approvalPolicy: { maxScope: "exact-input", maxTtlMs: 60_000, maxUses: 5 },
      execute: async () => {
        executions += 1;
        if (executions === 1) tool.description = "definition-v2";
        return { content: "ok" };
      },
    });
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("t1", "danger", { target: "same" })], "tool_use"),
      fakeMessage([toolUseBlock("t2", "danger", { target: "same" })], "tool_use"),
      fakeMessage([textBlock("done")], "end_turn"),
    ]);
    handle = createUiServer({ modelClient: model, tools: [tool], workdir: process.cwd() });
    base = baseUrl(await startServer(handle));
    const runId = (await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "工具定义变化" }),
    })).json()).runId;
    const first = await firstPending(runId);
    await fetch(`${base}/api/runs/${runId}/approvals/${encodeURIComponent(first)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow", scope: "conversation" }),
    });

    const second = await firstPending(runId);
    expect(second.startsWith("t2#")).toBe(true);
    const events = await readSSESnapshot(base, runId) as any[];
    expect(events.find((item) => item.event.type === "approval_grant_invalidated")?.event.cause)
      .toBe("tool_changed");
    expect(events.some((item) => item.event.actor === "auto-rule")).toBe(false);

    await fetch(`${base}/api/runs/${runId}/approvals/${encodeURIComponent(second)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow" }),
    });
    await waitForDone(base, runId);
  });

  it("最大使用次数耗尽后重新审批，并留下 exhausted 事件", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("t1", "danger", {})], "tool_use"),
      fakeMessage([toolUseBlock("t2", "danger", {})], "tool_use"),
      fakeMessage([toolUseBlock("t3", "danger", {})], "tool_use"),
      fakeMessage([toolUseBlock("t4", "danger", {})], "tool_use"),
      fakeMessage([textBlock("done")], "end_turn"),
    ]);
    const tool = makeTool({
      name: "danger",
      permission: "ask",
      parallelSafe: false,
      approvalPolicy: { maxScope: "exact-input", maxTtlMs: 60_000, maxUses: 2 },
    });
    handle = createUiServer({ modelClient: model, tools: [tool], workdir: process.cwd() });
    base = baseUrl(await startServer(handle));
    const runId = (await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "次数" }),
    })).json()).runId;
    const first = await firstPending(runId);
    await fetch(`${base}/api/runs/${runId}/approvals/${encodeURIComponent(first)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow", scope: "conversation" }),
    });

    const fourth = await firstPending(runId);
    expect(fourth.startsWith("t4#")).toBe(true);
    const events = await readSSESnapshot(base, runId) as any[];
    expect(events.filter((item) => item.event.actor === "auto-rule")).toHaveLength(2);
    expect(events.some((item) => item.event.type === "approval_grant_exhausted")).toBe(true);

    await fetch(`${base}/api/runs/${runId}/approvals/${encodeURIComponent(fourth)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow" }),
    });
    await waitForDone(base, runId);
  });

  it("不可续跑的核查 run 收尾时终止 active grant，UI 摘要不能继续报活跃", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("t_verified", "danger", {})], "tool_use"),
      fakeMessage([textBlock("main done")], "end_turn"),
      fakeMessage([textBlock(JSON.stringify({ passed: true, issues: [], summary: "通过" }))], "end_turn"),
    ]);
    handle = createUiServer({ modelClient: model, tools: [askEvery("danger")], workdir: process.cwd() });
    base = baseUrl(await startServer(handle));
    const runId = (await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "核查后不可续跑", verify: true }),
    })).json()).runId;
    const ref = await firstPending(runId);
    await fetch(`${base}/api/runs/${runId}/approvals/${encodeURIComponent(ref)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow", scope: "conversation" }),
    });
    await waitForDone(base, runId);

    const summary = ((await (await fetch(`${base}/api/runs`)).json()) as any[])
      .find((item) => item.runId === runId);
    expect(summary.canContinue).toBe(false);
    expect(summary.approvalGrants.active).toBe(0);
    const events = await readSSESnapshot(base, runId) as any[];
    const invalidated = events.find(
      (item) => item.event.type === "approval_grant_invalidated" && item.event.cause === "run_not_continuable",
    );
    expect(invalidated).toBeDefined();
    expect(events.at(-1)?.event.type).toBe("run_end");
  });
});

// ================================================================
// B2：运行历史落盘——重启不再清零
// ================================================================

describe("B2 · 运行历史落盘", () => {
  let handle: UiServerHandle | undefined;
  let port = 0;
  let base = "";
  let dir = "";

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      dir = "";
    }
  });

  async function boot(opts: Parameters<typeof createUiServer>[0]): Promise<void> {
    handle = createUiServer(opts);
    port = await startServer(handle);
    base = baseUrl(port);
  }

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("grant 进入完整 checkpoint 仅作审计；重启派生 child 必须重新审批", async () => {
    dir = await mkdtemp(join(tmpdir(), "history-grant-"));
    const reusable = () => makeTool({
      name: "danger",
      permission: "ask",
      parallelSafe: false,
      approvalPolicy: { maxScope: "exact-input", maxTtlMs: 60_000, maxUses: 3 },
    });
    await boot({
      modelClient: new FakeModelClient([
        fakeMessage([toolUseBlock("parent_tool", "danger", { target: "same" })], "tool_use"),
        fakeMessage([textBlock("parent done")], "end_turn"),
      ]),
      tools: [reusable()],
      workdir: process.cwd(),
      history: dir,
    });
    const { runId } = (await (await post("/api/runs", { task: "授权审计", verify: false })).json()) as { runId: string };
    const parentRequest = await waitForEvent(
      base,
      runId,
      (item: any) => item.event.type === "approval_request",
    ) as any;
    const parentRef = `${parentRequest.event.toolUseId}#${parentRequest.seq}`;
    const granted = await post(`/api/runs/${runId}/approvals/${encodeURIComponent(parentRef)}`, {
      decision: "allow",
      scope: "conversation",
    });
    expect(granted.status).toBe(200);
    await waitForDone(base, runId);
    const parentEventsBefore = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    await handle!.close();
    handle = undefined;

    const meta = JSON.parse(await readFile(join(dir, runId, "meta.json"), "utf8"));
    expect(meta.checkpoint.approvalGrants).toEqual([
      expect.objectContaining({
        version: 1,
        boundRunId: runId,
        scope: "run",
        name: "danger",
        inputScope: "exact-input",
        usedUses: 0,
      }),
    ]);

    await boot({
      modelClient: new FakeModelClient([
        fakeMessage([toolUseBlock("child_tool", "danger", { target: "same" })], "tool_use"),
        fakeMessage([textBlock("child done")], "end_turn"),
      ]),
      tools: [reusable()],
      workdir: process.cwd(),
      history: dir,
    });
    const restored = ((await (await fetch(`${base}/api/runs`)).json()) as any[])
      .find((item) => item.runId === runId);
    expect(restored.approvalGrants).toMatchObject({ active: 0, archivedAudit: 1, restorable: false });

    const follow = await post(`/api/runs/${runId}/messages`, { text: "继续相同操作" });
    expect(follow.status).toBe(200);
    const childId = ((await follow.json()) as any).runId as string;
    const childRequest = await waitForEvent(
      base,
      childId,
      (item: any) => item.event.type === "approval_request" && item.event.toolUseId === "child_tool",
    ) as any;
    expect(childRequest, "child 不得被父 grant 自动放行").toBeDefined();
    const childEvents = await readSSESnapshot(base, childId) as any[];
    expect(childEvents[0]?.event.type, "派生运行第一条 durable 事件必须先建立谱系")
      .toBe("run_forked");
    const reset = childEvents.find((item) => item.event.type === "approval_grant_not_inherited");
    expect(reset?.event).toMatchObject({
      boundRunId: runId,
      childRunId: childId,
      reason: "run_id_mismatch",
    });
    expect(childEvents.some((item) => item.event.actor === "auto-rule")).toBe(false);

    const childRef = `${childRequest.event.toolUseId}#${childRequest.seq}`;
    await post(`/api/runs/${childId}/approvals/${encodeURIComponent(childRef)}`, { decision: "allow" });
    await waitForDone(base, childId);
    expect(await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`))).toEqual(parentEventsBefore);
  });

  it("复制其它 run 的 grant 快照会被丢弃，普通 checkpoint 仍可读取", async () => {
    dir = await mkdtemp(join(tmpdir(), "history-grant-tamper-"));
    const runDir = join(dir, "target-run");
    await mkdir(runDir, { recursive: true });
    const hash = `sha256:${"a".repeat(64)}`;
    await writeFile(join(runDir, "meta.json"), JSON.stringify({
      version: 1,
      runId: "target-run",
      task: "tampered grant",
      status: "done",
      verify: false,
      createdAt: 1_000,
      finishedAt: 2_000,
      packName: null,
      mode: "single",
      effort: null,
      rubric: null,
      workdir: process.cwd(),
      conversationTurn: 1,
      planGate: false,
      planDecision: null,
      mainStopReason: "completed",
      outcome: null,
      checkpoint: {
        segmentIndex: 0,
        conversationTurn: 1,
        contextInputTokens: 10,
        runBudget: { usedTurns: 1, usedTokens: 10 },
        approvalGrants: [{
          version: 1,
          canonicalizationVersion: 1,
          policyVersion: 1,
          grantId: "copied-grant",
          approvalId: "tool#1",
          boundRunId: "another-run",
          scope: "run",
          name: "danger",
          inputScope: "exact-input",
          inputHash: hash,
          toolFingerprint: hash,
          issuedAt: 1_100,
          expiresAt: 9_999_999_999_999,
          maxUses: 3,
          usedUses: 0,
        }],
      },
    }), "utf8");

    await boot({ modelClient: new FakeModelClient([]), tools: [], workdir: process.cwd(), history: dir });
    const restored = ((await (await fetch(`${base}/api/runs`)).json()) as any[])
      .find((item) => item.runId === "target-run");
    expect(restored).toBeDefined();
    expect(restored.approvalGrants).toMatchObject({ active: 0, archivedAudit: 0, restorable: false });
  });

  it("重启后从检查点派生新 run：父档案不变、正史与共享预算继续", async () => {
    dir = await mkdtemp(join(tmpdir(), "history-"));
    await boot({
      modelClient: new FakeModelClient([
        fakeMessage([textBlock("第一段记住 alpha-7")], "end_turn", {
          input_tokens: 90,
          output_tokens: 10,
        }),
      ]),
      tools: [autoTool("noop")],
      workdir: process.cwd(),
      history: dir,
    });
    const { runId } = (await (await post("/api/runs", { task: "归档我", verify: false })).json()) as { runId: string };
    await waitForDone(base, runId);
    const before = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    await handle!.close();
    handle = undefined;

    const resumedModel = new FakeModelClient([
      fakeMessage([textBlock("第二段仍记得 alpha-7")], "end_turn", {
        input_tokens: 40,
        output_tokens: 10,
      }),
    ]);
    await boot({ modelClient: resumedModel, tools: [autoTool("noop")], workdir: process.cwd(), history: dir });
    const list = (await (await fetch(`${base}/api/runs`)).json()) as any[];
    const restored = list.find((r) => r.runId === runId);
    expect(restored, "重启后列表里没有这个 run").toBeDefined();
    expect(restored.archived).toBe(true);
    expect(restored.status).toBe("done");
    expect(restored.stopReason).toBe("completed");
    expect(restored.task).toBe("归档我");
    expect(restored.canContinue).toBe(true);
    expect(restored.continuationMode).toBe("fork");

    // 事件重放逐条等价——界面的一切都从重放长出来，这是档案的硬契约（V-05 的延伸）
    const after = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    expect(after).toEqual(before);

    const transcript = (await (await fetch(`${base}/api/runs/${runId}/transcript`)).json()) as any;
    expect(transcript.segments.length).toBeGreaterThan(0);

    const follow = await post(`/api/runs/${runId}/messages`, { text: "暗号是什么？" });
    expect(follow.status).toBe(200);
    const fork = (await follow.json()) as any;
    expect(fork.runId).not.toBe(runId);
    expect(fork.continuedFrom).toBe(runId);
    expect(fork.continuationMode).toBe("fork");
    await waitForDone(base, fork.runId);

    // 真正送到模型的是父运行的完整正史 + 新反馈，不是只拿摘要重新开局。
    const request = resumedModel.requests[0]!;
    const flattened = JSON.stringify(request.messages);
    expect(flattened).toContain("alpha-7");
    expect(flattened).toContain("暗号是什么？");

    const childEvents = (await readSSEAll(await fetch(`${base}/api/runs/${fork.runId}/events`))) as any[];
    const lineage = childEvents.find((item) => item.event.type === "run_forked");
    expect(lineage?.event.parentRunId).toBe(runId);
    const childDone = childEvents.find((item) => item.source === "main" && item.event.type === "done");
    expect(childDone.event.runBudget.usedTurns).toBe(2);
    expect(childDone.event.runBudget.usedTokens).toBe(150);

    const afterList = (await (await fetch(`${base}/api/runs`)).json()) as any[];
    const parent = afterList.find((item) => item.runId === runId);
    const child = afterList.find((item) => item.runId === fork.runId);
    expect(parent.archived).toBe(true);
    expect(parent.status).toBe("done");
    expect(child.continuedFrom).toBe(runId);
    expect(child.rootRunId).toBe(runId);

    // 派生不会往父档案追加事件；旧运行保持不可变、可独立审计。
    const parentAfter = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    expect(parentAfter).toEqual(before);
  });

  it("重启不能绕过当前宿主更严格的总预算：列表提前阻断，模型零调用", async () => {
    dir = await mkdtemp(join(tmpdir(), "history-budget-"));
    await boot({
      modelClient: new FakeModelClient([fakeMessage([textBlock("第一段完成")], "end_turn")]),
      tools: [],
      workdir: process.cwd(),
      history: dir,
    });
    const { runId } = (await (await post("/api/runs", { task: "预算边界", verify: false })).json()) as { runId: string };
    await waitForDone(base, runId);
    await handle!.close();
    handle = undefined;

    const resumedModel = new FakeModelClient([fakeMessage([textBlock("不应被调用")], "end_turn")]);
    process.env.AGENT_TOTAL_MAX_TURNS = "1";
    try {
      await boot({ modelClient: resumedModel, tools: [], workdir: process.cwd(), history: dir });
      const restored = ((await (await fetch(`${base}/api/runs`)).json()) as any[])
        .find((item) => item.runId === runId);
      expect(restored.canContinue).toBe(false);
      expect(restored.continuationMode).toBeNull();
      expect(restored.continuationBlockReason).toContain("总轮次预算已用尽");

      const response = await post(`/api/runs/${runId}/messages`, { text: "再跑一轮" });
      expect(response.status).toBe(409);
      expect(((await response.json()) as any).error).toContain("总轮次预算已用尽");
      expect(resumedModel.requests).toHaveLength(0);
    } finally {
      delete process.env.AGENT_TOTAL_MAX_TURNS;
    }
  });

  it("重启不能移除检查点里的旧上限；子 run 用尽后 live 入口也提前关闭", async () => {
    dir = await mkdtemp(join(tmpdir(), "history-old-budget-"));
    process.env.AGENT_TOTAL_MAX_TURNS = "2";
    try {
      await boot({
        modelClient: new FakeModelClient([fakeMessage([textBlock("第一段")], "end_turn")]),
        tools: [],
        workdir: process.cwd(),
        history: dir,
      });
      const { runId } = (await (await post("/api/runs", { task: "旧上限", verify: false })).json()) as { runId: string };
      await waitForDone(base, runId);
      await handle!.close();
      handle = undefined;
      delete process.env.AGENT_TOTAL_MAX_TURNS;

      const resumedModel = new FakeModelClient([
        fakeMessage([textBlock("第二段，正好耗尽旧上限")], "end_turn"),
      ]);
      await boot({ modelClient: resumedModel, tools: [], workdir: process.cwd(), history: dir });
      const follow = await post(`/api/runs/${runId}/messages`, { text: "继续" });
      const childId = ((await follow.json()) as any).runId as string;
      await waitForDone(base, childId);

      const events = (await readSSEAll(await fetch(`${base}/api/runs/${childId}/events`))) as any[];
      const done = events.find((item) => item.source === "main" && item.event.type === "done");
      expect(done.event.runBudget).toMatchObject({ maxTurns: 2, usedTurns: 2 });

      const child = ((await (await fetch(`${base}/api/runs`)).json()) as any[])
        .find((item) => item.runId === childId);
      expect(child.canContinue).toBe(false);
      expect(child.continuationBlockReason).toContain("总轮次预算已用尽");

      const blocked = await post(`/api/runs/${childId}/messages`, { text: "第三段" });
      expect(blocked.status).toBe(409);
      expect(((await blocked.json()) as any).error).toContain("总轮次预算已用尽");
      expect(resumedModel.requests).toHaveLength(1);
    } finally {
      delete process.env.AGENT_TOTAL_MAX_TURNS;
    }
  });

  it("归档工作目录不在当前白名单时拒绝派生，不把旧权限带进新宿主", async () => {
    dir = await mkdtemp(join(tmpdir(), "history-workdir-"));
    const oldWorkdir = join(dir, "old-workdir");
    const currentWorkdir = join(dir, "current-workdir");
    await mkdir(oldWorkdir);
    await mkdir(currentWorkdir);
    await boot({
      modelClient: new FakeModelClient([fakeMessage([textBlock("完成")], "end_turn")]),
      tools: [],
      workdir: oldWorkdir,
      history: dir,
    });
    const { runId } = (await (await post("/api/runs", { task: "目录边界", verify: false })).json()) as { runId: string };
    await waitForDone(base, runId);
    await handle!.close();
    handle = undefined;

    const resumedModel = new FakeModelClient([fakeMessage([textBlock("不应被调用")], "end_turn")]);
    await boot({ modelClient: resumedModel, tools: [], workdir: currentWorkdir, history: dir });
    const restored = ((await (await fetch(`${base}/api/runs`)).json()) as any[])
      .find((item) => item.runId === runId);
    expect(restored.canContinue).toBe(false);
    expect(restored.continuationBlockReason).toContain("不在当前宿主白名单");

    const response = await post(`/api/runs/${runId}/messages`, { text: "继续" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as any).error).toContain("不在当前宿主白名单");
    expect(resumedModel.requests).toHaveLength(0);
  });

  it("宿主收尾时在飞的 run 也归档：审批过期宣告与 run_end(closed) 都在档案里", async () => {
    dir = await mkdtemp(join(tmpdir(), "history-"));
    await boot({
      modelClient: new FakeModelClient([fakeMessage([toolUseBlock("tu_hang", "sensitive", {})], "tool_use")]),
      tools: [askTool("sensitive")],
      workdir: process.cwd(),
      history: dir,
    });
    const { runId } = (await (await post("/api/runs", { task: "开着就关", verify: false })).json()) as { runId: string };
    await waitForEvent(base, runId, (e: any) => e.event.type === "approval_request");
    await handle!.close();
    handle = undefined;

    await boot({ modelClient: new FakeModelClient([]), tools: [], workdir: process.cwd(), history: dir });
    const restored = ((await (await fetch(`${base}/api/runs`)).json()) as any[]).find((r) => r.runId === runId);
    expect(restored.status).toBe("done");
    const events = (await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`))) as any[];
    expect(events.map((e) => e.event.type)).toContain("approval_expired");
    expect(events.at(-1)!.event.type).toBe("run_end");
    expect(events.at(-1)!.event.outcome).toBe("closed");
  });

  it("崩溃档案（meta 停在 running）按异常终止恢复，绝不显示成还在跑", async () => {
    dir = await mkdtemp(join(tmpdir(), "history-"));
    const runDir = join(dir, "crash-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "meta.json"),
      JSON.stringify({
        version: 1, runId: "crash-run", task: "崩溃现场", status: "running", verify: false,
        createdAt: 1000, finishedAt: null, packName: null, mode: "single", effort: null,
        rubric: null, workdir: null, conversationTurn: 1, planGate: false, planDecision: null,
        mainStopReason: null, outcome: null,
      }),
      "utf8",
    );
    await writeFile(
      join(runDir, "events.jsonl"),
      `${JSON.stringify({ seq: 0, source: "main", ts: 1001, event: { type: "turn_start", turn: 1 } })}\n`,
      "utf8",
    );

    await boot({ modelClient: new FakeModelClient([]), tools: [], workdir: process.cwd(), history: dir });
    const r = ((await (await fetch(`${base}/api/runs`)).json()) as any[]).find((x) => x.runId === "crash-run");
    expect(r.status).toBe("done");
    expect(r.stopReason).toBe("error");
    expect(r.canContinue).toBe(false);
    // 事件流缺 run_end 时合成一条，否则重放出来的界面会永远"运行中"
    const events = (await readSSEAll(await fetch(`${base}/api/runs/crash-run/events`))) as any[];
    expect(events.at(-1)!.event.type).toBe("run_end");
    expect(events.at(-1)!.event.mainStopReason).toBe("error");
    expect(events.at(-1)!.event.synthesized).toBe("host_not_finalized");
  });

  it("保留策略（判据③）：超出 keep 的最老档案被修剪，重启后列表同口径", async () => {
    dir = await mkdtemp(join(tmpdir(), "history-"));
    await boot({
      modelClient: new FakeModelClient([
        fakeMessage([textBlock("一")], "end_turn"),
        fakeMessage([textBlock("二")], "end_turn"),
        fakeMessage([textBlock("三")], "end_turn"),
      ]),
      tools: [],
      workdir: process.cwd(),
      history: dir,
      historyKeep: 2,
    });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { runId } = (await (await post("/api/runs", { task: `任务${i}`, verify: false })).json()) as { runId: string };
      ids.push(runId);
      await waitForDone(base, runId);
      await new Promise((r) => setTimeout(r, 10)); // createdAt 是排序键，别让两条同毫秒
    }
    await handle!.close();
    handle = undefined;

    expect((await readdir(dir)).sort()).toEqual([ids[1]!, ids[2]!].sort());

    await boot({ modelClient: new FakeModelClient([]), tools: [], workdir: process.cwd(), history: dir, historyKeep: 2 });
    const list = (await (await fetch(`${base}/api/runs`)).json()) as any[];
    expect(list.map((r) => r.runId).sort()).toEqual([ids[1]!, ids[2]!].sort());
  });

  it("坏档案逐条跳过，好档案照常恢复——档案坏了不影响宿主启动", async () => {
    dir = await mkdtemp(join(tmpdir(), "history-"));
    await mkdir(join(dir, "bogus"));
    await writeFile(join(dir, "bogus", "meta.json"), "{ 这不是 JSON", "utf8");
    await mkdir(join(dir, "no-meta"));
    const good = join(dir, "good-run");
    await mkdir(good);
    await writeFile(
      join(good, "meta.json"),
      JSON.stringify({
        version: 1, runId: "good-run", task: "好档案", status: "done", verify: false,
        createdAt: 2000, finishedAt: 2100, packName: null, mode: "single", effort: null,
        rubric: null, workdir: null, conversationTurn: 1, planGate: false, planDecision: null,
        mainStopReason: "completed", outcome: null,
      }),
      "utf8",
    );

    await boot({ modelClient: new FakeModelClient([]), tools: [], workdir: process.cwd(), history: dir });
    const list = (await (await fetch(`${base}/api/runs`)).json()) as any[];
    expect(list.map((r) => r.runId)).toEqual(["good-run"]);
  });

  it("档案根不可写时运行照常完成——仪器坏了不能影响被测对象（与台账同纪律）", async () => {
    dir = await mkdtemp(join(tmpdir(), "history-"));
    const file = join(dir, "plain.txt");
    await writeFile(file, "x", "utf8");
    // 根的父路径是普通文件：mkdir 必败，写入链熄火，但 run 必须照常跑完
    await boot({
      modelClient: new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]),
      tools: [],
      workdir: process.cwd(),
      history: join(file, "sub"),
    });
    const { runId } = (await (await post("/api/runs", { task: "x", verify: false })).json()) as { runId: string };
    await waitForDone(base, runId);
    const r = ((await (await fetch(`${base}/api/runs`)).json()) as any[]).find((x) => x.runId === runId);
    expect(r.status).toBe("done");
    expect(r.stopReason).toBe("completed");
  });

  it("historyRootPath / historyKeepCount：env 覆盖与非法值回退", () => {
    expect(historyRootPath({}, "/proj")).toMatch(/[\\/]proj[\\/]\.agent-run-history$/);
    expect(historyRootPath({ AGENT_RUN_HISTORY_DIR: "out/h" }, "/proj")).toMatch(/out[\\/]h$/);
    expect(historyKeepCount({})).toBe(DEFAULT_HISTORY_KEEP);
    expect(historyKeepCount({ AGENT_RUN_HISTORY_KEEP: "7" })).toBe(7);
    expect(historyKeepCount({ AGENT_RUN_HISTORY_KEEP: "abc" })).toBe(DEFAULT_HISTORY_KEEP);
    expect(historyKeepCount({ AGENT_RUN_HISTORY_KEEP: "0" })).toBe(DEFAULT_HISTORY_KEEP);
  });

  it("RUN-01：活 run 写 state.json；列表暴露 durablePhase 且 sameRunResume=false", async () => {
    dir = await mkdtemp(join(tmpdir(), "history-state-"));
    await boot({
      modelClient: new FakeModelClient([fakeMessage([textBlock("done")], "end_turn")]),
      tools: [autoTool("noop")],
      workdir: process.cwd(),
      history: dir,
    });
    const { runId } = (await (await post("/api/runs", { task: "state me", verify: false })).json()) as {
      runId: string;
    };
    await waitForDone(base, runId);
    const list = (await (await fetch(`${base}/api/runs`)).json()) as any[];
    const row = list.find((r) => r.runId === runId);
    expect(row.sameRunResume).toBe(false);
    expect(row.durablePhase).toBe("executing"); // 可追问的 completed 保持 executing
    expect(row.durableRecovery).toBe("fork_from_checkpoint");
    // writer 链是异步的：关宿主 flush 后再读盘，避免 waitForDone 与 rename 赛跑
    await handle!.close();
    handle = undefined;
    const statePath = join(dir, runId, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(state.phase).toBe("executing");
    expect(state.runId).toBe(runId);
    expect(state.segmentSource).toBe("main");
  });

  it("RUN-01：崩溃档案(meta=running)恢复后 phase=interrupted，不冒充可同 run 续跑", async () => {
    dir = await mkdtemp(join(tmpdir(), "history-crash-"));
    const runDir = join(dir, "crash-1");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "meta.json"),
      JSON.stringify({
        version: 1,
        runId: "crash-1",
        task: "崩了",
        status: "running",
        verify: false,
        createdAt: 1000,
        finishedAt: null,
        packName: null,
        mode: "single",
        effort: null,
        rubric: null,
        workdir: null,
        conversationTurn: 1,
        planGate: false,
        planDecision: null,
        mainStopReason: null,
        outcome: null,
      }),
      "utf8",
    );
    await writeFile(
      join(runDir, "state.json"),
      JSON.stringify({
        version: 1,
        runId: "crash-1",
        phase: "executing",
        updatedAt: 1001,
        plan: null,
        segmentIndex: 0,
        segmentSource: "main",
        verificationRound: 0,
        pendingApprovalIds: [],
        pendingQuestionIds: [],
        rootRunId: null,
        continuedFrom: null,
      }),
      "utf8",
    );
    await writeFile(join(runDir, "events.jsonl"), "", "utf8");
    await boot({ modelClient: new FakeModelClient([]), tools: [], workdir: process.cwd(), history: dir });
    const list = (await (await fetch(`${base}/api/runs`)).json()) as any[];
    const row = list.find((r) => r.runId === "crash-1");
    expect(row.archived).toBe(true);
    expect(row.status).toBe("done");
    expect(row.durablePhase).toBe("interrupted");
    expect(row.sameRunResume).toBe(false);
    expect(row.continuationMode).not.toBe("same");
    expect(row.continuationMode).not.toBe("same-run");
    const recovered = JSON.parse(await readFile(join(runDir, "state.json"), "utf8"));
    expect(recovered.phase).toBe("interrupted");
  });

  it("RUN-01 Phase 2：崩溃+checkpoint → sameRunResume；续跑同 runId 发 run_resumed", async () => {
    dir = await mkdtemp(join(tmpdir(), "history-same-run-"));
    await boot({
      modelClient: new FakeModelClient([
        fakeMessage([textBlock("段1 secret-z9")], "end_turn", {
          input_tokens: 80,
          output_tokens: 20,
        }),
      ]),
      tools: [autoTool("noop")],
      workdir: process.cwd(),
      history: dir,
    });
    const { runId } = (await (await post("/api/runs", { task: "热恢复我", verify: false })).json()) as {
      runId: string;
    };
    await waitForDone(base, runId);
    await handle!.close();
    handle = undefined;

    // 模拟进程崩溃：meta 仍 running，state 停在 executing（有 checkpoint）
    const runDir = join(dir, runId);
    const meta = JSON.parse(await readFile(join(runDir, "meta.json"), "utf8"));
    expect(meta.checkpoint).toBeTruthy();
    meta.status = "running";
    meta.finishedAt = null;
    await writeFile(join(runDir, "meta.json"), JSON.stringify(meta), "utf8");
    const state = JSON.parse(await readFile(join(runDir, "state.json"), "utf8"));
    state.phase = "executing";
    await writeFile(join(runDir, "state.json"), JSON.stringify(state), "utf8");

    const resumedModel = new FakeModelClient([
      fakeMessage([textBlock("段2 仍见 secret-z9")], "end_turn", {
        input_tokens: 30,
        output_tokens: 10,
      }),
    ]);
    await boot({
      modelClient: resumedModel,
      tools: [autoTool("noop")],
      workdir: process.cwd(),
      history: dir,
    });
    const list = (await (await fetch(`${base}/api/runs`)).json()) as any[];
    const row = list.find((r) => r.runId === runId);
    expect(row.durablePhase).toBe("interrupted");
    expect(row.sameRunResume).toBe(true);
    expect(row.continuationMode).toBe("same-run");
    expect(row.canContinue).toBe(true);
    expect(row.durableBudget?.usedTurns).toBeGreaterThanOrEqual(1);

    const follow = await post(`/api/runs/${runId}/messages`, { text: "接着跑" });
    expect(follow.status).toBe(200);
    const body = (await follow.json()) as any;
    expect(body.runId).toBe(runId);
    expect(body.continuationMode).toBe("same-run");
    expect(body.sameRunResume).toBe(true);
    await waitForDone(base, runId);

    const events = (await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`))) as any[];
    const resumed = events.find((item) => item.event.type === "run_resumed");
    expect(resumed?.event.runId).toBe(runId);
    expect(events.some((item) => item.event.type === "run_forked")).toBe(false);

    const flattened = JSON.stringify(resumedModel.requests[0]!.messages);
    expect(flattened).toContain("secret-z9");
    expect(flattened).toContain("接着跑");

    const afterState = JSON.parse(await readFile(join(runDir, "state.json"), "utf8"));
    expect(afterState.lastSameRunResumeAt).toBeTruthy();
    expect(["executing", "completed"]).toContain(afterState.phase);
  });
});


/**
 * §5.2 需求澄清的宿主接线（第零节那条规律：harness 加能力必须同提交接宿主）。
 *
 * 锁的是**阻塞式交互的三个出口**：答、跳过、收尾过期。任何一个不通，
 * 执行协程就会永远吊在 ask_user 的 execute 里——V-01 那类失效的原样重演。
 */
describe("§5.2 需求澄清：Web 宿主接线", () => {
  let handle: UiServerHandle | undefined;
  let port = 0;
  let base = "";

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  /** 委托方实测场景：一句「做一版 Desktop UI」带出三个正交未知（决定 6） */
  const QUESTIONS = {
    questions: [
      { question: "桌面端用哪个框架？", options: ["Electron", "Tauri"], fallback: "默认 Tauri" },
      { question: "UI 风格？", options: ["沿用现有暗色系", "重做一套"], fallback: "默认沿用" },
    ],
  };

  /** 模型先问一次，拿到答复后收笔 */
  function askingScript() {
    return [
      fakeMessage([toolUseBlock("tu_1", "ask_user", QUESTIONS)], "tool_use"),
      fakeMessage([textBlock("知道了，照办")], "end_turn"),
    ];
  }

  async function start(body: Record<string, unknown>) {
    handle = createUiServer({
      modelClient: new FakeModelClient(askingScript()),
      tools: [autoTool("noop")],
      workdir: process.cwd(),
    });
    port = await startServer(handle);
    base = baseUrl(port);
    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })).json() as { runId: string };
    return runId;
  }

  async function waitForQuestion(runId: string): Promise<any> {
    for (let i = 0; i < 150; i++) {
      const list = await (await fetch(`${base}/api/runs`)).json() as any[];
      const r = list.find((x) => x.runId === runId);
      if (r?.awaitingQuestion) return r.awaitingQuestion;
      if (r?.status === "done") throw new Error("run 已收尾但从未挂起提问");
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error("等待提问超时");
  }

  it("默认关：没勾选时 ask_user 根本不在工具面上（决定 1）", async () => {
    const runId = await start({ task: "做一版 Desktop UI" });
    await waitForDone(base, runId);
    const events = await readSSESnapshot(base, runId);
    expect(events.some((e: any) => e.event.type === "user_question_request")).toBe(false);
  });

  it("显式开启 → 一次挂起一组问题，问题与候选进事件流（刷新后仍看得到）", async () => {
    const runId = await start({ task: "做一版 Desktop UI", askUser: true });
    const pending = await waitForQuestion(runId);
    expect(pending.questions, "一次打断带一组问题，不是一个").toHaveLength(2);
    expect(pending.questions[0].question).toContain("框架");
    expect(pending.questions[0].options).toEqual(["Electron", "Tauri"]);
    expect(pending.questions[1].fallback).toBe("默认沿用");

    const events = await readSSESnapshot(base, runId);
    const req = events.find((e: any) => e.event.type === "user_question_request");
    expect(req, "提问必须进事件流——重连重放要能复原").toBeDefined();
  });

  it("逐题答复回到模型手里，run 正常收尾；漏答那题带上它自己的默认", async () => {
    const runId = await start({ task: "做一版 Desktop UI", askUser: true });
    await waitForQuestion(runId);
    const res = await fetch(`${base}/api/runs/${runId}/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: ["Tauri", null] }),
    });
    expect(res.status).toBe(200);
    await waitForDone(base, runId);

    const events = await readSSESnapshot(base, runId);
    const resolved = events.find((e: any) => e.event.type === "user_question_resolved") as any;
    expect(resolved.event.answers).toEqual(["Tauri", null]);
    expect(resolved.event.skipped).toBe(false);
    const toolResult = events.find(
      (e: any) => e.event.type === "tool_result" && String(e.event.result?.content ?? "").includes("Tauri"),
    );
    expect(toolResult, "答复必须回到模型的 tool_result").toBeDefined();
    // 没答的那题不含糊过去：照实说并带上模型自己写的默认
    expect(String((toolResult as any).event.result.content)).toContain("默认沿用");
  });

  it("答复条数与问题数不符 → 400（对不齐的回填比没有更危险）", async () => {
    const runId = await start({ task: "做一版 Desktop UI", askUser: true });
    await waitForQuestion(runId);
    const res = await fetch(`${base}/api/runs/${runId}/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: ["Tauri"] }),
    });
    expect(res.status).toBe(400);
  });

  it('「都让它自己定」照实记为 skipped，而不是画成"没人答"（V-04）', async () => {
    const runId = await start({ task: "做一版 Desktop UI", askUser: true });
    await waitForQuestion(runId);
    const res = await fetch(`${base}/api/runs/${runId}/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skip: true }),
    });
    expect(res.status).toBe(200);
    await waitForDone(base, runId);

    const events = await readSSESnapshot(base, runId);
    const resolved = events.find((e: any) => e.event.type === "user_question_resolved") as any;
    expect(resolved.event.skipped, "主动跳过与超时是两件事").toBe(true);
    expect(resolved.event.answers).toBeNull();
  });

  it("收尾时宣告过期并解除挂起——否则执行协程永远吊在 execute 里（V-01）", async () => {
    const runId = await start({ task: "做一版 Desktop UI", askUser: true });
    await waitForQuestion(runId);
    // 不回答，直接停止：这是最容易把 run 挂死的路径
    await fetch(`${base}/api/runs/${runId}/stop`, { method: "POST" });
    await waitForDone(base, runId);

    const events = await readSSESnapshot(base, runId);
    const expired = events.filter((e: any) => e.event.type === "user_question_expired");
    expect(expired.length, "过期必须进事件流，且只发一次").toBe(1);
    // cause 要照实说是"委托方停止的"。靠 finalizeRun 顺手补会写成 run_finished——
    // 把委托方的决定说成宿主收尾，V-04 同族
    expect((expired[0] as any).event.cause).toBe("stopped");
    const list = await (await fetch(`${base}/api/runs`)).json() as any[];
    expect(list.find((x) => x.runId === runId)?.awaitingQuestion, "挂起态必须解除").toBeNull();
  });

  /**
   * M13 那条变异逃过第一版测试，因为停止路径顺手把它盖住了。
   * 宿主关停是**唯一**不经过停止按钮、却仍可能留下挂起提问的路径——
   * 收尾侧那道闸只有在这里才看得见。
   */
  it("宿主关停时也宣告过期，cause=run_finished（收尾侧那道闸的唯一现场）", async () => {
    const runId = await start({ task: "做一版 Desktop UI", askUser: true });
    await waitForQuestion(runId);

    // 挂着一条 live SSE：关停时发出的帧只能在这里收——HTTP 一断就查不到了
    const res = await fetch(`${base}/api/runs/${runId}/events`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          seen += decoder.decode(value, { stream: true });
        }
      } catch { /* 关停时连接被掐断，正常 */ }
    })();

    await handle!.close();
    handle = undefined;
    await pump;

    expect(seen, "关停必须宣告过期，否则执行协程永远吊着").toContain("user_question_expired");
    expect(seen, "关停不是委托方按的停止，cause 要照实说").toContain("run_finished");
  });

  it("没有挂起提问时应答 409——「我到底答没答」必须有确定答案（R-01 口径）", async () => {
    const runId = await start({ task: "做一版 Desktop UI", askUser: true });
    await waitForQuestion(runId);
    await fetch(`${base}/api/runs/${runId}/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: ["Tauri", "沿用现有暗色系"] }),
    });
    const dup = await fetch(`${base}/api/runs/${runId}/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: ["Electron", "重做一套"] }),
    });
    expect(dup.status).toBe(409);
  });

  it("一题都没答被拒 400——要么给内容，要么显式 skip（不静默转换）", async () => {
    const runId = await start({ task: "做一版 Desktop UI", askUser: true });
    await waitForQuestion(runId);
    const res = await fetch(`${base}/api/runs/${runId}/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: ["   ", null] }),
    });
    expect(res.status).toBe(400);
  });
});

describe("目标级闭环：Web 真实宿主接线", () => {
  let handle: UiServerHandle | undefined;
  let base = "";

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function boot(model: ModelClient, options: { taskCompletion?: boolean } = {}): Promise<void> {
    handle = createUiServer({
      modelClient: model,
      tools: [autoTool("noop")],
      workdir: process.cwd(),
      ...options,
    });
    base = baseUrl(await startServer(handle));
  }

  async function createRun(body: Record<string, unknown>): Promise<string> {
    const response = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { runId: string }).runId;
  }

  async function waitQuestion(runId: string, previousId?: string): Promise<any> {
    for (let i = 0; i < 150; i++) {
      const list = (await (await fetch(`${base}/api/runs`)).json()) as any[];
      const pending = list.find((item) => item.runId === runId)?.awaitingQuestion;
      if (pending && pending.id !== previousId) return pending;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("等待 Web 提问超时");
  }

  it("run_end 结果映射 fail-closed：只有明确 completed 才能标绿", () => {
    expect(runOutcomeForStopReason("completed")).toBe("completed");
    expect(runOutcomeForStopReason("partial")).toBe("partial");
    expect(runOutcomeForStopReason("blocked")).toBe("blocked");
    expect(runOutcomeForStopReason("aborted")).toBe("closed");
    expect(runOutcomeForStopReason("plan_gate_expired")).toBe("closed");
    expect(runOutcomeForStopReason("plan_rejected")).toBe("rejected");
    for (const reason of [
      "incomplete",
      "stalled",
      "max_tokens",
      "max_turns",
      "budget_exhausted",
      "refusal",
      "error",
      "未来新增但尚未分类的值",
      undefined,
    ]) {
      expect(runOutcomeForStopReason(reason)).toBe("error");
    }
  });

  it("end_turn 不能把 Web run 标绿；finish_task 的 partial 与证据原样进入 done/run_end/列表", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock("看起来做完了")], "end_turn"),
      fakeMessage([
        toolUseBlock("finish", FINISH_TASK_TOOL_NAME, {
          status: "partial",
          summary: "UI 骨架可运行，但尚未签名打包",
          artifacts: ["ui/public/app.js"],
          verification: ["npm test 通过"],
          assumptions: [],
          blockers: ["缺少代码签名证书"],
        }),
      ], "tool_use"),
    ]);
    await boot(model, { taskCompletion: true });
    const runId = await createRun({ task: "实现 Desktop UI" });
    await waitForDone(base, runId);

    const events = await readSSESnapshot(base, runId);
    expect(events.some((item: any) => item.event.type === "recovery_decision")).toBe(true);
    const done = events.find((item: any) => item.source === "main" && item.event.type === "done") as any;
    expect(done.event.stopReason).toBe("partial");
    expect(done.event.completion.blockers).toEqual(["缺少代码签名证书"]);
    expect(done.event.runBudget.usedTurns).toBe(2);
    const end = events.find((item: any) => item.event.type === "run_end") as any;
    expect(end.event.outcome).toBe("partial");
    const list = (await (await fetch(`${base}/api/runs`)).json()) as any[];
    expect(list.find((item) => item.runId === runId)?.stopReason).toBe("partial");
  });

  it("plan 模式先在 Web 挂起成组问题，答复合并进 planner 唯一任务输入", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("ask", "ask_user", {
        questions: [
          { question: "桌面框架？", options: ["Tauri", "Electron"], fallback: "Tauri" },
          { question: "交付深度？", options: ["可运行 MVP", "发布版"], fallback: "可运行 MVP" },
        ],
      })], "tool_use"),
      fakeMessage([toolUseBlock("requirements", REQUIREMENTS_TOOL_NAME, {
        task: "使用 Tauri 实现可运行 Desktop UI MVP",
        acceptance: ["能够启动"],
        assumptions: [],
      })], "tool_use"),
      fakeMessage([toolUseBlock("plan", PLAN_TOOL_NAME, {
        subtasks: [{
          id: "s1", title: "实现 UI", description: "使用 Tauri 实现 MVP",
          acceptance: ["能够启动"], dependsOn: [],
        }],
      })], "tool_use"),
      fakeMessage([toolUseBlock("finish", FINISH_TASK_TOOL_NAME, {
        status: "completed", summary: "MVP 已实现", artifacts: ["src-tauri"],
        verification: ["能够启动"], assumptions: [], blockers: [],
      })], "tool_use"),
      fakeMessage([toolUseBlock("verdict", VERDICT_TOOL_NAME, {
        passed: true, issues: [], unverified: [], advisory: [], summary: "通过",
      })], "tool_use"),
    ]);
    await boot(model, { taskCompletion: true });
    const runId = await createRun({
      task: "给项目开发一版 Desktop UI",
      mode: "plan",
      concurrency: 1,
      askUser: true,
    });
    const pending = await waitQuestion(runId);
    expect(pending.questions).toHaveLength(2);
    const answer = await fetch(`${base}/api/runs/${runId}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: ["Tauri", "可运行 MVP"] }),
    });
    expect(answer.status).toBe(200);
    await waitForDone(base, runId);

    expect(JSON.stringify(model.requests[2]!.messages)).toContain("使用 Tauri 实现可运行 Desktop UI MVP");
    expect(JSON.stringify(model.requests[2]!.messages)).toContain("能够启动");
    expect(model.requests[2]!.tools.some((tool) => tool.name === "ask_user")).toBe(false);
    expect(model.requests[2]!.tools.some((tool) => tool.name === FINISH_TASK_TOOL_NAME)).toBe(false);
    const events = await readSSESnapshot(base, runId);
    const planResult = events.find((item: any) => item.event.type === "plan_result") as any;
    expect(planResult.event.clarification.asked).toBe(true);
  });

  it("并行子任务同时 ask_user 时宿主逐组排队，不覆盖 pendingQuestion", async () => {
    let askId = 0;
    const plan = {
      subtasks: [
        { id: "s1", title: "A", description: "A", acceptance: [], dependsOn: [] },
        { id: "s2", title: "B", description: "B", acceptance: [], dependsOn: [] },
      ],
    };
    const adaptive: ModelClient = {
      async send(req) {
        const names = new Set(req.tools.map((tool) => tool.name));
        let message;
        if (names.has(REQUIREMENTS_TOOL_NAME)) {
          message = fakeMessage([toolUseBlock("requirements", REQUIREMENTS_TOOL_NAME, {
            task: "并行任务", acceptance: [], assumptions: [],
          })], "tool_use");
        } else if (names.has(PLAN_TOOL_NAME)) {
          message = fakeMessage([toolUseBlock("plan", PLAN_TOOL_NAME, plan)], "tool_use");
        } else if (names.has(VERDICT_TOOL_NAME)) {
          message = fakeMessage([toolUseBlock(`verdict-${askId}`, VERDICT_TOOL_NAME, {
            passed: true, issues: [], unverified: [], advisory: [], summary: "通过",
          })], "tool_use");
        } else if (JSON.stringify(req.messages).includes("委托方答复")) {
          message = fakeMessage([textBlock("完成")], "end_turn");
        } else {
          askId += 1;
          message = fakeMessage([toolUseBlock(`ask-${askId}`, "ask_user", {
            questions: [{
              question: `并行问题 ${askId}？`, options: ["选项 A", "选项 B"], fallback: "选项 A",
            }],
          })], "tool_use");
        }
        return { message, stopReason: message.stop_reason, usage: message.usage };
      },
    };
    await boot(adaptive);
    const runId = await createRun({ task: "并行任务", mode: "plan", concurrency: 2, askUser: true });

    const first = await waitQuestion(runId);
    let events = await readSSESnapshot(base, runId);
    expect(events.filter((item: any) => item.event.type === "user_question_request")).toHaveLength(1);
    await fetch(`${base}/api/runs/${runId}/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: ["选项 A"] }),
    });
    const second = await waitQuestion(runId, first.id);
    expect(second.id).not.toBe(first.id);
    await fetch(`${base}/api/runs/${runId}/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: ["选项 B"] }),
    });
    await waitForDone(base, runId);
    events = await readSSESnapshot(base, runId);
    expect(events.filter((item: any) => item.event.type === "user_question_request")).toHaveLength(2);
    expect(events.filter((item: any) => item.event.type === "user_question_resolved")).toHaveLength(2);
  });
});

describe("P0 production host boundary", () => {
  let handle: UiServerHandle | undefined;
  let base = "";

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function boot(
    options: Omit<Parameters<typeof createUiServer>[0], "modelClient" | "workdir"> = {},
    model: ModelClient = new FakeModelClient([
      fakeMessage([textBlock("done")], "end_turn"),
      fakeMessage([textBlock("done")], "end_turn"),
      fakeMessage([textBlock("done")], "end_turn"),
    ]),
  ): Promise<void> {
    handle = createUiServer({
      modelClient: model,
      tools: [autoTool("noop")],
      workdir: process.cwd(),
      ...options,
    });
    base = baseUrl(await startServer(handle));
  }

  it("拒绝跨源副作用、缺失访问令牌和非 JSON 创建请求", async () => {
    await boot({ accessToken: "p0-secret" });

    const evil = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: {
        Authorization: "Bearer p0-secret",
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
      body: JSON.stringify({ task: "csrf", verify: false }),
    });
    expect(evil.status).toBe(403);

    const unauthenticated = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "no token", verify: false }),
    });
    expect(unauthenticated.status).toBe(401);

    const plain = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: {
        Authorization: "Bearer p0-secret",
        "Content-Type": "text/plain",
      },
      body: JSON.stringify({ task: "simple request", verify: false }),
    });
    expect(plain.status).toBe(415);

    const rebindingStatus = await new Promise<number>((resolveStatus, rejectStatus) => {
      const target = new URL(base);
      const body = JSON.stringify({ task: "dns rebinding", verify: false });
      const request = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: "/api/runs",
        method: "POST",
        headers: {
          Authorization: "Bearer p0-secret",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Host: "attacker.example",
          Origin: "http://attacker.example",
        },
      }, (response) => {
        response.resume();
        response.on("end", () => resolveStatus(response.statusCode ?? 0));
      });
      request.on("error", rejectStatus);
      request.end(body);
    });
    expect(rebindingStatus).toBe(421);

    const accepted = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: {
        Authorization: "Bearer p0-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ task: "authorized", verify: false }),
    });
    expect(accepted.status, await accepted.text()).toBe(200);

    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    const metrics = await fetch(`${base}/metrics`, {
      headers: { Authorization: "Bearer p0-secret" },
    });
    expect(metrics.status).toBe(200);
    const metricText = await metrics.text();
    expect(metricText).toContain('agent_harness_security_rejections_total{reason="origin"} 1');
    expect(metricText).toContain('agent_harness_security_rejections_total{reason="host"} 1');
  });

  it("浏览器引导把 URL 令牌换成 HttpOnly cookie 并立即清理查询串", async () => {
    await boot({ accessToken: "p0-secret" });
    const bootstrap = await fetch(`${base}/?access_token=p0-secret`, { redirect: "manual" });
    expect(bootstrap.status).toBe(303);
    expect(bootstrap.headers.get("location")).toBe("/");
    const setCookie = bootstrap.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");

    const cookie = setCookie.split(";", 1)[0] ?? "";
    const harness = await fetch(`${base}/api/harness`, { headers: { Cookie: cookie } });
    expect(harness.status).toBe(200);
  });

  it("请求体超限返回 413，不能把任意大载荷缓存在内存", async () => {
    await boot({ requestBodyMaxBytes: 96 });
    const response = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "x".repeat(256), verify: false }),
    });
    expect(response.status).toBe(413);
  });

  it("单一来源的副作用请求超过窗口上限后返回 429", async () => {
    await boot({ mutationRateLimitPerMinute: 1 });
    const first = await fetch(`${base}/unknown-mutation`, { method: "POST" });
    expect(first.status).toBe(404);
    const second = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "rate limited", verify: false }),
    });
    expect(second.status).toBe(429);
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("关闭 bash 后工具快照与宿主限制都如实报告", async () => {
    await boot({ enableBash: false, tools: undefined });
    const snapshot = await (await fetch(`${base}/api/harness`)).json() as any;
    expect(snapshot.tools.map((tool: any) => tool.name)).not.toContain("bash");
    expect(snapshot.shell).toBeNull();
    expect(snapshot.hostLimits.bashEnabled).toBe(false);
  });

  it("达到活动运行上限时以 429 拒绝新任务", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("hold", "danger", {})], "tool_use"),
      fakeMessage([textBlock("stopped")], "end_turn"),
    ]);
    await boot({ maxActiveRuns: 1, tools: [askTool("danger")] }, model);

    const first = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "hold slot", verify: false }),
    });
    expect(first.status).toBe(200);
    const { runId } = await first.json() as { runId: string };
    let pending = 0;
    for (let i = 0; i < 100; i++) {
      const list = await (await fetch(`${base}/api/runs`)).json() as any[];
      pending = list.find((item) => item.runId === runId)?.pendingApprovals ?? 0;
      if (pending > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(pending).toBe(1);

    const second = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "overflow", verify: false }),
    });
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTruthy();
  });

  it("内存中的已完成运行按上限淘汰，长期常驻不会无限增长", async () => {
    await boot({ maxStoredRuns: 2 });
    for (const task of ["one", "two", "three"]) {
      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, verify: false }),
      });
      const { runId } = await response.json() as { runId: string };
      await waitForDone(base, runId);
    }
    const runs = await (await fetch(`${base}/api/runs`)).json() as any[];
    expect(runs.map((run) => run.task)).toEqual(["three", "two"]);
  });

  it("打开全局 SSE 时 close 仍会在期限内完成并结束流", async () => {
    await boot();
    const stream = await fetch(`${base}/api/stream`);
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    await reader.read(); // snapshot

    const closePromise = handle!.close();
    const result = await Promise.race([
      closePromise.then(() => "closed" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);

    if (result === "timeout") {
      await reader.cancel().catch(() => {});
      handle!.server.closeAllConnections();
      await closePromise.catch(() => {});
    }
    expect(result).toBe("closed");
    const end = await reader.read().catch(() => ({ done: true, value: undefined }));
    expect(end.done).toBe(true);
    handle = undefined;
  });

  it("历史写入失败会让 readiness 降级，但 liveness 与运行闭环仍存活", async () => {
    const dir = await mkdtemp(join(tmpdir(), "p0-health-"));
    const file = join(dir, "not-a-directory");
    await writeFile(file, "x", "utf8");
    try {
      await boot({ history: join(file, "child") });
      const created = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "health", verify: false }),
      });
      const { runId } = await created.json() as { runId: string };
      await waitForDone(base, runId);

      let ready: Response | undefined;
      for (let i = 0; i < 40; i++) {
        ready = await fetch(`${base}/ready`);
        if (ready.status === 503) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect((await fetch(`${base}/health`)).status).toBe(200);
      expect(ready?.status).toBe(503);
      expect(await ready!.json()).toMatchObject({ status: "degraded", history: { healthy: false } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * 监控闭环锁（审计 2026-08-24）：
 * ① runs_finished 按 outcome 分档——runbook 的"run errors 超基线即回滚"从此有数可查；
 * ② 告警文件引用的每个 agent_harness_* 指标必须真实存在于 /metrics 输出
 *    （告警引用幽灵指标 = 永远不响的保险丝，与"有指标没告警"同族但更隐蔽）；
 * ③ 进程死亡告警必须存在且钉在 job="agent-harness" 上——其余告警全基于自产指标，
 *    进程一死序列转 stale，全部失聪；up/absent 是唯一不依赖被监控者自己的规则。
 */
describe("监控闭环：outcome 分档指标与告警文件一致性", () => {
  it("跑完一个 run 后 outcome 档计 1，六档序列全部在场（含 0），无标签旧形状消失", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metrics-outcome-"));
    const handle = createUiServer({
      modelClient: new FakeModelClient([fakeMessage([textBlock("done")], "end_turn")]),
      workdir: dir,
    });
    try {
      const port = await startServer(handle);
      const base = baseUrl(port);
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "t" }),
      });
      const { runId } = await res.json();
      await waitForDone(base, runId);
      const text = await (await fetch(`${base}/metrics`)).text();
      // 字符类含 _ 与数字：仓库枚举先例大量 snake_case（plan_rejected 等），
      // [a-z]+ 会让未来的新档被 matchAll 静默跳过、绊线恰好在新增形态上失效（评审抓出）
      const buckets = [...text.matchAll(/^agent_harness_runs_finished_total\{outcome="([a-z0-9_]+)"\} (\d+)$/gm)]
        .map(([, outcome, n]) => [outcome, Number(n)] as const);
      // 六档全部在场
      expect(buckets.map(([o]) => o).sort()).toEqual(
        ["blocked", "closed", "completed", "error", "partial", "rejected"],
      );
      // 成功 run 必须落 completed 档（注入模型 + end_turn 是确定性的）——
      // 只查总和不查归属，会放过"恒计 error 档"这类变异（评审抓出的假绿缝）
      expect(buckets.find(([o]) => o === "completed")?.[1]).toBe(1);
      expect(buckets.reduce((sum, [, n]) => sum + n, 0)).toBe(1);
      // 无标签的旧形状必须消失（半新半旧的双形状会让 sum() 查询翻倍）
      expect(text).not.toMatch(/^agent_harness_runs_finished_total \d/m);
    } finally {
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("抛错的 run 落 error 档——分档归属可辨（把增量恒计某一档的变异在此红）", async () => {
    class CrashClient implements ModelClient {
      async send(): Promise<ModelTurn> {
        throw new Error("simulated model crash");
      }
    }
    const dir = await mkdtemp(join(tmpdir(), "metrics-outcome-err-"));
    const handle = createUiServer({ modelClient: new CrashClient(), workdir: dir });
    try {
      const port = await startServer(handle);
      const base = baseUrl(port);
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "t" }),
      });
      const { runId } = await res.json();
      await waitForDone(base, runId);
      const text = await (await fetch(`${base}/metrics`)).text();
      expect(text).toContain('agent_harness_runs_finished_total{outcome="error"} 1');
      expect(text).toContain('agent_harness_runs_finished_total{outcome="completed"} 0');
    } finally {
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * /metrics 的 token 序列解析成 Map 后做数值等值断言——不用 toContain：
   * '} 100' 是 '} 1000' 的前缀，裸子串对十倍类错值静默放行（评审两抓同款缝）。
   * 字符类含数字与下划线：snake_case 新档被 matchAll 静默跳过的缝同前。
   */
  const tokenSeries = (text: string): Map<string, number> =>
    new Map(
      [...text.matchAll(/^agent_harness_tokens_total\{role="([a-z0-9_]+)",kind="([a-z0-9_]+)"\} (\d+)$/gm)].map(
        ([, role, kind, n]) => [`${role}/${kind}`, Number(n)],
      ),
    );

  it("token 计量：普通 run 计入 execution 档精确值，16 序列全集在场（含 0）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metrics-tokens-"));
    const handle = createUiServer({
      modelClient: new FakeModelClient([fakeMessage([textBlock("done")], "end_turn")]),
      workdir: dir,
    });
    try {
      const port = await startServer(handle);
      const base = baseUrl(port);
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "t" }),
      });
      const { runId } = await res.json();
      await waitForDone(base, runId);
      const series = tokenSeries(await (await fetch(`${base}/metrics`)).text());
      // 16 序列全集（4 role × 4 kind）恒在场
      expect(series.size).toBe(16);
      // FakeModelClient 每轮 usage 固定 100/50——数值等值断言，多计/漏计/十倍错值都红
      expect(series.get("execution/input")).toBe(100);
      expect(series.get("execution/output")).toBe(50);
      expect(series.get("verification/input")).toBe(0);
      expect(series.get("planner/input")).toBe(0);
      expect(series.get("vision/input")).toBe(0);
    } finally {
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("token 计量防双计：verify+返工共 4 段，逐段求和精确等于脚本总量", async () => {
    // main → verifier(不通过) → 返工续跑 → verifier(通过)：4 段各 100/50。
    // done 的 usage 若是跨段累计（而非每段独立），execution 会计成 300/150——此锁即红
    const model = new FakeModelClient([
      fakeMessage([textBlock("首轮交付")], "end_turn"),
      fakeMessage(
        [textBlock(JSON.stringify({ passed: false, issues: ["缺少收尾"], summary: "未通过" }))],
        "end_turn",
      ),
      fakeMessage([textBlock("返工完成")], "end_turn"),
      fakeMessage(
        [textBlock(JSON.stringify({ passed: true, issues: [], summary: "通过" }))],
        "end_turn",
      ),
    ]);
    const dir = await mkdtemp(join(tmpdir(), "metrics-tokens-rework-"));
    const handle = createUiServer({ modelClient: model, workdir: dir });
    try {
      const port = await startServer(handle);
      const base = baseUrl(port);
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "t", verify: true }),
      });
      const { runId } = await res.json();
      await waitForDone(base, runId);
      const series = tokenSeries(await (await fetch(`${base}/metrics`)).text());
      expect(series.get("execution/input")).toBe(200);
      expect(series.get("execution/output")).toBe(100);
      expect(series.get("verification/input")).toBe(200);
      expect(series.get("verification/output")).toBe(100);
    } finally {
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("token 计量 plan 模式三角色全链路：planner/execution/verification 各归各档", async () => {
    // 五段脚本（同 v2-17 形状）：planner 拆两步 + s1 执行/裁决 + s2 执行/裁决。
    // 子任务 verifier 的 done 被 orchestrate 压掉——verification 档只能靠
    // runPlanned 的 onVerification 逐轮回调接线（评审：此前收尾回扫在宿主级
    // 异常时整体漏记）。接线断了此锁的 verification 档即为 0。
    const planJson = JSON.stringify({
      subtasks: [
        { id: "s1", title: "第一步", description: "做 A", acceptance: ["A 完成"], dependsOn: [] },
        { id: "s2", title: "第二步", description: "做 B", acceptance: ["B 完成"], dependsOn: ["s1"] },
      ],
    });
    const pass = () =>
      fakeMessage([textBlock(JSON.stringify({ passed: true, issues: [], summary: "通过" }))], "end_turn");
    const model = new FakeModelClient([
      fakeMessage([textBlock(["```json", planJson, "```"].join("\n"))], "end_turn"),
      fakeMessage([textBlock("s1 完成")], "end_turn"), pass(),
      fakeMessage([textBlock("s2 完成")], "end_turn"), pass(),
    ]);
    const dir = await mkdtemp(join(tmpdir(), "metrics-tokens-plan-"));
    const handle = createUiServer({ modelClient: model, workdir: dir });
    try {
      const port = await startServer(handle);
      const base = baseUrl(port);
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "两步任务", mode: "plan" }),
      });
      const { runId } = await res.json();
      await waitForDone(base, runId);
      const series = tokenSeries(await (await fetch(`${base}/metrics`)).text());
      expect(series.get("planner/input")).toBe(100);
      expect(series.get("planner/output")).toBe(50);
      expect(series.get("execution/input")).toBe(200);
      expect(series.get("execution/output")).toBe(100);
      expect(series.get("verification/input")).toBe(200);
      expect(series.get("verification/output")).toBe(100);
    } finally {
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("日预算门：超限后新 run 与追问均 429（拒因可读、计数入指标），账本读数如实", async () => {
    // 预算 100 < 单 run 非 cache_read 消耗 150（input 100 + output 50）。
    // 首个 run 准入时账本为 0 → 放行并跑完；之后一切新准入被拒，在飞语义
    // 由"门只在准入点"这一结构保证（run 中途永远不再过这道门）。
    const model = new FakeModelClient([fakeMessage([textBlock("done")], "end_turn")]);
    const dir = await mkdtemp(join(tmpdir(), "metrics-daily-budget-"));
    const handle = createUiServer({ modelClient: model, workdir: dir, dailyTokenBudget: 100 });
    try {
      const port = await startServer(handle);
      const base = baseUrl(port);
      const create = () =>
        fetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task: "t" }),
        });
      const first = await create();
      expect(first.status).toBe(200);
      const { runId } = await first.json();
      await waitForDone(base, runId);

      const text1 = await (await fetch(`${base}/metrics`)).text();
      expect(text1).toMatch(/^agent_harness_daily_tokens_used 150$/m);

      // 新 run 被拒：429 + 可读拒因 + Retry-After 指向次日
      const second = await create();
      expect(second.status).toBe(429);
      const body = (await second.json()) as any;
      expect(body.error).toContain("Daily token budget");
      expect(body.dailyTokensUsed).toBe(150);
      expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);

      // 追问（已完成 run 的续跑）同属新的执行准入，一样被拒
      const followUp = await fetch(`${base}/api/runs/${runId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "再补一步" }),
      });
      expect(followUp.status).toBe(429);

      const text2 = await (await fetch(`${base}/metrics`)).text();
      expect(text2).toMatch(/^agent_harness_security_rejections_total\{reason="budget"\} 2$/m);
    } finally {
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("日预算 0 = 今日封盘：一切新准入立即 429（而不是炸启动或当未启用）", async () => {
    // 评审实测：0 走 positiveInteger 会拒启——但 used >= 0 恒真本可自然表达
    // "封盘"。现在放行 0 并钉住该语义；配置校验只拒负数与非整数
    const dir = await mkdtemp(join(tmpdir(), "metrics-budget-zero-"));
    const handle = createUiServer({
      modelClient: new FakeModelClient([fakeMessage([textBlock("done")], "end_turn")]),
      workdir: dir,
      dailyTokenBudget: 0,
    });
    try {
      const port = await startServer(handle);
      const res = await fetch(`${baseUrl(port)}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "t" }),
      });
      expect(res.status).toBe(429);
      expect(((await res.json()) as any).error).toContain("Daily token budget");
    } finally {
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("注入测试模型的宿主忽略日预算 env——开发机残留变量不得武装全部测试宿主", async () => {
    // 仪器纪律同台账/历史：env 只武装 realHost。否则 export 过小额度的开发机上，
    // 全套测试会在消耗积累后冒出无法归因的 429（评审点名的测试污染缝）
    process.env.AGENT_UI_DAILY_TOKEN_BUDGET = "1";
    const dir = await mkdtemp(join(tmpdir(), "metrics-budget-env-"));
    const handle = createUiServer({
      modelClient: new FakeModelClient([fakeMessage([textBlock("done")], "end_turn")]),
      workdir: dir,
    });
    try {
      const port = await startServer(handle);
      const base = baseUrl(port);
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "t" }),
      });
      expect(res.status).toBe(200);
      const { runId } = await res.json();
      await waitForDone(base, runId);
    } finally {
      delete process.env.AGENT_UI_DAILY_TOKEN_BUDGET;
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("计划签字位也过日预算门：预算在挂起期间耗尽 → approve 429 且计划保持挂起，reject 永远可行", async () => {
    // 评审：签字位零副作用、可挂任意久，却曾是唯一不过预算门的执行入口——
    // 预算在挂起期间被烧穿后点批准 = 全部子任务无门发射。
    // planner 一条消息即耗 150（逐调用实时落账——这里同时锁住计量不等段收尾），
    // 预算 100 在计划挂起时已穿。
    const planJson = JSON.stringify({
      subtasks: [{ id: "s1", title: "第一步", description: "做 A", acceptance: ["A 完成"], dependsOn: [] }],
    });
    const model = new FakeModelClient([
      fakeMessage([textBlock(["```json", planJson, "```"].join("\n"))], "end_turn"),
      fakeMessage([textBlock("s1 完成")], "end_turn"),
      fakeMessage([textBlock(JSON.stringify({ passed: true, issues: [], summary: "通过" }))], "end_turn"),
    ]);
    const dir = await mkdtemp(join(tmpdir(), "metrics-budget-plangate-"));
    const handle = createUiServer({ modelClient: model, workdir: dir, dailyTokenBudget: 100 });
    try {
      const port = await startServer(handle);
      const base = baseUrl(port);
      const { runId } = await (await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "需要签字的任务", mode: "plan", planGate: true }),
      })).json() as { runId: string };
      for (let i = 0; i < 100; i++) {
        const list = (await (await fetch(`${base}/api/runs`)).json()) as any[];
        const r = list.find((x) => x.runId === runId);
        if (r?.awaitingPlanApproval) break;
        if (r?.status === "done") throw new Error("run 已收尾但从未挂起计划门");
        await new Promise((r2) => setTimeout(r2, 20));
      }
      const approve = await fetch(`${base}/api/runs/${runId}/plan-approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      });
      expect(approve.status).toBe(429);
      expect(((await approve.json()) as any).error).toContain("Daily token budget");
      // 429 不消耗签字位：计划保持挂起，run 未被作废
      const list = (await (await fetch(`${base}/api/runs`)).json()) as any[];
      expect(list.find((x) => x.runId === runId)?.awaitingPlanApproval).toBe(true);
      // 拒绝不花钱，永远可拒——且正常走完否决收场
      const reject = await fetch(`${base}/api/runs/${runId}/plan-approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "reject" }),
      });
      expect(reject.status).toBe(200);
      await waitForDone(base, runId);
    } finally {
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("跨 run 资源互斥：stm32 包的探针被在飞 run 持有 → 429 附持有者；stop 释放后放行", async () => {
    // 审计 high ④：互斥此前只在单个 runPlanned 内生效——两个并发 run 同用
    // stm32 包会同时抢探针。run A 挂在工具审批上保持 running（准入时已按包
    // 声明整体占用 swd-probe）；B 同包创建被 429；stop A 触发 finalize 释放。
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_probe", "probe_op", { op: "read" })], "tool_use"),
      fakeMessage([textBlock("done")], "end_turn"),
    ]);
    const dir = await mkdtemp(join(tmpdir(), "resource-mutex-"));
    const handle = createUiServer({ modelClient: model, tools: [askTool("probe_op")], workdir: dir });
    try {
      const port = await startServer(handle);
      const base = baseUrl(port);
      const create = () =>
        fetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task: "t", pack: "stm32-debug" }),
        });
      const first = await create();
      expect(first.status).toBe(200);
      const { runId: runA } = await first.json();

      const refused = await create();
      expect(refused.status).toBe(429);
      const body = (await refused.json()) as any;
      expect(body.resource).toBe("swd-probe");
      expect(body.heldBy).toBe(runA);
      const metricsText = await (await fetch(`${base}/metrics`)).text();
      expect(metricsText).toMatch(/^agent_harness_security_rejections_total\{reason="resource"\} 1$/m);

      expect((await fetch(`${base}/api/runs/${runA}/stop`, { method: "POST" })).status).toBe(200);
      await waitForDone(base, runA);

      const second = await create();
      expect(second.status).toBe(200);
      const { runId: runB } = await second.json();
      await waitForDone(base, runB);
    } finally {
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("plan 模式子任务对别的 run 持有的探针等待而非 skip：stop 持有者后照常完成", async () => {
    // 锁宿主接线（resources: hostResources 注入 runPlanned）：调度器的等待语义
    // 在 orchestrate 层已有锁，这里锁"宿主真的把跨 run 表递了进去"。
    const planJson = JSON.stringify({
      subtasks: [
        { id: "s1", title: "连板", description: "真机操作", acceptance: ["ok"], dependsOn: [], pack: "stm32-debug" },
      ],
    });
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_hold", "probe_op", { op: "hold" })], "tool_use"), // run A 挂审批持探针
      fakeMessage([textBlock(["```json", planJson, "```"].join("\n"))], "end_turn"), // run B planner
      fakeMessage([textBlock("s1 完成")], "end_turn"), // s1 执行（A 释放后才会被消费）
      fakeMessage([textBlock(JSON.stringify({ passed: true, issues: [], summary: "通过" }))], "end_turn"),
    ]);
    const dirA = await mkdtemp(join(tmpdir(), "plan-mutex-a-"));
    const dirB = await mkdtemp(join(tmpdir(), "plan-mutex-b-"));
    const handle = createUiServer({
      modelClient: model,
      tools: [askTool("probe_op")],
      workdir: dirA,
      workdirs: [dirA, dirB],
    });
    try {
      const port = await startServer(handle);
      const base = baseUrl(port);
      const a = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "占着探针", pack: "stm32-debug" }),
      });
      const { runId: runA } = await a.json();
      const b = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "计划任务", mode: "plan", workdir: dirB }),
      });
      expect(b.status).toBe(200); // plan 模式创建不整体占资源——按子任务粒度管
      const { runId: runB } = await b.json();

      // 给调度器时间走到 s1：s1 必须在等待（零 s1/ 前缀事件），而不是被 skip 或硬闯
      await new Promise((r) => setTimeout(r, 150));
      const midEvents = await readSSESnapshot(base, runB);
      expect(
        midEvents.some((e: any) => String(e.source).startsWith("s1/")),
        "探针被 run A 持有期间 s1 不得发射",
      ).toBe(false);

      expect((await fetch(`${base}/api/runs/${runA}/stop`, { method: "POST" })).status).toBe(200);
      await waitForDone(base, runA);
      await waitForDone(base, runB);
      const endEvents = await readSSESnapshot(base, runB);
      expect(endEvents.some((e: any) => String(e.source).startsWith("s1/"))).toBe(true);
      const result = endEvents.find((e: any) => e.event.type === "plan_result") as any;
      expect(result.event.steps.map((st: any) => st.id)).toEqual(["s1"]); // 没有被 skip
    } finally {
      await handle.close();
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  });

  it("并发双 followUp：readBody 期间 run 被另一条置回 running → 复查 409", async () => {
    // 评审双镜头独立抓出的 real-bug：状态门在 await readBody 之前查过一次，
    // await 期间另一条 followUp 把 run 置回 running——不复查的话同一 AgentLoop
    // 会被两条 continuation 并发驱动，且资源门因同 holder 幂等拦不住。
    // 竞态窗口用 chunked POST 确定性构造：B 先送请求头（预检通过、停在
    // readBody 等 body）→ A 完整发出且续跑挂在审批上（status=running）→
    // 再补 B 的 body——复查点必然看到 running。
    const model = new FakeModelClient([
      fakeMessage([textBlock("首轮完成")], "end_turn"),
      fakeMessage([toolUseBlock("tu_hold2", "hold_op", { op: "x" })], "tool_use"), // A 的续跑挂审批
    ]);
    const dir = await mkdtemp(join(tmpdir(), "followup-race-"));
    const handle = createUiServer({ modelClient: model, tools: [askTool("hold_op")], workdir: dir });
    try {
      const port = await startServer(handle);
      const base = baseUrl(port);
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "t" }),
      });
      const { runId } = await res.json();
      await waitForDone(base, runId);

      // B：只送头，预检（status=done 时）通过后停在 readBody
      const slow = httpRequest({
        host: "127.0.0.1",
        port,
        path: `/api/runs/${runId}/messages`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
      });
      const slowResponse = new Promise<number>((resolveStatus, reject) => {
        slow.on("response", (r) => {
          r.resume();
          resolveStatus(r.statusCode!);
        });
        slow.on("error", reject);
      });
      slow.flushHeaders();
      await new Promise((r) => setTimeout(r, 80)); // 让 B 的处理器进入并停在 readBody

      // A：完整发出，续跑同步置 running 并挂在审批上
      const a = await fetch(`${base}/api/runs/${runId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "先到的一条" }),
      });
      expect(a.status).toBe(200);

      // 补 B 的 body：readBody 返回后复查必须抓到 running
      slow.end(JSON.stringify({ text: "后到的一条" }));
      expect(await slowResponse).toBe(409);
    } finally {
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("planner 漏写 pack 的子任务：资源兜底到宿主默认包，不得绕过互斥表", async () => {
    // 评审抓出的覆盖缺口：无 pack/包名打错的子任务降级到默认配置执行，
    // 工具面照样拿到探针类工具，资源声明却是空的——等于绕过互斥。
    // 兜底链补了宿主默认包（与 single 模式按 admissionPack 占用同口径）。
    const planJson = JSON.stringify({
      subtasks: [
        { id: "s1", title: "连板", description: "真机操作", acceptance: ["ok"], dependsOn: [] }, // 刻意无 pack
      ],
    });
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_hold3", "probe_op", { op: "hold" })], "tool_use"),
      fakeMessage([textBlock(["```json", planJson, "```"].join("\n"))], "end_turn"),
      fakeMessage([textBlock("s1 完成")], "end_turn"),
      fakeMessage([textBlock(JSON.stringify({ passed: true, issues: [], summary: "通过" }))], "end_turn"),
    ]);
    const dirA = await mkdtemp(join(tmpdir(), "plan-fallback-a-"));
    const dirB = await mkdtemp(join(tmpdir(), "plan-fallback-b-"));
    const handle = createUiServer({
      modelClient: model,
      tools: [askTool("probe_op")],
      packName: "stm32-debug", // 宿主默认包声明 swd-probe
      workdir: dirA,
      workdirs: [dirA, dirB],
    });
    try {
      const port = await startServer(handle);
      const base = baseUrl(port);
      const a = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "占着探针" }),
      });
      expect(a.status).toBe(200);
      const { runId: runA } = await a.json();
      const b = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "计划任务", mode: "plan", workdir: dirB }),
      });
      const { runId: runB } = await b.json();

      await new Promise((r) => setTimeout(r, 150));
      const midEvents = await readSSESnapshot(base, runB);
      expect(
        midEvents.some((e: any) => String(e.source).startsWith("s1/")),
        "无 pack 子任务也必须持探针标签等待，不得硬闯",
      ).toBe(false);

      expect((await fetch(`${base}/api/runs/${runA}/stop`, { method: "POST" })).status).toBe(200);
      await waitForDone(base, runA);
      await waitForDone(base, runB);
      const endEvents = await readSSESnapshot(base, runB);
      expect(endEvents.some((e: any) => String(e.source).startsWith("s1/"))).toBe(true);
    } finally {
      await handle.close();
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  });

  it("workdir 独占开关：同 workdir 并发 → 409 附冲突 run；不同 workdir 放行", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_wd", "wd_op", { op: "x" })], "tool_use"),
      fakeMessage([textBlock("done")], "end_turn"),
    ]);
    const dirA = await mkdtemp(join(tmpdir(), "wd-excl-a-"));
    const dirB = await mkdtemp(join(tmpdir(), "wd-excl-b-"));
    const handle = createUiServer({
      modelClient: model,
      tools: [askTool("wd_op")],
      workdir: dirA,
      workdirs: [dirA, dirB],
      exclusiveWorkdir: true,
    });
    try {
      const port = await startServer(handle);
      const base = baseUrl(port);
      const create = (workdir?: string) =>
        fetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task: "t", ...(workdir ? { workdir } : {}) }),
        });
      const first = await create();
      expect(first.status).toBe(200);
      const { runId: runA } = await first.json();

      // 同 workdir → 409 且指认冲突 run
      const refused = await create();
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as any).conflictRunId).toBe(runA);
      const metricsText = await (await fetch(`${base}/metrics`)).text();
      expect(metricsText).toMatch(/^agent_harness_security_rejections_total\{reason="workdir"\} 1$/m);

      // 不同 workdir → 放行并跑完
      const other = await create(dirB);
      expect(other.status).toBe(200);
      const { runId: runC } = await other.json();
      await waitForDone(base, runC);
    } finally {
      await handle.close();
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  });

  it("meterModelClient：视觉调用的 usage 被逐次交给回调，turn 原样透传", async () => {
    // describe_image 的调用在工具执行内部，不经 done/verification 任何记账路径
    // ——计量只能包在客户端边界（评审 real-bug：turn.usage 此前拿到就扔）
    const seen: unknown[] = [];
    const inner = new FakeModelClient([
      fakeMessage([textBlock("红色")], "end_turn", {
        input_tokens: 7000,
        output_tokens: 3,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 2,
      }),
    ]);
    const metered = meterModelClient(inner, (u) => seen.push(u));
    const turn = await metered.send({ system: [], messages: [], tools: [], maxTokens: 64 } as any);
    expect(turn.message.content[0]).toMatchObject({ type: "text", text: "红色" });
    expect(seen).toEqual([
      { inputTokens: 7000, outputTokens: 3, cacheReadTokens: 5, cacheCreationTokens: 2 },
    ]);
  });

  /**
   * 装饰器不得收窄被装饰者的契约。
   *
   * 计量层此前只接 `req` 一个参数：`onDelta` 被吞掉 = Web 上根本没有流式
   * （直播条与对话末尾的实时段全空），`signal` 被吞掉 = 停止按钮掐不掉在飞的
   * 那个请求——而 `ModelClient.send` 的注释写得很清楚："没有它，停止就只是句
   * 空话"。两条都是**静默**失效：没有报错，只是那个能力不见了。
   */
  it("meterModelClient：onDelta 与 signal 必须原样透传（吞掉它们=流式与停止双双静默失效）", async () => {
    const controller = new AbortController();
    let sawDelta: unknown;
    let sawSignal: AbortSignal | undefined;
    const inner: ModelClient = {
      send: async (_req, onDelta, signal) => {
        sawSignal = signal;
        onDelta?.({ kind: "text", text: "半句" });
        return {
          message: fakeMessage([textBlock("整句")], "end_turn"),
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 } as any,
        };
      },
    };
    const metered = meterModelClient(inner, () => {});
    await metered.send(
      { system: [], messages: [], tools: [], maxTokens: 8 } as any,
      (d) => { sawDelta = d; },
      controller.signal,
    );
    expect(sawDelta).toEqual({ kind: "text", text: "半句" });
    expect(sawSignal).toBe(controller.signal);
  });

  it("告警文件：引用的自产指标逐一真实存在；进程死亡告警钉在 job=agent-harness", async () => {
    const alertsYml = readFileSync(
      fileURLToPath(new URL("../deploy/prometheus-alerts.yml", import.meta.url)),
      "utf8",
    );
    // ③ up==0 与 absent 双臂都在，job 名精确（改名/删规则即红）
    expect(alertsYml).toMatch(/up\{job="agent-harness"\} == 0/);
    expect(alertsYml).toMatch(/absent\(up\{job="agent-harness"\}\)/);
    // ② 告警表达式引用的每个 agent_harness_* 指标名都必须以**真实样本行**存在
    //    （评审抓出两个假绿缝：toContain 子串会被 "# TYPE" 声明行命中——http
    //    状态在响应 finish 事件才记账，首个响应构建时 httpStatuses 为空、该指标
    //    彼时只有 TYPE 行；前缀子串还会放过漏写 _total 的告警名）
    const referenced = [...new Set(alertsYml.match(/agent_harness_[a-z0-9_]+/g) ?? [])];
    expect(referenced.length).toBeGreaterThanOrEqual(5);
    const dir = await mkdtemp(join(tmpdir(), "metrics-alerts-"));
    const handle = createUiServer({
      modelClient: new FakeModelClient([fakeMessage([textBlock("done")], "end_turn")]),
      workdir: dir,
    });
    try {
      const port = await startServer(handle);
      // 暖场请求：让至少一个 HTTP 状态完成记账（status 在 finish 事件落账）
      await (await fetch(`${baseUrl(port)}/api/runs`)).json();
      const text = await (await fetch(`${baseUrl(port)}/metrics`)).text();
      const sampleNames = new Set(
        [...text.matchAll(/^(agent_harness_[a-z0-9_]+)[ {]/gm)].map(([, name]) => name),
      );
      for (const name of referenced) {
        expect(sampleNames.has(name), `告警引用的指标 ${name} 没有真实样本行（全名比对）`).toBe(true);
      }
      // 错误率告警的分子序列（outcome="error"）从第 0 次错误起就存在；
      // 5xx 序列同理预注册（HighHttpErrorRate 的首爆盲区，评审抓出）
      expect(text).toContain('agent_harness_runs_finished_total{outcome="error"} 0');
      expect(text).toContain('agent_harness_http_responses_total{status="500"} 0');
    } finally {
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------
// MODEL-01a · 端点降级链接进 Web 宿主
// ------------------------------------------------------

describe("MODEL-01a 端点降级：宿主接线", () => {
  /**
   * 换端点发生在 L0 的 `FallbackModelClient.send` 内部，宿主看不到轮内的事。
   * 这一组用**真的 HTTP**（本地 mock provider）走完整条路：主端点报 503 →
   * 换到备用端点 → 备用端点真的应答 → run 跑完。只 stub 到 FallbackModelClient
   * 为止的话，验的就只是"我调用了我自己写的那个函数"。
   *
   * 降级链的配置源走 `fallbackEnv` 注入而不是 `process.env`：仪器纪律与
   * `executionEnv` 同款——宿主 `.env` 里真有一条链时，测试里的一次瞬时错误
   * 会把假模型的请求转发到真端点上去。
   */
  let handle: UiServerHandle | undefined;
  let mock: Awaited<ReturnType<typeof startMockProvider>> | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    await mock?.close();
    mock = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** 恒报 503 的主端点：瞬时错误才允许换端点，这是链会动的前提 */
  const alwaysTransient = (): ModelClient => ({
    send: async () => {
      throw Object.assign(new Error("upstream temporarily unavailable"), { status: 503 });
    },
  });

  function fallbackEnvFor(base: string): NodeJS.ProcessEnv {
    return {
      AGENT_FALLBACK_MODEL: "mock-backup",
      AGENT_FALLBACK_PROVIDER: "anthropic",
      AGENT_FALLBACK_BASE_URL: base,
      AGENT_FALLBACK_API_KEY: "test-key",
    };
  }

  it("主端点瞬时失败 → 事件流里有 model_fallback，且备用端点真的把这次 run 跑完", async () => {
    mock = await startMockProvider({
      scripts: [{ content: [{ type: "text", text: "备用端点接手并完成" }], stopReason: "end_turn" }],
    });
    dir = await mkdtemp(join(tmpdir(), "fallback-e2e-"));
    handle = createUiServer({
      modelClient: alwaysTransient(),
      tools: [],
      workdir: dir,
      fallbackEnv: fallbackEnvFor(mock.anthropicBaseUrl),
    });
    const base = baseUrl(await startServer(handle));

    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "降级 e2e" }),
    });
    const { runId } = (await created.json()) as { runId: string };
    await waitForDone(base, runId);

    const events = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    const fell = events.find((e) => (e as any).event.type === "model_fallback") as any;
    expect(fell, "主端点 503 之后必须有一条 model_fallback 进事件流").toBeDefined();
    expect(fell.event.to).toBe("mock-backup");
    expect(fell.event.reason).toContain("503");
    expect(fell.event.turn).toBe(1);
    // 来源不是 host：那是宿主的决定；换端点是 L0 的事实
    expect(fell.source).toBe("model");

    // 备用端点确实收到了请求，并且 run 是靠它跑完的
    expect(mock.requestLog.map((r) => r.wire)).toContain("anthropic");
    const done = events.find((e) => (e as any).event.type === "done") as any;
    expect(done.event.stopReason).toBe("completed");
    const texts = events
      .filter((e) => (e as any).event.type === "assistant_text")
      .map((e) => (e as any).event.text);
    expect(texts.join("")).toContain("备用端点接手并完成");
  });

  it("run_config 与 /api/harness 都报出这条链，并写明只覆盖执行者", async () => {
    mock = await startMockProvider({ scripts: [{ content: [{ type: "text", text: "ok" }] }] });
    dir = await mkdtemp(join(tmpdir(), "fallback-cfg-"));
    handle = createUiServer({
      modelClient: new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]),
      tools: [],
      workdir: dir,
      fallbackEnv: fallbackEnvFor(mock.anthropicBaseUrl),
    });
    const base = baseUrl(await startServer(handle));

    const snapshot = (await (await fetch(`${base}/api/harness`)).json()) as any;
    expect(snapshot.fallbackChain).toHaveLength(2);
    expect(snapshot.fallbackChain[1]).toBe("mock-backup");
    expect(snapshot.fallbackScope).toBe("executor");
    // 链上第二家的 baseURL / key 与角色模型同规格：绝不下发给浏览器
    const asText = JSON.stringify(snapshot);
    expect(asText).not.toContain("test-key");
    expect(asText).not.toContain(mock.anthropicBaseUrl);

    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "看配置" }),
    });
    const { runId } = (await created.json()) as { runId: string };
    await waitForDone(base, runId);
    const events = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    const cfg = events.find((e) => (e as any).event.type === "run_config") as any;
    expect(cfg.event.fallbackChain[1]).toBe("mock-backup");
    expect(cfg.event.fallbackScope).toBe("executor");
  });

  /**
   * `null` 与 `[]` 必须分得开：前者是"这台机器上根本没有这条防线"，
   * 后者会被读成"配了链但没有备用端点"。压成同一个读数之后，
   * "本次零降级"是防线没触发还是防线不存在就再也答不出来。
   */
  it("没配降级链时报 null 而不是空数组，且 run 照常跑完", async () => {
    dir = await mkdtemp(join(tmpdir(), "fallback-off-"));
    handle = createUiServer({
      modelClient: new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]),
      tools: [],
      workdir: dir,
      fallbackEnv: {},
    });
    const base = baseUrl(await startServer(handle));
    const snapshot = (await (await fetch(`${base}/api/harness`)).json()) as any;
    expect(snapshot.fallbackChain).toBeNull();
    expect(snapshot.fallbackScope).toBeNull();

    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "无降级" }),
    });
    const { runId } = (await created.json()) as { runId: string };
    await waitForDone(base, runId);
    const events = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    expect(events.some((e) => (e as any).event.type === "model_fallback")).toBe(false);
  });

  /**
   * 归属靠 AsyncLocalStorage 而不是一个可变的"当前 run"引用。这台宿主允许多个
   * run 并发在飞，而换端点发生在 send 内部——单个可变引用会在两次 send 交错时
   * 把降级记到别人账上，而那种错误在界面上完全看不出来（另一个 run 多了一行）。
   */
  it("两个 run 并发降级时各记各的，不会串台", async () => {
    mock = await startMockProvider({
      scripts: [
        { content: [{ type: "text", text: "A 完成" }] },
        { content: [{ type: "text", text: "B 完成" }] },
      ],
    });
    dir = await mkdtemp(join(tmpdir(), "fallback-par-"));
    handle = createUiServer({
      modelClient: alwaysTransient(),
      tools: [],
      workdir: dir,
      fallbackEnv: fallbackEnvFor(mock.anthropicBaseUrl),
    });
    const base = baseUrl(await startServer(handle));

    const start = async (task: string): Promise<string> => {
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task }),
      });
      return ((await res.json()) as { runId: string }).runId;
    };
    const [a, b] = await Promise.all([start("并发 A"), start("并发 B")]);
    await Promise.all([waitForDone(base, a), waitForDone(base, b)]);

    for (const runId of [a, b]) {
      const events = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
      const fallbacks = events.filter((e) => (e as any).event.type === "model_fallback");
      expect(fallbacks, `run ${runId} 应当恰好记到自己那一次降级`).toHaveLength(1);
    }
  });
});


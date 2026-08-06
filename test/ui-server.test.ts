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
import { afterEach, describe, expect, it } from "vitest";
import { createUiServer, type UiServerHandle } from "../ui/server.js";
import {
  FakeModelClient,
  fakeMessage,
  makeTool,
  textBlock,
  toolUseBlock,
} from "./helpers.js";
import type { Tool, ModelClient, ModelRequest, ModelTurn } from "../src/types.js";

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
      async send(_req: ModelRequest, onDelta?: (text: string) => void): Promise<ModelTurn> {
        // text_delta 经 send 的第二个参数旁路发出（见 src/types.ts 的 ModelClient 契约）
        onDelta?.("流式");
        onDelta?.("片段");
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

/**
 * ui/server.ts 契约测试——全用注入的 FakeModelClient，不碰真实端点、不需要 API key。
 *
 * 覆盖率:
 *   a. verify=false run → SSE 收到 turn_start…done，seq 单调递增
 *   b. approval_request → POST allow → 继续至 done
 *   c. approval_request → POST deny → tool_result isError，运行正常收尾
 *   d. verify=true → source="verifier" 事件 + verdict 合成事件（含 unverified/advisory）
 *   e. SSE 晚订阅（run 已结束后）→ 重放全部缓冲事件含 verdict
 *   f. GET /api/runs 列表状态正确；未知 runId 返回 404
 *   g. verifier 的 approval_request 不进 pendingApprovals → POST 返回 404（F2）
 *   h. R-01 幂等: 同一 toolUseId 二次 POST 返回 409，respond 仅调用一次
 *   i. R-01 run 结束后审批 POST 返回 409
 *   j. R-01 GET /api/runs 返回 createdAt/finishedAt（字段存在+单调性）
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
import type { Tool } from "../src/types.js";

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

    // 提取完整的 SSE 事件（\n\n 分隔）
    while (true) {
      const idx = buffer.indexOf("\n\n");
      if (idx === -1) break;
      const block = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (block.startsWith("data: ")) {
        yield JSON.parse(block.slice(6));
      }
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

  // ---- c. approval deny → tool_result isError，运行仍正常收尾 ----
  it("c. approval_request → deny: 工具结果 isError，运行正常收尾", async () => {
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
});

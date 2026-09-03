/**
 * RUN-02 — 恢复与故障注入。
 *
 * 在今天真实存在的边界上注入崩溃（model call、审批等待、history/state 写、
 * segment/checkpoint 边界、同 run resume、不可续时的 fork），断言：
 *   - state.json 与 events 一致；
 *   - 可观测的已提交副作用不重复（checkpoint 段边界）；
 *   - sameRunResume / fork 诚实。
 *
 * **不做假**：无 SAFE-06 toolTx → 不假装有 prepared/committed；mid-tool
 * 恢复标为残余。mock-provider 覆盖 wire 层 mid-model 故障。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import { createUiServer, recoverDurableStateOnCrash, type UiServerHandle } from "../ui/server.js";
import {
  RunHistoryWriter,
  readArchivedEvents,
  readArchivedState,
} from "../ui/history.js";
import {
  canSameRunResume,
  initialRunState,
  recoveryActionForPhase,
  transitionRunState,
} from "../src/run-state.js";
import { AnthropicModelClient } from "../src/model-client.js";
import { startMockProvider, type MockProviderHandle } from "../eval/mock-provider.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock, toolUseBlock } from "./helpers.js";
import type { ModelClient, Tool } from "../src/types.js";

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

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function waitForDone(base: string, runId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const list: { runId: string; status: string }[] = await (await fetch(`${base}/api/runs`)).json();
    if (list.find((r) => r.runId === runId)?.status === "done") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Run ${runId} did not finish in time`);
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

async function* readSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
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
      if (dataLines.length === 0 || eventName !== "message") continue;
      yield JSON.parse(dataLines.join("\n"));
    }
    if (done) break;
  }
}

async function readSSEAll(response: Response): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for await (const e of readSSE(response)) events.push(e);
  return events;
}

/**
 * 把已落盘档案改写成「宿主硬崩溃」形态：meta 仍 running、phase 可选覆写。
 * 对应 ADR：进程中断来不及 finalizeRun。
 */
async function paintHardCrash(
  runDir: string,
  opts: { phase?: string; pendingApprovalIds?: string[] } = {},
): Promise<void> {
  const metaPath = join(runDir, "meta.json");
  const meta = JSON.parse(await readFile(metaPath, "utf8"));
  meta.status = "running";
  meta.finishedAt = null;
  await writeFile(metaPath, JSON.stringify(meta), "utf8");

  const statePath = join(runDir, "state.json");
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (opts.phase) state.phase = opts.phase;
    if (opts.pendingApprovalIds) state.pendingApprovalIds = opts.pendingApprovalIds;
    await writeFile(statePath, JSON.stringify(state), "utf8");
  } catch {
    // 无 state.json：旧档案路径，恢复时会合成 interrupted
  }
}

function countingTool(name: string, counter: { n: number }): Tool {
  return makeTool({
    name,
    permission: "auto",
    parallelSafe: true,
    execute: async () => {
      counter.n += 1;
      return { content: `${name}#${counter.n}` };
    },
  });
}

function askTool(name: string, counter?: { n: number }): Tool {
  return makeTool({
    name,
    permission: "ask",
    parallelSafe: false,
    execute: async () => {
      if (counter) counter.n += 1;
      return { content: `${name} ran` };
    },
  });
}

// ------------------------------------------------------------------ suite

describe("RUN-02 crash injection", () => {
  let handle: UiServerHandle | undefined;
  let mock: MockProviderHandle | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    await mock?.close();
    mock = undefined;
    if (dir) {
      // Windows：偶发文件句柄未立刻释放 → ENOTEMPTY；重试后仍败则交给 OS 清临时目录
      for (let i = 0; i < 5; i++) {
        try {
          await rm(dir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 50 * 2 ** i));
        }
      }
    }
    dir = undefined;
  });

  async function boot(opts: {
    modelClient: ModelClient;
    tools?: Tool[];
    history: string;
    workdir?: string;
  }): Promise<string> {
    handle = createUiServer({
      modelClient: opts.modelClient,
      tools: opts.tools ?? [],
      workdir: opts.workdir ?? process.cwd(),
      history: opts.history,
    });
    return baseUrl(await startServer(handle));
  }

  // ---- 1. mid-model：真·飞行中硬崩溃（无 done / 无 checkpoint）-----------

  it("飞行中硬崩溃（无 done、无 checkpoint）→ interrupted，不可 same-run，工具零次", async () => {
    dir = await mkdtemp(join(tmpdir(), "run02-mid-flight-"));
    const runId = "mid-flight";
    const runDir = join(dir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "meta.json"),
      JSON.stringify({
        version: 1,
        runId,
        task: "died mid-model",
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
        ...initialRunState(runId, 1000),
        phase: "executing",
        segmentIndex: 0,
        segmentSource: "main",
        updatedAt: 1001,
      }),
      "utf8",
    );
    await writeFile(
      join(runDir, "events.jsonl"),
      `${JSON.stringify({ seq: 0, source: "main", ts: 1001, event: { type: "turn_start", turn: 1 } })}\n`,
      "utf8",
    );

    const counter = { n: 0 };
    const base = await boot({
      modelClient: new FakeModelClient([]),
      tools: [countingTool("side", counter)],
      history: dir,
    });
    const row = ((await (await fetch(`${base}/api/runs`)).json()) as any[]).find(
      (r) => r.runId === runId,
    );
    expect(row.durablePhase).toBe("interrupted");
    expect(row.sameRunResume).toBe(false);
    expect(row.continuationMode).not.toBe("same-run");
    expect(counter.n).toBe(0);
    expect((await readArchivedState(runDir))?.phase).toBe("interrupted");
    const hydrated = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    expect(hydrated.some((e) => (e as any).event.type === "run_end")).toBe(true);
  });

  // ---- 2. mid-model：Fake 抛错（finalize done，可能留下 checkpoint）-------

  it("mid-model Fake 抛错：工具零次；崩溃收口后 checkpoint 边界诚实", async () => {
    dir = await mkdtemp(join(tmpdir(), "run02-mid-model-"));
    const counter = { n: 0 };
    const model = new FakeModelClient([fakeMessage([textBlock("never")], "end_turn")]);
    model.crashAtCall = 1;

    const base = await boot({
      modelClient: model,
      tools: [countingTool("side", counter)],
      history: dir,
    });
    const { runId } = (await (
      await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "mid-model", verify: false }),
      })
    ).json()) as { runId: string };
    await waitForDone(base, runId);
    expect(counter.n).toBe(0);
    expect(model.requests).toHaveLength(1);

    await handle!.close();
    handle = undefined;
    await paintHardCrash(join(dir, runId), { phase: "executing" });

    const base2 = await boot({
      modelClient: new FakeModelClient([fakeMessage([textBlock("recovered")], "end_turn")]),
      tools: [countingTool("side", counter)],
      history: dir,
    });
    const row = ((await (await fetch(`${base2}/api/runs`)).json()) as any[]).find(
      (r) => r.runId === runId,
    );
    expect(row.durablePhase).toBe("interrupted");
    // error-done 若已写入 checkpoint，same-run 合法；否则只能 fork/只读
    if (row.sameRunResume) {
      expect(row.continuationMode).toBe("same-run");
      const follow = await fetch(`${base2}/api/runs/${runId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "重试" }),
      });
      expect(follow.status).toBe(200);
      expect(((await follow.json()) as any).sameRunResume).toBe(true);
      await waitForDone(base2, runId);
    } else {
      expect(row.continuationMode).not.toBe("same-run");
    }
    expect(counter.n).toBe(0);
  });

  // ---- 3. mock-provider wire 层 mid-model --------------------------------

  it("mock-provider alwaysFault 500：wire 层失败后崩溃收口诚实", async () => {
    dir = await mkdtemp(join(tmpdir(), "run02-mock-500-"));
    mock = await startMockProvider({
      alwaysFault: { type: "status", status: 500 },
    });
    const sdk = new Anthropic({
      baseURL: mock.anthropicBaseUrl,
      apiKey: "mock-key",
      maxRetries: 0,
      timeout: 5_000,
    });
    const client = new AnthropicModelClient("mock-model", sdk, { compat: true });

    const base = await boot({ modelClient: client, tools: [], history: dir });
    const { runId } = (await (
      await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "upstream 500", verify: false }),
      })
    ).json()) as { runId: string };
    await waitForDone(base, runId);

    const events = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    const done = events.find((e) => (e as any).event.type === "done") as any;
    expect(done?.event.stopReason).toBe("error");
    expect(mock.requestLog.length).toBeGreaterThanOrEqual(1);

    await handle!.close();
    handle = undefined;
    await paintHardCrash(join(dir, runId), { phase: "executing" });

    const base2 = await boot({
      modelClient: new FakeModelClient([]),
      history: dir,
    });
    const row = ((await (await fetch(`${base2}/api/runs`)).json()) as any[]).find(
      (r) => r.runId === runId,
    );
    expect(row.durablePhase).toBe("interrupted");
    expect(row.status).toBe("done");
    expect(typeof row.sameRunResume).toBe("boolean");
    const hydrated = await readSSEAll(await fetch(`${base2}/api/runs/${runId}/events`));
    expect(hydrated.some((e) => (e as any).event.type === "run_end")).toBe(true);
  });

  // ---- 4. approval wait --------------------------------------------------

  it("审批等待中硬崩溃 → pending 清空为 interrupted；无 checkpoint 不可 same-run", async () => {
    dir = await mkdtemp(join(tmpdir(), "run02-approval-"));
    const counter = { n: 0 };
    const base = await boot({
      modelClient: new FakeModelClient([
        fakeMessage([toolUseBlock("tu_ask", "danger", { x: 1 })], "tool_use"),
        fakeMessage([textBlock("after allow")], "end_turn"),
      ]),
      tools: [askTool("danger", counter)],
      history: dir,
    });
    const { runId } = (await (
      await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "need approval", verify: false }),
      })
    ).json()) as { runId: string };

    const req = await waitForEvent(
      base,
      runId,
      (e: any) => e.event?.type === "approval_request",
    );
    expect(req).toBeDefined();
    // 等 state.json 写出 awaiting_approval
    const deadline = Date.now() + 3000;
    let livePhase: string | undefined;
    while (Date.now() < deadline) {
      try {
        const s = JSON.parse(await readFile(join(dir, runId, "state.json"), "utf8"));
        livePhase = s.phase;
        if (s.phase === "awaiting_approval") break;
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(livePhase).toBe("awaiting_approval");
    expect(recoveryActionForPhase("awaiting_approval")).toBe("expire_waits_and_fork");

    // 硬崩溃：不走 finalize 语义——关停后改写盘上形态
    await handle!.close();
    handle = undefined;
    expect(counter.n).toBe(0); // 工具从未执行
    await paintHardCrash(join(dir, runId), {
      phase: "awaiting_approval",
      pendingApprovalIds: ["tu_ask#0"],
    });

    const base2 = await boot({
      modelClient: new FakeModelClient([]),
      tools: [askTool("danger", counter)],
      history: dir,
    });
    const row = ((await (await fetch(`${base2}/api/runs`)).json()) as any[]).find(
      (r) => r.runId === runId,
    );
    expect(row.durablePhase).toBe("interrupted");
    expect(row.sameRunResume).toBe(false);
    expect(row.pendingApprovals).toBe(0);
    const recovered = await readArchivedState(join(dir, runId));
    expect(recovered?.phase).toBe("interrupted");
    expect(recovered?.pendingApprovalIds).toEqual([]);
    expect(counter.n).toBe(0);
  });

  // ---- 4. history / state write ------------------------------------------

  it("history/state 写入：原子落盘可 round-trip；半截 tmp 不冒充游标", async () => {
    const good = await mkdtemp(join(tmpdir(), "run02-hist-write-"));
    dir = good;
    const w = new RunHistoryWriter(good);
    let state = initialRunState("crash-write", 1);
    state = transitionRunState(state, { type: "start" }, 2)!;
    state = transitionRunState(state, { type: "segment_begin", index: 0, source: "main" }, 3)!;
    w.writeState(state);
    w.appendEvent({ seq: 0, source: "main", ts: 3, event: { type: "turn_start", turn: 1 } });
    await w.flush();

    const loaded = await readArchivedState(good);
    expect(loaded).toEqual(state);
    const events = await readArchivedEvents(good);
    expect(events).toHaveLength(1);

    // 半截写：只留 tmp，无正式 state.json → fail-closed
    const broken = await mkdtemp(join(tmpdir(), "run02-hist-half-"));
    await writeFile(join(broken, ".state.999.tmp"), "{not-complete", "utf8");
    expect(await readArchivedState(broken)).toBeNull();
    await rm(broken, { recursive: true, force: true });

    const recovered = recoverDurableStateOnCrash(state!);
    expect(recovered.phase).toBe("interrupted");
  });

  it("state 写失败不阻断 run；writer 熄火后健康位可观测", async () => {
    // 根路径是普通文件 → mkdir 失败 → 链熄火（与 B2 仪器纪律同构）
    const parent = await mkdtemp(join(tmpdir(), "run02-hist-fail-"));
    dir = parent;
    const fileAsRoot = join(parent, "not-a-dir");
    await writeFile(fileAsRoot, "x", "utf8");
    const w = new RunHistoryWriter(join(fileAsRoot, "sub"));
    w.writeState(initialRunState("r"));
    await w.flush();
    expect(w.healthy).toBe(false);
    expect(w.lastError).toBeTruthy();
  });

  // ---- 5. interrupted → same-run resume，无重复副作用 --------------------

  it("checkpoint 边界崩溃 → same-run resume；已提交段工具不重跑", async () => {
    dir = await mkdtemp(join(tmpdir(), "run02-same-run-"));
    const counter = { n: 0 };
    const tool = countingTool("ledger_write", counter);

    const base = await boot({
      modelClient: new FakeModelClient([
        fakeMessage([toolUseBlock("t1", "ledger_write", { k: "a" })], "tool_use"),
        fakeMessage([textBlock("seg1 marker-alpha")], "end_turn", {
          input_tokens: 80,
          output_tokens: 20,
        }),
      ]),
      tools: [tool],
      history: dir,
    });
    const { runId } = (await (
      await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "checkpoint then crash", verify: false }),
      })
    ).json()) as { runId: string };
    await waitForDone(base, runId);
    expect(counter.n).toBe(1);

    await handle!.close();
    handle = undefined;
    await paintHardCrash(join(dir, runId), { phase: "executing" });

    const resumeModel = new FakeModelClient([
      fakeMessage([textBlock("seg2 after resume")], "end_turn", {
        input_tokens: 40,
        output_tokens: 10,
      }),
    ]);
    const base2 = await boot({
      modelClient: resumeModel,
      tools: [tool],
      history: dir,
    });
    const row = ((await (await fetch(`${base2}/api/runs`)).json()) as any[]).find(
      (r) => r.runId === runId,
    );
    expect(row.sameRunResume).toBe(true);
    expect(row.continuationMode).toBe("same-run");
    expect(row.durablePhase).toBe("interrupted");

    const follow = await fetch(`${base2}/api/runs/${runId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "继续" }),
    });
    expect(follow.status).toBe(200);
    const body = (await follow.json()) as any;
    expect(body.runId).toBe(runId);
    expect(body.sameRunResume).toBe(true);
    expect(body.continuationMode).toBe("same-run");
    await waitForDone(base2, runId);

    // 已提交段的工具不得因 resume 再执行一次
    expect(counter.n).toBe(1);
    const events = await readSSEAll(await fetch(`${base2}/api/runs/${runId}/events`));
    expect(events.some((e) => (e as any).event.type === "run_resumed")).toBe(true);
    expect(events.some((e) => (e as any).event.type === "run_forked")).toBe(false);
    const flattened = JSON.stringify(resumeModel.requests[0]?.messages ?? []);
    expect(flattened).toContain("marker-alpha");

    const after = await readArchivedState(join(dir, runId));
    expect(after?.lastSameRunResumeAt).toBeTruthy();
  });

  // ---- 6. fork 路径（不可 same-run） -------------------------------------

  it("完成态档案续跑走 fork，不冒充 same-run；父档案不变", async () => {
    dir = await mkdtemp(join(tmpdir(), "run02-fork-"));
    const base = await boot({
      modelClient: new FakeModelClient([
        fakeMessage([textBlock("parent done secret-beta")], "end_turn", {
          input_tokens: 50,
          output_tokens: 10,
        }),
      ]),
      tools: [],
      history: dir,
    });
    const { runId } = (await (
      await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "fork me", verify: false }),
      })
    ).json()) as { runId: string };
    await waitForDone(base, runId);
    await handle!.close();
    handle = undefined;

    // 正常完成态重启（不 paint crash）
    const childModel = new FakeModelClient([
      fakeMessage([textBlock("child")], "end_turn"),
    ]);
    const base2 = await boot({
      modelClient: childModel,
      history: dir,
    });
    const row = ((await (await fetch(`${base2}/api/runs`)).json()) as any[]).find(
      (r) => r.runId === runId,
    );
    expect(row.sameRunResume).toBe(false);
    expect(row.continuationMode).toBe("fork");
    expect(row.canContinue).toBe(true);

    const parentEventsBefore = await readSSEAll(await fetch(`${base2}/api/runs/${runId}/events`));
    const follow = await fetch(`${base2}/api/runs/${runId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "派生" }),
    });
    expect(follow.status).toBe(200);
    const child = (await follow.json()) as any;
    expect(child.runId).not.toBe(runId);
    expect(child.continuedFrom).toBe(runId);
    expect(child.continuationMode).toBe("fork");
    // fork 响应体不设 sameRunResume:true（仅 same-run 路径显式 true）
    expect(child.sameRunResume).not.toBe(true);
    await waitForDone(base2, child.runId);

    const childEvents = await readSSEAll(await fetch(`${base2}/api/runs/${child.runId}/events`));
    expect(childEvents.some((e) => (e as any).event.type === "run_forked")).toBe(true);
    expect(childEvents.some((e) => (e as any).event.type === "run_resumed")).toBe(false);

    // 父档案事件流不被 fork 改写
    expect(await readSSEAll(await fetch(`${base2}/api/runs/${runId}/events`))).toEqual(
      parentEventsBefore,
    );
  });

  // ---- 7. SAFE-06 / toolTx 残余诚实锁 ------------------------------------

  it("残余：无 tool prepared/committed 事件；mid-tool 不声称可恢复", async () => {
    // 契约锁：今天的事件类型集合里没有 toolTx 生命周期
    dir = await mkdtemp(join(tmpdir(), "run02-no-tooltx-"));
    const base = await boot({
      modelClient: new FakeModelClient([
        fakeMessage([toolUseBlock("t", "noop", {})], "tool_use"),
        fakeMessage([textBlock("ok")], "end_turn"),
      ]),
      tools: [makeTool({ name: "noop", permission: "auto" })],
      history: dir,
    });
    const { runId } = (await (
      await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "no tooltx", verify: false }),
      })
    ).json()) as { runId: string };
    await waitForDone(base, runId);
    const events = await readSSEAll(await fetch(`${base}/api/runs/${runId}/events`));
    const types = events.map((e) => (e as any).event.type);
    expect(types).not.toContain("tool_prepared");
    expect(types).not.toContain("tool_committed");
    expect(types).not.toContain("tool_compensated");

    // canSameRunResume 在 executing（mid-segment 活相）上必须 false——
    // 只有 interrupted+checkpoint 才是 idempotency 边界
    expect(
      canSameRunResume({
        phase: "executing",
        hasCheckpoint: true,
        verify: false,
        mode: "single",
        budgetExhausted: false,
      }),
    ).toBe(false);
  });
});

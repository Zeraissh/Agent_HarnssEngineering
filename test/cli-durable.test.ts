import { describe, expect, it } from "vitest";
import {
  extractPendingToolUses,
  planMidToolReplay,
} from "../src/mid-tool-replay.js";
import { canonicalInputHash, type DurableToolTx } from "../src/tool-tx.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hostPlanEvent,
  hostPlanReplanEvent,
  hostPlanResultEvent,
  hostPlanResumeEvent,
  hostPlanSubtaskViews,
  serializeTurnEventForArchive,
} from "../src/archive-event.js";
import type { PlannedRunResult } from "../src/orchestrate.js";
import {
  cliMetaCheckpoint,
  createCliDurable,
  formatCliResumeStop,
  lastExecutorTranscriptMessages,
  nextArchiveEventSeq,
  prepareCliPlanResume,
  prepareCliSingleResume,
} from "../src/cli-durable.js";
import type { TurnEvent } from "../src/types.js";
import { loadArchivedMetas } from "../ui/history.js";
import { durablePlanFromPlan, planNodesFromSubtasks } from "../src/planner.js";
import { initialRunState, transitionRunState } from "../src/run-state.js";
import type { Plan } from "../src/planner.js";

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
      handle.markCompleted();
      await handle.writer.flush();
      const raw = await readFile(path.join(root, "cli-test-1", "state.json"), "utf8");
      const state = JSON.parse(raw) as { phase: string; toolTx: unknown[] };
      expect(state.toolTx.length).toBe(1);
      expect(state.phase).toBe("completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("OBS-01：tool_call + tool_result 投影到 trace.jsonl，收尾关掉根 span", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cli-trace-"));
    try {
      const handle = createCliDurable({
        runId: "cli-trace-1",
        historyRoot: root,
      });
      handle.beginTrace({
        tools: [{ name: "write_file", inputSchema: { type: "object" } }],
        packName: "ts-coding",
        model: "test-model",
      });
      handle.noteTrace("main", {
        type: "tool_call",
        toolUseId: "tu1",
        name: "write_file",
        input: { path: "a.txt", content: "x" },
      });
      handle.noteTrace("main", {
        type: "tool_result",
        toolUseId: "tu1",
        durationMs: 4,
        result: { content: "wrote a.txt", isError: false },
      });
      handle.noteTrace("main", { type: "model_call_start", turn: 1, attempt: 0 });
      handle.noteTrace("main", {
        type: "model_call_end",
        turn: 1,
        attempt: 0,
        status: "ok",
        durationMs: 9,
      });
      handle.markCompleted();
      await handle.writer.flush();
      const raw = await readFile(path.join(root, "cli-trace-1", "trace.jsonl"), "utf8");
      const spans = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { kind: string; name: string; status: string; spanId: string });
      expect(spans[0]).toMatchObject({ kind: "run", name: "cli_run", status: "running" });
      expect(spans.some((s) => s.kind === "tool" && s.name === "write_file")).toBe(true);
      expect(spans.some((s) => s.kind === "model" && s.name === "model_send" && s.status === "ok")).toBe(
        true,
      );
      const closed = spans[spans.length - 1];
      expect(closed).toMatchObject({ kind: "run", spanId: spans[0]!.spanId, status: "ok" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("CLI 宿主把 noteForLedger 接到 noteTrace / noteEvent / beginTrace（host-lags）", () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const cli = readFileSync(path.join(root, "..", "src", "cli.ts"), "utf8");
    expect(cli).toMatch(/cliDurable\?\.beginTrace\(/);
    expect(cli).toMatch(/cliDurable\?\.noteTrace\(source, event\)/);
    expect(cli).toMatch(/cliDurable\?\.noteEvent\(source, event\)/);
    expect(cli).toMatch(/case "model_call_start"/);
    expect(cli).toMatch(/case "model_call_end"/);
    const server = readFileSync(path.join(root, "..", "ui", "server.ts"), "utf8");
    expect(server).toMatch(/serializeTurnEventForArchive/);
    expect(server).toMatch(/from "\.\.\/src\/archive-event\.js"/);
    expect(server).toMatch(/return serializeTurnEventForArchive\(_source, event, segmentIndex\)/);
  });

  it("CLI 宿主把半截 DAG 续跑接到 plan_progress / --resume-run（host-lags）", () => {
    const cli = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts"), "utf8");
    expect(cli).toMatch(/prepareCliPlanResume/);
    expect(cli).toMatch(/type: "plan_progress"/);
    expect(cli).toMatch(/resume:\s*\{/);
    expect(cli).toMatch(/onSubtaskStart/);
    expect(cli).toMatch(/activeCliDurable\?\.markInterrupted/);
    expect(cli).toMatch(/type: "budget_snapshot"/);
    expect(cli).toMatch(/seedDurableBudget/);
    expect(cli).toMatch(/snapshotDurableBudget\(activeCliLineageBudget\)/);
    expect(cli).toMatch(/prepareCliSingleResume/);
    expect(cli).toMatch(/runContinuation/);
    expect(cli).toMatch(/noteExecutorCheckpoint/);
    expect(cli).toMatch(/archive:\s*cliArchive/);
    expect(cli).toMatch(/noteHostEvent\(hostPlanResumeEvent/);
    expect(cli).toMatch(/onReplan:/);
    expect(cli).toMatch(/noteHostEvent\(hostPlanReplanEvent/);
    expect(cli).toMatch(/noteHostEvent\(\s*hostPlanEvent\(/);
    expect(cli).toMatch(/noteHostEvent\(hostPlanResultEvent/);
    const server = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui", "server.ts"), "utf8");
    expect(server).toMatch(/hostPlanResumeEvent\(\{ kept, remaining, reason: feedback \}\)/);
    expect(server).toMatch(/hostPlanReplanEvent\(diff\)/);
    expect(server).toMatch(/hostPlanEvent\(\{/);
    expect(server).toMatch(/hostPlanResultEvent\(outcome,/);
  });
});

const twoStep: Plan = {
  subtasks: [
    { id: "s1", title: "一", description: "d1", acceptance: ["a1"], dependsOn: [] },
    { id: "s2", title: "二", description: "d2", acceptance: ["a2"], dependsOn: ["s1"] },
  ],
};

function executingHalfDag(nodes = [
  ...planNodesFromSubtasks([twoStep.subtasks[0]!], "passed"),
  ...planNodesFromSubtasks([twoStep.subtasks[1]!], "pending"),
]) {
  let s = initialRunState("cli-half");
  s = transitionRunState(s, { type: "start" })!;
  s = transitionRunState(s, { type: "plan_begin" })!;
  s = transitionRunState(s, {
    type: "plan_ready",
    gated: false,
    plan: durablePlanFromPlan(twoStep, "freeform", nodes),
  })!;
  return s;
}

describe("CLI 半截 DAG 续跑准入", () => {
  it("executing 崩溃相先 interrupt 再放行；零进度 / 终态拒绝", () => {
    const half = executingHalfDag();
    expect(half.phase).toBe("executing");
    const ok = prepareCliPlanResume(half);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.state.phase).toBe("interrupted");
      expect(ok.nodes.map((n) => n.id)).toEqual(["s1", "s2"]);
    }

    const zero = executingHalfDag(planNodesFromSubtasks(twoStep.subtasks, "pending"));
    expect(prepareCliPlanResume(zero)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/零进度/),
    });
    expect(prepareCliPlanResume(zero, { hasTask: true })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/零进度/),
    });

    const done = transitionRunState(half, { type: "complete" })!;
    expect(prepareCliPlanResume(done)).toEqual({
      ok: false,
      reason: "终态 completed 不能同 run 热续 DAG",
    });
    expect(prepareCliPlanResume(null).ok).toBe(false);
  });

  it("plan_gated 拒绝 CLI 签字，不把对话封死成可热续", () => {
    let gated = initialRunState("cli-gate");
    gated = transitionRunState(gated, { type: "plan_begin" })!;
    gated = transitionRunState(gated, {
      type: "plan_ready",
      gated: true,
      plan: durablePlanFromPlan(twoStep),
    })!;
    expect(gated.phase).toBe("plan_gated");
    expect(prepareCliPlanResume(gated, { hasTask: true })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/不会替你签字/),
    });
  });

  it("谱系预算已用尽则拒；无快照 fail-open 仍放行", () => {
    const half = executingHalfDag();
    expect(prepareCliPlanResume(half).ok).toBe(true);

    const under = transitionRunState(half, {
      type: "budget_snapshot",
      budget: { usedTurns: 9, usedTokens: 100, maxTurns: 10 },
    })!;
    expect(prepareCliPlanResume(under).ok).toBe(true);

    const turnsOut = transitionRunState(half, {
      type: "budget_snapshot",
      budget: { usedTurns: 10, usedTokens: 100, maxTurns: 10 },
    })!;
    const refusedTurns = prepareCliPlanResume(turnsOut);
    expect(refusedTurns.ok).toBe(false);
    if (!refusedTurns.ok) {
      expect(refusedTurns.reason).toMatch(/AGENT_TOTAL_MAX_TURNS/);
      expect(refusedTurns.reason).toMatch(/不要 --resume-run/);
    }

    const tokensOut = transitionRunState(half, {
      type: "budget_snapshot",
      budget: { usedTurns: 1, usedTokens: 500, maxTokens: 500 },
    })!;
    const refusedTokens = prepareCliPlanResume(tokensOut);
    expect(refusedTokens.ok).toBe(false);
    if (!refusedTokens.ok) {
      expect(refusedTokens.reason).toMatch(/AGENT_TOTAL_TOKEN_BUDGET/);
    }
  });

  it("apply plan_progress 把节点写进 state.json", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cli-plan-nodes-"));
    try {
      const handle = createCliDurable({ runId: "cli-nodes", historyRoot: root });
      expect(handle.apply({ type: "plan_begin" })).toBe(true);
      const pending = planNodesFromSubtasks(twoStep.subtasks, "pending");
      expect(
        handle.apply({
          type: "plan_ready",
          gated: false,
          plan: durablePlanFromPlan(twoStep, "freeform", pending),
        }),
      ).toBe(true);
      const progressed = pending.map((n, i) =>
        i === 0 ? { ...n, status: "passed" as const, evidenceSummary: "s1 ok" } : n,
      );
      expect(
        handle.apply({
          type: "plan_progress",
          nodes: progressed.map((n) => ({
            ...n,
            pack: n.pack ?? null,
          })),
        }),
      ).toBe(true);
      handle.persist();
      await handle.writer.flush();
      const raw = await readFile(path.join(root, "cli-nodes", "state.json"), "utf8");
      const state = JSON.parse(raw) as {
        phase: string;
        plan: { nodes: Array<{ id: string; status: string }> };
      };
      expect(state.phase).toBe("executing");
      expect(state.plan.nodes.map((n) => `${n.id}:${n.status}`)).toEqual(["s1:passed", "s2:pending"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("CLI 单执行者同 run 续跑准入", () => {
  function executingWithCheckpoint() {
    let s = initialRunState("cli-single");
    s = transitionRunState(s, { type: "start" })!;
    s = transitionRunState(s, {
      type: "executor_checkpoint",
      checkpoint: { segmentIndex: 0, contextInputTokens: 8 },
    })!;
    return s;
  }

  it("executing 崩溃相先 interrupt 再放行；无检查点 / 终态 / 编排档案拒绝", () => {
    const half = executingWithCheckpoint();
    const ok = prepareCliSingleResume(half, { hasHistory: true });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.state.phase).toBe("interrupted");

    expect(prepareCliSingleResume(executingWithCheckpoint(), { hasHistory: false })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/没有已提交的 main 检查点/),
    });
    expect(prepareCliSingleResume(executingWithCheckpoint(), {
      hasHistory: false,
      hasTask: true,
    })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/没有已提交的 main 检查点/),
    });
    expect(prepareCliSingleResume(transitionRunState(initialRunState("x"), { type: "start" })!, { hasHistory: true }))
      .toMatchObject({ ok: false });
    expect(prepareCliSingleResume(executingWithCheckpoint(), { hasHistory: true, verify: true })).toEqual({
      ok: false,
      reason: "同 run 热恢复不接 --verify",
    });

    const done = transitionRunState(half, { type: "complete" })!;
    expect(prepareCliSingleResume(done, { hasHistory: true })).toEqual({
      ok: false,
      reason: "终态 completed 没有可热续的检查点",
    });
    expect(prepareCliSingleResume(done, { hasHistory: true, hasTask: true })).toMatchObject({
      ok: false,
      reason: "终态 completed 没有可热续的检查点",
    });
    expect(formatCliResumeStop({
      runId: "cli-1",
      reason: "终态 completed 没有可热续的检查点",
      task: "写下 hello.txt",
      phase: "completed",
    })).toBe(
      [
        "不能续跑 cli-1：终态 completed 没有可热续的检查点",
        "原任务：写下 hello.txt",
        "终态：completed",
        "飞行中杀掉不能接着工具。读不到热续检查点会停，不会当新任务重开。",
      ].join("\n"),
    );
    const cli = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts"), "utf8");
    expect(cli).toMatch(/formatCliResumeStop/);
    expect(cli).not.toMatch(/将从任务正文重开一轮/);
    expect(cli).not.toMatch(/cliSingleResume\?\.reopen/);

    const planArchive = executingHalfDag();
    expect(prepareCliSingleResume(planArchive, { hasHistory: true })).toEqual({
      ok: false,
      reason: "这是编排档案，请加 --plan",
    });
  });

  it("noteExecutorCheckpoint 写 transcript + 游标；坏正史 fail-closed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cli-single-cp-"));
    try {
      const handle = createCliDurable({ runId: "cli-cp", historyRoot: root });
      handle.noteExecutorCheckpoint({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "ok" },
        ],
        contextInputTokens: 4,
        budget: { usedTurns: 2, usedTokens: 20, maxTurns: 40 },
      });
      handle.persist();
      await handle.writer.flush();
      const state = handle.getState();
      expect(state.checkpoint).toEqual({ segmentIndex: 0, contextInputTokens: 4 });
      expect(state.budget?.usedTurns).toBe(2);
      const raw = await readFile(path.join(root, "cli-cp", "transcript.jsonl"), "utf8");
      const seg = JSON.parse(raw.trim()) as { source: string; messages: unknown[] };
      expect(seg.source).toBe("main");
      expect(lastExecutorTranscriptMessages([seg])?.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(
        lastExecutorTranscriptMessages([{ source: "main", messages: [{ role: "tool", content: "x" }] }]),
      ).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("CLI meta.json（Web 列表）", () => {
  it("开工写出 running；有检查点+账才给 Web checkpoint；收尾 status=done 且自带 run_end", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cli-meta-"));
    try {
      const handle = createCliDurable({
        runId: "cli-meta-1",
        historyRoot: root,
        archive: {
          task: "写个文件",
          mode: "single",
          verify: false,
          packName: "ts-coding",
          workdir: "/tmp/cli-meta",
        },
      });
      await handle.writer.flush();
      const listed = await loadArchivedMetas(root);
      expect(listed).toHaveLength(1);
      expect(listed[0]!.meta).toMatchObject({
        version: 1,
        runId: "cli-meta-1",
        task: "写个文件",
        status: "running",
        mode: "single",
        packName: "ts-coding",
        verify: false,
        host: "cli",
      });
      expect(listed[0]!.meta.checkpoint).toBeNull();

      expect(cliMetaCheckpoint(handle.getState())).toBeNull();
      handle.noteExecutorCheckpoint({
        messages: [{ role: "user", content: "hi" }],
        contextInputTokens: 3,
        budget: { usedTurns: 1, usedTokens: 10, maxTurns: 40 },
      });
      const cp = cliMetaCheckpoint(handle.getState());
      expect(cp).toEqual({
        segmentIndex: 0,
        conversationTurn: 1,
        contextInputTokens: 3,
        runBudget: { usedTurns: 1, usedTokens: 10, maxTurns: 40 },
      });
      expect(cp!.conversationTurn).toBeGreaterThanOrEqual(1);

      handle.markCompleted();
      await handle.writer.flush();
      const done = await loadArchivedMetas(root);
      expect(done[0]!.meta.status).toBe("done");
      expect(done[0]!.meta.mainStopReason).toBe("completed");
      expect(done[0]!.meta.checkpoint?.runBudget.usedTurns).toBe(1);
      const events = (await readFile(path.join(root, "cli-meta-1", "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: { type: string; outcome?: string } });
      expect(events.some((e) => e.event.type === "run_end" && e.event.outcome === "completed")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function sampleDone(messages: { role: "user" | "assistant"; content: string }[]): Extract<TurnEvent, { type: "done" }> {
  return {
    type: "done",
    result: {
      stopReason: "completed",
      messages,
      usage: {
        inputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 2,
        turns: 1,
        cacheHitRatio: 0,
      },
    },
  };
}

describe("CLI events.jsonl TurnEvent 投影", () => {
  it("done 投影带 messageCount、不带 messages；approval 去掉 respond", () => {
    const done = serializeTurnEventForArchive("main", sampleDone([{ role: "user", content: "secret-history" }]), 0);
    expect(done).toMatchObject({
      type: "done",
      stopReason: "completed",
      messageCount: 1,
      segment: { index: 0, source: "main" },
    });
    expect(done).not.toHaveProperty("messages");
    expect(JSON.stringify(done)).not.toContain("secret-history");

    const approval = serializeTurnEventForArchive(
      "main",
      {
        type: "approval_request",
        toolUseId: "tu-a",
        name: "bash",
        input: { command: "echo hi" },
        respond: () => {},
      },
      0,
    );
    expect(approval).toEqual({
      type: "approval_request",
      toolUseId: "tu-a",
      name: "bash",
      input: { command: "echo hi" },
    });
    expect(approval).not.toHaveProperty("respond");
  });

  it("tool_call + done 进档案；delta 不占 seq；续跑接着写", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cli-events-"));
    try {
      const handle = createCliDurable({ runId: "cli-ev-1", historyRoot: root });
      handle.noteEvent("main", {
        type: "tool_call",
        toolUseId: "tu1",
        name: "write_file",
        input: { path: "a.txt", content: "x" },
      });
      handle.noteEvent("main", { type: "text_delta", text: "partial..." });
      handle.noteEvent("main", { type: "thinking_delta", text: "hmm" });
      handle.noteEvent("main", sampleDone([{ role: "user", content: "secret-history" }]));
      handle.markCompleted();
      await handle.writer.flush();

      const raw = await readFile(path.join(root, "cli-ev-1", "events.jsonl"), "utf8");
      const events = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { seq: number; source: string; event: Record<string, unknown> });
      expect(events.map((e) => e.event.type)).toEqual(["tool_call", "done", "run_end"]);
      expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
      expect(events[0]).toMatchObject({
        source: "main",
        event: { type: "tool_call", name: "write_file", toolUseId: "tu1" },
      });
      expect(events[1]!.event).toMatchObject({
        type: "done",
        messageCount: 1,
        segment: { index: 0, source: "main" },
      });
      expect(events[1]!.event).not.toHaveProperty("messages");
      expect(raw).not.toContain("secret-history");
      expect(raw).not.toContain("text_delta");
      expect(raw).not.toContain("partial...");
      expect(events[2]!.event).toMatchObject({ type: "run_end", outcome: "completed", host: "cli" });
      expect(nextArchiveEventSeq(path.join(root, "cli-ev-1"))).toBe(3);

      const resumed = createCliDurable({
        runId: "cli-ev-1",
        historyRoot: root,
        existing: handle.getState(),
      });
      resumed.noteEvent("main", {
        type: "tool_call",
        toolUseId: "tu2",
        name: "read_file",
        input: { path: "a.txt" },
      });
      await resumed.writer.flush();
      const again = (await readFile(path.join(root, "cli-ev-1", "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { seq: number; event: { type: string } });
      expect(again.at(-1)).toMatchObject({ seq: 3, event: { type: "tool_call" } });
      expect(again.filter((e) => e.seq === 3)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("noteHostEvent 写入 plan_resume / plan_replan，与 Web 同一形状", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cli-host-plan-"));
    try {
      const handle = createCliDurable({ runId: "cli-hp-1", historyRoot: root });
      handle.noteHostEvent(hostPlanResumeEvent({
        kept: ["s1"],
        remaining: ["s2"],
        reason: "接着跑半截计划",
      }));
      handle.noteHostEvent(hostPlanReplanEvent({
        kept: ["s1"],
        added: ["s3"],
        dropped: ["s2"],
        changed: [],
        reason: "目标变了",
      }));
      handle.noteHostEvent({ nope: true });
      handle.markCompleted();
      await handle.writer.flush();
      const events = (await readFile(path.join(root, "cli-hp-1", "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { seq: number; source: string; event: Record<string, unknown> });
      expect(events.map((e) => e.event.type)).toEqual(["plan_resume", "plan_replan", "run_end"]);
      expect(events[0]).toMatchObject({
        seq: 0,
        source: "host",
        event: { type: "plan_resume", kept: ["s1"], remaining: ["s2"], reason: "接着跑半截计划" },
      });
      expect(events[1]).toMatchObject({
        seq: 1,
        source: "host",
        event: { type: "plan_replan", kept: ["s1"], added: ["s3"], dropped: ["s2"], changed: [] },
      });
      expect(hostPlanResumeEvent({ kept: ["a"], remaining: ["b"], reason: "x".repeat(250) }).reason).toHaveLength(200);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("plan / plan_result 与 Web 同一形状；续发射不要求再写 plan", async () => {
    const views = hostPlanSubtaskViews(
      [{ id: "s1", title: "一", description: "d", acceptance: ["a"], dependsOn: [], pack: "ts-coding" }],
      (name) => (name === "ts-coding" ? ["cpu"] : undefined),
    );
    expect(views[0]).toMatchObject({ id: "s1", pack: "ts-coding", resources: ["cpu"] });
    const planEv = hostPlanEvent({
      concurrency: 2,
      concurrencyMode: "auto",
      plannerMs: 12,
      subtasks: views,
      gated: false,
    });
    expect(planEv).toMatchObject({
      type: "plan",
      concurrency: 2,
      concurrencyMode: "auto",
      gated: false,
    });
    expect(planEv).not.toHaveProperty("replanned");

    const zeroUsage = {
      inputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      turns: 0,
      cacheHitRatio: 0,
    };
    const fail = hostPlanResultEvent(
      {
        completed: false,
        planOutcome: { raw: "x".repeat(500), usage: zeroUsage, failureSummary: "没拆开" },
        steps: [],
        skipped: [],
      } as PlannedRunResult,
      { startedAt: 1000, planReadyAt: 1100, finishedAt: 2000 },
    );
    expect(fail).toMatchObject({
      type: "plan_result",
      completed: false,
      planned: false,
      plannerFailure: "没拆开",
      plannerRecovery: null,
    });
    expect(String(fail.plannerRaw)).toHaveLength(400);
    expect(fail.timing).toEqual({
      totalMs: 1000,
      plannerMs: 100,
      subtaskWallMs: 900,
      stepSumMs: 0,
      savedMs: 0,
    });

    const root = await mkdtemp(path.join(tmpdir(), "cli-plan-ev-"));
    try {
      const handle = createCliDurable({ runId: "cli-plan-ev", historyRoot: root });
      handle.noteHostEvent(planEv);
      handle.noteHostEvent(fail);
      handle.markCompleted();
      await handle.writer.flush();
      const types = (await readFile(path.join(root, "cli-plan-ev", "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { event: { type: string } }).event.type);
      expect(types).toEqual(["plan", "plan_result", "run_end"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  canReopenSameRun,
  canRestorePlanGate,
  canSameRunResume,
  durableBudgetExhausted,
  initialRunState,
  planResumeFacts,
  recoveryActionForPhase,
  seedDurableBudget,
  snapshotDurableBudget,
  transitionRunState,
  type DurablePlanSnapshot,
} from "../src/run-state.js";

const plan: DurablePlanSnapshot = {
  protocol: "freeform",
  taskIds: ["s1", "s2"],
  edges: { s1: [], s2: ["s1"] },
  approvedAt: null,
  rejectedAt: null,
};

describe("RUN-01 Phase 1 run-state", () => {
  it("walks plan-gated → approve → execute → complete", () => {
    let s = initialRunState("r1", 1);
    s = transitionRunState(s, { type: "plan_begin" }, 2)!;
    expect(s.phase).toBe("planning");
    s = transitionRunState(s, { type: "plan_ready", plan, gated: true }, 3)!;
    expect(s.phase).toBe("plan_gated");
    s = transitionRunState(s, { type: "plan_approved", at: 4 }, 4)!;
    expect(s.phase).toBe("executing");
    expect(s.plan?.approvedAt).toBe(4);
    s = transitionRunState(s, { type: "complete" }, 5)!;
    expect(s.phase).toBe("completed");
  });

  it("rejects illegal transitions with null", () => {
    const s = initialRunState("r1");
    expect(transitionRunState(s, { type: "plan_approved", at: 1 })).toBeNull();
    expect(transitionRunState(s, { type: "complete" })!.phase).toBe("completed");
    expect(transitionRunState(transitionRunState(s, { type: "complete" })!, { type: "fail" })).toBeNull();
  });

  it("approval wait clears back to executing", () => {
    let s = transitionRunState(initialRunState("r"), { type: "start" })!;
    s = transitionRunState(s, { type: "approval_wait", approvalId: "a1" })!;
    expect(s.phase).toBe("awaiting_approval");
    s = transitionRunState(s, { type: "approval_resolved", approvalId: "a1" })!;
    expect(s.phase).toBe("executing");
    expect(s.pendingApprovalIds).toEqual([]);
  });

  it("maps crash phases to recovery actions per ADR-003", () => {
    expect(recoveryActionForPhase("plan_gated")).toBe("restore_gate");
    expect(recoveryActionForPhase("awaiting_approval")).toBe("expire_waits_and_fork");
    expect(recoveryActionForPhase("executing")).toBe("fork_from_checkpoint");
    expect(recoveryActionForPhase("completed")).toBe("readonly");
    expect(recoveryActionForPhase("planning")).toBe("close_archive");
  });

  it("plan_gated 崩溃回到门上：有未批快照才 restore，不 close_archive", () => {
    expect(
      canRestorePlanGate({ phase: "plan_gated", plan }),
    ).toBe(true);
    expect(
      canRestorePlanGate({
        phase: "plan_gated",
        plan: { ...plan, approvedAt: 9 },
      }),
    ).toBe(false);
    expect(
      canRestorePlanGate({
        phase: "plan_gated",
        plan: { ...plan, rejectedAt: 9 },
      }),
    ).toBe(false);
    expect(canRestorePlanGate({ phase: "interrupted", plan })).toBe(false);
    expect(
      canRestorePlanGate({ phase: "plan_gated", plan, budgetExhausted: true }),
    ).toBe(false);
  });

  it("零进度无检查点：有任务正文可 reopen，不假装能热续", () => {
    expect(
      canReopenSameRun({ phase: "interrupted", hasTask: true }),
    ).toBe(true);
    expect(
      canReopenSameRun({ phase: "failed", hasTask: true }),
    ).toBe(true);
    expect(
      canReopenSameRun({ phase: "interrupted", hasTask: false }),
    ).toBe(false);
    expect(
      canReopenSameRun({ phase: "plan_gated", hasTask: true }),
    ).toBe(false);
    expect(
      canReopenSameRun({ phase: "interrupted", hasTask: true, budgetExhausted: true }),
    ).toBe(false);
    expect(
      canSameRunResume({
        phase: "interrupted",
        hasCheckpoint: false,
        verify: false,
        mode: "single",
        budgetExhausted: false,
      }),
    ).toBe(false);
  });

  it("interrupt from executing", () => {
    const s = transitionRunState(transitionRunState(initialRunState("r"), { type: "start" })!, {
      type: "interrupt",
    })!;
    expect(s.phase).toBe("interrupted");
    expect(recoveryActionForPhase(s.phase)).toBe("readonly");
  });
});

describe("RUN-01 Phase 2 same-run resume", () => {
  it("resume only from interrupted → executing and stamps lastSameRunResumeAt", () => {
    let s = transitionRunState(initialRunState("r"), { type: "start" })!;
    s = transitionRunState(s, { type: "interrupt" }, 10)!;
    const next = transitionRunState(s, { type: "resume", at: 20 }, 20)!;
    expect(next.phase).toBe("executing");
    expect(next.lastSameRunResumeAt).toBe(20);
    expect(transitionRunState(next, { type: "resume", at: 30 })).toBeNull();
  });

  it("budget_snapshot and grant_audit persist without phase change", () => {
    let s = transitionRunState(initialRunState("r"), { type: "start" })!;
    s = transitionRunState(s, {
      type: "budget_snapshot",
      budget: { usedTurns: 3, usedTokens: 100, maxTurns: 120 },
    })!;
    expect(s.phase).toBe("executing");
    expect(s.budget).toEqual({ usedTurns: 3, usedTokens: 100, maxTurns: 120 });
    s = transitionRunState(s, {
      type: "grant_audit",
      entry: {
        grantId: "g1",
        approvalId: "a1",
        name: "bash",
        inputHash: "h",
        issuedAt: 1,
        expiresAt: 2,
        maxUses: 1,
        usedUses: 0,
        outcome: "issued",
        at: 3,
      },
    })!;
    expect(s.grantAudit).toHaveLength(1);
    expect(s.grantAudit[0]!.outcome).toBe("issued");
  });

  it("canSameRunResume requires interrupted + checkpoint; never for completed/plan/verify", () => {
    const base = {
      hasCheckpoint: true,
      verify: false,
      mode: "single" as const,
      budgetExhausted: false,
    };
    expect(canSameRunResume({ ...base, phase: "interrupted" })).toBe(true);
    expect(canSameRunResume({ ...base, phase: "executing" })).toBe(false);
    expect(canSameRunResume({ ...base, phase: "completed" })).toBe(false);
    expect(canSameRunResume({ ...base, phase: "interrupted", hasCheckpoint: false })).toBe(false);
    expect(canSameRunResume({ ...base, phase: "interrupted", verify: true })).toBe(false);
    expect(canSameRunResume({ ...base, phase: "interrupted", mode: "plan" })).toBe(false);
    expect(canSameRunResume({ ...base, phase: "interrupted", budgetExhausted: true })).toBe(false);
  });

  it("plan 半截 DAG：有 passed + remaining、无 failed 才放行；不要会话检查点", () => {
    const half = {
      approved: true,
      hasPassedNode: true,
      hasFailedNode: false,
      hasRemainingNode: true,
    };
    const input = {
      phase: "interrupted" as const,
      hasCheckpoint: false,
      verify: true,
      mode: "plan" as const,
      budgetExhausted: false,
      plan: half,
    };
    expect(canSameRunResume(input)).toBe(true);
    expect(canSameRunResume({ ...input, plan: { ...half, hasPassedNode: false } })).toBe(false);
    expect(canSameRunResume({ ...input, plan: { ...half, hasFailedNode: true } })).toBe(false);
    expect(canSameRunResume({ ...input, plan: { ...half, hasRemainingNode: false } })).toBe(false);
    expect(canSameRunResume({ ...input, plan: { ...half, approved: false } })).toBe(false);
    expect(canSameRunResume({ ...input, budgetExhausted: true })).toBe(false);
  });

  it("plan_progress 刷节点且不改 phase；终态拒绝", () => {
    let s = transitionRunState(initialRunState("r"), { type: "plan_begin" })!;
    s = transitionRunState(s, { type: "plan_ready", plan, gated: false })!;
    expect(s.phase).toBe("executing");
    const nodes = [
      {
        id: "s1",
        title: "一",
        description: "d",
        acceptance: [] as string[],
        dependsOn: [] as string[],
        status: "passed" as const,
        evidenceSummary: "s1 ok",
      },
      {
        id: "s2",
        title: "二",
        description: "d",
        acceptance: [] as string[],
        dependsOn: ["s1"],
        status: "pending" as const,
      },
    ];
    s = transitionRunState(s, { type: "plan_progress", nodes })!;
    expect(s.phase).toBe("executing");
    expect(s.plan?.nodes?.map((n) => n.status)).toEqual(["passed", "pending"]);
    expect(planResumeFacts(s.plan)).toEqual({
      approved: true,
      hasPassedNode: true,
      hasFailedNode: false,
      hasRemainingNode: true,
    });
    const done = transitionRunState(s, { type: "complete" })!;
    expect(transitionRunState(done, { type: "plan_progress", nodes })).toBeNull();
  });

  it("executor_checkpoint 写入游标且不改 phase；终态拒绝", () => {
    let s = transitionRunState(initialRunState("r"), { type: "start" })!;
    s = transitionRunState(s, {
      type: "executor_checkpoint",
      checkpoint: { segmentIndex: 0, contextInputTokens: 12 },
    })!;
    expect(s.phase).toBe("executing");
    expect(s.checkpoint).toEqual({ segmentIndex: 0, contextInputTokens: 12 });
    const done = transitionRunState(s, { type: "complete" })!;
    expect(
      transitionRunState(done, {
        type: "executor_checkpoint",
        checkpoint: { segmentIndex: 1, contextInputTokens: 1 },
      }),
    ).toBeNull();
  });

  it("durableBudgetExhausted：无快照 fail-open；used ≥ max 才耗尽", () => {
    expect(durableBudgetExhausted(undefined)).toBe(false);
    expect(durableBudgetExhausted(null)).toBe(false);
    expect(durableBudgetExhausted({ usedTurns: 9, usedTokens: 90 })).toBe(false);
    expect(durableBudgetExhausted({ usedTurns: 9, usedTokens: 90, maxTurns: 10 })).toBe(false);
    expect(durableBudgetExhausted({ usedTurns: 10, usedTokens: 90, maxTurns: 10 })).toBe(true);
    expect(durableBudgetExhausted({ usedTurns: 1, usedTokens: 100, maxTokens: 100 })).toBe(true);
    const live = { usedTurns: 0, usedTokens: 0, maxTurns: 80 };
    seedDurableBudget(live, { usedTurns: 12, usedTokens: 400, maxTurns: 40 });
    expect(live).toEqual({ usedTurns: 12, usedTokens: 400, maxTurns: 40 });
    expect(snapshotDurableBudget(live)).toEqual({ usedTurns: 12, usedTokens: 400, maxTurns: 40 });
  });

  it("mutation lock: canSameRunResume must not allow executing phase", () => {
    // 若有人把 phase 检查删掉，完成态档案会被谎报可同 run 热续
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

/**
 * 会话中心化：同进程内对已收尾的 run 追加新一轮。`reopen` 与 `resume` 是两件事——
 * resume 是崩溃后同 run 热恢复（仅 interrupted），reopen 是"这场对话还没完"。
 */
describe("reopen（会话续轮）", () => {
  const started = () => transitionRunState(initialRunState("r"), { type: "start" })!;

  it("completed / failed / closed / interrupted 都能回到 executing，挂起 id 清空", () => {
    for (const terminal of ["complete", "fail", "close", "interrupt"] as const) {
      const ended = transitionRunState(started(), { type: terminal })!;
      const reopened = transitionRunState(ended, { type: "reopen" }, 99);
      expect(reopened?.phase, `${terminal} → reopen`).toBe("executing");
      expect(reopened?.pendingApprovalIds).toEqual([]);
      expect(reopened?.updatedAt).toBe(99);
    }
  });

  it("有一轮还没结束时拒绝（created / plan_gated / awaiting_approval）——追加会与它并发", () => {
    expect(transitionRunState(initialRunState("r"), { type: "reopen" })).toBeNull();
    const gated = transitionRunState(
      transitionRunState(initialRunState("r"), { type: "plan_begin" })!,
      { type: "plan_ready", plan, gated: true },
    )!;
    expect(transitionRunState(gated, { type: "reopen" })).toBeNull();
    const waiting = transitionRunState(started(), { type: "approval_wait", approvalId: "a1" })!;
    expect(transitionRunState(waiting, { type: "reopen" })).toBeNull();
  });

  it("reopen 保留 toolTx / grantAudit / budget（它们是账，不是挂起态）", () => {
    let s = started();
    s = transitionRunState(s, { type: "budget_snapshot", budget: { usedTurns: 4, usedTokens: 9 } })!;
    s = transitionRunState(s, {
      type: "grant_audit",
      entry: { grantId: "g", approvalId: "a", name: "bash", inputHash: "h", issuedAt: 1, expiresAt: 2, maxUses: 1, usedUses: 0, outcome: "issued", at: 3 },
    })!;
    s = transitionRunState(s, { type: "complete" })!;
    const reopened = transitionRunState(s, { type: "reopen" })!;
    expect(reopened.budget).toEqual({ usedTurns: 4, usedTokens: 9 });
    expect(reopened.grantAudit).toHaveLength(1);
    // 续轮之后仍能正常记段与收尾
    const seg = transitionRunState(reopened, { type: "segment_begin", index: 2, source: "main" })!;
    expect(seg.phase).toBe("executing");
    expect(transitionRunState(seg, { type: "complete" })!.phase).toBe("completed");
  });
});

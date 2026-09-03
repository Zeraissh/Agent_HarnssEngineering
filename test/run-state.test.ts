import { describe, expect, it } from "vitest";
import {
  canSameRunResume,
  initialRunState,
  recoveryActionForPhase,
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
    expect(recoveryActionForPhase("plan_gated")).toBe("close_archive");
    expect(recoveryActionForPhase("awaiting_approval")).toBe("expire_waits_and_fork");
    expect(recoveryActionForPhase("executing")).toBe("fork_from_checkpoint");
    expect(recoveryActionForPhase("completed")).toBe("readonly");
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

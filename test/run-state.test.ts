import { describe, expect, it } from "vitest";
import {
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

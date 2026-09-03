import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  RunHistoryWriter,
  parseDurableRunState,
  readArchivedState,
} from "../ui/history.js";
import {
  durablePlanFromPlan,
  recoverDurableStateOnCrash,
} from "../ui/server.js";
import { initialRunState, transitionRunState } from "../src/run-state.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "run-state-"));
  dirs.push(d);
  return d;
}

describe("RUN-01 state.json persistence", () => {
  it("RunHistoryWriter writeState → readArchivedState round-trip", async () => {
    const dir = await temp();
    const w = new RunHistoryWriter(dir);
    let state = initialRunState("r1", 10);
    state = transitionRunState(state, { type: "start" }, 11)!;
    state = transitionRunState(
      state,
      { type: "segment_begin", index: 0, source: "main" },
      12,
    )!;
    w.writeState(state);
    await w.flush();
    const loaded = await readArchivedState(dir);
    expect(loaded).toEqual(state);
    const raw = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    expect(raw.phase).toBe("executing");
    expect(raw.segmentSource).toBe("main");
  });

  it("mutation: dropping phase makes parse fail-closed", () => {
    const good = initialRunState("r");
    expect(parseDurableRunState(good)?.phase).toBe("created");
    const { phase: _drop, ...broken } = good as unknown as Record<string, unknown>;
    expect(parseDurableRunState(broken)).toBeNull();
    expect(parseDurableRunState({ ...good, phase: "not-a-phase" })).toBeNull();
  });

  it("bad / missing state.json → null (同 meta 跳过纪律)", async () => {
    const dir = await temp();
    expect(await readArchivedState(dir)).toBeNull();
    await writeFile(join(dir, "state.json"), "{not json", "utf8");
    expect(await readArchivedState(dir)).toBeNull();
  });

  it("recoverDurableStateOnCrash follows ADR table", () => {
    const gated = transitionRunState(
      transitionRunState(initialRunState("r"), { type: "plan_begin" })!,
      {
        type: "plan_ready",
        plan: durablePlanFromPlan({
          subtasks: [{ id: "s1", title: "t", description: "d", acceptance: [], dependsOn: [] }],
        }),
        gated: true,
      },
    )!;
    expect(gated.phase).toBe("plan_gated");
    expect(recoverDurableStateOnCrash(gated).phase).toBe("closed");

    const exec = transitionRunState(initialRunState("r"), { type: "start" })!;
    expect(recoverDurableStateOnCrash(exec).phase).toBe("interrupted");

    const done = transitionRunState(exec, { type: "complete" })!;
    expect(recoverDurableStateOnCrash(done).phase).toBe("completed");
  });

  it("durablePlanFromPlan captures dependsOn edges", () => {
    const snap = durablePlanFromPlan({
      subtasks: [
        { id: "s1", title: "a", description: "d", acceptance: [], dependsOn: [] },
        { id: "s2", title: "b", description: "d", acceptance: [], dependsOn: ["s1"] },
      ],
    }, "structured");
    expect(snap.protocol).toBe("structured");
    expect(snap.taskIds).toEqual(["s1", "s2"]);
    expect(snap.edges).toEqual({ s1: [], s2: ["s1"] });
  });

  it("Phase 2：budget + grantAudit round-trip；旧档案缺字段仍可解析", async () => {
    const dir = await temp();
    const w = new RunHistoryWriter(dir);
    let state = initialRunState("r2", 10);
    state = transitionRunState(state, { type: "start" }, 11)!;
    state = transitionRunState(state, {
      type: "budget_snapshot",
      budget: { usedTurns: 1, usedTokens: 50, maxTurns: 10 },
    }, 12)!;
    state = transitionRunState(state, {
      type: "grant_audit",
      entry: {
        grantId: "g",
        approvalId: "a",
        name: "bash",
        inputHash: "hh",
        issuedAt: 1,
        expiresAt: 9,
        maxUses: 1,
        usedUses: 0,
        outcome: "checkpointed",
        at: 12,
      },
    }, 12)!;
    w.writeState(state);
    await w.flush();
    const loaded = await readArchivedState(dir);
    expect(loaded?.budget?.usedTurns).toBe(1);
    expect(loaded?.grantAudit).toHaveLength(1);

    // 旧 Phase 1 档案（无 budget/grantAudit）仍合法
    const legacy = {
      version: 1,
      runId: "legacy",
      phase: "executing",
      updatedAt: 1,
      plan: null,
      segmentIndex: 0,
      segmentSource: "main",
      verificationRound: 0,
      pendingApprovalIds: [],
      pendingQuestionIds: [],
      rootRunId: null,
      continuedFrom: null,
    };
    expect(parseDurableRunState(legacy)?.budget).toBeNull();
    expect(parseDurableRunState(legacy)?.grantAudit).toEqual([]);
  });
});

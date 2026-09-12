/**
 * 档案事件投影（Web events.jsonl ↔ CLI 共用）。
 *
 * delta 不占 seq、不进档案——重放几万条增量没有意义。
 * done 不带 messages（正史在 transcript.jsonl）。
 */
import type { PlannedRunResult } from "./orchestrate.js";
import type { SubTask } from "./planner.js";
import type { TurnEvent } from "./types.js";

export function isEphemeralTurnEvent(event: TurnEvent): boolean {
  return event.type === "text_delta" || event.type === "thinking_delta";
}

export function serializeTurnEventForArchive(
  source: string,
  event: TurnEvent,
  segmentIndex: number,
): Record<string, unknown> {
  switch (event.type) {
    case "approval_request":
      return {
        type: event.type,
        toolUseId: event.toolUseId,
        name: event.name,
        input: event.input,
      };
    case "done":
      return {
        type: event.type,
        stopReason: event.result.stopReason,
        usage: event.result.usage,
        ...(event.result.completion ? { completion: event.result.completion } : {}),
        ...(event.result.runBudget ? { runBudget: event.result.runBudget } : {}),
        ...(event.result.contextInputTokens !== undefined
          ? { contextInputTokens: event.result.contextInputTokens }
          : {}),
        ...(event.result.error
          ? { error: { name: event.result.error.name, message: event.result.error.message } }
          : {}),
        messageCount: event.result.messages.length,
        segment: { index: segmentIndex, source },
      };
    default:
      return { ...event };
  }
}

/** 半截 DAG 续发射：与 Web `pushSyntheticEvent` 同一形状。 */
export function hostPlanResumeEvent(input: {
  kept: readonly string[];
  remaining: readonly string[];
  reason: string;
}): { type: "plan_resume"; kept: string[]; remaining: string[]; reason: string } {
  return {
    type: "plan_resume",
    kept: [...input.kept],
    remaining: [...input.remaining],
    reason: input.reason.slice(0, 200),
  };
}

/** 重规划差分：与 Web `plan_replan` 同一形状。 */
export function hostPlanReplanEvent(input: {
  kept: readonly string[];
  added: readonly string[];
  dropped: readonly string[];
  changed: readonly string[];
  reason: string;
}): {
  type: "plan_replan";
  kept: string[];
  added: string[];
  dropped: string[];
  changed: string[];
  reason: string;
} {
  return {
    type: "plan_replan",
    kept: [...input.kept],
    added: [...input.added],
    dropped: [...input.dropped],
    changed: [...input.changed],
    reason: input.reason.slice(0, 200),
  };
}

export interface HostPlanSubtaskView {
  id: string;
  title: string;
  pack: string | null;
  description: string;
  acceptance: string[];
  dependsOn: string[];
  resources: string[];
}

export function hostPlanSubtaskViews(
  subtasks: readonly SubTask[],
  packResources: (pack: string) => readonly string[] | undefined,
): HostPlanSubtaskView[] {
  return subtasks.map((t) => ({
    id: t.id,
    title: t.title,
    pack: t.pack ?? null,
    description: t.description,
    acceptance: [...t.acceptance],
    dependsOn: [...t.dependsOn],
    resources: [...(t.resources ?? (t.pack ? packResources(t.pack) ?? [] : []))],
  }));
}

/** 计划就绪：与 Web `type: "plan"` 同一形状。续发射不写（原图已在档案里）。 */
export function hostPlanEvent(input: {
  concurrency: number;
  concurrencyMode: "auto" | "fixed";
  plannerMs: number;
  subtasks: readonly HostPlanSubtaskView[];
  gated?: boolean;
  replanned?: boolean;
}): Record<string, unknown> {
  return {
    type: "plan",
    concurrency: input.concurrency,
    concurrencyMode: input.concurrencyMode,
    plannerMs: input.plannerMs,
    subtasks: input.subtasks.map((t) => ({
      ...t,
      acceptance: [...t.acceptance],
      dependsOn: [...t.dependsOn],
      resources: [...t.resources],
    })),
    gated: Boolean(input.gated),
    ...(input.replanned ? { replanned: true } : {}),
  };
}

/** 编排收尾：与 Web `type: "plan_result"` 同一形状。 */
export function hostPlanResultEvent(
  outcome: PlannedRunResult,
  timing: { startedAt: number; planReadyAt: number; finishedAt: number },
): Record<string, unknown> {
  const stepSumMs = outcome.steps.reduce((n, st) => n + st.durationMs, 0);
  const subtaskWallMs = timing.finishedAt - timing.planReadyAt;
  return {
    type: "plan_result",
    completed: outcome.completed,
    planned: Boolean(outcome.plan),
    plannerRaw: outcome.plan ? undefined : outcome.planOutcome.raw.slice(0, 400),
    plannerRecovery: outcome.planOutcome.recovery ?? null,
    ...(outcome.planOutcome.failureSummary
      ? { plannerFailure: outcome.planOutcome.failureSummary }
      : {}),
    plannerUsage: outcome.planOutcome.usage,
    ...(outcome.clarification
      ? {
          clarification: {
            task: outcome.clarification.task,
            acceptance: outcome.clarification.acceptance,
            assumptions: outcome.clarification.assumptions,
            asked: outcome.clarification.asked,
            usage: outcome.clarification.usage,
          },
        }
      : {}),
    ...(outcome.planOutcome.inventory ? { inventory: outcome.planOutcome.inventory } : {}),
    steps: outcome.steps.map((st) => ({
      id: st.sub.id,
      title: st.sub.title,
      pack: st.sub.pack ?? null,
      durationMs: st.durationMs,
      passed: st.result.finalPassed,
      reworks: st.result.reworks,
      stopReason: st.result.main.stopReason,
      ...(st.result.main.completion ? { completion: st.result.main.completion } : {}),
      verdict: st.result.verifications.at(-1)?.verdict ?? null,
      usage: st.result.executionUsage,
    })),
    skipped: outcome.skipped.map((t) => ({ id: t.id, title: t.title })),
    timing: {
      totalMs: timing.finishedAt - timing.startedAt,
      plannerMs: timing.planReadyAt - timing.startedAt,
      subtaskWallMs,
      stepSumMs,
      savedMs: Math.max(0, stepSumMs - subtaskWallMs),
    },
  };
}

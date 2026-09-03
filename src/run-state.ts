/**
 * RUN-01 Durable RunState 纯函数内核（见 docs/adr/ADR-003）。
 *
 * Phase 1：phase 迁移 + 快照形状。
 * Phase 2：预算/grant 审计进 state；同 run 热恢复仅在「已提交 checkpoint
 * 段边界」上合法（idempotency ≡ checkpoint.segmentIndex）。不恢复 live
 * loop / AbortController / active grant；不做 SAFE-06 toolTx。
 */
export const RUN_STATE_VERSION = 1 as const;

export const RUN_PHASES = [
  "created",
  "planning",
  "plan_gated",
  "executing",
  "verifying",
  "reworking",
  "awaiting_approval",
  "awaiting_question",
  "completed",
  "failed",
  "closed",
  "interrupted",
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

export interface DurablePlanSnapshot {
  protocol: "freeform" | "structured" | "fixed";
  taskIds: string[];
  /** dependsOn 边：from → to[] */
  edges: Record<string, string[]>;
  approvedAt: number | null;
  rejectedAt: number | null;
}

/** SharedRunBudget 的可序列化快照（字段同 src/types，避免循环依赖）。 */
export interface DurableBudgetSnapshot {
  maxTurns?: number;
  maxTokens?: number;
  usedTurns: number;
  usedTokens: number;
}

/**
 * Grant 审计条目——只记账，永不活化为 capability（SAFE-04 / ADR）。
 * 形状对齐 ArchivedApprovalGrant 的可移植子集。
 */
export interface DurableGrantAuditEntry {
  grantId: string;
  approvalId: string;
  name: string;
  inputHash: string;
  issuedAt: number;
  expiresAt: number;
  maxUses: number;
  usedUses: number;
  /** 审计事件：issued | exhausted | expired | invalidated | checkpointed */
  outcome: "issued" | "exhausted" | "expired" | "invalidated" | "checkpointed";
  at: number;
}

export interface DurableRunState {
  version: typeof RUN_STATE_VERSION;
  runId: string;
  phase: RunPhase;
  updatedAt: number;
  plan: DurablePlanSnapshot | null;
  segmentIndex: number;
  segmentSource: string | null;
  verificationRound: number;
  pendingApprovalIds: string[];
  pendingQuestionIds: string[];
  rootRunId: string | null;
  continuedFrom: string | null;
  /** Phase 2：执行谱系预算快照；旧档案缺省 null */
  budget: DurableBudgetSnapshot | null;
  /** Phase 2：grant 审计（不恢复 active grant） */
  grantAudit: DurableGrantAuditEntry[];
  /**
   * Phase 2：最后一次同 run 恢复成功时的墙钟。
   * 有值 = 本档案曾诚实做过 same-run resume（非 fork）。
   */
  lastSameRunResumeAt: number | null;
}

export type RunStateEvent =
  | { type: "start" }
  | { type: "plan_begin" }
  | { type: "plan_ready"; plan: DurablePlanSnapshot; gated: boolean }
  | { type: "plan_approved"; at: number }
  | { type: "plan_rejected"; at: number }
  | { type: "segment_begin"; index: number; source: string }
  | { type: "verify_begin"; round: number }
  | { type: "rework_begin"; round: number }
  | { type: "approval_wait"; approvalId: string }
  | { type: "approval_resolved"; approvalId: string }
  | { type: "question_wait"; questionId: string }
  | { type: "question_resolved"; questionId: string }
  | { type: "budget_snapshot"; budget: DurableBudgetSnapshot }
  | { type: "grant_audit"; entry: DurableGrantAuditEntry }
  | { type: "resume"; at: number }
  | { type: "complete" }
  | { type: "fail" }
  | { type: "close" }
  | { type: "interrupt" };

export function initialRunState(runId: string, at = Date.now()): DurableRunState {
  return {
    version: RUN_STATE_VERSION,
    runId,
    phase: "created",
    updatedAt: at,
    plan: null,
    segmentIndex: 0,
    segmentSource: null,
    verificationRound: 0,
    pendingApprovalIds: [],
    pendingQuestionIds: [],
    rootRunId: null,
    continuedFrom: null,
    budget: null,
    grantAudit: [],
    lastSameRunResumeAt: null,
  };
}

/** 非法迁移返回 null（调用方 fail-closed 记日志，不抛——仪器不得打死 run）。 */
export function transitionRunState(
  state: DurableRunState,
  event: RunStateEvent,
  at = Date.now(),
): DurableRunState | null {
  const next: DurableRunState = {
    ...state,
    pendingApprovalIds: [...state.pendingApprovalIds],
    pendingQuestionIds: [...state.pendingQuestionIds],
    grantAudit: [...state.grantAudit],
    budget: state.budget ? { ...state.budget } : null,
    plan: state.plan ? { ...state.plan, edges: { ...state.plan.edges } } : null,
    updatedAt: at,
  };

  switch (event.type) {
    case "start":
      if (state.phase !== "created") return null;
      next.phase = "executing";
      return next;
    case "plan_begin":
      if (state.phase !== "created" && state.phase !== "executing") return null;
      next.phase = "planning";
      return next;
    case "plan_ready":
      if (state.phase !== "planning") return null;
      next.plan = event.plan;
      next.phase = event.gated ? "plan_gated" : "executing";
      return next;
    case "plan_approved":
      if (state.phase !== "plan_gated" || !next.plan) return null;
      next.plan = { ...next.plan, approvedAt: event.at, rejectedAt: null };
      next.phase = "executing";
      return next;
    case "plan_rejected":
      if (state.phase !== "plan_gated" || !next.plan) return null;
      next.plan = { ...next.plan, rejectedAt: event.at };
      next.phase = "closed";
      return next;
    case "segment_begin":
      if (!["executing", "reworking", "verifying"].includes(state.phase)) return null;
      next.segmentIndex = event.index;
      next.segmentSource = event.source;
      next.phase = event.source.startsWith("verifier")
        ? "verifying"
        : event.source.includes("rework")
          ? "reworking"
          : "executing";
      return next;
    case "verify_begin":
      if (!["executing", "reworking", "verifying"].includes(state.phase)) return null;
      next.phase = "verifying";
      next.verificationRound = event.round;
      return next;
    case "rework_begin":
      if (state.phase !== "verifying" && state.phase !== "executing") return null;
      next.phase = "reworking";
      next.verificationRound = event.round;
      return next;
    case "approval_wait":
      if (["completed", "failed", "closed", "interrupted"].includes(state.phase)) return null;
      if (!next.pendingApprovalIds.includes(event.approvalId)) {
        next.pendingApprovalIds.push(event.approvalId);
      }
      next.phase = "awaiting_approval";
      return next;
    case "approval_resolved":
      next.pendingApprovalIds = next.pendingApprovalIds.filter((id) => id !== event.approvalId);
      if (next.pendingApprovalIds.length === 0 && state.phase === "awaiting_approval") {
        next.phase = next.plan?.approvedAt || !next.plan ? "executing" : "plan_gated";
      }
      return next;
    case "question_wait":
      if (["completed", "failed", "closed", "interrupted"].includes(state.phase)) return null;
      if (!next.pendingQuestionIds.includes(event.questionId)) {
        next.pendingQuestionIds.push(event.questionId);
      }
      next.phase = "awaiting_question";
      return next;
    case "question_resolved":
      next.pendingQuestionIds = next.pendingQuestionIds.filter((id) => id !== event.questionId);
      if (next.pendingQuestionIds.length === 0 && state.phase === "awaiting_question") {
        next.phase = "executing";
      }
      return next;
    case "budget_snapshot":
      if (["completed", "failed", "closed"].includes(state.phase)) return null;
      next.budget = { ...event.budget };
      return next;
    case "grant_audit": {
      if (["completed", "failed", "closed"].includes(state.phase)) return null;
      const idx = next.grantAudit.findIndex((g) => g.grantId === event.entry.grantId);
      if (idx >= 0) next.grantAudit[idx] = { ...event.entry };
      else next.grantAudit.push({ ...event.entry });
      return next;
    }
    case "resume":
      // 仅 interrupted → executing。不恢复 grant / 不假装 loop 还在。
      if (state.phase !== "interrupted") return null;
      next.phase = "executing";
      next.pendingApprovalIds = [];
      next.pendingQuestionIds = [];
      next.lastSameRunResumeAt = event.at;
      return next;
    case "complete":
      if (["closed", "failed", "interrupted"].includes(state.phase)) return null;
      next.phase = "completed";
      next.pendingApprovalIds = [];
      next.pendingQuestionIds = [];
      return next;
    case "fail":
      if (["closed", "completed"].includes(state.phase)) return null;
      next.phase = "failed";
      next.pendingApprovalIds = [];
      next.pendingQuestionIds = [];
      return next;
    case "close":
      next.phase = "closed";
      next.pendingApprovalIds = [];
      next.pendingQuestionIds = [];
      return next;
    case "interrupt":
      if (["completed", "failed", "closed"].includes(state.phase)) return null;
      next.phase = "interrupted";
      next.pendingApprovalIds = [];
      next.pendingQuestionIds = [];
      return next;
    default:
      return null;
  }
}

/** 崩溃恢复策略（ADR 表）：只读决策，不执行 I/O。 */
export function recoveryActionForPhase(
  phase: RunPhase,
): "readonly" | "close_archive" | "expire_waits_and_fork" | "fork_from_checkpoint" {
  switch (phase) {
    case "completed":
    case "failed":
    case "closed":
    case "interrupted":
      return "readonly";
    case "created":
    case "planning":
    case "plan_gated":
      return "close_archive";
    case "awaiting_approval":
    case "awaiting_question":
      return "expire_waits_and_fork";
    default:
      return "fork_from_checkpoint";
  }
}

/**
 * Phase 2 同 run 热恢复准入（ADR：需 toolTx **或** idempotency 边界）。
 *
 * 本实现取后者：只在 interrupted + 已提交 main checkpoint 时放行。
 * 中途 tool 调用无 prepared/committed（SAFE-06 残余）——故不以 mid-tool 续跑。
 * Active grant 永不因本函数为 true 而复活。
 */
export function canSameRunResume(input: {
  phase: RunPhase;
  hasCheckpoint: boolean;
  verify: boolean;
  mode: "single" | "plan";
  budgetExhausted: boolean;
}): boolean {
  if (input.phase !== "interrupted") return false;
  if (!input.hasCheckpoint) return false;
  if (input.verify) return false;
  if (input.mode === "plan") return false;
  if (input.budgetExhausted) return false;
  return true;
}

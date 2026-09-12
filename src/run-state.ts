/**
 * RUN-01 Durable RunState 纯函数内核（见 docs/adr/ADR-003）。
 *
 * Phase 1：phase 迁移 + 快照形状。
 * Phase 2：预算/grant 审计进 state；同 run 热恢复仅在「已提交 checkpoint
 * 段边界」上合法（idempotency ≡ checkpoint.segmentIndex）。不恢复 live
 * loop / AbortController / active grant。
 * SAFE-06 Phase 1：toolTx[] 持久化 prepared/running/committed；mid-tool
 * 同 key 不重复 commit；不自动重放未完成 assistant 轮（见 ADR 附录）。
 */
import {
  parseDurableToolTx,
  type DurableToolTx,
  upsertToolTx,
} from "./tool-tx.js";

export type { DurableToolTx };
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

export const PLAN_NODE_STATUSES = ["pending", "running", "passed", "failed", "skipped"] as const;
export type DurablePlanNodeStatus = (typeof PLAN_NODE_STATUSES)[number];

export interface DurablePlanNode {
  id: string;
  title: string;
  pack?: string | null;
  description: string;
  acceptance: string[];
  dependsOn: string[];
  resources?: string[];
  status: DurablePlanNodeStatus;
  evidenceSummary?: string;
  failureStrategy?: string;
}

export interface DurablePlanSnapshot {
  protocol: "freeform" | "structured" | "fixed";
  taskIds: string[];
  /** dependsOn 边：from → to[] */
  edges: Record<string, string[]>;
  approvedAt: number | null;
  rejectedAt: number | null;
  /**
   * AGENT-01 / RUN-01：逐节点状态（可选）。旧档案没有 = 只有图结构。
   * 半截 DAG 续发射靠这份快照，不靠会话正史检查点。
   */
  nodes?: DurablePlanNode[];
}

/** 半截 DAG 同 run 续发射的只读事实——给 canSameRunResume 用。 */
export interface PlanResumeFacts {
  /** 计划存在且未被否决（未开门的崩溃走 closed，到不了这里） */
  approved: boolean;
  hasPassedNode: boolean;
  hasFailedNode: boolean;
  /** pending 或 running：图上还有活要干 */
  hasRemainingNode: boolean;
}

export function planResumeFacts(plan: DurablePlanSnapshot | null | undefined): PlanResumeFacts | undefined {
  if (!plan || plan.rejectedAt != null || plan.taskIds.length === 0) return undefined;
  const nodes = plan.nodes ?? [];
  return {
    approved: true,
    hasPassedNode: nodes.some((n) => n.status === "passed"),
    hasFailedNode: nodes.some((n) => n.status === "failed"),
    hasRemainingNode: nodes.some((n) => n.status === "pending" || n.status === "running"),
  };
}

function cloneDurablePlan(plan: DurablePlanSnapshot): DurablePlanSnapshot {
  return {
    ...plan,
    taskIds: [...plan.taskIds],
    edges: Object.fromEntries(Object.entries(plan.edges).map(([k, v]) => [k, [...v]])),
    ...(plan.nodes
      ? {
          nodes: plan.nodes.map((n) => ({
            ...n,
            acceptance: [...n.acceptance],
            dependsOn: [...n.dependsOn],
            ...(n.resources ? { resources: [...n.resources] } : {}),
          })),
        }
      : {}),
  };
}

/** SharedRunBudget 的可序列化快照（字段同 src/types，避免循环依赖）。 */
export interface DurableBudgetSnapshot {
  maxTurns?: number;
  maxTokens?: number;
  usedTurns: number;
  usedTokens: number;
}

/** 无快照 = 无法证明耗尽（fail-open）。有上限且 used ≥ max 才拒。 */
export function durableBudgetExhausted(budget: DurableBudgetSnapshot | null | undefined): boolean {
  if (!budget) return false;
  if (budget.maxTurns !== undefined && budget.usedTurns >= budget.maxTurns) return true;
  if (budget.maxTokens !== undefined && budget.usedTokens >= budget.maxTokens) return true;
  return false;
}

export function snapshotDurableBudget(budget: DurableBudgetSnapshot): DurableBudgetSnapshot {
  return {
    usedTurns: budget.usedTurns,
    usedTokens: budget.usedTokens,
    ...(budget.maxTurns !== undefined ? { maxTurns: budget.maxTurns } : {}),
    ...(budget.maxTokens !== undefined ? { maxTokens: budget.maxTokens } : {}),
  };
}

/** 把落盘账写回活的谱系对象（同一引用，spawn / loop 才能看见）。 */
export function seedDurableBudget(target: DurableBudgetSnapshot, snap: DurableBudgetSnapshot): void {
  target.usedTurns = snap.usedTurns;
  target.usedTokens = snap.usedTokens;
  if (snap.maxTurns !== undefined) target.maxTurns = snap.maxTurns;
  else delete target.maxTurns;
  if (snap.maxTokens !== undefined) target.maxTokens = snap.maxTokens;
  else delete target.maxTokens;
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
  /**
   * SAFE-06：副作用工具事务表（按 idempotencyKey upsert）。
   * 旧档案缺省 []。中断后保留——恢复时 seed 给 ToolExecutor 防重复 commit。
   */
  toolTx: DurableToolTx[];
  /**
   * 单执行者已提交的 main 检查点游标。正史在 transcript.jsonl，不进 state。
   * 旧档案缺省 null = 没有检查点。
   */
  checkpoint: DurableExecutorCheckpoint | null;
}

/** transcript 段号 + compact 水位；预算走 state.budget。 */
export interface DurableExecutorCheckpoint {
  segmentIndex: number;
  contextInputTokens: number;
}

export type RunStateEvent =
  | { type: "start" }
  | { type: "plan_begin" }
  | { type: "plan_ready"; plan: DurablePlanSnapshot; gated: boolean }
  | { type: "plan_approved"; at: number }
  | { type: "plan_rejected"; at: number }
  /** 子任务起止后刷节点状态；不改 phase。 */
  | { type: "plan_progress"; nodes: DurablePlanNode[] }
  | { type: "segment_begin"; index: number; source: string }
  | { type: "verify_begin"; round: number }
  | { type: "rework_begin"; round: number }
  | { type: "approval_wait"; approvalId: string }
  | { type: "approval_resolved"; approvalId: string }
  | { type: "question_wait"; questionId: string }
  | { type: "question_resolved"; questionId: string }
  | { type: "budget_snapshot"; budget: DurableBudgetSnapshot }
  | { type: "executor_checkpoint"; checkpoint: DurableExecutorCheckpoint }
  | { type: "grant_audit"; entry: DurableGrantAuditEntry }
  | { type: "resume"; at: number }
  /**
   * 会话中心化：同进程内对一个已收尾的 run 追加新一轮对话。
   * 与 `resume` 的区别：resume 是崩溃后同 run 热恢复（仅 interrupted）；
   * reopen 是"这场对话还没完"——completed/failed/closed/interrupted 都可回到
   * executing。挂起 id 清空（收尾时已宣告过期）；toolTx/grantAudit/budget 保留。
   */
  | { type: "reopen" }
  | { type: "tool_tx"; tx: DurableToolTx }
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
    toolTx: [],
    checkpoint: null,
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
    toolTx: state.toolTx.map((t) => ({ ...t })),
    budget: state.budget ? { ...state.budget } : null,
    checkpoint: state.checkpoint ? { ...state.checkpoint } : null,
    plan: state.plan ? cloneDurablePlan(state.plan) : null,
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
    case "plan_progress":
      if (!next.plan) return null;
      if (["completed", "failed", "closed"].includes(state.phase)) return null;
      next.plan = { ...next.plan, nodes: event.nodes.map((n) => ({ ...n })) };
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
    case "executor_checkpoint":
      if (["completed", "failed", "closed"].includes(state.phase)) return null;
      next.checkpoint = { ...event.checkpoint };
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
      // toolTx 故意保留：同 key 防重复 commit 的种子。
      if (state.phase !== "interrupted") return null;
      next.phase = "executing";
      next.pendingApprovalIds = [];
      next.pendingQuestionIds = [];
      next.lastSameRunResumeAt = event.at;
      return next;
    case "reopen":
      // 只有"已收尾"或"仍在执行相"的 run 能开新一轮；created/planning/plan_gated/
      // awaiting_* 都意味着有一轮还没结束，追加会与它并发——拒绝。
      if (
        !["completed", "failed", "closed", "interrupted", "executing", "verifying", "reworking"].includes(
          state.phase,
        )
      ) {
        return null;
      }
      next.phase = "executing";
      next.pendingApprovalIds = [];
      next.pendingQuestionIds = [];
      return next;
    case "tool_tx":
      if (["completed", "failed", "closed"].includes(state.phase)) return null;
      next.toolTx = upsertToolTx(next.toolTx, { ...event.tx });
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
export type RecoveryAction =
  | "readonly"
  | "close_archive"
  | "expire_waits_and_fork"
  | "fork_from_checkpoint"
  | "restore_gate";

export function recoveryActionForPhase(phase: RunPhase): RecoveryAction {
  switch (phase) {
    case "completed":
    case "failed":
    case "closed":
    case "interrupted":
      return "readonly";
    case "plan_gated":
      // 计划已落盘、子任务还没发射：崩溃后回到门上，不把对话封成 closed。
      return "restore_gate";
    case "created":
    case "planning":
      return "close_archive";
    case "awaiting_approval":
    case "awaiting_question":
      return "expire_waits_and_fork";
    default:
      return "fork_from_checkpoint";
  }
}

/**
 * Phase 2 同 run 热恢复准入（ADR：checkpoint 段边界；SAFE-06 不改此门）。
 *
 * 单执行者：interrupted + 已提交 main checkpoint；verify/预算耗尽仍拒。
 * 编排：不靠会话正史检查点（sN/main 不属于对话谱系），靠 durable plan 节点——
 * 至少一枚 passed、没有 failed、还有 pending/running。
 * 计划门未批的崩溃走 canRestorePlanGate，不走本函数。
 * Active grant 永不因本函数为 true 而复活。
 */
export function canSameRunResume(input: {
  phase: RunPhase;
  hasCheckpoint: boolean;
  verify: boolean;
  mode: "single" | "plan";
  budgetExhausted: boolean;
  plan?: PlanResumeFacts;
}): boolean {
  if (input.phase !== "interrupted") return false;
  if (input.budgetExhausted) return false;
  if (input.mode === "plan") {
    const p = input.plan;
    if (!p?.approved) return false;
    if (!p.hasPassedNode) return false;
    if (p.hasFailedNode) return false;
    if (!p.hasRemainingNode) return false;
    return true;
  }
  if (!input.hasCheckpoint) return false;
  if (input.verify) return false;
  return true;
}

/**
 * 崩溃停在计划确认门：计划已落盘、一个子任务都还没发射。
 * 同 run 回到门上是零副作用的（没有工具可重放）。
 */
export function canRestorePlanGate(input: {
  phase: RunPhase;
  plan?: DurablePlanSnapshot | null;
  budgetExhausted?: boolean;
}): boolean {
  if (input.budgetExhausted) return false;
  if (input.phase !== "plan_gated") return false;
  const plan = input.plan;
  if (!plan || plan.taskIds.length === 0) return false;
  if (plan.rejectedAt != null) return false;
  if (plan.approvedAt != null) return false;
  return true;
}

/**
 * 不能热续（无检查点 / 零进度 DAG）时，仍可用任务正文在同 run 重开一轮。
 * 不假装有检查点，也不自动重放飞行中的工具。
 */
export function canReopenSameRun(input: {
  phase: RunPhase;
  hasTask: boolean;
  budgetExhausted?: boolean;
}): boolean {
  if (!input.hasTask || input.budgetExhausted) return false;
  return ["interrupted", "failed", "completed", "closed"].includes(input.phase);
}

/** 供 history 解析复用：坏条目整表拒（与 grantAudit 同纪律）。 */
export function parseToolTxList(raw: unknown): DurableToolTx[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: DurableToolTx[] = [];
  for (const item of raw) {
    const tx = parseDurableToolTx(item);
    if (!tx) return null;
    out.push(tx);
  }
  return out;
}

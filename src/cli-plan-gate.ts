/**
 * CLI `--plan` 确认门：复用 runPlanned.onPlan + planner 短句补丁。
 * 不问编排器要新钩子。非 TTY 不建 readline、不摔 ERR_USE_AFTER_CLOSE。
 */
import {
  CLI_NEEDS_CONFIRM_EXIT,
  formatCliNeedsConfirmMessage,
  isReadlineClosedError,
} from "./cli-args.js";
import {
  applyPlanShortEdits,
  resolvePlanShortEdits,
  type Plan,
  type PlanShortEditPatch,
} from "./planner.js";

export const CLI_PLAN_GATE_RUN_PROMPT = "开跑？ [y/N] ";
export const CLI_PLAN_GATE_EDIT_ID_PROMPT = "改一行标题？输入子任务 id，回车跳过：";
export const CLI_PLAN_GATE_EDIT_TITLE_PROMPT = "新标题：";

export type CliPlanGateMode = "auto" | "prompt" | "need_yes";

export type CliPlanGateDecision =
  | { kind: "approve"; edits: PlanShortEditPatch[] }
  | { kind: "reject" }
  | { kind: "need_yes" };

export class CliPlanRejectedError extends Error {
  readonly exitCode = 1;

  constructor(message = "计划未获批准，未执行子任务。") {
    super(message);
    this.name = "CliPlanRejectedError";
  }
}

export function resolveCliPlanGateMode(opts: {
  autoYes: boolean;
  canPrompt: boolean;
}): CliPlanGateMode {
  if (opts.autoYes) return "auto";
  if (!opts.canPrompt) return "need_yes";
  return "prompt";
}

/** 与工具审批同一口径：只有 y / yes 算批准，空与 n 都是否决。 */
export function parseCliPlanGateYesNo(raw: string): "yes" | "no" {
  const s = raw.trim().toLowerCase();
  return s === "y" || s === "yes" ? "yes" : "no";
}

/** 子任务短表：id、标题、包、依赖。不含验收长文。 */
export function formatCliPlanShortTable(plan: Plan): string {
  return plan.subtasks
    .map((s) => {
      const pack = s.pack ? `  [${s.pack}]` : "";
      const deps = s.dependsOn.length > 0 ? `  ⇐ ${s.dependsOn.join(",")}` : "";
      return `${s.id}  ${s.title}${pack}${deps}`;
    })
    .join("\n");
}

export function applyCliPlanTitleEdits(plan: Plan, edits: readonly PlanShortEditPatch[]): PlanShortEditPatch[] {
  const resolved = resolvePlanShortEdits(
    plan,
    edits.map((e) => ({ id: e.id, ...(e.title !== undefined ? { title: e.title } : {}) })),
  );
  if (!resolved.ok) return [];
  applyPlanShortEdits(plan, resolved.patches);
  return resolved.patches;
}

/**
 * 计划门决策。`question` 只在 TTY 提示档调用；非 TTY / --yes 绝不碰 readline。
 */
export async function confirmCliPlan(opts: {
  plan: Plan;
  autoYes: boolean;
  canPrompt: boolean;
  question: (prompt: string) => Promise<string>;
}): Promise<CliPlanGateDecision> {
  const mode = resolveCliPlanGateMode(opts);
  if (mode === "auto") return { kind: "approve", edits: [] };
  if (mode === "need_yes") return { kind: "need_yes" };
  try {
    const ans = await opts.question(CLI_PLAN_GATE_RUN_PROMPT);
    if (parseCliPlanGateYesNo(ans) !== "yes") return { kind: "reject" };
    const idRaw = (await opts.question(CLI_PLAN_GATE_EDIT_ID_PROMPT)).trim();
    if (!idRaw) return { kind: "approve", edits: [] };
    const title = (await opts.question(CLI_PLAN_GATE_EDIT_TITLE_PROMPT)).trim();
    if (!title) return { kind: "approve", edits: [] };
    const resolved = resolvePlanShortEdits(opts.plan, [{ id: idRaw, title }]);
    if (!resolved.ok) return { kind: "approve", edits: [] };
    return { kind: "approve", edits: resolved.patches };
  } catch (err) {
    if (isReadlineClosedError(err)) return { kind: "need_yes" };
    throw err;
  }
}

export function cliPlanGateNeedYesMessage(): string {
  return formatCliNeedsConfirmMessage();
}

export function cliPlanGateNeedYesExit(): number {
  return CLI_NEEDS_CONFIRM_EXIT;
}

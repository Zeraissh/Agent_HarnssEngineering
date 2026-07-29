/**
 * L4 — 编排：主 agent 执行 → verifier 核查 → 未通过则带着问题清单返工。
 * 主 loop 与 verifier 共用 systemPrompt/tools（缓存前缀一致），上下文互相隔离。
 */
import { AgentLoop } from "./loop.js";
import { runPlanner, type Plan, type PlanOutcome, type SubTask } from "./planner.js";
import { runVerifier, sumUsage, type VerifyOutcome } from "./verifier.js";
import type { DomainPack } from "./presets.js";
import type { AgentConfig, AgentRunResult, AggregateUsage, ModelClient, TurnEvent } from "./types.js";

export interface VerifiedRunOptions {
  /** 核查未通过时的最大返工轮数。默认 1 */
  maxReworks?: number;
  /**
   * 返工模式（A/B 变量）：
   * - "fresh"（默认）：全新上下文重跑——独立重试，不被上一轮的错误推理污染；
   * - "inherit"：在上一轮会话正史上续跑——保留探索与工具结果，不从零重烧
   *   （fresh 模式最贵一例白烧 127k tokens；上下文增长由 compact 兜底）。
   */
  reworkMode?: "fresh" | "inherit";
  /** 领域验证指令：透传给 verifier，说明如何独立核查（如硬件场景自己连板重读） */
  verifyInstructions?: string;
  /**
   * 独立的 verifier 模型（默认与执行者共用同一个 client）。
   * A/B 研究结论：verifier 必须 ≥ 执行者强度，否则假阴性返工是净负——
   * 这个口子就是为"弱执行者 + 强核查者"的正确形态开的。
   * compat 随模型端点而定，与执行者的 compat 无关，因此需要一并指定。
   */
  verifierModel?: { client: ModelClient; compat?: boolean };
  /**
   * 事件旁路：所有主/返工 run 的事件都转发给宿主（含 approval_request——审批
   * 仍是宿主的事）。verifier 的事件也转发，但其 approval 已在内部 deny，仅供观察。
   */
  onEvent?: (source: "main" | "rework" | "verifier", event: TurnEvent) => void | Promise<void>;
}

export interface VerifiedRunResult {
  /** 最后一次执行 run 的结果（可能是返工后的） */
  main: AgentRunResult;
  /** 每轮核查的裁决（按时间顺序） */
  verifications: VerifyOutcome[];
  reworks: number;
  /** 最终裁决：最后一次核查是否通过 */
  finalPassed: boolean;
  /** 全部执行轮次（含被否掉的中间轮）的 usage 合计——成本核算必须用它而非 main.usage */
  executionUsage: AggregateUsage;
}

export async function runVerified(
  cfg: AgentConfig,
  model: ModelClient,
  task: string,
  opts: VerifiedRunOptions = {},
): Promise<VerifiedRunResult> {
  const maxReworks = opts.maxReworks ?? 1;
  const reworkMode = opts.reworkMode ?? "fresh";
  const verifications: VerifyOutcome[] = [];

  let main: AgentRunResult | undefined;
  let executionUsage: AggregateUsage | undefined;
  let feedback = task; // 首轮 = 任务本身；返工轮 = 反馈消息（fresh 含完整任务，inherit 只有增量）
  let reworks = 0;

  for (let round = 0; ; round++) {
    const source = round === 0 ? "main" : "rework";
    // inherit 模式的返工在上一轮正史上续跑；fresh（与首轮）全新开局
    const events =
      round > 0 && reworkMode === "inherit"
        ? new AgentLoop(cfg, model).runContinuation(main!.messages, feedback)
        : new AgentLoop(cfg, model).run(feedback);
    main = await drain(events, (e) => opts.onEvent?.(source, e));
    executionUsage = executionUsage ? sumUsage(executionUsage, main.usage) : main.usage;

    // 纯产物哲学：max_turns 时产物可能已就绪，照常核查；error 等宿主级失败才短路
    if (main.stopReason !== "completed" && main.stopReason !== "max_turns") {
      return { main, verifications, reworks, finalPassed: false, executionUsage };
    }

    const outcome = await runVerifierWithEvents(cfg, model, task, main, opts);
    verifications.push(outcome);

    if (outcome.verdict.passed) {
      return { main, verifications, reworks, finalPassed: true, executionUsage };
    }
    if (round >= maxReworks) {
      return { main, verifications, reworks, finalPassed: false, executionUsage };
    }

    reworks += 1;
    const issueList = `核查结论：${outcome.verdict.summary}
待修复问题：
${outcome.verdict.issues.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
    feedback =
      reworkMode === "inherit"
        ? `【返工】你上面的产出经独立核查未通过。${issueList}

请在已有工作的基础上核实并修复上述问题，然后重新交付。`
        : `${task}

【返工】上一轮产出经独立核查未通过。${issueList}

请核实并修复上述问题，然后重新交付。`;
  }
}

async function drain(
  events: AsyncIterable<TurnEvent>,
  onEvent: (e: TurnEvent) => void | Promise<void>,
): Promise<AgentRunResult> {
  let result: AgentRunResult | undefined;
  for await (const event of events) {
    await onEvent(event);
    if (event.type === "done") result = event.result;
  }
  return result!;
}

async function runVerifierWithEvents(
  cfg: AgentConfig,
  model: ModelClient,
  task: string,
  main: AgentRunResult,
  opts: VerifiedRunOptions,
): Promise<VerifyOutcome> {
  const executorReport = lastAssistantText(main) || "(执行者没有留下文字报告)";
  const verifierClient = opts.verifierModel?.client ?? model;
  const verifierCfg =
    opts.verifierModel && opts.verifierModel.compat !== undefined
      ? { ...cfg, compat: opts.verifierModel.compat }
      : cfg;
  // verifier 的过程事件（工具调用/复核）经 onEvent 下沉透出，宿主可见其独立核查过程；
  // 但压掉 verifier 的最终 assistant_text（裁决 JSON 是内部契约，不直接展示给用户）。
  const outcome = await runVerifier(
    verifierCfg,
    verifierClient,
    {
      task,
      executorReport,
      ...(opts.verifyInstructions ? { verifyInstructions: opts.verifyInstructions } : {}),
    },
    (event) => {
      if (event.type === "assistant_text" || event.type === "done") return;
      return opts.onEvent?.("verifier", event);
    },
  );
  // 最后单独上报一条人类可读的裁决摘要
  await opts.onEvent?.("verifier", {
    type: "assistant_text",
    text: `[verifier] passed=${outcome.verdict.passed} ${outcome.verdict.summary}`,
  });
  return outcome;
}

function lastAssistantText(result: AgentRunResult): string {
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const m = result.messages[i]!;
    if (m.role !== "assistant" || typeof m.content === "string") {
      if (m.role === "assistant" && typeof m.content === "string") return m.content;
      continue;
    }
    const text = m.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text) return text;
  }
  return "";
}

// ————————————————— 三角编排：planner → executor → verifier —————————————————

export interface PlannedRunOptions {
  /** 可用领域包（planner 的菜单 + 子任务 pack 名校验） */
  packs?: DomainPack[];
  /**
   * 宿主按子任务装配执行配置（按包换工具面/prompt/护栏）。
   * 缺省 = 全部子任务用 baseCfg + baseVerify。
   */
  resolveSubtask?: (sub: SubTask) => {
    cfg: AgentConfig;
    verify?: Pick<VerifiedRunOptions, "verifyInstructions" | "verifierModel" | "reworkMode">;
  };
  /** 每个子任务的最大返工轮数。默认 1 */
  maxReworks?: number;
  /** 计划就绪回调（在任何子任务执行前触发）：宿主可展示计划、做人工把关 */
  onPlan?: (plan: Plan) => void | Promise<void>;
  /** 事件旁路：source 形如 "planner" / "s1/main" / "s1/verifier" / "s1/rework" */
  onEvent?: (source: string, event: TurnEvent) => void | Promise<void>;
}

export interface PlannedStepResult {
  sub: SubTask;
  result: VerifiedRunResult;
}

export interface PlannedRunResult {
  /** undefined = planner 产不出可解析计划（fail-closed，未执行任何子任务） */
  plan?: Plan;
  planOutcome: PlanOutcome;
  /** 已执行的子任务（某步核查未通过则后续不再执行——快速失败） */
  steps: PlannedStepResult[];
  /** 全部子任务都执行且核查通过 */
  completed: boolean;
}

/**
 * 三角编排：planner 拆解（带验收标准）→ 逐子任务 runVerified（执行→核查→返工）
 * → 上游执行摘要作为交接注入下游。任一子任务核查未通过即中止（可靠性是乘法，
 * 带病继续只会把错误往下游放大）。
 */
export async function runPlanned(
  baseCfg: AgentConfig,
  model: ModelClient,
  task: string,
  opts: PlannedRunOptions = {},
): Promise<PlannedRunResult> {
  const packs = opts.packs ?? [];
  const planOutcome = await runPlanner(baseCfg, model, task, packs, (e) =>
    opts.onEvent?.("planner", e),
  );
  if (!planOutcome.plan) {
    return { planOutcome, steps: [], completed: false };
  }
  const plan = planOutcome.plan;
  await opts.onPlan?.(plan);

  const steps: PlannedStepResult[] = [];
  let prevHandoff = "";

  for (const sub of plan.subtasks) {
    // pack 名校验：未知包名不致命，降级为默认配置执行（记录在交接摘要里没有意义，宿主事件里可见）
    const resolved = opts.resolveSubtask?.(sub) ?? { cfg: baseCfg };

    const acceptance =
      sub.acceptance.length > 0
        ? `\n\n【验收标准】完成后将由独立核查者逐条验证：\n${sub.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")}`
        : "";
    const handoff = prevHandoff
      ? `\n\n【上游交接】上一个子任务的执行摘要（其产物路径以此为准）：\n${prevHandoff}`
      : "";
    const input = `${sub.description}${acceptance}${handoff}`;

    const result = await runVerified(resolved.cfg, model, input, {
      maxReworks: opts.maxReworks ?? 1,
      ...(resolved.verify ?? {}),
      onEvent: (source, event) => opts.onEvent?.(`${sub.id}/${source}`, event),
    });
    steps.push({ sub, result });

    if (!result.finalPassed) {
      return { plan, planOutcome, steps, completed: false };
    }
    prevHandoff = lastAssistantText(result.main) || "(上游没有留下文字报告)";
  }

  return { plan, planOutcome, steps, completed: true };
}

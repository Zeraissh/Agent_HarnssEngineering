/**
 * L4 — 编排：主 agent 执行 → verifier 核查 → 未通过则带着问题清单返工。
 * 主 loop 与 verifier 共用 systemPrompt/tools（缓存前缀一致），上下文互相隔离。
 */
import { AgentLoop } from "./loop.js";
import {
  runPlanner,
  runStructuredPlanner,
  validatePlanGraph,
  type Plan,
  type PlanOutcome,
  type SplitRule,
  type SubTask,
} from "./planner.js";
import { runVerifier, sumUsage, type VerifyOutcome } from "./verifier.js";
import { isTransientApiError } from "./model-client.js";
import type { DomainPack } from "./presets.js";
import type { AgentConfig, AgentRunResult, AggregateUsage, ModelClient, TurnEvent } from "./types.js";

export interface VerifiedRunOptions {
  /**
   * 中止信号。
   *
   * `AgentLoop.run` 从一开始就收 `AbortSignal`（loop.ts 每轮模型调用之前查它），
   * 但编排层与 Web 宿主**一直没往下传**——于是"停止"这个能力在 harness 里
   * 是有的、在宿主上是没有的。这正是宿主学那条规律的第九例
   * （findings 34：harness 有、宿主没接）。
   *
   * 语义：中止的是**执行者**。核查者不受它影响——一次已经开始的核查该跑完，
   * 半截的裁决比没有裁决更误导。
   */
  signal?: AbortSignal;
  /** 核查未通过时的最大返工轮数。默认 1 */
  maxReworks?: number;
  /**
   * 段级瞬时失败的续跑次数（9.8，缺省 1）。整段因瞬时宿主级错误终止时，
   * 带着已有正史续跑而不是作废。设 0 关闭（eval 做失败率统计时可能需要）。
   */
  transientResumes?: number;
  /**
   * 返工模式（A/B 变量）：
   * - "fresh"（默认）：全新上下文重跑——独立重试，不被上一轮的错误推理污染；
   * - "inherit"：在上一轮会话正史上续跑——保留探索与工具结果，不从零重烧
   *   （fresh 模式最贵一例白烧 127k tokens；上下文增长由 compact 兜底）。
   */
  reworkMode?: "fresh" | "inherit";
  /** 领域验证指令：透传给 verifier，说明如何独立核查（如硬件场景自己连板重读） */
  verifyInstructions?: string;
  /** verifier 的 bash 只读命令白名单（领域包声明），见 VerifyOptions.readOnlyCommands */
  verifyReadOnlyCommands?: string[];
  /** 主观评分表（rubric 模式载体），见 VerifyOptions.rubric——意见进 advisory,不触发返工 */
  verifyRubric?: string;
  /**
   * 核查者的轮次预算（缺省 15）。领域包用 `verify.maxTurns` 声明——
   * 真机域每条验收要多次探针往返，15 轮装不下（案例 #8）。
   */
  verifyMaxTurns?: number;
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
  /**
   * 每轮核查裁决出炉即回调（v2 Web 宿主催生）。
   *
   * 为什么需要它：verifications[] 只在 runVerified 返回时才拿得到，宿主要么等到
   * run 结束才能显示裁决，要么只能显示最后一轮——中间轮的 issues（也就是"为什么
   * 要返工"）在界面上永远不可见。这个回调让"逐轮裁决"能实时透出。
   * 纯附加、不影响控制流；不实现即完全等价于原行为。
   */
  onVerification?: (round: number, outcome: VerifyOutcome) => void | Promise<void>;
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

/**
 * 段级续跑的提示语。刻意短：模型手里的正史已经说明了一切，这里只需要告诉它
 * "刚才是基础设施抖了一下，不是你做错了"，以及别从头再来。
 */
const SEGMENT_RESUME_NUDGE = `【接续】刚才那次模型调用因为瞬时的基础设施故障（超时/限流/网络）中断了，不是你的工作有问题。你上面已经完成的步骤与工具返回都还在，请**从中断的地方接着做**，不要从头重来、也不要重复已经做过的工具调用。若你判断工作其实已经完成，直接给出最终总结即可。`;

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
        ? new AgentLoop(cfg, model).runContinuation(main!.messages, feedback, opts.signal)
        : new AgentLoop(cfg, model).run(feedback, opts.signal);
    main = await drain(events, (e) => opts.onEvent?.(source, e));
    executionUsage = executionUsage ? sumUsage(executionUsage, main.usage) : main.usage;

    /**
     * 段级续跑（9.8）：整段因**瞬时**宿主级错误终止时，带着已有正史再续一次，
     * 而不是把整段工作作废。
     *
     * **但人主动按了停止就不续**——中止在 loop 里也表现为 `stopReason=error`，
     * 不排除的话"停止"会变成"停一下又自己接着跑"，那是最糟的一种界面谎话。
     *
     * 案例 #8 实录：执行者跑到第 29 轮 API 超时，`stopReason=error` 直接短路，
     * 而它当时已经做了 28 次工具调用、最后一句是「让我验证 RCC 寄存器布局是否
     * 正确」——正朝着真缺陷去。一次端点抖动把整段工作连同进展全部作废。
     *
     * 这与 9.7 的收口续跑同构：那个救"核查没来得及收口"，这个救"执行没来得及
     * 交付"，都靠 runContinuation 把正史接上。
     *
     * **只对瞬时错误续跑**（认证/4xx/abort 属于永久性，续跑只是重复失败）——
     * 判据用 isTransientApiError 作用在原始错误上，不是字符串匹配分类后的消息。
     */
    let resumesLeft = opts.transientResumes ?? 1;
    while (
      main.stopReason === "error" &&
      resumesLeft > 0 &&
      main.messages.length > 0 &&
      // 人按了停止就不续——中止在 loop 里也是 stopReason=error，
      // 不排除的话"停止"会变成"停一下又自己接着跑"
      !opts.signal?.aborted &&
      isTransientApiError(main.error?.cause)
    ) {
      resumesLeft -= 1;
      const priorTurns = main.usage.turns;
      await opts.onEvent?.(source, {
        type: "segment_resume",
        attempt: (opts.transientResumes ?? 1) - resumesLeft,
        reason: main.error?.message ?? "瞬时失败",
        priorTurns,
      });
      const resumed = await drain(
        new AgentLoop(cfg, model).runContinuation(main.messages, SEGMENT_RESUME_NUDGE, opts.signal),
        (e) => opts.onEvent?.(source, e),
      );
      executionUsage = sumUsage(executionUsage!, resumed.usage);
      main = resumed;
    }

    // 纯产物哲学：max_turns 时产物可能已就绪，照常核查；error 等宿主级失败才短路
    if (main.stopReason !== "completed" && main.stopReason !== "max_turns") {
      return { main, verifications, reworks, finalPassed: false, executionUsage };
    }

    const outcome = await runVerifierWithEvents(cfg, model, task, main, opts);
    verifications.push(outcome);
    await opts.onVerification?.(round, outcome);

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
      ...(opts.verifyReadOnlyCommands ? { readOnlyCommands: opts.verifyReadOnlyCommands } : {}),
      ...(opts.verifyRubric ? { rubric: opts.verifyRubric } : {}),
      ...(opts.verifyMaxTurns !== undefined ? { maxTurns: opts.verifyMaxTurns } : {}),
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
    verify?: Pick<
      VerifiedRunOptions,
      | "verifyInstructions"
      | "verifyReadOnlyCommands"
      | "verifyRubric"
      | "verifyMaxTurns"
      | "verifierModel"
      | "reworkMode"
    >;
    /**
     * 独占资源标签（v1.1.1，领域包声明，如 ["swd-probe"]）：持有相同标签的
     * 子任务互斥——即使依赖图上独立、并行度允许，也强制先后执行。
     * 动机：真机域的探针/串口是全局单件，无锁并发 = 抢探针事故（实录见
     * case-01 与 windows-taskstop 僵尸风暴）。资源只在子任务在飞期间持有，
     * 结束即释放，不会死锁。
     */
    resources?: string[];
  };
  /** 每个子任务的最大返工轮数。默认 1 */
  maxReworks?: number;
  /** 计划就绪回调（在任何子任务执行前触发）：宿主可展示计划、做人工把关 */
  onPlan?: (plan: Plan) => void | Promise<void>;
  /** 事件旁路：source 形如 "planner" / "s1/main" / "s1/verifier" / "s1/rework" */
  onEvent?: (source: string, event: TurnEvent) => void | Promise<void>;
  /**
   * 并行度（v1.1）：同时在飞的子任务上限。默认 1 = 严格串行，行为与 v1.0 一致。
   * >1 时依赖图上互不依赖的子任务并发执行；执行/返工的 approval_request 经
   * 互斥门排队，宿主同一时刻至多面对一个待答审批（planner/verifier 的审批
   * 由其内部自答，不进门）。
   *
   * "auto" = min(3, 计划层宽)——A/B 采纳结论（ab-report-parallel.md）：拆分率
   * ~50/50 摇摆下串行默认让一半 run 白付拆分成本；并行调度零可见开销、token
   * 持平。线性链层宽 1 自动退化为串行，行为不变。
   */
  concurrency?: number | "auto";
  /**
   * 宿主注入的固定计划：跳过 planner，直接调度。用途：宿主自有拆解逻辑，
   * 或实验里隔离调度器变量（planner 拆不拆是独立的被测行为）。
   * 图非法时抛错（宿主代码 bug 应该炸响，不适用模型输出的 fail-closed）。
   */
  plan?: Plan;
  /**
   * 独立的 planner 模型（默认与执行者共用 client）——镜像 verifierModel 的口子。
   * 动机（ab-report-parallel.md）：flash 的拆分决策 ~50/50 摇摆是并行价值的
   * 瓶颈，"更强 planner"是稳定化候选之一。compat 随端点而定，需一并指定。
   * opts.plan 存在时此项无效（计划已注入，planner 不运行）。
   */
  plannerModel?: { client: ModelClient; compat?: boolean };
  /**
   * planner 协议（v1.1 拆分摇摆稳定化）：
   * - "freeform"（默认）：经典单发拆解，拆不拆由模型自由裁量（实测 ~50/50 摇摆，
   *   强 planner 无效——摇摆是纪律歧义区的裁量问题非能力问题）；
   * - "structured"：枚举与决策分离——planner 只枚举互不依赖分片（事实清单），
   *   拆不拆由宿主 splitRule 确定性判定，模型在决策点零裁量。
   */
  plannerProtocol?: "freeform" | "structured";
  /** structured 协议的拆分规则（默认 DEFAULT_SPLIT_RULE：分片≥2 即拆） */
  splitRule?: SplitRule;
}

export interface PlannedStepResult {
  sub: SubTask;
  result: VerifiedRunResult;
  /** 该子任务全程（执行+核查+返工）的墙钟耗时——并行价值的主度量 */
  durationMs: number;
}

export interface PlannedRunResult {
  /** undefined = planner 产不出可解析计划（fail-closed，未执行任何子任务） */
  plan?: Plan;
  planOutcome: PlanOutcome;
  /** 已执行的子任务，按计划顺序（某步核查未通过则停止发射新任务——快速失败） */
  steps: PlannedStepResult[];
  /** 未执行的子任务：依赖失败，或失败发生后调度停止（在飞的照常跑完） */
  skipped: SubTask[];
  /** 全部子任务都执行且核查通过 */
  completed: boolean;
}

/**
 * 三角编排：planner 拆解（带验收标准 + 依赖图）→ 子任务按依赖就绪调度
 * runVerified（执行→核查→返工）→ 直接依赖的执行摘要作为交接注入下游。
 *
 * 并行语义（v1.1）：concurrency>1 时互不依赖的子任务并发执行；任一子任务
 * 核查未通过即停止发射新任务——含与失败者无关的独立分支（整体已败，续跑
 * 只是烧 token），在飞的照常跑完（工具有副作用，中途硬断比跑完更危险），
 * 其余标记 skipped。可靠性是乘法，带病继续只会把错误往下游放大。
 */
export async function runPlanned(
  baseCfg: AgentConfig,
  model: ModelClient,
  task: string,
  opts: PlannedRunOptions = {},
): Promise<PlannedRunResult> {
  const packs = opts.packs ?? [];
  let planOutcome: PlanOutcome;
  if (opts.plan) {
    if (!validatePlanGraph(opts.plan.subtasks)) {
      throw new Error("注入的计划依赖图非法（id 重复/悬空引用/成环）");
    }
    planOutcome = { plan: opts.plan, usage: ZERO_USAGE, raw: "(host-provided plan)" };
  } else {
    const plannerClient = opts.plannerModel?.client ?? model;
    const plannerCfg =
      opts.plannerModel && opts.plannerModel.compat !== undefined
        ? { ...baseCfg, compat: opts.plannerModel.compat }
        : baseCfg;
    const onPlannerEvent = (e: TurnEvent) => opts.onEvent?.("planner", e);
    planOutcome =
      opts.plannerProtocol === "structured"
        ? await runStructuredPlanner(plannerCfg, plannerClient, task, packs, opts.splitRule, onPlannerEvent)
        : await runPlanner(plannerCfg, plannerClient, task, packs, onPlannerEvent);
  }
  if (!planOutcome.plan) {
    return { planOutcome, steps: [], skipped: [], completed: false };
  }
  const plan = planOutcome.plan;
  await opts.onPlan?.(plan);

  const concurrency =
    opts.concurrency === "auto"
      ? Math.min(AUTO_CONCURRENCY_CAP, planParallelWidth(plan.subtasks))
      : Math.max(1, Math.floor(opts.concurrency ?? 1));
  const byId = new Map(plan.subtasks.map((s) => [s.id, s]));
  const stepsById = new Map<string, PlannedStepResult>();
  const handoffs = new Map<string, string>();
  const passed = new Set<string>();
  const running = new Map<string, Promise<void>>();
  const queue = [...plan.subtasks]; // 未发射的子任务，保持计划顺序
  let aborted = false; // 首个失败后停止发射（在飞的跑完）
  let schedulerError: unknown;

  // 每个子任务只解析一次（解析结果含资源声明，调度判定与执行都要用）
  const resolvedById = new Map(
    plan.subtasks.map((s) => [s.id, opts.resolveSubtask?.(s) ?? { cfg: baseCfg }]),
  );
  const heldResources = new Set<string>();

  const forward = makeApprovalSerializer(opts.onEvent);

  const launch = (sub: SubTask): Promise<void> =>
    (async () => {
      // pack 名校验：未知包名不致命，降级为默认配置执行（宿主事件里可见）
      const resolved = resolvedById.get(sub.id)!;
      const input = buildSubtaskInput(sub, byId, handoffs);
      const startedAt = Date.now();
      const result = await runVerified(resolved.cfg, model, input, {
        maxReworks: opts.maxReworks ?? 1,
        ...(resolved.verify ?? {}),
        // 审批门只管执行/返工——verifier/planner 的 respond 由其内部自答，
        // 排队等宿主应答会死锁（内部自答在 onEvent 返回之后才发生）
        onEvent: (source, event) => forward(`${sub.id}/${source}`, event, source !== "verifier"),
      });
      stepsById.set(sub.id, { sub, result, durationMs: Date.now() - startedAt });
      if (result.finalPassed) {
        passed.add(sub.id);
        handoffs.set(sub.id, lastAssistantText(result.main) || "(上游没有留下文字报告)");
      } else {
        aborted = true;
      }
    })()
      .catch((err) => {
        // 宿主级异常：记下第一个，停止发射；等全部在飞任务归位后再抛，
        // 不留下悬空 promise（unhandled rejection）
        schedulerError ??= err;
        aborted = true;
      })
      .finally(() => {
        running.delete(sub.id);
        for (const r of sub.resources ?? resolvedById.get(sub.id)!.resources ?? []) heldResources.delete(r);
      });

  while (true) {
    if (!aborted) {
      const ready = queue.filter((s) => s.dependsOn.every((d) => passed.has(d)));
      for (const sub of ready) {
        if (running.size >= concurrency) break;
        // 独占资源互斥：与在飞子任务共享任一资源标签的，本轮不发射（资源释放后自然就绪）。
        // 子任务级声明覆盖包级默认（资源是仪器实例级的——双探针场景两个 debug 子任务
        // 各绑一只探针,包级同标签会误伤真并行）
        const resources = sub.resources ?? resolvedById.get(sub.id)!.resources ?? [];
        if (resources.some((r) => heldResources.has(r))) continue;
        for (const r of resources) heldResources.add(r);
        queue.splice(queue.indexOf(sub), 1);
        running.set(sub.id, launch(sub));
      }
    }
    if (running.size === 0) break; // 无在飞：全部完成，或失败/依赖不满足使调度停止
    await Promise.race(running.values());
  }
  if (schedulerError) throw schedulerError;

  const steps = plan.subtasks
    .map((s) => stepsById.get(s.id))
    .filter((s): s is PlannedStepResult => s !== undefined);
  const skipped = plan.subtasks.filter((s) => !stepsById.has(s.id));
  const completed = skipped.length === 0 && steps.every((s) => s.result.finalPassed);
  return { plan, planOutcome, steps, skipped, completed };
}

/** auto 并行度上限：收益曲线未测满前保守取 3（端点限流与宿主渲染都友好） */
export const AUTO_CONCURRENCY_CAP = 3;

/**
 * 计划的并行层宽（启发式）：按"距根的最长路径深度"分层，取最大层宽——
 * 即调度器在某一时刻可能同时就绪的子任务数的近似上界。线性链恒为 1。
 * 前提：依赖图已过校验（无环、引用存在）。
 */
export function planParallelWidth(subtasks: SubTask[]): number {
  if (subtasks.length === 0) return 1;
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const depth = new Map<string, number>();
  const depthOf = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    const sub = byId.get(id)!;
    const v =
      sub.dependsOn.length === 0 ? 0 : Math.max(...sub.dependsOn.map((d) => depthOf(d))) + 1;
    depth.set(id, v);
    return v;
  };
  const widths = new Map<number, number>();
  for (const s of subtasks) {
    const level = depthOf(s.id);
    widths.set(level, (widths.get(level) ?? 0) + 1);
  }
  return Math.max(...widths.values());
}

const ZERO_USAGE: AggregateUsage = {
  inputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  turns: 0,
  cacheHitRatio: 0,
};

/** 子任务输入 = 任务书 + 验收标准 + 直接依赖的交接摘要（多依赖多段，带来源标注） */
function buildSubtaskInput(
  sub: SubTask,
  byId: Map<string, SubTask>,
  handoffs: Map<string, string>,
): string {
  const acceptance =
    sub.acceptance.length > 0
      ? `\n\n【验收标准】完成后将由独立核查者逐条验证：\n${sub.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")}`
      : "";
  const sections = sub.dependsOn
    .filter((d) => handoffs.has(d))
    .map((d) => {
      const title = byId.get(d)?.title;
      return `── 来自 ${d}${title ? `（${title}）` : ""} ──\n${handoffs.get(d)!}`;
    });
  const handoff =
    sections.length > 0
      ? `\n\n【上游交接】你直接依赖的上游子任务的执行摘要（其产物路径以此为准）：\n${sections.join("\n\n")}`
      : "";
  return `${sub.description}${acceptance}${handoff}`;
}

/**
 * 审批互斥门：并发子任务的 approval_request 排队逐个交给宿主——终端审批
 * 提示同时弹两个是灾难（应答错配 + 渲染打架）。gated=false 的事件直通
 * （verifier 审批：宿主只观察，respond 由 verifier 内部自答，入队会死锁）。
 * 其余事件类型不排队：交错渲染是宿主的表达问题，不是正确性问题。
 */
function makeApprovalSerializer(
  onEvent?: (source: string, event: TurnEvent) => void | Promise<void>,
): (source: string, event: TurnEvent, gated: boolean) => void | Promise<void> {
  if (!onEvent) return () => {};
  let tail: Promise<void> = Promise.resolve();
  return (source, event, gated) => {
    if (event.type !== "approval_request" || !gated) return onEvent(source, event);
    const job = tail.then(async () => {
      let release!: () => void;
      const answered = new Promise<void>((resolve) => (release = resolve));
      const inner = event.respond;
      await onEvent(source, {
        ...event,
        respond: (decision, reason) => {
          inner(decision, reason);
          release();
        },
      });
      await answered;
    });
    tail = job.catch(() => {}); // 宿主异常不阻塞后续审批；异常本身沿 job 抛给调用方
    return job;
  };
}

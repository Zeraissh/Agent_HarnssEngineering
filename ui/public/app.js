import { createBatcher } from "./core/batch.js";
import { diffKeyed, signature } from "./core/diff.js";
import { isLocalPathCandidate, renderMarkdown, renderMarkdownInline } from "./core/markdown.js";
import {
  patchList,
  appendOnly,
  setText,
  setAttr,
  setClass,
  keepScrollAnchored,
  withFocusPreserved,
} from "./dom/patch.js";

// 桶文件转出：现有 import 路径（测试与控制器都从 /app.js 取）保持不变
export { createBatcher, diffKeyed, signature, patchList, appendOnly, setText, setAttr, setClass, keepScrollAnchored, withFocusPreserved };

/**
 * Harness Web UI — 纯函数 reducer + DOM 渲染层。
 *
 * 架构：
 *   reduceEvent(state, sseEvent) → 纯函数，把 SSE 事件流折叠为渲染模型。
 *   DOM 渲染函数惰性引用 window/document，可被 vitest node 环境 import。
 *
 * 导出：
 *   - reduceEvent / createInitialState / markApprovalResolved / expirePendingApprovals
 *   - deriveOverview / deriveLogEntries / toggleEntryCollapsed: 阶段二纯模型
 *   - deriveRunListItems / filterRunsByStatus: R-08 列表元数据与筛选
 *   - renderRunList / renderRunDetail / renderEmptyState: DOM 渲染（浏览器端）
 */

// ---------------------------------------------------------------
// 类型（JSDoc 注释，运行时即对象形状契约）
// ---------------------------------------------------------------

/**
 * @typedef {{
 *   runId: string,
 *   task: string,
 *   status: "running"|"done",
 *   archived: boolean,
 *   verify: boolean,
 *   timeline: TimelineEntry[],
 *   verifierTimeline: TimelineEntry[],
 *   autoAllow: {name:string,inputHash:string|null,inputScope:"exact-input"|"legacy-tool",grantId?:string,boundRunId?:string,expiresAt?:number,maxUses?:number,usedUses?:number,status:"active"|"expired"|"invalidated"|"exhausted"|"not-inherited"|"legacy"}[],
 *   pendingApprovals: PendingApproval[],
 *   verdict: VerdictModel|null,
 *   usage: UsageModel|null,
 *   error: string|null,
 *   stopReason: string|null,
 *   completion: {status:string,summary:string,artifacts:string[],verification:string[],assumptions:string[],blockers:string[]}|null,
 *   runBudget: {maxTurns?:number,maxTokens?:number,usedTurns:number,usedTokens:number}|null,
 *   lineage: {parentRunId:string,rootRunId:string,boundary:string,inheritedBudget:object|null,reset:string[]}|null,
 *   lastSeq: number,
 *   runEnd: {outcome:string, mainStopReason?:string, finishedAt:number}|null
 * }} RunState
 *
 * @typedef {{
 *   seq: number,
 *   source: string,
 *   type: string,
 *   turn?: number,
 *   name?: string,
 *   toolUseId?: string,
 *   input?: unknown,
 *   resultContent?: string,
 *   resultIsError?: boolean,
 *   durationMs?: number,
 *   text?: string,
 *   attempt?: number,
 *   reason?: string,
 *   action?: string,
 *   detail?: string,
 *   extraTurns?: number,
 *   droppedBlocks?: number
 *   ledgerEntries?: number
 *   summaryApplied?: boolean
 *   collapsedTurns?: number
 *   reactive?: boolean
 * }} TimelineEntry
 *
 * @typedef {TimelineEntry & {collapsed: boolean}} LogEntry
 *
 * @typedef {{
 *   toolUseId: string,
 *   name: string,
 *   input: unknown,
 *   status: "pending"|"allowed"|"denied"|"expired",
 *   reason?: string,
 *   decidedAt?: number,
 *   requestSeq?: number,
 *   approvalId?: string,
 *   grantPolicy?: {maxScope:"once"|"exact-input",maxTtlMs:number,maxUses:number}
 * }} PendingApproval
 *
 * @typedef {{
 *   passed: boolean,
 *   summary: string,
 *   issues: string[],
 *   unverified: string[],
 *   advisory: string[]
 * }} VerdictModel
 *
 * @typedef {{
 *   turns: number,
 *   inputTokens: number,
 *   outputTokens: number,
 *   cacheHitRatio: number
 * }} UsageModel
 *
 * @typedef {{
 *   finalStatus: string,
 *   resultSummary: string|null,
 *   completion: object|null,
 *   verdict: VerdictModel|null,
 *   actionItems: {pendingApprovals: PendingApproval[], unverifiedItems: string[], blockers:string[]},
 *   resolvedApprovals: PendingApproval[],
 *   usage: UsageModel|null
 * }} OverviewModel
 *
 * @typedef {{
 *   status: string,
 *   startTime: number,
 *   duration: number|null,
 *   verdictConclusion: string|null
 * }} RunListItemMeta
 */

// ---------------------------------------------------------------
// 纯函数：createInitialState
// ---------------------------------------------------------------

/** @returns {RunState} */
export function createInitialState(runId, task, verify, metadata = {}) {
  return {
    runId,
    task,
    status: "running",
    verify,
    archived: Boolean(metadata.archived),
    timeline: [],
    verifierTimeline: [],
    /** 本次对话内精确输入放行规则（见 deriveAssemblyBar 的 autoAllow 那一格） */
    autoAllow: [],
    pendingApprovals: [],
    verdict: null,
    usage: null,
    error: null,
    stopReason: null,
    completion: null,
    runBudget: null,
    /** 归档检查点派生边界；null = 本 run 不是跨宿主恢复出来的子级。 */
    lineage: null,
    lastSeq: -1,
    runEnd: null,
    /** 逐轮 token（来自 usage 事件）——上下文水位与成本的唯一来源 */
    usageByTurn: [],
    /** 逐轮核查裁决（来自 verification 事件），末轮之外的也保留 */
    verifications: [],
    /** toolUseId → 工具名。tool_result 事件本身不带 name，只能靠 tool_call 回填 */
    toolNames: {},
    /**
     * 本次运行的实际装配（V-24）。pack 可逐 run 覆盖，而 /api/harness 是进程级
     * 快照——两者不一致时以这个为准，否则 Tools 面会展示另一个包的边界。
     */
    runConfig: null,
    /** V-27 编排：计划、调度结果、降级告警 */
    plan: null,
    planResult: null,
    planWarnings: [],
    /**
     * 计划确认门（backlog §5.1）。null = 本 run 没开门。
     * status: pending 等签字 | approved | rejected | expired（run 收尾时未应答）
     */
    planApproval: null,
    // §5.2 需求澄清：当前挂起的提问（null = 没有）+ 已决记录（审计）
    question: null,
    questionLog: [],
    /** V-28：已进行的对话轮数（第 1 轮 = 建 run 时那次提交） */
    conversationTurn: 1,
  };
}

// ---------------------------------------------------------------
// 纯函数：stopReason 分档 (V-04)
// ---------------------------------------------------------------

/**
 * 把六种终止原因分档为 {色调, 人话标签, 补救提示}。
 *
 * 为什么值得单独一个函数：此前前端只判 `error`，其余五值一律显示绿色"已完成"。
 * 而 max_turns 与 error 恰是「verifier 救不了」的两类——执行根本没跑完，
 * 核查通过也不代表任务做完。界面必须直说，否则是在报喜不报忧。
 * 分档口径对齐 CLI（src/cli.ts 的 completed=绿 / max_tokens=黄 / 其余=红）。
 *
 * @param {string|null|undefined} stopReason
 * @returns {{tone:"ok"|"warn"|"bad", label:string, hint:string|null}}
 */
export function classifyStopReason(stopReason) {
  switch (stopReason) {
    case "completed":
      return { tone: "ok", label: "已完成", hint: null };
    case "max_tokens":
      return {
        tone: "warn",
        label: "输出被截断",
        hint: "单次响应达到上限，产物可能不完整；可提高 AGENT_MAX_TOKENS 后重跑",
      };
    case "max_turns":
      return {
        tone: "bad",
        label: "撞轮次护栏",
        hint: "执行未自然结束，核查救不了这一类——即使核查通过也不代表任务做完",
      };
    case "partial":
      return {
        tone: "warn",
        label: "部分完成",
        hint: "已有可用交付，但仍有未完成项；请查看结构化阻塞清单",
      };
    case "blocked":
      return {
        tone: "warn",
        label: "等待外部条件",
        hint: "执行者已明确列出无法自行解除的阻塞条件",
      };
    case "incomplete":
      return {
        tone: "bad",
        label: "未能结构化收口",
        hint: "模型多次结束生成却没有提交有效完成状态，不能按成功处理",
      };
    case "stalled":
      return {
        tone: "bad",
        label: "重复空转已停止",
        hint: "连续获得相同工具观察，换策略后仍无进展，宿主已停止继续烧轮次",
      };
    /**
     * 人主动叫停：判 warn 不判 bad。把委托方自己的决定画成"异常终止"
     * 是对他说谎（与 plan_rejected 同一条纪律）。
     */
    case "aborted":
      return {
        tone: "warn",
        label: "已停止",
        hint: "这次运行由你主动停止；已完成的工具调用与写入不会回滚。",
      };
    case "budget_exhausted":
      return {
        tone: "bad",
        label: "token 预算耗尽",
        hint: "执行未自然结束，产物大概率不完整",
      };
    case "refusal":
      return { tone: "bad", label: "模型拒答", hint: "模型拒绝继续，需要改写任务描述" };
    case "plan_rejected":
      // 不是失败，是决定——所以 warn 不是 bad，文案也不说"终止/异常"
      return {
        tone: "warn",
        label: "计划未获批准",
        hint: "计划确认门被否决，一个子任务都没有发射——没有任何副作用",
      };
    case "plan_gate_expired":
      return {
        tone: "warn",
        label: "计划门未应答",
        hint: "运行收尾时确认门仍在等待，未执行任何子任务",
      };
    case "error":
      return { tone: "bad", label: "异常终止", hint: "宿主级失败，核查不会运行" };
    case null:
    case undefined:
      return { tone: "ok", label: "运行中", hint: null };
    default:
      return { tone: "warn", label: String(stopReason), hint: null };
  }
}

// ---------------------------------------------------------------
// 纯函数：reduceEvent
// ---------------------------------------------------------------

/**
 * 恢复策略投影（run_config.recovery / harness.recovery 同形）。
 * 三字段缺一就整体 null——半份策略比没有更糟（会显示"续跑 8 轮"却不知道
 * 停滞窗是多少）；sources 缺省全 "default"，armed 缺省按 true（旧宿主没这个字段
 * 时完成门是默认开的）。
 * @returns {{armed:boolean,progressExtensionTurns:number,stagnationWindow:number,maxStagnationRecoveries:number,sources:Record<string,string>}|null}
 */
export function normalizeRecoveryConfig(raw) {
  if (!raw || typeof raw !== "object") return null;
  const fields = ["progressExtensionTurns", "stagnationWindow", "maxStagnationRecoveries"];
  const out = {};
  for (const f of fields) {
    if (typeof raw[f] !== "number" || !Number.isFinite(raw[f])) return null;
    out[f] = raw[f];
  }
  const sources = {};
  for (const f of fields) {
    const s = raw.sources && typeof raw.sources === "object" ? raw.sources[f] : undefined;
    sources[f] = s === "env" || s === "pack" ? s : "default";
  }
  return { armed: raw.armed !== false, ...out, sources };
}

/**
 * 把一条 SSE 事件折叠进渲染模型。
 * @param {RunState} state
 * @param {{seq:number, source:string, event:Record<string,unknown>}} sseEvent
 * @returns {RunState}
 */
export function reduceEvent(state, sseEvent) {
  const { seq, source, event } = sseEvent;
  const type = /** @type {string} */ (event.type);

  // text_delta 不进 state——它走 `event: delta` 命名通道、不占 seq、不进服务端
  // 事件缓冲（V-15），重连重放时根本不存在；进了 state 就会打破"同批事件重放
  // 两次状态深相等"。逐字显示由控制器单独持有缓冲、作为 renderRunDetail 的
  // liveText 入参喂进直播条（backlog §4）。这条分支守的是"万一它混进了durable
  // 流也不改状态"。
  if (type === "text_delta") return state;

  // ---- 路由 ----
  if (type === "verdict") {
    return applyVerdict(state, event);
  }
  if (type === "done") {
    return applySegmentDone(state, event, source);
  }
  if (type === "run_end") {
    return applyRunEnd(state, event);
  }
  if (type === "approval_request") {
    return applyApproval(state, seq, source, event);
  }
  if (type === "approval_resolved") {
    const next = applyApprovalResolved(state, event);
    /**
     * 放行规则也从权威事件里长出来。当前事件必须带 exact-input/hash；旧档案
     * 可能只有 scope，保留成 legacy 审计标记，但不会把它说成当前精确规则。
     */
    if (event.scope !== "run" && event.scope !== "conversation") return next;
    const name = String(event.name ?? "");
    if (!name) return next;
    const exact =
      event.scope === "run" &&
      event.inputScope === "exact-input" &&
      typeof event.inputHash === "string" &&
      typeof event.grantId === "string" &&
      event.boundRunId === state.runId &&
      Number.isFinite(Number(event.expiresAt));
    const rule = {
      name,
      inputHash: exact ? String(event.inputHash) : null,
      inputScope: exact ? "exact-input" : "legacy-tool",
      status: exact ? "active" : "legacy",
      ...(exact
        ? {
            grantId: String(event.grantId),
            boundRunId: String(event.boundRunId),
            expiresAt: Number(event.expiresAt),
            maxUses: Number(event.maxUses ?? 0),
            usedUses: Number(event.usedUses ?? 0),
          }
        : {}),
    };
    const index = next.autoAllow.findIndex(
      (item) =>
        (rule.grantId && item.grantId === rule.grantId) ||
        (!rule.grantId && item.name === rule.name && item.inputHash === rule.inputHash && item.inputScope === rule.inputScope),
    );
    if (index < 0) return { ...next, autoAllow: [...next.autoAllow, rule] };
    const autoAllow = [...next.autoAllow];
    autoAllow[index] = { ...autoAllow[index], ...rule };
    return { ...next, autoAllow };
  }
  if (
    type === "approval_grant_expired" ||
    type === "approval_grant_invalidated" ||
    type === "approval_grant_exhausted" ||
    type === "approval_grant_not_inherited"
  ) {
    const status = type === "approval_grant_expired"
      ? "expired"
      : type === "approval_grant_exhausted"
        ? "exhausted"
        : type === "approval_grant_not_inherited"
          ? "not-inherited"
          : "invalidated";
    const grantId = String(event.grantId ?? "");
    const index = state.autoAllow.findIndex((item) => grantId && item.grantId === grantId);
    const record = {
      name: String(event.name ?? "unknown"),
      inputHash: typeof event.inputHash === "string" ? String(event.inputHash) : null,
      inputScope: event.inputScope === "exact-input" ? "exact-input" : "legacy-tool",
      grantId: grantId || undefined,
      boundRunId: typeof event.boundRunId === "string" ? String(event.boundRunId) : undefined,
      expiresAt: Number.isFinite(Number(event.expiresAt)) ? Number(event.expiresAt) : undefined,
      status,
    };
    const autoAllow = [...state.autoAllow];
    if (index >= 0) autoAllow[index] = { ...autoAllow[index], ...record };
    else autoAllow.push(record);
    return {
      ...state,
      autoAllow,
      timeline: [...state.timeline, buildTimelineEntry(seq, source, type, event)],
    };
  }
  if (type === "approval_expired") {
    return applyApprovalExpired(state, event);
  }
  if (type === "run_forked") {
    const entry = buildTimelineEntry(seq, source, type, event);
    return {
      ...state,
      lineage: {
        parentRunId: String(event.parentRunId ?? ""),
        rootRunId: String(event.rootRunId ?? event.parentRunId ?? ""),
        boundary: String(event.boundary ?? ""),
        inheritedBudget: event.checkpoint && typeof event.checkpoint === "object"
          ? /** @type {any} */ (event.checkpoint).runBudget ?? null
          : null,
        reset: Array.isArray(event.reset) ? event.reset.map(String) : [],
        kind: "fork",
      },
      timeline: [...state.timeline, entry],
    };
  }
  if (type === "run_resumed") {
    const entry = buildTimelineEntry(seq, source, type, event);
    return {
      ...state,
      status: "running",
      runEnd: null,
      stopReason: null,
      error: null,
      lineage: {
        parentRunId: String(event.runId ?? ""),
        rootRunId: String(event.rootRunId ?? event.runId ?? ""),
        boundary: String(event.boundary ?? ""),
        inheritedBudget: event.checkpoint && typeof event.checkpoint === "object"
          ? /** @type {any} */ (event.checkpoint).runBudget ?? null
          : null,
        reset: Array.isArray(event.reset) ? event.reset.map(String) : [],
        kind: "same-run",
      },
      timeline: [...state.timeline, entry],
    };
  }
  if (type === "user_message") {
    // 追加的这句话既是会话内容，也标志 run 从终态回到运行中——
    // 状态由事件本身驱动，客户端不必另写一套特判。
    // 会话中心化：核查是逐轮选项，事件带本轮的 verify——reducer 的 `state.verify`
    // 从此是"当前这一轮核查不核查"，applySegmentDone 的单段快路径靠它判 done 是不是
    // run 终止。不接这个字段，第 1 轮没核查、第 2 轮核查的 run 会在执行者 done 时被
    // 判成结束，控制器随即关流，verifier 段与 run_end 全部收不到（V-01 那条缝的第三个现身）
    return {
      ...state,
      status: "running",
      runEnd: null,
      stopReason: null,
      error: null,
      ...(typeof event.verify === "boolean" ? { verify: event.verify } : {}),
      conversationTurn: Number(event.turn ?? state.conversationTurn + 1),
      timeline: [
        ...state.timeline,
        {
          seq, source, type: "user_message",
          text: String(event.text ?? ""),
          turn: Number(event.turn ?? 0),
          ...(typeof event.verify === "boolean" ? { verify: event.verify } : {}),
          // 这一轮接的是什么：history / plan-summary / fresh（旧事件没有，缺省不显示）
          ...(typeof event.continues === "string" ? { continues: event.continues } : {}),
        },
      ],
    };
  }
  if (type === "plan") {
    return {
      ...state,
      plan: {
        concurrency: Number(event.concurrency ?? 1),
        concurrencyMode: String(event.concurrencyMode ?? "fixed"),
        plannerMs: Number(event.plannerMs ?? 0),
        subtasks: Array.isArray(event.subtasks) ? event.subtasks : [],
        // 门开着时这份计划还在等签字，界面不能显得像已经在跑
        gated: Boolean(event.gated),
      },
    };
  }
  // ---- 计划确认门（§5.1）。三条事件都是 durable 合成事件，重连重放即复原 ----
  if (type === "plan_approval_request") {
    return { ...state, planApproval: { status: "pending", seq, at: Number(event.at ?? 0) } };
  }
  if (type === "plan_approval_resolved") {
    return {
      ...state,
      planApproval: {
        status: event.decision === "approve" ? "approved" : "rejected",
        seq: Number(event.requestSeq ?? seq),
        at: Number(event.at ?? 0),
        actor: String(event.actor ?? "user"),
      },
    };
  }
  if (type === "plan_approval_expired") {
    // 只有仍在 pending 时才转过期：已签过的决策是审计记录，不能被覆盖
    if (state.planApproval && state.planApproval.status !== "pending") return state;
    return {
      ...state,
      planApproval: { status: "expired", seq: Number(event.requestSeq ?? seq), at: 0 },
    };
  }
  // ---- 需求澄清（§5.2）。三条事件同计划门：durable 合成事件，重连重放即复原 ----
  if (type === "user_question_request") {
    return {
      ...state,
      question: {
        status: "pending",
        id: String(event.id ?? seq),
        seq,
        // 一次打断一组问题（决定 6）
        questions: (Array.isArray(event.questions) ? event.questions : []).map((q) => ({
          question: String(q.question ?? ""),
          options: Array.isArray(q.options) ? q.options.map(String) : [],
          fallback: String(q.fallback ?? ""),
        })),
        at: Number(event.at ?? 0),
      },
    };
  }
  if (type === "user_question_resolved") {
    const answered = {
      status: event.skipped ? "skipped" : "answered",
      id: String(event.id ?? ""),
      seq: Number(event.requestSeq ?? seq),
      questions: state.question ? state.question.questions : [],
      answers: Array.isArray(event.answers)
        ? event.answers.map((a) => (a === null || a === undefined ? null : String(a)))
        : [],
      at: Number(event.at ?? 0),
    };
    return { ...state, question: null, questionLog: [...state.questionLog, answered] };
  }
  if (type === "user_question_expired") {
    // 只有仍挂起时才转过期：已答过的是审计记录，不能被覆盖（同计划门口径）
    if (!state.question || state.question.status !== "pending") return state;
    return {
      ...state,
      question: null,
      questionLog: [...state.questionLog, { ...state.question, status: "expired", answers: [] }],
    };
  }
  // 9.8 段级续跑：整段因瞬时错误死掉后带着正史接着跑。必须显式呈现——
  // 否则宿主看到一个 done(error) 之后又冒出一堆事件，完全读不懂
  if (type === "segment_resume") {
    return {
      ...state,
      // 段死了又续上：状态回到运行中，清掉那条已经不成立的错误
      status: "running",
      error: null,
      stopReason: null,
      completion: null,
      timeline: [
        ...state.timeline,
        {
          seq, source, type: "segment_resume",
          attempt: Number(event.attempt ?? 1),
          reason: String(event.reason ?? ""),
          priorTurns: Number(event.priorTurns ?? 0),
        },
      ],
    };
  }
  if (type === "plan_result") {
    return { ...state, planResult: { ...event, type: undefined } };
  }
  if (type === "plan_warning") {
    return {
      ...state,
      planWarnings: [...state.planWarnings, { subtaskId: event.subtaskId, message: event.message }],
    };
  }
  if (type === "run_config") {
    return {
      ...state,
      runConfig: {
        pack: event.pack ?? null,
        workdir: event.workdir ?? null,
        executionIsolation: event.executionIsolation ?? null,
        roleModels: event.roleModels ?? null,
        effort: event.effort ?? null,
        effortApplies: Boolean(event.effortApplies),
        rubricSource: event.rubricSource ?? null,
        // 核查预算逐 run 可不同（9.1：领域包用 verify.maxTurns 覆盖）。
        // 这个分支是逐字段白名单投影——**新字段不在这里列出就会被静默丢弃**，
        // 本轮已是第三次踩到（api_retry.backoffMs、这里）。加字段必查这三处：
        // reduceEvent 的投影分支、派生函数、渲染分支。
        verifierBudgetTurns: event.verifierBudgetTurns ?? null,
        verifierBudgetSource: event.verifierBudgetSource ?? null,
        plannerBudgetTurns: event.plannerBudgetTurns ?? null,
        plannerBudgetSource: event.plannerBudgetSource ?? null,
        // 恢复策略（领域包可声明）：三字段 + 逐字段来源 + armed。armed 必须保真——
        // 完成门关着时 loop 根本不读这些数，界面若只显示数字就是在说谎
        recovery: normalizeRecoveryConfig(event.recovery),
        // 核查白名单的**生效值**与来源：无包运行拿通用缺省（委托方批准的例外），
        // 只读 pack.verify.readOnlyCommands 会把它画成"白名单 0 · 核查饥饿"
        verifierReadOnlyCommands: Array.isArray(event.verifierReadOnlyCommands)
          ? event.verifierReadOnlyCommands.map(String)
          : null,
        verifierReadOnlySource: event.verifierReadOnlySource ? String(event.verifierReadOnlySource) : null,
        // MODEL-01a：null = 没配这条防线，[] 与它不是一回事，别用 ?? [] 抹平
        fallbackChain: Array.isArray(event.fallbackChain) ? event.fallbackChain.map(String) : null,
        fallbackChains: event.fallbackChains && typeof event.fallbackChains === "object"
          ? {
              executor: Array.isArray(event.fallbackChains.executor) ? event.fallbackChains.executor.map(String) : null,
              verifier: Array.isArray(event.fallbackChains.verifier) ? event.fallbackChains.verifier.map(String) : null,
              planner: Array.isArray(event.fallbackChains.planner) ? event.fallbackChains.planner.map(String) : null,
              vision: Array.isArray(event.fallbackChains.vision) ? event.fallbackChains.vision.map(String) : null,
            }
          : null,
        fallbackScope: event.fallbackScope ? String(event.fallbackScope) : null,
        fallbackRouting: event.fallbackRouting ? String(event.fallbackRouting) : null,
        compatSource: event.compatSource ? String(event.compatSource) : null,
        guardrails: event.guardrails ?? null,
        tools: Array.isArray(event.tools) ? event.tools : [],
      },
    };
  }
  if (type === "usage") {
    return applyUsage(state, event);
  }
  if (type === "verification") {
    return applyVerification(state, seq, event);
  }

  // 其余事件进入时间线
  const entry = buildTimelineEntry(seq, source, type, event);
  const isVerifier = isVerifierSource(source);

  // V-12：tool_result 事件不带工具名（src/loop.ts 只发 toolUseId），日志里就成了
  // "toolu_01AbC... 成功"。靠 tool_call 记下的映射回填。
  let toolNames = state.toolNames;
  if (type === "tool_call" && entry.toolUseId) {
    toolNames = { ...toolNames, [entry.toolUseId]: entry.name };
  } else if (type === "tool_result" && entry.toolUseId && toolNames[entry.toolUseId]) {
    entry.name = toolNames[entry.toolUseId];
  }

  return {
    ...state,
    toolNames,
    timeline: isVerifier ? state.timeline : [...state.timeline, entry],
    verifierTimeline: isVerifier ? [...state.verifierTimeline, entry] : state.verifierTimeline,
  };
}

/**
 * 逐轮 token（V-09）。
 *
 * 此前这类事件落进 default 分支，被渲染成一条图标「•」、动作名「usage」、
 * 详情空白的噪声行——每轮一条。而它是**唯一**能提前算出"上下文快满了"的信号：
 * ContextManager 就是拿 input+cacheW+cacheR 对上限判是否要压缩的。
 * @returns {RunState}
 */
function applyUsage(state, event) {
  const u = /** @type {any} */ (event.usage) ?? {};
  return {
    ...state,
    usageByTurn: [
      ...state.usageByTurn,
      {
        turn: Number(event.turn ?? state.usageByTurn.length + 1),
        input: Number(u.input_tokens ?? 0),
        cacheCreation: Number(u.cache_creation_input_tokens ?? 0),
        cacheRead: Number(u.cache_read_input_tokens ?? 0),
        output: Number(u.output_tokens ?? 0),
      },
    ],
  };
}

/** 逐轮核查裁决（V-08）：中间轮的 issues 就是"为什么要返工"。@returns {RunState} */
function applyVerification(state, seq, event) {
  const raw = /** @type {any} */ (event.verdict) ?? {};
  return {
    ...state,
    verifications: [
      ...state.verifications,
      {
        round: Number(event.round ?? state.verifications.length),
        // 会话中心化：裁决只对它核查的那一轮负责——轮号与事件序号一起带走，
        // 对话里才能把它放回它出炉的位置、并标明判的是第几轮
        judgedTurn: Number.isFinite(Number(event.judgedTurn)) && event.judgedTurn !== undefined
          ? Number(event.judgedTurn)
          : null,
        seq: typeof seq === "number" ? seq : null,
        // 裁决获得路径（第五次提醒：这是逐字段白名单投影，不列出就静默丢弃）
        recovery: event.recovery ? String(event.recovery) : null,
        verdict: {
          passed: Boolean(raw.passed),
          summary: String(raw.summary ?? ""),
          issues: Array.isArray(raw.issues) ? raw.issues.map(String) : [],
          unverified: Array.isArray(raw.unverified) ? raw.unverified.map(String) : [],
          advisory: Array.isArray(raw.advisory) ? raw.advisory.map(String) : [],
        },
        usage: event.usage ?? null,
      },
    ],
  };
}

/**
 * 上下文水位（V-09）。
 *
 * 口径要害：分母是 contextTokenLimit，分子是**最近一轮**的输入
 * （input + cacheCreation + cacheRead），**不是全 run 累计**——
 * ContextManager.noteUsage 是赋值不是累加，按累计画会得到一条永远"即将压缩"
 * 却永远不压缩的假警报。累计量属于成本，另算。
 *
 * @param {RunState} state
 * @param {number|null} contextTokenLimit
 * @returns {{lastInputTokens:number, limit:number|null, ratio:number|null,
 *   watermark:number, split:{input:number,cacheCreation:number,cacheRead:number},
 *   cumulative:{input:number,cacheCreation:number,cacheRead:number,output:number},
 *   cacheHitRatio:number}}
 */
export function deriveContextUsage(state, contextTokenLimit) {
  const last = state.usageByTurn[state.usageByTurn.length - 1];
  const split = last
    ? { input: last.input, cacheCreation: last.cacheCreation, cacheRead: last.cacheRead }
    : { input: 0, cacheCreation: 0, cacheRead: 0 };
  const lastInputTokens = split.input + split.cacheCreation + split.cacheRead;

  const cumulative = state.usageByTurn.reduce(
    (a, t) => ({
      input: a.input + t.input,
      cacheCreation: a.cacheCreation + t.cacheCreation,
      cacheRead: a.cacheRead + t.cacheRead,
      output: a.output + t.output,
    }),
    { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 },
  );

  const denom = cumulative.input + cumulative.cacheCreation + cumulative.cacheRead;
  return {
    lastInputTokens,
    limit: contextTokenLimit ?? null,
    ratio: contextTokenLimit ? lastInputTokens / contextTokenLimit : null,
    watermark: 0.8,
    split,
    cumulative,
    cacheHitRatio: denom > 0 ? cumulative.cacheRead / denom : 0,
  };
}

/**
 * 批量折叠一批事件——控制器的真实入口。
 *
 * 相比逐条 reduceEvent 有两点不同，都是必要的：
 * ① 幂等：seq ≤ lastSeq 的事件直接丢弃。SSE 断线重连会带 Last-Event-ID 续传，
 *    但服务端可能全量重放（或客户端重复订阅），没有这道闸门就会出现重复的
 *    时间线条目与重复的审批卡。
 * ② 一批只做一次数组拷贝的语义边界，供渲染层按批重绘（消 O(n²)）。
 *
 * reduceEvent 保持"单事件、不设闸门"的旧语义：既有测试用固定 seq=0 构造事件流，
 * 在那里加闸门会把第二条以后的事件全丢掉。真实路径一律走本函数。
 *
 * @param {RunState} state
 * @param {{seq:number, source:string, event:Record<string,unknown>}[]} sseEvents
 * @returns {RunState}
 */
export function reduceEvents(state, sseEvents) {
  let next = state;
  for (const e of sseEvents) {
    if (typeof e.seq === "number" && e.seq <= next.lastSeq) continue;
    next = reduceEvent(next, e);
    if (typeof e.seq === "number" && e.seq > next.lastSeq) {
      next = { ...next, lastSeq: e.seq };
    }
  }
  return next;
}

/** 来源是否属于 verifier（放开为字符串后要兼容 "s1/verifier" 这类编排来源） */
function isVerifierSource(source) {
  return source === "verifier" || (typeof source === "string" && source.endsWith("/verifier"));
}

// ---------------------------------------------------------------
// 内部纯 helper
// ---------------------------------------------------------------

/** @returns {TimelineEntry} */
function buildTimelineEntry(seq, source, type, event) {
  const base = { seq, source, type };
  switch (type) {
    case "turn_start":
      return { ...base, turn: /** @type {number} */ (event.turn) };
    case "tool_call":
      return {
        ...base,
        toolUseId: /** @type {string} */ (event.toolUseId),
        name: /** @type {string} */ (event.name),
        input: event.input,
      };
    case "tool_prepared":
    case "tool_running":
    case "tool_committed":
    case "tool_failed":
    case "tool_aborted":
      return {
        ...base,
        toolUseId: /** @type {string} */ (event.toolUseId),
        name: /** @type {string} */ (event.name),
        idempotencyKey: String(event.idempotencyKey ?? ""),
        ...(typeof event.inputHash === "string" ? { inputHash: event.inputHash } : {}),
        ...(event.skipped === true ? { skipped: true } : {}),
        ...(typeof event.reason === "string" ? { reason: event.reason } : {}),
      };
    case "tool_result":
      return {
        ...base,
        toolUseId: /** @type {string} */ (event.toolUseId),
        resultContent: event.result && typeof event.result === "object" ? /** @type {string} */ (/** @type {any} */ (event.result).content) : "",
        resultIsError: event.result && typeof event.result === "object" ? Boolean(/** @type {any} */ (event.result).isError) : false,
        durationMs: /** @type {number} */ (event.durationMs),
      };
    case "assistant_text":
      return { ...base, text: /** @type {string} */ (event.text) };
    case "assistant_thinking":
      // 逐字段白名单投影：新字段不列出就静默丢弃（本轮第四次踩到这条）
      return {
        ...base,
        turn: /** @type {number} */ (event.turn),
        text: /** @type {string} */ (event.text ?? ""),
        redacted: Boolean(event.redacted),
      };
    case "api_retry":
      return {
        ...base,
        turn: /** @type {number} */ (event.turn),
        attempt: /** @type {number} */ (event.attempt),
        reason: /** @type {string} */ (event.reason),
        // 抖动上线后同一 attempt 的等待不再是定值；旧 run 没有这个字段，
        // 只在存在时带上（渲染层据此决定显不显示，不能显示 undefined）
        ...(typeof event.backoffMs === "number" ? { backoffMs: event.backoffMs } : {}),
      };
    // MODEL-01a 端点降级。逐字段白名单投影：不在这里列出的字段静默消失，
    // 而"少显示一行"在界面上看不出来（host-lags 那条纪律的第 N 次现身）
    case "model_fallback":
      return {
        ...base,
        from: String(event.from ?? ""),
        to: String(event.to ?? ""),
        reason: String(event.reason ?? ""),
        turn: Number(event.turn ?? 0),
        ...(event.role ? { role: String(event.role) } : {}),
        ...(event.routing ? { routing: String(event.routing) } : {}),
      };
    case "recovery_decision":
      return {
        ...base,
        reason: String(event.reason ?? ""),
        action: String(event.action ?? ""),
        detail: String(event.detail ?? ""),
        ...(typeof event.extraTurns === "number" ? { extraTurns: event.extraTurns } : {}),
      };
    case "run_forked":
      return {
        ...base,
        parentRunId: String(event.parentRunId ?? ""),
        rootRunId: String(event.rootRunId ?? event.parentRunId ?? ""),
        boundary: String(event.boundary ?? ""),
        inheritedBudget: event.checkpoint && typeof event.checkpoint === "object"
          ? /** @type {any} */ (event.checkpoint).runBudget ?? null
          : null,
        reset: Array.isArray(event.reset) ? event.reset.map(String) : [],
      };
    case "run_resumed":
      return {
        ...base,
        runId: String(event.runId ?? ""),
        rootRunId: String(event.rootRunId ?? event.runId ?? ""),
        boundary: String(event.boundary ?? ""),
        inheritedBudget: event.checkpoint && typeof event.checkpoint === "object"
          ? /** @type {any} */ (event.checkpoint).runBudget ?? null
          : null,
        segmentIndex:
          event.checkpoint && typeof event.checkpoint === "object"
            ? /** @type {any} */ (event.checkpoint).segmentIndex ?? null
            : null,
        reset: Array.isArray(event.reset) ? event.reset.map(String) : [],
      };
    case "compaction":
      return {
        ...base,
        droppedBlocks: /** @type {number} */ (event.droppedBlocks),
        ledgerEntries:
          typeof event.ledgerEntries === "number" ? /** @type {number} */ (event.ledgerEntries) : undefined,
        summaryApplied: event.summaryApplied === true,
        // Phase C：折叠了几轮旧对话（正文不可恢复）、是不是撞了端点 400 才压的
        collapsedTurns: typeof event.collapsedTurns === "number" ? event.collapsedTurns : 0,
        reactive: event.reactive === true,
      };
    default:
      return base;
  }
}

/** @returns {RunState} */
function applyApproval(state, seq, source, event) {
  const toolUseId = /** @type {string} */ (event.toolUseId);
  const name = /** @type {string} */ (event.name);
  const input = event.input;

  const entry = { seq, source, type: "approval_request", toolUseId, name, input };

  // F2: verifier 审批不进 pendingApprovals（内部已自答，HTTP 不应再应答）
  if (isVerifierSource(source)) {
    return {
      ...state,
      verifierTimeline: [...state.verifierTimeline, entry],
    };
  }

  // main/rework 审批：进时间线 + 挂起审批列表。
  // requestSeq 是这张卡的身份：返工轮会复用同一个 toolUseId，只有请求序号
  // 能区分"这是第几轮的那次审批"——否则一次点击会改写历史卡（V-03）。
  return {
    ...state,
    timeline: [...state.timeline, entry],
    pendingApprovals: [
      ...state.pendingApprovals,
      {
        toolUseId,
        name,
        input,
        status: "pending",
        requestSeq: seq,
        approvalId: `${toolUseId}#${seq}`,
        ...(event.grantPolicy && typeof event.grantPolicy === "object"
          ? { grantPolicy: event.grantPolicy }
          : {}),
      },
    ],
  };
}

/**
 * 服务端宣告的审批决策（V-02）。
 * 决策此前只写在浏览器内存里，刷新即失真——现在以服务端事件为准，
 * 任意客户端重放同一事件流都得到同一份审计记录。
 * @returns {RunState}
 */
function applyApprovalResolved(state, event) {
  const requestSeq = /** @type {number} */ (event.requestSeq);
  const toolUseId = /** @type {string} */ (event.toolUseId);
  const status = event.decision === "allow" ? "allowed" : "denied";
  return {
    ...state,
    pendingApprovals: state.pendingApprovals.map((a) =>
      matchesApproval(a, requestSeq, toolUseId)
        ? {
            ...a,
            status,
            ...(event.reason ? { reason: String(event.reason) } : {}),
            decidedAt: Number(event.at ?? Date.now()),
            actor: event.actor ? String(event.actor) : undefined,
          }
        : a,
    ),
  };
}

/** 服务端宣告的审批过期（run 结束时逐条发出）。@returns {RunState} */
function applyApprovalExpired(state, event) {
  const requestSeq = /** @type {number} */ (event.requestSeq);
  const toolUseId = /** @type {string} */ (event.toolUseId);
  return {
    ...state,
    pendingApprovals: state.pendingApprovals.map((a) =>
      matchesApproval(a, requestSeq, toolUseId) && a.status === "pending"
        ? { ...a, status: /** @type {"expired"} */ ("expired") }
        : a,
    ),
  };
}

/** 优先按 requestSeq 精确匹配；缺该字段时退回 toolUseId（兼容旧事件流重放） */
function matchesApproval(approval, requestSeq, toolUseId) {
  if (typeof requestSeq === "number" && typeof approval.requestSeq === "number") {
    return approval.requestSeq === requestSeq;
  }
  return approval.toolUseId === toolUseId;
}

/** @returns {RunState} */
function applyVerdict(state, event) {
  const raw = /** @type {any} */ (event.verdict);
  return {
    ...state,
    verdict: {
      passed: Boolean(raw.passed),
      summary: String(raw.summary ?? ""),
      issues: Array.isArray(raw.issues) ? raw.issues.map(String) : [],
      unverified: Array.isArray(raw.unverified) ? raw.unverified.map(String) : [],
      advisory: Array.isArray(raw.advisory) ? raw.advisory.map(String) : [],
      // 末轮裁决判的是第几轮对话（会话中心化）；旧事件流没有这个字段
      ...(Number.isFinite(Number(event.judgedTurn)) && event.judgedTurn !== undefined
        ? { judgedTurn: Number(event.judgedTurn) }
        : {}),
    },
  };
}

/**
 * 段终止（V-01 的核心修复点）。
 *
 * `done` 宣告的是**一段**执行结束，不是整个 run 结束。核查模式下
 * `runVerified` 会把主轮的 done 也转发出来，此后还有 verifier 段、可能还有
 * 返工段。旧实现在这里直接把 run 置为 done 并把挂起审批全部作废，导致
 * 返工轮的审批卡不再渲染操作按钮 → respond 永不被调用 → 循环永久 await。
 *
 * 现在：只记录段的终止原因与用量；run 级收敛交给 run_end。
 * 唯一例外是非核查运行——它按协议只有一段，其 done 即 run 终止，
 * 这条快路径同时保住了既有测试的语义。
 *
 * @returns {RunState}
 */
function applySegmentDone(state, event, source = "main") {
  const usage = event.usage && typeof event.usage === "object" ? /** @type {any} */ (event.usage) : null;
  const stopReason = /** @type {string} */ (event.stopReason);
  const errorMessage =
    event.error && typeof event.error === "object"
      ? String(/** @type {any} */ (event.error).message ?? "")
      : "";

  const next = {
    ...state,
    stopReason,
    ...(event.completion && typeof event.completion === "object"
      ? { completion: { ...event.completion } }
      : {}),
    ...(event.runBudget && typeof event.runBudget === "object"
      ? { runBudget: { ...event.runBudget } }
      : {}),
    // 服务端此前把 error 整条丢掉，前端只能写死一句话；现在有真实消息就用真实的
    error: stopReason === "error" ? errorMessage || "运行异常终止" : null,
    usage: usage
      ? {
          turns: Number(usage.turns ?? 0),
          inputTokens: Number(usage.inputTokens ?? 0),
          outputTokens: Number(usage.outputTokens ?? 0),
          cacheHitRatio: Number(usage.cacheHitRatio ?? 0),
        }
      : state.usage,
  };

  /**
   * 单段运行的快路径：非核查模式下不会再有后续段，done 即终止。
   *
   * **必须限定 source === "main"**（真机实测抓到的缺陷）：编排模式下 planner
   * 自己那一轮也发 `done(completed)`，各子任务发 `sN/main` 的 done。不限定来源，
   * 客户端会在 planner 一结束就判定整个 run 结束——控制器随即 `es.close()`，
   * 之后的 plan / plan_result / 子任务进度 / run_end 全部收不到，界面停在
   * "已完成"并把 planner 的 JSON 当成执行者报告展示。
   *
   * 这就是 V-01 那条「段终止 ≠ run 终止」，当时在事件层修过（`done` 只记段，
   * run 级收敛由 `run_end` 宣告），reducer 侧这个快路径漏掉了同一条。
   * 触发条件是 mode=plan 且未勾核查——而那正是选了"计划编排"后的默认组合。
   */
  if (!state.verify && source === "main") {
    return { ...next, status: "done", pendingApprovals: expireAll(next.pendingApprovals) };
  }
  return next;
}

/**
 * run 级终止（服务端 run_end，恒为最后一条 durable 事件）。
 * 幂等——单段快路径可能已经收敛过一次。
 * @returns {RunState}
 */
function applyRunEnd(state, event) {
  const mainStopReason = event.mainStopReason ? String(event.mainStopReason) : state.stopReason;
  return {
    ...state,
    status: "done",
    stopReason: mainStopReason,
    error:
      mainStopReason === "error" ? state.error || "运行异常终止" : state.error,
    pendingApprovals: expireAll(state.pendingApprovals),
    // 末轮之前若未收到 verification 事件（如旧事件流重放），用 run_end 里的补齐
    verifications:
      state.verifications.length > 0 || !Array.isArray(event.verifications)
        ? state.verifications
        : /** @type {any[]} */ (event.verifications).map((v, i) => ({
            round: Number(v.round ?? i),
            judgedTurn: Number.isFinite(Number(v.judgedTurn)) && v.judgedTurn !== undefined
              ? Number(v.judgedTurn)
              : null,
            seq: null,
            verdict: v.verdict,
            usage: v.usage ?? null,
          })),
    runEnd: {
      outcome: String(event.outcome ?? "completed"),
      ...(mainStopReason ? { mainStopReason } : {}),
      finishedAt: Number(event.finishedAt ?? Date.now()),
      ...(event.finalPassed !== undefined ? { finalPassed: Boolean(event.finalPassed) } : {}),
      ...(event.reworks !== undefined ? { reworks: Number(event.reworks) } : {}),
      // V-07：成本口径。executionUsage 含被否掉的中间轮，是唯一正确的执行成本；
      // verificationUsage 是核查侧开销，两者分列不混。
      ...(event.executionUsage ? { executionUsage: event.executionUsage } : {}),
      ...(event.verificationUsage ? { verificationUsage: event.verificationUsage } : {}),
    },
  };
}

/** stopReason 色调 → 状态徽章 class */
function toneClass(tone) {
  if (tone === "bad") return "status--error";
  if (tone === "warn") return "status--warn";
  return "status--done";
}

function expireAll(approvals) {
  return approvals.map((a) =>
    a.status === "pending" ? { ...a, status: /** @type {"expired"} */ ("expired") } : a,
  );
}

// ---------------------------------------------------------------
// v2 R4：四决定因素派生层 (V-17)
//
// 组织原则来自 docs/01-philosophy.md:5-12——模型能力固定时，agent 表现的
// 差异全部落在 Loop / Tools / Context / Verification 四处。所以控制台首屏
// 呈现的是这四个面的当前状态，日志退为它们的下钻内容，而不是反过来。
// 全部是纯函数，可在 node 环境直测。
// ---------------------------------------------------------------

/** verifier 输出无法解析时的哨兵（与 src/verifier.ts:303 逐字一致） */
export const VERDICT_PARSE_FAIL = "verifier 输出无法解析为 JSON 裁决";

/** 写类工具：会改变外部世界的那些，用于识别"零写入返工" */
const WRITE_TOOLS = new Set(["write_file", "memory_write", "bash"]);

/** 能从入参直接读出产物路径的写类工具。bash 不在其中——见 deriveArtifacts 的说明 */
const ARTIFACT_TOOLS = new Set(["write_file", "memory_write"]);

/** source → 角色。前缀式来源（"s1/main"）为并行编排预留 */
function segmentRole(source) {
  if (source === "planner") return "planner";
  if (isVerifierSource(source)) return "verifier";
  const tail = typeof source === "string" && source.includes("/")
    ? source.slice(source.lastIndexOf("/") + 1)
    : source;
  return tail === "rework" ? "rework" : "main";
}

/**
 * 把时间线切成段：main → verifier → rework → verifier …
 *
 * 存在的理由：此前日志把三种来源按 seq 混排，标题写着"Agent 执行"却混着核查
 * 条目，"第 1 轮"出现四次而看不出属于哪一段（V-11）。CLI 有明确的黄色
 * `↺ 核查未通过，开始返工…` 分界（src/cli.ts:449），Web 一直没有。
 *
 * @param {RunState} state
 * @returns {{index:number, source:string, role:string, round:number, startSeq:number, endSeq:number, entries:TimelineEntry[]}[]}
 */
export function deriveSegments(state) {
  const all = [...state.timeline, ...state.verifierTimeline].sort((a, b) => a.seq - b.seq);
  const segments = [];
  let current = null;
  const roundOf = { main: 0, rework: 0, verifier: 0 };

  for (const entry of all) {
    if (!current || current.source !== entry.source) {
      const role = segmentRole(entry.source);
      const round = role === "main" ? 0 : roundOf[role]++ + (role === "rework" ? 1 : 0);
      current = {
        index: segments.length,
        source: entry.source,
        role,
        round,
        startSeq: entry.seq,
        endSeq: entry.seq,
        entries: [],
      };
      segments.push(current);
    }
    current.endSeq = entry.seq;
    current.entries.push(entry);
  }
  return segments;
}

/**
 * 编排面（V-27）：依赖图、每个子任务的状态与耗时、并行收益。
 *
 * 依赖图按**层**呈现而不是画自由图：层 = 依赖深度，同层意味着互不依赖、
 * 可并发。这正是并行调度真正在做的决策，也是"为什么能省时间"的解释。
 * 手写图布局既贵又不会更清楚。
 *
 * 返回 null 表示这次运行不是编排模式——调用方据此决定要不要渲染这一块。
 */
export function derivePlanFace(state) {
  const plan = state.plan;
  if (!plan) return null;

  const subs = plan.subtasks;
  const byId = new Map(subs.map((t) => [t.id, t]));
  const result = state.planResult;
  const stepById = new Map((result?.steps ?? []).map((st) => [st.id, st]));
  const skipped = new Set((result?.skipped ?? []).map((x) => x.id));

  // 哪些子任务已经开跑：来源形如 "s1/main"，前缀即子任务 id
  const started = new Set();
  for (const e of [...state.timeline, ...state.verifierTimeline]) {
    const src = String(e.source ?? "");
    if (src.includes("/")) started.add(src.slice(0, src.indexOf("/")));
  }

  const statusOf = (id) => {
    const st = stepById.get(id);
    if (st) return st.passed ? "passed" : "failed";
    if (skipped.has(id)) return "skipped";
    if (started.has(id)) return "running";
    return "pending";
  };

  // 依赖深度 = 层号。带记忆的深度优先，环在服务端已 fail-closed 挡掉，
  // 这里仍留一道访问标记防御——前端不该因为一份脏数据栈溢出
  const depth = new Map();
  const computing = new Set();
  const depthOf = (id) => {
    if (depth.has(id)) return depth.get(id);
    if (computing.has(id)) return 0;
    computing.add(id);
    const t = byId.get(id);
    const d = !t || t.dependsOn.length === 0
      ? 0
      : Math.max(...t.dependsOn.map((p) => depthOf(p) + 1));
    computing.delete(id);
    depth.set(id, d);
    return d;
  };

  const nodes = subs.map((t) => ({
    ...t,
    depth: depthOf(t.id),
    status: statusOf(t.id),
    durationMs: stepById.get(t.id)?.durationMs ?? null,
    reworks: stepById.get(t.id)?.reworks ?? null,
    verdict: stepById.get(t.id)?.verdict ?? null,
  }));

  const layers = [];
  for (const n of nodes) {
    (layers[n.depth] ??= []).push(n);
  }

  const maxDuration = Math.max(1, ...nodes.map((n) => n.durationMs ?? 0));
  return {
    concurrency: plan.concurrency,
    concurrencyMode: plan.concurrencyMode,
    plannerMs: plan.plannerMs,
    nodes,
    layers: layers.map((l) => l ?? []),
    // 层宽 = 理论最大并发；与实际并行度并列显示才看得出调度有没有吃满
    parallelWidth: Math.max(1, ...layers.map((l) => (l ?? []).length)),
    maxDuration,
    timing: result?.timing ?? null,
    completed: result?.completed ?? null,
    planned: result ? result.planned !== false : null,
    plannerRaw: result?.plannerRaw ?? null,
    // B0：区分"胡言乱语"与"探索没来得及收口"——两者的返工策略完全不同
    plannerRecovery: result?.plannerRecovery ?? null,
    plannerFailure: result?.plannerFailure ?? null,
    warnings: state.planWarnings,
    skipped: result?.skipped ?? [],
    // 计划确认门的审计记录（§5.1）。挂起态归 ActionRail（那是"需你现在决定"
    // 的地方）；已决/过期归这里——它是这份计划的历史，不是待办事项。
    // 两处不重复展示同一条，口径同 V-16。
    gate: state.planApproval ?? null,
  };
}

/**
 * Loop 面：轮次水位、六值终止、返工裁决序列。
 * @param {RunState} state
 * @param {object|null} harness `/api/harness` 快照
 */
export function deriveLoopFace(state, harness) {
  const isRunning = state.status === "running";
  // 逐 run 装配优先于进程级快照——用户选了别的包时，护栏也跟着换
  const rc = state.runConfig;
  const maxTurns = rc?.guardrails?.maxTurns ?? harness?.guardrails?.maxTurns ?? null;

  // 轮次取执行侧（main/rework）的最大 turn_start——核查轮预算独立，不该混进来
  let turn = 0;
  for (const e of state.timeline) {
    // planner 是只读拆解，预算与执行者解耦，不并入轮次水位
    if (e.source === "planner") continue;
    if (e.type === "turn_start" && typeof e.turn === "number" && e.turn > turn) turn = e.turn;
  }

  const segments = deriveSegments(state);
  const verdictOf = (round) => state.verifications.find((v) => v.round === round)?.verdict ?? null;
  let verifierSeen = 0;
  const chain = segments.map((s) => {
    if (s.role !== "verifier") return { role: s.role, round: s.round, passed: null };
    const v = verdictOf(verifierSeen++);
    return { role: "verifier", round: s.round, passed: v ? Boolean(v.passed) : null };
  });

  return {
    isRunning,
    turn,
    maxTurns,
    ratio: maxTurns ? Math.min(turn / maxTurns, 1) : null,
    nearLimit: Boolean(maxTurns && turn / maxTurns >= 0.8),
    stopReason: isRunning ? null : classifyStopReason(state.stopReason),
    chain,
    reworks: state.runEnd?.reworks ?? segments.filter((s) => s.role === "rework").length,
    retries: state.timeline.filter((e) => e.type === "api_retry"),
    // 端点降级与同轮重试分开计：一个是"同一家再试一次"，一个是"换了一家"，
    // 混成一个数字就再也答不出"这次运行到底是谁应答的"
    fallbacks: state.timeline.filter((e) => e.type === "model_fallback"),
    effort: rc?.effort ?? harness?.effort ?? null,
    effortApplies: Boolean(rc ? rc.effortApplies : harness?.effortApplies),
    // 恢复策略：逐 run 优先于进程级快照（编排下各子任务的包可声明不同的续跑额度）。
    // 与它管着的那几条 recovery_decision 放在同一个面上——策略与它的触发记录并排
    recovery: rc?.recovery ?? normalizeRecoveryConfig(harness?.recovery) ?? null,
    recoveryDecisions: state.timeline.filter((e) => e.type === "recovery_decision"),
  };
}

/**
 * 恢复策略一行文案（Loop 卡 / 状态条共用）。
 * armed=false 时明说"关"——数字照配着但 loop 不读它们，把它画成"续跑 8 轮"就是谎话。
 * 来源只在**非默认**时标注：全默认时"（默认）"一个词就够，逐字段标三遍是噪声。
 */
export function describeRecoveryPolicy(recovery) {
  if (!recovery) return null;
  if (!recovery.armed) return "恢复：关（完成门关闭，到轮数上限即停）";
  const src = (f) => (recovery.sources?.[f] === "env" ? "·env" : recovery.sources?.[f] === "pack" ? "·包" : "");
  const allDefault = ["progressExtensionTurns", "stagnationWindow", "maxStagnationRecoveries"]
    .every((f) => !src(f));
  return (
    `恢复：续跑 ${recovery.progressExtensionTurns} 轮${src("progressExtensionTurns")}` +
    ` · 停滞窗 ${recovery.stagnationWindow}${src("stagnationWindow")}` +
    ` · 换策略 ${recovery.maxStagnationRecoveries} 次${src("maxStagnationRecoveries")}` +
    (allDefault ? "（默认）" : "")
  );
}

/**
 * Context 面 = 水位口径 + 压缩事件。
 *
 * 水位分子是**最近一轮输入**而不是全 run 累计：ContextManager.noteUsage 是
 * 赋值不是累加（src/context.ts:56-61），按累计画会得到"永远即将压缩却永不
 * 压缩"的假警报。压缩单独成一个不可逆语域——被置换的 tool_result 原文
 * 永不可恢复，那不是又一条普通警告。
 */
export function deriveContextFace(state, harness) {
  const limit =
    state.runConfig?.guardrails?.contextTokenLimit ?? harness?.guardrails?.contextTokenLimit ?? null;
  const usage = deriveContextUsage(state, limit);
  const compactions = [...state.timeline, ...state.verifierTimeline]
    .filter((e) => e.type === "compaction")
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({
      seq: e.seq,
      source: e.source,
      droppedBlocks: e.droppedBlocks ?? 0,
      ledgerEntries: e.ledgerEntries ?? 0,
      summaryApplied: e.summaryApplied === true,
      collapsedTurns: e.collapsedTurns ?? 0,
      reactive: e.reactive === true,
    }));

  return {
    ...usage,
    watermark: harness?.compactWatermark ?? usage.watermark,
    nearWatermark: usage.ratio !== null && usage.ratio >= (harness?.compactWatermark ?? 0.8),
    compactions,
    droppedBlocks: compactions.reduce((n, c) => n + c.droppedBlocks, 0),
    ledgerEntries: compactions.reduce((n, c) => n + (c.ledgerEntries ?? 0), 0),
    summaryAppliedCount: compactions.reduce((n, c) => n + (c.summaryApplied ? 1 : 0), 0),
    // Phase C：旧轮折叠总数与反应式（撞 400 后）压缩次数——两者都比"置换了几个块"更该被看见
    collapsedTurns: compactions.reduce((n, c) => n + (c.collapsedTurns ?? 0), 0),
    reactiveCount: compactions.reduce((n, c) => n + (c.reactive ? 1 : 0), 0),
    perTurn: state.usageByTurn,
  };
}

/**
 * Tools 面：本次运行模型能做什么、实际做了什么、边界在哪。
 *
 * "改道"是 P5「错误进上下文，不炸循环」的可视化证据：工具失败之后模型换了
 * 工具或换了参数继续走，而不是循环崩掉。
 */
export function deriveToolsFace(state, harness) {
  const all = [...state.timeline, ...state.verifierTimeline].sort((a, b) => a.seq - b.seq);
  const stats = new Map();
  const bump = (name, key) => {
    if (!name) return;
    const s = stats.get(name) ?? { calls: 0, errors: 0 };
    s[key] += 1;
    stats.set(name, s);
  };

  const reroutes = [];
  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    if (e.type === "tool_call") bump(e.name, "calls");
    if (e.type === "tool_result") {
      const name = state.toolNames[e.toolUseId] ?? null;
      if (e.resultIsError) {
        bump(name, "errors");
        // 紧随其后的下一次工具调用即"改道"
        const next = all.slice(i + 1).find((x) => x.type === "tool_call");
        if (next) {
          reroutes.push({
            errorSeq: e.seq,
            failedTool: name,
            nextSeq: next.seq,
            nextTool: next.name,
            switched: next.name !== name,
          });
        }
      }
    }
  }

  const rc = state.runConfig;
  const declared = rc?.tools ?? harness?.tools ?? [];
  const tools = declared.map((t) => ({
    ...t,
    calls: stats.get(t.name)?.calls ?? 0,
    errors: stats.get(t.name)?.errors ?? 0,
  }));
  // 声明面之外被真实调用过的（MCP 未接入时可能出现），照实列出而不是隐藏
  for (const [name, s] of stats) {
    if (!declared.some((t) => t.name === name)) {
      tools.push({ name, permission: null, origin: "unknown", calls: s.calls, errors: s.errors });
    }
  }

  return {
    pack: rc?.pack ?? harness?.pack ?? null,
    shell: harness?.shell ?? null,
    executionIsolation: rc?.executionIsolation ?? harness?.executionIsolation ?? null,
    // 逐 run 可换工作目录，Tools 面必须报本 run 真正用的那个
    workdir: rc?.workdir ?? harness?.workdir ?? null,
    roleModels: rc?.roleModels ?? null,
    readRoots: harness?.readRoots ?? [],
    // 运行历史的真实落点是进程级装配（不逐 run 变），只来自宿主快照
    history: harness?.history ?? null,
    mcp: harness?.mcp ?? null,
    guardrails: rc?.guardrails ?? harness?.guardrails ?? null,
    tools,
    totalCalls: [...stats.values()].reduce((n, s) => n + s.calls, 0),
    totalErrors: [...stats.values()].reduce((n, s) => n + s.errors, 0),
    denials: state.pendingApprovals
      .filter((a) => a.status === "denied")
      .map((a) => ({ name: a.name, reason: a.reason ?? null })),
    reroutes,
  };
}

/**
 * 核查白名单的生效值与来源：逐 run 的 run_config 优先于进程级 `/api/harness`；两者都没报
 * （旧宿主）→ commands=null，调用方回落到 pack.verify.readOnlyCommands。
 * @returns {{commands: string[]|null, source: string|null}}
 */
function resolveEffectiveWhitelist(state, harness) {
  const rc = state.runConfig;
  if (rc && Array.isArray(rc.verifierReadOnlyCommands)) {
    return { commands: rc.verifierReadOnlyCommands, source: rc.verifierReadOnlySource ?? null };
  }
  if (harness && Array.isArray(harness.verifierReadOnlyCommands)) {
    return { commands: harness.verifierReadOnlyCommands.map(String), source: harness.verifierReadOnlySource ?? null };
  }
  return { commands: null, source: null };
}

/** 白名单来源的短标签（状态条 / Verification 面共用；pack 与未知不标——那是常态） */
export function whitelistSourceLabel(source) {
  if (source === "default") return "通用默认";
  if (source === "env") return "env";
  if (source === "none") return "包未声明";
  return "";
}

/**
 * Verification 面：三值裁决 + 三类饥饿告警。
 *
 * `pass_with_notes` 是刻意独立的一态：CLI 对 passed=true 但 issues 非空会
 * 降级为黄色 `⚠`（src/cli.ts:276），Web 此前一律红色。项目有两个真实案例
 * 是"通过但备注里藏着真 bug"，这一态不能被绿色吞掉。
 */
export function deriveVerificationFace(state, harness) {
  const v = state.verdict;
  const badge = !v
    ? "pending"
    : v.passed && v.issues.length > 0
      ? "pass_with_notes"
      : v.passed
        ? "pass"
        : "fail";

  const segments = deriveSegments(state);
  const runPack = state.runConfig?.pack ?? harness?.pack;
  // 生效白名单优先于包声明：无包运行拿的是通用缺省（run_config 报出来的才是核查者手里那份）
  const effective = resolveEffectiveWhitelist(state, harness);
  const whitelist = effective.commands ?? runPack?.verify?.readOnlyCommands ?? [];

  // ① 白名单饥饿：verifier 没有可用的只读命令，却确实撞上了审批门——案例 #4 的形态。
  //    注意判据不能看 pendingApprovals：verifier 的审批由 harness 内部自答，
  //    压根不进那个列表（applyApproval 直接把它扔进 verifierTimeline）。
  const verifierDenied = state.verifierTimeline.some((e) => e.type === "approval_request");
  // ② 空返工：被否触发的返工段里一次写类调用都没有，纯粹在重证明已为真的东西
  const emptyRework = segments
    .filter((s) => s.role === "rework")
    .filter((s) => !s.entries.some((e) => e.type === "tool_call" && WRITE_TOOLS.has(e.name)))
    .map((s) => s.round);
  // ③ 解析失败型：fail-closed 的第一种误伤形态
  const parseFail = Boolean(v && !v.passed && v.issues[0] === VERDICT_PARSE_FAIL);

  return {
    badge,
    verdict: v,
    rounds: state.verifications,
    finalPassed: state.runEnd?.finalPassed ?? (v ? v.passed : null),
    whitelist,
    // pack = 包声明；default = 无包通用缺省；env = AGENT_VERIFY_READONLY_COMMANDS；none = 包沉默；null = 旧宿主没报
    whitelistSource: effective.source,
    rubricSource: state.runConfig?.rubricSource ?? runPack?.verify?.rubricSource ?? null,
    // 逐 run 的 run_config 优先于进程级快照：编排下各子任务的包不同，
    // 核查预算也不同（9.1），读进程级会显示另一个包的数
    budgetTurns: state.runConfig?.verifierBudgetTurns ?? harness?.verifierBudgetTurns ?? null,
    budgetSource: state.runConfig?.verifierBudgetSource ?? harness?.verifierBudgetSource ?? null,
    starvation: {
      noWhitelist: whitelist.length === 0 && verifierDenied,
      emptyRework,
      parseFail,
    },
  };
}

// ================================================================
// 统一输入框（composer）：新建任务与追加指令共用同一个框
// ================================================================

/**
 * 一个框、四个模式。模式**只由"当前选中哪个运行"派生**。
 *
 * 为什么合并（委托方原话："追加指令和下方的输入框不能公用吗 为啥要分开"）：
 * 分开纯粹是实现遗留——底栏打 `POST /api/runs`（新建），详情里那个打
 * `POST /api/runs/:id/messages`（续跑）。对用户来说它们长得一样、位置也挨着，
 * 没有理由是两个框。
 *
 * 为什么模式由选中态派生、而不是加一个"新建/追加"切换器：切换器是第四个概念，
 * 要持久化、要和选中态同步，还会造出"切换器说新建、详情页却显示着某个运行"
 * 这种自相矛盾态。侧栏本来就有「+ 新建对话」，它天然就是"切回新建"的开关。
 *
 * **这笔交易的代价要认下来**：点开一个运行只是想读它，底栏却已经变成
 * "追加到这个运行"。所以模式必须**处处可见**——按钮文案、placeholder、
 * 说明行、`data-mode` 四处同时变，绝不静默。
 *
 * @param {{
 *   info?: {status?: string, canContinue?: boolean, continuationMode?: string, continuationBlockReason?: string|null, mode?: string, verify?: boolean, workdir?: string, runId?: string, archived?: boolean}|null,
 *   localStatus?: string|null,   // 本地 SSE 观测到的状态；见下方"默认值不是观测"
 *   submitting?: boolean,        // 提交在飞：服务端还没回、列表也还没更新
 *   error?: string|null,
 * }} input
 */
export function deriveComposerMode({ info, localStatus, submitting, error } = {}) {
  const base = {
    runId: info?.runId ?? null,
    workdir: info?.workdir ?? null,
    error: error ?? null,
    optionsEnabled: true,
    /**
     * 独立核查开关的逐模式契约（会话中心化：核查是**每一轮**的选项）。
     * 新建：用户自己的选择，不动；追加：缺省沿用该 run 上一轮的设置（defaultChecked），
     * 由 patchComposer 在**切到这个 run 时**套一次；运行中/提交中：禁用。
     */
    verifyToggle: { enabled: true, defaultChecked: null, label: "独立核查" },
  };

  // 提交在飞：服务端在 json(res) **之前**就广播了 run_created，于是列表先一步
  // 刷新、syncComposer 跟着跑一遍，按钮会被重新算成"可点"——用户第二下就建了
  // 第二个 run（新建路径没有 409 兜着）。所以 in-flight 必须是模式的一部分，
  // 不能用命令式的 btn.disabled=true 去和 patchComposer 抢同一个属性。
  if (submitting) {
    return {
      ...base,
      mode: "submitting",
      kind: null,
      buttonLabel: "提交中…",
      labelText: "任务描述",
      placeholder: "",
      note: "",
      canSubmit: false,
      optionsEnabled: false,
      verifyToggle: { ...base.verifyToggle, enabled: false },
    };
  }

  if (!info) {
    return {
      ...base,
      mode: "new",
      kind: "new",
      buttonLabel: "运行任务",
      labelText: "任务描述",
      placeholder: "输入新任务描述…（Ctrl+Enter 发送）",
      note: "",
      canSubmit: true,
    };
  }

  /**
   * "在跑"以**服务端列表**为准，本地状态只能把它往"结束"方向推，不能往
   * "在跑"方向推。
   *
   * 原因：`createInitialState` 把 status 初始化成 `"running"`——那是默认值，
   * **不是一次观测**。若拿它当"在跑"的证据，从侧栏点开一个早已结束的运行会
   * 走出 append → running → append 的抖动，中间还挂一句"运行进行中"的假话。
   * 反过来，本地已经收到 run_end 而列表还没刷新时，本地那一侧是真观测，
   * 应当立刻生效——所以是单向的。
   */
  const running = info.status === "running" && localStatus !== "done";
  if (running) {
    return {
      ...base,
      mode: "running",
      kind: "stop",
      /**
       * 运行中这个位置变成「停止」，而不是再加一个按钮。
       *
       * 理由是此刻它本来就没别的事可做（既不能新建也不能追加），
       * 空着一个灰按钮 + 旁边再摆一个停止键，是把一个位置的两种状态
       * 画成了两个控件。
       */
      buttonLabel: "停止",
      labelText: "任务描述",
      // 不禁用输入框：把"先把下一条想好"的能力也没收掉是过度反应
      placeholder: "运行进行中，可以先把下一条指令打好…",
      note: "运行进行中，等这一轮结束后可以追加指令；要现在开新任务请点左侧「+ 新建对话」。按「停止」会让它在下一次模型调用之前收手。",
      canSubmit: true,
      optionsEnabled: false,
      verifyToggle: { ...base.verifyToggle, enabled: false },
    };
  }

  if (info.canContinue) {
    // 追加轮的核查开关：缺省沿用该 run 上一轮的设置，可逐轮改（会话中心化）
    const verifyToggle = { enabled: true, defaultChecked: Boolean(info.verify), label: "本轮独立核查" };
    // 这一轮接的是什么，要让人看得见：有正史续正史；plan 以计划摘要开局；否则从头
    const lineage =
      info.mode === "plan"
        ? "此前是计划编排：本轮以计划摘要为背景、按单执行者继续（续的是对话，不是重跑 DAG）。"
        : "";
    if (info.continuationMode === "same-run") {
      return {
        ...base,
        mode: "same-run",
        kind: "append",
        buttonLabel: "同运行恢复",
        labelText: "恢复指令",
        placeholder: "从检查点在同一运行上继续…（Ctrl+Enter 发送）",
        note:
          "将在同一 runId 上从最后提交的检查点续跑：会话正史与总预算延续；不恢复原进程的审批放行与在飞工具。" +
          (info.durablePhase ? ` 崩溃相：${info.durablePhase}。` : ""),
        canSubmit: true,
        optionsEnabled: false,
        verifyToggle,
      };
    }
    if (info.continuationMode === "fork") {
      return {
        ...base,
        mode: "fork",
        kind: "append",
        buttonLabel: "从归档继续",
        labelText: "续跑指令",
        placeholder: "从归档派生新运行继续…（Ctrl+Enter 发送）",
        note:
          "将从归档派生新运行：有检查点则会话正史与总预算继续累计，没有则从头开一轮；模型、工具和策略使用当前宿主，父归档保持只读。" +
          lineage,
        canSubmit: true,
        optionsEnabled: false,
        verifyToggle,
      };
    }
    return {
      ...base,
      mode: "append",
      kind: "append",
      buttonLabel: "继续对话",
      labelText: "追加指令",
      placeholder: "追加一条指令，接着这次会话继续…（Ctrl+Enter 发送）",
      // 轮次预算每轮重新起算，不说清楚用户会以为 maxTurns 是整场对话的总额。
      // 裁决只对它核查的那一轮负责——续跑不会抹掉它，也不会让它替新一轮担保
      note:
        "续跑复用这次运行的装配（包 / 思考预算 / 工作目录）；是否核查按本轮开关；已出具的裁决留在对话里、只对它核查的那一轮负责。单段轮次预算每轮重新起算，总轮次 / token 预算沿执行谱系累计。" +
        lineage,
      canSubmit: true,
      // 装配项在续跑里**构造上无效**：续跑只取正史与检查点，pack/effort/workdir/
      // mode/rubric 一个都不读——唯一逐轮可改的是核查开关（单列在 verifyToggle）
      optionsEnabled: false,
      verifyToggle,
    };
  }

  /**
   * 选中了运行、却不能追加。**绝不静默回落成新建**——那才是这次合并最容易
   * 埋的雷：用户以为在续跑，实际另起了一次运行。原因照实写出来，
   * 并且明说"提交将新建一次运行"。
   */
  return {
    ...base,
    mode: "new-blocked",
    kind: "new",
    buttonLabel: "运行任务",
    labelText: "任务描述",
    placeholder: "输入新任务描述…（Ctrl+Enter 发送）",
    note: `${blockedReason(info)}提交将新建一次运行。`,
    canSubmit: true,
    // 不能追加 = 这一提交是新建，装配当然有效
    optionsEnabled: true,
  };
}

/**
 * 不能追加的原因（V-28：不能只是"没有输入框"，要说为什么）。
 *
 * 会话中心化之后这里只剩两类：服务端按当前边界算出的阻断理由（活 run 唯一的是
 * 执行谱系预算耗尽——文案里带 env 名与提法；归档还有包不存在 / 目录越权），
 * 以及"服务端没给理由"的兜底。核查 / 编排 / 执行失败**不再是**理由：
 * 旧文案「追加会绕过已出具的裁决」「没有续跑入口」「没有可续跑的会话正史」已退役，
 * 裁决现在带轮号留在对话里、只对它核查的那一轮负责。
 */
function blockedReason(info) {
  if (info.continuationBlockReason) {
    return `${info.archived ? "这是只读归档，当前不能派生续跑：" : ""}${info.continuationBlockReason}。`;
  }
  if (info.archived) {
    return "这是只读归档，当前不能派生续跑（服务端未给出原因）。";
  }
  return "这次运行当前不能追加（服务端未给出原因）。";
}

/**
 * 追加一轮的网络载荷（纯函数，与 buildNewRunRequest 同规格）。
 * verify 是**本轮**的核查开关；未给时不发字段，服务端沿用该 run 上一轮的设置。
 */
export function buildFollowUpRequest({ text, verify }) {
  return {
    text: String(text ?? ""),
    ...(typeof verify === "boolean" ? { verify } : {}),
  };
}

/**
 * 提交意图。纯函数——路由决策与 DOM、网络无关，所以它可测。
 * @returns {{kind:"new"|"append", runId:string|null, text:string}|null} null = 不该提交
 */
export function composerSubmitPlan(mode, rawText) {
  if (!mode || !mode.canSubmit || !mode.kind) return null;
  // 停止不需要文本——框里那半截草稿是给下一轮准备的，不该拦着人叫停
  if (mode.kind === "stop") return { kind: "stop", runId: mode.runId, text: "" };
  const text = String(rawText ?? "").trim();
  if (!text) return null;
  return { kind: mode.kind, runId: mode.runId, text };
}

/**
 * 新建运行的网络载荷。保持为纯函数，避免某个 UI 开关只在特定分支里“看起来接上”。
 * `askUser` 是执行方式，不是 plan 专属能力：single 任务遇到地点、环境或交付边界
 * 不明确时同样需要先问人。
 */
export function buildNewRunRequest({
  task,
  verify = false,
  pack,
  effort,
  rubric,
  mode = "single",
  concurrency,
  planGate = false,
  askUser = false,
  workdir,
  useVerifierModel = true,
  usePlannerModel = true,
} = {}) {
  const trimmedRubric = String(rubric ?? "").trim();
  return {
    task: String(task ?? ""),
    verify: Boolean(verify),
    ...(pack ? { pack } : {}),
    ...(effort ? { effort } : {}),
    ...(trimmedRubric ? { rubric: trimmedRubric } : {}),
    ...(mode === "plan"
      ? {
          mode: "plan",
          ...(concurrency ? { concurrency } : {}),
          ...(planGate ? { planGate: true } : {}),
        }
      : {}),
    ...(askUser ? { askUser: true } : {}),
    ...(workdir ? { workdir } : {}),
    // 与宿主既有契约一致：角色模型默认启用，只有显式关闭才传 false。
    ...(!useVerifierModel ? { useVerifierModel: false } : {}),
    ...(!usePlannerModel ? { usePlannerModel: false } : {}),
  };
}

/**
 * 把 archived follow-up 的 HTTP 响应并入列表。纯函数的目的不是“少写几行 DOM”，
 * 而是锁住两个竞态不变量：父归档绝不改成 running；生命周期 SSE 若已把极短的
 * 子 run 推到 done，较旧的 HTTP running 快照不能让它倒退。
 *
 * @returns {{targetRunId:string, summary:object, runs:object[]}|null} null = 同 run 续跑
 */
export function mergeForkedFollowUp(runList, parentRunId, payload, feedback, now = Date.now()) {
  const targetRunId = typeof payload?.runId === "string" ? payload.runId : parentRunId;
  if (targetRunId === parentRunId) return null;

  const existingIndex = runList.findIndex((run) => run.runId === targetRunId);
  const existing = existingIndex >= 0 ? runList[existingIndex] : null;
  const parent = runList.find((run) => run.runId === parentRunId);
  const incoming = payload?.run && typeof payload.run === "object"
    ? payload.run
    : {
        runId: targetRunId,
        task: parent?.task ?? feedback,
        status: "running",
        verify: false,
        createdAt: now,
        finishedAt: null,
        continuedFrom: parentRunId,
      };
  const summary = existing?.status === "done"
    ? { ...incoming, ...existing }
    : { ...(existing ?? {}), ...incoming };
  const runs = [...runList];
  if (existingIndex >= 0) runs[existingIndex] = summary;
  else runs.unshift(summary);
  return { targetRunId, summary, runs };
}

/**
 * 把模式应用到底栏 DOM。**这里一行 addEventListener 都没有**——
 * 监听只在启动时由 `bindComposer` 绑一次。合并把输入框从"每次重建"变成
 * "永久存在"，重复绑定从不可能变成一步之遥，所以用职责切分把它堵死。
 */
export function patchComposer(mode, root = document) {
  const q = (sel) => root.querySelector(sel);
  const form = q("#submit-form");
  const btn = q("#submit-btn");
  const btnLabel = q("#submit-btn-label");
  const btnIcon = btn?.querySelector?.("i");
  const input = q("#task-input");
  const label = q('label[for="task-input"]');
  const modeLabel = q("#composer-mode-label");
  const note = q("#composer-note");
  const err = q("#submit-error");

  if (form) setAttr(form, "data-mode", mode.mode);
  if (btn) {
    setText(btnLabel ?? btn, mode.buttonLabel);
    setAttr(btn, "disabled", mode.canSubmit ? null : "");
  }
  if (btnIcon) {
    const icon = mode.mode === "running"
      ? "ph-stop"
      : mode.mode === "submitting"
        ? "ph-spinner-gap"
        : "ph-paper-plane-right";
    btnIcon.className = `ph ${icon}${mode.mode === "submitting" ? " is-spinning" : ""}`;
  }
  if (modeLabel) {
    const text = {
      new: "新建对话",
      append: "继续当前对话",
      fork: "从归档派生续跑",
      "same-run": "同运行热恢复",
      running: "任务运行中",
      submitting: "正在创建",
      "new-blocked": "另建新对话",
    }[mode.mode] ?? "新建对话";
    setText(modeLabel, text);
  }
  if (label) setText(label, mode.labelText);
  if (input) {
    setAttr(input, "placeholder", mode.placeholder);
    // 说明行不是 live region，靠 aria-describedby 在聚焦输入框时被读到——
    // disabled 的按钮不可聚焦，读屏用户否则无从得知它为什么是死的
    setAttr(input, "aria-describedby", mode.note ? "composer-note" : null);
  }
  if (note) {
    setText(note, mode.note);
    setAttr(note, "hidden", mode.note ? null : "");
  }
  if (err) {
    setText(err, mode.error ?? "");
    setAttr(err, "hidden", mode.error ? null : "");
  }

  /**
   * 装配项（独立核查 / 装配面板里的每一项）跟着模式禁用，**但不隐藏**——
   * 沿用本仓已有的纪律（见 index.html 并行度那处注释）：让"这个旋钮属于哪个
   * 模式"这件事本身可见。
   *
   * 两条刻意的例外：
   * ① 不动 `#run-knobs.hidden`：面板开合是用户状态、只有点击处理器一个写入方。
   *    让后台事件（run 收尾 → loadRuns → syncComposer）去强行折叠它，会把焦点
   *    正在 `#rubric-input` 里的用户直接踢回 body。
   * ② 不改 checkbox 的 checked：这一组在续跑里根本不进请求体，清掉反而毁了
   *    用户为下一次新建准备好的设置。禁用 + 一句说明比篡改用户的值诚实。
   */
  const knobs = [
    ...(q("#composer-scopebar")
      ? q("#composer-scopebar").querySelectorAll("input, select")
      : []),
    ...(q("#run-knobs") ? q("#run-knobs").querySelectorAll("input, select, textarea, button") : []),
  ].filter(Boolean);
  const active = root.activeElement ?? document.activeElement;
  for (const el of knobs) {
    const fixed = el.getAttribute?.("data-fixed") === "true";
    setAttr(el, "disabled", mode.optionsEnabled && !fixed ? null : "");
  }
  // 禁用一个正被聚焦的控件会让焦点掉回 body（后续按键全丢）。把它交还给输入框。
  if (!mode.optionsEnabled && active && knobs.includes(active) && input?.focus) input.focus();

  /**
   * 独立核查开关单独走（会话中心化：核查是每一轮的选项，追加轮它**进请求体**）。
   * 缺省值只在**切到另一个 run 的追加模式时**套一次（data-verify-run 记着已经套过
   * 哪个 run），之后由用户随意改——每次 syncComposer 都重套会把用户刚拨的开关拨回去。
   * 回到新建模式时清掉记号，下次再选中同一个 run 会重新套它上一轮的设置。
   */
  const verify = q("#verify-toggle");
  const toggle = mode.verifyToggle ?? { enabled: mode.optionsEnabled, defaultChecked: null, label: "独立核查" };
  if (verify) {
    setAttr(verify, "disabled", toggle.enabled ? null : "");
    if (mode.kind === "append" && mode.runId && toggle.defaultChecked !== null) {
      if (form?.dataset.verifyRun !== mode.runId) {
        verify.checked = Boolean(toggle.defaultChecked);
        if (form) form.dataset.verifyRun = mode.runId;
      }
    } else if (mode.kind === "new" && form?.dataset.verifyRun) {
      delete form.dataset.verifyRun;
    }
    const caption = verify.closest?.("label")?.querySelector?.("span");
    if (caption) setText(caption, toggle.label);
    if (!toggle.enabled && active === verify && input?.focus) input.focus();
  }
}

/**
 * 传输层断了，还是服务端正常收流了？
 *
 * 委托方截图里，一个状态是**已完成**的运行顶上挂着「连接中断，正在重连…」。
 * 根因是 EventSource 这一层**分辨不了**这两件事：服务端推完 run_end 就
 * `res.end()`，浏览器收到 FIN 派发的同样是 `error`、readyState 同样是
 * CONNECTING。而 run_end 那条 message 还在 batcher 队列里（一帧之后才 flush），
 * 所以顺序被结构性地固定成"先 error 挂横幅、后 flush 才 close"——前端永远
 * 抢不到前面。**必现，不是竞态。**
 *
 * 既然传输层分不了，就用 harness 事实去分：两边任一说这个 run 已经结束，
 * 就不是断线。（从侧栏点开一条历史运行同样走这条路——那时本地状态还是
 * `createInitialState` 的默认 "running"，只有服务端列表说得出真话。）
 */
export function shouldShowReconnecting({ info, localStatus } = {}) {
  if (localStatus === "done") return false;
  if (info && info.status === "done") return false;
  return true;
}

/**
 * 需要人介入的事项——ActionRail 的唯一数据源。
 *
 * unverified 只在这里出现一次；裁决卡里的同一批是详情下钻，不是第二份清单
 * （V-16：此前概览的"裁决卡"与"需介入事项"把它列了两遍）。
 */
export function deriveActionState(state) {
  const pending = state.pendingApprovals.filter((a) => a.status === "pending");
  const unverified = state.verdict ? state.verdict.unverified : [];
  // 计划确认门（§5.1）：签字位也是"需你决定"，而且是最靠前的那一件——
  // 它挂起时一个子任务都还没发射，此刻的决定成本最低
  const planPending = state.planApproval?.status === "pending";
  /**
   * §5.2 提问同属"需你现在决定"，而且是**阻塞式**的——执行协程正吊在
   * ask_user 的 execute 里等这一下。不进 needsAttention 就等于整个运行卡死
   * 而界面上什么都没有（V-01/V-05 那一族）。
   */
  const questionPending = state.question?.status === "pending";
  const blockers = Array.isArray(state.completion?.blockers) ? state.completion.blockers : [];
  return {
    pendingApprovals: pending,
    unverifiedItems: unverified,
    planApproval: state.planApproval ?? null,
    awaitingPlan: planPending,
    question: state.question ?? null,
    awaitingQuestion: questionPending,
    blockers,
    needsAttention:
      planPending || questionPending || pending.length > 0 || unverified.length > 0 || blockers.length > 0,
  };
}

// ---------------------------------------------------------------
// 阶段二 新增：概览模型 (R-03)
// ---------------------------------------------------------------

/**
 * 从 RunState 派生出概览模型——无需展开日志即可判断任务成败与下一步。
 * @param {RunState} state
 * @returns {OverviewModel}
 */
export function deriveOverview(state) {
  // 结果摘要：时间线中最后一条 assistant_text
  const lastAssistant = [...state.timeline].reverse().find(
    (e) => e.type === "assistant_text",
  );

  // 待介入事项
  const pendingApprovals = state.pendingApprovals.filter(
    (a) => a.status === "pending",
  );
  // 已处理审批（allow/deny/expired）：保留为只读记录，不得静默丢失
  const resolvedApprovals = state.pendingApprovals.filter(
    (a) => a.status !== "pending",
  );
  const unverifiedItems = state.verdict ? state.verdict.unverified : [];
  const blockers = Array.isArray(state.completion?.blockers) ? state.completion.blockers : [];

  return {
    finalStatus: state.error ? "error" : state.status,
    resultSummary: state.completion?.summary ?? (lastAssistant ? lastAssistant.text ?? null : null),
    completion: state.completion,
    verdict: state.verdict,
    actionItems: {
      pendingApprovals,
      unverifiedItems,
      blockers,
    },
    resolvedApprovals,
    usage: state.usage,
  };
}

// ---------------------------------------------------------------
// 阶段二 新增：日志分层 (R-04)
// ---------------------------------------------------------------

/**
 * 合并主 timeline 与核查 timeline，为每条添加折叠状态。
 * 规则：
 *   - 成功 tool_result、tool_call、turn_start、assistant_text → collapsed=true
 *   - 失败 tool_result (resultIsError)、approval_request、api_retry、compaction → collapsed=false
 * @param {RunState} state
 * @returns {LogEntry[]}
 */
export function deriveLogEntries(state) {
  const all = [...state.timeline, ...state.verifierTimeline].sort(
    (a, b) => a.seq - b.seq,
  );
  return all.map((e) => ({
    ...e,
    // V-12：tool_result 事件本身不带 name（src/loop.ts:259-264），此前界面直接
    // 显示 `toolu_01AbC… 成功`。在派生层按 toolUseId 回填，渲染层不必知道这件事。
    ...(e.type === "tool_result" && !e.name && state.toolNames[e.toolUseId]
      ? { name: state.toolNames[e.toolUseId] }
      : {}),
    collapsed: defaultCollapsed(e),
  }));
}

/**
 * 判断单条时间线条目默认是否折叠。
 * @param {TimelineEntry} entry
 * @returns {boolean}
 */
function defaultCollapsed(entry) {
  // 失败结果 → 展开
  if (entry.type === "tool_result" && entry.resultIsError) return false;
  // 审批请求 → 展开
  if (entry.type === "approval_request") return false;
  // API 重试 → 展开
  if (entry.type === "api_retry") return false;
  // 换端点 → 展开：这一行解释了后面所有轮次是谁应答的，折起来等于藏了变量
  if (entry.type === "model_fallback") return false;
  if (entry.type === "segment_resume") return false;
  if (entry.type === "recovery_decision") return false;
  if (entry.type === "run_forked") return false;
  if (entry.type === "run_resumed") return false;
  // 上下文压缩 → 展开
  if (entry.type === "compaction") return false;
  // 其余（turn_start、tool_call、成功 tool_result、assistant_text）→ 折叠
  return true;
}

/**
 * 切换指定 seq 日志条目的折叠状态。
 * @param {LogEntry[]} entries
 * @param {number} seq
 * @returns {LogEntry[]}
 */
export function toggleEntryCollapsed(entries, seq) {
  return entries.map((e) =>
    e.seq === seq ? { ...e, collapsed: !e.collapsed } : e,
  );
}

/**
 * 把"用户手动展开/折叠过哪些条"的覆盖表贴到派生条目上。
 * 覆盖表里没有的条，走 deriveLogEntries 给的默认（成功折叠、异常展开）。
 */
export function applyCollapseOverrides(entries, overrides) {
  if (!overrides || overrides.size === 0) return entries;
  return entries.map((e) => (overrides.has(e.seq) ? { ...e, collapsed: overrides.get(e.seq) } : e));
}

/**
 * 点一下之后，这一条的覆盖值该写成什么。
 *
 * **必须先把默认值算进来再翻**。宿主此前直接对覆盖表取反，而表里没有这一条时
 * 取反得到 true——可多数条目（tool_call、成功的 tool_result、assistant_text、
 * turn_start）默认就是 `collapsed: true`。于是**第一次点击把 true 写成 true**：
 * 状态没变、DOM 早退、屏幕上一点反应都没有，要点第二下才展开。
 * AC-04 说的"两次操作可达原始详情"实际是三次，且第一次零反馈。
 *
 * 这个 bug 能活下来，是因为宿主自己另写了一套 toggle，而被测的
 * `toggleEntryCollapsed` **全仓零调用**——测试测的是产品不用的那份实现。
 * 所以这里把"算默认 → 翻转"整条做成纯函数，宿主只许调它。
 *
 * @returns {boolean|null} 该写进覆盖表的值；seq 不存在时返回 null
 */
export function nextCollapseOverride(entries, overrides, seq) {
  const hit = toggleEntryCollapsed(applyCollapseOverrides(entries, overrides), seq).find(
    (e) => e.seq === seq,
  );
  return hit ? hit.collapsed : null;
}

// ---------------------------------------------------------------
// 阶段二 新增：运行列表元数据与筛选 (R-08)
// ---------------------------------------------------------------

/**
 * 从 runs 列表和 runStates 派生每条运行的列表展示元数据。
 * @param {{runId:string, task:string, status:string, verify:boolean, createdAt:number, finishedAt:number|null}[]} runs
 * @param {Map<string, RunState>} runStates
 * @returns {Map<string, RunListItemMeta>}
 */
/**
 * 会话标题：从任务文本里**算**一个短标题出来。
 *
 * 侧栏此前直接铺任务原文，一条几百字的任务描述会占掉三四行、还看不出是什么
 * （委托方截图里第一条就是 `附件：uploads/65a53cbdab081af8413977836a52f10b.jpg…`）。
 *
 * **为什么不让模型生成标题**：那是每次运行多付一次调用，而任务的第一句
 * 本来就是人自己写的概括。花钱买一个它已经知道的答案，不合算——
 * 真需要更好的标题时，人可以自己改第一句。
 *
 * 只上传附件、没写文字时特殊处理：拿文件名当标题，
 * 因为 `附件：uploads/<32 位哈希>.jpg` 里唯一有信息量的就是那个扩展名与前几位。
 */
export function deriveRunTitle(task, max = 24) {
  const raw = String(task ?? "").trim();
  if (!raw) return "未命名任务";

  const lines = raw.split(NEWLINE_RE).map((l) => l.trim()).filter(Boolean);
  // 优先取第一条**不是附件行**的内容——附件是补充材料，不是任务本身
  const meaningful = lines.find((l) => !ATTACH_RE.test(l));
  if (!meaningful) {
    const m = ATTACH_CAPTURE_RE.exec(lines[0] ?? "");
    const file = (m?.[1] ?? "").split(PATH_SEP_RE).pop() ?? "";
    return file ? `附件 ${clip(file, max)}` : "附件";
  }

  // 去掉 Markdown 的行首记法：标题/列表/引用符号本身不是标题内容
  const cleaned = meaningful
    .replace(HEADING_RE, "")
    .replace(BULLET_RE, "")
    .replace(ORDERED_RE, "")
    .replace(QUOTE_RE, "")
    .replace(SPACES_RE, " ")
    .trim();
  return clip(cleaned, max) || "未命名任务";
}

const NEWLINE_RE = /\r?\n/;
const ATTACH_RE = /^附件[：:]/;
const ATTACH_CAPTURE_RE = /^附件[：:]\s*(.+)$/;
const PATH_SEP_RE = /[\\/]/;
const HEADING_RE = /^#{1,6}\s*/;
const BULLET_RE = /^[-*+]\s+/;
const ORDERED_RE = /^\d+[.)]\s+/;
const QUOTE_RE = /^(?:&gt;|>)\s*/;
const SPACES_RE = /\s+/g;

/** 截断到 max 字并补省略号；刚好放得下就不补 */
function clip(text, max) {
  const t = String(text ?? "").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

export function deriveRunListItems(runs, runStates, unread) {
  /** @type {Map<string, RunListItemMeta>} */
  const map = new Map();
  for (const r of runs) {
    const state = runStates.get(r.runId);
    const duration = r.finishedAt ? r.finishedAt - r.createdAt : null;
    let verdictConclusion = null;
    if (state && state.verdict) {
      verdictConclusion = state.verdict.passed ? "passed" : "failed";
    } else if (state && state.verify && state.status !== "done") {
      verdictConclusion = "pending";
    }
    map.set(r.runId, {
      status: r.status,
      startTime: r.createdAt,
      duration,
      verdictConclusion,
      /**
       * 跑完了但你还没看过。
       *
       * 取代那条横贯整屏的「■ 已完成」——"这次结束了"是**列表**该说的事
       * （你可能同时开着好几个运行、正在别处忙），不是详情页该占一整行去说的事。
       * 判据由宿主维护：run 收尾时若它不是当前选中的那个就记上，选中即清。
       */
      unread: Boolean(unread && unread.has(r.runId)),
    });
  }
  return map;
}

/**
 * 按状态筛选运行列表。
 * @param {{runId:string, task:string, status:string, verify:boolean, createdAt:number, finishedAt:number|null}[]} runs
 * @param {Map<string, RunState>} states
 * @param {"all"|"running"|"done"|"failed"} filter
 * @returns {typeof runs}
 */
export function filterRunsByStatus(runs, states, filter) {
  if (filter === "all") return runs;
  return runs.filter((r) => {
    if (filter === "running") return r.status === "running";
    if (filter === "done") {
      // "已完成"：status=done 且（无核查 或 核查通过）
      const s = states.get(r.runId);
      if (r.status !== "done") return false;
      if (s && s.verdict && !s.verdict.passed) return false;
      return true;
    }
    if (filter === "failed") {
      const s = states.get(r.runId);
      return !!(s && s.verdict && !s.verdict.passed);
    }
    return true;
  });
}

/**
 * 按任务描述搜索运行。
 *
 * 只匹配 task 字段：runId 是 UUID，用户不会记；状态已有独立筛选器。
 * 大小写与首尾空白无关；空查询原样返回，不做任何过滤。
 * @param {{runId:string, task:string}[]} runs
 * @param {string} query
 */
export function filterRunsByQuery(runs, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return runs;
  return runs.filter((r) => String(r.task ?? "").toLowerCase().includes(q));
}

// ---------------------------------------------------------------
// 阶段二 新增：日志条目默认展开/折叠状态查询
// ---------------------------------------------------------------

/**
 * 查询摘要卡默认折叠状态——导出供渲染层和测试使用。
 * @param {TimelineEntry} entry
 * @returns {boolean}
 */
export function isEntryCollapsedByDefault(entry) {
  return defaultCollapsed(entry);
}

// ---------------------------------------------------------------
// 渲染辅助：标记审批已处理（由 DOM 层在 POST 应答成功后调用）
// ---------------------------------------------------------------

/**
 * 标记审批卡为已处理（allow/deny 应答后）。
 * @param {RunState} state
 * @param {string} toolUseId
 * @param {"allowed"|"denied"} decision
 * @param {string} [reason]
 * @returns {RunState}
 */
export function markApprovalResolved(state, ref, decision, reason) {
  // V-03：旧实现按 toolUseId 全量匹配，返工轮复用同一 id 时一次点击会连历史卡
  // 一起改写。改为：带 `#seq` 走精确匹配；裸 id 只命中最新的那张挂起卡。
  const target = findApprovalIndex(state.pendingApprovals, ref);
  if (target < 0) return state;
  return {
    ...state,
    pendingApprovals: state.pendingApprovals.map((a, i) =>
      i === target ? { ...a, status: decision, reason, decidedAt: Date.now() } : a,
    ),
  };
}

/** 解析审批引用（approvalId 或裸 toolUseId）到下标；裸 id 取最新的挂起项 */
function findApprovalIndex(approvals, ref) {
  if (typeof ref === "string" && ref.includes("#")) {
    return approvals.findIndex((a) => a.approvalId === ref);
  }
  let best = -1;
  for (let i = 0; i < approvals.length; i++) {
    const a = approvals[i];
    if (a.toolUseId !== ref) continue;
    if (best < 0 || a.status === "pending") best = i;
  }
  return best;
}

/**
 * 将 run 中所有 pending 审批转为 expired（run 结束/出错时由前端主动同步调用）。
 * @param {RunState} state
 * @returns {RunState}
 */
export function expirePendingApprovals(state) {
  return {
    ...state,
    pendingApprovals: state.pendingApprovals.map((a) =>
      a.status === "pending" ? { ...a, status: /** @type {"expired"} */ ("expired") } : a,
    ),
  };
}

// ---------------------------------------------------------------
// DOM 渲染（仅浏览器环境调用——惰性引用 window/document）
// ---------------------------------------------------------------

/**
 * 渲染运行列表侧栏。
 * @param {{runId:string, task:string, status:string, verify:boolean, createdAt:number, finishedAt:number|null}[]} runs
 * @param {string|null} selectedRunId
 * @param {(runId:string)=>void} onSelect
 * @param {Map<string, import('./app.js').RunListItemMeta>} [metaMap]
 */
export function renderRunList(runs, selectedRunId, onSelect, metaMap) {
  const listEl = document.getElementById("run-list");
  if (!listEl) return;
  if (runs.length === 0) {
    // 空态不得挂 role=listbox：listbox 必须含 option 子项（aria-required-children），
    // 空壳 listbox 是 critical 违规。role 与内容同生共死。
    listEl.removeAttribute("role");
    listEl.removeAttribute("aria-label");
    listEl.innerHTML = '<div class="run-list-empty">尚无运行。</div>';
    return;
  }
  // 有 option 子项时才挂 listbox 身份
  listEl.setAttribute("role", "listbox");
  listEl.setAttribute("aria-label", "项目与对话");
  // 空态留下的占位节点不属于 patchList 管辖，先清掉
  const placeholder = listEl.querySelector(".run-list-empty");
  if (placeholder) placeholder.remove();

  // V-32/R6：始终按工作目录分组。此前只有一个目录时自动摊平，但这会让
  // 同一套侧栏在「一个项目」与「两个项目」之间突然变结构，也把最重要的
  // 工具圈禁边界藏掉。项目 → 对话现在是稳定的信息架构，不随数量漂移。
  const groups = groupRunsByWorkdir(runs);

  // 分组时用 listbox > group > option（ARIA 1.2 允许的结构）。
  patchList(listEl, groups, {
    key: (g) => g.key,
    create: (g) => {
      const box = document.createElement("div");
      box.className = "run-group";
      box.setAttribute("role", "group");
      box.setAttribute("aria-label", g.label);
      box.innerHTML =
        '<div class="run-group-label">' +
        '<span class="run-group-identity"><i class="ph ph-folder-simple" aria-hidden="true"></i><span class="run-group-name"></span></span>' +
        '<span class="run-group-count"></span>' +
        '</div><div class="run-group-items"></div>';
      patchRunGroupHeader(box, g);
      patchRunItems(box.querySelector(".run-group-items"), g.runs, metaMap, selectedRunId, onSelect);
      return box;
    },
    update: (box, g) => {
      patchRunGroupHeader(box, g);
      patchRunItems(box.querySelector(".run-group-items"), g.runs, metaMap, selectedRunId, onSelect);
    },
  });
}

function patchRunGroupHeader(box, group) {
  const label = box.querySelector(".run-group-label");
  setText(box.querySelector(".run-group-name"), group.label);
  setText(box.querySelector(".run-group-count"), String(group.runs.length));
  setAttr(label, "title", group.key === "(default)" ? "默认工作目录" : group.key);
}

/**
 * 按工作目录分组。workdir 是工具的写入圈禁边界——"这段工作触碰的范围"，
 * 所以它是这个 harness 自己长出来的分组键，而不是从别家侧栏照搬的层级。
 * 分组前后保持原有顺序（服务端已按 createdAt 降序）。
 * @returns {{key:string,label:string,runs:any[]}[]}
 */
export function groupRunsByWorkdir(runs) {
  const byDir = new Map();
  for (const r of runs) {
    const dir = r.workdir ?? "";
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(r);
  }
  return [...byDir.entries()].map(([dir, list]) => ({
    key: dir || "(default)",
    // 标签只取末段：完整绝对路径在窄侧栏里会挤掉一切，完整值在 Tools 面有
    // 两种分隔符都要切：这个宿主主要跑在 Windows 上（反斜杠），但路径也可能
    // 是 posix 风格。只切 `/` 的话 Windows 路径切不开，组名会变成整条绝对路径
    label: dir ? dir.split(/[\\/]/).filter(Boolean).pop() ?? dir : "（默认工作目录）",
    runs: list,
  }));
}

function patchRunItems(host, runs, metaMap, selectedRunId, onSelect) {
  patchList(host, runs, {
    key: (r) => r.runId,
    create: (r) => {
      const el = document.createElement("div");
      el.className = "run-item";
      el.setAttribute("role", "option");
      el.setAttribute("tabindex", "0");
      el.setAttribute("data-run-id", r.runId);
      el.innerHTML =
        '<div class="run-item-status">' +
        '<span class="status-dot"></span>' +
        // 未读星：跑完了但还没看过。放在状态行最前，扫一眼列表就知道哪条有新结果
        '<span class="run-item-unread" hidden aria-label="已完成，尚未查看"><i class="ph ph-sparkle" aria-hidden="true"></i></span>' +
        '<span class="verify-badge" hidden>核查</span>' +
        '<span class="run-item-verdict" hidden></span>' +
        '<span class="run-item-state-label"></span>' +
        "</div>" +
        '<div class="run-item-task"></div>' +
        '<div class="run-item-meta">' +
        '<span class="run-item-turns"></span>' +
        '<span class="run-item-time"></span>' +
        '<span class="run-item-duration"></span>' +
        "</div>";
      el.addEventListener("click", () => onSelect(r.runId));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(r.runId);
        }
      });
      updateRunItem(el, r, metaMap, selectedRunId);
      return el;
    },
    update: (el, r) => updateRunItem(el, r, metaMap, selectedRunId),
  });
}

/** 就地更新一个运行项的可变部分（不碰节点本身） */
function updateRunItem(el, r, metaMap, selectedRunId) {
  const meta = metaMap ? metaMap.get(r.runId) : null;
  const isSelected = r.runId === selectedRunId;

  setClass(el, "run-item--selected", isSelected);
  setAttr(el, "aria-selected", String(isSelected));

  setClass(el.querySelector(".status-dot"), "status-dot--live", r.status === "running");

  // 未读星只在"没被选中 且 标记未读"时亮——选中即视为看过
  const unreadEl = el.querySelector(".run-item-unread");
  setAttr(unreadEl, "hidden", meta && meta.unread && !isSelected ? null : "");
  setClass(el, "run-item--unread", Boolean(meta && meta.unread && !isSelected));

  const verifyBadge = el.querySelector(".verify-badge");
  setAttr(verifyBadge, "hidden", r.verify ? null : "");

  const verdictEl = el.querySelector(".run-item-verdict");
  const conclusion = meta ? meta.verdictConclusion : null;
  const marks = { passed: "ph-check", failed: "ph-x", pending: "ph-dots-three" };
  if (conclusion && marks[conclusion]) {
    setAttr(verdictEl, "hidden", null);
    verdictEl.innerHTML = `<i class="ph ${marks[conclusion]}" aria-hidden="true"></i>`;
    // 裁决只对它核查的那一轮负责：列表列的裁决若不是最近一轮出的，标出轮号
    // ——"第 1 轮通过、第 3 轮没核查"不能被读成"这场对话通过了"
    const judged = Number(r.verdictTurn);
    const turns = Number(r.conversationTurn ?? 1);
    const stale = Number.isFinite(judged) && judged > 0 && judged < turns;
    const base = conclusion === "passed" ? "核查通过" : conclusion === "failed" ? "核查未通过" : "等待核查";
    setAttr(verdictEl, "aria-label", stale ? `${base}（判第 ${judged} 轮，此后未再核查）` : base);
    setAttr(verdictEl, "title", stale ? `判第 ${judged} 轮对话；之后的轮次未核查` : null);
    setAttr(verdictEl, "data-judged-turn", Number.isFinite(judged) && judged > 0 ? String(judged) : null);
    verdictEl.className = `run-item-verdict run-item-verdict--${conclusion === "passed" ? "pass" : conclusion === "failed" ? "fail" : "pending"}${stale ? " run-item-verdict--stale" : ""}`;
  } else {
    setAttr(verdictEl, "hidden", "");
  }

  setText(el.querySelector(".run-item-state-label"), r.status === "running" ? "运行中" : "已完成");
  // 标题是算出来的短句；完整任务原文挂 title，鼠标停一下就能看全
  setText(el.querySelector(".run-item-task"), deriveRunTitle(r.task));
  setAttr(el.querySelector(".run-item-task"), "title", r.task);
  setText(el.querySelector(".run-item-turns"), `${Math.max(1, Number(r.conversationTurn ?? 1))} 轮`);
  setText(el.querySelector(".run-item-time"), meta ? formatTimeShort(meta.startTime) : "");
  setText(
    el.querySelector(".run-item-duration"),
    meta && meta.duration != null ? formatDuration(meta.duration) : "",
  );
}

/**
 * 渲染单个 run 的详情视图（R-03 四层标签结构）。
 * @param {RunState} state
 * @param {{
 *   onAllow?:(toolUseId:string)=>void,
 *   onDenyReason?:(toolUseId:string,reason:string)=>void,
 *   showBack?:boolean,
 *   onBack?:()=>void,
 *   activeTab?:string,
 *   logEntries?:LogEntry[],
 *   onToggleEntry?:(seq:number)=>void,
 *   onReveal?:(path:string)=>void,
 *   inspectPaths?:(paths:string[])=>Promise<any[]>
 * }} callbacks
 */
export function renderRunDetail(state, callbacks) {
  const mainEl = document.getElementById("main-area");
  if (!mainEl) return;

  const activeTab = normalizeTab(callbacks.activeTab);
  const logEntries = callbacks.logEntries || deriveLogEntries(state);
  const overview = deriveOverview(state);
  const harness = callbacks.harness ?? null;

  const isRunning = state.status === "running";

  // V-17：四决定因素派生一次，各分区共用
  const faces = {
    loop: deriveLoopFace(state, harness),
    context: deriveContextFace(state, harness),
    tools: deriveToolsFace(state, harness),
    verification: deriveVerificationFace(state, harness),
    action: deriveActionState(state),
    plan: derivePlanFace(state),
  };

  // V-10：骨架建一次，之后逐区补丁。此前每条 SSE 事件重建整页 innerHTML——
  // 实测拒绝理由输入框的字被清空、日志滚动归零、长运行退化成 O(n²)。
  const parts = ensureDetailSkeleton(mainEl, state, callbacks);

  patchDetailHeader(parts, state, isRunning, faces);
  patchAssemblyBar(parts, state, callbacks.harness);
  /**
   * 「需你决定」现在钉在滚动容器【之外】（#action-dock），它变高变矮只会改变
   * 滚动容器的高度，不会平移容器里的内容——所以**不再需要任何滚动补偿**。
   * 此前为它写过一个视口锚定补偿函数，那是在给布局问题打补丁：补偿方向还得
   * 分"变高别动、变矮才补"两种情形，判反一次就把刚冒出来的待办推出视野。
   * 布局改对之后这段逻辑连同它的测试一起删掉了——**根因修掉，补丁就是负债**。
   */
  patchUserQuestion(parts, faces, callbacks);
  patchPlanGate(parts, state, faces, callbacks);
  patchApprovalRail(parts, state, isRunning, callbacks);
  patchUnverifiedRail(parts, faces);
  patchLiveStrip(parts, state, isRunning, callbacks.liveText ?? "", callbacks.liveThinking ?? "");
  patchConversation(
    parts,
    state,
    { text: callbacks.liveText, thinking: callbacks.liveThinking },
    callbacks,
  );
  patchDetailRail(parts, state, faces, callbacks);
  patchOutcomeCard(parts, state, overview, faces);
  patchFactorGrid(parts, faces, activeTab, callbacks);
  patchTabContent(parts, state, activeTab, overview, logEntries, callbacks, faces);
  patchUsageFooter(parts, state);
}

/** L3 下钻标签集合。overview 是历史别名——旧链接落到 Loop 面 */
const DETAIL_TABS = ["loop", "context", "tools", "verify"];

export function normalizeTab(tab) {
  if (tab === "log" || tab === "overview" || !tab) return "loop";
  return DETAIL_TABS.includes(tab) ? tab : "loop";
}

/**
 * 建立（或复用）详情页骨架，返回各分区容器的引用。
 *
 * 重建条件只有三个：换了 run、窄屏返回栏的有无变了、容器被外部整体替换过
 * （renderEmptyState 会这么干，测试里的 beforeEach 也会）。
 * 其余情况一律复用——这正是输入值与焦点得以存活的根据。
 */
/**
 * 「需你决定」的固定坞：钉在输入框正上方、**在滚动容器之外**。
 *
 * 为什么搬出来（委托方建议 + 实测）：它原本在滚动区顶部，于是
 *   ① 内容一长它就被推走，得靠滚动补偿去追——补偿方向还容易搞反；
 *   ② 用户往下看日志时，新冒出来的待办完全在视野之外。
 * 钉住之后这两件事一起消失，且不再需要任何滚动补偿。
 *
 * 骨架只建一次（内容切换靠补丁），所以这里判空即返回既有节点。
 */
function ensureActionDock() {
  const dock = document.getElementById("action-dock");
  if (!dock) return { actionRail: null, userQuestion: null, planGate: null, approvals: null, approvalsDone: null, unverified: null };
  if (!dock.querySelector(".action-rail")) {
    dock.innerHTML =
      '<div class="action-rail" hidden>' +
      // 提问排在最前：它是**阻塞式**的，执行协程此刻正吊在 ask_user 里等答复
      '<div class="user-question" hidden></div>' +
      // 签字位排在审批卡之前：它挂起时一个子任务都还没发射，此刻决定成本最低
      '<div class="plan-gate" hidden></div>' +
      '<div class="approval-cards" hidden></div>' +
      // 已处理的折叠成一行，不与待处理的混排
      '<div class="approval-cards-done" hidden></div>' +
      '<div class="unverified-rail" hidden></div>' +
      "</div>";
  }
  return {
    dock,
    actionRail: dock.querySelector(".action-rail"),
    userQuestion: dock.querySelector(".user-question"),
    planGate: dock.querySelector(".plan-gate"),
    approvals: dock.querySelector(".approval-cards"),
    approvalsDone: dock.querySelector(".approval-cards-done"),
    unverified: dock.querySelector(".unverified-rail"),
  };
}

function ensureDetailSkeleton(mainEl, state, callbacks) {
  const showBack = Boolean(callbacks.showBack && callbacks.onBack);
  const intact = mainEl.__parts && mainEl.querySelector(".detail-header");
  if (intact && mainEl.__runId === state.runId && mainEl.__showBack === showBack) {
    return mainEl.__parts;
  }

  // V-17 的 L2 结构，自上而下：页头 → 需你决定 → 直播 → 结果 → 四决定因素 → 下钻。
  // 日志不在这一层——它是 Loop 面的下钻内容。
  mainEl.innerHTML =
    (showBack
      ? '<div class="back-bar"><button class="btn back-btn" id="back-to-list-btn">← 返回列表</button></div>'
      : "") +
    '<div class="detail-header">' +
    '<h2 class="detail-task"></h2>' +
    '<div class="detail-meta">' +
    '<span class="status-badge"></span>' +
    '<span class="verify-badge" hidden>核查模式</span>' +
    // V-33：上下文水位常驻页头。压缩是不可逆的（置换掉的 tool_result 原文
    // 永不可恢复），所以"快满了"必须在第一屏就看得见，而不是要下钻才发现
    '<button type="button" class="ctx-gauge" hidden aria-live="polite">' +
    '<i class="ph ph-gauge" aria-hidden="true"></i>' +
    '<span class="ctx-gauge-value"></span>' +
    '<span class="ctx-gauge-compactions" hidden></span>' +
    '</button>' +
    '<span class="detail-hint" hidden></span>' +
    "</div>" +
    // 装配状态条：条上是这次运行的真实装配，点开才是那句设计思想
    '<div class="assembly-bar" role="group" aria-label="本次运行的装配"></div>' +
    '<div class="assembly-why" hidden role="note"></div>' +
    "</div>" +
    '<div class="live-strip" hidden aria-live="polite"></div>' +
    /**
     * **对话是主干**（委托方："还是希望做成对话框的形式，对于用惯了其它 agent
     * 的人来说过于难用"）。
     *
     * 此前首屏是仪表盘（四因子卡 + 下钻面），对话只是 Loop 面里的一个子视图，
     * 而且只有段结束落盘后才有内容——等于把最像"用 agent"的那件事藏在两层之下。
     * 现在反过来：对话铺在主干，工具调用 / 思考 / 审批痕迹 / 裁决**按发生时刻
     * 就地织进这条流**；仪表盘退成默认收起的抽屉。
     *
     * 这不是把特色藏起来——恰恰相反：别家把 agent 的内部收进一个转圈图标，
     * 我们把它按时间顺序织进对话里。低切换成本与"明显不同"在这个形态下不冲突。
     */
    /**
     * 对话与**右栏**并排。右栏现在装编排模式的子任务盘（planner 拆出来的
     * 那张 DAG），将来的子 agent 面板也落这里——委托方要求"做好后续右侧
     * 可能出现子 agent 任务的准备"。
     *
     * 没有东西可放时右栏整个不占位（`hidden`），所以单任务模式下对话仍然铺满。
     * 折叠按钮只在有内容时出现——一个永远空着的折叠柄比没有更糟。
     */
    '<div class="detail-layout">' +
    '<div class="conversation" id="conversation"></div>' +
    '<aside class="detail-rail" id="detail-rail" hidden aria-label="子任务">' +
    '<button type="button" class="rail-toggle" id="rail-toggle" aria-expanded="true" aria-controls="rail-body">子任务 ⟩</button>' +
    '<div class="rail-body" id="rail-body">' +
    '<div class="artifacts" hidden></div>' +
    '<div class="plan-board"></div>' +
    "</div>" +
    "</aside>" +
    "</div>" +
    // 结果卡排在对话之后：它是这次运行的收尾，不是开场白
    '<div class="outcome-card"></div>' +
    '<div class="usage-footer" hidden></div>' +
    // 仪表盘抽屉：四因子卡仍是标签栏，只是不再占首屏
    '<details class="detail-drawer" id="detail-drawer">' +
    '<summary class="drawer-summary">运行详情：Loop / 上下文 / 工具 / 核查</summary>' +
    '<div class="factor-grid" role="tablist" aria-label="四决定因素"></div>' +
    '<div class="tab-content" id="tab-content" role="tabpanel" tabindex="0"></div>' +
    "</details>";

  if (showBack) {
    mainEl.querySelector("#back-to-list-btn").addEventListener("click", callbacks.onBack);
  }
  bindThinkingPref(mainEl.querySelector(".conversation"));
  const railToggle = mainEl.querySelector("#rail-toggle");
  if (railToggle) {
    railToggle.addEventListener("click", () => {
      const rail = mainEl.querySelector(".detail-rail");
      const open = !rail.classList.contains("detail-rail--collapsed");
      rail.classList.toggle("detail-rail--collapsed", open);
      railToggle.setAttribute("aria-expanded", String(!open));
      railToggle.textContent = open ? "⟨ 子任务" : "子任务 ⟩";
    });
  }

  const parts = {
    root: mainEl,
    task: mainEl.querySelector(".detail-task"),
    statusBadge: mainEl.querySelector(".status-badge"),
    verifyBadge: mainEl.querySelector(".verify-badge"),
    ctxGauge: mainEl.querySelector(".ctx-gauge"),
    hint: mainEl.querySelector(".detail-hint"),
    assembly: mainEl.querySelector(".assembly-bar"),
    assemblyWhy: mainEl.querySelector(".assembly-why"),
    // 「需你决定」在滚动容器之外（#action-dock，钉在输入框上方）——
    // 它不随内容滚走，新审批出现在哪都看得见（委托方建议的结构解法）
    ...ensureActionDock(),
    liveStrip: mainEl.querySelector(".live-strip"),
    conversation: mainEl.querySelector(".conversation"),
    rail: mainEl.querySelector(".detail-rail"),
    railBoard: mainEl.querySelector(".detail-rail .plan-board"),
    artifacts: mainEl.querySelector(".detail-rail .artifacts"),
    drawer: mainEl.querySelector(".detail-drawer"),
    outcome: mainEl.querySelector(".outcome-card"),
    factorGrid: mainEl.querySelector(".factor-grid"),
    tabContent: mainEl.querySelector(".tab-content"),
    usage: mainEl.querySelector(".usage-footer"),
    sig: {},
  };
  mainEl.__parts = parts;
  mainEl.__runId = state.runId;
  mainEl.__showBack = showBack;
  return parts;
}

function patchDetailHeader(parts, state, isRunning, faces) {
  const cls = classifyStopReason(isRunning ? null : state.stopReason);
  const loop = faces.loop;
  patchContextGauge(parts, faces.context);
  const sig = signature([
    state.task, isRunning, state.stopReason, state.verify, loop.turn, loop.maxTurns,
  ]);
  if (parts.sig.header === sig) return;
  parts.sig.header = sig;

  setText(parts.task, state.task);
  const turnLabel = loop.maxTurns ? ` · 第 ${loop.turn}/${loop.maxTurns} 轮` : "";
  setText(parts.statusBadge, (isRunning ? "运行中" : cls.label) + (isRunning ? turnLabel : ""));
  parts.statusBadge.className = `status-badge ${isRunning ? "status--live" : toneClass(cls.tone)}`;
  setAttr(parts.verifyBadge, "hidden", state.verify ? null : "");

  // 六值终止的补救提示直接进页头——max_turns / error 这两类核查根本救不了，
  // 用户必须在第一屏就知道"通过也不代表任务做完"
  setAttr(parts.hint, "hidden", !isRunning && cls.hint ? null : "");
  if (!isRunning && cls.hint) setText(parts.hint, cls.hint);
}

/**
 * 渲染装配条。每一项是一个按钮，点开在下方展开那句"为什么这样设计"。
 *
 * 用按钮而不是 `title` 提示：`title` 触屏上根本出不来、键盘也够不着，
 * 而这条恰恰是给"第一次用、想知道这跟别家有什么不同"的人看的。
 */
function patchAssemblyBar(parts, state, harness) {
  const host = parts.assembly;
  if (!host) return;
  const items = deriveAssemblyBar(state, harness);
  setAttr(host, "hidden", items.length > 0 ? null : "");
  const sig = signature(items.map((i) => `${i.key}:${i.chip}`));
  if (parts.sig.assembly !== sig) {
    parts.sig.assembly = sig;
    host.innerHTML = items
      .map(
        (i) =>
          `<button type="button" class="assembly-chip" data-why="${esc(i.key)}" aria-expanded="false" title="${esc(i.chip)}">${esc(i.chip)}</button>`,
      )
      .join('<span class="assembly-sep">·</span>');
  }

  if (host.__whyBound) return;
  host.__whyBound = true;
  host.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest("[data-why]") : null;
    if (!btn) return;
    const key = btn.getAttribute("data-why");
    const cur = deriveAssemblyBar(state, harness).find((i) => i.key === key);
    const box = parts.assemblyWhy;
    const already = btn.getAttribute("aria-expanded") === "true";
    for (const b of host.querySelectorAll("[data-why]")) b.setAttribute("aria-expanded", "false");
    if (already || !cur) {
      setAttr(box, "hidden", "");
      return;
    }
    btn.setAttribute("aria-expanded", "true");
    setAttr(box, "hidden", null);
    box.innerHTML = `<strong>${esc(cur.chip)}</strong> ${renderMarkdownInline(cur.why)}`;
  });
}

/**
 * 流式显示的**匀速放行**。
 *
 * 委托方："有时候会卡住然后突然冒一长串，就是有点像卡顿的样子。"
 * 量了一轮，**不是我们渲染慢**（长任务观测器录到 0 条长任务），
 * 是**上游本来就是一阵一阵来的**：一次 230 条增量里，多数在同一毫秒内到达，
 * 而相邻两批之间最长静默 943ms。兼容端点按块推流，不是逐字推。
 *
 * 所以修不在"更快地画"，而在**别把到达节奏当成显示节奏**：
 * 把已到达但还没显示的部分当成一个缓冲，按帧匀速放出去。
 * 一次 300 字的突进因此摊成约 350ms 的平滑推进，而不是一帧糊上去。
 *
 * 三条边界：
 *   ① **积压越多放得越快**——否则长文会越拖越远，最后停笔了字还在慢慢爬；
 *   ② 有个下限速度，免得零星几个字挤牙膏；
 *   ③ 一轮结束（`done`）时**立刻全放**——收尾必须是准的，
 *      不能让人对着一段还没吐完的文字以为模型还在写。
 *
 * @param {{arrived:number, revealed:number, dtMs:number, done?:boolean}} m
 * @returns {number} 这一帧该显示到第几个字
 */
export function paceReveal(m) {
  const arrived = Math.max(0, m.arrived | 0);
  // 上游文本变短 = 换了一轮（liveText 被清过），显示位置跟着回落
  let revealed = Math.min(Math.max(0, m.revealed | 0), arrived);
  if (m.done) return arrived;
  const backlog = arrived - revealed;
  if (backlog <= 0) return revealed;
  /**
   * **剩不多了就一次放完。**
   *
   * 速度取自积压量，所以这是指数衰减——越接近追平走得越慢，尾巴能拖很久。
   * 初版没有这个收尾闸，一次 300 字的突进 350ms 只走到 200 字，
   * 剩下那截慢慢爬，正是我要修的"字还在爬"本身。**是被自己写的那条测试
   * 当场抓出来的**（断言 350ms 追平，实测 200/300）。
   */
  if (backlog <= REVEAL_SNAP) return arrived;
  const cps = Math.max(REVEAL_MIN_CPS, backlog / REVEAL_DRAIN_SEC);
  const step = Math.ceil((cps * Math.max(0, m.dtMs)) / 1000);
  return Math.min(arrived, revealed + Math.max(1, step));
}

/**
 * 匀速放行的**窗口换算**：全局"该显示到第几个字"→ 当前缓冲里该切几个字。
 *
 * 为什么需要它（2026-08-15 委托方实测：思考流到约 2000 字就停住，过一会才整块出现）：
 * `revealed` 是一个**单调增长的绝对计数**，而直播缓冲有上限（LIVE_TEXT_CAP）
 * 且**只留尾部**——是一个滑动窗口。用绝对计数直接去 slice 一个滑动窗口，
 * 到达上限那一刻两件事同时发生：
 *   ① `arrived` 不再增长（缓冲长度被钉死在上限）；
 *   ② 于是 `revealed` 也不再变化，节拍器里 `changed` 恒为 false → **再也不重绘**。
 * 屏幕就冻在撞上限的那一帧，直到本轮结束、turn 级 `assistant_thinking`
 * 走正常 reducer 路径整块到达——正是"过好一会才显示"。
 *
 * 修法是把绝对计数与窗口分开：另记**单调累计到达字数**（不受上限影响），
 * revealed 对它计数；这里再把它换算成窗口内的偏移。
 *
 * 提成纯函数放在 app.js，是因为原来那段逻辑住在 index.html——**没有任何测试
 * 够得着它**（本仓库那条"核心可测、壳不可测的分界线就是缺陷分布线"的活标本）。
 * 挪进来是结构性修复，不是补丁。
 *
 * @param {{revealed:number, precedingTotal:number, total:number, bufferLength:number}} m
 *   revealed       全局已放行字数（paceReveal 的产物）
 *   precedingTotal 排在本段之前的那些段的累计字数（思考在前、正文在后）
 *   total          本段**累计**到达字数（单调，不受缓冲上限影响）
 *   bufferLength   本段当前缓冲长度（≤ 上限）
 * @returns {number} 该从缓冲头部切多少个字
 */
export function revealedWindow(m) {
  const bufferLength = Math.max(0, m.bufferLength | 0);
  const total = Math.max(0, m.total | 0);
  // 已经被挤出缓冲的字数：它们早就该显示了，不该再占放行额度
  const dropped = Math.max(0, total - bufferLength);
  const budget = (m.revealed | 0) - Math.max(0, m.precedingTotal | 0) - dropped;
  return Math.max(0, Math.min(bufferLength, budget));
}

/** 积压排空的时间常数。指数衰减，配合下面的收尾闸才能真的追平 */
const REVEAL_DRAIN_SEC = 0.12;
/** 速度下限：零星几个字别挤牙膏 */
const REVEAL_MIN_CPS = 40;
/** 收尾闸：剩这么多字就一次放完，不留一条慢慢爬的尾巴 */
const REVEAL_SNAP = 12;

/**
 * 两个跳转箭头该不该出现。
 *
 * 委托方要的是两件不同的事：
 *   · **↓ 回到底部**——流式时人往上翻过之后，得有一步回到"正在写"的地方；
 *   · **↑ 回到四决定因素**——点开下钻抽屉、往下读进去之后，
 *     四张卡已经滚出视野，没有箭头就只能一路滚回去。
 *
 * 抽成纯函数是因为这两条判据都只是算术，而 jsdom 里量不到真实布局——
 * 放在渲染函数里就等于没法测（本轮反复吃过这个亏）。
 *
 * @param {{scrollTop:number, scrollHeight:number, clientHeight:number,
 *          anchorTop:number|null, drawerOpen:boolean}} m 已量好的几何量
 */
export function deriveScrollNav(m, threshold = 80) {
  const distanceToBottom = m.scrollHeight - m.scrollTop - m.clientHeight;
  // 内容还没长到需要滚动时，两个箭头都是噪声
  const scrollable = m.scrollHeight - m.clientHeight > threshold;
  return {
    showBottom: scrollable && distanceToBottom > threshold,
    /**
     * ↑ 只在**抽屉开着且四张卡已经滚出视野**时出现。
     * 抽屉没开时上面就是对话，往上翻是读历史，不该被一个"回到顶部"催着走。
     */
    showTop: Boolean(m.drawerOpen) && m.anchorTop !== null && m.anchorTop < 0,
  };
}

/**
 * 装配状态条：**显示的是这次运行的真实装配，点开才是那句设计思想**。
 *
 * 委托方问的是"能不能在某处以状态栏的形式显示我们 harness 的哲学设计思想"。
 * 直接滚动展示理念的状态栏，本质是标语——而本项目一贯反对标语（findings 全篇
 * 的写法都是"判据 + 出处"，不是主张）。所以把它翻过来：
 *
 *   条上是 `opus-5 · ts-coding · 40轮/64k · 核查开 · 写入圈禁 D:\proj`，
 *   点「核查开」才弹出那句"为什么这个 harness 要有独立核查者"。
 *
 * **哲学通过它管着的那个真实数字被看见**，而不是通过一句悬空的话。
 * 一个副作用是它没法说谎：数字来自 run_config，装配变了条上就变，
 * 说明文字不会和现实脱节——而一条写死的标语会。
 *
 * 每一项的 `why` 都必须落在**具体后果**上（不这样会发生什么），
 * 且能追到 docs 里的出处。写不出后果的项，就不该占状态条的位置。
 */
export function deriveAssemblyBar(state, harness) {
  const cfg = state.runConfig ?? {};
  const g = cfg.guardrails ?? harness?.guardrails ?? null;
  const pack = cfg.pack ?? harness?.pack ?? null;
  const items = [];

  const push = (key, chip, why) => {
    if (chip) items.push({ key, chip, why });
  };

  // 执行模型：换模型是最容易被忘记的变量，而它解释掉大半的行为差异
  push(
    "model",
    harness?.model ?? null,
    "执行者用的模型。手写循环不绑定某一家：Anthropic 原生与 OpenAI wire 两条协议走同一个循环，" +
      "所以模型是**可对照的实验变量**而不是一次重写——发现 15~17 的拆分方差对照（换更强的 planner 纹丝不动，" +
      "改成结构化拆分协议才做到 5/5 零方差）就是靠这一点做出来的。这一格是记录，不是旋钮。",
  );

  // 领域包：本项目最独特的装配单位
  push(
    "pack",
    pack?.name ?? "无领域包",
    "领域包一次装配三样东西：系统提示、工具面、以及**核查者的只读白名单与预算**。" +
      "分开配的后果案例 #4 实证过——核查者没有可用的只读命令，会在 22 轮里反复重新证明已经为真的事（核查饥饿），" +
      "烧光预算却什么也没查出来。",
  );

  // 护栏：轮数与 token 是硬边界，撞上了核查救不了
  // maxTokens 未设时**不写它**：`?? 0` 会渲成「0k」，那是在说"上限为零"——
  // 一个没设过的护栏被画成最严格的护栏，正是这条状态条最该避免的那种谎话
  const tokenPart = g && g.maxTokens ? ` / ${Math.round(g.maxTokens / 1000)}k` : "";
  push(
    "guardrails",
    g && g.maxTurns ? `${g.maxTurns} 轮${tokenPart}` : null,
    "单次运行的硬边界，由**宿主**执行：轮数/预算检查发生在每次模型调用之前，触发时不再发请求、" +
      "直接以对应的 stopReason 收尾。撞上它与「做完了」是两回事——即使裁决 passed 也不代表任务做完，" +
      "所以终止原因是**一组具名值**而不是成败两值，撞边界时界面会直说「核查救不了这一类」。",
  );

  // 核查：三值裁决 + 独立上下文，这是与别家最明显的分野
  /**
   * 白名单条数上条，**且 0 要显眼**。
   *
   * 这几条决定核查者是"能亲手重跑 vitest/tsc 的验证者"还是"只能读文件猜的观察者"。
   * 案例 #4 就是空白名单：verifier 的 bash 全被拒，22 轮返工、零写入，
   * 而四道门禁的地面真值早已全绿——把"查不了"错判成"没做对"，
   * 那是 fail-closed 三种误伤里代价最高的一种。所以它不适用"空就不显示"。
   */
  // 生效白名单（无包运行 = 通用缺省）优先于包声明；来源非包时标出来——"白名单 13"若不说是通用缺省，
  // 人会以为是自己配的
  const wlEff = resolveEffectiveWhitelist(state, harness);
  const wl = wlEff.commands ?? (cfg.pack ?? harness?.pack)?.verify?.readOnlyCommands ?? [];
  const wlSrc = whitelistSourceLabel(wlEff.source);
  const wlPart = state.verify ? `·白名单 ${wl.length}${wlSrc ? `(${wlSrc})` : ""}` : "";
  push(
    "verify",
    state.verify ? `核查开${cfg.verifierBudgetTurns ? ` ${cfg.verifierBudgetTurns} 轮` : ""}${wlPart}` : "核查关",
    "开启后由**另一个上下文**独立复核，不是让执行者自己说自己对（它看得见自己的推理，天然会为结论辩护）。" +
      "裁决分三值：passed / unverified / advisory——「没验成」和「不合格」是两件事，压成一个布尔值会让前者被当成后者。" +
      "白名单是核查者的取证手段：案例 #4 里它为空，verifier 的 bash 全被拒，22 轮返工零写入，而地面真值早已全绿。",
  );

  // 工作目录：工具的写入圈禁根
  push(
    "workdir",
    cfg.workdir ? shortPath(cfg.workdir) : null,
    "工具的写入圈禁根。路径校验在**宿主**这一侧做，不靠提示词让模型自觉——" +
      "模型给出的路径是不可信输入，`..` 逃逸与工作区外的绝对路径一律在执行前被拒。",
  );

  // RUN-01 Phase 2：同 run 恢复痕迹（来自 run_resumed 事件，重放可复原）
  if (state.lineage?.kind === "same-run") {
    push(
      "durable",
      "同 run 热恢复",
      "本会话从 state.json 的 interrupted 相 + 已提交检查点在同一 runId 上续跑；" +
        "未恢复 active grant / 原 AbortController；SAFE-06 toolTx 从 state 种子化（同 key 不重复 commit），" +
        "不自动重放未完成 mid-tool 轮。",
    );
  }

  /**
   * 识图能力。**没配就明说没配**——委托方遇到的正是这一条：
   * 传了图进去，模型很诚实地回"我看不到图片"，但界面上完全看不出
   * "是这套装配里没有这个工具"，只能从模型的道歉里推。
   *
   * 顺带说明 harness 在这件事上的判断：视觉模型没配时，`describe_image`
   * **根本不进工具面**，而不是摆一个一调用就报错的工具——
   * 给模型一个用不了的工具，它会反复尝试并把失败归咎于自己。
   */
  /**
   * 两处数据源形状**不一样**，都得认：
   *   · `run_config.roleModels.vision` 是 `string|null`（本 run 实际用的）；
   *   · `/api/harness` 的是 `{configured:boolean, model?}`（进程级配置）。
   * 直接 `harness.roleModels.vision ? …` 会永远为真——未配时它是
   * `{configured:false}`，一个真值对象。**那会让这一格恰好在它唯一有用的
   * 场景下说反话**，所以判据只认名字与 configured。
   */
  const visionRun = cfg.roleModels?.vision ?? null;
  const visionCfg = harness?.roleModels?.vision ?? null;
  const visionName =
    (typeof visionRun === "string" && visionRun) ||
    (visionCfg && visionCfg.configured ? visionCfg.model ?? "已配" : null);
  push(
    "vision",
    visionName ? `识图 ${visionName}` : "识图 未配",
    visionName
      ? "配了视觉模型，`describe_image` 才在工具面上。图片走独立角色模型，与执行者解耦——" +
        "执行模型不必自己支持视觉。"
      : "没配视觉模型（`AGENT_VISION_MODEL`），所以 `describe_image` **根本不进工具面**——" +
        "而不是摆一个一调用就报错的工具。给模型一个用不了的工具，它会反复尝试并把失败归咎于自己；" +
        "工具面必须与真实能力一致，这是工具运行时地板那条纪律。",
  );

  /**
   * 端点降级链（MODEL-01a）。**只在配了的时候上条**——与识图那一格相反：
   * 识图未配时要明说，因为"模型说它看不到图"这个现象需要解释；降级未配是
   * 绝大多数机器的常态，摆一格"未配"只是噪声。
   *
   * 配了就必须写清**覆盖范围**：链只包主执行者。若把它读成"整台宿主都保了底"，
   * 核查者所在端点挂掉时会得到一个完全意料之外的失败。
   */
  const chainCfg = cfg.fallbackChain ?? harness?.fallbackChain ?? null;
  const chainsCfg = cfg.fallbackChains ?? harness?.fallbackChains ?? null;
  const scopeCfg = cfg.fallbackScope ?? harness?.fallbackScope ?? null;
  const routingCfg = cfg.fallbackRouting ?? harness?.fallbackRouting ?? null;
  if (Array.isArray(chainCfg) && chainCfg.length > 1) {
    const fellBack = (state.timeline ?? []).some((e) => e.type === "model_fallback");
    const roleBits = [];
    if (chainsCfg?.verifier?.length > 1) roleBits.push(`核查 ${chainsCfg.verifier.join("→")}`);
    if (chainsCfg?.planner?.length > 1) roleBits.push(`规划 ${chainsCfg.planner.join("→")}`);
    if (chainsCfg?.vision?.length > 1) roleBits.push(`视觉 ${chainsCfg.vision.join("→")}`);
    const scopeLabel =
      scopeCfg === "roles" ? "多角色" : "主执行者";
    push(
      "fallback",
      `降级链 ${chainCfg.join(" → ")}${fellBack ? "·已降级" : ""}${routingCfg === "prefer_healthy" ? "·偏好健康" : ""}`,
      `${scopeLabel}端点降级：瞬时错误（网络/超时/429/5xx）耗尽后换下一家再试，各端点按身份共享熔断器。` +
        (scopeCfg === "roles"
          ? `角色可自配 AGENT_<ROLE>_FALLBACK_* 或 inherit。${roleBits.length ? ` 已装配：${roleBits.join("；")}。` : ""}`
          : "角色默认不进执行者链——要保底须显式配置或 inherit。") +
        " 认证失败、400 一律原样上抛。prefer_healthy 只是粘性探针证据上的排序 stub，不是成本路由。",
    );
  }

  /** 精确输入 grant 必须可见：active 与历史审计不能混成一个状态。 */
  const rules = state.autoAllow ?? [];
  if (rules.length > 0) {
    const now = Date.now();
    const activeRules = rules.filter(
      (rule) =>
        !state.archived &&
        rule?.status === "active" &&
        rule.inputScope === "exact-input" &&
        rule.inputHash &&
        Number(rule.expiresAt) > now &&
        Number(rule.usedUses ?? 0) < Number(rule.maxUses ?? 0),
    );
    const historicalRules = rules.filter((rule) => !activeRules.includes(rule));
    const labels = activeRules.map((rule) => {
      const shortHash = String(rule.inputHash).replace(/^sha256:/, "").slice(0, 8);
      const remaining = Math.max(0, Number(rule.maxUses ?? 0) - Number(rule.usedUses ?? 0));
      return `${rule.name}#${shortHash}·余${remaining}`;
    });
    if (historicalRules.length) labels.push(`历史记录 ${historicalRules.length}`);
    push(
      "autoAllow",
      activeRules.length ? `精确放行 ${labels.join("·")}` : `授权审计 ${labels.join("·")}`,
      "active grant 只在**同一 runId、同一工具定义、完全相同的参数**下生效，并受固定 TTL 与次数限制；" +
        "command、path、device 任一参数变化都会重新询问。完整 main checkpoint 会保存审计快照，但 archive continuation " +
        "会创建新 run，因此只显示 not-inherited，绝不恢复执行权。旧版或过期记录仅作历史审计。",
    );
  }

  // 编排：计划确认门是"零副作用时刻"的唯一入口
  if (state.plan) {
    // planner 预算不再是写死的 12（B0）：报数字必须带来源，口径同核查预算
    const pb = cfg.plannerBudgetTurns ?? harness?.plannerBudgetTurns ?? null;
    const pbSrc = cfg.plannerBudgetSource ?? harness?.plannerBudgetSource ?? null;
    push(
      "plan",
      `编排 ${state.plan.subtasks?.length ?? 0} 步${pb ? `·planner ${pb} 轮` : ""}`,
      "planner 先拆解成带依赖的子任务再调度，互不依赖的并发跑。" +
        "配套的计划确认门挂在**第一个子任务发射之前**——那是整场运行里唯一一个否决它零副作用的时刻，过了就有东西被改了。" +
        (pb
          ? `探索预算 ${pb} 轮（来源：${pbSrc === "env" ? "env 显式覆盖" : pbSrc === "pack" ? "领域包声明" : "默认值"}），与执行者护栏解耦；撞满会续跑一小段只许写计划的收口，仍无计划才 fail-closed。`
          : ""),
    );
  }

  return items;
}

/** 长路径只留尾部两级：状态条是一行，完整值挂 title */
function shortPath(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? String(p) : `…${parts.slice(-2).join("/")}`;
}

/**
 * 常驻上下文水位表（V-33）。
 *
 * Context 面里有完整的三分与逐轮明细，但那要下钻才看得到。压缩是**不可逆**的
 * ——被置换的 tool_result 原文永不可恢复，模型只能重新调工具取回——所以
 * "快满了"这件事必须在第一屏就可见，而不是事后在明细里发现。
 *
 * 点它跳到 Context 面：图标是入口，不是死数字。
 */
function patchContextGauge(parts, ctx) {
  const el = parts.ctxGauge;
  if (!el) return;
  if (!ctx || ctx.lastInputTokens === 0) {
    setAttr(el, "hidden", "");
    return;
  }
  setAttr(el, "hidden", null);

  const pct = ctx.ratio === null ? null : Math.round(ctx.ratio * 100);
  const tone = ctx.compactions.length > 0 ? "irreversible" : ctx.nearWatermark ? "warn" : "ok";
  el.className = `ctx-gauge ctx-gauge--${tone}`;

  // 应用层操作图标统一由 Phosphor 提供；数值仍用文字直接报真值。
  // 没配上限时只报绝对值，不画一个看似 0% 的伪水位。
  const label = pct === null
    ? `上下文 ${formatTokens(ctx.lastInputTokens)}`
    : `上下文 ${pct}%`;
  setText(el.querySelector(".ctx-gauge-value"), label);
  const compacted = el.querySelector(".ctx-gauge-compactions");
  setText(compacted, ctx.compactions.length > 0 ? `压缩 ${ctx.compactions.length}` : "");
  setAttr(compacted, "hidden", ctx.compactions.length > 0 ? null : "");

  // 无障碍名称要说全口径与后果——光念"48%"没有信息量
  const parts2 = [
    pct === null
      ? `上下文最近一轮输入 ${formatTokens(ctx.lastInputTokens)}（未配置上限）`
      : `上下文水位 ${pct}%，最近一轮输入 ${formatTokens(ctx.lastInputTokens)} / 上限 ${formatTokens(ctx.limit)}`,
    ctx.compactions.length > 0
      ? `已压缩 ${ctx.compactions.length} 次，置换 ${ctx.droppedBlocks} 个 tool_result 原文` +
        ((ctx.collapsedTurns ?? 0) > 0 ? `，折叠 ${ctx.collapsedTurns} 轮旧对话` : "") +
        ((ctx.reactiveCount ?? 0) > 0 ? `（${ctx.reactiveCount} 次为撞 400 后的反应式压缩）` : "") +
        `；结构化账本保留 ${ctx.ledgerEntries ?? 0} 条事实` +
        ((ctx.summaryAppliedCount ?? 0) > 0 ? `（其中 ${ctx.summaryAppliedCount} 次合并了 LLM 摘要）` : "")
      : null,
    "查看上下文详情",
  ].filter(Boolean);
  setAttr(el, "aria-label", parts2.join("；"));
  setAttr(el, "title", parts2.join("\n"));

  if (!el.__bound) {
    el.__bound = true;
    el.addEventListener("click", () => switchToFace("context"));
  }
}

/**
 * 待复核项（⋯ unverified）。
 *
 * 只在这里出现一次。V-16：此前概览的"裁决卡"与"需介入事项"把同一批列了两遍，
 * 用户以为有两组待办。裁决卡里的那份现在是下钻详情，不是第二份清单。
 */
/**
 * 计划确认门（§5.1）——"一人公司"路线里的签字位。
 *
 * 挂起时计划已经产出、但一个子任务都还没发射，所以否决是零副作用的。
 * 决策做出后不隐藏，转成只读的审计记录留在原地——与审批卡同款口径（V-02）：
 * "我到底批没批、什么时候批的"必须刷新后还看得见。
 */
/**
 * §5.2 提问卡。与计划门同款口径：**阻塞式交互必须可见且可键盘操作**——
 * 看不见就等于运行卡死了而界面上什么都没有。
 *
 * 三个出口都给（选项 / 自由输入 / 让它自己定），因为决定 4 说得很清楚：
 * 不答不是错误。把「让它自己定」做成一个明确的按钮，而不是逼人关窗口，
 * 是同一条纪律——委托方的选择要有地方表达。
 */
function patchUserQuestion(parts, faces, callbacks) {
  if (!parts.userQuestion) return;
  const q = faces.action.question;
  if (!q || q.status !== "pending") {
    setAttr(parts.userQuestion, "hidden", "");
    parts.sig.userQuestion = null;
    parts.userQuestion.innerHTML = "";
    return;
  }
  const sig = signature([q.id, q.questions.map((x) => x.question + x.options.join("|")).join("§")]);
  if (parts.sig.userQuestion === sig) return;
  parts.sig.userQuestion = sig;
  setAttr(parts.userQuestion, "hidden", null);

  const n = q.questions.length;
  /**
   * 一屏答完（决定 6）。每题一组选项 + 一个自由输入，底部**一个**提交按钮——
   * 三个正交的问题分三轮问是三次打断，一屏答完是一次。
   * 选项用 radio 而不是按钮：选了要能看出选了哪个，还要能改主意。
   */
  const blocks = q.questions
    .map((item, i) => {
      const opts = item.options
        .map(
          (o, j) =>
            `<label class="question-opt"><input type="radio" name="q-${i}" value="${esc(o)}" />` +
            `<span>${esc(o)}</span></label>`,
        )
        .join("");
      return (
        `<fieldset class="question-item">` +
        `<legend class="question-legend">${n > 1 ? `${i + 1}. ` : ""}${esc(item.question)}</legend>` +
        `<div class="question-options">${opts}</div>` +
        `<label class="question-free-label" for="q-free-${i}">或自己写</label>` +
        `<input id="q-free-${i}" class="question-free" data-free="${i}" type="text" placeholder="不在上面的答案" />` +
        `<p class="rail-note">不答这题就按：${esc(item.fallback)}</p>` +
        `</fieldset>`
      );
    })
    .join("");

  parts.userQuestion.innerHTML =
    '<div class="question-card">' +
    `<h3 class="rail-title">◆ ${esc(ROLE_PERSONA.main)} 有 ${n} 个问题需要你定</h3>` +
    blocks +
    '<div class="question-actions">' +
    '<button class="btn btn--allow" data-action="send">提交答复</button>' +
    '<button class="btn" data-action="skip">都让它自己定</button>' +
    "</div></div>";

  const collect = () =>
    q.questions.map((_, i) => {
      const free = parts.userQuestion.querySelector(`[data-free="${i}"]`);
      if (free && free.value.trim()) return free.value.trim();
      const picked = parts.userQuestion.querySelector(`input[name="q-${i}"]:checked`);
      return picked ? picked.value : null;
    });

  parts.userQuestion
    .querySelector("[data-action='send']")
    .addEventListener("click", () => {
      const answers = collect();
      // 一题都没答就等同"都让它自己定"——不让它变成一次无效往返
      callbacks.onAnswer?.(answers.some((a) => a !== null) ? answers : null);
    });
  parts.userQuestion
    .querySelector("[data-action='skip']")
    .addEventListener("click", () => callbacks.onAnswer?.(null));
}

function patchPlanGate(parts, state, faces, callbacks) {
  const gate = faces.action.planApproval;
  if (!gate) {
    setAttr(parts.planGate, "hidden", "");
    parts.sig.planGate = null;
    parts.planGate.innerHTML = "";
    return;
  }
  // 已决/过期不留在 rail 上——那是"需你现在决定"的位置。审计记录归 Plan 面。
  if (gate.status !== "pending") {
    setAttr(parts.planGate, "hidden", "");
    parts.sig.planGate = null;
    parts.planGate.innerHTML = "";
    return;
  }

  const count = state.plan?.subtasks?.length ?? 0;
  const sig = signature(["pending", count]);
  if (parts.sig.planGate === sig) return;
  parts.sig.planGate = sig;
  setAttr(parts.planGate, "hidden", null);

  parts.planGate.innerHTML =
    '<div class="plan-gate-card">' +
    '<h3 class="rail-title">◈ 计划待你签字</h3>' +
    `<p class="plan-gate-body">${ROLE_PERSONA.planner}（planner）已拆出 <strong>${count}</strong> 个子任务（详见 Plan 面）。` +
    "批准后才会发射第一个子任务；此刻否决没有任何副作用。</p>" +
    '<div class="plan-gate-actions">' +
    '<button class="btn btn--allow" data-action="approve">批准并开跑</button>' +
    '<button class="btn btn--deny" data-action="reject">否决（中止本次运行）</button>' +
    "</div></div>";
  parts.planGate
    .querySelector("[data-action='approve']")
    .addEventListener("click", () => callbacks.onPlanDecision?.("approve"));
  parts.planGate
    .querySelector("[data-action='reject']")
    .addEventListener("click", () => callbacks.onPlanDecision?.("reject"));
}

function patchUnverifiedRail(parts, faces) {
  const items = faces.action.unverifiedItems;
  const sig = signature([items.length, items.join("|")]);
  setAttr(parts.actionRail, "hidden", faces.action.needsAttention ? null : "");
  /**
   * 坞和栏要**一起**切显隐。
   *
   * 坞在 index.html 里初始就是 hidden（没事时不该在输入框上方占一条空白），
   * 只切里面的 rail 的话，rail 显示了坞还盖着——整块「需你决定」永远看不见。
   * 这正是搬出滚动容器新引入的接线，容易漏，所以下面有一条专门的回归锁。
   */
  if (parts.dock) setAttr(parts.dock, "hidden", faces.action.needsAttention ? null : "");
  if (parts.sig.unverified === sig) return;
  parts.sig.unverified = sig;

  setAttr(parts.unverified, "hidden", items.length > 0 ? null : "");
  if (items.length === 0) {
    parts.unverified.innerHTML = "";
    return;
  }
  parts.unverified.innerHTML =
    `<h3 class="rail-title">⋯ ${items.length} 项待你复核</h3>` +
    '<ul class="unverified-list">' +
    items.map((i) => `<li class="unverified-item md-inline">${renderMarkdownInline(i)}</li>`).join("") +
    "</ul>" +
    '<p class="rail-note">核查者无法自行判定这些项，已移交委托方。不影响 passed，也不触发返工。</p>';
}

/**
 * 直播条：运行中显示【正在流入的文本】，其次是最近一次工具调用，再次是最后一句输出。
 *
 * liveText 是逐字增量（`event: delta` 命名通道）。它**不在 RunState 里**，
 * 由控制器单独持有并作为参数传入——delta 不占 seq、不进事件缓冲（V-15），
 * 重放时根本不存在；塞进 state 会打破 reducer 的"同批事件重放两次状态深相等"。
 *
 * 优先级把 liveText 放第一：它描述的是【此刻正在发生】的事，而 tool_call /
 * assistant_text 都是已经发生完的。控制器在 turn_start / tool_call / done
 * 时清空缓冲，所以文本阶段一结束就自动让位给工具标签。
 */
function patchLiveStrip(parts, state, isRunning, liveText = "", liveThinking = "") {
  if (!isRunning) {
    setAttr(parts.liveStrip, "hidden", "");
    parts.sig.live = null;
    return;
  }
  const streaming = String(liveText ?? "").trim();
  const thinking = String(liveThinking ?? "").trim();
  const recent = [...state.timeline].reverse();
  const call = recent.find((e) => e.type === "tool_call");
  const text = recent.find((e) => e.type === "assistant_text");
  // 优先级：正文 > 思考 > 工具 > 最后一句。思考排在工具之前是因为它是【此刻】
  // 在发生的——委托方反馈的那段"只有一行流动对话"的空窗正是它
  /**
   * **正文与思考已经在对话里逐字流了，这里不再重复**（V-16）。
   * 直播条现在只说对话此刻说不出来的那几种：正在调哪个工具、以及还没开口的空窗。
   * 两处同时滚同一段文字会让人不知道该看哪儿——那正是"过于难用"的一种。
   */
  if (streaming || thinking) {
    setAttr(parts.liveStrip, "hidden", "");
    parts.sig.live = null;
    return;
  }
  const label = call
    ? `${call.name}(${summarizeInput(call.input)})`
    : text
      ? String(text.text ?? "").slice(0, 80)
      : "等待模型响应…";

  const sig = signature([label]);
  if (parts.sig.live === sig) return;
  parts.sig.live = sig;
  setAttr(parts.liveStrip, "hidden", null);
  parts.liveStrip.innerHTML =
    '<span class="live-dot"></span><span class="live-text"></span>';
  setText(parts.liveStrip.querySelector(".live-text"), label);
}

/**
 * 取尾部 n 字（流式文本要看的是最新写出来的那截，不是开头）。
 * 换行折成空格：直播条是单行，原样塞进去会把布局撑开。
 */
export function tailOf(s, n) {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `…${flat.slice(flat.length - n)}`;
}

function summarizeInput(input) {
  if (!input || typeof input !== "object") return "";
  const first = Object.values(input)[0];
  const s = typeof first === "string" ? first : JSON.stringify(first ?? "");
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/**
 * 审批栏（V-10 的关键分区）。
 *
 * 用 patchList 按 approvalId 键控：已存在的卡片节点永不重建，于是里面的
 * 拒绝理由输入框连同光标位置一起活下来。直播中的 run 几百毫秒一个事件，
 * 旧实现下这个输入框根本没法用。
 */
function patchApprovalRail(parts, state, isRunning, callbacks) {
  /**
   * **只有待处理的进 rail**（委托方反馈）。
   *
   * 此前这里渲染 `state.pendingApprovals` 全量——那个数组同时装着已决的，
   * 于是长运行下审批卡无限堆叠、已处理与未处理混在一起，既难读又难操作。
   * 已决的本来就在概览「审批记录」里有留档，留在 rail 上是同一条在两处
   * 重复展示（V-16 修过的同一个毛病），而 rail 的语义是"需你现在决定"。
   *
   * 但也不能点完就凭空消失——那样人不确定自己那一下有没有生效。
   * 折中：已决的折叠成一行摘要留在 rail 底部，展开是紧凑列表而不是完整卡片。
   */
  const list = state.pendingApprovals.filter((a) => a.status === "pending");
  const resolved = state.pendingApprovals.filter((a) => a.status !== "pending");
  patchResolvedSummary(parts, resolved);

  setAttr(parts.approvals, "hidden", list.length > 0 ? null : "");
  if (list.length === 0) {
    patchList(parts.approvals, [], { key: (a) => a.approvalId || a.toolUseId, create: () => document.createElement("div") });
    return;
  }

  patchList(parts.approvals, list, {
    key: (a) => a.approvalId || a.toolUseId,
    create: (a) => {
      const card = document.createElement("div");
      card.className = "approval-card";
      card.setAttribute("data-approval-id", a.approvalId || a.toolUseId);
      card.innerHTML =
        '<div class="approval-card-header">' +
        '<span class="approval-tool-name"></span>' +
        '<span class="approval-result" hidden></span>' +
        "</div>" +
        '<pre class="approval-input"></pre>' +
        '<div class="approval-actions" hidden>' +
        '<button class="btn btn--allow" data-action="allow">允许本次</button>' +
        // 规则只复用同一工具 + 完全相同参数，并受 TTL/次数/工具策略限制
        '<button class="btn btn--allow-always" data-action="allow-always">短期允许相同参数</button>' +
        '<button class="btn btn--deny" data-action="deny">拒绝并说明</button>' +
        '<input class="deny-reason" placeholder="拒绝理由（可选）" />' +
        "</div>" +
        '<div class="approval-meta" hidden></div>' +
        '<div class="approval-reason" hidden></div>';

      const cardId = a.approvalId || a.toolUseId;
      const input = card.querySelector(".deny-reason");
      input.setAttribute("data-fk", `approval:${cardId}:reason`);
      card.querySelector("[data-action='allow']").addEventListener("click", () => {
        callbacks.onAllow?.(cardId);
      });
      card.querySelector("[data-action='allow-always']").addEventListener("click", () => {
        callbacks.onAllowAlways?.(cardId, a.name);
      });
      card.querySelector("[data-action='deny']").addEventListener("click", () => {
        callbacks.onDenyReason?.(cardId, input.value.trim());
      });
      updateApprovalCard(card, a, isRunning);
      return card;
    },
    update: (card, a) => updateApprovalCard(card, a, isRunning),
  });
}

/**
 * 已处理审批的折叠摘要：一行统计 + 可展开的紧凑列表。
 * 展开态用 `<details>` 原生实现——它自带键盘可达与展开状态保持，
 * 比自己拿 button + hidden 拼一套稳。
 */
function patchResolvedSummary(parts, resolved) {
  const host = parts.approvalsDone;
  if (!host) return;
  if (resolved.length === 0) {
    setAttr(host, "hidden", "");
    host.innerHTML = "";
    parts.sig.approvalsDone = null;
    return;
  }
  const counts = { allowed: 0, denied: 0, expired: 0 };
  for (const a of resolved) counts[a.status] = (counts[a.status] ?? 0) + 1;
  const sig = signature([resolved.length, counts.allowed, counts.denied, counts.expired]);
  if (parts.sig.approvalsDone === sig) return;
  parts.sig.approvalsDone = sig;

  setAttr(host, "hidden", null);
  const parts_ = [];
  if (counts.allowed) parts_.push(`允许 ${counts.allowed}`);
  if (counts.denied) parts_.push(`拒绝 ${counts.denied}`);
  if (counts.expired) parts_.push(`过期 ${counts.expired}`);
  // details/summary 的展开态由浏览器保持，重渲染时不会被合上
  const wasOpen = host.querySelector("details")?.open ?? false;
  host.innerHTML =
    `<details class="approvals-done"${wasOpen ? " open" : ""}>` +
    `<summary>已处理 ${resolved.length} 项 · ${esc(parts_.join(" · "))}</summary>` +
    '<ul class="approvals-done-list">' +
    resolved
      .map((a) => {
        const label = a.status === "allowed" ? "✓ 允许" : a.status === "denied" ? "✗ 拒绝" : "⋯ 过期";
        const when = a.decidedAt ? ` · ${new Date(a.decidedAt).toLocaleTimeString()}` : "";
        const why = a.reason ? ` · ${esc(a.reason)}` : "";
        return `<li><span class="approvals-done-mark">${esc(label)}</span> ${esc(a.name)}${esc(when)}${why}</li>`;
      })
      .join("") +
    "</ul></details>";
}

function updateApprovalCard(card, a, isRunning) {
  const isPending = a.status === "pending";
  /**
   * 这是**兜底**，不是主闸——说清楚免得高估它。
   *
   * 唯一的调用路径 `patchApprovalRail` 已经把列表过滤成 pending-only，
   * 所以这里 `isPending` 恒真；变异测试（改成 `operable = true`）不会让任何
   * 一条测试变红。真正在守 R-01 的是三处：reducer 在 run_end/error 上把
   * pending 收敛成 expired、rail 的 pending-only 过滤、服务端两路 409。
   * 留着它是防"reducer 漏掉某条终止路径"，不是防用户。
   */
  const operable = isPending && isRunning;
  const resolved = !isPending;

  setClass(card, "approval-card--resolved", resolved);
  setText(card.querySelector(".approval-tool-name"), `⚠ ${a.name}`);

  const resultEl = card.querySelector(".approval-result");
  if (resolved) {
    const label = a.status === "allowed" ? "已允许" : a.status === "denied" ? "已拒绝" : "已过期";
    const mod = a.status === "allowed" ? "allow" : a.status === "denied" ? "deny" : "expired";
    setAttr(resultEl, "hidden", null);
    setText(resultEl, label);
    resultEl.className = `approval-result approval-result--${mod}`;
  } else {
    setAttr(resultEl, "hidden", "");
  }

  setText(card.querySelector(".approval-input"), formatInput(a.input));
  card.querySelector(".deny-reason").setAttribute(
    "aria-label",
    `拒绝 ${a.name} 的理由（可选）`,
  );

  // 只切显隐，不重建——输入框节点必须原地存活
  setAttr(card.querySelector(".approval-actions"), "hidden", operable ? null : "");
  const reusable = a.grantPolicy?.maxScope === "exact-input";
  const reusableButton = card.querySelector("[data-action='allow-always']");
  setAttr(reusableButton, "hidden", operable && reusable ? null : "");
  if (reusable) {
    setAttr(
      reusableButton,
      "title",
      `最多复用 ${Number(a.grantPolicy.maxUses ?? 0)} 次，最长 ${Math.round(Number(a.grantPolicy.maxTtlMs ?? 0) / 60000)} 分钟`,
    );
  } else {
    setAttr(reusableButton, "title", "该工具策略只允许单次审批");
  }

  const metaEl = card.querySelector(".approval-meta");
  setAttr(metaEl, "hidden", resolved && a.decidedAt ? null : "");
  if (resolved && a.decidedAt) setText(metaEl, formatTime(a.decidedAt));

  const reasonEl = card.querySelector(".approval-reason");
  setAttr(reasonEl, "hidden", resolved && a.reason ? null : "");
  if (resolved && a.reason) setText(reasonEl, `理由：${a.reason}`);
}

/**
 * 结果卡：恒在、恒展开。
 *
 * 排序刻意把核查结论放在执行者报告之前——委托方 §6 的要求是"无需展开日志
 * 即可判断结果"，而执行者的自述与核查者的裁决不是一回事，后者才是结论。
 */
function pathWithoutLineRef(value) {
  return String(value ?? "").trim().replace(/:\d+(?::\d+)?$/, "");
}

function pathBasename(value) {
  const clean = pathWithoutLineRef(value).replace(/[\\/]+$/, "");
  return clean.slice(Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\")) + 1);
}

function joinDisplayedPath(dir, file) {
  const clean = String(dir ?? "").replace(/[\\/]+$/, "");
  const separator = clean.includes("\\") && !clean.includes("/") ? "\\" : "/";
  return `${clean}${separator}${file}`;
}

/**
 * 给每个显示值列出按优先级排列的实际探测路径。
 *
 * 裸文件名本身信息不足：截图里的 `index.html` 实际位于同一句已经提到的
 * `threejs-fps-game/` 下。这里先用已确认产物的唯一 basename，再试同消息目录，
 * 最后才试工作目录根；只有服务端 stat 成功的那一项会真正变成链接。
 */
export function buildLocalPathProbePlan(labels, artifactPaths = []) {
  const uniqueLabels = [...new Set((labels ?? []).map((v) => String(v ?? "").trim()).filter(Boolean))];
  const directories = uniqueLabels
    .map(pathWithoutLineRef)
    .filter((v) => /[\\/]$/.test(v));
  const artifacts = [...new Set((artifactPaths ?? []).map((v) => String(v ?? "").trim()).filter(Boolean))];

  const entries = uniqueLabels.map((label) => {
    const target = pathWithoutLineRef(label);
    const choices = [];
    const hasSeparator = /[\\/]/.test(target);
    const isDirectory = /[\\/]$/.test(target);
    if (!hasSeparator && !isDirectory) {
      const byBasename = artifacts.filter(
        (path) => pathBasename(path).toLocaleLowerCase() === target.toLocaleLowerCase(),
      );
      if (byBasename.length === 1) choices.push(byBasename[0]);
      for (const dir of directories) choices.push(joinDisplayedPath(dir, target));
    }
    choices.push(target);
    const deduped = [...new Map(choices.map((v) => [v.toLocaleLowerCase(), v])).values()];
    return { label, choices: deduped };
  });
  return {
    entries,
    probes: [...new Map(entries.flatMap((e) => e.choices).map((v) => [v.toLocaleLowerCase(), v])).values()],
  };
}

function makePathIcon(name) {
  const icon = document.createElement("i");
  icon.className = `ph ph-${name}`;
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

function decorateLocalPathCode(code, hit, runId) {
  if (!code?.parentNode || !hit?.path || !hit?.kind) return;
  const shell = document.createElement("span");
  shell.className = `local-path-ref local-path-ref--${hit.kind}`;
  code.classList.add("local-path-code");
  code.removeAttribute("data-local-path");
  code.setAttribute("data-path-state", "linked");

  if (hit.kind === "file") {
    const href = `/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(hit.path)}`;
    const link = document.createElement("a");
    link.className = "local-path-link";
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = `打开文件：${hit.path}`;
    code.parentNode.insertBefore(shell, code);
    link.append(code, makePathIcon("arrow-square-out"));
    shell.append(link);

    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "local-path-folder";
    reveal.dataset.pathReveal = hit.path;
    reveal.title = "在文件夹中显示";
    reveal.setAttribute("aria-label", `在文件夹中显示 ${hit.path}`);
    reveal.append(makePathIcon("folder-open"));
    shell.append(reveal);
    return;
  }

  const open = document.createElement("button");
  open.type = "button";
  open.className = "local-path-link local-path-link--directory";
  open.dataset.pathReveal = hit.path;
  open.title = `打开文件夹：${hit.path}`;
  open.setAttribute("aria-label", `打开文件夹 ${hit.path}`);
  code.parentNode.insertBefore(shell, code);
  open.append(code, makePathIcon("folder-open"));
  shell.append(open);
}

function bindLocalPathActions(host, callbacks) {
  if (!host) return;
  host.__pathReveal = callbacks?.onReveal;
  if (host.__pathActionBound) return;
  host.__pathActionBound = true;
  host.addEventListener("click", (event) => {
    const target = event.target instanceof Element
      ? event.target.closest("[data-path-reveal]")
      : null;
    if (!target) return;
    event.preventDefault();
    host.__pathReveal?.(target.getAttribute("data-path-reveal"));
  });
}

async function hydrateLocalPathLinks(host, state, callbacks) {
  if (!host || typeof callbacks?.inspectPaths !== "function") return;
  bindLocalPathActions(host, callbacks);
  const nodes = [...host.querySelectorAll('code[data-local-path]:not([data-path-state])')];
  if (nodes.length === 0) return;
  for (const node of nodes) node.setAttribute("data-path-state", "checking");

  const labels = nodes.map((node) => node.getAttribute("data-local-path") ?? "");
  const artifactPaths = deriveArtifacts(state).map((artifact) => artifact.path);
  const plan = buildLocalPathProbePlan(labels, artifactPaths);
  let inspected = [];
  try {
    inspected = await callbacks.inspectPaths(plan.probes.slice(0, 64));
  } catch {
    // 路径链接是渐进增强：宿主不可达时正文仍完整可读
  }
  const byInput = new Map(
    (Array.isArray(inspected) ? inspected : [])
      .filter((item) => item?.exists && item?.input)
      .map((item) => [String(item.input).toLocaleLowerCase(), item]),
  );
  const choiceByLabel = new Map(
    plan.entries.map((entry) => [
      entry.label,
      entry.choices.map((choice) => byInput.get(choice.toLocaleLowerCase())).find(Boolean) ?? null,
    ]),
  );

  for (const node of nodes) {
    if (!host.contains(node) || node.getAttribute("data-path-state") !== "checking") continue;
    const label = node.getAttribute("data-local-path") ?? "";
    const hit = choiceByLabel.get(label);
    if (hit) decorateLocalPathCode(node, hit, state.runId);
    else node.setAttribute("data-path-state", "plain");
  }
}

/**
 * 对话主干的补丁。
 *
 * 签名只看 `lastSeq` 与条目数：事件流单调追加，这两个数不变就没有新内容。
 * 与日志面同款——重画整段对话会打断正在展开的 details 与用户的滚动位置。
 */
function patchConversation(parts, state, live, callbacks) {
  const host = parts.conversation;
  if (!host) return;
  const items = deriveChatItems(state, live);

  if (items.length === 0) {
    host.__patchNodes = undefined;
    host.innerHTML =
      state.status === "running"
        ? '<p class="empty-note">刚开始，还没有内容。</p>'
        : '<p class="empty-note">这次运行没有产生对话内容。</p>';
    return;
  }
  const empty = host.querySelector(".empty-note");
  if (empty) empty.remove();

  /**
   * **键控补丁，不是整段重画。**
   *
   * 初版这里是一句 `innerHTML = renderChatStream(...)`。流式一开，签名每来一个
   * 字就变一次，于是整段对话每秒重建几十遍——后果是**用户点开的思考过程当场
   * 被关上**（`<details open>` 随节点一起没了），滚动位置也一起归零。
   * 委托方那句"点开思考过程就应该永远显示"，缺的正是这一层。
   *
   * 这也正是本仓 V-10 早就定下的纪律（已存在 key 的节点永不重建，只更新），
   * 我在把对话搬成主干时把它漏掉了。
   */
  /**
   * **贴底跟随**：人在底部就跟着新内容往下走，人往上翻了就别动他
   * （委托方："在流式的情况下在最底部的时候应该一直往下移动，
   *  然后不在最底部的时候就不往下移动"）。
   *
   * 这是 GitHub Actions / 各家日志面板的标准行为，本仓的 `keepScrollAnchored`
   * 早就实现了它，只是**日志面在用、对话没接**——而流式恰恰全在对话里，
   * 于是"正在写"的那一段每次都长在视野之外。
   */
  const scroller = host.closest(".content-area") || host;
  keepScrollAnchored(scroller, () => {
  patchList(host, items, {
    key: (it) => it.key,
    create: (it) => {
      const node = document.createElement("div");
      node.className = "chat-item";
      node.__sig = chatItemSig(it);
      node.innerHTML = renderChatItem(it, thinkingPrefOpen());
      return node;
    },
    update: (node, it) => {
      const sig = chatItemSig(it);
      if (node.__sig === sig) return;
      node.__sig = sig;
      // 流式那条**就地改文本**，绝不重建：它每来一个字就走一次这里，
      // 重建等于把用户刚点开的 details 一秒关上几十遍
      if (it.kind === "live" && updateLiveNode(node, it)) return;
      node.innerHTML = renderChatItem(it, thinkingPrefOpen());
    },
  });
  });
  void hydrateLocalPathLinks(host, state, callbacks);
}

/**
 * 就地更新流式条目。
 *
 * 只改文本节点与字数，不动 DOM 结构——于是 `<details open>` 天然保住，
 * 滚动位置也不跳。结构还不存在时（第一次出现思考、或思考之后才开口）
 * 返回 false，交给调用方整条渲染一次。
 *
 * @returns {boolean} 是否已就地更新完毕
 */
function updateLiveNode(node, it) {
  const wantThinking = Boolean(it.thinking.trim());
  const wantText = Boolean(it.text.trim());
  const thinkEl = node.querySelector(".chat-thinking--live");
  const textEl = node.querySelector(".chat-msg--live");
  // 结构与需求不一致 = 有新块要出现，只能重建一次
  if (wantThinking !== Boolean(thinkEl) || wantText !== Boolean(textEl)) return false;

  if (thinkEl) {
    setText(thinkEl.querySelector(".chat-live-text"), it.thinking);
    setText(thinkEl.querySelector(".aside-peek"), `${it.thinking.length} 字`);
  }
  if (textEl) setText(textEl.querySelector(".chat-live-text"), it.text);
  return true;
}

/** 一条对话条目的可变部分——只有它变了才重建那一条 */
function chatItemSig(it) {
  switch (it.kind) {
    case "live":
      return `live:${it.thinking.length}:${it.text.length}`;
    case "tool":
      return `tool:${it.status}:${it.gated ? 1 : 0}:${it.durationMs ?? ""}:${(it.result ?? "").length}`;
    case "verdict":
      return `verdict:${JSON.stringify(it.verdict)}`;
    default:
      return `${it.kind}:${(it.text ?? "").length}`;
  }
}

/**
 * "思考过程展开与否"是**用户的偏好**，不是每条消息各自的状态。
 *
 * 委托方的原话是"点开的时候就永远显示流式的思考过程，再点一次关闭就不看"——
 * 也就是说这个开关一次设定、后续每一轮都照办。逐条记的话，每来一轮新思考
 * 又是收起的，等于每轮都要再点一次。存进 localStorage，跨会话也保持。
 */
const THINKING_PREF_KEY = "agent-ui-thinking-open";

function thinkingPrefOpen() {
  try {
    return localStorage.getItem(THINKING_PREF_KEY) === "1";
  } catch {
    return false; // 隐私模式下读不到就按收起处理，不影响主流程
  }
}

/**
 * 展开/收起思考块时记住偏好。
 * 用**事件委托**绑在对话容器上（`toggle` 事件不冒泡，所以监听 summary 的 click），
 * 这样键控补丁重建条目时不会漏绑、也不会重复绑。
 */
function bindThinkingPref(host) {
  if (!host || host.__thinkingBound) return;
  host.__thinkingBound = true;
  host.addEventListener("click", (e) => {
    const summary = e.target instanceof Element ? e.target.closest("summary") : null;
    const details = summary && summary.parentElement;
    if (!details || !details.classList.contains("chat-thinking")) return;
    // click 先于浏览器切换 open，所以这里取反才是切换后的值
    try {
      localStorage.setItem(THINKING_PREF_KEY, details.open ? "0" : "1");
    } catch {
      // 写不进去也不影响本次展开，静默
    }
  });
}

/**
 * 右栏：有子任务才出现。
 *
 * 编排模式下 planner 会把任务拆成一张带依赖的子任务图——那正是"子 agent 在做
 * 什么"。它此前埋在 Loop 面的下钻里，跟"当前这一步进行到哪"隔了两层。
 * 放到对话右侧之后，读对话与看进度是同一屏。
 */
function patchDetailRail(parts, state, faces, callbacks) {
  if (!parts.rail) return;
  const plan = faces.plan;
  const files = deriveArtifacts(state);
  // 判据是"这是不是一次编排运行"，**不是"有没有子任务"**：
  // planner fail-closed 时子任务为空，而那句"未能产出可解析计划"最该被看见
  setAttr(parts.rail, "hidden", plan || files.length > 0 ? null : "");
  setAttr(parts.railBoard, "hidden", plan ? null : "");
  if (plan) patchPlanBoard(parts, parts.railBoard, plan);
  patchArtifacts(parts, files, state.runId, callbacks);
}

/**
 * 产物清单。
 *
 * 「预览」与「下载」都走宿主的 `/api/runs/:id/artifact`——浏览器一律拦截
 * http 页面跳 `file://`，所以本地文件必须由宿主取给它。
 * 「在文件夹中显示」是**从网页请求启动本机进程**，圈禁在服务端（同一套
 * resolveInWorkdir），这里只负责把路径原样交上去。
 */
function patchArtifacts(parts, files, runId, callbacks) {
  const host = parts.artifacts;
  if (!host) return;
  setAttr(host, "hidden", files.length > 0 ? null : "");
  const sig = signature(files.map((f) => `${f.path}:${f.writes}`));
  if (parts.sig.artifacts === sig) return;
  parts.sig.artifacts = sig;

  host.innerHTML =
    `<h3 class="rail-title">产物 <span class="aside-peek">${files.length}</span></h3>` +
    files
      .map((f) => {
        const href = `/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(f.path)}`;
        // 写了不止一次时说出来：那通常意味着返工，看的人有权知道这不是一稿过
        const times = f.writes > 1 ? `<span class="aside-peek">改 ${f.writes} 次</span>` : "";
        return (
          '<div class="artifact">' +
          `<a class="artifact-name" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(f.path)}">${esc(f.path)}</a>` +
          `${times}` +
          '<div class="artifact-actions">' +
          `<a class="artifact-btn" href="${esc(href)}&download=1">下载</a>` +
          `<button type="button" class="artifact-btn" data-reveal="${esc(f.path)}">在文件夹中显示</button>` +
          "</div></div>"
        );
      })
      .join("");

  // 事件委托：清单每次重画，逐个绑会漏也会重
  if (!host.__revealBound) {
    host.__revealBound = true;
    host.addEventListener("click", (e) => {
      const btn = e.target instanceof Element ? e.target.closest("[data-reveal]") : null;
      if (btn) callbacks.onReveal?.(btn.getAttribute("data-reveal"));
    });
  }
}

function patchOutcomeCard(parts, state, overview, faces) {
  const v = faces.verification;
  const loop = faces.loop;
  const summary = overview.resultSummary;
  const sig = signature([
    state.status, state.stopReason, state.error, v.badge,
    v.verdict ? JSON.stringify(v.verdict) : "", loop.reworks, summary,
  ]);
  if (parts.sig.outcome === sig) return;
  parts.sig.outcome = sig;

  /**
   * **对话成为主干之后，这张卡里三样东西变成了重复展示**（V-16 的老问题换了个现场）：
   *   · 「执行者报告」= 最后一条 assistant 文本 = 对话里的最后一条消息；
   *   · 裁决徽章 / summary / issues = 对话末尾那张 `.chat-verdict`；
   *   · 「运行中，尚无最终结果。」——运行中本来就在对话里逐条长出来，这句纯噪声。
   * 委托方直接指了第三样：「这个框框可以不用了」。
   *
   * 于是收缩成**一条收尾条**，只保留对话里没有的那件事：**这次是怎么结束的**
   * （六值终止原因 + 它的补救提示 + 错误原文 + 返工轮数）。运行中整条隐藏。
   */
  if (state.status === "running") {
    setAttr(parts.outcome, "hidden", "");
    parts.outcome.innerHTML = "";
    return;
  }
  setAttr(parts.outcome, "hidden", null);

  const cls = classifyStopReason(state.stopReason);
  const rework = loop.reworks > 0
    ? `<span class="outcome-note">返工 ${loop.reworks} 轮后${v.verdict && v.verdict.passed ? "通过" : "仍未过"}</span>`
    : "";

  /**
   * **正常收尾什么都不显示。**（委托方："这个可以不用了……过于占空间了"）
   *
   * 一条横贯整屏、只写着「■ 已完成」的条，说的是读对话就能知道的事——
   * 对话到此为止本身就是"完成了"。占一整行去讲一句废话，是在跟真正有话说的
   * 那几种收尾抢版面。
   *
   * 反过来，**非正常收尾必须留着**：撞轮数上限、撞 token、出错、被否决——
   * 这几种对话里看不出来（对话只是"停了"），而且各有各的下一步。
   * 返工过的也留：那是"通过之前失败过几次"，不说就丢了。
   * 判据一句话：**只在有话要说的时候占位。**
   */
  const quiet = cls.tone === "ok" && !cls.hint && !state.error && loop.reworks === 0;
  if (quiet) {
    setAttr(parts.outcome, "hidden", "");
    parts.outcome.innerHTML = "";
    return;
  }

  let html =
    `<div class="outcome-line outcome-line--${cls.tone}">` +
    `<span class="outcome-mark">■</span> ${esc(cls.label)}${rework}</div>`;
  // 终止原因的补救提示：撞轮数 / 撞 token 各有各的下一步，这是六值分档的全部意义
  if (cls.hint) html += `<p class="outcome-hint">${esc(cls.hint)}</p>`;
  if (state.error) html += `<p class="outcome-error">${esc(state.error)}</p>`;

  parts.outcome.innerHTML = html;
}

function verdictBadgeLabel(badge) {
  return {
    pass: "✔ 核查通过",
    pass_with_notes: "✔ 通过（有备注）",
    fail: "✘ 核查未通过",
    pending: "⋯ 尚未核查",
  }[badge] ?? "⋯ 尚未核查";
}

/**
 * 四决定因素网格 (V-17)。
 *
 * 异常面自动加权并排到首位——用户第一眼该看到的是"哪一面出了问题"，
 * 而不是四张长得一样的卡片。
 */
function patchFactorGrid(parts, faces, activeTab, callbacks) {
  const cards = buildFactorCards(faces);
  const sig = signature([
    JSON.stringify(cards.map((c) => [c.id, c.abnormal, c.lines.join("~")])),
    activeTab,
  ]);
  if (parts.sig.factors === sig) return;
  parts.sig.factors = sig;

  patchList(parts.factorGrid, cards, {
    key: (c) => c.id,
    create: (c) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "factor-card";
      el.id = `tab-${c.id}`;
      el.setAttribute("role", "tab");
      el.setAttribute("aria-controls", "tab-content");
      el.setAttribute("data-factor", c.id);
      el.setAttribute("data-tab", c.id);
      el.innerHTML =
        '<span class="factor-title"></span><span class="factor-lines"></span>';
      el.addEventListener("click", () => switchToFace(c.id));
      // roving tabindex 下 Tab 只进当前项，组内移动靠方向键——没有这段，
      // 未选中的面就彻底不可键盘到达（比不做 roving 更糟）
      el.addEventListener("keydown", (e) => {
        const key = /** @type {KeyboardEvent} */ (e).key;
        const all = [...parts.factorGrid.querySelectorAll('[role="tab"]')];
        const idx = all.indexOf(el);
        let next = -1;
        if (key === "ArrowRight" || key === "ArrowDown") next = (idx + 1) % all.length;
        else if (key === "ArrowLeft" || key === "ArrowUp") next = (idx - 1 + all.length) % all.length;
        else if (key === "Home") next = 0;
        else if (key === "End") next = all.length - 1;
        if (next < 0) return;
        e.preventDefault();
        switchToFace(all[next].getAttribute("data-tab"));
      });
      updateFactorCard(el, c, activeTab);
      return el;
    },
    update: (el, c) => updateFactorCard(el, c, activeTab),
  });

  setAttr(parts.tabContent, "aria-labelledby", `tab-${activeTab}`);
}

function switchToFace(tab) {
  if (tab) document.dispatchEvent(new CustomEvent("tab-switch", { detail: { tab } }));
}

function updateFactorCard(el, c, activeTab) {
  const isActive = c.id === activeTab;
  setClass(el, "factor-card--abnormal", c.abnormal);
  setClass(el, "factor-card--active", isActive);
  setAttr(el, "aria-selected", String(isActive));
  setAttr(el, "tabindex", isActive ? "0" : "-1");
  setText(el.querySelector(".factor-title"), c.title);
  // 名称里带上"当前查看"，屏幕阅读器才知道这一张既是摘要也是当前选中的面
  setAttr(el, "aria-label", `${c.title}：${c.lines.join("，")}${isActive ? "。当前查看" : "。查看详情"}`);
  el.querySelector(".factor-lines").innerHTML = c.lines
    .map((l) => `<span class="factor-line">${esc(l)}</span>`)
    .join("");
}

/** 四张卡的内容与异常判定，纯函数——可直测 */
export function buildFactorCards(faces) {
  const { loop, context, tools, verification: v } = faces;

  const loopLines = [];
  loopLines.push(loop.maxTurns ? `${loop.turn}/${loop.maxTurns} 轮` : `${loop.turn} 轮`);
  if (loop.stopReason) loopLines.push(`■ ${loop.stopReason.label}`);
  if (loop.reworks > 0) loopLines.push(`↺ 返工 ${loop.reworks} 轮`);
  if (loop.retries.length > 0) loopLines.push(`⟳ 重试 ${loop.retries.length} 次已自愈`);
  if (loop.effort) loopLines.push(`effort ${loop.effort}${loop.effortApplies ? "" : "（compat 下不发送）"}`);
  // 恢复策略与它的触发记录并排：配了几轮续跑、这次到底触发了几次
  const recoveryLine = describeRecoveryPolicy(loop.recovery);
  if (recoveryLine) loopLines.push(recoveryLine);
  if ((loop.recoveryDecisions?.length ?? 0) > 0) {
    loopLines.push(`⤷ 恢复决策 ${loop.recoveryDecisions.length} 次`);
  }

  const ctxLines = [];
  if (context.limit) {
    ctxLines.push(`本轮输入 ${formatTokens(context.lastInputTokens)} / ${formatTokens(context.limit)}`);
  } else {
    ctxLines.push(`本轮输入 ${formatTokens(context.lastInputTokens)}`);
  }
  ctxLines.push(`缓存命中 ${(context.cacheHitRatio * 100).toFixed(0)}%`);
  if (context.compactions.length > 0) {
    ctxLines.push(
      `⚠ 压缩 ${context.compactions.length} 次 · 置换 ${context.droppedBlocks} 块原文` +
        ((context.collapsedTurns ?? 0) > 0 ? ` · 折叠 ${context.collapsedTurns} 轮旧对话` : "") +
        ((context.reactiveCount ?? 0) > 0 ? ` · 撞 400 后反应式 ${context.reactiveCount} 次` : "") +
        ` · 账本 ${context.ledgerEntries ?? 0} 条` +
        ((context.summaryAppliedCount ?? 0) > 0
          ? ` · LLM 摘要 ${context.summaryAppliedCount} 次`
          : ""),
    );
  }

  const toolLines = [];
  toolLines.push(tools.pack?.name ? `包 ${tools.pack.name}` : "无领域包");
  toolLines.push(`${tools.tools.length} 个工具 · 调用 ${tools.totalCalls} 次`);
  if (tools.totalErrors > 0) toolLines.push(`✗ 失败 ${tools.totalErrors} 次`);
  if (tools.denials.length > 0) toolLines.push(`⊘ 被拒 ${tools.denials.length} 次`);
  if (tools.readRoots.length > 0) toolLines.push(`只读根 ${tools.readRoots.length} 个`);
  if (tools.executionIsolation) {
    const state = tools.executionIsolation.effectiveState;
    toolLines.push(
      state === "partial"
        ? "隔离：部分（仅 bash）"
        : state === "report-only"
          ? "⚠ 隔离：仅报告，宿主直跑"
          : state === "direct"
            ? "⚠ 隔离：关闭，宿主直跑"
            : "✗ 隔离：required 不可用",
    );
  }

  const vLines = [verdictBadgeLabel(v.badge)];
  if (v.verdict) {
    const bits = [];
    if (v.verdict.unverified.length) bits.push(`⋯ ${v.verdict.unverified.length}`);
    if (v.verdict.advisory.length) bits.push(`◈ ${v.verdict.advisory.length}`);
    if (bits.length) vLines.push(bits.join(" · "));
  }
  if (v.starvation.noWhitelist) vLines.push("⚠ verifier 无白名单（核查饥饿）");
  if (v.starvation.emptyRework.length > 0) vLines.push("⚠ 返工零写入（疑似核查饥饿）");
  if (v.starvation.parseFail) vLines.push("⚠ 裁决解析失败（fail-closed 误伤）");

  const cards = [
    {
      id: "loop", title: "Loop 循环", lines: loopLines,
      abnormal: Boolean(loop.stopReason && loop.stopReason.tone !== "ok") || loop.nearLimit,
    },
    {
      id: "context", title: "Context 上下文", lines: ctxLines,
      abnormal: context.compactions.length > 0 || context.nearWatermark,
    },
    {
      id: "tools", title: "Tools 工具", lines: toolLines,
      abnormal:
        tools.totalErrors > 0 || tools.denials.length > 0 ||
        ["direct", "report-only", "failed"].includes(tools.executionIsolation?.effectiveState),
    },
    {
      id: "verify", title: "Verification 核查", lines: vLines,
      abnormal:
        v.badge === "fail" || v.badge === "pass_with_notes" ||
        (v.verdict?.unverified.length ?? 0) > 0 ||
        v.starvation.noWhitelist || v.starvation.parseFail ||
        v.starvation.emptyRework.length > 0,
    },
  ];

  // 异常面排到首位（稳定排序：同为异常/正常者保持声明顺序）
  return [...cards.filter((c) => c.abnormal), ...cards.filter((c) => !c.abnormal)];
}

// patchTabNav 已移除：四张因子卡直接充当 tablist（见 patchFactorGrid）。
// 此前卡片下面另起一行同名标签，两排四个一模一样的词，是纯粹的重复导航；
// 更要命的是两者的成员还不一致——卡片恒为四张，而标签栏在没有核查记录时
// 只渲染三个，于是点第四张卡会切到一个根本不存在的标签，tabpanel 的
// aria-labelledby 随之指向空引用（悬空引用，屏幕阅读器报不出面板名）。

function patchTabContent(parts, state, activeTab, overview, logEntries, callbacks, faces) {
  const container = parts.tabContent;

  // 换标签页时内容形态完全不同，直接重建；同一标签内走各自的增量策略
  if (container.__tab !== activeTab) {
    container.innerHTML = "";
    container.__patchNodes = undefined;
    container.__tab = activeTab;
    parts.sig.tabBody = null;
    // 对话视图的签名也要一起作废。漏掉它的后果是：切走再切回 Loop 面时
    // 对话主干在抽屉之外、不随标签重建；这里保留清签名是防御性的
    parts.sig.chat = null;
    if (activeTab === "loop") {
      /**
       * V-23 原本在这里放"事件流 / 对话"两种读法的切换。
       * **对话已经升为主干**（在抽屉外、常驻、实时），这里只剩事件流——
       * 同一件事有两个入口，用户就得先决定"该看哪个"，那正是委托方说的难用。
       * 事件流留在这里的定位随之收窄：逐工具、逐结果的**取证视图**。
       */
      container.innerHTML =
        // 计划盘已搬到右栏（子任务是"谁在做什么"，属于进度不属于取证）
        '<h3 class="overview-section-title">执行事件流</h3>' +
        '<div class="rework-chain"></div>' +
        '<div class="log-entries"></div>';
      container.__logHost = container.querySelector(".log-entries");
    }
  }

  if (activeTab === "loop") {
    patchReworkChain(container.querySelector(".rework-chain"), faces.loop);
    patchLoopView(parts, container, state, logEntries, callbacks);
    return;
  }

  // context / tools / verify：无输入控件、无滚动锚点，签名变了整体重绘即可
  const sig =
    activeTab === "context"
      ? signature([
          faces.context.lastInputTokens, faces.context.limit,
          faces.context.compactions.length, faces.context.droppedBlocks,
          faces.context.ledgerEntries ?? 0, faces.context.perTurn.length,
          faces.context.collapsedTurns ?? 0, faces.context.reactiveCount ?? 0,
        ])
      : activeTab === "tools"
        ? signature([
            faces.tools.totalCalls, faces.tools.totalErrors,
            faces.tools.tools.length, faces.tools.denials.length,
            faces.tools.reroutes.length, faces.tools.pack?.name ?? "",
          ])
        : signature([
            state.verifierTimeline.length,
            state.verdict ? JSON.stringify(state.verdict) : "",
            faces.verification.rounds.length,
            JSON.stringify(faces.verification.starvation),
          ]);
  if (parts.sig.tabBody === sig) return;
  parts.sig.tabBody = sig;

  container.innerHTML =
    activeTab === "context"
      ? renderContextTab(faces.context)
      : activeTab === "tools"
        ? renderToolsTab(faces.tools)
        : renderVerifyTab(state, faces.verification);
}

/** 返工裁决序列：main ─■─▶ verifier ✘ ─↺─▶ rework ─■─▶ verifier ✔ */
function patchReworkChain(host, loop) {
  if (!host) return;
  if (loop.chain.length <= 1) {
    host.innerHTML = "";
    setAttr(host, "hidden", "");
    return;
  }
  setAttr(host, "hidden", null);
  const roleLabel = { main: "主轮", rework: "返工", verifier: "核查" };
  host.innerHTML = foldChain(loop.chain)
    .map((c) => {
      const mark = c.role === "verifier" ? (c.passed === null ? "⋯" : c.passed ? "✔" : "✘") : "■";
      const tone = c.role === "verifier" ? (c.passed === null ? "pending" : c.passed ? "ok" : "bad") : "neutral";
      const label = c.role === "rework" ? `↺ ${roleLabel[c.role]}` : roleLabel[c.role];
      const round = c.role === "main" ? "" : ` ${c.round}`;
      const times = c.count > 1 ? ` ×${c.count}` : "";
      return `<span class="chain-node chain-node--${tone}">${mark} ${esc(label)}${round}${times}</span>`;
    })
    .join('<span class="chain-arrow">▸</span>');
}

/**
 * 连续的主轮折叠成一个带计数的节点。
 *
 * 这条链要表达的是"执行 → 核查 → 返工"的**交替结构**。多轮对话下会出现
 * 二十几个连着的 main 段，逐个画出来就是一排一模一样的「■ 主轮」——
 * 委托方截图里那一行占满整屏却零信息量。计数版既保住了结构，也说清了有多少轮。
 *
 * 只折叠 main：核查与返工每一次都是独立事件，合并会把"返工了三次"抹平成一个。
 */
export function foldChain(chain) {
  const out = [];
  for (const c of chain ?? []) {
    const last = out[out.length - 1];
    if (last && last.role === c.role && c.role === "main") last.count += 1;
    else out.push({ ...c, count: 1 });
  }
  return out;
}

/** Context 面下钻：逐轮 token 与压缩点 */
function renderContextTab(ctx) {
  let html = '<h3 class="overview-section-title">上下文水位</h3>';

  if (ctx.limit) {
    const pct = Math.round((ctx.ratio ?? 0) * 100);
    html += '<div class="meter" role="progressbar"' +
      ` aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"` +
      ` aria-label="上下文水位 ${pct}%">`;
    html += `<div class="meter-fill" style="width:${pct}%"></div>`;
    html += `<div class="meter-threshold" style="left:${Math.round(ctx.watermark * 100)}%"></div>`;
    html += "</div>";
    html += `<p class="meter-note">最近一轮输入 ${formatTokens(ctx.lastInputTokens)} / 上限 ${formatTokens(ctx.limit)}（${pct}%），超过 ${Math.round(ctx.watermark * 100)}% 触发压缩。<strong>口径是最近一轮，不是全程累计</strong>——压缩判据取的就是单轮输入。</p>`;
  } else {
    html += `<p class="meter-note">最近一轮输入 ${formatTokens(ctx.lastInputTokens)}（未配置上限，无法给出水位）。</p>`;
  }

  html += '<h3 class="overview-section-title">Token 三分（全程累计）</h3>';
  const c = ctx.cumulative;
  const total = c.input + c.cacheCreation + c.cacheRead;
  if (total > 0) {
    const seg = (n, cls, label) =>
      n > 0 ? `<span class="token-seg token-seg--${cls}" style="flex:${n}" title="${label} ${formatTokens(n)}"></span>` : "";
    html += '<div class="token-bar">';
    html += seg(c.input, "uncached", "未缓存输入");
    html += seg(c.cacheCreation, "cache-write", "缓存写入");
    html += seg(c.cacheRead, "cache-read", "缓存读取");
    html += "</div>";
    html += '<ul class="token-legend">';
    html += `<li><span class="token-dot token-dot--uncached"></span>未缓存 ${formatTokens(c.input)}</li>`;
    html += `<li><span class="token-dot token-dot--cache-write"></span>缓存写入 ${formatTokens(c.cacheCreation)}</li>`;
    html += `<li><span class="token-dot token-dot--cache-read"></span>缓存读取 ${formatTokens(c.cacheRead)}</li>`;
    html += `<li>命中率 ${(ctx.cacheHitRatio * 100).toFixed(0)}%</li>`;
    html += "</ul>";
  } else {
    html += '<p class="empty-note">尚无 token 计量。</p>';
  }

  if (ctx.compactions.length > 0) {
    // V-19：不可逆自成语域。被置换的 tool_result 原文永不可恢复，
    // 这不是"又一条黄色警告"，混在一起会让人对它脱敏。
    html += '<div class="callout callout--irreversible">';
    html += `<strong>⚠ 上下文压缩 ${ctx.compactions.length} 次，置换 ${ctx.droppedBlocks} 个 tool_result 原文` +
      ((ctx.collapsedTurns ?? 0) > 0 ? `，折叠 ${ctx.collapsedTurns} 轮旧对话` : "") +
      "</strong>";
    html +=
      "<p>tool_result 原文不可恢复，模型如需全文须重跑工具。" +
      ((ctx.collapsedTurns ?? 0) > 0
        ? "被折叠的旧轮只剩一行摘要（assistant 正文首句 / 工具调用 / 结果首行），正文同样不可恢复。"
        : "") +
      ((ctx.reactiveCount ?? 0) > 0
        ? `其中 ${ctx.reactiveCount} 次是端点返回上下文超长 400 后的反应式硬压缩（保护窗收到 2），随即重发了同一轮。`
        : "") +
      `结构化账本已保留 ${ctx.ledgerEntries ?? 0} 条约束/决策/失败/证据/副作用摘要` +
      ((ctx.summaryAppliedCount ?? 0) > 0
        ? `（其中 ${ctx.summaryAppliedCount} 次合并了可选 LLM 摘要）`
        : "") +
      "。</p>";
    html += "</div>";
  }

  if (ctx.perTurn.length > 0) {
    html += '<h3 class="overview-section-title">逐轮明细</h3>';
    html += '<div class="table-scroll"><table class="usage-table">';
    html += "<thead><tr><th>轮</th><th>未缓存</th><th>缓存写</th><th>缓存读</th><th>输出</th></tr></thead><tbody>";
    for (const t of ctx.perTurn) {
      html += `<tr><td>${t.turn}</td><td>${formatTokens(t.input)}</td><td>${formatTokens(t.cacheCreation)}</td><td>${formatTokens(t.cacheRead)}</td><td>${formatTokens(t.output)}</td></tr>`;
    }
    html += "</tbody></table></div>";
  }
  return html;
}

/** Tools 面下钻：工具面、边界、改道证据 */
function renderToolsTab(tools) {
  let html = '<h3 class="overview-section-title">工具面</h3>';

  if (tools.tools.length === 0) {
    html += '<p class="empty-note">未获取到工具清单（宿主快照不可用）。</p>';
  } else {
    html += '<ul class="tool-chips">';
    for (const t of tools.tools) {
      const perm = t.permission ? `<span class="chip-perm chip-perm--${t.permission}">${t.permission}</span>` : "";
      const count = t.calls > 0 ? `<span class="chip-count">${t.calls} 次</span>` : "";
      const err = t.errors > 0 ? `<span class="chip-err">${t.errors} 失败</span>` : "";
      html += `<li class="tool-chip${t.errors > 0 ? " tool-chip--err" : ""}"><span class="chip-name">${esc(t.name)}</span>${perm}${count}${err}</li>`;
    }
    html += "</ul>";
  }

  html += '<h3 class="overview-section-title">运行边界</h3><dl class="boundary-list">';
  const row = (k, v) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`;
  if (tools.pack) {
    html += row("领域包", tools.pack.name ? `${tools.pack.name} — ${tools.pack.description ?? ""}` : "（无）");
    html += row("核查模式", tools.pack.verify?.mode ?? "（无）");
    const wl = tools.pack.verify?.readOnlyCommands ?? [];
    html += row("核查只读白名单", wl.length ? wl.join("、") : "（空——verifier 只能读文件，无法亲手重跑门禁）");
    if (tools.pack.resources?.length) html += row("独占资源", tools.pack.resources.join("、"));
  }
  if (tools.shell) html += row("bash 运行时", tools.shell);
  if (tools.executionIsolation) {
    const e = tools.executionIsolation;
    const label = e.effectiveState === "partial"
      ? "部分隔离（当前只覆盖 bash，SAFE-05 尚未完成）"
      : e.effectiveState === "report-only"
        ? "仅能力报告；命令仍以宿主身份执行，未隔离"
        : e.effectiveState === "direct"
          ? "隔离关闭；命令以宿主身份执行"
          : "required 后端不可用；命令拒绝执行";
    html += row(
      "Agent 命令隔离",
      `${label} · backend ${e.resolvedBackend ?? "none"} · probe ${e.probe?.state ?? "unknown"}`,
    );
    html += row("隔离策略摘要", `fs: ${e.filesystem} · net: ${e.network} · identity: ${e.identity} · resources: ${e.resources}`);
  }
  if (tools.workdir) html += row("工作目录", tools.workdir);
  if (tools.roleModels) {
    // 报的是本 run 实际用了什么模型跑哪个角色——配了但这次没启用要看得出来
    const rm = tools.roleModels;
    html += row("执行者模型", rm.executor ?? "—");
    html += row("核查者模型", rm.verifier ?? "（与执行者同一个）");
    html += row("planner 模型", rm.planner ?? "（与执行者同一个）");
    // 没配视觉模型时说清"看不了图"，而不是不提——执行者不知道自己缺这个能力
    html += row("视觉模型", rm.vision ?? "（未配置：本次运行看不了图）");
  }
  html += row("额外只读根", tools.readRoots.length ? tools.readRoots.join("；") : "（无）");
  if (tools.history) {
    // 报实际落点：重启后能不能接着这场对话，取决于档案存在哪、留几个
    html += row(
      "运行历史",
      tools.history.enabled ? `${tools.history.dir}（保留最近 ${tools.history.keep} 个）` : "（未落盘：重启后无法回看或派生）",
    );
  }
  if (tools.guardrails) {
    const g = tools.guardrails;
    html += row("护栏", `maxTurns ${g.maxTurns ?? "—"} · maxTokens ${g.maxTokens ?? "—"} · 上下文上限 ${g.contextTokenLimit ?? "—"}`);
  }
  if (tools.mcp) {
    const servers = tools.mcp.servers ?? [];
    html += row(
      "MCP",
      servers.length
        ? servers.map((s) => `${s.name}（${s.status}${s.toolCount != null ? `，${s.toolCount} 工具` : ""}）`).join("；")
        : tools.mcp.configured ? "已配置但未连接" : "未配置",
    );
  }
  html += "</dl>";

  if (tools.denials.length > 0) {
    html += '<h3 class="overview-section-title">被拒记录</h3><ul class="deny-list">';
    for (const d of tools.denials) {
      html += `<li><code>${esc(d.name)}</code>${d.reason ? `：${esc(d.reason)}` : "（未填理由）"}</li>`;
    }
    html += "</ul>";
    html += '<p class="rail-note">拒绝理由会原样回传给模型——deny 消息本身就是能力边界说明书。</p>';
  }

  const switched = tools.reroutes.filter((r) => r.switched);
  if (switched.length > 0) {
    // P5「错误进上下文，不炸循环」的可视化证据
    html += '<h3 class="overview-section-title">失败后的改道</h3><ul class="reroute-list">';
    for (const r of switched) {
      html += `<li><code>${esc(r.failedTool ?? "?")}</code> 失败 <span class="reroute-arrow">↳</span> 改用 <code>${esc(r.nextTool)}</code></li>`;
    }
    html += "</ul>";
    html += '<p class="rail-note">工具失败是常态路径：错误进上下文、循环不中断，模型自行改道。</p>';
  }
  return html;
}

/**
 * 日志面板：只追加，从不重排已渲染的条目。
 *
 * 两个后果都是实测过的痛点：① 展开/折叠状态与滚动位置天然保持；
 * ② 单次代价降到 O(新增条数)，长运行不再是 O(n²)。
 * 滚动跟随沿用 GitHub Actions 的规矩——贴底才跟，用户往上翻时不拽回去。
 */
function patchLogPanel(container, logEntries, callbacks, state) {
  const host = container.__logHost;
  if (!host) return;

  if (logEntries.length === 0) {
    if (!container.querySelector(".log-empty")) {
      const empty = document.createElement("div");
      empty.className = "log-empty";
      empty.textContent = "暂无日志记录。";
      host.appendChild(empty);
    }
    return;
  }
  const empty = container.querySelector(".log-empty");
  if (empty) empty.remove();

  // V-11：段首插入来源分界。此前三种来源按 seq 混排，标题写着"Agent 执行"
  // 却混着核查条目，"第 1 轮"出现四次而看不出属于哪一段。
  // CLI 一直有黄色 `↺ 核查未通过，开始返工…`（src/cli.ts:449），Web 没有。
  const boundaries = new Map();
  if (state) {
    for (const s of deriveSegments(state)) {
      if (s.index > 0) boundaries.set(s.startSeq, s);
    }
  }

  const scroller = host.closest(".content-area") || host;
  keepScrollAnchored(scroller, () => {
    appendOnly(host, logEntries, {
      key: (e) => String(e.seq),
      create: (e) => {
        const wrap = document.createElement("div");
        const boundary = boundaries.get(e.seq);
        wrap.innerHTML = (boundary ? renderSegmentBoundary(boundary) : "") + renderLogEntry(e);
        // 有分界时把两个节点包进一个容器，保持 appendOnly 的"一 key 一节点"契约
        let node;
        if (boundary) {
          node = document.createElement("div");
          node.className = "log-group";
          while (wrap.firstChild) node.appendChild(wrap.firstChild);
        } else {
          node = wrap.firstElementChild;
        }
        node.querySelector(".log-entry-header")?.addEventListener("click", () => {
          callbacks.onToggleEntry?.(Number(e.seq));
        });
        return node;
      },
      // 折叠状态是唯一会变的部分：重建内容但保留外层节点，
      // 这样滚动锚点与 patchNodes 映射都不受影响
      update: (node, e) => {
        const target = node.classList.contains("log-group")
          ? node.querySelector(".log-entry")
          : node;
        if (!target) return;
        const wasCollapsed = target.classList.contains("log-entry--collapsed");
        if (wasCollapsed === Boolean(e.collapsed)) return;
        const wrap = document.createElement("div");
        wrap.innerHTML = renderLogEntry(e);
        const fresh = wrap.firstElementChild;
        target.className = fresh.className;
        target.innerHTML = fresh.innerHTML;
        target.querySelector(".log-entry-header")?.addEventListener("click", () => {
          callbacks.onToggleEntry?.(Number(e.seq));
        });
      },
    });
  });
  // 工具日志同样走“语法候选 → 宿主 workdir/stat 确认 → 再升级为链接”的
  // 渐进增强链。这里不能只靠 renderLogEntry 直接造 href：历史 run 的 workdir
  // 可能不同，且日志正文是模型/工具输入，未经确认的路径只能继续当普通代码。
  if (state) void hydrateLocalPathLinks(host, state, callbacks);
}

/** 编排面板：依赖分层 + 甘特 + 并行收益（V-27） */
function patchPlanBoard(parts, host, plan) {
  if (!host) return;
  if (!plan) {
    setAttr(host, "hidden", "");
    host.innerHTML = "";
    parts.sig.plan = null;
    return;
  }
  setAttr(host, "hidden", null);
  const sig = signature([
    plan.nodes.map((n) => `${n.id}:${n.status}:${n.durationMs ?? ""}`).join(","),
    plan.timing ? JSON.stringify(plan.timing) : "",
    plan.warnings.length,
    plan.gate ? `${plan.gate.status}:${plan.gate.at}` : "",
  ]);
  if (parts.sig.plan === sig) return;
  parts.sig.plan = sig;

  let html = '<h3 class="overview-section-title">编排计划</h3>';

  // 签字位的审计记录（§5.1）：谁在什么时候批的，刷新后仍在
  if (plan.gate && plan.gate.status !== "pending") {
    const g = plan.gate;
    const tone = g.status === "approved" ? "ok" : "warn";
    const label =
      g.status === "approved"
        ? "✓ 计划已批准"
        : g.status === "rejected"
          ? "✗ 计划被否决"
          : "⋯ 计划门未应答";
    const detail =
      g.status === "expired"
        ? "运行收尾时确认门仍在等待，未执行任何子任务。"
        : g.status === "rejected"
          ? `由委托方否决${g.at ? ` · ${new Date(g.at).toLocaleString()}` : ""}——一个子任务都没有发射。`
          : `由委托方批准${g.at ? ` · ${new Date(g.at).toLocaleString()}` : ""}`;
    html += `<div class="callout callout--${tone}"><strong>${esc(label)}</strong><p>${esc(detail)}</p></div>`;
  }

  if (plan.planned === false) {
    // fail-closed：planner 产不出可解析计划时一个子任务都不执行。
    // 这不是"没结果"，是一个明确的结论，必须说清。
    // B0 的过程摘要必须一并给出：「胡言乱语」与「探索没来得及收口」
    // 在原始输出片段上长得一模一样，返工策略却完全不同。
    html += '<div class="callout callout--bad"><strong>planner 未能产出可解析计划</strong>' +
      "<p>整份计划作废，没有执行任何子任务（fail-closed）。下面是 planner 的原始输出片段。</p>" +
      (plan.plannerFailure ? `<p>${esc(plan.plannerFailure)}</p>` : "") +
      (plan.plannerRaw ? `<pre class="chat-body">${esc(plan.plannerRaw)}</pre>` : "") +
      "</div>";
    host.innerHTML = html;
    return;
  }

  html += '<p class="plan-meta">';
  html += `并行度 ${plan.concurrency}${plan.concurrencyMode === "auto" ? "（auto）" : ""}`;
  html += ` · 层宽 ${plan.parallelWidth}`;
  html += ` · ${plan.nodes.length} 个子任务`;
  if (plan.plannerMs) html += ` · 拆解耗时 ${formatDuration(plan.plannerMs)}`;
  html += "</p>";

  for (const w of plan.warnings) {
    html += `<div class="callout callout--warn"><strong>⚠ ${esc(w.subtaskId)}</strong><p>${esc(w.message)}</p></div>`;
  }

  // 依赖分层：同层 = 互不依赖 = 可并发。这正是调度器在做的决策
  html += '<ol class="plan-layers">';
  plan.layers.forEach((layer, i) => {
    html += `<li class="plan-layer"><span class="plan-layer-label">第 ${i + 1} 层${layer.length > 1 ? `（${layer.length} 个可并发）` : ""}</span>`;
    html += '<div class="plan-nodes">';
    for (const n of layer) html += renderPlanNode(n, plan.maxDuration);
    html += "</div></li>";
  });
  html += "</ol>";

  if (plan.timing) {
    const t = plan.timing;
    // 口径写全：子任务阶段墙钟排除 planner，"节省"是相对串行全序和而言
    html += '<dl class="boundary-list plan-timing">';
    html += `<dt>全程</dt><dd>${formatDuration(t.totalMs)}</dd>`;
    html += `<dt>拆解</dt><dd>${formatDuration(t.plannerMs)}</dd>`;
    html += `<dt>子任务阶段墙钟</dt><dd>${formatDuration(t.subtaskWallMs)}（排除拆解）</dd>`;
    html += `<dt>子任务合计</dt><dd>${formatDuration(t.stepSumMs)}（各步耗时之和 = 串行基线）</dd>`;
    html += `<dt>并行节省</dt><dd>${formatDuration(t.savedMs)}${
      t.stepSumMs > 0 ? `（${((t.savedMs / t.stepSumMs) * 100).toFixed(0)}%）` : ""
    }</dd>`;
    html += "</dl>";
    html += '<p class="rail-note">并行买的是时间不是 token：token 成本是结构性的，不随并行度下降。</p>';
  }

  if (plan.skipped.length > 0) {
    html += `<div class="callout callout--warn"><strong>${plan.skipped.length} 个子任务未执行</strong>` +
      "<p>某一步核查未通过后调度停止发射新任务（在飞的照常跑完）——整体已败，续跑只是烧 token。</p><ul>" +
      plan.skipped.map((x) => `<li><code>${esc(x.id)}</code> ${esc(x.title)}</li>`).join("") +
      "</ul></div>";
  }
  host.innerHTML = html;
}

/** @returns {string} */
function renderPlanNode(n, maxDuration) {
  const mark = { passed: "✔", failed: "✘", skipped: "－", running: "●", pending: "○" }[n.status];
  const pct = n.durationMs ? Math.max(2, Math.round((n.durationMs / maxDuration) * 100)) : 0;
  let html = `<div class="plan-node plan-node--${n.status}">`;
  html += `<div class="plan-node-head"><span class="plan-node-mark">${mark}</span>`;
  html += `<code class="plan-node-id">${esc(n.id)}</code> <span class="plan-node-title">${esc(n.title)}</span></div>`;
  html += '<div class="plan-node-meta">';
  if (n.pack) html += `<span class="chip-perm">包 ${esc(n.pack)}</span>`;
  if (n.dependsOn.length) html += `<span>⇐ ${esc(n.dependsOn.join(", "))}</span>`;
  // 独占资源要显眼：同标签强制串行，是"为什么这两个没并发"的唯一解释
  if (n.resources?.length) html += `<span class="plan-node-res">⊘ 独占 ${esc(n.resources.join("、"))}</span>`;
  if (n.reworks) html += `<span>↺ 返工 ${n.reworks} 轮</span>`;
  if (n.durationMs != null) html += `<span>${formatDuration(n.durationMs)}</span>`;
  html += "</div>";
  if (pct > 0) html += `<div class="plan-bar"><div class="plan-bar-fill" style="width:${pct}%"></div></div>`;
  if (n.acceptance?.length) {
    html += `<details class="chat-aside"><summary>验收 ${n.acceptance.length} 条</summary><ul class="plan-acceptance">`;
    html += n.acceptance.map((a) => `<li>${esc(a)}</li>`).join("");
    html += "</ul></details>";
  }
  html += "</div>";
  return html;
}

/** Loop 面的两种读法之间切换 */
function patchLoopView(parts, container, state, logEntries, callbacks) {
  // 对话升为主干之后这里只剩事件流一种读法（取证视图）
  patchLogPanel(container, logEntries, callbacks, state);
}

/**
 * 从**事件流**派生对话条目——对话主干的数据源。
 *
 * 为什么用事件而不是 transcript（委托方："还是希望做成对话框的形式"）：
 * transcript 只在**每一段结束时**才落盘，于是"对话"在运行过程中根本是空的，
 * 只能退回去看事件流——那正是它没法当主干的原因。而事件流里其实什么都有：
 * `assistant_text` 全文、`assistant_thinking` 全文、`tool_call` 的完整入参、
 * `tool_result` 的完整返回（`ui/server.ts` 的 default 分支原样透传）。
 * 换成事件之后对话**天然实时**，且顺手消掉了两件麻烦事：按需拉 transcript 的
 * 时序，以及续跑返回累计正史带来的逐段去重（V-28 那套前缀比对）——
 * 事件流本来就不重复。
 *
 * 产物是纯数据，渲染在 `renderChatStream`。这样"对话该长什么样"可以在
 * node 里直测，不必依赖 DOM。
 *
 * @returns {{kind:string,[k:string]:any}[]}
 */
export function deriveChatItems(state, live) {
  const items = [];
  /**
   * 开场白：**任务本身就是第一条用户消息**。
   *
   * 它不在事件流里（它是 run 的入参，不是事件），所以要显式补上。
   * 漏掉的后果很直白——打开一个运行，第一眼看不到自己当初要求了什么。
   * （这条是改造时被一条既有测试当场抓出来的：对话里只有回答没有提问。）
   */
  if (state.task) items.push({ kind: "user", text: state.task, seq: -1 });
  /** toolUseId → 该工具行在 items 里的下标，tool_result 回来时就地补上结果 */
  const callAt = new Map();
  let lastSource = null;

  /**
   * **两条时间线合起来按 seq 排。**
   *
   * 核查者的事件走 `verifierTimeline`（reducer 分流），只读 `timeline` 的话
   * 对话里就完全看不到核查者做过什么——而"另一个上下文独立复核"恰恰是这个
   * harness 最该被看见的东西。合并之后 `main → ◆ 核查 → ↺ 返工` 的交替
   * 直接长在对话里。
   */
  const all = [...(state.timeline ?? []), ...(state.verifierTimeline ?? [])].sort(
    (a, b) => a.seq - b.seq,
  );
  for (const e of all) {
    // 段切换（main → verifier → rework、或编排下换子任务）插一条分界
    if (e.source !== lastSource && CHAT_SOURCED.has(e.type)) {
      items.push({ kind: "boundary", source: e.source, role: segmentRole(e.source), seq: e.seq });
      lastSource = e.source;
    }
    switch (e.type) {
      case "user_message":
        items.push({
          kind: "user", text: e.text, seq: e.seq,
          ...(e.turn ? { turn: e.turn } : {}),
          ...(typeof e.verify === "boolean" ? { verify: e.verify } : {}),
          ...(e.continues ? { continues: e.continues } : {}),
        });
        break;
      case "assistant_thinking":
        if (e.text || e.redacted) {
          items.push({ kind: "thinking", text: e.text ?? "", redacted: Boolean(e.redacted), seq: e.seq });
        }
        break;
      case "assistant_text":
        // role 是给发言署名用的（人名映射在渲染层，见 ROLE_PERSONA）
        if (String(e.text ?? "").trim()) {
          items.push({ kind: "text", text: e.text, seq: e.seq, role: segmentRole(e.source) });
        }
        break;
      case "tool_call":
        callAt.set(e.toolUseId, items.length);
        items.push({
          kind: "tool", name: e.name, input: e.input, toolUseId: e.toolUseId,
          status: "running", result: null, isError: false, durationMs: null, seq: e.seq,
        });
        break;
      case "tool_result": {
        const at = callAt.get(e.toolUseId);
        if (at === undefined) break; // 没见过对应的调用（重放缺口），宁可不画也不伪造
        items[at] = {
          ...items[at],
          status: e.resultIsError ? "error" : "ok",
          result: e.resultContent ?? "",
          isError: Boolean(e.resultIsError),
          durationMs: e.durationMs ?? null,
        };
        break;
      }
      case "approval_request": {
        const at = callAt.get(e.toolUseId);
        // 审批卡本体在钉底坞里；对话里只留一条"这里等过人"的痕迹，
        // 否则事后回看会看到工具凭空执行，读不出当时被拦过
        if (at !== undefined) items[at] = { ...items[at], gated: true };
        else items.push({ kind: "gate", name: e.name, seq: e.seq });
        break;
      }
      default:
        break;
    }
  }

  /**
   * 裁决是对话的一部分，不是另一个页面。会话中心化之后一场对话可能有多轮核查，
   * 裁决必须落回**它出炉的位置**（按事件序号插进流里）并标明判的是第几轮——
   * 全部堆在末尾会把第 1 轮的"通过"画在第 3 轮的指令后面，读成整场对话通过了。
   * 没有序号的（旧事件流 / run_end 补齐）仍按老办法排在末尾。
   */
  const verdictItems = (state.verifications ?? []).map((v) => ({
    kind: "verdict",
    round: v.round,
    judgedTurn: v.judgedTurn ?? null,
    verdict: v.verdict,
    recovery: v.recovery ?? null,
    seq: typeof v.seq === "number" ? v.seq : null,
  }));
  const placed = verdictItems.filter((v) => v.seq !== null);
  if (placed.length > 0) {
    // 按 seq 插入：找到第一个序号更大的对话条目，插在它前面
    for (const v of placed) {
      const at = items.findIndex((it) => typeof it.seq === "number" && it.seq > v.seq);
      if (at < 0) items.push(v);
      else items.splice(at, 0, v);
    }
  }
  for (const v of verdictItems.filter((v) => v.seq === null)) items.push(v);

  /**
   * **正在流入的那一轮**（委托方："对话中的流式输出也没有做好，思考过程也没法
   * 流式被用户看见"）。
   *
   * 此前逐字增量只喂给页面顶部那条一行的直播条，对话里要等整轮结束、
   * `assistant_text` 落下来才突然出现一整段。于是"正在发生的事"和"发生过的事"
   * 在两个地方，而人的注意力只能在一处。现在增量直接长在对话末尾，
   * 那一轮结束时被真正的 `assistant_text` 条目自然接替。
   *
   * 思考与正文分成两块：思考仍是可折叠的（它是"为什么这么做"的证据，不是主线），
   * 但**展开之后就一直流**——这正是委托方要的那个行为。
   */
  const liveText = String(live?.text ?? "");
  const liveThinking = String(live?.thinking ?? "");
  if (state.status === "running" && (liveText.trim() || liveThinking.trim())) {
    // 直播只有 main 来源（planner/verifier 的流不进直播缓冲），署名跟着走
    items.push({ kind: "live", text: liveText, thinking: liveThinking, role: "main" });
  }

  // 稳定 key：节点靠它复用，不复用就保不住 details 的展开状态与滚动位置
  let n = 0;
  for (const it of items) {
    it.key =
      it.kind === "live" ? "live"
      // 多轮核查后 round 会重复（每轮从 0 起），键里必须带轮号才唯一
      : it.kind === "verdict" ? `verdict:${it.judgedTurn ?? "x"}:${it.round}`
      : `${it.kind}:${it.seq ?? "x"}:${n}`;
    n++;
  }
  return items;
}

/**
 * 这次运行**产出了哪些文件**（委托方："最终生成的文件有没有办法有超链接给用户
 * 直接点击打开"）。
 *
 * 数据源仍是事件流：写类工具的 `tool_call` 带着路径，配对的 `tool_result`
 * 说明它到底成没成。**只收成功的那些**——失败的写入不是产物，列出来只会
 * 让人点开一个不存在的文件。
 *
 * 边界诚实声明：`bash` 里 `>` 重定向出来的文件**认不出来**。要认出它得去
 * 解析 shell 命令，那是猜；宁可少列几个，也不要列一个其实没生成的。
 * 同一路径被写多次只留最后一次（那才是当前内容），但保留首次出现的顺序，
 * 因为人记的是"先做了什么再做了什么"。
 */
export function deriveArtifacts(state) {
  // 注意**不能**复用 WRITE_TOOLS：那一组含 bash（它用来判"这轮返工有没有动过
  // 东西"），而 bash 没有 path 入参，混进来只会产生一堆空路径

  const results = new Map();
  for (const e of state.timeline ?? []) {
    if (e.type === "tool_result") results.set(e.toolUseId, e);
  }
  /** @type {Map<string, any>} */
  const byPath = new Map();
  for (const e of state.timeline ?? []) {
    if (e.type !== "tool_call" || !ARTIFACT_TOOLS.has(e.name)) continue;
    const input = e.input && typeof e.input === "object" ? e.input : {};
    const path = String(input.path ?? input.file_path ?? "").trim();
    if (!path) continue;
    const res = results.get(e.toolUseId);
    if (!res || res.resultIsError) continue; // 没成的不是产物
    const prev = byPath.get(path);
    byPath.set(path, {
      path,
      tool: e.name,
      seq: prev ? prev.seq : e.seq, // 保留首次出现的次序
      writes: (prev?.writes ?? 0) + 1,
    });
  }
  return [...byPath.values()].sort((a, b) => a.seq - b.seq);
}

/** 会引起"换段"的事件类型：turn_start 这类噪声不该产生分界 */
const CHAT_SOURCED = new Set([
  "user_message", "assistant_text", "assistant_thinking", "tool_call", "approval_request",
]);

/**
 * 把对话条目渲染成 HTML。**对话是叙事，不是管道**：文字是主角，
 * 工具调用与返回折叠成一行摘要，需要时能展开但不淹没"它当时在说什么"。
 * @returns {string}
 */
export function renderChatStream(items, state) {
  if (!items || items.length === 0) {
    return state?.status === "running"
      ? '<p class="empty-note">刚开始，还没有内容。</p>'
      : '<p class="empty-note">这次运行没有产生对话内容。</p>';
  }
  return items.map((it) => renderChatItem(it)).join("");
}

/**
 * 模型正文的渲染入口：散文走 Markdown，**纯 JSON 输出走代码块**。
 *
 * 动机（委托方反馈："只有 planner 的输出没做成 markdown，很突兀"）：
 * planner / verifier 的输出契约是**裸 JSON**（不带围栏），Markdown 渲染器对它
 * 无事可做，于是一面墙的原始 JSON 以正文段落的样子杵在对话里。根因不在
 * 渲染分支——所有来源本就走同一支 renderMarkdown——在内容本身。
 *
 * 判据是【内容】不是【来源】：整体 JSON.parse 得过的对象/数组才算，
 * 散文零误伤；这样 verifier 若有裸 JSON 落进对话也一并受益。
 * pretty-print 只发生在展示层，事件流里的原文一字未动（审计面不受影响）。
 */
function renderAssistantText(text) {
  const t = String(text ?? "").trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const parsed = JSON.parse(t);
      return renderMarkdown("```json\n" + JSON.stringify(parsed, null, 2) + "\n```");
    } catch {
      // 不是纯 JSON（散文里恰好以花括号开头）——按散文走
    }
  }
  return renderMarkdown(text);
}

/**
 * 直播文本的渲染：与落定条目同一支 Markdown，外加一个流式特化——
 * 开头就像 JSON 的流（planner/verifier 的契约输出）直接套上 json 围栏，
 * 借渲染器"缺收尾围栏也成块"的既有容忍，让它**从第一个字起就以代码块的
 * 样子流入**；整轮落定后由 renderAssistantText 接手 pretty-print，形态连续。
 */
function renderLiveText(text) {
  const t = String(text ?? "");
  if (/^\s*[{[]/.test(t)) return renderMarkdown("```json\n" + t);
  return renderMarkdown(t);
}

/**
 * 单条对话条目。
 *
 * @param {any} it
 * @param {boolean} [thinkingOpen] 思考块是否默认展开——见 `THINKING_PREF_KEY`
 * @returns {string}
 */
export function renderChatItem(it, thinkingOpen = false) {
  {
    let html = "";
    switch (it.kind) {
      case "boundary":
        html += renderSegmentBoundary({ role: it.role, round: it.round ?? 0, source: it.source });
        break;
      case "user": {
        // 追加轮的两条元信息并列在署名旁：这一轮核查不核查、接的是什么（正史 /
        // 计划摘要 / 从头）。不显示的话"为什么这一轮没有裁决"要靠猜
        const turnMeta = [
          it.turn ? `第 ${it.turn} 轮` : "",
          it.verify === true ? "本轮核查" : it.verify === false && it.turn ? "本轮不核查" : "",
          it.continues === "plan-summary" ? "以计划摘要开局" : it.continues === "fresh" ? "无正史，从头开始" : "",
        ].filter(Boolean);
        html +=
          `<div class="chat-msg chat-msg--user"><div class="chat-role">委托方${
            turnMeta.length ? `<span class="aside-peek chat-turn-meta">${esc(turnMeta.join(" · "))}</span>` : ""
          }</div>` +
          `<div class="chat-body chat-body--text md">${renderMarkdown(it.text)}</div></div>`;
        break;
      }
      case "text":
        html +=
          `<div class="chat-msg chat-msg--assistant"><div class="chat-role">¶ ${esc(ROLE_PERSONA[it.role] ?? "Agent")}</div>` +
          `<div class="chat-body chat-body--text md">${renderAssistantText(it.text)}</div></div>`;
        break;
      case "thinking":
        html += it.redacted
          ? '<div class="chat-thinking chat-thinking--redacted">✽ 思考过程已被服务端加密（redacted），无法展示</div>'
          : `<details class="chat-thinking"${thinkingOpen ? " open" : ""}>` +
            `<summary>✽ 思考过程 <span class="aside-peek">${it.text.length} 字</span></summary>` +
            `<div class="chat-body chat-body--text md">${renderMarkdown(it.text)}</div></details>`;
        break;
      /**
       * 正在流入的这一轮。思考在上、正文在下，与已落定的形态一致，
       * 所以它结束时被真正的条目接替不会有视觉跳变。
       *
       * 正文与落定条目走**同一支 Markdown**（委托方："流式输出的时候就是
       * markdown 形式"）。此前流式按纯文本、落定再换 Markdown——同一段字在
       * 结束瞬间整体变脸，那才是真正的跳变。当年顾虑的"半截记法抽搐"如今
       * 有两层缓冲：增量经匀速放行按帧批量落下（不是每个字一次重排），
       * 且渲染器对没闭合的围栏本就容忍（余下部分整体成码块，见
       * core/markdown.js 的围栏分支）。未闭合的行内记法保持字面，闭合瞬间
       * 才变换——这与最终形态是同向收敛，不是抖动。
       */
      case "live":
        if (it.thinking.trim()) {
          html +=
            `<details class="chat-thinking chat-thinking--live"${thinkingOpen ? " open" : ""}>` +
            `<summary>✽ 正在思考 <span class="aside-peek">${it.thinking.length} 字</span></summary>` +
            `<div class="chat-body chat-body--text md chat-live-text">${renderLiveText(it.thinking)}</div></details>`;
        }
        if (it.text.trim()) {
          html +=
            `<div class="chat-msg chat-msg--assistant chat-msg--live"><div class="chat-role">¶ ${esc(ROLE_PERSONA[it.role] ?? "Agent")}</div>` +
            `<div class="chat-body chat-body--text md chat-live-text">${renderLiveText(it.text)}</div></div>`;
        }
        break;
      case "tool":
        html += renderToolRow(it);
        break;
      case "gate":
        html += `<div class="chat-gate">⚠ ${esc(it.name)} 需要你放行</div>`;
        break;
      case "verdict":
        html += renderVerdictInline(it);
        break;
      default:
        break;
    }
    return html;
  }
}

/**
 * 一次工具调用 = 一行。**摘要必须一眼认得出这是在干什么**。
 *
 * 委托方截图里那行 `→ bash {` 就是反例：入参被 `JSON.stringify(…, null, 2)`
 * 美化过，取首行自然只剩一个左花括号——等于什么都没说。
 * 现在按工具的**主参数**取摘要（command / path / url / query…），取不到才退回紧凑 JSON。
 */
function renderToolRow(it) {
  const cls = it.status === "error" ? " chat-tool--err" : it.status === "running" ? " chat-tool--live" : "";
  const mark = it.status === "error" ? "✗" : it.status === "running" ? "⋯" : "✓";
  const dur = it.durationMs != null ? `<span class="aside-peek">${it.durationMs}ms</span>` : "";
  const gate = it.gated ? '<span class="chat-tool-gate" title="这一步曾等待人工放行">⚠ 经放行</span>' : "";
  const peek = esc(truncate(toolPeek(it.name, it.input), 88));
  const paths = renderToolPathStrip(it.input);
  const body = paths + (it.result
    ? `<pre class="chat-body">${esc(truncate(String(it.result), 4000))}</pre>`
    : `<pre class="chat-body">${esc(truncate(formatInput(it.input), 1200))}</pre>`);
  return (
    `<details class="chat-tool${cls}">` +
    `<summary><span class="aside-mark">${mark}</span> <code>${esc(it.name ?? "")}</code> ` +
    `<span class="aside-peek">${peek}</span> ${gate} ${dur}</summary>${body}</details>`
  );
}

/** 各工具的"主参数"——摘要行只说这一个，别的展开再看 */
const TOOL_PEEK_KEYS = ["command", "path", "file_path", "url", "query", "name", "expression", "pattern"];

/**
 * 工具入参里哪些字段具有明确的“路径所有权”。
 *
 * 不解析 shell command：`cd a && node b.js` 不是路径，猜命令语义会把可执行文本
 * 误画成文件。只收结构化字段；最终仍由服务端按该 run 的 workdir + stat 确认。
 */
const TOOL_PATH_KEY = /(?:^|_)(?:path|paths|file|files|filename|filenames|dir|dirs|directory|directories|cwd|workdir|root)(?:$|_)/i;

/** @returns {string[]} */
export function toolPathCandidates(input) {
  const found = [];
  const seen = new Set();
  const add = (value) => {
    const clean = String(value ?? "").trim();
    const key = clean.toLocaleLowerCase();
    if (!clean || seen.has(key) || !isLocalPathCandidate(clean)) return;
    seen.add(key);
    found.push(clean);
  };
  const visit = (value, key = "", inherited = false, depth = 0) => {
    if (found.length >= 16 || depth > 5 || value == null) return;
    const pathField = inherited || TOOL_PATH_KEY.test(key);
    if (typeof value === "string") {
      if (pathField) add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, pathField, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value)) {
      visit(child, childKey, pathField || TOOL_PATH_KEY.test(childKey), depth + 1);
      if (found.length >= 16) break;
    }
  };

  if (typeof input === "string") add(input);
  else visit(input);
  return found;
}

function renderToolPathStrip(input) {
  const paths = toolPathCandidates(input);
  if (paths.length === 0) return "";
  return (
    '<div class="tool-path-strip" role="group" aria-label="工具涉及的路径">' +
    '<span class="tool-path-strip-label"><i class="ph ph-folder-simple" aria-hidden="true"></i>路径</span>' +
    paths.map((path) => `<code data-local-path="${esc(path)}">${esc(path)}</code>`).join("") +
    "</div>"
  );
}

export function toolPeek(name, input) {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return firstLine(input, 88);
  if (typeof input !== "object") return String(input);
  for (const k of TOOL_PEEK_KEYS) {
    const v = /** @type {any} */ (input)[k];
    if (typeof v === "string" && v.trim()) return firstLine(v, 88);
  }
  // 没有已知主参数时给紧凑单行 JSON——至少不是一个孤零零的花括号
  const compact = Object.entries(input)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  return firstLine(compact, 88);
}

/** 裁决卡：一段的收尾，就地出现在对话里而不是另一个标签页 */
function renderVerdictInline(it) {
  const v = it.verdict ?? {};
  const tone = v.passed ? (v.issues?.length ? "warn" : "ok") : "bad";
  const label = v.passed ? (v.issues?.length ? "通过（有备注）" : "核查通过") : "核查未通过";
  const list = (arr, mark, cls) =>
    arr && arr.length
      ? `<ul class="chat-verdict-list chat-verdict-list--${cls}">${arr
          .map((x) => `<li class="md-inline">${mark} ${renderMarkdownInline(x)}</li>`)
          .join("")}</ul>`
      : "";
  // 裁决只对它核查的那一轮对话负责——轮号必须与结论并列显示，不能让"通过"
  // 看起来像是整场对话的通过（判的是哪一轮 = 这份裁决的适用范围）
  const judged =
    it.judgedTurn != null
      ? `<span class="aside-peek chat-verdict-turn" data-judged-turn="${Number(it.judgedTurn)}">判第 ${Number(it.judgedTurn)} 轮对话</span>`
      : "";
  return (
    `<div class="chat-verdict chat-verdict--${tone}">` +
    `<div class="chat-verdict-head">◆ ${esc(label)}` +
    judged +
    (it.round ? `<span class="aside-peek">返工第 ${it.round} 轮</span>` : "") +
    "</div>" +
    (v.summary ? `<p class="md-inline chat-verdict-summary">${renderMarkdownInline(v.summary)}</p>` : "") +
    list(v.issues, v.passed ? "⚠" : "✗", "bad") +
    list(v.unverified, "?", "warn") +
    list(v.advisory, "◈", "note") +
    "</div>"
  );
}

/** 取首行并截断——折叠摘要上给一眼能认出是什么的线索 */
function firstLine(text, max) {
  const line = String(text ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  return truncate(line.trim(), max);
}

/**
 * 角色人名（backlog D4，委托方要求）。**显示层别名 only**：
 * source/事件流/台账/正史全部保持结构名（planner/verifier/sN/main），
 * 人名只在渲染时映射——进了协议层就是记录串味、改名即漂移。
 *
 * 姓名即角色：计明远——"计"划，谋定而后动，只看不改；施敢当——"施"工 +
 * 石敢当（顶得住事的那位，返工也是他，同一个人回来修自己的活）；
 * 严不苟——"严"格 + 一丝不苟，拒签是他的本职。
 * 人名必须与角色语义**并列显示**：严不苟的公信力来自"全新上下文"这个
 * 结构事实，不来自名字——名字不许把它盖住。
 */
export const ROLE_PERSONA = {
  planner: "计明远",
  main: "施敢当",
  rework: "施敢当",
  verifier: "严不苟",
};

/** 段分界：main→verifier 用 ━，返工用 CLI 同款 ↺（src/cli.ts:449） */
function renderSegmentBoundary(seg) {
  const label = {
    verifier: `${ROLE_PERSONA.verifier} · 核查（全新上下文独立复核）`,
    rework: `${ROLE_PERSONA.rework} · 核查未通过，返工（第 ${seg.round} 轮）`,
    planner: `${ROLE_PERSONA.planner} · 计划单元（只读拆解）`,
    main: `${ROLE_PERSONA.main} · Agent 执行`,
  }[seg.role];
  const mark = seg.role === "rework" ? "↺" : seg.role === "verifier" ? "◆" : seg.role === "planner" ? "❑" : "▸";
  // 编排模式下来源形如 "s1/main"：并行时多个子任务的日志按 seq 交错，
  // 不标出子任务 id 就完全读不懂谁在说话
  const src = String(seg.source ?? "");
  const stepId = src.includes("/") ? src.slice(0, src.indexOf("/")) : null;
  const step = stepId ? `<code class="segment-step">${esc(stepId)}</code> ` : "";
  return `<div class="segment-boundary segment-boundary--${seg.role}"><span class="segment-mark">${mark}</span>${step}<span class="segment-label">${esc(label)}</span></div>`;
}

function patchUsageFooter(parts, state) {
  const html = renderUsageFooterBody(state);
  const sig = signature([html.length, html.slice(0, 120)]);
  if (parts.sig.usage === sig) return;
  parts.sig.usage = sig;
  setAttr(parts.usage, "hidden", html ? null : "");
  parts.usage.innerHTML = html;
}


/**
 * 用量脚注（V-07）。
 *
 * 口径是这里的全部要点。旧版把最后一条 done 的 usage 当成整个 run 的开销——
 * 返工场景下那只是最后一轮，主轮与 verifier 的花费全部漏计。现在优先用
 * executionUsage（全部执行轮合计，含被否掉的中间轮），核查开销单列，
 * 每个数字都带口径标注：界面上不出现没有口径的数字。
 * @returns {string}
 */
function renderUsageFooterBody(state) {
  const exec = state.runEnd && state.runEnd.executionUsage;
  const verify = state.runEnd && state.runEnd.verificationUsage;

  if (!exec && !state.usage) return "";

  let html = "";
  if (exec) {
    html += `<span class="usage-item">执行（全部轮次合计）：${exec.turns} 轮 · 入 ${formatTokens(exec.inputTokens)} · 出 ${formatTokens(exec.outputTokens)}</span>`;
    if (verify && verify.turns > 0) {
      html += `<span class="usage-item">核查：${verify.turns} 轮 · 入 ${formatTokens(verify.inputTokens)} · 出 ${formatTokens(verify.outputTokens)}</span>`;
    }
    if (state.runEnd.reworks) {
      html += `<span class="usage-item">返工 ${state.runEnd.reworks} 轮</span>`;
    }
    const denom = exec.inputTokens + exec.cacheCreationTokens + exec.cacheReadTokens;
    if (denom > 0) {
      html += `<span class="usage-item">缓存命中 ${((exec.cacheReadTokens / denom) * 100).toFixed(0)}%</span>`;
    }
  } else {
    // 运行中：只有段级数据，标注清楚它不是全程合计
    html += `<span class="usage-item">本段：${state.usage.turns} 轮 · 入 ${formatTokens(state.usage.inputTokens)} · 出 ${formatTokens(state.usage.outputTokens)}</span>`;
    html += `<span class="usage-item">缓存命中 ${(state.usage.cacheHitRatio * 100).toFixed(0)}%</span>`;
  }
  return html;
}

/** @returns {string} */
function renderApprovalCards(state, isRunning) {
  let html = `<div class="approval-cards">`;
  for (const app of state.pendingApprovals) {
    const isPending = app.status === "pending";
    const operable = isPending && isRunning;
    const resolved = !isPending;

    // 卡片身份用 approvalId（toolUseId#requestSeq）：返工轮复用同一 toolUseId，
    // 只有它能把"这一轮的卡"和"上一轮的历史卡"区分开（V-03）
    const cardId = app.approvalId || app.toolUseId;

    html += `<div class="approval-card ${resolved ? "approval-card--resolved" : ""}" data-approval-id="${esc(cardId)}">`;
    html += `<div class="approval-card-header">`;
    html += `<span class="approval-tool-name">⚠ ${esc(app.name)}</span>`;

    if (resolved) {
      const decisionLabel =
        app.status === "allowed" ? "已允许" :
        app.status === "denied" ? "已拒绝" : "已过期";
      const decisionClass =
        app.status === "allowed" ? "approval-result--allow" :
        app.status === "denied" ? "approval-result--deny" : "approval-result--expired";
      html += `<span class="approval-result ${decisionClass}">${decisionLabel}</span>`;
    }
    html += `</div>`;

    html += `<pre class="approval-input">${esc(formatInput(app.input))}</pre>`;

    if (operable) {
      html += `<div class="approval-actions">`;
      html += `<button class="btn btn--allow" data-action="allow" data-approval-id="${esc(cardId)}">允许本次</button>`;
      html += `<button class="btn btn--deny" data-action="deny" data-approval-id="${esc(cardId)}">拒绝并说明</button>`;
      // aria-label 而非只靠 placeholder：placeholder 虽按 accname 规范算兜底名称，
      // 但输入后即从视觉上消失，屏幕阅读器用户失去上下文
      html += `<input class="deny-reason" data-approval-id="${esc(cardId)}" aria-label="拒绝 ${esc(app.name)} 的理由（可选）" placeholder="拒绝理由（可选）" />`;
      html += `</div>`;
    } else if (resolved) {
      if (app.decidedAt) {
        html += `<div class="approval-meta">${formatTime(app.decidedAt)}</div>`;
      }
      if (app.reason) {
        html += `<div class="approval-reason">理由：${esc(app.reason)}</div>`;
      }
    }
    html += `</div>`;
  }
  html += `</div>`;
  return html;
}

/** @returns {string} */
function renderOverviewTab(overview, state) {
  let html = "";

  // 最终状态徽章（醒目）+ 补救提示（V-04）
  const isRunning = overview.finalStatus === "running";
  const cls = classifyStopReason(isRunning ? null : state.stopReason);
  const statusLabel = isRunning ? "运行中" : cls.label;
  const statusCls = isRunning ? "status--live" : toneClass(cls.tone);
  html += `<div class="overview-status">`;
  html += `<span class="status-badge status-badge--lg ${statusCls}">${esc(statusLabel)}</span>`;
  // 说明这次终止意味着什么、下一步能做什么——"撞轮次护栏"这类结局，
  // 光给一个标签用户还是不知道该怎么办
  if (cls.hint) html += `<div class="status-hint">${esc(cls.hint)}</div>`;
  html += `</div>`;

  // 结果摘要
  if (overview.resultSummary) {
    html += `<div class="overview-section">`;
    html += `<h3 class="overview-section-title">结果摘要</h3>`;
    html += `<div class="overview-summary-text">${esc(overview.resultSummary)}</div>`;
    html += `</div>`;
  }

  // finish_task 的证据字段必须在 UI 可见；只显示 summary 会把结构化契约又压回散文。
  if (overview.completion) {
    const groups = [
      ["产物", overview.completion.artifacts],
      ["验证", overview.completion.verification],
      ["关键假设", overview.completion.assumptions],
    ].filter(([, items]) => Array.isArray(items) && items.length > 0);
    if (groups.length > 0) {
      html += `<div class="overview-section"><h3 class="overview-section-title">结构化交付</h3>`;
      for (const [label, items] of groups) {
        html += `<div class="overview-summary-text"><strong>${esc(label)}</strong><ul class="action-items">`;
        for (const item of items) html += `<li>${esc(item)}</li>`;
        html += `</ul></div>`;
      }
      html += `</div>`;
    }
  }

  // 验证结论
  if (overview.verdict) {
    html += renderVerdictCard(overview.verdict);
  }

  // 需介入事项
  const hasActionItems =
    overview.actionItems.pendingApprovals.length > 0 ||
    overview.actionItems.unverifiedItems.length > 0 ||
    overview.actionItems.blockers.length > 0;
  if (hasActionItems) {
    html += `<div class="overview-section overview-section--action">`;
    html += `<h3 class="overview-section-title">⚠ 需介入事项</h3>`;
    html += `<ul class="action-items">`;
    for (const a of overview.actionItems.pendingApprovals) {
      html += `<li class="action-item action-item--approval">⚠ 待审批：${esc(a.name)} — ${esc(truncate(formatInput(a.input), 80))}</li>`;
    }
    for (const u of overview.actionItems.unverifiedItems) {
      html += `<li class="action-item action-item--unverified">⋯ 待复核：${esc(u)}</li>`;
    }
    for (const blocker of overview.actionItems.blockers) {
      html += `<li class="action-item action-item--unverified">⋯ 未完成/阻塞：${esc(blocker)}</li>`;
    }
    html += `</ul>`;
    html += `</div>`;
  }

  // 已处理审批（只读记录，不静默丢失）
  if (overview.resolvedApprovals && overview.resolvedApprovals.length > 0) {
    html += `<div class="overview-section">`;
    html += `<h3 class="overview-section-title">审批记录</h3>`;
    html += `<ul class="action-items">`;
    for (const a of overview.resolvedApprovals) {
      const label = a.status === "allowed" ? "已允许" : a.status === "denied" ? "已拒绝" : "已过期";
      const reasonSuffix = a.reason ? ` — ${esc(a.reason)}` : "";
      html += `<li class="action-item action-item--resolved">${label}：${esc(a.name)}${reasonSuffix}</li>`;
    }
    html += `</ul>`;
    html += `</div>`;
  }

  // 错误醒目
  if (state.error) {
    html += `<div class="error-banner">⚠ ${esc(state.error)}</div>`;
  }

  // 无结果时显示提示
  if (!overview.resultSummary && !overview.verdict && !hasActionItems && !state.error) {
    html += `<div class="overview-placeholder">运行中，暂无结果摘要…</div>`;
  }

  return html;
}

// renderLogTab 已移除：日志面板改为 patchLogPanel 的增量追加，
// 不再有"把整份日志拼成一段 HTML"这一步（那正是 O(n²) 与滚动跳动的来源）。
// 区块标题 "Agent 执行" 移到 patchTabContent 的骨架里（委托方 §12 文案不变）。

/** @returns {string} */
function renderLogEntry(e) {
  const collapsed = e.collapsed;
  const headerHtml = renderLogEntryHeader(e, collapsed);
  const bodyHtml = collapsed ? "" : renderLogEntryBody(e);

  let cls = "log-entry";
  if (e.type === "tool_result" && e.resultIsError) cls += " log-entry--error";
  if (e.type === "approval_request") cls += " log-entry--approval";
  if (e.type === "api_retry") cls += " log-entry--warning";
  if (e.type === "model_fallback") cls += " log-entry--warning";
  if (e.type === "recovery_decision") cls += " log-entry--warning";
  if (e.type === "run_forked") cls += " log-entry--warning";
  if (e.type === "run_resumed") cls += " log-entry--warning";
  if (e.type === "compaction") cls += " log-entry--warning";
  if (collapsed) cls += " log-entry--collapsed";

  // 折叠的工具调用也必须看得到路径入口：路径条独立于 body，避免用户为了打开
  // 一个文件先展开整块 JSON；同时避开在 role=button 的 header 里嵌套链接。
  const pathHtml = e.type === "tool_call" ? renderToolPathStrip(e.input) : "";
  return `<div class="${cls}" data-seq="${e.seq}">
    ${headerHtml}
    ${pathHtml}
    ${bodyHtml}
  </div>`;
}

/** @returns {string} */
function renderLogEntryHeader(e, collapsed) {
  const icon = entryIcon(e.type, e.resultIsError);
  const action = entryActionLabel(e);
  const detail = entryDetail(e);
  // V-12：耗时用可读格式（此前原样输出 `124757ms`，人得自己心算成 2 分钟）
  const duration = e.durationMs != null ? formatDuration(e.durationMs) : "";
  const expandIcon = collapsed ? "▸" : "▾";

  // action / detail 在此统一 esc，entryActionLabel 内部不得再 esc 一次
  // （V-16：双重转义会把工具参数里的引号显示成 &amp;quot;）
  return `<div class="log-entry-header" data-seq="${e.seq}" tabindex="0" role="button" aria-expanded="${!collapsed}">
    <span class="log-entry-expand">${expandIcon}</span>
    <span class="log-entry-icon">${icon}</span>
    <span class="log-entry-action">${esc(action)}</span>
    <span class="log-entry-detail">${esc(detail)}</span>
    ${duration ? `<span class="log-entry-duration">${esc(duration)}</span>` : ""}
  </div>`;
}

/** @returns {string} */
function renderLogEntryBody(e) {
  switch (e.type) {
    case "tool_call":
      return `<pre class="log-entry-body">${esc(formatInput(e.input))}</pre>`;
    case "tool_prepared":
    case "tool_running":
    case "tool_committed":
    case "tool_failed":
    case "tool_aborted":
      return `<div class="log-entry-body">idempotencyKey=<code>${esc(e.idempotencyKey ?? "")}</code>${
        e.skipped ? "<br>skipped duplicate commit" : ""
      }${e.reason ? `<br>${esc(e.reason)}` : ""}${
        e.inputHash ? `<br>inputHash=<code>${esc(String(e.inputHash).slice(0, 16))}…</code>` : ""
      }</div>`;
    case "tool_result":
      return `<pre class="log-entry-body">${esc(e.resultContent ?? "")}</pre>`;
    case "assistant_text":
      // 模型散文走 Markdown 渲染（委托方反馈：原样显示 **粗体**/- 列表是噪声）。
      // renderMarkdown 内部先整体转义再变换，此处不能再 esc 一次——那会双重转义（V-16）
      return `<div class="log-entry-body log-entry-text md">${renderMarkdown(e.text ?? "")}</div>`;
    case "approval_request":
      return `<pre class="log-entry-body">${esc(formatInput(e.input))}</pre>`;
    case "assistant_thinking":
      return e.redacted
        ? '<div class="log-entry-body log-thinking">服务端已加密该段思考（redacted），内容取不到——但它确实发生过。</div>'
        : `<div class="log-entry-body log-thinking md">${renderMarkdown(e.text ?? "")}</div>`;
    case "segment_resume":
      return `<div class="log-entry-body">整段因瞬时故障终止，已带着之前 ${esc(String(e.priorTurns ?? "?"))} 轮的会话正史接着跑（不是从头重来）。<br>原因：${esc(e.reason ?? "")}</div>`;
    case "api_retry":
      // 等待时长要看得见：抖动之后同一 attempt 的等待不再是定值，
      // 只显示"第几次重试"会让人以为退避是固定的
      return `<div class="log-entry-body">原因：${esc(e.reason ?? "")}${
        typeof e.backoffMs === "number" ? `<br>退避等待：${esc(formatDuration(e.backoffMs))}（含抖动）` : ""
      }</div>`;
    case "model_fallback":
      // 三件事都要写出来：换到了哪家、为什么离开上一家、这之后的输出归谁。
      {
        const roleLabel = e.role && e.role !== "executor" ? `（角色 ${esc(e.role)}）` : "（主执行者）";
        return `<div class="log-entry-body">端点${roleLabel}从 <code>${esc(e.from ?? "")}</code> 换到 <code>${esc(
          e.to ?? "",
        )}</code>（第 ${esc(String(e.turn ?? "?"))} 次模型调用）。<br>离开原因：${esc(
          fallbackReasonText(e.reason),
        )}${e.routing ? `<br>路由策略：${esc(e.routing)}` : ""}<br>此后该角色的输出由新端点产生。</div>`;
      }
    case "recovery_decision":
      return `<div class="log-entry-body">${esc(e.detail ?? "")}${
        typeof e.extraTurns === "number" ? `<br>追加额度：${esc(String(e.extraTurns))} 轮` : ""
      }</div>`;
    case "run_forked": {
      const budget = e.inheritedBudget ?? {};
      const budgetText = [
        budget.maxTurns != null ? `轮次 ${budget.usedTurns ?? 0}/${budget.maxTurns}` : `已用轮次 ${budget.usedTurns ?? 0}`,
        budget.maxTokens != null ? `token ${budget.usedTokens ?? 0}/${budget.maxTokens}` : `已用 token ${budget.usedTokens ?? 0}`,
      ].join("；");
      return `<div class="log-entry-body">${esc(e.boundary ?? "")}` +
        `<br>直接父运行：<code>${esc(e.parentRunId ?? "")}</code>` +
        `<br>继承总账：${esc(budgetText)}` +
        `${Array.isArray(e.reset) && e.reset.length ? `<br>已重置：${esc(e.reset.join("、"))}` : ""}</div>`;
    }
    case "run_resumed": {
      const budget = e.inheritedBudget ?? {};
      const budgetText = [
        budget.maxTurns != null ? `轮次 ${budget.usedTurns ?? 0}/${budget.maxTurns}` : `已用轮次 ${budget.usedTurns ?? 0}`,
        budget.maxTokens != null ? `token ${budget.usedTokens ?? 0}/${budget.maxTokens}` : `已用 token ${budget.usedTokens ?? 0}`,
      ].join("；");
      return `<div class="log-entry-body">${esc(e.boundary ?? "")}` +
        `<br>同 run：<code>${esc(e.runId ?? "")}</code>` +
        (e.segmentIndex != null ? `<br>检查点段号：${esc(String(e.segmentIndex))}` : "") +
        `<br>继承总账：${esc(budgetText)}` +
        `${Array.isArray(e.reset) && e.reset.length ? `<br>未恢复：${esc(e.reset.join("、"))}` : ""}</div>`;
    }
    case "compaction":
      return `<div class="log-entry-body">${e.reactive ? "反应式（撞上下文超长 400 后重发同一轮）· " : ""}丢弃 ${e.droppedBlocks ?? "?"} 个块` +
        (e.collapsedTurns ? ` · 折叠 ${e.collapsedTurns} 轮旧对话` : "") +
        (typeof e.ledgerEntries === "number" ? ` · 账本 ${e.ledgerEntries} 条` : "") +
        (e.summaryApplied ? " · 已合并 LLM 摘要" : "") +
        `</div>`;
    default:
      return "";
  }
}

/** @returns {string} */
function entryIcon(type, isError) {
  // 一律用**单色排印符**，不用 emoji。
  //
  // 理由不是审美：emoji 是自带调色板的彩色字形，CSS `color` 对它们无效，
  // 因此它们无法参与主题系统——浅色暖底上尤其像贴上去的异物。排印符继承
  // currentColor，明暗两套主题里都跟着语义色走。
  //
  // 符号表同时向 CLI 收敛（src/cli.ts:512-591），Web 与终端看到的是同一套记号。
  switch (type) {
    case "turn_start": return "──";      // cli.ts:516
    case "tool_call": return "→";        // cli.ts:527
    case "tool_prepared": return "⬡";
    case "tool_running": return "⬡";
    case "tool_committed": return "⬡";
    case "tool_failed": return "⬡";
    case "tool_aborted": return "⬡";
    case "tool_result": return isError ? "✗" : "✓"; // cli.ts:530-531
    case "assistant_text": return "¶";   // CLI 直接流式打印无标记，列表里需要一个
    case "assistant_thinking": return "✽"; // 与对话视图同款，自成语域
    case "approval_request": return "⚠"; // cli.ts:539
    case "api_retry": return "⟳";        // cli.ts:563
    case "segment_resume": return "⟲";   // 与 ⟳(同轮重试) 区分：这是整段续跑
    case "model_fallback": return "⇄";   // 前两个换的是时机，这个换的是端点（cli.ts 同款）
    case "recovery_decision": return "⤷";
    case "run_forked": return "↗";
    case "run_resumed": return "↺";
    // CLI 对压缩也用 ⚠，这里刻意分开：V-19 要求不可逆自成语域，
    // 与普通警告共用符号会让人对它脱敏
    case "compaction": return "⊟";
    case "user_message": return "✎";
    default: return "·";
  }
}

/** @returns {string} */
function entryActionLabel(e) {
  // 这里一律返回**未转义**的纯文本，转义由 renderLogEntryHeader 统一做（V-16）
  switch (e.type) {
    case "turn_start": return `第 ${e.turn ?? "?"} 轮`;
    case "tool_call": return e.name ?? "";
    case "tool_prepared": return `${e.name ?? ""} prepared`;
    case "tool_running": return `${e.name ?? ""} running`;
    case "tool_committed":
      return `${e.name ?? ""} committed${e.skipped ? " (skipped)" : ""}`;
    case "tool_failed": return `${e.name ?? ""} tx failed`;
    case "tool_aborted": return `${e.name ?? ""} tx aborted`;
    // name 由 deriveLogEntries 按 toolUseId 回填；真取不到才退回 id（V-12）
    case "tool_result": return `${e.name ?? e.toolUseId ?? ""} ${e.resultIsError ? "失败" : "成功"}`;
    case "assistant_text": return "助手消息";
    case "assistant_thinking":
      return e.redacted ? "思考过程（已加密）" : `思考过程（${(e.text ?? "").length} 字）`;
    case "approval_request": return `审批请求：${e.name ?? ""}`;
    case "api_retry": return `API 重试（第${e.attempt ?? "?"}次）`;
    case "segment_resume": return `瞬时失败后带正史续跑（已完成 ${e.priorTurns ?? "?"} 轮）`;
    case "model_fallback": return `端点降级${e.role && e.role !== "executor" ? `[${e.role}]` : ""}：${e.from ?? "?"} → ${e.to ?? "?"}`;
    case "recovery_decision": {
      const labels = {
        request_completion: "要求业务收口",
        continue_with_context: "同上下文有界续跑",
        change_strategy: "检测停滞，要求换策略",
        force_completion: "强制结构化收口",
      };
      return labels[e.action] ?? "恢复路由";
    }
    case "run_forked": return "从归档检查点派生";
    case "run_resumed": return "同运行热恢复";
    case "compaction": return "上下文压缩";
    case "usage": return "本轮用量";
    case "user_message":
      return `追加指令（第 ${e.turn ?? "?"} 轮对话${e.verify === true ? "，本轮核查" : e.verify === false ? "，本轮不核查" : ""}）`;
    default: return e.type;
  }
}

/**
 * 降级原因的人话。`circuit_open` 是 L0 的内部标记，不是端点回的错误码——
 * 原样显示会让人以为上游返回了一个叫 circuit_open 的东西，从而去查错方向。
 * 摘要行与展开体共用这一处，两处各写一遍就是"同一件事两种说法"的开始。
 * @returns {string}
 */
function fallbackReasonText(reason) {
  if (reason === "circuit_open") return "上一个端点仍在熔断隔离期，本次直接跳过";
  if (reason === "probe_unhealthy") return "粘性探针标为不健康，prefer_healthy 跳过";
  return reason ?? "";
}

/** @returns {string} */
function entryDetail(e) {
  switch (e.type) {
    case "tool_call":
      return truncate(formatInput(e.input), 60);
    case "tool_prepared":
    case "tool_running":
    case "tool_committed":
      return truncate(e.idempotencyKey ?? "", 48);
    case "tool_failed":
      return truncate(e.reason ?? "", 60);
    case "tool_aborted":
      return truncate(e.idempotencyKey ?? "", 48);
    case "tool_result":
      return truncate(e.resultContent ?? "", 60);
    case "assistant_text":
      return truncate(e.text ?? "", 80);
    case "approval_request":
      return truncate(formatInput(e.input), 60);
    case "api_retry":
      return e.reason ?? "";
    case "model_fallback":
      return fallbackReasonText(e.reason);
    case "recovery_decision":
      return e.detail ?? e.reason ?? "";
    case "run_forked":
      return e.boundary ?? "";
    case "run_resumed":
      return e.boundary ?? "";
    case "user_message":
      return truncate(e.text ?? "", 80);
    default:
      return "";
  }
}

/** @returns {string} */
function renderVerifyTab(state, face) {
  let html = "";

  // Verification 面恒在：没跑核查本身就是一条信息，不是一个空白。
  // 界面要说清"为什么没有裁决"——是没开核查，还是执行根本没跑完导致核查
  // 压根没机会运行。后者尤其重要：那种情形下"没有裁决"绝不等于"没问题"。
  if (!state.verdict && state.verifierTimeline.length === 0) {
    if (!state.verify) {
      html += '<div class="callout callout--info"><strong>本次运行未开启独立核查</strong>' +
        "<p>提交任务时勾选「开启独立核查」，会由一个全新上下文的核查 Agent 重读产物并出具三值裁决。</p></div>";
    } else {
      const cls = classifyStopReason(state.stopReason);
      html += '<div class="callout callout--warn"><strong>核查未运行</strong>' +
        `<p>已开启独立核查，但执行段以 <code>${esc(state.stopReason ?? "未知")}</code>（${esc(cls.label)}）终止，核查没有机会执行。<strong>没有裁决不等于没有问题</strong>——这一类失败核查救不了。</p></div>`;
    }
    return html;
  }

  // 三类饥饿告警分开列，不混成一条——它们指向不同的根因层，混在一起就没法归因
  if (face) {
    const s = face.starvation;
    if (s.noWhitelist) {
      html += '<div class="callout callout--warn"><strong>⚠ verifier 处于无白名单状态</strong>' +
        "<p>本包未声明 <code>verify.readOnlyCommands</code>，核查者撞上审批门只能被拒——它无法亲手重跑门禁，只能靠间接证据。这正是案例 #4 那次 22 轮空转的配置形态。</p></div>";
    }
    if (s.emptyRework.length > 0) {
      html += `<div class="callout callout--warn"><strong>⚠ 第 ${s.emptyRework.join("、")} 轮返工零写入</strong>` +
        "<p>被否之后的返工段里没有任何写类工具调用，疑似核查饥饿（fail-closed 的第三种误伤形态）：模型在重新证明已经为真的东西，而不是修东西。</p></div>";
    }
    if (s.parseFail) {
      html += '<div class="callout callout--bad"><strong>⚠ 裁决解析失败</strong>' +
        "<p>verifier 的输出不是可解析的 JSON 裁决，被 fail-closed 判为未通过。这是误伤，不是真的核查不过。</p></div>";
    }
  }

  // 核查结论（如果存在）
  if (state.verdict) {
    html += renderVerdictCard(state.verdict);
  }

  // 逐轮裁决（V-08：末轮之外的中间轮也保留）
  if (face && face.rounds.length > 1) {
    html += '<h3 class="overview-section-title">逐轮裁决</h3><ol class="verify-rounds">';
    for (const r of face.rounds) {
      const mark = r.verdict?.passed ? "✔" : "✘";
      const issues = r.verdict?.issues?.length ?? 0;
      html += `<li class="verify-round verify-round--${r.verdict?.passed ? "ok" : "bad"}">` +
        `<span class="round-mark">${mark}</span> 第 ${r.round + 1} 次核查` +
        (issues ? `：${issues} 项不符` : "") +
        (r.verdict?.summary ? `<span class="round-summary">${esc(r.verdict.summary)}</span>` : "") +
        "</li>";
    }
    html += "</ol>";
  }

  // 核查者的能力边界——deny 消息即教学，白名单即边界说明书
  if (face) {
    /**
     * 裁决获得路径（§2.1 前置）：裁决是"首轮直接给的"还是"靠兜底救回来的"，
     * 这件事本身就是信号——救回来的那些说明核查者收口不稳，而不是产物有问题。
     * 也是 fail-closed 三种误伤形态第一次可计量。
     * （措辞避开"核查"+"过程"连写：那是 v1 的旧标签名，AC7 文案门禁仍在禁它。）
     */
    const recoveries = face.rounds.map((r) => r.recovery).filter(Boolean);
    /**
     * §2.1 之后**健康路径有两条**：tool（走终结工具交付，新的理想路径）与
     * direct（末条消息恰好可解析，端点不认强制工具时的形态）。
     * 这个集合必须跟着 VerdictRecovery 走——漏一个值，那条运行就会被界面
     * 说成"收口不稳"，而它其实一切正常（V-04：界面不得对委托方说谎）。
     */
    const HEALTHY_RECOVERY = new Set(["tool", "direct"]);
    if (recoveries.length > 0 && recoveries.some((r) => !HEALTHY_RECOVERY.has(r))) {
      const label = {
        tool: "首轮直接交付（结构化）",
        direct: "首轮直接给出",
        wrapup: "预算用尽后收口续跑救回",
        reformat: "重问转写救回",
        failed: "兜底未救回（fail-closed）",
      };
      html += '<h3 class="overview-section-title">裁决获得路径</h3><ul class="unverified-list">';
      html += face.rounds
        .map((r, i) => `<li>第 ${r.round ?? i} 轮：${esc(label[r.recovery] ?? String(r.recovery ?? "—"))}</li>`)
        .join("");
      html += "</ul><p class=\"rail-note\">有轮次靠兜底才拿到裁决，说明核查者收口不稳——问题出在核查这一环，不是产物本身。</p>";
    }

    html += '<h3 class="overview-section-title">核查者的边界</h3><dl class="boundary-list">';
    html += `<dt>只读白名单</dt><dd>${
      face.whitelist.length
        ? esc(face.whitelist.join("、")) +
          (whitelistSourceLabel(face.whitelistSource) ? ` <small>（${esc(whitelistSourceLabel(face.whitelistSource))}）</small>` : "")
        : "（空——只能读文件，无法重跑门禁）"
    }</dd>`;
    // 不再写"固定"：9.1 之后领域包可用 verify.maxTurns 覆盖，
    // 而"这个数从哪来"决定了人要不要去改它
    html += `<dt>核查预算</dt><dd>${face.budgetTurns ?? "—"} 轮${
      face.budgetSource === "pack"
        ? "（领域包声明）"
        : face.budgetSource === "env"
          ? "（AGENT_VERIFY_MAX_TURNS 覆盖）"
          : "（默认；与执行者的 maxTurns 解耦）"
    }</dd>`;
    html += `<dt>评分表来源</dt><dd>${face.rubricSource ? esc(face.rubricSource) : "（未注入——advisory 恒为空）"}</dd>`;
    html += "</dl>";
  }

  // 核查时间线（使用日志卡片风格）
  if (state.verifierTimeline.length > 0) {
    html += `<div class="verify-timeline">`;
    html += `<h3 class="overview-section-title">◆ 核查 Agent 过程</h3>`;
    for (const e of state.verifierTimeline) {
      const logEntry = { ...e, collapsed: defaultCollapsed(e) };
      html += renderLogEntry(logEntry);
    }
    html += `</div>`;
  }

  if (!state.verdict && state.verifierTimeline.length === 0) {
    html += `<div class="log-empty">暂无核查记录。</div>`;
  }

  return html;
}

/** @returns {string} */
function renderVerdictCard(v) {
  const badge = v.passed
    ? '<span class="verdict-badge verdict-badge--pass">✔ 核查通过</span>'
    : '<span class="verdict-badge verdict-badge--fail">✘ 核查未通过</span>';
  let html = `<div class="verdict-card">`;
  html += `<div class="verdict-header">${badge}<span class="verdict-summary md-inline">${renderMarkdownInline(v.summary)}</span></div>`;

  if (v.issues.length > 0) {
    html += `<div class="verdict-section verdict-section--issues">`;
    html += `<div class="verdict-section-title">✗ 客观项不符</div>`;
    html += `<ul>${v.issues.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`;
    html += `</div>`;
  }
  if (v.unverified.length > 0) {
    html += `<div class="verdict-section verdict-section--unverified">`;
    html += `<div class="verdict-section-title">⋯ 待委托方复核</div>`;
    html += `<ul>${v.unverified.map((s) => `<li>⋯ ${esc(s)}</li>`).join("")}</ul>`;
    html += `</div>`;
  }
  if (v.advisory.length > 0) {
    html += `<div class="verdict-section verdict-section--advisory">`;
    html += `<div class="verdict-section-title">◈ 评审意见</div>`;
    html += `<ul>${v.advisory.map((s) => `<li class="md-inline">◈ ${renderMarkdownInline(s)}</li>`).join("")}</ul>`;
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

/**
 * 渲染空态提示。
 * @param {boolean} [hasRuns] - 列表是否已有运行记录
 */
/**
 * 空态给的是**能点的例子**，不是一句"尚无运行"。
 *
 * 第一次打开时最难的不是不会用，而是不知道**这个 agent 到底能干什么**——
 * 一句"尚无运行"把这个问题原样退回给人。四个例子刻意各走一条不同的路：
 * 纯问答（不碰工具）、读代码（只读工具）、写文件（会触发审批门）、
 * 带核查的交付（三值裁决）。点一下填进输入框，**不直接开跑**——
 * 让人看清自己要提交什么，是这个 harness 一贯的做法。
 */
export const EXAMPLE_TASKS = [
  { label: "问一个问题", text: "用三句话解释什么是 PID 控制器。不要调用工具。" },
  { label: "读一读这个项目", text: "看看当前工作目录里有哪些源文件，用一段话总结这个项目在做什么。" },
  { label: "写个文件（会问你要不要放行）", text: "在工作目录下创建 hello.md，写一段这个项目的简介。" },
  { label: "带独立核查的交付", text: "写一个 TypeScript 函数 clamp(n, min, max) 并配 vitest 测试，跑通后告诉我结果。" },
];

export function renderEmptyState(hasRuns) {
  const mainEl = document.getElementById("main-area");
  if (!mainEl) return;
  const icons = ["ph-chats-circle", "ph-file-plus", "ph-code"];
  mainEl.innerHTML =
    '<div class="empty-state empty-state--welcome">' +
    '<div class="empty-icon" aria-hidden="true"><i class="ph ph-chat-centered-dots"></i></div>' +
    '<span class="empty-eyebrow">HARNESS WORKSPACE</span>' +
    `<h2>${hasRuns ? "开始一段新对话" : "从一个明确目标开始"}</h2>` +
    `<p>${hasRuns
      ? "工作目录决定工具可触碰的边界；选好项目与角色模型，再把目标交给 Agent。"
      : "先选工作目录与角色模型，再描述目标。下面的例子只会填入输入框，由你确认后提交。"}</p>` +
    '<ul class="example-tasks">' +
    EXAMPLE_TASKS.map(
      (e, index) =>
        `<li><button type="button" class="example-task" data-example="${esc(e.text)}">` +
        `<i class="ph ${icons[index] ?? "ph-chat"}" aria-hidden="true"></i>` +
        '<span class="example-copy">' +
        `<span class="example-label">${esc(e.label)}</span>` +
        `<span class="example-text">${esc(e.text)}</span></span>` +
        '<i class="ph ph-arrow-up-right example-arrow" aria-hidden="true"></i>' +
        "</button></li>",
    ).join("") +
    "</ul></div>";
}

// ---------------------------------------------------------------

// 格式化工具

function esc(s) {
  if (typeof s !== "string") return String(s ?? "");
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(s, maxLen) {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "…";
}

function formatInput(input) {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") {
    try {
      return JSON.stringify(JSON.parse(input), null, 2);
    } catch {
      return input;
    }
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function formatTokens(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * 格式化毫秒时间戳为可读时间。
 * @param {number} ms
 * @returns {string}
 */
function formatTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 格式化毫秒时间戳为短时间（HH:mm）。
 * @param {number} ms
 * @returns {string}
 */
function formatTimeShort(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 格式化毫秒时长为可读字符串。
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m${secs}s`;
}

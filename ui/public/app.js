import { createBatcher } from "./core/batch.js";
import { diffKeyed, signature } from "./core/diff.js";
import { renderMarkdown, renderMarkdownInline } from "./core/markdown.js";
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
 *   verify: boolean,
 *   timeline: TimelineEntry[],
 *   verifierTimeline: TimelineEntry[],
 *   pendingApprovals: PendingApproval[],
 *   verdict: VerdictModel|null,
 *   usage: UsageModel|null,
 *   error: string|null,
 *   stopReason: string|null,
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
 *   droppedBlocks?: number
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
 *   approvalId?: string
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
 *   verdict: VerdictModel|null,
 *   actionItems: {pendingApprovals: PendingApproval[], unverifiedItems: string[]},
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
export function createInitialState(runId, task, verify) {
  return {
    runId,
    task,
    status: "running",
    verify,
    timeline: [],
    verifierTimeline: [],
    pendingApprovals: [],
    verdict: null,
    usage: null,
    error: null,
    stopReason: null,
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
    return applyApprovalResolved(state, event);
  }
  if (type === "approval_expired") {
    return applyApprovalExpired(state, event);
  }
  if (type === "user_message") {
    // 追加的这句话既是会话内容，也标志 run 从终态回到运行中——
    // 状态由事件本身驱动，客户端不必另写一套特判
    return {
      ...state,
      status: "running",
      runEnd: null,
      stopReason: null,
      error: null,
      conversationTurn: Number(event.turn ?? state.conversationTurn + 1),
      timeline: [...state.timeline, { seq, source, type: "user_message", text: String(event.text ?? ""), turn: Number(event.turn ?? 0) }],
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
  // 9.8 段级续跑：整段因瞬时错误死掉后带着正史接着跑。必须显式呈现——
  // 否则宿主看到一个 done(error) 之后又冒出一堆事件，完全读不懂
  if (type === "segment_resume") {
    return {
      ...state,
      // 段死了又续上：状态回到运行中，清掉那条已经不成立的错误
      status: "running",
      error: null,
      stopReason: null,
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
        guardrails: event.guardrails ?? null,
        tools: Array.isArray(event.tools) ? event.tools : [],
      },
    };
  }
  if (type === "usage") {
    return applyUsage(state, event);
  }
  if (type === "verification") {
    return applyVerification(state, event);
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
function applyVerification(state, event) {
  const raw = /** @type {any} */ (event.verdict) ?? {};
  return {
    ...state,
    verifications: [
      ...state.verifications,
      {
        round: Number(event.round ?? state.verifications.length),
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
    case "compaction":
      return { ...base, droppedBlocks: /** @type {number} */ (event.droppedBlocks) };
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
    effort: rc?.effort ?? harness?.effort ?? null,
    effortApplies: Boolean(rc ? rc.effortApplies : harness?.effortApplies),
  };
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
    .map((e) => ({ seq: e.seq, source: e.source, droppedBlocks: e.droppedBlocks ?? 0 }));

  return {
    ...usage,
    watermark: harness?.compactWatermark ?? usage.watermark,
    nearWatermark: usage.ratio !== null && usage.ratio >= (harness?.compactWatermark ?? 0.8),
    compactions,
    droppedBlocks: compactions.reduce((n, c) => n + c.droppedBlocks, 0),
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
    // 逐 run 可换工作目录，Tools 面必须报本 run 真正用的那个
    workdir: rc?.workdir ?? harness?.workdir ?? null,
    roleModels: rc?.roleModels ?? null,
    readRoots: harness?.readRoots ?? [],
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
  const whitelist = runPack?.verify?.readOnlyCommands ?? [];

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
 *   info?: {status?: string, canContinue?: boolean, mode?: string, verify?: boolean, workdir?: string, runId?: string}|null,
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
      kind: null,
      buttonLabel: "运行任务",
      labelText: "任务描述",
      // 不禁用输入框：把"先把下一条想好"的能力也没收掉是过度反应
      placeholder: "运行进行中，可以先把下一条指令打好…",
      note: "运行进行中，等这一轮结束后可以追加指令；要现在开新任务请点左侧「+ 新建对话」。",
      canSubmit: false,
      optionsEnabled: false,
    };
  }

  if (info.canContinue) {
    return {
      ...base,
      mode: "append",
      kind: "append",
      buttonLabel: "继续对话",
      labelText: "追加指令",
      placeholder: "追加一条指令，接着这次会话继续…（Ctrl+Enter 发送）",
      // 轮次预算每轮重新起算，不说清楚用户会以为 maxTurns 是整场对话的总额
      note: "续跑复用这次运行的装配（包 / 思考预算 / 工作目录 / 核查）；轮次预算每轮重新起算。",
      canSubmit: true,
      // 装配项在续跑里**构造上无效**：startContinuation 只取 run.loop 与
      // run.history，pack/effort/workdir/mode/rubric 一个都不读
      optionsEnabled: false,
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

/** 不能追加的原因（V-28：不能只是"没有输入框"，要说为什么） */
function blockedReason(info) {
  if (info.mode === "plan") {
    return "计划编排的运行不支持追加：runPlanned 每次都从拆解开始，没有续跑入口。";
  }
  if (info.verify) {
    return "开启独立核查的运行不支持追加：追加会绕过已出具的裁决。";
  }
  return "这次运行没有可续跑的会话正史（可能执行阶段就失败了）。";
}

/**
 * 提交意图。纯函数——路由决策与 DOM、网络无关，所以它可测。
 * @returns {{kind:"new"|"append", runId:string|null, text:string}|null} null = 不该提交
 */
export function composerSubmitPlan(mode, rawText) {
  if (!mode || !mode.canSubmit || !mode.kind) return null;
  const text = String(rawText ?? "").trim();
  if (!text) return null;
  return { kind: mode.kind, runId: mode.runId, text };
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
  const input = q("#task-input");
  const label = q('label[for="task-input"]');
  const note = q("#composer-note");
  const err = q("#submit-error");

  if (form) setAttr(form, "data-mode", mode.mode);
  if (btn) {
    setText(btn, mode.buttonLabel);
    setAttr(btn, "disabled", mode.canSubmit ? null : "");
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
    q("#verify-toggle"),
    ...(q("#run-knobs") ? q("#run-knobs").querySelectorAll("input, select, textarea, button") : []),
  ].filter(Boolean);
  const active = root.activeElement ?? document.activeElement;
  for (const el of knobs) setAttr(el, "disabled", mode.optionsEnabled ? null : "");
  // 禁用一个正被聚焦的控件会让焦点掉回 body（后续按键全丢）。把它交还给输入框。
  if (!mode.optionsEnabled && active && knobs.includes(active) && input?.focus) input.focus();
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
  return {
    pendingApprovals: pending,
    unverifiedItems: unverified,
    planApproval: state.planApproval ?? null,
    awaitingPlan: planPending,
    needsAttention: planPending || pending.length > 0 || unverified.length > 0,
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

  return {
    finalStatus: state.error ? "error" : state.status,
    resultSummary: lastAssistant ? lastAssistant.text ?? null : null,
    verdict: state.verdict,
    actionItems: {
      pendingApprovals,
      unverifiedItems,
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
  if (entry.type === "segment_resume") return false;
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
export function deriveRunListItems(runs, runStates) {
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
  listEl.setAttribute("aria-label", "运行列表");
  // 空态留下的占位节点不属于 patchList 管辖，先清掉
  const placeholder = listEl.querySelector(".run-list-empty");
  if (placeholder) placeholder.remove();

  // V-32：按工作目录分组。只有一个组时**自动摊平**——凭空多一层标题
  // 只会增加噪声，层级要在真有多个项目时才出现。
  const groups = groupRunsByWorkdir(runs);
  const grouped = groups.length > 1;

  // 分组时用 listbox > group > option（ARIA 1.2 允许的结构）。
  // 摊平时组容器不出现，option 直接挂在 listbox 下。
  patchList(listEl, grouped ? groups : [{ key: "", label: "", runs }], {
    key: (g) => g.key,
    create: (g) => {
      const box = document.createElement("div");
      box.className = "run-group";
      if (g.key) {
        box.setAttribute("role", "group");
        box.setAttribute("aria-label", g.label);
        box.innerHTML = '<div class="run-group-label"></div><div class="run-group-items"></div>';
        setText(box.querySelector(".run-group-label"), g.label);
      } else {
        box.innerHTML = '<div class="run-group-items"></div>';
      }
      patchRunItems(box.querySelector(".run-group-items"), g.runs, metaMap, selectedRunId, onSelect);
      return box;
    },
    update: (box, g) => {
      if (g.key) setText(box.querySelector(".run-group-label"), g.label);
      patchRunItems(box.querySelector(".run-group-items"), g.runs, metaMap, selectedRunId, onSelect);
    },
  });
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
        '<span class="verify-badge" hidden>核查</span>' +
        '<span class="run-item-verdict" hidden></span>' +
        '<span class="run-item-state-label"></span>' +
        "</div>" +
        '<div class="run-item-task"></div>' +
        '<div class="run-item-meta">' +
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

  const verifyBadge = el.querySelector(".verify-badge");
  setAttr(verifyBadge, "hidden", r.verify ? null : "");

  const verdictEl = el.querySelector(".run-item-verdict");
  const conclusion = meta ? meta.verdictConclusion : null;
  const marks = { passed: "✓", failed: "✗", pending: "⋯" };
  if (conclusion && marks[conclusion]) {
    setAttr(verdictEl, "hidden", null);
    setText(verdictEl, marks[conclusion]);
    verdictEl.className = `run-item-verdict run-item-verdict--${conclusion === "passed" ? "pass" : conclusion === "failed" ? "fail" : "pending"}`;
  } else {
    setAttr(verdictEl, "hidden", "");
  }

  setText(el.querySelector(".run-item-state-label"), r.status === "running" ? "运行中" : "已完成");
  setText(el.querySelector(".run-item-task"), r.task);
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
 *   onToggleEntry?:(seq:number)=>void
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
  /**
   * 「需你决定」现在钉在滚动容器【之外】（#action-dock），它变高变矮只会改变
   * 滚动容器的高度，不会平移容器里的内容——所以**不再需要任何滚动补偿**。
   * 此前为它写过一个视口锚定补偿函数，那是在给布局问题打补丁：补偿方向还得
   * 分"变高别动、变矮才补"两种情形，判反一次就把刚冒出来的待办推出视野。
   * 布局改对之后这段逻辑连同它的测试一起删掉了——**根因修掉，补丁就是负债**。
   */
  patchPlanGate(parts, state, faces, callbacks);
  patchApprovalRail(parts, state, isRunning, callbacks);
  patchUnverifiedRail(parts, faces);
  patchLiveStrip(parts, state, isRunning, callbacks.liveText ?? "", callbacks.liveThinking ?? "");
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
  if (!dock) return { actionRail: null, planGate: null, approvals: null, approvalsDone: null, unverified: null };
  if (!dock.querySelector(".action-rail")) {
    dock.innerHTML =
      '<div class="action-rail" hidden>' +
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
    '<button type="button" class="ctx-gauge" hidden aria-live="polite"></button>' +
    '<span class="detail-hint" hidden></span>' +
    "</div></div>" +
    '<div class="live-strip" hidden aria-live="polite"></div>' +
    '<div class="outcome-card"></div>' +
    // 四张因子卡**本身就是标签栏**：它们既是四个决定因素的摘要，也是切到对应
    // 下钻面的入口。此前卡片下面还另起一行同名标签，两排四个一模一样的词——
    // 委托方一眼看出是重复。合并之后选中态由 aria-selected 天然承载。
    '<div class="factor-grid" role="tablist" aria-label="四决定因素"></div>' +
    '<div class="tab-content" id="tab-content" role="tabpanel" tabindex="0"></div>' +
    '<div class="usage-footer" hidden></div>';

  if (showBack) {
    mainEl.querySelector("#back-to-list-btn").addEventListener("click", callbacks.onBack);
  }

  const parts = {
    root: mainEl,
    task: mainEl.querySelector(".detail-task"),
    statusBadge: mainEl.querySelector(".status-badge"),
    verifyBadge: mainEl.querySelector(".verify-badge"),
    ctxGauge: mainEl.querySelector(".ctx-gauge"),
    hint: mainEl.querySelector(".detail-hint"),
    // 「需你决定」在滚动容器之外（#action-dock，钉在输入框上方）——
    // 它不随内容滚走，新审批出现在哪都看得见（委托方建议的结构解法）
    ...ensureActionDock(),
    liveStrip: mainEl.querySelector(".live-strip"),
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

  // 五格文本刻度：不依赖 SVG、能被屏幕阅读器念出来，也不会在窄屏里被挤没。
  // 没配上限时**不画刻度**——五个空格看起来像"0%"，而事实是"不知道"，
  // 用空刻度表达未知就是在说谎。这时只报绝对值。
  const glyph =
    pct === null
      ? ""
      : "▮".repeat(Math.min(5, Math.max(1, Math.ceil(pct / 20)))) +
        "▯".repeat(5 - Math.min(5, Math.max(1, Math.ceil(pct / 20))));
  const label = pct === null ? `上下文 ${formatTokens(ctx.lastInputTokens)}` : `${pct}%`;
  const compacted = ctx.compactions.length > 0 ? ` ⊟${ctx.compactions.length}` : "";
  setText(el, `${glyph ? `${glyph} ` : ""}${label}${compacted}`);

  // 无障碍名称要说全口径与后果——光念"48%"没有信息量
  const parts2 = [
    pct === null
      ? `上下文最近一轮输入 ${formatTokens(ctx.lastInputTokens)}（未配置上限）`
      : `上下文水位 ${pct}%，最近一轮输入 ${formatTokens(ctx.lastInputTokens)} / 上限 ${formatTokens(ctx.limit)}`,
    ctx.compactions.length > 0
      ? `已压缩 ${ctx.compactions.length} 次，置换 ${ctx.droppedBlocks} 个 tool_result 原文，不可恢复`
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
    `<p class="plan-gate-body">planner 已拆出 <strong>${count}</strong> 个子任务（详见 Plan 面）。` +
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
  const label = streaming
    ? tailOf(streaming, 80)
    : thinking
    ? `✽ ${tailOf(thinking, 76)}`
    : call
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

  let html = "";
  if (state.status === "running") {
    html += '<p class="outcome-pending">运行中，尚无最终结果。</p>';
  } else {
    const cls = classifyStopReason(state.stopReason);
    html += `<div class="outcome-line outcome-line--${cls.tone}">`;
    html += `<span class="outcome-mark">■</span> ${esc(cls.label)}`;
    html += "</div>";
    if (state.error) html += `<p class="outcome-error">${esc(state.error)}</p>`;
  }

  if (v.verdict) {
    const reworkNote = loop.reworks > 0 ? `（返工 ${loop.reworks} 轮后${v.verdict.passed ? "通过" : "仍未过"}）` : "";
    html += `<div class="outcome-verdict outcome-verdict--${v.badge}">`;
    html += `<span class="outcome-verdict-badge">${verdictBadgeLabel(v.badge)}</span>`;
    html += `<span class="outcome-verdict-note">${esc(reworkNote)}</span>`;
    html += "</div>";
    if (v.verdict.summary) {
      html += `<p class="outcome-verdict-summary md-inline">${renderMarkdownInline(v.verdict.summary)}</p>`;
    }
    if (v.verdict.issues.length > 0) {
      // V-19：passed=true 时 issues 降级为黄色备注而不是红色不符——
      // 项目有两个真实案例是"通过但备注里藏着真 bug"，这一态不能被绿色吞掉
      const mark = v.verdict.passed ? "⚠" : "✗";
      const tone = v.verdict.passed ? "warn" : "bad";
      html += `<ul class="outcome-issues outcome-issues--${tone}">`;
      html += v.verdict.issues.map((i) => `<li class="md-inline">${mark} ${renderMarkdownInline(i)}</li>`).join("");
      html += "</ul>";
    }
  }

  if (summary) {
    const lines = summary.split("\n");
    const long = lines.length > 6;
    html += '<details class="outcome-summary"' + (long ? "" : " open") + ">";
    html += `<summary>执行者报告${long ? `（${lines.length} 行）` : ""}</summary>`;
    html += `<div class="outcome-summary-text">${esc(summary)}</div>`;
    html += "</details>";
  }

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

  const ctxLines = [];
  if (context.limit) {
    ctxLines.push(`本轮输入 ${formatTokens(context.lastInputTokens)} / ${formatTokens(context.limit)}`);
  } else {
    ctxLines.push(`本轮输入 ${formatTokens(context.lastInputTokens)}`);
  }
  ctxLines.push(`缓存命中 ${(context.cacheHitRatio * 100).toFixed(0)}%`);
  if (context.compactions.length > 0) {
    ctxLines.push(`⚠ 压缩 ${context.compactions.length} 次 · 置换 ${context.droppedBlocks} 块不可恢复`);
  }

  const toolLines = [];
  toolLines.push(tools.pack?.name ? `包 ${tools.pack.name}` : "无领域包");
  toolLines.push(`${tools.tools.length} 个工具 · 调用 ${tools.totalCalls} 次`);
  if (tools.totalErrors > 0) toolLines.push(`✗ 失败 ${tools.totalErrors} 次`);
  if (tools.denials.length > 0) toolLines.push(`⊘ 被拒 ${tools.denials.length} 次`);
  if (tools.readRoots.length > 0) toolLines.push(`只读根 ${tools.readRoots.length} 个`);

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
      abnormal: tools.totalErrors > 0 || tools.denials.length > 0,
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
    // `.chat-view` 已被上面这行重建成空 div，而 patchLoopView 看签名没变
    // 直接提前 return——整段对话白屏，且没有任何报错。
    parts.sig.chat = null;
    if (activeTab === "loop") {
      // V-23：同一段执行的两种读法。事件流是"它做了什么"（逐工具、逐结果），
      // 对话是"它当时在想什么"（user/assistant/tool 往返）。两者信息量不同，
      // 不是换皮——回看一次失败时，往往要先看对话才知道它为什么那么做。
      container.innerHTML =
        '<div class="view-switch" role="group" aria-label="执行视图">' +
        '<button type="button" class="view-btn" data-view="events">事件流</button>' +
        '<button type="button" class="view-btn" data-view="chat">对话</button>' +
        "</div>" +
        '<div class="plan-board"></div>' +
        '<h3 class="overview-section-title">Agent 执行</h3>' +
        '<div class="rework-chain"></div>' +
        '<div class="log-entries"></div>' +
        '<div class="chat-view" hidden></div>';
      container.__logHost = container.querySelector(".log-entries");
      container.querySelectorAll(".view-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          callbacks.onSwitchView?.(btn.getAttribute("data-view"));
        });
      });
    }
  }

  if (activeTab === "loop") {
    patchPlanBoard(parts, container.querySelector(".plan-board"), faces.plan);
    patchReworkChain(container.querySelector(".rework-chain"), faces.loop);
    patchLoopView(parts, container, state, logEntries, callbacks);
    return;
  }

  // context / tools / verify：无输入控件、无滚动锚点，签名变了整体重绘即可
  const sig =
    activeTab === "context"
      ? signature([
          faces.context.lastInputTokens, faces.context.limit,
          faces.context.compactions.length, faces.context.perTurn.length,
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
  host.innerHTML = loop.chain
    .map((c) => {
      const mark = c.role === "verifier" ? (c.passed === null ? "⋯" : c.passed ? "✔" : "✘") : "■";
      const tone = c.role === "verifier" ? (c.passed === null ? "pending" : c.passed ? "ok" : "bad") : "neutral";
      const label = c.role === "rework" ? `↺ ${roleLabel[c.role]}` : roleLabel[c.role];
      const round = c.role === "main" ? "" : ` ${c.round}`;
      return `<span class="chain-node chain-node--${tone}">${mark} ${esc(label)}${round}</span>`;
    })
    .join('<span class="chain-arrow">▸</span>');
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
    html += `<strong>⚠ 上下文压缩 ${ctx.compactions.length} 次，置换 ${ctx.droppedBlocks} 个 tool_result 原文</strong>`;
    html += "<p>本地截断是不可逆的信息丢失：被置换的原文永不可恢复，模型只能重新调用工具取回。</p>";
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
    html += '<div class="callout callout--bad"><strong>planner 未能产出可解析计划</strong>' +
      "<p>整份计划作废，没有执行任何子任务（fail-closed）。下面是 planner 的原始输出片段。</p>" +
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
  const view = callbacks.loopView === "chat" ? "chat" : "events";
  const logHost = container.querySelector(".log-entries");
  const chatHost = container.querySelector(".chat-view");

  for (const btn of container.querySelectorAll(".view-btn")) {
    const on = btn.getAttribute("data-view") === view;
    setClass(btn, "view-btn--active", on);
    setAttr(btn, "aria-pressed", String(on));
  }
  setAttr(logHost, "hidden", view === "events" ? null : "");
  setAttr(chatHost, "hidden", view === "chat" ? null : "");

  if (view === "events") {
    patchLogPanel(container, logEntries, callbacks, state);
    return;
  }

  // 对话视图现在只剩正史——追加框已经并进底栏那个共用的 composer。
  // 签名里也随之去掉 canContinue/followUpError，顺手消掉"一条错误就把整段
  // 对话重画一遍"这个噪音源。
  const sig = signature([
    callbacks.transcript ? callbacks.transcript.segments.length : -1,
    state.lastSeq,
  ]);
  if (parts.sig.chat === sig) return;
  parts.sig.chat = sig;

  chatHost.innerHTML = renderConversation(callbacks.transcript, state);
}

/**
 * 会话正史视图。
 *
 * 数据来自 GET /api/runs/:id/transcript——`AgentRunResult.messages` 一直存在，
 * 只是从没透出过（SSE 里只带 messageCount，几 MB 的会话不能进事件缓冲）。
 *
 * 渲染上有一处容易搞错：**带 tool_result 的 user 消息不是用户说的话**。
 * Anthropic 的协议把工具返回值放在 user 角色里回传给模型，若照 role 直接画成
 * 用户气泡，界面会显示成"用户对着 agent 念了一堆命令输出"。这里按内容块
 * 类型分派，工具返回归到工具那一侧。
 * @returns {string}
 */
export function renderConversation(transcript, state) {
  if (!transcript) {
    return '<p class="empty-note">正在载入会话…</p>';
  }
  const segments = transcript.segments ?? [];
  if (segments.length === 0) {
    return '<p class="empty-note">本次运行尚无完整会话记录——会话在每一段执行结束时落盘，运行中请先看事件流。</p>';
  }

  let html = "";
  let prev = null;
  for (const seg of segments) {
    const role = segmentRole(seg.source);
    const msgs = seg.messages ?? [];

    // 续跑返回的是**累计**正史：第 2 轮那一段包含第 1 轮的全部消息。
    // 直接逐段全量渲染会把前面几轮重复画一遍。同源且构成前缀时只渲染增量。
    let start = 0;
    if (prev && prev.source === seg.source && isPrefix(prev.messages ?? [], msgs)) {
      start = (prev.messages ?? []).length;
    }
    if (segments.length > 1 && start === 0) {
      html += renderSegmentBoundary({ role, round: seg.index, source: seg.source });
    }
    for (const msg of msgs.slice(start)) {
      html += renderChatMessage(msg);
    }
    prev = seg;
  }

  // V-28：正在进行的这一轮还没落盘（transcript 只在段结束时写），
  // 但追加的指令已经在事件流里——不补上的话，用户会看到自己刚发的话凭空消失
  const pendingTurns = (state?.timeline ?? []).filter(
    (e) => e.type === "user_message" && !JSON.stringify(segments).includes(e.text),
  );
  for (const t of pendingTurns) {
    html += renderChatMessage({ role: "user", content: t.text });
  }
  if (state?.status === "running" && pendingTurns.length > 0) {
    html += '<p class="empty-note">这一轮进行中，完整会话在本轮结束后落盘。</p>';
  }
  return html || '<p class="empty-note">会话为空。</p>';
}

/**
 * 单条消息。
 *
 * 排版原则：**对话是叙事，不是管道**。文字是主角，工具调用与返回值折叠成
 * 一行摘要——需要时能展开，但不该淹没"它当时在说什么、在想什么"。
 * 想看逐工具的完整过程，事件流视图本来就是干这个的。
 * @returns {string}
 */
function renderChatMessage(msg) {
  const blocks = Array.isArray(msg?.content)
    ? msg.content
    : [{ type: "text", text: String(msg?.content ?? "") }];

  // 工具返回块单独成组：协议上它们挂在 user 角色下，语义上属于工具
  const toolResults = blocks.filter((b) => b && b.type === "tool_result");
  const rest = blocks.filter((b) => !b || b.type !== "tool_result");

  let html = "";
  for (const b of toolResults) {
    const text = extractBlockText(b.content);
    const head = firstLine(text, 72);
    html +=
      `<details class="chat-aside${b.is_error ? " chat-aside--err" : ""}">` +
      `<summary><span class="aside-mark">${b.is_error ? "✗" : "✓"}</span> 工具返回` +
      (head ? ` <span class="aside-peek">${esc(head)}</span>` : "") +
      "</summary>" +
      `<pre class="chat-body">${esc(truncate(text, 4000))}</pre>` +
      "</details>";
  }

  const thinking = rest.filter((b) => b && (b.type === "thinking" || b.type === "redacted_thinking"));
  const speech = rest.filter((b) => b && (b.type === "text" || b.type === "tool_use"));
  if (thinking.length === 0 && speech.length === 0) return html;

  const who = msg?.role === "assistant" ? "assistant" : "user";
  html += `<div class="chat-msg chat-msg--${who}">`;
  html += `<div class="chat-role">${who === "assistant" ? "¶ Agent" : "委托方"}</div>`;

  // 思考过程：数据一直在 transcript 里（src/model-client.ts:41 显式开了
  // adaptive thinking，loop.ts:209 完整 push 了 content 块），此前只是没人渲染。
  // 默认折叠——它是"为什么这么做"的证据，不是主线叙述。
  for (const b of thinking) {
    if (b.type === "redacted_thinking") {
      html += '<div class="chat-thinking chat-thinking--redacted">✽ 思考过程已被服务端加密（redacted），无法展示</div>';
      continue;
    }
    const t = String(b.thinking ?? "");
    html +=
      '<details class="chat-thinking">' +
      `<summary>✽ 思考过程 <span class="aside-peek">${t.length} 字</span></summary>` +
      `<div class="chat-body chat-body--text md">${renderMarkdown(t)}</div>` +
      "</details>";
  }

  for (const b of speech) {
    if (b.type === "text") {
      html += `<div class="chat-body chat-body--text md">${renderMarkdown(b.text ?? "")}</div>`;
    } else {
      const input = formatInput(b.input);
      html +=
        '<details class="chat-aside chat-aside--call">' +
        `<summary><span class="aside-mark">→</span> <code>${esc(b.name ?? "")}</code>` +
        ` <span class="aside-peek">${esc(firstLine(input, 60))}</span></summary>` +
        `<pre class="chat-body">${esc(truncate(input, 1200))}</pre>` +
        "</details>";
    }
  }
  html += "</div>";
  return html;
}

/** 取首行并截断——折叠摘要上给一眼能认出是什么的线索 */
function firstLine(text, max) {
  const line = String(text ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  return truncate(line.trim(), max);
}

/** a 是否为 b 的前缀（逐条深比对——消息里含内容块数组，浅比会漏判） */
function isPrefix(a, b) {
  if (a.length === 0 || a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
  }
  return true;
}

/** tool_result 的 content 可能是字符串，也可能是内容块数组 */
function extractBlockText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((c) => (c && c.type === "text" ? c.text : typeof c === "string" ? c : JSON.stringify(c)))
    .join("\n");
}

/** 段分界：main→verifier 用 ━，返工用 CLI 同款 ↺（src/cli.ts:449） */
function renderSegmentBoundary(seg) {
  const label = {
    verifier: "核查 Agent 独立复核（全新上下文）",
    rework: `核查未通过，开始返工（第 ${seg.round} 轮）`,
    planner: "计划单元（planner，只读拆解）",
    main: "Agent 执行",
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

  // 验证结论
  if (overview.verdict) {
    html += renderVerdictCard(overview.verdict);
  }

  // 需介入事项
  const hasActionItems =
    overview.actionItems.pendingApprovals.length > 0 ||
    overview.actionItems.unverifiedItems.length > 0;
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
  if (e.type === "compaction") cls += " log-entry--warning";
  if (collapsed) cls += " log-entry--collapsed";

  return `<div class="${cls}" data-seq="${e.seq}">
    ${headerHtml}
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
    case "compaction":
      return `<div class="log-entry-body">丢弃 ${e.droppedBlocks ?? "?"} 个块</div>`;
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
    case "tool_result": return isError ? "✗" : "✓"; // cli.ts:530-531
    case "assistant_text": return "¶";   // CLI 直接流式打印无标记，列表里需要一个
    case "assistant_thinking": return "✽"; // 与对话视图同款，自成语域
    case "approval_request": return "⚠"; // cli.ts:539
    case "api_retry": return "⟳";        // cli.ts:563
    case "segment_resume": return "⟲";   // 与 ⟳(同轮重试) 区分：这是整段续跑
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
    // name 由 deriveLogEntries 按 toolUseId 回填；真取不到才退回 id（V-12）
    case "tool_result": return `${e.name ?? e.toolUseId ?? ""} ${e.resultIsError ? "失败" : "成功"}`;
    case "assistant_text": return "助手消息";
    case "assistant_thinking":
      return e.redacted ? "思考过程（已加密）" : `思考过程（${(e.text ?? "").length} 字）`;
    case "approval_request": return `审批请求：${e.name ?? ""}`;
    case "api_retry": return `API 重试（第${e.attempt ?? "?"}次）`;
    case "segment_resume": return `瞬时失败后带正史续跑（已完成 ${e.priorTurns ?? "?"} 轮）`;
    case "compaction": return "上下文压缩";
    case "usage": return "本轮用量";
    case "user_message": return `追加指令（第 ${e.turn ?? "?"} 轮对话）`;
    default: return e.type;
  }
}

/** @returns {string} */
function entryDetail(e) {
  switch (e.type) {
    case "tool_call":
      return truncate(formatInput(e.input), 60);
    case "tool_result":
      return truncate(e.resultContent ?? "", 60);
    case "assistant_text":
      return truncate(e.text ?? "", 80);
    case "approval_request":
      return truncate(formatInput(e.input), 60);
    case "api_retry":
      return e.reason ?? "";
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
    if (recoveries.length > 0 && recoveries.some((r) => r !== "direct")) {
      const label = { direct: "首轮直接给出", wrapup: "预算用尽后收口续跑救回", reformat: "重问转写救回", failed: "兜底未救回（fail-closed）" };
      html += '<h3 class="overview-section-title">裁决获得路径</h3><ul class="unverified-list">';
      html += face.rounds
        .map((r, i) => `<li>第 ${r.round ?? i} 轮：${esc(label[r.recovery] ?? String(r.recovery ?? "—"))}</li>`)
        .join("");
      html += "</ul><p class=\"rail-note\">非「首轮直接给出」说明核查者收口不稳——问题出在核查这一环，不是产物本身。</p>";
    }

    html += '<h3 class="overview-section-title">核查者的边界</h3><dl class="boundary-list">';
    html += `<dt>只读白名单</dt><dd>${face.whitelist.length ? esc(face.whitelist.join("、")) : "（空——只能读文件，无法重跑门禁）"}</dd>`;
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
export function renderEmptyState(hasRuns) {
  const mainEl = document.getElementById("main-area");
  if (mainEl) {
    const msg = hasRuns
      ? "选择左侧运行查看详情，或创建新任务。"
      : "尚无运行。";
    mainEl.innerHTML = `<div class="empty-state">
      <div class="empty-icon">◌</div>
      <p>${msg}</p>
    </div>`;
  }
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

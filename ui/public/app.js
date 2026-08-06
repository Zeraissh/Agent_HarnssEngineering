import { createBatcher } from "./core/batch.js";
import { diffKeyed, signature } from "./core/diff.js";
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

  // text_delta — 忽略不渲染（assistant_text 已含全文）
  if (type === "text_delta") return state;

  // ---- 路由 ----
  if (type === "verdict") {
    return applyVerdict(state, event);
  }
  if (type === "done") {
    return applySegmentDone(state, event);
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
    case "api_retry":
      return {
        ...base,
        turn: /** @type {number} */ (event.turn),
        attempt: /** @type {number} */ (event.attempt),
        reason: /** @type {string} */ (event.reason),
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
function applySegmentDone(state, event) {
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

  // 单段运行的快路径：非核查模式下不会再有后续段，done 即终止
  if (!state.verify) {
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
 * Loop 面：轮次水位、六值终止、返工裁决序列。
 * @param {RunState} state
 * @param {object|null} harness `/api/harness` 快照
 */
export function deriveLoopFace(state, harness) {
  const isRunning = state.status === "running";
  const maxTurns = harness?.guardrails?.maxTurns ?? null;

  // 轮次取执行侧（main/rework）的最大 turn_start——核查轮预算独立，不该混进来
  let turn = 0;
  for (const e of state.timeline) {
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
    effort: harness?.effort ?? null,
    effortApplies: Boolean(harness?.effortApplies),
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
  const usage = deriveContextUsage(state, harness?.guardrails?.contextTokenLimit ?? null);
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

  const declared = harness?.tools ?? [];
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
    pack: harness?.pack ?? null,
    shell: harness?.shell ?? null,
    workdir: harness?.workdir ?? null,
    readRoots: harness?.readRoots ?? [],
    mcp: harness?.mcp ?? null,
    guardrails: harness?.guardrails ?? null,
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
  const whitelist = harness?.pack?.verify?.readOnlyCommands ?? [];

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
    rubricSource: harness?.pack?.verify?.rubricSource ?? null,
    budgetTurns: harness?.verifierBudgetTurns ?? null,
    starvation: {
      noWhitelist: whitelist.length === 0 && verifierDenied,
      emptyRework,
      parseFail,
    },
  };
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
  return {
    pendingApprovals: pending,
    unverifiedItems: unverified,
    needsAttention: pending.length > 0 || unverified.length > 0,
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

  // V-10：键控补丁而非 innerHTML 重建。侧栏每 3 秒被刷新一次，整体重建会把
  // 停在运行项上的键盘焦点直接摧毁（实测 3.6s 后 activeElement 变成 BODY）。
  // 复用节点后，焦点、hover 态、CSS 过渡都得以保持。
  patchList(listEl, runs, {
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
  };

  // V-10：骨架建一次，之后逐区补丁。此前每条 SSE 事件重建整页 innerHTML——
  // 实测拒绝理由输入框的字被清空、日志滚动归零、长运行退化成 O(n²)。
  const parts = ensureDetailSkeleton(mainEl, state, callbacks);

  patchDetailHeader(parts, state, isRunning, faces);
  patchApprovalRail(parts, state, isRunning, callbacks);
  patchUnverifiedRail(parts, faces);
  patchLiveStrip(parts, state, isRunning);
  patchOutcomeCard(parts, state, overview, faces);
  patchFactorGrid(parts, faces, callbacks);
  patchTabNav(parts, state, activeTab, callbacks, faces);
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
    '<span class="detail-hint" hidden></span>' +
    "</div></div>" +
    '<div class="action-rail" hidden>' +
    '<div class="approval-cards" hidden></div>' +
    '<div class="unverified-rail" hidden></div>' +
    "</div>" +
    '<div class="live-strip" hidden aria-live="polite"></div>' +
    '<div class="outcome-card"></div>' +
    '<div class="factor-grid"></div>' +
    '<div class="tab-nav" role="tablist" aria-label="详情视图切换"></div>' +
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
    hint: mainEl.querySelector(".detail-hint"),
    actionRail: mainEl.querySelector(".action-rail"),
    approvals: mainEl.querySelector(".approval-cards"),
    unverified: mainEl.querySelector(".unverified-rail"),
    liveStrip: mainEl.querySelector(".live-strip"),
    outcome: mainEl.querySelector(".outcome-card"),
    factorGrid: mainEl.querySelector(".factor-grid"),
    tabNav: mainEl.querySelector(".tab-nav"),
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
 * 待复核项（⋯ unverified）。
 *
 * 只在这里出现一次。V-16：此前概览的"裁决卡"与"需介入事项"把同一批列了两遍，
 * 用户以为有两组待办。裁决卡里的那份现在是下钻详情，不是第二份清单。
 */
function patchUnverifiedRail(parts, faces) {
  const items = faces.action.unverifiedItems;
  const sig = signature([items.length, items.join("|")]);
  setAttr(parts.actionRail, "hidden", faces.action.needsAttention ? null : "");
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
    items.map((i) => `<li class="unverified-item">${esc(i)}</li>`).join("") +
    "</ul>" +
    '<p class="rail-note">核查者无法自行判定这些项，已移交委托方。不影响 passed，也不触发返工。</p>';
}

/** 直播条：运行中显示最近一次工具调用或最后一句输出 */
function patchLiveStrip(parts, state, isRunning) {
  if (!isRunning) {
    setAttr(parts.liveStrip, "hidden", "");
    parts.sig.live = null;
    return;
  }
  const recent = [...state.timeline].reverse();
  const call = recent.find((e) => e.type === "tool_call");
  const text = recent.find((e) => e.type === "assistant_text");
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
  const list = state.pendingApprovals;
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

function updateApprovalCard(card, a, isRunning) {
  const isPending = a.status === "pending";
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
      html += `<p class="outcome-verdict-summary">${esc(v.verdict.summary)}</p>`;
    }
    if (v.verdict.issues.length > 0) {
      // V-19：passed=true 时 issues 降级为黄色备注而不是红色不符——
      // 项目有两个真实案例是"通过但备注里藏着真 bug"，这一态不能被绿色吞掉
      const mark = v.verdict.passed ? "⚠" : "✗";
      const tone = v.verdict.passed ? "warn" : "bad";
      html += `<ul class="outcome-issues outcome-issues--${tone}">`;
      html += v.verdict.issues.map((i) => `<li>${mark} ${esc(i)}</li>`).join("");
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
function patchFactorGrid(parts, faces, callbacks) {
  const cards = buildFactorCards(faces);
  const sig = signature([JSON.stringify(cards.map((c) => [c.id, c.abnormal, c.lines.join("~")]))]);
  if (parts.sig.factors === sig) return;
  parts.sig.factors = sig;

  patchList(parts.factorGrid, cards, {
    key: (c) => c.id,
    create: (c) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "factor-card";
      el.setAttribute("data-factor", c.id);
      el.innerHTML =
        '<span class="factor-title"></span><span class="factor-lines"></span>';
      el.addEventListener("click", () => {
        document.dispatchEvent(new CustomEvent("tab-switch", { detail: { tab: c.id } }));
      });
      updateFactorCard(el, c);
      return el;
    },
    update: updateFactorCard,
  });
}

function updateFactorCard(el, c) {
  setClass(el, "factor-card--abnormal", c.abnormal);
  setText(el.querySelector(".factor-title"), c.title);
  setAttr(el, "aria-label", `${c.title}：${c.lines.join("，")}。查看详情`);
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

function patchTabNav(parts, state, activeTab, callbacks, faces) {
  const tabs = [
    { id: "loop", label: "Loop 循环" },
    { id: "context", label: "Context 上下文" },
    { id: "tools", label: "Tools 工具" },
  ];
  if (state.verifierTimeline.length > 0 || state.verdict) {
    tabs.push({ id: "verify", label: "Verification 核查" });
  }

  const sig = signature([tabs.map((t) => t.id).join(","), activeTab]);
  if (parts.sig.tabNav === sig) return;
  parts.sig.tabNav = sig;

  parts.tabNav.innerHTML = tabs
    .map((t) => renderTabButton(t.id, t.label, activeTab))
    .join("");
  setAttr(parts.tabContent, "aria-labelledby", `tab-${activeTab}`);

  const tabBtns = [...parts.tabNav.querySelectorAll(".tab-btn")];
  const switchTab = (tab) => {
    if (tab) document.dispatchEvent(new CustomEvent("tab-switch", { detail: { tab } }));
  };
  tabBtns.forEach((btn, idx) => {
    btn.addEventListener("click", () => switchTab(btn.getAttribute("data-tab")));
    // roving tabindex 下 Tab 只进当前项，组内移动靠方向键 —— 没有这段，
    // 未选中的标签就彻底不可键盘到达（比改之前更糟）
    btn.addEventListener("keydown", (e) => {
      const key = /** @type {KeyboardEvent} */ (e).key;
      let next = -1;
      if (key === "ArrowRight" || key === "ArrowDown") next = (idx + 1) % tabBtns.length;
      else if (key === "ArrowLeft" || key === "ArrowUp") next = (idx - 1 + tabBtns.length) % tabBtns.length;
      else if (key === "Home") next = 0;
      else if (key === "End") next = tabBtns.length - 1;
      if (next < 0) return;
      e.preventDefault();
      switchTab(tabBtns[next].getAttribute("data-tab"));
    });
  });
}

function patchTabContent(parts, state, activeTab, overview, logEntries, callbacks, faces) {
  const container = parts.tabContent;

  // 换标签页时内容形态完全不同，直接重建；同一标签内走各自的增量策略
  if (container.__tab !== activeTab) {
    container.innerHTML = "";
    container.__patchNodes = undefined;
    container.__tab = activeTab;
    parts.sig.tabBody = null;
    if (activeTab === "loop") {
      container.innerHTML =
        '<h3 class="overview-section-title">Agent 执行</h3>' +
        '<div class="rework-chain"></div>' +
        '<div class="log-entries"></div>';
      container.__logHost = container.querySelector(".log-entries");
    }
  }

  if (activeTab === "loop") {
    patchReworkChain(container.querySelector(".rework-chain"), faces.loop);
    patchLogPanel(container, logEntries, callbacks, state);
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

/** 段分界：main→verifier 用 ━，返工用 CLI 同款 ↺（src/cli.ts:449） */
function renderSegmentBoundary(seg) {
  const label = {
    verifier: "核查 Agent 独立复核（全新上下文）",
    rework: `核查未通过，开始返工（第 ${seg.round} 轮）`,
    main: "Agent 执行",
  }[seg.role];
  const mark = seg.role === "rework" ? "↺" : seg.role === "verifier" ? "◆" : "▸";
  return `<div class="segment-boundary segment-boundary--${seg.role}"><span class="segment-mark">${mark}</span><span class="segment-label">${esc(label)}</span></div>`;
}

function patchUsageFooter(parts, state) {
  const html = renderUsageFooterBody(state);
  const sig = signature([html.length, html.slice(0, 120)]);
  if (parts.sig.usage === sig) return;
  parts.sig.usage = sig;
  setAttr(parts.usage, "hidden", html ? null : "");
  parts.usage.innerHTML = html;
}

/** @returns {string} */
function renderTabButton(tab, label, activeTab) {
  const isActive = tab === activeTab;
  // aria-controls + id 让屏幕阅读器知道该 tab 控制哪个面板；未选中项 tabindex=-1
  // 走 roving tabindex（APG tabs 模式），Tab 键只进入当前选中项，组内用方向键切换
  return `<button class="tab-btn ${isActive ? "tab-btn--active" : ""}"
    id="tab-${tab}"
    role="tab"
    aria-selected="${isActive}"
    aria-controls="tab-content"
    tabindex="${isActive ? "0" : "-1"}"
    data-tab="${tab}">${label}</button>`;
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
      return `<div class="log-entry-body log-entry-text">${esc(e.text ?? "")}</div>`;
    case "approval_request":
      return `<pre class="log-entry-body">${esc(formatInput(e.input))}</pre>`;
    case "api_retry":
      return `<div class="log-entry-body">原因：${esc(e.reason ?? "")}</div>`;
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
    case "approval_request": return "⚠"; // cli.ts:539
    case "api_retry": return "⟳";        // cli.ts:563
    // CLI 对压缩也用 ⚠，这里刻意分开：V-19 要求不可逆自成语域，
    // 与普通警告共用符号会让人对它脱敏
    case "compaction": return "⊟";
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
    case "approval_request": return `审批请求：${e.name ?? ""}`;
    case "api_retry": return `API 重试（第${e.attempt ?? "?"}次）`;
    case "compaction": return "上下文压缩";
    case "usage": return "本轮用量";
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
    default:
      return "";
  }
}

/** @returns {string} */
function renderVerifyTab(state, face) {
  let html = "";

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
    html += '<h3 class="overview-section-title">核查者的边界</h3><dl class="boundary-list">';
    html += `<dt>只读白名单</dt><dd>${face.whitelist.length ? esc(face.whitelist.join("、")) : "（空——只能读文件，无法重跑门禁）"}</dd>`;
    html += `<dt>核查预算</dt><dd>${face.budgetTurns ?? "—"} 轮（固定，与执行者的 maxTurns 解耦）</dd>`;
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
  html += `<div class="verdict-header">${badge}<span class="verdict-summary">${esc(v.summary)}</span></div>`;

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
    html += `<ul>${v.advisory.map((s) => `<li>◈ ${esc(s)}</li>`).join("")}</ul>`;
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

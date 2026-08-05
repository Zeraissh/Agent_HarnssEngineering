/**
 * Harness Web UI — 纯函数 reducer + DOM 渲染层。
 *
 * 架构：
 *   reduceEvent(state, sseEvent) → 纯函数，把 SSE 事件流折叠为渲染模型。
 *   DOM 渲染函数惰性引用 window/document，可被 vitest node 环境 import。
 *
 * 导出：
 *   - reduceEvent: 纯 reducer
 *   - createInitialState: 初始状态工厂
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
 *   error: string|null
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
 * @typedef {{
 *   toolUseId: string,
 *   name: string,
 *   input: unknown,
 *   status: "pending"|"allowed"|"denied",
 *   reason?: string
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
  };
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
    return applyDone(state, event);
  }
  if (type === "approval_request") {
    return applyApproval(state, seq, source, event);
  }

  // 其余事件进入时间线
  const entry = buildTimelineEntry(seq, source, type, event);
  const isVerifier = source === "verifier";
  return {
    ...state,
    timeline: isVerifier ? state.timeline : [...state.timeline, entry],
    verifierTimeline: isVerifier ? [...state.verifierTimeline, entry] : state.verifierTimeline,
  };
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
  if (source === "verifier") {
    return {
      ...state,
      verifierTimeline: [...state.verifierTimeline, entry],
    };
  }

  // main/rework 审批：进时间线 + 挂起审批列表
  return {
    ...state,
    timeline: [...state.timeline, entry],
    pendingApprovals: [
      ...state.pendingApprovals,
      { toolUseId, name, input, status: "pending" },
    ],
  };
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

/** @returns {RunState} */
function applyDone(state, event) {
  const usage = event.usage && typeof event.usage === "object" ? /** @type {any} */ (event.usage) : null;
  const stopReason = /** @type {string} */ (event.stopReason);
  return {
    ...state,
    status: "done",
    error: stopReason === "error" ? "运行异常终止" : null,
    usage: usage
      ? {
          turns: Number(usage.turns ?? 0),
          inputTokens: Number(usage.inputTokens ?? 0),
          outputTokens: Number(usage.outputTokens ?? 0),
          cacheHitRatio: Number(usage.cacheHitRatio ?? 0),
        }
      : null,
  };
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
export function markApprovalResolved(state, toolUseId, decision, reason) {
  return {
    ...state,
    pendingApprovals: state.pendingApprovals.map((a) =>
      a.toolUseId === toolUseId ? { ...a, status: decision, reason } : a,
    ),
  };
}

// ---------------------------------------------------------------
// DOM 渲染（仅浏览器环境调用——惰性引用 window/document）
// ---------------------------------------------------------------

/**
 * 渲染运行列表侧栏。
 * @param {{runId:string, task:string, status:string, verify:boolean}[]} runs
 * @param {string|null} selectedRunId
 * @param {(runId:string)=>void} onSelect
 */
export function renderRunList(runs, selectedRunId, onSelect) {
  const listEl = document.getElementById("run-list");
  if (!listEl) return;
  if (runs.length === 0) {
    listEl.innerHTML = '<div class="run-list-empty">暂无运行</div>';
    return;
  }
  listEl.innerHTML = runs
    .map(
      (r) => `
    <div class="run-item ${r.runId === selectedRunId ? "run-item--selected" : ""}"
         data-run-id="${esc(r.runId)}">
      <div class="run-item-status">
        <span class="status-dot ${r.status === "running" ? "status-dot--live" : ""}"></span>
        ${r.verify ? '<span class="verify-badge">核查</span>' : ""}
      </div>
      <div class="run-item-task">${esc(r.task)}</div>
      <div class="run-item-meta">${r.status === "running" ? "运行中…" : "已完成"}</div>
    </div>`,
    )
    .join("");

  listEl.querySelectorAll(".run-item").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-run-id");
      if (id) onSelect(id);
    });
  });
}

/**
 * 渲染单个 run 的详情视图。
 * @param {RunState} state
 * @param {{onAllow:(toolUseId:string)=>void, onDeny:(toolUseId:string)=>void, onDenyReason:(toolUseId:string,reason:string)=>void}} callbacks
 */
export function renderRunDetail(state, callbacks) {
  const mainEl = document.getElementById("main-area");
  if (!mainEl) return;

  const isRunning = state.status === "running";
  const statusClass = isRunning ? "status--live" : state.error ? "status--error" : "status--done";
  const statusText = isRunning ? "运行中" : state.error ? "异常终止" : "已完成";

  let html = "";
  html += `<div class="detail-header">`;
  html += `<h2 class="detail-task">${esc(state.task)}</h2>`;
  html += `<div class="detail-meta">`;
  html += `<span class="status-badge ${statusClass}">${statusText}</span>`;
  if (state.verify) html += `<span class="verify-badge">核查模式</span>`;
  html += `</div></div>`;

  // 审批卡
  if (state.pendingApprovals.length > 0) {
    html += `<div class="approval-cards">`;
    for (const app of state.pendingApprovals) {
      const resolved = app.status !== "pending";
      html += `<div class="approval-card ${resolved ? "approval-card--resolved" : ""}" data-tool-use-id="${esc(app.toolUseId)}">`;
      html += `<div class="approval-card-header">`;
      html += `<span class="approval-tool-name">🔔 ${esc(app.name)}</span>`;
      if (resolved) {
        html += `<span class="approval-result ${app.status === "allowed" ? "approval-result--allow" : "approval-result--deny"}">${app.status === "allowed" ? "已允许" : "已拒绝"}</span>`;
      }
      html += `</div>`;
      html += `<pre class="approval-input">${esc(formatInput(app.input))}</pre>`;
      if (!resolved) {
        html += `<div class="approval-actions">`;
        html += `<button class="btn btn--allow" data-action="allow" data-tool-use-id="${esc(app.toolUseId)}">允许</button>`;
        html += `<button class="btn btn--deny" data-action="deny" data-tool-use-id="${esc(app.toolUseId)}">拒绝</button>`;
        html += `<input class="deny-reason" data-tool-use-id="${esc(app.toolUseId)}" placeholder="拒绝理由（可选）" />`;
        html += `</div>`;
      } else if (app.reason) {
        html += `<div class="approval-reason">理由：${esc(app.reason)}</div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }

  // 时间线
  html += `<div class="timeline-container">`;
  html += renderTimeline(state.timeline, "主时间线");
  if (state.verifierTimeline.length > 0) {
    html += renderTimeline(state.verifierTimeline, "核查过程", true);
  }
  html += `</div>`;

  // 裁决卡
  if (state.verdict) {
    html += renderVerdictCard(state.verdict);
  }

  // 用量脚注
  if (state.usage) {
    html += `<div class="usage-footer">`;
    html += `🔄 ${state.usage.turns} 轮 · `;
    html += `📥 ${formatTokens(state.usage.inputTokens)} · `;
    html += `📤 ${formatTokens(state.usage.outputTokens)} · `;
    html += `💾 缓存命中 ${(state.usage.cacheHitRatio * 100).toFixed(0)}%`;
    html += `</div>`;
  }

  // 错误醒目标记
  if (state.error) {
    html += `<div class="error-banner">⚠️ ${esc(state.error)}</div>`;
  }

  mainEl.innerHTML = html;

  // 绑定审批按钮
  mainEl.querySelectorAll("[data-action='allow']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-tool-use-id");
      if (id) callbacks.onAllow(id);
    });
  });
  mainEl.querySelectorAll("[data-action='deny']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-tool-use-id");
      const reasonInput = mainEl.querySelector(`.deny-reason[data-tool-use-id="${id}"]`);
      const reason = reasonInput ? reasonInput.value.trim() : "";
      if (id) callbacks.onDenyReason(id, reason);
    });
  });
}

/** @returns {string} */
function renderTimeline(entries, title, isVerifier) {
  if (entries.length === 0) return "";
  const cls = isVerifier ? "timeline--verifier" : "";
  let html = `<div class="timeline ${cls}">`;
  html += `<div class="timeline-title">${esc(title)}</div>`;
  for (const e of entries) {
    html += renderTimelineEntry(e);
  }
  html += `</div>`;
  return html;
}

/** @returns {string} */
function renderTimelineEntry(e) {
  switch (e.type) {
    case "turn_start":
      return `<div class="tl-item tl-turn">── 第 ${e.turn ?? "?"} 轮 ──</div>`;
    case "tool_call":
      return `<div class="tl-item tl-tool-call">
        <span class="tl-tool-name">🔧 ${esc(e.name ?? "")}</span>
        <pre class="tl-tool-input">${esc(truncate(formatInput(e.input), 200))}</pre>
      </div>`;
    case "tool_result":
      return `<div class="tl-item tl-tool-result ${e.resultIsError ? "tl-tool-result--error" : ""}">
        <span class="tl-tool-status">${e.resultIsError ? "❌" : "✅"} ${esc(e.name ?? e.toolUseId ?? "")}</span>
        <span class="tl-duration">${e.durationMs != null ? `${e.durationMs}ms` : ""}</span>
        <pre class="tl-tool-output">${esc(truncate(e.resultContent ?? "", 150))}</pre>
      </div>`;
    case "assistant_text":
      return `<div class="tl-item tl-assistant-text">${esc(e.text ?? "")}</div>`;
    case "approval_request":
      return `<div class="tl-item tl-approval">⏳ 审批请求：${esc(e.name ?? "")} — ${esc(truncate(formatInput(e.input), 100))}</div>`;
    case "api_retry":
      return `<div class="tl-item tl-warning">🔄 API 重试（第${e.attempt}次）：${esc(e.reason ?? "")}</div>`;
    case "compaction":
      return `<div class="tl-item tl-warning">📦 上下文压缩：丢弃 ${e.droppedBlocks ?? "?"} 个块</div>`;
    default:
      return `<div class="tl-item">${esc(e.type)}</div>`;
  }
}

/** @returns {string} */
function renderVerdictCard(v) {
  const badge = v.passed
    ? '<span class="verdict-badge verdict-badge--pass">✅ 核查通过</span>'
    : '<span class="verdict-badge verdict-badge--fail">❌ 核查未通过</span>';
  let html = `<div class="verdict-card">`;
  html += `<div class="verdict-header">${badge}<span class="verdict-summary">${esc(v.summary)}</span></div>`;

  if (v.issues.length > 0) {
    html += `<div class="verdict-section verdict-section--issues">`;
    html += `<div class="verdict-section-title">🔴 客观项不符</div>`;
    html += `<ul>${v.issues.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`;
    html += `</div>`;
  }
  if (v.unverified.length > 0) {
    html += `<div class="verdict-section verdict-section--unverified">`;
    html += `<div class="verdict-section-title">🟡 待委托方复核</div>`;
    html += `<ul>${v.unverified.map((s) => `<li>⋯ ${esc(s)}</li>`).join("")}</ul>`;
    html += `</div>`;
  }
  if (v.advisory.length > 0) {
    html += `<div class="verdict-section verdict-section--advisory">`;
    html += `<div class="verdict-section-title">🟣 评审意见</div>`;
    html += `<ul>${v.advisory.map((s) => `<li>◈ ${esc(s)}</li>`).join("")}</ul>`;
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

/**
 * 渲染空态提示。
 */
export function renderEmptyState() {
  const mainEl = document.getElementById("main-area");
  if (mainEl) {
    mainEl.innerHTML = `<div class="empty-state">
      <div class="empty-icon">📋</div>
      <p>尚无运行。提交一个任务开始。</p>
    </div>`;
  }
}

// ---------------------------------------------------------------
// 格式化工具
// ---------------------------------------------------------------

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

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
 * @typedef {TimelineEntry & {collapsed: boolean}} LogEntry
 *
 * @typedef {{
 *   toolUseId: string,
 *   name: string,
 *   input: unknown,
 *   status: "pending"|"allowed"|"denied"|"expired",
 *   reason?: string,
 *   decidedAt?: number
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

  // R-01: run 完成后所有仍 pending 的审批卡转为 expired
  const expiredApprovals = state.pendingApprovals.map((a) =>
    a.status === "pending" ? { ...a, status: /** @type {"expired"} */ ("expired") } : a,
  );

  return {
    ...state,
    status: "done",
    error: stopReason === "error" ? "运行异常终止" : null,
    pendingApprovals: expiredApprovals,
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
  const unverifiedItems = state.verdict ? state.verdict.unverified : [];

  return {
    finalStatus: state.error ? "error" : state.status,
    resultSummary: lastAssistant ? lastAssistant.text ?? null : null,
    verdict: state.verdict,
    actionItems: {
      pendingApprovals,
      unverifiedItems,
    },
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
export function markApprovalResolved(state, toolUseId, decision, reason) {
  return {
    ...state,
    pendingApprovals: state.pendingApprovals.map((a) =>
      a.toolUseId === toolUseId
        ? { ...a, status: decision, reason, decidedAt: Date.now() }
        : a,
    ),
  };
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
    listEl.innerHTML = '<div class="run-list-empty">尚无运行。</div>';
    return;
  }
  listEl.innerHTML = runs
    .map(
      (r) => {
        const meta = metaMap ? metaMap.get(r.runId) : null;
        const isSelected = r.runId === selectedRunId;
        // R-08: 时间与耗时
        const timeStr = meta ? formatTimeShort(meta.startTime) : "";
        const durationStr = meta && meta.duration != null ? formatDuration(meta.duration) : "";
        // R-08: 核查结论
        let verdictLabel = "";
        if (meta && meta.verdictConclusion === "passed") verdictLabel = '<span class="run-item-verdict run-item-verdict--pass">✓</span>';
        else if (meta && meta.verdictConclusion === "failed") verdictLabel = '<span class="run-item-verdict run-item-verdict--fail">✗</span>';
        else if (meta && meta.verdictConclusion === "pending") verdictLabel = '<span class="run-item-verdict run-item-verdict--pending">⋯</span>';

        return `
    <div class="run-item ${isSelected ? "run-item--selected" : ""}"
         data-run-id="${esc(r.runId)}"
         role="option"
         tabindex="0"
         aria-selected="${isSelected}">
      <div class="run-item-status">
        <span class="status-dot ${r.status === "running" ? "status-dot--live" : ""}"></span>
        ${r.verify ? '<span class="verify-badge">核查</span>' : ""}
        ${verdictLabel}
        <span class="run-item-state-label">${r.status === "running" ? "运行中" : "已完成"}</span>
      </div>
      <div class="run-item-task">${esc(r.task)}</div>
      <div class="run-item-meta">
        ${timeStr ? `<span class="run-item-time">${esc(timeStr)}</span>` : ""}
        ${durationStr ? `<span class="run-item-duration">${esc(durationStr)}</span>` : ""}
      </div>
    </div>`;
      },
    )
    .join("");

  // 绑定点击 + 键盘事件
  listEl.querySelectorAll(".run-item").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-run-id");
      if (id) onSelect(id);
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const id = el.getAttribute("data-run-id");
        if (id) onSelect(id);
      }
    });
  });
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

  const activeTab = callbacks.activeTab || "overview";
  const logEntries = callbacks.logEntries || deriveLogEntries(state);
  const overview = deriveOverview(state);

  const isRunning = state.status === "running";
  const statusClass = isRunning ? "status--live" : state.error ? "status--error" : "status--done";
  const statusText = isRunning ? "运行中" : state.error ? "异常终止" : "已完成";

  let html = "";

  // 窄屏返回按钮
  if (callbacks.showBack && callbacks.onBack) {
    html += `<div class="back-bar"><button class="btn back-btn" id="back-to-list-btn">← 返回列表</button></div>`;
  }

  // 详情页头
  html += `<div class="detail-header">`;
  html += `<h2 class="detail-task">${esc(state.task)}</h2>`;
  html += `<div class="detail-meta">`;
  html += `<span class="status-badge ${statusClass}">${statusText}</span>`;
  if (state.verify) html += `<span class="verify-badge">核查模式</span>`;
  html += `</div></div>`;

  // ---- 审批卡（R-01：仅 pending + run 运行中才渲染操作按钮） ----
  if (state.pendingApprovals.length > 0) {
    html += renderApprovalCards(state, isRunning);
  }

  // ---- 标签页导航 (R-03) ----
  html += `<div class="tab-nav" role="tablist" aria-label="详情视图切换">`;
  html += renderTabButton("overview", "概览", activeTab);
  html += renderTabButton("log", "运行日志", activeTab);
  if (state.verifierTimeline.length > 0 || state.verdict) {
    html += renderTabButton("verify", "核查", activeTab);
  }
  html += `</div>`;

  // ---- 标签内容 ----
  html += `<div class="tab-content" id="tab-content">`;

  if (activeTab === "overview") {
    html += renderOverviewTab(overview, state);
  } else if (activeTab === "log") {
    html += renderLogTab(logEntries);
  } else if (activeTab === "verify") {
    html += renderVerifyTab(state);
  }

  html += `</div>`;

  // 用量脚注（始终显示）
  if (state.usage) {
    html += `<div class="usage-footer">`;
    html += `🔄 ${state.usage.turns} 轮 · `;
    html += `📥 ${formatTokens(state.usage.inputTokens)} · `;
    html += `📤 ${formatTokens(state.usage.outputTokens)} · `;
    html += `💾 缓存命中 ${(state.usage.cacheHitRatio * 100).toFixed(0)}%`;
    html += `</div>`;
  }

  mainEl.innerHTML = html;

  // 绑定窄屏返回按钮
  if (callbacks.showBack && callbacks.onBack) {
    const backBtn = document.getElementById("back-to-list-btn");
    if (backBtn) {
      backBtn.addEventListener("click", callbacks.onBack);
    }
  }

  // 绑定审批按钮
  mainEl.querySelectorAll("[data-action='allow']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-tool-use-id");
      if (id && callbacks.onAllow) callbacks.onAllow(id);
    });
  });
  mainEl.querySelectorAll("[data-action='deny']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-tool-use-id");
      const reasonInput = mainEl.querySelector(`.deny-reason[data-tool-use-id="${id}"]`);
      const reason = reasonInput ? reasonInput.value.trim() : "";
      if (id && callbacks.onDenyReason) callbacks.onDenyReason(id, reason);
    });
  });

  // 绑定标签切换
  mainEl.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-tab");
      if (tab) {
        // 委托控制器重渲染
        document.dispatchEvent(new CustomEvent("tab-switch", { detail: { tab } }));
      }
    });
  });

  // 绑定日志条目展开/折叠
  mainEl.querySelectorAll(".log-entry-header").forEach((header) => {
    header.addEventListener("click", () => {
      const seqStr = header.getAttribute("data-seq");
      if (seqStr !== null && callbacks.onToggleEntry) {
        callbacks.onToggleEntry(Number(seqStr));
      }
    });
  });
}

/** @returns {string} */
function renderTabButton(tab, label, activeTab) {
  const isActive = tab === activeTab;
  return `<button class="tab-btn ${isActive ? "tab-btn--active" : ""}"
    role="tab"
    aria-selected="${isActive}"
    data-tab="${tab}">${label}</button>`;
}

/** @returns {string} */
function renderApprovalCards(state, isRunning) {
  let html = `<div class="approval-cards">`;
  for (const app of state.pendingApprovals) {
    const isPending = app.status === "pending";
    const operable = isPending && isRunning;
    const resolved = !isPending;

    html += `<div class="approval-card ${resolved ? "approval-card--resolved" : ""}" data-tool-use-id="${esc(app.toolUseId)}">`;
    html += `<div class="approval-card-header">`;
    html += `<span class="approval-tool-name">🔔 ${esc(app.name)}</span>`;

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
      html += `<button class="btn btn--allow" data-action="allow" data-tool-use-id="${esc(app.toolUseId)}">允许本次</button>`;
      html += `<button class="btn btn--deny" data-action="deny" data-tool-use-id="${esc(app.toolUseId)}">拒绝并说明</button>`;
      html += `<input class="deny-reason" data-tool-use-id="${esc(app.toolUseId)}" placeholder="拒绝理由（可选）" />`;
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

  // 最终状态徽章（醒目）
  const isError = overview.finalStatus === "error";
  const isRunning = overview.finalStatus === "running";
  const statusLabel = isError ? "异常终止" : isRunning ? "运行中" : "已完成";
  const statusCls = isError ? "status--error" : isRunning ? "status--live" : "status--done";
  html += `<div class="overview-status">`;
  html += `<span class="status-badge status-badge--lg ${statusCls}">${statusLabel}</span>`;
  html += `</div>`;

  // 结果摘要
  if (overview.resultSummary) {
    html += `<div class="overview-section">`;
    html += `<h3 class="overview-section-title">📝 结果摘要</h3>`;
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
    html += `<h3 class="overview-section-title">⚠️ 需介入事项</h3>`;
    html += `<ul class="action-items">`;
    for (const a of overview.actionItems.pendingApprovals) {
      html += `<li class="action-item action-item--approval">⏳ 待审批：${esc(a.name)} — ${esc(truncate(formatInput(a.input), 80))}</li>`;
    }
    for (const u of overview.actionItems.unverifiedItems) {
      html += `<li class="action-item action-item--unverified">⋯ 待复核：${esc(u)}</li>`;
    }
    html += `</ul>`;
    html += `</div>`;
  }

  // 错误醒目
  if (state.error) {
    html += `<div class="error-banner">⚠️ ${esc(state.error)}</div>`;
  }

  // 无结果时显示提示
  if (!overview.resultSummary && !overview.verdict && !hasActionItems && !state.error) {
    html += `<div class="overview-placeholder">运行中，暂无结果摘要…</div>`;
  }

  return html;
}

/** @returns {string} */
function renderLogTab(logEntries) {
  if (logEntries.length === 0) {
    return `<div class="log-empty">暂无日志记录。</div>`;
  }

  let html = `<h3 class="overview-section-title">Agent 执行</h3>
<div class="log-entries">`;
  for (const e of logEntries) {
    html += renderLogEntry(e);
  }
  html += `</div>`;
  return html;
}

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
  const duration = e.durationMs != null ? `${e.durationMs}ms` : "";
  const expandIcon = collapsed ? "▸" : "▾";

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
  switch (type) {
    case "turn_start": return "──";
    case "tool_call": return "🔧";
    case "tool_result": return isError ? "❌" : "✅";
    case "assistant_text": return "💬";
    case "approval_request": return "⏳";
    case "api_retry": return "🔄";
    case "compaction": return "📦";
    default: return "•";
  }
}

/** @returns {string} */
function entryActionLabel(e) {
  switch (e.type) {
    case "turn_start": return `第 ${e.turn ?? "?"} 轮`;
    case "tool_call": return `${esc(e.name ?? "")}`;
    case "tool_result": return `${esc(e.name ?? e.toolUseId ?? "")} ${e.resultIsError ? "失败" : "成功"}`;
    case "assistant_text": return `助手消息`;
    case "approval_request": return `审批请求：${esc(e.name ?? "")}`;
    case "api_retry": return `API 重试（第${e.attempt ?? "?"}次）`;
    case "compaction": return `上下文压缩`;
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
function renderVerifyTab(state) {
  let html = "";

  // 核查结论（如果存在）
  if (state.verdict) {
    html += renderVerdictCard(state.verdict);
  }

  // 核查时间线（使用日志卡片风格）
  if (state.verifierTimeline.length > 0) {
    html += `<div class="verify-timeline">`;
    html += `<h3 class="overview-section-title">📋 核查 Agent 过程</h3>`;
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
 * @param {boolean} [hasRuns] - 列表是否已有运行记录
 */
export function renderEmptyState(hasRuns) {
  const mainEl = document.getElementById("main-area");
  if (mainEl) {
    const msg = hasRuns
      ? "选择左侧运行查看详情，或创建新任务。"
      : "尚无运行。";
    mainEl.innerHTML = `<div class="empty-state">
      <div class="empty-icon">📋</div>
      <p>${msg}</p>
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

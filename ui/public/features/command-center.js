/**
 * features/command-center — 运行指挥中心（T11）。
 *
 * 零依赖原生 ESM。独立视图（hash 路由 #/board），按状态分组的三栏卡片墙：
 *   「待你决定」：所有会话的审批待决 / 提问待答 / 计划门——数据**与通知中心
 *     同源**（host.getDecisionItems 直接读 notifications.js 的 store，本模块
 *     不维护第二份待决账本）；
 *   「运行中」：所有 running 状态的 run，卡片带当前轮数 / 已耗时 / 最近一步
 *     工具调用摘要（从 run 的 RunState 时间线派生）与「停止」按钮；
 *   「最近完成」：最近 24h 内收尾的 run，按 完成 / 未通过 / 被停止 分档徽章
 *     （分档复用 notifications.js 的 classifyRunEndForNotify，两处口径不漂）。
 *
 * 与 settings / notifications 同一约定：
 *   1) 纯函数层（路由判定 / 时长格式化 / 工具摘要 / 三栏归约）——可单测；
 *   2) DOM 层 initCommandCenterView(host, env)——宿主（index.html 内联控制器）
 *      注入回调，本模块不反向 import 宿主任何东西，也不新建 EventSource：
 *      实时性由宿主在既有 SSE 批处理节拍里调 refresh() 获得。
 */

import { formatRelTime, classifyRunEndForNotify, collapseDecisionItems } from "./notifications.js";

// ---------------------------------------------------------------
// 常量
// ---------------------------------------------------------------

/** 路由：指挥中心视图占用的唯一 hash */
export const COMMAND_CENTER_HASH = "#/board";
/** 「最近完成」栏的回看窗（24 小时） */
export const RECENT_WINDOW_MS = 86_400_000;
/** 「最近完成」栏的卡片上限（超出裁最旧的） */
export const FINISHED_LIMIT = 30;
/** 视图打开时等待/耗时数字的刷新节拍（毫秒） */
export const DEFAULT_TICK_MS = 10_000;

/** 待决定类型的徽章文案与图标。kind 口径与 notifications.js 一致。 */
export const DECISION_KIND_META = {
  approval: { label: "审批待决", icon: "ph-shield-check" },
  question: { label: "提问待答", icon: "ph-chat-centered-dots" },
  plan_gate: { label: "计划待签发", icon: "ph-tree-structure" },
};

// ---------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------

/**
 * 路由判定：指挥中心视图的唯一 hash。宿主路由与本模块共用这一条。
 * @param {string} hash location.hash
 * @returns {boolean}
 */
export function isCommandCenterRoute(hash) {
  return String(hash ?? "") === COMMAND_CENTER_HASH;
}

/**
 * 时长格式化（已等待 / 已耗时）：不到 1 分钟 / N 分钟 / N 小时 N 分钟 / N 天 N 小时。
 * 与 formatRelTime（相对时刻）互补：这里回答"等了多久"，不是"什么时候"。
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function formatElapsed(ms) {
  const v = Number.isFinite(Number(ms)) ? Math.max(0, Number(ms)) : 0;
  const minutes = Math.floor(v / 60_000);
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const restMin = minutes % 60;
    return restMin > 0 ? `${hours} 小时 ${restMin} 分钟` : `${hours} 小时`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

/** 同一天（本地时区）判定：统计条「今日完成」用。 @param {number} a @param {number} b */
export function sameLocalDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/**
 * 工具入参摘要：取最有辨识度的字段（command / path / file_path / query / url /
 * pattern / 第一个字符串值），截到 48 字符。拿不到就给空串——卡片只显示工具名。
 * @param {unknown} input tool_call 事件的 input
 * @param {number} [max]
 * @returns {string}
 */
export function summarizeToolInput(input, max = 48) {
  /** @param {string} s */
  const cut = (s) => {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
  };
  if (typeof input === "string") return cut(input);
  if (!input || typeof input !== "object") return "";
  const obj = /** @type {Record<string, unknown>} */ (input);
  for (const key of ["command", "path", "file_path", "query", "url", "pattern"]) {
    if (typeof obj[key] === "string" && obj[key]) return cut(/** @type {string} */ (obj[key]));
  }
  for (const value of Object.values(obj)) {
    if (typeof value === "string" && value) return cut(value);
  }
  return "";
}

/**
 * 从 RunState 派生运行进度语境：当前轮数（时间线上最后一次 turn_start）与
 * 最近一步工具调用（最后一次 tool_call）。state 缺失（没订阅过的 run）时
 * 两者都是 null，卡片降级为只显示标题与耗时。
 * @param {{ timeline?: { type:string, turn?:number, name?:string, input?:unknown }[] }|null|undefined} state
 * @returns {{ turn:number|null, lastTool:{ name:string, summary:string }|null }}
 */
export function deriveRunProgress(state) {
  if (!state) return { turn: null, lastTool: null };
  const timeline = Array.isArray(state.timeline) ? state.timeline : [];
  /** @type {number|null} */
  let turn = null;
  /** @type {{ name:string, summary:string }|null} */
  let lastTool = null;
  for (const entry of timeline) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "turn_start" && typeof entry.turn === "number") turn = entry.turn;
    if (entry.type === "tool_call") {
      lastTool = { name: String(entry.name ?? "工具"), summary: summarizeToolInput(entry.input) };
    }
  }
  return { turn, lastTool };
}

/**
 * @typedef {{ id:string, runId:string, title:string, kind:string, kindLabel:string,
 *   detail:string|null, at:number, waitingMs:number }} DecisionCard
 * @typedef {{ runId:string, title:string, turn:number|null, elapsedMs:number|null,
 *   lastTool:{ name:string, summary:string }|null }} RunningCard
 * @typedef {{ runId:string, title:string, tier:string, tone:string,
 *   finishedAt:number, durationMs:number|null }} FinishedCard
 * @typedef {{ running:number, deciding:number, doneToday:number }} BoardStats
 * @typedef {{ stats:BoardStats,
 *   columns:{ decision:DecisionCard[], running:RunningCard[], finished:FinishedCard[] },
 *   empty:boolean }} BoardModel
 */

/**
 * 三栏归约（本模块的核心纯函数）：
 *   输入 run 列表 + RunState 访问器 + 通知中心的待决条目，输出三栏卡片模型与统计条。
 *
 * 排序纪律：
 *   待你决定 —— 等待最久的排最前（最该被看见的排最前）；
 *   运行中   —— 跑得最久的排最前；
 *   最近完成 —— 刚完成的排最前，超 FINISHED_LIMIT 裁最旧的。
 *
 * @param {{
 *   runs: { runId:string, task?:string, status:string, createdAt?:number,
 *           finishedAt?:number|null, stopReason?:string|null }[],
 *   getState?: (runId:string) => any,
 *   decisionItems?: { id:string, runId:string, runTitle?:string, kind:string,
 *                     category:string, label?:string, detail?:string|null, at:number }[],
 *   now:number,
 * }} input
 * @returns {BoardModel}
 */
export function deriveBoardModel(input) {
  const { runs = [], decisionItems = [], now } = input;
  const nowMs = Number(now) || 0;
  const getState = typeof input.getState === "function" ? input.getState : () => null;

  const freshTitle = (runId, fallback) =>
    runs.find((r) => r && r.runId === runId)?.task ?? fallback ?? "";

  // ---- 栏一：待你决定（与通知中心同源的待决条目）----
  /** @type {DecisionCard[]} */
  const decision = [];
  for (const item of collapseDecisionItems(decisionItems)) {
    if (!item || item.category !== "decision") continue;
    const at = Number(item.at) || nowMs;
    decision.push({
      id: String(item.id),
      runId: String(item.runId),
      title: String(freshTitle(item.runId, item.runTitle) ?? ""),
      kind: String(item.kind),
      kindLabel: DECISION_KIND_META[item.kind]?.label ?? item.label ?? "待决定",
      detail: item.detail ?? null,
      at,
      waitingMs: Math.max(0, nowMs - at),
    });
  }
  decision.sort((a, b) => b.waitingMs - a.waitingMs);

  // ---- 栏二/栏三：run 列表状态 ----
  /** @type {RunningCard[]} */
  const running = [];
  /** @type {FinishedCard[]} */
  const finished = [];
  let doneToday = 0;

  for (const run of runs) {
    if (!run || !run.runId) continue;
    const title = String(run.task ?? "");
    const createdAt = Number.isFinite(Number(run.createdAt)) ? Number(run.createdAt) : null;
    if (run.status === "running") {
      const progress = deriveRunProgress(getState(run.runId));
      running.push({
        runId: run.runId,
        title,
        turn: progress.turn,
        elapsedMs: createdAt !== null ? Math.max(0, nowMs - createdAt) : null,
        lastTool: progress.lastTool,
      });
    } else if (run.status === "done") {
      const finishedAt = Number.isFinite(Number(run.finishedAt)) ? Number(run.finishedAt) : null;
      if (finishedAt === null) continue;
      if (sameLocalDay(finishedAt, nowMs)) doneToday++;
      if (nowMs - finishedAt > RECENT_WINDOW_MS) continue;
      const cls = classifyRunEndForNotify(run.stopReason ?? null);
      finished.push({
        runId: run.runId,
        title,
        tier: cls.tier,
        tone: cls.tone,
        finishedAt,
        durationMs: createdAt !== null && finishedAt >= createdAt ? finishedAt - createdAt : null,
      });
    }
  }
  running.sort((a, b) => (b.elapsedMs ?? -1) - (a.elapsedMs ?? -1));
  finished.sort((a, b) => b.finishedAt - a.finishedAt);
  const trimmedFinished = finished.slice(0, FINISHED_LIMIT);

  return {
    stats: { running: running.length, deciding: decision.length, doneToday },
    columns: { decision, running, finished: trimmedFinished },
    autoApprovedWrites: summarizeAutoApprovedWrites(runs, getState),
    empty: decision.length === 0 && running.length === 0 && trimmedFinished.length === 0,
  };
}

/**
 * 自动放行时待决定栏是空的。留下「已自动放行：写了 x」的痕迹。
 * @param {{ runId:string }[]} runs
 * @param {(runId:string) => any} getState
 * @returns {string[]}
 */
export function summarizeAutoApprovedWrites(runs, getState) {
  const names = [];
  const seen = new Set();
  for (const run of runs ?? []) {
    const st = typeof getState === "function" ? getState(run.runId) : null;
    for (const a of st?.pendingApprovals ?? []) {
      if (a.actor !== "auto-rule" || a.status !== "allowed") continue;
      const path = a.input && typeof a.input === "object"
        ? String(a.input.path ?? a.input.file_path ?? "").trim()
        : "";
      if (!path) continue;
      const base = path.split(/[\\/]/).filter(Boolean).pop() || path;
      if (seen.has(base)) continue;
      seen.add(base);
      names.push(base);
    }
  }
  return names;
}

// ---------------------------------------------------------------
// DOM 层
// ---------------------------------------------------------------

const VIEW_ID = "command-center-view";

const FINISHED_TONE_BADGE = { ok: "cc-badge--ok", warn: "cc-badge--warn", bad: "cc-badge--bad" };

/**
 * 初始化指挥中心视图。幂等：重复调用返回既有节点的薄壳。
 *
 * host 回调：
 *   getRuns()                 → RunListEntry[]（run 列表状态，与通知中心同源）
 *   getRunState(runId)        → RunState|null（轮数与最近工具调用的出处）
 *   getDecisionItems()        → NotificationItem[]（notifications.js store 的 items，
 *                               本模块只读，不维护第二份待决账本）
 *   isStopping(runId)         → boolean（人已按停止、run 未落 done：按钮置灰）
 *   onOpenBoard()             → 侧栏入口点击（宿主写 hash 路由）
 *   onCloseBoard()            → 返回上一视图（宿主决定 history.back 或回 "#/"）
 *   onOpenConversation(runId) → 跳转会话
 *   onRevealDock(runId)       → 待决定卡点击后直达 action-dock（可选，缺省退化为跳会话）
 *   onStopRun(runId)          → 走宿主既有 stop API
 *   onNewChat()               → 空态「新建任务」入口
 *   onAnnounce(msg)           → aria-live 播报（可选）
 *
 * env（测试注入）：doc / win / now / tickMs
 *
 * @param {Record<string, Function>} host
 * @param {{ doc?:Document, win?:Window, now?:() => number, tickMs?:number }} [env]
 */
export function initCommandCenterView(host = {}, env = {}) {
  const doc = env.doc ?? document;
  const win = env.win ?? (doc.defaultView ?? window);
  const now = env.now ?? (() => Date.now());
  const tickMs = Number(env.tickMs) > 0 ? Number(env.tickMs) : DEFAULT_TICK_MS;

  const existing = doc.getElementById(VIEW_ID);
  if (existing) {
    return {
      open: () => { existing.hidden = false; },
      close: () => { existing.hidden = true; },
      isOpen: () => !existing.hidden,
      element: existing,
      refresh: () => {},
    };
  }

  // ---- 状态 ----
  let open = false;
  /** @type {HTMLElement|null} */
  let restoreFocusTo = null;
  /** @type {number|null} 等待/耗时数字的刷新节拍器（仅打开时转） */
  let timer = null;

  // ---- 骨架 ----
  const view = doc.createElement("div");
  view.id = VIEW_ID;
  view.className = "cc-view";
  view.hidden = true;

  const shell = doc.createElement("div");
  shell.className = "cc-shell";

  const head = doc.createElement("header");
  head.className = "cc-head";
  const backBtn = doc.createElement("button");
  backBtn.type = "button";
  backBtn.className = "btn btn--ghost cc-back";
  backBtn.innerHTML = '<i class="ph ph-arrow-left" aria-hidden="true"></i><span>返回</span>';
  backBtn.setAttribute("aria-label", "返回上一视图");
  const title = doc.createElement("h2");
  title.className = "cc-title";
  title.textContent = "指挥中心";
  head.appendChild(backBtn);
  head.appendChild(title);

  // 统计条：运行中 N · 待决定 M · 今日完成 K
  const stats = doc.createElement("div");
  stats.className = "cc-stats";
  stats.setAttribute("role", "status");
  /** @type {Record<string, HTMLElement>} */
  const statNums = {};
  /** @type {Record<string, HTMLElement>} */
  const statChips = {};
  for (const [key, label] of [
    ["running", "运行中"],
    ["deciding", "待决定"],
    ["doneToday", "今日完成"],
  ]) {
    const chip = doc.createElement("div");
    chip.className = "cc-stat";
    chip.setAttribute("data-stat", key);
    const num = doc.createElement("span");
    num.className = "cc-stat-num";
    num.textContent = "0";
    const text = doc.createElement("span");
    text.className = "cc-stat-label";
    text.textContent = label;
    chip.appendChild(num);
    chip.appendChild(text);
    stats.appendChild(chip);
    statNums[key] = num;
    statChips[key] = chip;
  }

  // 三栏
  const board = doc.createElement("div");
  board.className = "cc-board";
  /** @type {Record<string, { section:HTMLElement, body:HTMLElement, count:HTMLElement, empty:HTMLElement }>} */
  const colRefs = {};
  for (const [key, label, emptyText] of [
    ["decision", "待你决定", "没有等你决定的事"],
    ["running", "运行中", "没有正在运行的任务"],
    ["finished", "最近完成", "最近 24 小时还没有完成的任务"],
  ]) {
    const section = doc.createElement("section");
    section.className = "cc-column";
    section.setAttribute("data-col", key);
    const colHead = doc.createElement("div");
    colHead.className = "cc-column-head";
    const h = doc.createElement("h3");
    h.className = "cc-column-title";
    h.textContent = label;
    const count = doc.createElement("span");
    count.className = "cc-column-count";
    count.textContent = "0";
    colHead.appendChild(h);
    colHead.appendChild(count);
    const body = doc.createElement("div");
    body.className = "cc-column-body";
    const emptyHint = doc.createElement("p");
    emptyHint.className = "cc-column-empty";
    emptyHint.textContent = emptyText;
    section.appendChild(colHead);
    section.appendChild(body);
    section.appendChild(emptyHint);
    board.appendChild(section);
    colRefs[key] = { section, body, count, empty: emptyHint };
  }

  // 空态：三栏全空
  const emptyState = doc.createElement("div");
  emptyState.className = "cc-empty";
  const emptyIcon = doc.createElement("div");
  emptyIcon.className = "cc-empty-icon";
  emptyIcon.setAttribute("aria-hidden", "true");
  emptyIcon.innerHTML = '<i class="ph ph-squares-four"></i>';
  const emptyText = doc.createElement("p");
  emptyText.className = "cc-empty-text";
  emptyText.textContent = "一切尽在掌握——没有运行中的任务";
  const emptyAction = doc.createElement("button");
  emptyAction.type = "button";
  emptyAction.className = "btn btn--primary cc-empty-action";
  emptyAction.innerHTML = '<i class="ph ph-plus" aria-hidden="true"></i><span>新建任务</span>';
  emptyState.appendChild(emptyIcon);
  emptyState.appendChild(emptyText);
  emptyState.appendChild(emptyAction);

  shell.appendChild(head);
  shell.appendChild(stats);
  shell.appendChild(board);
  shell.appendChild(emptyState);
  view.appendChild(shell);
  // 与 settings-view 同一纪律：盖住主列内容与 composer，侧栏保持可用
  (doc.getElementById("main-panel") ?? doc.body).appendChild(view);

  // ---- 渲染 ----
  function currentModel() {
    return deriveBoardModel({
      runs: host.getRuns?.() ?? [],
      getState: (runId) => host.getRunState?.(runId) ?? null,
      decisionItems: host.getDecisionItems?.() ?? [],
      now: now(),
    });
  }

  /** @param {string} text @param {string} [className] */
  function metaLine(text, className = "cc-card-meta") {
    const el = doc.createElement("span");
    el.className = className;
    el.textContent = text;
    return el;
  }

  /** @param {DecisionCard} card */
  function buildDecisionCard(card) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "cc-card cc-card--decision";
    btn.setAttribute("data-run-id", card.runId);
    btn.setAttribute("data-kind", card.kind);

    const top = doc.createElement("span");
    top.className = "cc-card-top";
    const icon = doc.createElement("i");
    icon.className = `ph ${DECISION_KIND_META[card.kind]?.icon ?? "ph-bell"}`;
    icon.setAttribute("aria-hidden", "true");
    const name = doc.createElement("span");
    name.className = "cc-card-title";
    name.textContent = card.title || "（会话已删除）";
    const badge = doc.createElement("span");
    badge.className = "cc-badge cc-badge--warn";
    badge.textContent = card.kindLabel;
    top.appendChild(icon);
    top.appendChild(name);
    top.appendChild(badge);
    btn.appendChild(top);

    btn.appendChild(metaLine(`已等待 ${formatElapsed(card.waitingMs)}`));
    if (card.detail) btn.appendChild(metaLine(card.detail, "cc-card-detail"));

    btn.addEventListener("click", () => {
      if (typeof host.onRevealDock === "function") host.onRevealDock(card.runId);
      else host.onOpenConversation?.(card.runId);
      host.onAnnounce?.(`已打开待决定项：${card.title || card.runId}`);
    });
    return btn;
  }

  /** @param {RunningCard} card */
  function buildRunningCard(card) {
    const item = doc.createElement("div");
    item.className = "cc-card cc-card--running";
    item.setAttribute("data-run-id", card.runId);

    const openBtn = doc.createElement("button");
    openBtn.type = "button";
    openBtn.className = "cc-card-open";

    const top = doc.createElement("span");
    top.className = "cc-card-top";
    const icon = doc.createElement("i");
    icon.className = "ph ph-circle-notch";
    icon.setAttribute("aria-hidden", "true");
    const name = doc.createElement("span");
    name.className = "cc-card-title";
    name.textContent = card.title || card.runId;
    const badge = doc.createElement("span");
    badge.className = "cc-badge cc-badge--info";
    badge.textContent = "运行中";
    top.appendChild(icon);
    top.appendChild(name);
    top.appendChild(badge);
    openBtn.appendChild(top);

    const bits = [];
    bits.push(card.turn !== null ? `第 ${card.turn} 轮` : "轮数未知");
    bits.push(card.elapsedMs !== null ? `已耗时 ${formatElapsed(card.elapsedMs)}` : "耗时未知");
    openBtn.appendChild(metaLine(bits.join(" · ")));
    if (card.lastTool) {
      const tool = card.lastTool.summary
        ? `${card.lastTool.name} · ${card.lastTool.summary}`
        : card.lastTool.name;
      openBtn.appendChild(metaLine(`最近：${tool}`, "cc-card-detail"));
    }
    openBtn.addEventListener("click", () => {
      host.onOpenConversation?.(card.runId);
      host.onAnnounce?.(`已打开运行：${card.title || card.runId}`);
    });

    const actions = doc.createElement("div");
    actions.className = "cc-card-actions";
    const stopBtn = doc.createElement("button");
    stopBtn.type = "button";
    stopBtn.className = "btn btn--ghost cc-stop-btn";
    const stopping = Boolean(host.isStopping?.(card.runId));
    stopBtn.disabled = stopping;
    stopBtn.innerHTML = '<i class="ph ph-stop" aria-hidden="true"></i><span></span>';
    stopBtn.querySelector("span").textContent = stopping ? "停止中…" : "停止";
    stopBtn.setAttribute("aria-label", `停止运行：${card.title || card.runId}`);
    stopBtn.addEventListener("click", () => {
      host.onStopRun?.(card.runId);
      host.onAnnounce?.(`已请求停止：${card.title || card.runId}`);
    });
    actions.appendChild(stopBtn);

    item.appendChild(openBtn);
    item.appendChild(actions);
    return item;
  }

  /** @param {FinishedCard} card */
  function buildFinishedCard(card) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "cc-card cc-card--finished";
    btn.setAttribute("data-run-id", card.runId);

    const top = doc.createElement("span");
    top.className = "cc-card-top";
    const icon = doc.createElement("i");
    icon.className = "ph ph-flag-checkered";
    icon.setAttribute("aria-hidden", "true");
    const name = doc.createElement("span");
    name.className = "cc-card-title";
    name.textContent = card.title || card.runId;
    const badge = doc.createElement("span");
    badge.className = `cc-badge ${FINISHED_TONE_BADGE[card.tone] ?? "cc-badge--info"}`;
    badge.textContent = card.tier;
    top.appendChild(icon);
    top.appendChild(name);
    top.appendChild(badge);
    btn.appendChild(top);

    const bits = [formatRelTime(card.finishedAt, now())];
    if (card.durationMs !== null) bits.push(`耗时 ${formatElapsed(card.durationMs)}`);
    btn.appendChild(metaLine(bits.join(" · ")));

    btn.addEventListener("click", () => {
      host.onOpenConversation?.(card.runId);
      host.onAnnounce?.(`已打开会话：${card.title || card.runId}`);
    });
    return btn;
  }

  function render() {
    const model = currentModel();

    statNums.running.textContent = String(model.stats.running);
    statNums.deciding.textContent = String(model.stats.deciding);
    statNums.doneToday.textContent = String(model.stats.doneToday);
    statChips.deciding.classList.toggle("cc-stat--hot", model.stats.deciding > 0);
    stats.setAttribute(
      "aria-label",
      `运行中 ${model.stats.running}，待决定 ${model.stats.deciding}，今日完成 ${model.stats.doneToday}`,
    );

    /** @type {Record<string, (card:any) => HTMLElement>} */
    const builders = {
      decision: buildDecisionCard,
      running: buildRunningCard,
      finished: buildFinishedCard,
    };
    for (const key of ["decision", "running", "finished"]) {
      const ref = colRefs[key];
      const cards = model.columns[key];
      ref.body.innerHTML = "";
      for (const card of cards) ref.body.appendChild(builders[key](card));
      ref.count.textContent = String(cards.length);
      ref.count.hidden = cards.length === 0;
      if (key === "decision" && cards.length === 0) {
        const writes = model.autoApprovedWrites ?? [];
        ref.empty.textContent = writes.length
          ? `已自动放行：写了 ${writes.slice(0, 4).join("、")}`
          : "没有等你决定的事";
      }
      ref.empty.hidden = cards.length > 0;
    }

    board.hidden = model.empty;
    stats.hidden = model.empty;
    emptyState.hidden = !model.empty;
  }

  // ---- 开关 ----
  function startTicker() {
    if (timer !== null || typeof win.setInterval !== "function") return;
    timer = win.setInterval(() => { if (open) render(); }, tickMs);
  }

  function stopTicker() {
    if (timer === null) return;
    win.clearInterval?.(timer);
    timer = null;
  }

  function openView() {
    if (open) return;
    open = true;
    restoreFocusTo = /** @type {HTMLElement|null} */ (doc.activeElement);
    render();
    view.hidden = false;
    backBtn.focus();
    startTicker();
    host.onAnnounce?.("指挥中心已打开");
  }

  function closeView() {
    if (!open) return;
    open = false;
    stopTicker();
    view.hidden = true;
    if (restoreFocusTo && typeof restoreFocusTo.focus === "function" && doc.contains?.(restoreFocusTo) !== false) {
      restoreFocusTo.focus();
    }
    restoreFocusTo = null;
  }

  backBtn.addEventListener("click", () => host.onCloseBoard?.());
  emptyAction.addEventListener("click", () => {
    host.onAnnounce?.("开始新建任务");
    host.onNewChat?.();
  });

  // 侧栏入口（宿主在骨架里放了 #board-open-btn 才有）
  const openBtn = doc.getElementById("board-open-btn");
  if (openBtn) {
    openBtn.addEventListener("click", () => host.onOpenBoard?.());
  }

  return {
    open: openView,
    close: closeView,
    isOpen: () => open,
    element: view,
    /** 宿主在 SSE 批处理节拍 / run 列表刷新后调用；关闭时是 no-op（不白渲染） */
    refresh: () => { if (open) render(); },
  };
}

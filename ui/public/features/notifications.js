/**
 * features/notifications — 通知中心（T4）。
 *
 * 零依赖原生 ESM。两层：
 *   1) 应用内「待你处理」中心：侧栏铃铛 + 角标 + 浮层面板，聚合所有会话的
 *      待决定项（审批 / 提问 / 计划门）与最近事件（运行完成 / 需要注意）。
 *   2) 系统级通知（Notification API）：页面不可见或失焦时才发，30 秒合并窗，
 *      秒级任务（≤60s）的运行完成不打扰。
 *
 * 与 command-palette 同一约定：纯函数层可单测；DOM 层 initNotifications(host, env)
 * 由宿主（index.html 内联控制器）注入回调，本模块不反向 import 宿主任何东西。
 *
 * 事件口径与 app.js 的 reducer 对齐（同一份 durable 事件流）：
 *   approval_request / approval_resolved / approval_expired（审批，verifier 来源不算）
 *   user_question_request / user_question_resolved / user_question_expired（§5.2 提问）
 *   plan_approval_request / plan_approval_resolved / plan_approval_expired（§5.1 计划门）
 *   run_end（run 级终止；mainStopReason 分档）
 */

// ---------------------------------------------------------------
// 常量
// ---------------------------------------------------------------

/** 同一会话同类事件的系统通知合并窗（毫秒） */
export const MERGE_WINDOW_MS = 30_000;
/** 运行完成系统通知的最短运行时长（毫秒）：秒级任务不值得通知 */
export const MIN_NOTIFY_DURATION_MS = 60_000;
/** 事件流类条目（运行完成 / 需要注意）的留存上限 */
export const FEED_LIMIT = 50;
/** 已读 id 的持久化上限（超出裁最旧的） */
export const READ_CAP = 200;

export const READ_STORAGE_KEY = "agent-ui-notifications-read";
export const PROMPT_STORAGE_KEY = "agent-ui-notify-prompt";

// ---------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------

/**
 * @typedef {"approval"|"question"|"plan_gate"|"run_end"|"budget"|"error"} NotificationKind
 * @typedef {"decision"|"finished"|"attention"} NotificationCategory
 * @typedef {{
 *   id:string, runId:string, runTitle:string, kind:NotificationKind,
 *   category:NotificationCategory, label:string, detail:string|null,
 *   at:number, read:boolean, pending:boolean, durationMs:number|null,
 * }} NotificationItem
 * @typedef {{
 *   items:NotificationItem[],
 *   endedRunIds:string[],
 *   seenStatuses:Record<string,string>,
 *   seeded:boolean,
 * }} NotificationStore
 * @typedef {{runId:string, task?:string, status:string, stopReason?:string|null, createdAt?:number, finishedAt?:number|null}} RunListEntry
 */

/** @returns {NotificationStore} */
export function createNotificationStore() {
  return { items: [], endedRunIds: [], seenStatuses: {}, seeded: false };
}

/**
 * run_end 分档。与 app.js classifyStopReason 同口径，但只保留通知中心需要的三分：
 *   - finished/完成：completed、max_tokens、partial、blocked（有交付或明确收口）
 *   - finished/未通过：max_turns、incomplete、stalled、refusal
 *   - finished/被停止：aborted、plan_rejected、plan_gate_expired（人的决定，不是异常）
 *   - attention/预算耗尽：budget_exhausted
 *   - attention/运行错误：error
 * @param {string|null|undefined} stopReason
 * @returns {{ category:"finished"|"attention", kind:NotificationKind, tier:string, tone:"ok"|"warn"|"bad" }|null}
 */
export function classifyRunEndForNotify(stopReason) {
  switch (stopReason) {
    case "completed":
    case "max_tokens":
    case "partial":
    case "blocked":
      return { category: "finished", kind: "run_end", tier: "完成", tone: "ok" };
    case "max_turns":
    case "incomplete":
    case "stalled":
    case "refusal":
      return { category: "finished", kind: "run_end", tier: "未通过", tone: "bad" };
    case "aborted":
    case "plan_rejected":
    case "plan_gate_expired":
      return { category: "finished", kind: "run_end", tier: "被停止", tone: "warn" };
    case "budget_exhausted":
      return { category: "attention", kind: "budget", tier: "预算耗尽", tone: "warn" };
    case "error":
      return { category: "attention", kind: "error", tier: "运行错误", tone: "bad" };
    default:
      // 未知终止原因按「完成」档入 finished，但标注原始原因，不替宿主编结论
      return { category: "finished", kind: "run_end", tier: "完成", tone: "warn" };
  }
}

function isChildAgentSource(source) {
  const s = String(source ?? "");
  if (s.startsWith("spawn/")) return true;
  const slash = s.indexOf("/");
  if (slash <= 0) return false;
  const head = s.slice(0, slash);
  return head !== "main" && head !== "rework" && head !== "verifier"
    && head !== "planner" && head !== "host" && head !== "model";
}

/**
 * 同一会话同一类待决叠成一条：并行子任务各要一次 bash 时，
 * 「待你决定」不该出现五张长得一样的卡。
 */
export function collapseDecisionItems(items) {
  const groups = new Map();
  for (const item of items ?? []) {
    if (!item || item.category !== "decision") continue;
    const key = `${item.runId}:${item.kind}`;
    const prev = groups.get(key);
    if (!prev) {
      groups.set(key, { ...item, count: 1 });
      continue;
    }
    prev.count += 1;
    if (!item.read) prev.read = false;
    if (Number(item.at) > Number(prev.at)) {
      prev.at = item.at;
      prev.detail = item.detail;
      prev.id = item.id;
    }
  }
  return [...groups.values()];
}

/**
 * 把一条 SSE 事件折叠进通知存储。纯函数：返回新 store 与本次新增的条目
 * （DOM 层据此决定要不要发系统通知）。
 *
 * 幂等：重放同一条事件流得到同一份 store——
 *   待决条目以确定性 id 去重；run_end 用 endedRunIds 去重。
 *
 * @param {NotificationStore} store
 * @param {{ runId:string, runTitle:string, seq:number, source:string,
 *           event:Record<string,unknown>, now:number, runCreatedAt?:number|null }} input
 * @returns {{ store:NotificationStore, added:NotificationItem[] }}
 */
export function applyRunEventToStore(store, input) {
  const { runId, runTitle, seq, source, event, now } = input;
  const type = /** @type {string} */ (event?.type ?? "");
  const at = Number(event?.at ?? now) || now;

  /** @param {NotificationItem[]} items @param {string} id */
  const without = (items, id) => items.filter((i) => i.id !== id);
  /** @param {NotificationItem[]} items */
  const dropPendingOfRun = (items) =>
    items.filter((i) => !(i.runId === runId && i.pending));

  let items = store.items;
  let endedRunIds = store.endedRunIds;
  /** @type {NotificationItem[]} */
  const added = [];

  /** @param {NotificationItem} item */
  const pushPending = (item) => {
    if (items.some((i) => i.id === item.id)) return; // 重放去重
    items = [...items, item];
    added.push(item);
  };
  /** @param {NotificationItem} item */
  const pushFeed = (item) => {
    if (items.some((i) => i.id === item.id)) return;
    items = [...items, item];
    added.push(item);
  };

  switch (type) {
    case "approval_request": {
      // planner/verifier 在 drain 里自答，不进「待你决定」（同 applyApproval）
      if (
        source === "verifier" || source === "planner"
        || (typeof source === "string" && (source.endsWith("/verifier") || source.endsWith("/planner")))
      ) break;
      // 子代理审批挂在「子代理工作中」卡上，不在这里摊成 N 张假待决。
      if (isChildAgentSource(source)) break;
      // 自动放行 / 同批已决：不是待你决定。再记一条会让通知中心堆出几十张假待决。
      if (event.autoResolved === true) break;
      const toolUseId = String(event.toolUseId ?? "");
      const name = String(event.name ?? "工具");
      pushPending({
        id: `ap:${runId}:${toolUseId}#${seq}`,
        runId, runTitle,
        kind: "approval", category: "decision",
        label: "审批待决",
        detail: name,
        at, read: false, pending: true, durationMs: null,
      });
      break;
    }
    case "approval_resolved":
    case "approval_expired": {
      const toolUseId = String(event.toolUseId ?? "");
      const requestSeq = Number(event.requestSeq ?? seq);
      items = without(items, `ap:${runId}:${toolUseId}#${requestSeq}`);
      break;
    }
    case "user_question_request": {
      const qid = String(event.id ?? seq);
      const first = Array.isArray(event.questions) && event.questions[0]
        ? String(/** @type {any} */ (event.questions[0]).question ?? "")
        : "";
      pushPending({
        id: `q:${runId}:${qid}`,
        runId, runTitle,
        kind: "question", category: "decision",
        label: "提问待答",
        detail: first || null,
        at, read: false, pending: true, durationMs: null,
      });
      break;
    }
    case "user_question_resolved":
    case "user_question_expired": {
      const qid = String(event.id ?? event.requestSeq ?? seq);
      items = without(items, `q:${runId}:${qid}`);
      break;
    }
    case "plan_approval_request": {
      pushPending({
        id: `pg:${runId}:${seq}`,
        runId, runTitle,
        kind: "plan_gate", category: "decision",
        label: "计划待签发",
        detail: "拆解完成，等你批准后才发射子任务",
        at, read: false, pending: true, durationMs: null,
      });
      break;
    }
    case "plan_approval_resolved":
    case "plan_approval_expired": {
      const requestSeq = Number(event.requestSeq ?? seq);
      items = without(items, `pg:${runId}:${requestSeq}`);
      break;
    }
    case "run_end": {
      // 幂等：run_end 恒为最后一条 durable 事件，重放不重复记
      if (endedRunIds.includes(runId)) break;
      endedRunIds = [...endedRunIds, runId];
      items = dropPendingOfRun(items);
      const stopReason = event.mainStopReason != null ? String(event.mainStopReason) : null;
      const cls = classifyRunEndForNotify(stopReason);
      const createdAt = Number.isFinite(Number(input.runCreatedAt)) ? Number(input.runCreatedAt) : null;
      const durationMs = createdAt !== null && at >= createdAt ? at - createdAt : null;
      pushFeed({
        id: `end:${runId}:${seq}`,
        runId, runTitle,
        kind: cls.kind, category: cls.category,
        label: cls.tier,
        detail: runTitle || null,
        at, read: false, pending: false, durationMs,
      });
      break;
    }
    default:
      return { store, added };
  }

  // 事件流条目（非待决）超限时裁最旧的；待决条目永不裁——它们是真待办
  const feed = items.filter((i) => !i.pending);
  if (feed.length > FEED_LIMIT) {
    const overflow = feed.length - FEED_LIMIT;
    const dropIds = new Set(feed.slice(0, overflow).map((i) => i.id));
    items = items.filter((i) => !dropIds.has(i.id));
  }

  return { store: { ...store, items, endedRunIds }, added };
}

/**
 * 从 run 列表状态派生（补事件流够不到的那一面）：
 *   - 首次调用只做基线播种，不为历史 run 生成条目（否则一打开页面就被旧账刷屏）；
 *   - 之后 running→done 的跃迁（该 run 没有事件订阅、run_end 没被 ingest 过时）
 *     补一条「运行完成」；
 *   - 已 done 的 run 清掉残留的待决条目（对账保险）。
 *
 * @param {NotificationStore} store
 * @param {RunListEntry[]} runs
 * @param {number} now
 * @returns {{ store:NotificationStore, added:NotificationItem[] }}
 */
export function syncRunsToStore(store, runs, now) {
  /** @type {NotificationItem[]} */
  const added = [];
  let items = store.items;
  let endedRunIds = store.endedRunIds;
  /** @type {Record<string,string>} */
  const seen = {};

  for (const run of runs) {
    const prev = store.seeded ? store.seenStatuses[run.runId] : undefined;
    seen[run.runId] = run.status;
    if (
      prev === "running" &&
      run.status === "done" &&
      !endedRunIds.includes(run.runId)
    ) {
      endedRunIds = [...endedRunIds, run.runId];
      const cls = classifyRunEndForNotify(run.stopReason ?? "completed");
      const at = Number(run.finishedAt ?? now) || now;
      const createdAt = Number.isFinite(Number(run.createdAt)) ? Number(run.createdAt) : null;
      const item = {
        id: `end:${run.runId}:list`,
        runId: run.runId,
        runTitle: String(run.task ?? ""),
        kind: cls.kind, category: cls.category,
        label: cls.tier,
        detail: String(run.task ?? "") || null,
        at, read: false, pending: false,
        durationMs: createdAt !== null && at >= createdAt ? at - createdAt : null,
      };
      if (!items.some((i) => i.id === item.id)) {
        items = [...items, item];
        added.push(item);
      }
    }
    if (run.status === "done") {
      items = items.filter((i) => !(i.runId === run.runId && i.pending));
    }
  }

  const feed = items.filter((i) => !i.pending);
  if (feed.length > FEED_LIMIT) {
    const dropIds = new Set(feed.slice(0, feed.length - FEED_LIMIT).map((i) => i.id));
    items = items.filter((i) => !dropIds.has(i.id));
  }

  return {
    store: { items, endedRunIds, seenStatuses: seen, seeded: true },
    added,
  };
}

/** 删除会话时清掉它的全部条目与账本记录。 @returns {NotificationStore} */
export function removeRunFromStore(store, runId) {
  const { [runId]: _dropped, ...seenStatuses } = store.seenStatuses;
  return {
    ...store,
    items: store.items.filter((i) => i.runId !== runId),
    endedRunIds: store.endedRunIds.filter((id) => id !== runId),
    seenStatuses,
  };
}

/**
 * 角标数字 = 待决定类未读数（最重要的数字）。
 * @param {NotificationStore} store
 * @returns {number}
 */
export function decisionUnreadCount(store) {
  return collapseDecisionItems(store.items.filter((i) => !i.read)).length;
}

/**
 * 面板分组：待你决定 / 运行完成 / 需要注意，各组按时间倒序。
 * @param {NotificationStore} store
 * @returns {{ key:NotificationCategory, label:string, unread:number, items:NotificationItem[] }[]}
 */
export function groupStoreItems(store) {
  const byAtDesc = (a, b) => b.at - a.at;
  const decision = collapseDecisionItems(store.items).sort(byAtDesc);
  const finished = store.items.filter((i) => i.category === "finished").sort(byAtDesc);
  const attention = store.items.filter((i) => i.category === "attention").sort(byAtDesc);
  const unread = (list) => list.filter((i) => !i.read).length;
  return [
    { key: "decision", label: "待你决定", unread: unread(decision), items: decision },
    { key: "finished", label: "运行完成", unread: unread(finished), items: finished },
    { key: "attention", label: "需要注意", unread: unread(attention), items: attention },
  ];
}

/** @returns {NotificationStore} */
export function markRead(store, id) {
  return {
    ...store,
    items: store.items.map((i) => (i.id === id ? { ...i, read: true } : i)),
  };
}

/** @returns {NotificationStore} */
export function markAllRead(store) {
  return { ...store, items: store.items.map((i) => (i.read ? i : { ...i, read: true })) };
}

/**
 * 系统通知判定（第二层）。五个条件缺一不可发：
 *   1. 已授权（permission === "granted"）；
 *   2. 页面不可见或窗口失焦（可见时不打扰）；
 *   3. run_end 类要求运行时长 > 60s；
 *   4. 同一会话同类事件 30 秒合并窗内不重复发；
 *   5. kind 必须是可通知类型。
 * @param {{ kind:NotificationKind, permission:string|null, hidden:boolean, focused:boolean,
 *           durationMs?:number|null, lastSentAt?:number|null, now:number }} input
 * @returns {boolean}
 */
export function shouldSendSystemNotification(input) {
  const { kind, permission, hidden, focused, now } = input;
  if (permission !== "granted") return false;
  if (!hidden && focused) return false;
  if (kind === "run_end" || kind === "budget" || kind === "error") {
    if (kind === "run_end" && (input.durationMs == null || input.durationMs <= MIN_NOTIFY_DURATION_MS)) {
      return false;
    }
  }
  const last = input.lastSentAt ?? null;
  if (last !== null && now - last < MERGE_WINDOW_MS) return false;
  return true;
}

/**
 * 系统通知合并键：同一会话同类事件共用一个键（也是 Notification.tag）。
 * @param {string} runId @param {NotificationKind} kind
 */
export function systemMergeKey(runId, kind) {
  return `${runId}:${kind}`;
}

/**
 * 权限提示条判定：仅在「支持但未决定且用户没表态过」时出现一次。
 * @param {string|null} permission Notification.permission（不支持时传 null）
 * @param {string|null} promptChoice localStorage 里的用户选择（"dismissed" 等）
 * @returns {boolean}
 */
export function shouldPromptForPermission(permission, promptChoice) {
  if (permission !== "default") return false;
  return promptChoice !== "dismissed" && promptChoice !== "granted";
}

/**
 * 相对时间：刚刚 / N 分钟前 / N 小时前 / 今天 HH:mm / M月d日。
 * @param {number} at @param {number} now
 * @returns {string}
 */
export function formatRelTime(at, now) {
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const d = new Date(at);
  const n = new Date(now);
  if (diff < 86_400_000 && d.getDate() === n.getDate()) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * 持久化已读 id（只存当前还活着的条目，避免无限增长）。
 * @param {Storage|null} storage @param {NotificationStore} store
 */
export function persistReadState(storage, store) {
  if (!storage) return;
  try {
    const readIds = store.items.filter((i) => i.read).map((i) => i.id).slice(-READ_CAP);
    storage.setItem(READ_STORAGE_KEY, JSON.stringify(readIds));
  } catch { /* 隐私模式写入失败：本次会话内仍生效 */ }
}

/**
 * 启动时把已读标记贴回条目。
 * @param {Storage|null} storage @param {NotificationStore} store
 * @returns {NotificationStore}
 */
export function restoreReadState(storage, store) {
  if (!storage) return store;
  try {
    const raw = storage.getItem(READ_STORAGE_KEY);
    const ids = raw ? new Set(JSON.parse(raw)) : null;
    if (!ids || ids.size === 0) return store;
    return applyReadIds(store, ids);
  } catch {
    return store;
  }
}

/**
 * 把一组已读 id 贴到 store 上（内存账本与持久化恢复快照共用这一条路径）。
 * @param {NotificationStore} store @param {Set<string>} ids
 * @returns {NotificationStore}
 */
export function applyReadIds(store, ids) {
  if (!ids || ids.size === 0) return store;
  return {
    ...store,
    items: store.items.map((i) => (!i.read && ids.has(i.id) ? { ...i, read: true } : i)),
  };
}

/** @param {Storage|null} storage @returns {string|null} */
export function loadPromptChoice(storage) {
  try {
    return storage ? storage.getItem(PROMPT_STORAGE_KEY) : null;
  } catch {
    return null;
  }
}

/** @param {Storage|null} storage @param {string} choice */
export function persistPromptChoice(storage, choice) {
  try {
    storage?.setItem(PROMPT_STORAGE_KEY, choice);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------
// DOM 层
// ---------------------------------------------------------------

const PANEL_ID = "notifications-panel";
const PROMPT_ID = "notifications-prompt";

const KIND_ICON = {
  approval: "ph-shield-check",
  question: "ph-chat-centered-dots",
  plan_gate: "ph-tree-structure",
  run_end: "ph-flag-checkered",
  budget: "ph-coins",
  error: "ph-warning-circle",
};

/**
 * 初始化通知中心。幂等：重复调用返回既有节点的薄壳。
 *
 * host 回调：
 *   getRuns()           → RunListEntry[]（同步 run 列表状态用）
 *   getRunTitle(runId)  → string|null（渲染时刷新标题，run 被删后降级为旧快照）
 *   onOpenConversation(runId) → 跳转会话（hash 路由）
 *   onRevealDock(runId) → 待决定类点击后直达 action-dock（可选）
 *   onAnnounce(msg)     → aria-live 播报（可选）
 *
 * env（测试注入）：doc / win / storage / now / Notification
 *
 * @param {Record<string, Function>} host
 * @param {{ doc?:Document, win?:Window, storage?:Storage|null, now?:() => number,
 *           Notification?:any }} [env]
 */
export function initNotifications(host = {}, env = {}) {
  const doc = env.doc ?? document;
  const win = env.win ?? (doc.defaultView ?? window);
  const storage = env.storage !== undefined ? env.storage : safeStorage(win);
  const now = env.now ?? (() => Date.now());
  const NotificationCtor =
    env.Notification !== undefined
      ? env.Notification
      : typeof Notification !== "undefined"
        ? Notification
        : null;

  const bell = /** @type {HTMLElement|null} */ (doc.getElementById("notifications-btn"));
  const badge = /** @type {HTMLElement|null} */ (doc.getElementById("notifications-badge"));

  const existing = doc.getElementById(PANEL_ID);
  if (existing) {
    return { open: () => { existing.hidden = false; }, close: () => { existing.hidden = true; }, isOpen: () => !existing.hidden, element: existing, ingest: () => {}, syncRuns: () => {}, removeRun: () => {} };
  }

  // ---- 状态 ----
  let store = restoreReadState(storage, createNotificationStore());
  /** 已读内存账本：storage 只是它的快照，运行期以这里为准（隐私模式写入失败也不丢态） */
  const readIds = new Set(store.items.filter((i) => i.read).map((i) => i.id));
  /** @type {Map<string, number>} 系统通知合并窗账本 */
  const systemSentAt = new Map();
  let open = false;
  /** @type {HTMLElement|null} */
  let restoreFocusTo = null;
  let promptChoice = loadPromptChoice(storage);

  // ---- 骨架：浮层面板 ----
  const overlay = doc.createElement("div");
  overlay.id = PANEL_ID;
  overlay.className = "notif-overlay";
  overlay.hidden = true;

  const panel = doc.createElement("div");
  panel.className = "notif-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", "通知中心");

  const head = doc.createElement("div");
  head.className = "notif-head";
  const title = doc.createElement("h2");
  title.className = "notif-title";
  title.textContent = "通知中心";
  const markAllBtn = doc.createElement("button");
  markAllBtn.type = "button";
  markAllBtn.className = "notif-mark-all";
  markAllBtn.textContent = "全部已读";
  const closeBtn = doc.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "notif-close icon-btn";
  closeBtn.setAttribute("aria-label", "关闭通知中心");
  closeBtn.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i>';
  head.appendChild(title);
  head.appendChild(markAllBtn);
  head.appendChild(closeBtn);

  const body = doc.createElement("div");
  body.className = "notif-body";

  const empty = doc.createElement("div");
  empty.className = "notif-empty";
  empty.textContent = "没有待处理项——需要你做决定或刚结束的任务会出现在这里";

  panel.appendChild(head);
  panel.appendChild(body);
  panel.appendChild(empty);
  overlay.appendChild(panel);
  doc.body.appendChild(overlay);

  // ---- 骨架：权限提示条（一次性，轻量） ----
  const prompt = doc.createElement("div");
  prompt.id = PROMPT_ID;
  prompt.className = "notif-prompt";
  prompt.setAttribute("role", "status");
  prompt.hidden = true;
  const promptText = doc.createElement("span");
  promptText.className = "notif-prompt-text";
  promptText.textContent = "开启桌面通知，运行完成或需要你决定时提醒你";
  const promptAllow = doc.createElement("button");
  promptAllow.type = "button";
  promptAllow.className = "btn btn--primary notif-prompt-allow";
  promptAllow.textContent = "开启";
  const promptDismiss = doc.createElement("button");
  promptDismiss.type = "button";
  promptDismiss.className = "btn btn--ghost notif-prompt-dismiss";
  promptDismiss.textContent = "不再提示";
  prompt.appendChild(promptText);
  prompt.appendChild(promptAllow);
  prompt.appendChild(promptDismiss);
  doc.body.appendChild(prompt);

  function permissionState() {
    return NotificationCtor ? String(NotificationCtor.permission ?? "default") : null;
  }

  // ---- 渲染 ----
  function renderBadge() {
    if (!badge) return;
    const n = decisionUnreadCount(store);
    badge.hidden = n === 0;
    badge.textContent = n > 99 ? "99+" : String(n);
    if (bell) {
      bell.setAttribute(
        "aria-label",
        n > 0 ? `通知中心，${n} 项待你决定` : "通知中心",
      );
    }
  }

  function titleOf(item) {
    return host.getRunTitle?.(item.runId) ?? item.runTitle ?? "";
  }

  function renderPanel() {
    body.innerHTML = "";
    const groups = groupStoreItems(store);
    let total = 0;
    for (const group of groups) {
      if (group.items.length === 0) continue;
      total += group.items.length;
      const section = doc.createElement("section");
      section.className = "notif-group";
      section.setAttribute("data-group", group.key);
      const h = doc.createElement("h3");
      h.className = "notif-group-title";
      h.textContent = group.label;
      if (group.unread > 0) {
        const count = doc.createElement("span");
        count.className = "notif-group-count";
        count.textContent = String(group.unread);
        h.appendChild(count);
      }
      section.appendChild(h);
      const ul = doc.createElement("ul");
      ul.className = "notif-list";
      for (const item of group.items) {
        const li = doc.createElement("li");
        const btn = doc.createElement("button");
        btn.type = "button";
        btn.className = "notif-item";
        if (!item.read) btn.classList.add("notif-item--unread");
        btn.setAttribute("data-notif-id", item.id);

        const icon = doc.createElement("i");
        icon.className = `ph ${KIND_ICON[item.kind] ?? "ph-bell"}`;
        icon.setAttribute("aria-hidden", "true");
        btn.appendChild(icon);

        const copy = doc.createElement("span");
        copy.className = "notif-item-copy";
        const line1 = doc.createElement("span");
        line1.className = "notif-item-line1";
        const label = doc.createElement("span");
        label.className = "notif-item-label";
        label.textContent = item.count > 1 ? `${item.label} · ${item.count} 项` : item.label;
        line1.appendChild(label);
        const conv = doc.createElement("span");
        conv.className = "notif-item-conv";
        conv.textContent = titleOf(item) || "（会话已删除）";
        line1.appendChild(conv);
        copy.appendChild(line1);
        const line2 = doc.createElement("span");
        line2.className = "notif-item-line2";
        const bits = [];
        if (item.detail && item.detail !== titleOf(item)) bits.push(item.detail);
        bits.push(formatRelTime(item.at, now()));
        line2.textContent = bits.join(" · ");
        copy.appendChild(line2);
        btn.appendChild(copy);

        btn.addEventListener("click", () => openItem(item));
        li.appendChild(btn);
        ul.appendChild(li);
      }
      section.appendChild(ul);
      body.appendChild(section);
    }
    empty.hidden = total > 0;
    body.hidden = total === 0;
    markAllBtn.disabled = store.items.every((i) => i.read);
  }

  function render() {
    renderBadge();
    renderPanel();
  }

  function persist() {
    persistReadState(storage, store);
  }

  /** reducer 产出的新 store 进场时，把内存已读账本贴回去 */
  function adoptStore(next) {
    store = applyReadIds(next, readIds);
  }

  /** 点击条目：标记已读 → 跳会话 → 待决定类直达 action-dock */
  function openItem(item) {
    readIds.add(item.id);
    store = markRead(store, item.id);
    persist();
    render();
    closePanel();
    if (item.category === "decision" && typeof host.onRevealDock === "function") {
      host.onRevealDock(item.runId);
    } else {
      host.onOpenConversation?.(item.runId);
    }
    host.onAnnounce?.(`已打开：${titleOf(item) || item.runId}`);
  }

  // ---- 系统通知（第二层） ----
  /** @param {NotificationItem} item */
  function maybeSystemNotify(item) {
    if (!NotificationCtor) return;
    const key = systemMergeKey(item.runId, item.kind);
    const ok = shouldSendSystemNotification({
      kind: item.kind,
      permission: permissionState(),
      hidden: Boolean(doc.hidden),
      focused: typeof doc.hasFocus === "function" ? doc.hasFocus() : true,
      durationMs: item.durationMs,
      lastSentAt: systemSentAt.get(key) ?? null,
      now: now(),
    });
    if (!ok) return;
    systemSentAt.set(key, now());
    try {
      const n = new NotificationCtor(`${item.label} · ${titleOf(item) || "会话"}`, {
        body: item.detail ?? "",
        tag: key,
      });
      if (n) n.onclick = () => {
        win.focus?.();
        openItem(item);
      };
    } catch { /* 构造被拒（如权限中途被收走）时静默降级，应用内中心仍可用 */ }
  }

  /** 首次出现待决事件时的一次性授权提示 */
  function maybeShowPrompt() {
    if (!prompt.hidden) return;
    const hasPending = store.items.some((i) => i.category === "decision");
    if (!hasPending) return;
    if (!shouldPromptForPermission(permissionState(), promptChoice)) return;
    prompt.hidden = false;
  }

  promptAllow.addEventListener("click", () => {
    prompt.hidden = true;
    if (!NotificationCtor || typeof NotificationCtor.requestPermission !== "function") return;
    try {
      const done = (result) => {
        promptChoice = result === "granted" ? "granted" : "dismissed";
        persistPromptChoice(storage, promptChoice);
      };
      const ret = NotificationCtor.requestPermission(done);
      // 新规范返回 Promise，旧规范走回调——两个都接，哪个来了用哪个
      if (ret && typeof ret.then === "function") ret.then(done);
    } catch { /* 请求本身被拒时不再追问 */ }
  });
  promptDismiss.addEventListener("click", () => {
    prompt.hidden = true;
    promptChoice = "dismissed";
    persistPromptChoice(storage, promptChoice);
  });

  // ---- 开关 ----
  function openPanel() {
    if (open) return;
    open = true;
    restoreFocusTo = /** @type {HTMLElement|null} */ (doc.activeElement);
    overlay.hidden = false;
    bell?.setAttribute("aria-expanded", "true");
    renderPanel();
    closeBtn.focus();
  }

  function closePanel() {
    if (!open) return;
    open = false;
    overlay.hidden = true;
    bell?.setAttribute("aria-expanded", "false");
    if (restoreFocusTo && typeof restoreFocusTo.focus === "function") restoreFocusTo.focus();
    restoreFocusTo = null;
  }

  bell?.addEventListener("click", () => (open ? closePanel() : openPanel()));
  closeBtn.addEventListener("click", () => closePanel());
  markAllBtn.addEventListener("click", () => {
    for (const i of store.items) readIds.add(i.id);
    store = markAllRead(store);
    persist();
    render();
    host.onAnnounce?.("全部通知已标为已读");
  });
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) closePanel();
  });
  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      closePanel();
    }
  });

  renderBadge();

  // ---- 对外 API：宿主在事件节拍与列表刷新时推数据进来 ----
  return {
    open: openPanel,
    close: closePanel,
    isOpen: () => open,
    element: overlay,
    /**
     * 每 run 事件流的一条事件（与 reduceEvent 同一份信封）。
     * @param {string} runId
     * @param {{ seq:number, source:string, event:Record<string,unknown> }} sseEvent
     */
    ingest(runId, sseEvent) {
      const runTitle = host.getRunTitle?.(runId) ?? "";
      const runs = host.getRuns?.() ?? [];
      const createdAt = runs.find((r) => r.runId === runId)?.createdAt ?? null;
      const before = new Set(store.items.map((i) => i.id));
      const result = applyRunEventToStore(store, {
        runId, runTitle,
        seq: Number(sseEvent?.seq ?? 0),
        source: String(sseEvent?.source ?? "main"),
        event: sseEvent?.event ?? {},
        now: now(),
        runCreatedAt: createdAt,
      });
      adoptStore(result.store);
      if (result.added.length === 0) {
        if (before.size !== store.items.length) render(); // 待决被消解也要刷新
        return;
      }
      for (const item of result.added) maybeSystemNotify(item);
      maybeShowPrompt();
      render();
    },
    /** run 列表刷新后对账（生命周期流 / loadRuns 之后调用） */
    syncRuns() {
      const runs = host.getRuns?.() ?? [];
      const result = syncRunsToStore(store, runs, now());
      adoptStore(result.store);
      for (const item of result.added) maybeSystemNotify(item);
      render();
    },
    /** 会话被删除时清账 */
    removeRun(runId) {
      store = removeRunFromStore(store, runId);
      render();
    },
    /** 测试与诊断用 */
    getStore: () => store,
  };
}

/** localStorage 可能因隐私模式整个不可用，取不到就降级为内存态 */
function safeStorage(win) {
  try {
    return win?.localStorage ?? null;
  } catch {
    return null;
  }
}

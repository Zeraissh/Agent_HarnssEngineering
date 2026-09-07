/**
 * features/reading-mode — 过程/结论双模式阅读（T12）。
 *
 * 问题：对话主列把思考过程、每次工具调用、审批痕迹按时刻全部织进时间流。
 * 长任务（70+ 轮）时真正有价值的助手正文/结论被同质的过程卡片淹没。
 *
 * 两种模式：
 *   「完整」——现状，一字不动；
 *   「聚焦」——主列只留：用户消息、助手正文、结果/产物卡、审批·裁决·返工等
 *     **决策类痕迹**（监督语义，不能藏）、段分界卡。思考与常规工具调用折叠为
 *     段间一条细摘要行（如「3 次思考 · 7 个工具调用 · 12s」），点击展开还原。
 *
 * 实现策略（不动 app.js 渲染）：
 *   纯 DOM 后处理层。宿主（index.html 内联控制器）在每次 renderRunDetail 之后
 *   调 update(backBar, conversation)——与 changes-panel 的 mount 同一时机。
 *   聚焦模式给过程类元素加 .rm-hidden、在相邻锚点之间插入 .rm-summary 摘要行；
 *   切回完整模式移除全部处理。每次 update 全量重算，天然幂等，可反复切换。
 *
 * 与其他 features 同一约定：
 *   1) 纯函数层（单元分类 / 聚类 / 摘要文案 / 偏好读写）——可单测；
 *   2) DOM 层 initReadingMode(host, env)——宿主注入回调，本模块不反向 import 宿主。
 *
 * 直播纪律：摘要段默认收起；用户展开的段记在 expandedKeys 里，重算后还原展开态。
 * 新到的过程事件并入所在段，**不会弹开**已收起的段；新助手正文是锚点，正常流式出现。
 */

// ---------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------

/** 偏好键：全局（非每会话），与设置中心「外观」分组同源读写 */
export const READING_MODE_KEY = "agent-ui-reading-mode";

/** @type {readonly ["full", "focus"]} */
export const READING_MODES = ["full", "focus"];

/** 分段开关与设置中心共用同一份文案，避免两处漂移 */
export const READING_MODE_COPY = {
  groupLabel: "对话阅读模式",
  full: { label: "完整", hint: "思考、工具与结论全部按时间展开" },
  focus: { label: "聚焦", hint: "只留正文与决策痕迹，过程收成摘要行" },
  expandTitle: "点击展开这段过程",
  collapseTitle: "点击收起这段过程",
};

/**
 * 读偏好。未设 / 非法值 / storage 不可用 → "full"（保守默认：完整模式是现状）。
 * @param {Storage|null} [storage]
 * @returns {"full"|"focus"}
 */
export function readReadingMode(storage) {
  try {
    const raw = (storage ?? safeLocalStorage())?.getItem(READING_MODE_KEY);
    return raw === "focus" ? "focus" : "full";
  } catch {
    return "full";
  }
}

/**
 * 写偏好。非法值按 "full" 落盘，不写第三态。
 * @param {Storage|null} [storage]
 * @param {string} mode
 * @returns {"full"|"focus"} 实际写入的值
 */
export function writeReadingMode(storage, mode) {
  const next = mode === "focus" ? "focus" : "full";
  try {
    (storage ?? safeLocalStorage())?.setItem(READING_MODE_KEY, next);
  } catch {
    /* 隐私模式写不进：本次会话内仍生效（调用方持有内存态） */
  }
  return next;
}

/** localStorage 可能因隐私模式整个不可用 */
function safeLocalStorage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * 过程单元分类。**只认已知的过程类，其余一律按锚点处理**（保守方向：
 * 判错了宁可多留，绝不误藏——决策类痕迹因此天然安全）。
 *
 * 分类单位是 .chat-item 的**直接子元素**，不是 chat-item 本身：
 * 直播条目（kind:"live"）里思考 details 与正文 .chat-msg--live 是平级兄弟，
 * 前者要折、后者必须继续流式出现。
 *
 * @param {Element} el
 * @returns {"thinking"|"tool"|"activity"|"anchor"}
 */
export function classifyUnit(el) {
  if (!el || typeof el.matches !== "function") return "anchor";
  if (el.matches("details.chat-thinking")) return "thinking";
  if (el.matches("details.chat-tool-group, details.chat-tool")) return "tool";
  if (el.matches(".chat-activity")) return "activity";
  return "anchor";
}

/**
 * @typedef {{ kind:"thinking"|"tool"|"activity"|"anchor", key:string,
 *   durationMs?:number }} ReadingUnit
 * @typedef {{ type:"anchor", key:string } |
 *   { type:"summary", key:string, thinking:number, tools:number,
 *     activities:number, durationMs:number }} ReadingSegment
 */

/**
 * 聚类：单元序列 → 摘要段模型。连续的过程单元合并为一条 summary 段，
 * 段 key 取段内首单元 key（直播中尾段持续增长时身份稳定，展开态不丢）。
 * @param {ReadingUnit[]} units
 * @returns {ReadingSegment[]}
 */
export function clusterUnits(units) {
  /** @type {ReadingSegment[]} */
  const out = [];
  /** @type {Extract<ReadingSegment, { type:"summary" }>|null} */
  let open = null;
  for (const u of units) {
    if (!u || u.kind === "anchor") {
      open = null;
      out.push({ type: "anchor", key: String(u?.key ?? "") });
      continue;
    }
    if (!open) {
      open = { type: "summary", key: String(u.key), thinking: 0, tools: 0, activities: 0, durationMs: 0 };
      out.push(open);
    }
    if (u.kind === "thinking") open.thinking += 1;
    else if (u.kind === "tool") open.tools += 1;
    else if (u.kind === "activity") open.activities += 1;
    if (Number.isFinite(u.durationMs) && u.durationMs > 0) open.durationMs += u.durationMs;
  }
  return out;
}

/**
 * 时长格式化：998ms → "998ms"；4.2s；43s；2m5s。
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const total = Number(ms);
  if (!Number.isFinite(total) || total <= 0) return "";
  if (total < 1000) return `${Math.round(total)}ms`;
  const s = total / 1000;
  if (s < 10) return `${Math.round(s * 10) / 10}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return rest > 0 ? `${m}m${rest}s` : `${m}m`;
}

/**
 * 摘要行文案：「3 次思考 · 7 个工具调用 · 12s」。零计数维度不出现；
 * 时长只有能从被藏元素里解析出来才带（工具行的 durationMs  peek）。
 * @param {{ thinking:number, tools:number, activities:number, durationMs:number }} seg
 * @returns {string}
 */
export function summaryText(seg) {
  const parts = [];
  if (seg.thinking > 0) parts.push(`${seg.thinking} 次思考`);
  if (seg.tools > 0) parts.push(`${seg.tools} 个工具调用`);
  if (seg.activities > 0) parts.push(`${seg.activities} 条状态提示`);
  const dur = formatDuration(seg.durationMs);
  if (dur) parts.push(dur);
  return parts.join(" · ");
}

/**
 * 从被藏的工具元素里解析耗时：逐条工具行 summary 里的 "123ms" peek 求和。
 * 工具组（chat-tool-group）的摘要行不带耗时，解析不到就按 0，不伪造。
 * @param {Element} el
 * @returns {number}
 */
export function parseToolDuration(el) {
  let total = 0;
  const peeks = el.querySelectorAll?.(".aside-peek") ?? [];
  for (const peek of peeks) {
    const m = /(\d+)\s*ms/.exec(peek.textContent ?? "");
    if (m) total += Number(m[1]);
  }
  return total;
}

// ---------------------------------------------------------------
// DOM 层
// ---------------------------------------------------------------

const HIDDEN_CLASS = "rm-hidden";
const SUMMARY_CLASS = "rm-summary";

/**
 * 初始化阅读模式。幂等：重复调用返回既有实例。
 *
 * host 回调：
 *   onModeChange(mode) → 模式切换后（设置中心同源刷新等，可选）
 *   onAnnounce(msg)   → aria-live 播报（可选）
 *
 * env（测试注入）：doc / storage
 *
 * @param {Record<string, Function>} [host]
 * @param {{ doc?:Document, storage?:Storage|null }} [env]
 */
export function initReadingMode(host = {}, env = {}) {
  const doc = env.doc ?? document;
  const storage = env.storage !== undefined ? env.storage : safeLocalStorage();

  const existing = doc.querySelector(".rm-switch[data-rm]");
  if (existing && existing.__rmApi) return existing.__rmApi;

  // ---- 状态 ----
  /** @type {"full"|"focus"} */
  let mode = readReadingMode(storage);
  /** 用户展开过的摘要段（段 key 集合）。切模式不清——切回来展开态还在 */
  const expandedKeys = new Set();
  /** @type {Element|null} */
  let lastBackBar = null;
  /** @type {Element|null} */
  let lastConversation = null;

  // ---- 分段开关（radio 语义）----
  const switchEl = doc.createElement("div");
  switchEl.className = "rm-switch";
  switchEl.dataset.rm = "1";
  switchEl.setAttribute("role", "radiogroup");
  switchEl.setAttribute("aria-label", READING_MODE_COPY.groupLabel);
  switchEl.hidden = true;

  /** @type {HTMLButtonElement[]} */
  const modeButtons = [];
  for (const value of ["focus", "full"]) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "rm-switch-btn";
    btn.dataset.mode = value;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", "false");
    btn.textContent = READING_MODE_COPY[value].label;
    btn.title = READING_MODE_COPY[value].hint;
    btn.addEventListener("click", () => setMode(value));
    switchEl.appendChild(btn);
    modeButtons.push(btn);
  }

  function syncSwitch() {
    for (const btn of modeButtons) {
      btn.setAttribute("aria-checked", String(btn.dataset.mode === mode));
    }
  }

  // ---- 后处理 ----

  /** 撤掉上一轮的 all 处理：摘要行删除、隐藏类与单元打标摘掉。幂等。 */
  function clearProcessed(container) {
    for (const el of container.querySelectorAll(`.${HIDDEN_CLASS}`)) {
      el.classList.remove(HIDDEN_CLASS);
    }
    for (const el of container.querySelectorAll("[data-rm-unit-of]")) {
      el.removeAttribute("data-rm-unit-of");
    }
    for (const el of container.querySelectorAll(`.${SUMMARY_CLASS}`)) {
      el.remove();
    }
  }

  /**
   * chat-item 节点 → 稳定 key。优先用 patchList 的键控表（__patchNodes），
   * 测试/直拼 DOM 没有这张表时退化为位置序号（同一轮重算内仍自洽）。
   */
  function itemKeyMap(container) {
    /** @type {Map<Element, string>} */
    const map = new Map();
    const nodes = container.__patchNodes;
    if (nodes instanceof Map) {
      for (const [key, node] of nodes) {
        if (node instanceof Element) map.set(node, String(key));
      }
    }
    return map;
  }

  /**
   * 对话容器 → 单元序列（chat-item 的直接子元素逐个分类）。
   * @returns {{ units:(ReadingUnit & { el:Element, item:Element })[] }}
   */
  function collectUnits(container) {
    const keyOf = itemKeyMap(container);
    const units = [];
    const items = [...container.children].filter((c) => c.classList?.contains("chat-item"));
    items.forEach((item, itemIdx) => {
      const base = keyOf.get(item) ?? `idx:${itemIdx}`;
      [...item.children].forEach((el, childIdx) => {
        const kind = classifyUnit(el);
        units.push({
          el,
          item,
          kind,
          key: `${base}#${childIdx}`,
          durationMs: kind === "tool" ? parseToolDuration(el) : 0,
        });
      });
    });
    return { units };
  }

  function buildSummaryButton(seg) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = SUMMARY_CLASS;
    btn.dataset.rmSeg = seg.key;
    const expanded = expandedKeys.has(seg.key);
    btn.setAttribute("aria-expanded", String(expanded));
    btn.title = expanded ? READING_MODE_COPY.collapseTitle : READING_MODE_COPY.expandTitle;
    const icon = doc.createElement("i");
    icon.className = `ph ${expanded ? "ph-caret-down" : "ph-caret-right"}`;
    icon.setAttribute("aria-hidden", "true");
    const text = doc.createElement("span");
    text.textContent = summaryText(seg);
    btn.appendChild(icon);
    btn.appendChild(text);
    btn.addEventListener("click", () => toggleSegment(seg.key, btn));
    return btn;
  }

  /** 展开/收起一段。只翻 DOM 与 expandedKeys，不重算——点击反馈即时 */
  function toggleSegment(segKey, btn) {
    const expand = !expandedKeys.has(segKey);
    if (expand) expandedKeys.add(segKey);
    else expandedKeys.delete(segKey);
    const container = btn.parentElement;
    if (container) {
      for (const el of container.querySelectorAll(`[data-rm-unit-of="${cssEscapeAttr(segKey)}"]`)) {
        el.classList.toggle(HIDDEN_CLASS, !expand);
      }
      syncWrappers(container);
    }
    btn.setAttribute("aria-expanded", String(expand));
    btn.title = expand ? READING_MODE_COPY.collapseTitle : READING_MODE_COPY.expandTitle;
    const icon = btn.querySelector("i");
    if (icon) icon.className = `ph ${expand ? "ph-caret-down" : "ph-caret-right"}`;
  }

  /**
   * 空壳回收：chat-item 的子元素全被藏掉时，把壳本身也藏了。
   * .conversation 是 flex + gap——只藏内容的话空壳仍占一个 gap 槽位，
   * 聚焦模式反而不比完整模式矮（实测 +338px 的元凶）。
   */
  function syncWrappers(container) {
    for (const item of container.querySelectorAll(".chat-item")) {
      const children = [...item.children];
      const allHidden = children.length > 0 && children.every((c) => c.classList.contains(HIDDEN_CLASS));
      item.classList.toggle(HIDDEN_CLASS, allHidden);
    }
  }

  /**
   * 聚焦模式主流程：全量重算（每次渲染后都跑一遍，天然幂等）。
   * 摘要行插在段后第一个锚点 chat-item 之前；尾段贴在对话末尾。
   */
  function applyFocus(container) {
    const { units } = collectUnits(container);
    if (units.length === 0) return;
    const segments = clusterUnits(units);
    // 重算期间保住键盘焦点：焦点在旧摘要行上时，按段 key 找新行接回
    const focusedSeg =
      doc.activeElement instanceof Element && doc.activeElement.classList?.contains(SUMMARY_CLASS)
        ? doc.activeElement.dataset.rmSeg
        : null;

    // 段归属用下标区间算最清楚：anchor 段消耗一个单元，summary 段吃掉连续过程单元
    let segIdx = 0;
    let cursor = 0; // units 下标
    /** @type {HTMLButtonElement|null} */
    let focusRestore = null;
    while (segIdx < segments.length) {
      const seg = segments[segIdx];
      if (seg.type === "anchor") {
        cursor += 1; // 锚点单元与 segments 一一对应
        segIdx += 1;
        continue;
      }
      // summary 段：吃掉连续的过程单元
      const start = cursor;
      while (cursor < units.length && units[cursor].kind !== "anchor") cursor += 1;
      const members = units.slice(start, cursor);
      const expanded = expandedKeys.has(seg.key);
      for (const u of members) {
        u.el.dataset.rmUnitOf = seg.key;
        u.el.classList.toggle(HIDDEN_CLASS, !expanded);
      }
      if (members.length > 0) {
        const btn = buildSummaryButton(seg);
        // 插到段后第一个锚点 chat-item 之前；段在末尾则追加到对话尾
        const nextAnchor = units[cursor] ?? null;
        const refNode = nextAnchor ? nextAnchor.item : null;
        container.insertBefore(btn, refNode);
        if (focusedSeg && focusedSeg === seg.key) focusRestore = btn;
      }
      segIdx += 1;
    }
    syncWrappers(container);
    if (focusRestore) focusRestore.focus({ preventScroll: true });
  }

  /** @param {Element|null} container */
  function apply(container) {
    if (!container) return;
    clearProcessed(container);
    if (mode === "focus") applyFocus(container);
  }

  /**
   * 切模式。persist 默认 true（用户显式选择）；设置中心改动走同一入口。
   * @param {string} next
   */
  function setMode(next) {
    const normalized = next === "focus" ? "focus" : "full";
    if (normalized === mode) {
      syncSwitch();
      return;
    }
    mode = writeReadingMode(storage, normalized);
    syncSwitch();
    apply(lastConversation);
    host.onModeChange?.(mode);
    host.onAnnounce?.(
      mode === "focus" ? "已切到聚焦模式：过程收成摘要行" : "已切到完整模式：过程全部展开",
    );
  }

  // ---- 对外 API ----
  const api = {
    element: switchEl,
    /**
     * 宿主每次渲染对话详情后调用（与 changes-panel.mount 同一时机）。
     * backBar 为 null（列表视图）时开关随旧骨架消失，这里只记状态。
     * @param {Element|null} backBar
     * @param {Element|null} conversation
     */
    update(backBar, conversation) {
      lastBackBar = backBar ?? null;
      lastConversation = conversation ?? null;
      if (backBar && switchEl.parentElement !== backBar) backBar.appendChild(switchEl);
      // 空对话 / 加载中不渲染开关
      const hasContent = Boolean(conversation?.querySelector?.(".chat-item"));
      switchEl.hidden = !hasContent;
      syncSwitch();
      apply(conversation);
    },
    /** 设置中心改了偏好后来这里对齐（同源键，外部写入） */
    syncFromStorage() {
      mode = readReadingMode(storage);
      syncSwitch();
      apply(lastConversation);
    },
    setMode,
    getMode: () => mode,
    /** 测试与诊断用 */
    getExpandedKeys: () => [...expandedKeys],
  };
  switchEl.__rmApi = api;
  syncSwitch();
  return api;
}

/** querySelector 属性选择器里的引号/反斜杠转义（段 key 含 ":" 与 "#" 是安全的） */
function cssEscapeAttr(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

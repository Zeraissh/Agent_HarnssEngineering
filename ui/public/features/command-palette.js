/**
 * features/command-palette — 命令面板（Ctrl+K / Cmd+K）。
 *
 * 零依赖原生 ESM。分两层：
 *   1) 纯函数层（模糊评分 / 过滤 / 分组 / 导航状态机 / 派发）——可单测；
 *   2) DOM 层（initCommandPalette）——遮罩、listbox、焦点陷阱、键盘交互。
 *
 * 宿主（index.html 内联控制器）通过 initCommandPalette(host) 注入回调，
 * 本模块不反向 import 宿主任何东西，保持单向依赖。
 */

// ---------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------

/**
 * 子序列模糊评分。query 的每个字符按顺序出现在 text 中即匹配；
 * 分数越高越相关：连续命中、词边界命中、前缀命中加权，长文本轻罚。
 * @param {string} query
 * @param {string} text
 * @returns {number|null} 不匹配返回 null
 */
export function fuzzyScore(query, text) {
  const q = String(query ?? "").trim().toLowerCase();
  const t = String(text ?? "").toLowerCase();
  if (!q) return 0;
  if (!t) return null;
  let qi = 0;
  let score = 0;
  let streak = 0;
  let prevAt = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    // 连续命中递增奖励
    streak = ti === prevAt + 1 ? streak + 1 : 0;
    score += 1 + streak * 2;
    // 词边界（开头 / 跟在分隔符后）奖励
    if (ti === 0 || /[\s\-_./\\]/.test(t[ti - 1])) score += 3;
    prevAt = ti;
    qi++;
  }
  if (qi < q.length) return null;
  // 前缀整体命中再加一笔；长文本轻微衰减，避免长路径压过短标题
  if (t.startsWith(q)) score += 5;
  score -= Math.min(t.length - q.length, 40) * 0.05;
  return score;
}

/** @typedef {{ id:string, label:string, hint?:string, icon?:string, kbd?:string, themeId?:string, current?:boolean }} CommandSpec */
/** @typedef {{ runId:string, title:string, workdir?:string|null, status?:string }} ConversationSpec */
/** @typedef {{ kind:string, group:"command"|"conversation", id:string, label:string, hint?:string, icon?:string, kbd?:string, themeId?:string, current?:boolean, runId?:string }} PaletteItem */

/**
 * 静态命令清单。run 状态决定"停止/继续"哪一条在场。
 * @param {{ currentRunId?: string|null, currentRunStatus?: string|null, currentTheme?: string }} ctx
 * @returns {CommandSpec[]}
 */
export function staticCommands(ctx = {}) {
  const { currentRunId = null, currentRunStatus = null, currentTheme = "auto" } = ctx;
  const commands = [
    { id: "new-chat", label: "新建对话", hint: "清空输入，开始新任务", icon: "ph-plus", kbd: "" },
  ];
  if (currentRunId && currentRunStatus === "running") {
    commands.push({ id: "stop-run", label: "停止当前运行", hint: "向当前对话发送停止指令", icon: "ph-stop" });
  } else if (currentRunId) {
    commands.push({ id: "continue-run", label: "继续当前对话", hint: "聚焦输入框，追加指令", icon: "ph-chat-centered-dots" });
  }
  commands.push(
    { id: "focus-search", label: "搜索对话", hint: "跳到侧栏搜索框", icon: "ph-magnifying-glass" },
    { id: "help", label: "快捷键帮助", hint: "查看全部快捷键", icon: "ph-keyboard", kbd: "?" },
  );
  const themes = [
    ["auto", "跟随系统"],
    ["light", "暖纸"],
    ["dark", "暖炭"],
    ["graphite", "石墨"],
    ["contrast", "高对比"],
  ];
  for (const [themeId, name] of themes) {
    commands.push({
      id: `theme-${themeId}`,
      label: `主题：${name}`,
      hint: themeId === currentTheme ? "当前主题" : "切换配色",
      icon: "ph-palette",
      themeId,
      current: themeId === currentTheme,
    });
  }
  return commands;
}

/**
 * 过滤静态命令：空查询全量返回；否则对 label + hint 取最高分子序列匹配，按分排序。
 * @param {string} query
 * @param {CommandSpec[]} commands
 * @returns {CommandSpec[]}
 */
export function matchCommands(query, commands) {
  const q = String(query ?? "").trim();
  if (!q) return [...commands];
  const scored = [];
  for (const cmd of commands) {
    const a = fuzzyScore(q, cmd.label);
    const b = cmd.hint ? fuzzyScore(q, cmd.hint) : null;
    const s = Math.max(a ?? -Infinity, b ?? -Infinity);
    if (s === -Infinity) continue;
    scored.push({ cmd, s });
  }
  scored.sort((x, y) => y.s - x.s);
  return scored.map((r) => r.cmd);
}

/**
 * 动态会话匹配：标题 / 工作目录任一命中即入选，标题命中优先。
 * @param {string} query
 * @param {ConversationSpec[]} conversations
 * @param {{ limit?: number }} [opts]
 * @returns {(ConversationSpec & { score:number })[]}
 */
export function matchConversations(query, conversations, opts = {}) {
  const q = String(query ?? "").trim();
  const limit = opts.limit ?? 8;
  if (!q) return [];
  const scored = [];
  for (const c of conversations) {
    const titleScore = fuzzyScore(q, c.title);
    const dirScore = c.workdir ? fuzzyScore(q, c.workdir) : null;
    const s = Math.max(titleScore ?? -Infinity, dirScore !== null ? (dirScore ?? -Infinity) - 1 : -Infinity);
    if (s === -Infinity) continue;
    scored.push({ ...c, score: s });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, limit);
}

/**
 * 组装面板条目（分组扁平列表，命令在前、对话在后）。
 * @param {{ query:string, commands:CommandSpec[], conversations:ConversationSpec[] }} input
 * @returns {{ items:PaletteItem[], groups:{ key:string, label:string, count:number }[] }}
 */
export function buildPaletteItems({ query, commands, conversations }) {
  /** @type {PaletteItem[]} */
  const items = [];
  for (const cmd of matchCommands(query, commands)) {
    items.push({
      kind: cmd.id.startsWith("theme-") ? "theme" : cmd.id,
      group: "command",
      id: `cmd:${cmd.id}`,
      label: cmd.label,
      hint: cmd.hint,
      icon: cmd.icon,
      kbd: cmd.kbd,
      themeId: cmd.themeId,
      current: cmd.current,
    });
  }
  for (const c of matchConversations(query, conversations)) {
    items.push({
      kind: "conversation",
      group: "conversation",
      id: `conv:${c.runId}`,
      label: c.title || "（无标题）",
      hint: c.workdir || undefined,
      icon: "ph-chat-centered-text",
      runId: c.runId,
    });
  }
  const cmdCount = items.filter((i) => i.group === "command").length;
  const convCount = items.length - cmdCount;
  const groups = [];
  if (cmdCount) groups.push({ key: "command", label: "命令", count: cmdCount });
  if (convCount) groups.push({ key: "conversation", label: "对话", count: convCount });
  return { items, groups };
}

// ---------------------------------------------------------------
// 外部命令注册（T5 起）：其他 features 模块的最小接入 API
// ---------------------------------------------------------------

/**
 * 已注册的外部命令。模块级注册表：initCommandPalette 幂等且全局唯一，
 * 命令跟着面板实例走而不是跟着某次 init 调用走。
 * @type {Map<string, CommandSpec & { run?: () => void }>}
 */
const externalCommands = new Map();

/** 内置命令占用的 id / 前缀，外部注册不得撞名（撞了行为不可预期） */
const RESERVED_COMMAND_IDS = new Set(["new-chat", "stop-run", "continue-run", "focus-search", "help"]);

/**
 * 注册一条外部命令。spec.run 在执行时被调用（面板随后关闭）。
 * @param {{ id:string, label:string, hint?:string, icon?:string, kbd?:string, run?:() => void }} spec
 * @returns {() => void} 注销函数（测试隔离用）
 */
export function registerPaletteCommand(spec) {
  const id = String(spec?.id ?? "");
  const label = String(spec?.label ?? "");
  if (!id || !label) throw new Error("registerPaletteCommand: id 与 label 必填");
  if (RESERVED_COMMAND_IDS.has(id) || id.startsWith("theme-")) {
    throw new Error(`registerPaletteCommand: "${id}" 与内置命令撞名`);
  }
  externalCommands.set(id, { id, label, hint: spec.hint, icon: spec.icon, kbd: spec.kbd, run: spec.run });
  return () => { externalCommands.delete(id); };
}

/** 当前已注册的外部命令快照（currentItems 与测试共用）。 */
export function listExternalCommands() {
  return [...externalCommands.values()];
}


/**
 * 键盘导航状态机：环形移动激活下标。
 * @param {number} current
 * @param {number} delta +1 / -1
 * @param {number} count
 * @returns {number}
 */
export function moveActiveIndex(current, delta, count) {
  if (count <= 0) return -1;
  const base = current < 0 ? (delta > 0 ? -1 : 0) : current;
  return (base + delta + count) % count;
}

/** 列表变化后钳位激活下标。 */
export function clampActiveIndex(current, count) {
  if (count <= 0) return -1;
  if (current < 0) return 0;
  return Math.min(current, count - 1);
}

/**
 * 条目执行派发。返回 true 表示已消费（调用方随后关闭面板）。
 * @param {PaletteItem} item
 * @param {Record<string, Function>} host
 * @returns {boolean}
 */
export function executeItem(item, host) {
  if (!item || !host) return false;
  switch (item.kind) {
    case "conversation":
      if (item.runId && typeof host.onOpenConversation === "function") host.onOpenConversation(item.runId);
      return true;
    case "new-chat":
      host.onNewChat?.();
      return true;
    case "stop-run":
      host.onStopRun?.();
      return true;
    case "continue-run":
      host.onContinueRun?.();
      return true;
    case "focus-search":
      host.onFocusSearch?.();
      return true;
    case "theme":
      if (item.themeId) host.onSelectTheme?.(item.themeId);
      return true;
    case "help":
      host.onToggleHelp?.();
      return false; // 帮助浮层在面板内展开，不关面板
    default: {
      // 外部注册命令（registerPaletteCommand）：kind 即注册 id
      const ext = externalCommands.get(item.kind);
      if (ext) {
        ext.run?.();
        return true;
      }
      return false;
    }
  }
}

/** 快捷键 cheatsheet 内容（帮助浮层与测试共用同一份数据）。 */
export const SHORTCUTS = [
  { keys: "Ctrl / ⌘ + K", desc: "打开命令面板" },
  { keys: "Ctrl / ⌘ + Enter", desc: "发送任务 / 追加指令" },
  { keys: "↑ ↓", desc: "在面板内移动选择" },
  { keys: "Enter", desc: "执行选中项" },
  { keys: "Esc", desc: "关闭面板 / 菜单" },
];

// ---------------------------------------------------------------
// DOM 层
// ---------------------------------------------------------------

const PALETTE_ID = "command-palette";

/**
 * 初始化命令面板。幂等：重复调用直接返回既有实例。
 * @param {{
 *   getConversations?: () => ConversationSpec[],
 *   getCurrentRun?: () => { runId:string, status:string } | null,
 *   getTheme?: () => string,
 *   onOpenConversation?: (runId:string) => void,
 *   onNewChat?: () => void,
 *   onStopRun?: () => void,
 *   onContinueRun?: () => void,
 *   onFocusSearch?: () => void,
 *   onSelectTheme?: (theme:string) => void,
 *   onAnnounce?: (msg:string) => void,
 * }} host
 * @param {{ doc?: Document, win?: Window }} [env] 测试注入用
 */
export function initCommandPalette(host = {}, env = {}) {
  const doc = env.doc ?? document;
  const existing = doc.getElementById(PALETTE_ID);
  if (existing) {
    // 幂等：重复初始化只返回既有节点的薄壳，不重复绑事件
    return {
      open: () => { existing.hidden = false; },
      close: () => { existing.hidden = true; },
      isOpen: () => !existing.hidden,
      element: /** @type {HTMLElement} */ (existing),
    };
  }

  // ---- 骨架 ----
  const overlay = doc.createElement("div");
  overlay.id = PALETTE_ID;
  overlay.className = "palette-overlay";
  overlay.hidden = true;

  const dialog = doc.createElement("div");
  dialog.className = "palette-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "命令面板");

  const inputRow = doc.createElement("div");
  inputRow.className = "palette-input-row";
  inputRow.innerHTML = '<i class="ph ph-magnifying-glass" aria-hidden="true"></i>';
  const input = doc.createElement("input");
  input.type = "text";
  input.className = "palette-input";
  input.placeholder = "输入命令或搜索对话…";
  input.setAttribute("aria-label", "命令面板搜索");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-controls", `${PALETTE_ID}-list`);
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("autocomplete", "off");
  inputRow.appendChild(input);
  const closeBtn = doc.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "palette-close icon-btn";
  closeBtn.setAttribute("aria-label", "关闭命令面板");
  closeBtn.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i>';
  inputRow.appendChild(closeBtn);

  const list = doc.createElement("ul");
  list.className = "palette-list";
  list.id = `${PALETTE_ID}-list`;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "命令与对话");

  const empty = doc.createElement("div");
  empty.className = "palette-empty";
  empty.textContent = "没有匹配的命令或对话";
  empty.hidden = true;

  const help = doc.createElement("div");
  help.className = "palette-help";
  help.hidden = true;
  const helpTitle = doc.createElement("h3");
  helpTitle.className = "palette-help-title";
  helpTitle.textContent = "快捷键";
  help.appendChild(helpTitle);
  const helpList = doc.createElement("dl");
  helpList.className = "palette-help-list";
  for (const s of SHORTCUTS) {
    const dt = doc.createElement("dt");
    const kbd = doc.createElement("kbd");
    kbd.className = "palette-kbd";
    kbd.textContent = s.keys;
    dt.appendChild(kbd);
    const dd = doc.createElement("dd");
    dd.textContent = s.desc;
    helpList.appendChild(dt);
    helpList.appendChild(dd);
  }
  help.appendChild(helpList);

  const footer = doc.createElement("div");
  footer.className = "palette-footer";
  footer.innerHTML =
    '<span class="palette-footer-hint"><kbd class="palette-kbd">↑↓</kbd> 选择</span>' +
    '<span class="palette-footer-hint"><kbd class="palette-kbd">Enter</kbd> 执行</span>' +
    '<span class="palette-footer-hint"><kbd class="palette-kbd">Esc</kbd> 关闭</span>';

  dialog.appendChild(inputRow);
  dialog.appendChild(list);
  dialog.appendChild(empty);
  dialog.appendChild(help);
  dialog.appendChild(footer);
  overlay.appendChild(dialog);
  doc.body.appendChild(overlay);

  // ---- 状态 ----
  let open = false;
  let helpOpen = false;
  /** @type {PaletteItem[]} */
  let items = [];
  let active = -1;
  /** @type {HTMLElement|null} */
  let restoreFocusTo = null;

  function currentItems() {
    const currentRun = host.getCurrentRun?.() ?? null;
    const commands = [
      ...staticCommands({
        currentRunId: currentRun?.runId ?? null,
        currentRunStatus: currentRun?.status ?? null,
        currentTheme: host.getTheme?.() ?? "auto",
      }),
      ...listExternalCommands(),
    ];
    const conversations = host.getConversations?.() ?? [];
    return buildPaletteItems({ query: input.value, commands, conversations }).items;
  }

  function render() {
    items = currentItems();
    active = clampActiveIndex(items.length ? active : -1, items.length);
    if (active < 0 && items.length) active = 0;
    list.innerHTML = "";
    let lastGroup = null;
    items.forEach((item, idx) => {
      if (item.group !== lastGroup) {
        lastGroup = item.group;
        const head = doc.createElement("li");
        head.className = "palette-group";
        head.setAttribute("role", "presentation");
        head.textContent = item.group === "command" ? "命令" : "对话";
        list.appendChild(head);
      }
      const li = doc.createElement("li");
      li.className = "palette-item";
      li.id = `${PALETTE_ID}-opt-${idx}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(idx === active));
      if (idx === active) li.classList.add("palette-item--active");
      const icon = doc.createElement("i");
      icon.className = `ph ${item.icon ?? "ph-dot-outline"}`;
      icon.setAttribute("aria-hidden", "true");
      li.appendChild(icon);
      const copy = doc.createElement("span");
      copy.className = "palette-item-copy";
      const label = doc.createElement("span");
      label.className = "palette-item-label";
      label.textContent = item.label;
      copy.appendChild(label);
      if (item.hint) {
        const hint = doc.createElement("span");
        hint.className = "palette-item-hint";
        hint.textContent = item.hint;
        copy.appendChild(hint);
      }
      li.appendChild(copy);
      if (item.current) {
        const mark = doc.createElement("i");
        mark.className = "ph ph-check palette-item-current";
        mark.setAttribute("aria-hidden", "true");
        li.appendChild(mark);
      }
      if (item.kbd) {
        const kbd = doc.createElement("kbd");
        kbd.className = "palette-kbd";
        kbd.textContent = item.kbd;
        li.appendChild(kbd);
      }
      li.addEventListener("pointerenter", () => setActive(idx));
      li.addEventListener("click", () => runItem(idx));
      list.appendChild(li);
    });
    empty.hidden = items.length > 0;
    list.hidden = items.length === 0;
    syncActiveDescendant();
  }

  function syncActiveDescendant() {
    if (active >= 0 && items[active]) {
      input.setAttribute("aria-activedescendant", `${PALETTE_ID}-opt-${active}`);
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function setActive(idx) {
    if (idx === active) return;
    active = clampActiveIndex(idx, items.length);
    const options = list.querySelectorAll(".palette-item");
    options.forEach((el, i) => {
      el.classList.toggle("palette-item--active", i === active);
      el.setAttribute("aria-selected", String(i === active));
    });
    syncActiveDescendant();
    const el = options[active];
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }

  function runItem(idx) {
    const item = items[idx];
    if (!item) return;
    const consumed = executeItem(item, {
      ...host,
      onToggleHelp: () => toggleHelp(),
    });
    if (consumed) closePalette();
  }

  function toggleHelp() {
    helpOpen = !helpOpen;
    help.hidden = !helpOpen;
    list.hidden = helpOpen || items.length === 0;
    footer.hidden = helpOpen;
    if (helpOpen) host.onAnnounce?.("快捷键帮助已展开");
  }

  function openPalette() {
    if (open) return;
    open = true;
    restoreFocusTo = /** @type {HTMLElement|null} */ (doc.activeElement);
    overlay.hidden = false;
    input.value = "";
    active = -1;
    helpOpen = false;
    help.hidden = true;
    footer.hidden = false;
    render();
    input.focus();
    host.onAnnounce?.("命令面板已打开");
  }

  function closePalette() {
    if (!open) return;
    open = false;
    overlay.hidden = true;
    if (restoreFocusTo && typeof restoreFocusTo.focus === "function") {
      restoreFocusTo.focus();
    }
    restoreFocusTo = null;
  }

  // ---- 事件 ----
  input.addEventListener("input", () => {
    active = -1;
    render();
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (helpOpen) return;
      setActive(moveActiveIndex(active, event.key === "ArrowDown" ? 1 : -1, items.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!helpOpen) runItem(active);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (helpOpen) toggleHelp();
      else closePalette();
    }
  });

  closeBtn.addEventListener("click", () => closePalette());
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) closePalette();
  });

  // 焦点陷阱：面板打开期间 Tab 只在输入框与关闭按钮之间循环
  overlay.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const focusables = [input, closeBtn];
    const at = focusables.indexOf(/** @type {HTMLElement} */ (doc.activeElement));
    event.preventDefault();
    const step = event.shiftKey ? -1 : 1;
    const next = focusables[(at + step + focusables.length) % focusables.length];
    next.focus();
  });

  // 全局唤起：Ctrl/Cmd+K，输入框聚焦时同样生效
  doc.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && (event.key === "k" || event.key === "K")) {
      event.preventDefault();
      if (open) closePalette();
      else openPalette();
    }
  });

  // 侧栏入口按钮（宿主在骨架里放了 #palette-open-btn 才有）
  const openBtn = doc.getElementById("palette-open-btn");
  if (openBtn) {
    openBtn.addEventListener("click", () => openPalette());
  }

  const api = { open: openPalette, close: closePalette, isOpen: () => open, element: overlay };
  return api;
}

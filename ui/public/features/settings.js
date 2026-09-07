/**
 * features/settings — 设置中心（T7）。
 *
 * 零依赖原生 ESM。独立视图（hash 路由 #/settings），分五组：
 *   外观 / 运行默认值 / 通知 / 快捷键 / 关于。
 *
 * 与 command-palette / notifications / memory-panel 同一约定：
 *   1) 纯函数层（设置读写 / 容错解析 / 旧键迁移 / composer 默认值派生 /
 *      路由判定）——可单测；
 *   2) DOM 层 initSettingsView(host, env)——宿主（index.html 内联控制器）
 *      注入回调，本模块不反向 import 宿主任何东西。
 *
 * 同源纪律（不设第二份状态）：
 *   - 主题：读写走宿主注入的 getTheme / onSelectTheme（即 index.html 的
 *     applyTheme/currentTheme，持久化键 agent-ui-theme 只有那一处写）；
 *   - 系统通知授权：状态读 Notification.permission，授权结果经
 *     notifications.js 的 persistPromptChoice 落同一个 agent-ui-notify-prompt；
 *   - 自动放行默认值：agent-ui-settings 为准，旧键 agent-ui-auto-approve
 *     由 migrateLegacyPrefs 一次性迁入，两处写入方（本模块与 composer 开关）
 *     都同时写两个键，不会漂；
 *   - 快捷键表：直接复用 command-palette.js 的 SHORTCUTS（帮助浮层同一份数据）。
 */

import { SHORTCUTS } from "./command-palette.js";
import { persistPromptChoice } from "./notifications.js";
import {
  READING_MODE_COPY,
  readReadingMode,
  writeReadingMode,
} from "./reading-mode.js";

// ---------------------------------------------------------------
// 常量
// ---------------------------------------------------------------

export const SETTINGS_STORAGE_KEY = "agent-ui-settings";
export const SETTINGS_SCHEMA_VERSION = 1;
/** 旧版自动放行偏好键（composer 既有），启动时一次性迁入 settings */
export const LEGACY_AUTO_APPROVE_KEY = "agent-ui-auto-approve";
/** /api/harness 快照没有版本字段时的兜底（与 package.json 对齐） */
export const FALLBACK_VERSION = "1.3.0";
export const PROJECT_NAME = "Agent Harness";
/** 路由：设置视图占用的唯一 hash */
export const SETTINGS_HASH = "#/settings";

/** 主题选项。label/hint/icon 与侧栏主题菜单逐字对齐，避免两处文案漂移。 */
export const THEME_CHOICES = [
  { id: "auto", label: "跟随系统", hint: "自动匹配设备", icon: "ph-circle-half" },
  { id: "light", label: "暖纸", hint: "低眩光浅色", icon: "ph-sun" },
  { id: "dark", label: "暖炭", hint: "温暖深色", icon: "ph-moon" },
  { id: "graphite", label: "石墨", hint: "中性深色", icon: "ph-stack" },
  { id: "contrast", label: "高对比", hint: "更强文字与边界", icon: "ph-circle-half-tilt" },
];

/** 分组锚点导航。id 即视图内 section 的 id。 */
export const SETTINGS_SECTIONS = [
  { id: "settings-appearance", label: "外观", icon: "ph-palette" },
  { id: "settings-defaults", label: "运行默认值", icon: "ph-sliders-horizontal" },
  { id: "settings-notifications", label: "通知", icon: "ph-bell" },
  { id: "settings-shortcuts", label: "快捷键", icon: "ph-keyboard" },
  { id: "settings-about", label: "关于", icon: "ph-info" },
];

const EFFORT_LABELS = { low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高" };

/**
 * @typedef {{
 *   version:number,
 *   defaults:{ effort:string, verify:boolean, autoApprove:boolean },
 *   badge:boolean,
 * }} UiSettings
 */

// ---------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------

/** @returns {UiSettings} */
export function defaultSettings() {
  return {
    version: SETTINGS_SCHEMA_VERSION,
    defaults: { effort: "", verify: false, autoApprove: true },
    badge: true,
  };
}

/**
 * 容错解析。坏 JSON / 非对象 / schema 版本不符 → null（调用方回默认）；
 * 字段逐个校验，类型不对的字段回默认，不拖垮其余字段。
 * @param {string|null|undefined} raw
 * @returns {UiSettings|null}
 */
export function parseSettings(raw) {
  if (!raw) return null;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  if (obj.version !== SETTINGS_SCHEMA_VERSION) return null;
  const base = defaultSettings();
  const d = obj.defaults && typeof obj.defaults === "object" ? obj.defaults : {};
  if (typeof d.effort === "string") base.defaults.effort = d.effort;
  if (typeof d.verify === "boolean") base.defaults.verify = d.verify;
  if (typeof d.autoApprove === "boolean") base.defaults.autoApprove = d.autoApprove;
  if (typeof obj.badge === "boolean") base.badge = obj.badge;
  return base;
}

/**
 * 读设置。storage 不可用 / 无记录 / 内容损坏 → 默认设置。
 * @param {Storage|null} storage
 * @returns {UiSettings}
 */
export function loadSettings(storage) {
  if (!storage) return defaultSettings();
  try {
    return parseSettings(storage.getItem(SETTINGS_STORAGE_KEY)) ?? defaultSettings();
  } catch {
    return defaultSettings();
  }
}

/**
 * 写设置。隐私模式写入失败时静默降级（返回 false），本次会话内的内存态仍生效。
 * @param {Storage|null} storage
 * @param {UiSettings} settings
 * @returns {boolean} 是否真正落盘
 */
export function saveSettings(storage, settings) {
  if (!storage) return false;
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/**
 * 不可变更新。patch.defaults 与现有 defaults 浅合并，其余键浅合并。
 * @param {UiSettings} settings
 * @param {{ defaults?:Partial<UiSettings["defaults"]>, badge?:boolean }} patch
 * @returns {UiSettings}
 */
export function updateSettings(settings, patch) {
  return {
    ...settings,
    ...(typeof patch.badge === "boolean" ? { badge: patch.badge } : {}),
    defaults: { ...settings.defaults, ...(patch.defaults ?? {}) },
  };
}

/**
 * 旧键一次性迁移：settings 里还没有显式的 autoApprove 时，用旧键
 * （agent-ui-auto-approve）的值播种并落盘。settings 已显式记录过就以它为准。
 * @param {Storage|null} storage
 * @param {UiSettings} settings loadSettings 的结果
 * @returns {{ settings:UiSettings, migrated:boolean }}
 */
export function migrateLegacyPrefs(storage, settings) {
  if (!storage) return { settings, migrated: false };
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (typeof parsed?.defaults?.autoApprove === "boolean") {
      return { settings, migrated: false };
    }
    const legacy = storage.getItem(LEGACY_AUTO_APPROVE_KEY);
    if (legacy !== "0" && legacy !== "1") return { settings, migrated: false };
    const next = updateSettings(settings, {
      defaults: { autoApprove: legacy === "1" },
    });
    saveSettings(storage, next);
    return { settings: next, migrated: true };
  } catch {
    return { settings, migrated: false };
  }
}

/**
 * composer 默认值派生。这就是"运行默认值"分组与 composer 的同源点：
 * composer 启动时与本视图读写同一份 settings。
 * @param {UiSettings} settings
 * @returns {{ effort:string, verify:boolean, autoApprove:boolean }}
 */
export function composerDefaults(settings) {
  return {
    effort: settings?.defaults?.effort ?? "",
    verify: Boolean(settings?.defaults?.verify),
    autoApprove: settings?.defaults?.autoApprove !== false,
  };
}

/**
 * 思考强度校验：""（跟随服务端默认）或落在服务端声明的档位集合里。
 * levels 为空数组/缺省时只放行 ""——前端不硬编码档位。
 * @param {string} effort
 * @param {string[]|null|undefined} levels
 * @returns {boolean}
 */
export function isValidEffort(effort, levels) {
  if (effort === "") return true;
  return Array.isArray(levels) && levels.includes(effort);
}

/**
 * 把默认值应用到 composer 控件。DOM 触碰集中在这一处，jsdom 可测。
 *
 * 语义：effort 为 "" 表示「跟随服务端默认」——不动 select（populateKnobs
 * 已经把它放到服务端默认档）；非空且是合法档位才覆盖。verify / autoApprove
 * 直接写 checked。只应用 patch 里出现的键，没出现的不动——
 * 用户在 composer 里的当次改动不会被设置页无关项覆盖。
 *
 * @param {{ verifyToggle?:HTMLInputElement|null, autoApproveToggle?:HTMLInputElement|null,
 *           effortSelect?:HTMLSelectElement|null }} controls
 * @param {{ effort?:string, verify?:boolean, autoApprove?:boolean }} patch
 * @param {{ effortLevels?:string[]|null }} [opts]
 * @returns {{ effort:boolean, verify:boolean, autoApprove:boolean }} 各项是否真应用了
 */
export function applyComposerDefaults(controls, patch, opts = {}) {
  const applied = { effort: false, verify: false, autoApprove: false };
  if (!controls || !patch) return applied;
  if (typeof patch.verify === "boolean" && controls.verifyToggle) {
    controls.verifyToggle.checked = patch.verify;
    applied.verify = true;
  }
  if (typeof patch.autoApprove === "boolean" && controls.autoApproveToggle) {
    controls.autoApproveToggle.checked = patch.autoApprove;
    applied.autoApprove = true;
  }
  if (typeof patch.effort === "string" && controls.effortSelect && patch.effort !== "") {
    const levels = opts.effortLevels ?? [...controls.effortSelect.options].map((o) => o.value);
    if (isValidEffort(patch.effort, levels)) {
      controls.effortSelect.value = patch.effort;
      applied.effort = true;
    }
  }
  return applied;
}

/**
 * 应用内角标开关状态。
 * @param {UiSettings} settings
 * @returns {boolean}
 */
export function badgeEnabled(settings) {
  return settings?.badge !== false;
}

/**
 * 路由判定：设置视图的唯一 hash。宿主路由（index.html applyHash）与本模块
 * 共用这一条，避免两处各写一份正则。
 * @param {string} hash location.hash
 * @returns {boolean}
 */
export function isSettingsRoute(hash) {
  return String(hash ?? "") === SETTINGS_HASH;
}

/**
 * 系统通知授权状态的中文文案。
 * @param {string|null} permission Notification.permission；不支持时传 null
 * @returns {string}
 */
export function permissionStateLabel(permission) {
  switch (permission) {
    case "granted":
      return "已授权——页面不在前台时会收到系统通知";
    case "denied":
      return "已被浏览器拒绝——需在浏览器的站点设置里手动开启";
    case "default":
      return "未决定——点击右侧按钮请求授权";
    default:
      return "当前浏览器不支持系统通知";
  }
}

/** 快捷键一览的数据源：与命令面板帮助浮层同一份 SHORTCUTS。 */
export function shortcutRows() {
  return SHORTCUTS.map((s) => ({ keys: s.keys, desc: s.desc }));
}

// ---------------------------------------------------------------
// DOM 层
// ---------------------------------------------------------------

const VIEW_ID = "settings-view";

/**
 * 初始化设置视图。幂等：重复调用返回既有节点的薄壳。
 *
 * host 回调：
 *   getTheme()                  → 当前主题 id
 *   onSelectTheme(id)           → 切换主题（宿主 applyTheme，负责持久化）
 *   getHarnessSnapshot()        → /api/harness 快照或 null（档位、版本、工作目录）
 *   onApplyComposerDefaults(p)  → 设置页改动实时同步 composer 控件
 *   onOpenSettings()            → 侧栏齿轮点击（宿主写 hash 路由）
 *   onCloseSettings()           → 返回上一视图（宿主决定 history.back 或回 "#/")
 *   onAnnounce(msg)             → aria-live 播报（可选）
 *
 * env（测试注入）：doc / win / storage / Notification
 *
 * @param {Record<string, Function>} host
 * @param {{ doc?:Document, win?:Window, storage?:Storage|null, Notification?:any }} [env]
 */
export function initSettingsView(host = {}, env = {}) {
  const doc = env.doc ?? document;
  const win = env.win ?? (doc.defaultView ?? window);
  const storage = env.storage !== undefined ? env.storage : safeStorage(win);
  const NotificationCtor =
    env.Notification !== undefined
      ? env.Notification
      : typeof Notification !== "undefined"
        ? Notification
        : null;

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
  let settings = loadSettings(storage);
  let open = false;
  /** @type {HTMLElement|null} */
  let restoreFocusTo = null;

  const persist = () => saveSettings(storage, settings);

  // ---- 骨架 ----
  const view = doc.createElement("div");
  view.id = VIEW_ID;
  view.className = "settings-view";
  view.hidden = true;

  const shell = doc.createElement("div");
  shell.className = "settings-shell";

  // 头部：返回 + 标题
  const head = doc.createElement("header");
  head.className = "settings-head";
  const backBtn = doc.createElement("button");
  backBtn.type = "button";
  backBtn.className = "btn btn--ghost settings-back";
  backBtn.innerHTML = '<i class="ph ph-arrow-left" aria-hidden="true"></i><span>返回</span>';
  backBtn.setAttribute("aria-label", "返回上一视图");
  const title = doc.createElement("h2");
  title.className = "settings-title";
  title.textContent = "设置";
  head.appendChild(backBtn);
  head.appendChild(title);

  const body = doc.createElement("div");
  body.className = "settings-body";

  // 左侧锚点导航
  const nav = doc.createElement("nav");
  nav.className = "settings-nav";
  nav.setAttribute("aria-label", "设置分组");
  const navList = doc.createElement("ul");
  navList.className = "settings-nav-list";
  nav.appendChild(navList);

  const content = doc.createElement("div");
  content.className = "settings-content";

  body.appendChild(nav);
  body.appendChild(content);
  shell.appendChild(head);
  shell.appendChild(body);
  view.appendChild(shell);
  // 挂在主区：盖住对话内容与 composer，但侧栏仍在（主题菜单、铃铛可用）
  (doc.getElementById("main-panel") ?? doc.body).appendChild(view);

  /** 分组卡片骨架：section + 标题，内容由各 build 函数填 */
  function addSection(sectionId, heading) {
    const section = doc.createElement("section");
    section.id = sectionId;
    section.className = "settings-card";
    section.setAttribute("tabindex", "-1");
    const h = doc.createElement("h3");
    h.className = "settings-card-title";
    h.textContent = heading;
    section.appendChild(h);
    content.appendChild(section);
    return section;
  }

  // ---- 分组一：外观 ----
  const appearanceSection = addSection("settings-appearance", "外观");
  const themeField = doc.createElement("fieldset");
  themeField.className = "settings-theme-grid";
  const themeLegend = doc.createElement("legend");
  themeLegend.className = "sr-only";
  themeLegend.textContent = "配色主题";
  themeField.appendChild(themeLegend);
  /** @type {HTMLInputElement[]} */
  const themeRadios = [];
  for (const t of THEME_CHOICES) {
    const label = doc.createElement("label");
    label.className = "settings-theme-option";
    const radio = doc.createElement("input");
    radio.type = "radio";
    radio.name = "settings-theme";
    radio.value = t.id;
    themeRadios.push(radio);
    const icon = doc.createElement("i");
    icon.className = `ph ${t.icon}`;
    icon.setAttribute("aria-hidden", "true");
    const copy = doc.createElement("span");
    copy.className = "settings-theme-copy";
    const name = doc.createElement("strong");
    name.textContent = t.label;
    const hint = doc.createElement("small");
    hint.textContent = t.hint;
    copy.appendChild(name);
    copy.appendChild(hint);
    label.appendChild(radio);
    label.appendChild(icon);
    label.appendChild(copy);
    themeField.appendChild(label);
  }
  appearanceSection.appendChild(themeField);

  themeField.addEventListener("change", (event) => {
    const radio = event.target;
    if (!(radio instanceof (win.HTMLInputElement ?? Object))) return;
    if (radio.name !== "settings-theme" || !radio.checked) return;
    host.onSelectTheme?.(radio.value);
    const meta = THEME_CHOICES.find((t) => t.id === radio.value);
    host.onAnnounce?.(`主题已切换：${meta?.label ?? radio.value}`);
  });

  // 对话阅读模式（T12）：与对话详情顶栏的「聚焦 / 完整」分段开关同源——
  // 读写同一个 localStorage 键（reading-mode.js 持有），两边改动互见。
  const readingField = doc.createElement("fieldset");
  readingField.className = "settings-reading-mode";
  const readingLegend = doc.createElement("legend");
  readingLegend.className = "settings-reading-mode-legend";
  readingLegend.textContent = READING_MODE_COPY.groupLabel;
  readingField.appendChild(readingLegend);
  /** @type {HTMLInputElement[]} */
  const readingRadios = [];
  for (const value of ["full", "focus"]) {
    const meta = READING_MODE_COPY[value];
    const label = doc.createElement("label");
    label.className = "settings-reading-option";
    const radio = doc.createElement("input");
    radio.type = "radio";
    radio.name = "settings-reading-mode";
    radio.value = value;
    readingRadios.push(radio);
    const copy = doc.createElement("span");
    copy.className = "settings-reading-copy";
    const name = doc.createElement("strong");
    name.textContent = meta.label;
    const hint = doc.createElement("small");
    hint.textContent = meta.hint;
    copy.appendChild(name);
    copy.appendChild(hint);
    label.appendChild(radio);
    label.appendChild(copy);
    readingField.appendChild(label);
  }
  appearanceSection.appendChild(readingField);

  readingField.addEventListener("change", (event) => {
    const radio = event.target;
    if (!(radio instanceof (win.HTMLInputElement ?? Object))) return;
    if (radio.name !== "settings-reading-mode" || !radio.checked) return;
    const mode = writeReadingMode(storage, radio.value);
    host.onReadingModeChange?.(mode);
    host.onAnnounce?.(
      mode === "focus" ? "对话将默认用聚焦模式：过程收成摘要行" : "对话将默认用完整模式：过程全部展开",
    );
  });

  // ---- 分组二：运行默认值 ----
  const defaultsSection = addSection("settings-defaults", "运行默认值");
  const defaultsNote = doc.createElement("p");
  defaultsNote.className = "settings-card-note";
  defaultsNote.textContent = "这里是新对话的出发状态；在提交栏里当次改动的开关不受影响。";
  defaultsSection.appendChild(defaultsNote);

  // 思考强度
  const effortRow = doc.createElement("div");
  effortRow.className = "settings-field";
  const effortLabel = doc.createElement("label");
  effortLabel.setAttribute("for", "settings-effort");
  effortLabel.textContent = "思考强度";
  const effortSelect = doc.createElement("select");
  effortSelect.id = "settings-effort";
  effortRow.appendChild(effortLabel);
  effortRow.appendChild(effortSelect);
  defaultsSection.appendChild(effortRow);

  // 两个开关
  /** @param {string} id @param {string} text @param {string} hint */
  const buildToggle = (id, text, hint) => {
    const row = doc.createElement("div");
    row.className = "settings-field";
    const label = doc.createElement("label");
    label.className = "settings-toggle";
    const input = doc.createElement("input");
    input.type = "checkbox";
    input.id = id;
    const span = doc.createElement("span");
    span.textContent = text;
    label.appendChild(input);
    label.appendChild(span);
    row.appendChild(label);
    const hintEl = doc.createElement("p");
    hintEl.className = "settings-field-hint";
    hintEl.textContent = hint;
    row.appendChild(hintEl);
    defaultsSection.appendChild(row);
    return input;
  };
  const verifyInput = buildToggle("settings-verify", "独立核查", "新对话默认开启独立核查；提交栏里可逐次关掉。");
  const autoApproveInput = buildToggle("settings-auto-approve", "自动放行工具", "新对话默认自动放行低风险工具；写入仍受工作目录边界约束。");

  effortSelect.addEventListener("change", () => {
    settings = updateSettings(settings, { defaults: { effort: effortSelect.value } });
    persist();
    host.onApplyComposerDefaults?.({ effort: effortSelect.value });
    host.onAnnounce?.("已更新思考强度默认值");
  });
  verifyInput.addEventListener("change", () => {
    settings = updateSettings(settings, { defaults: { verify: verifyInput.checked } });
    persist();
    host.onApplyComposerDefaults?.({ verify: verifyInput.checked });
    host.onAnnounce?.(verifyInput.checked ? "新对话将默认开启独立核查" : "新对话默认关闭独立核查");
  });
  autoApproveInput.addEventListener("change", () => {
    settings = updateSettings(settings, { defaults: { autoApprove: autoApproveInput.checked } });
    persist();
    // 与 composer 的旧偏好键同源：两个键一起写，哪边先读都一致
    try { storage?.setItem(LEGACY_AUTO_APPROVE_KEY, autoApproveInput.checked ? "1" : "0"); } catch { /* ignore */ }
    host.onApplyComposerDefaults?.({ autoApprove: autoApproveInput.checked });
    host.onAnnounce?.(autoApproveInput.checked ? "新对话将默认自动放行工具" : "新对话默认逐条审批工具");
  });

  // ---- 分组三：通知 ----
  const notifSection = addSection("settings-notifications", "通知");

  const permRow = doc.createElement("div");
  permRow.className = "settings-field settings-field--inline";
  const permText = doc.createElement("div");
  permText.className = "settings-field-copy";
  const permLabel = doc.createElement("strong");
  permLabel.textContent = "系统通知";
  const permState = doc.createElement("p");
  permState.className = "settings-field-hint";
  permState.id = "settings-notify-state";
  permText.appendChild(permLabel);
  permText.appendChild(permState);
  const permBtn = doc.createElement("button");
  permBtn.type = "button";
  permBtn.className = "btn btn--ghost";
  permBtn.id = "settings-notify-request";
  permBtn.textContent = "请求授权";
  permRow.appendChild(permText);
  permRow.appendChild(permBtn);
  notifSection.appendChild(permRow);

  function permissionState() {
    return NotificationCtor ? String(NotificationCtor.permission ?? "default") : null;
  }

  function renderPermission() {
    const perm = permissionState();
    permState.textContent = permissionStateLabel(perm);
    // 只有「未决定」能弹授权框；已授权/已拒绝都如实展示、按钮退场
    permBtn.hidden = perm !== "default";
  }

  permBtn.addEventListener("click", () => {
    if (!NotificationCtor || typeof NotificationCtor.requestPermission !== "function") return;
    try {
      const done = (result) => {
        // 与 notifications.js 同源：授权结果落同一个 agent-ui-notify-prompt
        persistPromptChoice(storage, result === "granted" ? "granted" : "dismissed");
        renderPermission();
        host.onAnnounce?.(result === "granted" ? "系统通知已开启" : "系统通知未开启");
      };
      const ret = NotificationCtor.requestPermission(done);
      // 新规范返回 Promise，旧规范走回调——两个都接（与 notifications.js 同口径）
      if (ret && typeof ret.then === "function") ret.then(done);
    } catch { /* 请求被拒时静默，状态行照实显示 */ }
  });

  // 应用内角标
  const badgeRow = doc.createElement("div");
  badgeRow.className = "settings-field";
  const badgeLabel = doc.createElement("label");
  badgeLabel.className = "settings-toggle";
  const badgeInput = doc.createElement("input");
  badgeInput.type = "checkbox";
  badgeInput.id = "settings-badge";
  const badgeSpan = doc.createElement("span");
  badgeSpan.textContent = "侧栏铃铛上的待决定角标";
  badgeLabel.appendChild(badgeInput);
  badgeLabel.appendChild(badgeSpan);
  badgeRow.appendChild(badgeLabel);
  const badgeHint = doc.createElement("p");
  badgeHint.className = "settings-field-hint";
  badgeHint.textContent = "关掉后通知中心仍在，只是不再用红点数字提醒。";
  badgeRow.appendChild(badgeHint);
  notifSection.appendChild(badgeRow);

  function applyBadgePref() {
    doc.body?.classList?.toggle("settings-badge-off", !badgeEnabled(settings));
  }

  badgeInput.addEventListener("change", () => {
    settings = updateSettings(settings, { badge: badgeInput.checked });
    persist();
    applyBadgePref();
    host.onAnnounce?.(badgeInput.checked ? "已开启应用内角标" : "已关闭应用内角标");
  });

  // ---- 分组四：快捷键（静态一览，数据源与命令面板帮助同源）----
  const shortcutSection = addSection("settings-shortcuts", "快捷键");
  const scList = doc.createElement("dl");
  scList.className = "settings-shortcut-list";
  for (const s of shortcutRows()) {
    const row = doc.createElement("div");
    row.className = "settings-shortcut-row";
    const dt = doc.createElement("dt");
    const kbd = doc.createElement("kbd");
    kbd.className = "palette-kbd";
    kbd.textContent = s.keys;
    dt.appendChild(kbd);
    const dd = doc.createElement("dd");
    dd.textContent = s.desc;
    row.appendChild(dt);
    row.appendChild(dd);
    scList.appendChild(row);
  }
  shortcutSection.appendChild(scList);

  // ---- 分组五：关于 ----
  const aboutSection = addSection("settings-about", "关于");
  const aboutList = doc.createElement("dl");
  aboutList.className = "settings-about-list";
  /** @type {Record<string, HTMLElement>} */
  const aboutValues = {};
  for (const [key, label] of [["name", "项目"], ["version", "版本"], ["workdir", "工作目录"]]) {
    const row = doc.createElement("div");
    row.className = "settings-about-row";
    const dt = doc.createElement("dt");
    dt.textContent = label;
    const dd = doc.createElement("dd");
    dd.id = `settings-about-${key}`;
    row.appendChild(dt);
    row.appendChild(dd);
    aboutList.appendChild(row);
    aboutValues[key] = dd;
  }
  aboutSection.appendChild(aboutList);

  function renderAbout() {
    const snap = host.getHarnessSnapshot?.() ?? null;
    aboutValues.name.textContent = PROJECT_NAME;
    aboutValues.version.textContent =
      typeof snap?.version === "string" && snap.version ? snap.version : FALLBACK_VERSION;
    aboutValues.workdir.textContent =
      typeof snap?.workdir === "string" && snap.workdir ? snap.workdir : "未获取";
  }

  // ---- 锚点导航 ----
  for (const s of SETTINGS_SECTIONS) {
    const li = doc.createElement("li");
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "settings-nav-btn";
    btn.setAttribute("data-section", s.id);
    btn.innerHTML = `<i class="ph ${s.icon}" aria-hidden="true"></i><span></span>`;
    btn.querySelector("span").textContent = s.label;
    btn.addEventListener("click", () => {
      const target = doc.getElementById(s.id);
      if (!target) return;
      // 跳转锚点：滚动到分组并把焦点交给它（tabindex=-1，不进 Tab 序）
      try { target.scrollIntoView({ block: "start" }); } catch { /* jsdom 等无布局环境 */ }
      target.focus({ preventScroll: true });
    });
    li.appendChild(btn);
    navList.appendChild(li);
  }

  // ---- 刷新：控件与状态对齐（打开时、快照晚到时、外部改主题后）----
  function refresh() {
    const current = String(host.getTheme?.() ?? "auto");
    for (const radio of themeRadios) radio.checked = radio.value === current;

    // 对话阅读模式：以 localStorage 为准（详情顶栏开关可能刚改过）
    const readingMode = readReadingMode(storage);
    for (const radio of readingRadios) radio.checked = radio.value === readingMode;

    // 思考强度选项：档位由服务端声明，前端只补「跟随服务端默认」
    const snap = host.getHarnessSnapshot?.() ?? null;
    const levels = Array.isArray(snap?.effortLevels) ? snap.effortLevels : [];
    const currentEffort = settings.defaults.effort;
    effortSelect.innerHTML = "";
    const followOpt = doc.createElement("option");
    followOpt.value = "";
    followOpt.textContent = "跟随服务端默认";
    effortSelect.appendChild(followOpt);
    for (const lv of levels) {
      const opt = doc.createElement("option");
      opt.value = lv;
      opt.textContent = EFFORT_LABELS[lv] ?? lv;
      effortSelect.appendChild(opt);
    }
    effortSelect.value = isValidEffort(currentEffort, levels) ? currentEffort : "";

    verifyInput.checked = settings.defaults.verify;
    autoApproveInput.checked = settings.defaults.autoApprove;
    badgeInput.checked = badgeEnabled(settings);

    renderPermission();
    renderAbout();
  }

  // ---- 开关 ----
  function openView() {
    if (open) return;
    open = true;
    restoreFocusTo = /** @type {HTMLElement|null} */ (doc.activeElement);
    settings = loadSettings(storage); // 外部（composer）可能刚写过
    applyBadgePref();
    refresh();
    view.hidden = false;
    backBtn.focus();
    host.onAnnounce?.("设置已打开");
  }

  function closeView() {
    if (!open) return;
    open = false;
    view.hidden = true;
    if (restoreFocusTo && typeof restoreFocusTo.focus === "function" && doc.contains?.(restoreFocusTo) !== false) {
      restoreFocusTo.focus();
    }
    restoreFocusTo = null;
  }

  backBtn.addEventListener("click", () => host.onCloseSettings?.());

  // 侧栏齿轮入口（宿主在骨架里放了 #settings-open-btn 才有）
  const openBtn = doc.getElementById("settings-open-btn");
  if (openBtn) {
    openBtn.addEventListener("click", () => host.onOpenSettings?.());
  }

  // 角标偏好在首次打开前就该生效（启动即隐藏角标，不用等进设置页）
  applyBadgePref();

  return {
    open: openView,
    close: closeView,
    isOpen: () => open,
    element: view,
    refresh,
    /** 测试与诊断用 */
    getSettings: () => settings,
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

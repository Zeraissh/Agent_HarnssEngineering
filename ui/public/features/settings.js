/**
 * features/settings — 设置中心（T7）。
 *
 * 零依赖原生 ESM。独立视图（hash 路由 #/settings），分六组：
 *   外观 / 模型 / 运行默认值 / 通知 / 快捷键 / 关于。
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
  { id: "settings-models", label: "模型", icon: "ph-cpu" },
  { id: "settings-mcp", label: "MCP", icon: "ph-plugs-connected" },
  { id: "settings-defaults", label: "运行默认值", icon: "ph-sliders-horizontal" },
  { id: "settings-notifications", label: "通知", icon: "ph-bell" },
  { id: "settings-shortcuts", label: "快捷键", icon: "ph-keyboard" },
  { id: "settings-about", label: "关于", icon: "ph-info" },
];

// ---------------------------------------------------------------
// 模型库（MODEL-02）：常量与纯函数层
// ---------------------------------------------------------------

export const MODELS_API_URL = "/api/models";
export const MODELS_TEST_API_URL = "/api/models/test";

export const MODEL_PROVIDER_CHOICES = [
  { id: "anthropic", label: "Anthropic / Claude 兼容" },
  { id: "openai", label: "OpenAI 兼容（DeepSeek / Kimi / 本地网关）" },
];

/** model 输入框的 datalist 建议——只是提示，不拦任何合法输入。 */
export const MODEL_NAME_SUGGESTIONS = {
  anthropic: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
  openai: ["deepseek-v4-flash", "deepseek-v4-pro", "kimi-k2-thinking", "moonshot-v1-8k-vision-preview"],
};

/**
 * 五个角色：executor 必选（没有执行者整个宿主就没有出发点）；
 * planner/verifier 的空值 = 跟随执行；vision / image 的空值 = 不配置。
 */
export const MODEL_ROLE_META = [
  { key: "executor", label: "执行", allowEmpty: false, emptyLabel: "", hint: "实际干活的模型——拆任务、调工具、写代码" },
  { key: "planner", label: "规划", allowEmpty: true, emptyLabel: "跟随执行", hint: "复杂任务的框架设计与拆分；跟随执行 = 与执行者同一个模型" },
  { key: "verifier", label: "核查", allowEmpty: true, emptyLabel: "跟随执行", hint: "审查与复查检查——可以把这一步交给更强的模型" },
  { key: "vision", label: "识图", allowEmpty: true, emptyLabel: "不配置", hint: "图片理解（describe_image 工具）；不配置 = 不提供该工具" },
  { key: "image", label: "生图", allowEmpty: true, emptyLabel: "不配置", hint: "文生图（generate_image 工具，OpenAI 兼容 Images API）；不配置 = 不提供该工具" },
];

/**
 * GET /api/models 应答的容错解析：形状不对 → null；条目逐条过滤，
 * roles 的悬空引用收编为 null（与服务端 parseModelStore 同一条纪律）。
 */
export function parseModelsPayload(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!Array.isArray(raw.models)) return null;
  const models = [];
  const seen = new Set();
  for (const m of raw.models) {
    if (!m || typeof m !== "object") continue;
    if (typeof m.id !== "string" || !m.id || seen.has(m.id)) continue;
    if (m.provider !== "anthropic" && m.provider !== "openai") continue;
    if (typeof m.model !== "string" || !m.model) continue;
    seen.add(m.id);
    models.push({
      id: m.id,
      label: typeof m.label === "string" && m.label ? m.label : m.model,
      provider: m.provider,
      model: m.model,
      baseUrl: typeof m.baseUrl === "string" ? m.baseUrl : "",
      hasApiKey: m.hasApiKey === true,
    });
  }
  const roles = { executor: null, planner: null, verifier: null, vision: null, image: null };
  const rawRoles = raw.roles && typeof raw.roles === "object" ? raw.roles : {};
  for (const key of Object.keys(roles)) {
    const id = rawRoles[key];
    roles[key] = typeof id === "string" && seen.has(id) ? id : null;
  }
  return { models, roles, source: raw.source === "store" ? "store" : "env" };
}

/** 客户端侧条目 id（服务端校验规则 [A-Za-z0-9:_-]{1,64}，冲突时服务端兜底重发）。 */
export function newModelId() {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function modelOptionLabel(m) {
  return `${m.label}（${m.provider} · ${m.model}）`;
}

/** 角色下拉选项：允许空的角色首项是「跟随执行 / 不配置」。 */
export function roleOptionsFor(roleKey, models) {
  const meta = MODEL_ROLE_META.find((r) => r.key === roleKey);
  const opts = [];
  if (meta?.allowEmpty) opts.push({ value: "", label: meta.emptyLabel });
  for (const m of models) opts.push({ value: m.id, label: modelOptionLabel(m) });
  return opts;
}

/** 角色现状一行字：「核查 · Claude Opus」/「核查 · 跟随执行」。 */
export function roleCurrentLabel(roleKey, models, roles) {
  const meta = MODEL_ROLE_META.find((r) => r.key === roleKey);
  const id = roles?.[roleKey];
  const entry = id ? models.find((m) => m.id === id) : null;
  if (!entry) return `${meta?.label ?? roleKey} · ${meta?.emptyLabel ?? "未配置"}`;
  return `${meta?.label ?? roleKey} · ${entry.label}（${entry.model}）`;
}

/** 本机回环判定（与服务端 normalizeBaseUrl 同口径的最小集）。 */
function isLoopbackHost(hostname) {
  const h = String(hostname ?? "").toLowerCase();
  return h === "localhost" || h === "::1" || h === "[::1]" || h.startsWith("127.");
}

/** 添加/编辑表单的前置校验（服务端仍会全量复核——这里只为当场反馈）。 */
export function validateModelDraft(draft) {
  const errors = [];
  if (!draft || typeof draft !== "object") return ["表单为空"];
  if (draft.provider !== "anthropic" && draft.provider !== "openai") errors.push("请选择 Provider");
  const model = String(draft.model ?? "");
  if (!model || model !== model.trim() || model.length > 200) {
    errors.push("模型名无效：不能为空、不带首尾空白、最长 200 字符");
  }
  const baseUrl = String(draft.baseUrl ?? "").trim();
  if (baseUrl) {
    let u = null;
    try {
      u = new URL(baseUrl);
    } catch {
      errors.push("Base URL 不是有效 URL");
    }
    if (u) {
      if (u.username || u.password) errors.push("Base URL 不能包含用户名或密码");
      if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))) {
        errors.push("远程 Base URL 必须使用 HTTPS；HTTP 只允许本机回环地址");
      }
    }
  }
  return errors;
}

/**
 * 删除条目：被执行者引用 → 拒绝（执行者不可降级）；被其他角色引用 →
 * 该角色重置为空值（跟随执行 / 不配置）并在 warnings 里说明。
 */
export function applyModelDelete(models, roles, id) {
  if (roles.executor === id) {
    return {
      models, roles, warnings: [],
      error: "执行者正在使用这个模型——请先在下方「角色分配」里把执行改派给别的模型",
    };
  }
  const warnings = [];
  const nextRoles = { ...roles };
  for (const meta of MODEL_ROLE_META) {
    if (meta.key !== "executor" && nextRoles[meta.key] === id) {
      nextRoles[meta.key] = null;
      warnings.push(`「${meta.label}」已重置为${meta.emptyLabel}`);
    }
  }
  return { models: models.filter((m) => m.id !== id), roles: nextRoles, error: null, warnings };
}

/**
 * PUT 请求体组装。apiKey 三态纪律：只有用户在表单里碰过 apiKey 的条目
 * （pendingApiKeys 里有记录）才带这个字段——含 ""（= 清除，改走环境变量）；
 * 没碰过的一律省略（= 保持不变）。apiKey 原文永不出栈，所以不能用
 * hasApiKey 反推。
 */
export function buildModelsPutBody(models, roles, pendingApiKeys) {
  return {
    models: models.map((m) => ({
      id: m.id,
      label: m.label,
      provider: m.provider,
      model: m.model,
      baseUrl: m.baseUrl,
      ...(pendingApiKeys && pendingApiKeys.has(m.id) ? { apiKey: pendingApiKeys.get(m.id) } : {}),
    })),
    roles: { ...roles },
  };
}

export function modelsSourceLabel(source) {
  return source === "store"
    ? "当前来源：模型库文件（.agent-models.json）"
    : "当前来源：环境变量（首次保存后转为模型库文件）";
}

const EFFORT_LABELS = { low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高" };

/**
 * @typedef {{
 *   version:number,
 *   defaults:{ effort:string, verify:boolean, autoApprove:boolean, predictiveInput:boolean },
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
    defaults: { effort: "", verify: false, autoApprove: true, predictiveInput: false },
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
  if (typeof d.predictiveInput === "boolean") base.defaults.predictiveInput = d.predictiveInput;
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
 * @returns {{ effort:string, verify:boolean, autoApprove:boolean, predictiveInput:boolean }}
 */
export function composerDefaults(settings) {
  return {
    effort: settings?.defaults?.effort ?? "",
    verify: Boolean(settings?.defaults?.verify),
    autoApprove: settings?.defaults?.autoApprove !== false,
    predictiveInput: settings?.defaults?.predictiveInput === true,
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
 *   onModelsSaved()             → 模型配置保存成功（宿主刷新 /api/harness 快照，composer pill 同步）
 *   onOpenSettings()            → 侧栏齿轮点击（宿主写 hash 路由）
 *   onCloseSettings()           → 返回上一视图（宿主决定 history.back 或回 "#/")
 *   onReplayOnboarding()        → 再看一遍新手引导（设置 → 关于）
 *   onAnnounce(msg)             → aria-live 播报（可选）
 *
 * env（测试注入）：doc / win / storage / Notification / fetchImpl（模型库读写；
 * 缺省用全局 fetch）
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

  // ---- 分组二：模型（MODEL-02 模型库 + 角色分配）----
  // 数据在服务端（.agent-models.json），本视图只做读写中转；apiKey 只进不出——
  // GET 拿不到原文，保存时只有用户碰过 apiKey 的条目才带这个字段。
  const modelsSection = addSection("settings-models", "模型");
  const fetcher = env.fetchImpl ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);

  const modelsNote = doc.createElement("p");
  modelsNote.className = "settings-card-note";
  modelsNote.textContent = "模型库与角色分配保存在服务端。配置对新任务生效；进行中的任务不受影响。";
  modelsSection.appendChild(modelsNote);

  const modelsSource = doc.createElement("p");
  modelsSource.className = "settings-field-hint";
  modelsSource.id = "settings-models-source";
  modelsSection.appendChild(modelsSource);

  // 模型库列表
  const modelsList = doc.createElement("div");
  modelsList.className = "settings-models-list";
  modelsList.id = "settings-models-list";
  modelsSection.appendChild(modelsList);

  // 添加 / 编辑表单
  const modelForm = doc.createElement("fieldset");
  modelForm.className = "settings-model-form";
  const modelFormLegend = doc.createElement("legend");
  modelFormLegend.className = "settings-model-form-legend";
  modelFormLegend.id = "settings-model-form-legend";
  modelFormLegend.textContent = "添加模型";
  modelForm.appendChild(modelFormLegend);

  /** 小工具：带 label 的输入行 */
  const buildInputRow = (id, labelText, input) => {
    const row = doc.createElement("div");
    row.className = "settings-field";
    const label = doc.createElement("label");
    label.setAttribute("for", id);
    label.textContent = labelText;
    input.id = id;
    row.appendChild(label);
    row.appendChild(input);
    modelForm.appendChild(row);
    return input;
  };
  const modelLabelInput = buildInputRow("settings-model-label", "名称（给自己看的备注）", doc.createElement("input"));
  modelLabelInput.type = "text";
  modelLabelInput.placeholder = "例如：Claude Opus（强模型）";
  modelLabelInput.maxLength = 80;

  const modelProviderSelect = buildInputRow("settings-model-provider", "Provider", doc.createElement("select"));
  for (const p of MODEL_PROVIDER_CHOICES) {
    const opt = doc.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    modelProviderSelect.appendChild(opt);
  }

  const modelNameInput = buildInputRow("settings-model-name", "模型名", doc.createElement("input"));
  modelNameInput.type = "text";
  modelNameInput.placeholder = "例如：claude-opus-4-8";
  modelNameInput.setAttribute("list", "settings-model-suggestions");
  const modelSuggestions = doc.createElement("datalist");
  modelSuggestions.id = "settings-model-suggestions";
  modelForm.appendChild(modelSuggestions);
  const renderSuggestions = () => {
    modelSuggestions.innerHTML = "";
    for (const name of MODEL_NAME_SUGGESTIONS[modelProviderSelect.value] ?? []) {
      const opt = doc.createElement("option");
      opt.value = name;
      modelSuggestions.appendChild(opt);
    }
  };
  modelProviderSelect.addEventListener("change", renderSuggestions);
  renderSuggestions();

  const modelBaseUrlInput = buildInputRow("settings-model-baseurl", "Base URL（留空 = 官方端点）", doc.createElement("input"));
  modelBaseUrlInput.type = "text";
  modelBaseUrlInput.placeholder = "https://api.example.com（远程必须 HTTPS）";

  const modelApiKeyInput = buildInputRow("settings-model-apikey", "API Key", doc.createElement("input"));
  modelApiKeyInput.type = "password";
  modelApiKeyInput.autocomplete = "off";
  // 三态语义的界面表达：不碰 = 保持不变；清空 = 改用环境变量；输入 = 更新
  modelApiKeyInput.dataset.touched = "0";
  modelApiKeyInput.addEventListener("input", () => { modelApiKeyInput.dataset.touched = "1"; });

  const apiKeyHint = doc.createElement("p");
  apiKeyHint.className = "settings-field-hint";
  apiKeyHint.id = "settings-model-apikey-hint";
  apiKeyHint.textContent = "留空 = 使用环境变量（ANTHROPIC_API_KEY / OPENAI_API_KEY）。Key 只保存在服务端，永不下发浏览器。";
  modelForm.appendChild(apiKeyHint);

  const modelFormActions = doc.createElement("div");
  modelFormActions.className = "settings-model-form-actions";
  const modelTestBtn = doc.createElement("button");
  modelTestBtn.type = "button";
  modelTestBtn.className = "btn btn--ghost";
  modelTestBtn.id = "settings-model-test";
  modelTestBtn.textContent = "测试连接";
  const modelSubmitBtn = doc.createElement("button");
  modelSubmitBtn.type = "button";
  modelSubmitBtn.className = "btn btn--primary";
  modelSubmitBtn.id = "settings-model-submit";
  modelSubmitBtn.textContent = "添加到模型库";
  const modelCancelBtn = doc.createElement("button");
  modelCancelBtn.type = "button";
  modelCancelBtn.className = "btn btn--ghost";
  modelCancelBtn.id = "settings-model-cancel";
  modelCancelBtn.textContent = "取消编辑";
  modelCancelBtn.hidden = true;
  modelFormActions.appendChild(modelTestBtn);
  modelFormActions.appendChild(modelSubmitBtn);
  modelFormActions.appendChild(modelCancelBtn);
  modelForm.appendChild(modelFormActions);

  const modelFormStatus = doc.createElement("p");
  modelFormStatus.className = "settings-field-hint";
  modelFormStatus.id = "settings-model-form-status";
  modelFormStatus.setAttribute("role", "status");
  modelForm.appendChild(modelFormStatus);
  modelsSection.appendChild(modelForm);

  // 角色分配
  const rolesHeading = doc.createElement("h4");
  rolesHeading.className = "settings-models-subhead";
  rolesHeading.textContent = "角色分配";
  modelsSection.appendChild(rolesHeading);
  /** @type {Record<string, HTMLSelectElement>} */
  const roleSelects = {};
  /** @type {Record<string, HTMLElement>} */
  const roleCurrentLines = {};
  for (const meta of MODEL_ROLE_META) {
    const row = doc.createElement("div");
    row.className = "settings-field";
    const label = doc.createElement("label");
    label.setAttribute("for", `settings-role-${meta.key}`);
    label.textContent = meta.label;
    const select = doc.createElement("select");
    select.id = `settings-role-${meta.key}`;
    const hint = doc.createElement("p");
    hint.className = "settings-field-hint";
    hint.textContent = meta.hint;
    const current = doc.createElement("p");
    current.className = "settings-role-current";
    current.id = `settings-role-${meta.key}-current`;
    row.appendChild(label);
    row.appendChild(select);
    row.appendChild(hint);
    row.appendChild(current);
    modelsSection.appendChild(row);
    roleSelects[meta.key] = select;
    roleCurrentLines[meta.key] = current;
  }

  // 保存行
  const modelsSaveRow = doc.createElement("div");
  modelsSaveRow.className = "settings-model-form-actions";
  const modelsSaveBtn = doc.createElement("button");
  modelsSaveBtn.type = "button";
  modelsSaveBtn.className = "btn btn--primary";
  modelsSaveBtn.id = "settings-models-save";
  modelsSaveBtn.textContent = "保存模型配置";
  const modelsSyncEnvBtn = doc.createElement("button");
  modelsSyncEnvBtn.type = "button";
  modelsSyncEnvBtn.className = "btn btn--ghost";
  modelsSyncEnvBtn.id = "settings-models-sync-env";
  modelsSyncEnvBtn.textContent = "同步到 .env";
  modelsSyncEnvBtn.title = "把当前角色模型名写回 .env，下次冷启动仍可用；不写 API key，当前进程不会因此换模型";
  modelsSaveRow.appendChild(modelsSaveBtn);
  modelsSaveRow.appendChild(modelsSyncEnvBtn);
  modelsSection.appendChild(modelsSaveRow);
  const modelsStatus = doc.createElement("p");
  modelsStatus.className = "settings-field-hint";
  modelsStatus.id = "settings-models-status";
  modelsStatus.setAttribute("role", "status");
  modelsSection.appendChild(modelsStatus);

  /** @type {{ models:any[], roles:Record<string,string|null>, source:string }|null} */
  let modelsState = null;
  /** 用户碰过 apiKey 的条目：保存时才带 apiKey 字段（含 "" = 清除） */
  const pendingApiKeys = new Map();
  let modelsDirty = false;
  /** 编辑目标 id；null = 添加模式 */
  let editingModelId = null;

  function setModelsStatus(msg, isError = false) {
    modelsStatus.textContent = msg;
    modelsStatus.classList.toggle("settings-status--error", isError);
  }
  function setFormStatus(msg, isError = false) {
    modelFormStatus.textContent = msg;
    modelFormStatus.classList.toggle("settings-status--error", isError);
  }

  function renderModelsList() {
    modelsList.innerHTML = "";
    const models = modelsState?.models ?? [];
    if (!models.length) {
      const empty = doc.createElement("p");
      empty.className = "settings-field-hint";
      empty.textContent = "模型库为空——先在下方添加一个模型。";
      modelsList.appendChild(empty);
      return;
    }
    for (const m of models) {
      const row = doc.createElement("div");
      row.className = "settings-model-row";
      const copy = doc.createElement("div");
      copy.className = "settings-model-copy";
      const name = doc.createElement("strong");
      name.textContent = m.label;
      const detail = doc.createElement("small");
      detail.textContent = `${m.provider} · ${m.model}${m.baseUrl ? ` · ${m.baseUrl}` : ""}`;
      copy.appendChild(name);
      copy.appendChild(detail);
      const keyBadge = doc.createElement("span");
      keyBadge.className = m.hasApiKey ? "settings-badge settings-badge--ok" : "settings-badge";
      keyBadge.textContent = m.hasApiKey ? "已存 Key" : "环境变量 Key";
      copy.appendChild(keyBadge);
      row.appendChild(copy);
      const actions = doc.createElement("div");
      actions.className = "settings-model-actions";
      const editBtn = doc.createElement("button");
      editBtn.type = "button";
      editBtn.className = "btn btn--ghost";
      editBtn.textContent = "编辑";
      editBtn.addEventListener("click", () => startEditModel(m.id));
      const delBtn = doc.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn--ghost";
      delBtn.textContent = "删除";
      delBtn.addEventListener("click", () => deleteModel(m.id));
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      row.appendChild(actions);
      modelsList.appendChild(row);
    }
  }

  function renderRoleSelects() {
    if (!modelsState) return;
    for (const meta of MODEL_ROLE_META) {
      const select = roleSelects[meta.key];
      select.innerHTML = "";
      for (const opt of roleOptionsFor(meta.key, modelsState.models)) {
        const el = doc.createElement("option");
        el.value = opt.value;
        el.textContent = opt.label;
        select.appendChild(el);
      }
      select.value = modelsState.roles[meta.key] ?? "";
      roleCurrentLines[meta.key].textContent = `当前：${roleCurrentLabel(meta.key, modelsState.models, modelsState.roles)}`;
    }
  }

  function renderModelsSource() {
    modelsSource.textContent = modelsState ? modelsSourceLabel(modelsState.source) : "";
  }

  function renderModelsAll() {
    renderModelsSource();
    renderModelsList();
    renderRoleSelects();
    modelsSaveBtn.disabled = !modelsState;
  }

  function resetModelForm() {
    editingModelId = null;
    modelLabelInput.value = "";
    modelNameInput.value = "";
    modelBaseUrlInput.value = "";
    modelApiKeyInput.value = "";
    modelApiKeyInput.dataset.touched = "0";
    modelApiKeyInput.placeholder = "留空 = 使用环境变量";
    modelFormLegend.textContent = "添加模型";
    modelSubmitBtn.textContent = "添加到模型库";
    modelCancelBtn.hidden = true;
  }

  function startEditModel(id) {
    const m = modelsState?.models.find((x) => x.id === id);
    if (!m) return;
    editingModelId = id;
    modelLabelInput.value = m.label;
    modelProviderSelect.value = m.provider;
    renderSuggestions();
    modelNameInput.value = m.model;
    modelBaseUrlInput.value = m.baseUrl;
    modelApiKeyInput.value = "";
    modelApiKeyInput.dataset.touched = "0";
    modelApiKeyInput.placeholder = m.hasApiKey ? "已保存（输入以替换；清空并保存 = 改用环境变量）" : "留空 = 使用环境变量";
    modelFormLegend.textContent = "编辑模型";
    modelSubmitBtn.textContent = "保存修改";
    modelCancelBtn.hidden = false;
    setFormStatus("");
  }

  function deleteModel(id) {
    if (!modelsState) return;
    const result = applyModelDelete(modelsState.models, modelsState.roles, id);
    if (result.error) {
      setModelsStatus(result.error, true);
      host.onAnnounce?.(result.error);
      return;
    }
    modelsState = { ...modelsState, models: result.models, roles: result.roles };
    pendingApiKeys.delete(id);
    if (editingModelId === id) resetModelForm();
    modelsDirty = true;
    renderModelsAll();
    const msg = ["已删除模型（保存后生效）", ...result.warnings].join("；");
    setModelsStatus(msg);
    host.onAnnounce?.(msg);
  }

  function upsertModelFromForm() {
    if (!modelsState) {
      setFormStatus("模型库还没加载完成，请稍候", true);
      return;
    }
    const draft = {
      label: modelLabelInput.value.trim(),
      provider: modelProviderSelect.value,
      model: modelNameInput.value,
      baseUrl: modelBaseUrlInput.value.trim(),
    };
    const errors = validateModelDraft(draft);
    if (errors.length) {
      setFormStatus(errors.join("；"), true);
      return;
    }
    const id = editingModelId ?? newModelId();
    const next = {
      id,
      label: draft.label || draft.model,
      provider: draft.provider,
      model: draft.model,
      baseUrl: draft.baseUrl,
      hasApiKey: modelApiKeyInput.dataset.touched === "1"
        ? modelApiKeyInput.value !== ""
        : (modelsState.models.find((x) => x.id === id)?.hasApiKey ?? false),
    };
    if (modelApiKeyInput.dataset.touched === "1") {
      pendingApiKeys.set(id, modelApiKeyInput.value);
    }
    const index = modelsState.models.findIndex((x) => x.id === id);
    const models = [...modelsState.models];
    if (index >= 0) models[index] = next;
    else models.push(next);
    modelsState = { ...modelsState, models };
    // 添加的第一个模型自动派给执行者（executor 必选，替用户少点一下）
    if (!modelsState.roles.executor) {
      modelsState.roles = { ...modelsState.roles, executor: id };
    }
    modelsDirty = true;
    resetModelForm();
    renderModelsAll();
    setFormStatus("");
    setModelsStatus("模型库已更新（保存后生效）");
  }

  async function testModelFromForm() {
    if (!fetcher) return;
    const draft = {
      provider: modelProviderSelect.value,
      model: modelNameInput.value,
      baseUrl: modelBaseUrlInput.value.trim(),
    };
    const errors = validateModelDraft(draft);
    if (errors.length) {
      setFormStatus(errors.join("；"), true);
      return;
    }
    modelTestBtn.disabled = true;
    setFormStatus("正在测试连接…");
    try {
      const res = await fetcher(MODELS_TEST_API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: draft.provider,
          model: draft.model,
          baseUrl: draft.baseUrl,
          // 编辑已存 Key 的条目且没碰过 apiKey 时，测试走服务端环境变量/已存语义
          ...(modelApiKeyInput.dataset.touched === "1" && modelApiKeyInput.value
            ? { apiKey: modelApiKeyInput.value }
            : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      if (data?.ok) {
        setFormStatus("连接成功——端点、Key 与模型名都可用");
      } else {
        setFormStatus(data?.error ?? `测试失败（HTTP ${res.status}）`, true);
      }
    } catch {
      setFormStatus("测试请求未能发出——请检查网络或服务端状态", true);
    } finally {
      modelTestBtn.disabled = false;
    }
  }

  async function loadModels() {
    if (!fetcher) {
      setModelsStatus("当前环境无法连接服务端", true);
      return;
    }
    try {
      const res = await fetcher(MODELS_API_URL);
      if (!res.ok) {
        setModelsStatus(`模型配置加载失败（HTTP ${res.status}）`, true);
        return;
      }
      const parsed = parseModelsPayload(await res.json());
      if (!parsed) {
        setModelsStatus("模型配置应答无法解析", true);
        return;
      }
      modelsState = parsed;
      pendingApiKeys.clear();
      modelsDirty = false;
      resetModelForm();
      renderModelsAll();
      setModelsStatus("");
    } catch {
      setModelsStatus("模型配置加载失败——请检查服务端状态", true);
    }
  }

  async function saveModels() {
    if (!fetcher || !modelsState) return;
    if (!modelsState.roles.executor) {
      setModelsStatus("请先在「角色分配」里为执行选择一个模型", true);
      return;
    }
    modelsSaveBtn.disabled = true;
    setModelsStatus("正在保存…");
    try {
      const res = await fetcher(MODELS_API_URL, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildModelsPutBody(modelsState.models, modelsState.roles, pendingApiKeys)),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setModelsStatus(data?.error ?? `保存失败（HTTP ${res.status}）`, true);
        return;
      }
      const parsed = parseModelsPayload(data);
      if (parsed) modelsState = parsed;
      pendingApiKeys.clear();
      modelsDirty = false;
      resetModelForm();
      renderModelsAll();
      setModelsStatus("已保存——对新任务生效；进行中的任务不受影响");
      host.onAnnounce?.("模型配置已保存，对新任务生效");
      // composer 的角色 pill 读 /api/harness：保存成功后立刻刷新快照
      host.onModelsSaved?.();
    } catch {
      setModelsStatus("保存请求未能发出——请检查网络或服务端状态", true);
    } finally {
      modelsSaveBtn.disabled = false;
    }
  }

  modelSubmitBtn.addEventListener("click", upsertModelFromForm);
  modelCancelBtn.addEventListener("click", () => { resetModelForm(); setFormStatus(""); });
  modelTestBtn.addEventListener("click", () => { void testModelFromForm(); });
  modelsSaveBtn.addEventListener("click", () => { void saveModels(); });
  modelsSyncEnvBtn.addEventListener("click", async () => {
    if (!fetcher) return;
    modelsSyncEnvBtn.disabled = true;
    setModelsStatus("正在写入 .env…");
    try {
      const res = await fetcher("/api/models/sync-env", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setModelsStatus(data?.error ?? `同步失败（HTTP ${res.status}）`, true);
        return;
      }
      const n = Array.isArray(data?.changed) ? data.changed.length : 0;
      setModelsStatus(n ? `已更新 ${n} 项到 .env，重启宿主后按文件生效` : ".env 已是最新");
      host.onAnnounce?.("模型配置已同步到 .env");
    } catch {
      setModelsStatus("同步请求未能发出", true);
    } finally {
      modelsSyncEnvBtn.disabled = false;
    }
  });
  for (const meta of MODEL_ROLE_META) {
    roleSelects[meta.key].addEventListener("change", () => {
      if (!modelsState) return;
      modelsState.roles = { ...modelsState.roles, [meta.key]: roleSelects[meta.key].value || null };
      modelsDirty = true;
      renderRoleSelects();
      setModelsStatus("角色分配已修改（保存后生效）");
    });
  }

  // ---- MCP 插件 ----
  const mcpSection = addSection("settings-mcp", "MCP 插件");
  const mcpNote = doc.createElement("p");
  mcpNote.className = "settings-card-note";
  mcpNote.textContent = "宿主已能把 mcp.json 里的服务适配成工具。这里改配置；启用需 AGENT_UI_MCP=1。";
  mcpSection.appendChild(mcpNote);
  const mcpList = doc.createElement("div");
  mcpList.id = "settings-mcp-list";
  mcpList.className = "settings-models-list";
  mcpSection.appendChild(mcpList);
  const mcpForm = doc.createElement("div");
  mcpForm.className = "settings-field";
  mcpForm.innerHTML =
    '<label for="settings-mcp-name">添加服务</label>' +
    '<input id="settings-mcp-name" placeholder="名称，如 stm32" autocomplete="off" />' +
    '<input id="settings-mcp-command" placeholder="command，如 python" autocomplete="off" />' +
    '<input id="settings-mcp-args" placeholder="args，空格分隔" autocomplete="off" />' +
    '<input id="settings-mcp-url" placeholder="或 HTTP url" autocomplete="off" />';
  mcpSection.appendChild(mcpForm);
  const mcpAddBtn = doc.createElement("button");
  mcpAddBtn.type = "button";
  mcpAddBtn.className = "btn btn--primary";
  mcpAddBtn.textContent = "添加 / 更新";
  mcpSection.appendChild(mcpAddBtn);
  const mcpStatus = doc.createElement("p");
  mcpStatus.className = "settings-field-hint";
  mcpSection.appendChild(mcpStatus);

  async function refreshMcp() {
    if (!fetcher) return;
    try {
      const res = await fetcher("/api/mcp");
      const data = await res.json().catch(() => null);
      const servers = Array.isArray(data?.servers) ? data.servers : [];
      const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      }[c]));
      mcpList.innerHTML = servers.length
        ? servers.map((s) =>
            `<div class="settings-model-card" data-mcp-name="${esc(s.name)}">` +
            `<strong>${esc(s.name)}</strong> · ${s.enabled === false ? "已停用" : "启用"} · ${esc(s.command || s.url || "（无命令）")}` +
            `<div class="settings-model-form-actions">` +
            `<button type="button" class="btn btn--ghost" data-mcp-toggle="${esc(s.name)}">${s.enabled === false ? "启用" : "停用"}</button>` +
            `<button type="button" class="btn btn--ghost" data-mcp-remove="${esc(s.name)}">删除</button>` +
            `</div></div>`,
          ).join("")
        : '<p class="settings-field-hint">还没有配置 MCP 服务。</p>';
      mcpStatus.textContent = data?.enabled ? `已启用（${data.path}）` : `配置在 ${data?.path ?? "mcp.json"}；当前宿主未开 AGENT_UI_MCP=1`;
    } catch {
      mcpStatus.textContent = "无法读取 MCP 配置";
    }
  }

  mcpList.addEventListener("click", (event) => {
    const t = event.target instanceof Element ? event.target : null;
    const remove = t?.closest?.("[data-mcp-remove]");
    const toggle = t?.closest?.("[data-mcp-toggle]");
    if (remove) {
      void fetcher("/api/mcp", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: remove.getAttribute("data-mcp-remove"), remove: true }),
      }).then(refreshMcp);
      return;
    }
    if (toggle) {
      const name = toggle.getAttribute("data-mcp-toggle");
      const card = mcpList.querySelector(`[data-mcp-name="${name}"]`);
      const enabled = !card?.textContent?.includes("已停用");
      void fetcher("/api/mcp", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, server: { enabled: !enabled } }),
      }).then(refreshMcp);
    }
  });
  mcpAddBtn.addEventListener("click", () => {
    const name = /** @type {HTMLInputElement} */ (doc.getElementById("settings-mcp-name"))?.value.trim();
    const command = /** @type {HTMLInputElement} */ (doc.getElementById("settings-mcp-command"))?.value.trim();
    const args = /** @type {HTMLInputElement} */ (doc.getElementById("settings-mcp-args"))?.value.trim();
    const url = /** @type {HTMLInputElement} */ (doc.getElementById("settings-mcp-url"))?.value.trim();
    if (!name) {
      mcpStatus.textContent = "先填服务名";
      return;
    }
    void fetcher("/api/mcp", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        server: { command, args: args ? args.split(/\s+/) : [], url, enabled: true },
      }),
    }).then(async (res) => {
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        mcpStatus.textContent = data?.error ?? `保存失败（HTTP ${res.status}）`;
        return;
      }
      void refreshMcp();
    });
  });
  void refreshMcp();

  // ---- 分组三：运行默认值 ----
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
  const predictiveInput = buildToggle(
    "settings-predictive",
    "输入补全（实验性）",
    "根据欢迎页示例和最近对话标题补全当前输入，按 Tab 接受。默认关，不调模型。",
  );

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
  predictiveInput.addEventListener("change", () => {
    settings = updateSettings(settings, { defaults: { predictiveInput: predictiveInput.checked } });
    persist();
    host.onApplyComposerDefaults?.({ predictiveInput: predictiveInput.checked });
    host.onAnnounce?.(predictiveInput.checked ? "已打开实验性输入补全" : "已关闭输入补全");
  });

  // ---- 分组四：通知 ----
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

  // ---- 分组五：快捷键（静态一览，数据源与命令面板帮助同源）----
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

  // ---- 分组六：关于 ----
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
  const replayBtn = doc.createElement("button");
  replayBtn.type = "button";
  replayBtn.id = "settings-onboarding-replay";
  replayBtn.className = "btn btn--ghost";
  replayBtn.textContent = "再看一遍新手引导";
  replayBtn.addEventListener("click", () => host.onReplayOnboarding?.());
  aboutSection.appendChild(replayBtn);

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
    predictiveInput.checked = settings.defaults.predictiveInput === true;
    badgeInput.checked = badgeEnabled(settings);

    renderPermission();
    renderAbout();
    // 模型库数据在服务端：每次打开都拉一次最新（外部可能刚 PUT 过）
    void loadModels();
  }

  /** 焦点移交某个分组（命令面板「模型设置」直达用） */
  function focusSection(sectionId) {
    const target = sectionId ? doc.getElementById(sectionId) : null;
    if (!target) return;
    try { target.scrollIntoView({ block: "start" }); } catch { /* jsdom 等无布局环境 */ }
    target.focus({ preventScroll: true });
  }

  // ---- 开关 ----
  function openView(sectionId) {
    if (open) {
      // 已打开时重复调用 = 只换焦点（命令面板直达分组的路径）
      if (sectionId) focusSection(sectionId);
      return;
    }
    open = true;
    restoreFocusTo = /** @type {HTMLElement|null} */ (doc.activeElement);
    settings = loadSettings(storage); // 外部（composer）可能刚写过
    applyBadgePref();
    refresh();
    view.hidden = false;
    if (sectionId && doc.getElementById(sectionId)) focusSection(sectionId);
    else backBtn.focus();
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

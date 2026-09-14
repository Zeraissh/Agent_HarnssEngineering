// @vitest-environment jsdom
// @ts-nocheck
/**
 * 设置中心（features/settings.js）的回归锁——T7。
 *
 * 分层覆盖：
 *   纯函数层：设置读写 / 容错解析 / 旧键迁移 / composer 默认值派生与注入 /
 *             思考强度校验 / 路由判定 / 授权状态文案 / 快捷键表同源
 *   DOM 层  ：jsdom 里真实初始化，验证视图开关与焦点、主题 radio 派发、
 *             默认值持久化与 composer 同步、通知授权、角标开关、关于分组
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SETTINGS_STORAGE_KEY,
  SETTINGS_SCHEMA_VERSION,
  LEGACY_AUTO_APPROVE_KEY,
  FALLBACK_VERSION,
  SETTINGS_HASH,
  THEME_CHOICES,
  SETTINGS_SECTIONS,
  parsePacksPayload,
  defaultSettings,
  parseSettings,
  loadSettings,
  saveSettings,
  updateSettings,
  migrateLegacyPrefs,
  composerDefaults,
  isValidEffort,
  applyComposerDefaults,
  badgeEnabled,
  isSettingsRoute,
  permissionStateLabel,
  shortcutRows,
  initSettingsView,
  MCP_MARKET_HEADER,
  MCP_MARKET_COPY,
  MCP_MARKET_ESSAY_PHRASES,
  mcpMarketFaceText,
  mcpMarketFaceHasEssay,
  mcpMarketKindLabel,
  mcpOneLine,
  filterMcpMarketItems,
  renderMcpMarketCardHtml,
} from "../ui/public/features/settings.js";
import { SHORTCUTS } from "../ui/public/features/command-palette.js";
import { PROMPT_STORAGE_KEY } from "../ui/public/features/notifications.js";

/** Map  backed 假 Storage（抛错注入比改 jsdom localStorage 更可控） */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

// ---------------------------------------------------------------
// 读写与容错
// ---------------------------------------------------------------
describe("设置读写与容错", () => {
  it("defaultSettings 形状完整", () => {
    const s = defaultSettings();
    expect(s.version).toBe(SETTINGS_SCHEMA_VERSION);
    expect(s.defaults).toEqual({ effort: "", verify: false, autoApprove: true });
    expect(s.badge).toBe(true);
  });

  it("独立核查设置文案写明计划编排默认仍核查", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../ui/public/features/settings.js"),
      "utf8",
    );
    expect(src).toContain("计划编排的子任务默认仍会核查");
    expect(src).not.toContain("提交栏里可逐次关掉。");
  });

  it("parseSettings 合法 JSON 往返", () => {
    const s = updateSettings(defaultSettings(), {
      defaults: { effort: "high", verify: true, autoApprove: false },
      badge: false,
    });
    expect(parseSettings(JSON.stringify(s))).toEqual(s);
  });

  it("坏 JSON / 非对象 / null → null（回默认）", () => {
    expect(parseSettings("{oops")).toBeNull();
    expect(parseSettings('"字符串"')).toBeNull();
    expect(parseSettings("42")).toBeNull();
    expect(parseSettings(null)).toBeNull();
    expect(parseSettings(undefined)).toBeNull();
  });

  it("schema 版本不符 → null", () => {
    const s = { ...defaultSettings(), version: 999 };
    expect(parseSettings(JSON.stringify(s))).toBeNull();
  });

  it("字段逐个校验：类型不对的字段回默认，合法字段保留", () => {
    const raw = JSON.stringify({
      version: SETTINGS_SCHEMA_VERSION,
      defaults: { effort: "low", verify: "是", autoApprove: false },
      badge: "no",
    });
    const s = parseSettings(raw);
    expect(s.defaults.effort).toBe("low");
    expect(s.defaults.verify).toBe(false); // 字符串被丢弃
    expect(s.defaults.autoApprove).toBe(false);
    expect(s.badge).toBe(true); // 非 boolean 被丢弃
  });

  it("loadSettings：无记录 / 损坏内容 / storage 不可用都回默认", () => {
    expect(loadSettings(fakeStorage())).toEqual(defaultSettings());
    expect(loadSettings(fakeStorage({ [SETTINGS_STORAGE_KEY]: "{bad" }))).toEqual(defaultSettings());
    expect(loadSettings(null)).toEqual(defaultSettings());
    const throwing = { getItem: () => { throw new Error("隐私模式"); }, setItem: () => {} };
    expect(loadSettings(throwing)).toEqual(defaultSettings());
  });

  it("saveSettings：正常落盘；写入抛错返回 false 不炸", () => {
    const st = fakeStorage();
    const s = updateSettings(defaultSettings(), { badge: false });
    expect(saveSettings(st, s)).toBe(true);
    expect(parseSettings(st.getItem(SETTINGS_STORAGE_KEY))).toEqual(s);
    const throwing = { getItem: () => null, setItem: () => { throw new Error("满"); } };
    expect(saveSettings(throwing, s)).toBe(false);
    expect(saveSettings(null, s)).toBe(false);
  });

  it("updateSettings 不可变合并：原对象不动，defaults 深一层合并", () => {
    const base = defaultSettings();
    const next = updateSettings(base, { defaults: { verify: true } });
    expect(base.defaults.verify).toBe(false);
    expect(next.defaults.verify).toBe(true);
    expect(next.defaults.autoApprove).toBe(true); // 其余键保留
  });
});

// ---------------------------------------------------------------
// 旧键迁移与 composer 默认值
// ---------------------------------------------------------------
describe("旧键迁移与 composer 默认值派生", () => {
  it("settings 未显式记录 autoApprove 时，旧键 0/1 播种并落盘", () => {
    const st = fakeStorage({ [LEGACY_AUTO_APPROVE_KEY]: "0" });
    const { settings, migrated } = migrateLegacyPrefs(st, loadSettings(st));
    expect(migrated).toBe(true);
    expect(settings.defaults.autoApprove).toBe(false);
    // 已落盘：下次读直接拿到
    expect(loadSettings(st).defaults.autoApprove).toBe(false);
  });

  it("settings 已显式记录 → 以 settings 为准，不被旧键覆盖", () => {
    const explicit = updateSettings(defaultSettings(), { defaults: { autoApprove: true } });
    const st = fakeStorage({
      [SETTINGS_STORAGE_KEY]: JSON.stringify(explicit),
      [LEGACY_AUTO_APPROVE_KEY]: "0",
    });
    const { settings, migrated } = migrateLegacyPrefs(st, loadSettings(st));
    expect(migrated).toBe(false);
    expect(settings.defaults.autoApprove).toBe(true);
  });

  it("旧键缺失 / 值非法 / storage 为 null → 不迁移", () => {
    expect(migrateLegacyPrefs(fakeStorage(), defaultSettings()).migrated).toBe(false);
    expect(migrateLegacyPrefs(fakeStorage({ [LEGACY_AUTO_APPROVE_KEY]: "是" }), defaultSettings()).migrated).toBe(false);
    expect(migrateLegacyPrefs(null, defaultSettings()).migrated).toBe(false);
  });

  it("composerDefaults 派生三项默认值", () => {
    const s = updateSettings(defaultSettings(), {
      defaults: { effort: "medium", verify: true, autoApprove: false },
    });
    expect(composerDefaults(s)).toEqual({ effort: "medium", verify: true, autoApprove: false });
    expect(composerDefaults(defaultSettings())).toEqual({ effort: "", verify: false, autoApprove: true });
  });

  it("isValidEffort：空串恒合法；档位必须在服务端声明集合里", () => {
    expect(isValidEffort("", null)).toBe(true);
    expect(isValidEffort("high", ["low", "medium", "high"])).toBe(true);
    expect(isValidEffort("high", ["low"])).toBe(false);
    expect(isValidEffort("high", null)).toBe(false);
  });
});

// ---------------------------------------------------------------
// composer 默认值注入（纯函数化的 DOM 触碰）
// ---------------------------------------------------------------
describe("applyComposerDefaults 注入 composer", () => {
  function makeControls() {
    document.body.innerHTML = `
      <input type="checkbox" id="verify-toggle" />
      <input type="checkbox" id="auto-approve-toggle" checked />
      <select id="effort-select">
        <option value="">默认</option>
        <option value="low">低</option>
        <option value="high">高</option>
      </select>`;
    return {
      verifyToggle: document.getElementById("verify-toggle"),
      autoApproveToggle: document.getElementById("auto-approve-toggle"),
      effortSelect: document.getElementById("effort-select"),
    };
  }

  it("三项默认值注入对应控件", () => {
    const c = makeControls();
    const applied = applyComposerDefaults(c, { effort: "high", verify: true, autoApprove: false });
    expect(applied).toEqual({ effort: true, verify: true, autoApprove: true });
    expect(c.verifyToggle.checked).toBe(true);
    expect(c.autoApproveToggle.checked).toBe(false);
    expect(c.effortSelect.value).toBe("high");
  });

  it("effort 为空串 = 跟随服务端默认，不动 select", () => {
    const c = makeControls();
    c.effortSelect.value = "low"; // 服务端默认档
    const applied = applyComposerDefaults(c, { effort: "" });
    expect(applied.effort).toBe(false);
    expect(c.effortSelect.value).toBe("low");
  });

  it("非法档位被忽略（设置里是服务端没有的档）", () => {
    const c = makeControls();
    const applied = applyComposerDefaults(c, { effort: "xhigh" }, { effortLevels: ["low", "high"] });
    expect(applied.effort).toBe(false);
    expect(c.effortSelect.value).toBe(""); // 保持原位
  });

  it("只应用 patch 里出现的键：用户在 composer 的当次改动不被无关项覆盖", () => {
    const c = makeControls();
    c.verifyToggle.checked = true; // 用户当次勾的
    const applied = applyComposerDefaults(c, { autoApprove: false });
    expect(applied.verify).toBe(false);
    expect(c.verifyToggle.checked).toBe(true); // 没被动
    expect(c.autoApproveToggle.checked).toBe(false);
  });
});

// ---------------------------------------------------------------
// 路由判定 / 文案 / 快捷键表
// ---------------------------------------------------------------
describe("路由判定与静态数据", () => {
  it("isSettingsRoute 只认 #/settings", () => {
    expect(isSettingsRoute(SETTINGS_HASH)).toBe(true);
    expect(isSettingsRoute("#/")).toBe(false);
    expect(isSettingsRoute("#/run/abc/loop")).toBe(false);
    expect(isSettingsRoute("")).toBe(false);
    expect(isSettingsRoute(null)).toBe(false);
  });

  it("permissionStateLabel 覆盖四种状态", () => {
    expect(permissionStateLabel("granted")).toContain("已授权");
    expect(permissionStateLabel("denied")).toContain("已被浏览器拒绝");
    expect(permissionStateLabel("default")).toContain("未决定");
    expect(permissionStateLabel(null)).toContain("不支持");
  });

  it("快捷键一览与命令面板帮助同源（同一份 SHORTCUTS）", () => {
    const rows = shortcutRows();
    expect(rows).toHaveLength(SHORTCUTS.length);
    expect(rows.map((r) => r.keys)).toEqual(SHORTCUTS.map((s) => s.keys));
    expect(rows.some((r) => r.keys.includes("K"))).toBe(true); // Ctrl+K 在列
    expect(rows.some((r) => r.keys.includes("Enter"))).toBe(true); // Ctrl+Enter 在列
  });

  it("badgeEnabled：缺省 true，显式 false 才关", () => {
    expect(badgeEnabled(defaultSettings())).toBe(true);
    expect(badgeEnabled(updateSettings(defaultSettings(), { badge: false }))).toBe(false);
    expect(badgeEnabled(null)).toBe(true);
  });
});

describe("parsePacksPayload", () => {
  it("坏形状 → null；缺 drafts 当空列表；不把 systemPrompt 带进视图", () => {
    expect(parsePacksPayload(null)).toBeNull();
    expect(parsePacksPayload("x")).toBeNull();
    const parsed = parsePacksPayload({
      drafts: [{ name: "thermo", description: "热电偶", systemPrompt: "SECRET" }],
      installed: [{ name: "" }, { name: "ok", description: 1 }],
      root: "/tmp/packs",
    });
    expect(parsed.drafts).toEqual([
      { name: "thermo", description: "热电偶", measured: false, builtinTools: [], verifyEnabled: false },
    ]);
    expect(parsed.drafts[0]).not.toHaveProperty("systemPrompt");
    expect(parsed.installed).toEqual([
      { name: "ok", description: "", measured: false, builtinTools: [], verifyEnabled: false },
    ]);
    expect(parsed.root).toBe("/tmp/packs");
  });
});

// ---------------------------------------------------------------
// DOM 层
// ---------------------------------------------------------------
describe("initSettingsView 视图行为", () => {
  const LEVELS = ["low", "medium", "high"];
  const SNAP = {
    version: "9.9.9-test",
    workdir: "D:\\repo",
    effortLevels: LEVELS,
  };

  function makeHost(overrides = {}) {
    return {
      getTheme: vi.fn(() => "dark"),
      onSelectTheme: vi.fn(),
      getHarnessSnapshot: vi.fn(() => SNAP),
      onApplyComposerDefaults: vi.fn(),
      onReplayOnboarding: vi.fn(),
      onOpenSettings: vi.fn(),
      onCloseSettings: vi.fn(),
      onAnnounce: vi.fn(),
      ...overrides,
    };
  }

  function makeEnv(overrides = {}) {
    return {
      doc: document,
      win: window,
      storage: fakeStorage(),
      Notification: {
        permission: "default",
        requestPermission: vi.fn((cb) => {
          cb("granted");
          return Promise.resolve("granted");
        }),
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    document.body.innerHTML = `
      <aside class="sidebar">
        <button type="button" id="settings-open-btn" aria-label="打开设置"><i class="ph ph-gear"></i><span>设置</span></button>
      </aside>
      <main id="main-panel"></main>`;
    document.body.classList.remove("settings-badge-off");
  });

  it("初始化挂出隐藏视图（进 #main-panel），重复初始化幂等", () => {
    const api = initSettingsView(makeHost(), makeEnv());
    const view = document.getElementById("settings-view");
    expect(view).not.toBeNull();
    expect(view.hidden).toBe(true);
    expect(view.parentElement.id).toBe("main-panel");
    const again = initSettingsView(makeHost(), makeEnv());
    expect(again.element).toBe(view);
  });

  it("侧栏齿轮点击 → host.onOpenSettings（宿主写 hash 路由）", () => {
    const host = makeHost();
    initSettingsView(host, makeEnv());
    document.getElementById("settings-open-btn").click();
    expect(host.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("open/close：显隐 + 焦点管理（开时焦点进视图，关时还原到来处）", () => {
    const host = makeHost();
    const api = initSettingsView(host, makeEnv());
    const gear = document.getElementById("settings-open-btn");
    gear.focus();
    api.open();
    expect(api.isOpen()).toBe(true);
    expect(api.element.hidden).toBe(false);
    expect(api.element.contains(document.activeElement)).toBe(true);
    api.close();
    expect(api.isOpen()).toBe(false);
    expect(api.element.hidden).toBe(true);
    expect(document.activeElement).toBe(gear);
  });

  it("「返回」按钮 → host.onCloseSettings（由来处/深链的策略在宿主）", () => {
    const host = makeHost();
    const api = initSettingsView(host, makeEnv());
    api.open();
    api.element.querySelector(".settings-back").click();
    expect(host.onCloseSettings).toHaveBeenCalledTimes(1);
  });

  it("外观：radio 反映当前主题，改动派发给 host.onSelectTheme", () => {
    const host = makeHost();
    const api = initSettingsView(host, makeEnv());
    api.open();
    const radios = [...api.element.querySelectorAll('input[name="settings-theme"]')];
    expect(radios).toHaveLength(THEME_CHOICES.length);
    expect(radios.find((r) => r.value === "dark").checked).toBe(true);
    const light = radios.find((r) => r.value === "light");
    light.checked = true;
    light.dispatchEvent(new Event("change", { bubbles: true }));
    expect(host.onSelectTheme).toHaveBeenCalledWith("light");
  });

  it("运行默认值：改动持久化到 agent-ui-settings 并实时同步 composer", () => {
    const env = makeEnv();
    const host = makeHost();
    const api = initSettingsView(host, env);
    api.open();

    const verify = api.element.querySelector("#settings-verify");
    verify.checked = true;
    verify.dispatchEvent(new Event("change", { bubbles: true }));
    expect(host.onApplyComposerDefaults).toHaveBeenCalledWith({ verify: true });
    const stored = parseSettings(env.storage.getItem(SETTINGS_STORAGE_KEY));
    expect(stored.defaults.verify).toBe(true);

    // 思考强度：档位由快照声明，第一档是「跟随服务端默认」
    const effort = api.element.querySelector("#settings-effort");
    expect(effort.options[0].value).toBe("");
    expect([...effort.options].map((o) => o.value)).toEqual(["", ...LEVELS]);
    effort.value = "medium";
    effort.dispatchEvent(new Event("change", { bubbles: true }));
    expect(host.onApplyComposerDefaults).toHaveBeenCalledWith({ effort: "medium" });
    expect(parseSettings(env.storage.getItem(SETTINGS_STORAGE_KEY)).defaults.effort).toBe("medium");
  });

  it("自动放行默认值：settings 与旧键一起写（同源）", () => {
    const env = makeEnv();
    const host = makeHost();
    const api = initSettingsView(host, env);
    api.open();
    const toggle = api.element.querySelector("#settings-auto-approve");
    expect(toggle.checked).toBe(true); // 默认开
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    expect(parseSettings(env.storage.getItem(SETTINGS_STORAGE_KEY)).defaults.autoApprove).toBe(false);
    expect(env.storage.getItem(LEGACY_AUTO_APPROVE_KEY)).toBe("0");
    expect(host.onApplyComposerDefaults).toHaveBeenCalledWith({ autoApprove: false });
  });

  it("关于：再看一遍新手引导走宿主回调", () => {
    const host = makeHost();
    const api = initSettingsView(host, makeEnv());
    api.open();
    api.element.querySelector("#settings-onboarding-replay").click();
    expect(host.onReplayOnboarding).toHaveBeenCalledTimes(1);
  });

  it("通知：展示授权状态；点请求授权走 Notification 并与 notifications.js 同源落 prompt 键", () => {
    const env = makeEnv();
    const api = initSettingsView(makeHost(), env);
    api.open();
    const state = api.element.querySelector("#settings-notify-state");
    expect(state.textContent).toContain("未决定");
    const btn = api.element.querySelector("#settings-notify-request");
    expect(btn.hidden).toBe(false);
    btn.click();
    expect(env.Notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(env.storage.getItem(PROMPT_STORAGE_KEY)).toBe("granted");
  });

  it("通知：已被浏览器拒绝时不给请求按钮，如实提示", () => {
    const env = makeEnv({ Notification: { permission: "denied" } });
    const api = initSettingsView(makeHost(), env);
    api.open();
    expect(api.element.querySelector("#settings-notify-state").textContent).toContain("已被浏览器拒绝");
    expect(api.element.querySelector("#settings-notify-request").hidden).toBe(true);
  });

  it("通知：浏览器不支持时如实展示，不弹按钮", () => {
    const env = makeEnv({ Notification: null });
    const api = initSettingsView(makeHost(), env);
    api.open();
    expect(api.element.querySelector("#settings-notify-state").textContent).toContain("不支持");
    expect(api.element.querySelector("#settings-notify-request").hidden).toBe(true);
  });

  it("应用内角标：关掉即加 body 类并持久化，启动时（未开视图）也生效", () => {
    const env = makeEnv();
    const api = initSettingsView(makeHost(), env);
    // 初始化即应用偏好（默认开 → 无类）
    expect(document.body.classList.contains("settings-badge-off")).toBe(false);
    api.open();
    const toggle = api.element.querySelector("#settings-badge");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.body.classList.contains("settings-badge-off")).toBe(true);
    expect(parseSettings(env.storage.getItem(SETTINGS_STORAGE_KEY)).badge).toBe(false);
  });

  it("快捷键分组：行数与 SHORTCUTS 一致", () => {
    const api = initSettingsView(makeHost(), makeEnv());
    api.open();
    const rows = api.element.querySelectorAll(".settings-shortcut-row");
    expect(rows).toHaveLength(SHORTCUTS.length);
  });

  it("关于：快照有版本与工作目录就用快照，没有则版本兜底 1.3.0", () => {
    const api = initSettingsView(makeHost(), makeEnv());
    api.open();
    expect(api.element.querySelector("#settings-about-name").textContent).toBe("Agent Harness");
    expect(api.element.querySelector("#settings-about-version").textContent).toBe("9.9.9-test");
    expect(api.element.querySelector("#settings-about-workdir").textContent).toBe("D:\\repo");

    // 无快照：版本回落 FALLBACK_VERSION，工作目录如实「未获取」
    document.body.innerHTML = `<main id="main-panel"></main>`;
    const api2 = initSettingsView(makeHost({ getHarnessSnapshot: () => null }), makeEnv());
    api2.open();
    expect(api2.element.querySelector("#settings-about-version").textContent).toBe(FALLBACK_VERSION);
    expect(api2.element.querySelector("#settings-about-workdir").textContent).toBe("未获取");
  });

  it("锚点导航：分组按钮齐全，点击把焦点交给目标分组", () => {
    const api = initSettingsView(makeHost(), makeEnv());
    api.open();
    const navBtns = [...api.element.querySelectorAll(".settings-nav-btn")];
    expect(navBtns.map((b) => b.getAttribute("data-section"))).toEqual(
      SETTINGS_SECTIONS.map((s) => s.id),
    );
    expect(SETTINGS_SECTIONS.some((s) => s.id === "settings-mcp")).toBe(true);
    expect(SETTINGS_SECTIONS.some((s) => s.id === "settings-packs")).toBe(true);
    expect(SETTINGS_SECTIONS.map((s) => s.id).indexOf("settings-packs")).toBe(
      SETTINGS_SECTIONS.map((s) => s.id).indexOf("settings-mcp") + 1,
    );
    expect(SETTINGS_SECTIONS.some((s) => s.id === "settings-usage" && s.label === "消耗")).toBe(true);
    expect(SETTINGS_SECTIONS.map((s) => s.id).indexOf("settings-usage")).toBeLessThan(
      SETTINGS_SECTIONS.map((s) => s.id).indexOf("settings-about"),
    );
    const defaultsBtn = navBtns.find((b) => b.getAttribute("data-section") === "settings-defaults");
    defaultsBtn.click();
    const target = document.getElementById("settings-defaults");
    expect(document.activeElement).toBe(target);
  });

  it("消耗分组：无 fetchUsage 仍有锚点；有则嵌进台账图", async () => {
    const api = initSettingsView(makeHost(), makeEnv());
    api.open();
    expect(api.element.querySelector("#settings-usage")).toBeTruthy();
    expect(api.element.querySelector("#settings-usage-cards")).toBeNull();
    expect(api.element.querySelector("#settings-usage .settings-card-note")?.textContent).toContain("台账");

    document.body.innerHTML = `<main id="main-panel"></main>`;
    const host = makeHost({
      nowUsage: () => Date.parse("2026-09-09T12:00:00"),
      fetchUsage: async () => ({
        totalRuns: 1,
        totalTurns: 8,
        totalUsd: 0.08,
        unpricedRuns: 0,
        byDay: [{ day: "2026-09-07", runs: 1, turns: 8, usd: 0.08, unpricedRuns: 0 }],
        byModel: [{ model: "pro", runs: 1, turns: 8, usd: 0.08, unpricedRuns: 0 }],
        byDayModel: [{ day: "2026-09-07", model: "pro", runs: 1, turns: 8, usd: 0.08, unpricedRuns: 0 }],
      }),
    });
    const api2 = initSettingsView(host, makeEnv());
    api2.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(api2.element.querySelector("#settings-usage-cards")?.textContent).toContain("pro");
    expect(api2.element.querySelector("#settings-usage-cards")?.textContent).toContain("8 轮");
    expect(api2.element.querySelectorAll("#settings-usage .usage-col")).toHaveLength(7);
  });

  it("open 时从存储重读：外部（composer）刚写过的值立刻反映到控件", () => {
    const env = makeEnv();
    const api = initSettingsView(makeHost(), env);
    // 模拟 composer 侧改动落了盘
    env.storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify(updateSettings(defaultSettings(), { defaults: { verify: true } })),
    );
    api.open();
    expect(api.element.querySelector("#settings-verify").checked).toBe(true);
  });

  it("领域包分组：列出草稿，安装后回调宿主刷新菜单", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = vi.fn(async (url, opts = {}) => {
      calls.push({ url, method: opts.method });
      if (String(url).includes("/install")) {
        return { ok: true, status: 200, json: async () => ({ ok: true, drafts: [], installed: [{ name: "thermo", description: "热电偶" }] }) };
      }
      if (String(url).startsWith("/api/packs")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            drafts: [{ name: "thermo", description: "热电偶" }],
            installed: [],
            root: "D:\\\\packs",
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ models: [], roles: { executor: null, planner: null, verifier: null, vision: null, image: null }, source: "env" }) };
    });
    const host = makeHost({ onPacksChanged: vi.fn() });
    const api = initSettingsView(host, makeEnv({ fetchImpl }));
    api.open();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(api.element.querySelector("#settings-packs-drafts").textContent).toContain("thermo");
    expect(api.element.querySelector("#settings-packs")).not.toBeNull();
    api.element.querySelector("[data-pack-install='thermo']").click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(host.onPacksChanged).toHaveBeenCalled();
    expect(calls.some((c) => c.method === "POST" && String(c.url).includes("/drafts/thermo/install"))).toBe(true);
  });

  it("MCP 市场：卡片不是论文，详情收起，安装仍走 confirm", async () => {
    const record = {};
    const confirm = vi.fn(() => true);
    const prevConfirm = window.confirm;
    window.confirm = confirm;
    try {
      const api = initSettingsView(makeHost(), makeEnv({ fetchImpl: marketFetcher(record) }));
      api.open();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      const section = document.getElementById("settings-mcp");
      expect(section.querySelector("#settings-mcp-lede")?.textContent).toBe(MCP_MARKET_HEADER);
      expect(section.textContent).not.toContain("不是 Cursor Marketplace");

      const catalog = document.getElementById("settings-mcp-catalog");
      const feishu = catalog.querySelector('[data-catalog-id="feishu-lark"]');
      const slack = catalog.querySelector('[data-catalog-id="slack"]');
      const missing = catalog.querySelector('[data-catalog-id="google-workspace"]');
      expect(cardFaceText(feishu)).toContain("飞书");
      expect(cardFaceText(feishu)).toContain("安装");
      expect(cardFaceText(feishu)).not.toContain("AGENT_FEISHU_WEBHOOK");
      expect(cardFaceText(feishu)).not.toContain("Lark OpenAPI");
      for (const phrase of MCP_MARKET_ESSAY_PHRASES) {
        expect(cardFaceText(feishu)).not.toContain(phrase);
      }
      expect(feishu.querySelector("details")?.open).toBeFalsy();
      expect(feishu.querySelector("details")?.textContent).toContain("AGENT_FEISHU_WEBHOOK");

      expect(cardFaceText(slack)).toContain("已安装");
      expect(slack.querySelector("[data-mcp-install]")).toBeNull();
      expect(missing.querySelector("button[disabled]")?.textContent).toBe("不可装");
      expect(cardFaceText(missing)).toMatch(/没有可装/);

      const installed = document.getElementById("settings-mcp-list");
      expect(installed.querySelector("[data-mcp-toggle='slack']")?.textContent).toBe("停用");
      expect(installed.querySelector("[data-mcp-uninstall='slack']")?.textContent).toBe("移除");
      expect(document.getElementById("settings-mcp-github")?.textContent).toBe("安装");
      expect(document.querySelector(".settings-mcp-manual")?.open).toBeFalsy();

      feishu.querySelector("[data-mcp-install]").click();
      expect(confirm).toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 0));
      expect(record.installBody).toMatchObject({ catalogId: "feishu-lark", confirm: true, kind: "mcp" });

      document.getElementById("settings-mcp-filter").value = "飞书";
      document.getElementById("settings-mcp-filter").dispatchEvent(new Event("input"));
      expect(catalog.querySelector('[data-catalog-id="feishu-lark"]')).toBeTruthy();
      expect(catalog.querySelector('[data-catalog-id="slack"]')).toBeNull();
    } finally {
      window.confirm = prevConfirm;
    }
  });
});

const MARKET_FIXTURE = {
  path: "mcp.json",
  enabled: false,
  catalog: [
    {
      id: "feishu-lark",
      title: "飞书 / Lark OpenAPI",
      description: "飞书官方 OpenAPI MCP（文档、日历、会话等）。不是出站 IM 卡片。",
      kind: "mcp",
      availability: "ready",
      repo: "larksuite/lark-openapi-mcp",
      notes: "官方仓库。需要 APP_ID / APP_SECRET。出站 webhook（AGENT_FEISHU_WEBHOOK）是另一条切片。",
    },
    {
      id: "slack",
      title: "Slack",
      description: "MCP 组织参考 stdio 实现。不是 Slack Inc 托管的 HTTP MCP。",
      kind: "mcp",
      availability: "ready",
      notes: "stdio 配方来自参考实现。Slack 官方是托管 HTTP（mcp.slack.com）。",
      mcpSnippet: { name: "slack" },
    },
    {
      id: "superpowers",
      title: "Superpowers",
      description: "obra/superpowers 是 skill/plugin，不是 DomainPack。",
      kind: "skill",
      availability: "ready",
      notes: "安装写入 using-superpowers，不会新增 pack。",
    },
    {
      id: "google-workspace",
      title: "Google Workspace",
      description: "Gmail / Calendar / Drive 不在本目录。",
      kind: "mcp",
      availability: "missing",
      notes: "不收录未经核实的插件，也不会从 Cursor Marketplace 搬运。",
    },
  ],
  servers: [{ name: "slack", command: "npx", enabled: true }],
  skills: [],
  custom: [],
  installedCatalogIds: ["slack"],
  skillInstall: { available: true, reason: "" },
};

function marketFetcher(extra = {}) {
  return vi.fn(async (url, opts = {}) => {
    extra.calls ||= [];
    extra.calls.push({ url, method: opts.method, body: opts.body });
    if (url === "/api/mcp") {
      return { ok: true, status: 200, json: async () => MARKET_FIXTURE };
    }
    if (url === "/api/mcp/install") {
      extra.installBody = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ message: "已写入 mcp.json" }) };
    }
    return { ok: true, status: 200, json: async () => ({ models: [], roles: {}, source: "env" }) };
  });
}

function cardFaceText(card) {
  const clone = card.cloneNode(true);
  clone.querySelectorAll("details").forEach((node) => node.remove());
  return clone.textContent ?? "";
}

describe("MCP / Skills 小型市场", () => {
  const styles = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../ui/public/styles.css"),
    "utf8",
  );

  it("卡面短标题 + 一句，长说明只进详情", () => {
    expect(MCP_MARKET_HEADER).toMatch(/AGENT_UI_MCP=1/);
    expect(MCP_MARKET_HEADER).not.toMatch(/Marketplace|预装二进制|Gmail/);
    expect(mcpMarketFaceHasEssay(MCP_MARKET_HEADER)).toBe(false);
    for (const [id, copy] of Object.entries(MCP_MARKET_COPY)) {
      const face = mcpMarketFaceText({ id, title: "飞书 / Lark OpenAPI 长标题", description: "很长的论文。" });
      expect(face).toContain(copy.title);
      expect(face).toContain(copy.blurb);
      expect(mcpMarketFaceHasEssay(face)).toBe(false);
      expect(face).not.toContain("不是 Cursor Marketplace");
    }
    expect(mcpMarketKindLabel({ kind: "mcp" })).toBe("MCP");
    expect(mcpMarketKindLabel({ kind: "skill" })).toBe("Skill");
    expect(mcpMarketKindLabel({ availability: "missing" })).toBe("缺");
    expect(mcpOneLine("第一句。第二句还很长。", 40)).toBe("第一句");
  });

  it("筛选按短名命中，渲染锁：详情默认收起、安装按钮在", () => {
    const html = renderMcpMarketCardHtml({
      id: "feishu-lark",
      title: "飞书 / Lark OpenAPI",
      description: MARKET_FIXTURE.catalog[0].description,
      notes: MARKET_FIXTURE.catalog[0].notes,
      kind: "mcp",
    });
    expect(html).toContain("安装");
    expect(html).toContain("<summary>详情</summary>");
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toContain("AGENT_FEISHU_WEBHOOK");
    expect(filterMcpMarketItems(MARKET_FIXTURE.catalog, "飞书").map((i) => i.id)).toEqual(["feishu-lark"]);
    expect(filterMcpMarketItems(MARKET_FIXTURE.catalog, "xyzzy")).toEqual([]);
  });

  it("卡面 CSS 禁止字距拉开（避免 MCP 看起来像 MCPP）", () => {
    expect(styles).toMatch(/\.settings-mcp-card,\s*\n\s*\.settings-mcp-card \* \{\s*\n\s*letter-spacing: 0;/);
    expect(styles).toMatch(/\.settings-mcp-grid \{[\s\S]*grid-template-columns: repeat\(2/);
    expect(styles).toMatch(/@media \(max-width: 700px\) \{[\s\S]*\.settings-mcp-grid \{ grid-template-columns: 1fr; \}/);
  });
});

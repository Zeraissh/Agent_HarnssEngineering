// @vitest-environment jsdom
// @ts-nocheck
/**
 * 设置中心「模型」分组（MODEL-02）的回归锁。
 *
 * 分层覆盖：
 *   纯函数层：parseModelsPayload 容错 / roleOptionsFor / roleCurrentLabel /
 *             validateModelDraft / applyModelDelete 降级 / buildModelsPutBody 三态
 *   DOM 层  ：jsdom 里真实初始化 + 注入 fetchImpl——列表渲染与徽标、角色
 *             下拉与现状行、删除被引用模型的降级、保存流程（PUT 体三态 +
 *             onModelsSaved 回调）、测试连接按钮
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  SETTINGS_SECTIONS,
  MODEL_ROLE_META,
  parseModelsPayload,
  newModelId,
  modelOptionLabel,
  roleOptionsFor,
  roleCurrentLabel,
  validateModelDraft,
  applyModelDelete,
  buildModelsPutBody,
  modelsSourceLabel,
  initSettingsView,
} from "../ui/public/features/settings.js";

/** Map backed 假 Storage */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const SERVER_PAYLOAD = {
  models: [
    { id: "m-fast", label: "快模型", provider: "openai", model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com", hasApiKey: true },
    { id: "m-strong", label: "强模型", provider: "anthropic", model: "claude-opus-4-8", baseUrl: "", hasApiKey: false },
  ],
  roles: { executor: "m-fast", planner: null, verifier: "m-strong", vision: null },
  source: "store",
  roleModels: { executor: { model: "deepseek-v4-flash", provider: "openai" } },
};

/** 假 fetch：GET 回 SERVER_PAYLOAD；PUT/POST 记录请求体后回成功。 */
function makeFetcher(record = {}) {
  record.putBodies = [];
  record.testBodies = [];
  const fn = vi.fn(async (url, opts = {}) => {
    if (url === "/api/models" && opts.method === "PUT") {
      record.putBodies.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => SERVER_PAYLOAD };
    }
    if (url === "/api/models/test") {
      record.testBodies.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: true, status: 200, json: async () => SERVER_PAYLOAD };
  });
  return fn;
}

function makeHost(overrides = {}) {
  return {
    getTheme: vi.fn(() => "auto"),
    onSelectTheme: vi.fn(),
    getHarnessSnapshot: vi.fn(() => null),
    onApplyComposerDefaults: vi.fn(),
    onModelsSaved: vi.fn(),
    onOpenSettings: vi.fn(),
    onCloseSettings: vi.fn(),
    onAnnounce: vi.fn(),
    ...overrides,
  };
}

function makeEnv(fetchImpl) {
  return {
    doc: document,
    win: window,
    storage: fakeStorage(),
    Notification: null,
    fetchImpl,
  };
}

/** open() 触发异步 loadModels——等一个宏任务让渲染落定 */
async function openAndSettle(api) {
  api.open();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  document.body.innerHTML = `<main id="main-panel"></main>`;
  document.body.classList.remove("settings-badge-off");
});

// ---------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------
describe("模型分组纯函数", () => {
  it("SETTINGS_SECTIONS 含「模型」分组且位于第二位", () => {
    const idx = SETTINGS_SECTIONS.findIndex((s) => s.id === "settings-models");
    expect(idx).toBe(1);
    expect(SETTINGS_SECTIONS[idx].label).toBe("模型");
  });

  it("parseModelsPayload：坏形状 → null；悬空 roles 收编为 null", () => {
    expect(parseModelsPayload(null)).toBeNull();
    expect(parseModelsPayload({})).toBeNull();
    const parsed = parseModelsPayload({
      models: [{ id: "a", provider: "anthropic", model: "m", label: "", baseUrl: 1, hasApiKey: true }],
      roles: { executor: "a", verifier: "ghost" },
      source: "store",
    });
    expect(parsed.models[0]).toMatchObject({ id: "a", label: "m", baseUrl: "", hasApiKey: true });
    expect(parsed.roles).toEqual({ executor: "a", planner: null, verifier: null, vision: null });
    expect(parsed.source).toBe("store");
  });

  it("roleOptionsFor：可空角色首项是空值标签；executor 无空项", () => {
    const models = parseModelsPayload(SERVER_PAYLOAD).models;
    const verifier = roleOptionsFor("verifier", models);
    expect(verifier[0]).toEqual({ value: "", label: "跟随执行" });
    expect(verifier).toHaveLength(3);
    const vision = roleOptionsFor("vision", models);
    expect(vision[0].label).toBe("不配置");
    const executor = roleOptionsFor("executor", models);
    expect(executor[0].value).toBe("m-fast");
  });

  it("roleCurrentLabel：配置与空值两种形态", () => {
    const { models, roles } = parseModelsPayload(SERVER_PAYLOAD);
    expect(roleCurrentLabel("verifier", models, roles)).toBe("核查 · 强模型（claude-opus-4-8）");
    expect(roleCurrentLabel("planner", models, roles)).toBe("规划 · 跟随执行");
    expect(roleCurrentLabel("vision", models, roles)).toBe("识图 · 不配置");
  });

  it("validateModelDraft：provider / 模型名 / baseUrl 逐条拦截", () => {
    expect(validateModelDraft({ provider: "bogus", model: "m" })).not.toEqual([]);
    expect(validateModelDraft({ provider: "openai", model: " 带空白" })).not.toEqual([]);
    expect(validateModelDraft({ provider: "openai", model: "m", baseUrl: "http://8.8.8.8" })).not.toEqual([]);
    expect(validateModelDraft({ provider: "openai", model: "m", baseUrl: "http://127.0.0.1:8080" })).toEqual([]);
    expect(validateModelDraft({ provider: "anthropic", model: "claude-opus-4-8", baseUrl: "" })).toEqual([]);
  });

  it("applyModelDelete：executor 引用 → 拒绝；其他角色引用 → 重置为空并警告", () => {
    const { models, roles } = parseModelsPayload(SERVER_PAYLOAD);
    const blocked = applyModelDelete(models, roles, "m-fast");
    expect(blocked.error).toContain("执行");
    expect(blocked.models).toHaveLength(2);
    const ok = applyModelDelete(models, roles, "m-strong");
    expect(ok.error).toBeNull();
    expect(ok.models).toHaveLength(1);
    expect(ok.roles.verifier).toBeNull();
    expect(ok.warnings.join()).toContain("核查");
  });

  it("buildModelsPutBody：apiKey 三态——没碰过的不带字段，碰过的含空串也带", () => {
    const { models, roles } = parseModelsPayload(SERVER_PAYLOAD);
    const untouched = buildModelsPutBody(models, roles, new Map());
    expect(untouched.models[0]).not.toHaveProperty("apiKey");
    const touched = buildModelsPutBody(models, roles, new Map([["m-fast", ""], ["m-strong", "sk-new"]]));
    expect(touched.models[0].apiKey).toBe("");
    expect(touched.models[1].apiKey).toBe("sk-new");
    expect(touched.roles).toEqual(roles);
  });

  it("modelsSourceLabel / modelOptionLabel / newModelId 形状", () => {
    expect(modelsSourceLabel("store")).toContain("模型库文件");
    expect(modelsSourceLabel("env")).toContain("环境变量");
    expect(modelOptionLabel(SERVER_PAYLOAD.models[0])).toContain("快模型");
    expect(newModelId()).toMatch(/^[A-Za-z0-9:_-]{1,64}$/);
  });
});

// ---------------------------------------------------------------
// DOM 层
// ---------------------------------------------------------------
describe("模型分组视图行为", () => {
  it("打开视图后渲染模型库列表（含 Key 徽标）与角色下拉现状行", async () => {
    const record = {};
    const api = initSettingsView(makeHost(), makeEnv(makeFetcher(record)));
    await openAndSettle(api);

    const list = document.getElementById("settings-models-list");
    expect(list.textContent).toContain("快模型");
    expect(list.textContent).toContain("deepseek-v4-flash");
    expect(list.textContent).toContain("已存 Key");
    expect(list.textContent).toContain("环境变量 Key");

    const verifierSelect = document.getElementById("settings-role-verifier");
    expect(verifierSelect.value).toBe("m-strong");
    expect(verifierSelect.options[0].textContent).toBe("跟随执行");
    expect(document.getElementById("settings-role-vision-current").textContent).toContain("不配置");
    expect(document.getElementById("settings-models-source").textContent).toContain("模型库文件");

    const executorSelect = document.getElementById("settings-role-executor");
    expect(executorSelect.value).toBe("m-fast");
    expect(executorSelect.options[0].value).not.toBe("");
  });

  it("添加模型：校验失败当场拦截；成功后入库并自动派给空缺的执行者", async () => {
    const record = {};
    const fetchImpl = vi.fn(async (url, opts = {}) => {
      if (url === "/api/models" && opts.method === "PUT") {
        record.put = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => SERVER_PAYLOAD };
      }
      return { ok: true, status: 200, json: async () => ({ models: [], roles: { executor: null, planner: null, verifier: null, vision: null }, source: "env" }) };
    });
    const api = initSettingsView(makeHost(), makeEnv(fetchImpl));
    await openAndSettle(api);
    expect(document.getElementById("settings-models-list").textContent).toContain("模型库为空");

    // 非法 baseUrl → 拦截，不入库
    document.getElementById("settings-model-name").value = "deepseek-v4-flash";
    document.getElementById("settings-model-provider").value = "openai";
    document.getElementById("settings-model-baseurl").value = "http://8.8.8.8";
    document.getElementById("settings-model-submit").click();
    expect(document.getElementById("settings-model-form-status").textContent).toContain("HTTPS");
    expect(document.getElementById("settings-models-list").textContent).toContain("模型库为空");

    // 合法输入 → 入库；执行者空缺时自动指派
    document.getElementById("settings-model-baseurl").value = "https://api.deepseek.com";
    document.getElementById("settings-model-label").value = "快模型";
    document.getElementById("settings-model-submit").click();
    expect(document.getElementById("settings-models-list").textContent).toContain("快模型");
    expect(document.getElementById("settings-role-executor").value).not.toBe("");
    expect(document.getElementById("settings-models-status").textContent).toContain("保存后生效");
  });

  it("删除被引用的模型：verifier 引用 → 角色重置为跟随执行并提示", async () => {
    const record = {};
    const api = initSettingsView(makeHost(), makeEnv(makeFetcher(record)));
    await openAndSettle(api);

    const rows = [...document.querySelectorAll(".settings-model-row")];
    const strongRow = rows.find((r) => r.textContent.includes("强模型"));
    strongRow.querySelectorAll("button")[1].click(); // 删除
    expect(document.getElementById("settings-models-list").textContent).not.toContain("强模型");
    expect(document.getElementById("settings-role-verifier").value).toBe("");
    expect(document.getElementById("settings-models-status").textContent).toContain("核查");
  });

  it("删除执行者正在用的模型 → 拒绝并说明", async () => {
    const record = {};
    const api = initSettingsView(makeHost(), makeEnv(makeFetcher(record)));
    await openAndSettle(api);

    const rows = [...document.querySelectorAll(".settings-model-row")];
    const fastRow = rows.find((r) => r.textContent.includes("快模型"));
    fastRow.querySelectorAll("button")[1].click();
    expect(document.getElementById("settings-models-status").textContent).toContain("执行");
    expect(document.getElementById("settings-models-list").textContent).toContain("快模型");
  });

  it("保存流程：PUT 体的 apiKey 三态 + 成功后 onModelsSaved 回调", async () => {
    const record = {};
    const host = makeHost();
    const api = initSettingsView(host, makeEnv(makeFetcher(record)));
    await openAndSettle(api);

    // 不碰任何 apiKey → PUT 体不带 apiKey 字段
    document.getElementById("settings-models-save").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(record.putBodies).toHaveLength(1);
    for (const m of record.putBodies[0].models) expect(m).not.toHaveProperty("apiKey");
    expect(record.putBodies[0].roles).toEqual(SERVER_PAYLOAD.roles);
    expect(host.onModelsSaved).toHaveBeenCalledTimes(1);
    expect(document.getElementById("settings-models-status").textContent).toContain("进行中的任务不受影响");

    // 编辑快模型并清空 apiKey（碰过 = 清除语义）→ PUT 体带 apiKey: ""
    const rows = [...document.querySelectorAll(".settings-model-row")];
    const fastRow = rows.find((r) => r.textContent.includes("快模型"));
    fastRow.querySelectorAll("button")[0].click(); // 编辑
    const keyInput = document.getElementById("settings-model-apikey");
    keyInput.value = "";
    keyInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    document.getElementById("settings-model-submit").click();
    document.getElementById("settings-models-save").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(record.putBodies).toHaveLength(2);
    expect(record.putBodies[1].models.find((m) => m.id === "m-fast").apiKey).toBe("");
    expect(record.putBodies[1].models.find((m) => m.id === "m-strong")).not.toHaveProperty("apiKey");
  });

  it("测试连接按钮：表单校验通过后打 POST /api/models/test", async () => {
    const record = {};
    const api = initSettingsView(makeHost(), makeEnv(makeFetcher(record)));
    await openAndSettle(api);

    document.getElementById("settings-model-provider").value = "openai";
    document.getElementById("settings-model-name").value = "deepseek-v4-flash";
    document.getElementById("settings-model-baseurl").value = "https://api.deepseek.com";
    document.getElementById("settings-model-test").click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(record.testBodies).toHaveLength(1);
    expect(record.testBodies[0]).toMatchObject({ provider: "openai", model: "deepseek-v4-flash" });
    expect(record.testBodies[0]).not.toHaveProperty("apiKey");
    expect(document.getElementById("settings-model-form-status").textContent).toContain("连接成功");
  });

  it("open(\"settings-models\")：已打开时重复调用只换焦点（命令面板直达路径）", async () => {
    const api = initSettingsView(makeHost(), makeEnv(makeFetcher({})));
    await openAndSettle(api);
    api.open("settings-models");
    expect(document.activeElement?.id).toBe("settings-models");
  });
});

/**
 * ui/model-config.ts 纯逻辑测试——模型库存储（MODEL-02）。
 *
 * 覆盖：
 *   a. 读写 round-trip（原子写 → 读回同一份）
 *   b. 坏文件容错：备份 .bak + 从零开始
 *   c. env 合成初始库（executor 永远在；角色仅 env 配了才有；角色 key 随条目走）
 *   d. PUT 校验：provider 枚举 / 模型名 / baseUrl 白名单 / roles 引用 / executor 必选
 *   e. apiKey 三态：省略 = 沿用；"" = 清除；非空 = 更新
 *   f. 脱敏出栈：redactStore 永不带 apiKey
 *   g. normalizeBaseUrl 规则（https / loopback http / 用户密 / query）
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyStore,
  isValidModelName,
  loadModelStore,
  normalizeBaseUrl,
  parseModelStore,
  redactStore,
  roleEntryOf,
  saveModelStore,
  synthesizeStoreFromEnv,
  validateModelConfig,
  type ModelStore,
} from "../ui/model-config.js";

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "model-config-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sampleStore(): ModelStore {
  return {
    schemaVersion: 1,
    models: [
      { id: "m-a", label: "强模型", provider: "anthropic", model: "claude-opus-4-8", baseUrl: "", apiKey: "sk-secret" },
      { id: "m-b", label: "快模型", provider: "openai", model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com", apiKey: "" },
    ],
    roles: { executor: "m-b", planner: null, verifier: "m-a", vision: null, image: null },
  };
}

describe("读写 round-trip 与坏文件容错", () => {
  it("save → load 读回同一份；roles 引用完整", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, ".agent-models.json");
      saveModelStore(file, sampleStore());
      const loaded = loadModelStore(file);
      expect(loaded.recoveredFromCorrupt).toBe(false);
      expect(loaded.store).toEqual(sampleStore());
    });
  });

  it("文件不存在 → store 为 null（不视为损坏）", async () => {
    await withTempDir(async (dir) => {
      const loaded = loadModelStore(join(dir, "missing.json"));
      expect(loaded.store).toBeNull();
      expect(loaded.recoveredFromCorrupt).toBe(false);
    });
  });

  it("坏 JSON → 备份 .bak 后从零开始", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, ".agent-models.json");
      await writeFile(file, "{ 这不是 JSON", "utf8");
      const loaded = loadModelStore(file);
      expect(loaded.store).toBeNull();
      expect(loaded.recoveredFromCorrupt).toBe(true);
      // 备份里是原文，原文件仍在（等待下次启动覆盖或被用户处理）
      expect(await readFile(`${file}.bak`, "utf8")).toBe("{ 这不是 JSON");
      await access(file);
    });
  });

  it("schema 版本不符 → null；悬空 roles 引用收编为 null", () => {
    expect(parseModelStore(JSON.stringify({ schemaVersion: 99, models: [], roles: {} }))).toBeNull();
    const parsed = parseModelStore(JSON.stringify({
      schemaVersion: 1,
      models: [{ id: "m-a", label: "x", provider: "anthropic", model: "claude-opus-4-8", baseUrl: "", apiKey: "" }],
      roles: { executor: "m-a", verifier: "ghost", planner: 42, vision: null },
    }));
    expect(parsed?.roles).toEqual({ executor: "m-a", planner: null, verifier: null, vision: null, image: null });
  });
});

describe("env 合成初始库", () => {
  it("executor 永远在；未配的角色不入库", () => {
    const store = synthesizeStoreFromEnv({ AGENT_MODEL: "my-model", AGENT_PROVIDER: "openai", OPENAI_BASE_URL: "https://api.deepseek.com" }, {});
    expect(store.roles.executor).toBe("env:executor");
    expect(store.roles.verifier).toBeNull();
    expect(store.models[0]).toMatchObject({
      id: "env:executor",
      provider: "openai",
      model: "my-model",
      baseUrl: "https://api.deepseek.com",
      apiKey: "", // executor 的 key 继续走环境变量
    });
    expect(store.models[0]!.label).toContain("环境变量");
  });

  it("env 配了角色 → 入库初始值；角色专属 API key 随条目走", () => {
    const store = synthesizeStoreFromEnv({}, {
      AGENT_VERIFIER_MODEL: "strong-verifier",
      AGENT_VERIFIER_PROVIDER: "openai",
      AGENT_VERIFIER_BASE_URL: "https://api.moonshot.cn/v1",
      AGENT_VERIFIER_API_KEY: "sk-role-key",
    });
    const entry = roleEntryOf(store, "verifier");
    expect(entry).toMatchObject({
      id: "env:verifier",
      provider: "openai",
      model: "strong-verifier",
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "sk-role-key",
    });
    expect(store.roles.planner).toBeNull();
    expect(store.roles.vision).toBeNull();
    expect(store.roles.image).toBeNull();
  });

  it("env 配了 AGENT_IMAGE_MODEL → 合成 env:image 条目", () => {
    const store = synthesizeStoreFromEnv({}, {
      AGENT_IMAGE_MODEL: "dall-e-3",
      AGENT_IMAGE_PROVIDER: "openai",
      AGENT_IMAGE_BASE_URL: "https://api.openai.com/v1",
      AGENT_IMAGE_API_KEY: "sk-image-role",
    });
    const entry = roleEntryOf(store, "image");
    expect(entry).toMatchObject({
      id: "env:image",
      provider: "openai",
      model: "dall-e-3",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-image-role",
    });
    expect(store.roles.image).toBe("env:image");
  });

  it("非法 AGENT_PROVIDER 回退 anthropic；非法 baseUrl 回退空串", () => {
    const store = synthesizeStoreFromEnv(
      { AGENT_PROVIDER: "bogus", ANTHROPIC_BASE_URL: "http://192.168.1.10:8080" },
      {},
    );
    expect(store.models[0]!.provider).toBe("anthropic");
    expect(store.models[0]!.baseUrl).toBe("");
  });
});

describe("PUT 校验（validateModelConfig）", () => {
  it("合法整表通过；省略 id 的条目由服务端分配", () => {
    const result = validateModelConfig({
      models: [
        { id: "m-a", label: "强模型", provider: "anthropic", model: "claude-opus-4-8", baseUrl: "", apiKey: "sk-1" },
        { label: "新模型", provider: "openai", model: "deepseek-v4-flash" },
      ],
      roles: { executor: "m-a", planner: null, verifier: null, vision: null },
    }, null);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.store.models).toHaveLength(2);
      expect(result.store.models[1]!.id).toMatch(/^[A-Za-z0-9:_-]{1,64}$/);
      expect(result.store.models[1]!.apiKey).toBe("");
    }
  });

  it("provider 枚举 / 模型名 / baseUrl / roles 引用 / executor 必选——逐条 400 文案", () => {
    const base = { provider: "anthropic", model: "claude-opus-4-8" };
    expect(validateModelConfig({ models: [{ ...base, id: "a", provider: "bogus" }], roles: { executor: "a" } }, null))
      .toMatchObject({ ok: false });
    const badName = validateModelConfig({ models: [{ ...base, id: "a", model: " 带空白" }], roles: { executor: "a" } }, null);
    expect(badName.ok).toBe(false);
    const badUrl = validateModelConfig({ models: [{ ...base, id: "a", baseUrl: "http://8.8.8.8" }], roles: { executor: "a" } }, null);
    expect(badUrl.ok).toBe(false);
    if (!badUrl.ok) expect(badUrl.errors.join()).toContain("HTTPS");
    const dangling = validateModelConfig({ models: [{ ...base, id: "a" }], roles: { executor: "a", verifier: "ghost" } }, null);
    expect(dangling.ok).toBe(false);
    const noExecutor = validateModelConfig({ models: [{ ...base, id: "a" }], roles: { executor: null } }, null);
    expect(noExecutor.ok).toBe(false);
    if (!noExecutor.ok) expect(noExecutor.errors.join()).toContain("executor");
  });

  it("apiKey 三态：省略 = 沿用旧值；空串 = 清除；非空 = 更新", () => {
    const previous = sampleStore();
    // 省略 → 沿用 "sk-secret"
    const keep = validateModelConfig({
      models: [{ id: "m-a", label: "改名", provider: "anthropic", model: "claude-opus-4-8", baseUrl: "" }],
      roles: { executor: "m-a", planner: null, verifier: null, vision: null },
    }, previous);
    expect(keep.ok && keep.store.models[0]!.apiKey).toBe("sk-secret");
    // 空串 → 清除
    const clear = validateModelConfig({
      models: [{ id: "m-a", label: "x", provider: "anthropic", model: "claude-opus-4-8", baseUrl: "", apiKey: "" }],
      roles: { executor: "m-a", planner: null, verifier: null, vision: null },
    }, previous);
    expect(clear.ok && clear.store.models[0]!.apiKey).toBe("");
    // 非空 → 更新
    const update = validateModelConfig({
      models: [{ id: "m-a", label: "x", provider: "anthropic", model: "claude-opus-4-8", baseUrl: "", apiKey: "sk-new" }],
      roles: { executor: "m-a", planner: null, verifier: null, vision: null },
    }, previous);
    expect(update.ok && update.store.models[0]!.apiKey).toBe("sk-new");
  });

  it("重复 id / 超量条目被拒", () => {
    const dup = validateModelConfig({
      models: [
        { id: "a", provider: "anthropic", model: "m1" },
        { id: "a", provider: "anthropic", model: "m2" },
      ],
      roles: { executor: "a" },
    }, null);
    expect(dup.ok).toBe(false);
    const tooMany = validateModelConfig({
      models: Array.from({ length: 51 }, (_, i) => ({ id: `m-${i}`, provider: "anthropic", model: "x" })),
      roles: { executor: "m-0" },
    }, null);
    expect(tooMany.ok).toBe(false);
  });
});

describe("脱敏与 baseUrl 规则", () => {
  it("redactStore 永不带 apiKey，只回 hasApiKey", () => {
    const pub = redactStore(sampleStore(), "store");
    const raw = JSON.stringify(pub);
    expect(raw).not.toContain("sk-secret");
    expect(raw).not.toContain("apiKey");
    expect(pub.models[0]!.hasApiKey).toBe(true);
    expect(pub.models[1]!.hasApiKey).toBe(false);
    expect(pub.source).toBe("store");
  });

  it("normalizeBaseUrl：https 直过；loopback http 放行；远程 http / 用户密 / query 全拒", () => {
    expect(normalizeBaseUrl("")).toBe("");
    expect(normalizeBaseUrl(undefined)).toBe("");
    expect(normalizeBaseUrl("https://api.deepseek.com/")).toBe("https://api.deepseek.com");
    expect(normalizeBaseUrl("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
    expect(normalizeBaseUrl("http://localhost:8080/v1")).toBe("http://localhost:8080/v1");
    expect(() => normalizeBaseUrl("http://8.8.8.8")).toThrow(/HTTPS/);
    expect(() => normalizeBaseUrl("https://user:pass@api.x.com")).toThrow(/用户名或密码/);
    expect(() => normalizeBaseUrl("https://api.x.com/v1?key=1")).toThrow(/query/);
    expect(() => normalizeBaseUrl("not a url")).toThrow(/有效 URL/);
  });

  it("isValidModelName 与 provider.ts 同口径", () => {
    expect(isValidModelName("claude-opus-4-8")).toBe(true);
    expect(isValidModelName("")).toBe(false);
    expect(isValidModelName(" padded")).toBe(false);
    expect(isValidModelName("a".repeat(201))).toBe(false);
    expect(isValidModelName("bad" + String.fromCharCode(7) + "name")).toBe(false);
  });

  it("emptyStore 的角色初值全 null", () => {
    expect(emptyStore().roles).toEqual({ executor: null, planner: null, verifier: null, vision: null, image: null });
  });
});

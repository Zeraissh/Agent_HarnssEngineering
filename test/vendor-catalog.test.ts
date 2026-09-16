import { describe, expect, it } from "vitest";
import {
  applyVendorPreset,
  inferVendorFromBaseUrl,
  inferVendorHint,
  publicVendorCatalog,
  vendorById,
  type CatalogModelStore,
} from "../src/vendor-catalog.js";

function emptyStore(): CatalogModelStore {
  return {
    schemaVersion: 1,
    models: [],
    roles: { executor: null, planner: null, verifier: null, vision: null, image: null },
  };
}

describe("厂家预设", () => {
  it("从官方端点认厂家，硅基流动不冒充 DeepSeek", () => {
    expect(inferVendorFromBaseUrl("https://api.deepseek.com/anthropic")).toBe("deepseek");
    expect(inferVendorFromBaseUrl("https://api.moonshot.cn/anthropic")).toBe("kimi");
    expect(inferVendorFromBaseUrl("https://api.openai.com/v1")).toBe("openai");
    expect(inferVendorFromBaseUrl("https://api.siliconflow.cn/v1")).toBeNull();
    expect(inferVendorHint("https://api.siliconflow.cn/v1", "deepseek-v4-flash")).toBe("unlisted");
    expect(inferVendorHint("", "kimi-k3")).toBe("kimi");
    expect(inferVendorHint("https://gateway.example.com", "kimi-k3")).toBeNull();
  });

  it("一把 Key 写入该厂全部预设模型，已有同端点条目更新不重复", () => {
    const vendor = vendorById("kimi")!;
    let ids = 0;
    const first = applyVendorPreset(emptyStore(), vendor, "sk-kimi", () => `m-${++ids}`);
    expect(first.added).toBe(3);
    expect(first.store.models).toHaveLength(3);
    expect(first.store.roles.executor).toBe("m-1");
    expect(first.store.models.every((m) => m.apiKey === "sk-kimi" && m.baseUrl.includes("moonshot"))).toBe(true);

    const second = applyVendorPreset(first.store, vendor, "sk-new", () => `m-${++ids}`);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(3);
    expect(second.store.models).toHaveLength(3);
    expect(second.store.models[0]?.apiKey).toBe("sk-new");
    expect(second.store.roles.executor).toBe("m-1");
  });

  it("已有执行者时不抢角色；出栈不含密钥", () => {
    const store = emptyStore();
    store.models.push({
      id: "m-env",
      label: "环境变量",
      provider: "anthropic",
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "",
    });
    store.roles.executor = "m-env";
    let extra = 0;
    const next = applyVendorPreset(store, vendorById("deepseek")!, "sk-ds", () => `m-x${++extra}`);
    expect(next.store.roles.executor).toBe("m-env");
    expect(next.updated).toBe(1);
    const pub = publicVendorCatalog(next.store);
    expect(pub.find((v) => v.id === "deepseek")?.connected).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("sk-ds");
  });
});

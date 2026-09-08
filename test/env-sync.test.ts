import { describe, expect, it } from "vitest";
import { envUpdatesFromStore, upsertEnvKeys } from "../ui/env-sync.js";

describe("upsertEnvKeys", () => {
  it("保留注释，只改认识的键", () => {
    const existing = "# keep\nAGENT_MODEL=old\nFOO=bar\n";
    const { text, changed } = upsertEnvKeys(existing, { AGENT_MODEL: "new", AGENT_PROVIDER: "openai" });
    expect(text).toContain("# keep");
    expect(text).toContain("FOO=bar");
    expect(text).toMatch(/AGENT_MODEL=new/);
    expect(text).toMatch(/AGENT_PROVIDER=openai/);
    expect(changed).toEqual(["AGENT_MODEL", "AGENT_PROVIDER"]);
  });

  it("null 删除该键，其它行不动", () => {
    const { text, changed } = upsertEnvKeys("A=1\nB=2\n", { A: null });
    expect(text).toBe("B=2\n");
    expect(changed).toEqual(["A"]);
  });

  it("含空格的值加引号", () => {
    const { text } = upsertEnvKeys("", { AGENT_MODEL: "has space" });
    expect(text).toBe('AGENT_MODEL="has space"\n');
  });
});

describe("envUpdatesFromStore", () => {
  it("不写 API key，只写角色模型名", () => {
    const updates = envUpdatesFromStore({
      models: [
        { id: "e", provider: "openai", model: "flash", baseUrl: "https://api.example.com" },
        { id: "v", provider: "anthropic", model: "vl", baseUrl: "" },
      ],
      roles: { executor: "e", vision: "v", planner: null, verifier: null },
    });
    expect(updates.AGENT_MODEL).toBe("flash");
    expect(updates.AGENT_PROVIDER).toBe("openai");
    expect(updates.OPENAI_BASE_URL).toBe("https://api.example.com");
    expect(updates.AGENT_VISION_MODEL).toBe("vl");
    expect(updates.AGENT_IMAGE_MODEL).toBeNull();
    expect(updates.AGENT_PLANNER_MODEL).toBeNull();
    expect(JSON.stringify(updates)).not.toMatch(/sk-|api[_-]?key/i);
  });

  it("生图角色写入 AGENT_IMAGE_*，仍不写 key", () => {
    const updates = envUpdatesFromStore({
      models: [
        { id: "e", provider: "openai", model: "flash", baseUrl: "" },
        { id: "img", provider: "openai", model: "dall-e-3", baseUrl: "https://api.openai.com/v1" },
      ],
      roles: { executor: "e", image: "img" },
    });
    expect(updates.AGENT_IMAGE_MODEL).toBe("dall-e-3");
    expect(updates.AGENT_IMAGE_PROVIDER).toBe("openai");
    expect(updates.AGENT_IMAGE_BASE_URL).toBe("https://api.openai.com/v1");
    expect(JSON.stringify(updates)).not.toMatch(/sk-|api[_-]?key/i);
  });
});

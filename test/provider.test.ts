import { afterEach, describe, expect, it } from "vitest";
import { createModelClientFromEnv } from "../src/provider.js";

const original = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, original);
});

describe("provider credential isolation", () => {
  it("OpenAI provider 不得隐式拿 ANTHROPIC_API_KEY 发给另一个端点", () => {
    process.env.AGENT_PROVIDER = "openai";
    process.env.ANTHROPIC_API_KEY = "anthropic-only-secret";
    delete process.env.OPENAI_API_KEY;
    expect(() => createModelClientFromEnv("some-openai-model")).toThrow();
  });

  it("显式 OPENAI_API_KEY 或角色 override 仍可正常构造", () => {
    process.env.AGENT_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "openai-secret";
    expect(createModelClientFromEnv("some-openai-model").provider).toBe("openai");
    delete process.env.OPENAI_API_KEY;
    expect(createModelClientFromEnv("some-openai-model", { provider: "openai", apiKey: "role-secret" }).provider).toBe("openai");
  });

  it("非法 provider 在创建客户端前 fail closed", () => {
    process.env.AGENT_PROVIDER = "typo-provider";
    expect(() => createModelClientFromEnv("model")).toThrow(/AGENT_PROVIDER 无效/);
  });

  it("模型名首尾空白或控制字符与 doctor 同样 fail closed", () => {
    process.env.ANTHROPIC_API_KEY = "anthropic-secret";
    expect(() => createModelClientFromEnv(" model ")).toThrow(/模型名无效/);
    expect(() => createModelClientFromEnv("model\rforged")).toThrow(/模型名无效/);
  });

  it("携带凭据的远程 HTTP、127 前缀域名、userinfo/query 端点均被拒绝", () => {
    process.env.AGENT_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "openai-secret";
    for (const endpoint of [
      "http://api.attacker.example/v1",
      "http://127.attacker.example/v1",
      "https://user:password@api.example.test/v1",
      "https://api.example.test/v1?token=secret",
    ]) {
      process.env.OPENAI_BASE_URL = endpoint;
      expect(() => createModelClientFromEnv("model")).toThrow(/OPENAI_BASE_URL 无效/);
    }
  });

  it("HTTPS 自定义端点与 loopback HTTP 保持可用", () => {
    process.env.AGENT_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "openai-secret";
    process.env.OPENAI_BASE_URL = "https://api.example.test/v1";
    expect(createModelClientFromEnv("model").provider).toBe("openai");
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:11434/v1";
    expect(createModelClientFromEnv("model").provider).toBe("openai");
    process.env.OPENAI_BASE_URL = "http://localhost:11434/v1";
    expect(createModelClientFromEnv("model").provider).toBe("openai");
  });
});

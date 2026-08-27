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
});

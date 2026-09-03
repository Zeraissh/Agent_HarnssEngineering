/**
 * MODEL-01b 能力 / 健康探针（src/model-capability.ts）。
 *
 * 负向主场：探针失败必须 fail-open 到名称猜测（错成 compat=true 可恢复；
 * 错成 compat=false 会让 DeepSeek 类端点永久 400）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { startMockProvider } from "../eval/mock-provider.js";
import {
  clearCapabilityCache,
  endpointIdentityKey,
  getStickyCapabilities,
  guessCompatFromName,
  probeEndpointCapabilities,
  shouldRunModelProbe,
} from "../src/model-capability.js";
import { createModelClientWithProbe } from "../src/provider.js";

afterEach(() => {
  clearCapabilityCache();
});

describe("guessCompatFromName / shouldRunModelProbe", () => {
  it("openai 一律 compat；anthropic 非 claude-* 即 compat", () => {
    expect(guessCompatFromName("gpt-4o", "openai")).toBe(true);
    expect(guessCompatFromName("claude-opus-4-8", "anthropic")).toBe(false);
    expect(guessCompatFromName("deepseek-v4-pro", "anthropic")).toBe(true);
  });

  it("只有 AGENT_MODEL_PROBE=1 才开；缺省与 =0 都不探针（避免吃掉 mock 脚本）", () => {
    expect(shouldRunModelProbe({ AGENT_MODEL_PROBE: "1" }, "https://api.example.com")).toBe(true);
    expect(shouldRunModelProbe({ AGENT_MODEL_PROBE: "0" }, "http://127.0.0.1:9")).toBe(false);
    expect(shouldRunModelProbe({}, "http://127.0.0.1:9")).toBe(false);
    expect(shouldRunModelProbe({}, "https://api.deepseek.com/anthropic")).toBe(false);
  });
});

describe("probeEndpointCapabilities via mock provider", () => {
  it("compat 端点拒绝 thinking → healthy + compat=true（不靠名称）", async () => {
    const mock = await startMockProvider({
      rejectClaudeExtensions: true,
      scripts: [{ content: [{ type: "text", text: "pong" }] }],
    });
    try {
      // 名称故意伪装成 claude-*：若仍靠名称猜会得到 compat=false
      const caps = await probeEndpointCapabilities({
        identity: {
          provider: "anthropic",
          model: "claude-fake-compat",
          baseURL: mock.anthropicBaseUrl,
        },
        apiKey: "test",
        env: { AGENT_MODEL_PROBE: "1" },
      });
      expect(caps.healthy).toBe(true);
      expect(caps.compat).toBe(true);
      expect(caps.source).toBe("probe");
      expect(caps.reason).toMatch(/compat_rejected/);
    } finally {
      await mock.close();
    }
  });

  it("原生端点接受 thinking → compat=false", async () => {
    const mock = await startMockProvider({
      scripts: [{ content: [{ type: "text", text: "pong" }] }],
    });
    try {
      const caps = await probeEndpointCapabilities({
        identity: {
          provider: "anthropic",
          model: "not-a-claude-name",
          baseURL: mock.anthropicBaseUrl,
        },
        apiKey: "test",
        env: { AGENT_MODEL_PROBE: "1" },
      });
      expect(caps.healthy).toBe(true);
      expect(caps.compat).toBe(false);
      expect(caps.reason).toBe("native_accepted_thinking");
    } finally {
      await mock.close();
    }
  });

  it("上游 503 → unhealthy，compat fail-open 到名称猜测", async () => {
    const mock = await startMockProvider({
      alwaysFault: { type: "status", status: 503 },
    });
    try {
      const caps = await probeEndpointCapabilities({
        identity: {
          provider: "anthropic",
          model: "deepseek-v4-flash",
          baseURL: mock.anthropicBaseUrl,
        },
        apiKey: "test",
        env: { AGENT_MODEL_PROBE: "1" },
      });
      expect(caps.healthy).toBe(false);
      expect(caps.compat).toBe(true); // 名称猜
      expect(caps.reason).toMatch(/503/);
    } finally {
      await mock.close();
    }
  });

  it("未触发探针条件 → source=name，不发 HTTP", async () => {
    let calls = 0;
    const caps = await probeEndpointCapabilities({
      identity: { provider: "anthropic", model: "deepseek-v4-pro", baseURL: "https://api.deepseek.com/anthropic" },
      env: {},
      fetchImpl: (async () => {
        calls += 1;
        throw new Error("should not fetch");
      }) as typeof fetch,
    });
    expect(calls).toBe(0);
    expect(caps.source).toBe("name");
    expect(caps.compat).toBe(true);
    expect(caps.healthy).toBe(true);
  });

  it("粘性缓存命中 → source=sticky，不重复请求", async () => {
    const mock = await startMockProvider({
      rejectClaudeExtensions: true,
    });
    try {
      const identity = {
        provider: "anthropic" as const,
        model: "m",
        baseURL: mock.anthropicBaseUrl,
      };
      const first = await probeEndpointCapabilities({
        identity,
        apiKey: "k",
        env: { AGENT_MODEL_PROBE: "1" },
      });
      const before = mock.requestLog.length;
      const second = await probeEndpointCapabilities({
        identity,
        apiKey: "k",
        env: { AGENT_MODEL_PROBE: "1" },
      });
      expect(second.source).toBe("sticky");
      expect(second.compat).toBe(first.compat);
      expect(mock.requestLog.length).toBe(before);
      expect(getStickyCapabilities(endpointIdentityKey(identity))?.compat).toBe(true);
    } finally {
      await mock.close();
    }
  });
});

describe("createModelClientWithProbe", () => {
  it("探针结果写入 ResolvedProvider.compat（覆盖名称伪装）", async () => {
    const mock = await startMockProvider({ rejectClaudeExtensions: true });
    try {
      const resolved = await createModelClientWithProbe(
        "claude-lookalike",
        { baseURL: mock.anthropicBaseUrl, apiKey: "k" },
        { AGENT_MODEL_PROBE: "1", AGENT_PROVIDER: "anthropic" },
      );
      expect(resolved.compat).toBe(true);
      expect(resolved.capabilities.source).toBe("probe");
    } finally {
      await mock.close();
    }
  });
});

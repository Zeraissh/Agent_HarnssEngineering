/**
 * MODEL-01a 降级链与熔断（src/model-fallback.ts）。
 *
 * 负向路径是这个模块的主场：值钱的不是"降级能成功"，而是
 * **认证失败不许降级**（否则同一个 401 会被打到第二家服务商去，还掩盖真因）、
 * **思考块不许原样转发**（带的是上一家的签名）、
 * **全链熔断时要报错而不是静默**。
 */
import { describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitBreakerRegistry,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_FAILURE_THRESHOLD,
  FallbackModelClient,
  orderEndpointsForRouting,
  readFallbackEnv,
  readRoleFallbackMode,
  stripThinkingBlocks,
} from "../src/model-fallback.js";
import type { FallbackInfo } from "../src/model-fallback.js";
import { clearCapabilityCache, setStickyCapabilities } from "../src/model-capability.js";
import type { ModelClient, ModelRequest, ModelTurn } from "../src/types.js";
import { FakeModelClient, fakeMessage, textBlock } from "./helpers.js";

function apiError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status });
}

/** 每次调用都抛同一个错误的假端点；记录调用次数 */
class ThrowingClient implements ModelClient {
  calls = 0;
  constructor(private readonly err: Error) {}
  send(): Promise<ModelTurn> {
    this.calls += 1;
    return Promise.reject(this.err);
  }
}

function makeRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    system: [{ type: "text", text: "sys" }],
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    maxTokens: 1024,
    effort: "high",
    ...overrides,
  };
}

function okClient(): FakeModelClient {
  return new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]);
}

describe("CircuitBreaker", () => {
  it("closed → N 次失败 → open → 冷却到期 half_open → 成功 → closed", () => {
    let clock = 1_000;
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 500, now: () => clock });

    expect(breaker.state()).toBe("closed");
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state()).toBe("closed"); // 阈值未到，仍放行
    expect(breaker.allow()).toBe(true);

    breaker.recordFailure();
    expect(breaker.state()).toBe("open");
    expect(breaker.allow()).toBe(false);

    clock += 499;
    expect(breaker.state()).toBe("open"); // 差 1ms 也不放行
    expect(breaker.allow()).toBe(false);

    clock += 1;
    expect(breaker.state()).toBe("half_open");
    expect(breaker.allow()).toBe(true);

    breaker.recordSuccess();
    expect(breaker.state()).toBe("closed");
  });

  it("half_open 下再失败立刻重新拉闸，冷却从这一刻重新计时", () => {
    let clock = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100, now: () => clock });

    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state()).toBe("open");

    clock = 100;
    expect(breaker.state()).toBe("half_open");
    breaker.recordFailure(); // 试探失败：不必再攒到阈值
    expect(breaker.state()).toBe("open");

    clock = 199;
    expect(breaker.state()).toBe("open");
    clock = 200;
    expect(breaker.state()).toBe("half_open");
  });

  it("成功清零失败计数：抖动不会跨越很长时间累积成熔断", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 10, now: () => 0 });
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.state()).toBe("closed");
  });

  it("缺省阈值 3 / 冷却 30s", () => {
    let clock = 0;
    const breaker = new CircuitBreaker({ now: () => clock });
    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD - 1; i += 1) breaker.recordFailure();
    expect(breaker.state()).toBe("closed");
    breaker.recordFailure();
    expect(breaker.state()).toBe("open");
    clock = DEFAULT_COOLDOWN_MS - 1;
    expect(breaker.state()).toBe("open");
    clock = DEFAULT_COOLDOWN_MS;
    expect(breaker.state()).toBe("half_open");
  });
});

describe("FallbackModelClient", () => {
  it("primary 瞬时失败（503）→ fallback 成功，onFallback 报出 from/to/reason/turn", async () => {
    const primary = new ThrowingClient(apiError(503, "upstream unavailable"));
    const fallback = okClient();
    const events: FallbackInfo[] = [];
    const client = new FallbackModelClient({
      primary: { name: "primary", client: primary },
      fallbacks: [{ name: "backup", client: fallback }],
      onFallback: (info) => events.push(info),
    });

    const turn = await client.send(makeRequest());
    expect(turn.stopReason).toBe("end_turn");
    expect(primary.calls).toBe(1);
    expect(fallback.requests).toHaveLength(1);
    expect(events).toEqual([
      { from: "primary", to: "backup", reason: "503: upstream unavailable", turn: 1, routing: "sequential" },
    ]);
    expect(client.chain()).toEqual(["primary", "backup"]);
  });

  it("primary 成功时既不降级也不通知", async () => {
    const primary = okClient();
    const fallback = okClient();
    const onFallback = vi.fn();
    const client = new FallbackModelClient({
      primary: { name: "primary", client: primary },
      fallbacks: [{ name: "backup", client: fallback }],
      onFallback,
    });

    await client.send(makeRequest());
    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(0);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("primary 抛 401（非瞬时）→ 不降级、原样上抛", async () => {
    const primary = new ThrowingClient(apiError(401, "invalid api key"));
    const fallback = okClient();
    const onFallback = vi.fn();
    const client = new FallbackModelClient({
      primary: { name: "primary", client: primary },
      fallbacks: [{ name: "backup", client: fallback }],
      onFallback,
    });

    await expect(client.send(makeRequest())).rejects.toThrow("invalid api key");
    expect(fallback.requests).toHaveLength(0);
    expect(onFallback).not.toHaveBeenCalled();
    // 配置错误不计入失败数：否则一串 401 会把健康端点熔断掉
    expect(client.breakerState("primary")).toBe("closed");
  });

  it("stripThinking 的 fallback 收到的消息里没有思考块，且原请求未被改坏", async () => {
    const primary = new ThrowingClient(apiError(503));
    const fallback = okClient();
    const client = new FallbackModelClient({
      primary: { name: "primary", client: primary },
      fallbacks: [{ name: "compat", client: fallback, stripThinking: true }],
    });

    const req = makeRequest({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "内部推理", signature: "sig-of-primary" },
            { type: "redacted_thinking", data: "opaque" },
            { type: "text", text: "答案" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "继续" }] },
      ],
    });
    await client.send(req);

    const sent = fallback.requests[0]!;
    const assistant = sent.messages[1]!.content;
    expect(Array.isArray(assistant)).toBe(true);
    expect(assistant).toEqual([{ type: "text", text: "答案" }]);
    const kinds = sent.messages
      .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
      .map((b) => b.type);
    expect(kinds).not.toContain("thinking");
    expect(kinds).not.toContain("redacted_thinking");

    // 调用方手里的那份请求不能被降级路径改坏（它还要发给下一个端点/被复用）
    const original = req.messages[1]!.content;
    expect(Array.isArray(original) && original).toHaveLength(3);
  });

  it("不带 stripThinking 的端点原样收到思考块", async () => {
    const fallback = okClient();
    const client = new FallbackModelClient({
      primary: { name: "primary", client: new ThrowingClient(apiError(503)) },
      fallbacks: [{ name: "native", client: fallback }],
    });
    await client.send(
      makeRequest({
        messages: [
          { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }] },
        ],
      }),
    );
    const content = fallback.requests[0]!.messages[0]!.content;
    expect(Array.isArray(content) && content[0]!.type).toBe("thinking");
  });

  it("全部失败 → 抛出最后一个错误", async () => {
    const first = apiError(503, "first down");
    const last = apiError(500, "last down");
    const client = new FallbackModelClient({
      primary: { name: "primary", client: new ThrowingClient(first) },
      fallbacks: [{ name: "backup", client: new ThrowingClient(last) }],
    });

    await expect(client.send(makeRequest())).rejects.toThrow("last down");
  });

  it("primary 熔断后直接走 fallback，reason=circuit_open 且 primary 不再被调用", async () => {
    const primary = new ThrowingClient(apiError(503, "down"));
    const fallback = new FakeModelClient([
      fakeMessage([textBlock("a")], "end_turn"),
      fakeMessage([textBlock("b")], "end_turn"),
      fakeMessage([textBlock("c")], "end_turn"),
      fakeMessage([textBlock("d")], "end_turn"),
    ]);
    const events: FallbackInfo[] = [];
    const client = new FallbackModelClient({
      primary: { name: "primary", client: primary },
      fallbacks: [{ name: "backup", client: fallback }],
      breaker: { failureThreshold: 2, cooldownMs: 1_000, now: () => 0 },
      onFallback: (info) => events.push(info),
    });

    await client.send(makeRequest());
    await client.send(makeRequest());
    expect(client.breakerState("primary")).toBe("open");

    await client.send(makeRequest());
    expect(primary.calls).toBe(2); // 第三次没再打扰已隔离的端点
    expect(fallback.requests).toHaveLength(3);
    expect(events.map((e) => e.reason)).toEqual(["503: down", "503: down", "circuit_open"]);
    // turn 按 send 调用递增，供事件流定位是哪一轮切的
    expect(events.map((e) => e.turn)).toEqual([1, 2, 3]);
  });

  it("三级链逐跳报出各自的原因，而不是把上一跳的错误一路复制下去", async () => {
    const events: FallbackInfo[] = [];
    const client = new FallbackModelClient({
      primary: { name: "primary", client: new ThrowingClient(apiError(503, "p down")) },
      fallbacks: [
        { name: "middle", client: new ThrowingClient(apiError(500, "m down")) },
        { name: "last", client: okClient() },
      ],
      onFallback: (info) => events.push(info),
    });

    await client.send(makeRequest());
    expect(events).toEqual([
      { from: "primary", to: "middle", reason: "503: p down", turn: 1, routing: "sequential" },
      { from: "middle", to: "last", reason: "500: m down", turn: 1, routing: "sequential" },
    ]);
  });

  it("全链熔断 → 一次请求都不发，抛出明确的隔离错误", async () => {
    const primary = new ThrowingClient(apiError(503, "p down"));
    const backup = new ThrowingClient(apiError(503, "b down"));
    const client = new FallbackModelClient({
      primary: { name: "primary", client: primary },
      fallbacks: [{ name: "backup", client: backup }],
      breaker: { failureThreshold: 1, cooldownMs: 10_000, now: () => 0 },
    });

    await expect(client.send(makeRequest())).rejects.toThrow("b down");
    expect(client.breakerState("primary")).toBe("open");
    expect(client.breakerState("backup")).toBe("open");

    await expect(client.send(makeRequest())).rejects.toThrow(/熔断隔离/);
    expect(primary.calls).toBe(1);
    expect(backup.calls).toBe(1);
  });

  it("成功后熔断计数清零（半开试探成功即恢复 primary）", async () => {
    let clock = 0;
    const primary = new (class implements ModelClient {
      calls = 0;
      send(): Promise<ModelTurn> {
        this.calls += 1;
        if (this.calls === 1) return Promise.reject(apiError(503, "blip"));
        const message = fakeMessage([textBlock("recovered")], "end_turn");
        return Promise.resolve({ message, stopReason: message.stop_reason, usage: message.usage });
      }
    })();
    const fallback = okClient();
    const client = new FallbackModelClient({
      primary: { name: "primary", client: primary },
      fallbacks: [{ name: "backup", client: fallback }],
      breaker: { failureThreshold: 1, cooldownMs: 100, now: () => clock },
    });

    await client.send(makeRequest());
    expect(client.breakerState("primary")).toBe("open");
    clock = 100;
    await client.send(makeRequest());
    expect(client.breakerState("primary")).toBe("closed");
    expect(fallback.requests).toHaveLength(1); // 只有第一轮借用了 fallback
  });

  it("onDelta 与 signal 透传给实际发出请求的那个端点", async () => {
    const controller = new AbortController();
    const seen: { onDelta?: unknown; signal?: unknown } = {};
    const fallback: ModelClient = {
      send(_req, onDelta, signal) {
        seen.onDelta = onDelta;
        seen.signal = signal;
        const message = fakeMessage([textBlock("ok")], "end_turn");
        return Promise.resolve({ message, stopReason: message.stop_reason, usage: message.usage });
      },
    };
    const client = new FallbackModelClient({
      primary: { name: "primary", client: new ThrowingClient(apiError(503)) },
      fallbacks: [{ name: "backup", client: fallback }],
    });

    const onDelta = vi.fn();
    await client.send(makeRequest(), onDelta, controller.signal);
    expect(seen.onDelta).toBe(onDelta);
    expect(seen.signal).toBe(controller.signal);
  });
});

describe("stripThinkingBlocks", () => {
  it("字符串 content 原样保留", () => {
    const req = makeRequest({ messages: [{ role: "user", content: "hi" }] });
    expect(stripThinkingBlocks(req).messages[0]!.content).toBe("hi");
  });

  it("剥光后不留空 content（空数组是非法请求），改留标记块", () => {
    const req = makeRequest({
      messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }] }],
    });
    expect(stripThinkingBlocks(req).messages[0]!.content).toEqual([
      { type: "text", text: "[thinking omitted]" },
    ]);
  });

  it("system/tools/预算等其余字段照原样带过去", () => {
    const req = makeRequest({ maxTokens: 77, toolChoice: "none" });
    const out = stripThinkingBlocks(req);
    expect(out.maxTokens).toBe(77);
    expect(out.toolChoice).toBe("none");
    expect(out.system).toEqual(req.system);
  });
});

describe("readFallbackEnv", () => {
  it("空环境 → 无端点配置，阈值取缺省", () => {
    expect(readFallbackEnv({})).toEqual({
      failureThreshold: DEFAULT_FAILURE_THRESHOLD,
      cooldownMs: DEFAULT_COOLDOWN_MS,
      routing: "sequential",
    });
  });

  it("读四个端点变量与两个熔断旋钮，顺带修掉首尾空白", () => {
    expect(
      readFallbackEnv({
        AGENT_FALLBACK_MODEL: " deepseek-v4-flash ",
        AGENT_FALLBACK_PROVIDER: "openai",
        AGENT_FALLBACK_BASE_URL: "https://api.deepseek.com",
        AGENT_FALLBACK_API_KEY: "sk-test",
        AGENT_CIRCUIT_FAILURE_THRESHOLD: "5",
        AGENT_CIRCUIT_COOLDOWN_MS: "1500",
      }),
    ).toEqual({
      model: "deepseek-v4-flash",
      provider: "openai",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-test",
      failureThreshold: 5,
      cooldownMs: 1500,
      routing: "sequential",
    });
  });

  it("空串视作未配置", () => {
    const cfg = readFallbackEnv({ AGENT_FALLBACK_MODEL: "   ", AGENT_CIRCUIT_COOLDOWN_MS: "" });
    expect(cfg.model).toBeUndefined();
    expect(cfg.cooldownMs).toBe(DEFAULT_COOLDOWN_MS);
  });

  it("数值非法时抛错而不是静默取默认", () => {
    expect(() => readFallbackEnv({ AGENT_CIRCUIT_FAILURE_THRESHOLD: "0" })).toThrow(
      /AGENT_CIRCUIT_FAILURE_THRESHOLD/,
    );
    expect(() => readFallbackEnv({ AGENT_CIRCUIT_FAILURE_THRESHOLD: "abc" })).toThrow();
    expect(() => readFallbackEnv({ AGENT_CIRCUIT_COOLDOWN_MS: "-1" })).toThrow(
      /AGENT_CIRCUIT_COOLDOWN_MS/,
    );
    expect(() => readFallbackEnv({ AGENT_CIRCUIT_COOLDOWN_MS: "1.5" })).toThrow();
    // 0 是合法的：冷却 0 = 每次都给一次试探机会
    expect(readFallbackEnv({ AGENT_CIRCUIT_COOLDOWN_MS: "0" }).cooldownMs).toBe(0);
  });

  it("AGENT_FALLBACK_ROUTING 只认 sequential / prefer_healthy", () => {
    expect(readFallbackEnv({ AGENT_FALLBACK_ROUTING: "prefer_healthy" }).routing).toBe("prefer_healthy");
    expect(() => readFallbackEnv({ AGENT_FALLBACK_ROUTING: "cheapest" })).toThrow(/AGENT_FALLBACK_ROUTING/);
  });
});

describe("CircuitBreakerRegistry", () => {
  it("同一身份共享熔断状态；不同身份互不影响", () => {
    const reg = new CircuitBreakerRegistry({ failureThreshold: 1, cooldownMs: 10_000, now: () => 0 });
    const a = reg.get("anthropic|m1|https://a.example");
    const a2 = reg.get("anthropic|m1|https://a.example");
    const b = reg.get("anthropic|m1|https://b.example");
    expect(a).toBe(a2);
    a.recordFailure();
    expect(a.state()).toBe("open");
    expect(b.state()).toBe("closed");
  });
});

describe("readRoleFallbackMode", () => {
  it("缺省 none；own 要有 MODEL；inherit 字面量", () => {
    expect(readRoleFallbackMode("verifier", {})).toEqual({ mode: "none" });
    expect(readRoleFallbackMode("verifier", { AGENT_VERIFIER_FALLBACK: "inherit" })).toEqual({
      mode: "inherit",
    });
    const own = readRoleFallbackMode("verifier", {
      AGENT_VERIFIER_FALLBACK_MODEL: "backup-v",
      AGENT_VERIFIER_FALLBACK_PROVIDER: "anthropic",
    });
    expect(own.mode).toBe("own");
    if (own.mode === "own") expect(own.config.model).toBe("backup-v");
    expect(() => readRoleFallbackMode("planner", { AGENT_PLANNER_FALLBACK: "maybe" })).toThrow(
      /AGENT_PLANNER_FALLBACK/,
    );
  });
});

describe("prefer_healthy routing stub", () => {
  it("有健康候选时跳过粘性探针标为不健康的端点，reason=probe_unhealthy", async () => {
    clearCapabilityCache();
    const unhealthyId = { provider: "anthropic" as const, model: "sick", baseURL: "http://127.0.0.1:9" };
    setStickyCapabilities({
      identity: unhealthyId,
      healthy: false,
      compat: true,
      latencyMs: 1,
      source: "probe",
      probedAt: Date.now(),
      reason: "upstream:503",
    });

    const sick = new ThrowingClient(apiError(503, "should-not-call"));
    const healthy = okClient();
    const events: FallbackInfo[] = [];
    const client = new FallbackModelClient({
      primary: { name: "sick", client: sick, identity: unhealthyId },
      fallbacks: [
        {
          name: "well",
          client: healthy,
          identity: { provider: "anthropic", model: "well", baseURL: "http://127.0.0.1:10" },
        },
      ],
      routing: "prefer_healthy",
      onFallback: (info) => events.push(info),
      role: "executor",
    });

    await client.send(makeRequest());
    expect(sick.calls).toBe(0);
    expect(healthy.requests).toHaveLength(1);
    expect(events).toEqual([
      {
        from: "sick",
        to: "well",
        reason: "probe_unhealthy",
        turn: 1,
        role: "executor",
        routing: "prefer_healthy",
      },
    ]);
    clearCapabilityCache();
  });

  it("全不健康时仍尝试（fail-open），不会因探针把整链拒之门外", async () => {
    clearCapabilityCache();
    const idA = { provider: "anthropic" as const, model: "a", baseURL: "http://127.0.0.1:11" };
    const idB = { provider: "anthropic" as const, model: "b", baseURL: "http://127.0.0.1:12" };
    for (const id of [idA, idB]) {
      setStickyCapabilities({
        identity: id,
        healthy: false,
        compat: true,
        latencyMs: 1,
        source: "probe",
        probedAt: Date.now(),
      });
    }
    const a = new ThrowingClient(apiError(503, "a down"));
    const b = okClient();
    const client = new FallbackModelClient({
      primary: { name: "a", client: a, identity: idA },
      fallbacks: [{ name: "b", client: b, identity: idB }],
      routing: "prefer_healthy",
    });
    await client.send(makeRequest());
    expect(a.calls).toBe(1);
    expect(b.requests).toHaveLength(1);
    clearCapabilityCache();
  });
});

describe("orderEndpointsForRouting", () => {
  it("变异：把 prefer_healthy 恒退化成原序会被本用例抓住——不健康必须排后", () => {
    clearCapabilityCache();
    const sick = {
      name: "sick",
      client: okClient(),
      identity: { provider: "anthropic" as const, model: "sick", baseURL: "http://127.0.0.1:13" },
    };
    const well = {
      name: "well",
      client: okClient(),
      identity: { provider: "anthropic" as const, model: "well", baseURL: "http://127.0.0.1:14" },
    };
    setStickyCapabilities({
      identity: sick.identity!,
      healthy: false,
      compat: true,
      latencyMs: null,
      source: "probe",
      probedAt: Date.now(),
    });
    const ordered = orderEndpointsForRouting([sick, well], "prefer_healthy");
    expect(ordered.map((e) => e.name)).toEqual(["well", "sick"]);
    clearCapabilityCache();
  });
});

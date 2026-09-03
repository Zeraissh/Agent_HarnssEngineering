import { describe, expect, it, beforeEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  Counter,
  Histogram,
  MetricsRegistry,
  instrumentModelClient,
  modelCallSeconds,
  modelTtftSeconds,
  obsRegistry,
  observeToolSeconds,
  observeWaitSeconds,
  preregisterObservability,
  resetObservabilityMetrics,
  toolSeconds,
  waitSeconds,
  WAIT_KINDS,
} from "../src/metrics.js";
import { API_ERROR_CLASSES, apiErrorClass } from "../src/model-client.js";
import type { ModelClient, ModelTurn, StreamDelta } from "../src/types.js";
import { fakeMessage, textBlock } from "./helpers.js";

const emptyReq = { system: [], messages: [], tools: [], maxTokens: 64 } as never;

function turnOf(text: string): ModelTurn {
  const message = fakeMessage([textBlock(text)], "end_turn");
  return { message, stopReason: message.stop_reason, usage: message.usage };
}

describe("OBS-02 · 指标原语", () => {
  it("Histogram：桶是累计的，带 +Inf/_sum/_count，标签值转义", () => {
    const h = new Histogram({
      name: "t_seconds",
      help: 'help "with" quotes',
      labelNames: ["role"],
      buckets: [1, 2],
    });
    h.observe({ role: 'a"b' }, 0.5);
    h.observe({ role: 'a"b' }, 1.5);
    h.observe({ role: 'a"b' }, 9);
    const lines = h.render();
    // 累计语义：le=1 只含 0.5；le=2 含 0.5 与 1.5；+Inf 含全部三个
    expect(lines).toContain('t_seconds_bucket{role="a\\"b",le="1"} 1');
    expect(lines).toContain('t_seconds_bucket{role="a\\"b",le="2"} 2');
    expect(lines).toContain('t_seconds_bucket{role="a\\"b",le="+Inf"} 3');
    expect(lines).toContain('t_seconds_count{role="a\\"b"} 3');
    expect(lines).toContain('t_seconds_sum{role="a\\"b"} 11');
  });

  it("Histogram：NaN / 负数样本丢弃——一次污染就毁掉整条曲线的 _sum", () => {
    const h = new Histogram({ name: "t", help: "h", buckets: [1] });
    h.observe({}, Number.NaN);
    h.observe({}, -1);
    h.observe({}, Number.POSITIVE_INFINITY);
    expect(h.snapshot({})).toBeNull(); // 一条都没落，序列都还没出生
    h.observe({}, 0.5);
    expect(h.snapshot({})).toEqual({ count: 1, sum: 0.5 });
  });

  it("preregister：序列以全 0 出生（rate/histogram_quantile 的首抓盲区）", () => {
    const h = new Histogram({ name: "t", help: "h", labelNames: ["kind"], buckets: [1, 5] });
    expect(h.render()).toEqual([]); // 未注册 = 没有任何序列
    h.preregister({ kind: "approval" });
    const lines = h.render();
    expect(lines).toContain('t_bucket{kind="approval",le="1"} 0');
    expect(lines).toContain('t_bucket{kind="approval",le="+Inf"} 0');
    expect(lines).toContain('t_count{kind="approval"} 0');
    // 预注册不得吃掉后续观测
    h.observe({ kind: "approval" }, 3);
    expect(h.snapshot({ kind: "approval" })).toEqual({ count: 1, sum: 3 });
  });

  it("Counter：只增不减，小数按有效位输出，负增量丢弃", () => {
    const c = new Counter({ name: "c_total", help: "h", labelNames: ["role"] });
    c.inc({ role: "execution" }, 0.000_25);
    c.inc({ role: "execution" }, 0.000_25);
    c.inc({ role: "execution" }, -5);
    c.inc({ role: "execution" }, Number.NaN);
    expect(c.get({ role: "execution" })).toBeCloseTo(0.0005, 9);
    expect(c.render()).toContain('c_total{role="execution"} 0.0005');
  });

  it("Registry：renderLines 汇总全部仪器；reset 清空", () => {
    const r = new MetricsRegistry();
    const h = r.histogram({ name: "h_seconds", help: "h", buckets: [1] });
    const c = r.counter({ name: "c_total", help: "c" });
    h.observe({}, 0.5);
    c.inc({}, 2);
    const lines = r.renderLines();
    expect(lines.some((l) => l.startsWith("h_seconds_count"))).toBe(true);
    expect(lines).toContain("c_total 2");
    r.reset();
    expect(r.renderLines()).toEqual([]);
  });
});

describe("OBS-02 · TTFT 与调用时长", () => {
  beforeEach(() => resetObservabilityMetrics());

  /**
   * 这条是整个 OBS-02 延迟面的判据：TTFT **每次调用一个样本**。
   * 每个 delta 都记会把它变成"平均分片间隔"——数字仍然长得像 TTFT，
   * 但回答的是另一个问题，而且没人看得出来。
   */
  it("TTFT 每次调用只落一个样本，取值是第一个 delta 的时刻", async () => {
    let clock = 1000;
    const inner: ModelClient = {
      send: async (_req, onDelta) => {
        clock += 400; // 首个 delta 前的等待
        onDelta?.({ kind: "text", text: "一" });
        clock += 100;
        onDelta?.({ kind: "text", text: "二" });
        clock += 100;
        onDelta?.({ kind: "thinking", text: "三" });
        clock += 400; // 收尾
        return turnOf("整句");
      },
    };
    const client = instrumentModelClient(inner, {
      role: "execution",
      model: "m1",
      now: () => clock,
    });
    await client.send(emptyReq);

    const ttft = modelTtftSeconds.snapshot({ role: "execution", model: "m1" });
    expect(ttft).toEqual({ count: 1, sum: 0.4 });
    const call = modelCallSeconds.snapshot({ role: "execution", model: "m1" });
    expect(call).toEqual({ count: 1, sum: 1 });
  });

  /**
   * 不流式的 wire（或纯 tool_use 无文本的一轮）：**不记**，而不是记 0。
   * 记 0 会让 p95 TTFT 越来越好看，恰好在端点退化时给出反向信号。
   */
  it("整次调用一个 delta 都没有 → TTFT 不落样本，但调用时长照记", async () => {
    let clock = 0;
    const inner: ModelClient = {
      send: async () => {
        clock += 2000;
        return turnOf("只有工具调用，没有文本流");
      },
    };
    await instrumentModelClient(inner, { role: "verification", model: "m2", now: () => clock }).send(
      emptyReq,
    );
    expect(modelTtftSeconds.snapshot({ role: "verification", model: "m2" })).toBeNull();
    expect(modelCallSeconds.snapshot({ role: "verification", model: "m2" })).toEqual({
      count: 1,
      sum: 2,
    });
  });

  it("调用失败也记调用时长（超时被剔掉的话，端点变慢时 p99 反而变好看）", async () => {
    let clock = 0;
    const inner: ModelClient = {
      send: async () => {
        clock += 30_000;
        throw Object.assign(new Error("boom"), { status: 500 });
      },
    };
    const client = instrumentModelClient(inner, { role: "planner", model: "m3", now: () => clock });
    await expect(client.send(emptyReq)).rejects.toThrow("boom");
    expect(modelCallSeconds.snapshot({ role: "planner", model: "m3" })).toEqual({
      count: 1,
      sum: 30,
    });
    expect(modelTtftSeconds.snapshot({ role: "planner", model: "m3" })).toBeNull();
  });

  /**
   * 装饰器不得收窄被装饰者的契约（`meterModelClient` 那条教训的同款锁）：
   * onDelta 与 signal 原样透传；调用方**没传** onDelta 时装饰器也必须自己传一个，
   * 否则 AnthropicModelClient 的 `if (onDelta)` 会整个跳过订阅，TTFT 永远为空。
   */
  it("onDelta / signal 原样透传；调用方不传 onDelta 时装饰器仍自带一个", async () => {
    const controller = new AbortController();
    const seen: StreamDelta[] = [];
    let sawSignal: AbortSignal | undefined;
    let innerGotOnDelta = false;
    const inner: ModelClient = {
      send: async (_req, onDelta, signal) => {
        sawSignal = signal;
        innerGotOnDelta = typeof onDelta === "function";
        onDelta?.({ kind: "text", text: "x" });
        return turnOf("ok");
      },
    };
    const client = instrumentModelClient(inner, { role: "execution", model: "m4" });

    await client.send(emptyReq, (d) => seen.push(d), controller.signal);
    expect(seen).toEqual([{ kind: "text", text: "x" }]);
    expect(sawSignal).toBe(controller.signal);

    await client.send(emptyReq);
    expect(innerGotOnDelta).toBe(true);
    expect(modelTtftSeconds.snapshot({ role: "execution", model: "m4" })?.count).toBe(2);
  });

  it("preregisterObservability：装配了的角色与全部等待种类以 0 出生", () => {
    preregisterObservability([{ role: "execution", model: "m5" }]);
    expect(modelTtftSeconds.snapshot({ role: "execution", model: "m5" })).toEqual({
      count: 0,
      sum: 0,
    });
    for (const kind of WAIT_KINDS) {
      expect(waitSeconds.snapshot({ kind })).toEqual({ count: 0, sum: 0 });
    }
    // 没装配的角色不该凭空长出序列（基数纪律）
    expect(modelTtftSeconds.snapshot({ role: "vision", model: "m5" })).toBeNull();
  });

  it("工具 / 等待观测入口：毫秒转秒", () => {
    observeToolSeconds("bash", 2500);
    observeWaitSeconds("approval", 90_000);
    expect(toolSeconds.snapshot({ tool: "bash" })).toEqual({ count: 1, sum: 2.5 });
    expect(waitSeconds.snapshot({ kind: "approval" })).toEqual({ count: 1, sum: 90 });
    expect(obsRegistry.renderLines().some((l) => l.startsWith("agent_harness_tool_seconds_count"))).toBe(
      true,
    );
  });
});

describe("OBS-02 · 错误类标签", () => {
  it("apiErrorClass：值域固定，SDK 类型与裸 status 都归得了类", () => {
    const hdrs = new Headers();
    const cases: Array<[unknown, string]> = [
      [new Anthropic.AuthenticationError(401, {}, "no key", hdrs), "auth"],
      [new Anthropic.RateLimitError(429, {}, "slow down", hdrs), "rate_limit"],
      [new Anthropic.NotFoundError(404, {}, "no model", hdrs), "not_found"],
      [Object.assign(new Error("x"), { status: 503 }), "server"],
      [Object.assign(new Error("x"), { status: 408 }), "timeout"],
      [Object.assign(new Error("x"), { status: 402 }), "bad_request"],
      [Object.assign(new Error("x"), { name: "AbortError" }), "aborted"],
      [new Error("something odd"), "unknown"],
      [
        Object.assign(new Error("prompt is too long: 300000 tokens > 200000 maximum"), {
          status: 400,
        }),
        "context_overflow",
      ],
    ];
    for (const [err, expected] of cases) {
      expect(apiErrorClass(err)).toBe(expected);
      expect(API_ERROR_CLASSES).toContain(apiErrorClass(err));
    }
  });
});

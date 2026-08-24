/**
 * L0 AnthropicModelClient 的请求构造契约。
 *
 * 为什么补这个（SDK 0.90→0.115 升级窗口暴露的覆盖缺口）：全部 220 个既有测试
 * 都用 FakeModelClient，**没有一个碰到真实 SDK 的入参构造**。于是
 * "compat 剥离 Claude 专属参数 / 非 compat 原样发送" 这条核心契约长期零覆盖——
 * 一次 wire 层改动可以全绿通过却在真机上炸。这里用注入的假 SDK client 捕获
 * 出参，把契约钉死。
 */
import { describe, expect, it } from "vitest";
import { AnthropicModelClient, toAnthropicToolChoice } from "../src/model-client.js";
import type { ModelRequest } from "../src/types.js";

/** 捕获 messages.stream 入参的假 SDK client（形状够用即可，不实现整个 SDK） */
function makeFakeSdk() {
  const calls: Record<string, unknown>[] = [];
  const client = {
    messages: {
      stream(params: Record<string, unknown>) {
        calls.push(params);
        return {
          on() {
            /* 本测试不关心 delta */
          },
          finalMessage: async () => ({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "m",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          }),
        };
      },
    },
  };
  return { client, calls };
}

const req: ModelRequest = {
  system: [{ type: "text", text: "sys" }],
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  maxTokens: 1024,
  effort: "high",
};

describe("AnthropicModelClient 请求构造契约", () => {
  it("非 compat：发送 thinking(adaptive) 与 output_config.effort", async () => {
    const { client, calls } = makeFakeSdk();
    await new AnthropicModelClient("claude-opus-4-8", client as never, { compat: false }).send(req);
    expect(calls).toHaveLength(1);
    expect(calls[0]!["thinking"]).toEqual({ type: "adaptive" });
    expect(calls[0]!["output_config"]).toEqual({ effort: "high" });
  });

  it("compat：Claude 专属参数一个都不发（第三方端点会拒）", async () => {
    const { client, calls } = makeFakeSdk();
    await new AnthropicModelClient("deepseek-v4-pro", client as never, { compat: true }).send(req);
    expect(calls[0]).not.toHaveProperty("thinking");
    expect(calls[0]).not.toHaveProperty("output_config");
  });

  it("compat 缺省按模型名推断：claude-* 为原生，其余为兼容端点", async () => {
    const native = makeFakeSdk();
    await new AnthropicModelClient("claude-opus-4-8", native.client as never).send(req);
    expect(native.calls[0]).toHaveProperty("output_config");

    const third = makeFakeSdk();
    await new AnthropicModelClient("kimi-k3", third.client as never).send(req);
    expect(third.calls[0]).not.toHaveProperty("output_config");
  });

  it("effort 逐档透传，含 SDK 0.115 新增的 max 档", async () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const { client, calls } = makeFakeSdk();
      await new AnthropicModelClient("claude-opus-4-8", client as never, { compat: false }).send({
        ...req,
        effort,
      });
      expect(calls[0]!["output_config"]).toEqual({ effort });
    }
  });

  it("toolChoice=none → tool_choice {type:none}，compat 与否都发（B0b；DeepSeek 兼容端点实测接受）", async () => {
    for (const compat of [false, true]) {
      const { client, calls } = makeFakeSdk();
      await new AnthropicModelClient("m", client as never, { compat }).send({ ...req, toolChoice: "none" });
      expect(calls[0]!["tool_choice"], `compat=${compat}`).toEqual({ type: "none" });
    }
  });

  it("未设 toolChoice 时不发 tool_choice 字段", async () => {
    const { client, calls } = makeFakeSdk();
    await new AnthropicModelClient("m", client as never, { compat: true }).send(req);
    expect(calls[0]).not.toHaveProperty("tool_choice");
  });

  it("基础字段原样透传（model / max_tokens / system / messages / tools）", async () => {
    const { client, calls } = makeFakeSdk();
    await new AnthropicModelClient("claude-opus-4-8", client as never, { compat: false }).send(req);
    expect(calls[0]).toMatchObject({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
    });
  });
});

describe("tool_choice 映射（§2.1）", () => {
  it('"none" → {type:"none"}；强制交付 → {type:"tool", name}', () => {
    expect(toAnthropicToolChoice("none")).toEqual({ type: "none" });
    expect(toAnthropicToolChoice({ type: "tool", name: "submit_verdict" })).toEqual({
      type: "tool",
      name: "submit_verdict",
    });
  });

  it("工具名原样透传——写错这里不会报错，只会静默退化成「没约束」", () => {
    expect(toAnthropicToolChoice({ type: "tool", name: "submit_plan" })).toEqual({
      type: "tool",
      name: "submit_plan",
    });
  });
});

/**
 * 强制工具 × 思考模式（2026-08-15 真机探针催生）。
 *
 * 探针实测（api.deepseek.com/anthropic）：
 *   tool_choice:{type:"tool"} + 思考模式 → 400「Thinking mode does not support this tool_choice」
 *   同一请求加 thinking:{type:"disabled"} → 200 且真的返回 tool_use
 * 这是 Anthropic 协议本身的约束（扩展思考开启时 tool_choice 不能点名具体工具），
 * 不是某个端点的怪癖，所以两种模式统一处理。
 *
 * **没有这条锁，§2.1 会在真机上把收口救援直接烧成 error**——400 是永久性错误，
 * loop 的分类会 finish("error")，比不做还糟。
 */
describe("强制工具必须关掉思考（否则真机 400）", () => {
  const forced: ModelRequest = { ...req, toolChoice: { type: "tool", name: "submit_verdict" } };

  it("非 compat + 强制工具 → thinking 显式 disabled（不是 adaptive）", async () => {
    const { client, calls } = makeFakeSdk();
    await new AnthropicModelClient("claude-opus-4-8", client as never, { compat: false }).send(forced);
    expect(calls[0]!["thinking"]).toEqual({ type: "disabled" });
    expect(calls[0]!["tool_choice"]).toEqual({ type: "tool", name: "submit_verdict" });
  });

  it("compat + 强制工具 → 同样显式关思考（端点默认可能替你开着）", async () => {
    const { client, calls } = makeFakeSdk();
    await new AnthropicModelClient("deepseek-v4-pro", client as never, { compat: true }).send(forced);
    expect(calls[0]!["thinking"]).toEqual({ type: "disabled" });
  });

  it("tool_choice=none 不受影响——禁工具与思考并不冲突", async () => {
    const { client, calls } = makeFakeSdk();
    await new AnthropicModelClient("claude-opus-4-8", client as never, { compat: false }).send({
      ...req,
      toolChoice: "none",
    });
    expect(calls[0]!["thinking"]).toEqual({ type: "adaptive" });
  });
});

describe("降级臂：端点拒绝强制工具时剥掉重发，而不是烧掉整段", () => {
  /** 前 n 次调用抛 400，之后正常 */
  function rejectingSdk(n: number, message: string) {
    const base = makeFakeSdk();
    let seen = 0;
    const calls: Record<string, unknown>[] = [];
    const client = {
      messages: {
        stream(params: Record<string, unknown>) {
          calls.push(params);
          seen += 1;
          if (seen <= n) {
            const err = Object.assign(new Error(message), { status: 400 });
            return { on() {}, finalMessage: async () => { throw err; } };
          }
          return base.client.messages.stream(params);
        },
      },
    };
    return { client, calls };
  }

  const forced: ModelRequest = { ...req, toolChoice: { type: "tool", name: "submit_verdict" } };

  it("400 提到 thinking → 剥掉 tool_choice 重发一次并成功", async () => {
    const { client, calls } = rejectingSdk(1, "Thinking mode does not support this tool_choice");
    const turn = await new AnthropicModelClient("m", client as never, { compat: true }).send(forced);
    expect(calls).toHaveLength(2);
    expect(calls[0]!["tool_choice"], "第一次带强制").toBeDefined();
    expect(calls[1]!["tool_choice"], "重发不带").toBeUndefined();
    expect(turn.stopReason).toBe("end_turn");
  });

  it("记住结论：同一个端点不再每轮撞一次墙", async () => {
    const { client, calls } = rejectingSdk(1, "unsupported tool_choice");
    const c = new AnthropicModelClient("m", client as never, { compat: true });
    await c.send(forced);
    await c.send(forced);
    expect(calls).toHaveLength(3); // 1 撞 + 1 重发 + 第二轮直接不带
    expect(calls[2]!["tool_choice"]).toBeUndefined();
  });

  it("无关的 400 原样抛出——不吞掉真错误，也不白烧一次调用", async () => {
    const { client, calls } = rejectingSdk(1, "messages.0: text content blocks must be non-empty");
    await expect(
      new AnthropicModelClient("m", client as never, { compat: true }).send(forced),
    ).rejects.toThrow("non-empty");
    expect(calls).toHaveLength(1);
  });

  it("没带强制工具时不触发降级——那条路径与本机制无关", async () => {
    const { client, calls } = rejectingSdk(1, "Thinking mode does not support this tool_choice");
    await expect(
      new AnthropicModelClient("m", client as never, { compat: true }).send(req),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

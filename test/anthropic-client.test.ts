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
import { AnthropicModelClient } from "../src/model-client.js";
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

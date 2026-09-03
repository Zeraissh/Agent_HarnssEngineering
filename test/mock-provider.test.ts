/**
 * EVAL-03a — mock provider 的契约测试。
 *
 * 这里测的是**仪器本身**：确定性质量门要拿它当端点替身，那它自己先得可信。
 * 两条线各自钉住：
 *   ①「说对了协议」——真实的 @anthropic-ai/sdk / openai SDK 经由本仓的 L0
 *     客户端跑通全流程，拿到文本、工具调用、stop_reason 与用量；
 *   ②「坏得也对」——429（带 Retry-After）、500、流中途断、慢到超时、坏 JSON
 *     必须真的把客户端打失败，而不是被静默吞成一次空成功。
 *
 * ②比①重要：仪器最危险的失效形态是"故障注入了但没注进去"，那会让整批
 * 失败路径用例变成假绿（本仓 checker-bug / eval 宿主审批打穿都是同族）。
 */
import { afterEach, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import type { Message, TextBlock, ToolUseBlock } from "@anthropic-ai/sdk/resources/messages";
import { AnthropicModelClient, isContextOverflowError, isTransientApiError } from "../src/model-client.js";
import { parseContextWindowFromOverflowError } from "../src/model-capability.js";
import { OpenAIModelClient } from "../src/model-client-openai.js";
import {
  anthropicSseEvents,
  contextOverflowBody,
  openaiSseChunks,
  resolveTurn,
  startMockProvider,
  toOpenAIFinishReason,
  type MockProviderHandle,
  type MockProviderOptions,
} from "../eval/mock-provider.js";
import type { ModelRequest, StreamDelta } from "../src/types.js";

// ------------------------------------------------------------------ 脚手架

const open: MockProviderHandle[] = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

async function mock(opts?: MockProviderOptions): Promise<MockProviderHandle> {
  const handle = await startMockProvider(opts);
  open.push(handle);
  return handle;
}

/** maxRetries 默认 0：请求次数要可数，SDK 的自动重试会把 requestLog 搅浑 */
function anthropicClient(
  handle: MockProviderHandle,
  sdkOpts: { maxRetries?: number; timeout?: number } = {},
): AnthropicModelClient {
  const sdk = new Anthropic({
    baseURL: handle.anthropicBaseUrl,
    apiKey: "mock-key",
    maxRetries: sdkOpts.maxRetries ?? 0,
    timeout: sdkOpts.timeout ?? 5_000,
  });
  return new AnthropicModelClient("mock-model", sdk, { compat: true });
}

function openaiClient(handle: MockProviderHandle, timeoutMs = 5_000): OpenAIModelClient {
  return new OpenAIModelClient("mock-model", {
    baseURL: handle.openaiBaseUrl,
    apiKey: "mock-key",
    maxRetries: 0,
    timeoutMs,
  });
}

const req: ModelRequest = {
  system: [{ type: "text", text: "sys" }],
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  maxTokens: 1024,
  effort: "high",
};

function textOf(message: Message): string {
  return message.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * 裸 fetch 拉一次报文，把 data: 行切出来——不经 SDK，直接看字节。
 * 故障响应（429/500）本来就不是 SSE，那时 datas 为空、看 status/headers 即可。
 */
async function rawSse(
  url: string,
  body: unknown,
): Promise<{ status: number; headers: Headers; text: string; datas: string[] }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const datas = text
    .split("\n\n")
    .map((chunk) => chunk.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => line !== undefined)
    .map((line) => line.slice("data: ".length));
  return { status: res.status, headers: res.headers, text, datas };
}

// ------------------------------------------------------------------ 纯构造

describe("事件构造（纯函数，不起服务）", () => {
  it("缺省回合是简单的 end_turn ok；有 tool_use 块则推断 stop_reason=tool_use", () => {
    expect(resolveTurn(undefined)).toEqual({ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" });
    expect(
      resolveTurn({ content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] }).stopReason,
    ).toBe("tool_use");
    expect(resolveTurn({ content: [{ type: "text", text: "x" }], stopReason: "max_tokens" }).stopReason).toBe(
      "max_tokens",
    );
  });

  it("Anthropic 事件顺序与 index 递增——cut_stream 的 afterEvents 全靠这个顺序可数", () => {
    const events = anthropicSseEvents(
      resolveTurn({
        content: [
          { type: "text", text: "a" },
          { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
        ],
      }),
      { id: "msg_1", model: "m" },
    );
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const toolStart = events[4]!.data as { index: number; content_block: { type: string; name: string } };
    expect(toolStart.index).toBe(1);
    expect(toolStart.content_block).toMatchObject({ type: "tool_use", name: "bash" });
    const toolDelta = events[5]!.data as { delta: { type: string; partial_json: string } };
    expect(toolDelta.delta.type).toBe("input_json_delta");
    expect(JSON.parse(toolDelta.delta.partial_json)).toEqual({ cmd: "ls" });
  });

  it("stop_reason → OpenAI finish_reason 逐值映射", () => {
    expect(toOpenAIFinishReason("end_turn")).toBe("stop");
    expect(toOpenAIFinishReason("tool_use")).toBe("tool_calls");
    expect(toOpenAIFinishReason("max_tokens")).toBe("length");
    expect(toOpenAIFinishReason("refusal")).toBe("content_filter");
  });

  it("OpenAI 末帧带 include_usage 的空 choices 用量帧", () => {
    const chunks = openaiSseChunks(resolveTurn({ content: [{ type: "text", text: "hello" }] }), {
      id: "c1",
      model: "m",
    }) as Array<{ choices: unknown[]; usage?: { total_tokens: number } }>;
    const last = chunks.at(-1)!;
    expect(last.choices).toEqual([]);
    expect(last.usage!.total_tokens).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------ Anthropic wire

describe("Anthropic 流式：真 SDK + AnthropicModelClient", () => {
  it("文本脚本 → 文本、end_turn、用量与流式增量都到齐", async () => {
    const handle = await mock({ scripts: [{ content: [{ type: "text", text: "hello from mock" }] }] });
    const deltas: StreamDelta[] = [];
    const turn = await anthropicClient(handle).send(req, (d) => deltas.push(d));

    expect(textOf(turn.message)).toBe("hello from mock");
    expect(turn.stopReason).toBe("end_turn");
    expect(turn.usage.input_tokens).toBeGreaterThan(0);
    expect(turn.usage.output_tokens).toBeGreaterThan(0);
    expect(deltas.map((d) => d.text).join("")).toBe("hello from mock");
  });

  it("tool_use 脚本 → stop_reason=tool_use，入参经 input_json_delta 还原", async () => {
    const handle = await mock({
      scripts: [
        {
          content: [
            { type: "text", text: "let me look" },
            { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.txt" } },
          ],
        },
      ],
    });
    const turn = await anthropicClient(handle).send(req);

    expect(turn.stopReason).toBe("tool_use");
    const toolUse = turn.message.content.find((b): b is ToolUseBlock => b.type === "tool_use")!;
    expect(toolUse.id).toBe("toolu_1");
    expect(toolUse.name).toBe("read_file");
    expect(toolUse.input).toEqual({ path: "a.txt" });
  });

  it("显式 stopReason 透传（max_tokens 这类非 end_turn 也要能演）", async () => {
    const handle = await mock({ scripts: [{ stopReason: "max_tokens", content: [{ type: "text", text: "cut" }] }] });
    expect((await anthropicClient(handle).send(req)).stopReason).toBe("max_tokens");
  });

  it("脚本按顺序消费，空队列回缺省 ok——多跑一轮不会变成看不懂的报错", async () => {
    const handle = await mock({
      scripts: [{ content: [{ type: "text", text: "one" }] }, { content: [{ type: "text", text: "two" }] }],
    });
    handle.pushScript({ content: [{ type: "text", text: "three" }] });
    expect(handle.remainingScripts()).toBe(3);

    const client = anthropicClient(handle);
    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) seen.push(textOf((await client.send(req)).message));

    expect(seen).toEqual(["one", "two", "three", "ok"]);
    expect(handle.remainingScripts()).toBe(0);
  });

  it("requestLog 记下 wire/path 与请求体：断言「请求真的到了这台服务」的唯一依据", async () => {
    const handle = await mock();
    await anthropicClient(handle).send(req);

    expect(handle.requestLog).toHaveLength(1);
    const entry = handle.requestLog[0]!;
    expect(entry.wire).toBe("anthropic");
    expect(entry.path).toBe("/v1/messages");
    expect(entry.body).toMatchObject({ model: "mock-model", max_tokens: 1024, stream: true });
  });
});

// ------------------------------------------------------------------ OpenAI wire

describe("OpenAI 流式：真 SDK + OpenAIModelClient", () => {
  it("文本脚本 → 文本 + end_turn + 用量映射", async () => {
    const handle = await mock({ scripts: [{ content: [{ type: "text", text: "openai says hi" }] }] });
    const deltas: StreamDelta[] = [];
    const turn = await openaiClient(handle).send(req, (d) => deltas.push(d));

    expect(textOf(turn.message)).toBe("openai says hi");
    expect(turn.stopReason).toBe("end_turn");
    expect(turn.usage.output_tokens).toBeGreaterThan(0);
    expect(deltas.map((d) => d.text).join("")).toBe("openai says hi");
    expect(handle.requestLog[0]!.wire).toBe("openai");
    expect(handle.requestLog[0]!.path).toBe("/v1/chat/completions");
  });

  it("tool_calls 分片 → tool_use 块（两个 wire 在 ModelTurn 上收敛成同一形状）", async () => {
    const handle = await mock({
      scripts: [
        {
          content: [
            { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } },
            { type: "tool_use", id: "call_2", name: "read_file", input: { path: "b.txt" } },
          ],
        },
      ],
    });
    const turn = await openaiClient(handle).send(req);

    expect(turn.stopReason).toBe("tool_use");
    const calls = turn.message.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    expect(calls.map((c) => c.id)).toEqual(["call_1", "call_2"]);
    expect(calls[1]!.input).toEqual({ path: "b.txt" });
  });

  it("裸报文形状：chat.completion.chunk 序列以 [DONE] 收尾", async () => {
    const handle = await mock({ scripts: [{ content: [{ type: "text", text: "raw" }] }] });
    const { status, datas } = await rawSse(`${handle.baseUrl}/v1/chat/completions`, {
      model: "mock-model",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(status).toBe(200);
    expect(datas.at(-1)).toBe("[DONE]");
    const parsed = datas.slice(0, -1).map((d) => JSON.parse(d) as { object: string; choices: unknown[] });
    expect(parsed.every((c) => c.object === "chat.completion.chunk")).toBe(true);
    const contents = parsed
      .flatMap((c) => c.choices as Array<{ delta?: { content?: string } }>)
      .map((c) => c.delta?.content ?? "")
      .join("");
    expect(contents).toBe("raw");
  });
});

// ------------------------------------------------------------------ 故障注入

describe("故障注入：坏得也要对", () => {
  it("429 带 Retry-After，且被 L0 判为可重试的瞬时错误", async () => {
    const handle = await mock({ alwaysFault: { type: "status", status: 429 } });

    const raw = await rawSse(`${handle.baseUrl}/v1/messages`, { model: "m" });
    expect(raw.status).toBe(429);
    expect(raw.headers.get("retry-after")).toBe("1");
    expect(JSON.parse(raw.text)).toMatchObject({ type: "error", error: { type: "rate_limit_error" } });

    const err = await anthropicClient(handle)
      .send(req)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.RateLimitError);
    expect((err as { status?: number }).status).toBe(429);
    expect(isTransientApiError(err)).toBe(true);
    expect(handle.requestLog).toHaveLength(2); // 裸 fetch 一次 + SDK 一次（maxRetries=0）
  });

  it("alwaysFault 不消费脚本队列——它描述端点状态，不是这一轮该说什么", async () => {
    const handle = await mock({
      alwaysFault: { type: "status", status: 500 },
      scripts: [{ content: [{ type: "text", text: "never spoken" }] }],
    });
    await expect(anthropicClient(handle).send(req)).rejects.toThrow();
    expect(handle.remainingScripts()).toBe(1);
  });

  it("SDK 真的会对 429 重试：Retry-After=0 时打到 mock 上是两次请求", async () => {
    const handle = await mock({
      alwaysFault: { type: "status", status: 429, headers: { "Retry-After": "0" } },
    });
    await expect(anthropicClient(handle, { maxRetries: 1 }).send(req)).rejects.toBeInstanceOf(
      Anthropic.RateLimitError,
    );
    expect(handle.requestLog).toHaveLength(2);
  });

  it("500 → APIError(500)，同样算瞬时", async () => {
    const handle = await mock({ alwaysFault: { type: "status", status: 500 } });
    const err = await anthropicClient(handle)
      .send(req)
      .catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(500);
    expect(isTransientApiError(err)).toBe(true);
  });

  it("400 → 不可重试（负向对照：不是所有注入的故障都该被当成瞬时）", async () => {
    const handle = await mock({ alwaysFault: { type: "status", status: 400 } });
    const err = await anthropicClient(handle)
      .send(req)
      .catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(400);
    expect(isTransientApiError(err)).toBe(false);
  });

  /**
   * MEM-01 Phase C：反应式压缩靠 L0 认出"上下文超长"这个 400 子类。两条 wire 的真实 SDK
   * 各把 mock 的报文包成自己的错误对象，都必须被 isContextOverflowError 认出、且不算瞬时。
   * 这条锁的是**真实 wire 上的形状**——纯对象单测认得的字段，SDK 包装后未必还在原位。
   */
  it("context_overflow：两条 wire 的真实 SDK 错误都被判为上下文超长（不算瞬时）", async () => {
    const anthropic = await mock({ scripts: [{ content: [{ type: "text", text: "x" }], fault: { type: "context_overflow" } }] });
    const errA = await anthropicClient(anthropic).send(req).catch((e: unknown) => e);
    expect((errA as { status?: number }).status).toBe(400);
    expect(isContextOverflowError(errA)).toBe(true);
    expect(isTransientApiError(errA)).toBe(false);

    const openai = await mock({ scripts: [{ content: [{ type: "text", text: "x" }], fault: { type: "context_overflow" } }] });
    const errO = await openaiClient(openai).send(req).catch((e: unknown) => e);
    expect((errO as { status?: number }).status).toBe(400);
    expect(isContextOverflowError(errO)).toBe(true);
    expect(isTransientApiError(errO)).toBe(false);
    // 故障消费脚本：下一条请求才是"重发"
    expect(anthropic.remainingScripts()).toBe(0);
  });

  /**
   * MEM-01 窗口 / 预算分离：学习钩子读的是报文里"最大值"那个数。两条 wire 经真实 SDK 包装后
   * 都要能解析出来；`windowTokens` 可替换那个数（缺省 Anthropic 200000 / OpenAI 128000 不动，
   * 与被逐字锁住的真机形状一致）。
   */
  it("context_overflow 的报文经真实 SDK 包装后仍能解析出窗口；windowTokens 可指定", async () => {
    const anthropic = await mock({ scripts: [{ content: [{ type: "text", text: "x" }], fault: { type: "context_overflow" } }] });
    expect(parseContextWindowFromOverflowError(await anthropicClient(anthropic).send(req).catch((e: unknown) => e))).toBe(200_000);
    const openai = await mock({ scripts: [{ content: [{ type: "text", text: "x" }], fault: { type: "context_overflow" } }] });
    expect(parseContextWindowFromOverflowError(await openaiClient(openai).send(req).catch((e: unknown) => e))).toBe(128_000);

    const custom = await mock({
      scripts: [{ content: [{ type: "text", text: "x" }], fault: { type: "context_overflow", windowTokens: 1_048_576 } }],
    });
    const err = await anthropicClient(custom).send(req).catch((e: unknown) => e);
    expect(isContextOverflowError(err)).toBe(true);
    expect(parseContextWindowFromOverflowError(err)).toBe(1_048_576);
    expect(contextOverflowBody("openai", 1_048_576)).toMatchObject({
      error: { message: expect.stringContaining("maximum context length is 1048576 tokens"), code: "context_length_exceeded" },
    });
  });

  it("cut_stream：message_start 之后断流 → 调用失败，不会静默变成空成功", async () => {
    const handle = await mock({
      scripts: [{ content: [{ type: "text", text: "truncated" }], fault: { type: "cut_stream", afterEvents: 2 } }],
    });
    await expect(anthropicClient(handle).send(req)).rejects.toThrow();
    expect(handle.requestLog).toHaveLength(1);
  });

  it("cut_stream 在 OpenAI 侧同样是失败", async () => {
    const handle = await mock({
      scripts: [{ content: [{ type: "text", text: "truncated" }], fault: { type: "cut_stream", afterEvents: 2 } }],
    });
    await expect(openaiClient(handle).send(req)).rejects.toThrow();
  });

  it("bad_json：事件名合法但 data 不是 JSON → 两个 wire 都失败", async () => {
    const anthropic = await mock({ scripts: [{ content: [{ type: "text", text: "x" }], fault: { type: "bad_json" } }] });
    await expect(anthropicClient(anthropic).send(req)).rejects.toThrow();

    const openai = await mock({ scripts: [{ content: [{ type: "text", text: "x" }], fault: { type: "bad_json" } }] });
    await expect(openaiClient(openai).send(req)).rejects.toThrow();
  });

  it("timeout：服务端拖过客户端时限 → APIConnectionTimeoutError（瞬时）", async () => {
    const handle = await mock({ alwaysFault: { type: "timeout", ms: 3_000 } });
    const err = await anthropicClient(handle, { timeout: 120 })
      .send(req)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
    expect(isTransientApiError(err)).toBe(true);
  });

  it("eventDelayMs 拖慢的是流本身，时限够宽就照样成功", async () => {
    const handle = await mock({
      scripts: [{ content: [{ type: "text", text: "slow" }], eventDelayMs: 8 }],
    });
    expect(textOf((await anthropicClient(handle).send(req)).message)).toBe("slow");
  });
});

// ------------------------------------------------------------------ 边界

describe("服务边界", () => {
  it("只监听 loopback——harness 的明文 HTTP 白名单不许在测试里被自己绕过", async () => {
    await expect(startMockProvider({ host: "0.0.0.0" })).rejects.toThrow(/loopback/);
  });

  it("未知路径 404，且不进 requestLog", async () => {
    const handle = await mock();
    const res = await fetch(`${handle.baseUrl}/v1/nope`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    await res.text();
    expect(handle.requestLog).toHaveLength(0);
  });

  it("close() 之后端口不再接受连接", async () => {
    const handle = await startMockProvider();
    const url = `${handle.baseUrl}/v1/messages`;
    await handle.close();
    await expect(fetch(url, { method: "POST", body: "{}" })).rejects.toThrow();
  });
});

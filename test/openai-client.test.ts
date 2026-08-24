import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { fromAccumulated, toOpenAIMessages, toOpenAIToolChoice, toOpenAITools } from "../src/model-client-openai.js";
import type { ModelRequest } from "../src/types.js";

const baseReq = (messages: Anthropic.MessageParam[]): ModelRequest => ({
  system: [{ type: "text", text: "sys A" }, { type: "text", text: "sys B" }],
  messages,
  tools: [],
  maxTokens: 4096,
  effort: "high",
});

describe("toOpenAIMessages（Anthropic → OpenAI 请求翻译）", () => {
  it("system 块合并为首条 system 消息；字符串 content 直通", () => {
    const out = toOpenAIMessages(baseReq([{ role: "user", content: "hi" }]));
    expect(out[0]).toEqual({ role: "system", content: "sys A\n\nsys B" });
    expect(out[1]).toEqual({ role: "user", content: "hi" });
  });

  it("assistant 的 text+tool_use → content + tool_calls（input 序列化为 JSON 串）", () => {
    const out = toOpenAIMessages(
      baseReq([
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "using tool" },
            { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.txt" } },
          ],
        },
      ]),
    );
    const assistant = out[2] as { content: string; tool_calls: { id: string; function: { name: string; arguments: string } }[] };
    expect(assistant.content).toBe("using tool");
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls[0]!.id).toBe("tu_1");
    expect(JSON.parse(assistant.tool_calls[0]!.function.arguments)).toEqual({ path: "a.txt" });
  });

  it("user 消息里的 tool_result 块 → 逐条 role:tool；is_error 降级为内容前缀", () => {
    const out = toOpenAIMessages(
      baseReq([
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "ok data" },
            { type: "tool_result", tool_use_id: "tu_2", content: "boom", is_error: true },
          ],
        },
      ]),
    );
    expect(out[1]).toEqual({ role: "tool", tool_call_id: "tu_1", content: "ok data" });
    expect(out[2]).toEqual({ role: "tool", tool_call_id: "tu_2", content: "[tool error] boom" });
  });

  it("动态上下文的多 text 块 user 消息合并为一条", () => {
    const out = toOpenAIMessages(
      baseReq([
        {
          role: "user",
          content: [
            { type: "text", text: "<context>\ndate: x\n</context>" },
            { type: "text", text: "the task" },
          ],
        },
      ]),
    );
    expect(out).toHaveLength(2);
    expect((out[1] as { content: string }).content).toContain("the task");
    expect((out[1] as { content: string }).content).toContain("<context>");
  });
});

describe("toOpenAITools", () => {
  it("input_schema → function.parameters", () => {
    const tools = toOpenAITools([
      {
        name: "t1",
        description: "d1",
        input_schema: { type: "object", properties: { x: { type: "string" } } },
      } as Anthropic.Tool,
    ]);
    expect(tools[0]).toEqual({
      type: "function",
      function: {
        name: "t1",
        description: "d1",
        parameters: { type: "object", properties: { x: { type: "string" } } },
      },
    });
  });
});

describe("fromAccumulated（OpenAI → ModelTurn 响应翻译）", () => {
  it("tool_calls → tool_use 块 + stop_reason=tool_use", () => {
    const turn = fromAccumulated({
      id: "cmpl_1",
      model: "deepseek-chat",
      text: "let me check",
      calls: [{ id: "call_1", name: "read_file", args: '{"path":"a.txt"}' }],
      finish: "tool_calls",
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });
    expect(turn.stopReason).toBe("tool_use");
    expect(turn.message.content).toHaveLength(2);
    const toolUse = turn.message.content[1] as Anthropic.ToolUseBlock;
    expect(toolUse.type).toBe("tool_use");
    expect(toolUse.input).toEqual({ path: "a.txt" });
  });

  it("finish=length → max_tokens；finish=stop → end_turn", () => {
    const mk = (finish: string) =>
      fromAccumulated({ id: "x", model: "m", text: "t", calls: [], finish, usage: undefined });
    expect(mk("length").stopReason).toBe("max_tokens");
    expect(mk("stop").stopReason).toBe("end_turn");
  });

  it("usage 映射：cached_tokens 从 prompt_tokens 中拆出为 cache_read", () => {
    const turn = fromAccumulated({
      id: "x",
      model: "m",
      text: "t",
      calls: [],
      finish: "stop",
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        total_tokens: 1050,
        prompt_tokens_details: { cached_tokens: 700 },
      } as never,
    });
    expect(turn.usage.cache_read_input_tokens).toBe(700);
    expect(turn.usage.input_tokens).toBe(300);
    expect(turn.usage.output_tokens).toBe(50);
  });

  it("残缺 JSON 参数不崩溃：包成 __malformed_arguments 交给工具校验层报错", () => {
    const turn = fromAccumulated({
      id: "x",
      model: "m",
      text: "",
      calls: [{ id: "call_1", name: "t", args: '{"path": "a' }],
      finish: "tool_calls",
      usage: undefined,
    });
    const toolUse = turn.message.content[0] as Anthropic.ToolUseBlock;
    expect(toolUse.input).toHaveProperty("__malformed_arguments");
  });
});

describe("图像块 → OpenAI image_url（视觉模型走 compat 端点的前提）", () => {
  const img = (data = "AAAA") => ({
    type: "image" as const,
    source: { type: "base64" as const, media_type: "image/png" as const, data },
  });

  /**
   * 此前图像块和 thinking 一样被静默丢弃。后果不是"少了点信息"——
   * 是把一次看图请求变成空请求：视觉模型只收到提示词、没有图，然后
   * 一本正经编一段描述出来。静默降级比报错危险得多，所以这条必须锁死。
   *
   * 现实场景：Kimi / Qwen-VL / GLM-4V 这些能看图的模型都走 OpenAI 兼容端点，
   * 也就是说视觉能力**必然**经过这条翻译路径。
   */
  it("图像块被翻译为 data URI 的 image_url，不再丢弃", () => {
    const out = toOpenAIMessages(
      baseReq([{ role: "user", content: [img("iVBORw0KGgo="), { type: "text", text: "这是什么？" }] }]),
    );
    const user = out.find((m) => m.role === "user")!;
    expect(Array.isArray(user.content), "有图时必须用内容块数组而不是纯字符串").toBe(true);

    const parts = user.content as any[];
    const image = parts.find((p) => p.type === "image_url");
    expect(image, "图像块被丢弃了").toBeDefined();
    expect(image.image_url.url).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(parts.find((p) => p.type === "text").text).toBe("这是什么？");
  });

  it("多张图全部保留，顺序不变", () => {
    const out = toOpenAIMessages(
      baseReq([{ role: "user", content: [img("one"), img("two"), { type: "text", text: "比较" }] }]),
    );
    const parts = (out.find((m) => m.role === "user")!.content as any[]).filter(
      (p) => p.type === "image_url",
    );
    expect(parts.map((p) => p.image_url.url.split(",")[1])).toEqual(["one", "two"]);
  });

  it("无图时仍走纯字符串——不给不需要图的请求平白加一层数组", () => {
    const out = toOpenAIMessages(baseReq([{ role: "user", content: [{ type: "text", text: "纯文本" }] }]));
    expect(out.find((m) => m.role === "user")!.content).toBe("纯文本");
  });

  it("图与 tool_result 混在同一条 user 消息时，tool_result 仍单独成 role:tool", () => {
    const out = toOpenAIMessages(
      baseReq([
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "ok" },
            img("zzz"),
            { type: "text", text: "看这张" },
          ],
        },
      ]),
    );
    expect(out.find((m) => m.role === "tool")).toBeDefined();
    const user = out.filter((m) => m.role === "user").at(-1)!;
    expect((user.content as any[]).some((p) => p.type === "image_url")).toBe(true);
  });
});

describe("tool_choice 映射（§2.1，补上 B0b 记着的那笔欠账）", () => {
  /**
   * B0b 的实施笔记原话：「OpenAI 客户端的 create 捕获桩不存在，那一行 spread
   * 映射暂靠 loop 层锁间接盖住——补桩时顺手锁」。提成纯函数即可直接锁，
   * 不必为此建一整套 create 桩。
   */
  it('"none" 走 OpenAI 的字符串取值，强制交付走 {type:"function"}', () => {
    expect(toOpenAIToolChoice("none")).toBe("none");
    expect(toOpenAIToolChoice({ type: "tool", name: "submit_verdict" })).toEqual({
      type: "function",
      function: { name: "submit_verdict" },
    });
  });

  it("两个 wire 的形状确实不同——这正是需要各自映射函数的原因", () => {
    const anthropic = { type: "tool", name: "submit_plan" };
    expect(toOpenAIToolChoice({ type: "tool", name: "submit_plan" })).not.toEqual(anthropic);
  });
});

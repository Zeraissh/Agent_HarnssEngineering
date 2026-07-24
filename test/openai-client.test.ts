import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { fromAccumulated, toOpenAIMessages, toOpenAITools } from "../src/model-client-openai.js";
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

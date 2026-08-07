/**
 * L0 备选实现 — OpenAIModelClient：把 harness 内部的 Anthropic 形状请求
 * 翻译成 OpenAI chat completions 格式，响应再翻译回来。
 *
 * 这是原则 P1（分层可替换）的终极检验：换掉整个 wire 协议，
 * L1 loop / L2 工具 / L3 上下文零改动 —— 它们只认识 ModelClient 接口。
 *
 * 翻译要点：
 * - Anthropic 的 tool_result 块（合并在一条 user 消息里）→ OpenAI 的多条
 *   role:"tool" 消息（必须紧跟对应的 assistant tool_calls 消息）
 * - Anthropic 的 tool_use 块 → OpenAI 的 assistant.tool_calls（input 序列化为 JSON 串）
 * - is_error 标志在 OpenAI 协议里不存在 → 降级为内容前缀 "[tool error] "
 * - thinking 块（如 Ollama 产生）→ 丢弃（OpenAI 协议无对应物）
 * - finish_reason 映射：tool_calls→tool_use, length→max_tokens, stop→end_turn
 * - 流式：手写 SSE 分片累积（文本 delta 旁路给 onDelta；tool_calls 按 index 拼装）
 */
import OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient, ModelRequest, ModelTurn } from "./types.js";

export interface OpenAIClientOptions {
  baseURL?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class OpenAIModelClient implements ModelClient {
  private client: OpenAI;

  constructor(
    private readonly model: string,
    opts: OpenAIClientOptions = {},
    client?: OpenAI,
  ) {
    this.client =
      client ??
      new OpenAI({
        ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
        apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY ?? "",
        ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
        ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      });
  }

  async send(req: ModelRequest, onDelta?: (text: string) => void): Promise<ModelTurn> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: req.maxTokens,
      messages: toOpenAIMessages(req),
      ...(req.tools.length > 0 ? { tools: toOpenAITools(req.tools) } : {}),
      stream: true,
      stream_options: { include_usage: true },
    });

    let text = "";
    const calls: { id: string; name: string; args: string }[] = [];
    let finish: string | null = null;
    let usage: OpenAI.CompletionUsage | undefined;
    let id = "msg_openai";

    for await (const chunk of stream) {
      if (chunk.id) id = chunk.id;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.delta?.content) {
        text += choice.delta.content;
        onDelta?.(choice.delta.content);
      }
      for (const tc of choice.delta?.tool_calls ?? []) {
        const slot = (calls[tc.index] ??= { id: "", name: "", args: "" });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    return fromAccumulated({ id, model: this.model, text, calls, finish, usage });
  }
}

// ---------------------------------------------------------------- 请求方向

export function toOpenAIMessages(
  req: ModelRequest,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: req.system.map((b) => b.text).join("\n\n") },
  ];

  for (const m of req.messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    if (m.role === "assistant") {
      const text = m.content
        .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolCalls = m.content
        .filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function" as const,
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // user 消息：tool_result 块 → 逐条 role:"tool"（OpenAI 要求紧跟 assistant tool_calls）；
    // 其余 text 块合并为一条 user 消息，排在 tool 消息之后
    const texts: string[] = [];
    const images: OpenAI.Chat.Completions.ChatCompletionContentPartImage[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        const body = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        out.push({
          role: "tool",
          tool_call_id: b.tool_use_id,
          content: b.is_error ? `[tool error] ${body}` : body,
        });
      } else if (b.type === "text") {
        texts.push(b.text);
      } else if (b.type === "image" && b.source.type === "base64") {
        // 图像块必须转成 OpenAI 的 image_url（data URI 形式）。
        // 此前和 thinking 一样被丢弃——后果不是"少了点信息"，而是把一次
        // 看图请求静默变成空请求：视觉模型收到的只有提示词，没有图，
        // 然后一本正经地编一段描述出来。静默降级比报错危险得多。
        images.push({
          type: "image_url",
          image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
        });
      }
      // thinking / 其他块类型：OpenAI 协议无对应物，丢弃
    }
    if (images.length > 0) {
      out.push({
        role: "user",
        content: [
          ...images,
          ...(texts.length > 0
            ? [{ type: "text" as const, text: texts.join("\n\n") }]
            : []),
        ],
      });
    } else if (texts.length > 0) {
      out.push({ role: "user", content: texts.join("\n\n") });
    }
  }

  return out;
}

export function toOpenAITools(tools: Anthropic.Tool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

// ---------------------------------------------------------------- 响应方向

export interface AccumulatedCompletion {
  id: string;
  model: string;
  text: string;
  calls: { id: string; name: string; args: string }[];
  finish: string | null;
  usage: OpenAI.CompletionUsage | undefined;
}

export function fromAccumulated(acc: AccumulatedCompletion): ModelTurn {
  const content: Anthropic.ContentBlock[] = [];
  if (acc.text) {
    content.push({ type: "text", text: acc.text, citations: null } as Anthropic.TextBlock);
  }
  for (const call of acc.calls) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: safeParseArgs(call.args),
    } as Anthropic.ToolUseBlock);
  }

  const stopReason: Anthropic.Message["stop_reason"] =
    acc.finish === "tool_calls" || acc.calls.length > 0
      ? "tool_use"
      : acc.finish === "length"
        ? "max_tokens"
        : "end_turn";

  // 缓存命中：OpenAI 规范字段 prompt_tokens_details.cached_tokens；
  // DeepSeek 另有 prompt_cache_hit_tokens（含义相同，谁在用谁）
  const raw = (acc.usage ?? {}) as Record<string, unknown>;
  const details = (raw["prompt_tokens_details"] ?? {}) as Record<string, unknown>;
  const cacheRead =
    Number(details["cached_tokens"] ?? 0) || Number(raw["prompt_cache_hit_tokens"] ?? 0);
  const promptTokens = acc.usage?.prompt_tokens ?? 0;

  const usage = {
    input_tokens: Math.max(0, promptTokens - cacheRead),
    output_tokens: acc.usage?.completion_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cacheRead,
  } as Anthropic.Usage;

  const message = {
    id: acc.id,
    type: "message",
    role: "assistant",
    model: acc.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  } as Anthropic.Message;

  return { message, stopReason, usage };
}

/** 模型拼出来的 JSON 串可能残缺；解析失败回传空对象，让工具的输入校验给出可操作报错 */
function safeParseArgs(args: string): unknown {
  if (!args.trim()) return {};
  try {
    return JSON.parse(args);
  } catch {
    return { __malformed_arguments: args };
  }
}

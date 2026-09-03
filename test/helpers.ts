import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient, ModelRequest, ModelTurn, Tool } from "../src/types.js";

/** 构造一个符合 SDK 形状的 assistant 消息 */
export function fakeMessage(
  content: Anthropic.ContentBlock[],
  stopReason: Anthropic.Message["stop_reason"],
  usage?: Partial<Anthropic.Usage>,
): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-8",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      ...usage,
    } as Anthropic.Usage,
  } as Anthropic.Message;
}

export function textBlock(text: string): Anthropic.TextBlock {
  return { type: "text", text, citations: null } as Anthropic.TextBlock;
}

export function toolUseBlock(id: string, name: string, input: unknown): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input } as Anthropic.ToolUseBlock;
}

/** 按脚本顺序吐出预设响应的假模型；记录每次收到的请求 */
export class FakeModelClient implements ModelClient {
  requests: ModelRequest[] = [];
  private index = 0;

  /**
   * RUN-02：从第 N 次 send（1-based）起每次都抛错，模拟 mid-model 崩溃。
   * 抛错带 status:400——plain Error 会被 isTransientApiError 当成瞬时并重试，
   * 那会把「注入点」糊成「重试后成功」，仪器说谎。
   */
  crashAtCall: number | null = null;

  constructor(private readonly script: Anthropic.Message[]) {}

  send(req: ModelRequest): Promise<ModelTurn> {
    this.requests.push(structuredClone(req));
    this.index += 1;
    if (this.crashAtCall !== null && this.index >= this.crashAtCall) {
      throw Object.assign(new Error(`injected model crash at call ${this.index}`), { status: 400 });
    }
    const message = this.script[this.index - 1];
    if (!message) throw new Error(`FakeModelClient script exhausted at call ${this.index}`);
    return Promise.resolve({ message, stopReason: message.stop_reason, usage: message.usage });
  }
}

/** 简单可控的测试工具 */
export function makeTool(overrides: Partial<Tool> & Pick<Tool, "name">): Tool {
  return {
    description: `test tool ${overrides.name}`,
    inputSchema: { type: "object" as const, properties: {} },
    permission: "auto",
    parallelSafe: true,
    execute: async () => ({ content: `${overrides.name} ok` }),
    ...overrides,
  };
}

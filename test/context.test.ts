import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { DefaultContextManager } from "../src/context.js";

const mgr = () =>
  new DefaultContextManager({ systemPrompt: "frozen system", maxTokens: 64000, effort: "high" });

describe("DefaultContextManager.render", () => {
  it("system 尾块携带 cache_control", () => {
    const req = mgr().render([{ role: "user", content: "hi" }], []);
    expect(req.system.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    expect(req.system.at(-1)?.text).toBe("frozen system");
  });

  it("最后一条消息的最后一个可缓存块携带 cache_control；字符串 content 被转为块", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ];
    const req = mgr().render(messages, []);

    const last = req.messages.at(-1)!;
    const blocks = last.content as Anthropic.TextBlockParam[];
    expect(blocks.at(-1)?.cache_control).toEqual({ type: "ephemeral" });

    // 非末条消息不打标记
    expect(typeof req.messages[0]!.content).toBe("string");
  });

  it("tool_result 块可作为断点载体", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
      },
    ];
    const req = mgr().render(messages, []);
    const blocks = req.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect((blocks[0] as { cache_control?: unknown }).cache_control).toEqual({ type: "ephemeral" });
  });

  it("不原地修改传入的 messages（历史保持无标记）", () => {
    const original: Anthropic.MessageParam[] = [{ role: "user", content: "hi" }];
    mgr().render(original, []);
    expect(typeof original[0]!.content).toBe("string");
  });

  it("cacheBreakpoints=false（compat 模式）：不打任何 cache_control 标记", () => {
    const m = new DefaultContextManager({
      systemPrompt: "s",
      maxTokens: 8000,
      effort: "high",
      cacheBreakpoints: false,
    });
    const req = m.render([{ role: "user", content: "hi" }], []);
    expect(req.system[0]).not.toHaveProperty("cache_control");
    expect(typeof req.messages[0]!.content).toBe("string");
  });

  it("compact 返回新数组，低水位时内容等价（详细行为见 compact.test.ts）", () => {
    const m = mgr();
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "hi" }];
    const out = m.compact(messages);
    expect(out.messages).not.toBe(messages);
    expect(out.messages).toEqual(messages);
    expect(out.droppedBlocks).toBe(0);
  });
});

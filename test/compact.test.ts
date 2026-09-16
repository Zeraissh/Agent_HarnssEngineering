import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { COMPACT_LEDGER_MARKER, parseCompactLedgerText } from "../src/compact-ledger.js";
import {
  COMPACTED_IMAGE_MARKER,
  COMPACTED_TURNS_MARKER,
  DefaultContextManager,
  formatCompactedImage,
  REACTIVE_PROTECT_RECENT,
  userMessageWithContext,
} from "../src/context.js";
import { diffRenderedRequests } from "../src/diagnostics.js";
import { AgentLoop } from "../src/loop.js";
import type { TurnEvent } from "../src/types.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock, toolUseBlock } from "./helpers.js";

const usage = (n: number) =>
  ({ input_tokens: n, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }) as Anthropic.Usage;

function bigToolResultMsg(id: string, chars = 2000): Anthropic.MessageParam {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "x".repeat(chars) }],
  };
}

function mgr(limit = 1000, protect = 2) {
  return new DefaultContextManager({
    systemPrompt: "frozen",
    maxTokens: 8000,
    effort: "high",
    contextTokenLimit: limit,
    protectRecent: protect,
  });
}

describe("DefaultContextManager.compact（v0.3 真实实现）", () => {
  it("cache_read 不触发预算压缩：重读已缓存前缀不是该压的信号", () => {
    const m = mgr(1000);
    m.noteUsage({
      input_tokens: 100,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 900,
    } as Anthropic.Usage);
    const messages = [bigToolResultMsg("tu_1"), { role: "user" as const, content: "hi" }];
    const out = m.compact(messages);
    expect(out.changed).toBe(false);
    expect(out.droppedBlocks).toBe(0);
    expect(out.messages).toEqual(messages);
  });

  it("低于水位线：直通不压缩", () => {
    const m = mgr(1000);
    m.noteUsage(usage(100)); // 100 < 800 水位
    const messages = [bigToolResultMsg("tu_1"), { role: "user" as const, content: "hi" }];
    const out = m.compact(messages);
    expect(out.droppedBlocks).toBe(0);
    expect(out.ledgerEntries).toBe(0);
    expect(out.messages).toEqual(messages);
  });

  it("超过水位线：压缩保护窗口外的大 tool_result，保留结构", () => {
    const m = mgr(1000, 2);
    m.noteUsage(usage(900)); // 900 > 800 水位
    const messages: Anthropic.MessageParam[] = [
      bigToolResultMsg("tu_old"), // 窗口外，大 → 压缩
      { role: "user", content: "small" }, // 窗口外，非 tool_result → 不动
      bigToolResultMsg("tu_recent"), // 保护窗口内 → 不动
      { role: "user", content: "latest" },
    ];
    const out = m.compact(messages);

    expect(out.droppedBlocks).toBe(1);
    // 账本消息可能插到最前；按 tool_use_id 查找，不依赖绝对下标
    const oldMsg = out.messages.find(
      (msg) =>
        typeof msg.content !== "string" &&
        msg.content.some((b) => b.type === "tool_result" && b.tool_use_id === "tu_old"),
    )!;
    const oldBlocks = oldMsg.content as Anthropic.ToolResultBlockParam[];
    expect(oldBlocks[0]!.content).toContain("[compacted]");
    expect(oldBlocks[0]!.tool_use_id).toBe("tu_old"); // 结构不破坏
    const recentBlocks = out.messages.find(
      (msg) =>
        typeof msg.content !== "string" &&
        msg.content.some((b) => b.type === "tool_result" && b.tool_use_id === "tu_recent"),
    )!.content as Anthropic.ToolResultBlockParam[];
    expect(recentBlocks[0]!.content).not.toContain("[compacted]");
  });

  it("幂等：第二次 compact 不再产生 dropped（已压缩块不重复计数）", () => {
    const m = mgr(1000, 1);
    m.noteUsage(usage(900));
    const first = m.compact([bigToolResultMsg("tu_1"), { role: "user", content: "end" }]);
    expect(first.droppedBlocks).toBe(1);
    const second = m.compact(first.messages);
    expect(second.droppedBlocks).toBe(0);
  });

  it("小体积 tool_result 不压缩", () => {
    const m = mgr(1000, 0);
    m.noteUsage(usage(900));
    const out = m.compact([bigToolResultMsg("tu_1", 100)]);
    expect(out.droppedBlocks).toBe(0);
  });
});

/**
 * 占位符带原文首行摘录（2026-09-03 真机复核的缺口）：反应式压缩救回 987k 超长请求后，
 * 72 个 `[compacted]` 占位符里没有一个字的原文，模型只能 `read_file limit=1` 补读 72 次（8 轮）。
 * 变异验证：tier 1 调用处删掉 excerpt 参数 → 下面三条全红。
 */
describe("tier 1 占位符带原文首行摘录", () => {
  const FIRST = "FILE-001 :: the lighthouse keeper counted thirty-seven gulls at dawn :: code M519";
  function readResult(id: string, firstLine: string, isError = false): Anthropic.MessageParam {
    return {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: id,
        ...(isError ? { is_error: true } : {}),
        content: `${firstLine}\n${"body ".repeat(700)}\ntail`,
      }],
    };
  }
  const placeholderOf = (out: Anthropic.MessageParam[], id: string): string => {
    const msg = out.find(
      (m) => typeof m.content !== "string" && m.content.some((b) => b.type === "tool_result" && b.tool_use_id === id),
    )!;
    const block = (msg.content as Anthropic.ToolResultBlockParam[]).find((b) => b.tool_use_id === id)!;
    return block.content as string;
  };

  it("占位符首行仍以 [compacted] 开头，带行数，且有 excerpt 行 = 原文首个非空行", () => {
    const m = mgr(1000, 1);
    m.noteUsage(usage(900));
    const out = m.compact([
      { role: "assistant", content: [toolUseBlock("tu_r", "read_file", { path: "data/chunks/f001.txt" })] },
      readResult("tu_r", FIRST),
      { role: "user", content: "latest" },
    ]);
    expect(out.droppedBlocks).toBe(1);
    const text = placeholderOf(out.messages, "tu_r");
    expect(text.startsWith("[compacted] semantic elision (was ")).toBe(true);
    expect(text.split("\n")[0]).toMatch(/was \d+ chars, 3 lines\)/);
    expect(text).toContain("tool: read_file");
    expect(text).toContain(`excerpt: ${FIRST}`);
    // 体积有界：摘录相关只多出 ≤ 150 字符
    const bare = text.split("\n").filter((l) => !l.startsWith("excerpt: ")).join("\n").replace(/, 3 lines/, "");
    expect(text.length - bare.length).toBeLessThanOrEqual(150);
  });

  it("首行超过 100 字符 → 摘录恰好 100 字符、末位省略号", () => {
    const m = mgr(1000, 1);
    m.noteUsage(usage(900));
    const long = "X".repeat(260);
    const out = m.compact([
      { role: "assistant", content: [toolUseBlock("tu_l", "bash", { command: "cat big.log" })] },
      readResult("tu_l", long),
      { role: "user", content: "latest" },
    ]);
    const line = placeholderOf(out.messages, "tu_l").split("\n").find((l) => l.startsWith("excerpt: "))!;
    const excerpt = line.slice("excerpt: ".length);
    expect(excerpt.length).toBe(100);
    expect(excerpt).toBe(`${"X".repeat(99)}…`);
  });

  it("is_error 的结果摘录错误行（不在首行也要找到）", () => {
    const m = mgr(1000, 1);
    m.noteUsage(usage(900));
    const out = m.compact([
      { role: "assistant", content: [toolUseBlock("tu_e", "bash", { command: "openocd -f x.cfg" })] },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "tu_e",
          is_error: true,
          content: `Command output:\n\nError: LIBUSB_ERROR_ACCESS probe held by PID 4242\n${"e".repeat(600)}`,
        }],
      },
      { role: "user", content: "latest" },
    ]);
    expect(placeholderOf(out.messages, "tu_e")).toContain("excerpt: Error: LIBUSB_ERROR_ACCESS probe held by PID 4242");
  });

  it("幂等：二次压缩不重置换，占位符逐字节不变（摘录稳定）", () => {
    const m = mgr(1000, 1);
    m.noteUsage(usage(900));
    const first = m.compact([
      { role: "assistant", content: [toolUseBlock("tu_r", "read_file", { path: "f001.txt" })] },
      readResult("tu_r", FIRST),
      { role: "user", content: "latest" },
    ]);
    const before = placeholderOf(first.messages, "tu_r");
    const second = m.compact(first.messages);
    expect(second.droppedBlocks).toBe(0);
    expect(placeholderOf(second.messages, "tu_r")).toBe(before);
    // 摘录只出现一次——不会被"占位符再摘录"套娃
    expect(before.split("\n").filter((l) => l.startsWith("excerpt: "))).toHaveLength(1);
  });
});

describe("MEM-01 语义账本（结构化压缩残留）", () => {
  it("压缩后保留用户约束、决策、失败、证据与 write_file 副作用", () => {
    const m = mgr(1000, 1);
    m.noteUsage(usage(900));
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: "必须 ERC=0；不得改网表基线。验收 AC5：image_crc32 非零。",
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "决定采用按名成网，不手改 net。" },
          toolUseBlock("tu_w", "write_file", { path: "sch/board.kicad_sch", content: "(kicad_sch)" }),
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_w",
            content: `Wrote 4096 bytes to sch/board.kicad_sch\nERC=0\nimage_crc32=0x7189AAB5\n${"pad".repeat(400)}`,
          },
        ],
      },
      {
        role: "assistant",
        content: [toolUseBlock("tu_b", "bash", { command: "rm -rf out && cmake --build out" })],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_b",
            is_error: true,
            content: `Error: LIBUSB_ERROR_ACCESS probe held by PID 4242\n${"e".repeat(600)}`,
          },
        ],
      },
      { role: "user", content: "继续" }, // 保护窗口
    ];

    const out = m.compact(messages);
    expect(out.droppedBlocks).toBeGreaterThan(0);
    expect(out.ledgerEntries).toBeGreaterThan(0);

    const flat = JSON.stringify(out.messages);
    expect(flat).toContain(COMPACT_LEDGER_MARKER);
    expect(flat).toMatch(/必须 ERC=0|不得改网表/);
    expect(flat).toMatch(/决定采用按名成网/);
    expect(flat).toMatch(/write_file sch\/board\.kicad_sch/);
    expect(flat).toMatch(/LIBUSB_ERROR_ACCESS|0x7189AAB5/);

    const ledgerMsg = out.messages.find((msg) => JSON.stringify(msg).includes(COMPACT_LEDGER_MARKER));
    expect(ledgerMsg).toBeTruthy();
    const ledgerText =
      typeof ledgerMsg!.content === "string"
        ? ledgerMsg!.content
        : (ledgerMsg!.content as Anthropic.TextBlockParam[]).map((b) => b.text).join("\n");
    const parsed = parseCompactLedgerText(ledgerText);
    expect(parsed.constraints.length).toBeGreaterThan(0);
    expect(parsed.decisions.length).toBeGreaterThan(0);
    expect(parsed.sideEffects.some((s) => /write_file/.test(s))).toBe(true);
    expect(parsed.failures.length + parsed.evidence.length).toBeGreaterThan(0);

    // 保护窗口语义未破：末条仍是"继续"
    expect(out.messages.at(-1)).toEqual({ role: "user", content: "继续" });
  });

  it("二次压缩原地更新账本，不重复插入 ledger 消息", () => {
    const m = mgr(1000, 1);
    m.noteUsage(usage(900));
    const first = m.compact([
      { role: "user", content: "必须保留约束 A" },
      bigToolResultMsg("tu_1", 800),
      { role: "user", content: "end1" },
    ]);
    const ledgerCount1 = first.messages.filter((msg) =>
      JSON.stringify(msg).includes(COMPACT_LEDGER_MARKER),
    ).length;
    expect(ledgerCount1).toBe(1);

    const grown: Anthropic.MessageParam[] = [
      ...first.messages.slice(0, -1),
      {
        role: "assistant",
        content: [toolUseBlock("tu_2", "write_file", { path: "b.txt", content: "x" })],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_2",
            content: `Wrote 1 bytes to b.txt\n${"z".repeat(700)}`,
          },
        ],
      },
      { role: "user", content: "end2" },
    ];
    const second = m.compact(grown);
    const ledgerCount2 = second.messages.filter((msg) =>
      JSON.stringify(msg).includes(COMPACT_LEDGER_MARKER),
    ).length;
    expect(ledgerCount2).toBe(1);
    expect(JSON.stringify(second.messages)).toMatch(/write_file b\.txt|必须保留约束 A/);
  });

  it("变异锁：若退回纯占位符（无账本），本测试必须红", () => {
    const m = mgr(1000, 0);
    m.noteUsage(usage(900));
    const out = m.compact([
      { role: "user", content: "必须使用 DAPLink，不得碰 ST-Link。" },
      {
        role: "assistant",
        content: [toolUseBlock("tu", "write_file", { path: "note.md", content: "x" })],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu",
            content: `Wrote 1 bytes to note.md\n${"n".repeat(600)}`,
          },
        ],
      },
    ]);
    // 纯 `[compacted] tool result elided...` 旧实现过不了这三条
    expect(out.ledgerEntries).toBeGreaterThan(0);
    expect(JSON.stringify(out.messages)).toContain(COMPACT_LEDGER_MARKER);
    expect(JSON.stringify(out.messages)).toMatch(/必须使用 DAPLink|write_file note\.md/);
  });
});

describe("AgentLoop 集成：compaction 事件与正史替换", () => {
  it("上下文超限时发 compaction 事件，run 正常完成，正史被替换", async () => {
    const bigTool = makeTool({
      name: "reader",
      execute: async () => ({ content: "y".repeat(3000) }),
    });
    // 5 轮 tool_use（每轮 usage 都超限）+ 收尾
    const script = [
      ...Array.from({ length: 5 }, (_, i) =>
        fakeMessage([toolUseBlock(`tu_${i}`, "reader", {})], "tool_use", { input_tokens: 5000 }),
      ),
      fakeMessage([textBlock("done")], "end_turn", { input_tokens: 5000 }),
    ];
    const loop = new AgentLoop(
      {
        systemPrompt: "frozen",
        tools: [bigTool],
        workdir: process.cwd(),
        contextTokenLimit: 5000, // 水位 4000，第 2 轮起触发
      },
      new FakeModelClient(script),
    );

    const events: TurnEvent[] = [];
    for await (const e of loop.run("go")) events.push(e);

    const compactions = events.filter((e) => e.type === "compaction");
    expect(compactions.length).toBeGreaterThan(0);
    for (const c of compactions) {
      if (c.type === "compaction") {
        expect(typeof c.ledgerEntries).toBe("number");
      }
    }

    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("no done event");
    expect(done.result.stopReason).toBe("completed");
    // 正史里最老的 tool_result 应已被压缩：tier 1 的占位文本，或（水位仍高时）被 tier 2
    // 连同所在轮一起折叠进 [compacted_turns]——两者都算"原文不再在正史里"
    const flat = JSON.stringify(done.result.messages);
    expect(flat).toMatch(/\[compacted\]|\[compacted_turns\]/);
    // 每一轮的 usage 都钉在 5000（水位之上），tier 1 置换后估算仍在水位上 → tier 2 必须跟上
    expect(flat).toContain(COMPACTED_TURNS_MARKER);
    expect(compactions.some((c) => c.type === "compaction" && (c.collapsedTurns ?? 0) > 0)).toBe(true);
  });

  it("从持久化检查点恢复时，首个请求先按旧水位压缩，不能盲发完整大历史", async () => {
    const history: Anthropic.MessageParam[] = [
      { role: "user", content: "原始任务" },
      { role: "assistant", content: [toolUseBlock("old", "reader", {})] },
      bigToolResultMsg("old", 3000),
      { role: "assistant", content: "阶段 1 完成" },
      { role: "user", content: "阶段 2" },
      { role: "assistant", content: "阶段 2 完成" },
      { role: "user", content: "阶段 3" },
      { role: "assistant", content: "阶段 3 完成" },
    ];
    const model = new FakeModelClient([
      fakeMessage([textBlock("从检查点继续完成")], "end_turn", { input_tokens: 120 }),
    ]);
    const loop = new AgentLoop(
      {
        systemPrompt: "frozen",
        tools: [makeTool({ name: "reader" })],
        workdir: process.cwd(),
        contextTokenLimit: 1000,
        initialContextInputTokens: 900,
      },
      model,
    );

    const events: TurnEvent[] = [];
    for await (const event of loop.runContinuation(history, "请继续")) events.push(event);

    expect(events.some((event) => event.type === "compaction")).toBe(true);
    expect(JSON.stringify(model.requests[0]!.messages)).toContain("[compacted]");
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") expect(done.result.contextInputTokens).toBe(120);
  });
});

describe("system prompt 冻结（P3 断言）", () => {
  it("多次 render 之间 system 字节完全一致，且不受 messages 变化影响", () => {
    const m = mgr();
    const r1 = m.render([{ role: "user", content: "a" }], []);
    const r2 = m.render([{ role: "user", content: "完全不同的输入" }, { role: "assistant", content: "x" }], []);
    expect(JSON.stringify(r1.system)).toBe(JSON.stringify(r2.system));
    expect(m.systemPrompt).toBe("frozen");
  });
});

describe("userMessageWithContext（动态上下文注入规范）", () => {
  it("易变信息进 messages 首条消息，system 不受影响", () => {
    const msg = userMessageWithContext("do the task", { date: "2026-07-24", platform: "win32" });
    const blocks = msg.content as Anthropic.TextBlockParam[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text).toContain("<context>");
    expect(blocks[0]!.text).toContain("date: 2026-07-24");
    expect(blocks[1]!.text).toBe("do the task");
  });
});

describe("diffRenderedRequests（缓存诊断）", () => {
  const base = () =>
    mgr().render([{ role: "user", content: "hi" }], [
      { name: "a", description: "d", input_schema: { type: "object" as const, properties: {} } },
    ]);

  it("完全一致 → none", () => {
    expect(diffRenderedRequests(base(), base()).tier).toBe("none");
  });

  it("工具差异 → tools（最高优先级）", () => {
    const b = base();
    b.tools = [{ name: "b", description: "d", input_schema: { type: "object", properties: {} } }];
    b.messages = [{ role: "user", content: "也不一样" }];
    const d = diffRenderedRequests(base(), b);
    expect(d.tier).toBe("tools");
    expect(d.index).toBe(0);
  });

  it("system 差异 → system，并给出首个差异字符位置", () => {
    const a = base();
    const b = base();
    b.system = [{ type: "text", text: "frozen (2026-07-24 10:00)" }];
    const d = diffRenderedRequests(a, b);
    expect(d.tier).toBe("system");
    expect(d.detail).toContain("易变内容");
  });

  it("messages 差异 → messages，并给出下标", () => {
    const a = base();
    const b = base();
    b.messages = [{ role: "user", content: "different" }];
    const d = diffRenderedRequests(a, b);
    expect(d.tier).toBe("messages");
    expect(d.index).toBe(0);
  });
});

/**
 * 图片懒加载 A'：compact 把保护窗外的 image 块换成路径+纪要。
 * 变异锁：删 degrade 调用 →「窗外不再有 image」红；摘要扫描若丢掉 describe_image → 带 summary 的用例红。
 */
describe("保护窗外 image 块降级为纪要", () => {
  const PIXEL = "iVBORw0KGgo".repeat(80);

  function imageBlock(data = PIXEL): Anthropic.ImageBlockParam {
    return { type: "image", source: { type: "base64", media_type: "image/png", data } };
  }

  function imageMsgs(blocks: Anthropic.ContentBlockParam[]): Anthropic.MessageParam {
    return { role: "user", content: blocks };
  }

  function compactedImageTexts(messages: Anthropic.MessageParam[]): string[] {
    const out: string[] = [];
    for (const m of messages) {
      if (typeof m.content === "string") {
        if (m.content.startsWith(COMPACTED_IMAGE_MARKER)) out.push(m.content);
        continue;
      }
      for (const b of m.content) {
        if (b.type === "text" && b.text.includes(COMPACTED_IMAGE_MARKER)) out.push(b.text);
        if (b.type === "tool_result" && Array.isArray(b.content)) {
          for (const ib of b.content) {
            if (ib.type === "text" && ib.text.includes(COMPACTED_IMAGE_MARKER)) out.push(ib.text);
          }
        }
      }
    }
    return out;
  }

  function countImages(messages: Anthropic.MessageParam[], from = 0, to?: number): number {
    const end = to ?? messages.length;
    let n = 0;
    for (let i = from; i < end; i++) {
      const m = messages[i]!;
      if (typeof m.content === "string") continue;
      for (const b of m.content) {
        if (b.type === "image") n += 1;
        if (b.type === "tool_result" && Array.isArray(b.content)) {
          n += b.content.filter((ib) => ib.type === "image").length;
        }
      }
    }
    return n;
  }

  it("formatCompactedImage：有摘要两行，无摘要只有 path 行", () => {
    expect(formatCompactedImage("shots/hero.png", "红按钮白底卡片，无文字。")).toBe(
      `${COMPACTED_IMAGE_MARKER} path=shots/hero.png\nsummary: 红按钮白底卡片，无文字。`,
    );
    expect(formatCompactedImage("shots/hero.png")).toBe(`${COMPACTED_IMAGE_MARKER} path=shots/hero.png`);
  });

  it("保护窗外的 image 换成带路径的短文本，窗内原图不动", () => {
    const m = mgr(1000, 1);
    m.noteUsage(usage(900));
    const out = m.compact([
      imageMsgs([{ type: "text", text: "[view_image] shots/old.png" }, imageBlock()]),
      imageMsgs([{ type: "text", text: "[view_image] shots/recent.png" }, imageBlock("RECENTPIXEL")]),
    ]);
    expect(out.changed).toBe(true);
    expect(countImages(out.messages, 0, out.messages.length - 1)).toBe(0);
    expect(countImages([out.messages.at(-1)!])).toBe(1);
    const texts = compactedImageTexts(out.messages);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toBe(formatCompactedImage("shots/old.png"));
    expect(JSON.stringify(out.messages)).not.toContain(PIXEL);
    expect(JSON.stringify(out.messages)).toContain("RECENTPIXEL");
  });

  it("能扫到同路径 describe_image 的 tool_result 时带上最近一次摘要", () => {
    const m = mgr(1000, 1);
    m.noteUsage(usage(900));
    const out = m.compact([
      { role: "assistant", content: [toolUseBlock("tu_d1", "describe_image", { path: "shots/hero.png" })] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_d1", content: "旧摘要：风景图。" }],
      },
      { role: "assistant", content: [toolUseBlock("tu_d2", "describe_image", { path: "shots\\hero.png" })] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_d2", content: "红按钮白底卡片，无文字。" }],
      },
      imageMsgs([{ type: "text", text: "[view_image] shots/hero.png" }, imageBlock()]),
      { role: "user", content: "latest" },
    ]);
    expect(out.changed).toBe(true);
    expect(countImages(out.messages.slice(0, -1))).toBe(0);
    expect(compactedImageTexts(out.messages)).toEqual([
      formatCompactedImage("shots/hero.png", "红按钮白底卡片，无文字。"),
    ]);
  });

  it("同路径既有 describe_image 又有 view_image 时优先 describe 摘要", () => {
    const m = mgr(1000, 1);
    m.noteUsage(usage(900));
    const out = m.compact([
      { role: "assistant", content: [toolUseBlock("tu_d", "describe_image", { path: "a.png" })] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_d", content: "一只猫蹲在篱笆上。" }],
      },
      { role: "assistant", content: [toolUseBlock("tu_v", "view_image", { path: "a.png" })] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_v", content: "Loaded a.png into this turn." }],
      },
      imageMsgs([{ type: "text", text: "[view_image] a.png" }, imageBlock()]),
      { role: "user", content: "latest" },
    ]);
    expect(compactedImageTexts(out.messages)[0]).toBe(
      formatCompactedImage("a.png", "一只猫蹲在篱笆上。"),
    );
  });

  it("只有 view_image 回执时用它当摘要", () => {
    const m = mgr(1000, 1);
    m.noteUsage(usage(900));
    const out = m.compact([
      { role: "assistant", content: [toolUseBlock("tu_v", "view_image", { path: "board.png" })] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_v", content: "Loaded board.png. 原理图左上是 USB。" }],
      },
      imageMsgs([imageBlock()]),
      { role: "user", content: "latest" },
    ]);
    expect(compactedImageTexts(out.messages)[0]).toBe(
      formatCompactedImage("board.png", "Loaded board.png. 原理图左上是 USB。"),
    );
  });

  it("扫不到摘要时只留路径；裸 image 且无邻近路径 → path=(unknown)", () => {
    const m = mgr(1000, 1);
    m.noteUsage(usage(900));
    const withPath = m.compact([
      imageMsgs([{ type: "text", text: "[view_image] shots/x.png" }, imageBlock()]),
      { role: "user", content: "latest" },
    ]);
    expect(compactedImageTexts(withPath.messages)[0]).toBe(formatCompactedImage("shots/x.png"));
    expect(compactedImageTexts(withPath.messages)[0]).not.toContain("summary:");

    const unknown = m.compact([imageMsgs([imageBlock()]), { role: "user", content: "latest" }]);
    expect(compactedImageTexts(unknown.messages)[0]).toBe(formatCompactedImage("(unknown)"));
  });

  it("tool_result 数组里的 image 按 tool_use.path 降级", () => {
    const m = mgr(1000, 1);
    m.noteUsage(usage(900));
    const out = m.compact([
      { role: "assistant", content: [toolUseBlock("tu_v", "view_image", { path: "wire.png" })] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_v",
            content: [imageBlock(), { type: "text", text: "Loaded wire.png" }],
          },
        ],
      },
      { role: "user", content: "latest" },
    ]);
    expect(countImages(out.messages)).toBe(0);
    expect(compactedImageTexts(out.messages)[0]).toBe(
      formatCompactedImage("wire.png", "Loaded wire.png"),
    );
  });

  it("低于水位不降级；force 则忽略水位", () => {
    const low = mgr(1000, 1);
    low.noteUsage(usage(100));
    const msgs: Anthropic.MessageParam[] = [
      imageMsgs([{ type: "text", text: "[view_image] keep.png" }, imageBlock()]),
      { role: "user", content: "mid" },
      { role: "user", content: "latest" },
    ];
    const skipped = low.compact(msgs);
    expect(skipped.changed).toBe(false);
    expect(countImages(skipped.messages)).toBe(1);

    // 反应式窗 = 2：三条里只有窗外那张被回收
    const forced = low.compact(msgs, { force: true, protectRecent: REACTIVE_PROTECT_RECENT });
    expect(forced.changed).toBe(true);
    expect(countImages(forced.messages, 0, 1)).toBe(0);
    expect(countImages(forced.messages, 1)).toBe(0);
    expect(compactedImageTexts(forced.messages)[0]).toContain("path=keep.png");
  });

  it("幂等：已降级文本不再被改写，窗外不再出现 image 块", () => {
    const m = mgr(1000, 1);
    m.noteUsage(usage(900));
    const first = m.compact([
      imageMsgs([{ type: "text", text: "[view_image] shots/hero.png" }, imageBlock()]),
      { role: "user", content: "latest" },
    ]);
    const before = compactedImageTexts(first.messages);
    expect(before).toEqual([formatCompactedImage("shots/hero.png")]);
    const second = m.compact(first.messages);
    expect(second.droppedBlocks).toBe(0);
    expect(compactedImageTexts(second.messages)).toEqual(before);
    expect(countImages(second.messages)).toBe(0);
  });

  it("is_error 的 describe_image 不进摘要；长摘要被裁到上限", () => {
    const m = mgr(1000, 1);
    m.noteUsage(usage(900));
    const long = `逐像素对照：${"色块 ".repeat(80)}结束`;
    const out = m.compact([
      { role: "assistant", content: [toolUseBlock("tu_e", "describe_image", { path: "big.png" })] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_e", is_error: true, content: "Image not found: big.png" }],
      },
      { role: "assistant", content: [toolUseBlock("tu_ok", "describe_image", { path: "big.png" })] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_ok", content: long }],
      },
      imageMsgs([{ type: "text", text: "path=big.png" }, imageBlock()]),
      { role: "user", content: "latest" },
    ]);
    const text = compactedImageTexts(out.messages)[0]!;
    expect(text).not.toContain("Image not found");
    expect(text).toBe(formatCompactedImage("big.png", long));
    const summary = text.split("\n").find((l) => l.startsWith("summary: "))!.slice("summary: ".length);
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(summary.endsWith("…")).toBe(true);
  });
});

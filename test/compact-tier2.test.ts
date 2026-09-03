/**
 * MEM-01 Phase C —— 分级压缩流水线的三个新层 + 反应式压缩。
 *
 *   a. 入口截断（snipToolResult / ToolExecutor）：单个 tool_result 进正史前的字符上限；
 *   c. tier 2（collapse old turns）：tier 1 之后估计仍在水位上 → 折叠保护窗外的旧轮；
 *   d. 反应式：端点 context-too-long 400 → 忽略水位硬压缩 → 重发同一轮；仍超长 → error。
 *
 * 不变量（每条都有锁）：任务首条消息永不折叠；tool_use / tool_result 配对永不拆散；
 * `[compact_ledger]` 只有一份且不丢；折叠确定性 + 幂等；反应式不消耗瞬时重试额度。
 */
import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { COMPACT_LEDGER_MARKER, parseCompactLedgerText } from "../src/compact-ledger.js";
import { COMPACTED_TURNS_MARKER, DefaultContextManager, REACTIVE_PROTECT_RECENT } from "../src/context.js";
import { AgentLoop } from "../src/loop.js";
import {
  CONTEXT_OVERFLOW_ERROR_PREFIX,
  classifyApiError,
  isContextOverflowError,
  isTransientApiError,
} from "../src/model-client.js";
import { DEFAULT_TOOL_RESULT_MAX_CHARS, snipToolResult } from "../src/tools/registry.js";
import type { ModelClient, ModelRequest, ModelTurn, TurnEvent } from "../src/types.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock, toolUseBlock } from "./helpers.js";

const usage = (n: number) =>
  ({ input_tokens: n, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }) as Anthropic.Usage;

function mgr(limit = 1000, protect = 2) {
  return new DefaultContextManager({
    systemPrompt: "frozen",
    maxTokens: 8000,
    effort: "high",
    contextTokenLimit: limit,
    protectRecent: protect,
  });
}

/** 一轮 = assistant(text + tool_use) + user(tool_result)。结果刻意很小：tier 1 碰不到它们 */
function turnPair(i: number, resultChars = 40): Anthropic.MessageParam[] {
  return [
    {
      role: "assistant",
      content: [
        { type: "text", text: `第 ${i} 步：决定检查文件 f${i}` },
        toolUseBlock(`tu_${i}`, "read_file", { path: `src/f${i}.ts` }),
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `tu_${i}`, content: `line1 of f${i}\n${"x".repeat(resultChars)}` }],
    },
  ];
}

function history(turns: number, task = "任务：必须保留 A 文件。"): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  for (let i = 1; i <= turns; i++) out.push(...turnPair(i));
  return out;
}

/** 配对合法性：每个 tool_result 的 tool_use 在紧邻的前一条 assistant 里；每个 tool_use 后面紧跟它的结果 */
function assertPairingValid(messages: Anthropic.MessageParam[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (typeof m.content === "string") continue;
    const results = m.content.filter((b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result");
    if (results.length) {
      const prev = messages[i - 1];
      expect(prev?.role, `tool_result at ${i} 前面必须是 assistant`).toBe("assistant");
      const uses = new Set(
        (prev!.content as Anthropic.ContentBlockParam[]).filter((b) => b.type === "tool_use").map((b) => (b as Anthropic.ToolUseBlockParam).id),
      );
      for (const r of results) expect(uses.has(r.tool_use_id), `悬空 tool_result ${r.tool_use_id}`).toBe(true);
    }
    const uses = m.content.filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use");
    if (uses.length) {
      const next = messages[i + 1];
      expect(next?.role, `tool_use at ${i} 后面必须紧跟 tool_result`).toBe("user");
      const ids = new Set(
        (next!.content as Anthropic.ContentBlockParam[]).filter((b) => b.type === "tool_result").map((b) => (b as Anthropic.ToolResultBlockParam).tool_use_id),
      );
      for (const u of uses) expect(ids.has(u.id), `悬空 tool_use ${u.id}`).toBe(true);
    }
  }
}

function collapsedBlocks(messages: Anthropic.MessageParam[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "text" && b.text.startsWith(COMPACTED_TURNS_MARKER)) out.push(b.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------- tier 2

describe("tier 2：折叠旧轮（tier 1 无可置换 / 置换后估计仍在水位上）", () => {
  it("只有小结果时 tier 1 一个块都置换不出来 → 折叠保护窗外的旧轮；任务首条与保护窗原样", () => {
    const m = mgr(1000, 2);
    m.noteUsage(usage(900));
    const input = history(4); // task + 4 轮 = 9 条；保护 2 → 折叠第 1~3 轮
    const out = m.compact(input);

    expect(out.droppedBlocks).toBe(0);
    expect(out.changed).toBe(true);
    expect(out.collapsedTurns).toBe(3);
    const blocks = collapsedBlocks(out.messages);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("3 earlier turns collapsed");
    expect(blocks[0]).toContain("决定检查文件 f1");
    expect(blocks[0]).toContain("read_file(path=src/f1.ts)");
    expect(blocks[0]).toContain("✓ read_file: line1 of f1");
    // 任务首条原样、保护窗（第 4 轮）原样
    expect(out.messages.some((x) => x.role === "user" && x.content === "任务：必须保留 A 文件。")).toBe(true);
    expect(JSON.stringify(out.messages.slice(-2))).toEqual(JSON.stringify(input.slice(-2)));
    assertPairingValid(out.messages);
  });

  it("保护窗首条是 tool_result 时，它的 tool_use 所在 assistant 一并保留（配对永不拆散）", () => {
    const m = mgr(1000, 3); // 奇数保护窗：窗首正好落在 tool_result 上
    m.noteUsage(usage(900));
    const out = m.compact(history(4));
    expect(out.collapsedTurns).toBe(2); // 第 3 轮的 assistant 被保护窗"吸"进去，只折叠 1~2
    assertPairingValid(out.messages);
    // 折叠块后面紧跟的必须是 assistant（第 3 轮的 tool_use），不是孤儿 tool_result
    const idx = out.messages.findIndex((x) => collapsedBlocks([x]).length > 0);
    expect(out.messages[idx + 1]!.role).toBe("assistant");
  });

  it("幂等：同一输入二次 compact 不再改动（折叠块只合并不二折）", () => {
    const m = mgr(1000, 2);
    m.noteUsage(usage(900));
    const first = m.compact(history(4));
    const second = m.compact(first.messages);
    expect(second.changed).toBe(false);
    expect(second.collapsedTurns).toBe(0);
    expect(second.droppedBlocks).toBe(0);
    expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages));
  });

  it("确定性：同一输入两个实例给出逐字节相同的输出", () => {
    const a = mgr(1000, 2);
    const b = mgr(1000, 2);
    a.noteUsage(usage(900));
    b.noteUsage(usage(900));
    expect(JSON.stringify(a.compact(history(5)).messages)).toBe(JSON.stringify(b.compact(history(5)).messages));
  });

  it("合并：新轮出保护窗后并入同一个折叠块，正史里永远只有一个 [compacted_turns]", () => {
    const m = mgr(1000, 2);
    m.noteUsage(usage(900));
    const first = m.compact(history(4)); // 折叠 1~3，保留 4
    const grown = [...first.messages, ...turnPair(5), ...turnPair(6)]; // 4、5 出窗，6 受保护
    const second = m.compact(grown);
    expect(second.changed).toBe(true);
    expect(second.collapsedTurns).toBe(2);
    const blocks = collapsedBlocks(second.messages);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("5 earlier turns collapsed");
    expect(blocks[0]).toContain("f1");
    expect(blocks[0]).toContain("f5");
    assertPairingValid(second.messages);
    // 再来一次：无事发生
    expect(m.compact(second.messages).changed).toBe(false);
  });

  it("账本只有一份且不丢：任务约束进 constraints，被折叠的小结果也过一遍账本（write_file 副作用）", () => {
    const m = mgr(1000, 2);
    m.noteUsage(usage(900));
    const input: Anthropic.MessageParam[] = [
      { role: "user", content: "必须保留 board.kicad_sch；不得改网表。" },
      {
        role: "assistant",
        content: [toolUseBlock("tw", "write_file", { path: "notes/plan.md", content: "x" })],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tw", content: "Wrote 12 bytes to notes/plan.md" }] },
      ...turnPair(2),
      ...turnPair(3),
    ];
    const first = m.compact(input);
    expect(first.changed).toBe(true);
    const ledgers = first.messages.filter((x) => JSON.stringify(x).includes(COMPACT_LEDGER_MARKER));
    expect(ledgers).toHaveLength(1);
    const ledgerText = (ledgers[0]!.content as Anthropic.TextBlockParam[]).map((b) => b.text).join("\n");
    const parsed = parseCompactLedgerText(ledgerText);
    expect(parsed.constraints.some((c) => c.includes("必须保留 board.kicad_sch"))).toBe(true);
    // 小结果（tier 1 从不碰的）在被折叠时也要进账本——它从正史里消失了
    expect(parsed.sideEffects.some((s) => s.includes("write_file notes/plan.md"))).toBe(true);

    // 二次压缩：账本仍只有一份，约束仍在
    const second = m.compact([...first.messages, ...turnPair(4), ...turnPair(5)]);
    expect(second.messages.filter((x) => JSON.stringify(x).includes(COMPACT_LEDGER_MARKER))).toHaveLength(1);
    expect(JSON.stringify(second.messages)).toContain("必须保留 board.kicad_sch");
  });

  it("估算闸：tier 1 置换掉的量足以落回水位下 → 不折叠；置换后仍在水位上 → 折叠", () => {
    // 900/1000：一个 3000 字符的大结果置换掉 ≈ 725 token → 估算 175 < 800 → 只有 tier 1
    const enough = mgr(1000, 2);
    enough.noteUsage(usage(900));
    const bigThenSmall: Anthropic.MessageParam[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: [toolUseBlock("big", "bash", { command: "cat log" })] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "big", content: "y".repeat(3000) }] },
      ...turnPair(2),
    ];
    const r1 = enough.compact(bigThenSmall);
    expect(r1.droppedBlocks).toBe(1);
    expect(r1.collapsedTurns).toBe(0);

    // 4000/1000：同样的置换只省 725，估算仍远在水位上 → tier 2 跟上
    const notEnough = mgr(1000, 2);
    notEnough.noteUsage(usage(4000));
    const r2 = notEnough.compact(bigThenSmall);
    expect(r2.droppedBlocks).toBe(1);
    expect(r2.collapsedTurns).toBe(1);
    assertPairingValid(r2.messages);
  });

  it("force + protectRecent=2：水位以下也压，只保最近一轮（反应式硬压缩的形状）", () => {
    const m = mgr(1000, 6);
    m.noteUsage(usage(10)); // 远在水位下
    expect(m.compact(history(4)).changed).toBe(false); // 常规路径不动
    const hard = m.compact(history(4), { force: true, protectRecent: REACTIVE_PROTECT_RECENT });
    expect(hard.changed).toBe(true);
    expect(hard.collapsedTurns).toBe(3);
    expect(hard.messages.slice(-2)).toEqual(history(4).slice(-2));
    assertPairingValid(hard.messages);
  });

  it("没有可折叠的旧轮（只有任务 + 保护窗）→ 不改动、不发事件", () => {
    const m = mgr(1000, 2);
    m.noteUsage(usage(900));
    const out = m.compact(history(1));
    expect(out.changed).toBe(false);
    expect(out.collapsedTurns).toBe(0);
  });
});

// ---------------------------------------------------------------- 上下文超长判定

describe("isContextOverflowError / classifyApiError：两条 wire 的超长形状", () => {
  const anthropicShape = Object.assign(new Error("prompt is too long: 213462 tokens > 200000 maximum"), { status: 400 });
  const openaiShape = Object.assign(
    new Error("This model's maximum context length is 128000 tokens. However, your messages resulted in 131072 tokens."),
    { status: 400, code: "context_length_exceeded" },
  );
  const openaiNested = Object.assign(new Error("Request too large"), {
    status: 400,
    error: { code: "context_length_exceeded", message: "…" },
  });

  it("Anthropic「prompt is too long」/ OpenAI code / 嵌套 error.code 都认", () => {
    expect(isContextOverflowError(anthropicShape)).toBe(true);
    expect(isContextOverflowError(openaiShape)).toBe(true);
    expect(isContextOverflowError(openaiNested)).toBe(true);
  });

  it("其它 400（tool_choice 拒绝）、429、500、abort 一律不认", () => {
    expect(isContextOverflowError(Object.assign(new Error("Thinking mode does not support this tool_choice"), { status: 400 }))).toBe(false);
    expect(isContextOverflowError(Object.assign(new Error("prompt is too long"), { status: 429 }))).toBe(false);
    expect(isContextOverflowError(Object.assign(new Error("context length"), { status: 500 }))).toBe(false);
    expect(isContextOverflowError(new Error("aborted"))).toBe(false);
    expect(isContextOverflowError(null)).toBe(false);
  });

  it("超长是永久错误的子类：不算瞬时；分类文案带 context_overflow 前缀（台账 taxonomy 靠它）", () => {
    expect(isTransientApiError(anthropicShape)).toBe(false);
    expect(isTransientApiError(openaiShape)).toBe(false);
    expect(classifyApiError(anthropicShape).startsWith(CONTEXT_OVERFLOW_ERROR_PREFIX)).toBe(true);
    expect(classifyApiError(openaiShape)).toContain("maximum context length is 128000");
  });

  /**
   * 真端点实测形状（2026-09-03，deepseek-v4-flash @ api.deepseek.com/anthropic，窗口 1,048,576 tokens）：
   * Anthropic 兼容路由回的是 **OpenAI 信封**（没有 Anthropic 的 `type:"error"` 外层），而且 `code` 不是
   * OpenAI 自家的 context_length_exceeded，是笼统的 invalid_request_error——上面两个 mock 形状都覆盖不到：
   * Anthropic 形状靠「prompt is too long」，OpenAI 形状靠 code。真实信号只剩 message 里那句
   * 「maximum context length」。报文逐字照抄真机（数字含 64000 的 completion 份额：端点按
   * messages + max_tokens 之和计超长）；经真实 SDK 的错误工厂包装——message 变成「400 {…json…}」、
   * body 挂 `.error`、content-type 是 application/octet-stream——与 probe 观测逐字一致。
   * 变异验证：删掉 isContextOverflowError 里的 /maximum context length/ 分支，只有这条红。
   */
  it("DeepSeek Anthropic 兼容路由的真实形状：OpenAI 信封 + code=invalid_request_error，只有 message 可认", () => {
    const body = {
      error: {
        message:
          "This model's maximum context length is 1048576 tokens. However, you requested 1220725 tokens " +
          "(1156725 in the messages, 64000 in the completion). Please reduce the length of the messages or completion.",
        type: "invalid_request_error",
        param: null,
        code: "invalid_request_error",
      },
    };
    const err = Anthropic.APIError.generate(
      400,
      body,
      undefined,
      new Headers({ "content-type": "application/octet-stream" }),
    );
    expect(err).toBeInstanceOf(Anthropic.BadRequestError);
    expect(err.status).toBe(400);
    expect(err.message.startsWith('400 {"error":{"message":"This model\'s maximum context length is 1048576 tokens.')).toBe(true);
    expect((err.error as { error: { code: string } }).error.code).toBe("invalid_request_error");
    expect(isContextOverflowError(err)).toBe(true);
    expect(isTransientApiError(err)).toBe(false);
    expect(classifyApiError(err).startsWith(CONTEXT_OVERFLOW_ERROR_PREFIX)).toBe(true);
    expect(classifyApiError(err)).toContain("maximum context length is 1048576");
  });
});

// ---------------------------------------------------------------- 反应式压缩（AgentLoop）

/** 按脚本应答，但在指定的第 N 次 send 上抛一次（或多次）超长 400 */
class OverflowingModel implements ModelClient {
  requests: ModelRequest[] = [];
  private calls = 0;
  private scriptIndex = 0;
  constructor(
    private readonly script: Anthropic.Message[],
    private readonly overflowAtCalls: number[],
  ) {}
  send(req: ModelRequest): Promise<ModelTurn> {
    this.calls += 1;
    this.requests.push(structuredClone(req));
    if (this.overflowAtCalls.includes(this.calls)) {
      throw Object.assign(new Error("prompt is too long: 250000 tokens > 200000 maximum"), { status: 400 });
    }
    const message = this.script[this.scriptIndex++];
    if (!message) throw new Error(`script exhausted at call ${this.calls}`);
    return Promise.resolve({ message, stopReason: message.stop_reason, usage: message.usage });
  }
}

async function runLoop(model: ModelClient, extra: Record<string, unknown> = {}): Promise<TurnEvent[]> {
  const loop = new AgentLoop(
    {
      systemPrompt: "frozen",
      // 结果 ≈ 450 字符：低于 tier 1 的 500 字符门槛（tier 1 碰不到），但足以让折叠真的省下字节
      tools: [makeTool({ name: "reader", execute: async () => ({ content: `line1\n${"small ".repeat(75)}` }) })],
      workdir: process.cwd(),
      errorRetryBackoffMs: 0,
      ...extra,
    },
    model,
  );
  const events: TurnEvent[] = [];
  for await (const e of loop.run("go")) events.push(e);
  return events;
}

describe("反应式压缩：端点 context-too-long 400 → 硬压缩 → 重发同一轮", () => {
  const threeToolTurns = Array.from({ length: 3 }, (_, i) =>
    fakeMessage([toolUseBlock(`tu_${i}`, "reader", { n: i })], "tool_use", { input_tokens: 100 }),
  );

  it("第 4 次 send 撞 400 → 发 compaction{reactive} → 用折叠后的正史重发 → 正常完成，不占瞬时重试额度", async () => {
    const model = new OverflowingModel(
      [...threeToolTurns, fakeMessage([textBlock("done")], "end_turn", { input_tokens: 100 })],
      [4],
    );
    // errorRetries=0：若反应式重发被当成瞬时重试，这里就没有第二次机会，run 会以 error 结束
    const events = await runLoop(model, { errorRetries: 0 });
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("no done");
    expect(done.result.stopReason).toBe("completed");

    const reactive = events.filter((e) => e.type === "compaction" && e.reactive === true);
    expect(reactive).toHaveLength(1);
    if (reactive[0]?.type === "compaction") expect(reactive[0].collapsedTurns).toBeGreaterThan(0);
    // 不是 api_retry：那是瞬时错误的路径
    expect(events.some((e) => e.type === "api_retry")).toBe(false);

    // 第 5 次请求（重发）带折叠块，且比第 4 次（撞墙那次）短
    expect(model.requests).toHaveLength(5);
    const failed = JSON.stringify(model.requests[3]!.messages);
    const resent = JSON.stringify(model.requests[4]!.messages);
    expect(resent).toContain(COMPACTED_TURNS_MARKER);
    expect(failed).not.toContain(COMPACTED_TURNS_MARKER);
    expect(resent.length).toBeLessThan(failed.length);
    // 重发保住了最近一轮的 tool_use / tool_result（保护窗 2）
    expect(resent).toContain("tu_2");
    assertPairingValid(model.requests[4]!.messages);
    // 正史与请求一致：done 里的 messages 也是折叠后的
    expect(JSON.stringify(done.result.messages)).toContain(COMPACTED_TURNS_MARKER);
  });

  it("压缩后仍超长（连续两次 400）→ finish(error)，原因分类为 context_overflow，且只压一次", async () => {
    const model = new OverflowingModel(threeToolTurns, [4, 5]);
    const events = await runLoop(model, { errorRetries: 1 });
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("no done");
    expect(done.result.stopReason).toBe("error");
    expect(done.result.error?.message.startsWith(CONTEXT_OVERFLOW_ERROR_PREFIX)).toBe(true);
    expect(events.filter((e) => e.type === "compaction" && e.reactive === true)).toHaveLength(1);
    // 第二个 400 不再重发：5 次 send（3 成功 + 撞墙 + 重发再撞）
    expect(model.requests).toHaveLength(5);
  });

  it("没有可压的东西（任务 + 一轮）→ 不假装压缩，直接如实报 context_overflow", async () => {
    const model = new OverflowingModel(threeToolTurns.slice(0, 1), [2]);
    const events = await runLoop(model, { errorRetries: 1 });
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("no done");
    expect(done.result.stopReason).toBe("error");
    expect(done.result.error?.message.startsWith(CONTEXT_OVERFLOW_ERROR_PREFIX)).toBe(true);
    expect(events.some((e) => e.type === "compaction")).toBe(false);
    expect(model.requests).toHaveLength(2);
  });

  it("常规水位路径的 compaction 事件带 collapsedTurns，不带 reactive", async () => {
    const script = [
      ...Array.from({ length: 5 }, (_, i) =>
        fakeMessage([toolUseBlock(`tu_${i}`, "reader", { n: i })], "tool_use", { input_tokens: 5000 }),
      ),
      fakeMessage([textBlock("done")], "end_turn", { input_tokens: 5000 }),
    ];
    const events = await runLoop(new FakeModelClient(script), { contextTokenLimit: 5000, errorRetries: 0 });
    const compactions = events.filter((e) => e.type === "compaction");
    expect(compactions.length).toBeGreaterThan(0);
    for (const c of compactions) {
      if (c.type !== "compaction") continue;
      expect(c.reactive).toBeUndefined();
    }
    expect(compactions.some((c) => c.type === "compaction" && (c.collapsedTurns ?? 0) > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------- 入口截断

describe("入口截断：单个 tool_result 进正史前的字符上限", () => {
  it("snipToolResult：上限内原样；超限保留头部并附可操作的分页标记", () => {
    const small = { content: "ok" };
    expect(snipToolResult(small, "bash")).toBe(small);
    const big = snipToolResult({ content: "z".repeat(50_000) }, "stm32__read_memory");
    expect(big.content.length).toBeLessThan(50_000);
    expect(big.content.startsWith("z".repeat(DEFAULT_TOOL_RESULT_MAX_CHARS))).toBe(true);
    expect(big.content).toContain("harness truncated 10000 of 50000 chars");
    expect(big.content).toContain("stm32__read_memory");
    expect(big.content).toContain("AGENT_TOOL_RESULT_MAX_CHARS=40000");
    expect(big.content).toContain("offset/limit");
    // isError 等其它字段保留
    expect(snipToolResult({ content: "e".repeat(5000), isError: true }, "bash", 1000).isError).toBe(true);
    // 下限 1000：再小连标记都放不下
    expect(snipToolResult({ content: "e".repeat(5000) }, "bash", 10).content.startsWith("e".repeat(1000))).toBe(true);
  });

  it("ToolExecutor 路径：事件里的 tool_result 与正史里的同一份，都已截断；cfg.toolResultMaxChars 可调", async () => {
    const huge = makeTool({ name: "huge", execute: async () => ({ content: "h".repeat(100_000) }) });
    const script = [
      fakeMessage([toolUseBlock("t1", "huge", {})], "tool_use"),
      fakeMessage([textBlock("done")], "end_turn"),
    ];
    const model = new FakeModelClient(script);
    const loop = new AgentLoop(
      { systemPrompt: "frozen", tools: [huge], workdir: process.cwd(), toolResultMaxChars: 2000 },
      model,
    );
    const events: TurnEvent[] = [];
    for await (const e of loop.run("go")) events.push(e);
    const result = events.find((e) => e.type === "tool_result");
    if (result?.type !== "tool_result") throw new Error("no tool_result");
    expect(result.result.content.length).toBeLessThan(2600);
    expect(result.result.content).toContain("harness truncated 98000 of 100000 chars");
    // 第二次请求里模型看到的 tool_result 与事件里一致
    const inHistory = JSON.stringify(model.requests[1]!.messages);
    expect(inHistory).toContain("harness truncated 98000 of 100000 chars");
    expect(inHistory).not.toContain("h".repeat(2001));
  });

  it("缺省 40k：内置工具自己的 30k 截断先生效，这一层不重复截", async () => {
    // 模拟内置工具已按 30k 截过的产出：不应再被这一层动
    const thirtyK = "a".repeat(30_000) + "\n...[truncated 5 of 30005 chars]";
    const r = snipToolResult({ content: thirtyK }, "read_file");
    expect(r.content).toBe(thirtyK);
  });
});

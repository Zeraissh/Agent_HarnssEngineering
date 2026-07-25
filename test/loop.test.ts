import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { AgentLoop } from "../src/loop.js";
import type { AgentRunResult, TurnEvent } from "../src/types.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock, toolUseBlock } from "./helpers.js";

async function collect(events: AsyncIterable<TurnEvent>): Promise<{
  events: TurnEvent[];
  result: AgentRunResult;
}> {
  const all: TurnEvent[] = [];
  for await (const e of all_iter(events)) {
    all.push(e);
    if (e.type === "approval_request") e.respond("allow");
  }
  const done = all.at(-1);
  if (done?.type !== "done") throw new Error("last event was not done");
  return { events: all, result: done.result };
}

// eslint 风格辅助：直接透传（保留一个命名以便阅读）
function all_iter(it: AsyncIterable<TurnEvent>): AsyncIterable<TurnEvent> {
  return it;
}

const baseConfig = {
  systemPrompt: "test system",
  workdir: process.cwd(),
};

describe("AgentLoop", () => {
  it("tool_use → end_turn：工具结果合并进单条 user 消息，id 一一对应", async () => {
    const model = new FakeModelClient([
      fakeMessage(
        [textBlock("using tools"), toolUseBlock("tu_1", "alpha", {}), toolUseBlock("tu_2", "beta", {})],
        "tool_use",
      ),
      fakeMessage([textBlock("done")], "end_turn"),
    ]);
    const loop = new AgentLoop(
      { ...baseConfig, tools: [makeTool({ name: "alpha" }), makeTool({ name: "beta" })] },
      model,
    );
    const { result } = await collect(loop.run("go"));

    expect(result.stopReason).toBe("completed");
    // 历史结构：user, assistant(tool_use), user(tool_results), assistant(end)
    expect(result.messages).toHaveLength(4);
    const toolResultMsg = result.messages[2]!;
    expect(toolResultMsg.role).toBe("user");
    const blocks = toolResultMsg.content as Anthropic.ToolResultBlockParam[];
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.tool_use_id).sort()).toEqual(["tu_1", "tu_2"]);
    expect(blocks.every((b) => b.type === "tool_result")).toBe(true);
  });

  it("parallelSafe 工具并发执行，非 parallelSafe 串行", async () => {
    const timeline: string[] = [];
    const slowParallel = (name: string) =>
      makeTool({
        name,
        parallelSafe: true,
        execute: async () => {
          timeline.push(`${name}:start`);
          await new Promise((r) => setTimeout(r, 30));
          timeline.push(`${name}:end`);
          return { content: "ok" };
        },
      });
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_1", "p1", {}), toolUseBlock("tu_2", "p2", {})], "tool_use"),
      fakeMessage([textBlock("done")], "end_turn"),
    ]);
    const loop = new AgentLoop(
      { ...baseConfig, tools: [slowParallel("p1"), slowParallel("p2")] },
      model,
    );
    await collect(loop.run("go"));
    // 并发证明：两个 start 都发生在任一 end 之前
    expect(timeline.slice(0, 2).sort()).toEqual(["p1:start", "p2:start"]);
  });

  it("pause_turn：原样重发，不追加用户消息", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock("working on server tools...")], "pause_turn"),
      fakeMessage([textBlock("done")], "end_turn"),
    ]);
    const loop = new AgentLoop({ ...baseConfig, tools: [] }, model);
    const { result } = await collect(loop.run("go"));

    expect(result.stopReason).toBe("completed");
    expect(model.requests).toHaveLength(2);
    // 第二次请求：user, assistant(paused) —— 中间没有插入任何 user 消息
    const second = model.requests[1]!;
    expect(second.messages).toHaveLength(2);
    expect(second.messages[1]!.role).toBe("assistant");
  });

  it("maxTurns 护栏：到限后不再发请求，以 max_turns 结束", async () => {
    const endless = () =>
      fakeMessage([toolUseBlock(`tu_${Math.random()}`, "alpha", {})], "tool_use");
    const model = new FakeModelClient([endless(), endless(), endless(), endless()]);
    const loop = new AgentLoop(
      { ...baseConfig, tools: [makeTool({ name: "alpha" })], maxTurns: 2 },
      model,
    );
    const { result } = await collect(loop.run("go"));
    expect(result.stopReason).toBe("max_turns");
    expect(model.requests).toHaveLength(2);
  });

  it("工具抛异常：循环不中断，模型收到 is_error 的 tool_result", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_1", "boom", {})], "tool_use"),
      fakeMessage([textBlock("recovered")], "end_turn"),
    ]);
    const boom = makeTool({
      name: "boom",
      execute: async () => {
        throw new Error("disk on fire");
      },
    });
    const loop = new AgentLoop({ ...baseConfig, tools: [boom] }, model);
    const { events, result } = await collect(loop.run("go"));

    expect(result.stopReason).toBe("completed");
    const blocks = result.messages[2]!.content as Anthropic.ToolResultBlockParam[];
    expect(blocks[0]!.is_error).toBe(true);
    expect(blocks[0]!.content).toContain("disk on fire");
    const resultEvent = events.find((e) => e.type === "tool_result");
    expect(resultEvent?.type === "tool_result" && resultEvent.result.isError).toBe(true);
  });

  it("审批 deny：不终止循环，理由以 is_error 回传模型", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_1", "danger", {})], "tool_use"),
      fakeMessage([textBlock("understood")], "end_turn"),
    ]);
    const loop = new AgentLoop(
      { ...baseConfig, tools: [makeTool({ name: "danger", permission: "ask" })] },
      model,
    );
    const all: TurnEvent[] = [];
    for await (const e of loop.run("go")) {
      all.push(e);
      if (e.type === "approval_request") e.respond("deny", "too risky today");
    }
    const done = all.at(-1);
    if (done?.type !== "done") throw new Error("no done event");
    expect(done.result.stopReason).toBe("completed");
    const blocks = done.result.messages[2]!.content as Anthropic.ToolResultBlockParam[];
    expect(blocks[0]!.is_error).toBe(true);
    expect(blocks[0]!.content).toContain("too risky today");
  });

  it("refusal：立即结束且不重试", async () => {
    const model = new FakeModelClient([fakeMessage([], "refusal")]);
    const loop = new AgentLoop({ ...baseConfig, tools: [] }, model);
    const { result } = await collect(loop.run("go"));
    expect(result.stopReason).toBe("refusal");
    expect(model.requests).toHaveLength(1);
  });

  it("max_tokens：优雅终止（非 error），已生成的部分内容保留在历史中", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock("这是一份很长的报告，写到一半就")], "max_tokens"),
    ]);
    const loop = new AgentLoop({ ...baseConfig, tools: [] }, model);
    const { events, result } = await collect(loop.run("go"));

    expect(result.stopReason).toBe("max_tokens");
    expect(result.error).toBeUndefined(); // 不是错误
    // 部分 assistant 内容完整保留（可供宿主/用户查看或重跑）
    const last = result.messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(JSON.stringify(last.content)).toContain("写到一半就");
    // assistant_text 事件也发出了截断前的文本
    const textEvent = events.find((e) => e.type === "assistant_text");
    expect(textEvent?.type === "assistant_text" && textEvent.text).toContain("很长的报告");
  });

  it("usage 聚合：三类 token 分开累计且与各轮之和对账一致", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_1", "alpha", {})], "tool_use", {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 0,
      }),
      fakeMessage([textBlock("done")], "end_turn", {
        input_tokens: 20,
        output_tokens: 7,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 100,
      }),
    ]);
    const loop = new AgentLoop({ ...baseConfig, tools: [makeTool({ name: "alpha" })] }, model);
    const { result } = await collect(loop.run("go"));

    expect(result.usage).toMatchObject({
      inputTokens: 30,
      cacheCreationTokens: 100,
      cacheReadTokens: 100,
      outputTokens: 12,
      turns: 2,
    });
    expect(result.usage.cacheHitRatio).toBeCloseTo(100 / 230);
  });

  it("tokens 预算护栏：超限后以 budget_exhausted 结束", async () => {
    const heavy = () =>
      fakeMessage([toolUseBlock(`tu_${Math.random()}`, "alpha", {})], "tool_use", {
        input_tokens: 500,
        output_tokens: 500,
      });
    const model = new FakeModelClient([heavy(), heavy(), heavy()]);
    const loop = new AgentLoop(
      { ...baseConfig, tools: [makeTool({ name: "alpha" })], maxTokensBudget: 1500 },
      model,
    );
    const { result } = await collect(loop.run("go"));
    expect(result.stopReason).toBe("budget_exhausted");
    expect(model.requests.length).toBeLessThanOrEqual(2);
  });
});

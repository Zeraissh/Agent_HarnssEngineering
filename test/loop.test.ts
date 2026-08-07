import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { AgentLoop, backoffWithJitter } from "../src/loop.js";
import type { AgentRunResult, ModelClient, ModelTurn, TurnEvent } from "../src/types.js";
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

describe("瞬时 API 错误的同轮重试", () => {
  class FlakyClient implements ModelClient {
    calls = 0;
    constructor(
      private readonly failures: number,
      private readonly err: unknown,
      private readonly message: Anthropic.Message,
    ) {}
    send(): Promise<ModelTurn> {
      this.calls += 1;
      if (this.calls <= this.failures) return Promise.reject(this.err);
      return Promise.resolve({
        message: this.message,
        stopReason: this.message.stop_reason,
        usage: this.message.usage,
      });
    }
  }
  const transient = () => Object.assign(new Error("upstream 503"), { status: 503 });

  it("503 重试一次成功：产出 api_retry 事件，run 正常完成", async () => {
    const model = new FlakyClient(1, transient(), fakeMessage([textBlock("ok")], "end_turn"));
    const loop = new AgentLoop({ ...baseConfig, tools: [], errorRetryBackoffMs: 0 }, model);
    const { events, result } = await collect(loop.run("t"));
    expect(result.stopReason).toBe("completed");
    expect(events.filter((e) => e.type === "api_retry")).toHaveLength(1);
    expect(model.calls).toBe(2);
  });

  it("重试预算耗尽 → error 终止（errorRetries=1 共两次尝试）", async () => {
    const model = new FlakyClient(99, transient(), fakeMessage([textBlock("ok")], "end_turn"));
    const loop = new AgentLoop(
      { ...baseConfig, tools: [], errorRetries: 1, errorRetryBackoffMs: 0 },
      model,
    );
    const { result } = await collect(loop.run("t"));
    expect(result.stopReason).toBe("error");
    expect(model.calls).toBe(2);
  });

  it("非瞬时错误（401）不重试，立即终止", async () => {
    const model = new FlakyClient(
      99,
      Object.assign(new Error("bad key"), { status: 401 }),
      fakeMessage([textBlock("ok")], "end_turn"),
    );
    const loop = new AgentLoop({ ...baseConfig, tools: [], errorRetryBackoffMs: 0 }, model);
    const { result } = await collect(loop.run("t"));
    expect(result.stopReason).toBe("error");
    expect(model.calls).toBe(1);
  });

  it("errorRetries=0 关闭重试", async () => {
    const model = new FlakyClient(1, transient(), fakeMessage([textBlock("ok")], "end_turn"));
    const loop = new AgentLoop(
      { ...baseConfig, tools: [], errorRetries: 0, errorRetryBackoffMs: 0 },
      model,
    );
    const { result } = await collect(loop.run("t"));
    expect(result.stopReason).toBe("error");
    expect(model.calls).toBe(1);
  });

  it("重试【调用点】真的用了抖动——20 次重试的等待不全相等", async () => {
    // 只测纯函数覆不住调用点：把 loop.ts 改回 `backoffMs * (attempt+1)`，
    // 纯函数那几条照样全绿。这条锁的是"loop 确实按抖动值等待"——
    // 反向自检：改回线性后它立即失败（20 次会全部等于 BASE）。
    const BASE = 8;
    const observed: number[] = [];
    for (let i = 0; i < 20; i++) {
      const model = new FlakyClient(1, transient(), fakeMessage([textBlock("ok")], "end_turn"));
      const loop = new AgentLoop({ ...baseConfig, tools: [], errorRetryBackoffMs: BASE }, model);
      const { events } = await collect(loop.run("t"));
      const retry = events.find((e) => e.type === "api_retry");
      expect(retry).toBeDefined();
      observed.push((retry as Extract<TurnEvent, { type: "api_retry" }>).backoffMs);
    }
    // 等量抖动值域：[ceiling/2, ceiling]，attempt=0 时 ceiling = BASE
    expect(Math.min(...observed)).toBeGreaterThanOrEqual(BASE / 2);
    expect(Math.max(...observed)).toBeLessThanOrEqual(BASE);
    expect(new Set(observed).size).toBeGreaterThan(1);
  });
});

describe("退避抖动（V-27 并行编排引入的触发条件）", () => {
  it("等量抖动：恒在 [ceiling/2, ceiling]，且随 attempt 递增", () => {
    for (const attempt of [0, 1, 2]) {
      const ceiling = 1500 * (attempt + 1);
      expect(backoffWithJitter(1500, attempt, () => 0)).toBe(ceiling / 2);
      expect(backoffWithJitter(1500, attempt, () => 1)).toBe(ceiling);
      expect(backoffWithJitter(1500, attempt, () => 0.5)).toBe(Math.round(ceiling * 0.75));
    }
  });

  it("绝不返回接近 0 的等待——429 说的是「你太快了」，全抖动在这里是错的", () => {
    // 全抖动取 [0, ceiling]，random()→0 时几乎立刻重发；等量抖动保证等到一半
    expect(backoffWithJitter(1500, 0, () => 0)).toBe(750);
  });

  it("三条同时开始的重试轨被真正拉开（不是整体推后）", () => {
    // V-27 之前只有一条轨，线性退避无害；cap=3 并行后同时撞 429 会同步重试
    const rails = [0.05, 0.5, 0.95].map((r) => backoffWithJitter(1500, 0, () => r));
    expect(new Set(rails).size).toBe(3);
    expect(Math.max(...rails) - Math.min(...rails)).toBeGreaterThan(600);
  });

  it("backoffMs=0 仍然是 0（既有测试靠这条零延迟跑）", () => {
    expect(backoffWithJitter(0, 3, () => 0.9)).toBe(0);
  });
});

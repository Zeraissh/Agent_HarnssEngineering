import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { AgentLoop, backoffWithJitter, createRunBudget } from "../src/loop.js";
import {
  FINISH_TASK_TOOL_NAME,
  withTaskCompletion,
} from "../src/task-completion.js";
import type { AgentRunResult, ModelClient, ModelRequest, ModelTurn, TurnEvent } from "../src/types.js";
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

  /**
   * B0b 结构化禁工具（案例 #9 第二跑实弹催生）：收口段的"别再调工具"不能靠
   * 模型自觉——tool_choice=none 已随请求发出，但兼容端点可能只收不认。
   * loop 层是真不变量：不执行、回可操作拒绝、让模型用剩余轮次写结论。
   */
  it("toolChoice=none：模型仍请求工具时不执行，回拒绝结果，下一轮的纯文本被采纳", async () => {
    let executed = 0;
    const probe = makeTool({
      name: "probe",
      execute: async () => {
        executed += 1;
        return { content: "should never run" };
      },
    });
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_1", "probe", {})], "tool_use"),
      fakeMessage([textBlock("最终结论")], "end_turn"),
    ]);
    const loop = new AgentLoop({ ...baseConfig, tools: [probe], toolChoice: "none" }, model);
    const { events, result } = await collect(loop.run("收口"));

    expect(executed, "禁工具段的工具绝不能真的执行").toBe(0);
    // 请求层也带了 tool_choice（省轮数的优化层）
    expect(model.requests[0]!.toolChoice).toBe("none");
    // 拒绝以 tool_result 形式回给模型（API 结构约束：每个 tool_use 必须有对应结果）
    const refusal = events.find((e) => e.type === "tool_result");
    expect(refusal && refusal.type === "tool_result" && refusal.result.isError).toBe(true);
    const resultMsg = result.messages[2]!;
    expect(JSON.stringify(resultMsg.content)).toContain("此阶段工具不可用");
    expect(result.stopReason).toBe("completed");
  });

  it("未设 toolChoice 的 loop 不受影响：请求不带 tool_choice，工具照常执行", async () => {
    let executed = 0;
    const probe = makeTool({
      name: "probe",
      execute: async () => {
        executed += 1;
        return { content: "ran" };
      },
    });
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_1", "probe", {})], "tool_use"),
      fakeMessage([textBlock("done")], "end_turn"),
    ]);
    const { result } = await collect(new AgentLoop({ ...baseConfig, tools: [probe] }, model).run("go"));
    expect(executed).toBe(1);
    expect(model.requests[0]!.toolChoice).toBeUndefined();
    expect(result.stopReason).toBe("completed");
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

describe("思考过程透出（委托方反馈：运行中只有直播条一行，看不到模型在想什么）", () => {
  const thinkingBlock = (t: string) =>
    ({ type: "thinking", thinking: t, signature: "sig" }) as unknown as Anthropic.ContentBlock;
  const redactedBlock = () =>
    ({ type: "redacted_thinking", data: "xxx" }) as unknown as Anthropic.ContentBlock;

  it("思考块发成事件，运行中即可见（此前只进会话正史，每段结束才落盘）", async () => {
    const model = new FakeModelClient([
      fakeMessage([thinkingBlock("先读 package.json 再动手"), textBlock("好的")], "end_turn"),
    ]);
    const loop = new AgentLoop({ ...baseConfig, tools: [] }, model);
    const { events } = await collect(loop.run("t"));

    const think = events.find((e) => e.type === "assistant_thinking") as Extract<
      TurnEvent,
      { type: "assistant_thinking" }
    >;
    expect(think, "未发出 assistant_thinking 事件").toBeDefined();
    expect(think.text).toBe("先读 package.json 再动手");
    expect(think.redacted).toBe(false);
    expect(think.turn).toBe(1);

    // 顺序：思考在正文之前——它就是在正文之前发生的
    const types = events.map((e) => e.type);
    expect(types.indexOf("assistant_thinking")).toBeLessThan(types.indexOf("assistant_text"));
  });

  it("redacted_thinking 照实标注，不假装没有", async () => {
    const model = new FakeModelClient([
      fakeMessage([redactedBlock(), textBlock("好的")], "end_turn"),
    ]);
    const { events } = await collect(new AgentLoop({ ...baseConfig, tools: [] }, model).run("t"));
    const think = events.find((e) => e.type === "assistant_thinking") as Extract<
      TurnEvent,
      { type: "assistant_thinking" }
    >;
    expect(think.redacted).toBe(true);
    expect(think.text).toBe("");
  });

  it("没有思考块时不发空事件（compat 端点多数不返回 thinking）", async () => {
    const model = new FakeModelClient([fakeMessage([textBlock("直接答")], "end_turn")]);
    const { events } = await collect(new AgentLoop({ ...baseConfig, tools: [] }, model).run("t"));
    expect(events.some((e) => e.type === "assistant_thinking")).toBe(false);
  });

  it("思考块仍然完整进历史（发事件不能改变消息内容，否则第三方端点会 400）", async () => {
    const model = new FakeModelClient([
      fakeMessage([thinkingBlock("想一想"), textBlock("答")], "end_turn"),
    ]);
    const { result } = await collect(new AgentLoop({ ...baseConfig, tools: [] }, model).run("t"));
    const assistant = result.messages.find((m) => m.role === "assistant")!;
    expect(JSON.stringify(assistant.content)).toContain("想一想");
  });
});

describe("思考流式增量（thinking_delta）", () => {
  class DeltaClient implements ModelClient {
    constructor(private deltas: { kind: "text" | "thinking"; text: string }[]) {}
    send(_req: ModelRequest, onDelta?: (d: any) => void): Promise<ModelTurn> {
      for (const d of this.deltas) onDelta?.(d);
      const m = fakeMessage([textBlock("答")], "end_turn");
      return Promise.resolve({ message: m, stopReason: m.stop_reason, usage: m.usage });
    }
  }

  it("两路增量分别发成 thinking_delta / text_delta，不混成一路", async () => {
    const model = new DeltaClient([
      { kind: "thinking", text: "想…" },
      { kind: "text", text: "说…" },
    ]);
    const { events } = await collect(new AgentLoop({ ...baseConfig, tools: [] }, model).run("t"));
    const think = events.filter((e) => e.type === "thinking_delta");
    const text = events.filter((e) => e.type === "text_delta");
    expect(think).toHaveLength(1);
    expect(text).toHaveLength(1);
    expect((think[0] as any).text).toBe("想…");
    expect((text[0] as any).text).toBe("说…");
  });

  it("端点不吐思考增量时只是没有这一路，不影响文本与控制流", async () => {
    const model = new DeltaClient([{ kind: "text", text: "只有正文" }]);
    const { events, result } = await collect(
      new AgentLoop({ ...baseConfig, tools: [] }, model).run("t"),
    );
    expect(events.some((e) => e.type === "thinking_delta")).toBe(false);
    expect(result.stopReason).toBe("completed");
  });
});

describe("终结工具（§2.1：交付即调用）", () => {
  /**
   * 判据来自台账：52 次裁决里 wrapup 69.2%——主要失效不是"写了散文不是 JSON"，
   * 是"跑满预算从没写出结论"。所以这一组锁的不是格式，是**终止**：
   * 模型一旦交付，运行必须就地结束，且不得再有副作用。
   */
  const deliverTool = makeTool({ name: "submit_x" });
  const sideEffect = makeTool({ name: "writes_stuff" });

  it("调用终结工具 → 就地以 completed 收尾，不再发请求", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_1", "submit_x", { ok: true })], "tool_use"),
      // 脚本里还有第二条——真被消费掉就说明 loop 没有就地收尾
      fakeMessage([textBlock("不该走到这里")], "end_turn"),
    ]);
    const { result } = await collect(
      new AgentLoop(
        { ...baseConfig, tools: [deliverTool], terminalTool: "submit_x" },
        model,
      ).run("t"),
    );
    expect(result.stopReason).toBe("completed");
    expect(model.requests, "交付之后不该再有第二次模型调用").toHaveLength(1);
  });

  it("同轮的其它工具一律不执行——交付之后再取证会让「完成」变得可争议", async () => {
    let executed = 0;
    const counting = makeTool({
      name: "writes_stuff",
      execute: async () => {
        executed += 1;
        return { content: "ran" };
      },
    });
    const model = new FakeModelClient([
      fakeMessage(
        [
          toolUseBlock("tu_1", "writes_stuff", {}),
          toolUseBlock("tu_2", "submit_x", { ok: true }),
        ],
        "tool_use",
      ),
    ]);
    const { events, result } = await collect(
      new AgentLoop(
        { ...baseConfig, tools: [deliverTool, counting], terminalTool: "submit_x" },
        model,
      ).run("t"),
    );
    expect(executed, "同轮的副作用工具必须零执行").toBe(0);
    expect(result.stopReason).toBe("completed");

    // 每条 tool_call 都要有回执，否则界面留下一条永远转圈的调用
    const calls = events.filter((e) => e.type === "tool_call");
    const results = events.filter((e) => e.type === "tool_result");
    expect(calls).toHaveLength(2);
    expect(results.map((r) => (r as { toolUseId: string }).toolUseId).sort()).toEqual([
      "tu_1",
      "tu_2",
    ]);
  });

  it("正史保持 API 合法：每个 tool_use 都有对应 tool_result（这段可能被续跑复用）", async () => {
    const model = new FakeModelClient([
      fakeMessage(
        [toolUseBlock("tu_1", "writes_stuff", {}), toolUseBlock("tu_2", "submit_x", {})],
        "tool_use",
      ),
    ]);
    const { result } = await collect(
      new AgentLoop(
        { ...baseConfig, tools: [deliverTool, sideEffect], terminalTool: "submit_x" },
        model,
      ).run("t"),
    );
    const uses = new Set<string>();
    const answered = new Set<string>();
    for (const m of result.messages) {
      if (typeof m.content === "string") continue;
      for (const b of m.content) {
        if (b.type === "tool_use") uses.add(b.id);
        if (b.type === "tool_result") answered.add(b.tool_use_id);
      }
    }
    expect(uses.size).toBe(2);
    expect([...uses].every((id) => answered.has(id)), "每个 tool_use 都得有回执").toBe(true);
  });

  it("未声明 terminalTool 时同名工具照常执行——这个机制不得误伤普通工具面", async () => {
    let executed = 0;
    const normal = makeTool({
      name: "submit_x",
      execute: async () => {
        executed += 1;
        return { content: "ran" };
      },
    });
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_1", "submit_x", {})], "tool_use"),
      fakeMessage([textBlock("done")], "end_turn"),
    ]);
    await collect(new AgentLoop({ ...baseConfig, tools: [normal] }, model).run("t"));
    expect(executed).toBe(1);
    expect(model.requests).toHaveLength(2);
  });

  it("请求体带上 tool_choice：强制交付这件事必须真的发到 wire 上", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_1", "submit_x", {})], "tool_use"),
    ]);
    await collect(
      new AgentLoop(
        {
          ...baseConfig,
          tools: [deliverTool],
          terminalTool: "submit_x",
          toolChoice: { type: "tool", name: "submit_x" },
        },
        model,
      ).run("t"),
    );
    expect(model.requests[0]!.toolChoice).toEqual({ type: "tool", name: "submit_x" });
  });
});

describe("目标级闭环：共享预算 + 结构化完成门", () => {
  it("harness 自身意外异常也必须以 done(error) 关队列，不能让宿主永久挂起", async () => {
    const brokenModel: ModelClient = {
      // 故意破坏 ModelTurn 内部形状，模拟 client 适配器的实现缺陷而非正常 API 错误。
      send: async () => ({ message: undefined, stopReason: "end_turn", usage: undefined } as never),
    };
    const { events, result } = await collect(
      new AgentLoop({ ...baseConfig, tools: [] }, brokenModel).run("触发意外异常"),
    );
    expect(events.at(-1)?.type).toBe("done");
    expect(result.stopReason).toBe("error");
    expect(result.error).toBeInstanceOf(Error);
  });

  it("同一个 AgentLoop 的 continuation 共享总轮次预算，不得每段清零", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock("第一段")], "end_turn"),
      fakeMessage([textBlock("第二段")], "end_turn"),
      // 不应被消费：总预算已经用完
      fakeMessage([textBlock("第三段")], "end_turn"),
    ]);
    const budget = createRunBudget({ maxTurns: 2 });
    const loop = new AgentLoop({ ...baseConfig, tools: [], runBudget: budget }, model);

    const first = await collect(loop.run("开始"));
    const second = await collect(loop.runContinuation(first.result.messages, "继续"));
    const third = await collect(loop.runContinuation(second.result.messages, "再继续"));

    expect(first.result.stopReason).toBe("completed");
    expect(second.result.stopReason).toBe("completed");
    expect(third.result.stopReason).toBe("budget_exhausted");
    expect(model.requests).toHaveLength(2);
    expect(budget.usedTurns).toBe(2);
  });

  it("并行 AgentLoop 对共享总轮次先预占，maxTurns=1 不得同时发出两次请求", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock("唯一允许的请求")], "end_turn"),
      fakeMessage([textBlock("不应被消费")], "end_turn"),
    ]);
    const budget = createRunBudget({ maxTurns: 1 });
    const cfg = { ...baseConfig, tools: [], runBudget: budget };
    const [a, b] = await Promise.all([
      collect(new AgentLoop(cfg, model).run("A")),
      collect(new AgentLoop(cfg, model).run("B")),
    ]);

    expect([a.result.stopReason, b.result.stopReason].sort()).toEqual([
      "budget_exhausted",
      "completed",
    ]);
    expect(model.requests).toHaveLength(1);
    expect(budget.usedTurns).toBe(1);
  });

  it("并行 AgentLoop 在显式 token 总账下串行记账，不得基于旧余额同时起跑", async () => {
    const model = new FakeModelClient([
      fakeMessage(
        [textBlock("唯一允许的请求")],
        "end_turn",
        { input_tokens: 100, output_tokens: 50 },
      ),
      fakeMessage([textBlock("不应被消费")], "end_turn"),
    ]);
    const budget = createRunBudget({ maxTokens: 150 });
    const cfg = { ...baseConfig, tools: [], runBudget: budget };
    const [a, b] = await Promise.all([
      collect(new AgentLoop(cfg, model).run("A")),
      collect(new AgentLoop(cfg, model).run("B")),
    ]);

    expect([a.result.stopReason, b.result.stopReason].sort()).toEqual([
      "budget_exhausted",
      "completed",
    ]);
    expect(model.requests).toHaveLength(1);
    expect(budget.usedTokens).toBe(150);
    expect(budget.usedTurns).toBe(1);
  });

  it("maxTokensBudget 在 continuation 中仍是整个 run 的预算（修前会重新起算）", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock("第一段")], "end_turn", { input_tokens: 100, output_tokens: 50 }),
      fakeMessage([textBlock("不应执行")], "end_turn"),
    ]);
    const loop = new AgentLoop(
      { ...baseConfig, tools: [], maxTokensBudget: 150 },
      model,
    );
    const first = await collect(loop.run("开始"));
    const second = await collect(loop.runContinuation(first.result.messages, "继续"));
    expect(second.result.stopReason).toBe("budget_exhausted");
    expect(model.requests).toHaveLength(1);
  });

  it("end_turn 不再冒充完成：先提醒使用 ask_user/finish_task，再以结构化 blocked 收尾", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock("请告诉我你所在的城市")], "end_turn"),
      fakeMessage(
        [
          toolUseBlock("tu_finish", FINISH_TASK_TOOL_NAME, {
            status: "blocked",
            summary: "缺少查询天气所需的城市",
            artifacts: [],
            verification: [],
            assumptions: [],
            blockers: ["委托方尚未提供城市"],
          }),
        ],
        "tool_use",
      ),
    ]);
    const cfg = withTaskCompletion({ ...baseConfig, tools: [] }, { progressExtensionTurns: 0 });
    const { events, result } = await collect(new AgentLoop(cfg, model).run("今天天气怎么样"));

    expect(result.stopReason).toBe("blocked");
    expect(result.completion?.summary).toContain("城市");
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests[1]!.messages.at(-1)!.content)).toContain("ask_user");
    expect(events.some((e) => e.type === "recovery_decision" && e.action === "request_completion")).toBe(true);
  });

  it("兼容端点无视强制 tool_choice 时最多再给一轮，且不得执行其它工具", async () => {
    let probeCalls = 0;
    const probe = makeTool({
      name: "probe",
      execute: async () => {
        probeCalls += 1;
        return { content: "不应执行" };
      },
    });
    const model = new FakeModelClient([
      fakeMessage([textBlock("文字收尾 1")], "end_turn"),
      fakeMessage([textBlock("文字收尾 2")], "end_turn"),
      // 第三轮已被宿主限定为 finish_task；兼容端点故意无视 tool_choice。
      fakeMessage([toolUseBlock("ignored", "probe", {})], "tool_use"),
      fakeMessage([textBlock("不应再请求")], "end_turn"),
    ]);
    const cfg = withTaskCompletion({ ...baseConfig, tools: [probe] }, { progressExtensionTurns: 0 });
    const { result } = await collect(new AgentLoop(cfg, model).run("任务"));

    expect(result.stopReason).toBe("incomplete");
    expect(model.requests).toHaveLength(3);
    expect(model.requests[2]!.toolChoice).toEqual({ type: "tool", name: FINISH_TASK_TOOL_NAME });
    expect(probeCalls).toBe(0);
  });

  it("finish_task 入参无效时不许收尾：回 is_error 后给模型一次修正机会", async () => {
    const model = new FakeModelClient([
      fakeMessage(
        [toolUseBlock("bad", FINISH_TASK_TOOL_NAME, { status: "completed", summary: "" })],
        "tool_use",
      ),
      fakeMessage(
        [
          toolUseBlock("good", FINISH_TASK_TOOL_NAME, {
            status: "completed",
            summary: "交付完成",
            artifacts: ["out.txt"],
            verification: ["tests passed"],
            assumptions: [],
            blockers: [],
          }),
        ],
        "tool_use",
      ),
    ]);
    const cfg = withTaskCompletion({ ...baseConfig, tools: [] }, { progressExtensionTurns: 0 });
    const { events, result } = await collect(new AgentLoop(cfg, model).run("做任务"));

    expect(result.stopReason).toBe("completed");
    const invalid = events.find(
      (e) => e.type === "tool_result" && e.toolUseId === "bad",
    );
    expect(invalid?.type === "tool_result" && invalid.result.isError).toBe(true);
    expect(model.requests).toHaveLength(2);
  });

  it("执行轮次用尽但仍有新证据 → 同上下文追加一小段，而不是盲目整段提额", async () => {
    const probe = makeTool({
      name: "probe",
      execute: async (input) => ({ content: `evidence:${JSON.stringify(input)}` }),
    });
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("t1", "probe", { step: 1 })], "tool_use"),
      fakeMessage([toolUseBlock("t2", "probe", { step: 2 })], "tool_use"),
      fakeMessage(
        [
          toolUseBlock("done", FINISH_TASK_TOOL_NAME, {
            status: "completed",
            summary: "两步取证完成",
            artifacts: [],
            verification: ["step 1", "step 2"],
            assumptions: [],
            blockers: [],
          }),
        ],
        "tool_use",
      ),
    ]);
    const cfg = withTaskCompletion(
      { ...baseConfig, tools: [probe], maxTurns: 2 },
      { progressExtensionTurns: 2 },
    );
    const { events, result } = await collect(new AgentLoop(cfg, model).run("长任务"));

    expect(result.stopReason).toBe("completed");
    expect(model.requests).toHaveLength(3);
    expect(events.some((e) => e.type === "recovery_decision" && e.action === "continue_with_context")).toBe(true);
  });
});

describe("目标级闭环：停滞检测与恢复路由", () => {
  it("同工具+同入参+同结果连续重复：先要求换策略，再强制结构化收口", async () => {
    let calls = 0;
    const probe = makeTool({
      name: "probe",
      execute: async () => {
        calls += 1;
        return { content: "still locked" };
      },
    });
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("t1", "probe", { target: "A" })], "tool_use"),
      fakeMessage([toolUseBlock("t2", "probe", { target: "A" })], "tool_use"),
      fakeMessage([toolUseBlock("t3", "probe", { target: "A" })], "tool_use"),
      fakeMessage(
        [
          toolUseBlock("stop", FINISH_TASK_TOOL_NAME, {
            status: "blocked",
            summary: "目标持续被锁定",
            artifacts: [],
            verification: [],
            assumptions: [],
            blockers: ["probe 连续返回 still locked"],
          }),
        ],
        "tool_use",
      ),
    ]);
    const cfg = withTaskCompletion(
      { ...baseConfig, tools: [probe], maxTurns: 10 },
      { stagnationWindow: 2, maxStagnationRecoveries: 1, progressExtensionTurns: 0 },
    );
    const { events, result } = await collect(new AgentLoop(cfg, model).run("处理 A"));

    expect(result.stopReason).toBe("blocked");
    expect(calls).toBe(3);
    const decisions = events.filter((e) => e.type === "recovery_decision");
    expect(decisions.some((e) => e.type === "recovery_decision" && e.action === "change_strategy")).toBe(true);
    expect(decisions.some((e) => e.type === "recovery_decision" && e.action === "force_completion")).toBe(true);
    expect(model.requests.at(-1)!.toolChoice).toEqual({ type: "tool", name: FINISH_TASK_TOOL_NAME });
  });

  it("输入或结果持续变化不算停滞", async () => {
    const probe = makeTool({
      name: "probe",
      execute: async (input) => ({ content: `changed:${JSON.stringify(input)}` }),
    });
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("t1", "probe", { n: 1 })], "tool_use"),
      fakeMessage([toolUseBlock("t2", "probe", { n: 2 })], "tool_use"),
      fakeMessage(
        [
          toolUseBlock("done", FINISH_TASK_TOOL_NAME, {
            status: "completed",
            summary: "完成",
            artifacts: [],
            verification: [],
            assumptions: [],
            blockers: [],
          }),
        ],
        "tool_use",
      ),
    ]);
    const cfg = withTaskCompletion(
      { ...baseConfig, tools: [probe] },
      { stagnationWindow: 2, progressExtensionTurns: 0 },
    );
    const { events, result } = await collect(new AgentLoop(cfg, model).run("处理"));
    expect(result.stopReason).toBe("completed");
    expect(events.some((e) => e.type === "recovery_decision" && e.reason === "stagnation")).toBe(false);
  });
});

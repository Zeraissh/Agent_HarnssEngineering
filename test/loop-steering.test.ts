/**
 * 信息队列·loop 层插队（steering）契约测试。
 *
 * 守的三件事：
 *   ① drain 在每次模型调用前取空宿主队列，逐条并入末条 user 消息
 *     （appendControlMessage 语义：不造连续两条 user）；
 *   ② 每条注入都发射 steering 事件，位置 = 生效位置（下一轮 turn_start 之前）；
 *   ③ 取空语义——同一指令绝不注入第二次。
 */
import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { AgentLoop } from "../src/loop.js";
import type {
  AgentRunResult,
  ModelClient,
  ModelRequest,
  ModelTurn,
  TurnEvent,
} from "../src/types.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock, toolUseBlock } from "./helpers.js";

async function collect(events: AsyncIterable<TurnEvent>): Promise<{
  events: TurnEvent[];
  result: AgentRunResult;
}> {
  const all: TurnEvent[] = [];
  for await (const e of events) {
    all.push(e);
    if (e.type === "approval_request") e.respond("allow");
  }
  const done = all.at(-1);
  if (done?.type !== "done") throw new Error("last event was not done");
  return { events: all, result: done.result };
}

const baseConfig = {
  systemPrompt: "test system",
  workdir: process.cwd(),
};

/** 抽出一次模型请求末条 user 消息里的全部文本块 */
function lastUserText(req: ModelRequest): string {
  const last = req.messages.at(-1);
  if (!last || last.role !== "user") return "";
  if (typeof last.content === "string") return last.content;
  return (last.content as Anthropic.ContentBlockParam[])
    .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

describe("AgentLoop · 信息队列插队（steering）", () => {
  it("模型调用前已在队列的指令并入首条 user 消息，且发射 steering 事件", async () => {
    const pending = ["改用 TypeScript 写"];
    const model = new FakeModelClient([fakeMessage([textBlock("done")], "end_turn")]);
    const loop = new AgentLoop(
      {
        ...baseConfig,
        tools: [],
        steering: { drain: () => pending.splice(0) },
      },
      model,
    );
    const { events, result } = await collect(loop.run("用 JavaScript 写个脚本"));

    expect(result.stopReason).toBe("completed");
    // 注入：末条 user 同时带着原任务与插队指令（并入同一条，不造连续两条 user）
    const text = lastUserText(model.requests[0]!);
    expect(text).toContain("用 JavaScript 写个脚本");
    expect(text).toContain("改用 TypeScript 写");
    // 事件：一条 steering，且先于 turn_start（注入发生在请求构建之前）
    const steering = events.filter((e) => e.type === "steering");
    expect(steering).toHaveLength(1);
    expect(steering[0]).toMatchObject({ type: "steering", text: "改用 TypeScript 写" });
    const steeringIdx = events.findIndex((e) => e.type === "steering");
    const turnIdx = events.findIndex((e) => e.type === "turn_start");
    expect(steeringIdx).toBeGreaterThanOrEqual(0);
    expect(steeringIdx).toBeLessThan(turnIdx);
    // 取空语义
    expect(pending).toHaveLength(0);
  });

  it("运行中推入的指令在下一次模型调用前注入（工具轮之后），只注入一次", async () => {
    const pending: string[] = [];
    // 第一次 send 发生时模拟"人此刻按了插队重想"
    class MidRunSteerClient extends FakeModelClient {
      override send(req: ModelRequest): Promise<ModelTurn> {
        const out = super.send(req);
        if (this.requests.length === 1) pending.push("别查了，直接给结论");
        return out;
      }
    }
    const model = new MidRunSteerClient([
      fakeMessage([toolUseBlock("tu_1", "probe", {})], "tool_use"),
      fakeMessage([textBlock("结论")], "end_turn"),
    ]);
    const loop = new AgentLoop(
      {
        ...baseConfig,
        tools: [makeTool({ name: "probe" })],
        steering: { drain: () => pending.splice(0) },
      },
      model,
    );
    const { events } = await collect(loop.run("调查一下"));

    expect(model.requests).toHaveLength(2);
    // 第二次请求的末条 user = tool_result + 插队指令并入同一条
    const second = model.requests[1]!;
    const last = second.messages.at(-1)!;
    expect(last.role).toBe("user");
    const blocks = last.content as Anthropic.ContentBlockParam[];
    expect(blocks.some((b) => b.type === "tool_result")).toBe(true);
    expect(lastUserText(second)).toContain("别查了，直接给结论");
    // 恰好一条 steering 事件，且在第二个 turn_start 之前
    const steeringIdxs = events.flatMap((e, i) => (e.type === "steering" ? [i] : []));
    expect(steeringIdxs).toHaveLength(1);
    const turnStarts = events.flatMap((e, i) => (e.type === "turn_start" ? [i] : []));
    expect(turnStarts).toHaveLength(2);
    expect(steeringIdxs[0]!).toBeGreaterThan(turnStarts[0]!);
    expect(steeringIdxs[0]!).toBeLessThan(turnStarts[1]!);
  });

  it("多条指令逐条并入同一条 user 消息；未配置 steering 时行为不变", async () => {
    const pending = ["指令甲", "指令乙"];
    const model = new FakeModelClient([fakeMessage([textBlock("done")], "end_turn")]);
    const loop = new AgentLoop(
      { ...baseConfig, tools: [], steering: { drain: () => pending.splice(0) } },
      model,
    );
    const { events, result } = await collect(loop.run("原始任务"));

    expect(result.stopReason).toBe("completed");
    const text = lastUserText(model.requests[0]!);
    expect(text).toContain("指令甲");
    expect(text).toContain("指令乙");
    expect(events.filter((e) => e.type === "steering")).toHaveLength(2);
    // 末条 user 只有一条（没有连续两条 user）
    const userMsgs = result.messages.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);

    // 未配置 steering：无 steering 事件（基线不污染）
    const plain = new FakeModelClient([fakeMessage([textBlock("done")], "end_turn")]);
    const plainLoop = new AgentLoop({ ...baseConfig, tools: [] }, plain);
    const plainRun = await collect(plainLoop.run("普通任务"));
    expect(plainRun.events.some((e) => e.type === "steering")).toBe(false);
  });
});

// ModelClient 接口核对（防止 override 签名漂移）
const _typecheck: ModelClient | null = null;
void _typecheck;

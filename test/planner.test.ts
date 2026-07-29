import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { parsePlan, runPlanner } from "../src/planner.js";
import { runPlanned } from "../src/orchestrate.js";
import type { ModelClient, ModelRequest, ModelTurn } from "../src/types.js";
import { fakeMessage, textBlock } from "./helpers.js";

const baseConfig = {
  systemPrompt: "shared frozen system",
  workdir: process.cwd(),
  tools: [],
};

class ScriptedClient implements ModelClient {
  requests: ModelRequest[] = [];
  constructor(private script: Anthropic.Message[]) {}
  send(req: ModelRequest): Promise<ModelTurn> {
    this.requests.push(structuredClone(req));
    const m = this.script.shift();
    if (!m) throw new Error(`script exhausted at request ${this.requests.length}`);
    return Promise.resolve({ message: m, stopReason: m.stop_reason, usage: m.usage });
  }
}

const PLAN_JSON =
  '{"subtasks": [' +
  '{"id": "s1", "title": "改固件", "pack": "stm32-coding", "description": "修改 main.c 并构建", "acceptance": ["ELF 存在"]},' +
  '{"id": "s2", "title": "烧录验证", "pack": "stm32-debug", "description": "烧录 build/x.elf 到板子", "acceptance": ["heartbeat 递增"]}' +
  "]}";

describe("parsePlan（宽容解析，fail-closed）", () => {
  it("纯 JSON 计划", () => {
    const p = parsePlan(PLAN_JSON);
    expect(p).toBeDefined();
    expect(p!.subtasks).toHaveLength(2);
    expect(p!.subtasks[0]!.pack).toBe("stm32-coding");
    expect(p!.subtasks[1]!.acceptance).toEqual(["heartbeat 递增"]);
  });

  it("代码围栏 + 前后说明文字", () => {
    const p = parsePlan("拆解如下：\n```json\n" + PLAN_JSON + "\n```\n以上。");
    expect(p).toBeDefined();
    expect(p!.subtasks).toHaveLength(2);
  });

  it('pack 为字符串 "null" 或缺省 → null；id/title 缺省自动补', () => {
    const p = parsePlan('{"subtasks": [{"pack": "null", "description": "做点事", "acceptance": []}]}');
    expect(p).toBeDefined();
    expect(p!.subtasks[0]!.pack).toBeNull();
    expect(p!.subtasks[0]!.id).toBe("s1");
    expect(p!.subtasks[0]!.title).toBeTruthy();
  });

  it("缺 description → 无效（fail-closed）", () => {
    expect(parsePlan('{"subtasks": [{"id": "s1", "acceptance": []}]}')).toBeUndefined();
  });

  it("空 subtasks → 无效（无可执行内容）", () => {
    expect(parsePlan('{"subtasks": []}')).toBeUndefined();
    expect(parsePlan("我觉得不用拆")).toBeUndefined();
  });
});

describe("runPlanner", () => {
  it("散文输出 → 重问一次转写，采纳第二次的计划", async () => {
    const model = new ScriptedClient([
      fakeMessage([textBlock("我把任务拆成两步：第一步改固件，第二步烧录验证。")], "end_turn"),
      fakeMessage([textBlock(PLAN_JSON)], "end_turn"),
    ]);
    const outcome = await runPlanner(baseConfig, model, "任务", []);
    expect(outcome.plan).toBeDefined();
    expect(outcome.plan!.subtasks).toHaveLength(2);
    // 重问提示携带原文（转写而非重新规划）
    expect(JSON.stringify(model.requests[1]!.messages[0]!.content)).toContain("第一步改固件");
    expect(outcome.usage.turns).toBe(2);
  });

  it("空输出 → 不重问，无计划（fail-closed）", async () => {
    const model = new ScriptedClient([fakeMessage([textBlock("")], "end_turn")]);
    const outcome = await runPlanner(baseConfig, model, "任务", []);
    expect(outcome.plan).toBeUndefined();
    expect(model.requests).toHaveLength(1);
  });
});

describe("runPlanned（三角编排）", () => {
  const passVerdict = () =>
    fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "ok"}')], "end_turn");
  const failVerdict = () =>
    fakeMessage([textBlock('{"passed": false, "issues": ["产物缺失"], "summary": "no"}')], "end_turn");

  it("两个子任务顺序执行：验收注入任务书、上游摘要交接下游、按包解析配置", async () => {
    const model = new ScriptedClient([
      fakeMessage([textBlock(PLAN_JSON)], "end_turn"), // planner
      fakeMessage([textBlock("ELF 已构建于 build/x.elf")], "end_turn"), // s1 main
      passVerdict(), // s1 verifier
      fakeMessage([textBlock("烧录完成，heartbeat 递增")], "end_turn"), // s2 main
      passVerdict(), // s2 verifier
    ]);
    const resolvedPacks: (string | null | undefined)[] = [];
    const outcome = await runPlanned(baseConfig, model, "整体任务", {
      resolveSubtask: (sub) => {
        resolvedPacks.push(sub.pack);
        return { cfg: { ...baseConfig, systemPrompt: `pack:${sub.pack}` } };
      },
    });

    expect(outcome.completed).toBe(true);
    expect(outcome.steps).toHaveLength(2);
    expect(resolvedPacks).toEqual(["stm32-coding", "stm32-debug"]);

    // s1 执行请求：验收标准注入任务书；使用了按包解析的 system prompt
    const s1Req = model.requests[1]!;
    const s1Input = JSON.stringify(s1Req.messages[0]!.content);
    expect(s1Input).toContain("验收标准");
    expect(s1Input).toContain("ELF 存在");
    expect(s1Req.system[0]!.text).toBe("pack:stm32-coding");

    // s2 执行请求：携带 s1 的执行摘要作为上游交接
    const s2Input = JSON.stringify(model.requests[3]!.messages[0]!.content);
    expect(s2Input).toContain("上游交接");
    expect(s2Input).toContain("ELF 已构建于 build/x.elf");
  });

  it("子任务核查未通过（含返工）→ 快速失败，后续子任务不执行", async () => {
    const model = new ScriptedClient([
      fakeMessage([textBlock(PLAN_JSON)], "end_turn"), // planner
      fakeMessage([textBlock("完成了")], "end_turn"), // s1 main
      failVerdict(), // s1 verifier #1
      fakeMessage([textBlock("重做了")], "end_turn"), // s1 rework
      failVerdict(), // s1 verifier #2 → s1 finalPassed=false
    ]);
    const outcome = await runPlanned(baseConfig, model, "整体任务", {});
    expect(outcome.completed).toBe(false);
    expect(outcome.steps).toHaveLength(1);
    expect(outcome.steps[0]!.result.finalPassed).toBe(false);
    expect(model.requests).toHaveLength(5); // s2 从未启动
  });

  it("planner 产不出计划 → 不执行任何子任务", async () => {
    const model = new ScriptedClient([
      fakeMessage([textBlock("")], "end_turn"), // planner 空输出
    ]);
    const outcome = await runPlanned(baseConfig, model, "整体任务", {});
    expect(outcome.plan).toBeUndefined();
    expect(outcome.steps).toHaveLength(0);
    expect(outcome.completed).toBe(false);
  });

  it("onPlan 在首个子任务执行前触发", async () => {
    const order: string[] = [];
    const model = new ScriptedClient([
      fakeMessage([textBlock(PLAN_JSON)], "end_turn"),
      fakeMessage([textBlock("done1")], "end_turn"),
      passVerdict(),
      fakeMessage([textBlock("done2")], "end_turn"),
      passVerdict(),
    ]);
    await runPlanned(baseConfig, model, "任务", {
      onPlan: (plan) => {
        order.push(`plan:${plan.subtasks.length}`);
      },
      onEvent: (source, event) => {
        if (event.type === "turn_start" && source.endsWith("/main")) order.push(source);
      },
    });
    expect(order[0]).toBe("plan:2");
    expect(order).toContain("s1/main");
  });
});

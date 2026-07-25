import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { runVerified } from "../src/orchestrate.js";
import { parseVerdict, runVerifier } from "../src/verifier.js";
import type { ModelClient, ModelRequest, ModelTurn } from "../src/types.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock, toolUseBlock } from "./helpers.js";

const baseConfig = {
  systemPrompt: "shared frozen system",
  workdir: process.cwd(),
};

describe("parseVerdict（宽容解析，fail-closed）", () => {
  it("纯 JSON", () => {
    const v = parseVerdict('{"passed": true, "issues": [], "summary": "ok"}');
    expect(v).toEqual({ passed: true, issues: [], summary: "ok" });
  });

  it("代码围栏包裹的 JSON", () => {
    const v = parseVerdict('核查完成。\n```json\n{"passed": false, "issues": ["行数不对"], "summary": "有误"}\n```');
    expect(v.passed).toBe(false);
    expect(v.issues).toEqual(["行数不对"]);
  });

  it("JSON 前后带说明文字", () => {
    const v = parseVerdict('我核查了产出。结论：{"passed": true, "issues": [], "summary": "一致"} 以上。');
    expect(v.passed).toBe(true);
  });

  it("无法解析 → 不通过（fail-closed）", () => {
    const v = parseVerdict("我觉得大概没问题吧");
    expect(v.passed).toBe(false);
    expect(v.issues[0]).toContain("无法解析");
  });
});

describe("runVerifier", () => {
  it("verifier 对写类工具的审批自动 deny，最终产出裁决", async () => {
    const model = new FakeModelClient([
      // verifier 试图用需要审批的工具 → 被内部 deny
      fakeMessage([toolUseBlock("tu_1", "writer", { path: "x" })], "tool_use"),
      // 收到 deny 理由后改用只读手段，输出裁决
      fakeMessage([textBlock('{"passed": false, "issues": ["产物缺失"], "summary": "未通过"}')], "end_turn"),
    ]);
    const writer = makeTool({ name: "writer", permission: "ask" });
    const outcome = await runVerifier({ ...baseConfig, tools: [writer] }, model, {
      task: "写一个文件",
      executorReport: "我写好了",
    });

    expect(outcome.verdict.passed).toBe(false);
    expect(outcome.verdict.issues).toEqual(["产物缺失"]);
    // 第二次请求里应包含 deny 的 is_error tool_result（read-only 理由回传了模型）
    const second = model.requests[1]!;
    const lastMsg = second.messages.at(-1)!;
    const blocks = lastMsg.content as Anthropic.ToolResultBlockParam[];
    expect(blocks[0]!.is_error).toBe(true);
    expect(String(blocks[0]!.content)).toContain("read-only");
  });

  it("verifier 与父级共享 system prompt（缓存前缀一致）", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "ok"}')], "end_turn"),
    ]);
    await runVerifier({ ...baseConfig, tools: [] }, model, { task: "t", executorReport: "r" });
    expect(model.requests[0]!.system[0]!.text).toBe("shared frozen system");
  });

  it("onEvent 透传 verifier 过程事件（工具调用可见）", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_1", "probe", {})], "tool_use"),
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "ok"}')], "end_turn"),
    ]);
    const seen: string[] = [];
    await runVerifier(
      { ...baseConfig, tools: [makeTool({ name: "probe" })] },
      model,
      { task: "t", executorReport: "r" },
      (e) => {
        seen.push(e.type);
      },
    );
    // verifier 自己的工具调用与结果都被透出
    expect(seen).toContain("tool_call");
    expect(seen).toContain("tool_result");
  });
});

describe("runVerified（编排：执行 → 核查 → 返工）", () => {
  /** 按调用顺序分派给 main/verifier/rework 的脚本模型 */
  class ScriptedClient implements ModelClient {
    requests: ModelRequest[] = [];
    constructor(private script: Anthropic.Message[]) {}
    send(req: ModelRequest): Promise<ModelTurn> {
      this.requests.push(structuredClone(req));
      const m = this.script.shift();
      if (!m) throw new Error("script exhausted");
      return Promise.resolve({ message: m, stopReason: m.stop_reason, usage: m.usage });
    }
  }

  it("一次通过：不返工", async () => {
    const model = new ScriptedClient([
      fakeMessage([textBlock("完成了")], "end_turn"), // main
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "产出正确"}')], "end_turn"), // verifier
    ]);
    const outcome = await runVerified({ ...baseConfig, tools: [] }, model, "任务");
    expect(outcome.finalPassed).toBe(true);
    expect(outcome.reworks).toBe(0);
    expect(outcome.verifications).toHaveLength(1);
  });

  it("首轮未通过：返工输入携带问题清单，二轮核查通过", async () => {
    const model = new ScriptedClient([
      fakeMessage([textBlock("完成了")], "end_turn"), // main
      fakeMessage([textBlock('{"passed": false, "issues": ["hello.txt 内容为空"], "summary": "未通过"}')], "end_turn"), // verifier #1
      fakeMessage([textBlock("修好了")], "end_turn"), // rework
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "已修复"}')], "end_turn"), // verifier #2
    ]);
    const outcome = await runVerified({ ...baseConfig, tools: [] }, model, "任务");

    expect(outcome.finalPassed).toBe(true);
    expect(outcome.reworks).toBe(1);
    expect(outcome.verifications).toHaveLength(2);
    // 返工 run（第 3 次请求）的输入包含 verifier 的问题清单
    const reworkInput = JSON.stringify(model.requests[2]!.messages[0]);
    expect(reworkInput).toContain("hello.txt 内容为空");
    expect(reworkInput).toContain("返工");
  });

  it("到达 maxReworks 仍未通过：finalPassed=false", async () => {
    const failVerdict = () =>
      fakeMessage([textBlock('{"passed": false, "issues": ["still broken"], "summary": "no"}')], "end_turn");
    const model = new ScriptedClient([
      fakeMessage([textBlock("done")], "end_turn"), // main
      failVerdict(), // verifier #1
      fakeMessage([textBlock("done again")], "end_turn"), // rework
      failVerdict(), // verifier #2
    ]);
    const outcome = await runVerified({ ...baseConfig, tools: [] }, model, "任务", { maxReworks: 1 });
    expect(outcome.finalPassed).toBe(false);
    expect(outcome.reworks).toBe(1);
  });

  it("主 run 未完成（如护栏触发）：跳过核查直接返回", async () => {
    const model = new ScriptedClient([
      fakeMessage([toolUseBlock("tu_1", "t", {})], "tool_use"), // 只会消耗 maxTurns
    ]);
    const outcome = await runVerified(
      { ...baseConfig, tools: [makeTool({ name: "t" })], maxTurns: 1 },
      model,
      "任务",
    );
    expect(outcome.finalPassed).toBe(false);
    expect(outcome.verifications).toHaveLength(0);
    expect(outcome.main.stopReason).toBe("max_turns");
  });
});

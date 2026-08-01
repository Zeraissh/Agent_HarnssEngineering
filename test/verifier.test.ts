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

  it("裁决非 JSON → 重问一次转写，采纳第二次的裁决", async () => {
    const model = new FakeModelClient([
      // 第一轮：核查做了但最终消息是散文（不符合契约）
      fakeMessage([textBlock("核查完毕：数值 11 正确，文件为纯数字，没有问题。")], "end_turn"),
      // 重问轮：转写为合规 JSON
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "数值与格式均正确"}')], "end_turn"),
    ]);
    const outcome = await runVerifier({ ...baseConfig, tools: [] }, model, {
      task: "t",
      executorReport: "r",
    });
    expect(outcome.verdict.passed).toBe(true);
    expect(outcome.verdict.summary).toBe("数值与格式均正确");
    // 重问提示里应携带第一轮的结论原文（转写而非重新核查）
    expect(model.requests).toHaveLength(2);
    const retryMsg = model.requests[1]!.messages[0]!;
    expect(JSON.stringify(retryMsg.content)).toContain("核查完毕");
    // 两轮 usage 合并
    expect(outcome.usage.turns).toBe(2);
  });

  it("裁决为空输出 → 不重问（无可转写内容），维持 fail-closed", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock("")], "end_turn"),
    ]);
    const outcome = await runVerifier({ ...baseConfig, tools: [] }, model, {
      task: "t",
      executorReport: "r",
    });
    expect(outcome.verdict.passed).toBe(false);
    expect(model.requests).toHaveLength(1);
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

  it("主 run 宿主级失败（error）：跳过核查直接返回", async () => {
    // 非瞬时错误（401）→ loop 不重试 → stopReason=error → 编排短路，不运行 verifier
    class AuthFailClient implements ModelClient {
      send(): Promise<ModelTurn> {
        return Promise.reject(Object.assign(new Error("bad key"), { status: 401 }));
      }
    }
    const outcome = await runVerified({ ...baseConfig, tools: [] }, new AuthFailClient(), "任务");
    expect(outcome.finalPassed).toBe(false);
    expect(outcome.verifications).toHaveLength(0);
    expect(outcome.main.stopReason).toBe("error");
  });
});

describe("runVerified：返工模式与纯产物核查", () => {
  class ScriptedClient2 implements ModelClient {
    requests: ModelRequest[] = [];
    constructor(private script: Anthropic.Message[]) {}
    send(req: ModelRequest): Promise<ModelTurn> {
      this.requests.push(structuredClone(req));
      const m = this.script.shift();
      if (!m) throw new Error("script exhausted");
      return Promise.resolve({ message: m, stopReason: m.stop_reason, usage: m.usage });
    }
  }

  it("inherit 返工：第二轮执行请求携带首轮正史，executionUsage 合计所有轮", async () => {
    const model = new ScriptedClient2([
      fakeMessage([textBlock("完成了")], "end_turn"), // main
      fakeMessage([textBlock('{"passed": false, "issues": ["数字错了"], "summary": "未通过"}')], "end_turn"), // verifier #1
      fakeMessage([textBlock("修好了")], "end_turn"), // rework（inherit 续跑）
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "已修复"}')], "end_turn"), // verifier #2
    ]);
    const outcome = await runVerified({ ...baseConfig, tools: [] }, model, "任务", {
      reworkMode: "inherit",
    });
    expect(outcome.finalPassed).toBe(true);
    const reworkReq = model.requests[2]!;
    // 正史：user(任务) + assistant(完成了) + user(返工反馈)
    expect(reworkReq.messages).toHaveLength(3);
    expect(reworkReq.messages[1]!.role).toBe("assistant");
    expect(JSON.stringify(reworkReq.messages[2]!.content)).toContain("返工");
    expect(outcome.executionUsage.turns).toBe(2);
  });

  it("fresh 返工：第二轮执行请求不携带首轮正史", async () => {
    const model = new ScriptedClient2([
      fakeMessage([textBlock("完成了")], "end_turn"),
      fakeMessage([textBlock('{"passed": false, "issues": ["x"], "summary": "未通过"}')], "end_turn"),
      fakeMessage([textBlock("重做了")], "end_turn"),
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "ok"}')], "end_turn"),
    ]);
    const outcome = await runVerified({ ...baseConfig, tools: [] }, model, "任务", {
      reworkMode: "fresh",
    });
    expect(outcome.finalPassed).toBe(true);
    expect(model.requests[2]!.messages).toHaveLength(1); // 只有全新的返工任务消息
  });

  it("max_turns 后仍核查产物（纯产物哲学），核查通过则 finalPassed", async () => {
    const model = new ScriptedClient2([
      fakeMessage([toolUseBlock("tu_1", "probe", {})], "tool_use"), // main turn1 → max_turns
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "产物已就绪"}')], "end_turn"), // verifier
    ]);
    const outcome = await runVerified(
      { ...baseConfig, tools: [makeTool({ name: "probe" })], maxTurns: 1 },
      model,
      "任务",
    );
    expect(outcome.main.stopReason).toBe("max_turns");
    expect(outcome.finalPassed).toBe(true);
  });
});

describe("verifier 只读命令白名单", () => {
  const PREFIXES = ["cmake --build", "arm-none-eabi-nm", "grep", "wc", "ls"];

  it("isReadOnlyCommand：前缀命中放行，词边界防误放", async () => {
    const { isReadOnlyCommand } = await import("../src/verifier.js");
    expect(isReadOnlyCommand("cmake --build build", PREFIXES)).toBe(true);
    expect(isReadOnlyCommand("arm-none-eabi-nm build/x.elf", PREFIXES)).toBe(true);
    expect(isReadOnlyCommand("grep -c heartbeat src/main.c", PREFIXES)).toBe(true);
    // 词边界：白名单 "ls" 不放行 "lsblk"；"cmake --build" 不放行 "cmake --builder"
    expect(isReadOnlyCommand("lsblk", PREFIXES)).toBe(false);
    expect(isReadOnlyCommand("rm -rf build", PREFIXES)).toBe(false);
  });

  it("isReadOnlyCommand：重定向/链式/子命令替换一律拒绝；管道只允许只读过滤器", async () => {
    const { isReadOnlyCommand } = await import("../src/verifier.js");
    expect(isReadOnlyCommand("arm-none-eabi-nm x.elf > out.txt", PREFIXES)).toBe(false);
    expect(isReadOnlyCommand("cmake --build build && rm -rf src", PREFIXES)).toBe(false);
    expect(isReadOnlyCommand("grep foo; rm bar", PREFIXES)).toBe(false);
    expect(isReadOnlyCommand("grep $(cat cmd) src", PREFIXES)).toBe(false);
    expect(isReadOnlyCommand("arm-none-eabi-nm x.elf | grep g_divisor | wc -l", PREFIXES)).toBe(true);
    expect(isReadOnlyCommand("arm-none-eabi-nm x.elf | xargs rm", PREFIXES)).toBe(false);
  });

  it("审批：白名单命令自动放行执行，其余仍 deny", async () => {
    const model = new FakeModelClient([
      // verifier 先跑一条白名单命令（真实执行），再跑一条越界命令（被 deny），最后裁决
      fakeMessage([toolUseBlock("tu_1", "bash", { command: "wc -l package.json" })], "tool_use"),
      fakeMessage([toolUseBlock("tu_2", "bash", { command: "rm -rf eval-out" })], "tool_use"),
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "ok"}')], "end_turn"),
    ]);
    const { bashTool } = await import("../src/tools/bash.js");
    const results: { id: string; isError: boolean; head: string }[] = [];
    await runVerifier(
      { ...baseConfig, tools: [bashTool] },
      model,
      { task: "t", executorReport: "r", readOnlyCommands: ["wc"] },
      (e) => {
        if (e.type === "tool_result") {
          results.push({
            id: e.toolUseId,
            isError: e.result.isError === true,
            head: e.result.content.split("\n")[0] ?? "",
          });
        }
      },
    );
    const allowed = results.find((r) => r.id === "tu_1")!;
    const denied = results.find((r) => r.id === "tu_2")!;
    expect(allowed.isError).toBe(false); // 真实执行了 wc
    expect(denied.isError).toBe(true);
    expect(denied.head).toContain("read-only");
  });
});

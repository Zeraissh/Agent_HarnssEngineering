import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { continuationVerifyTask, runVerified, verdictFeedbackSummary } from "../src/orchestrate.js";
import { FINISH_TASK_TOOL_NAME, withTaskCompletion } from "../src/task-completion.js";
import {
  DEFAULT_VERIFIER_MAX_TURNS,
  VERIFIER_WRAPUP_MAX_TURNS,
  VERDICT_PARSE_FAIL,
  VERDICT_TOOL_NAME,
  createVerdictTool,
  parseVerdict,
  runVerifier,
  verdictFromToolInput,
} from "../src/verifier.js";
import { PACKS } from "../src/presets.js";
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

  it("三值裁决：unverified/advisory 可选字段解析（rubric-verifier,案例 #6）", () => {
    const v = parseVerdict(
      '{"passed": true, "issues": [], "unverified": ["行数需 wc 复核（bash 被拒）"], "advisory": ["提炼度 | 良 | 抽查三节均为跨报告合并"], "summary": "客观项全过"}',
    );
    expect(v).toEqual({
      passed: true,
      issues: [],
      unverified: ["行数需 wc 复核（bash 被拒）"],
      advisory: ["提炼度 | 良 | 抽查三节均为跨报告合并"],
      summary: "客观项全过",
    });
  });

  it("三值裁决：旧三字段形状不产生多余键（向后兼容）", () => {
    const v = parseVerdict('{"passed": true, "issues": [], "summary": "ok"}');
    expect("unverified" in v).toBe(false);
    expect("advisory" in v).toBe(false);
  });

  it("三值裁决：非数组的扩展字段被忽略,空数组不保留", () => {
    const v = parseVerdict(
      '{"passed": false, "issues": ["x"], "unverified": "不是数组", "advisory": [], "summary": "s"}',
    );
    expect(v).toEqual({ passed: false, issues: ["x"], summary: "s" });
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
      executorReport: "已写",
    });
    expect(outcome.verdict.passed).toBe(false);
    expect(outcome.verdict.issues).toEqual(["产物缺失"]);
    // 第二次请求里应包含 deny 的 is_error tool_result（read-only 理由回传了模型）
    const second = model.requests[1]!;
    const blocks = second.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(blocks[0]!.is_error).toBe(true);
    expect(String(blocks[0]!.content)).toContain("read-only");
  });

  it("verifier 审批门放行 describe_image——视觉取证只读（案例 #9 收官催生的眼睛）", async () => {
    let looked = 0;
    const eyes = makeTool({
      name: "describe_image",
      permission: "ask",
      execute: async () => {
        looked += 1;
        return { content: "板框内无越界元件，丝印参考号可读" };
      },
    });
    const model = new FakeModelClient([
      fakeMessage(
        [toolUseBlock("tu_1", "describe_image", { path: "preview/board.png", question: "元件有越出板框吗" })],
        "tool_use",
      ),
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "视觉核查通过"}')], "end_turn"),
    ]);
    const outcome = await runVerifier({ ...baseConfig, tools: [eyes] }, model, {
      task: "画一块板",
      executorReport: "板已画好",
    });

    expect(looked, "看图应当被放行执行").toBe(1);
    expect(outcome.verdict.passed).toBe(true);
    // 第二次请求里带的是真实描述结果，不是 deny
    const second = model.requests[1]!;
    const blocks = second.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(blocks[0]!.is_error, "视觉取证不该被拒").not.toBe(true);
    expect(String(blocks[0]!.content)).toContain("板框内无越界元件");
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
  it("执行者只调用 finish_task 时，结构化摘要/产物/验证仍进入 verifier 任务书", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("finish", FINISH_TASK_TOOL_NAME, {
        status: "completed",
        summary: "生成了桌面 UI",
        artifacts: ["ui/app.ts"],
        verification: ["npm test 通过"],
        assumptions: [],
        blockers: [],
      })], "tool_use"),
      fakeMessage([toolUseBlock("verdict", VERDICT_TOOL_NAME, {
        passed: true,
        issues: [],
        unverified: [],
        advisory: [],
        summary: "通过",
      })], "tool_use"),
    ]);
    const cfg = withTaskCompletion({ ...baseConfig, tools: [] });
    const outcome = await runVerified(cfg, model, "实现 UI", { maxReworks: 0 });

    expect(outcome.finalPassed).toBe(true);
    const verifierInput = JSON.stringify(model.requests[1]!.messages);
    expect(verifierInput).toContain("生成了桌面 UI");
    expect(verifierInput).toContain("ui/app.ts");
    expect(verifierInput).toContain("npm test 通过");
  });

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

/**
 * 会话中心化：核查是"每一轮的选项"而不是 run 级封印。续跑轮由 continuation 入口
 * 进来——执行者在正史上续跑，核查者仍是全新上下文、核查的是本轮指令。
 */
describe("runVerified 续跑入口（continuation）", () => {
  class ScriptedClient3 implements ModelClient {
    requests: ModelRequest[] = [];
    constructor(private script: Anthropic.Message[]) {}
    send(req: ModelRequest): Promise<ModelTurn> {
      this.requests.push(structuredClone(req));
      const m = this.script.shift();
      if (!m) throw new Error("script exhausted");
      return Promise.resolve({ message: m, stopReason: m.stop_reason, usage: m.usage });
    }
  }
  const history: Anthropic.MessageParam[] = [
    { role: "user", content: "第一轮：记住暗号 alpha-7" },
    { role: "assistant", content: [textBlock("记住了 alpha-7")] },
  ];

  it("执行者带正史续跑；核查者拿到的任务书是本轮指令 + 原任务背景，不带执行者正史", async () => {
    const model = new ScriptedClient3([
      fakeMessage([textBlock("暗号是 alpha-7，已写入 out.txt")], "end_turn"), // 续跑执行
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "out.txt 一致"}')], "end_turn"), // verifier
    ]);
    const task = continuationVerifyTask("原任务：记住暗号", "把暗号写进 out.txt");
    const outcome = await runVerified({ ...baseConfig, tools: [] }, model, task, {
      continuation: { history, feedback: "把暗号写进 out.txt" },
    });
    expect(outcome.finalPassed).toBe(true);
    expect(outcome.reworks).toBe(0);

    // 执行者：正史 + 本轮反馈（第 3 条 user）——不是从零开始
    const exec = model.requests[0]!.messages;
    expect(exec).toHaveLength(3);
    expect(JSON.stringify(exec[0])).toContain("alpha-7");
    expect(exec[2]!.role).toBe("user");
    expect(JSON.stringify(exec[2]!.content)).toContain("把暗号写进 out.txt");
    // 核查者：全新上下文（单条 user），任务书含本轮指令与原任务；不含执行者正史原文
    const verifierReq = model.requests[1]!.messages;
    expect(verifierReq).toHaveLength(1);
    const text = JSON.stringify(verifierReq[0]);
    expect(text).toContain("把暗号写进 out.txt");
    expect(text).toContain("原任务：记住暗号");
    expect(text).toContain("【本轮指令】");
    expect(text).not.toContain("第一轮：记住暗号 alpha-7");
    // 返回的 main.messages 就是下一轮该接的正史（含本轮全部）
    expect(outcome.main.messages).toHaveLength(4);
  });

  it("续跑轮的返工强制 inherit：即使传 fresh，返工也在正史上继续（变异锁）", async () => {
    const model = new ScriptedClient3([
      fakeMessage([textBlock("写了")], "end_turn"), // 续跑执行
      fakeMessage([textBlock('{"passed": false, "issues": ["out.txt 为空"], "summary": "未通过"}')], "end_turn"), // verifier #1
      fakeMessage([textBlock("补上了")], "end_turn"), // rework
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "已修复"}')], "end_turn"), // verifier #2
    ]);
    const outcome = await runVerified({ ...baseConfig, tools: [] }, model, "任务", {
      reworkMode: "fresh",
      continuation: { history, feedback: "写 out.txt" },
    });
    expect(outcome.finalPassed).toBe(true);
    expect(outcome.reworks).toBe(1);
    const rework = model.requests[2]!.messages;
    // fresh 会只剩 1 条（任务+返工）；inherit 是 正史2 + 本轮 user + assistant + 返工 user = 5
    expect(rework).toHaveLength(5);
    expect(JSON.stringify(rework[0])).toContain("alpha-7");
    expect(JSON.stringify(rework[4]!.content)).toContain("out.txt 为空");
    // 返工段的正史是完整谱系：下一轮续跑就该接它
    expect(outcome.main.messages.length).toBeGreaterThan(rework.length);
  });

  it("verdictFeedbackSummary / continuationVerifyTask：给执行者的裁决摘要与给核查者的任务书", () => {
    const failed = verdictFeedbackSummary(
      { passed: false, summary: "两处不符", issues: ["行数 3≠4", "缺换行"], unverified: ["a"], advisory: ["b", "c"] },
      2,
    );
    expect(failed).toContain("第 2 轮对话");
    expect(failed).toContain("未通过：两处不符");
    expect(failed).toContain("1. 行数 3≠4");
    expect(failed).toContain("2. 缺换行");
    expect(failed).toContain("未能核查 1 项");
    expect(failed).toContain("评审意见 2 条");

    const passed = verdictFeedbackSummary({ passed: true, summary: "一致", issues: [] });
    expect(passed).toContain("通过：一致");
    expect(passed).not.toContain("问题");
    expect(passed).not.toContain("轮对话");

    const task = continuationVerifyTask("原任务", "本轮要求");
    expect(task.indexOf("【本轮指令】本轮要求")).toBeGreaterThanOrEqual(0);
    expect(task.indexOf("【本轮指令】")).toBeLessThan(task.indexOf("原任务"));
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

  it("isReadOnlyCommand：引号内的管道符不是管道（案例 #7:grep 交替被误拒,烧核查轮次）", async () => {
    const { isReadOnlyCommand } = await import("../src/verifier.js");
    // 双引号内的 grep 交替符与字面管道
    expect(isReadOnlyCommand(String.raw`grep -n "foo\|bar" src/x.ts`, PREFIXES)).toBe(true);
    expect(isReadOnlyCommand(`grep -rn "a|b" src/`, PREFIXES)).toBe(true);
    expect(isReadOnlyCommand(`grep -n 'x|y' src/`, PREFIXES)).toBe(true);
    // 引号外的转义管道同样是字面量,不切段
    expect(isReadOnlyCommand(String.raw`grep -n a\|b src/`, PREFIXES)).toBe(true);
    // 但引号外的真管道照旧按段判定
    expect(isReadOnlyCommand(`grep -n "a" src/ | wc -l`, PREFIXES)).toBe(true);
    expect(isReadOnlyCommand(`grep -n "a" src/ | xargs rm`, PREFIXES)).toBe(false);
    // 引号内的危险构造不放行整条命令的越权:引号外仍有链式即拒
    expect(isReadOnlyCommand(`grep -n "a|b" src/ && rm -rf x`, PREFIXES)).toBe(false);
    // 引号未闭合 = 边界不可靠,按可疑拒绝
    expect(isReadOnlyCommand(`grep -n "unclosed src/`, PREFIXES)).toBe(false);
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

describe("verifier 裁决纪律（rule-precedence 延伸到裁决端）", () => {
  it("verifier 提示包含按字面裁决条款（案例 #1：+510 被'实质合理'放行的教训）", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "ok"}')], "end_turn"),
    ]);
    await runVerifier({ ...baseConfig, tools: [] }, model, { task: "t", executorReport: "r" });
    const prompt = JSON.stringify(model.requests[0]!.messages[0]!.content);
    expect(prompt).toContain("裁决按字面");
    expect(prompt).toContain("标准值 vs 实测值");
    expect(prompt).toContain("不由核查者裁定");
  });
});

describe("rubric-verifier（三值裁决协议,案例 #6 催生）", () => {
  it("诚实降级条款默认在提示中：查不了进 unverified,主观进 advisory,passed 只由客观项决定", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "ok"}')], "end_turn"),
    ]);
    await runVerifier({ ...baseConfig, tools: [] }, model, { task: "t", executorReport: "r" });
    const prompt = JSON.stringify(model.requests[0]!.messages[0]!.content);
    expect(prompt).toContain("诚实降级");
    expect(prompt).toContain("unverified");
    expect(prompt).toContain("advisory");
    expect(prompt).toContain("实际核查过的客观项");
  });

  it("传入 rubric 时评分表注入提示,并声明意见不影响 passed", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "ok"}')], "end_turn"),
    ]);
    await runVerifier({ ...baseConfig, tools: [] }, model, {
      task: "t",
      executorReport: "r",
      rubric: "维度A:清晰度——读者能否不看原始报告获得结论",
    });
    const prompt = JSON.stringify(model.requests[0]!.messages[0]!.content);
    expect(prompt).toContain("主观评分表");
    expect(prompt).toContain("维度A:清晰度");
    expect(prompt).toContain("主观裁决权在委托方");
  });

  it("runVerified：advisory/unverified 不触发返工——passed=true 即通过,扩展字段保留", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock("完成")], "end_turn"), // main
      fakeMessage(
        [
          textBlock(
            '{"passed": true, "issues": [], "unverified": ["行数待复核"], "advisory": ["提炼度 | 良 | 判法自陈"], "summary": "客观项全过"}',
          ),
        ],
        "end_turn",
      ), // verifier——若误触返工,脚本会因消息耗尽而失败
    ]);
    const outcome = await runVerified(
      { systemPrompt: "sys", tools: [], workdir: process.cwd() },
      model,
      "任务",
      { verifyRubric: "维度A:提炼度" },
    );
    expect(outcome.finalPassed).toBe(true);
    expect(outcome.reworks).toBe(0);
    const v = outcome.verifications[0]!.verdict;
    expect(v.unverified).toEqual(["行数待复核"]);
    expect(v.advisory).toEqual(["提炼度 | 良 | 判法自陈"]);
  });
});

// ================================================================
// 核查预算按领域可覆盖（案例 #8 产出的 backlog 9.1）
// ================================================================

describe("核查轮次预算", () => {
  /** 永远只调工具、从不收口的模型——用来数 verifier 到底被允许跑几轮 */
  class NeverConcludes implements ModelClient {
    calls = 0;
    send(_req: ModelRequest): Promise<ModelTurn> {
      this.calls += 1;
      const m = fakeMessage([toolUseBlock(`tu_${this.calls}`, "probe", {})], "tool_use");
      return Promise.resolve({ message: m, stopReason: m.stop_reason, usage: m.usage });
    }
  }

  const probeCfg = { ...baseConfig, tools: [makeTool({ name: "probe" })] };

  it("缺省 15 轮（与执行者解耦，不随其 maxTurns 缩水）", async () => {
    const model = new NeverConcludes();
    // 执行者被压到 2 轮也不该影响核查预算——REPS=5 复现批的教训
    await runVerifier({ ...probeCfg, maxTurns: 2 }, model, { task: "t", executorReport: "r" });
    // 调查预算 + 收口续跑（9.7）：撞满预算后还会续跑一小段专门写裁决
    expect(model.calls).toBe(DEFAULT_VERIFIER_MAX_TURNS + VERIFIER_WRAPUP_MAX_TURNS);
  });

  it("opts.maxTurns 覆盖缺省——真机域每条验收要多次探针往返，15 装不下（案例 #8）", async () => {
    const model = new NeverConcludes();
    await runVerifier(probeCfg, model, { task: "t", executorReport: "r", maxTurns: 30 });
    expect(model.calls).toBe(30 + VERIFIER_WRAPUP_MAX_TURNS);
  });

  it("stm32-debug 包声明了更大的核查预算，且不高于它自己的执行者护栏", () => {
    const debugPack = PACKS["stm32-debug"]!;
    expect(debugPack.verify.maxTurns).toBe(30);
    // 核查者不该比执行者还能跑——那说明护栏的相对关系没想清楚
    expect(debugPack.verify.maxTurns!).toBeLessThanOrEqual(debugPack.guardrails!.maxTurns!);
    // 且必须真的比缺省大，否则这条声明没有意义
    expect(debugPack.verify.maxTurns!).toBeGreaterThan(DEFAULT_VERIFIER_MAX_TURNS);
  });

  it("软件域的包不声明预算 → 仍走缺省（不是所有域都需要加码）", () => {
    expect(PACKS["ts-coding"]!.verify.maxTurns).toBeUndefined();
    expect(PACKS["python-coding"]!.verify.maxTurns).toBeUndefined();
  });

  it("runVerified 把 verifyMaxTurns 穿到 verifier（不只是字段传下去，是真的多跑了）", async () => {
    /**
     * 行为断言而非字段断言：让 verifier 直到第 24 轮才收口。
     * 缺省 15 轮下它来不及写裁决 → 落 fail-closed；给到 30 轮就能通过。
     * 这正是案例 #8 的形态——核查不是错了，是没来得及收口。
     *
     * 收口点要放到**重问也够不着**的地方：初稿设在第 18 轮，结果被重问机制
     * （maxTurns 3）恰好救回，tight 臂反而通过了。那是重问在按设计工作，
     * 不是预算够用——所以收口点必须 > 15 + 3。
     */
    function scriptedVerifier(concludeAtCall: number): ModelClient {
      let n = 0;
      return {
        send(): Promise<ModelTurn> {
          n += 1;
          const m =
            n === 1
              ? fakeMessage([textBlock("执行完毕")], "end_turn") // 执行者那一轮
              : n < concludeAtCall
                ? fakeMessage([toolUseBlock(`tu_${n}`, "probe", {})], "tool_use")
                : fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "查完了"}')], "end_turn");
          return Promise.resolve({ message: m, stopReason: m.stop_reason, usage: m.usage });
        },
      };
    }

    const CONCLUDE_AT = 25; // > 1(执行者) + 15(缺省核查) + 3(重问)
    // 关掉返工：脚本模型是全局计数器，返工后已越过收口点，第二轮核查会立刻
    // 通过——那验的是返工在起作用，不是预算够用。这里只比第一轮裁决。
    const noRework = { maxReworks: 0 };

    const tight = await runVerified(probeCfg, scriptedVerifier(CONCLUDE_AT), "任务", noRework);
    expect(tight.finalPassed, "缺省 15 轮应当来不及收口").toBe(false);
    // 撞满预算时最终消息是半截工具调用、文本为空 → 不触发重问（无可转写内容），
    // 直接落解析失败那条 fail-closed。案例 #8 走的是另一条（verifier 产出过文本，
    // 重问后仍无结论 → "核查未产出明确结论"）——两条都是没来得及收口的表型。
    expect(tight.verifications[0]!.verdict.issues).toEqual([VERDICT_PARSE_FAIL]);

    const roomy = await runVerified(probeCfg, scriptedVerifier(CONCLUDE_AT), "任务", {
      ...noRework,
      verifyMaxTurns: 30,
    });
    expect(roomy.finalPassed, "给到 30 轮就该拿到实质裁决").toBe(true);
    expect(roomy.verifications[0]!.verdict.summary).toBe("查完了");
  });
});

// ================================================================
// 9.7 预算用尽的收口续跑 + 9.2 fail-closed 裁决带过程摘要
// ================================================================

describe("预算用尽后的收口（案例 #8 的 9.7 / 9.2）", () => {
  const probeCfg = {
    ...baseConfig,
    tools: [makeTool({ name: "probe" })],
    maxTurns: 50,
  };

  /**
   * 前 N 次只调工具（撞满预算），之后按脚本回答。
   * 用它模拟"核查做了大量取证但没来得及写裁决"——案例 #8 的真实形态。
   */
  function busyThenScripted(toolTurns: number, then: Anthropic.Message[]): ModelClient {
    let n = 0;
    const rest = [...then];
    return {
      requests: [] as ModelRequest[],
      send(req: ModelRequest): Promise<ModelTurn> {
        (this as any).requests.push(structuredClone(req));
        n += 1;
        const m =
          n <= toolTurns
            ? fakeMessage([toolUseBlock(`tu_${n}`, "probe", {})], "tool_use")
            : rest.shift() ?? fakeMessage([textBlock("（脚本耗尽）")], "end_turn");
        return Promise.resolve({ message: m, stopReason: m.stop_reason, usage: m.usage });
      },
    } as unknown as ModelClient;
  }

  it("撞满预算 → 续跑同一会话收口，拿到实质裁决（此前整场核查作废）", async () => {
    const model = busyThenScripted(5, [
      fakeMessage(
        [textBlock('{"passed": true, "issues": [], "unverified": ["AC3 预算用尽未及核查"], "summary": "已查项全过"}')],
        "end_turn",
      ),
    ]);
    const outcome = await runVerifier({ ...probeCfg }, model, {
      task: "t",
      executorReport: "r",
      maxTurns: 5, // 5 轮全用在工具上 → 撞满
    });

    expect(outcome.verdict.passed, "收口续跑应当拿到实质裁决").toBe(true);
    expect(outcome.verdict.summary).toBe("已查项全过");
    // 没查完的进 unverified 而不是 failed——否则就是把"没查"当成"没做对"
    expect(outcome.verdict.unverified).toEqual(["AC3 预算用尽未及核查"]);
  });

  it("收口续跑带着原会话正史——那些工具返回还在上下文里（不是另起炉灶）", async () => {
    const model = busyThenScripted(3, [
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "ok"}')], "end_turn"),
    ]);
    await runVerifier({ ...probeCfg }, model, { task: "t", executorReport: "r", maxTurns: 3 });

    const reqs = (model as unknown as { requests: ModelRequest[] }).requests;
    const wrapUp = reqs.at(-1)!;
    const flat = JSON.stringify(wrapUp.messages);
    // 正史带上了：原提示与三次工具往返都在
    expect(flat).toContain("独立验证员");
    expect(flat).toContain("tu_1");
    expect(flat).toContain("tu_3");
    /**
     * 收口段不许继续取证——**判据不变，承载物换了**（C2 的迁移纪律）。
     * B0b 的承载物是 `toolChoice:"none"`（只说得出"别调工具"）；
     * §2.1 换成强制终结工具，它把两件事一起给：唯一可调的就是交付工具，
     * 且必须交付。是收紧不是放宽——旧断言在新承载物下逐条对得上。
     */
    expect(reqs[0]!.toolChoice, "调查轮不设约束：那时就该自由取证").toBeUndefined();
    expect(wrapUp.toolChoice).toEqual({ type: "tool", name: VERDICT_TOOL_NAME });
    // 且收口提示明确禁止继续取证、点名交付口
    expect(flat).toContain("不要再取证");
    expect(flat).toContain(VERDICT_TOOL_NAME);
    expect(flat).toContain("不得因为没查完就判 failed");
  });

  it("收口也失败时，fail-closed 裁决带过程摘要（返工者要知道上一轮走到哪）", async () => {
    // 永不收口：连续调工具，续跑那两轮也一样
    const model = busyThenScripted(999, []);
    const outcome = await runVerifier({ ...probeCfg }, model, {
      task: "t",
      executorReport: "r",
      maxTurns: 6,
    });

    expect(outcome.verdict.passed).toBe(false);
    // 哨兵原文不动——isParseFailure 与界面的核查饥饿判定都靠它
    expect(outcome.verdict.issues).toEqual([VERDICT_PARSE_FAIL]);
    // 但 summary 不再是"(空输出)"这种零信息量的东西
    const s = outcome.verdict.summary;
    expect(s).toContain("跑满 6 轮预算仍未收口");
    expect(s).toContain("次工具调用");
    expect(s).toContain("probe×");
    expect(s).toContain("这不等于产物有问题");
    expect(s).not.toBe("(空输出)");
  });

  it("零工具调用的失败与「查了很多没收口」要能分辨——那是两种完全不同的故障", async () => {
    const model = new FakeModelClient([fakeMessage([textBlock("")], "end_turn")]);
    const outcome = await runVerifier({ ...baseConfig, tools: [] }, model, {
      task: "t",
      executorReport: "r",
    });
    expect(outcome.verdict.summary).toContain("全程零工具调用");
    expect(outcome.verdict.summary).toContain("核查很可能根本没有开展");
  });

  it("正常收口的裁决不被过程摘要污染", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "产出正确"}')], "end_turn"),
    ]);
    const outcome = await runVerifier({ ...baseConfig, tools: [] }, model, { task: "t", executorReport: "r" });
    expect(outcome.verdict.summary).toBe("产出正确");
  });
});

// ================================================================
// 9.8 段级瞬时失败的续跑
// ================================================================

describe("段级续跑（案例 #8 的 9.8）", () => {
  const cfg = { ...baseConfig, tools: [makeTool({ name: "probe" })] };

  /** 前 k 次正常干活，第 k+1 次抛指定错误，之后按脚本继续 */
  function failsOnceThen(k: number, err: unknown, then: Anthropic.Message[]): ModelClient {
    let n = 0;
    const rest = [...then];
    return {
      requests: [] as ModelRequest[],
      send(req: ModelRequest): Promise<ModelTurn> {
        (this as any).requests.push(structuredClone(req));
        n += 1;
        if (n <= k) {
          const m = fakeMessage([toolUseBlock(`tu_${n}`, "probe", {})], "tool_use");
          return Promise.resolve({ message: m, stopReason: m.stop_reason, usage: m.usage });
        }
        if (n === k + 1) return Promise.reject(err);
        const m = rest.shift() ?? fakeMessage([textBlock("（脚本耗尽）")], "end_turn");
        return Promise.resolve({ message: m, stopReason: m.stop_reason, usage: m.usage });
      },
    } as unknown as ModelClient;
  }

  const timeout = () => Object.assign(new Error("upstream timeout"), { status: 408 });

  it("瞬时失败 → 带正史续跑，之前的工具往返不作废", async () => {
    const model = failsOnceThen(2, timeout(), [
      fakeMessage([textBlock("接着做完了")], "end_turn"),
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "ok"}')], "end_turn"),
    ]);
    const seen: string[] = [];
    const outcome = await runVerified({ ...cfg, errorRetries: 0 }, model, "任务", {
      onEvent: (src, e) => {
        if (e.type === "segment_resume") seen.push(`${src}:${e.type}:${e.priorTurns}`);
      },
    });

    // 续跑事件显式发出（否则宿主看到 done(error) 后又冒事件，读不懂）
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^main:segment_resume:\d+$/);
    // 整段没有作废：核查照常跑到并通过
    expect(outcome.finalPassed).toBe(true);
    expect(outcome.main.stopReason).toBe("completed");

    // 续跑请求带着正史：之前那两次工具往返都在
    const reqs = (model as unknown as { requests: ModelRequest[] }).requests;
    const resumeReq = reqs.find((r) => JSON.stringify(r.messages).includes("【接续】"))!;
    expect(resumeReq, "未发出带正史的续跑请求").toBeDefined();
    const flat = JSON.stringify(resumeReq.messages);
    expect(flat).toContain("tu_1");
    expect(flat).toContain("tu_2");
    expect(flat).toContain("不要从头重来");
  });

  it("永久性错误（401）不续跑——续跑只是重复失败", async () => {
    const model = failsOnceThen(1, Object.assign(new Error("bad key"), { status: 401 }), []);
    const seen: string[] = [];
    const outcome = await runVerified({ ...cfg, errorRetries: 0 }, model, "任务", {
      onEvent: (_s, e) => {
        if (e.type === "segment_resume") seen.push(e.type);
      },
    });
    expect(seen).toHaveLength(0);
    expect(outcome.main.stopReason).toBe("error");
    expect(outcome.finalPassed).toBe(false);
    expect(outcome.verifications).toHaveLength(0); // 宿主级失败照旧短路核查
  });

  it("transientResumes=0 关闭续跑（eval 统计失败率时要的是原始形态）", async () => {
    const model = failsOnceThen(1, timeout(), []);
    const outcome = await runVerified({ ...cfg, errorRetries: 0 }, model, "任务", {
      transientResumes: 0,
    });
    expect(outcome.main.stopReason).toBe("error");
    expect(outcome.finalPassed).toBe(false);
  });

  it("续跑次数有上限——不会对持续故障无限重开", async () => {
    // 每次调用都超时：首轮 error，续跑 1 次仍 error，然后停手
    let calls = 0;
    const model: ModelClient = {
      send() {
        calls += 1;
        return Promise.reject(timeout());
      },
    };
    const outcome = await runVerified({ ...cfg, errorRetries: 0 }, model, "任务", {});
    expect(outcome.main.stopReason).toBe("error");
    // 首轮 1 次 + 续跑 1 次 = 2；没有正史时不该续跑，这里首轮 messages 非空（含 user）
    expect(calls).toBeLessThanOrEqual(2);
  });
});

// ================================================================
// 裁决获得路径计数（§2.1 前置：先量再定）
// ================================================================

describe("裁决获得路径（recovery）", () => {
  const probeCfg = { ...baseConfig, tools: [makeTool({ name: "probe" })], maxTurns: 50 };

  it("direct：首轮就是可解析裁决", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "ok"}')], "end_turn"),
    ]);
    const o = await runVerifier({ ...baseConfig, tools: [] }, model, { task: "t", executorReport: "r" });
    expect(o.recovery).toBe("direct");
  });

  it("reformat：产出散文 → 重问转写救回", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock("核查完毕：数值正确，没问题。")], "end_turn"),
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "正确"}')], "end_turn"),
    ]);
    const o = await runVerifier({ ...baseConfig, tools: [] }, model, { task: "t", executorReport: "r" });
    expect(o.recovery).toBe("reformat");
    expect(o.verdict.passed).toBe(true);
  });

  it("wrapup：撞满预算 → 收口续跑救回", async () => {
    let n = 0;
    const model: ModelClient = {
      send() {
        n += 1;
        const m =
          n <= 4
            ? fakeMessage([toolUseBlock(`tu_${n}`, "probe", {})], "tool_use")
            : fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "查完了"}')], "end_turn");
        return Promise.resolve({ message: m, stopReason: m.stop_reason, usage: m.usage });
      },
    };
    const o = await runVerifier(probeCfg, model, { task: "t", executorReport: "r", maxTurns: 4 });
    expect(o.recovery).toBe("wrapup");
    expect(o.verdict.summary).toBe("查完了");
  });

  it("failed：兜底都没救回", async () => {
    const model: ModelClient = {
      send() {
        const m = fakeMessage([toolUseBlock("tu_x", "probe", {})], "tool_use");
        return Promise.resolve({ message: m, stopReason: m.stop_reason, usage: m.usage });
      },
    };
    const o = await runVerifier(probeCfg, model, { task: "t", executorReport: "r", maxTurns: 3 });
    expect(o.recovery).toBe("failed");
    expect(o.verdict.passed).toBe(false);
  });

  it("runVerified 把 recovery 带进每轮 VerifyOutcome（宿主要靠它统计）", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock("完成了")], "end_turn"),
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "ok"}')], "end_turn"),
    ]);
    const outcome = await runVerified({ ...baseConfig, tools: [] }, model, "任务");
    expect(outcome.verifications[0]!.recovery).toBe("direct");
  });
});

describe("§2.1 结构化交付：裁决走终结工具", () => {
  const probeCfg = { ...baseConfig, tools: [makeTool({ name: "probe" })], maxTurns: 50 };

  /**
   * 判据（台账 52 次裁决，2026-08-15）：direct 28.8% / wrapup 69.2% / reformat 1.9%。
   * backlog 原案 `response_format` 治的是 reformat 那 1.9%；这一组锁的是那 69.2%——
   * "停止取证、开始下结论"这个转换在自由文本契约下没有着力点，工具给了它一个。
   */
  it("首轮调用 submit_verdict → recovery=tool，裁决从入参直接取", async () => {
    const model = new FakeModelClient([
      fakeMessage(
        [
          toolUseBlock("tu_1", VERDICT_TOOL_NAME, {
            passed: true,
            issues: [],
            unverified: ["AC3 缺手段"],
            summary: "客观项全过",
          }),
        ],
        "tool_use",
      ),
    ]);
    const outcome = await runVerifier({ ...probeCfg }, model, { task: "t", executorReport: "r" });
    expect(outcome.recovery).toBe("tool");
    expect(outcome.verdict.passed).toBe(true);
    expect(outcome.verdict.summary).toBe("客观项全过");
    expect(outcome.verdict.unverified).toEqual(["AC3 缺手段"]);
  });

  it("终结工具在工具面上——不在面上，tool_choice 点名它就是 400", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_1", VERDICT_TOOL_NAME, { passed: true, summary: "s" })], "tool_use"),
    ]);
    await runVerifier({ ...probeCfg }, model, { task: "t", executorReport: "r" });
    const names = model.requests[0]!.tools.map((t) => t.name);
    expect(names).toContain(VERDICT_TOOL_NAME);
  });

  it("入参形状不合法 → **降级**回文本解析，不是拒绝（裁决侧的缺字段语义是降级）", async () => {
    const model = new FakeModelClient([
      // passed 不是布尔：端点没按 schema 兜住的情形
      fakeMessage(
        [
          textBlock('{"passed": false, "issues": ["真问题"], "summary": "文本兜住了"}'),
          toolUseBlock("tu_1", VERDICT_TOOL_NAME, { passed: "yes", summary: "坏形状" }),
        ],
        "tool_use",
      ),
    ]);
    const outcome = await runVerifier({ ...probeCfg }, model, { task: "t", executorReport: "r" });
    expect(outcome.recovery, "没走成工具就不该记 tool").not.toBe("tool");
    expect(outcome.verdict.issues).toEqual(["真问题"]);
  });

  it("端点完全不认强制工具时，旧的文本契约仍然收得住（降级臂）", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "纯文本裁决"}')], "end_turn"),
    ]);
    const outcome = await runVerifier({ ...probeCfg }, model, { task: "t", executorReport: "r" });
    expect(outcome.recovery).toBe("direct");
    expect(outcome.verdict.passed).toBe(true);
  });

  it("verdictFromToolInput：passed 必须是布尔，空的 unverified/advisory 不落字段", () => {
    expect(verdictFromToolInput({ passed: "true", summary: "s" })).toBeUndefined();
    expect(verdictFromToolInput(null)).toBeUndefined();
    expect(verdictFromToolInput("{}")).toBeUndefined();
    const v = verdictFromToolInput({ passed: true, summary: "s", unverified: [], advisory: [] })!;
    expect(v).toEqual({ passed: true, issues: [], summary: "s" });
    expect("unverified" in v, "空数组不落字段——与 parseVerdict 逐字同判").toBe(false);
  });

  it("工具的 execute 是公开面：合法入参回确认，非法入参回可操作报错而不是抛", async () => {
    const tool = createVerdictTool();
    const ok = await tool.execute({ passed: true, summary: "s" }, {} as never);
    expect(ok.isError).toBeUndefined();
    const bad = await tool.execute({ summary: "缺 passed" }, {} as never);
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("passed");
  });
});

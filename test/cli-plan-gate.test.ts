import { describe, expect, it } from "vitest";
import {
  applyCliPlanTitleEdits,
  CLI_PLAN_GATE_EDIT_ID_PROMPT,
  CLI_PLAN_GATE_EDIT_TITLE_PROMPT,
  CLI_PLAN_GATE_RUN_PROMPT,
  CliPlanRejectedError,
  cliPlanGateNeedYesExit,
  cliPlanGateNeedYesMessage,
  confirmCliPlan,
  formatCliPlanShortTable,
  parseCliPlanGateYesNo,
  resolveCliPlanGateMode,
} from "../src/cli-plan-gate.js";
import { CLI_NEEDS_CONFIRM_EXIT, cliHelpText, formatCliNeedsConfirmMessage } from "../src/cli-args.js";
import { cliRuntimePermissionSwitches, matchPermissionMode } from "../src/permission-mode.js";
import { runPlanned } from "../src/orchestrate.js";
import type { Plan } from "../src/planner.js";
import { fakeMessage, textBlock } from "./helpers.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient, ModelRequest, ModelTurn } from "../src/types.js";

function samplePlan(): Plan {
  return {
    subtasks: [
      {
        id: "s1",
        title: "第一步",
        pack: "ts-coding",
        description: "做 A",
        acceptance: ["A 完成"],
        dependsOn: [],
      },
      {
        id: "s2",
        title: "第二步",
        description: "做 B",
        acceptance: ["B 完成"],
        dependsOn: ["s1"],
      },
    ],
  };
}

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
  '{"id": "s1", "title": "改固件", "pack": "stm32-coding", "description": "修改 main.c", "acceptance": ["ELF 存在"]},' +
  '{"id": "s2", "title": "烧录验证", "pack": "stm32-debug", "description": "烧录", "acceptance": ["heartbeat 递增"]}' +
  "]}";

function passVerdict(): Anthropic.Message {
  return fakeMessage(
    [textBlock('{"passed":true,"issues":[],"summary":"ok"}')],
    "end_turn",
  );
}

describe("CLI 计划确认门", () => {
  it("短表只含 id / 标题 / 包 / 依赖", () => {
    const table = formatCliPlanShortTable(samplePlan());
    expect(table).toContain("s1  第一步  [ts-coding]");
    expect(table).toContain("s2  第二步  ⇐ s1");
    expect(table).not.toContain("做 A");
    expect(table).not.toContain("A 完成");
  });

  it("TTY 批准：y 之后可跳过改标题", async () => {
    const prompts: string[] = [];
    const answers = ["y", ""];
    const decision = await confirmCliPlan({
      plan: samplePlan(),
      autoYes: false,
      canPrompt: true,
      question: async (prompt) => {
        prompts.push(prompt);
        return answers.shift() ?? "";
      },
    });
    expect(decision).toEqual({ kind: "approve", edits: [] });
    expect(prompts[0]).toBe(CLI_PLAN_GATE_RUN_PROMPT);
    expect(prompts[1]).toBe(CLI_PLAN_GATE_EDIT_ID_PROMPT);
    expect(prompts).toHaveLength(2);
  });

  it("TTY 否决：n 或空回车都不开跑", async () => {
    for (const raw of ["n", "N", "", "no", "maybe"]) {
      const decision = await confirmCliPlan({
        plan: samplePlan(),
        autoYes: false,
        canPrompt: true,
        question: async () => raw,
      });
      expect(decision, raw).toEqual({ kind: "reject" });
    }
    expect(parseCliPlanGateYesNo("yes")).toBe("yes");
    expect(parseCliPlanGateYesNo("Y")).toBe("yes");
  });

  it("TTY 批准后改一行标题：写回活计划，不改 pack / 验收", async () => {
    const plan = samplePlan();
    const answers = ["y", "s1", "先读 CRC"];
    const decision = await confirmCliPlan({
      plan,
      autoYes: false,
      canPrompt: true,
      question: async (prompt) => {
        if (prompt === CLI_PLAN_GATE_EDIT_TITLE_PROMPT) return answers.shift()!;
        return answers.shift()!;
      },
    });
    expect(decision.kind).toBe("approve");
    if (decision.kind !== "approve") return;
    expect(decision.edits).toEqual([{ id: "s1", title: "先读 CRC" }]);
    applyCliPlanTitleEdits(plan, decision.edits);
    expect(plan.subtasks[0]).toMatchObject({
      title: "先读 CRC",
      description: "做 A",
      pack: "ts-coding",
      acceptance: ["A 完成"],
    });
    expect(plan.subtasks[1]?.title).toBe("第二步");
  });

  it("非 TTY 无 --yes：need_yes，绝不调用 question（不摔 readline）", async () => {
    let asked = 0;
    const decision = await confirmCliPlan({
      plan: samplePlan(),
      autoYes: false,
      canPrompt: false,
      question: async () => {
        asked += 1;
        throw Object.assign(new Error("readline was closed"), { code: "ERR_USE_AFTER_CLOSE" });
      },
    });
    expect(decision).toEqual({ kind: "need_yes" });
    expect(asked).toBe(0);
    expect(resolveCliPlanGateMode({ autoYes: false, canPrompt: false })).toBe("need_yes");
    expect(cliPlanGateNeedYesMessage()).toBe(formatCliNeedsConfirmMessage());
    expect(cliPlanGateNeedYesExit()).toBe(CLI_NEEDS_CONFIRM_EXIT);
    expect(cliPlanGateNeedYesMessage()).toBe("需要确认，请加 --yes");
  });

  it("非 TTY + --yes：自动开跑，不提问", async () => {
    let asked = 0;
    const decision = await confirmCliPlan({
      plan: samplePlan(),
      autoYes: true,
      canPrompt: false,
      question: async () => {
        asked += 1;
        return "n";
      },
    });
    expect(decision).toEqual({ kind: "approve", edits: [] });
    expect(asked).toBe(0);
    expect(resolveCliPlanGateMode({ autoYes: true, canPrompt: false })).toBe("auto");
  });

  it("TTY 但 readline 已关：当 need_yes，不把栈抛出去", async () => {
    const decision = await confirmCliPlan({
      plan: samplePlan(),
      autoYes: false,
      canPrompt: true,
      question: async () => {
        throw Object.assign(new Error("readline was closed"), { code: "ERR_USE_AFTER_CLOSE" });
      },
    });
    expect(decision).toEqual({ kind: "need_yes" });
  });

  it("TTY 批准后 onPlan 返回，子任务会跑", async () => {
    const order: string[] = [];
    const model = new ScriptedClient([
      fakeMessage([textBlock(PLAN_JSON)], "end_turn"),
      fakeMessage([textBlock("done1")], "end_turn"),
      passVerdict(),
      fakeMessage([textBlock("done2")], "end_turn"),
      passVerdict(),
    ]);
    const outcome = await runPlanned(
      { systemPrompt: "x", workdir: process.cwd(), tools: [] },
      model,
      "任务",
      {
        onPlan: async (plan) => {
          const answers = ["y", ""];
          const d = await confirmCliPlan({
            plan,
            autoYes: false,
            canPrompt: true,
            question: async () => {
              order.push("ask");
              return answers.shift() ?? "";
            },
          });
          expect(d.kind).toBe("approve");
          order.push(`plan:${plan.subtasks.length}`);
        },
        onEvent: (source, event) => {
          if (event.type === "turn_start" && source.endsWith("/main")) order.push(source);
        },
      },
    );
    expect(order[0]).toBe("ask");
    expect(order).toContain("plan:2");
    expect(order).toContain("s1/main");
    expect(outcome.steps.length).toBe(2);
  });

  it("TTY 否决：onPlan 抛 CliPlanRejectedError，零子任务", async () => {
    const started: string[] = [];
    const model = new ScriptedClient([
      fakeMessage([textBlock(PLAN_JSON)], "end_turn"),
      fakeMessage([textBlock("should-not-run")], "end_turn"),
    ]);
    await expect(
      runPlanned(
        { systemPrompt: "x", workdir: process.cwd(), tools: [] },
        model,
        "任务",
        {
          onPlan: async (plan) => {
            const d = await confirmCliPlan({
              plan,
              autoYes: false,
              canPrompt: true,
              question: async () => "n",
            });
            if (d.kind === "reject") throw new CliPlanRejectedError();
          },
          onEvent: (source, event) => {
            if (event.type === "turn_start" && source.endsWith("/main")) started.push(source);
          },
        },
      ),
    ).rejects.toBeInstanceOf(CliPlanRejectedError);
    expect(started).toEqual([]);
    expect(model.requests.length).toBe(1);
  });
});

describe("CLI --plan 帮助与档位跟门一致", () => {
  it("--help 写清 TTY 确认、非 TTY 须 --yes、退出码 2", () => {
    const help = cliHelpText();
    expect(help).toMatch(/TTY.*开跑|问是否开跑|y\/n/i);
    expect(help).toMatch(/非 TTY.*--yes/);
    expect(help).toMatch(/退出码 2|退出码 2/);
    expect(help).not.toMatch(/没有计划确认门/);
    expect(help).not.toMatch(/不会停下来给你改/);
    expect(help).not.toMatch(/拆完计划后立刻执行并核查/);
  });

  it("--plan 且无 --yes 对得上 plan 档（gate=true）", () => {
    const sw = cliRuntimePermissionSwitches({ autoYes: false, planMode: true });
    expect(sw.planGate).toBe(true);
    expect(sw.planMode).toBe(true);
    expect(matchPermissionMode(sw)).toBe("plan");
  });
});

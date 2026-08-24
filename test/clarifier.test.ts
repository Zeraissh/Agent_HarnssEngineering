import { describe, expect, it } from "vitest";
import {
  REQUIREMENTS_TOOL_NAME,
  runClarificationGate,
} from "../src/clarifier.js";
import { runPlanned } from "../src/orchestrate.js";
import { PLAN_TOOL_NAME } from "../src/planner.js";
import { createAskUserTool } from "../src/tools/ask-user.js";
import { VERDICT_TOOL_NAME } from "../src/verifier.js";
import type { ModelClient, ModelRequest } from "../src/types.js";
import { FakeModelClient, fakeMessage, textBlock, toolUseBlock } from "./helpers.js";

const baseConfig = {
  systemPrompt: "executor",
  workdir: process.cwd(),
  tools: [],
};

describe("planner 前结构化需求澄清门", () => {
  it("没有 ask_user 能力时零调用跳过，不给无人值守任务增加隐藏等待", async () => {
    const model = new FakeModelClient([]);
    const outcome = await runClarificationGate(baseConfig, model, "原任务");
    expect(outcome.task).toBe("原任务");
    expect(outcome.skipped).toBe(true);
    expect(model.requests).toHaveLength(0);
  });

  it("先集中提问，再用 submit_requirements 产出 planner 唯一可见的精炼任务", async () => {
    const seen: string[][] = [];
    const ask = createAskUserTool({
      ask: async ({ questions }) => {
        seen.push(questions.map((q) => q.question));
        return ["Tauri", "可运行 MVP"];
      },
    });
    const model = new FakeModelClient([
      fakeMessage(
        [
          toolUseBlock("ask", "ask_user", {
            questions: [
              {
                question: "桌面框架选哪个？",
                options: ["Tauri", "Electron"],
                fallback: "Tauri",
              },
              {
                question: "本轮做到什么程度？",
                options: ["可运行 MVP", "完整发布版"],
                fallback: "可运行 MVP",
              },
            ],
          }),
        ],
        "tool_use",
      ),
      fakeMessage(
        [
          toolUseBlock("requirements", REQUIREMENTS_TOOL_NAME, {
            task: "使用 Tauri 实现可运行的 Desktop UI MVP",
            acceptance: ["能够启动", "包含主任务列表"],
            assumptions: ["沿用现有视觉风格"],
          }),
        ],
        "tool_use",
      ),
    ]);

    const events: string[] = [];
    const outcome = await runClarificationGate(
      { ...baseConfig, tools: [ask] },
      model,
      "给项目开发一版 Desktop UI",
      (event) => {
        events.push(event.type);
      },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(2);
    expect(outcome.skipped).toBe(false);
    expect(outcome.task).toContain("Tauri");
    expect(outcome.acceptance).toEqual(["能够启动", "包含主任务列表"]);
    expect(events).toContain("tool_call");
    expect(model.requests[0]!.tools.map((t) => t.name).sort()).toEqual([
      "ask_user",
      REQUIREMENTS_TOOL_NAME,
    ].sort());
  });

  it("runPlanned 必须等澄清门完成，planner 收到精炼任务而不是原始歧义句", async () => {
    const ask = createAskUserTool({
      ask: async () => ["Tauri"],
    });
    const model = new FakeModelClient([
      fakeMessage(
        [
          toolUseBlock("ask", "ask_user", {
            questions: [
              {
                question: "框架？",
                options: ["Tauri", "Electron"],
                fallback: "Tauri",
              },
            ],
          }),
        ],
        "tool_use",
      ),
      fakeMessage(
        [
          toolUseBlock("requirements", REQUIREMENTS_TOOL_NAME, {
            task: "使用 Tauri 开发 Desktop UI",
            acceptance: ["npm test 通过"],
            assumptions: [],
          }),
        ],
        "tool_use",
      ),
      fakeMessage(
        [
          toolUseBlock("plan", PLAN_TOOL_NAME, {
            subtasks: [
              {
                id: "s1",
                title: "实现 UI",
                description: "使用 Tauri 开发 Desktop UI",
                acceptance: ["npm test 通过"],
                dependsOn: [],
              },
            ],
          }),
        ],
        "tool_use",
      ),
      fakeMessage([textBlock("实现完成")], "end_turn"),
      fakeMessage(
        [
          toolUseBlock("verdict", VERDICT_TOOL_NAME, {
            passed: true,
            issues: [],
            unverified: [],
            advisory: [],
            summary: "通过",
          }),
        ],
        "tool_use",
      ),
    ]);
    const sources: string[] = [];
    const outcome = await runPlanned(
      { ...baseConfig, tools: [ask] },
      model,
      "给项目开发一版 Desktop UI",
      {
        onEvent: (source, event) => {
          if (event.type === "turn_start") sources.push(source);
        },
      },
    );

    expect(outcome.completed).toBe(true);
    expect(outcome.clarification?.task).toContain("Tauri");
    expect(sources[0]).toBe("clarifier");
    expect(sources).toContain("planner");
    expect(JSON.stringify(model.requests[2]!.messages)).toContain("使用 Tauri 开发 Desktop UI");
    expect(model.requests[2]!.tools.some((t) => t.name === "ask_user")).toBe(false);
  });

  it("计划内所有并行子任务共享 maxTotalTurns，不得按子任务复制总额度", async () => {
    const requests: ModelRequest[] = [];
    const model: ModelClient = {
      async send(req) {
        requests.push(req);
        const message = req.tools.some((tool) => tool.name === VERDICT_TOOL_NAME)
          ? fakeMessage([toolUseBlock("verdict", VERDICT_TOOL_NAME, {
              passed: true, issues: [], unverified: [], advisory: [], summary: "通过",
            })], "tool_use")
          : fakeMessage([textBlock("执行完成")], "end_turn");
        return { message, stopReason: message.stop_reason, usage: message.usage };
      },
    };
    const outcome = await runPlanned(
      { ...baseConfig, tools: [], maxTotalTurns: 1 },
      model,
      "两个并行任务",
      {
        plan: {
          subtasks: [
            { id: "s1", title: "A", description: "A", acceptance: [], dependsOn: [] },
            { id: "s2", title: "B", description: "B", acceptance: [], dependsOn: [] },
          ],
        },
        concurrency: 2,
        maxReworks: 0,
      },
    );

    const executionRequests = requests.filter(
      (req) => !req.tools.some((tool) => tool.name === VERDICT_TOOL_NAME),
    );
    expect(executionRequests).toHaveLength(1);
    expect(outcome.steps.map((step) => step.result.main.stopReason)).toContain("budget_exhausted");
  });
});

import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  buildReplanTask,
  diffPlansForReplan,
  planFromNodes,
  planNodesFromSubtasks,
  type Plan,
  type PlanNodeState,
  type SubTask,
} from "../src/planner.js";
import { runPlanned } from "../src/orchestrate.js";
import type { ModelClient, ModelRequest, ModelTurn } from "../src/types.js";
import { fakeMessage, textBlock } from "./helpers.js";

function sub(
  id: string,
  title: string,
  deps: string[] = [],
  extras: Partial<SubTask> = {},
): SubTask {
  return {
    id,
    title,
    description: extras.description ?? `do ${title}`,
    acceptance: extras.acceptance ?? [`${title} ok`],
    dependsOn: deps,
    ...(extras.pack !== undefined ? { pack: extras.pack } : {}),
    ...(extras.resources ? { resources: extras.resources } : {}),
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

const passVerdict = () =>
  fakeMessage(
    [textBlock(JSON.stringify({ passed: true, summary: "ok", issues: [] }))],
    "end_turn",
  );

describe("AGENT-01 plan replan helpers", () => {
  it("diffPlansForReplan：passed 且内容未改 → kept；同 id 改文案 → changed；新/删分开", () => {
    const previous: Plan = {
      subtasks: [sub("s1", "勘察"), sub("s2", "改稿", ["s1"]), sub("s3", "验收", ["s2"])],
    };
    const next: Plan = {
      subtasks: [
        sub("s1", "勘察"),
        sub("s2", "改稿", ["s1"], { description: "改稿 v2" }),
        sub("s4", "补测", ["s2"]),
      ],
    };
    const diff = diffPlansForReplan(previous, next, new Set(["s1", "s2"]));
    expect(diff.kept).toEqual(["s1"]);
    expect(diff.changed).toEqual(["s2"]);
    expect(diff.added).toEqual(["s4"]);
    expect(diff.dropped).toEqual(["s3"]);
  });

  it("buildReplanTask 带上节点状态与委托方新要求", () => {
    const nodes: PlanNodeState[] = planNodesFromSubtasks([sub("s1", "勘察")], "passed");
    nodes[0]!.evidenceSummary = "已写 survey.md";
    const text = buildReplanTask({
      originalTask: "做 PPT",
      feedback: "改成英文版",
      nodes,
    });
    expect(text).toContain("【重规划】");
    expect(text).toContain("改成英文版");
    expect(text).toContain("s1 [passed]");
    expect(text).toContain("已写 survey.md");
  });

  it("planFromNodes 往返保留 dependsOn", () => {
    const nodes = planNodesFromSubtasks([sub("a", "A"), sub("b", "B", ["a"])]);
    expect(planFromNodes(nodes).subtasks.map((s) => s.dependsOn)).toEqual([[], ["a"]]);
  });
});

describe("AGENT-01 runPlanned replan 跳过 kept", () => {
  it("kept 节点不发射执行者；changed 会跑", async () => {
    const planJson = JSON.stringify({
      subtasks: [
        {
          id: "s1",
          title: "勘察",
          description: "do 勘察",
          acceptance: ["勘察 ok"],
          dependsOn: [],
        },
        {
          id: "s2",
          title: "改稿",
          description: "改稿 v2",
          acceptance: ["改稿 ok"],
          dependsOn: ["s1"],
        },
      ],
    });
    const client = new ScriptedClient([
      fakeMessage([textBlock(planJson)], "end_turn"), // planner
      fakeMessage([textBlock("s2 done")], "end_turn"), // s2 main only
      passVerdict(),
    ]);
    const cfg = {
      systemPrompt: "test",
      tools: [],
      maxTurns: 4,
      workdir: process.cwd(),
    };
    const diffs: Array<{ kept: string[]; changed: string[]; added: string[] }> = [];
    const sources: string[] = [];
    const outcome = await runPlanned(cfg, client, "ignored", {
      replan: {
        originalTask: "做 PPT",
        feedback: "改 s2",
        nodes: [
          {
            id: "s1",
            title: "勘察",
            description: "do 勘察",
            acceptance: ["勘察 ok"],
            dependsOn: [],
            status: "passed",
            evidenceSummary: "survey done",
          },
          {
            id: "s2",
            title: "改稿",
            description: "do 改稿",
            acceptance: ["改稿 ok"],
            dependsOn: ["s1"],
            status: "failed",
          },
        ],
        handoffs: { s1: "survey done" },
      },
      onReplan: (d) => {
        diffs.push({ kept: d.kept, changed: d.changed, added: d.added });
      },
      onEvent: (source) => {
        sources.push(source);
      },
      maxReworks: 0,
    });
    expect(diffs[0]?.kept).toEqual(["s1"]);
    expect(diffs[0]?.changed).toContain("s2");
    expect(sources.some((s) => s.startsWith("s1/"))).toBe(false);
    expect(sources.some((s) => s.startsWith("s2/"))).toBe(true);
    expect(outcome.steps.map((s) => s.sub.id).sort()).toEqual(["s1", "s2"]);
    expect(outcome.steps.find((s) => s.sub.id === "s1")?.result.finalPassed).toBe(true);
    expect(outcome.steps.find((s) => s.sub.id === "s1")?.durationMs).toBe(0);
    // s2 任务书应带上 s1 的预置交接
    const s2Req = client.requests.find((r) =>
      JSON.stringify(r.messages).includes("改稿 v2"),
    );
    expect(JSON.stringify(s2Req?.messages ?? [])).toContain("survey done");
  });
});

describe("RUN-01 runPlanned resume 跳过 passed", () => {
  it("注入同一张图：passed 不发射，pending 接着跑并吃到交接", async () => {
    const client = new ScriptedClient([
      fakeMessage([textBlock("s2 done")], "end_turn"),
      passVerdict(),
    ]);
    const plan: Plan = {
      subtasks: [sub("s1", "勘察"), sub("s2", "改稿", ["s1"])],
    };
    const started: string[] = [];
    const sources: string[] = [];
    const outcome = await runPlanned(
      { systemPrompt: "test", tools: [], maxTurns: 4, workdir: process.cwd() },
      client,
      "ignored",
      {
        plan,
        resume: {
          nodes: [
            {
              id: "s1",
              title: "勘察",
              description: "do 勘察",
              acceptance: ["勘察 ok"],
              dependsOn: [],
              status: "passed",
              evidenceSummary: "survey done",
            },
            {
              id: "s2",
              title: "改稿",
              description: "do 改稿",
              acceptance: ["改稿 ok"],
              dependsOn: ["s1"],
              status: "pending",
            },
          ],
          handoffs: { s1: "survey done" },
        },
        onSubtaskStart: (s) => {
          started.push(s.id);
        },
        onEvent: (source) => {
          sources.push(source);
        },
        maxReworks: 0,
      },
    );
    expect(started).toEqual(["s2"]);
    expect(sources.some((s) => s.startsWith("s1/"))).toBe(false);
    expect(sources.some((s) => s.startsWith("s2/"))).toBe(true);
    expect(outcome.steps.find((s) => s.sub.id === "s1")?.result.finalPassed).toBe(true);
    expect(outcome.steps.find((s) => s.sub.id === "s1")?.durationMs).toBe(0);
    expect(JSON.stringify(client.requests[0]?.messages ?? [])).toContain("survey done");
    expect(client.requests).toHaveLength(2);
  });
});

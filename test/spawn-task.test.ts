import { describe, expect, it } from "vitest";
import { withoutAskUser } from "../src/tools/ask-user.js";
import {
  createSpawnTaskTool,
  SPAWN_TASK_TOOL_NAME,
  withoutSpawnTask,
} from "../src/tools/spawn-task.js";
import { AgentLoop, createRunBudget } from "../src/loop.js";
import { runSpawnedTask, __resetSpawnSlotsForTest } from "../src/spawn.js";
import type { AgentConfig } from "../src/types.js";
import { FINISH_TASK_TOOL_NAME, withTaskCompletion } from "../src/task-completion.js";
import { FakeModelClient, fakeMessage, textBlock, toolUseBlock } from "./helpers.js";

describe("spawn_task (AGENT-02)", () => {
  it("withoutAskUser strips spawn_task (verifier/planner)", () => {
    const tools = [{ name: "bash" }, { name: SPAWN_TASK_TOOL_NAME }, { name: "ask_user" }];
    expect(withoutAskUser(tools).map((t) => t.name)).toEqual(["bash"]);
    expect(withoutSpawnTask(tools).map((t) => t.name)).toEqual(["bash", "ask_user"]);
  });

  it("depth >= maxDepth rejects without calling spawn", async () => {
    let called = 0;
    const tool = createSpawnTaskTool({
      depth: 1,
      maxDepth: 1,
      spawn: async () => {
        called += 1;
        return { summary: "nope", passed: true };
      },
    });
    const result = await tool.execute(
      { title: "x", description: "y" },
      {
        workdir: process.cwd(),
        toolUseId: "t1",
        signal: new AbortController().signal,
      },
    );
    expect(result.isError).toBe(true);
    expect(called).toBe(0);
  });

  it("returns parent-facing summary only; shares parent budget", async () => {
    __resetSpawnSlotsForTest();
    const budget = createRunBudget({ maxTurns: 20 });
    const parentCfg: AgentConfig = withTaskCompletion(
      {
        systemPrompt: "test",
        tools: [],
        workdir: process.cwd(),
        compat: true,
        maxTurns: 5,
        runBudget: budget,
      },
      { progressExtensionTurns: 0 },
    );

    const childClient = new FakeModelClient([
      fakeMessage(
        [
          toolUseBlock("tu_finish", FINISH_TASK_TOOL_NAME, {
            status: "completed",
            summary: "支线结论：42",
            artifacts: ["out.txt"],
            verification: ["ok"],
            assumptions: [],
            blockers: [],
          }),
        ],
        "tool_use",
      ),
    ]);

    const tool = createSpawnTaskTool({
      depth: 0,
      spawn: async (request) =>
        runSpawnedTask({
          parentConfig: parentCfg,
          modelClient: childClient,
          runBudget: budget,
          request,
        }),
    });

    const before = budget.usedTurns;
    const result = await tool.execute(
      { title: "调查", description: "算一下", acceptance: ["有结论"] },
      {
        workdir: process.cwd(),
        toolUseId: "t2",
        signal: new AbortController().signal,
      },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("支线结论：42");
    expect(result.content).toContain("out.txt");
    expect(budget.usedTurns).toBeGreaterThan(before);
  });

  it("child AgentLoop does not re-expose spawn_task", async () => {
    __resetSpawnSlotsForTest();
    const budget = createRunBudget();
    const parentCfg = withTaskCompletion(
      {
        systemPrompt: "test",
        tools: [
          createSpawnTaskTool({
            depth: 0,
            spawn: async () => ({ summary: "nested", passed: true }),
          }),
        ],
        workdir: process.cwd(),
        compat: true,
        maxTurns: 3,
        runBudget: budget,
      },
      { progressExtensionTurns: 0 },
    );

    const client = new FakeModelClient([
      fakeMessage(
        [
          toolUseBlock("done", FINISH_TASK_TOOL_NAME, {
            status: "completed",
            summary: "子结论",
            artifacts: [],
            verification: [],
            assumptions: [],
            blockers: [],
          }),
        ],
        "tool_use",
      ),
    ]);

    await runSpawnedTask({
      parentConfig: parentCfg,
      modelClient: client,
      runBudget: budget,
      request: { title: "t", description: "d", acceptance: [] },
    });

    const tools = client.requests[0]?.tools ?? [];
    expect(tools.some((t) => t.name === SPAWN_TASK_TOOL_NAME)).toBe(false);
    expect(tools.some((t) => t.name === FINISH_TASK_TOOL_NAME)).toBe(true);
  });

  it("getRunBudget exposes the live SharedRunBudget reference", () => {
    const budget = createRunBudget({ maxTurns: 9 });
    const loop = new AgentLoop(
      {
        systemPrompt: "x",
        tools: [],
        workdir: process.cwd(),
        compat: true,
        runBudget: budget,
      },
      new FakeModelClient([]),
    );
    expect(loop.getRunBudget()).toBe(budget);
  });
});

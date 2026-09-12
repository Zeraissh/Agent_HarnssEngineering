import { describe, expect, it } from "vitest";
import {
  STM32_FIX_THEN_VERIFY,
  buildHandoffPlan,
  buildHandoffTask,
  fillHandoffTemplate,
  findHandoffAmong,
  findPackHandoff,
  FIX_THEN_VERIFY,
} from "../src/handoff.js";
import { PACKS } from "../src/presets.js";
import { createProposeHandoffTool, PROPOSE_HANDOFF_TOOL_NAME } from "../src/tools/propose-handoff.js";
import { withoutAskUser, ASK_USER_TOOL_NAME } from "../src/tools/ask-user.js";
import type { ToolContext } from "../src/types.js";

const ctxTool = (): ToolContext => ({
  workdir: process.cwd(),
  toolUseId: "tu_h",
  signal: new AbortController().signal,
});

describe("handoff plan", () => {
  const ctx = {
    summary: "RCC_AHBENR bit6 是 F1 的 CRCEN，L1 在 bit12",
    parentTask: "镜像自校验，AC5 读 image_crc32",
    sketch: "【本对话近期委托】\n- 查 CRC 为什么是 0",
  };

  it("注入计划是 coding → debug 的线性两步，摘要写进任务书", () => {
    const plan = buildHandoffPlan(STM32_FIX_THEN_VERIFY, ctx);
    expect(plan.subtasks.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(plan.subtasks[0]!.dependsOn).toEqual([]);
    expect(plan.subtasks[1]!.dependsOn).toEqual(["s1"]);
    expect(plan.subtasks[0]!.pack).toBe("stm32-coding");
    expect(plan.subtasks[1]!.pack).toBe("stm32-debug");
    expect(plan.subtasks[0]!.description).toContain(ctx.summary);
    expect(plan.subtasks[0]!.description).toContain(ctx.parentTask);
    expect(plan.subtasks[0]!.acceptance[0]).toContain("bit12");
  });

  it("未知 id 解析失败", () => {
    expect(findPackHandoff(PACKS["stm32-debug"], "nope")).toBeNull();
    expect(findHandoffAmong(Object.values(PACKS), "nope")).toBeNull();
    expect(findHandoffAmong(Object.values(PACKS), FIX_THEN_VERIFY)?.id).toBe(FIX_THEN_VERIFY);
  });

  it("空摘要不能构图", () => {
    expect(() => buildHandoffPlan(STM32_FIX_THEN_VERIFY, { summary: "  ", parentTask: "x" })).toThrow(
      /summary/,
    );
  });

  it("任务书带根因，不提切包", () => {
    const task = buildHandoffTask(ctx);
    expect(task).toContain("按已确认的根因改固件并上板复测");
    expect(task).toContain(ctx.summary);
    expect(task).not.toMatch(/切包|stm32-coding|stm32-debug/);
  });

  it("模板空 sketch 不留占位符", () => {
    expect(fillHandoffTemplate("前{sketch}后", { summary: "a", parentTask: "b" })).toBe("前后");
  });
});

describe("propose_handoff 工具", () => {
  it("合法提议立刻返回，不挂起", async () => {
    const seen: string[] = [];
    const tool = createProposeHandoffTool({
      resolveHandoff: (id) => findPackHandoff(PACKS["stm32-debug"], id),
      onPropose: (p) => seen.push(p.summary),
    });
    const result = await tool.execute(
      { handoff: FIX_THEN_VERIFY, summary: "main.c:27 除零，CFSR 对得上" },
      ctxTool(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/对话继续|已记下/);
    expect(seen).toEqual(["main.c:27 除零，CFSR 对得上"]);
  });

  it("未知种类 / 空摘要拒绝，不回调", async () => {
    let called = 0;
    const tool = createProposeHandoffTool({
      resolveHandoff: (id) => findPackHandoff(PACKS["stm32-debug"], id),
      onPropose: () => {
        called += 1;
      },
    });
    const badId = await tool.execute(
      { handoff: "switch_pack", summary: "有点可疑" },
      ctxTool(),
    );
    const empty = await tool.execute(
      { handoff: FIX_THEN_VERIFY, summary: "  " },
      ctxTool(),
    );
    expect(badId.isError).toBe(true);
    expect(empty.isError).toBe(true);
    expect(called).toBe(0);
  });

  it("按钮文案来自包声明，不采信模型", async () => {
    const labels: string[] = [];
    const tool = createProposeHandoffTool({
      resolveHandoff: (id) => findPackHandoff(PACKS["stm32-debug"], id),
      onPropose: (p) => labels.push(p.label, p.declineLabel),
    });
    await tool.execute(
      { handoff: FIX_THEN_VERIFY, summary: "CRCEN 位号写错" },
      ctxTool(),
    );
    expect(labels[0]).toBe(STM32_FIX_THEN_VERIFY.label);
    expect(labels[1]).toBe(STM32_FIX_THEN_VERIFY.declineLabel);
    expect(labels.join(" ")).not.toMatch(/stm32-coding|stm32-debug|切包/);
  });
});

describe("对人说话的工具从核查/拆解面上剔除", () => {
  it("withoutAskUser 同时摘掉 propose_handoff", () => {
    const kept = withoutAskUser([
      { name: "bash" },
      { name: ASK_USER_TOOL_NAME },
      { name: PROPOSE_HANDOFF_TOOL_NAME },
      { name: "read_file" },
    ]);
    expect(kept.map((t) => t.name)).toEqual(["bash", "read_file"]);
  });
});

import { describe, expect, it } from "vitest";
import { AgentLoop } from "../src/loop.js";
import {
  claimsDeliveredImages,
  nameSuggestsVision,
  normalizeImagePath,
  resolveDescribeImageBacking,
  resolveExecutorVisionSupport,
  unreviewedImageCompletion,
} from "../src/design-image-review.js";
import {
  FINISH_TASK_IMAGE_GATE_WHEN_ABSENT,
  FINISH_TASK_IMAGE_GATE_WHEN_PRESENT,
  FINISH_TASK_TOOL_NAME,
  withTaskCompletion,
} from "../src/task-completion.js";
import type { AgentRunResult, TurnEvent } from "../src/types.js";
import { FakeModelClient, fakeMessage, makeTool, toolUseBlock } from "./helpers.js";

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

const completedImages = {
  status: "completed" as const,
  summary: "11张本地配图已就位",
  artifacts: ["index.html", "images/droplet.jpg"],
  verification: ["路径存在"],
  assumptions: [],
  blockers: [],
};

describe("claimsDeliveredImages", () => {
  it("认配图/图片文件，不认『图鉴』这种字", () => {
    expect(claimsDeliveredImages(completedImages)).toBe(true);
    expect(
      claimsDeliveredImages({
        summary: "三体科技图鉴提纲已写完",
        artifacts: ["outline.md"],
        verification: ["字数够"],
      }),
    ).toBe(false);
    expect(normalizeImagePath(".\\Images\\Droplet.JPG")).toBe("images/droplet.jpg");
  });

  it("没看过图的 completed 是事实；硬拒与否看工具面", () => {
    expect(unreviewedImageCompletion(completedImages, 0)).toBe(true);
    expect(unreviewedImageCompletion(completedImages, 1)).toBe(false);
    expect(unreviewedImageCompletion({ ...completedImages, status: "partial" }, 0)).toBe(false);
  });
});

describe("finish_task 识图门", () => {
  const baseConfig = {
    systemPrompt: "executor",
    workdir: process.cwd(),
    tools: [],
  };

  function eye() {
    return makeTool({
      name: "describe_image",
      execute: async () => ({ content: "否：这是一张随机风景，看不见水滴。" }),
    });
  }

  it("工具面有 describe_image：声称交了配图却从未调用 → 不许 completed，修正后再收", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("bad", FINISH_TASK_TOOL_NAME, completedImages)], "tool_use"),
      fakeMessage(
        [
          toolUseBlock("good", FINISH_TASK_TOOL_NAME, {
            status: "partial",
            summary: "图还没被看过，不能当配图验收",
            artifacts: ["index.html", "images/droplet.jpg"],
            verification: [],
            assumptions: ["picsum 随机图"],
            blockers: ["识图未做：不能确认画面是水滴"],
          }),
        ],
        "tool_use",
      ),
    ]);
    const cfg = withTaskCompletion({ ...baseConfig, tools: [eye()] }, { progressExtensionTurns: 0 });
    const finish = cfg.tools.find((t) => t.name === FINISH_TASK_TOOL_NAME);
    expect(finish?.description).toContain(FINISH_TASK_IMAGE_GATE_WHEN_PRESENT);
    expect(cfg.terminalReminder).toContain("必须已成功调用 describe_image");
    const { events, result } = await collect(new AgentLoop(cfg, model).run("杂志风幻灯"));
    const rejected = events.find((e) => e.type === "tool_result" && e.toolUseId === "bad");
    expect(rejected?.type === "tool_result" && rejected.result.isError).toBe(true);
    expect(result.stopReason).toBe("partial");
    expect(result.completion?.blockers?.[0]).toMatch(/识图/);
  });

  it("工具面没有 describe_image：未审图的 completed 不在 resolveTerminal 打成无效", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("done", FINISH_TASK_TOOL_NAME, completedImages)], "tool_use"),
    ]);
    const cfg = withTaskCompletion({ ...baseConfig, tools: [] }, { progressExtensionTurns: 0 });
    const finish = cfg.tools.find((t) => t.name === FINISH_TASK_TOOL_NAME);
    expect(finish?.description).toContain(FINISH_TASK_IMAGE_GATE_WHEN_ABSENT);
    expect(finish?.description).not.toContain("必须先成功调用 describe_image");
    expect(cfg.terminalReminder).toContain("没有 describe_image");
    expect(cfg.terminalReminder).toContain("优先 partial");
    const { events, result } = await collect(new AgentLoop(cfg, model).run("杂志风幻灯"));
    const ack = events.find((e) => e.type === "tool_result" && e.toolUseId === "done");
    expect(ack).toBeDefined();
    expect(ack?.type === "tool_result" && ack.result.isError).toBeFalsy();
    expect(result.stopReason).toBe("completed");
    expect(result.completion?.artifacts).toContain("images/droplet.jpg");
  });

  it("先看过图再 completed 才收", async () => {
    const model = new FakeModelClient([
      fakeMessage(
        [toolUseBlock("see", "describe_image", { path: "images/droplet.jpg", question: "这是水滴吗" })],
        "tool_use",
      ),
      fakeMessage([toolUseBlock("done", FINISH_TASK_TOOL_NAME, completedImages)], "tool_use"),
    ]);
    const cfg = withTaskCompletion({ ...baseConfig, tools: [eye()] }, { progressExtensionTurns: 0 });
    const { result } = await collect(new AgentLoop(cfg, model).run("杂志风幻灯"));
    expect(result.stopReason).toBe("completed");
  });
});

describe("识图 backing：执行者能看就不引角色", () => {
  it.each([
    ["claude-opus-4-8", true],
    ["claude-sonnet-4-5", true],
    ["gpt-4o", true],
    ["gpt-4.1-mini", true],
    ["gpt-5", true],
    ["qwen-vl-max", true],
    ["deepseek-v4-flash-vision-exp", true],
    ["moonshot-v1-8k-vision-preview", true],
    ["kimi-k2.6", false],
    ["deepseek-v4-flash", false],
    ["deepseek-v4-pro", false],
    ["", false],
  ] as const)("%s → %s", (name, expected) => {
    expect(nameSuggestsVision(name)).toBe(expected);
  });

  it("注入假客户端不按 claude 名当真", () => {
    expect(resolveExecutorVisionSupport({ modelName: "claude-opus-4-8", injectedClient: true })).toBe(false);
    expect(resolveExecutorVisionSupport({ modelName: "claude-opus-4-8" })).toBe(true);
    expect(resolveExecutorVisionSupport({
      modelName: "kimi-k2.6",
      probed: true,
      injectedClient: true,
    })).toBe(true);
    expect(resolveExecutorVisionSupport({ modelName: "claude-opus-4-8", probed: false })).toBe(false);
  });

  it("backing 优先级：执行者 > 识图角色 > 无", () => {
    expect(resolveDescribeImageBacking({
      executorSupportsVision: true,
      visionRoleConfigured: true,
    })).toBe("executor");
    expect(resolveDescribeImageBacking({
      executorSupportsVision: false,
      visionRoleConfigured: true,
    })).toBe("vision-role");
    expect(resolveDescribeImageBacking({
      executorSupportsVision: false,
      visionRoleConfigured: true,
      visionRoleSupportsVision: false,
    })).toBe("none");
    expect(resolveDescribeImageBacking({
      executorSupportsVision: false,
      visionRoleConfigured: false,
    })).toBe("none");
  });
});

/**
 * view_image —— 圈内图入 loop 队列，下一轮 request 带 image 块。
 *
 * 盯三件事：圈禁/体积与 describe_image 同纪律、文本执行者不注册、
 * 成功调用后下一轮发给执行者的 messages 里真有图（且不污染 userInput）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { AgentLoop } from "../src/loop.js";
import { assembleViewImageTool } from "../src/design-image-review.js";
import {
  appendViewImagesToMessages,
  createViewImageQueue,
  createViewImageTool,
  type PendingViewImage,
} from "../src/tools/view-image.js";
import type { AgentRunResult, TurnEvent } from "../src/types.js";
import { FakeModelClient, fakeMessage, textBlock, toolUseBlock } from "./helpers.js";

/** 1×1 透明 PNG */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "viewimg-"));
  await writeFile(join(dir, "shot.png"), Buffer.from(PNG_B64, "base64"));
  await writeFile(join(dir, "notes.txt"), "not an image");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ctx = () => ({ workdir: dir, toolUseId: "t1", signal: new AbortController().signal });

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

function imageBlocksIn(reqMessages: Anthropic.MessageParam[]): Anthropic.ImageBlockParam[] {
  const out: Anthropic.ImageBlockParam[] = [];
  for (const m of reqMessages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "image") out.push(b);
    }
  }
  return out;
}

describe("view_image", () => {
  it("审批只能单次：相同路径不能替被换过内容的新文件继续授权", () => {
    expect(createViewImageTool().approvalPolicy).toEqual({ maxScope: "once" });
  });

  it("权限为 ask：把本地文件内容送进执行者上下文，属于要审批的动作", () => {
    const tool = createViewImageTool();
    expect(tool.permission).toBe("ask");
    expect(tool.parallelSafe).toBe(true);
  });

  it("读成 base64 写入队列，tool_result 只回执不带像素", async () => {
    const queue = createViewImageQueue();
    const tool = createViewImageTool({ queue });
    const out = await tool.execute({ path: "shot.png" }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("shot.png");
    expect(out.content).not.toContain(PNG_B64);

    const pending = queue.drain();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.path).toBe("shot.png");
    expect(pending[0]!.mediaType).toBe("image/png");
    expect(pending[0]!.data).toBe(PNG_B64);
    expect(queue.drain()).toHaveLength(0);
  });

  it("非图片扩展名当场拒绝，并列出支持的类型", async () => {
    const queue = createViewImageQueue();
    const out = await createViewImageTool({ queue }).execute({ path: "notes.txt" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toContain(".png");
    expect(queue.drain()).toHaveLength(0);
  });

  it("文件不存在时报清楚，不把异常抛给循环", async () => {
    const queue = createViewImageQueue();
    const out = await createViewImageTool({ queue }).execute({ path: "missing.png" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toContain("missing.png");
    expect(queue.drain()).toHaveLength(0);
  });

  it("逃出工作目录的路径被挡住", async () => {
    const queue = createViewImageQueue();
    const out = await createViewImageTool({ queue }).execute({ path: "../outside.png" }, ctx());
    expect(out.isError).toBe(true);
    expect(queue.drain()).toHaveLength(0);
  });

  it("超过 describe_image 同款体积上限则拒绝且不入队", async () => {
    const huge = join(dir, "huge.png");
    await writeFile(huge, Buffer.alloc(3_500_001, 1));
    const queue = createViewImageQueue();
    const out = await createViewImageTool({ queue }).execute({ path: "huge.png" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/too large/i);
    expect(out.content).toContain("3.5MB");
    expect(queue.drain()).toHaveLength(0);
  });

  it("缺 path 入参不入队", async () => {
    const queue = createViewImageQueue();
    const out = await createViewImageTool({ queue }).execute({}, ctx());
    expect(out.isError).toBe(true);
    expect(queue.drain()).toHaveLength(0);
  });
});

describe("assembleViewImageTool", () => {
  it("文本执行者不注册：工具面没有 view_image，避免 [Unsupported Image]", () => {
    expect(assembleViewImageTool({ executorSupportsVision: false })).toBeUndefined();
  });

  it("执行者能看图才装配，名字就是 view_image", () => {
    const tool = assembleViewImageTool({ executorSupportsVision: true });
    expect(tool?.name).toBe("view_image");
    expect(tool?.permission).toBe("ask");
  });
});

describe("appendViewImagesToMessages", () => {
  const sample: PendingViewImage = {
    path: "shot.png",
    mediaType: "image/png",
    data: PNG_B64,
  };

  it("并进末条 user，不造连续两条 user", () => {
    const before: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu", content: "loaded" }] },
    ];
    const after = appendViewImagesToMessages(before, [sample]);
    expect(after).toHaveLength(3);
    const last = after[2]!;
    expect(last.role).toBe("user");
    const blocks = last.content as Anthropic.ContentBlockParam[];
    expect(blocks.some((b) => b.type === "tool_result")).toBe(true);
    expect(blocks.some((b) => b.type === "text" && b.text === "[view_image] shot.png")).toBe(true);
    const image = blocks.find((b) => b.type === "image") as Anthropic.ImageBlockParam;
    expect(image.source.type).toBe("base64");
    if (image.source.type === "base64") {
      expect(image.source.media_type).toBe("image/png");
      expect(image.source.data).toBe(PNG_B64);
    }
    expect(before[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu", content: "loaded" }],
    });
  });

  it("空队列原样返回同一引用", () => {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "go" }];
    expect(appendViewImagesToMessages(messages, [])).toBe(messages);
  });
});

describe("AgentLoop · view_image 队列", () => {
  it("下一轮 request 含 image 块；首轮 userInput 仍是字符串、没有图", async () => {
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_1", "view_image", { path: "shot.png" })], "tool_use"),
      fakeMessage([textBlock("saw it")], "end_turn"),
    ]);
    const loop = new AgentLoop(
      {
        systemPrompt: "test",
        workdir: dir,
        tools: [assembleViewImageTool({ executorSupportsVision: true })!],
      },
      model,
    );
    const { result, events } = await collect(loop.run("look at shot.png"));

    expect(result.stopReason).toBe("completed");
    expect(model.requests).toHaveLength(2);

    const firstUser = model.requests[0]!.messages[0]!;
    expect(firstUser.role).toBe("user");
    const firstText =
      typeof firstUser.content === "string"
        ? firstUser.content
        : firstUser.content
            .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
            .map((b) => b.text)
            .join("");
    expect(firstText).toBe("look at shot.png");
    expect(imageBlocksIn(model.requests[0]!.messages)).toHaveLength(0);

    const images = imageBlocksIn(model.requests[1]!.messages);
    expect(images, "第二轮请求里没有图像块——view_image 白调了").toHaveLength(1);
    expect(images[0]!.source.type).toBe("base64");
    if (images[0]!.source.type === "base64") {
      expect(images[0]!.source.media_type).toBe("image/png");
      expect(images[0]!.source.data).toBe(PNG_B64);
    }
    const lastUser = model.requests[1]!.messages.at(-1)!;
    const lastText =
      typeof lastUser.content === "string"
        ? lastUser.content
        : lastUser.content
            .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
            .map((b) => b.text)
            .join("\n");
    expect(lastText).toContain("[view_image] shot.png");

    const ack = events.find((e) => e.type === "tool_result" && e.toolUseId === "tu_1");
    expect(ack?.type === "tool_result" && ack.result.isError).toBeFalsy();
    expect(ack?.type === "tool_result" && ack.result.content).not.toContain(PNG_B64);
  });

  it("文本执行者工具面没有 view_image：调用即未知工具，request 仍无图", async () => {
    expect(assembleViewImageTool({ executorSupportsVision: false })).toBeUndefined();
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_1", "view_image", { path: "shot.png" })], "tool_use"),
      fakeMessage([textBlock("done")], "end_turn"),
    ]);
    const loop = new AgentLoop({ systemPrompt: "test", workdir: dir, tools: [] }, model);
    const { events } = await collect(loop.run("go"));
    const result = events.find((e) => e.type === "tool_result" && e.toolUseId === "tu_1");
    expect(result?.type === "tool_result" && result.result.isError).toBe(true);
    expect(result?.type === "tool_result" && result.result.content).toMatch(/Unknown tool/i);
    expect(imageBlocksIn(model.requests[1]!.messages)).toHaveLength(0);
  });
});

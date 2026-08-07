// @ts-nocheck
/**
 * describe_image —— 把"看图"包成工具（V-31）。
 *
 * 这个工具的价值命题是：让 DeepSeek / Kimi 这类**纯文本执行者**间接获得视觉
 * 能力。所以测试要盯住三件事：请求里真的带了图、边界情形不静默失败、
 * 以及错误信息是写给模型看的（P5）——它得据此改道，而不是原地打转。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { createDescribeImageTool } from "../src/tools/describe-image.js";
import { toOpenAIMessages } from "../src/model-client-openai.js";

/** 1×1 透明 PNG */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let dir: string;
let imgPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "descimg-"));
  imgPath = join(dir, "shot.png");
  await writeFile(imgPath, Buffer.from(PNG_B64, "base64"));
  await writeFile(join(dir, "notes.txt"), "not an image");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 记录收到的请求，回一段固定文本 */
function recorder(text = "一张 1×1 的透明图。") {
  const seen: any[] = [];
  return {
    seen,
    client: {
      async send(req: any) {
        seen.push(req);
        return {
          message: {
            id: "m", type: "message", role: "assistant", model: "vision",
            content: [{ type: "text", text }],
            stop_reason: "end_turn", stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          },
          stopReason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    },
  };
}

const ctx = () => ({ workdir: dir, toolUseId: "t1", signal: new AbortController().signal });

describe("describe_image", () => {
  it("把图片读成 base64 图像块发给视觉模型，并把提问一并带上", async () => {
    const rec = recorder("屏幕上写着 Connection refused。");
    const tool = createDescribeImageTool({ client: rec.client, modelName: "kimi-vision" });

    const out = await tool.execute({ path: "shot.png", question: "截图里报了什么错？" }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toBe("屏幕上写着 Connection refused。");

    const req = rec.seen[0];
    const blocks = req.messages[0].content;
    const image = blocks.find((b: any) => b.type === "image");
    expect(image, "请求里没有图像块——那就是一次空的看图请求").toBeDefined();
    expect(image.source.media_type).toBe("image/png");
    expect(image.source.data).toBe(PNG_B64);
    expect(blocks.find((b: any) => b.type === "text").text).toBe("截图里报了什么错？");
  });

  it("不给问题时用通用提示，并要求逐字带出图中文字", async () => {
    const rec = recorder();
    const tool = createDescribeImageTool({ client: rec.client });
    await tool.execute({ path: "shot.png" }, ctx());
    const text = rec.seen[0].messages[0].content.find((b: any) => b.type === "text").text;
    expect(text).toContain("verbatim");
  });

  /**
   * 系统提示里要求"看不清就说看不清"。这一条不是文案洁癖：调用方是另一个
   * 模型，它看不见图，只能全盘接受这段文字。视觉模型编一句合理的猜测，
   * 下游就会拿它当事实继续推理——这正是三值裁决协议要解决的那类问题。
   */
  it("系统提示要求诚实降级，而不是猜", async () => {
    const rec = recorder();
    const tool = createDescribeImageTool({ client: rec.client });
    await tool.execute({ path: "shot.png" }, ctx());
    const sys = rec.seen[0].system.map((b: any) => b.text).join(" ");
    expect(sys).toMatch(/unreadable or ambiguous/i);
    expect(sys).toMatch(/rather than guessing/i);
  });

  it("非图片扩展名当场拒绝，并列出支持的类型", async () => {
    const tool = createDescribeImageTool({ client: recorder().client });
    const out = await tool.execute({ path: "notes.txt" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toContain(".png");
  });

  it("文件不存在时报清楚，不把异常抛给循环", async () => {
    const tool = createDescribeImageTool({ client: recorder().client });
    const out = await tool.execute({ path: "missing.png" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toContain("missing.png");
  });

  it("逃出工作目录的路径被挡住", async () => {
    const tool = createDescribeImageTool({ client: recorder().client });
    const out = await tool.execute({ path: "../outside.png" }, ctx());
    expect(out.isError).toBe(true);
  });

  it("视觉模型返回空文本时报错，而不是把空串当成描述", async () => {
    const rec = recorder("");
    const tool = createDescribeImageTool({ client: rec.client, modelName: "no-vision-model" });
    const out = await tool.execute({ path: "shot.png" }, ctx());
    expect(out.isError).toBe(true);
    // 提示要指向真正的可能原因：这个模型可能压根不支持图像输入
    expect(out.content).toContain("no-vision-model");
    expect(out.content).toMatch(/image input/i);
  });

  it("视觉端点抛错时，错误进上下文写给模型看（P5），循环不中断", async () => {
    const tool = createDescribeImageTool({
      client: { async send() { throw new Error("402 insufficient balance"); } },
      modelName: "kimi-vision",
    });
    const out = await tool.execute({ path: "shot.png" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toContain("402 insufficient balance");
    expect(out.content).toContain("kimi-vision");
  });

  it("权限为 ask：把本地文件内容送到另一个端点，属于要审批的动作", () => {
    const tool = createDescribeImageTool({ client: recorder().client });
    expect(tool.permission).toBe("ask");
    expect(tool.parallelSafe).toBe(true);
  });

  /**
   * 端到端的要害：Kimi / Qwen-VL / GLM-4V 都走 OpenAI 兼容端点。工具构造的
   * Anthropic 图像块必须能被 toOpenAIMessages 翻译成 image_url，否则整条
   * 视觉链路会静默变成"只发提示词不发图"。
   */
  it("构造出的请求经 compat 翻译后仍带着图（Kimi 这类端点的前提）", async () => {
    const rec = recorder();
    const tool = createDescribeImageTool({ client: rec.client });
    await tool.execute({ path: "shot.png", question: "看看" }, ctx());

    const converted = toOpenAIMessages(rec.seen[0]);
    const user = converted.find((m) => m.role === "user")!;
    const parts = user.content as any[];
    const image = parts.find((p) => p.type === "image_url");
    expect(image, "compat 翻译把图丢了——视觉模型会收到一个没有图的请求").toBeDefined();
    expect(image.image_url.url).toBe(`data:image/png;base64,${PNG_B64}`);
  });
});

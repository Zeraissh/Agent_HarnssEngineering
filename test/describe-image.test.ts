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
import { createDescribeImageTool, DESCRIBE_IMAGE_SUMMARY_MAX_TOKENS } from "../src/tools/describe-image.js";
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
  it("审批只能单次：相同路径不能替被换过内容的新文件继续授权", () => {
    const tool = createDescribeImageTool({ client: recorder("unused").client, modelName: "vision" });
    expect(tool.approvalPolicy).toEqual({ maxScope: "once" });
  });

  it("把图片读成 base64 图像块发给视觉模型，并把提问一并带上", async () => {
    const rec = recorder("屏幕上写着 Connection refused。");
    const tool = createDescribeImageTool({ client: rec.client, modelName: "kimi-vision" });

    const out = await tool.execute({ path: "shot.png", question: "截图里报了什么错？", detail: "full" }, ctx());
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

  it("detail=full 且不给问题时用通用提示，并要求逐字带出图中文字", async () => {
    const rec = recorder();
    const tool = createDescribeImageTool({ client: rec.client });
    await tool.execute({ path: "shot.png", detail: "full" }, ctx());
    const text = rec.seen[0].messages[0].content.find((b: any) => b.type === "text").text;
    expect(text).toContain("verbatim");
    expect(rec.seen[0].maxTokens).toBe(2048);
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

  it("schema 声明 detail=summary|full，缺省 summary", () => {
    const tool = createDescribeImageTool({ client: recorder().client });
    const detail = tool.inputSchema.properties.detail;
    expect(detail).toBeDefined();
    expect(detail.enum).toEqual(["summary", "full"]);
    expect(detail.description).toMatch(/default/i);
    expect(detail.description).toMatch(/summary/i);
    expect(tool.inputSchema.required).toEqual(["path"]);
  });

  it("工具描述写死先 summary，只有像素/对比/排版才 full", () => {
    const tool = createDescribeImageTool({ client: recorder().client });
    expect(tool.description).toMatch(/detail=summary/i);
    expect(tool.description).toMatch(/default/i);
    expect(tool.description).toMatch(/pixel/i);
    expect(tool.description).toMatch(/contrast/i);
    expect(tool.description).toMatch(/layout/i);
    expect(tool.description).toMatch(/detail=full/i);
    expect(tool.description).toMatch(/Do not use full for a first look/i);
  });

  /**
   * 缺省必须是便宜档：不传 detail、传 summary、空串，都走短标签提示，maxTokens 百级。
   * 变异：若缺省仍用 2048 + verbatim 长描述，这条就红。
   */
  it("缺省 summary：短标签提示，maxTokens 压到百级，仍带着图", async () => {
    const rec = recorder("screenshot · text · no people · 1×1 transparent PNG");
    const tool = createDescribeImageTool({ client: rec.client });
    const out = await tool.execute({ path: "shot.png" }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("screenshot");

    const req = rec.seen[0];
    expect(req.maxTokens).toBe(DESCRIBE_IMAGE_SUMMARY_MAX_TOKENS);
    expect(req.maxTokens).toBeLessThanOrEqual(200);
    const text = req.messages[0].content.find((b: any) => b.type === "text").text;
    expect(text).toMatch(/type/i);
    expect(text).toMatch(/text/i);
    expect(text).toMatch(/error/i);
    expect(text).toMatch(/people/i);
    expect(text).toMatch(/one sentence/i);
    expect(text).not.toMatch(/in detail/i);
    expect(req.messages[0].content.find((b: any) => b.type === "image"), "summary 也必须真的送图").toBeDefined();
  });

  it("显式 detail=summary 与缺省同一条路；带 question 也只在短标签层回答", async () => {
    const rec = recorder();
    const tool = createDescribeImageTool({ client: rec.client, maxTokens: 4096 });
    await tool.execute({ path: "shot.png", detail: "summary", question: "这是什么" }, ctx());
    const req = rec.seen[0];
    expect(req.maxTokens).toBe(DESCRIBE_IMAGE_SUMMARY_MAX_TOKENS);
    const text = req.messages[0].content.find((b: any) => b.type === "text").text;
    expect(text).toContain("这是什么");
    expect(text).toMatch(/short-label/i);
    expect(text).not.toBe("这是什么");
  });

  it("工厂 maxTokens 只约束 full；summary 不会被抬到 full 预算", async () => {
    const rec = recorder();
    const tool = createDescribeImageTool({ client: rec.client, maxTokens: 4096 });
    await tool.execute({ path: "shot.png", detail: "full" }, ctx());
    await tool.execute({ path: "shot.png", detail: "summary" }, ctx());
    expect(rec.seen[0].maxTokens).toBe(4096);
    expect(rec.seen[1].maxTokens).toBe(DESCRIBE_IMAGE_SUMMARY_MAX_TOKENS);
  });

  it("非法 detail 当场拒绝，不打视觉端点，错误写给模型看（P5）", async () => {
    const rec = recorder();
    const tool = createDescribeImageTool({ client: rec.client });
    const out = await tool.execute({ path: "shot.png", detail: "pixels" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/summary/i);
    expect(out.content).toMatch(/full/i);
    expect(rec.seen, "非法 detail 不该去烧视觉 token").toHaveLength(0);
  });

  /**
   * 配图完成门认的是「成功调用过 describe_image」（!isError），不要求 full。
   * 这条锁在工具层：缺省 summary 的成功回执不得被标成错误。
   */
  it("summary 成功也是成功调用：配图门不要求 full", async () => {
    const rec = recorder("photo · no text · no error · no people · a red square");
    const tool = createDescribeImageTool({ client: rec.client });
    const omitted = await tool.execute({ path: "shot.png" }, ctx());
    const explicit = await tool.execute({ path: "shot.png", detail: "summary" }, ctx());
    expect(omitted.isError).toBeFalsy();
    expect(explicit.isError).toBeFalsy();
    expect(typeof omitted.content).toBe("string");
    expect(omitted.content.length).toBeGreaterThan(0);
  });
});

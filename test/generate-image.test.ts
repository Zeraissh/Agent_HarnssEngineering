import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGenerateImageTool } from "../src/tools/generate-image.js";
import type { ImageGenClient, ImageGenResult } from "../src/image-client.js";
import { isSideEffectTool, retryPolicyForTool } from "../src/tool-tx.js";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_B64, "base64");

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "genimg-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeClient(result: ImageGenResult | Error, seen: unknown[] = []): ImageGenClient {
  return {
    async generate(req) {
      seen.push(req);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const ctx = () => ({ workdir: dir, toolUseId: "t1", signal: new AbortController().signal });

describe("generate_image", () => {
  it("审批只能单次；写盘所以是副作用且可幂等重试", () => {
    const tool = createGenerateImageTool({ client: fakeClient({ bytes: PNG, mediaType: "image/png" }) });
    expect(tool.permission).toBe("ask");
    expect(tool.parallelSafe).toBe(false);
    expect(tool.approvalPolicy).toEqual({ maxScope: "once" });
    expect(isSideEffectTool(tool.name)).toBe(true);
    expect(retryPolicyForTool(tool.name)).toBe("idempotent_retry");
  });

  it("把生成的字节写进工作目录，回报相对路径", async () => {
    const seen: unknown[] = [];
    const tool = createGenerateImageTool({
      client: fakeClient({ bytes: PNG, mediaType: "image/png", revisedPrompt: "a tiny pixel" }, seen),
      modelName: "dall-e-3",
    });
    const out = await tool.execute({ prompt: "a red square", path: "generated/hero.png", size: "512x512" }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("generated/hero.png");
    expect(out.content).toContain("image/png");
    expect(out.content).toContain("a tiny pixel");
    expect(await readFile(join(dir, "generated", "hero.png"))).toEqual(PNG);
    expect(seen[0]).toMatchObject({ prompt: "a red square", size: "512x512" });
  });

  it("相同字节再写入报 unchanged（SAFE-06 内容幂等）", async () => {
    const tool = createGenerateImageTool({
      client: fakeClient({ bytes: PNG, mediaType: "image/png" }),
    });
    await tool.execute({ prompt: "x", path: "generated/same.png" }, ctx());
    const again = await tool.execute({ prompt: "x", path: "generated/same.png" }, ctx());
    expect(again.content).toMatch(/unchanged/);
  });

  it("缺 prompt / 非法 size / 逃出工作目录都当场拒绝，不调端点", async () => {
    const seen: unknown[] = [];
    const tool = createGenerateImageTool({
      client: fakeClient({ bytes: PNG, mediaType: "image/png" }, seen),
    });
    expect((await tool.execute({ prompt: "  " }, ctx())).isError).toBe(true);
    expect((await tool.execute({ prompt: "ok", size: "huge" }, ctx())).isError).toBe(true);
    const escaped = await tool.execute({ prompt: "ok", path: "../outside.png" }, ctx());
    expect(escaped.isError).toBe(true);
    expect(escaped.content).toMatch(/escapes/i);
    expect(seen).toHaveLength(0);
  });

  it("端点抛错时错误进上下文写给模型看，循环不中断", async () => {
    const tool = createGenerateImageTool({
      client: fakeClient(new Error("402 insufficient balance")),
      modelName: "dall-e-3",
    });
    const out = await tool.execute({ prompt: "a cat" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toContain("402 insufficient balance");
    expect(out.content).toContain("dall-e-3");
  });
});

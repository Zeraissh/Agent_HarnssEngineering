/**
 * generate_image —— 把"生图"包成工具。
 *
 * 与 describe_image 对偶：识图走 ModelClient.send() 塞图像块；
 * 生图打 OpenAI 兼容 /images/generations，再把字节写进工作目录。
 *
 * 工厂而不是常量：工具需要 ImageGenClient，ToolContext 里没有。
 * 未配置生图角色时宿主根本不把它放进工具池——摆一个一调用就报错的
 * 工具是在骗模型说自己能画图。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "../types.js";
import {
  DEFAULT_IMAGE_SIZE,
  type ImageGenClient,
  type ImageMediaType,
} from "../image-client.js";
import { resolveInWorkdir } from "./fs-util.js";

const SIZE_RE = /^\d{2,5}x\d{2,5}$/;
const EXT_OF: Record<ImageMediaType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export interface GenerateImageOptions {
  client: ImageGenClient;
  /** 仅用于错误信息与审计，不参与请求构造 */
  modelName?: string;
}

function defaultRelPath(prompt: string, ext: string): string {
  const slug =
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "image";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `generated/${stamp}-${slug}.${ext}`;
}

export function createGenerateImageTool(opts: GenerateImageOptions): Tool {
  return {
    name: "generate_image",
    description:
      "Generate an image from a text prompt and save it as a file in the working directory. Call this when the task asks for an illustration, mockup, diagram, or other newly created picture. Returns the relative path of the written file. You cannot see the image; if you need to inspect it afterwards, use describe_image (when configured). Optional path is relative to the working directory; omit it to write under generated/.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "What to draw. Be specific about subject, composition, and style.",
        },
        path: {
          type: "string",
          description:
            "Optional output path relative to the working directory (e.g. generated/hero.png). Parent directories are created. Omit to auto-name under generated/.",
        },
        size: {
          type: "string",
          description:
            `Pixel size as WIDTHxHEIGHT. Default ${DEFAULT_IMAGE_SIZE}. Common values: 256x256, 512x512, 1024x1024, 1792x1024, 1024x1792.`,
        },
      },
      required: ["prompt"],
    },
    permission: "ask",
    parallelSafe: false,
    approvalPolicy: { maxScope: "once" },

    async execute(input, ctx) {
      const { prompt, path: p, size } = input as {
        prompt?: unknown;
        path?: unknown;
        size?: unknown;
      };
      if (typeof prompt !== "string" || !prompt.trim()) {
        return { content: 'Invalid input: expected {"prompt": string}.', isError: true };
      }
      let resolvedSize = DEFAULT_IMAGE_SIZE;
      if (size !== undefined && size !== null && size !== "") {
        if (typeof size !== "string" || !SIZE_RE.test(size)) {
          return {
            content: `Invalid size "${String(size)}". Use WIDTHxHEIGHT (e.g. ${DEFAULT_IMAGE_SIZE}).`,
            isError: true,
          };
        }
        resolvedSize = size;
      }

      const requestedPath = typeof p === "string" && p.trim() ? p.trim() : null;
      if (requestedPath) {
        try {
          resolveInWorkdir(ctx.workdir, requestedPath);
        } catch (err) {
          return { content: err instanceof Error ? err.message : String(err), isError: true };
        }
      }

      let result;
      try {
        result = await opts.client.generate({
          prompt: prompt.trim(),
          size: resolvedSize,
          signal: ctx.signal,
        });
      } catch (err) {
        return {
          content: `Image model${opts.modelName ? ` (${opts.modelName})` : ""} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          isError: true,
        };
      }

      const ext = EXT_OF[result.mediaType];
      const rel =
        typeof p === "string" && p.trim()
          ? p.trim()
          : defaultRelPath(prompt.trim(), ext);

      let resolved: string;
      try {
        resolved = resolveInWorkdir(ctx.workdir, rel);
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }

      await mkdir(path.dirname(resolved), { recursive: true });
      const revalidated = resolveInWorkdir(ctx.workdir, rel);
      try {
        const existing = await readFile(revalidated);
        if (existing.equals(result.bytes)) {
          return {
            content: `Wrote ${result.bytes.length} bytes to ${rel} (${result.mediaType}, unchanged)`,
          };
        }
      } catch {
        /* 不存在或不可读 → 正常写入 */
      }
      await writeFile(revalidated, result.bytes);
      const revised = result.revisedPrompt ? ` Revised prompt: ${result.revisedPrompt}` : "";
      return {
        content: `Wrote ${result.bytes.length} bytes to ${rel} (${result.mediaType}).${revised}`,
      };
    },
  };
}

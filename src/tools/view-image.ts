/**
 * view_image —— 把圈内图写成 Anthropic image 块，交给执行者当轮亲眼看。
 *
 * 只在执行者自己能看图时注册。文本执行者看不见像素，注册了只会换来
 * `[Unsupported Image]`；那种情况继续走 describe_image。
 *
 * 像素不进 tool_result（那会把 base64 写进正史正文），也不改
 * `userInput: string`。工具往队列 enqueue，loop 在下一轮发请求前 drain，
 * 把 image 块并进当轮 messages。
 */
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "../types.js";
import { resolveReadable } from "./fs-util.js";

/** 与 describe_image 同一张表：端点只认这四种。 */
const MEDIA_TYPES: Record<string, PendingViewImage["mediaType"]> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * 与 describe_image 同一上限：原始字节 3.5MB（base64 膨胀 ~4/3 后贴 API ~5MB）。
 * 不从 describe-image 重导出——那份文件另有人在改 detail 字段。
 */
const MAX_BYTES = 3_500_000;

export interface PendingViewImage {
  path: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string;
}

export interface ViewImageQueue {
  enqueue(item: PendingViewImage): void;
  drain(): PendingViewImage[];
}

export function createViewImageQueue(): ViewImageQueue {
  const items: PendingViewImage[] = [];
  return {
    enqueue(item) {
      items.push(item);
    },
    drain() {
      return items.splice(0, items.length);
    },
  };
}

export interface ViewImageToolOptions {
  /**
   * 成功读到圈内图后写入。loop 构造时会换成自己的队列；
   * 单测传入收集器即可，不必起一整条 AgentLoop。
   */
  queue?: ViewImageQueue;
}

export function createViewImageTool(opts: ViewImageToolOptions = {}): Tool {
  const queue = opts.queue;

  return {
    name: "view_image",
    description:
      "Load an in-scope image into this turn's context so you can see the pixels yourself. " +
      "Call this only when you need pixel-level detail, layout comparison, or to check a specific region. " +
      "Do not use this for bulk captioning — prefer describe_image. " +
      "The image appears on the next request after this tool returns; this result is only an acknowledgement.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Image path relative to the working directory, or an absolute path inside the working directory or a configured extra root",
        },
      },
      required: ["path"],
    },
    permission: "ask",
    parallelSafe: true,
    // 与 describe_image 同纪律：grant 只绑 JSON 输入，不绑文件内容，不能用相同 path 偷换。
    approvalPolicy: { maxScope: "once" },

    async execute(input, ctx) {
      const { path: p } = input as { path?: unknown };
      if (typeof p !== "string" || p.length === 0) {
        return { content: 'Invalid input: expected {"path": string}.', isError: true };
      }

      const ext = extname(p).toLowerCase();
      const mediaType = MEDIA_TYPES[ext];
      if (!mediaType) {
        return {
          content: `Unsupported image type "${ext || "(none)"}". Supported: ${Object.keys(MEDIA_TYPES).join(", ")}. Convert the file first if you need it viewed.`,
          isError: true,
        };
      }

      let resolved: string;
      try {
        resolved = resolveReadable(ctx.workdir, ctx.readRoots, p);
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }

      let bytes: number;
      try {
        bytes = (await stat(resolved)).size;
      } catch {
        return { content: `Image not found: ${p}`, isError: true };
      }
      if (bytes > MAX_BYTES) {
        return {
          content: `Image too large: ${(bytes / 1_000_000).toFixed(1)}MB exceeds the ${(MAX_BYTES / 1_000_000).toFixed(1)}MB limit. Downscale or crop it first (e.g. with an image tool via bash), then call view_image again.`,
          isError: true,
        };
      }

      const data = (await readFile(resolved)).toString("base64");
      queue?.enqueue({ path: p, mediaType, data });
      return {
        content:
          `Loaded ${p} into this turn. You will see the image in the next request. ` +
          "Look at the pixels now; do not call view_image again on the same file unless it changed.",
      };
    },
  };
}

/**
 * 把待看的图并进末条 user（通常是刚写下的 tool_result），避免连续两条 user。
 * 只改副本，不原地改入参。
 */
export function appendViewImagesToMessages(
  messages: Anthropic.MessageParam[],
  images: readonly PendingViewImage[],
): Anthropic.MessageParam[] {
  if (images.length === 0) return messages;
  const extra: Anthropic.ContentBlockParam[] = images.flatMap((img) => [
    { type: "text" as const, text: `[view_image] ${img.path}` },
    {
      type: "image" as const,
      source: { type: "base64" as const, media_type: img.mediaType, data: img.data },
    },
  ]);
  const last = messages.at(-1);
  if (last?.role === "user") {
    const content: Anthropic.ContentBlockParam[] =
      typeof last.content === "string"
        ? [{ type: "text", text: last.content }]
        : [...last.content];
    return [...messages.slice(0, -1), { role: "user", content: [...content, ...extra] }];
  }
  return [...messages, { role: "user", content: extra }];
}

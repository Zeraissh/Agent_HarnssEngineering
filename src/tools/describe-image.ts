/**
 * describe_image —— 把"看图"这件事包成一个工具。
 *
 * 为什么是工具而不是别的两种做法：
 *
 * ① 不是"改协议让执行者自己看图"。执行者可能是 DeepSeek 这类纯文本模型，
 *    协议通了它也还是看不见。真正需要执行者自己看图的场景（如"照着这张
 *    截图改 CSS"，描述会丢掉像素级细节）只有一个正确解——换一个能看图的
 *    执行者模型，不是加工具。
 *
 * ② 不是 MCP。这是个纯函数式能力：给路径，返回描述。为它引入一个额外进程、
 *    一套连接生命周期，还要面对 C4 那条实测结论（MCP 回执 ok ≠ 生效，
 *    case-05 里五个工具四个回执 ok 但文档纹丝不动），是过度晋升。
 *
 * 按 P2 的晋升判据，它确实够格晋升为专用工具：需要安全边界（另一个端点、
 * 另一套密钥、以及把本地文件内容送出去这件事本身）。
 *
 * 视觉模型是第四个"角色模型"，与 verifier / planner 同一个机制。
 */
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient, Tool } from "../types.js";
import { resolveReadable } from "./fs-util.js";

/** Anthropic 图像块支持的媒体类型 */
const MEDIA_TYPES: Record<string, "image/jpeg" | "image/png" | "image/gif" | "image/webp"> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * base64 后的上限。API 侧约 5MB，这里按原始字节 3.5MB 拦（base64 膨胀 ~4/3）。
 * 提前拦住并说清怎么办，比让请求飞到端点再吃一个 400 便宜得多——
 * 而且错误信息是写给模型看的（P5），它能据此自己改道去压缩或裁剪。
 */
const MAX_BYTES = 3_500_000;

export interface DescribeImageOptions {
  /** 视觉模型的客户端（宿主装配，与 verifier / planner 同一个机制） */
  client: ModelClient;
  /** 仅用于错误信息与审计，不参与请求构造 */
  modelName?: string;
  /** 单次描述的输出上限 */
  maxTokens?: number;
}

/**
 * 工厂而不是常量：工具需要一个 ModelClient，而 ToolContext 里没有。
 * 与其为一个工具往 ToolContext 上挂模型客户端（污染所有工具的契约），
 * 不如让宿主在装配工具池时把依赖注进来——工具本来就是"值"。
 */
export function createDescribeImageTool(opts: DescribeImageOptions): Tool {
  const maxTokens = opts.maxTokens ?? 2048;

  return {
    name: "describe_image",
    description:
      "Look at an image file and get a text description of it. Call this whenever you need to know what an image contains — screenshots, diagrams, photos, rendered output, scanned documents. You cannot see images yourself; this tool asks a vision-capable model and returns its answer as text. Supply a specific question to get a focused answer instead of a generic caption.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Image path relative to the working directory (or an absolute path inside a read-only root)",
        },
        question: {
          type: "string",
          description:
            "What you need to know about the image. Be specific — 'what error is shown in this screenshot' beats 'describe this'. Omit for a general description.",
        },
      },
      required: ["path"],
    },
    permission: "ask",
    parallelSafe: true,

    async execute(input, ctx) {
      const { path: p, question } = input as { path?: unknown; question?: unknown };
      if (typeof p !== "string" || p.length === 0) {
        return { content: 'Invalid input: expected {"path": string}.', isError: true };
      }

      const ext = extname(p).toLowerCase();
      const mediaType = MEDIA_TYPES[ext];
      if (!mediaType) {
        return {
          content: `Unsupported image type "${ext || "(none)"}". Supported: ${Object.keys(MEDIA_TYPES).join(", ")}. Convert the file first if you need it described.`,
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
          content: `Image too large: ${(bytes / 1_000_000).toFixed(1)}MB exceeds the ${(MAX_BYTES / 1_000_000).toFixed(1)}MB limit. Downscale or crop it first (e.g. with an image tool via bash), then call describe_image again.`,
          isError: true,
        };
      }

      const data = (await readFile(resolved)).toString("base64");
      const prompt =
        typeof question === "string" && question.trim()
          ? question.trim()
          : "Describe this image in detail. Include any text that appears in it, verbatim.";

      const messages: Anthropic.MessageParam[] = [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data } },
            { type: "text", text: prompt },
          ],
        },
      ];

      try {
        const turn = await opts.client.send({
          system: [
            {
              type: "text",
              text: "You are a vision assistant. Answer only about what is actually visible in the image. If something is unreadable or ambiguous, say so explicitly rather than guessing — the caller acts on your answer and cannot see the image.",
            },
          ],
          messages,
          tools: [],
          maxTokens,
          effort: "low",
        });

        const text = turn.message.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("")
          .trim();

        if (!text) {
          return {
            content: `Vision model${opts.modelName ? ` (${opts.modelName})` : ""} returned no text for ${p}. It may not support image input.`,
            isError: true,
          };
        }
        return { content: text };
      } catch (err) {
        // 错误进上下文，写给模型看（P5）——它可以据此改道，而不是循环崩掉
        return {
          content: `Vision model${opts.modelName ? ` (${opts.modelName})` : ""} failed on ${p}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          isError: true,
        };
      }
    },
  };
}

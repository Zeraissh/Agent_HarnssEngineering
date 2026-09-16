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

/**
 * summary 档输出上限。类型 + 有无文字/报错/人物 + 一句话，百级即可。
 * 工厂 `maxTokens` 是 full 档上限；summary 取二者较小，避免宿主把 full 预算套到摘要上。
 */
export const DESCRIBE_IMAGE_SUMMARY_MAX_TOKENS = 128;

const DETAIL_VALUES = ["summary", "full"] as const;
export type DescribeImageDetail = (typeof DETAIL_VALUES)[number];

const SUMMARY_PROMPT =
  "Give a short label only, not a full description. Report: (1) type — screenshot, photo, diagram, document, or other; (2) whether it has readable text, an error/warning, or people (yes/no each); (3) one sentence of what it shows. Do not transcribe text verbatim or describe pixels, contrast, or layout.";

const FULL_PROMPT_DEFAULT =
  "Describe this image in detail. Include any text that appears in it, verbatim.";

export interface DescribeImageOptions {
  /** 视觉模型的客户端（宿主装配，与 verifier / planner 同一个机制） */
  client: ModelClient;
  /** 仅用于错误信息与审计，不参与请求构造 */
  modelName?: string;
  /** full 档单次描述的输出上限；summary 不走这个数 */
  maxTokens?: number;
}

function parseDetail(raw: unknown): DescribeImageDetail | { error: string } {
  if (raw === undefined || raw === null) return "summary";
  if (typeof raw !== "string") {
    return { error: 'Invalid input: "detail" must be "summary" or "full".' };
  }
  const v = raw.trim().toLowerCase();
  if (v === "") return "summary";
  if (v === "summary" || v === "full") return v;
  return {
    error: `Invalid detail "${raw}". Use "summary" or "full". Start with summary; use full only for pixels, contrast, or layout.`,
  };
}

/**
 * 工厂而不是常量：工具需要一个 ModelClient，而 ToolContext 里没有。
 * 与其为一个工具往 ToolContext 上挂模型客户端（污染所有工具的契约），
 * 不如让宿主在装配工具池时把依赖注进来——工具本来就是"值"。
 */
export function createDescribeImageTool(opts: DescribeImageOptions): Tool {
  const fullMaxTokens = opts.maxTokens ?? 2048;

  return {
    name: "describe_image",
    description:
      "Look at an image file and return a text description. You cannot see images yourself; this tool asks a vision-capable model. Always start with detail=summary (the default): cheap short labels — type, whether it has text/errors/people, and one sentence. That is enough for \"what is this\" and counts as a successful describe_image for the image-delivery completion gate. Use detail=full only when the question is about pixels, contrast, or layout. Full is the existing detailed behavior (focused answer, or a detailed caption with verbatim text). Do not use full for a first look.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Image path relative to the working directory, or an absolute path inside the working directory or a configured extra root",
        },
        question: {
          type: "string",
          description:
            "What you need to know about the image. Be specific — 'what error is shown in this screenshot' beats 'describe this'. Omit for a general description. With detail=summary the question is answered only at the short-label level.",
        },
        detail: {
          type: "string",
          enum: [...DETAIL_VALUES],
          description:
            'summary (default): short labels — type, text/error/people, one sentence. full: existing detailed behavior. Start with summary; use full only when the question is about pixels, contrast, or layout.',
        },
      },
      required: ["path"],
    },
    permission: "ask",
    parallelSafe: true,
    // 同一路径的文件内容可能在两次调用间变化。grant 目前只绑定 JSON 输入，尚未
    // 绑定文件内容摘要；因此视觉上传必须逐次审批，不能用相同 path 偷换资源。
    approvalPolicy: { maxScope: "once" },

    async execute(input, ctx) {
      const { path: p, question, detail: rawDetail } = input as {
        path?: unknown;
        question?: unknown;
        detail?: unknown;
      };
      if (typeof p !== "string" || p.length === 0) {
        return { content: 'Invalid input: expected {"path": string}.', isError: true };
      }
      const detail = parseDetail(rawDetail);
      if (typeof detail !== "string") {
        return { content: detail.error, isError: true };
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
      const asked = typeof question === "string" && question.trim() ? question.trim() : "";
      const prompt =
        detail === "summary"
          ? asked
            ? `${SUMMARY_PROMPT} The caller asked: ${asked} Answer only at this short-label level.`
            : SUMMARY_PROMPT
          : asked || FULL_PROMPT_DEFAULT;
      const maxTokens =
        detail === "summary" ? Math.min(DESCRIBE_IMAGE_SUMMARY_MAX_TOKENS, fullMaxTokens) : fullMaxTokens;

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

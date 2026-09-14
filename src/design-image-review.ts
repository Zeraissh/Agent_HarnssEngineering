/**
 * 设计交付的识图门：路径存在 ≠ 看过图。
 *
 * 那次杂志风幻灯把 picsum 随机风景按文件名当成「水滴 / 智子」，
 * finish_task 只核路径。本模块只认两件可程序化事实：
 * ① 完成声明是否在声称交了配图；② 本段是否成功调用过 describe_image。
 *
 * 识图角色只在执行者自己看不见图时才引用——执行者能看就走执行模型。
 */
import { createDescribeImageTool } from "./tools/describe-image.js";
import type { ModelClient, TaskCompletion, Tool } from "./types.js";

export type DescribeImageBacking = "executor" | "vision-role" | "none";

/** 声称交了照片/配图，而不是「图鉴」「图表」这类字。 */
const IMAGE_CLAIM =
  /配图|大图|封面图|刊头图|插图|照片|摄影|本地图|images\/|\.(png|jpe?g|webp|gif)\b/i;

export function normalizeImagePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").trim().toLowerCase();
}

export function claimsDeliveredImages(
  completion: Pick<TaskCompletion, "summary" | "artifacts" | "verification">,
): boolean {
  return IMAGE_CLAIM.test(
    [completion.summary, ...completion.artifacts, ...completion.verification].join("\n"),
  );
}

/** completed 且声称有图，但本段一次识图都没有 → 不许收尾。 */
export function unreviewedImageCompletion(
  completion: Pick<TaskCompletion, "status" | "summary" | "artifacts" | "verification">,
  describedCount: number,
): boolean {
  return completion.status === "completed" && claimsDeliveredImages(completion) && describedCount === 0;
}

/** 名称上就看得出能看图的模型。宁可不认，也不要把纯文本 DeepSeek 当成 VL。 */
export function nameSuggestsVision(modelName: string): boolean {
  const n = String(modelName ?? "").trim().toLowerCase();
  if (!n) return false;
  if (/(?:^|[^a-z])vision(?:[^a-z]|$)|-vl(?:-|$)|(?:^|[^a-z])vl-/.test(n)) return true;
  if (n.startsWith("claude-")) return true;
  if (n.startsWith("gpt-4o") || n.startsWith("gpt-4.1") || n.startsWith("gpt-5")) return true;
  return false;
}

/**
 * 执行者会不会看图。探针说了算；没探过才看名字。
 * 注入的假模型名称常是默认 claude-*，不能据此当真。
 */
export function resolveExecutorVisionSupport(opts: {
  modelName: string;
  probed?: boolean | null;
  injectedClient?: boolean;
}): boolean {
  if (opts.probed === true) return true;
  if (opts.probed === false) return false;
  if (opts.injectedClient) return false;
  return nameSuggestsVision(opts.modelName);
}

export function resolveDescribeImageBacking(input: {
  executorSupportsVision: boolean;
  visionRoleConfigured: boolean;
  visionRoleSupportsVision?: boolean | null;
}): DescribeImageBacking {
  if (input.executorSupportsVision) return "executor";
  if (!input.visionRoleConfigured) return "none";
  if (input.visionRoleSupportsVision === false) return "none";
  return "vision-role";
}

export function assembleDescribeImageTool(opts: {
  backing: DescribeImageBacking;
  executor: { client: ModelClient; modelName: string };
  vision?: { client: ModelClient; modelName: string };
}): Tool | undefined {
  if (opts.backing === "executor") {
    return createDescribeImageTool(opts.executor);
  }
  if (opts.backing === "vision-role" && opts.vision) {
    return createDescribeImageTool(opts.vision);
  }
  return undefined;
}

export function wrapDescribeImageForReview(tool: Tool, described: Set<string>): Tool {
  return {
    ...tool,
    execute: async (input, ctx) => {
      const result = await tool.execute(input, ctx);
      const path =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as { path?: unknown }).path
          : undefined;
      if (!result.isError && typeof path === "string" && path.trim()) {
        described.add(normalizeImagePath(path));
      }
      return result;
    },
  };
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "../types.js";
import { resolveInWorkdir } from "./fs-util.js";

export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Create or overwrite a UTF-8 text file inside the working directory. Call this when the task requires producing or updating a file. Parent directories are created automatically. Overwrites existing content — read the file first if you need to preserve parts of it.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the working directory" },
      content: { type: "string", description: "Full file content to write" },
    },
    required: ["path", "content"],
  },
  // 写盘是可回滚性最差的内置动作，默认走审批门
  permission: "ask",
  parallelSafe: false,
  // 写入属于副作用操作；重复同一 payload 也不能由客户端扩大成常驻授权。
  approvalPolicy: { maxScope: "once" },
  async execute(input, ctx) {
    const { path: p, content } = input as { path: string; content: string };
    if (typeof p !== "string" || typeof content !== "string") {
      return { content: 'Invalid input: expected {"path": string, "content": string}.', isError: true };
    }
    const resolved = resolveInWorkdir(ctx.workdir, p);
    await mkdir(path.dirname(resolved), { recursive: true });
    // mkdir 可能补齐原先不存在的父目录；在真正写文件前重新 realpath 校验一次。
    // 这会抓住创建过程中出现的 symlink/junction，但 Node 的跨平台 fs API 没有
    // openat-style、逐路径分量的原子圈禁，校验与 writeFile 间仍存在很窄的 TOCTOU。
    const revalidated = resolveInWorkdir(ctx.workdir, p);
    const bytes = Buffer.byteLength(content, "utf8");
    // SAFE-06：内容级幂等——写后未 committed 的崩溃重入时，同内容不二次覆盖。
    try {
      const existing = await readFile(revalidated, "utf8");
      if (existing === content) {
        return { content: `Wrote ${bytes} bytes to ${p} (unchanged)` };
      }
    } catch {
      // 不存在或不可读 → 正常写入
    }
    await writeFile(revalidated, content, "utf8");
    return { content: `Wrote ${bytes} bytes to ${p}` };
  },
};

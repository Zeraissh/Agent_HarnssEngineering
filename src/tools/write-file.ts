import { mkdir, writeFile } from "node:fs/promises";
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
  async execute(input, ctx) {
    const { path: p, content } = input as { path: string; content: string };
    if (typeof p !== "string" || typeof content !== "string") {
      return { content: 'Invalid input: expected {"path": string, "content": string}.', isError: true };
    }
    const resolved = resolveInWorkdir(ctx.workdir, p);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, content, "utf8");
    return { content: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${p}` };
  },
};

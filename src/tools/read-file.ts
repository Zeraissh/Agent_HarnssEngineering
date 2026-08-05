import { readFile } from "node:fs/promises";
import type { Tool } from "../types.js";
import { resolveReadable, truncate } from "./fs-util.js";

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a UTF-8 text file inside the working directory (or one of the configured read-only roots, using an absolute path). Call this whenever you need the contents of a specific file before analyzing or modifying it. Input path is relative to the working directory.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the working directory" },
    },
    required: ["path"],
  },
  permission: "auto",
  parallelSafe: true,
  async execute(input, ctx) {
    const { path: p } = input as { path: string };
    if (typeof p !== "string" || p.length === 0) {
      return { content: 'Invalid input: expected {"path": string}.', isError: true };
    }
    const resolved = resolveReadable(ctx.workdir, ctx.readRoots, p);
    const text = await readFile(resolved, "utf8");
    return { content: truncate(text) };
  },
};

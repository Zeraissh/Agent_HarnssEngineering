import { readFile } from "node:fs/promises";
import type { Tool } from "../types.js";
import { credentialLikeName, resolveReadable, truncate } from "./fs-util.js";

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a UTF-8 text file inside the working directory (or one of the configured read-only roots, using an absolute path). Call this whenever you need the contents of a specific file before analyzing or modifying it. Input path is relative to the working directory. " +
    "For large files, pass offset (1-based starting line) and/or limit (max lines) to read a slice.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the working directory" },
      // 案例 #9 第四跑催生：verifier 读大 s-expression 文件时幻觉了这个参数，
      // 被失败开放校验静默放行、返回文件头，还把"没生效"写进了裁决。
      // 模型会自发想要的参数,是真需求的最诚实信号——补上,而不是让幻觉继续撞墙。
      offset: { type: "number", description: "1-based line number to start reading from (optional)" },
      limit: { type: "number", description: "Maximum number of lines to return (optional)" },
    },
    required: ["path"],
  },
  permission: "auto",
  parallelSafe: true,
  async execute(input, ctx) {
    const { path: p, offset, limit } = input as { path: string; offset?: number; limit?: number };
    if (typeof p !== "string" || p.length === 0) {
      return { content: 'Invalid input: expected {"path": string}.', isError: true };
    }
    // 凭据文件对无审批的 read_file 关门（fail-closed），报错写给模型看：说清为什么、指出改道
    if (credentialLikeName(p)) {
      return {
        content:
          `Reading credential-style files is blocked for read_file: "${p}" looks like key material ` +
          "(.env*, .npmrc, .netrc, id_rsa*, *.pem). This tool runs without approval, so its reads are " +
          "invisible to the operator and would land in plaintext run archives. If the task genuinely " +
          "needs values from this file, ask the operator to provide them, or read it via the " +
          "approval-gated bash tool so a human sees exactly what is accessed.",
        isError: true,
      };
    }
    const resolved = resolveReadable(ctx.workdir, ctx.readRoots, p);
    const text = await readFile(resolved, "utf8");
    if (offset === undefined && limit === undefined) return { content: truncate(text) };

    // 切片语义：offset 越界给明确报错（静默空串会被当成"文件到头了"）
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, Math.floor(offset ?? 1));
    if (start > lines.length) {
      return { content: `offset ${start} exceeds file length (${lines.length} lines).`, isError: true };
    }
    const count = limit !== undefined ? Math.max(1, Math.floor(limit)) : lines.length;
    const slice = lines.slice(start - 1, start - 1 + count);
    const header = `[lines ${start}-${start - 1 + slice.length} of ${lines.length}]\n`;
    return { content: header + truncate(slice.join("\n")) };
  },
};

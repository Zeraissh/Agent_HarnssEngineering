/**
 * L2 — `grep`：在工作目录里按正则搜内容。
 *
 * **实现选型：纯 Node，不依赖 ripgrep。** 代价说清楚：rg 在大仓上快一到两个
 * 数量级（它有并行遍历、SIMD 匹配、.gitignore 感知）；这里是单线程逐文件
 * `readFile` + `RegExp.exec`，几万个文件的树上会明显慢。换来的是**这个工具在任何
 * 宿主上都在场**——本仓两次栽在"外部命令行工具的可用性靠父进程运气"上
 * （cmd 冒充 bash、Git Bash 丢 coreutils PATH），工具运行时质量是模型表现的地板，
 * 一个偶尔不存在的快工具不如一个永远在的慢工具。有界（文件数/单文件大小/输出条数）
 * 是把慢的最坏情况钉住的手段。
 *
 * 与 `bash grep` 的分工：本工具只读、不进审批门、跨平台同语义；需要管道/字段处理
 * 的复杂取证仍走 bash。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "../types.js";
import { credentialLikeName } from "./fs-util.js";
import { DEFAULT_IGNORED_DIRS, matchesGlob, resolveScanRoot, scanFiles, toPosix } from "./fs-scan.js";

export const GREP_DEFAULT_LIMIT = 100;
export const GREP_MAX_LIMIT = 500;
/** 单个文件的读入上限：超过就跳过并计数。1MB 之外的多半是产物/数据，不是要搜的源码 */
export const GREP_MAX_FILE_BYTES = 1_000_000;
/** 单行回填上限——一行 minified JS 能顶掉整个结果预算 */
const MAX_LINE_CHARS = 400;

export const OUTPUT_MODES = ["content", "files_with_matches", "count"] as const;
export type GrepOutputMode = (typeof OUTPUT_MODES)[number];

function clampLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return `${line.slice(0, MAX_LINE_CHARS)}…[+${line.length - MAX_LINE_CHARS} chars]`;
}

/** NUL 字节 = 二进制，跳过。只看前 8KB，够用且不为此再读一遍文件 */
function looksBinary(text: string): boolean {
  return text.slice(0, 8192).includes("\u0000");
}

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search file contents with a JavaScript regular expression inside the working directory (or a configured read-only root). " +
    "Prefer this over shell `grep`/`findstr`: it needs no approval, no shell, and behaves identically on every platform. " +
    "Use output_mode='content' (default) to see matching lines with line numbers, 'files_with_matches' to just locate files, " +
    "'count' for per-file match counts. Narrow the search with `path` and/or `glob` before raising `limit`. " +
    `\`${DEFAULT_IGNORED_DIRS.join("`/`")}\`, binary files, files over ${GREP_MAX_FILE_BYTES} bytes and credential-style files (.env*, *.pem, …) are skipped.`,
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "JavaScript regular expression, e.g. \"export function \\\\w+\" (remember to escape backslashes in JSON)",
      },
      path: {
        type: "string",
        description:
          "File or directory to search, relative to the working directory (default: the working directory). " +
          "An absolute path is allowed only inside a configured read-only root.",
      },
      glob: {
        type: "string",
        description: 'Only search files whose relative path matches this glob, e.g. "**/*.ts" or "*.{md,txt}"',
      },
      "-i": { type: "boolean", description: "Case-insensitive match (default false)" },
      "-A": { type: "number", description: "Lines of context after each match (content mode only)" },
      "-B": { type: "number", description: "Lines of context before each match (content mode only)" },
      "-C": { type: "number", description: "Lines of context before and after each match (content mode only)" },
      output_mode: {
        type: "string",
        enum: [...OUTPUT_MODES],
        description: "content (default) | files_with_matches | count",
      },
      limit: {
        type: "number",
        description: `Maximum matches (content) or files (other modes) to return (default ${GREP_DEFAULT_LIMIT}, hard cap ${GREP_MAX_LIMIT}). "head_limit" is accepted as an alias.`,
      },
    },
    required: ["pattern"],
  },
  permission: "auto",
  parallelSafe: true,
  async execute(input, ctx) {
    const raw = input as Record<string, unknown>;
    const pattern = raw.pattern;
    const dir = raw.path;
    const globFilter = raw.glob;
    const mode = (raw.output_mode as GrepOutputMode | undefined) ?? "content";

    if (typeof pattern !== "string" || pattern.length === 0) {
      return { content: 'Invalid input: expected {"pattern": string}.', isError: true };
    }
    if (dir !== undefined && typeof dir !== "string") {
      return { content: 'Invalid input: "path" must be a string when provided.', isError: true };
    }
    if (globFilter !== undefined && typeof globFilter !== "string") {
      return { content: 'Invalid input: "glob" must be a string when provided.', isError: true };
    }
    if (!OUTPUT_MODES.includes(mode)) {
      return {
        content: `Invalid output_mode ${JSON.stringify(mode)}. Expected one of: ${OUTPUT_MODES.join(", ")}.`,
        isError: true,
      };
    }
    // 显式指名凭据文件与 read_file 同一条门（fail-closed）：grep 也是无审批的读
    if (typeof dir === "string" && credentialLikeName(dir)) {
      return {
        content:
          `Searching credential-style files is blocked for grep: "${dir}" looks like key material ` +
          "(.env*, .npmrc, .netrc, id_rsa*, *.pem). This tool runs without approval, so its reads are " +
          "invisible to the operator and matched lines would land in plaintext run archives. Ask the operator " +
          "for the values, or use the approval-gated bash tool so a human sees exactly what is accessed.",
        isError: true,
      };
    }

    let regex: RegExp;
    try {
      const flags = raw["-i"] === true ? "gi" : "g";
      regex = new RegExp(pattern, flags);
    } catch (err) {
      return {
        content:
          `Invalid regular expression ${JSON.stringify(pattern)}: ${(err as Error).message}. ` +
          "This tool uses JavaScript regex syntax; escape backslashes once for JSON.",
        isError: true,
      };
    }

    const num = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : undefined;
    const ctxBoth = num(raw["-C"]);
    const after = num(raw["-A"]) ?? ctxBoth ?? 0;
    const before = num(raw["-B"]) ?? ctxBoth ?? 0;
    const cap = Math.min(GREP_MAX_LIMIT, Math.max(1, num(raw.limit) ?? num(raw.head_limit) ?? GREP_DEFAULT_LIMIT));

    let root: string;
    try {
      root = resolveScanRoot(ctx.workdir, ctx.readRoots, dir);
    } catch (err) {
      return { content: (err as Error).message, isError: true };
    }

    let scan;
    try {
      scan = await scanFiles({
        root,
        match: (rel) =>
          !credentialLikeName(rel) && (typeof globFilter !== "string" || matchesGlob(rel, globFilter)),
      });
    } catch (err) {
      return { content: `grep failed: ${(err as Error).message}`, isError: true };
    }

    const lines: string[] = [];
    const perFile: { file: string; count: number }[] = [];
    let totalMatches = 0;
    let emitted = 0;
    let truncated = false;
    let skippedBig = 0;
    let skippedBinary = 0;

    for (const rel of scan.files) {
      if (truncated) break;
      let text: string;
      try {
        const buf = await readFile(path.join(scan.base, rel));
        if (buf.byteLength > GREP_MAX_FILE_BYTES) {
          skippedBig += 1;
          continue;
        }
        text = buf.toString("utf8");
      } catch {
        continue;
      }
      if (looksBinary(text)) {
        skippedBinary += 1;
        continue;
      }
      const fileLines = text.split(/\r?\n/);
      let fileCount = 0;
      for (let i = 0; i < fileLines.length; i++) {
        regex.lastIndex = 0;
        if (!regex.test(fileLines[i]!)) continue;
        fileCount += 1;
        totalMatches += 1;
        if (mode !== "content") continue;
        if (emitted >= cap) {
          truncated = true;
          break;
        }
        for (let c = Math.max(0, i - before); c < i; c++) {
          lines.push(`${rel}-${c + 1}-${clampLine(fileLines[c]!)}`);
        }
        lines.push(`${rel}:${i + 1}:${clampLine(fileLines[i]!)}`);
        for (let c = i + 1; c <= Math.min(fileLines.length - 1, i + after); c++) {
          lines.push(`${rel}-${c + 1}-${clampLine(fileLines[c]!)}`);
        }
        emitted += 1;
      }
      if (fileCount > 0) perFile.push({ file: rel, count: fileCount });
      if (mode !== "content" && perFile.length >= cap) {
        truncated = true;
        break;
      }
    }

    const where = dir ? ` under ${toPosix(dir)}` : "";
    const scope = `${JSON.stringify(pattern)}${where}${typeof globFilter === "string" ? ` (glob ${JSON.stringify(globFilter)})` : ""}`;
    const notes: string[] = [];
    if (skippedBig > 0) notes.push(`${skippedBig} file(s) skipped (> ${GREP_MAX_FILE_BYTES} bytes)`);
    if (skippedBinary > 0) notes.push(`${skippedBinary} binary file(s) skipped`);
    if (scan.scanTruncated) {
      notes.push(`directory scan stopped after ${scan.scanned} entries — this search may be incomplete`);
    }
    const noteLine = notes.length ? `\n...[${notes.join("; ")}]` : "";

    if (totalMatches === 0) {
      return {
        content:
          `No matches for ${scope} in ${scan.files.length} searched file(s).${noteLine}` +
          "\nIf you expected matches, check the regex escaping, widen `glob`, or search a different `path`.",
      };
    }

    if (mode === "files_with_matches") {
      const shown = perFile.slice(0, cap).map((f) => f.file);
      const more = truncated ? `\n...[more files not shown: limit=${cap}]` : "";
      return {
        content: `${perFile.length} file(s) contain ${scope}:\n${shown.join("\n")}${more}${noteLine}`,
      };
    }

    if (mode === "count") {
      const shown = perFile.slice(0, cap).map((f) => `${f.file}:${f.count}`);
      const more = truncated ? `\n...[more files not shown: limit=${cap}]` : "";
      return {
        content: `${totalMatches} match(es) for ${scope} across ${perFile.length} file(s):\n${shown.join("\n")}${more}${noteLine}`,
      };
    }

    const more = truncated
      ? `\n...[truncated: showed ${emitted} of at least ${totalMatches} matching lines (limit=${cap}). Narrow the search or raise limit — do NOT assume the rest are absent.]`
      : "";
    return {
      content:
        `${truncated ? "at least " : ""}${totalMatches} matching line(s) for ${scope}:\n` +
        `${lines.join("\n")}${more}${noteLine}`,
    };
  },
};

/**
 * L2 — `glob`：按文件名模式找文件。
 *
 * 为什么值得做成内置而不是让模型 `bash find`：`find` 的可用性取决于宿主上有没有
 * 一个像样的 shell（本仓为此栽过两次：cmd 冒充 bash、Git Bash 丢 coreutils PATH），
 * 而且它走审批门——一次"我先看看有哪些文件"要停下来等人。列目录是只读动作，
 * 不该有这个代价。工具运行时质量是模型表现的地板（docs/05-findings.md）。
 */
import type { Tool } from "../types.js";
import { DEFAULT_IGNORED_DIRS, globToRegExp, resolveScanRoot, scanFiles, toPosix } from "./fs-scan.js";

/** 返回条数缺省上限。超过就截断并**说出来**——静默截断会被当成"就这么多" */
export const GLOB_DEFAULT_LIMIT = 200;
export const GLOB_MAX_LIMIT = 1000;

export const globTool: Tool = {
  name: "glob",
  description:
    "Find files by name pattern inside the working directory (or a configured read-only root). " +
    "Prefer this over shell `find`/`ls`: it needs no approval, no shell, and returns a stable sorted list. " +
    "Pattern syntax: `**` matches any number of directories, `*` matches within one path segment, `?` one character, " +
    "`{a,b}` alternates, `[a-z]` character classes. A pattern without `/` is matched at any depth (`*.ts` = `**/*.ts`). " +
    "Matching is case-sensitive on every platform. Results are relative POSIX paths sorted lexicographically (not by mtime). " +
    `\`${DEFAULT_IGNORED_DIRS.join("`/`")}\` are skipped unless include_ignored is true.`,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: 'Glob pattern, e.g. "**/*.ts" or "src/**/{a,b}.json"' },
      path: {
        type: "string",
        description:
          "Directory to search in, relative to the working directory (default: the working directory itself). " +
          "An absolute path is allowed only inside a configured read-only root.",
      },
      limit: {
        type: "number",
        description: `Maximum number of paths to return (default ${GLOB_DEFAULT_LIMIT}, hard cap ${GLOB_MAX_LIMIT})`,
      },
      include_ignored: {
        type: "boolean",
        description: `Also descend into ${DEFAULT_IGNORED_DIRS.join(" / ")} (default false)`,
      },
    },
    required: ["pattern"],
  },
  // 只读、无副作用：不进审批门。这正是它相对 `bash find` 的价值所在。
  permission: "auto",
  parallelSafe: true,
  async execute(input, ctx) {
    const {
      pattern,
      path: dir,
      limit,
      include_ignored: includeIgnored,
    } = input as { pattern?: unknown; path?: unknown; limit?: unknown; include_ignored?: unknown };
    if (typeof pattern !== "string" || pattern.length === 0) {
      return { content: 'Invalid input: expected {"pattern": string}.', isError: true };
    }
    if (dir !== undefined && typeof dir !== "string") {
      return { content: 'Invalid input: "path" must be a string when provided.', isError: true };
    }

    let root: string;
    try {
      root = resolveScanRoot(ctx.workdir, ctx.readRoots, dir);
    } catch (err) {
      return { content: (err as Error).message, isError: true };
    }

    let regex: RegExp;
    try {
      regex = globToRegExp(pattern);
    } catch (err) {
      return {
        content: `Invalid glob pattern ${JSON.stringify(pattern)}: ${(err as Error).message}`,
        isError: true,
      };
    }

    const cap = Math.min(
      GLOB_MAX_LIMIT,
      Math.max(1, typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : GLOB_DEFAULT_LIMIT),
    );

    let scan;
    try {
      scan = await scanFiles({
        root,
        ...(includeIgnored === true ? { includeIgnored: true } : {}),
        match: (rel) => regex.test(rel),
      });
    } catch (err) {
      return { content: `glob failed: ${(err as Error).message}`, isError: true };
    }

    const where = dir ? ` under ${toPosix(dir)}` : "";
    if (scan.files.length === 0) {
      const skipped = scan.skippedDirs.length
        ? ` Skipped ${scan.skippedDirs.length} ignored director${scan.skippedDirs.length === 1 ? "y" : "ies"} (${DEFAULT_IGNORED_DIRS.join(", ")}); pass include_ignored=true to search them.`
        : "";
      // 空结果不是错误——但必须让模型看出"确实搜了、确实没有"，而不是以为工具没跑
      return {
        content:
          `No files match ${JSON.stringify(pattern)}${where} (scanned ${scan.scanned} entries).${skipped}`,
      };
    }

    const shown = scan.files.slice(0, cap);
    const header = `${scan.files.length} file(s) match ${JSON.stringify(pattern)}${where}, sorted by path:`;
    const notes: string[] = [];
    if (shown.length < scan.files.length) {
      notes.push(
        `...[${scan.files.length - shown.length} more paths not shown: limit=${cap}. Narrow the pattern or raise limit.]`,
      );
    }
    if (scan.scanTruncated) {
      notes.push(
        `...[directory scan stopped after ${scan.scanned} entries; this listing may be incomplete. Search a subdirectory via "path".]`,
      );
    }
    return { content: [header, ...shown, ...notes].join("\n") };
  },
};

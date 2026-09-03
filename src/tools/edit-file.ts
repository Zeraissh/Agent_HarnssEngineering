/**
 * L2 — `edit_file`：按 str_replace 语义做**局部**修改。
 *
 * 为什么建它：运行台账的工具直方图里，执行者调用过压根不存在的 `edit_file` ×1、
 * `replace_in_file` ×3。模型自发想要的工具是真需求最诚实的信号（同 `read_file` 的
 * `offset/limit`——那也是从幻觉里长出来的）。在它不存在的时代，改一行的代价是
 * `read_file` 全文 + `write_file` 全文重写：token 与"抄漏一段"的风险都按文件大小走，
 * 而案例 #11 已经实测过文本模型结构性重写 8000 行文件三发同形失败。
 *
 * ================= 字节保真是硬约束 =================
 * 不做行尾归一、不补结尾换行、不 trim。做的就是 `String.replace` 那一件事：
 * CRLF 文件保持 CRLF，无结尾换行的文件仍然无结尾换行，BOM 原样留着。本仓被字节级
 * 判据咬过多次（`"11" \r\n`、PowerShell 写 BOM 崩 tsx），一个"顺手帮你规范化"的
 * 编辑工具会把这类缺陷制造成日常。
 *
 * ================= 唯一性由宿主执行，不靠模型自觉 =================
 * 0 命中 / 多命中都必须是 `is_error`，且报错要**可操作**（说清命中几次、下一步怎么办）。
 * 一个"多命中就改第一个"的编辑工具会静默改错地方——那是最难查的一类缺陷。
 *
 * ================= 崩溃重入 =================
 * SAFE-06 给它 `idempotent_retry`。第一层是事务层：committed 之后同 key 直接跳过。
 * 第二层是工具语义：若 `old_string` 在第一次写入后**整段消失**，裸重放只会 0 命中报错。
 * 注意：`new_string` 仍含 `old_string` 作子串时（如 `1`→`1 + 1`）第二层不成立——
 * 这时只能靠事务层，不能靠"字符串天然幂等"的幻觉。
 */
import { readFile, writeFile } from "node:fs/promises";
import type { Tool } from "../types.js";
import { credentialLikeName, resolveInWorkdir } from "./fs-util.js";

export const EDIT_FILE_TOOL_NAME = "edit_file";

/**
 * 回填 diff 的上限：hunk 数与总字符数。编辑工具的回执不该比文件本身还贵。
 * 导出是为了让行为锁引用同一个数——写死的计数一定会过期（findings 45）。
 */
export const MAX_DIFF_HUNKS = 5;
export const MAX_DIFF_CHARS = 4000;
/** 每个 hunk 的上下文行数（与 `diff -u` 缺省一致） */
const DIFF_CONTEXT = 3;

/**
 * 核查者 / planner 的工具面必须剔掉它——与 `withoutAskUser` 同一条硬执行点（P6）。
 *
 * 为什么对 `edit_file` 做剥离，而 `write_file` 至今只靠审批门自动 deny：那两条防线
 * 强度不同，但对 `write_file` 改现状会动到长期行为（核查者被 deny 时看到的提示、
 * 领域包核查指令里对它的引用），不在 A1 的测量范围内。新工具没有历史包袱，
 * 可以直接选最强的那条：**根本不出现在只读角色的工具面上**——被 deny 要烧掉一轮，
 * 不在场则连触发面都没有。这条不对称是自觉的选择，不是遗漏。
 */
export function withoutEditFile<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((t) => t.name !== EDIT_FILE_TOOL_NAME);
}

function splitLines(text: string): string[] {
  return text.split("\n");
}

/** 偏移量所在的 0-based 行号 */
function lineOfOffset(text: string, offset: number): number {
  let n = 0;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

function allOccurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return out;
    out.push(at);
    from = at + needle.length;
  }
}

/**
 * 逐处替换生成 unified diff。
 *
 * 不做通用 LCS：本工具的改动形态是已知的——每一处都是同一段 `old_string` 换成
 * `new_string`，位置在替换前就算得出来。直接按这些位置出 hunk 既精确又便宜，
 * 而且**不会**像通用差分那样把无关的相邻行卷进来。
 */
export function renderEditDiff(
  relPath: string,
  before: string,
  after: string,
  offsets: number[],
  oldLen: number,
  newLen: number,
): string {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const delta = newLen - oldLen;
  const lines: string[] = [`--- a/${relPath}`, `+++ b/${relPath}`];
  const shown = offsets.slice(0, MAX_DIFF_HUNKS);

  shown.forEach((pos, i) => {
    const afterPos = pos + i * delta;
    const bStart = lineOfOffset(before, pos);
    const bEnd = lineOfOffset(before, pos + oldLen);
    const aStart = lineOfOffset(after, afterPos);
    const aEnd = lineOfOffset(after, afterPos + newLen);
    const ctxStart = Math.max(0, bStart - DIFF_CONTEXT);
    const ctxEndBefore = Math.min(beforeLines.length - 1, bEnd + DIFF_CONTEXT);
    const ctxEndAfter = Math.min(afterLines.length - 1, aEnd + DIFF_CONTEXT);

    const oldCount = ctxEndBefore - ctxStart + 1;
    const newCount = ctxEndAfter - Math.max(0, aStart - DIFF_CONTEXT) + 1;
    lines.push(`@@ -${ctxStart + 1},${oldCount} +${Math.max(0, aStart - DIFF_CONTEXT) + 1},${newCount} @@`);
    for (let l = ctxStart; l < bStart; l++) lines.push(` ${beforeLines[l]}`);
    for (let l = bStart; l <= bEnd; l++) lines.push(`-${beforeLines[l]}`);
    for (let l = aStart; l <= aEnd; l++) lines.push(`+${afterLines[l]}`);
    for (let l = bEnd + 1; l <= ctxEndBefore; l++) lines.push(` ${beforeLines[l]}`);
  });

  if (offsets.length > shown.length) {
    lines.push(`...[${offsets.length - shown.length} more replacement(s) not shown]`);
  }
  const text = lines.join("\n");
  if (text.length <= MAX_DIFF_CHARS) return text;
  return `${text.slice(0, MAX_DIFF_CHARS)}\n...[diff truncated at ${MAX_DIFF_CHARS} chars; re-read the file if you need the full result]`;
}

export const editFileTool: Tool = {
  name: EDIT_FILE_TOOL_NAME,
  description:
    "Replace an exact string inside an existing file. PREFER THIS OVER write_file whenever you are changing part of a file " +
    "that already exists — it costs a fraction of the tokens and cannot accidentally drop the parts you did not mean to touch. " +
    "old_string must match the file byte for byte (including indentation and line endings) and must be unique: include enough " +
    "surrounding lines to disambiguate, or set replace_all to change every occurrence. Nothing is normalized — line endings, a " +
    "missing final newline and BOM are preserved exactly. Use write_file only to create a new file or to rewrite one wholesale.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the working directory. The file must already exist." },
      old_string: {
        type: "string",
        description: "Exact text to find, copied verbatim from the file (indentation included). Must be unique unless replace_all is true.",
      },
      new_string: { type: "string", description: "Text to put in its place (may be empty to delete)" },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence instead of requiring a unique match (default false)",
      },
    },
    required: ["path", "old_string", "new_string"],
  },
  // 与 write_file 同一档：改盘是可回滚性最差的动作，走审批门
  permission: "ask",
  parallelSafe: false,
  // 同一 payload 也不能被客户端扩大成常驻授权
  approvalPolicy: { maxScope: "once" },
  async execute(input, ctx) {
    const {
      path: p,
      old_string: oldString,
      new_string: newString,
      replace_all: replaceAll,
    } = input as { path?: unknown; old_string?: unknown; new_string?: unknown; replace_all?: unknown };

    if (typeof p !== "string" || typeof oldString !== "string" || typeof newString !== "string") {
      return {
        content: 'Invalid input: expected {"path": string, "old_string": string, "new_string": string}.',
        isError: true,
      };
    }
    /**
     * `replace_all` 不是布尔就拒。schema 声明过 ≠ 端点执行过（P6，§2.2 的定论），
     * 而这个参数一旦被静默读成 false，模型自以为在全量替换、实际只会撞上
     * "不唯一" 报错——报错方向虽然安全，但它掩盖了真正的输入缺陷。
     */
    if (replaceAll !== undefined && typeof replaceAll !== "boolean") {
      return {
        content: `Invalid input: replace_all must be a boolean, got ${typeof replaceAll}. Omit it (default false) or pass true.`,
        isError: true,
      };
    }
    if (oldString === "") {
      return {
        content:
          "old_string must not be empty: an empty match has no location. Copy the exact text you want to replace from the file.",
        isError: true,
      };
    }
    if (oldString === newString) {
      return {
        content: "old_string and new_string are identical — this edit would change nothing. Check which text you meant to write.",
        isError: true,
      };
    }
    /**
     * 凭据文件同 read_file 的 fail-closed。理由与只读侧略有不同但更强：本工具的回执
     * 里带 diff——修改一次 .env 就等于把密钥上下文原样写进正史与运行归档。
     */
    if (credentialLikeName(p)) {
      return {
        content:
          `Editing credential-style files is blocked for edit_file: "${p}" looks like key material ` +
          "(.env*, .npmrc, .netrc, id_rsa*, *.pem). This tool returns a diff, so the surrounding secret material would land " +
          "in plaintext run archives. Ask the operator to change it, or use the approval-gated bash tool so a human sees exactly what happens.",
        isError: true,
      };
    }

    const resolved = resolveInWorkdir(ctx.workdir, p);

    let before: string;
    try {
      before = await readFile(resolved, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {
          content: `File not found: ${p}. edit_file only modifies files that already exist — use write_file to create it.`,
          isError: true,
        };
      }
      return { content: `Cannot read ${p}: ${(err as Error).message}`, isError: true };
    }

    const offsets = allOccurrences(before, oldString);
    if (offsets.length === 0) {
      // CRLF 是最常见的"看起来一样但不相等"，明确点名——否则模型会反复递交同一段文本
      const crlfHint =
        before.includes("\r\n") && !oldString.includes("\r\n") && oldString.includes("\n")
          ? " This file uses CRLF line endings while old_string uses bare LF — copy the text verbatim from read_file output."
          : "";
      return {
        content:
          `old_string was not found in ${p} (0 matches).${crlfHint} Re-read the file and copy the exact text, ` +
          "including indentation; widen the excerpt with surrounding lines if you are unsure. " +
          "(If a previous attempt already applied this edit, the old text is gone by design — read the file to confirm before retrying.)",
        isError: true,
      };
    }
    if (offsets.length > 1 && replaceAll !== true) {
      const lines = offsets.slice(0, 10).map((o) => lineOfOffset(before, o) + 1);
      return {
        content:
          `old_string is not unique in ${p}: ${offsets.length} matches (lines ${lines.join(", ")}${offsets.length > lines.length ? ", …" : ""}). ` +
          "Add more surrounding context to make it unique, or pass replace_all: true to change every occurrence.",
        isError: true,
      };
    }

    const after = replaceAll === true ? before.split(oldString).join(newString) : before.replace(oldString, newString);
    const applied = replaceAll === true ? offsets : [offsets[0]!];

    // mkdir 不参与（文件必须已存在），但父目录仍可能在读之后被替换成链接——重算一次
    const revalidated = resolveInWorkdir(ctx.workdir, p);
    await writeFile(revalidated, after, "utf8");

    const diff = renderEditDiff(p, before, after, applied, oldString.length, newString.length);
    const delta = Buffer.byteLength(after, "utf8") - Buffer.byteLength(before, "utf8");
    const sign = delta >= 0 ? "+" : "";
    return {
      content:
        `Edited ${p}: ${applied.length} replacement(s), ${sign}${delta} bytes.\n${diff}`,
    };
  },
};

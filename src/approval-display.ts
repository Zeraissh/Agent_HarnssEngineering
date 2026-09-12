/**
 * GhostApproval 对策：审批文案必须显示解析后的真实目标，而不只是模型给的诱饵名。
 *
 * SAFE-02 已拦圈外 symlink 逃逸；圈内 symlink（如 `project_settings.json` → `.env`）
 * 仍会写成功——知情同意来自审批卡上的真实目标，不是参数字符串。
 */
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { resolveInWorkdir, resolveReadable } from "./tools/fs-util.js";

export interface ApprovalPathTarget {
  field: string;
  requested: string;
  /** lexical resolve（仍在圈内校验之后） */
  lexical: string;
  /**
   * 真实目标：若路径存在则 realpath（解开 symlink/junction）；
   * 新文件则为其最近存在祖先的 realpath + 剩余相对段。
   */
  real: string;
  /** lexical 与 real 不一致，或校验失败——宿主必须醒目展示 */
  diverges: boolean;
  /** 圈禁/解析失败时的说明（仍展示 requested，便于人拒绝） */
  error?: string;
}

const PATH_FIELDS_BY_TOOL: Record<string, string[]> = {
  write_file: ["path"],
  write_pptx: ["path"],
  edit_file: ["path"],
  read_file: ["path"],
  generate_image: ["path", "output_path"],
};

function pathFieldsForTool(name: string): string[] {
  if (PATH_FIELDS_BY_TOOL[name]) return PATH_FIELDS_BY_TOOL[name]!;
  // MCP / 未知工具：常见字段名启发式（fail-open：认不出就不画，不拦审批）
  return ["path", "file", "filepath", "file_path", "output", "output_path", "target"];
}

function realpathExistingOrNearest(lexical: string): string {
  if (existsSync(lexical)) {
    try {
      return realpathSync.native(lexical);
    } catch {
      /* fall through to nearest ancestor */
    }
  }
  let cursor = path.resolve(lexical);
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    missing.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const realParent = realpathSync.native(cursor);
  return missing.length ? path.join(realParent, ...missing) : realParent;
}

/**
 * 单路径：先做圈禁（与工具执行同口径），再解出真实目标。
 * 写类用 resolveInWorkdir；读类允许 readRoots。
 */
export function inspectPathForApproval(input: {
  workdir: string;
  readRoots?: string[];
  writeRoots?: string[];
  requested: string;
  field: string;
  readable?: boolean;
}): ApprovalPathTarget {
  const { workdir, readRoots, writeRoots, requested, field } = input;
  try {
    const lexical = input.readable
      ? resolveReadable(workdir, readRoots, requested)
      : resolveInWorkdir(workdir, requested, writeRoots);
    const real = realpathExistingOrNearest(lexical);
    const diverges =
      path.normalize(lexical) !== path.normalize(real)
      || path.basename(requested) !== path.basename(real);
    return { field, requested, lexical, real, diverges };
  } catch (error) {
    return {
      field,
      requested,
      lexical: path.resolve(workdir, requested),
      real: path.resolve(workdir, requested),
      diverges: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 从工具名 + 入参抽出应在审批卡上展示的路径目标。 */
export function describeApprovalTargets(
  toolName: string,
  toolInput: unknown,
  workdir: string,
  readRoots?: string[],
  writeRoots?: string[],
): ApprovalPathTarget[] {
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return [];
  const obj = toolInput as Record<string, unknown>;
  const readable = toolName === "read_file";
  const out: ApprovalPathTarget[] = [];
  for (const field of pathFieldsForTool(toolName)) {
    const value = obj[field];
    if (typeof value !== "string" || !value.trim()) continue;
    out.push(
      inspectPathForApproval({
        workdir,
        readRoots,
        writeRoots,
        requested: value,
        field,
        readable,
      }),
    );
  }
  return out;
}

/** 是否存在需要醒目展示的目标（分歧或解析失败）。 */
export function approvalTargetsNeedAttention(targets: readonly ApprovalPathTarget[]): boolean {
  return targets.some((t) => t.diverges || Boolean(t.error));
}

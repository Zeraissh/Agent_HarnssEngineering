/**
 * 文件类工具共享的路径安全校验：先做 lexical containment，再校验真实路径。
 * 模型给出的路径是不可信输入 —— 拒绝 `..`、圈外绝对路径以及经
 * symlink / junction / reparse point 的逃逸。
 */
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * 返回 path 本身（若存在）或最近存在父目录的真实路径。
 *
 * 不能只校验 lexical `path.resolve`：workdir 内的 symlink / Windows junction
 * 可以把后续 read/write 带到圈外。写入目标经常尚不存在，所以必须逐级上溯，
 * 直到找到一个可 realpath 的祖先；遇到 dangling link 或权限错误则 fail closed。
 */
function realpathOfNearestExisting(input: string): string {
  let cursor = path.resolve(input);
  while (true) {
    try {
      lstatSync(cursor);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw new Error(
          `Cannot verify path boundary for "${input}": ${(error as Error).message}`,
        );
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new Error(`Cannot verify path boundary for "${input}": no existing parent found.`);
      }
      cursor = parent;
      continue;
    }

    try {
      // native 在 Windows 上会解析 junction/reparse point，在 POSIX 上解析 symlink。
      return realpathSync.native(cursor);
    } catch (error) {
      throw new Error(
        `Cannot verify path boundary for "${input}": ${(error as Error).message}`,
      );
    }
  }
}

function realpathOfRoot(root: string): string {
  try {
    return realpathSync.native(root);
  } catch (error) {
    throw new Error(`Cannot verify root directory "${root}": ${(error as Error).message}`);
  }
}

export function resolveInWorkdir(workdir: string, p: string): string {
  const lexicalRoot = path.resolve(workdir);
  const resolved = path.resolve(lexicalRoot, p);
  if (!isInside(lexicalRoot, resolved)) {
    throw new Error(
      `Path escapes the working directory: "${p}". Use a path inside ${workdir}.`,
    );
  }

  // workdir 本身必须存在；否则“最近存在父目录”会错误地扩大授权边界。
  const realRoot = realpathOfRoot(lexicalRoot);
  const realTargetParent = realpathOfNearestExisting(resolved);
  if (!isInside(realRoot, realTargetParent)) {
    throw new Error(
      `Path escapes the working directory through a symbolic link or junction: "${p}". ` +
        `Use a path inside ${workdir}.`,
    );
  }
  return resolved;
}

/** true 当 resolved 位于 root 之内（含 root 自身） */
function isInside(root: string, resolved: string): boolean {
  const rel = path.relative(path.resolve(root), resolved);
  return rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * 只读解析：workdir 之内照旧;否则允许落在任一额外只读根内(绝对路径直接给,
 * 相对路径仅相对 workdir 解析)。写类工具不得使用本函数——只读根仅对读开放
 * (案例 #5 催生:KiCad 官方库在 D:\KiCad\share,agent 需要读取库件原文嵌入文档)。
 */
export function resolveReadable(workdir: string, readRoots: string[] | undefined, p: string): string {
  const resolved = path.resolve(workdir, p);
  const hint = readRoots?.length ? ` or one of the read-only roots: ${readRoots.join(", ")}` : "";
  const lexicalRoots = [workdir, ...(readRoots ?? [])]
    .map((root) => path.resolve(root))
    .filter((root) => isInside(root, resolved));
  if (lexicalRoots.length > 0) {
    const realTargetParent = realpathOfNearestExisting(resolved);
    for (const root of lexicalRoots) {
      const realRoot = realpathOfRoot(root);
      if (isInside(realRoot, realTargetParent)) return resolved;
    }
  }
  throw new Error(
    `Path escapes the working directory: "${p}". Use a path inside ${workdir}${hint}.`,
  );
}

/**
 * 凭据形状的文件名（审计 2026-08-24 high）：read_file 走 auto 权限，默认
 * workdir=cwd 时 agent 可**无审批**读走 .env 真实密钥，且内容随 transcript
 * 明文进运行历史归档。bash `cat .env` 仍可行——但 bash 在审批门后，操作员
 * 看得见命令；这里堵的是唯一一条无人看见的路径。
 * `.example` / `.sample` 是不含真值的模板，放行。名单刻意收紧到"几乎不可能
 * 误伤"的形状——宁可漏（还有审批门兜底），不可把正常文件误拒成新失效模式。
 */
export function credentialLikeName(p: string): boolean {
  const base = path.basename(p).toLowerCase();
  if (base.endsWith(".example") || base.endsWith(".sample")) return false;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (base === ".npmrc" || base === ".netrc") return true;
  if (base.startsWith("id_rsa") || base.startsWith("id_ed25519") || base.startsWith("id_ecdsa")) return true;
  if (base.endsWith(".pem")) return true;
  return false;
}

/** 输出截断：超长内容回填给模型只会烧 token，不会更有用 */
export function truncate(text: string, limit = 30_000): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} of ${text.length} chars]`;
}

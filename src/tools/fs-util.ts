/**
 * 文件类工具共享的路径安全校验：resolve 到规范形式并确认仍在 workdir 内。
 * 模型给出的路径是不可信输入 —— 拒绝 `..` 逃逸与工作区外的绝对路径。
 */
import path from "node:path";

export function resolveInWorkdir(workdir: string, p: string): string {
  const resolved = path.resolve(workdir, p);
  const rel = path.relative(path.resolve(workdir), resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Path escapes the working directory: "${p}". Use a path inside ${workdir}.`,
    );
  }
  return resolved;
}

/** true 当 resolved 位于 root 之内（含 root 自身） */
function isInside(root: string, resolved: string): boolean {
  const rel = path.relative(path.resolve(root), resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 只读解析：workdir 之内照旧;否则允许落在任一额外只读根内(绝对路径直接给,
 * 相对路径仅相对 workdir 解析)。写类工具不得使用本函数——只读根仅对读开放
 * (案例 #5 催生:KiCad 官方库在 D:\KiCad\share,agent 需要读取库件原文嵌入文档)。
 */
export function resolveReadable(workdir: string, readRoots: string[] | undefined, p: string): string {
  const resolved = path.resolve(workdir, p);
  if (isInside(workdir, resolved)) return resolved;
  for (const root of readRoots ?? []) {
    if (isInside(root, resolved)) return resolved;
  }
  const hint = readRoots?.length ? ` or one of the read-only roots: ${readRoots.join(", ")}` : "";
  throw new Error(
    `Path escapes the working directory: "${p}". Use a path inside ${workdir}${hint}.`,
  );
}

/** 输出截断：超长内容回填给模型只会烧 token，不会更有用 */
export function truncate(text: string, limit = 30_000): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} of ${text.length} chars]`;
}

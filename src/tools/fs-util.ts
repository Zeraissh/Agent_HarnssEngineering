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

/** 输出截断：超长内容回填给模型只会烧 token，不会更有用 */
export function truncate(text: string, limit = 30_000): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} of ${text.length} chars]`;
}

/**
 * 圈禁内浅列表：给 composer `@` 点名工作区文件。
 * 只列一层，不递归；隐藏目录 / 凭据形状 / node_modules 不进菜单。
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { credentialLikeName, resolveInWorkdir } from "../src/tools/fs-util.js";

export const WORKSPACE_FILE_LIST_MAX = 40;

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".agent-run-history",
  ".agent-memory",
  ".agent-campaigns",
]);

export type WorkspaceFileKind = "file" | "directory";

export interface WorkspaceFileEntry {
  name: string;
  relative: string;
  kind: WorkspaceFileKind;
}

/** `@src/hel` → 在 src/ 下筛 hel*；`@foo` → 工作区根下筛 foo*。 */
export function parseWorkspaceFileQuery(q: string): { dir: string; prefix: string } {
  const norm = String(q ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  const cut = norm.lastIndexOf("/");
  if (cut < 0) return { dir: "", prefix: norm.toLowerCase() };
  return { dir: norm.slice(0, cut), prefix: norm.slice(cut + 1).toLowerCase() };
}

export async function listWorkspaceFiles(
  workdir: string,
  query = "",
): Promise<{ files: WorkspaceFileEntry[] }> {
  const root = path.resolve(workdir);
  const { dir, prefix } = parseWorkspaceFileQuery(query);
  let target = root;
  if (dir) {
    try {
      target = resolveInWorkdir(root, dir);
    } catch {
      return { files: [] };
    }
  }
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    return { files: [] };
  }
  const files: WorkspaceFileEntry[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    if (credentialLikeName(entry.name)) continue;
    if (prefix && !entry.name.toLowerCase().startsWith(prefix)) continue;
    const isDir = entry.isDirectory();
    const isFile = entry.isFile();
    if (!isDir && !isFile) continue;
    const relative = (dir ? `${dir}/${entry.name}` : entry.name).replace(/\\/g, "/");
    files.push({
      name: entry.name,
      relative,
      kind: isDir ? "directory" : "file",
    });
  }
  files.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, "en");
  });
  return { files: files.slice(0, WORKSPACE_FILE_LIST_MAX) };
}

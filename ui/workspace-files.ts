/**
 * 圈禁内工作区检索：给 composer `@` 点名文件。
 * 空查询只浅列一层；带 q 时按文件名/相对路径包含匹配，适度深搜。
 * 隐藏目录 / 凭据形状 / node_modules 不进菜单。每条路径都走 resolveInWorkdir。
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { credentialLikeName, resolveInWorkdir } from "../src/tools/fs-util.js";

export const WORKSPACE_FILE_LIST_MAX = 40;
/** 从起点往下最多再走几层目录（根为 0）。不是完整 IDE 树。 */
export const WORKSPACE_FILE_SEARCH_DEPTH = 4;
const WORKSPACE_FILE_WALK_CAP = 800;

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

/** `@src/hel` → 在 src/ 下筛 hel；`@foo` → 整树按名找 foo。 */
export function parseWorkspaceFileQuery(q: string): { dir: string; prefix: string } {
  const norm = String(q ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  const cut = norm.lastIndexOf("/");
  if (cut < 0) return { dir: "", prefix: norm.toLowerCase() };
  return { dir: norm.slice(0, cut), prefix: norm.slice(cut + 1).toLowerCase() };
}

function shouldSkipName(name: string): boolean {
  if (name.startsWith(".")) return true;
  if (SKIP_DIR_NAMES.has(name)) return true;
  if (credentialLikeName(name)) return true;
  return false;
}

function toRelative(dir: string, name: string): string {
  return (dir ? `${dir}/${name}` : name).replace(/\\/g, "/");
}

function sortEntries(files: WorkspaceFileEntry[]): WorkspaceFileEntry[] {
  files.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, "en");
  });
  return files;
}

function resolveListed(root: string, relative: string): string | null {
  try {
    return relative ? resolveInWorkdir(root, relative) : path.resolve(root);
  } catch {
    return null;
  }
}

async function readDirSafe(abs: string) {
  try {
    return await readdir(abs, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function listShallow(root: string, dir: string): Promise<WorkspaceFileEntry[]> {
  const target = resolveListed(root, dir);
  if (!target) return [];
  const files: WorkspaceFileEntry[] = [];
  for (const entry of await readDirSafe(target)) {
    if (shouldSkipName(entry.name)) continue;
    const isDir = entry.isDirectory();
    const isFile = entry.isFile();
    if (!isDir && !isFile) continue;
    const relative = toRelative(dir, entry.name);
    if (!resolveListed(root, relative)) continue;
    files.push({
      name: entry.name,
      relative,
      kind: isDir ? "directory" : "file",
    });
  }
  return sortEntries(files).slice(0, WORKSPACE_FILE_LIST_MAX);
}

async function searchDeep(
  root: string,
  startRel: string,
  needle: string,
): Promise<WorkspaceFileEntry[]> {
  const out: WorkspaceFileEntry[] = [];
  const seen = new Set<string>();
  const queue: { rel: string; depth: number }[] = [{ rel: startRel, depth: 0 }];
  let walked = 0;
  while (queue.length && out.length < WORKSPACE_FILE_LIST_MAX && walked < WORKSPACE_FILE_WALK_CAP) {
    const { rel, depth } = queue.shift()!;
    const abs = resolveListed(root, rel);
    if (!abs) continue;
    for (const entry of await readDirSafe(abs)) {
      if (walked++ >= WORKSPACE_FILE_WALK_CAP) break;
      if (shouldSkipName(entry.name)) continue;
      const childRel = toRelative(rel, entry.name);
      if (seen.has(childRel)) continue;
      seen.add(childRel);
      if (!resolveListed(root, childRel)) continue;
      const isDir = entry.isDirectory();
      const isFile = entry.isFile();
      if (!isDir && !isFile) continue;
      const nameHit = entry.name.toLowerCase().includes(needle);
      const relHit = childRel.toLowerCase().includes(needle);
      if (nameHit || relHit) {
        out.push({
          name: entry.name,
          relative: childRel,
          kind: isDir ? "directory" : "file",
        });
        if (out.length >= WORKSPACE_FILE_LIST_MAX) break;
      }
      if (isDir && depth + 1 <= WORKSPACE_FILE_SEARCH_DEPTH) {
        queue.push({ rel: childRel, depth: depth + 1 });
      }
    }
  }
  return sortEntries(out).slice(0, WORKSPACE_FILE_LIST_MAX);
}

export async function listWorkspaceFiles(
  workdir: string,
  query = "",
): Promise<{ files: WorkspaceFileEntry[] }> {
  const root = path.resolve(workdir);
  const { dir, prefix } = parseWorkspaceFileQuery(query);
  if (dir && !resolveListed(root, dir)) return { files: [] };
  if (!prefix) {
    return { files: await listShallow(root, dir) };
  }
  return { files: await searchDeep(root, dir, prefix) };
}

/**
 * 圈禁内工作区检索：composer `@` 点名 + Code 脸文件树展开。
 * 空查询 / 以 `/` 结尾的 q 只浅列一层（树展开）；带文件名前缀时按名深搜。
 * 隐藏目录 / 凭据形状 / node_modules 不进菜单。每条路径都走 resolveInWorkdir。
 * 服务端只转发 files[]，人话提示挂在条目的 notice 上（不是 HTTP 码）。
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { credentialLikeName, resolveInWorkdir } from "../src/tools/fs-util.js";

export const WORKSPACE_FILE_LIST_MAX = 40;
/** 从起点往下最多再走几层目录（根为 0）。`@` 深搜用，不是整盘扫描。 */
export const WORKSPACE_FILE_SEARCH_DEPTH = 4;
/** 文件树：从工作区根往下最多展开几层。再深给人话，不继续扫。 */
export const WORKSPACE_TREE_MAX_DEPTH = 8;
/** 文件树：单层最多列出多少条（另加一条截断提示）。 */
export const WORKSPACE_TREE_LAYER_MAX = 200;
const WORKSPACE_FILE_WALK_CAP = 800;

export const TREE_NOTICE = {
  escaped: "这个路径不在当前工作目录里。",
  denied: "没有权限打开这个文件夹。",
  missing: "这个文件夹已经不在了。",
  failed: "打不开这个文件夹。",
  tooDeep: "这一层太深了，不再往下展开。",
  truncated: "这一层文件太多，只列出前 200 个。",
} as const;

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
  /** 有值时本条是人话提示，不是真实文件。服务端只转发 files[]，提示只能挂在这里。 */
  notice?: string;
}

/** `@src/hel` → 在 src/ 下筛 hel；`@foo` → 整树按名找 foo。 */
export function parseWorkspaceFileQuery(q: string): { dir: string; prefix: string } {
  const norm = String(q ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  const cut = norm.lastIndexOf("/");
  if (cut < 0) return { dir: "", prefix: norm.toLowerCase() };
  return { dir: norm.slice(0, cut), prefix: norm.slice(cut + 1).toLowerCase() };
}

/** `src` → `src/`，给文件树展开用；根是空字符串。 */
export function treeQueryForDir(dir: string): string {
  const rel = String(dir ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return rel ? `${rel}/` : "";
}

/** 相对工作区根的目录深度。根为 0。 */
export function treeDepthOf(dir: string): number {
  const rel = String(dir ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!rel) return 0;
  return rel.split("/").filter(Boolean).length;
}

export function isWorkspaceFileNotice(
  entry: WorkspaceFileEntry | null | undefined,
): boolean {
  return Boolean(entry && typeof entry.notice === "string" && entry.notice.trim());
}

function noticeEntry(notice: string, relative = ""): WorkspaceFileEntry {
  return { name: "", relative, kind: "directory", notice };
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

async function readDirSafe(abs: string): Promise<{
  dents: Awaited<ReturnType<typeof readdir>>;
  error: string | null;
}> {
  try {
    return { dents: await readdir(abs, { withFileTypes: true }), error: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { dents: [], error: code ?? "FAILED" };
  }
}

function listErrorNotice(code: string | null, dir: string): WorkspaceFileEntry {
  if (code === "EACCES" || code === "EPERM") return noticeEntry(TREE_NOTICE.denied, dir);
  if (code === "ENOENT") return noticeEntry(TREE_NOTICE.missing, dir);
  return noticeEntry(TREE_NOTICE.failed, dir);
}

async function listShallow(root: string, dir: string): Promise<WorkspaceFileEntry[]> {
  if (treeDepthOf(dir) > WORKSPACE_TREE_MAX_DEPTH) {
    return [noticeEntry(TREE_NOTICE.tooDeep, dir)];
  }
  const target = resolveListed(root, dir);
  if (!target) return [noticeEntry(TREE_NOTICE.escaped, dir)];
  const { dents, error } = await readDirSafe(target);
  if (error) return [listErrorNotice(error, dir)];
  const files: WorkspaceFileEntry[] = [];
  for (const entry of dents) {
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
  const sorted = sortEntries(files);
  if (sorted.length > WORKSPACE_TREE_LAYER_MAX) {
    const cut = sorted.slice(0, WORKSPACE_TREE_LAYER_MAX);
    cut.push(noticeEntry(TREE_NOTICE.truncated, dir));
    return cut;
  }
  return sorted;
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
    const { dents } = await readDirSafe(abs);
    for (const entry of dents) {
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
  if (dir && !resolveListed(root, dir)) {
    // `@../secret` 仍空列表（点名补全不该冒出逃逸提示）；树展开 `../secret/` 才给人话。
    if (!prefix) return { files: [noticeEntry(TREE_NOTICE.escaped, dir)] };
    return { files: [] };
  }
  if (!prefix) {
    return { files: await listShallow(root, dir) };
  }
  return { files: await searchDeep(root, dir, prefix) };
}

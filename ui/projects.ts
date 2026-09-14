/**
 * 项目实体的持久化存储（多 workdir 分组）。
 *
 * 落点：<workdir>/.agent-projects.json（真实宿主默认；AGENT_PROJECTS_FILE 可覆盖）。
 * 注入 modelClient 的测试宿主经 UiServerOptions.projectsStoreFile 显式给路径，
 * 缺省 null——仪器纪律同 workdirStoreFile：假模型宿主不该写操作员那份项目文件。
 *
 * 纪律：
 *   - 原子写：临时文件 + rename；读到的文件损坏 → 备份为 .bak 后从零开始。
 *   - workdirs / primaryWorkdir 一律 resolve 归一化；写入时必须已在白名单内。
 *   - 同一绝对路径不得同时属于两个项目（slug / 侧栏分组否则会撞车）。
 */
import { randomUUID } from "node:crypto";
import { copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const PROJECTS_SCHEMA_VERSION = 1;
export const PROJECTS_FILENAME = ".agent-projects.json";
export const PROJECT_NAME_MAX = 80;

export interface Project {
  id: string;
  name: string;
  workdirs: string[];
  primaryWorkdir: string;
  createdAt: string;
}

export interface ProjectStore {
  schemaVersion: typeof PROJECTS_SCHEMA_VERSION;
  projects: Project[];
}

const PROJECT_ID_RE = /^[\w][\w.-]{0,63}$/;

export function isProjectId(id: string): boolean {
  return PROJECT_ID_RE.test(String(id ?? "").trim());
}

export function newProjectId(): string {
  return randomUUID();
}

function normalizePath(raw: string): string {
  return resolve(String(raw).trim());
}

/**
 * 宽松解析：坏 JSON / 版本不符 / 非对象 → null。
 * 单条缺必填字段或非法 id 收掉；路径 resolve 去重；primary 必须落在 workdirs 里。
 */
export function parseProjectStore(raw: string | null | undefined): ProjectStore | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.schemaVersion !== PROJECTS_SCHEMA_VERSION) return null;
  if (!Array.isArray(o.projects)) return { schemaVersion: PROJECTS_SCHEMA_VERSION, projects: [] };
  const claimed = new Set<string>();
  const projects: Project[] = [];
  for (const entry of o.projects) {
    const parsed = coerceStoredProject(entry, claimed);
    if (parsed) projects.push(parsed);
  }
  return { schemaVersion: PROJECTS_SCHEMA_VERSION, projects };
}

function coerceStoredProject(entry: unknown, claimed: Set<string>): Project | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const id = String(e.id ?? "").trim();
  const name = String(e.name ?? "").trim();
  if (!isProjectId(id) || !name) return null;
  if (!Array.isArray(e.workdirs) || e.workdirs.length < 1) return null;
  const workdirs: string[] = [];
  const seen = new Set<string>();
  for (const item of e.workdirs) {
    if (typeof item !== "string" || !item.trim()) continue;
    const path = normalizePath(item);
    if (seen.has(path) || claimed.has(path)) continue;
    seen.add(path);
    workdirs.push(path);
  }
  if (!workdirs.length) return null;
  const primaryRaw = typeof e.primaryWorkdir === "string" ? normalizePath(e.primaryWorkdir) : workdirs[0]!;
  const primaryWorkdir = workdirs.includes(primaryRaw) ? primaryRaw : workdirs[0]!;
  const createdAt = typeof e.createdAt === "string" && e.createdAt.trim()
    ? e.createdAt.trim()
    : new Date(0).toISOString();
  for (const path of workdirs) claimed.add(path);
  return { id, name: name.slice(0, PROJECT_NAME_MAX), workdirs, primaryWorkdir, createdAt };
}

export interface LoadProjectStoreResult {
  store: ProjectStore | null;
  recoveredFromCorrupt: boolean;
}

export function loadProjectStore(file: string): LoadProjectStoreResult {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { store: null, recoveredFromCorrupt: false };
  }
  const store = parseProjectStore(raw);
  if (store) return { store, recoveredFromCorrupt: false };
  try {
    copyFileSync(file, `${file}.bak`);
  } catch { /* 备份失败不挡启动 */ }
  return { store: null, recoveredFromCorrupt: true };
}

export function saveProjectStore(file: string, store: ProjectStore): void {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

export function findProjectById(projects: Iterable<Project>, id: string): Project | undefined {
  const want = String(id ?? "").trim();
  if (!want) return undefined;
  return [...projects].find((p) => p.id === want);
}

export function findProjectByWorkdir(projects: Iterable<Project>, workdir: string): Project | undefined {
  if (typeof workdir !== "string" || !workdir.trim()) return undefined;
  let asked: string;
  try {
    asked = normalizePath(workdir);
  } catch {
    return undefined;
  }
  return [...projects].find((p) => p.workdirs.includes(asked));
}

/** 项目内除主目录外的成员，给 composer extraWorkdirs。 */
export function extraWorkdirsFromProject(project: Project, primary = project.primaryWorkdir): string[] {
  const root = normalizePath(primary);
  return project.workdirs.filter((p) => p !== root);
}

export type ProjectWrite =
  | { ok: true; name: string; workdirs: string[]; primaryWorkdir: string }
  | { ok: false; error: string; status?: number };

/**
 * 请求体 → 归一化后的名称与目录。越白名单 / 空名 / 空成员 / primary 不在集合
 * 一律失败，不静默丢掉。
 */
export function parseProjectWrite(
  raw: unknown,
  allowed: Iterable<string>,
): ProjectWrite {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "请求体必须是对象" };
  }
  const body = raw as Record<string, unknown>;
  const name = String(body.name ?? "").trim();
  if (!name) return { ok: false, error: "项目名称不能为空" };
  if (name.length > PROJECT_NAME_MAX) {
    return { ok: false, error: `项目名称不能超过 ${PROJECT_NAME_MAX} 个字符` };
  }
  if (!Array.isArray(body.workdirs) || body.workdirs.length < 1) {
    return { ok: false, error: "workdirs 必须是至少一项的路径数组" };
  }
  const allowedSet = new Set([...allowed].map((p) => normalizePath(p)));
  const workdirs: string[] = [];
  const seen = new Set<string>();
  for (const item of body.workdirs) {
    if (typeof item !== "string" || !item.trim()) {
      return { ok: false, error: "workdirs 每项必须是非空路径" };
    }
    const asked = normalizePath(item);
    if (!allowedSet.has(asked)) {
      return { ok: false, error: `目录不在白名单内：${asked}`, status: 400 };
    }
    if (seen.has(asked)) continue;
    seen.add(asked);
    workdirs.push(asked);
  }
  if (!workdirs.length) return { ok: false, error: "workdirs 必须是至少一项的路径数组" };
  let primaryWorkdir = workdirs[0]!;
  if (body.primaryWorkdir !== undefined && body.primaryWorkdir !== null && body.primaryWorkdir !== "") {
    if (typeof body.primaryWorkdir !== "string") {
      return { ok: false, error: "primaryWorkdir 必须是路径" };
    }
    const asked = normalizePath(body.primaryWorkdir);
    if (!workdirs.includes(asked)) {
      return { ok: false, error: "primaryWorkdir 必须是 workdirs 中的一项" };
    }
    primaryWorkdir = asked;
  }
  return { ok: true, name, workdirs, primaryWorkdir };
}

export type ProjectPatch =
  | { ok: true; name?: string; workdirs?: string[]; primaryWorkdir?: string }
  | { ok: false; error: string; status?: number };

/** PATCH：只校验出现的字段；未出现的留给调用方从旧项目补齐后再查重叠。 */
export function parseProjectPatch(
  raw: unknown,
  allowed: Iterable<string>,
): ProjectPatch {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "请求体必须是对象" };
  }
  const body = raw as Record<string, unknown>;
  const out: { name?: string; workdirs?: string[]; primaryWorkdir?: string } = {};
  if (body.name !== undefined) {
    const name = String(body.name ?? "").trim();
    if (!name) return { ok: false, error: "项目名称不能为空" };
    if (name.length > PROJECT_NAME_MAX) {
      return { ok: false, error: `项目名称不能超过 ${PROJECT_NAME_MAX} 个字符` };
    }
    out.name = name;
  }
  if (body.workdirs !== undefined) {
    const parsed = parseProjectWrite(
      { name: out.name ?? "x", workdirs: body.workdirs, primaryWorkdir: body.primaryWorkdir },
      allowed,
    );
    if (!parsed.ok) return parsed;
    out.workdirs = parsed.workdirs;
    if (body.primaryWorkdir !== undefined) out.primaryWorkdir = parsed.primaryWorkdir;
  } else if (body.primaryWorkdir !== undefined && body.primaryWorkdir !== null && body.primaryWorkdir !== "") {
    if (typeof body.primaryWorkdir !== "string") {
      return { ok: false, error: "primaryWorkdir 必须是路径" };
    }
    out.primaryWorkdir = normalizePath(body.primaryWorkdir);
  }
  return { ok: true, ...out };
}

/** 除 excludeId 外，这些路径是否已被别的项目占用。 */
export function overlappingProjectWorkdirs(
  projects: Iterable<Project>,
  workdirs: string[],
  excludeId?: string,
): string[] {
  const claimed = new Set<string>();
  for (const project of projects) {
    if (excludeId && project.id === excludeId) continue;
    for (const path of project.workdirs) claimed.add(path);
  }
  return workdirs.filter((path) => claimed.has(path));
}

export function createProjectRecord(
  input: { name: string; workdirs: string[]; primaryWorkdir: string },
  now = new Date(),
): Project {
  return {
    id: newProjectId(),
    name: input.name,
    workdirs: [...input.workdirs],
    primaryWorkdir: input.primaryWorkdir,
    createdAt: now.toISOString(),
  };
}

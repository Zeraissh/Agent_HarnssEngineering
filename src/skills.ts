/**
 * Optional skill files: install into a harness-known directory, inject into
 * the executor system prompt. Not DomainPacks. Not MCP.
 *
 * The only adaptation is a short tool-name map in the inject wrapper.
 * Skill bodies are written and re-injected unchanged.
 */
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export const SKILLS_DIR_NAME = ".agent-skills";
export const SKILLS_INDEX_FILE = "index.json";
export const SUPERPOWERS_DISTINCTIVE_PHRASE = "These thoughts mean STOP—you're rationalizing";

export const HOST_TOOL_NAME_MAP = [
  ["Read", "read_file"],
  ["Write", "write_file"],
  ["Edit", "edit_file"],
  ["Bash", "bash"],
  ["Glob", "glob"],
  ["Grep", "grep"],
] as const;

export interface SkillFileRef {
  sourcePath: string;
  destName: string;
}

export interface SkillIndexEntry {
  id: string;
  kind: "skill";
  enabled: boolean;
  repo?: string;
  url?: string;
  files: string[];
  installedAt: string;
}

export interface SkillsIndex {
  skills: Record<string, SkillIndexEntry>;
}

export interface LoadedSkill {
  id: string;
  kind: "skill";
  enabled: true;
  body: string;
  files: string[];
}

export type SkillFetch = (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const SAFE_DEST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_SOURCE_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const SAFE_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SAFE_BRANCH = /^[A-Za-z0-9._-]+$/;
const MAX_SKILL_CHARS = 200_000;
const MAX_LISTING_CHARS = 200_000;

/** Default branches after a pinned catalog branch (if any). */
export const DEFAULT_SKILL_BRANCHES = ["main", "master"] as const;

/**
 * Extra SKILL.md locations when the folder name ≠ repo name.
 * Public contents listing can discover others; this list is the no-token fallback.
 */
export const WELL_KNOWN_SKILL_MD_PATHS = [
  "skills/ppt-master/SKILL.md",
  "skills/using-superpowers/SKILL.md",
] as const;

export type SkillResolveCode = "repo_not_found" | "skill_file_not_found" | "auth";

export class SkillResolveError extends Error {
  readonly code: SkillResolveCode;
  readonly tried: string[];
  readonly status?: number;
  constructor(code: SkillResolveCode, message: string, tried: string[], status?: number) {
    super(message);
    this.name = "SkillResolveError";
    this.code = code;
    this.tried = tried;
    this.status = status;
  }
}

export function formatSkillFileNotFound(repo: string, tried: string[]): string {
  const paths = tried.length ? tried.join("、") : "(无)";
  return (
    `仓库 https://github.com/${repo} 可访问，但未找到 SKILL.md（skill 文件 404，不是仓库缺失）。` +
    `已尝试：${paths}。`
  );
}

export function formatSkillRepoNotFound(repo: string): string {
  return `GitHub 仓库不存在或不可公开访问：https://github.com/${repo}`;
}

export function formatSkillAuthDenied(status: number): string {
  return `GitHub 拒绝访问（HTTP ${status}），可能是私有仓库、未授权或限流。安装未使用操作员令牌。`;
}

export function skillInstallBranches(preferred?: string): string[] {
  const out: string[] = [];
  const add = (branch: string) => {
    if (!SAFE_BRANCH.test(branch) || out.includes(branch)) return;
    out.push(branch);
  };
  if (preferred) add(preferred);
  for (const branch of DEFAULT_SKILL_BRANCHES) add(branch);
  return out;
}

export function skillMdCandidatePaths(repoName: string, pinned: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (path: string) => {
    if (!SAFE_SOURCE_PATH.test(path) || path.includes("..") || seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };
  for (const path of pinned) add(path);
  add("SKILL.md");
  add("skills/SKILL.md");
  if (SAFE_BRANCH.test(repoName)) add(`skills/${repoName}/SKILL.md`);
  for (const extra of WELL_KNOWN_SKILL_MD_PATHS) add(extra);
  return out;
}

export function githubRepoApiUrl(repo: string): string {
  if (!SAFE_REPO.test(repo)) throw new Error("repo 非法");
  return `https://api.github.com/repos/${repo}`;
}

export function githubSkillsContentsApiUrl(repo: string, branch: string): string {
  if (!SAFE_REPO.test(repo)) throw new Error("repo 非法");
  if (!SAFE_BRANCH.test(branch)) throw new Error("branch 非法");
  return `https://api.github.com/repos/${repo}/contents/skills?ref=${encodeURIComponent(branch)}`;
}

function assertNoUserinfoPort(parsed: URL): void {
  if (parsed.username || parsed.password || parsed.port) throw new Error("拒绝带用户信息或端口的 URL");
}

function assertAllowedRawUrl(url: string): void {
  if (!url.startsWith("https://raw.githubusercontent.com/")) {
    throw new Error("只允许 raw.githubusercontent.com");
  }
  const parsed = new URL(url);
  assertNoUserinfoPort(parsed);
  if (parsed.search || parsed.hash) throw new Error("拒绝带 query/hash 的 raw URL");
}

function assertAllowedGithubApiUrl(url: string): void {
  if (!url.startsWith("https://api.github.com/")) throw new Error("只允许 api.github.com");
  const parsed = new URL(url);
  assertNoUserinfoPort(parsed);
  if (parsed.hash) throw new Error("拒绝带 hash 的 API URL");
  const path = parsed.pathname.replace(/\/$/, "") || "/";
  const repoMeta = /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
  const skillsListing = /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/contents\/skills$/;
  if (repoMeta.test(path)) {
    if (parsed.search) throw new Error("拒绝带 query 的仓库元数据 URL");
    return;
  }
  if (skillsListing.test(path)) {
    const ref = parsed.searchParams.get("ref");
    if ([...parsed.searchParams.keys()].join() !== "ref" || !ref || !SAFE_BRANCH.test(ref)) {
      throw new Error("skills listing 只允许 ?ref=branch");
    }
    return;
  }
  throw new Error("只允许公开仓库元数据或 skills 目录 listing");
}

/** No Authorization header — public GitHub only. Injected tests should mock this. */
export function defaultSkillFetch(url: string): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> {
  const headers: Record<string, string> = { "User-Agent": "agent-harness-skill-install" };
  if (url.startsWith("https://api.github.com/")) {
    headers.Accept = "application/vnd.github+json";
  }
  return fetch(url, { headers });
}

function parseSkillsListing(body: string): string[] {
  if (body.length > MAX_LISTING_CHARS) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name : "";
    const type = typeof row.type === "string" ? row.type : "";
    const rawPath = typeof row.path === "string" ? row.path.replace(/\/$/, "") : "";
    if (!rawPath || rawPath.includes("..") || !SAFE_SOURCE_PATH.test(rawPath)) continue;
    let candidate: string | undefined;
    if (type === "file" && name === "SKILL.md") candidate = rawPath;
    else if (type === "dir" && SAFE_BRANCH.test(name)) candidate = `${rawPath}/SKILL.md`;
    if (!candidate || !SAFE_SOURCE_PATH.test(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    paths.push(candidate);
  }
  return paths;
}

export async function resolveSkillMd(opts: {
  repo: string;
  skillBranch?: string;
  pinnedPaths?: readonly string[];
  fetchImpl: SkillFetch;
}): Promise<{ branch: string; sourcePath: string; text: string; url: string; tried: string[] }> {
  if (!SAFE_REPO.test(opts.repo)) throw new Error("repo 非法");
  const repoName = opts.repo.slice(opts.repo.indexOf("/") + 1);
  const branches = skillInstallBranches(opts.skillBranch);
  const staticCandidates = skillMdCandidatePaths(repoName, opts.pinnedPaths);
  const tried: string[] = [];
  const triedSet = new Set<string>();
  let authStatus: number | undefined;

  const mark = (branch: string, sourcePath: string): boolean => {
    const label = `${branch}/${sourcePath}`;
    if (triedSet.has(label)) return false;
    triedSet.add(label);
    tried.push(label);
    return true;
  };
  const noteAuth = (status: number) => {
    if (status === 401 || status === 403) authStatus = status;
  };

  for (const branch of branches) {
    for (const sourcePath of staticCandidates) {
      if (!mark(branch, sourcePath)) continue;
      const url = pinnedRawUrl(opts.repo, branch, sourcePath);
      assertAllowedRawUrl(url);
      const res = await opts.fetchImpl(url);
      noteAuth(res.status);
      if (!res.ok) continue;
      const text = await res.text();
      if (text.length > MAX_SKILL_CHARS) throw new Error("skill 文件过大");
      return { branch, sourcePath, text, url, tried };
    }

    try {
      const listingUrl = githubSkillsContentsApiUrl(opts.repo, branch);
      assertAllowedGithubApiUrl(listingUrl);
      const listing = await opts.fetchImpl(listingUrl);
      noteAuth(listing.status);
      if (!listing.ok) continue;
      const listed = parseSkillsListing(await listing.text());
      for (const sourcePath of listed) {
        if (!mark(branch, sourcePath)) continue;
        const url = pinnedRawUrl(opts.repo, branch, sourcePath);
        assertAllowedRawUrl(url);
        const res = await opts.fetchImpl(url);
        noteAuth(res.status);
        if (!res.ok) continue;
        const text = await res.text();
        if (text.length > MAX_SKILL_CHARS) throw new Error("skill 文件过大");
        return { branch, sourcePath, text, url, tried };
      }
    } catch (error) {
      if (error instanceof SkillResolveError) throw error;
      /* listing is optional; well-known paths already covered */
    }
  }

  if (authStatus) {
    throw new SkillResolveError("auth", formatSkillAuthDenied(authStatus), tried, authStatus);
  }

  let repoStatus: number | undefined;
  try {
    const metaUrl = githubRepoApiUrl(opts.repo);
    assertAllowedGithubApiUrl(metaUrl);
    const meta = await opts.fetchImpl(metaUrl);
    repoStatus = meta.status;
  } catch {
    repoStatus = undefined;
  }
  if (repoStatus === 401 || repoStatus === 403) {
    throw new SkillResolveError("auth", formatSkillAuthDenied(repoStatus), tried, repoStatus);
  }
  if (repoStatus === 404) {
    throw new SkillResolveError("repo_not_found", formatSkillRepoNotFound(opts.repo), tried, 404);
  }
  throw new SkillResolveError("skill_file_not_found", formatSkillFileNotFound(opts.repo, tried), tried, 404);
}

export function resolveSkillsDir(opts: {
  workdir: string;
  explicit?: string | null;
  env?: NodeJS.ProcessEnv;
  realHost: boolean;
}): string | undefined {
  if (opts.explicit === null) return undefined;
  if (typeof opts.explicit === "string" && opts.explicit.trim()) return resolve(opts.explicit.trim());
  if (!opts.realHost) return undefined;
  const fromEnv = opts.env?.AGENT_SKILLS_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  return resolve(opts.workdir, SKILLS_DIR_NAME);
}

export function skillsIndexPath(root: string): string {
  return join(root, SKILLS_INDEX_FILE);
}

export function skillDir(root: string, id: string): string {
  if (!SAFE_DEST.test(id)) throw new Error("skill id 非法");
  return join(root, id);
}

export async function readSkillsIndex(root: string): Promise<SkillsIndex> {
  try {
    const parsed = JSON.parse(await readFile(skillsIndexPath(root), "utf8")) as { skills?: unknown };
    if (!parsed || typeof parsed.skills !== "object" || parsed.skills == null || Array.isArray(parsed.skills)) {
      return { skills: {} };
    }
    const skills: Record<string, SkillIndexEntry> = {};
    for (const [id, raw] of Object.entries(parsed.skills as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      skills[id] = {
        id,
        kind: "skill",
        enabled: row.enabled !== false,
        ...(typeof row.repo === "string" ? { repo: row.repo } : {}),
        ...(typeof row.url === "string" ? { url: row.url } : {}),
        files: Array.isArray(row.files) ? row.files.map(String) : ["SKILL.md"],
        installedAt: typeof row.installedAt === "string" ? row.installedAt : "",
      };
    }
    return { skills };
  } catch {
    return { skills: {} };
  }
}

export async function writeSkillsIndex(root: string, index: SkillsIndex): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(skillsIndexPath(root), `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

export function publicSkillsView(index: SkillsIndex): Array<{ id: string; kind: "skill"; enabled: boolean }> {
  return Object.values(index.skills)
    .map((row) => ({ id: row.id, kind: "skill" as const, enabled: row.enabled }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function readSkillsIndexSync(root: string | undefined): SkillsIndex {
  if (!root) return { skills: {} };
  try {
    const parsed = JSON.parse(readFileSync(skillsIndexPath(root), "utf8")) as { skills?: unknown };
    if (!parsed || typeof parsed.skills !== "object" || parsed.skills == null || Array.isArray(parsed.skills)) {
      return { skills: {} };
    }
    const skills: Record<string, SkillIndexEntry> = {};
    for (const [id, raw] of Object.entries(parsed.skills as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      skills[id] = {
        id,
        kind: "skill",
        enabled: row.enabled !== false,
        ...(typeof row.repo === "string" ? { repo: row.repo } : {}),
        ...(typeof row.url === "string" ? { url: row.url } : {}),
        files: Array.isArray(row.files) ? row.files.map(String) : ["SKILL.md"],
        installedAt: typeof row.installedAt === "string" ? row.installedAt : "",
      };
    }
    return { skills };
  } catch {
    return { skills: {} };
  }
}

export function withEnabledSkills(prompt: string, root?: string): string {
  return appendEnabledSkills(prompt, loadEnabledSkillsSync(root));
}

export function wrapSkillForInject(id: string, body: string): string {
  const map = HOST_TOOL_NAME_MAP.map(([from, to]) => `${from} → ${to}`).join(", ");
  return (
    `\n\n<skill id="${id}" kind="skill">\n` +
    `Host tool-name map (wrapper only; skill body is unchanged): ${map}.\n` +
    `${body.trim()}\n` +
    `</skill>\n`
  );
}

export function appendEnabledSkills(systemPrompt: string, skills: LoadedSkill[]): string {
  if (!skills.length) return systemPrompt;
  return systemPrompt + skills.map((skill) => wrapSkillForInject(skill.id, skill.body)).join("");
}

export async function loadEnabledSkills(root: string | undefined): Promise<LoadedSkill[]> {
  if (!root) return [];
  const index = await readSkillsIndex(root);
  const loaded: LoadedSkill[] = [];
  for (const row of Object.values(index.skills)) {
    if (!row.enabled) continue;
    const files = row.files.length ? row.files : ["SKILL.md"];
    const parts: string[] = [];
    for (const dest of files) {
      if (dest.includes("..") || dest.includes("\\") || dest.includes("/") || dest.includes(sep)) continue;
      try {
        parts.push(await readFile(join(skillDir(root, row.id), dest), "utf8"));
      } catch {
        /* missing companion is skip, not fail-closed on the whole run */
      }
    }
    if (!parts.length) continue;
    loaded.push({
      id: row.id,
      kind: "skill",
      enabled: true,
      body: parts.join("\n\n"),
      files,
    });
  }
  return loaded;
}

export function pinnedRawUrl(repo: string, branch: string, sourcePath: string): string {
  if (!SAFE_REPO.test(repo)) throw new Error("repo 非法");
  if (!SAFE_BRANCH.test(branch)) throw new Error("branch 非法");
  if (!SAFE_SOURCE_PATH.test(sourcePath) || sourcePath.includes("..")) throw new Error("sourcePath 非法");
  return `https://raw.githubusercontent.com/${repo}/${branch}/${sourcePath}`;
}

export interface SkillInstallSpec {
  id: string;
  kind: "skill";
  repo: string;
  skillBranch?: string;
  skillFiles?: readonly SkillFileRef[];
}

export function skillFilesOf(entry: SkillInstallSpec): SkillFileRef[] {
  const listed = entry.skillFiles;
  if (listed?.length) return listed.map((file) => ({ ...file }));
  return [{ sourcePath: "SKILL.md", destName: "SKILL.md" }];
}

export function loadEnabledSkillsSync(root: string | undefined): LoadedSkill[] {
  if (!root) return [];
  try {
    const parsed = JSON.parse(readFileSync(skillsIndexPath(root), "utf8")) as { skills?: unknown };
    if (!parsed || typeof parsed.skills !== "object" || !parsed.skills || Array.isArray(parsed.skills)) return [];
    const loaded: LoadedSkill[] = [];
    for (const [id, raw] of Object.entries(parsed.skills as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      if (row.enabled === false) continue;
      const files = Array.isArray(row.files) ? row.files.map(String) : ["SKILL.md"];
      const parts: string[] = [];
      for (const dest of files) {
        if (dest.includes("..") || dest.includes("\\") || dest.includes("/")) continue;
        try {
          parts.push(readFileSync(join(skillDir(root, id), dest), "utf8"));
        } catch {
          /* skip missing companion */
        }
      }
      if (!parts.length) continue;
      loaded.push({ id, kind: "skill", enabled: true, body: parts.join("\n\n"), files });
    }
    return loaded;
  } catch {
    return [];
  }
}

export async function installCatalogSkill(opts: {
  root: string;
  entry: SkillInstallSpec;
  fetchImpl?: SkillFetch;
  now?: Date;
}): Promise<{ alreadyInstalled: boolean; writeTarget: string; files: string[] }> {
  if (opts.entry.kind !== "skill") throw new Error("不是 skill 条目");
  if (!opts.entry.repo) throw new Error("skill 条目缺少 repo");
  const id = opts.entry.id;
  const destDir = skillDir(opts.root, id);
  const index = await readSkillsIndex(opts.root);
  const existing = index.skills[id];
  const files = skillFilesOf(opts.entry);
  const skillMd = join(destDir, "SKILL.md");
  if (existing && existsSync(skillMd)) {
    if (!existing.enabled) {
      existing.enabled = true;
      await writeSkillsIndex(opts.root, index);
    }
    return { alreadyInstalled: true, writeTarget: destDir, files: existing.files };
  }

  const fetchImpl = opts.fetchImpl ?? defaultSkillFetch;
  const destName = files[0]?.destName ?? "SKILL.md";
  if (!SAFE_DEST.test(destName) || destName.includes(sep)) {
    throw new Error(`非法 destName: ${destName}`);
  }
  const resolved = await resolveSkillMd({
    repo: opts.entry.repo,
    ...(opts.entry.skillBranch ? { skillBranch: opts.entry.skillBranch } : {}),
    pinnedPaths: opts.entry.skillFiles?.map((file) => file.sourcePath) ?? [],
    fetchImpl,
  });
  await mkdir(destDir, { recursive: true });
  await writeFile(join(destDir, destName), resolved.text, "utf8");
  const written = [destName];
  index.skills[id] = {
    id,
    kind: "skill",
    enabled: true,
    repo: opts.entry.repo,
    url: `https://github.com/${opts.entry.repo}`,
    files: written,
    installedAt: (opts.now ?? new Date()).toISOString(),
  };
  await writeSkillsIndex(opts.root, index);
  return { alreadyInstalled: false, writeTarget: destDir, files: written };
}

export async function setSkillEnabled(root: string, id: string, enabled: boolean): Promise<SkillIndexEntry | undefined> {
  const index = await readSkillsIndex(root);
  const row = index.skills[id];
  if (!row) return undefined;
  row.enabled = enabled;
  await writeSkillsIndex(root, index);
  return row;
}

export async function uninstallSkill(root: string, id: string): Promise<void> {
  const index = await readSkillsIndex(root);
  delete index.skills[id];
  await writeSkillsIndex(root, index);
  try {
    await rm(skillDir(root, id), { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

export function assertSkillDirSafe(root: string, id: string): string {
  const dest = resolve(skillDir(root, id));
  const base = resolve(root);
  if (dest !== base && !dest.startsWith(base + sep) && !dest.startsWith(base + "/")) {
    throw new Error("skill 写入路径逃逸");
  }
  return dest;
}

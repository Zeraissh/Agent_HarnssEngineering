/**
 * Opt-in MCP / skill install catalog.
 *
 * This is the harness surface (`mcp.json` + Settings → MCP), not Cursor Marketplace.
 * Entries are recipes (command + env *names*), never binaries and never secrets.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  GITHUB_MCP_TOOLS_CSV,
  GITHUB_MCP_TOKEN_ENV,
  GITHUB_MCP_WRITE_TOOLS,
  githubMcpPermissionPolicy,
} from "./mcp-github.js";
import { applyMcpServerPatch, parseMcpConfigFile, serializeMcpConfig } from "../ui/mcp-config-file.js";
import {
  installCatalogSkill,
  readSkillsIndex,
  uninstallSkill,
  type SkillFetch,
} from "./skills.js";

export type CatalogKind = "mcp" | "skill";
export type CatalogSource = "github" | "preset";
export type CatalogAvailability = "ready" | "missing";

export interface McpSnippet {
  name: string;
  command?: string;
  args?: readonly string[];
  url?: string;
  env?: Record<string, string>;
  requiredEnv?: readonly string[];
}

export interface CatalogEntry {
  id: string;
  title: string;
  description: string;
  kind: CatalogKind;
  source: CatalogSource;
  availability: CatalogAvailability;
  repo?: string;
  mcpSnippet?: McpSnippet;
  /** Pinned skill files (kind=skill). destName is written under .agent-skills/<id>/. */
  skillFiles?: readonly { sourcePath: string; destName: string }[];
  skillBranch?: string;
  notes: string;
}

export interface CustomCatalogEntry {
  id: string;
  title: string;
  repo: string;
  url: string;
  kind: CatalogKind;
  recordedAt: string;
  notes: string;
}

export interface GithubRepoRef {
  owner: string;
  repo: string;
  url: string;
}

const ENV_PLACEHOLDER = /^\$\{[A-Z][A-Z0-9_]*\}$/;

export const SKILL_DIR_MISSING =
  "未配置 skill 目录（注入宿主须显式传 skillsDir；真实宿主默认 <workdir>/.agent-skills）。不会写入 mcp.json，也不会假装已安装。";

export const SKILL_KIND_REQUIRED =
  "这个 GitHub 仓库不在目录里。请说清 kind 是 mcp 还是 skill，或改用目录条目。";

export const SKILL_INSTALLED_HINT =
  "已写入 skill 文件并启用。将注入后续 run 的执行者 system prompt。AGENT_UI_MCP 与此无关。";

export const SKILL_ALREADY_HINT =
  "已经安装过，保持启用。将继续注入后续 run 的执行者 system prompt。";

export const MCP_NOT_STARTED_HINT =
  "已写入 mcp.json。当前宿主未开 AGENT_UI_MCP=1，Install 没有启动服务。";

export const MCP_WRITTEN_HINT =
  "已写入 mcp.json。下一次需要 MCP 的运行才会连接（不会立刻拉起进程）。";

export const CUSTOM_GITHUB_NOTE =
  "已记下 GitHub 仓库。没有可信 command/args，不会写入 mcp.json，也不会跑 curl|sh。请在设置里手填 stdio 命令，或换目录里的条目。";

/** Frozen id list — tests lock this exact order. */
export const MCP_CATALOG_IDS = [
  "feishu-lark",
  "slack",
  "github",
  "filesystem",
  "notion",
  "superpowers",
  "ppt-master",
  "google-workspace",
] as const;

export type CatalogId = (typeof MCP_CATALOG_IDS)[number];

export const MCP_CATALOG: readonly CatalogEntry[] = Object.freeze([
  Object.freeze({
    id: "feishu-lark",
    title: "飞书 / Lark OpenAPI",
    description: "飞书官方 OpenAPI MCP（文档、日历、会话等）。不是出站 IM 卡片。",
    kind: "mcp",
    source: "github",
    availability: "ready",
    repo: "larksuite/lark-openapi-mcp",
    mcpSnippet: Object.freeze({
      name: "lark-mcp",
      command: "npx",
      args: Object.freeze(["-y", "@larksuiteoapi/lark-mcp", "mcp"]),
      env: Object.freeze({ APP_ID: "${APP_ID}", APP_SECRET: "${APP_SECRET}" }),
      requiredEnv: Object.freeze(["APP_ID", "APP_SECRET"]),
    }),
    notes:
      "官方仓库 larksuite/lark-openapi-mcp。需要飞书应用 APP_ID / APP_SECRET（只写变量名，不填密钥）。出站 webhook（AGENT_FEISHU_WEBHOOK）是另一条 IM 卡片切片，装这条不会配置 webhook。",
  }),
  Object.freeze({
    id: "slack",
    title: "Slack",
    description: "MCP 组织参考 stdio 实现：读频道、发消息。不是 Slack Inc 托管的 HTTP MCP。",
    kind: "mcp",
    source: "github",
    availability: "ready",
    repo: "modelcontextprotocol/servers",
    mcpSnippet: Object.freeze({
      name: "slack",
      command: "npx",
      args: Object.freeze(["-y", "@modelcontextprotocol/server-slack"]),
      env: Object.freeze({
        SLACK_BOT_TOKEN: "${SLACK_BOT_TOKEN}",
        SLACK_TEAM_ID: "${SLACK_TEAM_ID}",
      }),
      requiredEnv: Object.freeze(["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"]),
    }),
    notes:
      "stdio 配方来自 MCP 参考实现，不是 Slack Inc 官方应用商店。Slack 官方是托管 HTTP（mcp.slack.com），本宿主只接 stdio，不会假装能连那条。Cursor 市场的 slack-skills-plugin 是 skill+远程 MCP 捆绑，这里装不成。",
  }),
  Object.freeze({
    id: "github",
    title: "GitHub",
    description: "官方 github/github-mcp-server（docker）。工作区连接器，不是某个领域包的私货。",
    kind: "mcp",
    source: "github",
    availability: "ready",
    repo: "github/github-mcp-server",
    mcpSnippet: Object.freeze({
      name: "github",
      command: "docker",
      args: Object.freeze([
        "run",
        "-i",
        "--rm",
        "-e",
        GITHUB_MCP_TOKEN_ENV,
        "-e",
        "GITHUB_TOOLS",
        "ghcr.io/github/github-mcp-server",
      ]),
      env: Object.freeze({
        [GITHUB_MCP_TOKEN_ENV]: `\${${GITHUB_MCP_TOKEN_ENV}}`,
        GITHUB_TOOLS: GITHUB_MCP_TOOLS_CSV,
      }),
      requiredEnv: Object.freeze([GITHUB_MCP_TOKEN_ENV]),
    }),
    notes: `官方镜像 ghcr.io/github/github-mcp-server。需要 ${GITHUB_MCP_TOKEN_ENV}（可用 GITHUB_TOKEN 别名）。已有 github 服务时只补缺，不拆掉 includeTools。`,
  }),
  Object.freeze({
    id: "filesystem",
    title: "Filesystem（可选 MCP）",
    description: "MCP 组织 filesystem server。本宿主已有圈禁的 read_file/write_file，这条是额外参考实现。",
    kind: "mcp",
    source: "github",
    availability: "ready",
    repo: "modelcontextprotocol/servers",
    mcpSnippet: Object.freeze({
      name: "filesystem",
      command: "npx",
      args: Object.freeze(["-y", "@modelcontextprotocol/server-filesystem"]),
    }),
    notes:
      "安装时把当前工作目录追加为唯一允许根。不是内置工具的替代。Gmail/Drive/AWS 等 Cursor 精选插件不在本目录——请粘贴 GitHub URL。",
  }),
  Object.freeze({
    id: "notion",
    title: "Notion",
    description: "Notion 官方本地 MCP（npx @notionhq/notion-mcp-server）。",
    kind: "mcp",
    source: "github",
    availability: "ready",
    repo: "makenotion/notion-mcp-server",
    mcpSnippet: Object.freeze({
      name: "notion",
      command: "npx",
      args: Object.freeze(["-y", "@notionhq/notion-mcp-server"]),
      env: Object.freeze({ NOTION_TOKEN: "${NOTION_TOKEN}" }),
      requiredEnv: Object.freeze(["NOTION_TOKEN"]),
    }),
    notes:
      "官方仓库 makenotion/notion-mcp-server。Notion 也在推远程 OAuth MCP；本宿主只写这条 stdio 配方。NOTION_TOKEN 只写占位符。",
  }),
  Object.freeze({
    id: "superpowers",
    title: "Superpowers",
    description: "obra/superpowers 是 skill/plugin，不是 stdio MCP，也不是 DomainPack。",
    kind: "skill",
    source: "github",
    availability: "ready",
    repo: "obra/superpowers",
    skillBranch: "main",
    skillFiles: Object.freeze([
      Object.freeze({ sourcePath: "skills/using-superpowers/SKILL.md", destName: "SKILL.md" }),
    ]),
    notes:
      "安装写入 .agent-skills/superpowers/SKILL.md（钉死 using-superpowers），启用后注入本 run 的执行者 system prompt。工具名对照只在包装层：Read→read_file 等，不改 SKILL.md 正文。AGENT_UI_MCP 与此无关。不会新增 pack: superpowers。",
  }),
  Object.freeze({
    id: "ppt-master",
    title: "ppt-master",
    description: "hugohe3/ppt-master：可编辑 PPTX 幻灯 skill（路由式工作流），不是 stdio MCP。",
    kind: "skill",
    source: "github",
    availability: "ready",
    repo: "hugohe3/ppt-master",
    skillBranch: "main",
    skillFiles: Object.freeze([
      Object.freeze({ sourcePath: "skills/ppt-master/SKILL.md", destName: "SKILL.md" }),
    ]),
    notes:
      "安装写入 .agent-skills/ppt-master/SKILL.md（钉死 skills/ppt-master）。启用后注入执行者 system prompt。AGENT_UI_MCP 与此无关。不下载执行安装脚本，也不会新增 pack。",
  }),
  Object.freeze({
    id: "google-workspace",
    title: "Google Workspace",
    description: "Gmail / Calendar / Drive 不在本目录。没有可引用的官方 stdio MCP 配方。",
    kind: "mcp",
    source: "github",
    availability: "missing",
    notes:
      "不收录未经核实的 Workspace / AWS 官方插件，也不会从 Cursor Marketplace 搬运。请粘贴可信 GitHub URL，并说清是 mcp 还是 skill。",
  }),
]);

export function getCatalogEntry(id: string): CatalogEntry | undefined {
  return MCP_CATALOG.find((entry) => entry.id === id);
}

export function findCatalogByRepo(ownerRepo: string): CatalogEntry | undefined {
  const key = ownerRepo.replace(/^\//, "").toLowerCase();
  return MCP_CATALOG.find((entry) => entry.repo?.toLowerCase() === key);
}

export function skillInstallRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.AGENT_SKILLS_DIR?.trim();
  return raw || undefined;
}

export function customCatalogPath(mcpConfigPath: string): string {
  return join(dirname(mcpConfigPath), "mcp-catalog-custom.json");
}

export function parseGithubRepoUrl(raw: string): GithubRepoRef | { error: string } {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { error: "缺少 GitHub URL" };
  if (/[\u0000-\u001F]/.test(trimmed)) return { error: "URL 含控制字符" };
  if (/^(javascript|data|file|vbscript):/i.test(trimmed)) return { error: "拒绝非 https 协议" };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: "不是合法 URL" };
  }
  if (parsed.protocol !== "https:") return { error: "只允许 https://github.com/owner/repo" };
  if (parsed.username || parsed.password) return { error: "拒绝带用户信息的 URL" };
  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return { error: "只允许 github.com" };
  if (parsed.port) return { error: "拒绝带端口的 GitHub URL" };
  const parts = parsed.pathname.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  if (parts.length !== 2) return { error: "只要 https://github.com/owner/repo，不要子路径" };
  const owner = parts[0]!;
  let repo = parts[1]!;
  if (repo.toLowerCase().endsWith(".git")) repo = repo.slice(0, -4);
  if (owner === "." || owner === ".." || repo === "." || repo === "..") {
    return { error: "拒绝路径逃逸" };
  }
  if (owner.includes("\\") || repo.includes("\\") || owner.includes("/") || repo.includes("/")) {
    return { error: "拒绝路径逃逸" };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
    return { error: "owner/repo 含非法字符" };
  }
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

export function snippetEnvIsSafe(env: Record<string, string> | undefined): boolean {
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!key.trim()) return false;
    if (key === "GITHUB_TOOLS") {
      if (!/^[A-Za-z0-9_,]+$/.test(value)) return false;
      continue;
    }
    if (value !== "" && !ENV_PLACEHOLDER.test(value)) return false;
  }
  return true;
}

export function catalogHasNoSecrets(entries: readonly CatalogEntry[] = MCP_CATALOG): boolean {
  const banned = /sk-|ntn_|xox[bap]-|Bearer\s+[A-Za-z0-9]|hooks\.slack|feishu\.cn\/open-apis\/bot/i;
  for (const entry of entries) {
    const blob = JSON.stringify(entry);
    if (banned.test(blob)) return false;
    if (entry.mcpSnippet && !snippetEnvIsSafe(entry.mcpSnippet.env)) return false;
  }
  return true;
}

export function publicCatalogEntries(): Array<Record<string, unknown>> {
  return MCP_CATALOG.map((entry) => ({
    id: entry.id,
    title: entry.title,
    description: entry.description,
    kind: entry.kind,
    source: entry.source,
    availability: entry.availability,
    ...(entry.repo ? { repo: entry.repo } : {}),
    ...(entry.mcpSnippet
      ? {
          mcpSnippet: {
            name: entry.mcpSnippet.name,
            ...(entry.mcpSnippet.command ? { command: entry.mcpSnippet.command } : {}),
            ...(entry.mcpSnippet.args ? { args: [...entry.mcpSnippet.args] } : {}),
            ...(entry.mcpSnippet.url ? { url: entry.mcpSnippet.url } : {}),
            ...(entry.mcpSnippet.env ? { env: { ...entry.mcpSnippet.env } } : {}),
            ...(entry.mcpSnippet.requiredEnv ? { requiredEnv: [...entry.mcpSnippet.requiredEnv] } : {}),
          },
        }
      : {}),
    ...(entry.skillFiles ? { skillFiles: entry.skillFiles.map((file) => ({ ...file })) } : {}),
    notes: entry.notes,
  }));
}

export function installedCatalogIdsFrom(servers: Record<string, unknown>): string[] {
  const names = new Set(Object.keys(servers));
  return MCP_CATALOG.filter((entry) => entry.mcpSnippet && names.has(entry.mcpSnippet.name)).map(
    (entry) => entry.id,
  );
}

export function combinedInstalledCatalogIds(
  servers: Record<string, unknown>,
  skillIds: readonly string[],
): string[] {
  const fromSkills = skillIds.filter((id) => Boolean(getCatalogEntry(id)));
  return [...new Set([...installedCatalogIdsFrom(servers), ...fromSkills])].sort();
}

export function resolveInstallSnippet(
  entry: CatalogEntry,
  ctx: { workdir: string },
): McpSnippet | undefined {
  const snippet = entry.mcpSnippet;
  if (!snippet) return undefined;
  if (entry.id === "filesystem") {
    return { ...snippet, args: [...(snippet.args ?? []), ctx.workdir] };
  }
  return snippet;
}

export function mergeCatalogSnippet(
  current: Record<string, unknown>,
  snippet: McpSnippet,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!snippetEnvIsSafe(snippet.env)) {
    throw new Error("目录配方的 env 只允许 ${VAR} 占位符");
  }
  const name = snippet.name;
  const existing = current[name];
  const had = Boolean(existing && typeof existing === "object" && !Array.isArray(existing));
  if (had) {
    const prev = existing as Record<string, unknown>;
    const prevEnv =
      prev.env && typeof prev.env === "object" && !Array.isArray(prev.env)
        ? { ...(prev.env as Record<string, string>) }
        : {};
    return applyMcpServerPatch(current, name, {
      env: { ...prevEnv, ...(snippet.env ?? {}) },
      enabled: true,
      permission: prev.permission === "auto" ? "auto" : "ask",
    });
  }
  const next = applyMcpServerPatch(current, name, {
    ...(snippet.command ? { command: snippet.command } : {}),
    ...(snippet.args ? { args: [...snippet.args] } : {}),
    ...(snippet.url ? { url: snippet.url } : {}),
    ...(snippet.env ? { env: { ...snippet.env } } : {}),
    ...(snippet.requiredEnv ? { requiredEnv: [...snippet.requiredEnv] } : {}),
    permission: "ask",
    enabled: true,
  });
  if (Object.keys(extras).length) {
    const row = next[name];
    if (row && typeof row === "object" && !Array.isArray(row)) {
      next[name] = { ...row, ...extras };
    }
  }
  return next;
}

function extrasForNewServer(entry: CatalogEntry): Record<string, unknown> {
  if (entry.id !== "github") return {};
  const policy = githubMcpPermissionPolicy();
  return {
    ...policy,
    parallelSafe: true,
    sideEffectTools: [...GITHUB_MCP_WRITE_TOOLS],
  };
}

export async function readCustomCatalog(path: string): Promise<CustomCatalogEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { entries?: unknown };
    if (!parsed || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      if (typeof row.id !== "string" || typeof row.url !== "string") return [];
      return [{
        id: row.id,
        title: typeof row.title === "string" ? row.title : row.id,
        repo: typeof row.repo === "string" ? row.repo : "",
        url: row.url,
        kind: row.kind === "skill" ? "skill" : "mcp",
        recordedAt: typeof row.recordedAt === "string" ? row.recordedAt : "",
        notes: typeof row.notes === "string" ? row.notes : "",
      }];
    });
  } catch {
    return [];
  }
}

export async function writeCustomCatalog(path: string, entries: CustomCatalogEntry[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
}

function customId(owner: string, repo: string): string {
  return `custom-${owner}-${repo}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
}

export type CatalogActionResult = {
  ok: boolean;
  installed: boolean;
  recorded: boolean;
  alreadyInstalled?: boolean;
  kind?: CatalogKind;
  catalogId?: string;
  serverName?: string;
  writeTarget?: string;
  pointerPath?: string;
  message: string;
  error?: string;
  servers?: Record<string, unknown>;
  custom?: CustomCatalogEntry[];
};

async function loadServers(configPath: string): Promise<Record<string, unknown>> {
  try {
    return parseMcpConfigFile(await readFile(configPath, "utf8")).servers;
  } catch {
    return {};
  }
}

async function saveServers(configPath: string, servers: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, serializeMcpConfig(servers), "utf8");
}

export async function performCatalogInstall(opts: {
  configPath: string;
  workdir: string;
  confirm: boolean;
  writesArmed: boolean;
  catalogId?: string;
  githubUrl?: string;
  kind?: CatalogKind;
  skillRoot?: string;
  fetchImpl?: SkillFetch;
  now?: Date;
}): Promise<CatalogActionResult> {
  if (!opts.confirm) {
    return { ok: false, installed: false, recorded: false, message: "需要 confirm: true", error: "需要 confirm: true" };
  }

  let entry = opts.catalogId ? getCatalogEntry(opts.catalogId) : undefined;
  let github: GithubRepoRef | undefined;
  if (opts.githubUrl) {
    const parsed = parseGithubRepoUrl(opts.githubUrl);
    if ("error" in parsed) {
      return { ok: false, installed: false, recorded: false, message: parsed.error, error: parsed.error };
    }
    github = parsed;
    const byRepo = findCatalogByRepo(`${parsed.owner}/${parsed.repo}`);
    if (entry && byRepo && entry.id !== byRepo.id) {
      return {
        ok: false,
        installed: false,
        recorded: false,
        message: "catalogId 与 githubUrl 指向不同条目",
        error: "catalogId 与 githubUrl 指向不同条目",
      };
    }
    entry = entry ?? byRepo;
  }

  if (!entry && !github) {
    return { ok: false, installed: false, recorded: false, message: "需要 catalogId 或 githubUrl", error: "需要 catalogId 或 githubUrl" };
  }

  if (entry?.availability === "missing") {
    return {
      ok: false,
      installed: false,
      recorded: false,
      kind: entry.kind,
      catalogId: entry.id,
      message: entry.notes,
      error: entry.notes,
    };
  }

  const kind: CatalogKind | undefined = entry?.kind ?? opts.kind;
  if (!entry && github && kind !== "mcp" && kind !== "skill") {
    return { ok: false, installed: false, recorded: false, message: SKILL_KIND_REQUIRED, error: SKILL_KIND_REQUIRED };
  }

  if (kind === "skill") {
    if (!opts.skillRoot) {
      return { ok: false, installed: false, recorded: false, kind: "skill", message: SKILL_DIR_MISSING, error: SKILL_DIR_MISSING };
    }
    const spec = entry && entry.repo
      ? {
          id: entry.id,
          kind: "skill" as const,
          repo: entry.repo,
          ...(entry.skillBranch ? { skillBranch: entry.skillBranch } : {}),
          ...(entry.skillFiles ? { skillFiles: entry.skillFiles } : {}),
        }
      : github
        ? { id: customId(github.owner, github.repo), kind: "skill" as const, repo: `${github.owner}/${github.repo}` }
        : undefined;
    if (!spec) {
      return { ok: false, installed: false, recorded: false, kind: "skill", message: "skill 条目缺少 repo", error: "skill 条目缺少 repo" };
    }
    try {
      const written = await installCatalogSkill({
        root: opts.skillRoot,
        entry: spec,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      });
      return {
        ok: true,
        installed: true,
        recorded: false,
        alreadyInstalled: written.alreadyInstalled,
        kind: "skill",
        catalogId: spec.id,
        writeTarget: written.writeTarget,
        message: written.alreadyInstalled ? SKILL_ALREADY_HINT : SKILL_INSTALLED_HINT,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, installed: false, recorded: false, kind: "skill", message, error: message };
    }
  }

  if (!opts.writesArmed) {
    return {
      ok: false,
      installed: false,
      recorded: false,
      message: "注入宿主未指定 mcpConfigFile，拒绝写操作员 mcp.json",
      error: "注入宿主未指定 mcpConfigFile，拒绝写操作员 mcp.json",
    };
  }

  if (entry?.kind === "mcp" && entry.mcpSnippet) {
    const snippet = resolveInstallSnippet(entry, { workdir: opts.workdir });
    if (!snippet) {
      return { ok: false, installed: false, recorded: false, message: "条目没有可写的 MCP 配方", error: "条目没有可写的 MCP 配方" };
    }
    const current = await loadServers(opts.configPath);
    const had = Boolean(current[snippet.name]);
    const servers = mergeCatalogSnippet(current, snippet, had ? {} : extrasForNewServer(entry));
    await saveServers(opts.configPath, servers);
    return {
      ok: true,
      installed: true,
      recorded: false,
      kind: "mcp",
      catalogId: entry.id,
      serverName: snippet.name,
      message: MCP_WRITTEN_HINT,
      servers,
    };
  }

  if (github) {
    const customPath = customCatalogPath(opts.configPath);
    const custom = await readCustomCatalog(customPath);
    const record: CustomCatalogEntry = {
      id: customId(github.owner, github.repo),
      title: `${github.owner}/${github.repo}`,
      repo: `${github.owner}/${github.repo}`,
      url: github.url,
      kind: "mcp",
      recordedAt: (opts.now ?? new Date()).toISOString(),
      notes: CUSTOM_GITHUB_NOTE,
    };
    const nextCustom = [...custom.filter((row) => row.id !== record.id), record];
    await writeCustomCatalog(customPath, nextCustom);
    return {
      ok: true,
      installed: false,
      recorded: true,
      kind: "mcp",
      catalogId: record.id,
      message: CUSTOM_GITHUB_NOTE,
      custom: nextCustom,
    };
  }

  return { ok: false, installed: false, recorded: false, message: "无法安装该条目", error: "无法安装该条目" };
}

export async function performCatalogUninstall(opts: {
  configPath: string;
  confirm: boolean;
  writesArmed: boolean;
  catalogId?: string;
  name?: string;
  skillRoot?: string;
}): Promise<CatalogActionResult> {
  if (!opts.confirm) {
    return { ok: false, installed: false, recorded: false, message: "需要 confirm: true", error: "需要 confirm: true" };
  }
  const entry = opts.catalogId ? getCatalogEntry(opts.catalogId) : undefined;
  const skillId = entry?.kind === "skill" ? entry.id : opts.catalogId;
  const skillOnDisk = Boolean(
    opts.skillRoot && skillId && (await readSkillsIndex(opts.skillRoot)).skills[skillId],
  );
  if (entry?.kind === "skill" || skillOnDisk) {
    if (!opts.skillRoot) {
      return { ok: false, installed: false, recorded: false, kind: "skill", message: SKILL_DIR_MISSING, error: SKILL_DIR_MISSING };
    }
    await uninstallSkill(opts.skillRoot, skillId!);
    return {
      ok: true,
      installed: false,
      recorded: false,
      kind: "skill",
      catalogId: skillId,
      message: `已移除 skill ${skillId}`,
    };
  }
  if (!opts.writesArmed) {
    return {
      ok: false,
      installed: false,
      recorded: false,
      message: "注入宿主未指定 mcpConfigFile，拒绝写操作员 mcp.json",
      error: "注入宿主未指定 mcpConfigFile，拒绝写操作员 mcp.json",
    };
  }
  const serverName = opts.name?.trim() || entry?.mcpSnippet?.name;
  const current = await loadServers(opts.configPath);
  let servers = current;
  if (serverName && current[serverName]) {
    servers = applyMcpServerPatch(current, serverName, null);
    await saveServers(opts.configPath, servers);
  }
  const customPath = customCatalogPath(opts.configPath);
  const custom = await readCustomCatalog(customPath);
  const nextCustom = opts.catalogId ? custom.filter((row) => row.id !== opts.catalogId) : custom;
  if (nextCustom.length !== custom.length) {
    await writeCustomCatalog(customPath, nextCustom);
  }
  return {
    ok: true,
    installed: false,
    recorded: false,
    kind: entry?.kind,
    catalogId: opts.catalogId,
    serverName,
    message: serverName ? `已从 mcp.json 移除 ${serverName}` : "已从目录记录里移除",
    servers,
    custom: nextCustom,
  };
}

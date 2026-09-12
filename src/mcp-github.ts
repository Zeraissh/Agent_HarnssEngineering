/**
 * GitHub MCP（官方 github/github-mcp-server）的连接层白名单。
 *
 * GitHub 是**工作区连接器**，不是 ts-coding 的私货：仓库/分支跟工作目录走，
 * 换包不该让「我在哪个仓库」和远端工具一起消失。硬件独占包（stm32-debug）
 * 仍不叠加，以免冲掉刻意留白的工具面。
 */
import { applyMcpPackPermission, originalMcpToolName } from "./mcp.js";
import type { ToolPermission } from "./permission-mode.js";
import type { Tool } from "./types.js";

export const GITHUB_MCP_SERVER = "github";

/** 官方 server 认的 PAT 环境变量名。 */
export const GITHUB_MCP_TOKEN_ENV = "GITHUB_PERSONAL_ACCESS_TOKEN";

export const GITHUB_MCP_READ_TOOLS = [
  "get_me",
  "get_file_contents",
  "get_repository_tree",
  "search_code",
  "search_repositories",
  "list_issues",
  "issue_read",
  "list_pull_requests",
  "pull_request_read",
  "list_commits",
  "get_commit",
] as const;

export const GITHUB_MCP_WRITE_TOOLS = [
  "create_branch",
  "create_pull_request",
  "add_issue_comment",
  "issue_write",
] as const;

export const GITHUB_MCP_TOOLS = [...GITHUB_MCP_READ_TOOLS, ...GITHUB_MCP_WRITE_TOOLS] as const;

export type GithubMcpTool = (typeof GITHUB_MCP_TOOLS)[number];

/** 给 docker `-e GITHUB_TOOLS=` / 官方 `--tools` 用的逗号串。 */
export const GITHUB_MCP_TOOLS_CSV = GITHUB_MCP_TOOLS.join(",");

export function githubMcpPermissionPolicy(): {
  permission: "ask";
  toolPermissions: Record<string, ToolPermission>;
  includeTools: string[];
} {
  return {
    permission: "ask",
    toolPermissions: {
      ...Object.fromEntries(GITHUB_MCP_READ_TOOLS.map((name) => [name, "auto" as const])),
      ...Object.fromEntries(GITHUB_MCP_WRITE_TOOLS.map((name) => [name, "ask" as const])),
    },
    includeTools: [...GITHUB_MCP_TOOLS],
  };
}

const HOST_GITHUB_DENY_PACKS = new Set(["stm32-debug"]);

/** 硬件独占包不叠 GitHub；其余包（含 mcp:false）和工作区无包都接。 */
export function packAcceptsHostGithub(pack?: { name?: string } | null): boolean {
  const name = pack?.name;
  if (name && HOST_GITHUB_DENY_PACKS.has(name)) return false;
  return true;
}

export function mergeHostGithubTools(
  pack: { name?: string } | undefined,
  selected: Tool[],
  mcpPool: Tool[],
): Tool[] {
  if (!packAcceptsHostGithub(pack)) return selected;
  const have = new Set(selected.map((tool) => tool.name));
  const policy = githubMcpPermissionPolicy();
  const allow = new Set<string>(GITHUB_MCP_TOOLS);
  const added: Tool[] = [];
  for (const tool of mcpPool) {
    const raw = originalMcpToolName(tool) ?? tool.name.split("__").slice(1).join("__");
    if (!allow.has(raw) || have.has(tool.name)) continue;
    added.push(applyMcpPackPermission(tool, raw, policy));
    have.add(tool.name);
  }
  return added.length ? [...selected, ...added] : selected;
}

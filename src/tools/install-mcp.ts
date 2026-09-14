/**
 * Host-gated catalog / GitHub MCP or skill install.
 * MCP → merge mcp.json. Skill → write .agent-skills/<id>/ and inject later.
 * permission: ask. Does not run curl|sh. Superpowers is a skill, not an MCP.
 */
import type { Tool } from "../types.js";
import {
  MCP_CATALOG_IDS,
  MCP_NOT_STARTED_HINT,
  MCP_WRITTEN_HINT,
  performCatalogInstall,
  type CatalogKind,
} from "../mcp-catalog.js";
import type { SkillFetch } from "../skills.js";

export function installMcpTool(opts: {
  configPath: string;
  workdir: string;
  writesArmed: boolean;
  mcpEnabled?: boolean;
  skillRoot?: string;
  fetchImpl?: SkillFetch;
}): Tool {
  const skillRoot = opts.skillRoot;
  return {
    name: "install_mcp",
    description:
      "Install an optional catalog item after the user confirmed (approval rail). " +
      `Known catalog ids: ${MCP_CATALOG_IDS.join(", ")}. ` +
      "kind=mcp writes/merges mcp.json (does not start the server; Web host still needs AGENT_UI_MCP=1). " +
      "kind=skill writes SKILL.md under the harness skills dir and enables prompt inject; MCP off does not block skills. " +
      "Superpowers (obra/superpowers) is a skill, never a DomainPack and never an MCP. " +
      "Custom GitHub URL: only https://github.com/owner/repo; if it is not in the catalog you MUST pass kind=mcp or kind=skill. " +
      "kind=skill looks for SKILL.md at pinned path, repo root, skills/, skills/<repo>/, then public skills/* (no token); file 404 lists paths tried and is not a missing-repo error. " +
      "Never invent Gmail/Drive/AWS official plugins. Never run curl|sh. " +
      "For the approval card include catalogId, kind, githubUrl/repo, and writeTarget when known. Set confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        catalogId: {
          type: "string",
          description: `Frozen catalog id (${MCP_CATALOG_IDS.join(" | ")})`,
        },
        githubUrl: {
          type: "string",
          description: "https://github.com/owner/repo only.",
        },
        kind: {
          type: "string",
          enum: ["mcp", "skill"],
          description: "Required when the GitHub URL is not in the catalog.",
        },
        writeTarget: {
          type: "string",
          description: "Intended write path for the approval card (e.g. .agent-skills/superpowers).",
        },
        confirm: {
          type: "boolean",
          description: "Must be true after the user confirmed this install in the current turn.",
        },
      },
    },
    permission: "ask",
    parallelSafe: false,
    approvalPolicy: { maxScope: "once" },
    async execute(input) {
      const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
      const kind = o.kind === "skill" || o.kind === "mcp" ? (o.kind as CatalogKind) : undefined;
      const result = await performCatalogInstall({
        configPath: opts.configPath,
        workdir: opts.workdir,
        writesArmed: opts.writesArmed,
        confirm: o.confirm === true,
        ...(typeof o.catalogId === "string" ? { catalogId: o.catalogId } : {}),
        ...(typeof o.githubUrl === "string" ? { githubUrl: o.githubUrl } : {}),
        ...(kind ? { kind } : {}),
        ...(skillRoot ? { skillRoot } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
      if (!result.ok) {
        return { content: result.error ?? result.message, isError: true };
      }
      const enabledHint = result.kind === "skill"
        ? result.message
        : result.installed
          ? (opts.mcpEnabled ? MCP_WRITTEN_HINT : MCP_NOT_STARTED_HINT)
          : result.message;
      return {
        content:
          `${enabledHint}\n` +
          `installed=${result.installed} recorded=${result.recorded}` +
          (result.alreadyInstalled ? " alreadyInstalled=true" : "") +
          (result.kind ? ` kind=${result.kind}` : "") +
          (result.catalogId ? ` catalogId=${result.catalogId}` : "") +
          (result.serverName ? ` server=${result.serverName}` : "") +
          (result.writeTarget ? ` writeTarget=${result.writeTarget}` : ""),
      };
    },
  };
}

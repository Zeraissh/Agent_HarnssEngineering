/**
 * 起草文件领域包。只写 drafts/，不安装、不进 getPack。
 *
 * 薄字段：name / description / systemPrompt / verifyInstructions。
 * 工具面、MCP、资源、核查预算一律保守缺省——扩权只能人改 pack.json 再签字。
 */
import type { Tool } from "../types.js";
import { writeDraftPack, packsRootFromEnv } from "../pack-files.js";

export function draftDomainPackTool(root = packsRootFromEnv()): Tool {
  return {
    name: "draft_domain_pack",
    description:
      "Draft a domain pack as files under drafts/ (name, description, working loop, optional verify notes). " +
      "Does not install it. The operator must approve the draft in Settings before it can be selected. " +
      "Do not use this for casual chat. Conservative defaults: no MCP, no probe lock, verify off, no bash/network.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "kebab-case id, e.g. thermocouple-consult. Cannot shadow a builtin pack.",
        },
        description: {
          type: "string",
          description: "One sentence: domain and typical deliverable.",
        },
        systemPrompt: {
          type: "string",
          description: "Working loop and golden rules. Do not claim unmeasured budgets or tool lists.",
        },
        verifyInstructions: {
          type: "string",
          description: "Optional: how a verifier would independently check. Verify stays off until a human enables it.",
        },
      },
      required: ["name", "description", "systemPrompt"],
    },
    permission: "ask",
    parallelSafe: false,
    async execute(input) {
      const o = input && typeof input === "object" ? input as Record<string, unknown> : {};
      try {
        const rec = await writeDraftPack(root, {
          name: String(o.name ?? ""),
          description: String(o.description ?? ""),
          systemPrompt: String(o.systemPrompt ?? ""),
          ...(typeof o.verifyInstructions === "string"
            ? { verifyInstructions: o.verifyInstructions }
            : {}),
        });
        return {
          content:
            `Draft written: ${rec.dir}\n` +
            `status=draft measured=false tools=${rec.manifest.builtinTools.join(",")}\n` +
            `mcp=false verify.enabled=false\n` +
            `Not selectable until the operator installs it in Settings → 领域包.`,
        };
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  };
}

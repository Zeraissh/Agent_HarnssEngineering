/**
 * `propose_handoff`：记下「要不要按这个根因接着做」，立刻返回。
 *
 * 与 ask_user 相反——不挂起 loop、不等人。界面出一张提示卡，对话继续。
 * 同意之后由宿主开新 run；模型不得把「切包」写成正文选择题。
 */
import { findPackHandoff, type PackHandoff } from "../handoff.js";
import type { Tool } from "../types.js";

export const PROPOSE_HANDOFF_TOOL_NAME = "propose_handoff";

export function withoutProposeHandoff<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((t) => t.name !== PROPOSE_HANDOFF_TOOL_NAME);
}

export interface HandoffProposalRecord {
  handoffId: string;
  summary: string;
  label: string;
  declineLabel: string;
}

export interface ProposeHandoffOptions {
  resolveHandoff: (id: string) => PackHandoff | null;
  onPropose: (proposal: HandoffProposalRecord) => void;
}

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function createProposeHandoffTool(opts: ProposeHandoffOptions): Tool {
  return {
    name: PROPOSE_HANDOFF_TOOL_NAME,
    description:
      "当你已经有可引用的固件根因，且下一步必须改源码并重新烧录复测时调用。" +
      "立刻返回，不打断对话；委托方会在界面上看到一张「要不要接着做」的提示卡。" +
      "不要在正文里问要不要切包，也不要写出领域包名字。" +
      "闲聊、只有模糊怀疑、或下一步仍是同板观察时不要调用。",
    inputSchema: {
      type: "object",
      properties: {
        handoff: {
          type: "string",
          description: "提议种类。当前仅 fix_then_verify（改固件再上板复测）。",
        },
        summary: {
          type: "string",
          description:
            "一句可核对的根因（文件:行、寄存器实测 vs 规格，或同等证据）。不要写包名。",
        },
      },
      required: ["handoff", "summary"],
    },
    permission: "auto",
    parallelSafe: true,
    async execute(input) {
      const handoffId = asNonEmptyString((input as { handoff?: unknown })?.handoff);
      const summary = asNonEmptyString((input as { summary?: unknown })?.summary);
      if (!handoffId) {
        return { content: "handoff 不能为空。", isError: true };
      }
      if (!summary) {
        return {
          content: "summary 必须是一句可引用的根因。模糊怀疑不要提议。",
          isError: true,
        };
      }
      const spec = opts.resolveHandoff(handoffId);
      if (!spec) {
        return {
          content: `未知的下一步种类 "${handoffId}"。不要再试这个值。`,
          isError: true,
        };
      }
      opts.onPropose({
        handoffId: spec.id,
        summary,
        label: spec.label,
        declineLabel: spec.declineLabel,
      });
      return {
        content:
          `已记下下一步提议，对话继续。委托方会看到「${spec.label}」和「${spec.declineLabel}」。` +
          "在他们点同意之前，不要假定已经换了工作世界；把这次调试收口即可。",
      };
    },
  };
}

/** 给测试与宿主复用：按包名单解析（找不到即 null） */
export function resolvePackHandoff(
  pack: { handoffs?: PackHandoff[] } | undefined,
  id: string,
): PackHandoff | null {
  return findPackHandoff(pack, id);
}

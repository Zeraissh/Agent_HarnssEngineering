/**
 * 战役 mailbox：导演写给子对话的字条。
 *
 * payload 只有任务书与产物路径。子正史不进 mailbox——整场 transcript
 * 是给人看的战役视图，不是每个子对话的 first-turn。
 */
import {
  isMailboxAction,
  parseMailboxAction,
  type MailboxAction,
  type MailboxActionKind,
} from "../campaign.js";
import type { Tool } from "../types.js";

export const CAMPAIGN_MAIL_TOOL_NAME = "campaign_mail";

export interface CampaignMailOptions {
  append: (childRunId: string, action: MailboxAction) => Promise<void> | void;
}

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
}

export function createCampaignMailTool(opts: CampaignMailOptions): Tool {
  return {
    name: CAMPAIGN_MAIL_TOOL_NAME,
    description:
      "给战役子对话写 mailbox：assign / follow_up / cancel / redispatch。" +
      "只写任务书与产物路径，不要粘贴子对话正史。",
    inputSchema: {
      type: "object",
      properties: {
        childRunId: { type: "string", description: "子对话 runId" },
        action: {
          type: "string",
          enum: ["assign", "follow_up", "cancel", "redispatch"],
        },
        task: { type: "string", description: "任务书或跟进说明（不是正史）" },
        artifacts: {
          type: "array",
          items: { type: "string" },
          description: "产物路径",
        },
      },
      required: ["childRunId", "action", "task"],
    },
    permission: "auto",
    parallelSafe: true,
    async execute(input) {
      const childRunId = asNonEmptyString((input as { childRunId?: unknown })?.childRunId);
      const actionRaw = asNonEmptyString((input as { action?: unknown })?.action);
      const task = asNonEmptyString((input as { task?: unknown })?.task);
      const artifacts = asStringList((input as { artifacts?: unknown })?.artifacts);
      if (!childRunId) return { content: "childRunId 不能为空。", isError: true };
      if (!isMailboxAction(actionRaw)) {
        return { content: "action 必须是 assign / follow_up / cancel / redispatch。", isError: true };
      }
      if (!task) return { content: "task 必须是任务书或跟进说明，不能写子正史。", isError: true };
      const action = parseMailboxAction({
        action: actionRaw as MailboxActionKind,
        task,
        artifacts,
        at: Date.now(),
      });
      if (!action) return { content: "mailbox 条目不合法。", isError: true };
      try {
        await opts.append(childRunId, action);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: `mailbox 写入失败：${message}`, isError: true };
      }
      const arts = action.artifacts.length ? `；产物 ${action.artifacts.join("、")}` : "";
      return { content: `已写入 mailbox（${action.action} → ${childRunId}）${arts}` };
    },
  };
}

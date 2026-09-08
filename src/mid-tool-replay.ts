/**
 * SAFE-06 / RUN-02 — mid-tool 自动重放计划（纯函数）。
 *
 * 崩溃若落在 tool_prepared/running 之后、committed 之前：正史末条可能是
 * 悬空 tool_use 的 assistant。同 run 恢复时：
 * - idempotent_retry（write_file 等）→ 列入重放，由 ToolExecutor 再入
 * - fail_closed_no_retry（bash）→ 不重放，产出 is_error 回执（与 P6 补洞同构）
 * - 已 committed → 跳过（回缓存结果由执行器处理）
 */
import type Anthropic from "@anthropic-ai/sdk";
import {
  decideToolTxReplay,
  toolIdempotencyKey,
  canonicalInputHash,
  type DurableToolTx,
} from "./tool-tx.js";

export type MidToolReplayItem =
  | {
      action: "replay";
      toolUseId: string;
      name: string;
      input: unknown;
      idempotencyKey: string;
    }
  | {
      action: "synthesize_error";
      toolUseId: string;
      name: string;
      content: string;
    }
  | {
      action: "skip_committed";
      toolUseId: string;
      name: string;
      content: string;
      isError?: boolean;
    };

export function planMidToolReplay(input: {
  runId: string;
  /** 正史末条若为含 tool_use 的 assistant，抽出其块 */
  pendingToolUses: Array<{ id: string; name: string; input: unknown }>;
  toolTx: readonly DurableToolTx[];
}): MidToolReplayItem[] {
  const out: MidToolReplayItem[] = [];
  for (const block of input.pendingToolUses) {
    const key = toolIdempotencyKey(input.runId, block.id);
    const existing = input.toolTx.find((t) => t.idempotencyKey === key);
    if (!existing) {
      // 无事务记录的工具（只读）——不纳入 mid-tool 重放面
      continue;
    }
    const decision = decideToolTxReplay(existing, existing.inputHash);
    if (decision.action === "skip_committed") {
      out.push({
        action: "skip_committed",
        toolUseId: block.id,
        name: block.name,
        content: decision.result.content,
        ...(decision.result.isError ? { isError: true } : {}),
      });
      continue;
    }
    if (decision.action === "fail_closed") {
      out.push({
        action: "synthesize_error",
        toolUseId: block.id,
        name: block.name,
        content: decision.reason,
      });
      continue;
    }
    // 守卫：重放前核对当前 input 与 prepared 时一致
    const nowHash = canonicalInputHash(block.input);
    if (nowHash !== existing.inputHash) {
      out.push({
        action: "synthesize_error",
        toolUseId: block.id,
        name: block.name,
        content:
          `Mid-tool replay refused: input hash drift for ${key} (SAFE-06).`,
      });
      continue;
    }
    out.push({
      action: "replay",
      toolUseId: block.id,
      name: block.name,
      input: block.input,
      idempotencyKey: key,
    });
  }
  return out;
}

/** 从 assistant message 抽出 tool_use 块（忽略其它 content）。 */
export function extractPendingToolUses(
  message: Anthropic.MessageParam | undefined,
): Array<{ id: string; name: string; input: unknown }> {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }
  const out: Array<{ id: string; name: string; input: unknown }> = [];
  for (const block of message.content) {
    if (
      block
      && typeof block === "object"
      && "type" in block
      && (block as { type: string }).type === "tool_use"
    ) {
      const tu = block as Anthropic.ToolUseBlock;
      out.push({ id: tu.id, name: tu.name, input: tu.input });
    }
  }
  return out;
}

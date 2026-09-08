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

/**
 * 从 ToolTxController.get 种子化 pending 相关的事务表。
 * 只读工具无记录 → 不进表（由调用方退回 ABORTED 合成或另行执行）。
 */
export function collectPendingToolTx(
  runId: string,
  pending: Array<{ id: string }>,
  get: (key: string) => DurableToolTx | undefined,
): DurableToolTx[] {
  const out: DurableToolTx[] = [];
  for (const block of pending) {
    const tx = get(toolIdempotencyKey(runId, block.id));
    if (tx) out.push(tx);
  }
  return out;
}

/**
 * 把 mid-tool 计划与已执行结果合成 tool_result 块（顺序与 pending 一致）。
 * pending 中未出现在计划里的 id 用 fallback（通常是 ABORTED_TOOL_RESULT）。
 */
export function assembleMidToolResults(input: {
  pendingToolUses: Array<{ id: string; name: string; input: unknown }>;
  plan: MidToolReplayItem[];
  /** replay 项执行后的回执；key = toolUseId */
  executed: ReadonlyMap<string, { content: string; isError?: boolean }>;
  fallbackContent: string;
}): Anthropic.ToolResultBlockParam[] {
  const byId = new Map<string, Anthropic.ToolResultBlockParam>();
  for (const item of input.plan) {
    if (item.action === "replay") {
      const got = input.executed.get(item.toolUseId);
      byId.set(item.toolUseId, {
        type: "tool_result",
        tool_use_id: item.toolUseId,
        content: got?.content ?? input.fallbackContent,
        ...((got?.isError ?? !got) ? { is_error: true } : {}),
      });
      continue;
    }
    byId.set(item.toolUseId, {
      type: "tool_result",
      tool_use_id: item.toolUseId,
      content: item.content,
      ...(item.action === "synthesize_error" || item.isError ? { is_error: true } : {}),
    });
  }
  return input.pendingToolUses.map((block) => {
    const existing = byId.get(block.id);
    if (existing) return existing;
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: input.fallbackContent,
      is_error: true,
    };
  });
}

/** 是否值得走 mid-tool 路径（有悬空 tool_use 且至少一条副作用事务）。 */
export function shouldAttemptMidToolReplay(
  pending: Array<{ id: string }>,
  toolTx: readonly DurableToolTx[],
): boolean {
  return pending.length > 0 && toolTx.length > 0;
}

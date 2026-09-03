/**
 * SAFE-06 Phase 1 — 工具副作用事务层（纯函数 + 执行器钩子）。
 *
 * 范围：write_file / bash 两个主副作用内置工具。
 * - idempotencyKey = runId:toolUseId（inputHash 只作审计与同 id 异参 fail-closed）
 * - 生命周期：prepared → running → committed | failed | aborted
 * - write_file：idempotent_retry（prepared 可重入；committed 跳过）
 * - bash：fail_closed_no_retry（prepared/running 残留禁止重跑；无 undo）
 *
 * 残余：CLI 对等 durable、mid-tool 自动重放未完成 assistant 轮、bash compensation。
 */
import { createHash } from "node:crypto";
import type { ToolResult } from "./types.js";

export const SIDE_EFFECT_TOOL_NAMES = new Set(["write_file", "bash"]);

export const TOOL_TX_STATUSES = [
  "prepared",
  "running",
  "committed",
  "failed",
  "aborted",
] as const;
export type ToolTxStatus = (typeof TOOL_TX_STATUSES)[number];

export type ToolTxRetryPolicy = "idempotent_retry" | "fail_closed_no_retry";

export interface DurableToolTx {
  idempotencyKey: string;
  toolUseId: string;
  name: string;
  inputHash: string;
  status: ToolTxStatus;
  retryPolicy: ToolTxRetryPolicy;
  preparedAt: number;
  updatedAt: number;
  /** committed 时缓存，供同 key 跳过重放 */
  resultContent?: string;
  resultIsError?: boolean;
}

export function isSideEffectTool(name: string): boolean {
  return SIDE_EFFECT_TOOL_NAMES.has(name);
}

export function retryPolicyForTool(name: string): ToolTxRetryPolicy {
  // bash 任意命令不可安全重试；write_file 同内容写入可幂等
  return name === "bash" ? "fail_closed_no_retry" : "idempotent_retry";
}

export function toolIdempotencyKey(runId: string, toolUseId: string): string {
  return `${runId}:${toolUseId}`;
}

/** 规范化 JSON 形状后再哈希——键序稳定，避免同参不同序列化。 */
export function canonicalInputHash(input: unknown): string {
  return createHash("sha256").update(stableStringify(input), "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export type ToolTxReplayDecision =
  | { action: "execute" }
  | { action: "skip_committed"; result: ToolResult }
  | { action: "fail_closed"; reason: string };

/**
 * 同 key 再入时的决策。
 * - committed → 跳过副作用，回缓存结果
 * - prepared/running + fail_closed → 不重跑
 * - prepared + idempotent_retry → 允许再执行（崩溃在写前）
 * - running + idempotent_retry → 允许再执行（写后未 commit 靠工具层内容幂等兜底）
 * - 同 key 异 inputHash → fail-closed（toolUseId 不应改参）
 */
export function decideToolTxReplay(
  existing: DurableToolTx | undefined,
  inputHash: string,
): ToolTxReplayDecision {
  if (!existing) return { action: "execute" };
  if (existing.inputHash !== inputHash) {
    return {
      action: "fail_closed",
      reason:
        `Idempotency key ${existing.idempotencyKey} was prepared with a different input hash; ` +
        "refusing to re-bind parameters (SAFE-06).",
    };
  }
  if (existing.status === "committed") {
    return {
      action: "skip_committed",
      result: {
        content:
          existing.resultContent ??
          `Skipped duplicate commit for ${existing.name} (${existing.idempotencyKey}).`,
        ...(existing.resultIsError ? { isError: true } : {}),
      },
    };
  }
  if (
    (existing.status === "prepared" || existing.status === "running") &&
    existing.retryPolicy === "fail_closed_no_retry"
  ) {
    return {
      action: "fail_closed",
      reason:
        `Tool "${existing.name}" left ${existing.status} without commit; ` +
        "non-idempotent side effects must not be retried (SAFE-06 fail-closed). " +
        "No compensation/undo is available for bash.",
    };
  }
  // prepared/running + idempotent_retry → re-execute
  return { action: "execute" };
}

export function findToolTx(
  list: readonly DurableToolTx[] | undefined,
  key: string,
): DurableToolTx | undefined {
  return list?.find((t) => t.idempotencyKey === key);
}

export function upsertToolTx(
  list: readonly DurableToolTx[],
  tx: DurableToolTx,
): DurableToolTx[] {
  const idx = list.findIndex((t) => t.idempotencyKey === tx.idempotencyKey);
  if (idx < 0) return [...list, tx];
  const next = [...list];
  next[idx] = tx;
  return next;
}

/** 解析/校验落盘条目；坏形状 → null（整份 state 由调用方决定是否拒）。 */
export function parseDurableToolTx(raw: unknown): DurableToolTx | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.idempotencyKey !== "string" || !o.idempotencyKey) return null;
  if (typeof o.toolUseId !== "string" || !o.toolUseId) return null;
  if (typeof o.name !== "string" || !o.name) return null;
  if (typeof o.inputHash !== "string" || !o.inputHash) return null;
  if (typeof o.status !== "string" || !(TOOL_TX_STATUSES as readonly string[]).includes(o.status)) {
    return null;
  }
  if (o.retryPolicy !== "idempotent_retry" && o.retryPolicy !== "fail_closed_no_retry") {
    return null;
  }
  if (typeof o.preparedAt !== "number" || !Number.isFinite(o.preparedAt)) return null;
  if (typeof o.updatedAt !== "number" || !Number.isFinite(o.updatedAt)) return null;
  const tx: DurableToolTx = {
    idempotencyKey: o.idempotencyKey,
    toolUseId: o.toolUseId,
    name: o.name,
    inputHash: o.inputHash,
    status: o.status as ToolTxStatus,
    retryPolicy: o.retryPolicy,
    preparedAt: o.preparedAt,
    updatedAt: o.updatedAt,
  };
  if (typeof o.resultContent === "string") tx.resultContent = o.resultContent;
  if (typeof o.resultIsError === "boolean") tx.resultIsError = o.resultIsError;
  return tx;
}

/**
 * 宿主注入的事务控制器。ToolExecutor 在副作用边界调用；
 * prepared 的 notify 必须在返回前把 state 刷盘（崩溃注入才能证明）。
 */
export interface ToolTxController {
  runId: string;
  get(key: string): DurableToolTx | undefined;
  /**
   * 生命周期通知。prepared 时调用方应 await 落盘完成。
   * 返回后 ToolExecutor 才进入 running/execute。
   */
  notify(
    phase: ToolTxStatus,
    tx: DurableToolTx,
    meta?: { skipped?: boolean; reason?: string },
  ): void | Promise<void>;
  /** 测试/注入：prepared 落盘后、execute 前抛错模拟崩溃 */
  injectCrashAfterPrepared?: () => boolean;
}

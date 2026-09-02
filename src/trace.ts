/**
 * OBS-01 — 端到端 trace（run → segment → model/tool spans）。
 *
 * 设计选择：扩展既有落盘（`.agent-run-history/<runId>/trace.jsonl`）与
 * `operationalLog`，不引入 OpenTelemetry SDK——本仓尚无 OTel hook，加一层
 * 只会多一个与 events.jsonl 漂移的事实源。spans 是**可离线 playback** 的
 * 结构化旁路；界面仍由 events.jsonl 重放驱动。
 *
 * 不变量：
 * - 落盘 attrs 只含哈希 / 版本 / 计数，不含密钥、完整工具入参、token 原文。
 * - redacted export 再剥一轮敏感键名（authorization/api_key/…）。
 * - span 投影失败不得打断 run（仪器纪律，同 history 写失败）。
 */
import { createHash, randomUUID } from "node:crypto";
import type { TurnEvent } from "./types.js";

export type TraceSpanKind = "run" | "segment" | "model" | "tool";
export type TraceSpanStatus = "ok" | "error" | "running";

export interface TraceVersions {
  harnessVersion: string;
  gitCommit: string | null;
  packName: string | null;
  model: string | null;
  /** 工具名 + schema 形状哈希；schema 字节变了指纹就变 */
  toolSchemaHash: string | null;
}

export interface TraceSpan {
  version: 1;
  spanId: string;
  parentSpanId: string | null;
  kind: TraceSpanKind;
  name: string;
  runId: string;
  source: string | null;
  tsStart: number;
  tsEnd: number | null;
  status: TraceSpanStatus;
  attrs: Record<string, unknown>;
}

const SECRET_KEY =
  /^(?:authorization|api[_-]?key|token|password|secret|cookie|set-cookie|access_token|refresh_token)$/i;

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 递归脱敏：敏感键名 → "[redacted]"；其余保持可哈希形状。 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length > 512) return `${value.slice(0, 64)}…[len=${value.length}]`;
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 32).map((v) => redactValue(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 64)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : redactValue(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** 规范化 JSON 哈希（键排序），输入先 redact。 */
export function hashPayload(value: unknown): string {
  return sha256Hex(stableStringify(redactValue(value)));
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function hashToolSchemas(
  tools: ReadonlyArray<{ name: string; inputSchema?: unknown }>,
): string {
  return hashPayload(
    tools.map((t) => ({ name: t.name, inputSchema: t.inputSchema ?? null })).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  );
}

export function resolveGitCommit(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of ["AGENT_GIT_COMMIT", "GITHUB_SHA", "GIT_COMMIT", "COMMIT_SHA"]) {
    const v = env[key]?.trim();
    if (v) return v.length > 40 ? v.slice(0, 40) : v;
  }
  return null;
}

export function newSpanId(): string {
  return randomUUID();
}

export function startSpan(partial: {
  kind: TraceSpanKind;
  name: string;
  runId: string;
  parentSpanId?: string | null;
  source?: string | null;
  attrs?: Record<string, unknown>;
  ts?: number;
  spanId?: string;
}): TraceSpan {
  return {
    version: 1,
    spanId: partial.spanId ?? newSpanId(),
    parentSpanId: partial.parentSpanId ?? null,
    kind: partial.kind,
    name: partial.name,
    runId: partial.runId,
    source: partial.source ?? null,
    tsStart: partial.ts ?? Date.now(),
    tsEnd: null,
    status: "running",
    attrs: partial.attrs ?? {},
  };
}

export function endSpan(
  span: TraceSpan,
  status: TraceSpanStatus,
  attrs: Record<string, unknown> = {},
  ts = Date.now(),
): TraceSpan {
  return {
    ...span,
    tsEnd: ts,
    status,
    attrs: { ...span.attrs, ...attrs },
  };
}

/**
 * 从 TurnEvent 投影 tool/model 相关 span 片段。
 * tool_call 开 span（running）；tool_result 关 span；done 记 model 段摘要。
 * 返回 0..n 条应追加的完整 span 行（调用方负责 parent 关联）。
 */
export function projectTurnEventToSpans(opts: {
  runId: string;
  source: string;
  event: TurnEvent;
  parentSpanId: string | null;
  openTools: Map<string, TraceSpan>;
  ts?: number;
}): TraceSpan[] {
  const { runId, source, event, parentSpanId, openTools } = opts;
  const ts = opts.ts ?? Date.now();
  const out: TraceSpan[] = [];

  if (event.type === "tool_call") {
    const span = startSpan({
      kind: "tool",
      name: event.name,
      runId,
      parentSpanId,
      source,
      ts,
      attrs: {
        toolUseId: event.toolUseId,
        inputHash: hashPayload(event.input),
      },
    });
    openTools.set(event.toolUseId, span);
    out.push(span);
    return out;
  }

  if (event.type === "tool_result") {
    const open = openTools.get(event.toolUseId);
    if (open) {
      openTools.delete(event.toolUseId);
      out.push(
        endSpan(
          open,
          event.result.isError ? "error" : "ok",
          {
            durationMs: event.durationMs,
            resultHash: hashPayload({
              isError: event.result.isError,
              content: event.result.content,
            }),
          },
          ts,
        ),
      );
    }
    return out;
  }

  if (event.type === "api_retry") {
    out.push(
      endSpan(
        startSpan({
          kind: "model",
          name: "api_retry",
          runId,
          parentSpanId,
          source,
          ts,
          attrs: {
            turn: event.turn,
            attempt: event.attempt,
            reasonHash: hashPayload(event.reason),
            backoffMs: event.backoffMs,
          },
        }),
        "ok",
        {},
        ts,
      ),
    );
    return out;
  }

  if (event.type === "model_fallback") {
    out.push(
      endSpan(
        startSpan({
          kind: "model",
          name: "model_fallback",
          runId,
          parentSpanId,
          source,
          ts,
          attrs: {
            from: event.from,
            to: event.to,
            reasonHash: hashPayload(event.reason),
            turn: event.turn,
          },
        }),
        "ok",
        {},
        ts,
      ),
    );
    return out;
  }

  if (event.type === "done") {
    const stop = event.result.stopReason;
    const usage = event.result.usage;
    out.push(
      endSpan(
        startSpan({
          kind: "segment",
          name: `segment:${source}`,
          runId,
          parentSpanId,
          source,
          ts,
          attrs: {
            stopReason: stop,
          },
        }),
        stop === "error" || stop === "aborted" ? "error" : "ok",
        {
          usage: usage
            ? {
                input: usage.inputTokens,
                output: usage.outputTokens,
              }
            : null,
        },
        ts,
      ),
    );
    return out;
  }

  return out;
}

/** 脱敏导出：再剥 attrs 里可能漏网的敏感键，供离线分享。 */
export function exportRedactedTrace(spans: TraceSpan[]): {
  version: 1;
  exportedAt: string;
  spanCount: number;
  spans: TraceSpan[];
} {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    spanCount: spans.length,
    spans: spans.map((s) => ({
      ...s,
      attrs: redactValue(s.attrs) as Record<string, unknown>,
    })),
  };
}

/** 离线 playback：读 JSONL，坏行跳过。 */
export function parseTraceJsonl(text: string): TraceSpan[] {
  const out: TraceSpan[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t) as TraceSpan;
      if (row?.version === 1 && typeof row.spanId === "string" && typeof row.runId === "string") {
        out.push(row);
      }
    } catch {
      // skip corrupt
    }
  }
  return out;
}

/** 简易 playback 摘要：按 kind 计数 + 错误 span 列表（不重放 UI）。 */
export function playbackSummary(spans: TraceSpan[]): {
  byKind: Record<TraceSpanKind, number>;
  errors: Array<{ spanId: string; kind: TraceSpanKind; name: string }>;
  durationMs: number | null;
} {
  const byKind: Record<TraceSpanKind, number> = { run: 0, segment: 0, model: 0, tool: 0 };
  const errors: Array<{ spanId: string; kind: TraceSpanKind; name: string }> = [];
  let min = Infinity;
  let max = -Infinity;
  for (const s of spans) {
    byKind[s.kind] += 1;
    if (s.status === "error") errors.push({ spanId: s.spanId, kind: s.kind, name: s.name });
    if (Number.isFinite(s.tsStart)) min = Math.min(min, s.tsStart);
    if (s.tsEnd != null && Number.isFinite(s.tsEnd)) max = Math.max(max, s.tsEnd);
  }
  return {
    byKind,
    errors,
    durationMs: min === Infinity || max === -Infinity ? null : Math.max(0, max - min),
  };
}

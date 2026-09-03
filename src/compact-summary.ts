/**
 * MEM-01 Phase B — optional LLM enrichment of the durable compact ledger.
 *
 * Defaults OFF (no client). When armed: one bounded, tool-free model call
 * extracts facts heuristics miss (esp. long assistant reasoning / non-template
 * constraints) and **merges** into the Phase A ledger. Fail-open on any
 * error — never drop existing buckets. Does not elide assistant message bodies.
 */
import type { CompactLedger } from "./compact-ledger.js";
import {
  emptyCompactLedger,
  formatCompactLedger,
  mergeCompactLedgers,
} from "./compact-ledger.js";
import type { ModelClient, ModelRequest } from "./types.js";

/** Default ceiling for the summary call — cost/latency hard bound. */
export const DEFAULT_COMPACT_SUMMARY_MAX_TOKENS = 512;
/** Hard cap on excerpt text fed to the summarizer (chars). */
export const COMPACT_SUMMARY_EXCERPT_BUDGET = 6_000;
/** Hard cap on optional narrative prose stored in the ledger. */
export const COMPACT_SUMMARY_NARRATIVE_MAX_CHARS = 400;

export interface CompactSummaryEnrichment {
  additions: CompactLedger;
  narrative?: string;
}

export interface SummarizeForCompactArgs {
  client: ModelClient;
  ledger: CompactLedger;
  /** Unprotected-prefix excerpts (assistant reasoning, user text, tool heads). */
  excerpts: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * One-shot tool-free summary. Returns null on empty/unparseable output
 * (caller fail-opens to Phase A). Throws only for transport errors — caller
 * still fail-opens.
 */
export async function summarizeForCompact(
  args: SummarizeForCompactArgs,
): Promise<CompactSummaryEnrichment | null> {
  const maxTokens = Math.max(
    64,
    Math.min(args.maxTokens ?? DEFAULT_COMPACT_SUMMARY_MAX_TOKENS, 2048),
  );
  const excerpts = clipBudget(args.excerpts, COMPACT_SUMMARY_EXCERPT_BUDGET);
  if (!excerpts.trim()) return null;

  const req: ModelRequest = {
    system: [{ type: "text", text: COMPACT_SUMMARY_SYSTEM }],
    messages: [
      {
        role: "user",
        content: buildSummaryUserPrompt(args.ledger, excerpts),
      },
    ],
    tools: [],
    maxTokens,
    effort: "low",
    toolChoice: "none",
  };

  const turn = await args.client.send(req, undefined, args.signal);
  const text = extractAssistantText(turn.message.content);
  return parseCompactSummaryResponse(text);
}

/** Pure: parse model JSON into additive ledger + optional narrative. */
export function parseCompactSummaryResponse(raw: string): CompactSummaryEnrichment | null {
  const json = extractJsonObject(raw);
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const obj = json as Record<string, unknown>;
  const additions = emptyCompactLedger();
  pushStrings(additions.constraints, obj.constraints);
  pushStrings(additions.decisions, obj.decisions);
  pushStrings(additions.failures, obj.failures);
  pushStrings(additions.evidence, obj.evidence);
  pushStrings(additions.sideEffects, obj.sideEffects);

  let narrative: string | undefined;
  if (typeof obj.narrative === "string" && obj.narrative.trim()) {
    narrative = clipBudget(obj.narrative.trim(), COMPACT_SUMMARY_NARRATIVE_MAX_CHARS);
  }

  const hasBuckets =
    additions.constraints.length +
      additions.decisions.length +
      additions.failures.length +
      additions.evidence.length +
      additions.sideEffects.length >
    0;
  if (!hasBuckets && !narrative) return null;
  return { additions, ...(narrative ? { narrative } : {}) };
}

/**
 * Merge Phase B enrichment into Phase A ledger. Buckets are unioned;
 * narrative is appended (not replaced) when both exist. Guarantees
 * entry-count never shrinks relative to `base` bucket totals.
 */
export function mergeSummaryIntoLedger(
  base: CompactLedger,
  enrichment: CompactSummaryEnrichment,
): CompactLedger {
  const merged = mergeCompactLedgers(base, enrichment.additions);
  const narrative = joinNarratives(base.narrative, enrichment.narrative);
  const out: CompactLedger = narrative ? { ...merged, narrative } : { ...merged };
  // Belt: if a buggy merge somehow lost entries, keep base.
  const baseCount = bucketCount(base);
  if (bucketCount(out) < baseCount) return base.narrative || !narrative ? base : { ...base, narrative };
  return out;
}

export function collectCompactExcerpts(
  texts: { role: "user" | "assistant"; text: string }[],
): string {
  const parts: string[] = [];
  let used = 0;
  for (const item of texts) {
    const body = item.text.trim();
    if (!body) continue;
    if (body.includes("[compact_ledger]") || body.startsWith("[compacted]")) continue;
    const chunk = `[${item.role}]\n${body}`;
    if (used + chunk.length > COMPACT_SUMMARY_EXCERPT_BUDGET) {
      const remain = COMPACT_SUMMARY_EXCERPT_BUDGET - used;
      if (remain > 80) parts.push(chunk.slice(0, remain) + "…");
      break;
    }
    parts.push(chunk);
    used += chunk.length + 1;
  }
  return parts.join("\n\n");
}

const COMPACT_SUMMARY_SYSTEM =
  "You enrich a durable compact ledger for an agent run. " +
  "Extract only durable facts: user constraints, decisions, failures, evidence refs, side-effects. " +
  "Do not invent paths, hashes, register values, or outcomes absent from the excerpts. " +
  "Prefer short bullet-worthy strings. Output ONE JSON object only.";

function buildSummaryUserPrompt(ledger: CompactLedger, excerpts: string): string {
  return `Existing structured ledger (DO NOT drop these — only add missing facts):

${formatCompactLedger(ledger)}

Conversation excerpts about to lose tool_result detail (and long assistant reasoning still in history):

${excerpts}

Return JSON:
{"constraints":[],"decisions":[],"failures":[],"evidence":[],"sideEffects":[],"narrative":"optional ≤400 chars"}
Arrays may be empty. narrative is optional short prose that does not replace buckets.`;
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
      const t = (b as { text?: unknown }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.join("\n");
}

function extractJsonObject(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function pushStrings(target: string[], value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item !== "string") continue;
    const v = item.replace(/\s+/g, " ").trim();
    if (!v) continue;
    if (target.includes(v)) continue;
    if (target.length >= 20) return;
    target.push(v.length > 200 ? `${v.slice(0, 199)}…` : v);
  }
}

function joinNarratives(a?: string, b?: string): string | undefined {
  const left = a?.trim();
  const right = b?.trim();
  if (!left && !right) return undefined;
  if (!left) return right;
  if (!right) return left;
  if (left.includes(right) || right.includes(left)) {
    return clipBudget(left.length >= right.length ? left : right, COMPACT_SUMMARY_NARRATIVE_MAX_CHARS);
  }
  return clipBudget(`${left} | ${right}`, COMPACT_SUMMARY_NARRATIVE_MAX_CHARS);
}

function bucketCount(ledger: CompactLedger): number {
  return (
    ledger.constraints.length +
    ledger.decisions.length +
    ledger.failures.length +
    ledger.evidence.length +
    ledger.sideEffects.length
  );
}

function clipBudget(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

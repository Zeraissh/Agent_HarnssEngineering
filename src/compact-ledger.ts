/**
 * MEM-01 — structured semantic residue for context compaction.
 *
 * Non-LLM path: extract constraints / decisions / failures / evidence /
 * side-effects from messages before tool_result bodies are elided, then keep
 * them in a durable `[compact_ledger]` text block. Heuristic extraction is
 * intentionally fail-closed about what it cannot prove — residual gaps are
 * documented in docs/08, not papered over with an LLM summary.
 */

export const COMPACT_LEDGER_MARKER = "[compact_ledger]";

export interface CompactLedger {
  constraints: string[];
  decisions: string[];
  failures: string[];
  evidence: string[];
  sideEffects: string[];
  /**
   * Optional Phase B narrative prose. Never replaces the five buckets;
   * merge appends / dedupes. Omitted from ledgerEntryCount (buckets only).
   */
  narrative?: string;
}

export interface ToolUseRef {
  name: string;
  input: unknown;
}

const MAX_ENTRIES_PER_BUCKET = 20;
const MAX_ENTRY_CHARS = 200;

const CONSTRAINT_RE =
  /(?:必须|不得|不要|禁止|要求|约束|验收|AC\d+\b|must\b|must not\b|do not\b|don't\b|never\b|always\b|shall\b|required\b)[^\n。；;]{0,160}/gi;

const DECISION_RE =
  /(?:决定|选择|采用|改用|改为|结论|decided\b|decision\b|will use\b|switching to\b|chose\b|going with\b)[^\n。；;]{0,160}/gi;

const PATH_RE =
  /(?:[A-Za-z]:\\|\/|\.\/)[^\s"'`<>|]{3,120}|\b[\w.-]+\.(?:c|h|ts|js|py|md|elf|hex|kicad_sch|kicad_pcb|json|txt)\b/g;

const HEX_RE = /\b0x[0-9A-Fa-f]{4,16}\b/g;
const HASH_RE = /\b[A-Fa-f0-9]{64}\b/g;
const KEY_VALUE_RE =
  /\b(?:image_crc32|crc32|dev_id|CPUID|TELM|g_\w+|ERC|DRC|passed|stopReason)\s*[=:]\s*[^\s,;]{1,40}/gi;

const MUTATING_BASH_RE =
  /\b(?:rm|mv|cp|dd|git\s+commit|git\s+push|cmake|make\b|ninja|flash|openocd|pip\s+install|npm\s+i(?:nstall)?|tee\b|mkdir|touch)\b|[>|]{1,2}/i;

const SIDE_EFFECT_TOOL_RE =
  /^(?:write_file|write_memory|flash_firmware|flash_and_run)$|flash|write_memory|program_device|erase/i;

export function emptyCompactLedger(): CompactLedger {
  return { constraints: [], decisions: [], failures: [], evidence: [], sideEffects: [] };
}

export function ledgerEntryCount(ledger: CompactLedger): number {
  return (
    ledger.constraints.length +
    ledger.decisions.length +
    ledger.failures.length +
    ledger.evidence.length +
    ledger.sideEffects.length
  );
}

export function mergeCompactLedgers(...parts: CompactLedger[]): CompactLedger {
  const out = emptyCompactLedger();
  const narratives: string[] = [];
  for (const part of parts) {
    pushUnique(out.constraints, part.constraints);
    pushUnique(out.decisions, part.decisions);
    pushUnique(out.failures, part.failures);
    pushUnique(out.evidence, part.evidence);
    pushUnique(out.sideEffects, part.sideEffects);
    if (part.narrative?.trim()) narratives.push(part.narrative.trim());
  }
  if (narratives.length) {
    const joined = narratives.filter((n, i) => narratives.indexOf(n) === i).join(" | ");
    out.narrative = joined.length > MAX_ENTRY_CHARS * 2
      ? `${joined.slice(0, MAX_ENTRY_CHARS * 2 - 1)}…`
      : joined;
  }
  return out;
}

/** Parse a previously injected ledger block; unknown shape → empty (fail-closed). */
export function parseCompactLedgerText(text: string): CompactLedger {
  if (!text.includes(COMPACT_LEDGER_MARKER)) return emptyCompactLedger();
  const out = emptyCompactLedger();
  type Bucket = "constraints" | "decisions" | "failures" | "evidence" | "sideEffects";
  type Mode = Bucket | "narrative" | null;
  let mode: Mode = null;
  const narrativeParts: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === COMPACT_LEDGER_MARKER) continue;
    if (line === "(empty — no durable facts extracted)") continue;
    const header = line.toLowerCase().replace(/:$/, "");
    if (header === "constraints") {
      mode = "constraints";
      continue;
    }
    if (header === "decisions") {
      mode = "decisions";
      continue;
    }
    if (header === "failures") {
      mode = "failures";
      continue;
    }
    if (header === "evidence") {
      mode = "evidence";
      continue;
    }
    if (header === "side-effects" || header === "sideeffects") {
      mode = "sideEffects";
      continue;
    }
    if (header === "summary" || header === "narrative") {
      mode = "narrative";
      continue;
    }
    const item = line.replace(/^[-*]\s*/, "").trim();
    if (!item) continue;
    if (mode === "narrative") {
      narrativeParts.push(item);
      continue;
    }
    if (mode) {
      pushUnique(out[mode], [item]);
    }
  }
  if (narrativeParts.length) {
    out.narrative = narrativeParts.join(" ").trim();
  }
  return out;
}

export function formatCompactLedger(ledger: CompactLedger): string {
  const lines = [COMPACT_LEDGER_MARKER];
  appendBucket(lines, "constraints", ledger.constraints);
  appendBucket(lines, "decisions", ledger.decisions);
  appendBucket(lines, "failures", ledger.failures);
  appendBucket(lines, "evidence", ledger.evidence);
  appendBucket(lines, "side-effects", ledger.sideEffects);
  if (ledger.narrative?.trim()) {
    lines.push("summary:");
    lines.push(ledger.narrative.trim());
  }
  if (lines.length === 1) {
    lines.push("(empty — no durable facts extracted)");
  }
  return lines.join("\n");
}

/** 占位符 / 折叠块里一行原文摘录的字符上限（含省略号） */
export const EXCERPT_MAX_CHARS = 100;
/** 占位符里摘录行的标签——tier 2 折叠已置换的块时按它把摘录取回来，别改 */
const EXCERPT_LABEL = "excerpt: ";
const ERROR_LINE_RE = /\b(?:error|failed|denied|traceback|exception|fatal)\b/i;

/**
 * 从 tool_result 原文摘录一行事实："这次读到了什么"要在原文被置换之后仍留在正史里。
 *
 * 为什么（2026-09-03 真机）：反应式压缩救回了 987k 的超长请求，但 72 个占位符里没有一个
 * 字的原文——模型只能逐个 `read_file limit=1` 补读 72 次（8 轮）才凑齐首行事实。
 *
 * 规则：首个非空行；`is_error` 时优先取首个像错误的行（"Command output:\n\nError: …" 这种
 * 形状错误不在首行）；空白折叠成单空格；≤ {@link EXCERPT_MAX_CHARS} 字符。
 * 含 `[compact_ledger]` 字面量时打断它：摘录会进 text 块（折叠块），而账本的识别 / upsert
 * 是按"文本含该标记"判的，原样放进去整块会被当成账本改写（tier 2 首版实测踩过）。
 */
export function excerptToolResult(content: string, isError = false): string {
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let pick = lines[0] ?? "";
  if (isError) {
    const errorLine = lines.find((l) => ERROR_LINE_RE.test(l));
    if (errorLine) pick = errorLine;
  }
  const one = pick.replace(/\s+/g, " ").split(COMPACT_LEDGER_MARKER).join("[compact_ledger…]");
  return clipTo(one, EXCERPT_MAX_CHARS);
}

/** 行数：按 \n 或 \r\n 切，末尾一个换行不多算一行；空串 = 0 */
export function countLines(text: string): number {
  if (!text) return 0;
  const parts = text.split(/\r?\n/);
  if (parts.at(-1) === "") parts.pop();
  return parts.length;
}

/**
 * tier 1 占位符。首行以 `[compacted]` 开头是契约（幂等判定、扫描跳过、Phase B 摘要
 * 过滤都靠它）；`excerpt:` 行是原文首行摘录（{@link excerptToolResult}），
 * {@link parseSemanticPlaceholderExcerpt} 按标签取回——折叠时复用，不再写 "(elided)"。
 * 体积有界：摘录行 ≤ 9 + 100 字符，头部多出的 ", N lines" ≤ 20 字符。
 */
export function formatSemanticPlaceholder(args: {
  originalChars: number;
  /** 原文行数；缺省不写 */
  originalLines?: number;
  toolName?: string;
  /** 原文首行摘录；缺省不写（老调用方 / 无内容） */
  excerpt?: string;
  local: CompactLedger;
}): string {
  const lines = [
    `[compacted] semantic elision (was ${args.originalChars} chars` +
      (args.originalLines != null ? `, ${args.originalLines} lines` : "") +
      "). Re-run the tool if you need full output.",
  ];
  if (args.toolName) lines.push(`tool: ${args.toolName}`);
  if (args.excerpt) lines.push(`${EXCERPT_LABEL}${clipTo(args.excerpt.replace(/\s+/g, " ").trim(), EXCERPT_MAX_CHARS)}`);
  for (const item of args.local.sideEffects.slice(0, 4)) lines.push(`side-effect: ${item}`);
  for (const item of args.local.failures.slice(0, 4)) lines.push(`failure: ${item}`);
  for (const item of args.local.evidence.slice(0, 6)) lines.push(`evidence: ${item}`);
  return lines.join("\n");
}

/**
 * 从占位符取回摘录行；没有（本版之前写下的占位符，或空摘录）→ undefined，调用方自行退回 "(elided)"。
 * 只认 `[compacted]` 开头的文本——别把普通 tool_result 里恰好含 "excerpt:" 的行认成摘录。
 */
export function parseSemanticPlaceholderExcerpt(placeholder: string): string | undefined {
  if (!placeholder.startsWith("[compacted]")) return undefined;
  for (const line of placeholder.split("\n")) {
    if (line.startsWith(EXCERPT_LABEL)) {
      const v = line.slice(EXCERPT_LABEL.length).trim();
      return v || undefined;
    }
  }
  return undefined;
}

export function extractConstraintsFromText(text: string): string[] {
  return matchLines(text, CONSTRAINT_RE);
}

export function extractDecisionsFromText(text: string): string[] {
  return matchLines(text, DECISION_RE);
}

export function extractEvidenceFromText(text: string): string[] {
  const out: string[] = [];
  pushUnique(out, (text.match(HASH_RE) ?? []).map((h) => `sha256:${h.slice(0, 12)}…`));
  pushUnique(out, (text.match(HEX_RE) ?? []).slice(0, 8));
  pushUnique(out, (text.match(KEY_VALUE_RE) ?? []).map(clip));
  pushUnique(
    out,
    (text.match(PATH_RE) ?? [])
      .filter((p) => !p.includes("node_modules") && p.length <= 120)
      .slice(0, 8)
      .map(clip),
  );
  return out.slice(0, MAX_ENTRIES_PER_BUCKET);
}

/** Facts attributable to one tool_use + its tool_result body (pre-elision). */
export function extractFromToolExchange(
  tool: ToolUseRef | undefined,
  resultContent: string,
  isError: boolean,
): CompactLedger {
  const local = emptyCompactLedger();
  const name = tool?.name ?? "unknown_tool";
  const input = tool?.input;

  if (isError || looksLikeFailure(resultContent)) {
    pushUnique(local.failures, [`${name}: ${clip(firstMeaningfulLine(resultContent) || "error")}`]);
  }

  if (name === "write_file") {
    const path = readStringField(input, "path");
    if (path) pushUnique(local.sideEffects, [`write_file ${path}`]);
  } else if (SIDE_EFFECT_TOOL_RE.test(name)) {
    const detail = summarizeToolInput(name, input);
    pushUnique(local.sideEffects, [detail]);
  } else if (name === "bash") {
    const command = readStringField(input, "command");
    if (command && MUTATING_BASH_RE.test(command)) {
      pushUnique(local.sideEffects, [`bash: ${clip(command)}`]);
    }
  }

  // Successful write_file result restates the path — keep as evidence too.
  pushUnique(local.evidence, extractEvidenceFromText(resultContent));
  if (name === "write_file" && /Wrote\s+\d+\s+bytes/i.test(resultContent)) {
    pushUnique(local.evidence, [clip(firstMeaningfulLine(resultContent))]);
  }

  return local;
}

function appendBucket(lines: string[], title: string, items: string[]): void {
  if (items.length === 0) return;
  lines.push(`${title}:`);
  for (const item of items) lines.push(`- ${item}`);
}

function matchLines(text: string, re: RegExp): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    pushUnique(out, [clip(m[0].trim())]);
    if (out.length >= MAX_ENTRIES_PER_BUCKET) break;
  }
  return out;
}

function looksLikeFailure(content: string): boolean {
  const head = content.slice(0, 240);
  return /(?:^|\n)\s*(?:error|failed|denied|traceback|exception|fatal)\b/i.test(head);
}

function firstMeaningfulLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

function readStringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return name;
  const obj = input as Record<string, unknown>;
  for (const key of ["path", "elf_path", "file", "address", "session"]) {
    if (typeof obj[key] === "string" && (obj[key] as string).trim()) {
      return `${name} ${key}=${clip(String(obj[key]))}`;
    }
  }
  return name;
}

function clip(s: string): string {
  return clipTo(s.replace(/\s+/g, " ").trim(), MAX_ENTRY_CHARS);
}

/** 截到 ≤ max 字符，超出时末位是省略号（"…" 算一个字符，总长恰为 max） */
function clipTo(one: string, max: number): string {
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

function pushUnique(target: string[], items: string[]): void {
  for (const item of items) {
    const v = clip(item);
    if (!v) continue;
    if (target.includes(v)) continue;
    if (target.length >= MAX_ENTRIES_PER_BUCKET) return;
    target.push(v);
  }
}

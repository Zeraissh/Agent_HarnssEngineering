/**
 * EVAL-02 — 统计与失败分类引擎。
 *
 * 读 `eval/ab-log.jsonl`（A/B 逐 run）与 `.agent-runs.jsonl`（宿主台账），
 * 按 case × arm × model 输出：n、pass@1 + Wilson 95% CI、pass@k（无偏）、
 * 首轮成功率、修复率、turns/tokens/wall 的 p50/p95、稳定失败 taxonomy。
 *
 * 判据与 taxonomy **先写死**——映射规则每条有测试，不允许事后改口径凑数。
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ledgerPath, type RunLedgerEntry } from "../src/ledger.js";

// ── taxonomy（先写死的枚举）────────────────────────────────────────

export const FAILURE_TAXONOMY = [
  "api_error",
  "budget_max_turns",
  "budget_tokens",
  "verifier_fail_closed",
  "verifier_rejected_final",
  "plan_failed",
  "plan_rejected",
  "aborted",
  "wrong_output",
  "incomplete_output",
  "unknown",
] as const;

export type FailureTaxonomy = (typeof FAILURE_TAXONOMY)[number];

export interface StatsRunRow {
  source: "ab" | "ledger";
  caseId: string;
  arm: string;
  model: string;
  pass: boolean;
  stopReason: string | null;
  note?: string | null;
  turns?: number | null;
  tokens?: number | null;
  durationMs?: number | null;
  /** 多轮核查：按时间序；用于首轮/修复率 */
  verifierPassed?: boolean[];
  error?: string | null;
  finalPassed?: boolean | null;
}

export interface GroupStats {
  caseId: string;
  arm: string;
  model: string;
  n: number;
  passes: number;
  passAt1: number;
  wilson95: { low: number; high: number };
  /** k = min(n, 默认 5)；无偏估计 1 - C(n-c, k) / C(n, k) */
  passAtK: { k: number; estimate: number };
  firstRoundPassRate: number | null;
  repairRate: number | null;
  turns: { p50: number | null; p95: number | null };
  tokens: { p50: number | null; p95: number | null };
  wallMs: { p50: number | null; p95: number | null };
  taxonomy: Partial<Record<FailureTaxonomy, number>>;
}

// ── 纯函数：Wilson / pass@k / 分位数 / taxonomy ─────────────────────

/** Wilson score interval for a binomial proportion (z≈1.96 → 95%). */
export function wilsonInterval(passes: number, n: number, z = 1.96): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 0 };
  const p = passes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return {
    low: Math.max(0, (centre - margin) / denom),
    high: Math.min(1, (centre + margin) / denom),
  };
}

/** Combinations C(n, k); 0 when k>n or k<0. */
export function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let kk = Math.min(k, n - k);
  let num = 1;
  for (let i = 1; i <= kk; i++) num = (num * (n - kk + i)) / i;
  return num;
}

/**
 * Unbiased pass@k：从 n 次独立 trial 里抽 k 次至少一次成功的概率估计。
 * estimate = 1 - C(n-c, k) / C(n, k)；当 n-c < k 时为 1。
 */
export function passAtK(passes: number, n: number, k: number): { k: number; estimate: number } {
  const kk = Math.max(1, Math.min(k, n));
  if (n <= 0) return { k: kk, estimate: 0 };
  const fails = n - passes;
  if (fails < kk) return { k: kk, estimate: 1 };
  const denom = comb(n, kk);
  if (denom === 0) return { k: kk, estimate: 0 };
  return { k: kk, estimate: 0 }; // MUTATION
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const w = idx - lo;
  return sorted[lo]! * (1 - w) + sorted[hi]! * w;
}

export function summarizeNumeric(values: Array<number | null | undefined>): {
  p50: number | null;
  p95: number | null;
} {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  return { p50: percentile(xs, 0.5), p95: percentile(xs, 0.95) };
}

/**
 * 稳定失败 taxonomy —— 从 stopReason + verdicts + note 推导。
 * 顺序是有意的：更具体的形态优先于笼统的 wrong_output。
 */
export function classifyFailure(row: StatsRunRow): FailureTaxonomy | null {
  if (row.pass) return null;

  const reason = (row.stopReason ?? "").toLowerCase();
  const note = (row.note ?? "").toLowerCase();
  const err = (row.error ?? "").toLowerCase();
  const verdicts = row.verifierPassed ?? [];

  if (reason === "aborted" || reason === "plan_rejected" || reason === "plan_gate_expired") {
    if (reason === "aborted") return "aborted";
    return "plan_rejected";
  }
  if (reason === "plan_failed" || (note.includes("plan") && note.includes("fail"))) return "plan_failed";

  if (reason === "max_turns" || note.includes("max_turns")) return "budget_max_turns";
  if (reason === "max_tokens" || note.includes("token") && note.includes("budget")) return "budget_tokens";

  if (reason === "error" || err.includes("api") || err.includes("限流") || err.includes("网络") || err.includes("超时") || err.includes("认证")) {
    // 有 verifier fail-closed 证据时优先归核查类（跑满预算空裁决）
    if (verdicts.length > 0 && verdicts.every((v) => v === false) && (note.includes("无法解析") || err.includes("unclassified"))) {
      return "verifier_fail_closed";
    }
    return "api_error";
  }

  if (verdicts.length > 0) {
    const last = verdicts[verdicts.length - 1];
    if (last === false) {
      // 末轮拒签：若 note/summary 暗示解析失败 → fail-closed；否则 rejected_final
      if (note.includes("无法解析") || note.includes("parse") || note.includes("空输出")) {
        return "verifier_fail_closed";
      }
      return "verifier_rejected_final";
    }
  }

  if (note.includes("未创建") || note.includes("incomplete") || note.includes("没跑完") || note.includes("未完成")) {
    return "incomplete_output";
  }
  if (reason === "completed" || note.includes("期望") || note.includes("实际")) {
    return "wrong_output";
  }
  return "unknown";
}

export function firstRoundAndRepair(rows: StatsRunRow[]): {
  firstRoundPassRate: number | null;
  repairRate: number | null;
} {
  const withVerdicts = rows.filter((r) => (r.verifierPassed?.length ?? 0) > 0);
  if (withVerdicts.length === 0) return { firstRoundPassRate: null, repairRate: null };

  let firstOk = 0;
  let repairDenom = 0;
  let repairOk = 0;
  for (const r of withVerdicts) {
    const v = r.verifierPassed!;
    if (v[0]) firstOk += 1;
    else {
      repairDenom += 1;
      if (v.length > 1 && v[v.length - 1]) repairOk += 1;
    }
  }
  return {
    firstRoundPassRate: firstOk / withVerdicts.length,
    repairRate: repairDenom === 0 ? null : repairOk / repairDenom,
  };
}

export function groupKey(row: StatsRunRow): string {
  return `${row.caseId}\0${row.arm}\0${row.model}`;
}

export function summarizeGroup(rows: StatsRunRow[], passAtKDefault = 5): GroupStats {
  const head = rows[0]!;
  const passes = rows.filter((r) => r.pass).length;
  const n = rows.length;
  const { firstRoundPassRate, repairRate } = firstRoundAndRepair(rows);
  const taxonomy: Partial<Record<FailureTaxonomy, number>> = {};
  for (const r of rows) {
    const t = classifyFailure(r);
    if (!t) continue;
    taxonomy[t] = (taxonomy[t] ?? 0) + 1;
  }
  return {
    caseId: head.caseId,
    arm: head.arm,
    model: head.model,
    n,
    passes,
    passAt1: n === 0 ? 0 : passes / n,
    wilson95: wilsonInterval(passes, n),
    passAtK: passAtK(passes, n, passAtKDefault),
    firstRoundPassRate,
    repairRate,
    turns: summarizeNumeric(rows.map((r) => r.turns)),
    tokens: summarizeNumeric(rows.map((r) => r.tokens)),
    wallMs: summarizeNumeric(rows.map((r) => r.durationMs)),
    taxonomy,
  };
}

export function summarizeAll(rows: StatsRunRow[], passAtKDefault = 5): GroupStats[] {
  const buckets = new Map<string, StatsRunRow[]>();
  for (const r of rows) {
    const k = groupKey(r);
    const arr = buckets.get(k) ?? [];
    arr.push(r);
    buckets.set(k, arr);
  }
  return [...buckets.values()]
    .map((g) => summarizeGroup(g, passAtKDefault))
    .sort((a, b) => a.caseId.localeCompare(b.caseId) || a.arm.localeCompare(b.arm) || a.model.localeCompare(b.model));
}

// ── 读入 ────────────────────────────────────────────────────────────

export function parseAbLogLine(line: string): StatsRunRow | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const caseId = String(obj.case ?? obj.caseId ?? "unknown");
  const arm = String(obj.arm ?? "unknown");
  const model = String(obj.model ?? "unknown");
  const pass = Boolean(obj.pass);
  const stopReason = obj.stopReason != null ? String(obj.stopReason) : null;
  const verdicts = Array.isArray(obj.verifierVerdicts)
    ? (obj.verifierVerdicts as Array<{ passed?: boolean }>).map((v) => Boolean(v?.passed))
    : [];
  return {
    source: "ab",
    caseId,
    arm,
    model,
    pass,
    stopReason,
    note: obj.note != null ? String(obj.note) : null,
    turns: typeof obj.turns === "number" ? obj.turns : null,
    tokens: typeof obj.tokens === "number" ? obj.tokens : null,
    durationMs: typeof obj.durationMs === "number" ? obj.durationMs : null,
    verifierPassed: verdicts,
    error: obj.error != null ? String(obj.error) : null,
    finalPassed: typeof obj.finalPassed === "boolean" ? obj.finalPassed : pass,
  };
}

export function ledgerEntryToRow(e: RunLedgerEntry): StatsRunRow {
  const pass = e.finalPassed === true || e.stopReason === "completed";
  return {
    source: "ledger",
    caseId: `ledger:${e.host}`,
    arm: e.mode + (e.verify ? "+verify" : ""),
    model: e.model ?? "(unset)",
    pass,
    stopReason: e.stopReason,
    note: null,
    turns: e.turns,
    tokens: null,
    durationMs: e.durationMs,
    verifierPassed: e.verifications.map((v) => v.passed),
    error: e.error,
    finalPassed: e.finalPassed,
  };
}

export async function loadRows(opts: {
  abLog?: string;
  ledger?: string | null;
}): Promise<{ rows: StatsRunRow[]; broken: number }> {
  const rows: StatsRunRow[] = [];
  let broken = 0;

  if (opts.abLog) {
    try {
      const raw = await readFile(opts.abLog, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const r = parseAbLogLine(line);
        if (r) rows.push(r);
        else broken += 1;
      }
    } catch {
      // 文件不存在则跳过
    }
  }

  if (opts.ledger) {
    try {
      const raw = await readFile(opts.ledger, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          rows.push(ledgerEntryToRow(JSON.parse(line) as RunLedgerEntry));
        } catch {
          broken += 1;
        }
      }
    } catch {
      // 台账不存在则跳过
    }
  }

  return { rows, broken };
}

export function renderMarkdown(groups: GroupStats[], meta: { broken: number; n: number }): string {
  const pct = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
  const num = (x: number | null) => (x == null ? "—" : Number.isInteger(x) ? String(x) : x.toFixed(1));
  const lines: string[] = [
    "# Eval stats report",
    "",
    `Generated by \`npm run eval:stats\`. Rows=${meta.n}, broken lines skipped=${meta.broken}.`,
    "",
    "| case | arm | model | n | pass@1 | Wilson95 | pass@k | first | repair | turns p50/p95 | tokens p50/p95 | wall p50/p95 | taxonomy |",
    "|---|---|---|---:|---:|---|---:|---:|---:|---|---|---|---|",
  ];
  for (const g of groups) {
    const tax = Object.entries(g.taxonomy)
      .filter(([, c]) => (c ?? 0) > 0)
      .map(([k, c]) => `${k}:${c}`)
      .join(", ");
    lines.push(
      `| ${g.caseId} | ${g.arm} | ${g.model} | ${g.n} | ${pct(g.passAt1)} | [${pct(g.wilson95.low)}, ${pct(g.wilson95.high)}] | k=${g.passAtK.k} ${pct(g.passAtK.estimate)} | ${pct(g.firstRoundPassRate)} | ${pct(g.repairRate)} | ${num(g.turns.p50)}/${num(g.turns.p95)} | ${num(g.tokens.p50)}/${num(g.tokens.p95)} | ${num(g.wallMs.p50)}/${num(g.wallMs.p95)} | ${tax || "—"} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ── CLI 入口 ────────────────────────────────────────────────────────

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).replace(/\\/g, "/").endsWith("/eval/stats.ts");

if (isMain) {
  const root = process.cwd();
  const abLog = process.env.EVAL_AB_LOG ?? path.join(root, "eval", "ab-log.jsonl");
  const ledger = process.env.AGENT_RUN_LEDGER === "0" ? null : ledgerPath();
  const { rows, broken } = await loadRows({ abLog, ledger });
  const groups = summarizeAll(rows);
  const md = renderMarkdown(groups, { broken, n: rows.length });
  const jsonPath = path.join(root, "eval", "stats-report.json");
  const mdPath = path.join(root, "eval", "stats-report.md");
  await writeFile(jsonPath, JSON.stringify({ broken, n: rows.length, groups }, null, 2), "utf8");
  await writeFile(mdPath, md, "utf8");
  console.log(md);
  console.log(`Wrote ${mdPath}`);
  console.log(`Wrote ${jsonPath}`);
}

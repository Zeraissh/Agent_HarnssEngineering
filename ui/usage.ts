/**
 * 消耗视图：只读解析 .agent-runs.jsonl，按日 / 按模型汇总。
 *
 * 台账不记 token 原文（隐私 + 体积），有成本就报 usd，没有就报 turns。
 * 未登记单价与花了 0 元必须分开——usd 为 null 的行进 unpricedRuns。
 */

export interface UsageDayRow {
  day: string;
  runs: number;
  turns: number;
  usd: number | null;
  unpricedRuns: number;
}

export interface UsageModelRow {
  model: string;
  runs: number;
  turns: number;
  usd: number | null;
  unpricedRuns: number;
}

/** 按日再按模型——堆叠柱的事实源。byDay 仍是当日合计，不能从那里还原分模型。 */
export interface UsageDayModelRow {
  day: string;
  model: string;
  runs: number;
  turns: number;
  usd: number | null;
  unpricedRuns: number;
}

export interface UsageReport {
  totalRuns: number;
  totalTurns: number;
  totalUsd: number | null;
  unpricedRuns: number;
  byDay: UsageDayRow[];
  byModel: UsageModelRow[];
  byDayModel: UsageDayModelRow[];
}

export interface UsageLedgerRow {
  at?: number;
  model?: string | null;
  turns?: number | null;
  cost?: { usd?: number | null } | null;
}

function localDay(at: number): string {
  const d = new Date(at);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseLedgerLines(text: string): UsageLedgerRow[] {
  const rows: UsageLedgerRow[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as UsageLedgerRow;
      if (obj && typeof obj === "object") rows.push(obj);
    } catch {
      // 半截行跳过
    }
  }
  return rows;
}

function addUsd(current: number | null, next: number | null): number | null {
  if (next == null) return current;
  return (current ?? 0) + next;
}

export function aggregateUsage(rows: UsageLedgerRow[]): UsageReport {
  const byDay = new Map<string, UsageDayRow>();
  const byModel = new Map<string, UsageModelRow>();
  const byDayModel = new Map<string, UsageDayModelRow>();
  let totalRuns = 0;
  let totalTurns = 0;
  let totalUsd: number | null = null;
  let unpricedRuns = 0;

  for (const row of rows) {
    const at = typeof row.at === "number" && Number.isFinite(row.at) ? row.at : 0;
    const turns = typeof row.turns === "number" && Number.isFinite(row.turns) ? Math.max(0, row.turns) : 0;
    const usd = row.cost && typeof row.cost.usd === "number" && Number.isFinite(row.cost.usd)
      ? row.cost.usd
      : null;
    const model = String(row.model ?? "").trim() || "(unknown)";
    totalRuns += 1;
    totalTurns += turns;
    totalUsd = addUsd(totalUsd, usd);
    if (usd == null) unpricedRuns += 1;

    const day = at ? localDay(at) : "unknown";
    const dayRow = byDay.get(day) ?? { day, runs: 0, turns: 0, usd: null, unpricedRuns: 0 };
    dayRow.runs += 1;
    dayRow.turns += turns;
    dayRow.usd = addUsd(dayRow.usd, usd);
    if (usd == null) dayRow.unpricedRuns += 1;
    byDay.set(day, dayRow);

    const modelRow = byModel.get(model) ?? { model, runs: 0, turns: 0, usd: null, unpricedRuns: 0 };
    modelRow.runs += 1;
    modelRow.turns += turns;
    modelRow.usd = addUsd(modelRow.usd, usd);
    if (usd == null) modelRow.unpricedRuns += 1;
    byModel.set(model, modelRow);

    const dayModelKey = `${day}\t${model}`;
    const dayModelRow = byDayModel.get(dayModelKey) ?? {
      day,
      model,
      runs: 0,
      turns: 0,
      usd: null,
      unpricedRuns: 0,
    };
    dayModelRow.runs += 1;
    dayModelRow.turns += turns;
    dayModelRow.usd = addUsd(dayModelRow.usd, usd);
    if (usd == null) dayModelRow.unpricedRuns += 1;
    byDayModel.set(dayModelKey, dayModelRow);
  }

  return {
    totalRuns,
    totalTurns,
    totalUsd,
    unpricedRuns,
    byDay: [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)),
    byModel: [...byModel.values()].sort((a, b) => b.runs - a.runs),
    byDayModel: [...byDayModel.values()].sort((a, b) => {
      const dayCmp = b.day.localeCompare(a.day);
      return dayCmp !== 0 ? dayCmp : b.turns - a.turns;
    }),
  };
}

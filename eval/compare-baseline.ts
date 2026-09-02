/**
 * EVAL-03b — nightly 基线比对。
 *
 * 输入：A/B 网格摘要（或从 ab-log 聚合）；对照 `eval/baselines/nightly.json`。
 * 通过率跌出下界、或总成本/延迟涨超阈值 → 非零退出。
 *
 * 口径先写死在基线文件与本文件的纯函数里——不允许事后改阈值凑绿。
 */

export interface NightlyCellSummary {
  caseId: string;
  arm: string;
  pass: number;
  reps: number;
  tokens: number;
  wallMs: number;
}

export interface NightlyBaseline {
  version: 1;
  /** 期望跑到的用例（顺序无关）；缺 cell 视为未完成 → 失败 */
  cases: string[];
  arms: string[];
  /** 全矩阵合计通过率下界（pass/reps，跳过 reps=0） */
  minPassRate: number;
  /** 可选：单用例通过率下界 */
  caseMinPassRate?: Record<string, number>;
  /** 矩阵合计 token 上界（成本退化） */
  maxTotalTokens?: number;
  /** 矩阵合计墙钟上界（ms） */
  maxTotalWallMs?: number;
  /** 可选：人类可读的阈值来源说明（不参与比对） */
  notes?: string;
}

export interface CompareResult {
  ok: boolean;
  failures: string[];
  observed: {
    passRate: number;
    totalTokens: number;
    totalWallMs: number;
    completedCells: number;
  };
}

export function summarizeCells(cells: NightlyCellSummary[]): {
  passRate: number;
  totalTokens: number;
  totalWallMs: number;
  completedCells: number;
  byCase: Record<string, { pass: number; reps: number }>;
} {
  let pass = 0;
  let reps = 0;
  let totalTokens = 0;
  let totalWallMs = 0;
  let completedCells = 0;
  const byCase: Record<string, { pass: number; reps: number }> = {};
  for (const c of cells) {
    if (c.reps <= 0) continue;
    completedCells += 1;
    pass += c.pass;
    reps += c.reps;
    totalTokens += c.tokens;
    totalWallMs += c.wallMs;
    const prev = byCase[c.caseId] ?? { pass: 0, reps: 0 };
    byCase[c.caseId] = { pass: prev.pass + c.pass, reps: prev.reps + c.reps };
  }
  return {
    passRate: reps > 0 ? pass / reps : 0,
    totalTokens,
    totalWallMs,
    completedCells,
    byCase,
  };
}

export function compareNightly(
  cells: NightlyCellSummary[],
  baseline: NightlyBaseline,
): CompareResult {
  const failures: string[] = [];
  const summary = summarizeCells(cells);

  for (const arm of baseline.arms) {
    for (const caseId of baseline.cases) {
      const hit = cells.find((c) => c.caseId === caseId && c.arm === arm && c.reps > 0);
      if (!hit) {
        failures.push(`missing cell: ${caseId}/${arm}`);
      }
    }
  }

  if (summary.passRate + 1e-12 < baseline.minPassRate) {
    failures.push(
      `passRate ${summary.passRate.toFixed(3)} < minPassRate ${baseline.minPassRate}`,
    );
  }

  if (baseline.caseMinPassRate) {
    for (const [caseId, floor] of Object.entries(baseline.caseMinPassRate)) {
      const row = summary.byCase[caseId];
      if (!row || row.reps <= 0) {
        failures.push(`caseMinPassRate: missing ${caseId}`);
        continue;
      }
      const rate = row.pass / row.reps;
      if (rate + 1e-12 < floor) {
        failures.push(`case ${caseId} passRate ${rate.toFixed(3)} < ${floor}`);
      }
    }
  }

  if (baseline.maxTotalTokens != null && summary.totalTokens > baseline.maxTotalTokens) {
    failures.push(
      `totalTokens ${summary.totalTokens} > maxTotalTokens ${baseline.maxTotalTokens}`,
    );
  }
  if (baseline.maxTotalWallMs != null && summary.totalWallMs > baseline.maxTotalWallMs) {
    failures.push(
      `totalWallMs ${summary.totalWallMs} > maxTotalWallMs ${baseline.maxTotalWallMs}`,
    );
  }

  return {
    ok: failures.length === 0,
    failures,
    observed: {
      passRate: summary.passRate,
      totalTokens: summary.totalTokens,
      totalWallMs: summary.totalWallMs,
      completedCells: summary.completedCells,
    },
  };
}

/** 从 ab-log JSONL 行聚合成 cell 摘要（同 case×arm 合并）。 */
export function cellsFromAbLog(lines: Array<Record<string, unknown>>): NightlyCellSummary[] {
  const map = new Map<string, NightlyCellSummary>();
  for (const row of lines) {
    const caseId = typeof row.case === "string" ? row.case : null;
    const arm = typeof row.arm === "string" ? row.arm : null;
    if (!caseId || !arm) continue;
    const key = `${caseId}\0${arm}`;
    const cur = map.get(key) ?? {
      caseId,
      arm,
      pass: 0,
      reps: 0,
      tokens: 0,
      wallMs: 0,
    };
    cur.reps += 1;
    if (row.pass === true) cur.pass += 1;
    if (typeof row.tokens === "number" && Number.isFinite(row.tokens)) cur.tokens += row.tokens;
    if (typeof row.wallMs === "number" && Number.isFinite(row.wallMs)) cur.wallMs += row.wallMs;
    map.set(key, cur);
  }
  return [...map.values()];
}

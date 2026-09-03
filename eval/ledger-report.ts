/**
 * 运行台账读数器 —— `npm run ledger`
 *
 * 把 `.agent-runs.jsonl` 折成能下判断的几个数，并**按代码里先写死的阈值**
 * 直接给出结论。
 *
 * 之所以把结论也做成代码而不是"人看着数字判断"：判据写在 `src/ledger.ts` 里、
 * 且在收到任何数据之前就写好了。谁跑都得出同一个结论，没有事后合理化的空间。
 *
 * 报的问题已经换过一次：`STRUCTURED_OUTPUT_RULE`（§2.1 该不该做）在 52 次裁决上
 * 开火给出 `do`，§2.1 已实施，它随即有记录退役；现在报的是
 * `STRUCTURED_OUTPUT_EFFECT_RULE`（§2.1 生效了吗）。
 */
import { readFile } from "node:fs/promises";
import {
  decideStructuredOutputEffect,
  ledgerPath,
  summarizeLedger,
  summarizeTermination,
  STRUCTURED_OUTPUT_BASELINE,
  STRUCTURED_OUTPUT_EFFECT_RULE,
  type RunLedgerEntry,
} from "../src/ledger.js";
import { DEFAULT_MAX_TURNS } from "../src/loop.js";
import { getPack } from "../src/presets.js";

const file = process.argv[2] ?? ledgerPath();

let raw: string;
try {
  raw = await readFile(file, "utf8");
} catch {
  console.log(`台账还不存在：${file}`);
  console.log("跑几次任务（CLI 或 Web 宿主都会记）之后再来看。");
  process.exit(0);
}

const entries: RunLedgerEntry[] = [];
let broken = 0;
for (const line of raw.split("\n")) {
  if (!line.trim()) continue;
  try {
    entries.push(JSON.parse(line));
  } catch {
    broken++; // 半行/截断行不该让整份报告读不出来
  }
}

const s = summarizeLedger(entries);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

console.log(`台账：${file}`);
console.log(`运行 ${s.runs} 次（带核查 ${s.verifiedRuns}）${broken ? `，跳过 ${broken} 行坏数据` : ""}`);
console.log("");
console.log("── 裁决获得路径 ──");
console.log(`  裁决共 ${s.verdicts} 次`);
for (const k of ["tool", "direct", "reformat", "wrapup", "failed", "unknown"] as const) {
  const n = s.recovery[k];
  if (n > 0 || k === "tool" || k === "direct") {
    console.log(`  ${k.padEnd(9)} ${String(n).padStart(4)}  ${s.verdicts ? pct(n / s.verdicts) : "—"}`);
  }
}
console.log(`  非 direct 占比 ${pct(s.nonDirectRatio)}｜reformat+wrapup ${pct(s.reformatWrapupRatio)}`);
console.log(`  核查撞轮次上限 ${s.hitBudget} 次`);
console.log("");

/**
 * 判据换了：`STRUCTURED_OUTPUT_RULE` 已在 52 次裁决上开火给出 do，§2.1 已实施，
 * 那条规则**有记录退役**（留在 ledger.ts 里能原样复现那一刻的读数）。
 * 现在报的是下一个问题：它生效了吗。阈值同样先写后收。
 */
const eff = decideStructuredOutputEffect(s);
console.log(
  `── §2.1 效果判据（先写后收：样本≥${STRUCTURED_OUTPUT_EFFECT_RULE.minSamples}、` +
    `端点不认<${pct(STRUCTURED_OUTPUT_EFFECT_RULE.endpointIgnoresBelow)}、` +
    `wrapup 须降到<${pct(STRUCTURED_OUTPUT_EFFECT_RULE.wrapupMustDropBelow)}、` +
    `生效>${pct(STRUCTURED_OUTPUT_EFFECT_RULE.effectiveAbove)}）──`,
);
console.log(
  `  基线（实施前，${STRUCTURED_OUTPUT_BASELINE.verdicts} 次）：` +
    `direct ${STRUCTURED_OUTPUT_BASELINE.direct} / wrapup ${STRUCTURED_OUTPUT_BASELINE.wrapup} / reformat ${STRUCTURED_OUTPUT_BASELINE.reformat}`,
);
console.log(`  §2.1 效果：${eff.effect}`);
console.log(`  ${eff.why}`);
console.log("");

console.log("── 9.9 观察项：核查者调了写类工具吗 ──");
if (Object.keys(s.verifierWriteCalls).length === 0) {
  console.log("  无。（Web 宿主已于 2026-09-01 接入 MemoryStore；CLI + 领域包仍是主要观察路径。）");
} else {
  for (const [name, n] of Object.entries(s.verifierWriteCalls)) console.log(`  ${name}：${n} 次`);
  console.log("  只读核查出现写类调用——按 9.6/9.9 判定是否收紧白名单。");
}
console.log("");

console.log("── 工具调用直方图（按角色）──");
for (const [source, counts] of Object.entries(s.tools)) {
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  console.log(`  ${source}: ${top.map(([n, c]) => `${n}×${c}`).join(" ")}`);
}
console.log("");

/**
 * 上下文压缩（MEM-01）：反应式压缩救回超长请求的代价（模型补读被置换掉的事实）此前只在
 * 事件流里可见——台账行不记，`npm run ledger` 就看不见。只读带字段的行，老行是未知不是零。
 */
const cp = s.compaction;
console.log("── 上下文压缩（MEM-01）──");
if (cp.rows === 0) {
  console.log("  0 行带压缩计数（2026-09-03 之前的老行不记，是未知不是零次）。");
} else {
  console.log(
    `  有计数的运行 ${cp.rows} 次：发生过压缩 ${cp.runsWithAny} 次（其中反应式 ${cp.runsWithReactive} 次）；` +
      `常规 ${cp.proactive} 次 / 反应式 ${cp.reactive} 次；置换 ${cp.droppedBlocks} 块 / 折叠 ${cp.collapsedTurns} 轮`,
  );
}
console.log("");

/**
 * 上下文窗口 / 预算（MEM-01 窗口 / 预算分离）：窗口是从哪知道的、预算相对窗口在哪。
 * 150k 预算在 1M 窗口上压了三个月没人发现，就是因为没有一处把这两个数并排放着。
 */
const cx = s.context;
console.log("── 上下文窗口 / 预算 ──");
if (cx.rows === 0) {
  console.log("  0 行带窗口 / 预算字段（早于窗口 / 预算分离的老行不记，是未知不是零）。");
} else {
  const dist = (o: Record<string, number>) =>
    Object.entries(o).filter(([, n]) => n > 0).map(([k, n]) => `${k}×${n}`).join(" ") || "—";
  console.log(`  有字段的运行 ${cx.rows} 次：窗口来源 ${dist(cx.windowSources)}；预算来源 ${dist(cx.budgetSources)}`);
  const budgets = Object.entries(cx.budgets)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([k, n]) => `${Math.floor(Number(k) / 1000)}k×${n}`)
    .join(" ");
  console.log(
    `  预算分布 ${budgets || "—"}` +
      (cx.meanBudgetToWindow === null
        ? "；窗口全部未知，算不出预算 / 窗口比"
        : `；窗口已知的行里预算 / 窗口均值 ${pct(cx.meanBudgetToWindow)}`),
  );
}
console.log("");

/**
 * 终止原因 × 包 —— 领域包的恢复策略（`DomainPack.recovery`）该填几，只能从这里读。
 * 老行没有 maxTurns 字段时按**当前** presets 推算分母并标 `~`：包护栏是会改的
 * （kicad 40 → 70），推算值只能当参考。plan 模式 turns 是各子任务之和，不算比值。
 */
const t = summarizeTermination(entries, (pack) =>
  pack === null ? DEFAULT_MAX_TURNS : (getPack(pack)?.guardrails?.maxTurns ?? DEFAULT_MAX_TURNS),
);
const w = 12;
console.log("── 终止原因 × 包 ──");
console.log(`  ${"pack".padEnd(14)}${t.stopReasons.map((r) => r.padStart(w)).join("")}${"total".padStart(w)}`);
for (const row of t.byPack) {
  console.log(
    `  ${row.pack.padEnd(14)}` +
      t.stopReasons.map((r) => String(row.counts[r] ?? 0).padStart(w)).join("") +
      String(row.total).padStart(w),
  );
}
console.log("");

console.log("── max_turns 明细：用了多少轮 vs 单段护栏（比值按段归一 = turns / (护栏 × (1+返工))）──");
if (t.maxTurnsRuns.length === 0) {
  console.log("  无 max_turns 运行。");
} else {
  console.log(
    `  ${"日期".padEnd(12)}${"host".padEnd(5)}${"pack".padEnd(14)}${"mode".padEnd(7)}${"turns".padStart(6)}${"护栏".padStart(6)}${"段".padStart(3)}${"比值".padStart(8)}  续跑/停滞/强制  策略(续/窗/换)`,
  );
  for (const r of t.maxTurnsRuns) {
    const date = new Date(r.at).toISOString().slice(0, 10);
    const guard = r.maxTurns === null ? "—" : `${r.maxTurnsSource === "inferred" ? "~" : ""}${r.maxTurns}`;
    const ratio = r.ratio === null ? "—" : `${(r.ratio * 100).toFixed(0)}%`;
    const rec = r.recovery ? `${r.recovery.extensions}/${r.recovery.stagnations}/${r.recovery.forced}` : "未知(老行)";
    const pol =
      r.recoveryPolicy === undefined
        ? "未知(老行)"
        : r.recoveryPolicy === null
          ? "关"
          : `${r.recoveryPolicy.progressExtensionTurns}/${r.recoveryPolicy.stagnationWindow}/${r.recoveryPolicy.maxStagnationRecoveries}`;
    console.log(
      `  ${date.padEnd(12)}${r.host.padEnd(5)}${r.pack.padEnd(14)}${r.mode.padEnd(7)}` +
        `${String(r.turns ?? "—").padStart(6)}${guard.padStart(6)}${String(r.segments).padStart(3)}${ratio.padStart(8)}  ${rec.padEnd(14)}  ${pol}`,
    );
  }
  console.log("  （~ = 老行无分母，按当前 presets 推算；未知(老行) = 早于恢复机制字段，不是零次）");
}
console.log("");
const p = t.postRecovery;
console.log("── 恢复机制落地后的行（有 recovery 字段）──");
if (p.runs === 0) {
  console.log("  0 行。领域包的 recovery 数字要等这里攒够——现在填数就是拍脑袋。");
} else {
  console.log(
    `  运行 ${p.runs} 次，其中 max_turns ${p.maxTurns} 次；进展续跑触发 ${p.extensions} 次、停滞检测 ${p.stagnations} 次、强制收口 ${p.forced} 次`,
  );
}

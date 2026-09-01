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
  STRUCTURED_OUTPUT_BASELINE,
  STRUCTURED_OUTPUT_EFFECT_RULE,
  type RunLedgerEntry,
} from "../src/ledger.js";

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

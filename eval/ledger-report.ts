/**
 * 运行台账读数器 —— `npm run ledger`
 *
 * 把 `.agent-runs.jsonl` 折成能下判断的几个数，并**按代码里先写死的阈值**
 * 直接给出 §2.1 该不该做的结论（`decideStructuredOutput`）。
 *
 * 之所以把结论也做成代码而不是"人看着数字判断"：判据写在
 * `src/ledger.ts` 的 `STRUCTURED_OUTPUT_RULE` 里、且在收到任何数据之前就写好了。
 * 谁跑都得出同一个结论，没有事后合理化的空间。
 */
import { readFile } from "node:fs/promises";
import {
  decideStructuredOutput,
  ledgerPath,
  summarizeLedger,
  STRUCTURED_OUTPUT_RULE,
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
console.log("── 裁决获得路径（§2.1 的证据）──");
console.log(`  裁决共 ${s.verdicts} 次`);
for (const k of ["direct", "reformat", "wrapup", "failed", "unknown"] as const) {
  const n = s.recovery[k];
  if (n > 0 || k === "direct") {
    console.log(`  ${k.padEnd(9)} ${String(n).padStart(4)}  ${s.verdicts ? pct(n / s.verdicts) : "—"}`);
  }
}
console.log(`  非 direct 占比 ${pct(s.nonDirectRatio)}｜reformat+wrapup ${pct(s.reformatWrapupRatio)}`);
console.log(`  核查撞轮次上限 ${s.hitBudget} 次`);
console.log("");

const d = decideStructuredOutput(s);
console.log(`── 判据（阈值在收数据之前写死：样本≥${STRUCTURED_OUTPUT_RULE.minSamples}、关<${pct(STRUCTURED_OUTPUT_RULE.closeBelow)}、做>${pct(STRUCTURED_OUTPUT_RULE.doAbove)}）──`);
console.log(`  §2.1 结论：${d.decision}`);
console.log(`  ${d.why}`);
console.log("");

console.log("── 9.9 观察项：核查者调了写类工具吗 ──");
if (Object.keys(s.verifierWriteCalls).length === 0) {
  console.log("  无。（注意：这个现象只有 CLI + 领域包那条路能产生，Web 宿主没接 MemoryStore）");
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

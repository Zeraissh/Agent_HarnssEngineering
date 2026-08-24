/**
 * 真机验收：§2.1 终结工具在**真实端点**上端到端跑通吗。
 *
 * 单测用的是假模型——它永远按脚本返回 tool_use，证明不了端点会不会照做。
 * 这个脚本让真 verifier 核查一个真文件，然后报三件事：
 *   ① recovery 是不是 `tool`（走了终结工具）；
 *   ② 裁决内容对不对（植入一处不符，看它抓不抓得到）；
 *   ③ 强制工具那条降级臂有没有被触发（触发了说明端点拒了，仍应拿到裁决）。
 *
 * 用法：npx tsx --env-file-if-exists=.env eval/live-terminal-tool.ts
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelClientFromEnv } from "../src/provider.js";
import { runVerifier } from "../src/verifier.js";
import { readFileTool } from "../src/tools/read-file.js";

const model = process.env.AGENT_MODEL ?? "claude-opus-4-8";
const { client, provider, compat } = createModelClientFromEnv(model);
console.log(`端点：${process.env.ANTHROPIC_BASE_URL ?? "(默认)"}｜模型名：${model}｜provider=${provider}｜compat=${compat}\n`);

const dir = await mkdtemp(join(tmpdir(), "live-verify-"));
const file = join(dir, "counts.txt");
// 植入：报告说 5 行，实际 4 行。verifier 必须自己数出来
await writeFile(file, "alpha\nbeta\ngamma\ndelta\n", "utf8");

const outcome = await runVerifier(
  { systemPrompt: "你是一个严谨的工程助手。", tools: [readFileTool], workdir: dir, compat, maxTurns: 8 },
  client,
  {
    task: `核查 ${file} 是否恰好包含 5 行内容。`,
    executorReport: `我已写入 ${file}，共 5 行。`,
    maxTurns: 8,
  },
);

console.log("── 结果 ──");
console.log(`recovery : ${outcome.recovery}${outcome.recovery === "tool" ? "  ← 走了终结工具" : ""}`);
console.log(`passed   : ${outcome.verdict.passed}  （应为 false：实际 4 行 ≠ 报告的 5 行）`);
console.log(`summary  : ${outcome.verdict.summary}`);
console.log(`issues   : ${JSON.stringify(outcome.verdict.issues, null, 1)}`);
console.log(`raw      : ${outcome.raw.slice(0, 200)}`);
console.log(`turns    : ${outcome.usage.turns}｜cacheHit ${(outcome.usage.cacheHitRatio * 100).toFixed(1)}%`);

const ok = outcome.recovery === "tool" && outcome.verdict.passed === false;
console.log(`\n判定：${ok ? "✅ 终结工具在真机上生效，且裁决正确" : "⚠ 见上——recovery 非 tool 说明走了降级臂"}`);
process.exit(ok ? 0 : 1);

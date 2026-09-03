/**
 * 评估基线执行器：全量用例单跑（baseline 口径），记录 通过/轮数/token 成本，生成报告。
 * 用法：npm run eval   （环境变量同 CLI：ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / AGENT_MODEL）
 *   EVAL_CASES=write-basic,par-fanout   只跑指定用例（默认全部）
 *
 * 这是回归基线：改动 harness 后重跑，对比 eval/baseline-report.md 看是否退化。
 * 审批一律自动放行（用例本身就是写文件类任务）。
 *
 * 口径与 eval/ab.ts 的 baseline 臂对齐（2026-08-04 修化石漂移——本文件自 v0.6 起
 * 失修,缺 setup/逐用例清场/纯产物评分/rule-precedence,fixture 类用例结果全体无效）：
 * - 每用例前清空 eval-out 并跑 setup（fixture 供给;ab.ts 的铁律）
 * - 纯产物评分：无论 stopReason 一律查产物,过程终止态只做元数据
 * - SYSTEM_PROMPT 含 rule-precedence（2026-07-31 起的 baseline 时代）
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AgentLoop } from "../src/loop.js";
import { RULE_PRECEDENCE_DISCIPLINE } from "../src/presets.js";
import { createModelClientFromEnv } from "../src/provider.js";
import { bashTool, SHELL_DESC } from "../src/tools/bash.js";
import { globTool } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";
import { readFileTool } from "../src/tools/read-file.js";
import { writeFileTool } from "../src/tools/write-file.js";
import type { AgentConfig, AgentRunResult, ModelClient } from "../src/types.js";
import { cases } from "./cases.js";

const SYSTEM_PROMPT =
  `You are a capable autonomous agent operating in a local working directory.
Complete the user's task end to end using the available tools.
Ground every claim of progress in an actual tool result. When the task is done, summarize what you did in one or two sentences.
Keep file outputs clean and well-structured. Respond in the language the user used.` + RULE_PRECEDENCE_DISCIPLINE;

interface CaseRecord {
  id: string;
  covers: string;
  pass: boolean;
  note: string;
  stopReason: string;
  turns: number;
  totalTokens: number;
  outputTokens: number;
  durationMs: number;
}

async function main(): Promise<void> {
  const workdir = process.cwd();
  const model = process.env.AGENT_MODEL ?? "claude-opus-4-8";
  const { client, compat } = createModelClientFromEnv(model);
  const config: AgentConfig = {
    systemPrompt: SYSTEM_PROMPT,
    // 与 eval/ab.ts 的工具面保持逐字一致——两台仪器的被测面分叉过一次
    // （eval/run.ts 从 v0.6 起失修成化石，见 23055ed），不再重犯。
    tools: [bashTool, readFileTool, writeFileTool, globTool, grepTool],
    workdir,
    compat,
    maxTurns: 15,
    maxTokens: process.env.AGENT_MAX_TOKENS ? Number(process.env.AGENT_MAX_TOKENS) : undefined,
    dynamicContext: {
      platform: process.platform,
      shell: SHELL_DESC,
      workdir,
    },
  };

  const caseFilter = process.env.EVAL_CASES?.split(",").map((s) => s.trim());
  const suite = caseFilter ? cases.filter((c) => caseFilter.includes(c.id)) : cases;

  const records: CaseRecord[] = [];
  for (const evalCase of suite) {
    // 铁律（与 ab.ts 同款）：每用例前清空产出目录并供给 fixture——
    // 否则用例互相污染,判定可能"通过"在别的用例遗留的文件上
    await rm(path.join(workdir, "eval-out"), { recursive: true, force: true });
    await mkdir(path.join(workdir, "eval-out"), { recursive: true });
    await evalCase.setup?.(workdir);

    process.stdout.write(`[${evalCase.id}] running... `);
    const started = Date.now();
    const result = await runCase(config, client, evalCase.task);
    // 纯产物评分：无论 stopReason 一律查产物;非 completed 只做备注元数据
    const artifact = await evalCase.check(workdir);
    const verdict =
      result.stopReason === "completed"
        ? artifact
        : { ...artifact, note: `${artifact.note} [stopReason=${result.stopReason}]` };
    const u = result.usage;
    records.push({
      id: evalCase.id,
      covers: evalCase.covers,
      pass: verdict.pass,
      note: verdict.note,
      stopReason: result.stopReason,
      turns: u.turns,
      totalTokens: u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens + u.outputTokens,
      outputTokens: u.outputTokens,
      durationMs: Date.now() - started,
    });
    console.log(verdict.pass ? `PASS (${u.turns} turns)` : `FAIL — ${verdict.note}`);
  }

  const report = renderReport(model, records);
  const reportPath = path.join(workdir, "eval", "baseline-report.md");
  await writeFile(reportPath, report, "utf8");
  console.log(`\n${records.filter((r) => r.pass).length}/${records.length} passed — report: eval/baseline-report.md`);
  if (records.some((r) => !r.pass)) process.exitCode = 1;
}

async function runCase(
  config: AgentConfig,
  client: ModelClient,
  task: string,
): Promise<AgentRunResult> {
  const loop = new AgentLoop(config, client);
  let result: AgentRunResult | undefined;
  for await (const event of loop.run(task)) {
    if (event.type === "approval_request") event.respond("allow");
    if (event.type === "done") result = event.result;
  }
  return result!;
}

function renderReport(model: string, records: CaseRecord[]): string {
  const passed = records.filter((r) => r.pass).length;
  const rows = records
    .map(
      (r) =>
        `| ${r.id} | ${r.covers} | ${r.pass ? "✅" : `❌ ${r.note}`} | ${r.turns} | ${r.totalTokens} | ${r.outputTokens} | ${(r.durationMs / 1000).toFixed(1)}s |`,
    )
    .join("\n");
  return `# 评估基线报告

- 日期：${new Date().toISOString().slice(0, 10)}
- 模型：\`${model}\`
- 结果：**${passed}/${records.length} 通过**

| 用例 | 覆盖面 | 结果 | 轮数 | 总 tokens | 输出 tokens | 耗时 |
|---|---|---|---|---|---|---|
${rows}

> 总 tokens = input + cacheW + cacheR + output。改动 harness 后重跑 \`npm run eval\`，与本基线对比：
> 成功率下降 = 行为回归；轮数/tokens 显著上升 = 效率回归。
`;
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});

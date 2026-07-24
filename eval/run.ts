/**
 * 评估基线执行器：跑固定 5 用例，记录 通过/轮数/token 成本，生成报告。
 * 用法：npm run eval   （环境变量同 CLI：ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / AGENT_MODEL）
 *
 * 这是回归基线：改动 harness 后重跑，对比 eval/baseline-report.md 看是否退化。
 * 审批一律自动放行（用例本身就是写文件类任务）。
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AgentLoop } from "../src/loop.js";
import { AnthropicModelClient } from "../src/model-client.js";
import { bashTool } from "../src/tools/bash.js";
import { readFileTool } from "../src/tools/read-file.js";
import { writeFileTool } from "../src/tools/write-file.js";
import type { AgentConfig, AgentRunResult } from "../src/types.js";
import { cases } from "./cases.js";

const SYSTEM_PROMPT = `You are a capable autonomous agent operating in a local working directory.
Complete the user's task end to end using the available tools.
Ground every claim of progress in an actual tool result. When the task is done, summarize what you did in one or two sentences.
Keep file outputs clean and well-structured. Respond in the language the user used.`;

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
  const config: AgentConfig = {
    systemPrompt: SYSTEM_PROMPT,
    tools: [bashTool, readFileTool, writeFileTool],
    workdir,
    compat: !model.startsWith("claude"),
    maxTurns: 15,
    dynamicContext: {
      platform: process.platform,
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      workdir,
    },
  };
  const client = new AnthropicModelClient(model);

  // 干净起跑：清空上一次的产出目录
  await rm(path.join(workdir, "eval-out"), { recursive: true, force: true });
  await mkdir(path.join(workdir, "eval-out"), { recursive: true });

  const records: CaseRecord[] = [];
  for (const evalCase of cases) {
    process.stdout.write(`[${evalCase.id}] running... `);
    const started = Date.now();
    const result = await runCase(config, client, evalCase.task);
    const verdict =
      result.stopReason === "completed"
        ? await evalCase.check(workdir)
        : { pass: false, note: `run 未完成: ${result.stopReason}` };
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
  client: AnthropicModelClient,
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

/**
 * A/B 跑测器：同一套 eval 用例 × 多个实验臂，产出对比矩阵，量化各 harness 特性的收益。
 * 用法：npm run ab   （env 同 CLI：AGENT_MODEL / ANTHROPIC_BASE_URL / AGENT_PROVIDER…）
 *   AB_ARMS=baseline,verified   只跑指定臂（默认全部：baseline/verified/bare-tools）
 *   AB_CASES=write-basic,sum-numbers   只跑指定用例（默认全部）
 *   AB_REPS=1                    每个(用例,臂)重复次数（默认 1；>1 用于看方差）
 *
 * 铁律：每个单独 run 前清空 eval-out/——否则某臂可能"通过"在别的臂遗留的文件上。
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AgentLoop } from "../src/loop.js";
import { runVerified } from "../src/orchestrate.js";
import { createModelClientFromEnv } from "../src/provider.js";
import { bashTool } from "../src/tools/bash.js";
import { readFileTool } from "../src/tools/read-file.js";
import { writeFileTool } from "../src/tools/write-file.js";
import type { AgentConfig, AgentRunResult, ModelClient } from "../src/types.js";
import { getArms, type Arm } from "./arms.js";
import { cases, type EvalCase } from "./cases.js";

const SYSTEM_PROMPT = `You are a capable autonomous agent operating in a local working directory.
Complete the user's task end to end using the available tools.
Ground every claim of progress in an actual tool result. When the task is done, summarize what you did in one or two sentences.
Keep file outputs clean and well-structured. Respond in the language the user used.`;

interface Cell {
  pass: number; // 通过次数
  reps: number;
  turns: number; // 累计轮数
  tokens: number; // 累计总 tokens
}

async function main(): Promise<void> {
  const workdir = process.cwd();
  const model = process.env.AGENT_MODEL ?? "claude-opus-4-8";
  const reps = process.env.AB_REPS ? Number(process.env.AB_REPS) : 1;
  const arms = getArms(process.env.AB_ARMS?.split(",").map((s) => s.trim()));
  const caseFilter = process.env.AB_CASES?.split(",").map((s) => s.trim());
  const suite = caseFilter ? cases.filter((c) => caseFilter.includes(c.id)) : cases;

  const { client, compat } = createModelClientFromEnv(model);
  const baseConfig: AgentConfig = {
    systemPrompt: SYSTEM_PROMPT,
    tools: [bashTool, readFileTool, writeFileTool],
    workdir,
    compat,
    maxTurns: 15,
    maxTokens: process.env.AGENT_MAX_TOKENS ? Number(process.env.AGENT_MAX_TOKENS) : undefined,
  };

  // cell[caseId][armName]
  const grid: Record<string, Record<string, Cell>> = {};
  for (const c of suite) grid[c.id] = {};

  console.log(
    `A/B: ${suite.length} 用例 × ${arms.length} 臂 × ${reps} 次 = ${suite.length * arms.length * reps} runs (model=${model})\n`,
  );

  for (const evalCase of suite) {
    for (const arm of arms) {
      const cell: Cell = { pass: 0, reps, turns: 0, tokens: 0 };
      for (let r = 0; r < reps; r++) {
        // 每个 run 前清空产出目录——保证判定只看本次 run 的产物
        await rm(path.join(workdir, "eval-out"), { recursive: true, force: true });
        await mkdir(path.join(workdir, "eval-out"), { recursive: true });

        const { result, turns, tokens } = await runArm(arm, baseConfig, client, evalCase.task);
        cell.turns += turns;
        cell.tokens += tokens;
        const verdict =
          result.stopReason === "completed" || result.stopReason === "max_tokens"
            ? await evalCase.check(workdir)
            : { pass: false, note: `run 未完成: ${result.stopReason}` };
        if (verdict.pass) cell.pass += 1;
      }
      grid[evalCase.id]![arm.name] = cell;
      const c = grid[evalCase.id]![arm.name]!;
      console.log(
        `[${evalCase.id} / ${arm.name}] ${c.pass}/${c.reps} pass, ${(c.turns / c.reps).toFixed(1)} turns, ${Math.round(c.tokens / c.reps)} tok`,
      );
    }
  }

  const report = renderReport(model, reps, suite, arms, grid);
  await writeFile(path.join(workdir, "eval", "ab-report.md"), report, "utf8");
  console.log("\n报告已写入 eval/ab-report.md");
}

async function runArm(
  arm: Arm,
  base: AgentConfig,
  client: ModelClient,
  task: string,
): Promise<{ result: AgentRunResult; turns: number; tokens: number }> {
  const cfg = arm.configure(base);
  if (arm.mode === "verified") {
    const outcome = await runVerified(cfg, client, task, {
      maxReworks: 1,
      // eval 场景自动放行主/返工 agent 的审批（verifier 的审批已在内部自动 deny）
      onEvent: (_source, event) => {
        if (event.type === "approval_request") event.respond("allow");
      },
    });
    // 成本 = 主 run（含返工，取最后一次 result.usage）+ 各次核查
    const mainU = outcome.main.usage;
    let tokens =
      mainU.inputTokens + mainU.cacheCreationTokens + mainU.cacheReadTokens + mainU.outputTokens;
    let turns = mainU.turns;
    for (const v of outcome.verifications) {
      tokens += v.usage.inputTokens + v.usage.cacheCreationTokens + v.usage.cacheReadTokens + v.usage.outputTokens;
      turns += v.usage.turns;
    }
    return { result: outcome.main, turns, tokens };
  }
  // single
  const loop = new AgentLoop(cfg, client);
  let result: AgentRunResult | undefined;
  for await (const event of loop.run(task)) {
    if (event.type === "approval_request") event.respond("allow");
    if (event.type === "done") result = event.result;
  }
  const u = result!.usage;
  return {
    result: result!,
    turns: u.turns,
    tokens: u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens + u.outputTokens,
  };
}

function renderReport(
  model: string,
  reps: number,
  suite: EvalCase[],
  arms: Arm[],
  grid: Record<string, Record<string, Cell>>,
): string {
  const header = ["用例", "覆盖面", ...arms.map((a) => a.name)];
  const rows = suite.map((c) => {
    const cells = arms.map((a) => {
      const cell = grid[c.id]![a.name]!;
      return `${cell.pass}/${cell.reps} · ${(cell.turns / cell.reps).toFixed(1)}t · ${Math.round(cell.tokens / cell.reps / 1000)}k`;
    });
    return `| ${c.id} | ${c.covers} | ${cells.join(" | ")} |`;
  });

  // 每臂汇总
  const agg = arms.map((a) => {
    let pass = 0,
      reps2 = 0,
      turns = 0,
      tokens = 0;
    for (const c of suite) {
      const cell = grid[c.id]![a.name]!;
      pass += cell.pass;
      reps2 += cell.reps;
      turns += cell.turns;
      tokens += cell.tokens;
    }
    return { name: a.name, rate: pass / reps2, avgTurns: turns / reps2, avgTokens: tokens / reps2 };
  });

  const armLegend = arms.map((a) => `- **${a.name}**（${a.mode}）：${a.hypothesis}`).join("\n");
  const aggRows = agg
    .map(
      (a) =>
        `| ${a.name} | ${(a.rate * 100).toFixed(0)}% | ${a.avgTurns.toFixed(1)} | ${Math.round(a.avgTokens)} |`,
    )
    .join("\n");

  return `# Harness A/B 对比报告

- 日期：${new Date().toISOString().slice(0, 10)}
- 模型：\`${model}\`
- 规模：${suite.length} 用例 × ${arms.length} 臂 × ${reps} 次

## 实验臂

${armLegend}

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens |
|---|---|---|---|
${aggRows}

## 明细矩阵

单元格格式：\`通过/次数 · 平均轮数t · 平均 k-tokens\`

| ${header.join(" | ")} |
|${header.map(() => "---").join("|")}|
${rows.join("\n")}

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。
`;
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});

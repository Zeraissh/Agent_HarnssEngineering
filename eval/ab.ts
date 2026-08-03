/**
 * A/B 跑测器：同一套 eval 用例 × 多个实验臂，产出对比矩阵，量化各 harness 特性的收益。
 * 用法：npm run ab   （env 同 CLI：AGENT_MODEL / ANTHROPIC_BASE_URL / AGENT_PROVIDER…）
 *   AB_ARMS=baseline,verified   只跑指定臂（默认全部，见 arms.ts）
 *   AB_CASES=write-basic,sum-numbers   只跑指定用例（默认全部）
 *   AB_REPS=1                    每个(用例,臂)重复次数（默认 1；>1 用于看方差）
 *   AB_REPORT=eval/ab-report.md  报告输出路径（默认覆盖 eval/ab-report.md）
 *   AB_VERIFIER_MODEL=…          verified-strong 臂的核查模型；配套可选：
 *   AB_VERIFIER_PROVIDER / AB_VERIFIER_BASE_URL / AB_VERIFIER_API_KEY
 *     （缺省沿用执行者的端点配置；未设 AB_VERIFIER_MODEL 时自动跳过 strong 臂）
 *
 * 铁律：每个单独 run 前清空 eval-out/——否则某臂可能"通过"在别的臂遗留的文件上。
 */
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AgentLoop } from "../src/loop.js";
import { runPlanned, runVerified } from "../src/orchestrate.js";
import { RULE_PRECEDENCE_DISCIPLINE } from "../src/presets.js";
import { createModelClientFromEnv, type ResolvedProvider } from "../src/provider.js";
import { bashTool } from "../src/tools/bash.js";
import { readFileTool } from "../src/tools/read-file.js";
import { writeFileTool } from "../src/tools/write-file.js";
import type { Verdict } from "../src/verifier.js";
import type { AgentConfig, AgentRunResult, ModelClient } from "../src/types.js";
import { getArms, type Arm } from "./arms.js";
import { cases, type EvalCase } from "./cases.js";

// 2026-07-31 起（rule-precedence 采纳,见 ab-report-rulefirst.md）baseline 含成文口径纪律——
// 与更早报告横向比较时注意这是新的 baseline 时代
const SYSTEM_PROMPT =
  `You are a capable autonomous agent operating in a local working directory.
Complete the user's task end to end using the available tools.
Ground every claim of progress in an actual tool result. When the task is done, summarize what you did in one or two sentences.
Keep file outputs clean and well-structured. Respond in the language the user used.` + RULE_PRECEDENCE_DISCIPLINE;

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
  const caseFilter = process.env.AB_CASES?.split(",").map((s) => s.trim());
  const suite = caseFilter ? cases.filter((c) => caseFilter.includes(c.id)) : cases;

  // verified-strong 臂的独立核查模型（可指向不同端点）；未配置则跳过该臂
  const verifierModelName = process.env.AB_VERIFIER_MODEL;
  const verifierProvider: ResolvedProvider | undefined = verifierModelName
    ? createModelClientFromEnv(verifierModelName, {
        ...(process.env.AB_VERIFIER_PROVIDER
          ? { provider: process.env.AB_VERIFIER_PROVIDER as "anthropic" | "openai" }
          : {}),
        ...(process.env.AB_VERIFIER_BASE_URL ? { baseURL: process.env.AB_VERIFIER_BASE_URL } : {}),
        ...(process.env.AB_VERIFIER_API_KEY ? { apiKey: process.env.AB_VERIFIER_API_KEY } : {}),
      })
    : undefined;

  const arms = getArms(process.env.AB_ARMS?.split(",").map((s) => s.trim())).filter((a) => {
    if (a.verify?.strongModel && !verifierProvider) {
      console.log(`[skip] 臂 ${a.name} 需要 AB_VERIFIER_MODEL，未配置`);
      return false;
    }
    return true;
  });

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
        await evalCase.setup?.(workdir);

        const { result, turns, tokens, verdicts } = await runArm(
          arm,
          baseConfig,
          client,
          evalCase.task,
          verifierProvider,
        );
        cell.turns += turns;
        cell.tokens += tokens;
        // 评分策略（2026-07-25 改）：纯产物制——无论 stopReason 一律检查实际产物。
        // 旧策略对 max_turns 直接判负，但 agent 可能在最后一轮已写出正确产物；
        // 过程如何终止是过程指标（stopReason 单独留档），产物对错才是任务成败。
        const artifact = await evalCase.check(workdir);
        const verdict =
          result.stopReason === "completed"
            ? artifact
            : { ...artifact, note: `${artifact.note} [stopReason=${result.stopReason}]` };
        if (verdict.pass) cell.pass += 1;
        // 完整 transcript 留档（诊断用）：不留就无法回答"为什么烧穿了轮次/token"
        await mkdir(path.join(workdir, "eval", "transcripts"), { recursive: true });
        await writeFile(
          path.join(
            workdir,
            "eval",
            "transcripts",
            `${evalCase.id}__${arm.name}__rep${r + 1}__${Date.now()}.json`,
          ),
          JSON.stringify(
            { case: evalCase.id, arm: arm.name, rep: r + 1, model, stopReason: result.stopReason, verdict, messages: result.messages },
            null,
            2,
          ),
          "utf8",
        );
        // 逐 run 留档（诊断用）：裁决细节不落档，事后就只能靠 eval-out 遗留文件猜
        await appendFile(
          path.join(workdir, "eval", "ab-log.jsonl"),
          JSON.stringify({
            t: new Date().toISOString(),
            model,
            case: evalCase.id,
            arm: arm.name,
            rep: r + 1,
            pass: verdict.pass,
            note: verdict.note,
            stopReason: result.stopReason,
            turns,
            tokens,
            verifierVerdicts: verdicts,
          }) + "\n",
          "utf8",
        );
      }
      grid[evalCase.id]![arm.name] = cell;
      const c = grid[evalCase.id]![arm.name]!;
      console.log(
        `[${evalCase.id} / ${arm.name}] ${c.pass}/${c.reps} pass, ${(c.turns / c.reps).toFixed(1)} turns, ${Math.round(c.tokens / c.reps)} tok`,
      );
    }
  }

  const reportPath = process.env.AB_REPORT ?? path.join("eval", "ab-report.md");
  const report = renderReport(model, reps, suite, arms, grid, verifierModelName);
  await writeFile(path.join(workdir, reportPath), report, "utf8");
  console.log(`\n报告已写入 ${reportPath}`);
}

async function runArm(
  arm: Arm,
  base: AgentConfig,
  client: ModelClient,
  task: string,
  verifierProvider?: ResolvedProvider,
): Promise<{ result: AgentRunResult; turns: number; tokens: number; verdicts: Verdict[] }> {
  const cfg = arm.configure(base);
  if (arm.mode === "planned") {
    // 三角编排：planner 切分 → 每子任务 runVerified（各自全新轮次预算）
    const outcome = await runPlanned(cfg, client, task, {
      maxReworks: 1,
      onEvent: (source, event) => {
        // 只放行执行/返工的审批——planner/verifier 的 respond 是先到先得,
        // 抢答 allow 会把它们的内部只读 deny 变成空操作
        if (
          event.type === "approval_request" &&
          (source.endsWith("/main") || source.endsWith("/rework"))
        ) {
          event.respond("allow");
        }
      },
    });
    const tok = (u: { inputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; outputTokens: number }) =>
      u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens + u.outputTokens;
    let tokens = tok(outcome.planOutcome.usage);
    let turns = outcome.planOutcome.usage.turns;
    const verdicts = [];
    for (const step of outcome.steps) {
      tokens += tok(step.result.executionUsage);
      turns += step.result.executionUsage.turns;
      for (const v of step.result.verifications) {
        tokens += tok(v.usage);
        turns += v.usage.turns;
        verdicts.push(v.verdict);
      }
    }
    const lastMain = outcome.steps.at(-1)?.result.main;
    const result: AgentRunResult = lastMain ?? {
      stopReason: "error",
      messages: [],
      usage: outcome.planOutcome.usage,
      error: new Error("planner 未产出可解析计划"),
    };
    return { result, turns, tokens, verdicts };
  }
  if (arm.mode === "verified") {
    const outcome = await runVerified(cfg, client, task, {
      maxReworks: 1,
      ...(arm.verify?.instructions ? { verifyInstructions: arm.verify.instructions } : {}),
      ...(arm.verify?.reworkMode ? { reworkMode: arm.verify.reworkMode } : {}),
      ...(arm.verify?.strongModel && verifierProvider
        ? { verifierModel: { client: verifierProvider.client, compat: verifierProvider.compat } }
        : {}),
      // 只放行主/返工 agent 的审批——verifier 的 respond 先到先得,抢答 allow
      // 会打穿其只读 deny(2026-08-01 发现的潜伏 bug:此前 verified 臂一直被打穿)
      onEvent: (source, event) => {
        if (event.type === "approval_request" && source !== "verifier") event.respond("allow");
      },
    });
    // 成本 = 全部执行轮次合计（executionUsage 含被否掉的中间轮——旧版只算最后一轮，漏计返工前的主 run）+ 各次核查
    const mainU = outcome.executionUsage;
    let tokens =
      mainU.inputTokens + mainU.cacheCreationTokens + mainU.cacheReadTokens + mainU.outputTokens;
    let turns = mainU.turns;
    for (const v of outcome.verifications) {
      tokens += v.usage.inputTokens + v.usage.cacheCreationTokens + v.usage.cacheReadTokens + v.usage.outputTokens;
      turns += v.usage.turns;
    }
    return {
      result: outcome.main,
      turns,
      tokens,
      verdicts: outcome.verifications.map((v) => v.verdict),
    };
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
    verdicts: [],
  };
}

function renderReport(
  model: string,
  reps: number,
  suite: EvalCase[],
  arms: Arm[],
  grid: Record<string, Record<string, Cell>>,
  verifierModel?: string,
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
- 模型：\`${model}\`${verifierModel ? `\n- verifier 模型（verified-strong 臂）：\`${verifierModel}\`` : ""}
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

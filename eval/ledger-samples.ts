/**
 * §2.1 台账样本批量采集 —— `npm run ledger:samples`
 *
 * 跑若干带 `--verify` 的真实小任务，向 `.agent-runs.jsonl` 攒裁决样本。
 * 判据在 `src/ledger.ts` 的 `STRUCTURED_OUTPUT_EFFECT_RULE`（≥20 次实施后裁决）。
 *
 * 用法：
 *   npm run ledger:samples
 *   LEDGER_SAMPLES_TARGET=5 npm run ledger:samples   # 只补到目标样本数
 *   LEDGER_SAMPLES_TASKS=3 npm run ledger:samples  # 最多跑 3 次新任务
 *
 * 需 `.env` 或进程环境提供 API 凭据（与 CLI 相同）；无凭据时退出并提示。
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  decideStructuredOutputEffect,
  ledgerPath,
  summarizeLedger,
  STRUCTURED_OUTPUT_EFFECT_RULE,
  type RunLedgerEntry,
} from "../src/ledger.js";

const cwd = process.cwd();
const ledgerFile = ledgerPath();
const target = Number(process.env.LEDGER_SAMPLES_TARGET ?? STRUCTURED_OUTPUT_EFFECT_RULE.minSamples);
const maxNew = Number(process.env.LEDGER_SAMPLES_TASKS ?? 25);

function credentialPresent(): boolean {
  const p = process.env.AGENT_PROVIDER ?? "anthropic";
  if (p === "openai") return Boolean(process.env.OPENAI_API_KEY?.trim());
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

async function readLedger(): Promise<RunLedgerEntry[]> {
  try {
    const raw = await readFile(ledgerFile, "utf8");
    const entries: RunLedgerEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // 截断行跳过
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function runCliTask(task: string): Promise<{ code: number; signal: string | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      ["tsx", "--env-file-if-exists=.env", "src/cli.ts", "run", "--yes", "--verify", task],
      {
        cwd,
        env: {
          ...process.env,
          AGENT_MAX_TOKENS: process.env.LEDGER_SAMPLES_MAX_TOKENS ?? "4096",
          AGENT_MAX_TURNS: process.env.LEDGER_SAMPLES_MAX_TURNS ?? "8",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    child.stdout?.on("data", (c) => {
      out += c;
      process.stdout.write(c);
    });
    child.stderr?.on("data", (c) => {
      out += c;
      process.stderr.write(c);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0) {
        console.error(`\n✘ 任务失败 (code=${code ?? "null"})：${task.slice(0, 60)}…`);
        if (out.includes("credential") || out.includes("API key") || out.includes("401")) {
          console.error("  （疑似凭据/鉴权问题，检查 .env 或环境变量）");
        }
      }
      resolve({ code: code ?? 1, signal });
    });
  });
}

const TASK_TEMPLATES = [
  "在 eval-out/ledger-s{n}.txt 写入一行：sample {n}",
  "在 eval-out/ledger-s{n}.txt 写入两行：第一行 line-a，第二行 line-b",
  "在 eval-out/ledger-s{n}.md 写入一个一级标题「Sample {n}」和一行正文 ok",
  "在 eval-out/ledger-s{n}.json 写入 JSON：{\"id\":{n},\"status\":\"ok\"}",
  "在 eval-out/ledger-s{n}.txt 写入三行数字：1、2、3",
];

async function main(): Promise<void> {
  if (!credentialPresent()) {
    console.error("✘ 未检测到 API 凭据。");
    console.error("  复制 .env.example → .env 并填写 ANTHROPIC_API_KEY（或 OPENAI_API_KEY）。");
    console.error("  Cloud Agent 可在环境设置里注入同名 Secret。");
    process.exit(1);
  }

  const before = await readLedger();
  const beforeSummary = summarizeLedger(before);
  const need = Math.max(0, target - beforeSummary.structured.verdicts);
  const toRun = Math.min(maxNew, need > 0 ? need : maxNew);

  console.log(`台账：${ledgerFile}`);
  console.log(
    `实施后裁决 ${beforeSummary.structured.verdicts}/${target}，` +
      `本次计划跑 ${toRun} 次（need=${need}，cap=${maxNew}）`,
  );

  if (need === 0 && beforeSummary.structured.verdicts >= target) {
    const eff = decideStructuredOutputEffect(beforeSummary);
    console.log(`\n样本已够：§2.1 效果 = ${eff.effect}`);
    console.log(eff.why);
    process.exit(0);
  }

  await rm(path.join(cwd, "eval-out"), { recursive: true, force: true });
  await mkdir(path.join(cwd, "eval-out"), { recursive: true });

  const startIdx = beforeSummary.runs + 1;
  for (let i = 0; i < toRun; i++) {
    const n = startIdx + i;
    const template = TASK_TEMPLATES[i % TASK_TEMPLATES.length]!;
    const task = template.replace(/\{n\}/g, String(n));
    console.log(`\n── [${i + 1}/${toRun}] ${task} ──`);
    const { code } = await runCliTask(task);
    if (code !== 0) {
      console.error("中止批量：上一任务未成功完成。");
      process.exit(1);
    }
    const mid = summarizeLedger(await readLedger());
    if (mid.structured.verdicts >= target) {
      console.log(`\n已达目标样本 ${target}，提前结束。`);
      break;
    }
  }

  const after = summarizeLedger(await readLedger());
  const eff = decideStructuredOutputEffect(after);
  console.log("\n── 汇总 ──");
  console.log(`运行 ${after.runs} 次，带核查 ${after.verifiedRuns}，实施后裁决 ${after.structured.verdicts}`);
  console.log(`§2.1 效果：${eff.effect} — ${eff.why}`);
  console.log(`\n完整读数：npm run ledger`);
}

main().catch((err) => {
  console.error("✘ ledger:samples 失败：", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

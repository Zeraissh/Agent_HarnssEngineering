/**
 * CLI：读 ab-log + baselines/nightly.json，比对后写报告；失败 exit 1。
 *
 *   npm run eval:compare-baseline -- [ab-log路径] [基线路径]
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  cellsFromAbLog,
  compareNightly,
  type NightlyBaseline,
} from "./compare-baseline.js";

async function main(): Promise<void> {
  const workdir = process.cwd();
  const logPath = path.resolve(workdir, process.argv[2] ?? path.join("eval", "ab-log.jsonl"));
  const baselinePath = path.resolve(
    workdir,
    process.argv[3] ?? path.join("eval", "baselines", "nightly.json"),
  );
  const outJson = path.resolve(workdir, process.env.COMPARE_OUT ?? path.join("eval", "nightly-compare.json"));

  const rawBaseline = JSON.parse(await readFile(baselinePath, "utf8")) as NightlyBaseline;
  if (rawBaseline.version !== 1) {
    throw new Error(`unsupported baseline version: ${String((rawBaseline as { version?: unknown }).version)}`);
  }

  let logText = "";
  try {
    logText = await readFile(logPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
  const lines = logText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  const cells = cellsFromAbLog(lines);
  const result = compareNightly(cells, rawBaseline);
  await writeFile(outJson, JSON.stringify({ baselinePath, logPath, ...result }, null, 2), "utf8");

  if (!result.ok) {
    console.error("nightly baseline compare FAILED:");
    for (const f of result.failures) console.error(`  - ${f}`);
    console.error(`report: ${outJson}`);
    process.exit(1);
  }
  console.log(
    `nightly baseline OK: passRate=${result.observed.passRate.toFixed(3)} tokens=${result.observed.totalTokens} wallMs=${result.observed.totalWallMs}`,
  );
  console.log(`report: ${outJson}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

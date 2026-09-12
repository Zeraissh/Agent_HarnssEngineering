/**
 * TEST-01 — changed-line coverage。
 *
 * 全仓棘轮只挡住平均值回退；PR 改了的可执行行仍可能是 0 hit。
 * 本脚本拿 unified diff 对 lcov 的 DA 行：改到的、被插桩的行 hit 必须 > 0。
 *
 * 用法：
 *   npm run test:changed-coverage -- --base origin/main
 *   node scripts/changed-line-coverage.mjs --lcov coverage/lcov.info --diff path.diff
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export function coverageInclude(file) {
  const n = file.replace(/\\/g, "/").replace(/^\.\//, "");
  if (n.startsWith("src/") && n.endsWith(".ts") && !n.endsWith(".d.ts")) return true;
  if (/^ui\/[^/]+\.ts$/.test(n) && !n.endsWith(".d.ts")) return true;
  return false;
}

/** @returns {Map<string, Map<number, number>>} file → line → hits */
export function parseLcov(text) {
  const files = new Map();
  let current = null;
  let lines = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith("SF:")) {
      current = raw.slice(3).replace(/\\/g, "/");
      lines = new Map();
      files.set(current, lines);
    } else if (raw.startsWith("DA:") && lines) {
      const [line, hits] = raw.slice(3).split(",");
      lines.set(Number(line), Number(hits));
    } else if (raw === "end_of_record") {
      current = null;
      lines = null;
    }
  }
  return files;
}

/**
 * 只收新文件侧的行号（+ 行）。删行不要求覆盖。
 * @returns {Map<string, Set<number>>}
 */
export function parseUnifiedDiff(text) {
  const out = new Map();
  let file = null;
  let newLine = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith("+++ ")) {
      const name = raw.slice(4).replace(/^\w\//, "").replace(/\\/g, "/");
      file = name === "/dev/null" ? null : name;
      if (file && !out.has(file)) out.set(file, new Set());
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      out.get(file)?.add(newLine);
      newLine += 1;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      // 旧行，新侧行号不动
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file"
    } else {
      newLine += 1;
    }
  }
  return out;
}

function lcovFileFor(lcov, rel) {
  const needle = rel.replace(/\\/g, "/");
  for (const [sf, lines] of lcov) {
    const n = sf.replace(/\\/g, "/");
    if (n === needle || n.endsWith(`/${needle}`) || n.endsWith(`\\${needle}`)) return lines;
  }
  return null;
}

/**
 * @returns {{ ok: boolean, uncovered: Array<{file:string,line:number,hits:number}>, checked: number, skippedUninstrumented: number, missingFiles: string[] }}
 */
export function changedLineCoverage({ lcovText, diffText }) {
  const lcov = parseLcov(lcovText);
  const changed = parseUnifiedDiff(diffText);
  const uncovered = [];
  const missingFiles = [];
  let checked = 0;
  let skippedUninstrumented = 0;

  for (const [file, lines] of changed) {
    if (!coverageInclude(file)) continue;
    if (lines.size === 0) continue;
    const da = lcovFileFor(lcov, file);
    if (!da) {
      missingFiles.push(file);
      continue;
    }
    for (const line of lines) {
      if (!da.has(line)) {
        skippedUninstrumented += 1;
        continue;
      }
      checked += 1;
      const hits = da.get(line) ?? 0;
      if (hits <= 0) uncovered.push({ file, line, hits });
    }
  }

  return {
    ok: uncovered.length === 0 && missingFiles.length === 0,
    uncovered,
    checked,
    skippedUninstrumented,
    missingFiles,
  };
}

export function gitDiff(base, cwd = process.cwd()) {
  const result = spawnSync("git", ["diff", "--unified=0", `${base}...HEAD`], {
    cwd,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git diff failed (${result.status})`);
  }
  return result.stdout ?? "";
}

function parseArgs(argv) {
  const out = { lcov: "coverage/lcov.info", diff: null, base: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--lcov") out.lcov = argv[++i];
    else if (a === "--diff") out.diff = argv[++i];
    else if (a === "--base") out.base = argv[++i];
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const lcovPath = resolve(args.lcov);
  if (!existsSync(lcovPath)) {
    console.error(`changed-line-coverage: missing ${args.lcov} (run npm run test:coverage first)`);
    process.exit(1);
  }
  let diffText;
  if (args.diff) {
    diffText = readFileSync(args.diff, "utf8");
  } else {
    const base = args.base ?? process.env.CHANGED_COVERAGE_BASE ?? "";
    if (!base) {
      if (process.env.CI) {
        console.error("changed-line-coverage: --base required in CI");
        process.exit(1);
      }
      console.log("changed-line-coverage: no --base, skip (local)");
      process.exit(0);
    }
    try {
      diffText = gitDiff(base);
    } catch (err) {
      console.error(`changed-line-coverage: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  const report = changedLineCoverage({
    lcovText: readFileSync(lcovPath, "utf8"),
    diffText,
  });
  console.log(
    `changed-line-coverage: checked=${report.checked} uninstrumented=${report.skippedUninstrumented} uncovered=${report.uncovered.length} missingFiles=${report.missingFiles.length}`,
  );
  for (const miss of report.missingFiles) {
    console.error(`  missing from lcov: ${miss}`);
  }
  for (const row of report.uncovered) {
    console.error(`  ${row.file}:${row.line} hits=${row.hits}`);
  }
  process.exit(report.ok ? 0 : 1);
}

const invoked = process.argv[1] && /changed-line-coverage\.mjs$/.test(process.argv[1].replace(/\\/g, "/"));
if (invoked) main();

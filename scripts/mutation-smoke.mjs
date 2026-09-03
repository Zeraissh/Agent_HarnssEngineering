#!/usr/bin/env node
/**
 * TEST-01a mutation smoke — 固定清单的关键变异必须变红。
 *
 * 不引 Stryker：对源文件就地打补丁 → 跑对应测试文件 → 必须失败 → 还原。
 * 任一变异测绿（假绿）或还原失败都会让本脚本以非零退出。
 *
 * 用法：npm run test:mutation-smoke
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @typedef {{
 *   id: string;
 *   file: string;
 *   find: string;
 *   replace: string;
 *   testFiles: string[];
 *   why: string;
 * }} Mutant
 */

/** @type {Mutant[]} */
const MUTANTS = [
  {
    id: "transient-always-false",
    file: "src/model-client.ts",
    find: "export function isTransientApiError(err: unknown): boolean {\n  if (err instanceof Anthropic.APIUserAbortError) return false;",
    replace:
      "export function isTransientApiError(err: unknown): boolean {\n  return false; // MUTATION\n  if (err instanceof Anthropic.APIUserAbortError) return false;",
    testFiles: ["test/loop.test.ts"],
    why: "503 同轮重试依赖瞬时判定；恒假会让瞬时错误立刻终止",
  },
  {
    id: "transient-always-true",
    file: "src/model-client.ts",
    find: "export function isTransientApiError(err: unknown): boolean {\n  if (err instanceof Anthropic.APIUserAbortError) return false;",
    replace:
      "export function isTransientApiError(err: unknown): boolean {\n  return true; // MUTATION\n  if (err instanceof Anthropic.APIUserAbortError) return false;",
    testFiles: ["test/loop.test.ts"],
    why: "401 等永久错误不得重试；恒真会白烧重试预算",
  },
  {
    id: "approval-gate-bypass",
    file: "src/tools/registry.ts",
    find: '    if (tool.permission === "ask") {\n      const { decision, reason } = await approve(block);\n      if (decision === "deny") {\n        return {\n          content: `User denied permission to run "${block.name}".${reason ? ` Reason: ${reason}` : ""} Adjust your approach or ask the user how to proceed.`,\n          isError: true,\n        };\n      }\n    }',
    replace: "    // MUTATION: approval gate bypassed\n",
    testFiles: ["test/loop.test.ts"],
    why: "permission=ask 必须挂起审批；绕过等于 silent allow",
  },
  {
    id: "tool-choice-none-dropped",
    file: "src/model-client.ts",
    find: 'export function toAnthropicToolChoice(choice: ToolChoice): Anthropic.ToolChoice {\n  return choice === "none" ? { type: "none" } : { type: "tool", name: choice.name };\n}',
    replace:
      'export function toAnthropicToolChoice(choice: ToolChoice): Anthropic.ToolChoice {\n  // MUTATION: none 映射丢失 → 禁工具约束静默失效\n  return choice === "none" ? ({ type: "auto" } as Anthropic.ToolChoice) : { type: "tool", name: choice.name };\n}',
    testFiles: ["test/anthropic-client.test.ts"],
    why: "tool_choice=none 必须真的发到 wire；映射丢了不会编译报错",
  },
  {
    id: "verdict-fail-open",
    file: "src/verifier.ts",
    find: [
      "  return {",
      "    passed: false,",
      "    issues: [VERDICT_PARSE_FAIL],",
      '    summary: text.slice(0, 200) || "(空输出)",',
      "  };",
      "}",
    ].join("\n"),
    replace: [
      "  return {",
      "    passed: true, // MUTATION: fail-closed → fail-open",
      "    issues: [VERDICT_PARSE_FAIL],",
      '    summary: text.slice(0, 200) || "(空输出)",',
      "  };",
      "}",
    ].join("\n"),
    testFiles: ["test/verifier.test.ts"],
    why: "无法解析的裁决必须 passed=false；改 true 会放过假核查",
  },
  {
    id: "verifier-readonly-always-allow",
    file: "src/verifier.ts",
    find: '          event.respond("deny", `Verifier is read-only. Use read_file or read-only commands to inspect.${hint}`);',
    replace: '          event.respond("allow"); // MUTATION: verifier 只读门放行',
    testFiles: ["test/verifier.test.ts"],
    why: "verifier 对写类工具必须 deny；恒 allow 打穿只读硬约束",
  },
  {
    id: "ledger-noop",
    file: "src/ledger.ts",
    find: [
      "export async function appendRunLedger(",
      "  entry: RunLedgerEntry,",
      "  file: string = ledgerPath(),",
      "): Promise<boolean> {",
      "  try {",
      "    await appendFile(file, `${JSON.stringify(entry)}\\n`, \"utf8\");",
      "    return true;",
      "  } catch {",
      "    return false;",
      "  }",
      "}",
    ].join("\n"),
    replace: [
      "export async function appendRunLedger(",
      "  entry: RunLedgerEntry,",
      "  file: string = ledgerPath(),",
      "): Promise<boolean> {",
      "  return true; // MUTATION: 宣称成功但不落盘",
      "}",
    ].join("\n"),
    testFiles: ["test/ledger.test.ts"],
    why: "台账写入成功必须真有行；空成功会让统计与对照失真",
  },
  {
    id: "credential-like-always-false",
    file: "src/tools/fs-util.ts",
    find: "export function credentialLikeName(p: string): boolean {\n",
    replace: "export function credentialLikeName(p: string): boolean {\n  return false; // MUTATION\n",
    testFiles: ["test/tools.test.ts"],
    why: "read_file 对 .env/密钥形状必须 fail-closed；恒假会泄露密钥进正史",
  },
  {
    id: "compact-ledger-skipped",
    file: "src/context.ts",
    find: "    const ledger = mergeCompactLedgers(priorLedger, scanned);\n    const withLedger = upsertCompactLedger(out, ledger);\n    return {\n      messages: withLedger,\n      droppedBlocks: dropped,\n      ledgerEntries: ledgerEntryCount(ledger),\n      ledger,\n    };",
    replace:
      "    // MUTATION: skip semantic ledger — regress to placeholder-only compaction\n    return {\n      messages: out,\n      droppedBlocks: dropped,\n      ledgerEntries: 0,\n      ledger: emptyCompactLedger(),\n    };",
    testFiles: ["test/compact.test.ts"],
    why: "MEM-01 压缩必须写入 compact_ledger；退回纯占位等于语义残留丢失",
  },
  {
    id: "prefer-healthy-never-skips",
    file: "src/model-fallback.ts",
    find: "        if (othersMayWork && stickySaysUnhealthy(id)) {\n          skipped.push(ep.name);\n          previous = { name: ep.name, reason: \"probe_unhealthy\" };\n          continue;\n        }",
    replace:
      "        // MUTATION: prefer_healthy 不再跳过不健康端点\n        if (false && othersMayWork && stickySaysUnhealthy(id)) {\n          skipped.push(ep.name);\n          previous = { name: ep.name, reason: \"probe_unhealthy\" };\n          continue;\n        }",
    testFiles: ["test/model-fallback.test.ts"],
    why: "prefer_healthy 有健康候选时必须跳过 sticky unhealthy；否则 stub 形同虚设",
  },
];

function runVitest(testFiles) {
  const args = ["vitest", "run", "--reporter=dot", ...testFiles];
  const result = spawnSync("npx", args, {
    cwd: root,
    encoding: "utf8",
    shell: true,
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function applyMutant(m) {
  const abs = join(root, m.file);
  const original = readFileSync(abs, "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const find = m.find.replace(/\n/g, eol);
  const replace = m.replace.replace(/\n/g, eol);
  if (!original.includes(find)) {
    throw new Error(`[${m.id}] find 串在 ${m.file} 中未命中——源码漂移，请更新 scripts/mutation-smoke.mjs`);
  }
  if (original.includes("// MUTATION")) {
    throw new Error(`[${m.id}] 源文件已含 MUTATION 标记，上次可能未还原`);
  }
  const next = original.replace(find, replace);
  if (next === original) {
    throw new Error(`[${m.id}] replace 未改变文件`);
  }
  const backup = `${abs}.mutation-bak`;
  copyFileSync(abs, backup);
  writeFileSync(abs, next, "utf8");
  return { abs, backup, original };
}

function restoreSync(abs, backup, original) {
  writeFileSync(abs, original, "utf8");
  try {
    unlinkSync(backup);
  } catch {
    /* ignore */
  }
}

let failed = 0;
const results = [];

console.log(`mutation-smoke: ${MUTANTS.length} mutants @ ${root}\n`);

for (const m of MUTANTS) {
  process.stdout.write(`→ ${m.id} … `);
  let handle;
  try {
    handle = applyMutant(m);
  } catch (err) {
    console.log("SETUP FAIL");
    console.error(`  ${err instanceof Error ? err.message : err}`);
    failed += 1;
    results.push({ id: m.id, outcome: "setup_fail" });
    continue;
  }

  let outcome;
  try {
    const run = runVitest(m.testFiles);
    if (run.ok) {
      console.log("SURVIVED (tests still green — lock is blind)");
      failed += 1;
      outcome = "survived";
    } else {
      console.log("killed (tests red, as required)");
      outcome = "killed";
    }
  } catch (err) {
    console.log("RUN FAIL");
    console.error(`  ${err instanceof Error ? err.message : err}`);
    failed += 1;
    outcome = "run_fail";
  } finally {
    restoreSync(handle.abs, handle.backup, handle.original);
    // 再读一眼确认还原干净
    const now = readFileSync(handle.abs, "utf8");
    if (now !== handle.original) {
      console.error(`  FATAL: ${m.file} 还原后与原文不一致`);
      failed += 1;
      outcome = "restore_fail";
    }
    if (existsSync(handle.backup)) {
      try {
        unlinkSync(handle.backup);
      } catch {
        /* ignore */
      }
    }
  }
  results.push({ id: m.id, outcome, why: m.why });
}

console.log("\n── summary ──");
for (const r of results) {
  console.log(`  ${r.outcome.padEnd(12)} ${r.id}`);
}
const killed = results.filter((r) => r.outcome === "killed").length;
console.log(`\nkilled ${killed}/${MUTANTS.length}; failures=${failed}`);

if (failed > 0) {
  process.exit(1);
}

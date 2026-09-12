#!/usr/bin/env node
/**
 * TEST-01a mutation smoke — 固定清单的关键变异必须变红。
 *
 * 不引 Stryker：对源文件就地打补丁 → 跑对应测试文件 → 必须失败 → 还原。
 * 任一变异测绿（假绿）或还原失败都会让本脚本以非零退出。
 *
 * 用法：npm run test:mutation-smoke
 * 只跑若干：MUTATION_ONLY=id1,id2 npm run test:mutation-smoke
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
    find: "    const ledger = mergeCompactLedgers(priorLedger, scanned, collapsedLedger);\n    const withLedger = upsertCompactLedger(out, ledger);\n    return {\n      messages: withLedger,\n      droppedBlocks: dropped,\n      ledgerEntries: ledgerEntryCount(ledger),\n      ledger,\n      summaryApplied: false,\n      collapsedTurns,\n      changed: true,\n    };",
    replace:
      "    // MUTATION: skip semantic ledger — regress to placeholder-only compaction\n    return {\n      messages: out,\n      droppedBlocks: dropped,\n      ledgerEntries: 0,\n      ledger: emptyCompactLedger(),\n      summaryApplied: false,\n      collapsedTurns,\n      changed: true,\n    };",
    testFiles: ["test/compact.test.ts"],
    why: "MEM-01 压缩必须写入 compact_ledger；退回纯占位等于语义残留丢失",
  },
  {
    id: "compact-summary-replaces-ledger",
    file: "src/compact-summary.ts",
    find: "export function mergeSummaryIntoLedger(\n  base: CompactLedger,\n  enrichment: CompactSummaryEnrichment,\n): CompactLedger {\n  const merged = mergeCompactLedgers(base, enrichment.additions);\n",
    replace:
      "export function mergeSummaryIntoLedger(\n  base: CompactLedger,\n  enrichment: CompactSummaryEnrichment,\n): CompactLedger {\n  // MUTATION: replace buckets with summary-only additions — lose Phase A facts\n  const merged = enrichment.additions;\n  void base;\n  void mergeCompactLedgers;\n",
    testFiles: ["test/compact-summary.test.ts"],
    why: "Phase B 必须 merge 进 Phase A 账本，不得用摘要桶替换启发式桶",
  },
  {
    id: "compact-tier2-skipped",
    file: "src/context.ts",
    find: "    const needTier2 =\n      force || dropped === 0 || estimatedAfter >= this.contextTokenLimit * COMPACT_WATERMARK;",
    replace:
      "    // MUTATION: tier 2 never runs — long assistant text / small results stay forever\n    const needTier2 = false as boolean;\n    void force; void estimatedAfter;",
    testFiles: ["test/compact-tier2.test.ts"],
    why: "MEM-01 Phase C：tier 1 无可置换或置换后仍在水位上时必须折叠旧轮；退回 tier 1 = 水位只涨不落",
  },
  {
    id: "reactive-compaction-skipped",
    file: "src/loop.ts",
    find: "            if (isContextOverflowError(err) && !reactiveCompactionUsed) {",
    replace: "            if (false && isContextOverflowError(err) && !reactiveCompactionUsed) { // MUTATION",
    testFiles: ["test/compact-tier2.test.ts"],
    why: "端点 context-too-long 400 必须触发硬压缩重发；跳过 = 整段工作因一次超长请求作废",
  },
  {
    id: "tool-result-snip-bypassed",
    file: "src/tools/registry.ts",
    find: "  const limit = Math.max(1000, Math.floor(maxChars));\n  if (result.content.length <= limit) return result;",
    replace: "  const limit = Math.max(1000, Math.floor(maxChars));\n  if (true || result.content.length <= limit) return result; // MUTATION",
    testFiles: ["test/compact-tier2.test.ts"],
    why: "单个 tool_result 入口截断是兜底：MCP 返回无上限，绕过它一次几百 KB 就顶穿上下文",
  },
  {
    id: "compact-excerpt-dropped",
    file: "src/context.ts",
    find: "            excerpt: excerptToolResult(b.content, b.is_error === true),\n            local,\n          });",
    replace: "            local, // MUTATION: excerpt dropped — placeholder carries no fact from the original\n          });",
    testFiles: ["test/compact.test.ts", "test/compact-tier2.test.ts"],
    why: "占位符必须带原文首行摘录；丢了模型只能重跑工具找回事实（真机 72 次补读 / 8 轮）",
  },
  {
    id: "compact-tier2-elided-again",
    file: "src/context.ts",
    find: '          ? (parseSemanticPlaceholderExcerpt(b.content) ?? "(elided)")\n',
    replace: '          ? "(elided)" // MUTATION: collapse throws the excerpt away again\n',
    testFiles: ["test/compact-tier2.test.ts"],
    why: "tier 2 折叠已置换的块时必须复用占位符里的摘录；写回 (elided) 首行事实随折叠丢失",
  },
  {
    id: "ledger-compaction-uncounted",
    file: "src/ledger.ts",
    find: '  if (event.type !== "compaction") return tally;\n  if (event.reactive === true) tally.reactive += 1;',
    replace:
      '  return tally; // MUTATION: compaction never counted\n  if (event.type !== "compaction") return tally;\n  if (event.reactive === true) tally.reactive += 1;',
    testFiles: ["test/ledger.test.ts"],
    why: "台账不记压缩次数，反应式救回超长请求的代价（补读）就永远只在事件流里可见",
  },
  {
    id: "context-budget-clamp-dropped",
    file: "src/context-window.ts",
    find: "  if (maxBudget === null || requested <= maxBudget) {",
    replace: "  if (true || maxBudget === null || requested <= maxBudget) { // MUTATION: never clamp",
    testFiles: ["test/context-window.test.ts"],
    why: "预算必须夹进 窗口 − maxTokens − 边际：128k 模型上 150k 默认预算不夹 = 主动压缩永不触发，只剩反应式白吃 400",
  },
  {
    id: "context-window-learn-dropped",
    file: "src/loop.ts",
    find: "              const learnedWindow = parseContextWindowFromOverflowError(err);",
    replace:
      "              const learnedWindow = null as number | null; void parseContextWindowFromOverflowError; // MUTATION: never learn",
    testFiles: ["test/compact-tier2.test.ts"],
    why: "撞 400 时报文里的窗口必须学走：不学，下一次同端点的运行仍按 unknown 算预算，反应式 400 每次都吃",
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
  {
    id: "same-run-resume-allows-executing",
    file: "src/run-state.ts",
    find: "  if (input.phase !== \"interrupted\") return false;\n  if (input.budgetExhausted) return false;",
    replace:
      "  if (false && input.phase !== \"interrupted\") return false; // MUTATION: allow non-interrupted\n  if (input.budgetExhausted) return false;",
    testFiles: ["test/run-state.test.ts"],
    why: "sameRunResume 仅 interrupted；放宽会把完成态档案谎报可同 run 热续",
  },
  {
    id: "plan-resume-without-passed",
    file: "src/run-state.ts",
    find: "    if (!p.hasPassedNode) return false;",
    replace: "    if (false && !p.hasPassedNode) return false; // MUTATION: 零进度也续发射",
    testFiles: ["test/run-state.test.ts"],
    why: "半截 DAG 必须已有 passed 节点才同 run 续发射；否则中途崩溃会用新 toolUseId 重做副作用",
  },
  {
    id: "cli-plan-resume-skips-crash-interrupt",
    file: "src/cli-durable.ts",
    find: "  if (CLI_CRASH_PHASES.has(current.phase)) {\n    const interrupted = transitionRunState(current, { type: \"interrupt\" });\n    if (interrupted) current = interrupted;\n  }",
    replace:
      "  if (false && CLI_CRASH_PHASES.has(current.phase)) {\n    const interrupted = transitionRunState(current, { type: \"interrupt\" });\n    if (interrupted) current = interrupted;\n  }",
    testFiles: ["test/cli-durable.test.ts"],
    why: "CLI Ctrl+C / 硬杀常把 phase 留在 executing；不先 interrupt，canSameRunResume 会拒半截 DAG",
  },
  {
    id: "cli-plan-resume-ignores-budget",
    file: "src/cli-durable.ts",
    find: "  const facts = planResumeFacts(current.plan);\n  const budgetExhausted = durableBudgetExhausted(current.budget);",
    replace:
      "  const facts = planResumeFacts(current.plan);\n  const budgetExhausted = false; // MUTATION: 落盘账耗尽仍同 run 续",
    testFiles: ["test/cli-durable.test.ts"],
    why: "CLI 半截 DAG 续跑必须读谱系预算；恒假会把已用尽的档案再跑一遍",
  },
  {
    id: "cli-single-resume-without-checkpoint",
    file: "src/cli-durable.ts",
    find: "  const hasCheckpoint = Boolean(current.checkpoint) && opts.hasHistory;",
    replace: "  const hasCheckpoint = true; // MUTATION: 飞行中无检查点也同 run 续",
    testFiles: ["test/cli-durable.test.ts"],
    why: "单执行者同 run 必须已提交 main 检查点；恒真会把飞行中崩溃当可续",
  },
  {
    id: "cli-skips-meta-json",
    file: "src/cli-durable.ts",
    find: "  writer.writeMeta(meta);\n",
    replace: "  // MUTATION: 不写 meta.json → Web 列表看不见 CLI 档案\n",
    testFiles: ["test/cli-durable.test.ts"],
    why: "CLI 档案必须写 meta.json，否则 loadArchivedMetas 跳过、Web 列表空白",
  },
  {
    id: "cli-skips-plan-result-event",
    file: "src/cli.ts",
    find: "    cliDurable?.noteHostEvent(hostPlanResultEvent(outcome, { startedAt, planReadyAt, finishedAt }));",
    replace: "    // MUTATION: plan_result 不进 events.jsonl",
    testFiles: ["test/cli-durable.test.ts"],
    why: "CLI 编排收尾必须写 plan_result；否则 Web 重放看不到子任务结局与 planner 失败摘要",
  },
  {
    id: "cli-skips-plan-resume-event",
    file: "src/cli.ts",
    find: "      cliDurable?.noteHostEvent(hostPlanResumeEvent({ kept, remaining, reason: plannedTask }));",
    replace: "      // MUTATION: plan_resume 只打控制台，不进 events.jsonl",
    testFiles: ["test/cli-durable.test.ts"],
    why: "CLI 半截 DAG 续跑必须把 plan_resume 写入档案；否则 Web 重放看不见续发射",
  },
  {
    id: "cli-skips-host-cli",
    file: "src/cli-durable.ts",
    find: "    checkpoint: cliMetaCheckpoint(opts.state),\n    host: \"cli\",\n    continuedFrom: prev?.continuedFrom ?? opts.state.continuedFrom ?? null,",
    replace:
      "    checkpoint: cliMetaCheckpoint(opts.state),\n    continuedFrom: prev?.continuedFrom ?? opts.state.continuedFrom ?? null,",
    testFiles: ["test/cli-durable.test.ts"],
    why: "CLI 档案必须写 meta.host=cli，否则 Web 列表无法标来源",
  },
  {
    id: "cli-skips-turn-events",
    file: "src/cli-durable.ts",
    find: "    noteEvent(source, event) {\n      if (isEphemeralTurnEvent(event)) return;\n      const payload = serializeTurnEventForArchive(source, event, archiveSegmentIndex);\n      writer.appendEvent({",
    replace:
      "    noteEvent(source, event) {\n      if (isEphemeralTurnEvent(event)) return;\n      return; // MUTATION: turn events 不进 events.jsonl\n      const payload = serializeTurnEventForArchive(source, event, archiveSegmentIndex);\n      writer.appendEvent({",
    testFiles: ["test/cli-durable.test.ts"],
    why: "CLI 必须把 TurnEvent 投影进 events.jsonl；否则 Web 打开对话只有 run_end",
  },
  {
    id: "tool-tx-committed-must-skip",
    file: "src/tool-tx.ts",
    find: "  if (existing.status === \"committed\") {\n    return {\n      action: \"skip_committed\",",
    replace:
      "  if (false && existing.status === \"committed\") {\n    // MUTATION: committed 不再跳过 → 重复副作用\n    return {\n      action: \"skip_committed\",",
    testFiles: ["test/tool-tx.test.ts"],
    why: "SAFE-06：已 committed 同 key 必须跳过，否则崩溃恢复会重复写入",
  },
  {
    id: "hook-exit-1-quietly-blocks",
    file: "src/hooks.ts",
    find: "  if (exitCode === 2) return \"block\";",
    replace: "  if (exitCode === 1 || exitCode === 2) return \"block\"; // MUTATION: exit 1 悄悄阻断",
    testFiles: ["test/hooks.test.ts"],
    why: "exit 1 必须是非阻断错误；悄悄阻断会让写坏的 hook 掐死整轮",
  },
  {
    id: "hook-exit-2-quietly-allows",
    file: "src/hooks.ts",
    find: "  if (exitCode === 2) return \"block\";",
    replace: "  if (exitCode === 2) return \"allow\"; // MUTATION: exit 2 悄悄放行",
    testFiles: ["test/hooks.test.ts"],
    why: "exit 2 必须阻断；悄悄放行等于 hooks 权限门不存在",
  },
  {
    id: "agent-md-leaks-to-verifier",
    file: "src/agent-md.ts",
    find: "export function withoutAgentMd(cfg: AgentConfig): AgentConfig {\n  if (!cfg.dynamicContext?.[AGENT_MD_CONTEXT_KEY]) return cfg;",
    replace:
      "export function withoutAgentMd(cfg: AgentConfig): AgentConfig {\n  return cfg; // MUTATION: 核查者看得到 AGENT.md\n  if (!cfg.dynamicContext?.[AGENT_MD_CONTEXT_KEY]) return cfg;",
    testFiles: ["test/agent-md.test.ts"],
    why: "verifier 必须是干净上下文；AGENT.md 漏过去等于项目文件能写核查纪律",
  },
  {
    id: "approval-auto-counted-as-asked",
    file: "src/ledger.ts",
    find: '  else if (actor === "auto-run" || actor === "auto-rule") tally.auto += 1;',
    replace: '  else if (actor === "auto-run" || actor === "auto-rule") tally.asked += 1; // MUTATION: --yes 记成问过人',
    testFiles: ["test/ledger.test.ts"],
    why: "自动放行必须进 auto 桶；记进 asked 会把 --yes 画成人工审批",
  },
  {
    id: "mcp-side-effect-declaration-ignored",
    file: "src/tool-tx.ts",
    find: "    if (nameOrTool.sideEffect === true) return true;",
    replace: "    if (false && nameOrTool.sideEffect === true) return true; // MUTATION: 声明进不了事务",
    testFiles: ["test/tool-tx.test.ts"],
    why: "启发式认不出的 MCP 写工具只能靠 sideEffect 声明进事务；忽略声明等于漏检原样回来",
  },
  {
    id: "future-schema-classified-as-malformed",
    file: "ui/history.ts",
    find: '    return { ok: false, state: null, reason: "unsupported_version", version };',
    replace: '    return { ok: false, state: null, reason: "malformed", version }; // MUTATION: 未来版本与坏形状分不清',
    testFiles: ["test/run-state-persist.test.ts"],
    why: "升级演练必须把 unsupported_version 与 malformed 分开，否则不知道该回滚 schema 还是丢档案",
  },
  {
    id: "run-config-permission-uses-stale-label",
    file: "ui/server.ts",
    find: "        const matched = matchPermissionMode(switches);",
    replace: "        const matched = run.permissionMode ?? matchPermissionMode(switches); // MUTATION: 点过的档名盖过实际开关",
    testFiles: ["test/permission-mode.test.ts"],
    why: "装配条 mode 必须跟实际开关；标签盖过去会把追问改编排仍画成 auto",
  },
  {
    id: "model-send-error-marked-ok",
    file: "src/loop.ts",
    find: 'q.push({ type: "model_call_end", turn, attempt, status: "error", durationMs: Date.now() - startedAt });',
    replace:
      'q.push({ type: "model_call_end", turn, attempt, status: "ok", durationMs: Date.now() - startedAt }); // MUTATION: 失败 send 画成成功',
    testFiles: ["test/loop.test.ts"],
    why: "抛错必须先发 model_call_end(error)；标成 ok 会让失败 send 的 span 撒谎",
  },
  {
    id: "histogram-quantile-zero-on-empty",
    file: "src/metrics.ts",
    find: "  if (!Number.isFinite(total) || total <= 0) return null;",
    replace: "  if (!Number.isFinite(total) || total <= 0) return 0; // MUTATION: 没有读数编成零",
    testFiles: ["test/metrics.test.ts"],
    why: "分位数没有样本必须是 null；编 0 会把空曲线画成瞬时完成",
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

const only = new Set(
  (process.env.MUTATION_ONLY ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const selected = only.size > 0 ? MUTANTS.filter((m) => only.has(m.id)) : MUTANTS;
if (only.size > 0) {
  const missing = [...only].filter((id) => !MUTANTS.some((m) => m.id === id));
  if (missing.length) {
    console.error(`MUTATION_ONLY unknown id(s): ${missing.join(", ")}`);
    process.exit(1);
  }
}

console.log(`mutation-smoke: ${selected.length}/${MUTANTS.length} mutants @ ${root}\n`);

for (const m of selected) {
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
console.log(`\nkilled ${killed}/${selected.length}; failures=${failed}`);

if (failed > 0) {
  process.exit(1);
}

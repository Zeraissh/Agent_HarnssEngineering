/**
 * 运行台账（L6）的回归锁。
 *
 * 这个模块的存在理由本身就是一条教训：backlog 上两条"等证据"（§2.1 裁决获得
 * 路径的分布、9.9 verifier 用 write_memory）**永远等不到**，因为证据在产生的
 * 同时就被删掉了——`recovery` 只活在内存里，进程一重启样本归零。
 *
 * 所以这里锁两件事：
 *   ① 台账**永不影响被测对象**（写失败要静默，不能把运行搞挂）；
 *   ② 判据是**先写死的代码**，不是事后的一句话——`decideStructuredOutput`
 *      谁跑都得出同一个结论，没有解释空间。
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRunLedger,
  buildLedgerEntry,
  decideStructuredOutput,
  decideStructuredOutputEffect,
  emptyCompactionTally,
  emptyRecoveryTally,
  isExecutorSource,
  LEDGER_NO_PACK,
  LEDGER_UNCLASSIFIED_ERROR,
  ledgerErrorClass,
  ledgerPath,
  summarizeLedger,
  summarizeTermination,
  STRUCTURED_OUTPUT_BASELINE,
  STRUCTURED_OUTPUT_EFFECT_RULE,
  STRUCTURED_OUTPUT_RULE,
  tallyCompaction,
  tallyRecoveryDecision,
  tallyToolCall,
  type RunLedgerEntry,
} from "../src/ledger.js";
import { parseEnvFile, findEnvConflicts, warnEnvConflicts } from "../src/env-check.js";
import { plannedStopReason } from "../src/orchestrate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const base = {
  at: 1_700_000_000_000,
  runId: "r1",
  host: "cli" as const,
};

function entry(over: Partial<RunLedgerEntry> = {}): RunLedgerEntry {
  return { ...buildLedgerEntry(base), ...over };
}

describe("buildLedgerEntry：只记元数据，且对脏输入不炸", () => {
  it("任务只留字符数，不留内容——台账要能随手给别人看", () => {
    const e = buildLedgerEntry({ ...base, task: "把 CRC 自检固件烧进去并验收" });
    expect(e.taskChars).toBe(16);
    expect(JSON.stringify(e)).not.toContain("CRC");
  });

  it("rubric 只记有没有；空白串算没有", () => {
    expect(buildLedgerEntry({ ...base, rubric: "维度一：…" }).rubric).toBe(true);
    expect(buildLedgerEntry({ ...base, rubric: "   " }).rubric).toBe(false);
    expect(buildLedgerEntry({ ...base }).rubric).toBe(false);
  });

  it("裁决只记三值的**条数**，不记条目内容", () => {
    const e = buildLedgerEntry({
      ...base,
      verifications: [
        {
          round: 0,
          recovery: "reformat",
          verdict: { passed: false, issues: ["行数不符"], unverified: [], advisory: ["建议重构", "命名"] },
        },
      ],
    });
    expect(e.verifications).toEqual([
      { round: 0, recovery: "reformat", passed: false, issues: 1, unverified: 0, advisory: 2 },
    ]);
    expect(JSON.stringify(e)).not.toContain("行数不符");
  });

  it("未知的 recovery 值落成 null 而不是原样带进来", () => {
    const e = buildLedgerEntry({ ...base, verifications: [{ recovery: "who-knows" }] });
    expect(e.verifications[0]!.recovery).toBeNull();
  });

  it("错误只留首行且截断——够定位形态，不至于把整段日志抄进来", () => {
    const e = buildLedgerEntry({ ...base, error: `${"x".repeat(500)}\n第二行` });
    expect(e.error!.length).toBe(200);
    expect(e.error).not.toContain("第二行");
  });

  it("stopReason=error 却漏传 error → 哨兵 unclassified_error（不许再落 null）", () => {
    const e = buildLedgerEntry({ ...base, stopReason: "error" });
    expect(e.error).toBe(LEDGER_UNCLASSIFIED_ERROR);
  });

  it("ledgerErrorClass 走 classifyApiError：401 归认证类，字符串原样首行", () => {
    const auth = Object.assign(new Error("bad key"), { status: 401 });
    // classifyApiError 对非 Anthropic SDK 401 走 message 分支
    expect(ledgerErrorClass(auth)).toBe("bad key");
    expect(ledgerErrorClass("限流：SDK 重试已耗尽\n细节")).toBe("限流：SDK 重试已耗尽");
  });

  it("字段缺失一律给确定的默认值（台账的每一行形状必须一致）", () => {
    const e = buildLedgerEntry(base);
    expect(e).toMatchObject({
      mode: "single", verify: false, rubric: false, verifications: [], tools: {}, verifierHitBudget: false,
    });
  });

  /**
   * MODEL-01a。`null`（这台机器没有降级这条防线）与 `["主端点"]`（配了链但只有
   * 一环）必须分开：压成同一个读数之后，事后就答不出"零次降级"是防线没触发
   * 还是防线根本不存在——而那正是这一列唯一要回答的问题。
   */
  it("降级链：未配是 null，配了才是数组；次数缺省 0 而不是 null", () => {
    const off = buildLedgerEntry(base);
    expect(off.fallbackChain).toBeNull();
    expect(off.fallbacks).toBe(0);

    const on = buildLedgerEntry({ ...base, fallbackChain: ["primary", "backup"], fallbacks: 2 });
    expect(on.fallbackChain).toEqual(["primary", "backup"]);
    expect(on.fallbacks).toBe(2);
    // 空数组按"没配"处理：一条零环的链在读数上与没有这条防线等价
    expect(buildLedgerEntry({ ...base, fallbackChain: [] }).fallbackChain).toBeNull();
    // 脏输入不炸也不留 NaN——台账每一行的形状必须一致
    expect(buildLedgerEntry({ ...base, fallbacks: Number.NaN }).fallbacks).toBe(0);
    expect(buildLedgerEntry({ ...base, fallbacks: -3 }).fallbacks).toBe(0);
  });
});

describe("plannedStopReason：编排收尾写进台账的终止原因", () => {
  it("完成 → completed，未完成 → error——只取具名值，不做兜底串化", () => {
    expect(plannedStopReason({ completed: true })).toBe("completed");
    expect(plannedStopReason({ completed: false })).toBe("error");
  });

  /**
   * 回归钉：CLI 曾在编排失败分支写 String(planOutcome)，把整个对象串成
   * "[object Object]" 进了台账——stopReason 一列从此对 plan 模式失真。
   */
  it("台账 stopReason 不得是 '[object Object]'", () => {
    const e = buildLedgerEntry({
      ...base,
      mode: "plan",
      stopReason: plannedStopReason({ completed: false }),
    });
    expect(e.stopReason).toBe("error");
    expect(e.stopReason).not.toBe("[object Object]");
  });
});

describe("tallyToolCall：按角色分的工具直方图", () => {
  it("累加到对应角色的桶里", () => {
    const t = {};
    tallyToolCall(t, "main", "bash");
    tallyToolCall(t, "main", "bash");
    tallyToolCall(t, "verifier", "read_file");
    expect(t).toEqual({ main: { bash: 2 }, verifier: { read_file: 1 } });
  });
});

/**
 * 领域包该声明几轮续跑（`DomainPack.recovery`），只能从台账里读——而此前台账只记
 * stopReason=max_turns，分不清"续跑过 8 轮仍撞上限"与"根本没触发续跑"。
 * 这组锁：① 新字段的写入形状；② 老行（没有这些字段）仍可读且按"未知"标注，不冒充零次；
 * ③ max_turns 比值按段归一（turns 是各段之和，返工一次分母就翻倍）。
 */
describe("恢复决策计数与 max_turns 分母（终止原因 × 包）", () => {
  it("tallyRecoveryDecision 只数执行者谱系：main / rework / s1/main 计，verifier / planner 不计", () => {
    const t = emptyRecoveryTally();
    const ext = { type: "recovery_decision", reason: "max_turns", action: "continue_with_context" };
    const stag = { type: "recovery_decision", reason: "stagnation", action: "change_strategy" };
    const forced = { type: "recovery_decision", reason: "stagnation", action: "force_completion" };
    tallyRecoveryDecision(t, "main", ext);
    tallyRecoveryDecision(t, "s2/rework", stag);
    tallyRecoveryDecision(t, "rework", forced);
    tallyRecoveryDecision(t, "verifier", ext); // 不计
    tallyRecoveryDecision(t, "s1/verifier", stag); // 不计
    tallyRecoveryDecision(t, "planner", forced); // 不计
    tallyRecoveryDecision(t, "main", { type: "tool_call" }); // 不是恢复决策
    // force_completion 且 reason=stagnation 同时计入停滞与强制两格——两个问题两个读数
    expect(t).toEqual({ extensions: 1, stagnations: 2, forced: 1 });
    expect(isExecutorSource("s3/main")).toBe(true);
    expect(isExecutorSource("clarifier")).toBe(false);
  });

  it("buildLedgerEntry：maxTurns 非正数落 null；策略快照 null=完成门关；recovery 新行恒有对象", () => {
    const e = buildLedgerEntry({
      ...base,
      maxTurns: 70,
      recoveryPolicy: { progressExtensionTurns: 8, stagnationWindow: 3, maxStagnationRecoveries: 1 },
      recovery: { extensions: 1, stagnations: 0, forced: 2 },
    });
    expect(e.maxTurns).toBe(70);
    expect(e.recoveryPolicy).toEqual({ progressExtensionTurns: 8, stagnationWindow: 3, maxStagnationRecoveries: 1 });
    expect(e.recovery).toEqual({ extensions: 1, stagnations: 0, forced: 2 });

    const bare = buildLedgerEntry(base);
    expect(bare.maxTurns).toBeNull();
    expect(bare.recoveryPolicy).toBeNull();
    // 新行没数到就是 0 次——与老行的 undefined（未知）必须分开
    expect(bare.recovery).toEqual({ extensions: 0, stagnations: 0, forced: 0 });
    expect(buildLedgerEntry({ ...base, maxTurns: 0 }).maxTurns).toBeNull();
    expect(buildLedgerEntry({ ...base, maxTurns: Number.NaN }).maxTurns).toBeNull();
    expect(buildLedgerEntry({ ...base, recovery: { extensions: -1 } }).recovery!.extensions).toBe(0);
  });

  it("summarizeTermination：终止原因 × 包 表 + max_turns 比值按段归一 + 老行按推算/未知标注", () => {
    const fresh = buildLedgerEntry({
      ...base, pack: "kicad", stopReason: "max_turns", turns: 140, reworks: 1, maxTurns: 70,
      recoveryPolicy: { progressExtensionTurns: 8, stagnationWindow: 3, maxStagnationRecoveries: 1 },
      recovery: { extensions: 2, stagnations: 0, forced: 1 },
    });
    // 老行：没有 maxTurns / recovery / recoveryPolicy 三个字段（2026-08 的真实形状）
    const legacy = JSON.parse(JSON.stringify(buildLedgerEntry({
      ...base, pack: "kicad", stopReason: "max_turns", turns: 70, reworks: 0,
    }))) as RunLedgerEntry;
    delete (legacy as Partial<RunLedgerEntry>).maxTurns;
    delete (legacy as Partial<RunLedgerEntry>).recovery;
    delete (legacy as Partial<RunLedgerEntry>).recoveryPolicy;
    const legacyNoTurns = { ...legacy, pack: null, turns: null } as RunLedgerEntry;
    const plan = buildLedgerEntry({ ...base, pack: "kicad", mode: "plan", stopReason: "max_turns", turns: 90, maxTurns: 70 });
    const ok = buildLedgerEntry({ ...base, pack: null, stopReason: "completed", turns: 5 });
    const err = buildLedgerEntry({ ...base, pack: "ts-coding", stopReason: "error", error: "x" });

    const t = summarizeTermination([fresh, legacy, legacyNoTurns, plan, ok, err], (pack) =>
      pack === "kicad" ? 70 : pack === null ? 50 : undefined,
    );

    // 表：按总次数降序；pack=null 显示为 LEDGER_NO_PACK；列按总次数降序
    expect(t.stopReasons).toEqual(["max_turns", "completed", "error"]);
    expect(t.byPack).toEqual([
      { pack: "kicad", total: 3, counts: { max_turns: 3 } },
      { pack: LEDGER_NO_PACK, total: 2, counts: { max_turns: 1, completed: 1 } },
      { pack: "ts-coding", total: 1, counts: { error: 1 } },
    ]);

    expect(t.maxTurnsRuns).toHaveLength(4);
    const [f, l, ln, p] = t.maxTurnsRuns;
    // 新行：分母来自台账；140 轮 / (70 × 2 段) = 100%
    expect(f).toMatchObject({ maxTurns: 70, maxTurnsSource: "ledger", segments: 2, ratio: 1 });
    expect(f!.recovery).toEqual({ extensions: 2, stagnations: 0, forced: 1 });
    // 老行：分母按当前 presets 推算并标 inferred；恢复计数 undefined（未知，不是零）
    expect(l).toMatchObject({ maxTurns: 70, maxTurnsSource: "inferred", segments: 1, ratio: 1 });
    expect(l!.recovery).toBeUndefined();
    expect(l!.recoveryPolicy).toBeUndefined();
    // 老行缺 turns：分母仍能推算，比值算不出 → null
    expect(ln).toMatchObject({ pack: LEDGER_NO_PACK, maxTurns: 50, maxTurnsSource: "inferred", ratio: null });
    // plan 模式：turns 是各子任务之和，对不上单个护栏，不算比值
    expect(p).toMatchObject({ mode: "plan", maxTurns: null, maxTurnsSource: null, ratio: null });

    // 恢复机制落地后的行单独一套账：只有带 recovery 字段的行计入
    expect(t.postRecovery).toEqual({ runs: 4, maxTurns: 2, extensions: 2, stagnations: 0, forced: 1 });
  });

  it("变异锁：比值若不按段归一（漏乘 1+返工），返工一次的 100% 会被画成 200%", () => {
    const e = buildLedgerEntry({ ...base, pack: "kicad", stopReason: "max_turns", turns: 140, reworks: 1, maxTurns: 70 });
    expect(summarizeTermination([e]).maxTurnsRuns[0]!.ratio).toBe(1);
  });

  it("真实台账的老行形状（2026-08）：JSONL 解析后可读，不因缺字段抛错", () => {
    const line =
      '{"at":1786181440373,"runId":"c7f","host":"web","taskChars":62,"pack":null,"model":null,"effort":null,' +
      '"mode":"single","verify":false,"rubric":false,"stopReason":"max_turns","error":null,"turns":null,' +
      '"reworks":null,"finalPassed":null,"verifications":[],"verifierBudgetTurns":null,"verifierHitBudget":false,' +
      '"tools":{},"durationMs":1053}';
    const t = summarizeTermination([JSON.parse(line) as RunLedgerEntry], () => 50);
    expect(t.byPack).toEqual([{ pack: LEDGER_NO_PACK, total: 1, counts: { max_turns: 1 } }]);
    expect(t.maxTurnsRuns[0]).toMatchObject({ maxTurns: 50, maxTurnsSource: "inferred", ratio: null });
    expect(t.postRecovery.runs).toBe(0);
  });
});

/**
 * 上下文压缩计数（MEM-01）。2026-09-03 真机：反应式压缩救回 987k 超长请求（dropped 72 / collapsed 10），
 * 模型随后补读 72 次文件（8 轮）才找回被置换的事实——这笔代价在台账里完全不可见，`npm run ledger`
 * 报不出"这次运行压过几次"。这组锁：① 事件计数（常规 / 反应式分开，块与轮累加）；② 写入形状
 * （新行恒有对象，老行 undefined = 未知不是零）；③ 读数器只算带字段的行；④ 两个宿主写入口都接了。
 */
describe("上下文压缩计数（compaction）", () => {
  it("tallyCompaction：reactive 与常规分开数，droppedBlocks / collapsedTurns 累加，非 compaction 事件忽略", () => {
    const t = emptyCompactionTally();
    tallyCompaction(t, { type: "compaction", droppedBlocks: 3 });
    tallyCompaction(t, { type: "compaction", droppedBlocks: 0, collapsedTurns: 4 });
    tallyCompaction(t, { type: "compaction", droppedBlocks: 72, collapsedTurns: 10, reactive: true });
    tallyCompaction(t, { type: "tool_call" }); // 不是压缩
    tallyCompaction(t, { type: "compaction", droppedBlocks: -1, collapsedTurns: Number.NaN }); // 脏值按 0
    expect(t).toEqual({ proactive: 3, reactive: 1, droppedBlocks: 75, collapsedTurns: 14 });
  });

  it("buildLedgerEntry：新行恒有 compaction 对象（没压过就是 0）；脏值归 0；老行 JSON 缺字段仍可读", () => {
    const e = buildLedgerEntry({ ...base, compaction: { proactive: 1, reactive: 1, droppedBlocks: 72, collapsedTurns: 10 } });
    expect(e.compaction).toEqual({ proactive: 1, reactive: 1, droppedBlocks: 72, collapsedTurns: 10 });
    expect(buildLedgerEntry(base).compaction).toEqual({ proactive: 0, reactive: 0, droppedBlocks: 0, collapsedTurns: 0 });
    expect(buildLedgerEntry({ ...base, compaction: { reactive: -2 } }).compaction!.reactive).toBe(0);

    // 2026-09-03 真机那一行的形状（本提交之前写下：有 recovery、没有 compaction）
    const line =
      '{"at":1788436346029,"runId":"cli-1788435994738","host":"cli","taskChars":284,"pack":null,"model":"deepseek-v4-flash",' +
      '"effort":null,"mode":"single","verify":false,"rubric":false,"stopReason":"completed","error":null,"turns":28,"reworks":null,' +
      '"finalPassed":null,"verifications":[],"verifierBudgetTurns":null,"verifierHitBudget":false,"fallbackChain":null,"fallbacks":0,' +
      '"tools":{"main":{"read_file":198,"bash":3,"write_file":1,"finish_task":1}},"durationMs":351291,"maxTurns":50,' +
      '"recoveryPolicy":{"progressExtensionTurns":8,"stagnationWindow":3,"maxStagnationRecoveries":1},' +
      '"recovery":{"extensions":0,"stagnations":0,"forced":0},"structuredDelivery":true}';
    const legacy = JSON.parse(line) as RunLedgerEntry;
    expect(legacy.compaction).toBeUndefined();
    const s = summarizeLedger([legacy]);
    expect(s.runs).toBe(1);
    // 老行是未知不是零：不进分母
    expect(s.compaction).toEqual({
      rows: 0, runsWithAny: 0, runsWithReactive: 0, proactive: 0, reactive: 0, droppedBlocks: 0, collapsedTurns: 0,
    });
  });

  it("summarizeLedger.compaction：只算带字段的行；发生过压缩 / 反应式的运行数与总量分开", () => {
    const rows = [
      buildLedgerEntry({ ...base, compaction: { proactive: 2, reactive: 0, droppedBlocks: 5, collapsedTurns: 3 } }),
      buildLedgerEntry({ ...base, compaction: { proactive: 0, reactive: 1, droppedBlocks: 72, collapsedTurns: 10 } }),
      buildLedgerEntry({ ...base, compaction: { proactive: 1, reactive: 1, droppedBlocks: 4, collapsedTurns: 0 } }),
      buildLedgerEntry(base), // 新行、没压过
    ];
    const legacy = JSON.parse(JSON.stringify(buildLedgerEntry(base))) as RunLedgerEntry;
    delete (legacy as Partial<RunLedgerEntry>).compaction;
    const s = summarizeLedger([...rows, legacy]);
    expect(s.runs).toBe(5);
    expect(s.compaction).toEqual({
      rows: 4,
      runsWithAny: 3,
      runsWithReactive: 2,
      proactive: 3,
      reactive: 2,
      droppedBlocks: 81,
      collapsedTurns: 13,
    });
  });

  it("两个宿主的写入口都接了计数，读数器把它印出来（源码锁：漏接一处这里就红）", () => {
    const web = readFileSync(join(__dirname, "..", "ui", "server.ts"), "utf-8");
    const cli = readFileSync(join(__dirname, "..", "src", "cli.ts"), "utf-8");
    const report = readFileSync(join(__dirname, "..", "eval", "ledger-report.ts"), "utf-8");
    // Web：事件旁路累加 + 台账行带字段
    expect(web).toMatch(/if \(event\.type === "compaction"\) \{\s*\n\s*tallyCompaction\(\(run\.compactionTally \?\?= emptyCompactionTally\(\)\), event\);/);
    expect(web).toMatch(/compaction:\s*run\.compactionTally \?\? emptyCompactionTally\(\)/);
    // CLI：三条执行路径共用的 noteForLedger 里累加 + 台账行带字段
    expect(cli).toMatch(/tallyCompaction\(ledgerCompaction, event\);/);
    expect(cli).toMatch(/compaction:\s*ledgerCompaction,/);
    // 读数器一行摘要：发生过压缩的运行数 / 反应式次数
    expect(report).toMatch(/s\.compaction/);
    expect(report).toMatch(/runsWithAny[\s\S]{0,200}runsWithReactive|runsWithReactive[\s\S]{0,200}runsWithAny/);
  });
});

/**
 * MEM-01 窗口 / 预算分离：台账行记窗口与预算各带来源。150k 预算在 1M 窗口上压了三个月
 * 没人发现，正是因为没有一处把这两个数并排放着——这里锁的是"两个数 + 两个来源都在行里"。
 */
describe("上下文窗口 / 预算（context）", () => {
  it("buildLedgerEntry：四字段照录；宿主漏传 = unknown / null，不许画成某个数；非法来源归 unknown / null", () => {
    const e = buildLedgerEntry({
      ...base,
      context: { window: 1_048_576, windowSource: "learned", budget: 150_000, budgetSource: "default" },
    });
    expect(e.context).toEqual({ window: 1_048_576, windowSource: "learned", budget: 150_000, budgetSource: "default" });
    expect(buildLedgerEntry(base).context).toEqual({ window: null, windowSource: "unknown", budget: null, budgetSource: null });
    expect(
      buildLedgerEntry({ ...base, context: { window: -5, windowSource: "guess", budget: 0, budgetSource: "magic" } }).context,
    ).toEqual({ window: null, windowSource: "unknown", budget: null, budgetSource: null });
  });

  it("老行（无 context 字段）仍可读，且不进分母——未知不是零", () => {
    const legacy = JSON.parse(JSON.stringify(buildLedgerEntry(base))) as RunLedgerEntry;
    delete (legacy as Partial<RunLedgerEntry>).context;
    const s = summarizeLedger([legacy]);
    expect(s.runs).toBe(1);
    expect(s.context.rows).toBe(0);
    expect(s.context.meanBudgetToWindow).toBeNull();
  });

  it("summarizeLedger.context：窗口来源 / 预算来源直方图、预算分桶、窗口已知行的预算 / 窗口均值", () => {
    const rows = [
      buildLedgerEntry({ ...base, context: { window: 1_048_576, windowSource: "registry", budget: 150_000, budgetSource: "default" } }),
      buildLedgerEntry({ ...base, context: { window: 1_048_576, windowSource: "learned", budget: 524_288, budgetSource: "run" } }),
      buildLedgerEntry({ ...base, context: { window: null, windowSource: "unknown", budget: 150_000, budgetSource: "default" } }),
      buildLedgerEntry({ ...base, context: { window: 128_000, windowSource: "env", budget: 59_904, budgetSource: "env" } }),
    ];
    const s = summarizeLedger(rows);
    expect(s.context.rows).toBe(4);
    expect(s.context.windowSources).toEqual({ env: 1, learned: 1, registry: 1, unknown: 1 });
    expect(s.context.budgetSources).toEqual({ run: 1, env: 1, pack: 0, default: 2, unknown: 0 });
    expect(s.context.budgets).toEqual({ "150000": 2, "524288": 1, "59904": 1 });
    // 三行窗口已知：150000/1048576 + 524288/1048576 + 59904/128000，均值 ≈ 0.370
    expect(s.context.meanBudgetToWindow).toBeCloseTo((150_000 / 1_048_576 + 524_288 / 1_048_576 + 59_904 / 128_000) / 3, 6);
  });

  it("CLI 写入口带 context，读数器把分布印出来（源码锁：漏接一处这里就红）", () => {
    const cli = readFileSync(join(__dirname, "..", "src", "cli.ts"), "utf-8");
    const report = readFileSync(join(__dirname, "..", "eval", "ledger-report.ts"), "utf-8");
    expect(cli).toMatch(/context:\s*\{\s*\n\s*window:\s*contextPlan\.window,\s*\n\s*windowSource:\s*contextPlan\.windowSource,\s*\n\s*budget:\s*contextPlan\.budget,\s*\n\s*budgetSource:\s*contextPlan\.budgetSource,/);
    expect(report).toMatch(/s\.context/);
    expect(report).toMatch(/windowSources[\s\S]{0,300}budgetSources/);
  });
});

describe("appendRunLedger：仪器坏了不能影响被测对象", () => {
  it("正常路径写成一行 JSONL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ledger-"));
    const file = join(dir, "runs.jsonl");
    expect(await appendRunLedger(entry(), file)).toBe(true);
    expect(await appendRunLedger(entry({ runId: "r2" }), file)).toBe(true);
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).runId).toBe("r2");
  });

  /**
   * 这条是本模块最重要的一条：台账是研究仪器，不是业务数据。
   * 仪器坏了就当这次没记，**绝不能反过来把运行搞挂**。
   */
  it("路径写不进去时返回 false 而不是抛异常", async () => {
    const bad = join(tmpdir(), "definitely-not-a-dir- ", "x.jsonl");
    await expect(appendRunLedger(entry(), bad)).resolves.toBe(false);
  });
});

describe("ledgerPath：默认落 cwd，可被环境变量覆盖", () => {
  it("默认 .agent-runs.jsonl", () => {
    expect(ledgerPath({}, "/proj")).toMatch(/[\\/]proj[\\/]\.agent-runs\.jsonl$/);
  });
  it("AGENT_RUN_LEDGER 相对路径按 cwd 解析", () => {
    expect(ledgerPath({ AGENT_RUN_LEDGER: "out/x.jsonl" }, "/proj")).toMatch(/out[\\/]x\.jsonl$/);
  });
  it("空白值当没设", () => {
    expect(ledgerPath({ AGENT_RUN_LEDGER: "  " }, "/proj")).toMatch(/\.agent-runs\.jsonl$/);
  });
});

describe("summarizeLedger：把一堆行折成能下判断的数", () => {
  const v = (recovery: string) => ({ recovery, verdict: { passed: true } });
  const rows = [
    buildLedgerEntry({ ...base, verify: true, verifications: [v("direct"), v("direct")] }),
    buildLedgerEntry({ ...base, verify: true, verifications: [v("reformat")], verifierHitBudget: true }),
    buildLedgerEntry({ ...base, verify: false, tools: { verifier: { write_memory: 5, read_file: 3 } } }),
  ];

  it("裁决按 recovery 分档计数", () => {
    const s = summarizeLedger(rows);
    expect(s.runs).toBe(3);
    expect(s.verifiedRuns).toBe(2);
    expect(s.verdicts).toBe(3);
    expect(s.recovery.direct).toBe(2);
    expect(s.recovery.reformat).toBe(1);
    expect(s.nonDirectRatio).toBeCloseTo(1 / 3);
    expect(s.hitBudget).toBe(1);
  });

  /** 9.9 的观察项：只读核查不该写东西，出现即入册，不再靠碰巧翻到日志 */
  it("verifier 侧的写类调用单独列出——9.9 靠这个自动检出", () => {
    const s = summarizeLedger(rows);
    expect(s.verifierWriteCalls).toEqual({ write_memory: 5 });
    expect(s.tools.verifier).toEqual({ write_memory: 5, read_file: 3 });
  });

  it("空台账不炸，比值为 0 而不是 NaN", () => {
    const s = summarizeLedger([]);
    expect(s.nonDirectRatio).toBe(0);
    expect(s.reformatWrapupRatio).toBe(0);
  });
});

/**
 * 判据锁。**这些阈值是在拿到任何数据之前写下的**——收完数据再定阈值，
 * 等于用数据反推一个想要的结论。下面每条都钉住一个具体分支，
 * 谁改了阈值都得连带改测试，改不动就说明是在事后合理化。
 */
describe("decideStructuredOutput：先写死的判据", () => {
  const withVerdicts = (recoveries: string[]) =>
    summarizeLedger([
      buildLedgerEntry({ ...base, verify: true, verifications: recoveries.map((r) => ({ recovery: r })) }),
    ]);

  it("fail-closed 出现一次就立刻做——那是误伤，不是概率问题（压过样本量门槛）", () => {
    const d = decideStructuredOutput(withVerdicts(["direct", "failed"]));
    expect(d.decision).toBe("do-now");
    expect(d.why).toContain("误伤");
  });

  it("样本不足时明确说不下结论，不含糊其辞", () => {
    const d = decideStructuredOutput(withVerdicts(Array(5).fill("direct")));
    expect(d.decision).toBe("insufficient");
    expect(d.why).toContain(String(STRUCTURED_OUTPUT_RULE.minSamples));
  });

  it("样本够且非 direct 占比低于阈值 → 关掉 §2.1", () => {
    const d = decideStructuredOutput(withVerdicts(Array(40).fill("direct")));
    expect(d.decision).toBe("close");
  });

  it("reformat+wrapup 超过阈值 → 做，且指明优先方向", () => {
    const rows = [...Array(20).fill("direct"), ...Array(10).fill("reformat")];
    const d = decideStructuredOutput(withVerdicts(rows));
    expect(d.decision).toBe("do");
    expect(d.why).toContain("reformat+wrapup");
  });

  it("落在两条阈值之间的灰带要说清是灰带，不许硬凑一个结论", () => {
    // 30 次里 3 次非 direct = 10%：高于 close 阈值 5%、低于 do 阈值 20%
    const rows = [...Array(27).fill("direct"), ...Array(3).fill("reformat")];
    const d = decideStructuredOutput(withVerdicts(rows));
    expect(d.decision).toBe("insufficient");
    expect(d.why).toContain("灰带");
  });
});

/**
 * 仪器污染锁。
 *
 * 台账刚上线时忘了这条：一跑测试套就往台账里灌了 **86 条假运行、22 次裁决
 * 全是 `direct`**——而假模型的裁决永远可解析，那个 100% 正好会把 §2.1 推向
 * "关掉"。**用假模型的数去判模型行为，是最坏的一种假证据。**
 */
describe("台账不许被假模型污染", () => {
  it("createUiServer 注入了 modelClient 时默认不记账", async () => {
    const src = readFileSync(join(__dirname, "..", "ui", "server.ts"), "utf-8");
    // 默认关闭的判据必须写在代码里，且以 options.modelClient 为准
    expect(src).toMatch(/options\.ledger === false[\s\S]{0,200}options\.modelClient\s*\n?\s*\?\s*null/);
    // 写入必须被这个开关罩住
    expect(src).toMatch(/if \(ledgerFile\) \{[\s\S]{0,80}appendRunLedger\(/);
  });
});

/**
 * 失败 taxonomy 前置锁：error 终止必须带错误类。
 * 2026-09-02 台账 12 次 error 全是 null——根因是 ui/server 硬编码 error:null。
 */
describe("error 终止必须带 error 类", () => {
  it("Web/CLI 台账写入不再硬编码 error:null，且走 ledgerErrorClass", () => {
    const web = readFileSync(join(__dirname, "..", "ui", "server.ts"), "utf-8");
    const cli = readFileSync(join(__dirname, "..", "src", "cli.ts"), "utf-8");
    // 硬编码 null 会让整份台账的失败分类永远算不出来
    expect(web).not.toMatch(/buildLedgerEntry\(\{[\s\S]{0,400}error:\s*null/);
    expect(web).toMatch(/ledgerErrorClass/);
    expect(cli).toMatch(/ledgerErrorClass/);
    expect(cli).toMatch(/error:\s*ledgerFacts\?\.error/);
  });

  it("变异：把哨兵改回 null 必须让本文件变红", () => {
    // 行为锁：stopReason=error + 无 error 输入 → 哨兵，不是 null
    const e = buildLedgerEntry({
      at: 1,
      runId: "r",
      host: "cli",
      task: "x",
      stopReason: "error",
    });
    expect(e.error).not.toBeNull();
    expect(e.error).toBe(LEDGER_UNCLASSIFIED_ERROR);
  });
});

/**
 * `.env` 与进程环境冲突的告警。
 *
 * 真实事故（2026-08-08 本机）：`.env` 里写着 deepseek 的兼容端点，
 * 而终端里残留着 `ANTHROPIC_BASE_URL=https://api.anthropic.com`——
 * Node 的 `--env-file` 不覆盖已存在的变量，于是 **deepseek 的 key 会被发往
 * Anthropic 官方端点**。不是"配置没生效"这么轻，是凭据送错了厂商，
 * 而且全程零报错：只会看到一个 401，然后开始怀疑 key 打错了。
 */
describe("环境冲突告警", () => {
  it("解析 .env 的极简子集：忽略注释与空行，去掉成对引号", () => {
    const got = parseEnvFile(
      ["# 注释", "", "A=1", 'B="含空格 的值"', "C='单引号'", "D=", "没有等号"].join("\n"),
    );
    expect(got).toEqual({ A: "1", B: "含空格 的值", C: "单引号" });
  });

  it("取值相同不算冲突——那只是重复配置，没有歧义", () => {
    expect(findEnvConflicts({ X: "same" }, { X: "same" })).toEqual([]);
  });

  it("取值不同才算冲突，并标出哪些是敏感项", () => {
    const c = findEnvConflicts(
      { ANTHROPIC_BASE_URL: "https://deepseek", ANTHROPIC_API_KEY: "sk-a" },
      { ANTHROPIC_BASE_URL: "https://anthropic", ANTHROPIC_API_KEY: "sk-b" },
    );
    expect(c.map((x) => x.key).sort()).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
    expect(c.find((x) => x.key === "ANTHROPIC_API_KEY")!.secret).toBe(true);
    expect(c.find((x) => x.key === "ANTHROPIC_BASE_URL")!.secret).toBe(false);
  });

  it("环境里没有这一项时不算冲突（.env 正常生效）", () => {
    expect(findEnvConflicts({ X: "v" }, {})).toEqual([]);
  });

  /** 冲突项里可能有 key——**任何情况下都不许把值打印出来** */
  it("告警文本绝不包含任何值", async () => {
    const dir = await mkdtemp(join(tmpdir(), "envchk-"));
    await writeFile(
      join(dir, ".env"),
      "ANTHROPIC_API_KEY=sk-super-secret\nANTHROPIC_BASE_URL=https://deepseek\n",
      "utf8",
    );
    const lines: string[] = [];
    const conflicts = warnEnvConflicts(
      dir,
      { ANTHROPIC_API_KEY: "sk-other-secret", ANTHROPIC_BASE_URL: "https://anthropic" },
      (m) => lines.push(m),
    );
    expect(conflicts).toHaveLength(2);
    const all = lines.join("\n");
    expect(all).toContain("ANTHROPIC_API_KEY");
    expect(all, "把密钥打进了告警").not.toContain("sk-super-secret");
    expect(all, "把密钥打进了告警").not.toContain("sk-other-secret");
    expect(all, "把端点值打进了告警").not.toContain("https://deepseek");
  });

  it("没有 .env 时静默——没有配置文件不是错误", async () => {
    const dir = await mkdtemp(join(tmpdir(), "envchk2-"));
    const lines: string[] = [];
    expect(warnEnvConflicts(dir, { X: "1" }, (m) => lines.push(m))).toEqual([]);
    expect(lines).toHaveLength(0);
  });
});

describe("§2.1 效果判据（判据打完一仗就退役，换新判据接手）", () => {
  const verdictRow = (
    recoveries: (string | null)[],
    structuredDelivery = true,
  ): RunLedgerEntry => ({
    ...buildLedgerEntry({
      ...base,
      verify: true,
      verifications: recoveries.map((r, i) => ({
        round: i,
        recovery: r,
        verdict: { passed: true, issues: [], unverified: [], advisory: [] },
      })),
    }),
    structuredDelivery,
  });

  const rows = (recoveries: string[], structured = true): RunLedgerEntry[] =>
    recoveries.map((r) => verdictRow([r], structured));

  it("旧规则语义已冻结：把基线那 52 次原样喂回去，仍得到同一个 do", () => {
    const B = STRUCTURED_OUTPUT_BASELINE;
    const s = summarizeLedger([
      ...rows(Array(B.direct).fill("direct")),
      ...rows(Array(B.wrapup).fill("wrapup")),
      ...rows(Array(B.reformat).fill("reformat")),
    ]);
    expect(s.verdicts).toBe(B.verdicts);
    expect(decideStructuredOutput(s).decision, "历史读数必须可原样复现").toBe("do");
  });

  /**
   * 这一条是仪器纪律，不是功能：效果判据只许读 §2.1 之后的行。
   * 混着算，tool 占比会被 52 条基线永久稀释，规则会一直报"端点不认"——
   * 那正是"用假证据做真判断"的同族（当年 FakeModelClient 灌进 86 条假运行）。
   */
  it("实施前的行不进效果读数——被旧数据污染的读数等于没有读数", () => {
    const s = summarizeLedger([
      ...rows(Array(52).fill("wrapup"), false), // 基线：没有 structuredDelivery
      ...rows(Array(25).fill("tool"), true), // 实施后：全部走了终结工具
    ]);
    expect(s.verdicts, "总账照旧全记").toBe(77);
    expect(s.structured.verdicts, "效果只看实施后的行").toBe(25);
    expect(s.structured.toolRatio).toBe(1);
    expect(decideStructuredOutputEffect(s).effect).toBe("effective");
  });

  it("样本不足时照实说，并点明台账里那些是基线不是效果", () => {
    const s = summarizeLedger(rows(Array(52).fill("wrapup"), false));
    const d = decideStructuredOutputEffect(s);
    expect(d.effect).toBe("insufficient");
    expect(d.why).toContain("基线");
  });

  it("端点不认强制工具 → endpoint-ignores（降级臂仍在兜底，不是故障）", () => {
    const s = summarizeLedger(rows(Array(30).fill("direct")));
    expect(decideStructuredOutputEffect(s).effect).toBe("endpoint-ignores");
  });

  it("认了工具但主要形态没降下来 → missed-target（打偏了，不是没打）", () => {
    const s = summarizeLedger([
      ...rows(Array(10).fill("tool")),
      ...rows(Array(20).fill("wrapup")),
    ]);
    const d = decideStructuredOutputEffect(s);
    expect(d.effect).toBe("missed-target");
    expect(d.why).toContain("tool_choice");
  });

  it("§2.1 之后仍出现 fail-closed → 一次都不该有，压过样本量门槛", () => {
    const s = summarizeLedger(rows(["failed"]));
    expect(decideStructuredOutputEffect(s).effect).toBe("missed-target");
  });

  it("新构建写下的行一律带 structuredDelivery（构建标记，不是配置项）", () => {
    expect(buildLedgerEntry({ ...base }).structuredDelivery).toBe(true);
  });

  it("效果阈值与基线挂钩：wrapup 门槛就是基线的一半，不是拍脑袋的常数", () => {
    expect(STRUCTURED_OUTPUT_EFFECT_RULE.wrapupMustDropBelow).toBeCloseTo(
      STRUCTURED_OUTPUT_BASELINE.wrapupRatio / 2,
    );
    expect(STRUCTURED_OUTPUT_BASELINE.wrapupRatio).toBeCloseTo(36 / 52);
  });
});

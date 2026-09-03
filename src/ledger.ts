/**
 * L6 — 运行台账：把每次运行的**元数据**追加成一行 JSONL。
 *
 * ================= 为什么要它 =================
 * backlog 上有两条一直挂着"等证据"：§2.1 结构化输出（等裁决获得路径的分布）、
 * 9.9 verifier 用 write_memory（等第二次出现）。查下来才发现，**它们不是运行
 * 次数不够，是证据在产生的同时就被删掉了**：
 *   · `recovery` 只活在事件流与 `ui/server.ts` 的内存 Map 里，进程一重启全没；
 *   · CLI 那条路径连运行记录都不写；
 *   · 9.9 那次是读 verifier 日志时**碰巧看见的**——没有任何"哪个角色调了哪个
 *     工具"的记录，要再看见一次得靠同样的运气。
 * 所以"等"是在等一个正被删除的数字。跑一百次和跑一次，可数的样本都是 0。
 *
 * 这正是项目自己那条 P6（不变量靠 harness，不靠自觉）没有用在**研究本身**上：
 * **一条要靠"下次注意看"才能获得的证据，等于没有证据。**
 *
 * ================= 边界（有意为之） =================
 * 只记**元数据**：不记任务原文、不记会话正文、不记工具入参。
 *   · 便宜——一行几百字节，追加即完；
 *   · 无隐私面——台账可以随手交给别人看；
 *   · 够用——要回答的问题是"裁决怎么拿到的""谁调了什么工具"，不是"它说了啥"。
 * 任务只留字符数（`taskChars`），用于把分布按任务规模切开而不存内容。
 *
 * **绝不能因为记账把运行搞挂**：写入是 fire-and-forget，全程吞异常。
 * 台账是研究仪器，不是业务数据——仪器坏了就当这次没记，不能反过来影响被测对象。
 */
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { classifyApiError } from "./model-client.js";

/** 裁决是怎么拿到的（与 verifier.ts 的 VerdictRecovery 同源） */
export type LedgerRecovery = "tool" | "direct" | "reformat" | "wrapup" | "failed";

/**
 * 台账用的错误类：经 classifyApiError 后取首行并截断。
 * stopReason=error 时宿主必须把这个字段写进台账——否则失败 taxonomy 算不出来
 * （2026-09-02 台账里 12 次 error 全是 null，正是 ui/server 硬编码造成的）。
 */
export function ledgerErrorClass(err: unknown): string {
  return classifyApiError(err).slice(0, 200).split("\n")[0]!;
}

/** error 终止却没带分类时的哨兵——buildLedgerEntry fail-closed，避免再写回 null */
export const LEDGER_UNCLASSIFIED_ERROR = "unclassified_error";

export interface LedgerVerification {
  round: number;
  recovery: LedgerRecovery | null;
  passed: boolean;
  /** 三值裁决各自的条数——只记数量，不记内容 */
  issues: number;
  unverified: number;
  advisory: number;
}

/** 按角色分的工具调用直方图：`{ main: { bash: 3 }, verifier: { read_file: 8 } }` */
export type ToolTally = Record<string, Record<string, number>>;

/**
 * 执行者谱系（main / rework，含编排下的 `s1/main`）的恢复决策计数。
 *
 * 为什么要它：领域包能声明恢复策略之后（`DomainPack.recovery`），"该给 kicad 几轮
 * 续跑"这个数只能从台账里读出来——而此前台账只记 stopReason=max_turns，分不清
 * "续跑过 8 轮仍撞上限" 与 "根本没触发续跑就停了"，也分不清停滞检测有没有开过火。
 * planner / verifier 的决策不计：它们各有独立预算，混进来就答不出"执行者的续跑够不够"。
 */
export interface LedgerRecoveryTally {
  /** action=continue_with_context 的次数（进展续跑真的发生了几次） */
  extensions: number;
  /** reason=stagnation 的决策次数（停滞检测开火几次，含换策略与强制收口） */
  stagnations: number;
  /** action=force_completion 的次数（被宿主强制结构化收口） */
  forced: number;
}

export function emptyRecoveryTally(): LedgerRecoveryTally {
  return { extensions: 0, stagnations: 0, forced: 0 };
}

/** 来源是不是执行者谱系：`main` / `rework` / `s1/main` / `s1/rework`；verifier / planner / clarifier 不是 */
export function isExecutorSource(source: string): boolean {
  const tail = source.split("/").at(-1) ?? source;
  return tail === "main" || tail === "rework";
}

/**
 * 累加一次恢复决策（原地改，两个宿主都在事件回调里逐条喂，与 tallyToolCall 同款）。
 * 非执行者来源、非 recovery_decision 事件一律忽略。
 */
export function tallyRecoveryDecision(
  tally: LedgerRecoveryTally,
  source: string,
  event: { type: string; reason?: string; action?: string },
): LedgerRecoveryTally {
  if (event.type !== "recovery_decision" || !isExecutorSource(source)) return tally;
  if (event.action === "continue_with_context") tally.extensions += 1;
  if (event.reason === "stagnation") tally.stagnations += 1;
  if (event.action === "force_completion") tally.forced += 1;
  return tally;
}

/**
 * 上下文压缩计数（MEM-01）。
 *
 * 为什么要它（2026-09-03 真机）：反应式压缩救回了一次 987k 的超长请求，但代价——模型为找回
 * 被置换掉的事实补读了 72 次文件（8 轮）——在台账里完全不可见，`compaction` 只活在事件流里。
 * 一条要靠"回放日志才看得见"的成本，等于没被计量。
 *
 * 与 `recovery` 不同，**不按角色过滤**：问的是"这次运行的上下文有没有被压、压掉多少"，
 * 哪个角色压的都算（verifier 的反应式压缩同样是这次运行付出的代价）。
 */
export interface LedgerCompactionTally {
  /** 水位触发的常规压缩次数（compaction 事件且 reactive 不为 true） */
  proactive: number;
  /** 端点 context-overflow 400 触发的硬压缩次数（reactive=true，随即重发同一轮） */
  reactive: number;
  /** tier 1 置换为占位符的 tool_result 块总数 */
  droppedBlocks: number;
  /** tier 2 折叠进 `[compacted_turns]` 的旧轮总数 */
  collapsedTurns: number;
}

export function emptyCompactionTally(): LedgerCompactionTally {
  return { proactive: 0, reactive: 0, droppedBlocks: 0, collapsedTurns: 0 };
}

/**
 * 累加一次压缩事件（原地改，两个宿主都在事件回调里逐条喂，与 tallyToolCall 同款）。
 * 非 compaction 事件一律忽略；缺省字段按 0 计。
 */
export function tallyCompaction(
  tally: LedgerCompactionTally,
  event: { type: string; droppedBlocks?: number; collapsedTurns?: number; reactive?: boolean },
): LedgerCompactionTally {
  if (event.type !== "compaction") return tally;
  if (event.reactive === true) tally.reactive += 1;
  else tally.proactive += 1;
  tally.droppedBlocks += nonNegativeInt(event.droppedBlocks);
  tally.collapsedTurns += nonNegativeInt(event.collapsedTurns);
  return tally;
}

/** 台账里记的恢复策略快照（完成门关着时为 null——那时 loop 到 maxTurns 即停） */
export interface LedgerRecoveryPolicy {
  progressExtensionTurns: number;
  stagnationWindow: number;
  maxStagnationRecoveries: number;
}

export interface RunLedgerEntry {
  /** 传入而不是内部取，纯函数才可测 */
  at: number;
  runId: string;
  host: "web" | "cli";
  taskChars: number;
  pack: string | null;
  model: string | null;
  effort: string | null;
  mode: "single" | "plan";
  verify: boolean;
  rubric: boolean;
  stopReason: string | null;
  /** 错误只留分类后的首行，截断——够定位形态，不至于把日志抄进来 */
  error: string | null;
  turns: number | null;
  reworks: number | null;
  finalPassed: boolean | null;
  verifications: LedgerVerification[];
  verifierBudgetTurns: number | null;
  /** 核查是否撞了轮次上限（撞了才有"预算不够"这个嫌疑） */
  verifierHitBudget: boolean;
  /**
   * 主执行者的端点降级链（MODEL-01a），未配置降级时为 **null**。
   * null 与 `[主端点]` 必须分开：前者是"这台机器上根本没有这条防线"，
   * 后者是"配了链但只有一环"——把两者压成同一个读数，事后就无从判断
   * "零次降级"是防线没触发还是防线不存在。
   */
  fallbackChain: string[] | null;
  /** 本次运行实际换端点的次数（含被熔断跳过导致的换）。未配置时恒 0 */
  fallbacks: number;
  tools: ToolTally;
  durationMs: number | null;
  /**
   * 执行者**单段**轮次护栏（包 guardrails.maxTurns，未声明则 DEFAULT_MAX_TURNS）。
   * `turns / maxTurns` 是"撞上限时到底用了多少"的分母——没有它，事后只能拿
   * 当前 presets 里的数去推算，而包护栏是会改的（kicad 40 → 70）。
   * **plan 模式为 null**：turns 是各子任务之和，对不上任何单个护栏。
   * 老行没有这个字段（undefined）= 未知，读数器按"推算"标注。
   */
  maxTurns?: number | null;
  /** 本 run 生效的恢复策略；null = 完成门关着（loop 到 maxTurns 即停，策略无效） */
  recoveryPolicy?: LedgerRecoveryPolicy | null;
  /** 执行者谱系的恢复决策计数。老行没有这个字段（undefined）= 早于恢复机制，读数器按"未知"标注 */
  recovery?: LedgerRecoveryTally;
  /** 上下文压缩计数（全部角色）。老行没有这个字段（undefined）= 早于计数落地（2026-09-03），不是零次 */
  compaction?: LedgerCompactionTally;
  /**
   * 仪器纪律：**这一行是不是由带终结工具（§2.1）的构建写下的**。
   *
   * 不是配置项，是**构建标记**——`buildLedgerEntry` 恒写 true。为什么必须有它：
   * 效果判据要问"§2.1 生效了吗"，而台账里躺着 52 条 §2.1 之前的裁决，
   * 混在一起算，tool 占比会被基线永久稀释，规则会一直报"端点不认"。
   * 老行没有这个字段 = 基线，新行有 = 可用于效果判定。
   *
   * 同族纪律：注入 modelClient 默认不记账（假模型的数不该进真账）。
   * **一条会被旧数据污染的读数，和没有读数一样。**
   */
  structuredDelivery: boolean;
}

export interface LedgerInput {
  at: number;
  runId: string;
  host: "web" | "cli";
  task?: string;
  pack?: string | null;
  model?: string | null;
  effort?: string | null;
  mode?: "single" | "plan";
  verify?: boolean;
  rubric?: string | null;
  stopReason?: string | null;
  error?: string | null;
  turns?: number | null;
  reworks?: number | null;
  finalPassed?: boolean | null;
  verifications?: {
    round?: number;
    recovery?: string | null;
    verdict?: {
      passed?: boolean;
      issues?: unknown[];
      unverified?: unknown[];
      advisory?: unknown[];
    } | null;
  }[];
  verifierBudgetTurns?: number | null;
  verifierHitBudget?: boolean;
  fallbackChain?: string[] | null;
  fallbacks?: number | null;
  tools?: ToolTally;
  durationMs?: number | null;
  maxTurns?: number | null;
  recoveryPolicy?: LedgerRecoveryPolicy | null;
  recovery?: Partial<LedgerRecoveryTally> | null;
  compaction?: Partial<LedgerCompactionTally> | null;
}

const RECOVERIES: LedgerRecovery[] = ["tool", "direct", "reformat", "wrapup", "failed"];

function nonNegativeInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 纯函数：把两个宿主各自的收尾信息归一成一条台账。所有取值都做防御。 */
export function buildLedgerEntry(input: LedgerInput): RunLedgerEntry {
  return {
    at: input.at,
    runId: String(input.runId),
    host: input.host,
    taskChars: typeof input.task === "string" ? input.task.length : 0,
    pack: input.pack ?? null,
    model: input.model ?? null,
    effort: input.effort ?? null,
    mode: input.mode === "plan" ? "plan" : "single",
    verify: Boolean(input.verify),
    // rubric 只记"有没有"：内容可能很长，且它是不是空串才是判据
    rubric: Boolean(input.rubric && String(input.rubric).trim()),
    stopReason: input.stopReason ?? null,
    error: (() => {
      const line = input.error ? String(input.error).slice(0, 200).split("\n")[0]! : null;
      // error 终止必须带分类：宿主漏传时写哨兵，不许再落 null（taxonomy 前置）
      if (!line && input.stopReason === "error") return LEDGER_UNCLASSIFIED_ERROR;
      return line;
    })(),
    turns: input.turns ?? null,
    reworks: input.reworks ?? null,
    finalPassed: input.finalPassed ?? null,
    verifications: (input.verifications ?? []).map((v, i) => ({
      round: typeof v.round === "number" ? v.round : i,
      recovery: RECOVERIES.includes(v.recovery as LedgerRecovery)
        ? (v.recovery as LedgerRecovery)
        : null,
      passed: Boolean(v.verdict?.passed),
      issues: v.verdict?.issues?.length ?? 0,
      unverified: v.verdict?.unverified?.length ?? 0,
      advisory: v.verdict?.advisory?.length ?? 0,
    })),
    verifierBudgetTurns: input.verifierBudgetTurns ?? null,
    verifierHitBudget: Boolean(input.verifierHitBudget),
    fallbackChain:
      Array.isArray(input.fallbackChain) && input.fallbackChain.length > 0
        ? input.fallbackChain.map(String)
        : null,
    fallbacks: Number.isFinite(Number(input.fallbacks)) ? Math.max(0, Number(input.fallbacks)) : 0,
    tools: input.tools ?? {},
    durationMs: input.durationMs ?? null,
    // 分母要保真：非正数/非数字一律 null（"护栏为 0"是一个没设过的值被画成最严格的值）
    maxTurns:
      typeof input.maxTurns === "number" && Number.isFinite(input.maxTurns) && input.maxTurns > 0
        ? Math.floor(input.maxTurns)
        : null,
    recoveryPolicy: input.recoveryPolicy
      ? {
          progressExtensionTurns: nonNegativeInt(input.recoveryPolicy.progressExtensionTurns),
          stagnationWindow: nonNegativeInt(input.recoveryPolicy.stagnationWindow),
          maxStagnationRecoveries: nonNegativeInt(input.recoveryPolicy.maxStagnationRecoveries),
        }
      : null,
    // 新行恒有这个对象（宿主没数到就是 0 次）；老行的 undefined 才表示"未知"
    recovery: {
      extensions: nonNegativeInt(input.recovery?.extensions),
      stagnations: nonNegativeInt(input.recovery?.stagnations),
      forced: nonNegativeInt(input.recovery?.forced),
    },
    // 同款：新行恒有对象（没压过就是 0 次）；老行 undefined = 未知
    compaction: {
      proactive: nonNegativeInt(input.compaction?.proactive),
      reactive: nonNegativeInt(input.compaction?.reactive),
      droppedBlocks: nonNegativeInt(input.compaction?.droppedBlocks),
      collapsedTurns: nonNegativeInt(input.compaction?.collapsedTurns),
    },
    // 构建标记，不是配置：这个构建的 verifier/planner 一律带终结工具
    structuredDelivery: true,
  };
}

/** 累加一次工具调用（原地改，两个宿主都在事件回调里逐条喂） */
export function tallyToolCall(tally: ToolTally, source: string, name: string): ToolTally {
  const bucket = (tally[source] ??= {});
  bucket[name] = (bucket[name] ?? 0) + 1;
  return tally;
}

/** 台账路径。默认落在 cwd，可用 `AGENT_RUN_LEDGER` 覆盖（绝对或相对均可）。 */
export function ledgerPath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const override = env.AGENT_RUN_LEDGER;
  if (override && override.trim()) return path.resolve(cwd, override.trim());
  return path.join(cwd, ".agent-runs.jsonl");
}

/**
 * 追加一行。**永不抛**——记账失败就当这次没记。
 * @returns 是否真的写进去了（测试与诊断用）
 */
export async function appendRunLedger(
  entry: RunLedgerEntry,
  file: string = ledgerPath(),
): Promise<boolean> {
  try {
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

// ================================================================
// 判据：**先写死再收数据**
// ================================================================

/**
 * §2.1（结构化输出）做不做的判据。**已完成使命，有记录退役（2026-08-15）。**
 *
 * 阈值是在拿到任何数据之前写下的，这正是它算证据而不是事后合理化的分界线。
 * 它在 52 次裁决上开火并给出 `do`，§2.1 已按此实施——见下面的 BASELINE。
 *
 * 保留它不是留着继续判：**判据打完自己那一仗就该退役**，否则实施本身会把它
 * 的分母改掉（`tool` 一上线，"非 direct 占比"就永远高，规则会永远说"做"，
 * 一条永远说"做"的规则不是判据）。保留是为了**留住那一刻的读数**——
 * 退役后由 `STRUCTURED_OUTPUT_EFFECT_RULE` 接手回答下一个问题：它生效了吗。
 *
 * @deprecated 结论已出（do，已实施）。新问题用 STRUCTURED_OUTPUT_EFFECT_RULE。
 */
export const STRUCTURED_OUTPUT_RULE = {
  /** 少于这个样本量，不下任何结论——这条是防"三次里有一次"就拍板 */
  minSamples: 20,
  /** 非 direct 占比低于此 → 关掉 §2.1，理由写进 backlog */
  closeBelow: 0.05,
  /** reformat + wrapup 占比高于此 → 做，且知道该优化哪一段 */
  doAbove: 0.2,
} as const;

/**
 * §2.1 实施前的基线读数（2026-08-15，`.agent-runs.jsonl` 52 次裁决）。
 * 写死在代码里而不是写进文档：文档里的数字会过期没人管，这个会被测试钉着，
 * 而下面那条效果判据的全部意义就是**与它对比**。
 */
export const STRUCTURED_OUTPUT_BASELINE = {
  verdicts: 52,
  direct: 15,
  wrapup: 36,
  reformat: 1,
  failed: 0,
  /** 0.692——这才是 §2.1 真正要打的那一段（原案 response_format 只覆盖 reformat 的 1.9%） */
  wrapupRatio: 36 / 52,
} as const;

/**
 * §2.1 **生效了吗**的判据。同样先写阈值、后收数据（2026-08-15 写下，样本 0）。
 *
 * 问的不再是"该不该做"，而是三件事，按优先级：
 * ① 端点到底认不认强制工具（tool 占比）——不认就得走降级臂，那是另一套账；
 * ② 主要失效形态 wrapup 有没有真的下来（对比基线 69.2%）；
 * ③ fail-closed 仍然一次都不该有。
 */
export const STRUCTURED_OUTPUT_EFFECT_RULE = {
  minSamples: 20,
  /** tool 占比低于此 → 端点基本不认强制工具，把数字写进 backlog 并评估降级臂 */
  endpointIgnoresBelow: 0.05,
  /** wrapup 占比未降到基线的一半以下 → §2.1 没打中主要形态，回头看 */
  wrapupMustDropBelow: STRUCTURED_OUTPUT_BASELINE.wrapupRatio / 2,
  /** tool 占比高于此 → 生效，这条线可以收工 */
  effectiveAbove: 0.8,
} as const;

export interface LedgerSummary {
  runs: number;
  verifiedRuns: number;
  /** 裁决轮数（一次运行可能有多轮） */
  verdicts: number;
  recovery: Record<LedgerRecovery | "unknown", number>;
  nonDirectRatio: number;
  reformatWrapupRatio: number;
  /**
   * **只统计 §2.1 之后写下的行**（`structuredDelivery`）。老行是基线，
   * 混进来会把 tool 占比永久稀释成"端点不认"——被旧数据污染的读数等于没有读数。
   */
  structured: {
    verdicts: number;
    /** 走终结工具交付的占比 = 端点认不认强制工具 */
    toolRatio: number;
    /** 主要失效形态占比，与 STRUCTURED_OUTPUT_BASELINE.wrapupRatio 对比 */
    wrapupRatio: number;
    failClosed: number;
  };
  failClosed: number;
  hitBudget: number;
  /** 按角色汇总的工具调用直方图 */
  tools: ToolTally;
  /** 9.9 的观察项：verifier 侧的写类工具调用（它本该是只读的） */
  verifierWriteCalls: Record<string, number>;
  /**
   * 上下文压缩（MEM-01）。**只统计带 `compaction` 字段的行**——老行没有 = 未知，
   * 不冒充零次（口径同 recovery 的 postRecovery）。
   */
  compaction: {
    /** 有 compaction 字段的行数（分母） */
    rows: number;
    /** 发生过至少一次压缩的运行数 */
    runsWithAny: number;
    /** 发生过反应式压缩（撞 400 才压）的运行数 */
    runsWithReactive: number;
    proactive: number;
    reactive: number;
    droppedBlocks: number;
    collapsedTurns: number;
  };
}

/** verifier 侧出现这些就值得看一眼——只读核查不该写东西 */
const WRITE_TOOLS = new Set(["write_file", "write_memory", "memory_write", "write_memory_tool"]);

export function summarizeLedger(entries: RunLedgerEntry[]): LedgerSummary {
  const recovery: LedgerSummary["recovery"] = {
    tool: 0, direct: 0, reformat: 0, wrapup: 0, failed: 0, unknown: 0,
  };
  const tools: ToolTally = {};
  const verifierWriteCalls: Record<string, number> = {};
  let verifiedRuns = 0;
  let hitBudget = 0;

  // §2.1 之后的行单独一套计数——效果判据只读这一套
  const post = { verdicts: 0, tool: 0, wrapup: 0, failed: 0 };
  const compaction: LedgerSummary["compaction"] = {
    rows: 0, runsWithAny: 0, runsWithReactive: 0, proactive: 0, reactive: 0, droppedBlocks: 0, collapsedTurns: 0,
  };

  for (const e of entries) {
    if (e.verify) verifiedRuns++;
    if (e.verifierHitBudget) hitBudget++;
    if (e.compaction !== undefined) {
      const c = e.compaction;
      compaction.rows += 1;
      compaction.proactive += nonNegativeInt(c.proactive);
      compaction.reactive += nonNegativeInt(c.reactive);
      compaction.droppedBlocks += nonNegativeInt(c.droppedBlocks);
      compaction.collapsedTurns += nonNegativeInt(c.collapsedTurns);
      if (nonNegativeInt(c.proactive) + nonNegativeInt(c.reactive) > 0) compaction.runsWithAny += 1;
      if (nonNegativeInt(c.reactive) > 0) compaction.runsWithReactive += 1;
    }
    for (const v of e.verifications) {
      recovery[v.recovery ?? "unknown"]++;
      if (e.structuredDelivery) {
        post.verdicts++;
        if (v.recovery === "tool") post.tool++;
        else if (v.recovery === "wrapup") post.wrapup++;
        else if (v.recovery === "failed") post.failed++;
      }
    }
    for (const [source, counts] of Object.entries(e.tools ?? {})) {
      const bucket = (tools[source] ??= {});
      for (const [name, n] of Object.entries(counts)) {
        bucket[name] = (bucket[name] ?? 0) + n;
        if (source === "verifier" && WRITE_TOOLS.has(name)) {
          verifierWriteCalls[name] = (verifierWriteCalls[name] ?? 0) + n;
        }
      }
    }
  }

  const verdicts = RECOVERIES.reduce((n, k) => n + recovery[k], 0) + recovery.unknown;
  const nonDirect = verdicts - recovery.direct;
  return {
    runs: entries.length,
    verifiedRuns,
    verdicts,
    recovery,
    nonDirectRatio: verdicts === 0 ? 0 : nonDirect / verdicts,
    reformatWrapupRatio: verdicts === 0 ? 0 : (recovery.reformat + recovery.wrapup) / verdicts,
    structured: {
      verdicts: post.verdicts,
      toolRatio: post.verdicts === 0 ? 0 : post.tool / post.verdicts,
      wrapupRatio: post.verdicts === 0 ? 0 : post.wrapup / post.verdicts,
      failClosed: post.failed,
    },
    failClosed: recovery.failed,
    hitBudget,
    tools,
    verifierWriteCalls,
    compaction,
  };
}

export type StructuredOutputDecision = "insufficient" | "close" | "do" | "do-now";

export type StructuredOutputEffect =
  | "insufficient"
  | "endpoint-ignores"
  | "missed-target"
  | "effective"
  | "partial";

/**
 * 按 `STRUCTURED_OUTPUT_EFFECT_RULE` 判断 §2.1 **生效了吗**。
 * 阈值同样先写后收（2026-08-15 写下时 tool 样本为 0）。
 */
export function decideStructuredOutputEffect(s: LedgerSummary): {
  effect: StructuredOutputEffect;
  why: string;
} {
  const R = STRUCTURED_OUTPUT_EFFECT_RULE;
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const base = pct(STRUCTURED_OUTPUT_BASELINE.wrapupRatio);
  // 只看 §2.1 之后的行：老行是基线，混进来算 tool 占比永远上不去
  const p = s.structured;

  if (p.failClosed > 0) {
    return {
      effect: "missed-target",
      why: `出现 ${p.failClosed} 次 fail-closed 裁决。§2.1 之后这一格仍该恒为 0——先查是不是终结工具没进工具面。`,
    };
  }
  if (p.verdicts < R.minSamples) {
    return {
      effect: "insufficient",
      why: `§2.1 之后的裁决样本 ${p.verdicts} < ${R.minSamples}，不下结论（台账里另有 ${s.verdicts - p.verdicts} 次实施前的裁决，那是基线不是效果）。基线：direct ${STRUCTURED_OUTPUT_BASELINE.direct} / wrapup ${STRUCTURED_OUTPUT_BASELINE.wrapup}，共 ${STRUCTURED_OUTPUT_BASELINE.verdicts} 次。`,
    };
  }
  if (p.toolRatio < R.endpointIgnoresBelow) {
    return {
      effect: "endpoint-ignores",
      why: `走终结工具的只有 ${pct(p.toolRatio)}（${p.verdicts} 次裁决）——端点基本不认强制工具。把这个数字写进 backlog，并评估降级臂（文本契约仍在兜底）。`,
    };
  }
  if (p.wrapupRatio >= R.wrapupMustDropBelow) {
    return {
      effect: "missed-target",
      why: `wrapup 仍占 ${pct(p.wrapupRatio)}，未降到基线 ${base} 的一半以下（${p.verdicts} 次裁决）。§2.1 没打中主要形态——先看收口轮的请求里 tool_choice 到底带没带。`,
    };
  }
  if (p.toolRatio > R.effectiveAbove) {
    return {
      effect: "effective",
      why: `走终结工具 ${pct(p.toolRatio)}、wrapup 从基线 ${base} 降到 ${pct(p.wrapupRatio)}（${p.verdicts} 次裁决）。§2.1 生效，这条线可以收工。`,
    };
  }
  return {
    effect: "partial",
    why: `走终结工具 ${pct(p.toolRatio)}、wrapup ${pct(p.wrapupRatio)}（基线 ${base}，${p.verdicts} 次裁决）——主要形态确实降了，但交付路径尚未收敛到工具。继续攒，或查是哪一类跑仍走文本。`,
  };
}

/**
 * 按 `STRUCTURED_OUTPUT_RULE` 出结论。**语义已冻结**——它服务的问题已经结案，
 * 留着是为了能原样复现那一刻的读数（把 52 条历史喂进去仍得到同一个 do）。
 * 新数据请看 `decideStructuredOutputEffect`。
 */
export function decideStructuredOutput(s: LedgerSummary): {
  decision: StructuredOutputDecision;
  why: string;
} {
  // fail-closed 是**误伤**，一次都不该有——它压过样本量门槛
  if (s.failClosed > 0) {
    return {
      decision: "do-now",
      why: `出现 ${s.failClosed} 次 fail-closed 裁决（解析失败兜底）。那是误伤，不是概率问题——立刻做 §2.1。`,
    };
  }
  if (s.verdicts < STRUCTURED_OUTPUT_RULE.minSamples) {
    return {
      decision: "insufficient",
      why: `裁决样本 ${s.verdicts} < ${STRUCTURED_OUTPUT_RULE.minSamples}，不下结论。继续跑，台账会自己攒。`,
    };
  }
  if (s.nonDirectRatio < STRUCTURED_OUTPUT_RULE.closeBelow) {
    return {
      decision: "close",
      why: `非 direct 占比 ${(s.nonDirectRatio * 100).toFixed(1)}% < ${STRUCTURED_OUTPUT_RULE.closeBelow * 100}%（${s.verdicts} 次裁决）。剩余增量太小，关掉 §2.1 并把这个数字写进 backlog。`,
    };
  }
  if (s.reformatWrapupRatio > STRUCTURED_OUTPUT_RULE.doAbove) {
    return {
      decision: "do",
      why: `reformat+wrapup 占比 ${(s.reformatWrapupRatio * 100).toFixed(1)}% > ${STRUCTURED_OUTPUT_RULE.doAbove * 100}%（${s.verdicts} 次裁决）。做 §2.1，且优先针对占比大的那一段。`,
    };
  }
  return {
    decision: "insufficient",
    why: `非 direct ${(s.nonDirectRatio * 100).toFixed(1)}%、reformat+wrapup ${(s.reformatWrapupRatio * 100).toFixed(1)}%——落在两条阈值之间的灰带（${s.verdicts} 次裁决）。再攒一倍样本，或按当时的实际形态另行判断。`,
  };
}

// ================================================================
// 终止原因 × 包（领域包恢复策略该填几，只能从这里读出来）
// ================================================================

/** 台账里 pack=null 的行在表上的名字（ASCII，等宽终端里列对得齐） */
export const LEDGER_NO_PACK = "(none)";

export interface TerminationPackRow {
  pack: string;
  total: number;
  /** stopReason → 次数；stopReason=null 的行记在 "unknown" */
  counts: Record<string, number>;
}

export interface MaxTurnsRunRow {
  at: number;
  host: string;
  pack: string;
  mode: "single" | "plan";
  turns: number | null;
  reworks: number | null;
  /** 分母：台账记的单段护栏；老行没记就按当前包声明推算（标 inferred）；plan 模式无 */
  maxTurns: number | null;
  maxTurnsSource: "ledger" | "inferred" | null;
  /** 段数 = 1 + 返工轮数：max_turns 的 turns 是各段之和，比值要按段归一 */
  segments: number;
  /** turns / (maxTurns × segments)；算不出来（缺 turns / 缺分母 / plan）为 null */
  ratio: number | null;
  /** undefined = 老行（早于恢复机制字段），不是"零次" */
  recovery: LedgerRecoveryTally | undefined;
  recoveryPolicy: LedgerRecoveryPolicy | null | undefined;
}

export interface TerminationSummary {
  /** 出现过的 stopReason，按总次数降序（unknown 排最后） */
  stopReasons: string[];
  byPack: TerminationPackRow[];
  maxTurnsRuns: MaxTurnsRunRow[];
  /**
   * 恢复机制字段落地后的行（有 recovery 字段）单独一套账：
   * 只有这些行能回答"续跑/停滞开过火没有"。老行是基线，混进来会把"零次"和"未知"抹成一个数。
   */
  postRecovery: {
    runs: number;
    maxTurns: number;
    extensions: number;
    stagnations: number;
    forced: number;
  };
}

/**
 * 把台账折成「终止原因 × 包」与 max_turns 明细。纯函数；`guardrailOf` 由调用方注入
 * （通常是 `getPack(name)?.guardrails?.maxTurns ?? DEFAULT_MAX_TURNS`）——台账层不 import
 * presets：仪器不该依赖被测对象的配置，只在老行缺分母时借它推算并明确标注。
 */
export function summarizeTermination(
  entries: RunLedgerEntry[],
  guardrailOf: (pack: string | null) => number | undefined = () => undefined,
): TerminationSummary {
  const perPack = new Map<string, Record<string, number>>();
  const reasonTotals = new Map<string, number>();
  const maxTurnsRuns: MaxTurnsRunRow[] = [];
  const post = { runs: 0, maxTurns: 0, extensions: 0, stagnations: 0, forced: 0 };

  for (const e of entries) {
    const pack = e.pack ?? LEDGER_NO_PACK;
    const reason = e.stopReason ?? "unknown";
    const counts = perPack.get(pack) ?? {};
    counts[reason] = (counts[reason] ?? 0) + 1;
    perPack.set(pack, counts);
    reasonTotals.set(reason, (reasonTotals.get(reason) ?? 0) + 1);

    if (e.recovery !== undefined) {
      post.runs += 1;
      post.extensions += e.recovery.extensions;
      post.stagnations += e.recovery.stagnations;
      post.forced += e.recovery.forced;
      if (e.stopReason === "max_turns") post.maxTurns += 1;
    }

    if (e.stopReason !== "max_turns") continue;
    const mode: "single" | "plan" = e.mode === "plan" ? "plan" : "single";
    let maxTurns: number | null = null;
    let maxTurnsSource: MaxTurnsRunRow["maxTurnsSource"] = null;
    if (mode === "single") {
      if (typeof e.maxTurns === "number" && e.maxTurns > 0) {
        maxTurns = e.maxTurns;
        maxTurnsSource = "ledger";
      } else if (e.maxTurns === undefined) {
        const inferred = guardrailOf(e.pack);
        if (inferred !== undefined && inferred > 0) {
          maxTurns = inferred;
          maxTurnsSource = "inferred";
        }
      }
    }
    const segments = 1 + Math.max(0, e.reworks ?? 0);
    const ratio =
      typeof e.turns === "number" && maxTurns !== null ? e.turns / (maxTurns * segments) : null;
    maxTurnsRuns.push({
      at: e.at,
      host: e.host,
      pack,
      mode,
      turns: e.turns ?? null,
      reworks: e.reworks ?? null,
      maxTurns,
      maxTurnsSource,
      segments,
      ratio,
      recovery: e.recovery,
      recoveryPolicy: e.recoveryPolicy,
    });
  }

  const stopReasons = [...reasonTotals.entries()]
    .sort((a, b) => (a[0] === "unknown" ? 1 : b[0] === "unknown" ? -1 : b[1] - a[1] || a[0].localeCompare(b[0])))
    .map(([k]) => k);
  const byPack: TerminationPackRow[] = [...perPack.entries()]
    .map(([pack, counts]) => ({
      pack,
      counts,
      total: Object.values(counts).reduce((n, v) => n + v, 0),
    }))
    .sort((a, b) => b.total - a.total || a.pack.localeCompare(b.pack));

  return { stopReasons, byPack, maxTurnsRuns, postRecovery: post };
}

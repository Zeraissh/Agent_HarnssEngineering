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
  tools: ToolTally;
  durationMs: number | null;
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
  tools?: ToolTally;
  durationMs?: number | null;
}

const RECOVERIES: LedgerRecovery[] = ["tool", "direct", "reformat", "wrapup", "failed"];

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
    tools: input.tools ?? {},
    durationMs: input.durationMs ?? null,
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

  for (const e of entries) {
    if (e.verify) verifiedRuns++;
    if (e.verifierHitBudget) hitBudget++;
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

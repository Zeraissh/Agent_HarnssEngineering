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

/** 裁决是怎么拿到的（与 verifier.ts 的 VerdictRecovery 同源） */
export type LedgerRecovery = "direct" | "reformat" | "wrapup" | "failed";

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

const RECOVERIES: LedgerRecovery[] = ["direct", "reformat", "wrapup", "failed"];

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
    error: input.error ? String(input.error).slice(0, 200).split("\n")[0]! : null,
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
 * §2.1（结构化输出 `tool_choice` / `response_format`）做不做的判据。
 *
 * **这段阈值是在拿到任何数据之前写下的**，这正是它算证据而不是事后合理化的
 * 分界线。收完数据再定阈值，等于用数据反推一个想要的结论。
 *
 * 背景：重问机制已经断掉"fail-closed 直接返工"那条链，9.7 的收口续跑又救回了
 * "撞预算没收口"那一类，所以 §2.1 的剩余增量只是消灭**残余的解析失败**。
 * 值不值得做，取决于残余到底有多大。
 */
export const STRUCTURED_OUTPUT_RULE = {
  /** 少于这个样本量，不下任何结论——这条是防"三次里有一次"就拍板 */
  minSamples: 20,
  /** 非 direct 占比低于此 → 关掉 §2.1，理由写进 backlog */
  closeBelow: 0.05,
  /** reformat + wrapup 占比高于此 → 做，且知道该优化哪一段 */
  doAbove: 0.2,
} as const;

export interface LedgerSummary {
  runs: number;
  verifiedRuns: number;
  /** 裁决轮数（一次运行可能有多轮） */
  verdicts: number;
  recovery: Record<LedgerRecovery | "unknown", number>;
  nonDirectRatio: number;
  reformatWrapupRatio: number;
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
    direct: 0, reformat: 0, wrapup: 0, failed: 0, unknown: 0,
  };
  const tools: ToolTally = {};
  const verifierWriteCalls: Record<string, number> = {};
  let verifiedRuns = 0;
  let hitBudget = 0;

  for (const e of entries) {
    if (e.verify) verifiedRuns++;
    if (e.verifierHitBudget) hitBudget++;
    for (const v of e.verifications) recovery[v.recovery ?? "unknown"]++;
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
    failClosed: recovery.failed,
    hitBudget,
    tools,
    verifierWriteCalls,
  };
}

export type StructuredOutputDecision = "insufficient" | "close" | "do" | "do-now";

/** 按 `STRUCTURED_OUTPUT_RULE` 出结论。判据在代码里，谁跑都一样。 */
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

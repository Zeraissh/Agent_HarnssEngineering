/**
 * B2 — 运行历史落盘。此前 `runs` 是内存 Map，宿主一重启全部运行连同会话
 * 正文一起没："用新功能"和"留住已有工作"变成二选一（真机实测撞到的后果）。
 *
 * 四个判据（动手前定死，与 docs/06-backlog.md B2 条目一致）：
 *
 * ① **存什么**：四个文件——`meta.json`（列表所需元数据快照，整写）、
 *    `events.jsonl`（可重放事件流，逐条追加；界面的全部状态都由重放长出来，
 *    这正是 V-05 重放幂等锁存在的原因）、`transcript.jsonl`（逐段会话正文，
 *    可达数 MB/段，与事件流分开、按需读——当初把 transcript 从 SSE 摘出去
 *    的理由在磁盘上同样成立）、`state.json`（RUN-01 / ADR-003 编排游标：
 *    phase / plan DAG / segment / 挂起审批 id——**不是**第二套事件流；
 *    Phase 1 不恢复 active grant、不冒充同 run 热续跑）。活对象一概不存：
 *    loop/abort/SSE 客户端存不了，挂起审批的 respond 回调也存不了——收尾时
 *    它们已被宣告过期并落进事件流。
 * ② **存哪**：`<root>/<runId>/` 每 run 一个目录。删一条 = 删一个目录，
 *    root 缺省 `<cwd>/.agent-run-history`，`AGENT_RUN_HISTORY_DIR` 可覆盖。
 * ③ **存多久**：只保留最近 DEFAULT_HISTORY_KEEP 个 run（启动与每次收尾后
 *    修剪，在跑的永不删）。没有清理策略的持久化最后都会变成没人敢删的占用。
 * ④ **怎样恢复续跑**：归档本身保持只读；每个已完成 main 段把 transcript 段号、
 *    ContextManager 水位和共享预算快照写进 meta。重启后从该检查点**派生新 run**，
 *    新 run 使用当前宿主的模型/工具/策略并显式记录 lineage，不冒充原进程无缝继续。
 *    没有检查点的旧档案仍只能回看。`state.json` 只回答"崩在哪一相"，续跑仍走 fork。
 *
 * 写失败不打断正在跑的 run，但必须通过健康状态显式上报；生产宿主不能把
 * “任务完成但历史全丢了”伪装成健康。meta/state 采用同目录临时文件 + rename，避免
 * 进程中断留下半截 JSON。
 */
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import {
  RUN_PHASES,
  RUN_STATE_VERSION,
  type DurablePlanSnapshot,
  type DurableRunState,
  type RunPhase,
} from "../src/run-state.js";
import type { SharedRunBudget } from "../src/types.js";

async function renameWithTransientRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw error;
      // Windows Defender/索引器会短暂占住旧 meta。保留旧文件并重试原子替换，
      // 不能先 rm target——那会制造一个断电时 meta 完全不存在的窗口。
      await new Promise((done) => setTimeout(done, 10 * 2 ** attempt));
    }
  }
}

/** meta/state 共用的整写 + rename；prefix 只进临时文件名，避免互相踩。 */
async function writeJsonAtomic(target: string, value: unknown, prefix: string): Promise<void> {
  const temporary = join(dirname(target), `.${prefix}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value), "utf8");
    await renameWithTransientRetry(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** 保留的 run 目录数上限（判据③）。先写死再收数据——口径同 STRUCTURED_OUTPUT_RULE */
export const DEFAULT_HISTORY_KEEP = 50;

/**
 * 最后一个完整 main checkpoint 中的授权快照。
 *
 * 这是 durable audit / 将来同-run 恢复的输入，不是可跨 run 搬运的 capability。
 * 当前 archive continuation 会创建新 run，因此宿主只读它并记录失效，绝不激活。
 */
export interface ArchivedApprovalGrant {
  version: 1;
  canonicalizationVersion: 1;
  policyVersion: 1;
  grantId: string;
  approvalId: string;
  boundRunId: string;
  scope: "run";
  name: string;
  inputScope: "exact-input";
  inputHash: string;
  toolFingerprint: string;
  issuedAt: number;
  expiresAt: number;
  maxUses: number;
  usedUses: number;
}

export interface ArchivedCheckpoint {
  /** transcript.jsonl 中承载这份 messages 的 main 段号 */
  segmentIndex: number;
  conversationTurn: number;
  /** ContextManager 首次恢复请求前的 compact 水位 */
  contextInputTokens: number;
  /** continuation / 返工谱系共用的累计预算快照 */
  runBudget: SharedRunBudget;
  /** 仅最后完整 main 段的授权审计快照；archive child 不继承 active grant */
  approvalGrants?: ArchivedApprovalGrant[];
}

/** meta.json 的形状。version 是将来格式演进的逃生口 */
export interface ArchivedMeta {
  version: 1;
  runId: string;
  task: string;
  /** "running" 只会出现在宿主没来得及正常收尾的档案里（崩溃/断电） */
  status: "running" | "done";
  verify: boolean;
  createdAt: number;
  finishedAt: number | null;
  packName: string | null;
  mode: "single" | "plan";
  effort: string | null;
  rubric: string | null;
  workdir: string | null;
  conversationTurn: number;
  planGate: boolean;
  planDecision: { decision: "approve" | "reject"; at: number } | null;
  mainStopReason: string | null;
  /** ask_user 是否开启；派生 run 只继承开关，不继承已用配额或审批放行 */
  askUser?: boolean;
  /** 归档可恢复检查点；旧档案缺省 = 只读 */
  checkpoint?: ArchivedCheckpoint | null;
  /** 派生谱系；父档案始终不可变 */
  continuedFrom?: string | null;
  rootRunId?: string | null;
  /** 列表列所需的裁决摘要；完整裁决在事件流里，不重复存 */
  outcome: { finalPassed: boolean | null; reworks: number | null; verdict: unknown } | null;
}

export interface ArchivedRun {
  meta: ArchivedMeta;
  dir: string;
}

/** 历史根：cwd 下 .agent-run-history，AGENT_RUN_HISTORY_DIR 可覆盖（口径同 ledgerPath） */
export function historyRootPath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const override = env.AGENT_RUN_HISTORY_DIR;
  if (override && override.trim()) return resolve(cwd, override.trim());
  return join(cwd, ".agent-run-history");
}

/** 保留数：AGENT_RUN_HISTORY_KEEP 可覆盖；非法值退默认（口径同 Web 宿主其它 env 解析） */
export function historyKeepCount(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENT_RUN_HISTORY_KEEP;
  if (!raw || !raw.trim()) return DEFAULT_HISTORY_KEEP;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_HISTORY_KEEP;
}

/**
 * 每 run 一个写入器。单条 promise 链保序（events.jsonl 的行序 = seq 序，
 * 乱序落盘会让重放出来的界面与当时不同）；任何一步失败后整链熄火——
 * 磁盘坏了就当没记（仪器纪律），不重试、不打断 run、不刷屏。
 */
export class RunHistoryWriter {
  private chain: Promise<unknown> = Promise.resolve();
  private dead = false;
  private failure: Error | null = null;

  constructor(
    readonly dir: string,
    private readonly onError?: (error: Error) => void,
  ) {
    this.enqueue(() => mkdir(this.dir, { recursive: true }));
  }

  private enqueue(op: () => Promise<unknown>): void {
    if (this.dead) return;
    this.chain = this.chain
      .then(async () => {
        // 多个写会在 mkdir 真正失败前排进链；失败后这些已排队步骤也必须短路。
        if (this.dead) return;
        await op();
      })
      .catch((cause: unknown) => {
        if (this.dead) return;
        this.dead = true;
        this.failure = cause instanceof Error ? cause : new Error(String(cause));
        this.onError?.(this.failure);
      });
  }

  /** 整写 meta.json；rename 的源/目标同目录，因此不会跨卷退化成复制。 */
  writeMeta(meta: ArchivedMeta): void {
    this.enqueue(async () => {
      await writeJsonAtomic(join(this.dir, "meta.json"), meta, "meta");
    });
  }

  /**
   * RUN-01：整写 state.json（编排游标）。与 meta 同链保序——调用方须先
   * appendEvent 再 writeState（ADR-003 写序），本 writer 的 enqueue 保证落盘顺序。
   */
  writeState(state: DurableRunState): void {
    this.enqueue(async () => {
      await writeJsonAtomic(join(this.dir, "state.json"), state, "state");
    });
  }

  appendEvent(sseEvent: unknown): void {
    this.enqueue(() => appendFile(join(this.dir, "events.jsonl"), `${JSON.stringify(sseEvent)}\n`, "utf8"));
  }

  appendTranscriptSegment(segment: unknown): void {
    this.enqueue(() => appendFile(join(this.dir, "transcript.jsonl"), `${JSON.stringify(segment)}\n`, "utf8"));
  }

  /** OBS-01：追加一条 trace span（与 events 同链保序）。 */
  appendTraceSpan(span: unknown): void {
    this.enqueue(() => appendFile(join(this.dir, "trace.jsonl"), `${JSON.stringify(span)}\n`, "utf8"));
  }

  /**
   * 在写入链上排一个自定义步骤：保证它在此前全部写落盘之后才执行。
   * 收尾后的修剪必须走这里——fire-and-forget 的修剪会与本 run 的 meta 写
   * 赛跑，读盘时档案还没成形，计数不足就不修（实测抓到的形态）。
   */
  schedule(op: () => Promise<unknown>): void {
    this.enqueue(op);
  }

  /** 宿主 close() 用：等待已入队的写全部落盘，收尾事件不能丢在半路 */
  flush(): Promise<unknown> {
    return this.chain;
  }

  get healthy(): boolean {
    return !this.dead;
  }

  get lastError(): Error | null {
    return this.failure;
  }
}

/**
 * 扫描历史根，按 createdAt 升序返回可读档案。
 * 坏档案（meta 缺失/损坏/版本不认识）逐条跳过——档案坏了不能影响宿主启动，
 * 这与 appendRunLedger"路径写不进去返回 false 而不是抛异常"是同一条纪律。
 */
export async function loadArchivedMetas(root: string): Promise<ArchivedRun[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return []; // 根目录不存在 = 还没有历史
  }
  const out: ArchivedRun[] = [];
  for (const name of entries) {
    const dir = join(root, name);
    try {
      const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as ArchivedMeta;
      if (!meta || meta.version !== 1 || typeof meta.runId !== "string" || meta.runId === "") continue;
      out.push({ meta, dir });
    } catch {
      // 跳过：半写的目录、损坏的 meta、混进来的无关文件
    }
  }
  out.sort((a, b) => a.meta.createdAt - b.meta.createdAt);
  return out;
}

/** 读一个档案的事件流。坏行跳过（追加中断可能留下半行），行序即 seq 序 */
export async function readArchivedEvents(dir: string): Promise<unknown[]> {
  return readJsonLines(join(dir, "events.jsonl"));
}

/** 读一个档案的会话正文（逐段） */
export async function readArchivedTranscript(dir: string): Promise<unknown[]> {
  return readJsonLines(join(dir, "transcript.jsonl"));
}

/** OBS-01：读 trace.jsonl（缺文件 = 空，旧档案无 trace） */
export async function readArchivedTrace(dir: string): Promise<unknown[]> {
  return readJsonLines(join(dir, "trace.jsonl"));
}

/**
 * RUN-01：读 state.json。坏文件/缺文件/版本不认 → null（同 meta 跳过纪律）。
 * 变异锁：丢掉 `phase` 必须返回 null，不能静默当成可恢复游标。
 */
export async function readArchivedState(dir: string): Promise<DurableRunState | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as unknown;
    return parseDurableRunState(raw);
  } catch {
    return null;
  }
}

/** 校验 DurableRunState 形状；任何必填字段缺失即 null。 */
export function parseDurableRunState(raw: unknown): DurableRunState | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== RUN_STATE_VERSION) return null;
  if (typeof o.runId !== "string" || o.runId === "") return null;
  if (typeof o.phase !== "string" || !(RUN_PHASES as readonly string[]).includes(o.phase)) return null;
  if (typeof o.updatedAt !== "number" || !Number.isFinite(o.updatedAt)) return null;
  if (typeof o.segmentIndex !== "number" || !Number.isInteger(o.segmentIndex) || o.segmentIndex < 0) {
    return null;
  }
  if (o.segmentSource !== null && typeof o.segmentSource !== "string") return null;
  if (typeof o.verificationRound !== "number" || !Number.isInteger(o.verificationRound)) return null;
  if (!Array.isArray(o.pendingApprovalIds) || !o.pendingApprovalIds.every((x) => typeof x === "string")) {
    return null;
  }
  if (!Array.isArray(o.pendingQuestionIds) || !o.pendingQuestionIds.every((x) => typeof x === "string")) {
    return null;
  }
  if (o.rootRunId !== null && typeof o.rootRunId !== "string") return null;
  if (o.continuedFrom !== null && typeof o.continuedFrom !== "string") return null;
  const plan = parseDurablePlanSnapshot(o.plan);
  if (o.plan !== null && plan === null) return null;
  return {
    version: RUN_STATE_VERSION,
    runId: o.runId,
    phase: o.phase as RunPhase,
    updatedAt: o.updatedAt,
    plan,
    segmentIndex: o.segmentIndex,
    segmentSource: o.segmentSource as string | null,
    verificationRound: o.verificationRound,
    pendingApprovalIds: [...o.pendingApprovalIds],
    pendingQuestionIds: [...o.pendingQuestionIds],
    rootRunId: (o.rootRunId as string | null) ?? null,
    continuedFrom: (o.continuedFrom as string | null) ?? null,
  };
}

function parseDurablePlanSnapshot(raw: unknown): DurablePlanSnapshot | null {
  if (raw === null || raw === undefined) return null;
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.protocol !== "freeform" && o.protocol !== "structured" && o.protocol !== "fixed") return null;
  if (!Array.isArray(o.taskIds) || !o.taskIds.every((x) => typeof x === "string")) return null;
  if (!o.edges || typeof o.edges !== "object") return null;
  const edges: Record<string, string[]> = {};
  for (const [from, tos] of Object.entries(o.edges as Record<string, unknown>)) {
    if (!Array.isArray(tos) || !tos.every((x) => typeof x === "string")) return null;
    edges[from] = [...tos];
  }
  if (o.approvedAt !== null && typeof o.approvedAt !== "number") return null;
  if (o.rejectedAt !== null && typeof o.rejectedAt !== "number") return null;
  return {
    protocol: o.protocol,
    taskIds: [...o.taskIds],
    edges,
    approvedAt: o.approvedAt as number | null,
    rejectedAt: o.rejectedAt as number | null,
  };
}

async function readJsonLines(file: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 半行（进程中断时最后一条可能没写完）：丢弃该行，其余照读
    }
  }
  return out;
}

/**
 * 修剪（判据③）：按 createdAt 保最近 keep 个，其余整目录删除。
 * `protectedIds` 里的永不删——收尾后修剪时别的 run 可能还在跑。
 * @returns 被删除的 runId（观测用）
 */
export async function pruneHistory(
  root: string,
  keep: number,
  protectedIds: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const archived = await loadArchivedMetas(root);
  const removable = archived.filter((a) => !protectedIds.has(a.meta.runId));
  const excess = removable.slice(0, Math.max(0, archived.length - Math.max(1, keep)));
  const removed: string[] = [];
  for (const a of excess) {
    try {
      await rm(a.dir, { recursive: true, force: true });
      removed.push(a.meta.runId);
    } catch {
      // 删不掉就留着，下次再试——修剪失败不值得让任何调用方失败
    }
  }
  return removed;
}

/**
 * B2 — 运行历史落盘。此前 `runs` 是内存 Map，宿主一重启全部运行连同会话
 * 正文一起没："用新功能"和"留住已有工作"变成二选一（真机实测撞到的后果）。
 *
 * 四个判据（动手前定死，与 docs/06-backlog.md B2 条目一致）：
 *
 * ① **存什么**：三个文件——`meta.json`（列表所需元数据快照，整写）、
 *    `events.jsonl`（可重放事件流，逐条追加；界面的全部状态都由重放长出来，
 *    这正是 V-05 重放幂等锁存在的原因）、`transcript.jsonl`（逐段会话正文，
 *    可达数 MB/段，与事件流分开、按需读——当初把 transcript 从 SSE 摘出去
 *    的理由在磁盘上同样成立）。活对象一概不存：loop/abort/SSE 客户端存不了，
 *    挂起审批的 respond 回调也存不了——收尾时它们已被宣告过期并落进事件流。
 * ② **存哪**：`<root>/<runId>/` 每 run 一个目录。删一条 = 删一个目录，
 *    root 缺省 `<cwd>/.agent-run-history`，`AGENT_RUN_HISTORY_DIR` 可覆盖。
 * ③ **存多久**：只保留最近 DEFAULT_HISTORY_KEEP 个 run（启动与每次收尾后
 *    修剪，在跑的永不删）。没有清理策略的持久化最后都会变成没人敢删的占用。
 * ④ **怎样恢复续跑**：归档本身保持只读；每个已完成 main 段把 transcript 段号、
 *    ContextManager 水位和共享预算快照写进 meta。重启后从该检查点**派生新 run**，
 *    新 run 使用当前宿主的模型/工具/策略并显式记录 lineage，不冒充原进程无缝继续。
 *    没有检查点的旧档案仍只能回看。
 *
 * 写失败不打断正在跑的 run，但必须通过健康状态显式上报；生产宿主不能把
 * “任务完成但历史全丢了”伪装成健康。meta 采用同目录临时文件 + rename，避免
 * 进程中断留下半截 JSON。
 */
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
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

/** 保留的 run 目录数上限（判据③）。先写死再收数据——口径同 STRUCTURED_OUTPUT_RULE */
export const DEFAULT_HISTORY_KEEP = 50;

export interface ArchivedCheckpoint {
  /** transcript.jsonl 中承载这份 messages 的 main 段号 */
  segmentIndex: number;
  conversationTurn: number;
  /** ContextManager 首次恢复请求前的 compact 水位 */
  contextInputTokens: number;
  /** continuation / 返工谱系共用的累计预算快照 */
  runBudget: SharedRunBudget;
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
      const target = join(this.dir, "meta.json");
      const temporary = join(this.dir, `.meta.${process.pid}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(meta), "utf8");
        await renameWithTransientRetry(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    });
  }

  appendEvent(sseEvent: unknown): void {
    this.enqueue(() => appendFile(join(this.dir, "events.jsonl"), `${JSON.stringify(sseEvent)}\n`, "utf8"));
  }

  appendTranscriptSegment(segment: unknown): void {
    this.enqueue(() => appendFile(join(this.dir, "transcript.jsonl"), `${JSON.stringify(segment)}\n`, "utf8"));
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

/**
 * T9 — 定时任务调度器。
 *
 * 判据（动手前定死）：
 *
 * ① **存在哪**：`<workdir>/.agent-schedules.json` 单文件整写（AGENT_SCHEDULES_FILE
 *    可覆盖，测试隔离用）。写盘沿用 history.ts 的原子写纪律：同目录临时文件 +
 *    rename；坏文件启动时备份为 .bak 后从新开始——档案坏了不能影响宿主启动。
 * ② **触发语义**：宿主内 setInterval 周期 tick（默认 30s，测试注入时钟手动 tick）。
 *    到期 = enabled 且 nextRunAt <= now。发起 run 走与 POST /api/runs **完全相同**
 *    的内部入口（createRunFromBody），调度器只负责构造请求体 { task, workdir, verify }。
 * ③ **错过（missed）**：once/daily/weekly 任务到期时刻已过超过 MISSED_WINDOW_MS（24h）
 *    才被发现（宿主停机/休眠），不补跑——半夜补跑"每天早上 8 点的报表"是惊吓不是
 *    功能。once 错过即禁用；daily/weekly 错过则顺推到下一个未来时刻。interval 不按错过
 *    处理：过期间隔只补跑一次，随后从触发时刻重新排期（不追打欠账）。
 * ④ **并发护栏（skipped）**：到期时该任务上一次 run 仍在跑（isRunActive(lastRunId)）
 *    → 本次跳过，只记 lastTrigger=skipped 不落盘（长 run 挡着短间隔任务时每 30s
 *    写一次盘是纯浪费），nextRunAt 不动，下个 tick 再试。
 * ⑤ **启动失败（error）**：准入被拒（容量/日预算/隔离不可用等）记 outcome=error
 *    并顺推排期——留在到期态会每 30s 打一次准入门。错误原因留在 lastTrigger.note。
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------

export type ScheduleSpec =
  | { kind: "once"; at: number }
  | { kind: "daily"; hhmm: string }
  | { kind: "weekly"; days: number[]; hhmm: string }
  | { kind: "interval"; everyMs: number };

/** 周一到周五（0=周日 … 6=周六）。预设「工作日」用这一组。 */
export const WEEKDAYS = [1, 2, 3, 4, 5] as const;

export type ScheduleTriggerOutcome = "launched" | "skipped" | "missed" | "error";

export interface ScheduleTriggerRecord {
  at: number;
  outcome: ScheduleTriggerOutcome;
  runId: string | null;
  note: string | null;
}

export interface ScheduleEntry {
  id: string;
  name: string;
  task: string;
  workdir: string;
  verify: boolean;
  schedule: ScheduleSpec;
  enabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
  lastRunId: string | null;
  /** 计算值随每次变更落盘；列表端点直接回读，不必每次重算 */
  nextRunAt: number | null;
  lastTrigger: ScheduleTriggerRecord | null;
  /** 可选：所属项目。缺省不入项；列表按当前项目过滤时只留对上的。 */
  projectId?: string;
}

/** 落盘文件形状。version 是将来格式演进的逃生口（与 meta.json 同纪律） */
export const SCHEDULES_FILE_VERSION = 1;

/** 判据③：once/daily 到期后超过这个窗口才被发现 → missed，不补跑 */
export const MISSED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** interval 下限：挡掉"每 1 秒跑一次"这种自杀式配置 */
export const MIN_INTERVAL_MS = 60_000;

/** tick 周期（宿主侧 setInterval）；测试不走它，手动调 runner.tick() */
export const SCHEDULE_TICK_MS = 30_000;

// ---------------------------------------------------------------
// 纯函数层：校验 / 排期计算 / 到期判定
// ---------------------------------------------------------------

const HHMM_RE = /^(\d{2}):(\d{2})$/;

/** "HH:MM" 严格校验（24 小时制）。合法返回 { hh, mm }，否则 null。 */
export function parseHhmm(raw: unknown): { hh: number; mm: number } | null {
  if (typeof raw !== "string") return null;
  const m = HHMM_RE.exec(raw);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

/**
 * 每周几天：整数 0=周日 … 6=周六，至少一天，去重后按日历序。
 * 越界 / 非整数 / 空数组一律 null——不静默丢掉坏项。
 */
export function parseWeeklyDays(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length < 1) return null;
  const seen = new Set<number>();
  for (const item of raw) {
    if (typeof item !== "number" || !Number.isInteger(item) || item < 0 || item > 6) return null;
    seen.add(item);
  }
  if (seen.size < 1) return null;
  return [...seen].sort((a, b) => a - b);
}

/** 工作日 = 周一到周五（1–5），顺序无关。 */
export function isWeekdays(days: readonly number[]): boolean {
  if (days.length !== WEEKDAYS.length) return false;
  const have = new Set(days);
  return WEEKDAYS.every((d) => have.has(d));
}

/**
 * 调度规则校验（API 入参与落盘加载共用一条，不各写一份）。
 * once.at 必须是有限整数；daily.hhmm 必须过 parseHhmm；
 * weekly.days 必须是 0–6 的非空整数集 + 合法 hhmm；
 * interval.everyMs 必须是 >= MIN_INTERVAL_MS 的整数。
 */
export function parseScheduleSpec(raw: unknown): ScheduleSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.kind === "once") {
    if (typeof o.at !== "number" || !Number.isFinite(o.at)) return null;
    return { kind: "once", at: o.at };
  }
  if (o.kind === "daily") {
    if (!parseHhmm(o.hhmm)) return null;
    return { kind: "daily", hhmm: o.hhmm as string };
  }
  if (o.kind === "weekly") {
    const days = parseWeeklyDays(o.days);
    if (!days || !parseHhmm(o.hhmm)) return null;
    return { kind: "weekly", days, hhmm: o.hhmm as string };
  }
  if (o.kind === "interval") {
    if (typeof o.everyMs !== "number" || !Number.isInteger(o.everyMs) || o.everyMs < MIN_INTERVAL_MS) {
      return null;
    }
    return { kind: "interval", everyMs: o.everyMs };
  }
  return null;
}

/** daily 的下一个触发时刻：今天 hh:mm 已过则明天（本地时区，与操作员直觉一致）。 */
function nextDailyAt(hhmm: string, now: number): number {
  const { hh, mm } = parseHhmm(hhmm)!;
  const cursor = new Date(now);
  let candidate = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), hh, mm, 0, 0);
  if (candidate.getTime() <= now) {
    candidate = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1, hh, mm, 0, 0);
  }
  return candidate.getTime();
}

/**
 * weekly：从 now 起找下一个落在 days 里的本地 hh:mm（严格大于 now）。
 * 最多往前看 7 天；days 已由 parse 保证非空。
 */
function nextWeeklyAt(days: readonly number[], hhmm: string, now: number): number {
  const { hh, mm } = parseHhmm(hhmm)!;
  const wanted = new Set(days);
  const cursor = new Date(now);
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(
      cursor.getFullYear(),
      cursor.getMonth(),
      cursor.getDate() + offset,
      hh,
      mm,
      0,
      0,
    );
    if (candidate.getTime() > now && wanted.has(candidate.getDay())) {
      return candidate.getTime();
    }
  }
  // 理论上 days 非空时走不到；退回一周后同一时刻以免 null 卡住启用态
  return new Date(
    cursor.getFullYear(),
    cursor.getMonth(),
    cursor.getDate() + 7,
    hh,
    mm,
    0,
    0,
  ).getTime();
}

/**
 * 计算下一次触发时刻。
 *
 * - once：at 在未来 → at；已过 → null（等 missed/禁用处理）
 * - daily：下一个 hh:mm（严格大于 now）
 * - weekly：下一个落在 days 里的 hh:mm（严格大于 now）
 * - interval：base + everyMs。base 取 lastRunAt ?? createdAt；
 *   算出来已在过去（宿主停机欠账）就**不逐拍追补**，直接排 now + everyMs
 */
export function computeNextRunAt(
  schedule: ScheduleSpec,
  now: number,
  base?: number | null,
): number | null {
  if (schedule.kind === "once") {
    return schedule.at > now ? schedule.at : null;
  }
  if (schedule.kind === "daily") {
    return nextDailyAt(schedule.hhmm, now);
  }
  if (schedule.kind === "weekly") {
    return nextWeeklyAt(schedule.days, schedule.hhmm, now);
  }
  const anchor = typeof base === "number" && Number.isFinite(base) ? base : now;
  const next = anchor + schedule.everyMs;
  return next > now ? next : now + schedule.everyMs;
}

/** 到期判定：启用中且 nextRunAt 已到（含恰好等于）。 */
export function isDue(entry: Pick<ScheduleEntry, "enabled" | "nextRunAt">, now: number): boolean {
  return entry.enabled && entry.nextRunAt !== null && entry.nextRunAt <= now;
}

/**
 * 当前选了项目时：只留带同一 projectId 的条目。
 * 未选项目（空 / 缺省）→ 原样返回，不把未入项的任务藏起来。
 */
export function filterSchedulesByProject<T extends Pick<ScheduleEntry, "projectId">>(
  entries: readonly T[],
  projectId?: string | null,
): T[] {
  const want = String(projectId ?? "").trim();
  if (!want) return [...entries];
  return entries.filter((entry) => entry.projectId === want);
}

/**
 * 判据③错过判定：once/daily/weekly 的到期时刻已过去超过 MISSED_WINDOW_MS。
 * interval 永不 missed（判据③：只补跑一次后重新排期）。
 */
export function isMissed(
  entry: Pick<ScheduleEntry, "enabled" | "nextRunAt" | "schedule">,
  now: number,
): boolean {
  if (!entry.enabled || entry.nextRunAt === null) return false;
  if (entry.schedule.kind === "interval") return false;
  return now - entry.nextRunAt > MISSED_WINDOW_MS;
}

/**
 * 触发（含手动）成功后顺推排期：
 * once → 禁用并清空 nextRunAt；daily/weekly → 下一个时刻；interval → 从触发时刻起 +everyMs。
 */
export function advanceAfterTrigger(entry: ScheduleEntry, now: number): void {
  if (entry.schedule.kind === "once") {
    entry.enabled = false;
    entry.nextRunAt = null;
    return;
  }
  entry.nextRunAt = computeNextRunAt(entry.schedule, now, now);
}

/** 判据③错过处置：once 禁用；daily/weekly 顺推到下一个未来时刻。 */
export function advanceAfterMiss(entry: ScheduleEntry, now: number): void {
  if (entry.schedule.kind === "once") {
    entry.enabled = false;
    entry.nextRunAt = null;
    return;
  }
  entry.nextRunAt = computeNextRunAt(entry.schedule, now, entry.lastRunAt ?? entry.createdAt);
}

// ---------------------------------------------------------------
// 持久化（判据①）
// ---------------------------------------------------------------

/** 调度文件路径：AGENT_SCHEDULES_FILE 覆盖；缺省 <cwd>/.agent-schedules.json */
export function schedulesFilePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const override = env.AGENT_SCHEDULES_FILE;
  if (override && override.trim()) return resolve(cwd, override.trim());
  return join(cwd, ".agent-schedules.json");
}

async function renameWithTransientRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw error;
      await new Promise((done) => setTimeout(done, 10 * 2 ** attempt));
    }
  }
}

/** 与 history.ts 同纪律的原子整写：同目录临时文件 + rename。 */
async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temporary = join(dirname(target), `.schedules.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value), "utf8");
    await renameWithTransientRetry(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** 单条 entry 的形状校验；任何必填字段不对劲即 null（坏记录不拖垮整表）。 */
export function parseScheduleEntry(raw: unknown): ScheduleEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id === "") return null;
  if (typeof o.name !== "string") return null;
  if (typeof o.task !== "string" || o.task === "") return null;
  if (typeof o.workdir !== "string" || o.workdir === "") return null;
  if (typeof o.createdAt !== "number" || !Number.isFinite(o.createdAt)) return null;
  const schedule = parseScheduleSpec(o.schedule);
  if (!schedule) return null;
  const numOrNull = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  let lastTrigger: ScheduleTriggerRecord | null = null;
  if (o.lastTrigger && typeof o.lastTrigger === "object") {
    const t = o.lastTrigger as Record<string, unknown>;
    const outcome = t.outcome;
    if (
      typeof t.at === "number" &&
      (outcome === "launched" || outcome === "skipped" || outcome === "missed" || outcome === "error")
    ) {
      lastTrigger = {
        at: t.at,
        outcome,
        runId: typeof t.runId === "string" ? t.runId : null,
        note: typeof t.note === "string" ? t.note : null,
      };
    }
  }
  return {
    id: o.id,
    name: o.name,
    task: o.task,
    workdir: o.workdir,
    verify: o.verify === true,
    schedule,
    enabled: o.enabled === true,
    createdAt: o.createdAt,
    lastRunAt: numOrNull(o.lastRunAt),
    lastRunId: typeof o.lastRunId === "string" ? o.lastRunId : null,
    nextRunAt: numOrNull(o.nextRunAt),
    lastTrigger,
    ...(typeof o.projectId === "string" && o.projectId.trim()
      ? { projectId: o.projectId.trim() }
      : {}),
  };
}

export interface SchedulesLoadResult {
  entries: ScheduleEntry[];
  /** true = 原文件损坏已备份为 .bak，从空表从新开始 */
  recovered: boolean;
}

/**
 * 启动加载（判据①）：缺文件 → 空表；坏 JSON / 版本不认 → 备份 .bak 后空表；
 * 表内坏条目逐条丢弃。任何形态都不抛——调度器坏了不能挡住宿主启动。
 */
export async function loadSchedules(file: string): Promise<SchedulesLoadResult> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { entries: [], recovered: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    await rename(file, `${file}.bak`).catch(() => {});
    return { entries: [], recovered: true };
  }
  const o = parsed as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.version !== SCHEDULES_FILE_VERSION || !Array.isArray(o.schedules)) {
    await rename(file, `${file}.bak`).catch(() => {});
    return { entries: [], recovered: true };
  }
  const entries: ScheduleEntry[] = [];
  for (const raw of o.schedules) {
    const entry = parseScheduleEntry(raw);
    if (entry) entries.push(entry);
  }
  return { entries, recovered: false };
}

/** 整写落盘（原子）。目录不存在先建——首次写入时调度文件还没出生过。 */
export async function saveSchedules(file: string, entries: readonly ScheduleEntry[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeJsonAtomic(file, { version: SCHEDULES_FILE_VERSION, schedules: entries });
}

// ---------------------------------------------------------------
// 触发循环（判据②③④⑤）
// ---------------------------------------------------------------

export type ScheduleLaunchResult = { ok: true; runId: string } | { ok: false; error: string };

export interface ScheduleRunnerOptions {
  /** 共享数组引用：REST 处理器的增删改直接反映到 tick（同一份状态，不设副本） */
  entries: ScheduleEntry[];
  /** 发起 run：宿主注入与 POST /api/runs 相同的内部入口（只传 task/workdir/verify） */
  launch: (entry: ScheduleEntry) => Promise<ScheduleLaunchResult>;
  /** 并发护栏的事实源：该 run 是否仍在跑 */
  isRunActive: (runId: string) => boolean;
  /** 需要落盘的时刻回调（launched/missed/error/REST 变更；skipped 故意不落盘，判据④） */
  onChange?: () => void;
  now?: () => number;
}

export class ScheduleRunner {
  private ticking = false;

  constructor(private readonly opts: ScheduleRunnerOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private record(entry: ScheduleEntry, outcome: ScheduleTriggerOutcome, runId: string | null, note: string | null): void {
    entry.lastTrigger = { at: this.now(), outcome, runId, note };
  }

  /**
   * 一轮巡检：逐条处理到期任务。异步串行（同一 tick 内不并发发起），
   * 重入护栏挡住"上一轮还没跑完下一轮又到点"（30s 周期下手动触发可能撞上）。
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const entry of this.opts.entries) {
        await this.consider(entry);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** 单条到期处置；tick 与手动触发共用（手动跳过 due 检查，走 triggerNow）。 */
  private async consider(entry: ScheduleEntry): Promise<void> {
    const now = this.now();
    if (!isDue(entry, now)) return;
    // 判据③：欠账超过 24h 的 once/daily 不补跑
    if (isMissed(entry, now)) {
      this.record(entry, "missed", null, "错过触发时间超过 24 小时，未补跑");
      advanceAfterMiss(entry, now);
      this.opts.onChange?.();
      return;
    }
    await this.launch(entry, now);
  }

  /**
   * 手动立即触发（POST /api/schedules/:id/run）：无视到期与启用状态，
   * 但并发护栏（判据④）照样生效。触发后按规则顺推排期。
   * once 已禁用（已跑过/已错过）的任务不允许手动触发——它没有"下一次"可顺推。
   */
  async triggerNow(entry: ScheduleEntry): Promise<ScheduleTriggerOutcome> {
    const now = this.now();
    if (entry.schedule.kind === "once" && !entry.enabled && entry.lastTrigger !== null) {
      return "missed"; // 调用方映射成 409：一次性任务已终结
    }
    return this.launch(entry, now);
  }

  private async launch(entry: ScheduleEntry, now: number): Promise<ScheduleTriggerOutcome> {
    // 判据④：上一次 run 仍在跑 → 跳过，排期不动，下个 tick 再试
    if (entry.lastRunId && this.opts.isRunActive(entry.lastRunId)) {
      this.record(entry, "skipped", entry.lastRunId, "上一次运行仍在进行，本次跳过");
      return "skipped";
    }
    let result: ScheduleLaunchResult;
    try {
      result = await this.opts.launch(entry);
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (result.ok) {
      entry.lastRunAt = now;
      entry.lastRunId = result.runId;
      this.record(entry, "launched", result.runId, null);
    } else {
      // 判据⑤：准入失败顺推排期，不留到期态反复打门
      this.record(entry, "error", null, result.error);
    }
    advanceAfterTrigger(entry, now);
    this.opts.onChange?.();
    return result.ok ? "launched" : "error";
  }
}

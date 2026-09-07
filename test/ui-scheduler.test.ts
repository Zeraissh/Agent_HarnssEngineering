/**
 * T9 调度器纯逻辑与持久化测试——ui/scheduler.ts。
 *
 * 全程注入时钟（now 函数）与假 launch/isRunActive，不碰真实定时器、
 * 不等 30s tick。覆盖：
 *   a. parseHhmm / parseScheduleSpec 校验
 *   b. computeNextRunAt：once / daily / interval 三种规则
 *   c. isDue / isMissed 到期与错过（24h 窗口）判定
 *   d. advanceAfterTrigger / advanceAfterMiss 排期顺推
 *   e. 持久化 round-trip + 坏文件 .bak 容错 + 坏条目逐条丢弃
 *   f. ScheduleRunner.tick：到期发起、once 触发后禁用、并发护栏 skipped、
 *      错过 missed、启动失败 error 顺推、重入护栏
 *   g. triggerNow：手动触发绕过到期检查、并发护栏仍生效、已终结 once 拒绝
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MIN_INTERVAL_MS,
  MISSED_WINDOW_MS,
  SCHEDULES_FILE_VERSION,
  ScheduleRunner,
  advanceAfterMiss,
  advanceAfterTrigger,
  computeNextRunAt,
  isDue,
  isMissed,
  loadSchedules,
  parseHhmm,
  parseScheduleEntry,
  parseScheduleSpec,
  saveSchedules,
  schedulesFilePath,
  type ScheduleEntry,
  type ScheduleSpec,
} from "../ui/scheduler.js";

/** 本地时区构造时刻（daily 语义是本地挂钟时间，测试必须用同一基准） */
function localTime(y: number, mo: number, d: number, h: number, mi: number): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

let entrySeq = 0;
function makeEntry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  entrySeq += 1;
  return {
    id: `sched-${entrySeq}`,
    name: `任务 ${entrySeq}`,
    task: "做点事",
    workdir: "/tmp/work",
    verify: false,
    schedule: { kind: "interval", everyMs: 3_600_000 },
    enabled: true,
    createdAt: 1_000_000,
    lastRunAt: null,
    lastRunId: null,
    nextRunAt: null,
    lastTrigger: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------
// a. 校验
// ---------------------------------------------------------------
describe("调度规则校验", () => {
  it("parseHhmm：合法 HH:MM 通过，越界与畸形拒绝", () => {
    expect(parseHhmm("09:30")).toEqual({ hh: 9, mm: 30 });
    expect(parseHhmm("00:00")).toEqual({ hh: 0, mm: 0 });
    expect(parseHhmm("23:59")).toEqual({ hh: 23, mm: 59 });
    expect(parseHhmm("24:00")).toBeNull();
    expect(parseHhmm("09:60")).toBeNull();
    expect(parseHhmm("9:30")).toBeNull();
    expect(parseHhmm("0930")).toBeNull();
    expect(parseHhmm(930)).toBeNull();
    expect(parseHhmm("")).toBeNull();
  });

  it("parseScheduleSpec：三种合法形态", () => {
    expect(parseScheduleSpec({ kind: "once", at: 123 })).toEqual({ kind: "once", at: 123 });
    expect(parseScheduleSpec({ kind: "daily", hhmm: "08:00" })).toEqual({ kind: "daily", hhmm: "08:00" });
    expect(parseScheduleSpec({ kind: "interval", everyMs: MIN_INTERVAL_MS })).toEqual({
      kind: "interval",
      everyMs: MIN_INTERVAL_MS,
    });
  });

  it("parseScheduleSpec：非法形态逐类拒绝", () => {
    expect(parseScheduleSpec(null)).toBeNull();
    expect(parseScheduleSpec("daily")).toBeNull();
    expect(parseScheduleSpec({ kind: "weekly" })).toBeNull();
    expect(parseScheduleSpec({ kind: "once", at: "明天" })).toBeNull();
    expect(parseScheduleSpec({ kind: "once", at: Number.NaN })).toBeNull();
    expect(parseScheduleSpec({ kind: "daily", hhmm: "25:00" })).toBeNull();
    expect(parseScheduleSpec({ kind: "interval", everyMs: 1000 })).toBeNull(); // 低于 1 分钟下限
    expect(parseScheduleSpec({ kind: "interval", everyMs: 90_000.5 })).toBeNull(); // 非整数
  });
});

// ---------------------------------------------------------------
// b. nextRunAt 计算
// ---------------------------------------------------------------
describe("computeNextRunAt", () => {
  const now = localTime(2026, 9, 6, 8, 0); // 2026-09-06 08:00 本地

  it("once：未来时刻原样返回；已过返回 null", () => {
    const future = localTime(2026, 9, 6, 9, 0);
    expect(computeNextRunAt({ kind: "once", at: future }, now)).toBe(future);
    expect(computeNextRunAt({ kind: "once", at: now }, now)).toBeNull();
    expect(computeNextRunAt({ kind: "once", at: now - 1 }, now)).toBeNull();
  });

  it("daily：当天时刻未到 → 今天；已过 → 明天", () => {
    const today0930 = localTime(2026, 9, 6, 9, 30);
    const tomorrow0800 = localTime(2026, 9, 7, 8, 0);
    expect(computeNextRunAt({ kind: "daily", hhmm: "09:30" }, now)).toBe(today0930);
    // 恰好等于 now 也算"已过"（严格大于）
    expect(computeNextRunAt({ kind: "daily", hhmm: "08:00" }, now)).toBe(localTime(2026, 9, 7, 8, 0));
    expect(tomorrow0800).toBe(localTime(2026, 9, 7, 8, 0));
  });

  it("interval：base + everyMs；欠账不逐拍追补，直接 now + everyMs", () => {
    const spec: ScheduleSpec = { kind: "interval", everyMs: 3_600_000 };
    expect(computeNextRunAt(spec, now, now - 1_000_000)).toBe(now - 1_000_000 + 3_600_000);
    // base 太旧（欠了好几拍）：不追补，从 now 重新排
    expect(computeNextRunAt(spec, now, now - 10 * 3_600_000)).toBe(now + 3_600_000);
    // 无 base（新建）：从 now 起
    expect(computeNextRunAt(spec, now, null)).toBe(now + 3_600_000);
  });
});

// ---------------------------------------------------------------
// c/d. 到期与错过判定、排期顺推
// ---------------------------------------------------------------
describe("到期 / 错过 / 顺推", () => {
  const now = localTime(2026, 9, 6, 8, 0);

  it("isDue：启用且 nextRunAt <= now", () => {
    expect(isDue(makeEntry({ nextRunAt: now - 1 }), now)).toBe(true);
    expect(isDue(makeEntry({ nextRunAt: now }), now)).toBe(true);
    expect(isDue(makeEntry({ nextRunAt: now + 1 }), now)).toBe(false);
    expect(isDue(makeEntry({ enabled: false, nextRunAt: now - 1 }), now)).toBe(false);
    expect(isDue(makeEntry({ nextRunAt: null }), now)).toBe(false);
  });

  it("isMissed：once/daily 超过 24h 才算；interval 永不 missed", () => {
    const daily = makeEntry({ schedule: { kind: "daily", hhmm: "07:00" }, nextRunAt: now - MISSED_WINDOW_MS - 1 });
    expect(isMissed(daily, now)).toBe(true);
    const justIn = makeEntry({ schedule: { kind: "daily", hhmm: "07:00" }, nextRunAt: now - MISSED_WINDOW_MS });
    expect(isMissed(justIn, now)).toBe(false);
    const once = makeEntry({ schedule: { kind: "once", at: 1 }, nextRunAt: now - MISSED_WINDOW_MS - 1 });
    expect(isMissed(once, now)).toBe(true);
    const interval = makeEntry({ nextRunAt: now - MISSED_WINDOW_MS * 3 });
    expect(isMissed(interval, now)).toBe(false);
    expect(isMissed(makeEntry({ enabled: false, nextRunAt: 1 }), now)).toBe(false);
  });

  it("advanceAfterTrigger：once 禁用；daily/interval 顺推到未来", () => {
    const once = makeEntry({ schedule: { kind: "once", at: now + 1000 }, nextRunAt: now + 1000 });
    advanceAfterTrigger(once, now);
    expect(once.enabled).toBe(false);
    expect(once.nextRunAt).toBeNull();

    const daily = makeEntry({ schedule: { kind: "daily", hhmm: "09:00" } });
    advanceAfterTrigger(daily, now);
    expect(daily.nextRunAt).toBe(localTime(2026, 9, 6, 9, 0));

    const interval = makeEntry({ schedule: { kind: "interval", everyMs: 3_600_000 } });
    advanceAfterTrigger(interval, now);
    expect(interval.nextRunAt).toBe(now + 3_600_000);
  });

  it("advanceAfterMiss：once 禁用；daily 顺推到下一个未来时刻", () => {
    const once = makeEntry({ schedule: { kind: "once", at: 1 }, nextRunAt: 1 });
    advanceAfterMiss(once, now);
    expect(once.enabled).toBe(false);
    expect(once.nextRunAt).toBeNull();

    const daily = makeEntry({ schedule: { kind: "daily", hhmm: "09:30" }, nextRunAt: 1 });
    advanceAfterMiss(daily, now);
    expect(daily.enabled).toBe(true);
    expect(daily.nextRunAt).toBe(localTime(2026, 9, 6, 9, 30));
  });
});

// ---------------------------------------------------------------
// e. 持久化
// ---------------------------------------------------------------
describe("持久化", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ui-scheduler-"));
    file = join(dir, ".agent-schedules.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trip：save → load 逐字段一致", async () => {
    const entry = makeEntry({
      id: "rt-1",
      schedule: { kind: "daily", hhmm: "09:30" },
      verify: true,
      lastRunAt: 123,
      lastRunId: "run-x",
      nextRunAt: 456,
      lastTrigger: { at: 100, outcome: "launched", runId: "run-x", note: null },
    });
    await saveSchedules(file, [entry]);
    const loaded = await loadSchedules(file);
    expect(loaded.recovered).toBe(false);
    expect(loaded.entries).toEqual([entry]);
  });

  it("缺文件 → 空表且非 recovered", async () => {
    const loaded = await loadSchedules(join(dir, "nope.json"));
    expect(loaded).toEqual({ entries: [], recovered: false });
  });

  it("坏 JSON → 备份 .bak 后空表从新开始", async () => {
    await writeFile(file, "{oops", "utf8");
    const loaded = await loadSchedules(file);
    expect(loaded).toEqual({ entries: [], recovered: true });
    const bak = await readFile(`${file}.bak`, "utf8");
    expect(bak).toBe("{oops");
    // 原文件已改名走，load 应已是空表起点
    await expect(access(file)).rejects.toThrow();
  });

  it("版本不认 → 同样备份 .bak", async () => {
    await writeFile(file, JSON.stringify({ version: 999, schedules: [] }), "utf8");
    const loaded = await loadSchedules(file);
    expect(loaded.recovered).toBe(true);
    expect(loaded.entries).toEqual([]);
  });

  it("表内坏条目逐条丢弃，好条目保留", async () => {
    const good = makeEntry({ id: "good-1" });
    await writeFile(
      file,
      JSON.stringify({
        version: SCHEDULES_FILE_VERSION,
        schedules: [good, { id: "" }, { id: "x", task: 42 }, null],
      }),
      "utf8",
    );
    const loaded = await loadSchedules(file);
    expect(loaded.recovered).toBe(false);
    expect(loaded.entries.map((e) => e.id)).toEqual(["good-1"]);
  });

  it("schedulesFilePath：env 覆盖优先，缺省 <cwd>/.agent-schedules.json", () => {
    expect(schedulesFilePath({}, "/repo")).toBe(join("/repo", ".agent-schedules.json"));
    expect(schedulesFilePath({ AGENT_SCHEDULES_FILE: "custom.json" }, "/repo")).toBe(
      resolve("/repo", "custom.json"),
    );
  });
});

// ---------------------------------------------------------------
// f/g. Runner 触发循环
// ---------------------------------------------------------------
describe("ScheduleRunner", () => {
  const t0 = localTime(2026, 9, 6, 8, 0);

  function makeRunner(opts: {
    entries: ScheduleEntry[];
    now?: () => number;
    launch?: (entry: ScheduleEntry) => Promise<{ ok: true; runId: string } | { ok: false; error: string }>;
    isRunActive?: (runId: string) => boolean;
    onChange?: () => void;
  }) {
    return new ScheduleRunner({
      entries: opts.entries,
      launch: opts.launch ?? (() => Promise.resolve({ ok: true, runId: "run-auto" })),
      isRunActive: opts.isRunActive ?? (() => false),
      now: opts.now ?? (() => t0),
      onChange: opts.onChange,
    });
  }

  it("到期 interval 任务被发起：lastRunAt/lastRunId/nextRunAt 更新并落盘", async () => {
    const entry = makeEntry({ nextRunAt: t0 - 1 });
    let persisted = 0;
    const runner = makeRunner({ entries: [entry], onChange: () => { persisted += 1; } });
    await runner.tick();
    expect(entry.lastRunAt).toBe(t0);
    expect(entry.lastRunId).toBe("run-auto");
    expect(entry.nextRunAt).toBe(t0 + 3_600_000);
    expect(entry.lastTrigger?.outcome).toBe("launched");
    expect(persisted).toBe(1);
  });

  it("未到期 / 已禁用不动", async () => {
    const future = makeEntry({ nextRunAt: t0 + 1000 });
    const disabled = makeEntry({ enabled: false, nextRunAt: t0 - 1 });
    let launches = 0;
    const runner = makeRunner({
      entries: [future, disabled],
      launch: () => { launches += 1; return Promise.resolve({ ok: true, runId: "r" }); },
    });
    await runner.tick();
    expect(launches).toBe(0);
    expect(future.lastTrigger).toBeNull();
    expect(disabled.lastTrigger).toBeNull();
  });

  it("once 触发后禁用且清空 nextRunAt", async () => {
    const entry = makeEntry({
      schedule: { kind: "once", at: t0 - 1000 },
      nextRunAt: t0 - 1000,
    });
    const runner = makeRunner({ entries: [entry] });
    await runner.tick();
    expect(entry.enabled).toBe(false);
    expect(entry.nextRunAt).toBeNull();
    expect(entry.lastTrigger?.outcome).toBe("launched");
    // 再 tick 不重放
    await runner.tick();
    expect(entry.lastRunAt).toBe(t0);
  });

  it("并发护栏：上一次 run 仍在跑 → skipped，排期不动、不落盘", async () => {
    const entry = makeEntry({ nextRunAt: t0 - 1, lastRunId: "run-busy", lastRunAt: t0 - 3_600_000 });
    let persisted = 0;
    let launches = 0;
    const runner = makeRunner({
      entries: [entry],
      isRunActive: (id) => id === "run-busy",
      launch: () => { launches += 1; return Promise.resolve({ ok: true, runId: "r" }); },
      onChange: () => { persisted += 1; },
    });
    await runner.tick();
    expect(launches).toBe(0);
    expect(entry.lastTrigger?.outcome).toBe("skipped");
    expect(entry.nextRunAt).toBe(t0 - 1); // 排期不动，下个 tick 再试
    expect(persisted).toBe(0); // skipped 故意不落盘（每 30s 写盘是纯浪费）
  });

  it("错过超过 24h 的 daily：missed 不补跑，顺推到明天", async () => {
    const stale = t0 - MISSED_WINDOW_MS - 60_000;
    const entry = makeEntry({
      schedule: { kind: "daily", hhmm: "09:30" },
      nextRunAt: stale,
    });
    let launches = 0;
    let persisted = 0;
    const runner = makeRunner({
      entries: [entry],
      launch: () => { launches += 1; return Promise.resolve({ ok: true, runId: "r" }); },
      onChange: () => { persisted += 1; },
    });
    await runner.tick();
    expect(launches).toBe(0);
    expect(entry.lastTrigger?.outcome).toBe("missed");
    expect(entry.nextRunAt).toBe(localTime(2026, 9, 6, 9, 30));
    expect(persisted).toBe(1);
  });

  it("错过超过 24h 的 once：missed 并禁用", async () => {
    const stale = t0 - MISSED_WINDOW_MS - 60_000;
    const entry = makeEntry({
      schedule: { kind: "once", at: stale },
      nextRunAt: stale,
    });
    let launches = 0;
    const runner = makeRunner({
      entries: [entry],
      launch: () => { launches += 1; return Promise.resolve({ ok: true, runId: "r" }); },
    });
    await runner.tick();
    expect(launches).toBe(0);
    expect(entry.enabled).toBe(false);
    expect(entry.lastTrigger?.outcome).toBe("missed");
  });

  it("启动失败：记 error 并顺推排期（不留到期态反复打门）", async () => {
    const entry = makeEntry({ nextRunAt: t0 - 1 });
    const runner = makeRunner({
      entries: [entry],
      launch: () => Promise.resolve({ ok: false, error: "容量已满" }),
    });
    await runner.tick();
    expect(entry.lastTrigger?.outcome).toBe("error");
    expect(entry.lastTrigger?.note).toBe("容量已满");
    expect(entry.nextRunAt).toBe(t0 + 3_600_000);
    expect(entry.lastRunId).toBeNull();
  });

  it("launch 抛异常同样记 error，不炸掉 tick 循环", async () => {
    const bad = makeEntry({ nextRunAt: t0 - 1 });
    const good = makeEntry({ nextRunAt: t0 - 1 });
    const runner = makeRunner({
      entries: [bad, good],
      launch: (entry) =>
        entry === bad ? Promise.reject(new Error("boom")) : Promise.resolve({ ok: true, runId: "r-2" }),
    });
    await runner.tick();
    expect(bad.lastTrigger?.outcome).toBe("error");
    expect(bad.lastTrigger?.note).toBe("boom");
    expect(good.lastTrigger?.outcome).toBe("launched");
  });

  it("triggerNow：未到期也立即触发；触发后顺推排期", async () => {
    const entry = makeEntry({ nextRunAt: t0 + 3_600_000 });
    const runner = makeRunner({ entries: [entry] });
    const outcome = await runner.triggerNow(entry);
    expect(outcome).toBe("launched");
    expect(entry.lastRunId).toBe("run-auto");
    expect(entry.nextRunAt).toBe(t0 + 3_600_000);
  });

  it("triggerNow：并发护栏仍生效", async () => {
    const entry = makeEntry({ nextRunAt: t0 + 3_600_000, lastRunId: "busy" });
    const runner = makeRunner({ entries: [entry], isRunActive: () => true });
    const outcome = await runner.triggerNow(entry);
    expect(outcome).toBe("skipped");
    expect(entry.lastTrigger?.outcome).toBe("skipped");
  });

  it("triggerNow：已终结的 once（已跑过禁用）拒绝重放", async () => {
    const entry = makeEntry({
      schedule: { kind: "once", at: t0 - 1000 },
      enabled: false,
      nextRunAt: null,
      lastTrigger: { at: t0 - 2000, outcome: "launched", runId: "r-old", note: null },
    });
    const runner = makeRunner({ entries: [entry] });
    const outcome = await runner.triggerNow(entry);
    expect(outcome).toBe("missed"); // 调用方映射 409
    expect(entry.lastRunId).toBeNull();
  });
});

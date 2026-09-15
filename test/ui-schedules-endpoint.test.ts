/**
 * T9 定时任务端点契约测试——/api/schedules CRUD + 手动触发。
 *
 * 全用注入的 FakeModelClient + 临时 workdir + AGENT_SCHEDULES_FILE 指向临时
 * 文件（隔离调度持久化），不碰真实仓库根、不需要 API key。
 *
 * 覆盖：
 *   a. GET 空列表 → 200 []
 *   b. POST 创建 interval → 201，GET 列表回读（含 nextRunAt 计算值）
 *   c. POST 校验：task 空 / workdir 不在白名单 / schedule 畸形 / once 时间已过 → 400
 *   d. PATCH：启用/禁用翻转 + 改时间重排 nextRunAt；未知 id → 404
 *   e. DELETE：删除后列表消失；未知 id → 404
 *   f. POST /:id/run：手动触发产出真实 runId（进 /api/runs）；未知 id → 404
 *   g. 持久化：重启宿主（同一文件）后任务仍在
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiServer, type UiServerHandle } from "../ui/server.js";
import { FakeModelClient, fakeMessage, textBlock } from "./helpers.js";

function startServer(handle: UiServerHandle): Promise<number> {
  return new Promise((resolve, reject) => {
    handle.server.listen(0, () => {
      const address = handle.server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("Could not get server port"));
    });
    handle.server.on("error", reject);
  });
}

interface ScheduleDto {
  id: string;
  name: string;
  task: string;
  workdir: string;
  verify: boolean;
  schedule: { kind: string; at?: number; hhmm?: string; everyMs?: number };
  enabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
  lastRunId: string | null;
  nextRunAt: number | null;
  lastTrigger: { at: number; outcome: string; runId: string | null; note: string | null } | null;
  projectId?: string;
}

describe("T9 /api/schedules 端点", () => {
  let handle: UiServerHandle | undefined;
  let dir: string;
  let schedulesFile: string;
  let savedSchedulesEnv: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ui-schedules-api-"));
    schedulesFile = join(dir, ".agent-schedules.json");
    savedSchedulesEnv = process.env.AGENT_SCHEDULES_FILE;
    process.env.AGENT_SCHEDULES_FILE = schedulesFile;
  });

  afterEach(async () => {
    if (savedSchedulesEnv === undefined) delete process.env.AGENT_SCHEDULES_FILE;
    else process.env.AGENT_SCHEDULES_FILE = savedSchedulesEnv;
    await handle?.close();
    handle = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function boot(script = [fakeMessage([textBlock("完成")], "end_turn")]): Promise<string> {
    handle = createUiServer({
      modelClient: new FakeModelClient(script),
      tools: [],
      workdir: dir,
    });
    return `http://127.0.0.1:${await startServer(handle)}`;
  }

  async function createSchedule(
    base: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; data: { schedule?: ScheduleDto; error?: string } }> {
    const res = await fetch(`${base}/api/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as { schedule?: ScheduleDto; error?: string } };
  }

  async function listSchedules(base: string): Promise<ScheduleDto[]> {
    const res = await fetch(`${base}/api/schedules`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { schedules: ScheduleDto[]; serverTime: number };
    expect(typeof body.serverTime).toBe("number");
    return body.schedules;
  }

  const futureOnce = () => Date.now() + 3_600_000;

  it("a. 空列表 → 200 空数组", async () => {
    const base = await boot();
    expect(await listSchedules(base)).toEqual([]);
  });

  it("b. 创建 interval 任务 → 201，列表回读含 nextRunAt", async () => {
    const base = await boot();
    const before = Date.now();
    const created = await createSchedule(base, {
      name: "每日快报",
      task: "整理今天的 AI 新闻",
      verify: true,
      schedule: { kind: "interval", everyMs: 7_200_000 },
    });
    expect(created.status).toBe(201);
    const entry = created.data.schedule!;
    expect(entry.id).toBeTruthy();
    expect(entry.name).toBe("每日快报");
    expect(entry.verify).toBe(true);
    expect(entry.enabled).toBe(true);
    expect(entry.workdir).toBe(dir);
    expect(entry.nextRunAt).toBeGreaterThanOrEqual(before + 7_200_000 - 1000);

    const list = await listSchedules(base);
    expect(list.map((s) => s.id)).toEqual([entry.id]);
    expect(list[0]!.nextRunAt).toBe(entry.nextRunAt);
  });

  it("c. 创建校验：task 空 / workdir 越白名单 / schedule 畸形 / once 已过 → 400", async () => {
    const base = await boot();
    const ok = { task: "x", schedule: { kind: "interval", everyMs: 3_600_000 } };

    const noTask = await createSchedule(base, { schedule: ok.schedule });
    expect(noTask.status).toBe(400);

    const blankTask = await createSchedule(base, { task: "   ", schedule: ok.schedule });
    expect(blankTask.status).toBe(400);

    const badWorkdir = await createSchedule(base, { ...ok, workdir: join(dir, "..", "elsewhere") });
    expect(badWorkdir.status).toBe(400);
    expect(badWorkdir.data.error).toContain("白名单");

    const badSchedule = await createSchedule(base, { task: "x", schedule: { kind: "weekly" } });
    expect(badSchedule.status).toBe(400);

    const badInterval = await createSchedule(base, { task: "x", schedule: { kind: "interval", everyMs: 1000 } });
    expect(badInterval.status).toBe(400);

    const pastOnce = await createSchedule(base, {
      task: "x",
      schedule: { kind: "once", at: Date.now() - 1000 },
    });
    expect(pastOnce.status).toBe(400);
    expect(pastOnce.data.error).toContain("已过");

    // 一个都没建进去
    expect(await listSchedules(base)).toEqual([]);
  });

  it("d. PATCH：禁用/启用翻转、改时间重排；未知 id → 404", async () => {
    const base = await boot();
    const created = await createSchedule(base, {
      task: "x",
      schedule: { kind: "daily", hhmm: "09:30" },
    });
    const id = created.data.schedule!.id;

    // 禁用
    const disable = await fetch(`${base}/api/schedules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disable.status).toBe(200);
    const disabled = ((await disable.json()) as { schedule: ScheduleDto }).schedule;
    expect(disabled.enabled).toBe(false);
    expect(disabled.nextRunAt).toBeNull();

    // 改时间 + 重新启用：nextRunAt 重排到未来
    const repatch = await fetch(`${base}/api/schedules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schedule: { kind: "daily", hhmm: "23:59" }, enabled: true }),
    });
    expect(repatch.status).toBe(200);
    const reEnabled = ((await repatch.json()) as { schedule: ScheduleDto }).schedule;
    expect(reEnabled.enabled).toBe(true);
    expect(reEnabled.schedule).toEqual({ kind: "daily", hhmm: "23:59" });
    expect(reEnabled.nextRunAt).toBeGreaterThan(Date.now());

    // enabled 非布尔 → 400
    const badPatch = await fetch(`${base}/api/schedules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "是" }),
    });
    expect(badPatch.status).toBe(400);

    // 未知 id → 404
    const missing = await fetch(`${base}/api/schedules/nope`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(missing.status).toBe(404);
  });

  it("e. DELETE：删除后列表为空；未知 id → 404", async () => {
    const base = await boot();
    const created = await createSchedule(base, {
      task: "x",
      schedule: { kind: "interval", everyMs: 3_600_000 },
    });
    const id = created.data.schedule!.id;

    const del = await fetch(`${base}/api/schedules/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true);
    expect(await listSchedules(base)).toEqual([]);

    const again = await fetch(`${base}/api/schedules/${id}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  it("f. 手动触发：产出真实 runId 并进 /api/runs；未知 id → 404", async () => {
    const base = await boot();
    const created = await createSchedule(base, {
      name: "手动验证",
      task: "说一句完成",
      schedule: { kind: "once", at: futureOnce() },
    });
    const id = created.data.schedule!.id;

    const fired = await fetch(`${base}/api/schedules/${id}/run`, { method: "POST" });
    expect(fired.status).toBe(200);
    const firedBody = (await fired.json()) as { runId: string; outcome: string };
    expect(firedBody.outcome).toBe("launched");
    expect(firedBody.runId).toBeTruthy();

    // 走与 POST /api/runs 相同的内部入口：列表里能看到这个 run
    const runsRes = await fetch(`${base}/api/runs`);
    const runs = (await runsRes.json()) as { runId: string; task: string }[];
    expect(runs.some((r) => r.runId === firedBody.runId)).toBe(true);

    // once 触发后已终结：再次手动触发 → 409
    const refire = await fetch(`${base}/api/schedules/${id}/run`, { method: "POST" });
    expect(refire.status).toBe(409);

    const missing = await fetch(`${base}/api/schedules/nope/run`, { method: "POST" });
    expect(missing.status).toBe(404);

    // 任务自身记录了触发结果
    const list = await listSchedules(base);
    expect(list[0]!.lastTrigger?.outcome).toBe("launched");
    expect(list[0]!.lastRunId).toBe(firedBody.runId);
    expect(list[0]!.enabled).toBe(false); // once 触发即禁用
  });

  it("g. 持久化：同一文件重启宿主后任务仍在（含 nextRunAt）", async () => {
    const base = await boot();
    const created = await createSchedule(base, {
      name: "跨重启",
      task: "x",
      schedule: { kind: "interval", everyMs: 3_600_000 },
    });
    const id = created.data.schedule!.id;
    // 等落盘链走完再关（close 本身会等 persist chain，这里直接 close）
    await handle?.close();
    handle = undefined;

    const base2 = await boot();
    const list = await listSchedules(base2);
    expect(list.map((s) => s.id)).toEqual([id]);
    expect(list[0]!.name).toBe("跨重启");
    expect(list[0]!.nextRunAt).toBeGreaterThan(0);
  });

  it("h. weekly 规则创建 → 201，nextRunAt 落在未来的指定星期", async () => {
    const base = await boot();
    const created = await createSchedule(base, {
      name: "每周复盘",
      task: "写复盘",
      schedule: { kind: "weekly", days: [5], hhmm: "16:00" },
    });
    expect(created.status).toBe(201);
    expect(created.data.schedule!.schedule).toEqual({ kind: "weekly", days: [5], hhmm: "16:00" });
    expect(created.data.schedule!.nextRunAt).toBeGreaterThan(Date.now());
    const bad = await createSchedule(base, {
      task: "x",
      schedule: { kind: "weekly", days: [7], hhmm: "08:00" },
    });
    expect(bad.status).toBe(400);
  });

  it("i. 创建带 projectId；GET ?projectId= 过滤；未知项目 / 目录不属于项目 → 400", async () => {
    const extra = join(dir, "extra");
    await mkdir(extra, { recursive: true });
    await handle?.close();
    handle = undefined;
    handle = createUiServer({
      modelClient: new FakeModelClient([fakeMessage([textBlock("完成")], "end_turn")]),
      tools: [],
      workdir: dir,
      workdirs: [extra],
    });
    const base = `http://127.0.0.1:${await startServer(handle)}`;

    const p1 = await (await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "甲", workdirs: [dir] }),
    })).json() as { project: { id: string } };
    const p2 = await (await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "乙", workdirs: [extra] }),
    })).json() as { project: { id: string } };

    const a = await createSchedule(base, {
      name: "甲的简报",
      task: "甲",
      projectId: p1.project.id,
      schedule: { kind: "weekly", days: [1, 2, 3, 4, 5], hhmm: "08:00" },
    });
    expect(a.status).toBe(201);
    expect(a.data.schedule!.projectId).toBe(p1.project.id);
    expect(a.data.schedule!.workdir).toBe(dir);

    const b = await createSchedule(base, {
      name: "乙的简报",
      task: "乙",
      projectId: p2.project.id,
      schedule: { kind: "daily", hhmm: "09:00" },
    });
    expect(b.status).toBe(201);

    const unknown = await createSchedule(base, {
      task: "x",
      projectId: "no-such-project",
      schedule: { kind: "daily", hhmm: "09:00" },
    });
    expect(unknown.status).toBe(400);

    const outsider = await createSchedule(base, {
      task: "x",
      projectId: p1.project.id,
      workdir: extra,
      schedule: { kind: "daily", hhmm: "09:00" },
    });
    expect(outsider.status).toBe(400);
    expect(outsider.data.error).toContain("不属于项目");

    const filtered = await (await fetch(`${base}/api/schedules?projectId=${encodeURIComponent(p1.project.id)}`)).json() as {
      schedules: ScheduleDto[];
    };
    expect(filtered.schedules.map((s) => s.name)).toEqual(["甲的简报"]);

    const all = await listSchedules(base);
    expect(all.map((s) => s.name).sort()).toEqual(["乙的简报", "甲的简报"]);
  });

  it("j. 手动触发带 projectId 的任务：run 继承项目", async () => {
    const base = await boot();
    const createdProject = await (await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "看板", workdirs: [dir] }),
    })).json() as { project: { id: string } };
    const created = await createSchedule(base, {
      name: "项目里的定时",
      task: "说一句完成",
      projectId: createdProject.project.id,
      schedule: { kind: "once", at: futureOnce() },
    });
    const id = created.data.schedule!.id;
    const fired = await fetch(`${base}/api/schedules/${id}/run`, { method: "POST" });
    expect(fired.status).toBe(200);
    const { runId } = (await fired.json()) as { runId: string };
    const runs = await (await fetch(`${base}/api/runs`)).json() as { runId: string; projectId?: string }[];
    expect(runs.find((r) => r.runId === runId)?.projectId).toBe(createdProject.project.id);
  });
});

// @vitest-environment jsdom
// @ts-nocheck
/**
 * 定时任务视图（features/schedules.js）的回归锁——T9。
 *
 * 分层覆盖：
 *   纯函数层：调度规则人话 / 倒计时 / 上次触发文案 / 表单载荷构造与校验 / 路由判定
 *   DOM 层  ：jsdom 里真实初始化（fetchFn/confirmFn 注入），验证列表渲染、
 *             人话规则、空态、表单提交、开关切换、立即运行、删除确认
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  SCHEDULES_HASH,
  MIN_INTERVAL_MS,
  isSchedulesRoute,
  describeSchedule,
  countdownText,
  lastTriggerLabel,
  summarizeTask,
  buildCreatePayload,
  initSchedulesView,
} from "../ui/public/features/schedules.js";

// ---------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------
describe("调度规则人话", () => {
  it("once：一次性 · 9月6日 08:00（跨年补年份）", () => {
    const at = new Date(2026, 8, 6, 8, 0).getTime();
    expect(describeSchedule({ kind: "once", at }, new Date(2026, 8, 1).getTime()))
      .toBe("一次性 · 9月6日 08:00");
    expect(describeSchedule({ kind: "once", at }, new Date(2025, 11, 1).getTime()))
      .toBe("一次性 · 2026年9月6日 08:00");
  });

  it("daily / interval", () => {
    expect(describeSchedule({ kind: "daily", hhmm: "09:30" })).toBe("每天 09:30");
    expect(describeSchedule({ kind: "interval", everyMs: 7_200_000 })).toBe("每 2 小时");
    expect(describeSchedule({ kind: "interval", everyMs: 1_800_000 })).toBe("每 30 分钟");
    expect(describeSchedule({ kind: "interval", everyMs: 90_000 })).toBe("每 90 秒");
  });

  it("畸形输入回未知规则", () => {
    expect(describeSchedule(null)).toBe("未知规则");
    expect(describeSchedule({ kind: "weekly" })).toBe("未知规则");
  });
});

describe("倒计时与状态文案", () => {
  const now = 1_000_000_000_000;

  it("countdownText：分钟 / 小时 / 天 / 到期 / 无", () => {
    expect(countdownText(null, now)).toBe("—");
    expect(countdownText(now - 1, now)).toBe("即将运行");
    expect(countdownText(now + 5 * 60_000, now)).toBe("5 分钟后");
    expect(countdownText(now + 2 * 3_600_000, now)).toBe("2 小时后");
    expect(countdownText(now + 2.5 * 3_600_000, now)).toBe("2 小时 30 分钟后");
    expect(countdownText(now + 26 * 3_600_000, now)).toBe("1 天 2 小时后");
  });

  it("lastTriggerLabel：四种结局 + 未运行", () => {
    expect(lastTriggerLabel({ lastTrigger: null, enabled: true }).text).toBe("等待首次运行");
    expect(lastTriggerLabel({ lastTrigger: { outcome: "launched" } }).tone).toBe("ok");
    expect(lastTriggerLabel({ lastTrigger: { outcome: "skipped" } }).text).toContain("跳过");
    expect(lastTriggerLabel({ lastTrigger: { outcome: "missed" } }).text).toContain("错过");
    expect(lastTriggerLabel({ lastTrigger: { outcome: "error", note: "容量已满" } }).text)
      .toBe("启动失败：容量已满");
  });

  it("summarizeTask：取首行、超长省略", () => {
    expect(summarizeTask("第一行\n第二行")).toBe("第一行");
    expect(summarizeTask("x".repeat(100))).toBe(`${"x".repeat(60)}…`);
  });
});

describe("buildCreatePayload 表单预校验", () => {
  it("任务描述为空 / 工作目录为空 / 未选类型 → 拒绝", () => {
    expect(buildCreatePayload({ task: " ", workdir: "/w", kind: "daily", dailyHhmm: "08:00" }).ok).toBe(false);
    expect(buildCreatePayload({ task: "x", workdir: "", kind: "daily", dailyHhmm: "08:00" }).ok).toBe(false);
    expect(buildCreatePayload({ task: "x", workdir: "/w" }).ok).toBe(false);
  });

  it("once：时间缺失或已过 → 拒绝；未来时刻 → 通过", () => {
    expect(buildCreatePayload({ task: "x", workdir: "/w", kind: "once", onceAtMs: null }).ok).toBe(false);
    expect(buildCreatePayload({ task: "x", workdir: "/w", kind: "once", onceAtMs: Date.now() - 1000 }).ok).toBe(false);
    const at = Date.now() + 3_600_000;
    const built = buildCreatePayload({ task: "x", workdir: "/w", kind: "once", onceAtMs: at, verify: true });
    expect(built.ok).toBe(true);
    expect(built.payload.schedule).toEqual({ kind: "once", at });
    expect(built.payload.verify).toBe(true);
  });

  it("daily：HH:MM 畸形 → 拒绝", () => {
    expect(buildCreatePayload({ task: "x", workdir: "/w", kind: "daily", dailyHhmm: "25:00" }).ok).toBe(false);
    const built = buildCreatePayload({ task: "x", workdir: "/w", kind: "daily", dailyHhmm: "07:15" });
    expect(built.payload.schedule).toEqual({ kind: "daily", hhmm: "07:15" });
  });

  it("interval：非正数 / 低于 1 分钟下限 → 拒绝；小时转毫秒", () => {
    expect(buildCreatePayload({ task: "x", workdir: "/w", kind: "interval", intervalHours: "0" }).ok).toBe(false);
    expect(buildCreatePayload({ task: "x", workdir: "/w", kind: "interval", intervalHours: "abc" }).ok).toBe(false);
    const built = buildCreatePayload({ task: "x", workdir: "/w", kind: "interval", intervalHours: "2" });
    expect(built.payload.schedule).toEqual({ kind: "interval", everyMs: 2 * 3_600_000 });
    expect(built.payload.schedule.everyMs).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
  });
});

describe("路由判定", () => {
  it("仅认 #/schedules", () => {
    expect(isSchedulesRoute(SCHEDULES_HASH)).toBe(true);
    expect(isSchedulesRoute("#/settings")).toBe(false);
    expect(isSchedulesRoute("")).toBe(false);
    expect(isSchedulesRoute(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------
// DOM 层
// ---------------------------------------------------------------
function fakeEntry(overrides = {}) {
  return {
    id: "s-1",
    name: "每日快报",
    task: "整理今天的 AI 新闻，写入 daily.md",
    workdir: "/work",
    verify: false,
    schedule: { kind: "daily", hhmm: "09:30" },
    enabled: true,
    createdAt: 1_000,
    lastRunAt: null,
    lastRunId: null,
    nextRunAt: 1_000_000_000_000,
    lastTrigger: null,
    ...overrides,
  };
}

/** 可编程的假 fetch：按 path+method 路由到应答表 */
function makeFetch(routes) {
  const calls = [];
  const fetchFn = async (path, opts = {}) => {
    const method = opts.method ?? "GET";
    calls.push({ path, method, body: opts.body ? JSON.parse(opts.body) : null });
    const key = `${method} ${path}`;
    for (const [pattern, responder] of Object.entries(routes)) {
      if (key === pattern || (pattern.endsWith("*") && key.startsWith(pattern.slice(0, -1)))) {
        const out = responder({ path, method, body: calls[calls.length - 1].body });
        return { status: out.status ?? 200, json: async () => out.data };
      }
    }
    return { status: 404, json: async () => ({ error: "not found" }) };
  };
  return { fetchFn, calls };
}

function bootDom({ routes, confirmFn, host = {} } = {}) {
  document.body.innerHTML = '<div id="main-panel"></div><button id="schedules-open-btn"></button>';
  const { fetchFn, calls } = makeFetch(routes ?? {
    "GET /api/schedules": () => ({ data: { schedules: [], serverTime: 1_000 } }),
  });
  const api = initSchedulesView(
    {
      getHarnessSnapshot: () => ({ workdir: "/work", availableWorkdirs: ["/work", "/work/alt"] }),
      onAnnounce: host.onAnnounce,
      onOpenRun: host.onOpenRun,
      onOpenSchedules: host.onOpenSchedules,
      onCloseSchedules: host.onCloseSchedules,
    },
    { doc: document, win: window, fetchFn, confirmFn: confirmFn ?? (() => true), refreshMs: 0 },
  );
  return { api, calls, el: document.getElementById("schedules-view") };
}

describe("定时任务视图 DOM", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("空态：无任务时显示引导文案", async () => {
    const { api, el } = bootDom();
    api.open();
    await new Promise((r) => setTimeout(r, 0));
    const empty = el.querySelector(".schedules-empty");
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toContain("还没有定时任务——让 Agent 每天定时帮你干活");
  });

  it("列表渲染：名称 / 摘要 / 人话规则 / 倒计时 / 启用开关", async () => {
    const { api, el } = bootDom({
      routes: {
        "GET /api/schedules": () => ({
          data: { schedules: [fakeEntry()], serverTime: 1_000_000_000_000 - 30 * 60_000 },
        }),
      },
    });
    api.open();
    await new Promise((r) => setTimeout(r, 0));
    const card = el.querySelector(".schedule-card");
    expect(card).not.toBeNull();
    expect(card.querySelector(".schedule-card-name").textContent).toBe("每日快报");
    expect(card.querySelector(".schedule-card-task").textContent).toContain("整理今天的 AI 新闻");
    expect(card.querySelector(".schedule-card-rule").textContent).toContain("每天 09:30");
    expect(card.querySelector(".schedule-card-next").textContent).toContain("30 分钟后");
    expect(card.querySelector(".schedule-card-last").textContent).toContain("等待首次运行");
    expect(card.querySelector(".schedule-card-toggle input").checked).toBe(true);
    expect(el.querySelector(".schedules-empty").hidden).toBe(true);
  });

  it("上次运行可点击跳转 onOpenRun", async () => {
    const opened = [];
    const { api, el } = bootDom({
      host: { onOpenRun: (id) => opened.push(id) },
      routes: {
        "GET /api/schedules": () => ({
          data: {
            schedules: [fakeEntry({
              lastRunId: "run-9",
              lastTrigger: { at: 1, outcome: "launched", runId: "run-9", note: null },
            })],
            serverTime: 1_000,
          },
        }),
      },
    });
    api.open();
    await new Promise((r) => setTimeout(r, 0));
    const link = el.querySelector(".schedule-card-last-link");
    expect(link.textContent).toContain("已启动");
    link.click();
    expect(opened).toEqual(["run-9"]);
  });

  it("表单提交：构造正确载荷 POST /api/schedules，成功后收起并刷新", async () => {
    let created = null;
    const { api, el, calls } = bootDom({
      routes: {
        "GET /api/schedules": () => ({
          data: { schedules: created ? [created] : [], serverTime: 1_000 },
        }),
        "POST /api/schedules": ({ body }) => {
          created = fakeEntry({ id: "s-new", name: body.name || "x", schedule: body.schedule });
          return { status: 201, data: { schedule: created } };
        },
      },
    });
    api.open();
    await new Promise((r) => setTimeout(r, 0));
    el.querySelector("#schedules-new-btn").click();
    const form = el.querySelector("#schedules-form");
    expect(form.hidden).toBe(false);
    // 工作目录下拉来自 harness 快照白名单
    const select = el.querySelector("#schedules-form-workdir");
    expect([...select.options].map((o) => o.value)).toEqual(["/work", "/work/alt"]);

    el.querySelector("#schedules-form-name").value = "晨间巡检";
    el.querySelector("#schedules-form-task").value = "检查服务状态";
    const dailyRadio = form.querySelector('input[name="schedules-kind"][value="daily"]');
    dailyRadio.checked = true;
    dailyRadio.dispatchEvent(new window.Event("change", { bubbles: true }));
    el.querySelector("#schedules-form-daily").value = "08:15";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const post = calls.find((c) => c.method === "POST" && c.path === "/api/schedules");
    expect(post.body).toEqual({
      name: "晨间巡检",
      task: "检查服务状态",
      workdir: "/work",
      verify: false,
      schedule: { kind: "daily", hhmm: "08:15" },
    });
    expect(form.hidden).toBe(true);
    expect(el.querySelectorAll(".schedule-card").length).toBe(1);
  });

  it("表单校验失败：就地报错，不发请求", async () => {
    const { api, el, calls } = bootDom();
    api.open();
    await new Promise((r) => setTimeout(r, 0));
    el.querySelector("#schedules-new-btn").click();
    const form = el.querySelector("#schedules-form");
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    const err = el.querySelector("#schedules-form-error");
    expect(err.hidden).toBe(false);
    expect(err.textContent).toContain("任务描述不能为空");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("启用开关：PATCH enabled=false", async () => {
    const { api, el, calls } = bootDom({
      routes: {
        "GET /api/schedules": () => ({ data: { schedules: [fakeEntry()], serverTime: 1_000 } }),
        "PATCH /api/schedules/s-1": ({ body }) => ({ data: { schedule: fakeEntry({ enabled: body.enabled }) } }),
      },
    });
    api.open();
    await new Promise((r) => setTimeout(r, 0));
    const toggle = el.querySelector(".schedule-card-toggle input");
    toggle.checked = false;
    toggle.dispatchEvent(new window.Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch.path).toBe("/api/schedules/s-1");
    expect(patch.body).toEqual({ enabled: false });
  });

  it("立即运行：POST /run 成功后跳转到新 run", async () => {
    const opened = [];
    const { api, el, calls } = bootDom({
      host: { onOpenRun: (id) => opened.push(id) },
      routes: {
        "GET /api/schedules": () => ({ data: { schedules: [fakeEntry()], serverTime: 1_000 } }),
        "POST /api/schedules/s-1/run": () => ({ data: { runId: "run-new", outcome: "launched" } }),
      },
    });
    api.open();
    await new Promise((r) => setTimeout(r, 0));
    el.querySelector(".schedule-card-run").click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/schedules/s-1/run")).toBe(true);
    expect(opened).toEqual(["run-new"]);
  });

  it("删除：需确认；取消不发请求，确认后 DELETE", async () => {
    let deleted = false;
    let confirmAsked = 0;
    const { api, el, calls } = bootDom({
      confirmFn: () => { confirmAsked += 1; return deleted ? true : false; },
      routes: {
        "GET /api/schedules": () => ({
          data: { schedules: deleted ? [] : [fakeEntry()], serverTime: 1_000 },
        }),
        "DELETE /api/schedules/s-1": () => ({ data: { deleted: true } }),
      },
    });
    api.open();
    await new Promise((r) => setTimeout(r, 0));

    // 第一次：取消
    el.querySelector(".schedule-card-delete").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(confirmAsked).toBe(1);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    // 第二次：确认
    deleted = true;
    el.querySelector(".schedule-card-delete").click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/schedules/s-1")).toBe(true);
    // 删完回到空态
    expect(el.querySelector(".schedules-empty").hidden).toBe(false);
  });

  it("侧栏入口按钮触发 onOpenSchedules；返回触发 onCloseSchedules", async () => {
    const events = [];
    const { api, el } = bootDom({
      host: {
        onOpenSchedules: () => events.push("open"),
        onCloseSchedules: () => events.push("close"),
      },
    });
    document.getElementById("schedules-open-btn").click();
    api.open();
    await new Promise((r) => setTimeout(r, 0));
    el.querySelector(".schedules-back").click();
    expect(events).toEqual(["open", "close"]);
  });
});

// @vitest-environment jsdom
// @ts-nocheck
/**
 * 运行指挥中心（features/command-center.js）的回归锁——T11。
 *
 * 分层覆盖：
 *   纯函数层：路由判定 / 时长格式化 / 同日判定 / 工具入参摘要 / 进度派生 /
 *             三栏归约（待决→栏一、running→栏二、24h 内 done→栏三）/
 *             排序纪律 / 统计条计数（含今日完成）/ 空态判定
 *   DOM 层  ：jsdom 里真实初始化，验证统计条渲染、三栏卡片、待决卡点击直达
 *             action-dock 回调、运行卡停止按钮派发、完成卡点击跳会话、
 *             空态与新建任务入口、refresh 只在打开时重渲染
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  COMMAND_CENTER_HASH,
  RECENT_WINDOW_MS,
  FINISHED_LIMIT,
  DECISION_KIND_META,
  isCommandCenterRoute,
  formatElapsed,
  sameLocalDay,
  summarizeToolInput,
  deriveRunProgress,
  deriveBoardModel,
  initCommandCenterView,
} from "../ui/public/features/command-center.js";
import {
  createNotificationStore,
  applyRunEventToStore,
} from "../ui/public/features/notifications.js";

const NOW = 1_700_000_000_000; // 固定时刻：本地时区无关的派生都以此为准

/** 造一条 run 列表项 */
function run(partial) {
  return {
    runId: "r1",
    task: "任务",
    status: "running",
    createdAt: NOW - 60_000,
    finishedAt: null,
    stopReason: null,
    ...partial,
  };
}

/** 造一条通知中心待决条目（与 notifications.js 产出的形状一致） */
function decisionItem(partial = {}) {
  return {
    id: "ap:r1:t1#1",
    runId: "r1",
    runTitle: "修复登录页",
    kind: "approval",
    category: "decision",
    label: "审批待决",
    detail: "bash",
    at: NOW - 5 * 60_000,
    read: false,
    pending: true,
    durationMs: null,
    ...partial,
  };
}

// ---------------------------------------------------------------
// 路由判定
// ---------------------------------------------------------------
describe("isCommandCenterRoute 路由判定", () => {
  it("#/board 命中，其余不命中", () => {
    expect(isCommandCenterRoute("#/board")).toBe(true);
    expect(isCommandCenterRoute("#/settings")).toBe(false);
    expect(isCommandCenterRoute("#/run/abc/loop")).toBe(false);
    expect(isCommandCenterRoute("")).toBe(false);
    expect(isCommandCenterRoute(null)).toBe(false);
  });
  it("hash 常量与判定自洽", () => {
    expect(COMMAND_CENTER_HASH).toBe("#/board");
    expect(isCommandCenterRoute(COMMAND_CENTER_HASH)).toBe(true);
  });
});

// ---------------------------------------------------------------
// 时长格式化
// ---------------------------------------------------------------
describe("formatElapsed 时长格式化", () => {
  it("分档：秒/分钟/小时/天", () => {
    expect(formatElapsed(0)).toBe("不到 1 分钟");
    expect(formatElapsed(59_000)).toBe("不到 1 分钟");
    expect(formatElapsed(60_000)).toBe("1 分钟");
    expect(formatElapsed(5 * 60_000)).toBe("5 分钟");
    expect(formatElapsed(60 * 60_000)).toBe("1 小时");
    expect(formatElapsed(90 * 60_000)).toBe("1 小时 30 分钟");
    expect(formatElapsed(24 * 60 * 60_000)).toBe("1 天");
    expect(formatElapsed(26 * 60 * 60_000)).toBe("1 天 2 小时");
  });
  it("负数与非数兜底为 0", () => {
    expect(formatElapsed(-100)).toBe("不到 1 分钟");
    expect(formatElapsed(null)).toBe("不到 1 分钟");
    expect(formatElapsed(undefined)).toBe("不到 1 分钟");
  });
});

describe("sameLocalDay 同日判定", () => {
  it("同一日历日为真，跨日为假", () => {
    const morning = new Date(2026, 0, 15, 8, 0, 0).getTime();
    const evening = new Date(2026, 0, 15, 23, 59, 0).getTime();
    const nextDay = new Date(2026, 0, 16, 0, 1, 0).getTime();
    expect(sameLocalDay(morning, evening)).toBe(true);
    expect(sameLocalDay(evening, nextDay)).toBe(false);
  });
});

// ---------------------------------------------------------------
// 工具入参摘要 / 进度派生
// ---------------------------------------------------------------
describe("summarizeToolInput 工具入参摘要", () => {
  it("优先取 command / path / query 等辨识字段", () => {
    expect(summarizeToolInput({ command: "npm test" })).toBe("npm test");
    expect(summarizeToolInput({ path: "src/a.ts", other: 1 })).toBe("src/a.ts");
    expect(summarizeToolInput({ query: "agent loop" })).toBe("agent loop");
  });
  it("没有辨识字段时取第一个字符串值；非对象给空串", () => {
    expect(summarizeToolInput({ foo: "bar baz" })).toBe("bar baz");
    expect(summarizeToolInput(null)).toBe("");
    expect(summarizeToolInput(42)).toBe("");
    expect(summarizeToolInput({ n: 1 })).toBe("");
  });
  it("超长截断并压掉换行", () => {
    const long = summarizeToolInput({ command: "echo " + "x".repeat(100) + "\n第二行" });
    expect(long.length).toBeLessThanOrEqual(49); // 48 + 省略号
    expect(long).not.toContain("\n");
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("deriveRunProgress 运行进度派生", () => {
  it("取最后一次 turn_start 与最后一次 tool_call", () => {
    const state = {
      timeline: [
        { type: "turn_start", turn: 1 },
        { type: "tool_call", name: "read_file", input: { path: "a.ts" } },
        { type: "turn_start", turn: 2 },
        { type: "tool_call", name: "bash", input: { command: "npm test" } },
        { type: "tool_running" },
      ],
    };
    expect(deriveRunProgress(state)).toEqual({
      turn: 2,
      lastTool: { name: "bash", summary: "npm test" },
    });
  });
  it("state 缺失 / 无相关条目时降级为 null", () => {
    expect(deriveRunProgress(null)).toEqual({ turn: null, lastTool: null });
    expect(deriveRunProgress({ timeline: [] })).toEqual({ turn: null, lastTool: null });
    expect(deriveRunProgress({})).toEqual({ turn: null, lastTool: null });
  });
});

// ---------------------------------------------------------------
// 三栏归约（核心纯函数）
// ---------------------------------------------------------------
describe("deriveBoardModel 三栏归约", () => {
  it("待决条目进「待你决定」，带等待时长与类型徽章", () => {
    const model = deriveBoardModel({
      runs: [run({})],
      decisionItems: [decisionItem()],
      now: NOW,
    });
    expect(model.columns.decision).toHaveLength(1);
    const card = model.columns.decision[0];
    expect(card.runId).toBe("r1");
    expect(card.kindLabel).toBe("审批待决");
    expect(card.waitingMs).toBe(5 * 60_000);
    expect(card.title).toBe("任务"); // 标题以 run 列表为准（runTitle 只是快照）
  });

  it("待决排序：等待最久的排最前；只收 category=decision", () => {
    const model = deriveBoardModel({
      runs: [],
      decisionItems: [
        decisionItem({ id: "a", at: NOW - 60_000 }),
        decisionItem({ id: "b", at: NOW - 600_000, kind: "question" }),
        decisionItem({ id: "c", category: "finished", at: NOW - 999_000 }),
      ],
      now: NOW,
    });
    expect(model.columns.decision.map((c) => c.id)).toEqual(["b", "a"]);
    expect(model.columns.decision[0].kindLabel).toBe("提问待答");
  });

  it("run 已删除时标题退回条目快照", () => {
    const model = deriveBoardModel({
      runs: [],
      decisionItems: [decisionItem()],
      now: NOW,
    });
    expect(model.columns.decision[0].title).toBe("修复登录页");
  });

  it("running 进「运行中」，带轮数/耗时/最近工具", () => {
    const states = new Map([
      ["r1", { timeline: [{ type: "turn_start", turn: 3 }, { type: "tool_call", name: "bash", input: { command: "ls" } }] }],
    ]);
    const model = deriveBoardModel({
      runs: [run({})],
      getState: (id) => states.get(id) ?? null,
      now: NOW,
    });
    expect(model.columns.running).toHaveLength(1);
    const card = model.columns.running[0];
    expect(card.turn).toBe(3);
    expect(card.elapsedMs).toBe(60_000);
    expect(card.lastTool).toEqual({ name: "bash", summary: "ls" });
  });

  it("运行中排序：跑得最久的排最前", () => {
    const model = deriveBoardModel({
      runs: [
        run({ runId: "r1", createdAt: NOW - 60_000 }),
        run({ runId: "r2", createdAt: NOW - 600_000 }),
      ],
      now: NOW,
    });
    expect(model.columns.running.map((c) => c.runId)).toEqual(["r2", "r1"]);
  });

  it("24h 内 done 进「最近完成」并按终止原因分档；窗外与无 finishedAt 的不进", () => {
    const model = deriveBoardModel({
      runs: [
        run({ runId: "ok", status: "done", finishedAt: NOW - 60_000, stopReason: "completed" }),
        run({ runId: "bad", status: "done", finishedAt: NOW - 120_000, stopReason: "max_turns" }),
        run({ runId: "stop", status: "done", finishedAt: NOW - 180_000, stopReason: "aborted" }),
        run({ runId: "old", status: "done", finishedAt: NOW - RECENT_WINDOW_MS - 1 }),
        run({ runId: "nofin", status: "done", finishedAt: null }),
      ],
      now: NOW,
    });
    const ids = model.columns.finished.map((c) => c.runId);
    expect(ids).toEqual(["ok", "bad", "stop"]);
    const tiers = Object.fromEntries(model.columns.finished.map((c) => [c.runId, c.tier]));
    expect(tiers).toEqual({ ok: "完成", bad: "未通过", stop: "被停止" });
  });

  it("最近完成按收尾时间倒序，超出上限裁最旧的", () => {
    const runs = [];
    for (let i = 0; i < FINISHED_LIMIT + 5; i++) {
      runs.push(run({ runId: `f${i}`, status: "done", finishedAt: NOW - i * 60_000 }));
    }
    const model = deriveBoardModel({ runs, now: NOW });
    expect(model.columns.finished).toHaveLength(FINISHED_LIMIT);
    expect(model.columns.finished[0].runId).toBe("f0");
    expect(model.columns.finished.at(-1).runId).toBe(`f${FINISHED_LIMIT - 1}`);
  });

  it("统计条：运行中 N · 待决定 M · 今日完成 K（今日按本地日历日，不看 24h 窗）", () => {
    const todayDone = new Date(NOW);
    todayDone.setHours(0, 30, 0, 0); // 今天凌晨：若 NOW 在当天 0:30 之后，这算今日完成
    const model = deriveBoardModel({
      runs: [
        run({ runId: "run1" }),
        run({ runId: "run2" }),
        run({ runId: "done1", status: "done", finishedAt: NOW - 60_000 }),
      ],
      decisionItems: [decisionItem({ id: "a" }), decisionItem({ id: "b", kind: "question" })],
      now: NOW,
    });
    expect(model.stats).toEqual({ running: 2, deciding: 2, doneToday: 1 });
    // 昨天完成的只进 24h 栏，不算「今日完成」
    const yesterday = new Date(NOW);
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(23, 0, 0, 0);
    const m2 = deriveBoardModel({
      runs: [run({ runId: "d", status: "done", finishedAt: yesterday.getTime() })],
      now: NOW,
    });
    expect(m2.stats.doneToday).toBe(0);
    expect(m2.columns.finished).toHaveLength(1); // 仍在 24h 窗内
    void todayDone;
  });

  it("空态：三栏全空时 empty=true；任一栏有卡则为 false", () => {
    expect(deriveBoardModel({ runs: [], decisionItems: [], now: NOW }).empty).toBe(true);
    expect(deriveBoardModel({ runs: [run({})], now: NOW }).empty).toBe(false);
    expect(deriveBoardModel({ runs: [], decisionItems: [decisionItem()], now: NOW }).empty).toBe(false);
  });
});

// ---------------------------------------------------------------
// 与通知中心同源：真实 store 事件流喂出来的待决条目直接可消费
// ---------------------------------------------------------------
describe("与 notifications.js 同源集成", () => {
  it("applyRunEventToStore 产出的待决条目可直接归约进待决栏", () => {
    let store = createNotificationStore();
    store = applyRunEventToStore(store, {
      runId: "r1",
      runTitle: "修复登录页",
      seq: 7,
      source: "main",
      event: { type: "approval_request", toolUseId: "t1", name: "bash", at: NOW - 120_000 },
      now: NOW,
    }).store;
    store = applyRunEventToStore(store, {
      runId: "r2",
      runTitle: "写周报",
      seq: 3,
      source: "main",
      event: { type: "plan_approval_request", at: NOW - 30_000 },
      now: NOW,
    }).store;
    const model = deriveBoardModel({
      runs: [run({ runId: "r1", task: "修复登录页" }), run({ runId: "r2", task: "写周报" })],
      decisionItems: store.items,
      now: NOW,
    });
    expect(model.stats.deciding).toBe(2);
    expect(model.columns.decision[0].kindLabel).toBe("审批待决"); // 等更久的排前
    expect(model.columns.decision[1].kindLabel).toBe("计划待签发");
    // verifier 来源的审批不进待决栏（同 notifications 口径）
    const withVerifier = applyRunEventToStore(store, {
      runId: "r1",
      runTitle: "修复登录页",
      seq: 8,
      source: "verifier",
      event: { type: "approval_request", toolUseId: "t9", name: "bash", at: NOW },
      now: NOW,
    }).store;
    const m2 = deriveBoardModel({ runs: [], decisionItems: withVerifier.items, now: NOW });
    expect(m2.stats.deciding).toBe(2);
  });
});

// ---------------------------------------------------------------
// DOM 层
// ---------------------------------------------------------------
describe("initCommandCenterView DOM 层", () => {
  let host;
  let runs;
  let decisionItems;
  let states;
  let clock;

  function mount(extraHost = {}) {
    document.body.innerHTML = `
      <aside><button type="button" id="board-open-btn">指挥中心</button></aside>
      <main id="main-panel"><div id="action-dock"></div></main>
    `;
    const calls = { openConv: [], revealDock: [], stop: [], announce: [], newChat: 0, close: 0, open: 0 };
    host = {
      getRuns: () => runs,
      getRunState: (id) => states.get(id) ?? null,
      getDecisionItems: () => decisionItems,
      isStopping: (id) => id === "stopping-run",
      onOpenBoard: () => { calls.open++; },
      onCloseBoard: () => { calls.close++; },
      onOpenConversation: (id) => calls.openConv.push(id),
      onRevealDock: (id) => calls.revealDock.push(id),
      onStopRun: (id) => calls.stop.push(id),
      onNewChat: () => { calls.newChat++; },
      onAnnounce: (m) => calls.announce.push(m),
      ...extraHost,
    };
    const api = initCommandCenterView(host, { now: () => clock });
    return { api, calls };
  }

  beforeEach(() => {
    runs = [];
    decisionItems = [];
    states = new Map();
    clock = NOW;
  });

  it("初始化幂等且骨架就位：三栏 + 统计条 + 空态", () => {
    const { api } = mount();
    expect(api.isOpen()).toBe(false);
    const view = document.getElementById("command-center-view");
    expect(view).toBeTruthy();
    expect(view.hidden).toBe(true);
    expect(view.querySelectorAll(".cc-column")).toHaveLength(3);
    expect(view.querySelectorAll(".cc-stat")).toHaveLength(3);
    // 再次 init 返回薄壳，不重复挂载
    const again = initCommandCenterView(host, { now: () => clock });
    expect(document.querySelectorAll("#command-center-view")).toHaveLength(1);
    expect(again.element).toBe(view);
  });

  it("打开后统计条与三栏卡片渲染；待决定>0 时统计染热", () => {
    runs = [
      run({ runId: "run1", task: "跑测试" }),
      run({ runId: "done1", task: "写文档", status: "done", finishedAt: NOW - 60_000, stopReason: "completed" }),
    ];
    decisionItems = [decisionItem()];
    states.set("run1", { timeline: [{ type: "turn_start", turn: 4 }, { type: "tool_call", name: "bash", input: { command: "npm test" } }] });
    const { api } = mount();
    api.open();
    expect(api.isOpen()).toBe(true);
    const view = api.element;
    expect(view.hidden).toBe(false);
    expect(view.querySelector('[data-stat="running"] .cc-stat-num').textContent).toBe("1");
    expect(view.querySelector('[data-stat="deciding"] .cc-stat-num').textContent).toBe("1");
    expect(view.querySelector('[data-stat="doneToday"] .cc-stat-num').textContent).toBe("1");
    expect(view.querySelector('[data-stat="deciding"]').classList.contains("cc-stat--hot")).toBe(true);

    const decCol = view.querySelector('[data-col="decision"]');
    expect(decCol.querySelectorAll(".cc-card")).toHaveLength(1);
    expect(decCol.textContent).toContain("审批待决");
    expect(decCol.textContent).toContain("已等待 5 分钟");

    const runCol = view.querySelector('[data-col="running"]');
    expect(runCol.textContent).toContain("第 4 轮");
    expect(runCol.textContent).toContain("已耗时 1 分钟");
    expect(runCol.textContent).toContain("最近：bash · npm test");

    const finCol = view.querySelector('[data-col="finished"]');
    expect(finCol.textContent).toContain("写文档");
    expect(finCol.querySelector(".cc-badge").textContent).toBe("完成");
  });

  it("待决卡点击 → onRevealDock 直达（缺省退化为跳会话）", () => {
    decisionItems = [decisionItem()];
    const { api, calls } = mount();
    api.open();
    api.element.querySelector('[data-col="decision"] .cc-card').click();
    expect(calls.revealDock).toEqual(["r1"]);
    expect(calls.openConv).toEqual([]);

    // 无 onRevealDock 的宿主：退化为 onOpenConversation
    document.body.innerHTML = `<main id="main-panel"></main>`;
    const plain = initCommandCenterView(
      {
        getRuns: () => [],
        getDecisionItems: () => [decisionItem()],
        onOpenConversation: (id) => calls.openConv.push(id),
      },
      { now: () => clock },
    );
    plain.open();
    plain.element.querySelector('[data-col="decision"] .cc-card').click();
    expect(calls.openConv).toEqual(["r1"]);
  });

  it("运行卡：打开区点击跳会话；停止按钮走 onStopRun 且不冒泡成跳转", () => {
    runs = [run({ runId: "run1", task: "跑测试" })];
    const { api, calls } = mount();
    api.open();
    const card = api.element.querySelector('[data-col="running"] .cc-card');
    card.querySelector(".cc-stop-btn").click();
    expect(calls.stop).toEqual(["run1"]);
    expect(calls.openConv).toEqual([]); // 停止不触发跳转
    card.querySelector(".cc-card-open").click();
    expect(calls.openConv).toEqual(["run1"]);
  });

  it("停止中的 run：按钮置灰并显示「停止中…」", () => {
    runs = [run({ runId: "stopping-run", task: "长跑任务" })];
    const { api } = mount();
    api.open();
    const stopBtn = api.element.querySelector('[data-col="running"] .cc-stop-btn');
    expect(stopBtn.disabled).toBe(true);
    expect(stopBtn.textContent).toContain("停止中…");
  });

  it("完成卡点击跳会话；未通过/被停止徽章分档", () => {
    runs = [
      run({ runId: "bad", task: "失败任务", status: "done", finishedAt: NOW - 60_000, stopReason: "max_turns" }),
      run({ runId: "stop", task: "被停任务", status: "done", finishedAt: NOW - 120_000, stopReason: "aborted" }),
    ];
    const { api, calls } = mount();
    api.open();
    const cards = [...api.element.querySelectorAll('[data-col="finished"] .cc-card')];
    expect(cards[0].querySelector(".cc-badge").textContent).toBe("未通过");
    expect(cards[0].querySelector(".cc-badge").className).toContain("cc-badge--bad");
    expect(cards[1].querySelector(".cc-badge").textContent).toBe("被停止");
    cards[0].click();
    expect(calls.openConv).toEqual(["bad"]);
  });

  it("空态：三栏全空时显示空态与「新建任务」入口，点击派发到宿主", () => {
    const { api, calls } = mount();
    api.open();
    const view = api.element;
    expect(view.querySelector(".cc-empty").hidden).toBe(false);
    expect(view.querySelector(".cc-board").hidden).toBe(true);
    expect(view.querySelector(".cc-empty").textContent).toContain("一切尽在掌握");
    view.querySelector(".cc-empty-action").click();
    expect(calls.newChat).toBe(1);
  });

  it("refresh 只在打开时重渲染；数据变化后打开即反映", () => {
    const { api } = mount();
    runs = [run({ runId: "run1" })];
    api.refresh(); // 关闭中：不重渲染
    expect(api.element.querySelectorAll('[data-col="running"] .cc-card')).toHaveLength(0);
    api.open();
    expect(api.element.querySelectorAll('[data-col="running"] .cc-card')).toHaveLength(1);
    // 打开中：新待决到达 → refresh 后出现在待决栏
    decisionItems = [decisionItem({ id: "late" })];
    api.refresh();
    expect(api.element.querySelectorAll('[data-col="decision"] .cc-card')).toHaveLength(1);
    expect(api.element.querySelector('[data-stat="deciding"] .cc-stat-num').textContent).toBe("1");
  });

  it("返回按钮派发 onCloseBoard；侧栏入口派发 onOpenBoard", () => {
    const { api, calls } = mount();
    api.open();
    api.element.querySelector(".cc-back").click();
    expect(calls.close).toBe(1);
    document.getElementById("board-open-btn").click();
    expect(calls.open).toBe(1);
  });

  it("等待时长随时钟前进（节拍器重渲染）", () => {
    decisionItems = [decisionItem()];
    const { api } = mount();
    api.open();
    expect(api.element.querySelector('[data-col="decision"]').textContent).toContain("已等待 5 分钟");
    clock = NOW + 10 * 60_000;
    api.refresh();
    expect(api.element.querySelector('[data-col="decision"]').textContent).toContain("已等待 15 分钟");
  });
});

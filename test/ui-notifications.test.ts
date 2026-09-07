// @vitest-environment jsdom
// @ts-nocheck
/**
 * 通知中心（features/notifications.js）的回归锁——T4。
 *
 * 分层覆盖：
 *   纯函数层：事件→通知项归约 / run 列表对账 / run_end 分档 / 角标计数 /
 *             分组 / 已读 / 系统通知判定（合并窗 + 时长门槛 + 可见性）/
 *             权限提示判定 / 相对时间 / 持久化
 *   DOM 层  ：jsdom 里真实初始化，验证铃铛角标、面板分组渲染、点击跳转、
 *             全部已读、权限提示条、系统通知发送与降级
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  MERGE_WINDOW_MS,
  MIN_NOTIFY_DURATION_MS,
  FEED_LIMIT,
  READ_STORAGE_KEY,
  PROMPT_STORAGE_KEY,
  createNotificationStore,
  classifyRunEndForNotify,
  applyRunEventToStore,
  syncRunsToStore,
  removeRunFromStore,
  decisionUnreadCount,
  groupStoreItems,
  markRead,
  markAllRead,
  shouldSendSystemNotification,
  shouldPromptForPermission,
  systemMergeKey,
  formatRelTime,
  persistReadState,
  restoreReadState,
  initNotifications,
} from "../ui/public/features/notifications.js";

const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------
// run_end 分档
// ---------------------------------------------------------------
describe("classifyRunEndForNotify 结果分档", () => {
  it("completed 等收口类 → finished/完成", () => {
    for (const r of ["completed", "max_tokens", "partial", "blocked"]) {
      expect(classifyRunEndForNotify(r)).toMatchObject({ category: "finished", kind: "run_end", tier: "完成" });
    }
  });

  it("max_turns 等失败类 → finished/未通过", () => {
    for (const r of ["max_turns", "incomplete", "stalled", "refusal"]) {
      expect(classifyRunEndForNotify(r)).toMatchObject({ category: "finished", tier: "未通过", tone: "bad" });
    }
  });

  it("aborted / 计划门未批 → finished/被停止（人的决定不算异常）", () => {
    for (const r of ["aborted", "plan_rejected", "plan_gate_expired"]) {
      expect(classifyRunEndForNotify(r)).toMatchObject({ category: "finished", tier: "被停止", tone: "warn" });
    }
  });

  it("budget_exhausted → attention/预算耗尽；error → attention/运行错误", () => {
    expect(classifyRunEndForNotify("budget_exhausted")).toMatchObject({ category: "attention", kind: "budget", tier: "预算耗尽" });
    expect(classifyRunEndForNotify("error")).toMatchObject({ category: "attention", kind: "error", tier: "运行错误" });
  });

  it("未知原因兜底进 finished，不抛错", () => {
    expect(classifyRunEndForNotify("something_new").category).toBe("finished");
    expect(classifyRunEndForNotify(null).category).toBe("finished");
  });
});

// ---------------------------------------------------------------
// 事件 → 通知项归约
// ---------------------------------------------------------------
describe("applyRunEventToStore 事件归约", () => {
  const base = { runId: "r1", runTitle: "修复登录页", now: NOW };

  it("approval_request（main 来源）→ 待决定 pending 条目", () => {
    const { store, added } = applyRunEventToStore(createNotificationStore(), {
      ...base, seq: 7, source: "main",
      event: { type: "approval_request", toolUseId: "tu1", name: "bash", at: NOW },
    });
    expect(added).toHaveLength(1);
    const item = store.items[0];
    expect(item).toMatchObject({
      id: "ap:r1:tu1#7", kind: "approval", category: "decision",
      label: "审批待决", detail: "bash", pending: true, read: false,
    });
  });

  it("verifier 来源的审批不进「待你决定」（harness 内部自答）", () => {
    const { added, store } = applyRunEventToStore(createNotificationStore(), {
      ...base, seq: 7, source: "verifier",
      event: { type: "approval_request", toolUseId: "tu1", name: "bash" },
    });
    expect(added).toEqual([]);
    expect(store.items).toEqual([]);
  });

  it("approval_resolved / approval_expired 按 toolUseId#requestSeq 消解待决", () => {
    let { store } = applyRunEventToStore(createNotificationStore(), {
      ...base, seq: 7, source: "main",
      event: { type: "approval_request", toolUseId: "tu1", name: "bash" },
    });
    for (const type of ["approval_resolved", "approval_expired"]) {
      const next = applyRunEventToStore(store, {
        ...base, seq: 9, source: "main",
        event: { type, toolUseId: "tu1", requestSeq: 7 },
      });
      expect(next.store.items).toEqual([]);
    }
  });

  it("user_question_request → 提问待答，detail 取第一题；resolved/expired 消解", () => {
    let { store, added } = applyRunEventToStore(createNotificationStore(), {
      ...base, seq: 3, source: "main",
      event: { type: "user_question_request", id: "q1", questions: [{ question: "用哪个端口？" }] },
    });
    expect(added[0]).toMatchObject({ kind: "question", category: "decision", label: "提问待答", detail: "用哪个端口？" });
    ({ store } = applyRunEventToStore(store, {
      ...base, seq: 4, source: "main",
      event: { type: "user_question_resolved", id: "q1", requestSeq: 3 },
    }));
    expect(store.items).toEqual([]);
  });

  it("plan_approval_request → 计划待签发；resolved 按 requestSeq 消解", () => {
    let { store, added } = applyRunEventToStore(createNotificationStore(), {
      ...base, seq: 11, source: "main",
      event: { type: "plan_approval_request" },
    });
    expect(added[0]).toMatchObject({ kind: "plan_gate", label: "计划待签发", pending: true });
    ({ store } = applyRunEventToStore(store, {
      ...base, seq: 12, source: "main",
      event: { type: "plan_approval_resolved", requestSeq: 11 },
    }));
    expect(store.items).toEqual([]);
  });

  it("run_end → 清掉该 run 全部待决 + 入一条 finished/attention 条目", () => {
    let store = createNotificationStore();
    ({ store } = applyRunEventToStore(store, {
      ...base, seq: 1, source: "main",
      event: { type: "approval_request", toolUseId: "tu1", name: "bash" },
    }));
    const { store: next, added } = applyRunEventToStore(store, {
      ...base, seq: 20, source: "main", runCreatedAt: NOW - 120_000,
      event: { type: "run_end", mainStopReason: "completed", at: NOW },
    });
    expect(next.items).toHaveLength(1);
    expect(added[0]).toMatchObject({
      kind: "run_end", category: "finished", label: "完成",
      pending: false, durationMs: 120_000,
    });
  });

  it("run_end 幂等：重放不重复记第二条", () => {
    let store = createNotificationStore();
    const evt = { ...base, seq: 20, source: "main", event: { type: "run_end", mainStopReason: "completed", at: NOW } };
    ({ store } = applyRunEventToStore(store, evt));
    const { store: again, added } = applyRunEventToStore(store, evt);
    expect(added).toEqual([]);
    expect(again.items).toHaveLength(1);
  });

  it("budget_exhausted 的 run_end → 需要注意而非运行完成", () => {
    const { store } = applyRunEventToStore(createNotificationStore(), {
      ...base, seq: 20, source: "main",
      event: { type: "run_end", mainStopReason: "budget_exhausted", at: NOW },
    });
    expect(store.items[0]).toMatchObject({ category: "attention", kind: "budget", label: "预算耗尽" });
  });

  it("feed 条目超 FEED_LIMIT 裁最旧；待决条目永不裁", () => {
    let store = createNotificationStore();
    for (let i = 0; i < FEED_LIMIT + 5; i++) {
      ({ store } = applyRunEventToStore(store, {
        runId: `r${i}`, runTitle: `任务${i}`, seq: 1, source: "main", now: NOW + i,
        event: { type: "run_end", mainStopReason: "completed", at: NOW + i },
      }));
    }
    expect(store.items.filter((i) => !i.pending)).toHaveLength(FEED_LIMIT);
    ({ store } = applyRunEventToStore(store, {
      ...base, seq: 99, source: "main",
      event: { type: "approval_request", toolUseId: "tuX", name: "edit" },
    }));
    // 超裁后待决仍在
    expect(store.items.some((i) => i.pending)).toBe(true);
  });

  it("无关事件原样返回 store", () => {
    const store = createNotificationStore();
    const { store: next, added } = applyRunEventToStore(store, {
      ...base, seq: 1, source: "main", event: { type: "tool_call" },
    });
    expect(next).toBe(store);
    expect(added).toEqual([]);
  });
});

// ---------------------------------------------------------------
// run 列表对账
// ---------------------------------------------------------------
describe("syncRunsToStore 列表派生", () => {
  const mk = (over) => ({ runId: "r1", task: "任务一", status: "running", createdAt: NOW - 90_000, finishedAt: null, ...over });

  it("首次调用只播种基线：历史已完成 run 不生成条目", () => {
    const { store, added } = syncRunsToStore(createNotificationStore(), [
      mk({ runId: "old", status: "done", finishedAt: NOW - 5000 }),
    ], NOW);
    expect(added).toEqual([]);
    expect(store.seeded).toBe(true);
    expect(store.items).toEqual([]);
  });

  it("播种后 running→done 跃迁补一条「运行完成」", () => {
    let { store } = syncRunsToStore(createNotificationStore(), [mk({})], NOW);
    ({ store } = syncRunsToStore(store, [mk({ status: "done", finishedAt: NOW + 90_000 })], NOW + 90_000));
    const done = store.items.find((i) => i.category === "finished");
    expect(done).toMatchObject({ runId: "r1", kind: "run_end", label: "完成", durationMs: 180_000 });
  });

  it("已被 run_end 事件记录过的 run 不重复补", () => {
    let store = createNotificationStore();
    ({ store } = syncRunsToStore(store, [mk({})], NOW));
    ({ store } = applyRunEventToStore(store, {
      runId: "r1", runTitle: "任务一", seq: 9, source: "main", now: NOW + 90_000,
      event: { type: "run_end", mainStopReason: "completed", at: NOW + 90_000 },
    }));
    const { store: next, added } = syncRunsToStore(store, [mk({ status: "done", finishedAt: NOW + 90_000 })], NOW + 90_000);
    expect(added).toEqual([]);
    expect(next.items.filter((i) => i.runId === "r1")).toHaveLength(1);
  });

  it("已 done 的 run 清掉残留待决（对账保险）", () => {
    let store = createNotificationStore();
    ({ store } = applyRunEventToStore(store, {
      runId: "r1", runTitle: "任务一", seq: 1, source: "main", now: NOW,
      event: { type: "approval_request", toolUseId: "tu1", name: "bash" },
    }));
    ({ store } = syncRunsToStore(store, [mk({})], NOW)); // 播种 running
    const { store: next } = syncRunsToStore(store, [mk({ status: "done", finishedAt: NOW + 1000 })], NOW + 1000);
    expect(next.items.filter((i) => i.pending)).toEqual([]);
  });
});

describe("removeRunFromStore 会话删除清账", () => {
  it("清掉该 run 的条目、结束账本与状态播种", () => {
    let store = createNotificationStore();
    ({ store } = applyRunEventToStore(store, {
      runId: "r1", runTitle: "任务一", seq: 1, source: "main", now: NOW,
      event: { type: "run_end", mainStopReason: "completed", at: NOW },
    }));
    ({ store } = syncRunsToStore(store, [{ runId: "r1", task: "任务一", status: "done" }], NOW));
    const next = removeRunFromStore(store, "r1");
    expect(next.items).toEqual([]);
    expect(next.endedRunIds).toEqual([]);
    expect(next.seenStatuses).toEqual({});
  });
});

// ---------------------------------------------------------------
// 角标计数 / 分组 / 已读
// ---------------------------------------------------------------
describe("角标与分组", () => {
  function storeWith() {
    let store = createNotificationStore();
    const add = (runId, seq, event) => {
      ({ store } = applyRunEventToStore(store, { runId, runTitle: `t-${runId}`, seq, source: "main", now: NOW + seq, event }));
    };
    add("r1", 1, { type: "approval_request", toolUseId: "a", name: "bash" });
    add("r2", 2, { type: "user_question_request", id: "q", questions: [{ question: "?" }] });
    add("r3", 3, { type: "run_end", mainStopReason: "completed", at: NOW + 3 });
    add("r4", 4, { type: "run_end", mainStopReason: "budget_exhausted", at: NOW + 4 });
    return store;
  }

  it("角标 = 待决定类未读数（不含运行完成与需要注意）", () => {
    expect(decisionUnreadCount(storeWith())).toBe(2);
  });

  it("markRead 后角标下降；markAllRead 归零", () => {
    let store = storeWith();
    store = markRead(store, "ap:r1:a#1");
    expect(decisionUnreadCount(store)).toBe(1);
    store = markAllRead(store);
    expect(decisionUnreadCount(store)).toBe(0);
    expect(store.items.every((i) => i.read)).toBe(true);
  });

  it("分组：三类齐全、组内按时间倒序、未读计数正确", () => {
    const groups = groupStoreItems(storeWith());
    expect(groups.map((g) => g.key)).toEqual(["decision", "finished", "attention"]);
    expect(groups[0].items).toHaveLength(2);
    expect(groups[0].unread).toBe(2);
    expect(groups[1].items[0].runId).toBe("r3");
    expect(groups[2].items[0].label).toBe("预算耗尽");
    // 倒序：seq 2 的提问排在 seq 1 的审批前
    expect(groups[0].items[0].kind).toBe("question");
  });
});

// ---------------------------------------------------------------
// 系统通知判定
// ---------------------------------------------------------------
describe("shouldSendSystemNotification 防打扰判定", () => {
  const granted = { permission: "granted", hidden: true, focused: false, now: NOW };

  it("未授权 / 不支持 → 不发", () => {
    expect(shouldSendSystemNotification({ ...granted, kind: "approval", permission: "default" })).toBe(false);
    expect(shouldSendSystemNotification({ ...granted, kind: "approval", permission: "denied" })).toBe(false);
    expect(shouldSendSystemNotification({ ...granted, kind: "approval", permission: null })).toBe(false);
  });

  it("页面可见且聚焦 → 不发（可见时不打扰）", () => {
    expect(shouldSendSystemNotification({ ...granted, kind: "approval", hidden: false, focused: true })).toBe(false);
    // 可见但失焦 → 发
    expect(shouldSendSystemNotification({ ...granted, kind: "approval", hidden: false, focused: false })).toBe(true);
    // 隐藏 → 发
    expect(shouldSendSystemNotification({ ...granted, kind: "approval" })).toBe(true);
  });

  it("运行完成：时长 ≤60s 不发，>60s 才发；时长未知不发", () => {
    expect(shouldSendSystemNotification({ ...granted, kind: "run_end", durationMs: 30_000 })).toBe(false);
    expect(shouldSendSystemNotification({ ...granted, kind: "run_end", durationMs: MIN_NOTIFY_DURATION_MS })).toBe(false);
    expect(shouldSendSystemNotification({ ...granted, kind: "run_end", durationMs: MIN_NOTIFY_DURATION_MS + 1 })).toBe(true);
    expect(shouldSendSystemNotification({ ...granted, kind: "run_end", durationMs: null })).toBe(false);
  });

  it("待决类与需要注意类不受 60s 门槛", () => {
    for (const kind of ["approval", "question", "plan_gate", "budget", "error"]) {
      expect(shouldSendSystemNotification({ ...granted, kind, durationMs: 1000 })).toBe(true);
    }
  });

  it("30 秒合并窗：窗口内同类不发，窗口外发", () => {
    const input = { ...granted, kind: "approval", lastSentAt: NOW - MERGE_WINDOW_MS + 1 };
    expect(shouldSendSystemNotification(input)).toBe(false);
    expect(shouldSendSystemNotification({ ...input, lastSentAt: NOW - MERGE_WINDOW_MS })).toBe(true);
  });

  it("合并键 = runId:kind（同会话同类合并，跨会话/跨类不合并）", () => {
    expect(systemMergeKey("r1", "approval")).toBe("r1:approval");
    expect(systemMergeKey("r1", "approval")).not.toBe(systemMergeKey("r1", "question"));
    expect(systemMergeKey("r1", "approval")).not.toBe(systemMergeKey("r2", "approval"));
  });
});

// ---------------------------------------------------------------
// 权限提示判定
// ---------------------------------------------------------------
describe("shouldPromptForPermission 一次性提示", () => {
  it("仅在 default 且用户未表态时提示", () => {
    expect(shouldPromptForPermission("default", null)).toBe(true);
    expect(shouldPromptForPermission("granted", null)).toBe(false);
    expect(shouldPromptForPermission("denied", null)).toBe(false);
    expect(shouldPromptForPermission(null, null)).toBe(false); // 浏览器不支持
    expect(shouldPromptForPermission("default", "dismissed")).toBe(false);
    expect(shouldPromptForPermission("default", "granted")).toBe(false);
  });
});

// ---------------------------------------------------------------
// 相对时间
// ---------------------------------------------------------------
describe("formatRelTime", () => {
  it("分档：刚刚 / 分钟 / 当天时刻 / 小时 / 日期", () => {
    expect(formatRelTime(NOW - 5_000, NOW)).toBe("刚刚");
    expect(formatRelTime(NOW - 5 * 60_000, NOW)).toBe("5 分钟前");
    const sameDay = new Date(NOW);
    sameDay.setHours(Math.max(0, sameDay.getHours() - 2));
    expect(formatRelTime(sameDay.getTime(), NOW)).toMatch(/^\d{2}:\d{2}$/);
    expect(formatRelTime(NOW - 40 * 3_600_000, NOW)).toMatch(/^\d+月\d+日$/);
  });
});

// ---------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------
describe("已读状态持久化", () => {
  function memStorage() {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  }

  it("只持久化活着的已读条目；restore 贴回 read 标记", () => {
    let store = createNotificationStore();
    ({ store } = applyRunEventToStore(store, {
      runId: "r1", runTitle: "t", seq: 1, source: "main", now: NOW,
      event: { type: "approval_request", toolUseId: "a", name: "bash" },
    }));
    store = markRead(store, "ap:r1:a#1");
    const storage = memStorage();
    persistReadState(storage, store);
    const revived = restoreReadState(storage, createNotificationStore());
    expect(revived.items).toEqual([]);
    // 同一 id 的条目重新出现时（重放）已读状态贴回
    const { store: replayed } = applyRunEventToStore(createNotificationStore(), {
      runId: "r1", runTitle: "t", seq: 1, source: "main", now: NOW,
      event: { type: "approval_request", toolUseId: "a", name: "bash" },
    });
    const restored = restoreReadState(storage, replayed);
    expect(restored.items[0].read).toBe(true);
    expect(JSON.parse(storage.getItem(READ_STORAGE_KEY))).toEqual(["ap:r1:a#1"]);
  });

  it("storage 抛错（隐私模式）时静默降级", () => {
    const bad = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    };
    const store = createNotificationStore();
    expect(() => persistReadState(bad, store)).not.toThrow();
    expect(restoreReadState(bad, store)).toBe(store);
  });
});

// ---------------------------------------------------------------
// DOM 层：jsdom 真实初始化
// ---------------------------------------------------------------
describe("initNotifications DOM 行为", () => {
  let host;
  let sent;
  let FakeNotification;

  beforeEach(() => {
    document.body.innerHTML =
      '<button type="button" id="notifications-btn" aria-label="通知中心">' +
      '<span id="notifications-badge" hidden>0</span></button>' +
      '<div id="action-dock" hidden></div>';
    sent = [];
    FakeNotification = class {
      static permission = "default";
      static requestPermission = vi.fn(() => {
        FakeNotification.permission = "granted";
        return Promise.resolve("granted");
      });
      constructor(title, opts) {
        this.title = title;
        this.opts = opts;
        this.onclick = null;
        sent.push(this);
      }
    };
    host = {
      getRuns: () => [
        { runId: "r1", task: "修复登录页", status: "running", createdAt: NOW - 90_000 },
        { runId: "r2", task: "写测试", status: "running", createdAt: NOW - 10_000 },
      ],
      getRunTitle: (id) => ({ r1: "修复登录页", r2: "写测试" })[id] ?? null,
      onOpenConversation: vi.fn(),
      onRevealDock: vi.fn(),
      onAnnounce: vi.fn(),
    };
  });

  function mkEnv(over = {}) {
    const m = new Map();
    return {
      doc: document,
      win: {
        focus: vi.fn(),
        localStorage: {
          getItem: (k) => (m.has(k) ? m.get(k) : null),
          setItem: (k, v) => m.set(k, String(v)),
        },
      },
      storage: {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
      },
      now: () => NOW,
      Notification: FakeNotification,
      ...over,
    };
  }

  const approvalEvt = (seq = 1) => ({
    seq, source: "main",
    event: { type: "approval_request", toolUseId: "tu1", name: "bash", at: NOW },
  });

  it("铃铛角标 = 待决定未读数；aria-label 带计数", () => {
    const api = initNotifications(host, mkEnv());
    expect(document.getElementById("notifications-badge").hidden).toBe(true);
    api.ingest("r1", approvalEvt());
    const badge = document.getElementById("notifications-badge");
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe("1");
    expect(document.getElementById("notifications-btn").getAttribute("aria-label")).toContain("1 项待你决定");
  });

  it("首次出现待决事件 → 显示一次性授权提示条；「不再提示」持久化", async () => {
    const env = mkEnv();
    const api = initNotifications(host, env);
    api.ingest("r1", approvalEvt());
    const prompt = document.getElementById("notifications-prompt");
    expect(prompt.hidden).toBe(false);
    expect(prompt.textContent).toContain("开启桌面通知");
    prompt.querySelector(".notif-prompt-dismiss").click();
    expect(prompt.hidden).toBe(true);
    expect(env.storage.getItem(PROMPT_STORAGE_KEY)).toBe("dismissed");
    // 再次有待决也不再出现
    api.ingest("r2", approvalEvt(9));
    expect(prompt.hidden).toBe(true);
  });

  it("「开启」请求权限；授权后页面隐藏时发系统通知，点击通知聚焦并跳会话", async () => {
    const env = mkEnv();
    const api = initNotifications(host, env);
    api.ingest("r1", approvalEvt());
    document.getElementById("notifications-prompt").querySelector(".notif-prompt-allow").click();
    await Promise.resolve();
    expect(FakeNotification.requestPermission).toHaveBeenCalled();
    expect(env.storage.getItem(PROMPT_STORAGE_KEY)).toBe("granted");

    // jsdom document.hidden=false、hasFocus=false → 失焦路径：应发
    api.ingest("r1", { seq: 2, source: "main", event: { type: "user_question_request", id: "q1", questions: [{ question: "端口？" }], at: NOW + 1000 } });
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toContain("提问待答");
    expect(sent[0].opts.tag).toBe("r1:question");
    // 点击系统通知 → 聚焦窗口 + 跳会话
    sent[0].onclick();
    expect(env.win.focus).toHaveBeenCalled();
    expect(host.onRevealDock).toHaveBeenCalledWith("r1");
  });

  it("权限 default 时不发系统通知（未授权不打扰）", () => {
    const api = initNotifications(host, mkEnv());
    api.ingest("r1", approvalEvt());
    expect(sent).toEqual([]);
  });

  it("浏览器不支持 Notification → 无提示条、无异常", () => {
    const env = mkEnv({ Notification: null });
    const api = initNotifications(host, env);
    api.ingest("r1", approvalEvt());
    expect(document.getElementById("notifications-prompt").hidden).toBe(true);
    expect(document.getElementById("notifications-badge").hidden).toBe(false); // 应用内中心不受影响
  });

  it("面板：铃铛点击展开，三组分类渲染，空态文案", () => {
    const api = initNotifications(host, mkEnv());
    api.ingest("r1", approvalEvt());
    api.ingest("r2", { seq: 5, source: "main", event: { type: "run_end", mainStopReason: "completed", at: NOW }, });
    document.getElementById("notifications-btn").click();
    const panel = document.getElementById("notifications-panel");
    expect(panel.hidden).toBe(false);
    const groups = [...panel.querySelectorAll(".notif-group")].map((g) => g.getAttribute("data-group"));
    expect(groups).toEqual(["decision", "finished"]);
    expect(panel.textContent).toContain("待你决定");
    expect(panel.textContent).toContain("运行完成");
    expect(panel.textContent).toContain("审批待决");
    expect(panel.textContent).toContain("修复登录页");
    // 空态隐藏
    expect(panel.querySelector(".notif-empty").hidden).toBe(true);
  });

  it("待决定类条目点击 → onRevealDock 直达决定坞；其他类 → onOpenConversation", () => {
    const api = initNotifications(host, mkEnv());
    api.ingest("r1", approvalEvt());
    api.ingest("r2", { seq: 5, source: "main", event: { type: "run_end", mainStopReason: "error", at: NOW } });
    document.getElementById("notifications-btn").click();
    const items = [...document.querySelectorAll(".notif-item")];
    const decisionBtn = items.find((b) => b.textContent.includes("审批待决"));
    const attentionBtn = items.find((b) => b.textContent.includes("运行错误"));
    decisionBtn.click();
    expect(host.onRevealDock).toHaveBeenCalledWith("r1");
    // 点击后已读 → 角标归零
    expect(document.getElementById("notifications-badge").hidden).toBe(true);
    attentionBtn.click();
    expect(host.onOpenConversation).toHaveBeenCalledWith("r2");
  });

  it("「全部已读」清空角标并持久化", () => {
    const env = mkEnv();
    const api = initNotifications(host, env);
    api.ingest("r1", approvalEvt());
    document.getElementById("notifications-btn").click();
    document.querySelector(".notif-mark-all").click();
    expect(document.getElementById("notifications-badge").hidden).toBe(true);
    expect(host.onAnnounce).toHaveBeenCalledWith("全部通知已标为已读");
    expect(JSON.parse(env.storage.getItem(READ_STORAGE_KEY))).toContain("ap:r1:tu1#1");
  });

  it("Esc 与遮罩点击关闭面板；焦点还给铃铛", () => {
    const api = initNotifications(host, mkEnv());
    const bell = document.getElementById("notifications-btn");
    bell.focus();
    bell.click();
    expect(api.isOpen()).toBe(true);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(api.isOpen()).toBe(false);
    expect(document.activeElement).toBe(bell);
    // 遮罩
    bell.click();
    api.element.querySelector(".notif-panel").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(api.isOpen()).toBe(true);
    api.element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(api.isOpen()).toBe(false);
  });

  it("syncRuns：首次播种不生成历史条目，跃迁时补「运行完成」并刷新面板", () => {
    const api = initNotifications(host, mkEnv());
    api.syncRuns(); // 播种：两个 running
    expect(api.getStore().items).toEqual([]);
    host.getRuns = () => [{ runId: "r1", task: "修复登录页", status: "done", createdAt: NOW - 90_000, finishedAt: NOW }];
    api.syncRuns();
    expect(api.getStore().items.some((i) => i.category === "finished" && i.runId === "r1")).toBe(true);
  });

  it("removeRun 清掉该会话条目", () => {
    const api = initNotifications(host, mkEnv());
    api.ingest("r1", approvalEvt());
    api.removeRun("r1");
    expect(api.getStore().items).toEqual([]);
    expect(document.getElementById("notifications-badge").hidden).toBe(true);
  });

  it("重复初始化幂等：不重复挂 DOM", () => {
    initNotifications(host, mkEnv());
    initNotifications(host, mkEnv());
    expect(document.querySelectorAll("#notifications-panel")).toHaveLength(1);
    expect(document.querySelectorAll("#notifications-prompt")).toHaveLength(1);
  });
});

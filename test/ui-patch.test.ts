// @vitest-environment jsdom
// @ts-nocheck
/**
 * 细粒度渲染的回归锁（v2 R3 / V-10）。
 *
 * 守的是三件在旧实现下实测失败的事：
 *   · 直播中拒绝理由输入框的内容被清空（每条 SSE 事件重建一次 innerHTML）
 *   · 侧栏焦点每 3 秒被摧毁（轮询整体重建列表）
 *   · 日志滚动位置归零、且长运行退化成 O(n²)
 *
 * 这些都不是 axe 或键盘走查能覆盖的层次——s3d 测的是 Tab 序、s3e 测的是静态
 * ARIA 结构，两者都不涉及"重渲染之后这些状态还在不在"。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createInitialState,
  reduceEvents,
  renderRunDetail,
  renderRunList,
  diffKeyed,
  patchList,
  appendOnly,
  keepScrollAnchored,
  createBatcher,
  shouldShowReconnecting,
} from "../ui/public/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "..", "ui", "public");

function loadSkeleton(): string {
  const html = readFileSync(join(UI_DIR, "index.html"), "utf-8");
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? "";
  return body.replace(/<script[\s\S]*?<\/script>/g, "");
}

const sse = (seq: number, source: string, type: string, extra = {}) => ({
  seq,
  source,
  event: { type, ...extra },
});

beforeEach(() => {
  document.body.innerHTML = loadSkeleton();
});

// ================================================================
// diffKeyed —— 纯函数
// ================================================================

describe("diffKeyed", () => {
  it("全新列表：全是 inserts，beforeKey 指向后继", () => {
    const d = diffKeyed([], ["a", "b", "c"]);
    expect(d.removes).toEqual([]);
    expect(d.keeps).toEqual([]);
    expect(d.inserts.map((i) => i.key)).toEqual(["a", "b", "c"]);
    expect(d.inserts[0].beforeKey).toBe("b");
    expect(d.inserts[2].beforeKey).toBeNull();
  });

  it("纯追加：既有键全部 keeps，不产生 moves", () => {
    const d = diffKeyed(["a", "b"], ["a", "b", "c"]);
    expect(d.keeps).toEqual(["a", "b"]);
    expect(d.inserts.map((i) => i.key)).toEqual(["c"]);
    expect(d.moves).toEqual([]);
  });

  it("删除中间项不把后续项误判为 move", () => {
    const d = diffKeyed(["a", "b", "c"], ["a", "c"]);
    expect(d.removes).toEqual(["b"]);
    expect(d.keeps).toEqual(["a", "c"]);
    expect(d.moves).toEqual([]);
  });

  it("头部插入（列表降序时的典型形态）：只有新项是 insert", () => {
    const d = diffKeyed(["b", "c"], ["a", "b", "c"]);
    expect(d.inserts.map((i) => i.key)).toEqual(["a"]);
    expect(d.inserts[0].beforeKey).toBe("b");
    expect(d.keeps).toEqual(["b", "c"]);
    expect(d.moves).toEqual([]);
  });

  it("真实换位才算 move，且 move 数取最小（走 LCS）", () => {
    const d = diffKeyed(["a", "b", "c"], ["c", "a", "b"]);
    expect(d.keeps).toEqual(["a", "b"]);
    expect(d.moves.map((m) => m.key)).toEqual(["c"]);
  });

  it("全部替换：旧的全删、新的全插", () => {
    const d = diffKeyed(["a", "b"], ["x", "y"]);
    expect(d.removes).toEqual(["a", "b"]);
    expect(d.inserts.map((i) => i.key)).toEqual(["x", "y"]);
    expect(d.keeps).toEqual([]);
  });
});

// ================================================================
// patchList / appendOnly —— 节点同一性
// ================================================================

describe("patchList 节点复用", () => {
  const spec = {
    key: (x: any) => x.id,
    create: (x: any) => {
      const el = document.createElement("div");
      el.dataset.id = x.id;
      el.textContent = x.label;
      return el;
    },
    update: (node: HTMLElement, x: any) => {
      node.textContent = x.label;
    },
  };

  it("复用同 key 的节点对象，不是重建一个长得一样的", () => {
    const host = document.createElement("div");
    patchList(host, [{ id: "a", label: "1" }], spec);
    const first = host.firstElementChild;
    patchList(host, [{ id: "a", label: "2" }], spec);
    expect(host.firstElementChild).toBe(first); // 引用相等
    expect(first!.textContent).toBe("2"); // 内容确实更新了
  });

  it("头部插入后既有节点仍是原对象，且顺序正确", () => {
    const host = document.createElement("div");
    patchList(host, [{ id: "b", label: "B" }], spec);
    const bNode = host.firstElementChild;
    patchList(host, [{ id: "a", label: "A" }, { id: "b", label: "B" }], spec);
    expect([...host.children].map((c) => (c as HTMLElement).dataset.id)).toEqual(["a", "b"]);
    expect(host.children[1]).toBe(bNode);
  });

  it("移除的项从 DOM 与索引中一并消失", () => {
    const host = document.createElement("div");
    patchList(host, [{ id: "a", label: "A" }, { id: "b", label: "B" }], spec);
    patchList(host, [{ id: "b", label: "B" }], spec);
    expect(host.children).toHaveLength(1);
    expect((host.firstElementChild as HTMLElement).dataset.id).toBe("b");
  });
});

describe("appendOnly", () => {
  const spec = {
    key: (e: any) => String(e.seq),
    create: (e: any) => {
      const el = document.createElement("div");
      el.dataset.seq = String(e.seq);
      return el;
    },
  };

  it("只处理新增项，已渲染节点原样不动", () => {
    const host = document.createElement("div");
    appendOnly(host, [{ seq: 0 }, { seq: 1 }], spec);
    const nodes = [...host.children];
    appendOnly(host, [{ seq: 0 }, { seq: 1 }, { seq: 2 }], spec);
    expect(host.children).toHaveLength(3);
    expect(host.children[0]).toBe(nodes[0]);
    expect(host.children[1]).toBe(nodes[1]);
  });

  it("重复传入同一批不产生重复节点（重连重放安全）", () => {
    const host = document.createElement("div");
    const batch = [{ seq: 0 }, { seq: 1 }];
    appendOnly(host, batch, spec);
    appendOnly(host, batch, spec);
    expect(host.children).toHaveLength(2);
  });
});

describe("keepScrollAnchored", () => {
  function makeScroller(scrollHeight: number, clientHeight: number, scrollTop: number) {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollHeight", { value: scrollHeight, writable: true });
    Object.defineProperty(el, "clientHeight", { value: clientHeight, writable: true });
    el.scrollTop = scrollTop;
    return el;
  }

  it("贴底时新内容到达后仍贴底", () => {
    const el = makeScroller(1000, 200, 800);
    const pinned = keepScrollAnchored(el, () => {
      (el as any).scrollHeight = 1200;
    });
    expect(pinned).toBe(true);
    expect(el.scrollTop).toBe(1200);
  });

  it("用户往上翻时不被拽回底部", () => {
    const el = makeScroller(1000, 200, 100);
    const pinned = keepScrollAnchored(el, () => {
      (el as any).scrollHeight = 1200;
    });
    expect(pinned).toBe(false);
    expect(el.scrollTop).toBe(100); // 原地不动
  });
});

// ================================================================
// createBatcher —— 事件折叠调度
// ================================================================

describe("createBatcher", () => {
  it("同一节拍内的多条事件折叠成一次 flush", () => {
    const flushes: any[] = [];
    let frame: (() => void) | null = null;
    const b = createBatcher((batches) => flushes.push(batches), {
      raf: (cb) => (frame = cb),
      isHidden: () => false,
    });

    b.push("r1", { seq: 0 });
    b.push("r1", { seq: 1 });
    b.push("r2", { seq: 0 });
    expect(flushes).toHaveLength(0); // 还没到节拍
    expect(b.pending()).toBe(3);

    frame!();
    expect(flushes).toHaveLength(1);
    expect(flushes[0].get("r1")).toHaveLength(2);
    expect(flushes[0].get("r2")).toHaveLength(1);
    expect(b.pending()).toBe(0);
  });

  it("1000 条事件只触发一次 flush（锁死 O(n²) 不回归）", () => {
    let calls = 0;
    let frame: (() => void) | null = null;
    const b = createBatcher(() => calls++, {
      raf: (cb) => (frame = cb),
      isHidden: () => false,
    });
    for (let i = 0; i < 1000; i++) b.push("r", { seq: i });
    frame!();
    expect(calls).toBe(1);
  });

  /**
   * 这条是实测踩出来的：R3 首版只用 rAF，而浏览器在标签页隐藏时不触发 rAF——
   * 事件在队列里无限堆积、界面永不更新。后台标签页里等审批的人一直等不到卡片，
   * 等于换个门重新制造了 R1 刚修掉的"审批悄悄消失"。
   */
  it("标签页隐藏时不依赖 rAF，改走定时器（否则界面永不更新）", () => {
    let rafCalled = 0;
    let timerCb: (() => void) | null = null;
    let timerDelay = -1;
    let flushed = 0;

    const b = createBatcher(() => flushed++, {
      raf: () => {
        rafCalled++;
      },
      timer: (cb, ms) => {
        timerCb = cb;
        timerDelay = ms;
      },
      isHidden: () => true,
      hiddenIntervalMs: 250,
    });

    b.push("r", { seq: 0 });
    expect(rafCalled).toBe(0); // 绝不能把命交给 rAF
    expect(timerDelay).toBe(250);

    timerCb!();
    expect(flushed).toBe(1);
    expect(b.pending()).toBe(0);
  });

  it("flushNow 立即折叠（切回前台时用）", () => {
    let flushed = 0;
    const b = createBatcher(() => flushed++, {
      raf: () => {},
      isHidden: () => false,
    });
    b.push("r", { seq: 0 });
    b.flushNow();
    expect(flushed).toBe(1);
    // 队列已空时再 flush 不产生空回调
    b.flushNow();
    expect(flushed).toBe(1);
  });
});

// ================================================================
// 详情页：输入值、焦点、渲染次数
// ================================================================

function stateWithPendingApproval() {
  let s = createInitialState("run-x", "写文件任务", true);
  s = reduceEvents(s, [
    sse(0, "main", "turn_start", { turn: 1 }),
    sse(1, "main", "approval_request", {
      toolUseId: "tu_w",
      name: "write_file",
      input: { path: "a.txt" },
    }),
  ]);
  return s;
}

describe("详情页重渲染下的状态存活 (V-10)", () => {
  it("拒绝理由输入的内容与光标位置在重渲染后保持", () => {
    let s = stateWithPendingApproval();
    renderRunDetail(s, { activeTab: "overview" });

    const input = document.querySelector(".deny-reason") as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = "路径不在白名单";
    input.setSelectionRange(3, 3);
    input.focus();

    // 直播中又来了一批事件——旧实现在这里会把输入框连同整页一起重建
    s = reduceEvents(s, [
      sse(2, "main", "assistant_text", { text: "继续执行" }),
      sse(3, "main", "turn_start", { turn: 2 }),
    ]);
    renderRunDetail(s, { activeTab: "overview" });

    const after = document.querySelector(".deny-reason") as HTMLInputElement;
    expect(after).toBe(input); // 同一个节点对象
    expect(after.value).toBe("路径不在白名单");
    expect(after.selectionStart).toBe(3);
    expect(document.activeElement).toBe(after);
  });

  it("审批卡按 approvalId 键控：返工轮新增的卡不影响上一轮那张", () => {
    let s = stateWithPendingApproval();
    renderRunDetail(s, { activeTab: "overview" });
    const firstCard = document.querySelector(".approval-card");

    s = reduceEvents(s, [
      sse(2, "host", "approval_resolved", {
        requestSeq: 1, toolUseId: "tu_w", decision: "allow", at: 1,
      }),
      sse(5, "rework", "approval_request", {
        toolUseId: "tu_w", name: "write_file", input: { path: "b.txt" },
      }),
    ]);
    renderRunDetail(s, { activeTab: "overview" });

    /**
     * V-03 的不变量是「同一 toolUseId 跨返工轮不串卡」——按裸 toolUseId 存会让
     * 后一轮覆盖前一轮。表达它的方式随设计调整过：已决的审批不再留在待办区
     * （委托方反馈：无限堆叠、已处理与未处理混排），所以现在断言的是
     * "待办区里只剩本轮那张【新的】卡，且它不是上一轮那张节点"。
     * 上一轮那张的归宿在下面"已处理折叠摘要"一组里锁。
     */
    const cards = [...document.querySelectorAll(".approval-card")];
    expect(cards).toHaveLength(1);
    expect(cards[0], "返工轮的卡必须是新节点，不能复用上一轮那张").not.toBe(firstCard);
    expect(cards[0].querySelector("[data-action='allow']")).toBeTruthy(); // 新的一张可操作
    expect(cards[0].getAttribute("data-approval-id")).toBe("tu_w#5");
  });

  it("已处理的审批离开待办区，折叠成一行摘要（委托方反馈：堆叠难读难操作）", () => {
    let s = stateWithPendingApproval();
    s = reduceEvents(s, [
      sse(2, "host", "approval_resolved", {
        requestSeq: 1, toolUseId: "tu_w", decision: "allow", at: 1700000000000,
      }),
    ]);
    renderRunDetail(s, { activeTab: "overview" });

    // 待办区空了——已决的不再占位
    expect(document.querySelectorAll(".approval-card")).toHaveLength(0);
    // 但没有凭空消失：折叠摘要给出即时反馈，展开是紧凑列表
    const done = document.querySelector(".approvals-done");
    expect(done).toBeTruthy();
    expect(done!.querySelector("summary")!.textContent).toContain("已处理 1 项");
    expect(done!.querySelector("summary")!.textContent).toContain("允许 1");
    expect(done!.querySelectorAll(".approvals-done-list li")).toHaveLength(1);
    expect(done!.querySelector(".approvals-done-list li")!.textContent).toContain("write_file");
  });

  it("摘要展开态在重渲染后保持（details 的 open 不能被补丁合上）", () => {
    let s = stateWithPendingApproval();
    s = reduceEvents(s, [
      sse(2, "host", "approval_resolved", { requestSeq: 1, toolUseId: "tu_w", decision: "allow", at: 1 }),
    ]);
    renderRunDetail(s, { activeTab: "overview" });
    const details = document.querySelector(".approvals-done") as HTMLDetailsElement;
    details.open = true;

    // 再来一条已决项 → 摘要必须重建，但展开态要留着
    s = reduceEvents(s, [
      sse(3, "main", "approval_request", { toolUseId: "tu_b", name: "bash", input: { command: "ls" } }),
      sse(4, "host", "approval_resolved", { requestSeq: 3, toolUseId: "tu_b", decision: "deny", at: 2, reason: "不需要" }),
    ]);
    renderRunDetail(s, { activeTab: "overview" });

    const next = document.querySelector(".approvals-done") as HTMLDetailsElement;
    expect(next.open, "重渲染把用户展开的摘要合上了").toBe(true);
    expect(next.querySelector("summary")!.textContent).toContain("已处理 2 项");
    expect(next.textContent).toContain("不需要"); // 拒绝理由留档
  });

  it("同一状态连续渲染两次：DOM 不变且节点引用不变（幂等）", () => {
    const s = stateWithPendingApproval();
    renderRunDetail(s, { activeTab: "overview" });
    const card = document.querySelector(".approval-card");
    const html = document.getElementById("main-area")!.innerHTML;

    renderRunDetail(s, { activeTab: "overview" });
    expect(document.getElementById("main-area")!.innerHTML).toBe(html);
    expect(document.querySelector(".approval-card")).toBe(card);
  });

  it("日志面板只追加：先渲染的条目在新事件到达后仍是同一节点", () => {
    let s = createInitialState("run-log", "日志任务", false);
    s = reduceEvents(s, [
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "main", "tool_call", { toolUseId: "t1", name: "read_file", input: {} }),
    ]);
    renderRunDetail(s, { activeTab: "log" });
    const firstRow = document.querySelector(".log-entries .log-entry");
    expect(firstRow).toBeTruthy();

    s = reduceEvents(s, [
      sse(2, "main", "tool_result", { toolUseId: "t1", result: { content: "ok" }, durationMs: 3 }),
    ]);
    renderRunDetail(s, { activeTab: "log" });

    const rows = [...document.querySelectorAll(".log-entries .log-entry")];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe(firstRow);
  });

  it("1000 条事件的日志一次渲染完成，且不重建已有节点", () => {
    let s = createInitialState("run-big", "长运行", false);
    const events = [];
    for (let i = 0; i < 1000; i++) {
      events.push(sse(i, "main", "turn_start", { turn: i + 1 }));
    }
    s = reduceEvents(s, events);
    renderRunDetail(s, { activeTab: "log" });
    const rows = document.querySelectorAll(".log-entries .log-entry");
    expect(rows).toHaveLength(1000);
    const firstRow = rows[0];

    // 再来一条：只应新增一个节点，其余原样
    s = reduceEvents(s, [sse(1000, "main", "turn_start", { turn: 1001 })]);
    const createSpy = vi.spyOn(document, "createElement");
    renderRunDetail(s, { activeTab: "log" });
    createSpy.mockRestore();

    expect(document.querySelectorAll(".log-entries .log-entry")).toHaveLength(1001);
    expect(document.querySelectorAll(".log-entries .log-entry")[0]).toBe(firstRow);
  });
});

describe("侧栏重渲染下的焦点存活 (V-10)", () => {
  const runs = [
    { runId: "r1", task: "任务一", status: "running", verify: false },
    { runId: "r2", task: "任务二", status: "done", verify: true },
  ];

  it("列表刷新不摧毁停在运行项上的焦点", () => {
    renderRunList(runs, "r1", () => {}, new Map());
    const item = document.querySelector("#run-list .run-item") as HTMLElement;
    item.focus();
    expect(document.activeElement).toBe(item);

    // 相当于此前每 3 秒一次的整体刷新
    for (let i = 0; i < 5; i++) renderRunList(runs, "r1", () => {}, new Map());

    expect(document.activeElement).toBe(item);
  });

  it("新运行插到列表头部时，既有项与焦点都不受影响", () => {
    renderRunList(runs, "r1", () => {}, new Map());
    const item = document.querySelector('[data-run-id="r1"]') as HTMLElement;
    item.focus();

    const withNew = [{ runId: "r0", task: "最新任务", status: "running", verify: false }, ...runs];
    renderRunList(withNew, "r1", () => {}, new Map());

    expect(document.querySelectorAll("#run-list .run-item")).toHaveLength(3);
    expect(document.querySelector('[data-run-id="r1"]')).toBe(item);
    expect(document.activeElement).toBe(item);
    // 顺序正确：新的在最前
    expect(
      [...document.querySelectorAll("#run-list .run-item")].map((e) =>
        (e as HTMLElement).dataset.runId,
      ),
    ).toEqual(["r0", "r1", "r2"]);
  });
});

// ================================================================
// api_retry 的退避等待要看得见
// ================================================================

describe("重试退避等待在界面上可见", () => {
  /**
   * 抖动上线后，同一 attempt 的等待不再是定值——界面若仍只显示"第几次重试"，
   * 人会以为退避是固定的。这是这个项目反复踩的那条"harness 有、宿主没接"，
   * 新字段落地时就该锁住，而不是等第七次再补。
   */
  function stateWithRetry(extra: Record<string, unknown>) {
    let s = createInitialState("run-r", "重试任务", false);
    s = reduceEvents(s, [
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "main", "api_retry", { turn: 1, attempt: 1, reason: "限流", ...extra }),
    ]);
    return s;
  }

  it("带 backoffMs 时渲染出实际等待时长", () => {
    renderRunDetail(stateWithRetry({ backoffMs: 2250 }), { activeTab: "loop" });
    const body = document.querySelector(".log-entries")?.textContent ?? "";
    expect(body).toContain("限流");
    expect(body).toContain("2.3s"); // formatDuration(2250)
    expect(body).toContain("抖动");
  });

  it("旧事件没有 backoffMs 时不渲染空占位（重放旧 run 不能显示 undefined）", () => {
    renderRunDetail(stateWithRetry({}), { activeTab: "loop" });
    const body = document.querySelector(".log-entries")?.textContent ?? "";
    expect(body).toContain("限流");
    expect(body).not.toContain("退避等待");
    expect(body).not.toContain("undefined");
  });
});

// ================================================================
// 文本流式（backlog §4）
// ================================================================

describe("直播条消费逐字增量", () => {
  /**
   * 服务端 R2 起就在推 `event: delta`，前端一直丢弃——直播条显示的是上一条
   * **完整** assistant_text。这里锁的是"流入的文本优先于已发生完的事"。
   * liveText 不进 RunState（delta 不占 seq、重放时不存在），所以它是 render
   * 的入参而不是 state 的字段——这一点本身也由下面"重放幂等"那条守住。
   */
  function runningState() {
    let s = createInitialState("run-s", "流式任务", false);
    s = reduceEvents(s, [sse(0, "main", "turn_start", { turn: 1 })]);
    return s;
  }

  const liveText = () =>
    document.querySelector(".live-strip .live-text")?.textContent ?? "";

  it("有增量时显示增量的尾部，而不是「等待模型响应…」", () => {
    renderRunDetail(runningState(), { activeTab: "loop", liveText: "我先读一下 package.json" });
    expect(liveText()).toContain("package.json");
    expect(liveText()).not.toContain("等待模型响应");
  });

  it("超长增量取尾部——要看的是刚写出来的那截", () => {
    const long = `${"甲".repeat(300)}结论在最后`;
    renderRunDetail(runningState(), { activeTab: "loop", liveText: long });
    expect(liveText()).toContain("结论在最后");
    expect(liveText().length).toBeLessThan(100);
  });

  it("增量里的换行折成单行——直播条是单行，原样塞进去会撑开布局", () => {
    renderRunDetail(runningState(), { activeTab: "loop", liveText: "第一行\n\n第二行" });
    expect(liveText()).not.toContain("\n");
    expect(liveText()).toContain("第一行 第二行");
  });

  it("增量为空时退回原行为（最近一次工具调用）", () => {
    let s = runningState();
    s = reduceEvents(s, [
      sse(1, "main", "tool_call", { toolUseId: "t1", name: "read_file", input: { path: "a.ts" } }),
    ]);
    renderRunDetail(s, { activeTab: "loop", liveText: "" });
    expect(liveText()).toContain("read_file");
  });

  it("不传 liveText 时行为与接入前完全一致（老调用方不受影响）", () => {
    renderRunDetail(runningState(), { activeTab: "loop" });
    expect(liveText()).toContain("等待模型响应");
  });

  it("运行已结束时直播条隐藏，增量不能把它拉回来", () => {
    let s = runningState();
    s = reduceEvents(s, [
      sse(1, "main", "done", { stopReason: "completed", messageCount: 2, usage: {} }),
      sse(2, "host", "run_end", { outcome: "completed" }),
    ]);
    renderRunDetail(s, { activeTab: "loop", liveText: "还在流的残留文本" });
    const strip = document.querySelector(".live-strip") as HTMLElement;
    expect(strip.hasAttribute("hidden")).toBe(true);
  });
});

// ================================================================
// 计划确认门（§5.1）
// ================================================================

describe("思考过程进事件流", () => {
  function withThinking(extra: Record<string, unknown>) {
    let s = createInitialState("run-t", "任务", false);
    return reduceEvents(s, [
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "main", "assistant_thinking", { turn: 1, text: "先读 **package.json**", redacted: false, ...extra }),
    ]);
  }

  it("思考条目进日志、默认折叠、展开后按 Markdown 渲染", () => {
    renderRunDetail(withThinking({}), { activeTab: "loop" });
    const rows = [...document.querySelectorAll(".log-entries .log-entry")];
    const think = rows.find((r) => (r.textContent ?? "").includes("思考过程"))!;
    expect(think, "思考条目没进日志——大概率是 reducer 白名单投影又丢字段了").toBeTruthy();
    // 标题带字数，正文默认折叠（思考比正文长得多，展开会淹没时间线）
    expect(think.textContent).toContain("字");
    expect(think.querySelector(".log-thinking")).toBeNull();
  });

  it("redacted 照实说明，不假装没发生过", () => {
    const s = withThinking({ text: "", redacted: true });
    renderRunDetail(s, { activeTab: "loop" });
    const rows = [...document.querySelectorAll(".log-entries .log-entry")];
    expect(rows.some((r) => (r.textContent ?? "").includes("已加密"))).toBe(true);
  });
});

describe("计划确认门的签字位", () => {
  const PLAN = {
    type: "plan",
    concurrency: 2,
    concurrencyMode: "auto",
    plannerMs: 100,
    gated: true,
    subtasks: [
      { id: "s1", title: "一", description: "", acceptance: [], dependsOn: [] },
      { id: "s2", title: "二", description: "", acceptance: [], dependsOn: ["s1"] },
    ],
  };

  function gatedState(extra: any[] = []) {
    let s = createInitialState("run-g", "编排任务", false);
    return reduceEvents(s, [
      sse(0, "host", "turn_start", { turn: 1 }),
      { seq: 1, source: "host", event: PLAN },
      sse(2, "host", "plan_approval_request", { at: 1000 }),
      ...extra,
    ]);
  }

  const rail = () => document.querySelector(".plan-gate") as HTMLElement;

  it("挂起时渲染出可点的批准/否决，并说明此刻否决零副作用", () => {
    renderRunDetail(gatedState(), { activeTab: "loop" });
    expect(rail().hasAttribute("hidden")).toBe(false);
    const text = rail().textContent ?? "";
    expect(text).toContain("计划待你签字");
    expect(text).toContain("2"); // 子任务数
    expect(text).toContain("没有任何副作用");
    expect(rail().querySelector("[data-action='approve']")).toBeTruthy();
    expect(rail().querySelector("[data-action='reject']")).toBeTruthy();
  });

  it("点击真的把决定送出去（行为断言，不是「按钮在不在」）", () => {
    const decisions: string[] = [];
    renderRunDetail(gatedState(), {
      activeTab: "loop",
      onPlanDecision: (d: string) => decisions.push(d),
    });
    (rail().querySelector("[data-action='reject']") as HTMLElement).click();
    expect(decisions).toEqual(["reject"]);
    (rail().querySelector("[data-action='approve']") as HTMLElement).click();
    expect(decisions).toEqual(["reject", "approve"]);
  });

  it("已决后从待办区消失——审计记录归 Plan 面，同一条不在两处重复", () => {
    const s = gatedState([
      sse(3, "host", "plan_approval_resolved", {
        requestSeq: 2, decision: "approve", actor: "user", at: 1700000000000,
      }),
    ]);
    renderRunDetail(s, { activeTab: "loop" });
    expect(rail().hasAttribute("hidden")).toBe(true);
    expect(rail().textContent).toBe("");
  });

  it("没开门的 run 不渲染签字位（默认关，不打扰主路径）", () => {
    let s = createInitialState("run-p", "编排任务", false);
    s = reduceEvents(s, [{ seq: 0, source: "host", event: { ...PLAN, gated: false } }]);
    renderRunDetail(s, { activeTab: "loop" });
    expect(rail().hasAttribute("hidden")).toBe(true);
  });

  it("否决收尾后页头说的是「计划未获批准」，不是「异常终止」", () => {
    const s = gatedState([
      sse(3, "host", "plan_approval_resolved", { requestSeq: 2, decision: "reject", actor: "user", at: 5 }),
      sse(4, "main", "done", { stopReason: "plan_rejected", messageCount: 0, usage: {} }),
      sse(5, "host", "run_end", { outcome: "rejected", mainStopReason: "plan_rejected" }),
    ]);
    renderRunDetail(s, { activeTab: "loop" });
    const head = document.querySelector(".detail-head")?.textContent ?? document.body.textContent ?? "";
    expect(head).toContain("计划未获批准");
    expect(head).not.toContain("异常终止");
  });
});

describe("思考流式：直播条在正文之前显示它在想什么", () => {
  function running() {
    let s = createInitialState("run-th", "任务", false);
    return reduceEvents(s, [sse(0, "main", "turn_start", { turn: 1 })]);
  }
  const liveText = () => document.querySelector(".live-strip .live-text")?.textContent ?? "";

  it("只有思考增量时显示思考（此前这段是「等待模型响应…」的空窗）", () => {
    renderRunDetail(running(), { activeTab: "loop", liveThinking: "先看 package.json 再决定" });
    expect(liveText()).toContain("✽");
    expect(liveText()).toContain("package.json");
    expect(liveText()).not.toContain("等待模型响应");
  });

  it("正文一来就压过思考——它已经想完了", () => {
    renderRunDetail(running(), {
      activeTab: "loop",
      liveThinking: "还在想",
      liveText: "我先读一下配置",
    });
    expect(liveText()).toContain("我先读一下配置");
    expect(liveText()).not.toContain("还在想");
  });

  it("两者都空时退回原行为", () => {
    renderRunDetail(running(), { activeTab: "loop" });
    expect(liveText()).toContain("等待模型响应");
  });
});


// ================================================================
// 「需你决定」的固定坞（委托方建议的结构解法）
// ================================================================

describe("需你决定：钉在输入框上方的固定坞", () => {
  const dock = () => document.getElementById("action-dock") as HTMLElement;
  const rail = () => document.querySelector(".action-rail") as HTMLElement;

  /**
   * 结构约束：坞必须在滚动容器【外面】。
   *
   * 这是整件事的根据——在里面它就会被内容推走，得靠滚动补偿去追；
   * 在外面它变高变矮只改变滚动容器的高度，容器里的内容一动不动。
   * 哪天有人把它挪回 #main-area 里，这条会当场炸。
   */
  it("坞在 #main-area 之外，且排在提交栏之前", () => {
    const main = document.getElementById("main-area")!;
    expect(main.contains(dock())).toBe(false);
    const form = document.querySelector("#task-form, form")!;
    // compareDocumentPosition：FOLLOWING 表示 form 在 dock 之后
    expect(dock().compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /**
   * 实测抓到的接线漏：坞在 HTML 里初始 hidden，渲染层却只切了里面的 rail。
   * 结果 rail 显示了、坞还盖着，整块「需你决定」永远看不见——
   * 而所有既有测试都只查 `.deny-reason` 之类的节点存在性，隐藏与否照样通过。
   */
  it("有待办时坞与栏一起露出，没待办时一起收起", () => {
    const s = stateWithPendingApproval();
    renderRunDetail(s, { activeTab: "loop" });
    expect(rail().hasAttribute("hidden"), "有待审批却仍隐藏 action-rail").toBe(false);
    expect(dock().hasAttribute("hidden"), "有待审批却仍隐藏 action-dock").toBe(false);

    const idle = createInitialState("run-idle", "无审批任务", true);
    renderRunDetail(idle, { activeTab: "loop" });
    expect(dock().hasAttribute("hidden"), "没待办时坞不该占位").toBe(true);
  });

  it("审批卡渲染在坞里，不在滚动区里", () => {
    renderRunDetail(stateWithPendingApproval(), { activeTab: "loop" });
    const card = document.querySelector(".approval-card")!;
    expect(dock().contains(card)).toBe(true);
    expect(document.getElementById("main-area")!.contains(card)).toBe(false);
  });
});

// ================================================================
// 换标签再切回：对话视图不许白屏
// ================================================================

describe("换标签重建时对话视图的签名要一起作废", () => {
  const transcript = {
    segments: [{
      index: 0, source: "main",
      messages: [
        { role: "user", content: "记住暗号 alpha-7" },
        { role: "assistant", content: [{ type: "text", text: "记住了。" }] },
      ],
    }],
  };

  function doneState() {
    let s = createInitialState("run-chat", "记住暗号", false);
    s = reduceEvents(s, [
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "main", "done", { stopReason: "completed", usage: { turns: 1 } }),
    ]);
    return s;
  }

  /**
   * 换标签时 `.tab-content` 整体重建，`.chat-view` 变成空 div；若只清
   * `sig.tabBody` 而漏了 `sig.chat`，patchLoopView 看签名没变直接提前 return，
   * 于是**整段对话白屏，且没有任何报错**。
   */
  it("loop → tools → loop 之后对话内容还在", () => {
    const s = doneState();
    const opts = { harness: null, loopView: "chat", transcript } as any;
    renderRunDetail(s, { ...opts, activeTab: "loop" });
    expect(document.querySelector(".chat-view")!.textContent).toContain("记住了");

    renderRunDetail(s, { ...opts, activeTab: "tools" });
    renderRunDetail(s, { ...opts, activeTab: "loop" });
    expect(
      document.querySelector(".chat-view")!.textContent,
      "换标签再切回，对话整段消失了",
    ).toContain("记住了");
  });
});

// ================================================================
// 重连横幅：正常收尾不是断线
// ================================================================

describe("shouldShowReconnecting：分辨正常收流与真断线", () => {
  it("服务端列表说已完成 → 不报断线（点开历史运行走的就是这条）", () => {
    // 本地 status 此刻还是 createInitialState 的默认 "running"——那不是观测
    expect(shouldShowReconnecting({ info: { status: "done" }, localStatus: "running" })).toBe(false);
  });

  it("本地已收到 run_end → 不报断线（列表还没刷新时走这条）", () => {
    expect(shouldShowReconnecting({ info: { status: "running" }, localStatus: "done" })).toBe(false);
  });

  it("两边都说在跑 → 这才是真断线", () => {
    expect(shouldShowReconnecting({ info: { status: "running" }, localStatus: "running" })).toBe(true);
  });

  it("什么都不知道时按断线处理——宁可多提示一次，也不要静默失联", () => {
    expect(shouldShowReconnecting({})).toBe(true);
  });
});

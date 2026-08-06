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

    const cards = [...document.querySelectorAll(".approval-card")];
    expect(cards).toHaveLength(2);
    expect(cards[0]).toBe(firstCard); // 第一轮那张原地存活
    expect(cards[0].querySelector(".approval-result")!.textContent).toBe("已允许");
    expect(cards[1].querySelector("[data-action='allow']")).toBeTruthy(); // 新的一张可操作
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

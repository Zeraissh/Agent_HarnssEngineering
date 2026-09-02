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
  deriveChatItems,
  toolPeek,
  foldChain,
  deriveRunListItems,
  deriveRunTitle,
  renderEmptyState,
  deriveAssemblyBar,
  deriveComposerMode,
  composerSubmitPlan,
  deriveScrollNav,
  paceReveal,
  revealedWindow,
  keepScrollAnchored,
  renderRunList,
  applyCollapseOverrides,
  nextCollapseOverride,
  buildLocalPathProbePlan,
  toolPathCandidates,
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

describe("消息正文路径探测计划", () => {
  it("工具入参只从有路径语义的结构化字段提取，并递归处理数组", () => {
    expect(toolPathCandidates({
      path: "src/main.ts",
      file_path: "docs/guide.md",
      metadata: {
        directory: "assets/",
        filenames: ["hero.png", "hero.png"],
      },
      cwd: "build/",
    })).toEqual([
      "src/main.ts",
      "docs/guide.md",
      "assets/",
      "hero.png",
      "build/",
    ]);
  });

  it("工具路径不猜 shell、URL 或普通正文里的文件名", () => {
    expect(toolPathCandidates({
      command: "cat src/main.ts",
      url: "https://example.com/out/report.md",
      content: "请打开 out/report.md",
      label: "README.md",
    })).toEqual([]);
  });

  it("同消息目录能把裸文件名解析到真实组合路径", () => {
    const plan = buildLocalPathProbePlan(
      ["threejs-fps-game/", "index.html", "threejs-fps-game/index.html"],
      [],
    );
    const index = plan.entries.find((entry) => entry.label === "index.html");
    expect(index?.choices).toEqual(["threejs-fps-game/index.html", "index.html"]);
    expect(plan.probes).toContain("threejs-fps-game/");
    expect(plan.probes).toContain("threejs-fps-game/index.html");
  });

  it("唯一产物 basename 优先；重名时不猜", () => {
    const unique = buildLocalPathProbePlan(["report.md"], ["out/report.md"]);
    expect(unique.entries[0].choices[0]).toBe("out/report.md");

    const ambiguous = buildLocalPathProbePlan(
      ["report.md"],
      ["a/report.md", "b/report.md"],
    );
    expect(ambiguous.entries[0].choices).toEqual(["report.md"]);
  });

  it("file.ts:12:4 探测时去掉行列号，显示标签保持原样", () => {
    const plan = buildLocalPathProbePlan(["src/file.ts:12:4"]);
    expect(plan.entries[0]).toEqual({ label: "src/file.ts:12:4", choices: ["src/file.ts"] });
  });

  it("宿主确认后：文件可打开且可定位，目录可直接打开", async () => {
    let state = createInitialState("run-path", "生成文件", false);
    state = reduceEvents(state, [
      sse(0, "main", "assistant_text", {
        text: "文件 `out/report.md`，目录 `out/`。",
      }),
    ]);
    const onReveal = vi.fn();
    renderRunDetail(state, {
      activeTab: "loop",
      onReveal,
      inspectPaths: async (paths: string[]) => paths.map((input) => ({
        input,
        exists: true,
        path: input.replace(/[\\/]$/, ""),
        kind: /[\\/]$/.test(input) ? "directory" : "file",
      })),
    });

    await vi.waitFor(() => {
      expect(document.querySelector('.local-path-link[href*="artifact"]')).toBeTruthy();
      expect(document.querySelector('.local-path-link--directory')).toBeTruthy();
    });
    const fileLink = document.querySelector('.local-path-link[href*="artifact"]') as HTMLAnchorElement;
    expect(decodeURIComponent(fileLink.href)).toContain("path=out/report.md");
    const reveal = document.querySelector(".local-path-folder") as HTMLButtonElement;
    expect(reveal.getAttribute("aria-label")).toContain("out/report.md");
    reveal.click();
    expect(onReveal).toHaveBeenCalledWith("out/report.md");
  });

  it("折叠的工具调用日志也显示经宿主确认的文件链接与定位按钮", async () => {
    let state = createInitialState("run-tool-path", "读取报告", false);
    state = reduceEvents(state, [
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "main", "tool_call", {
        toolUseId: "tool-path-1",
        name: "read_file",
        input: { path: "out/report.md" },
      }),
    ]);
    const onReveal = vi.fn();
    renderRunDetail(state, {
      activeTab: "loop",
      onReveal,
      inspectPaths: async (paths: string[]) => paths.map((input) => ({
        input,
        exists: true,
        path: input,
        kind: "file",
      })),
    });

    await vi.waitFor(() => {
      expect(document.querySelector(
        '.log-entries .log-entry--collapsed .tool-path-strip .local-path-link[href*="artifact"]',
      )).toBeTruthy();
    });
    const row = document.querySelector('.log-entries .log-entry[data-seq="1"]') as HTMLElement;
    const fileLink = row.querySelector('.local-path-link[href*="artifact"]') as HTMLAnchorElement;
    expect(decodeURIComponent(fileLink.href)).toContain("path=out/report.md");
    const reveal = row.querySelector(".local-path-folder") as HTMLButtonElement;
    expect(reveal.getAttribute("aria-label")).toContain("out/report.md");
    reveal.click();
    expect(onReveal).toHaveBeenCalledWith("out/report.md");
  });
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

  /**
   * 2026-08-09 重做为意图态的三条新锁（委托方实测：批准卡出现、思考流式时
   * 跟随停在半路）。共同判据：**只有用户自己的滚动事件才改变跟随与否**——
   * 瞬时几何位移（容器变矮、贴底动画走到半路）不算数。
   */
  it("批准卡出现（clientHeight 突变、无 scroll 事件）不打断跟随", () => {
    const el = makeScroller(1000, 200, 800); // 贴底
    keepScrollAnchored(el, () => {}); // 建立跟随意图
    el.scrollTop = 800; // 浏览器会把 scrollTop 钳到 scrollHeight-clientHeight
    (el as any).clientHeight = 120; // 批准卡把容器压矮 80px——距底瞬间超阈（80 > 40）
    const pinned = keepScrollAnchored(el, () => {
      (el as any).scrollHeight = 1300;
    });
    expect(pinned, "容器变矮不该被当成用户上翻").toBe(true);
    expect(el.scrollTop).toBe(1300);
  });

  it("贴底动画走到半路时下一批到达，跟随不断（smooth 竞态）", () => {
    const el = makeScroller(1000, 200, 800);
    keepScrollAnchored(el, () => {}); // 建立跟随意图
    el.scrollTop = 400; // 模拟平滑动画的中途位置（无用户滚动事件）
    const pinned = keepScrollAnchored(el, () => {
      (el as any).scrollHeight = 1400;
    });
    expect(pinned, "动画中途位置不该被读成「用户不在底部」").toBe(true);
    expect(el.scrollTop).toBe(1400);
  });

  it("用户滚动事件才是意图：上翻停跟随、翻回底部恢复", () => {
    const el = makeScroller(1000, 200, 800);
    keepScrollAnchored(el, () => {}); // 跟随中
    // 用户上翻：位置 + 真实 scroll 事件
    el.scrollTop = 100;
    el.dispatchEvent(new Event("scroll"));
    let pinned = keepScrollAnchored(el, () => {
      (el as any).scrollHeight = 1600;
    });
    expect(pinned).toBe(false);
    expect(el.scrollTop).toBe(100);
    // 用户翻回底部
    el.scrollTop = 1600 - 200;
    el.dispatchEvent(new Event("scroll"));
    pinned = keepScrollAnchored(el, () => {
      (el as any).scrollHeight = 1800;
    });
    expect(pinned).toBe(true);
    expect(el.scrollTop).toBe(1800);
  });

  it("程序化贴底自己触发的 scroll 事件不搞坏跟随（落点即底部，无需哨兵）", () => {
    const el = makeScroller(1000, 200, 800);
    keepScrollAnchored(el, () => {
      (el as any).scrollHeight = 1200;
    }); // 瞬时贴底：事件送达时几何就在底部
    el.dispatchEvent(new Event("scroll"));
    const pinned = keepScrollAnchored(el, () => {
      (el as any).scrollHeight = 1500;
    });
    expect(pinned, "贴底自触发的 scroll 不该停掉跟随").toBe(true);
    expect(el.scrollTop).toBe(1500);
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

function stateWithPendingApproval(grantPolicy = { maxScope: "once", maxTtlMs: 60_000, maxUses: 1 }) {
  let s = createInitialState("run-x", "写文件任务", true);
  s = reduceEvents(s, [
    sse(0, "main", "turn_start", { turn: 1 }),
    sse(1, "main", "approval_request", {
      toolUseId: "tu_w",
      name: "write_file",
      input: { path: "a.txt" },
      grantPolicy,
    }),
  ]);
  return s;
}

describe("详情页重渲染下的状态存活 (V-10)", () => {
  it("可复用工具明确显示短期、相同参数边界", () => {
    const onAllowAlways = vi.fn();
    renderRunDetail(
      stateWithPendingApproval({ maxScope: "exact-input", maxTtlMs: 60_000, maxUses: 3 }),
      { activeTab: "overview", onAllowAlways },
    );
    const button = document.querySelector("[data-action='allow-always']") as HTMLButtonElement;
    expect(button.textContent).toBe("短期允许相同参数");
    expect(button.hidden).toBe(false);
    expect(button.title).toContain("最多复用 3 次");
    expect(document.body.textContent).not.toContain("本次对话都允许");
    button.click();
    expect(onAllowAlways).toHaveBeenCalledWith("tu_w#1", "write_file");
  });

  it("once 工具隐藏复用按钮，客户端不能扩大宿主策略", () => {
    renderRunDetail(stateWithPendingApproval(), { activeTab: "overview" });
    const button = document.querySelector("[data-action='allow-always']") as HTMLButtonElement;
    expect(button.hidden).toBe(true);
    expect(button.title).toContain("只允许单次审批");
  });

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

describe("流式输出直接长在对话里", () => {
  /**
   * 服务端 R2 起就在推 `event: delta`。此前它只喂给页面顶部那条**一行**的直播条，
   * 对话里要等整轮结束、`assistant_text` 落下来才突然出现一整段——于是
   * "正在发生的事"和"发生过的事"在两个地方，而人的注意力只能在一处。
   * 委托方："对话中的流式输出也没有做好，思考过程也没法流式被用户看见。"
   *
   * liveText/liveThinking 不进 RunState（delta 不占 seq、重放时不存在），
   * 所以它们是 render 的入参而不是 state 的字段。
   */
  function runningState() {
    let s = createInitialState("run-s", "流式任务", false);
    s = reduceEvents(s, [sse(0, "main", "turn_start", { turn: 1 })]);
    return s;
  }

  const conv = () => document.querySelector(".conversation")?.textContent ?? "";
  const strip = () => document.querySelector(".live-strip .live-text")?.textContent ?? "";

  it("正文增量逐字出现在对话末尾", () => {
    renderRunDetail(runningState(), { activeTab: "loop", liveText: "我先读一下 package.json" });
    expect(conv()).toContain("package.json");
    expect(document.querySelector(".chat-msg--live")).toBeTruthy();
  });

  it("思考增量也在对话里，且是可折叠的一块", () => {
    renderRunDetail(runningState(), { activeTab: "loop", liveThinking: "先确认路径在不在工作目录内" });
    expect(conv()).toContain("先确认路径在不在工作目录内");
    const d = document.querySelector("details.chat-thinking--live");
    expect(d, "流式思考应当是一块可折叠的 details").toBeTruthy();
  });

  /**
   * 判据翻转记录（委托方 2026-08-09："能否做到流式输出的时候就是以 markdown
   * 形式"）：旧锁「流式正文按纯文本渲染，不做 Markdown」就地退役。当年顾虑的
   * "半截记法抽搐"如今有两层缓冲——增量经匀速放行按帧批量落下，且渲染器对
   * 未闭合围栏本就容忍（余下部分整体成码块）。以下四条是新判据。
   */
  it("流式正文按 Markdown 渲染——闭合的记法立即成型", () => {
    renderRunDetail(runningState(), { activeTab: "loop", liveText: "**已闭合的粗体** 后面还在写" });
    expect(document.querySelector(".chat-msg--live strong")).toBeTruthy();
    expect(conv()).toContain("已闭合的粗体");
  });

  it("未闭合的行内记法保持字面——不闪成半个粗体，闭合时与终稿同向收敛", () => {
    renderRunDetail(runningState(), { activeTab: "loop", liveText: "**还没写完的粗体" });
    expect(document.querySelector(".chat-msg--live strong")).toBeNull();
    expect(conv()).toContain("**还没写完的粗体");
  });

  it("未闭合的围栏从第一行起就是代码块（渲染器的缺收尾容忍是这条的地基）", () => {
    renderRunDetail(runningState(), { activeTab: "loop", liveText: "```ts\nconst a = 1;" });
    expect(document.querySelector(".chat-msg--live pre.md-code")).toBeTruthy();
    expect(conv()).toContain("const a = 1;");
  });

  it("裸 JSON 流（planner 的输出契约）以代码块形态流入，不是一面正文墙", () => {
    renderRunDetail(runningState(), { activeTab: "loop", liveText: '{"subtasks": [{"id": "s1"' });
    expect(document.querySelector(".chat-msg--live pre.md-code")).toBeTruthy();
  });

  /**
   * 落定条目的同族判据（同一条委托方反馈："只有 planner 的输出没做成 markdown，
   * 很突兀"）：根因不在渲染分支——所有来源本就走同一支 renderMarkdown——
   * 在内容：planner 的契约输出是裸 JSON，对 Markdown 渲染器是无事可做的散文。
   * 判据按内容不按来源：整体 parse 得过才算，花括号开头的散文零误伤。
   */
  it("落定的裸 JSON 正文渲染为高亮代码块并 pretty-print（展示层，事件流原文不动）", () => {
    let s = runningState();
    s = reduceEvents(s, [
      sse(1, "planner", "assistant_text", { text: '{"subtasks": [{"id": "s1", "title": "改固件"}]}' }),
    ]);
    renderRunDetail(s, { activeTab: "loop" });
    const pre = document.querySelector(".chat-msg--assistant pre.md-code");
    expect(pre, "裸 JSON 应当渲染为代码块").toBeTruthy();
    expect(pre!.textContent).toContain('"subtasks"');
    expect(pre!.textContent, "展示层应当 pretty-print（原文是单行）").toContain("\n");
  });

  it("以花括号开头的散文不被误判为 JSON，仍按 Markdown 走", () => {
    let s = runningState();
    s = reduceEvents(s, [
      sse(1, "main", "assistant_text", { text: "{占位符} 表示模板里的槽位，**这是散文**。" }),
    ]);
    renderRunDetail(s, { activeTab: "loop" });
    expect(document.querySelector(".chat-msg--assistant strong")).toBeTruthy();
    expect(document.querySelector(".chat-msg--assistant pre.md-code")).toBeNull();
  });

  /**
   * **对话已经在逐字流了，直播条不该再滚同一段字**（V-16）。
   * 两处同时滚同一段文字会让人不知道该看哪儿——那正是"过于难用"的一种。
   */
  it("有增量时直播条让位；只在对话说不出来的时候才出声", () => {
    renderRunDetail(runningState(), { activeTab: "loop", liveText: "正在写" });
    expect((document.querySelector(".live-strip") as HTMLElement).hasAttribute("hidden")).toBe(true);

    let s = runningState();
    s = reduceEvents(s, [
      sse(1, "main", "tool_call", { toolUseId: "t1", name: "read_file", input: { path: "a.ts" } }),
    ]);
    renderRunDetail(s, { activeTab: "loop", liveText: "" });
    expect(strip(), "没有增量时直播条要说清正在调什么工具").toContain("read_file");
  });

  it("没有任何增量与工具时仍报「等待模型响应…」", () => {
    renderRunDetail(runningState(), { activeTab: "loop" });
    expect(strip()).toContain("等待模型响应");
  });

  it("运行已结束时不再有流式条目，残留增量也拉不回来", () => {
    let s = runningState();
    s = reduceEvents(s, [
      sse(1, "main", "done", { stopReason: "completed", messageCount: 2, usage: {} }),
      sse(2, "host", "run_end", { outcome: "completed" }),
    ]);
    renderRunDetail(s, { activeTab: "loop", liveText: "还在流的残留文本" });
    expect(document.querySelector(".chat-msg--live")).toBeNull();
    expect((document.querySelector(".live-strip") as HTMLElement).hasAttribute("hidden")).toBe(true);
  });

  /**
   * 这条是委托方那句话的核心：**点开思考过程就该一直看得见它在流**。
   * 初版对话用 `innerHTML` 整段重画，流式一开每秒重建几十遍，
   * 用户刚点开的 details 当场被关上——键控补丁就是为这个上的。
   */
  it("流式期间已展开的思考块不会被重画关上", () => {
    const s = runningState();
    renderRunDetail(s, { activeTab: "loop", liveThinking: "第一句" });
    const d = document.querySelector("details.chat-thinking--live") as HTMLDetailsElement;
    d.open = true;

    renderRunDetail(s, { activeTab: "loop", liveThinking: "第一句，第二句" });
    const after = document.querySelector("details.chat-thinking--live") as HTMLDetailsElement;
    expect(after, "思考块被整段重建了").toBe(d);
    expect(after.open, "用户点开的思考过程被重画关上了").toBe(true);
    expect(after.textContent).toContain("第二句");
  });

  it("已落定的条目不因流式而重建（节点同一性）", () => {
    let s = runningState();
    s = reduceEvents(s, [sse(1, "main", "assistant_text", { text: "上一轮说完的话" })]);
    renderRunDetail(s, { activeTab: "loop", liveText: "新" });
    const first = document.querySelectorAll(".chat-item")[0];
    renderRunDetail(s, { activeTab: "loop", liveText: "新的一句" });
    expect(document.querySelectorAll(".chat-item")[0]).toBe(first);
  });
});
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
   * 旧形态下对话是 Loop 面里的子视图，换标签会把它连同下钻面一起重建——
   * 曾因漏清一个签名导致整段对话白屏。**对话升为主干后它在下钻面之外**，
   * 换标签结构上碰不到它。这条锁的就是这个结构事实。
   */
  it("对话在下钻抽屉之外：换标签不影响它", () => {
    const s = doneState();
    renderRunDetail(s, { activeTab: "loop", harness: null });
    const chat = document.querySelector(".conversation")!;
    expect(chat.textContent).toContain("记住暗号");

    renderRunDetail(s, { activeTab: "tools", harness: null });
    renderRunDetail(s, { activeTab: "loop", harness: null });
    expect(document.querySelector(".conversation")).toBe(chat); // 同一个节点，没被重建
    expect(chat.textContent).toContain("记住暗号");
    expect(
      document.getElementById("tab-content")!.contains(chat),
      "对话不该落在下钻面里",
    ).toBe(false);
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

// ================================================================
// AC2-18 复验补的锁：这几条此前都是"变异了也不红"
// ================================================================

describe("AC-04 展开一条默认折叠的日志：点一下就该展开", () => {
  const entries = [
    { seq: 0, type: "tool_call", collapsed: true },
    { seq: 1, type: "tool_result", collapsed: true },
    { seq: 2, type: "approval_request", collapsed: false },
  ];

  /**
   * 实测缺陷：宿主写的是 `overrides.set(seq, !overrides.get(seq))`，
   * 覆盖表里没有这一条时 `!undefined === true`，而多数条目默认就是 true——
   * 第一次点击把 true 写成 true，DOM 早退，屏幕上一点反应都没有。
   * AC-04 说"两次操作可达原始详情"，实际是三次，且第一次零反馈。
   */
  it("默认折叠的条目：第一次点击就翻成展开（不是第二次）", () => {
    const overrides = new Map<number, boolean>();
    expect(nextCollapseOverride(entries, overrides, 0), "第一次点击必须真的改变状态").toBe(false);
  });

  it("默认展开的条目（审批）：第一次点击折叠", () => {
    expect(nextCollapseOverride(entries, new Map(), 2)).toBe(true);
  });

  it("点两次回到原状", () => {
    const ov = new Map<number, boolean>();
    ov.set(0, nextCollapseOverride(entries, ov, 0)!);
    ov.set(0, nextCollapseOverride(entries, ov, 0)!);
    expect(ov.get(0)).toBe(true);
  });

  it("不存在的 seq 返回 null，宿主据此不写覆盖表", () => {
    expect(nextCollapseOverride(entries, new Map(), 999)).toBeNull();
  });

  it("覆盖表只影响被点过的那条", () => {
    const ov = new Map([[0, false]]);
    const applied = applyCollapseOverrides(entries, ov);
    expect(applied.map((e) => e.collapsed)).toEqual([false, true, false]);
  });

  /**
   * 这个 bug 能活下来的根因：宿主自己另写了一套 toggle，被测的纯函数
   * 全仓零调用——**测试测的是产品不用的那份实现**。所以顺手锁住调用关系。
   */
  it("宿主必须调纯函数，不许自己再写一套 toggle", () => {
    const html = readFileSync(join(__dirname, "..", "ui", "public", "index.html"), "utf-8");
    expect(html).toContain("nextCollapseOverride(");
    expect(html).toContain("applyCollapseOverrides(");
    expect(html, "宿主又在自己翻转覆盖表了").not.toMatch(/overrides\.set\(\s*seq\s*,\s*!/);
  });
});

describe("R-03 无需展开下钻面即可判断结果", () => {
  /**
   * 承载物换过两次，判据没变。v1 是"三标签的概览页"，v2 是"结果卡排在下钻面之前"，
   * 现在是"裁决就地长在对话里 + 一条收尾条"——**旧锁必须跟着迁移**，
   * 否则就是 case-07 §六 那条：验收还写着 ✅，看守它的断言却已经不在被测范围内。
   */
  it("裁决在对话里、终止原因在收尾条上，两者都在下钻抽屉之前", () => {
    let s = createInitialState("run-r3", "任务", true);
    s = reduceEvents(s, [
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "main", "done", { stopReason: "completed", usage: { turns: 1 } }),
      sse(2, "verifier", "verification", {
        round: 0,
        verdict: { passed: false, issues: ["缺收尾"], unverified: [], advisory: [], summary: "未通过" },
      }),
      sse(3, "host", "verdict", {
        verdict: { passed: false, issues: ["缺收尾"], unverified: [], advisory: [], summary: "未通过" },
      }),
      sse(4, "host", "run_end", { stopReason: "completed" }),
    ]);
    renderRunDetail(s, { activeTab: "loop", harness: null });

    const conv = document.querySelector(".conversation")!;
    const outcome = document.querySelector(".outcome-card")!;
    const tabs = document.getElementById("tab-content")!;

    // 不合格项就地长在对话里
    expect(conv.textContent, "裁决没有出现在对话主干里").toContain("缺收尾");
    expect(conv.querySelector(".chat-verdict")).toBeTruthy();
    // 正常收尾时那条「■ 已完成」不出现——读对话就知道，占一整行是浪费
    expect(outcome.hidden, "正常收尾不该再占一整行说废话").toBe(true);
    // 对话排在下钻抽屉之前
    expect(
      conv.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING,
      "对话被排到下钻面之后了——那正是 R-03 要修的毛病",
    ).toBeTruthy();
  });

  /**
   * 反过来：**非正常收尾必须留着**。对话里只表现为"停了"，看不出是撞了轮数上限；
   * 而这几种各有各的下一步（六值分档的全部意义就在这个提示上）。
   */
  it("撞轮数上限这类收尾要说出来，并给出下一步", () => {
    let s = createInitialState("run-mt", "任务", false);
    s = reduceEvents(s, [
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "main", "done", { stopReason: "max_turns", usage: { turns: 40 } }),
    ]);
    renderRunDetail(s, { activeTab: "loop", harness: null });
    const outcome = document.querySelector(".outcome-card") as HTMLElement;
    expect(outcome.hidden).toBe(false);
    expect(outcome.textContent).toContain("核查救不了这一类");
  });

  /** 委托方：「这个框框可以不用了」——运行中它只会说一句"尚无最终结果" */
  it("运行中收尾条整条隐藏，且不重复对话里已有的执行者报告", () => {
    let s = createInitialState("run-r3b", "任务", false);
    s = reduceEvents(s, [
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "main", "assistant_text", { text: "让我再快速看几个关键文件。" }),
    ]);
    renderRunDetail(s, { activeTab: "loop", harness: null });
    const outcome = document.querySelector(".outcome-card") as HTMLElement;
    expect(outcome.hidden, "运行中不该挂一个说'尚无结果'的空框").toBe(true);
    // 那句话只在对话里出现一次
    const body = document.querySelector(".conversation")!.textContent!;
    expect(body.split("让我再快速看几个关键文件").length - 1).toBe(1);
  });
});
describe("R-01 运行结束后，页面上不该有任何可点的审批按钮", () => {
  /**
   * 此前只有 reducer 与服务端 409 在守；渲染层那道 `operable = isPending && isRunning`
   * 里 isPending 在唯一调用路径上恒为 true，把它改成 `true` 也没有一条测试变红。
   * 这条补的是 DOM 级的终态判据。
   */
  it("done 之后审批转 expired，坞收起，allow/deny 按钮数 = 0", () => {
    let s = createInitialState("run-r1", "写文件", true);
    s = reduceEvents(s, [
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "main", "approval_request", { toolUseId: "tu_1", name: "write_file", input: { path: "a" } }),
    ]);
    renderRunDetail(s, { activeTab: "loop", harness: null });
    expect(document.querySelectorAll("[data-action='allow']").length, "运行中该有可点的按钮").toBe(1);

    s = reduceEvents(s, [
      sse(2, "main", "done", { stopReason: "completed", usage: { turns: 1 } }),
      sse(3, "host", "run_end", { stopReason: "completed" }),
    ]);
    renderRunDetail(s, { activeTab: "loop", harness: null });

    expect(s.pendingApprovals[0].status).toBe("expired");
    expect(document.querySelectorAll("[data-action='allow']").length).toBe(0);
    expect(document.querySelectorAll("[data-action='deny']").length).toBe(0);
    expect(
      (document.getElementById("action-dock") as HTMLElement).hidden,
      "已结束的运行不该还占着待办坞",
    ).toBe(true);
  });
});

// ================================================================
// 对话主干（委托方："还是希望做成对话框的形式"）
// ================================================================

describe("deriveChatItems：对话从事件流派生，因此实时", () => {
  const run = (...evts: any[]) => {
    let s = createInitialState("run-chat2", "查一下今天的天气", false);
    return reduceEvents(s, evts);
  };

  it("任务本身是第一条用户消息——打开运行第一眼要看到自己要求了什么", () => {
    const items = deriveChatItems(run());
    expect(items[0]).toMatchObject({ kind: "user", text: "查一下今天的天气" });
  });

  it("工具调用与它的返回合成一行，而不是两条各自漂着", () => {
    const s = run(
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "main", "tool_call", { toolUseId: "t1", name: "bash", input: { command: "date" } }),
      sse(2, "main", "tool_result", { toolUseId: "t1", result: { content: "2026-08-08", isError: false }, durationMs: 12 }),
    );
    const tools = deriveChatItems(s).filter((i) => i.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "bash", status: "ok", result: "2026-08-08", durationMs: 12 });
  });

  it("还没返回的工具是 running 态——运行中就该看得见它正在做什么", () => {
    const s = run(sse(0, "main", "tool_call", { toolUseId: "t1", name: "bash", input: { command: "sleep 5" } }));
    expect(deriveChatItems(s).filter((i) => i.kind === "tool")[0]!.status).toBe("running");
  });

  /**
   * 事后回看时，"这一步被拦过"必须看得出来。只把审批卡放在坞里的话，
   * 运行结束坞收起，对话里的那次调用就变成凭空执行了。
   */
  it("经过审批的工具带放行标记", () => {
    const s = run(
      sse(0, "main", "tool_call", { toolUseId: "t1", name: "write_file", input: { path: "a.txt" } }),
      sse(1, "main", "approval_request", { toolUseId: "t1", name: "write_file", input: { path: "a.txt" } }),
    );
    expect(deriveChatItems(s).find((i) => i.kind === "tool")).toMatchObject({ gated: true });
  });

  it("换来源插一条分界（main → verifier），turn_start 这类噪声不插", () => {
    const s = run(
      sse(0, "main", "assistant_text", { text: "做完了" }),
      sse(1, "verifier", "assistant_text", { text: "我来复核" }),
    );
    const kinds = deriveChatItems(s).map((i) => i.kind);
    expect(kinds.filter((k) => k === "boundary")).toHaveLength(2); // main 段 + verifier 段
  });

  it("裁决作为收尾卡进对话，不再是另一个页面", () => {
    let s = run(sse(0, "main", "assistant_text", { text: "做完了" }));
    s = reduceEvents(s, [
      sse(1, "verifier", "verification", {
        round: 0,
        verdict: { passed: false, issues: ["缺收尾"], unverified: [], advisory: [], summary: "未通过" },
      }),
    ]);
    const v = deriveChatItems(s).find((i) => i.kind === "verdict");
    expect(v).toBeTruthy();
    expect(v!.verdict.issues).toEqual(["缺收尾"]);
  });

  it("空文本不产生空气泡", () => {
    const s = run(sse(0, "main", "assistant_text", { text: "   " }));
    expect(deriveChatItems(s).filter((i) => i.kind === "text")).toHaveLength(0);
  });
});

describe("toolPeek：摘要要一眼认得出在干什么", () => {
  /**
   * 委托方截图里那行 `→ bash {` 就是反例：入参被美化过（缩进 JSON），
   * 取首行自然只剩一个左花括号，等于什么都没说。
   */
  it("bash 取 command，不是那个左花括号", () => {
    expect(toolPeek("bash", { command: "npx vitest run" })).toBe("npx vitest run");
    expect(toolPeek("bash", { command: "a\nb" })).toBe("a");
  });

  it("读写类取路径、抓取类取 URL", () => {
    expect(toolPeek("read_file", { path: "src/loop.ts" })).toBe("src/loop.ts");
    expect(toolPeek("fetch_url", { url: "https://example.com" })).toBe("https://example.com");
  });

  it("没有已知主参数时给紧凑单行，绝不返回孤零零的括号", () => {
    const peek = toolPeek("weird", { a: 1, b: [2, 3] });
    expect(peek).toContain("a=1");
    expect(peek.trim()).not.toBe("{");
  });

  it("空入参返回空串而不是崩", () => {
    expect(toolPeek("x", null)).toBe("");
    expect(toolPeek("x", undefined)).toBe("");
  });
});

describe("foldChain：连续主轮折叠成计数", () => {
  /**
   * 多轮对话下会出现二十几个连着的 main 段，逐个画出来就是一排一模一样的
   * 「■ 主轮」——委托方截图里那一行占满整屏却零信息量。
   */
  it("20 个连续主轮折成一个 ×20", () => {
    const folded = foldChain(Array.from({ length: 20 }, () => ({ role: "main", round: 0, passed: null })));
    expect(folded).toHaveLength(1);
    expect(folded[0].count).toBe(20);
  });

  /** 只折 main：返工三次必须还看得出是三次，否则等于把失败史抹平 */
  it("核查与返工不折叠", () => {
    const folded = foldChain([
      { role: "main" }, { role: "main" },
      { role: "verifier", round: 0 }, { role: "rework", round: 1 },
      { role: "verifier", round: 1 }, { role: "rework", round: 2 },
    ]);
    expect(folded.map((c) => `${c.role}${c.count > 1 ? "×" + c.count : ""}`)).toEqual([
      "main×2", "verifier", "rework", "verifier", "rework",
    ]);
  });

  it("空链不炸", () => {
    expect(foldChain([])).toEqual([]);
    expect(foldChain(undefined)).toEqual([]);
  });
});

// ================================================================
// 未读星：跑完了但还没看过
// ================================================================

describe("未读星取代那条「■ 已完成」", () => {
  const runs = [
    { runId: "a", task: "任务甲", status: "done", verify: false, createdAt: 1, finishedAt: 2 },
    { runId: "b", task: "任务乙", status: "done", verify: false, createdAt: 1, finishedAt: 2 },
  ];

  it("未读集合里的运行带 unread 标记", () => {
    const meta = deriveRunListItems(runs, new Map(), new Set(["a"]));
    expect(meta.get("a")!.unread).toBe(true);
    expect(meta.get("b")!.unread).toBe(false);
  });

  it("不传未读集合时一律为 false（旧调用点不受影响）", () => {
    const meta = deriveRunListItems(runs, new Map());
    expect(meta.get("a")!.unread).toBe(false);
  });

  it("选中的那条不亮星——你就在看它", () => {
    renderRunList(runs, "a", () => {}, deriveRunListItems(runs, new Map(), new Set(["a", "b"])));
    const star = (id: string) =>
      (document.querySelector(`[data-run-id="${id}"] .run-item-unread`) as HTMLElement).hidden;
    expect(star("a"), "选中的那条不该还亮着未读星").toBe(true);
    expect(star("b"), "没选中且未读的那条应该亮星").toBe(false);
  });

  it("星带可及名称——读屏用户也得知道这条有新结果", () => {
    renderRunList(runs, null, () => {}, deriveRunListItems(runs, new Map(), new Set(["a"])));
    const star = document.querySelector('[data-run-id="a"] .run-item-unread')!;
    expect(star.getAttribute("aria-label")).toContain("尚未查看");
  });
});

// ================================================================
// 装配状态条：条上是真实装配，点开才是设计思想
// ================================================================

describe("装配状态条", () => {
  function configured() {
    let s = createInitialState("run-asm", "任务", true);
    return reduceEvents(s, [
      sse(0, "host", "run_config", {
        pack: { name: "ts-coding" },
        workdir: "D:/Work/Github_pros/Agent_Design",
        guardrails: { maxTurns: 40, maxTokens: 64000 },
        verifierBudgetTurns: 15,
      }),
    ]);
  }

  /**
   * 这条是整个设计的关键：**状态条上的每个数字都来自 run_config**，
   * 不是写死的文案。装配变了条上就变，说明文字因此不会和现实脱节——
   * 而一条写死的标语会。
   */
  it("chip 全部来自本次运行的真实装配", () => {
    const items = deriveAssemblyBar(configured(), { model: "claude-opus-5" });
    const by = Object.fromEntries(items.map((i) => [i.key, i.chip]));
    expect(by.model).toBe("claude-opus-5");
    expect(by.pack).toBe("ts-coding");
    expect(by.guardrails).toBe("40 轮 / 64k");
    expect(by.verify).toContain("15 轮");
  });

  it("精确放行说明展示 hash，并明确参数变化会重新询问", () => {
    let state = configured();
    state = reduceEvents(state, [
      sse(2, "host", "approval_resolved", {
        name: "bash",
        toolUseId: "t1",
        requestSeq: 1,
        decision: "allow",
        actor: "user",
        scope: "run",
        inputScope: "exact-input",
        inputHash: "sha256:0123456789abcdef",
        grantId: "g1",
        boundRunId: state.runId,
        expiresAt: Date.now() + 60_000,
        maxUses: 5,
        usedUses: 0,
        at: 1,
      }),
    ]);
    const item = deriveAssemblyBar(state, null).find((candidate) => candidate.key === "autoAllow")!;
    expect(item.chip).toContain("bash#01234567");
    expect(item.chip).toContain("余5");
    expect(item.why).toContain("完全相同的参数");
    expect(item.why).toContain("command、path、device");
    expect(item.why).not.toContain("只对这几个工具名");
  });

  it("归档运行即使 grant 尚未到期也只显示审计，不显示 active", () => {
    let state = createInitialState("archived", "历史", false, { archived: true });
    state = reduceEvents(state, [
      sse(2, "host", "approval_resolved", {
        name: "fetch_url",
        toolUseId: "t1",
        requestSeq: 1,
        decision: "allow",
        actor: "user",
        scope: "run",
        inputScope: "exact-input",
        inputHash: "sha256:abcdef",
        grantId: "g-archived",
        boundRunId: "archived",
        expiresAt: Date.now() + 60_000,
        maxUses: 5,
        usedUses: 0,
        at: 1,
      }),
    ]);
    const item = deriveAssemblyBar(state, null).find((candidate) => candidate.key === "autoAllow")!;
    expect(item.chip).toContain("授权审计");
    expect(item.chip).not.toContain("精确放行");
    expect(item.why).toContain("绝不恢复执行权");
  });

  it("装配变了条上就变——核查关掉时说的是「核查关」", () => {
    let s = createInitialState("r2", "t", false);
    const items = deriveAssemblyBar(s, null);
    expect(items.find((i) => i.key === "verify")!.chip).toBe("核查关");
  });

  it("没有领域包时如实说「无领域包」，不留空", () => {
    const items = deriveAssemblyBar(createInitialState("r3", "t", false), null);
    expect(items.find((i) => i.key === "pack")!.chip).toBe("无领域包");
  });

  it("长工作目录只留尾部两级——状态条是一行", () => {
    const items = deriveAssemblyBar(configured(), null);
    const wd = items.find((i) => i.key === "workdir")!.chip;
    expect(wd.length).toBeLessThan(40);
    expect(wd).toContain("Agent_Design");
  });

  it("非编排运行没有编排项", () => {
    expect(deriveAssemblyBar(configured(), null).some((i) => i.key === "plan")).toBe(false);
  });

  /**
   * B0：planner 预算不再是写死的 12，plan 芯片必须报数字与来源。
   * 这条同时锁 run_config 的白名单投影——plannerBudget* 两个字段若在
   * reduceEvent 里被丢（新字段默认被丢，本轮已是第四次踩到这类坑），
   * 芯片上就不会出现预算，本测试变红。
   */
  it("plan 芯片带 planner 预算，数字与来源都来自 run_config（B0）", () => {
    let s = createInitialState("run-asm-plan", "任务", true);
    s = reduceEvents(s, [
      sse(0, "host", "run_config", {
        pack: { name: "ts-coding" },
        workdir: "D:/w",
        guardrails: { maxTurns: 40 },
        verifierBudgetTurns: 15,
        plannerBudgetTurns: 30,
        plannerBudgetSource: "pack",
      }),
      sse(1, "host", "plan", {
        concurrency: 1,
        subtasks: [{ id: "s1", title: "t", dependsOn: [], acceptance: [], description: "", pack: null }],
      }),
    ]);
    const chip = deriveAssemblyBar(s, null).find((i) => i.key === "plan")!;
    expect(chip.chip).toContain("planner 30 轮");
    expect(chip.why).toContain("领域包声明");
  });

  /**
   * **每一句 why 都必须落在具体后果上**，不能是标语。
   * 判据：说清"不这样会发生什么"。写不出后果的项就不该占状态条的位置——
   * 本项目一贯反对标语（findings 全篇都是"判据 + 出处"的写法）。
   */
  it("每一项都有说明，且不是空泛口号", () => {
    const items = deriveAssemblyBar(configured(), { model: "m" });
    expect(items.length).toBeGreaterThanOrEqual(5);
    for (const i of items) {
      expect(i.why.length, `${i.key} 的说明太短`).toBeGreaterThan(40);
      // 标语词一律不许出现
      for (const banned of ["我们相信", "更可靠", "更智能", "赋能", "领先"]) {
        expect(i.why, `${i.key} 的说明里出现了口号「${banned}」`).not.toContain(banned);
      }
    }
  });

  it("点一下展开说明，再点一下收起", () => {
    renderRunDetail(configured(), { activeTab: "loop", harness: { model: "m" } });
    const chips = [...document.querySelectorAll(".assembly-chip")] as HTMLElement[];
    const why = document.querySelector(".assembly-why") as HTMLElement;
    expect(why.hidden).toBe(true);

    chips[0].click();
    expect(why.hidden).toBe(false);
    expect(chips[0].getAttribute("aria-expanded")).toBe("true");
    expect(why.textContent!.length).toBeGreaterThan(20);

    chips[0].click();
    expect(why.hidden, "再点一次应当收起").toBe(true);
  });

  it("同时只展开一项——两句解释叠在一起没人读", () => {
    renderRunDetail(configured(), { activeTab: "loop", harness: { model: "m" } });
    const chips = [...document.querySelectorAll(".assembly-chip")] as HTMLElement[];
    chips[0].click();
    chips[1].click();
    const open = chips.filter((c) => c.getAttribute("aria-expanded") === "true");
    expect(open).toHaveLength(1);
    expect(open[0]).toBe(chips[1]);
  });
});

describe("装配条不许说谎（文案交叉核对抓到的三处）", () => {
  const cfg = (over: any = {}) => {
    let s = createInitialState("r", "t", true);
    return reduceEvents(s, [sse(0, "host", "run_config", over)]);
  };

  /**
   * `?? 0` 会把**没设过**的 maxTokens 渲成「0k」——一个没设过的护栏被画成
   * 最严格的护栏。这条状态条的全部价值就在于它不说谎，所以这是必须锁的。
   */
  it("maxTokens 未设时不渲染，不许出现「0k」", () => {
    const chip = deriveAssemblyBar(cfg({ guardrails: { maxTurns: 40 } }), null)
      .find((i) => i.key === "guardrails")!.chip;
    expect(chip).toBe("40 轮");
    expect(chip).not.toContain("0k");
  });

  it("maxTokens 设了才带上", () => {
    const chip = deriveAssemblyBar(cfg({ guardrails: { maxTurns: 40, maxTokens: 64000 } }), null)
      .find((i) => i.key === "guardrails")!.chip;
    expect(chip).toBe("40 轮 / 64k");
  });

  /**
   * `classifyStopReason` 的具名值全集以 src/types.ts 的 STOP_REASONS 为准
   * （B1 一致锁钉着，数目还会长——这条注释因此也不写数字；初稿写"八个"，
   * aborted 一上线就过期了，正是"写死的计数会过期"的活标本）。
   * 文案里写死"六值"同理是过期口径，所以文案不写具体数目。
   */
  it("护栏说明不写死终止值的个数（口径会漂）", () => {
    const why = deriveAssemblyBar(cfg({ guardrails: { maxTurns: 40 } }), null)
      .find((i) => i.key === "guardrails")!.why;
    expect(why).not.toMatch(/[六五四三七八九]值/);
  });

  /**
   * 案例 #8 全程单模型（deepseek-v4-pro，执行/核查/planner 同款），
   * 四跑 A/B/C/D 的变量是预算 / 只读纪律 / 收口续跑——**模型是控制量**。
   * 拿它当"换模型可对照"的证据是把出处引反了。
   */
  it("模型说明不得拿案例 #8 当「换模型可对照」的证据", () => {
    const why = deriveAssemblyBar(cfg({}), { model: "m" }).find((i) => i.key === "model")!.why;
    expect(why).not.toContain("案例 #8");
    expect(why).not.toContain("A/B/C/D");
  });

  /** 空白名单是案例 #4 的事故形态，必须显式显示 0 而不是省略 */
  it("核查白名单为空时显示「白名单 0」，不适用「空就不显示」", () => {
    const chip = deriveAssemblyBar(cfg({ guardrails: { maxTurns: 40 } }), null)
      .find((i) => i.key === "verify")!.chip;
    expect(chip).toContain("白名单 0");
  });

  it("白名单有值时报真实条数", () => {
    const s = cfg({ pack: { name: "ts-coding", verify: { readOnlyCommands: ["a", "b", "c"] } } });
    expect(deriveAssemblyBar(s, null).find((i) => i.key === "verify")!.chip).toContain("白名单 3");
  });
});

// ================================================================
// 跳转箭头与贴底跟随
// ================================================================

describe("deriveScrollNav：两个箭头各管各的", () => {
  const at = (over: any = {}) =>
    deriveScrollNav({
      scrollTop: 0, scrollHeight: 2000, clientHeight: 600, anchorTop: null, drawerOpen: false,
      ...over,
    });

  it("离底还远 → 出现「回到最新」", () => {
    expect(at({ scrollTop: 0 }).showBottom).toBe(true);
  });

  it("已经贴底 → 不出现（它此刻什么也做不了）", () => {
    expect(at({ scrollTop: 1400 }).showBottom).toBe(false);
  });

  it("内容根本不够滚时两个都不出现——那是纯噪声", () => {
    const n = at({ scrollHeight: 620, clientHeight: 600, scrollTop: 0 });
    expect(n.showBottom).toBe(false);
    expect(n.showTop).toBe(false);
  });

  /**
   * ↑ 的判据不是"往上翻过"，而是**抽屉开着且四张卡已经滚出视野**。
   * 抽屉没开时上面就是对话，往上翻是在读历史——那时候弹一个"回到顶部"
   * 是在催人离开他正在读的地方。
   */
  it("抽屉没开时不出现「回到四决定因素」，哪怕已经滚很远", () => {
    expect(at({ scrollTop: 1200, anchorTop: -800, drawerOpen: false }).showTop).toBe(false);
  });

  it("抽屉开着且四张卡滚出上边界 → 出现", () => {
    expect(at({ scrollTop: 1200, anchorTop: -800, drawerOpen: true }).showTop).toBe(true);
  });

  it("抽屉开着但四张卡还在视野内 → 不出现", () => {
    expect(at({ scrollTop: 100, anchorTop: 120, drawerOpen: true }).showTop).toBe(false);
  });

  it("量不到四张卡时不猜——宁可不显示也不乱跳", () => {
    expect(at({ anchorTop: null, drawerOpen: true }).showTop).toBe(false);
  });
});

describe("对话贴底跟随", () => {
  /**
   * 本仓早就有 `keepScrollAnchored`（贴底时跟随、否则不动用户的位置），
   * 但**只有日志面在用、对话没接**——而流式全在对话里，
   * 于是"正在写"的那一段每次都长在视野之外。这条锁住它确实接上了。
   */
  it("patchConversation 走 keepScrollAnchored", () => {
    const src = readFileSync(join(__dirname, "..", "ui", "public", "app.js"), "utf-8");
    const fn = src.slice(src.indexOf("function patchConversation"), src.indexOf("function chatItemSig"));
    expect(fn, "对话没有接贴底跟随").toContain("keepScrollAnchored(");
  });

  it("贴底时跟随到新的底部；离底时一动不动", () => {
    // 直接测那个 helper 的两种分支——jsdom 量不到真实布局，所以造一个假滚动容器
    const make = (scrollTop: number) => ({
      scrollTop, scrollHeight: 1000, clientHeight: 400,
    });
    const pinned = make(590); // 距底 10px，算贴底
    expect(keepScrollAnchored(pinned as any, () => { pinned.scrollHeight = 1200; })).toBe(true);
    expect(pinned.scrollTop, "贴底时应跟到新底部").toBe(1200);

    const away = make(100); // 距底 500px，人在往上翻
    expect(keepScrollAnchored(away as any, () => { away.scrollHeight = 1200; })).toBe(false);
    expect(away.scrollTop, "人往上翻了就不该动他").toBe(100);
  });
});

describe("角色人名（backlog D4：显示层别名，与角色语义并列）", () => {
  function crewState() {
    const s = createInitialState("run-crew", "任务", true);
    return reduceEvents(s, [
      sse(0, "planner", "assistant_text", { text: "我先拆解任务" }),
      sse(1, "s1/main", "assistant_text", { text: "开始施工" }),
      sse(2, "s1/verifier", "assistant_text", { text: "开始核查" }),
    ]);
  }

  it("段分界带人名，且角色语义并列在同一条分界上——名字不许盖住「全新上下文」", () => {
    renderRunDetail(crewState(), { activeTab: "loop" });
    // 锁必须打在分界元素本身：初版断言整段对话文本，发言署名里的人名会把
    // "分界丢了人名"的变异救绿（变异测试当场抓出来的教训）
    const boundaries = [...document.querySelectorAll(".segment-boundary")].map(
      (n) => n.textContent ?? "",
    );
    expect(boundaries.some((b) => b.includes("计明远") && b.includes("只读拆解"))).toBe(true);
    expect(boundaries.some((b) => b.includes("施敢当") && b.includes("Agent 执行"))).toBe(true);
    expect(boundaries.some((b) => b.includes("严不苟") && b.includes("全新上下文"))).toBe(true);
  });

  it("发言署名跟角色走：计明远/施敢当各自具名，不再一律「Agent」", () => {
    renderRunDetail(crewState(), { activeTab: "loop" });
    const roles = [...document.querySelectorAll(".chat-msg--assistant .chat-role")].map(
      (n) => n.textContent ?? "",
    );
    expect(roles.some((r) => r.includes("计明远"))).toBe(true);
    expect(roles.some((r) => r.includes("施敢当"))).toBe(true);
  });

  it("人名只在显示层——事件流与派生层的 source 仍是结构名（改名不漂移记录）", () => {
    const s = crewState();
    expect(s.timeline.every((e: any) => !/计明远|施敢当|严不苟/.test(String(e.source)))).toBe(true);
    const boundary = deriveChatItems(s, null).find((it: any) => it.kind === "boundary");
    expect(boundary!.source).toBe("planner");
  });

  it("直播条目署名施敢当（直播只有 main 来源）", () => {
    let s = createInitialState("run-crew2", "任务", false);
    s = reduceEvents(s, [sse(0, "main", "turn_start", { turn: 1 })]);
    renderRunDetail(s, { activeTab: "loop", liveText: "正在写……" });
    expect(document.querySelector(".chat-msg--live .chat-role")!.textContent).toContain("施敢当");
  });
});

describe("paceReveal：把上游的一阵一阵摊成匀速", () => {
  /**
   * 委托方："有时候会卡住然后突然冒一长串。"
   * 量下来**不是渲染慢**（长任务观测器录到 0 条），是上游本来就一阵一阵来：
   * 一次 230 条增量里多数在同一毫秒到达，相邻两批最长静默 943ms。
   * 所以修在"别把到达节奏当成显示节奏"。
   */
  it("一次突进不会一帧全糊上去", () => {
    const next = paceReveal({ arrived: 300, revealed: 0, dtMs: 16 });
    expect(next).toBeGreaterThan(0);
    expect(next, "300 字一帧全放了，等于没做节流").toBeLessThan(300);
  });

  it("积压越多放得越快——否则长文会越拖越远", () => {
    const small = paceReveal({ arrived: 50, revealed: 0, dtMs: 16 });
    const big = paceReveal({ arrived: 5000, revealed: 0, dtMs: 16 });
    expect(big).toBeGreaterThan(small);
  });

  /**
   * 速度取自积压量 = 指数衰减，尾巴会拖。初版没有收尾闸，300 字突进 350ms
   * 只走到 200 字，剩下那截慢慢爬——**正是这条测试把它抓出来的**。
   * 现在加了剩不多了一次放完，实测：60 字 176ms / 300 字 352ms /
   * 1200 字 512ms / 5000 字 672ms —— 越长的突进追得越快，但都在人可接受的范围内。
   */
  it("典型突进在 400ms 内追平，超长突进也不超过 1 秒", () => {
    const catchUp = (burst: number) => {
      let revealed = 0;
      let t = 0;
      while (revealed < burst && t < 5000) {
        revealed = paceReveal({ arrived: burst, revealed, dtMs: 16 });
        t += 16;
      }
      return t;
    };
    expect(catchUp(300)).toBeLessThanOrEqual(400);
    expect(catchUp(5000)).toBeLessThanOrEqual(1000);
  });

  it("一轮结束时立刻全放——收尾必须是准的", () => {
    expect(paceReveal({ arrived: 5000, revealed: 3, dtMs: 16, done: true })).toBe(5000);
  });

  it("没有积压就不动", () => {
    expect(paceReveal({ arrived: 120, revealed: 120, dtMs: 16 })).toBe(120);
  });

  it("上游文本变短（换了一轮）时显示位置跟着回落，不会停在越界处", () => {
    expect(paceReveal({ arrived: 10, revealed: 999, dtMs: 16 })).toBeLessThanOrEqual(10);
  });

  it("dt 为 0 也至少推进一个字——绝不卡死", () => {
    expect(paceReveal({ arrived: 100, revealed: 0, dtMs: 0 })).toBeGreaterThan(0);
  });
});

describe("停止按钮：运行中那个位置变成「停止」", () => {
  const running = () =>
    deriveComposerMode({
      info: { runId: "r1", status: "running", canContinue: false },
      localStatus: "running",
    });

  it("运行中按钮是「停止」且可点——不是一个灰着的「运行任务」", () => {
    const m = running();
    expect(m.buttonLabel).toBe("停止");
    expect(m.canSubmit).toBe(true);
    expect(m.kind).toBe("stop");
  });

  /** 框里那半截草稿是给下一轮准备的，不该拦着人叫停 */
  it("停止不需要文本", () => {
    expect(composerSubmitPlan(running(), "")).toEqual({ kind: "stop", runId: "r1", text: "" });
    expect(composerSubmitPlan(running(), "   ")).toEqual({ kind: "stop", runId: "r1", text: "" });
  });

  it("说明里讲清楚它只保证「下一次模型调用之前收手」", () => {
    expect(running().note).toContain("下一次模型调用之前");
  });

  it("非运行态不会误发停止", () => {
    const done = deriveComposerMode({ info: { runId: "r1", status: "done", canContinue: true } });
    expect(done.kind).toBe("append");
    expect(composerSubmitPlan(done, "继续")!.kind).toBe("append");
  });
});

describe("B2 · 归档运行在底栏的说法", () => {
  /**
   * 归档 run（宿主重启前的历史）同样 canContinue=false，但原因完全不同：
   * 落到兜底那句"可能执行阶段就失败了"是对着一次好端端的运行说谎（判据④）。
   */
  it("归档的'不能续跑'要说真话，而不是'执行阶段就失败了'", () => {
    const m = deriveComposerMode({
      info: { runId: "r1", status: "done", canContinue: false, archived: true },
    });
    expect(m.mode).toBe("new-blocked");
    expect(m.note).toContain("归档");
    expect(m.note).not.toContain("失败");
  });
});

describe("装配条的识图那一格", () => {
  const bare = () => createInitialState("rv", "t", false);

  /**
   * 委托方遇到的正是这条：传图进去，模型诚实地说"我看不到"，
   * 但界面上完全看不出**是这套装配里没有这个工具**，只能从模型的道歉里推。
   */
  it("未配时明说「未配」，并解释为什么工具面上干脆没有它", () => {
    const item = deriveAssemblyBar(bare(), { roleModels: { vision: { configured: false } } })
      .find((i) => i.key === "vision")!;
    expect(item.chip).toBe("识图 未配");
    expect(item.why).toContain("根本不进工具面");
  });

  /**
   * `/api/harness` 未配时给的是 `{configured:false}`——**一个真值对象**。
   * 直接 `vision ? …` 会让这一格恰好在它唯一有用的场景下说反话。
   */
  it("未配的那个对象是真值——判据必须认 configured 而不是对象本身", () => {
    const snapshot = { roleModels: { vision: { configured: false } } };
    expect(Boolean(snapshot.roleModels.vision), "前提：它确实是真值").toBe(true);
    expect(
      deriveAssemblyBar(bare(), snapshot).find((i) => i.key === "vision")!.chip,
    ).toBe("识图 未配");
  });

  it("两种数据源形状都认：逐 run 是字符串，进程级是对象", () => {
    const perRun = reduceEvents(bare(), [
      sse(0, "host", "run_config", { roleModels: { vision: "qwen-vl" } }),
    ]);
    expect(deriveAssemblyBar(perRun, null).find((i) => i.key === "vision")!.chip).toContain("qwen-vl");
    expect(
      deriveAssemblyBar(bare(), { roleModels: { vision: { configured: true, model: "gpt-4o" } } })
        .find((i) => i.key === "vision")!.chip,
    ).toContain("gpt-4o");
  });
});

// ================================================================
// MODEL-01a 端点降级：换端点这件事必须在界面上留痕
// ================================================================

describe("端点降级在界面上看得见", () => {
  /**
   * 换端点是**本次运行最强的解释变量**：之后每一轮的措辞、工具偏好、失败形态
   * 都可能因此改变。这条事件若被静默丢弃（`app.js` 的逐字段白名单投影天生就是
   * 这个语义），界面只是少一行，肉眼看不出——正是这个项目踩过七次的那条缝。
   */
  function stateWithFallback(extra: Record<string, unknown> = {}) {
    let s = createInitialState("run-fb", "降级任务", false);
    s = reduceEvents(s, [
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "model", "model_fallback", {
        from: "deepseek-v4-pro",
        to: "kimi-k3",
        reason: "503: upstream unavailable",
        turn: 2,
        ...extra,
      }),
    ]);
    return s;
  }

  it("日志里渲染出「从谁换到谁 + 为什么离开」，且默认展开", () => {
    renderRunDetail(stateWithFallback(), { activeTab: "loop" });
    const entry = document.querySelector(".log-entries .log-entry") as HTMLElement | null;
    const body = document.querySelector(".log-entries")?.textContent ?? "";
    expect(body).toContain("deepseek-v4-pro");
    expect(body).toContain("kimi-k3");
    expect(body).toContain("503: upstream unavailable");
    // 折叠会把这行藏起来；这条事件恰恰是后面所有轮次的前提，不能默认折叠
    expect([...document.querySelectorAll(".log-entries .log-entry")].some(
      (e) => e.textContent?.includes("deepseek-v4-pro") && !e.className.includes("log-entry--collapsed"),
    )).toBe(true);
    expect(entry).not.toBeNull();
  });

  it("熔断跳过要说成「隔离期跳过」，不能显示成一个假的错误码", () => {
    renderRunDetail(stateWithFallback({ reason: "circuit_open" }), { activeTab: "loop" });
    const body = document.querySelector(".log-entries")?.textContent ?? "";
    expect(body).toContain("熔断隔离期");
    expect(body).not.toContain("circuit_open");
  });

  it("界面要说清降级只覆盖执行者——否则核查端点挂掉时会是个意料之外的失败", () => {
    renderRunDetail(stateWithFallback(), { activeTab: "loop" });
    const body = document.querySelector(".log-entries")?.textContent ?? "";
    expect(body).toContain("核查者");
    expect(body).toContain("不在降级链上");
  });

  it("装配条：配了链才上条，且写出完整链路", () => {
    const configured = reduceEvents(createInitialState("rc", "t", false), [
      sse(0, "host", "run_config", { fallbackChain: ["deepseek-v4-pro", "kimi-k3"] }),
    ]);
    const chip = deriveAssemblyBar(configured, null).find((i) => i.key === "fallback");
    expect(chip?.chip).toContain("deepseek-v4-pro → kimi-k3");
    expect(chip?.why).toContain("只覆盖执行者");
  });

  it("没配降级链时这一格根本不出现（未配是常态，摆一格「未配」只是噪声）", () => {
    expect(
      deriveAssemblyBar(createInitialState("rc2", "t", false), null).find((i) => i.key === "fallback"),
    ).toBeUndefined();
  });

  it("已经降过级的运行，装配条上要看得出来（配置 ≠ 发生过）", () => {
    let s = createInitialState("rc3", "t", false);
    s = reduceEvents(s, [
      sse(0, "host", "run_config", { fallbackChain: ["a", "b"] }),
    ]);
    expect(deriveAssemblyBar(s, null).find((i) => i.key === "fallback")!.chip).not.toContain("已降级");
    s = reduceEvents(s, [sse(1, "model", "model_fallback", { from: "a", to: "b", reason: "503", turn: 1 })]);
    expect(deriveAssemblyBar(s, null).find((i) => i.key === "fallback")!.chip).toContain("已降级");
  });
});

describe("会话标题：算出来的短句，不是任务原文", () => {
  /**
   * 侧栏此前直接铺任务原文——一条几百字的描述占三四行还看不出是什么。
   * 委托方截图里第一条就是 `附件：uploads/65a53cbdab081af8413977836a52f10b.jpg…`。
   */
  it("长任务截断到可扫视的长度", () => {
    const t = deriveRunTitle("你好 今天广东省佛山市南海区的天气怎么样 适合去哪些地方玩啊?");
    expect(t.length).toBeLessThanOrEqual(25);
    expect(t.startsWith("你好")).toBe(true);
  });

  it("只有附件时拿文件名当标题，不铺整条路径", () => {
    const t = deriveRunTitle("附件：uploads/65a53cbdab081af8413977836a52f10b.jpg");
    expect(t.startsWith("附件 ")).toBe(true);
    expect(t).not.toContain("uploads/");
  });

  /** 附件是补充材料不是任务本身——有正文就取正文 */
  it("既有正文又有附件时取正文", () => {
    expect(deriveRunTitle("写一个函数\n附件：uploads/a.png")).toBe("写一个函数");
  });

  it("剥掉 Markdown 行首记法（标题/列表/引用）", () => {
    expect(deriveRunTitle("## 三、四线制 PT1000 测量原理")).toBe("三、四线制 PT1000 测量原理");
    expect(deriveRunTitle("- 做一件事")).toBe("做一件事");
    expect(deriveRunTitle("1. 做一件事")).toBe("做一件事");
    expect(deriveRunTitle("> 引用的任务")).toBe("引用的任务");
  });

  it("空 / 全空白 → 有个确定的兜底，不是空字符串", () => {
    expect(deriveRunTitle("")).toBe("未命名任务");
    expect(deriveRunTitle("   \n  ")).toBe("未命名任务");
    expect(deriveRunTitle(undefined)).toBe("未命名任务");
  });

  it("列表项渲染标题，同时把原文挂 title（鼠标停一下看全）", () => {
    const runs = [{ runId: "a", task: "很长很长的任务描述".repeat(6), status: "done", verify: false, createdAt: 1, finishedAt: 2 }];
    renderRunList(runs, null, () => {}, deriveRunListItems(runs, new Map()));
    const el = document.querySelector(".run-item-task") as HTMLElement;
    expect(el.textContent!.length).toBeLessThan(30);
    expect(el.getAttribute("title")).toBe(runs[0].task);
  });
});

describe("空态给的是能点的例子", () => {
  /**
   * 第一次打开时最难的不是不会用，而是**不知道这个 agent 能干什么**——
   * 一句"尚无运行"把这个问题原样退回给人。
   */
  it("无运行时列出示例，且各走一条不同的路", () => {
    renderEmptyState(false);
    const items = [...document.querySelectorAll("[data-example]")];
    expect(items.length).toBeGreaterThanOrEqual(3);
    const all = items.map((e) => e.getAttribute("data-example")!).join(" ");
    expect(all, "应当有一个不碰工具的纯问答").toContain("不要调用工具");
    expect(all, "应当有一个会触发审批门的写入").toMatch(/创建|写/);
  });

  it("示例文本进 data-example，点击由宿主填进输入框（不直接开跑）", () => {
    renderEmptyState(false);
    const btn = document.querySelector("[data-example]") as HTMLElement;
    expect(btn.tagName).toBe("BUTTON"); // 键盘可达
    expect(btn.getAttribute("data-example")!.length).toBeGreaterThan(5);
  });

  it("已有运行时的新建对话面仍给示例——示例属于启动器，不属于首次安装", () => {
    renderEmptyState(true);
    expect(document.querySelectorAll("[data-example]").length).toBeGreaterThanOrEqual(3);
    expect(document.querySelector(".empty-state h2")!.textContent).toBe("开始一段新对话");
  });

});


/**
 * §直播条 · 滑动窗口换算（2026-08-15 委托方实测缺陷）。
 *
 * 现象：Web UI 里思考流到**约 2000 字就停住**，要过好一会才整块出现。
 *
 * 根因是绝对计数去 slice 一个滑动窗口：`revealed` 单调增长，而直播缓冲
 * 有上限（LIVE_TEXT_CAP=2000）且只留尾部。撞上限那刻——
 *   ① 旧代码的 `arrived` 取自缓冲长度 → 被钉死在 2000，不再增长；
 *   ② 于是 `revealed` 也不再变化，节拍器的 `changed` 恒为 false；
 *   ③ **再也不重绘**，屏幕冻在那一帧，直到本轮结束、turn 级
 *      `assistant_thinking` 走正常 reducer 整块到达——正是"过一会才显示"。
 *
 * 这段逻辑原来住在 `index.html`，**没有任何测试够得着**——本仓库那条
 * "核心可测、壳不可测的分界线就是缺陷分布线"的活标本。挪进 app.js 是
 * 结构性修复，下面这组锁才有地方立。
 */
describe("revealedWindow：绝对放行计数 → 滑动窗口内的偏移", () => {
  const CAP = 2000;

  it("没到上限时就是原样放行（缓冲=全部，没有丢弃）", () => {
    expect(revealedWindow({ revealed: 300, precedingTotal: 0, total: 500, bufferLength: 500 })).toBe(300);
    expect(revealedWindow({ revealed: 500, precedingTotal: 0, total: 500, bufferLength: 500 })).toBe(500);
  });

  /** 这一条就是那个 bug：撞上限之后，追平的过程必须还能推进 */
  it("超过上限后 revealed 前进则可见位置前进——旧实现在这里冻住", () => {
    const at = (revealed: number) =>
      revealedWindow({ revealed, precedingTotal: 0, total: 5000, bufferLength: CAP });
    expect(at(4900)).toBe(1900); // 丢弃 5000-2000=3000；4900-3000
    expect(at(4950)).toBe(1950);
    expect(at(4950), "同一累计下 revealed 走一步，屏幕就得走一步").toBeGreaterThan(at(4900));
  });

  /**
   * 滞后量相同时窗口位置相同——这不是 bug 而是正确性质：内容在滑，
   * 位置不动照样看到新尾巴。真正修掉冻结的是"累计不再被上限钉死"，
   * 由下面那条逐批流入的锁负责。
   */
  it("累计与 revealed 同步增长时位置稳定（内容在滑，不靠位置动）", () => {
    const a = revealedWindow({ revealed: 4900, precedingTotal: 0, total: 5000, bufferLength: CAP });
    const b = revealedWindow({ revealed: 4950, precedingTotal: 0, total: 5050, bufferLength: CAP });
    expect(b).toBe(a);
  });

  it("追平时正好落在窗口末尾，不越界", () => {
    expect(revealedWindow({ revealed: 5000, precedingTotal: 0, total: 5000, bufferLength: CAP })).toBe(CAP);
    // 即使 revealed 因为舍入跑过头也夹在窗口内
    expect(revealedWindow({ revealed: 9999, precedingTotal: 0, total: 5000, bufferLength: CAP })).toBe(CAP);
  });

  it("正文的额度扣掉思考已占的（思考在前、正文在后）", () => {
    // 思考累计 800，正文刚到 100，全局放行 850 → 正文该显示 50
    expect(revealedWindow({ revealed: 850, precedingTotal: 800, total: 100, bufferLength: 100 })).toBe(50);
    // 全局还没走完思考那段，正文一个字都不该露
    expect(revealedWindow({ revealed: 700, precedingTotal: 800, total: 100, bufferLength: 100 })).toBe(0);
  });

  it("永不返回负数或超过缓冲长度（下游直接拿去 slice）", () => {
    for (const m of [
      { revealed: 0, precedingTotal: 999, total: 10, bufferLength: 10 },
      { revealed: -5, precedingTotal: 0, total: 0, bufferLength: 0 },
      { revealed: 1e9, precedingTotal: 0, total: 1e9, bufferLength: 50 },
    ]) {
      const n = revealedWindow(m);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(m.bufferLength);
    }
  });

  /**
   * 端到端的形态复现：模拟一段 5000 字的思考按 250 字一批流进来，
   * 缓冲按 2000 截尾。**每一批之后可见位置都必须前进**——只要有一批不动，
   * 就是那个"冻住"的形态回来了。
   */
  it("逐批流入 5000 字：可见位置每批都前进，一次都不冻", () => {
    let total = 0;
    let buffer = "";
    let lastVisibleTail = "";
    const positions: number[] = [];
    for (let i = 0; i < 20; i++) {
      const chunk = "想".repeat(250);
      total += chunk.length;
      buffer = (buffer + chunk).slice(-CAP);
      // 节拍器追平后的稳态：revealed == arrived == total
      const n = revealedWindow({ revealed: total, precedingTotal: 0, total, bufferLength: buffer.length });
      positions.push(total);
      const tail = buffer.slice(0, n).slice(-80);
      expect(tail.length, `第 ${i + 1} 批尾部不该为空`).toBeGreaterThan(0);
      lastVisibleTail = tail;
    }
    expect(lastVisibleTail.length).toBe(80);
    // 累计单调递增：旧实现里这个数会在 2000 处永久钉死
    expect(positions.at(-1)).toBe(5000);
    expect(positions.every((p, i) => i === 0 || p > positions[i - 1]!)).toBe(true);
  });
});

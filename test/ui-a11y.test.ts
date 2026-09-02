// @vitest-environment jsdom
// @ts-nocheck
/**
 * 无障碍自动扫描（axe-core + jsdom）——AC-05/AC-06 的常驻回归门禁。
 *
 * 为什么需要它（案例 #7 s3d 实证）：手写静态断言只能守护"写了什么"。当时的断言
 * 检查了 `role="option"` 存在——它确实存在，断言绿；真正的缺陷是**缺父容器
 * role="listbox"**，这类"父子契约"只有在真实 DOM 上跑规则引擎才发现得了。
 * axe 的 aria-required-parent 规则正是为此而生。
 *
 * 边界（诚实声明，不要误以为这层覆盖了全部）：
 * - jsdom 无布局与真实样式级联，axe 的 color-contrast / target-size / 焦点可见性
 *   等**视觉类规则在此环境下不产出 violations**（落在 incomplete）。
 * - 对比度由 ui-app.test.ts 里从 styles.css 解析色对、按 WCAG 相对亮度公式
 *   实算的测试守护——两者互补，不可互相替代。
 * - 真实屏幕阅读器听感仍需人工。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import axe from "axe-core";
import {
  createInitialState,
  reduceEvent,
  renderRunList,
  renderRunDetail,
  renderEmptyState,
  deriveComposerMode,
  composerSubmitPlan,
  patchComposer,
} from "../ui/public/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "..", "ui", "public");

/** 取真实 index.html 的 body 骨架，剥掉 <script>（innerHTML 注入本就不执行脚本，显式剥离是为了语义清晰） */
function loadSkeleton(): string {
  const html = readFileSync(join(UI_DIR, "index.html"), "utf-8");
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? "";
  return body.replace(/<script[\s\S]*?<\/script>/g, "");
}

/**
 * 打开「运行详情」抽屉。
 *
 * 对话主干化之后，四因子卡与下钻面搬进了默认收起的 `<details>`——
 * **axe 不扫收起的 details 里的内容**。也就是说不显式打开，下钻面的可访问性
 * 就从"每次都扫"变成"一次都不扫"，而测试还是绿的。
 * 这正是本轮 AC2-18 复验反复抓到的那类假绿，所以凡断言下钻面的用例都要先开抽屉。
 */
function openDrawer(): void {
  const d = document.getElementById("detail-drawer") as HTMLDetailsElement | null;
  if (d) d.open = true;
}

/** 宿主快照替身：护栏、工具面、包与白名单齐全，四决定因素才有东西可渲染 */
const FAKE_HARNESS = {
  model: "claude-opus-4-8",
  effort: "high",
  effortApplies: true,
  shell: "Git Bash (C:\\Program Files\\Git\\bin\\bash.exe)",
  workdir: "D:\\repo",
  readRoots: ["D:\\refs"],
  guardrails: { maxTurns: 40, maxTokens: 64000, contextTokenLimit: 150000 },
  compactWatermark: 0.8,
  verifierBudgetTurns: 15,
  pack: {
    name: "ts-coding",
    description: "TypeScript 编码域",
    resources: [],
    verify: { enabled: true, mode: "rubric", hasInstructions: true, readOnlyCommands: ["npm test"], rubricSource: "pack" },
  },
  tools: [
    { name: "bash", permission: "ask", parallelSafe: false, origin: "builtin" },
    { name: "read_file", permission: "auto", parallelSafe: true, origin: "builtin" },
    { name: "write_file", permission: "ask", parallelSafe: false, origin: "builtin" },
  ],
  mcp: { configured: false, servers: [] },
};

/** 构造一个"内容尽量丰富"的运行状态：审批卡（待处理+已应答）、核查过程、三值裁决、用量 */
function buildRichState() {
  let s = createInitialState("run-1", "创建 demo.txt 并核对内容", true);
  const push = (source: string, event: Record<string, unknown>, seq: number) => {
    s = reduceEvent(s, { seq, source, event });
  };
  let n = 0;
  push("main", { type: "turn_start", turn: 1 }, n++);
  push("main", { type: "tool_call", toolUseId: "t1", name: "write_file", input: { path: "demo.txt", content: "hello" } }, n++);
  push("main", { type: "approval_request", toolUseId: "t1", name: "write_file", input: { path: "demo.txt" } }, n++);
  push("main", { type: "tool_result", toolUseId: "t1", resultContent: "Wrote 5 bytes", resultIsError: false, durationMs: 3 }, n++);
  push("main", { type: "tool_call", toolUseId: "t2", name: "bash", input: { command: "cat demo.txt" } }, n++);
  push("main", { type: "approval_request", toolUseId: "t2", name: "bash", input: { command: "cat demo.txt" } }, n++);
  push("main", { type: "tool_result", toolUseId: "t2", resultContent: "boom", resultIsError: true, durationMs: 1 }, n++);
  push("main", { type: "assistant_text", text: "已创建 demo.txt 并读回确认。" }, n++);
  push("verifier", { type: "turn_start", turn: 1 }, n++);
  push("verifier", { type: "tool_call", toolUseId: "v1", name: "read_file", input: { path: "demo.txt" } }, n++);
  push("verifier", { type: "tool_result", toolUseId: "v1", resultContent: "hello", resultIsError: false, durationMs: 2 }, n++);
  push(
    "verifier",
    {
      type: "verdict",
      verdict: {
        passed: true,
        issues: [],
        unverified: ["字节数需 od 复核（只读环境无该命令）"],
        advisory: ["可读性 | 良 | 抽查两节均为结论先行"],
        summary: "客观项全部通过",
      },
    },
    n++,
  );
  push(
    "main",
    { type: "done", stopReason: "completed", usage: { turns: 3, inputTokens: 1024, outputTokens: 345, cacheHitRatio: 0.64 } },
    n++,
  );
  return s;
}

/** 在当前 document 上跑 axe，返回 violations（按 id 归并，便于断言与报错可读） */
async function runAxe(options: Record<string, unknown> = {}) {
  const results = await axe.run(document, {
    resultTypes: ["violations"],
    ...options,
  });
  return results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((nd) => nd.html.slice(0, 120)),
  }));
}

/**
 * 已知的 incomplete（"需人工复核"）规则白名单。
 *
 * 关键认知：只断言 violations 为空是不够的——axe 把"无法在本环境判定"的规则
 * 放进 incomplete 桶，它既不是通过也不是失败。若不盯住这个桶，新出现的
 * 待复核项会静默溜过去。这里锁定当前已知集合，多出任何一条都要人来看一眼。
 * - color-contrast：jsdom 无渲染，由 ui-app.test.ts 的 WCAG 实算测试守护
 * - landmark-one-main：注入式 body 下 axe 无法完全判定 main 唯一性
 * - page-has-heading-one：h1 确实存在（<header class="sr-only"> 内，已实测 DOM 命中），
 *   但 jsdom 无布局，axe 无法确认其可感知性，故恒为待复核
 */
const KNOWN_INCOMPLETE = new Set(["color-contrast", "landmark-one-main", "page-has-heading-one"]);

async function incompleteIds(): Promise<string[]> {
  const results = await axe.run(document);
  return results.incomplete.map((v) => v.id);
}

beforeEach(() => {
  // 真实页面的 <head> 语义（lang / title）由 index.html 提供，这里只注入 body，
  // 故手动补齐，避免 document-title / html-has-lang 这类脚手架假阳性
  document.documentElement.lang = "zh-CN";
  document.title = "Agent Harness — Web UI";
  document.body.innerHTML = loadSkeleton();
});

describe("axe 自动扫描：空态 / 列表 / 详情三种画面零 violations", () => {
  it("空态（尚无运行）", async () => {
    renderEmptyState(false);
    const violations = await runAxe();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("运行列表（含选中项，role=option 需在 role=listbox 内）", async () => {
    renderRunList(
      [
        { runId: "run-1", task: "创建 demo.txt", status: "done", verify: true },
        { runId: "run-2", task: "另一个任务", status: "running", verify: false },
      ],
      "run-1",
      () => {},
      new Map([
        ["run-1", { startTime: 1785980000000, duration: 12345, verdictConclusion: "passed" }],
        ["run-2", { startTime: 1785986000000, duration: null, verdictConclusion: "pending" }],
      ]),
    );
    const violations = await runAxe();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  // v2 R4：详情页从"概览/日志/核查"三标签改为「结果 + 四决定因素」结构。
  // 每个面各扫一遍——审批栏、结果卡与因子网格在四个面下都恒在，所以任一面
  // 的 violations 都会同时暴露 L2 与 L3 的问题。
  it("运行详情·Loop 面（返工链 + 分段日志 + 折叠条目）", async () => {
    renderRunDetail(buildRichState(), { activeTab: "loop", harness: FAKE_HARNESS });
    openDrawer();
    const violations = await runAxe();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("运行详情·Context 面（水位条 + token 三分 + 逐轮表）", async () => {
    renderRunDetail(buildRichState(), { activeTab: "context", harness: FAKE_HARNESS });
    openDrawer();
    const violations = await runAxe();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("运行详情·Tools 面（工具芯片 + 边界清单）", async () => {
    renderRunDetail(buildRichState(), { activeTab: "tools", harness: FAKE_HARNESS });
    openDrawer();
    const violations = await runAxe();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("运行详情·Verification 面（三值裁决 + 饥饿告警 + 边界）", async () => {
    renderRunDetail(buildRichState(), { activeTab: "verify", harness: FAKE_HARNESS });
    openDrawer();
    const violations = await runAxe();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("窄屏详情态（含返回列表按钮）", async () => {
    renderRunDetail(buildRichState(), {
      activeTab: "loop", showBack: true, onBack: () => {}, harness: FAKE_HARNESS,
    });
    openDrawer();
    const violations = await runAxe();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("宿主快照缺席时降级渲染仍零 violations", async () => {
    renderRunDetail(buildRichState(), { activeTab: "tools" });
    openDrawer();
    const violations = await runAxe();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  // §5.1：签字位是新的可交互区域，且是**阻塞**的——用户不点它运行就不动。
  // 键盘/读屏用不了它 = 整个运行卡死，比一般的可及性缺陷后果更重。
  it("计划确认门挂起态零 violations（阻塞式交互，读屏用不了就等于卡死）", async () => {
    let s = createInitialState("run-g", "跨领域任务", false);
    let n = 0;
    const push = (source: string, event: Record<string, unknown>) => {
      s = reduceEvent(s, { seq: n++, source, event });
    };
    push("host", { type: "turn_start", turn: 1 });
    push("host", {
      type: "plan",
      concurrency: 2,
      concurrencyMode: "auto",
      plannerMs: 120,
      gated: true,
      subtasks: [
        { id: "s1", title: "写固件", description: "", acceptance: [], dependsOn: [] },
        { id: "s2", title: "烧录验证", description: "", acceptance: [], dependsOn: ["s1"] },
      ],
    });
    push("host", { type: "plan_approval_request", at: 1000 });

    renderRunDetail(s, { activeTab: "loop", harness: FAKE_HARNESS });

    openDrawer();
    // 先确认它真的渲染出来了——否则这条会变成"什么都没扫也算通过"的假绿
    expect(document.querySelector(".plan-gate")?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelectorAll(".plan-gate button")).toHaveLength(2);

    const violations = await runAxe();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  /**
   * §5.2：提问卡与计划门同族，但**阻塞得更死**——执行协程正吊在 ask_user 的
   * execute 里等这一下。读屏/键盘用不了它，运行就永远停在那儿。
   * 而且它比计划门多一个自由输入框，那是最容易漏 label 的地方。
   */
  it("需求澄清提问挂起态零 violations（含自由输入框的 label）", async () => {
    let s = createInitialState("run-q", "配一块板", false);
    let n = 0;
    const push = (source: string, event: Record<string, unknown>) => {
      s = reduceEvent(s, { seq: n++, source, event });
    };
    push("host", { type: "turn_start", turn: 1 });
    // 委托方实测场景（决定 6）：一次打断带一组正交问题，一屏答完
    push("host", {
      type: "user_question_request",
      id: "q7",
      questions: [
        {
          question: "桌面端用哪个框架？",
          options: ["Electron", "Tauri"],
          fallback: "默认 Tauri（体积小、已有 Rust 工具链）",
        },
        {
          question: "UI 风格跟现有 Web 宿主一致，还是重做？",
          options: ["沿用现有暗色系", "重做一套"],
          fallback: "默认沿用现有暗色系",
        },
        {
          question: "这次做到什么程度？",
          options: ["可运行骨架", "核心页面齐全", "对齐 Web 全功能"],
          fallback: "默认做到可运行骨架",
        },
      ],
      at: 1000,
    });

    renderRunDetail(s, { activeTab: "loop", harness: FAKE_HARNESS });

    openDrawer();
    // 先确认它真的渲染了——否则这条会变成"什么都没扫也算通过"的假绿
    expect(document.querySelector(".user-question")?.hasAttribute("hidden")).toBe(false);
    /**
     * **坞和栏要一起显**。这不是多余的断言：变异测试实测，把提问从
     * needsAttention 里拿掉时，卡片自身照样 hidden=false，但外层的坞仍盖着——
     * 于是整块「需你决定」一个像素都看不见，而运行正吊着等这一下。
     * 那正是 app.js 里那段注释警告过的接线，只有连坞一起断言才拦得住。
     */
    expect(document.getElementById("action-dock")?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector(".action-rail")?.hasAttribute("hidden")).toBe(false);
    // 三题各自成块，每块一组 radio + 一个自由输入；底部只有两个按钮
    expect(document.querySelectorAll(".user-question fieldset")).toHaveLength(3);
    expect(document.querySelectorAll(".user-question button")).toHaveLength(2);
    expect(document.querySelectorAll('.user-question input[type="radio"]')).toHaveLength(7);
    expect(document.querySelectorAll('.user-question input[type="text"]')).toHaveLength(3);

    const violations = await runAxe();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});

describe("运行列表的 ARIA 语义（真实 DOM 断言，取代原先的源码字符串扫描）", () => {
  const runs = [
    { runId: "run-1", task: "创建 demo.txt", status: "done", verify: true },
    { runId: "run-2", task: "另一个任务", status: "running", verify: false },
  ];

  it("运行列表项的 role / tabindex / aria-selected 在真实 DOM 上成立", () => {
    renderRunList(runs, "run-1", () => {}, new Map());
    const items = [...document.querySelectorAll("#run-list .run-item")];
    expect(items).toHaveLength(2);
    for (const el of items) {
      expect(el.getAttribute("role")).toBe("option");
      expect(el.getAttribute("tabindex")).toBe("0");
      expect(el.hasAttribute("aria-selected")).toBe(true);
    }
    // 字符串扫描抓不住的部分：选中态必须真的落在被选中那一项上
    expect(items[0].getAttribute("aria-selected")).toBe("true");
    expect(items[1].getAttribute("aria-selected")).toBe("false");
    expect(document.getElementById("run-list")!.getAttribute("role")).toBe("listbox");
  });

  it("重渲染复用节点：选中态更新但 DOM 节点是同一个（焦点得以保持）", () => {
    renderRunList(runs, "run-1", () => {}, new Map());
    const before = document.querySelector("#run-list .run-item")!;
    (before as HTMLElement).focus();

    // 模拟侧栏刷新（此前每 3 秒整体重建一次，焦点随之被摧毁）
    renderRunList(runs, "run-2", () => {}, new Map());
    const after = document.querySelector("#run-list .run-item")!;

    expect(after).toBe(before); // 同一个节点对象，不是"长得一样"
    expect(document.activeElement).toBe(before);
    expect(after.getAttribute("aria-selected")).toBe("false"); // 选中态确实更新了
  });

  it("列表变空时摘掉 listbox 身份（空壳 listbox 是 critical 违规）", () => {
    renderRunList(runs, "run-1", () => {}, new Map());
    renderRunList([], null, () => {}, new Map());
    const listEl = document.getElementById("run-list")!;
    expect(listEl.hasAttribute("role")).toBe(false);
    expect(listEl.querySelectorAll(".run-item")).toHaveLength(0);
  });
});

describe("标签三件套（真实 DOM 断言，取代原先的源码字符串扫描）", () => {
  it("tab 三件套在真实 DOM 上闭环，且 aria-labelledby 随选中项更新", () => {
    renderRunDetail(buildRichState(), { activeTab: "loop", harness: FAKE_HARNESS });
    openDrawer();

    const tablist = document.querySelector('[role="tablist"]')!;
    const panel = document.querySelector('[role="tabpanel"]')!;
    expect(tablist).toBeTruthy();

    // 每个 tab 都指向那个面板，且面板反向指回当前选中的 tab
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    expect(tabs.length).toBeGreaterThanOrEqual(2);
    for (const t of tabs) expect(t.getAttribute("aria-controls")).toBe("tab-content");
    expect(panel.getAttribute("aria-labelledby")).toBe("tab-loop");
    // 反向引用不得悬空——字符串扫描看不见这一点
    expect(document.getElementById(panel.getAttribute("aria-labelledby")!)).toBeTruthy();

    // 切到另一个面后，引用必须跟着换
    renderRunDetail(buildRichState(), { activeTab: "context", harness: FAKE_HARNESS });
    openDrawer();
    const panel2 = document.querySelector('[role="tabpanel"]')!;
    expect(panel2.getAttribute("aria-labelledby")).toBe("tab-context");
    expect(document.getElementById("tab-context")).toBeTruthy();
  });

  it("旧标签 id 归一到 Loop 面，深链不 404", () => {
    for (const legacy of ["overview", "log", undefined, "bogus"]) {
      renderRunDetail(buildRichState(), { activeTab: legacy, harness: FAKE_HARNESS });
      openDrawer();
      const panel = document.querySelector('[role="tabpanel"]')!;
      expect(panel.getAttribute("aria-labelledby")).toBe("tab-loop");
    }
  });

  it("roving tabindex：仅选中项可 Tab 进入，其余为 -1", () => {
    renderRunDetail(buildRichState(), { activeTab: "loop", harness: FAKE_HARNESS });
    openDrawer();
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const active = tabs.filter((t) => t.getAttribute("tabindex") === "0");
    expect(active).toHaveLength(1);
    expect(active[0].getAttribute("aria-selected")).toBe("true");
    for (const t of tabs.filter((t) => t !== active[0])) {
      expect(t.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("方向键在四个面之间移动——只加 roving 不加方向键比不改更糟（s3d 教训）", () => {
    renderRunDetail(buildRichState(), { activeTab: "loop", harness: FAKE_HARNESS });
    openDrawer();
    const seen: string[] = [];
    document.addEventListener("tab-switch", (e) => seen.push((e as CustomEvent).detail.tab));

    for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"]) {
      seen.length = 0;
      const active = document.querySelector('[role="tab"][tabindex="0"]')!;
      active.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));
      expect(seen, `${key} 未触发切换`).toHaveLength(1);
    }
  });

  /**
   * 委托方截图发现：因子卡恒为四张，而当时的标签栏在没有核查记录时只渲染三个。
   * 点第四张卡会切到一个根本不存在的标签，tabpanel 的 aria-labelledby 随之
   * 指向空引用——屏幕阅读器报不出面板名。合并成同一组 tab 后这类不一致
   * 从结构上消失，这几条锁住它不复发。
   */
  it("未开启核查的运行同样有 Verification 面，且反向引用不悬空", () => {
    let s = createInitialState("run-nv", "没开核查的任务", false);
    s = reduceEvent(s, { seq: 0, source: "main", event: { type: "turn_start", turn: 1 } });
    s = reduceEvent(s, {
      seq: 1, source: "main",
      event: { type: "done", stopReason: "completed", usage: { turns: 1 } },
    });

    renderRunDetail(s, { activeTab: "verify", harness: FAKE_HARNESS });

    openDrawer();
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((t) => t.getAttribute("data-tab"));
    expect(tabs).toEqual(expect.arrayContaining(["loop", "context", "tools", "verify"]));

    const panel = document.querySelector('[role="tabpanel"]')!;
    expect(panel.getAttribute("aria-labelledby")).toBe("tab-verify");
    expect(document.getElementById("tab-verify")).toBeTruthy(); // 不悬空
    // 没有裁决时给出的是解释而不是空白——"没跑核查"本身就是一条信息
    expect(panel.textContent).toContain("未开启独立核查");
  });

  it("开了核查但执行先挂掉时，明说核查没机会运行", () => {
    let s = createInitialState("run-err", "认证失败的任务", true);
    s = reduceEvent(s, { seq: 0, source: "main", event: { type: "turn_start", turn: 1 } });
    s = reduceEvent(s, {
      seq: 1, source: "main",
      event: { type: "done", stopReason: "error", error: { message: "auth failed" }, usage: { turns: 0 } },
    });
    s = reduceEvent(s, {
      seq: 2, source: "host",
      event: { type: "run_end", outcome: "error", mainStopReason: "error", finishedAt: 1 },
    });

    renderRunDetail(s, { activeTab: "verify", harness: FAKE_HARNESS });

    openDrawer();
    const panel = document.querySelector('[role="tabpanel"]')!;
    expect(panel.textContent).toContain("核查未运行");
    // 这一句是要害：没有裁决不等于没有问题
    expect(panel.textContent).toContain("没有裁决不等于没有问题");
  });

  it("当前查看的面在卡片上有选中标记（卡片即标签）", () => {
    renderRunDetail(buildRichState(), { activeTab: "tools", harness: FAKE_HARNESS });
    openDrawer();
    const active = document.querySelector('.factor-card[aria-selected="true"]')!;
    expect(active.getAttribute("data-factor")).toBe("tools");
    expect(active.classList.contains("factor-card--active")).toBe(true);
    expect(active.getAttribute("aria-label")).toContain("当前查看");
    expect(document.querySelectorAll('.factor-card[aria-selected="true"]')).toHaveLength(1);
  });

  it("不再存在与因子卡重复的第二排标签", () => {
    renderRunDetail(buildRichState(), { activeTab: "loop", harness: FAKE_HARNESS });
    openDrawer();
    expect(document.querySelectorAll(".tab-nav")).toHaveLength(0);
    expect(document.querySelectorAll(".tab-btn")).toHaveLength(0);
    // tablist 只有一个，就是因子卡那一组
    const lists = [...document.querySelectorAll('[role="tablist"]')];
    expect(lists).toHaveLength(1);
    expect(lists[0].classList.contains("factor-grid")).toBe(true);
  });
});

describe("扫描器双向自检：植入已知缺陷必须被抓到", () => {
  // 项目纪律：checker 本身要能证明"它抓得住"，否则全绿可能只是没在看
  it("植入 s3d 的真实缺陷（role=option 脱离 listbox）→ aria-required-parent 必须报错", async () => {
    renderRunList([{ runId: "r", task: "t", status: "done", verify: false }], "r", () => {}, new Map());
    // 复刻当时的错误形态：父容器丢掉 role="listbox"
    document.getElementById("run-list")!.removeAttribute("role");
    const violations = await runAxe();
    expect(violations.map((v) => v.id)).toContain("aria-required-parent");
  });

  it("植入空壳 listbox（role 在但无 option 子项）→ aria-required-children 必须报错", async () => {
    // 这正是扫描器上线首跑抓到的真实回归：静态 role=listbox 遇上空态
    const listEl = document.getElementById("run-list")!;
    listEl.setAttribute("role", "listbox");
    listEl.setAttribute("aria-label", "运行列表");
    listEl.innerHTML = '<div class="run-list-empty">尚无运行。</div>';
    const violations = await runAxe();
    expect(violations.map((v) => v.id)).toContain("aria-required-children");
  });

  it("植入表单标签缺失 → label 规则必须报错", async () => {
    const input = document.getElementById("task-input")!;
    document.querySelector('label[for="task-input"]')?.remove();
    input.removeAttribute("aria-label");
    // placeholder 按 accname 规范也算可及名称（兜底档），不摘掉就仍有名字、不构成违规
    input.removeAttribute("placeholder");
    const violations = await runAxe();
    expect(violations.map((v) => v.id)).toContain("label");
  });

  it("植入悬空 aria-labelledby → 必须落进待复核桶（axe 对断链引用给 incomplete 而非 violation）", async () => {
    // 针对 s3d 新增的 tabpanel/aria-labelledby 关系：引用指向不存在的 id 时，
    // 屏幕阅读器取不到面板名称。axe 把它归为"需人工复核"（引用元素可能后续动态出现），
    // 所以守护它的是上面那条 incomplete 白名单测试 —— 此处证明白名单确实拦得住。
    renderRunDetail(buildRichState(), { activeTab: "loop", harness: FAKE_HARNESS });
    openDrawer();
    document.querySelector('[role="tabpanel"]')!.setAttribute("aria-labelledby", "tab-does-not-exist");
    const unexpected = (await incompleteIds()).filter((id) => !KNOWN_INCOMPLETE.has(id));
    expect(unexpected).toContain("aria-valid-attr-value");
  });
});

describe("环境边界声明（防止把 incomplete 误当通过）", () => {
  it("详情页的待复核项不得超出已知白名单（新增 incomplete 必须有人看一眼）", async () => {
    renderRunDetail(buildRichState(), { activeTab: "loop", harness: FAKE_HARNESS });
    openDrawer();
    renderRunList([{ runId: "run-1", task: "t", status: "done", verify: true }], "run-1", () => {}, new Map());
    const unexpected = (await incompleteIds()).filter((id) => !KNOWN_INCOMPLETE.has(id));
    expect(unexpected, `新出现的待复核规则: ${unexpected.join(", ")}`).toEqual([]);
  });

  it("color-contrast 在 jsdom 下不产出 violations —— 对比度由 ui-app.test.ts 的 WCAG 实算测试守护", async () => {
    renderRunDetail(buildRichState(), { activeTab: "loop", harness: FAKE_HARNESS });
    openDrawer();
    const results = await axe.run(document, { runOnly: { type: "rule", values: ["color-contrast"] } });
    // 断言的是"这里不承担对比度判定"这一事实，而不是"对比度没问题"
    expect(results.violations).toEqual([]);
  });
});

// ================================================================
// v2 R5：多主题下的结构语义（V-20）
// ================================================================

describe("多主题：data-theme 切换不改变结构语义", () => {
  const SCREENS: [string, () => void][] = [
    ["空态", () => renderEmptyState(false)],
    [
      "运行列表",
      () =>
        renderRunList(
          [
            { runId: "run-1", task: "创建 demo.txt", status: "done", verify: true },
            { runId: "run-2", task: "另一个任务", status: "running", verify: false },
          ],
          "run-1",
          () => {},
          new Map([["run-1", { startTime: 1785980000000, duration: 12345, verdictConclusion: "passed" }]]),
        ),
    ],
    ["Loop 面", () => renderRunDetail(buildRichState(), { activeTab: "loop", harness: FAKE_HARNESS })],
    ["Context 面", () => renderRunDetail(buildRichState(), { activeTab: "context", harness: FAKE_HARNESS })],
    ["Tools 面", () => renderRunDetail(buildRichState(), { activeTab: "tools", harness: FAKE_HARNESS })],
    ["Verification 面", () => renderRunDetail(buildRichState(), { activeTab: "verify", harness: FAKE_HARNESS })],
    [
      "窄屏详情态",
      () =>
        renderRunDetail(buildRichState(), {
          activeTab: "loop", showBack: true, onBack: () => {}, harness: FAKE_HARNESS,
        }),
    ],
    ["宿主快照缺席降级", () => renderRunDetail(buildRichState(), { activeTab: "tools" })],
  ];

  // 主题只改颜色不改结构；但"只改颜色"是需要被证明的，不是假设的。
  // jsdom 不判对比度（那由 ui-app.test.ts 的 WCAG 实算守护），这里守的是
  // 换主题后 ARIA 结构、地标、名称计算不发生任何漂移。
  for (const theme of ["light", "dark", "graphite", "contrast"] as const) {
    describe(`${theme} 主题`, () => {
      it.each(SCREENS)("%s 零 violations", async (_name, render) => {
        document.documentElement.setAttribute("data-theme", theme);
        render();
        const violations = await runAxe();
        expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
      });
    });
  }

  it("切换主题不改变可访问性树（同一画面各主题的 ARIA 快照一致）", () => {
    const snapshot = (theme: string) => {
      document.documentElement.setAttribute("data-theme", theme);
      document.body.innerHTML = loadSkeleton();
      renderRunDetail(buildRichState(), { activeTab: "verify", harness: FAKE_HARNESS });
      openDrawer();
      return [...document.querySelectorAll("[role],[aria-label],[aria-labelledby],[aria-selected]")]
        .map((el) =>
          [
            el.tagName,
            el.getAttribute("role") ?? "",
            el.getAttribute("aria-label") ?? "",
            el.getAttribute("aria-labelledby") ?? "",
            el.getAttribute("aria-selected") ?? "",
          ].join("|"),
        );
    };
    const light = snapshot("light");
    for (const theme of ["dark", "graphite", "contrast"]) {
      expect(snapshot(theme), `${theme} 不应改变结构语义`).toEqual(light);
    }
  });

  it("展开的主题菜单零 violations，当前项用单选语义表达", async () => {
    document.body.innerHTML = loadSkeleton();
    const menu = document.getElementById("theme-menu") as HTMLElement;
    const toggle = document.getElementById("theme-toggle") as HTMLButtonElement;
    menu.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    const choices = [...menu.querySelectorAll('[role="menuitemradio"]')];
    choices.forEach((choice, index) => choice.setAttribute("aria-checked", index === 2 ? "true" : "false"));
    expect(choices).toHaveLength(5);
    const violations = await runAxe();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});

// ================================================================
// v2 R6a：会话正史视图 (V-23)
// ================================================================

describe("编排面板", () => {
  function planState() {
    let s = createInitialState("run-plan", "跨领域交付", true);
    const push = (seq: number, source: string, event: Record<string, unknown>) => {
      s = reduceEvent(s, { seq, source, event });
    };
    push(0, "host", {
      type: "plan", concurrency: 2, concurrencyMode: "auto", plannerMs: 8000,
      subtasks: [
        { id: "s1", title: "整理资料", pack: null, description: "", acceptance: ["产出 refs.md"], dependsOn: [], resources: [] },
        { id: "s2", title: "写固件", pack: "stm32-debug", description: "", acceptance: [], dependsOn: [], resources: ["swd-probe"] },
        { id: "s3", title: "汇总", pack: null, description: "", acceptance: [], dependsOn: ["s1", "s2"], resources: [] },
      ],
    });
    push(1, "planner", { type: "turn_start", turn: 1 });
    push(2, "s1/main", { type: "turn_start", turn: 1 });
    push(3, "s2/main", { type: "turn_start", turn: 1 });
    push(4, "host", {
      type: "plan_result", completed: false, planned: true,
      steps: [
        { id: "s1", title: "整理资料", durationMs: 5000, passed: true, reworks: 0 },
        { id: "s2", title: "写固件", durationMs: 9000, passed: false, reworks: 1 },
      ],
      skipped: [{ id: "s3", title: "汇总" }],
      timing: { totalMs: 20000, plannerMs: 8000, subtaskWallMs: 9000, stepSumMs: 14000, savedMs: 5000 },
    });
    return s;
  }

  it("依赖分层渲染：同层并列、跨层标依赖、独占资源可见", () => {
    renderRunDetail(planState(), { activeTab: "loop", harness: FAKE_HARNESS });
    openDrawer();
    const board = document.querySelector(".plan-board")!;
    const layers = [...board.querySelectorAll(".plan-layer")];
    expect(layers).toHaveLength(2);
    expect(layers[0].textContent).toContain("2 个可并发");
    expect(board.querySelector('.plan-node--passed .plan-node-id')!.textContent).toBe("s1");
    expect(board.querySelector(".plan-node--failed")!.textContent).toContain("s2");
    expect(board.querySelector(".plan-node--skipped, .callout")!.textContent).toContain("汇总");
    // 独占资源是"为什么这两个没并发"的唯一解释，必须显式可见
    expect(board.textContent).toContain("swd-probe");
  });

  it("并行收益的每个数字都带口径", () => {
    renderRunDetail(planState(), { activeTab: "loop", harness: FAKE_HARNESS });
    openDrawer();
    const t = document.querySelector(".plan-timing")!.textContent!;
    expect(t).toContain("排除拆解");
    expect(t).toContain("串行基线");
    expect(document.querySelector(".plan-board")!.textContent).toContain("并行买的是时间不是 token");
  });

  it("planner 失败时说清 fail-closed，而不是显示成空计划", () => {
    let s = createInitialState("r", "t", true);
    s = reduceEvent(s, { seq: 0, source: "host", event: { type: "plan", concurrency: 1, subtasks: [] } });
    s = reduceEvent(s, {
      seq: 1, source: "host",
      event: { type: "plan_result", planned: false, completed: false, plannerRaw: "我觉得不用拆", steps: [], skipped: [] },
    });
    renderRunDetail(s, { activeTab: "loop", harness: FAKE_HARNESS });
    openDrawer();
    const board = document.querySelector(".plan-board")!;
    expect(board.textContent).toContain("未能产出可解析计划");
    expect(board.textContent).toContain("我觉得不用拆");
  });

  /**
   * B0：fail-closed 的过程摘要必须渲染出来。「胡言乱语」与「探索没来得及收口」
   * 在原始输出片段上长得一模一样，返工策略却完全不同——只给片段等于让人瞎猜。
   */
  it("planner 失败时给出过程摘要，不只是原始输出片段（B0）", () => {
    let s = createInitialState("r", "t", true);
    s = reduceEvent(s, { seq: 0, source: "host", event: { type: "plan", concurrency: 1, subtasks: [] } });
    s = reduceEvent(s, {
      seq: 1, source: "host",
      event: {
        type: "plan_result", planned: false, completed: false, plannerRaw: "……",
        plannerRecovery: "failed",
        plannerFailure: "拆解未产出可解析计划：跑满 12 轮预算仍未收口，期间发起 9 次工具调用（read_file×6、bash×3）。",
        steps: [], skipped: [],
      },
    });
    renderRunDetail(s, { activeTab: "loop", harness: FAKE_HARNESS });
    openDrawer();
    expect(document.querySelector(".plan-board")!.textContent).toContain("跑满 12 轮预算仍未收口");
  });

  /**
   * 判据没变（非编排运行不该出现子任务盘），**承载物变了**：计划盘从 Loop 面的
   * 下钻搬到了对话右栏，于是"隐藏"由整条右栏承担。锁跟着迁移，不是放宽。
   */
  it("非编排运行不渲染子任务盘（右栏可能因产物而在，但盘要收起）", () => {
    renderRunDetail(buildRichState(), { activeTab: "loop", harness: FAKE_HARNESS });
    const board = document.querySelector(".plan-board") as HTMLElement;
    // 整页只有一处计划盘——两处同名节点会让 querySelector 取到错的那个
    expect(document.querySelectorAll(".plan-board")).toHaveLength(1);
    expect(board.hidden || board.closest("[hidden]") !== null, "非编排运行不该显示子任务盘").toBe(true);
  });

  it("既无子任务也无产物时，右栏整条不占位", () => {
    let s = createInitialState("r-bare", "什么都没产出的任务", false);
    s = reduceEvent(s, { seq: 0, source: "main", event: { type: "assistant_text", text: "说完了" } });
    renderRunDetail(s, { activeTab: "loop", harness: FAKE_HARNESS });
    expect((document.getElementById("detail-rail") as HTMLElement).hidden).toBe(true);
  });

  it("编排面板零 violations（全部主题）", async () => {
    for (const theme of ["light", "dark", "graphite", "contrast"]) {
      document.body.innerHTML = loadSkeleton();
      document.documentElement.setAttribute("data-theme", theme);
      renderRunDetail(planState(), { activeTab: "loop", harness: FAKE_HARNESS });
      openDrawer();
      const violations = await runAxe();
      expect(violations, `${theme}: ${JSON.stringify(violations, null, 2)}`).toEqual([]);
    }
  });
});

// ================================================================
// v2 R8：多轮对话 (V-28)
// ================================================================

describe("统一 composer：一个框，两种去向", () => {
  function doneState() {
    let s = createInitialState("run-mt", "记住暗号", false);
    s = reduceEvent(s, { seq: 0, source: "main", event: { type: "turn_start", turn: 1 } });
    s = reduceEvent(s, {
      seq: 1, source: "main",
      event: { type: "done", stopReason: "completed", usage: { turns: 1 } },
    });
    return s;
  }

  const transcript = {
    segments: [{
      index: 0, source: "main",
      messages: [
        { role: "user", content: "记住暗号 alpha-7" },
        { role: "assistant", content: [{ type: "text", text: "记住了。" }] },
      ],
    }],
  };

  const CONTINUABLE = { runId: "run-mt", status: "done", canContinue: true, workdir: "D:\\repo" };
  const q = (sel: string) => document.querySelector(sel) as HTMLElement;

  // ---- 模式派生（纯函数）----

  it("没选中运行 → 新建；选中可续跑的 → 追加，且带上 runId", () => {
    const m0 = deriveComposerMode({ info: null });
    expect(m0.mode).toBe("new");
    expect(m0.buttonLabel).toBe("运行任务");

    const m1 = deriveComposerMode({ info: CONTINUABLE, localStatus: "done" });
    expect(m1.mode).toBe("append");
    expect(m1.buttonLabel).toBe("继续对话");
    expect(m1.runId).toBe("run-mt");
    // 轮次预算每轮重新起算，不说清用户会以为 maxTurns 是整场对话的总额
    expect(m1.note).toContain("每轮重新起算");
  });

  it("归档检查点显示为显式派生续跑，不冒充原进程无缝继续", () => {
    const mode = deriveComposerMode({
      info: {
        ...CONTINUABLE,
        archived: true,
        continuationMode: "fork",
        continuedFrom: null,
      },
      localStatus: "done",
    });
    expect(mode.mode).toBe("fork");
    expect(mode.kind).toBe("append");
    expect(mode.buttonLabel).toBe("从归档继续");
    expect(mode.note).toContain("派生新运行");
    expect(mode.note).toContain("当前宿主");
    expect(mode.note).toContain("总预算");

    patchComposer(mode);
    expect(document.getElementById("composer-mode-label")!.textContent).toBe("从归档派生续跑");
    expect(document.getElementById("submit-form")!.dataset.mode).toBe("fork");
  });

  /**
   * `createInitialState` 把 status 初始化成 "running"——那是**默认值不是观测**。
   * 拿它当"在跑"的证据，会让点开一条早已结束的运行走出 append→running→append
   * 的抖动，中间还挂一句"运行进行中"的假话。所以本地状态只能单向生效。
   */
  it("本地状态只能把模式往「已结束」推，不能往「在跑」推", () => {
    // 服务端说结束、本地还是初始化默认的 running → 仍然是追加，不抖
    expect(deriveComposerMode({ info: CONTINUABLE, localStatus: "running" }).mode).toBe("append");
    // 服务端说在跑、本地也在跑 → 运行中
    expect(deriveComposerMode({
      info: { ...CONTINUABLE, status: "running", canContinue: false }, localStatus: "running",
    }).mode).toBe("running");
    // 服务端还没刷新、本地已经收到 run_end → 立刻放行（这一侧是真观测）
    expect(deriveComposerMode({
      info: { ...CONTINUABLE, status: "running" }, localStatus: "done",
    }).mode).toBe("append");
  });

  /**
   * V-28 的原意保留：不能追加时要说清为什么。合并之后它不再表现为
   * "没有输入框"，而是同一个框换个去向——**但绝不静默**，必须明说会新建。
   */
  it("不能追加时说清原因，并明说这一提交会新建一次运行", () => {
    const verify = deriveComposerMode({ info: { ...CONTINUABLE, canContinue: false, verify: true } });
    expect(verify.mode).toBe("new-blocked");
    expect(verify.note).toContain("绕过已出具的裁决");
    expect(verify.note).toContain("将新建一次运行");
    expect(verify.canSubmit).toBe(true);

    const plan = deriveComposerMode({ info: { ...CONTINUABLE, canContinue: false, mode: "plan" } });
    expect(plan.note).toContain("没有续跑入口");
    expect(plan.note).toContain("将新建一次运行");

    const exhausted = deriveComposerMode({
      info: {
        ...CONTINUABLE,
        canContinue: false,
        continuationBlockReason: "执行谱系的总轮次预算已用尽（2/2）",
      },
    });
    expect(exhausted.note).toContain("总轮次预算已用尽");
    expect(exhausted.note).toContain("将新建一次运行");
  });

  it("提交在飞时按钮不可点——服务端在返回响应之前就广播了 run_created", () => {
    const m = deriveComposerMode({ info: null, submitting: true });
    expect(m.canSubmit).toBe(false);
    expect(m.buttonLabel).toBe("提交中…");
  });

  // ---- 提交去向（纯函数）----

  it("提交计划：追加带 runId，去空白，运行中一律不发", () => {
    const append = deriveComposerMode({ info: CONTINUABLE, localStatus: "done" });
    expect(composerSubmitPlan(append, "  暗号是什么？  ")).toEqual({
      kind: "append", runId: "run-mt", text: "暗号是什么？",
    });
    expect(composerSubmitPlan(append, "   ")).toBeNull();

    /**
     * 运行中这个位置**改成了「停止」**（此前是一个灰着的「运行任务」）。
     * 所以判据从"一律不发"变成"发的是停止、且不吃那半截草稿"——
     * 那段文字是给下一轮准备的，不该拦着人叫停。
     */
    const running = deriveComposerMode({
      info: { ...CONTINUABLE, status: "running", canContinue: false }, localStatus: "running",
    });
    expect(composerSubmitPlan(running, "已经写好了")).toEqual({
      kind: "stop", runId: "run-mt", text: "",
    });

    expect(composerSubmitPlan(deriveComposerMode({ info: null }), "新任务")).toEqual({
      kind: "new", runId: null, text: "新任务",
    });
  });

  // ---- DOM 应用 ----

  it("追加模式：按钮/标签/说明一起变，装配项禁用但附件仍可用", () => {
    patchComposer(deriveComposerMode({ info: CONTINUABLE, localStatus: "done" }));
    expect(q("#submit-btn-label").textContent).toBe("继续对话");
    expect((q("#submit-btn") as HTMLButtonElement).disabled).toBe(false);
    // 可及名称不能说谎：这一刻它不是「任务描述」
    expect(q('label[for="task-input"]').textContent).toBe("追加指令");
    expect(q("#composer-note").hidden).toBe(false);
    expect(q("#task-input").getAttribute("aria-describedby")).toBe("composer-note");

    // 续跑复用原运行的装配，这一组构造上无效——禁用而不是藏起来
    expect((q("#verify-toggle") as HTMLInputElement).disabled).toBe(true);
    expect((q("#rubric-input") as HTMLTextAreaElement).disabled).toBe(true);
    // 但**不动面板的开合**：那是用户状态，后台事件去改它会把焦点踢回 body
    expect(q("#run-knobs").hidden).toBe(true); // 骨架初始就是折叠的，没被动过
    // 附件走独立端点、不进请求体，续跑照常能用
    expect((q("#file-upload") as HTMLInputElement).disabled).toBe(false);
  });

  it("运行中：按钮变「停止」，输入框仍可打草稿，原因写在 note 里", () => {
    patchComposer(deriveComposerMode({
      info: { ...CONTINUABLE, status: "running", canContinue: false }, localStatus: "running",
    }));
    // 从"灰着的运行任务"改成"可点的停止"：同一个位置，两种状态，不加第二个控件
    expect(q("#submit-btn-label").textContent).toBe("停止");
    expect((q("#submit-btn") as HTMLButtonElement).disabled).toBe(false);
    expect((q("#task-input") as HTMLTextAreaElement).disabled).toBe(false);
    expect(q("#composer-note").textContent).toContain("等这一轮结束");
    // disabled 的按钮不可聚焦、不会被读到，原因只能挂在输入框上
    expect(document.getElementById(q("#task-input").getAttribute("aria-describedby")!)).toBeTruthy();
  });

  it("切回新建模式时装配项解禁、说明行收起", () => {
    patchComposer(deriveComposerMode({ info: CONTINUABLE, localStatus: "done" }));
    patchComposer(deriveComposerMode({ info: null }));
    expect(q("#submit-btn-label").textContent).toBe("运行任务");
    expect(q('label[for="task-input"]').textContent).toBe("任务描述");
    expect((q("#verify-toggle") as HTMLInputElement).disabled).toBe(false);
    expect((q("#rubric-input") as HTMLTextAreaElement).disabled).toBe(false);
    expect(q("#composer-note").hidden).toBe(true);
    expect(q("#task-input").getAttribute("aria-describedby")).toBeNull();
  });

  /**
   * 合并把输入框从"每次重建"变成"永久存在"，重复绑定从不可能变成一步之遥。
   * 用职责切分堵死：patchComposer 只写属性，一行 addEventListener 都没有。
   */
  it("patchComposer 反复调用不会累积事件监听", () => {
    let clicks = 0;
    q("#submit-btn").addEventListener("click", () => clicks++);
    for (let i = 0; i < 5; i++) patchComposer(deriveComposerMode({ info: CONTINUABLE, localStatus: "done" }));
    (q("#submit-btn") as HTMLElement).click();
    expect(clicks).toBe(1);
  });

  it("禁用一个正被聚焦的装配项时，焦点交还输入框而不是掉回 body", () => {
    const rubric = q("#rubric-input") as HTMLTextAreaElement;
    rubric.focus();
    expect(document.activeElement).toBe(rubric);
    patchComposer(deriveComposerMode({ info: CONTINUABLE, localStatus: "done" }));
    expect(document.activeElement).toBe(q("#task-input"));
  });

  it("提交错误显示在 #submit-error，且随模式清掉——不会挂到另一次运行头上", () => {
    patchComposer(deriveComposerMode({ info: CONTINUABLE, localStatus: "done", error: "HTTP 409" }));
    expect(q("#submit-error").hidden).toBe(false);
    expect(q("#submit-error").textContent).toContain("409");
    patchComposer(deriveComposerMode({ info: null }));
    expect(q("#submit-error").hidden).toBe(true);
  });

  it("整页只有一个输入框、一个 role=alert，且不留任何旧的追加框残迹", () => {
    patchComposer(deriveComposerMode({ info: CONTINUABLE, localStatus: "done" }));
    renderRunDetail(doneState(), {
      activeTab: "loop", harness: FAKE_HARNESS, loopView: "chat", transcript,
    });
    openDrawer();
    expect(document.querySelectorAll("#task-input")).toHaveLength(1);
    expect(document.querySelectorAll("form")).toHaveLength(1);
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(document.querySelector("[class*='followup']")).toBeNull();
    expect(document.getElementById("main-area")!.querySelector("form")).toBeNull();
  });

  /**
   * transcript 只在每一段结束时落盘。追加的那句话此刻只存在于事件流里，
   * 不补上的话用户会看到自己刚发的消息凭空消失。
   */
  /**
   * 对话改从**事件流**派生之后，"追加的话要不要补进去"这个问题本身消失了——
   * 它本来就在事件流里。此前要靠一段特判把它塞进 transcript 的渲染结果里，
   * 因为 transcript 只在段结束时才落盘。这条锁住新形态：追加即可见，且实时。
   */
  it("追加的指令立刻出现在对话主干里（不必等落盘）", () => {
    let s = doneState();
    s = reduceEvent(s, {
      seq: 2, source: "host",
      event: { type: "user_message", turn: 2, text: "暗号是什么？", at: 1 },
    });
    expect(s.status, "user_message 应把 run 从终态拉回运行中").toBe("running");

    renderRunDetail(s, { activeTab: "loop", harness: FAKE_HARNESS });

    const chat = document.querySelector(".conversation")!;
    expect(chat.textContent).toContain("暗号是什么？");
  });

  it("composer 的两种模式各自零 violations（全部主题）", async () => {
    const modes = [
      deriveComposerMode({ info: CONTINUABLE, localStatus: "done" }),
      deriveComposerMode({ info: { ...CONTINUABLE, status: "running", canContinue: false }, localStatus: "running" }),
    ];
    for (const theme of ["light", "dark", "graphite", "contrast"]) {
      for (const mode of modes) {
        document.body.innerHTML = loadSkeleton();
        document.documentElement.setAttribute("data-theme", theme);
        renderRunDetail(doneState(), {
          activeTab: "loop", harness: FAKE_HARNESS, loopView: "chat", transcript,
        });
        openDrawer();
        // 必须先打补丁再扫：不打的话 axe 看到的永远是那份静态骨架，
        // 「禁用 + aria-describedby + note 可见」这个组合形态一眼都扫不到
        patchComposer(mode);
        expect(q("#composer-note").hidden, "前置：note 应当可见，否则这条扫描等于没扫").toBe(false);
        const violations = await runAxe();
        expect(violations, `${theme}/${mode.mode}: ${JSON.stringify(violations, null, 2)}`).toEqual([]);
      }
    }
  });
});

describe("侧栏按工作目录分组", () => {
  const meta = new Map();
  const runs = (dirs: string[]) =>
    dirs.map((d, i) => ({ runId: `r${i}`, task: `任务 ${i}`, status: "done", verify: false, workdir: d }));

  it("只有一个工作目录时仍保留项目层——信息架构不随项目数量漂移", () => {
    const list = runs(["D:\\proj-a", "D:\\proj-a"]);
    (list[0] as any).conversationTurn = 3;
    renderRunList(list, null, () => {}, meta);
    expect(document.querySelectorAll('#run-list [role="group"]')).toHaveLength(1);
    expect(document.querySelector('#run-list [role="group"]')!.getAttribute("aria-label")).toBe("proj-a");
    expect(document.querySelectorAll("#run-list .run-item")).toHaveLength(2);
    expect(document.querySelector(".run-item-turns")!.textContent).toBe("3 轮");
  });

  // 两种分隔符都要覆盖：宿主主要跑在 Windows（反斜杠），但路径也可能是 posix 风格。
  // 只切 `/` 的话 Windows 路径切不开，组名会退化成整条绝对路径——初版正是这个 bug。
  it.each([
    ["Windows 反斜杠", ["D:\\work\\proj-a", "D:\\work\\proj-b", "D:\\work\\proj-a"]],
    ["posix 斜杠", ["/home/u/proj-a", "/home/u/proj-b", "/home/u/proj-a"]],
  ])("多个工作目录时分组，组名取路径末段（%s）", (_label, dirs) => {
    renderRunList(runs(dirs as string[]), null, () => {}, meta);
    const groups = [...document.querySelectorAll('#run-list [role="group"]')];
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["proj-a", "proj-b"]);
    // 分组不改变 option 总数，也不改变 listbox 身份
    expect(document.querySelectorAll("#run-list .run-item")).toHaveLength(3);
    expect(document.getElementById("run-list")!.getAttribute("role")).toBe("listbox");
  });

  it("分组后 option 仍在 listbox 的合法子树内（axe 零 violations）", async () => {
    renderRunList(runs(["D:\\work\\a", "D:\\work\\b"]), "r0", () => {}, meta);
    const violations = await runAxe();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("分组渲染同样复用节点，焦点不丢", () => {
    const list = runs(["D:\\work\\a", "D:\\work\\b"]);
    renderRunList(list, null, () => {}, meta);
    const item = document.querySelector("#run-list .run-item") as HTMLElement;
    item.focus();
    renderRunList(list, "r0", () => {}, meta);
    expect(document.querySelector("#run-list .run-item")).toBe(item);
    expect(document.activeElement).toBe(item);
  });
});

describe("常驻上下文水位", () => {
  function stateWithUsage(input: number, compactions = 0) {
    let s = createInitialState("run-c", "任务", false);
    s = reduceEvent(s, {
      seq: 0, source: "main",
      event: { type: "usage", turn: 1, usage: { input_tokens: input, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    });
    for (let i = 0; i < compactions; i++) {
      s = reduceEvent(s, { seq: 10 + i, source: "main", event: { type: "compaction", droppedBlocks: 3 } });
    }
    return s;
  }

  const H = { ...FAKE_HARNESS, guardrails: { ...FAKE_HARNESS.guardrails, contextTokenLimit: 1000 } };

  it("无用量时不显示——不给一个恒为 0% 的摆设", () => {
    renderRunDetail(createInitialState("r", "t", false), { activeTab: "loop", harness: H });
    openDrawer();
    expect((document.querySelector(".ctx-gauge") as HTMLElement).hidden).toBe(true);
  });

  it("显示百分比与刻度，无障碍名称说全口径", () => {
    renderRunDetail(stateWithUsage(480), { activeTab: "loop", harness: H });
    openDrawer();
    const g = document.querySelector(".ctx-gauge") as HTMLElement;
    expect(g.hidden).toBe(false);
    expect(g.textContent).toContain("48%");
    const label = g.getAttribute("aria-label")!;
    // 光念一个 48% 没有信息量——要说清分子分母是什么
    expect(label).toContain("最近一轮输入");
    expect(label).toContain("上限");
  });

  it("越过压缩水位转 warn 语域", () => {
    renderRunDetail(stateWithUsage(900), { activeTab: "loop", harness: H });
    openDrawer();
    expect(document.querySelector(".ctx-gauge")!.classList.contains("ctx-gauge--warn")).toBe(true);
  });

  /**
   * 已压缩与"快满了"不是一个语域：前者是**已经不可逆地丢过 tool_result 原文**
   * （MEM-01 账本可保留摘要），后者只是预警。共用一个颜色会让人对前者脱敏。
   */
  it("已发生压缩时走不可逆语域，并在名称里说明账本保留", () => {
    renderRunDetail(stateWithUsage(300, 2), { activeTab: "loop", harness: H });
    openDrawer();
    const g = document.querySelector(".ctx-gauge")!;
    expect(g.classList.contains("ctx-gauge--irreversible")).toBe(true);
    expect(g.textContent).toContain("压缩 2");
    const label = g.getAttribute("aria-label") ?? "";
    expect(label).toContain("置换");
    expect(label).toContain("结构化账本");
  });

  it("点击跳到 Context 面——图标是入口不是死数字", () => {
    const seen: string[] = [];
    document.addEventListener("tab-switch", (e) => seen.push((e as CustomEvent).detail.tab));
    renderRunDetail(stateWithUsage(480), { activeTab: "loop", harness: H });
    openDrawer();
    (document.querySelector(".ctx-gauge") as HTMLElement).click();
    expect(seen).toEqual(["context"]);
  });

  /**
   * 没配上限时不画刻度：五个空格看起来像"0%"，而事实是"不知道"。
   * 用空刻度表达未知就是在说谎——这条和三值裁决里的 unverified 是同一个道理。
   */
  it("未配置上下文上限时只报绝对值，既不编造百分比也不画空刻度", () => {
    renderRunDetail(stateWithUsage(480), {
      activeTab: "loop", harness: { ...FAKE_HARNESS, guardrails: {} },
    });
    openDrawer();
    const g = document.querySelector(".ctx-gauge")!;
    expect(g.textContent).not.toContain("%");
    expect(g.textContent).not.toContain("▯");
    expect(g.textContent).not.toContain("▮");
    expect(g.textContent).toContain("上下文");
    expect(g.getAttribute("aria-label")).toContain("未配置上限");
  });

  it("配了上限时用统一图标 + 百分比报水位，不用文本方块模拟图形", () => {
    const H2 = { ...FAKE_HARNESS, guardrails: { ...FAKE_HARNESS.guardrails, contextTokenLimit: 1000 } };
    renderRunDetail(stateWithUsage(150), { activeTab: "loop", harness: H2 });
    openDrawer();
    const low = document.querySelector(".ctx-gauge")!;
    expect(low.querySelector(".ph-gauge")).toBeTruthy();
    expect(low.textContent).toContain("15%");
    expect(low.textContent).not.toMatch(/[▮▯]/);
    document.body.innerHTML = loadSkeleton();
    renderRunDetail(stateWithUsage(950), { activeTab: "loop", harness: H2 });
    openDrawer();
    const high = document.querySelector(".ctx-gauge")!;
    expect(high.querySelector(".ph-gauge")).toBeTruthy();
    expect(high.textContent).toContain("95%");
  });
});

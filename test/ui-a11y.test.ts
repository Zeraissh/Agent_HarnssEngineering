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
  renderConversation,
} from "../ui/public/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "..", "ui", "public");

/** 取真实 index.html 的 body 骨架，剥掉 <script>（innerHTML 注入本就不执行脚本，显式剥离是为了语义清晰） */
function loadSkeleton(): string {
  const html = readFileSync(join(UI_DIR, "index.html"), "utf-8");
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? "";
  return body.replace(/<script[\s\S]*?<\/script>/g, "");
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
    const violations = await runAxe();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("运行详情·Context 面（水位条 + token 三分 + 逐轮表）", async () => {
    renderRunDetail(buildRichState(), { activeTab: "context", harness: FAKE_HARNESS });
    const violations = await runAxe();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("运行详情·Tools 面（工具芯片 + 边界清单）", async () => {
    renderRunDetail(buildRichState(), { activeTab: "tools", harness: FAKE_HARNESS });
    const violations = await runAxe();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("运行详情·Verification 面（三值裁决 + 饥饿告警 + 边界）", async () => {
    renderRunDetail(buildRichState(), { activeTab: "verify", harness: FAKE_HARNESS });
    const violations = await runAxe();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("窄屏详情态（含返回列表按钮）", async () => {
    renderRunDetail(buildRichState(), {
      activeTab: "loop", showBack: true, onBack: () => {}, harness: FAKE_HARNESS,
    });
    const violations = await runAxe();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("宿主快照缺席时降级渲染仍零 violations", async () => {
    renderRunDetail(buildRichState(), { activeTab: "tools" });
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
    const panel2 = document.querySelector('[role="tabpanel"]')!;
    expect(panel2.getAttribute("aria-labelledby")).toBe("tab-context");
    expect(document.getElementById("tab-context")).toBeTruthy();
  });

  it("旧标签 id 归一到 Loop 面，深链不 404", () => {
    for (const legacy of ["overview", "log", undefined, "bogus"]) {
      renderRunDetail(buildRichState(), { activeTab: legacy, harness: FAKE_HARNESS });
      const panel = document.querySelector('[role="tabpanel"]')!;
      expect(panel.getAttribute("aria-labelledby")).toBe("tab-loop");
    }
  });

  it("roving tabindex：仅选中项可 Tab 进入，其余为 -1", () => {
    renderRunDetail(buildRichState(), { activeTab: "loop", harness: FAKE_HARNESS });
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
    const panel = document.querySelector('[role="tabpanel"]')!;
    expect(panel.textContent).toContain("核查未运行");
    // 这一句是要害：没有裁决不等于没有问题
    expect(panel.textContent).toContain("没有裁决不等于没有问题");
  });

  it("当前查看的面在卡片上有选中标记（卡片即标签）", () => {
    renderRunDetail(buildRichState(), { activeTab: "tools", harness: FAKE_HARNESS });
    const active = document.querySelector('.factor-card[aria-selected="true"]')!;
    expect(active.getAttribute("data-factor")).toBe("tools");
    expect(active.classList.contains("factor-card--active")).toBe(true);
    expect(active.getAttribute("aria-label")).toContain("当前查看");
    expect(document.querySelectorAll('.factor-card[aria-selected="true"]')).toHaveLength(1);
  });

  it("不再存在与因子卡重复的第二排标签", () => {
    renderRunDetail(buildRichState(), { activeTab: "loop", harness: FAKE_HARNESS });
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
    document.querySelector('[role="tabpanel"]')!.setAttribute("aria-labelledby", "tab-does-not-exist");
    const unexpected = (await incompleteIds()).filter((id) => !KNOWN_INCOMPLETE.has(id));
    expect(unexpected).toContain("aria-valid-attr-value");
  });
});

describe("环境边界声明（防止把 incomplete 误当通过）", () => {
  it("详情页的待复核项不得超出已知白名单（新增 incomplete 必须有人看一眼）", async () => {
    renderRunDetail(buildRichState(), { activeTab: "loop", harness: FAKE_HARNESS });
    renderRunList([{ runId: "run-1", task: "t", status: "done", verify: true }], "run-1", () => {}, new Map());
    const unexpected = (await incompleteIds()).filter((id) => !KNOWN_INCOMPLETE.has(id));
    expect(unexpected, `新出现的待复核规则: ${unexpected.join(", ")}`).toEqual([]);
  });

  it("color-contrast 在 jsdom 下不产出 violations —— 对比度由 ui-app.test.ts 的 WCAG 实算测试守护", async () => {
    renderRunDetail(buildRichState(), { activeTab: "loop", harness: FAKE_HARNESS });
    const results = await axe.run(document, { runOnly: { type: "rule", values: ["color-contrast"] } });
    // 断言的是"这里不承担对比度判定"这一事实，而不是"对比度没问题"
    expect(results.violations).toEqual([]);
  });
});

// ================================================================
// v2 R5：双主题下的结构语义（V-20）
// ================================================================

describe("双主题：data-theme 切换不改变结构语义", () => {
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
  for (const theme of ["light", "dark"] as const) {
    describe(`${theme} 主题`, () => {
      it.each(SCREENS)("%s 零 violations", async (_name, render) => {
        document.documentElement.setAttribute("data-theme", theme);
        render();
        const violations = await runAxe();
        expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
      });
    });
  }

  it("切换主题不改变可访问性树（同一画面两套主题的 ARIA 快照一致）", () => {
    const snapshot = (theme: string) => {
      document.documentElement.setAttribute("data-theme", theme);
      document.body.innerHTML = loadSkeleton();
      renderRunDetail(buildRichState(), { activeTab: "verify", harness: FAKE_HARNESS });
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
    expect(snapshot("dark")).toEqual(snapshot("light"));
  });
});

// ================================================================
// v2 R6a：会话正史视图 (V-23)
// ================================================================

describe("对话视图", () => {
  const transcript = {
    segments: [
      {
        index: 0,
        source: "main",
        messages: [
          { role: "user", content: "创建 demo.txt" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "我先写文件。" },
              { type: "tool_use", id: "t1", name: "write_file", input: { path: "demo.txt" } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "Wrote 5 bytes" }],
          },
          { role: "assistant", content: [{ type: "text", text: "已完成。" }] },
        ],
      },
    ],
  };

  function mount(t: unknown) {
    const host = document.createElement("div");
    host.innerHTML = renderConversation(t, { lastSeq: 0 });
    document.body.appendChild(host);
    return host;
  }

  /**
   * 这一条是整个视图最容易搞错的地方：Anthropic 协议把**工具返回值放在
   * user 角色里**回传给模型。照 role 直接画气泡的话，界面会显示成
   * "用户对着 agent 念了一堆命令输出"——完全不是发生过的事。
   */
  it("带 tool_result 的 user 消息渲染为工具返回，不是用户发言", () => {
    const host = mount(transcript);
    const userBubbles = [...host.querySelectorAll(".chat-msg--user")];
    // 只有真正的那一句任务描述算用户发言
    expect(userBubbles).toHaveLength(1);
    expect(userBubbles[0].textContent).toContain("创建 demo.txt");

    const toolBubbles = [...host.querySelectorAll(".chat-msg--tool")];
    expect(toolBubbles).toHaveLength(1);
    expect(toolBubbles[0].textContent).toContain("Wrote 5 bytes");
    expect(toolBubbles[0].textContent).not.toContain("委托方");
  });

  it("assistant 的 text 与 tool_use 同框呈现", () => {
    const host = mount(transcript);
    const a = [...host.querySelectorAll(".chat-msg--assistant")];
    expect(a).toHaveLength(2);
    expect(a[0].textContent).toContain("我先写文件");
    expect(a[0].querySelector(".chat-toolcall")?.textContent).toContain("write_file");
  });

  it("失败的工具返回带错误标记", () => {
    const host = mount({
      segments: [{
        index: 0, source: "main",
        messages: [{
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", content: "boom", is_error: true }],
        }],
      }],
    });
    expect(host.querySelector(".chat-msg--tool-err")).toBeTruthy();
  });

  it("tool_result 的 content 为内容块数组时同样能取出文本", () => {
    const host = mount({
      segments: [{
        index: 0, source: "main",
        messages: [{
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "块形式输出" }] }],
        }],
      }],
    });
    expect(host.querySelector(".chat-msg--tool")!.textContent).toContain("块形式输出");
  });

  it("多段会话之间插入来源分界", () => {
    const host = mount({
      segments: [
        { index: 0, source: "main", messages: [{ role: "user", content: "任务" }] },
        { index: 1, source: "rework", messages: [{ role: "user", content: "返工" }] },
      ],
    });
    const bounds = [...host.querySelectorAll(".segment-boundary")];
    expect(bounds.length).toBeGreaterThanOrEqual(2);
    expect(bounds.some((b) => b.textContent!.includes("返工"))).toBe(true);
  });

  it("未拉到 / 为空时给出解释而不是空白", () => {
    expect(mount(null).textContent).toContain("正在载入会话");
    expect(mount({ segments: [] }).textContent).toContain("尚无完整会话记录");
  });

  it("对话视图零 violations（两套主题）", async () => {
    for (const theme of ["light", "dark"]) {
      document.body.innerHTML = loadSkeleton();
      document.documentElement.setAttribute("data-theme", theme);
      renderRunDetail(buildRichState(), {
        activeTab: "loop", harness: FAKE_HARNESS, loopView: "chat", transcript,
      });
      const violations = await runAxe();
      expect(violations, `${theme}: ${JSON.stringify(violations, null, 2)}`).toEqual([]);
    }
  });
});

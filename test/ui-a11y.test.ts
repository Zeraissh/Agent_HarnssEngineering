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
} from "../ui/public/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "..", "ui", "public");

/** 取真实 index.html 的 body 骨架，剥掉 <script>（innerHTML 注入本就不执行脚本，显式剥离是为了语义清晰） */
function loadSkeleton(): string {
  const html = readFileSync(join(UI_DIR, "index.html"), "utf-8");
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? "";
  return body.replace(/<script[\s\S]*?<\/script>/g, "");
}

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

  it("运行详情·概览标签（审批卡 + 三值裁决 + 用量）", async () => {
    renderRunDetail(buildRichState(), { activeTab: "overview" });
    const violations = await runAxe();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("运行详情·运行日志标签（折叠/展开条目）", async () => {
    renderRunDetail(buildRichState(), { activeTab: "log" });
    const violations = await runAxe();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("运行详情·核查标签（核查过程 + 裁决）", async () => {
    renderRunDetail(buildRichState(), { activeTab: "verify" });
    const violations = await runAxe();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("窄屏详情态（含返回列表按钮）", async () => {
    renderRunDetail(buildRichState(), { activeTab: "overview", showBack: true, onBack: () => {} });
    const violations = await runAxe();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
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
    renderRunDetail(buildRichState(), { activeTab: "overview" });
    document.querySelector('[role="tabpanel"]')!.setAttribute("aria-labelledby", "tab-does-not-exist");
    const unexpected = (await incompleteIds()).filter((id) => !KNOWN_INCOMPLETE.has(id));
    expect(unexpected).toContain("aria-valid-attr-value");
  });
});

describe("环境边界声明（防止把 incomplete 误当通过）", () => {
  it("详情页的待复核项不得超出已知白名单（新增 incomplete 必须有人看一眼）", async () => {
    renderRunDetail(buildRichState(), { activeTab: "overview" });
    renderRunList([{ runId: "run-1", task: "t", status: "done", verify: true }], "run-1", () => {}, new Map());
    const unexpected = (await incompleteIds()).filter((id) => !KNOWN_INCOMPLETE.has(id));
    expect(unexpected, `新出现的待复核规则: ${unexpected.join(", ")}`).toEqual([]);
  });

  it("color-contrast 在 jsdom 下不产出 violations —— 对比度由 ui-app.test.ts 的 WCAG 实算测试守护", async () => {
    renderRunDetail(buildRichState(), { activeTab: "overview" });
    const results = await axe.run(document, { runOnly: { type: "rule", values: ["color-contrast"] } });
    // 断言的是"这里不承担对比度判定"这一事实，而不是"对比度没问题"
    expect(results.violations).toEqual([]);
  });
});

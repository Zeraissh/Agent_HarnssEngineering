// @vitest-environment jsdom
// @ts-nocheck
/**
 * 全局搜索（features/global-search.js）的回归锁——T6。
 *
 * 分层覆盖：
 *   纯函数层：响应整形 / 高亮切分 / 最短长度判定 / 文案常量
 *   DOM 层  ：jsdom 里真实初始化 + 注入 fetchFn，验证两档交互（本地过滤
 *             不被动、Enter/框内提示触发全局搜索）、加载态、结果渲染与 <mark>
 *             高亮、点击跳转、空态、错误态与重试、截断标注、关闭行为
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  normalizeSearchResponse,
  highlightRanges,
  isSearchable,
  SEARCH_COPY,
  initGlobalSearch,
} from "../ui/public/features/global-search.js";

const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------
describe("normalizeSearchResponse 响应整形", () => {
  it("合法负载原样通过，缺省字段降级", () => {
    const out = normalizeSearchResponse({
      query: "kicad",
      truncatedRuns: true,
      results: [
        {
          runId: "r1",
          title: "修理 KiCad",
          workdir: "D:/proj",
          status: "done",
          updatedAt: NOW,
          titleHit: true,
          snippets: [{ text: "在 KiCad 里", lineHint: "transcript.jsonl 第 2 行" }],
        },
        { runId: "r2" }, // 只有必填字段
      ],
    });
    expect(out.query).toBe("kicad");
    expect(out.truncatedRuns).toBe(true);
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toMatchObject({ runId: "r1", titleHit: true });
    expect(out.results[0].snippets[0].text).toContain("KiCad");
    expect(out.results[1]).toMatchObject({
      title: "",
      workdir: null,
      status: "done",
      updatedAt: 0,
      titleHit: false,
      snippets: [],
    });
  });

  it("畸形负载降级为空结果；无 runId / 无 text 的条目被过滤", () => {
    expect(normalizeSearchResponse(null)).toEqual({ query: "", results: [], truncatedRuns: false });
    expect(normalizeSearchResponse("junk").results).toEqual([]);
    const out = normalizeSearchResponse({
      results: [
        { title: "没有 runId" },
        { runId: "ok", snippets: [{ lineHint: "没正文" }, { text: "有正文" }] },
      ],
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0].snippets).toEqual([{ text: "有正文", lineHint: "" }]);
  });
});

describe("highlightRanges 高亮切分", () => {
  it("大小写不敏感切出全部命中段", () => {
    expect(highlightRanges("在 KiCad 里用 kicad 画图", "KICAD")).toEqual([
      { text: "在 ", hit: false },
      { text: "KiCad", hit: true },
      { text: " 里用 ", hit: false },
      { text: "kicad", hit: true },
      { text: " 画图", hit: false },
    ]);
  });

  it("无命中 / 空查询时整段返回且不标 hit", () => {
    expect(highlightRanges("没有这个词", "xyz")).toEqual([{ text: "没有这个词", hit: false }]);
    expect(highlightRanges("原文", "")).toEqual([{ text: "原文", hit: false }]);
    expect(highlightRanges("", "q")).toEqual([]);
  });
});

describe("isSearchable 最短长度判定", () => {
  it("去空白后至少 2 个字符", () => {
    expect(isSearchable("")).toBe(false);
    expect(isSearchable(" a ")).toBe(false);
    expect(isSearchable("文")).toBe(false);
    expect(isSearchable("文件")).toBe(true);
    expect(isSearchable(" kicad ")).toBe(true);
  });
});

describe("SEARCH_COPY 错误人话", () => {
  it("500 / 网络失败脸上不写 HTTP 状态码", () => {
    expect(SEARCH_COPY.error(500)).toBe("搜索没做成");
    expect(SEARCH_COPY.error(500)).not.toMatch(/HTTP\s*\d/i);
    expect(SEARCH_COPY.error(429)).not.toMatch(/HTTP\s*\d/i);
    expect(SEARCH_COPY.networkError).not.toMatch(/HTTP\s*\d/i);
    expect(SEARCH_COPY.error(400)).toContain("至少 2 个字符");
  });
});

// ---------------------------------------------------------------
// DOM 层
// ---------------------------------------------------------------
function mockResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function setupDom() {
  document.body.innerHTML =
    '<div class="sidebar-search">' +
    '<div class="run-search-field"><input type="search" id="run-search" /></div>' +
    "</div>";
}

const SEARCH_PAYLOAD = {
  query: "kicad",
  truncatedRuns: false,
  results: [
    {
      runId: "r-title",
      title: "修理 KiCad 封装",
      workdir: "D:/proj",
      status: "done",
      updatedAt: NOW - 60_000,
      titleHit: true,
      snippets: [],
    },
    {
      runId: "r-body",
      title: "画板子",
      workdir: null,
      status: "running",
      updatedAt: NOW - 30 * 60_000,
      titleHit: false,
      snippets: [
        { text: "先在 KiCad 里建工程，再布线", lineHint: "transcript.jsonl 第 2 行" },
        { text: "kicad 的封装库路径", lineHint: "transcript.jsonl 第 5 行" },
      ],
    },
  ],
};

/** 等待面板内出现满足条件的节点（搜索是异步的） */
async function waitFor(fn, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value && (typeof value.length !== "number" || value.length > 0)) return value;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function pressEnter(el) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

describe("initGlobalSearch DOM 层", () => {
  beforeEach(setupDom);
  afterEach(() => { document.body.innerHTML = ""; });

  it("挂载紧凑全局搜索提示到搜索框内，不另开兄弟槽", () => {
    initGlobalSearch({}, { fetchFn: vi.fn(), now: () => NOW });
    const trigger = document.getElementById("global-search-trigger");
    const field = document.querySelector(".run-search-field");
    expect(trigger).toBeTruthy();
    expect(field.contains(trigger)).toBe(true);
    expect(trigger.getAttribute("aria-label")).toBe(SEARCH_COPY.trigger);
    const kbd = trigger.querySelector("kbd.palette-kbd");
    expect(kbd).toBeTruthy();
    expect(kbd.getAttribute("aria-hidden")).toBe("true");
    expect(kbd.textContent).toBe("Enter");
    expect(trigger.textContent.trim()).toBe("Enter");
  });

  it("Enter 触发搜索：URL 编码查询词，先转圈后渲染结果", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const fetchFn = vi.fn(async () => { await gate; return mockResponse(200, SEARCH_PAYLOAD); });
    const api = initGlobalSearch({}, { fetchFn, now: () => NOW });
    const input = document.getElementById("run-search");
    input.value = " kicad ";
    pressEnter(input);

    // 加载态：面板打开 + 转圈文案
    await waitFor(() => !api.element.hidden);
    expect(document.querySelector(".gs-spin")).toBeTruthy();
    expect(document.querySelector(".gs-status").textContent).toContain(SEARCH_COPY.loading);

    release();
    const items = await waitFor(() => document.querySelectorAll(".gs-item"));
    expect(fetchFn).toHaveBeenCalledWith("/api/search?q=kicad");
    expect(items).toHaveLength(2);

    // 标题命中：徽标 + 标题里的 <mark>
    const first = items[0];
    expect(first.querySelector(".gs-item-badge").textContent).toBe(SEARCH_COPY.titleHitBadge);
    const titleMark = first.querySelector(".gs-item-title mark");
    expect(titleMark.textContent).toBe("KiCad");

    // 正文命中：片段 <mark> 高亮 + 行号 + 状态/相对时间
    const second = items[1];
    const marks = second.querySelectorAll(".gs-snippet mark");
    expect(marks).toHaveLength(2);
    expect(marks[0].textContent).toBe("KiCad");
    expect(marks[1].textContent).toBe("kicad"); // 保留原文大小写
    expect(second.querySelector(".gs-snippet-hint").textContent).toBe("transcript.jsonl 第 2 行");
    expect(second.querySelector(".gs-item-meta").textContent).toContain("运行中");
    expect(second.querySelector(".gs-item-meta").textContent).toContain("分钟前");
    // 命中词之外的片段文本不被转义破坏（textContent 拼装，原文样保留）
    expect(second.querySelector(".gs-snippet-text").textContent).toContain("先在 KiCad 里建工程，再布线");
  });

  it("点击结果跳转该会话并关闭面板", async () => {
    const onOpenConversation = vi.fn();
    const fetchFn = vi.fn(async () => mockResponse(200, SEARCH_PAYLOAD));
    const api = initGlobalSearch({ onOpenConversation }, { fetchFn, now: () => NOW });
    document.getElementById("run-search").value = "kicad";
    pressEnter(document.getElementById("run-search"));
    const items = await waitFor(() => document.querySelectorAll(".gs-item"));
    items[1].click();
    expect(onOpenConversation).toHaveBeenCalledWith("r-body");
    expect(api.isOpen()).toBe(false);
  });

  it("触发按钮与 Enter 等价", async () => {
    const fetchFn = vi.fn(async () => mockResponse(200, SEARCH_PAYLOAD));
    initGlobalSearch({}, { fetchFn, now: () => NOW });
    document.getElementById("run-search").value = "kicad";
    document.getElementById("global-search-trigger").click();
    await waitFor(() => document.querySelectorAll(".gs-item"));
    expect(fetchFn).toHaveBeenCalledWith("/api/search?q=kicad");
  });

  it("空结果有空态文案，truncatedRuns 有标注", async () => {
    const fetchFn = vi.fn(async () =>
      mockResponse(200, { query: "冷门词", results: [], truncatedRuns: true }));
    initGlobalSearch({}, { fetchFn, now: () => NOW });
    const input = document.getElementById("run-search");
    input.value = "冷门词";
    pressEnter(input);
    const status = await waitFor(() => {
      const el = document.querySelector(".gs-status");
      return el && !el.hidden && el.textContent.includes("没有找到") ? el : null;
    });
    expect(status.textContent).toBe(SEARCH_COPY.empty("冷门词"));
    const note = document.querySelector(".gs-note");
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain("500");
  });

  it("HTTP 错误行内提示（role=alert，不 alert）+ 重试可恢复", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? mockResponse(500, {}) : mockResponse(200, SEARCH_PAYLOAD);
    });
    initGlobalSearch({}, { fetchFn, now: () => NOW });
    const input = document.getElementById("run-search");
    input.value = "kicad";
    pressEnter(input);
    const alert = await waitFor(() => {
      const el = document.querySelector('.gs-status[role="alert"]');
      return el && !el.hidden ? el : null;
    });
    expect(alert.textContent).toContain(SEARCH_COPY.error(500));

    document.querySelector(".gs-retry").click();
    await waitFor(() => document.querySelectorAll(".gs-item").length === 2);
    expect(document.querySelector(".gs-status").hidden).toBe(true);
  });

  it("网络错误有专属文案；查询词 < 2 字符不发请求、行内提示", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("boom"); });
    const api = initGlobalSearch({}, { fetchFn, now: () => NOW });
    const input = document.getElementById("run-search");
    input.value = "kicad";
    pressEnter(input);
    const alert = await waitFor(() => {
      const el = document.querySelector('.gs-status[role="alert"]');
      return el && !el.hidden ? el : null;
    });
    expect(alert.textContent).toContain(SEARCH_COPY.networkError);

    // 太短：前端先拦，零网络往返
    fetchFn.mockClear();
    input.value = "文";
    pressEnter(input);
    await waitFor(() => {
      const el = document.querySelector('.gs-status[role="alert"]');
      return el && !el.hidden && el.textContent.includes("至少 2 个字符") ? el : null;
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(api.isOpen()).toBe(true);
  });

  it("Esc 与遮罩点击关闭面板", async () => {
    const fetchFn = vi.fn(async () => mockResponse(200, SEARCH_PAYLOAD));
    const api = initGlobalSearch({}, { fetchFn, now: () => NOW });
    document.getElementById("run-search").value = "kicad";
    pressEnter(document.getElementById("run-search"));
    await waitFor(() => document.querySelectorAll(".gs-item"));
    expect(api.isOpen()).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(api.isOpen()).toBe(false);

    api.open();
    expect(api.isOpen()).toBe(true);
    api.element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(api.isOpen()).toBe(false);
  });

  it("focusInput 聚焦并选中侧栏搜索框（命令面板入口语义）", () => {
    const onAnnounce = vi.fn();
    const api = initGlobalSearch({ onAnnounce }, { fetchFn: vi.fn(), now: () => NOW });
    const input = document.getElementById("run-search");
    input.value = "kicad";
    api.focusInput();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(5);
    expect(onAnnounce).toHaveBeenCalled();
  });

  it("结果数量经 onAnnounce 播报（aria-live 桥）", async () => {
    const onAnnounce = vi.fn();
    const fetchFn = vi.fn(async () => mockResponse(200, SEARCH_PAYLOAD));
    initGlobalSearch({ onAnnounce }, { fetchFn, now: () => NOW });
    document.getElementById("run-search").value = "kicad";
    pressEnter(document.getElementById("run-search"));
    await waitFor(() => document.querySelectorAll(".gs-item"));
    expect(onAnnounce).toHaveBeenCalledWith("全局搜索完成，命中 2 条对话");
  });

  it("幂等：重复初始化返回既有节点薄壳，不重复挂 DOM", () => {
    const first = initGlobalSearch({}, { fetchFn: vi.fn(), now: () => NOW });
    const second = initGlobalSearch({}, { fetchFn: vi.fn(), now: () => NOW });
    expect(document.querySelectorAll("#global-search-panel")).toHaveLength(1);
    expect(document.querySelectorAll("#global-search-trigger")).toHaveLength(1);
    second.open();
    expect(first.element.hidden).toBe(false);
  });
});

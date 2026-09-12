// @vitest-environment jsdom
// @ts-nocheck
/**
 * 产物画布（features/artifact-canvas.js）的回归锁——T10。
 *
 * 分层覆盖：
 *   纯函数层：类型分派（扩展名→渲染器）/ CSV 解析（引号、转义、TSV、截断）/
 *             路由编解码（往返、拒绝非画布 hash）/ 序号循环 / 字节格式化
 *   DOM 层  ：jsdom 里真实初始化，验证画布开关、按类型渲染（iframe 沙箱 /
 *             图片 / Markdown / 代码 / 文本 / CSV 表 / 二进制降级卡）、
 *             顶条 chrome（名称/徽章/大小/标签页）、Esc、取件失败错误卡
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  CSV_MAX_ROWS,
  artifactRendererKind,
  rendererKindLabel,
  artifactCodeLang,
  parseCsv,
  encodeArtifactHash,
  artifactExitHash,
  parseArtifactRoute,
  isArtifactRoute,
  wrapIndex,
  indexAfterCloseTab,
  formatBytes,
  artifactBasename,
  siteArtifactUrl,
  pathsMatch,
  parseDesignPalette,
  officeExportPaths,
  pptxPathForHtml,
  pngPathsForHtml,
  initArtifactCanvas,
  parseBrowserUrl,
  isBrowserPreviewPath,
  browserTabLabel,
  previewTabLabel,
  previewAddressValue,
} from "../ui/public/features/artifact-canvas.js";
import { DECK_READY_MESSAGE_TYPE, DECK_GOTO_MESSAGE_TYPE } from "../ui/public/features/review-mode.js";
import { deriveWrittenPaths } from "../ui/public/app.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
/** 收起退出动画播完（DOCK_CLOSE_ANIM_MS=140 + 余量） */
const settle = () => new Promise((r) => setTimeout(r, 220));

// ---------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------

describe("类型分派 artifactRendererKind", () => {
  it.each([
    ["out/site/index.html", "html"],
    ["out/page.HTM", "html"],
    ["out/plot.png", "image"],
    ["out/icon.svg", "image"],
    ["out/photo.jpeg", "image"],
    ["docs/报告.md", "markdown"],
    ["docs/notes.mdx", "markdown"],
    ["out/data.csv", "csv"],
    ["out/data.tsv", "csv"],
    ["src/util.js", "code"],
    ["src/app.ts", "code"],
    ["src/main.py", "code"],
    ["src/style.css", "code"],
    ["src/config.json", "code"],
    ["out/日志.txt", "text"],
    ["out/run.log", "text"],
    ["out/model.bin", "binary"],
    ["out/archive.zip", "binary"],
    ["out/report.xlsx", "binary"],
    ["out/deck.pptx", "binary"],
    ["out/deck.pdf", "binary"],
    ["out/noext", "binary"],
  ])("%s → %s", (path, kind) => {
    expect(artifactRendererKind(path)).toBe(kind);
  });

  it("查询串与反斜杠不影响判定", () => {
    expect(artifactRendererKind("C:\\work\\out\\index.html?x=1")).toBe("html");
  });

  it("每种渲染器都有中文徽章", () => {
    for (const kind of ["html", "browser", "image", "markdown", "csv", "code", "text", "binary"]) {
      expect(rendererKindLabel(kind)).toBeTruthy();
    }
    expect(rendererKindLabel("csv")).toBe("表格");
    expect(rendererKindLabel("browser")).toBe("网页");
  });

  it("http(s) 网址走内置浏览器，不按扩展名当分文件", () => {
    expect(isBrowserPreviewPath("https://example.com/page.html")).toBe(true);
    expect(artifactRendererKind("https://example.com/page.html")).toBe("browser");
    expect(artifactRendererKind("http://127.0.0.1:4173")).toBe("browser");
    expect(parseBrowserUrl("example.com/a")).toBe("https://example.com/a");
    expect(parseBrowserUrl("https://example.com")).toBe("https://example.com/");
    expect(parseBrowserUrl("javascript:alert(1)")).toBeNull();
    expect(parseBrowserUrl("data:text/html,x")).toBeNull();
    expect(browserTabLabel("https://www.example.com/path")).toBe("example.com");
    expect(previewTabLabel("https://www.example.com/docs")).toBe("example.com");
    expect(previewTabLabel("docs/10-design-mode-evolution.md")).toBe("docs/10-design-mode-evolution.md");
    expect(previewAddressValue("https://example.com/a")).toBe("example.com");
    expect(previewAddressValue("src/pack-files.ts")).toBe("src/pack-files.ts");
  });
});

describe("artifactCodeLang", () => {
  it("代码扩展名给出高亮语言，非代码为空", () => {
    expect(artifactCodeLang("a/b.ts")).toBe("ts");
    expect(artifactCodeLang("a/b.py")).toBe("py");
    expect(artifactCodeLang("a/b.md")).toBe("");
    expect(artifactCodeLang("a/b")).toBe("");
  });
});

describe("parseCsv", () => {
  it("普通行与表头", () => {
    const { rows, truncated, totalRows } = parseCsv("name,age\n小明,30\n小红,28");
    expect(rows).toEqual([["name", "age"], ["小明", "30"], ["小红", "28"]]);
    expect(truncated).toBe(false);
    expect(totalRows).toBe(3);
  });

  it("引号字段内的逗号与双引号转义", () => {
    const { rows } = parseCsv('say,by\n"你好, 世界","他""说""的"');
    expect(rows).toEqual([["say", "by"], ["你好, 世界", '他"说"的']]);
  });

  it("CRLF 与结尾换行不产出空行", () => {
    const { rows } = parseCsv("a,b\r\n1,2\r\n");
    expect(rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("首行有 Tab 无逗号时按 TSV 解析", () => {
    const { rows } = parseCsv("name\tage\n小明\t30");
    expect(rows).toEqual([["name", "age"], ["小明", "30"]]);
  });

  it("超过上限截断并如实标注总数", () => {
    const lines = ["h1,h2"];
    for (let i = 0; i < CSV_MAX_ROWS + 10; i += 1) lines.push(`a${i},b${i}`);
    const { rows, truncated, totalRows } = parseCsv(lines.join("\n"));
    expect(rows.length).toBe(CSV_MAX_ROWS);
    expect(truncated).toBe(true);
    expect(totalRows).toBe(CSV_MAX_ROWS + 10 + 1);
  });

  it("空输入产出空表", () => {
    expect(parseCsv("").rows).toEqual([]);
  });
});

describe("路由编解码", () => {
  it("往返一致", () => {
    const hash = encodeArtifactHash("run-123", 4);
    expect(hash).toBe("#/run/run-123/artifact/4");
    expect(parseArtifactRoute(hash)).toEqual({ runId: "run-123", index: 4, full: false });
  });

  it("放大态深链：?full 往返，刷新保持形态", () => {
    const hash = encodeArtifactHash("run-123", 4, { full: true });
    expect(hash).toBe("#/run/run-123/artifact/4?full");
    expect(parseArtifactRoute(hash)).toEqual({ runId: "run-123", index: 4, full: true });
    // 停靠态深链不带 full；&full 形式同样认得
    expect(parseArtifactRoute("#/run/run-123/artifact/4")?.full).toBe(false);
    expect(parseArtifactRoute("#/run/run-123/artifact/4?x=1&full")?.full).toBe(true);
  });

  it("runId 含特殊字符时先编码再解码", () => {
    const hash = encodeArtifactHash("a b/c", 0);
    expect(hash).not.toContain("a b/c");
    expect(parseArtifactRoute(hash)).toEqual({ runId: "a b/c", index: 0, full: false });
  });

  it("拒绝非画布 hash", () => {
    expect(parseArtifactRoute("#/")).toBeNull();
    expect(parseArtifactRoute("#/settings")).toBeNull();
    expect(parseArtifactRoute("#/run/abc/loop")).toBeNull();
    expect(parseArtifactRoute("#/run/abc/artifact/x")).toBeNull();
    expect(isArtifactRoute("#/run/abc/artifact/0")).toBe(true);
    expect(isArtifactRoute("#/run/abc")).toBe(false);
  });

  it("关闭落点是会话页，不是上一份预览", () => {
    expect(artifactExitHash("run-123", "loop")).toBe("#/run/run-123/loop");
    expect(artifactExitHash(null)).toBe("#/");
    expect(isArtifactRoute(artifactExitHash("run-123", "loop"))).toBe(false);
  });
});

describe("wrapIndex / formatBytes / artifactBasename", () => {
  it("序号循环与空清单", () => {
    expect(wrapIndex(0, 3)).toBe(0);
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(-1, 3)).toBe(2);
    expect(wrapIndex(5, 0)).toBe(-1);
  });

  it("关掉标签后落点：关当前取下一只，关左边序号减一，关完回 -1", () => {
    expect(indexAfterCloseTab(1, 1, 2)).toBe(1);
    expect(indexAfterCloseTab(2, 2, 2)).toBe(1);
    expect(indexAfterCloseTab(1, 0, 2)).toBe(0);
    expect(indexAfterCloseTab(0, 2, 2)).toBe(0);
    expect(indexAfterCloseTab(0, 0, 0)).toBe(-1);
  });

  it("字节格式化", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatBytes(null)).toBe("—");
  });

  it("basename 兼容反斜杠", () => {
    expect(artifactBasename("C:\\work\\out\\报告.md")).toBe("报告.md");
    expect(artifactBasename("out/a.csv")).toBe("a.csv");
  });

  it("整站 URL 按段编码，相对资源才能解析到同目录", () => {
    expect(siteArtifactUrl("run-1", "out/index.html")).toBe("/api/runs/run-1/site/out/index.html");
    expect(siteArtifactUrl("run-1", "demos\\liquid\\index.html")).toBe(
      "/api/runs/run-1/site/demos/liquid/index.html",
    );
    expect(siteArtifactUrl("a/b", "x y/z.html")).toBe(
      "/api/runs/a%2Fb/site/x%20y/z.html",
    );
  });
});

describe("officeExportPaths", () => {
  it("只收 .pptx / .pdf，有文件才可下载，不解析 OOXML", () => {
    expect(officeExportPaths([
      { path: "out/index.html" },
      { path: "out/deck.pptx" },
      { path: "out/deck.pdf" },
      { path: "out/notes.docx" },
      { path: "out/deck.PPTX" },
      "slides/pack.pdf?x=1",
      "C:\\work\\brief.pptx",
    ])).toEqual([
      "out/deck.pptx",
      "out/deck.pdf",
      "slides/pack.pdf?x=1",
      "C:/work/brief.pptx",
    ]);
    expect(officeExportPaths([{ path: "out/index.html" }])).toEqual([]);
    expect(officeExportPaths(null)).toEqual([]);
  });

  it("pptxPathForHtml 与 HTML 同茎", () => {
    expect(pptxPathForHtml("out/index.html")).toBe("out/index.pptx");
    expect(pptxPathForHtml("deck.htm")).toBe("deck.pptx");
    expect(pngPathsForHtml("out/index.html", 1)).toEqual(["out/index.png"]);
    expect(pngPathsForHtml("out/index.html", 2)).toEqual(["out/index-1.png", "out/index-2.png"]);
  });
});

// ---------------------------------------------------------------
// DOM 层
// ---------------------------------------------------------------

const ARTIFACTS = [
  { path: "out/index.html" },
  { path: "out/plot.png" },
  { path: "docs/报告.md" },
  { path: "src/util.js" },
  { path: "out/data.csv" },
  { path: "out/model.bin" },
];

const textRes = (text) => ({ ok: true, text: async () => text });

function setupHost(overrides = {}) {
  const host = {
    getRunId: () => "run-1",
    getArtifacts: () => ARTIFACTS,
    onClose: vi.fn(),
    onSwitch: vi.fn(),
    onExpandChange: vi.fn(),
    onReveal: vi.fn(),
    onAnnounce: vi.fn(),
    ...overrides,
  };
  return host;
}

describe("initArtifactCanvas — 打开与 chrome", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("HTML 产物：整站预览，iframe 沙箱不允许 same-origin，且不发 fetch", async () => {
    const fakeFetch = vi.fn(async () => ({ ok: true, json: async () => ({ found: false }) }));
    const api = initArtifactCanvas(setupHost(), { fetch: fakeFetch });
    expect(api.open(0)).toBe(true);
    expect(api.isOpen()).toBe(true);
    await flush();
    const frame = document.querySelector("iframe.ac-frame");
    expect(frame).toBeTruthy();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("src")).toBe("/api/runs/run-1/site/out/index.html?deck=1");
    expect(document.querySelector(".ac-note")?.textContent).toContain("整站预览");
    expect(document.querySelector("#ac-site")).toBeNull();
    expect(document.querySelector("#ac-export")?.hidden).toBe(false);
    expect(document.querySelector(".ac-actions > .ac-download")).toBeNull();
    expect(document.querySelector("#ac-zip")).toBeNull();
    expect(document.querySelector("#ac-print")).toBeNull();
    expect(document.querySelector("#ac-export-hint")).toBeNull();
    expect(document.querySelector("#ac-template")).toBeNull();
    // 整站预览不 fetch 产物本体，也不再拉 DESIGN.md 色板
    expect(fakeFetch).not.toHaveBeenCalled();
    // chrome：名称 + 徽章 + 位置
    expect(document.querySelector(".ac-name")?.textContent).toBe("out/index.html");
    expect(document.querySelector(".ac-badge")?.textContent).toBe("网站");
    const tabs = [...document.querySelectorAll(".ac-tab")];
    expect(tabs).toHaveLength(6);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].textContent).toBe("out/index.html");
    expect(document.getElementById("ac-browser-url")?.value).toBe("out/index.html");
    expect(document.querySelector(".ac-title")?.classList.contains("sr-only")).toBe(true);
    expect(document.querySelector(".ac-browser-bar")?.contains(document.querySelector(".ac-actions"))).toBe(true);
    expect(document.querySelector("#ac-inspect")?.hidden).toBe(false);
    expect(document.querySelector("#ac-annotate")?.hidden).toBe(true);
  });

  it("内置浏览器：地址栏提交后按 http(s) 嵌网页，沙箱含 same-origin", async () => {
    const onOpenBrowser = vi.fn();
    const api = initArtifactCanvas(
      setupHost({
        getArtifacts: () => [{ path: "https://example.com/" }],
        onOpenBrowser,
      }),
      { fetch: vi.fn() },
    );
    expect(api.open(0)).toBe(true);
    await flush();
    const frame = document.querySelector("iframe.ac-frame--web");
    expect(frame).toBeTruthy();
    expect(frame.getAttribute("src")).toBe("https://example.com/");
    expect(frame.getAttribute("sandbox")).toContain("allow-same-origin");
    expect(document.querySelector(".ac-badge")?.textContent).toBe("网页");
    expect(document.querySelector(".ac-tab")?.textContent).toBe("example.com");
    expect(document.querySelector(".ac-reveal")?.hidden).toBe(true);
    const bar = document.getElementById("ac-browser-bar");
    expect(bar).toBeTruthy();
    const input = document.getElementById("ac-browser-url");
    expect(input.value).toBe("example.com");
    input.value = "example.org";
    bar.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onOpenBrowser).toHaveBeenCalledWith("https://example.org/");
    expect(api.focusAddress()).toBe(true);
  });

  it("点评模式仍走整站 URL，只加 inspect=1，不 fetch、不用 srcdoc", async () => {
    const fakeFetch = vi.fn(async (url) => {
      if (String(url).includes("design-md")) {
        return { ok: true, json: async () => ({ found: false }) };
      }
      return { ok: false };
    });
    const api = initArtifactCanvas(setupHost(), { fetch: fakeFetch });
    api.open(0);
    await flush();
    fakeFetch.mockClear();
    document.querySelector("#ac-inspect").click();
    await flush();
    // inspect 重渲仍不 fetch 产物，也不拉 DESIGN.md
    expect(fakeFetch).not.toHaveBeenCalled();
    const frame = document.querySelector("iframe.ac-frame");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("src")).toBe("/api/runs/run-1/site/out/index.html?deck=1&inspect=1");
    expect(frame.getAttribute("srcdoc")).toBeNull();
    expect(document.querySelector(".ac-note")?.textContent).toContain("点评模式");
  });

  it("幻灯报到后显示翻页条；裸方向键只翻页，不再切文件", async () => {
    const host = setupHost();
    const api = initArtifactCanvas(host, { fetch: vi.fn() });
    api.open(0);
    const frame = document.querySelector("iframe.ac-frame");
    const cw = {};
    Object.defineProperty(frame, "contentWindow", { value: cw, configurable: true });
    const posts = [];
    cw.postMessage = (msg) => posts.push(msg);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: DECK_READY_MESSAGE_TYPE,
          total: 3,
          index: 0,
          slide: "1",
          slides: ["1", "2", "3"],
        },
        source: cw,
      }),
    );
    await flush();
    expect(document.querySelector("#ac-deck-bar")?.hidden).toBe(false);
    expect(document.querySelector(".ac-badge")?.textContent).toBe("幻灯");
    expect(document.querySelector(".ac-deck-pos")?.textContent).toContain("1 / 3");
    expect(document.querySelectorAll(".ac-deck-page").length).toBe(3);
    host.onSwitch.mockClear();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(posts.some((p) => p?.type === DECK_GOTO_MESSAGE_TYPE && p.delta === 1)).toBe(true);
    expect(host.onSwitch).not.toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true }));
    expect(host.onSwitch).not.toHaveBeenCalled();
    posts.length = 0;
    document.querySelectorAll(".ac-deck-page")[2].click();
    expect(posts.some((p) => p?.type === DECK_GOTO_MESSAGE_TYPE && p.index === 2)).toBe(true);
  });

  it("点评列表可全部写入输入框，也可清空", async () => {
    const onAppendReview = vi.fn();
    const api = initArtifactCanvas(setupHost({ onAppendReview }), { fetch: vi.fn() });
    api.open(0);
    document.querySelector("#ac-inspect").click();
    await flush();
    const frame = document.querySelector("iframe.ac-frame");
    const cw = {};
    Object.defineProperty(frame, "contentWindow", { value: cw, configurable: true });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "agent-inspect-pick", selector: "h1.hero", text: "标题", slide: "2" },
        source: cw,
      }),
    );
    await flush();
    const comment = document.querySelector("#ac-review-comment");
    expect(comment).toBeTruthy();
    comment.value = "对比度不够";
    document.querySelector("#ac-review-pop button[type='submit']").click();
    await flush();
    expect(onAppendReview).toHaveBeenCalled();
    expect(onAppendReview.mock.calls[0][0]).toContain("[点评][slide:2]");
    expect(document.querySelector("#ac-review-list")?.hidden).toBe(false);
    onAppendReview.mockClear();
    document.querySelector("#ac-review-flush").click();
    expect(onAppendReview).toHaveBeenCalledWith(expect.stringContaining("[点评][slide:2]"));
    document.querySelector("#ac-review-clear").click();
    expect(document.querySelector("#ac-review-list")?.hidden).toBe(true);
  });

  it("parseDesignPalette 抽出色块；画布不再展示 DESIGN.md 色板；导出菜单收 ZIP，幻灯才出打印", async () => {
    expect(
      parseDesignPalette("## 色板\n- accent: #3b82f6\n## 字体\n- body: system").colors[0],
    ).toEqual({
      name: "accent",
      value: "#3b82f6",
    });
    const fakeFetch = vi.fn(async (url) => {
      if (String(url).includes("/design-md")) {
        return {
          ok: true,
          json: async () => ({
            found: true,
            path: "DESIGN.md",
            text: "## 色板\n- accent: #3b82f6\n",
            palette: { colors: [{ name: "accent", value: "#3b82f6" }], fonts: [] },
          }),
        };
      }
      return { ok: false };
    });
    const api = initArtifactCanvas(setupHost(), { fetch: fakeFetch });
    api.open(0);
    await flush();
    expect(document.querySelector("#ac-design-panel")?.hidden).toBe(true);
    expect(document.querySelector(".ac-color-chip")).toBeNull();
    expect(fakeFetch).not.toHaveBeenCalled();
    document.querySelector("#ac-export").click();
    await flush();
    expect(document.querySelector("#ac-export-menu")).toBeTruthy();
    expect((document.querySelector("#ac-download") as HTMLAnchorElement).href).toContain("download=1");
    expect((document.querySelector("#ac-zip") as HTMLAnchorElement).href).toContain("site-zip");
    expect(document.querySelector("#ac-print")).toBeNull();
    expect(document.querySelector(".ac-office-download")).toBeNull();
    expect(document.querySelector("#ac-export-note")?.textContent).toContain("[data-card]");
    expect(document.querySelector("#ac-export-png")?.textContent).toContain("导出图片");
    expect(document.querySelector("#ac-export-menu")?.textContent).not.toContain("宿主不做 Office 引擎");
    expect(document.querySelector("#ac-export-menu")?.textContent).not.toContain("后导出");
    expect(document.querySelector("#ac-export-pptx")).toBeNull();
    const frame = document.querySelector("iframe.ac-frame");
    const cw = {};
    Object.defineProperty(frame, "contentWindow", { value: cw, configurable: true });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: DECK_READY_MESSAGE_TYPE, total: 3, index: 0, slide: "1", slides: ["1", "2", "3"] },
        source: cw,
      }),
    );
    await flush();
    document.querySelector("#ac-export").click();
    await flush();
    expect((document.querySelector("#ac-print") as HTMLAnchorElement).href).toContain("print=1");
    expect(document.querySelector("#ac-export-pptx")?.textContent).toContain("导出 PowerPoint");
    expect(document.querySelector("#ac-export-note")?.textContent).toContain("从幻灯 HTML 转换");
  });

  it("已有同茎 pptx 时导出仍走宿主转换，不静默下载旧文件", async () => {
    const fakeFetch = vi.fn(async (url, init) => {
      if (String(url).includes("/export/pptx") && init?.method === "POST") {
        expect(JSON.parse(init.body)).toEqual({ htmlPath: "out/index.html" });
        return { ok: true, json: async () => ({ path: "out/index.pptx", slides: 3, titles: ["一", "二", "三"], lossy: ["渐变字改为强调色纯色"] }) };
      }
      return { ok: false };
    });
    const host = setupHost({
      getArtifacts: () => [{ path: "out/index.html" }, { path: "out/index.pptx" }],
    });
    const api = initArtifactCanvas(host, { fetch: fakeFetch });
    api.open(0);
    await flush();
    const frame = document.querySelector("iframe.ac-frame");
    const cw = {};
    Object.defineProperty(frame, "contentWindow", { value: cw, configurable: true });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: DECK_READY_MESSAGE_TYPE, total: 3, index: 0, slide: "1", slides: ["1", "2", "3"] },
        source: cw,
      }),
    );
    await flush();
    document.querySelector("#ac-export").click();
    await flush();
    const btn = document.querySelector("#ac-export-pptx") as HTMLButtonElement;
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.getAttribute("href")).toBeNull();
    btn.click();
    await flush();
    expect(fakeFetch).toHaveBeenCalledWith(
      "/api/runs/run-1/export/pptx",
      expect.objectContaining({ method: "POST" }),
    );
    expect(document.querySelector("#ac-export-status")?.textContent).toContain("已导出");
    expect(document.querySelector("#ac-export-status")?.textContent).toContain("有损");
    expect(host.onAnnounce).toHaveBeenCalledWith(expect.stringContaining("已导出"));
  });

  it("导出失败写可见状态，不假装成功", async () => {
    const fakeFetch = vi.fn(async (url, init) => {
      if (String(url).includes("/export/pptx") && init?.method === "POST") {
        return { ok: false, json: async () => ({ error: "HTML 没有 section.slide[data-slide]，拒绝转换", code: "NO_SLIDES" }) };
      }
      return { ok: false };
    });
    const host = setupHost();
    const api = initArtifactCanvas(host, { fetch: fakeFetch });
    api.open(0);
    await flush();
    const frame = document.querySelector("iframe.ac-frame");
    const cw = {};
    Object.defineProperty(frame, "contentWindow", { value: cw, configurable: true });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: DECK_READY_MESSAGE_TYPE, total: 3, index: 0, slide: "1", slides: ["1", "2", "3"] },
        source: cw,
      }),
    );
    await flush();
    document.querySelector("#ac-export").click();
    await flush();
    (document.querySelector("#ac-export-pptx") as HTMLButtonElement).click();
    await flush();
    const status = document.querySelector("#ac-export-status") as HTMLElement;
    expect(status.hidden).toBe(false);
    expect(status.getAttribute("role")).toBe("alert");
    expect(status.textContent).toContain("没有 section.slide");
    expect(status.dataset.kind).toBe("error");
    expect(host.onAnnounce).toHaveBeenCalledWith(expect.stringContaining("没有 section.slide"));
  });

  it("点选某一页才进入改稿范围；仅报到不误伤", async () => {
    const api = initArtifactCanvas(setupHost(), { fetch: vi.fn() });
    api.open(0);
    await flush();
    expect(api.getEditScope()).toBeNull();
    const frame = document.querySelector("iframe.ac-frame");
    const cw = {};
    Object.defineProperty(frame, "contentWindow", { value: cw, configurable: true });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: DECK_READY_MESSAGE_TYPE, total: 3, index: 0, slide: "1", slides: ["1", "2", "3"] },
        source: cw,
      }),
    );
    await flush();
    expect(api.getEditScope()).toBeNull();
    (document.querySelectorAll(".ac-deck-page")[2] as HTMLButtonElement).click();
    expect(api.getEditScope()).toEqual({ slide: "3", path: "out/index.html" });
  });

  it("改稿写回后仍钉住被选页，并 goto 那一页", async () => {
    const posts = [];
    const cw = { postMessage: (msg) => posts.push(msg) };
    const api = initArtifactCanvas(setupHost(), { fetch: vi.fn(), refreshDebounceMs: 5 });
    api.open(0);
    await flush();
    const frame = document.querySelector("iframe.ac-frame");
    Object.defineProperty(frame, "contentWindow", { value: cw, configurable: true });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: DECK_READY_MESSAGE_TYPE, total: 3, index: 0, slide: "1", slides: ["1", "2", "3"] },
        source: cw,
      }),
    );
    await flush();
    (document.querySelectorAll(".ac-deck-page")[2] as HTMLButtonElement).click();
    expect(api.getEditScope()?.slide).toBe("3");
    const prev = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
    Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
      configurable: true,
      get() { return cw; },
    });
    try {
      api.noteWrites(["out/index.html"]);
      await new Promise((r) => setTimeout(r, 20));
      expect(api.getEditScope()).toEqual({ slide: "3", path: "out/index.html" });
      expect(posts.some((p) => p?.type === DECK_GOTO_MESSAGE_TYPE && p.slide === "3")).toBe(true);
    } finally {
      if (prev) Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", prev);
      else delete HTMLIFrameElement.prototype.contentWindow;
    }
  });

  it("多页幻灯即使产物清单没有 pptx 也提供导出 PowerPoint，点击先转换", async () => {
    const fakeFetch = vi.fn(async (url, init) => {
      if (String(url).includes("/export/pptx") && init?.method === "POST") {
        expect(JSON.parse(init.body)).toEqual({ htmlPath: "out/index.html" });
        return { ok: true, json: async () => ({ path: "out/index.pptx", slides: 3, lossy: [] }) };
      }
      return { ok: false };
    });
    const api = initArtifactCanvas(setupHost(), { fetch: fakeFetch });
    api.open(0);
    await flush();
    const frame = document.querySelector("iframe.ac-frame");
    const cw = {};
    Object.defineProperty(frame, "contentWindow", { value: cw, configurable: true });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: DECK_READY_MESSAGE_TYPE, total: 3, index: 0, slide: "1", slides: ["1", "2", "3"] },
        source: cw,
      }),
    );
    await flush();
    document.querySelector("#ac-export").click();
    await flush();
    const btn = document.querySelector("#ac-export-pptx") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.tagName).toBe("BUTTON");
    expect(document.querySelector(".ac-office-download")).toBeNull();
    btn.click();
    await flush();
    expect(fakeFetch).toHaveBeenCalledWith(
      "/api/runs/run-1/export/pptx",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("HTML 始终提供导出图片，点击打 /export/png", async () => {
    const fakeFetch = vi.fn(async (url, init) => {
      if (String(url).includes("/export/png") && init?.method === "POST") {
        expect(JSON.parse(init.body)).toEqual({ htmlPath: "out/index.html" });
        return { ok: true, json: async () => ({ paths: ["out/index-1.png", "out/index-2.png"], count: 2 }) };
      }
      return { ok: false };
    });
    const api = initArtifactCanvas(setupHost(), { fetch: fakeFetch });
    api.open(0);
    await flush();
    document.querySelector("#ac-export").click();
    await flush();
    const btn = document.querySelector("#ac-export-png") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    await flush();
    expect(fakeFetch).toHaveBeenCalledWith(
      "/api/runs/run-1/export/png",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("workdir 已有 .pptx/.pdf 时导出菜单提供下载；清单只列已存在文件", async () => {
    const api = initArtifactCanvas(
      setupHost({
        getArtifacts: () => [
          { path: "out/index.html" },
          { path: "out/deck.pptx" },
          { path: "out/brief.pdf" },
        ],
      }),
      { fetch: vi.fn() },
    );
    api.open(0);
    await flush();
    document.querySelector("#ac-export").click();
    await flush();
    const links = [...document.querySelectorAll(".ac-office-download")];
    expect(links.map((a) => a.getAttribute("download"))).toEqual(["deck.pptx", "brief.pdf"]);
    expect(links.every((a) => a.getAttribute("href")?.includes("download=1"))).toBe(true);
    expect(links[0].getAttribute("href")).toContain(encodeURIComponent("out/deck.pptx"));
    expect(links[1].getAttribute("href")).toContain(encodeURIComponent("out/brief.pdf"));
    expect(document.querySelector("#ac-export-note")?.textContent).toContain("[data-card]");
    expect(document.querySelector("#ac-export-png")?.textContent).toContain("导出图片");
    expect(document.querySelector("#ac-export-menu")?.textContent).not.toContain("宿主不做 Office 引擎");
  });

  it("图片产物：标注钮可见；打开后叠画布，不发 fetch", async () => {
    const fakeFetch = vi.fn();
    const api = initArtifactCanvas(setupHost(), { fetch: fakeFetch });
    api.open(1);
    const btn = document.querySelector("#ac-annotate");
    expect(btn?.hidden).toBe(false);
    expect(document.querySelector("#ac-inspect")?.hidden).toBe(true);
    btn.click();
    await flush();
    expect(document.querySelector("canvas.ac-annotate-canvas")).toBeTruthy();
    expect(document.querySelector("#ac-annotate-bar")).toBeTruthy();
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("图片产物：img 直显", () => {
    const api = initArtifactCanvas(setupHost(), { fetch: vi.fn() });
    api.open(1);
    const img = document.querySelector("img.ac-image");
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toContain("plot.png");
    expect(document.querySelector(".ac-badge")?.textContent).toBe("图片");
  });

  it("Markdown 产物：经 markdown.js 渲染，产物里的 HTML 是死文本", async () => {
    const fakeFetch = vi.fn(async () => textRes('# 标题\n\n<script>alert(1)</script>**粗体**'));
    const api = initArtifactCanvas(setupHost(), { fetch: fakeFetch });
    api.open(2);
    await flush();
    const doc = document.querySelector(".ac-doc");
    expect(doc).toBeTruthy();
    expect(doc.innerHTML).toContain("md-h");
    expect(doc.querySelector("strong")?.textContent).toBe("粗体");
    // 先转义纪律：产物里的 script 绝不能变成活标签
    expect(doc.querySelector("script")).toBeNull();
    expect(doc.innerHTML).toContain("&lt;script&gt;");
    // 大小由读入内容回填
    expect(document.querySelector(".ac-size")?.textContent).not.toBe("—");
  });

  it("代码产物：转义后高亮，标签不活化", async () => {
    const fakeFetch = vi.fn(async () => textRes('const x = "<b>";\n// 注释'));
    const api = initArtifactCanvas(setupHost(), { fetch: fakeFetch });
    api.open(3);
    await flush();
    const code = document.querySelector("pre.md-code code");
    expect(code).toBeTruthy();
    expect(code.querySelector("b")).toBeNull();
    expect(code.innerHTML).toContain("&lt;b&gt;");
    expect(code.innerHTML).toContain("hl-"); // 高亮 span 类前缀
  });

  it("CSV 产物：渲染成表格", async () => {
    const fakeFetch = vi.fn(async () => textRes("name,age\n小明,30\n小红,28"));
    const api = initArtifactCanvas(setupHost(), { fetch: fakeFetch });
    api.open(4);
    await flush();
    const table = document.querySelector("table.ac-table");
    expect(table).toBeTruthy();
    expect(table.querySelectorAll("thead th").length).toBe(2);
    expect(table.querySelectorAll("tbody tr").length).toBe(2);
    expect(table.textContent).toContain("小明");
  });

  it("二进制产物：降级信息卡（类型+大小+下载）", async () => {
    const fakeFetch = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(2048) }));
    const api = initArtifactCanvas(setupHost(), { fetch: fakeFetch });
    api.open(5);
    await flush();
    const card = document.querySelector(".ac-fallback");
    expect(card).toBeTruthy();
    expect(card.textContent).toContain("暂不支持预览");
    expect(card.textContent).toContain("2.0 KB");
    expect(card.querySelector("a")?.getAttribute("href")).toContain("download=1");
    expect(document.querySelector(".ac-size")?.textContent).toBe("2.0 KB");
  });

  it("取件失败：错误卡而不是白屏", async () => {
    const fakeFetch = vi.fn(async () => ({ ok: false }));
    const api = initArtifactCanvas(setupHost(), { fetch: fakeFetch });
    api.open(2);
    await flush();
    expect(document.querySelector(".ac-fallback")?.textContent).toContain("读取失败");
  });

  it("无产物时 open 返回 false 且视图保持隐藏", () => {
    const api = initArtifactCanvas(setupHost({ getArtifacts: () => [] }), { fetch: vi.fn() });
    expect(api.open(0)).toBe(false);
    expect(api.isOpen()).toBe(false);
    expect(document.getElementById("artifact-canvas-view").hidden).toBe(true);
  });

  it("序号越界钳制到清单范围内", () => {
    const api = initArtifactCanvas(setupHost(), { fetch: vi.fn() });
    api.open(99);
    expect(api.currentIndex()).toBe(3); // 99 % 6
  });
});

describe("initArtifactCanvas — 切换、关闭与键盘", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("点标签上报宿主切换，选中态跟着变", async () => {
    const host = setupHost();
    const api = initArtifactCanvas(host, { fetch: vi.fn(async () => textRes("x")) });
    api.open(0);
    document.querySelectorAll(".ac-tab")[1].click();
    expect(host.onSwitch).toHaveBeenCalledWith(1);
    api.open(1);
    await flush();
    const tabs = [...document.querySelectorAll(".ac-tab")];
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].getAttribute("aria-selected")).toBe("false");
    tabs[0].click();
    expect(host.onSwitch).toHaveBeenCalledWith(0);
  });

  it("悬停关闭钮上报 onCloseTab，不切到那只标签", () => {
    const host = setupHost({ onCloseTab: vi.fn() });
    const api = initArtifactCanvas(host, { fetch: vi.fn() });
    api.open(1);
    const close = document.querySelectorAll(".ac-tab-close")[0];
    expect(close).toBeTruthy();
    expect(close.getAttribute("aria-label")).toContain("关闭");
    close.click();
    expect(host.onCloseTab).toHaveBeenCalledWith(0);
    expect(host.onSwitch).not.toHaveBeenCalled();
  });

  it("单文件也画一只标签，没有左右箭头", () => {
    const api = initArtifactCanvas(
      setupHost({ getArtifacts: () => [{ path: "out/a.png" }] }),
      { fetch: vi.fn() },
    );
    api.open(0);
    expect(document.querySelectorAll(".ac-tab")).toHaveLength(1);
    expect(document.querySelector(".ac-nav")).toBeNull();
  });

  it("Esc 收起；全局方向键不再切文件", async () => {
    const host = setupHost();
    const api = initArtifactCanvas(host, { fetch: vi.fn(async () => textRes("x")), closeAnimMs: 0 });
    api.open(2);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(host.onSwitch).not.toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(host.onClose).not.toHaveBeenCalled();
    expect(api.isOpen()).toBe(true);
    expect(api.isCollapsed()).toBe(true);
    host.onSwitch.mockClear();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(host.onSwitch).not.toHaveBeenCalled();
    api.close();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(host.onSwitch).not.toHaveBeenCalled();
  });

  it("收起键不拆会话；在文件夹中显示仍走宿主回调", () => {
    const host = setupHost();
    const api = initArtifactCanvas(host, { fetch: vi.fn(), closeAnimMs: 0 });
    api.open(1);
    document.querySelector(".ac-reveal").click();
    expect(host.onReveal).toHaveBeenCalledWith("out/plot.png");
    document.querySelector(".ac-close").click();
    expect(host.onClose).not.toHaveBeenCalled();
    expect(api.isCollapsed()).toBe(true);
    expect(api.isOpen()).toBe(true);
  });

  it("close 清空内容并隐藏视图（收起动画播完后）；幂等初始化返回同一实例", async () => {
    const host = setupHost();
    const api = initArtifactCanvas(host, { fetch: vi.fn() });
    api.open(1);
    api.close();
    // 收起先播退出动画再隐藏（jsdom 无 matchMedia → 走动画分支），等它播完
    await settle();
    expect(document.getElementById("artifact-canvas-view").hidden).toBe(true);
    expect(document.querySelector(".ac-body").innerHTML).toBe("");
    const again = initArtifactCanvas(setupHost(), { fetch: vi.fn() });
    expect(again.element).toBe(api.element);
  });
});

// ---------------------------------------------------------------
// T10 升级：停靠面板形态
// ---------------------------------------------------------------

describe("initArtifactCanvas — 停靠面板形态", () => {
  beforeEach(() => {
    document.body.innerHTML =
      `<main id="main-panel"><div id="center-row">` +
      `<div id="main-area" class="content-area"><p>对话主列</p></div>` +
      `</div></main>`;
  });

  it("打开预览时收起 Progress 侧栏，避免对话列被挤扁", () => {
    const row = document.getElementById("center-row");
    const rail = document.createElement("aside");
    rail.id = "detail-rail";
    rail.className = "detail-rail";
    const toggle = document.createElement("button");
    toggle.id = "rail-toggle";
    toggle.textContent = "Progress ⟩";
    toggle.setAttribute("aria-expanded", "true");
    rail.appendChild(toggle);
    row.querySelector(".content-area")?.appendChild(rail);
    const api = initArtifactCanvas(setupHost(), { fetch: vi.fn() });
    api.open(0);
    expect(rail.classList.contains("detail-rail--collapsed")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("默认停靠在 #center-row：对话主列保持可见，不再是盖住一切的覆盖视图", () => {
    const api = initArtifactCanvas(setupHost(), { fetch: vi.fn() });
    api.open(0);
    const view = document.getElementById("artifact-canvas-view");
    expect(view.parentElement.id).toBe("center-row");
    expect(view.classList.contains("preview-dock")).toBe(true);
    expect(view.classList.contains("preview-dock--expanded")).toBe(false);
    const main = document.getElementById("main-area");
    expect(main.hidden).toBe(false); // 对话不被挡住
    expect(view.hidden).toBe(false);
  });

  it("放大按钮：扩到整个主区并上报宿主；再点还原；深链 open(full) 恢复形态", () => {
    const host = setupHost();
    const api = initArtifactCanvas(host, { fetch: vi.fn() });
    api.open(0);
    const btn = document.querySelector("#artifact-canvas-view .pd-expand");
    expect(btn.textContent).toContain("放大");
    btn.click();
    expect(api.isExpanded()).toBe(true);
    expect(document.getElementById("artifact-canvas-view").classList.contains("preview-dock--expanded")).toBe(true);
    expect(host.onExpandChange).toHaveBeenCalledWith(true);
    // 宿主改写 hash 后绕回来 open 同一件：full 省略时保持放大（◀ ▶ 切产物不缩回）
    api.open(1);
    expect(api.isExpanded()).toBe(true);
    // 深链不带 full → 明确回到停靠
    api.open(1, { full: false });
    expect(api.isExpanded()).toBe(false);
    // 深链带 full → 刷新恢复放大态
    api.open(2, { full: true });
    expect(api.isExpanded()).toBe(true);
  });

  it("Esc 两级：放大态先还原，停靠态只收起", () => {
    const host = setupHost();
    const api = initArtifactCanvas(host, { fetch: vi.fn(async () => ({ ok: true, text: async () => "x" })), closeAnimMs: 0 });
    api.open(2, { full: true });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(api.isExpanded()).toBe(false);
    expect(api.isOpen()).toBe(true);
    expect(host.onClose).not.toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(host.onClose).not.toHaveBeenCalled();
    expect(api.isCollapsed()).toBe(true);
  });

  it("窄屏退化：放大被忽略，Esc 一级直接收起", () => {
    const host = setupHost();
    const api = initArtifactCanvas(host, { fetch: vi.fn(), isNarrow: () => true, closeAnimMs: 0 });
    api.open(0, { full: true });
    expect(api.isExpanded()).toBe(false);
    expect(api.element.classList.contains("preview-dock--narrow")).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(host.onClose).not.toHaveBeenCalled();
    expect(api.isCollapsed()).toBe(true);
  });

  it("拖拽左缘调宽，宽度记进注入的存储", () => {
    const row = document.getElementById("center-row");
    row.getBoundingClientRect = () => ({ left: 0, right: 1200, width: 1200, top: 0, bottom: 700, height: 700 });
    const store = new Map();
    const storage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    };
    const api = initArtifactCanvas(setupHost(), { fetch: vi.fn(), storage });
    api.open(0);
    const handle = document.querySelector("#artifact-canvas-view .pd-handle");
    expect(handle).toBeTruthy();
    handle.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 600 }));
    document.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 480 }));
    document.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true, clientX: 480 }));
    // (1200-480)/1200 = 0.6
    expect(api.element.style.width).toBe("60%");
    expect([...store.values()]).toContain("0.6");
  });
});

describe("initArtifactCanvas — 运行中内容自动刷新（agent 在右边操作）", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("pathsMatch：反斜杠与 ./ 归一，大小写不折叠，空串不匹配", () => {
    expect(pathsMatch("out\\index.html", "out/index.html")).toBe(true);
    expect(pathsMatch("./out/index.html", "out/index.html")).toBe(true);
    expect(pathsMatch("out/a.html", "out/b.html")).toBe(false);
    expect(pathsMatch("", "out/a.html")).toBe(false);
  });

  it("当前预览产物被再次写入：防抖后重拉一次（带破缓存参数）", async () => {
    const fakeFetch = vi.fn(async () => textRes("# 第一版"));
    const api = initArtifactCanvas(setupHost(), { fetch: fakeFetch, refreshDebounceMs: 20 });
    api.open(2); // docs/报告.md
    await flush();
    expect(fakeFetch).toHaveBeenCalledTimes(1);

    api.noteWrites(["docs/报告.md"]);
    api.noteWrites(["docs/报告.md"]); // 一阵写入只触发一次
    await new Promise((r) => setTimeout(r, 60));
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(fakeFetch.mock.calls[1][0]).toContain("&v="); // 破缓存
  });

  it("写的是别的产物不刷新；画布关着不刷新", async () => {
    const fakeFetch = vi.fn(async () => textRes("# x"));
    const api = initArtifactCanvas(setupHost(), { fetch: fakeFetch, refreshDebounceMs: 20 });
    api.open(2);
    await flush();
    api.noteWrites(["out/index.html"]);
    await new Promise((r) => setTimeout(r, 60));
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    api.close();
    api.noteWrites(["docs/报告.md"]);
    await new Promise((r) => setTimeout(r, 60));
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });
});

describe("deriveWrittenPaths — 事件流里的写入路径", () => {
  const call = (id, path, name = "write_file") => ({
    event: { type: "tool_call", toolUseId: id, name, input: { path } },
  });
  const okResult = (id) => ({ event: { type: "tool_result", toolUseId: id, result: { isError: false } } });
  const errResult = (id) => ({ event: { type: "tool_result", toolUseId: id, result: { isError: true } } });

  it("tool_call 立即计入（结果未到先刷一次），成功结果也计入", () => {
    expect(deriveWrittenPaths(null, [call("t1", "out/a.html")])).toEqual(["out/a.html"]);
    expect(deriveWrittenPaths(null, [call("t1", "out/a.html"), okResult("t1")])).toEqual(["out/a.html"]);
  });

  it("结果落在后面的批次：从历史 timeline 回填路径；失败不计", () => {
    const state = {
      timeline: [
        { type: "tool_call", toolUseId: "t1", name: "write_file", input: { path: "out/a.html" } },
        { type: "tool_call", toolUseId: "t2", name: "write_file", input: { path: "out/b.html" } },
      ],
    };
    expect(deriveWrittenPaths(state, [okResult("t1")])).toEqual(["out/a.html"]);
    expect(deriveWrittenPaths(state, [errResult("t2")])).toEqual([]);
  });

  it("非写盘工具与缺路径的调用不算；去重；裸事件信封也认", () => {
    expect(deriveWrittenPaths(null, [call("t1", "", "bash")])).toEqual([]);
    expect(deriveWrittenPaths(null, [{ type: "tool_call", toolUseId: "t9", name: "memory_write", input: { file_path: "m.md" } }])).toEqual(["m.md"]);
    const batch = [call("t1", "out/a.html"), call("t2", "out/a.html"), okResult("t1")];
    expect(deriveWrittenPaths(null, batch)).toEqual(["out/a.html"]);
  });
});

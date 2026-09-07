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
 *             顶条 chrome（名称/徽章/大小/位置）、Esc 与 ←/→、取件失败错误卡
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  CSV_MAX_ROWS,
  artifactRendererKind,
  rendererKindLabel,
  artifactCodeLang,
  parseCsv,
  encodeArtifactHash,
  parseArtifactRoute,
  isArtifactRoute,
  wrapIndex,
  formatBytes,
  artifactBasename,
  initArtifactCanvas,
} from "../ui/public/features/artifact-canvas.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

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
    ["out/noext", "binary"],
  ])("%s → %s", (path, kind) => {
    expect(artifactRendererKind(path)).toBe(kind);
  });

  it("查询串与反斜杠不影响判定", () => {
    expect(artifactRendererKind("C:\\work\\out\\index.html?x=1")).toBe("html");
  });

  it("每种渲染器都有中文徽章", () => {
    for (const kind of ["html", "image", "markdown", "csv", "code", "text", "binary"]) {
      expect(rendererKindLabel(kind)).toBeTruthy();
    }
    expect(rendererKindLabel("csv")).toBe("表格");
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
    expect(parseArtifactRoute(hash)).toEqual({ runId: "run-123", index: 4 });
  });

  it("runId 含特殊字符时先编码再解码", () => {
    const hash = encodeArtifactHash("a b/c", 0);
    expect(hash).not.toContain("a b/c");
    expect(parseArtifactRoute(hash)).toEqual({ runId: "a b/c", index: 0 });
  });

  it("拒绝非画布 hash", () => {
    expect(parseArtifactRoute("#/")).toBeNull();
    expect(parseArtifactRoute("#/settings")).toBeNull();
    expect(parseArtifactRoute("#/run/abc/loop")).toBeNull();
    expect(parseArtifactRoute("#/run/abc/artifact/x")).toBeNull();
    expect(isArtifactRoute("#/run/abc/artifact/0")).toBe(true);
    expect(isArtifactRoute("#/run/abc")).toBe(false);
  });
});

describe("wrapIndex / formatBytes / artifactBasename", () => {
  it("序号循环与空清单", () => {
    expect(wrapIndex(0, 3)).toBe(0);
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(-1, 3)).toBe(2);
    expect(wrapIndex(5, 0)).toBe(-1);
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

  it("HTML 产物：iframe 沙箱不允许 same-origin，且不发 fetch", async () => {
    const fakeFetch = vi.fn();
    const api = initArtifactCanvas(setupHost(), { fetch: fakeFetch });
    expect(api.open(0)).toBe(true);
    expect(api.isOpen()).toBe(true);
    const frame = document.querySelector("iframe.ac-frame");
    expect(frame).toBeTruthy();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toContain("/api/runs/run-1/artifact?path=out%2Findex.html");
    // 相对资源失效的预期要标注出来
    expect(document.querySelector(".ac-note")?.textContent).toContain("相对资源");
    expect(fakeFetch).not.toHaveBeenCalled();
    // chrome：名称 + 徽章 + 位置
    expect(document.querySelector(".ac-name")?.textContent).toBe("index.html");
    expect(document.querySelector(".ac-badge")?.textContent).toBe("网站");
    expect(document.querySelector(".ac-pos")?.textContent).toBe("1 / 6");
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

  it("◀ ▶ 按钮只上报宿主（hash 归宿主），位置指示随之循环", async () => {
    const host = setupHost();
    const api = initArtifactCanvas(host, { fetch: vi.fn(async () => textRes("x")) });
    api.open(0);
    document.querySelector(".ac-nav[aria-label='下一件产物']").click();
    expect(host.onSwitch).toHaveBeenCalledWith(1);
    // 宿主写完 hash 绕回来调 open——这里模拟这一圈
    api.open(1);
    await flush();
    expect(document.querySelector(".ac-pos")?.textContent).toBe("2 / 6");
    document.querySelector(".ac-nav[aria-label='上一件产物']").click();
    expect(host.onSwitch).toHaveBeenCalledWith(0);
  });

  it("单产物时 ◀ ▶ 禁用", () => {
    const api = initArtifactCanvas(
      setupHost({ getArtifacts: () => [{ path: "out/a.png" }] }),
      { fetch: vi.fn() },
    );
    api.open(0);
    expect(document.querySelector(".ac-nav[aria-label='上一件产物']").disabled).toBe(true);
    expect(document.querySelector(".ac-pos")?.textContent).toBe("");
  });

  it("Esc 关闭、←/→ 切换；关闭后键盘归还", async () => {
    const host = setupHost();
    const api = initArtifactCanvas(host, { fetch: vi.fn(async () => textRes("x")) });
    api.open(2);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(host.onSwitch).toHaveBeenCalledWith(3);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(host.onSwitch).toHaveBeenCalledWith(1);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(host.onClose).toHaveBeenCalled();
    // 宿主收到后关视图；关掉再按箭头不再触发
    api.close();
    host.onSwitch.mockClear();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(host.onSwitch).not.toHaveBeenCalled();
  });

  it("关闭按钮与在文件夹中显示走宿主回调", () => {
    const host = setupHost();
    const api = initArtifactCanvas(host, { fetch: vi.fn() });
    api.open(1);
    document.querySelector(".ac-reveal").click();
    expect(host.onReveal).toHaveBeenCalledWith("out/plot.png");
    document.querySelector(".ac-close").click();
    expect(host.onClose).toHaveBeenCalled();
  });

  it("close 清空内容并隐藏视图；幂等初始化返回同一实例", () => {
    const host = setupHost();
    const api = initArtifactCanvas(host, { fetch: vi.fn() });
    api.open(1);
    api.close();
    expect(document.getElementById("artifact-canvas-view").hidden).toBe(true);
    expect(document.querySelector(".ac-body").innerHTML).toBe("");
    const again = initArtifactCanvas(setupHost(), { fetch: vi.fn() });
    expect(again.element).toBe(api.element);
  });
});

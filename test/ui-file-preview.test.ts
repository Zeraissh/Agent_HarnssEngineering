// @vitest-environment jsdom
// @ts-nocheck
/**
 * features/file-preview（V-35）回归锁。
 *
 * 分层覆盖：
 *   纯函数层：pastedFileName（截图命名/真实名保留/mime→扩展名）、
 *             dragHasFiles / filesFromDrop / filesFromPaste（提取与改名、
 *             同批重名追加序号）、buildFilePreviewUrl（编码/workdir/download）
 *   覆盖层  ：initFilePreview 打开/按类型分派渲染（md/html/图片/csv/代码/
 *             二进制降级卡）/Esc 与遮罩关闭/取件失败错误卡/幂等
 *   入口层  ：initFileIntake 拖拽高亮（enter/over/leave/drop）、只有文件才接管、
 *             文本拖拽还给默认行为、window 全局兜底防页面被文件替换、
 *             paste 提取文件与命名、文本+文件并存时文本照常插入
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  pastedFileName,
  dragHasFiles,
  filesFromDrop,
  filesFromPaste,
  buildFilePreviewUrl,
  initFilePreview,
  initFileIntake,
} from "../ui/public/features/file-preview.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

/** jsdom 没有 DragEvent：用普通 cancelable Event + 手工挂 dataTransfer */
function fakeDragEvent(type, { types = [], files = [] } = {}) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types, files, dropEffect: "none" },
  });
  return event;
}

function fakePasteEvent({ files = [], text = "" } = {}) {
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { files, getData: (t) => (t === "text/plain" ? text : "") },
  });
  return event;
}

const okText = (text) => async () => ({ ok: true, text: async () => text });

// ---------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------

describe("pastedFileName 截图命名", () => {
  it("真实文件名原样保留", () => {
    expect(pastedFileName({ name: "报告.md", type: "text/markdown" }, 123)).toBe("报告.md");
  });

  it("空名截图 → pasted-<时间戳>.<按 mime 的扩展名>", () => {
    expect(pastedFileName({ name: "", type: "image/png" }, 123)).toBe("pasted-123.png");
    expect(pastedFileName({ name: "", type: "image/jpeg" }, 123)).toBe("pasted-123.jpg");
  });

  it("浏览器通用占位名（image.png）也视为没名字——连贴两张不互相覆盖", () => {
    expect(pastedFileName({ name: "image.png", type: "image/png" }, 456)).toBe("pasted-456.png");
  });

  it("未知 mime → .bin", () => {
    expect(pastedFileName({ name: "", type: "application/octet-stream" }, 789)).toBe("pasted-789.bin");
  });
});

describe("拖拽/粘贴文件提取", () => {
  it("dragHasFiles 只看 types 里的 Files", () => {
    expect(dragHasFiles({ types: ["Files"] })).toBe(true);
    expect(dragHasFiles({ types: ["text/plain"] })).toBe(false);
    expect(dragHasFiles(null)).toBe(false);
  });

  it("filesFromDrop：有文件返回数组，纯文本拖拽返回 null", () => {
    const f = new File(["x"], "a.txt");
    expect(filesFromDrop({ files: [f] })).toEqual([f]);
    expect(filesFromDrop({ files: [] })).toBeNull();
    expect(filesFromDrop(null)).toBeNull();
  });

  it("filesFromPaste：无文件返回 null（纯文本粘贴走默认插入）", () => {
    expect(filesFromPaste({ files: [] })).toBeNull();
  });

  it("filesFromPaste：截图改名，真实文件保留原名，同批重名追加序号", () => {
    const shot = new File(["a"], "", { type: "image/png" });
    const shot2 = new File(["b"], "image.png", { type: "image/png" });
    const real = new File(["c"], "笔记.md", { type: "text/markdown" });
    const out = filesFromPaste({ files: [shot, shot2, real] }, 1000);
    expect(out.map((f) => f.name)).toEqual(["pasted-1000.png", "pasted-1000-2.png", "笔记.md"]);
    expect(out[2]).toBe(real); // 原名未改的对象原样返回，不重建
    expect(out[0].type).toBe("image/png");
  });
});

describe("buildFilePreviewUrl", () => {
  it("只带 path：编码中文与空格", () => {
    // URLSearchParams 的空格编为 "+"（与 %20 在服务端解码等价），断言按同一编码器构造
    const expected = `/api/file-preview?${new URLSearchParams({ path: "上传 文件/报告.md" })}`;
    expect(buildFilePreviewUrl({ path: "上传 文件/报告.md" })).toBe(expected);
    // 服务端 URLSearchParams 解码后能还原原文（"+" 与 "%20" 都回到空格）
    const decoded = new URLSearchParams(buildFilePreviewUrl({ path: "上传 文件/报告.md" }).split("?")[1]);
    expect(decoded.get("path")).toBe("上传 文件/报告.md");
  });

  it("带 workdir 与 download", () => {
    const url = buildFilePreviewUrl({ path: "a.txt", workdir: "D:\\工作\\目录", download: true });
    expect(url).toContain("path=a.txt");
    expect(url).toContain(`workdir=${encodeURIComponent("D:\\工作\\目录")}`);
    expect(url).toContain("download=1");
  });
});

// ---------------------------------------------------------------
// 预览覆盖层
// ---------------------------------------------------------------

describe("initFilePreview 覆盖层", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("打开 markdown：渲染成排版文档，顶条有名称/徽章/大小，下载链接带 download=1", async () => {
    const api = initFilePreview({}, { fetch: okText("# 标题\n\n正文**加粗**。") });
    const opened = api.open({ path: "docs/报告.md", url: "/api/file-preview?path=docs%2F报告.md" });
    expect(opened).toBe(true);
    expect(api.isOpen()).toBe(true);
    await flush();
    const el = api.element;
    expect(el.hidden).toBe(false);
    expect(el.querySelector(".ac-name").textContent).toBe("报告.md");
    expect(el.querySelector(".ac-badge").textContent).toBe("Markdown");
    expect(el.querySelector(".ac-doc")).toBeTruthy();
    expect(el.querySelector(".ac-doc").innerHTML).toContain("标题");
    expect(el.querySelector(".ac-size").textContent).toMatch(/B|KB/);
    expect(el.querySelector(".ac-download").getAttribute("href")).toContain("download=1");
  });

  it("html 进沙箱 iframe（allow-scripts，无 allow-same-origin）；图片直显", async () => {
    const api = initFilePreview({}, { fetch: okText("") });
    api.open({ path: "site/index.html", url: "/api/file-preview?path=site%2Findex.html" });
    await flush();
    const frame = api.element.querySelector("iframe");
    expect(frame).toBeTruthy();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("src")).toContain("/api/file-preview");

    api.open({ path: "shot.png", url: "/api/file-preview?path=shot.png" });
    await flush();
    const img = api.element.querySelector("img.ac-image");
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toContain("shot.png");
  });

  it("csv 成表格；代码高亮；文本 pre；二进制降级信息卡", async () => {
    const api = initFilePreview({}, {
      fetch: async (url) => ({
        ok: true,
        text: async () => (url.includes("csv") ? "名,值\n甲,1\n乙,2\n" : "const x = 1;"),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }),
    });
    api.open({ path: "data.csv", url: "/api/file-preview?path=data.csv" });
    await flush();
    expect(api.element.querySelectorAll("table.ac-table tbody tr").length).toBe(2);
    expect(api.element.querySelector("table.ac-table th").textContent).toBe("名");

    api.open({ path: "src/a.ts", url: "/api/file-preview?path=a.ts" });
    await flush();
    expect(api.element.querySelector("pre.ac-code")).toBeTruthy();

    api.open({ path: "run.log", url: "/api/file-preview?path=run.log" });
    await flush();
    expect(api.element.querySelector("pre.ac-text")).toBeTruthy();

    api.open({ path: "model.bin", url: "/api/file-preview?path=model.bin" });
    await flush();
    expect(api.element.querySelector(".ac-fallback")).toBeTruthy();
    expect(api.element.querySelector(".ac-size").textContent).toBe("3 B");
  });

  it("取件失败画错误卡", async () => {
    const api = initFilePreview({}, { fetch: async () => ({ ok: false }) });
    api.open({ path: "ghost.md", url: "/api/file-preview?path=ghost.md" });
    await flush();
    expect(api.element.querySelector(".ac-fallback")).toBeTruthy();
    expect(api.element.textContent).toContain("读取失败");
  });

  it("Esc 关闭并还原焦点；关闭后再打开仍是新渲染", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const api = initFilePreview({}, { fetch: okText("hello") });
    api.open({ path: "a.txt", url: "/api/file-preview?path=a.txt" });
    await flush();
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(api.isOpen()).toBe(false);
    expect(api.element.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
    api.open({ path: "b.txt", url: "/api/file-preview?path=b.txt" });
    await flush();
    expect(api.isOpen()).toBe(true);
    expect(api.element.querySelector(".ac-name").textContent).toBe("b.txt");
  });

  it("点遮罩关闭，点面板不收；关闭按钮关闭", async () => {
    const api = initFilePreview({}, { fetch: okText("x") });
    api.open({ path: "a.txt", url: "/api/file-preview?path=a.txt" });
    await flush();
    api.element.querySelector(".fp-panel").dispatchEvent(
      new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    expect(api.isOpen()).toBe(true);
    api.element.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(api.isOpen()).toBe(false);

    api.open({ path: "a.txt", url: "/api/file-preview?path=a.txt" });
    api.element.querySelector(".ac-close").click();
    expect(api.isOpen()).toBe(false);
  });

  it("缺 path 或 url 不打开；重复 init 幂等", () => {
    const api = initFilePreview({}, { fetch: okText("x") });
    expect(api.open({ path: "", url: "/x" })).toBe(false);
    expect(api.open({ path: "a.txt", url: "" })).toBe(false);
    expect(api.isOpen()).toBe(false);
    const again = initFilePreview({});
    expect(again).toBe(api);
    expect(document.querySelectorAll("#file-preview-overlay").length).toBe(1);
  });

  it("关闭作废旧渲染：慢 fetch 回来不覆盖新文件", async () => {
    let release;
    const slow = new Promise((r) => { release = r; });
    const api = initFilePreview({}, {
      fetch: (url) => (url.includes("slow") ? slow.then(() => ({ ok: true, text: async () => "慢内容" })) : okText("快内容")()),
    });
    api.open({ path: "slow.md", url: "/api/file-preview?path=slow.md" });
    api.open({ path: "fast.md", url: "/api/file-preview?path=fast.md" });
    await flush();
    release();
    await flush();
    expect(api.element.querySelector(".ac-name").textContent).toBe("fast.md");
    expect(api.element.querySelector(".ac-doc").textContent).toContain("快内容");
    expect(api.element.querySelector(".ac-doc").textContent).not.toContain("慢内容");
  });
});

// ---------------------------------------------------------------
// composer 拖拽/粘贴入口
// ---------------------------------------------------------------

describe("initFileIntake 拖拽上传", () => {
  let zone;
  let input;

  beforeEach(() => {
    document.body.innerHTML = "";
    zone = document.createElement("form");
    zone.className = "submit-bar";
    input = document.createElement("textarea");
    zone.appendChild(input);
    document.body.appendChild(zone);
  });

  it("拖入文件：enter/over 加高亮与提示，drop 触发上传并阻止默认", () => {
    const onFiles = vi.fn();
    initFileIntake({ zone, input, onFiles });

    zone.dispatchEvent(fakeDragEvent("dragenter", { types: ["Files"] }));
    expect(zone.classList.contains("submit-bar--drop-target")).toBe(true);
    const hint = zone.querySelector(".drop-hint");
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain("松开以上传附件");

    const over = fakeDragEvent("dragover", { types: ["Files"] });
    zone.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true); // 不 preventDefault 就不允许 drop

    const f = new File(["x"], "a.txt");
    const drop = fakeDragEvent("drop", { types: ["Files"], files: [f] });
    zone.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true); // 拦下「用文件替换页面」
    expect(onFiles).toHaveBeenCalledWith([f]);
    expect(zone.classList.contains("submit-bar--drop-target")).toBe(false);
    expect(hint.hidden).toBe(true);
  });

  it("子元素间移动的成对 enter/leave 不闪掉高亮，真正离开才还原", () => {
    initFileIntake({ zone, input, onFiles: () => {} });
    zone.dispatchEvent(fakeDragEvent("dragenter", { types: ["Files"] }));
    zone.dispatchEvent(fakeDragEvent("dragenter", { types: ["Files"] })); // 进入子元素
    zone.dispatchEvent(fakeDragEvent("dragleave", { types: ["Files"] })); // 离开子元素但还在 zone 内
    expect(zone.classList.contains("submit-bar--drop-target")).toBe(true);
    zone.dispatchEvent(fakeDragEvent("dragleave", { types: ["Files"] })); // 真正离开
    expect(zone.classList.contains("submit-bar--drop-target")).toBe(false);
  });

  it("拖拽纯文本：不上传、不高亮、不阻止默认（插入文字归浏览器）", () => {
    const onFiles = vi.fn();
    initFileIntake({ zone, input, onFiles });
    zone.dispatchEvent(fakeDragEvent("dragenter", { types: ["text/plain"] }));
    expect(zone.classList.contains("submit-bar--drop-target")).toBe(false);
    const drop = fakeDragEvent("drop", { types: ["text/plain"], files: [] });
    zone.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(false);
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("拖偏了在 zone 外松手：window 兜底阻止页面被文件替换", () => {
    initFileIntake({ zone, input, onFiles: () => {} });
    const drop = fakeDragEvent("drop", { types: ["Files"], files: [new File(["x"], "a.txt")] });
    window.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    const over = fakeDragEvent("dragover", { types: ["Files"] });
    window.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    // zone 内已处理的（defaultPrevented=true）走到 window 不重复拦、不报错
    const inside = fakeDragEvent("drop", { types: ["Files"], files: [new File(["y"], "b.txt")] });
    zone.dispatchEvent(inside); // 冒泡到 window
    expect(inside.defaultPrevented).toBe(true);
  });

  it("粘贴截图：上传且按 mime 命名，拦下默认行为", () => {
    const onFiles = vi.fn();
    initFileIntake({ zone, input, onFiles }, { now: () => 42 });
    const paste = fakePasteEvent({ files: [new File(["a"], "", { type: "image/png" })] });
    input.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0][0][0].name).toBe("pasted-42.png");
  });

  it("同时有文本和文件：文件上传 + 文本照常插入（不拦默认）", () => {
    const onFiles = vi.fn();
    initFileIntake({ zone, input, onFiles }, { now: () => 7 });
    const file = new File(["x"], "数据.csv", { type: "text/csv" });
    const paste = fakePasteEvent({ files: [file], text: "见附件" });
    input.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(false);
    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it("纯文本粘贴：不上传、不拦默认", () => {
    const onFiles = vi.fn();
    initFileIntake({ zone, input, onFiles });
    const paste = fakePasteEvent({ text: "只是文字" });
    input.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(false);
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("destroy 解绑事件并摘掉提示层", () => {
    const onFiles = vi.fn();
    const intake = initFileIntake({ zone, input, onFiles });
    intake.destroy();
    const drop = fakeDragEvent("drop", { types: ["Files"], files: [new File(["x"], "a.txt")] });
    zone.dispatchEvent(drop);
    expect(onFiles).not.toHaveBeenCalled();
    expect(zone.querySelector(".drop-hint")).toBeNull();
  });
});

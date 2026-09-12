// @vitest-environment jsdom
// @ts-nocheck
/**
 * 预览停靠外壳（features/preview-dock.js）的回归锁——T10 形态升级。
 *
 * 覆盖：
 *   纯函数层：clampDockFraction（钳制/非法回默认）/ readDockFraction（存储
 *             读取与损坏兜底）/ formatDockWidth / dockFractionFromPointer
 *   DOM 层  ：停靠形态（挂 #center-row、对话主列仍在）/ 拖拽调宽与宽度记忆 /
 *             放大还原（按钮、aria-pressed、onExpandChange 上报）/
 *             Esc 两级（放大态先还原再收起）/ 窄屏退化（禁拖拽禁放大、Esc 直接收起）/
 *             收起退出动画（reduced-motion 判据同源）/ 幂等
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DOCK_MIN_FRACTION,
  DOCK_MAX_FRACTION,
  DOCK_DEFAULT_FRACTION,
  DOCK_WIDTH_STORAGE_KEY,
  DOCK_CLOSE_ANIM_MS,
  clampDockFraction,
  readDockFraction,
  formatDockWidth,
  dockFractionFromPointer,
  createPreviewDock,
} from "../ui/public/features/preview-dock.js";

const settle = (ms = DOCK_CLOSE_ANIM_MS + 60) => new Promise((r) => setTimeout(r, ms));

/** 带 center-row + main-area 的页面骨架（dock 的停靠位与"对话仍在"的见证） */
function setupPage() {
  document.body.innerHTML =
    `<main id="main-panel"><div id="center-row">` +
    `<div id="main-area" class="content-area"><p>对话主列</p></div>` +
    `</div></main>`;
  // jsdom 没有布局：给容器一个可算的矩形，拖拽数学才有输入
  const row = document.getElementById("center-row");
  row.getBoundingClientRect = () => ({ left: 0, right: 1000, width: 1000, top: 0, bottom: 600, height: 600 });
  return row;
}

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

// ---------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------

describe("dock 宽度纯函数", () => {
  it("clampDockFraction 钳制到区间，非法输入回默认", () => {
    expect(clampDockFraction(0.5)).toBe(0.5);
    expect(clampDockFraction(0.1)).toBe(DOCK_MIN_FRACTION);
    expect(clampDockFraction(0.95)).toBe(DOCK_MAX_FRACTION);
    expect(clampDockFraction(Number.NaN)).toBe(DOCK_DEFAULT_FRACTION);
    expect(clampDockFraction(undefined)).toBe(DOCK_DEFAULT_FRACTION);
  });

  it("readDockFraction：空/损坏/越界都回默认，合法值保留", () => {
    const storage = fakeStorage();
    expect(readDockFraction(storage)).toBe(DOCK_DEFAULT_FRACTION);
    storage.setItem(DOCK_WIDTH_STORAGE_KEY, "0.6");
    expect(readDockFraction(storage)).toBeCloseTo(0.6);
    storage.setItem(DOCK_WIDTH_STORAGE_KEY, "不是数字");
    expect(readDockFraction(storage)).toBe(DOCK_DEFAULT_FRACTION);
    storage.setItem(DOCK_WIDTH_STORAGE_KEY, "0.01");
    expect(readDockFraction(storage)).toBe(DOCK_MIN_FRACTION);
    expect(readDockFraction(null)).toBe(DOCK_DEFAULT_FRACTION);
  });

  it("formatDockWidth 输出百分比字符串", () => {
    expect(formatDockWidth(0.5)).toBe("50.0%");
    expect(formatDockWidth(0.3333)).toBe("33.3%");
  });

  it("dockFractionFromPointer：右缘钉住，指针越左面板越宽；容器不可测返回 null", () => {
    expect(dockFractionFromPointer({ clientX: 500, containerRight: 1000, containerWidth: 1000 })).toBeCloseTo(0.5);
    expect(dockFractionFromPointer({ clientX: 100, containerRight: 1000, containerWidth: 1000 })).toBe(DOCK_MAX_FRACTION);
    expect(dockFractionFromPointer({ clientX: 950, containerRight: 1000, containerWidth: 1000 })).toBe(DOCK_MIN_FRACTION);
    expect(dockFractionFromPointer({ clientX: 500, containerRight: 0, containerWidth: 0 })).toBeNull();
  });
});

// ---------------------------------------------------------------
// DOM 层
// ---------------------------------------------------------------

describe("createPreviewDock — 停靠形态与开关", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("打开：挂进 #center-row，对话主列仍在且面板可见；宽度按记忆", () => {
    const row = setupPage();
    const storage = fakeStorage();
    storage.setItem(DOCK_WIDTH_STORAGE_KEY, "0.6");
    const dock = createPreviewDock({ id: "pd-a", label: "产物画布" }, { storage });
    expect(dock.root.parentElement).toBe(row);
    expect(dock.isOpen()).toBe(false);
    dock.open();
    expect(dock.isOpen()).toBe(true);
    expect(dock.root.hidden).toBe(false);
    expect(dock.root.style.width).toBe("60%");
    // 对话主列没被挪走也没被藏
    const main = document.getElementById("main-area");
    expect(main.hidden).toBe(false);
    expect(main.textContent).toContain("对话主列");
  });

  it("收起：先播退出动画再隐藏（reduced-motion 判据与 CSS 同源），再打开不被误藏", async () => {
    setupPage();
    const dock = createPreviewDock({ id: "pd-b", label: "预览" }, {});
    dock.open();
    dock.close();
    expect(dock.isOpen()).toBe(false);
    // jsdom 没有 matchMedia → 走动画分支：此刻还没隐藏
    expect(dock.root.classList.contains("preview-dock--closing")).toBe(true);
    expect(dock.root.hidden).toBe(false);
    // 动画没播完又打开：计时器作废，面板不藏
    dock.open();
    await settle();
    expect(dock.root.hidden).toBe(false);
    dock.close();
    await settle();
    expect(dock.root.hidden).toBe(true);
    expect(dock.root.classList.contains("preview-dock--closing")).toBe(false);
  });

  it("closeAnimMs=0 时收起立即隐藏（测试与降级路径）", () => {
    setupPage();
    const dock = createPreviewDock({ id: "pd-c", label: "预览" }, { closeAnimMs: 0 });
    dock.open();
    dock.close();
    expect(dock.root.hidden).toBe(true);
  });

  it("幂等：同 id 重复创建返回同一实例", () => {
    setupPage();
    const a = createPreviewDock({ id: "pd-d", label: "预览" }, {});
    const b = createPreviewDock({ id: "pd-d", label: "预览" }, {});
    expect(b).toBe(a);
    expect(document.querySelectorAll("#pd-d").length).toBe(1);
  });

  it("关闭时焦点还原到打开前的元素", () => {
    setupPage();
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const dock = createPreviewDock({ id: "pd-e", label: "预览" }, { closeAnimMs: 0 });
    dock.open();
    dock.close();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("createPreviewDock — 拖拽调宽", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  const drag = (dock, fromX, toX) => {
    const handle = dock.root.querySelector(".pd-handle");
    handle.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: fromX }));
    document.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: toX }));
    document.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true, clientX: toX }));
  };

  it("拖左缘调宽并写入存储；拖拽中有 dragging 类", () => {
    setupPage();
    const storage = fakeStorage();
    const dock = createPreviewDock({ id: "pd-f", label: "预览" }, { storage });
    dock.open();
    expect(parseFloat(dock.root.style.width)).toBeCloseTo(DOCK_DEFAULT_FRACTION * 100);
    const handle = dock.root.querySelector(".pd-handle");
    handle.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 500 }));
    document.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 400 }));
    expect(dock.root.style.width).toBe("60%");
    expect(dock.root.classList.contains("preview-dock--dragging")).toBe(true);
    document.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true, clientX: 400 }));
    expect(dock.root.classList.contains("preview-dock--dragging")).toBe(false);
    expect(storage.getItem(DOCK_WIDTH_STORAGE_KEY)).toBe("0.6");
    expect(dock.fraction()).toBeCloseTo(0.6);
  });

  it("拖过界钳制在区间内", () => {
    setupPage();
    const dock = createPreviewDock({ id: "pd-g", label: "预览" }, { storage: fakeStorage() });
    dock.open();
    drag(dock, 500, 50); // 想要 95% → 钳到 75%
    expect(dock.fraction()).toBe(DOCK_MAX_FRACTION);
    expect(dock.root.style.width).toBe("75%");
  });

  it("放大态与窄屏下拖拽不生效", () => {
    setupPage();
    const dock = createPreviewDock({ id: "pd-h", label: "预览" }, { storage: fakeStorage() });
    dock.open();
    dock.setExpanded(true);
    drag(dock, 500, 400);
    expect(dock.fraction()).toBeCloseTo(DOCK_DEFAULT_FRACTION); // 没动

    const narrow = createPreviewDock({ id: "pd-i", label: "预览" }, { storage: fakeStorage(), isNarrow: () => true });
    narrow.open();
    drag(narrow, 500, 400);
    expect(narrow.fraction()).toBeCloseTo(DOCK_DEFAULT_FRACTION);
  });
});

describe("createPreviewDock — 放大/还原与 Esc 两级", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("放大：加 expanded 类、按钮变「还原」、上报 onExpandChange；还原同理", () => {
    setupPage();
    const onExpandChange = vi.fn();
    const dock = createPreviewDock({ id: "pd-j", label: "预览", onExpandChange }, {});
    dock.open();
    const btn = dock.root.querySelector(".pd-expand");
    expect(btn.textContent).toContain("放大");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    btn.click();
    expect(dock.isExpanded()).toBe(true);
    expect(dock.root.classList.contains("preview-dock--expanded")).toBe(true);
    expect(btn.textContent).toContain("还原");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(onExpandChange).toHaveBeenCalledWith(true);
    btn.click();
    expect(dock.isExpanded()).toBe(false);
    expect(onExpandChange).toHaveBeenCalledWith(false);
  });

  it("Esc 两级：放大态先还原，再按只收起、不拆会话", () => {
    setupPage();
    const dock = createPreviewDock({ id: "pd-k", label: "预览" }, { closeAnimMs: 0 });
    dock.open();
    dock.body.textContent = "还在";
    dock.setExpanded(true);
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(dock.isExpanded()).toBe(false);
    expect(dock.isOpen()).toBe(true);
    expect(dock.isCollapsed()).toBe(false);
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(dock.isOpen()).toBe(true);
    expect(dock.isCollapsed()).toBe(true);
    expect(dock.root.hidden).toBe(true);
    expect(dock.body.textContent).toBe("还在");
    expect(dock.revealBtn.hidden).toBe(false);
    dock.revealBtn.click();
    expect(dock.isCollapsed()).toBe(false);
    expect(dock.root.hidden).toBe(false);
  });

  it("窄屏退化：加 narrow 类、放大被忽略、Esc 直接收起", () => {
    setupPage();
    const dock = createPreviewDock({ id: "pd-l", label: "预览" }, { isNarrow: () => true, closeAnimMs: 0 });
    dock.open();
    expect(dock.root.classList.contains("preview-dock--narrow")).toBe(true);
    dock.setExpanded(true);
    expect(dock.isExpanded()).toBe(false); // 窄屏本来就是覆盖式，放大无意义
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(dock.isCollapsed()).toBe(true);
    expect(dock.isOpen()).toBe(true);
  });

  it("顶条收起键与右侧展开钮对开，close 才真正拆掉会话", () => {
    setupPage();
    const dock = createPreviewDock({ id: "pd-collapse", label: "预览" }, { closeAnimMs: 0 });
    dock.open();
    dock.body.textContent = "内容";
    dock.closeBtn.click();
    expect(dock.isCollapsed()).toBe(true);
    expect(dock.isOpen()).toBe(true);
    expect(dock.body.textContent).toBe("内容");
    dock.revealBtn.click();
    expect(dock.isCollapsed()).toBe(false);
    dock.close();
    expect(dock.isOpen()).toBe(false);
    expect(dock.body.textContent).toBe("");
    expect(dock.revealBtn.hidden).toBe(true);
  });

  it("覆盖变体：带 overlay 类，与停靠型同一份行为", () => {
    setupPage();
    const dock = createPreviewDock({ id: "pd-m", label: "文件预览", overlay: true }, {});
    expect(dock.root.classList.contains("preview-dock--overlay")).toBe(true);
    dock.open();
    dock.setExpanded(true);
    expect(dock.root.classList.contains("preview-dock--expanded")).toBe(true);
  });

  it("insertHeadControl：特征控件在收起键之后、放大键恒在最右", () => {
    setupPage();
    const dock = createPreviewDock({ id: "pd-n", label: "预览" }, {});
    const a = document.createElement("span");
    a.className = "ctl-a";
    const b = document.createElement("span");
    b.className = "ctl-b";
    dock.insertHeadControl(a);
    dock.insertHeadControl(b);
    const kids = [...dock.head.children];
    expect(kids[0]).toBe(dock.closeBtn);
    expect(kids.indexOf(a)).toBeLessThan(kids.indexOf(b));
    expect(kids[kids.length - 1]).toBe(dock.expandBtn);
  });
});

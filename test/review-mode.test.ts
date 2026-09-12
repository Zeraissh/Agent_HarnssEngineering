// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  INSPECT_MESSAGE_TYPE,
  INSPECT_HOOK_SOURCE,
  DECK_READY_MESSAGE_TYPE,
  PRINT_HOOK_SOURCE,
  appendReviewToInput,
  attachDesignEditScope,
  buildCssSelector,
  formatDesignEditScope,
  formatReviewComment,
  normalizeDesignEditScope,
  formatImageReview,
  injectInspectHook,
  appendInspectHook,
  appendSiteHooks,
  isInspectPick,
  pathLength,
  pct,
  strokeBounds,
  stripScripts,
} from "../ui/public/features/review-mode.js";

describe("buildCssSelector / formatReviewComment", () => {
  it("优先 id；否则 tag + 合法 class + 可选父级", () => {
    expect(buildCssSelector({ id: "hero" })).toBe("#hero");
    expect(buildCssSelector({ tag: "button", className: "btn primary evil{}" })).toBe("button.btn.primary");
    expect(buildCssSelector({ tag: "li", nth: 2, parent: "ul.nav" })).toBe("ul.nav > li:nth-of-type(2)");
  });

  it("点评行是纯文本，可接到已有输入后面；可带 slide", () => {
    expect(formatReviewComment("h1.hero", "对比度不够")).toBe("[点评] h1.hero: 对比度不够");
    expect(formatReviewComment("h1.hero", "对比度不够", "3")).toBe("[点评][slide:3] h1.hero: 对比度不够");
    expect(formatReviewComment("  ", "")).toBe("[点评] (未识别)");
    expect(appendReviewToInput("先改首页", "[点评] h1: 太大")).toBe("先改首页\n[点评] h1: 太大");
    expect(appendReviewToInput("", "[点评] h1: 太大")).toBe("[点评] h1: 太大");
  });

  it("选中范围进入续跑正文；未选中不误伤", () => {
    expect(normalizeDesignEditScope(null)).toBeNull();
    expect(normalizeDesignEditScope({ slide: "" })).toBeNull();
    expect(normalizeDesignEditScope({ slide: '3" onclick' })).toBeNull();
    expect(normalizeDesignEditScope({ slide: "3", path: "out/index.html" })).toEqual({
      slide: "3",
      path: "out/index.html",
    });
    expect(attachDesignEditScope("缩短标题", null)).toBe("缩短标题");
    expect(attachDesignEditScope("缩短标题", {})).toBe("缩短标题");
    const scoped = attachDesignEditScope("缩短标题", { slide: "3", path: "out/index.html" });
    expect(scoped).toContain('[改稿范围] 只改 data-slide="3"（文件 out/index.html）');
    expect(scoped).toContain("缩短标题");
    expect(scoped).toContain("不要整份重写");
    expect(attachDesignEditScope("[点评][slide:2] h1: 太大", { slide: "3" })).toBe(
      "[点评][slide:2] h1: 太大",
    );
    const already = formatDesignEditScope({ slide: "1" });
    expect(attachDesignEditScope(`${already}\n再改`, { slide: "9" })).toBe(`${already}\n再改`);
  });
});

describe("inspect hook 注入", () => {
  it("injectInspectHook：剥掉原页面 script，再注入点选钩子", () => {
    const html = "<html><body><h1>Hi</h1><script>alert(1)</script></body></html>";
    expect(stripScripts(html)).not.toContain("<script>alert");
    const hooked = injectInspectHook(html);
    expect(hooked).not.toContain("alert(1)");
    expect(hooked).toContain(INSPECT_MESSAGE_TYPE);
    expect(hooked).toContain("parent.postMessage");
    expect(hooked).toMatch(/<\/script><\/body>/i);
  });

  it("appendInspectHook：保留页面脚本（整站点评）", () => {
    const html = "<html><body><h1>Hi</h1><script>window.__keep=1</script></body></html>";
    const hooked = appendInspectHook(html);
    expect(hooked).toContain("window.__keep=1");
    expect(hooked).toContain(INSPECT_MESSAGE_TYPE);
  });

  it("appendSiteHooks：可叠 deck + inspect", () => {
    const html = "<html><body><section class=\"slide\" data-slide=\"1\">A</section></body></html>";
    const hooked = appendSiteHooks(html, { deck: true, inspect: true });
    expect(hooked).toContain(DECK_READY_MESSAGE_TYPE);
    expect(hooked).toContain(INSPECT_MESSAGE_TYPE);
    expect(hooked).toContain("closest");
  });

  it("点评钩子含悬停外描边；点击后短暂固定（pinUntil）", () => {
    expect(INSPECT_HOOK_SOURCE).toContain("agent-inspect-ring");
    expect(INSPECT_HOOK_SOURCE).toContain("getBoundingClientRect");
    expect(INSPECT_HOOK_SOURCE).toContain("mousemove");
    expect(INSPECT_HOOK_SOURCE).toContain("pointer-events:none");
    expect(INSPECT_HOOK_SOURCE).toContain("pinUntil");
  });

  it("print 钩子调起 window.print", () => {
    expect(PRINT_HOOK_SOURCE).toContain("window.print");
    const hooked = appendSiteHooks("<html><body>x</body></html>", { print: true });
    expect(hooked).toContain("window.print");
  });

  it("只认本协议的 postMessage", () => {
    expect(isInspectPick({ type: INSPECT_MESSAGE_TYPE, selector: "h1" })).toBe(true);
    expect(isInspectPick({ type: INSPECT_MESSAGE_TYPE, selector: "  " })).toBe(false);
    expect(isInspectPick({ type: "other", selector: "h1" })).toBe(false);
  });
});

describe("图片标注点评行", () => {
  it("点按给坐标，笔迹给包围盒", () => {
    expect(pct(0.324)).toBe(32);
    expect(pathLength([{ x: 0, y: 0 }, { x: 0.3, y: 0.4 }])).toBeCloseTo(0.5);
    expect(strokeBounds([{ points: [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.9 }] }])).toEqual({
      x0: 0.1, y0: 0.2, x1: 0.8, y1: 0.9,
    });
    expect(formatImageReview({ pins: [{ x: 0.32, y: 0.48 }], comment: "太暗" }))
      .toBe("[点评] 图片 32%,48%: 太暗");
    expect(formatImageReview({
      strokes: [{ points: [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.7 }] }],
      comment: "对比度不够",
    })).toBe("[点评] 图片标注 1 笔 (10%,20%–80%,70%): 对比度不够");
    expect(formatImageReview({})).toBe("[点评] 图片");
  });
});

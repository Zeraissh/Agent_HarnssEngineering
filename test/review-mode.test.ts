// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  INSPECT_MESSAGE_TYPE,
  appendReviewToInput,
  buildCssSelector,
  formatReviewComment,
  formatImageReview,
  injectInspectHook,
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

  it("点评行是纯文本，可接到已有输入后面", () => {
    expect(formatReviewComment("h1.hero", "对比度不够")).toBe("[点评] h1.hero: 对比度不够");
    expect(formatReviewComment("  ", "")).toBe("[点评] (未识别)");
    expect(appendReviewToInput("先改首页", "[点评] h1: 太大")).toBe("先改首页\n[点评] h1: 太大");
    expect(appendReviewToInput("", "[点评] h1: 太大")).toBe("[点评] h1: 太大");
  });
});

describe("inspect hook 注入", () => {
  it("剥掉原页面 script，再注入点选钩子", () => {
    const html = "<html><body><h1>Hi</h1><script>alert(1)</script></body></html>";
    expect(stripScripts(html)).not.toContain("<script>alert");
    const hooked = injectInspectHook(html);
    expect(hooked).not.toContain("alert(1)");
    expect(hooked).toContain(INSPECT_MESSAGE_TYPE);
    expect(hooked).toContain("parent.postMessage");
    expect(hooked).toMatch(/<\/script><\/body>/i);
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

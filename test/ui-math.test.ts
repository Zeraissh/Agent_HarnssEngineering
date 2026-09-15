// @vitest-environment jsdom
// @ts-nocheck
/**
 * 对话 Markdown 与 HTML 产物预览的 TeX 渲染锁。
 *
 * 界面曾经把 `\(` / `\[` 当纯文本铺出来（模型再双转义成 `\\(` 更糟）。
 * 这里锁：气泡/HTML fixture 必须长出 `.katex`，且 `C:\\Users` 不被当分隔符剥。
 */
import { describe, expect, it, beforeAll } from "vitest";
import katex from "katex";
import renderMathInElement from "katex/contrib/auto-render";
import { renderMarkdown, renderMarkdownInline } from "../ui/public/core/markdown.js";
import {
  unescapeTexDelimiters,
  unescapeTexInElement,
  typesetDom,
  htmlHasTexDelimiters,
  pageHasMathRenderer,
  KATEX_AUTO_OPTS,
} from "../ui/public/core/math.js";
import { bootKatexPreviewRuntime } from "../ui/public/core/katex-preview-runtime.js";
import { renderChatItem } from "../ui/public/app.js";
import { appendKatexRuntime, appendSiteHooks } from "../ui/public/features/review-mode.js";

beforeAll(() => {
  globalThis.katex = katex;
  globalThis.renderMathInElement = renderMathInElement;
});

function mount(html) {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

describe("unescapeTexDelimiters：只剥成对 TeX 分隔符", () => {
  it("C:\\\\Users 不被改", () => {
    const src = String.raw`C:\\Users\\rk302\\work`;
    expect(unescapeTexDelimiters(src)).toBe(src);
    const host = mount(renderMarkdown(`path ${src} and more`));
    expect(host.textContent).toContain(src);
  });

  it("\\\\(E=mc^2\\\\) 剥一层变成 \\\\( … \\\\)", () => {
    expect(unescapeTexDelimiters(String.raw`\\(E=mc^2\\)`)).toBe(String.raw`\(E=mc^2\)`);
    expect(unescapeTexDelimiters(String.raw`\\[a+b\\]`)).toBe(String.raw`\[a+b\]`);
  });
});

describe("对话 Markdown：公式渲染成 .katex", () => {
  it("双转义行内公式 \\\\(E=mc^2\\\\) 长出 .katex，正文不再只剩裸 \\\\(", () => {
    const host = mount(renderMarkdown(String.raw`能量 \\(E=mc^2\\)`));
    expect(host.querySelector(".katex"), "应该交给 KaTeX").toBeTruthy();
    expect(host.textContent).toContain("E");
    expect(host.textContent).not.toMatch(/\\+\(/);
  });

  it("双转义独立公式 \\\\[a+b\\\\] 是 display .katex", () => {
    const host = mount(renderMarkdown(String.raw`\\[a+b\\]`));
    expect(host.querySelector(".katex")).toBeTruthy();
    expect(host.querySelector(".katex-display, .md-math-block .katex")).toBeTruthy();
    expect(host.textContent).not.toMatch(/\\+\[/);
  });

  it("单层 \\( \\) / $$ / $ 同样渲染", () => {
    expect(mount(renderMarkdown(String.raw`给定 \(\mathbf{x}\)`)).querySelector(".katex")).toBeTruthy();
    expect(mount(renderMarkdown("$$E=mc^2$$")).querySelector(".katex")).toBeTruthy();
    expect(mount(renderMarkdown("令 $E=mc^2$ 成立")).querySelector(".katex")).toBeTruthy();
    expect(mount(renderMarkdownInline(String.raw`\(\phi_i\)`)).querySelector(".katex")).toBeTruthy();
  });

  it("Hyena 跨行 \\[ \\] 里的 * 不当斜体", () => {
    const src = [
      "Hyena 算子：",
      String.raw`\[`,
      String.raw`\mathbf{y} = \mathbf{h} * \left(\mathbf{x} \odot \mathbf{v}\right)`,
      String.raw`\]`,
    ].join("\n");
    const host = mount(renderMarkdown(src));
    expect(host.querySelector(".katex")).toBeTruthy();
    expect(host.querySelector("em"), "公式里的星号被当成强调了").toBeNull();
    expect(host.textContent).not.toContain(String.raw`\mathbf`);
  });

  it("围栏代码里的 \\\\( 保持原样", () => {
    const host = mount(renderMarkdown(["```", String.raw`\\(E=mc^2\\)`, "```"].join("\n")));
    expect(host.querySelector(".katex")).toBeNull();
    expect(host.querySelector("code")!.textContent).toContain(String.raw`\\(E=mc^2\\)`);
  });

  it("$100 不当公式", () => {
    const host = mount(renderMarkdown("价格 $100 即可"));
    expect(host.querySelector(".katex")).toBeNull();
    expect(host.textContent).toContain("$100");
  });
});

describe("助手气泡 fixture", () => {
  it("chat-body 里的 \\\\(E=mc^2\\\\) 渲染为 .katex", () => {
    const html = renderChatItem({
      kind: "text",
      text: `能量 ${String.raw`\\(E=mc^2\\)`} 与\n${String.raw`\\[a+b\\]`}`,
      seq: 1,
      role: "main",
    });
    const host = mount(html);
    const body = host.querySelector(".chat-msg--assistant .chat-body");
    expect(body).toBeTruthy();
    expect(body.querySelector(".katex"), "气泡公式仍是裸反斜杠").toBeTruthy();
    expect(body.textContent).not.toMatch(/\\+\(/);
  });
});

describe("HTML 产物预览：注入 KaTeX", () => {
  it("含 TeX 的稿注入本机 katex；已有渲染器不重复", () => {
    const raw = "<html><body><p>\\\\(E=mc^2\\\\)</p></body></html>";
    const hooked = appendKatexRuntime(raw);
    expect(hooked).toContain("/vendor/katex/katex.min.js");
    expect(hooked).toContain("/vendor/katex/katex.min.css");
    expect(hooked).toContain("/core/katex-preview-runtime.js");
    const already = '<html><head><script src="/vendor/katex/katex.min.js"></script></head><body>\\(x\\)</body></html>';
    expect(appendKatexRuntime(already)).toBe(already);
    expect(appendKatexRuntime("<html><body>hello</body></html>")).not.toContain("katex.min.js");
  });

  it("HTML fixture 经 unescape + auto-render 长出 .katex，路径不被剥", () => {
    document.body.innerHTML = `<p>${String.raw`\\(E=mc^2\\)`} @ ${String.raw`C:\\Users\\rk302`}</p>`;
    unescapeTexInElement(document.body);
    expect(document.body.textContent).toContain(String.raw`C:\\Users\\rk302`);
    typesetDom(document.body);
    expect(document.querySelector(".katex")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\\+\(/);
    expect(document.body.textContent).toContain(String.raw`C:\\Users\\rk302`);
  });

  it("appendSiteHooks 默认会给带 TeX 的稿叠 KaTeX", () => {
    const hooked = appendSiteHooks("<html><body>\\[a+b\\]</body></html>", { print: true });
    expect(hooked).toContain("window.print");
    expect(hooked).toContain("katex.min.js");
    expect(htmlHasTexDelimiters("\\(x\\)")).toBe(true);
    expect(htmlHasTexDelimiters("$E=mc^2$")).toBe(true);
    expect(htmlHasTexDelimiters("价格 $100 即可")).toBe(false);
    expect(appendKatexRuntime("<html><body>$E=mc^2$</body></html>")).toContain("katex.min.js");
    expect(appendKatexRuntime("<html><body>价格 $100 即可</body></html>")).not.toContain("katex.min.js");
    expect(pageHasMathRenderer('<script src="mathjax.js"></script>')).toBe(true);
    expect(KATEX_AUTO_OPTS.trust).toBe(false);
  });

  it("preview runtime 对指定根做 unescape + auto-render", () => {
    const host = document.createElement("div");
    host.innerHTML = `<p>${String.raw`\\(E=mc^2\\)`} @ ${String.raw`C:\\Users\\rk302`}</p>`;
    bootKatexPreviewRuntime(host);
    expect(host.querySelector(".katex")).toBeTruthy();
    expect(host.textContent).not.toMatch(/\\+\(/);
    expect(host.textContent).toContain(String.raw`C:\\Users\\rk302`);
  });
});

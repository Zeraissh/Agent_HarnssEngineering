// @vitest-environment jsdom
// @ts-nocheck
/**
 * 最小 Markdown 渲染器的回归锁。
 *
 * 两组重点：
 *   ① 模型实际会用的记法要渲染对（不然做了等于没做）；
 *   ② **安全**——模型输出是不可信输入。这一组比第一组更重要：渲染错了是难看，
 *      转义漏了是 XSS。
 */
import { describe, expect, it } from "vitest";
import { renderMarkdown, renderMarkdownInline } from "../ui/public/core/markdown.js";

/** 把 HTML 串挂进真实 DOM 再断言——比字符串包含更能反映浏览器实际怎么解析 */
function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

/**
 * XSS 的正确判据是【有没有产生可执行的 DOM】，不是 innerHTML 里有没有那串字。
 * 转义过的 `"` 在文本节点里读回来仍是 `"`，所以 `innerHTML.includes("onerror=")`
 * 对纯文本也会命中——初版就是这么写的，白报了两次假失败。
 */
function hasExecutableInjection(host: HTMLElement): boolean {
  if (host.querySelector("script, img, iframe, object, embed, svg")) return true;
  for (const el of host.querySelectorAll("*")) {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) return true;
      if (/^(href|src)$/i.test(attr.name) && /^\s*(javascript|data):/i.test(attr.value)) return true;
    }
  }
  return false;
}

describe("Markdown 渲染：模型常用记法", () => {
  it("标题降级到 h3 起（页面里已有 h1/h2，不能抢大纲）", () => {
    const host = mount(renderMarkdown("# 一级\n\n## 二级"));
    expect(host.querySelector("h3")!.textContent).toBe("一级");
    expect(host.querySelector("h4")!.textContent).toBe("二级");
  });

  it("粗体 / 斜体 / 删除线 / 行内代码", () => {
    const host = mount(renderMarkdown("这是 **粗** 和 *斜* 和 ~~删~~ 和 `code`"));
    expect(host.querySelector("strong")!.textContent).toBe("粗");
    expect(host.querySelector("em")!.textContent).toBe("斜");
    expect(host.querySelector("del")!.textContent).toBe("删");
    expect(host.querySelector("code")!.textContent).toBe("code");
  });

  it("无序与有序列表", () => {
    const ul = mount(renderMarkdown("- 甲\n- 乙"));
    expect([...ul.querySelectorAll("ul li")].map((e) => e.textContent)).toEqual(["甲", "乙"]);
    const ol = mount(renderMarkdown("1. 甲\n2. 乙"));
    expect([...ol.querySelectorAll("ol li")].map((e) => e.textContent)).toEqual(["甲", "乙"]);
  });

  it("围栏代码块原样保留，内部记法不被解析", () => {
    const host = mount(renderMarkdown("```c\nint x = *p;\n**not bold**\n```"));
    const code = host.querySelector("pre.md-code code")!;
    expect(code.textContent).toBe("int x = *p;\n**not bold**");
    expect(code.querySelector("strong")).toBeNull();
    expect(host.querySelector("pre")!.getAttribute("data-lang")).toBe("c");
  });

  it("收尾围栏缺失也不崩（模型经常写漏）", () => {
    const host = mount(renderMarkdown("```\nabc"));
    expect(host.querySelector("pre code")!.textContent).toBe("abc");
  });

  it("引用与分隔线", () => {
    expect(mount(renderMarkdown("> 注意")).querySelector("blockquote")!.textContent).toBe("注意");
    expect(mount(renderMarkdown("---")).querySelector("hr")).toBeTruthy();
  });

  it("段内换行保留为 <br>，空行分段", () => {
    const host = mount(renderMarkdown("第一行\n第二行\n\n新段"));
    expect(host.querySelectorAll("p")).toHaveLength(2);
    expect(host.querySelector("p")!.innerHTML).toContain("<br>");
  });

  it("行内模式不产生块级标签（裁决 summary 那种单行场景）", () => {
    const host = mount(renderMarkdownInline("**通过**：11 项全过"));
    expect(host.querySelector("p")).toBeNull();
    expect(host.querySelector("strong")!.textContent).toBe("通过");
  });
});

describe("Markdown 渲染：安全（模型输出是不可信输入）", () => {
  it("原始 HTML 一律当死文本，不进 DOM", () => {
    const host = mount(renderMarkdown("<script>alert(1)</script>\n\n<b>粗</b>"));
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("b")).toBeNull();
    // 原文照旧可见——不是丢弃，是不执行
    expect(host.textContent).toContain("<script>alert(1)</script>");
    expect(host.textContent).toContain("<b>粗</b>");
  });

  it("img onerror 这类事件属性注入无效", () => {
    const host = mount(renderMarkdown('![x](y" onerror="alert(1))'));
    expect(hasExecutableInjection(host)).toBe(false);
  });

  it("javascript: 伪协议链接降级为纯文本，不产出 a 标签", () => {
    const host = mount(renderMarkdown("[点我](javascript:alert(1))"));
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toContain("点我");
  });

  it("data: 伪协议同样不放行", () => {
    const host = mount(renderMarkdown("[x](data:text/html,<script>alert(1)</script>)"));
    expect(host.querySelector("a")).toBeNull();
  });

  it("http/https 链接放行，且带 noopener（新窗口不得反向操作本页）", () => {
    const a = mount(renderMarkdown("[文档](https://example.com/a?b=1&c=2)")).querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://example.com/a?b=1&c=2");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.getAttribute("target")).toBe("_blank");
  });

  it("代码块里的 HTML 也不执行", () => {
    const host = mount(renderMarkdown("```\n<script>alert(1)</script>\n```"));
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("code")!.textContent).toBe("<script>alert(1)</script>");
  });

  it("行内模式同样转义", () => {
    const host = mount(renderMarkdownInline('<img src=x onerror="alert(1)">'));
    expect(hasExecutableInjection(host)).toBe(false);
    expect(host.textContent).toContain("onerror"); // 是死文本，不是属性
  });

  it("空/非字符串输入不崩", () => {
    expect(renderMarkdown("")).toBe("");
    expect(() => renderMarkdown(null)).not.toThrow();
    expect(() => renderMarkdownInline(undefined)).not.toThrow();
  });
});

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
import {
  isLocalPathCandidate,
  renderMarkdown,
  renderMarkdownInline,
} from "../ui/public/core/markdown.js";

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

  it("路径样式的行内代码只挂候选标记，不在 Markdown 层伪造链接", () => {
    const host = mount(
      renderMarkdown(
        "目录 `threejs-fps-game/`，文件 `index.html`、`threejs-fps-game/index.html`；普通代码 `Math.max`。",
      ),
    );
    const candidates = [...host.querySelectorAll("code[data-local-path]")]
      .map((node) => node.getAttribute("data-local-path"));
    expect(candidates).toEqual([
      "threejs-fps-game/",
      "index.html",
      "threejs-fps-game/index.html",
    ]);
    expect(host.querySelectorAll("a")).toHaveLength(0);
    expect([...host.querySelectorAll("code")].at(-1)!.textContent).toBe("Math.max");
  });

  it.each([
    ["D:\\Work\\demo\\main.ts:12", true],
    ["../docs/readme.md", true],
    ["My Report.docx", true],
    [".env", true],
    ["npm run test", false],
    ["Math.max", false],
    ["https://example.com/a.txt", false],
  ])("本地路径候选初筛：%s → %s", (value, expected) => {
    expect(isLocalPathCandidate(value)).toBe(expected);
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

describe("Markdown 表格（模型极爱用，原样铺出来最难读）", () => {
  const TABLE = [
    "| # | 源文件 | 测试数 | 状态 |",
    "|---|--------|--------|------|",
    "| 1 | `src/clamp.ts` | 5 | ✅ |",
    "| 2 | `src/chunk.ts` | 6 | ✅ |",
  ].join("\n");

  it("渲染成真表格，表头与数据行分开", () => {
    const host = mount(renderMarkdown(TABLE));
    const t = host.querySelector("table.md-table")!;
    expect(t).toBeTruthy();
    expect([...t.querySelectorAll("thead th")].map((e) => e.textContent)).toEqual([
      "#", "源文件", "测试数", "状态",
    ]);
    expect(t.querySelectorAll("tbody tr")).toHaveLength(2);
    // 单元格里的行内记法照常解析
    expect(t.querySelector("tbody code")!.textContent).toBe("src/clamp.ts");
  });

  it("对齐记法生效（:--- / :---: / ---:）", () => {
    const host = mount(
      renderMarkdown(["| a | b | c |", "|:---|:---:|---:|", "| 1 | 2 | 3 |"].join("\n")),
    );
    const th = [...host.querySelectorAll("th")] as HTMLElement[];
    expect(th[0].style.textAlign).toBe("left");
    expect(th[1].style.textAlign).toBe("center");
    expect(th[2].style.textAlign).toBe("right");
  });

  it("列数以表头为准：多的截掉、少的补空", () => {
    const host = mount(
      renderMarkdown(["| a | b |", "|---|---|", "| 1 |", "| 1 | 2 | 3 |"].join("\n")),
    );
    const rows = [...host.querySelectorAll("tbody tr")];
    expect(rows[0].querySelectorAll("td")).toHaveLength(2);
    expect(rows[1].querySelectorAll("td")).toHaveLength(2);
  });

  it("宽表包在横滚容器里，不撑破布局", () => {
    const host = mount(renderMarkdown(TABLE));
    expect(host.querySelector(".md-table-wrap > table.md-table")).toBeTruthy();
  });

  it("没有分隔行就不是表格——正文里带竖线的句子不该被误判", () => {
    const host = mount(renderMarkdown("| 这只是 | 一句带竖线的话 |\n下一行普通文字"));
    expect(host.querySelector("table")).toBeNull();
    expect(host.textContent).toContain("一句带竖线的话");
  });

  it("分隔行必须含 `-`（纯 `| | |` 不算）", () => {
    const host = mount(renderMarkdown("| a | b |\n|   |   |\n| 1 | 2 |"));
    expect(host.querySelector("table")).toBeNull();
  });

  it("表格里的 HTML 一样不执行", () => {
    const host = mount(
      renderMarkdown(["| x |", "|---|", "| <script>alert(1)</script> |"].join("\n")),
    );
    expect(hasExecutableInjection(host)).toBe(false);
    expect(host.querySelector("td")!.textContent).toContain("<script>");
  });

  it("表格后面的普通段落照常成段", () => {
    const host = mount(renderMarkdown(TABLE + "\n\n结论：全部通过。"));
    expect(host.querySelector("table")).toBeTruthy();
    expect([...host.querySelectorAll("p")].some((p) => p.textContent!.includes("结论"))).toBe(true);
  });
});

describe("代码高亮（委托方：用 VS 那种代码主题）", () => {
  const code = (lang: string, body: string) =>
    mount(renderMarkdown(["```" + lang, body, "```"].join("\n")));

  it("关键字 / 字符串 / 数字 / 注释各自着色", () => {
    const host = code("c", 'int n = 0x1F; // 采样\nconst char *s = "hi";');
    expect(host.querySelector(".hl-kw")!.textContent).toBe("int");
    expect(host.querySelector(".hl-num")!.textContent).toBe("0x1F");
    expect(host.querySelector(".hl-comment")!.textContent).toContain("采样");
    expect(host.querySelector(".hl-str")!.textContent).toContain("hi");
  });

  /**
   * 优先级必须是 注释 > 字符串 > 数字 > 关键字。
   * 反过来写就会在 `const url = "https://x"` 上把半行吃掉当注释——
   * 这是这类实现最常见的 bug。
   */
  it("字符串里的 // 不算注释", () => {
    const host = code("ts", 'const url = "https://example.com/a";');
    expect(host.querySelector(".hl-comment"), "把 URL 里的 // 当成注释了").toBeNull();
    expect(host.querySelector(".hl-str")!.textContent).toContain("https://example.com/a");
  });

  it("注释里的引号不开字符串", () => {
    const host = code("py", '# 他说 "你好\nx = 1');
    expect(host.querySelector(".hl-comment")!.textContent).toContain("你好");
    expect(host.querySelector(".hl-str")).toBeNull();
  });

  it("认不出的语言原样输出——猜着高亮比不高亮更糟", () => {
    const host = code("brainfuck", "+++[->+++<]");
    expect(host.querySelector("[class^='hl-']")).toBeNull();
    expect(host.textContent).toContain("+++[->+++<]");
  });

  it("语言角标进 data-lang，别名归一进 class", () => {
    const host = code("TypeScript", "const a = 1;");
    const pre = host.querySelector("pre")!;
    expect(pre.getAttribute("data-lang")).toBe("TypeScript");
    expect(pre.className).toContain("md-code--ts");
  });

  /**
   * 高亮**在已转义文本上做**。它绝不能反转义——反转义等于把死文本变回活标签，
   * 那是 markdown.js 整篇在防的事。这条同时覆盖"高亮不得引入 XSS"。
   */
  it("代码块里的 HTML 仍然不执行，且不被双重转义", () => {
    const host = code("ts", 'const s = "<script>alert(1)</script>";');
    expect(hasExecutableInjection(host)).toBe(false);
    expect(host.querySelector("code")!.textContent).toContain("<script>alert(1)</script>");
    expect(host.innerHTML, "出现了双重转义").not.toContain("&amp;lt;");
  });

  it("未闭合的字符串不吞掉后面整段（流式时半截代码很常见）", () => {
    const host = code("ts", 'const a = "没闭合\nconst b = 2;');
    expect(host.querySelectorAll(".hl-kw").length, "第二行的 const 被吞了").toBeGreaterThanOrEqual(2);
  });

  it("行内代码不受影响（只有围栏块高亮）", () => {
    const host = mount(renderMarkdown("用 `const x = 1` 表示"));
    expect(host.querySelector("code")!.textContent).toBe("const x = 1");
    expect(host.querySelector(".hl-kw")).toBeNull();
  });
});

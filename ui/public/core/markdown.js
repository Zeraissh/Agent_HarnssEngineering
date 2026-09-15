/**
 * 最小 Markdown 渲染器（零依赖）。
 *
 * 为什么要它：模型稳定地用 Markdown 写作，界面却按纯文本显示——`**粗体**`、
 * `- 列表`、反引号原样铺在页面上是纯噪声，长报告尤其难读。（委托方反馈。）
 *
 * 为什么手写而不是引库：`ui/public/` 是零构建、零运行时依赖的原生 ES 模块，
 * 这条约束从 v1 起就在；而我们要的只是模型实际会用的那几种记法。
 *
 * ================= 安全纪律（这里最不能出错） =================
 * 模型输出是**不可信输入**。做法是【先整体转义，再做变换】：
 *   1. 入口先把 & < > " ' 全部转义 —— 此后源串里不可能再出现真正的 `<`，
 *      任何"用户提供的 HTML"都已经是死文本；
 *   2. 之后所有标签都由本模块自己拼出来，不存在把源串当 HTML 插入的路径；
 *   3. 链接的 href 另外校验协议（只放行 http/https），因为属性值即使转义过，
 *      `javascript:` 这类伪协议仍然危险。
 *
 * 【不支持原始 HTML】是有意的，不是偷懒——支持它就等于把上面那条纪律作废。
 */

import { highlight, normalizeLang } from "./highlight.js";
import {
  unescapeTexDelimiters,
  unescapeTexOutsideFences,
  holdMathInEscaped,
  restoreHeldMath,
  matchDisplayMathBlock,
  isDisplayMathStart,
  renderTexHtml,
} from "./math.js";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

const LOCAL_PATH_EXT =
  "html?|css|scss|sass|less|m?js|cjs|jsx|tsx?|json|mdx?|txt|csv|log|ya?ml|toml|ini|env|" +
  "py|c|h|cc|cpp|cxx|hpp|cs|java|go|rs|sh|ps1|bat|cmd|sln|csproj|vcxproj|xml|" +
  "pdf|png|jpe?g|gif|webp|svg|docx?|xlsx?|pptx?|zip|7z|tar|gz|elf|hex|bin|map|" +
  "kicad_(?:pcb|sch|pro)";

/**
 * 从引用串里抽出真正该探测的路径。
 *
 * 模型常写成 `vitest.config.ts：lines 75 / branches 78` 或 `src/app.js:12`：
 * 全角冒号后的说明、`:12` / `:12:4` 行号都剥掉，留下文件名交给宿主 stat。
 * 抽不出合法路径时返回 null——不把说明文字当路径。
 */
export function extractLocalPathRef(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 1024 || /[\0\r\n]/.test(raw)) return null;
  let path = raw;
  const fullwidth = path.indexOf("：");
  if (fullwidth > 0) path = path.slice(0, fullwidth);
  const colonNote = path.search(/:\s/);
  if (colonNote > 0) path = path.slice(0, colonNote);
  path = path.split(/[。；，、]/)[0];
  path = path.replace(/:\d+(?::\d+)?$/, "").trim();
  if (!isLocalPathToken(path)) return null;
  return { path, raw };
}

function isLocalPathToken(s) {
  if (!s || s.length > 1024 || /[\0\r\n]/.test(s)) return false;
  if (/^(?:https?|data|javascript|mailto):/i.test(s)) return false;
  if (/^[.\\/]+$/.test(s)) return false;
  if (/^[A-Za-z]:[\\/]/.test(s)) return true;
  if (/^(?:\.{1,2}[\\/]|[\\/]).+/.test(s)) return true;
  if (/[\\/]/.test(s)) return !/[<>|?*。；，、]/.test(s);
  if (/^\.[A-Za-z0-9][\w.-]*$/.test(s)) return true;
  if (/^(?:README|LICENSE|Makefile|Dockerfile|AGENTS)(?:\.[\w.-]+)?$/i.test(s)) {
    return true;
  }
  return new RegExp(`^[^\\/:*?\"<>|]+\\.(?:${LOCAL_PATH_EXT})$`, "i").test(s);
}

/**
 * 行内代码里哪些值值得交给宿主做“本地路径是否存在”的只读探测。
 *
 * 这里只做低误报的语法初筛，**不决定它真的是路径**：最终是否升级成链接由
 * 服务端按该 run 的 workdir + stat 决定。像 `Math.max`、`npm run test` 仍是普通
 * 代码；目录、带分隔符的路径、常见文件名、常见工程扩展名，以及
 * `file.ts：说明` / `file.ts:12` 这类引用，才进入候选集。
 */
export function isLocalPathCandidate(value) {
  return extractLocalPathRef(value) != null;
}

/** 只放行 http/https —— javascript:/data: 等伪协议一律降级为纯文本 */
function safeHref(url) {
  const u = String(url).trim();
  return /^https?:\/\//i.test(u) ? u : null;
}

/**
 * 从已转义正文里拆出裸 URL 与尾标点。
 * 维基这类路径常带括号，不能一见 `)` 就剥；只剥多出来的右括号。
 */
function splitBareUrl(raw) {
  let url = String(raw);
  let trail = "";
  const marks = ".,;:!?。，；：、";
  while (url.length && marks.includes(url.slice(-1))) {
    trail = url.slice(-1) + trail;
    url = url.slice(0, -1);
  }
  while (url.endsWith(")") && (url.split("(").length - 1) < (url.split(")").length - 1)) {
    trail = `)${trail}`;
    url = url.slice(0, -1);
  }
  return { url, trail };
}

/**
 * 把正文里的裸 http(s) 网址收成可点链接。
 * 已有的 `[文字](链接)` / 插图必须先保护，否则会把 href 里的地址再链一次。
 */
function linkBareUrls(text) {
  const held = [];
  let s = text.replace(/<a\b[^>]*>[\s\S]*?<\/a>|<figure\b[\s\S]*?<\/figure>|<img\b[^>]*\/?>/gi, (m) => {
    held.push(m);
    return `A${held.length - 1}`;
  });
  s = s.replace(/https?:\/\/(?:[A-Za-z0-9\-._~:/?#\[\]@!$'()*+,;=%]|&amp;)+/gi, (raw) => {
    const { url, trail } = splitBareUrl(raw);
    const href = safeHref(url.replace(/&amp;/g, "&"));
    if (!href) return raw;
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(href)}</a>${trail}`;
  });
  return s.replace(/A(\d+)/g, (_, i) => held[Number(i)]);
}

/**
 * 是不是一处表格的开头：首行像 `| a | b |`，**且下一行是分隔行**（含 `-`）。
 *
 * 必须两行一起判——只看首行会把正文里带竖线的句子误判成表格。
 * 抽成函数是因为**两处都要用同一个判据**：表格分支要用它进入，段落收集要用它
 * 停下。两边判据一旦不一致，就会出现"段落把表格吃掉"或"谁都不处理导致空转"。
 */
function isTableStart(lines, i) {
  const head = lines[i];
  const sep = lines[i + 1];
  return (
    head !== undefined &&
    sep !== undefined &&
    /^\s*\|.*\|\s*$/.test(head) &&
    /^\s*\|[\s:|-]+\|\s*$/.test(sep) &&
    sep.includes("-")
  );
}

/** 行内记法。传入的 text 必须【已经转义过】 */
function inline(text) {
  let s = text;
  /**
   * 行内代码优先：它内部的其它记法不应再被解析，所以先摘出来占位、最后再放回。
   *
   * 占位符用 U+E000（私用区）而不是 NUL：NUL 让整个源文件在 git 眼里变成
   * **二进制**，`git diff` 从此只显示 "Bin 6147 -> 9150 bytes"，改动无从审阅。
   * 私用区字符同样不可能出现在模型正文里，却是合法文本。
   */
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push({ code, path: extractLocalPathRef(code)?.path ?? "" });
    return `C${codes.length - 1}`;
  });

  /**
   * 公式在粗体/斜体之前抽出：`\mathbf{h} * \left(` 里的 `*` 不是强调。
   * 行内代码已占位，围栏块走另一条路径，不会把代码里的 `\(` 当公式。
   */
  const math = holdMathInEscaped(s);
  s = math.text;

  /**
   * 图片：`![说明](https://img… "https://源页…")`
   * title 若是 http(s) 则作为源网页链接（咨询插图纪律）；否则退化为图本身。
   * 必须在普通链接之前匹配（否则 `![…](…)` 会先被链接触掉感叹号）。
   */
  s = s.replace(
    /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (whole, alt, url, title) => {
      const imgHref = safeHref(String(url).replace(/&amp;/g, "&"));
      if (!imgHref) return alt || whole;
      const sourceRaw = title ? String(title).replace(/&amp;/g, "&").trim() : "";
      const sourceHref = sourceRaw ? safeHref(sourceRaw) : null;
      const linkHref = sourceHref || imgHref;
      const caption = alt || (sourceHref ? "查看源网页" : "打开图片");
      return (
        `<figure class="md-figure">` +
        `<a class="md-figure-link" href="${escapeHtml(linkHref)}" target="_blank" rel="noopener noreferrer">` +
        `<img class="md-figure-img" src="${escapeHtml(imgHref)}" alt="${escapeHtml(alt || "")}" loading="lazy" referrerpolicy="no-referrer" />` +
        `</a>` +
        `<figcaption class="md-figure-cap">` +
        `<a href="${escapeHtml(linkHref)}" target="_blank" rel="noopener noreferrer">${caption}</a>` +
        (sourceHref && sourceHref !== imgHref
          ? ` · <a href="${escapeHtml(imgHref)}" target="_blank" rel="noopener noreferrer">原图</a>`
          : "") +
        `</figcaption></figure>`
      );
    },
  );

  // [文字](链接)：协议不合法时退化为纯文字，不产出 a 标签
  s = s.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (whole, label, url) => {
    // url 此时是转义后的串，&amp; 要还原回去才是真实地址
    const href = safeHref(url.replace(/&amp;/g, "&"));
    if (!href) return label || whole;
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label || escapeHtml(href)}</a>`;
  });

  // 模型经常直接甩出 https://…，不包 Markdown 链语法。行内代码已摘走，不会误链。
  s = linkBarePathCitations(linkBareUrls(s));

  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

  s = restoreHeldMath(s, math.held);

  return s.replace(/C(\d+)/g, (_, i) => {
    const item = codes[Number(i)];
    const attr = item.path ? ` data-local-path="${item.path}"` : "";
    return `<code${attr}>${item.code}</code>`;
  });
}

/**
 * 正文里没进反引号的文件引用也做成探测候选。
 * 只认「带目录分隔符」或「文件名 + 冒号说明/行号」——光一个 `index.html`
 * 不自动变链，避免普通句子误伤。已有的 a / code / 插图先保护。
 */
function linkBarePathCitations(text) {
  const held = [];
  const marked = String(text).replace(
    /<a\b[^>]*>[\s\S]*?<\/a>|<figure\b[\s\S]*?<\/figure>|<img\b[^>]*\/?>|<code\b[^>]*>[\s\S]*?<\/code>/gi,
    (m) => {
      held.push(m);
      return `T${held.length - 1}`;
    },
  );
  const linked = marked.replace(/[^\s<>]+/g, (token) => {
    let t = token;
    let trail = "";
    while (t && /[.,;!?。，、；]$/.test(t)) {
      trail = t.slice(-1) + trail;
      t = t.slice(0, -1);
    }
    const ref = extractLocalPathRef(t);
    if (!ref) return token;
    if (ref.path === t && !/[\\/]/.test(t)) return token;
    if (t.startsWith(ref.path) && t.length > ref.path.length) {
      return `<code data-local-path="${ref.path}">${ref.path}</code>${t.slice(ref.path.length)}${trail}`;
    }
    return `<code data-local-path="${ref.path}">${t}</code>${trail}`;
  });
  return linked.replace(/T(\d+)/g, (_, i) => held[Number(i)]);
}

/**
 * 渲染 Markdown 子集为安全 HTML。
 * 支持：标题、粗体/斜体/删除线、行内代码、围栏代码块、有序/无序列表、
 * 引用、分隔线、**GFM 表格**、**图片（含可选源页 title）**、段落、
 * **裸 http(s) 网址自动成链**、**文件引用（`file.ts：说明` / `src/a.ts:12`）挂探测标记**、
 * **TeX（`$…$` / `$$…$$` / `\(` `\)` / `\[` `\]`，含一层 `\\(` 反转义）走 KaTeX**。
 * **不支持原始 HTML（见上方安全纪律）。**
 * @param {string} src
 * @returns {string} 可直接 innerHTML 的 HTML 串
 */
export function renderMarkdown(src) {
  const text = escapeHtml(unescapeTexOutsideFences(src)).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const out = [];
  let i = 0;

  /** 收集连续满足 test 的行 */
  const take = (test) => {
    const buf = [];
    while (i < lines.length && test(lines[i])) buf.push(lines[i++]);
    return buf;
  };

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块：内部一律原样（已转义），不做任何行内解析
    const fence = line.match(/^\s*```(\S*)\s*$/);
    if (fence) {
      i++;
      const body = [];
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // 吃掉收尾围栏（缺失也不报错——模型经常写漏）
      /**
       * 代码块的外观（委托方："代码应该用代码的样式来显示，比如 VS 的那种代码主题"）。
       *
       * 高亮**在已转义的文本上做**——`highlight()` 只插入自己的 span，不碰实体，
       * 也不反转义（反转义就等于把死文本变回活标签，那是本文件整篇在防的事）。
       * 认不出语言就原样返回：**猜着高亮比不高亮更糟**。
       */
      const raw = fence[1] ?? "";
      const key = normalizeLang(raw);
      const langAttr = raw ? ` data-lang="${escapeHtml(raw)}"` : "";
      out.push(
        `<pre class="md-code${key ? ` md-code--${key}` : ""}"${langAttr}>` +
          `<code>${highlight(body.join("\n"), raw)}</code></pre>`,
      );
      continue;
    }

    const displayMath = matchDisplayMathBlock(lines, i);
    if (displayMath) {
      out.push(`<div class="md-math-block">${renderTexHtml(displayMath.tex, true)}</div>`);
      i = displayMath.end;
      continue;
    }

    if (/^\s*$/.test(line)) { i++; continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6); // h1→h3：页面里已有 h1/h2
      out.push(`<h${level} class="md-h">${inline(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      out.push('<hr class="md-hr">');
      i++;
      continue;
    }

    // 注意匹配的是 `&gt;` 而不是 `>`：入口已整体转义，源串里不再有裸的 `>`。
    // （初版写成 `/^\s*>/` 时引用块永远匹配不上——测试当场抓到。
    //  代价是这一处看着别扭，但"先转义再变换"那条安全纪律不能为了好看破例。）
    if (/^\s*&gt;\s?/.test(line)) {
      const quoted = take((l) => /^\s*&gt;\s?/.test(l)).map((l) => l.replace(/^\s*&gt;\s?/, ""));
      out.push(`<blockquote class="md-quote">${inline(quoted.join(" "))}</blockquote>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = take((l) => /^\s*[-*+]\s+/.test(l)).map((l) => l.replace(/^\s*[-*+]\s+/, ""));
      out.push(`<ul class="md-list">${items.map((t) => `<li>${inline(t)}</li>`).join("")}</ul>`);
      continue;
    }

    /**
     * GFM 表格。模型极爱用它做对照/清单，原样铺出来是一屏竖线，最难读的一类。
     *
     * 判据要两行一起看：首行是 `| a | b |`，**第二行必须是分隔行**
     * （`|---|:---:|`，至少含一个 `-`）。只看首行会把正文里带竖线的句子误判成表格。
     */
    if (isTableStart(lines, i)) {
      const sep = lines[i + 1];
      const cells = (l) =>
        l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const header = cells(line);
      const aligns = cells(sep).map((spec) => {
        const l = spec.startsWith(":");
        const r = spec.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : "";
      });
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));

      // 列数以表头为准：多的截掉、少的补空，避免残缺行把表格结构撑坏
      const styleOf = (n) => (aligns[n] ? ` style="text-align:${aligns[n]}"` : "");
      const cell = (tag, text, n) => `<${tag}${styleOf(n)}>${inline(text ?? "")}</${tag}>`;
      const head = `<tr>${header.map((h, n) => cell("th", h, n)).join("")}</tr>`;
      const body = rows
        .map((r) => `<tr>${header.map((_, n) => cell("td", r[n], n)).join("")}</tr>`)
        .join("");
      // 宽表自己横滚，不撑破布局（与代码块同款纪律）
      out.push(
        `<div class="md-table-wrap"><table class="md-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`,
      );
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = take((l) => /^\s*\d+[.)]\s+/.test(l)).map((l) => l.replace(/^\s*\d+[.)]\s+/, ""));
      out.push(`<ol class="md-list">${items.map((t) => `<li>${inline(t)}</li>`).join("")}</ol>`);
      continue;
    }

    /**
     * 段落：连续非空且不属于其它块的行合成一段，段内换行保留为 <br>。
     *
     * 这里必须**按索引**判而不是按行判：表格的界定要看下一行，
     * 而 `take` 的谓词只拿得到当前行。初版用行谓词排除所有 `|…|` 行，
     * 结果非表格的竖线行谁都不处理、`i` 不前进——**渲染器空转挂死**。
     * 下面那条 `para.length === 0` 是硬兜底：无论判据怎么演化，
     * 每轮循环都必须至少消费一行。
     */
    const para = [];
    while (i < lines.length) {
      const l = lines[i];
      if (
        /^\s*$/.test(l) ||
        /^\s*```/.test(l) ||
        /^#{1,6}\s/.test(l) ||
        /^\s*&gt;\s?/.test(l) ||
        /^\s*[-*+]\s+/.test(l) ||
        /^\s*\d+[.)]\s+/.test(l) ||
        /^\s*(---+|\*\*\*+|___+)\s*$/.test(l) ||
        isDisplayMathStart(l) ||
        (para.length > 0 && isTableStart(lines, i))
      ) {
        break;
      }
      para.push(lines[i++]);
    }
    if (para.length === 0) para.push(lines[i++]); // 绝不空转
    out.push(`<p class="md-p">${para.map((l) => inline(l.trim())).join("<br>")}</p>`);
  }

  return out.join("");
}

/**
 * 单行场景（裁决 summary、列表项这类）：只做行内记法，不产生块级标签。
 * 块级渲染会在本该是一行的地方塞进 `<p>`，把行高与对齐全打乱。
 */
export function renderMarkdownInline(src) {
  return inline(escapeHtml(unescapeTexDelimiters(src)).replace(/\n+/g, " "));
}

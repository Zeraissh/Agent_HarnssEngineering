/**
 * 极简语法高亮（零依赖）。
 *
 * 为什么手写：`ui/public/` 是零构建、零运行时依赖的原生 ES 模块，这条约束从
 * v1 起就在。而我们要的只是"代码看起来像代码"——注释、字符串、数字、关键字
 * 四类着色就已经拿到八成收益，真正的语言级解析（模板串嵌套、正则字面量、
 * JSX）收益递减而复杂度陡增。**不做的部分要说清楚，不能假装做了。**
 *
 * ================= 安全纪律（与 markdown.js 同源） =================
 * 输入是**已经转义过的**文本（markdown.js 在入口就把 & < > " ' 全转义了），
 * 所以这里绝不能再转义一次（否则 `&amp;lt;` 这种双重转义会显示成乱码），
 * 也绝不能反转义。本模块只做一件事：**在已转义的文本里插入自己的 span**。
 *
 * 由此得到一条硬约束：**分词只在已转义文本上进行**。`&lt;` 在这里是五个普通
 * 字符，不是一个尖括号——任何试图"还原成真实字符再分析"的做法都会把
 * 死文本变回活标签，那正是 markdown.js 整篇在防的事。
 */

/** 各语言的关键字。只收真的会在本项目里出现的那几种 */
const KEYWORDS = {
  ts: "abstract as async await break case catch class const continue declare default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while yield",
  js: "async await break case catch class const continue default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while yield",
  py: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield None True False self",
  c: "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while uint8_t uint16_t uint32_t int8_t int16_t int32_t bool",
  rs: "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true false type unsafe use where while",
  sh: "if then else elif fi for while do done case esac function return export local readonly set unset echo cd exit source",
  json: "true false null",
};

/** 语言别名 → 关键字表的键 */
const LANG_ALIAS = {
  typescript: "ts", ts: "ts", tsx: "ts",
  javascript: "js", js: "js", jsx: "js", mjs: "js",
  python: "py", py: "py",
  c: "c", h: "c", cpp: "c", "c++": "c", cc: "c",
  rust: "rs", rs: "rs",
  bash: "sh", sh: "sh", shell: "sh", zsh: "sh", console: "sh",
  json: "json",
};

/** 行注释前缀 */
const LINE_COMMENT = { ts: "//", js: "//", c: "//", rs: "//", py: "#", sh: "#", json: null };

export function normalizeLang(lang) {
  return LANG_ALIAS[String(lang ?? "").toLowerCase().trim()] ?? null;
}

/**
 * 给**已转义**的代码文本着色。
 *
 * 单趟扫描，优先级：注释 > 字符串 > 数字 > 关键字。
 * 这个顺序不是随意的——注释里的引号不该开字符串，字符串里的 `//` 不该开注释。
 * 反过来写就会在 `const url = "https://x"` 上把半行吃掉当注释（很常见的实现 bug）。
 *
 * @param {string} escaped 已由 markdown.js 转义过的源码
 * @param {string|null} lang 语言标记（```ts 里的那个）
 * @returns {string} 可直接 innerHTML 的 HTML
 */
export function highlight(escaped, lang) {
  const key = normalizeLang(lang);
  if (!key) return escaped; // 认不出语言就原样返回——**猜着高亮比不高亮更糟**
  const kw = new Set(KEYWORDS[key].split(/\s+/));
  const lineComment = LINE_COMMENT[key];
  const src = String(escaped);

  let out = "";
  let i = 0;
  const push = (cls, text) => {
    out += cls ? `<span class="hl-${cls}">${text}</span>` : text;
  };

  while (i < src.length) {
    const rest = src.slice(i);

    // ① 块注释（C 系）
    if (key !== "py" && key !== "sh" && rest.startsWith("/*")) {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      push("comment", src.slice(i, stop));
      i = stop;
      continue;
    }

    // ② 行注释
    if (lineComment && rest.startsWith(lineComment)) {
      const nl = src.indexOf("\n", i);
      const stop = nl === -1 ? src.length : nl;
      push("comment", src.slice(i, stop));
      i = stop;
      continue;
    }

    // ③ 字符串。注意引号在转义后是 `&quot;` / `&#39;`，不是 " 和 '——
    //    直接找裸引号会一个都匹配不上（markdown.js 那条引用块 bug 的同款陷阱）
    const q = matchQuote(src, i);
    if (q) {
      push("str", src.slice(i, q.end));
      i = q.end;
      continue;
    }

    // ④ 数字（含十六进制与后缀，如 0x1F / 1e-3 / 1u）
    const num = /^(0[xXbB][0-9a-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)[uUlLfF]*/.exec(rest);
    if (num && !isWordChar(src[i - 1])) {
      push("num", num[0]);
      i += num[0].length;
      continue;
    }

    // ⑤ 标识符 → 是关键字才着色
    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word) {
      push(kw.has(word[0]) ? "kw" : null, word[0]);
      i += word[0].length;
      continue;
    }

    // ⑥ 其余原样（包括 `&lt;` 这类实体——它们在这里就是普通字符）
    out += src[i];
    i += 1;
  }
  return out;
}

/** 转义后的引号形态：`&quot;` / `&#39;` / 反引号（反引号不被转义） */
const QUOTES = ["&quot;", "&#39;", "`"];

function matchQuote(src, i) {
  const open = QUOTES.find((q) => src.startsWith(q, i));
  if (!open) return null;
  let j = i + open.length;
  while (j < src.length) {
    // 反斜杠转义：跳过下一个字符（它可能本身就是引号实体的开头）
    if (src[j] === "\\") {
      j += 1;
      const nextQuote = QUOTES.find((q) => src.startsWith(q, j));
      j += nextQuote ? nextQuote.length : 1;
      continue;
    }
    if (src.startsWith(open, j)) return { end: j + open.length };
    // 未闭合的字符串不跨行吞掉整段——流式渲染时半截代码很常见
    if (src[j] === "\n" && open !== "`") return { end: j };
    j += 1;
  }
  return { end: src.length };
}

function isWordChar(c) {
  return Boolean(c) && /[\w$]/.test(c);
}

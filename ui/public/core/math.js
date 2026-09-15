/**
 * TeX 分隔符抽取与 KaTeX 渲染。
 *
 * 对话 Markdown 与 HTML 产物预览共用这一份：模型常把 `\(` 写成 `\\(`，
 * 界面若原样铺出来就是一屏反斜杠。只对成对的 TeX 分隔符剥一层，
 * **不动** `C:\Users` 这类 Windows 路径。
 *
 * KaTeX 本身不进本模块的 import——`ui/public` 是零构建 ESM，浏览器经
 * `/vendor/katex/katex.min.js` 挂到 `globalThis.katex`；单测同样挂上去。
 * 信任默认关（trust:false），坏公式 throwOnError:false，不把模型输入当 HTML。
 */

const BS = "\\";
const DBL_OPEN_BRACKET = BS + BS + "[";
const DBL_CLOSE_BRACKET = BS + BS + "]";
const DBL_OPEN_PAREN = BS + BS + "(";
const DBL_CLOSE_PAREN = BS + BS + ")";
const SGL_OPEN_BRACKET = BS + "[";
const SGL_CLOSE_BRACKET = BS + "]";
const SGL_OPEN_PAREN = BS + "(";
const SGL_CLOSE_PAREN = BS + ")";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

export const KATEX_CSS_HREF = "/vendor/katex/katex.min.css";
export const KATEX_JS_HREF = "/vendor/katex/katex.min.js";
export const KATEX_AUTO_HREF = "/vendor/katex/contrib/auto-render.min.js";
export const KATEX_RUNTIME_HREF = "/core/katex-preview-runtime.js";

export const KATEX_AUTO_OPTS = {
  delimiters: [
    { left: "$$", right: "$$", display: true },
    { left: SGL_OPEN_BRACKET, right: SGL_CLOSE_BRACKET, display: true },
    { left: SGL_OPEN_PAREN, right: SGL_CLOSE_PAREN, display: false },
    { left: "$", right: "$", display: false },
  ],
  throwOnError: false,
  trust: false,
  ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
};

/**
 * 只对成对的 `\\[` / `\\(` 剥一层，变成 `\[` / `\(`。
 * `C:\\Users` 不成对，原样返回。
 */
export function unescapeTexDelimiters(src) {
  const s = String(src ?? "");
  const once = replacePaired(s, DBL_OPEN_BRACKET, DBL_CLOSE_BRACKET, SGL_OPEN_BRACKET, SGL_CLOSE_BRACKET);
  return replacePaired(once, DBL_OPEN_PAREN, DBL_CLOSE_PAREN, SGL_OPEN_PAREN, SGL_CLOSE_PAREN);
}

/** 围栏代码里的 `\\(` 是字面量，不剥。 */
export function unescapeTexOutsideFences(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    out.push(inFence ? line : unescapeTexDelimiters(line));
  }
  return out.join("\n");
}

function replacePaired(s, dblOpen, dblClose, singleOpen, singleClose) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s.startsWith(dblOpen, i)) {
      const end = s.indexOf(dblClose, i + dblOpen.length);
      if (end !== -1) {
        out += singleOpen + s.slice(i + dblOpen.length, end) + singleClose;
        i = end + dblClose.length;
        continue;
      }
    }
    out += s[i];
    i += 1;
  }
  return out;
}

export function unescapeHtmlEntities(s) {
  return String(s ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function htmlHasTexDelimiters(html) {
  const s = String(html ?? "");
  if (
    s.includes("$$") ||
    s.includes(SGL_OPEN_BRACKET) ||
    s.includes(SGL_OPEN_PAREN) ||
    s.includes(DBL_OPEN_BRACKET) ||
    s.includes(DBL_OPEN_PAREN)
  ) {
    return true;
  }
  return hasPairedDollarMath(s);
}

export function pageHasMathRenderer(html) {
  const s = String(html ?? "");
  if (/<(?:script|link)\b[^>]*(?:katex|mathjax|MathJax)/i.test(s)) return true;
  if (/__agentKatexHooked/.test(s)) return true;
  if (/\b(?:renderMathInElement|tex2jax)\b/.test(s)) return true;
  return false;
}

function getKatex() {
  return globalThis.katex ?? null;
}

export function renderTexHtml(tex, displayMode) {
  const raw = String(tex ?? "");
  const katex = getKatex();
  if (!katex?.renderToString) {
    const cls = displayMode ? "md-math md-math--display md-math--fallback" : "md-math md-math--inline md-math--fallback";
    return `<span class="${cls}">${escapeHtml(raw)}</span>`;
  }
  try {
    return katex.renderToString(raw, {
      displayMode: Boolean(displayMode),
      throwOnError: false,
      trust: false,
      strict: "ignore",
      maxSize: 20,
      maxExpand: 1000,
      output: "html",
    });
  } catch {
    return `<span class="md-math md-math--error">${escapeHtml(raw)}</span>`;
  }
}

function isOddEscaped(s, i) {
  let n = 0;
  for (let j = i - 1; j >= 0 && s[j] === BS; j -= 1) n += 1;
  return n % 2 === 1;
}

function isCurrencyLike(tex) {
  return /^\d[\d.,]*$/.test(String(tex).trim());
}

function replaceDelimited(s, open, close, onBody) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s.startsWith(open, i) && !isOddEscaped(s, i)) {
      const end = s.indexOf(close, i + open.length);
      if (end !== -1 && end >= i + open.length) {
        const body = s.slice(i + open.length, end);
        if (body.length > 0 || open === "$$") {
          out += onBody(body);
          i = end + close.length;
          continue;
        }
      }
    }
    out += s[i];
    i += 1;
  }
  return out;
}

/** `$…$` 成对且不像货币时才算公式。`$100` / `cost$x` 不算。 */
function hasPairedDollarMath(s) {
  let found = false;
  replaceDollarMath(s, () => {
    found = true;
    return "";
  });
  return found;
}

function replaceDollarMath(s, onBody) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "$" && s[i + 1] !== "$" && !isOddEscaped(s, i)) {
      const prev = s[i - 1];
      if (prev && /[A-Za-z0-9]/.test(prev)) {
        out += "$";
        i += 1;
        continue;
      }
      let j = i + 1;
      let consumed = false;
      while (j < s.length && s[j] !== "\n") {
        if (s[j] === "$" && !isOddEscaped(s, j)) {
          const tex = s.slice(i + 1, j);
          if (tex && !isCurrencyLike(tex) && !/^\s/.test(tex) && !/\s$/.test(tex)) {
            out += onBody(tex);
            i = j + 1;
            consumed = true;
          }
          break;
        }
        j += 1;
      }
      if (!consumed) {
        out += "$";
        i += 1;
      }
      continue;
    }
    out += s[i];
    i += 1;
  }
  return out;
}

/**
 * 在【已转义】的行内文本里抽出公式，换成私用区占位。
 * 调用方做完粗体/链接后再 `restoreHeldMath`。
 */
export function holdMathInEscaped(escaped) {
  const held = [];
  const hold = (tex, display) => {
    held.push({ tex: unescapeHtmlEntities(tex), display: Boolean(display) });
    return `K${held.length - 1}`;
  };
  let s = String(escaped ?? "");
  s = replaceDelimited(s, "$$", "$$", (body) => hold(body, true));
  s = replaceDelimited(s, SGL_OPEN_BRACKET, SGL_CLOSE_BRACKET, (body) => hold(body, true));
  s = replaceDelimited(s, SGL_OPEN_PAREN, SGL_CLOSE_PAREN, (body) => hold(body, false));
  s = replaceDollarMath(s, (body) => hold(body, false));
  return { text: s, held };
}

export function restoreHeldMath(text, held) {
  return String(text ?? "").replace(/K(\d+)/g, (_, i) => {
    const item = held[Number(i)];
    if (!item) return "";
    return renderTexHtml(item.tex, item.display);
  });
}

function trimMathBody(parts) {
  return parts.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
}

function collectUntil(lines, i, openRe, closeRe) {
  const first = lines[i].replace(openRe, "");
  const body = [first];
  let j = i + 1;
  while (j < lines.length) {
    const m = lines[j].match(closeRe);
    if (m) {
      body.push(m[1]);
      return { end: j + 1, tex: trimMathBody(body) };
    }
    body.push(lines[j]);
    j += 1;
  }
  return { end: j, tex: trimMathBody(body) };
}

/** 行首 `$$` / `\[` 的块级公式（可跨行）。输入是已转义的行。 */
export function matchDisplayMathBlock(lines, i) {
  const line = lines[i];
  if (line === undefined) return null;
  const oneDollar = line.match(/^\s*\$\$([\s\S]*?)\$\$\s*$/);
  if (oneDollar) return { end: i + 1, tex: unescapeHtmlEntities(oneDollar[1]) };
  const oneBrack = line.match(/^\s*\\\[([\s\S]*?)\\\]\s*$/);
  if (oneBrack) return { end: i + 1, tex: unescapeHtmlEntities(oneBrack[1]) };
  if (/^\s*\$\$/.test(line)) {
    const hit = collectUntil(lines, i, /^\s*\$\$/, /^(.*)\$\$\s*$/);
    return { end: hit.end, tex: unescapeHtmlEntities(hit.tex) };
  }
  if (/^\s*\\\[/.test(line)) {
    const hit = collectUntil(lines, i, /^\s*\\\[/, /^(.*)\\\]\s*$/);
    return { end: hit.end, tex: unescapeHtmlEntities(hit.tex) };
  }
  return null;
}

export function isDisplayMathStart(line) {
  return /^\s*(?:\$\$|\\\[)/.test(String(line ?? ""));
}

const SKIP_UNESCAPE_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE", "PRE", "KBD", "SAMP"]);

export function unescapeTexInElement(root) {
  if (!root) return;
  const doc = root.nodeType === 9 ? root : root.ownerDocument;
  const walkerRoot = root.nodeType === 9 ? (root.body || root.documentElement) : root;
  if (!walkerRoot || !doc?.createTreeWalker) return;
  const walker = doc.createTreeWalker(walkerRoot, 4 /* NodeFilter.SHOW_TEXT */);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const tag = n.parentElement?.tagName;
    if (tag && SKIP_UNESCAPE_TAGS.has(tag)) continue;
    const next = unescapeTexDelimiters(n.nodeValue ?? "");
    if (next !== n.nodeValue) n.nodeValue = next;
  }
}

export function typesetDom(root) {
  if (!root) return;
  unescapeTexInElement(root);
  const render = globalThis.renderMathInElement;
  if (typeof render === "function") {
    render(root, KATEX_AUTO_OPTS);
  }
}

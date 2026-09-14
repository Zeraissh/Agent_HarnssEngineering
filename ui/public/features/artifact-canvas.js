/**
 * features/artifact-canvas — 产物画布（T10）。
 *
 * 零依赖原生 ESM。把右栏「产物」文件列表升级为可预览的工作台：
 * 点产物卡的「预览/打开」后，默认在主区右侧拉出**停靠面板**（对话保持可见、
 * 可继续交互；外壳共用 features/preview-dock.js），顶条「放大」可扩到整个主区；
 * 按类型分派渲染器，hash 深链 `#/run/<id>/artifact/<index>`（放大态 `?full`）
 * 可刷新恢复。运行中写盘工具再次触碰当前预览路径时，面板防抖自动刷新——
 * agent 流式改网站，用户在右侧直接看到效果。
 *
 * 与 command-palette / notifications / memory-panel / settings 同一约定：
 *   1) 纯函数层（类型分派 / CSV 解析 / 路由编解码 / 字节格式化）——可单测；
 *   2) DOM 层 initArtifactCanvas(host, env)——宿主（index.html 内联控制器）
 *      注入回调与数据，本模块不反向 import 宿主任何东西；
 *   3) hash 路由归宿主所有：画布只报「我要关掉」「我要切到第 N 个」，
 *      写 location.hash 的是宿主（写完后 hashchange 绕回来调 open）。
 *
 * ================= 安全边界（本模块最重要的一段注释） =================
 * 产物是模型生成的**不可信内容**，防线分两层：
 *   - 单文件扫一眼（/api/runs/:id/artifact）：CSP 禁脚本；下载仍走此通道；
 *   - HTML 预览一律整站（/api/runs/:id/site/*）：路径式取件让相对 CSS/JS 可解析，
 *     CSP 允许同源脚本；点评用 `?inspect=1` 由服务端注入点选钩子（不剥页面脚本）；
 *   - iframe `sandbox="allow-scripts"`：**故意不给 allow-same-origin**。给了它，
 *     产物脚本就能读宿主 localStorage、调同源 /api/*；不给则是无源文档，脚本
 *     即使绕过 CSP 也碰不到宿主。两层独立，各自失效时另一层仍在。
 *     翻页不读 contentDocument：chrome 只 postMessage，可见性由 /site 注入的
 *     deck runtime 在 iframe 里改 class/hidden。不为此放开 same-origin。
 *   - 无源文档对 Permissions-Policy 不是 `'src'`。缺 `allow="webgl *"` 时，
 *     three.js 的 `getContext` 会在页内预览里变 null，产物就弹出
 *     「这台设备没有可用的 WebGL」——同一份 HTML 在系统 Chrome 顶层打开却正常。
 *     `allow` 只授权 GPU，不放开 same-origin。
 * 文本类产物（Markdown / 代码 / CSV）一律经 core/markdown.js 与
 * core/highlight.js 渲染——它们遵守「先整体转义，再做变换」纪律，本模块
 * 绝不把产物原文直接塞进 innerHTML。
 */

import { renderMarkdown } from "../core/markdown.js";
import { highlight, normalizeLang } from "../core/highlight.js";
import { createPreviewDock } from "./preview-dock.js";
import {
  attachImageAnnotator,
  formatImageReview,
  formatReviewComment,
  isInspectPick,
  isWebglStatus,
  DECK_READY_MESSAGE_TYPE,
  DECK_GOTO_MESSAGE_TYPE,
  DECK_STATE_MESSAGE_TYPE,
} from "./review-mode.js";

// ---------------------------------------------------------------
// 常量
// ---------------------------------------------------------------

/** CSV 表格最多渲染的行数（超出截断并标注） */
export const CSV_MAX_ROWS = 200;
/** 文本类产物最多读入的字符数（超出截断并标注，防一份超大日志卡死渲染） */
export const TEXT_MAX_CHARS = 400_000;

/**
 * HTML 预览沙箱：有脚本、无 same-origin（无源文档，碰不到宿主 /api）。
 * 浏览器页才额外给 same-origin，见 PREVIEW_BROWSER_SANDBOX。
 */
export const PREVIEW_HTML_SANDBOX = "allow-scripts";
export const PREVIEW_BROWSER_SANDBOX =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-downloads";
/**
 * 无源 iframe 的文档 origin 是 opaque。`allow="webgl"` 默认 allowlist 是 `'src'`，
 * 对不上 opaque origin，WebGL 仍被 Permissions-Policy 挡住。必须 `*`。
 */
export const PREVIEW_IFRAME_ALLOW = "webgl *; xr-spatial-tracking *";

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
const HTML_EXT_RE = /\.html?$/i;
const MARKDOWN_EXT_RE = /\.(md|mdx|markdown)$/i;
const CSV_EXT_RE = /\.(csv|tsv)$/i;
const CODE_EXT_RE =
  /\.(css|scss|less|jsx?|mjs|cjs|tsx?|json|py|c|h|cc|cpp|cxx|hpp|cs|java|go|rs|sh|ps1|bat|cmd|ya?ml|toml|ini|xml|sql|vue|svelte)$/i;
const TEXT_EXT_RE = /\.(txt|log|env|rst|adoc)$/i;
const PPTX_EXT_RE = /\.pptx$/i;
const DOCX_EXT_RE = /\.docx$/i;

/** 预览 + 点评 + 对话改稿。不是「我们不做 Office」，也不是 Microsoft 就地编辑。 */
export const OFFICE_PREVIEW_NOTE =
  "预览 + 点评 + 对话改稿：翻页看内容，点评写进输入框，模型用 write_pptx / 源文件改稿。不是 Microsoft Office 就地编辑。";

export function isOfficeKind(kind) {
  return kind === "pptx" || kind === "docx";
}

/** 代码扩展名 → 高亮语言（highlight.js 的 normalizeLang 认得别名，这里给到粗粒度即可） */
const CODE_LANG = {
  js: "js", mjs: "js", cjs: "js", jsx: "js",
  ts: "ts", tsx: "ts",
  py: "py", c: "c", h: "c", cc: "c", cpp: "c", cxx: "c", hpp: "c",
  rs: "rs", go: "go", java: "java", cs: "cs",
  sh: "sh", ps1: "sh", bat: "sh", cmd: "sh",
  json: "json", css: "css", scss: "css", less: "css",
  yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini", xml: "xml", sql: "sql",
};

// ---------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------

/**
 * 类型分派：产物路径 → 渲染器种类。
 * 判据是**扩展名**而不是 Content-Type：服务端对源码统一回 text/plain，
 * 对未知类型回 octet-stream，都不足以区分「代码高亮」与「纯文本」。
 * @param {string} path
 * @returns {"html"|"image"|"markdown"|"csv"|"code"|"text"|"pptx"|"docx"|"binary"}
 */
/** 预览清单里的 http(s) 项：内置浏览器标签，不是本地文件。 */
export function isBrowserPreviewPath(path) {
  return /^https?:\/\//i.test(String(path ?? "").trim());
}

/**
 * 地址栏输入 → 可打开的 http(s) 网址。缺协议时补 https。
 * javascript: / data: / file: 一律拒绝。
 * @param {string} input
 * @returns {string|null}
 */
export function parseBrowserUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  let href = raw;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) href = `https://${href}`;
  let url;
  try { url = new URL(href); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return url.href;
}

/** 标签上显示主机名，完整网址放 title */
export function browserTabLabel(url) {
  try {
    const host = new URL(String(url ?? "")).hostname.replace(/^www\./, "");
    return host || String(url ?? "");
  } catch {
    return String(url ?? "");
  }
}

/** 标签文案：网站用站点名，本地文件用路径。 */
export function previewTabLabel(path) {
  const raw = String(path ?? "");
  return isBrowserPreviewPath(raw) ? browserTabLabel(raw) : raw;
}

/** 地址栏展示：网站用站点名，本地文件用路径。聚焦网址时再展开成完整 URL。 */
export function previewAddressValue(path) {
  const raw = String(path ?? "");
  return isBrowserPreviewPath(raw) ? browserTabLabel(raw) : raw;
}

export function artifactRendererKind(path) {
  if (isBrowserPreviewPath(path)) return "browser";
  const clean = String(path ?? "").split(/[?#]/)[0].replace(/\\/g, "/");
  if (HTML_EXT_RE.test(clean)) return "html";
  if (IMAGE_EXT_RE.test(clean)) return "image";
  if (MARKDOWN_EXT_RE.test(clean)) return "markdown";
  if (CSV_EXT_RE.test(clean)) return "csv";
  if (CODE_EXT_RE.test(clean)) return "code";
  if (TEXT_EXT_RE.test(clean)) return "text";
  if (PPTX_EXT_RE.test(clean)) return "pptx";
  if (DOCX_EXT_RE.test(clean)) return "docx";
  return "binary";
}

/** 画布顶条的类型徽章文案（与 app.js artifactKindLabel 同族但按渲染器归并） */
export function rendererKindLabel(kind, { deck = false } = {}) {
  if (kind === "html" && deck) return "幻灯";
  switch (kind) {
    case "html": return "网站";
    case "browser": return "网页";
    case "image": return "图片";
    case "markdown": return "Markdown";
    case "csv": return "表格";
    case "code": return "代码";
    case "text": return "文本";
    case "pptx": return "幻灯";
    case "docx": return "文档";
    default: return "文件";
  }
}

/**
 * 产物画布：会话内 Office 预览 JSON。
 * @param {string} runId
 * @param {string} path
 */
export function officePreviewUrl(runId, path) {
  return `/api/runs/${encodeURIComponent(runId)}/office-preview?path=${encodeURIComponent(path)}`;
}

/**
 * 文件预览覆盖层：从取件 URL 抄 workdir，改走 /api/office-preview。
 * @param {string} path
 * @param {string} fileUrl
 */
export function officePreviewUrlFromFileUrl(path, fileUrl) {
  try {
    const u = new URL(String(fileUrl ?? ""), "http://local.invalid");
    const q = new URLSearchParams();
    q.set("path", String(path ?? ""));
    const wd = u.searchParams.get("workdir");
    if (wd) q.set("workdir", wd);
    return `/api/office-preview?${q.toString()}`;
  } catch {
    return `/api/office-preview?path=${encodeURIComponent(String(path ?? ""))}`;
  }
}

/**
 * 翻到 Office 预览的第 index 页（0-based）。返回是否切成功。
 * @param {HTMLElement} root
 * @param {number} index
 */
export function showOfficePage(root, index) {
  if (!root) return false;
  const pages = [...root.querySelectorAll(".ac-office-page")];
  if (pages.length === 0) return false;
  const next = Math.max(0, Math.min(pages.length - 1, Number(index) || 0));
  root.dataset.index = String(next);
  pages.forEach((el, i) => {
    el.hidden = i !== next;
  });
  const pos = root.querySelector(".ac-office-pos");
  if (pos) pos.textContent = `${next + 1} / ${pages.length}`;
  root.querySelectorAll(".ac-office-num").forEach((btn, i) => {
    btn.setAttribute("aria-pressed", i === next ? "true" : "false");
    btn.classList.toggle("is-active", i === next);
  });
  const prev = root.querySelector(".ac-office-prev");
  const nxt = root.querySelector(".ac-office-next");
  if (prev) prev.disabled = pages.length < 2;
  if (nxt) nxt.disabled = pages.length < 2;
  return true;
}

/**
 * 代码产物的高亮语言。非代码返回 ""。
 * @param {string} path
 * @returns {string}
 */
export function artifactCodeLang(path) {
  const clean = String(path ?? "").split(/[?#]/)[0];
  const m = /\.([a-z0-9]+)$/i.exec(clean);
  if (!m) return "";
  return CODE_LANG[m[1].toLowerCase()] ?? "";
}

/**
 * 极简 CSV/TSV 解析（约 20 行）：支持引号字段、字段内 `""` 转义、CRLF、
 * 字段内换行（引号包住时）。分隔符自动探测——首行里出现 Tab 而没有逗号时按
 * TSV 处理。不是全量 RFC 4180：够渲染模型写出的表格，不假装是。
 *
 * @param {string} text
 * @param {{ maxRows?:number }} [opts]
 * @returns {{ rows:string[][], truncated:boolean, totalRows:number }}
 */
export function parseCsv(text, opts = {}) {
  const maxRows = opts.maxRows ?? CSV_MAX_ROWS;
  const src = String(text ?? "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
  /** @type {string[][]} */
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  let i = 0;
  const pushRow = () => {
    row.push(field);
    field = "";
    // 末尾空行（结尾换行）不产出空行记录
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"' && field === "") { inQuotes = true; i += 1; continue; }
    if (ch === delim) { row.push(field); field = ""; i += 1; continue; }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      i += 1;
      pushRow();
      continue;
    }
    field += ch; i += 1;
  }
  // 收尾：最后一个字段/行（无结尾换行时）
  if (field !== "" || row.length > 0) pushRow();
  const totalRows = rows.length;
  return { rows: rows.slice(0, maxRows), truncated: totalRows > maxRows, totalRows };
}

/**
 * 路由编码：`#/run/<id>/artifact/<index>`，放大态追加 `?full`。
 * index 是宿主产物清单里的 0 基序号。
 * @param {string} runId
 * @param {number} index
 * @param {{ full?:boolean }} [opts]
 * @returns {string}
 */
export function encodeArtifactHash(runId, index, opts = {}) {
  const base = `#/run/${encodeURIComponent(String(runId ?? ""))}/artifact/${Math.max(0, Math.trunc(index))}`;
  return opts?.full ? `${base}?full` : base;
}

/**
 * 关掉产物预览时的落点。必须是会话页，不能 history.back()——
 * 左右切过文件后，后退会退到上一份预览而不是关掉坞。
 */
export function artifactExitHash(runId, tab = "loop") {
  if (!runId) return "#/";
  const face = String(tab || "loop");
  return `#/run/${encodeURIComponent(String(runId))}/${face}`;
}

const ARTIFACT_ROUTE_RE = /^#\/run\/([^/]+)\/artifact\/(\d+)(?:[/?].*)?$/;

/**
 * 路由解码。不匹配返回 null；index 越界不归这里管（清单在宿主手里）。
 * full：hash 带 `?full` / `&full` 时为 true（放大态深链，刷新保持形态）。
 * @param {string} hash location.hash
 * @returns {{ runId:string, index:number, full:boolean }|null}
 */
export function parseArtifactRoute(hash) {
  const m = ARTIFACT_ROUTE_RE.exec(String(hash ?? ""));
  if (!m) return null;
  let runId = m[1];
  try { runId = decodeURIComponent(runId); } catch { /* 非法转义时保留原样 */ }
  return {
    runId,
    index: Number.parseInt(m[2], 10),
    full: /[?&]full(?:&|=|$)/.test(String(hash ?? "")),
  };
}

/** @param {string} hash @returns {boolean} */
export function isArtifactRoute(hash) {
  return parseArtifactRoute(hash) !== null;
}

/**
 * 序号钳制与循环：◀ ▶ 在多产物间循环切换。
 * @param {number} index @param {number} count
 * @returns {number} count 为 0 时返回 -1
 */
export function wrapIndex(index, count) {
  if (!Number.isFinite(count) || count <= 0) return -1;
  return ((Math.trunc(index) % count) + count) % count;
}

/**
 * 关掉一只标签后该落在哪一格。remaining 是关掉之后的只数。
 * 关当前 → 同序号滑过来的下一只，没有就前一只；关左边 → 当前序号减一；关右边不动。
 * @param {number} current
 * @param {number} closed
 * @param {number} remaining
 * @returns {number} 没有剩余时 -1
 */
export function indexAfterCloseTab(current, closed, remaining) {
  if (!Number.isFinite(remaining) || remaining <= 0) return -1;
  if (!Number.isFinite(closed) || closed < 0) return -1;
  if (closed === current) return Math.min(closed, remaining - 1);
  if (closed < current) return current - 1;
  return current;
}

/**
 * 字节数人性化。未知（null/undefined/负数）返回 "—"，由调用方决定摆不摆。
 * @param {number|null|undefined} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 文件名（画面对外只显示 basename，完整路径放 title） */
export function artifactBasename(path) {
  const s = String(path ?? "").replace(/\\/g, "/");
  return s.split("/").pop() || s;
}

/** 产物清单里已写出的 Office 文件。只认扩展名，不解析 OOXML。 */
export const OFFICE_EXPORT_EXT_RE = /\.(pptx|pdf)$/i;

/**
 * 从产物清单抽出已存在的 .pptx / .pdf。
 * 只列文件，不假装已经转好；幻灯转换是导出按钮的副作用。
 * @param {Array<{ path?: string }|string>|null|undefined} list
 * @returns {string[]}
 */
export function officeExportPaths(list) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const raw = typeof item === "string" ? item : String(item?.path ?? "");
    const path = raw.replace(/\\/g, "/").trim();
    const clean = path.split(/[?#]/)[0];
    if (!OFFICE_EXPORT_EXT_RE.test(clean)) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

/** 与 HTML 同目录的派生 .pptx 相对路径。 */
export function pptxPathForHtml(htmlPath) {
  return String(htmlPath ?? "").replace(/\\/g, "/").replace(/\.html?$/i, "") + ".pptx";
}

/** 与 HTML 同茎的派生 PNG：一张 stem.png，多张 stem-1.png… */
export function pngPathsForHtml(htmlPath, count) {
  const stem = String(htmlPath ?? "").replace(/\\/g, "/").replace(/\.html?$/i, "");
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n <= 0) return [];
  if (n === 1) return [`${stem}.png`];
  return Array.from({ length: n }, (_, i) => `${stem}-${i + 1}.png`);
}

/**
 * 整站预览 URL：路径段编码，保证 HTML 内 `./style.css` 解析到同目录资源。
 * 与服务端 `sitePreviewUrl` 同口径（前端自包含，不 import 宿主）。
 */
export function siteArtifactUrl(runId, path) {
  const normalized = String(path ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
  if (!normalized) return "";
  const segments = normalized.split("/").map((seg) => encodeURIComponent(seg)).join("/");
  return `/api/runs/${encodeURIComponent(runId)}/site/${segments}`;
}

/**
 * 从 DESIGN.md 抽出色板/字体（与 ui/design-templates.ts 同口径，前端自包含）。
 * @param {string} md
 * @returns {{ colors: {name:string,value:string}[], fonts: {name:string,value:string}[] }}
 */
export function parseDesignPalette(md) {
  const colors = [];
  const fonts = [];
  let section = /** @type {null|"colors"|"fonts"} */ (null);
  const seenColor = new Set();
  const seenFont = new Set();
  for (const line of String(md ?? "").split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      const h = heading[1].toLowerCase();
      if (/色板|color|palette/.test(h)) section = "colors";
      else if (/字体|font|type/.test(h)) section = "fonts";
      else section = null;
      continue;
    }
    const m = line.match(/^[-*]\s*([A-Za-z0-9_-]+)\s*[:：]\s*(.+?)\s*$/);
    if (!m) continue;
    const name = m[1];
    const value = m[2].replace(/^`+|`+$/g, "").trim();
    if (!value) continue;
    if (section === "fonts") {
      if (seenFont.has(name)) continue;
      seenFont.add(name);
      fonts.push({ name, value });
      continue;
    }
    if (section !== "colors") continue;
    const colorMatch = value.match(/^(#[0-9A-Fa-f]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\))$/);
    if (colorMatch) {
      if (seenColor.has(name)) continue;
      seenColor.add(name);
      colors.push({ name, value: colorMatch[1] });
    }
  }
  return { colors, fonts };
}

/** 运行中内容自动刷新的防抖间隔：打字机/批处理节拍下一阵写入只触发一次重拉 */
export const REFRESH_DEBOUNCE_MS = 500;

/**
 * 事件流里的写入路径与预览路径是否指同一文件。
 * 规范化：反斜杠归一、剥掉开头 "./"。不做大小写折叠——产物清单与工具
 * 入参同源（同一份事件流），过度宽松会把 "out/A.html" 与 "out/a.html" 误判同一件。
 * @param {string} a @param {string} b
 * @returns {boolean}
 */
export function pathsMatch(a, b) {
  const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
  const x = norm(a);
  const y = norm(b);
  return x !== "" && x === y;
}

// ---------------------------------------------------------------
// 渲染层（产物画布与文件预览覆盖层共用——分派/截断/沙箱/转义纪律只有一份）
// ---------------------------------------------------------------

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** 模块内转义：与 core/markdown.js 入口同一纪律——产物原文绝不直接进 innerHTML */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/** 文本读入后的公共截断：超大文件只画头部，标注出来 */
function clipPreviewText(text) {
  const t = String(text ?? "");
  if (t.length <= TEXT_MAX_CHARS) return { text: t, clipped: false };
  return { text: t.slice(0, TEXT_MAX_CHARS), clipped: true };
}

function renderPreviewErrorCard(body, message) {
  body.innerHTML =
    `<div class="ac-fallback">` +
    `<i class="ph ph-warning-circle ac-fallback-icon" aria-hidden="true"></i>` +
    `<p class="ac-fallback-text">${esc(message)}</p>` +
    `</div>`;
}

/**
 * 把 Office 预览 JSON 画进容器：每页一篇，自带翻页 chrome。
 * @param {HTMLElement} body
 * @param {{ kind?:string, pages?:{ index?:number, title?:string, texts?:string[], images?:{ name?:string, mime?:string, dataUrl?:string }[] }[] }} preview
 * @param {{ inspect?:boolean }} [opts]
 */
export function paintOfficePreview(body, preview, opts = {}) {
  const pages = Array.isArray(preview?.pages) ? preview.pages : [];
  const kind = preview?.kind === "docx" ? "docx" : "pptx";
  const pageBits = pages.map((page, i) => {
    const texts = Array.isArray(page?.texts) ? page.texts : [];
    const images = Array.isArray(page?.images) ? page.images : [];
    const title = String(page?.title ?? texts[0] ?? `第 ${i + 1} 页`);
    const rest = texts.filter((t) => t && t !== title);
    const imgBits = images
      .filter((img) => img?.dataUrl && String(img.dataUrl).startsWith("data:image/"))
      .map((img) => `<img class="ac-office-img" src="${esc(img.dataUrl)}" alt="${esc(img.name || title)}" />`)
      .join("");
    const list = rest.length
      ? `<ul class="ac-office-texts">${rest.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`
      : "";
    return (
      `<article class="ac-office-page" data-slide="${i + 1}"${i === 0 ? "" : " hidden"}>` +
      `<h2 class="ac-office-title">${esc(title)}</h2>` +
      list +
      (imgBits ? `<div class="ac-office-images">${imgBits}</div>` : "") +
      `</article>`
    );
  });
  const nums = pages.map((_, i) =>
    `<button type="button" class="btn btn--ghost ac-office-num${i === 0 ? " is-active" : ""}" data-index="${i}" aria-pressed="${i === 0 ? "true" : "false"}">${i + 1}</button>`,
  ).join("");
  body.innerHTML =
    `<div class="ac-office" data-kind="${kind}" data-index="0" data-total="${pages.length}">` +
    `<p class="ac-note">${esc(OFFICE_PREVIEW_NOTE)}</p>` +
    `<div class="ac-office-chrome" role="navigation" aria-label="翻页">` +
    `<button type="button" class="btn btn--ghost ac-office-prev">上一页</button>` +
    `<div class="ac-office-pages">${nums}</div>` +
    `<span class="ac-office-pos">${pages.length ? "1" : "0"} / ${pages.length}</span>` +
    `<button type="button" class="btn btn--ghost ac-office-next">下一页</button>` +
    `</div>` +
    pageBits.join("") +
    `<form class="ac-office-review"${opts.inspect ? "" : " hidden"}>` +
    `<p class="ac-review-kicker">本页点评</p>` +
    `<textarea class="ac-review-comment ac-office-comment" rows="2" placeholder="说说这一页要改什么"></textarea>` +
    `<div class="ac-review-actions"><button type="submit" class="btn btn--primary">写进输入框</button></div>` +
    `</form>` +
    `</div>`;
  const root = body.querySelector(".ac-office");
  showOfficePage(root, 0);
  bindOfficeChrome(root);
}

function bindOfficeChrome(root) {
  if (!root || root.dataset.bound === "1") return;
  root.dataset.bound = "1";
  const current = () => Number(root.dataset.index) || 0;
  root.querySelector(".ac-office-prev")?.addEventListener("click", () => {
    showOfficePage(root, current() - 1);
  });
  root.querySelector(".ac-office-next")?.addEventListener("click", () => {
    showOfficePage(root, current() + 1);
  });
  root.querySelectorAll(".ac-office-num").forEach((btn) => {
    btn.addEventListener("click", () => {
      showOfficePage(root, Number(btn.getAttribute("data-index")));
    });
  });
}

/**
 * 按类型把容器渲染成对应预览。产物画布（run 产物）与文件预览覆盖层
 * （任意白名单内本地文件）共用这一段——类型分派、超大截断、iframe 沙箱、
 * 「先转义再变换」纪律只有一份，不会两处漂移。
 *
 * @param {HTMLElement} body 渲染容器
 * @param {{ path:string, url:string, siteUrl?:string, officePreviewUrl?:string, fetch:Function|null, isStale?:()=>boolean, inspect?:boolean }} opts
 *   path 只做类型分派与标题；url 是单文件取件（图/文/下载）；HTML 预览用 siteUrl。
 *   Office（pptx/docx）走 officePreviewUrl JSON。
 *   isStale 返回 true 表示调用方已切走，放弃渲染并返回 null。
 *   inspect：HTML 加 ?inspect=1；Office 展开本页点评表。
 * @returns {Promise<{ size:number|null }|null>}
 *   读到的字节数（不可得/未读取为 null）；isStale 中途成立时整体返回 null。
 */
export async function renderPreviewBody(body, opts) {
  const path = String(opts?.path ?? "");
  const url = String(opts?.url ?? "");
  const fetchImpl = opts?.fetch ?? null;
  const isStale = typeof opts?.isStale === "function" ? opts.isStale : () => false;
  const kind = artifactRendererKind(path);
  const name = artifactBasename(path);

  /** @returns {Promise<string|null>} 失败或已切走回 null（调用方用 isStale 区分） */
  const fetchText = async () => {
    if (!fetchImpl) return null;
    try {
      const res = await fetchImpl(url);
      if (isStale()) return null;
      if (!res || res.ok === false) return null;
      return await res.text();
    } catch {
      return null;
    }
  };

  switch (kind) {
    case "browser": {
      body.innerHTML =
        `<iframe class="ac-frame ac-frame--web" sandbox="${PREVIEW_BROWSER_SANDBOX}" ` +
        `allow="${PREVIEW_IFRAME_ALLOW}" referrerpolicy="no-referrer" src="${esc(path)}" title="${esc(browserTabLabel(path))}"></iframe>` +
        `<p class="ac-note">内置浏览器。部分网站禁止被嵌入，页面空白时用「在系统浏览器打开」。</p>`;
      return { size: null };
    }
    case "html": {
      // 一律整站 /site/*；点评只加 ?inspect=1。沙箱纪律见文件头。
      const frameSrc = opts.siteUrl || url;
      const note = opts.inspect
        ? `<p class="ac-note">点评模式：点页面元素后填写意见，会写进输入框。整站资源仍可用；沙箱不含 same-origin。</p>`
        : `<p class="ac-note">整站预览：相对 CSS/JS 按目录解析。若有 .slide 可翻页（注入脚本切可见页，沙箱不含 same-origin）。三维页若仍提示没有 WebGL，用「在系统浏览器打开」。</p>`;
      body.innerHTML =
        `<iframe class="ac-frame" sandbox="${PREVIEW_HTML_SANDBOX}" allow="${PREVIEW_IFRAME_ALLOW}" referrerpolicy="no-referrer" ` +
        `src="${esc(frameSrc)}" title="${esc(name)}"></iframe>` +
        note;
      return { size: null };
    }
    case "image": {
      body.innerHTML =
        `<div class="ac-image-wrap"><img class="ac-image" src="${esc(url)}" ` +
        `alt="${esc(name)}" /></div>`;
      return { size: null };
    }
    case "markdown": {
      body.innerHTML = '<p class="ac-note">正在读取…</p>';
      const raw = await fetchText();
      if (isStale()) return null;
      if (raw == null) { renderPreviewErrorCard(body, "读取失败——文件可能已被移动或删除。"); return { size: null }; }
      const { text, clipped } = clipPreviewText(raw);
      body.innerHTML =
        `<div class="md ac-doc">${renderMarkdown(text)}</div>` +
        (clipped ? `<p class="ac-note">内容过长，仅显示前 ${TEXT_MAX_CHARS} 字符。</p>` : "");
      return { size: new TextEncoder().encode(raw).length };
    }
    case "code":
    case "text": {
      body.innerHTML = '<p class="ac-note">正在读取…</p>';
      const raw = await fetchText();
      if (isStale()) return null;
      if (raw == null) { renderPreviewErrorCard(body, "读取失败——文件可能已被移动或删除。"); return { size: null }; }
      const { text, clipped } = clipPreviewText(raw);
      if (kind === "code") {
        const lang = artifactCodeLang(path);
        const key = normalizeLang(lang);
        body.innerHTML =
          `<pre class="md-code ac-code${key ? ` md-code--${key}` : ""}">` +
          `<code>${highlight(esc(text), lang)}</code></pre>` +
          (clipped ? `<p class="ac-note">内容过长，仅显示前 ${TEXT_MAX_CHARS} 字符。</p>` : "");
      } else {
        body.innerHTML =
          `<pre class="ac-text">${esc(text)}</pre>` +
          (clipped ? `<p class="ac-note">内容过长，仅显示前 ${TEXT_MAX_CHARS} 字符。</p>` : "");
      }
      return { size: new TextEncoder().encode(raw).length };
    }
    case "csv": {
      body.innerHTML = '<p class="ac-note">正在读取…</p>';
      const raw = await fetchText();
      if (isStale()) return null;
      if (raw == null) { renderPreviewErrorCard(body, "读取失败——文件可能已被移动或删除。"); return { size: null }; }
      const { rows, truncated, totalRows } = parseCsv(raw);
      if (rows.length === 0) { renderPreviewErrorCard(body, "空表格——没有可显示的行。"); return { size: new TextEncoder().encode(raw).length }; }
      const [headRow, ...dataRows] = rows;
      const cell = (v, tag) => `<${tag}>${esc(v)}</${tag}>`;
      body.innerHTML =
        `<div class="md-table-wrap ac-table-wrap"><table class="md-table ac-table">` +
        `<thead><tr>${headRow.map((v) => cell(v, "th")).join("")}</tr></thead>` +
        `<tbody>${dataRows.map((r) => `<tr>${r.map((v) => cell(v, "td")).join("")}</tr>`).join("")}</tbody>` +
        `</table></div>` +
        (truncated
          ? `<p class="ac-note">仅显示前 ${CSV_MAX_ROWS} 行（共 ${totalRows} 行），完整内容请下载。</p>`
          : "");
      return { size: new TextEncoder().encode(raw).length };
    }
    case "pptx":
    case "docx": {
      body.innerHTML = '<p class="ac-note">正在读取…</p>';
      const previewUrl = String(opts.officePreviewUrl ?? "");
      if (!fetchImpl || !previewUrl) {
        renderPreviewErrorCard(body, "无法预览——缺少预览地址。");
        return { size: null };
      }
      try {
        const res = await fetchImpl(previewUrl);
        if (isStale()) return null;
        if (!res || res.ok === false) {
          let message = "读取失败——文件可能已被移动、损坏或已加密。";
          try {
            const payload = await res.json();
            if (payload?.error) message = String(payload.error);
          } catch { /* 用默认文案 */ }
          renderPreviewErrorCard(body, message);
          return { size: null };
        }
        const payload = await res.json();
        if (isStale()) return null;
        if (!payload || !Array.isArray(payload.pages) || payload.pages.length === 0) {
          renderPreviewErrorCard(body, "不是有效的 Office 文件，或已损坏。");
          return { size: null };
        }
        paintOfficePreview(body, { kind, pages: payload.pages }, { inspect: Boolean(opts.inspect) });
        return { size: null };
      } catch {
        if (isStale()) return null;
        renderPreviewErrorCard(body, "读取失败——文件可能已被移动、损坏或已加密。");
        return { size: null };
      }
    }
    default: {
      // 二进制/未知：降级信息卡。大小仍需一次取件——读完即弃，只留字节数
      let size = null;
      if (fetchImpl) {
        try {
          const res = await fetchImpl(url);
          if (isStale()) return null;
          if (res && res.ok !== false) {
            const buf = await res.arrayBuffer();
            if (isStale()) return null;
            size = buf.byteLength;
          }
        } catch { /* 大小不可得就留 null */ }
      }
      body.innerHTML =
        `<div class="ac-fallback">` +
        `<i class="ph ph-file ac-fallback-icon" aria-hidden="true"></i>` +
        `<p class="ac-fallback-name">${esc(name)}</p>` +
        `<p class="ac-fallback-text">类型：${esc(rendererKindLabel(kind))} · 大小：${esc(formatBytes(size))}</p>` +
        `<p class="ac-fallback-text">此类型暂不支持预览，请下载后查看。</p>` +
        `<a class="btn btn--ghost" href="${esc(url)}&download=1">下载</a>` +
        `</div>`;
      return { size };
    }
  }
}


// ---------------------------------------------------------------
// DOM 层
// ---------------------------------------------------------------

const VIEW_ID = "artifact-canvas-view";

/**
 * 初始化产物画布。幂等：重复调用返回既有节点的薄壳。
 *
 * 形态（T10 升级）：默认是主区右侧的**停靠面板**——对话主列保持可见、
 * 可滚动、可继续交互；顶条「放大」扩到整个主区（≈旧的覆盖形态），
 * Esc 在放大态先还原再关闭。外壳（拖拽调宽/放大还原/窄屏退化/动画）
 * 共用 features/preview-dock.js——那一份是所有预览面板的唯一 chrome。
 *
 * host 回调：
 *   getRunId()              → 当前会话 id（画布只预览当前会话的产物）
 *   getArtifacts()          → 已打开的预览标签 [{ path, ... }]（不是会话里全部文件）
 *   onClose()               → 离开会话时宿主仍可调 close()；顶条不再关画布，只收起
 *   onSwitch(index)         → 用户要切到第 index 个（宿主写 hash，绕回来调 open）
 *   onCloseTab(index)       → 关掉第 index 只标签（宿主从已打开清单拿掉再开下一只或收起）
 *   onExpandChange(full)    → 放大/还原（宿主改写 hash 的 ?full，绕回来调 open）
 *   onReveal(path)          → 在文件夹中显示（宿主既有 revealArtifact）
 *   onAnnounce(msg)         → aria-live 播报（可选）
 *
 * env（测试注入）：doc / win / fetch / storage / isNarrow / refreshDebounceMs /
 *                 closeAnimMs（后两者透传给 preview-dock）
 *
 * @param {Record<string, Function>} host
 * @param {{ doc?:Document, win?:Window, fetch?:Function, storage?:Storage|null,
 *           isNarrow?:()=>boolean, refreshDebounceMs?:number, closeAnimMs?:number }} [env]
 */
export function initArtifactCanvas(host = {}, env = {}) {
  const doc = env.doc ?? document;
  const win = env.win ?? (doc.defaultView ?? window);
  const fetchImpl = env.fetch ?? (typeof fetch !== "undefined" ? fetch.bind(win) : null);
  const refreshDebounceMs = env.refreshDebounceMs ?? REFRESH_DEBOUNCE_MS;

  const existing = doc.getElementById(VIEW_ID);
  if (existing && existing.__canvasApi) return existing.__canvasApi;

  // ---- 停靠外壳（拖拽/放大/Esc/窄屏/动画的唯一出处）----
  const dock = createPreviewDock(
    {
      id: VIEW_ID,
      label: "产物画布",
      extraClass: "artifact-canvas",
      onExpandChange: (full) => host.onExpandChange?.(full),
    },
    env,
  );
  const view = dock.root;
  const body = dock.body;

  // ---- 状态 ----
  /** @type {{ path:string }[]} */
  let artifacts = [];
  let runId = "";
  let current = -1;
  /** 异步渲染令牌：连按 ▶ 时慢的那次 fetch 回来不许覆盖快的 */
  let renderToken = 0;
  /** 内容更新自动刷新的防抖计时器（noteWrites） */
  let refreshTimer = 0;
  /** HTML 点评：同一整站 URL 加 ?inspect=1 */
  let inspectOn = false;
  /** 图片画圈：叠一层 canvas，坐标写进输入框 */
  let annotateOn = false;
  /** @type {ReturnType<typeof attachImageAnnotator>|null} */
  let annotator = null;
  /** 幻灯：iframe 报到后启用翻页 chrome */
  let deckActive = false;
  let deckIndex = 0;
  let deckTotal = 0;
  let deckSlideId = "";
  /** @type {string[]} */
  let deckSlideIds = [];
  /** 用户点选过的页才进续跑；仅 DECK_READY 报到不钉，避免误伤整份改稿。 */
  let deckPinnedSlide = "";
  let pinOnNextDeckState = false;
  /** @type {{ line:string, slide?:string }[]} */
  let reviewNotes = [];

  // ---- 顶条特征控件（关闭/放大键由外壳提供，这里插中间段）----
  const tablist = doc.createElement("div");
  tablist.className = "ac-tabs";
  tablist.setAttribute("role", "tablist");
  tablist.setAttribute("aria-label", "预览文件");

  const titleWrap = doc.createElement("div");
  titleWrap.className = "ac-title sr-only";
  const nameEl = doc.createElement("strong");
  nameEl.className = "ac-name";
  const badgeEl = doc.createElement("span");
  badgeEl.className = "ac-badge";
  const sizeEl = doc.createElement("span");
  sizeEl.className = "ac-size";
  titleWrap.appendChild(nameEl);
  titleWrap.appendChild(badgeEl);
  titleWrap.appendChild(sizeEl);

  const actions = doc.createElement("div");
  actions.className = "ac-actions";
  const revealBtn = doc.createElement("button");
  revealBtn.type = "button";
  revealBtn.className = "btn btn--ghost ac-reveal";
  revealBtn.innerHTML = '<i class="ph ph-folder-open" aria-hidden="true"></i><span>在文件夹中显示</span>';
  const exportBtn = doc.createElement("button");
  exportBtn.type = "button";
  exportBtn.id = "ac-export";
  exportBtn.className = "btn btn--ghost ac-export";
  exportBtn.hidden = true;
  exportBtn.setAttribute("aria-haspopup", "menu");
  exportBtn.setAttribute("aria-expanded", "false");
  exportBtn.innerHTML = '<i class="ph ph-export" aria-hidden="true"></i><span>导出</span>';
  exportBtn.title = "下载、打包或打印";
  const inspectBtn = doc.createElement("button");
  inspectBtn.type = "button";
  inspectBtn.id = "ac-inspect";
  inspectBtn.className = "btn btn--ghost ac-inspect";
  inspectBtn.hidden = true;
  inspectBtn.setAttribute("aria-pressed", "false");
  inspectBtn.innerHTML = '<i class="ph ph-cursor-click" aria-hidden="true"></i><span>点评</span>';
  const annotateBtn = doc.createElement("button");
  annotateBtn.type = "button";
  annotateBtn.id = "ac-annotate";
  annotateBtn.className = "btn btn--ghost ac-annotate";
  annotateBtn.hidden = true;
  annotateBtn.setAttribute("aria-pressed", "false");
  annotateBtn.innerHTML = '<i class="ph ph-pencil-simple" aria-hidden="true"></i><span>标注</span>';
  actions.appendChild(exportBtn);
  actions.appendChild(revealBtn);
  actions.appendChild(inspectBtn);
  actions.appendChild(annotateBtn);

  const deckBar = doc.createElement("div");
  deckBar.className = "ac-deck-bar";
  deckBar.id = "ac-deck-bar";
  deckBar.hidden = true;
  const deckPrev = doc.createElement("button");
  deckPrev.type = "button";
  deckPrev.className = "btn btn--ghost";
  deckPrev.textContent = "上一页";
  const deckPages = doc.createElement("div");
  deckPages.className = "ac-deck-pages";
  deckPages.id = "ac-deck-pages";
  const deckPos = doc.createElement("span");
  deckPos.className = "ac-deck-pos";
  const deckNext = doc.createElement("button");
  deckNext.type = "button";
  deckNext.className = "btn btn--ghost";
  deckNext.textContent = "下一页";
  deckBar.appendChild(deckPrev);
  deckBar.appendChild(deckPages);
  deckBar.appendChild(deckPos);
  deckBar.appendChild(deckNext);

  const designPanel = doc.createElement("aside");
  designPanel.className = "ac-design-panel";
  designPanel.id = "ac-design-panel";
  designPanel.hidden = true;
  designPanel.setAttribute("aria-label", "品牌色板（可选，默认不展示）");

  const reviewList = doc.createElement("div");
  reviewList.className = "ac-review-list";
  reviewList.id = "ac-review-list";
  reviewList.hidden = true;

  function hideReviewPopover() {
    body.querySelector("#ac-review-pop")?.remove();
  }

  function dropAnnotator() {
    annotator?.destroy();
    annotator = null;
    body.querySelector("#ac-annotate-bar")?.remove();
  }

  function paintReviewChrome(kind) {
    const html = kind === "html";
    const office = isOfficeKind(kind);
    const image = kind === "image";
    const web = kind === "browser";
    inspectBtn.hidden = !(html || office);
    exportBtn.hidden = !runId || web;
    revealBtn.hidden = web;
    if (!html) hideExportMenu();
    annotateBtn.hidden = !image;
    if (!html && !office) {
      inspectOn = false;
      resetDeck();
      hideDesignPanel();
    } else if (!html) {
      hideDesignPanel();
    }
    if (!image) annotateOn = false;
    inspectBtn.setAttribute("aria-pressed", inspectOn ? "true" : "false");
    inspectBtn.classList.toggle("is-active", inspectOn);
    annotateBtn.setAttribute("aria-pressed", annotateOn ? "true" : "false");
    annotateBtn.classList.toggle("is-active", annotateOn);
    if (kind !== "html") hideWebglBanner();
    paintDeckChrome();
    paintReviewList();
  }

  function hideExportMenu() {
    actions.querySelector("#ac-export-menu")?.remove();
    exportBtn.setAttribute("aria-expanded", "false");
  }

  function currentArtifactPath() {
    return String(artifacts[current]?.path ?? "");
  }

  function paintExportMenu() {
    hideExportMenu();
    const path = currentArtifactPath();
    if (!path) return;
    const menu = doc.createElement("div");
    menu.id = "ac-export-menu";
    menu.className = "ac-export-menu";
    menu.setAttribute("role", "menu");
    const kind = artifactRendererKind(path);
    const download = doc.createElement("a");
    download.id = "ac-download";
    download.className = "btn btn--ghost ac-export-item ac-download";
    download.setAttribute("role", "menuitem");
    download.href = `${artifactUrl(path)}&download=1`;
    download.setAttribute("download", artifactBasename(path));
    download.innerHTML = '<i class="ph ph-download-simple" aria-hidden="true"></i><span>下载当前文件</span>';
    menu.appendChild(download);
    if (kind === "html") {
      const zip = doc.createElement("a");
      zip.id = "ac-zip";
      zip.className = "btn btn--ghost ac-export-item";
      zip.setAttribute("role", "menuitem");
      zip.href = siteZipUrl(path);
      zip.setAttribute("download", `${artifactBasename(path).replace(/\.html?$/i, "") || "site"}.zip`);
      zip.innerHTML = '<i class="ph ph-file-zip" aria-hidden="true"></i><span>ZIP 整站</span>';
      menu.appendChild(zip);
    }
    const siblingPptx = pptxPathForHtml(path);
    const deckExport = deckActive && deckTotal > 1;
    if (deckExport) {
      const print = doc.createElement("a");
      print.id = "ac-print";
      print.className = "btn btn--ghost ac-export-item";
      print.setAttribute("role", "menuitem");
      print.href = siteUrlFor(path, { print: true });
      print.target = "_blank";
      print.rel = "noopener noreferrer";
      print.innerHTML = '<i class="ph ph-printer" aria-hidden="true"></i><span>打印 / 另存 PDF</span>';
      menu.appendChild(print);
      const pptxItem = doc.createElement("button");
      pptxItem.id = "ac-export-pptx";
      pptxItem.type = "button";
      pptxItem.className = "btn btn--ghost ac-export-item";
      pptxItem.setAttribute("role", "menuitem");
      pptxItem.innerHTML = '<i class="ph ph-presentation-chart" aria-hidden="true"></i><span>导出 PowerPoint</span>';
      pptxItem.addEventListener("click", (ev) => {
        ev.preventDefault();
        void exportDeckPptx(path, pptxItem);
      });
      menu.appendChild(pptxItem);
    }
    if (kind === "html") {
      const pngItem = doc.createElement("button");
      pngItem.id = "ac-export-png";
      pngItem.type = "button";
      pngItem.className = "btn btn--ghost ac-export-item";
      pngItem.setAttribute("role", "menuitem");
      pngItem.innerHTML = '<i class="ph ph-image" aria-hidden="true"></i><span>导出图片</span>';
      pngItem.addEventListener("click", (ev) => {
        ev.preventDefault();
        void exportCardPng(path, pngItem);
      });
      menu.appendChild(pngItem);
    }
    const officePaths = officeExportPaths(artifacts).filter((p) => {
      if (pathsMatch(p, path)) return false;
      if (deckExport && pathsMatch(p, siblingPptx)) return false;
      return true;
    });
    officePaths.forEach((officePath, i) => {
      const a = doc.createElement("a");
      a.id = `ac-office-${i}`;
      a.className = "btn btn--ghost ac-export-item ac-office-download";
      a.setAttribute("role", "menuitem");
      a.dataset.path = officePath;
      a.href = `${artifactUrl(officePath)}&download=1`;
      a.setAttribute("download", artifactBasename(officePath));
      const label = artifactBasename(officePath);
      a.innerHTML = `<i class="ph ph-download-simple" aria-hidden="true"></i><span>下载 ${esc(label)}</span>`;
      menu.appendChild(a);
    });
    if (kind === "html" || officePaths.length > 0 || deckExport) {
      const note = doc.createElement("p");
      note.id = "ac-export-note";
      note.className = "ac-export-note";
      note.textContent = deckExport
        ? "从幻灯 HTML 转换；方图截 [data-card]，不是另画一张"
        : kind === "html"
          ? "方图截 [data-card]；没有契约卡会拒绝"
          : "下载当前文件或已有的 Office 文件";
      menu.appendChild(note);
    }
    actions.appendChild(menu);
    exportBtn.setAttribute("aria-expanded", "true");
  }

  function hideDesignPanel() {
    designPanel.hidden = true;
    designPanel.replaceChildren();
  }

  /** 预览占宽时先收起 Progress，避免对话列被挤成一条；用户可再点开。 */
  function collapseRailForPreview() {
    const rail = doc.getElementById("detail-rail");
    if (!rail || rail.hidden || rail.classList.contains("detail-rail--collapsed")) return;
    rail.classList.add("detail-rail--collapsed");
    const toggle = rail.querySelector("#rail-toggle");
    if (toggle) {
      toggle.setAttribute("aria-expanded", "false");
      toggle.textContent = "⟨ Progress";
    }
  }

  function resetDeck({ keepPin = false } = {}) {
    deckActive = false;
    deckIndex = 0;
    deckTotal = 0;
    deckSlideId = "";
    deckSlideIds = [];
    pinOnNextDeckState = false;
    if (!keepPin) deckPinnedSlide = "";
    paintDeckChrome();
  }

  function pinDeckSlide(id) {
    const slide = String(id ?? "").trim();
    if (slide) deckPinnedSlide = slide;
  }

  /** 点评点选钉住的页；不自动写进续跑正文。 */
  function getEditScope() {
    const slide = String(deckPinnedSlide ?? "").trim();
    if (!slide) return null;
    const path = currentArtifactPath();
    return {
      slide,
      ...(path ? { path } : {}),
    };
  }

  function paintDeckChrome() {
    deckBar.hidden = !deckActive || deckTotal < 2;
    hideExportMenu();
    deckPages.replaceChildren();
    if (!deckActive) return;
    deckPos.textContent = `${deckIndex + 1} / ${deckTotal}${deckSlideId ? ` · ${deckSlideId}` : ""}`;
    deckPrev.disabled = deckTotal < 2;
    deckNext.disabled = deckTotal < 2;
    const ids = deckSlideIds.length === deckTotal
      ? deckSlideIds
      : Array.from({ length: deckTotal }, (_, i) => String(i + 1));
    ids.forEach((id, idx) => {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "btn btn--ghost ac-deck-page";
      btn.textContent = String(idx + 1);
      btn.title = `跳到第 ${idx + 1} 页（${id}）`;
      btn.setAttribute("aria-pressed", idx === deckIndex ? "true" : "false");
      btn.classList.toggle("is-active", idx === deckIndex);
      btn.addEventListener("click", () => {
        pinDeckSlide(id);
        pinOnNextDeckState = true;
        postDeckGoto({ index: idx });
      });
      deckPages.appendChild(btn);
    });
  }

  function paintReviewList() {
    const visible = reviewNotes.length > 0 && dock.isOpen();
    reviewList.hidden = !visible;
    reviewList.replaceChildren();
    if (!visible) return;
    const head = doc.createElement("div");
    head.className = "ac-review-list-head";
    const title = doc.createElement("p");
    title.className = "ac-review-list-title";
    title.textContent = `本会话点评（${reviewNotes.length}）`;
    const actionsRow = doc.createElement("div");
    actionsRow.className = "ac-review-list-actions";
    const flushBtn = doc.createElement("button");
    flushBtn.type = "button";
    flushBtn.id = "ac-review-flush";
    flushBtn.className = "btn btn--ghost";
    flushBtn.textContent = "全部写入输入框";
    const clearBtn = doc.createElement("button");
    clearBtn.type = "button";
    clearBtn.id = "ac-review-clear";
    clearBtn.className = "btn btn--ghost";
    clearBtn.textContent = "清空";
    flushBtn.addEventListener("click", () => {
      if (reviewNotes.length === 0) return;
      const block = reviewNotes.map((n) => n.line).join("\n");
      host.onAppendReview?.(block);
      host.onAnnounce?.(`已写入 ${reviewNotes.length} 条点评`);
    });
    clearBtn.addEventListener("click", () => {
      reviewNotes = [];
      paintReviewList();
      host.onAnnounce?.("点评列表已清空");
    });
    actionsRow.appendChild(flushBtn);
    actionsRow.appendChild(clearBtn);
    head.appendChild(title);
    head.appendChild(actionsRow);
    reviewList.appendChild(head);
    const ul = doc.createElement("ul");
    for (const note of reviewNotes.slice(-20)) {
      const li = doc.createElement("li");
      li.textContent = note.line;
      ul.appendChild(li);
    }
    reviewList.appendChild(ul);
  }

  function postDeckGoto(payload) {
    const iframe = body.querySelector("iframe.ac-frame");
    if (!iframe?.contentWindow || typeof iframe.contentWindow.postMessage !== "function") return;
    iframe.contentWindow.postMessage({ type: DECK_GOTO_MESSAGE_TYPE, ...payload }, "*");
  }

  function mountImageAnnotator() {
    dropAnnotator();
    const wrap = body.querySelector(".ac-image-wrap");
    if (!wrap) return;
    annotator = attachImageAnnotator(wrap);
    const bar = doc.createElement("div");
    bar.id = "ac-annotate-bar";
    bar.className = "ac-annotate-bar";
    const hint = doc.createElement("p");
    hint.className = "ac-note";
    hint.textContent = "在图上画圈或点一下定位，意见会写进输入框。";
    const comment = doc.createElement("textarea");
    comment.className = "ac-review-comment";
    comment.rows = 2;
    comment.placeholder = "说说这里要改什么";
    const actionsRow = doc.createElement("div");
    actionsRow.className = "ac-review-actions";
    const undo = doc.createElement("button");
    undo.type = "button";
    undo.className = "btn btn--ghost";
    undo.textContent = "撤销";
    const submit = doc.createElement("button");
    submit.type = "button";
    submit.className = "btn btn--primary";
    submit.textContent = "写进输入框";
    undo.addEventListener("click", () => annotator?.undo());
    submit.addEventListener("click", () => {
      const line = formatImageReview({
        comment: comment.value,
        strokes: annotator?.strokes() ?? [],
        pins: annotator?.pins() ?? [],
      });
      host.onAppendReview?.(line);
      host.onAnnounce?.("点评已写入输入框");
    });
    actionsRow.appendChild(undo);
    actionsRow.appendChild(submit);
    bar.appendChild(hint);
    bar.appendChild(comment);
    bar.appendChild(actionsRow);
    body.appendChild(bar);
  }

  function showReviewPopover(pick) {
    hideReviewPopover();
    const pop = doc.createElement("form");
    pop.id = "ac-review-pop";
    pop.className = "ac-review-pop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "点评选中元素");
    const kicker = doc.createElement("p");
    kicker.className = "ac-review-kicker";
    kicker.textContent = "选中";
    const sel = doc.createElement("code");
    sel.className = "ac-review-sel";
    sel.textContent = String(pick.selector ?? "");
    const comment = doc.createElement("textarea");
    comment.id = "ac-review-comment";
    comment.className = "ac-review-comment";
    comment.rows = 2;
    comment.placeholder = "说说这里要改什么";
    const actionsRow = doc.createElement("div");
    actionsRow.className = "ac-review-actions";
    const cancel = doc.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn--ghost";
    cancel.textContent = "取消";
    const submit = doc.createElement("button");
    submit.type = "submit";
    submit.className = "btn btn--primary";
    submit.textContent = "写进输入框";
    actionsRow.appendChild(cancel);
    actionsRow.appendChild(submit);
    pop.appendChild(kicker);
    pop.appendChild(sel);
    pop.appendChild(comment);
    pop.appendChild(actionsRow);
    cancel.addEventListener("click", () => hideReviewPopover());
    pop.addEventListener("submit", (event) => {
      event.preventDefault();
      const line = formatReviewComment(pick.selector, comment.value, pick.slide);
      reviewNotes.push({ line, slide: pick.slide ? String(pick.slide) : undefined });
      paintReviewList();
      host.onAppendReview?.(line);
      hideReviewPopover();
      host.onAnnounce?.("点评已写入输入框");
    });
    body.appendChild(pop);
    comment.focus();
  }

  const addTabBtn = doc.createElement("button");
  addTabBtn.type = "button";
  addTabBtn.className = "btn btn--ghost ac-tab-add";
  addTabBtn.setAttribute("aria-label", "打开网页");
  addTabBtn.title = "打开网页";
  addTabBtn.innerHTML = '<i class="ph ph-plus" aria-hidden="true"></i>';

  const browserBar = doc.createElement("form");
  browserBar.className = "ac-browser-bar";
  browserBar.id = "ac-browser-bar";
  const urlInput = doc.createElement("input");
  urlInput.type = "text";
  urlInput.className = "ac-browser-url";
  urlInput.id = "ac-browser-url";
  urlInput.placeholder = "输入网址或本地路径，回车打开";
  urlInput.setAttribute("aria-label", "地址栏");
  urlInput.autocomplete = "off";
  urlInput.spellcheck = false;
  const goBtn = doc.createElement("button");
  goBtn.type = "submit";
  goBtn.className = "btn btn--ghost ac-browser-go";
  goBtn.textContent = "前往";
  const openExt = doc.createElement("a");
  openExt.className = "btn btn--ghost ac-browser-ext";
  openExt.id = "ac-browser-ext";
  openExt.target = "_blank";
  openExt.rel = "noopener noreferrer";
  openExt.hidden = true;
  openExt.textContent = "在系统浏览器打开";
  browserBar.appendChild(urlInput);
  browserBar.appendChild(goBtn);
  browserBar.appendChild(openExt);
  browserBar.appendChild(actions);

  dock.insertHeadControl(tablist);
  dock.insertHeadControl(addTabBtn);
  // 名称/徽章给读屏与测试，不占标签行
  body.parentElement?.appendChild(titleWrap);
  // 地址栏单独一行：每个标签都有，网站显示站点名，本地文件显示路径
  const exportStatus = doc.createElement("p");
  exportStatus.id = "ac-export-status";
  exportStatus.className = "ac-export-status";
  exportStatus.hidden = true;
  exportStatus.setAttribute("role", "status");

  const webglBanner = doc.createElement("div");
  webglBanner.className = "ac-webgl-banner";
  webglBanner.id = "ac-webgl-banner";
  webglBanner.hidden = true;
  webglBanner.setAttribute("role", "status");
  const webglText = doc.createElement("p");
  webglText.textContent =
    "预览里拿不到 WebGL。若三维已经在转、只挡着「没有 WebGL」对话框，是页自己的失败遮罩没藏住（display:flex 盖掉了 hidden），不是显卡坏了。先刷新；仍是黑屏再在系统浏览器打开。";
  const webglOpen = doc.createElement("button");
  webglOpen.type = "button";
  webglOpen.className = "btn btn--ghost";
  webglOpen.id = "ac-webgl-open";
  webglOpen.textContent = "在系统浏览器打开";
  webglBanner.appendChild(webglText);
  webglBanner.appendChild(webglOpen);

  function hideWebglBanner() {
    webglBanner.hidden = true;
  }

  function showWebglBanner() {
    webglBanner.hidden = false;
  }

  webglOpen.addEventListener("click", () => {
    if (!openExt.href || openExt.hidden) {
      host.onAnnounce?.("没有可打开的预览地址");
      return;
    }
    openExt.click();
  });

  body.parentElement?.insertBefore(browserBar, body);
  body.parentElement?.insertBefore(deckBar, body);
  body.parentElement?.insertBefore(webglBanner, body);
  body.parentElement?.insertBefore(exportStatus, body);
  body.parentElement?.insertBefore(designPanel, body);
  body.parentElement?.appendChild(reviewList);

  // ---- 渲染 ----
  function artifactUrl(path, cacheBust = false) {
    const base = `/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(path)}`;
    // 运行中自动刷新时破缓存：同一 URL 的 iframe/img 可能吃到旧缓存
    return cacheBust ? `${base}&v=${Date.now()}` : base;
  }

  function siteUrlFor(path, { cacheBust = false, inspect = false, print = false } = {}) {
    const base = siteArtifactUrl(runId, path);
    const q = new URLSearchParams();
    q.set("deck", "1");
    if (inspect) q.set("inspect", "1");
    if (print) q.set("print", "1");
    if (cacheBust) q.set("v", String(Date.now()));
    return `${base}?${q.toString()}`;
  }

  function siteZipUrl(path) {
    return `/api/runs/${encodeURIComponent(runId)}/site-zip?path=${encodeURIComponent(path)}`;
  }

  async function exportDeckPptx(htmlPath, trigger) {
    if (!fetchImpl || !runId) {
      showExportStatus("error", "无法导出 PowerPoint：缺少会话");
      return;
    }
    if (trigger) trigger.disabled = true;
    showExportStatus("pending", "正在从幻灯 HTML 转换…");
    try {
      const res = await fetchImpl(`/api/runs/${encodeURIComponent(runId)}/export/pptx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ htmlPath }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        showExportStatus("error", payload.error || "导出 PowerPoint 失败");
        return;
      }
      const outPath = typeof payload.path === "string" && payload.path
        ? payload.path
        : "";
      if (!outPath) {
        showExportStatus("error", "转换回报成功但没有文件路径");
        return;
      }
      const a = doc.createElement("a");
      a.href = `${artifactUrl(outPath)}&download=1`;
      a.setAttribute("download", artifactBasename(outPath));
      a.rel = "noopener";
      doc.body.appendChild(a);
      a.click();
      a.remove();
      const n = Number(payload.slides) || 0;
      const lossy = Array.isArray(payload.lossy) ? payload.lossy.filter((x) => typeof x === "string" && x.trim()) : [];
      const lossyBit = lossy.length ? `；${lossy.length} 处有损（不是像素还原）` : "";
      showExportStatus("ok", `已导出 ${artifactBasename(outPath)}${n ? `（${n} 页）` : ""}${lossyBit}`);
    } catch (err) {
      showExportStatus("error", err instanceof Error ? err.message : "导出 PowerPoint 失败");
    } finally {
      if (trigger) trigger.disabled = false;
      hideExportMenu();
    }
  }

  function showExportStatus(kind, message) {
    const msg = String(message ?? "").trim();
    exportStatus.hidden = !msg;
    exportStatus.textContent = msg;
    exportStatus.dataset.kind = kind || "";
    exportStatus.setAttribute("role", kind === "error" ? "alert" : "status");
    if (msg) host.onAnnounce?.(msg);
  }

  async function exportCardPng(htmlPath, trigger) {
    if (!fetchImpl || !runId) {
      host.onAnnounce?.("无法导出图片：缺少会话");
      return;
    }
    if (trigger) trigger.disabled = true;
    try {
      const res = await fetchImpl(`/api/runs/${encodeURIComponent(runId)}/export/png`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ htmlPath }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        host.onAnnounce?.(payload.error || "导出图片失败");
        return;
      }
      const paths = Array.isArray(payload.paths) ? payload.paths.filter((p) => typeof p === "string") : [];
      if (paths.length === 0) {
        host.onAnnounce?.("导出图片成功但没有文件路径");
        return;
      }
      for (const outPath of paths) {
        const a = doc.createElement("a");
        a.href = `${artifactUrl(outPath)}&download=1`;
        a.setAttribute("download", artifactBasename(outPath));
        a.rel = "noopener";
        doc.body.appendChild(a);
        a.click();
        a.remove();
      }
      host.onAnnounce?.(
        paths.length === 1
          ? `已导出 ${artifactBasename(paths[0])}`
          : `已导出 ${paths.length} 张图片`,
      );
    } catch (err) {
      host.onAnnounce?.(err instanceof Error ? err.message : "导出图片失败");
    } finally {
      if (trigger) trigger.disabled = false;
      hideExportMenu();
    }
  }

  function setSize(bytes) {
    sizeEl.textContent = formatBytes(bytes);
    sizeEl.hidden = bytes == null;
  }

  async function renderCurrent({ cacheBust = false, keepDeckPin = false } = {}) {
    const token = ++renderToken;
    const art = artifacts[current];
    if (!art) return;
    const path = String(art.path ?? "");
    const kind = artifactRendererKind(path);
    const url = artifactUrl(path, cacheBust);

    resetDeck({ keepPin: Boolean(keepDeckPin || cacheBust) });
    hideWebglBanner();
    nameEl.textContent = previewTabLabel(path);
    nameEl.title = path;
    badgeEl.textContent = rendererKindLabel(kind, { deck: false });
    syncAddressBar();
    paintTabs();
    hideExportMenu();
    setSize(null);
    paintReviewChrome(kind);
    hideReviewPopover();
    dropAnnotator();

    const result = await renderPreviewBody(body, {
      path,
      url,
      siteUrl: kind === "html" ? siteUrlFor(path, { cacheBust, inspect: inspectOn }) : undefined,
      officePreviewUrl: isOfficeKind(kind) && runId ? officePreviewUrl(runId, path) : undefined,
      fetch: fetchImpl,
      isStale: () => token !== renderToken,
      inspect: inspectOn && (kind === "html" || isOfficeKind(kind)),
    });
    if (result && token === renderToken) setSize(result.size);
    if (token === renderToken && annotateOn && kind === "image") mountImageAnnotator();
    if (token === renderToken && isOfficeKind(kind)) bindOfficeReview();
  }

  function bindOfficeReview() {
    const root = body.querySelector(".ac-office");
    if (!root) return;
    const form = root.querySelector(".ac-office-review");
    if (form && form.dataset.reviewBound !== "1") {
      form.dataset.reviewBound = "1";
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const slide = String((Number(root.dataset.index) || 0) + 1);
        const comment = form.querySelector(".ac-office-comment")?.value ?? "";
        const line = formatReviewComment("slide", comment, slide);
        pinDeckSlide(slide);
        reviewNotes.push({ line, slide });
        paintReviewList();
        host.onAppendReview?.(line);
        host.onAnnounce?.("点评已写入输入框");
      });
    }
    if (form) form.hidden = !inspectOn;
    if (root.dataset.pinBound === "1") return;
    root.dataset.pinBound = "1";
    const pinFromRoot = () => pinDeckSlide(String((Number(root.dataset.index) || 0) + 1));
    root.querySelector(".ac-office-prev")?.addEventListener("click", pinFromRoot);
    root.querySelector(".ac-office-next")?.addEventListener("click", pinFromRoot);
    root.querySelectorAll(".ac-office-num").forEach((btn) => {
      btn.addEventListener("click", pinFromRoot);
    });
  }

  // ---- 开关与切换 ----
  /**
   * 打开画布并渲染第 index 件产物。数据当时从宿主取（与右栏同源）。
   * 已开着时复用——hash 切换（◀ ▶ / 前进后退）走同一条入口，不抢焦点。
   * @param {number} index
   * @param {{ full?:boolean }} [opts]
   *   full 给布尔值时设置放大/停靠（深链恢复用）；省略时保持现状
   *   （用户正放大着，◀ ▶ 切产物不该把它缩回去）。
   * @returns {boolean} 是否真打开了（无产物时 false，宿主决定下一步）
   */
  function openCanvas(index, opts = {}) {
    const list = Array.isArray(host.getArtifacts?.()) ? host.getArtifacts() : [];
    if (list.length === 0) return false;
    runId = String(host.getRunId?.() ?? "");
    if (!runId) return false;
    artifacts = list;
    current = wrapIndex(index, artifacts.length);
    if (current < 0) return false;
    if (typeof opts.full === "boolean") dock.setExpanded(opts.full);
    if (!dock.isOpen() || dock.isCollapsed()) {
      dock.open();
      collapseRailForPreview();
      host.onAnnounce?.(`产物画布已打开：${artifactBasename(artifacts[current].path)}`);
    }
    void renderCurrent();
    if (doc.activeElement == null || !view.contains(doc.activeElement)) dock.closeBtn.focus();
    return true;
  }

  function paintTabs() {
    const sig = `${artifacts.map((a) => a.path).join("\0")}#${current}`;
    if (tablist.dataset.sig === sig) return;
    tablist.dataset.sig = sig;
    tablist.replaceChildren();
    tablist.hidden = artifacts.length === 0;
    artifacts.forEach((art, i) => {
      const tab = doc.createElement("div");
      tab.className = "ac-tab";
      tab.setAttribute("role", "tab");
      tab.setAttribute("data-ac-index", String(i));
      const selected = i === current;
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.tabIndex = selected ? 0 : -1;
      tab.title = String(art.path ?? "");
      const label = doc.createElement("span");
      label.className = "ac-tab-label";
      const name = previewTabLabel(art.path);
      label.textContent = name;
      const close = doc.createElement("button");
      close.type = "button";
      close.className = "ac-tab-close";
      close.setAttribute("aria-label", `关闭 ${name}`);
      close.title = "关闭标签";
      close.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i>';
      tab.appendChild(label);
      tab.appendChild(close);
      tablist.appendChild(tab);
    });
    try {
      tablist.querySelector('[aria-selected="true"]')?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    } catch { /* jsdom 没有滚动盒，忽略 */ }
  }

  function closeCanvas() {
    if (!dock.isOpen()) return;
    renderToken += 1; // 作废在途 fetch
    if (refreshTimer) {
      win.clearTimeout(refreshTimer);
      refreshTimer = 0;
    }
    inspectOn = false;
    annotateOn = false;
    reviewNotes = [];
    resetDeck();
    paintReviewList();
    hideReviewPopover();
    hideExportMenu();
    dropAnnotator();
    hideDesignPanel();
    hideWebglBanner();
    dock.close();
  }

  function switchTo(index) {
    if (!dock.isOpen() || dock.isCollapsed()) return;
    const next = wrapIndex(index, artifacts.length);
    if (next < 0 || next === current) return;
    host.onSwitch?.(next);
  }

  /**
   * 运行中内容自动刷新（「agent 直接可以在右边操作」）：宿主在事件节拍里
   * 把本批写盘工具触碰的路径喂进来；命中当前预览路径时防抖重拉一次，
   * 用户就能在右侧看到 agent 实时改网站的效果。
   * @param {string[]} paths
   */
  function noteWrites(paths) {
    if (!dock.isOpen() || !Array.isArray(paths) || paths.length === 0) return;
    const cur = artifacts[current]?.path;
    if (!cur || isBrowserPreviewPath(cur) || !paths.some((p) => pathsMatch(p, cur))) return;
    const restoreSlide = deckPinnedSlide;
    if (refreshTimer) win.clearTimeout(refreshTimer);
    refreshTimer = win.setTimeout(() => {
      refreshTimer = 0;
      if (!dock.isOpen()) return;
      void renderCurrent({ cacheBust: true }).then(() => {
        if (restoreSlide) postDeckGoto({ slide: restoreSlide });
      });
    }, refreshDebounceMs);
  }

  function syncAddressBar() {
    const path = currentArtifactPath();
    urlInput.value = previewAddressValue(path);
    urlInput.title = path;
    const web = isBrowserPreviewPath(path);
    const html = artifactRendererKind(path) === "html";
    openExt.hidden = !(web || html);
    if (web) openExt.href = path;
    else if (html && runId) openExt.href = siteUrlFor(path);
    else openExt.href = "";
  }

  function focusAddress() {
    runId = String(host.getRunId?.() ?? "");
    if (!runId) return false;
    artifacts = Array.isArray(host.getArtifacts?.()) ? host.getArtifacts() : [];
    if (!dock.isOpen() || dock.isCollapsed()) {
      dock.open();
      collapseRailForPreview();
      paintTabs();
    }
    urlInput.focus();
    urlInput.select();
    return true;
  }

  function submitAddress() {
    const raw = String(urlInput.value ?? "").trim();
    if (!raw) {
      host.onAnnounce?.("请输入网址或本地路径");
      return false;
    }
    const href = parseBrowserUrl(raw);
    if (href) {
      if (typeof host.onOpenBrowser === "function") host.onOpenBrowser(href);
      else host.onAnnounce?.("当前没有可打开网页的会话");
      return true;
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
      host.onAnnounce?.("请输入 http 或 https 网址，或本地路径");
      return false;
    }
    if (typeof host.onOpenBrowser === "function") host.onOpenBrowser(raw);
    else host.onAnnounce?.("当前没有可打开预览的会话");
    return true;
  }

  addTabBtn.addEventListener("click", () => {
    urlInput.value = "";
    openExt.hidden = true;
    focusAddress();
  });
  browserBar.addEventListener("submit", (event) => {
    event.preventDefault();
    submitAddress();
  });
  urlInput.addEventListener("focus", () => {
    const path = currentArtifactPath();
    if (isBrowserPreviewPath(path)) urlInput.value = path;
    urlInput.select();
  });
  urlInput.addEventListener("blur", () => {
    if (browserBar.contains(doc.activeElement)) return;
    syncAddressBar();
  });
  tablist.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const close = target.closest(".ac-tab-close");
    if (close && tablist.contains(close)) {
      event.preventDefault();
      event.stopPropagation();
      const tab = close.closest("[data-ac-index]");
      if (tab) host.onCloseTab?.(Number(tab.getAttribute("data-ac-index")));
      return;
    }
    const tab = target.closest("[data-ac-index]");
    if (!tab || !tablist.contains(tab)) return;
    switchTo(Number(tab.getAttribute("data-ac-index")));
  });
  tablist.addEventListener("keydown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (event.key === "Delete" || event.key === "Backspace") {
      const tab = target?.closest("[data-ac-index]");
      if (!tab || !tablist.contains(tab)) return;
      event.preventDefault();
      host.onCloseTab?.(Number(tab.getAttribute("data-ac-index")));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      if (target?.closest(".ac-tab-close")) return;
      const tab = target?.closest("[data-ac-index]");
      if (!tab || !tablist.contains(tab)) return;
      event.preventDefault();
      switchTo(Number(tab.getAttribute("data-ac-index")));
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    if (artifacts.length <= 1) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Home") switchTo(0);
    else if (event.key === "End") switchTo(artifacts.length - 1);
    else switchTo(current + (event.key === "ArrowLeft" ? -1 : 1));
  });
  deckPrev.addEventListener("click", () => {
    pinOnNextDeckState = true;
    postDeckGoto({ delta: -1 });
  });
  deckNext.addEventListener("click", () => {
    pinOnNextDeckState = true;
    postDeckGoto({ delta: 1 });
  });
  revealBtn.addEventListener("click", () => {
    const art = artifacts[current];
    if (art) host.onReveal?.(art.path);
  });
  inspectBtn.addEventListener("click", () => {
    inspectOn = !inspectOn;
    const kind = artifactRendererKind(currentArtifactPath());
    paintReviewChrome(kind);
    if (kind === "html") void renderCurrent({ keepDeckPin: true });
    else if (isOfficeKind(kind)) bindOfficeReview();
  });
  annotateBtn.addEventListener("click", () => {
    annotateOn = !annotateOn;
    paintReviewChrome("image");
    void renderCurrent();
  });
  exportBtn.addEventListener("click", () => {
    if (actions.querySelector("#ac-export-menu")) hideExportMenu();
    else paintExportMenu();
  });
  win.addEventListener("message", (event) => {
    if (!dock.isOpen()) return;
    const iframe = body.querySelector("iframe.ac-frame");
    if (!iframe || event.source !== iframe.contentWindow) return;
    if (iframe.classList.contains("ac-frame--web")) return;
    const data = event.data;
    if (data && typeof data === "object" && data.type === DECK_READY_MESSAGE_TYPE) {
      deckActive = Number(data.total) > 0;
      deckTotal = Math.max(0, Number(data.total) || 0);
      deckIndex = Math.max(0, Number(data.index) || 0);
      deckSlideId = String(data.slide ?? "");
      deckSlideIds = Array.isArray(data.slides) ? data.slides.map((s) => String(s)) : [];
      badgeEl.textContent = rendererKindLabel("html", { deck: deckActive && deckTotal > 1 });
      paintDeckChrome();
      return;
    }
    if (data && typeof data === "object" && data.type === DECK_STATE_MESSAGE_TYPE) {
      deckIndex = Math.max(0, Number(data.index) || 0);
      deckTotal = Math.max(deckTotal, Number(data.total) || 0);
      deckSlideId = String(data.slide ?? "");
      if (pinOnNextDeckState && deckSlideId) {
        pinDeckSlide(deckSlideId);
        pinOnNextDeckState = false;
      }
      paintDeckChrome();
      return;
    }
    if (isWebglStatus(data)) {
      if (data.ok) hideWebglBanner();
      else showWebglBanner();
      return;
    }
    if (!inspectOn) return;
    if (!isInspectPick(data)) return;
    if (data.slide) pinDeckSlide(data.slide);
    showReviewPopover(data);
  });

  // 文件用顶条标签点选，不再全局 ←/→ 切文件。裸方向键只留给幻灯翻页。
  doc.addEventListener("keydown", (event) => {
    if (!dock.isOpen() || dock.isCollapsed()) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
    if (event.target instanceof Element && tablist.contains(event.target)) return;
    const officeRoot = body.querySelector(".ac-office");
    if (officeRoot && officeRoot.querySelectorAll(".ac-office-page").length > 1) {
      event.preventDefault();
      const next = (Number(officeRoot.dataset.index) || 0) + (event.key === "ArrowLeft" ? -1 : 1);
      showOfficePage(officeRoot, next);
      pinDeckSlide(String((Number(officeRoot.dataset.index) || 0) + 1));
      return;
    }
    if (!(deckActive && deckTotal > 1)) return;
    event.preventDefault();
    postDeckGoto({ delta: event.key === "ArrowLeft" ? -1 : 1 });
  });

  const api = {
    open: openCanvas,
    close: closeCanvas,
    isOpen: () => dock.isOpen(),
    isCollapsed: () => dock.isCollapsed(),
    isExpanded: () => dock.isExpanded(),
    setExpanded: (b) => dock.setExpanded(b),
    noteWrites,
    focusAddress,
    /** 当前序号（测试与诊断用） */
    currentIndex: () => current,
    /** 当前预览路径（宿主做写入匹配/诊断用） */
    currentPath: currentArtifactPath,
    getEditScope,
    element: view,
  };
  view.__canvasApi = api;
  return api;
}

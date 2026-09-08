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

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
const HTML_EXT_RE = /\.html?$/i;
const MARKDOWN_EXT_RE = /\.(md|mdx|markdown)$/i;
const CSV_EXT_RE = /\.(csv|tsv)$/i;
const CODE_EXT_RE =
  /\.(css|scss|less|jsx?|mjs|cjs|tsx?|json|py|c|h|cc|cpp|cxx|hpp|cs|java|go|rs|sh|ps1|bat|cmd|ya?ml|toml|ini|xml|sql|vue|svelte)$/i;
const TEXT_EXT_RE = /\.(txt|log|env|rst|adoc)$/i;

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
 * @returns {"html"|"image"|"markdown"|"csv"|"code"|"text"|"binary"}
 */
export function artifactRendererKind(path) {
  const clean = String(path ?? "").split(/[?#]/)[0].replace(/\\/g, "/");
  if (HTML_EXT_RE.test(clean)) return "html";
  if (IMAGE_EXT_RE.test(clean)) return "image";
  if (MARKDOWN_EXT_RE.test(clean)) return "markdown";
  if (CSV_EXT_RE.test(clean)) return "csv";
  if (CODE_EXT_RE.test(clean)) return "code";
  if (TEXT_EXT_RE.test(clean)) return "text";
  return "binary";
}

/** 画布顶条的类型徽章文案（与 app.js artifactKindLabel 同族但按渲染器归并） */
export function rendererKindLabel(kind, { deck = false } = {}) {
  if (kind === "html" && deck) return "幻灯";
  switch (kind) {
    case "html": return "网站";
    case "image": return "图片";
    case "markdown": return "Markdown";
    case "csv": return "表格";
    case "code": return "代码";
    case "text": return "文本";
    default: return "文件";
  }
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
 * 按类型把容器渲染成对应预览。产物画布（run 产物）与文件预览覆盖层
 * （任意白名单内本地文件）共用这一段——类型分派、超大截断、iframe 沙箱、
 * 「先转义再变换」纪律只有一份，不会两处漂移。
 *
 * @param {HTMLElement} body 渲染容器
 * @param {{ path:string, url:string, siteUrl?:string, fetch:Function|null, isStale?:()=>boolean, inspect?:boolean }} opts
 *   path 只做类型分派与标题；url 是单文件取件（图/文/下载）；HTML 预览用 siteUrl。
 *   isStale 返回 true 表示调用方已切走，放弃渲染并返回 null。
 *   inspect 仅 HTML：同一整站 URL 加 ?inspect=1，由服务端注入点选钩子。
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
    case "html": {
      // 一律整站 /site/*；点评只加 ?inspect=1。沙箱纪律见文件头。
      const frameSrc = opts.siteUrl || url;
      const note = opts.inspect
        ? `<p class="ac-note">点评模式：点页面元素后填写意见，会写进输入框。整站资源仍可用；沙箱不含 same-origin。</p>`
        : `<p class="ac-note">整站预览：相对 CSS/JS 按目录解析。若有 .slide 可翻页。沙箱不含 same-origin。</p>`;
      body.innerHTML =
        `<iframe class="ac-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" ` +
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
 *   getArtifacts()          → 当前会话的产物清单 [{ path, ... }]（与右栏同源）
 *   onClose()               → 用户要关掉画布（宿主负责改写 hash）
 *   onSwitch(index)         → 用户要切到第 index 个（宿主写 hash，绕回来调 open）
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
      onClose: () => host.onClose?.(),
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
  /** @type {{ line:string, slide?:string }[]} */
  let reviewNotes = [];

  // ---- 顶条特征控件（关闭/放大键由外壳提供，这里插中间段）----
  const prevBtn = doc.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "btn btn--ghost ac-nav";
  prevBtn.innerHTML = '<i class="ph ph-caret-left" aria-hidden="true"></i>';
  prevBtn.setAttribute("aria-label", "上一件产物");

  const nextBtn = doc.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "btn btn--ghost ac-nav";
  nextBtn.innerHTML = '<i class="ph ph-caret-right" aria-hidden="true"></i>';
  nextBtn.setAttribute("aria-label", "下一件产物");

  const posEl = doc.createElement("span");
  posEl.className = "ac-pos";

  const titleWrap = doc.createElement("div");
  titleWrap.className = "ac-title";
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
  const downloadLink = doc.createElement("a");
  downloadLink.className = "btn btn--ghost ac-download";
  downloadLink.innerHTML = '<i class="ph ph-download-simple" aria-hidden="true"></i><span>下载</span>';
  const revealBtn = doc.createElement("button");
  revealBtn.type = "button";
  revealBtn.className = "btn btn--ghost ac-reveal";
  revealBtn.innerHTML = '<i class="ph ph-folder-open" aria-hidden="true"></i><span>在文件夹中显示</span>';
  const zipLink = doc.createElement("a");
  zipLink.className = "btn btn--ghost ac-zip";
  zipLink.id = "ac-zip";
  zipLink.hidden = true;
  zipLink.innerHTML = '<i class="ph ph-file-zip" aria-hidden="true"></i><span>ZIP</span>';
  zipLink.title = "打包入口 HTML 所在目录";
  const printLink = doc.createElement("a");
  printLink.className = "btn btn--ghost ac-print";
  printLink.id = "ac-print";
  printLink.hidden = true;
  printLink.target = "_blank";
  printLink.rel = "noopener noreferrer";
  printLink.innerHTML = '<i class="ph ph-printer" aria-hidden="true"></i><span>打印</span>';
  printLink.title = "新窗口打开并调起打印（可另存为 PDF）";
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
  actions.appendChild(downloadLink);
  actions.appendChild(zipLink);
  actions.appendChild(printLink);
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
    const image = kind === "image";
    inspectBtn.hidden = !html;
    zipLink.hidden = !html;
    printLink.hidden = !html;
    annotateBtn.hidden = !image;
    if (!html) {
      inspectOn = false;
      resetDeck();
    }
    if (!image) annotateOn = false;
    inspectBtn.setAttribute("aria-pressed", inspectOn ? "true" : "false");
    inspectBtn.classList.toggle("is-active", inspectOn);
    annotateBtn.setAttribute("aria-pressed", annotateOn ? "true" : "false");
    annotateBtn.classList.toggle("is-active", annotateOn);
    paintDeckChrome();
    paintReviewList();
  }

  function resetDeck() {
    deckActive = false;
    deckIndex = 0;
    deckTotal = 0;
    deckSlideId = "";
    deckSlideIds = [];
    paintDeckChrome();
  }

  function paintDeckChrome() {
    deckBar.hidden = !deckActive || deckTotal < 2;
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
      btn.addEventListener("click", () => postDeckGoto({ index: idx }));
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
    if (!iframe?.contentWindow) return;
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

  dock.insertHeadControl(prevBtn);
  dock.insertHeadControl(nextBtn);
  dock.insertHeadControl(posEl);
  dock.insertHeadControl(titleWrap);
  dock.insertHeadControl(actions);
  // 幻灯条与点评列表挂在 body 上方：用 dock 的 body 父级插在 body 前
  body.parentElement?.insertBefore(deckBar, body);
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

  function setSize(bytes) {
    sizeEl.textContent = formatBytes(bytes);
    sizeEl.hidden = bytes == null;
  }

  async function renderCurrent({ cacheBust = false } = {}) {
    const token = ++renderToken;
    const art = artifacts[current];
    if (!art) return;
    const path = String(art.path ?? "");
    const kind = artifactRendererKind(path);
    const url = artifactUrl(path, cacheBust);

    resetDeck();
    nameEl.textContent = artifactBasename(path);
    nameEl.title = path;
    badgeEl.textContent = rendererKindLabel(kind, { deck: false });
    posEl.textContent = artifacts.length > 1 ? `${current + 1} / ${artifacts.length}` : "";
    prevBtn.disabled = artifacts.length <= 1;
    nextBtn.disabled = artifacts.length <= 1;
    downloadLink.href = `${artifactUrl(path)}&download=1`;
    downloadLink.setAttribute("download", artifactBasename(path));
    zipLink.href = siteZipUrl(path);
    zipLink.setAttribute("download", `${artifactBasename(path).replace(/\.html?$/i, "") || "site"}.zip`);
    printLink.href = siteUrlFor(path, { print: true });
    setSize(null);
    paintReviewChrome(kind);
    hideReviewPopover();
    dropAnnotator();

    const result = await renderPreviewBody(body, {
      path,
      url,
      siteUrl: kind === "html" ? siteUrlFor(path, { cacheBust, inspect: inspectOn }) : undefined,
      fetch: fetchImpl,
      isStale: () => token !== renderToken,
      inspect: inspectOn && kind === "html",
    });
    if (result && token === renderToken) setSize(result.size);
    if (token === renderToken && annotateOn && kind === "image") mountImageAnnotator();
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
    if (!dock.isOpen()) {
      dock.open();
      host.onAnnounce?.(`产物画布已打开：${artifactBasename(artifacts[current].path)}`);
    }
    void renderCurrent();
    if (doc.activeElement == null || !view.contains(doc.activeElement)) dock.closeBtn.focus();
    return true;
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
    dropAnnotator();
    dock.close();
  }

  function step(delta) {
    if (!dock.isOpen() || artifacts.length <= 1) return;
    host.onSwitch?.(wrapIndex(current + delta, artifacts.length));
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
    if (!cur || !paths.some((p) => pathsMatch(p, cur))) return;
    if (refreshTimer) win.clearTimeout(refreshTimer);
    refreshTimer = win.setTimeout(() => {
      refreshTimer = 0;
      if (dock.isOpen()) void renderCurrent({ cacheBust: true });
    }, refreshDebounceMs);
  }

  prevBtn.addEventListener("click", () => step(-1));
  nextBtn.addEventListener("click", () => step(1));
  deckPrev.addEventListener("click", () => postDeckGoto({ delta: -1 }));
  deckNext.addEventListener("click", () => postDeckGoto({ delta: 1 }));
  revealBtn.addEventListener("click", () => {
    const art = artifacts[current];
    if (art) host.onReveal?.(art.path);
  });
  inspectBtn.addEventListener("click", () => {
    inspectOn = !inspectOn;
    paintReviewChrome("html");
    void renderCurrent();
  });
  annotateBtn.addEventListener("click", () => {
    annotateOn = !annotateOn;
    paintReviewChrome("image");
    void renderCurrent();
  });
  win.addEventListener("message", (event) => {
    if (!dock.isOpen()) return;
    const iframe = body.querySelector("iframe.ac-frame");
    if (!iframe || event.source !== iframe.contentWindow) return;
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
      paintDeckChrome();
      return;
    }
    if (!inspectOn) return;
    if (!isInspectPick(data)) return;
    showReviewPopover(data);
  });

  // Alt+←/→ 切产物；裸 ←/→ 在幻灯激活时翻页，否则切产物
  doc.addEventListener("keydown", (event) => {
    if (!dock.isOpen()) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -1 : 1;
    if (event.altKey) {
      step(delta);
      return;
    }
    if (deckActive && deckTotal > 1) {
      postDeckGoto({ delta });
      return;
    }
    step(delta);
  });

  const api = {
    open: openCanvas,
    close: closeCanvas,
    isOpen: () => dock.isOpen(),
    isExpanded: () => dock.isExpanded(),
    setExpanded: (b) => dock.setExpanded(b),
    noteWrites,
    /** 当前序号（测试与诊断用） */
    currentIndex: () => current,
    /** 当前预览路径（宿主做写入匹配/诊断用） */
    currentPath: () => (current >= 0 ? String(artifacts[current]?.path ?? "") : ""),
    element: view,
  };
  view.__canvasApi = api;
  return api;
}

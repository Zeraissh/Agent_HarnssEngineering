/**
 * features/artifact-canvas — 产物画布（T10）。
 *
 * 零依赖原生 ESM。把右栏「产物」文件列表升级为可预览的工作台：
 * 点产物卡的「预览/打开」后，画布视图盖住主列（与 settings 同一条视图切换
 * 纪律），按类型分派渲染器，hash 深链 `#/run/<id>/artifact/<index>` 可刷新恢复。
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
 *   - 服务端（ui/server.ts /api/runs/:id/artifact）：CSP
 *     `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'` +
 *     nosniff——脚本与外链在 HTTP 层已被禁；
 *   - 本模块的 iframe 再加一道 `sandbox="allow-scripts"`：**故意不给
 *     `allow-same-origin`**。给了它，产物脚本就能读宿主的 localStorage、
 *     调同源 /api/*；不给，iframe 是无源（opaque origin）文档，脚本即使
 *     绕过了上面的 CSP 也碰不到宿主。两层独立，各自失效时另一层仍在。
 * 文本类产物（Markdown / 代码 / CSV）一律经 core/markdown.js 与
 * core/highlight.js 渲染——它们遵守「先整体转义，再做变换」纪律，本模块
 * 绝不把产物原文直接塞进 innerHTML。
 */

import { renderMarkdown } from "../core/markdown.js";
import { highlight, normalizeLang } from "../core/highlight.js";

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
export function rendererKindLabel(kind) {
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
 * 路由编码：`#/run/<id>/artifact/<index>`。index 是宿主产物清单里的 0 基序号。
 * @param {string} runId
 * @param {number} index
 * @returns {string}
 */
export function encodeArtifactHash(runId, index) {
  return `#/run/${encodeURIComponent(String(runId ?? ""))}/artifact/${Math.max(0, Math.trunc(index))}`;
}

const ARTIFACT_ROUTE_RE = /^#\/run\/([^/]+)\/artifact\/(\d+)(?:[/?].*)?$/;

/**
 * 路由解码。不匹配返回 null；index 越界不归这里管（清单在宿主手里）。
 * @param {string} hash location.hash
 * @returns {{ runId:string, index:number }|null}
 */
export function parseArtifactRoute(hash) {
  const m = ARTIFACT_ROUTE_RE.exec(String(hash ?? ""));
  if (!m) return null;
  let runId = m[1];
  try { runId = decodeURIComponent(runId); } catch { /* 非法转义时保留原样 */ }
  return { runId, index: Number.parseInt(m[2], 10) };
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

// ---------------------------------------------------------------
// DOM 层
// ---------------------------------------------------------------

const VIEW_ID = "artifact-canvas-view";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** 模块内转义：与 core/markdown.js 入口同一纪律——产物原文绝不直接进 innerHTML */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * 初始化产物画布。幂等：重复调用返回既有节点的薄壳。
 *
 * host 回调：
 *   getRunId()              → 当前会话 id（画布只预览当前会话的产物）
 *   getArtifacts()          → 当前会话的产物清单 [{ path, ... }]（与右栏同源）
 *   onClose()               → 用户要关掉画布（宿主负责改写 hash）
 *   onSwitch(index)         → 用户要切到第 index 个（宿主写 hash，绕回来调 open）
 *   onReveal(path)          → 在文件夹中显示（宿主既有 revealArtifact）
 *   onAnnounce(msg)         → aria-live 播报（可选）
 *
 * env（测试注入）：doc / win / fetch
 *
 * @param {Record<string, Function>} host
 * @param {{ doc?:Document, win?:Window, fetch?:Function }} [env]
 */
export function initArtifactCanvas(host = {}, env = {}) {
  const doc = env.doc ?? document;
  const win = env.win ?? (doc.defaultView ?? window);
  const fetchImpl = env.fetch ?? (typeof fetch !== "undefined" ? fetch.bind(win) : null);

  const existing = doc.getElementById(VIEW_ID);
  if (existing && existing.__canvasApi) return existing.__canvasApi;

  // ---- 状态 ----
  let open = false;
  /** @type {{ path:string }[]} */
  let artifacts = [];
  let runId = "";
  let current = -1;
  /** 异步渲染令牌：连按 ▶ 时慢的那次 fetch 回来不许覆盖快的 */
  let renderToken = 0;
  /** @type {HTMLElement|null} */
  let restoreFocusTo = null;

  // ---- 骨架 ----
  const view = doc.createElement("div");
  view.id = VIEW_ID;
  view.className = "artifact-canvas";
  view.hidden = true;
  view.setAttribute("role", "dialog");
  view.setAttribute("aria-label", "产物画布");

  const head = doc.createElement("header");
  head.className = "ac-head";

  const closeBtn = doc.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn btn--ghost ac-close";
  closeBtn.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i><span>关闭</span>';
  closeBtn.setAttribute("aria-label", "关闭产物画布（Esc）");

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
  actions.appendChild(downloadLink);
  actions.appendChild(revealBtn);

  head.appendChild(closeBtn);
  head.appendChild(prevBtn);
  head.appendChild(nextBtn);
  head.appendChild(posEl);
  head.appendChild(titleWrap);
  head.appendChild(actions);

  const body = doc.createElement("div");
  body.className = "ac-body";

  view.appendChild(head);
  view.appendChild(body);
  // 挂在主区：盖住对话内容与右栏，侧栏仍在（与 settings 同一条纪律）
  (doc.getElementById("main-panel") ?? doc.body).appendChild(view);

  // ---- 渲染 ----
  function artifactUrl(path) {
    return `/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(path)}`;
  }

  function setSize(bytes) {
    sizeEl.textContent = formatBytes(bytes);
    sizeEl.hidden = bytes == null;
  }

  /** @param {string} url @returns {Promise<string|null>} 失败回 null（调用方画错误卡） */
  async function fetchText(url, token) {
    if (!fetchImpl) return null;
    try {
      const res = await fetchImpl(url);
      if (token !== renderToken) return null; // 已切走，丢弃
      if (!res || res.ok === false) return null;
      return await res.text();
    } catch {
      return null;
    }
  }

  function renderErrorCard(message) {
    body.innerHTML =
      `<div class="ac-fallback">` +
      `<i class="ph ph-warning-circle ac-fallback-icon" aria-hidden="true"></i>` +
      `<p class="ac-fallback-text">${esc(message)}</p>` +
      `</div>`;
  }

  /** 文本读入后的公共截断：超大文件只画头部，标注出来 */
  function clipText(text) {
    const t = String(text ?? "");
    if (t.length <= TEXT_MAX_CHARS) return { text: t, clipped: false };
    return { text: t.slice(0, TEXT_MAX_CHARS), clipped: true };
  }

  async function renderCurrent() {
    const token = ++renderToken;
    const art = artifacts[current];
    if (!art) return;
    const path = String(art.path ?? "");
    const kind = artifactRendererKind(path);
    const url = artifactUrl(path);

    nameEl.textContent = artifactBasename(path);
    nameEl.title = path;
    badgeEl.textContent = rendererKindLabel(kind);
    posEl.textContent = artifacts.length > 1 ? `${current + 1} / ${artifacts.length}` : "";
    prevBtn.disabled = artifacts.length <= 1;
    nextBtn.disabled = artifacts.length <= 1;
    downloadLink.href = `${url}&download=1`;
    downloadLink.setAttribute("download", artifactBasename(path));
    setSize(null);

    switch (kind) {
      case "html": {
        // 沙箱纪律见文件头注释：allow-scripts 但不给 allow-same-origin
        body.innerHTML =
          `<iframe class="ac-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" ` +
          `src="${esc(url)}" title="${esc(artifactBasename(path))}"></iframe>` +
          `<p class="ac-note">HTML 产物在隔离沙箱中渲染；其内部的相对资源引用可能失效，属预期。</p>`;
        break;
      }
      case "image": {
        body.innerHTML =
          `<div class="ac-image-wrap"><img class="ac-image" src="${esc(url)}" ` +
          `alt="${esc(artifactBasename(path))}" /></div>`;
        break;
      }
      case "markdown": {
        body.innerHTML = '<p class="ac-note">正在读取…</p>';
        const raw = await fetchText(url, token);
        if (token !== renderToken) return;
        if (raw == null) { renderErrorCard("读取失败——文件可能已被移动或删除。"); return; }
        const { text, clipped } = clipText(raw);
        setSize(new TextEncoder().encode(raw).length);
        body.innerHTML =
          `<div class="md ac-doc">${renderMarkdown(text)}</div>` +
          (clipped ? `<p class="ac-note">内容过长，仅显示前 ${TEXT_MAX_CHARS} 字符。</p>` : "");
        break;
      }
      case "code":
      case "text": {
        body.innerHTML = '<p class="ac-note">正在读取…</p>';
        const raw = await fetchText(url, token);
        if (token !== renderToken) return;
        if (raw == null) { renderErrorCard("读取失败——文件可能已被移动或删除。"); return; }
        const { text, clipped } = clipText(raw);
        setSize(new TextEncoder().encode(raw).length);
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
        break;
      }
      case "csv": {
        body.innerHTML = '<p class="ac-note">正在读取…</p>';
        const raw = await fetchText(url, token);
        if (token !== renderToken) return;
        if (raw == null) { renderErrorCard("读取失败——文件可能已被移动或删除。"); return; }
        setSize(new TextEncoder().encode(raw).length);
        const { rows, truncated, totalRows } = parseCsv(raw);
        if (rows.length === 0) { renderErrorCard("空表格——没有可显示的行。"); return; }
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
        break;
      }
      default: {
        // 二进制/未知：降级信息卡。大小仍需一次取件——读完即弃，只留字节数
        let size = null;
        if (fetchImpl) {
          try {
            const res = await fetchImpl(url);
            if (token !== renderToken) return;
            if (res && res.ok !== false) {
              const buf = await res.arrayBuffer();
              if (token !== renderToken) return;
              size = buf.byteLength;
            }
          } catch { /* 大小不可得就留 "—" */ }
        }
        setSize(size);
        body.innerHTML =
          `<div class="ac-fallback">` +
          `<i class="ph ph-file ac-fallback-icon" aria-hidden="true"></i>` +
          `<p class="ac-fallback-name">${esc(artifactBasename(path))}</p>` +
          `<p class="ac-fallback-text">类型：${esc(rendererKindLabel(kind))} · 大小：${esc(formatBytes(size))}</p>` +
          `<p class="ac-fallback-text">此类型暂不支持预览，请下载后查看。</p>` +
          `<a class="btn btn--ghost" href="${esc(url)}&download=1">下载</a>` +
          `</div>`;
        break;
      }
    }
  }

  // ---- 开关与切换 ----
  /**
   * 打开画布并渲染第 index 件产物。数据当时从宿主取（与右栏同源）。
   * 已开着时复用——hash 切换（◀ ▶ / 前进后退）走同一条入口，不抢焦点。
   * @param {number} index
   * @returns {boolean} 是否真打开了（无产物时 false，宿主决定下一步）
   */
  function openCanvas(index) {
    const list = Array.isArray(host.getArtifacts?.()) ? host.getArtifacts() : [];
    if (list.length === 0) return false;
    runId = String(host.getRunId?.() ?? "");
    if (!runId) return false;
    artifacts = list;
    current = wrapIndex(index, artifacts.length);
    if (current < 0) return false;
    if (!open) {
      open = true;
      restoreFocusTo = /** @type {HTMLElement|null} */ (doc.activeElement);
      view.hidden = false;
      host.onAnnounce?.(`产物画布已打开：${artifactBasename(artifacts[current].path)}`);
    }
    void renderCurrent();
    if (doc.activeElement == null || !view.contains(doc.activeElement)) closeBtn.focus();
    return true;
  }

  function closeCanvas() {
    if (!open) return;
    open = false;
    renderToken += 1; // 作废在途 fetch
    view.hidden = true;
    body.innerHTML = "";
    if (restoreFocusTo && typeof restoreFocusTo.focus === "function" && doc.contains?.(restoreFocusTo) !== false) {
      restoreFocusTo.focus();
    }
    restoreFocusTo = null;
  }

  function step(delta) {
    if (!open || artifacts.length <= 1) return;
    host.onSwitch?.(wrapIndex(current + delta, artifacts.length));
  }

  closeBtn.addEventListener("click", () => host.onClose?.());
  prevBtn.addEventListener("click", () => step(-1));
  nextBtn.addEventListener("click", () => step(1));
  revealBtn.addEventListener("click", () => {
    const art = artifacts[current];
    if (art) host.onReveal?.(art.path);
  });

  // 键盘：Esc 关、←/→ 切。只在画布开着时接管，关掉后这几个键归还给宿主
  doc.addEventListener("keydown", (event) => {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      host.onClose?.();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
    }
  });

  const api = {
    open: openCanvas,
    close: closeCanvas,
    isOpen: () => open,
    /** 当前序号（测试与诊断用） */
    currentIndex: () => current,
    element: view,
  };
  view.__canvasApi = api;
  return api;
}

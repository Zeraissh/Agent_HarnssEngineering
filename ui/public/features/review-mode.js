/**
 * features/review-mode — 网站预览里的点评。
 *
 * 沙箱 iframe 没有 allow-same-origin，父页读不到 contentDocument。
 * 正解：整站仍走 `/site/*`（相对 CSS/JS 可用）；点评时由服务端在 HTML 响应里
 * 注入点选钩子（`?inspect=1`），不剥页面自己的脚本。点选经 postMessage 回来；
 * selector / 文案当不可信字符串，只写进输入框。
 * 翻页也走同一条路：注入 runtime 收 goto、在 iframe 里切可见页。不读
 * contentDocument，因此不需要放宽 same-origin。杂志风稿常省略
 * `.slide{display:none}`，只改 is-active 会让封面一直挡着；只 hidden 掉
 * 兄弟页又会让叠层后页失去尺寸/背景，变成黑框。runtime 同时藏非当前页
 * 并强制当前页自己占满视口（打印媒体不套）。
 */

import {
  htmlHasTexDelimiters,
  pageHasMathRenderer,
  KATEX_CSS_HREF,
  KATEX_JS_HREF,
  KATEX_AUTO_HREF,
  KATEX_RUNTIME_HREF,
} from "../core/math.js";

export const INSPECT_MESSAGE_TYPE = "agent-inspect-pick";
export const DECK_READY_MESSAGE_TYPE = "agent-deck-ready";
export const DECK_GOTO_MESSAGE_TYPE = "agent-deck-goto";
export const DECK_STATE_MESSAGE_TYPE = "agent-deck-state";
export const WEBGL_STATUS_MESSAGE_TYPE = "agent-webgl-status";

/**
 * 作者写 `.fallback{display:flex}` 时，UA 的 `[hidden]{display:none}` 会被盖掉。
 * 三维页因此在 WebGL 已经画出来之后，仍叠一层「这台设备没有可用的 WebGL」。
 * 整站预览统一补回 hidden 的语义；打印媒体不改。
 */
export const HIDDEN_ATTR_FIX_CSS = "[hidden]{display:none!important}";
export const HIDDEN_ATTR_FIX_TAG = `<style id="agent-hidden-fix">${HIDDEN_ATTR_FIX_CSS}</style>`;

export function sanitizeClassToken(token) {
  return /^[A-Za-z][\w-]*$/.test(String(token ?? "")) ? String(token) : "";
}

export function buildCssSelector(node) {
  if (!node || typeof node !== "object") return "";
  const id = sanitizeClassToken(node.id);
  if (id) return `#${id}`;
  const tag = String(node.tag ?? node.tagName ?? "div").toLowerCase().replace(/[^a-z0-9-]/g, "") || "div";
  const classes = String(node.className ?? "")
    .split(/\s+/)
    .map(sanitizeClassToken)
    .filter(Boolean)
    .slice(0, 2);
  let bit = tag + classes.map((c) => `.${c}`).join("");
  const nth = Number(node.nth);
  if (Number.isInteger(nth) && nth > 1) bit += `:nth-of-type(${nth})`;
  const parent = typeof node.parent === "string" && node.parent ? node.parent : "";
  return parent ? `${parent} > ${bit}` : bit;
}

/**
 * 用户在谈整份稿 / 全部配图时，点评不得带 [slide:…] 把意见箍在当前页。
 * 那次「这些图与科技不相关」被箍在封底，错图整册没动。
 * 先剥掉正文里的 [改稿范围]/[改范围]（手写或历史注入），只看用户原话。
 */
export function isWholeDeckRevision(text) {
  const t = stripSlideLockMarkers(String(text ?? ""));
  if (!t.trim()) return false;
  return /全部(的)?(图|页|配图)|所有(的)?(图|页|配图)|整份(稿|图|幻灯|配图)|整套(图|幻灯|稿)|每一[页张]|各页|这些图|配图都不|图(片)?.{0,24}(审核|不相关|无关|都不对|都错|全错)|完全.{0,24}(不相关|无关)|每页都|all (the )?(images?|pictures?|slides?|pages?)|every (slide|page|image)|whole deck/i.test(
    t,
  );
}

export function stripSlideLockMarkers(text) {
  return String(text ?? "")
    .replace(/\[改稿范围\][^\n]*/g, "")
    .replace(/\[改范围\][^\n]*/g, "")
    .replace(/\[点评\]\[slide:[^\]]+\]/g, "[点评]")
    .replace(/^\n+/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatReviewComment(selector, comment, slide) {
  const sel = String(selector ?? "").trim() || "(未识别)";
  const note = String(comment ?? "").replace(/\s+/g, " ").trim();
  const slideBit = isWholeDeckRevision(note) ? "" : String(slide ?? "").trim();
  const head = slideBit ? `[点评][slide:${slideBit}]` : "[点评]";
  return note ? `${head} ${sel}: ${note}` : `${head} ${sel}`;
}

export function appendReviewToInput(existing, line) {
  const cur = String(existing ?? "").replace(/\s+$/g, "");
  const next = String(line ?? "").trim();
  if (!next) return cur;
  return cur ? `${cur}\n${next}` : next;
}

export function isInspectPick(data) {
  return Boolean(
    data
    && typeof data === "object"
    && data.type === INSPECT_MESSAGE_TYPE
    && typeof data.selector === "string"
    && data.selector.trim(),
  );
}

export function isWebglStatus(data) {
  return Boolean(
    data
    && typeof data === "object"
    && data.type === WEBGL_STATUS_MESSAGE_TYPE
    && typeof data.ok === "boolean",
  );
}

/** iframe 内运行：只 postMessage，不碰父页。悬停用固定层描边，画在控件外侧。 */
export const INSPECT_HOOK_SOURCE = `(function(){
  if (window.__agentInspectHooked) return;
  window.__agentInspectHooked = true;
  function sel(el){
    if (!el || el.nodeType !== 1) return "";
    if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) return "#" + el.id;
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 4 && node !== document.body && node !== document.documentElement) {
      var tag = (node.tagName || "div").toLowerCase();
      var cls = String(node.className || "").split(/\\s+/).filter(function(c){ return /^[A-Za-z][\\w-]*$/.test(c); }).slice(0, 2);
      var bit = tag + cls.map(function(c){ return "." + c; }).join("");
      var kids = node.parentNode ? node.parentNode.children : null;
      if (kids && kids.length) {
        var same = 0, idx = 0;
        for (var i = 0; i < kids.length; i++) {
          if (kids[i].tagName === node.tagName) { same++; if (kids[i] === node) idx = same; }
        }
        if (same > 1) bit += ":nth-of-type(" + idx + ")";
      }
      parts.unshift(bit);
      node = node.parentElement;
      depth++;
    }
    return parts.join(" > ");
  }
  var PAD = 3;
  var ring = document.createElement("div");
  ring.id = "agent-inspect-ring";
  ring.setAttribute("aria-hidden", "true");
  ring.style.cssText = [
    "position:fixed",
    "pointer-events:none",
    "z-index:2147483647",
    "box-sizing:border-box",
    "border:2px solid #2563eb",
    "border-radius:4px",
    "box-shadow:0 0 0 1px rgba(255,255,255,0.85), 0 0 0 3px rgba(37,99,235,0.35)",
    "background:transparent",
    "display:none",
    "margin:0",
    "padding:0"
  ].join(";");
  function ensureRing(){
    if (!ring.isConnected) (document.documentElement || document.body).appendChild(ring);
  }
  function hideRing(){
    ring.style.display = "none";
  }
  function pickTarget(raw){
    var t = raw;
    if (!t || t === ring) return null;
    if (t.nodeType !== 1) t = t.parentElement;
    while (t && (t === ring || (t.id && t.id === "agent-inspect-ring"))) t = t.parentElement;
    if (!t || t === document.documentElement || t === document.body) return null;
    return t;
  }
  function showRing(el){
    ensureRing();
    var r = el.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) { hideRing(); return; }
    ring.style.display = "block";
    ring.style.top = Math.max(0, r.top - PAD) + "px";
    ring.style.left = Math.max(0, r.left - PAD) + "px";
    ring.style.width = Math.max(0, r.width + PAD * 2) + "px";
    ring.style.height = Math.max(0, r.height + PAD * 2) + "px";
  }
  document.documentElement.setAttribute("data-agent-inspect", "1");
  document.documentElement.style.cursor = "crosshair";
  var pinUntil = 0;
  document.addEventListener("mousemove", function(ev){
    if (Date.now() < pinUntil) return;
    var t = pickTarget(ev.target);
    if (!t) { hideRing(); return; }
    showRing(t);
  }, true);
  document.addEventListener("mouseleave", function(){
    if (Date.now() < pinUntil) return;
    hideRing();
  }, true);
  document.addEventListener("scroll", function(){
    if (Date.now() < pinUntil) return;
    hideRing();
  }, true);
  window.addEventListener("resize", function(){
    if (Date.now() < pinUntil) return;
    hideRing();
  }, true);
  document.addEventListener("click", function(ev){
    ev.preventDefault();
    ev.stopPropagation();
    var t = pickTarget(ev.target);
    if (!t) return;
    showRing(t);
    pinUntil = Date.now() + 2500;
    var text = String(t.innerText || t.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80);
    var slideEl = t.closest ? t.closest(".slide[data-slide]") : null;
    var slide = slideEl && slideEl.getAttribute ? String(slideEl.getAttribute("data-slide") || "").trim() : "";
    parent.postMessage({
      type: "${INSPECT_MESSAGE_TYPE}",
      selector: sel(t),
      tag: String(t.tagName || "").toLowerCase(),
      text: text,
      slide: slide || undefined
    }, "*");
  }, true);
  ensureRing();
})();`;

/**
 * iframe 内翻页 runtime：发现 .slide[data-slide] 后向父页报到，并响应 goto。
 * 无幻灯则静默退出。与页面自带 deck.js 并存时以本 runtime 的 is-active 为准。
 * 非当前页隐藏；当前页强制自成一屏（杂志叠层把尺寸/背景挂在第 1 页上，
 * 只 display:none 兄弟会留下黑框）。不用 hidden 属性——UA 的
 * [hidden]{display:none!important} 会和稿面 display:flex 互殴。
 */
export const DECK_VISIBILITY_CSS = [
  "@media not print{",
  "html,body{min-height:100%;min-height:100vh}",
  ".slide[data-slide]:not(.is-active){display:none!important}",
  ".slide[data-slide].is-active{",
  "display:flex!important;",
  "visibility:visible!important;",
  "opacity:1!important;",
  "position:relative!important;",
  "inset:auto!important;",
  "top:auto!important;left:auto!important;right:auto!important;bottom:auto!important;",
  "transform:none!important;",
  "translate:none!important;",
  "width:100%!important;",
  "max-width:100%!important;",
  "height:auto!important;",
  "min-height:100vh!important;",
  "pointer-events:auto!important;",
  "box-sizing:border-box!important",
  "}",
  "}",
].join("");

export const DECK_RUNTIME_SOURCE = `(function(){
  if (window.__agentDeckHooked) return;
  window.__agentDeckHooked = true;
  function collect(){
    return Array.prototype.slice.call(document.querySelectorAll(".slide[data-slide]"));
  }
  var slides = collect();
  if (!slides.length) return;
  if (!document.getElementById("agent-deck-visibility")) {
    var css = document.createElement("style");
    css.id = "agent-deck-visibility";
    css.setAttribute("data-agent-deck", "1");
    css.textContent = ${JSON.stringify(DECK_VISIBILITY_CSS)};
    (document.head || document.documentElement).appendChild(css);
  }
  var i = Math.max(0, slides.findIndex(function(s){ return s.classList.contains("is-active"); }));
  if (i < 0) i = 0;
  function idOf(idx){
    var el = slides[idx];
    return el ? String(el.getAttribute("data-slide") || String(idx + 1)) : "";
  }
  function emitState(){
    parent.postMessage({
      type: "${DECK_STATE_MESSAGE_TYPE}",
      index: i,
      total: slides.length,
      slide: idOf(i)
    }, "*");
  }
  function unpinTrack(el){
    var n = el && el.parentElement;
    var d = 0;
    while (n && d < 3 && n !== document.body && n !== document.documentElement) {
      n.style.setProperty("transform", "none", "important");
      n.style.setProperty("translate", "none", "important");
      n = n.parentElement;
      d++;
    }
  }
  function show(n){
    if (!slides.length) return;
    i = ((n % slides.length) + slides.length) % slides.length;
    slides.forEach(function(s, idx){
      var on = idx === i;
      s.classList.toggle("is-active", on);
      s.removeAttribute("hidden");
      s.setAttribute("aria-hidden", on ? "false" : "true");
    });
    unpinTrack(slides[i]);
    emitState();
  }
  parent.postMessage({
    type: "${DECK_READY_MESSAGE_TYPE}",
    total: slides.length,
    slides: slides.map(function(_, idx){ return idOf(idx); }),
    index: i,
    slide: idOf(i)
  }, "*");
  show(i);
  window.addEventListener("message", function(ev){
    var d = ev && ev.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "${DECK_GOTO_MESSAGE_TYPE}") {
      if (typeof d.index === "number") show(d.index);
      else if (d.slide != null) {
        var want = String(d.slide);
        var hit = slides.findIndex(function(s){ return String(s.getAttribute("data-slide") || "") === want; });
        if (hit >= 0) show(hit);
      } else if (d.delta === 1 || d.delta === -1) show(i + d.delta);
    }
  });
})();`;

/**
 * 父页读不到无源 iframe 的 contentDocument，只能让页内自己探 WebGL。
 * 探完立刻 loseContext，避免占掉 GPU 上下文槽位害 three.js 自己建不出来。
 */
export const WEBGL_PROBE_SOURCE = `(function(){
  if (window.__agentWebglProbed) return;
  window.__agentWebglProbed = true;
  var ok = false;
  try {
    var c = document.createElement("canvas");
    c.width = 1;
    c.height = 1;
    var gl = c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl");
    ok = Boolean(gl);
    if (gl) {
      var lose = gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
    }
  } catch (e) {}
  parent.postMessage({ type: "${WEBGL_STATUS_MESSAGE_TYPE}", ok: ok }, "*");
})();`;

/** 新窗口打印：加载后调起系统打印对话框（另存为 PDF 由系统对话框完成）。 */
export const PRINT_HOOK_SOURCE = `(function(){
  if (window.__agentPrintHooked) return;
  window.__agentPrintHooked = true;
  function go(){
    try { window.focus(); window.print(); } catch (e) {}
  }
  if (document.readyState === "complete") setTimeout(go, 200);
  else window.addEventListener("load", function(){ setTimeout(go, 200); });
})();`;

export function stripScripts(html) {
  return String(html ?? "").replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
}

function appendScriptHook(html, source) {
  const raw = String(html ?? "");
  const hook = `<script>${source}</script>`;
  if (/<\/body>/i.test(raw)) return raw.replace(/<\/body>/i, `${hook}</body>`);
  return `${raw}${hook}`;
}

/** 在完整 HTML 末尾注入点选钩子（保留页面自带脚本——整站点评需要它们）。 */
export function appendInspectHook(html) {
  return appendScriptHook(html, INSPECT_HOOK_SOURCE);
}

/** 注入幻灯翻页 runtime（无 .slide 时脚本自行 no-op）。 */
export function appendDeckRuntime(html) {
  return appendScriptHook(html, DECK_RUNTIME_SOURCE);
}

export function appendPrintHook(html) {
  return appendScriptHook(html, PRINT_HOOK_SOURCE);
}

export function appendWebglProbe(html) {
  return appendScriptHook(html, WEBGL_PROBE_SOURCE);
}

function appendHeadTag(html, tag) {
  const raw = String(html ?? "");
  if (/<\/head>/i.test(raw)) return raw.replace(/<\/head>/i, `${tag}</head>`);
  if (/<html\b[^>]*>/i.test(raw)) return raw.replace(/<html\b[^>]*>/i, (m) => `${m}${tag}`);
  return `${tag}${raw}`;
}

function appendBodySnippet(html, snippet) {
  const raw = String(html ?? "");
  if (/<\/body>/i.test(raw)) return raw.replace(/<\/body>/i, `${snippet}</body>`);
  return `${raw}${snippet}`;
}

/**
 * 稿面有 TeX 且没自带渲染器时，注入本机 KaTeX（与 deck runtime 同族：
 * 旧产物不用改文件）。已有 katex/MathJax 的稿不重复注入。
 */
export function appendKatexRuntime(html) {
  const raw = String(html ?? "");
  if (pageHasMathRenderer(raw) || !htmlHasTexDelimiters(raw)) return raw;
  let out = appendHeadTag(raw, `<link rel="stylesheet" href="${KATEX_CSS_HREF}">`);
  const hooks = [
    `<script src="${KATEX_JS_HREF}"></script>`,
    `<script src="${KATEX_AUTO_HREF}"></script>`,
    `<script type="module" src="${KATEX_RUNTIME_HREF}"></script>`,
  ].join("");
  return appendBodySnippet(out, hooks);
}

/**
 * 整站 HTML 响应钩子：按需叠加 deck / inspect / print；TeX 缺渲染器时再叠 KaTeX。
 * @param {string} html
 * @param {{ deck?: boolean, inspect?: boolean, print?: boolean, katex?: boolean, webgl?: boolean }} opts
 */
export function appendHiddenAttrFix(html) {
  const raw = String(html ?? "");
  if (raw.includes('id="agent-hidden-fix"')) return raw;
  return appendHeadTag(raw, HIDDEN_ATTR_FIX_TAG);
}

export function appendSiteHooks(html, opts = {}) {
  let out = appendHiddenAttrFix(String(html ?? ""));
  if (opts.deck) out = appendDeckRuntime(out);
  if (opts.inspect) out = appendInspectHook(out);
  if (opts.print) out = appendPrintHook(out);
  if (opts.webgl !== false) out = appendWebglProbe(out);
  if (opts.katex !== false) out = appendKatexRuntime(out);
  return out;
}

/**
 * 单文件/离线注入：剥脚本后再挂钩子（旧 srcdoc 路径与单测）。
 * 整站点评请用 appendInspectHook，不要剥页面脚本。
 */
export function injectInspectHook(html) {
  return appendInspectHook(stripScripts(html));
}

/** 归一化坐标 → 整数百分比，写进点评行给人读。 */
export function pct(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, Math.round(x * 100)));
}

export function pathLength(points) {
  const pts = Array.isArray(points) ? points : [];
  let n = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = Number(pts[i].x) - Number(pts[i - 1].x);
    const dy = Number(pts[i].y) - Number(pts[i - 1].y);
    if (Number.isFinite(dx) && Number.isFinite(dy)) n += Math.hypot(dx, dy);
  }
  return n;
}

export function strokeBounds(strokes) {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  let count = 0;
  for (const s of strokes ?? []) {
    for (const p of s.points ?? []) {
      const x = Number(p.x);
      const y = Number(p.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      count += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (!count) return null;
  return { x0: minX, y0: minY, x1: maxX, y1: maxY };
}

export function formatImageReview({ comment, pins, strokes } = {}) {
  const note = String(comment ?? "").replace(/\s+/g, " ").trim();
  const drawn = Array.isArray(strokes) ? strokes.filter((s) => (s.points?.length ?? 0) > 0) : [];
  const bounds = strokeBounds(drawn);
  const pin = Array.isArray(pins) ? pins.find((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y)) : null;
  let loc = "图片";
  if (drawn.length > 0 && bounds) {
    loc = `图片标注 ${drawn.length} 笔 (${pct(bounds.x0)}%,${pct(bounds.y0)}%–${pct(bounds.x1)}%,${pct(bounds.y1)}%)`;
  } else if (pin) {
    loc = `图片 ${pct(pin.x)}%,${pct(pin.y)}%`;
  }
  return note ? `[点评] ${loc}: ${note}` : `[点评] ${loc}`;
}

export function pointFromPointer(el, clientX, clientY) {
  if (!el || typeof el.getBoundingClientRect !== "function") return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return {
    x: Math.max(0, Math.min(1, (clientX - r.left) / r.width)),
    y: Math.max(0, Math.min(1, (clientY - r.top) / r.height)),
  };
}

/**
 * 在图片外包一层画布：拖动画圈，短点按钉点。坐标归一化到 0–1，写进输入框而不是另存图。
 * @returns {{ strokes:()=>any[], pins:()=>any[], undo:()=>void, clear:()=>void, destroy:()=>void }|null}
 */
export function attachImageAnnotator(wrap, opts = {}) {
  if (!wrap) return null;
  const doc = wrap.ownerDocument ?? document;
  const img = wrap.querySelector("img.ac-image") ?? wrap.querySelector("img");
  if (!img) return null;
  wrap.classList.add("ac-image-wrap--annotate");
  const canvas = doc.createElement("canvas");
  canvas.className = "ac-annotate-canvas";
  canvas.setAttribute("aria-label", "在图上画圈标注");
  wrap.appendChild(canvas);

  /** @type {{points:{x:number,y:number}[]}[]} */
  const strokes = [];
  /** @type {{x:number,y:number}[]} */
  const pins = [];
  /** @type {{points:{x:number,y:number}[]}|null} */
  let current = null;
  let drawing = false;

  function paintStroke(ctx, points) {
    if (!points.length) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x * canvas.width, points[0].y * canvas.height);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x * canvas.width, points[i].y * canvas.height);
    }
    ctx.stroke();
  }

  function redraw() {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#B0522F";
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const s of strokes) paintStroke(ctx, s.points);
    if (current) paintStroke(ctx, current.points);
    ctx.fillStyle = "#B0522F";
    for (const p of pins) {
      ctx.beginPath();
      ctx.arc(p.x * canvas.width, p.y * canvas.height, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function sizeCanvas() {
    const w = Math.max(1, img.clientWidth || wrap.clientWidth || 1);
    const h = Math.max(1, img.clientHeight || wrap.clientHeight || 1);
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.style.left = `${img.offsetLeft}px`;
    canvas.style.top = `${img.offsetTop}px`;
    redraw();
  }

  function emit() {
    opts.onChange?.({ strokes: strokes.slice(), pins: pins.slice() });
  }

  function onDown(event) {
    const pt = pointFromPointer(canvas, event.clientX, event.clientY);
    if (!pt) return;
    drawing = true;
    current = { points: [pt] };
    try { canvas.setPointerCapture?.(event.pointerId); } catch { /* jsdom */ }
    event.preventDefault();
  }

  function onMove(event) {
    if (!drawing || !current) return;
    const pt = pointFromPointer(canvas, event.clientX, event.clientY);
    if (!pt) return;
    current.points.push(pt);
    redraw();
  }

  function onUp() {
    if (!drawing || !current) return;
    drawing = false;
    if (pathLength(current.points) < 0.03) {
      pins.push(current.points[0]);
    } else {
      strokes.push(current);
    }
    current = null;
    redraw();
    emit();
  }

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  img.addEventListener("load", sizeCanvas);
  sizeCanvas();

  return {
    element: canvas,
    strokes: () => strokes.slice(),
    pins: () => pins.slice(),
    undo() {
      if (strokes.length) strokes.pop();
      else if (pins.length) pins.pop();
      redraw();
      emit();
    },
    clear() {
      strokes.length = 0;
      pins.length = 0;
      redraw();
      emit();
    },
    destroy() {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      img.removeEventListener("load", sizeCanvas);
      canvas.remove();
      wrap.classList.remove("ac-image-wrap--annotate");
    },
  };
}

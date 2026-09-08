/**
 * features/review-mode — 网站预览里的点评。
 *
 * 沙箱 iframe 没有 allow-same-origin，父页读不到 contentDocument。
 * 正解：把 HTML 取成文本、剥掉它自带的 script，注入我们的点选钩子，再用 srcdoc 打开。
 * 点选经 postMessage 回来；selector / 文案当不可信字符串，只写进输入框。
 */

export const INSPECT_MESSAGE_TYPE = "agent-inspect-pick";

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

export function formatReviewComment(selector, comment) {
  const sel = String(selector ?? "").trim() || "(未识别)";
  const note = String(comment ?? "").replace(/\s+/g, " ").trim();
  return note ? `[点评] ${sel}: ${note}` : `[点评] ${sel}`;
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

/** iframe 内运行：只 postMessage，不碰父页。 */
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
  document.documentElement.setAttribute("data-agent-inspect", "1");
  document.documentElement.style.cursor = "crosshair";
  document.addEventListener("click", function(ev){
    ev.preventDefault();
    ev.stopPropagation();
    var t = ev.target;
    if (!t || t === document.documentElement || t === document.body) return;
    var text = String(t.innerText || t.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80);
    parent.postMessage({
      type: "${INSPECT_MESSAGE_TYPE}",
      selector: sel(t),
      tag: String(t.tagName || "").toLowerCase(),
      text: text
    }, "*");
  }, true);
})();`;

export function stripScripts(html) {
  return String(html ?? "").replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
}

export function injectInspectHook(html) {
  const stripped = stripScripts(html);
  const hook = `<script>${INSPECT_HOOK_SOURCE}</script>`;
  if (/<\/body>/i.test(stripped)) return stripped.replace(/<\/body>/i, `${hook}</body>`);
  return `${stripped}${hook}`;
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

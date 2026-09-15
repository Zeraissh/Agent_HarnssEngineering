/**
 * features/review-mode — 网站预览里的点评。
 *
 * 沙箱 iframe 没有 allow-same-origin，父页读不到 contentDocument，不能
 * 事后把 script 塞进已打开的文档。正解：`/site/*` 每次出 HTML 都注入
 * **休眠**点评 runtime（跟 deck / WebGL 探针同族）；父页点「点评」只
 * postMessage `agent-inspect-set`，不要改 iframe.src。`?inspect=1` 只表示
 * 开机即开（换文件重挂时沿用），不是进入点评的必经导航。
 * 点选经 postMessage 回来；selector / 文案当不可信字符串，只写进输入框。
 * 三维页（FOUP / liquid-demo）：钩子包一层 THREE.WebGLRenderer.render
 * 记下 scene/camera，也认 window.scene / app.scene / 页内 WebGLRenderer，
 * 不要求页面改源码挂 THREE。射线打可见 mesh；跳过 material.visible=false
 * 的隐形拾取盒、Helper。空 Group 落到最近的可见后代。CSS2D / `.label`
 * 点标签：绑到对象就点对象，没绑就点评标签自己，不当透明穿透。
 * `.atmos` / loading 仍穿透。侧栏 / HUD / 按钮仍走 DOM，不当三维。
 * 翻页也走同一条路：注入 runtime 收 goto、在 iframe 里切可见页。不读
 * contentDocument，因此不需要放宽 same-origin。
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
export const INSPECT_SET_MESSAGE_TYPE = "agent-inspect-set";
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

export function isInspectSet(data) {
  return Boolean(
    data
    && typeof data === "object"
    && data.type === INSPECT_SET_MESSAGE_TYPE
    && typeof data.on === "boolean",
  );
}

/** 侧栏 / HUD / 按钮是页面 chrome，点评点它们走 DOM，不拿去射三维。 */
export function isReviewChrome(el) {
  if (!el || typeof el.closest !== "function") return false;
  if (el.closest(".labels, .label, .atmos, .tip, #agent-inspect-ring")) return false;
  return Boolean(el.closest(".panel, .hud, header, footer, nav, button, a, input, textarea, select, [data-review-ignore]"));
}

/** CSS 标注 / CSS2D 标签：要点它自己或它绑的对象，不当透明层。 */
export function isReviewLabel(el) {
  if (!el || typeof el.closest !== "function") return false;
  return Boolean(el.closest(".label, [data-review-label]"));
}

/** 大气层、载入遮罩、标注层空档：挡在 canvas 上，点评时应穿透去射三维。标签本身不是 overlay。 */
export function isReviewOverlay(el) {
  if (!el || typeof el.closest !== "function") return false;
  if (isReviewLabel(el)) return false;
  return Boolean(el.closest("#agent-inspect-ring, .atmos, .labels, .tip, .loading, .fallback, [data-review-overlay]"));
}

/** FOUP 槽位拾取盒用 visible:false 的材质；射中它不等于看见了形体。 */
export function shouldSkipInvisibleMaterial(obj) {
  if (!obj) return true;
  if (obj.visible === false) return true;
  const mat = obj.material;
  if (!mat) return false;
  if (Array.isArray(mat)) return mat.every((m) => m && m.visible === false);
  return mat.visible === false;
}

/** Helper / Gizmo / CSS2D 本体不当成被点中的形体（标签走 DOM/绑定，不走这条）。 */
export function isReviewHelper(obj) {
  if (!obj) return true;
  const t = String(obj.type || "");
  return /Helper|Gizmo|TransformControls/.test(t) || Boolean(obj.isCSS2DObject || obj.isCSS3DObject);
}

/** 看得见的体积：Mesh 族 + geometry + 可见材质。空 Group / 隐形盒不算。 */
export function isVisibleReviewMesh(obj) {
  if (!obj || obj.visible === false) return false;
  if (isReviewHelper(obj) || shouldSkipInvisibleMaterial(obj)) return false;
  if (!(obj.isMesh || obj.isInstancedMesh || obj.isSkinnedMesh)) return false;
  return Boolean(obj.geometry && obj.material);
}

function object3dWorldPos(obj) {
  if (!obj) return { x: 0, y: 0, z: 0 };
  if (typeof obj.getWorldPosition === "function") {
    try {
      const out = obj.getWorldPosition({ x: 0, y: 0, z: 0 });
      if (out) return { x: Number(out.x) || 0, y: Number(out.y) || 0, z: Number(out.z) || 0 };
    } catch {
      /* ignore */
    }
  }
  let x = 0;
  let y = 0;
  let z = 0;
  let n = obj;
  let depth = 0;
  while (n && depth < 16) {
    const p = n.position;
    if (p) {
      x += Number(p.x) || 0;
      y += Number(p.y) || 0;
      z += Number(p.z) || 0;
    }
    n = n.parent;
    depth += 1;
  }
  return { x, y, z };
}

function dist3(a, b) {
  const dx = (a?.x || 0) - (b?.x || 0);
  const dy = (a?.y || 0) - (b?.y || 0);
  const dz = (a?.z || 0) - (b?.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 空 Group / 只有变换的节点：落到空间上最近的可见后代 mesh。
 * `opts.from` 缺省用节点自身世界坐标（点隐形盒时用命中点）。
 */
export function nearestVisibleDescendant(root, opts = {}) {
  if (!root) return null;
  if (isVisibleReviewMesh(root)) return root;
  const from = opts.from || object3dWorldPos(root);
  let best = null;
  let bestD = Infinity;
  const stack = Array.isArray(root.children) ? root.children.slice() : [];
  const seen = typeof WeakSet === "function" ? new WeakSet() : null;
  let steps = 0;
  while (stack.length && steps++ < 400) {
    const n = stack.shift();
    if (!n || n.visible === false) continue;
    if (seen) {
      if (seen.has(n)) continue;
      seen.add(n);
    }
    if (isVisibleReviewMesh(n)) {
      const d = dist3(from, object3dWorldPos(n));
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    if (Array.isArray(n.children) && n.children.length) {
      for (const child of n.children) stack.push(child);
    }
  }
  return best;
}

/** 点到空 Group / 隐形盒时收成可见后代；已经是可见 mesh 则原样返回。 */
export function resolveReviewObject3d(obj, opts = {}) {
  if (!obj) return null;
  if (isVisibleReviewMesh(obj)) return obj;
  const from = opts.from;
  if (obj.parent && !obj.parent.isScene && (shouldSkipInvisibleMaterial(obj) || !obj.geometry)) {
    return nearestVisibleDescendant(obj.parent, { from }) || nearestVisibleDescendant(obj, { from });
  }
  return nearestVisibleDescendant(obj, { from });
}

/** 射线命中列表：跳过 Helper / 隐形盒，空节点落到最近可见后代。 */
export function pickVisibleRayHit(hits) {
  const list = Array.isArray(hits) ? hits : [];
  for (const hit of list) {
    const obj = hit && hit.object;
    if (!obj || isReviewHelper(obj)) continue;
    if (shouldSkipInvisibleMaterial(obj) || !isVisibleReviewMesh(obj)) {
      const vis = resolveReviewObject3d(obj, { from: hit.point });
      if (vis) return vis;
      continue;
    }
    return obj;
  }
  return null;
}

function isNamedReviewGroup(n) {
  if (!n || n.isScene) return false;
  if (!(n.isGroup || n.type === "Group")) return false;
  const ud = n.userData || {};
  if (ud.reviewId || ud.slot != null) return true;
  const name = String(n.name || "").trim();
  return Boolean(name && !/^(Object3D|Group|Scene)$/i.test(name));
}

/**
 * 射线没打到 mesh 时：用有名 Group 的包围盒（含可见后代）再收一次。
 * 匿名空 Group 不抢背景点击。
 */
export function nearestGroupMeshAlongRay(scene, ray, THREE) {
  if (!scene || !ray || !THREE || typeof THREE.Box3 !== "function") return null;
  const box = new THREE.Box3();
  const target = typeof THREE.Vector3 === "function" ? new THREE.Vector3() : { x: 0, y: 0, z: 0 };
  let best = null;
  let bestD = Infinity;
  const visit = (n) => {
    if (!n || n.visible === false) return;
    if (isNamedReviewGroup(n)) {
      const mesh = nearestVisibleDescendant(n, { from: ray.origin });
      if (mesh && typeof box.setFromObject === "function") {
        box.setFromObject(n);
        const empty = typeof box.isEmpty === "function" && box.isEmpty();
        if (!empty && typeof ray.intersectBox === "function" && ray.intersectBox(box, target)) {
          const d = dist3(ray.origin || { x: 0, y: 0, z: 0 }, target);
          if (d < bestD) {
            bestD = d;
            best = mesh;
          }
        }
      }
    }
    const kids = n.children || [];
    for (const child of kids) visit(child);
  };
  visit(scene);
  return best;
}

function isSceneLike(o) {
  return Boolean(o && typeof o === "object" && (o.isScene === true || o.type === "Scene"));
}

function isCameraLike(o) {
  return Boolean(o && typeof o === "object" && (o.isCamera === true || /Camera$/.test(String(o.type || ""))));
}

function isRendererLike(o) {
  return Boolean(
    o
    && typeof o === "object"
    && (o.isWebGLRenderer === true || (o.domElement && typeof o.render === "function")),
  );
}

function isThreeLib(o) {
  return Boolean(o && typeof o === "object" && typeof o.Raycaster === "function" && o.Vector2);
}

const THREE_CONTEXT_BAGS = ["app", "App", "viewer", "world", "game", "stage", "demo", "engine", "threeApp", "foup", "main"];
const THREE_CONTEXT_SKIP = new Set([
  "parent", "top", "frames", "self", "window", "document", "location",
  "navigator", "performance", "console", "localStorage", "sessionStorage",
  "history", "speechSynthesis", "chrome", "external",
]);

function takeThreeFromBag(bag, acc, canvas) {
  if (!bag || typeof bag !== "object") return;
  if (!acc.THREE && isThreeLib(bag.THREE)) acc.THREE = bag.THREE;
  if (!acc.THREE && isThreeLib(bag.three)) acc.THREE = bag.three;
  if (!acc.THREE && isThreeLib(bag)) acc.THREE = bag;
  if (!acc.scene && isSceneLike(bag.scene)) acc.scene = bag.scene;
  if (!acc.camera && isCameraLike(bag.camera)) acc.camera = bag.camera;
  if (!acc.renderer && isRendererLike(bag.renderer)) acc.renderer = bag.renderer;
  if (!acc.scene && isSceneLike(bag)) acc.scene = bag;
  if (!acc.camera && isCameraLike(bag)) acc.camera = bag;
  if (isRendererLike(bag)) {
    if (canvas && bag.domElement === canvas) acc.renderer = bag;
    else if (!acc.renderer) acc.renderer = bag;
  }
}

/** 找 THREE 命名空间：window.THREE / window.three / 常见袋里的 THREE。 */
export function findThreeLib(root = globalThis) {
  const acc = { THREE: null, scene: null, camera: null, renderer: null };
  takeThreeFromBag(root, acc);
  if (acc.THREE) return acc.THREE;
  if (!root || typeof root !== "object") return null;
  for (const key of THREE_CONTEXT_BAGS) {
    try {
      takeThreeFromBag(root[key], acc);
    } catch {
      /* ignore */
    }
    if (acc.THREE) return acc.THREE;
  }
  try {
    const keys = Object.keys(root);
    for (let i = 0; i < keys.length && i < 80; i++) {
      if (THREE_CONTEXT_SKIP.has(keys[i])) continue;
      let v;
      try { v = root[keys[i]]; } catch { continue; }
      if (isThreeLib(v)) return v;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 找 scene / camera / renderer，不要求页面改源码挂 window.THREE。
 * 认 window.scene、app.scene、挂着的 WebGLRenderer（含 canvas.domElement 对上的）。
 */
export function findThreeContext(root = globalThis, canvas) {
  const acc = { THREE: findThreeLib(root), scene: null, camera: null, renderer: null };
  const bags = [root];
  if (root && typeof root === "object") {
    for (const key of THREE_CONTEXT_BAGS) {
      try {
        const bag = root[key];
        if (bag && typeof bag === "object") bags.push(bag);
      } catch {
        /* ignore */
      }
    }
  }
  for (const bag of bags) takeThreeFromBag(bag, acc, canvas);
  if (root && typeof root === "object") {
    if (!acc.scene && isSceneLike(root.scene)) acc.scene = root.scene;
    if (!acc.camera && isCameraLike(root.camera)) acc.camera = root.camera;
    if (!acc.scene && root.app && isSceneLike(root.app.scene)) acc.scene = root.app.scene;
    if (!acc.camera && root.app && isCameraLike(root.app.camera)) acc.camera = root.app.camera;
  }
  if (canvas) {
    const attached = [canvas.__renderer, canvas._renderer, canvas.renderer];
    for (const r of attached) {
      if (isRendererLike(r)) acc.renderer = r;
    }
  }
  try {
    const keys = root && typeof root === "object" ? Object.keys(root) : [];
    for (let i = 0; i < keys.length && i < 80; i++) {
      if (THREE_CONTEXT_SKIP.has(keys[i])) continue;
      let v;
      try { v = root[keys[i]]; } catch { continue; }
      if (!v || typeof v !== "object") continue;
      takeThreeFromBag(v, acc, canvas);
      if (canvas && isRendererLike(v) && v.domElement === canvas) acc.renderer = v;
    }
  } catch {
    /* ignore */
  }
  if (canvas && acc.renderer && acc.renderer.domElement && acc.renderer.domElement !== canvas) {
    acc.renderer = null;
    for (const bag of bags) {
      if (isRendererLike(bag.renderer) && bag.renderer.domElement === canvas) acc.renderer = bag.renderer;
    }
  }
  const rend = acc.renderer;
  if (rend) {
    if (!acc.scene && isSceneLike(rend.__agentLastScene)) acc.scene = rend.__agentLastScene;
    if (!acc.camera && isCameraLike(rend.__agentLastCamera)) acc.camera = rend.__agentLastCamera;
    if (!acc.scene && isSceneLike(rend.scene)) acc.scene = rend.scene;
    if (!acc.camera && isCameraLike(rend.camera)) acc.camera = rend.camera;
  }
  return acc;
}

export function readLabelBinding(el) {
  if (!el) return null;
  const node = typeof el.closest === "function"
    ? (el.closest(".label, [data-review-label]") || el)
    : el;
  if (typeof node.getAttribute !== "function") return { el: node, reviewId: "", slot: "", target: "" };
  const reviewId = String(node.getAttribute("data-review-id") || "").trim();
  const slotRaw = node.getAttribute("data-slot") ?? node.getAttribute("data-review-slot");
  const target = String(
    node.getAttribute("data-target")
    || node.getAttribute("data-for")
    || node.getAttribute("data-object")
    || node.getAttribute("data-mesh")
    || "",
  ).trim();
  return { el: node, reviewId, slot: slotRaw == null ? "" : String(slotRaw), target };
}

function walkObject3d(root, pred) {
  if (!root) return null;
  let found = null;
  const visit = (n) => {
    if (!n || found) return;
    if (pred(n)) {
      found = n;
      return;
    }
    const kids = n.children || [];
    for (let i = 0; i < kids.length && !found; i++) visit(kids[i]);
  };
  visit(root);
  return found;
}

export function findObject3dByBinding(scene, binding) {
  if (!scene || !binding) return null;
  const rid = binding.reviewId ? String(binding.reviewId) : "";
  const slot = binding.slot;
  const target = binding.target ? String(binding.target) : "";
  if (!rid && (slot == null || slot === "") && !target) return null;
  return walkObject3d(scene, (n) => {
    const ud = n.userData || {};
    if (rid && String(ud.reviewId) === rid) return true;
    if (slot != null && slot !== "" && Number.isFinite(Number(slot)) && Number(ud.slot) === Number(slot)) return true;
    if (target && (n.name === target || String(ud.name ?? "") === target)) return true;
    return false;
  });
}

export function findCss2dOwner(scene, el) {
  if (!scene || !el) return null;
  return walkObject3d(scene, (n) => {
    if (!(n.isCSS2DObject || n.isCSS3DObject)) return false;
    const node = n.element;
    return Boolean(node && (node === el || (typeof node.contains === "function" && node.contains(el))));
  });
}

/** 点 CSS 标签：有绑定就收成三维对象（空 Group 再落到可见后代），没有就点评标签自己。 */
export function resolveLabelReview(el, scene) {
  if (!el) return null;
  const binding = readLabelBinding(el);
  const node = (binding && binding.el) || el;
  let start = findCss2dOwner(scene, node);
  if (start) {
    const ud = start.userData || {};
    const bound = ud.target || ud.object || (start.parent && !start.parent.isScene ? start.parent : null);
    start = bound || start;
  }
  if (!start) start = findObject3dByBinding(scene, binding);
  if (start) {
    const obj = resolveReviewObject3d(start) || start;
    return { kind: "mesh", mesh: formatObject3dReview(obj) };
  }
  return { kind: "dom", el: node };
}

/**
 * 三维命中 → 点评行用的 selector。优先 data-review-id / userData.reviewId / slot / 非泛名。
 * 空 Group 先由 resolveReviewObject3d 落到可见后代，再走这里向上收口。
 */
export function formatObject3dReview(obj) {
  if (!obj || typeof obj !== "object") return { selector: "mesh:(未识别)", text: "" };
  let n = obj;
  let depth = 0;
  while (n && depth < 8) {
    const reviewId = n.userData && n.userData.reviewId != null ? String(n.userData.reviewId).trim() : "";
    if (reviewId && /^[A-Za-z][\w-]*$/.test(reviewId)) {
      return { selector: `[data-review-id="${reviewId}"]`, text: reviewId };
    }
    if (n.userData && n.userData.slot != null && Number.isFinite(Number(n.userData.slot))) {
      const slot = Number(n.userData.slot);
      return { selector: `mesh:slot-${slot}`, text: `槽位 ${slot}` };
    }
    const name = String(n.name ?? "").trim();
    if (name && !/^(Object3D|Group|Mesh|Scene|Line|Points)$/i.test(name)) {
      const safe = name.replace(/[^\w.:-]/g, "").slice(0, 64);
      if (safe) return { selector: `mesh:${safe}`, text: name.slice(0, 80) };
    }
    n = n.parent;
    depth += 1;
  }
  const type = String(obj.type || "Mesh").replace(/[^\w]/g, "") || "Mesh";
  const geom = obj.geometry && obj.geometry.type ? String(obj.geometry.type).replace(/[^\w]/g, "") : "";
  return {
    selector: geom ? `mesh:${type}(${geom})` : `mesh:${type}`,
    text: type,
  };
}

/**
 * iframe 内点评 runtime。默认休眠；`startOn` 或收到 `agent-inspect-set` 才开。
 * 三维：包 WebGLRenderer.render，并找 window.scene / app.scene / WebGLRenderer；
 * 空 Group 落到可见后代；CSS 标签绑对象或点评自己。
 */
export function buildInspectHookSource(opts = {}) {
  const startOn = Boolean(opts.startOn);
  return `(function(){
  if (window.__agentInspectHooked) return;
  window.__agentInspectHooked = true;
  var startOn = ${startOn ? "true" : "false"};
  var enabled = false;
  var SET = "${INSPECT_SET_MESSAGE_TYPE}";
  var PICK = "${INSPECT_MESSAGE_TYPE}";
  function sel(el){
    if (!el || el.nodeType !== 1) return "";
    var rid = el.getAttribute && el.getAttribute("data-review-id");
    if (rid && /^[A-Za-z][\\w-]*$/.test(rid)) return '[data-review-id="' + rid + '"]';
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
  function isChrome(el){
    if (!el || !el.closest) return false;
    if (el.closest(".labels, .label, .atmos, .tip, #agent-inspect-ring")) return false;
    return Boolean(el.closest(".panel, .hud, header, footer, nav, button, a, input, textarea, select, [data-review-ignore]"));
  }
  function isLabel(el){
    if (!el || !el.closest) return false;
    return Boolean(el.closest(".label, [data-review-label]"));
  }
  function isOverlay(el){
    if (!el || !el.closest) return false;
    if (el.closest(".label, [data-review-label]")) return false;
    return Boolean(el.closest("#agent-inspect-ring, .atmos, .labels, .tip, .loading, .fallback, [data-review-overlay]"));
  }
  function skipInv(obj){
    if (!obj || obj.visible === false) return true;
    var mat = obj.material;
    if (!mat) return false;
    if (Object.prototype.toString.call(mat) === "[object Array]") {
      var all = true;
      for (var i = 0; i < mat.length; i++) if (!(mat[i] && mat[i].visible === false)) all = false;
      return all;
    }
    return mat.visible === false;
  }
  function isHelper(obj){
    var t = String(obj && obj.type || "");
    return /Helper|Gizmo|TransformControls/.test(t) || Boolean(obj && (obj.isCSS2DObject || obj.isCSS3DObject));
  }
  function isVisMesh(obj){
    if (!obj || obj.visible === false || skipInv(obj) || isHelper(obj)) return false;
    if (!(obj.isMesh || obj.isInstancedMesh || obj.isSkinnedMesh)) return false;
    return Boolean(obj.geometry && obj.material);
  }
  function wpos(obj){
    if (obj && typeof obj.getWorldPosition === "function") {
      try {
        var o = obj.getWorldPosition({ x:0, y:0, z:0 });
        if (o) return { x: +o.x || 0, y: +o.y || 0, z: +o.z || 0 };
      } catch (e) {}
    }
    var x=0,y=0,z=0,n=obj,d=0;
    while (n && d++ < 16) {
      var p = n.position;
      if (p) { x += +p.x || 0; y += +p.y || 0; z += +p.z || 0; }
      n = n.parent;
    }
    return { x:x, y:y, z:z };
  }
  function nearestVis(root, from){
    if (!root) return null;
    if (isVisMesh(root)) return root;
    var origin = from || wpos(root);
    var best=null, bestD=1e15;
    var stack = root.children ? root.children.slice() : [];
    var steps=0;
    while (stack.length && steps++ < 400) {
      var n = stack.shift();
      if (!n || n.visible === false) continue;
      if (isVisMesh(n)) {
        var p = wpos(n);
        var dx=origin.x-p.x, dy=origin.y-p.y, dz=origin.z-p.z;
        var dist = Math.sqrt(dx*dx+dy*dy+dz*dz);
        if (dist < bestD) { bestD=dist; best=n; }
      }
      if (n.children && n.children.length) {
        for (var ci=0;ci<n.children.length;ci++) stack.push(n.children[ci]);
      }
    }
    return best;
  }
  function resolve3d(obj, from){
    if (!obj) return null;
    if (isVisMesh(obj)) return obj;
    if (obj.parent && !obj.parent.isScene && (skipInv(obj) || !obj.geometry)) {
      return nearestVis(obj.parent, from) || nearestVis(obj, from);
    }
    return nearestVis(obj, from);
  }
  function pickHits(hits){
    for (var hi=0; hi<hits.length; hi++) {
      var h = hits[hi], obj = h && h.object;
      if (!obj || isHelper(obj)) continue;
      if (skipInv(obj) || !isVisMesh(obj)) {
        var vis = resolve3d(obj, h.point);
        if (vis) return vis;
        continue;
      }
      return obj;
    }
    return null;
  }
  function describe3d(obj){
    var n = obj, depth = 0;
    while (n && depth < 8) {
      var ud = n.userData || {};
      var rid = ud.reviewId != null ? String(ud.reviewId).trim() : "";
      if (rid && /^[A-Za-z][\\w-]*$/.test(rid)) return { selector: '[data-review-id="' + rid + '"]', text: rid };
      if (ud.slot != null && isFinite(Number(ud.slot))) return { selector: "mesh:slot-" + Number(ud.slot), text: "槽位 " + Number(ud.slot) };
      var name = String(n.name || "").trim();
      if (name && !/^(Object3D|Group|Mesh|Scene|Line|Points)$/i.test(name)) {
        var safe = name.replace(/[^\\w.:-]/g, "").slice(0, 64);
        if (safe) return { selector: "mesh:" + safe, text: name.slice(0, 80) };
      }
      n = n.parent;
      depth++;
    }
    var type = String(obj.type || "Mesh").replace(/[^\\w]/g, "") || "Mesh";
    var geom = obj.geometry && obj.geometry.type ? String(obj.geometry.type).replace(/[^\\w]/g, "") : "";
    return { selector: geom ? "mesh:" + type + "(" + geom + ")" : "mesh:" + type, text: type };
  }
  function isScn(o){ return Boolean(o && (o.isScene || o.type === "Scene")); }
  function isCam(o){ return Boolean(o && (o.isCamera || /Camera$/.test(String(o.type||"")))); }
  function isRend(o){ return Boolean(o && (o.isWebGLRenderer || (o.domElement && typeof o.render === "function"))); }
  function isLib(o){ return Boolean(o && typeof o.Raycaster === "function" && o.Vector2); }
  var hookedRenderers = [];
  function findCtx(canvas){
    var root = window;
    var THREE = isLib(root.THREE) ? root.THREE : (isLib(root.three) ? root.three : null);
    var scene=null, camera=null, renderer=null;
    if (isScn(window.scene) || isScn(root.scene)) scene = window.scene || root.scene;
    if (isCam(window.camera) || isCam(root.camera)) camera = window.camera || root.camera;
    if (isRend(root.renderer)) renderer = root.renderer;
    if (!scene && root.app && isScn(root.app.scene)) scene = root.app.scene;
    if (!camera && root.app && isCam(root.app.camera)) camera = root.app.camera;
    if (!renderer && root.app && isRend(root.app.renderer)) renderer = root.app.renderer;
    var bags = ["app","App","viewer","world","game","stage","demo","engine","threeApp","foup","main"];
    for (var bi=0; bi<bags.length; bi++) {
      var bag; try { bag = root[bags[bi]]; } catch (e) { bag = null; }
      if (!bag || typeof bag !== "object") continue;
      if (!THREE && isLib(bag.THREE)) THREE = bag.THREE;
      if (!scene && isScn(bag.scene)) scene = bag.scene;
      if (!camera && isCam(bag.camera)) camera = bag.camera;
      if (!renderer && isRend(bag.renderer)) renderer = bag.renderer;
    }
    try {
      var keys = Object.keys(root);
      for (var k=0; k<keys.length && k<80; k++) {
        if (/^(parent|top|frames|self|window|document|location|navigator|performance|console)$/.test(keys[k])) continue;
        var v; try { v = root[keys[k]]; } catch (e) { continue; }
        if (!v || typeof v !== "object") continue;
        if (!THREE && isLib(v)) THREE = v;
        if (!scene && isScn(v)) scene = v;
        if (!camera && isCam(v)) camera = v;
        if (isRend(v) && (!canvas || v.domElement === canvas)) renderer = v;
        if (!scene && isScn(v.scene)) scene = v.scene;
        if (!camera && isCam(v.camera)) camera = v.camera;
        if (!renderer && isRend(v.renderer)) renderer = v.renderer;
      }
    } catch (e) {}
    if (canvas) {
      var att = [canvas.__renderer, canvas._renderer, canvas.renderer];
      for (var ai=0; ai<att.length; ai++) if (isRend(att[ai])) renderer = att[ai];
    }
    if (renderer) {
      if (!scene && isScn(renderer.__agentLastScene)) scene = renderer.__agentLastScene;
      if (!camera && isCam(renderer.__agentLastCamera)) camera = renderer.__agentLastCamera;
      if (hookedRenderers.indexOf(renderer) < 0) hookedRenderers.push(renderer);
    }
    return { THREE: THREE, scene: scene, camera: camera, renderer: renderer };
  }
  function wrapRender(target){
    if (!target || target.__agentInspectRender || typeof target.render !== "function") return;
    target.__agentInspectRender = true;
    var orig = target.render;
    target.render = function(scene, camera){
      this.__agentLastScene = scene;
      this.__agentLastCamera = camera;
      if (hookedRenderers.indexOf(this) < 0) hookedRenderers.push(this);
      return orig.apply(this, arguments);
    };
  }
  function hookThree(){
    var ctx = findCtx();
    if (ctx.renderer) {
      wrapRender(ctx.renderer);
      if (ctx.renderer.constructor && ctx.renderer.constructor.prototype) wrapRender(ctx.renderer.constructor.prototype);
    }
    var THREE = ctx.THREE;
    if (THREE && THREE.WebGLRenderer && THREE.WebGLRenderer.prototype) wrapRender(THREE.WebGLRenderer.prototype);
    return Boolean(THREE || (ctx.scene && ctx.camera));
  }
  var threeTries = 0;
  (function waitThree(){
    if (hookThree() || threeTries++ > 80) return;
    setTimeout(waitThree, 50);
  })();
  function rendererFor(canvas){
    for (var i = 0; i < hookedRenderers.length; i++) {
      if (hookedRenderers[i].domElement === canvas) return hookedRenderers[i];
    }
    return hookedRenderers[0] || null;
  }
  function namedGroup(n){
    if (!n || n.isScene) return false;
    if (!(n.isGroup || n.type === "Group")) return false;
    var ud = n.userData || {};
    if (ud.reviewId || ud.slot != null) return true;
    var name = String(n.name || "").trim();
    return Boolean(name && !/^(Object3D|Group|Scene)$/i.test(name));
  }
  function pickGroupBox(scene, ray, THREE){
    if (!scene || !ray || !THREE || typeof THREE.Box3 !== "function") return null;
    var box = new THREE.Box3();
    var target = THREE.Vector3 ? new THREE.Vector3() : { x:0, y:0, z:0 };
    var best=null, bestD=1e15;
    function visit(n){
      if (!n || n.visible === false) return;
      if (namedGroup(n)) {
        var mesh = nearestVis(n, ray.origin);
        if (mesh && typeof box.setFromObject === "function") {
          box.setFromObject(n);
          var empty = typeof box.isEmpty === "function" && box.isEmpty();
          if (!empty && ray.intersectBox && ray.intersectBox(box, target)) {
            var o = ray.origin || { x:0, y:0, z:0 };
            var dx=o.x-target.x, dy=o.y-target.y, dz=o.z-target.z;
            var d = Math.sqrt(dx*dx+dy*dy+dz*dz);
            if (d < bestD) { bestD=d; best=mesh; }
          }
        }
      }
      var kids = n.children || [];
      for (var gi=0; gi<kids.length; gi++) visit(kids[gi]);
    }
    visit(scene);
    return best;
  }
  function pickWebgl(canvas, cx, cy){
    hookThree();
    var ctx = findCtx(canvas);
    var THREE = ctx.THREE;
    var scene = ctx.scene;
    var camera = ctx.camera;
    var rend = rendererFor(canvas) || ctx.renderer;
    if (rend) {
      if (!scene) scene = rend.__agentLastScene;
      if (!camera) camera = rend.__agentLastCamera;
    }
    if (!THREE || !THREE.Raycaster || !scene || !camera) return null;
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    var ndc = new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
    var ray = new THREE.Raycaster();
    if (typeof ray.setFromCamera !== "function") return null;
    ray.setFromCamera(ndc, camera);
    var hits = ray.intersectObjects(scene.children || [], true);
    var obj = pickHits(hits);
    if (!obj) obj = pickGroupBox(scene, ray, THREE);
    if (!obj) return null;
    return describe3d(obj);
  }
  function walkFind(scene, pred){
    var found=null;
    function visit(n){
      if (!n || found) return;
      if (pred(n)) { found=n; return; }
      var kids=n.children||[];
      for (var wi=0; wi<kids.length && !found; wi++) visit(kids[wi]);
    }
    visit(scene);
    return found;
  }
  function cssOwner(scene, el){
    if (!scene || !el) return null;
    return walkFind(scene, function(n){
      if (!(n.isCSS2DObject || n.isCSS3DObject)) return false;
      var node = n.element;
      return Boolean(node && (node === el || (node.contains && node.contains(el))));
    });
  }
  function bindObj(scene, el){
    if (!scene || !el || !el.getAttribute) return null;
    var node = el.closest ? (el.closest(".label, [data-review-label]") || el) : el;
    var rid = String(node.getAttribute("data-review-id") || "").trim();
    var slot = node.getAttribute("data-slot");
    if (slot == null) slot = node.getAttribute("data-review-slot");
    var target = String(node.getAttribute("data-target") || node.getAttribute("data-for") || node.getAttribute("data-object") || node.getAttribute("data-mesh") || "").trim();
    return walkFind(scene, function(n){
      var ud = n.userData || {};
      if (rid && String(ud.reviewId) === rid) return true;
      if (slot != null && slot !== "" && isFinite(Number(slot)) && Number(ud.slot) === Number(slot)) return true;
      if (target && (n.name === target || String(ud.name) === target)) return true;
      return false;
    });
  }
  function resolveLabel(el, scene){
    var node = (el && el.closest && el.closest(".label, [data-review-label]")) || el;
    var start = cssOwner(scene, node);
    if (start) {
      var ud = start.userData || {};
      var bound = ud.target || ud.object || (start.parent && !start.parent.isScene ? start.parent : null);
      start = bound || start;
    }
    if (!start) start = bindObj(scene, node);
    if (start) {
      var obj = resolve3d(start) || start;
      return { kind: "mesh", mesh: describe3d(obj), el: node };
    }
    return { kind: "dom", el: node };
  }
  function stackAt(ev){
    var list = [];
    try {
      if (document.elementsFromPoint) list = document.elementsFromPoint(ev.clientX, ev.clientY) || [];
    } catch (e) {}
    if (!list.length && ev.target) list = [ev.target];
    return list;
  }
  function resolvePick(ev){
    var stack = stackAt(ev);
    var canvas = null;
    var chrome = null;
    var dom = null;
    var label = null;
    for (var i = 0; i < stack.length; i++) {
      var el = stack[i];
      if (!el || el.id === "agent-inspect-ring") continue;
      if (el.tagName === "CANVAS") { canvas = el; break; }
      if (isChrome(el)) { chrome = el; break; }
      if (isLabel(el)) { label = el; break; }
      if (isOverlay(el)) continue;
      if (el.nodeType === 1 && el !== document.documentElement && el !== document.body) {
        dom = el;
        break;
      }
    }
    if (!canvas) {
      for (var j = 0; j < stack.length; j++) if (stack[j] && stack[j].tagName === "CANVAS") { canvas = stack[j]; break; }
    }
    if (chrome) return { kind: "dom", el: chrome };
    var scene = findCtx(canvas).scene;
    if (label) return resolveLabel(label, scene);
    if (dom && scene && cssOwner(scene, dom)) return resolveLabel(dom, scene);
    if (canvas) {
      var mesh = pickWebgl(canvas, ev.clientX, ev.clientY);
      if (mesh) return { kind: "mesh", mesh: mesh, canvas: canvas, x: ev.clientX, y: ev.clientY };
      if (dom && !isOverlay(dom) && !isChrome(dom) && !isLabel(dom)) return { kind: "dom", el: dom };
      return { kind: "dom", el: canvas };
    }
    return dom ? { kind: "dom", el: dom } : null;
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
  function showRingAt(x, y){
    ensureRing();
    var s = 16;
    ring.style.display = "block";
    ring.style.top = Math.max(0, y - s) + "px";
    ring.style.left = Math.max(0, x - s) + "px";
    ring.style.width = (s * 2) + "px";
    ring.style.height = (s * 2) + "px";
  }
  function setEnabled(on){
    enabled = !!on;
    if (enabled) {
      document.documentElement.setAttribute("data-agent-inspect", "1");
      document.documentElement.style.cursor = "crosshair";
      hookThree();
    } else {
      document.documentElement.removeAttribute("data-agent-inspect");
      document.documentElement.style.cursor = "";
      hideRing();
    }
  }
  var pinUntil = 0;
  document.addEventListener("mousemove", function(ev){
    if (!enabled || Date.now() < pinUntil) return;
    var hit = resolvePick(ev);
    if (!hit) { hideRing(); return; }
    if (hit.kind === "mesh") {
      if (hit.el) showRing(hit.el);
      else showRingAt(hit.x, hit.y);
    } else showRing(hit.el);
  }, true);
  document.addEventListener("mouseleave", function(){
    if (!enabled || Date.now() < pinUntil) return;
    hideRing();
  }, true);
  document.addEventListener("scroll", function(){
    if (!enabled || Date.now() < pinUntil) return;
    hideRing();
  }, true);
  window.addEventListener("resize", function(){
    if (!enabled || Date.now() < pinUntil) return;
    hideRing();
  }, true);
  document.addEventListener("click", function(ev){
    if (!enabled) return;
    ev.preventDefault();
    ev.stopPropagation();
    var hit = resolvePick(ev);
    if (!hit) return;
    pinUntil = Date.now() + 2500;
    if (hit.kind === "mesh") {
      if (hit.el) showRing(hit.el);
      else showRingAt(hit.x, hit.y);
      parent.postMessage({
        type: PICK,
        selector: hit.mesh.selector,
        tag: "mesh",
        text: hit.mesh.text,
        slide: undefined
      }, "*");
      return;
    }
    var t = hit.el;
    showRing(t);
    var text = String(t.innerText || t.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80);
    var slideEl = t.closest ? t.closest(".slide[data-slide]") : null;
    var slide = slideEl && slideEl.getAttribute ? String(slideEl.getAttribute("data-slide") || "").trim() : "";
    parent.postMessage({
      type: PICK,
      selector: sel(t),
      tag: String(t.tagName || "").toLowerCase(),
      text: text,
      slide: slide || undefined
    }, "*");
  }, true);
  window.addEventListener("message", function(ev){
    var d = ev && ev.data;
    if (!d || typeof d !== "object") return;
    if (d.type === SET && typeof d.on === "boolean") setEnabled(d.on);
  });
  ensureRing();
  if (startOn) setEnabled(true);
})();`;
}

/** 默认源（开机即开）——旧 srcdoc / 单测仍认这段字符串。 */
export const INSPECT_HOOK_SOURCE = buildInspectHookSource({ startOn: true });

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
export function appendInspectHook(html, opts = {}) {
  const startOn = opts.startOn === undefined ? true : Boolean(opts.startOn);
  return appendScriptHook(html, buildInspectHookSource({ startOn }));
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
  if (opts.inspectRuntime !== false) out = appendInspectHook(out, { startOn: Boolean(opts.inspect) });
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

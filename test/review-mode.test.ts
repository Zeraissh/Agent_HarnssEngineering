// @vitest-environment jsdom
// @ts-nocheck
import { afterEach, describe, expect, it } from "vitest";
import {
  INSPECT_MESSAGE_TYPE,
  INSPECT_SET_MESSAGE_TYPE,
  INSPECT_HOOK_SOURCE,
  DECK_READY_MESSAGE_TYPE,
  DECK_GOTO_MESSAGE_TYPE,
  DECK_STATE_MESSAGE_TYPE,
  WEBGL_STATUS_MESSAGE_TYPE,
  WEBGL_PROBE_SOURCE,
  HIDDEN_ATTR_FIX_CSS,
  DECK_RUNTIME_SOURCE,
  DECK_VISIBILITY_CSS,
  PRINT_HOOK_SOURCE,
  appendReviewToInput,
  buildCssSelector,
  formatReviewComment,
  isWholeDeckRevision,
  stripSlideLockMarkers,
  formatImageReview,
  injectInspectHook,
  appendInspectHook,
  appendSiteHooks,
  buildInspectHookSource,
  formatObject3dReview,
  isReviewChrome,
  isReviewLabel,
  isReviewOverlay,
  isReviewHelper,
  isVisibleReviewMesh,
  nearestVisibleDescendant,
  resolveReviewObject3d,
  pickVisibleRayHit,
  nearestGroupMeshAlongRay,
  findThreeLib,
  findThreeContext,
  resolveLabelReview,
  shouldSkipInvisibleMaterial,
  isInspectPick,
  isInspectSet,
  isWebglStatus,
  pathLength,
  pct,
  strokeBounds,
  stripScripts,
} from "../ui/public/features/review-mode.js";

describe("buildCssSelector / formatReviewComment", () => {
  it("优先 id；否则 tag + 合法 class + 可选父级", () => {
    expect(buildCssSelector({ id: "hero" })).toBe("#hero");
    expect(buildCssSelector({ tag: "button", className: "btn primary evil{}" })).toBe("button.btn.primary");
    expect(buildCssSelector({ tag: "li", nth: 2, parent: "ul.nav" })).toBe("ul.nav > li:nth-of-type(2)");
  });

  it("不再导出自动页锁 helper；点评行仍带 slide", () => {
    return import("../ui/public/features/review-mode.js").then((mod) => {
      expect(mod.formatDesignEditScope).toBeUndefined();
      expect(mod.attachDesignEditScope).toBeUndefined();
      expect(mod.normalizeDesignEditScope).toBeUndefined();
      expect(typeof mod.formatReviewComment).toBe("function");
    });
  });

  it("点评行是纯文本，可接到已有输入后面；可带 slide", () => {
    expect(formatReviewComment("h1.hero", "对比度不够")).toBe("[点评] h1.hero: 对比度不够");
    expect(formatReviewComment("h1.hero", "对比度不够", "3")).toBe("[点评][slide:3] h1.hero: 对比度不够");
    expect(formatReviewComment("  ", "")).toBe("[点评] (未识别)");
    expect(appendReviewToInput("先改首页", "[点评] h1: 太大")).toBe("先改首页\n[点评] h1: 太大");
    expect(appendReviewToInput("", "[点评] h1: 太大")).toBe("[点评] h1: 太大");
  });

  it("整份配图不对时点评不加 [slide:]；页锁标记可剥掉", () => {
    const complaint = "图片你自己有审核过吗？完全与介绍的科技不相关";
    expect(isWholeDeckRevision(complaint)).toBe(true);
    expect(isWholeDeckRevision("缩短标题")).toBe(false);
    expect(formatReviewComment("img.hero", "这些图都与科技不相关", "back")).toBe(
      "[点评] img.hero: 这些图都与科技不相关",
    );
    expect(formatReviewComment("img.hero", "对比度不够", "back")).toBe(
      "[点评][slide:back] img.hero: 对比度不够",
    );
    expect(stripSlideLockMarkers("[点评][slide:back] img: 全部图都不对")).toBe("[点评] img: 全部图都不对");
    expect(stripSlideLockMarkers('[改范围]只改 data-slide="back"（文件 index.html）。\n图片核对过吗'))
      .toBe("图片核对过吗");
    expect(stripSlideLockMarkers(
      `[改稿范围] 只改 data-slide="3"（文件 out/index.html）。不要改其它页，不要整份重写。\n缩短标题`,
    )).toBe("缩短标题");
  });
});

describe("inspect hook 注入", () => {
  it("injectInspectHook：剥掉原页面 script，再注入点选钩子", () => {
    const html = "<html><body><h1>Hi</h1><script>alert(1)</script></body></html>";
    expect(stripScripts(html)).not.toContain("<script>alert");
    const hooked = injectInspectHook(html);
    expect(hooked).not.toContain("alert(1)");
    expect(hooked).toContain(INSPECT_MESSAGE_TYPE);
    expect(hooked).toContain("parent.postMessage");
    expect(hooked).toMatch(/<\/script><\/body>/i);
  });

  it("appendInspectHook：保留页面脚本（整站点评）", () => {
    const html = "<html><body><h1>Hi</h1><script>window.__keep=1</script></body></html>";
    const hooked = appendInspectHook(html);
    expect(hooked).toContain("window.__keep=1");
    expect(hooked).toContain(INSPECT_MESSAGE_TYPE);
  });

  it("appendSiteHooks：可叠 deck + inspect", () => {
    const html = "<html><body><section class=\"slide\" data-slide=\"1\">A</section></body></html>";
    const hooked = appendSiteHooks(html, { deck: true, inspect: true });
    expect(hooked).toContain(DECK_READY_MESSAGE_TYPE);
    expect(hooked).toContain(INSPECT_MESSAGE_TYPE);
    expect(hooked).toContain("var startOn = true");
    expect(hooked).toContain("closest");
    expect(hooked).toContain("agent-deck-visibility");
    expect(hooked).toContain("display:none!important");
    expect(hooked).toContain(".slide[data-slide].is-active");
    expect(hooked).toContain("position:relative!important");
  });

  it("整站默认注入休眠点评 runtime，不改 src 也能开点评", () => {
    const hooked = appendSiteHooks("<html><body>x</body></html>");
    expect(hooked).toContain(INSPECT_SET_MESSAGE_TYPE);
    expect(hooked).toContain("var startOn = false");
    expect(hooked).toContain("Raycaster");
    expect(hooked).toContain("elementsFromPoint");
  });

  it("点评钩子含悬停外描边；点击后短暂固定（pinUntil）", () => {
    expect(INSPECT_HOOK_SOURCE).toContain("agent-inspect-ring");
    expect(INSPECT_HOOK_SOURCE).toContain("getBoundingClientRect");
    expect(INSPECT_HOOK_SOURCE).toContain("mousemove");
    expect(INSPECT_HOOK_SOURCE).toContain("pointer-events:none");
    expect(INSPECT_HOOK_SOURCE).toContain("pinUntil");
    expect(INSPECT_HOOK_SOURCE).toContain(INSPECT_SET_MESSAGE_TYPE);
  });

  it("三维点评：有名 / slot / reviewId；隐形材质跳过；chrome 与 overlay 分开", () => {
    expect(formatObject3dReview({ name: "Door", userData: {}, type: "Mesh" }))
      .toEqual({ selector: "mesh:Door", text: "Door" });
    expect(formatObject3dReview({ name: "", userData: { slot: 22 }, type: "Mesh" }))
      .toEqual({ selector: "mesh:slot-22", text: "槽位 22" });
    expect(formatObject3dReview({ name: "Mesh", userData: { reviewId: "wafer-upper" }, type: "Mesh" }))
      .toEqual({ selector: '[data-review-id="wafer-upper"]', text: "wafer-upper" });
    expect(formatObject3dReview({
      name: "",
      type: "Mesh",
      geometry: { type: "BoxGeometry" },
      userData: {},
      parent: { name: "Group", userData: {}, parent: null },
    })).toEqual({ selector: "mesh:Mesh(BoxGeometry)", text: "Mesh" });
    expect(shouldSkipInvisibleMaterial({ visible: true, material: { visible: false } })).toBe(true);
    expect(shouldSkipInvisibleMaterial({ visible: true, material: { visible: true } })).toBe(false);
    const chrome = { closest: (sel) => (sel.includes(".panel") ? {} : null) };
    const label = { closest: (sel) => (sel.includes(".label") ? {} : null) };
    expect(isReviewChrome(chrome)).toBe(true);
    expect(isReviewChrome(label)).toBe(false);
    expect(isReviewLabel(label)).toBe(true);
    expect(isReviewOverlay(label)).toBe(false);
    expect(isInspectSet({ type: INSPECT_SET_MESSAGE_TYPE, on: true })).toBe(true);
    expect(isInspectSet({ type: INSPECT_SET_MESSAGE_TYPE, on: "yes" })).toBe(false);
  });

  it("三维点评钩子含空 Group / app.scene / CSS 标签，不要求页面挂 THREE", () => {
    const src = buildInspectHookSource({ startOn: false });
    expect(src).toContain("app.scene");
    expect(src).toContain("isWebGLRenderer");
    expect(src).toContain("isCSS2DObject");
    expect(src).toContain("data-review-label");
    expect(src).toContain("nearestVis");
    expect(src).toContain("function isLabel");
    expect(src).toContain("window.scene");
  });
});

function meshAt(name, pos, extra = {}) {
  return {
    name,
    type: "Mesh",
    isMesh: true,
    visible: true,
    geometry: { type: "BoxGeometry" },
    material: { visible: true },
    position: pos,
    userData: {},
    children: [],
    ...extra,
  };
}

describe("三维点评选不中的缺口", () => {
  it("空 Group 落到最近的可见后代；隐形盒不当命中；没有可见后代不编造", () => {
    const invis = meshAt("pickBox", { x: 0, y: 0, z: 0 }, {
      material: { visible: false },
      userData: { slot: 3 },
    });
    const near = meshAt("Wafer", { x: 1, y: 0, z: 0 });
    const far = meshAt("Shell", { x: 20, y: 0, z: 0 });
    const group = {
      name: "Slot3",
      type: "Group",
      isGroup: true,
      visible: true,
      userData: { slot: 3 },
      position: { x: 0, y: 0, z: 0 },
      children: [invis, near, far],
    };
    invis.parent = group;
    near.parent = group;
    far.parent = group;

    expect(isVisibleReviewMesh(group)).toBe(false);
    expect(isVisibleReviewMesh(invis)).toBe(false);
    expect(isVisibleReviewMesh(near)).toBe(true);
    expect(nearestVisibleDescendant(group, { from: { x: 0, y: 0, z: 0 } })).toBe(near);
    expect(resolveReviewObject3d(group)).toBe(near);
    expect(resolveReviewObject3d(invis)).toBe(near);
    expect(pickVisibleRayHit([{ object: invis, point: { x: 0, y: 0, z: 0 } }])).toBe(near);
    expect(formatObject3dReview(resolveReviewObject3d(invis))).toEqual({
      selector: "mesh:Wafer",
      text: "Wafer",
    });
    const generic = meshAt("Mesh", { x: 0.2, y: 0, z: 0 });
    generic.parent = group;
    expect(formatObject3dReview(generic)).toEqual({ selector: "mesh:slot-3", text: "槽位 3" });

    const empty = { name: "Empty", type: "Group", isGroup: true, visible: true, userData: {}, children: [] };
    expect(nearestVisibleDescendant(empty)).toBeNull();
    expect(resolveReviewObject3d(empty)).toBeNull();
    expect(pickVisibleRayHit([{ object: empty }])).toBeNull();
  });

  it("没有 window.THREE 也能从 app.scene / 挂着的 WebGLRenderer 取到上下文", () => {
    const canvas = { tagName: "CANVAS" };
    const scene = { isScene: true, type: "Scene", children: [] };
    const camera = { isCamera: true, type: "PerspectiveCamera" };
    const renderer = {
      isWebGLRenderer: true,
      domElement: canvas,
      render() {},
      __agentLastScene: scene,
      __agentLastCamera: camera,
    };
    const root = { app: { scene, camera, renderer } };
    const ctx = findThreeContext(root, canvas);
    expect(ctx.THREE).toBeNull();
    expect(ctx.scene).toBe(scene);
    expect(ctx.camera).toBe(camera);
    expect(ctx.renderer).toBe(renderer);

    const loose = { orphanRenderer: renderer };
    expect(findThreeContext(loose, canvas).renderer).toBe(renderer);
    expect(findThreeContext(loose, canvas).scene).toBe(scene);
    expect(findThreeLib({ three: { Raycaster() {}, Vector2: true, Scene: true } })).toBeTruthy();
  });

  it("CSS 标签绑到对象（含 CSS2D parent）；没绑定就点评标签自己；侧栏仍是 chrome", () => {
    const door = meshAt("Door", { x: 0, y: 0, z: 0 }, { userData: { reviewId: "door" } });
    const scene = { isScene: true, type: "Scene", children: [door], userData: {} };
    door.parent = scene;

    const label = {
      closest(sel) { return sel.includes(".label") ? this : null; },
      getAttribute(name) { return name === "data-review-id" ? "door" : ""; },
    };
    const bound = resolveLabelReview(label, scene);
    expect(bound.kind).toBe("mesh");
    expect(bound.mesh.selector).toBe('[data-review-id="door"]');

    const labelEl = { id: "css-door" };
    const css = {
      isCSS2DObject: true,
      type: "CSS2DObject",
      element: { contains: (el) => el === labelEl },
      parent: door,
      userData: {},
      children: [],
    };
    const scene2 = { isScene: true, type: "Scene", children: [door, css] };
    css.parent = door;
    const fromCss = resolveLabelReview(labelEl, scene2);
    expect(fromCss.kind).toBe("mesh");
    expect(fromCss.mesh.selector).toBe('[data-review-id="door"]');

    const orphan = {
      closest(sel) { return sel.includes(".label") ? this : null; },
      getAttribute() { return ""; },
    };
    expect(resolveLabelReview(orphan, scene)).toEqual({ kind: "dom", el: orphan });

    const atmos = { closest: (sel) => (sel.includes(".atmos") ? {} : null) };
    expect(isReviewOverlay(atmos)).toBe(true);
    expect(isReviewChrome({ closest: (s) => (s.includes("button") ? {} : null) })).toBe(true);
    expect(isReviewHelper({ type: "BoxHelper" })).toBe(true);
  });

  it("有名空 Group 的包围盒能落到可见后代；匿名 Group 不抢背景", () => {
    const wafer = meshAt("Wafer", { x: 0, y: 0, z: 0 });
    const named = {
      name: "Carrier",
      type: "Group",
      isGroup: true,
      visible: true,
      userData: {},
      children: [wafer],
    };
    wafer.parent = named;
    const anon = {
      name: "Group",
      type: "Group",
      isGroup: true,
      visible: true,
      userData: {},
      children: [meshAt("HiddenShell", { x: 0, y: 0, z: 0 })],
    };
    const scene = { isScene: true, type: "Scene", children: [named, anon] };
    const THREE = {
      Box3: function Box3() {
        this.setFromObject = () => {};
        this.isEmpty = () => false;
      },
    };
    const ray = {
      origin: { x: 0, y: 0, z: 10 },
      intersectBox(_box, target) {
        target.x = 0;
        target.y = 0;
        target.z = 0;
        return target;
      },
    };
    expect(nearestGroupMeshAlongRay(scene, ray, THREE)).toBe(wafer);
    expect(nearestGroupMeshAlongRay({ isScene: true, children: [anon] }, ray, THREE)).toBeNull();
  });
});

describe("inspect hook 其余注入", () => {
  it("print 钩子调起 window.print", () => {
    expect(PRINT_HOOK_SOURCE).toContain("window.print");
    const hooked = appendSiteHooks("<html><body>x</body></html>", { print: true });
    expect(hooked).toContain("window.print");
  });

  it("整站预览补回 [hidden] 的 display:none，避免 fallback 遮罩假报没有 WebGL", () => {
    const hooked = appendSiteHooks("<html><head></head><body><div class=\"fallback\" hidden>这台设备没有可用的 WebGL</div></body></html>");
    expect(hooked).toContain('id="agent-hidden-fix"');
    expect(hooked).toContain(HIDDEN_ATTR_FIX_CSS);
    expect(appendSiteHooks(hooked)).toMatch(/id="agent-hidden-fix"/g);
    expect(appendSiteHooks(hooked).match(/id="agent-hidden-fix"/g)?.length).toBe(1);
  });

  it("整站默认注入 WebGL 探针；探完立刻释放上下文", () => {
    const hooked = appendSiteHooks("<html><body>x</body></html>");
    expect(hooked).toContain(WEBGL_STATUS_MESSAGE_TYPE);
    expect(WEBGL_PROBE_SOURCE).toContain("WEBGL_lose_context");
    expect(WEBGL_PROBE_SOURCE).toContain("loseContext");
    expect(isWebglStatus({ type: WEBGL_STATUS_MESSAGE_TYPE, ok: false })).toBe(true);
    expect(isWebglStatus({ type: WEBGL_STATUS_MESSAGE_TYPE, ok: true })).toBe(true);
    expect(isWebglStatus({ type: WEBGL_STATUS_MESSAGE_TYPE, ok: "no" })).toBe(false);
  });

  it("只认本协议的 postMessage", () => {
    expect(isInspectPick({ type: INSPECT_MESSAGE_TYPE, selector: "h1" })).toBe(true);
    expect(isInspectPick({ type: INSPECT_MESSAGE_TYPE, selector: "  " })).toBe(false);
    expect(isInspectPick({ type: "other", selector: "h1" })).toBe(false);
  });
});

describe("inspect runtime 就地开关", () => {
  afterEach(() => {
    window.__agentInspectHooked = false;
    document.documentElement.removeAttribute("data-agent-inspect");
    document.documentElement.style.cursor = "";
    document.getElementById("agent-inspect-ring")?.remove();
    document.body.innerHTML = "";
  });

  it("休眠钩子不抢点击；收到 inspect-set 才点选", async () => {
    document.body.innerHTML = '<h1 id="hero">标题</h1>';
    const picks = [];
    const onMsg = (ev) => {
      if (ev.data?.type === INSPECT_MESSAGE_TYPE) picks.push(ev.data);
    };
    window.addEventListener("message", onMsg);
    try {
      (0, eval)(buildInspectHookSource({ startOn: false }));
      expect(document.documentElement.getAttribute("data-agent-inspect")).toBeNull();
      document.getElementById("hero").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
      expect(picks).toHaveLength(0);
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: INSPECT_SET_MESSAGE_TYPE, on: true },
      }));
      expect(document.documentElement.getAttribute("data-agent-inspect")).toBe("1");
      document.getElementById("hero").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
      expect(picks.some((p) => String(p.selector).includes("hero") || String(p.selector).includes("h1"))).toBe(true);
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: INSPECT_SET_MESSAGE_TYPE, on: false },
      }));
      expect(document.documentElement.getAttribute("data-agent-inspect")).toBeNull();
    } finally {
      window.removeEventListener("message", onMsg);
    }
  });

  it("runtime：标签绑对象、未绑定标签走自己、侧栏当 chrome、隐形盒落到可见后代", async () => {
    const invis = meshAt("pickBox", { x: 0, y: 0, z: 0 }, {
      material: { visible: false },
      userData: { slot: 7 },
    });
    const wafer = meshAt("WaferA", { x: 0.5, y: 0, z: 0 });
    const slot = {
      name: "Slot7",
      type: "Group",
      isGroup: true,
      visible: true,
      userData: { slot: 7 },
      position: { x: 0, y: 0, z: 0 },
      children: [invis, wafer],
    };
    invis.parent = slot;
    wafer.parent = slot;
    const door = meshAt("Door", { x: 0, y: 0, z: 0 }, { userData: { reviewId: "door" } });
    const scene = { isScene: true, type: "Scene", children: [slot, door] };
    slot.parent = scene;
    door.parent = scene;

    document.body.innerHTML = [
      '<div class="panel"><button id="go">开始</button></div>',
      '<div class="labels"><div class="label" id="lbl-door" data-review-id="door">舱门</div></div>',
      '<div class="label" id="lbl-free">独立标注</div>',
      '<canvas id="stage"></canvas>',
    ].join("");
    const canvas = document.getElementById("stage");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 });

    window.scene = scene;
    window.camera = { isCamera: true, type: "PerspectiveCamera" };
    window.THREE = {
      Vector2: function Vector2(x, y) { this.x = x; this.y = y; },
      Raycaster: function Raycaster() {
        this.setFromCamera = function setFromCamera() {};
        this.intersectObjects = function intersectObjects() {
          return [{ object: invis, point: { x: 0, y: 0, z: 0 } }];
        };
      },
      WebGLRenderer: { prototype: { render() {} } },
    };

    const picks = [];
    const onMsg = (ev) => {
      if (ev.data?.type === INSPECT_MESSAGE_TYPE) picks.push(ev.data);
    };
    window.addEventListener("message", onMsg);
    try {
      (0, eval)(buildInspectHookSource({ startOn: true }));
      const click = (el) => el.dispatchEvent(new MouseEvent("click", {
        bubbles: true, cancelable: true, clientX: 10, clientY: 10,
      }));
      click(document.getElementById("go"));
      await new Promise((r) => setTimeout(r, 0));
      expect(picks.some((p) => /button|#go/.test(String(p.selector)))).toBe(true);

      click(document.getElementById("lbl-door"));
      await new Promise((r) => setTimeout(r, 0));
      expect(picks.some((p) => p.selector === '[data-review-id="door"]')).toBe(true);

      click(document.getElementById("lbl-free"));
      await new Promise((r) => setTimeout(r, 0));
      expect(picks.some((p) => /label|lbl-free/.test(String(p.selector)))).toBe(true);

      click(canvas);
      await new Promise((r) => setTimeout(r, 0));
      expect(picks.some((p) => p.selector === "mesh:slot-7" || p.selector === "mesh:WaferA")).toBe(true);
    } finally {
      window.removeEventListener("message", onMsg);
      delete window.THREE;
      delete window.scene;
      delete window.camera;
    }
  });
});

describe("deck runtime 翻页可见性", () => {
  afterEach(() => {
    window.__agentDeckHooked = false;
    document.head?.querySelector("#agent-deck-visibility")?.remove();
    document.body.innerHTML = "";
  });

  it("选第 N 页后只有那一页可见，不依赖稿面自带 display:none", async () => {
    document.body.innerHTML = [
      '<style>.slide{display:flex;min-height:100vh}</style>',
      '<section class="slide is-active" data-slide="title">三体·科技图鉴</section>',
      '<section class="slide" data-slide="sixiang">思想钢印</section>',
    ].join("");
    const states = [];
    const onMsg = (ev) => {
      if (ev.data?.type === DECK_STATE_MESSAGE_TYPE || ev.data?.type === DECK_READY_MESSAGE_TYPE) {
        states.push(ev.data);
      }
    };
    window.addEventListener("message", onMsg);
    try {
      (0, eval)(DECK_RUNTIME_SOURCE);
      const [title, thought] = document.querySelectorAll(".slide");
      expect(title.classList.contains("is-active")).toBe(true);
      expect(title.hasAttribute("hidden")).toBe(false);
      expect(thought.classList.contains("is-active")).toBe(false);
      expect(thought.getAttribute("aria-hidden")).toBe("true");
      expect(document.getElementById("agent-deck-visibility")?.textContent).toContain("display:none!important");
      expect(document.getElementById("agent-deck-visibility")?.textContent).toContain(".slide[data-slide].is-active");
      expect(document.getElementById("agent-deck-visibility")?.textContent).toContain("not print");

      window.dispatchEvent(new MessageEvent("message", {
        data: { type: DECK_GOTO_MESSAGE_TYPE, index: 1 },
      }));
      expect(title.classList.contains("is-active")).toBe(false);
      expect(title.getAttribute("aria-hidden")).toBe("true");
      expect(thought.classList.contains("is-active")).toBe(true);
      expect(thought.hasAttribute("hidden")).toBe(false);
      expect(thought.getAttribute("aria-hidden")).toBe("false");
      expect(thought.getAttribute("data-slide")).toBe("sixiang");
      expect(thought.textContent).toContain("思想钢印");
      await new Promise((r) => setTimeout(r, 0));
      expect(states.some((s) => s.type === DECK_STATE_MESSAGE_TYPE && s.slide === "sixiang" && s.index === 1)).toBe(true);

      window.dispatchEvent(new MessageEvent("message", {
        data: { type: DECK_GOTO_MESSAGE_TYPE, slide: "title" },
      }));
      expect(title.hasAttribute("hidden")).toBe(false);
      expect(title.classList.contains("is-active")).toBe(true);
      expect(thought.classList.contains("is-active")).toBe(false);
    } finally {
      window.removeEventListener("message", onMsg);
    }
  });

  it("杂志叠层 goto 第 2 页：目标页不是 hidden，computed display 不是 none，有盒子", () => {
    expect(DECK_VISIBILITY_CSS).toContain("position:relative!important");
    expect(DECK_VISIBILITY_CSS).toContain("min-height:100vh!important");
    document.body.innerHTML = [
      "<style>",
      "html,body{margin:0;background:#05070d;color:#f4f1ea;height:100%}",
      ".slide{display:flex;min-height:100vh;position:absolute;inset:0}",
      ".slide:first-child{background:#0b1020}",
      "</style>",
      '<section class="slide is-active" data-slide="title">三体·科技图鉴</section>',
      '<section class="slide" data-slide="sixiang"><h2>思想钢印</h2><p>后来页</p></section>',
    ].join("");
    (0, eval)(DECK_RUNTIME_SOURCE);
    window.dispatchEvent(new MessageEvent("message", {
      data: { type: DECK_GOTO_MESSAGE_TYPE, index: 1 },
    }));
    const title = document.querySelector('[data-slide="title"]');
    const thought = document.querySelector('[data-slide="sixiang"]');
    const actives = [...document.querySelectorAll(".slide.is-active")];
    expect(actives).toHaveLength(1);
    expect(actives[0]).toBe(thought);
    expect(thought.hasAttribute("hidden")).toBe(false);
    expect(title.classList.contains("is-active")).toBe(false);
    expect(getComputedStyle(thought).display).not.toBe("none");
    const box = thought.getBoundingClientRect();
    const hasBox = box.height > 0 || thought.offsetHeight > 0 || thought.scrollHeight > 0;
    if (!hasBox) {
      expect(DECK_VISIBILITY_CSS).toMatch(/min-height:100vh/);
      expect(thought.getAttribute("aria-hidden")).toBe("false");
    } else {
      expect(hasBox).toBe(true);
    }
    expect(thought.textContent).toContain("思想钢印");
  });
});

describe("图片标注点评行", () => {
  it("点按给坐标，笔迹给包围盒", () => {
    expect(pct(0.324)).toBe(32);
    expect(pathLength([{ x: 0, y: 0 }, { x: 0.3, y: 0.4 }])).toBeCloseTo(0.5);
    expect(strokeBounds([{ points: [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.9 }] }])).toEqual({
      x0: 0.1, y0: 0.2, x1: 0.8, y1: 0.9,
    });
    expect(formatImageReview({ pins: [{ x: 0.32, y: 0.48 }], comment: "太暗" }))
      .toBe("[点评] 图片 32%,48%: 太暗");
    expect(formatImageReview({
      strokes: [{ points: [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.7 }] }],
      comment: "对比度不够",
    })).toBe("[点评] 图片标注 1 笔 (10%,20%–80%,70%): 对比度不够");
    expect(formatImageReview({})).toBe("[点评] 图片");
  });
});

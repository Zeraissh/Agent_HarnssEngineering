/**
 * features/preview-dock — 预览停靠面板外壳（T10 形态升级）。
 *
 * 零依赖原生 ESM。产物画布（artifact-canvas）与文件预览（file-preview）共用
 * 这一份停靠外壳——「右侧拉出、可拖宽、可放大、Esc 两级、窄屏退化、宽度记忆」
 * 的逻辑只有一份，两处不许各写各的 chrome。
 *
 * 形态：
 *   - 停靠（默认）：面板是 #center-row 的 flex 子项，对话主列被压缩但仍
 *     可见、可滚动、可继续交互——边看预览边继续对话；
 *   - 放大：`.preview-dock--expanded` 切到 absolute inset:0，盖满整个主区
 *     （≈旧的覆盖形态）；按钮变「还原」；
 *   - 窄屏（≤900px，与 detail-rail 折叠同一断点）：CSS 媒体查询退化为覆盖式，
 *     拖拽柄与放大按钮同时隐藏；JS 侧 isNarrow() 负责禁拖拽/禁放大；
 *   - 覆盖变体（overlay:true，文件预览用）：absolute 钉在主区右侧，不占
 *     flex 位——它是瞬态预览，不该把对话挤窄；仍共用拖拽/放大/Esc 全部行为。
 *
 * 动画纪律与 settings/schedules 相同：只在 prefers-reduced-motion: no-preference
 * 下播放入场滑入与展开过渡；收起先播退出动画再隐藏（JS 计时与 CSS 时长同源，
 * reduced-motion 下 CSS 侧没有动画，JS 侧同样即时隐藏——判据只有一份，见
 * prefersReducedMotion()）。
 *
 * 安全边界不变：本模块只管外壳，产物内容的沙箱/转义纪律仍在
 * artifact-canvas.js 的 renderPreviewBody。
 */

// ---------------------------------------------------------------
// 常量与纯函数层
// ---------------------------------------------------------------

/** 拖拽调宽的允许区间（占主区宽度的比例）与默认值 */
export const DOCK_MIN_FRACTION = 0.3;
export const DOCK_MAX_FRACTION = 0.75;
export const DOCK_DEFAULT_FRACTION = 0.5;

/** 收起退出动画时长（与 styles.css 的 dock-slide-out 同源；reduced-motion 下不用） */
export const DOCK_CLOSE_ANIM_MS = 140;

/** 宽度记忆的 localStorage 键（产物画布与文件预览共一份偏好） */
export const DOCK_WIDTH_STORAGE_KEY = "agent-ui-preview-dock-width";

/** 窄屏断点（px）——与 detail-rail 折叠同一处先例 */
export const DOCK_NARROW_BP = 900;

/**
 * 拖拽比例钳制。非法输入回默认。
 * @param {number} fraction
 * @returns {number}
 */
export function clampDockFraction(fraction) {
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return DOCK_DEFAULT_FRACTION;
  return Math.min(DOCK_MAX_FRACTION, Math.max(DOCK_MIN_FRACTION, fraction));
}

/**
 * 从存储读宽度偏好。没有/损坏/越界都回默认——存储只是偏好，不是状态。
 * @param {Storage|null|undefined} storage
 * @param {string} [key]
 * @returns {number}
 */
export function readDockFraction(storage, key = DOCK_WIDTH_STORAGE_KEY) {
  try {
    const raw = storage?.getItem?.(key);
    if (raw == null) return DOCK_DEFAULT_FRACTION;
    return clampDockFraction(Number.parseFloat(raw));
  } catch {
    return DOCK_DEFAULT_FRACTION;
  }
}

/** 比例 → CSS 宽度字符串（保留一位小数，避免 33.333333% 这种噪声） */
export function formatDockWidth(fraction) {
  return `${(clampDockFraction(fraction) * 100).toFixed(1)}%`;
}

/**
 * 由指针位置算拖拽比例：面板钉在容器右缘，宽度 = 容器右缘 − 指针 x。
 * 容器宽度不可得（0/隐藏）时返回 null，调用方保持原宽度。
 * @param {{ clientX:number, containerRight:number, containerWidth:number }} p
 * @returns {number|null}
 */
export function dockFractionFromPointer(p) {
  const width = Number(p?.containerWidth);
  if (!Number.isFinite(width) || width <= 0) return null;
  return clampDockFraction((Number(p.containerRight) - Number(p.clientX)) / width);
}

// ---------------------------------------------------------------
// DOM 层
// ---------------------------------------------------------------

/**
 * 建一只预览停靠面板。幂等：同 id 重复调用返回既有实例。
 *
 * opts：
 *   id              → 根元素 id（幂等键）
 *   label           → aria-label
 *   overlay         → true 时为覆盖变体（absolute 钉右侧，不占 flex 位）
 *   extraClass      → 追加在根元素上的特征类（如 "artifact-canvas"）
 *   storageKey      → 宽度记忆键（默认 DOCK_WIDTH_STORAGE_KEY）
 *   onClose()       → 关闭按钮 / Esc（停靠态）时上报；路由归宿主，本模块不导航
 *   onExpandChange(expanded) → 放大/还原后上报（宿主可据此改写 hash 深链）
 *
 * env（测试注入）：doc / win / storage / isNarrow / closeAnimMs
 *
 * 返回：
 *   root / head / body / closeBtn / expandBtn
 *   insertHeadControl(el) → 把特征控件插进顶条（关闭键之后、放大键之前）
 *   open() / close() / isOpen()
 *   isExpanded() / setExpanded(b)
 *
 * @param {Record<string, any>} opts
 * @param {{ doc?:Document, win?:Window, storage?:Storage|null,
 *           isNarrow?:()=>boolean, closeAnimMs?:number }} [env]
 */
export function createPreviewDock(opts = {}, env = {}) {
  const doc = env.doc ?? document;
  const win = env.win ?? (doc.defaultView ?? window);
  const storage =
    env.storage !== undefined
      ? env.storage
      : (() => { try { return win.localStorage ?? null; } catch { return null; } })();
  const storageKey = String(opts.storageKey ?? DOCK_WIDTH_STORAGE_KEY);
  const closeAnimMs = env.closeAnimMs ?? DOCK_CLOSE_ANIM_MS;
  const isNarrow =
    typeof env.isNarrow === "function"
      ? env.isNarrow
      : () => Boolean(win.matchMedia?.(`(max-width: ${DOCK_NARROW_BP}px)`)?.matches);

  const id = String(opts.id ?? "preview-dock");
  const existing = doc.getElementById(id);
  if (existing && existing.__previewDockApi) return existing.__previewDockApi;

  /** reduced-motion 判据只有这一份：CSS 动画与 JS 收起计时都看它 */
  const prefersReducedMotion = () =>
    Boolean(win.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);

  // ---- 状态 ----
  let open = false;
  let expanded = false;
  let fraction = readDockFraction(storage, storageKey);
  /** 收起动画在途计时器：动画没播完又被打开时不许把面板藏起来 */
  let closeTimer = 0;
  /** @type {HTMLElement|null} */
  let restoreFocusTo = null;

  // ---- 骨架 ----
  const root = doc.createElement("section");
  root.id = id;
  root.className =
    `preview-dock${opts.overlay ? " preview-dock--overlay" : ""}` +
    (opts.extraClass ? ` ${opts.extraClass}` : "");
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", String(opts.label ?? "预览"));

  const handle = doc.createElement("div");
  handle.className = "pd-handle";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", "拖拽调整预览面板宽度");
  handle.title = "拖拽调整宽度";

  const head = doc.createElement("header");
  head.className = "ac-head pd-head";

  const closeBtn = doc.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn btn--ghost ac-close";
  closeBtn.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i><span>关闭</span>';
  closeBtn.setAttribute("aria-label", "关闭预览（Esc）");

  const expandBtn = doc.createElement("button");
  expandBtn.type = "button";
  expandBtn.className = "btn btn--ghost pd-expand";
  expandBtn.setAttribute("aria-pressed", "false");

  head.appendChild(closeBtn);

  const body = doc.createElement("div");
  body.className = "ac-body pd-body";

  root.appendChild(handle);
  root.appendChild(head);
  root.appendChild(body);
  // 停靠位是 #center-row（对话主列的横向容器）；测试/降级环境一路回退到 body
  const mount =
    doc.getElementById("center-row") ?? doc.getElementById("main-panel") ?? doc.body;
  mount?.appendChild(root);

  // ---- 宽度 ----
  function applyWidth() {
    root.style.width = formatDockWidth(fraction);
  }
  applyWidth();

  function persistWidth() {
    try {
      storage?.setItem?.(storageKey, String(fraction));
    } catch { /* 存储不可写只是丢偏好，不影响使用 */ }
  }

  // ---- 放大 / 还原 ----
  function syncExpandButton() {
    expandBtn.innerHTML = expanded
      ? '<i class="ph ph-arrows-in" aria-hidden="true"></i><span>还原</span>'
      : '<i class="ph ph-arrows-out" aria-hidden="true"></i><span>放大</span>';
    expandBtn.setAttribute("aria-pressed", expanded ? "true" : "false");
    expandBtn.setAttribute("aria-label", expanded ? "还原为停靠面板（Esc）" : "放大到整个主区");
  }
  syncExpandButton();

  /**
   * 放大/还原。窄屏下放大无意义（本来就是覆盖式），直接忽略。
   * @param {boolean} next
   */
  function setExpanded(next) {
    const target = Boolean(next);
    if (target && isNarrow()) return;
    if (expanded === target) return;
    expanded = target;
    root.classList.toggle("preview-dock--expanded", expanded);
    handle.hidden = expanded;
    syncExpandButton();
    opts.onExpandChange?.(expanded);
  }

  // ---- 开 / 关 ----
  function openDock() {
    if (closeTimer) {
      win.clearTimeout(closeTimer);
      closeTimer = 0;
      root.classList.remove("preview-dock--closing");
    }
    if (open) return;
    open = true;
    restoreFocusTo = /** @type {HTMLElement|null} */ (doc.activeElement);
    root.hidden = false;
    if (isNarrow()) root.classList.add("preview-dock--narrow");
    else root.classList.remove("preview-dock--narrow");
  }

  function finishClose() {
    closeTimer = 0;
    root.classList.remove("preview-dock--closing");
    root.hidden = true;
    body.innerHTML = "";
  }

  function closeDock() {
    if (!open) return;
    open = false;
    if (restoreFocusTo && typeof restoreFocusTo.focus === "function" && doc.contains?.(restoreFocusTo) !== false) {
      restoreFocusTo.focus();
    }
    restoreFocusTo = null;
    if (closeAnimMs > 0 && !prefersReducedMotion()) {
      root.classList.add("preview-dock--closing");
      closeTimer = win.setTimeout(finishClose, closeAnimMs);
    } else {
      finishClose();
    }
  }

  // ---- 拖拽调宽 ----
  handle.addEventListener("mousedown", (event) => {
    if (!open || expanded || isNarrow()) return;
    event.preventDefault();
    const container = root.parentElement;
    const rect = container?.getBoundingClientRect?.();
    root.classList.add("preview-dock--dragging");

    const onMove = (ev) => {
      const next = dockFractionFromPointer({
        clientX: ev.clientX,
        containerRight: rect?.right ?? 0,
        containerWidth: rect?.width ?? 0,
      });
      if (next == null) return;
      fraction = next;
      applyWidth();
    };
    const onUp = () => {
      root.classList.remove("preview-dock--dragging");
      doc.removeEventListener("mousemove", onMove);
      doc.removeEventListener("mouseup", onUp);
      persistWidth();
    };
    doc.addEventListener("mousemove", onMove);
    doc.addEventListener("mouseup", onUp);
  });

  // ---- 事件 ----
  closeBtn.addEventListener("click", () => opts.onClose?.());
  expandBtn.addEventListener("click", () => setExpanded(!expanded));

  // Esc 两级：放大态先还原，停靠态才上报关闭。只在开着时接管，关掉归还宿主。
  doc.addEventListener("keydown", (event) => {
    if (!open || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (expanded) setExpanded(false);
    else opts.onClose?.();
  });

  const api = {
    root,
    head,
    body,
    closeBtn,
    expandBtn,
    /** 特征控件插进顶条：关闭键之后、放大键之前（放大键恒在顶条最右） */
    insertHeadControl(el) {
      head.insertBefore(el, expandBtn.parentElement === head ? expandBtn : null);
      if (expandBtn.parentElement !== head) head.appendChild(expandBtn);
    },
    open: openDock,
    close: closeDock,
    isOpen: () => open,
    isExpanded: () => expanded,
    setExpanded,
    /** 当前宽度比例（测试与诊断用） */
    fraction: () => fraction,
  };
  // 顶条收尾：放大键永远在最右
  head.appendChild(expandBtn);
  root.__previewDockApi = api;
  return api;
}

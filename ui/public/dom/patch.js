/**
 * DOM 补丁应用器——`core/diff.js` 的执行侧。
 *
 * 唯一的硬规矩：**已存在 key 的节点永不重建，只更新**。
 * 一旦重建，节点里的输入值、光标位置、焦点、以及浏览器为它维护的滚动锚点
 * 全部清零。此前整个详情页每条事件重建一次 innerHTML，实测后果就是
 * 直播中根本没法在拒绝理由框里打字。
 */
import { diffKeyed } from "../core/diff.js";

/**
 * 键控列表补丁。
 * @param {HTMLElement} container
 * @param {any[]} items
 * @param {{
 *   key: (item:any)=>string,
 *   create: (item:any)=>HTMLElement,
 *   update?: (node:HTMLElement, item:any)=>void
 * }} spec
 */
export function patchList(container, items, spec) {
  const nodes = container.__patchNodes || (container.__patchNodes = new Map());
  const nextKeys = items.map(spec.key);
  const prevKeys = [...nodes.keys()];
  const byKey = new Map(items.map((it) => [spec.key(it), it]));

  const { removes } = diffKeyed(prevKeys, nextKeys);

  for (const key of removes) {
    const node = nodes.get(key);
    if (node && node.parentNode === container) container.removeChild(node);
    nodes.delete(key);
  }

  // 按目标顺序自后向前放置：每个节点都插到"已经就位的后继"之前。
  // 复用的节点若已在正确位置，insertBefore 是空操作，不会重建它。
  let anchor = null;
  for (let i = nextKeys.length - 1; i >= 0; i--) {
    const key = nextKeys[i];
    const item = byKey.get(key);
    let node = nodes.get(key);
    if (node) {
      spec.update?.(node, item);
    } else {
      node = spec.create(item);
      nodes.set(key, node);
    }
    if (node.nextSibling !== anchor || node.parentNode !== container) {
      container.insertBefore(node, anchor);
    }
    anchor = node;
  }
}

/**
 * 只追加的列表补丁——用于日志这种"只会在末尾增长"的流。
 *
 * 比 patchList 更省：不做差异计算，不碰任何已渲染的节点，因此
 * ① 展开/折叠状态与滚动位置天然保持；② 单次代价是 O(新增条数) 而非 O(总条数)，
 * 长运行下从 O(n²) 降到 O(n)。
 *
 * @param {HTMLElement} container
 * @param {any[]} entries 必须是单调追加的有序流
 * @param {{key:(e:any)=>string, create:(e:any)=>HTMLElement, update?:(node:HTMLElement,e:any)=>void}} spec
 */
export function appendOnly(container, entries, spec) {
  const nodes = container.__patchNodes || (container.__patchNodes = new Map());
  for (const entry of entries) {
    const key = spec.key(entry);
    const existing = nodes.get(key);
    if (existing) {
      spec.update?.(existing, entry);
      continue;
    }
    const node = spec.create(entry);
    nodes.set(key, node);
    container.appendChild(node);
  }
}

/** 只在真的变了才写——避免无谓的 DOM 变更与由此引发的重排 */
export function setText(node, text) {
  const s = text == null ? "" : String(text);
  if (node.textContent !== s) node.textContent = s;
}

/** 同上，属性版；value 为 null/undefined 时移除该属性 */
export function setAttr(node, name, value) {
  if (value === null || value === undefined || value === false) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
    return;
  }
  const s = String(value);
  if (node.getAttribute(name) !== s) node.setAttribute(name, s);
}

/** 只在真的变了才切 class，避免影响 CSS 过渡 */
export function setClass(node, name, on) {
  if (node.classList.contains(name) !== Boolean(on)) node.classList.toggle(name, Boolean(on));
}

/**
 * 在不得不重建节点的场合，保住焦点与光标。
 *
 * 靠 `data-fk`（focus key）认人——重建后的新节点带同一个 data-fk 即可接回焦点。
 * 这是兜底，不是主路径：主路径是根本不重建（patchList / appendOnly）。
 * @param {() => void} fn
 */
export function withFocusPreserved(fn) {
  const active = document.activeElement;
  const fk = active && active.getAttribute ? active.getAttribute("data-fk") : null;
  const selStart = active && "selectionStart" in active ? active.selectionStart : null;
  const selEnd = active && "selectionEnd" in active ? active.selectionEnd : null;

  fn();

  if (!fk) return;
  const restored = document.querySelector(`[data-fk="${cssEscape(fk)}"]`);
  if (!restored || restored === document.activeElement) return;
  restored.focus();
  if (selStart !== null && "setSelectionRange" in restored) {
    try {
      restored.setSelectionRange(selStart, selEnd ?? selStart);
    } catch {
      // 非文本类输入不支持选区，忽略
    }
  }
}

/**
 * 滚动跟随：贴底时保持贴底，否则不动用户的滚动位置。
 * 这是 GitHub Actions / Copilot 日志面板的标准行为——用户往上翻看历史时
 * 不该被新事件拽回底部。
 * @param {HTMLElement} scroller
 * @param {() => void} mutate
 * @param {number} [threshold] 距底多少像素内算"贴底"
 */
export function keepScrollAnchored(scroller, mutate, threshold = 40) {
  const pinned =
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= threshold;
  mutate();
  if (pinned) scroller.scrollTop = scroller.scrollHeight;
  return pinned;
}

/**
 * 视口锚定：一次会改变元素高度的补丁前后，让 `anchor` 在视口中的位置保持不变。
 *
 * 动机（委托方反馈）：审批栏在页面顶部，它一变高变矮，下面的全部内容就跟着
 * 平移——用户点一下"允许"，正在看的地方就被甩走了。`keepScrollAnchored` 解决
 * 的是另一件事（日志贴底跟随），这里要的是"别动我正在看的东西"。
 *
 * 做法是标准的 scroll anchoring：记下锚点相对视口的位置，补丁后按位移反向
 * 补偿 scrollTop。锚点应选在会变高的区域【下方】——那才是用户在读的内容。
 *
 * @param {HTMLElement} scroller 滚动容器
 * @param {HTMLElement} anchor   锚点元素（取其 getBoundingClientRect().top）
 * @param {() => void} mutate
 */
export function keepViewportAnchored(scroller, anchor, mutate, mode = "shrink") {
  if (!scroller || !anchor || typeof anchor.getBoundingClientRect !== "function") {
    mutate();
    return 0;
  }
  const before = anchor.getBoundingClientRect().top;
  mutate();
  const delta = anchor.getBoundingClientRect().top - before;

  /**
   * **只在内容变矮时补偿**（`mode="shrink"`，默认）。这条不对称是委托方实测
   * 反馈出来的，初版对称补偿反而更糟：
   *
   * - 上方区域**变高**（新审批卡冒出来）→ 锚点下移 → 对称补偿会把视口一起往下
   *   拉，于是顶部那张刚出现的、正等着人点的卡被推出视野。这恰好和人的意图相反：
   *   新出现的待办就是他要看的东西，**不该被藏起来**。
   * - 上方区域**变矮**（审批被应答、卡片离开待办区）→ 锚点上移 → 不补偿的话
   *   下面正在读的内容会整块往上跳一截。这才是需要压住的抖动。
   *
   * 一句话：**长高让它长，变矮才补偿。**
   */
  const shouldApply = mode === "both" ? delta !== 0 : delta < 0;
  // jsdom 里 rect 恒为 0，delta 恒为 0——真机才有效；helper 本身可注入锚点直测
  if (shouldApply) scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
  return shouldApply ? delta : 0;
}

/** CSS.escape 的最小替身（jsdom 里不一定有） */
function cssEscape(s) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return String(s).replace(/["\\]/g, "\\$&");
}

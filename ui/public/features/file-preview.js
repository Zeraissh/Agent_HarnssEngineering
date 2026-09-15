/**
 * features/file-preview — 本地文件预览覆盖层 + composer 文件拖拽/粘贴入口（V-35）。
 *
 * 零依赖原生 ESM。三件事共住一个模块，因为它们共用同一份「这是什么文件、
 * 去哪儿取」的判断：
 *   1) initFilePreview——预览停靠面板：md 渲染排版文档、HTML 进沙箱 iframe、
 *      图片直显、CSV 成表、代码高亮、Office（pptx/docx）走 /api/office-preview
 *      JSON 翻页、二进制降级信息卡。**渲染主体复用
 *      features/artifact-canvas.js 抽出的 renderPreviewBody**，外壳复用
 *      features/preview-dock.js（覆盖变体）——类型分派、沙箱纪律与
 *      停靠行为都只有一份；本模块只负责取件地址（/api/file-preview，
 *      Office 改走 /api/office-preview，圈禁在服务端）。
 *   2) initFileIntake——composer 的拖拽与粘贴：dataTransfer/clipboardData
 *      里有 files 才接管上传；纯文本拖拽/粘贴走浏览器默认行为（插入文字）。
 *   3) 纯函数层（命名、提取、URL 构造）——可单测。
 *
 * 与 artifact-canvas 同一约定：宿主（index.html 内联控制器）注入回调，
 * 本模块不反向 import 宿主任何东西；hash 路由与本模块无关（覆盖层不进历史）。
 */

import {
  artifactRendererKind,
  rendererKindLabel,
  artifactBasename,
  formatBytes,
  renderPreviewBody,
  isOfficeKind,
  officePreviewUrlFromFileUrl,
} from "./artifact-canvas.js";
import { createPreviewDock } from "./preview-dock.js";

// ---------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------

/** 粘贴截图的常见 mime → 扩展名（命名只凭 mime，不信原始名——截图根本没有原名） */
const PASTE_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

/**
 * 粘贴文件的落盘名。剪贴板截图没有用户起的名字——浏览器给的要么空、要么是
 * 通用占位（Chrome 一律 "image.png"，连贴两张会互相覆盖）。这两种都改命名
 * `pasted-<时间戳>.<按 mime 的扩展名>`；用户复制真实文件得来的名字原样保留。
 *
 * @param {{ name?:string, type?:string }} file
 * @param {number} [now] 时间戳（测试注入）
 * @returns {string}
 */
export function pastedFileName(file, now = Date.now()) {
  const name = String(file?.name ?? "").trim();
  // 空名与浏览器通用占位名（image.png / image.jpeg…）都视为"没名字"
  if (name && !/^image\.[a-z0-9]+$/i.test(name)) return name;
  const ext = PASTE_EXT[String(file?.type ?? "")] ?? "bin";
  return `pasted-${now}.${ext}`;
}

/** dataTransfer 里有没有文件（types 里有 "Files"）。文本拖拽返回 false。 */
export function dragHasFiles(dataTransfer) {
  const types = dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes("Files");
}

/**
 * 从 drop 事件的 dataTransfer 提取文件。没有文件返回 null——调用方据此
 * 把事件还给浏览器默认行为（比如把拖来的文本插进输入框）。
 * @param {DataTransfer|null|undefined} dataTransfer
 * @returns {File[]|null}
 */
export function filesFromDrop(dataTransfer) {
  const files = Array.from(dataTransfer?.files ?? []);
  return files.length > 0 ? files : null;
}

/**
 * 从 paste 事件的 clipboardData 提取文件并按需改名。没有文件返回 null
 * （纯文本粘贴，走默认插入）。一次贴多个文件时同名追加序号，避免互相覆盖。
 * @param {DataTransfer|null|undefined} clipboardData
 * @param {number} [now] 时间戳（测试注入）
 * @returns {File[]|null}
 */
export function filesFromPaste(clipboardData, now = Date.now()) {
  const files = Array.from(clipboardData?.files ?? []);
  if (files.length === 0) return null;
  const used = new Set();
  return files.map((file, i) => {
    let name = pastedFileName(file, now);
    if (used.has(name.toLowerCase())) name = name.replace(/(\.[^.]+)?$/, (m) => `-${i + 1}${m}`);
    used.add(name.toLowerCase());
    if (name === file.name) return file;
    return new File([file], name, { type: file.type });
  });
}

/**
 * /api/file-preview 取件地址。path 可以是相对 workdir 的路径（配 workdir 参数）
 * 或白名单工作目录内的绝对路径；圈禁在服务端做，前端只做编码。
 * @param {{ path:string, workdir?:string|null, download?:boolean }} opts
 * @returns {string}
 */
export function buildFilePreviewUrl(opts) {
  const q = new URLSearchParams({ path: String(opts?.path ?? "") });
  if (opts?.workdir) q.set("workdir", String(opts.workdir));
  if (opts?.download) q.set("download", "1");
  return `/api/file-preview?${q.toString()}`;
}


// ---------------------------------------------------------------
// DOM 层：预览停靠面板
// ---------------------------------------------------------------

const OVERLAY_ID = "file-preview-overlay";

/**
 * 初始化文件预览面板。幂等：重复调用返回既有节点的薄壳。
 *
 * 形态（T10 升级）：与产物画布同一只停靠外壳（features/preview-dock.js），
 * 用覆盖变体（absolute 钉主区右侧、不占 flex 位）——它是瞬态预览，不该把
 * 对话挤窄；拖拽调宽 / 放大还原 / Esc 两级 / 窄屏退化全部与画布同一行为。
 * 不再有点遮罩关闭（没有遮罩了）；关闭走顶条按钮或 Esc。
 *
 * host 回调：
 *   onAnnounce(msg) → aria-live 播报（可选）
 *
 * env（测试注入）：doc / win / fetch / storage / isNarrow / closeAnimMs
 *
 * @param {Record<string, Function>} [host]
 * @param {{ doc?:Document, win?:Window, fetch?:Function, storage?:Storage|null,
 *           isNarrow?:()=>boolean, closeAnimMs?:number }} [env]
 */
export function initFilePreview(host = {}, env = {}) {
  const doc = env.doc ?? document;
  const win = env.win ?? (doc.defaultView ?? window);
  const fetchImpl = env.fetch ?? (typeof fetch !== "undefined" ? fetch.bind(win) : null);

  const existing = doc.getElementById(OVERLAY_ID);
  if (existing && existing.__filePreviewApi) return existing.__filePreviewApi;

  // ---- 状态 ----
  /** 异步渲染令牌：连续打开两个文件时，慢的那次 fetch 回来不许覆盖快的 */
  let renderToken = 0;

  // ---- 停靠外壳（与产物画布同一份 chrome；overlay 变体不占 flex 位）----
  const dock = createPreviewDock(
    {
      id: OVERLAY_ID,
      label: "文件预览",
      overlay: true,
      extraClass: "fp-overlay",
    },
    env,
  );
  const overlay = dock.root;
  const body = dock.body;

  // ---- 顶条特征控件（关闭/放大键由外壳提供，这里插中间段）----
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
  actions.appendChild(downloadLink);

  dock.insertHeadControl(titleWrap);
  dock.insertHeadControl(actions);

  function setSize(bytes) {
    sizeEl.textContent = formatBytes(bytes);
    sizeEl.hidden = bytes == null;
  }

  /**
   * 打开面板并渲染指定文件。
   * @param {{ path:string, url:string }} opts
   *   path 用于类型分派与标题（显示相对路径）；url 是完整取件地址
   *   （/api/file-preview?… 或 /api/runs/:id/artifact?…，由调用方按来源构造）。
   * @returns {boolean} 是否真打开了
   */
  function openPreview(opts) {
    const path = String(opts?.path ?? "");
    const url = String(opts?.url ?? "");
    if (!path || !url) return false;
    const token = ++renderToken;
    const kind = artifactRendererKind(path);

    nameEl.textContent = artifactBasename(path);
    nameEl.title = path;
    badgeEl.textContent = rendererKindLabel(kind);
    downloadLink.href = url + (url.includes("?") ? "&" : "?") + "download=1";
    downloadLink.setAttribute("download", artifactBasename(path));
    setSize(null);

    if (!dock.isOpen() || dock.isCollapsed()) {
      dock.open();
      host.onAnnounce?.(`文件预览已打开：${artifactBasename(path)}`);
    }
    void renderPreviewBody(body, {
      path,
      url,
      officePreviewUrl: isOfficeKind(kind) ? officePreviewUrlFromFileUrl(path, url) : undefined,
      fetch: fetchImpl,
      isStale: () => token !== renderToken,
    }).then((result) => {
      if (result && token === renderToken) setSize(result.size);
    });
    if (doc.activeElement == null || !overlay.contains(doc.activeElement)) dock.closeBtn.focus();
    return true;
  }

  function closePreview() {
    if (!dock.isOpen()) return;
    renderToken += 1; // 作废在途 fetch
    dock.close();
  }

  const api = {
    open: openPreview,
    close: closePreview,
    isOpen: () => dock.isOpen(),
    isCollapsed: () => dock.isCollapsed(),
    isExpanded: () => dock.isExpanded(),
    setExpanded: (b) => dock.setExpanded(b),
    element: overlay,
  };
  overlay.__filePreviewApi = api;
  return api;
}

// ---------------------------------------------------------------
// DOM 层：composer 拖拽/粘贴上传入口
// ---------------------------------------------------------------

/**
 * 把「文件拖进 composer」与「Ctrl+V 贴文件」接到上传回调上。
 *
 * 纪律：
 *   - 只有 dataTransfer/clipboardData 里**真的有文件**才接管；纯文本拖拽
 *     与纯文本粘贴一律还给浏览器默认行为（往输入框里插文字）；
 *   - 高亮用深度计数而不是 dragleave 单打——子元素间移动会成对触发
 *     dragenter/dragleave，单打会在边框上闪；
 *   - window 上全局兜一道 dragover/drop 的 preventDefault：拖偏了松手，
 *     浏览器默认动作是**用文件替换当前页面**，那是数据丢失级的惊吓。
 *
 * @param {{ zone:HTMLElement, input?:HTMLTextAreaElement|null,
 *           onFiles:(files:File[])=>void, onAnnounce?:(msg:string)=>void }} opts
 *   zone 拖放高亮区（含输入框与附件清单，通常是整个 composer 表单）
 *   input 粘贴监听点（任务输入框）
 * @param {{ win?:Window, doc?:Document, now?:()=>number }} [env]
 * @returns {{ setActive:(on:boolean)=>void, destroy:()=>void }}
 */
export function initFileIntake(opts, env = {}) {
  const zone = opts?.zone;
  const input = opts?.input ?? null;
  const onFiles = typeof opts?.onFiles === "function" ? opts.onFiles : () => {};
  const win = env.win ?? zone?.ownerDocument?.defaultView ?? window;
  const now = typeof env.now === "function" ? env.now : () => Date.now();

  // 高亮提示层：模块自建（宿主不需要为它改静态标记）；zone 需 position:relative
  const hint = (zone?.ownerDocument ?? document).createElement("div");
  hint.className = "drop-hint";
  hint.hidden = true;
  hint.setAttribute("aria-hidden", "true");
  hint.innerHTML =
    '<i class="ph ph-upload-simple" aria-hidden="true"></i><span>松开以上传附件</span>';
  zone?.appendChild(hint);

  /** 拖入深度：子元素间移动成对触发 enter/leave，计数到 0 才算真的离开 */
  let depth = 0;
  function setActive(on) {
    if (!on) depth = 0;
    zone?.classList.toggle("submit-bar--drop-target", on);
    hint.hidden = !on;
  }

  const onDragEnter = (event) => {
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    depth += 1;
    setActive(true);
  };
  const onDragOver = (event) => {
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault(); // 不 preventDefault 就不允许 drop
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setActive(true);
  };
  const onDragLeave = (event) => {
    if (!dragHasFiles(event.dataTransfer)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) setActive(false);
  };
  const onDrop = (event) => {
    const files = filesFromDrop(event.dataTransfer);
    if (!files) return; // 拖的是文本：还给默认行为（插入输入框）
    event.preventDefault(); // 拦下「用文件替换页面」
    setActive(false);
    onFiles(files);
  };

  // 全局兜底：在 zone 之外松手不许替换页面。zone 内已 preventDefault 的不重复拦。
  const onWinDragOver = (event) => {
    if (dragHasFiles(event.dataTransfer)) event.preventDefault();
  };
  const onWinDrop = (event) => {
    if (event.defaultPrevented) return;
    if (dragHasFiles(event.dataTransfer)) event.preventDefault();
  };

  const onPaste = (event) => {
    const cd = event.clipboardData;
    if (!cd) return;
    const files = filesFromPaste(cd, now());
    if (!files) return; // 纯文本粘贴：默认插入
    let hasText = false;
    try {
      hasText = Boolean(cd.getData?.("text/plain"));
    } catch { /* 老实现取不到文本就当没有 */ }
    // 同时有文本和文件：文件上传 + 文本照常插入（不 preventDefault）；
    // 只有文件：拦下默认行为（否则有的浏览器会往里塞文件名）
    if (!hasText) event.preventDefault();
    onFiles(files);
  };

  zone?.addEventListener("dragenter", onDragEnter);
  zone?.addEventListener("dragover", onDragOver);
  zone?.addEventListener("dragleave", onDragLeave);
  zone?.addEventListener("drop", onDrop);
  win.addEventListener("dragover", onWinDragOver);
  win.addEventListener("drop", onWinDrop);
  input?.addEventListener("paste", onPaste);

  return {
    setActive,
    destroy() {
      zone?.removeEventListener("dragenter", onDragEnter);
      zone?.removeEventListener("dragover", onDragOver);
      zone?.removeEventListener("dragleave", onDragLeave);
      zone?.removeEventListener("drop", onDrop);
      win.removeEventListener("dragover", onWinDragOver);
      win.removeEventListener("drop", onWinDrop);
      input?.removeEventListener("paste", onPaste);
      hint.remove();
    },
  };
}

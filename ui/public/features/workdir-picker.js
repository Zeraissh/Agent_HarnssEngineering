/**
 * features/workdir-picker — composer 工作目录下拉的「＋ 添加目录…」入口
 * 与目录选择器浮层（V-29 运行时扩展）。
 *
 * 背景：工作目录白名单原来只能重启宿主时经 AGENT_UI_WORKDIRS 声明。
 * 现在本机 UI 可以直接把新目录加进白名单（POST /api/workdirs，服务端有
 * loopback 门），落 .agent-workdirs.json，重启后仍在。
 *
 * 零依赖原生 ESM。三件事共住一个模块，因为它们共用同一份「可选目录集合」
 * 的读写：
 *   1) 纯函数层：shortenPath（长路径中间省略号）/ renderWorkdirOptions
 *     （重建下拉项，含哨兵项）/ wireWorkdirSelect（哨兵选中 → 打开浮层）。
 *   2) initWorkdirPicker——目录选择器浮层：顶部当前路径 + 「选这个目录」
 *     主按钮 + 「上一级」；子目录列表下钻；也支持直接粘贴绝对路径。
 *   3) 取件地址构造（/api/fs/list、/api/workdirs）——可单测。
 *
 * 与 file-preview 同一约定：宿主（index.html 内联控制器）注入回调
 * （onAdded / onAnnounce），本模块不反向 import 宿主任何东西；浮层不进
 * hash 路由历史。
 */

// ---------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------

/** 下拉最后一项「＋ 添加目录…」的哨兵值——不可能与真实路径撞车 */
export const WORKDIR_ADD_VALUE = "__add_workdir__";

/**
 * 长路径中间省略号：保住开头的盘符/根与结尾的目录名，中间用 … 折叠。
 * 下拉宽度有限，头尾恰恰是认路的两端。
 *
 * @param {string} path
 * @param {number} [max] 最大显示长度（字符）
 * @returns {string}
 */
export function shortenPath(path, max = 40) {
  const s = String(path ?? "");
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

/**
 * 重建工作目录下拉的选项：每个目录一项（显示缩短、title 给全路径），
 * 最后一项恒为「＋ 添加目录…」哨兵。
 *
 * @param {HTMLSelectElement} select
 * @param {string[]} workdirs 服务端给的合法集合
 * @param {{ selected?:string|null }} [opts] 希望选中的目录（不在集合里则落第一项）
 * @returns {string} 最终选中的值
 */
export function renderWorkdirOptions(select, workdirs, opts = {}) {
  const doc = select.ownerDocument;
  select.innerHTML = "";
  for (const d of workdirs) {
    const opt = doc.createElement("option");
    opt.value = d;
    opt.textContent = shortenPath(d);
    opt.title = d;
    select.appendChild(opt);
  }
  const add = doc.createElement("option");
  add.value = WORKDIR_ADD_VALUE;
  add.textContent = "＋ 添加目录…";
  add.title = "把一个新目录加入可选工作目录（仅本机可用，重启后仍保留）";
  select.appendChild(add);
  const wanted = opts.selected && workdirs.includes(opts.selected) ? opts.selected : workdirs[0];
  if (wanted) select.value = wanted;
  select.title = select.value === WORKDIR_ADD_VALUE ? "" : select.value;
  return select.value;
}

/**
 * 下拉的 change 接线：选中哨兵 = 请求打开目录选择器，并把选择拨回上一个
 * 真实目录（哨兵从来不是「本次新建的工作目录」）；选中真实目录则记账并
 * 更新 title。
 *
 * @param {HTMLSelectElement} select
 * @param {{ onAddRequest?:()=>void, onChange?:(value:string)=>void }} [hooks]
 */
export function wireWorkdirSelect(select, hooks = {}) {
  let lastReal = select.value && select.value !== WORKDIR_ADD_VALUE ? select.value : null;
  select.addEventListener("change", () => {
    if (select.value === WORKDIR_ADD_VALUE) {
      // 拨回上一个真实目录；还没记过账（快照填充不触发 change）就退到
      // 第一个非哨兵项——哨兵从来不是「本次新建的工作目录」
      const values = [...select.options].map((o) => o.value);
      const fallback = lastReal && values.includes(lastReal)
        ? lastReal
        : values.find((v) => v !== WORKDIR_ADD_VALUE);
      if (fallback) select.value = fallback;
      select.title = select.value;
      hooks.onAddRequest?.();
      return;
    }
    lastReal = select.value;
    select.title = select.value;
    hooks.onChange?.(select.value);
  });
}

/** /api/fs/list 取件地址；path 为 null/空 = 常用起点列表。 */
export function buildFsListUrl(path) {
  const p = String(path ?? "").trim();
  if (!p) return "/api/fs/list";
  return `/api/fs/list?path=${encodeURIComponent(p)}`;
}

// ---------------------------------------------------------------
// DOM 层：目录选择器浮层
// ---------------------------------------------------------------

const OVERLAY_ID = "workdir-picker-overlay";

/**
 * 初始化目录选择器浮层。幂等：重复调用返回既有节点的薄壳。
 *
 * host 回调：
 *   onAdded(path, payload) → 目录成功加入白名单（payload 是服务端应答，
 *     含最新 workdirs 列表）；宿主据此刷新下拉并选中新目录
 *   onAnnounce(msg) → aria-live 播报（可选）
 *
 * env（测试注入）：doc / win / fetch
 *
 * @param {Record<string, Function>} [host]
 * @param {{ doc?:Document, win?:Window, fetch?:Function }} [env]
 * @returns {{ open:(startPath?:string|null)=>void, close:()=>void, isOpen:()=>boolean,
 *             currentPath:()=>string|null, element:HTMLElement }}
 */
export function initWorkdirPicker(host = {}, env = {}) {
  const doc = env.doc ?? document;
  const win = env.win ?? (doc.defaultView ?? window);
  const fetchImpl = env.fetch ?? (typeof fetch !== "undefined" ? fetch.bind(win) : null);

  const existing = doc.getElementById(OVERLAY_ID);
  if (existing && existing.__workdirPickerApi) return existing.__workdirPickerApi;

  // ---- 状态 ----
  let open = false;
  /** @type {string|null} 当前浏览到的目录；null = 常用起点列表 */
  let currentPath = null;
  /** 异步渲染令牌：连续点下钻时，慢的那次 fetch 回来不许覆盖快的 */
  let renderToken = 0;
  /** @type {HTMLElement|null} */
  let restoreFocusTo = null;

  // ---- 骨架 ----
  const overlay = doc.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.className = "wp-overlay";
  overlay.hidden = true;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "选择工作目录");

  const panel = doc.createElement("div");
  panel.className = "wp-panel";

  const head = doc.createElement("header");
  head.className = "wp-head";
  const closeBtn = doc.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn btn--ghost wp-close";
  closeBtn.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i><span>关闭</span>';
  closeBtn.setAttribute("aria-label", "关闭目录选择器（Esc）");
  const title = doc.createElement("strong");
  title.className = "wp-title";
  title.textContent = "选择工作目录";
  head.appendChild(closeBtn);
  head.appendChild(title);

  const toolbar = doc.createElement("div");
  toolbar.className = "wp-toolbar";
  const currentEl = doc.createElement("span");
  currentEl.className = "wp-current";
  const upBtn = doc.createElement("button");
  upBtn.type = "button";
  upBtn.className = "btn btn--ghost wp-up";
  upBtn.innerHTML = '<i class="ph ph-arrow-up" aria-hidden="true"></i><span>上一级</span>';
  const chooseBtn = doc.createElement("button");
  chooseBtn.type = "button";
  chooseBtn.className = "btn btn--primary wp-choose";
  chooseBtn.innerHTML = '<i class="ph ph-check" aria-hidden="true"></i><span>选这个目录</span>';
  toolbar.appendChild(currentEl);
  toolbar.appendChild(upBtn);
  toolbar.appendChild(chooseBtn);

  const manual = doc.createElement("div");
  manual.className = "wp-manual";
  const pathInput = doc.createElement("input");
  pathInput.type = "text";
  pathInput.className = "wp-path-input";
  pathInput.placeholder = "或直接粘贴绝对路径…";
  pathInput.setAttribute("aria-label", "直接输入目录绝对路径");
  const goBtn = doc.createElement("button");
  goBtn.type = "button";
  goBtn.className = "btn btn--ghost wp-go";
  goBtn.innerHTML = '<i class="ph ph-arrow-right" aria-hidden="true"></i><span>前往</span>';
  manual.appendChild(pathInput);
  manual.appendChild(goBtn);

  const list = doc.createElement("div");
  list.className = "wp-list";

  const status = doc.createElement("p");
  status.className = "wp-status";
  status.setAttribute("role", "status");
  status.hidden = true;

  panel.appendChild(head);
  panel.appendChild(toolbar);
  panel.appendChild(manual);
  panel.appendChild(list);
  panel.appendChild(status);
  overlay.appendChild(panel);
  (doc.body ?? doc.documentElement).appendChild(overlay);

  function setStatus(text, tone = "") {
    status.textContent = text;
    status.hidden = !text;
    status.dataset.tone = tone;
  }

  function renderToolbar(parent) {
    const atRoot = currentPath === null;
    currentEl.textContent = atRoot ? "选择起点" : currentPath;
    currentEl.title = atRoot ? "" : currentPath;
    upBtn.disabled = atRoot || !parent;
    upBtn.dataset.parent = parent ?? "";
    chooseBtn.disabled = atRoot;
  }

  function renderDirs(dirs) {
    list.innerHTML = "";
    if (!dirs.length) {
      const empty = doc.createElement("p");
      empty.className = "wp-empty";
      empty.textContent = currentPath === null ? "没有可用起点" : "这个目录没有可进入的子目录";
      list.appendChild(empty);
      return;
    }
    for (const dir of dirs) {
      const item = doc.createElement("button");
      item.type = "button";
      item.className = "wp-dir";
      item.title = dir.path;
      const icon = doc.createElement("i");
      icon.className = "ph ph-folder";
      icon.setAttribute("aria-hidden", "true");
      const name = doc.createElement("span");
      name.textContent = dir.name;
      item.appendChild(icon);
      item.appendChild(name);
      item.addEventListener("click", () => void load(dir.path));
      list.appendChild(item);
    }
  }

  /**
   * 拉一级目录并渲染。path 为 null = 常用起点。
   * @param {string|null} path
   */
  async function load(path) {
    if (!fetchImpl) return;
    const token = ++renderToken;
    setStatus("加载中…");
    upBtn.disabled = true;
    let res;
    try {
      res = await fetchImpl(buildFsListUrl(path));
    } catch {
      if (token !== renderToken) return;
      setStatus("网络错误，没拉到目录列表", "error");
      return;
    }
    if (token !== renderToken) return;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(body?.error ?? `读取失败（HTTP ${res.status}）`, "error");
      return;
    }
    currentPath = body.path ?? null;
    setStatus("");
    renderToolbar(body.parent ?? null);
    renderDirs(Array.isArray(body.dirs) ? body.dirs : []);
    if (path !== null) pathInput.value = currentPath ?? "";
  }

  /**
   * 打开浮层并从指定目录（缺省 = 常用起点）开始浏览。
   * @param {string|null} [startPath]
   */
  function openPicker(startPath = null) {
    if (!open) {
      open = true;
      restoreFocusTo = /** @type {HTMLElement|null} */ (doc.activeElement);
      overlay.hidden = false;
      host.onAnnounce?.("目录选择器已打开");
      if (doc.activeElement == null || !overlay.contains(doc.activeElement)) closeBtn.focus();
    }
    void load(startPath ?? null);
  }

  function closePicker() {
    if (!open) return;
    open = false;
    renderToken += 1; // 作废在途 fetch
    overlay.hidden = true;
    setStatus("");
    if (restoreFocusTo && typeof restoreFocusTo.focus === "function" && doc.contains?.(restoreFocusTo) !== false) {
      restoreFocusTo.focus();
    }
    restoreFocusTo = null;
  }

  /** 「选这个目录」→ POST /api/workdirs；成功后交还给宿主刷新下拉 */
  async function chooseCurrent() {
    if (!fetchImpl || currentPath === null) return;
    chooseBtn.disabled = true;
    setStatus("正在加入白名单…");
    try {
      const res = await fetchImpl("/api/workdirs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: currentPath }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(body?.error ?? `加入失败（HTTP ${res.status}）`, "error");
        return;
      }
      const added = String(body.workdir ?? currentPath);
      host.onAnnounce?.(`已加入工作目录：${added}`);
      closePicker();
      host.onAdded?.(added, body);
    } catch {
      setStatus("网络错误，没加成", "error");
    } finally {
      chooseBtn.disabled = currentPath === null;
    }
  }

  closeBtn.addEventListener("click", () => closePicker());
  upBtn.addEventListener("click", () => {
    // 上一级目标由最近一次应答的 parent 给出；按钮 disabled 状态已挡住 null
    const parent = upBtn.dataset.parent ?? null;
    if (parent) void load(parent);
  });
  chooseBtn.addEventListener("click", () => void chooseCurrent());
  goBtn.addEventListener("click", () => {
    const value = pathInput.value.trim();
    if (value) void load(value);
  });
  pathInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const value = pathInput.value.trim();
      if (value) void load(value);
    }
  });
  // 点遮罩（panel 之外）关闭；点 panel 内部不收
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) closePicker();
  });
  // Esc 关闭。只在浮层开着时接管，关掉后这个键归还给宿主
  doc.addEventListener("keydown", (event) => {
    if (!open || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closePicker();
  });

  const api = {
    open: openPicker,
    close: closePicker,
    isOpen: () => open,
    currentPath: () => currentPath,
    element: overlay,
  };
  overlay.__workdirPickerApi = api;
  return api;
}

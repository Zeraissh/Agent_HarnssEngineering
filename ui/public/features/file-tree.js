/**
 * features/file-tree — 右侧工作区文件栏（MVP，不是完整 IDE）。
 *
 * 挂在 `#center-row` 最右，Work / Code 都有：对话在中间，文件在右边。
 * 展开走既有 `GET /api/workspace/files?q=dir/`（浅列 + resolveInWorkdir）。
 * 点文件走宿主 onPreview（预览坞 / 产物画布，不走 file://）。
 * 行内 @ 走宿主 onCite（同一套 insert @path）。不发明第三套交互。
 *
 * 与 memory-panel / file-preview 同一约定：纯函数可单测；
 * initFileTree(host, env) 由宿主注入回调，本模块不反向 import 宿主。
 */

import { humanizeHttpFailure } from "./humanize-error.js";

/** 空态 / 按钮 / 失败（HTTP 码不进脸上）。截断与过深用服务端 notice。 */
export const FILE_TREE_COPY = {
  title: "文件",
  collapse: "收起文件",
  expand: "显示文件",
  empty: "这个文件夹是空的。",
  emptyRoot: "这个工作目录里还没有可列出的文件。",
  noWorkdir: "先选一个工作目录。",
  loading: "正在列出文件…",
  cite: "插入 @ 引用",
  network: "文件列表加载失败（网络错误）",
};

/** 折叠偏好。1 = 收起。 */
export const FILES_RAIL_PREF = "agent.ui.pref.filesRailCollapsed";

/** `src` → `src/`，根是空字符串。与 ui/workspace-files.ts 的 treeQueryForDir 同形。 */
export function treeQueryForDir(dir) {
  const rel = String(dir ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return rel ? `${rel}/` : "";
}

export function buildWorkspaceTreeUrl(workdir, dir) {
  const q = new URLSearchParams();
  if (workdir) q.set("workdir", String(workdir));
  const treeQ = treeQueryForDir(dir);
  if (treeQ) q.set("q", treeQ);
  return `/api/workspace/files?${q}`;
}

export function isTreeNotice(entry) {
  return Boolean(entry && typeof entry.notice === "string" && entry.notice.trim());
}

/**
 * 把服务端 files[] 分成真实条目与人话提示。
 * @param {unknown} files
 * @returns {{ entries: object[], notices: object[] }}
 */
export function splitTreeEntries(files) {
  const list = Array.isArray(files) ? files : [];
  const entries = [];
  const notices = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    if (isTreeNotice(raw)) {
      notices.push({
        notice: String(raw.notice).trim(),
        relative: String(raw.relative ?? "").replace(/\\/g, "/"),
      });
      continue;
    }
    const kind = raw.kind === "directory" ? "directory" : raw.kind === "file" ? "file" : "";
    const relative = String(raw.relative ?? "").replace(/\\/g, "/");
    const name = String(raw.name ?? "").trim() || relative.split("/").pop() || "";
    if (!kind || !relative || !name) continue;
    entries.push({ name, relative, kind });
  }
  return { entries, notices };
}

export function humanizeTreeFailure(status, bodyError) {
  const raw = typeof bodyError === "string" ? bodyError.trim() : "";
  if (raw && !/\bHTTP\s*\d{3}\b/i.test(raw) && !/^\d{3}$/.test(raw)) return raw;
  return humanizeHttpFailure(status, raw || FILE_TREE_COPY.network);
}

/** 展开集合的纯函数翻转。路径统一正斜杠。 */
export function toggleExpanded(expanded, relative) {
  const key = String(relative ?? "").replace(/\\/g, "/");
  const next = new Set(expanded ?? []);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function readFilesRailCollapsed(storage) {
  try {
    return storage?.getItem?.(FILES_RAIL_PREF) === "1";
  } catch {
    return false;
  }
}

export function writeFilesRailCollapsed(storage, collapsed) {
  try {
    if (!storage) return;
    if (collapsed) storage.setItem(FILES_RAIL_PREF, "1");
    else storage.removeItem(FILES_RAIL_PREF);
  } catch { /* 存储不可写只丢偏好 */ }
}

function childDepth(relative) {
  const rel = String(relative ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!rel) return 0;
  return rel.split("/").filter(Boolean).length;
}

/**
 * @param {{
 *   mount?: HTMLElement,
 *   getWorkdir?: () => string,
 *   onPreview?: (path: string) => void,
 *   onCite?: (path: string, kind: "file"|"directory") => void,
 *   onAnnounce?: (msg: string) => void,
 * }} [host]
 * @param {{ doc?: Document, fetch?: Function, storage?: Storage|null, collapsed?: boolean }} [env]
 */
export function initFileTree(host = {}, env = {}) {
  const mount = host.mount;
  if (!mount) return null;
  if (mount.__fileTreeApi) return mount.__fileTreeApi;

  const doc = env.doc ?? mount.ownerDocument ?? document;
  const fetchImpl = env.fetch
    ?? (typeof fetch !== "undefined" ? fetch.bind(env.win ?? globalThis) : null);
  const storage = env.storage !== undefined
    ? env.storage
    : (() => {
        try { return (env.win ?? globalThis).localStorage ?? null; } catch { return null; }
      })();

  mount.classList.add("files-rail", "workspace-file-tree");
  mount.replaceChildren();

  const head = doc.createElement("div");
  head.className = "workspace-file-tree-head";

  const title = doc.createElement("span");
  title.className = "files-rail-title";
  title.textContent = FILE_TREE_COPY.title;

  const toggle = doc.createElement("button");
  toggle.type = "button";
  toggle.className = "files-rail-toggle";

  const body = doc.createElement("div");
  body.className = "workspace-file-tree-body";
  body.id = "workspace-file-tree-body";
  body.setAttribute("aria-label", "工作区文件");

  toggle.setAttribute("aria-controls", body.id);
  head.appendChild(title);
  head.appendChild(toggle);
  mount.appendChild(head);
  mount.appendChild(body);

  /** @type {Map<string, { entries: object[], notices: object[] }>} */
  const cache = new Map();
  /** @type {Set<string>} */
  let expanded = new Set();
  /** @type {Set<string>} */
  const loading = new Set();
  /** @type {string} */
  let lastWorkdir = "";
  /** @type {string} */
  let rootError = "";
  let loadToken = 0;
  let collapsed = env.collapsed !== undefined
    ? Boolean(env.collapsed)
    : readFilesRailCollapsed(storage);

  function workdirNow() {
    return String(host.getWorkdir?.() ?? "").trim();
  }

  function syncCollapsedChrome() {
    mount.classList.toggle("files-rail--collapsed", collapsed);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-label", collapsed ? FILE_TREE_COPY.expand : FILE_TREE_COPY.collapse);
    toggle.textContent = collapsed ? `⟨ ${FILE_TREE_COPY.title}` : `${FILE_TREE_COPY.title} ⟩`;
  }

  function setCollapsed(next) {
    const target = Boolean(next);
    if (collapsed === target) {
      syncCollapsedChrome();
      return collapsed;
    }
    collapsed = target;
    writeFilesRailCollapsed(storage, collapsed);
    syncCollapsedChrome();
    return collapsed;
  }

  function paint() {
    const wd = workdirNow();
    body.replaceChildren();
    if (!wd) {
      const empty = doc.createElement("p");
      empty.className = "ft-empty";
      empty.textContent = FILE_TREE_COPY.noWorkdir;
      body.appendChild(empty);
      return;
    }
    if (rootError) {
      const err = doc.createElement("p");
      err.className = "ft-error";
      err.textContent = rootError;
      body.appendChild(err);
      return;
    }
    renderLevel("");
  }

  function appendNotice(text) {
    const p = doc.createElement("p");
    p.className = "ft-notice";
    p.textContent = text;
    body.appendChild(p);
  }

  function renderLevel(parentRel) {
    if (loading.has(parentRel)) {
      if (parentRel === "") {
        const p = doc.createElement("p");
        p.className = "ft-empty";
        p.textContent = FILE_TREE_COPY.loading;
        body.appendChild(p);
      }
      return;
    }
    const cached = cache.get(parentRel);
    if (!cached) return;
    for (const n of cached.notices) appendNotice(n.notice);
    if (!cached.entries.length && !cached.notices.length) {
      const p = doc.createElement("p");
      p.className = "ft-empty";
      p.textContent = parentRel ? FILE_TREE_COPY.empty : FILE_TREE_COPY.emptyRoot;
      body.appendChild(p);
      return;
    }
    const depth = parentRel ? childDepth(parentRel) : 0;
    for (const entry of cached.entries) {
      body.appendChild(renderRow(entry, depth));
      if (entry.kind === "directory" && expanded.has(entry.relative)) {
        renderLevel(entry.relative);
      }
    }
  }

  function renderRow(entry, depth) {
    const row = doc.createElement("div");
    row.className = "ft-row";
    row.dataset.path = entry.relative;
    row.dataset.kind = entry.kind;
    row.style.setProperty("--ft-depth", String(depth));

    if (entry.kind === "directory") {
      const twist = doc.createElement("button");
      twist.type = "button";
      twist.className = "ft-twist";
      const open = expanded.has(entry.relative);
      twist.setAttribute("aria-expanded", String(open));
      twist.setAttribute("aria-label", open ? `折叠 ${entry.name}` : `展开 ${entry.name}`);
      twist.innerHTML = `<i class="ph ${open ? "ph-caret-down" : "ph-caret-right"}" aria-hidden="true"></i>`;
      twist.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void toggleDir(entry.relative);
      });
      row.appendChild(twist);
    } else {
      const pad = doc.createElement("span");
      pad.className = "ft-twist-spacer";
      pad.setAttribute("aria-hidden", "true");
      row.appendChild(pad);
    }

    const nameBtn = doc.createElement("button");
    nameBtn.type = "button";
    nameBtn.className = "ft-name";
    const icon = entry.kind === "directory" ? "ph-folder" : "ph-file";
    nameBtn.innerHTML = `<i class="ph ${icon}" aria-hidden="true"></i>`;
    const label = doc.createElement("span");
    label.textContent = entry.name;
    nameBtn.appendChild(label);
    nameBtn.title = entry.relative;
    nameBtn.addEventListener("click", () => {
      if (entry.kind === "directory") void toggleDir(entry.relative);
      else host.onPreview?.(entry.relative);
    });
    row.appendChild(nameBtn);

    const cite = doc.createElement("button");
    cite.type = "button";
    cite.className = "ft-cite";
    cite.title = FILE_TREE_COPY.cite;
    cite.setAttribute("aria-label", `${FILE_TREE_COPY.cite} ${entry.relative}`);
    cite.textContent = "@";
    cite.addEventListener("click", (ev) => {
      ev.stopPropagation();
      host.onCite?.(entry.relative, entry.kind);
    });
    row.appendChild(cite);
    return row;
  }

  async function loadDir(dir) {
    const wd = workdirNow();
    const key = String(dir ?? "").replace(/\\/g, "/");
    if (!wd || !fetchImpl) {
      if (key === "") {
        rootError = "";
        paint();
      }
      return;
    }
    const token = ++loadToken;
    loading.add(key);
    if (key === "") {
      rootError = "";
      paint();
    }
    try {
      const res = await fetchImpl(buildWorkspaceTreeUrl(wd, key));
      if (token !== loadToken && key === "") return;
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const message = humanizeTreeFailure(res.status, body?.error);
        if (key === "") rootError = message;
        else cache.set(key, { entries: [], notices: [{ notice: message, relative: key }] });
        return;
      }
      const parsed = await res.json().catch(() => null);
      const split = splitTreeEntries(parsed?.files);
      cache.set(key, split);
      if (key === "") rootError = "";
    } catch {
      const message = FILE_TREE_COPY.network;
      if (key === "") rootError = message;
      else cache.set(key, { entries: [], notices: [{ notice: message, relative: key }] });
    } finally {
      loading.delete(key);
      paint();
    }
  }

  async function toggleDir(relative) {
    const key = String(relative ?? "").replace(/\\/g, "/");
    if (!key) return;
    if (expanded.has(key)) {
      expanded.delete(key);
      paint();
      return;
    }
    expanded.add(key);
    if (!cache.has(key)) await loadDir(key);
    else paint();
  }

  async function reload() {
    const wd = workdirNow();
    if (wd !== lastWorkdir) {
      cache.clear();
      expanded = new Set();
      lastWorkdir = wd;
    }
    rootError = "";
    cache.delete("");
    await loadDir("");
  }

  toggle.addEventListener("click", () => {
    setCollapsed(!collapsed);
  });
  syncCollapsedChrome();

  const api = {
    reload,
    expand: toggleDir,
    setCollapsed,
    isCollapsed: () => collapsed,
    element: mount,
  };
  mount.__fileTreeApi = api;
  return api;
}

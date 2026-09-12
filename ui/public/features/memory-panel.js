/**
 * features/memory-panel — 记忆面板（T5）。
 *
 * 让 L5 记忆从黑盒变可审查：只读列出默认工作目录作用域的 .agent-memory/，
 * 左侧列表（名称 + 摘要 + 修改时间），右侧用 core/markdown.js 渲染选中文件全文。
 *
 * 与 command-palette / notifications 同一约定：
 *   1) 纯函数层（响应整形 / 格式化）——可单测；
 *   2) DOM 层 initMemoryPanel(host, env)——宿主（index.html 内联控制器）注入回调，
 *      本模块不反向 import 宿主任何东西。
 *
 * 端点契约（ui/server.ts）：
 *   GET /api/memory        → { dir, entries: [{ name, summary, sizeBytes, mtimeMs }] }
 *   GET /api/memory/:name  → { name, content, sizeBytes, truncated }
 */

import { renderMarkdown } from "../core/markdown.js";
import { formatRelTime } from "./notifications.js";

// ---------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------

/**
 * @typedef {{ name:string, summary:string, sizeBytes:number, mtimeMs:number|null }} MemoryEntry
 * @typedef {{ name:string, content:string, sizeBytes:number, truncated:boolean }} MemoryFile
 */

/**
 * 列表响应整形：宽容外部输入，只放行形状合法的条目。
 * @param {unknown} payload
 * @returns {{ dir:string|null, entries:MemoryEntry[] }}
 */
export function normalizeMemoryList(payload) {
  const obj = payload && typeof payload === "object" ? /** @type {any} */ (payload) : {};
  const dir = typeof obj.dir === "string" ? obj.dir : null;
  const project = typeof obj.project === "string" ? obj.project : null;
  const shared = obj.shared === true;
  const rawStatus = obj.status && typeof obj.status === "object" ? obj.status : null;
  const status = rawStatus && typeof rawStatus.summary === "string" && rawStatus.summary
    ? {
        summary: rawStatus.summary,
        waiting: Array.isArray(rawStatus.waiting) ? rawStatus.waiting.map(String) : [],
        nextGate: typeof rawStatus.nextGate === "string" ? rawStatus.nextGate : "",
        decisions: Array.isArray(rawStatus.decisions) ? rawStatus.decisions.map(String) : [],
      }
    : null;
  const raw = Array.isArray(obj.entries) ? obj.entries : [];
  /** @type {MemoryEntry[]} */
  const entries = [];
  for (const e of raw) {
    if (!e || typeof e.name !== "string" || !e.name) continue;
    entries.push({
      name: e.name,
      summary: typeof e.summary === "string" ? e.summary : "",
      sizeBytes: Number.isFinite(Number(e.sizeBytes)) ? Number(e.sizeBytes) : 0,
      mtimeMs: Number.isFinite(Number(e.mtimeMs)) ? Number(e.mtimeMs) : null,
      scope: typeof e.scope === "string" ? e.scope : null,
    });
  }
  return { dir, project, shared, status, entries };
}

/**
 * 单文件响应整形。形状不合法返回 null（调用方按错误态处理）。
 * @param {unknown} payload
 * @returns {MemoryFile|null}
 */
export function normalizeMemoryFile(payload) {
  const obj = payload && typeof payload === "object" ? /** @type {any} */ (payload) : null;
  if (!obj || typeof obj.name !== "string" || typeof obj.content !== "string") return null;
  return {
    name: obj.name,
    content: obj.content,
    sizeBytes: Number.isFinite(Number(obj.sizeBytes)) ? Number(obj.sizeBytes) : 0,
    truncated: obj.truncated === true,
  };
}

/**
 * 字节数格式化：123 B / 1.2 KB / 3.4 MB。
 * @param {number} bytes
 * @returns {string}
 */
export function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 空态与错误态文案（测试与 UI 共用同一份，避免两处漂移）。 */
export const MEMORY_COPY = {
  empty: "还没有记忆——Agent 在跨会话工作中积累的内容会出现在这里",
  listError: (status) => `记忆列表加载失败（HTTP ${status}）`,
  previewError: (status) => (status === 404 ? "这条记忆已被删除" : `记忆内容加载失败（HTTP ${status}）`),
  previewPlaceholder: "选择左侧一条记忆查看全文",
  truncatedNote: "内容超过 256 KB，已截断显示",
};

// ---------------------------------------------------------------
// DOM 层
// ---------------------------------------------------------------

const PANEL_ID = "memory-panel";

/**
 * 初始化记忆面板。幂等：重复调用返回既有节点的薄壳。
 *
 * host 回调：
 *   onAnnounce(msg) → aria-live 播报（可选）
 *   getWorkdir() → 当前作曲栏工作目录（可选；有则带 ?workdir=）
 *
 * env（测试注入）：doc / fetchFn / now
 *
 * @param {Record<string, Function>} host
 * @param {{ doc?:Document, fetchFn?:typeof fetch, now?:() => number }} [env]
 */
export function initMemoryPanel(host = {}, env = {}) {
  const doc = env.doc ?? document;
  const fetchFn = env.fetchFn ?? ((...args) => fetch(...args));
  const now = env.now ?? (() => Date.now());

  const trigger = /** @type {HTMLElement|null} */ (doc.getElementById("memory-btn"));

  const existing = doc.getElementById(PANEL_ID);
  if (existing) {
    return { open: () => { existing.hidden = false; }, close: () => { existing.hidden = true; }, isOpen: () => !existing.hidden, element: existing };
  }

  // ---- 状态 ----
  let open = false;
  /** @type {string|null} */
  let dir = null;
  /** @type {MemoryEntry[]} */
  let entries = [];
  /** @type {{ summary:string, waiting:string[], nextGate:string, decisions:string[] }|null} */
  let board = null;
  /** @type {"current"|"all"} */
  let listScope = "current";
  /** @type {string|null} */
  let selectedName = null;
  /** @type {"loading"|"ready"|"error"} */
  let listStatus = "loading";
  let listError = "";
  /** @type {HTMLElement|null} */
  let restoreFocusTo = null;
  /** 预览竞态防护：快速连点时只渲染最后一次选择的结果 */
  let previewSeq = 0;

  // ---- 骨架：浮层 + 抽屉式面板 ----
  const overlay = doc.createElement("div");
  overlay.id = PANEL_ID;
  overlay.className = "mem-overlay";
  overlay.hidden = true;

  const panel = doc.createElement("div");
  panel.className = "mem-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", "记忆");

  const head = doc.createElement("div");
  head.className = "mem-head";
  const title = doc.createElement("h2");
  title.className = "mem-title";
  title.innerHTML = '<i class="ph ph-brain" aria-hidden="true"></i> 记忆';
  const dirLabel = doc.createElement("span");
  dirLabel.className = "mem-dir";
  dirLabel.hidden = true;
  const refreshBtn = doc.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "mem-refresh icon-btn";
  refreshBtn.setAttribute("aria-label", "刷新记忆列表");
  refreshBtn.innerHTML = '<i class="ph ph-arrows-clockwise" aria-hidden="true"></i>';
  const closeBtn = doc.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "mem-close icon-btn";
  closeBtn.setAttribute("aria-label", "关闭记忆面板");
  closeBtn.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i>';
  const scopeRow = doc.createElement("div");
  scopeRow.className = "mem-scope";
  scopeRow.setAttribute("role", "tablist");
  scopeRow.setAttribute("aria-label", "记忆范围");
  const scopeCurrent = doc.createElement("button");
  scopeCurrent.type = "button";
  scopeCurrent.className = "mem-scope-btn";
  scopeCurrent.dataset.scope = "current";
  scopeCurrent.textContent = "本项目";
  const scopeAll = doc.createElement("button");
  scopeAll.type = "button";
  scopeAll.className = "mem-scope-btn";
  scopeAll.dataset.scope = "all";
  scopeAll.textContent = "全部";
  scopeRow.appendChild(scopeCurrent);
  scopeRow.appendChild(scopeAll);

  head.appendChild(title);
  head.appendChild(dirLabel);
  head.appendChild(scopeRow);
  head.appendChild(refreshBtn);
  head.appendChild(closeBtn);

  const body = doc.createElement("div");
  body.className = "mem-body";

  const listCol = doc.createElement("div");
  listCol.className = "mem-list-col";
  const boardCard = doc.createElement("div");
  boardCard.className = "mem-board";
  boardCard.hidden = true;
  const list = doc.createElement("ul");
  list.className = "mem-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "记忆文件");
  listCol.appendChild(boardCard);
  listCol.appendChild(list);

  const preview = doc.createElement("div");
  preview.className = "mem-preview";
  preview.setAttribute("aria-live", "polite");

  body.appendChild(listCol);
  body.appendChild(preview);

  // 空态 / 错误态：整块覆盖 body
  const empty = doc.createElement("div");
  empty.className = "mem-empty";
  empty.textContent = MEMORY_COPY.empty;
  empty.hidden = true;

  const errorBox = doc.createElement("div");
  errorBox.className = "mem-error";
  errorBox.setAttribute("role", "alert");
  errorBox.hidden = true;
  const errorText = doc.createElement("span");
  errorText.className = "mem-error-text";
  const retryBtn = doc.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "btn btn--ghost mem-error-retry";
  retryBtn.textContent = "重试";
  errorBox.appendChild(errorText);
  errorBox.appendChild(retryBtn);

  panel.appendChild(head);
  panel.appendChild(body);
  panel.appendChild(empty);
  panel.appendChild(errorBox);
  overlay.appendChild(panel);
  doc.body.appendChild(overlay);

  // ---- 渲染 ----
  function memoryListUrl() {
    const params = new URLSearchParams();
    if (listScope === "all") params.set("scope", "all");
    const wd = typeof host.getWorkdir === "function" ? String(host.getWorkdir() ?? "").trim() : "";
    if (wd) params.set("workdir", wd);
    const q = params.toString();
    return q ? `/api/memory?${q}` : "/api/memory";
  }

  function renderBoard() {
    boardCard.hidden = !board;
    if (!board) {
      boardCard.replaceChildren();
      return;
    }
    const waiting = board.waiting.length ? board.waiting.join("；") : "（无）";
    const decisions = board.decisions.length ? board.decisions.join("；") : "（无）";
    boardCard.replaceChildren();
    const titleEl = doc.createElement("p");
    titleEl.className = "mem-board-title";
    titleEl.textContent = "进行中";
    const summaryEl = doc.createElement("p");
    summaryEl.className = "mem-board-summary";
    summaryEl.textContent = board.summary;
    const metaEl = doc.createElement("p");
    metaEl.className = "mem-board-meta";
    metaEl.textContent = `谁在等：${waiting} · 下一门：${board.nextGate || "（未指定）"} · 未决：${decisions}`;
    boardCard.append(titleEl, summaryEl, metaEl);
  }

  function renderScope() {
    scopeCurrent.setAttribute("aria-selected", String(listScope === "current"));
    scopeAll.setAttribute("aria-selected", String(listScope === "all"));
    scopeCurrent.classList.toggle("mem-scope-btn--active", listScope === "current");
    scopeAll.classList.toggle("mem-scope-btn--active", listScope === "all");
  }

  function renderList() {
    list.innerHTML = "";
    for (const entry of entries) {
      const li = doc.createElement("li");
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "mem-item";
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", String(entry.name === selectedName));
      if (entry.name === selectedName) btn.classList.add("mem-item--active");
      btn.dataset.name = entry.name;

      const copy = doc.createElement("span");
      copy.className = "mem-item-copy";
      const name = doc.createElement("span");
      name.className = "mem-item-name";
      name.textContent = entry.name;
      copy.appendChild(name);
      if (entry.summary) {
        const summary = doc.createElement("span");
        summary.className = "mem-item-summary";
        summary.textContent = entry.summary;
        copy.appendChild(summary);
      }
      const meta = doc.createElement("span");
      meta.className = "mem-item-meta";
      const bits = [formatSize(entry.sizeBytes)];
      if (entry.mtimeMs !== null) bits.push(formatRelTime(entry.mtimeMs, now()));
      meta.textContent = bits.join(" · ");
      copy.appendChild(meta);
      btn.appendChild(copy);

      btn.addEventListener("click", () => selectEntry(entry.name));
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  function renderPreviewPlaceholder(text) {
    preview.innerHTML = "";
    const hint = doc.createElement("div");
    hint.className = "mem-preview-hint";
    hint.textContent = text;
    preview.appendChild(hint);
  }

  function render() {
    dirLabel.hidden = !dir;
    if (dir) {
      dirLabel.textContent = dir;
      dirLabel.title = dir;
    }
    const hasEntries = listStatus === "ready" && entries.length > 0;
    const hasBoard = listStatus === "ready" && Boolean(board);
    body.hidden = !hasEntries && !hasBoard;
    empty.hidden = !(listStatus === "ready" && entries.length === 0 && !board);
    errorBox.hidden = listStatus !== "error";
    if (listStatus === "error") errorText.textContent = listError;
    if (listStatus === "loading") {
      body.hidden = false;
      renderPreviewPlaceholder("加载中…");
    }
    if (hasEntries || board) {
      body.hidden = false;
      renderBoard();
      if (hasEntries) renderList();
    }
    renderScope();
  }

  // ---- 数据 ----
  async function loadList() {
    listStatus = "loading";
    listError = "";
    render();
    let response;
    try {
      response = await fetchFn(memoryListUrl());
    } catch {
      listStatus = "error";
      listError = "记忆列表加载失败（网络错误）";
      render();
      return;
    }
    if (!response.ok) {
      listStatus = "error";
      listError = MEMORY_COPY.listError(response.status);
      render();
      return;
    }
    const payload = normalizeMemoryList(await response.json().catch(() => null));
    dir = payload.dir;
    board = payload.status;
    entries = payload.entries;
    listStatus = "ready";
    if (selectedName && !entries.some((e) => e.name === selectedName)) {
      selectedName = null;
    }
    render();
    if (!selectedName && entries.length > 0) {
      renderPreviewPlaceholder(MEMORY_COPY.previewPlaceholder);
    }
  }

  /** @param {string} name */
  async function selectEntry(name) {
    selectedName = name;
    const seq = ++previewSeq;
    renderList();
    renderPreviewPlaceholder("加载中…");
    let response;
    try {
      response = await fetchFn(`/api/memory/${encodeURIComponent(name)}`);
    } catch {
      if (seq !== previewSeq) return;
      renderPreviewPlaceholder("记忆内容加载失败（网络错误）");
      return;
    }
    if (seq !== previewSeq) return;
    if (!response.ok) {
      renderPreviewPlaceholder(MEMORY_COPY.previewError(response.status));
      return;
    }
    const file = normalizeMemoryFile(await response.json().catch(() => null));
    if (!file) {
      renderPreviewPlaceholder("记忆内容加载失败（响应格式异常）");
      return;
    }
    preview.innerHTML = "";
    const head2 = doc.createElement("div");
    head2.className = "mem-preview-head";
    head2.textContent = `${file.name} · ${formatSize(file.sizeBytes)}`;
    preview.appendChild(head2);
    if (file.truncated) {
      const note = doc.createElement("div");
      note.className = "mem-preview-truncated";
      note.setAttribute("role", "note");
      note.textContent = MEMORY_COPY.truncatedNote;
      preview.appendChild(note);
    }
    const content = doc.createElement("div");
    content.className = "mem-preview-content md";
    // core/markdown.js 的安全纪律：先整体转义再做变换，模型/文件内容当不可信输入
    content.innerHTML = renderMarkdown(file.content);
    preview.appendChild(content);
  }

  // ---- 开关 ----
  function openPanel() {
    if (open) return;
    open = true;
    restoreFocusTo = /** @type {HTMLElement|null} */ (doc.activeElement);
    overlay.hidden = false;
    trigger?.setAttribute("aria-expanded", "true");
    void loadList();
    closeBtn.focus();
    host.onAnnounce?.("记忆面板已打开");
  }

  function closePanel() {
    if (!open) return;
    open = false;
    overlay.hidden = true;
    trigger?.setAttribute("aria-expanded", "false");
    if (restoreFocusTo && typeof restoreFocusTo.focus === "function") restoreFocusTo.focus();
    restoreFocusTo = null;
  }

  // ---- 事件 ----
  trigger?.addEventListener("click", () => (open ? closePanel() : openPanel()));
  closeBtn.addEventListener("click", () => closePanel());
  scopeCurrent.addEventListener("click", () => {
    listScope = "current";
    void loadList();
  });
  scopeAll.addEventListener("click", () => {
    listScope = "all";
    void loadList();
  });
  refreshBtn.addEventListener("click", () => { void loadList(); });
  retryBtn.addEventListener("click", () => { void loadList(); });
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) closePanel();
  });
  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      closePanel();
    }
  });

  // ---- 对外 API ----
  return {
    open: openPanel,
    close: closePanel,
    isOpen: () => open,
    element: overlay,
    /** 测试与诊断用 */
    refresh: () => loadList(),
    select: (name) => selectEntry(name),
    getState: () => ({ dir, entries, board, listScope, selectedName, listStatus, listError }),
  };
}

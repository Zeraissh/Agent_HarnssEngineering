/**
 * features/global-search — 全局搜索（T6）。
 *
 * 侧栏搜索框是同一个控件的两档：
 *   1) 输入时即时本地标题过滤（宿主既有行为，本模块不碰）；
 *   2) 回车或点框内紧凑 Enter 提示 → 调 GET /api/search?q=...，
 *      在浮层里展示跨全部历史档案的标题/正文命中。
 * 不另开第三套搜索；#global-search-trigger 嵌在 .run-search-field 里，
 * 不再当 flex 兄弟去挤窄输入框。
 *
 * 与 command-palette / notifications / memory-panel 同一约定：
 *   1) 纯函数层（响应整形 / 高亮切分）——可单测；
 *   2) DOM 层 initGlobalSearch(host, env)——宿主（index.html 内联控制器）
 *      注入回调，本模块不反向 import 宿主任何东西。
 *
 * 端点契约（ui/server.ts）：
 *   GET /api/search?q=...&limit=...
 *     → { query, truncatedRuns,
 *         results: [{ runId, title, workdir, status, updatedAt,
 *                     titleHit, snippets: [{ text, lineHint }] }] }
 *   q 为空或长度 < 2 → 400
 */

import { formatRelTime } from "./notifications.js";
import { humanizeHttpFailure } from "./humanize-error.js";

// ---------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------

/**
 * @typedef {{ text:string, lineHint:string }} SearchSnippet
 * @typedef {{ runId:string, title:string, workdir:string|null, status:string,
 *             updatedAt:number, titleHit:boolean, snippets:SearchSnippet[] }} SearchResult
 * @typedef {{ query:string, results:SearchResult[], truncatedRuns:boolean }} SearchResponse
 */

/**
 * 搜索响应整形：宽容外部输入，只放行形状合法的条目。
 * @param {unknown} payload
 * @returns {SearchResponse}
 */
export function normalizeSearchResponse(payload) {
  const obj = payload && typeof payload === "object" ? /** @type {any} */ (payload) : {};
  const query = typeof obj.query === "string" ? obj.query : "";
  const raw = Array.isArray(obj.results) ? obj.results : [];
  /** @type {SearchResult[]} */
  const results = [];
  for (const r of raw) {
    if (!r || typeof r.runId !== "string" || !r.runId) continue;
    const rawSnippets = Array.isArray(r.snippets) ? r.snippets : [];
    /** @type {SearchSnippet[]} */
    const snippets = [];
    for (const s of rawSnippets) {
      if (!s || typeof s.text !== "string" || !s.text) continue;
      snippets.push({
        text: s.text,
        lineHint: typeof s.lineHint === "string" ? s.lineHint : "",
      });
    }
    results.push({
      runId: r.runId,
      title: typeof r.title === "string" ? r.title : "",
      workdir: typeof r.workdir === "string" ? r.workdir : null,
      status: typeof r.status === "string" ? r.status : "done",
      updatedAt: Number.isFinite(Number(r.updatedAt)) ? Number(r.updatedAt) : 0,
      titleHit: r.titleHit === true,
      snippets,
    });
  }
  return { query, results, truncatedRuns: obj.truncatedRuns === true };
}

/**
 * 把文本按查询词切成片段序列（大小写不敏感），hit=true 的片段渲染成 <mark>。
 * 返回纯数据而不是 HTML 字符串——高亮在 DOM 层用 textContent 拼装，
 * 历史正文是不可信输入，不过 innerHTML。
 * @param {string} text
 * @param {string} query
 * @returns {{ text:string, hit:boolean }[]}
 */
export function highlightRanges(text, query) {
  const t = String(text ?? "");
  const q = String(query ?? "").trim();
  if (!t) return [];
  if (!q) return [{ text: t, hit: false }];
  const lower = t.toLowerCase();
  const needle = q.toLowerCase();
  /** @type {{ text:string, hit:boolean }[]} */
  const ranges = [];
  let at = 0;
  for (;;) {
    const idx = lower.indexOf(needle, at);
    if (idx < 0) break;
    if (idx > at) ranges.push({ text: t.slice(at, idx), hit: false });
    ranges.push({ text: t.slice(idx, idx + q.length), hit: true });
    at = idx + q.length;
  }
  if (at < t.length) ranges.push({ text: t.slice(at), hit: false });
  return ranges;
}

/** run 状态的中文标签（meta.status 只有 running / done 两值，旧档案可能是 running） */
export const SEARCH_STATUS_LABELS = {
  running: "运行中",
  done: "已完成",
};

/** 空态/错误态等文案（测试与 UI 共用同一份，避免两处漂移）。 */
export const SEARCH_COPY = {
  trigger: "按正文全局搜索",
  panelTitle: "全局搜索",
  loading: "正在搜索全部历史对话…",
  empty: (query) => `没有找到包含「${query}」的对话`,
  error: (status) => (status === 400 ? "请输入至少 2 个字符再搜索" : humanizeHttpFailure(status, "搜索没做成")),
  networkError: "网络断了，搜索没做成",
  retry: "重试",
  titleHitBadge: "标题命中",
  truncatedNote: "历史较多，只扫描了最近 500 条档案，更早的结果可能未列出",
};

/** 查询词是否达到端点最短长度（前端先拦一道，避免必 400 的往返）。 */
export function isSearchable(query) {
  return String(query ?? "").trim().length >= 2;
}

// ---------------------------------------------------------------
// DOM 层
// ---------------------------------------------------------------

const PANEL_ID = "global-search-panel";

/**
 * 初始化全局搜索。幂等：重复调用返回既有节点的薄壳。
 *
 * host 回调：
 *   onOpenConversation(runId) → 跳转该会话（宿主走 hash 路由）
 *   onAnnounce(msg)          → aria-live 播报（可选）
 *
 * env（测试注入）：doc / fetchFn / now
 *
 * @param {Record<string, Function>} host
 * @param {{ doc?:Document, fetchFn?:typeof fetch, now?:() => number }} [env]
 */
export function initGlobalSearch(host = {}, env = {}) {
  const doc = env.doc ?? document;
  const fetchFn = env.fetchFn ?? ((...args) => fetch(...args));
  const now = env.now ?? (() => Date.now());

  const input = /** @type {HTMLInputElement|null} */ (doc.getElementById("run-search"));

  const existing = doc.getElementById(PANEL_ID);
  if (existing) {
    return {
      open: () => { existing.hidden = false; },
      close: () => { existing.hidden = true; },
      isOpen: () => !existing.hidden,
      search: () => {},
      focusInput: () => { input?.focus(); },
      element: /** @type {HTMLElement} */ (existing),
    };
  }

  // ---- 状态 ----
  let open = false;
  /** @type {"idle"|"loading"|"ready"|"error"} */
  let status = "idle";
  let errorText = "";
  /** @type {SearchResponse} */
  let data = { query: "", results: [], truncatedRuns: false };
  /** 竞态防护：快速连敲回车时只渲染最后一次搜索的结果 */
  let searchSeq = 0;

  // ---- 骨架 ----
  const overlay = doc.createElement("div");
  overlay.id = PANEL_ID;
  overlay.className = "gs-overlay";
  overlay.hidden = true;

  const panel = doc.createElement("div");
  panel.className = "gs-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", SEARCH_COPY.panelTitle);

  const head = doc.createElement("div");
  head.className = "gs-head";
  const title = doc.createElement("h2");
  title.className = "gs-title";
  title.innerHTML = '<i class="ph ph-magnifying-glass-plus" aria-hidden="true"></i> ';
  title.appendChild(doc.createTextNode(SEARCH_COPY.panelTitle));
  const queryLabel = doc.createElement("span");
  queryLabel.className = "gs-query";
  queryLabel.hidden = true;
  const closeBtn = doc.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "gs-close icon-btn";
  closeBtn.setAttribute("aria-label", "关闭全局搜索");
  closeBtn.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i>';
  head.appendChild(title);
  head.appendChild(queryLabel);
  head.appendChild(closeBtn);

  // 状态区：加载中转圈 / 错误行内提示 / 空态文案（同一槽位互斥）
  const statusBox = doc.createElement("div");
  statusBox.className = "gs-status";
  statusBox.hidden = true;

  const list = doc.createElement("ul");
  list.className = "gs-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "搜索结果");

  const footNote = doc.createElement("div");
  footNote.className = "gs-note";
  footNote.setAttribute("role", "note");
  footNote.textContent = SEARCH_COPY.truncatedNote;
  footNote.hidden = true;

  panel.appendChild(head);
  panel.appendChild(statusBox);
  panel.appendChild(list);
  panel.appendChild(footNote);
  overlay.appendChild(panel);
  doc.body.appendChild(overlay);

  // ---- 触发入口：嵌在搜索框内的紧凑 Enter 提示（点按 ≡ 回车）----
  const trigger = doc.createElement("button");
  trigger.type = "button";
  trigger.className = "gs-trigger";
  trigger.id = "global-search-trigger";
  trigger.setAttribute("aria-label", SEARCH_COPY.trigger);
  trigger.setAttribute("title", `${SEARCH_COPY.trigger}（Enter）`);
  trigger.innerHTML = '<kbd class="palette-kbd" aria-hidden="true">Enter</kbd>';
  const searchField = doc.querySelector(".run-search-field")
    ?? input?.closest?.(".run-search-field")
    ?? null;
  if (searchField) {
    searchField.appendChild(trigger);
  } else if (input?.parentNode) {
    input.parentNode.insertBefore(trigger, input.nextSibling);
  }

  // ---- 渲染 ----
  function renderStatus() {
    statusBox.innerHTML = "";
    if (status === "loading") {
      statusBox.hidden = false;
      statusBox.removeAttribute("role");
      const spinner = doc.createElement("i");
      spinner.className = "ph ph-circle-notch gs-spin";
      spinner.setAttribute("aria-hidden", "true");
      statusBox.appendChild(spinner);
      statusBox.appendChild(doc.createTextNode(SEARCH_COPY.loading));
      return;
    }
    if (status === "error") {
      statusBox.hidden = false;
      statusBox.setAttribute("role", "alert");
      const text = doc.createElement("span");
      text.className = "gs-error-text";
      text.textContent = errorText;
      const retry = doc.createElement("button");
      retry.type = "button";
      retry.className = "btn btn--ghost gs-retry";
      retry.textContent = SEARCH_COPY.retry;
      retry.addEventListener("click", () => { void runSearch(data.query); });
      statusBox.appendChild(text);
      statusBox.appendChild(retry);
      return;
    }
    if (status === "ready" && data.results.length === 0) {
      statusBox.hidden = false;
      statusBox.removeAttribute("role");
      statusBox.textContent = SEARCH_COPY.empty(data.query);
      return;
    }
    statusBox.hidden = true;
  }

  /** @param {string} text @param {string} query @param {HTMLElement} mount */
  function appendHighlighted(mount, text, query) {
    for (const range of highlightRanges(text, query)) {
      if (!range.text) continue;
      if (range.hit) {
        const mark = doc.createElement("mark");
        mark.textContent = range.text;
        mount.appendChild(mark);
      } else {
        mount.appendChild(doc.createTextNode(range.text));
      }
    }
  }

  function renderList() {
    list.innerHTML = "";
    for (const result of data.results) {
      const li = doc.createElement("li");
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "gs-item";
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", "false");
      btn.dataset.runId = result.runId;

      const titleRow = doc.createElement("span");
      titleRow.className = "gs-item-title-row";
      const titleEl = doc.createElement("span");
      titleEl.className = "gs-item-title";
      appendHighlighted(titleEl, result.title || "（无标题）", data.query);
      titleRow.appendChild(titleEl);
      if (result.titleHit) {
        const badge = doc.createElement("span");
        badge.className = "gs-item-badge";
        badge.textContent = SEARCH_COPY.titleHitBadge;
        titleRow.appendChild(badge);
      }
      btn.appendChild(titleRow);

      const meta = doc.createElement("span");
      meta.className = "gs-item-meta";
      const bits = [SEARCH_STATUS_LABELS[result.status] ?? result.status];
      if (result.updatedAt > 0) bits.push(formatRelTime(result.updatedAt, now()));
      meta.textContent = bits.join(" · ");
      btn.appendChild(meta);

      if (result.snippets.length > 0) {
        const snippetBox = doc.createElement("span");
        snippetBox.className = "gs-snippets";
        for (const snippet of result.snippets) {
          const line = doc.createElement("span");
          line.className = "gs-snippet";
          const textEl = doc.createElement("span");
          textEl.className = "gs-snippet-text";
          appendHighlighted(textEl, snippet.text, data.query);
          line.appendChild(textEl);
          if (snippet.lineHint) {
            const hint = doc.createElement("span");
            hint.className = "gs-snippet-hint";
            hint.textContent = snippet.lineHint;
            line.appendChild(hint);
          }
          snippetBox.appendChild(line);
        }
        btn.appendChild(snippetBox);
      }

      btn.addEventListener("click", () => {
        host.onOpenConversation?.(result.runId);
        closePanel();
      });
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  function render() {
    queryLabel.hidden = !data.query;
    if (data.query) {
      queryLabel.textContent = `「${data.query}」`;
      queryLabel.title = data.query;
    }
    renderStatus();
    renderList();
    footNote.hidden = !(status === "ready" && data.truncatedRuns);
  }

  // ---- 数据 ----
  /** @param {string} rawQuery */
  async function runSearch(rawQuery) {
    const query = String(rawQuery ?? "").trim();
    if (!isSearchable(query)) {
      data = { query, results: [], truncatedRuns: false };
      status = "error";
      errorText = SEARCH_COPY.error(400);
      openPanel();
      render();
      return;
    }
    const seq = ++searchSeq;
    data = { query, results: [], truncatedRuns: false };
    status = "loading";
    errorText = "";
    openPanel();
    render();
    let response;
    try {
      response = await fetchFn(`/api/search?q=${encodeURIComponent(query)}`);
    } catch {
      if (seq !== searchSeq) return;
      status = "error";
      errorText = SEARCH_COPY.networkError;
      render();
      return;
    }
    if (seq !== searchSeq) return;
    if (!response.ok) {
      status = "error";
      errorText = SEARCH_COPY.error(response.status);
      render();
      return;
    }
    data = normalizeSearchResponse(await response.json().catch(() => null));
    if (!data.query) data.query = query;
    status = "ready";
    render();
    host.onAnnounce?.(
      data.results.length > 0
        ? `全局搜索完成，命中 ${data.results.length} 条对话`
        : SEARCH_COPY.empty(data.query),
    );
  }

  // ---- 开关 ----
  function openPanel() {
    if (open) return;
    open = true;
    overlay.hidden = false;
  }

  function closePanel() {
    if (!open) return;
    open = false;
    overlay.hidden = true;
    if (input && typeof input.focus === "function") input.focus();
  }

  /** 命令面板「全局搜索」入口：聚焦侧栏搜索框并选中现有内容 */
  function focusInput() {
    if (!input) return;
    input.focus();
    if (typeof input.select === "function") input.select();
    host.onAnnounce?.("已聚焦搜索框，输入后回车做全局搜索");
  }

  // ---- 事件 ----
  trigger.addEventListener("click", () => { void runSearch(input?.value ?? ""); });
  closeBtn.addEventListener("click", () => closePanel());
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) closePanel();
  });
  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      closePanel();
    }
  });
  // 回车 = 第二档：本地标题过滤照常工作，Enter 触发正文级全局搜索
  input?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void runSearch(input.value);
  });

  // ---- 对外 API ----
  return {
    open: openPanel,
    close: closePanel,
    isOpen: () => open,
    /** @param {string} query */
    search: (query) => runSearch(query),
    focusInput,
    element: overlay,
    /** 测试与诊断用 */
    getState: () => ({ status, errorText, data }),
  };
}

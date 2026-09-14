/**
 * features/artifacts — 项目级产物画廊。
 *
 * 零依赖原生 ESM。独立视图（hash 路由 #/artifacts），与 schedules / command-center
 * 同一约定：
 *   1) 纯函数层（路由判定 / 查询串 / 过期徽章 / 时间戳）——可单测；
 *   2) DOM 层 initArtifactsView(host, env)——宿主注入回调，本模块不反向 import
 *      宿主任何东西。
 *
 * 数据同源：只认 GET /api/artifacts；卡片点击走现有 preview / canvas，
 * 「新建」回 composer。画册过期只标徽章，不自动重做。
 */

export const ARTIFACTS_HASH = "#/artifacts";

const KIND_ICON = {
  landing: "ph-browsers",
  spec: "ph-article",
  deck: "ph-presentation-chart",
  design: "ph-notebook",
};

/**
 * @param {string} hash location.hash
 * @returns {boolean}
 */
export function isArtifactsRoute(hash) {
  return String(hash ?? "") === ARTIFACTS_HASH;
}

/**
 * GET /api/artifacts 缺 workdir/projectId 现为 400。调用方必须带其一。
 * @param {{ projectId?:string|null, workdir?:string|null }|null|undefined} filter
 * @returns {string}
 */
export function artifactsQuery(filter) {
  const q = new URLSearchParams();
  const projectId = String(filter?.projectId ?? "").trim();
  const workdir = String(filter?.workdir ?? "").trim();
  if (projectId) q.set("projectId", projectId);
  else if (workdir) q.set("workdir", workdir);
  const s = q.toString();
  return s ? `/api/artifacts?${s}` : "/api/artifacts";
}

/**
 * 只有画册卡且服务端标了 deckStale 才亮「已过期」。
 * @param {{ kind?:string, deckStale?:boolean }|null|undefined} card
 */
export function shouldShowDeckStaleBadge(card) {
  return card?.kind === "deck" && card?.deckStale === true;
}

/**
 * @param {number|null|undefined} mtimeMs
 * @returns {string}
 */
export function formatArtifactStamp(mtimeMs) {
  const n = Number(mtimeMs);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n);
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** @param {string} workdir */
export function artifactWorkdirLabel(workdir) {
  const raw = String(workdir ?? "").trim();
  if (!raw) return "";
  return raw.split(/[\\/]/).filter(Boolean).pop() ?? raw;
}

const VIEW_ID = "artifacts-view";

/**
 * 初始化产物画廊。幂等：重复调用返回既有节点的薄壳。
 *
 * host：
 *   getFilter()            → { projectId?, workdir? }
 *   getHarnessSnapshot()   → 取项目名
 *   onOpenArtifacts()      → 侧栏入口（宿主写 hash）
 *   onCloseArtifacts()     → 返回
 *   onOpenArtifact(card)   → 现有 preview / canvas
 *   onNewArtifact()        → composer，带当前项目
 *   onAnnounce(msg)
 *
 * @param {Record<string, Function>} host
 * @param {{ doc?:Document, win?:Window, fetchFn?:Function }} [env]
 */
export function initArtifactsView(host = {}, env = {}) {
  const doc = env.doc ?? document;
  const fetchFn = env.fetchFn ?? ((...args) => fetch(...args));

  const existing = doc.getElementById(VIEW_ID);
  if (existing) {
    return {
      open: () => { existing.hidden = false; },
      close: () => { existing.hidden = true; },
      isOpen: () => !existing.hidden,
      element: existing,
      refresh: () => {},
    };
  }

  let open = false;
  /** @type {{ projectId?:string, workdir?:string }} */
  let filter = {};
  /** @type {Array<Record<string, any>>} */
  let cards = [];
  /** @type {HTMLElement|null} */
  let restoreFocusTo = null;

  const view = doc.createElement("div");
  view.id = VIEW_ID;
  view.className = "artifacts-view";
  view.hidden = true;

  const shell = doc.createElement("div");
  shell.className = "artifacts-shell";

  const head = doc.createElement("header");
  head.className = "artifacts-head";
  const backBtn = doc.createElement("button");
  backBtn.type = "button";
  backBtn.className = "btn btn--ghost artifacts-back";
  backBtn.innerHTML = '<i class="ph ph-arrow-left" aria-hidden="true"></i><span>返回</span>';
  backBtn.setAttribute("aria-label", "返回上一视图");
  const title = doc.createElement("h2");
  title.className = "artifacts-title";
  title.textContent = "产物";
  const newBtn = doc.createElement("button");
  newBtn.type = "button";
  newBtn.className = "btn artifacts-new-btn";
  newBtn.id = "artifacts-new-btn";
  newBtn.innerHTML = '<i class="ph ph-plus" aria-hidden="true"></i><span>新建</span>';
  head.appendChild(backBtn);
  head.appendChild(title);
  head.appendChild(newBtn);

  const body = doc.createElement("div");
  body.className = "artifacts-body";

  const grid = doc.createElement("div");
  grid.className = "artifacts-grid";
  grid.setAttribute("role", "list");

  const EMPTY_HTML =
    '<div class="empty-icon" aria-hidden="true"><i class="ph ph-folder"></i></div>' +
    "<p>还没有产物</p>";
  const emptyEl = doc.createElement("div");
  emptyEl.className = "artifacts-empty";
  emptyEl.hidden = true;

  body.appendChild(grid);
  body.appendChild(emptyEl);
  shell.appendChild(head);
  shell.appendChild(body);
  view.appendChild(shell);
  (doc.getElementById("main-panel") ?? doc.body).appendChild(view);

  function projectName() {
    const id = String(filter.projectId ?? "").trim();
    if (!id) return "";
    const list = host.getHarnessSnapshot?.()?.availableProjects;
    if (!Array.isArray(list)) return "";
    return String(list.find((p) => p?.id === id)?.name ?? "").trim();
  }

  function paintTitle() {
    const name = projectName();
    title.textContent = name ? `产物 · ${name}` : "产物";
  }

  async function reload() {
    const url = artifactsQuery(filter);
    let data = null;
    try {
      const res = await fetchFn(url);
      data = await res.json();
      const status = typeof res.status === "number" ? res.status : 200;
      if (status !== 200) {
        host.onAnnounce?.(data?.error ? String(data.error) : `加载产物失败（HTTP ${status}）`);
        cards = [];
        render();
        return;
      }
    } catch (err) {
      host.onAnnounce?.(`加载产物失败：${err instanceof Error ? err.message : String(err)}`);
      cards = [];
      render();
      return;
    }
    cards = Array.isArray(data?.artifacts) ? data.artifacts : [];
    render();
  }

  function render() {
    paintTitle();
    grid.innerHTML = "";
    if (cards.length > 0) {
      emptyEl.hidden = true;
      emptyEl.innerHTML = "";
      grid.hidden = false;
    } else {
      emptyEl.hidden = false;
      emptyEl.innerHTML = EMPTY_HTML;
      grid.hidden = true;
    }
    for (const card of cards) {
      grid.appendChild(renderCard(card));
    }
  }

  /** @param {Record<string, any>} card */
  function renderCard(card) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "artifact-card";
    btn.setAttribute("role", "listitem");
    btn.dataset.rel = String(card.rel ?? "");
    btn.dataset.kind = String(card.kind ?? "");
    if (card.workdir) btn.dataset.workdir = String(card.workdir);
    if (card.runId) btn.dataset.runId = String(card.runId);

    const top = doc.createElement("span");
    top.className = "artifact-card-top";
    const icon = doc.createElement("i");
    icon.className = `ph ${KIND_ICON[card.kind] ?? "ph-file"}`;
    icon.setAttribute("aria-hidden", "true");
    const name = doc.createElement("strong");
    name.className = "artifact-card-title";
    name.textContent = String(card.title || artifactWorkdirLabel(card.rel) || "产物");
    top.appendChild(icon);
    top.appendChild(name);
    if (shouldShowDeckStaleBadge(card)) {
      const badge = doc.createElement("span");
      badge.className = "artifact-card-stale";
      badge.textContent = "已过期";
      top.appendChild(badge);
    }
    btn.appendChild(top);

    const meta = doc.createElement("span");
    meta.className = "artifact-card-meta";
    const bits = [artifactWorkdirLabel(card.workdir), formatArtifactStamp(card.mtimeMs)].filter(Boolean);
    meta.textContent = bits.join(" · ");
    btn.appendChild(meta);

    btn.addEventListener("click", () => {
      host.onOpenArtifact?.(card);
      host.onAnnounce?.(`已打开产物：${card.title || card.rel}`);
    });
    return btn;
  }

  function openView(nextFilter) {
    if (nextFilter && typeof nextFilter === "object") filter = nextFilter;
    else filter = host.getFilter?.() ?? {};
    restoreFocusTo = /** @type {HTMLElement|null} */ (doc.activeElement);
    open = true;
    view.hidden = false;
    void reload();
    backBtn.focus();
    host.onAnnounce?.("产物已打开");
  }

  function closeView() {
    if (!open) return;
    open = false;
    view.hidden = true;
    emptyEl.hidden = true;
    emptyEl.innerHTML = "";
    if (restoreFocusTo && typeof restoreFocusTo.focus === "function" && doc.contains?.(restoreFocusTo) !== false) {
      restoreFocusTo.focus();
    }
    restoreFocusTo = null;
  }

  backBtn.addEventListener("click", () => host.onCloseArtifacts?.());
  newBtn.addEventListener("click", () => host.onNewArtifact?.());

  const openBtn = doc.getElementById("artifacts-open-btn");
  if (openBtn) {
    openBtn.addEventListener("click", () => host.onOpenArtifacts?.());
  }

  return {
    open: openView,
    close: closeView,
    isOpen: () => open,
    element: view,
    refresh: reload,
  };
}

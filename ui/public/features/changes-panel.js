/**
 * features/changes-panel — 变更审查视图（T8）。
 *
 * 监督式产品最关键的缺口：产物面板只列"最终交付了什么"，这里回答的是
 * "agent 这次运行**碰了**哪些文件"——新建还是修改、碰了几次、现状如何，
 * 有 git 仓库时再带上 M/A/?? 状态与 +x/-y 摘要。
 *
 * 与 command-palette / memory-panel 同一约定：
 *   1) 纯函数层（响应整形 / 徽章派生 / 预览截取）——可单测；
 *   2) DOM 层 initChangesPanel(host, env)——宿主（index.html 内联控制器）注入回调，
 *      本模块不反向 import 宿主任何东西。
 *
 * 挂载形态：对话详情右栏 rail 的一个 <details class="rail-section"> 分区。
 * app.js 的骨架在换 run 时整体重建，宿主在每次渲染后调 mount(railBody) 把
 * 本分区节点搬回新骨架（同一节点 re-parent，状态不丢）。
 *
 * 端点契约（ui/server.ts）：
 *   GET /api/runs/:id/changes →
 *     { runId, workdir, git: boolean,
 *       changes: [{ path, ops: ["write"|"edit"], count, lastAt,
 *                   outOfScope, exists, sizeBytes, mtimeMs,
 *                   git: { status, added, deleted } | null }] }
 *   预览沿用既有 GET /api/runs/:id/artifact?path=...（同一条圈禁）。
 */

import { formatRelTime } from "./notifications.js";
import { formatSize } from "./memory-panel.js";

// ---------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------

/**
 * @typedef {{ status:string, added:number|null, deleted:number|null }} ChangeGit
 * @typedef {{ path:string, ops:string[], count:number, lastAt:number|null,
 *   outOfScope:boolean, exists:boolean, sizeBytes:number|null, mtimeMs:number|null,
 *   git:ChangeGit|null }} ChangeEntry
 */

/** 操作标签 → 徽章文案（新建还是修改，一眼可见） */
export const OP_BADGES = {
  write: { label: "写入", className: "chg-op-badge--write" },
  edit: { label: "修改", className: "chg-op-badge--edit" },
};

/** git porcelain 归一状态 → 徽章文案与样式类。未知状态原样透出，不伪造。 */
export const GIT_STATUS_BADGES = {
  M: { label: "M", className: "chg-git-badge--m", hint: "已跟踪，有未提交修改" },
  A: { label: "A", className: "chg-git-badge--a", hint: "新增（已暂存）" },
  "??": { label: "??", className: "chg-git-badge--untracked", hint: "未跟踪的新文件" },
  D: { label: "D", className: "chg-git-badge--d", hint: "已从工作区删除" },
};

/** 空态与提示文案（测试与 UI 共用同一份，避免两处漂移）。 */
export const CHANGES_COPY = {
  empty: "本次运行没有写盘操作",
  listError: (status) => `变更列表加载失败（HTTP ${status}）`,
  listNetworkError: "变更列表加载失败（网络错误）",
  runGone: "这次运行的档案已不存在",
  loading: "加载中…",
  outOfScope: "路径越出本次工作目录，不提供预览",
  deleted: "文件已被删除，不提供预览",
  binary: "非文本文件，请用产物面板的预览 / 下载",
  previewError: (status) => `文件内容加载失败（HTTP ${status}）`,
  previewNetworkError: "文件内容加载失败（网络错误）",
  previewTruncated: (n) => `仅显示前 ${n} 行`,
};

/** 内联预览的行数上限 */
export const PREVIEW_MAX_LINES = 100;

/** 可内联预览的文本扩展名（小写，不带点）。其余一律按二进制处理。 */
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "jsonl", "js", "mjs", "cjs", "ts", "mts", "cts",
  "jsx", "tsx", "css", "html", "htm", "svg", "xml", "yml", "yaml", "toml", "ini",
  "cfg", "conf", "py", "java", "c", "h", "cpp", "hpp", "cs", "go", "rs", "rb",
  "php", "sh", "bash", "zsh", "ps1", "bat", "cmd", "sql", "vue", "svelte", "csv",
  "log", "env", "gitignore", "gitattributes", "editorconfig", "lock",
]);

/**
 * 路径是否可按文本内联预览。只看扩展名——内容与圈禁由服务端 artifact 端点兜底。
 * @param {string} p
 * @returns {boolean}
 */
export function isTextPreviewable(p) {
  const name = String(p ?? "");
  const base = name.slice(name.lastIndexOf("/") + 1).slice(name.lastIndexOf("\\") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    // 无扩展名的知名文本文件名放行（Makefile / Dockerfile / LICENSE…）
    return ["makefile", "dockerfile", "license", "readme", "changelog"].includes(base.toLowerCase());
  }
  return TEXT_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/**
 * 截取文本前 maxLines 行。
 * @param {string} text
 * @param {number} [maxLines]
 * @returns {{ text:string, truncated:boolean, totalLines:number }}
 */
export function firstLines(text, maxLines = PREVIEW_MAX_LINES) {
  const lines = String(text ?? "").split("\n");
  const truncated = lines.length > maxLines;
  return {
    text: truncated ? lines.slice(0, maxLines).join("\n") : lines.join("\n"),
    truncated,
    totalLines: lines.length,
  };
}

/**
 * JSON `null` 不能走 `Number(x)`——`Number(null) === 0`，会把「没有行差」
 * 收成 `+0/-0`，未跟踪新文件看起来像空改动。
 * @param {unknown} value
 * @returns {number|null}
 */
export function optionalNumber(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 列表响应整形：宽容外部输入，只放行形状合法的条目。
 * @param {unknown} payload
 * @returns {{ runId:string|null, workdir:string|null, git:boolean, changes:ChangeEntry[] }}
 */
export function normalizeChanges(payload) {
  const obj = payload && typeof payload === "object" ? /** @type {any} */ (payload) : {};
  const raw = Array.isArray(obj.changes) ? obj.changes : [];
  /** @type {ChangeEntry[]} */
  const changes = [];
  for (const e of raw) {
    if (!e || typeof e.path !== "string" || !e.path) continue;
    const ops = Array.isArray(e.ops) ? e.ops.filter((o) => typeof o === "string") : [];
    const gitRaw = e.git && typeof e.git === "object" ? e.git : null;
    changes.push({
      path: e.path,
      ops,
      count: optionalNumber(e.count) ?? 0,
      lastAt: optionalNumber(e.lastAt),
      outOfScope: e.outOfScope === true,
      exists: e.exists === true,
      sizeBytes: optionalNumber(e.sizeBytes),
      mtimeMs: optionalNumber(e.mtimeMs),
      git: gitRaw && typeof gitRaw.status === "string"
        ? {
            status: gitRaw.status,
            added: optionalNumber(gitRaw.added),
            deleted: optionalNumber(gitRaw.deleted),
          }
        : null,
    });
  }
  return {
    runId: typeof obj.runId === "string" ? obj.runId : null,
    workdir: typeof obj.workdir === "string" ? obj.workdir : null,
    git: obj.git === true,
    changes,
  };
}

/**
 * 单条目的徽章派生：操作徽章（ops 去重保序）+ git 徽章 + diff 摘要。
 * 纯数据，渲染与测试共用。
 * @param {ChangeEntry} entry
 * @returns {{ ops:{label:string, className:string}[],
 *   git:{label:string, className:string, hint:string}|null,
 *   diff:string|null }}
 */
export function badgesForEntry(entry) {
  const ops = [];
  const seen = new Set();
  for (const op of entry.ops) {
    const badge = OP_BADGES[op];
    if (!badge || seen.has(op)) continue;
    seen.add(op);
    ops.push(badge);
  }
  let git = null;
  let diff = null;
  if (entry.git) {
    const known = GIT_STATUS_BADGES[entry.git.status];
    git = known ?? { label: entry.git.status, className: "chg-git-badge--other", hint: "git 状态" };
    const { added, deleted } = entry.git;
    // 未跟踪文件的增删是 null（相对 HEAD 无 diff）。两端都是 0 也没信息——
    // 画 +0/-0 看起来像坏账，不如不画。
    if ((added !== null || deleted !== null) && ((added ?? 0) !== 0 || (deleted ?? 0) !== 0)) {
      diff = `+${added ?? 0}/-${deleted ?? 0}`;
    }
  }
  return { ops, git, diff };
}

// ---------------------------------------------------------------
// DOM 层
// ---------------------------------------------------------------

/**
 * 初始化变更审查分区。幂等：重复调用返回既有实例。
 *
 * host 回调：
 *   onAnnounce(msg) → aria-live 播报（可选）
 *
 * env（测试注入）：doc / fetchFn / now
 *
 * @param {Record<string, Function>} host
 * @param {{ doc?:Document, fetchFn?:typeof fetch, now?:() => number }} [env]
 */
export function initChangesPanel(host = {}, env = {}) {
  const doc = env.doc ?? document;
  const fetchFn = env.fetchFn ?? ((...args) => fetch(...args));
  const now = env.now ?? (() => Date.now());

  const existing = doc.querySelector(".changes-section[data-chg-panel]");
  if (existing && existing.__chgApi) return existing.__chgApi;

  // ---- 状态 ----
  /** @type {string|null} */
  let runId = null;
  /** @type {"idle"|"loading"|"ready"|"error"} */
  let status = "idle";
  let error = "";
  /** @type {ChangeEntry[]} */
  let changes = [];
  let gitRepo = false;
  /** @type {string|null} 当前展开预览的路径 */
  let expandedPath = null;
  /** 列表与预览的竞态防护：快速连点/切 run 时只渲染最后一次请求的结果 */
  let listSeq = 0;
  let previewSeq = 0;

  // ---- 骨架：rail 分区（<details>，与产物清单同形态）----
  const section = doc.createElement("details");
  section.className = "rail-section changes-section";
  section.dataset.chgPanel = "1";
  section.open = true;

  const summary = doc.createElement("summary");
  summary.className = "rail-section-title";
  const summaryIcon = doc.createElement("i");
  summaryIcon.className = "ph ph-files";
  summaryIcon.setAttribute("aria-hidden", "true");
  const summaryText = doc.createElement("span");
  summaryText.textContent = " 变更 ";
  const countPeek = doc.createElement("span");
  countPeek.className = "aside-peek";
  countPeek.hidden = true;
  summary.appendChild(summaryIcon);
  summary.appendChild(summaryText);
  summary.appendChild(countPeek);

  const body = doc.createElement("div");
  body.className = "chg-body";
  body.setAttribute("aria-live", "polite");

  section.appendChild(summary);
  section.appendChild(body);

  // ---- 渲染 ----
  function renderRow(entry) {
    const row = doc.createElement("div");
    row.className = "chg-row";

    const canPreview = !entry.outOfScope && entry.exists && isTextPreviewable(entry.path);
    const head = doc.createElement(canPreview ? "button" : "div");
    head.className = "chg-row-head";
    if (canPreview) {
      head.type = "button";
      head.setAttribute("aria-expanded", String(entry.path === expandedPath));
      head.addEventListener("click", () => togglePreview(entry));
    }

    const pathEl = doc.createElement("span");
    pathEl.className = "chg-path";
    pathEl.textContent = entry.path;
    pathEl.title = entry.path;
    head.appendChild(pathEl);

    const { ops, git, diff } = badgesForEntry(entry);
    const badges = doc.createElement("span");
    badges.className = "chg-badges";
    for (const badge of ops) {
      const el = doc.createElement("span");
      el.className = `chg-op-badge ${badge.className}`;
      el.textContent = badge.label;
      badges.appendChild(el);
    }
    if (git) {
      const el = doc.createElement("span");
      el.className = `chg-git-badge ${git.className}`;
      el.textContent = git.label;
      el.title = git.hint;
      badges.appendChild(el);
    }
    if (diff) {
      const el = doc.createElement("span");
      el.className = "chg-diff";
      el.textContent = diff;
      badges.appendChild(el);
    }
    head.appendChild(badges);
    row.appendChild(head);

    const meta = doc.createElement("div");
    meta.className = "chg-meta";
    const bits = [];
    if (entry.count > 1) bits.push(`触碰 ${entry.count} 次`);
    if (entry.sizeBytes !== null) bits.push(formatSize(entry.sizeBytes));
    if (entry.mtimeMs !== null) bits.push(formatRelTime(entry.mtimeMs, now()));
    if (entry.outOfScope) bits.push(CHANGES_COPY.outOfScope);
    else if (!entry.exists) bits.push(CHANGES_COPY.deleted);
    else if (!canPreview) bits.push(CHANGES_COPY.binary);
    meta.textContent = bits.join(" · ");
    row.appendChild(meta);

    if (canPreview && entry.path === expandedPath) {
      const preview = doc.createElement("div");
      preview.className = "chg-preview";
      preview.dataset.chgPreviewFor = entry.path;
      row.appendChild(preview);
    }
    return row;
  }

  function render() {
    countPeek.hidden = !(status === "ready" && changes.length > 0);
    if (!countPeek.hidden) countPeek.textContent = String(changes.length);
    body.innerHTML = "";
    if (!runId) {
      // 没选会话时整区收起（分区仍在骨架里，不闪）
      section.hidden = true;
      return;
    }
    section.hidden = false;
    if (status === "loading" || status === "idle") {
      const hint = doc.createElement("p");
      hint.className = "chg-hint";
      hint.textContent = CHANGES_COPY.loading;
      body.appendChild(hint);
      return;
    }
    if (status === "error") {
      const box = doc.createElement("p");
      box.className = "chg-error";
      box.setAttribute("role", "alert");
      box.textContent = error;
      body.appendChild(box);
      return;
    }
    if (changes.length === 0) {
      const empty = doc.createElement("p");
      empty.className = "chg-hint";
      empty.textContent = CHANGES_COPY.empty;
      body.appendChild(empty);
      return;
    }
    const list = doc.createElement("div");
    list.className = "chg-list";
    for (const entry of changes) list.appendChild(renderRow(entry));
    body.appendChild(list);
  }

  // ---- 数据 ----
  async function load() {
    if (!runId) return;
    const seq = ++listSeq;
    status = "loading";
    error = "";
    render();
    let response;
    try {
      response = await fetchFn(`/api/runs/${encodeURIComponent(runId)}/changes`);
    } catch {
      if (seq !== listSeq) return;
      status = "error";
      error = CHANGES_COPY.listNetworkError;
      render();
      return;
    }
    if (seq !== listSeq) return;
    if (!response.ok) {
      status = "error";
      error = response.status === 404 ? CHANGES_COPY.runGone : CHANGES_COPY.listError(response.status);
      render();
      return;
    }
    const payload = normalizeChanges(await response.json().catch(() => null));
    changes = payload.changes;
    gitRepo = payload.git;
    status = "ready";
    if (expandedPath && !changes.some((c) => c.path === expandedPath)) expandedPath = null;
    render();
    if (expandedPath) {
      // 展开态跨刷新保留：重画后预览容器是新的，内容要重填
      const entry = changes.find((c) => c.path === expandedPath);
      if (entry) void fillPreview(entry);
    }
  }

  /** @param {ChangeEntry} entry */
  async function fillPreview(entry) {
    const seq = ++previewSeq;
    // 路径可含引号/反斜杠，拼 selector 需要转义；直接按 dataset 值找，绕开 CSS.escape 依赖
    const container = [...body.querySelectorAll("[data-chg-preview-for]")]
      .find((el) => el.dataset.chgPreviewFor === entry.path);
    if (!container) return;
    container.textContent = CHANGES_COPY.loading;
    let response;
    try {
      response = await fetchFn(
        `/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(entry.path)}`,
      );
    } catch {
      if (seq !== previewSeq) return;
      container.textContent = CHANGES_COPY.previewNetworkError;
      return;
    }
    if (seq !== previewSeq) return;
    if (!response.ok) {
      container.textContent = CHANGES_COPY.previewError(response.status);
      return;
    }
    const text = await response.text().catch(() => null);
    if (seq !== previewSeq) return;
    if (text === null) {
      container.textContent = CHANGES_COPY.previewNetworkError;
      return;
    }
    const cut = firstLines(text);
    container.innerHTML = "";
    const pre = doc.createElement("pre");
    pre.className = "chg-preview-code";
    pre.textContent = cut.text || "（空文件）";
    container.appendChild(pre);
    if (cut.truncated) {
      const note = doc.createElement("div");
      note.className = "chg-preview-note";
      note.setAttribute("role", "note");
      note.textContent = CHANGES_COPY.previewTruncated(PREVIEW_MAX_LINES);
      container.appendChild(note);
    }
  }

  /** @param {ChangeEntry} entry */
  function togglePreview(entry) {
    expandedPath = expandedPath === entry.path ? null : entry.path;
    render();
    if (expandedPath === entry.path) void fillPreview(entry);
  }

  // ---- 对外 API ----
  const api = {
    element: section,
    /**
     * 把分区搬进取代骨架的 rail-body。app.js 换 run 会重建骨架，
     * re-parent 同一节点即可，加载态与展开态都不丢。
     * @param {Element} container
     */
    mount(container) {
      if (container && section.parentElement !== container) container.appendChild(section);
    },
    /**
     * 切换当前 run。runId 变化触发重载；null 收起分区。
     * @param {string|null} nextRunId
     */
    setRun(nextRunId) {
      const id = nextRunId || null;
      if (id === runId) return;
      runId = id;
      changes = [];
      expandedPath = null;
      status = "idle";
      error = "";
      render();
      if (runId) void load();
    },
    /** 手动刷新（测试与诊断用） */
    refresh: () => load(),
    /**
     * 命令面板「查看本次变更」：展开分区并把它带进视野。
     * @returns {boolean} 当前有选中会话才返回 true
     */
    reveal() {
      if (!runId) return false;
      section.open = true;
      section.scrollIntoView?.({ block: "nearest" });
      section.classList.remove("changes-section--flash");
      void section.offsetWidth; // 强制重排，连续两次也能重播高亮
      section.classList.add("changes-section--flash");
      host.onAnnounce?.("已定位到本次运行的变更列表");
      return true;
    },
    isGitRepo: () => gitRepo,
    getState: () => ({ runId, status, error, changes, expandedPath }),
  };
  section.__chgApi = api;
  render();
  return api;
}

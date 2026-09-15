/**
 * features/github-pr — 从当前工作目录真开 GitHub PR。
 * 不造 compare 弱链。失败用人话，成功只给 URL。
 */

import { humanizeHttpFailure } from "./humanize-error.js";

export const GITHUB_PR_API_URL = "/api/workspace/git/pr";

export const GITHUB_PR_COPY = {
  open: "开 PR",
  titleLabel: "标题",
  bodyLabel: "说明",
  submit: "开到 GitHub",
  submitting: "正在开…",
  cancel: "取消",
  opened: "打开 PR",
  titlePlaceholder: (head) => (head ? head : "这次改动一句话"),
  bodyPlaceholder: "可选。给评审看的说明。",
  fromTo: (head, base) => (head && base ? `从 ${head} 开到 ${base}` : ""),
  networkError: "没开成 PR（网络错误）",
  createError: (status, fallback) => humanizeHttpFailure(status, fallback ?? "没开成 PR"),
  readyError: (status, fallback) => humanizeHttpFailure(status, fallback ?? "现在还不能开 PR"),
};

/**
 * @param {string} workdir
 * @returns {string}
 */
export function githubPrReadyUrl(workdir) {
  return `${GITHUB_PR_API_URL}?workdir=${encodeURIComponent(String(workdir ?? ""))}`;
}

/**
 * @param {unknown} body
 * @returns {{ workdir: string, title?: string, body?: string, base?: string, head?: string }}
 */
export function buildCreatePrPayload(workdir, fields = {}) {
  const payload = { workdir: String(workdir ?? "") };
  const title = String(fields.title ?? "").trim();
  const body = String(fields.body ?? "").trim();
  const base = String(fields.base ?? "").trim();
  const head = String(fields.head ?? "").trim();
  if (title) payload.title = title;
  if (body) payload.body = body;
  if (base) payload.base = base;
  if (head) payload.head = head;
  return payload;
}

/**
 * @param {unknown} data
 * @returns {string}
 */
export function prUrlFromResponse(data) {
  const url = data && typeof data === "object" ? String(data.url ?? "").trim() : "";
  return /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i.test(url) ? url : "";
}

/**
 * @param {HTMLElement} host
 * @param {{
 *   git?: { present?: boolean, branch?: string|null, github?: { owner?: string, repo?: string }|null },
 *   ready?: { ready?: boolean, error?: string, head?: string, base?: string, defaultTitle?: string, repo?: { owner?: string, repo?: string } }|null,
 *   busy?: boolean,
 *   error?: string,
 *   url?: string,
 *   title?: string,
 *   body?: string,
 * }} [state]
 */
export function renderGithubPrPanel(host, state = {}) {
  host.replaceChildren();
  const doc = host.ownerDocument;
  const git = state.git;
  const owner = git?.github?.owner;
  const repo = git?.github?.repo;
  if (!git || git.present !== true || !owner || !repo) return;

  if (state.url) {
    const link = doc.createElement("a");
    link.className = "git-pr-link git-pr-opened";
    link.href = state.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = GITHUB_PR_COPY.opened;
    host.appendChild(link);
    return;
  }

  const ready = state.ready;
  if (ready && ready.ready === false) {
    const note = doc.createElement("p");
    note.className = "wd-menu-hint git-honesty git-pr-error";
    note.textContent = ready.error || GITHUB_PR_COPY.readyError(409);
    host.appendChild(note);
    return;
  }

  if (state.error) {
    const note = doc.createElement("p");
    note.className = "wd-menu-hint git-honesty git-pr-error";
    note.textContent = state.error;
    host.appendChild(note);
  }

  const form = doc.createElement("form");
  form.className = "git-pr-form";
  form.setAttribute("data-github-pr", "form");

  const head = ready?.head || git.branch || "";
  const base = ready?.base || "";
  const route = GITHUB_PR_COPY.fromTo(head, base);
  if (route) {
    const hint = doc.createElement("p");
    hint.className = "wd-menu-hint git-pr-route";
    hint.textContent = route;
    form.appendChild(hint);
  }

  const titleLabel = doc.createElement("label");
  titleLabel.className = "git-pr-label";
  titleLabel.textContent = GITHUB_PR_COPY.titleLabel;
  const title = doc.createElement("input");
  title.type = "text";
  title.name = "title";
  title.className = "git-pr-input";
  title.placeholder = GITHUB_PR_COPY.titlePlaceholder(head);
  title.value = state.title ?? ready?.defaultTitle ?? "";
  title.disabled = Boolean(state.busy);
  titleLabel.appendChild(title);
  form.appendChild(titleLabel);

  const bodyLabel = doc.createElement("label");
  bodyLabel.className = "git-pr-label";
  bodyLabel.textContent = GITHUB_PR_COPY.bodyLabel;
  const body = doc.createElement("textarea");
  body.name = "body";
  body.className = "git-pr-input git-pr-body";
  body.rows = 3;
  body.placeholder = GITHUB_PR_COPY.bodyPlaceholder;
  body.value = state.body ?? "";
  body.disabled = Boolean(state.busy);
  bodyLabel.appendChild(body);
  form.appendChild(bodyLabel);

  const actions = doc.createElement("div");
  actions.className = "git-dirty-actions";
  const submit = doc.createElement("button");
  submit.type = "submit";
  submit.className = "git-dirty-btn";
  submit.dataset.prAction = "submit";
  submit.disabled = Boolean(state.busy);
  submit.textContent = state.busy ? GITHUB_PR_COPY.submitting : GITHUB_PR_COPY.submit;
  actions.appendChild(submit);
  form.appendChild(actions);
  host.appendChild(form);
}

/**
 * @param {HTMLElement} menu
 * @param {{
 *   getWorkdir?: () => string,
 *   fetch?: typeof fetch,
 *   onAnnounce?: (msg: string) => void,
 *   git?: object,
 * }} [hooks]
 */
export function initGithubPrMount(menu, hooks = {}) {
  const fetchFn = hooks.fetch ?? globalThis.fetch.bind(globalThis);
  const state = {
    git: hooks.git ?? null,
    ready: null,
    busy: false,
    error: "",
    url: "",
    title: "",
    body: "",
  };

  function paint() {
    const host = menu.querySelector("[data-github-pr-host]") ?? menu;
    renderGithubPrPanel(host, state);
  }

  async function refreshReady() {
    const workdir = hooks.getWorkdir?.() ?? "";
    if (!workdir || !state.git?.github?.owner) {
      state.ready = null;
      paint();
      return state.ready;
    }
    try {
      const res = await fetchFn(githubPrReadyUrl(workdir));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        state.ready = { ready: false, error: data.error || GITHUB_PR_COPY.readyError(res.status) };
      } else {
        state.ready = data;
      }
    } catch {
      state.ready = { ready: false, error: GITHUB_PR_COPY.networkError };
    }
    paint();
    return state.ready;
  }

  async function submit(fields) {
    const workdir = hooks.getWorkdir?.() ?? "";
    if (!workdir || state.busy) return null;
    state.busy = true;
    state.error = "";
    state.title = fields.title ?? "";
    state.body = fields.body ?? "";
    paint();
    try {
      const res = await fetchFn(GITHUB_PR_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildCreatePrPayload(workdir, {
          title: state.title,
          body: state.body,
          base: state.ready?.base,
          head: state.ready?.head,
        })),
      });
      const data = await res.json().catch(() => ({}));
      const url = prUrlFromResponse(data);
      if (!res.ok || !url) {
        state.error = data.error || GITHUB_PR_COPY.createError(res.status);
        hooks.onAnnounce?.(state.error);
        return null;
      }
      state.url = url;
      hooks.onAnnounce?.(url);
      return { url };
    } catch (err) {
      state.error = err instanceof Error ? err.message : GITHUB_PR_COPY.networkError;
      hooks.onAnnounce?.(state.error);
      return null;
    } finally {
      state.busy = false;
      paint();
    }
  }

  menu.addEventListener("submit", (event) => {
    const form = event.target instanceof Element ? event.target.closest("[data-github-pr='form']") : null;
    if (!form) return;
    event.preventDefault();
    const title = form.querySelector("[name='title']");
    const body = form.querySelector("[name='body']");
    void submit({
      title: title && "value" in title ? title.value : "",
      body: body && "value" in body ? body.value : "",
    });
  });

  const api = {
    paint,
    refreshReady,
    submit,
    get state() { return state; },
    setGit(git) {
      state.git = git;
      state.url = "";
      state.error = "";
    },
  };
  paint();
  return api;
}

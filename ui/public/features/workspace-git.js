/**
 * features/workspace-git — composer 分支芯片（Cursor 状态栏同款）。
 * 仓库/分支是工作区事实，跟 workdir 走，不是领域包。
 */

export function formatGitTriggerLabel(git) {
  if (!git || git.present !== true) return "";
  const head = git.detached ? `detached ${git.branch || "HEAD"}` : (git.branch || "HEAD");
  return git.dirty ? `${head} *` : head;
}

export function formatGitTitle(git) {
  if (!git || git.present !== true) return "";
  const repo = git.github?.owner && git.github.repo
    ? `${git.github.owner}/${git.github.repo}`
    : (git.root || "local git");
  return git.dirty ? `${repo} · 有未提交改动` : repo;
}

export function renderGitMenu(menu, git) {
  menu.replaceChildren();
  if (!git || git.present !== true) return;
  if (git.github?.owner && git.github.repo) {
    const hint = menu.ownerDocument.createElement("p");
    hint.className = "wd-menu-hint";
    hint.textContent = `${git.github.owner}/${git.github.repo}`;
    menu.appendChild(hint);
  }
  const list = menu.ownerDocument.createElement("div");
  list.className = "wd-menu-list";
  const branches = Array.isArray(git.branches) ? git.branches : [];
  if (!branches.length) {
    const empty = menu.ownerDocument.createElement("p");
    empty.className = "wd-menu-hint";
    empty.textContent = git.detached ? "游离 HEAD，没有本地分支可切" : "没有本地分支";
    list.appendChild(empty);
  }
  for (const name of branches) {
    const btn = menu.ownerDocument.createElement("button");
    btn.type = "button";
    btn.className = "git-option";
    btn.dataset.branch = name;
    const current = name === git.branch && !git.detached;
    if (current) btn.classList.add("is-current");
    btn.disabled = current;
    btn.textContent = name;
    list.appendChild(btn);
  }
  menu.appendChild(list);
}

export function renderDirtyCheckoutPrompt(menu, { branch, fromBranch, busy } = {}) {
  const doc = menu.ownerDocument;
  menu.replaceChildren();
  const card = doc.createElement("div");
  card.className = "git-dirty-prompt";
  const title = doc.createElement("p");
  title.className = "git-dirty-title";
  title.textContent = "有未提交的改动";
  const hint = doc.createElement("p");
  hint.className = "wd-menu-hint";
  const target = String(branch ?? "").trim() || "目标分支";
  const from = String(fromBranch ?? "").trim();
  hint.textContent = from
    ? `从 ${from} 切到 ${target} 前，要先处理当前工作区。`
    : `切换到 ${target} 前，要先处理当前工作区。`;
  const actions = doc.createElement("div");
  actions.className = "git-dirty-actions";
  const stash = doc.createElement("button");
  stash.type = "button";
  stash.className = "git-dirty-btn";
  stash.dataset.dirtyAction = "stash";
  stash.textContent = "暂存后切换";
  stash.disabled = Boolean(busy);
  const discard = doc.createElement("button");
  discard.type = "button";
  discard.className = "git-dirty-btn git-dirty-btn--discard";
  discard.dataset.dirtyAction = "discard";
  discard.textContent = "丢弃改动并切换";
  discard.disabled = Boolean(busy);
  const cancel = doc.createElement("button");
  cancel.type = "button";
  cancel.className = "git-dirty-btn git-dirty-btn--cancel";
  cancel.dataset.dirtyAction = "cancel";
  cancel.textContent = "取消";
  cancel.disabled = Boolean(busy);
  actions.append(stash, discard, cancel);
  card.append(title, hint, actions);
  menu.appendChild(card);
}

/**
 * @param {HTMLElement} root
 * @param {{
 *   getWorkdir?: () => string,
 *   onAnnounce?: (msg: string) => void,
 *   fetch?: typeof fetch,
 *   trigger?: HTMLElement,
 *   menu?: HTMLElement,
 *   triggerText?: HTMLElement,
 * }} [hooks]
 * @param {{ doc?: Document }} [env]
 */
export function initWorkspaceGitChip(root, hooks = {}, env = {}) {
  if (root.__workspaceGitChip) {
    void root.__workspaceGitChip.refresh();
    return root.__workspaceGitChip;
  }
  const doc = env.doc ?? root.ownerDocument ?? document;
  const fetchFn = hooks.fetch ?? globalThis.fetch.bind(globalThis);
  const trigger = hooks.trigger ?? root.querySelector("#workspace-git-trigger");
  const menu = hooks.menu ?? root.querySelector("#workspace-git-menu");
  const triggerText = hooks.triggerText
    ?? root.querySelector("#workspace-git-trigger-text")
    ?? root.querySelector(".wd-trigger-text");
  if (!trigger || !menu) return null;

  let snapshot = { present: false };
  let busy = false;
  let pendingDirty = null;

  function closeMenu() {
    pendingDirty = null;
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  }

  function paint() {
    const present = snapshot?.present === true;
    root.hidden = !present;
    if (!present) {
      closeMenu();
      return snapshot;
    }
    if (triggerText) triggerText.textContent = formatGitTriggerLabel(snapshot);
    trigger.title = formatGitTitle(snapshot);
    trigger.disabled = busy;
    trigger.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
    if (!menu.hidden) {
      if (pendingDirty) {
        renderDirtyCheckoutPrompt(menu, {
          branch: pendingDirty.branch,
          fromBranch: snapshot.branch,
          busy,
        });
      } else {
        renderGitMenu(menu, snapshot);
      }
    }
    return snapshot;
  }

  async function refresh() {
    const workdir = hooks.getWorkdir?.();
    if (!workdir) {
      snapshot = { present: false };
      paint();
      return snapshot;
    }
    try {
      const res = await fetchFn(`/api/workspace/git?workdir=${encodeURIComponent(workdir)}`);
      snapshot = res.ok ? await res.json() : { present: false };
    } catch {
      snapshot = { present: false };
    }
    paint();
    return snapshot;
  }

  async function checkout(branch, dirtyAction) {
    const workdir = hooks.getWorkdir?.();
    const name = String(branch ?? "").trim();
    if (!workdir || !name || busy) return;
    busy = true;
    paint();
    try {
      const res = await fetchFn("/api/workspace/git/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workdir,
          branch: name,
          ...(dirtyAction ? { dirtyAction } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body.code === "dirty_worktree") {
          pendingDirty = { branch: name };
          return;
        }
        pendingDirty = null;
        hooks.onAnnounce?.(body.error || `无法切换到 ${name}`);
        return;
      }
      pendingDirty = null;
      snapshot = body;
      closeMenu();
      hooks.onAnnounce?.(formatGitTriggerLabel(snapshot) || name);
    } catch (err) {
      pendingDirty = null;
      hooks.onAnnounce?.(err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
      paint();
    }
  }

  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    if (trigger.disabled || root.hidden) return;
    if (menu.hidden) {
      pendingDirty = null;
      menu.hidden = false;
      paint();
    } else {
      closeMenu();
    }
  });

  menu.addEventListener("click", (event) => {
    const actionBtn = event.target instanceof Element
      ? event.target.closest("[data-dirty-action]")
      : null;
    if (actionBtn) {
      const action = actionBtn.dataset.dirtyAction;
      if (action === "cancel") {
        pendingDirty = null;
        paint();
        return;
      }
      if ((action === "stash" || action === "discard") && pendingDirty) {
        void checkout(pendingDirty.branch, action);
      }
      return;
    }
    const target = event.target instanceof Element ? event.target.closest("[data-branch]") : null;
    if (!target || target.disabled) return;
    void checkout(target.dataset.branch);
  });

  doc.addEventListener("mousedown", (event) => {
    if (menu.hidden) return;
    const t = event.target;
    if (t instanceof Node && root.contains(t)) return;
    closeMenu();
  });
  doc.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || menu.hidden) return;
    event.preventDefault();
    closeMenu();
    if (typeof trigger.focus === "function") trigger.focus();
  });

  const api = { paint, refresh, checkout, close: closeMenu };
  root.__workspaceGitChip = api;
  paint();
  return api;
}

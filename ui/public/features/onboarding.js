/**
 * features/onboarding — 首次引导。
 *
 * 第一次打开宿主时盖一层说明，指向工作目录 / 输入框 / 运行设置 / 侧栏。
 * 完成或跳过写 localStorage；设置 → 关于可以再看一遍。
 */

export const ONBOARDING_STORAGE_KEY = "agent.ui.pref.onboardingDone";

export const ONBOARDING_STEPS = [
  {
    id: "composer",
    title: "打一句话，回车",
    body: "在输入框里写下要做的事，按 Enter 发送。Shift+Enter 换行。下面的例子只填进输入框，由你确认后再跑。",
    target: "#task-input",
  },
  {
    id: "sidebar",
    title: "对话按项目分组",
    body: "左侧是历史。点项目名可以收起一组；标题会尽量收成短句，而不是整段任务。",
    target: "#run-list",
  },
  {
    id: "knobs",
    title: "需要时再开运行设置",
    body: "更多选项收在「运行设置」里。日常对话不用先配任何东西。",
    target: "#knobs-toggle",
  },
  {
    id: "files",
    title: "写完的文件会出现在旁边",
    body: "这次写下的文件会列在对话右侧。设置里写着：只能改这些文件夹。",
    target: "#main-area",
  },
];

export function isOnboardingDone(storage) {
  try {
    return storage?.getItem?.(ONBOARDING_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markOnboardingDone(storage) {
  try {
    storage?.setItem?.(ONBOARDING_STORAGE_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

export function nextOnboardingIndex(index, total = ONBOARDING_STEPS.length) {
  const i = Number.isFinite(index) ? index : 0;
  if (i < 0) return 0;
  if (i + 1 >= total) return total;
  return i + 1;
}

/**
 * @param {{
 *   onAnnounce?: (msg: string) => void,
 *   onDone?: () => void,
 *   storage?: Storage,
 *   ownerDocument?: Document,
 * }} [host]
 */
export function initOnboarding(host = {}) {
  const doc = host.ownerDocument ?? document;
  const storage = host.storage ?? (typeof localStorage === "undefined" ? null : localStorage);
  const existing = doc.getElementById("onboarding-overlay");
  if (existing?.__onboardingApi) return existing.__onboardingApi;

  const overlay = doc.createElement("div");
  overlay.id = "onboarding-overlay";
  overlay.className = "onboarding-overlay";
  overlay.hidden = true;
  overlay.innerHTML =
    '<div class="onboarding-card" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">' +
    '<p class="onboarding-kicker">初次使用</p>' +
    '<h2 id="onboarding-title"></h2>' +
    '<p class="onboarding-body" id="onboarding-body"></p>' +
    '<p class="onboarding-step" id="onboarding-step"></p>' +
    '<div class="onboarding-actions">' +
    '<button type="button" class="btn btn--ghost" id="onboarding-skip">跳过</button>' +
    '<button type="button" class="btn btn--primary" id="onboarding-next">下一步</button>' +
    "</div></div>";
  (doc.body ?? doc.documentElement).appendChild(overlay);

  let index = 0;
  let open = false;
  let restoreFocus = null;

  function paint() {
    const step = ONBOARDING_STEPS[index];
    const title = overlay.querySelector("#onboarding-title");
    const body = overlay.querySelector("#onboarding-body");
    const meta = overlay.querySelector("#onboarding-step");
    const nextBtn = overlay.querySelector("#onboarding-next");
    if (!step || !title || !body || !meta || !nextBtn) return;
    title.textContent = step.title;
    body.textContent = step.body;
    meta.textContent = `${index + 1} / ${ONBOARDING_STEPS.length}`;
    nextBtn.textContent = index + 1 >= ONBOARDING_STEPS.length ? "开始使用" : "下一步";
    doc.querySelectorAll("[data-onboarding-target]").forEach((el) => el.removeAttribute("data-onboarding-target"));
    if (step.target) {
      const target = doc.querySelector(step.target);
      if (target) target.setAttribute("data-onboarding-target", "1");
    }
  }

  function close(reason) {
    if (!open) return;
    open = false;
    overlay.hidden = true;
    markOnboardingDone(storage);
    doc.querySelectorAll("[data-onboarding-target]").forEach((el) => el.removeAttribute("data-onboarding-target"));
    const btn = restoreFocus;
    restoreFocus = null;
    try { btn?.focus?.({ preventScroll: true }); } catch { /* jsdom */ }
    host.onAnnounce?.(reason === "skip" ? "已跳过引导" : "引导完成");
    host.onDone?.();
  }

  function show(startIndex = 0) {
    index = Math.max(0, Math.min(ONBOARDING_STEPS.length - 1, startIndex));
    open = true;
    restoreFocus = /** @type {HTMLElement|null} */ (doc.activeElement);
    overlay.hidden = false;
    paint();
    overlay.querySelector("#onboarding-next")?.focus({ preventScroll: true });
  }

  overlay.querySelector("#onboarding-skip")?.addEventListener("click", () => close("skip"));
  overlay.querySelector("#onboarding-next")?.addEventListener("click", () => {
    const next = nextOnboardingIndex(index);
    if (next >= ONBOARDING_STEPS.length) {
      close("done");
      return;
    }
    index = next;
    paint();
  });
  overlay.addEventListener("keydown", (e) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close("skip");
    }
  });

  const api = {
    element: overlay,
    isOpen: () => open,
    start({ force = false } = {}) {
      if (!force && isOnboardingDone(storage)) return false;
      show(0);
      return true;
    },
    replay() {
      show(0);
      return true;
    },
    close,
  };
  overlay.__onboardingApi = api;
  return api;
}

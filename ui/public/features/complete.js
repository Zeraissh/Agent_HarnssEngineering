/**
 * features/complete — 实验性输入补全。
 *
 * 默认关。打开后按欢迎页示例 + 最近对话标题做前缀续写，Tab 接受、Esc 丢掉。
 * 服务端 /api/complete 同一套启发式；本模块也可纯本地算（测试不打网）。
 */

export const COMPLETE_API_URL = "/api/complete";
export const COMPLETE_MIN_PREFIX = 2;

/** 与 ui/complete.ts 的 COMPLETE_CANDIDATES 保持同一顺序。 */
export const COMPLETE_EXAMPLES = [
  { label: "问一个问题", text: "用三句话解释什么是 PID 控制器。不要调用工具。" },
  { label: "读一读这个项目", text: "看看当前工作目录里有哪些源文件，用一段话总结这个项目在做什么。" },
  { label: "三句话看项目", text: "帮我看看这个项目现在的状态，用三句话总结。" },
  { label: "写个文件（会问你要不要放行）", text: "在工作目录下创建 hello.md，写一段这个项目的简介。" },
  { label: "带独立核查的交付", text: "写一个 TypeScript 函数 clamp(n, min, max) 并配 vitest 测试，跑通后告诉我结果。" },
];

export function normalizeCompletePrefix(prefix) {
  return String(prefix ?? "").replace(/\s+/g, " ").trim();
}

export function heuristicComplete(prefix, extra = []) {
  const p = normalizeCompletePrefix(prefix);
  if (p.length < COMPLETE_MIN_PREFIX || p.length > 200) return null;
  const lower = p.toLowerCase();
  let best = null;
  const pool = [...COMPLETE_EXAMPLES.map((e) => e.text), ...extra];
  for (const raw of pool) {
    const t = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (t.length <= p.length) continue;
    if (!t.toLowerCase().startsWith(lower)) continue;
    const rest = t.slice(p.length);
    if (!rest) continue;
    if (best == null || rest.length < best.length) best = rest;
  }
  return best;
}

/** 光标必须在末尾才接受——半截插入会把人正在改的句子撕开。 */
export function shouldAcceptCompletion(value, cursor, suggestion) {
  if (!suggestion) return false;
  const v = String(value ?? "");
  const n = typeof cursor === "number" ? cursor : v.length;
  return n === v.length;
}

export function applyCompletion(value, suggestion) {
  return `${String(value ?? "")}${String(suggestion ?? "")}`;
}

/**
 * @param {{
 *   input: HTMLTextAreaElement,
 *   suggestEl?: HTMLElement|null,
 *   getRecent?: () => string[],
 *   fetchComplete?: (body: {prefix:string, recent:string[]}) => Promise<{completion?:string|null}>,
 *   debounceMs?: number,
 *   announce?: (msg: string) => void,
 * }} opts
 */
export function initComposerComplete(opts) {
  const input = opts.input;
  const suggestEl = opts.suggestEl ?? null;
  const debounceMs = opts.debounceMs ?? 220;
  let enabled = false;
  let suggestion = "";
  let timer = 0;
  let seq = 0;

  function render() {
    if (!suggestEl) return;
    if (!enabled || !suggestion) {
      suggestEl.hidden = true;
      suggestEl.textContent = "";
      return;
    }
    suggestEl.hidden = false;
    suggestEl.textContent = `Tab 接受：${suggestion}`;
  }

  function clear() {
    suggestion = "";
    render();
  }

  async function refresh() {
    if (!enabled) {
      clear();
      return;
    }
    const prefix = input.value;
    const local = heuristicComplete(prefix, opts.getRecent?.() ?? []);
    if (local) {
      suggestion = local;
      render();
      return;
    }
    if (typeof opts.fetchComplete !== "function") {
      clear();
      return;
    }
    const my = ++seq;
    try {
      const body = await opts.fetchComplete({
        prefix,
        recent: opts.getRecent?.() ?? [],
      });
      if (my !== seq) return;
      const next = typeof body?.completion === "string" ? body.completion : "";
      suggestion = next;
      render();
    } catch {
      if (my === seq) clear();
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      void refresh();
    }, debounceMs);
  }

  function accept() {
    if (!shouldAcceptCompletion(input.value, input.selectionStart, suggestion)) return false;
    input.value = applyCompletion(input.value, suggestion);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    clear();
    opts.announce?.("已接受补全");
    return true;
  }

  input.addEventListener("input", () => {
    if (!enabled) return;
    schedule();
  });
  input.addEventListener("keydown", (e) => {
    if (!enabled) return;
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Tab" && suggestion && shouldAcceptCompletion(input.value, input.selectionStart, suggestion)) {
      e.preventDefault();
      accept();
      return;
    }
    if (e.key === "Escape" && suggestion) {
      e.preventDefault();
      clear();
    }
  });

  return {
    setEnabled(next) {
      enabled = Boolean(next);
      if (!enabled) clear();
      else schedule();
    },
    isEnabled: () => enabled,
    suggestion: () => suggestion,
    accept,
    clear,
    refresh,
  };
}

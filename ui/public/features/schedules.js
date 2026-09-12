/**
 * features/schedules — 定时任务（T9）。
 *
 * 零依赖原生 ESM。独立视图（hash 路由 #/schedules），与 settings.js 同一约定：
 *   1) 纯函数层（调度规则人话 / 倒计时 / 上次触发文案 / 表单载荷构造与校验 /
 *      路由判定）——可单测；
 *   2) DOM 层 initSchedulesView(host, env)——宿主（index.html 内联控制器）
 *      注入回调，本模块不反向 import 宿主任何东西。
 *
 * 数据同源纪律：任务列表只认 GET /api/schedules（响应带 serverTime，倒计时
 * 以服务端时钟为锚，不赌客户端时钟）；变更（建/改/删/手动触发）后整表重拉，
 * 不在前端维护第二份状态。
 */

import { upgradeSelects } from "./theme-select.js";

// ---------------------------------------------------------------
// 常量
// ---------------------------------------------------------------

/** 路由：定时任务视图占用的唯一 hash */
export const SCHEDULES_HASH = "#/schedules";

/** 与服务端 scheduler.ts 的 MIN_INTERVAL_MS 对齐：间隔下限 1 分钟 */
export const MIN_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------

/**
 * 路由判定：与 settings.js 的 isSettingsRoute 同一条约定，宿主路由与本模块
 * 共用一条，不各写一份正则。
 * @param {string} hash location.hash
 * @returns {boolean}
 */
export function isSchedulesRoute(hash) {
  return String(hash ?? "") === SCHEDULES_HASH;
}

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * 调度规则的人话文案。
 *   once     → "一次性 · 9月6日 08:00"（跨年补年份）
 *   daily    → "每天 09:30"
 *   interval → "每 2 小时" / "每 30 分钟"
 * @param {{ kind:string, at?:number, hhmm?:string, everyMs?:number }} schedule
 * @param {number} [now] 用于判断 once 是否跨年；缺省取当前时刻
 * @returns {string}
 */
export function describeSchedule(schedule, now = Date.now()) {
  if (!schedule || typeof schedule !== "object") return "未知规则";
  if (schedule.kind === "once" && typeof schedule.at === "number") {
    const d = new Date(schedule.at);
    const sameYear = d.getFullYear() === new Date(now).getFullYear();
    const date = sameYear
      ? `${d.getMonth() + 1}月${d.getDate()}日`
      : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    return `一次性 · ${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  if (schedule.kind === "daily" && typeof schedule.hhmm === "string") {
    return `每天 ${schedule.hhmm}`;
  }
  if (schedule.kind === "interval" && typeof schedule.everyMs === "number") {
    const ms = schedule.everyMs;
    if (ms % 3_600_000 === 0) return `每 ${ms / 3_600_000} 小时`;
    if (ms % 60_000 === 0) return `每 ${ms / 60_000} 分钟`;
    return `每 ${Math.round(ms / 1000)} 秒`;
  }
  return "未知规则";
}

/**
 * 下次运行倒计时文案。
 * @param {number|null|undefined} nextRunAt epochMs；null → "—"（已禁用/已终结）
 * @param {number} now 服务端 serverTime
 * @returns {string}
 */
export function countdownText(nextRunAt, now) {
  if (typeof nextRunAt !== "number" || !Number.isFinite(nextRunAt)) return "—";
  const delta = nextRunAt - now;
  if (delta <= 0) return "即将运行";
  const minutes = Math.ceil(delta / 60_000);
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 24) return remMin ? `${hours} 小时 ${remMin} 分钟后` : `${hours} 小时后`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days} 天 ${remHours} 小时后` : `${days} 天后`;
}

/**
 * 上次触发结果的文案与色调。
 * @param {{ lastTrigger?:{ outcome:string, note?:string|null }|null, enabled?:boolean }} entry
 * @returns {{ text:string, tone:"ok"|"warn"|"bad"|"muted" }}
 */
export function lastTriggerLabel(entry) {
  const t = entry?.lastTrigger;
  if (!t) return { text: entry?.enabled === false ? "未运行过" : "等待首次运行", tone: "muted" };
  switch (t.outcome) {
    case "launched":
      return { text: "已启动", tone: "ok" };
    case "skipped":
      return { text: "已跳过（上次仍在运行）", tone: "warn" };
    case "missed":
      return { text: "已错过（超过 24 小时未补跑）", tone: "warn" };
    case "error":
      return { text: `启动失败${t.note ? `：${t.note}` : ""}`, tone: "bad" };
    default:
      return { text: "—", tone: "muted" };
  }
}

/**
 * 任务描述摘要：取首行，超长省略。
 * @param {string} task
 * @param {number} [max]
 * @returns {string}
 */
export function summarizeTask(task, max = 60) {
  const first = String(task ?? "").trim().split("\n")[0] ?? "";
  return first.length > max ? `${first.slice(0, max)}…` : first;
}

/**
 * 新建表单载荷构造 + 前端预校验（服务端仍会再校验一遍——双保险，不是替代）。
 *
 * @param {{
 *   name?:string, task?:string, workdir?:string, verify?:boolean,
 *   kind?:string, onceAtMs?:number|null, dailyHhmm?:string, intervalHours?:number|string,
 * }} input
 * @returns {{ ok:true, payload:Record<string,unknown> } | { ok:false, error:string }}
 */
export function buildCreatePayload(input) {
  const task = String(input?.task ?? "").trim();
  if (!task) return { ok: false, error: "任务描述不能为空" };
  if (!String(input?.workdir ?? "").trim()) return { ok: false, error: "请选择工作目录" };
  let schedule;
  if (input?.kind === "once") {
    const at = input.onceAtMs;
    if (typeof at !== "number" || !Number.isFinite(at)) return { ok: false, error: "请选择一次性的触发时间" };
    if (at <= Date.now()) return { ok: false, error: "触发时间已过——请选一个未来的时刻" };
    schedule = { kind: "once", at };
  } else if (input?.kind === "daily") {
    const hhmm = String(input.dailyHhmm ?? "");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) return { ok: false, error: "请选择每天的触发时刻（HH:MM）" };
    schedule = { kind: "daily", hhmm };
  } else if (input?.kind === "interval") {
    const hours = Number(input.intervalHours);
    if (!Number.isFinite(hours) || hours <= 0) return { ok: false, error: "请填写间隔小时数（大于 0）" };
    const everyMs = Math.round(hours * 3_600_000);
    if (everyMs < MIN_INTERVAL_MS) return { ok: false, error: "间隔不能小于 1 分钟" };
    schedule = { kind: "interval", everyMs };
  } else {
    return { ok: false, error: "请选择调度类型" };
  }
  return {
    ok: true,
    payload: {
      name: String(input?.name ?? "").trim(),
      task,
      workdir: String(input.workdir).trim(),
      verify: input?.verify === true,
      schedule,
    },
  };
}

// ---------------------------------------------------------------
// DOM 层
// ---------------------------------------------------------------

const VIEW_ID = "schedules-view";

/**
 * 初始化定时任务视图。幂等：重复调用返回既有节点的薄壳。
 *
 * host 回调：
 *   getHarnessSnapshot()  → /api/harness 快照或 null（工作目录白名单数据源）
 *   onOpenSchedules()     → 侧栏入口点击（宿主写 hash 路由）
 *   onCloseSchedules()    → 返回上一视图
 *   onOpenRun(runId)      → 上次运行跳转到对应 run
 *   onAnnounce(msg)       → aria-live 播报（可选）
 *
 * env（测试注入）：doc / win / fetchFn / confirmFn / refreshMs
 *   refreshMs=0 关闭倒计时周期刷新（jsdom 测试用）
 *
 * @param {Record<string, Function>} host
 * @param {{ doc?:Document, win?:Window, fetchFn?:Function, confirmFn?:Function, refreshMs?:number }} [env]
 */
export function initSchedulesView(host = {}, env = {}) {
  const doc = env.doc ?? document;
  const win = env.win ?? (doc.defaultView ?? window);
  const fetchFn = env.fetchFn ?? ((...args) => fetch(...args));
  const confirmFn = env.confirmFn ?? ((msg) => win.confirm?.(msg) ?? false);
  const refreshMs = env.refreshMs ?? 30_000;

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

  // ---- 状态 ----
  let open = false;
  /** @type {Array<Record<string, any>>} */
  let entries = [];
  let serverTime = Date.now();
  let formVisible = false;
  /** @type {HTMLElement|null} */
  let restoreFocusTo = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let refreshTimer = null;

  // ---- 骨架 ----
  const view = doc.createElement("div");
  view.id = VIEW_ID;
  view.className = "schedules-view";
  view.hidden = true;

  const shell = doc.createElement("div");
  shell.className = "schedules-shell";

  const head = doc.createElement("header");
  head.className = "schedules-head";
  const backBtn = doc.createElement("button");
  backBtn.type = "button";
  backBtn.className = "btn btn--ghost schedules-back";
  backBtn.innerHTML = '<i class="ph ph-arrow-left" aria-hidden="true"></i><span>返回</span>';
  backBtn.setAttribute("aria-label", "返回上一视图");
  const title = doc.createElement("h2");
  title.className = "schedules-title";
  title.textContent = "定时任务";
  const newBtn = doc.createElement("button");
  newBtn.type = "button";
  newBtn.className = "btn schedules-new-btn";
  newBtn.id = "schedules-new-btn";
  newBtn.innerHTML = '<i class="ph ph-plus" aria-hidden="true"></i><span>新建任务</span>';
  head.appendChild(backBtn);
  head.appendChild(title);
  head.appendChild(newBtn);

  const body = doc.createElement("div");
  body.className = "schedules-body";

  const listEl = doc.createElement("div");
  listEl.className = "schedules-list";

  const emptyEl = doc.createElement("div");
  emptyEl.className = "schedules-empty";
  emptyEl.hidden = true;
  emptyEl.innerHTML =
    '<div class="empty-icon" aria-hidden="true"><i class="ph ph-clock-countdown"></i></div>' +
    "<p>还没有定时任务——让 Agent 每天定时帮你干活</p>";

  body.appendChild(listEl);
  body.appendChild(emptyEl);

  // ---- 新建表单 ----
  const form = doc.createElement("form");
  form.className = "schedules-form";
  form.id = "schedules-form";
  form.hidden = true;
  form.noValidate = true;

  const formTitle = doc.createElement("h3");
  formTitle.className = "schedules-form-title";
  formTitle.textContent = "新建定时任务";
  form.appendChild(formTitle);

  /** 字段行：label + 控件 */
  function fieldRow(labelText, control, idFor) {
    const row = doc.createElement("div");
    row.className = "schedules-field";
    const label = doc.createElement("label");
    label.textContent = labelText;
    if (idFor) label.setAttribute("for", idFor);
    row.appendChild(label);
    row.appendChild(control);
    form.appendChild(row);
    return row;
  }

  const nameInput = doc.createElement("input");
  nameInput.type = "text";
  nameInput.id = "schedules-form-name";
  nameInput.placeholder = "可选——缺省取任务描述前 24 字";
  nameInput.maxLength = 60;
  fieldRow("名称", nameInput, nameInput.id);

  const taskInput = doc.createElement("textarea");
  taskInput.id = "schedules-form-task";
  taskInput.rows = 4;
  taskInput.placeholder = "例如：拉取今天的 AI 行业新闻，整理成 5 条摘要写入 daily-news.md";
  fieldRow("任务描述", taskInput, taskInput.id);

  // 工作目录：复用 composer 的白名单数据源（/api/harness 的 availableWorkdirs）
  const workdirSelect = doc.createElement("select");
  workdirSelect.id = "schedules-form-workdir";
  fieldRow("工作目录", workdirSelect, workdirSelect.id);

  // 调度类型三选一
  const kindField = doc.createElement("fieldset");
  kindField.className = "schedules-kind-grid";
  const kindLegend = doc.createElement("legend");
  kindLegend.className = "sr-only";
  kindLegend.textContent = "调度类型";
  kindField.appendChild(kindLegend);

  const KINDS = [
    { id: "once", label: "一次性", icon: "ph-calendar-dot" },
    { id: "daily", label: "每天", icon: "ph-calendar-check" },
    { id: "interval", label: "每隔几小时", icon: "ph-arrows-clockwise" },
  ];
  /** @type {HTMLInputElement[]} */
  const kindRadios = [];
  for (const k of KINDS) {
    const label = doc.createElement("label");
    label.className = "schedules-kind-option";
    const radio = doc.createElement("input");
    radio.type = "radio";
    radio.name = "schedules-kind";
    radio.value = k.id;
    kindRadios.push(radio);
    const icon = doc.createElement("i");
    icon.className = `ph ${k.icon}`;
    icon.setAttribute("aria-hidden", "true");
    const span = doc.createElement("span");
    span.textContent = k.label;
    label.appendChild(radio);
    label.appendChild(icon);
    label.appendChild(span);
    kindField.appendChild(label);
  }
  form.appendChild(kindField);

  // 三种类型的参数行（随 radio 切换显隐）
  const onceInput = doc.createElement("input");
  onceInput.type = "datetime-local";
  onceInput.id = "schedules-form-once";
  const onceRow = fieldRow("触发时间", onceInput, onceInput.id);
  onceRow.dataset.forKind = "once";

  const dailyInput = doc.createElement("input");
  dailyInput.type = "time";
  dailyInput.id = "schedules-form-daily";
  dailyInput.value = "09:30";
  const dailyRow = fieldRow("每天时刻", dailyInput, dailyInput.id);
  dailyRow.dataset.forKind = "daily";

  const intervalInput = doc.createElement("input");
  intervalInput.type = "number";
  intervalInput.id = "schedules-form-interval";
  intervalInput.min = "1";
  intervalInput.max = "720";
  intervalInput.step = "1";
  intervalInput.value = "2";
  const intervalRow = fieldRow("间隔小时数", intervalInput, intervalInput.id);
  intervalRow.dataset.forKind = "interval";

  // 独立核查开关
  const verifyRow = doc.createElement("div");
  verifyRow.className = "schedules-field";
  const verifyLabel = doc.createElement("label");
  verifyLabel.className = "settings-toggle";
  const verifyInput = doc.createElement("input");
  verifyInput.type = "checkbox";
  verifyInput.id = "schedules-form-verify";
  const verifySpan = doc.createElement("span");
  verifySpan.textContent = "独立核查";
  verifyLabel.appendChild(verifyInput);
  verifyLabel.appendChild(verifySpan);
  verifyRow.appendChild(verifyLabel);
  const verifyHint = doc.createElement("p");
  verifyHint.className = "settings-field-hint";
  verifyHint.textContent = "开启后，每次定时运行结束前由独立核查角色验一遍产物。";
  verifyRow.appendChild(verifyHint);
  form.appendChild(verifyRow);

  const formError = doc.createElement("p");
  formError.className = "schedules-form-error";
  formError.id = "schedules-form-error";
  formError.setAttribute("role", "alert");
  formError.hidden = true;
  form.appendChild(formError);

  const formActions = doc.createElement("div");
  formActions.className = "schedules-form-actions";
  const submitBtn = doc.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "btn";
  submitBtn.textContent = "创建";
  const cancelBtn = doc.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn btn--ghost";
  cancelBtn.textContent = "取消";
  formActions.appendChild(submitBtn);
  formActions.appendChild(cancelBtn);
  form.appendChild(formActions);

  body.appendChild(form);
  shell.appendChild(head);
  shell.appendChild(body);
  view.appendChild(shell);
  (doc.getElementById("main-panel") ?? doc.body).appendChild(view);

  // ---- 数据 ----
  async function api(path, opts = {}) {
    const res = await fetchFn(path, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
    });
    let data = null;
    try { data = await res.json(); } catch { /* 非 JSON 响应当 null 处理 */ }
    return { status: res.status, data };
  }

  async function reload() {
    const { status, data } = await api("/api/schedules");
    if (status !== 200 || !data || !Array.isArray(data.schedules)) return;
    entries = data.schedules;
    if (typeof data.serverTime === "number") serverTime = data.serverTime;
    renderList();
  }

  // ---- 渲染 ----
  function renderList() {
    listEl.innerHTML = "";
    emptyEl.hidden = entries.length > 0 || formVisible;
    // 最新创建的在前
    const sorted = [...entries].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    for (const entry of sorted) {
      listEl.appendChild(renderCard(entry));
    }
  }

  /** @param {Record<string, any>} entry */
  function renderCard(entry) {
    const card = doc.createElement("article");
    card.className = "schedule-card";
    card.dataset.scheduleId = entry.id;

    const main = doc.createElement("div");
    main.className = "schedule-card-main";

    const nameEl = doc.createElement("strong");
    nameEl.className = "schedule-card-name";
    nameEl.textContent = entry.name || summarizeTask(entry.task, 24);
    main.appendChild(nameEl);

    const taskEl = doc.createElement("p");
    taskEl.className = "schedule-card-task";
    taskEl.textContent = summarizeTask(entry.task);
    main.appendChild(taskEl);

    const meta = doc.createElement("div");
    meta.className = "schedule-card-meta";

    const rule = doc.createElement("span");
    rule.className = "schedule-card-rule";
    rule.innerHTML = '<i class="ph ph-clock" aria-hidden="true"></i><span></span>';
    rule.querySelector("span").textContent = describeSchedule(entry.schedule, serverTime);
    meta.appendChild(rule);

    const next = doc.createElement("span");
    next.className = "schedule-card-next";
    next.innerHTML = '<i class="ph ph-hourglass" aria-hidden="true"></i><span></span>';
    const nextText = entry.enabled
      ? `下次运行：${countdownText(entry.nextRunAt, serverTime)}`
      : "已停用";
    next.querySelector("span").textContent = nextText;
    meta.appendChild(next);

    const last = doc.createElement("span");
    const label = lastTriggerLabel(entry);
    last.className = `schedule-card-last schedule-card-last--${label.tone}`;
    if (entry.lastRunId && typeof host.onOpenRun === "function") {
      const link = doc.createElement("button");
      link.type = "button";
      link.className = "schedule-card-last-link";
      link.innerHTML = '<i class="ph ph-arrow-square-out" aria-hidden="true"></i><span></span>';
      link.querySelector("span").textContent = `上次运行：${label.text}`;
      link.addEventListener("click", () => host.onOpenRun(entry.lastRunId));
      last.appendChild(link);
    } else {
      last.textContent = `上次运行：${label.text}`;
    }
    meta.appendChild(last);

    main.appendChild(meta);
    card.appendChild(main);

    // 操作列：启用开关 / 立即运行 / 删除
    const actions = doc.createElement("div");
    actions.className = "schedule-card-actions";

    const toggleLabel = doc.createElement("label");
    toggleLabel.className = "settings-toggle schedule-card-toggle";
    const toggle = doc.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = entry.enabled === true;
    toggle.setAttribute("aria-label", `启用或停用「${nameEl.textContent}」`);
    toggle.addEventListener("change", async () => {
      const { status, data } = await api(`/api/schedules/${encodeURIComponent(entry.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: toggle.checked }),
      });
      if (status === 200) {
        host.onAnnounce?.(toggle.checked ? `已启用「${entry.name}」` : `已停用「${entry.name}」`);
      } else {
        host.onAnnounce?.(`更新失败：${data?.error ?? `HTTP ${status}`}`);
      }
      await reload();
    });
    const toggleSpan = doc.createElement("span");
    toggleSpan.textContent = "启用";
    toggleLabel.appendChild(toggle);
    toggleLabel.appendChild(toggleSpan);
    actions.appendChild(toggleLabel);

    const runBtn = doc.createElement("button");
    runBtn.type = "button";
    runBtn.className = "btn btn--ghost schedule-card-run";
    runBtn.innerHTML = '<i class="ph ph-play" aria-hidden="true"></i><span>立即运行</span>';
    runBtn.addEventListener("click", async () => {
      runBtn.disabled = true;
      try {
        const { status, data } = await api(`/api/schedules/${encodeURIComponent(entry.id)}/run`, {
          method: "POST",
        });
        if (status === 200) {
          host.onAnnounce?.(`已启动一次「${entry.name}」`);
          if (data?.runId && typeof host.onOpenRun === "function") host.onOpenRun(data.runId);
        } else {
          host.onAnnounce?.(`触发失败：${data?.error ?? `HTTP ${status}`}`);
        }
      } finally {
        runBtn.disabled = false;
        await reload();
      }
    });
    actions.appendChild(runBtn);

    const delBtn = doc.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn btn--ghost schedule-card-delete";
    delBtn.innerHTML = '<i class="ph ph-trash" aria-hidden="true"></i><span>删除</span>';
    delBtn.setAttribute("aria-label", `删除「${nameEl.textContent}」`);
    delBtn.addEventListener("click", async () => {
      if (!confirmFn(`确定删除定时任务「${entry.name}」？此操作不可撤销。`)) return;
      const { status, data } = await api(`/api/schedules/${encodeURIComponent(entry.id)}`, {
        method: "DELETE",
      });
      if (status === 200) {
        host.onAnnounce?.(`已删除「${entry.name}」`);
      } else {
        host.onAnnounce?.(`删除失败：${data?.error ?? `HTTP ${status}`}`);
      }
      await reload();
    });
    actions.appendChild(delBtn);

    card.appendChild(actions);
    return card;
  }

  // ---- 表单交互 ----
  function currentKind() {
    return kindRadios.find((r) => r.checked)?.value ?? "";
  }

  function syncKindRows() {
    const kind = currentKind();
    for (const row of [onceRow, dailyRow, intervalRow]) {
      row.hidden = row.dataset.forKind !== kind;
    }
  }

  function showForm() {
    formVisible = true;
    form.hidden = false;
    emptyEl.hidden = true;
    formError.hidden = true;
    // 工作目录下拉：与 composer 同源（/api/harness 的 availableWorkdirs）
    const snap = host.getHarnessSnapshot?.() ?? null;
    const dirs = Array.isArray(snap?.availableWorkdirs) && snap.availableWorkdirs.length
      ? snap.availableWorkdirs
      : (typeof snap?.workdir === "string" && snap.workdir ? [snap.workdir] : []);
    workdirSelect.innerHTML = "";
    for (const d of dirs) {
      const opt = doc.createElement("option");
      opt.value = d;
      opt.textContent = d;
      workdirSelect.appendChild(opt);
    }
    if (typeof snap?.workdir === "string") workdirSelect.value = snap.workdir;
    syncKindRows();
    nameInput.focus();
  }

  function hideForm() {
    formVisible = false;
    form.hidden = true;
    renderList();
  }

  for (const radio of kindRadios) {
    radio.addEventListener("change", syncKindRows);
  }
  newBtn.addEventListener("click", () => {
    if (formVisible) hideForm();
    else showForm();
  });
  cancelBtn.addEventListener("click", hideForm);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const built = buildCreatePayload({
      name: nameInput.value,
      task: taskInput.value,
      workdir: workdirSelect.value,
      verify: verifyInput.checked,
      kind: currentKind(),
      onceAtMs: onceInput.value ? new Date(onceInput.value).getTime() : null,
      dailyHhmm: dailyInput.value,
      intervalHours: intervalInput.value,
    });
    if (!built.ok) {
      formError.textContent = built.error;
      formError.hidden = false;
      return;
    }
    submitBtn.disabled = true;
    try {
      const { status, data } = await api("/api/schedules", {
        method: "POST",
        body: JSON.stringify(built.payload),
      });
      if (status === 201 || status === 200) {
        host.onAnnounce?.(`定时任务「${data?.schedule?.name ?? ""}」已创建`);
        taskInput.value = "";
        nameInput.value = "";
        hideForm();
        await reload();
      } else {
        formError.textContent = data?.error ?? `创建失败（HTTP ${status}）`;
        formError.hidden = false;
      }
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ---- 开关 ----
  function openView() {
    if (open) return;
    open = true;
    restoreFocusTo = /** @type {HTMLElement|null} */ (doc.activeElement);
    view.hidden = false;
    void reload();
    if (refreshMs > 0 && !refreshTimer) {
      // 倒计时以最近一次 serverTime 为锚就地重算，不整表重拉
      refreshTimer = win.setInterval(() => {
        serverTime += refreshMs;
        renderList();
      }, refreshMs);
    }
    backBtn.focus();
    host.onAnnounce?.("定时任务已打开");
  }

  function closeView() {
    if (!open) return;
    open = false;
    view.hidden = true;
    if (refreshTimer) {
      win.clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (restoreFocusTo && typeof restoreFocusTo.focus === "function" && doc.contains?.(restoreFocusTo) !== false) {
      restoreFocusTo.focus();
    }
    restoreFocusTo = null;
  }

  backBtn.addEventListener("click", () => host.onCloseSchedules?.());

  // 侧栏入口（宿主在骨架里放了 #schedules-open-btn 才有）
  const openBtn = doc.getElementById("schedules-open-btn");
  if (openBtn) {
    openBtn.addEventListener("click", () => host.onOpenSchedules?.());
  }
  upgradeSelects(view);

  return {
    open: openView,
    close: closeView,
    isOpen: () => open,
    element: view,
    refresh: reload,
  };
}

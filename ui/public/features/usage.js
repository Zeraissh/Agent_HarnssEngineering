/**
 * features/usage — 本机台账消耗视图。
 *
 * hash 路由 #/usage。数据来自 GET /api/usage（读 .agent-runs.jsonl）。
 * 台账不记 token 原文，图上按模型堆叠的是轮次；未登记单价不画成 $0.00。
 */

export const USAGE_HASH = "#/usage";
export const USAGE_API_URL = "/api/usage";
export const USAGE_PERIODS = [7, 30, 90];
export const USAGE_SERIES_LIMIT = 5;
export const USAGE_OTHER_MODEL = "其他";

export function isUsageRoute(hash) {
  return String(hash ?? "") === USAGE_HASH;
}

export function formatUsd(value) {
  if (value == null || !Number.isFinite(Number(value))) return "未计价";
  const n = Number(value);
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function displayModelName(model) {
  const raw = String(model ?? "").trim();
  if (!raw || raw === "(unknown)") return "未标注模型";
  return raw;
}

/**
 * @param {unknown} payload
 * @returns {{ totalRuns:number, totalTurns:number, totalUsd:number|null, unpricedRuns:number, byDay:any[], byModel:any[], byDayModel:any[] }}
 */
export function parseUsageReport(payload) {
  const empty = {
    totalRuns: 0,
    totalTurns: 0,
    totalUsd: null,
    unpricedRuns: 0,
    byDay: [],
    byModel: [],
    byDayModel: [],
  };
  if (!payload || typeof payload !== "object") return empty;
  const o = /** @type {any} */ (payload);
  return {
    totalRuns: Number(o.totalRuns) || 0,
    totalTurns: Number(o.totalTurns) || 0,
    totalUsd: typeof o.totalUsd === "number" ? o.totalUsd : null,
    unpricedRuns: Number(o.unpricedRuns) || 0,
    byDay: Array.isArray(o.byDay) ? o.byDay : [],
    byModel: Array.isArray(o.byModel) ? o.byModel : [],
    byDayModel: Array.isArray(o.byDayModel) ? o.byDayModel : [],
  };
}

export function formatLocalDay(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseLocalDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ""));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function periodStartDay(days, now = Date.now()) {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - (Math.max(1, Number(days) || 7) - 1));
  return formatLocalDay(start);
}

export function enumerateDays(startDay, endDay) {
  const start = parseLocalDay(startDay);
  const end = parseLocalDay(endDay);
  if (!start || !end || start > end) return [];
  const out = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    out.push(formatLocalDay(cursor));
  }
  return out;
}

export function formatChartDay(day) {
  const d = parseLocalDay(day);
  if (!d) return String(day ?? "");
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function formatChartDayFull(day) {
  const d = parseLocalDay(day);
  if (!d) return String(day ?? "");
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function formatCompactCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 10000) {
    const wan = n / 10000;
    const text = Math.abs(wan - Math.round(wan)) < 1e-6 ? String(Math.round(wan)) : wan.toFixed(1).replace(/\.0$/, "");
    return `${text}万`;
  }
  if (abs >= 1000) {
    const k = n / 1000;
    const text = Math.abs(k - Math.round(k)) < 1e-6 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, "");
    return `${text}k`;
  }
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1).replace(/\.0$/, "");
}

export function niceAxisMax(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  const exp = Math.floor(Math.log10(n));
  const pow = 10 ** exp;
  const frac = n / pow;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nice * pow;
}

export function dayLabelStep(days) {
  const n = Number(days) || 7;
  if (n <= 7) return 1;
  if (n <= 30) return 4;
  return 10;
}

function addUsd(current, next) {
  if (next == null || !Number.isFinite(Number(next))) return current;
  return (current ?? 0) + Number(next);
}

function emptyBucket() {
  return { runs: 0, turns: 0, usd: null, unpricedRuns: 0 };
}

function addToBucket(bucket, row) {
  bucket.runs += Number(row.runs) || 0;
  bucket.turns += Number(row.turns) || 0;
  bucket.usd = addUsd(bucket.usd, typeof row.usd === "number" ? row.usd : null);
  bucket.unpricedRuns += Number(row.unpricedRuns) || 0;
  return bucket;
}

/**
 * 老宿主没有 byDayModel 时，用 byDay 合成一条「全部」系列，柱仍能画，只是不能按模型拆。
 * @param {{ byDay?: any[], byDayModel?: any[] }} report
 */
export function dayModelRowsOf(report) {
  const rows = Array.isArray(report?.byDayModel) ? report.byDayModel : [];
  if (rows.length) return rows;
  return (Array.isArray(report?.byDay) ? report.byDay : []).map((d) => ({
    day: d.day,
    model: "全部",
    runs: d.runs,
    turns: d.turns,
    usd: d.usd,
    unpricedRuns: d.unpricedRuns,
  }));
}

/**
 * 窗口内模型超过上限时收成「其他」，避免图例把卡片挤爆。
 * @param {{ model:string, runs:number, turns:number, usd:number|null, unpricedRuns:number }[]} models
 * @param {number} [limit]
 */
export function collapseSeries(models, limit = USAGE_SERIES_LIMIT) {
  const sorted = [...models].sort((a, b) => b.turns - a.turns || b.runs - a.runs);
  const alias = new Map();
  if (sorted.length <= limit) {
    for (const row of sorted) alias.set(row.model, row.model);
    return { series: sorted, alias };
  }
  const kept = sorted.slice(0, limit);
  const rest = sorted.slice(limit);
  const other = emptyBucket();
  other.model = USAGE_OTHER_MODEL;
  for (const row of kept) alias.set(row.model, row.model);
  for (const row of rest) {
    alias.set(row.model, USAGE_OTHER_MODEL);
    addToBucket(other, row);
  }
  return { series: [...kept, other], alias };
}

/**
 * @param {ReturnType<typeof parseUsageReport>} report
 * @param {number} days
 * @param {number} [now]
 */
export function sliceUsageWindow(report, days, now = Date.now()) {
  const period = USAGE_PERIODS.includes(Number(days)) ? Number(days) : 7;
  const endDay = formatLocalDay(new Date(now));
  const startDay = periodStartDay(period, now);
  const dayKeys = enumerateDays(startDay, endDay);
  const inWindow = new Set(dayKeys);
  const raw = dayModelRowsOf(report).filter((row) => inWindow.has(String(row.day)));

  const modelMap = new Map();
  for (const row of raw) {
    const key = String(row.model ?? "").trim() || "(unknown)";
    const bucket = modelMap.get(key) ?? { model: key, ...emptyBucket() };
    addToBucket(bucket, row);
    modelMap.set(key, bucket);
  }
  const collapsed = collapseSeries([...modelMap.values()]);
  const columns = dayKeys.map((day) => {
    const parts = collapsed.series.map((s) => ({ model: s.model, ...emptyBucket() }));
    const partMap = new Map(parts.map((p) => [p.model, p]));
    const col = { day, ...emptyBucket(), parts };
    for (const row of raw) {
      if (String(row.day) !== day) continue;
      const targetName = collapsed.alias.get(String(row.model ?? "").trim() || "(unknown)") ?? USAGE_OTHER_MODEL;
      const part = partMap.get(targetName);
      if (part) addToBucket(part, row);
      addToBucket(col, row);
    }
    return col;
  });
  const totals = columns.reduce((acc, col) => addToBucket(acc, col), { ...emptyBucket() });
  return {
    days: period,
    startDay,
    endDay,
    dayKeys,
    series: collapsed.series,
    columns,
    totals,
    empty: totals.runs === 0 && totals.turns === 0,
  };
}

/**
 * 台账图本体：可挂独立 overlay（#/usage），也可嵌进设置「消耗」分组。
 * id 带 prefix，两处同时挂载不会撞 id。
 * @param {HTMLElement} container
 * @param {{ fetchUsage?: () => Promise<unknown>, now?: () => number, idPrefix?: string }} [env]
 */
export function attachUsagePanel(container, env = {}) {
  const prefix = String(env.idPrefix ?? "usage");
  const root = (container.ownerDocument ?? document).createElement("div");
  root.className = "usage-embed";
  root.innerHTML =
    '<div class="usage-toolbar">' +
    '<p class="usage-lead">本机台账里的运行轮次与已计价成本。台账不记 token 原文，图上按模型堆叠的是轮次。</p>' +
    '<div class="usage-period" role="group" aria-label="统计区间">' +
    USAGE_PERIODS.map((d, i) =>
      `<button type="button" data-days="${d}" aria-pressed="${i === 0 ? "true" : "false"}">${d}d</button>`,
    ).join("") +
    "</div></div>" +
    `<div class="usage-cards" id="${prefix}-cards"></div>` +
    `<section class="usage-chart-card" aria-labelledby="${prefix}-chart-title">` +
    '<header class="usage-chart-head">' +
    `<div><h3 id="${prefix}-chart-title">每日轮次</h3>` +
    `<p class="usage-chart-sub" id="${prefix}-chart-sub">按模型堆叠，近 7 天</p></div>` +
    '<div class="usage-view-toggle" role="group" aria-label="图或表">' +
    '<button type="button" class="usage-view-btn" data-view="chart" aria-pressed="true" aria-label="图表">' +
    '<i class="ph ph-chart-bar" aria-hidden="true"></i></button>' +
    '<button type="button" class="usage-view-btn" data-view="table" aria-pressed="false" aria-label="表格">' +
    '<i class="ph ph-table" aria-hidden="true"></i></button>' +
    "</div></header>" +
    `<div class="usage-legend" id="${prefix}-legend"></div>` +
    `<div class="usage-plot" id="${prefix}-plot"></div>` +
    `<div class="usage-table-wrap" id="${prefix}-table-wrap" hidden></div>` +
    '<p class="usage-footnote">未登记单价的运行仍计入轮次，成本写「未计价」，不会把没报价画成零元。</p>' +
    "</section>";
  container.appendChild(root);

  /** @type {ReturnType<typeof parseUsageReport>} */
  let report = parseUsageReport(null);
  let periodDays = 7;
  let viewMode = "chart";

  root.querySelector(".usage-period")?.addEventListener("click", (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest("[data-days]") : null;
    if (!btn) return;
    const next = Number(btn.getAttribute("data-days"));
    if (!USAGE_PERIODS.includes(next) || next === periodDays) return;
    periodDays = next;
    paint();
  });

  root.querySelector(".usage-view-toggle")?.addEventListener("click", (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest("[data-view]") : null;
    if (!btn) return;
    const next = btn.getAttribute("data-view") === "table" ? "table" : "chart";
    if (next === viewMode) return;
    viewMode = next;
    paint();
  });

  function nowMs() {
    return typeof env.now === "function" ? Number(env.now()) : Date.now();
  }

  function paint() {
    const win = sliceUsageWindow(report, periodDays, nowMs());
    for (const btn of root.querySelectorAll(".usage-period [data-days]")) {
      btn.setAttribute("aria-pressed", String(Number(btn.getAttribute("data-days")) === periodDays));
    }
    for (const btn of root.querySelectorAll(".usage-view-btn")) {
      btn.setAttribute("aria-pressed", String(btn.getAttribute("data-view") === viewMode));
    }
    const sub = root.querySelector(`#${prefix}-chart-sub`);
    if (sub) sub.textContent = `按模型堆叠，近 ${periodDays} 天`;
    renderCards(root.querySelector(`#${prefix}-cards`), win);
    renderLegend(root.querySelector(`#${prefix}-legend`), win);
    renderPlot(root.querySelector(`#${prefix}-plot`), win);
    renderTable(root.querySelector(`#${prefix}-table-wrap`), win);
    const plot = root.querySelector(`#${prefix}-plot`);
    const table = root.querySelector(`#${prefix}-table-wrap`);
    if (plot) plot.hidden = viewMode !== "chart";
    if (table) table.hidden = viewMode !== "table";
  }

  async function refresh() {
    try {
      report = parseUsageReport(await env.fetchUsage?.());
    } catch {
      report = parseUsageReport(null);
    }
    paint();
  }

  return { refresh, paint, el: root };
}

export function initUsageView(host, env) {
  const doc = host.ownerDocument ?? document;
  const overlay = doc.createElement("div");
  overlay.id = "usage-view";
  overlay.className = "settings-view usage-view";
  overlay.hidden = true;
  overlay.innerHTML =
    '<div class="settings-shell usage-shell">' +
    '<header class="settings-head usage-head">' +
    '<button type="button" class="btn btn--ghost settings-back" id="usage-back" aria-label="返回上一视图">' +
    '<i class="ph ph-arrow-left" aria-hidden="true"></i><span>返回</span></button>' +
    '<h2 class="settings-title">消耗</h2>' +
    "</header></div>";
  host.appendChild(overlay);

  overlay.querySelector("#usage-back")?.addEventListener("click", () => env.onClose?.());
  const panel = attachUsagePanel(overlay.querySelector(".usage-shell"), {
    fetchUsage: env.fetchUsage,
    now: env.now,
    idPrefix: "usage",
  });

  return {
    open() {
      overlay.hidden = false;
      void panel.refresh();
    },
    close() {
      overlay.hidden = true;
    },
    refresh: panel.refresh,
    paint: panel.paint,
    el: overlay,
  };
}

function renderCards(el, win) {
  if (!el) return;
  if (!win.series.length) {
    el.innerHTML =
      '<div class="usage-card usage-card--empty"><strong>这段时间没有运行</strong>' +
      "<span>换一个区间，或先跑一次任务再回来看。</span></div>";
    return;
  }
  el.innerHTML = win.series
    .map((row, i) => {
      const secondary = [`${row.runs} 次运行`, formatUsd(row.usd)];
      if (row.unpricedRuns) secondary.push(`${row.unpricedRuns} 未计价`);
      return (
        `<article class="usage-card" data-series="${i}">` +
        `<header class="usage-card-kicker"><i class="usage-swatch" data-series="${i}" aria-hidden="true"></i>` +
        `<span>${escapeHtml(displayModelName(row.model))}</span></header>` +
        `<strong>${escapeHtml(formatCompactCount(row.turns))} 轮</strong>` +
        `<span>${escapeHtml(secondary.join(" · "))}</span></article>`
      );
    })
    .join("");
}

function renderLegend(el, win) {
  if (!el) return;
  if (!win.series.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = win.series
    .map(
      (row, i) =>
        `<span class="usage-legend-item"><i class="usage-swatch" data-series="${i}" aria-hidden="true"></i>` +
        `${escapeHtml(displayModelName(row.model))}</span>`,
    )
    .join("");
}

function renderPlot(el, win) {
  if (!el) return;
  const axisMax = niceAxisMax(Math.max(0, ...win.columns.map((c) => c.turns)));
  const step = dayLabelStep(win.days);
  const ticks = [axisMax, axisMax / 2, 0];
  const yHtml = ticks
    .map((t) => `<span>${escapeHtml(formatCompactCount(t))}</span>`)
    .join("");
  const colsHtml = win.columns
    .map((col, index) => {
      const heightPct = axisMax > 0 ? Math.min(100, (col.turns / axisMax) * 100) : 0;
      const segs = col.parts
        .map((part, i) => {
          if (!part.turns) return "";
          const grow = part.turns;
          return `<span class="usage-seg" data-series="${i}" style="flex-grow:${grow}"></span>`;
        })
        .join("");
      const showLabel = index === 0 || index === win.columns.length - 1 || index % step === 0;
      const aria = `${formatChartDayFull(col.day)}，${col.turns} 轮，${col.runs} 次运行`;
      return (
        `<button type="button" class="usage-col" data-day="${escapeHtml(col.day)}" aria-label="${escapeHtml(aria)}">` +
        `<span class="usage-col-track"><span class="usage-col-stack" style="height:${heightPct}%">${segs}</span></span>` +
        `<span class="usage-col-label${showLabel ? "" : " is-muted"}">${showLabel ? escapeHtml(formatChartDay(col.day)) : ""}</span>` +
        `<span class="usage-tip" hidden><strong>${escapeHtml(formatChartDayFull(col.day))}</strong>` +
        (col.turns
          ? col.parts
              .filter((p) => p.turns || p.runs)
              .map((p, i) => {
                const series = win.series.findIndex((s) => s.model === p.model);
                return (
                  `<span class="usage-tip-row"><i class="usage-swatch" data-series="${series < 0 ? i : series}" aria-hidden="true"></i>` +
                  `${escapeHtml(displayModelName(p.model))} <b>${escapeHtml(formatCompactCount(p.turns))}</b></span>`
                );
              })
              .join("")
          : '<span class="usage-tip-row">没有运行</span>') +
        `</span></button>`
      );
    })
    .join("");
  el.innerHTML =
    `<div class="usage-y" aria-hidden="true">${yHtml}</div>` +
    `<div class="usage-plot-main"><div class="usage-grid" aria-hidden="true"><i></i><i></i><i></i></div>` +
    `<div class="usage-cols">${colsHtml}</div></div>`;

  for (const col of el.querySelectorAll(".usage-col")) {
    const tip = col.querySelector(".usage-tip");
    const show = () => {
      hideTips(el);
      if (tip) tip.hidden = false;
      col.classList.add("is-active");
    };
    const hide = () => {
      if (tip) tip.hidden = true;
      col.classList.remove("is-active");
    };
    col.addEventListener("mouseenter", show);
    col.addEventListener("focus", show);
    col.addEventListener("mouseleave", hide);
    col.addEventListener("blur", hide);
  }
}

function hideTips(root) {
  for (const tip of root.querySelectorAll(".usage-tip")) tip.hidden = true;
  for (const col of root.querySelectorAll(".usage-col.is-active")) col.classList.remove("is-active");
}

function renderTable(el, win) {
  if (!el) return;
  if (!win.columns.some((c) => c.runs || c.turns)) {
    el.innerHTML = '<p class="settings-field-hint">这段时间没有台账行。</p>';
    return;
  }
  const headModels = win.series
    .map((s) => `<th>${escapeHtml(displayModelName(s.model))}</th>`)
    .join("");
  const rows = [...win.columns].reverse().map((col) => {
    const modelCells = col.parts.map((p) => `<td>${p.turns || ""}</td>`).join("");
    return (
      `<tr><td>${escapeHtml(col.day)}</td>${modelCells}` +
      `<td>${col.turns}</td><td>${col.runs}</td>` +
      `<td>${formatUsd(col.usd)}${col.unpricedRuns ? ` · ${col.unpricedRuns} 未计价` : ""}</td></tr>`
    );
  }).join("");
  el.innerHTML =
    '<div class="table-scroll"><table class="usage-table"><thead><tr><th>日期</th>' +
    headModels +
    "<th>合计轮次</th><th>运行</th><th>成本</th></tr></thead><tbody>" +
    rows +
    "</tbody></table></div>";
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * features/usage — 模型消耗视图。
 *
 * hash 路由 #/usage。数据来自 GET /api/usage（读 .agent-runs.jsonl）。
 * 未登记单价的运行单独计数，不把「没报价」画成 0 元。
 */

export const USAGE_HASH = "#/usage";
export const USAGE_API_URL = "/api/usage";

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

/**
 * @param {unknown} payload
 * @returns {{ totalRuns:number, totalTurns:number, totalUsd:number|null, unpricedRuns:number, byDay:any[], byModel:any[] }}
 */
export function parseUsageReport(payload) {
  const empty = { totalRuns: 0, totalTurns: 0, totalUsd: null, unpricedRuns: 0, byDay: [], byModel: [] };
  if (!payload || typeof payload !== "object") return empty;
  const o = /** @type {any} */ (payload);
  return {
    totalRuns: Number(o.totalRuns) || 0,
    totalTurns: Number(o.totalTurns) || 0,
    totalUsd: typeof o.totalUsd === "number" ? o.totalUsd : null,
    unpricedRuns: Number(o.unpricedRuns) || 0,
    byDay: Array.isArray(o.byDay) ? o.byDay : [],
    byModel: Array.isArray(o.byModel) ? o.byModel : [],
  };
}

export function initUsageView(host, env) {
  const doc = host.ownerDocument ?? document;
  const overlay = doc.createElement("div");
  overlay.id = "usage-view";
  overlay.className = "settings-view usage-view";
  overlay.hidden = true;
  overlay.innerHTML =
    '<header class="settings-view-head">' +
    '<button type="button" class="settings-back" id="usage-back"><i class="ph ph-arrow-left" aria-hidden="true"></i>返回</button>' +
    "<div><h2>消耗</h2><p class=\"settings-view-lead\">按日、按模型汇总台账里的运行次数、轮次与成本。</p></div>" +
    "</header>" +
    '<div class="usage-summary" id="usage-summary"></div>' +
    '<section class="usage-section"><h3>按模型</h3><div id="usage-by-model"></div></section>' +
    '<section class="usage-section"><h3>按日</h3><div id="usage-by-day"></div></section>';
  host.appendChild(overlay);

  overlay.querySelector("#usage-back")?.addEventListener("click", () => env.onClose?.());

  function renderTable(el, rows, nameKey) {
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = '<p class="settings-field-hint">还没有台账行。</p>';
      return;
    }
    el.innerHTML =
      "<table class=\"usage-table\"><thead><tr><th></th><th>运行</th><th>轮次</th><th>成本</th></tr></thead><tbody>" +
      rows
        .map((r) =>
          `<tr><td>${escapeHtml(String(r[nameKey] ?? ""))}</td><td>${Number(r.runs) || 0}</td>` +
          `<td>${Number(r.turns) || 0}</td><td>${formatUsd(r.usd)}${r.unpricedRuns ? ` · ${r.unpricedRuns} 未计价` : ""}</td></tr>`,
        )
        .join("") +
      "</tbody></table>";
  }

  async function refresh() {
    let report = parseUsageReport(null);
    try {
      const res = await env.fetchUsage();
      report = parseUsageReport(res);
    } catch {
      report = parseUsageReport(null);
    }
    const summary = overlay.querySelector("#usage-summary");
    if (summary) {
      summary.innerHTML =
        `<div class="usage-stat"><strong>${report.totalRuns}</strong><span>运行</span></div>` +
        `<div class="usage-stat"><strong>${report.totalTurns}</strong><span>轮次</span></div>` +
        `<div class="usage-stat"><strong>${formatUsd(report.totalUsd)}</strong><span>已计价成本</span></div>` +
        `<div class="usage-stat"><strong>${report.unpricedRuns}</strong><span>未登记单价</span></div>`;
    }
    renderTable(overlay.querySelector("#usage-by-model"), report.byModel, "model");
    renderTable(overlay.querySelector("#usage-by-day"), report.byDay, "day");
  }

  return {
    open() {
      overlay.hidden = false;
      void refresh();
    },
    close() {
      overlay.hidden = true;
    },
    refresh,
    el: overlay,
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

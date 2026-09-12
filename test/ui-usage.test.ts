// @vitest-environment jsdom
// @ts-nocheck
/**
 * 消耗视图：区间切片、堆叠柱与主题化卡片。
 * 台账没有 token，图上按轮次堆叠；未计价不得画成 $0.00。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  parseUsageReport,
  formatUsd,
  formatChartDay,
  formatChartDayFull,
  formatCompactCount,
  niceAxisMax,
  periodStartDay,
  enumerateDays,
  collapseSeries,
  sliceUsageWindow,
  dayModelRowsOf,
  displayModelName,
  USAGE_OTHER_MODEL,
  initUsageView,
  attachUsagePanel,
} from "../ui/public/features/usage.js";

const NOW = Date.parse("2026-09-09T12:00:00");

const SAMPLE = {
  totalRuns: 4,
  totalTurns: 18,
  totalUsd: 0.12,
  unpricedRuns: 1,
  byDay: [
    { day: "2026-09-07", runs: 2, turns: 12, usd: 0.1, unpricedRuns: 0 },
    { day: "2026-09-02", runs: 1, turns: 3, usd: null, unpricedRuns: 1 },
    { day: "2026-08-01", runs: 1, turns: 3, usd: 0.02, unpricedRuns: 0 },
  ],
  byModel: [
    { model: "flash", runs: 3, turns: 10, usd: 0.04, unpricedRuns: 1 },
    { model: "pro", runs: 1, turns: 8, usd: 0.08, unpricedRuns: 0 },
  ],
  byDayModel: [
    { day: "2026-09-07", model: "flash", runs: 1, turns: 4, usd: 0.02, unpricedRuns: 0 },
    { day: "2026-09-07", model: "pro", runs: 1, turns: 8, usd: 0.08, unpricedRuns: 0 },
    { day: "2026-09-02", model: "flash", runs: 1, turns: 3, usd: null, unpricedRuns: 1 },
    { day: "2026-08-01", model: "flash", runs: 1, turns: 3, usd: 0.02, unpricedRuns: 0 },
  ],
};

describe("消耗读数", () => {
  it("formatUsd：null 写未计价，0 才是 $0.00", () => {
    expect(formatUsd(null)).toBe("未计价");
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("parseUsageReport 收下 byDayModel，缺字段不冒充 0 元", () => {
    const parsed = parseUsageReport({ totalRuns: 2, totalUsd: null, byDayModel: SAMPLE.byDayModel });
    expect(parsed.totalUsd).toBeNull();
    expect(parsed.byDayModel).toHaveLength(4);
    expect(parseUsageReport(null).byDayModel).toEqual([]);
  });

  it("日期轴与紧凑数字", () => {
    expect(formatChartDay("2026-09-07")).toBe("9月7日");
    expect(formatChartDayFull("2026-09-07")).toBe("2026年9月7日");
    expect(formatCompactCount(12)).toBe("12");
    expect(formatCompactCount(1400)).toBe("1.4k");
    expect(formatCompactCount(140000)).toBe("14万");
    expect(niceAxisMax(0)).toBe(1);
    expect(niceAxisMax(7)).toBe(10);
    expect(periodStartDay(7, NOW)).toBe("2026-09-03");
    expect(enumerateDays("2026-09-07", "2026-09-09")).toEqual([
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
    ]);
    expect(displayModelName("(unknown)")).toBe("未标注模型");
  });

  it("没有 byDayModel 时用 byDay 合成一条「全部」", () => {
    const rows = dayModelRowsOf({ byDay: SAMPLE.byDay, byDayModel: [] });
    expect(rows).toHaveLength(3);
    expect(rows[0]?.model).toBe("全部");
  });

  it("模型过多收成其他", () => {
    const models = [1, 2, 3, 4, 5, 6].map((n) => ({
      model: `m${n}`,
      runs: 1,
      turns: 10 - n,
      usd: 0,
      unpricedRuns: 0,
    }));
    const { series, alias } = collapseSeries(models, 5);
    expect(series.map((s) => s.model)).toEqual(["m1", "m2", "m3", "m4", "m5", USAGE_OTHER_MODEL]);
    expect(alias.get("m6")).toBe(USAGE_OTHER_MODEL);
    expect(series.at(-1)?.turns).toBe(4);
  });

  it("7 天窗口填满日期、丢掉更早的行、按模型重算卡片", () => {
    const win = sliceUsageWindow(SAMPLE, 7, NOW);
    expect(win.dayKeys[0]).toBe("2026-09-03");
    expect(win.dayKeys).toHaveLength(7);
    expect(win.series.map((s) => s.model)).toEqual(["pro", "flash"]);
    expect(win.series.find((s) => s.model === "pro")?.turns).toBe(8);
    expect(win.series.find((s) => s.model === "flash")?.turns).toBe(4);
    expect(win.totals.turns).toBe(12);
    expect(win.totals.usd).toBeCloseTo(0.1);
    expect(win.columns.find((c) => c.day === "2026-09-02")).toBeUndefined();
    const day7 = win.columns.find((c) => c.day === "2026-09-07");
    expect(day7?.parts.find((p) => p.model === "pro")?.turns).toBe(8);
    expect(win.columns.find((c) => c.day === "2026-09-08")?.turns).toBe(0);
  });

  it("30 天窗口收进 9月2 日的未计价行", () => {
    const win = sliceUsageWindow(SAMPLE, 30, NOW);
    expect(win.totals.unpricedRuns).toBe(1);
    expect(win.totals.turns).toBe(15);
    expect(win.series.find((s) => s.model === "flash")?.usd).toBeCloseTo(0.02);
  });
});

describe("消耗 DOM", () => {
  /** @type {HTMLElement} */
  let host;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  function boot(payload = SAMPLE) {
    const api = initUsageView(host, {
      fetchUsage: async () => payload,
      onClose: vi.fn(),
      now: () => NOW,
    });
    return api;
  }

  it("打开后画出模型卡、7 根柱、堆叠段", async () => {
    const api = boot();
    api.open();
    await Promise.resolve();
    const cardsText = api.el.querySelector("#usage-cards")?.textContent ?? "";
    expect(cardsText).toContain("pro");
    expect(cardsText).toContain("8 轮");
    expect(cardsText).toContain("flash");
    expect(cardsText).toContain("4 轮");
    expect(api.el.querySelectorAll(".usage-card")).toHaveLength(2);
    expect(api.el.querySelectorAll(".usage-col")).toHaveLength(7);
    const stacked = api.el.querySelector('.usage-col[data-day="2026-09-07"]');
    expect(stacked?.querySelectorAll(".usage-seg")).toHaveLength(2);
    expect(api.el.querySelector("#usage-chart-sub")?.textContent).toBe("按模型堆叠，近 7 天");
  });

  it("切换 30d 后卡片计入更早一天，切到表能看见未计价", async () => {
    const api = boot();
    api.open();
    await Promise.resolve();
    api.el.querySelector('[data-days="30"]').click();
    expect(api.el.querySelector("#usage-chart-sub")?.textContent).toBe("按模型堆叠，近 30 天");
    expect(api.el.querySelectorAll(".usage-col")).toHaveLength(30);
    expect(api.el.textContent).toContain("未计价");
    api.el.querySelector('[data-view="table"]').click();
    expect(api.el.querySelector("#usage-plot")?.hidden).toBe(true);
    expect(api.el.querySelector("#usage-table-wrap")?.hidden).toBe(false);
    expect(api.el.querySelector(".usage-table")?.textContent).toContain("2026-09-02");
    expect(api.el.querySelector(".usage-table")?.textContent).toContain("未计价");
    expect(api.el.querySelector(".usage-table")?.textContent).not.toMatch(/\$0\.00/);
  });

  it("悬停柱子弹出当日分模型提示", async () => {
    const api = boot();
    api.open();
    await Promise.resolve();
    const col = api.el.querySelector('.usage-col[data-day="2026-09-07"]');
    col.dispatchEvent(new Event("mouseenter"));
    const tip = col.querySelector(".usage-tip");
    expect(tip?.hidden).toBe(false);
    expect(tip?.textContent).toContain("2026年9月7日");
    expect(tip?.textContent).toContain("pro");
    expect(tip?.textContent).toContain("flash");
  });

  it("空台账不写 $0.00，卡片说没有运行", async () => {
    const api = boot({
      totalRuns: 0,
      totalTurns: 0,
      totalUsd: null,
      unpricedRuns: 0,
      byDay: [],
      byModel: [],
      byDayModel: [],
    });
    api.open();
    await Promise.resolve();
    expect(api.el.textContent).toContain("这段时间没有运行");
    expect(api.el.textContent).not.toContain("$0.00");
    expect(api.el.querySelector(".usage-card--empty")).toBeTruthy();
  });

  it("attachUsagePanel 可用独立 prefix，不占用 #usage-cards", async () => {
    const box = document.createElement("div");
    host.appendChild(box);
    const panel = attachUsagePanel(box, {
      idPrefix: "settings-usage",
      now: () => NOW,
      fetchUsage: async () => SAMPLE,
    });
    await panel.refresh();
    expect(box.querySelector("#settings-usage-cards")?.textContent).toContain("pro");
    expect(box.querySelector("#usage-cards")).toBeNull();
    expect(box.querySelectorAll(".usage-col")).toHaveLength(7);
  });
});

// @vitest-environment jsdom
// @ts-nocheck
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  formatContextWindowLabel,
  filterModels,
  fillExecutorModelSelect,
  initExecutorModelPicker,
} from "../ui/public/features/executor-model-picker.js";

describe("executor-model-picker", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="picker">
        <button type="button" id="trigger"><span id="value">加载中</span></button>
        <div id="menu" hidden>
          <input id="search" type="search" />
          <ul id="list" role="listbox"></ul>
          <aside id="detail" hidden></aside>
          <button type="button" id="manage">管理</button>
        </div>
        <select id="select"></select>
      </div>
    `;
  });

  it("formatContextWindowLabel：登记窗口写成可读短句，未知不瞎猜", () => {
    expect(formatContextWindowLabel({ window: 256_000, windowSource: "registry" }).short)
      .toBe("256k 上下文窗口");
    expect(formatContextWindowLabel({ window: null, windowSource: "unknown" }).short)
      .toBe("窗口未知");
  });

  it("filterModels 按 label/model/provider 搜索", () => {
    const models = [
      { id: "a", label: "快", model: "deepseek-v4-flash", provider: "openai" },
      { id: "b", label: "强", model: "claude-opus-4-8", provider: "anthropic" },
    ];
    expect(filterModels(models, "opus").map((m) => m.id)).toEqual(["b"]);
    expect(filterModels(models, "").length).toBe(2);
  });

  it("选择器打开后列出模型，选中带勾，详情显示窗口", async () => {
    const onSelect = vi.fn(async () => {});
    const onManage = vi.fn();
    const api = initExecutorModelPicker({
      select: document.getElementById("select"),
      trigger: document.getElementById("trigger"),
      menu: document.getElementById("menu"),
      list: document.getElementById("list"),
      search: document.getElementById("search"),
      detail: document.getElementById("detail"),
      manageBtn: document.getElementById("manage"),
      valueEl: document.getElementById("value"),
      onSelect,
      onManage,
    });
    api.setPayload({
      models: [
        {
          id: "m-fast",
          label: "快模型",
          model: "deepseek-v4-flash",
          provider: "openai",
          contextWindow: { window: 1_048_576, windowSource: "registry" },
        },
        {
          id: "m-haiku",
          label: "小模型",
          model: "claude-haiku-4-5",
          provider: "anthropic",
          contextWindow: { window: 200_000, windowSource: "registry" },
        },
      ],
      roles: { executor: "m-fast" },
    });
    expect(document.getElementById("value").textContent).toBe("快模型");
    document.getElementById("trigger").click();
    expect(document.getElementById("menu").hidden).toBe(false);
    const items = [...document.querySelectorAll(".model-picker-item")];
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("detail").textContent).toContain("1048k");
    items[1].click();
    await Promise.resolve();
    expect(onSelect).toHaveBeenCalledWith("m-haiku");
    expect(document.getElementById("select").value).toBe("m-haiku");
  });

  it("fillExecutorModelSelect 仍可作为隐藏 select 事实源", () => {
    const select = document.getElementById("select");
    fillExecutorModelSelect(select, {
      models: [{ id: "x", label: "X", model: "m", provider: "openai", contextWindow: { window: null, windowSource: "unknown" } }],
      roles: { executor: "x" },
    });
    expect(select.value).toBe("x");
  });
});

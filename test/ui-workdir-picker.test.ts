// @vitest-environment jsdom
// @ts-nocheck
/**
 * features/workdir-picker（V-29 运行时扩展）回归锁。
 *
 * 分层覆盖：
 *   纯函数层：shortenPath（短路径原样/长路径中间省略号保住头尾）、
 *             buildFsListUrl（编码/空 path）、renderWorkdirOptions
 *             （末项恒为「＋ 添加目录…」哨兵、title 全路径、selected 落值）
 *   下拉接线：wireWorkdirSelect 选中哨兵 → onAddRequest + 拨回真实目录；
 *             没记过账时退到第一个非哨兵项；真实目录记账 + title
 *   浮层    ：initWorkdirPicker 打开拉起点 / 子目录下钻 / 上一级 /
 *             粘贴路径前往 / 空目录与错误文案 / 选这个目录 → POST →
 *             onAdded + 自动关闭 / POST 失败留在浮层 / Esc 与遮罩关闭 / 幂等
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  WORKDIR_ADD_VALUE,
  shortenPath,
  renderWorkdirOptions,
  wireWorkdirSelect,
  buildFsListUrl,
  initWorkdirPicker,
} from "../ui/public/features/workdir-picker.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeSelect() {
  const select = document.createElement("select");
  document.body.appendChild(select);
  return select;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------

describe("shortenPath", () => {
  it("短路径原样返回", () => {
    expect(shortenPath("D:\\Work", 40)).toBe("D:\\Work");
  });

  it("长路径中间省略号，保住盘符头与目录尾", () => {
    const long = "D:\\Work\\Github_pros\\Agent_Design\\some\\very\\deep\\directory\\leaf";
    const out = shortenPath(long, 40);
    expect(out.length).toBe(40);
    expect(out).toContain("…");
    expect(out.startsWith("D:\\Work")).toBe(true);
    expect(out.endsWith("directory\\leaf".slice(-Math.floor(39 / 2)))).toBe(true);
  });

  it("恰好等于上限不动", () => {
    const s = "x".repeat(40);
    expect(shortenPath(s, 40)).toBe(s);
  });
});

describe("buildFsListUrl", () => {
  it("空 path = 常用起点端点", () => {
    expect(buildFsListUrl(null)).toBe("/api/fs/list");
    expect(buildFsListUrl("  ")).toBe("/api/fs/list");
  });

  it("带 path 编码进查询串", () => {
    expect(buildFsListUrl("D:\\Work\\a b")).toBe(
      `/api/fs/list?path=${encodeURIComponent("D:\\Work\\a b")}`,
    );
  });
});

describe("renderWorkdirOptions", () => {
  it("每个目录一项（title 全路径）+ 末项恒为「＋ 添加目录…」哨兵", () => {
    const select = makeSelect();
    renderWorkdirOptions(select, ["D:\\Work", "D:\\Play"], { selected: "D:\\Work" });
    const values = [...select.options].map((o) => o.value);
    expect(values).toEqual(["D:\\Work", "D:\\Play", WORKDIR_ADD_VALUE]);
    expect(select.options[0].title).toBe("D:\\Work");
    expect(select.options[1].textContent).toBe("D:\\Play");
    expect(select.options[2].textContent).toContain("添加目录");
    expect(select.value).toBe("D:\\Work");
  });

  it("selected 不在集合里 → 落第一项；长路径显示被缩短", () => {
    const select = makeSelect();
    const long = "D:\\" + "very-long-segment\\".repeat(4) + "leaf";
    renderWorkdirOptions(select, [long], { selected: "D:\\Nope" });
    expect(select.value).toBe(long);
    expect(select.options[0].textContent.length).toBeLessThanOrEqual(40);
    expect(select.options[0].title).toBe(long);
  });

  it("重建会先清空旧选项", () => {
    const select = makeSelect();
    renderWorkdirOptions(select, ["A"], {});
    renderWorkdirOptions(select, ["B", "C"], { selected: "C" });
    expect([...select.options].map((o) => o.value)).toEqual(["B", "C", WORKDIR_ADD_VALUE]);
    expect(select.value).toBe("C");
  });
});

describe("wireWorkdirSelect", () => {
  it("选中哨兵 → onAddRequest，且拨回上一个真实目录", () => {
    const select = makeSelect();
    renderWorkdirOptions(select, ["A", "B"], { selected: "A" });
    const onAddRequest = vi.fn();
    wireWorkdirSelect(select, { onAddRequest });

    select.value = "B";
    select.dispatchEvent(new Event("change"));
    expect(select.title).toBe("B");

    select.value = WORKDIR_ADD_VALUE;
    select.dispatchEvent(new Event("change"));
    expect(onAddRequest).toHaveBeenCalledTimes(1);
    expect(select.value).toBe("B"); // 哨兵从来不是「本次新建的目录」
  });

  it("没记过账（快照填充不触发 change）时退到第一个非哨兵项", () => {
    const select = makeSelect();
    renderWorkdirOptions(select, ["A", "B"], { selected: "A" });
    const onAddRequest = vi.fn();
    wireWorkdirSelect(select, { onAddRequest });

    select.value = WORKDIR_ADD_VALUE;
    select.dispatchEvent(new Event("change"));
    expect(onAddRequest).toHaveBeenCalledTimes(1);
    expect(select.value).toBe("A");
  });
});

// ---------------------------------------------------------------
// 浮层
// ---------------------------------------------------------------

/** 脚本化 fetch：按 URL 形状应答 fs/list 与 workdirs POST */
function makeFakeFetch({ tree = {}, addResult = { status: 200, body: {} } } = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.startsWith("/api/fs/list")) {
      const u = new URL(url, "http://localhost");
      const path = u.searchParams.get("path");
      if (path && tree[path] === undefined) {
        return { ok: false, status: 404, json: async () => ({ error: `目录不存在或读不了：${path}` }) };
      }
      const entry = path ? tree[path] : { path: null, parent: null, dirs: tree.__roots__ ?? [] };
      return { ok: true, status: 200, json: async () => entry };
    }
    if (url === "/api/workdirs" && opts.method === "POST") {
      return {
        ok: addResult.status < 400,
        status: addResult.status,
        json: async () => addResult.body,
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return { fetchImpl, calls };
}

const TREE = {
  __roots__: [{ name: "宿主工作目录", path: "D:\\Host" }],
  "D:\\Host": {
    path: "D:\\Host",
    parent: "D:\\",
    dirs: [{ name: "proj", path: "D:\\Host\\proj" }],
  },
  "D:\\Host\\proj": { path: "D:\\Host\\proj", parent: "D:\\Host", dirs: [] },
  "D:\\": { path: "D:\\", parent: null, dirs: [{ name: "Host", path: "D:\\Host" }] },
};

describe("initWorkdirPicker", () => {
  it("打开 → 拉常用起点；下钻 → 上一级 回到父目录", async () => {
    const { fetchImpl, calls } = makeFakeFetch({ tree: TREE });
    const picker = initWorkdirPicker({}, { fetch: fetchImpl });
    picker.open();
    await flush();
    expect(picker.isOpen()).toBe(true);
    expect(picker.currentPath()).toBeNull();
    const items = [...document.querySelectorAll(".wp-dir")];
    expect(items.map((i) => i.textContent)).toEqual(["宿主工作目录"]);
    // 起点态：上一级与「选这个目录」都不可用
    expect(document.querySelector(".wp-up").disabled).toBe(true);
    expect(document.querySelector(".wp-choose").disabled).toBe(true);

    // 下钻
    items[0].click();
    await flush();
    expect(picker.currentPath()).toBe("D:\\Host");
    expect(calls.at(-1).url).toBe(buildFsListUrl("D:\\Host"));
    expect(document.querySelector(".wp-choose").disabled).toBe(false);

    // 上一级
    document.querySelector(".wp-up").click();
    await flush();
    expect(picker.currentPath()).toBe("D:\\");
    expect(document.querySelector(".wp-up").disabled).toBe(true); // 根没有上级
  });

  it("空目录有文案；读不了的目录报服务端错误", async () => {
    const { fetchImpl } = makeFakeFetch({ tree: TREE });
    const picker = initWorkdirPicker({}, { fetch: fetchImpl });
    picker.open("D:\\Host\\proj");
    await flush();
    expect(document.querySelector(".wp-empty").textContent).toContain("没有可进入的子目录");

    picker.open("D:\\Nope");
    await flush();
    expect(document.querySelector(".wp-status").textContent).toContain("不存在");
  });

  it("粘贴路径 → 前往", async () => {
    const { fetchImpl, calls } = makeFakeFetch({ tree: TREE });
    const picker = initWorkdirPicker({}, { fetch: fetchImpl });
    picker.open();
    await flush();
    const input = document.querySelector(".wp-path-input");
    input.value = "  D:\\Host  ";
    document.querySelector(".wp-go").click();
    await flush();
    expect(calls.at(-1).url).toBe(buildFsListUrl("D:\\Host"));
    expect(picker.currentPath()).toBe("D:\\Host");
  });

  it("选这个目录 → POST /api/workdirs → onAdded 且浮层关闭", async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      tree: TREE,
      addResult: { status: 200, body: { added: true, workdir: "D:\\Host\\proj", workdirs: ["D:\\Host", "D:\\Host\\proj"] } },
    });
    const onAdded = vi.fn();
    const picker = initWorkdirPicker({ onAdded }, { fetch: fetchImpl });
    picker.open("D:\\Host\\proj");
    await flush();
    document.querySelector(".wp-choose").click();
    await flush();
    const post = calls.find((c) => c.opts.method === "POST");
    expect(JSON.parse(post.opts.body)).toEqual({ path: "D:\\Host\\proj" });
    expect(onAdded).toHaveBeenCalledWith("D:\\Host\\proj", expect.objectContaining({ added: true }));
    expect(picker.isOpen()).toBe(false);
  });

  it("POST 失败 → 错误文案，浮层不收", async () => {
    const { fetchImpl } = makeFakeFetch({
      tree: TREE,
      addResult: { status: 404, body: { error: "目录不存在：D:\\Host\\proj" } },
    });
    const onAdded = vi.fn();
    const picker = initWorkdirPicker({ onAdded }, { fetch: fetchImpl });
    picker.open("D:\\Host\\proj");
    await flush();
    document.querySelector(".wp-choose").click();
    await flush();
    expect(onAdded).not.toHaveBeenCalled();
    expect(picker.isOpen()).toBe(true);
    expect(document.querySelector(".wp-status").textContent).toContain("不存在");
  });

  it("Esc 与点遮罩都关浮层", async () => {
    const { fetchImpl } = makeFakeFetch({ tree: TREE });
    const picker = initWorkdirPicker({}, { fetch: fetchImpl });
    picker.open();
    await flush();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(picker.isOpen()).toBe(false);

    picker.open();
    await flush();
    const overlay = document.getElementById("workdir-picker-overlay");
    overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(picker.isOpen()).toBe(false);
  });

  it("幂等：二次 init 返回同一个 api", () => {
    const { fetchImpl } = makeFakeFetch({ tree: TREE });
    const a = initWorkdirPicker({}, { fetch: fetchImpl });
    const b = initWorkdirPicker({}, { fetch: fetchImpl });
    expect(a).toBe(b);
  });
});

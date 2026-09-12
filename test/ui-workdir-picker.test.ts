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
  formatWorkdirTriggerLabel,
  normalizeWorkdirSelection,
  applyWorkdirSelection,
  getWorkdirSelection,
  renderWorkdirMenu,
  initWorkdirCombobox,
  buildFsMkdirUrl,
  isSafeFolderName,
  workdirBreadcrumbs,
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

describe("workdirBreadcrumbs / isSafeFolderName", () => {
  it("Windows 盘符拆成可点的每一级", () => {
    expect(workdirBreadcrumbs("D:\\Host\\proj")).toEqual([
      { name: "D:\\", path: "D:\\" },
      { name: "Host", path: "D:\\Host" },
      { name: "proj", path: "D:\\Host\\proj" },
    ]);
  });

  it("Unix 根拆成 / 加每一级", () => {
    expect(workdirBreadcrumbs("/tmp/a")).toEqual([
      { name: "/", path: "/" },
      { name: "tmp", path: "/tmp" },
      { name: "a", path: "/tmp/a" },
    ]);
  });

  it("拒绝穿越与非法文件夹名", () => {
    expect(isSafeFolderName("ok")).toBe(true);
    expect(isSafeFolderName("..")).toBe(false);
    expect(isSafeFolderName("a/b")).toBe(false);
    expect(isSafeFolderName("a:b")).toBe(false);
  });

  it("mkdir 地址固定", () => {
    expect(buildFsMkdirUrl()).toBe("/api/fs/mkdir");
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

describe("formatWorkdirTriggerLabel / normalizeWorkdirSelection", () => {
  it("关闭态：只有主目录时缩短路径，有额外目录加 · +N", () => {
    expect(formatWorkdirTriggerLabel("D:\\Work", [], 40)).toBe("D:\\Work");
    expect(formatWorkdirTriggerLabel("D:\\a", ["D:\\b", "D:\\c"])).toBe("D:\\a · +2");
    expect(formatWorkdirTriggerLabel("D:\\a", ["D:\\a"])).toBe("D:\\a");
    expect(formatWorkdirTriggerLabel("")).toBe("选择目录");
  });

  it("额外目录去重、丢掉主目录、丢掉不在白名单里的", () => {
    expect(normalizeWorkdirSelection(["A", "B", "C"], {
      primary: "B",
      extras: ["A", "A", "B", "Nope"],
    })).toEqual({ primary: "B", extras: ["A"] });
    expect(normalizeWorkdirSelection(["A", "B"], { primary: "Nope" })).toEqual({
      primary: "A",
      extras: [],
    });
  });
});

describe("applyWorkdirSelection", () => {
  it("主目录写进 select.value，额外目录进 dataset.extras", () => {
    const select = makeSelect();
    renderWorkdirOptions(select, ["A", "B", "C"], { selected: "A" });
    applyWorkdirSelection(select, ["A", "B", "C"], { primary: "C", extras: ["A", "C"] });
    expect(select.value).toBe("C");
    expect(getWorkdirSelection(select)).toEqual({ primary: "C", extras: ["A"] });
  });
});

describe("renderWorkdirMenu + initWorkdirCombobox", () => {
  function mountCombobox(workdirs = ["A", "B", "C"], selected = "A") {
    const root = document.createElement("div");
    root.id = "workdir-combobox";
    const select = document.createElement("select");
    select.id = "workdir-select";
    const trigger = document.createElement("button");
    trigger.id = "workdir-trigger";
    trigger.type = "button";
    const text = document.createElement("span");
    text.className = "wd-trigger-text";
    trigger.appendChild(text);
    const menu = document.createElement("div");
    menu.id = "workdir-menu";
    menu.className = "wd-menu";
    menu.hidden = true;
    root.append(select, trigger, menu);
    document.body.appendChild(root);
    renderWorkdirOptions(select, workdirs, { selected });
    return { root, select, trigger, menu, text };
  }

  it("菜单用主题色行而不是原生 option，未选中项也有完整路径字", () => {
    const menu = document.createElement("div");
    document.body.appendChild(menu);
    renderWorkdirMenu(menu, ["D:\\Work", "D:\\Play"], { primary: "D:\\Play" });
    const rows = [...menu.querySelectorAll(".wd-option")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("D:\\Work");
    expect(rows[1].classList.contains("is-primary")).toBe(true);
    expect(menu.querySelector(".wd-menu-hint")?.textContent).toContain("读写");
    expect(menu.querySelector(".wd-add")?.textContent).toContain("添加目录");
    expect(menu.querySelector("option")).toBeNull();
  });

  it("勾选额外目录 → onChange；设为主会把旧主目录留在 extras", () => {
    const { root, select, trigger, menu } = mountCombobox();
    const onChange = vi.fn();
    const onAddRequest = vi.fn();
    const api = initWorkdirCombobox(root, { onChange, onAddRequest });
    expect(api).toBeTruthy();
    expect(trigger.querySelector(".wd-trigger-text")?.textContent).toBe("A");

    trigger.click();
    expect(api.isOpen()).toBe(true);
    const checkB = menu.querySelector('[data-path="B"] .wd-check');
    checkB.checked = true;
    checkB.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith({ primary: "A", extras: ["B"] });
    expect(getWorkdirSelection(select)).toEqual({ primary: "A", extras: ["B"] });
    expect(trigger.querySelector(".wd-trigger-text")?.textContent).toBe("A · +1");

    const setPrimary = menu.querySelector('[data-path="C"] .wd-primary-btn');
    setPrimary.click();
    expect(onChange).toHaveBeenLastCalledWith({ primary: "C", extras: ["B", "A"] });
    expect(select.value).toBe("C");
  });

  it("添加目录按钮关掉菜单并请求浮层；Esc / 点外面关闭", () => {
    const { root, trigger, menu } = mountCombobox();
    const onAddRequest = vi.fn();
    const api = initWorkdirCombobox(root, { onAddRequest });
    trigger.click();
    menu.querySelector("[data-add]").click();
    expect(onAddRequest).toHaveBeenCalledTimes(1);
    expect(api.isOpen()).toBe(false);

    trigger.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(api.isOpen()).toBe(false);

    trigger.click();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(api.isOpen()).toBe(false);
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
    if (url === "/api/fs/mkdir" && opts.method === "POST") {
      const body = JSON.parse(opts.body ?? "{}");
      const parent = tree[body.path];
      if (!parent) {
        return { ok: false, status: 404, json: async () => ({ error: "目录不存在" }) };
      }
      const created = `${body.path}\\${body.name}`;
      parent.dirs = [...(parent.dirs ?? []), { name: body.name, path: created }];
      tree[created] = { path: created, parent: body.path, dirs: [] };
      return { ok: true, status: 200, json: async () => ({ path: created, parent: body.path, name: body.name }) };
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

  it("面包屑可点回上级；新建文件夹 POST 后刷新列表", async () => {
    const { fetchImpl, calls } = makeFakeFetch({ tree: TREE });
    const picker = initWorkdirPicker({}, {
      fetch: fetchImpl,
      prompt: () => "newdir",
    });
    picker.open("D:\\Host");
    await flush();
    const crumbs = [...document.querySelectorAll(".wp-crumb")];
    expect(crumbs.map((c) => c.textContent)).toEqual(["D:\\", "Host"]);
    crumbs[0].click();
    await flush();
    expect(picker.currentPath()).toBe("D:\\");

    picker.open("D:\\Host");
    await flush();
    document.querySelector(".wp-mkdir").click();
    await flush();
    const mkdir = calls.find((c) => c.url === "/api/fs/mkdir");
    expect(JSON.parse(mkdir.opts.body)).toEqual({ path: "D:\\Host", name: "newdir" });
    expect([...document.querySelectorAll(".wp-dir")].map((i) => i.textContent)).toContain("newdir");
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

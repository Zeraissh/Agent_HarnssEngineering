// @vitest-environment jsdom
// @ts-nocheck
/**
 * 记忆面板（features/memory-panel.js）的回归锁——T5。
 *
 * 分层覆盖：
 *   纯函数层：响应整形 / 字节格式化 / 文案常量
 *   DOM 层  ：jsdom 里真实初始化 + 注入 fetchFn，验证列表渲染、选择预览
 *             （markdown 渲染、截断标注、404 降级）、空态、错误态与重试
 *   命令面板：registerPaletteCommand 外部注册 API（注册/执行/撞名/注销）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  normalizeMemoryList,
  normalizeMemoryFile,
  formatSize,
  MEMORY_COPY,
  initMemoryPanel,
} from "../ui/public/features/memory-panel.js";
import {
  registerPaletteCommand,
  listExternalCommands,
  buildPaletteItems,
  executeItem,
} from "../ui/public/features/command-palette.js";

const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------
describe("normalizeMemoryList 响应整形", () => {
  it("合法负载原样通过，mtimeMs 非法值降级为 null", () => {
    const out = normalizeMemoryList({
      dir: "/x/.agent-memory",
      entries: [
        { name: "a.md", summary: "摘要", sizeBytes: 12, mtimeMs: NOW },
        { name: "b.md", summary: "乙", sizeBytes: 3, mtimeMs: "bogus" },
      ],
    });
    expect(out.dir).toBe("/x/.agent-memory");
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]).toMatchObject({ name: "a.md", summary: "摘要", sizeBytes: 12, mtimeMs: NOW });
    expect(out.status).toBeNull();
    expect(out.shared).toBe(false);
    expect(out.entries[1].mtimeMs).toBeNull();
  });

  it("畸形负载降级为空列表，无名条目被过滤", () => {
    expect(normalizeMemoryList(null)).toEqual({
      dir: null,
      project: null,
      shared: false,
      status: null,
      entries: [],
    });
    expect(normalizeMemoryList({}).entries).toEqual([]);
    expect(normalizeMemoryList({ entries: [{ summary: "没名字" }, 42, { name: "ok.md" }] }).entries)
      .toEqual([{ name: "ok.md", summary: "", sizeBytes: 0, mtimeMs: null, scope: null }]);
  });
});

describe("normalizeMemoryFile 响应整形", () => {
  it("合法负载通过；缺 name/content 返回 null", () => {
    expect(normalizeMemoryFile({ name: "a.md", content: "# t", sizeBytes: 10, truncated: true }))
      .toEqual({ name: "a.md", content: "# t", sizeBytes: 10, truncated: true });
    expect(normalizeMemoryFile({ name: "a.md" })).toBeNull();
    expect(normalizeMemoryFile("nope")).toBeNull();
  });

  it("truncated 缺省为 false", () => {
    expect(normalizeMemoryFile({ name: "a.md", content: "x" }).truncated).toBe(false);
  });
});

describe("formatSize 字节格式化", () => {
  it("B / KB / MB 分档", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatSize(NaN)).toBe("0 B");
  });
});

// ---------------------------------------------------------------
// 命令面板外部注册 API（最小接入面）
// ---------------------------------------------------------------
describe("registerPaletteCommand 外部命令注册", () => {
  let unregister = null;
  afterEach(() => { unregister?.(); unregister = null; });

  it("注册后进入命令条目组装，executeItem 派发 run 并消费", () => {
    const run = vi.fn();
    unregister = registerPaletteCommand({ id: "view-memory", label: "查看记忆", icon: "ph-brain", run });
    expect(listExternalCommands().map((c) => c.id)).toContain("view-memory");

    const { items } = buildPaletteItems({ query: "", commands: listExternalCommands(), conversations: [] });
    const item = items.find((i) => i.id === "cmd:view-memory");
    expect(item).toBeDefined();
    expect(item.label).toBe("查看记忆");
    expect(executeItem(item, {})).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("注销后从注册表消失", () => {
    unregister = registerPaletteCommand({ id: "temp-cmd", label: "临时" });
    expect(listExternalCommands().some((c) => c.id === "temp-cmd")).toBe(true);
    unregister();
    unregister = null;
    expect(listExternalCommands().some((c) => c.id === "temp-cmd")).toBe(false);
  });

  it("缺 id/label 或与内置撞名时拒绝注册", () => {
    expect(() => registerPaletteCommand({ label: "无 id" })).toThrow();
    expect(() => registerPaletteCommand({ id: "new-chat", label: "撞名" })).toThrow();
    expect(() => registerPaletteCommand({ id: "theme-dark", label: "撞前缀" })).toThrow();
  });
});

// ---------------------------------------------------------------
// DOM 层
// ---------------------------------------------------------------
function mockResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function setupDom() {
  document.body.innerHTML =
    '<button type="button" id="memory-btn" aria-expanded="false"></button>';
}

const LIST_PAYLOAD = {
  dir: "/proj/.agent-memory",
  entries: [
    { name: "deploy-ports.md", summary: "部署端口", sizeBytes: 120, mtimeMs: NOW - 60_000 },
    { name: "shell-lessons.md", summary: "shell 教训", sizeBytes: 2048, mtimeMs: null },
  ],
};

/** 等待面板内出现满足条件的节点（loadList 是异步的） */
async function waitFor(fn, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    // 空 NodeList 也是真值——集合类结果要求非空才算等到
    if (value && (typeof value.length !== "number" || value.length > 0)) return value;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("initMemoryPanel DOM 层", () => {
  beforeEach(setupDom);
  afterEach(() => { document.body.innerHTML = ""; });

  it("打开面板拉取列表并渲染名称 / 摘要 / 元信息", async () => {
    const fetchFn = vi.fn(async (url) => mockResponse(200, LIST_PAYLOAD));
    const api = initMemoryPanel({}, { fetchFn, now: () => NOW });
    api.open();
    const items = await waitFor(() => document.querySelectorAll(".mem-item"));
    expect(items).toHaveLength(2);
    expect(fetchFn).toHaveBeenCalledWith("/api/memory");
    expect(document.querySelector(".mem-item-name").textContent).toBe("deploy-ports.md");
    expect(document.querySelector(".mem-item-summary").textContent).toBe("部署端口");
    // 大小 + 相对时间；mtimeMs 为 null 的条目只剩大小
    expect(items[0].textContent).toContain("120 B");
    expect(items[0].textContent).toContain("分钟前");
    expect(items[1].textContent).toContain("2.0 KB");
    // 作用域目录展示在头部
    expect(document.querySelector(".mem-dir").textContent).toBe("/proj/.agent-memory");
  });

  it("点击条目后拉取全文并用 markdown 渲染预览", async () => {
    const fetchFn = vi.fn(async (url) => {
      if (url === "/api/memory") return mockResponse(200, LIST_PAYLOAD);
      if (url === "/api/memory/shell-lessons.md") {
        return mockResponse(200, {
          name: "shell-lessons.md", content: "# 教训\n\n**粗体**内容", sizeBytes: 30, truncated: false,
        });
      }
      return mockResponse(404, {});
    });
    const api = initMemoryPanel({}, { fetchFn, now: () => NOW });
    api.open();
    const items = await waitFor(() => document.querySelectorAll(".mem-item"));
    items[1].click();
    const content = await waitFor(() => document.querySelector(".mem-preview-content"));
    expect(fetchFn).toHaveBeenCalledWith("/api/memory/shell-lessons.md");
    expect(content.innerHTML).toContain("<strong>粗体</strong>");
    expect(content.querySelector(".md-h").textContent).toContain("教训");
    // 选中态（点击后列表重渲染，需重新查询节点）
    const selected = document.querySelector('.mem-item[aria-selected="true"]');
    expect(selected?.dataset.name).toBe("shell-lessons.md");
    expect(document.querySelector(".mem-preview-head").textContent).toContain("shell-lessons.md");
    expect(document.querySelector(".mem-preview-truncated")).toBeNull();
  });

  it("截断响应展示截断标注", async () => {
    const fetchFn = vi.fn(async (url) => {
      if (url === "/api/memory") return mockResponse(200, LIST_PAYLOAD);
      return mockResponse(200, { name: "deploy-ports.md", content: "x", sizeBytes: 300_000, truncated: true });
    });
    const api = initMemoryPanel({}, { fetchFn, now: () => NOW });
    api.open();
    const items = await waitFor(() => document.querySelectorAll(".mem-item"));
    items[0].click();
    const note = await waitFor(() => document.querySelector(".mem-preview-truncated"));
    expect(note.textContent).toBe(MEMORY_COPY.truncatedNote);
  });

  it("空态：列表为空时展示引导文案", async () => {
    const fetchFn = vi.fn(async () => mockResponse(200, { dir: "/x/.agent-memory", entries: [] }));
    const api = initMemoryPanel({}, { fetchFn, now: () => NOW });
    api.open();
    const empty = await waitFor(() => {
      const el = document.querySelector(".mem-empty");
      return el && !el.hidden ? el : null;
    });
    expect(empty.textContent).toBe(MEMORY_COPY.empty);
    expect(document.querySelector(".mem-body").hidden).toBe(true);
  });

  it("错误态：列表端点 500 时行内降级文案 + 重试可恢复", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? mockResponse(500, {}) : mockResponse(200, LIST_PAYLOAD);
    });
    const api = initMemoryPanel({}, { fetchFn, now: () => NOW });
    api.open();
    const errorBox = await waitFor(() => {
      const el = document.querySelector(".mem-error");
      return el && !el.hidden ? el : null;
    });
    expect(errorBox.textContent).toContain(MEMORY_COPY.listError(500));
    expect(document.querySelector(".mem-body").hidden).toBe(true);

    document.querySelector(".mem-error-retry").click();
    await waitFor(() => document.querySelectorAll(".mem-item").length === 2);
    expect(document.querySelector(".mem-error").hidden).toBe(true);
  });

  it("预览端点 404 时降级为「已被删除」文案", async () => {
    const fetchFn = vi.fn(async (url) => {
      if (url === "/api/memory") return mockResponse(200, LIST_PAYLOAD);
      return mockResponse(404, {});
    });
    const api = initMemoryPanel({}, { fetchFn, now: () => NOW });
    api.open();
    const items = await waitFor(() => document.querySelectorAll(".mem-item"));
    items[0].click();
    const hint = await waitFor(() => {
      const el = document.querySelector(".mem-preview-hint");
      return el && el.textContent.includes("删除") ? el : null;
    });
    expect(hint.textContent).toBe(MEMORY_COPY.previewError(404));
  });

  it("Esc 与遮罩点击关闭面板，入口按钮 aria-expanded 联动", async () => {
    const fetchFn = vi.fn(async () => mockResponse(200, LIST_PAYLOAD));
    const api = initMemoryPanel({}, { fetchFn, now: () => NOW });
    const btn = document.getElementById("memory-btn");
    api.open();
    await waitFor(() => document.querySelectorAll(".mem-item").length === 2);
    expect(api.isOpen()).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("true");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(api.isOpen()).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("false");

    api.open();
    expect(api.isOpen()).toBe(true);
    api.element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(api.isOpen()).toBe(false);
  });

  it("进行中看板单独钉在列表上；本项目/全部切换请求参数", async () => {
    const fetchFn = vi.fn(async (url) => {
      if (String(url).startsWith("/api/memory?")) {
        return mockResponse(200, {
          dir: "/proj/.agent-memory",
          project: "proj",
          status: {
            summary: "规格待签字",
            waiting: ["委托方：规格签字"],
            nextGate: "评审会",
            decisions: ["是否先出幻灯"],
          },
          entries: LIST_PAYLOAD.entries,
        });
      }
      return mockResponse(200, {
        ...LIST_PAYLOAD,
        status: {
          summary: "规格待签字",
          waiting: ["委托方：规格签字"],
          nextGate: "评审会",
          decisions: ["是否先出幻灯"],
        },
      });
    });
    const api = initMemoryPanel(
      { getWorkdir: () => "D:/proj/alpha" },
      { fetchFn, now: () => NOW },
    );
    api.open();
    await waitFor(() => document.querySelector(".mem-board:not([hidden])"));
    expect(fetchFn).toHaveBeenCalledWith("/api/memory?workdir=D%3A%2Fproj%2Falpha");
    expect(document.querySelector(".mem-board-summary")?.textContent).toBe("规格待签字");
    expect(document.querySelector(".mem-board-meta")?.textContent).toContain("评审会");
    expect(document.querySelector('[data-scope="current"]')?.getAttribute("aria-selected")).toBe("true");

    document.querySelector('[data-scope="all"]').click();
    await waitFor(() => fetchFn.mock.calls.some((c) => String(c[0]).includes("scope=all")));
    expect(fetchFn).toHaveBeenCalledWith("/api/memory?scope=all&workdir=D%3A%2Fproj%2Falpha");
    expect(api.getState().listScope).toBe("all");
  });

  it("关闭面板时通知宿主刷新门禁 chip", async () => {
    const onClose = vi.fn();
    const fetchFn = vi.fn(async () => mockResponse(200, LIST_PAYLOAD));
    const api = initMemoryPanel({ onClose }, { fetchFn, now: () => NOW });
    api.open();
    await waitFor(() => document.querySelectorAll(".mem-item").length === 2);
    api.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("幂等：重复初始化返回既有节点薄壳，不重复挂 DOM", async () => {
    const fetchFn = vi.fn(async () => mockResponse(200, LIST_PAYLOAD));
    const first = initMemoryPanel({}, { fetchFn, now: () => NOW });
    const second = initMemoryPanel({}, { fetchFn, now: () => NOW });
    expect(document.querySelectorAll("#memory-panel")).toHaveLength(1);
    second.open();
    expect(first.element.hidden).toBe(false);
  });
});

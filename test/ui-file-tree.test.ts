// @vitest-environment jsdom
// @ts-nocheck
/**
 * Code 脸文件树（features/file-tree.js）回归锁。
 *
 * 纯函数：树 URL / 展开集合 / 人话失败 / files[] 拆成条目与 notice。
 * DOM：树形状、点文件夹展开（q=dir/）、圈禁逃逸与 403 不把 HTTP 码画到脸上。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  FILE_TREE_COPY,
  treeQueryForDir,
  buildWorkspaceTreeUrl,
  isTreeNotice,
  splitTreeEntries,
  humanizeTreeFailure,
  toggleExpanded,
  initFileTree,
} from "../ui/public/features/file-tree.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

function mockResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function mountTree(host = {}, env = {}) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const api = initFileTree({ mount: root, ...host }, env);
  return { root, api };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("treeQueryForDir / buildWorkspaceTreeUrl", () => {
  it("根不带 q；子目录带尾斜杠", () => {
    expect(treeQueryForDir("")).toBe("");
    expect(treeQueryForDir("src")).toBe("src/");
    expect(treeQueryForDir("src/nested/")).toBe("src/nested/");
    expect(buildWorkspaceTreeUrl("D:\\work", "")).toBe(
      "/api/workspace/files?workdir=D%3A%5Cwork",
    );
    expect(buildWorkspaceTreeUrl("D:\\work", "src")).toContain("q=src%2F");
  });
});

describe("splitTreeEntries / toggleExpanded / 人话", () => {
  it("notice 与真实条目拆开；展开集合按路径翻转", () => {
    expect(isTreeNotice({ notice: "这个路径不在当前工作目录里。" })).toBe(true);
    const { entries, notices } = splitTreeEntries([
      { name: "src", relative: "src", kind: "directory" },
      { name: "hello.txt", relative: "hello.txt", kind: "file" },
      { name: "", relative: "../secret", kind: "directory", notice: "这个路径不在当前工作目录里。" },
      { name: "skip", relative: "", kind: "file" },
    ]);
    expect(entries.map((e) => e.relative)).toEqual(["src", "hello.txt"]);
    expect(notices.map((n) => n.notice)).toEqual(["这个路径不在当前工作目录里。"]);

    const once = toggleExpanded(new Set(), "src");
    expect([...once]).toEqual(["src"]);
    expect([...toggleExpanded(once, "src")]).toEqual([]);
  });

  it("失败文案不出现 HTTP 码", () => {
    expect(humanizeTreeFailure(403, "工作目录不在白名单内。")).toBe("工作目录不在白名单内。");
    const fallback = humanizeTreeFailure(403, "");
    expect(fallback).not.toMatch(/HTTP/i);
    expect(fallback).not.toMatch(/\b403\b/);
    expect(humanizeTreeFailure(500, "HTTP 500 boom")).not.toMatch(/HTTP\s*500/i);
  });
});

describe("initFileTree DOM", () => {
  it("树形状：根下列出文件夹与文件", async () => {
    const fetchFn = vi.fn(async () => mockResponse(200, {
      files: [
        { name: "src", relative: "src", kind: "directory" },
        { name: "hello.txt", relative: "hello.txt", kind: "file" },
      ],
    }));
    const { root } = mountTree({ getWorkdir: () => "D:/proj" }, { fetch: fetchFn });
    await root.__fileTreeApi.reload();
    await flush();
    const rows = [...root.querySelectorAll(".ft-row")];
    expect(rows.map((el) => el.dataset.path)).toEqual(["src", "hello.txt"]);
    expect(rows.map((el) => el.dataset.kind)).toEqual(["directory", "file"]);
    expect(fetchFn).toHaveBeenCalledWith("/api/workspace/files?workdir=D%3A%2Fproj");
  });

  it("展开文件夹再打 q=dir/，子节点挂在树里", async () => {
    const fetchFn = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("q=src%2F")) {
        return mockResponse(200, {
          files: [{ name: "app.js", relative: "src/app.js", kind: "file" }],
        });
      }
      return mockResponse(200, {
        files: [{ name: "src", relative: "src", kind: "directory" }],
      });
    });
    const { root } = mountTree({ getWorkdir: () => "D:/proj" }, { fetch: fetchFn });
    await root.__fileTreeApi.reload();
    await flush();
    root.querySelector('.ft-row[data-path="src"] .ft-twist').click();
    await flush();
    await flush();
    expect(fetchFn.mock.calls.some((c) => String(c[0]).includes("q=src%2F"))).toBe(true);
    expect(root.querySelector('.ft-row[data-path="src/app.js"]')).toBeTruthy();
    expect(root.querySelector('.ft-row[data-path="src"] .ft-twist').getAttribute("aria-expanded")).toBe("true");
  });

  it("点文件走 onPreview，行内 @ 走 onCite，不发明第三套", async () => {
    const onPreview = vi.fn();
    const onCite = vi.fn();
    const fetchFn = vi.fn(async () => mockResponse(200, {
      files: [{ name: "hello.txt", relative: "hello.txt", kind: "file" }],
    }));
    const { root } = mountTree(
      { getWorkdir: () => "D:/proj", onPreview, onCite },
      { fetch: fetchFn },
    );
    await root.__fileTreeApi.reload();
    await flush();
    root.querySelector(".ft-name").click();
    expect(onPreview).toHaveBeenCalledWith("hello.txt");
    root.querySelector(".ft-cite").click();
    expect(onCite).toHaveBeenCalledWith("hello.txt", "file");
  });

  it("圈禁逃逸 notice 与 403 都是人话，没有 HTTP 码", async () => {
    const escaped = vi.fn(async () => mockResponse(200, {
      files: [{
        name: "",
        relative: "../secret",
        kind: "directory",
        notice: "这个路径不在当前工作目录里。",
      }],
    }));
    const { root, api } = mountTree({ getWorkdir: () => "D:/proj" }, { fetch: escaped });
    await api.reload();
    await flush();
    expect(root.querySelector(".ft-notice")?.textContent).toBe("这个路径不在当前工作目录里。");
    expect(root.textContent).not.toMatch(/HTTP/i);
    expect(root.querySelector(".ft-row")).toBeNull();

    const denied = vi.fn(async () => mockResponse(403, { error: "工作目录不在白名单内。" }));
    const second = mountTree({ getWorkdir: () => "D:/outside" }, { fetch: denied });
    await second.api.reload();
    await flush();
    expect(second.root.querySelector(".ft-error")?.textContent).toBe("工作目录不在白名单内。");
    expect(second.root.textContent).not.toMatch(/HTTP/i);
    expect(second.root.textContent).not.toMatch(/\b403\b/);
  });

  it("空目录与未选工作目录用人话", async () => {
    const empty = mountTree({ getWorkdir: () => "" }, { fetch: vi.fn() });
    await empty.api.reload();
    expect(empty.root.querySelector(".ft-empty")?.textContent).toBe(FILE_TREE_COPY.noWorkdir);

    const fetchFn = vi.fn(async () => mockResponse(200, { files: [] }));
    const { root, api } = mountTree({ getWorkdir: () => "D:/proj" }, { fetch: fetchFn });
    await api.reload();
    await flush();
    expect(root.querySelector(".ft-empty")?.textContent).toBe(FILE_TREE_COPY.emptyRoot);
  });
});

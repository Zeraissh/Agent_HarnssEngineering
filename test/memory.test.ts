import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryTools, MemoryStore } from "../src/memory.js";
import type { Tool } from "../src/types.js";

let dir: string;
let store: MemoryStore;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "harness-memory-"));
  store = new MemoryStore(dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("MemoryStore", () => {
  it("write → list → read 闭环；摘要取首个非空行并去 # 前缀", async () => {
    await store.write("deploy-port.md", "# 部署端口是 7788\n\n详细：staging 与 prod 都用 7788。");
    await store.write("lessons/windows-shell.md", "Windows 下要用 cmd 语法\n细节……");

    const entries = await store.list();
    expect(entries.map((e) => e.name)).toEqual(["deploy-port.md", "lessons/windows-shell.md"]);
    expect(entries[0]!.summary).toBe("部署端口是 7788");

    expect(await store.read("deploy-port.md")).toContain("7788");
  });

  it("indexBlock：有记忆时逐行列出，无记忆时明确说明", async () => {
    const block = await store.indexBlock();
    expect(block).toContain("- deploy-port.md: 部署端口是 7788");

    const empty = new MemoryStore(path.join(dir, "does-not-exist"));
    expect(await empty.indexBlock()).toBe("(no memories yet)");
  });

  it("非法名字被拒：路径逃逸、绝对路径、非 .md", async () => {
    await expect(store.write("../evil.md", "x")).rejects.toThrow(/Invalid memory name/);
    await expect(store.write("a/../../evil.md", "x")).rejects.toThrow(/Invalid|escapes/);
    await expect(store.write("C:/evil.md", "x")).rejects.toThrow(/Invalid memory name/);
    await expect(store.write("note.txt", "x")).rejects.toThrow(/Invalid memory name/);
  });

  it("超过 64KB 拒绝写入（记忆不是数据仓库）", async () => {
    await expect(store.write("huge.md", "x".repeat(65 * 1024))).rejects.toThrow(/too large/);
  });

  it("delete 后不再出现在 list", async () => {
    await store.write("temp.md", "临时");
    await store.delete("temp.md");
    const names = (await store.list()).map((e) => e.name);
    expect(names).not.toContain("temp.md");
  });
});

describe("createMemoryTools", () => {
  const byName = (tools: Tool[], name: string) => tools.find((t) => t.name === name)!;
  const ctx = { workdir: "irrelevant", toolUseId: "tu", signal: new AbortController().signal };

  it("四个工具齐全；读类 parallelSafe，全部 auto（圈禁不变量使 auto 成立）", () => {
    const tools = createMemoryTools(store);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "memory_delete",
      "memory_list",
      "memory_read",
      "memory_write",
    ]);
    expect(byName(tools, "memory_list").parallelSafe).toBe(true);
    expect(byName(tools, "memory_read").parallelSafe).toBe(true);
    expect(tools.every((t) => t.permission === "auto")).toBe(true);
  });

  it("memory_write → memory_list 摘要可见；memory_read 读回全文", async () => {
    const tools = createMemoryTools(store);
    await byName(tools, "memory_write").execute(
      { name: "pref.md", content: "用户偏好中文回复\n补充：术语保留英文。" },
      ctx,
    );
    const listed = await byName(tools, "memory_list").execute({}, ctx);
    expect(listed.content).toContain("pref.md: 用户偏好中文回复");
    const read = await byName(tools, "memory_read").execute({ name: "pref.md" }, ctx);
    expect(read.content).toContain("术语保留英文");
  });

  it("非法名字经工具路径同样被拒（错误抛给 executor 收敛为 is_error）", async () => {
    const tools = createMemoryTools(store);
    await expect(
      byName(tools, "memory_write").execute({ name: "../escape.md", content: "x" }, ctx),
    ).rejects.toThrow(/Invalid memory name/);
  });
});

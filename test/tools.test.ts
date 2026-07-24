import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools/registry.js";
import { resolveInWorkdir, truncate } from "../src/tools/fs-util.js";
import { readFileTool } from "../src/tools/read-file.js";
import { writeFileTool } from "../src/tools/write-file.js";
import { makeTool } from "./helpers.js";

let workdir: string;
const ctx = (toolUseId = "tu_test") => ({
  workdir,
  toolUseId,
  signal: new AbortController().signal,
});

beforeAll(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "harness-test-"));
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("resolveInWorkdir", () => {
  it("拒绝 .. 逃逸", () => {
    expect(() => resolveInWorkdir(workdir, "../outside.txt")).toThrow(/escapes/);
    expect(() => resolveInWorkdir(workdir, "a/../../outside.txt")).toThrow(/escapes/);
  });

  it("拒绝工作区外的绝对路径", () => {
    expect(() => resolveInWorkdir(workdir, "C:\\Windows\\system32\\x.txt")).toThrow(/escapes/);
  });

  it("接受工作区内的相对与嵌套路径", () => {
    expect(resolveInWorkdir(workdir, "a/b/c.txt")).toBe(path.resolve(workdir, "a/b/c.txt"));
  });
});

describe("write_file + read_file", () => {
  it("写入后可读回，自动创建父目录", async () => {
    const w = await writeFileTool.execute({ path: "nested/dir/out.txt", content: "你好 harness" }, ctx());
    expect(w.isError).toBeUndefined();
    expect(await readFile(path.join(workdir, "nested/dir/out.txt"), "utf8")).toBe("你好 harness");

    const r = await readFileTool.execute({ path: "nested/dir/out.txt" }, ctx());
    expect(r.content).toBe("你好 harness");
  });

  it("逃逸路径被拒绝（错误抛给 executor 收敛为 is_error）", async () => {
    await expect(
      writeFileTool.execute({ path: "../../evil.txt", content: "x" }, ctx()),
    ).rejects.toThrow(/escapes/);
  });
});

describe("truncate", () => {
  it("超限内容截断并标注", () => {
    const out = truncate("a".repeat(100), 10);
    expect(out).toContain("truncated 90 of 100 chars");
  });
});

describe("ToolRegistry", () => {
  it("toApiTools 按 name 排序（缓存前缀稳定）", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool({ name: "zeta" }));
    reg.register(makeTool({ name: "alpha" }));
    reg.register(makeTool({ name: "mid" }));
    expect(reg.toApiTools().map((t) => t.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("重复注册报错", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool({ name: "dup" }));
    expect(() => reg.register(makeTool({ name: "dup" }))).toThrow(/already registered/);
  });
});

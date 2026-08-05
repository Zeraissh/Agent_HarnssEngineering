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

describe("额外只读根（readRoots，案例 #5 催生）", () => {
  let readRoot: string;

  beforeAll(async () => {
    readRoot = await mkdtemp(path.join(tmpdir(), "harness-readroot-"));
    const w = await writeFileTool.execute(
      { path: "lib/part.kicad_sym", content: "(kicad_symbol_lib)" },
      { workdir: readRoot, toolUseId: "tu_seed", signal: new AbortController().signal },
    );
    expect(w.isError).toBeUndefined();
  });

  afterAll(async () => {
    await rm(readRoot, { recursive: true, force: true });
  });

  it("read_file 可用绝对路径读取只读根内的文件", async () => {
    const r = await readFileTool.execute(
      { path: path.join(readRoot, "lib/part.kicad_sym") },
      { ...ctx(), readRoots: [readRoot] },
    );
    expect(r.content).toBe("(kicad_symbol_lib)");
  });

  it("未配置只读根时,同一绝对路径仍被拒绝(错误提示不提根)", async () => {
    await expect(
      readFileTool.execute({ path: path.join(readRoot, "lib/part.kicad_sym") }, ctx()),
    ).rejects.toThrow(/escapes(?![\s\S]*read-only roots)/);
  });

  it("从只读根 .. 逃逸被拒绝,且错误提示列出可用根", async () => {
    await expect(
      readFileTool.execute(
        { path: path.join(readRoot, "..", "sibling.txt") },
        { ...ctx(), readRoots: [readRoot] },
      ),
    ).rejects.toThrow(/read-only roots/);
  });

  it("write_file 不受只读根影响——根内绝对路径仍被拒绝", async () => {
    await expect(
      writeFileTool.execute(
        { path: path.join(readRoot, "lib/hacked.txt"), content: "x" },
        { ...ctx(), readRoots: [readRoot] },
      ),
    ).rejects.toThrow(/escapes/);
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

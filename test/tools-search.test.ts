/**
 * A1 — `glob` / `grep` 的行为锁。
 *
 * 三类断言，按可靠性排序：
 * ① **可数事实**：命中哪些路径、哪些行、计数多少（不是"输出里有没有某个词"）；
 * ② **圈禁与 fail-closed**：越界、符号链接、凭据文件；
 * ③ **诚实性**：截断时必须说出来（静默截断 = 模型把半份结果当全量）。
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { globToRegExp, matchesGlob, scanFiles } from "../src/tools/fs-scan.js";
import { globTool } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";

let root: string;
let workdir: string;
let readRoot: string;

const ctx = (extra: { readRoots?: string[] } = {}) => ({
  workdir,
  toolUseId: "tu_search",
  signal: new AbortController().signal,
  ...extra,
});

async function put(rel: string, content: string): Promise<void> {
  const abs = path.join(workdir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "harness-search-"));
  workdir = path.join(root, "work");
  readRoot = path.join(root, "readonly");
  await mkdir(workdir, { recursive: true });
  await mkdir(readRoot, { recursive: true });
  await writeFile(path.join(readRoot, "lib.txt"), "read root marker\n", "utf8");
  await writeFile(path.join(root, "outside.txt"), "outside the workdir\n", "utf8");

  await put("src/alpha.ts", "export const alpha = 1;\nconst shared = 'alpha';\n");
  await put("src/beta.ts", "export const beta = 2;\nconst shared = 'beta';\n");
  await put("src/nested/deep.ts", "export const deep = 3;\n// shared marker\n");
  await put("src/notes.md", "# notes\nshared prose\n");
  await put("docs/guide.md", "# guide\nno marker here\n");
  await put("node_modules/pkg/index.ts", "export const shared = 'vendored';\n");
  await put(".git/config", "shared = git config\n");
  await put(".env", "SECRET_TOKEN=shared-secret\n");
  await put("data/blob.bin", `binary\u0000shared\u0000payload\n`);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("globToRegExp", () => {
  it("`**` 跨目录、`*` 不跨 `/`", () => {
    expect(matchesGlob("src/nested/deep.ts", "src/**/*.ts")).toBe(true);
    expect(matchesGlob("src/alpha.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/nested/deep.ts", "src/*.ts")).toBe(false);
  });

  it("不含 `/` 的 pattern 等价于任意深度", () => {
    expect(matchesGlob("src/nested/deep.ts", "*.ts")).toBe(true);
    expect(matchesGlob("deep.ts", "*.ts")).toBe(true);
  });

  it("花括号分支按字面翻译——不得被再补一次 `**/`", () => {
    // 这条是 translateGlob 与 globToRegExp 分家的原因：若分支走 globToRegExp，
    // "ts" 会被补成 "**/ts"，`*.{ts,md}` 当场全失配
    expect(matchesGlob("src/alpha.ts", "src/*.{ts,md}")).toBe(true);
    expect(matchesGlob("src/notes.md", "src/*.{ts,md}")).toBe(true);
    expect(matchesGlob("src/notes.txt", "src/*.{ts,md}")).toBe(false);
  });

  it("`?` 与字符类", () => {
    expect(matchesGlob("a1.ts", "a?.ts")).toBe(true);
    expect(matchesGlob("a12.ts", "a?.ts")).toBe(false);
    expect(matchesGlob("a1.ts", "a[0-9].ts")).toBe(true);
    expect(matchesGlob("ax.ts", "a[!0-9].ts")).toBe(true);
    expect(matchesGlob("a1.ts", "a[!0-9].ts")).toBe(false);
  });

  it("大小写敏感（跨平台同语义，不跟随 Windows 文件系统）", () => {
    expect(matchesGlob("README.MD", "*.md")).toBe(false);
    expect(matchesGlob("README.md", "*.md")).toBe(true);
  });

  it("元字符按字面处理，不当正则", () => {
    expect(globToRegExp("a+b.ts").test("a+b.ts")).toBe(true);
    expect(globToRegExp("a+b.ts").test("aab.ts")).toBe(false);
  });
});

describe("scanFiles", () => {
  it("缺省跳过 node_modules / .git 并把跳过的目录报出来", async () => {
    const scan = await scanFiles({ root: workdir });
    expect(scan.files).not.toContain("node_modules/pkg/index.ts");
    expect(scan.files).not.toContain(".git/config");
    expect(scan.skippedDirs.sort()).toEqual([".git", "node_modules"]);
  });

  it("include_ignored 打开后能进 node_modules", async () => {
    const scan = await scanFiles({ root: workdir, includeIgnored: true });
    expect(scan.files).toContain("node_modules/pkg/index.ts");
  });

  it("结果按路径字典序（不是 mtime）——可复现优先", async () => {
    const scan = await scanFiles({ root: workdir, match: (r) => r.endsWith(".ts") });
    expect(scan.files).toEqual([...scan.files].sort());
    expect(scan.files.slice(0, 3)).toEqual(["src/alpha.ts", "src/beta.ts", "src/nested/deep.ts"]);
  });

  it("撞上遍历上限时 scanTruncated=true（真话必须能转达）", async () => {
    const scan = await scanFiles({ root: workdir, maxEntries: 3 });
    expect(scan.scanTruncated).toBe(true);
  });
});

describe("glob 工具", () => {
  it("返回相对 POSIX 路径 + 命中数", async () => {
    const r = await globTool.execute({ pattern: "src/**/*.ts" }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("3 file(s) match");
    expect(r.content).toContain("src/alpha.ts");
    expect(r.content).toContain("src/nested/deep.ts");
    expect(r.content).not.toContain("notes.md");
  });

  it("limit 截断必须显式说明，不静默", async () => {
    const r = await globTool.execute({ pattern: "**/*.ts", limit: 1 }, ctx());
    expect(r.content).toContain("more paths not shown");
    expect(r.content).toContain("limit=1");
  });

  it("零命中不是错误，但要说清确实搜过", async () => {
    const r = await globTool.execute({ pattern: "**/*.rs" }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("No files match");
    expect(r.content).toContain("scanned");
  });

  it("path 越出工作目录 → is_error（圈禁）", async () => {
    const r = await globTool.execute({ pattern: "*.txt", path: ".." }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("escapes the working directory");
    expect(r.content).not.toContain("outside.txt");
  });

  it("配了只读根就能按绝对路径搜进去", async () => {
    const r = await globTool.execute({ pattern: "*.txt", path: readRoot }, ctx({ readRoots: [readRoot] }));
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("lib.txt");
  });

  it("缺 pattern → is_error", async () => {
    const r = await globTool.execute({}, ctx());
    expect(r.isError).toBe(true);
  });
});

describe("grep 工具", () => {
  it("content 模式给出 file:line:text，且不进 node_modules/.git", async () => {
    const r = await grepTool.execute({ pattern: "shared" }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("src/alpha.ts:2:const shared = 'alpha';");
    expect(r.content).toContain("src/beta.ts:2:const shared = 'beta';");
    expect(r.content).not.toContain("node_modules");
    expect(r.content).not.toContain(".git/config");
  });

  it("凭据文件与二进制文件不进结果（fail-closed + 噪声抑制）", async () => {
    const r = await grepTool.execute({ pattern: "shared" }, ctx());
    expect(r.content).not.toContain("SECRET_TOKEN");
    expect(r.content).not.toContain(".env");
    expect(r.content).not.toContain("data/blob.bin");
    expect(r.content).toContain("binary file(s) skipped");
  });

  it("显式指名凭据文件 → is_error 并指路审批门", async () => {
    const r = await grepTool.execute({ pattern: ".", path: ".env" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("credential-style");
    expect(r.content).not.toContain("SECRET_TOKEN");
  });

  it("glob 过滤只搜指定文件", async () => {
    const r = await grepTool.execute({ pattern: "shared", glob: "**/*.md" }, ctx());
    expect(r.content).toContain("src/notes.md:2:shared prose");
    expect(r.content).not.toContain("alpha.ts");
  });

  it("-i 大小写不敏感", async () => {
    const sensitive = await grepTool.execute({ pattern: "SHARED", glob: "src/*.ts" }, ctx());
    expect(sensitive.content).toContain("No matches");
    const insensitive = await grepTool.execute({ pattern: "SHARED", glob: "src/*.ts", "-i": true }, ctx());
    expect(insensitive.content).toContain("src/alpha.ts:2:");
  });

  it("-C 上下文行用 `-` 分隔，与命中行的 `:` 区分开", async () => {
    const r = await grepTool.execute({ pattern: "const shared", glob: "src/alpha.ts", "-C": 1 }, ctx());
    expect(r.content).toContain("src/alpha.ts-1-export const alpha = 1;");
    expect(r.content).toContain("src/alpha.ts:2:const shared = 'alpha';");
  });

  it("files_with_matches 模式只给路径", async () => {
    const r = await grepTool.execute({ pattern: "shared", output_mode: "files_with_matches" }, ctx());
    expect(r.content).toContain("src/alpha.ts");
    expect(r.content).not.toContain("const shared");
  });

  it("count 模式给逐文件计数", async () => {
    const r = await grepTool.execute({ pattern: "shared", glob: "src/*.ts", output_mode: "count" }, ctx());
    expect(r.content).toContain("src/alpha.ts:1");
    expect(r.content).toContain("src/beta.ts:1");
  });

  it("limit 截断说的是「至少」，并明说不得当作没有", async () => {
    const r = await grepTool.execute({ pattern: "shared", limit: 1 }, ctx());
    expect(r.content).toContain("at least");
    expect(r.content).toContain("do NOT assume the rest are absent");
  });

  it("非法正则 → is_error 且指出转义口径", async () => {
    const r = await grepTool.execute({ pattern: "(unclosed" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Invalid regular expression");
  });

  it("非法 output_mode → is_error 并列出合法值", async () => {
    const r = await grepTool.execute({ pattern: "shared", output_mode: "json" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("files_with_matches");
  });

  it("path 越界 → is_error（与 glob 同一条圈禁）", async () => {
    const r = await grepTool.execute({ pattern: "outside", path: "../outside.txt" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("escapes the working directory");
  });

  it("零命中不是错误，并给出下一步", async () => {
    const r = await grepTool.execute({ pattern: "zzz-not-present" }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("No matches");
    expect(r.content).toContain("check the regex escaping");
  });
});

describe("符号链接不跟随（圈禁 + 防目录环）", () => {
  it("workdir 里指向圈外的目录链接不进结果", async () => {
    const link = path.join(workdir, "escape-link");
    try {
      await symlink(root, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(code ?? "")) return; // 无权限建链接：跳过
      throw error;
    }
    try {
      const r = await globTool.execute({ pattern: "**/*.txt" }, ctx());
      expect(r.content).not.toContain("escape-link");
      expect(r.content).not.toContain("outside.txt");
    } finally {
      await rm(link, { recursive: true, force: true });
    }
  });
});

describe("工具契约（两个工具都必须满足）", () => {
  it("只读工具走 auto 权限且可并行——这正是相对 bash find/grep 的价值", () => {
    for (const tool of [globTool, grepTool]) {
      expect(tool.permission).toBe("auto");
      expect(tool.parallelSafe).toBe(true);
    }
  });

  it("schema 声明了 required 且描述里写清何时用", () => {
    expect(globTool.inputSchema.required).toEqual(["pattern"]);
    expect(grepTool.inputSchema.required).toEqual(["pattern"]);
    expect(globTool.description).toContain("no approval");
    expect(grepTool.description).toContain("no approval");
  });
});

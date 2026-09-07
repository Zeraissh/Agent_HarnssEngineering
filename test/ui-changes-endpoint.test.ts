/**
 * T8 变更审查端点契约测试——GET /api/runs/:id/changes。
 *
 * 全用注入的 FakeModelClient + 临时 history 根（手工摆 meta.json /
 * events.jsonl 档案）+ 临时 workdir（摆真实文件与真实 git 仓库），
 * 不碰真实历史、不需要 API key。
 *
 * 覆盖：
 *   a. run 不存在 → 404
 *   b. 无写盘事件 → 200 空列表
 *   c. 聚合：write_file / edit_file 同路径合并（ops / count / lastAt），
 *      非写盘工具（read_file / bash / memory_write）不计入
 *   d. 现状 stat：存在的文件带 sizeBytes / mtimeMs；写完被删 → exists=false
 *   e. 圈禁：../ 逃逸路径 → outOfScope: true，不 stat、不给 git 信息
 *   f. git 仓库：已跟踪修改 → M + +x/-y；未跟踪新文件 → ??；非仓库 → git:null
 *   g. 排序：lastAt 降序（最近触碰在前）
 *   h. 纯函数：collectTouchedPaths / parseGitPorcelainStatus / parseDiffStatSummary
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createUiServer,
  collectTouchedPaths,
  parseGitPorcelainStatus,
  parseDiffStatSummary,
  type UiServerHandle,
} from "../ui/server.js";
import { FakeModelClient } from "./helpers.js";

function startServer(handle: UiServerHandle): Promise<number> {
  return new Promise((resolve, reject) => {
    handle.server.listen(0, () => {
      const address = handle.server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("Could not get server port"));
    });
    handle.server.on("error", reject);
  });
}

interface ChangeDto {
  path: string;
  ops: string[];
  count: number;
  lastAt: number | null;
  outOfScope: boolean;
  exists: boolean;
  sizeBytes: number | null;
  mtimeMs: number | null;
  git: { status: string; added: number | null; deleted: number | null } | null;
}

interface ChangesResponseDto {
  runId: string;
  workdir: string;
  git: boolean;
  changes: ChangeDto[];
}

function metaShape(runId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    runId,
    task: "写文件任务",
    status: "done",
    verify: false,
    createdAt: 1_000,
    finishedAt: 2_000,
    packName: null,
    mode: "single",
    effort: null,
    rubric: null,
    workdir: null,
    conversationTurn: 1,
    planGate: false,
    planDecision: null,
    mainStopReason: "completed",
    outcome: null,
    ...overrides,
  };
}

/** 造一条 tool_call 事件包络（与 pushEvent 落盘形状一致：{ seq, source, ts, event }） */
function toolCall(seq: number, name: string, input: unknown, ts = 1_500 + seq): unknown {
  return { seq, source: "main", ts, event: { type: "tool_call", toolUseId: `tu_${seq}`, name, input } };
}

async function seedRun(
  root: string,
  runId: string,
  meta: Record<string, unknown>,
  events: unknown[] = [],
): Promise<void> {
  const dir = join(root, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), JSON.stringify(metaShape(runId, meta)), "utf8");
  const lines = events.map((e) => (typeof e === "string" ? e : JSON.stringify(e)));
  await writeFile(join(dir, "events.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

/** 环境有 git 才跑仓库分支断言；没有就降级路径已被 d/f 用例覆盖 */
function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("T8 /api/runs/:id/changes 变更审查端点", () => {
  let handle: UiServerHandle | undefined;
  let baseDir: string;
  let workdir: string;
  let historyRoot: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "ui-changes-api-"));
    workdir = join(baseDir, "proj");
    historyRoot = join(baseDir, "history");
    await mkdir(workdir, { recursive: true });
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    await rm(baseDir, { recursive: true, force: true });
  });

  async function boot(): Promise<string> {
    handle = createUiServer({
      modelClient: new FakeModelClient([]),
      tools: [],
      workdir,
      history: historyRoot,
      historyKeep: 10_000, // 防启动修剪删掉样本档案（同 T6 先例）
    });
    return `http://127.0.0.1:${await startServer(handle)}`;
  }

  it("a. run 不存在 → 404", async () => {
    const base = await boot();
    const res = await fetch(`${base}/api/runs/no-such-run/changes`);
    expect(res.status).toBe(404);
  });

  it("b. 无写盘事件的 run → 200 空列表", async () => {
    await seedRun(historyRoot, "run-readonly", { workdir }, [
      toolCall(0, "read_file", { path: "a.txt" }),
      toolCall(1, "bash", { command: "echo hi > sneaky.txt" }), // bash 写盘入参读不出路径，不计入
      { seq: 2, source: "main", ts: 1_502, event: { type: "text", text: "done" } },
    ]);
    const base = await boot();
    const res = await fetch(`${base}/api/runs/run-readonly/changes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChangesResponseDto;
    expect(body.runId).toBe("run-readonly");
    expect(body.changes).toEqual([]);
    expect(body.git).toBe(false); // 非 git 仓库
  });

  it("c. 聚合：同路径 write+edit 合并，ops/count/lastAt 正确，memory_write 不计入", async () => {
    await writeFile(join(workdir, "app.ts"), "export {}\n", "utf8");
    await seedRun(historyRoot, "run-writes", { workdir }, [
      toolCall(0, "write_file", { path: "app.ts", content: "v1" }, 1_600),
      toolCall(1, "read_file", { path: "app.ts" }, 1_601),
      toolCall(2, "edit_file", { path: "app.ts", old_string: "a", new_string: "b" }, 1_602),
      toolCall(3, "edit_file", { path: "app.ts", old_string: "c", new_string: "d" }, 1_603),
      toolCall(4, "memory_write", { name: "note.md", content: "x" }, 1_604),
      toolCall(5, "write_file", { path: "docs/new.md", content: "# n" }, 1_605),
    ]);
    const base = await boot();
    const res = await fetch(`${base}/api/runs/run-writes/changes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChangesResponseDto;
    expect(body.changes.map((c) => c.path).sort()).toEqual(["app.ts", "docs/new.md"]);

    const app = body.changes.find((c) => c.path === "app.ts")!;
    expect([...app.ops].sort()).toEqual(["edit", "write"]);
    expect(app.count).toBe(3);
    expect(app.lastAt).toBe(1_603);
  });

  it("d. 现状 stat：存在文件带大小与 mtime；写完被删 → exists=false", async () => {
    const content = "hello 世界\n";
    await writeFile(join(workdir, "kept.txt"), content, "utf8");
    await seedRun(historyRoot, "run-stat", { workdir }, [
      toolCall(0, "write_file", { path: "kept.txt", content }, 1_600),
      toolCall(1, "write_file", { path: "gone.txt", content: "x" }, 1_601), // 盘上并不存在
    ]);
    const base = await boot();
    const res = await fetch(`${base}/api/runs/run-stat/changes`);
    const body = (await res.json()) as ChangesResponseDto;

    const kept = body.changes.find((c) => c.path === "kept.txt")!;
    expect(kept.outOfScope).toBe(false);
    expect(kept.exists).toBe(true);
    expect(kept.sizeBytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(typeof kept.mtimeMs).toBe("number");
    expect(kept.mtimeMs!).toBeGreaterThan(0);
    expect(kept.git).toBeNull(); // 非仓库

    const gone = body.changes.find((c) => c.path === "gone.txt")!;
    expect(gone.outOfScope).toBe(false); // 圈内的"不存在"与"越界"是两回事
    expect(gone.exists).toBe(false);
    expect(gone.sizeBytes).toBeNull();
  });

  it("e. 圈禁：../ 逃逸路径 → outOfScope，不 stat、不给 git", async () => {
    // 圈外真有一个文件：若圈禁失效它会带着 exists=true 漏出来
    await writeFile(join(baseDir, "outside-secret.txt"), "secret\n", "utf8");
    await seedRun(historyRoot, "run-escape", { workdir }, [
      toolCall(0, "write_file", { path: "../outside-secret.txt", content: "pwn" }, 1_600),
      toolCall(1, "write_file", { path: "inside.txt", content: "ok" }, 1_601),
    ]);
    await writeFile(join(workdir, "inside.txt"), "ok\n", "utf8");
    const base = await boot();
    const res = await fetch(`${base}/api/runs/run-escape/changes`);
    const body = (await res.json()) as ChangesResponseDto;

    const outside = body.changes.find((c) => c.path.includes("outside-secret"))!;
    expect(outside.outOfScope).toBe(true);
    expect(outside.exists).toBe(false);
    expect(outside.sizeBytes).toBeNull();
    expect(outside.git).toBeNull();

    const inside = body.changes.find((c) => c.path === "inside.txt")!;
    expect(inside.outOfScope).toBe(false);
    expect(inside.exists).toBe(true);
  });

  it("f. git 仓库：已跟踪修改 → M 与 +x/-y；新文件 → ??；干净文件无徽章", async () => {
    if (!gitAvailable()) return; // 无 git 的环境降级路径已由 d 用例覆盖
    git(workdir, ["init"]);
    git(workdir, ["config", "user.email", "t@example.com"]);
    git(workdir, ["config", "user.name", "t"]);
    await writeFile(join(workdir, "tracked.txt"), "one\ntwo\nthree\n", "utf8");
    await writeFile(join(workdir, "clean.txt"), "clean\n", "utf8");
    git(workdir, ["add", "."]);
    git(workdir, ["commit", "-m", "init"]);
    // run 之后：tracked.txt 被改（+1/-1），untracked.txt 新建，clean.txt 被"写"但内容未变
    await writeFile(join(workdir, "tracked.txt"), "one\ntwo-changed\nthree\nfour\n", "utf8");
    await writeFile(join(workdir, "untracked.txt"), "brand new\n", "utf8");

    await seedRun(historyRoot, "run-git", { workdir }, [
      toolCall(0, "edit_file", { path: "tracked.txt" }, 1_600),
      toolCall(1, "write_file", { path: "untracked.txt", content: "brand new\n" }, 1_601),
      toolCall(2, "write_file", { path: "clean.txt", content: "clean\n" }, 1_602),
    ]);
    const base = await boot();
    const res = await fetch(`${base}/api/runs/run-git/changes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChangesResponseDto;
    expect(body.git).toBe(true);

    const tracked = body.changes.find((c) => c.path === "tracked.txt")!;
    expect(tracked.git).not.toBeNull();
    expect(tracked.git!.status).toBe("M");
    expect(tracked.git!.added).toBe(2); // two-changed + four 两行新增
    expect(tracked.git!.deleted).toBe(1); // two 一行删除

    const untracked = body.changes.find((c) => c.path === "untracked.txt")!;
    expect(untracked.git).not.toBeNull();
    expect(untracked.git!.status).toBe("??");
    expect(untracked.git!.added).toBeNull(); // 未跟踪没有 diff 可言

    const clean = body.changes.find((c) => c.path === "clean.txt")!;
    expect(clean.git).toBeNull(); // 内容未变 = 干净文件，不挂徽章
  });

  it("g. 排序：lastAt 降序（最近触碰在前）", async () => {
    await seedRun(historyRoot, "run-order", { workdir }, [
      toolCall(0, "write_file", { path: "first.txt", content: "1" }, 1_100),
      toolCall(1, "write_file", { path: "last.txt", content: "2" }, 1_900),
      toolCall(2, "write_file", { path: "mid.txt", content: "3" }, 1_500),
    ]);
    const base = await boot();
    const res = await fetch(`${base}/api/runs/run-order/changes`);
    const body = (await res.json()) as ChangesResponseDto;
    expect(body.changes.map((c) => c.path)).toEqual(["last.txt", "mid.txt", "first.txt"]);
  });
});

// ---------------------------------------------------------------
// 纯函数（导出供行为锁直接引用）
// ---------------------------------------------------------------
describe("collectTouchedPaths 事件聚合", () => {
  it("只收 write_file / edit_file 的字符串 path；同路径合并计数与 ops", () => {
    const out = collectTouchedPaths([
      toolCall(0, "write_file", { path: "a.txt", content: "x" }, 100),
      toolCall(1, "edit_file", { path: "a.txt" }, 200),
      toolCall(2, "read_file", { path: "a.txt" }, 300),
      toolCall(3, "write_file", { path: "  " }, 400), // 空路径丢弃
      toolCall(4, "write_file", { noPath: true }, 500), // 缺 path 丢弃
      { seq: 5, source: "main", ts: 600, event: { type: "text", text: "hi" } },
      "garbage-line", // 坏行不炸
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.input).toBe("a.txt");
    expect([...out[0]!.ops].sort()).toEqual(["edit", "write"]);
    expect(out[0]!.count).toBe(2);
    expect(out[0]!.lastAt).toBe(200);
  });

  it("事件无 ts 时 lastAt 保持 null 而不是污染成 NaN", () => {
    const out = collectTouchedPaths([
      { seq: 0, source: "main", event: { type: "tool_call", name: "write_file", input: { path: "x" } } },
    ]);
    expect(out[0]!.lastAt).toBeNull();
  });
});

describe("parseGitPorcelainStatus", () => {
  it("归一 M / A / D / ??；空行与畸形行返回 null", () => {
    expect(parseGitPorcelainStatus(" M src/a.ts")).toBe("M");
    expect(parseGitPorcelainStatus("M  src/a.ts")).toBe("M");
    expect(parseGitPorcelainStatus("A  src/new.ts")).toBe("A");
    expect(parseGitPorcelainStatus("AM src/new.ts")).toBe("A");
    expect(parseGitPorcelainStatus("?? src/u.ts")).toBe("??");
    expect(parseGitPorcelainStatus(" D src/gone.ts")).toBe("D");
    expect(parseGitPorcelainStatus("")).toBeNull();
    expect(parseGitPorcelainStatus(" ")).toBeNull();
  });
});

describe("parseDiffStatSummary", () => {
  it("解析汇总行的增删数；无 changed 行 → 全 null", () => {
    expect(parseDiffStatSummary(" a.txt | 5 ++---\n 1 file changed, 2 insertions(+), 3 deletions(-)"))
      .toEqual({ added: 2, deleted: 3 });
    // 纯新增 / 纯删除缺另一侧
    expect(parseDiffStatSummary(" 1 file changed, 4 insertions(+)")).toEqual({ added: 4, deleted: 0 });
    expect(parseDiffStatSummary(" 1 file changed, 1 deletion(-)")).toEqual({ added: 0, deleted: 1 });
    expect(parseDiffStatSummary("")).toEqual({ added: null, deleted: null });
    expect(parseDiffStatSummary("nothing here")).toEqual({ added: null, deleted: null });
  });
});

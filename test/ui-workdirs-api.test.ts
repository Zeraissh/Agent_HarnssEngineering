/**
 * /api/workdirs + /api/fs/list 端点契约测试（V-29 运行时白名单扩展）——
 * 全用注入的 FakeModelClient + 临时 workdirStoreFile，不碰真实配置。
 *
 * 覆盖：
 *   a. GET /api/workdirs：env / stored 来源分列，启动时 = env 白名单 ∪ 持久化清单
 *   b. POST 校验：相对路径 400 / 不存在 404 / 是文件 400 / 缺 path 400
 *   c. POST 幂等：已在集合 → 200 added:false；新目录 → 200 added:true 且
 *      立刻可用来建 run（白名单是活集合，不用重启）
 *   d. DELETE 边界：env 声明 403 / 未知 404 / 在飞 run 占用 409 / 空闲 stored 200
 *   e. /api/fs/list：path 省略给常用起点；只列目录不列文件；隐藏目录不列；
 *      上级导航 parent 正确；不存在 404 / 是文件 400
 *   f. loopback 门：非 loopback Host 一律 403（四个端点）
 *   g. 持久化 round-trip：第二个宿主实例从同一文件读到运行时添加的目录；
 *      坏文件 → .bak 容错
 *   h. Content-Type 门禁：POST 非 JSON → 415
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createUiServer, type UiServerHandle } from "../ui/server.js";
import { mergeRunReadRoots, mergeRunWriteRoots, parseExtraWorkdirs } from "../ui/workdirs.js";
import { resetObservabilityMetrics } from "../src/metrics.js";
import { clearCapabilityCache } from "../src/model-capability.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock, toolUseBlock } from "./helpers.js";

// ------------------------------------------------------
// Helpers
// ------------------------------------------------------

let handle: UiServerHandle | undefined;
let tempDirs: string[] = [];

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs = [];
  resetObservabilityMetrics();
  clearCapabilityCache();
});

async function startServer(): Promise<string> {
  const port = await new Promise<number>((resolve, reject) => {
    handle!.server.listen(0, () => {
      const addr = handle!.server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("no address"));
    });
  });
  return `http://127.0.0.1:${port}`;
}

async function makeHost(opts: {
  workdir?: string;
  workdirs?: string[];
  storeFile?: string | null;
  allowedHosts?: string[];
  designDraftsDir?: string;
  script?: import("@anthropic-ai/sdk").default.Message[];
  tools?: import("../src/types.js").Tool[];
} = {}): Promise<{ base: string; hostWorkdir: string; storeFile: string; draftsDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "workdirs-api-"));
  tempDirs.push(dir);
  const hostWorkdir = resolve(opts.workdir ?? dir);
  const storeFile = opts.storeFile === undefined ? join(dir, ".agent-workdirs.json") : opts.storeFile;
  const draftsDir = resolve(opts.designDraftsDir ?? join(dir, "injected-drafts"));
  handle = createUiServer({
    modelClient: new FakeModelClient(opts.script ?? [fakeMessage([textBlock("ok")], "end_turn")]),
    tools: opts.tools ?? [makeTool({ name: "noop", permission: "auto", parallelSafe: true })],
    workdir: hostWorkdir,
    ...(opts.workdirs ? { workdirs: opts.workdirs } : {}),
    workdirStoreFile: storeFile,
    designDraftsDir: draftsDir,
    ...(opts.allowedHosts ? { allowedHosts: opts.allowedHosts } : {}),
  });
  return { base: await startServer(), hostWorkdir, storeFile: storeFile ?? "", draftsDir };
}

function postWorkdir(base: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/workdirs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function deleteWorkdir(base: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/workdirs`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function waitForStatus(base: string, runId: string, status: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const list = await (await fetch(`${base}/api/runs`)).json() as { runId: string; status: string }[];
    if (list.find((r) => r.runId === runId)?.status === status) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Run ${runId} did not reach ${status} in time`);
}

describe("parseExtraWorkdirs / mergeRunReadRoots", () => {
  const allowed = ["D:\\a", "D:\\b", "D:\\c"];

  it("缺省 / 主目录自身 / 重复项都收成干净列表", () => {
    expect(parseExtraWorkdirs(undefined, allowed, "D:\\a")).toEqual({ ok: true, extraWorkdirs: [] });
    expect(parseExtraWorkdirs(["D:\\a", "D:\\b", "D:\\b"], allowed, "D:\\a")).toEqual({
      ok: true,
      extraWorkdirs: [resolve("D:\\b")],
    });
  });

  it("越白名单或非数组失败，不静默丢掉", () => {
    expect(parseExtraWorkdirs("D:\\b", allowed, "D:\\a").ok).toBe(false);
    expect(parseExtraWorkdirs(["D:\\nope"], allowed, "D:\\a").ok).toBe(false);
  });

  it("合并只读根时去掉主目录并去重", () => {
    expect(mergeRunReadRoots(["D:\\refs", "D:\\a"], ["D:\\b", "D:\\refs"], "D:\\a")).toEqual([
      resolve("D:\\refs"),
      resolve("D:\\b"),
    ]);
  });

  it("可写根只含勾选 extras，不含白名单整表", () => {
    expect(mergeRunWriteRoots([], "D:\\a")).toEqual([]);
    expect(mergeRunWriteRoots(undefined, "D:\\a")).toEqual([]);
    expect(mergeRunWriteRoots(["D:\\b", "D:\\a"], "D:\\a")).toEqual([resolve("D:\\b")]);
    expect(mergeRunWriteRoots(["D:\\b", "D:\\c"], "D:\\a")).toEqual([
      resolve("D:\\b"),
      resolve("D:\\c"),
    ]);
  });
});

// ------------------------------------------------------
// GET /api/workdirs
// ------------------------------------------------------

describe("GET /api/workdirs", () => {
  it("启动时 = 宿主 workdir + env 白名单，stored 为空", async () => {
    const extra = await mkdtemp(join(tmpdir(), "workdirs-env-"));
    tempDirs.push(extra);
    const { base, hostWorkdir } = await makeHost({ workdirs: [extra] });
    const res = await fetch(`${base}/api/workdirs`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.workdirs).toEqual([hostWorkdir, resolve(extra)]);
    expect(body.source.env).toEqual([hostWorkdir, resolve(extra)]);
    expect(body.source.stored).toEqual([]);
  });
});

// ------------------------------------------------------
// POST /api/workdirs
// ------------------------------------------------------

describe("POST /api/workdirs 校验", () => {
  it("相对路径 → 400", async () => {
    const { base } = await makeHost();
    const res = await postWorkdir(base, { path: "relative/dir" });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toContain("绝对路径");
  });

  it("不存在 → 404", async () => {
    const { base, hostWorkdir } = await makeHost();
    const res = await postWorkdir(base, { path: join(hostWorkdir, "no-such-dir") });
    expect(res.status).toBe(404);
    expect((await res.json() as any).error).toContain("不存在");
  });

  it("是文件不是目录 → 400", async () => {
    const { base, hostWorkdir } = await makeHost();
    const file = join(hostWorkdir, "a-file.txt");
    await writeFile(file, "x");
    const res = await postWorkdir(base, { path: file });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toContain("不是目录");
  });

  it("缺 path / 空 path → 400", async () => {
    const { base } = await makeHost();
    expect((await postWorkdir(base, {})).status).toBe(400);
    expect((await postWorkdir(base, { path: "  " })).status).toBe(400);
  });

  it("非 JSON Content-Type → 415", async () => {
    const { base, hostWorkdir } = await makeHost();
    const res = await fetch(`${base}/api/workdirs`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ path: hostWorkdir }),
    });
    expect(res.status).toBe(415);
  });

  it("新目录 → 200 added:true，落进 stored，且立刻可用来建 run", async () => {
    const { base } = await makeHost();
    const target = await mkdtemp(join(tmpdir(), "workdirs-add-"));
    tempDirs.push(target);

    const res = await postWorkdir(base, { path: target });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.added).toBe(true);
    expect(body.workdirs).toContain(resolve(target));
    expect(body.source.stored).toEqual([resolve(target)]);

    // 快照立即反映（前端 composer 下拉的数据源）
    const snap = await (await fetch(`${base}/api/harness`)).json() as any;
    expect(snap.availableWorkdirs).toContain(resolve(target));

    // 白名单是活集合：新目录不用重启就能建 run
    const run = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "t", workdir: resolve(target) }),
    });
    expect(run.status).toBe(200);
    const { runId } = await run.json() as any;
    await waitForStatus(base, runId, "done");
  });

  it("幂等：已在集合（env 或 stored）→ 200 added:false，stored 不重复记", async () => {
    const { base, hostWorkdir } = await makeHost();
    // env 声明的宿主 workdir
    const resEnv = await postWorkdir(base, { path: hostWorkdir });
    expect(resEnv.status).toBe(200);
    expect((await resEnv.json() as any).added).toBe(false);

    const target = await mkdtemp(join(tmpdir(), "workdirs-idem-"));
    tempDirs.push(target);
    await postWorkdir(base, { path: target });
    const resAgain = await postWorkdir(base, { path: target });
    expect((await resAgain.json() as any).added).toBe(false);
    const list = await (await fetch(`${base}/api/workdirs`)).json() as any;
    expect(list.source.stored.filter((d: string) => d === resolve(target))).toHaveLength(1);
  });
});

// ------------------------------------------------------
// DELETE /api/workdirs
// ------------------------------------------------------

describe("DELETE /api/workdirs", () => {
  it("env 声明的目录（含默认 workdir）→ 403，文案说清来源", async () => {
    const extra = await mkdtemp(join(tmpdir(), "workdirs-envdel-"));
    tempDirs.push(extra);
    const { base, hostWorkdir } = await makeHost({ workdirs: [extra] });
    for (const target of [hostWorkdir, resolve(extra)]) {
      const res = await deleteWorkdir(base, { path: target });
      expect(res.status).toBe(403);
      expect((await res.json() as any).error).toContain("启动时声明");
    }
  });

  it("不在运行时列表里 → 404", async () => {
    const { base } = await makeHost();
    const target = await mkdtemp(join(tmpdir(), "workdirs-unknown-"));
    tempDirs.push(target);
    const res = await deleteWorkdir(base, { path: target });
    expect(res.status).toBe(404);
  });

  it("空闲的 stored 目录 → 200 removed，列表与持久化同步", async () => {
    const { base, storeFile } = await makeHost();
    const target = await mkdtemp(join(tmpdir(), "workdirs-rm-"));
    tempDirs.push(target);
    await postWorkdir(base, { path: target });

    const res = await deleteWorkdir(base, { path: resolve(target) });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.removed).toBe(true);
    expect(body.workdirs).not.toContain(resolve(target));

    const persisted = JSON.parse(await readFile(storeFile, "utf8"));
    expect(persisted.workdirs).toEqual([]);
  });

  it("在飞 run 正在用 → 409；跑完后 → 200", async () => {
    let releaseTool: (() => void) | null = null;
    const blockingTool = makeTool({
      name: "block",
      permission: "auto",
      parallelSafe: true,
      execute: () => new Promise((resolveTool) => {
        releaseTool = () => resolveTool({ content: "done" });
      }),
    });
    const { base } = await makeHost({
      script: [
        fakeMessage([toolUseBlock("t1", "block", {})], "tool_use"),
        fakeMessage([textBlock("ok")], "end_turn"),
      ],
      tools: [blockingTool],
    });
    const target = await mkdtemp(join(tmpdir(), "workdirs-inflight-"));
    tempDirs.push(target);
    await postWorkdir(base, { path: target });

    const run = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "t", workdir: resolve(target) }),
    });
    const { runId } = await run.json() as any;
    await waitForStatus(base, runId, "running");

    const denied = await deleteWorkdir(base, { path: resolve(target) });
    expect(denied.status).toBe(409);
    expect((await denied.json() as any).error).toContain("正在运行");

    const latch = Date.now() + 15_000;
    while (!releaseTool && Date.now() < latch) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(releaseTool).toEqual(expect.any(Function));
    (releaseTool as unknown as () => void)();
    await waitForStatus(base, runId, "done");
    const ok = await deleteWorkdir(base, { path: resolve(target) });
    expect(ok.status).toBe(200);
  });
});

// ------------------------------------------------------
// GET /api/fs/list
// ------------------------------------------------------

describe("GET /api/fs/list", () => {
  it("path 省略 → 常用起点（含宿主工作目录），path/parent 为 null", async () => {
    const { base, hostWorkdir } = await makeHost();
    const res = await fetch(`${base}/api/fs/list`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.path).toBeNull();
    expect(body.parent).toBeNull();
    expect(body.separator).toBe(sep);
    expect(body.dirs.map((d: any) => d.path)).toContain(hostWorkdir);
  });

  it("只列目录不列文件；.开头隐藏目录不列；parent 正确", async () => {
    const { base } = await makeHost();
    const root = await mkdtemp(join(tmpdir(), "workdirs-fs-"));
    tempDirs.push(root);
    await mkdir(join(root, "bravo"));
    await mkdir(join(root, "alpha"));
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, "file.txt"), "x");

    const res = await fetch(`${base}/api/fs/list?path=${encodeURIComponent(root)}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.path).toBe(resolve(root));
    expect(body.parent).toBe(resolve(join(root, "..")));
    const names = body.dirs.map((d: any) => d.name);
    expect(names).toEqual(["alpha", "bravo"]); // 排序；隐藏与文件都不在
    expect(body.dirs[0].path).toBe(resolve(join(root, "alpha")));
  });

  it("子目录的上级 = 父目录；根的 parent 为 null", async () => {
    const { base } = await makeHost();
    const root = await mkdtemp(join(tmpdir(), "workdirs-nav-"));
    tempDirs.push(root);
    await mkdir(join(root, "sub"));
    const sub = await (await fetch(`${base}/api/fs/list?path=${encodeURIComponent(join(root, "sub"))}`)).json() as any;
    expect(sub.parent).toBe(resolve(root));
    const top = await (await fetch(`${base}/api/fs/list?path=${encodeURIComponent(resolve(sep))}`)).json() as any;
    expect(top.parent).toBeNull();
  });

  it("POST /api/fs/mkdir 在当前目录下建文件夹", async () => {
    const { base } = await makeHost();
    const root = await mkdtemp(join(tmpdir(), "workdirs-mkdir-"));
    tempDirs.push(root);
    const created = await fetch(`${base}/api/fs/mkdir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: root, name: "fresh" }),
    });
    expect(created.status).toBe(200);
    const body = await created.json() as any;
    expect(body.path).toBe(resolve(join(root, "fresh")));
    const listed = await (await fetch(`${base}/api/fs/list?path=${encodeURIComponent(root)}`)).json() as any;
    expect(listed.dirs.map((d: any) => d.name)).toContain("fresh");
    const bad = await fetch(`${base}/api/fs/mkdir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: root, name: ".." }),
    });
    expect(bad.status).toBe(400);
  });

  it("不存在 → 404；是文件 → 400", async () => {
    const { base, hostWorkdir } = await makeHost();
    expect((await fetch(`${base}/api/fs/list?path=${encodeURIComponent(join(hostWorkdir, "nope"))}`)).status).toBe(404);
    const file = join(hostWorkdir, "f.txt");
    await writeFile(file, "x");
    expect((await fetch(`${base}/api/fs/list?path=${encodeURIComponent(file)}`)).status).toBe(400);
  });
});

describe("GET /api/workspace/files", () => {
  it("圈禁内浅列文件，不列凭据；圈外 403", async () => {
    const { base, hostWorkdir } = await makeHost();
    await writeFile(join(hostWorkdir, "hello.txt"), "x");
    await writeFile(join(hostWorkdir, ".env"), "SECRET=1");
    await mkdir(join(hostWorkdir, "src"));

    const res = await fetch(`${base}/api/workspace/files?workdir=${encodeURIComponent(hostWorkdir)}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { files: Array<{ name: string; relative: string; kind: string }> };
    const names = body.files.map((f) => f.name);
    expect(names).toContain("hello.txt");
    expect(names).toContain("src");
    expect(names).not.toContain(".env");

    const q = await fetch(`${base}/api/workspace/files?workdir=${encodeURIComponent(hostWorkdir)}&q=hel`);
    expect(((await q.json()) as any).files.map((f: any) => f.relative)).toEqual(["hello.txt"]);

    await mkdir(join(hostWorkdir, "src", "nested"), { recursive: true });
    await writeFile(join(hostWorkdir, "src", "nested", "app.js"), "x");
    const deep = await fetch(`${base}/api/workspace/files?workdir=${encodeURIComponent(hostWorkdir)}&q=app`);
    expect(((await deep.json()) as any).files.map((f: any) => f.relative)).toEqual(["src/nested/app.js"]);

    const outside = await fetch(`${base}/api/workspace/files?workdir=${encodeURIComponent(join(hostWorkdir, ".."))}`);
    expect(outside.status).toBe(403);
  });
});

// ------------------------------------------------------
// loopback 门：非 loopback Host 一律 403
// ------------------------------------------------------

describe("loopback 门", () => {
  /**
   * undici 的 fetch 会按 Fetch 规范丢弃禁头 Host，所以这里用 node:http
   * 裸发请求，Host: example.com 才能真正到服务端。
   */
  async function rawRequest(
    base: string,
    method: string,
    path: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: any }> {
    const { request } = await import("node:http");
    return new Promise((resolvePromise, reject) => {
      // 显式 Content-Length：裸写 body 不给长度的话，llhttp 会把那两个字节
      // 当成下一条请求的开头，回一个无体的 400（真踩过）
      const payload = method === "GET" ? null : "{}";
      const req = request(`${base}${path}`, {
        method,
        headers: payload ? { ...headers, "Content-Length": String(payload.length) } : headers,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: any = null;
          try { body = JSON.parse(text); } catch { /* 非 JSON */ }
          resolvePromise({ status: res.statusCode ?? 0, body });
        });
      });
      req.on("error", reject);
      req.end(payload ?? undefined);
    });
  }

  it("工作目录管理端点对非 loopback Host 一律 403", async () => {
    const { base } = await makeHost({ allowedHosts: ["example.com"] });
    const remote = { Host: "example.com", "Content-Type": "application/json" };
    const get = await rawRequest(base, "GET", "/api/workdirs", remote);
    expect(get.status).toBe(403);
    expect(get.body.error).toContain("loopback");
    expect((await rawRequest(base, "POST", "/api/workdirs", remote)).status).toBe(403);
    expect((await rawRequest(base, "DELETE", "/api/workdirs", remote)).status).toBe(403);
    expect((await rawRequest(base, "GET", "/api/fs/list", remote)).status).toBe(403);
    expect((await rawRequest(base, "POST", "/api/fs/mkdir", remote)).status).toBe(403);
    expect((await rawRequest(base, "POST", "/api/design-drafts-workdir", remote)).status).toBe(403);
  });
});

// ------------------------------------------------------
// 持久化 round-trip
// ------------------------------------------------------

describe("持久化", () => {
  it("第二个宿主实例从同一文件读到运行时添加的目录（重启生效）", async () => {
    const first = await makeHost();
    const target = await mkdtemp(join(tmpdir(), "workdirs-persist-"));
    tempDirs.push(target);
    await postWorkdir(first.base, { path: target });
    const raw = JSON.parse(await readFile(first.storeFile, "utf8"));
    expect(raw.schemaVersion).toBe(1);
    expect(raw.workdirs).toEqual([resolve(target)]);
    await handle?.close();
    handle = undefined;

    // 同一个 storeFile、换一个宿主 workdir 再起一个实例
    const second = await makeHost({ storeFile: first.storeFile });
    const list = await (await fetch(`${second.base}/api/workdirs`)).json() as any;
    expect(list.source.stored).toEqual([resolve(target)]);
    expect(list.workdirs).toContain(resolve(target));
    const snap = await (await fetch(`${second.base}/api/harness`)).json() as any;
    expect(snap.availableWorkdirs).toContain(resolve(target));
  });

  it("坏文件 → 备份 .bak 后从零开始，不挡启动", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workdirs-corrupt-"));
    tempDirs.push(dir);
    const storeFile = join(dir, ".agent-workdirs.json");
    await writeFile(storeFile, "{ 半截 json", "utf8");
    const { base } = await makeHost({ workdir: dir, storeFile });
    const list = await (await fetch(`${base}/api/workdirs`)).json() as any;
    expect(list.source.stored).toEqual([]);
    // .bak 留档
    await stat(`${storeFile}.bak`);
  });
});

// ------------------------------------------------------
// POST /api/design-drafts-workdir
// ------------------------------------------------------

function postDesignDrafts(base: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/design-drafts-workdir`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/design-drafts-workdir", () => {
  it("GET /api/harness 报稿目录但不建目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "design-drafts-snap-"));
    tempDirs.push(root);
    const hostWorkdir = join(root, "Agent_Design");
    const draftsDir = join(root, "Fathom");
    await mkdir(hostWorkdir);
    await writeFile(join(hostWorkdir, "package.json"), JSON.stringify({ name: "agent-harness" }));
    const { base } = await makeHost({ workdir: hostWorkdir, designDraftsDir: draftsDir });
    const snap = await (await fetch(`${base}/api/harness`)).json() as any;
    expect(snap.designMode.draftsWorkdir).toBe(resolve(draftsDir));
    expect(snap.designMode.hostWorkdirIsHarness).toBe(true);
    await expect(stat(draftsDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("当前是宿主仓库 → 建目录、加入白名单、不切走", async () => {
    const root = await mkdtemp(join(tmpdir(), "design-drafts-host-"));
    tempDirs.push(root);
    const hostWorkdir = join(root, "Agent_Design");
    const draftsDir = join(root, "Fathom");
    await mkdir(hostWorkdir);
    await writeFile(join(hostWorkdir, "package.json"), JSON.stringify({ name: "agent-harness" }));
    const { base, storeFile } = await makeHost({ workdir: hostWorkdir, designDraftsDir: draftsDir });

    const res = await postDesignDrafts(base, { currentWorkdir: hostWorkdir });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.select).toBe(false);
    expect(body.reason).toBe("host-repo");
    expect(body.added).toBe(true);
    expect(body.workdir).toBe(resolve(draftsDir));
    expect(body.workdirs).toContain(resolve(draftsDir));
    expect((await stat(draftsDir)).isDirectory()).toBe(true);

    const stored = JSON.parse(await readFile(storeFile, "utf8"));
    expect(stored.workdirs).toContain(resolve(draftsDir));

    const again = await postDesignDrafts(base, { currentWorkdir: draftsDir });
    expect(again.status).toBe(200);
    const second = await again.json() as any;
    expect(second.added).toBe(false);
    expect(second.select).toBe(false);
    expect(second.reason).toBe("already-drafts");
  });

  it("用户已选别的目录 → 仍建稿目录但不抢选择", async () => {
    const campaign = await mkdtemp(join(tmpdir(), "design-drafts-campaign-"));
    tempDirs.push(campaign);
    const drafts = await mkdtemp(join(tmpdir(), "design-drafts-keep-"));
    tempDirs.push(drafts);
    await rm(drafts, { recursive: true, force: true });
    const { base, draftsDir } = await makeHost({
      workdirs: [campaign],
      designDraftsDir: drafts,
    });

    const res = await postDesignDrafts(base, { currentWorkdir: campaign });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.select).toBe(false);
    expect(body.reason).toBe("custom");
    expect(body.workdir).toBe(resolve(draftsDir));
    expect(body.workdirs).toContain(resolve(campaign));
    expect(body.workdirs).toContain(resolve(draftsDir));
    expect((await stat(draftsDir)).isDirectory()).toBe(true);
  });

  it("非 JSON Content-Type → 415，且不建目录", async () => {
    const { base, draftsDir } = await makeHost();
    const wrongType = await fetch(`${base}/api/design-drafts-workdir`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(wrongType.status).toBe(415);
    await expect(stat(draftsDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

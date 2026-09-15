/**
 * /api/workspace/git/pr：白名单 workdir、无令牌人话失败、成功走注入 runner。
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createUiServer, type UiServerHandle } from "../ui/server.js";
import { resetObservabilityMetrics } from "../src/metrics.js";
import { clearCapabilityCache } from "../src/model-capability.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock } from "./helpers.js";
import type { CommandSpec } from "../ui/github-pr.js";

const execFileAsync = promisify(execFile);
const TOKEN = "ghs_test_token_value_xxxxxxxx";

let handle: UiServerHandle | undefined;
let temps: string[] = [];

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
  temps = [];
  resetObservabilityMetrics();
  clearCapabilityCache();
});

async function gitRepo(onFeature = false): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ws-git-pr-"));
  temps.push(dir);
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "t@t.test"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "hi\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
  await execFileAsync("git", ["branch", "feature"], { cwd: dir });
  await execFileAsync(
    "git",
    ["remote", "add", "origin", "https://user:ghp_secret@github.com/acme/app.git"],
    { cwd: dir },
  );
  if (onFeature) {
    await execFileAsync("git", ["switch", "--", "feature"], { cwd: dir });
  }
  return resolve(dir);
}

async function startHost(
  workdir: string,
  extra: Parameters<typeof createUiServer>[0] = {},
): Promise<string> {
  handle = createUiServer({
    modelClient: new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]),
    tools: [makeTool({ name: "noop", permission: "auto", parallelSafe: true })],
    workdir,
    githubPrEnv: {},
    ...extra,
  });
  const port = await new Promise<number>((ok, fail) => {
    handle!.server.listen(0, () => {
      const addr = handle!.server.address();
      if (addr && typeof addr === "object") ok(addr.port);
      else fail(new Error("no address"));
    });
  });
  return `http://127.0.0.1:${port}`;
}

async function rawRequest(
  base: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  payload: string | null = null,
): Promise<{ status: number; body: any }> {
  const { request } = await import("node:http");
  return new Promise((resolvePromise, reject) => {
    const req = request(`${base}${path}`, {
      method,
      headers: payload
        ? { ...headers, "Content-Length": String(Buffer.byteLength(payload)) }
        : headers,
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

describe("/api/workspace/git/pr", () => {
  it("缺 workdir → 400；不在白名单 → 403；非仓库人话失败", async () => {
    const empty = await mkdtemp(join(tmpdir(), "ws-pr-empty-"));
    temps.push(empty);
    const base = await startHost(resolve(empty));
    expect((await fetch(`${base}/api/workspace/git/pr`)).status).toBe(400);
    expect((await fetch(`${base}/api/workspace/git/pr?workdir=${encodeURIComponent(resolve(tmpdir()))}`)).status)
      .toBe(403);
    const body = await (await fetch(`${base}/api/workspace/git/pr?workdir=${encodeURIComponent(resolve(empty))}`)).json();
    expect(body.ready).toBe(false);
    expect(body.error).toContain("不是 git 仓库");
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("无令牌：GET/POST 都是人话失败，不装成已开 PR", async () => {
    const repo = await gitRepo(true);
    const calls: CommandSpec[] = [];
    const base = await startHost(repo, {
      githubPrEnv: {},
      githubPrRunner: async (spec) => {
        calls.push(spec);
        return { stdout: "https://github.com/acme/app/pull/9\n", stderr: "", code: 0 };
      },
    });
    const ready = await (await fetch(`${base}/api/workspace/git/pr?workdir=${encodeURIComponent(repo)}`)).json();
    expect(ready.ready).toBe(false);
    expect(ready.code).toBe("no_token");
    expect(ready.error).toMatch(/GITHUB_TOKEN|GH_TOKEN|AGENT_GITHUB_TOKEN/);
    expect(ready.url).toBeUndefined();

    const created = await fetch(`${base}/api/workspace/git/pr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workdir: repo, title: "should not open" }),
    });
    expect(created.status).toBe(409);
    const fail = await created.json();
    expect(fail.error).toMatch(/令牌/);
    expect(fail.url).toBeUndefined();
    expect(calls.filter((c) => c.file === "gh")).toEqual([]);
    expect(JSON.stringify(fail)).not.toContain("ghp_secret");
  });

  it("无远程：人话失败", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-pr-noremote-"));
    temps.push(dir);
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "t@t.test"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: dir });
    await writeFile(join(dir, "README.md"), "hi\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
    const repo = resolve(dir);
    const base = await startHost(repo, { githubPrEnv: { GH_TOKEN: TOKEN } });
    const ready = await (await fetch(`${base}/api/workspace/git/pr?workdir=${encodeURIComponent(repo)}`)).json();
    expect(ready.ready).toBe(false);
    expect(ready.code).toBe("no_remote");
    expect(ready.error).toContain("远程");
  });

  it("成功：注入 runner，不真打 GitHub；命令是参数数组", async () => {
    const repo = await gitRepo(true);
    const calls: CommandSpec[] = [];
    const base = await startHost(repo, {
      githubPrEnv: { GH_TOKEN: TOKEN },
      githubPrRunner: async (spec) => {
        calls.push(spec);
        if (spec.file === "gh") {
          return { stdout: `https://github.com/acme/app/pull/18\n`, stderr: "", code: 0 };
        }
        if (spec.args.includes("symbolic-ref")) {
          return { stdout: "origin/main\n", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
    });
    const created = await fetch(`${base}/api/workspace/git/pr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workdir: repo,
        title: "fix; echo pwned",
        body: "bit12",
      }),
    });
    expect(created.status).toBe(200);
    const body = await created.json();
    expect(body.url).toBe("https://github.com/acme/app/pull/18");
    expect(body.head).toBe("feature");
    expect(body.base).toBe("main");
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(JSON.stringify(body)).not.toContain("ghp_secret");

    const gh = calls.find((c) => c.file === "gh");
    expect(gh).toBeDefined();
    expect(Array.isArray(gh!.args)).toBe(true);
    expect(gh!.args).toContain("fix; echo pwned");
    expect(gh!.args).toContain("--title");
    expect(typeof gh!.args).not.toBe("string");
    expect(gh!.cwd).toBe(repo);
    expect(JSON.stringify(gh!.args)).not.toContain(TOKEN);
  });

  it("非 loopback Host 开 PR → 403", async () => {
    const repo = await gitRepo(true);
    handle = createUiServer({
      modelClient: new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]),
      tools: [makeTool({ name: "noop", permission: "auto", parallelSafe: true })],
      workdir: repo,
      allowedHosts: ["example.com"],
      githubPrEnv: { GH_TOKEN: TOKEN },
    });
    const port = await new Promise<number>((ok, fail) => {
      handle!.server.listen(0, () => {
        const addr = handle!.server.address();
        if (addr && typeof addr === "object") ok(addr.port);
        else fail(new Error("no address"));
      });
    });
    const remote = await rawRequest(
      `http://127.0.0.1:${port}`,
      "POST",
      "/api/workspace/git/pr",
      { Host: "example.com", "Content-Type": "application/json" },
      JSON.stringify({ workdir: repo, title: "nope" }),
    );
    expect(remote.status).toBe(403);
    expect(remote.body.error).toContain("loopback");
    expect(remote.body.url).toBeUndefined();
  });
});

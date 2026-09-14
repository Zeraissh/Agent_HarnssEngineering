/**
 * /api/projects 契约——注入 FakeModelClient，缺省不碰操作员真实项目文件。
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createUiServer, type UiServerHandle } from "../ui/server.js";
import { PROJECTS_FILENAME, PROJECTS_SCHEMA_VERSION } from "../ui/projects.js";
import { resetObservabilityMetrics } from "../src/metrics.js";
import { clearCapabilityCache } from "../src/model-capability.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock } from "./helpers.js";

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
  const port = await new Promise<number>((resolvePort, reject) => {
    handle!.server.listen(0, () => {
      const addr = handle!.server.address();
      if (addr && typeof addr === "object") resolvePort(addr.port);
      else reject(new Error("no address"));
    });
  });
  return `http://127.0.0.1:${port}`;
}

async function makeHost(opts: {
  workdir?: string;
  workdirs?: string[];
  projectsStoreFile?: string | null;
  allowedHosts?: string[];
} = {}): Promise<{ base: string; hostWorkdir: string; extra: string; storeFile: string | null }> {
  const dir = await mkdtemp(join(tmpdir(), "projects-api-"));
  tempDirs.push(dir);
  const hostWorkdir = resolve(opts.workdir ?? dir);
  const extra = resolve(join(dir, "extra"));
  await mkdir(extra, { recursive: true });
  const storeFile = opts.projectsStoreFile === undefined ? null : opts.projectsStoreFile;
  handle = createUiServer({
    modelClient: new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]),
    tools: [makeTool({ name: "noop", permission: "auto", parallelSafe: true })],
    workdir: hostWorkdir,
    workdirs: opts.workdirs ?? [extra],
    ...(storeFile !== undefined ? { projectsStoreFile: storeFile } : {}),
    ...(opts.allowedHosts ? { allowedHosts: opts.allowedHosts } : {}),
  });
  return { base: await startServer(), hostWorkdir, extra, storeFile };
}

async function waitForDone(base: string, runId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const list = await (await fetch(`${base}/api/runs`)).json() as { runId: string; status: string }[];
    if (list.find((r) => r.runId === runId)?.status === "done") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Run ${runId} did not reach done`);
}

describe("GET/POST/PATCH/DELETE /api/projects", () => {
  it("CRUD 与 /api/harness.availableProjects", async () => {
    const { base, hostWorkdir, extra } = await makeHost();
    const empty = await (await fetch(`${base}/api/projects`)).json() as { projects: unknown[] };
    expect(empty.projects).toEqual([]);
    const created = await (await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "看板", workdirs: [hostWorkdir, extra], primaryWorkdir: hostWorkdir }),
    })).json() as { project: { id: string; name: string; workdirs: string[] } };
    expect(created.project.name).toBe("看板");
    expect(created.project.workdirs).toEqual([hostWorkdir, extra]);

    const listed = await (await fetch(`${base}/api/projects`)).json() as { projects: { id: string }[] };
    expect(listed.projects.map((p) => p.id)).toEqual([created.project.id]);
    const snap = await (await fetch(`${base}/api/harness`)).json() as { availableProjects: { id: string }[] };
    expect(snap.availableProjects.map((p) => p.id)).toEqual([created.project.id]);

    const patched = await (await fetch(`${base}/api/projects/${created.project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "新名" }),
    })).json() as { project: { name: string } };
    expect(patched.project.name).toBe("新名");

    const removed = await (await fetch(`${base}/api/projects/${created.project.id}`, {
      method: "DELETE",
    })).json() as { removed: boolean; id: string };
    expect(removed).toEqual({ removed: true, id: created.project.id });
    const after = await (await fetch(`${base}/api/projects`)).json() as { projects: unknown[] };
    expect(after.projects).toEqual([]);
  });

  it("越白名单 400，不静默丢掉", async () => {
    const { base } = await makeHost();
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", workdirs: ["D:\\definitely-not-allowed"] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("白名单");
  });

  it("同一目录不得属于两个项目", async () => {
    const { base, hostWorkdir } = await makeHost();
    const first = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "一", workdirs: [hostWorkdir] }),
    });
    expect(first.status).toBe(200);
    const second = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "二", workdirs: [hostWorkdir] }),
    });
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: string }).error).toContain("已属于");
  });

  it("注入 modelClient 的宿主不写操作员真实项目文件", async () => {
    const { base, hostWorkdir } = await makeHost();
    const implicit = join(hostWorkdir, PROJECTS_FILENAME);
    await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "看板", workdirs: [hostWorkdir] }),
    });
    expect(existsSync(implicit)).toBe(false);
    const listed = await (await fetch(`${base}/api/projects`)).json() as { projects: { name: string }[] };
    expect(listed.projects[0]?.name).toBe("看板");
  });

  it("显式 projectsStoreFile 才落盘，第二实例读得到", async () => {
    const dir = await mkdtemp(join(tmpdir(), "projects-store-"));
    tempDirs.push(dir);
    const storeFile = join(dir, PROJECTS_FILENAME);
    const first = await makeHost({ projectsStoreFile: storeFile });
    const created = await (await fetch(`${first.base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "看板", workdirs: [first.hostWorkdir] }),
    })).json() as { project: { id: string } };
    const raw = JSON.parse(await readFile(storeFile, "utf8"));
    expect(raw.schemaVersion).toBe(PROJECTS_SCHEMA_VERSION);
    expect(raw.projects[0].id).toBe(created.project.id);
    await handle?.close();
    handle = undefined;

    const second = await makeHost({ projectsStoreFile: storeFile });
    const listed = await (await fetch(`${second.base}/api/projects`)).json() as { projects: { id: string }[] };
    expect(listed.projects.map((p) => p.id)).toEqual([created.project.id]);
  });

  it("坏文件 → .bak 容错后空清单", async () => {
    const dir = await mkdtemp(join(tmpdir(), "projects-corrupt-"));
    tempDirs.push(dir);
    const storeFile = join(dir, PROJECTS_FILENAME);
    await writeFile(storeFile, "{not json", "utf8");
    const { base } = await makeHost({ projectsStoreFile: storeFile });
    const listed = await (await fetch(`${base}/api/projects`)).json() as { projects: unknown[] };
    expect(listed.projects).toEqual([]);
    expect(existsSync(`${storeFile}.bak`)).toBe(true);
  });

  it("新建 run 带 projectId：省略 workdir/extras 用成员；run_config 报 id", async () => {
    const { base, hostWorkdir, extra } = await makeHost();
    const created = await (await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "看板", workdirs: [hostWorkdir, extra], primaryWorkdir: hostWorkdir }),
    })).json() as { project: { id: string } };
    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "t", projectId: created.project.id }),
    })).json() as { runId: string };
    await waitForDone(base, runId);
    const sseText = await (await fetch(`${base}/api/runs/${runId}/events`)).text();
    const events = [...sseText.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]!));
    const rc = events.find((e) => e.event?.type === "run_config")?.event;
    expect(rc?.projectId).toBe(created.project.id);
    expect(rc?.workdir).toBe(hostWorkdir);
    expect(rc?.extraWorkdirs).toEqual([extra]);
    expect(rc?.writeRoots).toContain(extra);
    const list = await (await fetch(`${base}/api/runs`)).json() as { runId: string; projectId?: string }[];
    expect(list.find((r) => r.runId === runId)?.projectId).toBe(created.project.id);
  });

  it("未 POST projectId 时按目录入项不把项目 extras 写进 writeRoots", async () => {
    const { base, hostWorkdir, extra } = await makeHost();
    const created = await (await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "脏绑定", workdirs: [hostWorkdir, extra], primaryWorkdir: hostWorkdir }),
    })).json() as { project: { id: string } };
    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "t", workdir: extra }),
    })).json() as { runId: string };
    await waitForDone(base, runId);
    const sseText = await (await fetch(`${base}/api/runs/${runId}/events`)).text();
    const events = [...sseText.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]!));
    const rc = events.find((e) => e.event?.type === "run_config")?.event;
    expect(rc?.workdir).toBe(extra);
    expect(rc?.extraWorkdirs ?? []).toEqual([]);
    expect(rc?.writeRoots ?? []).not.toContain(hostWorkdir);
    expect(rc?.projectId).toBe(created.project.id);
  });

  it("未知 projectId / 工作目录不属于该项目 → 400", async () => {
    const { base, hostWorkdir, extra } = await makeHost();
    const created = await (await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "看板", workdirs: [hostWorkdir] }),
    })).json() as { project: { id: string } };
    const unknown = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "t", projectId: "no-such-project" }),
    });
    expect(unknown.status).toBe(400);
    const outsider = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "t", projectId: created.project.id, workdir: extra }),
    });
    expect(outsider.status).toBe(400);
    expect(((await outsider.json()) as { error: string }).error).toContain("不属于项目");
  });

  it("POST 非 JSON → 415", async () => {
    const { base } = await makeHost();
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "x",
    });
    expect(res.status).toBe(415);
  });
});

describe("loopback 门", () => {
  async function rawRequest(
    base: string,
    method: string,
    path: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: any }> {
    const { request } = await import("node:http");
    return new Promise((resolvePromise, reject) => {
      const payload = method === "GET" || method === "DELETE" ? null : "{}";
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

  it("项目管理端点对非 loopback Host 一律 403", async () => {
    const { base } = await makeHost({ allowedHosts: ["example.com"] });
    const remote = { Host: "example.com", "Content-Type": "application/json" };
    expect((await rawRequest(base, "GET", "/api/projects", remote)).status).toBe(403);
    expect((await rawRequest(base, "POST", "/api/projects", remote)).status).toBe(403);
    expect((await rawRequest(base, "PATCH", "/api/projects/x", remote)).status).toBe(403);
    expect((await rawRequest(base, "DELETE", "/api/projects/x", remote)).status).toBe(403);
  });
});

/**
 * GET /api/artifacts — 项目 workdirs 扫描 + 画册过期。
 * 不改 cite 同 workdir 政策（无 workdir 仍 400）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createUiServer, type UiServerHandle } from "../ui/server.js";
import { resetObservabilityMetrics } from "../src/metrics.js";
import { clearCapabilityCache } from "../src/model-capability.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock } from "./helpers.js";

let handle: UiServerHandle | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  resetObservabilityMetrics();
  clearCapabilityCache();
});

async function startServer(): Promise<string> {
  const port = await new Promise<number>((ok, reject) => {
    handle!.server.listen(0, "127.0.0.1", () => {
      const addr = handle!.server.address();
      if (addr && typeof addr === "object") ok(addr.port);
      else reject(new Error("no address"));
    });
  });
  return `http://127.0.0.1:${port}`;
}

async function makeHost() {
  const dir = await mkdtemp(join(tmpdir(), "artifacts-api-"));
  tempDirs.push(dir);
  const hostWorkdir = resolve(dir);
  const extra = resolve(join(dir, "extra"));
  await mkdir(extra, { recursive: true });
  handle = createUiServer({
    modelClient: new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]),
    tools: [makeTool({ name: "noop", permission: "auto", parallelSafe: true })],
    workdir: hostWorkdir,
    workdirs: [extra],
  });
  return { base: await startServer(), hostWorkdir, extra };
}

describe("GET /api/artifacts", () => {
  it("显式 workdir 扫该目录的 CITE_ARTIFACT_RELS", async () => {
    const { base, hostWorkdir } = await makeHost();
    await writeFile(join(hostWorkdir, "index.html"), "<html></html>");
    await writeFile(join(hostWorkdir, "DESIGN.md"), "# d");
    const body = await (await fetch(
      `${base}/api/artifacts?workdir=${encodeURIComponent(hostWorkdir)}`,
    )).json() as {
      artifacts: { rel: string; deckStale: boolean }[];
      workdirs: string[];
    };
    expect(body.workdirs).toEqual([hostWorkdir]);
    expect(body.artifacts.map((a) => a.rel).sort()).toEqual(["DESIGN.md", "index.html"]);
    expect(body.artifacts.every((a) => a.deckStale === false)).toBe(true);
  });

  it("projectId 扫项目内各目录；规格新于画册则 deckStale", async () => {
    const { base, hostWorkdir, extra } = await makeHost();
    await writeFile(join(hostWorkdir, "index.html"), "<html>home</html>");
    await mkdir(join(extra, "pm-spec"));
    await mkdir(join(extra, "deck-basic"));
    const specFile = join(extra, "pm-spec", "index.html");
    const deckFile = join(extra, "deck-basic", "index.html");
    await writeFile(specFile, "<html>spec</html>");
    await writeFile(deckFile, "<html>deck</html>");
    const old = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-04-01T00:00:00Z");
    await utimes(deckFile, old, old);
    await utimes(specFile, newer, newer);

    const created = await (await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "看板",
        workdirs: [hostWorkdir, extra],
        primaryWorkdir: hostWorkdir,
      }),
    })).json() as { project: { id: string } };

    const listed = await (await fetch(
      `${base}/api/artifacts?projectId=${encodeURIComponent(created.project.id)}`,
    )).json() as {
      projectId: string;
      artifacts: { rel: string; workdir: string; kind: string; deckStale: boolean }[];
      deckStale: boolean;
    };
    expect(listed.projectId).toBe(created.project.id);
    expect(listed.artifacts.map((a) => a.rel).sort()).toEqual([
      "deck-basic/index.html",
      "index.html",
      "pm-spec/index.html",
    ]);
    const deck = listed.artifacts.find((a) => a.kind === "deck");
    expect(deck?.deckStale).toBe(true);
    expect(listed.deckStale).toBe(true);
    expect(listed.artifacts.find((a) => a.rel === "index.html")?.workdir).toBe(hostWorkdir);
  });

  it("未知项目 404；白名单外 workdir 403", async () => {
    const { base } = await makeHost();
    expect((await fetch(`${base}/api/artifacts?projectId=no-such`)).status).toBe(404);
    expect((await fetch(`${base}/api/artifacts?workdir=${encodeURIComponent("D:\\\\not-allowed")}`)).status).toBe(403);
  });

  it("不放宽 cite：缺 workdir 仍 400", async () => {
    const { base } = await makeHost();
    expect((await fetch(`${base}/api/cite-candidates`)).status).toBe(400);
  });

  it("无滤参 400；?workdir= 只扫该目录", async () => {
    const { base, hostWorkdir, extra } = await makeHost();
    await writeFile(join(hostWorkdir, "index.html"), "<html>host-default</html>");
    await writeFile(join(extra, "index.html"), "<html>scratch-only</html>");

    const unfiltered = await fetch(`${base}/api/artifacts`);
    expect(unfiltered.status).toBe(400);
    const err = await unfiltered.json() as { error?: string };
    expect(err.error).toMatch(/workdir|projectId/);

    const filtered = await (await fetch(
      `${base}/api/artifacts?workdir=${encodeURIComponent(extra)}`,
    )).json() as {
      workdirs: string[];
      artifacts: { rel: string; workdir?: string }[];
    };
    expect(filtered.workdirs).toEqual([extra]);
    expect(filtered.artifacts.map((a) => a.rel)).toEqual(["index.html"]);
    expect(filtered.workdirs).not.toContain(hostWorkdir);
    expect(filtered.artifacts.every((a) => !a.workdir || a.workdir === extra)).toBe(true);
  });
});

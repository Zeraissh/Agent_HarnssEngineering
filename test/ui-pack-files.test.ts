/**
 * 文件领域包宿主契约：草稿不进菜单，签字安装后才可选用。
 * 注入 FakeModelClient + 临时 packsDir，不碰仓库 .agent-packs。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiServer, type UiServerHandle } from "../ui/server.js";
import { clearFilePacks, getPack, PACKS } from "../src/presets.js";
import { resetObservabilityMetrics } from "../src/metrics.js";
import { clearCapabilityCache } from "../src/model-capability.js";
import { FakeModelClient, fakeMessage, textBlock } from "./helpers.js";
import { mkdir, writeFile } from "node:fs/promises";

let handle: UiServerHandle | undefined;
const temps: string[] = [];

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
  temps.length = 0;
  clearFilePacks();
  resetObservabilityMetrics();
  clearCapabilityCache();
});

async function start(packsDir: string | null): Promise<string> {
  handle = createUiServer({
    modelClient: new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]),
    tools: [],
    workdir: process.cwd(),
    packsDir,
  });
  const port = await new Promise<number>((resolve, reject) => {
    handle!.server.listen(0, () => {
      const addr = handle!.server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("no address"));
    });
  });
  return `http://127.0.0.1:${port}`;
}

const draftBody = {
  name: "thermocouple-consult",
  description: "热电偶接线咨询",
  systemPrompt: "先问冷端补偿再谈接线。",
};

describe("file packs HTTP", () => {
  it("草稿不进 /api/harness；安装后 source=installed 且不泄露 systemPrompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "ui-packs-"));
    temps.push(root);
    const base = await start(root);

    const before = await (await fetch(`${base}/api/harness`)).json() as {
      availablePacks: Array<{ name: string; source?: string; systemPrompt?: unknown }>;
    };
    expect(before.availablePacks.some((p) => p.name === draftBody.name)).toBe(false);
    expect(before.availablePacks.every((p) => p.source === "builtin")).toBe(true);
    for (const p of before.availablePacks) expect(p).not.toHaveProperty("systemPrompt");

    const drafted = await fetch(`${base}/api/packs/drafts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draftBody),
    });
    expect(drafted.status).toBe(200);
    const draftList = await (await fetch(`${base}/api/packs`)).json() as {
      drafts: Array<{ name: string }>;
      installed: unknown[];
    };
    expect(draftList.drafts.map((d) => d.name)).toContain(draftBody.name);
    expect(draftList.installed).toEqual([]);
    expect(getPack(draftBody.name)).toBeUndefined();

    const mid = await (await fetch(`${base}/api/harness`)).json() as {
      availablePacks: Array<{ name: string }>;
    };
    expect(mid.availablePacks.some((p) => p.name === draftBody.name)).toBe(false);

    const installed = await fetch(`${base}/api/packs/drafts/${draftBody.name}/install`, {
      method: "POST",
    });
    expect(installed.status).toBe(200);
    const installedBody = await installed.json() as {
      availablePacks: Array<{ name: string; source: string }>;
    };
    expect(installedBody.availablePacks.some((p) => p.name === draftBody.name && p.source === "installed")).toBe(true);

    const after = await (await fetch(`${base}/api/harness`)).json() as {
      availablePacks: Array<{ name: string; source: string }>;
    };
    const filePack = after.availablePacks.find((p) => p.name === draftBody.name);
    expect(filePack?.source).toBe("installed");
    expect(filePack).not.toHaveProperty("systemPrompt");
    expect(getPack(draftBody.name)?.mcp).toBe(false);

    const run = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "闲聊一句", pack: draftBody.name }),
    });
    expect(run.status).toBe(200);
  });

  it("注入宿主缺省不读开发机 .agent-packs；未配置目录不能写草稿", async () => {
    const base = await start(null);
    const listed = await (await fetch(`${base}/api/packs`)).json() as { drafts: unknown[]; root: string | null };
    expect(listed.root).toBeNull();
    expect(listed.drafts).toEqual([]);
    const drafted = await fetch(`${base}/api/packs/drafts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draftBody),
    });
    expect(drafted.status).toBe(400);
  });

  it("不能起草内置包名", async () => {
    const root = await mkdtemp(join(tmpdir(), "ui-packs-"));
    temps.push(root);
    const base = await start(root);
    const res = await fetch(`${base}/api/packs/drafts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "design",
        description: "nope",
        systemPrompt: "nope",
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/内置包/);
    expect(getPack("design")).toBe(PACKS["design"]);
  });

  it("未识别 schemaVersion → createUiServer 抛错（同非法 context env）", async () => {
    const root = await mkdtemp(join(tmpdir(), "ui-packs-bad-"));
    temps.push(root);
    const dir = join(root, "installed", "bad-schema");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "pack.json"), JSON.stringify({
      schemaVersion: 99,
      name: "bad-schema",
      description: "x",
      builtinTools: ["read_file"],
      mcp: false,
      verify: { enabled: false, mode: "rubric" },
    }), "utf8");
    await writeFile(join(dir, "SYSTEM.md"), "x\n", "utf8");
    expect(() => createUiServer({
      modelClient: new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]),
      tools: [],
      workdir: process.cwd(),
      packsDir: root,
    })).toThrow(/schemaVersion/);
  });
});

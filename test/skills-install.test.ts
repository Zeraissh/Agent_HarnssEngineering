import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { performCatalogInstall } from "../src/mcp-catalog.js";
import { PACKS, getPack } from "../src/presets.js";
import { parseRouteDecision } from "../src/router.js";
import {
  SUPERPOWERS_DISTINCTIVE_PHRASE,
  githubSkillsContentsApiUrl,
  resolveSkillMd,
  resolveSkillsDir,
  setSkillEnabled,
  type SkillFetch,
} from "../src/skills.js";
import { installMcpTool } from "../src/tools/install-mcp.js";
import { ToolExecutor, ToolRegistry } from "../src/tools/registry.js";
import { createUiServer, type UiServerHandle } from "../ui/server.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock, toolUseBlock } from "./helpers.js";
// @ts-expect-error UI is plain JS
import { parseMcpSettingsPayload } from "../ui/public/features/settings.js";

const tempDirs: string[] = [];
let handle: UiServerHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

async function tmp(prefix = "skills-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const fixtureSkill = `# Using Superpowers\n\n${SUPERPOWERS_DISTINCTIVE_PHRASE}\nDo not skip the checklist.\n`;

const fetchImpl: SkillFetch = async (url) => {
  if (!url.startsWith("https://raw.githubusercontent.com/")) {
    return { ok: false, status: 400, text: async () => "blocked" };
  }
  return { ok: true, status: 200, text: async () => fixtureSkill };
};

async function listen(): Promise<string> {
  const port = await new Promise<number>((resolve, reject) => {
    handle!.server.listen(0, "127.0.0.1", () => {
      const addr = handle!.server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("no address"));
    });
  });
  return `http://127.0.0.1:${port}`;
}

async function waitForDone(base: string, runId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const list = await (await fetch(`${base}/api/runs`)).json() as { runId: string; status: string }[];
    if (list.find((row) => row.runId === runId)?.status === "done") return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("run did not finish");
}

describe("no Superpowers DomainPack", () => {
  it("PACKS / getPack / router stay pack=design unless a file pack", () => {
    expect(PACKS.superpowers).toBeUndefined();
    expect(getPack("superpowers")).toBeUndefined();
    expect(Object.keys(PACKS)).not.toContain("superpowers");
    expect(parseRouteDecision('{"pack":"superpowers","reason":"skills"}', Object.keys(PACKS))).toMatchObject({
      pack: null,
      reason: expect.stringMatching(/未注册/),
    });
  });
});

describe("skill write + inject", () => {
  it("deny writes nothing; allow writes SKILL.md idempotently", async () => {
    const dir = await tmp();
    const skillsDir = join(dir, ".agent-skills");
    const tool = installMcpTool({
      configPath: join(dir, "mcp.json"),
      workdir: dir,
      writesArmed: true,
      skillRoot: skillsDir,
      fetchImpl,
    });
    expect(tool.permission).toBe("ask");

    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry, dir);
    const ctx = { workdir: dir, toolUseId: "t1", signal: new AbortController().signal };
    const denied = await executor.executeAll(
      [toolUseBlock("u1", "install_mcp", { catalogId: "superpowers", kind: "skill", confirm: true })],
      ctx.signal,
      async () => ({ decision: "deny", reason: "not now" }),
    );
    expect(denied[0]?.is_error).toBe(true);
    expect(existsSync(join(skillsDir, "superpowers"))).toBe(false);

    const noConfirm = await tool.execute({ catalogId: "superpowers", confirm: false }, ctx);
    expect(noConfirm.isError).toBe(true);
    expect(existsSync(join(skillsDir, "superpowers"))).toBe(false);

    const first = await tool.execute({ catalogId: "superpowers", kind: "skill", confirm: true }, ctx);
    expect(first.isError).toBeUndefined();
    expect(existsSync(join(skillsDir, "superpowers", "SKILL.md"))).toBe(true);

    const second = await tool.execute({ catalogId: "superpowers", confirm: true }, ctx);
    expect(second.content).toMatch(/alreadyInstalled=true|已经安装/);
    const names = await readdir(join(skillsDir, "superpowers"));
    expect(names).toContain("SKILL.md");
  });

  it("next assembled run prompt contains the distinctive phrase from the written file", async () => {
    const dir = await tmp();
    const skillsDir = join(dir, "skills");
    const mcpFile = join(dir, "mcp.json");
    await writeFile(mcpFile, '{"mcpServers":{}}\n', "utf8");
    const installed = await performCatalogInstall({
      configPath: mcpFile,
      workdir: dir,
      confirm: true,
      writesArmed: true,
      catalogId: "superpowers",
      skillRoot: skillsDir,
      fetchImpl,
    });
    expect(installed.ok).toBe(true);

    const model = new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]);
    handle = createUiServer({
      modelClient: model,
      tools: [makeTool({ name: "noop" })],
      workdir: dir,
      mcpConfigFile: mcpFile,
      skillsDir,
      skillFetch: fetchImpl,
      executionEnv: { AGENT_EXECUTION_ISOLATION: "off" },
    });
    const base = await listen();
    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "ping", verify: false }),
    });
    expect(created.status).toBe(200);
    const { runId } = await created.json() as { runId: string };
    await waitForDone(base, runId);
    const system = model.requests[0]?.system.map((block) => block.text).join("\n") ?? "";
    expect(system).toContain(SUPERPOWERS_DISTINCTIVE_PHRASE);

    await setSkillEnabled(skillsDir, "superpowers", false);
    const model2 = new FakeModelClient([fakeMessage([textBlock("ok2")], "end_turn")]);
    await handle.close();
    handle = createUiServer({
      modelClient: model2,
      tools: [makeTool({ name: "noop" })],
      workdir: dir,
      mcpConfigFile: mcpFile,
      skillsDir,
      executionEnv: { AGENT_EXECUTION_ISOLATION: "off" },
    });
    const base2 = await listen();
    const created2 = await fetch(`${base2}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "ping2", verify: false }),
    });
    const { runId: runId2 } = await created2.json() as { runId: string };
    await waitForDone(base2, runId2);
    const system2 = model2.requests[0]?.system.map((block) => block.text).join("\n") ?? "";
    expect(system2).not.toContain(SUPERPOWERS_DISTINCTIVE_PHRASE);
  });

  it("injected modelClient host without skillsDir/mcpConfigFile writes nothing", async () => {
    const dir = await tmp();
    const model = new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]);
    handle = createUiServer({
      modelClient: model,
      tools: [makeTool({ name: "noop" })],
      workdir: dir,
      executionEnv: { AGENT_EXECUTION_ISOLATION: "off" },
    });
    const base = await listen();
    const skillRes = await fetch(`${base}/api/mcp/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ catalogId: "superpowers", confirm: true }),
    });
    expect(skillRes.status).toBeGreaterThanOrEqual(400);
    expect(existsSync(join(dir, ".agent-skills"))).toBe(false);
    expect(resolveSkillsDir({ workdir: dir, realHost: false })).toBeUndefined();

    const mcpRes = await fetch(`${base}/api/mcp/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ catalogId: "filesystem", confirm: true }),
    });
    expect(mcpRes.status).toBe(409);
    expect(existsSync(join(dir, "mcp.json"))).toBe(false);
  });

  it("/api/harness snapshot lists skills without secrets, webhooks, or skill bodies", async () => {
    const dir = await tmp();
    const skillsDir = join(dir, "skills");
    const mcpFile = join(dir, "mcp.json");
    await writeFile(mcpFile, '{"mcpServers":{}}\n', "utf8");
    await performCatalogInstall({
      configPath: mcpFile,
      workdir: dir,
      confirm: true,
      writesArmed: true,
      catalogId: "superpowers",
      skillRoot: skillsDir,
      fetchImpl,
    });
    handle = createUiServer({
      modelClient: new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]),
      tools: [makeTool({ name: "noop" })],
      workdir: dir,
      mcpConfigFile: mcpFile,
      skillsDir,
      executionEnv: { AGENT_EXECUTION_ISOLATION: "off" },
    });
    const base = await listen();
    const snap = await (await fetch(`${base}/api/harness`)).json() as {
      mcp: { skills: Array<{ id: string; kind: string; enabled: boolean }>; catalogIds: string[] };
      notify?: { kind?: string; armed?: boolean; webhookUrl?: string };
    };
    expect(snap.mcp.catalogIds).toEqual([
      "feishu-lark",
      "slack",
      "github",
      "filesystem",
      "notion",
      "superpowers",
      "ppt-master",
      "google-workspace",
    ]);
    expect(snap.mcp.skills).toEqual([{ id: "superpowers", kind: "skill", enabled: true }]);
    const blob = JSON.stringify(snap);
    expect(blob).not.toContain(SUPERPOWERS_DISTINCTIVE_PHRASE);
    expect(blob).not.toMatch(/hooks\.slack|feishu\.cn\/open-apis\/bot|sk-[A-Za-z0-9]|xox[bap]-/i);
    expect(snap.notify?.webhookUrl).toBeUndefined();
    expect(blob).not.toContain("AGENT_FEISHU_WEBHOOK");
  });
});

describe("custom GitHub skill discovery", () => {
  function mapFetch(impl: (url: string) => { status: number; body?: string }): SkillFetch {
    return async (url) => {
      const hit = impl(url);
      return {
        ok: hit.status >= 200 && hit.status < 300,
        status: hit.status,
        text: async () => hit.body ?? "",
      };
    };
  }

  it("install_mcp: root SKILL.md still works", async () => {
    const dir = await tmp();
    const skillsDir = join(dir, ".agent-skills");
    const tool = installMcpTool({
      configPath: join(dir, "mcp.json"),
      workdir: dir,
      writesArmed: true,
      skillRoot: skillsDir,
      fetchImpl: mapFetch((url) => {
        if (url === "https://raw.githubusercontent.com/acme/plain-skill/main/SKILL.md") {
          return { status: 200, body: "# root via tool\n" };
        }
        return { status: 404 };
      }),
    });
    const ctx = { workdir: dir, toolUseId: "t1", signal: new AbortController().signal };
    const result = await tool.execute(
      { githubUrl: "https://github.com/acme/plain-skill", kind: "skill", confirm: true },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(await readFile(join(skillsDir, "custom-acme-plain-skill", "SKILL.md"), "utf8")).toBe("# root via tool\n");
  });

  it("install_mcp: nested skills/foo/SKILL.md with root 404 still installs", async () => {
    const dir = await tmp();
    const skillsDir = join(dir, ".agent-skills");
    const tool = installMcpTool({
      configPath: join(dir, "mcp.json"),
      workdir: dir,
      writesArmed: true,
      skillRoot: skillsDir,
      fetchImpl: mapFetch((url) => {
        if (url.endsWith("/acme/foo/main/SKILL.md")) return { status: 404 };
        if (url.endsWith("/acme/foo/main/skills/foo/SKILL.md")) return { status: 200, body: "# foo nested\n" };
        return { status: 404 };
      }),
    });
    const ctx = { workdir: dir, toolUseId: "t1", signal: new AbortController().signal };
    const result = await tool.execute(
      { githubUrl: "https://github.com/acme/foo", kind: "skill", confirm: true },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(existsSync(join(skillsDir, "custom-acme-foo", "SKILL.md"))).toBe(true);
  });

  it("file-404 error string does not say 仓库不存在", async () => {
    const dir = await tmp();
    const tool = installMcpTool({
      configPath: join(dir, "mcp.json"),
      workdir: dir,
      writesArmed: true,
      skillRoot: join(dir, ".agent-skills"),
      fetchImpl: mapFetch((url) => {
        if (url === "https://api.github.com/repos/acme/missing-skill") {
          return { status: 200, body: "{}" };
        }
        return { status: 404 };
      }),
    });
    const ctx = { workdir: dir, toolUseId: "t1", signal: new AbortController().signal };
    const result = await tool.execute(
      { githubUrl: "https://github.com/acme/missing-skill", kind: "skill", confirm: true },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).not.toMatch(/仓库不存在/);
    expect(result.content).toMatch(/已尝试：/);
    expect(result.content).toMatch(/main\/SKILL\.md/);
  });

  it("public contents listing finds skills/foo when folder ≠ repo name", async () => {
    const listing = githubSkillsContentsApiUrl("acme/widget", "main");
    const resolved = await resolveSkillMd({
      repo: "acme/widget",
      fetchImpl: mapFetch((url) => {
        if (url === listing) {
          return {
            status: 200,
            body: JSON.stringify([{ name: "foo", path: "skills/foo", type: "dir" }]),
          };
        }
        if (url === "https://raw.githubusercontent.com/acme/widget/main/skills/foo/SKILL.md") {
          return { status: 200, body: "# listed foo\n" };
        }
        return { status: 404 };
      }),
    });
    expect(resolved.sourcePath).toBe("skills/foo/SKILL.md");
    expect(resolved.text).toBe("# listed foo\n");
    expect(resolved.tried).toContain("main/SKILL.md");
    expect(resolved.tried).toContain("main/skills/foo/SKILL.md");
  });
});

describe("settings catalog parse", () => {
  it("projects availability ready|missing and skills without bodies", () => {
    const parsed = parseMcpSettingsPayload({
      catalog: [{ id: "superpowers", kind: "skill", availability: "ready", title: "Superpowers" }],
      skills: [{ id: "superpowers", kind: "skill", enabled: true, body: "LEAK" }],
      installedCatalogIds: ["superpowers"],
    });
    expect(parsed.catalog[0].availability).toBe("ready");
    expect(parsed.skills).toEqual([{ id: "superpowers", kind: "skill", enabled: true }]);
    expect(JSON.stringify(parsed.skills)).not.toContain("LEAK");
  });
});

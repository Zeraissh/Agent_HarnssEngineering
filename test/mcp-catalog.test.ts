import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MCP_CATALOG,
  MCP_CATALOG_IDS,
  SKILL_KIND_REQUIRED,
  catalogHasNoSecrets,
  mergeCatalogSnippet,
  parseGithubRepoUrl,
  performCatalogInstall,
  publicCatalogEntries,
} from "../src/mcp-catalog.js";
import {
  skillMdCandidatePaths,
  type SkillFetch,
} from "../src/skills.js";
import { serializeMcpConfig } from "../ui/mcp-config-file.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-catalog-"));
  tempDirs.push(dir);
  return dir;
}

describe("MCP / skill catalog freeze", () => {
  it("ids are frozen, ≤12, exact order", () => {
    expect(MCP_CATALOG_IDS).toEqual([
      "feishu-lark",
      "slack",
      "github",
      "filesystem",
      "notion",
      "superpowers",
      "ppt-master",
      "google-workspace",
    ]);
    expect(MCP_CATALOG_IDS.length).toBeLessThanOrEqual(12);
    expect(MCP_CATALOG.map((entry) => entry.id)).toEqual([...MCP_CATALOG_IDS]);
  });

  it("availability is ready|missing; Superpowers is a skill; snippets have no secrets", () => {
    expect(new Set(MCP_CATALOG.map((entry) => entry.availability))).toEqual(new Set(["ready", "missing"]));
    expect(MCP_CATALOG.find((entry) => entry.id === "superpowers")).toMatchObject({
      kind: "skill",
      availability: "ready",
      repo: "obra/superpowers",
    });
    expect(MCP_CATALOG.find((entry) => entry.id === "ppt-master")).toMatchObject({
      kind: "skill",
      availability: "ready",
      repo: "hugohe3/ppt-master",
      skillFiles: [{ sourcePath: "skills/ppt-master/SKILL.md", destName: "SKILL.md" }],
    });
    expect(MCP_CATALOG.find((entry) => entry.id === "google-workspace")?.availability).toBe("missing");
    expect(catalogHasNoSecrets()).toBe(true);
    const blob = JSON.stringify(publicCatalogEntries());
    expect(blob).not.toMatch(/sk-|xox[bap]-|hooks\.slack|feishu\.cn\/open-apis\/bot/i);
    expect(blob).not.toMatch(/curl\s*\|/);
  });
});

describe("parseGithubRepoUrl", () => {
  it("accepts https://github.com/owner/repo", () => {
    expect(parseGithubRepoUrl("https://github.com/obra/superpowers")).toEqual({
      owner: "obra",
      repo: "superpowers",
      url: "https://github.com/obra/superpowers",
    });
  });

  it("rejects escape, extra path, javascript, userinfo, port", () => {
    expect(parseGithubRepoUrl("javascript:alert(1)")).toMatchObject({ error: expect.stringMatching(/https|协议/) });
    expect(parseGithubRepoUrl("https://github.com/obra/superpowers/blob/main/SKILL.md")).toMatchObject({
      error: expect.stringMatching(/子路径/),
    });
    expect(parseGithubRepoUrl("https://github.com/obra/../etc")).toMatchObject({
      error: expect.stringMatching(/逃逸|非法|子路径/),
    });
    expect(parseGithubRepoUrl("https://user:pass@github.com/obra/superpowers")).toMatchObject({
      error: expect.stringMatching(/用户信息/),
    });
    expect(parseGithubRepoUrl("https://github.com:8443/obra/superpowers")).toMatchObject({
      error: expect.stringMatching(/端口/),
    });
  });
});

describe("mergeCatalogSnippet", () => {
  it("does not wipe other mcp.json servers or existing includeTools", () => {
    const current = {
      stm32: { command: "python", args: ["-m", "stm32_gdb_mcp"], includeTools: ["self_check"] },
      github: { command: "docker", args: ["run"], includeTools: ["get_file_contents"], env: { KEEP: "1" } },
    };
    const next = mergeCatalogSnippet(current, {
      name: "filesystem",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    });
    expect(next.stm32).toEqual(current.stm32);
    expect((next.github as { includeTools: string[] }).includeTools).toEqual(["get_file_contents"]);
    expect((next.filesystem as { command: string }).command).toBe("npx");

    const githubAgain = mergeCatalogSnippet(next, {
      name: "github",
      command: "docker",
      args: ["run", "-i"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_ACCESS_TOKEN}" },
    });
    expect((githubAgain.github as { includeTools: string[] }).includeTools).toEqual(["get_file_contents"]);
    expect((githubAgain.stm32 as { command: string }).command).toBe("python");
  });
});

describe("performCatalogInstall", () => {
  it("merges filesystem into mcp.json without dropping siblings", async () => {
    const dir = await tmp();
    const configPath = join(dir, "mcp.json");
    await writeFile(configPath, serializeMcpConfig({
      stm32: { command: "python", args: ["srv"] },
    }), "utf8");
    const result = await performCatalogInstall({
      configPath,
      workdir: dir,
      confirm: true,
      writesArmed: true,
      catalogId: "filesystem",
    });
    expect(result.ok).toBe(true);
    const saved = JSON.parse(await readFile(configPath, "utf8")) as { servers: Record<string, unknown> };
    expect(saved.servers.stm32).toEqual({ command: "python", args: ["srv"] });
    expect(saved.servers.filesystem).toBeDefined();
  });

  it("custom GitHub without kind fail-closed", async () => {
    const dir = await tmp();
    const result = await performCatalogInstall({
      configPath: join(dir, "mcp.json"),
      workdir: dir,
      confirm: true,
      writesArmed: true,
      githubUrl: "https://github.com/acme/mystery-plugin",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(SKILL_KIND_REQUIRED);
  });
});

function skillFetchFor(impl: (url: string) => { status: number; body?: string }): SkillFetch {
  return async (url) => {
    const hit = impl(url);
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      text: async () => hit.body ?? "",
    };
  };
}

describe("custom GitHub skill SKILL.md resolve", () => {
  it("candidate order: pin, root, skills/, skills/<repo>/, well-known extras", () => {
    expect(skillMdCandidatePaths("foo", ["skills/using-superpowers/SKILL.md"])).toEqual([
      "skills/using-superpowers/SKILL.md",
      "SKILL.md",
      "skills/SKILL.md",
      "skills/foo/SKILL.md",
      "skills/ppt-master/SKILL.md",
    ]);
  });

  it("root SKILL.md still installs", async () => {
    const dir = await tmp();
    const skillsDir = join(dir, ".agent-skills");
    const result = await performCatalogInstall({
      configPath: join(dir, "mcp.json"),
      workdir: dir,
      confirm: true,
      writesArmed: true,
      githubUrl: "https://github.com/acme/plain-skill",
      kind: "skill",
      skillRoot: skillsDir,
      fetchImpl: skillFetchFor((url) => {
        if (url === "https://raw.githubusercontent.com/acme/plain-skill/main/SKILL.md") {
          return { status: 200, body: "# root skill\n" };
        }
        return { status: 404 };
      }),
    });
    expect(result.ok).toBe(true);
    expect(existsSync(join(skillsDir, "custom-acme-plain-skill", "SKILL.md"))).toBe(true);
    expect(await readFile(join(skillsDir, "custom-acme-plain-skill", "SKILL.md"), "utf8")).toBe("# root skill\n");
  });

  it("nested skills/foo/SKILL.md installs when root 404s", async () => {
    const dir = await tmp();
    const skillsDir = join(dir, ".agent-skills");
    const result = await performCatalogInstall({
      configPath: join(dir, "mcp.json"),
      workdir: dir,
      confirm: true,
      writesArmed: true,
      githubUrl: "https://github.com/acme/foo",
      kind: "skill",
      skillRoot: skillsDir,
      fetchImpl: skillFetchFor((url) => {
        if (url === "https://raw.githubusercontent.com/acme/foo/main/SKILL.md") return { status: 404 };
        if (url === "https://raw.githubusercontent.com/acme/foo/main/skills/foo/SKILL.md") {
          return { status: 200, body: "# nested foo\n" };
        }
        return { status: 404 };
      }),
    });
    expect(result.ok).toBe(true);
    expect(await readFile(join(skillsDir, "custom-acme-foo", "SKILL.md"), "utf8")).toBe("# nested foo\n");
  });

  it("file-404 names tried paths and does not say 仓库不存在", async () => {
    const dir = await tmp();
    const result = await performCatalogInstall({
      configPath: join(dir, "mcp.json"),
      workdir: dir,
      confirm: true,
      writesArmed: true,
      githubUrl: "https://github.com/acme/missing-skill",
      kind: "skill",
      skillRoot: join(dir, ".agent-skills"),
      fetchImpl: skillFetchFor((url) => {
        if (url === "https://api.github.com/repos/acme/missing-skill") {
          return { status: 200, body: JSON.stringify({ full_name: "acme/missing-skill" }) };
        }
        return { status: 404 };
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/skill 文件 404|未找到 SKILL\.md/);
    expect(result.error).toMatch(/main\/SKILL\.md/);
    expect(result.error).toMatch(/skills\/SKILL\.md/);
    expect(result.error).not.toMatch(/仓库不存在/);
  });

  it("repo 404 is a distinct missing-repo error", async () => {
    const dir = await tmp();
    const result = await performCatalogInstall({
      configPath: join(dir, "mcp.json"),
      workdir: dir,
      confirm: true,
      writesArmed: true,
      githubUrl: "https://github.com/acme/no-such-repo",
      kind: "skill",
      skillRoot: join(dir, ".agent-skills"),
      fetchImpl: skillFetchFor(() => ({ status: 404 })),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/仓库不存在或不可公开访问/);
    expect(result.error).toMatch(/acme\/no-such-repo/);
  });

  it("catalog ppt-master pin is fetched before root SKILL.md", async () => {
    const dir = await tmp();
    const urls: string[] = [];
    const result = await performCatalogInstall({
      configPath: join(dir, "mcp.json"),
      workdir: dir,
      confirm: true,
      writesArmed: true,
      catalogId: "ppt-master",
      skillRoot: join(dir, ".agent-skills"),
      fetchImpl: skillFetchFor((url) => {
        urls.push(url);
        if (url.endsWith("/skills/ppt-master/SKILL.md")) return { status: 200, body: "# ppt pin\n" };
        return { status: 404 };
      }),
    });
    expect(result.ok).toBe(true);
    expect(urls[0]).toBe("https://raw.githubusercontent.com/hugohe3/ppt-master/main/skills/ppt-master/SKILL.md");
  });
});

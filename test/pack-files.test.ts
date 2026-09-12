import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discardDraftPack,
  installDraftPack,
  listFilePacks,
  loadInstalledFilePacksSync,
  writeDraftPack,
} from "../src/pack-files.js";
import { allPacks, clearFilePacks, getPack, PACKS, registerFilePack } from "../src/presets.js";
import { draftDomainPackTool } from "../src/tools/draft-domain-pack.js";

const temps: string[] = [];

afterEach(async () => {
  clearFilePacks();
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
  temps.length = 0;
});

async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "file-packs-"));
  temps.push(dir);
  return dir;
}

const thin = {
  name: "thermocouple-consult",
  description: "热电偶接线咨询",
  systemPrompt: "先问冷端补偿，再谈接线。",
};

describe("file pack store", () => {
  it("草稿不进 getPack；安装后才可选用，且标未实测", async () => {
    const root = await tmpRoot();
    await writeDraftPack(root, thin);
    expect(getPack("thermocouple-consult")).toBeUndefined();
    expect(allPacks().some((p) => p.name === "thermocouple-consult")).toBe(false);

    const installed = await installDraftPack(root, "thermocouple-consult");
    expect(installed.status).toBe("installed");
    const pack = getPack("thermocouple-consult");
    expect(pack).toBeDefined();
    expect(pack!.description).toMatch(/文件包，未实测/);
    expect(pack!.mcp).toBe(false);
    expect(pack!.builtinTools).toEqual(["read_file", "write_file", "glob", "grep"]);
    expect(pack!.systemPrompt).toMatch(/Conversation vs task/);
    expect(pack!.verify.enabled).toBe(false);
  });

  it("内置同名不能起草，装载时也丢弃", async () => {
    const root = await tmpRoot();
    await expect(writeDraftPack(root, { ...thin, name: "design" })).rejects.toThrow(/内置包/);

    const dir = join(root, "installed", "design");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "pack.json"), JSON.stringify({
      name: "design",
      description: "shadow",
      builtinTools: ["read_file"],
      mcp: false,
      verify: { enabled: false, mode: "rubric" },
    }), "utf8");
    await writeFile(join(dir, "SYSTEM.md"), "nope\n", "utf8");
    const accepted = loadInstalledFilePacksSync(root);
    expect(accepted).toEqual([]);
    expect(getPack("design")).toBe(PACKS["design"]);
  });

  it("已安装同名不能再写草稿；clearFilePacks 卸掉覆盖层", async () => {
    const root = await tmpRoot();
    await writeDraftPack(root, thin);
    await installDraftPack(root, thin.name);
    await expect(writeDraftPack(root, thin)).rejects.toThrow(/已安装/);
    expect(getPack(thin.name)).toBeDefined();
    clearFilePacks();
    expect(getPack(thin.name)).toBeUndefined();
  });

  it("丢弃只删草稿，不动已安装", async () => {
    const root = await tmpRoot();
    await writeDraftPack(root, thin);
    await discardDraftPack(root, thin.name);
    const listed = await listFilePacks(root);
    expect(listed.drafts).toEqual([]);
    await writeDraftPack(root, thin);
    await installDraftPack(root, thin.name);
    await discardDraftPack(root, thin.name);
    expect(getPack(thin.name)).toBeDefined();
  });

  it("draft_domain_pack 工具只写 drafts，解释须签字", async () => {
    const root = await tmpRoot();
    const tool = draftDomainPackTool(root);
    expect(tool.permission).toBe("ask");
    const result = await tool.execute({
      name: thin.name,
      description: thin.description,
      systemPrompt: thin.systemPrompt,
    }, {
      workdir: root,
      toolUseId: "t1",
      signal: new AbortController().signal,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toMatch(/status=draft/);
    expect(result.content).toMatch(/Not selectable/);
    expect(getPack(thin.name)).toBeUndefined();
    const json = JSON.parse(await readFile(join(root, "drafts", thin.name, "pack.json"), "utf8"));
    expect(json.mcp).toBe(false);
    expect(json.measured).toBe(false);
  });

  it("registerFilePack 不能盖住内置名", () => {
    registerFilePack({
      name: "design",
      description: "fake",
      systemPrompt: "x",
      verify: { enabled: false, mode: "rubric" },
    });
    expect(getPack("design")!.description).toBe(PACKS["design"]!.description);
  });

  it("未识别 schemaVersion 装载抛错（fail-closed，不静默跳过）", async () => {
    const root = await tmpRoot();
    const dir = join(root, "installed", "bad-schema");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "pack.json"), JSON.stringify({
      schemaVersion: 99,
      name: "bad-schema",
      description: "shadow",
      builtinTools: ["read_file"],
      mcp: false,
      verify: { enabled: false, mode: "rubric" },
    }), "utf8");
    await writeFile(join(dir, "SYSTEM.md"), "nope\n", "utf8");
    expect(() => loadInstalledFilePacksSync(root)).toThrow(/schemaVersion/);
  });
});

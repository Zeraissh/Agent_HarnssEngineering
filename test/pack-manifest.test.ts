import { describe, expect, it } from "vitest";
import {
  ALLOWED_FILE_PACK_TOOLS,
  conservativeDraftManifest,
  clampFilePackPrivileges,
  DRAFT_BUILTIN_TOOLS,
  FILE_PACK_MAX_TURNS_CAP,
  PACK_MANIFEST_SCHEMA_VERSION,
  parsePackManifest,
} from "../src/pack-manifest.js";

describe("file pack manifest", () => {
  it("生成器只收薄字段，工具面锁死读写四件，mcp/核查/资源全关", () => {
    const m = conservativeDraftManifest({
      name: "Thermocouple-Consult",
      description: "热电偶接线咨询",
      systemPrompt: "先问型号再答。",
      verifyInstructions: "对照数据手册。",
    });
    expect(m.name).toBe("thermocouple-consult");
    expect(m.schemaVersion).toBe(PACK_MANIFEST_SCHEMA_VERSION);
    expect(m.builtinTools).toEqual([...DRAFT_BUILTIN_TOOLS]);
    expect(m.mcp).toBe(false);
    expect(m.verify).toEqual({ enabled: false, mode: "rubric" });
    expect(m.measured).toBe(false);
    expect(m.resources).toBeUndefined();
    expect(m.verifyInstructionsFile).toBe("VERIFY.md");
  });

  it("mcp:true 与 resources 一律丢掉；缺工具名单回落草稿默认", () => {
    const parsed = parsePackManifest({
      name: "lab-notes",
      description: "实验笔记",
      mcp: true,
      resources: ["swd-probe"],
      builtinTools: ["not-a-tool", "bash"],
      verify: { enabled: true, mode: "programmatic", maxTurns: 70 },
      guardrails: { maxTurns: 99 },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("parse failed");
    expect(parsed.manifest.mcp).toBe(false);
    expect(parsed.manifest.resources).toBeUndefined();
    expect(parsed.manifest.builtinTools).toEqual(["bash"]);
    expect(parsed.manifest.verify.enabled).toBe(true);
    expect(parsed.manifest.verify.maxTurns).toBe(FILE_PACK_MAX_TURNS_CAP);
    expect(parsed.manifest.guardrails?.maxTurns).toBe(FILE_PACK_MAX_TURNS_CAP);
  });

  it("缺 builtinTools 不等于全部内置工具", () => {
    const parsed = parsePackManifest({ name: "notes", description: "记笔记" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("parse failed");
    expect(parsed.manifest.builtinTools).toEqual([...DRAFT_BUILTIN_TOOLS]);
    expect(parsed.manifest.builtinTools).not.toContain("web_search");
    expect(ALLOWED_FILE_PACK_TOOLS).toContain("web_search");
  });

  it("非法包名拒绝", () => {
    expect(() => conservativeDraftManifest({
      name: "1bad",
      description: "x",
      systemPrompt: "y",
    })).toThrow(/kebab-case/);
    expect(parsePackManifest({ name: "no_underscore", description: "x" }).ok).toBe(false);
  });

  it("clamp 后再写 measured 仍是 false——签字安装也不算实测", () => {
    const clamped = clampFilePackPrivileges({
      schemaVersion: PACK_MANIFEST_SCHEMA_VERSION,
      name: "notes",
      description: "x",
      version: "1.0.0",
      measured: true,
      systemPromptFile: "SYSTEM.md",
      builtinTools: [...DRAFT_BUILTIN_TOOLS],
      mcp: false,
      verify: { enabled: false, mode: "rubric" },
    });
    expect(clamped.measured).toBe(false);
    expect(clamped.schemaVersion).toBe(PACK_MANIFEST_SCHEMA_VERSION);
  });

  it("未识别 schemaVersion → unrecognizedSchema（装载须 fail-closed）", () => {
    const parsed = parsePackManifest({
      schemaVersion: 99,
      name: "notes",
      description: "x",
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected fail");
    expect(parsed.unrecognizedSchema).toBe(true);
    expect(parsed.error).toMatch(/schemaVersion/);
  });

  it("缺 schemaVersion 视为当前版本（兼容旧草稿）", () => {
    const parsed = parsePackManifest({ name: "notes", description: "x" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("parse failed");
    expect(parsed.manifest.schemaVersion).toBe(PACK_MANIFEST_SCHEMA_VERSION);
  });
});

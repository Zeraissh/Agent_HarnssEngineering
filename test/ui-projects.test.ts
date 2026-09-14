/**
 * 项目实体解析 / 重叠 / 白名单（不启宿主）。
 */
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  overlappingProjectWorkdirs,
  parseProjectPatch,
  parseProjectStore,
  parseProjectWrite,
  PROJECTS_SCHEMA_VERSION,
} from "../ui/projects.js";

const allowed = ["D:\\a", "D:\\b", "D:\\c"];

describe("parseProjectWrite", () => {
  it("名称 + 至少一项白名单目录；primary 缺省取第一项", () => {
    const parsed = parseProjectWrite({ name: "看板", workdirs: ["D:\\a", "D:\\b"] }, allowed);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.name).toBe("看板");
    expect(parsed.workdirs).toEqual([resolve("D:\\a"), resolve("D:\\b")]);
    expect(parsed.primaryWorkdir).toBe(resolve("D:\\a"));
  });

  it("越白名单失败，不静默丢掉", () => {
    const parsed = parseProjectWrite({ name: "x", workdirs: ["D:\\nope"] }, allowed);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("白名单");
    expect(parsed.status).toBe(400);
  });

  it("空名 / 空成员 / primary 不在集合都失败", () => {
    expect(parseProjectWrite({ name: "  ", workdirs: ["D:\\a"] }, allowed).ok).toBe(false);
    expect(parseProjectWrite({ name: "x", workdirs: [] }, allowed).ok).toBe(false);
    expect(parseProjectWrite({ name: "x", workdirs: ["D:\\a"], primaryWorkdir: "D:\\b" }, allowed).ok).toBe(false);
  });
});

describe("parseProjectPatch / overlap", () => {
  it("只改名时不要求 workdirs", () => {
    const parsed = parseProjectPatch({ name: "新名" }, allowed);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.name).toBe("新名");
    expect(parsed.workdirs).toBeUndefined();
  });

  it("同一路径不得同时属于两个项目", () => {
    const a = resolve("D:\\a");
    const overlap = overlappingProjectWorkdirs(
      [{ id: "p1", name: "一", workdirs: [a], primaryWorkdir: a, createdAt: "0" }],
      [a],
    );
    expect(overlap).toEqual([a]);
    expect(overlappingProjectWorkdirs(
      [{ id: "p1", name: "一", workdirs: [a], primaryWorkdir: a, createdAt: "0" }],
      [a],
      "p1",
    )).toEqual([]);
  });
});

describe("parseProjectStore", () => {
  it("坏 JSON / 版本不符 → null", () => {
    expect(parseProjectStore("{")).toBeNull();
    expect(parseProjectStore(JSON.stringify({ schemaVersion: 99, projects: [] }))).toBeNull();
  });

  it("合法 store 保留 id / 路径归一", () => {
    const store = parseProjectStore(JSON.stringify({
      schemaVersion: PROJECTS_SCHEMA_VERSION,
      projects: [{
        id: "board-1",
        name: "看板",
        workdirs: ["D:\\a"],
        primaryWorkdir: "D:\\a",
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
    }));
    expect(store?.projects[0]?.id).toBe("board-1");
    expect(store?.projects[0]?.workdirs).toEqual([resolve("D:\\a")]);
  });
});

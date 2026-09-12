import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DESIGN_DRAFTS_FOLDER,
  decideDesignDraftsSelection,
  isHarnessPackageName,
  packageNameFromJson,
  resolveDesignDraftsDir,
  sameWorkdirPath,
} from "../src/design-workdir.js";

describe("resolveDesignDraftsDir", () => {
  it("缺省落在家目录下的 Fathom", () => {
    expect(resolveDesignDraftsDir({}, "/Users/ops")).toBe(resolve("/Users/ops", DESIGN_DRAFTS_FOLDER));
  });

  it("AGENT_DESIGN_DRAFTS_DIR 覆盖", () => {
    expect(resolveDesignDraftsDir(
      { AGENT_DESIGN_DRAFTS_DIR: join("D:", "Work", "scratch", "fathom-ops") },
      homedir(),
    )).toBe(resolve(join("D:", "Work", "scratch", "fathom-ops")));
  });
});

describe("harness 仓库识别", () => {
  it("只认 package.json name = agent-harness", () => {
    expect(packageNameFromJson('{"name":"agent-harness"}')).toBe("agent-harness");
    expect(isHarnessPackageName("agent-harness")).toBe(true);
    expect(isHarnessPackageName("ruile-deck")).toBe(false);
    expect(packageNameFromJson("not-json")).toBeNull();
  });
});

describe("decideDesignDraftsSelection", () => {
  const drafts = resolve("/tmp/Fathom");

  it("当前是宿主仓库 → 切到稿目录", () => {
    expect(decideDesignDraftsSelection({
      currentWorkdir: resolve("/repo/Agent_Design"),
      draftsDir: drafts,
      currentIsHarness: true,
    })).toEqual({ select: true, reason: "host-repo" });
  });

  it("已经在稿目录 → 不反复切", () => {
    expect(decideDesignDraftsSelection({
      currentWorkdir: drafts,
      draftsDir: drafts,
      currentIsHarness: false,
    })).toEqual({ select: false, reason: "already-drafts" });
  });

  it("用户已选别的目录 → 不抢", () => {
    expect(decideDesignDraftsSelection({
      currentWorkdir: resolve("/work/campaign"),
      draftsDir: drafts,
      currentIsHarness: false,
    })).toEqual({ select: false, reason: "custom" });
  });

  it("还没选目录 → 用稿目录", () => {
    expect(decideDesignDraftsSelection({
      currentWorkdir: "",
      draftsDir: drafts,
      currentIsHarness: false,
    })).toEqual({ select: true, reason: "empty" });
  });

  it("sameWorkdirPath 归一斜杠", () => {
    expect(sameWorkdirPath("D:/Work/Fathom", "D:\\Work\\Fathom")).toBe(true);
  });
});

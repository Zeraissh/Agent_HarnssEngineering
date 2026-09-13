import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatCiteBlock,
  oneLineTask,
  parseCitedRunIds,
  resolveCiteArtifacts,
  visibleCiteRuns,
} from "../ui/cite.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("visibleCiteRuns", () => {
  it("被续跑接走的父会话不出现", () => {
    expect(visibleCiteRuns([
      { runId: "parent", continuedFrom: null },
      { runId: "child", continuedFrom: "parent" },
    ]).map((r) => r.runId)).toEqual(["child"]);
  });
});

describe("parseCitedRunIds / oneLineTask", () => {
  it("去重、去空、封顶", () => {
    expect(parseCitedRunIds([" a ", "", "a", "b", 3, "c"], 2)).toEqual(["a", "b"]);
    expect(parseCitedRunIds("nope")).toEqual([]);
  });

  it("原任务压成一行", () => {
    expect(oneLineTask("第一行\n第二行")).toBe("第一行");
    expect(oneLineTask("x".repeat(90)).endsWith("…")).toBe(true);
    expect(oneLineTask("   \n  ")).toBe("");
  });
});

describe("resolveCiteArtifacts", () => {
  it("只报存在的主产物相对路径，不碰 transcript/events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cite-art-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "index.html"), "<html></html>");
    await mkdir(join(dir, "pm-spec"));
    await writeFile(join(dir, "pm-spec", "index.html"), "<html></html>");
    await writeFile(join(dir, "DESIGN.md"), "# brand\n");
    await mkdir(join(dir, ".agent-run-history", "r1"), { recursive: true });
    await writeFile(join(dir, ".agent-run-history", "r1", "transcript.jsonl"), "{}\n");
    await writeFile(join(dir, ".agent-run-history", "r1", "events.jsonl"), "{}\n");

    expect(await resolveCiteArtifacts(dir)).toEqual([
      "index.html",
      "pm-spec/index.html",
      "DESIGN.md",
    ]);
  });
});

describe("formatCiteBlock", () => {
  it("空列表不产出；有引用才写【引用】块", () => {
    expect(formatCiteBlock([])).toBe("");
    const block = formatCiteBlock([
      {
        runId: "run-a",
        title: "规格草案",
        task: "写一份产品规格",
        recap: "已写完目录。",
        artifacts: ["pm-spec/index.html", "DESIGN.md"],
      },
    ]);
    expect(block).toContain("【引用】");
    expect(block).toContain("规格草案（run-a）");
    expect(block).toContain("原任务：写一份产品规格");
    expect(block).toContain("收口：已写完目录。");
    expect(block).toContain("产物：pm-spec/index.html、DESIGN.md");
    expect(block).not.toContain("transcript");
    expect(block).not.toContain("events");
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  citeWorkdirLabel,
  formatCiteBlock,
  formatCiteChip,
  isCiteableRun,
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

describe("isCiteableRun / citeWorkdirLabel", () => {
  const spec = resolve("D:/proj/spec");
  const deck = resolve("D:/proj/deck");
  const other = resolve("D:/elsewhere/gamma");
  const allowed = [spec, deck, other];

  it("同项目跨 workdir 放行；其它项目 / 白名单外拒绝；无项目仍要求同目录", () => {
    const sameProject = {
      workdir: spec,
      projectId: "board-1",
      projectWorkdirs: [spec, deck],
      allowedWorkdirs: allowed,
    };
    expect(isCiteableRun({ workdir: deck, projectId: "board-1" }, sameProject)).toBe(true);
    expect(isCiteableRun({ workdir: deck }, sameProject)).toBe(true);
    expect(isCiteableRun({ workdir: other, projectId: "other-9" }, sameProject)).toBe(false);
    expect(isCiteableRun(
      { workdir: other, projectId: "board-1" },
      sameProject,
    )).toBe(false);
    expect(isCiteableRun(
      { workdir: resolve("D:/not-listed"), projectId: "board-1" },
      sameProject,
    )).toBe(false);

    const noProject = { workdir: spec, allowedWorkdirs: allowed };
    expect(isCiteableRun({ workdir: spec }, noProject)).toBe(true);
    expect(isCiteableRun({ workdir: deck }, noProject)).toBe(false);
  });

  it("芯片与目录标签只取末段", () => {
    expect(citeWorkdirLabel(spec)).toBe("spec");
    expect(formatCiteChip({ runId: "r1", title: "规格草案", workdirLabel: "spec" }))
      .toBe("规格草案 · spec");
    expect(formatCiteChip({ runId: "r1", title: "规格草案" })).toBe("规格草案");
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

  it("带目录标签以免跨 workdir 产物路径混在一起；仍不写 transcript", () => {
    const block = formatCiteBlock([
      {
        runId: "run-a",
        title: "规格草案",
        task: "写一份产品规格",
        recap: null,
        artifacts: ["pm-spec/index.html"],
        workdirLabel: "spec",
      },
    ]);
    expect(block).toContain("规格草案（run-a · spec）");
    expect(block).not.toContain("transcript");
    expect(block).not.toContain("events");
  });
});

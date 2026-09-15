import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory.js";
import {
  classifyMemoryScope,
  createProjectStatusTool,
  formatProjectStatusBlock,
  inProgressMemoryName,
  isSharedMemoryDir,
  parseProjectStatusMarkdown,
  projectSlugFromWorkdir,
  readProjectStatus,
  resolveProjectSlug,
  scopedMemoryIndex,
} from "../src/project-status.js";

describe("project slug / shared / classify", () => {
  it("slug 取 workdir 末段", () => {
    expect(projectSlugFromWorkdir("D:/work/alpha")).toBe("alpha");
    expect(projectSlugFromWorkdir("D:\\work\\alpha")).toBe("alpha");
  });

  it("选了项目实体时 slug 跟 id，非法 id 回落末段", () => {
    expect(resolveProjectSlug("D:/one/alpha", "board-1")).toBe("board-1");
    expect(resolveProjectSlug("D:/one/alpha", "not a slug!")).toBe("alpha");
    expect(resolveProjectSlug("D:/one/alpha")).toBe("alpha");
  });

  it("共享记忆目录：不是 <workdir>/.agent-memory", () => {
    expect(isSharedMemoryDir("D:/proj", "D:/proj/.agent-memory")).toBe(false);
    expect(isSharedMemoryDir("D:/proj", "D:/shared/memory")).toBe(true);
  });

  it("共享目录下未打标的根文件算 other；本目录算 current", () => {
    expect(
      classifyMemoryScope({ name: "kicad-notes.md", project: "alpha", shared: true }),
    ).toBe("other");
    expect(
      classifyMemoryScope({ name: "kicad-notes.md", project: "alpha", shared: false }),
    ).toBe("current");
    expect(
      classifyMemoryScope({ name: "lessons/shell.md", project: "alpha", shared: true }),
    ).toBe("global");
    expect(
      classifyMemoryScope({
        name: "in-progress.md",
        frontmatter: { kind: "in-progress", project: "alpha" },
        project: "alpha",
        shared: true,
      }),
    ).toBe("in-progress");
    expect(
      classifyMemoryScope({
        name: "projects/beta/in-progress.md",
        project: "alpha",
        shared: true,
      }),
    ).toBe("other");
    expect(inProgressMemoryName("alpha", true)).toBe("projects/alpha/in-progress.md");
    expect(inProgressMemoryName("alpha", false)).toBe("in-progress.md");
  });
});

describe("project_status tool + scoped index", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("写入进行中看板；索引只留本项目/全局/进行中", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "project-status-"));
    const workdir = path.join(dir, "alpha");
    const store = new MemoryStore(path.join(workdir, ".agent-memory"));
    const tool = createProjectStatusTool(() => store, {
      sharedFor: (wd) => isSharedMemoryDir(wd, store.dir),
    });
    const ctx = { workdir, toolUseId: "t1", signal: new AbortController().signal };

    await store.write("lessons/shell.md", "# Git Bash\n");
    await store.write("stray.md", "# 别的项目残留\n");

    const saved = await tool.execute(
      {
        summary: "规格待签字",
        waiting: ["委托方：规格签字"],
        nextGate: "规格确认门",
        decisions: ["要不要做三页幻灯"],
      },
      ctx,
    );
    expect(saved.isError).toBeFalsy();

    const status = await readProjectStatus(store, workdir, false);
    expect(status).toMatchObject({
      summary: "规格待签字",
      waiting: ["委托方：规格签字"],
      nextGate: "规格确认门",
      decisions: ["要不要做三页幻灯"],
      project: "alpha",
    });
    expect(parseProjectStatusMarkdown(await store.read("in-progress.md"), "alpha")?.summary).toBe(
      "规格待签字",
    );
    expect(formatProjectStatusBlock(status)).toContain("规格待签字");

    const localIndex = await scopedMemoryIndex(store, workdir);
    expect(localIndex).toContain("in-progress.md");
    expect(localIndex).toContain("lessons/shell.md");
    expect(localIndex).toContain("stray.md");

    const sharedStore = new MemoryStore(path.join(dir, "shared"));
    await sharedStore.write("lessons/shell.md", "# Git Bash\n");
    await sharedStore.write("stray.md", "# 别的项目残留\n");
    await sharedStore.write(
      "projects/alpha/in-progress.md",
      "---\nkind: in-progress\nproject: alpha\n---\n# 看板\n\n## 谁在等\n- （无）\n\n## 下一门\n（未指定）\n\n## 未决决策\n- （无）\n",
    );
    const sharedIndex = await scopedMemoryIndex(sharedStore, workdir);
    expect(sharedIndex).toContain("lessons/shell.md");
    expect(sharedIndex).toContain("projects/alpha/in-progress.md");
    expect(sharedIndex).not.toContain("stray.md");
  });

  it("共享记忆下两个同名目录用不同 project.id 互不覆盖", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "project-status-iso-"));
    const shared = new MemoryStore(path.join(dir, "shared"));
    const one = path.join(dir, "one", "alpha");
    const two = path.join(dir, "two", "alpha");
    const tool = createProjectStatusTool(() => shared, {
      sharedFor: () => true,
      resolveProject: (wd) => (wd.includes(`${path.sep}one${path.sep}`) || wd.includes("/one/")
        ? "proj-one"
        : "proj-two"),
    });
    const signal = new AbortController().signal;
    await tool.execute({ summary: "甲看板" }, { workdir: one, toolUseId: "t1", signal });
    await tool.execute({ summary: "乙看板" }, { workdir: two, toolUseId: "t2", signal });

    expect((await shared.read("projects/proj-one/in-progress.md"))).toContain("甲看板");
    expect((await shared.read("projects/proj-two/in-progress.md"))).toContain("乙看板");
    const indexOne = await scopedMemoryIndex(shared, one, "proj-one");
    const indexTwo = await scopedMemoryIndex(shared, two, "proj-two");
    expect(indexOne).toContain("projects/proj-one/in-progress.md");
    expect(indexOne).not.toContain("projects/proj-two/in-progress.md");
    expect(indexTwo).toContain("projects/proj-two/in-progress.md");
    expect(indexTwo).not.toContain("projects/proj-one/in-progress.md");
    expect(await readProjectStatus(shared, one, true, "proj-one")).toMatchObject({
      summary: "甲看板",
      project: "proj-one",
    });
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listWorkspaceFiles, parseWorkspaceFileQuery } from "../ui/workspace-files.js";

const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ws-files-"));
  temps.push(dir);
  return dir;
}

describe("parseWorkspaceFileQuery", () => {
  it("根前缀与子目录切开", () => {
    expect(parseWorkspaceFileQuery("hel")).toEqual({ dir: "", prefix: "hel" });
    expect(parseWorkspaceFileQuery("src/app")).toEqual({ dir: "src", prefix: "app" });
    expect(parseWorkspaceFileQuery("src\\app")).toEqual({ dir: "src", prefix: "app" });
  });
});

describe("listWorkspaceFiles", () => {
  it("浅列文件和目录，跳过隐藏、凭据和 node_modules", async () => {
    const root = await scratch();
    await writeFile(join(root, "hello.txt"), "x");
    await writeFile(join(root, ".env"), "SECRET=1");
    await writeFile(join(root, ".hidden.txt"), "x");
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "src", "app.js"), "x");

    const { files } = await listWorkspaceFiles(root, "");
    const names = files.map((f) => f.name);
    expect(names).toContain("hello.txt");
    expect(names).toContain("src");
    expect(names).not.toContain(".env");
    expect(names).not.toContain(".hidden.txt");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain("app.js");
    expect(files.find((f) => f.name === "src")?.kind).toBe("directory");
  });

  it("q 带目录前缀只列那一层", async () => {
    const root = await scratch();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "app.js"), "x");
    await writeFile(join(root, "src", "other.ts"), "x");
    await writeFile(join(root, "hello.txt"), "x");

    const { files } = await listWorkspaceFiles(root, "src/a");
    expect(files.map((f) => f.relative)).toEqual(["src/app.js"]);
    expect(files.some((f) => f.relative === "hello.txt")).toBe(false);
  });

  it("圈外路径空列表，不抛", async () => {
    const root = await scratch();
    const { files } = await listWorkspaceFiles(root, "../secret");
    expect(files).toEqual([]);
  });

  it("带 q 时按文件名深搜，不把圈外和凭据列出来", async () => {
    const root = await scratch();
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await writeFile(join(root, "src", "nested", "app.js"), "x");
    await writeFile(join(root, "hello.txt"), "x");
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "pkg", "app.js"), "x");
    await writeFile(join(root, ".env.app"), "SECRET=1");

    const { files } = await listWorkspaceFiles(root, "app");
    expect(files.map((f) => f.relative)).toEqual(["src/nested/app.js"]);
    expect(files.some((f) => f.relative.includes("node_modules"))).toBe(false);
    expect(files.some((f) => f.name.startsWith(".env"))).toBe(false);

    const escaped = await listWorkspaceFiles(root, "../app");
    expect(escaped.files).toEqual([]);
  });
});

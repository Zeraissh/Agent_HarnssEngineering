/**
 * MEM-02/03 记忆合同：工具写入 ↔ Web list/read 同形；resolveMemoryDir 唯一目录源。
 *
 * 不做：加密、同步、多租户、事件自动摄入。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryTools,
  MemoryStore,
  resolveMemoryDir,
} from "../src/memory.js";
import { createUiServer, type UiServerHandle } from "../ui/server.js";
import { FakeModelClient } from "./helpers.js";
import type { Tool } from "../src/types.js";

describe("resolveMemoryDir", () => {
  it("AGENT_MEMORY_DIR 覆盖，否则 <workdir>/.agent-memory", () => {
    const workdir = join("proj", "a");
    expect(resolveMemoryDir(workdir, {})).toBe(join(workdir, ".agent-memory"));
    expect(resolveMemoryDir(workdir, { AGENT_MEMORY_DIR: join("custom", "mem") })).toBe(
      join("custom", "mem"),
    );
  });

  it("与 MemoryStore.NAME_RE 导出一致", () => {
    expect(MemoryStore.NAME_RE.test("lessons/foo.md")).toBe(true);
    expect(MemoryStore.NAME_RE.test("../x.md")).toBe(false);
  });
});

describe("memory contract: tool write → Web list/read", () => {
  let handle: UiServerHandle | undefined;
  let dir: string;
  let savedMemoryDir: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "memory-contract-"));
    savedMemoryDir = process.env.AGENT_MEMORY_DIR;
    delete process.env.AGENT_MEMORY_DIR;
  });

  afterEach(async () => {
    if (savedMemoryDir === undefined) delete process.env.AGENT_MEMORY_DIR;
    else process.env.AGENT_MEMORY_DIR = savedMemoryDir;
    await handle?.close();
    handle = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  function byName(tools: Tool[], name: string): Tool {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`missing tool ${name}`);
    return t;
  }

  async function boot(): Promise<string> {
    handle = createUiServer({
      modelClient: new FakeModelClient([]),
      tools: [],
      workdir: dir,
      packsDir: null,
    });
    const port = await new Promise<number>((resolve, reject) => {
      handle!.server.listen(0, () => {
        const address = handle!.server.address();
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("no port"));
      });
      handle!.server.on("error", reject);
    });
    return `http://127.0.0.1:${port}`;
  }

  it("memory_write 嵌套路径后，GET list/read 同名同文同摘要", async () => {
    const memDir = resolveMemoryDir(dir);
    const store = new MemoryStore(memDir);
    const tools = createMemoryTools(store);
    const ctx = { workdir: dir, toolUseId: "t1", signal: new AbortController().signal };
    const content =
      "---\nsourceRunId: run-abc\nupdatedAt: 2026-09-10T00:00:00.000Z\n---\n" +
      "# Windows shell 教训\n\n用 Git Bash，别用 cmd 冒充。\n";

    await byName(tools, "memory_write").execute(
      { name: "lessons/windows-shell.md", content },
      ctx,
    );

    const base = await boot();
    const listRes = await fetch(`${base}/api/memory`);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      dir: string;
      entries: Array<{ name: string; summary: string; sizeBytes: number }>;
    };
    expect(list.dir).toBe(memDir);
    const entry = list.entries.find((e) => e.name === "lessons/windows-shell.md");
    expect(entry).toBeDefined();
    expect(entry!.summary).toBe("Windows shell 教训");
    expect(entry!.sizeBytes).toBe(Buffer.byteLength(content, "utf8"));

    const readRes = await fetch(`${base}/api/memory/lessons%2Fwindows-shell.md`);
    expect(readRes.status).toBe(200);
    const body = (await readRes.json()) as { name: string; content: string };
    expect(body.name).toBe("lessons/windows-shell.md");
    expect(body.content).toBe(content);

    const storeListed = await store.list();
    expect(storeListed.find((e) => e.name === "lessons/windows-shell.md")?.summary).toBe(
      "Windows shell 教训",
    );
  });

  it("可选 frontmatter 不破坏首行摘要规则", async () => {
    const store = new MemoryStore(resolveMemoryDir(dir));
    await store.write(
      "meta.md",
      "---\nsourceRunId: x\nupdatedAt: 2026-01-01T00:00:00Z\n---\n第一行摘要\n其余\n",
    );
    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.summary).toBe("第一行摘要");
  });
});

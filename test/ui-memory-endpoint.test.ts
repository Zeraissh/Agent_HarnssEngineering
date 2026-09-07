/**
 * T5 记忆端点契约测试——GET /api/memory 与 GET /api/memory/:name。
 *
 * 全用注入的 FakeModelClient + 临时 workdir（其下手工摆 .agent-memory/），
 * 不碰真实端点、不需要 API key。
 *
 * 覆盖：
 *   a. 目录不存在 → 200 空列表（不报错）
 *   b. 列表条目含 名称 / 摘要（去 # 前缀）/ 大小 / 修改时间
 *   c. 读取单条记忆全文（内容往返一致）
 *   d. 未知名字 → 404；非法名字（无 .md / 含 .. / 含斜杠）→ 404（路由层圈禁）
 *   e. 超过 256KB → 截断 + truncated 标记
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiServer, type UiServerHandle } from "../ui/server.js";
import { FakeModelClient } from "./helpers.js";

function startServer(handle: UiServerHandle): Promise<number> {
  return new Promise((resolve, reject) => {
    handle.server.listen(0, () => {
      const address = handle.server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("Could not get server port"));
    });
    handle.server.on("error", reject);
  });
}

interface MemoryEntryDto {
  name: string;
  summary: string;
  sizeBytes: number;
  mtimeMs: number | null;
}

describe("T5 /api/memory 记忆端点", () => {
  let handle: UiServerHandle | undefined;
  let dir: string;
  let savedMemoryDir: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ui-memory-api-"));
    // defaultMemoryDir 优先读 AGENT_MEMORY_DIR——测试期间必须摘掉它，
    // 否则端点会指向宿主真实记忆目录而不是临时目录
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

  async function boot(): Promise<string> {
    handle = createUiServer({
      modelClient: new FakeModelClient([]),
      tools: [],
      workdir: dir,
    });
    return `http://127.0.0.1:${await startServer(handle)}`;
  }

  async function seedMemory(name: string, content: string): Promise<void> {
    await mkdir(join(dir, ".agent-memory"), { recursive: true });
    await writeFile(join(dir, ".agent-memory", name), content, "utf8");
  }

  it("a. .agent-memory 目录不存在 → 200 空列表", async () => {
    const base = await boot();
    const res = await fetch(`${base}/api/memory`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dir: string; entries: MemoryEntryDto[] };
    expect(body.entries).toEqual([]);
    expect(body.dir).toContain(".agent-memory");
  });

  it("b. 列表返回名称 / 摘要 / 大小 / 修改时间", async () => {
    await seedMemory("deploy-ports.md", "# 部署端口\n\nStaging 7788\n");
    await seedMemory("plain.md", "第一行就是摘要\n其余内容\n");
    const base = await boot();
    const res = await fetch(`${base}/api/memory`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: MemoryEntryDto[] };
    expect(body.entries.map((e) => e.name)).toEqual(["deploy-ports.md", "plain.md"]);
    const first = body.entries[0]!;
    expect(first.summary).toBe("部署端口"); // # 前缀被剥掉
    expect(first.sizeBytes).toBeGreaterThan(0);
    expect(typeof first.mtimeMs).toBe("number");
    expect(first.mtimeMs).toBeGreaterThan(0);
    expect(body.entries[1]!.summary).toBe("第一行就是摘要");
  });

  it("c. 读取单条记忆全文，内容往返一致", async () => {
    const text = "# 教训\n\nWindows 下用 npm.cmd。\n- 第二条\n";
    await seedMemory("shell-lessons.md", text);
    const base = await boot();
    const res = await fetch(`${base}/api/memory/shell-lessons.md`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string; content: string; sizeBytes: number; truncated: boolean;
    };
    expect(body.name).toBe("shell-lessons.md");
    expect(body.content).toBe(text);
    expect(body.sizeBytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(body.truncated).toBe(false);
  });

  it("d. 未知名字 404；非法名字在路由层圈禁（404）", async () => {
    await seedMemory("exists.md", "内容\n");
    const base = await boot();

    const missing = await fetch(`${base}/api/memory/nope.md`);
    expect(missing.status).toBe(404);

    // 无 .md 后缀
    expect((await fetch(`${base}/api/memory/foo`)).status).toBe(404);
    // 非 .md 文件
    expect((await fetch(`${base}/api/memory/foo.txt`)).status).toBe(404);
    // 路径穿越（百分号编码的 ../ 也挡）
    expect((await fetch(`${base}/api/memory/..%2Fsecret.md`)).status).toBe(404);
    expect((await fetch(`${base}/api/memory/..%2F..%2Fpackage.json.md`)).status).toBe(404);
    // 子目录（名字字符集不含 "/"）
    expect((await fetch(`${base}/api/memory/sub%2Fdir.md`)).status).toBe(404);
    // 真文件仍在，圈禁不影响合法读取
    expect((await fetch(`${base}/api/memory/exists.md`)).status).toBe(200);
  });

  it("e. 超过 256KB 的记忆截断并标注 truncated", async () => {
    const big = "甲".repeat(100_000); // 300KB UTF-8
    await seedMemory("big.md", big);
    const base = await boot();
    const res = await fetch(`${base}/api/memory/big.md`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; sizeBytes: number; truncated: boolean };
    expect(body.truncated).toBe(true);
    expect(body.sizeBytes).toBe(300_000);
    expect(Buffer.byteLength(body.content, "utf8")).toBeLessThanOrEqual(256 * 1024);
    expect(body.content.length).toBeLessThan(big.length);
  });
});

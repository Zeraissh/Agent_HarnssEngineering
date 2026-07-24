/**
 * L5 — Memory：文件式跨会话记忆。
 *
 * 设计决策（对应 docs/01 的原则）：
 * - 一条记忆 = 一个文件；**索引不落盘**，list 时从每个文件首行实时提取摘要——
 *   不依赖模型自觉维护 MEMORY.md（P6：不变量靠 harness，不靠 prompt 纪律）；
 * - 记忆工具是 P2 "晋升为专用工具" 的正面案例：写操作被硬性圈禁在 memoryDir 内，
 *   这个不变量让 memory_write 可以 permission: "auto"——而通用 write_file 必须 ask；
 * - 记忆索引每次 run 开始时经 dynamicContext 注入 messages（P3：易变信息不进 system）。
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "./types.js";

/** 单条记忆上限：记忆是"值得复用的事实/教训"，不是数据仓库 */
const MAX_MEMORY_BYTES = 64 * 1024;
/** 合法记忆名：相对路径、常规字符，杜绝逃逸与怪名 */
const NAME_RE = /^[\w][\w\-./]*\.md$/;

export interface MemoryEntry {
  name: string;
  /** 文件首个非空行（去掉 # 前缀），截断到 80 字符 */
  summary: string;
  sizeBytes: number;
}

export class MemoryStore {
  constructor(readonly dir: string) {}

  private resolvePath(name: string): string {
    if (!NAME_RE.test(name) || name.includes("..")) {
      throw new Error(
        `Invalid memory name "${name}". Use a relative path of word characters ending in .md, e.g. "deploy-port.md" or "lessons/windows-shell.md".`,
      );
    }
    const resolved = path.resolve(this.dir, name);
    const rel = path.relative(path.resolve(this.dir), resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Memory name escapes the memory directory: "${name}"`);
    }
    return resolved;
  }

  async list(): Promise<MemoryEntry[]> {
    let names: string[];
    try {
      const entries = await readdir(this.dir, { recursive: true, withFileTypes: true });
      names = entries
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => path.relative(this.dir, path.join(e.parentPath, e.name)).replaceAll("\\", "/"))
        .sort();
    } catch {
      return []; // 目录不存在 = 还没有记忆
    }
    const out: MemoryEntry[] = [];
    for (const name of names) {
      const text = await readFile(path.join(this.dir, name), "utf8");
      out.push({ name, summary: firstLineSummary(text), sizeBytes: Buffer.byteLength(text, "utf8") });
    }
    return out;
  }

  async read(name: string): Promise<string> {
    return readFile(this.resolvePath(name), "utf8");
  }

  async write(name: string, content: string): Promise<void> {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_MEMORY_BYTES) {
      throw new Error(
        `Memory too large (${bytes} bytes > ${MAX_MEMORY_BYTES}). Memories are reusable facts/lessons, not data storage — distill it.`,
      );
    }
    const resolved = this.resolvePath(name);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, content, "utf8");
  }

  async delete(name: string): Promise<void> {
    await rm(this.resolvePath(name), { force: false });
  }

  /** 注入 dynamicContext 用的索引文本：模型开局即知自己记得什么 */
  async indexBlock(): Promise<string> {
    const entries = await this.list();
    if (entries.length === 0) return "(no memories yet)";
    return entries.map((e) => `- ${e.name}: ${e.summary}`).join("\n");
  }
}

function firstLineSummary(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const clean = line.replace(/^#+\s*/, "").trim();
  return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean;
}

/** 由一个 MemoryStore 派生出四个记忆工具（工厂：一个 agent 一套，互不串味） */
export function createMemoryTools(store: MemoryStore): Tool[] {
  const memoryList: Tool = {
    name: "memory_list",
    description:
      "List all stored memories with one-line summaries. Call this when the memory index in your context seems insufficient and you want to re-check what has been remembered.",
    inputSchema: { type: "object", properties: {} },
    permission: "auto",
    parallelSafe: true,
    async execute() {
      return { content: await store.indexBlock() };
    },
  };

  const memoryRead: Tool = {
    name: "memory_read",
    description:
      "Read the full content of one memory file. Call this before relying on a remembered fact — the index only shows summaries.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: 'Memory file name, e.g. "deploy-port.md"' } },
      required: ["name"],
    },
    permission: "auto",
    parallelSafe: true,
    async execute(input) {
      const { name } = input as { name: string };
      return { content: await store.read(name) };
    },
  };

  const memoryWrite: Tool = {
    name: "memory_write",
    description:
      "Create or update a memory file that persists across sessions. Call this when you learn a durable fact, user preference, or lesson worth reusing later (a correction you received, a project constant, an approach that worked). One fact per file; put a one-line summary on the first line. Do NOT store things already recorded in the repository, or transient task state.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: 'Relative .md file name, e.g. "deploy-port.md" or "lessons/windows-shell.md"' },
        content: { type: "string", description: "Memory content; first line = one-line summary" },
      },
      required: ["name", "content"],
    },
    // 写盘却 auto：因为被圈禁在 memoryDir 内 —— 这正是"晋升为专用工具"的收益（P2）
    permission: "auto",
    parallelSafe: false,
    async execute(input) {
      const { name, content } = input as { name: string; content: string };
      await store.write(name, content);
      return { content: `Memory saved: ${name}` };
    },
  };

  const memoryDelete: Tool = {
    name: "memory_delete",
    description:
      "Delete a memory file. Call this when a memory turns out to be wrong or obsolete — stale memories are worse than no memories.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Memory file name to delete" } },
      required: ["name"],
    },
    permission: "auto",
    parallelSafe: false,
    async execute(input) {
      const { name } = input as { name: string };
      await store.delete(name);
      return { content: `Memory deleted: ${name}` };
    },
  };

  return [memoryList, memoryRead, memoryWrite, memoryDelete];
}

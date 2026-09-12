/**
 * 项目进行中看板：谁在等、下一门、未决决策。
 *
 * 教训笔记（memory_write）仍然禁止临时任务状态。进行中状态走本模块的
 * 保留文件 in-progress.md（共享记忆目录时为 projects/<slug>/in-progress.md），
 * 与 lessons/ 分开，注入 dynamicContext.project_status。
 */
import path from "node:path";
import type { MemoryEntry, MemoryStore } from "./memory.js";
import type { Tool, ToolContext } from "./types.js";

export const IN_PROGRESS_BASENAME = "in-progress.md";
export const PROJECT_STATUS_TOOL = "project_status";

export type MemoryScope = "in-progress" | "current" | "global" | "other";

export type ProjectStatus = {
  summary: string;
  waiting: string[];
  nextGate: string;
  decisions: string[];
  updatedAt: string;
  project: string;
};

const SLUG_RE = /^[\w][\w.-]{0,63}$/;

export function projectSlugFromWorkdir(workdir: string): string {
  const base = path.basename(path.resolve(String(workdir ?? "").trim() || "."));
  const slug = base.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return SLUG_RE.test(slug) ? slug : "project";
}

export function isSharedMemoryDir(
  workdir: string,
  memoryDir: string,
): boolean {
  const scoped = path.resolve(path.join(workdir, ".agent-memory"));
  return path.resolve(memoryDir) !== scoped;
}

export function inProgressMemoryName(project: string, shared: boolean): string {
  const slug = SLUG_RE.test(project) ? project : "project";
  return shared ? `projects/${slug}/${IN_PROGRESS_BASENAME}` : IN_PROGRESS_BASENAME;
}

export function parseMemoryFrontmatter(text: string): Record<string, string> {
  const raw = String(text ?? "");
  if (!raw.startsWith("---")) return {};
  const firstNl = raw.indexOf("\n");
  if (firstNl < 0) return {};
  const rest = raw.slice(firstNl + 1);
  const close = rest.match(/\n---[ \t]*(?:\r?\n|$)/);
  if (!close || close.index === undefined) return {};
  const block = rest.slice(0, close.index);
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    out[m[1]!.toLowerCase()] = m[2]!;
  }
  return out;
}

export function classifyMemoryScope(opts: {
  name: string;
  frontmatter?: Record<string, string>;
  project: string;
  shared: boolean;
}): MemoryScope {
  const name = opts.name.replaceAll("\\", "/");
  const fm = opts.frontmatter ?? {};
  const tagged = String(fm.project ?? "").trim();
  const scope = String(fm.scope ?? "").trim().toLowerCase();
  const kind = String(fm.kind ?? "").trim().toLowerCase();
  const isInProgress =
    kind === "in-progress" || name === IN_PROGRESS_BASENAME || name.endsWith(`/${IN_PROGRESS_BASENAME}`);

  if (isInProgress) {
    if (!opts.shared) return "in-progress";
    if (tagged && tagged !== opts.project) return "other";
    if (name.startsWith("projects/") && !name.startsWith(`projects/${opts.project}/`)) return "other";
    return "in-progress";
  }
  if (scope === "global" || name.startsWith("lessons/")) return "global";
  if (tagged && tagged !== "*" && tagged !== opts.project) return "other";
  if (name.startsWith("projects/")) {
    return name.startsWith(`projects/${opts.project}/`) ? "current" : "other";
  }
  return opts.shared ? "other" : "current";
}

export function formatProjectStatusMarkdown(status: ProjectStatus): string {
  const waiting = status.waiting.length ? status.waiting.map((w) => `- ${w}`).join("\n") : "- （无）";
  const decisions = status.decisions.length ? status.decisions.map((d) => `- ${d}`).join("\n") : "- （无）";
  return [
    "---",
    "kind: in-progress",
    `project: ${status.project}`,
    `updatedAt: ${status.updatedAt}`,
    "---",
    `# ${status.summary}`,
    "",
    "## 谁在等",
    waiting,
    "",
    "## 下一门",
    status.nextGate || "（未指定）",
    "",
    "## 未决决策",
    decisions,
    "",
  ].join("\n");
}

function listFromSection(body: string, heading: string): string[] {
  const re = new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  const m = body.match(re);
  if (!m) return [];
  return m[1]!
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => line && line !== "（无）");
}

export function parseProjectStatusMarkdown(
  text: string,
  fallbackProject: string,
): ProjectStatus | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const fm = parseMemoryFrontmatter(raw);
  const after = raw.startsWith("---")
    ? raw.replace(/^---[\s\S]*?\n---[ \t]*\r?\n?/, "")
    : raw;
  const summaryLine = after.split("\n").find((l) => l.trim()) ?? "";
  const summary = summaryLine.replace(/^#+\s*/, "").trim();
  if (!summary) return null;
  const nextGateMatch = after.match(/##\s+下一门\s*\n([\s\S]*?)(?=\n##\s+|$)/i);
  const nextGate = (nextGateMatch?.[1] ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && l !== "（未指定）") ?? "";
  return {
    summary,
    waiting: listFromSection(after, "谁在等"),
    nextGate,
    decisions: listFromSection(after, "未决决策"),
    updatedAt: fm.updatedat || "",
    project: fm.project || fallbackProject,
  };
}

export function formatProjectStatusBlock(status: ProjectStatus | null): string {
  if (!status) return "(no in-progress board)";
  const waiting = status.waiting.length ? status.waiting.join("；") : "（无）";
  const decisions = status.decisions.length ? status.decisions.join("；") : "（无）";
  return [
    `summary: ${status.summary}`,
    `waiting: ${waiting}`,
    `nextGate: ${status.nextGate || "（未指定）"}`,
    `decisions: ${decisions}`,
  ].join("\n");
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v ?? "").trim()).filter(Boolean).slice(0, 20);
}

type StoreResolver = (workdir: string) => MemoryStore;

export function createProjectStatusTool(
  resolveStore: StoreResolver,
  opts?: { sharedFor?: (workdir: string) => boolean },
): Tool {
  return {
    name: PROJECT_STATUS_TOOL,
    description:
      "Replace the current project's in-progress board (who is waiting, next gate, open decisions). " +
      "This is allowed task state. Do NOT put it in memory_write — lessons stay durable facts. " +
      "Call when a gate, owner, or open decision changes; pass clear=true to delete the board.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One-line status of what is in flight" },
        waiting: {
          type: "array",
          items: { type: "string" },
          description: "Who is blocked on whom, e.g. \"委托方：规格签字\"",
        },
        nextGate: { type: "string", description: "The next decision or review gate" },
        decisions: {
          type: "array",
          items: { type: "string" },
          description: "Open decisions that are not yet logged as decided",
        },
        clear: { type: "boolean", description: "Delete the in-progress board" },
      },
    },
    permission: "auto",
    parallelSafe: false,
    async execute(input, ctx: ToolContext) {
      const store = resolveStore(ctx.workdir);
      const project = projectSlugFromWorkdir(ctx.workdir);
      const shared = opts?.sharedFor?.(ctx.workdir) ?? false;
      const name = inProgressMemoryName(project, shared);
      const body = (input ?? {}) as {
        summary?: unknown;
        waiting?: unknown;
        nextGate?: unknown;
        decisions?: unknown;
        clear?: unknown;
      };
      if (body.clear === true) {
        try {
          await store.delete(name);
        } catch {
          /* 没有看板也算清掉 */
        }
        return { content: `In-progress board cleared: ${name}` };
      }
      const summary = String(body.summary ?? "").trim();
      if (!summary) {
        return { content: "summary is required unless clear=true.", isError: true };
      }
      const status: ProjectStatus = {
        summary: summary.slice(0, 200),
        waiting: asStringList(body.waiting),
        nextGate: String(body.nextGate ?? "").trim().slice(0, 200),
        decisions: asStringList(body.decisions),
        updatedAt: new Date().toISOString(),
        project,
      };
      await store.write(name, formatProjectStatusMarkdown(status));
      return { content: `In-progress board saved: ${name}` };
    },
  };
}

export async function readProjectStatus(
  store: MemoryStore,
  workdir: string,
  shared: boolean,
): Promise<ProjectStatus | null> {
  const project = projectSlugFromWorkdir(workdir);
  const name = inProgressMemoryName(project, shared);
  try {
    const text = await store.read(name);
    return parseProjectStatusMarkdown(text, project);
  } catch {
    return null;
  }
}

export async function annotateMemoryEntries(
  store: MemoryStore,
  workdir: string,
): Promise<Array<MemoryEntry & { scope: MemoryScope }>> {
  const shared = isSharedMemoryDir(workdir, store.dir);
  const project = projectSlugFromWorkdir(workdir);
  const entries = await store.list();
  const out: Array<MemoryEntry & { scope: MemoryScope }> = [];
  for (const entry of entries) {
    let frontmatter: Record<string, string> = {};
    try {
      frontmatter = parseMemoryFrontmatter(await store.read(entry.name));
    } catch {
      /* 列出后被删：按无 frontmatter 归类 */
    }
    out.push({
      ...entry,
      scope: classifyMemoryScope({
        name: entry.name,
        frontmatter,
        project,
        shared,
      }),
    });
  }
  return out;
}

export async function scopedMemoryIndex(store: MemoryStore, workdir: string): Promise<string> {
  const kept = (await annotateMemoryEntries(store, workdir)).filter((entry) => entry.scope !== "other");
  if (kept.length === 0) return "(no memories yet)";
  return kept.map((entry) => `- ${entry.name}: ${entry.summary}`).join("\n");
}

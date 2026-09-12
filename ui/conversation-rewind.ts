/**
 * 对话回退：按 seq 裁事件，并按写盘快照（可选 git）还原工作区。
 *
 * 父档案只读。子 run 是裁过的快照，不启动模型。
 * 文件还原只保证 write_file / edit_file / write_pptx / generate_image
 * 在调用前记下的 before 镜像；bash / MCP 写出的不假装能退。
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, unlink, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Tool, ToolContext } from "../src/types.js";
import { resolveInWorkdir } from "../src/tools/fs-util.js";

function isExecutorLineageSource(source: string): boolean {
  return source === "main" || source === "rework";
}

const execFileAsync = promisify(execFile);

export const REWIND_SNAPSHOT_TOOLS = new Set([
  "write_file",
  "edit_file",
  "write_pptx",
  "generate_image",
]);

export const MAX_REWIND_SNAPSHOT_BYTES = 8 * 1024 * 1024;

export const REWIND_BOOTSTRAP_TYPES = new Set([
  "run_start",
  "run_config",
  "pack_route",
  "design_route",
  "execution_boundary",
  "hooks_config",
]);

export type RewindWrite = {
  seq: number;
  toolUseId: string;
  tool: string;
  path: string;
};

export type FileRewindRecord = {
  toolUseId: string;
  tool: string;
  path: string;
  existed: boolean;
  bytes: number;
  skipped?: "too_large" | "unreadable";
  at: number;
};

export type FileRevertAction = {
  path: string;
  action: "restore" | "delete" | "git" | "skip";
  toolUseId?: string;
  reason?: string;
};

export type FileRevertResult = {
  restored: string[];
  deleted: string[];
  gitRestored: string[];
  skipped: { path: string; reason: string }[];
};

export type SSELike = {
  seq: number;
  source: string;
  ts?: number;
  event: { type?: string; [k: string]: unknown };
};

export type TranscriptSeg = {
  index: number;
  source: string;
  messages: unknown[];
};

export function parseRewindRequest(body: unknown):
  | { ok: true; seq: number; revertFiles: boolean }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "请求体必须是 JSON 对象，且带整数 seq" };
  }
  const raw = body as { seq?: unknown; revertFiles?: unknown };
  if (!Number.isInteger(raw.seq) || (raw.seq as number) < -1) {
    return { ok: false, error: '"seq" 必须是 ≥ -1 的整数（-1 = 回到开场任务）' };
  }
  if (raw.revertFiles !== undefined && typeof raw.revertFiles !== "boolean") {
    return { ok: false, error: '"revertFiles" 必须是布尔值' };
  }
  return { ok: true, seq: raw.seq as number, revertFiles: raw.revertFiles === true };
}

export function truncateEventsToSeq<T extends SSELike>(events: T[], seq: number): T[] {
  if (seq === -1) {
    return events.filter((e) => REWIND_BOOTSTRAP_TYPES.has(String(e.event?.type ?? "")));
  }
  return events.filter((e) => Number.isInteger(e.seq) && e.seq <= seq);
}

export function conversationTurnFromEvents(events: SSELike[]): number {
  let turn = 1;
  for (const e of events) {
    if (e.event?.type !== "user_message") continue;
    const n = Number(e.event.turn);
    if (Number.isInteger(n) && n > turn) turn = n;
  }
  return turn;
}

export function pickTranscriptForRewind(
  events: SSELike[],
  transcript: TranscriptSeg[],
): { transcript: TranscriptSeg[]; history?: unknown[]; segmentIndex: number } {
  const doneCount = events.filter((e) => e.event?.type === "done").length;
  const kept = transcript.slice(0, Math.min(doneCount, transcript.length));
  const history = [...kept].reverse().find((seg) => isExecutorLineageSource(seg.source))?.messages;
  return {
    transcript: kept,
    ...(history?.length ? { history: structuredClone(history) } : {}),
    segmentIndex: kept.length,
  };
}

export function writesAfterSeq(events: SSELike[], cutSeq: number): RewindWrite[] {
  const out: RewindWrite[] = [];
  for (const e of events) {
    if (!Number.isInteger(e.seq) || e.seq <= cutSeq) continue;
    if (e.event?.type !== "tool_call") continue;
    const tool = String(e.event.name ?? "");
    if (!REWIND_SNAPSHOT_TOOLS.has(tool)) continue;
    const path = String((e.event.input as { path?: unknown } | undefined)?.path ?? "").trim();
    const toolUseId = String(e.event.toolUseId ?? "");
    if (!path || !toolUseId) continue;
    out.push({ seq: e.seq, toolUseId, tool, path });
  }
  return out;
}

export function planFileRevert(
  writes: RewindWrite[],
  snapshots: Map<string, FileRewindRecord>,
): FileRevertAction[] {
  const byPath = new Map<string, RewindWrite[]>();
  for (const w of writes) {
    const list = byPath.get(w.path) ?? [];
    list.push(w);
    byPath.set(w.path, list);
  }
  const actions: FileRevertAction[] = [];
  for (const [path, list] of byPath) {
    const ordered = [...list].sort((a, b) => b.seq - a.seq);
    const usable = ordered.filter((w) => {
      const snap = snapshots.get(w.toolUseId);
      if (!snap || snap.skipped) return false;
      return snap.existed === false || snap.bytes >= 0;
    });
    if (usable.length === 0) {
      actions.push({ path, action: "git", reason: "no_snapshot" });
      continue;
    }
    for (const w of usable) {
      const snap = snapshots.get(w.toolUseId)!;
      if (!snap.existed) {
        actions.push({ path, action: "delete", toolUseId: w.toolUseId });
      } else if (snap.skipped) {
        actions.push({ path, action: "skip", toolUseId: w.toolUseId, reason: snap.skipped });
      } else {
        actions.push({ path, action: "restore", toolUseId: w.toolUseId });
      }
    }
  }
  return actions;
}

export function sanitizeRewindBlobId(toolUseId: string): string {
  const cleaned = String(toolUseId ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.slice(0, 180) || "unknown";
}

export async function captureBeforeWrite(
  workdir: string,
  writeRoots: string[] | undefined,
  rel: string,
  toolUseId: string,
  tool: string,
): Promise<{ record: FileRewindRecord; blob?: Buffer }> {
  const at = Date.now();
  let abs: string;
  try {
    abs = resolveInWorkdir(workdir, rel, writeRoots);
  } catch {
    return {
      record: { toolUseId, tool, path: rel, existed: false, bytes: 0, skipped: "unreadable", at },
    };
  }
  try {
    const blob = await readFile(abs);
    if (blob.length > MAX_REWIND_SNAPSHOT_BYTES) {
      return {
        record: {
          toolUseId,
          tool,
          path: rel,
          existed: true,
          bytes: blob.length,
          skipped: "too_large",
          at,
        },
      };
    }
    return {
      record: { toolUseId, tool, path: rel, existed: true, bytes: blob.length, at },
      blob,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { record: { toolUseId, tool, path: rel, existed: false, bytes: 0, at } };
    }
    return {
      record: { toolUseId, tool, path: rel, existed: false, bytes: 0, skipped: "unreadable", at },
    };
  }
}

export function wrapToolsWithRewindSnapshots(
  tools: Tool[],
  capture: (tool: string, input: unknown, ctx: ToolContext) => Promise<void>,
): Tool[] {
  return tools.map((tool) => {
    if (!REWIND_SNAPSHOT_TOOLS.has(tool.name)) return tool;
    return {
      ...tool,
      async execute(input, ctx) {
        try {
          await capture(tool.name, input, ctx);
        } catch {
          // 快照失败不得挡住写入
        }
        return tool.execute(input, ctx);
      },
    };
  });
}

export async function persistRewindSnapshot(
  archiveDir: string,
  record: FileRewindRecord,
  blob?: Buffer,
): Promise<void> {
  const dir = join(archiveDir, "rewinds");
  await mkdir(dir, { recursive: true });
  if (blob && !record.skipped) {
    await writeFile(join(dir, sanitizeRewindBlobId(record.toolUseId)), blob);
  }
  await appendFile(join(archiveDir, "rewinds.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
}

export async function loadRewindSnapshots(
  archiveDir: string,
): Promise<{ records: FileRewindRecord[]; blobs: Map<string, Buffer> }> {
  const records: FileRewindRecord[] = [];
  const blobs = new Map<string, Buffer>();
  let raw = "";
  try {
    raw = await readFile(join(archiveDir, "rewinds.jsonl"), "utf8");
  } catch {
    return { records, blobs };
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as FileRewindRecord;
      if (!parsed?.toolUseId || !parsed.path) continue;
      records.push(parsed);
    } catch {
      // 半行跳过
    }
  }
  for (const rec of records) {
    if (rec.skipped || !rec.existed) continue;
    try {
      blobs.set(rec.toolUseId, await readFile(join(archiveDir, "rewinds", sanitizeRewindBlobId(rec.toolUseId))));
    } catch {
      // 缺 blob 的记录在还原时走 skip / git
    }
  }
  return { records, blobs };
}

async function isGitTracked(gitRoot: string, rel: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", gitRoot, "ls-files", "--error-unmatch", "--", rel], {
      timeout: 8000,
      windowsHide: true,
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}

export async function applyFileRevert(opts: {
  workdir: string;
  writeRoots?: string[];
  gitRoot?: string | null;
  writes: RewindWrite[];
  snapshots: Map<string, { record: FileRewindRecord; blob?: Buffer }>;
}): Promise<FileRevertResult> {
  const records = new Map<string, FileRewindRecord>();
  for (const [id, row] of opts.snapshots) records.set(id, row.record);
  const plan = planFileRevert(opts.writes, records);
  const result: FileRevertResult = { restored: [], deleted: [], gitRestored: [], skipped: [] };
  const gitTried = new Set<string>();

  for (const step of plan) {
    let abs: string;
    try {
      abs = resolveInWorkdir(opts.workdir, step.path, opts.writeRoots);
    } catch {
      result.skipped.push({ path: step.path, reason: "out_of_scope" });
      continue;
    }
    if (step.action === "delete") {
      try {
        await unlink(abs);
        result.deleted.push(step.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") result.deleted.push(step.path);
        else result.skipped.push({ path: step.path, reason: "delete_failed" });
      }
      continue;
    }
    if (step.action === "restore") {
      const row = step.toolUseId ? opts.snapshots.get(step.toolUseId) : undefined;
      if (!row?.blob) {
        result.skipped.push({ path: step.path, reason: row?.record.skipped ?? "missing_blob" });
        continue;
      }
      try {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, row.blob);
        result.restored.push(step.path);
      } catch {
        result.skipped.push({ path: step.path, reason: "restore_failed" });
      }
      continue;
    }
    if (step.action === "git") {
      if (!opts.gitRoot || gitTried.has(step.path)) {
        if (!opts.gitRoot) result.skipped.push({ path: step.path, reason: step.reason ?? "no_snapshot" });
        continue;
      }
      gitTried.add(step.path);
      const tracked = await isGitTracked(opts.gitRoot, step.path);
      if (!tracked) {
        result.skipped.push({ path: step.path, reason: "untracked_no_snapshot" });
        continue;
      }
      try {
        await execFileAsync("git", ["-C", opts.gitRoot, "checkout", "HEAD", "--", step.path], {
          timeout: 8000,
          windowsHide: true,
          encoding: "utf8",
        });
        result.gitRestored.push(step.path);
      } catch {
        result.skipped.push({ path: step.path, reason: "git_restore_failed" });
      }
      continue;
    }
    result.skipped.push({ path: step.path, reason: step.reason ?? "skip" });
  }
  return result;
}

export function parseRewindFromMeta(
  value: unknown,
): { parentRunId: string; seq: number; revertFiles: boolean } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.parentRunId !== "string" || !raw.parentRunId.trim()) return undefined;
  if (!Number.isInteger(raw.seq) || (raw.seq as number) < -1) return undefined;
  return {
    parentRunId: raw.parentRunId,
    seq: raw.seq as number,
    revertFiles: raw.revertFiles === true,
  };
}

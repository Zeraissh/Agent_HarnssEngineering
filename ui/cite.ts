/**
 * 点名引用：同项目（任一成员 workdir）会话的产物清单与【引用】装配块。
 * 无项目时仍只放行同一 resolve(workdir)。
 * 不读 transcript / events；不猜邻居任务。
 */
import { basename, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { resolveInWorkdir } from "../src/tools/fs-util.js";

export const CITE_ARTIFACT_RELS = [
  "index.html",
  "pm-spec/index.html",
  "deck-basic/index.html",
  "DESIGN.md",
] as const;

export type CiteRef = {
  runId: string;
  title: string;
  task: string;
  recap: string | null;
  artifacts: string[];
  /** 成员目录末段，避免同名产物路径混在一起 */
  workdirLabel?: string;
};

export type CiteRunHint = {
  workdir?: string | null;
  projectId?: string | null;
};

export type CiteScope = {
  workdir: string;
  projectId?: string | null;
  projectWorkdirs?: string[];
  allowedWorkdirs: Iterable<string>;
};

/** 芯片 / 【引用】块上的目录标签：只取末段，不拼绝对路径。 */
export function citeWorkdirLabel(workdir: string): string {
  const trimmed = String(workdir ?? "").trim().replace(/[\\/]+$/, "");
  return basename(trimmed) || trimmed;
}

/**
 * 放行：目标有 projectId 时，同项目任一（已入项且在白名单内的）workdir；
 * 无项目时仍要求同一 resolve(workdir)。
 * 白名单外 / 其它项目一律跳过。
 */
export function isCiteableRun(
  run: CiteRunHint,
  scope: CiteScope,
  resolvePath: (p: string) => string = resolve,
): boolean {
  const rawDir = String(run.workdir ?? "").trim();
  if (!rawDir) return false;
  let runDir: string;
  try {
    runDir = resolvePath(rawDir);
  } catch {
    return false;
  }
  const allowed = new Set<string>();
  for (const item of scope.allowedWorkdirs) {
    try {
      allowed.add(resolvePath(item));
    } catch {
      /* 非法白名单项：忽略 */
    }
  }
  if (!allowed.has(runDir)) return false;

  const scopeProject = String(scope.projectId ?? "").trim();
  const runProject = String(run.projectId ?? "").trim();
  if (scopeProject) {
    if (runProject && runProject !== scopeProject) return false;
    const members = new Set<string>();
    for (const item of scope.projectWorkdirs ?? []) {
      try {
        members.add(resolvePath(item));
      } catch {
        /* 非法成员路径：忽略 */
      }
    }
    if (members.size) return members.has(runDir);
    return runProject === scopeProject;
  }
  try {
    return runDir === resolvePath(scope.workdir);
  } catch {
    return false;
  }
}

export function visibleCiteRuns<T extends { runId: string; continuedFrom?: string | null }>(
  runs: T[],
): T[] {
  const superseded = new Set<string>();
  for (const r of runs) {
    if (r.continuedFrom) superseded.add(r.continuedFrom);
  }
  return runs.filter((r) => !superseded.has(r.runId));
}

export function parseCitedRunIds(raw: unknown, max = 8): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of raw) {
    if (typeof id !== "string") continue;
    const t = id.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export function oneLineTask(task: string, max = 80): string {
  const line = String(task ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  if (line.length <= max) return line;
  return `${line.slice(0, Math.max(1, max - 1))}…`;
}

export async function resolveCiteArtifacts(workdir: string): Promise<string[]> {
  const found: string[] = [];
  for (const rel of CITE_ARTIFACT_RELS) {
    try {
      const abs = resolveInWorkdir(workdir, rel);
      const st = await stat(abs);
      if (st.isFile()) found.push(rel);
    } catch {
      /* 不存在或越界：跳过，不猜路径 */
    }
  }
  return found;
}

export function formatCiteChip(ref: { title?: string; task?: string; runId: string; workdirLabel?: string }): string {
  const name = String(ref.title || ref.task || ref.runId).trim() || ref.runId;
  const label = String(ref.workdirLabel ?? "").trim();
  return label ? `${name} · ${label}` : name;
}

export function formatCiteBlock(refs: CiteRef[]): string {
  if (!refs.length) return "";
  const lines = ["【引用】"];
  for (const ref of refs) {
    const loc = String(ref.workdirLabel ?? "").trim();
    lines.push(loc ? `- ${ref.title}（${ref.runId} · ${loc}）` : `- ${ref.title}（${ref.runId}）`);
    if (ref.task) lines.push(`  原任务：${ref.task}`);
    if (ref.recap) lines.push(`  收口：${ref.recap}`);
    if (ref.artifacts.length) lines.push(`  产物：${ref.artifacts.join("、")}`);
  }
  return lines.join("\n");
}

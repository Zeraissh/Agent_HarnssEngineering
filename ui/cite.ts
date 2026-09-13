/**
 * 点名引用：同 workdir 会话的产物清单与【引用】装配块。
 * 不读 transcript / events；不猜邻居任务。
 */
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
};

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

export function formatCiteBlock(refs: CiteRef[]): string {
  if (!refs.length) return "";
  const lines = ["【引用】"];
  for (const ref of refs) {
    lines.push(`- ${ref.title}（${ref.runId}）`);
    if (ref.task) lines.push(`  原任务：${ref.task}`);
    if (ref.recap) lines.push(`  收口：${ref.recap}`);
    if (ref.artifacts.length) lines.push(`  产物：${ref.artifacts.join("、")}`);
  }
  return lines.join("\n");
}

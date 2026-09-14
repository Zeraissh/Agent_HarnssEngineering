/**
 * 产物画廊：按 CITE_ARTIFACT_RELS 扫 workdir，并判断画册是否相对规格过期。
 *
 * 不改 cite 的同 workdir 候选政策——那边另一条线会放宽。这里只复用 rel 清单
 * 与圈禁（resolveInWorkdir），多目录扫描由调用方传入项目成员路径。
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { CITE_ARTIFACT_RELS } from "./cite.js";
import { resolveInWorkdir } from "../src/tools/fs-util.js";

export type ArtifactKind = "landing" | "spec" | "deck" | "design";

export type DirFingerprint = {
  exists: boolean;
  mtimeMs: number;
  hash: string;
};

export type ArtifactCard = {
  rel: string;
  workdir: string;
  kind: ArtifactKind;
  title: string;
  mtimeMs: number;
  runId: string | null;
  deckStale: boolean;
};

export const ARTIFACT_KIND_ORDER: Record<ArtifactKind, number> = {
  landing: 0,
  spec: 1,
  deck: 2,
  design: 3,
};

const TITLE_BY_REL: Record<string, string> = {
  "index.html": "落地页",
  "pm-spec/index.html": "产品规格",
  "deck-basic/index.html": "幻灯画册",
  "DESIGN.md": "设计说明",
};

const KIND_BY_REL: Record<string, ArtifactKind> = {
  "index.html": "landing",
  "pm-spec/index.html": "spec",
  "deck-basic/index.html": "deck",
  "DESIGN.md": "design",
};

const HASH_MAX_BYTES = 2_000_000;

export function artifactKindForRel(rel: string): ArtifactKind | null {
  return KIND_BY_REL[String(rel ?? "")] ?? null;
}

export function artifactTitleForRel(rel: string): string {
  const key = String(rel ?? "");
  return TITLE_BY_REL[key] ?? key.split(/[\\/]/).filter(Boolean).pop() ?? key;
}

/**
 * 规格新于画册 → 过期。缺任一侧都不标（没有画册就没有「已过期」徽章）。
 * 用目录树最大 mtime：改 pm-spec/ 里任意文件也算规格更新。不自动重做。
 */
export function isDeckStale(
  spec: Pick<DirFingerprint, "exists" | "mtimeMs"> | null | undefined,
  deck: Pick<DirFingerprint, "exists" | "mtimeMs"> | null | undefined,
): boolean {
  if (!spec?.exists || !deck?.exists) return false;
  return spec.mtimeMs > deck.mtimeMs;
}

export function compareArtifactCards(a: ArtifactCard, b: ArtifactCard): number {
  const kind = (ARTIFACT_KIND_ORDER[a.kind] ?? 99) - (ARTIFACT_KIND_ORDER[b.kind] ?? 99);
  if (kind !== 0) return kind;
  if (a.workdir !== b.workdir) return a.workdir.localeCompare(b.workdir);
  return a.rel.localeCompare(b.rel);
}

export async function fingerprintArtifactTree(
  workdir: string,
  dirRel: string,
): Promise<DirFingerprint> {
  const empty: DirFingerprint = { exists: false, mtimeMs: 0, hash: "" };
  let root: string;
  try {
    root = resolveInWorkdir(workdir, dirRel);
  } catch {
    return empty;
  }
  let rootStat: Awaited<ReturnType<typeof stat>>;
  try {
    rootStat = await stat(root);
  } catch {
    return empty;
  }

  const files: string[] = [];
  if (rootStat.isFile()) {
    files.push(root);
  } else if (rootStat.isDirectory()) {
    files.push(...await listFiles(root));
  } else {
    return empty;
  }

  if (files.length === 0) {
    return { exists: true, mtimeMs: rootStat.mtimeMs, hash: createHash("sha256").update("empty").digest("hex") };
  }

  files.sort((x, y) => x.localeCompare(y));
  const hash = createHash("sha256");
  let mtimeMs = 0;
  for (const abs of files) {
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
    const rel = posixRel(root, abs);
    hash.update(rel);
    hash.update("\0");
    if (st.size > HASH_MAX_BYTES) {
      hash.update(`size:${st.size}`);
    } else {
      try {
        hash.update(await readFile(abs));
      } catch {
        hash.update(`missing:${rel}`);
      }
    }
    hash.update("\n");
  }
  return { exists: true, mtimeMs: mtimeMs || rootStat.mtimeMs, hash: hash.digest("hex") };
}

export async function listCiteArtifactsInWorkdir(workdir: string): Promise<Omit<ArtifactCard, "runId" | "deckStale">[]> {
  const root = resolve(workdir);
  const hits: Omit<ArtifactCard, "runId" | "deckStale">[] = [];
  for (const rel of CITE_ARTIFACT_RELS) {
    try {
      const abs = resolveInWorkdir(root, rel);
      const st = await stat(abs);
      if (!st.isFile()) continue;
      const kind = artifactKindForRel(rel);
      if (!kind) continue;
      hits.push({
        rel,
        workdir: root,
        kind,
        title: artifactTitleForRel(rel),
        mtimeMs: st.mtimeMs,
      });
    } catch {
      /* 不存在或越界：跳过，不猜路径 */
    }
  }
  return hits;
}

export async function collectWorkdirArtifactCards(
  workdir: string,
  runId: string | null = null,
): Promise<ArtifactCard[]> {
  const hits = await listCiteArtifactsInWorkdir(workdir);
  const spec = await fingerprintArtifactTree(workdir, "pm-spec");
  const deck = await fingerprintArtifactTree(workdir, "deck-basic");
  const stale = isDeckStale(spec, deck);
  return hits.map((hit) => ({
    ...hit,
    runId,
    deckStale: hit.kind === "deck" ? stale : false,
  }));
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) out.push(abs);
    }
  }
  return out;
}

function posixRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

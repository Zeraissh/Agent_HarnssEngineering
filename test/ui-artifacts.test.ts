/**
 * 产物画廊扫描与画册过期（不启宿主）。
 */
import { describe, expect, it } from "vitest";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CITE_ARTIFACT_RELS } from "../ui/cite.js";
import {
  artifactKindForRel,
  artifactTitleForRel,
  collectWorkdirArtifactCards,
  compareArtifactCards,
  fingerprintArtifactTree,
  isDeckStale,
  listCiteArtifactsInWorkdir,
} from "../ui/artifacts.js";

describe("artifactKindForRel / title", () => {
  it("与 CITE_ARTIFACT_RELS 四条对齐", () => {
    expect(CITE_ARTIFACT_RELS).toEqual([
      "index.html",
      "pm-spec/index.html",
      "deck-basic/index.html",
      "DESIGN.md",
    ]);
    expect(artifactKindForRel("index.html")).toBe("landing");
    expect(artifactKindForRel("pm-spec/index.html")).toBe("spec");
    expect(artifactKindForRel("deck-basic/index.html")).toBe("deck");
    expect(artifactKindForRel("DESIGN.md")).toBe("design");
    expect(artifactKindForRel("other.md")).toBeNull();
    expect(artifactTitleForRel("deck-basic/index.html")).toBe("幻灯画册");
  });
});

describe("isDeckStale", () => {
  it("缺规格或缺画册都不标过期", () => {
    expect(isDeckStale(null, { exists: true, mtimeMs: 2 })).toBe(false);
    expect(isDeckStale({ exists: true, mtimeMs: 2 }, null)).toBe(false);
    expect(isDeckStale({ exists: false, mtimeMs: 9 }, { exists: true, mtimeMs: 1 })).toBe(false);
    expect(isDeckStale({ exists: true, mtimeMs: 9 }, { exists: false, mtimeMs: 1 })).toBe(false);
  });

  it("规格 mtime 新于画册 → 过期；画册更新或同时刻 → 不过期", () => {
    expect(isDeckStale({ exists: true, mtimeMs: 20 }, { exists: true, mtimeMs: 10 })).toBe(true);
    expect(isDeckStale({ exists: true, mtimeMs: 10 }, { exists: true, mtimeMs: 20 })).toBe(false);
    expect(isDeckStale({ exists: true, mtimeMs: 10 }, { exists: true, mtimeMs: 10 })).toBe(false);
  });
});

describe("扫描 workdir 与目录指纹", () => {
  it("只列出 CITE_ARTIFACT_RELS 里真实存在的文件；规格新则画册卡 deckStale", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-scan-"));
    await writeFile(join(dir, "index.html"), "<html>landing</html>");
    await writeFile(join(dir, "DESIGN.md"), "# design");
    await mkdir(join(dir, "pm-spec"));
    await mkdir(join(dir, "deck-basic"));
    const specFile = join(dir, "pm-spec", "index.html");
    const deckFile = join(dir, "deck-basic", "index.html");
    await writeFile(specFile, "<html>spec-v2</html>");
    await writeFile(deckFile, "<html>deck-v1</html>");
    const old = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-02-01T00:00:00Z");
    await utimes(deckFile, old, old);
    await utimes(specFile, newer, newer);

    const listed = await listCiteArtifactsInWorkdir(dir);
    expect(listed.map((a) => a.rel).sort()).toEqual([
      "DESIGN.md",
      "deck-basic/index.html",
      "index.html",
      "pm-spec/index.html",
    ]);

    const spec = await fingerprintArtifactTree(dir, "pm-spec");
    const deck = await fingerprintArtifactTree(dir, "deck-basic");
    expect(spec.exists).toBe(true);
    expect(deck.exists).toBe(true);
    expect(spec.mtimeMs).toBeGreaterThan(deck.mtimeMs);
    expect(spec.hash).not.toBe(deck.hash);

    const cards = await collectWorkdirArtifactCards(dir, "run-1");
    const deckCard = cards.find((c) => c.kind === "deck");
    expect(deckCard?.deckStale).toBe(true);
    expect(deckCard?.runId).toBe("run-1");
    expect(cards.filter((c) => c.kind !== "deck").every((c) => c.deckStale === false)).toBe(true);

    const sorted = [...cards].sort(compareArtifactCards);
    expect(sorted.map((c) => c.kind)).toEqual(["landing", "spec", "deck", "design"]);
  });

  it("画册新于规格则不过期", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-fresh-"));
    await mkdir(join(dir, "pm-spec"));
    await mkdir(join(dir, "deck-basic"));
    const specFile = join(dir, "pm-spec", "index.html");
    const deckFile = join(dir, "deck-basic", "index.html");
    await writeFile(specFile, "<html>spec</html>");
    await writeFile(deckFile, "<html>deck</html>");
    const old = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-03-01T00:00:00Z");
    await utimes(specFile, old, old);
    await utimes(deckFile, newer, newer);
    const cards = await collectWorkdirArtifactCards(dir);
    expect(cards.find((c) => c.kind === "deck")?.deckStale).toBe(false);
  });
});

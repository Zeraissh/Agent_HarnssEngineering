import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CARD_PNG_NO_FRAMES,
  findPngFrames,
  MINIMAL_PNG,
  pngRelPathsForHtml,
  requirePngFrames,
} from "../src/card-png.js";

describe("findPngFrames", () => {
  it("认 data-card 与 data-size", () => {
    const html = `
      <article class="card" data-card="cover" data-size="1080x1080"></article>
      <article data-card="2" data-size="800x800"></article>
    `;
    expect(findPngFrames(html)).toEqual([
      { id: "cover", selector: '[data-card="cover"]', width: 1080, height: 1080 },
      { id: "2", selector: '[data-card="2"]', width: 800, height: 800 },
    ]);
  });

  it("没有契约卡 → 拒绝", () => {
    expect(findPngFrames("<section class=\"slide\" data-slide=\"1\"></section>")).toEqual([]);
    expect(() => requirePngFrames("<html></html>")).toThrowError(/data-card/);
    try {
      requirePngFrames("<html></html>");
    } catch (err) {
      expect((err as { code?: string }).code).toBe(CARD_PNG_NO_FRAMES);
    }
  });

  it("pngRelPathsForHtml 一张同茎，多张加序号", () => {
    expect(pngRelPathsForHtml("cards/index.html", 1)).toEqual(["cards/index.png"]);
    expect(pngRelPathsForHtml("cards/index.html", 3)).toEqual([
      "cards/index-1.png",
      "cards/index-2.png",
      "cards/index-3.png",
    ]);
  });

  it("social-basic 种子有三张卡", async () => {
    const html = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "design", "social-basic", "index.html"),
      "utf8",
    );
    const frames = findPngFrames(html);
    expect(frames).toHaveLength(3);
    expect(frames.every((f) => f.width === 1080 && f.height === 1080)).toBe(true);
    expect(html).toMatch(/data-look="ink"/);
    expect(MINIMAL_PNG.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
  });
});

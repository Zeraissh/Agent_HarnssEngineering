import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  convertDeckHtmlToPptx,
  DECK_PPTX_NO_SLIDES,
  DeckPptxError,
  deckSlideTitle,
  joinHtmlRelative,
  lookFromHtml,
  parseCssTheme,
  parseDeckHtml,
  pptxRelPathForHtml,
  readPptxOutline,
  relativeStylesheetHrefs,
} from "../src/deck-pptx.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

async function readFixture(...parts: string[]): Promise<string> {
  return readFile(join(repo, ...parts), "utf8");
}

/** 抽出 ppt/slides/slideN.xml 文本。只出标题的映射会让正文断言红。 */
function pptxSlideXml(buf: Buffer): string {
  const parts: string[] = [];
  let i = 0;
  while (i + 30 <= buf.length) {
    if (buf.readUInt32LE(i) !== 0x04034b50) {
      i += 1;
      continue;
    }
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString("utf8");
    const dataStart = i + 30 + nameLen + extraLen;
    if (dataStart + compSize > buf.length) break;
    const data = buf.subarray(dataStart, dataStart + compSize);
    let raw = data;
    if (method === 8) {
      try {
        raw = inflateRawSync(data);
      } catch {
        i = dataStart + compSize;
        continue;
      }
    } else if (method !== 0) {
      i = dataStart + compSize;
      continue;
    }
    if (/^ppt\/slides\/slide\d+\.xml$/i.test(name)) {
      parts.push(raw.toString("utf8"));
    }
    i = dataStart + compSize;
  }
  return parts.join("\n");
}

describe("deck HTML 契约解析", () => {
  it("deck-basic：3 页，标题对上主张 / 三点 / 收束", async () => {
    const html = await readFixture("templates", "design", "deck-basic", "index.html");
    const css = await readFixture("templates", "design", "deck-basic", "style.css");
    const ir = parseDeckHtml(html, css);
    expect(ir.slides).toHaveLength(3);
    expect(ir.slides.map(deckSlideTitle)).toEqual(["一页一个主张", "三点结构", "收束"]);
    const bullets = ir.slides[1]!.blocks.find((b) => b.kind === "bullets");
    expect(bullets?.kind === "bullets" ? bullets.items.length : 0).toBeGreaterThanOrEqual(3);
    expect(relativeStylesheetHrefs(html)).toEqual(["style.css"]);
  });

  it("ruile-deck：8 页，概览 4 个 stat，tc 规格表行数不少於 HTML", async () => {
    const html = await readFixture("ruile-deck", "index.html");
    const css = await readFixture("ruile-deck", "style.css");
    const md = await readFixture("ruile-deck", "DESIGN.md");
    const ir = parseDeckHtml(html, css, md);
    expect(ir.slides).toHaveLength(8);
    expect(ir.slides.map((s) => s.id)).toEqual([
      "cover", "overview", "tc", "rtd", "wls", "ams", "ats", "contact",
    ]);
    const overview = ir.slides.find((s) => s.id === "overview");
    const stats = overview?.blocks.find((b) => b.kind === "stats");
    expect(stats?.kind === "stats" ? stats.items : []).toHaveLength(4);
    expect(stats?.kind === "stats" ? stats.items.map((x) => x.num) : []).toEqual([
      "2016", "500", "2", "12",
    ]);

    const tcHtmlRows = (html.match(/data-slide="tc"[\s\S]*?<\/section>/) ?? [""])[0]
      .match(/<tr\b/g)?.length ?? 0;
    const tc = ir.slides.find((s) => s.id === "tc");
    const product = tc?.blocks.find((b) => b.kind === "productGrid");
    const tableRows = product?.kind === "productGrid" ? product.spec?.table?.rows ?? [] : [];
    expect(tableRows.length).toBeGreaterThanOrEqual(tcHtmlRows);
    expect(tableRows.some((row) => row.includes("产品型号"))).toBe(true);
    expect(ir.theme.accent).toBe("22D3EE");
    expect(ir.theme.bg).toBe("0A1628");
    expect(ir.lossy.some((l) => l.includes("翻页提示") || l.includes("渐变字"))).toBe(true);
  });

  it("无 .slide 的 HTML fail-closed，不装成空 deck", () => {
    expect(() => parseDeckHtml("<html><body><h1>落地页</h1></body></html>")).toThrow(DeckPptxError);
    try {
      parseDeckHtml("<html><body><p>hi</p></body></html>");
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DeckPptxError);
      expect((err as DeckPptxError).code).toBe(DECK_PPTX_NO_SLIDES);
    }
  });

  it("色板读 :root 与 DESIGN.md 表", () => {
    const theme = parseCssTheme(
      ":root { --bg: #111111; --fg: #eeeeee; --accent: #3b82f6; --muted: #888888; --bg-panel: #222222; }",
      "| `--accent` | `#00ff00` |\n- bg: #abcdef",
    );
    expect(theme.bg).toBe("111111");
    expect(theme.accent).toBe("3B82F6");
    expect(theme.panel).toBe("222222");
    const fromMd = parseCssTheme("", "| `--fg` | `#f2f7ff` |");
    expect(fromMd.fg).toBe("F2F7FF");
  });

  it("html[data-look] 取对应皮，不误读 CSS 里最后一套", async () => {
    const css = await readFixture("templates", "design", "deck-basic", "style.css");
    expect(lookFromHtml('<html lang="zh-CN" data-look="paper">')).toBe("paper");
    const ink = parseCssTheme(css);
    const paper = parseCssTheme(css, "", "paper");
    expect(ink.bg).toBe("0F1419");
    expect(ink.accent).toBe("3B82F6");
    expect(paper.bg).toBe("F4F1EA");
    expect(paper.accent).toBe("B0522F");
  });

  it("pptx 相对路径与样式 href", () => {
    expect(pptxRelPathForHtml("out/index.html")).toBe("out/index.pptx");
    expect(pptxRelPathForHtml("deck.htm")).toBe("deck.pptx");
    expect(joinHtmlRelative("talks/index.html", "style.css")).toBe("talks/style.css");
    expect(relativeStylesheetHrefs(
      `<link rel="stylesheet" href="https://cdn.example/x.css"><link rel="stylesheet" href="./theme.css">`,
    )).toEqual(["theme.css"]);
  });
});

describe("DeckIR → pptxgenjs", () => {
  it("deck-basic 写出 PK 魔数，正文/条目进 OOXML（只出标题必须红）", async () => {
    const html = await readFixture("templates", "design", "deck-basic", "index.html");
    const css = await readFixture("templates", "design", "deck-basic", "style.css");
    const { ir, bytes } = await convertDeckHtmlToPptx({ html, css });
    expect(ir.slides).toHaveLength(3);
    expect(bytes.subarray(0, 2).toString("ascii")).toBe("PK");
    const outline = readPptxOutline(bytes);
    expect(outline.slideCount).toBe(3);
    const texts = outline.slides.flatMap((s) => s.texts);
    expect(texts).toEqual(expect.arrayContaining(["一页一个主张", "三点结构", "收束"]));
    const xml = pptxSlideXml(bytes);
    expect(xml).toContain("入口必须是可预览");
    expect(xml).toContain("色板写进");
  });

  it("子目录相对样式 + 中文页标题进写出的 pptx", async () => {
    const html = `<!doctype html>
<html lang="zh-CN"><head>
<title>中文稿</title>
<link rel="stylesheet" href="../theme.css">
</head><body>
<section class="slide" data-slide="cover"><h1 class="hero">封面主张</h1></section>
<section class="slide" data-slide="p2"><h2>第二页标题</h2><ul class="bullets"><li>要点甲</li></ul></section>
</body></html>`;
    const css = ":root { --bg: #101010; --fg: #f5f5f5; --accent: #cc0033; --muted: #888888; }";
    expect(relativeStylesheetHrefs(html)).toEqual(["../theme.css"]);
    expect(joinHtmlRelative("幻灯/子/index.html", "../theme.css")).toBe("幻灯/子/../theme.css");
    const { ir, bytes } = await convertDeckHtmlToPptx({ html, css });
    expect(ir.slides.map(deckSlideTitle)).toEqual(["封面主张", "第二页标题"]);
    expect(ir.theme.accent).toBe("CC0033");
    const outline = readPptxOutline(bytes);
    expect(outline.slideCount).toBe(2);
    expect(outline.slides.flatMap((s) => s.texts)).toEqual(
      expect.arrayContaining(["封面主张", "第二页标题", "要点甲"]),
    );
  });

  it("ruile-deck 写出 8 页，规格表单元格进 OOXML", async () => {
    const html = await readFixture("ruile-deck", "index.html");
    const css = await readFixture("ruile-deck", "style.css");
    const { ir, bytes } = await convertDeckHtmlToPptx({ html, css });
    expect(ir.slides).toHaveLength(8);
    expect(bytes.subarray(0, 2).toString("ascii")).toBe("PK");
    const xml = pptxSlideXml(bytes);
    expect(xml).toContain("广东瑞乐半导体科技有限公司");
    expect(xml).toContain("产品型号");
    expect(xml).toContain("TCW-4");
    expect(xml).toContain("成立年份");
  });
});

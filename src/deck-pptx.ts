/**
 * 契约绑定的 HTML 幻灯 → PPTX。
 *
 * 只认 design 包的 section.slide[data-slide]，不还原 CSS 盒模型，不引 jsdom。
 * 创作源仍是 HTML；本模块产出可编辑的 pptxgenjs 形状。
 */
import { inflateRawSync } from "node:zlib";
import pptxgen from "pptxgenjs";

type PptxSlide = {
  background: { color?: string };
  addNotes: (notes: string) => void;
  addText: (text: unknown, opts?: Record<string, unknown>) => void;
  addTable: (rows: unknown, opts?: Record<string, unknown>) => void;
  addShape: (name: string, opts?: Record<string, unknown>) => void;
};

function createPres() {
  const Ctor = pptxgen as unknown as {
    new (): {
      layout: string;
      title: string;
      author: string;
      addSlide: () => PptxSlide;
      write: (opts: { outputType: "nodebuffer" }) => Promise<string | ArrayBuffer | Blob | Uint8Array>;
    };
  };
  return new Ctor();
}

export const DECK_PPTX_NO_SLIDES = "NO_SLIDES";

export class DeckPptxError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DeckPptxError";
    this.code = code;
  }
}

export function isDeckPptxError(err: unknown): err is DeckPptxError {
  return err instanceof DeckPptxError;
}

export type DeckTheme = {
  bg: string;
  fg: string;
  accent: string;
  muted: string;
  panel: string;
};

export type DeckStat = { num: string; unit?: string; label: string };

export type DeckZone = {
  title?: string;
  bullets: string[];
  paragraphs: string[];
  table?: { rows: string[][] };
};

export type DeckBlock =
  | { kind: "kicker"; text: string }
  | { kind: "hero"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "lede"; text: string }
  | { kind: "meta"; text: string }
  | { kind: "source"; text: string }
  | { kind: "bullets"; items: string[] }
  | { kind: "stats"; items: DeckStat[] }
  | { kind: "columns"; columns: DeckZone[] }
  | { kind: "productGrid"; spec?: DeckZone; zones: DeckZone[] };

export type DeckSlide = {
  id: string;
  label: string;
  cover: boolean;
  blocks: DeckBlock[];
  notes: string;
};

export type DeckIR = {
  title: string;
  theme: DeckTheme;
  slides: DeckSlide[];
  lossy: string[];
};

const DEFAULT_THEME: DeckTheme = {
  bg: "0F1419",
  fg: "F4F1EA",
  accent: "3B82F6",
  muted: "A8A29A",
  panel: "1A222C",
};

export function pptxRelPathForHtml(htmlPath: string): string {
  const norm = String(htmlPath ?? "").replace(/\\/g, "/").trim();
  return norm.replace(/\.html?$/i, "") + ".pptx";
}

/** 相对 HTML 所在目录拼接 href（`..` 原样保留，交给 resolveInWorkdir 拒逃逸）。 */
export function joinHtmlRelative(htmlPath: string, href: string): string {
  const base = String(htmlPath ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  const rel = String(href ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  const dir = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
  return dir ? `${dir}/${rel}` : rel;
}

export function deckSlideTitle(slide: DeckSlide): string {
  for (const block of slide.blocks) {
    if (block.kind === "hero" || block.kind === "heading") return block.text;
  }
  return slide.label;
}

export type PptxOutline = {
  slideCount: number;
  /** 每页全部 a:t，按出现顺序。封面 kicker 可能排在标题前。 */
  slides: { texts: string[] }[];
};

/**
 * 读回 pptxgenjs 写出的 ZIP：页数 + 每页文本。
 * pptxgen 没有公开 load API；这是对它写出的 OOXML 的行为读回，不是通用导入器。
 */
export function readPptxOutline(buf: Buffer | Uint8Array): PptxOutline {
  const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const files = zipLocalTexts(raw)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/i.test(f.name))
    .sort((a, b) => slideXmlIndex(a.name) - slideXmlIndex(b.name));
  return {
    slideCount: files.length,
    slides: files.map((f) => ({ texts: extractATexts(f.text) })),
  };
}

function slideXmlIndex(name: string): number {
  const m = name.match(/slide(\d+)\.xml$/i);
  return m ? Number(m[1]) : 0;
}

function extractATexts(xml: string): string[] {
  const out: string[] = [];
  const re = /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const t = decodeEntities(m[1] ?? "").trim();
    if (t) out.push(t);
  }
  return out;
}

/** 抽出 ppt/slides/slideN.xml 等本地文件的解压文本。只认 deflate / store。 */
function zipLocalTexts(buf: Buffer): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
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
    out.push({ name, text: raw.toString("utf8") });
    i = dataStart + compSize;
  }
  return out;
}

export function relativeStylesheetHrefs(html: string): string[] {
  const out: string[] = [];
  const re = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if (!/rel\s*=\s*(["'])stylesheet\1/i.test(tag)) continue;
    const href = attr(tag, "href");
    if (!href || /^(https?:)?\/\//i.test(href) || href.startsWith("data:")) continue;
    out.push(href.replace(/^\.\//, ""));
  }
  return out;
}

export function lookFromHtml(html: string): string | undefined {
  const open = html.match(/<html\b[^>]*>/i)?.[0];
  if (!open) return undefined;
  const look = attr(open, "data-look")?.trim();
  return look && /^[a-z0-9-]+$/i.test(look) ? look : undefined;
}

export function parseCssTheme(css: string, designMd?: string, look?: string): DeckTheme {
  const theme = { ...DEFAULT_THEME };
  const fromCss = readCssVars(css, look);
  const fromMd = readDesignMdColors(designMd ?? "");
  applyColor(theme, "bg", fromCss.bg ?? fromMd.bg);
  applyColor(theme, "fg", fromCss.fg ?? fromMd.fg);
  applyColor(theme, "accent", fromCss.accent ?? fromMd.accent);
  applyColor(theme, "muted", fromCss.muted ?? fromMd.muted);
  applyColor(theme, "panel", fromCss.panel ?? fromCss.bgPanel ?? fromMd.panel);
  return theme;
}

export function parseDeckHtml(html: string, cssText?: string, designMd?: string): DeckIR {
  const lossy: string[] = [];
  const css = cssText ?? extractInlineCss(html);
  const theme = parseCssTheme(css, designMd, lookFromHtml(html));
  recordThemeLossy(css, lossy);
  const title = textOfFirst(html, "title") || "Deck";
  const slides: DeckSlide[] = [];

  const openRe = /<section\b/gi;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html))) {
    const openEnd = html.indexOf(">", m.index);
    if (openEnd < 0) break;
    const openTag = html.slice(m.index, openEnd + 1);
    if (!classList(openTag).includes("slide")) continue;
    const closed = matchClose(html, m.index, "section");
    if (!closed) continue;
    const id = attr(openTag, "data-slide") ?? String(slides.length + 1);
    const label = decodeEntities(attr(openTag, "aria-label") ?? "");
    const cover = classList(openTag).includes("slide-cover");
    slides.push(parseSlide(id, label, cover, closed.inner, lossy));
    openRe.lastIndex = closed.end;
  }

  if (slides.length === 0) {
    throw new DeckPptxError(
      DECK_PPTX_NO_SLIDES,
      "HTML 没有 section.slide[data-slide]，拒绝转换",
    );
  }
  return { title, theme, slides, lossy };
}

export async function convertDeckHtmlToPptx(opts: {
  html: string;
  css?: string;
  designMd?: string;
}): Promise<{ ir: DeckIR; bytes: Buffer }> {
  const ir = parseDeckHtml(opts.html, opts.css, opts.designMd);
  const bytes = await emitDeckPptx(ir);
  return { ir, bytes };
}

function parseSlide(
  id: string,
  label: string,
  coverHint: boolean,
  inner: string,
  lossy: string[],
): DeckSlide {
  const frag = new Fragment(inner);
  const blocks: DeckBlock[] = [];
  const notes: string[] = [];

  for (const hint of frag.takeAll("hint")) {
    const t = stripTags(hint.inner);
    if (t) {
      lossy.push(`${id}: 翻页提示未进正文（${clip(t, 40)}）`);
      notes.push(t);
    }
  }

  const product = frag.takeAll("product-grid")[0];
  const twoCol = frag.takeAll("two-col")[0];
  const contact = frag.takeAll("contact-grid")[0];
  const stats = frag.takeAll("stat-grid")[0];
  const head = frag.takeAll("slide-head")[0];

  if (head) pushHeadBlocks(head.inner, blocks);
  else {
    takeTextBlock(frag, "kicker", "kicker", blocks);
    takeTextBlock(frag, "hero", "hero", blocks);
    const h2 = frag.takeTag("h2");
    if (h2) blocks.push({ kind: "heading", text: stripTags(h2.inner) });
    takeTextBlock(frag, "lede", "lede", blocks);
    takeTextBlock(frag, "cover-meta", "meta", blocks);
  }

  takeTextBlock(frag, "sub", "lede", blocks);
  takeTextBlock(frag, "lede", "lede", blocks);
  takeTextBlock(frag, "cover-meta", "meta", blocks);
  takeTextBlock(frag, "hero", "hero", blocks);

  if (stats) {
    const items = parseStats(stats.inner);
    if (items.length) blocks.push({ kind: "stats", items });
  }
  if (product) {
    if (findByClass(product.inner, "vs").length) {
      lossy.push(`${id}: 对比双栏降为分区文字`);
    }
    blocks.push(parseProductGrid(product.inner));
  }
  if (twoCol) blocks.push({ kind: "columns", columns: parseZones(twoCol.inner) });
  if (contact) blocks.push({ kind: "columns", columns: parseZones(contact.inner) });

  const leftoverZones = frag.takeAll("zone");
  if (leftoverZones.length && !product && !twoCol && !contact) {
    blocks.push({ kind: "columns", columns: leftoverZones.map((z) => parseZone(z.inner)) });
  }

  const bullets = frag.takeAll("bullets");
  if (bullets.length) {
    blocks.push({ kind: "bullets", items: bullets.flatMap((b) => parseListItems(b.inner)) });
  }

  const specTables = frag.takeAll("spec");
  if (specTables.length) {
    const rows = specTables.flatMap((t) => parseTable(t.inner));
    if (rows.length) {
      blocks.push({
        kind: "productGrid",
        spec: { bullets: [], paragraphs: [], table: { rows } },
        zones: [],
      });
    }
  }

  takeTextBlock(frag, "src", "source", blocks);

  const leftover = frag.leftoverText();
  if (leftover) {
    lossy.push(`${id}: 未识别文本收入备注（${clip(leftover, 80)}）`);
    notes.push(leftover);
  }

  const hasHero = blocks.some((b) => b.kind === "hero");
  return {
    id,
    label,
    cover: coverHint || (hasHero && !product && !stats),
    blocks,
    notes: notes.join("\n"),
  };
}

function pushHeadBlocks(inner: string, blocks: DeckBlock[]): void {
  const head = new Fragment(inner);
  takeTextBlock(head, "kicker", "kicker", blocks);
  const h2 = head.takeTag("h2");
  if (h2) blocks.push({ kind: "heading", text: stripTags(h2.inner) });
  takeTextBlock(head, "sub", "lede", blocks);
  takeTextBlock(head, "lede", "lede", blocks);
}

function takeTextBlock(
  frag: Fragment,
  cls: string,
  kind: "kicker" | "hero" | "lede" | "meta" | "source",
  blocks: DeckBlock[],
): void {
  const hit = frag.takeAll(cls)[0];
  if (!hit) return;
  const text = stripTags(hit.inner);
  if (text) blocks.push({ kind, text });
}

function parseProductGrid(inner: string): DeckBlock {
  const zones = findByClass(inner, "zone").map((z) => parseZone(z.inner));
  const specIdx = findByClass(inner, "zone").findIndex((z) =>
    classList(z.open).includes("zone-spec"),
  );
  let spec: DeckZone | undefined;
  const rest = [...zones];
  if (specIdx >= 0) spec = rest.splice(specIdx, 1)[0];
  return { kind: "productGrid", spec, zones: rest };
}

function parseZones(inner: string): DeckZone[] {
  const zones = findByClass(inner, "zone").map((z) => parseZone(z.inner));
  return zones.length ? zones : [parseZone(inner)];
}

function parseZone(inner: string): DeckZone {
  const title = textOfFirst(inner, "h3") || undefined;
  const bullets = [
    ...findByClass(inner, "bullets").flatMap((b) => parseListItems(b.inner)),
    ...findByClass(inner, "vs").flatMap((v) => parseListItems(v.inner)),
  ];
  const tableHits = findByClass(inner, "spec");
  const tableRows = tableHits.flatMap((t) => parseTable(t.inner));
  const paras = findByClass(inner, "contact-line").map((p) => stripTags(p.inner)).filter(Boolean);
  if (!paras.length && !bullets.length) {
    const stripped = inner
      .replace(/<h3\b[\s\S]*?<\/h3>/gi, " ")
      .replace(/<ul\b[\s\S]*?<\/ul>/gi, " ")
      .replace(/<table\b[\s\S]*?<\/table>/gi, " ");
    const t = stripTags(stripped);
    if (t) paras.push(t);
  }
  return {
    title,
    bullets,
    paragraphs: paras,
    table: tableRows.length ? { rows: tableRows } : undefined,
  };
}

function parseStats(inner: string): DeckStat[] {
  return findByClass(inner, "stat").map((s) => {
    const numEl = findByClass(s.inner, "stat-num")[0];
    const unitEl = numEl ? findByClass(numEl.inner, "unit")[0] : undefined;
    const unit = unitEl ? stripTags(unitEl.inner) : undefined;
    let num = numEl ? stripTags(numEl.inner) : stripTags(s.inner);
    if (unit) num = num.replace(unit, "").trim();
    const label = stripTags(findByClass(s.inner, "stat-label")[0]?.inner ?? "");
    return { num, unit, label };
  }).filter((s) => s.num || s.label);
}

function parseListItems(inner: string): string[] {
  return findTags(inner, "li").map((li) => stripTags(li.inner)).filter(Boolean);
}

function parseTable(inner: string): string[][] {
  return findTags(inner, "tr").map((tr) => {
    const cells = [...findTags(tr.inner, "th"), ...findTags(tr.inner, "td")];
    return cells.map((c) => stripTags(c.inner));
  }).filter((row) => row.some((c) => c));
}

async function emitDeckPptx(ir: DeckIR): Promise<Buffer> {
  const pres = createPres();
  pres.layout = "LAYOUT_WIDE";
  pres.title = ir.title;
  pres.author = "agent-harness";
  for (const slide of ir.slides) {
    const s = pres.addSlide();
    s.background = { color: ir.theme.bg };
    renderSlide(s, slide, ir.theme);
    if (slide.notes) s.addNotes(slide.notes);
  }
  return toNodeBuffer(await pres.write({ outputType: "nodebuffer" }));
}

function renderSlide(slide: PptxSlide, data: DeckSlide, theme: DeckTheme): void {
  if (data.cover) {
    renderCover(slide, data, theme);
    return;
  }
  const product = data.blocks.find((b): b is Extract<DeckBlock, { kind: "productGrid" }> => b.kind === "productGrid");
  const columns = data.blocks.find((b): b is Extract<DeckBlock, { kind: "columns" }> => b.kind === "columns");
  const stats = data.blocks.find((b): b is Extract<DeckBlock, { kind: "stats" }> => b.kind === "stats");
  let y = renderHeader(slide, data, theme, 0.28);

  if (stats) {
    y = renderStats(slide, stats.items, theme, y) + 0.16;
  }
  if (product) {
    renderProduct(slide, product, theme, y);
    return;
  }
  if (columns) {
    renderColumns(slide, columns.columns, theme, y);
    return;
  }
  renderStack(slide, data, theme, y);
}

function renderCover(slide: PptxSlide, data: DeckSlide, theme: DeckTheme): void {
  const kicker = textOf(data, "kicker");
  const hero = textOf(data, "hero") || textOf(data, "heading") || data.label;
  const lede = textOf(data, "lede");
  const meta = textOf(data, "meta");
  if (kicker) {
    slide.addText(kicker, {
      x: 0.6, y: 1.7, w: 12.1, h: 0.4,
      fontSize: 13, color: theme.accent, fontFace: "Calibri",
    });
  }
  slide.addText(hero, {
    x: 0.6, y: 2.2, w: 12.1, h: 1.8,
    fontSize: 32, bold: true, color: theme.fg, fontFace: "Calibri", valign: "top",
  });
  if (lede) {
    slide.addText(lede, {
      x: 0.6, y: 4.2, w: 11.2, h: 1.3,
      fontSize: 16, color: theme.muted, fontFace: "Calibri",
    });
  }
  if (meta) {
    slide.addText(meta, {
      x: 0.6, y: 5.7, w: 11.2, h: 0.5,
      fontSize: 13, color: theme.muted, fontFace: "Calibri",
    });
  }
}

function renderHeader(
  slide: PptxSlide,
  data: DeckSlide,
  theme: DeckTheme,
  y: number,
): number {
  const kicker = textOf(data, "kicker");
  const heading = textOf(data, "heading") || textOf(data, "hero") || data.label;
  const lede = textOf(data, "lede");
  if (kicker) {
    slide.addText(kicker, {
      x: 0.4, y, w: 12.5, h: 0.32,
      fontSize: 11, color: theme.accent, fontFace: "Calibri",
    });
    y += 0.32;
  }
  slide.addText(heading, {
    x: 0.4, y, w: 12.5, h: 0.55,
    fontSize: 22, bold: true, color: theme.fg, fontFace: "Calibri",
  });
  y += 0.58;
  if (lede) {
    slide.addText(lede, {
      x: 0.4, y, w: 12.5, h: 0.4,
      fontSize: 13, color: theme.muted, fontFace: "Calibri",
    });
    y += 0.42;
  }
  return y;
}

function renderStats(
  slide: PptxSlide,
  items: DeckStat[],
  theme: DeckTheme,
  y: number,
): number {
  const n = Math.min(items.length, 4);
  const gap = 0.18;
  const w = (12.5 - gap * (n - 1)) / n;
  items.slice(0, n).forEach((item, i) => {
    const x = 0.4 + i * (w + gap);
    slide.addShape("roundRect", {
      x, y, w, h: 1.15,
      fill: { color: theme.panel },
    });
    slide.addText(`${item.num}${item.unit ?? ""}`, {
      x: x + 0.1, y: y + 0.12, w: w - 0.2, h: 0.5,
      fontSize: 20, bold: true, color: theme.accent, fontFace: "Calibri",
    });
    slide.addText(item.label, {
      x: x + 0.1, y: y + 0.64, w: w - 0.2, h: 0.38,
      fontSize: 11, color: theme.muted, fontFace: "Calibri",
    });
  });
  return y + 1.15;
}

function renderProduct(
  slide: PptxSlide,
  block: Extract<DeckBlock, { kind: "productGrid" }>,
  theme: DeckTheme,
  y: number,
): void {
  const tableRows = block.spec?.table?.rows ?? [];
  if (tableRows.length) {
    slide.addTable(
      tableRows.map((row) =>
        row.map((cell, i) => ({
          text: cell,
          options: {
            bold: i === 0,
            color: i === 0 ? theme.muted : theme.fg,
            fill: { color: theme.panel },
            valign: "middle" as const,
          },
        })),
      ),
      {
        x: 0.35,
        y,
        w: 5.9,
        h: Math.min(5.6, 0.28 * tableRows.length + 0.2),
        fontSize: 10,
        fontFace: "Calibri",
        border: [
          { pt: 0.5, color: theme.muted },
          { pt: 0.5, color: theme.muted },
          { pt: 0.5, color: theme.muted },
          { pt: 0.5, color: theme.muted },
        ],
        colW: [2.1, 3.8],
      },
    );
  }
  const zones = block.zones;
  const colW = 6.3;
  const x0 = 6.5;
  zones.slice(0, 4).forEach((zone, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const zx = x0 + col * (colW / 2 + 0.08);
    const zy = y + row * 2.35;
    renderZoneBox(slide, zone, theme, zx, zy, colW / 2 - 0.05, 2.2);
  });
}

function renderColumns(
  slide: PptxSlide,
  columns: DeckZone[],
  theme: DeckTheme,
  y: number,
): void {
  const n = Math.min(Math.max(columns.length, 1), 3);
  const gap = 0.2;
  const w = (12.5 - gap * (n - 1)) / n;
  const h = 7.2 - y - 0.2;
  columns.slice(0, n).forEach((zone, i) => {
    renderZoneBox(slide, zone, theme, 0.4 + i * (w + gap), y, w, h);
  });
}

function renderStack(
  slide: PptxSlide,
  data: DeckSlide,
  theme: DeckTheme,
  y: number,
): void {
  for (const block of data.blocks) {
    if (block.kind === "bullets" && block.items.length) {
      slide.addText(
        block.items.map((t) => ({ text: t, options: { bullet: true } })),
        {
          x: 0.5, y, w: 12.3, h: Math.min(4.8, 7.1 - y),
          fontSize: 16, color: theme.fg, fontFace: "Calibri", valign: "top",
        },
      );
      y += Math.min(4.8, 0.38 * block.items.length + 0.2);
    }
    if (block.kind === "source") {
      slide.addText(block.text, {
        x: 0.5, y: 6.9, w: 12.3, h: 0.35,
        fontSize: 10, color: theme.muted, fontFace: "Calibri",
      });
    }
  }
}

function renderZoneBox(
  slide: PptxSlide,
  zone: DeckZone,
  theme: DeckTheme,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  slide.addShape("roundRect", {
    x, y, w, h,
    fill: { color: theme.panel },
  });
  let cy = y + 0.1;
  if (zone.title) {
    slide.addText(zone.title, {
      x: x + 0.12, y: cy, w: w - 0.24, h: 0.32,
      fontSize: 13, bold: true, color: theme.accent, fontFace: "Calibri",
    });
    cy += 0.34;
  }
  if (zone.table?.rows.length) {
    slide.addTable(
      zone.table.rows.map((row) =>
        row.map((cell) => ({ text: cell, options: { color: theme.fg } })),
      ),
      {
        x: x + 0.1, y: cy, w: w - 0.2, h: h - (cy - y) - 0.12,
        fontSize: 10, fontFace: "Calibri",
      },
    );
    return;
  }
  const lines = [
    ...zone.bullets.map((t) => ({ text: t, options: { bullet: true, color: theme.fg } })),
    ...zone.paragraphs.map((t) => ({ text: t, options: { color: theme.fg } })),
  ];
  if (lines.length) {
    slide.addText(lines, {
      x: x + 0.12, y: cy, w: w - 0.24, h: h - (cy - y) - 0.1,
      fontSize: 11, fontFace: "Calibri", valign: "top", color: theme.fg,
    });
  }
}

function textOf(slide: DeckSlide, kind: DeckBlock["kind"]): string {
  const hit = slide.blocks.find((b) => b.kind === kind);
  if (!hit) return "";
  if ("text" in hit) return hit.text;
  return "";
}

function toNodeBuffer(raw: string | ArrayBuffer | Blob | Uint8Array): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (typeof raw === "string") return Buffer.from(raw, "binary");
  throw new Error("pptxgenjs write() did not return a Node buffer");
}

// ——— HTML 扫描（无 jsdom） ———

type Found = { open: string; inner: string; start: number; end: number };

class Fragment {
  private consumed: { start: number; end: number }[] = [];
  constructor(private readonly html: string) {}

  takeAll(cls: string): Found[] {
    const found = findByClass(this.html, cls).filter((f) => !this.overlaps(f));
    this.consumed.push(...found);
    return found;
  }

  takeTag(tag: string): Found | undefined {
    const found = findTags(this.html, tag).find((f) => !this.overlaps(f));
    if (!found) return undefined;
    this.consumed.push(found);
    return found;
  }

  leftoverText(): string {
    const chars = this.html.split("");
    for (const c of this.consumed) {
      for (let i = c.start; i < c.end && i < chars.length; i++) chars[i] = " ";
    }
    return stripTags(chars.join(""));
  }

  private overlaps(f: Found): boolean {
    return this.consumed.some((c) => f.start < c.end && f.end > c.start);
  }
}

function findByClass(html: string, cls: string): Found[] {
  const out: Found[] = [];
  const re = /<([a-zA-Z][\w:-]*)\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[1]!;
    const open = m[0];
    if (!classList(open).includes(cls)) continue;
    if (/\/\s*>$/.test(open)) {
      out.push({ open, inner: "", start: m.index, end: m.index + open.length });
      continue;
    }
    const closed = matchClose(html, m.index, tag);
    if (!closed) continue;
    out.push({ open, inner: closed.inner, start: m.index, end: closed.end });
    re.lastIndex = closed.end;
  }
  return out;
}

function findTags(html: string, tag: string): Found[] {
  const out: Found[] = [];
  const re = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const open = m[0];
    if (/\/\s*>$/.test(open)) {
      out.push({ open, inner: "", start: m.index, end: m.index + open.length });
      continue;
    }
    const closed = matchClose(html, m.index, tag);
    if (!closed) continue;
    out.push({ open, inner: closed.inner, start: m.index, end: closed.end });
    re.lastIndex = closed.end;
  }
  return out;
}

function matchClose(
  html: string,
  start: number,
  tag: string,
): { inner: string; end: number } | null {
  const openEnd = html.indexOf(">", start);
  if (openEnd < 0) return null;
  const openRe = new RegExp(`<${tag}\\b`, "gi");
  const closeRe = new RegExp(`</${tag}\\s*>`, "gi");
  let depth = 1;
  let i = openEnd + 1;
  while (i < html.length && depth > 0) {
    openRe.lastIndex = i;
    closeRe.lastIndex = i;
    const o = openRe.exec(html);
    const c = closeRe.exec(html);
    if (!c) return null;
    if (o && o.index < c.index) {
      const oe = html.indexOf(">", o.index);
      const slice = html.slice(o.index, oe + 1);
      if (!/\/\s*>$/.test(slice)) depth += 1;
      i = oe + 1;
    } else {
      depth -= 1;
      if (depth === 0) {
        return { inner: html.slice(openEnd + 1, c.index), end: c.index + c[0].length };
      }
      i = c.index + c[0].length;
    }
  }
  return null;
}

function classList(openTag: string): string[] {
  const m = openTag.match(/\bclass\s*=\s*("([^"]*)"|'([^']*)')/i);
  const raw = m?.[2] ?? m?.[3] ?? "";
  return raw.split(/\s+/).filter(Boolean);
}

function attr(openTag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const m = openTag.match(re);
  return m?.[2] ?? m?.[3];
}

function textOfFirst(html: string, tag: string): string {
  const hit = findTags(html, tag)[0];
  return hit ? stripTags(hit.inner) : "";
}

function extractInlineCss(html: string): string {
  return findTags(html, "style").map((s) => s.inner).join("\n");
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function readCssVars(css: string, look?: string): Record<string, string | undefined> {
  let body: string | undefined;
  if (look) {
    const re = new RegExp(`html\\[data-look=["']${look}["']\\]\\s*\\{([\\s\\S]*?)\\}`, "i");
    body = css.match(re)?.[1];
  }
  if (!body) body = css.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? css;
  const out: Record<string, string | undefined> = {};
  const re = /--([a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const key = m[1]!.toLowerCase();
    const hex = normalizeColor(m[2]!.trim());
    if (!hex) continue;
    if (key === "bg") out.bg = hex;
    else if (key === "fg") out.fg = hex;
    else if (key === "accent") out.accent = hex;
    else if (key === "muted") out.muted = hex;
    else if (key === "bg-panel") out.bgPanel = hex;
  }
  return out;
}

function readDesignMdColors(md: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const line of md.split(/\r?\n/)) {
    const cell = line.match(/`?--?(bg|fg|accent|muted|bg-panel)`?\s*[|：:]\s*`?(#[0-9A-Fa-f]{3,8})`?/i)
      ?? line.match(/^[-*]\s*(bg|fg|accent|muted)\s*[:：]\s*(#[0-9A-Fa-f]{3,8})/i);
    if (!cell) continue;
    const hex = normalizeColor(cell[2]!);
    if (!hex) continue;
    const key = cell[1]!.toLowerCase().replace(/^--/, "");
    if (key === "bg-panel") out.panel = hex;
    else out[key] = hex;
  }
  return out;
}

function normalizeColor(raw: string): string | undefined {
  const hex = raw.trim().match(/^#([0-9A-Fa-f]{3,8})$/);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return h.slice(0, 6).toUpperCase();
  }
  const rgb = raw.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!rgb) return undefined;
  return [rgb[1], rgb[2], rgb[3]]
    .map((n) => Number(n).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function applyColor(theme: DeckTheme, key: keyof DeckTheme, value?: string): void {
  if (value) theme[key] = value;
}

function recordThemeLossy(css: string, lossy: string[]): void {
  if (/background-clip\s*:\s*text/i.test(css) || /--grad\s*:/i.test(css)) {
    lossy.push("渐变字改为强调色纯色");
  }
  if (/radial-gradient|grid-template/i.test(css)) {
    lossy.push("CSS 光晕/栅格改为语义分区");
  }
}

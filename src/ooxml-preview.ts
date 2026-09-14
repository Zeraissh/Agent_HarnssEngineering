/**
 * Office 文件预览解析：.pptx / .docx → 可翻页的结构化页（文本 + 嵌入图）。
 *
 * 不引第三方 ZIP 库：复用 deck-pptx 同款「扫 ZIP 本地头 + inflateRaw/store」。
 * 不是像素还原，也不是 Microsoft 就地编辑器。加密 / 坏文件 fail-closed。
 */
import { inflateRawSync } from "node:zlib";

export const OOXML_ENCRYPTED = "ENCRYPTED";
export const OOXML_BROKEN = "BROKEN";

export class OoxmlPreviewError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OoxmlPreviewError";
    this.code = code;
  }
}

export function isOoxmlPreviewError(err: unknown): err is OoxmlPreviewError {
  return err instanceof OoxmlPreviewError;
}

export type OfficeKind = "pptx" | "docx";

export type OfficePreviewImage = {
  name: string;
  mime: string;
  dataUrl: string;
};

export type OfficePreviewPage = {
  index: number;
  title: string;
  texts: string[];
  images: OfficePreviewImage[];
};

export type OfficePreview = {
  kind: OfficeKind;
  pages: OfficePreviewPage[];
};

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_LOCAL = 0x04034b50;
const MAX_IMAGE_BYTES = 400_000;
const MAX_IMAGES_PER_PAGE = 6;

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

export function officeKindFromPath(path: string): OfficeKind | null {
  const clean = String(path ?? "").split(/[?#]/)[0]?.replace(/\\/g, "/").toLowerCase() ?? "";
  if (clean.endsWith(".pptx")) return "pptx";
  if (clean.endsWith(".docx")) return "docx";
  return null;
}

export function parseOfficePreview(buf: Buffer | Uint8Array, kind: OfficeKind): OfficePreview {
  const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (raw.length < 8) {
    throw new OoxmlPreviewError(OOXML_BROKEN, "不是有效的 Office 文件，或已损坏。");
  }
  if (raw.subarray(0, 8).equals(OLE_MAGIC)) {
    throw new OoxmlPreviewError(OOXML_ENCRYPTED, "文件已加密，无法预览。解密后再打开。");
  }
  if (raw.readUInt32LE(0) !== ZIP_LOCAL) {
    throw new OoxmlPreviewError(OOXML_BROKEN, "不是有效的 Office 文件，或已损坏。");
  }

  const files = zipLocalFiles(raw);
  if (files.encrypted) {
    throw new OoxmlPreviewError(OOXML_ENCRYPTED, "文件已加密，无法预览。解密后再打开。");
  }
  const names = [...files.map.keys()];
  if (names.some((n) => /(?:^|\/)(?:EncryptionInfo|EncryptedPackage)$/i.test(n))) {
    throw new OoxmlPreviewError(OOXML_ENCRYPTED, "文件已加密，无法预览。解密后再打开。");
  }

  const pages = kind === "pptx" ? parsePptxPages(files.map) : parseDocxPages(files.map);
  if (pages.length === 0) {
    throw new OoxmlPreviewError(OOXML_BROKEN, "不是有效的 Office 文件，或已损坏。");
  }
  return { kind, pages };
}

type ZipFiles = { map: Map<string, Buffer>; encrypted: boolean };

function zipLocalFiles(buf: Buffer): ZipFiles {
  const map = new Map<string, Buffer>();
  let encrypted = false;
  let i = 0;
  while (i + 30 <= buf.length) {
    if (buf.readUInt32LE(i) !== ZIP_LOCAL) {
      i += 1;
      continue;
    }
    const flags = buf.readUInt16LE(i + 6);
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    if (flags & 0x1) encrypted = true;
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString("utf8").replace(/\\/g, "/");
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
    if (name && !name.endsWith("/")) map.set(name, Buffer.from(raw));
    i = dataStart + compSize;
  }
  return { map, encrypted };
}

function parsePptxPages(files: Map<string, Buffer>): OfficePreviewPage[] {
  const slides = [...files.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort((a, b) => slideXmlIndex(a) - slideXmlIndex(b));
  return slides.map((name, i) => {
    const xml = files.get(name)?.toString("utf8") ?? "";
    const texts = extractATexts(xml);
    const relsName = relsPathFor(name);
    const embeds = imageTargets(files.get(relsName)?.toString("utf8") ?? "", name);
    const used = new Set(blipEmbeds(xml));
    const wanted = embeds.filter((e) => used.has(e.id)).map((e) => e.target);
    return {
      index: i + 1,
      title: texts[0] ?? `第 ${i + 1} 页`,
      texts,
      images: collectImages(files, wanted),
    };
  });
}

function parseDocxPages(files: Map<string, Buffer>): OfficePreviewPage[] {
  const xml = files.get("word/document.xml")?.toString("utf8");
  if (!xml) return [];
  const rels = imageTargets(files.get("word/_rels/document.xml.rels")?.toString("utf8") ?? "", "word/document.xml");
  const byId = new Map(rels.map((r) => [r.id, r.target]));
  const pages: { texts: string[]; targets: string[] }[] = [{ texts: [], targets: [] }];
  const tokenRe =
    /<w:lastRenderedPageBreak\b[^/]*\/>|<w:br\b[^>]*w:type\s*=\s*["']page["'][^/]*\/>|<w:t\b[^>]*>([^<]*)<\/w:t>|r:embed="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(xml))) {
    if (m[0].startsWith("<w:lastRenderedPageBreak") || m[0].startsWith("<w:br")) {
      if (pages[pages.length - 1]!.texts.length > 0 || pages[pages.length - 1]!.targets.length > 0) {
        pages.push({ texts: [], targets: [] });
      }
      continue;
    }
    if (m[1] != null) {
      const t = decodeEntities(m[1]).trim();
      if (t) pages[pages.length - 1]!.texts.push(t);
      continue;
    }
    if (m[2]) {
      const target = byId.get(m[2]);
      if (target) pages[pages.length - 1]!.targets.push(target);
    }
  }
  return pages
    .filter((p) => p.texts.length > 0 || p.targets.length > 0)
    .map((p, i) => ({
      index: i + 1,
      title: p.texts[0] ?? `第 ${i + 1} 页`,
      texts: p.texts,
      images: collectImages(files, p.targets),
    }));
}

function slideXmlIndex(name: string): number {
  const m = name.match(/slide(\d+)\.xml$/i);
  return m ? Number(m[1]) : 0;
}

function relsPathFor(xmlName: string): string {
  const slash = xmlName.lastIndexOf("/");
  const dir = slash >= 0 ? xmlName.slice(0, slash) : "";
  const base = slash >= 0 ? xmlName.slice(slash + 1) : xmlName;
  return dir ? `${dir}/_rels/${base}.rels` : `_rels/${base}.rels`;
}

function imageTargets(relsXml: string, fromFile: string): { id: string; target: string }[] {
  const out: { id: string; target: string }[] = [];
  const re = /<Relationship\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(relsXml))) {
    const tag = m[0];
    if (!/Type\s*=\s*["'][^"']*\/image["']/i.test(tag)) continue;
    const id = attr(tag, "Id");
    const target = attr(tag, "Target");
    if (!id || !target || /^(https?:)?\/\//i.test(target) || target.startsWith("mailto:")) continue;
    out.push({ id, target: joinZipPath(fromFile, target) });
  }
  return out;
}

function blipEmbeds(xml: string): string[] {
  const out: string[] = [];
  const re = /r:embed="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]!);
  return out;
}

function collectImages(files: Map<string, Buffer>, targets: string[]): OfficePreviewImage[] {
  const out: OfficePreviewImage[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target) || out.length >= MAX_IMAGES_PER_PAGE) continue;
    seen.add(target);
    const data = files.get(target);
    if (!data || data.length === 0 || data.length > MAX_IMAGE_BYTES) continue;
    const ext = extOf(target);
    const mime = IMAGE_MIME[ext];
    if (!mime) continue;
    const name = target.split("/").pop() || target;
    out.push({
      name,
      mime,
      dataUrl: `data:${mime};base64,${data.toString("base64")}`,
    });
  }
  return out;
}

function extOf(name: string): string {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
}

function joinZipPath(fromFile: string, target: string): string {
  const rel = target.replace(/\\/g, "/").replace(/^\//, "");
  const slash = fromFile.replace(/\\/g, "/").lastIndexOf("/");
  const dir = slash >= 0 ? fromFile.slice(0, slash) : "";
  const parts = `${dir}/${rel}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
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

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return m?.[1] ?? "";
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

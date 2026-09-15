import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { writePptxTool } from "../src/tools/write-pptx.js";
import {
  OOXML_BROKEN,
  OOXML_ENCRYPTED,
  officeKindFromPath,
  parseOfficePreview,
} from "../src/ooxml-preview.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function zipStore(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const crc = crc32(file.data);
    const local = Buffer.alloc(30 + name.length + file.data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    file.data.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

function zipDeflate(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const packed = deflateRawSync(file.data);
    const crc = crc32(file.data);
    const local = Buffer.alloc(30 + name.length + packed.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    packed.copy(local, 30 + name.length);
    locals.push(local);
    offset += local.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  return Buffer.concat([...locals, eocd]);
}

function zipEncryptedNamed(name: string): Buffer {
  const nameBuf = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(1, 6);
  nameBuf.copy(local, 30);
  local.writeUInt16LE(nameBuf.length, 26);
  return local;
}

describe("officeKindFromPath", () => {
  it("只认 pptx / docx", () => {
    expect(officeKindFromPath("talks/deck.pptx")).toBe("pptx");
    expect(officeKindFromPath("C:\\work\\brief.DOCX?x=1")).toBe("docx");
    expect(officeKindFromPath("out/deck.pdf")).toBeNull();
    expect(officeKindFromPath("out/sheet.xlsx")).toBeNull();
  });
});

describe("parseOfficePreview — pptx", () => {
  it("读回 pptxgen 写出的两页标题与正文", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ooxml-pptx-"));
    try {
      const ctx = {
        workdir: dir,
        toolUseId: "tu_ooxml",
        signal: new AbortController().signal,
      };
      const out = await writePptxTool.execute(
        {
          path: "deck.pptx",
          slides: [
            { title: "封面主张", body: "第一页正文" },
            { title: "三点结构", body: "条目甲" },
          ],
        },
        ctx,
      );
      expect(out.isError).toBeFalsy();
      const parsed = parseOfficePreview(await readFile(join(dir, "deck.pptx")), "pptx");
      expect(parsed.kind).toBe("pptx");
      expect(parsed.pages).toHaveLength(2);
      expect(parsed.pages[0]!.title).toContain("封面主张");
      expect(parsed.pages[0]!.texts.join(" ")).toContain("第一页正文");
      expect(parsed.pages[1]!.texts.join(" ")).toContain("三点结构");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("抽出 slide 关系指向的嵌入图", () => {
    const slide =
      `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>有图的页</a:t></a:r></a:p></p:txBody></p:sp>` +
      `<p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>`;
    const rels =
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>` +
      `</Relationships>`;
    const buf = zipStore([
      { name: "ppt/slides/slide1.xml", data: Buffer.from(slide, "utf8") },
      { name: "ppt/slides/_rels/slide1.xml.rels", data: Buffer.from(rels, "utf8") },
      { name: "ppt/media/image1.png", data: PNG_1X1 },
    ]);
    const parsed = parseOfficePreview(buf, "pptx");
    expect(parsed.pages[0]!.images).toHaveLength(1);
    expect(parsed.pages[0]!.images[0]!.mime).toBe("image/png");
    expect(parsed.pages[0]!.images[0]!.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });
});

describe("parseOfficePreview — docx", () => {
  it("按分页符切开，抽出各页 w:t", () => {
    const doc =
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body><w:p><w:r><w:t>第一章</w:t></w:r></w:p>` +
      `<w:p><w:r><w:br w:type="page"/></w:r></w:p>` +
      `<w:p><w:r><w:t>第二章</w:t></w:r></w:p></w:body></w:document>`;
    const buf = zipDeflate([{ name: "word/document.xml", data: Buffer.from(doc, "utf8") }]);
    const parsed = parseOfficePreview(buf, "docx");
    expect(parsed.pages).toHaveLength(2);
    expect(parsed.pages[0]!.texts).toEqual(["第一章"]);
    expect(parsed.pages[1]!.texts).toEqual(["第二章"]);
  });
});

describe("parseOfficePreview — fail-closed", () => {
  it("OLE 复合文档当加密", () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x01]);
    expect(() => parseOfficePreview(ole, "pptx")).toThrow(/加密/);
    try {
      parseOfficePreview(ole, "pptx");
    } catch (err) {
      expect((err as { code: string }).code).toBe(OOXML_ENCRYPTED);
    }
  });

  it("ZIP 加密位当加密", () => {
    expect(() => parseOfficePreview(zipEncryptedNamed("ppt/slides/slide1.xml"), "pptx")).toThrow(/加密/);
  });

  it("EncryptionInfo 条目当加密", () => {
    const buf = zipStore([{ name: "EncryptionInfo", data: Buffer.from("x") }]);
    expect(() => parseOfficePreview(buf, "pptx")).toThrow(/加密/);
  });

  it("乱字节与空 zip fail-closed", () => {
    expect(() => parseOfficePreview(Buffer.from("not-a-zip"), "pptx")).toThrow(/损坏/);
    const empty = zipStore([{ name: "ppt/presentation.xml", data: Buffer.from("<p/>") }]);
    try {
      parseOfficePreview(empty, "pptx");
      expect.fail("should throw");
    } catch (err) {
      expect((err as { code: string }).code).toBe(OOXML_BROKEN);
    }
  });
});

/**
 * 极简 ZIP（仅 store，无压缩）——给整站目录打包下载用，零依赖。
 * 不是通用归档器：路径分隔用 `/`，拒绝 `..` 段。
 */
import { createHash } from "node:crypto";

function crc32(buf: Buffer): number {
  let c = 0xffff_ffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb8_8320 ^ (c >>> 1)) : c >>> 1;
    }
  }
  return (c ^ 0xffff_ffff) >>> 0;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n >>> 0, 0);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

/** 规范化进 ZIP 的相对路径；非法则抛错。 */
export function zipEntryName(relativePath: string): string {
  const normalized = String(relativePath ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
  if (!normalized) throw new Error("zip entry path is empty");
  const parts = normalized.split("/");
  for (const p of parts) {
    if (!p || p === "." || p === "..") throw new Error(`illegal zip path segment: ${relativePath}`);
  }
  return normalized;
}

export type ZipFileEntry = { name: string; data: Buffer };

/**
 * 组装 store-method ZIP。entries 的 name 已是 zip 内路径。
 */
export function buildStoreZip(entries: ZipFileEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = zipEntryName(entry.name);
    const nameBuf = Buffer.from(name, "utf8");
    const data = entry.data;
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      data,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = Buffer.concat(centrals);
  const localBlob = Buffer.concat(locals);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDir.length),
    u32(localBlob.length),
    u16(0),
  ]);
  return Buffer.concat([localBlob, centralDir, end]);
}

/** 调试/指纹：内容哈希，不进 ZIP 格式。 */
export function zipContentFingerprint(entries: ZipFileEntry[]): string {
  const h = createHash("sha256");
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    h.update(zipEntryName(e.name));
    h.update("\0");
    h.update(e.data);
  }
  return h.digest("hex");
}

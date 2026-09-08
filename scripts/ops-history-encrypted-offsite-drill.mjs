#!/usr/bin/env node
/**
 * OPS-01 异地加密备份恢复最小全套（单操作员）。
 *
 * 在既有明文目录复制演练之上，增加：
 *   live → 加密包 → 「异地」目录 → 解密恢复 → 树哈希一致
 *
 * 用法：
 *   node scripts/ops-history-encrypted-offsite-drill.mjs
 *   node scripts/ops-history-encrypted-offsite-drill.mjs --root D:\Work\scratch\ops-enc
 *
 * 口令：AGENT_OPS_BACKUP_PASSPHRASE（演练未设则用一次性随机口令，只打在 stdout）
 */
import { mkdir, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { fileURLToPath } from "node:url";

const rootArg = process.argv.indexOf("--root");
const drillRoot = rootArg >= 0
  ? path.resolve(process.argv[rootArg + 1])
  : path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".ops-drill-enc");

const live = path.join(drillRoot, "live");
const offsite = path.join(drillRoot, "offsite");
const restore = path.join(drillRoot, "restore");
const packPath = path.join(offsite, "history-backup.agz");

async function hashTree(dir) {
  const hash = createHash("sha256");
  async function walk(current, prefix = "") {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else {
        const body = await readFile(full);
        hash.update(rel);
        hash.update("\0");
        hash.update(body);
        hash.update("\0");
      }
    }
  }
  await walk(dir);
  return hash.digest("hex");
}

async function collectFiles(dir, prefix = "") {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await collectFiles(full, rel));
    else out.push({ rel, full });
  }
  return out;
}

/**
 * 简易加密归档：魔数 + salt + iv + scrypt(N=16384) AES-256-GCM(gzip(JSON files))
 * 故意不依赖 tar/openssl CLI，Windows/Linux 同路径。
 */
async function encryptTreeToFile(srcDir, destFile, passphrase) {
  const files = await collectFiles(srcDir);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  const payload = [];
  for (const f of files) {
    payload.push({ path: f.rel, data: (await readFile(f.full)).toString("base64") });
  }
  const plain = Buffer.from(JSON.stringify({ v: 1, files: payload }), "utf8");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header = Buffer.from("AGHB1\0");
  await mkdir(path.dirname(destFile), { recursive: true });
  await writeFile(destFile, Buffer.concat([header, salt, iv, tag, enc]));
}

async function decryptFileToTree(encFile, destDir, passphrase) {
  const blob = await readFile(encFile);
  if (blob.subarray(0, 6).toString() !== "AGHB1\0") {
    throw new Error("encrypted backup magic mismatch");
  }
  const salt = blob.subarray(6, 22);
  const iv = blob.subarray(22, 34);
  const tag = blob.subarray(34, 50);
  const enc = blob.subarray(50);
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
  const parsed = JSON.parse(plain.toString("utf8"));
  if (parsed.v !== 1 || !Array.isArray(parsed.files)) {
    throw new Error("encrypted backup payload is invalid");
  }
  await mkdir(destDir, { recursive: true });
  for (const file of parsed.files) {
    if (typeof file.path !== "string" || file.path.includes("..") || path.isAbsolute(file.path)) {
      throw new Error(`refusing unsafe archive path: ${file.path}`);
    }
    const full = path.join(destDir, file.path);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, Buffer.from(file.data, "base64"));
  }
}

await rm(drillRoot, { recursive: true, force: true });
await mkdir(path.join(live, "run-demo"), { recursive: true });
await writeFile(
  path.join(live, "run-demo", "meta.json"),
  JSON.stringify({ runId: "run-demo", note: "ops-01 encrypted offsite fixture" }),
  "utf8",
);
await writeFile(
  path.join(live, "run-demo", "events.jsonl"),
  '{"seq":1,"type":"run_start","secret":"must-stay-ciphertext-only"}\n',
  "utf8",
);

const passphrase = process.env.AGENT_OPS_BACKUP_PASSPHRASE?.trim()
  || randomBytes(24).toString("base64url");
const ephemeral = !process.env.AGENT_OPS_BACKUP_PASSPHRASE?.trim();

const before = await hashTree(live);
await mkdir(offsite, { recursive: true });
await encryptTreeToFile(live, packPath, passphrase);

const encBytes = await readFile(packPath);
if (encBytes.includes(Buffer.from("must-stay-ciphertext-only"))) {
  console.error("plaintext secret leaked into encrypted package");
  process.exit(1);
}

// 模拟本机 live 损毁后只剩异地密文
await rm(live, { recursive: true, force: true });
await rm(restore, { recursive: true, force: true });
await decryptFileToTree(packPath, restore, passphrase);
const after = await hashTree(restore);
if (before !== after) {
  console.error("encrypted offsite restore hash mismatch");
  process.exit(1);
}

// 错口令必须 fail-closed
let wrongRejected = false;
try {
  await decryptFileToTree(packPath, path.join(drillRoot, "wrong"), passphrase + "-nope");
} catch {
  wrongRejected = true;
}
if (!wrongRejected) {
  console.error("wrong passphrase did not fail closed");
  process.exit(1);
}

const stamp = {
  at: new Date().toISOString(),
  sha256: before,
  offsitePackage: packPath,
  packageBytes: (await stat(packPath)).size,
  rpo: "last successful encrypted offsite package (this drill)",
  rto: "fetch offsite package → decrypt with passphrase → replace history root → restart; solo target < 15min",
  passphraseEphemeral: ephemeral,
  note: "ciphertext-only offsite; plaintext transcripts never leave the operator machine unencrypted",
};
await writeFile(path.join(offsite, ".last-success.json"), JSON.stringify(stamp, null, 2), "utf8");

console.log("OPS-01 encrypted offsite drill: pass");
console.log(JSON.stringify(stamp, null, 2));
if (ephemeral) {
  console.log(`drill passphrase (ephemeral): ${passphrase}`);
}

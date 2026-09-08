#!/usr/bin/env node
/**
 * OPS-01 最小切片 — 历史卷备份/恢复演练脚本（单操作员）。
 *
 * 不替代生产 sidecar；本机验证「复制 → 校验 → 恢复」一条链。
 *
 * 用法：
 *   node scripts/ops-history-backup-drill.mjs
 *   node scripts/ops-history-backup-drill.mjs --root D:\Work\scratch\history-drill
 *
 * RPO/RTO（本切片口径，写入 stdout；正式值见 docs/07）：
 *   RPO = 上一次成功整目录复制的时刻（本脚本结束时写 .last-success.json）
 *   RTO = 手动恢复：停宿主 → 用备份覆盖 history 根 → 重启（目标 < 15 min 单操作员）
 */
import { cp, mkdir, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const rootArg = process.argv.indexOf("--root");
const drillRoot = rootArg >= 0
  ? path.resolve(process.argv[rootArg + 1])
  : path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".ops-drill");

const live = path.join(drillRoot, "live");
const backup = path.join(drillRoot, "backup");
const restore = path.join(drillRoot, "restore");

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

await rm(drillRoot, { recursive: true, force: true });
await mkdir(path.join(live, "run-demo"), { recursive: true });
await writeFile(
  path.join(live, "run-demo", "meta.json"),
  JSON.stringify({ runId: "run-demo", note: "ops-01 drill fixture" }),
  "utf8",
);
await writeFile(path.join(live, "run-demo", "events.jsonl"), '{"seq":1,"type":"run_start"}\n', "utf8");

const before = await hashTree(live);
await mkdir(backup, { recursive: true });
await cp(live, path.join(backup, "live"), { recursive: true });
const afterCopy = await hashTree(path.join(backup, "live"));
if (before !== afterCopy) {
  console.error("backup hash mismatch");
  process.exit(1);
}

await rm(restore, { recursive: true, force: true });
await cp(path.join(backup, "live"), restore, { recursive: true });
const afterRestore = await hashTree(restore);
if (before !== afterRestore) {
  console.error("restore hash mismatch");
  process.exit(1);
}

const stamp = {
  at: new Date().toISOString(),
  sha256: before,
  rpo: "last successful full-directory copy (this drill)",
  rto: "stop host → replace history root from backup → restart; solo target < 15min",
  note: "transcripts are plaintext — treat backups like model keys (docs/07)",
};
await writeFile(path.join(backup, ".last-success.json"), JSON.stringify(stamp, null, 2), "utf8");

console.log("OPS-01 backup drill: pass");
console.log(JSON.stringify(stamp, null, 2));

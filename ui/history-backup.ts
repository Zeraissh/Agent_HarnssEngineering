/**
 * 生产历史备份 sidecar：只复制 status=done 的不可变 run 档案，逐文件 SHA-256
 * 验证后再原子 rename。运行中的目录不碰，避免把半条 transcript 当成备份。
 */
import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadArchivedMetas } from "./history.js";

const ARCHIVE_FILES = ["meta.json", "events.jsonl", "transcript.jsonl"] as const;

interface BackupManifest {
  version: 1;
  runId: string;
  backedUpAt: string;
  files: Record<string, string>;
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export async function verifyRunBackup(dir: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(dir, "backup-manifest.json"), "utf8")) as BackupManifest;
    if (manifest.version !== 1 || !manifest.runId || !manifest.files) return false;
    for (const [name, expected] of Object.entries(manifest.files)) {
      if (!ARCHIVE_FILES.includes(name as (typeof ARCHIVE_FILES)[number])) return false;
      if ((await sha256(join(dir, name))) !== expected) return false;
    }
    return Object.keys(manifest.files).includes("meta.json");
  } catch {
    return false;
  }
}

export async function backupCompletedRuns(historyRoot: string, backupRoot: string): Promise<{ copied: string[]; skipped: string[] }> {
  const sourceRoot = resolve(historyRoot);
  const targetRoot = resolve(backupRoot);
  const sourceToTarget = relative(sourceRoot, targetRoot);
  const targetToSource = relative(targetRoot, sourceRoot);
  if (
    sourceRoot === targetRoot ||
    (!sourceToTarget.startsWith("..") && sourceToTarget !== "") ||
    (!targetToSource.startsWith("..") && targetToSource !== "")
  ) {
    throw new Error("历史目录与备份目录不能相同或互相包含");
  }
  await mkdir(targetRoot, { recursive: true });
  const copied: string[] = [];
  const skipped: string[] = [];
  for (const archive of await loadArchivedMetas(sourceRoot)) {
    if (archive.meta.status !== "done") continue;
    const target = join(targetRoot, archive.meta.runId);
    if (await exists(target)) {
      if (!(await verifyRunBackup(target))) {
        throw new Error(`已有备份校验失败，拒绝覆盖：${target}`);
      }
      skipped.push(archive.meta.runId);
      continue;
    }

    const temporary = join(targetRoot, `.${archive.meta.runId}.${randomUUID()}.tmp`);
    try {
      await mkdir(temporary, { recursive: true });
      const hashes: Record<string, string> = {};
      for (const name of ARCHIVE_FILES) {
        const source = join(archive.dir, name);
        if (!(await exists(source))) continue;
        const destination = join(temporary, name);
        await copyFile(source, destination);
        const [sourceHash, copiedHash] = await Promise.all([sha256(source), sha256(destination)]);
        if (sourceHash !== copiedHash) throw new Error(`备份校验失败：${archive.meta.runId}/${name}`);
        hashes[name] = copiedHash;
      }
      if (!hashes["meta.json"]) throw new Error(`档案缺 meta.json：${archive.meta.runId}`);
      const manifest: BackupManifest = {
        version: 1,
        runId: archive.meta.runId,
        backedUpAt: new Date().toISOString(),
        files: hashes,
      };
      await writeFile(join(temporary, "backup-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      if (!(await verifyRunBackup(temporary))) throw new Error(`备份复验失败：${archive.meta.runId}`);
      await rename(temporary, target);
      copied.push(archive.meta.runId);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
  return { copied, skipped };
}

async function main(): Promise<void> {
  const historyRoot = process.env.AGENT_RUN_HISTORY_DIR;
  const backupRoot = process.env.AGENT_RUN_HISTORY_BACKUP_DIR;
  if (!historyRoot || !backupRoot) throw new Error("AGENT_RUN_HISTORY_DIR 与 AGENT_RUN_HISTORY_BACKUP_DIR 均为必填");
  const interval = Number(process.env.AGENT_RUN_HISTORY_BACKUP_INTERVAL_MS ?? 3_600_000);
  if (!Number.isInteger(interval) || interval < 60_000) throw new Error("备份间隔必须是 >=60000 的整数毫秒");

  let stopping = false;
  let wakeForStop: (() => void) | undefined;
  const stopped = new Promise<void>((done) => { wakeForStop = done; });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    stopping = true;
    wakeForStop?.();
  });
  while (!stopping) {
    const result = await backupCompletedRuns(historyRoot, backupRoot);
    const marker = { at: new Date().toISOString(), ...result };
    await writeFile(join(resolve(backupRoot), ".last-success.json"), `${JSON.stringify(marker)}\n`, "utf8");
    console.log(JSON.stringify({ event: "history_backup_completed", ...marker }));
    await Promise.race([new Promise<void>((done) => setTimeout(done, interval)), stopped]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main().catch((error: unknown) => {
    console.error(JSON.stringify({ event: "history_backup_failed", error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  });
}

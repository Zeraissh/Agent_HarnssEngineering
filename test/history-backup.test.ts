import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { backupCompletedRuns, verifyRunBackup } from "../ui/history-backup.js";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function seedRun(root: string, id: string, status: "running" | "done"): Promise<void> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), JSON.stringify({ version: 1, runId: id, task: "t", status, createdAt: 1 }), "utf8");
  await writeFile(join(dir, "events.jsonl"), "{\"seq\":1}\n", "utf8");
  await writeFile(join(dir, "transcript.jsonl"), "{\"segment\":1}\n", "utf8");
}

describe("history backup", () => {
  it("只备份 done 档案，逐文件哈希复验；重复运行幂等跳过", async () => {
    const history = await temp("history-source-");
    const backups = await temp("history-backup-");
    await seedRun(history, "done-1", "done");
    await seedRun(history, "running-1", "running");
    expect(await backupCompletedRuns(history, backups)).toEqual({ copied: ["done-1"], skipped: [] });
    expect(await verifyRunBackup(join(backups, "done-1"))).toBe(true);
    expect(await backupCompletedRuns(history, backups)).toEqual({ copied: [], skipped: ["done-1"] });
  });

  it("已有备份被篡改时 fail-closed，不覆盖证据", async () => {
    const history = await temp("history-source-");
    const backups = await temp("history-backup-");
    await seedRun(history, "done-1", "done");
    await backupCompletedRuns(history, backups);
    const eventFile = join(backups, "done-1", "events.jsonl");
    await writeFile(eventFile, `${await readFile(eventFile, "utf8")}tampered`, "utf8");
    expect(await verifyRunBackup(join(backups, "done-1"))).toBe(false);
    await expect(backupCompletedRuns(history, backups)).rejects.toThrow(/拒绝覆盖/);
  });

  it("拒绝源目录与备份目录互相嵌套，避免递归复制和清理误伤", async () => {
    const root = await temp("history-overlap-");
    await expect(backupCompletedRuns(root, join(root, "backup"))).rejects.toThrow(/互相包含/);
    await expect(backupCompletedRuns(join(root, "history"), root)).rejects.toThrow(/互相包含/);
  });
});

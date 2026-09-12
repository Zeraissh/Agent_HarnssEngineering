import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyFileRevert,
  conversationTurnFromEvents,
  parseRewindFromMeta,
  parseRewindRequest,
  planFileRevert,
  truncateEventsToSeq,
  writesAfterSeq,
  type FileRewindRecord,
} from "../ui/conversation-rewind.js";

const ev = (seq: number, type: string, extra: Record<string, unknown> = {}) => ({
  seq,
  source: "main",
  event: { type, ...extra },
});

describe("conversation-rewind 纯函数", () => {
  it("parseRewindRequest 拒绝缺 seq / 非整数", () => {
    expect(parseRewindRequest(null).ok).toBe(false);
    expect(parseRewindRequest({}).ok).toBe(false);
    expect(parseRewindRequest({ seq: 1.5 }).ok).toBe(false);
    expect(parseRewindRequest({ seq: -2 }).ok).toBe(false);
    expect(parseRewindRequest({ seq: 3, revertFiles: "yes" }).ok).toBe(false);
    expect(parseRewindRequest({ seq: 3 })).toEqual({ ok: true, seq: 3, revertFiles: false });
    expect(parseRewindRequest({ seq: -1, revertFiles: true })).toEqual({
      ok: true,
      seq: -1,
      revertFiles: true,
    });
  });

  it("seq=-1 只留开机事件；正整数裁掉之后的消息", () => {
    const events = [
      ev(0, "run_config"),
      ev(1, "assistant_text", { text: "第一轮" }),
      ev(2, "user_message", { turn: 2, text: "再来" }),
      ev(3, "assistant_text", { text: "第二轮" }),
    ];
    expect(truncateEventsToSeq(events, -1).map((e) => e.event.type)).toEqual(["run_config"]);
    expect(truncateEventsToSeq(events, 1).map((e) => e.seq)).toEqual([0, 1]);
    expect(conversationTurnFromEvents(truncateEventsToSeq(events, 1))).toBe(1);
    expect(conversationTurnFromEvents(truncateEventsToSeq(events, 3))).toBe(2);
  });

  it("writesAfterSeq 只收裁点之后带 path 的写盘工具", () => {
    const events = [
      ev(0, "assistant_text"),
      ev(1, "tool_call", { name: "write_file", toolUseId: "w1", input: { path: "a.txt" } }),
      ev(2, "tool_call", { name: "bash", toolUseId: "b1", input: { command: "echo x > a.txt" } }),
      ev(3, "tool_call", { name: "write_file", toolUseId: "w2", input: { path: "a.txt" } }),
    ];
    expect(writesAfterSeq(events, 0).map((w) => w.toolUseId)).toEqual(["w1", "w2"]);
    expect(writesAfterSeq(events, 1).map((w) => w.toolUseId)).toEqual(["w2"]);
  });

  it("有快照的路径按时间倒序还原/删除，没有快照才走 git", () => {
    const writes = [
      { seq: 1, toolUseId: "w1", tool: "write_file", path: "a.txt" },
      { seq: 2, toolUseId: "w2", tool: "write_file", path: "a.txt" },
      { seq: 3, toolUseId: "w3", tool: "write_file", path: "b.txt" },
    ];
    const snapshots = new Map<string, FileRewindRecord>([
      ["w1", { toolUseId: "w1", tool: "write_file", path: "a.txt", existed: false, bytes: 0, at: 1 }],
      ["w2", { toolUseId: "w2", tool: "write_file", path: "a.txt", existed: true, bytes: 2, at: 2 }],
    ]);
    const plan = planFileRevert(writes, snapshots);
    expect(plan.filter((a) => a.path === "a.txt").map((a) => a.action)).toEqual(["restore", "delete"]);
    expect(plan.find((a) => a.path === "b.txt")).toMatchObject({ action: "git", reason: "no_snapshot" });
  });

  it("parseRewindFromMeta 丢掉坏形状", () => {
    expect(parseRewindFromMeta(null)).toBeUndefined();
    expect(parseRewindFromMeta({ parentRunId: "p", seq: 2, revertFiles: true })).toEqual({
      parentRunId: "p",
      seq: 2,
      revertFiles: true,
    });
    expect(parseRewindFromMeta({ parentRunId: "p", seq: "2" })).toBeUndefined();
  });

  it("applyFileRevert 按快照还原并删掉当时不存在的文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rewind-files-"));
    try {
      await writeFile(join(dir, "kept.txt"), "after", "utf8");
      await writeFile(join(dir, "new.txt"), "created", "utf8");
      const result = await applyFileRevert({
        workdir: dir,
        writes: [
          { seq: 1, toolUseId: "a", tool: "write_file", path: "kept.txt" },
          { seq: 2, toolUseId: "b", tool: "write_file", path: "new.txt" },
        ],
        snapshots: new Map([
          ["a", {
            record: { toolUseId: "a", tool: "write_file", path: "kept.txt", existed: true, bytes: 6, at: 1 },
            blob: Buffer.from("before", "utf8"),
          }],
          ["b", {
            record: { toolUseId: "b", tool: "write_file", path: "new.txt", existed: false, bytes: 0, at: 2 },
          }],
        ]),
      });
      expect(result.restored).toEqual(["kept.txt"]);
      expect(result.deleted).toEqual(["new.txt"]);
      expect(await readFile(join(dir, "kept.txt"), "utf8")).toBe("before");
      await expect(readFile(join(dir, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

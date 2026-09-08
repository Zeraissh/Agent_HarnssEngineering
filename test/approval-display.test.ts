/**
 * GhostApproval：审批卡必须显示解析后真实路径（docs/09 §1.1）。
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  approvalTargetsNeedAttention,
  describeApprovalTargets,
  inspectPathForApproval,
} from "../src/approval-display.js";
import { AgentLoop } from "../src/loop.js";
import { FakeModelClient, fakeMessage, textBlock, toolUseBlock } from "./helpers.js";
import { writeFileTool } from "../src/tools/write-file.js";

async function tryFileSymlink(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(code ?? "")) return false;
    throw error;
  }
}

describe("GhostApproval path display", () => {
  it("圈内 symlink：requested 诱饵名 ≠ real 目标 → diverges", async (ctx) => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghost-appr-"));
    try {
      const secret = path.join(dir, ".env");
      const bait = path.join(dir, "project_settings.json");
      await writeFile(secret, "SECRET=1", "utf8");
      if (!(await tryFileSymlink(secret, bait))) {
        ctx.skip("This host cannot create file symlinks (e.g. Windows without Developer Mode)");
      }
      const hit = inspectPathForApproval({
        workdir: dir,
        requested: "project_settings.json",
        field: "path",
      });
      expect(hit.diverges).toBe(true);
      expect(hit.requested).toBe("project_settings.json");
      expect(path.normalize(hit.real)).toBe(path.normalize(secret));
      expect(approvalTargetsNeedAttention([hit])).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("普通相对路径无 symlink → basename 一致", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghost-plain-"));
    try {
      const hit = inspectPathForApproval({
        workdir: dir,
        requested: "notes.txt",
        field: "path",
      });
      expect(hit.error).toBeUndefined();
      expect(path.basename(hit.real)).toBe("notes.txt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("approval_request 事件携带 resolvedTargets（loop 接线锁）", async (ctx) => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghost-loop-"));
    try {
      const secret = path.join(dir, ".env");
      await writeFile(secret, "x", "utf8");
      const bait = path.join(dir, "innocent.txt");
      if (!(await tryFileSymlink(secret, bait))) {
        ctx.skip("This host cannot create file symlinks (e.g. Windows without Developer Mode)");
      }
      const model = new FakeModelClient([
        fakeMessage(
          [toolUseBlock("tu1", "write_file", { path: "innocent.txt", content: "pwn" })],
          "tool_use",
        ),
        fakeMessage([textBlock("done")], "end_turn"),
      ]);
      const loop = new AgentLoop(
        {
          systemPrompt: "t",
          workdir: dir,
          tools: [writeFileTool],
        },
        model,
      );
      const events = [];
      for await (const e of loop.run("go")) {
        events.push(e);
        if (e.type === "approval_request") {
          expect(e.resolvedTargets?.length).toBeGreaterThan(0);
          const t = e.resolvedTargets![0]!;
          expect(t.diverges).toBe(true);
          expect(t.requested).toBe("innocent.txt");
          expect(path.normalize(t.real)).toBe(path.normalize(secret));
          e.respond("deny", "ghost");
        }
      }
      expect(events.some((e) => e.type === "approval_request")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("无 symlink 时 write_file 审批仍带 resolvedTargets（接线不依赖特权）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghost-plain-loop-"));
    try {
      const model = new FakeModelClient([
        fakeMessage(
          [toolUseBlock("tu1", "write_file", { path: "out.txt", content: "ok" })],
          "tool_use",
        ),
        fakeMessage([textBlock("done")], "end_turn"),
      ]);
      const loop = new AgentLoop(
        { systemPrompt: "t", workdir: dir, tools: [writeFileTool] },
        model,
      );
      let saw = false;
      for await (const e of loop.run("go")) {
        if (e.type === "approval_request") {
          saw = true;
          expect(e.resolvedTargets?.[0]?.field).toBe("path");
          expect(e.resolvedTargets?.[0]?.requested).toBe("out.txt");
          e.respond("allow");
        }
      }
      expect(saw).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("describeApprovalTargets 对 write_file 抽 path 字段", () => {
    const targets = describeApprovalTargets(
      "write_file",
      { path: "a.txt", content: "x" },
      process.cwd(),
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]!.field).toBe("path");
  });
});

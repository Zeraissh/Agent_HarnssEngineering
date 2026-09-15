import { describe, expect, it } from "vitest";
import {
  parseCampaignMeta,
  parseMailboxAction,
  parseMailboxJsonl,
  serializeMailboxAction,
} from "../src/campaign.js";
import { CAMPAIGN_MAIL_TOOL_NAME, createCampaignMailTool } from "../src/tools/campaign-mail.js";

describe("campaign mailbox", () => {
  it("只保留 action / task / artifacts，丢掉 transcript", () => {
    const parsed = parseMailboxAction({
      action: "assign",
      task: "写固件",
      artifacts: ["out/a.elf"],
      transcript: [{ role: "assistant", text: "不该进 mailbox" }],
      messages: ["也不该"],
      at: 1,
    });
    expect(parsed).toEqual({
      at: 1,
      action: "assign",
      task: "写固件",
      artifacts: ["out/a.elf"],
    });
    expect(JSON.stringify(parsed)).not.toContain("transcript");
    expect(serializeMailboxAction(parsed!)).not.toContain("不该进 mailbox");
  });

  it("四动作都合法；缺 task 或非法 action 丢弃", () => {
    expect(parseMailboxAction({ action: "follow_up", task: "补验收" })?.action).toBe("follow_up");
    expect(parseMailboxAction({ action: "cancel", task: "停" })?.action).toBe("cancel");
    expect(parseMailboxAction({ action: "redispatch", task: "重派" })?.action).toBe("redispatch");
    expect(parseMailboxAction({ action: "assign", task: "" })).toBeNull();
    expect(parseMailboxAction({ action: "whisper", task: "x" })).toBeNull();
  });

  it("jsonl 坏行跳过", () => {
    const lines = [
      serializeMailboxAction({ at: 1, action: "assign", task: "a", artifacts: [] }),
      "{not json",
      JSON.stringify({ action: "assign" }),
      serializeMailboxAction({ at: 2, action: "cancel", task: "停", artifacts: [] }),
    ].join("\n");
    const parsed = parseMailboxJsonl(lines);
    expect(parsed.map((a) => a.action)).toEqual(["assign", "cancel"]);
  });

  it("parseCampaignMeta 丢掉非法 child，schema 不对则整份丢弃", () => {
    expect(parseCampaignMeta({ schemaVersion: 2, id: "c1", directorRunId: "d1" })).toBeNull();
    const meta = parseCampaignMeta({
      schemaVersion: 1,
      id: "c1",
      directorRunId: "d1",
      task: "做落地页，并写 STM32 固件。",
      createdAt: "2026-09-15T00:00:00.000Z",
      children: [
        { runId: "child-1", title: "固件", status: "running", pack: "stm32-coding" },
        { runId: "", title: "缺 id" },
        { title: "缺 runId" },
      ],
    });
    expect(meta).toEqual({
      schemaVersion: 1,
      id: "c1",
      directorRunId: "d1",
      task: "做落地页，并写 STM32 固件。",
      createdAt: "2026-09-15T00:00:00.000Z",
      children: [{ runId: "child-1", title: "固件", status: "running", pack: "stm32-coding" }],
    });
  });
});

describe("campaign_mail tool", () => {
  const ctx = {
    workdir: process.cwd(),
    toolUseId: "mail-1",
    signal: new AbortController().signal,
  };

  it("只把 action / task / artifacts 交给 append，丢掉 transcript", async () => {
    const appended: Array<{ childRunId: string; action: unknown }> = [];
    const tool = createCampaignMailTool({
      append: (childRunId, action) => {
        appended.push({ childRunId, action });
      },
    });
    expect(tool.name).toBe(CAMPAIGN_MAIL_TOOL_NAME);
    const result = await tool.execute(
      {
        childRunId: "child-1",
        action: "assign",
        task: "写固件",
        artifacts: ["out/a.elf"],
        transcript: [{ role: "assistant", text: "不该进 mailbox" }],
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("child-1");
    expect(appended).toHaveLength(1);
    expect(appended[0]?.childRunId).toBe("child-1");
    expect(appended[0]?.action).toEqual({
      at: expect.any(Number),
      action: "assign",
      task: "写固件",
      artifacts: ["out/a.elf"],
    });
    expect(JSON.stringify(appended)).not.toContain("transcript");
    expect(JSON.stringify(appended)).not.toContain("不该进 mailbox");
  });

  it("缺 childRunId / 非法 action / 空 task 拒绝且不写", async () => {
    let called = 0;
    const tool = createCampaignMailTool({
      append: () => {
        called += 1;
      },
    });
    expect((await tool.execute({ action: "assign", task: "x" }, ctx)).isError).toBe(true);
    expect((await tool.execute({ childRunId: "c1", action: "whisper", task: "x" }, ctx)).isError).toBe(true);
    expect((await tool.execute({ childRunId: "c1", action: "assign", task: "  " }, ctx)).isError).toBe(true);
    expect(called).toBe(0);
  });
});

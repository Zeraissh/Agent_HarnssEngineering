/**
 * AGENT-02 战役会话：spawn 真开 StoredRun、spec-plus-deck 不拆、
 * 注入宿主不写操作员战役目录、关旗时仍是同 run 旁路。
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createUiServer, type UiServerHandle } from "../ui/server.js";
import { CAMPAIGNS_DIRNAME } from "../src/campaign.js";
import { formatSiblingBootContext } from "../ui/conversation-context.js";
import { resetObservabilityMetrics } from "../src/metrics.js";
import { clearCapabilityCache } from "../src/model-capability.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock, toolUseBlock } from "./helpers.js";
import { SPAWN_TASK_TOOL_NAME } from "../src/tools/spawn-task.js";

let handle: UiServerHandle | undefined;
let tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function stashEnv(...keys: string[]): void {
  for (const key of keys) savedEnv[key] = process.env[key];
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs = [];
  restoreEnv();
  resetObservabilityMetrics();
  clearCapabilityCache();
});

async function startServer(): Promise<string> {
  const port = await new Promise<number>((resolvePort, reject) => {
    handle!.server.listen(0, () => {
      const addr = handle!.server.address();
      if (addr && typeof addr === "object") resolvePort(addr.port);
      else reject(new Error("no address"));
    });
  });
  return `http://127.0.0.1:${port}`;
}

async function makeHost(opts: {
  fake?: FakeModelClient;
  campaignsRoot?: string | null;
  workdir?: string;
} = {}): Promise<{ base: string; hostWorkdir: string; fake: FakeModelClient }> {
  const dir = await mkdtemp(join(tmpdir(), "campaign-api-"));
  tempDirs.push(dir);
  const hostWorkdir = resolve(opts.workdir ?? dir);
  await mkdir(hostWorkdir, { recursive: true });
  const fake = opts.fake ?? new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]);
  handle = createUiServer({
    modelClient: fake,
    tools: [makeTool({ name: "noop", permission: "auto", parallelSafe: true })],
    workdir: hostWorkdir,
    workdirs: [hostWorkdir],
    ...(opts.campaignsRoot !== undefined ? { campaignsRoot: opts.campaignsRoot } : {}),
  });
  return { base: await startServer(), hostWorkdir, fake };
}

async function waitForDone(base: string, runId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await (await fetch(`${base}/api/runs`)).json() as { runId: string; status: string }[];
    if (list.find((r) => r.runId === runId)?.status === "done") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Run ${runId} did not reach done`);
}

async function waitForPlanGate(base: string, runId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await (await fetch(`${base}/api/runs`)).json() as {
      runId: string;
      awaitingPlanApproval?: boolean;
    }[];
    if (list.find((r) => r.runId === runId)?.awaitingPlanApproval) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Run ${runId} never awaited plan approval`);
}

describe("campaign API", () => {
  it("注入宿主缺省不写 <workdir>/.agent-campaigns", async () => {
    const { base, hostWorkdir } = await makeHost();
    const res = await fetch(`${base}/api/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "做落地页，并写 STM32 固件。",
        autoApprove: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { runId: string; campaignId: string };
    expect(body.campaignId).toBeTruthy();
    expect(existsSync(join(hostWorkdir, CAMPAIGNS_DIRNAME))).toBe(false);
  });

  it("spec-plus-deck 显式开战 → 409，不拆", async () => {
    const { base } = await makeHost();
    const res = await fetch(`${base}/api/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "写一份产品规格，并做成三页汇报幻灯。" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { reason?: string };
    expect(body.reason).toBe("spec-plus-deck");
    const runs = await (await fetch(`${base}/api/runs`)).json() as unknown[];
    expect(runs).toEqual([]);
  });

  it("AGENT_CAMPAIGN=1 时 spec-plus-deck 走普通 run，不升导演", async () => {
    stashEnv("AGENT_CAMPAIGN");
    process.env.AGENT_CAMPAIGN = "1";
    const { base } = await makeHost();
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "写一份产品规格，并做成三页汇报幻灯。" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { runId: string; campaignId?: string };
    expect(body.campaignId).toBeUndefined();
  });

  it("战役 spawn 真开 StoredRun，父事件带 runId，mailbox 只有任务书", async () => {
    stashEnv("AGENT_CAMPAIGN", "AGENT_SPAWN_TASK");
    delete process.env.AGENT_SPAWN_TASK;
    delete process.env.AGENT_CAMPAIGN;
    const campaignsDir = await mkdtemp(join(tmpdir(), "campaigns-disk-"));
    tempDirs.push(campaignsDir);
    const fake = new FakeModelClient([
      fakeMessage(
        [toolUseBlock("s1", SPAWN_TASK_TOOL_NAME, {
          title: "固件",
          description: "写固件 CHILD-SECRET",
          acceptance: ["elf"],
        })],
        "tool_use",
      ),
      fakeMessage([textBlock("支线结论：固件已写 CHILD-SECRET")], "end_turn"),
      fakeMessage([textBlock("导演收口")], "end_turn"),
    ]);
    const { base } = await makeHost({ fake, campaignsRoot: campaignsDir });
    const created = await fetch(`${base}/api/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "做落地页，并写 STM32 固件。",
        autoApprove: true,
      }),
    });
    expect(created.status).toBe(200);
    const { runId, campaignId } = await created.json() as { runId: string; campaignId: string };
    await waitForPlanGate(base, runId);
    const approve = await fetch(`${base}/api/runs/${runId}/plan-approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(approve.status).toBe(200);
    await waitForDone(base, runId);

    const list = await (await fetch(`${base}/api/runs`)).json() as {
      runId: string;
      campaignRole?: string;
      campaignId?: string;
    }[];
    expect(list.length).toBeGreaterThanOrEqual(2);
    const child = list.find((r) => r.campaignRole === "child");
    expect(child?.campaignId).toBe(campaignId);
    expect(child?.runId).toBeTruthy();

    const eventsRes = await fetch(`${base}/api/runs/${runId}/events`);
    const eventsText = await eventsRes.text();
    expect(eventsText).toContain(`"runId":"${child!.runId}"`);
    expect(eventsText).toContain("spawn_start");
    expect(eventsText).not.toContain("CHILD-SECRET 正史");

    const mail = await (await fetch(
      `${base}/api/campaigns/${campaignId}/mailbox/${child!.runId}`,
    )).json() as { actions: { action: string; task: string; transcript?: unknown }[] };
    expect(mail.actions.some((a) => a.action === "assign")).toBe(true);
    expect(mail.actions[0]?.task).toContain("写固件");
    expect(mail.actions.every((a) => a.transcript === undefined)).toBe(true);

    const transcript = await (await fetch(
      `${base}/api/campaigns/${campaignId}/transcript`,
    )).json() as { parts: { runId: string; transcript: unknown[] }[] };
    expect(transcript.parts.some((p) => p.runId === child!.runId)).toBe(true);

    const childPrompt = fake.requests.find((req) =>
      JSON.stringify(req.messages).includes("【支线 · 固件】"),
    );
    expect(childPrompt, "子对话应收到 spawn 任务书").toBeTruthy();
    const childWire = JSON.stringify(childPrompt);
    expect(childWire).toContain("【支线 · 固件】");
    expect(childWire).not.toMatch(/【战役会话】|campaignTranscript/);
  });

  it("关战役旗且仅 AGENT_SPAWN_TASK=1 时仍是同 run 旁路", async () => {
    stashEnv("AGENT_CAMPAIGN", "AGENT_SPAWN_TASK");
    delete process.env.AGENT_CAMPAIGN;
    process.env.AGENT_SPAWN_TASK = "1";
    const fake = new FakeModelClient([
      fakeMessage(
        [toolUseBlock("s1", SPAWN_TASK_TOOL_NAME, {
          title: "调查",
          description: "查一下",
        })],
        "tool_use",
      ),
      fakeMessage([textBlock("支线结论：旁路")], "end_turn"),
      fakeMessage([textBlock("父收口")], "end_turn"),
    ]);
    const { base } = await makeHost({ fake });
    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "普通任务", autoApprove: true }),
    });
    expect(created.status).toBe(200);
    const { runId } = await created.json() as { runId: string };
    await waitForDone(base, runId);
    const list = await (await fetch(`${base}/api/runs`)).json() as { runId: string }[];
    expect(list).toHaveLength(1);
    const eventsText = await (await fetch(`${base}/api/runs/${runId}/events`)).text();
    expect(eventsText).toContain("spawn/");
    expect(eventsText).toContain("spawn_start");
  });

  it("formatSiblingBootContext 仍不注入邻居任务名（契约未改）", () => {
    const text = formatSiblingBootContext({
      title: "优化站点",
      task: "帮我优化这个网站",
      recap: "截图已出",
      conversationTurn: 6,
    });
    expect(text).not.toContain("优化站点");
    expect(text).not.toContain("帮我优化这个网站");
    expect(text).toContain("不要根据工作目录");
  });

  it("子对话 first-turn 不含邻居任务名", async () => {
    stashEnv("AGENT_CAMPAIGN", "AGENT_SPAWN_TASK");
    delete process.env.AGENT_SPAWN_TASK;
    delete process.env.AGENT_CAMPAIGN;
    const fake = new FakeModelClient([
      fakeMessage([textBlock("邻居做完了 UNIQUE-NEIGHBOR-TASK")], "end_turn"),
      fakeMessage(
        [toolUseBlock("s1", SPAWN_TASK_TOOL_NAME, {
          title: "固件",
          description: "只写固件",
        })],
        "tool_use",
      ),
      fakeMessage([textBlock("支线结论：ok")], "end_turn"),
      fakeMessage([textBlock("导演收口")], "end_turn"),
    ]);
    const { base } = await makeHost({ fake });
    const neighbor = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "UNIQUE-NEIGHBOR-TASK 帮我优化这个网站" }),
    });
    const { runId: neighborId } = await neighbor.json() as { runId: string };
    await waitForDone(base, neighborId);

    const created = await fetch(`${base}/api/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "做落地页，并写 STM32 固件。",
        autoApprove: true,
      }),
    });
    const { runId } = await created.json() as { runId: string };
    await waitForPlanGate(base, runId);
    await fetch(`${base}/api/runs/${runId}/plan-approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    await waitForDone(base, runId);

    const childReq = fake.requests.find((req) =>
      JSON.stringify(req.messages).includes("【支线 · 固件】"),
    );
    expect(childReq).toBeTruthy();
    expect(JSON.stringify(childReq)).not.toContain("UNIQUE-NEIGHBOR-TASK");
  });
});

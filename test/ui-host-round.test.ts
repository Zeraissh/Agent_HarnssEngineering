/**
 * Round A–C 宿主契约：标题、自动路由、追问编排、消耗、.env 同步、MCP 配置。
 * 全用 FakeModelClient，不碰真实端点。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiServer, type UiServerHandle } from "../ui/server.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock } from "./helpers.js";
import { MODEL_STORE_SCHEMA_VERSION } from "../ui/model-config.js";

function startServer(handle: UiServerHandle): Promise<number> {
  return new Promise((resolve, reject) => {
    handle.server.listen(0, "127.0.0.1", () => {
      const addr = handle.server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("no port"));
    });
    handle.server.on("error", reject);
  });
}

async function waitForDone(base: string, runId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const list = (await (await fetch(`${base}/api/runs`)).json()) as { runId: string; status: string }[];
    if (list.find((r) => r.runId === runId)?.status === "done") return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Run ${runId} did not finish`);
}

describe("宿主 Round A–C", () => {
  let handle: UiServerHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("新建 run 列表带启发式 title", async () => {
    handle = createUiServer({
      modelClient: new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]),
      tools: [makeTool({ name: "noop", permission: "auto" })],
      workdir: process.cwd(),
    });
    const base = `http://127.0.0.1:${await startServer(handle)}`;
    const { runId } = (await (await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "写一个很长的标题用来测试启发式摘要是否截断到合适长度" }),
    })).json()) as { runId: string };
    await waitForDone(base, runId);
    const list = (await (await fetch(`${base}/api/runs`)).json()) as { runId: string; title: string }[];
    const row = list.find((r) => r.runId === runId);
    expect(row?.title).toBeTruthy();
    expect(row!.title.length).toBeLessThanOrEqual(25);
    expect(row!.title).not.toContain("是否截断到合适长度");
  });

  it("autoPack 走 router，选中的包写进列表与 packRoute", async () => {
    handle = createUiServer({
      modelClient: new FakeModelClient([
        fakeMessage([textBlock(JSON.stringify({ pack: "ts-coding", reason: "TypeScript 任务" }))], "end_turn"),
        fakeMessage([textBlock("ok")], "end_turn"),
      ]),
      tools: [makeTool({ name: "noop", permission: "auto" })],
      workdir: process.cwd(),
    });
    const base = `http://127.0.0.1:${await startServer(handle)}`;
    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "写一个 vitest", autoPack: true }),
    });
    expect(created.status).toBe(200);
    const { runId } = (await created.json()) as { runId: string };
    await waitForDone(base, runId);
    const list = (await (await fetch(`${base}/api/runs`)).json()) as {
      runId: string;
      packName: string | null;
      packRoute?: { pack: string | null; reason: string };
    }[];
    const row = list.find((r) => r.runId === runId);
    expect(row?.packName).toBe("ts-coding");
    expect(row?.packRoute).toMatchObject({ pack: "ts-coding", reason: "TypeScript 任务" });
  });

  it("已完成的单轮对话追问勾计划模式会发出 plan 事件", async () => {
    const planJson = JSON.stringify({
      subtasks: [{ id: "s1", title: "一步", description: "做 A", acceptance: ["A"], dependsOn: [] }],
    });
    const pass = fakeMessage(
      [textBlock(JSON.stringify({ passed: true, issues: [], summary: "通过" }))],
      "end_turn",
    );
    handle = createUiServer({
      modelClient: new FakeModelClient([
        fakeMessage([textBlock("第一轮")], "end_turn"),
        fakeMessage([textBlock(["```json", planJson, "```"].join("\n"))], "end_turn"),
        fakeMessage([textBlock("s1 完成")], "end_turn"),
        pass,
      ]),
      tools: [makeTool({ name: "noop", permission: "auto" })],
      workdir: process.cwd(),
    });
    const base = `http://127.0.0.1:${await startServer(handle)}`;
    const { runId } = (await (await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "先做一件小事" }),
    })).json()) as { runId: string };
    await waitForDone(base, runId);

    const follow = await fetch(`${base}/api/runs/${runId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "拆成计划再做", multiAgent: true }),
    });
    expect(follow.status).toBe(200);
    await waitForDone(base, runId);
    const sse = await fetch(`${base}/api/runs/${runId}/events`);
    const text = await sse.text();
    expect(text).toMatch(/"type":"plan"/);
  });

  it("GET /api/usage 读台账；未配置台账返回空汇总", async () => {
    handle = createUiServer({
      modelClient: new FakeModelClient([]),
      tools: [],
      workdir: process.cwd(),
    });
    const base = `http://127.0.0.1:${await startServer(handle)}`;
    const empty = await (await fetch(`${base}/api/usage`)).json() as { totalRuns: number; totalUsd: number | null };
    expect(empty.totalRuns).toBe(0);
    expect(empty.totalUsd).toBeNull();
    await handle.close();

    const dir = await mkdtemp(join(tmpdir(), "usage-"));
    const ledger = join(dir, "runs.jsonl");
    await writeFile(
      ledger,
      `${JSON.stringify({ at: Date.parse("2026-09-07T01:00:00Z"), model: "flash", turns: 2, cost: { usd: 0.05 } })}\n`,
      "utf8",
    );
    handle = createUiServer({
      modelClient: new FakeModelClient([]),
      tools: [],
      workdir: process.cwd(),
      ledger,
    });
    const base2 = `http://127.0.0.1:${await startServer(handle)}`;
    const report = await (await fetch(`${base2}/api/usage`)).json() as { totalRuns: number; totalUsd: number };
    expect(report.totalRuns).toBe(1);
    expect(report.totalUsd).toBeCloseTo(0.05);
  });

  it("同步到 .env 只改模型键，不写 key；未配置落点 409", async () => {
    handle = createUiServer({
      modelClient: new FakeModelClient([]),
      tools: [],
      workdir: process.cwd(),
    });
    const base = `http://127.0.0.1:${await startServer(handle)}`;
    const denied = await fetch(`${base}/api/models/sync-env`, { method: "POST" });
    expect(denied.status).toBe(409);
    await handle.close();

    const dir = await mkdtemp(join(tmpdir(), "envsync-"));
    const envPath = join(dir, ".env");
    const storePath = join(dir, ".agent-models.json");
    await writeFile(envPath, "# keep\nFOO=bar\nAGENT_MODEL=old\n", "utf8");
    await writeFile(
      storePath,
      JSON.stringify({
        schemaVersion: MODEL_STORE_SCHEMA_VERSION,
        models: [{
          id: "e1",
          label: "exec",
          provider: "openai",
          model: "flash-x",
          baseUrl: "https://api.example.com",
          apiKey: "sk-should-not-leak",
        }],
        roles: { executor: "e1", planner: null, verifier: null, vision: null },
      }),
      "utf8",
    );
    handle = createUiServer({
      modelClient: new FakeModelClient([]),
      tools: [],
      workdir: process.cwd(),
      envFile: envPath,
      modelStoreFile: storePath,
    });
    const base2 = `http://127.0.0.1:${await startServer(handle)}`;
    const res = await fetch(`${base2}/api/models/sync-env`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { changed: string[] };
    expect(body.changed).toContain("AGENT_MODEL");
    const written = await readFile(envPath, "utf8");
    expect(written).toContain("# keep");
    expect(written).toContain("FOO=bar");
    expect(written).toMatch(/AGENT_MODEL=flash-x/);
    expect(written).not.toContain("sk-should-not-leak");
  });

  it("MCP 配置可列出、添加、停用", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-"));
    const mcpFile = join(dir, "mcp.json");
    await writeFile(mcpFile, JSON.stringify({ servers: { demo: { command: "python", args: ["-m", "x"] } } }), "utf8");
    handle = createUiServer({
      modelClient: new FakeModelClient([]),
      tools: [],
      workdir: process.cwd(),
      mcpConfigFile: mcpFile,
    });
    const base = `http://127.0.0.1:${await startServer(handle)}`;
    const listed = await (await fetch(`${base}/api/mcp`)).json() as { servers: { name: string; enabled: boolean }[] };
    expect(listed.servers.map((s) => s.name)).toContain("demo");

    const added = await fetch(`${base}/api/mcp`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "http1", server: { url: "http://127.0.0.1:9", enabled: true } }),
    });
    expect(added.status).toBe(200);

    const paused = await fetch(`${base}/api/mcp`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo", server: { enabled: false } }),
    });
    expect(paused.status).toBe(200);
    const after = await (await fetch(`${base}/api/mcp`)).json() as { servers: { name: string; enabled: boolean; url?: string }[] };
    expect(after.servers.find((s) => s.name === "demo")?.enabled).toBe(false);
    expect(after.servers.find((s) => s.name === "http1")?.url).toContain("127.0.0.1");
  });

  it("POST /api/complete 只做启发式续写，不碰模型", async () => {
    const client = new FakeModelClient([]);
    handle = createUiServer({
      modelClient: client,
      tools: [makeTool({ name: "noop", permission: "auto" })],
      workdir: process.cwd(),
    });
    const base = `http://127.0.0.1:${await startServer(handle)}`;
    const res = await fetch(`${base}/api/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefix: "帮我看看", recent: [] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { completion: string | null };
    expect(body.completion).toBe("这个项目现在的状态，用三句话总结。");
    expect(client.requests).toEqual([]);
  });
});

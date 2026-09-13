/**
 * GET /api/cite-candidates + POST /api/runs citedRunIds 装配【引用】块。
 * 同 workdir；不读 transcript/events；不改 formatSiblingBootContext。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiServer, type UiServerHandle } from "../ui/server.js";
import { formatSiblingBootContext } from "../ui/conversation-context.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock } from "./helpers.js";
import { resetObservabilityMetrics } from "../src/metrics.js";
import { clearCapabilityCache } from "../src/model-capability.js";

let handle: UiServerHandle | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  resetObservabilityMetrics();
  clearCapabilityCache();
});

async function startServer(): Promise<string> {
  const port = await new Promise<number>((ok, reject) => {
    handle!.server.listen(0, "127.0.0.1", () => {
      const addr = handle!.server.address();
      if (addr && typeof addr === "object") ok(addr.port);
      else reject(new Error("no address"));
    });
  });
  return `http://127.0.0.1:${port}`;
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

describe("cite-candidates + citedRunIds", () => {
  it("只列同目录可见会话与主产物；POST 把【引用】注入首轮任务书并写入 run_config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cite-api-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "index.html"), "<html></html>");
    await mkdir(join(dir, "pm-spec"));
    await writeFile(join(dir, "pm-spec", "index.html"), "<html></html>");
    const client = new FakeModelClient([
      fakeMessage([textBlock("已写完规格。")], "end_turn"),
      fakeMessage([textBlock("接着做。")], "end_turn"),
    ]);
    handle = createUiServer({
      modelClient: client,
      tools: [makeTool({ name: "noop", permission: "auto", parallelSafe: true })],
      workdir: dir,
    });
    const base = await startServer();

    const first = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "写一份产品规格\n第二行不进候选" }),
    });
    expect(first.status).toBe(200);
    const { runId: specId } = (await first.json()) as { runId: string };
    await waitForDone(base, specId);

    const missing = await fetch(`${base}/api/cite-candidates`);
    expect(missing.status).toBe(400);

    const listed = await (await fetch(
      `${base}/api/cite-candidates?workdir=${encodeURIComponent(dir)}`,
    )).json() as {
      candidates: Array<{
        runId: string;
        title: string;
        task: string;
        conversationRecap: string | null;
        artifacts: string[];
      }>;
    };
    expect(listed.candidates).toHaveLength(1);
    expect(listed.candidates[0]!.runId).toBe(specId);
    expect(listed.candidates[0]!.task).toBe("写一份产品规格");
    expect(listed.candidates[0]!.artifacts).toEqual(["index.html", "pm-spec/index.html"]);
    expect(JSON.stringify(listed)).not.toContain("transcript");
    expect(JSON.stringify(listed)).not.toContain("events.jsonl");

    const second = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "根据引用出一页幻灯", citedRunIds: [specId] }),
    });
    expect(second.status).toBe(200);
    const { runId: deckId } = (await second.json()) as { runId: string };
    await waitForDone(base, deckId);

    const citeReq = client.requests.find((req) => {
      const firstUser = req.messages.find((m) => m.role === "user");
      const text = typeof firstUser?.content === "string"
        ? firstUser.content
        : Array.isArray(firstUser?.content)
          ? firstUser.content.map((b) => ("text" in b ? b.text : "")).join("")
          : "";
      return text.includes("【引用】");
    });
    expect(citeReq).toBeTruthy();
    const prompt = JSON.stringify(citeReq?.messages);
    expect(prompt).toContain("【引用】");
    expect(prompt).toContain(specId);
    expect(prompt).toContain("写一份产品规格");
    expect(prompt).toContain("index.html");
    expect(prompt).not.toContain("transcript");

    const sse = await (await fetch(`${base}/api/runs/${deckId}/events`)).text();
    expect(sse).toContain('"type":"run_config"');
    expect(sse).toContain('"cited"');
    expect(sse).toContain(specId);

    expect(formatSiblingBootContext({
      title: "邻居",
      task: "优化 liquid-demo",
      recap: "已改完。",
      conversationTurn: 2,
    })).not.toContain("liquid-demo");
  });

  it("别的 workdir 的 runId 不注入", async () => {
    const here = await mkdtemp(join(tmpdir(), "cite-here-"));
    const other = await mkdtemp(join(tmpdir(), "cite-other-"));
    tempDirs.push(here, other);
    const client = new FakeModelClient([
      fakeMessage([textBlock("ok")], "end_turn"),
      fakeMessage([textBlock("ok")], "end_turn"),
    ]);
    handle = createUiServer({
      modelClient: client,
      tools: [makeTool({ name: "noop", permission: "auto", parallelSafe: true })],
      workdir: here,
      workdirs: [here, other],
    });
    const base = await startServer();
    const foreign = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "邻居任务", workdir: other }),
    });
    const { runId: foreignId } = (await foreign.json()) as { runId: string };
    await waitForDone(base, foreignId);

    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "本目录新开", workdir: here, citedRunIds: [foreignId] }),
    });
    expect(created.status).toBe(200);
    const { runId } = (await created.json()) as { runId: string };
    await waitForDone(base, runId);
    const last = JSON.stringify(client.requests.at(-1)?.messages ?? []);
    expect(last).toContain("本目录新开");
    expect(last).not.toContain("【引用】");
    expect(last).not.toContain("邻居任务");
  });
});

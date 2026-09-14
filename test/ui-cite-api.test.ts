/**
 * GET /api/cite-candidates + POST /api/runs citedRunIds 装配【引用】块。
 * 同项目跨 workdir 放行；其它项目 / 无项目跨目录拒绝。
 * 不读 transcript/events；不改 formatSiblingBootContext。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiServer, type UiServerHandle } from "../ui/server.js";
import { formatSiblingBootContext } from "../ui/conversation-context.js";
import { citeWorkdirLabel } from "../ui/cite.js";
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

  it("同项目跨 workdir 可引用；块带目录标签且不含 transcript", async () => {
    const here = await mkdtemp(join(tmpdir(), "cite-here-"));
    const sibling = await mkdtemp(join(tmpdir(), "cite-sib-"));
    tempDirs.push(here, sibling);
    await writeFile(join(sibling, "DESIGN.md"), "# brand\n");
    await mkdir(join(sibling, ".agent-run-history", "r-secret"), { recursive: true });
    await writeFile(join(sibling, ".agent-run-history", "r-secret", "transcript.jsonl"), "{secret}\n");
    await writeFile(join(sibling, ".agent-run-history", "r-secret", "events.jsonl"), "{secret}\n");
    const client = new FakeModelClient([
      fakeMessage([textBlock("规格写完。")], "end_turn"),
      fakeMessage([textBlock("接着做。")], "end_turn"),
    ]);
    handle = createUiServer({
      modelClient: client,
      tools: [makeTool({ name: "noop", permission: "auto", parallelSafe: true })],
      workdir: here,
      workdirs: [here, sibling],
    });
    const base = await startServer();

    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "看板", workdirs: [here, sibling], primaryWorkdir: here }),
    });
    expect(created.status).toBe(200);
    const { project } = (await created.json()) as { project: { id: string } };

    const spec = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "写一份产品规格", workdir: sibling, projectId: project.id }),
    });
    expect(spec.status).toBe(200);
    const { runId: specId } = (await spec.json()) as { runId: string };
    await waitForDone(base, specId);

    const listed = await (await fetch(
      `${base}/api/cite-candidates?workdir=${encodeURIComponent(here)}`,
    )).json() as {
      projectId?: string;
      candidates: Array<{ runId: string; artifacts: string[]; workdirLabel?: string }>;
    };
    expect(listed.projectId).toBe(project.id);
    expect(listed.candidates.map((c) => c.runId)).toContain(specId);
    const hit = listed.candidates.find((c) => c.runId === specId);
    expect(hit?.artifacts).toEqual(["DESIGN.md"]);
    expect(hit?.workdirLabel).toBe(citeWorkdirLabel(sibling));
    expect(JSON.stringify(listed)).not.toContain("transcript");
    expect(JSON.stringify(listed)).not.toContain("{secret}");

    const second = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "根据引用出一页幻灯",
        workdir: here,
        projectId: project.id,
        citedRunIds: [specId],
      }),
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
    expect(prompt).toContain(citeWorkdirLabel(sibling));
    expect(prompt).toContain("DESIGN.md");
    expect(prompt).not.toContain("transcript");
    expect(prompt).not.toContain("{secret}");
    expect(prompt).not.toContain("events.jsonl");

    const sse = await (await fetch(`${base}/api/runs/${deckId}/events`)).text();
    expect(sse).toContain('"cited"');
    expect(sse).toContain(specId);
    expect(sse).toContain(citeWorkdirLabel(sibling));
  });

  it("别的项目的 runId 不注入", async () => {
    const here = await mkdtemp(join(tmpdir(), "cite-proj-a-"));
    const other = await mkdtemp(join(tmpdir(), "cite-proj-b-"));
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
    const projA = await (await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "甲", workdirs: [here], primaryWorkdir: here }),
    })).json() as { project: { id: string } };
    const projB = await (await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "乙", workdirs: [other], primaryWorkdir: other }),
    })).json() as { project: { id: string } };

    const foreign = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "邻居任务", workdir: other, projectId: projB.project.id }),
    });
    const { runId: foreignId } = (await foreign.json()) as { runId: string };
    await waitForDone(base, foreignId);

    const listed = await (await fetch(
      `${base}/api/cite-candidates?workdir=${encodeURIComponent(here)}`,
    )).json() as { candidates: Array<{ runId: string }> };
    expect(listed.candidates.map((c) => c.runId)).not.toContain(foreignId);

    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "本目录新开",
        workdir: here,
        projectId: projA.project.id,
        citedRunIds: [foreignId],
      }),
    });
    expect(created.status).toBe(200);
    const { runId } = (await created.json()) as { runId: string };
    await waitForDone(base, runId);
    const last = JSON.stringify(client.requests.at(-1)?.messages ?? []);
    expect(last).toContain("本目录新开");
    expect(last).not.toContain("【引用】");
    expect(last).not.toContain("邻居任务");
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

    const listed = await (await fetch(
      `${base}/api/cite-candidates?workdir=${encodeURIComponent(here)}`,
    )).json() as { candidates: Array<{ runId: string; workdirLabel?: string }> };
    expect(listed.candidates.map((c) => c.runId)).not.toContain(foreignId);
    expect(JSON.stringify(listed)).not.toContain(foreignId);

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

  it("追问带 citedRunIds 装配【引用】；别的 workdir 仍不注入", async () => {
    const here = await mkdtemp(join(tmpdir(), "cite-fu-"));
    const other = await mkdtemp(join(tmpdir(), "cite-fu-other-"));
    tempDirs.push(here, other);
    const client = new FakeModelClient([
      fakeMessage([textBlock("本场先做完。")], "end_turn"),
      fakeMessage([textBlock("规格写完。")], "end_turn"),
      fakeMessage([textBlock("邻居写完。")], "end_turn"),
      fakeMessage([textBlock("追问也做完。")], "end_turn"),
      fakeMessage([textBlock("跨目录追问。")], "end_turn"),
    ]);
    handle = createUiServer({
      modelClient: client,
      tools: [makeTool({ name: "noop", permission: "auto", parallelSafe: true })],
      workdir: here,
      workdirs: [here, other],
    });
    const base = await startServer();

    const main = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "本场任务", workdir: here }),
    });
    expect(main.status).toBe(200);
    const { runId } = (await main.json()) as { runId: string };
    await waitForDone(base, runId);

    const spec = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "被引用的规格", workdir: here }),
    });
    expect(spec.status).toBe(200);
    const { runId: specId } = (await spec.json()) as { runId: string };
    await waitForDone(base, specId);

    const foreign = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "邻居任务", workdir: other }),
    });
    expect(foreign.status).toBe(200);
    const { runId: foreignId } = (await foreign.json()) as { runId: string };
    await waitForDone(base, foreignId);

    const follow = await fetch(`${base}/api/runs/${runId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "对照那一场", citedRunIds: [specId] }),
    });
    expect(follow.status).toBe(200);
    await waitForDone(base, runId);

    const last = JSON.stringify(client.requests.at(-1)?.messages ?? []);
    expect(last).toContain("对照那一场");
    expect(last).toContain("【引用】");
    expect(last).toContain("被引用的规格");
    expect(last).toContain(specId);

    const skipped = await fetch(`${base}/api/runs/${runId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "别引邻居", citedRunIds: [foreignId] }),
    });
    expect(skipped.status).toBe(200);
    await waitForDone(base, runId);
    const lastUser = [...(client.requests.at(-1)?.messages ?? [])]
      .reverse()
      .find((m) => m.role === "user");
    const lastUserText = typeof lastUser?.content === "string"
      ? lastUser.content
      : Array.isArray(lastUser?.content)
        ? lastUser.content.map((b) => ("text" in b ? b.text : "")).join("")
        : "";
    expect(lastUserText).toContain("别引邻居");
    expect(lastUserText).not.toContain("【引用】");
    expect(lastUserText).not.toContain(foreignId);
  });
});

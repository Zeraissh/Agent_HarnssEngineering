/**
 * T6 全局搜索端点契约测试——GET /api/search?q=...&limit=...。
 *
 * 全用注入的 FakeModelClient + 临时 history 根（options.history 显式指向
 * 临时目录；historyKeep 拉高防止启动修剪删掉样本档案），不碰真实历史。
 *
 * 覆盖：
 *   a. 标题命中（titleHit=true，无正文片段）与正文命中（snippets 带上下文）
 *   b. 大小写不敏感子串匹配
 *   c. 片段截取：命中词前后各约 60 字符 + 省略号 + lineHint 行号
 *   d. 每 run 最多 3 条正文命中
 *   e. limit 参数生效；结果按 updatedAt 降序
 *   f. q 为空 / 长度 < 2 → 400
 *   g. 历史目录不存在 → 200 空结果（不报错）
 *   h. 圈禁：只读历史根内平铺目录；根外同名关键词文件不出现；q 含 ".." 只是普通子串
 *   i. 扫描上限：>500 个 run 时 truncatedRuns=true
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiServer, type UiServerHandle } from "../ui/server.js";
import { FakeModelClient } from "./helpers.js";

function startServer(handle: UiServerHandle): Promise<number> {
  return new Promise((resolve, reject) => {
    handle.server.listen(0, () => {
      const address = handle.server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("Could not get server port"));
    });
    handle.server.on("error", reject);
  });
}

interface SearchResultDto {
  runId: string;
  title: string;
  workdir: string | null;
  status: string;
  updatedAt: number;
  titleHit: boolean;
  snippets: { text: string; lineHint: string }[];
}

interface SearchResponseDto {
  query: string;
  results: SearchResultDto[];
  truncatedRuns: boolean;
}

function metaShape(runId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    runId,
    task: "普通任务",
    status: "done",
    verify: false,
    createdAt: 1_000,
    finishedAt: 2_000,
    packName: null,
    mode: "single",
    effort: null,
    rubric: null,
    workdir: null,
    conversationTurn: 1,
    planGate: false,
    planDecision: null,
    mainStopReason: "completed",
    outcome: null,
    ...overrides,
  };
}

async function seedRun(
  root: string,
  runId: string,
  meta: Record<string, unknown>,
  transcriptSegments: unknown[] = [],
): Promise<void> {
  const dir = join(root, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), JSON.stringify(metaShape(runId, meta)), "utf8");
  if (transcriptSegments.length > 0) {
    const lines = transcriptSegments.map((s) => (typeof s === "string" ? s : JSON.stringify(s)));
    await writeFile(join(dir, "transcript.jsonl"), `${lines.join("\n")}\n`, "utf8");
  }
}

/** 造一段会话正文：user 字符串 content + assistant 块数组 content */
function segment(...texts: string[]): unknown {
  return {
    index: 0,
    source: "main",
    messages: [
      { role: "user", content: texts[0] ?? "" },
      {
        role: "assistant",
        content: texts.slice(1).map((text) => ({ type: "text", text })),
      },
    ],
  };
}

describe("T6 /api/search 全局搜索端点", () => {
  let handle: UiServerHandle | undefined;
  let workdir: string;
  let historyRoot: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "ui-search-api-"));
    historyRoot = join(workdir, "history");
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    await rm(workdir, { recursive: true, force: true });
  });

  async function boot(): Promise<string> {
    handle = createUiServer({
      modelClient: new FakeModelClient([]),
      tools: [],
      workdir,
      history: historyRoot,
      // 启动恢复会先修剪再挂载：默认 keep=50 会把 500+ 样本剪掉，测试拉高
      historyKeep: 10_000,
    });
    return `http://127.0.0.1:${await startServer(handle)}`;
  }

  async function search(base: string, qs: string): Promise<Response> {
    return fetch(`${base}/api/search${qs}`);
  }

  it("a. 标题命中标 titleHit；正文命中带片段；两档可同时成立", async () => {
    await seedRun(historyRoot, "run-title", { task: "修理 KiCad 封装" });
    await seedRun(historyRoot, "run-body", { task: "无关任务" }, [
      segment("请帮我画一块板子", "好的，先在 KiCad 里建工程。"),
    ]);
    const base = await boot();
    const res = await search(base, "?q=kicad");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResponseDto;
    expect(body.query).toBe("kicad");
    expect(body.truncatedRuns).toBe(false);
    expect(body.results).toHaveLength(2);
    const titleHit = body.results.find((r) => r.runId === "run-title")!;
    expect(titleHit.titleHit).toBe(true);
    expect(titleHit.title).toBe("修理 KiCad 封装");
    expect(titleHit.snippets).toEqual([]);
    const bodyHit = body.results.find((r) => r.runId === "run-body")!;
    expect(bodyHit.titleHit).toBe(false);
    expect(bodyHit.snippets).toHaveLength(1);
    expect(bodyHit.snippets[0]!.text).toContain("KiCad");
  });

  it("b. 大小写不敏感：查询 KICAD 命中 kicad", async () => {
    await seedRun(historyRoot, "run-case", { task: "kicad 学习笔记" });
    const base = await boot();
    const body = (await (await search(base, "?q=KICAD")).json()) as SearchResponseDto;
    expect(body.results.map((r) => r.runId)).toEqual(["run-case"]);
  });

  it("c. 片段带前后各约 60 字符上下文，截断处加省略号，标注行号", async () => {
    const pad = "甲".repeat(100);
    await seedRun(historyRoot, "run-snippet", { task: "无关" }, [
      segment(`${pad}目标词${pad}`),
    ]);
    const base = await boot();
    const body = (await (await search(base, "?q=目标词")).json()) as SearchResponseDto;
    const snippet = body.results[0]!.snippets[0]!;
    expect(snippet.text.startsWith("…")).toBe(true);
    expect(snippet.text.endsWith("…")).toBe(true);
    expect(snippet.text).toContain("目标词");
    // 60 字符上下文 + 省略号 + 命中词本身
    expect(snippet.text.length).toBe(1 + 60 + 3 + 60 + 1);
    expect(snippet.lineHint).toBe("transcript.jsonl 第 1 行");
    // 短文本不强行补省略号
    await seedRun(historyRoot, "run-short", { task: "无关2" }, [segment("这里有目标词。")]);
    const body2 = (await (await search(base, "?q=目标词")).json()) as SearchResponseDto;
    const short = body2.results.find((r) => r.runId === "run-short")!.snippets[0]!;
    expect(short.text).toBe("这里有目标词。");
  });

  it("d. 每 run 最多 3 条正文命中", async () => {
    await seedRun(historyRoot, "run-many", { task: "无关" }, [
      segment("命中点 一"),
      segment("命中点 二"),
      segment("命中点 三"),
      segment("命中点 四"),
      segment("命中点 五"),
    ]);
    const base = await boot();
    const body = (await (await search(base, "?q=命中点")).json()) as SearchResponseDto;
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.snippets).toHaveLength(3);
  });

  it("e. limit 截断结果数；结果按 updatedAt 降序", async () => {
    await seedRun(historyRoot, "run-old", { task: "关键词 旧", finishedAt: 1_000 });
    await seedRun(historyRoot, "run-mid", { task: "关键词 中", finishedAt: 5_000 });
    await seedRun(historyRoot, "run-new", { task: "关键词 新", finishedAt: 9_000 });
    const base = await boot();
    const all = (await (await search(base, "?q=关键词")).json()) as SearchResponseDto;
    expect(all.results.map((r) => r.runId)).toEqual(["run-new", "run-mid", "run-old"]);
    const limited = (await (await search(base, "?q=关键词&limit=2")).json()) as SearchResponseDto;
    expect(limited.results.map((r) => r.runId)).toEqual(["run-new", "run-mid"]);
  });

  it("f. q 为空或长度 < 2 → 400", async () => {
    const base = await boot();
    expect((await search(base, "")).status).toBe(400);
    expect((await search(base, "?q=")).status).toBe(400);
    expect((await search(base, "?q=%20")).status).toBe(400);
    expect((await search(base, "?q=a")).status).toBe(400);
    expect((await search(base, "?q=ab")).status).not.toBe(400);
  });

  it("g. 历史目录不存在 → 200 空结果", async () => {
    const base = await boot();
    const res = await search(base, "?q=任何词");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResponseDto;
    expect(body.results).toEqual([]);
    expect(body.truncatedRuns).toBe(false);
  });

  it("h. 圈禁：只读历史根内目录；根外文件不出现；q 含 .. 只是普通子串", async () => {
    await seedRun(historyRoot, "run-inside", { task: "圈禁词 在内" });
    // 历史根**之外**放一个含同关键词的文件：绝不应被读到
    await writeFile(join(workdir, "outside.json"), JSON.stringify(segment("圈禁词 在外")), "utf8");
    const base = await boot();
    const body = (await (await search(base, "?q=圈禁词")).json()) as SearchResponseDto;
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.runId).toBe("run-inside");
    // 路径穿越形状的查询词不报错、不逃逸，只是没有匹配
    const traversal = await search(base, `?q=${encodeURIComponent("..\\..")}`);
    expect(traversal.status).toBe(200);
    expect(((await traversal.json()) as SearchResponseDto).results).toEqual([]);
  });

  it("i. 超过 500 个 run 时截断扫描并标注 truncatedRuns", { timeout: 60_000 }, async () => {
    for (let i = 0; i < 501; i++) {
      await seedRun(historyRoot, `run-${String(i).padStart(4, "0")}`, { task: `扫描词 ${i}` });
    }
    const base = await boot();
    const body = (await (await search(base, "?q=扫描词&limit=100")).json()) as SearchResponseDto;
    expect(body.truncatedRuns).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.length).toBeLessThanOrEqual(100);
  });
});

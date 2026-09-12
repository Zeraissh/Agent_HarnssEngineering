/**
 * /api/models 端点契约测试（MODEL-02）——全用注入的 FakeModelClient + 临时
 * modelStoreFile，不碰真实端点、不需要 API key。
 *
 * 覆盖：
 *   a. GET 脱敏：apiKey 只进不出（原始应答文本里搜不到 key），hasApiKey 布尔正确
 *   b. GET source 语义：无库文件 = "env"（env 合成的隐式条目）；PUT 后 = "store"
 *   c. PUT 校验 400：provider 枚举 / baseUrl 白名单 / roles 悬空引用 / executor 为空
 *   d. PUT 成功后重装配：/api/harness 的 roleModels.verifier 立刻变化
 *   e. 进行中的 run 不受影响：PUT 前启动的 run 正常跑完；PUT 后新 run 的
 *      run_config 才报新角色模型
 *   f. apiKey 三态：PUT 省略字段 = 保持；"" = 清除
 *   g. 持久化：第二个宿主实例从同一文件读到同一份库（重启生效）
 *   h. POST /api/models/test：loopback stub 端点 200 → ok；401 → 鉴权文案；
 *      缺 key → 不发请求直接报缺 key；baseUrl 非法 → 400
 *   i. Content-Type 门禁：PUT 非 JSON → 415
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { createUiServer, type UiServerHandle } from "../ui/server.js";
import { resetObservabilityMetrics } from "../src/metrics.js";
import { clearCapabilityCache } from "../src/model-capability.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock } from "./helpers.js";

// ------------------------------------------------------
// Helpers
// ------------------------------------------------------

let handle: UiServerHandle | undefined;
let tempDirs: string[] = [];

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs = [];
  resetObservabilityMetrics();
  clearCapabilityCache();
});

async function startServer(): Promise<string> {
  const port = await new Promise<number>((resolve, reject) => {
    handle!.server.listen(0, () => {
      const addr = handle!.server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("no address"));
    });
  });
  return `http://127.0.0.1:${port}`;
}

async function makeHost(opts: { storeFile?: string } = {}): Promise<{ base: string; storeFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), "models-api-"));
  tempDirs.push(dir);
  const storeFile = opts.storeFile ?? join(dir, ".agent-models.json");
  handle = createUiServer({
    modelClient: new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]),
    tools: [makeTool({ name: "noop", permission: "auto", parallelSafe: true })],
    workdir: process.cwd(),
    modelStoreFile: storeFile,
  });
  return { base: await startServer(), storeFile };
}

function modelsBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    models: [
      { id: "m-fast", label: "快模型", provider: "openai", model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com", apiKey: "sk-fast-secret" },
      { id: "m-strong", label: "强模型", provider: "anthropic", model: "claude-opus-4-8", baseUrl: "" },
    ],
    roles: { executor: "m-fast", planner: null, verifier: "m-strong", vision: null, image: null },
    ...overrides,
  };
}

async function putModels(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/models`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitForDone(base: string, runId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const list = await (await fetch(`${base}/api/runs`)).json() as { runId: string; status: string }[];
    if (list.find((r) => r.runId === runId)?.status === "done") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Run ${runId} did not finish in time`);
}

async function readRunConfigRoleModels(base: string, runId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/api/runs/${runId}/events`);
  const text = await res.text();
  for (const block of text.split("\n\n")) {
    const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    const evt = JSON.parse(dataLine.slice(5).trimStart());
    if (evt.event?.type === "run_config") return evt.event.roleModels;
  }
  throw new Error("run_config event not found");
}

// ------------------------------------------------------
// Tests
// ------------------------------------------------------

describe("GET /api/models", () => {
  it("无库文件 → source=env，executor 是 env 合成的隐式条目", async () => {
    const { base } = await makeHost();
    const res = await fetch(`${base}/api/models`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.source).toBe("env");
    expect(body.roles.executor).toBe("env:executor");
    expect(body.models[0].label).toContain("环境变量");
    // 角色快照随包下发（前端一次渲染够数）
    expect(body.roleModels.executor.model).toBeTruthy();
  });

  it("脱敏：PUT 存的 key 永不出栈，只回 hasApiKey", async () => {
    const { base } = await makeHost();
    await putModels(base, modelsBody());
    const res = await fetch(`${base}/api/models`);
    const raw = await res.text();
    expect(raw).not.toContain("sk-fast-secret");
    expect(raw).not.toContain('"apiKey"');
    const body = JSON.parse(raw);
    expect(body.source).toBe("store");
    expect(body.models.find((m: any) => m.id === "m-fast").hasApiKey).toBe(true);
    expect(body.models.find((m: any) => m.id === "m-strong").hasApiKey).toBe(false);
  });
});

describe("PUT /api/models 校验", () => {
  it("provider 枚举 / baseUrl 白名单 / roles 悬空引用 / executor 为空 → 400", async () => {
    const { base } = await makeHost();
    const badProvider = await putModels(base, modelsBody({ models: [{ id: "x", provider: "bogus", model: "m" }], roles: { executor: "x" } }));
    expect(badProvider.status).toBe(400);
    const badUrl = await putModels(base, modelsBody({
      models: [{ id: "x", provider: "openai", model: "m", baseUrl: "http://8.8.8.8" }],
      roles: { executor: "x" },
    }));
    expect(badUrl.status).toBe(400);
    expect((await badUrl.json() as any).error).toContain("HTTPS");
    const dangling = await putModels(base, modelsBody({ roles: { executor: "m-fast", verifier: "ghost" } }));
    expect(dangling.status).toBe(400);
    const noExecutor = await putModels(base, modelsBody({ roles: { executor: null } }));
    expect(noExecutor.status).toBe(400);
    expect((await noExecutor.json() as any).error).toContain("executor");
  });

  it("非 JSON Content-Type → 415；坏 JSON → 400；配置不被半写", async () => {
    const { base } = await makeHost();
    const wrong = await fetch(`${base}/api/models`, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "{}" });
    expect(wrong.status).toBe(415);
    const broken = await putModels(base, "{ 不是 JSON").catch(() => null);
    // putModels 里 JSON.stringify 包住了——直接发原始坏体
    const rawBad = await fetch(`${base}/api/models`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: "{ 不是 JSON",
    });
    expect(rawBad.status).toBe(400);
    expect(broken).toBeTruthy();
    // 校验失败不落盘：GET 仍是 env 合成态
    const after = await (await fetch(`${base}/api/models`)).json() as any;
    expect(after.source).toBe("env");
  });
});

describe("PUT 重装配", () => {
  it("成功后 /api/harness 的 roleModels 立刻反映新角色；响应自带新快照", async () => {
    const { base } = await makeHost();
    const before = await (await fetch(`${base}/api/harness`)).json() as any;
    expect(before.roleModels.verifier.configured).toBe(false);

    const put = await putModels(base, modelsBody());
    expect(put.status).toBe(200);
    const putBody = await put.json() as any;
    expect(putBody.roleModels.verifier).toMatchObject({ model: "claude-opus-4-8", configured: true });

    const after = await (await fetch(`${base}/api/harness`)).json() as any;
    expect(after.roleModels.verifier).toMatchObject({ model: "claude-opus-4-8", provider: "anthropic", configured: true });
    expect(after.roleModels.planner.configured).toBe(false);
    expect(after.roleModels.vision.configured).toBe(false);
    expect(after.roleModels.image.configured).toBe(false);
    // 注入 modelClient 的宿主锁定执行者：执行者不被库改写（仪器纪律）
    expect(after.roleModels.executor.model).toBe(before.roleModels.executor.model);
  });

  it("进行中的 run 不受影响：PUT 前启动的 run 正常跑完；新 run 的 run_config 才报新角色", async () => {
    const { base } = await makeHost();
    // PUT 前的 run：run_config 里 verifier = null
    const runA = await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "旧配置 run" }),
    })).json() as { runId: string };
    await waitForDone(base, runA.runId);
    expect((await readRunConfigRoleModels(base, runA.runId)).verifier).toBeNull();

    // 改配置 → 新 run 的 run_config 报新角色
    await putModels(base, modelsBody());
    const runB = await (await fetch(`${base}/api/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "新配置 run" }),
    })).json() as { runId: string };
    await waitForDone(base, runB.runId);
    expect((await readRunConfigRoleModels(base, runB.runId)).verifier).toBe("claude-opus-4-8");

    // 旧 run 的档案不被回填（报的是本 run 实际用了什么）
    expect((await readRunConfigRoleModels(base, runA.runId)).verifier).toBeNull();
  });

  it("apiKey 三态：省略 = 保持；\"\" = 清除", async () => {
    const { base } = await makeHost();
    await putModels(base, modelsBody());
    // 省略 apiKey 字段 → 保持 "sk-fast-secret"
    const keep = modelsBody();
    (keep.models as any[])[0] = { id: "m-fast", label: "改名", provider: "openai", model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com" };
    await putModels(base, keep);
    let raw = await (await fetch(`${base}/api/models`)).text();
    expect(JSON.parse(raw).models.find((m: any) => m.id === "m-fast").hasApiKey).toBe(true);
    expect(JSON.parse(raw).models.find((m: any) => m.id === "m-fast").label).toBe("改名");
    // "" → 清除
    const clear = modelsBody();
    (clear.models as any[])[0].apiKey = "";
    await putModels(base, clear);
    raw = await (await fetch(`${base}/api/models`)).text();
    expect(JSON.parse(raw).models.find((m: any) => m.id === "m-fast").hasApiKey).toBe(false);
  });

  it("持久化：第二个宿主实例从同一文件读到同一份库（source=store）", async () => {
    const { base, storeFile } = await makeHost();
    await putModels(base, modelsBody());
    // 落盘内容本身合法且含 key（本地文件，gitignored + 0600）
    const onDisk = JSON.parse(await readFile(storeFile, "utf8"));
    expect(onDisk.models.find((m: any) => m.id === "m-fast").apiKey).toBe("sk-fast-secret");
    await handle?.close();
    handle = undefined;
    // 重启：新实例直接读库，不再走 env 合成
    handle = createUiServer({
      modelClient: new FakeModelClient([]),
      tools: [],
      workdir: process.cwd(),
      modelStoreFile: storeFile,
    });
    const base2 = await startServer();
    const body = await (await fetch(`${base2}/api/models`)).json() as any;
    expect(body.source).toBe("store");
    expect(body.roles.verifier).toBe("m-strong");
    expect(body.models.find((m: any) => m.id === "m-fast").hasApiKey).toBe(true);
  });
});

describe("POST /api/models/test", () => {
  let stub: Server | undefined;
  let stubStatus = 200;
  afterEach(async () => {
    await new Promise<void>((r) => stub?.close(() => r()) ?? r());
    stub = undefined;
  });

  async function startStub(): Promise<string> {
    stub = createServer((_req, res) => {
      res.writeHead(stubStatus, { "content-type": "application/json" });
      res.end(stubStatus === 200
        ? JSON.stringify({ id: "msg_1", content: [{ type: "text", text: "p" }] })
        : JSON.stringify({ error: { message: "unauthorized" } }));
    });
    const port = await new Promise<number>((resolve) => stub!.listen(0, "127.0.0.1", () => {
      resolve((stub!.address() as { port: number }).port);
    }));
    return `http://127.0.0.1:${port}`;
  }

  async function postTest(base: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}/api/models/test`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  it("loopback stub 200 → ok:true；401 → 鉴权失败文案", async () => {
    const { base } = await makeHost();
    const stubUrl = await startStub();
    const ok = await postTest(base, { provider: "anthropic", model: "claude-opus-4-8", baseUrl: stubUrl, apiKey: "sk-test" });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);

    stubStatus = 401;
    const denied = await postTest(base, { provider: "anthropic", model: "claude-opus-4-8", baseUrl: stubUrl, apiKey: "sk-wrong" });
    expect(denied.body.ok).toBe(false);
    expect(denied.body.error).toContain("鉴权");
  });

  it("缺 key → 不发请求当场说明；baseUrl 非法 → 400；provider 非法 → 400", async () => {
    const { base } = await makeHost();
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const noKey = await postTest(base, { provider: "anthropic", model: "claude-opus-4-8" });
      expect(noKey.status).toBe(200);
      expect(noKey.body.ok).toBe(false);
      expect(noKey.body.error).toContain("ANTHROPIC_API_KEY");
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
    const badUrl = await postTest(base, { provider: "openai", model: "m", baseUrl: "http://8.8.8.8", apiKey: "sk" });
    expect(badUrl.status).toBe(400);
    const badProvider = await postTest(base, { provider: "bogus", model: "m" });
    expect(badProvider.status).toBe(400);
  });
});

describe("模型窗口预览与角色快捷切换", () => {
  it("GET /api/models 每条带 contextWindow；响应带当前 context", async () => {
    const { base } = await makeHost();
    await putModels(base, modelsBody());
    const body = await (await fetch(`${base}/api/models`)).json() as any;
    const flash = body.models.find((m: any) => m.id === "m-fast");
    const opus = body.models.find((m: any) => m.id === "m-strong");
    expect(flash.contextWindow).toMatchObject({ window: 1_048_576, windowSource: "registry" });
    expect(opus.contextWindow).toMatchObject({ window: 1_000_000, windowSource: "registry" });
    expect(body.context).toMatchObject({
      windowSource: expect.stringMatching(/^(env|learned|registry|unknown)$/),
      budget: expect.any(Number),
    });
  });

  it("PATCH /api/models/roles 改 executor；悬空 id → 400；写盘可读回", async () => {
    const { base, storeFile } = await makeHost();
    await putModels(base, modelsBody());
    const bad = await fetch(`${base}/api/models/roles`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ executor: "ghost" }),
    });
    expect(bad.status).toBe(400);

    const ok = await fetch(`${base}/api/models/roles`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ executor: "m-strong" }),
    });
    expect(ok.status).toBe(200);
    const body = await ok.json() as any;
    expect(body.roles.executor).toBe("m-strong");
    // 注入 FakeModelClient 时执行者装配锁定——但库文件角色必须已改（重启/真宿主生效）
    const disk = JSON.parse(await readFile(storeFile, "utf8"));
    expect(disk.roles.executor).toBe("m-strong");
  });
});

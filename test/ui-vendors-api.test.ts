/**
 * /api/vendors + /api/pricing：厂家预设与价表刷新。
 * 注入 FakeModelClient + 临时库文件，不碰真实端点。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiServer, type UiServerHandle } from "../ui/server.js";
import { resetObservabilityMetrics } from "../src/metrics.js";
import { clearCapabilityCache } from "../src/model-capability.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock } from "./helpers.js";

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

async function makeHost(opts: {
  storeFile?: string;
  priceCacheFile?: string;
  priceFetch?: typeof fetch;
} = {}): Promise<{ base: string; storeFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), "vendors-api-"));
  tempDirs.push(dir);
  const storeFile = opts.storeFile ?? join(dir, ".agent-models.json");
  handle = createUiServer({
    modelClient: new FakeModelClient([fakeMessage([textBlock("ok")], "end_turn")]),
    tools: [makeTool({ name: "noop", permission: "auto", parallelSafe: true })],
    workdir: process.cwd(),
    modelStoreFile: storeFile,
    priceCacheFile: opts.priceCacheFile ?? join(dir, ".agent-price-cache.json"),
    ...(opts.priceFetch ? { priceFetch: opts.priceFetch } : {}),
  });
  return { base: await startServer(), storeFile };
}

describe("厂家预设与价表", () => {
  it("POST /api/vendors 一把 Key 写入 Kimi 预设，出栈不含密钥", async () => {
    const { base } = await makeHost();
    const listed = await (await fetch(`${base}/api/vendors`)).json() as { vendors: Array<{ id: string }> };
    expect(listed.vendors.map((v) => v.id)).toEqual(["deepseek", "kimi", "anthropic", "openai"]);

    const res = await fetch(`${base}/api/vendors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendorId: "kimi", apiKey: "sk-secret-kimi-never-echo" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.added).toBe(3);
    expect(body.models.some((m: { model: string }) => m.model === "kimi-k3")).toBe(true);
    expect(JSON.stringify(body)).not.toContain("sk-secret-kimi-never-echo");

    const again = await (await fetch(`${base}/api/models`)).text();
    expect(again).toContain("kimi-k3");
    expect(again).not.toContain("sk-secret-kimi-never-echo");

    const pricing = await (await fetch(`${base}/api/pricing`)).json() as { entries: Array<{ model: string }> };
    expect(pricing.entries.some((e) => e.model === "kimi-k3")).toBe(true);
  });

  it("刷新只写具名别名进缓存；覆盖表路径下 409", async () => {
    const dir = await mkdtemp(join(tmpdir(), "price-refresh-"));
    tempDirs.push(dir);
    const cache = join(dir, ".agent-price-cache.json");
    const priceFetch = (async () => ({
      ok: true,
      json: async () => ({
        "moonshot/kimi-k3": {
          input_cost_per_token: 0.000004,
          output_cost_per_token: 0.000016,
        },
      }),
    })) as unknown as typeof fetch;

    const { base } = await makeHost({ priceCacheFile: cache, priceFetch });
    const res = await fetch(`${base}/api/pricing/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { matched: string[]; missing: string[] };
    expect(body.matched).toContain("kimi-k3");
    const disk = await readFile(cache, "utf8");
    expect(disk).toContain("kimi-k3");
    expect(disk).not.toContain("deepseek-chat");
  });
});

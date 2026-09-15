/**
 * Office 预览端点：GET /api/office-preview 与 /api/runs/:id/office-preview。
 * 圈禁与 file-preview / artifact 同一把尺；加密 / 坏文件 422。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiServer, type UiServerHandle } from "../ui/server.js";
import { writePptxTool } from "../src/tools/write-pptx.js";
import { FakeModelClient, fakeMessage, textBlock } from "./helpers.js";

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

describe("GET /api/office-preview", () => {
  let dir: string;
  let handle: UiServerHandle | undefined;
  let base = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "office-preview-"));
  });

  afterEach(async () => {
    if (handle) await handle.close();
    handle = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function boot() {
    handle = createUiServer({
      modelClient: new FakeModelClient([fakeMessage([textBlock("done")], "end_turn")]),
      tools: [],
      workdir: dir,
    });
    const port = await startServer(handle);
    base = `http://127.0.0.1:${port}`;
  }

  it("pptx 拆成可翻页 JSON，含 mode=preview", async () => {
    await boot();
    const ctx = {
      workdir: dir,
      toolUseId: "tu",
      signal: new AbortController().signal,
    };
    await writePptxTool.execute(
      { path: "deck.pptx", slides: [{ title: "封面主张", body: "正文" }, { title: "收束" }] },
      ctx,
    );
    const res = await fetch(`${base}/api/office-preview?path=deck.pptx`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("pptx");
    expect(body.mode).toBe("preview");
    expect(body.pages).toHaveLength(2);
    expect(body.pages[0].texts.join(" ")).toContain("封面主张");
  });

  it("OLE 加密 → 422 ENCRYPTED", async () => {
    await boot();
    await writeFile(join(dir, "secret.pptx"), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]));
    const res = await fetch(`${base}/api/office-preview?path=secret.pptx`);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("ENCRYPTED");
    expect(body.error).toMatch(/加密/);
  });

  it("乱字节 → 422 BROKEN；xlsx 400；逃逸 403", async () => {
    await boot();
    await writeFile(join(dir, "bad.pptx"), "not-zip");
    const broken = await fetch(`${base}/api/office-preview?path=bad.pptx`);
    expect(broken.status).toBe(422);
    expect((await broken.json()).code).toBe("BROKEN");

    await writeFile(join(dir, "sheet.xlsx"), "x");
    const xlsx = await fetch(`${base}/api/office-preview?path=sheet.xlsx`);
    expect(xlsx.status).toBe(400);

    const escape = await fetch(`${base}/api/office-preview?path=${encodeURIComponent("../secret.pptx")}`);
    expect(escape.status).toBe(403);

    const other = await mkdtemp(join(tmpdir(), "office-preview-other-"));
    try {
      const foreign = await fetch(
        `${base}/api/office-preview?path=deck.pptx&workdir=${encodeURIComponent(other)}`,
      );
      expect(foreign.status).toBe(403);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("会话内 /api/runs/:id/office-preview 与 file 通道同拆页", async () => {
    await boot();
    const ctx = {
      workdir: dir,
      toolUseId: "tu",
      signal: new AbortController().signal,
    };
    await writePptxTool.execute({ path: "talk.pptx", slides: [{ title: "会话页" }] }, ctx);
    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "office", pack: "design" }),
    });
    const runId = (await created.json()).runId;
    const res = await fetch(`${base}/api/runs/${runId}/office-preview?path=talk.pptx`);
    expect(res.status).toBe(200);
    expect((await res.json()).pages[0].title).toContain("会话页");
  });
});

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isSideEffectTool, retryPolicyForTool } from "../src/tool-tx.js";
import { writePptxTool } from "../src/tools/write-pptx.js";

let workdir: string;
const ctx = () => ({
  workdir,
  toolUseId: "tu_pptx",
  signal: new AbortController().signal,
});

beforeAll(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "write-pptx-"));
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("write_pptx", () => {
  it("审批档与 write_file 同级：ask + once；写盘可幂等重试", () => {
    expect(writePptxTool.permission).toBe("ask");
    expect(writePptxTool.parallelSafe).toBe(false);
    expect(writePptxTool.approvalPolicy).toEqual({ maxScope: "once" });
    expect(isSideEffectTool(writePptxTool.name)).toBe(true);
    expect(retryPolicyForTool(writePptxTool.name)).toBe("idempotent_retry");
  });

  it("写出真实 pptx：文件存在且以 ZIP 魔数 PK 开头，回报相对路径与页数", async () => {
    const rel = "talks/deck.pptx";
    const out = await writePptxTool.execute(
      {
        path: rel,
        slides: [
          { title: "Hello", body: "World", notes: "say hi" },
          { title: "Second", extra: "ignored" },
        ],
      },
      ctx(),
    );
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain(rel);
    expect(out.content).toMatch(/2 slides/);
    const bytes = await readFile(path.join(workdir, rel));
    expect(bytes.length).toBeGreaterThan(4);
    expect(bytes.subarray(0, 2).toString("ascii")).toBe("PK");
  });

  it("拒绝圈外路径", async () => {
    await expect(
      writePptxTool.execute(
        { path: "../outside.pptx", slides: [{ title: "x" }] },
        ctx(),
      ),
    ).rejects.toThrow(/escapes/);
  });

  it("拒绝非 .pptx 扩展名，不落盘", async () => {
    const out = await writePptxTool.execute(
      { path: "deck.html", slides: [{ title: "x" }] },
      ctx(),
    );
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/\.pptx/);
    await expect(readFile(path.join(workdir, "deck.html"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("slides 为空或缺 title 当场拒绝", async () => {
    expect((await writePptxTool.execute({ path: "a.pptx", slides: [] }, ctx())).isError).toBe(true);
    expect(
      (await writePptxTool.execute({ path: "a.pptx", slides: [{ title: "  " }] }, ctx())).isError,
    ).toBe(true);
  });

  it("父目录自动创建", async () => {
    const rel = "nested/deep/out.pptx";
    await mkdir(path.join(workdir, "nested"), { recursive: true });
    const out = await writePptxTool.execute(
      { path: rel, slides: [{ title: "Nested" }] },
      ctx(),
    );
    expect(out.isError).toBeFalsy();
    expect(out.content).toMatch(/1 slide/);
    const bytes = await readFile(path.join(workdir, rel));
    expect(bytes.subarray(0, 2).toString("ascii")).toBe("PK");
  });
});

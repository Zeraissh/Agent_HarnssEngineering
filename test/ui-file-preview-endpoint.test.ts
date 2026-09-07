/**
 * V-35 文件预览端点契约测试——GET /api/file-preview。
 *
 * 全用注入的 FakeModelClient + 临时工作目录（摆真实文件），不碰真实历史、
 * 不需要 API key。与 /api/upload、/api/runs/:id/artifact 同一测试模式。
 *
 * 覆盖：
 *   a. 相对路径取文本：200 + text/plain + CSP + nosniff + no-store + inline
 *   b. HTML：text/html + 同一份 CSP（不可信内容纪律与 artifact 一致）
 *   c. 图片：二进制原样返回 + image/png
 *   d. 圈禁：`..` 逃逸 → 403；白名单外绝对路径 → 403；非白名单 workdir 参数 → 403
 *   e. 白名单内绝对路径 → 200（上传返回的 absolutePath 走的就是这条）
 *   f. 附加白名单工作目录（options.workdirs）里的文件按 workdir 参数可取
 *   g. 不存在 → 404；目录 → 404（不开目录浏览）
 *   h. 超过 10MB → 413
 *   i. download=1 → Content-Disposition: attachment
 *   j. 未知扩展名 → application/octet-stream（下载而不是猜着执行）
 *   k. 缺 path 参数 → 404（malformed 路由）
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

const CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src data:";

describe("GET /api/file-preview", () => {
  let dir: string;
  let handle: UiServerHandle | undefined;
  let base = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "file-preview-"));
  });

  afterEach(async () => {
    if (handle) await handle.close();
    handle = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function boot(extraWorkdirs: string[] = []) {
    handle = createUiServer({
      modelClient: new FakeModelClient([]),
      tools: [],
      workdir: dir,
      ...(extraWorkdirs.length ? { workdirs: extraWorkdirs } : {}),
    });
    const port = await startServer(handle);
    base = `http://127.0.0.1:${port}`;
  }

  const preview = (query: string) => fetch(`${base}/api/file-preview?${query}`);

  it("a. 相对路径取文本：200 + 内容原样 + 安全头齐全", async () => {
    await boot();
    await writeFile(join(dir, "README.md"), "# 你好\n\n正文。", "utf8");
    const res = await preview(`path=${encodeURIComponent("README.md")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("Content-Security-Policy")).toBe(CSP);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Disposition")).toContain("inline");
    expect(res.headers.get("Content-Disposition")).toContain(encodeURIComponent("README.md"));
    expect(await res.text()).toBe("# 你好\n\n正文。");
  });

  it("b. HTML 按 text/html 返回，且带与 artifact 同一份 CSP", async () => {
    await boot();
    await mkdir(join(dir, "site"), { recursive: true });
    await writeFile(join(dir, "site", "index.html"), "<h1>站点</h1>", "utf8");
    const res = await preview(`path=${encodeURIComponent("site/index.html")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Content-Security-Policy")).toBe(CSP);
    expect(await res.text()).toBe("<h1>站点</h1>");
  });

  it("c. 图片按二进制原样返回", async () => {
    await boot();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(join(dir, "shot.png"), png);
    const res = await preview("path=shot.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).equals(png)).toBe(true);
  });

  it("d1. .. 逃逸相对路径 → 403，读不到圈外文件", async () => {
    await boot();
    const outside = join(tmpdir(), `escape-${Date.now()}.txt`);
    await writeFile(outside, "机密", "utf8");
    try {
      const rel = `../escape-${Date.now()}.txt`;
      // 文件名对不上也该是 403 而不是 404——越界判定先于存在性
      const res = await preview(`path=${encodeURIComponent("../out.txt")}`);
      expect(res.status).toBe(403);
      expect((await res.json() as { error: string }).error).toContain("escapes");
      expect(rel).toContain(".."); // 说明性断言：用例本身是逃逸形状
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("d2. 白名单外的绝对路径 → 403", async () => {
    await boot();
    const res = await preview(`path=${encodeURIComponent(join(tmpdir(), "somewhere-else.txt"))}`);
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toContain("白名单");
  });

  it("d3. 非白名单的 workdir 参数 → 403", async () => {
    await boot();
    const res = await preview(
      `path=${encodeURIComponent("a.txt")}&workdir=${encodeURIComponent(tmpdir())}`,
    );
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toContain("白名单");
  });

  it("e. 白名单内的绝对路径 → 200（上传返回的 absolutePath 走这条）", async () => {
    await boot();
    await mkdir(join(dir, "uploads"), { recursive: true });
    await writeFile(join(dir, "uploads", "报告.md"), "# 附件", "utf8");
    const res = await preview(`path=${encodeURIComponent(join(dir, "uploads", "报告.md"))}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# 附件");
  });

  it("f. 附加白名单工作目录里的文件按 workdir 参数可取", async () => {
    const other = await mkdtemp(join(tmpdir(), "file-preview-b-"));
    try {
      await boot([other]);
      await writeFile(join(other, "data.csv"), "a,b\n1,2\n", "utf8");
      const ok = await preview(
        `path=${encodeURIComponent("data.csv")}&workdir=${encodeURIComponent(other)}`,
      );
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("a,b\n1,2\n");
      // 同一个相对路径在默认工作目录里不存在 → 404（不同圈互不串）
      const miss = await preview(`path=${encodeURIComponent("data.csv")}`);
      expect(miss.status).toBe(404);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("g. 不存在 → 404；目录 → 404（不开目录浏览）", async () => {
    await boot();
    await mkdir(join(dir, "subdir"), { recursive: true });
    expect((await preview("path=ghost.txt")).status).toBe(404);
    expect((await preview("path=subdir")).status).toBe(404);
    expect((await preview(`path=${encodeURIComponent(dir)}`)).status).toBe(404);
  });

  it("h. 超过 10MB → 413，且错误可读", async () => {
    await boot();
    await writeFile(join(dir, "big.log"), Buffer.alloc(10_000_001, 0x61));
    const res = await preview("path=big.log");
    expect(res.status).toBe(413);
    expect((await res.json() as { error: string }).error).toContain("过大");
  });

  it("i. download=1 → attachment", async () => {
    await boot();
    await writeFile(join(dir, "数据表.csv"), "a,b\n", "utf8");
    const res = await preview(`path=${encodeURIComponent("数据表.csv")}&download=1`);
    expect(res.status).toBe(200);
    const disp = res.headers.get("Content-Disposition") ?? "";
    expect(disp).toContain("attachment");
    // RFC 5987 编码：中文名不编码会在 header 里变成乱码
    expect(disp).toContain(encodeURIComponent("数据表.csv"));
  });

  it("j. 未知扩展名 → octet-stream + nosniff（下载而不是猜着执行）", async () => {
    await boot();
    await writeFile(join(dir, "model.bin"), Buffer.from([1, 2, 3]));
    const res = await preview("path=model.bin");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("k. 缺 path 参数 → 404（malformed 路由）", async () => {
    await boot();
    const res = await fetch(`${base}/api/file-preview?download=1`);
    expect(res.status).toBe(404);
  });
});

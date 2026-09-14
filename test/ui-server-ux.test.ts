/**
 * Work 脸普通发送 / Web 默认先问 —— HTTP 契约。
 * FakeModelClient，不碰真实端点。
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createUiServer, type UiServerHandle } from "../ui/server.js";
import { toBrowserApiError } from "../ui/api-errors.js";
import { writeFileTool } from "../src/tools/write-file.js";
import { WEB_DEFAULT_AUTO_APPROVE, WEB_DEFAULT_PERMISSION_MODE } from "../src/permission-mode.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock, toolUseBlock } from "./helpers.js";

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

async function waitForRow(
  base: string,
  runId: string,
  pred: (row: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const list = (await (await fetch(`${base}/api/runs`)).json()) as Record<string, unknown>[];
    const row = list.find((r) => r.runId === runId);
    if (row && pred(row)) return row;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Run ${runId} did not match`);
}

describe("Work 普通发送与 Web 默认先问", () => {
  let handle: UiServerHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("Work / 无模板 / 写文件任务 → 2xx 并创建 run（不因路由空包 409）", async () => {
    handle = createUiServer({
      modelClient: new FakeModelClient([
        fakeMessage([textBlock("已写好 hello-verify-ux.txt")], "end_turn"),
      ]),
      tools: [makeTool({ name: "noop", permission: "auto", parallelSafe: true })],
      workdir: process.cwd(),
    });
    const base = `http://127.0.0.1:${await startServer(handle)}`;
    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "帮我写一个文件 hello-verify-ux.txt，内容写 ping",
        mode: "design",
        workspace: "office",
        designTab: "Prototype",
      }),
    });
    expect(created.status).toBeGreaterThanOrEqual(200);
    expect(created.status).toBeLessThan(300);
    const body = await created.json() as { runId?: string; error?: string };
    expect(body.runId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.stringify(body)).not.toMatch(/HTTP|领域包|Prototype/);
    const row = await waitForRow(base, body.runId!, (r) => typeof r.status === "string");
    expect(row.task).toContain("hello-verify-ux.txt");
    expect(row.designRoute).toBeUndefined();
  });

  it("若仍 4xx，正文不含 HTTP 和 领域包", async () => {
    handle = createUiServer({
      modelClient: new FakeModelClient([]),
      tools: [],
      workdir: process.cwd(),
    });
    const base = `http://127.0.0.1:${await startServer(handle)}`;
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "帮我写一个文件 hello-verify-ux.txt，内容写 ping",
        pack: "不存在的包",
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const text = await res.text();
    expect(text).not.toMatch(/HTTP|领域包/);
    const payload = JSON.parse(text) as { error: string };
    expect(payload.error.length).toBeGreaterThan(0);
    expect(payload.error).not.toMatch(/HTTP|领域包|Prototype/);
  });

  it("点了无效模板芯片才 4xx，人话且不报内部词", async () => {
    handle = createUiServer({
      modelClient: new FakeModelClient([
        fakeMessage(
          [textBlock(JSON.stringify({
            pack: null,
            reason: "通用文件写入任务，不涉及任何领域包的专用工具或产出格式，直接执行即可。",
          }))],
          "end_turn",
        ),
      ]),
      tools: [],
      workdir: process.cwd(),
    });
    const base = `http://127.0.0.1:${await startServer(handle)}`;
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "帮我写一个文件 hello-verify-ux.txt，内容写 ping",
        mode: "design",
        designId: "not-a-real-template",
      }),
    });
    expect(res.status).toBe(400);
    const payload = await res.json() as { error: string };
    expect(payload.error).toMatch(/模板|描述要做什么/);
    expect(payload.error).not.toMatch(/HTTP|领域包|Prototype/);
  });

  it("Web 新建 run 默认先问；harness.defaults.autoApprove=false（变异：改回 true 要红）", async () => {
    expect(WEB_DEFAULT_AUTO_APPROVE).toBe(false);
    expect(WEB_DEFAULT_PERMISSION_MODE).toBe("manual");
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "permission-mode.ts"), "utf8");
    expect(src).toMatch(/export const WEB_DEFAULT_AUTO_APPROVE = false/);
    expect(src).not.toMatch(/export const WEB_DEFAULT_AUTO_APPROVE = true/);

    handle = createUiServer({
      modelClient: new FakeModelClient([
        fakeMessage([toolUseBlock("w1", "write_file", {
          path: "hello-default-ask.txt",
          content: "ping\n",
        })], "tool_use"),
        fakeMessage([textBlock("written")], "end_turn"),
      ]),
      tools: [writeFileTool],
      workdir: process.cwd(),
    });
    const base = `http://127.0.0.1:${await startServer(handle)}`;
    const snap = await (await fetch(`${base}/api/harness`)).json() as {
      defaults: { autoApprove: boolean; permissionMode: string };
    };
    expect(snap.defaults.autoApprove).toBe(false);
    expect(snap.defaults.permissionMode).toBe("manual");

    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "写一个文件 hello-default-ask.txt" }),
    });
    expect(created.status).toBe(200);
    const { runId } = await created.json() as { runId: string };
    const row = await waitForRow(base, runId, (r) => Number(r.pendingApprovals) > 0);
    expect(row.autoApprove).toBe(false);
    expect(row.pendingApprovals).toBeGreaterThan(0);
  });
});

describe("toBrowserApiError", () => {
  it("剥掉 HTTP 状态码、领域包、Prototype", () => {
    expect(toBrowserApiError("提交失败（HTTP 409）：不涉及任何领域包，已指定页签 Prototype"))
      .not.toMatch(/HTTP|领域包|Prototype/);
    expect(toBrowserApiError("HTTP 429 Mutation rate limit exceeded")).not.toMatch(/HTTP/);
    expect(toBrowserApiError("Mutation rate limit exceeded")).toBe("前面还有人在交，请等几秒。");
    expect(toBrowserApiError("")).toMatch(/没发出去/);
  });
});

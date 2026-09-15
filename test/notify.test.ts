/**
 * 办公出站门禁卡片：纯函数 + notifier + 工具回调 + Web 宿主仪器纪律。
 * 不启动长寿命 UI；每条用例 listen(0) 后 close。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory.js";
import { createProjectStatusTool } from "../src/project-status.js";
import { createServer } from "node:http";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
  FEISHU_ENCRYPT_KEY_ENV,
  FEISHU_VERIFICATION_TOKEN_ENV,
  FEISHU_WEBHOOK_ENV,
  IM_FEISHU_PATH,
  IM_STATUS_PATH,
  IM_WECOM_PATH,
  NOTIFY_WEBHOOK_ENV,
  WECOM_WEBHOOK_ENV,
  attachImInbound,
  createOfficeNotifier,
  feishuSignatureHex,
  formatFeishuGateCard,
  formatGateCardText,
  formatImHostHint,
  formatImRunResultText,
  gateNotifyPayloadFromBoard,
  notifyArmedHint,
  officeNotifySnapshot,
  parseFeishuInboundEvent,
  resolveFeishuInboundFromEnv,
  resolveImHostStatus,
  resolveOfficeNotifyFromEnv,
  sanitizeNotifyUrlForLog,
  verifyFeishuSignature,
} from "../src/notify.js";
import { createUiServer, type UiServerHandle } from "../ui/server.js";
import { FakeModelClient, fakeMessage, textBlock, toolUseBlock } from "./helpers.js";

const LEAK = "https://open.feishu.cn/open-apis/bot/v2/hook/NOTIFY-LEAK-TOKEN-9f3";
const WECOM_LEAK = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=WECOM-LEAK-TOKEN-9f3";
const ENCRYPT_KEY = "feishu-encrypt-key-for-tests";

function signFeishu(timestamp: string, nonce: string, body: string, key = ENCRYPT_KEY): string {
  return feishuSignatureHex(timestamp, nonce, key, body);
}

function encryptFeishuBody(plain: string, key = ENCRYPT_KEY): string {
  const keyBuf = createHash("sha256").update(key).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", keyBuf, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, enc]).toString("base64");
}

function startImServer(opts: Parameters<typeof attachImInbound>[1]): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end("no");
  });
  attachImInbound(server, opts);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({
          port: addr.port,
          close: () => new Promise((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
        });
      } else reject(new Error("Could not get server port"));
    });
    server.on("error", reject);
  });
}

function cardText(payload: Parameters<typeof formatGateCardText>[0]): string {
  return formatFeishuGateCard(payload).content.text;
}

function startServer(handle: UiServerHandle): Promise<number> {
  return new Promise((resolve, reject) => {
    handle.server.listen(0, "127.0.0.1", () => {
      const addr = handle.server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("Could not get server port"));
    });
    handle.server.on("error", reject);
  });
}

async function waitForDone(base: string, runId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/runs`);
    const list: { runId: string; status: string }[] = await res.json();
    const entry = list.find((r) => r.runId === runId);
    if (entry?.status === "done") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Run ${runId} did not finish in time`);
}

function boardWriteModel() {
  return new FakeModelClient([
    fakeMessage(
      [
        toolUseBlock("tu_ps", "project_status", {
          summary: "规格待签字",
          waiting: ["委托方：规格签字"],
          nextGate: "规格确认门",
          decisions: ["要不要做三页幻灯"],
        }),
      ],
      "tool_use",
    ),
    fakeMessage([textBlock("看板已更新")], "end_turn"),
  ]);
}

describe("formatFeishuGateCard", () => {
  const payload = {
    project: "alpha",
    summary: "规格待签字",
    nextGate: "规格确认门",
    waiting: ["委托方：规格签字"],
    decisions: ["要不要做三页幻灯"],
  };

  it("正文含项目 / 下一门 / 谁在等", () => {
    const text = cardText(payload);
    expect(text).toContain("项目：alpha");
    expect(text).toContain("摘要：规格待签字");
    expect(text).toContain("下一门：规格确认门");
    expect(text).toContain("谁在等：委托方：规格签字");
    expect(text).toContain("打开本机宿主查看该 run");
  });

  it("waiting 为空时印「无」", () => {
    const text = cardText({ ...payload, waiting: [] });
    expect(text).toMatch(/谁在等：无(?:\n|$)/);
    expect(text).not.toMatch(/谁在等：\s*\n/);
  });

  it("变异锁：去掉下一门，测试必须红", () => {
    const formatted = formatFeishuGateCard(payload);
    const dumped = JSON.stringify(formatted);
    expect(dumped).toContain("下一门");
    expect(dumped).toContain("规格确认门");
    expect(formatGateCardText(payload)).toMatch(/下一门：规格确认门/);
  });
});

describe("sanitizeNotifyUrlForLog / hint / env", () => {
  it("剥 query 与末段 token", () => {
    expect(sanitizeNotifyUrlForLog(`${LEAK}?sign=abc#frag`)).toBe(
      "https://open.feishu.cn/open-apis/bot/v2/hook/***",
    );
    expect(sanitizeNotifyUrlForLog("not a url")).toBe("(invalid-notify-url)");
  });

  it("armed 提示不含地址", () => {
    expect(notifyArmedHint(true)).toBe("飞书门禁通知已开");
    expect(notifyArmedHint(false)).toBeUndefined();
    expect(notifyArmedHint(true)).not.toContain("http");
  });

  it("飞书 env 优先于企微与通用 webhook", () => {
    expect(
      resolveOfficeNotifyFromEnv({
        [FEISHU_WEBHOOK_ENV]: LEAK,
        [WECOM_WEBHOOK_ENV]: WECOM_LEAK,
        [NOTIFY_WEBHOOK_ENV]: "https://example.test/generic",
      }),
    ).toEqual({ kind: "feishu", webhookUrl: LEAK });
    expect(resolveOfficeNotifyFromEnv({ [WECOM_WEBHOOK_ENV]: WECOM_LEAK })).toEqual({
      kind: "wecom",
      webhookUrl: WECOM_LEAK,
    });
    expect(resolveOfficeNotifyFromEnv({ [NOTIFY_WEBHOOK_ENV]: "https://example.test/generic" })).toEqual({
      kind: "webhook",
      webhookUrl: "https://example.test/generic",
    });
    expect(resolveOfficeNotifyFromEnv({})).toBeNull();
  });

  it("无 ENCRYPT_KEY 不启入站；hint 不含密钥", () => {
    expect(resolveFeishuInboundFromEnv({})).toBeNull();
    expect(resolveFeishuInboundFromEnv({ [FEISHU_VERIFICATION_TOKEN_ENV]: "tok" })).toBeNull();
    const armed = resolveFeishuInboundFromEnv({ [FEISHU_ENCRYPT_KEY_ENV]: ENCRYPT_KEY });
    expect(armed?.encryptKey).toBe(ENCRYPT_KEY);
    const hint = formatImHostHint(resolveImHostStatus({}));
    expect(hint).toBe("飞书/微信宿主未开");
    expect(hint).not.toContain("ENCRYPT");
    expect(formatImHostHint(resolveImHostStatus({
      [FEISHU_WEBHOOK_ENV]: LEAK,
      [FEISHU_ENCRYPT_KEY_ENV]: ENCRYPT_KEY,
    }))).toContain("入站收消息");
    expect(JSON.stringify(resolveImHostStatus({ [FEISHU_ENCRYPT_KEY_ENV]: ENCRYPT_KEY })))
      .not.toContain(ENCRYPT_KEY);
  });

  it("快照只有 kind/armed", () => {
    const n = createOfficeNotifier({ kind: "feishu", webhookUrl: LEAK });
    expect(officeNotifySnapshot(n)).toEqual({ kind: "feishu", armed: true });
    expect(JSON.stringify(officeNotifySnapshot(n))).not.toContain("NOTIFY-LEAK");
  });
});

describe("createOfficeNotifier", () => {
  it("armed 时 POST webhook，body 是卡片 JSON", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const notifier = createOfficeNotifier({
      kind: "feishu",
      webhookUrl: LEAK,
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body ?? "") });
        return new Response("ok", { status: 200 });
      },
    });
    expect(notifier.armed).toBe(true);
    await notifier.notify({
      project: "alpha",
      summary: "规格待签字",
      nextGate: "规格确认门",
      waiting: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(LEAK);
    const body = JSON.parse(calls[0]!.body) as { msg_type: string; content: { text: string } };
    expect(body.msg_type).toBe("text");
    expect(body.content.text).toContain("规格确认门");
    expect(body.content.text).toMatch(/谁在等：无/);
  });

  it("disabled 或空 URL → 零 fetch", async () => {
    const calls: unknown[] = [];
    const fetchFn = async () => {
      calls.push(1);
      return new Response("ok", { status: 200 });
    };
    await createOfficeNotifier({ webhookUrl: LEAK, enabled: false, fetchFn }).notify({
      project: "p",
      summary: "s",
      nextGate: "g",
      waiting: [],
    });
    await createOfficeNotifier({ webhookUrl: "", fetchFn }).notify({
      project: "p",
      summary: "s",
      nextGate: "g",
      waiting: [],
    });
    await createOfficeNotifier({ fetchFn }).notify({
      project: "p",
      summary: "s",
      nextGate: "g",
      waiting: [],
    });
    expect(calls).toHaveLength(0);
  });

  it("wecom 出站用 msgtype/text.content，不含飞书 msg_type", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const notifier = createOfficeNotifier({
      kind: "wecom",
      webhookUrl: WECOM_LEAK,
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body ?? "") });
        return new Response("ok", { status: 200 });
      },
    });
    await notifier.notify({
      project: "alpha",
      summary: "规格待签字",
      nextGate: "规格确认门",
      waiting: [],
    });
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.body) as { msgtype: string; text: { content: string } };
    expect(body.msgtype).toBe("text");
    expect(body.text.content).toContain("规格确认门");
    expect(calls[0]!.body).not.toContain("msg_type");
    expect(JSON.stringify(officeNotifySnapshot(notifier))).not.toContain("WECOM-LEAK");
  });
});

describe("飞书入站签名与开 run", () => {
  it("签名失败拒；无密钥不启；成功路径注入 startRun", async () => {
    const started: Array<{ task: string; source: string }> = [];
    const env = { [FEISHU_ENCRYPT_KEY_ENV]: ENCRYPT_KEY };
    const now = 1_700_000_000_000;
    const { port, close } = await startImServer({
      env,
      nowMs: () => now,
      startRun: async (input) => {
        started.push(input);
        return { runId: "run_injected" };
      },
    });
    const base = `http://127.0.0.1:${port}`;
    try {
      const noKey = await startImServer({ env: {}, startRun: async () => ({ runId: "nope" }) });
      try {
        const disabled = await fetch(`http://127.0.0.1:${noKey.port}${IM_FEISHU_PATH}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        expect(disabled.status).toBe(503);
        expect(await disabled.json()).toMatchObject({ error: "飞书入站未开", enabled: false });
      } finally {
        await noKey.close();
      }

      const event = {
        schema: "2.0",
        header: { event_type: "im.message.receive_v1", event_id: "evt_1" },
        event: {
          sender: { sender_type: "user" },
          message: {
            message_id: "om_1",
            message_type: "text",
            content: JSON.stringify({ text: "写一份周报" }),
          },
        },
      };
      const body = JSON.stringify(event);
      const ts = String(Math.floor(now / 1000));
      const nonce = "n1";

      const bad = await fetch(`${base}${IM_FEISHU_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Lark-Request-Timestamp": ts,
          "X-Lark-Request-Nonce": nonce,
          "X-Lark-Signature": "deadbeef",
        },
        body,
      });
      expect(bad.status).toBe(401);
      expect(await bad.json()).toMatchObject({ error: "签名无效" });
      expect(started).toHaveLength(0);

      const good = await fetch(`${base}${IM_FEISHU_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Lark-Request-Timestamp": ts,
          "X-Lark-Request-Nonce": nonce,
          "X-Lark-Signature": signFeishu(ts, nonce, body),
        },
        body,
      });
      expect(good.status).toBe(200);
      expect(await good.json()).toEqual({ ok: true, runId: "run_injected" });
      expect(started).toEqual([{ task: "写一份周报", source: "feishu", messageId: "om_1" }]);

      const status = await fetch(`${base}${IM_STATUS_PATH}`);
      const snap = await status.json() as Record<string, unknown>;
      expect(snap.feishuInbound).toBe(true);
      expect(snap.wechatPersonalInbound).toBe(false);
      expect(JSON.stringify(snap)).not.toContain(ENCRYPT_KEY);

      const wecom = await fetch(`${base}${IM_WECOM_PATH}`, { method: "POST", body: "{}" });
      expect(wecom.status).toBe(501);
      expect((await wecom.json() as { error: string }).error).toContain("不伪造");
    } finally {
      await close();
    }
  });

  it("url_verification 回 challenge；结果回写出站", async () => {
    const replies: string[] = [];
    const now = 1_700_000_000_000;
    const env = { [FEISHU_ENCRYPT_KEY_ENV]: ENCRYPT_KEY };
    const notifier = createOfficeNotifier({
      kind: "feishu",
      webhookUrl: LEAK,
      fetchFn: async (_url, init) => {
        replies.push(String(init?.body ?? ""));
        return new Response("ok", { status: 200 });
      },
    });
    const { port, close } = await startImServer({
      env,
      nowMs: () => now,
      notifier,
      startRun: async () => ({ runId: "run_done" }),
      waitForRun: async (runId) => ({
        task: "写一份周报",
        runId,
        status: "done",
        stopReason: "completed",
        summary: "周报已写好",
      }),
    });
    const base = `http://127.0.0.1:${port}`;
    try {
      const challengeBody = JSON.stringify({
        type: "url_verification",
        challenge: "ping-challenge",
        token: "unused",
      });
      const ts = String(Math.floor(now / 1000));
      const nonce = "n2";
      const challenge = await fetch(`${base}${IM_FEISHU_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Lark-Request-Timestamp": ts,
          "X-Lark-Request-Nonce": nonce,
          "X-Lark-Signature": signFeishu(ts, nonce, challengeBody),
        },
        body: challengeBody,
      });
      expect(challenge.status).toBe(200);
      expect(await challenge.json()).toEqual({ challenge: "ping-challenge" });

      const encryptedPlain = JSON.stringify({ type: "url_verification", challenge: "enc-challenge" });
      const encryptedBody = JSON.stringify({ encrypt: encryptFeishuBody(encryptedPlain) });
      const enc = await fetch(`${base}${IM_FEISHU_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Lark-Request-Timestamp": ts,
          "X-Lark-Request-Nonce": nonce,
          "X-Lark-Signature": signFeishu(ts, nonce, encryptedBody),
        },
        body: encryptedBody,
      });
      expect(enc.status).toBe(200);
      expect(await enc.json()).toEqual({ challenge: "enc-challenge" });

      const event = {
        schema: "2.0",
        header: { event_type: "im.message.receive_v1" },
        event: {
          message: { message_id: "om_2", message_type: "text", content: "{\"text\":\"任务\"}" },
        },
      };
      const body = JSON.stringify(event);
      const run = await fetch(`${base}${IM_FEISHU_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Lark-Request-Timestamp": ts,
          "X-Lark-Request-Nonce": nonce,
          "X-Lark-Signature": signFeishu(ts, nonce, body),
        },
        body,
      });
      expect(run.status).toBe(200);
      expect(await run.json()).toEqual({ ok: true, runId: "run_done" });
      const deadline = Date.now() + 1000;
      while (replies.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("周报已写好");
      expect(replies[0]).toContain("run_done");
      expect(replies[0]).not.toContain("NOTIFY-LEAK");
    } finally {
      await close();
    }
  });

  it("纯函数：坏签名 / 空密钥 / 解析消息", () => {
    expect(verifyFeishuSignature({
      timestamp: "1",
      nonce: "n",
      body: "{}",
      encryptKey: "",
      signature: "abc",
    })).toBe(false);
    expect(verifyFeishuSignature({
      timestamp: "1",
      nonce: "n",
      body: "{}",
      encryptKey: ENCRYPT_KEY,
      signature: "nope",
    })).toBe(false);
    const body = "{\"x\":1}";
    const good = signFeishu("1", "n", body);
    expect(verifyFeishuSignature({
      timestamp: "1",
      nonce: "n",
      body,
      encryptKey: ENCRYPT_KEY,
      signature: good,
    })).toBe(true);

    expect(parseFeishuInboundEvent({
      type: "url_verification",
      challenge: "c1",
    })).toEqual({ kind: "challenge", challenge: "c1" });
    expect(parseFeishuInboundEvent({
      event: {
        sender: { sender_type: "app" },
        message: { message_type: "text", content: "{\"text\":\"hi\"}" },
      },
    }).kind).toBe("ignored");
    expect(parseFeishuInboundEvent({
      header: { event_type: "im.message.receive_v1" },
      event: { message: { message_id: "om", message_type: "text", content: "{\"text\":\"@_user_1 开工\"}" } },
    })).toEqual({ kind: "message", task: "开工", messageId: "om" });
    expect(formatImRunResultText({
      task: "t",
      runId: "r",
      status: "done",
      stopReason: "completed",
      summary: "ok",
    })).toContain("打开本 run：r");
    expect(encryptFeishuBody("{\"type\":\"url_verification\",\"challenge\":\"x\"}").length).toBeGreaterThan(16);
  });
});

describe("project_status onBoardChange", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("写/清都回调；校验失败与回调抛错都不让工具失败", async () => {
    dir = await mkdtemp(join(tmpdir(), "notify-board-"));
    const workdir = join(dir, "alpha");
    const store = new MemoryStore(join(workdir, ".agent-memory"));
    const seen: Array<{ status: unknown; project: string }> = [];
    const tool = createProjectStatusTool(() => store, {
      onBoardChange: (status, project) => {
        seen.push({ status, project });
        throw new Error("notify boom");
      },
    });
    const ctx = { workdir, toolUseId: "t1", signal: new AbortController().signal };

    const bad = await tool.execute({ waiting: ["x"] }, ctx);
    expect(bad.isError).toBe(true);
    expect(seen).toHaveLength(0);

    const saved = await tool.execute(
      { summary: "规格待签字", nextGate: "规格确认门", waiting: ["委托方"] },
      ctx,
    );
    expect(saved.isError).toBeFalsy();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      project: "alpha",
      status: { summary: "规格待签字", nextGate: "规格确认门", project: "alpha" },
    });

    const cleared = await tool.execute({ clear: true }, ctx);
    expect(cleared.isError).toBeFalsy();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ status: null, project: "alpha" });
    expect(gateNotifyPayloadFromBoard(null, "alpha").summary).toBe("看板已清除");
  });
});

describe("Web 宿主出站通知", () => {
  const envKeys = [FEISHU_WEBHOOK_ENV, NOTIFY_WEBHOOK_ENV, "AGENT_MEMORY_DIR"] as const;
  const saved: Record<string, string | undefined> = {};
  let handle: UiServerHandle | undefined;
  let dir = "";
  let priorFetch: typeof fetch | undefined;

  afterEach(async () => {
    if (priorFetch) {
      globalThis.fetch = priorFetch;
      priorFetch = undefined;
    }
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
      delete saved[key];
    }
    await handle?.close();
    handle = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  function stashEnv(): void {
    for (const key of envKeys) saved[key] = process.env[key];
    delete process.env.AGENT_MEMORY_DIR;
  }

  it("注入模型的宿主忽略残留 AGENT_FEISHU_WEBHOOK（仪器锁）", async () => {
    stashEnv();
    process.env[FEISHU_WEBHOOK_ENV] = LEAK;
    const fetchCalls: unknown[] = [];
    priorFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("NOTIFY-LEAK") || String(url).includes("open.feishu.cn")) {
        fetchCalls.push({ url: String(url), body: String(init?.body ?? "") });
        return new Response("ok", { status: 200 });
      }
      return priorFetch!(url as Parameters<typeof fetch>[0], init);
    }) as typeof fetch;

    dir = await mkdtemp(join(tmpdir(), "notify-ignore-"));
    handle = createUiServer({
      modelClient: boardWriteModel(),
      tools: [],
      workdir: dir,
    });
    const base = `http://127.0.0.1:${await startServer(handle)}`;
    const snap = (await (await fetch(`${base}/api/harness`)).json()) as {
      notify?: { kind: string; armed: boolean };
    };
    expect(snap.notify).toEqual({ kind: "feishu", armed: false });
    const asText = JSON.stringify(snap);
    expect(asText).not.toContain("NOTIFY-LEAK");
    expect(asText).not.toContain(LEAK);
    expect(asText).not.toMatch(/open\.feishu\.cn/);

    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "写看板" }),
    });
    expect(created.status).toBe(200);
    const { runId } = (await created.json()) as { runId: string };
    await waitForDone(base, runId);
    expect(existsSync(join(dir, ".agent-memory", "in-progress.md"))).toBe(true);
    expect(fetchCalls).toHaveLength(0);
  });

  it("options.notify：project_status 执行后 fetch 接到卡片，快照 armed 且无 URL", async () => {
    stashEnv();
    process.env[FEISHU_WEBHOOK_ENV] = "https://example.test/should-not-use";
    const calls: Array<{ url: string; body: string }> = [];
    dir = await mkdtemp(join(tmpdir(), "notify-armed-"));
    handle = createUiServer({
      modelClient: boardWriteModel(),
      tools: [],
      workdir: dir,
      notify: {
        kind: "feishu",
        webhookUrl: LEAK,
        fetchFn: async (url, init) => {
          calls.push({ url: String(url), body: String(init?.body ?? "") });
          return new Response("ok", { status: 200 });
        },
      },
    });
    const base = `http://127.0.0.1:${await startServer(handle)}`;
    const snap = (await (await fetch(`${base}/api/harness`)).json()) as Record<string, unknown>;
    expect(snap.notify).toEqual({ kind: "feishu", armed: true });
    expect(JSON.stringify(snap)).not.toContain("NOTIFY-LEAK");
    expect(JSON.stringify(snap)).not.toContain(LEAK);
    expect(JSON.stringify(snap)).not.toContain("should-not-use");

    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "写看板" }),
    });
    expect(created.status).toBe(200);
    const { runId } = (await created.json()) as { runId: string };
    await waitForDone(base, runId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(LEAK);
    const body = JSON.parse(calls[0]!.body) as { content: { text: string } };
    expect(body.content.text).toContain("规格确认门");
    expect(body.content.text).toContain("规格待签字");
    expect(body.content.text).toContain("委托方：规格签字");
    const written = await readFile(join(dir, ".agent-memory", "in-progress.md"), "utf8");
    expect(written).toContain("规格确认门");
  });
});

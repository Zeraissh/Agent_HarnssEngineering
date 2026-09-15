/**
 * 办公 IM 宿主：出站门禁卡片 + 飞书入站开 run。
 *
 * 出站：看板（project_status）变更，或入站开的 run 收尾，POST 飞书自定义机器人 /
 * 企业微信群机器人 / 通用 JSON webhook。
 *
 * 入站（仅飞书事件订阅）：校验 X-Lark-Signature，把文本消息变成一次 run，
 * 结果走同一条出站 webhook。无 ENCRYPT_KEY 不启入站，启动行写「未开」。
 *
 * 企业微信：本仓只做群机器人出站。个微 / 公众号入站需要调用方自己的 App
 * 凭证与公网回调，这里不伪造、不假装能收私聊。
 *
 * Token / webhook / encrypt key 只活在服务端；sanitize 之后的地址才允许进日志。
 */
import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { ProjectStatus } from "./project-status.js";

export const FEISHU_WEBHOOK_ENV = "AGENT_FEISHU_WEBHOOK";
export const NOTIFY_WEBHOOK_ENV = "AGENT_NOTIFY_WEBHOOK";
export const WECOM_WEBHOOK_ENV = "AGENT_WECOM_WEBHOOK";
export const FEISHU_ENCRYPT_KEY_ENV = "AGENT_FEISHU_ENCRYPT_KEY";
export const FEISHU_VERIFICATION_TOKEN_ENV = "AGENT_FEISHU_VERIFICATION_TOKEN";

export const IM_STATUS_PATH = "/api/im";
export const IM_FEISHU_PATH = "/api/im/feishu";
export const IM_WECOM_PATH = "/api/im/wecom";

export const FEISHU_TIMESTAMP_MAX_SKEW_MS = 60 * 60 * 1000;
const IM_BODY_MAX_BYTES = 256 * 1024;
const SEEN_EVENT_CAP = 200;

export type OfficeNotifyKind = "feishu" | "wecom" | "webhook";

export type GateNotifyPayload = {
  project: string;
  summary: string;
  nextGate: string;
  waiting: string[];
  decisions?: string[];
  runId?: string | null;
  title?: string | null;
};

export type ImRunResultPayload = {
  task: string;
  runId: string;
  status: string;
  stopReason?: string | null;
  summary?: string;
};

export type OfficeNotifyConfig = {
  kind?: OfficeNotifyKind;
  webhookUrl?: string;
  fetchFn?: typeof fetch;
  enabled?: boolean;
};

export type OfficeNotifier = {
  kind: OfficeNotifyKind;
  armed: boolean;
  notify(payload: GateNotifyPayload): Promise<void>;
  notifyText(text: string): Promise<void>;
};

export type OfficeNotifySnapshot = {
  kind: OfficeNotifyKind;
  armed: boolean;
};

/** 飞书自定义机器人接受的 text 体。v1 不绑 interactive card schema。 */
export type FeishuTextBody = {
  msg_type: "text";
  content: { text: string };
};

/** 企业微信群机器人 text 体。不是个微 / 公众号。 */
export type WecomTextBody = {
  msgtype: "text";
  text: { content: string };
};

export type ImHostStatus = {
  feishuOutbound: boolean;
  feishuInbound: boolean;
  wecomOutbound: boolean;
  genericOutbound: boolean;
};

export type ImStartRunRequest = {
  task: string;
  source: "feishu";
  messageId?: string;
};

export type ImStartRunFn = (input: ImStartRunRequest) => Promise<{ runId: string }>;
export type ImWaitRunFn = (runId: string) => Promise<ImRunResultPayload>;

export type ImInboundAttachOptions = {
  env?: NodeJS.ProcessEnv;
  startRun?: ImStartRunFn;
  waitForRun?: ImWaitRunFn;
  notifier?: OfficeNotifier;
  nowMs?: () => number;
  seen?: Set<string>;
};

export type FeishuInboundParse =
  | { kind: "challenge"; challenge: string }
  | { kind: "message"; task: string; messageId?: string }
  | { kind: "ignored"; reason: string };

export function resolveOfficeNotifyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OfficeNotifyConfig | null {
  const feishu = env[FEISHU_WEBHOOK_ENV]?.trim() ?? "";
  const wecom = env[WECOM_WEBHOOK_ENV]?.trim() ?? "";
  const generic = env[NOTIFY_WEBHOOK_ENV]?.trim() ?? "";
  if (feishu) return { kind: "feishu", webhookUrl: feishu };
  if (wecom) return { kind: "wecom", webhookUrl: wecom };
  if (generic) return { kind: "webhook", webhookUrl: generic };
  return null;
}

export function resolveFeishuInboundFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { encryptKey: string; verificationToken: string } | null {
  const encryptKey = env[FEISHU_ENCRYPT_KEY_ENV]?.trim() ?? "";
  if (!encryptKey) return null;
  return {
    encryptKey,
    verificationToken: env[FEISHU_VERIFICATION_TOKEN_ENV]?.trim() ?? "",
  };
}

export function resolveImHostStatus(env: NodeJS.ProcessEnv = process.env): ImHostStatus {
  const feishu = Boolean(env[FEISHU_WEBHOOK_ENV]?.trim());
  const wecom = Boolean(env[WECOM_WEBHOOK_ENV]?.trim());
  const generic = Boolean(env[NOTIFY_WEBHOOK_ENV]?.trim());
  return {
    feishuOutbound: feishu,
    feishuInbound: Boolean(resolveFeishuInboundFromEnv(env)),
    wecomOutbound: wecom,
    genericOutbound: generic && !feishu && !wecom,
  };
}

/**
 * 启动行 / CLI 横幅。boolean 旧口径保留：armed →「飞书门禁通知已开」，未开 → undefined。
 * 传入 ImHostStatus 时无配置也诚实写「未开」，且永不带 URL / token。
 */
export function notifyArmedHint(armed: boolean | ImHostStatus): string | undefined {
  if (typeof armed === "boolean") {
    return armed ? "飞书门禁通知已开" : undefined;
  }
  return formatImHostHint(armed);
}

export function formatImHostHint(status: ImHostStatus): string {
  const bits: string[] = [];
  if (status.feishuInbound && (status.feishuOutbound || status.genericOutbound)) {
    bits.push("飞书宿主已开（入站收消息 + 出站回结果）");
  } else if (status.feishuInbound) {
    bits.push("飞书入站已开（出站未配，结果只在本机 UI）");
  } else if (status.feishuOutbound) {
    bits.push("飞书门禁通知已开");
    bits.push("飞书入站未开");
  }
  if (status.wecomOutbound && !status.feishuOutbound) {
    bits.push("企业微信群机器人出站已开");
  } else if (status.wecomOutbound && status.feishuOutbound) {
    bits.push("企业微信群机器人出站已开");
  }
  if (status.genericOutbound && !status.feishuOutbound && !status.wecomOutbound) {
    bits.push("通用 webhook 门禁通知已开");
  }
  if (bits.length === 0) return "飞书/微信宿主未开";
  return bits.join("；");
}

export function imHostStatusSnapshot(status: ImHostStatus): {
  feishuInbound: boolean;
  feishuOutbound: boolean;
  wecomOutbound: boolean;
  wechatPersonalInbound: false;
  note: string;
} {
  return {
    feishuInbound: status.feishuInbound,
    feishuOutbound: status.feishuOutbound,
    wecomOutbound: status.wecomOutbound,
    wechatPersonalInbound: false,
    note: status.feishuInbound || status.feishuOutbound || status.wecomOutbound
      ? "企业微信只做群机器人出站；个微/公众号入站需要你们自己的 App 凭证，本仓不伪造。"
      : "飞书/微信宿主未开。",
  };
}

export function gateNotifyPayloadFromBoard(
  status: ProjectStatus | null,
  project = "",
): GateNotifyPayload {
  if (!status) {
    return {
      project,
      summary: "看板已清除",
      nextGate: "",
      waiting: [],
    };
  }
  return {
    project: status.project || project,
    summary: status.summary,
    nextGate: status.nextGate,
    waiting: status.waiting,
    ...(status.decisions.length ? { decisions: status.decisions } : {}),
  };
}

/**
 * 卡片正文。测试锁的是这些字段进了文本，不锁飞书 card JSON 的移动 schema。
 * 谁在等为空时必须印「无」（不是空白、不是「（无）」）。
 */
export function formatGateCardText(payload: GateNotifyPayload): string {
  const waiting = payload.waiting.length ? payload.waiting.join("；") : "无";
  const decisions = payload.decisions?.length ? payload.decisions.join("；") : "无";
  const title = payload.title?.trim();
  const runHint = payload.runId
    ? `打开本 run：${payload.runId}`
    : "打开本机宿主查看该 run";
  return [
    title || "门禁看板",
    `项目：${payload.project}`,
    `摘要：${payload.summary}`,
    `下一门：${payload.nextGate}`,
    `谁在等：${waiting}`,
    `未决：${decisions}`,
    runHint,
  ].join("\n");
}

export function formatFeishuGateCard(payload: GateNotifyPayload): FeishuTextBody {
  return {
    msg_type: "text",
    content: { text: formatGateCardText(payload) },
  };
}

export function formatWecomText(text: string): WecomTextBody {
  return { msgtype: "text", text: { content: text } };
}

export function formatImRunResultText(payload: ImRunResultPayload): string {
  const reason = payload.stopReason?.trim() || "无";
  const summary = payload.summary?.trim() || payload.task;
  return [
    "任务已结束",
    `任务：${payload.task}`,
    `状态：${payload.status}`,
    `终止原因：${reason}`,
    `摘要：${summary}`,
    `打开本 run：${payload.runId}`,
  ].join("\n");
}

export function encodeOfficeNotifyBody(kind: OfficeNotifyKind, text: string): string {
  if (kind === "wecom") return JSON.stringify(formatWecomText(text));
  return JSON.stringify({ msg_type: "text", content: { text } });
}

/**
 * 日志用：剥 query / hash，并把末段 path（hook token）打码。
 * 真实启动横幅不应调用这个去打印地址——armed 时只印「已开 / 未开」。
 */
export function sanitizeNotifyUrlForLog(url: string): string {
  const raw = String(url ?? "").trim();
  if (!raw) return "(invalid-notify-url)";
  try {
    const parsed = new URL(raw);
    parsed.search = "";
    parsed.hash = "";
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length > 0) {
      parts[parts.length - 1] = "***";
      parsed.pathname = `/${parts.join("/")}`;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(invalid-notify-url)";
  }
}

export function officeNotifySnapshot(notifier: Pick<OfficeNotifier, "kind" | "armed">): OfficeNotifySnapshot {
  return { kind: notifier.kind, armed: notifier.armed };
}

export function createOfficeNotifier(opts: OfficeNotifyConfig = {}): OfficeNotifier {
  const webhookUrl = String(opts.webhookUrl ?? "").trim();
  const enabled = opts.enabled !== false && webhookUrl.length > 0;
  const kind: OfficeNotifyKind = opts.kind === "wecom"
    ? "wecom"
    : opts.kind === "webhook"
      ? "webhook"
      : "feishu";
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);

  const postText = async (text: string): Promise<void> => {
    if (!enabled) return;
    await fetchFn(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: encodeOfficeNotifyBody(kind, text),
    });
  };

  return {
    kind,
    armed: enabled,
    async notify(payload: GateNotifyPayload): Promise<void> {
      await postText(formatGateCardText(payload));
    },
    async notifyText(text: string): Promise<void> {
      await postText(text);
    },
  };
}

export function feishuSignatureHex(
  timestamp: string,
  nonce: string,
  encryptKey: string,
  body: string,
): string {
  return createHash("sha256").update(`${timestamp}${nonce}${encryptKey}${body}`).digest("hex");
}

export function verifyFeishuSignature(opts: {
  timestamp: string;
  nonce: string;
  body: string;
  encryptKey: string;
  signature: string;
}): boolean {
  const key = opts.encryptKey.trim();
  const sig = opts.signature.trim();
  if (!key || !sig || !opts.timestamp || !opts.nonce) return false;
  const expected = feishuSignatureHex(opts.timestamp, opts.nonce, key, opts.body);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isFeishuTimestampFresh(
  timestamp: string,
  nowMs: number = Date.now(),
  maxSkewMs: number = FEISHU_TIMESTAMP_MAX_SKEW_MS,
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const eventMs = ts < 1e12 ? ts * 1000 : ts;
  return Math.abs(nowMs - eventMs) <= maxSkewMs;
}

/**
 * 飞书 Encrypt Key 解密。密文 = Base64(iv[16] + ciphertext)。
 * key 材料 = SHA256(encrypt_key)。解不开返回 null，不抛。
 */
export function decryptFeishuEncrypt(encrypt: string, encryptKey: string): string | null {
  try {
    const key = createHash("sha256").update(encryptKey).digest();
    const buf = Buffer.from(encrypt, "base64");
    if (buf.length < 17) return null;
    const iv = buf.subarray(0, 16);
    const data = buf.subarray(16);
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    return null;
  }
}

export function stripFeishuMentions(text: string): string {
  return text
    .replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, " ")
    .replace(/@_user_\d+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractFeishuMessageText(content: unknown): string {
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as { text?: unknown };
        if (typeof parsed.text === "string") return stripFeishuMentions(parsed.text);
      } catch {
        return stripFeishuMentions(trimmed);
      }
    }
    return stripFeishuMentions(trimmed);
  }
  if (content && typeof content === "object" && typeof (content as { text?: unknown }).text === "string") {
    return stripFeishuMentions((content as { text: string }).text);
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseFeishuInboundEvent(
  raw: unknown,
  opts: { verificationToken?: string } = {},
): FeishuInboundParse {
  const root = asRecord(raw);
  if (!root) return { kind: "ignored", reason: "not_object" };

  if (root.type === "url_verification" && typeof root.challenge === "string") {
    const token = opts.verificationToken?.trim() ?? "";
    if (token && root.token !== token) return { kind: "ignored", reason: "token_mismatch" };
    return { kind: "challenge", challenge: root.challenge };
  }

  const header = asRecord(root.header);
  const expectedToken = opts.verificationToken?.trim() ?? "";
  if (expectedToken) {
    const got = (typeof header?.token === "string" ? header.token : undefined)
      ?? (typeof root.token === "string" ? root.token : undefined);
    if (got !== expectedToken) return { kind: "ignored", reason: "token_mismatch" };
  }

  const eventType = typeof header?.event_type === "string"
    ? header.event_type
    : typeof root.type === "string"
      ? root.type
      : "";
  if (eventType && eventType !== "im.message.receive_v1" && eventType !== "message") {
    return { kind: "ignored", reason: "not_message" };
  }

  const event = asRecord(root.event) ?? root;
  const sender = asRecord(event.sender);
  if (sender?.sender_type === "app") return { kind: "ignored", reason: "bot_echo" };

  const message = asRecord(event.message) ?? event;
  const messageType = typeof message.message_type === "string"
    ? message.message_type
    : typeof message.msg_type === "string"
      ? message.msg_type
      : "text";
  if (messageType !== "text") return { kind: "ignored", reason: "not_text" };

  const task = extractFeishuMessageText(message.content ?? message.text);
  if (!task) return { kind: "ignored", reason: "empty" };

  const messageId = typeof message.message_id === "string"
    ? message.message_id
    : typeof header?.event_id === "string"
      ? header.event_id
      : undefined;
  return { kind: "message", task, ...(messageId ? { messageId } : {}) };
}

export function unwrapFeishuInboundBody(
  rawText: string,
  encryptKey: string,
): { ok: true; value: unknown } | { ok: false; reason: "invalid_json" | "decrypt_failed" } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  const rec = asRecord(parsed);
  if (rec && typeof rec.encrypt === "string" && !rec.type && !rec.schema && !rec.header && !rec.event) {
    const plain = decryptFeishuEncrypt(rec.encrypt, encryptKey);
    if (plain == null) return { ok: false, reason: "decrypt_failed" };
    try {
      return { ok: true, value: JSON.parse(plain) };
    } catch {
      return { ok: false, reason: "invalid_json" };
    }
  }
  return { ok: true, value: parsed };
}

function headerValue(req: IncomingMessage, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  return typeof raw === "string" ? raw : Array.isArray(raw) ? (raw[0] ?? "") : "";
}

function pathnameOf(url: string | undefined): string {
  const raw = url ?? "";
  const q = raw.indexOf("?");
  return q === -1 ? raw : raw.slice(0, q);
}

export function isImInboundPath(url: string | undefined): boolean {
  const path = pathnameOf(url);
  return path === IM_STATUS_PATH || path === IM_FEISHU_PATH || path === IM_WECOM_PATH;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(json);
}

function readIncomingBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function handleImInboundRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ImInboundAttachOptions = {},
): Promise<void> {
  const env = opts.env ?? process.env;
  const path = pathnameOf(req.url);
  const method = (req.method ?? "GET").toUpperCase();
  const status = resolveImHostStatus(env);

  if (path === IM_STATUS_PATH && method === "GET") {
    writeJson(res, 200, imHostStatusSnapshot(status));
    return;
  }

  if (path === IM_WECOM_PATH) {
    writeJson(res, 501, {
      error: "企业微信入站未实现。个微/公众号需要你们自己的 App 凭证，本仓不伪造。出站请配 AGENT_WECOM_WEBHOOK（群机器人）。",
      enabled: false,
    });
    return;
  }

  if (path !== IM_FEISHU_PATH) {
    writeJson(res, 404, { error: "not found" });
    return;
  }

  if (method === "GET") {
    writeJson(res, status.feishuInbound ? 200 : 503, {
      enabled: status.feishuInbound,
      error: status.feishuInbound ? undefined : "飞书入站未开",
    });
    return;
  }

  if (method !== "POST") {
    writeJson(res, 405, { error: "method not allowed" });
    return;
  }

  const inbound = resolveFeishuInboundFromEnv(env);
  if (!inbound) {
    writeJson(res, 503, { error: "飞书入站未开", enabled: false });
    return;
  }

  let body: string;
  try {
    body = await readIncomingBody(req, IM_BODY_MAX_BYTES);
  } catch {
    writeJson(res, 413, { error: "payload too large" });
    return;
  }

  const timestamp = headerValue(req, "x-lark-request-timestamp");
  const nonce = headerValue(req, "x-lark-request-nonce");
  const signature = headerValue(req, "x-lark-signature");
  const nowMs = opts.nowMs?.() ?? Date.now();

  if (!verifyFeishuSignature({
    timestamp,
    nonce,
    body,
    encryptKey: inbound.encryptKey,
    signature,
  })) {
    writeJson(res, 401, { error: "签名无效" });
    return;
  }
  if (!isFeishuTimestampFresh(timestamp, nowMs)) {
    writeJson(res, 401, { error: "签名无效" });
    return;
  }

  const unwrapped = unwrapFeishuInboundBody(body, inbound.encryptKey);
  if (!unwrapped.ok) {
    writeJson(res, 400, { error: "无法解析事件" });
    return;
  }

  const parsed = parseFeishuInboundEvent(unwrapped.value, {
    verificationToken: inbound.verificationToken,
  });

  if (parsed.kind === "challenge") {
    writeJson(res, 200, { challenge: parsed.challenge });
    return;
  }
  if (parsed.kind === "ignored") {
    writeJson(res, 200, { ok: true, ignored: parsed.reason });
    return;
  }

  const seen = opts.seen;
  if (parsed.messageId && seen?.has(parsed.messageId)) {
    writeJson(res, 200, { ok: true, ignored: "duplicate" });
    return;
  }
  if (parsed.messageId && seen) {
    seen.add(parsed.messageId);
    if (seen.size > SEEN_EVENT_CAP) {
      const first = seen.values().next().value;
      if (first !== undefined) seen.delete(first);
    }
  }

  if (!opts.startRun) {
    writeJson(res, 503, { error: "飞书入站已开但未接线" });
    return;
  }

  let runId: string;
  try {
    const started = await opts.startRun({
      task: parsed.task,
      source: "feishu",
      ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
    });
    runId = started.runId;
  } catch {
    writeJson(res, 500, { error: "未能开跑" });
    return;
  }

  writeJson(res, 200, { ok: true, runId });

  const wait = opts.waitForRun;
  const notifier = opts.notifier;
  if (!wait || !notifier?.armed) return;
  void wait(runId)
    .then((result) => notifier.notifyText(formatImRunResultText(result)))
    .catch(() => {
      /* 出站失败不回打飞书；结果仍在本机 UI */
    });
}

/**
 * 把飞书/企微入站接到已有 http.Server 上，不改 ui/server.ts 的路由表。
 * IM 路径先于原 handler 吃掉，因而也不走 AGENT_UI_ACCESS_TOKEN（签名即凭证）。
 */
export function attachImInbound(server: Server, opts: ImInboundAttachOptions = {}): () => void {
  const existing = server.listeners("request").slice() as Array<
    (req: IncomingMessage, res: ServerResponse) => void
  >;
  server.removeAllListeners("request");
  const seen = opts.seen ?? new Set<string>();
  const wrapped = (req: IncomingMessage, res: ServerResponse): void => {
    if (isImInboundPath(req.url)) {
      void handleImInboundRequest(req, res, { ...opts, seen }).catch(() => {
        if (!res.headersSent) writeJson(res, 500, { error: "Internal server error" });
      });
      return;
    }
    for (const listener of existing) listener.call(server, req, res);
  };
  server.on("request", wrapped);
  return () => {
    server.removeListener("request", wrapped);
    for (const listener of existing) server.on("request", listener);
  };
}

export function createLocalImStartRun(opts: {
  port: () => number;
  accessToken?: string | null;
  fetchFn?: typeof fetch;
}): ImStartRunFn {
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  return async (input) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = opts.accessToken?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetchFn(`http://127.0.0.1:${opts.port()}/api/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ task: input.task }),
    });
    const body = await res.json() as { runId?: string; error?: string };
    if (!res.ok || typeof body.runId !== "string") {
      throw new Error("start_run_failed");
    }
    return { runId: body.runId };
  };
}

export function createLocalImWaitRun(opts: {
  port: () => number;
  accessToken?: string | null;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  intervalMs?: number;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): ImWaitRunFn {
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const intervalMs = opts.intervalMs ?? 400;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  return async (runId) => {
    const headers: Record<string, string> = {};
    const token = opts.accessToken?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    const started = opts.nowMs?.() ?? Date.now();
    while ((opts.nowMs?.() ?? Date.now()) - started <= timeoutMs) {
      const res = await fetchFn(`http://127.0.0.1:${opts.port()}/api/runs`, { headers });
      const list = await res.json() as Array<{
        runId: string;
        task?: string;
        title?: string;
        status?: string;
        stopReason?: string | null;
      }>;
      const entry = Array.isArray(list) ? list.find((r) => r.runId === runId) : undefined;
      if (entry?.status === "done") {
        return {
          task: String(entry.task ?? ""),
          runId,
          status: "done",
          stopReason: entry.stopReason ?? null,
          summary: String(entry.title ?? entry.task ?? ""),
        };
      }
      await sleep(intervalMs);
    }
    return {
      task: "",
      runId,
      status: "timeout",
      summary: "等待超时，请打开本机宿主查看",
    };
  };
}

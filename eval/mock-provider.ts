/**
 * EVAL-03a — 本地 mock provider：一台只监听 loopback 的 HTTP 服务，同时会说
 * 两套 wire——Anthropic Messages 流式（POST /v1/messages）与 OpenAI
 * chat.completions 流式（POST /v1/chat/completions）。
 *
 * 为什么要它：确定性质量门不能依赖真实端点。真端点会限流、会改模型名、会在
 * 半夜换措辞，而我们要验的是 L0 wire 层与 loop 的行为——包括**失败路径**：
 * 429 带 Retry-After、500、流中断、超时、坏 JSON。这些形态在真端点上要么不可
 * 复现，要么只能靠等（本仓历史上多次被"瞬时端点窗口"污染整批实验数据）。
 *
 * 设计取舍：
 * - **脚本队列驱动**，一次请求消费一条；队列空了回一个简单的 end_turn "ok"，
 *   这样"多跑一轮"不会变成难懂的报错。
 * - **故障是一等公民**，不是测试里 monkey-patch 出来的。`alwaysFault` 不消费
 *   脚本（它描述的是端点的状态，不是这一轮该说什么）。
 * - 每个文本/工具块只发一条 delta。**事件条数因此是确定的**，`cut_stream`
 *   的 `afterEvents` 才能精确指到某个事件之后断流。
 * - 认证头一律不校验：这里要验的是协议与故障，不是鉴权。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { isLoopbackHostname } from "../src/provider-config.js";

// ---------------------------------------------------------------- 契约

export type MockFault =
  | { type: "ok" }
  | { type: "status"; status: number; body?: unknown; headers?: Record<string, string> }
  | { type: "cut_stream"; afterEvents?: number }
  | { type: "timeout"; ms: number }
  | { type: "bad_json" }
  /**
   * 上下文超长（MEM-01 Phase C 反应式压缩的触发器）。两条 wire 各按真端点的形状回 400：
   * Anthropic「prompt is too long: N tokens > M maximum」；OpenAI `code: context_length_exceeded`。
   * 它描述的是"这一次请求装不下"，所以**消费**脚本（下一条请求才是重发）。
   */
  | { type: "context_overflow" };

export type MockContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export type MockStopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal";

export interface MockTurnScript {
  /** Anthropic 口径的 stop_reason；不写则按有无 tool_use 块推断 */
  stopReason?: MockStopReason;
  content: MockContentBlock[];
  fault?: MockFault;
  /** SSE 事件之间的间隔（毫秒），用来制造慢流 */
  eventDelayMs?: number;
}

export interface MockProviderOptions {
  host?: string;
  port?: number;
  /** 脚本队列，一次请求消费一条；空队列回简单的 end_turn "ok" */
  scripts?: MockTurnScript[];
  /** 设了就每个请求都先吃这个故障，且**不消费**脚本队列 */
  alwaysFault?: MockFault;
  /**
   * MODEL-01b：拒绝 Claude 专属扩展（thinking / output_config）。
   * 用来模拟 compat 端点——能力探针带 thinking 时应拿 400，健康仍算可达。
   */
  rejectClaudeExtensions?: boolean;
}

export interface MockRequestLogEntry {
  wire: "anthropic" | "openai";
  path: string;
  /** 解析后的请求体；解析不了就是原始字符串 */
  body: unknown;
}

export interface MockProviderHandle {
  baseUrl: string;
  /** Anthropic SDK 的 baseURL：SDK 自己会拼 /v1/messages */
  anthropicBaseUrl: string;
  /** OpenAI SDK 的 baseURL：SDK 自己会拼 /chat/completions */
  openaiBaseUrl: string;
  port: number;
  server: Server;
  pushScript(script: MockTurnScript): void;
  remainingScripts(): number;
  requestLog: MockRequestLogEntry[];
  close(): Promise<void>;
}

// ---------------------------------------------------------------- 纯事件构造

/** 时间戳写死：报文要可逐字节比对，不能每跑一次就变一次 */
export const MOCK_CREATED_UNIX = 1_700_000_000;
export const MOCK_INPUT_TOKENS = 11;

export interface ResolvedTurn {
  content: MockContentBlock[];
  stopReason: MockStopReason;
}

/** 队列空时的缺省回合，与"简单的 end_turn ok"这条承诺是同一处定义 */
export function resolveTurn(script: MockTurnScript | undefined): ResolvedTurn {
  const content = script?.content ?? [{ type: "text", text: "ok" }];
  const inferred: MockStopReason = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
  return { content, stopReason: script?.stopReason ?? inferred };
}

/** 粗略但确定：只要输入一样，报出来的 output_tokens 就一样 */
export function estimateOutputTokens(turn: ResolvedTurn): number {
  const chars = turn.content.reduce(
    (n, b) => n + (b.type === "text" ? b.text.length : JSON.stringify(b.input ?? {}).length + b.name.length),
    0,
  );
  return Math.max(1, Math.ceil(chars / 4));
}

export interface SseEvent {
  event: string;
  data: unknown;
}

/**
 * Anthropic 流式事件序列——形状取的是 @anthropic-ai/sdk 的累积器
 * （lib/MessageStream）真正读的那几个字段，不是文档抄写。
 */
export function anthropicSseEvents(turn: ResolvedTurn, meta: { id: string; model: string }): SseEvent[] {
  const events: SseEvent[] = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: meta.id,
          type: "message",
          role: "assistant",
          model: meta.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: MOCK_INPUT_TOKENS,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
    },
  ];

  turn.content.forEach((block, index) => {
    if (block.type === "text") {
      events.push({
        event: "content_block_start",
        data: { type: "content_block_start", index, content_block: { type: "text", text: "", citations: null } },
      });
      events.push({
        event: "content_block_delta",
        data: { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
      });
    } else {
      events.push({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
        },
      });
      // 工具入参走 input_json_delta 的 partial_json 累积，和真端点一样——
      // 直接在 content_block_start 里塞完整 input 的话，SDK 的懒解析路径就没被走过。
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
        },
      });
    }
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
  });

  events.push({
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: turn.stopReason, stop_sequence: null },
      usage: { output_tokens: estimateOutputTokens(turn) },
    },
  });
  events.push({ event: "message_stop", data: { type: "message_stop" } });
  return events;
}

export function toOpenAIFinishReason(stopReason: MockStopReason): string {
  switch (stopReason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

/** OpenAI chat.completion.chunk 序列；末尾的 `[DONE]` 由调用方拼帧时补 */
export function openaiSseChunks(turn: ResolvedTurn, meta: { id: string; model: string }): unknown[] {
  const base = {
    id: meta.id,
    object: "chat.completion.chunk",
    created: MOCK_CREATED_UNIX,
    model: meta.model,
  };
  const chunks: unknown[] = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
  ];

  let toolIndex = 0;
  for (const block of turn.content) {
    if (block.type === "text") {
      chunks.push({ ...base, choices: [{ index: 0, delta: { content: block.text }, finish_reason: null }] });
    } else {
      chunks.push({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: toolIndex,
                  id: block.id,
                  type: "function",
                  function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      toolIndex += 1;
    }
  }

  chunks.push({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: toOpenAIFinishReason(turn.stopReason) }],
  });
  // include_usage 的那一帧：choices 为空数组，用量单独给
  const completion = estimateOutputTokens(turn);
  chunks.push({
    ...base,
    choices: [],
    usage: {
      prompt_tokens: MOCK_INPUT_TOKENS,
      completion_tokens: completion,
      total_tokens: MOCK_INPUT_TOKENS + completion,
    },
  });
  return chunks;
}

export function sseFrame(event: string | undefined, data: string): string {
  return `${event ? `event: ${event}\n` : ""}data: ${data}\n\n`;
}

// ---------------------------------------------------------------- 服务

const STATUS_ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  408: "timeout_error",
  429: "rate_limit_error",
  500: "api_error",
  529: "overloaded_error",
};

/** 两条 wire 的"上下文超长"400 报文——形状照抄真端点，不是自己发明的 */
export function contextOverflowBody(wire: "anthropic" | "openai"): Record<string, unknown> {
  return wire === "anthropic"
    ? {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "prompt is too long: 213462 tokens > 200000 maximum",
        },
      }
    : {
        error: {
          message:
            "This model's maximum context length is 128000 tokens. However, your messages resulted in 131072 tokens. " +
            "Please reduce the length of the messages.",
          type: "invalid_request_error",
          param: "messages",
          code: "context_length_exceeded",
        },
      };
}

function lowercaseHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = v;
  return out;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

function wireOf(pathname: string): "anthropic" | "openai" | null {
  if (pathname === "/v1/messages" || pathname === "/messages") return "anthropic";
  if (pathname === "/v1/chat/completions" || pathname === "/chat/completions") return "openai";
  return null;
}

export async function startMockProvider(opts: MockProviderOptions = {}): Promise<MockProviderHandle> {
  const host = opts.host ?? "127.0.0.1";
  // 圈禁自检：harness 的端点白名单只对 loopback 放行明文 HTTP
  // （src/provider-config.ts）。mock 敢监听公网地址的话，这条不变量就等于
  // 在测试里被自己绕过了。
  if (!isLoopbackHostname(host)) {
    throw new Error(`mock provider 只允许监听 loopback，收到 host=${host}`);
  }

  const scripts: MockTurnScript[] = [...(opts.scripts ?? [])];
  const requestLog: MockRequestLogEntry[] = [];
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  let closed = false;
  let seq = 0;

  /** 计时器统一登记：close() 要能把在飞的 timeout 故障一并清掉，否则测试进程会挂住 */
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.add(timer);
      timer.unref?.();
    });

  function respondStatus(res: ServerResponse, fault: Extract<MockFault, { type: "status" }>): void {
    const overrides = lowercaseHeaders(fault.headers);
    const body =
      fault.body ??
      ({
        type: "error",
        error: {
          type: STATUS_ERROR_TYPES[fault.status] ?? "api_error",
          message: `mock provider injected fault (status ${fault.status})`,
        },
      } satisfies Record<string, unknown>);
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(fault.status, {
      "content-type": "application/json",
      // 429 默认带 Retry-After：限流的可测形态就是"服务端说了等多久"，
      // 缺省不给的话每个用例都要自己记得补，迟早漏。显式 headers 可覆盖。
      ...(fault.status === 429 ? { "retry-after": "1" } : {}),
      ...overrides,
    });
    res.end(payload);
  }

  async function writeStream(
    res: ServerResponse,
    frames: string[],
    stream: { delayMs: number; cutAfter: number },
  ): Promise<void> {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    if (stream.cutAfter <= 0) {
      res.destroy();
      return;
    }
    let written = 0;
    for (const frame of frames) {
      if (res.destroyed || closed) return;
      res.write(frame);
      written += 1;
      if (written >= stream.cutAfter) {
        // 先让已写入的字节离开缓冲，再断——否则客户端可能一个事件都没见到，
        // "流中途断掉"就退化成了"连接压根没建起来"，是另一种故障。
        await sleep(5);
        res.destroy();
        return;
      }
      if (stream.delayMs > 0) await sleep(stream.delayMs);
    }
    res.end();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? "/", `http://${host}`).pathname;
    const wire = wireOf(pathname);
    const raw = await readBody(req);

    if (!wire || req.method !== "POST") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `no mock route for ${req.method} ${pathname}` } }));
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
    requestLog.push({ wire, path: pathname, body });

    if (
      opts.rejectClaudeExtensions &&
      wire === "anthropic" &&
      body &&
      typeof body === "object" &&
      ("thinking" in (body as object) || "output_config" in (body as object))
    ) {
      respondStatus(res, {
        type: "status",
        status: 400,
        body: {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "thinking is not supported on this mock compat endpoint",
          },
        },
      });
      return;
    }

    const always = opts.alwaysFault && opts.alwaysFault.type !== "ok" ? opts.alwaysFault : undefined;
    const script = always ? undefined : scripts.shift();
    const fault: MockFault = always ?? script?.fault ?? { type: "ok" };

    if (fault.type === "timeout") await sleep(fault.ms);
    if (res.destroyed || closed) return;

    if (fault.type === "status") {
      respondStatus(res, fault);
      return;
    }
    if (fault.type === "context_overflow") {
      respondStatus(res, { type: "status", status: 400, body: contextOverflowBody(wire) });
      return;
    }

    seq += 1;
    const model = (body as { model?: unknown } | null)?.model;
    const modelName = typeof model === "string" && model ? model : "mock-model";
    const turn = resolveTurn(script);
    const stream = {
      delayMs: script?.eventDelayMs ?? 0,
      cutAfter: fault.type === "cut_stream" ? (fault.afterEvents ?? 1) : Number.POSITIVE_INFINITY,
    };

    if (fault.type === "bad_json") {
      // 事件名合法、data 不是 JSON：这正是两家 SDK 会走进 JSON.parse 然后炸掉的路径
      const frame =
        wire === "anthropic"
          ? sseFrame("message_start", '{"type":"message_start", <<not json>>')
          : sseFrame(undefined, '{"object":"chat.completion.chunk", <<not json>>');
      await writeStream(res, [frame], { ...stream, cutAfter: Number.POSITIVE_INFINITY });
      return;
    }

    const frames =
      wire === "anthropic"
        ? anthropicSseEvents(turn, { id: `msg_mock_${seq}`, model: modelName }).map((e) =>
            sseFrame(e.event, JSON.stringify(e.data)),
          )
        : [
            ...openaiSseChunks(turn, { id: `chatcmpl_mock_${seq}`, model: modelName }).map((c) =>
              sseFrame(undefined, JSON.stringify(c)),
            ),
            sseFrame(undefined, "[DONE]"),
          ];

    await writeStream(res, frames, stream);
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "mock provider handler failed" } }));
      } else {
        res.destroy();
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(opts.port ?? 0, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://${host}:${port}`;

  return {
    baseUrl,
    anthropicBaseUrl: baseUrl,
    openaiBaseUrl: `${baseUrl}/v1`,
    port,
    server,
    pushScript(script) {
      scripts.push(script);
    },
    remainingScripts() {
      return scripts.length;
    },
    requestLog,
    async close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

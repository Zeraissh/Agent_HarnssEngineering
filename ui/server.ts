/**
 * HTTP + SSE 后端事件桥：把 AgentLoop / runVerified 的 TurnEvent 流暴露给浏览器，
 * 并支持任务提交与审批应答。Node 内置模块，零第三方依赖。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { AgentLoop } from "../src/loop.js";
import { runVerified } from "../src/orchestrate.js";
import { createModelClientFromEnv } from "../src/provider.js";
import { getPack, selectPackTools } from "../src/presets.js";
import { bashTool } from "../src/tools/bash.js";
import { fetchUrlTool } from "../src/tools/fetch-url.js";
import { readFileTool } from "../src/tools/read-file.js";
import { writeFileTool } from "../src/tools/write-file.js";
import type { ModelClient, TurnEvent, AgentConfig, Tool } from "../src/types.js";
import type { Verdict } from "../src/verifier.js";

// ------------------------------------------------------
// Types
// ------------------------------------------------------

/**
 * `source` 是自由字符串而非字面量联合：并行编排（runPlanned）的来源形如
 * "s1/main"、"s1/verifier"，本轮虽不接，但契约先放开，避免日后破坏性变更。
 */
interface SSEEvent {
  seq: number;
  source: string;
  /** 服务端接收时刻——审批等待时长 = ts(approval_resolved) − ts(approval_request) */
  ts: number;
  event: Record<string, unknown>;
}

interface PendingApproval {
  toolUseId: string;
  name: string;
  input: unknown;
  /** 发出该请求的事件 seq —— 审批的唯一键，见 approvalId() */
  requestSeq: number;
  at: number;
  respond: (decision: "allow" | "deny", reason?: string) => void;
}

interface ResolvedApproval {
  decision: "allow" | "deny";
  reason?: string;
  at: number;
}

/** run 级终止信息，由 startPlainRun/startVerifiedRun 算出后交给 finalizeRun */
interface RunEndInfo {
  /** closed = 宿主关停导致的终止（run 本身没跑完），与 run 自己跑完区分开 */
  outcome: "completed" | "error" | "closed";
  mainStopReason?: string;
}

interface StoredRun {
  id: string;
  task: string;
  status: "running" | "done";
  verify: boolean;
  createdAt: number;
  finishedAt?: number;
  events: SSEEvent[];
  /**
   * 键是 approvalId（`toolUseId#requestSeq`）而非裸 toolUseId：返工轮会复用同一个
   * toolUseId，按裸 id 存会让后一轮覆盖前一轮，应答时也无法区分是哪一轮的卡片。
   */
  pendingApprovals: Map<string, PendingApproval>;
  respondedApprovals: Map<string, ResolvedApproval>;
  /** 裸 toolUseId 维度的已应答集合，仅用于 409 判定（兼容不带 #seq 的旧式请求） */
  respondedToolUseIds: Set<string>;
  sseClients: Set<ServerResponse>;
  /** 段计数：每个 main/rework 的 done 递增一次，用于把日志按段归属 */
  segmentIndex: number;
}

/** 审批唯一键：同一 toolUseId 在返工轮再次出现时，靠 requestSeq 区分 */
function approvalId(toolUseId: string, requestSeq: number): string {
  return `${toolUseId}#${requestSeq}`;
}

/**
 * verifier 来源判定。写成前缀/后缀两用是为并行编排预留——那里的来源形如
 * "s1/verifier"，若只比对字面量 "verifier"，子任务的 verifier 审批会被
 * 错误地挂进待办表，而它内部已自答 → 双响。
 */
function isVerifierSource(source: string): boolean {
  return source === "verifier" || source.endsWith("/verifier");
}

/** decodeURIComponent 对畸形百分号编码会抛错——路径参数是外部输入，不能让它炸掉请求 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export interface UiServerOptions {
  modelClient?: ModelClient;
  workdir?: string;
  packName?: string;
  /** 测试注入：覆盖默认工具池 */
  tools?: Tool[];
}

export interface UiServerHandle {
  server: Server;
  close(): Promise<void>;
}

// ------------------------------------------------------
// Helpers
// ------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function notFound(res: ServerResponse, detail?: string): void {
  json(res, 404, { error: detail ?? "Not found" });
}

function badRequest(res: ServerResponse, detail: string): void {
  json(res, 400, { error: detail });
}

/** 把 TurnEvent 投影为可序列化对象，approval_request 去掉 respond 回调 */
function serializeEvent(
  _source: string,
  event: TurnEvent,
  segmentIndex: number,
): Record<string, unknown> {
  switch (event.type) {
    case "approval_request":
      return {
        type: event.type,
        toolUseId: event.toolUseId,
        name: event.name,
        input: event.input,
      };
    case "done":
      return {
        type: event.type,
        stopReason: event.result.stopReason,
        usage: event.result.usage,
        // V-04：错误详情此前被整条丢弃，前端只能写死一句"运行异常终止"
        ...(event.result.error
          ? { error: { name: event.result.error.name, message: event.result.error.message } }
          : {}),
        // 会话正史不进 SSE（可达数 MB，全量缓冲会爆内存）——只给条数，正文走
        // GET /api/runs/:id/transcript 按需拉
        messageCount: event.result.messages.length,
        // V-01：段终止 ≠ run 终止。带上段身份，让前端能区分"这一段结束了"
        // 与"整个 run 结束了"——后者只由 run_end 宣告
        segment: { index: segmentIndex, source: _source },
      };
    default:
      return { ...event };
  }
}

const BUILTIN_POOL: Tool[] = [bashTool, fetchUrlTool, readFileTool, writeFileTool];
const DEFAULT_SYSTEM_PROMPT = `You are a capable autonomous agent operating in a local working directory.
Complete the user's task end to end using the available tools.
Ground every claim of progress in an actual tool result.`;

// ------------------------------------------------------
// Server factory
// ------------------------------------------------------

export function createUiServer(options: UiServerOptions = {}): UiServerHandle {
  // F1: 缺省模型从环境变量读取，compat 取自 createModelClientFromEnv 返回值
  const resolved = createModelClientFromEnv(process.env.AGENT_MODEL ?? "claude-opus-4-8");
  const modelClient = options.modelClient ?? resolved.client;
  const envCompat = resolved.compat;
  const workdir = options.workdir ?? process.cwd();
  const pack = options.packName ? getPack(options.packName) : undefined;
  const injectedTools = options.tools;

  const runs = new Map<string, StoredRun>();

  function buildConfig(): AgentConfig {
    const systemPrompt = pack?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    const tools = injectedTools ?? (pack
      ? selectPackTools(pack, BUILTIN_POOL, [])
      : BUILTIN_POOL);
    return {
      systemPrompt,
      tools,
      workdir,
      compat: envCompat,
    };
  }

  /** 向 run 的所有 SSE 客户端推送一条事件 */
  function broadcastSSE(run: StoredRun, data: string): void {
    for (const client of run.sseClients) {
      try {
        client.write(data);
      } catch {
        run.sseClients.delete(client);
      }
    }
  }

  /**
   * SSE 帧。带 `id:` 是为了让浏览器断线重连时自动带上 Last-Event-ID，
   * 服务端据此只补发缺口而不是整条重放。
   */
  function frameFor(sseEvent: SSEEvent): string {
    return `id: ${sseEvent.seq}\ndata: ${JSON.stringify(sseEvent)}\n\n`;
  }

  /** 推送一条 TurnEvent 到 run 的缓冲与在线 SSE 客户端（不负责完成/关闭逻辑） */
  function pushEvent(run: StoredRun, source: string, event: TurnEvent): number {
    const seq = run.events.length;
    const sseEvent: SSEEvent = {
      seq,
      source,
      ts: Date.now(),
      event: serializeEvent(source, event, run.segmentIndex),
    };
    run.events.push(sseEvent);

    // F2: verifier 的 approval_request 不进 pendingApprovals（verifier 内部已自答）
    if (event.type === "approval_request" && !isVerifierSource(source)) {
      run.pendingApprovals.set(approvalId(event.toolUseId, seq), {
        toolUseId: event.toolUseId,
        name: event.name,
        input: event.input,
        requestSeq: seq,
        at: sseEvent.ts,
        respond: event.respond,
      });
    }

    // 段计数在 done 之后递增：done 自身属于刚结束的那一段
    if (event.type === "done") run.segmentIndex += 1;

    // 推送给在线 SSE 客户端
    broadcastSSE(run, frameFor(sseEvent));
    return seq;
  }

  /** 推送合成事件（如 verdict / approval_resolved / run_end）到缓冲与在线客户端 */
  function pushSyntheticEvent(run: StoredRun, source: string, event: Record<string, unknown>): number {
    const seq = run.events.length;
    const sseEvent: SSEEvent = { seq, source, ts: Date.now(), event };
    run.events.push(sseEvent);
    broadcastSSE(run, frameFor(sseEvent));
    return seq;
  }

  /**
   * 标记 run 完成并关闭所有 SSE 连接。
   *
   * 顺序是契约的一部分：先把仍挂起的审批逐条宣告过期，再发 run_end，最后才断流。
   * run_end 恒为最后一条 durable 事件——它同时是"整个 run 结束了"的唯一权威信号
   * （段级 done 不是）与客户端"可以主动 close，不要再自动重连"的信号。
   */
  function finalizeRun(run: StoredRun, endInfo: RunEndInfo): void {
    if (run.status === "done") return; // 幂等：异常路径可能重复调用

    for (const pending of run.pendingApprovals.values()) {
      pushSyntheticEvent(run, "host", {
        type: "approval_expired",
        requestSeq: pending.requestSeq,
        toolUseId: pending.toolUseId,
        name: pending.name,
        cause: "run_finished",
      });
    }
    run.pendingApprovals.clear();

    run.status = "done";
    run.finishedAt = Date.now();

    pushSyntheticEvent(run, "host", {
      type: "run_end",
      finishedAt: run.finishedAt,
      outcome: endInfo.outcome,
      ...(endInfo.mainStopReason ? { mainStopReason: endInfo.mainStopReason } : {}),
    });

    for (const client of run.sseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    run.sseClients.clear();
  }

  /** 启动一次不带核查的运行 */
  async function startPlainRun(run: StoredRun): Promise<void> {
    const cfg = buildConfig();
    const loop = new AgentLoop(cfg, modelClient);
    let mainStopReason: string | undefined;
    try {
      for await (const event of loop.run(run.task)) {
        if (event.type === "done") mainStopReason = event.result.stopReason;
        pushEvent(run, "main", event);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errorEvent: TurnEvent = {
        type: "done",
        result: {
          stopReason: "error",
          messages: [],
          usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, turns: 0, cacheHitRatio: 0 },
          error: new Error(errorMsg),
        },
      };
      mainStopReason = "error";
      pushEvent(run, "main", errorEvent);
    } finally {
      finalizeRun(run, {
        outcome: mainStopReason === "error" ? "error" : "completed",
        ...(mainStopReason ? { mainStopReason } : {}),
      });
    }
  }

  /** 启动一次带核查的运行 */
  async function startVerifiedRun(run: StoredRun): Promise<void> {
    const cfg = buildConfig();
    let mainStopReason: string | undefined;
    try {
      const outcome = await runVerified(cfg, modelClient, run.task, {
        onEvent: (source, event) => {
          // 只记主/返工段的终止原因：verifier 的 done 已被 orchestrate 压掉，
          // 这里取到的最后一个就是最终交付那一段的
          if (event.type === "done") mainStopReason = event.result.stopReason;
          pushEvent(run, source, event);
        },
      });
      // 追加 verdict 合成事件
      const lastVerdict = outcome.verifications.at(-1)?.verdict;
      if (lastVerdict) {
        pushSyntheticEvent(run, "verifier", { type: "verdict", verdict: lastVerdict });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      mainStopReason = "error";
      pushSyntheticEvent(run, "main", {
        type: "done",
        stopReason: "error",
        error: { name: "Error", message: errorMsg },
        messageCount: 0,
        usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, turns: 0, cacheHitRatio: 0 },
      });
    } finally {
      finalizeRun(run, {
        outcome: mainStopReason === "error" ? "error" : "completed",
        ...(mainStopReason ? { mainStopReason } : {}),
      });
    }
  }

  /** SSE 事件流：先重放缓冲，再实时推送 */
  function serveSSE(req: IncomingMessage, res: ServerResponse, run: StoredRun): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // 断点续传：浏览器重连时自带 Last-Event-ID，只补发缺口而非整条重放。
    // 前端 reducer 另有 lastSeq 幂等兜底，所以即使这里退化为全量重放也不会串状态。
    const lastEventId = Number(req.headers["last-event-id"]);
    const from = Number.isFinite(lastEventId) ? lastEventId : -1;

    for (const evt of run.events) {
      if (evt.seq <= from) continue;
      res.write(frameFor(evt));
    }

    if (run.status === "done") {
      // run 已结束：重放完即关闭
      res.end();
      return;
    }

    // run 仍在进行：加入在线客户端列表，实时接收新事件
    run.sseClients.add(res);

    // 客户端断开时清理
    req.on("close", () => {
      run.sseClients.delete(res);
    });
  }

  /**
   * 把 URL 里的 approvalRef 解析为挂起审批。
   * - `toolUseId#seq`：精确匹配某一轮的那张卡（前端一律用这种形式）
   * - `toolUseId`：取该 id 下 requestSeq 最大的挂起项（兼容形式）
   */
  function resolveApprovalRef(
    run: StoredRun,
    ref: string,
  ): { key?: string; pending?: PendingApproval } {
    if (ref.includes("#")) {
      const pending = run.pendingApprovals.get(ref);
      return pending ? { key: ref, pending } : {};
    }
    let best: { key: string; pending: PendingApproval } | undefined;
    for (const [key, pending] of run.pendingApprovals) {
      if (pending.toolUseId !== ref) continue;
      if (!best || pending.requestSeq > best.pending.requestSeq) best = { key, pending };
    }
    return best ?? {};
  }

  // ------------------------------------------------------
  // Route matching
  // ------------------------------------------------------

  function matchRoute(
    method: string,
    url: string,
  ):
    | { type: "static"; filePath: string }
    | { type: "runsList" }
    | { type: "createRun" }
    | { type: "events"; runId: string }
    | { type: "approval"; runId: string; toolUseId: string }
    | { type: "malformed" } {
    if (method === "GET" && (url === "/" || url === "/index.html")) {
      return { type: "static", filePath: "index.html" };
    }
    if (method === "GET" && url.startsWith("/") && !url.startsWith("/api/")) {
      const file = url.slice(1);
      if (file.includes("..")) return { type: "malformed" };
      return { type: "static", filePath: file };
    }

    if (method === "GET" && url === "/api/runs") {
      return { type: "runsList" };
    }

    if (method === "POST" && url === "/api/runs") {
      return { type: "createRun" };
    }

    const eventsMatch = method === "GET" && url.match(/^\/api\/runs\/([^/]+)\/events$/);
    if (eventsMatch) {
      return { type: "events", runId: eventsMatch[1]! };
    }

    const approvalMatch = method === "POST" && url.match(/^\/api\/runs\/([^/]+)\/approvals\/([^/]+)$/);
    if (approvalMatch) {
      // approvalId 形如 `toolUseId#seq`；`#` 在 URL 里是片段分隔符，客户端必须
      // encodeURIComponent 后再拼路径，这里对应解码
      return {
        type: "approval",
        runId: approvalMatch[1]!,
        toolUseId: safeDecode(approvalMatch[2]!),
      };
    }

    return { type: "malformed" };
  }

  // ------------------------------------------------------
  // HTTP handler
  // ------------------------------------------------------

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    const route = matchRoute(method, url);

    switch (route.type) {
      case "malformed":
        return notFound(res, `Unknown route: ${method} ${url}`);

      case "runsList": {
        const list = [...runs.values()].map((r) => ({
          runId: r.id,
          task: r.task,
          status: r.status,
          verify: r.verify,
          createdAt: r.createdAt,
          finishedAt: r.finishedAt ?? null,
        }));
        return json(res, 200, list);
      }

      case "createRun": {
        let body: string;
        try {
          body = await readBody(req);
        } catch {
          return badRequest(res, "Failed to read request body");
        }
        let parsed: { task?: string; verify?: boolean };
        try {
          parsed = JSON.parse(body);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }
        if (!parsed.task || typeof parsed.task !== "string") {
          return badRequest(res, 'Missing or invalid "task" field');
        }
        const verify = parsed.verify === true;
        const id = randomUUID();
        const run: StoredRun = {
          id,
          task: parsed.task,
          status: "running",
          verify,
          createdAt: Date.now(),
          events: [],
          pendingApprovals: new Map(),
          respondedApprovals: new Map(),
          respondedToolUseIds: new Set(),
          sseClients: new Set(),
          segmentIndex: 0,
        };
        runs.set(id, run);

        if (verify) {
          void startVerifiedRun(run);
        } else {
          void startPlainRun(run);
        }

        return json(res, 200, { runId: id });
      }

      case "events": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);
        return serveSSE(req, res, run);
      }

      case "approval": {
        const run = runs.get(route.runId);
        if (!run) return notFound(res, `Run not found: ${route.runId}`);

        // approvalRef 二义解析：带 `#seq` 走精确匹配（前端一律用这种）；
        // 不带则取该 toolUseId 下最新的挂起项——保持对裸 toolUseId 调用方的兼容
        const { key, pending } = resolveApprovalRef(run, route.toolUseId);

        if (!pending) {
          // 不在 pending 中：检查是否已应答或 run 已结束（R-01 幂等 + 状态不允许）
          const bareId = route.toolUseId.split("#")[0]!;
          if (run.respondedApprovals.has(route.toolUseId) || run.respondedToolUseIds.has(bareId)) {
            return json(res, 409, { error: "Approval already decided" });
          }
          if (run.status === "done") {
            return json(res, 409, { error: "Run already finished; approvals are no longer accepted" });
          }
          return notFound(res, `Approval not found: ${route.toolUseId}`);
        }

        // R-01: 运行结束后任何审批 POST 返回 409
        if (run.status === "done") {
          return json(res, 409, { error: "Run already finished; approvals are no longer accepted" });
        }

        let body: string;
        try {
          body = await readBody(req);
        } catch {
          return badRequest(res, "Failed to read request body");
        }
        let parsed: { decision?: string; reason?: string };
        try {
          parsed = JSON.parse(body);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }
        if (parsed.decision !== "allow" && parsed.decision !== "deny") {
          return badRequest(res, 'decision must be "allow" or "deny"');
        }

        pending.respond(parsed.decision, parsed.reason);
        const at = Date.now();
        run.respondedApprovals.set(key!, {
          decision: parsed.decision,
          ...(parsed.reason ? { reason: parsed.reason } : {}),
          at,
        });
        run.respondedToolUseIds.add(pending.toolUseId);
        run.pendingApprovals.delete(key!);

        // V-02：决策进事件流。此前只写在浏览器内存里，刷新后已允许的审批
        // 会显示成"已过期"——审计记录必须由服务端持有，任意客户端重放一致
        pushSyntheticEvent(run, "host", {
          type: "approval_resolved",
          requestSeq: pending.requestSeq,
          toolUseId: pending.toolUseId,
          name: pending.name,
          decision: parsed.decision,
          ...(parsed.reason ? { reason: parsed.reason } : {}),
          actor: "user",
          at,
        });

        return json(res, 200, { acknowledged: true });
      }

      case "static": {
        const filePath = join(PUBLIC_DIR, route.filePath);
        if (!existsSync(filePath)) {
          return notFound(res, `File not found: ${route.filePath}`);
        }
        try {
          const content = await readFile(filePath);
          const ext = extname(filePath).toLowerCase();
          const contentType = MIME[ext] ?? "application/octet-stream";
          res.writeHead(200, { "Content-Type": contentType });
          res.end(content);
        } catch {
          return notFound(res, `Failed to read: ${route.filePath}`);
        }
        return;
      }
    }
  }

  const server = createServer(handleRequest);

  return {
    server,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        // 走正规的 finalizeRun 而不是直接掀桌：宿主关停时仍挂起的审批要被
        // 显式宣告过期、run_end 要落进事件流。否则在线客户端只会看到连接莫名断掉，
        // 而它按设计是会自动重连的——语义上就成了"运行还在，只是连不上"。
        for (const run of runs.values()) {
          finalizeRun(run, { outcome: "closed" });
        }
        runs.clear();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

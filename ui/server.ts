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

interface SSEEvent {
  seq: number;
  source: "main" | "rework" | "verifier";
  event: Record<string, unknown>;
}

interface PendingApproval {
  toolUseId: string;
  name: string;
  input: unknown;
  respond: (decision: "allow" | "deny", reason?: string) => void;
}

interface StoredRun {
  id: string;
  task: string;
  status: "running" | "done";
  verify: boolean;
  createdAt: number;
  finishedAt?: number;
  events: SSEEvent[];
  pendingApprovals: Map<string, PendingApproval>;
  respondedApprovals: Set<string>;
  sseClients: Set<ServerResponse>;
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
  _source: "main" | "rework" | "verifier",
  event: TurnEvent,
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

  /** 推送一条 TurnEvent 到 run 的缓冲与在线 SSE 客户端（不负责完成/关闭逻辑） */
  function pushEvent(run: StoredRun, source: "main" | "rework" | "verifier", event: TurnEvent): void {
    const sseEvent: SSEEvent = {
      seq: run.events.length,
      source,
      event: serializeEvent(source, event),
    };
    run.events.push(sseEvent);

    // F2: verifier 的 approval_request 不进 pendingApprovals（verifier 内部已自答）
    if (event.type === "approval_request" && source !== "verifier") {
      run.pendingApprovals.set(event.toolUseId, {
        toolUseId: event.toolUseId,
        name: event.name,
        input: event.input,
        respond: event.respond,
      });
    }

    // 推送给在线 SSE 客户端
    broadcastSSE(run, `data: ${JSON.stringify(sseEvent)}\n\n`);
  }

  /** 推送合成事件（如 verdict）到缓冲与在线客户端 */
  function pushSyntheticEvent(run: StoredRun, source: "main" | "rework" | "verifier", event: Record<string, unknown>): void {
    const sseEvent: SSEEvent = { seq: run.events.length, source, event };
    run.events.push(sseEvent);
    broadcastSSE(run, `data: ${JSON.stringify(sseEvent)}\n\n`);
  }

  /** 标记 run 完成并关闭所有 SSE 连接 */
  function finalizeRun(run: StoredRun): void {
    run.status = "done";
    run.finishedAt = Date.now();
    for (const client of run.sseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    run.sseClients.clear();
  }

  /** 启动一次不带核查的运行 */
  async function startPlainRun(run: StoredRun): Promise<void> {
    const cfg = buildConfig();
    const loop = new AgentLoop(cfg, modelClient);
    try {
      for await (const event of loop.run(run.task)) {
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
      pushEvent(run, "main", errorEvent);
    } finally {
      finalizeRun(run);
    }
  }

  /** 启动一次带核查的运行 */
  async function startVerifiedRun(run: StoredRun): Promise<void> {
    const cfg = buildConfig();
    try {
      const outcome = await runVerified(cfg, modelClient, run.task, {
        onEvent: (source, event) => {
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
      pushSyntheticEvent(run, "main", {
        type: "done",
        stopReason: "error",
        usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, turns: 0, cacheHitRatio: 0 },
      });
    } finally {
      finalizeRun(run);
    }
  }

  /** SSE 事件流：先重放缓冲，再实时推送 */
  function serveSSE(req: IncomingMessage, res: ServerResponse, run: StoredRun): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // 先重放缓冲的全部事件
    for (const evt of run.events) {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
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
      return { type: "approval", runId: approvalMatch[1]!, toolUseId: approvalMatch[2]! };
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
          respondedApprovals: new Set(),
          sseClients: new Set(),
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

        const pending = run.pendingApprovals.get(route.toolUseId);
        if (!pending) {
          // 不在 pending 中：检查是否已应答或 run 已结束（R-01 幂等 + 状态不允许）
          if (run.respondedApprovals.has(route.toolUseId)) {
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
        run.respondedApprovals.add(route.toolUseId);
        run.pendingApprovals.delete(route.toolUseId);
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
        for (const run of runs.values()) {
          run.status = "done";
          for (const client of run.sseClients) {
            try { client.end(); } catch { /* ignore */ }
          }
          run.sseClients.clear();
        }
        runs.clear();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

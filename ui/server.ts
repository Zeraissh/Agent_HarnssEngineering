/**
 * HTTP + SSE 后端事件桥：把 AgentLoop / runVerified 的 TurnEvent 流暴露给浏览器，
 * 并支持任务提交与审批应答。Node 内置模块，零第三方依赖。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { AgentLoop } from "../src/loop.js";
import { runVerified, type VerifiedRunResult } from "../src/orchestrate.js";
import { createModelClientFromEnv } from "../src/provider.js";
import { getPack, selectPackTools } from "../src/presets.js";
import { bashTool, SHELL_DESC } from "../src/tools/bash.js";
import { fetchUrlTool } from "../src/tools/fetch-url.js";
import { readFileTool } from "../src/tools/read-file.js";
import { writeFileTool } from "../src/tools/write-file.js";
import { EFFORT_LEVELS } from "../src/types.js";
import type { ModelClient, TurnEvent, AgentConfig, Tool, Effort } from "../src/types.js";
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
  /** 核查运行的完整结果（含 executionUsage / reworks / 全部裁决），run_end 用 */
  outcome?: VerifiedRunResult;
  /** 最终交付那一段的终止原因，列表接口直接读（不必等客户端订阅） */
  mainStopReason?: string;
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

  /**
   * 全局生命周期流的订阅者（V-10）。
   *
   * 存在的理由：侧栏此前靠 `setInterval(loadRuns, 3000)` 保持新鲜，而那次轮询会
   * 整体重建列表——实测焦点停在运行项上 3.6 秒后就变成 BODY。改成推送之后，
   * 侧栏只在真的有变化时更新，而且更新走键控补丁，不再摧毁焦点。
   * 这条流只广播"哪个 run 变了"，不带事件载荷——详情仍走 per-run 的 SSE。
   */
  const lifecycleClients = new Set<ServerResponse>();

  /**
   * 列表项摘要。V-14：元数据由服务端算好，侧栏不再依赖"这个 run 是否被订阅过"
   * ——此前核查结论一列只有打开过的 run 才有值。
   */
  function runSummary(r: StoredRun): Record<string, unknown> {
    return {
      runId: r.id,
      task: r.task,
      status: r.status,
      verify: r.verify,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt ?? null,
      packName: pack?.name ?? null,
      stopReason: r.mainStopReason ?? null,
      finalPassed: r.outcome?.finalPassed ?? null,
      reworks: r.outcome?.reworks ?? null,
      pendingApprovals: r.pendingApprovals.size,
      verdict: r.outcome?.verifications.at(-1)?.verdict ?? null,
    };
  }

  function broadcastLifecycle(type: string, run: StoredRun): void {
    if (lifecycleClients.size === 0) return;
    const frame = `data: ${JSON.stringify({ type, run: runSummary(run) })}\n\n`;
    for (const client of lifecycleClients) {
      try {
        client.write(frame);
      } catch {
        lifecycleClients.delete(client);
      }
    }
  }

  // 思考预算档：非法值当场抛错而不是静默退回默认——静默降级会让"我明明设了 max"
  // 与实际行为长期不一致（口径与 src/cli.ts 一致，CLI 是 exit 1，库里改成抛错）
  const effortEnv = process.env.AGENT_EFFORT;
  if (effortEnv && !(EFFORT_LEVELS as readonly string[]).includes(effortEnv)) {
    throw new Error(
      `AGENT_EFFORT="${effortEnv}" 无效。可选值: ${EFFORT_LEVELS.join(" | ")}`,
    );
  }
  const effort = effortEnv as Effort | undefined;

  // 额外只读根（安全边界：agent 能读到工作目录之外的哪里）
  const readRoots = (process.env.AGENT_READ_ROOTS ?? "")
    .split(delimiter)
    .map((s) => s.trim())
    .filter(Boolean);

  // 护栏优先级：显式 env > 领域包默认 > 全局默认（照抄 cli.ts 口径）
  const contextTokenLimit = process.env.AGENT_CONTEXT_LIMIT
    ? Number(process.env.AGENT_CONTEXT_LIMIT)
    : pack?.guardrails?.contextTokenLimit;
  const maxTokens = process.env.AGENT_MAX_TOKENS
    ? Number(process.env.AGENT_MAX_TOKENS)
    : pack?.guardrails?.maxTokens;
  const maxTurns = pack?.guardrails?.maxTurns;

  // 任务级评分表优先于领域包声明（rubric 是任务属性，包只提供缺省）
  const rubric = process.env.AGENT_VERIFY_RUBRIC ?? pack?.verify.rubric;

  /**
   * MCP 接入状态。**默认不连**，需 AGENT_UI_MCP=1 显式开。
   *
   * 理由不是保守：stm32-debug 这类包声明了 swd-probe 独占资源，而 UI server 是
   * 常驻进程——默认连接就等于一个长期攥着调试探针的会话，正是案例 #3 里
   * 害得整块板子连不上的那种形态。要用就显式开，用完关掉宿主。
   */
  const mcpEnabled = process.env.AGENT_UI_MCP === "1";
  const mcpStatus: Record<string, unknown> = {
    configured: existsSync(process.env.AGENT_MCP_CONFIG ?? join(workdir, "mcp.json")),
    enabled: mcpEnabled,
    connected: false,
    servers: [] as unknown[],
    ...(mcpEnabled
      ? {}
      : { reason: "Web 宿主默认不接 MCP（设 AGENT_UI_MCP=1 开启）——常驻进程持有独占资源有风险" }),
  };

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
      // 此前这里只设四个字段，pack 的护栏、只读根、effort 全部丢失
      ...(effort ? { effort } : {}),
      ...(readRoots.length ? { readRoots } : {}),
      ...(contextTokenLimit !== undefined ? { contextTokenLimit } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    };
  }

  /**
   * 核查选项装配（V-06）。
   *
   * 此前调 runVerified 只传了 onEvent——verifyInstructions / readOnlyCommands /
   * rubric 一个没传。后果不是"少显示点东西"：verifier 因此在 Web 上处于**无白名单**
   * 状态，bash 全被拒，只能靠间接证据核查，正是案例 #4 那个 22 轮空转的核查饥饿
   * 配置；rubric 失效则让 advisory 永远为空。
   */
  function buildVerifyOptions() {
    return {
      ...(pack?.verify.instructions ? { verifyInstructions: pack.verify.instructions } : {}),
      ...(pack?.verify.readOnlyCommands ? { verifyReadOnlyCommands: pack.verify.readOnlyCommands } : {}),
      ...(rubric ? { verifyRubric: rubric } : {}),
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
    // V-15：流式增量走命名通道，不占 seq、不进 run.events。
    // 此前它和其它事件一样被全量缓冲——一次长运行几万条 delta，晚订阅或重连
    // 时全部重放一遍，纯粹是带宽与内存的浪费（而前端还主动丢弃它们）。
    if (event.type === "text_delta") {
      broadcastSSE(
        run,
        `event: delta\ndata: ${JSON.stringify({ source, text: event.text })}\n\n`,
      );
      return -1;
    }

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
      // 侧栏的"待审批"计数靠这条推送保鲜，不必再轮询
      broadcastLifecycle("run_updated", run);
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
    if (endInfo.mainStopReason) run.mainStopReason = endInfo.mainStopReason;

    // V-07：成本必须用 executionUsage（全部执行轮合计，含被否掉的中间轮）。
    // 前端此前用最后一条 done 的 usage——返工场景下那只是最后一轮，主轮与
    // verifier 的开销全部漏计。核查开销单独列出，口径不混。
    const o = run.outcome;
    const verificationUsage = o
      ? o.verifications.reduce(
          (acc, v) => ({
            inputTokens: acc.inputTokens + v.usage.inputTokens,
            cacheCreationTokens: acc.cacheCreationTokens + v.usage.cacheCreationTokens,
            cacheReadTokens: acc.cacheReadTokens + v.usage.cacheReadTokens,
            outputTokens: acc.outputTokens + v.usage.outputTokens,
            turns: acc.turns + v.usage.turns,
            cacheHitRatio: 0,
          }),
          { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, turns: 0, cacheHitRatio: 0 },
        )
      : undefined;

    pushSyntheticEvent(run, "host", {
      type: "run_end",
      finishedAt: run.finishedAt,
      outcome: endInfo.outcome,
      ...(endInfo.mainStopReason ? { mainStopReason: endInfo.mainStopReason } : {}),
      ...(o
        ? {
            finalPassed: o.finalPassed,
            reworks: o.reworks,
            executionUsage: o.executionUsage,
            verificationUsage,
            verifications: o.verifications.map((v, i) => ({
              round: i,
              verdict: v.verdict,
              usage: v.usage,
              raw: v.raw,
            })),
          }
        : {}),
    });

    for (const client of run.sseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    run.sseClients.clear();

    broadcastLifecycle("run_finished", run);
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
        ...buildVerifyOptions(),
        onEvent: (source, event) => {
          // 只记主/返工段的终止原因：verifier 的 done 已被 orchestrate 压掉，
          // 这里取到的最后一个就是最终交付那一段的
          if (event.type === "done") mainStopReason = event.result.stopReason;
          pushEvent(run, source, event);
        },
        // V-08：逐轮裁决实时透出。只发末轮的话，"为什么要返工"（中间轮的 issues）
        // 在界面上永远看不到
        onVerification: (round, vo) => {
          pushSyntheticEvent(run, "verifier", {
            type: "verification",
            round,
            verdict: vo.verdict,
            usage: vo.usage,
          });
        },
      });
      run.outcome = outcome;
      // 追加 verdict 合成事件（末轮裁决，保持既有契约）
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
   * 宿主真相快照（V-18 的数据源）。
   *
   * 回答的是"这次运行里模型能做什么、核查者能查什么、边界在哪"——
   * 领域包工具面、MCP 状态、只读根、护栏、effort、核查白名单。这些此前在
   * Web 上完全不可见，用户只能猜。**不含任何密钥**，只暴露 baseURL 级别的信息。
   */
  function harnessSnapshot(): Record<string, unknown> {
    const tools = buildConfig().tools;
    return {
      model: process.env.AGENT_MODEL ?? "claude-opus-4-8",
      provider: process.env.AGENT_PROVIDER ?? "anthropic",
      compat: envCompat,
      // compat 模式下第三方端点不认识 output_config.effort，harness 不会发送它——
      // 界面必须说清楚，否则用户以为自己设的档位生效了
      effort: effort ?? null,
      effortApplies: Boolean(effort) && !envCompat,
      shell: SHELL_DESC,
      workdir,
      readRoots,
      guardrails: {
        maxTurns: maxTurns ?? null,
        maxTokens: maxTokens ?? null,
        contextTokenLimit: contextTokenLimit ?? null,
      },
      compactWatermark: 0.8,
      // 核查预算与执行者解耦，硬编码在 src/verifier.ts
      verifierBudgetTurns: 15,
      pack: pack
        ? {
            name: pack.name,
            description: pack.description,
            resources: pack.resources ?? [],
            verify: {
              enabled: pack.verify.enabled,
              mode: pack.verify.mode,
              hasInstructions: Boolean(pack.verify.instructions),
              readOnlyCommands: pack.verify.readOnlyCommands ?? [],
              rubricSource: process.env.AGENT_VERIFY_RUBRIC
                ? "env"
                : pack.verify.rubric
                  ? "pack"
                  : null,
            },
          }
        : {
            name: null,
            description: null,
            resources: [],
            verify: {
              enabled: false,
              mode: null,
              hasInstructions: false,
              readOnlyCommands: [],
              rubricSource: process.env.AGENT_VERIFY_RUBRIC ? "env" : null,
            },
          },
      tools: tools.map((t) => ({
        name: t.name,
        permission: t.permission,
        parallelSafe: t.parallelSafe,
        origin: BUILTIN_POOL.some((b) => b.name === t.name) ? "builtin" : "mcp",
      })),
      mcp: mcpStatus,
    };
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
    | { type: "harness" }
    | { type: "runsList" }
    | { type: "lifecycleStream" }
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

    if (method === "GET" && url === "/api/harness") {
      return { type: "harness" };
    }

    if (method === "GET" && url === "/api/runs") {
      return { type: "runsList" };
    }

    if (method === "GET" && url === "/api/stream") {
      return { type: "lifecycleStream" };
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

      case "harness":
        return json(res, 200, harnessSnapshot());

      case "runsList": {
        // V-13：按 createdAt 降序。此前是插入顺序（最旧在上），而客户端提交后把
        // 新任务 unshift 到顶——3 秒后一轮询它就从顶跳到底。
        const list = [...runs.values()]
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(runSummary);
        return json(res, 200, list);
      }

      case "lifecycleStream": {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        // 先发一份当前快照，订阅者不必再额外拉一次 /api/runs
        res.write(
          `data: ${JSON.stringify({
            type: "snapshot",
            runs: [...runs.values()].sort((a, b) => b.createdAt - a.createdAt).map(runSummary),
          })}\n\n`,
        );
        lifecycleClients.add(res);
        req.on("close", () => {
          lifecycleClients.delete(res);
        });
        return;
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
        broadcastLifecycle("run_created", run);

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
        broadcastLifecycle("run_updated", run);

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

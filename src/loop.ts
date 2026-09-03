/**
 * L1 — AgentLoop：harness 的心脏。
 * 控制流决策全部在这里：stop_reason 分支、护栏、事件流、审批挂起。
 *
 * 事件驱动契约：run() 返回 AsyncIterable<TurnEvent>，宿主 for-await 消费；
 * approval_request 事件挂起循环直到宿主调用 respond；最后一个事件恒为 done。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { DefaultContextManager, userMessageWithContext } from "./context.js";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { classifyApiError, isTransientApiError } from "./model-client.js";
import { decideRecovery } from "./recovery.js";
import { type DurableToolTx, type ToolTxController } from "./tool-tx.js";
import { ToolExecutor, ToolRegistry } from "./tools/registry.js";
import type {
  AgentConfig,
  AgentRunResult,
  AggregateUsage,
  ExecutionBroker,
  ModelClient,
  SharedRunBudget,
  TaskCompletion,
  TerminalResolution,
  TurnEvent,
} from "./types.js";

const DEFAULTS = {
  model: "claude-opus-4-8",
  effort: "high",
  maxTokens: 64_000,
  maxTurns: 50,
} as const;

/** 终结工具（§2.1）的回执：交付被接收 */
export const TERMINAL_TOOL_ACK = "已收到，交付完成。";
/** 同轮里与终结工具一起发出的其它调用的回执：未执行，且说清为什么 */
export const TERMINAL_TOOL_SUPERSEDED =
  "未执行：本轮已通过终结工具交付，运行到此结束。";
export const TERMINAL_TOOL_INVALID =
  "终结工具入参不符合交付契约，未收尾。请根据工具 schema 修正后重新提交。";

/**
 * 创建可跨 AgentLoop 实例共享的总预算。省略上限仍会累计读数，便于宿主观察；
 * 真正的硬上限由 maxTurns / maxTokens 字段决定。
 */
export function createRunBudget(
  limits: { maxTurns?: number; maxTokens?: number } = {},
): SharedRunBudget {
  return {
    ...(limits.maxTurns !== undefined ? { maxTurns: limits.maxTurns } : {}),
    ...(limits.maxTokens !== undefined ? { maxTokens: limits.maxTokens } : {}),
    usedTurns: 0,
    usedTokens: 0,
  };
}

/**
 * token 用量只有响应返回后才知道，不能像 turns 一样在请求前精确预占。显式设置
 * maxTokens 时，同一共享总账下的模型调用因此需要串行记账：允许最后一个已获准的
 * 调用按实际响应自然越界，但不会让多条并发轨同时基于同一个旧余额起跑。
 *
 * WeakMap 以总账对象本身为锁域；最后一个等待者释放后删除，避免长期宿主泄漏。
 */
const tokenBudgetTails = new WeakMap<SharedRunBudget, Promise<void>>();

async function acquireTokenBudgetSlot(budget: SharedRunBudget): Promise<() => void> {
  const previous = tokenBudgetTails.get(budget) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const tail = previous.then(() => gate);
  tokenBudgetTails.set(budget, tail);
  await previous;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
    if (tokenBudgetTails.get(budget) === tail) tokenBudgetTails.delete(budget);
  };
}

function turnTokenCost(usage: Anthropic.Usage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens
  );
}

/** 工具观察签名故意不含 tool_use_id——每次 id 都变，拿它比较永远检测不到重复。 */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stableValue(v)]),
    );
  }
  return value;
}

function observationSignature(
  blocks: Anthropic.ToolUseBlock[],
  results: Anthropic.ToolResultBlockParam[],
): string {
  const canonical = blocks.map((block, i) => ({
    name: block.name,
    input: stableValue(block.input),
    result: results[i]?.content ?? "",
    isError: results[i]?.is_error === true,
  }));
  // 工具结果可能是 MB 级文件/日志；只保留固定长度摘要，不能让停滞检测复制一份正文。
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * 重试退避 + 抖动。
 *
 * 为什么需要抖动（V-27 并行编排引入的新触发条件）：原实现是纯线性
 * `backoffMs * (attempt + 1)`，单 agent 时无害——只有一条重试轨。接入 DAG 并行
 * 调度（cap=3）之后，同一时刻在飞的多个子任务共享同一个端点，一旦撞上 429，
 * 它们会在【同一毫秒】发起重试，并在后续每一轮继续保持同步——线性退避对
 * "同时开始的多条轨"完全不做解耦，只是把碰撞整体推后。
 *
 * 用等量抖动（equal jitter）而非全抖动（full jitter）：全抖动取 [0, ceiling]，
 * 有可能几乎立刻重试——对 429 这种"服务端明说你太快了"的信号是错误的响应。
 * 等量抖动保证至少等到一半的既定退避，同时给出 2:1 的散布窗口；并发上限是 3
 * （AUTO_CONCURRENCY_CAP），2:1 的散布足够把三条轨拉开。
 *
 * 纯函数 + 可注入 random：抖动不能让重试行为变得不可测试（P2 按需晋升——
 * 这里不需要重试策略 DSL，只需要这一个函数是可断言的）。
 */
export function backoffWithJitter(
  baseMs: number,
  attempt: number,
  random: () => number = Math.random,
): number {
  const ceiling = baseMs * (attempt + 1);
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

/** push 式异步事件队列：让 loop 在 await 模型/工具期间也能实时发事件 */
class AsyncEventQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.buffer.push(value);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.buffer.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export class AgentLoop {
  private readonly registry = new ToolRegistry();
  private readonly executor: ToolExecutor;
  private readonly context: DefaultContextManager;
  private readonly maxTurns: number;
  private readonly runBudget: SharedRunBudget;
  private readonly errorRetries: number;
  private readonly errorRetryBackoffMs: number;
  /** SAFE-06：当前 run 的事务控制器（可无——无 runId 时不武装） */
  private toolTxCtrl: ToolTxController | undefined;

  constructor(
    private readonly cfg: AgentConfig,
    private readonly model: ModelClient,
  ) {
    for (const tool of cfg.tools) this.registry.register(tool);
    this.executor = new ToolExecutor(
      this.registry,
      cfg.workdir,
      cfg.readRoots,
      cfg.executionBroker,
    );
    // SAFE-06：有 runId 就武装事务层。宿主可注入持久化 controller；否则内存表。
    if (cfg.runId) {
      this.installToolTx(cfg.runId, cfg.toolTx);
    }
    this.context = new DefaultContextManager({
      systemPrompt: cfg.systemPrompt,
      maxTokens: cfg.maxTokens ?? DEFAULTS.maxTokens,
      effort: cfg.effort ?? DEFAULTS.effort,
      cacheBreakpoints: !cfg.compat,
      contextTokenLimit: cfg.contextTokenLimit,
      ...(cfg.initialContextInputTokens !== undefined
        ? { initialInputTokens: cfg.initialContextInputTokens }
        : {}),
      ...(cfg.compactSummaryClient
        ? {
            summaryClient: cfg.compactSummaryClient,
            ...(cfg.compactSummaryMaxTokens !== undefined
              ? { summaryMaxTokens: cfg.compactSummaryMaxTokens }
              : {}),
          }
        : {}),
    });
    this.maxTurns = cfg.maxTurns ?? DEFAULTS.maxTurns;
    this.runBudget =
      cfg.runBudget ??
      createRunBudget({
        ...(cfg.maxTotalTurns !== undefined ? { maxTurns: cfg.maxTotalTurns } : {}),
        ...(cfg.maxTokensBudget !== undefined ? { maxTokens: cfg.maxTokensBudget } : {}),
      });
    this.errorRetries = cfg.errorRetries ?? 1;
    this.errorRetryBackoffMs = cfg.errorRetryBackoffMs ?? 1500;
  }

  run(userInput: string, signal?: AbortSignal): AsyncIterable<TurnEvent> {
    const queue = new AsyncEventQueue<TurnEvent>();
    this.startDrive(userInput, signal ?? new AbortController().signal, queue);
    return queue;
  }

  /**
   * Preserve this loop's conversation context and cumulative budget while
   * replacing the execution boundary that was disposed at the end of the
   * previous segment.
   */
  setExecutionBroker(executionBroker?: ExecutionBroker): void {
    this.executor.setExecutionBroker(executionBroker);
  }

  /**
   * SAFE-06：安装/替换 toolTx 控制器。续跑同 runId 时应带上磁盘 seed
   * （cfg.toolTx.get 读 durableState.toolTx）。
   */
  setToolTx(controller?: ToolTxController): void {
    if (!this.cfg.runId && !controller) {
      this.toolTxCtrl = undefined;
      this.executor.setToolTx(undefined, undefined);
      return;
    }
    this.installToolTx(controller?.runId ?? this.cfg.runId!, controller);
  }

  private installToolTx(runId: string, external?: ToolTxController): void {
    const memory = new Map<string, DurableToolTx>();
    this.toolTxCtrl = external
      ? {
          runId: external.runId,
          get: (key) => external.get(key) ?? memory.get(key),
          notify: async (phase, tx, meta) => {
            memory.set(tx.idempotencyKey, tx);
            await external.notify(phase, tx, meta);
          },
          ...(external.injectCrashAfterPrepared
            ? { injectCrashAfterPrepared: external.injectCrashAfterPrepared }
            : {}),
        }
      : {
          runId,
          get: (key) => memory.get(key),
          notify: (_phase, tx) => {
            memory.set(tx.idempotencyKey, tx);
          },
        };
    this.executor.setToolTx(this.toolTxCtrl);
  }

  /**
   * 续跑：在已有会话正史之上追加一条 user 反馈继续执行。
   * 当前段的 maxTurns 重新起算；runBudget 的总轮次/token 账不会重置。
   * 用途：返工继承上下文——agent 保留此前的探索/工具结果，不必从零重烧
   * （A/B 实测 fresh 返工最贵一例白烧 127k tokens）。上下文增长由 compact 兜底。
   */
  runContinuation(
    history: Anthropic.MessageParam[],
    feedback: string,
    signal?: AbortSignal,
  ): AsyncIterable<TurnEvent> {
    const queue = new AsyncEventQueue<TurnEvent>();
    this.startDrive(feedback, signal ?? new AbortController().signal, queue, history);
    return queue;
  }

  /**
   * drive 是后台 promise；若未捕获异常，AsyncEventQueue 永远不会 end，所有宿主的
   * for-await 都会永久挂住。预期 API/工具失败在 drive 内有细分路径，这里只兜
   * harness 自身的意外异常，并仍履行“最后一条事件恒为 done”的总契约。
   */
  private startDrive(
    userInput: string,
    signal: AbortSignal,
    queue: AsyncEventQueue<TurnEvent>,
    history?: Anthropic.MessageParam[],
  ): void {
    void this.drive(userInput, signal, queue, history).catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const messages: Anthropic.MessageParam[] = history
        ? [...history, { role: "user", content: userInput }]
        : [{ role: "user", content: userInput }];
      queue.push({
        type: "done",
        result: {
          stopReason: "error",
          messages,
          usage: {
            inputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 0,
            turns: 0,
            cacheHitRatio: 0,
          },
          runBudget: { ...this.runBudget },
          contextInputTokens: this.context.checkpointInputTokens(),
          error,
        },
      });
      queue.end();
    });
  }

  private async drive(
    userInput: string,
    signal: AbortSignal,
    q: AsyncEventQueue<TurnEvent>,
    history?: Anthropic.MessageParam[],
  ): Promise<void> {
    // SAFE-06：把事务生命周期事件推入本段队列（与 tool_call 同流）
    if (this.toolTxCtrl) {
      this.executor.setToolTx(this.toolTxCtrl, async (event) => {
        q.push(event);
      });
    }
    // 续跑且正史末条是 user（如 max_turns 停在 tool_result 后）：反馈合并进同一条
    // user 消息，避免连续两条 user——Anthropic 官方允许，但第三方兼容端点未必。
    if (history && history.at(-1)?.role === "user") {
      const last = history.at(-1)!;
      const blocks: Anthropic.ContentBlockParam[] =
        typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
      blocks.push({ type: "text", text: userInput });
      history = [...history.slice(0, -1), { role: "user", content: blocks }];
      userInput = ""; // 已并入 history
    }
    let messages: Anthropic.MessageParam[] = [
      ...(history ?? []),
      ...(userInput === "" && history
        ? []
        : [
            this.cfg.dynamicContext && !history
              ? userMessageWithContext(userInput, this.cfg.dynamicContext)
              : ({ role: "user", content: userInput } as Anthropic.MessageParam),
          ]),
    ];
    const usage: AggregateUsage = {
      inputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      turns: 0,
      cacheHitRatio: 0,
    };

    const finish = (
      stopReason: AgentRunResult["stopReason"],
      error?: Error,
      completion?: TaskCompletion,
    ): void => {
      const denom = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
      usage.cacheHitRatio = denom > 0 ? usage.cacheReadTokens / denom : 0;
      q.push({
        type: "done",
        result: {
          stopReason,
          messages,
          usage,
          ...(completion ? { completion } : {}),
          runBudget: { ...this.runBudget },
          contextInputTokens: this.context.checkpointInputTokens(),
          ...(error ? { error } : {}),
        },
      });
      q.end();
    };

    /**
     * 恢复提示要并进末条 user（通常是 tool_result）而不是再造连续两条 user；
     * 第三方兼容端点对连续同角色消息的容忍度不一致。
     */
    const appendControlMessage = (text: string): void => {
      const last = messages.at(-1);
      if (last?.role === "user") {
        const content: Anthropic.ContentBlockParam[] =
          typeof last.content === "string"
            ? [{ type: "text", text: last.content }]
            : [...last.content];
        content.push({ type: "text", text });
        messages = [...messages.slice(0, -1), { role: "user", content }];
      } else {
        messages.push({ role: "user", content: text });
      }
    };

    let turn = 0;
    let turnCeiling = this.maxTurns;
    let extensionUsed = false;
    let completionReminderUsed = false;
    let forceTerminal = false;
    let terminalCorrectionUsed = false;
    let forcedFailureReason: "incomplete" | "stalled" = "incomplete";
    let hasProgress = false;
    let lastObservation: string | undefined;
    let repeatedObservationTurns = 0;
    let stagnationRecoveries = 0;

    while (true) {
      // 护栏检查发生在每次模型调用之前（契约 4）
      if (signal.aborted) {
        // 不是 error：人叫停是决定不是故障（见 AgentRunResult.stopReason 注释）
        return finish("aborted");
      }
      if (
        (this.runBudget.maxTurns !== undefined &&
          this.runBudget.usedTurns >= this.runBudget.maxTurns) ||
        (this.runBudget.maxTokens !== undefined &&
          this.runBudget.usedTokens >= this.runBudget.maxTokens)
      ) {
        return finish("budget_exhausted");
      }

      /**
       * 普通 loop 到 maxTurns 仍保持旧语义。只有显式装了业务完成门，宿主才会
       * 根据进展做一次有界续跑或强制收口——不会偷偷把所有任务的护栏调大。
       */
      if (turn >= turnCeiling) {
        if (!this.cfg.requireTerminalTool || !this.cfg.terminalTool) {
          return finish("max_turns");
        }
        if (forceTerminal) return finish(forcedFailureReason);

        const decision = decideRecovery({
          trigger: "max_turns",
          policy: this.cfg.recovery,
          hasProgress,
          extensionUsed,
        });
        q.push({
          type: "recovery_decision",
          reason: "max_turns",
          action: decision.action,
          detail: decision.detail,
          ...(decision.extraTurns !== undefined ? { extraTurns: decision.extraTurns } : {}),
        });
        appendControlMessage(`【恢复决策】${decision.detail}`);
        if (decision.action === "continue_with_context") {
          extensionUsed = true;
          turnCeiling += decision.extraTurns ?? 0;
        } else {
          forceTerminal = true;
          forcedFailureReason = "incomplete";
          // 强制交付本身是一轮短工具调用，不从执行预算里偷。
          turnCeiling = turn + 1;
        }
        continue;
      }

      let modelTurn;
      const releaseTokenBudget =
        this.runBudget.maxTokens !== undefined
          ? await acquireTokenBudgetSlot(this.runBudget)
          : undefined;
      try {
        // 等锁期间其它并发轨可能已经把共享总账用完，必须在真正发请求前复查。
        if (signal.aborted) return finish("aborted");
        if (
          (this.runBudget.maxTurns !== undefined &&
            this.runBudget.usedTurns >= this.runBudget.maxTurns) ||
          (this.runBudget.maxTokens !== undefined &&
            this.runBudget.usedTokens >= this.runBudget.maxTokens)
        ) {
          return finish("budget_exhausted");
        }

        turn += 1;
        q.push({ type: "turn_start", turn });

        /**
         * 总轮次在模型请求发出【之前】预占。并行计划下多个 AgentLoop 共享同一对象；
         * 若等响应回来才加，cap=1 时两条并发轨都会先看到 0 并各发一请求，硬上限
         * 会按并发度超卖。JS 在第一个 await 前同步执行，这一步就是原子预占点。
         *
         * MEM-01 Phase B：compactAsync 即使无摘要客户端也会 await 一次 Promise，
         * 预占必须排在它【之前】，否则并行轨会在微任务缝里同时通过上面的预算检查。
         */
        this.runBudget.usedTurns += 1;

        // 压缩替换正史（一次性、确定性），保证后续请求前缀稳定（见 context.ts 注释）
        // Phase B：可选 LLM 摘要经 compactAsync；未配置客户端时与 Phase A 同步路径等价
        const compacted = await this.context.compactAsync(messages, signal);
        if (compacted.droppedBlocks > 0) {
          messages = compacted.messages;
          q.push({
            type: "compaction",
            droppedBlocks: compacted.droppedBlocks,
            ledgerEntries: compacted.ledgerEntries,
            ...(compacted.summaryApplied ? { summaryApplied: true } : {}),
          });
        }

        const request = this.context.render(messages, this.registry.toApiTools());
        if (forceTerminal && this.cfg.terminalTool) {
          request.toolChoice = { type: "tool", name: this.cfg.terminalTool };
        } else if (this.cfg.toolChoice) {
          request.toolChoice = this.cfg.toolChoice;
        }

        // 同轮重试：SDK 的 HTTP 重试耗尽后，loop 层对瞬时错误再兜 errorRetries 次。
        // 请求是幂等的（同一 request 重发），非瞬时错误（认证/4xx/abort）立即终止。
        for (let attempt = 0; ; attempt++) {
          try {
            modelTurn = await this.model.send(
              request,
              (delta) =>
                q.push(
                  delta.kind === "thinking"
                    ? { type: "thinking_delta", text: delta.text }
                    : { type: "text_delta", text: delta.text },
                ),
              // 中止位不能只在轮与轮之间查：一次长生成就是一次调用，
              // 不把 signal 交给 SDK，"停止"就要等这一整轮吐完才生效
              signal,
            );
            break;
          } catch (err) {
            /**
             * 中止把在飞的请求掐断，SDK 会抛 AbortError——那不是故障。
             * 不在这里分出去的话，"我按了停止"会被画成"它崩了"，
             * 而且 error 路径还会触发段级续跑（9.8），变成"停一下又自己接着跑"。
             */
            if (signal.aborted) return finish("aborted");
            if (!isTransientApiError(err) || attempt >= this.errorRetries) {
              // 原始错误挂在 cause 上：分类过的消息是给人看的，但编排层要靠
              // isTransientApiError(原始错误) 决定"这段能不能带着正史续跑"（9.8）。
              // 此前这里只留下一句字符串，上游再想分类只能字符串匹配——那正是
              // 本项目一贯反对的做法。
              return finish("error", new Error(classifyApiError(err), { cause: err }));
            }
            const backoffMs = backoffWithJitter(this.errorRetryBackoffMs, attempt);
            q.push({
              type: "api_retry",
              turn,
              attempt: attempt + 1,
              reason: classifyApiError(err),
              backoffMs,
            });
            await delay(backoffMs);
          }
        }

        usage.turns = turn;
        this.context.noteUsage(modelTurn.usage);
        usage.inputTokens += modelTurn.usage.input_tokens;
        usage.cacheCreationTokens += modelTurn.usage.cache_creation_input_tokens ?? 0;
        usage.cacheReadTokens += modelTurn.usage.cache_read_input_tokens ?? 0;
        usage.outputTokens += modelTurn.usage.output_tokens;
        this.runBudget.usedTokens += turnTokenCost(modelTurn.usage);
      } finally {
        releaseTokenBudget?.();
      }
      q.push({ type: "usage", turn, usage: modelTurn.usage });

      // 完整 push assistant content（契约 1）：丢块会导致 400 或行为退化
      messages.push({ role: "assistant", content: modelTurn.message.content });

      /**
       * 思考块透出（委托方反馈：运行中只有直播条那一行，看不到模型在想什么）。
       *
       * 数据一直都在——`model-client.ts` 显式开了 adaptive thinking，思考块随
       * `message.content` 完整进历史。但它此前只在【会话正史】里，而正史是每段
       * `done` 之后才落盘的，所以运行过程中根本看不见。发成事件即可实时可见。
       *
       * 这是 turn 级而非流式：`stream.on("text")` 只接文本增量，`thinking_delta`
       * 尚未接（见 docs/06-backlog.md 第四节）。所以思考在【每轮结束时】整块到达，
       * 不是逐字——比没有强得多，但别把它当流式。
       *
       * redacted_thinking 照实标注，不假装没有：那是服务端加密过的思考，
       * 内容取不到，但"这里有一段思考"这个事实本身要让人看见。
       */
      for (const block of modelTurn.message.content) {
        if (block.type === "thinking" && block.thinking) {
          q.push({ type: "assistant_thinking", turn, text: block.thinking, redacted: false });
        } else if (block.type === "redacted_thinking") {
          q.push({ type: "assistant_thinking", turn, text: "", redacted: true });
        }
      }

      const text = modelTurn.message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text) q.push({ type: "assistant_text", text });

      switch (modelTurn.stopReason) {
        case "end_turn":
        case "stop_sequence": {
          if (!this.cfg.requireTerminalTool || !this.cfg.terminalTool) {
            return finish("completed");
          }
          if (forceTerminal) return finish(forcedFailureReason);

          const decision = decideRecovery({
            trigger: "end_turn_without_completion",
            policy: this.cfg.recovery,
            completionReminderUsed,
          });
          q.push({
            type: "recovery_decision",
            reason: "end_turn_without_completion",
            action: decision.action,
            detail: decision.detail,
          });
          appendControlMessage(
            `${this.cfg.terminalReminder ?? decision.detail}\n【宿主判定】${decision.detail}`,
          );
          completionReminderUsed = true;
          if (decision.action === "force_completion") {
            forceTerminal = true;
            forcedFailureReason = "incomplete";
            // 只给一轮结构化收口。不能保留原来的大 ceiling，否则兼容端点无视
            // tool_choice 后还能继续空转几十轮，“强制”就只剩名字。
            turnCeiling = turn + 1;
          }
          continue;
        }

        case "refusal":
          // 不用同一 prompt 重试（API 硬约束 7）
          return finish("refusal");

        case "max_tokens": {
          // 优雅终止而非报废整轮：部分 assistant 内容已入历史、assistant_text 已发出，
          // 都得以保留。max_tokens 是刻意的护栏（防本地模型跑飞/上下文预算），撞上限
          // 说明本轮输出需要更多空间——提高 maxTokens 即可，而非丢弃已完成的工作。
          if (!this.cfg.requireTerminalTool || !this.cfg.terminalTool) {
            return finish("max_tokens");
          }
          if (forceTerminal) return finish(forcedFailureReason);
          const decision = decideRecovery({
            trigger: "max_tokens_without_completion",
            policy: this.cfg.recovery,
          });
          q.push({
            type: "recovery_decision",
            reason: "max_tokens_without_completion",
            action: decision.action,
            detail: decision.detail,
          });
          appendControlMessage(`【收口】${decision.detail}`);
          forceTerminal = true;
          forcedFailureReason = "incomplete";
          turnCeiling = turn + 1;
          continue;
        }

        case "pause_turn":
          // 原样重发，不追加任何用户文本（API 硬约束 2）
          hasProgress = false;
          continue;

        case "tool_use": {
          const blocks = modelTurn.message.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
          );
          for (const b of blocks) {
            q.push({ type: "tool_call", toolUseId: b.id, name: b.name, input: b.input });
          }

          /**
           * 终结工具（§2.1）：模型调用它 = 交付完成，立刻收尾。
           *
           * 同轮里的其它工具调用**不执行**：模型既然已经交付，再跑取证只会
           * 让"完成"这件事变得可争议（同轮多调用是常态，不是异常）。但每个
           * tool_use 都要有对应的 tool_result——① API 硬约束 1，这段正史可能
           * 被 runContinuation 复用；② 事件流上每条 tool_call 都得有回执，
           * 否则界面留下一条永远转圈的调用。
           */
          if (this.cfg.terminalTool) {
            const terminal = blocks.find((b) => b.name === this.cfg.terminalTool);
            if (terminal) {
              let resolution: TerminalResolution | undefined;
              try {
                resolution = this.cfg.resolveTerminal?.(terminal.input);
              } catch {
                resolution = undefined;
              }
              const invalid = Boolean(this.cfg.resolveTerminal) && !resolution;
              const ackOf = (id: string): string => {
                if (id !== terminal.id) return TERMINAL_TOOL_SUPERSEDED;
                return invalid ? TERMINAL_TOOL_INVALID : TERMINAL_TOOL_ACK;
              };
              for (const b of blocks) {
                q.push({
                  type: "tool_result",
                  toolUseId: b.id,
                  result: {
                    content: ackOf(b.id),
                    ...(invalid && b.id === terminal.id ? { isError: true } : {}),
                  },
                  durationMs: 0,
                });
              }
              messages.push({
                role: "user",
                content: blocks.map((b) => ({
                  type: "tool_result" as const,
                  tool_use_id: b.id,
                  content: ackOf(b.id),
                  ...(invalid && b.id === terminal.id ? { is_error: true } : {}),
                })),
              });
              if (invalid) {
                // 强制收口段也给一次修正 schema 的机会；仍受总预算约束。
                if (forceTerminal) {
                  if (terminalCorrectionUsed) return finish(forcedFailureReason);
                  terminalCorrectionUsed = true;
                  turnCeiling = turn + 1;
                }
                continue;
              }
              return finish(
                resolution?.stopReason ?? "completed",
                undefined,
                resolution?.completion,
              );
            }
          }

          /**
           * 强制收口时兼容端点仍可能无视 tool_choice。此时其它工具绝不执行：
           * 否则“最后一轮只许交付”又会退回继续取证，正是 B0b 修过的失效。
           */
          if (forceTerminal && this.cfg.terminalTool) {
            const refusal =
              `当前处于强制收口阶段，只允许调用 ${this.cfg.terminalTool}。` +
              "其它工具未执行；请立即提交真实的 completed / partial / blocked 状态。";
            for (const b of blocks) {
              q.push({
                type: "tool_result",
                toolUseId: b.id,
                result: { content: refusal, isError: true },
                durationMs: 0,
              });
            }
            messages.push({
              role: "user",
              content: blocks.map((b) => ({
                type: "tool_result" as const,
                tool_use_id: b.id,
                content: refusal,
                is_error: true,
              })),
            });
            continue;
          }

          /**
           * 结构化禁工具（B0b）：tool_choice=none 已随请求发出，但兼容端点
           * 可能只收不认（探针只证明了"接受"，没证明"遵守"）。这里是真不变量：
           * 不执行、回可操作的拒绝，让模型用剩余轮次写结论——收口段的
           * "别再调工具"从此不靠自觉（P6）。
           */
          if (this.cfg.toolChoice === "none") {
            const refusal = "此阶段工具不可用（收口段只许写结论）。立即以纯文本输出最终结论，不要再请求任何工具。";
            for (const b of blocks) {
              q.push({
                type: "tool_result",
                toolUseId: b.id,
                result: { content: refusal, isError: true },
                durationMs: 0,
              });
            }
            messages.push({
              role: "user",
              content: blocks.map((b) => ({
                type: "tool_result" as const,
                tool_use_id: b.id,
                content: refusal,
                is_error: true,
              })),
            });
            continue;
          }

          const results = await this.executor.executeAll(
            blocks,
            signal,
            (block) =>
              new Promise((resolve) => {
                q.push({
                  type: "approval_request",
                  toolUseId: block.id,
                  name: block.name,
                  input: block.input,
                  respond: (decision, reason) => resolve({ decision, reason }),
                });
              }),
            (executed) =>
              q.push({
                type: "tool_result",
                toolUseId: executed.toolUseId,
                result: executed.result,
                durationMs: executed.durationMs,
              }),
          );

          // 目标级进展判定：相同调用与相同观察才算重复；tool_use_id 不参与签名。
          const signature = observationSignature(blocks, results);
          if (signature === lastObservation) {
            repeatedObservationTurns += 1;
            hasProgress = false;
          } else {
            lastObservation = signature;
            repeatedObservationTurns = 1;
            hasProgress = true;
          }

          const resultContent: Anthropic.ContentBlockParam[] = [...results];
          const stagnationWindow = Math.max(
            0,
            Math.floor(this.cfg.recovery?.stagnationWindow ?? 0),
          );
          if (
            this.cfg.requireTerminalTool &&
            this.cfg.terminalTool &&
            stagnationWindow > 0 &&
            repeatedObservationTurns >= stagnationWindow
          ) {
            const decision = decideRecovery({
              trigger: "stagnation",
              policy: this.cfg.recovery,
              stagnationRecoveries,
            });
            q.push({
              type: "recovery_decision",
              reason: "stagnation",
              action: decision.action,
              detail: decision.detail,
            });
            resultContent.push({ type: "text", text: `【停滞检测】${decision.detail}` });
            if (decision.action === "change_strategy") {
              stagnationRecoveries += 1;
            } else {
              forceTerminal = true;
              forcedFailureReason = "stalled";
              turnCeiling = turn + 1;
            }
          }

          // 所有 tool_result + 恢复指令合并进【同一条】user 消息（API 硬约束 1）
          messages.push({ role: "user", content: resultContent });
          continue;
        }

        default:
          return finish(
            "error",
            new Error(`Unhandled stop_reason: ${String(modelTurn.stopReason)}`),
          );
      }
    }
  }
}

/**
 * L1 — AgentLoop：harness 的心脏。
 * 控制流决策全部在这里：stop_reason 分支、护栏、事件流、审批挂起。
 *
 * 事件驱动契约：run() 返回 AsyncIterable<TurnEvent>，宿主 for-await 消费；
 * approval_request 事件挂起循环直到宿主调用 respond；最后一个事件恒为 done。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { DefaultContextManager, userMessageWithContext } from "./context.js";
import { setTimeout as delay } from "node:timers/promises";
import { classifyApiError, isTransientApiError } from "./model-client.js";
import { ToolExecutor, ToolRegistry } from "./tools/registry.js";
import type {
  AgentConfig,
  AgentRunResult,
  AggregateUsage,
  ModelClient,
  TurnEvent,
} from "./types.js";

const DEFAULTS = {
  model: "claude-opus-4-8",
  effort: "high",
  maxTokens: 64_000,
  maxTurns: 50,
} as const;

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
  private readonly maxTokensBudget: number | undefined;
  private readonly errorRetries: number;
  private readonly errorRetryBackoffMs: number;

  constructor(
    private readonly cfg: AgentConfig,
    private readonly model: ModelClient,
  ) {
    for (const tool of cfg.tools) this.registry.register(tool);
    this.executor = new ToolExecutor(this.registry, cfg.workdir, cfg.readRoots);
    this.context = new DefaultContextManager({
      systemPrompt: cfg.systemPrompt,
      maxTokens: cfg.maxTokens ?? DEFAULTS.maxTokens,
      effort: cfg.effort ?? DEFAULTS.effort,
      cacheBreakpoints: !cfg.compat,
      contextTokenLimit: cfg.contextTokenLimit,
    });
    this.maxTurns = cfg.maxTurns ?? DEFAULTS.maxTurns;
    this.maxTokensBudget = cfg.maxTokensBudget;
    this.errorRetries = cfg.errorRetries ?? 1;
    this.errorRetryBackoffMs = cfg.errorRetryBackoffMs ?? 1500;
  }

  run(userInput: string, signal?: AbortSignal): AsyncIterable<TurnEvent> {
    const queue = new AsyncEventQueue<TurnEvent>();
    void this.drive(userInput, signal ?? new AbortController().signal, queue);
    return queue;
  }

  /**
   * 续跑：在已有会话正史之上追加一条 user 反馈继续执行（轮次预算重新起算）。
   * 用途：返工继承上下文——agent 保留此前的探索/工具结果，不必从零重烧
   * （A/B 实测 fresh 返工最贵一例白烧 127k tokens）。上下文增长由 compact 兜底。
   */
  runContinuation(
    history: Anthropic.MessageParam[],
    feedback: string,
    signal?: AbortSignal,
  ): AsyncIterable<TurnEvent> {
    const queue = new AsyncEventQueue<TurnEvent>();
    void this.drive(feedback, signal ?? new AbortController().signal, queue, history);
    return queue;
  }

  private async drive(
    userInput: string,
    signal: AbortSignal,
    q: AsyncEventQueue<TurnEvent>,
    history?: Anthropic.MessageParam[],
  ): Promise<void> {
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
    ): void => {
      const denom = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
      usage.cacheHitRatio = denom > 0 ? usage.cacheReadTokens / denom : 0;
      q.push({ type: "done", result: { stopReason, messages, usage, ...(error ? { error } : {}) } });
      q.end();
    };

    for (let turn = 1; turn <= this.maxTurns; turn++) {
      // 护栏检查发生在每次模型调用之前（契约 4）
      if (signal.aborted) {
        return finish("error", new Error("Aborted by host"));
      }
      if (this.maxTokensBudget !== undefined) {
        const spent =
          usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens + usage.outputTokens;
        if (spent >= this.maxTokensBudget) {
          return finish("budget_exhausted");
        }
      }

      q.push({ type: "turn_start", turn });

      // 压缩替换正史（一次性、确定性），保证后续请求前缀稳定（见 context.ts 注释）
      const compacted = this.context.compact(messages);
      if (compacted.droppedBlocks > 0) {
        messages = compacted.messages;
        q.push({ type: "compaction", droppedBlocks: compacted.droppedBlocks });
      }

      const request = this.context.render(messages, this.registry.toApiTools());

      // 同轮重试：SDK 的 HTTP 重试耗尽后，loop 层对瞬时错误再兜 errorRetries 次。
      // 请求是幂等的（同一 request 重发），非瞬时错误（认证/4xx/abort）立即终止。
      let modelTurn;
      for (let attempt = 0; ; attempt++) {
        try {
          modelTurn = await this.model.send(request, (text) =>
            q.push({ type: "text_delta", text }),
          );
          break;
        } catch (err) {
          if (signal.aborted || !isTransientApiError(err) || attempt >= this.errorRetries) {
            return finish("error", new Error(classifyApiError(err)));
          }
          q.push({
            type: "api_retry",
            turn,
            attempt: attempt + 1,
            reason: classifyApiError(err),
          });
          await delay(this.errorRetryBackoffMs * (attempt + 1));
        }
      }

      usage.turns = turn;
      this.context.noteUsage(modelTurn.usage);
      usage.inputTokens += modelTurn.usage.input_tokens;
      usage.cacheCreationTokens += modelTurn.usage.cache_creation_input_tokens ?? 0;
      usage.cacheReadTokens += modelTurn.usage.cache_read_input_tokens ?? 0;
      usage.outputTokens += modelTurn.usage.output_tokens;
      q.push({ type: "usage", turn, usage: modelTurn.usage });

      // 完整 push assistant content（契约 1）：丢块会导致 400 或行为退化
      messages.push({ role: "assistant", content: modelTurn.message.content });

      const text = modelTurn.message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text) q.push({ type: "assistant_text", text });

      switch (modelTurn.stopReason) {
        case "end_turn":
        case "stop_sequence":
          return finish("completed");

        case "refusal":
          // 不用同一 prompt 重试（API 硬约束 7）
          return finish("refusal");

        case "max_tokens":
          // 优雅终止而非报废整轮：部分 assistant 内容已入历史、assistant_text 已发出，
          // 都得以保留。max_tokens 是刻意的护栏（防本地模型跑飞/上下文预算），撞上限
          // 说明本轮输出需要更多空间——提高 maxTokens 即可，而非丢弃已完成的工作。
          return finish("max_tokens");

        case "pause_turn":
          // 原样重发，不追加任何用户文本（API 硬约束 2）
          continue;

        case "tool_use": {
          const blocks = modelTurn.message.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
          );
          for (const b of blocks) {
            q.push({ type: "tool_call", toolUseId: b.id, name: b.name, input: b.input });
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

          // 所有 tool_result 合并进【同一条】user 消息（API 硬约束 1）
          messages.push({ role: "user", content: results });
          continue;
        }

        default:
          return finish(
            "error",
            new Error(`Unhandled stop_reason: ${String(modelTurn.stopReason)}`),
          );
      }
    }

    finish("max_turns");
  }
}

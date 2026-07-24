/**
 * L1 — AgentLoop：harness 的心脏。
 * 控制流决策全部在这里：stop_reason 分支、护栏、事件流、审批挂起。
 *
 * 事件驱动契约：run() 返回 AsyncIterable<TurnEvent>，宿主 for-await 消费；
 * approval_request 事件挂起循环直到宿主调用 respond；最后一个事件恒为 done。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { DefaultContextManager } from "./context.js";
import { classifyApiError } from "./model-client.js";
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

  constructor(
    private readonly cfg: AgentConfig,
    private readonly model: ModelClient,
  ) {
    for (const tool of cfg.tools) this.registry.register(tool);
    this.executor = new ToolExecutor(this.registry, cfg.workdir);
    this.context = new DefaultContextManager({
      systemPrompt: cfg.systemPrompt,
      maxTokens: cfg.maxTokens ?? DEFAULTS.maxTokens,
      effort: cfg.effort ?? DEFAULTS.effort,
      cacheBreakpoints: !cfg.compat,
    });
    this.maxTurns = cfg.maxTurns ?? DEFAULTS.maxTurns;
    this.maxTokensBudget = cfg.maxTokensBudget;
  }

  run(userInput: string, signal?: AbortSignal): AsyncIterable<TurnEvent> {
    const queue = new AsyncEventQueue<TurnEvent>();
    void this.drive(userInput, signal ?? new AbortController().signal, queue);
    return queue;
  }

  private async drive(
    userInput: string,
    signal: AbortSignal,
    q: AsyncEventQueue<TurnEvent>,
  ): Promise<void> {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: userInput }];
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

      const request = this.context.render(
        this.context.compact(messages),
        this.registry.toApiTools(),
      );

      let modelTurn;
      try {
        modelTurn = await this.model.send(request, (text) =>
          q.push({ type: "text_delta", text }),
        );
      } catch (err) {
        return finish("error", new Error(classifyApiError(err)));
      }

      usage.turns = turn;
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
          // v0.2 从简：视为宿主级错误终止；v0.3 再考虑提额重试策略
          return finish(
            "error",
            new Error(
              `Output truncated at max_tokens=${this.cfg.maxTokens ?? DEFAULTS.maxTokens}; raise maxTokens in AgentConfig`,
            ),
          );

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

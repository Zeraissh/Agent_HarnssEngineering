/**
 * L2 — ToolRegistry + ToolExecutor：工具注册、确定性序列化、权限评估与并行调度。
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { ExecutionBroker, Tool, ToolResult, TurnEvent } from "../types.js";
import {
  canonicalInputHash,
  decideToolTxReplay,
  isSideEffectTool,
  retryPolicyForTool,
  toolIdempotencyKey,
  type DurableToolTx,
  type ToolTxController,
} from "../tool-tx.js";
import { validateToolInput } from "./validate-input.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 按 name 排序 —— 工具顺序稳定 = 缓存前缀稳定（P3） */
  list(): Tool[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  toApiTools(): Anthropic.Tool[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }
}

export type ApprovalFn = (
  block: Anthropic.ToolUseBlock,
) => Promise<{ decision: "allow" | "deny"; reason?: string }>;

export interface ExecutedTool {
  toolUseId: string;
  result: ToolResult;
  durationMs: number;
}

/** SAFE-06：生命周期事件交给 loop 推入 TurnEvent 流 */
export type ToolTxEventSink = (event: TurnEvent) => void | Promise<void>;

export class ToolExecutor {
  private toolTx: ToolTxController | undefined;
  private onTxEvent: ToolTxEventSink | undefined;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly workdir: string,
    private readonly readRoots?: string[],
    private executionBroker?: ExecutionBroker,
  ) {}

  /**
   * A completed Web conversation segment disposes its execution boundary.  The
   * same AgentLoop may still be reused for a follow-up so that context and the
   * shared run budget survive; swap only the segment-scoped broker before that
   * continuation starts.
   */
  setExecutionBroker(executionBroker?: ExecutionBroker): void {
    this.executionBroker = executionBroker;
  }

  /** SAFE-06：注入/替换事务控制器与事件出口（loop 在 drive 前设置）。 */
  setToolTx(controller?: ToolTxController, onTxEvent?: ToolTxEventSink): void {
    this.toolTx = controller;
    this.onTxEvent = onTxEvent;
  }

  /**
   * 执行一轮内的全部 tool_use 块：
   * - parallelSafe 的并发执行，其余串行；
   * - 结果按原 block 顺序返回（合并进单条 user 消息由 loop 负责）；
   * - 任何失败都收敛为 isError result，绝不向上抛（P5）。
   * - 副作用工具走 prepared→committed；崩溃注入在 prepared 之后可抛（供测试）。
   */
  async executeAll(
    blocks: Anthropic.ToolUseBlock[],
    signal: AbortSignal,
    approve: ApprovalFn,
    onResult?: (executed: ExecutedTool) => void,
  ): Promise<Anthropic.ToolResultBlockParam[]> {
    const settled = new Map<string, ExecutedTool>();

    const runOne = async (block: Anthropic.ToolUseBlock): Promise<void> => {
      const started = Date.now();
      const result = await this.executeSingle(block, signal, approve);
      const executed = { toolUseId: block.id, result, durationMs: Date.now() - started };
      settled.set(block.id, executed);
      onResult?.(executed);
    };

    const parallel = blocks.filter((b) => this.registry.get(b.name)?.parallelSafe);
    const serial = blocks.filter((b) => !this.registry.get(b.name)?.parallelSafe);

    await Promise.all(parallel.map(runOne));
    for (const block of serial) {
      await runOne(block);
    }

    // 按原顺序组装；每个 tool_use_id 有且仅有一个 result（API 硬约束）
    return blocks.map((block) => {
      const executed = settled.get(block.id)!;
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: executed.result.content,
        ...(executed.result.isError ? { is_error: true } : {}),
      };
    });
  }

  private async executeSingle(
    block: Anthropic.ToolUseBlock,
    signal: AbortSignal,
    approve: ApprovalFn,
  ): Promise<ToolResult> {
    /**
     * 中止后一个块都不再评估——尤其不再**请求审批**。
     *
     * 真机现场（2026-09-03，Web 宿主）：一轮里 5 个串行 write_file，人在第一个
     * 审批卡上按了停止。宿主把当时挂起的那一个 deny 掉，可下一个块照样走到审批门，
     * 又挂出一张新卡——没人会给一个已经叫停的运行放行，于是 run 永远停在
     * running / pendingApprovals=1，每按一次停止只解开一个。停止按钮不能停，
     * 比没有更糟。中止位在块与块之间必须先查，审批门之后的那次检查只管
     * "等审批期间被中止"这一形态。
     */
    if (signal.aborted) {
      return { content: `Tool "${block.name}" aborted before execution.`, isError: true };
    }

    const tool = this.registry.get(block.name);
    if (!tool) {
      /**
       * 名字不对时先给最接近的候选（案例 #8 的 9.4）。
       *
       * 实测形态：verifier 调 `read_variable` 而正确名是 `stm32__read_variable`
       * ——MCP 工具带 `<server>__` 前缀，模型很容易漏掉。原来只丢一份全量清单，
       * 工具面二十几个时模型得自己在里面找，每次白烧一轮。
       *
       * 只在**确有**接近候选时提示，且候选也照常附全量清单——猜错方向比不猜更糟。
       */
      const names = this.registry.list().map((t) => t.name);
      const near = nearestToolNames(block.name, names);
      const hint = near.length ? ` Did you mean: ${near.join(" / ")}?` : "";
      return {
        content: `Unknown tool "${block.name}".${hint} Available tools: ${names.join(", ")}`,
        isError: true,
      };
    }

    /**
     * 入参校验（P6：护栏是宿主的责任）——在【审批门之前】。
     *
     * 顺序是有意的：入参就不合法的调用不该去打扰人做授权决定。人看到审批卡时
     * 应当只需判断"要不要授权这个动作"，而不是先替宿主检查参数形状对不对。
     * 校验器本身失败开放（只拒认得的构造被明确违反），见 validate-input.ts。
     *
     * 各工具自己的 typeof 检查保留不动：Tool.execute 是可被直接调用的公开面
     * （测试就这么用），工具守住自己的前置条件是本分，不是这一层的冗余。
     * 分工是：这一层执行【声明过的 schema】，工具那一层管 schema 表达不了的
     * 语义约束（非空、必须 https://）。
     */
    const invalid = validateToolInput(tool.inputSchema, block.input);
    if (invalid) {
      return { content: invalid, isError: true };
    }

    if (tool.permission === "ask") {
      const { decision, reason } = await approve(block);
      if (decision === "deny") {
        return {
          content: `User denied permission to run "${block.name}".${reason ? ` Reason: ${reason}` : ""} Adjust your approach or ask the user how to proceed.`,
          isError: true,
        };
      }
    }

    const sideEffect = isSideEffectTool(tool.name) && this.toolTx;
    if (!sideEffect) {
      try {
        return await tool.execute(block.input, {
          workdir: this.workdir,
          ...(this.readRoots?.length ? { readRoots: this.readRoots } : {}),
          toolUseId: block.id,
          signal,
          ...(this.executionBroker ? { executionBroker: this.executionBroker } : {}),
        });
      } catch (err) {
        if (err instanceof ToolTxCrashError) throw err;
        return {
          content: `Tool "${block.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    }

    return this.executeSideEffect(tool, block, signal);
  }

  /**
   * SAFE-06 副作用路径：prepared →（crash 注入点）→ running → execute → committed。
   * 同 key 已 committed → 跳过；bash prepared/running → fail-closed 不重跑。
   */
  private async executeSideEffect(
    tool: Tool,
    block: Anthropic.ToolUseBlock,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const ctrl = this.toolTx!;
    const inputHash = canonicalInputHash(block.input);
    const key = toolIdempotencyKey(ctrl.runId, block.id);
    const existing = ctrl.get(key);
    const decision = decideToolTxReplay(existing, inputHash);

    if (decision.action === "skip_committed") {
      const tx: DurableToolTx = {
        ...(existing as DurableToolTx),
        status: "committed",
        updatedAt: Date.now(),
      };
      await this.emitTx("tool_committed", tx, { skipped: true });
      await ctrl.notify("committed", tx, { skipped: true });
      return decision.result;
    }

    if (decision.action === "fail_closed") {
      const base =
        existing ??
        ({
          idempotencyKey: key,
          toolUseId: block.id,
          name: tool.name,
          inputHash,
          status: "failed" as const,
          retryPolicy: retryPolicyForTool(tool.name),
          preparedAt: Date.now(),
          updatedAt: Date.now(),
        } satisfies DurableToolTx);
      const tx: DurableToolTx = {
        ...base,
        status: "failed",
        updatedAt: Date.now(),
        resultContent: decision.reason,
        resultIsError: true,
      };
      await this.emitTx("tool_failed", tx, { reason: decision.reason });
      await ctrl.notify("failed", tx, { reason: decision.reason });
      return { content: decision.reason, isError: true };
    }

    const now = Date.now();
    const prepared: DurableToolTx = {
      idempotencyKey: key,
      toolUseId: block.id,
      name: tool.name,
      inputHash,
      status: "prepared",
      retryPolicy: retryPolicyForTool(tool.name),
      preparedAt: existing?.preparedAt ?? now,
      updatedAt: now,
    };
    await this.emitTx("tool_prepared", prepared);
    await ctrl.notify("prepared", prepared);

    if (ctrl.injectCrashAfterPrepared?.()) {
      // 崩溃注入：prepared 已落盘；不进入 running/execute。向上抛让宿主收成 interrupted。
      throw new ToolTxCrashError(key);
    }

    if (signal.aborted) {
      const aborted: DurableToolTx = { ...prepared, status: "aborted", updatedAt: Date.now() };
      await this.emitTx("tool_aborted", aborted);
      await ctrl.notify("aborted", aborted);
      return { content: `Tool "${tool.name}" aborted before execution.`, isError: true };
    }

    const running: DurableToolTx = { ...prepared, status: "running", updatedAt: Date.now() };
    await this.emitTx("tool_running", running);
    await ctrl.notify("running", running);

    try {
      const result = await tool.execute(block.input, {
        workdir: this.workdir,
        ...(this.readRoots?.length ? { readRoots: this.readRoots } : {}),
        toolUseId: block.id,
        signal,
        ...(this.executionBroker ? { executionBroker: this.executionBroker } : {}),
      });
      const committed: DurableToolTx = {
        ...running,
        status: "committed",
        updatedAt: Date.now(),
        resultContent: result.content,
        ...(result.isError ? { resultIsError: true } : {}),
      };
      await this.emitTx("tool_committed", committed);
      await ctrl.notify("committed", committed);
      return result;
    } catch (err) {
      if (err instanceof ToolTxCrashError) throw err;
      if (signal.aborted) {
        const aborted: DurableToolTx = { ...running, status: "aborted", updatedAt: Date.now() };
        await this.emitTx("tool_aborted", aborted);
        await ctrl.notify("aborted", aborted);
        return { content: `Tool "${tool.name}" aborted during execution.`, isError: true };
      }
      const reason = err instanceof Error ? err.message : String(err);
      const failed: DurableToolTx = {
        ...running,
        status: "failed",
        updatedAt: Date.now(),
        resultContent: reason,
        resultIsError: true,
      };
      await this.emitTx("tool_failed", failed, { reason });
      await ctrl.notify("failed", failed, { reason });
      return {
        content: `Tool "${block.name}" failed: ${reason}`,
        isError: true,
      };
    }
  }

  private async emitTx(
    type: "tool_prepared" | "tool_running" | "tool_committed" | "tool_failed" | "tool_aborted",
    tx: DurableToolTx,
    meta?: { skipped?: boolean; reason?: string },
  ): Promise<void> {
    if (!this.onTxEvent) return;
    if (type === "tool_prepared") {
      await this.onTxEvent({
        type,
        toolUseId: tx.toolUseId,
        name: tx.name,
        idempotencyKey: tx.idempotencyKey,
        inputHash: tx.inputHash,
      });
      return;
    }
    if (type === "tool_running") {
      await this.onTxEvent({
        type,
        toolUseId: tx.toolUseId,
        name: tx.name,
        idempotencyKey: tx.idempotencyKey,
      });
      return;
    }
    if (type === "tool_committed") {
      await this.onTxEvent({
        type,
        toolUseId: tx.toolUseId,
        name: tx.name,
        idempotencyKey: tx.idempotencyKey,
        ...(meta?.skipped ? { skipped: true } : {}),
      });
      return;
    }
    if (type === "tool_failed") {
      await this.onTxEvent({
        type,
        toolUseId: tx.toolUseId,
        name: tx.name,
        idempotencyKey: tx.idempotencyKey,
        reason: meta?.reason ?? tx.resultContent ?? "failed",
      });
      return;
    }
    await this.onTxEvent({
      type: "tool_aborted",
      toolUseId: tx.toolUseId,
      name: tx.name,
      idempotencyKey: tx.idempotencyKey,
    });
  }
}

/** prepared 落盘后、副作用前注入的崩溃——不得被 executeSingle 收成 isError。 */
export class ToolTxCrashError extends Error {
  readonly idempotencyKey: string;
  constructor(idempotencyKey: string) {
    super(`SAFE-06 crash injection after tool_prepared (${idempotencyKey})`);
    this.name = "ToolTxCrashError";
    this.idempotencyKey = idempotencyKey;
  }
}

/**
 * 找出与给定名字最接近的工具名（最多 2 个）。
 *
 * 两条判据，按可靠性排序：
 * ① **后缀命中**——`read_variable` vs `stm32__read_variable`。这是实测最常见的
 *    形态（MCP 的 `<server>__` 前缀被漏掉），且几乎不会误报，优先给。
 * ② **编辑距离** ≤ 名字长度的三分之一：拼写手滑。阈值卡紧一点，
 *    宁可不提示也不要把模型往错的方向带。
 */
export function nearestToolNames(name: string, candidates: string[], limit = 2): string[] {
  const lower = name.toLowerCase();
  const bySuffix = candidates.filter(
    (c) => c.toLowerCase().endsWith(`__${lower}`) || c.toLowerCase() === lower,
  );
  if (bySuffix.length > 0) return bySuffix.slice(0, limit);

  const budget = Math.max(1, Math.floor(name.length / 3));
  return candidates
    .map((c) => ({ c, d: editDistance(lower, c.toLowerCase()) }))
    .filter((x) => x.d <= budget)
    .sort((a, b) => a.d - b.d || a.c.length - b.c.length)
    .slice(0, limit)
    .map((x) => x.c);
}

/** Levenshtein，滚动一行——工具名很短，不值得引库 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

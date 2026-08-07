/**
 * L2 — ToolRegistry + ToolExecutor：工具注册、确定性序列化、权限评估与并行调度。
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Tool, ToolResult } from "../types.js";
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

export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly workdir: string,
    private readonly readRoots?: string[],
  ) {}

  /**
   * 执行一轮内的全部 tool_use 块：
   * - parallelSafe 的并发执行，其余串行；
   * - 结果按原 block 顺序返回（合并进单条 user 消息由 loop 负责）；
   * - 任何失败都收敛为 isError result，绝不向上抛（P5）。
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
    const tool = this.registry.get(block.name);
    if (!tool) {
      return {
        content: `Unknown tool "${block.name}". Available tools: ${this.registry
          .list()
          .map((t) => t.name)
          .join(", ")}`,
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

    try {
      return await tool.execute(block.input, {
        workdir: this.workdir,
        ...(this.readRoots?.length ? { readRoots: this.readRoots } : {}),
        toolUseId: block.id,
        signal,
      });
    } catch (err) {
      // 错误进上下文，写给模型看（P5）
      return {
        content: `Tool "${block.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}

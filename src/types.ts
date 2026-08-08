/**
 * 核心类型定义 — 与 docs/03-interfaces.md 一一对应。
 * 约定：wire 格式一律复用 SDK 导出类型，这里只定义 harness 自身的概念。
 */
import type Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------- L2: 工具契约

/** JSON Schema 对象（工具输入约束），直接使用 SDK 的 InputSchema 形状 */
export type JSONSchema = Anthropic.Tool.InputSchema;

export interface ToolContext {
  /** 工作目录（路径校验的根，所有文件类工具不得逃逸） */
  workdir: string;
  /**
   * 额外只读根（可选）：read_file 可读取这些目录下的绝对路径（写类工具不受益）。
   * 用于领域素材库（如 KiCad 官方符号/封装库）在工作区之外的场景。
   */
  readRoots?: string[];
  /** 本次调用的 tool_use_id，用于日志关联 */
  toolUseId: string;
  /** 取消信号：护栏触发或用户中断时，长时间运行的工具应尽快退出 */
  signal: AbortSignal;
}

export interface ToolResult {
  /** 回填给模型的内容。错误信息要写给模型看（可操作、指明修正方向） */
  content: string;
  /** true = 以 is_error: true 回传，模型据此调整策略；不会中断循环 */
  isError?: boolean;
}

export interface Tool {
  name: string;
  /** 必须写清"何时调用"（触发条件），不只是"做什么" */
  description: string;
  inputSchema: JSONSchema;
  /** auto = 直接执行；ask = 发 approval_request 事件，等宿主应答后执行 */
  permission: "auto" | "ask";
  /** true = 可与其他 parallelSafe 工具并发执行（典型：只读工具） */
  parallelSafe: boolean;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

// ---------------------------------------------------------------- L0: 模型客户端

/**
 * 思考预算档位，对应 Anthropic `output_config.effort`。
 * "max" 自 SDK 0.115 起可用（升级窗口 7c8ae75 附带发现）。
 * 仅在非 compat（原生 Claude 端点）下实际发送——第三方兼容端点不认识该字段。
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** 运行时校验用（CLI 解析 AGENT_EFFORT 等外部输入时使用） */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export interface ModelRequest {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  maxTokens: number;
  effort: Effort;
}

/** 归一化后的一次模型往返 */
export interface ModelTurn {
  message: Anthropic.Message;
  stopReason: Anthropic.Message["stop_reason"];
  usage: Anthropic.Usage;
}

export interface ModelClient {
  /** 一律流式发送；text delta 通过 onDelta 旁路（仅供渲染），控制流只依赖最终 ModelTurn */
  send(req: ModelRequest, onDelta?: (text: string) => void): Promise<ModelTurn>;
}

// ---------------------------------------------------------------- L1: 循环与事件

export interface AgentConfig {
  /** 默认 "claude-opus-4-8" */
  model?: string;
  /** 冻结；禁止含时间戳等易变内容 */
  systemPrompt: string;
  tools: Tool[];
  /** 默认 "high" */
  effort?: Effort;
  /** 默认 64000（流式） */
  maxTokens?: number;
  /** 默认 50，硬护栏 */
  maxTurns?: number;
  /** 可选：整个 run 的累计 token 上限（input+cacheCreation+cacheRead+output） */
  maxTokensBudget?: number;
  workdir: string;
  /** 额外只读根（见 ToolContext.readRoots）。CLI 经 AGENT_READ_ROOTS 注入 */
  readRoots?: string[];
  /**
   * 第三方 Anthropic 兼容端点模式（DeepSeek/GLM/Kimi 等）：
   * 去掉 Claude 专属参数（adaptive thinking / output_config.effort / cache_control）。
   * 缺省时由宿主按模型名推断（非 claude-* 即 true）。
   */
  compat?: boolean;
  /** 上下文 token 上限（触发 compact 的依据，按上一轮实际输入衡量）。默认 150_000 */
  contextTokenLimit?: number;
  /**
   * loop 层对瞬时 API 错误（网络/超时/429/5xx）的同轮重试次数，默认 1。
   * 与 SDK 内置的 HTTP 重试是两层：SDK 耗尽后 loop 再兜一次，避免整个 run 因
   * 一次抖动作废（A/B 实测：基建错误占 hard 套件失败的 1/3）。设 0 关闭。
   */
  errorRetries?: number;
  /** 重试退避基数毫秒（第 n 次重试等 n×此值）。默认 1500；测试可设 0 */
  errorRetryBackoffMs?: number;
  /** 动态上下文（时间/环境等易变信息）：注入首条 user 消息，绝不进 system（P3） */
  dynamicContext?: Record<string, string>;
}

export interface AggregateUsage {
  /** 未缓存部分 */
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  turns: number;
  /** cacheRead / (input + cacheCreation + cacheRead)，无输入时为 0 */
  cacheHitRatio: number;
}

export interface AgentRunResult {
  /**
   * completed = end_turn 正常结束；max_tokens = 末轮输出撞单次上限被截断
   * （非错误：已生成内容保留在 messages 中，提高 maxTokens 可让其写完）；
   * 其余为护栏/拒绝/宿主错误。
   */
  stopReason: "completed" | "max_tokens" | "max_turns" | "budget_exhausted" | "refusal" | "error";
  /** 完整会话历史（SDK 类型），可用于持久化或子代理接力 */
  messages: Anthropic.MessageParam[];
  usage: AggregateUsage;
  /** stopReason = "error" 时的宿主级错误；工具错误不会出现在这里 */
  error?: Error;
}

/** loop 对外发射的结构化事件——日志、UI、审批门都是它的消费者 */
export type TurnEvent =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; text: string }
  | { type: "assistant_text"; text: string }
  | { type: "tool_call"; toolUseId: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; result: ToolResult; durationMs: number }
  | {
      type: "approval_request";
      toolUseId: string;
      name: string;
      input: unknown;
      /** 宿主必须调用 respond 才能让 loop 继续；deny 时可附给模型的理由 */
      respond: (decision: "allow" | "deny", reason?: string) => void;
    }
  | { type: "usage"; turn: number; usage: Anthropic.Usage }
  | { type: "compaction"; droppedBlocks: number }
  /** backoffMs = 本次实际等待毫秒（含抖动）——不带它宿主就看不出重试到底等了多久 */
  | { type: "api_retry"; turn: number; attempt: number; reason: string; backoffMs: number }
  /**
   * 段级续跑（9.8）：整段因**瞬时**宿主级错误终止后，带着已有正史再续一次，
   * 而不是把整段工作作废。与 api_retry 是两回事——那个是同一轮内重发同一个请求，
   * 这个是一整段已经死了、靠正史接着往下走。
   * 必须显式发出来：否则宿主会看到一个 `done(error)` 之后又冒出一堆事件，
   * 完全读不懂（V-01 那条「段终止 ≠ run 终止」的同族）。
   */
  | { type: "segment_resume"; attempt: number; reason: string; priorTurns: number }
  | { type: "done"; result: AgentRunResult };

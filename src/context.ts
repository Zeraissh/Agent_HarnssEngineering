/**
 * L3 — ContextManager：模型每次看到什么。
 * 决策（docs/02）：system 冻结；两个缓存断点（system 尾块 + 最近一条消息尾块）；
 * v0.2 的 compact() 为空实现（策略接口位）。
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Effort, ModelRequest } from "./types.js";

/** 可携带 cache_control 的 content 块类型（thinking 块不可缓存标记） */
const CACHEABLE_TYPES = new Set(["text", "image", "tool_use", "tool_result", "document"]);

export interface ContextConfig {
  systemPrompt: string;
  maxTokens: number;
  effort: Effort;
  /** false = 不打 cache_control 标记（第三方兼容端点可能不支持）。默认 true */
  cacheBreakpoints?: boolean;
  /** 上下文 token 上限（近似值，按上一轮实际输入衡量）。默认 150_000 */
  contextTokenLimit?: number;
  /** 压缩时保护最近 N 条消息不动。默认 6 */
  protectRecent?: number;
  /** 从持久化检查点恢复时的上一轮实际输入水位；缺省 0（全新会话） */
  initialInputTokens?: number;
}

export interface CompactResult {
  messages: Anthropic.MessageParam[];
  /** 本次被置换为占位文本的 tool_result 块数量；0 = 未压缩 */
  droppedBlocks: number;
}

/** 触发压缩的水位：上一轮实际输入超过上限的 80% */
const COMPACT_WATERMARK = 0.8;
/** 小于该字符数的 tool_result 不值得压缩 */
const MIN_COMPACTABLE_CHARS = 500;

export class DefaultContextManager {
  readonly systemPrompt: string;
  private readonly maxTokens: number;
  private readonly effort: Effort;
  private readonly cacheBreakpoints: boolean;
  private readonly contextTokenLimit: number;
  private readonly protectRecent: number;
  /** 上一轮的实际输入规模（input + cacheW + cacheR），是"上下文有多大"的唯一可靠信号 */
  private lastInputTokens = 0;

  constructor(cfg: ContextConfig) {
    // 构造时冻结（P3）：此后任何路径都不得修改 system prompt
    this.systemPrompt = cfg.systemPrompt;
    this.maxTokens = cfg.maxTokens;
    this.effort = cfg.effort;
    this.cacheBreakpoints = cfg.cacheBreakpoints ?? true;
    this.contextTokenLimit = cfg.contextTokenLimit ?? 150_000;
    this.protectRecent = cfg.protectRecent ?? 6;
    this.lastInputTokens = Math.max(0, Math.floor(cfg.initialInputTokens ?? 0));
  }

  /** loop 每轮调用，喂入实际 usage —— compact 的触发依据 */
  noteUsage(usage: Anthropic.Usage): void {
    this.lastInputTokens =
      usage.input_tokens +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0);
  }

  /** 持久化检查点只需要这个水位，不暴露其余内部策略状态。 */
  checkpointInputTokens(): number {
    return this.lastInputTokens;
  }

  /**
   * 组装一次请求。断点策略：
   *  ① system 尾块（连同前面的 tools 一起缓存）
   *  ② 最近一条消息的最后一个可缓存块（会话增量缓存）
   * 不原地修改传入的 messages。
   */
  render(messages: Anthropic.MessageParam[], tools: Anthropic.Tool[]): ModelRequest {
    if (!this.cacheBreakpoints) {
      return {
        system: [{ type: "text", text: this.systemPrompt }],
        messages: [...messages],
        tools,
        maxTokens: this.maxTokens,
        effort: this.effort,
      };
    }

    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: this.systemPrompt, cache_control: { type: "ephemeral" } },
    ];

    const rendered = messages.map((m, i) =>
      i === messages.length - 1 ? withTrailingCacheMark(m) : m,
    );

    return { system, messages: rendered, tools, maxTokens: this.maxTokens, effort: this.effort };
  }

  /**
   * v0.3 压缩策略：上一轮输入超过水位线时，把"保护窗口之外"的大体积
   * tool_result 内容替换为占位文本。结构保持不变（每个 tool_use_id 仍有
   * 对应 tool_result），只有内容被置换 —— 不会破坏 API 约束。
   *
   * 注意：loop 会用返回值**替换**正史（而非仅用于本次渲染）——压缩只发生一次、
   * 结果确定，后续请求前缀保持稳定，避免每轮重压缩导致的缓存抖动。
   */
  compact(messages: Anthropic.MessageParam[]): CompactResult {
    if (this.lastInputTokens < this.contextTokenLimit * COMPACT_WATERMARK) {
      return { messages: [...messages], droppedBlocks: 0 };
    }

    let dropped = 0;
    const cutoff = Math.max(0, messages.length - this.protectRecent);
    const out = messages.map((m, i) => {
      if (i >= cutoff || typeof m.content === "string") return m;
      let touched = false;
      const blocks = m.content.map((b) => {
        if (
          b.type === "tool_result" &&
          typeof b.content === "string" &&
          b.content.length > MIN_COMPACTABLE_CHARS &&
          !b.content.startsWith("[compacted]")
        ) {
          touched = true;
          dropped += 1;
          return {
            ...b,
            content: `[compacted] tool result elided to save context (${b.content.length} chars). Re-run the tool if you need this data again.`,
          };
        }
        return b;
      });
      return touched ? { ...m, content: blocks } : m;
    });

    return { messages: out, droppedBlocks: dropped };
  }
}

/**
 * 动态上下文注入规范（P3）：易变信息（时间、环境）以独立 text 块进 messages，
 * 绝不写进 system prompt —— system 变一个字节，其后缓存全灭。
 * 注入点在首条 user 消息，run 期间保持不变，因此 messages 前缀依然稳定。
 */
export function userMessageWithContext(
  userInput: string,
  context: Record<string, string>,
): Anthropic.MessageParam {
  const lines = Object.entries(context)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return {
    role: "user",
    content: [
      { type: "text", text: `<context>\n${lines}\n</context>` },
      { type: "text", text: userInput },
    ],
  };
}

/** 在消息的最后一个可缓存块上打 cache_control 标记（浅拷贝，不动原对象） */
function withTrailingCacheMark(m: Anthropic.MessageParam): Anthropic.MessageParam {
  if (typeof m.content === "string") {
    return {
      ...m,
      content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }],
    };
  }
  const blocks = [...m.content];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (CACHEABLE_TYPES.has(block.type)) {
      blocks[i] = { ...block, cache_control: { type: "ephemeral" } } as typeof block;
      break;
    }
  }
  return { ...m, content: blocks };
}

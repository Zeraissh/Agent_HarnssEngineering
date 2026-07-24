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
}

export class DefaultContextManager {
  readonly systemPrompt: string;
  private readonly maxTokens: number;
  private readonly effort: Effort;
  private readonly cacheBreakpoints: boolean;

  constructor(cfg: ContextConfig) {
    // 构造时冻结（P3）：此后任何路径都不得修改 system prompt
    this.systemPrompt = cfg.systemPrompt;
    this.maxTokens = cfg.maxTokens;
    this.effort = cfg.effort;
    this.cacheBreakpoints = cfg.cacheBreakpoints ?? true;
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
   * 窗口逼近时的压缩策略位。v0.2 = 直通（不压缩）；
   * v0.3 实现"截断最老的大体积 tool_result"，后续可切 server-side compaction。
   * 约定：返回新数组，不原地修改。
   */
  compact(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    return [...messages];
  }
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

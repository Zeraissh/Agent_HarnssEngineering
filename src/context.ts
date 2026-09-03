/**
 * L3 — ContextManager：模型每次看到什么。
 * 决策（docs/02）：system 冻结；两个缓存断点（system 尾块 + 最近一条消息尾块）；
 * v0.3 起 compact() 为真实实现；MEM-01 起 elision 附带结构化 semantic ledger；
 * Phase B 可选 LLM 摘要经 compactAsync 合并进账本（默认关、fail-open）。
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Effort, ModelClient, ModelRequest } from "./types.js";
import {
  COMPACT_LEDGER_MARKER,
  type CompactLedger,
  type ToolUseRef,
  emptyCompactLedger,
  extractConstraintsFromText,
  extractDecisionsFromText,
  extractEvidenceFromText,
  extractFromToolExchange,
  formatCompactLedger,
  formatSemanticPlaceholder,
  ledgerEntryCount,
  mergeCompactLedgers,
  parseCompactLedgerText,
} from "./compact-ledger.js";
import {
  DEFAULT_COMPACT_SUMMARY_MAX_TOKENS,
  collectCompactExcerpts,
  mergeSummaryIntoLedger,
  summarizeForCompact,
} from "./compact-summary.js";

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
  /**
   * MEM-01 Phase B：可选摘要 ModelClient。缺省 / 未注入 = 只走 Phase A 启发式。
   * 不经 ToolContext——与 describe_image 同款装配纪律。
   */
  summaryClient?: ModelClient;
  /** Phase B 摘要 max_tokens 上限；默认 512 */
  summaryMaxTokens?: number;
}

export interface CompactResult {
  messages: Anthropic.MessageParam[];
  /** 本次被置换为占位文本的 tool_result 块数量；0 = 未压缩 */
  droppedBlocks: number;
  /** MEM-01：压缩后账本中的事实条数（含既有 + 新提取） */
  ledgerEntries: number;
  /** MEM-01：本次写入正史的结构化账本；未压缩时为空账本 */
  ledger: CompactLedger;
  /** Phase B：本次是否成功合并了 LLM 摘要（失败/未配置均为 false） */
  summaryApplied?: boolean;
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
  private readonly summaryClient: ModelClient | undefined;
  private readonly summaryMaxTokens: number;
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
    this.summaryClient = cfg.summaryClient;
    this.summaryMaxTokens = cfg.summaryMaxTokens ?? DEFAULT_COMPACT_SUMMARY_MAX_TOKENS;
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
   * Phase A 同步压缩：语义占位 + 启发式 `[compact_ledger]`。
   * Phase B 走 {@link compactAsync}（可选 LLM，fail-open）。
   */
  compact(messages: Anthropic.MessageParam[]): CompactResult {
    const empty = emptyCompactLedger();
    if (this.lastInputTokens < this.contextTokenLimit * COMPACT_WATERMARK) {
      return {
        messages: [...messages],
        droppedBlocks: 0,
        ledgerEntries: 0,
        ledger: empty,
        summaryApplied: false,
      };
    }

    const cutoff = Math.max(0, messages.length - this.protectRecent);
    const toolUses = indexToolUses(messages);
    const priorLedger = findExistingLedger(messages);
    const scanned = scanConversationLedger(messages, cutoff, toolUses);

    let dropped = 0;
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
          const tool = toolUses.get(b.tool_use_id);
          const local = extractFromToolExchange(tool, b.content, b.is_error === true);
          return {
            ...b,
            content: formatSemanticPlaceholder({
              originalChars: b.content.length,
              toolName: tool?.name,
              local,
            }),
          };
        }
        return b;
      });
      return touched ? { ...m, content: blocks } : m;
    });

    if (dropped === 0) {
      return {
        messages: out,
        droppedBlocks: 0,
        ledgerEntries: 0,
        ledger: empty,
        summaryApplied: false,
      };
    }

    const ledger = mergeCompactLedgers(priorLedger, scanned);
    const withLedger = upsertCompactLedger(out, ledger);
    return {
      messages: withLedger,
      droppedBlocks: dropped,
      ledgerEntries: ledgerEntryCount(ledger),
      ledger,
      summaryApplied: false,
    };
  }

  /**
   * Phase A + optional Phase B. Summary only runs when a client is injected
   * and Phase A actually elided blocks. Any summary failure → Phase A result.
   */
  async compactAsync(
    messages: Anthropic.MessageParam[],
    signal?: AbortSignal,
  ): Promise<CompactResult> {
    const base = this.compact(messages);
    if (!this.summaryClient || base.droppedBlocks === 0) return base;
    if (signal?.aborted) return base;

    const cutoff = Math.max(0, messages.length - this.protectRecent);
    const excerpts = collectCompactExcerpts(gatherExcerptTexts(messages, cutoff));
    try {
      const enrichment = await summarizeForCompact({
        client: this.summaryClient,
        ledger: base.ledger,
        excerpts,
        maxTokens: this.summaryMaxTokens,
        signal,
      });
      if (!enrichment) return base;
      const ledger = mergeSummaryIntoLedger(base.ledger, enrichment);
      // Never lose Phase A buckets.
      if (ledgerEntryCount(ledger) < ledgerEntryCount(base.ledger)) return base;
      return {
        messages: upsertCompactLedger(base.messages, ledger),
        droppedBlocks: base.droppedBlocks,
        ledgerEntries: ledgerEntryCount(ledger),
        ledger,
        summaryApplied: true,
      };
    } catch {
      return base;
    }
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

function indexToolUses(messages: Anthropic.MessageParam[]): Map<string, ToolUseRef> {
  const map = new Map<string, ToolUseRef>();
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_use") {
        map.set(b.id, { name: b.name, input: b.input });
      }
    }
  }
  return map;
}

function findExistingLedger(messages: Anthropic.MessageParam[]): CompactLedger {
  let found = emptyCompactLedger();
  for (const m of messages) {
    for (const text of messageTexts(m)) {
      if (text.includes(COMPACT_LEDGER_MARKER)) {
        found = mergeCompactLedgers(found, parseCompactLedgerText(text));
      }
    }
  }
  return found;
}

/**
 * Scan the unprotected prefix for durable facts. Skip already-compacted
 * placeholders and existing ledger blocks (those are merged via findExistingLedger).
 */
function scanConversationLedger(
  messages: Anthropic.MessageParam[],
  cutoff: number,
  toolUses: Map<string, ToolUseRef>,
): CompactLedger {
  const parts: CompactLedger[] = [];
  for (let i = 0; i < cutoff; i++) {
    const m = messages[i]!;
    if (m.role === "user") {
      for (const text of messageTexts(m)) {
        if (text.includes(COMPACT_LEDGER_MARKER) || text.startsWith("[compacted]")) continue;
        const constraints = extractConstraintsFromText(text);
        const evidence = extractEvidenceFromText(text);
        if (constraints.length || evidence.length) {
          parts.push({
            ...emptyCompactLedger(),
            constraints,
            evidence,
          });
        }
      }
      if (typeof m.content !== "string") {
        for (const b of m.content) {
          if (b.type !== "tool_result" || typeof b.content !== "string") continue;
          if (b.content.startsWith("[compacted]")) continue;
          // Only harvest large results we are about to elide — small ones stay verbatim.
          if (b.content.length <= MIN_COMPACTABLE_CHARS) continue;
          parts.push(extractFromToolExchange(toolUses.get(b.tool_use_id), b.content, b.is_error === true));
        }
      }
    } else if (m.role === "assistant") {
      for (const text of messageTexts(m)) {
        const decisions = extractDecisionsFromText(text);
        if (decisions.length) {
          parts.push({ ...emptyCompactLedger(), decisions });
        }
      }
    }
  }
  return mergeCompactLedgers(...parts);
}

function gatherExcerptTexts(
  messages: Anthropic.MessageParam[],
  cutoff: number,
): { role: "user" | "assistant"; text: string }[] {
  const out: { role: "user" | "assistant"; text: string }[] = [];
  for (let i = 0; i < cutoff; i++) {
    const m = messages[i]!;
    const role = m.role === "assistant" ? "assistant" : "user";
    for (const text of messageTexts(m)) {
      out.push({ role, text });
    }
    // Prefer head of large tool_results (full body is about to be elided).
    if (role === "user" && typeof m.content !== "string") {
      for (const b of m.content) {
        if (b.type !== "tool_result" || typeof b.content !== "string") continue;
        if (b.content.startsWith("[compacted]")) continue;
        if (b.content.length <= MIN_COMPACTABLE_CHARS) continue;
        out.push({ role: "user", text: b.content.slice(0, 800) });
      }
    }
  }
  return out;
}

function messageTexts(m: Anthropic.MessageParam): string[] {
  if (typeof m.content === "string") return [m.content];
  const out: string[] = [];
  for (const b of m.content) {
    if (b.type === "text" && typeof b.text === "string") out.push(b.text);
  }
  return out;
}

/**
 * Upsert a single durable ledger text block. Prefer rewriting an existing
 * marker in place (prefix shape stable across re-compacts); otherwise insert
 * a dedicated user message at the front (protectRecent is end-relative).
 */
function upsertCompactLedger(
  messages: Anthropic.MessageParam[],
  ledger: CompactLedger,
): Anthropic.MessageParam[] {
  const text = formatCompactLedger(ledger);
  const out = messages.map((m) => {
    if (typeof m.content === "string") {
      if (!m.content.includes(COMPACT_LEDGER_MARKER)) return m;
      return { ...m, content: text };
    }
    let touched = false;
    const blocks = m.content.map((b) => {
      if (b.type === "text" && typeof b.text === "string" && b.text.includes(COMPACT_LEDGER_MARKER)) {
        touched = true;
        return { ...b, text };
      }
      return b;
    });
    return touched ? { ...m, content: blocks } : m;
  });

  const already = out.some((m) =>
    messageTexts(m).some((t) => t.includes(COMPACT_LEDGER_MARKER)),
  );
  if (already) return out;

  return [{ role: "user", content: [{ type: "text", text }] }, ...out];
}

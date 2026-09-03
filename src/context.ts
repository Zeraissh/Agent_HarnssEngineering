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
  countLines,
  emptyCompactLedger,
  excerptToolResult,
  extractConstraintsFromText,
  extractDecisionsFromText,
  extractEvidenceFromText,
  extractFromToolExchange,
  formatCompactLedger,
  formatSemanticPlaceholder,
  ledgerEntryCount,
  mergeCompactLedgers,
  parseCompactLedgerText,
  parseSemanticPlaceholderExcerpt,
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
  /** 本次被置换为占位文本的 tool_result 块数量（tier 1）；0 = 未置换 */
  droppedBlocks: number;
  /** MEM-01：压缩后账本中的事实条数（含既有 + 新提取） */
  ledgerEntries: number;
  /** MEM-01：本次写入正史的结构化账本；未压缩时为空账本 */
  ledger: CompactLedger;
  /** Phase B：本次是否成功合并了 LLM 摘要（失败/未配置均为 false） */
  summaryApplied?: boolean;
  /**
   * tier 2（MEM-01 Phase C）：本次新折叠进 `[compacted_turns]` 块的 assistant 轮数。
   * 0 = 未折叠（tier 1 够用、或保护窗外已无可折叠的旧轮）。
   */
  collapsedTurns: number;
  /** 本次是否改动了正史（droppedBlocks > 0 或 collapsedTurns > 0）。loop 据此决定要不要替换正史与发事件 */
  changed: boolean;
}

/**
 * 压缩选项。缺省 = 常规路径（按水位判定、保护窗 = 构造参数）。
 * `force` 是反应式硬压缩（loop 撞上端点的 context-too-long 400 时）：忽略水位，
 * tier 1 + tier 2 一起上；通常配 `protectRecent: REACTIVE_PROTECT_RECENT`。
 */
export interface CompactOptions {
  force?: boolean;
  protectRecent?: number;
}

/** 触发压缩的水位：上一轮实际输入超过上限的 80% */
const COMPACT_WATERMARK = 0.8;
/** 小于该字符数的 tool_result 不值得压缩 */
const MIN_COMPACTABLE_CHARS = 500;
/**
 * tier 2 折叠块的标记。以它开头的 user 文本块 = 早先轮次的摘要，再次压缩时只会
 * 被**合并**（新老出保护窗的轮追加进同一块），不会被二次折叠——这是幂等的来源。
 */
export const COMPACTED_TURNS_MARKER = "[compacted_turns]";
/**
 * 反应式压缩的保护窗：端点已经明说"装不下"，常规的 6 条（3 轮）保护窗此时是奢侈品；
 * 收到 2 = 只保最近一轮 assistant + 它的 tool_result（模型接着往下走至少要看见这个）。
 */
export const REACTIVE_PROTECT_RECENT = 2;
/**
 * tier 1 节省量的 token 估算系数（字符/token）。只用于判断"置换之后估计还在水位上吗"
 * ——真实水位下一轮 noteUsage 才知道；估得偏保守（英文约 4、中文更低）即可，
 * 错判的代价只是多折叠一轮旧对话。
 */
const CHARS_PER_TOKEN_ESTIMATE = 4;
/** 折叠块里每条摘要行的字符上限 */
const COLLAPSE_LINE_CHARS = 160;

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
   * 同步压缩：分级流水线，便宜的先上。
   *
   *  tier 1（Phase A）：保护窗外的大 tool_result 置换为语义占位 + 启发式 `[compact_ledger]`；
   *  tier 2（Phase C）：tier 1 之后**估计**仍在水位上（或根本没有可置换的块）时，把保护窗外、
   *    首条任务消息之后的旧轮（assistant 正文 + tool_use 摘要 + 结果首行 + user 文本）折叠成
   *    一个 `[compacted_turns]` 摘要块。tool_use / tool_result 配对永不拆散：保护窗起点若是
   *    tool_result，其 tool_use 所在的 assistant 一并保留。确定性、幂等（同一输入二次调用
   *    不再改动——折叠块只合并不二折）。
   *
   * 为什么 tier 2 不能省（MEM-01 残余）：tier 1 只碰 tool_result；长 assistant 推理、
   * 控制消息、已置换过的占位符本身都在"永不缩小"的集合里，几十轮之后 tier 1 一个块都
   * 置换不出来而水位还在涨——此前的结局是端点 400 → `finish("error")`。
   *
   * Phase B（可选 LLM 摘要进账本）走 {@link compactAsync}。
   */
  compact(messages: Anthropic.MessageParam[], opts: CompactOptions = {}): CompactResult {
    const empty = emptyCompactLedger();
    const force = opts.force === true;
    const protectRecent = Math.max(0, Math.floor(opts.protectRecent ?? this.protectRecent));
    const unchanged = (msgs: Anthropic.MessageParam[]): CompactResult => ({
      messages: msgs,
      droppedBlocks: 0,
      ledgerEntries: 0,
      ledger: empty,
      summaryApplied: false,
      collapsedTurns: 0,
      changed: false,
    });
    if (!force && this.lastInputTokens < this.contextTokenLimit * COMPACT_WATERMARK) {
      return unchanged([...messages]);
    }

    const cutoff = Math.max(0, messages.length - protectRecent);
    const toolUses = indexToolUses(messages);
    const priorLedger = findExistingLedger(messages);
    const scanned = scanConversationLedger(messages, cutoff, toolUses);

    // ---- tier 1：大 tool_result → 语义占位 ----
    let dropped = 0;
    let savedChars = 0;
    let out = messages.map((m, i) => {
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
          // 占位符带原文首行摘录："这次读到了什么"不该只能靠重跑工具找回
          const placeholder = formatSemanticPlaceholder({
            originalChars: b.content.length,
            originalLines: countLines(b.content),
            toolName: tool?.name,
            excerpt: excerptToolResult(b.content, b.is_error === true),
            local,
          });
          savedChars += Math.max(0, b.content.length - placeholder.length);
          return { ...b, content: placeholder };
        }
        return b;
      });
      return touched ? { ...m, content: blocks } : m;
    });

    // ---- tier 2：置换之后估计仍在水位上（或无可置换）→ 折叠旧轮 ----
    const estimatedAfter = this.lastInputTokens - savedChars / CHARS_PER_TOKEN_ESTIMATE;
    const needTier2 =
      force || dropped === 0 || estimatedAfter >= this.contextTokenLimit * COMPACT_WATERMARK;
    let collapsedTurns = 0;
    let collapsedLedger = emptyCompactLedger();
    if (needTier2) {
      const folded = collapseOldTurns(out, cutoff, toolUses);
      out = folded.messages;
      collapsedTurns = folded.collapsedTurns;
      collapsedLedger = folded.ledger;
    }

    if (dropped === 0 && collapsedTurns === 0) return unchanged(out);

    const ledger = mergeCompactLedgers(priorLedger, scanned, collapsedLedger);
    const withLedger = upsertCompactLedger(out, ledger);
    return {
      messages: withLedger,
      droppedBlocks: dropped,
      ledgerEntries: ledgerEntryCount(ledger),
      ledger,
      summaryApplied: false,
      collapsedTurns,
      changed: true,
    };
  }

  /**
   * Phase A(+C) + optional Phase B. Summary only runs when a client is injected
   * and the sync pass actually changed history. Any summary failure → sync result.
   */
  async compactAsync(
    messages: Anthropic.MessageParam[],
    signal?: AbortSignal,
    opts: CompactOptions = {},
  ): Promise<CompactResult> {
    const base = this.compact(messages, opts);
    if (!this.summaryClient || !base.changed) return base;
    if (signal?.aborted) return base;

    const protectRecent = Math.max(0, Math.floor(opts.protectRecent ?? this.protectRecent));
    const cutoff = Math.max(0, messages.length - protectRecent);
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
        ...base,
        messages: upsertCompactLedger(base.messages, ledger),
        ledgerEntries: ledgerEntryCount(ledger),
        ledger,
        summaryApplied: true,
      };
    } catch {
      return base;
    }
  }
}

// ---------------------------------------------------------------- tier 2：折叠旧轮

/**
 * 把 `[start, end)` 的旧轮折叠成一个 `[compacted_turns]` user 文本块。
 *
 * 区间由三条规则确定，缺一条就会产出端点拒收的正史：
 *  ① 起点 = 首条**任务** user 消息之后（账本消息不算任务；任务原文永不折叠）；
 *  ② 终点 = 保护窗起点；若保护窗首条是 tool_result，其 tool_use 所在的 assistant
 *     一并保留（终点前移一格）——否则保护窗里会出现没有 tool_use 的 tool_result；
 *  ③ 区间开头若已是折叠块，取出其摘要行**合并**进新块（幂等：只有它一个时无事发生）。
 *
 * 折叠同时把区间里**所有** tool_result（含 tier 1 不碰的小结果）过一遍账本抽取——
 * 它们从正史里消失了，"小结果保留原文"这条 tier 1 的前提不再成立。
 */
function collapseOldTurns(
  messages: Anthropic.MessageParam[],
  cutoff: number,
  toolUses: Map<string, ToolUseRef>,
): { messages: Anthropic.MessageParam[]; collapsedTurns: number; ledger: CompactLedger } {
  const none = { messages, collapsedTurns: 0, ledger: emptyCompactLedger() };
  const taskIndex = messages.findIndex((m) => m.role === "user" && !isLedgerMessage(m));
  if (taskIndex < 0) return none;
  const start = taskIndex + 1;
  let end = Math.min(cutoff, messages.length);
  while (end > start && end < messages.length && isToolResultMessage(messages[end]!)) end -= 1;
  if (end <= start) return none;

  const region = messages.slice(start, end);
  const prior = isCollapsedTurnsMessage(region[0]!) ? parseCollapsedTurns(region[0]!) : null;
  const fresh = prior ? region.slice(1) : region;
  // 区间里除了既有折叠块什么都没有 → 幂等出口；账本消息混在区间里也不算新内容
  const foldable = fresh.filter((m) => !isLedgerMessage(m));
  if (foldable.length === 0) return none;

  const lines: string[] = prior ? [...prior.lines] : [];
  let turns = prior?.turns ?? 0;
  let chars = prior?.chars ?? 0;
  const ledgerParts: CompactLedger[] = [];
  for (const m of foldable) {
    chars += messageChars(m);
    if (m.role === "assistant") {
      turns += 1;
      lines.push(describeAssistantMessage(m));
      continue;
    }
    if (typeof m.content === "string") {
      lines.push(`- user: ${clipLine(m.content)}`);
      continue;
    }
    const results: string[] = [];
    const texts: string[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result" && typeof b.content === "string") {
        const tool = toolUses.get(b.tool_use_id);
        ledgerParts.push(extractFromToolExchange(tool, b.content, b.is_error === true));
        // 已置换的块复用占位符里的摘录；只有本版之前写下的占位符（没有摘录行）才退回 "(elided)"
        const head = b.content.startsWith("[compacted]")
          ? (parseSemanticPlaceholderExcerpt(b.content) ?? "(elided)")
          : excerptToolResult(b.content, b.is_error === true);
        results.push(`${b.is_error ? "✗" : "✓"} ${tool?.name ?? "tool"}: ${head}`);
      } else if (b.type === "text") {
        texts.push(clipLine(b.text));
      }
    }
    if (results.length) lines.push(`  results: ${results.join("; ")}`);
    for (const t of texts) lines.push(`- user: ${t}`);
  }

  const kept = messages.filter((m, i) => i >= start && i < end && isLedgerMessage(m));
  const block: Anthropic.MessageParam = {
    role: "user",
    content: [{ type: "text", text: formatCollapsedTurns(turns, chars, lines) }],
  };
  return {
    messages: [...messages.slice(0, start), ...kept, block, ...messages.slice(end)],
    collapsedTurns: turns - (prior?.turns ?? 0),
    ledger: mergeCompactLedgers(...ledgerParts),
  };
}

/**
 * 折叠块正文。**头部不得出现 `[compact_ledger]` 字面量**：账本的 upsert / 识别都是按
 * "文本含该标记"判的，写进去这个块就会被当成账本改写掉（首版实测：块被账本覆盖、
 * 正史里出现两份账本、被折叠的轮凭空消失）。
 */
function formatCollapsedTurns(turns: number, chars: number, lines: string[]): string {
  return [
    `${COMPACTED_TURNS_MARKER} ${turns} earlier turns collapsed (was ${chars} chars). ` +
      "Durable facts are kept in the compact ledger block; re-run a tool if you need its exact output.",
    ...lines,
  ].join("\n");
}

function parseCollapsedTurns(m: Anthropic.MessageParam): { turns: number; chars: number; lines: string[] } {
  const text = messageTexts(m).find((t) => t.startsWith(COMPACTED_TURNS_MARKER)) ?? "";
  const [header = "", ...lines] = text.split("\n");
  const turns = Number(/(\d+) earlier turns/.exec(header)?.[1] ?? 0);
  const chars = Number(/was (\d+) chars/.exec(header)?.[1] ?? 0);
  return { turns: Number.isFinite(turns) ? turns : 0, chars: Number.isFinite(chars) ? chars : 0, lines };
}

function describeAssistantMessage(m: Anthropic.MessageParam): string {
  if (typeof m.content === "string") return `- assistant: ${clipLine(m.content)}`;
  const text = m.content
    .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join(" ");
  const tools = m.content
    .filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use")
    .map((b) => describeToolUse(b.name, b.input));
  const head = text.trim() ? clipLine(text) : "(no text)";
  return `- assistant: ${head}${tools.length ? ` | tools: ${tools.join("; ")}` : ""}`;
}

function describeToolUse(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return `${name}()`;
  const obj = input as Record<string, unknown>;
  for (const key of ["command", "path", "elf_path", "file", "url", "address"]) {
    if (typeof obj[key] === "string" && (obj[key] as string).trim()) {
      return `${name}(${key}=${clipLine(String(obj[key]), 80)})`;
    }
  }
  return `${name}(${clipLine(JSON.stringify(obj), 60)})`;
}

function isLedgerMessage(m: Anthropic.MessageParam): boolean {
  return messageTexts(m).some((t) => t.includes(COMPACT_LEDGER_MARKER));
}

function isCollapsedTurnsMessage(m: Anthropic.MessageParam): boolean {
  return m.role === "user" && messageTexts(m).some((t) => t.startsWith(COMPACTED_TURNS_MARKER));
}

function isToolResultMessage(m: Anthropic.MessageParam): boolean {
  return (
    m.role === "user" &&
    typeof m.content !== "string" &&
    m.content.some((b) => b.type === "tool_result")
  );
}

function messageChars(m: Anthropic.MessageParam): number {
  if (typeof m.content === "string") return m.content.length;
  let n = 0;
  for (const b of m.content) {
    if (b.type === "text") n += b.text.length;
    else if (b.type === "tool_result" && typeof b.content === "string") n += b.content.length;
    else if (b.type === "tool_use") n += JSON.stringify(b.input ?? {}).length + b.name.length;
  }
  return n;
}

function clipLine(s: string, max = COLLAPSE_LINE_CHARS): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
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

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
 * 保护窗外 image 块降级后的文本标记。界面附件缩略图不走这条路——回收的是模型正史。
 * 形状：`[compacted_image] path=…`，扫到 describe_image / view_image 回执再追加 `summary:` 行。
 */
export const COMPACTED_IMAGE_MARKER = "[compacted_image]";
/** 纪要摘要行上限（空白折叠后）；路径本身另有独立上限 */
const IMAGE_SUMMARY_MAX_CHARS = 200;
const IMAGE_PATH_MAX_CHARS = 120;
const UNKNOWN_IMAGE_PATH = "(unknown)";
const IMAGE_SUMMARY_TOOLS = new Set(["describe_image", "view_image"]);
/**
 * 反应式压缩的保护窗：端点已经明说"装不下"，常规的 6 条（3 轮）保护窗此时是奢侈品；
 * 收到 2 = 只保最近一轮 assistant + 它的 tool_result（模型接着往下走至少要看见这个）。
 */
export const REACTIVE_PROTECT_RECENT = 2;
/**
 * tier 1 节省量的 token 估算系数（字符/token）。只用于判断"置换之后估计还在水位上吗"
 * ——真实水位下一轮 noteUsage 才知道；估得偏保守（英文约 4、中文更低）即可，
 * 错判的代价只是多折叠一轮旧对话。上下文分项估算复用同一系数。
 */
export const CHARS_PER_TOKEN_ESTIMATE = 4;
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
  /** 上一轮窗口占用（input + cacheW + cacheR）：模型实际看见多少。给 UI / 检查点。 */
  private lastInputTokens = 0;
  /**
   * 上一轮相对预算的压缩判据（input + cacheW，**不含 cache_read**）。
   * 谱系预算 `turnTokenCost` 已经这样计：cache_read 是重读已缓存前缀，长对话
   * 每一轮都接近窗口；拿它去撞默认 150k 预算，缓存一热就每轮压缩，前缀拆掉
   * 反而更贵。窗口真装不下仍走反应式 400。
   */
  private lastCompactTokens = 0;

  constructor(cfg: ContextConfig) {
    // 构造时冻结（P3）：此后任何路径都不得修改 system prompt
    this.systemPrompt = cfg.systemPrompt;
    this.maxTokens = cfg.maxTokens;
    this.effort = cfg.effort;
    this.cacheBreakpoints = cfg.cacheBreakpoints ?? true;
    this.contextTokenLimit = cfg.contextTokenLimit ?? 150_000;
    this.protectRecent = cfg.protectRecent ?? 6;
    this.lastInputTokens = Math.max(0, Math.floor(cfg.initialInputTokens ?? 0));
    this.lastCompactTokens = this.lastInputTokens;
    this.summaryClient = cfg.summaryClient;
    this.summaryMaxTokens = cfg.summaryMaxTokens ?? DEFAULT_COMPACT_SUMMARY_MAX_TOKENS;
  }

  /** loop 每轮调用，喂入实际 usage —— compact 的触发依据 */
  noteUsage(usage: Anthropic.Usage): void {
    const input = Math.max(0, usage.input_tokens);
    const cacheW = Math.max(0, usage.cache_creation_input_tokens ?? 0);
    const cacheR = Math.max(0, usage.cache_read_input_tokens ?? 0);
    this.lastInputTokens = input + cacheW + cacheR;
    this.lastCompactTokens = input + cacheW;
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
   *  image（A'）：保护窗外的 `image` 块先换成 `[compacted_image]` 纪要（路径 + 最近一次
   *    describe_image / view_image 的 tool_result 摘要，扫得到就带上）。必须赶在 tier 2 前面，
   *    否则折叠会把像素默默丢掉、正史里连路径都没有。
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
    if (!force && this.lastCompactTokens < this.contextTokenLimit * COMPACT_WATERMARK) {
      return unchanged([...messages]);
    }

    const cutoff = Math.max(0, messages.length - protectRecent);
    const toolUses = indexToolUses(messages);
    const priorLedger = findExistingLedger(messages);
    const scanned = scanConversationLedger(messages, cutoff, toolUses);

    // ---- 保护窗外 image → 短文本纪要（须在 tier 2 之前，否则折叠会把像素默默丢掉）----
    const imagePass = degradeUnprotectedImages(messages, cutoff, toolUses);

    // ---- tier 1：大 tool_result → 语义占位 ----
    let dropped = 0;
    let savedChars = imagePass.savedChars;
    let out = imagePass.messages.map((m, i) => {
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
    const estimatedAfter = this.lastCompactTokens - savedChars / CHARS_PER_TOKEN_ESTIMATE;
    const needTier2 =
      force ||
      (dropped === 0 && imagePass.degraded === 0) ||
      estimatedAfter >= this.contextTokenLimit * COMPACT_WATERMARK;
    let collapsedTurns = 0;
    let collapsedLedger = emptyCompactLedger();
    if (needTier2) {
      const folded = collapseOldTurns(out, cutoff, toolUses);
      out = folded.messages;
      collapsedTurns = folded.collapsedTurns;
      collapsedLedger = folded.ledger;
    }

    if (dropped === 0 && collapsedTurns === 0) {
      if (imagePass.degraded === 0) return unchanged(out);
      return {
        messages: out,
        droppedBlocks: 0,
        ledgerEntries: 0,
        ledger: empty,
        summaryApplied: false,
        collapsedTurns: 0,
        changed: true,
      };
    }

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

/** 上下文分项估算（字符 / CHARS_PER_TOKEN_ESTIMATE）；API 不给官方分项时的诚实近似 */
export interface ContextBreakdown {
  system: number;
  toolsBuiltin: number;
  toolsMcp: number;
  memory: number;
  summarized: number;
  conversation: number;
  /** API 实测 input 总量 − 估算合计；可正可负，标明估算误差 */
  unallocated: number;
  estimated: true;
}

function estimateCharsToTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE));
}

function breakdownContentChars(content: Anthropic.MessageParam["content"] | Anthropic.TextBlockParam[]): number {
  if (typeof content === "string") return content.length;
  let n = 0;
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if ("text" in b && typeof b.text === "string") n += b.text.length;
    else if ("content" in b && typeof (b as { content?: unknown }).content === "string") {
      n += ((b as { content: string }).content).length;
    } else if ("input" in b) {
      try {
        n += JSON.stringify((b as { input: unknown }).input).length;
      } catch {
        /* ignore */
      }
    } else {
      try {
        n += JSON.stringify(b).length;
      } catch {
        /* ignore */
      }
    }
  }
  return n;
}

/**
 * 按请求结构估算上下文分项。`apiInputTokens` 为上一轮 API 实测（含 cache）；
 * 缺省时 unallocated=0。
 */
export function estimateContextBreakdown(
  req: Pick<ModelRequest, "system" | "messages" | "tools">,
  apiInputTokens?: number,
): ContextBreakdown {
  const systemChars = breakdownContentChars(req.system);
  let toolsBuiltinChars = 0;
  let toolsMcpChars = 0;
  for (const t of req.tools ?? []) {
    const blob = JSON.stringify(t);
    if (t.name.includes("__")) toolsMcpChars += blob.length;
    else toolsBuiltinChars += blob.length;
  }
  let memoryChars = 0;
  let summarizedChars = 0;
  let conversationChars = 0;
  for (const m of req.messages ?? []) {
    const texts = typeof m.content === "string"
      ? [m.content]
      : (m.content ?? [])
          .filter((b): b is Anthropic.TextBlockParam => Boolean(b) && typeof b === "object" && "text" in b)
          .map((b) => b.text);
    const joined = texts.join("\n");
    const isMemory =
      joined.includes("<context>") &&
      (joined.includes("memory_index") || joined.includes("memory:"));
    const isSummarized =
      joined.includes(COMPACT_LEDGER_MARKER) || joined.startsWith(COMPACTED_TURNS_MARKER);
    const chars = breakdownContentChars(m.content);
    if (isMemory) memoryChars += chars;
    else if (isSummarized) summarizedChars += chars;
    else conversationChars += chars;
  }
  const system = estimateCharsToTokens(systemChars);
  const toolsBuiltin = estimateCharsToTokens(toolsBuiltinChars);
  const toolsMcp = estimateCharsToTokens(toolsMcpChars);
  const memory = estimateCharsToTokens(memoryChars);
  const summarized = estimateCharsToTokens(summarizedChars);
  const conversation = estimateCharsToTokens(conversationChars);
  const sum = system + toolsBuiltin + toolsMcp + memory + summarized + conversation;
  const api =
    typeof apiInputTokens === "number" && Number.isFinite(apiInputTokens)
      ? Math.max(0, Math.floor(apiInputTokens))
      : sum;
  return {
    system,
    toolsBuiltin,
    toolsMcp,
    memory,
    summarized,
    conversation,
    unallocated: api - sum,
    estimated: true,
  };
}

/**
 * 保护窗外 image 降级后的正史文案。无摘要时只有首行。
 * 例：`[compacted_image] path=shots/hero.png\nsummary: 红按钮白底卡片，无文字。`
 */
export function formatCompactedImage(path: string, summary?: string): string {
  const shown = clipLine(path.trim() || UNKNOWN_IMAGE_PATH, IMAGE_PATH_MAX_CHARS);
  const head = `${COMPACTED_IMAGE_MARKER} path=${shown}`;
  const clipped = summary?.replace(/\s+/g, " ").trim();
  if (!clipped) return head;
  return `${head}\nsummary: ${clipLine(clipped, IMAGE_SUMMARY_MAX_CHARS)}`;
}

function isImageBlock(b: unknown): b is Anthropic.ImageBlockParam {
  return Boolean(b) && typeof b === "object" && (b as { type?: unknown }).type === "image";
}

function normalizeImagePathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").trim().toLowerCase();
}

function pathFromToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of ["path", "file"]) {
    if (typeof obj[key] === "string" && obj[key].trim()) return obj[key].trim();
  }
  return undefined;
}

function extractPathFromText(text: string): string | undefined {
  const labeled =
    /(?:\[(?:view_image|describe_image|compacted_image)\]|\bpath\s*[=:])\s*([^\s"'<>]+)/i.exec(text);
  if (labeled?.[1]) return labeled[1].replace(/^[[`']+|[\]`']+$/g, "");
  const ext = /((?:[A-Za-z]:)?[^\s"'<>]+?\.(?:png|jpe?g|gif|webp|bmp|svg))\b/i.exec(text);
  return ext?.[1];
}

function imageSourcePath(block: Anthropic.ImageBlockParam): string | undefined {
  const src = block.source as { type?: string; url?: string } | undefined;
  if (src?.type === "url" && typeof src.url === "string" && src.url.trim()) return src.url.trim();
  return undefined;
}

function estimateImageChars(block: Anthropic.ImageBlockParam): number {
  const src = block.source as { type?: string; data?: string; url?: string } | undefined;
  if (src?.type === "base64" && typeof src.data === "string") return src.data.length;
  if (src?.type === "url" && typeof src.url === "string") return src.url.length;
  try {
    return JSON.stringify(block).length;
  } catch {
    return 0;
  }
}

function toolResultPlainText(content: Anthropic.ToolResultBlockParam["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  return parts.join("\n");
}

function indexImageSummaries(
  messages: Anthropic.MessageParam[],
  toolUses: Map<string, ToolUseRef>,
): { describe: Map<string, string>; view: Map<string, string> } {
  const describe = new Map<string, string>();
  const view = new Map<string, string>();
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type !== "tool_result" || b.is_error === true) continue;
      const tool = toolUses.get(b.tool_use_id);
      if (!tool || !IMAGE_SUMMARY_TOOLS.has(tool.name)) continue;
      const path = pathFromToolInput(tool.input);
      if (!path) continue;
      const text = toolResultPlainText(b.content).replace(/\s+/g, " ").trim();
      if (!text) continue;
      const key = normalizeImagePathKey(path);
      if (tool.name === "describe_image") describe.set(key, text);
      else view.set(key, text);
    }
  }
  return { describe, view };
}

function summaryForPath(
  path: string,
  summaries: { describe: Map<string, string>; view: Map<string, string> },
): string | undefined {
  if (!path || path === UNKNOWN_IMAGE_PATH) return undefined;
  const key = normalizeImagePathKey(path);
  return summaries.describe.get(key) ?? summaries.view.get(key);
}

function resolveImagePath(args: {
  block: Anthropic.ImageBlockParam;
  siblingTexts: string[];
  enclosingTool?: ToolUseRef;
  nearestVisionTool?: ToolUseRef;
}): string {
  const fromEnclosing = pathFromToolInput(args.enclosingTool?.input);
  if (fromEnclosing) return fromEnclosing;
  for (const text of args.siblingTexts) {
    const extracted = extractPathFromText(text);
    if (extracted) return extracted;
  }
  const fromNearest = pathFromToolInput(args.nearestVisionTool?.input);
  if (fromNearest) return fromNearest;
  return imageSourcePath(args.block) ?? UNKNOWN_IMAGE_PATH;
}

function siblingTextsOf(content: Anthropic.ContentBlockParam[]): string[] {
  const out: string[] = [];
  for (const b of content) {
    if (b.type === "text" && typeof b.text === "string") out.push(b.text);
    else if (b.type === "tool_result") {
      const text = toolResultPlainText(b.content);
      if (text) out.push(text);
    }
  }
  return out;
}

function replaceImageBlock(
  block: Anthropic.ImageBlockParam,
  path: string,
  summaries: { describe: Map<string, string>; view: Map<string, string> },
): { text: Anthropic.TextBlockParam; savedChars: number } {
  const text = formatCompactedImage(path, summaryForPath(path, summaries));
  return {
    text: { type: "text", text },
    savedChars: Math.max(0, estimateImageChars(block) - text.length),
  };
}

/**
 * 只改保护窗外的 image 块（含 tool_result 数组里的）。窗内原图不动。
 * 不增删消息条数，所以 cutoff 下标仍然有效。
 */
function degradeUnprotectedImages(
  messages: Anthropic.MessageParam[],
  cutoff: number,
  toolUses: Map<string, ToolUseRef>,
): { messages: Anthropic.MessageParam[]; degraded: number; savedChars: number } {
  const summaries = indexImageSummaries(messages, toolUses);
  let degraded = 0;
  let savedChars = 0;
  let lastVision: ToolUseRef | undefined;
  const out = messages.map((m, i) => {
    if (typeof m.content !== "string" && m.role === "assistant") {
      for (const b of m.content) {
        if (b.type === "tool_use" && IMAGE_SUMMARY_TOOLS.has(b.name)) {
          lastVision = { name: b.name, input: b.input };
        }
      }
    }
    if (i >= cutoff || typeof m.content === "string") return m;
    const siblings = siblingTextsOf(m.content);
    let touched = false;
    const blocks = m.content.map((b) => {
      if (isImageBlock(b)) {
        touched = true;
        degraded += 1;
        const path = resolveImagePath({
          block: b,
          siblingTexts: siblings,
          nearestVisionTool: lastVision,
        });
        const replaced = replaceImageBlock(b, path, summaries);
        savedChars += replaced.savedChars;
        return replaced.text;
      }
      if (b.type !== "tool_result" || !Array.isArray(b.content)) return b;
      const tool = toolUses.get(b.tool_use_id);
      let innerTouched = false;
      const inner = b.content.map((ib) => {
        if (!isImageBlock(ib)) return ib;
        innerTouched = true;
        degraded += 1;
        const path = resolveImagePath({
          block: ib,
          siblingTexts: [toolResultPlainText(b.content), ...siblings].filter(Boolean),
          enclosingTool: tool,
          nearestVisionTool: lastVision,
        });
        const replaced = replaceImageBlock(ib, path, summaries);
        savedChars += replaced.savedChars;
        return replaced.text;
      });
      if (!innerTouched) return b;
      touched = true;
      return { ...b, content: inner };
    });
    return touched ? { ...m, content: blocks } : m;
  });
  return { messages: out, degraded, savedChars };
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

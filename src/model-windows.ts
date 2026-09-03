/**
 * 已知模型的上下文窗口登记表（MEM-01 窗口 / 预算分离的第三级来源）。
 *
 * 这里登记的是**事实**（端点会在多大处拒收），不是策略（我们在多大处压缩）——
 * 后者见 `context-window.ts` 的预算。两者此前被一个 `contextTokenLimit` 同时充当，
 * 真机实测 deepseek-v4-flash 窗口 1,048,576 而默认预算 150k（11% 处就压），
 * 而一个 128k 的模型则永远到不了主动压缩（150k > 窗口），只能靠反应式压缩
 * 白吃一次 400。
 *
 * 纪律：**没有出处的模型不登记**——猜一个数比不知道更糟：猜大了预算上限跟着虚高，
 * 端点照样 400；猜小了白白压缩。不在表里的模型走 `unknown`，预算保持默认，
 * 界面明说"窗口未知"；撞一次 400 之后由 learned 来源接管（`model-capability.ts`）。
 *
 * 优先级（`resolveContextWindow`）：env `AGENT_CONTEXT_WINDOW` > learned > **registry** > unknown。
 * learned 排在前面是因为它是**这台端点**的第一手证据：同名模型在不同兼容端点后面
 * 可能被配成不同窗口，登记表只是"官方说的"。
 */

export interface ModelWindowEntry {
  /** 精确匹配模型名（可带日期后缀，见 `matches`） */
  pattern: RegExp;
  windowTokens: number;
  /** 出处——每条都要能回答"这个数哪来的" */
  source: string;
}

/**
 * 出处逐条：
 * - DeepSeek v4 flash / pro：2026-09-03 真机冒烟（api.deepseek.com/anthropic）400 报文
 *   「This model's maximum context length is 1048576 tokens」，逐字锁在 test/compact-tier2.test.ts；
 *   pro 与 flash 同族同窗口（DeepSeek 模型页）。
 * - Claude：platform.claude.com/docs/en/build-with-claude/context-windows（2026-09 读取）——
 *   Opus 4.6 / 4.7 / 4.8、Sonnet 4.6、Opus 5、Sonnet 5 为 1M 且**无需 beta 头**；
 *   Sonnet 4 / 4.5、Opus 4 / 4.1 / 4.5、Haiku 4.5 为 200k（Sonnet 4/4.5 的 1M beta 已于
 *   2026-04-30 退役，harness 也从不发 `context-1m-2025-08-07` 头，所以按 200k 登记）。
 * - Kimi：platform.moonshot.cn/docs/guide/faq（2026-09 读取）——kimi-k3 最大 1M
 *   （1024×1024 = 1,048,576），kimi-k2.6 / kimi-k2.7-code 为 256k（256×1024）。
 *   注意：不是 k3 = 256k——那是 K2.x 的数。
 */
export const MODEL_WINDOW_REGISTRY: readonly ModelWindowEntry[] = [
  {
    pattern: /^deepseek-v4-(flash|pro)$/,
    windowTokens: 1_048_576,
    source: "2026-09-03 real-wire smoke @ api.deepseek.com/anthropic: 400 'maximum context length is 1048576 tokens'",
  },
  {
    pattern: /^claude-opus-4-[678](-\d{8})?$/,
    windowTokens: 1_000_000,
    source: "platform.claude.com context-windows doc (2026-09): Opus 4.6/4.7/4.8 = 1M, no beta header",
  },
  {
    pattern: /^claude-sonnet-4-6(-\d{8})?$/,
    windowTokens: 1_000_000,
    source: "platform.claude.com context-windows doc (2026-09): Sonnet 4.6 = 1M, no beta header",
  },
  {
    pattern: /^claude-(opus|sonnet)-5(-\d+)?(-\d{8})?$/,
    windowTokens: 1_000_000,
    source: "platform.claude.com context-windows doc (2026-09): Opus 5 / Sonnet 5 = 1M",
  },
  {
    pattern: /^claude-(opus|sonnet)-4(-[015])?(-\d{8})?$/,
    windowTokens: 200_000,
    source: "platform.claude.com context-windows doc (2026-09): Sonnet 4/4.5, Opus 4/4.1/4.5 = 200k (1M beta retired 2026-04-30)",
  },
  {
    pattern: /^claude-haiku-4-5(-\d{8})?$/,
    windowTokens: 200_000,
    source: "platform.claude.com context-windows doc (2026-09): Haiku 4.5 = 200k",
  },
  {
    pattern: /^kimi-k3$/,
    windowTokens: 1_048_576,
    source: "platform.moonshot.cn FAQ (2026-09): kimi-k3 max 1M tokens (1024*1024)",
  },
  {
    pattern: /^kimi-k2\.(6|7-code)$/,
    windowTokens: 262_144,
    source: "platform.moonshot.cn FAQ (2026-09): kimi-k2.6 / kimi-k2.7-code = 256k (256*1024)",
  },
];

/** 登记表查询：命中返回窗口与出处；不认识就 undefined（不猜） */
export function registryContextWindow(
  model: string,
): { windowTokens: number; source: string } | undefined {
  const name = model.trim();
  for (const entry of MODEL_WINDOW_REGISTRY) {
    if (entry.pattern.test(name)) return { windowTokens: entry.windowTokens, source: entry.source };
  }
  return undefined;
}

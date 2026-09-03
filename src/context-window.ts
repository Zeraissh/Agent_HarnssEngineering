/**
 * 上下文**窗口**（事实）与压缩**预算**（策略）——MEM-01 的两个概念，此前是一个数。
 *
 * `contextTokenLimit`（默认 150k，env `AGENT_CONTEXT_LIMIT`，包 `guardrails.contextTokenLimit`）
 * 一直同时充当"模型能装多少"与"我们在多少处压缩"。真机实测 deepseek-v4-flash 的窗口是
 * 1,048,576（我们在它 11% 处就压），而一个 128k 的模型永远到不了主动压缩（150k > 窗口），
 * 只能靠反应式压缩白吃一次 400。两个概念分开之后：
 *
 *  - **窗口** `contextWindowTokens`：端点会在多大处拒收。来源按优先级
 *    env `AGENT_CONTEXT_WINDOW` > learned（撞过的 400 报文里的数，`model-capability.ts`）
 *    > registry（`model-windows.ts`，有出处的登记表）> unknown。
 *  - **预算** `contextTokenLimit`：名字与 env 保持不变（兼容）。默认**仍是 150k**——
 *    知道窗口是 1M 不等于该把预算抬到 1M：每轮成本与时延随上下文线性增长，
 *    而压缩带来的质量损失有账本 / 摘录兜着；抬预算是委托方按任务权衡的决定，不该由
 *    harness 因为"发现窗口更大"自动替人做。三级覆盖 run（Web 逐 run）> env > 包 > 默认。
 *  - **夹紧**：窗口已知时 `maxBudget = window − maxTokens − margin`（端点按 messages + max_tokens
 *    之和计超长，2026-09-03 真机实测），预算超过就夹到上限并**发出告警**——这不是静默降级：
 *    夹紧值与被夹的原值都报出来（CLI 启动行 / Web run_config / 台账）。
 */
import { getLearnedContextWindow, type EndpointIdentity } from "./model-capability.js";
import { registryContextWindow } from "./model-windows.js";

export type ContextWindowSource = "env" | "learned" | "registry" | "unknown";
export type ContextBudgetSource = "run" | "env" | "pack" | "default";

/** 默认预算：保守值，见文件头。不随窗口自动抬高 */
export const DEFAULT_CONTEXT_TOKEN_LIMIT = 150_000;
/** 逐 run 预算下限：再小连任务首条 user 消息 + 保护窗都装不下，压缩会每轮开火 */
export const MIN_CONTEXT_TOKEN_LIMIT = 32_000;
/** 窗口未知时逐 run 预算的理智上限（与 cross-app model-settings-store 的 contextLimit max 同值） */
export const CONTEXT_TOKEN_LIMIT_HARD_CAP = 2_000_000;
/** 安全边际下限（4k）与比例（2%）——token 计数是端点算的，我们这边只有上一轮读数 */
export const CONTEXT_WINDOW_MARGIN_MIN = 4_096;
export const CONTEXT_WINDOW_MARGIN_RATIO = 0.02;
/** 夹紧后的地板：低于它压缩会抖动。落到这里说明配置本身不自洽（maxTokens ≥ 窗口） */
export const CONTEXT_BUDGET_FLOOR = 8_192;
/** 逐 run 预算超过此值时界面给成本忠告（不是阻断） */
export const CONTEXT_BUDGET_ADVISORY_ABOVE = 200_000;

export interface ContextWindowResolution {
  window: number | null;
  windowSource: ContextWindowSource;
  /** 登记表 / 学习记录的出处（诊断用；env 与 unknown 为 null） */
  windowNote: string | null;
}

/** 读 env 里的窗口覆盖。非法值抛错（口径同其它护栏 env：不静默降级） */
export function readContextWindowEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.AGENT_CONTEXT_WINDOW;
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`AGENT_CONTEXT_WINDOW "${raw}" 无效：需为 ≥1 的整数（模型上下文窗口的 token 数）`);
  }
  return n;
}

/** 读 env 里的预算覆盖。非法值抛错；`1e7` 这类科学计数法照 Number 语义接受 */
export function readContextLimitEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.AGENT_CONTEXT_LIMIT;
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`AGENT_CONTEXT_LIMIT "${raw}" 无效：需为 ≥1 的整数（触发压缩的上下文 token 预算）`);
  }
  return n;
}

/**
 * 四级来源解析窗口。identity 是**执行者**端点（窗口按端点 + 模型记）。
 * env 非法值在这里抛出——调用方（CLI exit 1 / Web 抛错）决定怎么呈现。
 */
export function resolveContextWindow(
  identity: EndpointIdentity,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): ContextWindowResolution {
  const fromEnv = readContextWindowEnv(env);
  if (fromEnv !== undefined) return { window: fromEnv, windowSource: "env", windowNote: null };
  const learned = getLearnedContextWindow(identity, now);
  if (learned) {
    return {
      window: learned.windowTokens,
      windowSource: "learned",
      windowNote: `learned from a context-overflow 400 at ${new Date(learned.learnedAt).toISOString()}`,
    };
  }
  const registry = registryContextWindow(identity.model);
  if (registry) return { window: registry.windowTokens, windowSource: "registry", windowNote: registry.source };
  return { window: null, windowSource: "unknown", windowNote: null };
}

export function contextWindowMargin(window: number): number {
  return Math.max(CONTEXT_WINDOW_MARGIN_MIN, Math.floor(window * CONTEXT_WINDOW_MARGIN_RATIO));
}

/**
 * 预算上限 = 窗口 − maxTokens − 边际。可以为负（maxTokens 比窗口还大）——调用方据此告警，
 * 这里不吞掉这个事实。
 */
export function maxContextBudget(window: number, maxTokens: number): number {
  return window - maxTokens - contextWindowMargin(window);
}

export interface ContextBudgetInputs {
  window: number | null;
  windowSource: ContextWindowSource;
  /** 单次响应输出上限（默认 64k）——端点把它算进窗口 */
  maxTokens: number;
  /** 逐 run 覆盖（Web 请求体）；已经过 validateRunContextBudget */
  runLimit?: number;
  /** env AGENT_CONTEXT_LIMIT（已解析） */
  envLimit?: number;
  /** 包 guardrails.contextTokenLimit */
  packLimit?: number;
}

export interface ContextPlan {
  window: number | null;
  windowSource: ContextWindowSource;
  /** 生效预算（可能被夹紧） */
  budget: number;
  budgetSource: ContextBudgetSource;
  /** 夹紧前的配置值；未夹时与 budget 相等 */
  requestedBudget: number;
  /** 窗口已知时的预算上限；未知为 null */
  maxBudget: number | null;
  maxTokens: number;
  clamped: boolean;
  /** 夹紧 / 配置不自洽时的一句人话；正常为 null */
  warning: string | null;
}

/** 预算三级覆盖 + 夹紧。纯函数，可测 */
export function planContextBudget(inputs: ContextBudgetInputs): ContextPlan {
  const requested =
    inputs.runLimit ?? inputs.envLimit ?? inputs.packLimit ?? DEFAULT_CONTEXT_TOKEN_LIMIT;
  const budgetSource: ContextBudgetSource =
    inputs.runLimit !== undefined
      ? "run"
      : inputs.envLimit !== undefined
        ? "env"
        : inputs.packLimit !== undefined
          ? "pack"
          : "default";
  const maxBudget = inputs.window === null ? null : maxContextBudget(inputs.window, inputs.maxTokens);

  if (maxBudget === null || requested <= maxBudget) {
    return {
      window: inputs.window,
      windowSource: inputs.windowSource,
      budget: requested,
      budgetSource,
      requestedBudget: requested,
      maxBudget,
      maxTokens: inputs.maxTokens,
      clamped: false,
      warning: null,
    };
  }

  const budget = Math.max(CONTEXT_BUDGET_FLOOR, maxBudget);
  const margin = contextWindowMargin(inputs.window!);
  const warning =
    maxBudget < CONTEXT_BUDGET_FLOOR
      ? `上下文预算已夹到地板 ${formatTokensK(budget)}：窗口 ${formatTokensK(inputs.window!)}（${inputs.windowSource}）` +
        ` − maxTokens ${formatTokensK(inputs.maxTokens)} − 边际 ${formatTokensK(margin)} = ${formatTokensK(maxBudget)}，` +
        `配置不自洽——请调低 AGENT_MAX_TOKENS，否则每轮都会压缩甚至仍然 400`
      : `上下文预算 ${formatTokensK(requested)}（${budgetSource}）超过窗口允许的上限，已夹到 ${formatTokensK(budget)}：` +
        `窗口 ${formatTokensK(inputs.window!)}（${inputs.windowSource}）− maxTokens ${formatTokensK(inputs.maxTokens)}` +
        ` − 边际 ${formatTokensK(margin)}`;
  return {
    window: inputs.window,
    windowSource: inputs.windowSource,
    budget,
    budgetSource,
    requestedBudget: requested,
    maxBudget,
    maxTokens: inputs.maxTokens,
    clamped: true,
    warning,
  };
}

/** 逐 run 预算的合法区间：[32k, maxBudget]；窗口未知时上限取理智硬顶 */
export function runContextBudgetRange(maxBudget: number | null): { min: number; max: number } {
  return { min: MIN_CONTEXT_TOKEN_LIMIT, max: maxBudget ?? CONTEXT_TOKEN_LIMIT_HARD_CAP };
}

export type RunContextBudgetValidation =
  | { ok: true; value: number }
  | { ok: false; error: string; min: number; max: number };

/**
 * 校验 Web 请求体里的逐 run 预算。**拒绝而不是静默夹紧**：外部输入静默降级会让
 * "我明明填了 900k"与实际行为长期不一致（口径同 effort / pack 的 V-24）。
 * 区间上限 = maxBudget（窗口已知）或硬顶 2M（未知）；错误文案带可用区间。
 */
export function validateRunContextBudget(raw: unknown, maxBudget: number | null): RunContextBudgetValidation {
  const { min, max } = runContextBudgetRange(maxBudget);
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isInteger(n)) {
    return { ok: false, min, max, error: `contextTokenLimit "${String(raw)}" 无效：需为整数 token 数，可用区间 ${min}..${max}` };
  }
  if (max < min) {
    return {
      ok: false,
      min,
      max,
      error:
        `本端点的窗口减去 maxTokens 与边际后只剩 ${max}，低于逐 run 预算下限 ${min}——` +
        "无法逐 run 设预算；请调低 AGENT_MAX_TOKENS 或换更大窗口的模型",
    };
  }
  if (n < min || n > max) {
    return {
      ok: false,
      min,
      max,
      error:
        `contextTokenLimit ${n} 越界：可用区间 ${min}..${max}` +
        (maxBudget !== null ? "（上限 = 窗口 − maxTokens − 边际）" : "（窗口未知，上限取硬顶）"),
    };
  }
  return { ok: true, value: n };
}

/** 150000 → "150k"；1048576 → "1,048k"（向下取整到千，千位分隔） */
export function formatTokensK(n: number): string {
  const k = Math.floor(n / 1000);
  return `${k.toLocaleString("en-US")}k`;
}

/** 窗口一段的人话：已知带来源，未知就说未知（不编一个数） */
export function describeContextWindow(plan: Pick<ContextPlan, "window" | "windowSource">): string {
  return plan.window === null ? "窗口未知" : `窗口 ${formatTokensK(plan.window)}（来源：${plan.windowSource}）`;
}

/**
 * CLI 启动行：`上下文：预算 150k / 窗口 1,048k（来源：learned）`。
 * 预算不是默认值时带来源（`预算 200k（env）`），被夹紧时写明原值（`预算 60k（由 150k 夹紧）`）——
 * 数字必须带来源，否则无从判断"这是不是我要的那个值"。
 */
export function describeContextPlan(plan: ContextPlan): string {
  const budget = plan.clamped
    ? `预算 ${formatTokensK(plan.budget)}（由 ${formatTokensK(plan.requestedBudget)} 夹紧）`
    : plan.budgetSource === "default"
      ? `预算 ${formatTokensK(plan.budget)}`
      : `预算 ${formatTokensK(plan.budget)}（${plan.budgetSource}）`;
  return `上下文：${budget} / ${describeContextWindow(plan)}`;
}

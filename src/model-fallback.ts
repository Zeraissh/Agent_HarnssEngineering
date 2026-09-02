/**
 * L0 装饰器 — 端点降级与熔断（MODEL-01a）。
 *
 * 位置选择的理由与 model-client.ts 里那条降级臂同源：**端点能力与健康差异归 L0**。
 * 上面几层只认识 ModelClient 接口，不该知道"这次调用其实换了一家服务商"。
 *
 * 与既有两层重试的关系（别把三者混成一件事）：
 *   - SDK 内置重试：同一端点、同一请求，指数退避扛住 429/5xx 抖动；
 *   - loop 的 errorRetries：同一端点、同一轮，SDK 耗尽后再幂等重发一次；
 *   - 这里：**换端点**。只有在错误已被判定为瞬时（即换个端点有可能成功）时才动作；
 *     认证失败、400、宿主 abort 一律原样上抛——换端点救不了配置错误，只会
 *     把同一个 401 打到第二家服务商去，并掩盖真正的原因。
 */
import { isTransientApiError } from "./model-client.js";
import { createModelClientFromEnv } from "./provider.js";
import type { ModelClient, ModelRequest, ModelTurn, StreamDelta } from "./types.js";

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  /** 注入时钟：熔断的全部语义都挂在时间上，不注入就只能靠 sleep 测 */
  now?: () => number;
}

export type CircuitState = "closed" | "open" | "half_open";

export const DEFAULT_FAILURE_THRESHOLD = 3;
export const DEFAULT_COOLDOWN_MS = 30_000;

/**
 * 单端点熔断器。
 *
 * `open → half_open` 是**惰性转移**：没有定时器，冷却到期与否在被问到时才算。
 * 所以 `state()` 与 `allow()` 都会推进状态机——这让"到期了但没人调用"不会留下
 * 一个永远显示 open 的读数（那种读数会让排障的人以为端点仍被隔离）。
 */
export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private current: CircuitState = "closed";
  private failures = 0;
  private openedAt = 0;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = opts.now ?? Date.now;
  }

  state(): CircuitState {
    return this.refresh();
  }

  /** open 且冷却未到 → 不放行；half_open 放行一次试探 */
  allow(): boolean {
    return this.refresh() !== "open";
  }

  recordSuccess(): void {
    this.current = "closed";
    this.failures = 0;
  }

  /** 只在**瞬时**失败时调用：把配置错误计入失败数会把好端点熔断掉 */
  recordFailure(): void {
    // half_open 下的失败立刻重新拉闸：试探已经给过机会，不必再攒到阈值
    if (this.refresh() === "half_open") {
      this.trip();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.trip();
  }

  private refresh(): CircuitState {
    if (this.current === "open" && this.now() - this.openedAt >= this.cooldownMs) {
      this.current = "half_open";
    }
    return this.current;
  }

  private trip(): void {
    this.current = "open";
    this.openedAt = this.now();
    this.failures = this.failureThreshold;
  }
}

export interface FallbackEndpoint {
  name: string;
  client: ModelClient;
  /** If true, strip thinking blocks from messages before send (compat endpoints) */
  stripThinking?: boolean;
}

export interface FallbackInfo {
  from: string;
  to: string;
  reason: string;
  turn: number;
}

export interface FallbackModelClientOptions {
  primary: FallbackEndpoint;
  fallbacks: FallbackEndpoint[];
  breaker?: CircuitBreakerOptions;
  onFallback?: (info: FallbackInfo) => void;
}

/**
 * 从消息里剥掉思考块。
 *
 * 为什么要剥：思考块带 `signature`，是**发给它的那一家**的凭据。把 A 家的思考
 * 原样转给 B 家，好一点的忽略，差一点的直接 400——降级本来是救命的，结果换来一个
 * 永久性错误，比不降级还糟。
 *
 * 深拷贝而非就地过滤：同一个 ModelRequest 可能还要发给下一个端点（也可能被调用方
 * 复用），改坏它就是把降级路径的副作用漏回主路径。
 */
export function stripThinkingBlocks(req: ModelRequest): ModelRequest {
  const messages = structuredClone(req.messages).map((msg) => {
    if (typeof msg.content === "string") return msg;
    const kept = msg.content.filter(
      (block) => block.type !== "thinking" && block.type !== "redacted_thinking",
    );
    if (kept.length === msg.content.length) return msg;
    // 只剩空数组的话请求本身就不合法了（content 不能为空）。保留一个标记块，
    // 让"这里原本有一段思考"这个事实不消失，也不伪造思考内容。
    return {
      ...msg,
      content: kept.length > 0 ? kept : [{ type: "text" as const, text: "[thinking omitted]" }],
    };
  });
  return { ...req, messages };
}

/**
 * 按顺序尝试 primary → fallbacks 的 ModelClient 装饰器。
 *
 * 每个端点各有自己的熔断器：共用一个的话，第一家挂掉会把整条链一起拉闸，
 * 而链存在的全部意义就是"这家不行换那家"。
 */
export class FallbackModelClient implements ModelClient {
  private readonly endpoints: FallbackEndpoint[];
  private readonly breakers = new Map<FallbackEndpoint, CircuitBreaker>();
  private readonly onFallback: ((info: FallbackInfo) => void) | undefined;
  private turn = 0;

  constructor(opts: FallbackModelClientOptions) {
    this.endpoints = [opts.primary, ...opts.fallbacks];
    this.onFallback = opts.onFallback;
    for (const ep of this.endpoints) this.breakers.set(ep, new CircuitBreaker(opts.breaker));
  }

  /** 供 harness/配置面报告实际生效的链路 */
  chain(): string[] {
    return this.endpoints.map((ep) => ep.name);
  }

  /** 排障用：某个端点当前的熔断状态（会推进惰性转移，同 CircuitBreaker.state） */
  breakerState(name: string): CircuitState | undefined {
    for (const ep of this.endpoints) {
      if (ep.name === name) return this.breakers.get(ep)?.state();
    }
    return undefined;
  }

  async send(
    req: ModelRequest,
    onDelta?: (delta: StreamDelta) => void,
    signal?: AbortSignal,
  ): Promise<ModelTurn> {
    const turn = ++this.turn;
    let lastError: unknown;
    let attempted = false;
    /**
     * 上一个"离开"的端点及离开的原因：跳过的也算离开（否则熔断跳过时 from 会指错人），
     * 而原因必须跟着**紧邻的那一步**走——链中间夹一个熔断跳过时，
     * 沿用整条链的 lastError 会把"它被隔离了"报成"它报了 503"。
     */
    let previous: { name: string; reason: string } | undefined;
    const skipped: string[] = [];

    for (const ep of this.endpoints) {
      const breaker = this.breakers.get(ep)!;
      if (!breaker.allow()) {
        skipped.push(ep.name);
        previous = { name: ep.name, reason: "circuit_open" };
        continue;
      }
      if (previous !== undefined) {
        this.onFallback?.({ from: previous.name, to: ep.name, reason: previous.reason, turn });
      }
      previous = { name: ep.name, reason: "unknown" };
      attempted = true;

      try {
        const turnResult = await ep.client.send(
          ep.stripThinking ? stripThinkingBlocks(req) : req,
          onDelta,
          signal,
        );
        breaker.recordSuccess();
        return turnResult;
      } catch (err) {
        // 非瞬时（认证/4xx/abort）不换端点、不计失败数：换过去也是同一个错
        if (!isTransientApiError(err)) throw err;
        breaker.recordFailure();
        lastError = err;
        previous = { name: ep.name, reason: describeError(err) };
      }
    }

    if (attempted) throw lastError;
    // 一次都没发出去：全链熔断中。要报成明确的配置/健康问题，不能静默返回空轮次
    throw new Error(
      `所有模型端点均处于熔断隔离中，本轮未发出任何请求：${skipped.join(" → ")}`,
    );
  }
}

function describeError(err: unknown): string {
  const status = (err as { status?: unknown } | undefined)?.status;
  const msg = err instanceof Error ? err.message : String(err);
  return typeof status === "number" ? `${status}: ${msg}` : msg;
}

export interface FallbackEnvConfig {
  model?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  failureThreshold: number;
  cooldownMs: number;
}

/**
 * 读取降级链的环境配置。
 *
 * 数值非法时**抛错而不是静默取默认**：静默的后果是运维以为自己把冷却调成了 5 分钟，
 * 实际仍是 30 秒——熔断这种防线一旦口径与人的认知不一致就等于没有。
 */
export function readFallbackEnv(env: NodeJS.ProcessEnv = process.env): FallbackEnvConfig {
  const model = trimmed(env.AGENT_FALLBACK_MODEL);
  const provider = trimmed(env.AGENT_FALLBACK_PROVIDER);
  const baseUrl = trimmed(env.AGENT_FALLBACK_BASE_URL);
  const apiKey = trimmed(env.AGENT_FALLBACK_API_KEY);
  return {
    ...(model !== undefined ? { model } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    failureThreshold: readPositiveInt(
      env.AGENT_CIRCUIT_FAILURE_THRESHOLD,
      "AGENT_CIRCUIT_FAILURE_THRESHOLD",
      DEFAULT_FAILURE_THRESHOLD,
      1,
    ),
    cooldownMs: readPositiveInt(
      env.AGENT_CIRCUIT_COOLDOWN_MS,
      "AGENT_CIRCUIT_COOLDOWN_MS",
      DEFAULT_COOLDOWN_MS,
      0,
    ),
  };
}

function trimmed(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function readPositiveInt(raw: string | undefined, name: string, fallback: number, min: number): number {
  const v = raw?.trim();
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} 无效：需要 ≥ ${min} 的整数，实际收到 "${raw}"`);
  }
  return n;
}

/**
 * 配了 AGENT_FALLBACK_MODEL 就把 primary 包一层，否则原样返回。
 *
 * 宿主接线（CLI / ui / eval 各自报告链路与降级事件）是另一笔提交；这里只提供
 * 一个装配函数，让"配置了却没生效"这种最难查的形态不必等到那笔提交才有解。
 */
export function createFallbackClientIfConfigured(
  primary: FallbackEndpoint,
  env: NodeJS.ProcessEnv = process.env,
  onFallback?: (info: FallbackInfo) => void,
): ModelClient {
  const cfg = readFallbackEnv(env);
  if (!cfg.model) return primary.client;

  if (cfg.provider !== undefined && cfg.provider !== "anthropic" && cfg.provider !== "openai") {
    throw new Error('AGENT_FALLBACK_PROVIDER 无效：只能是 "anthropic" 或 "openai"');
  }
  const resolved = createModelClientFromEnv(cfg.model, {
    ...(cfg.provider !== undefined ? { provider: cfg.provider } : {}),
    ...(cfg.baseUrl !== undefined ? { baseURL: cfg.baseUrl } : {}),
    ...(cfg.apiKey !== undefined ? { apiKey: cfg.apiKey } : {}),
  });

  return new FallbackModelClient({
    primary,
    fallbacks: [
      {
        name: cfg.model,
        client: resolved.client,
        // compat 端点不认 Claude 的思考块签名，转过去只会挨 400
        stripThinking: resolved.compat,
      },
    ],
    breaker: { failureThreshold: cfg.failureThreshold, cooldownMs: cfg.cooldownMs },
    ...(onFallback ? { onFallback } : {}),
  });
}

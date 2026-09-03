/**
 * L0 装饰器 — 端点降级与熔断（MODEL-01a）+ 每角色链 / 健康偏好（MODEL-01b）。
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
 *
 * MODEL-01b 增量：
 *   - 熔断器按**端点身份**登记（provider|model|baseURL），角色之间不误共用
 *     另一条链的对象引用，但同一物理端点的健康状态诚实共享；
 *   - verifier / planner / vision 可声明自己的 `AGENT_<ROLE>_FALLBACK_*`，
 *     或 `AGENT_<ROLE>_FALLBACK=inherit` 继承执行者备用端点（仍是独立装饰器实例）；
 *   - `prefer_healthy` 路由 stub：有粘性探针证据时把已知不健康的端点排后，
 *     全不健康仍尝试（fail-open）——不是成本模型，不假装聪明。
 */
import {
  endpointIdentityKey,
  stickySaysUnhealthy,
  type EndpointIdentity,
  type ModelProviderKind,
} from "./model-capability.js";
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

export type ModelRole = "executor" | "verifier" | "planner" | "vision";

export type FallbackRouting = "sequential" | "prefer_healthy";

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

/**
 * 按端点身份共享的熔断表。
 *
 * 角色 A 的 FallbackModelClient 与角色 B 的不得共享**同一个装饰器实例**
 * （否则 sticky open 会把无关角色一并隔离）；但若两边真的指向同一
 * provider|model|baseURL，健康状态应当共享——否则会出现"执行者刚把这家
 * 熔断、核查者又去撞同一堵墙"的假独立。
 */
export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly opts: CircuitBreakerOptions;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.opts = opts;
  }

  get(identityKey: string): CircuitBreaker {
    let b = this.breakers.get(identityKey);
    if (!b) {
      b = new CircuitBreaker(this.opts);
      this.breakers.set(identityKey, b);
    }
    return b;
  }

  state(identityKey: string): CircuitState | undefined {
    return this.breakers.get(identityKey)?.state();
  }

  clear(): void {
    this.breakers.clear();
  }

  size(): number {
    return this.breakers.size;
  }
}

/** 进程缺省登记表：宿主装配多角色时复用，测试可 new 自己的 */
export const sharedBreakerRegistry = new CircuitBreakerRegistry();

export interface FallbackEndpoint {
  name: string;
  client: ModelClient;
  /** If true, strip thinking blocks from messages before send (compat endpoints) */
  stripThinking?: boolean;
  /** 熔断 / 探针身份；缺省用 name 凑一个 anthropic 身份（仅测试便利用） */
  identity?: EndpointIdentity;
}

export interface FallbackInfo {
  from: string;
  to: string;
  reason: string;
  turn: number;
  role?: ModelRole;
  routing?: FallbackRouting;
}

export interface FallbackModelClientOptions {
  primary: FallbackEndpoint;
  fallbacks: FallbackEndpoint[];
  breaker?: CircuitBreakerOptions;
  /** 不传则每端点私有熔断器（MODEL-01a 行为）；传了则按身份共享 */
  breakerRegistry?: CircuitBreakerRegistry;
  onFallback?: (info: FallbackInfo) => void;
  role?: ModelRole;
  /** 缺省 sequential；prefer_healthy 是诚实 stub，不是成本路由 */
  routing?: FallbackRouting;
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

function endpointKey(ep: FallbackEndpoint): string {
  if (ep.identity) return endpointIdentityKey(ep.identity);
  return endpointIdentityKey({ provider: "anthropic", model: ep.name });
}

/**
 * prefer_healthy stub：已知不健康的排后，未知与健康的保持相对顺序。
 * 全不健康时返回原序（仍会尝试）——探针不是准入闸门。
 */
export function orderEndpointsForRouting(
  endpoints: FallbackEndpoint[],
  routing: FallbackRouting,
  now: () => number = Date.now,
): FallbackEndpoint[] {
  if (routing !== "prefer_healthy" || endpoints.length <= 1) return endpoints;
  const healthyOrUnknown: FallbackEndpoint[] = [];
  const unhealthy: FallbackEndpoint[] = [];
  for (const ep of endpoints) {
    const id = ep.identity ?? { provider: "anthropic" as const, model: ep.name };
    if (stickySaysUnhealthy(id, now())) unhealthy.push(ep);
    else healthyOrUnknown.push(ep);
  }
  if (unhealthy.length === 0 || healthyOrUnknown.length === 0) return endpoints;
  return [...healthyOrUnknown, ...unhealthy];
}

/**
 * 按顺序尝试 primary → fallbacks 的 ModelClient 装饰器。
 *
 * 每个端点各有自己的熔断器（或按身份从 registry 取）：共用**一个**熔断器对象
 * 会把整条链一起拉闸，而链存在的全部意义就是"这家不行换那家"。
 */
export class FallbackModelClient implements ModelClient {
  private readonly endpoints: FallbackEndpoint[];
  private readonly privateBreakers = new Map<string, CircuitBreaker>();
  private readonly registry: CircuitBreakerRegistry | undefined;
  private readonly breakerOpts: CircuitBreakerOptions;
  private readonly onFallback: ((info: FallbackInfo) => void) | undefined;
  private readonly role: ModelRole | undefined;
  private readonly routing: FallbackRouting;
  private turn = 0;

  constructor(opts: FallbackModelClientOptions) {
    this.endpoints = [opts.primary, ...opts.fallbacks];
    this.onFallback = opts.onFallback;
    this.registry = opts.breakerRegistry;
    this.breakerOpts = opts.breaker ?? {};
    this.role = opts.role;
    this.routing = opts.routing ?? "sequential";
    if (!this.registry) {
      for (const ep of this.endpoints) {
        this.privateBreakers.set(endpointKey(ep), new CircuitBreaker(this.breakerOpts));
      }
    }
  }

  /** 供 harness/配置面报告实际生效的链路 */
  chain(): string[] {
    return this.endpoints.map((ep) => ep.name);
  }

  /** 备用端点（不含 primary）——角色 inherit 时复用这些对象，不重建 client */
  backupEndpoints(): FallbackEndpoint[] {
    return this.endpoints.slice(1);
  }

  roleName(): ModelRole | undefined {
    return this.role;
  }

  routingPolicy(): FallbackRouting {
    return this.routing;
  }

  /** 排障用：某个端点当前的熔断状态（会推进惰性转移，同 CircuitBreaker.state） */
  breakerState(name: string): CircuitState | undefined {
    for (const ep of this.endpoints) {
      if (ep.name === name) return this.breakerFor(ep).state();
    }
    return undefined;
  }

  private breakerFor(ep: FallbackEndpoint): CircuitBreaker {
    const key = endpointKey(ep);
    if (this.registry) return this.registry.get(key);
    let b = this.privateBreakers.get(key);
    if (!b) {
      b = new CircuitBreaker(this.breakerOpts);
      this.privateBreakers.set(key, b);
    }
    return b;
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
    // 尝试顺序保持配置链原序（委托方眼里的优先级）；prefer_healthy 只决定
    // "已知不健康时是否跳过"，不重排——重排会让"跳过"变成静默换首发，事件流丢决策。
    const ordered = this.endpoints;

    for (const ep of ordered) {
      const breaker = this.breakerFor(ep);
      if (!breaker.allow()) {
        skipped.push(ep.name);
        previous = { name: ep.name, reason: "circuit_open" };
        continue;
      }
      // prefer_healthy：有更健康候选时，跳过粘性探针标过 unhealthy 的端点
      if (this.routing === "prefer_healthy") {
        const id = ep.identity ?? { provider: "anthropic" as const, model: ep.name };
        const othersMayWork = ordered.some((cand) => {
          if (cand === ep) return false;
          if (!this.breakerFor(cand).allow()) return false;
          const candId = cand.identity ?? { provider: "anthropic" as const, model: cand.name };
          return !stickySaysUnhealthy(candId);
        });
        if (othersMayWork && stickySaysUnhealthy(id)) {
          skipped.push(ep.name);
          previous = { name: ep.name, reason: "probe_unhealthy" };
          continue;
        }
      }
      if (previous !== undefined) {
        this.onFallback?.({
          from: previous.name,
          to: ep.name,
          reason: previous.reason,
          turn,
          ...(this.role ? { role: this.role } : {}),
          routing: this.routing,
        });
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
  routing: FallbackRouting;
}

/**
 * 读取执行者降级链的环境配置。
 *
 * 数值非法时**抛错而不是静默取默认**：静默的后果是运维以为自己把冷却调成了 5 分钟，
 * 实际仍是 30 秒——熔断这种防线一旦口径与人的认知不一致就等于没有。
 */
export function readFallbackEnv(env: NodeJS.ProcessEnv = process.env): FallbackEnvConfig {
  return readFallbackEnvWithPrefix("", env);
}

/**
 * 角色降级：`own` 配了 AGENT_<ROLE>_FALLBACK_MODEL；`inherit` 吃执行者备用端点；
 * `none` 不包装饰器。
 */
export type RoleFallbackMode =
  | { mode: "none" }
  | { mode: "own"; config: FallbackEnvConfig }
  | { mode: "inherit" };

const ROLE_ENV_PREFIX: Record<Exclude<ModelRole, "executor">, string> = {
  verifier: "VERIFIER",
  planner: "PLANNER",
  vision: "VISION",
};

export function readRoleFallbackMode(
  role: Exclude<ModelRole, "executor">,
  env: NodeJS.ProcessEnv = process.env,
): RoleFallbackMode {
  const prefix = ROLE_ENV_PREFIX[role];
  const inheritRaw = trimmed(env[`AGENT_${prefix}_FALLBACK`]);
  if (inheritRaw === "inherit") return { mode: "inherit" };
  if (inheritRaw !== undefined && inheritRaw !== "own") {
    throw new Error(`AGENT_${prefix}_FALLBACK 无效：只能是 "inherit" 或 "own"（或缺省）`);
  }
  const model = trimmed(env[`AGENT_${prefix}_FALLBACK_MODEL`]);
  if (!model) return { mode: "none" };
  return {
    mode: "own",
    config: readFallbackEnvWithPrefix(`${prefix}_`, env),
  };
}

function readFallbackEnvWithPrefix(prefix: string, env: NodeJS.ProcessEnv): FallbackEnvConfig {
  // prefix "" → AGENT_FALLBACK_MODEL；"VERIFIER_" → AGENT_VERIFIER_FALLBACK_MODEL
  const modelKey = prefix ? `AGENT_${prefix}FALLBACK_MODEL` : "AGENT_FALLBACK_MODEL";
  const providerKey = prefix ? `AGENT_${prefix}FALLBACK_PROVIDER` : "AGENT_FALLBACK_PROVIDER";
  const baseKey = prefix ? `AGENT_${prefix}FALLBACK_BASE_URL` : "AGENT_FALLBACK_BASE_URL";
  const keyKey = prefix ? `AGENT_${prefix}FALLBACK_API_KEY` : "AGENT_FALLBACK_API_KEY";
  const model = trimmed(env[modelKey]);
  const provider = trimmed(env[providerKey]);
  const baseUrl = trimmed(env[baseKey]);
  const apiKey = trimmed(env[keyKey]);
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
    routing: readRouting(env.AGENT_FALLBACK_ROUTING),
  };
}

function readRouting(raw: string | undefined): FallbackRouting {
  const v = raw?.trim();
  if (!v || v === "sequential") return "sequential";
  if (v === "prefer_healthy") return "prefer_healthy";
  throw new Error('AGENT_FALLBACK_ROUTING 无效：只能是 "sequential" 或 "prefer_healthy"');
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

function resolveFallbackEndpoint(cfg: FallbackEnvConfig): FallbackEndpoint {
  if (!cfg.model) {
    throw new Error("fallback config missing model");
  }
  if (cfg.provider !== undefined && cfg.provider !== "anthropic" && cfg.provider !== "openai") {
    throw new Error('FALLBACK_PROVIDER 无效：只能是 "anthropic" 或 "openai"');
  }
  const resolved = createModelClientFromEnv(cfg.model, {
    ...(cfg.provider !== undefined ? { provider: cfg.provider as ModelProviderKind } : {}),
    ...(cfg.baseUrl !== undefined ? { baseURL: cfg.baseUrl } : {}),
    ...(cfg.apiKey !== undefined ? { apiKey: cfg.apiKey } : {}),
  });
  const provider = (cfg.provider as ModelProviderKind | undefined) ?? resolved.provider;
  return {
    name: cfg.model,
    client: resolved.client,
    // compat 端点不认 Claude 的思考块签名，转过去只会挨 400
    stripThinking: resolved.compat,
    identity: {
      provider,
      model: cfg.model,
      ...(cfg.baseUrl !== undefined ? { baseURL: cfg.baseUrl } : {}),
    },
  };
}

export interface CreateFallbackOptions {
  primary: FallbackEndpoint;
  env?: NodeJS.ProcessEnv;
  onFallback?: (info: FallbackInfo) => void;
  role?: ModelRole;
  breakerRegistry?: CircuitBreakerRegistry;
  /** 显式备用端点（inherit 时由调用方传入执行者的 fallback 端点） */
  fallbackEndpoints?: FallbackEndpoint[];
  /** 强制使用某份 FallbackEnvConfig（角色 own 模式） */
  config?: FallbackEnvConfig;
}

/**
 * 配了 AGENT_FALLBACK_MODEL（或传入 config / fallbackEndpoints）就把 primary 包一层，
 * 否则原样返回。
 *
 * 宿主接线（CLI / ui / eval 各自报告链路与降级事件）是另一笔；这里只提供
 * 装配函数，让"配置了却没生效"这种最难查的形态不必等到那笔才有解。
 */
export function createFallbackClientIfConfigured(
  primary: FallbackEndpoint,
  env: NodeJS.ProcessEnv = process.env,
  onFallback?: (info: FallbackInfo) => void,
  extras: Omit<CreateFallbackOptions, "primary" | "env" | "onFallback"> = {},
): ModelClient {
  return createFallbackClient({
    primary,
    env,
    ...(onFallback ? { onFallback } : {}),
    ...extras,
  });
}

export function createFallbackClient(opts: CreateFallbackOptions): ModelClient {
  const env = opts.env ?? process.env;
  const cfg = opts.config ?? readFallbackEnv(env);
  const fallbacks =
    opts.fallbackEndpoints ??
    (cfg.model ? [resolveFallbackEndpoint(cfg)] : []);

  if (fallbacks.length === 0) return opts.primary.client;

  const primary: FallbackEndpoint = {
    ...opts.primary,
    identity:
      opts.primary.identity ??
      ({
        provider: "anthropic",
        model: opts.primary.name,
      } satisfies EndpointIdentity),
  };

  return new FallbackModelClient({
    primary,
    fallbacks,
    breaker: { failureThreshold: cfg.failureThreshold, cooldownMs: cfg.cooldownMs },
    // 缺省私有熔断（MODEL-01a）；多角色宿主显式传入 sharedBreakerRegistry 才按身份共享
    ...(opts.breakerRegistry ? { breakerRegistry: opts.breakerRegistry } : {}),
    ...(opts.onFallback ? { onFallback: opts.onFallback } : {}),
    ...(opts.role ? { role: opts.role } : {}),
    routing: cfg.routing,
  });
}

/**
 * 为角色装配降级链：own / inherit / none。
 * inherit 复用执行者备用端点列表，但装饰器实例与事件 role 独立；熔断按身份共享。
 */
export function createRoleFallbackClient(opts: {
  role: Exclude<ModelRole, "executor">;
  primary: FallbackEndpoint;
  env?: NodeJS.ProcessEnv;
  onFallback?: (info: FallbackInfo) => void;
  /** 执行者链上的备用端点（不含 primary）；inherit 时必填且可为空数组→不包 */
  executorFallbacks?: FallbackEndpoint[];
  breakerRegistry?: CircuitBreakerRegistry;
}): ModelClient {
  const env = opts.env ?? process.env;
  const mode = readRoleFallbackMode(opts.role, env);
  if (mode.mode === "none") return opts.primary.client;
  if (mode.mode === "inherit") {
    const inherited = opts.executorFallbacks ?? [];
    if (inherited.length === 0) return opts.primary.client;
    return createFallbackClient({
      primary: opts.primary,
      env,
      fallbackEndpoints: inherited,
      config: { ...readFallbackEnv(env), model: inherited[0]?.name },
      ...(opts.onFallback ? { onFallback: opts.onFallback } : {}),
      role: opts.role,
      ...(opts.breakerRegistry ? { breakerRegistry: opts.breakerRegistry } : {}),
    });
  }
  return createFallbackClient({
    primary: opts.primary,
    env,
    config: mode.config,
    ...(opts.onFallback ? { onFallback: opts.onFallback } : {}),
    role: opts.role,
    ...(opts.breakerRegistry ? { breakerRegistry: opts.breakerRegistry } : {}),
  });
}

/** 从执行者 FallbackModelClient 取出备用端点（供 inherit）；非装饰器则空 */
export function executorBackupEndpoints(client: ModelClient): FallbackEndpoint[] {
  if (client instanceof FallbackModelClient) return client.backupEndpoints();
  return [];
}

/**
 * MODEL-01b — 端点能力 / 健康探针。
 *
 * 为什么要它：compat 此前只靠 `claude-*` 名称猜测。名称对的时候没事；名称错了
 * （例如某家 compat 端点挂了个 `claude-xxx` 别名，或原生 Claude 走了非标准名）
 * 就会把 thinking/effort 打到不认的端点上 → 永久性 400，降级链也救不了
 * （认证/4xx 不降级是 MODEL-01a 的纪律）。
 *
 * 哲学（与 router 同款 fail-open，与 verifier 相反）：
 *   - **能力旗标 fail-open**：探针失败 / 判不清 → 退回名称猜测。错判成
 *     compat=true 只是关掉思考；错判成 compat=false 会让 DeepSeek 类端点
 *     直接 400——前者可恢复，后者不可。
 *   - **健康位如实**：探针失败就标 unhealthy，路由 stub 可据此偏好；但若
 *     全链都 unhealthy，仍允许尝试（fail-open：探针不是准入闸门）。
 *
 * 触发：仅 `AGENT_MODEL_PROBE=1`。远程与 loopback 都不默认打——
 * 确定性 eval 的 mock 也在 loopback 上，自动探针会吃掉脚本队列。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inspectProviderEndpoint } from "./provider-config.js";

export type CapabilitySource = "probe" | "name" | "sticky" | "assumed";

export type ModelProviderKind = "anthropic" | "openai";

export interface EndpointIdentity {
  provider: ModelProviderKind;
  model: string;
  /** 归一化后的 origin；缺省 = 该 provider 的官方默认（不进 key） */
  baseURL?: string;
}

export interface EndpointCapabilities {
  identity: EndpointIdentity;
  healthy: boolean;
  /** true = 不发 Claude 专属 thinking / effort / cache_control */
  compat: boolean;
  latencyMs: number | null;
  source: CapabilitySource;
  probedAt: number;
  reason?: string;
}

export const DEFAULT_PROBE_TTL_MS = 300_000;

/** 进程内粘性结果：同一端点身份在 TTL 内不重复探针 */
const stickyCache = new Map<string, EndpointCapabilities>();

/** 清空进程内两张表（探针粘性 + 学到的窗口）；不碰磁盘文件、不改 store 配置 */
export function clearCapabilityCache(): void {
  stickyCache.clear();
  learnedWindows.clear();
}

// ---------------------------------------------------------------- 学到的上下文窗口

/**
 * 从一次真实的 context-overflow 400 学到的窗口（MEM-01 窗口 / 预算分离的第二级来源）。
 *
 * 为什么它比登记表（`model-windows.ts`）优先：登记表是"官方说的"，这条是**这台端点**
 * 亲口说的——同名模型挂在不同兼容端点后面可以被配成不同窗口。为什么它比 env 低：
 * 操作员显式写的 `AGENT_CONTEXT_WINDOW` 是有意为之，机器学到的数不该压过人。
 *
 * 粘性 + TTL（30 天）：窗口是模型的事实，不是会话状态，跨 run 跨进程都该记得；
 * 但厂商会升窗口（Kimi K2→K3 从 256k 到 1M），所以不永久——过期就退回登记表 / unknown，
 * 下一次 400 再学。**只存身份键（provider|model|origin）与数字，永不存 key。**
 */
export interface LearnedContextWindow {
  windowTokens: number;
  learnedAt: number;
  /** 目前只有一种证据；留字段是为了以后能区分"探针量出来的"与"撞 400 学到的" */
  evidence: "overflow_400";
}

export const DEFAULT_LEARNED_WINDOW_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const learnedWindows = new Map<string, LearnedContextWindow>();
/** 磁盘落点；null = 只在进程内记（注入 modelClient 的测试宿主缺省如此——仪器纪律） */
let capabilityStoreFile: string | null = null;

interface CapabilityStoreFileShape {
  version: 1;
  contextWindows: Record<string, LearnedContextWindow>;
}

/**
 * 缺省落点：与台账 / 记忆 / 历史同一套约定——cwd 下的 `.agent-capabilities.json`，
 * `AGENT_CAPABILITY_CACHE` 可改路径（绝对或相对 cwd）。
 */
export function capabilityStorePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const override = env.AGENT_CAPABILITY_CACHE;
  if (override && override.trim()) return path.resolve(cwd, override.trim());
  return path.join(cwd, ".agent-capabilities.json");
}

/**
 * 配置磁盘落点并同步装载已有内容进内存表。**永不抛**：文件坏了 / 读不到就当空表——
 * 能力缓存是加速器不是准入闸门，它坏了不能把宿主拖死。
 * `file: null` = 关掉落盘（只留内存表）。
 * @returns 装载进来的条数（诊断用）
 */
export function configureCapabilityStore(opts: { file: string | null }): { loaded: number } {
  capabilityStoreFile = opts.file;
  if (!opts.file) return { loaded: 0 };
  try {
    const raw = readFileSync(opts.file, "utf8");
    const parsed = JSON.parse(raw) as Partial<CapabilityStoreFileShape>;
    const windows = parsed && typeof parsed === "object" ? parsed.contextWindows : undefined;
    let loaded = 0;
    if (windows && typeof windows === "object") {
      for (const [key, value] of Object.entries(windows)) {
        if (!value || typeof value !== "object") continue;
        const tokens = Number((value as LearnedContextWindow).windowTokens);
        const at = Number((value as LearnedContextWindow).learnedAt);
        if (!Number.isInteger(tokens) || tokens < MIN_LEARNABLE_WINDOW || !Number.isFinite(at)) continue;
        learnedWindows.set(key, { windowTokens: tokens, learnedAt: at, evidence: "overflow_400" });
        loaded += 1;
      }
    }
    return { loaded };
  } catch {
    return { loaded: 0 };
  }
}

export function capabilityStoreFilePath(): string | null {
  return capabilityStoreFile;
}

function persistCapabilityStore(): void {
  if (!capabilityStoreFile) return;
  try {
    const shape: CapabilityStoreFileShape = { version: 1, contextWindows: Object.fromEntries(learnedWindows) };
    mkdirSync(path.dirname(capabilityStoreFile), { recursive: true });
    const tmp = `${capabilityStoreFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(shape, null, 2)}\n`, "utf8");
    renameSync(tmp, capabilityStoreFile);
  } catch {
    // 落盘失败就当这次没记——下次 400 会再学；绝不让缓存把运行搞挂
  }
}

/** 小于这个数的"窗口"不可信（没有模型的窗口小于 1k；报文里的数若这么小，多半解析到了别的字段） */
const MIN_LEARNABLE_WINDOW = 1_024;

/**
 * 记下一个学到的窗口。非法值（非正整数 / 小于 1k）忽略并返回 null。
 * 同身份重复学到同一个数也刷新时间戳（TTL 从最近一次证据起算）。
 */
export function learnContextWindow(
  identity: EndpointIdentity,
  windowTokens: number,
  now = Date.now(),
): LearnedContextWindow | null {
  if (!Number.isInteger(windowTokens) || windowTokens < MIN_LEARNABLE_WINDOW) return null;
  const entry: LearnedContextWindow = { windowTokens, learnedAt: now, evidence: "overflow_400" };
  learnedWindows.set(endpointIdentityKey(identity), entry);
  persistCapabilityStore();
  return entry;
}

/** 读学到的窗口；过 TTL 视为不存在（并从内存表删掉，磁盘文件下次写入时随之清理） */
export function getLearnedContextWindow(
  identity: EndpointIdentity,
  now = Date.now(),
  ttlMs = DEFAULT_LEARNED_WINDOW_TTL_MS,
): LearnedContextWindow | undefined {
  const key = endpointIdentityKey(identity);
  const hit = learnedWindows.get(key);
  if (!hit) return undefined;
  if (now - hit.learnedAt > ttlMs) {
    learnedWindows.delete(key);
    return undefined;
  }
  return hit;
}

/**
 * 从 context-overflow 400 的报文里解析端点声明的窗口大小（学习钩子的输入）。
 *
 * 只认两种**已在真机 / SDK 上见过**的措辞，取的是"最大值"那个数而不是"你发了多少"：
 *  - OpenAI / DeepSeek（含兼容路由把 JSON 整段塞进 message 的形状）：
 *    「This model's maximum context length is N tokens. However, you requested …」→ N
 *  - Anthropic：「prompt is too long: N tokens > M maximum」→ M
 * 措辞对不上就返回 null——宁可不学，不能学错：学错的数会变成下一次运行的预算上限。
 * 调用方应先用 `isContextOverflowError` 确认这确实是超长错误。
 */
export function parseContextWindowFromOverflowError(err: unknown): number | null {
  const texts: string[] = [];
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") texts.push(message);
    const nested = (err as { error?: { message?: unknown; error?: { message?: unknown } } }).error;
    if (nested && typeof nested === "object") {
      if (typeof nested.message === "string") texts.push(nested.message);
      if (nested.error && typeof nested.error === "object" && typeof nested.error.message === "string") {
        texts.push(nested.error.message);
      }
    }
  } else if (typeof err === "string") {
    texts.push(err);
  }
  for (const text of texts) {
    const openai = /maximum context length is\s+(\d[\d,]*)\s+tokens/i.exec(text);
    if (openai) return toWindow(openai[1]!);
    const anthropic = /(\d[\d,]*)\s+tokens\s*>\s*(\d[\d,]*)\s+maximum/i.exec(text);
    if (anthropic) return toWindow(anthropic[2]!);
  }
  return null;
}

function toWindow(digits: string): number | null {
  const n = Number(digits.replace(/,/g, ""));
  return Number.isInteger(n) && n >= MIN_LEARNABLE_WINDOW ? n : null;
}

export function endpointIdentityKey(id: EndpointIdentity): string {
  const base = normalizeBaseForKey(id.baseURL);
  return `${id.provider}|${id.model}|${base}`;
}

function normalizeBaseForKey(baseURL: string | undefined): string {
  if (!baseURL?.trim()) return "";
  const inspected = inspectProviderEndpoint(baseURL.trim());
  return inspected.valid ? inspected.origin : baseURL.trim().replace(/\/+$/, "");
}

/** 名称猜测：openai 协议一律 compat；anthropic 协议非 claude-* 即 compat */
export function guessCompatFromName(model: string, provider: ModelProviderKind): boolean {
  if (provider === "openai") return true;
  return !model.startsWith("claude");
}

/**
 * 要不要发探针。
 *
 * **只认 `AGENT_MODEL_PROBE=1`**。loopback 不自动开——确定性 eval / 本机 mock
 * 也走 loopback，自动探针会吃掉脚本队列里的第一条，把整批场景打成"文件不存在"。
 * 测探针的用例显式翻 env；远程真端点同样要显式打开（省启动往返）。
 */
export function shouldRunModelProbe(
  env: NodeJS.ProcessEnv = process.env,
  _baseURL?: string,
): boolean {
  return env.AGENT_MODEL_PROBE === "1";
}

export function getStickyCapabilities(key: string, now = Date.now(), ttlMs = DEFAULT_PROBE_TTL_MS): EndpointCapabilities | undefined {
  const hit = stickyCache.get(key);
  if (!hit) return undefined;
  if (now - hit.probedAt > ttlMs) {
    stickyCache.delete(key);
    return undefined;
  }
  return { ...hit, source: "sticky" };
}

export function setStickyCapabilities(caps: EndpointCapabilities): void {
  stickyCache.set(endpointIdentityKey(caps.identity), { ...caps, source: "probe" });
}

export interface ProbeOptions {
  identity: EndpointIdentity;
  apiKey?: string;
  /** 注入 fetch：单测不需真 HTTP；真机/mock 走全局 fetch */
  fetchImpl?: typeof fetch;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** 跳过粘性缓存强制重探 */
  force?: boolean;
  signal?: AbortSignal;
}

/**
 * 轻量预检：一次最小 messages / chat.completions 请求。
 *
 * Anthropic 路径故意带 `thinking: adaptive`——原生端点 200，compat 端点通常
 * 400 并提到 thinking。据此区分能力，而不是猜名字。
 * OpenAI 路径只做健康检查（协议本身就是 compat）。
 */
export async function probeEndpointCapabilities(opts: ProbeOptions): Promise<EndpointCapabilities> {
  const now = opts.now ?? Date.now;
  const env = opts.env ?? process.env;
  const ttl = readProbeTtl(env);
  const key = endpointIdentityKey(opts.identity);
  if (!opts.force) {
    const sticky = getStickyCapabilities(key, now(), ttl);
    if (sticky) return sticky;
  }

  const nameCompat = guessCompatFromName(opts.identity.model, opts.identity.provider);
  if (!shouldRunModelProbe(env, opts.identity.baseURL)) {
    const assumed: EndpointCapabilities = {
      identity: opts.identity,
      healthy: true,
      compat: nameCompat,
      latencyMs: null,
      source: "name",
      probedAt: now(),
      reason: "probe_skipped",
    };
    return assumed;
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return {
      identity: opts.identity,
      healthy: true,
      compat: nameCompat,
      latencyMs: null,
      source: "assumed",
      probedAt: now(),
      reason: "fetch_unavailable",
    };
  }

  const started = now();
  try {
    const result =
      opts.identity.provider === "openai"
        ? await probeOpenAI(opts, fetchImpl)
        : await probeAnthropic(opts, fetchImpl, nameCompat);
    const caps: EndpointCapabilities = {
      ...result,
      identity: opts.identity,
      latencyMs: Math.max(0, now() - started),
      probedAt: now(),
      source: "probe",
    };
    setStickyCapabilities(caps);
    return caps;
  } catch (err) {
    const caps: EndpointCapabilities = {
      identity: opts.identity,
      healthy: false,
      compat: nameCompat,
      latencyMs: Math.max(0, now() - started),
      source: "probe",
      probedAt: now(),
      reason: err instanceof Error ? err.message : String(err),
    };
    // 失败也粘：短时间内别对着挂掉的端点连打
    setStickyCapabilities(caps);
    return caps;
  }
}

function readProbeTtl(env: NodeJS.ProcessEnv): number {
  const raw = env.AGENT_MODEL_PROBE_TTL_MS?.trim();
  if (!raw) return DEFAULT_PROBE_TTL_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`AGENT_MODEL_PROBE_TTL_MS 无效：需要 ≥ 0 的整数，实际收到 "${raw}"`);
  }
  return n;
}

async function probeAnthropic(
  opts: ProbeOptions,
  fetchImpl: typeof fetch,
  nameCompat: boolean,
): Promise<Pick<EndpointCapabilities, "healthy" | "compat" | "reason">> {
  const url = joinUrl(opts.identity.baseURL, "/v1/messages");
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(opts.apiKey ? { "x-api-key": opts.apiKey } : {}),
    },
    body: JSON.stringify({
      model: opts.identity.model,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
      // 能力探针：原生接受，compat 通常 400
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    }),
    signal: opts.signal,
  });

  if (res.ok) {
    return { healthy: true, compat: false, reason: "native_accepted_thinking" };
  }

  const text = await res.text().catch(() => "");
  const lower = text.toLowerCase();
  if (res.status === 400 && (lower.includes("thinking") || lower.includes("output_config") || lower.includes("effort"))) {
    // 端点活着，只是不认 Claude 专属字段 → compat
    return { healthy: true, compat: true, reason: `compat_rejected_extensions:${res.status}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { healthy: false, compat: nameCompat, reason: `auth:${res.status}` };
  }
  if (res.status >= 500 || res.status === 429) {
    return { healthy: false, compat: nameCompat, reason: `upstream:${res.status}` };
  }
  // 其它 4xx：端点可达但请求形态不对——能力不明，fail-open 到名称
  return { healthy: true, compat: nameCompat, reason: `reachable_status:${res.status}` };
}

async function probeOpenAI(
  opts: ProbeOptions,
  fetchImpl: typeof fetch,
): Promise<Pick<EndpointCapabilities, "healthy" | "compat" | "reason">> {
  const url = joinUrl(opts.identity.baseURL, "/chat/completions");
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: opts.identity.model,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    }),
    signal: opts.signal,
  });

  if (res.ok) {
    return { healthy: true, compat: true, reason: "openai_ok" };
  }
  if (res.status === 401 || res.status === 403) {
    return { healthy: false, compat: true, reason: `auth:${res.status}` };
  }
  if (res.status >= 500 || res.status === 429) {
    return { healthy: false, compat: true, reason: `upstream:${res.status}` };
  }
  return { healthy: true, compat: true, reason: `reachable_status:${res.status}` };
}

function joinUrl(baseURL: string | undefined, path: string): string {
  const base = (baseURL?.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
  // OpenAI SDK baseURL 常带 /v1；chat 路径是 /chat/completions
  if (path === "/chat/completions") {
    if (base.endsWith("/v1")) return `${base}${path}`;
    return `${base}/v1${path}`;
  }
  // Anthropic：base 已含或不含 /v1 都要落到 .../v1/messages
  if (base.endsWith("/v1") && path.startsWith("/v1/")) {
    return `${base}${path.slice(3)}`;
  }
  return `${base}${path}`;
}

/**
 * 路由 stub 用：有粘性证据且标了 unhealthy 才算"已知不健康"。
 * 没探针过 = 未知 = 当作可试（fail-open）。
 */
export function stickySaysUnhealthy(identity: EndpointIdentity, now = Date.now(), ttlMs = DEFAULT_PROBE_TTL_MS): boolean {
  const hit = getStickyCapabilities(endpointIdentityKey(identity), now, ttlMs);
  return hit !== undefined && hit.healthy === false;
}

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
 * 触发：`AGENT_MODEL_PROBE=1`，或 baseURL 是 loopback（本地 mock / 自测）。
 * 远程真端点默认**不**打探针——省一次启动往返，也避免无 key 时误伤。
 */
import { isLoopbackHostname, inspectProviderEndpoint } from "./provider-config.js";

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

export function clearCapabilityCache(): void {
  stickyCache.clear();
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
 * loopback 默认开：mock provider 与本地自测是 MODEL-01b 的主验证面，
 * 不靠手动翻 env。远程必须显式 `AGENT_MODEL_PROBE=1`。
 */
export function shouldRunModelProbe(
  env: NodeJS.ProcessEnv = process.env,
  baseURL?: string,
): boolean {
  if (env.AGENT_MODEL_PROBE === "0") return false;
  if (env.AGENT_MODEL_PROBE === "1") return true;
  if (!baseURL?.trim()) return false;
  try {
    const host = new URL(baseURL.trim()).hostname;
    return isLoopbackHostname(host);
  } catch {
    return false;
  }
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

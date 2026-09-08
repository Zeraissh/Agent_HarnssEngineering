/**
 * 模型库 + 角色分配的持久化存储（MODEL-02）。
 *
 * 落点：<workdir>/.agent-models.json（真实宿主默认；注入 modelClient 的测试宿主
 * 经 UiServerOptions.modelStoreFile 显式给路径，仪器纪律同 roleEnv——假模型宿主
 * 不该被开发机残留的库文件武装）。
 *
 * 纪律：
 *   - 原子写：临时文件 + rename；读到的文件损坏 → 备份为 .bak 后从零开始，
 *     绝不带着半截 JSON 启动。
 *   - apiKey 只进不出：redactStore 是唯一的出栈通道，永不含 apiKey 原文。
 *   - PUT 语义：apiKey 字段省略 = 保持不变；空字符串 = 清除（改走环境变量）。
 *   - 生效优先级：运行时库 > env。库文件存在就以库为准（roles 里 null =
 *     跟随执行 / 不配置）；库文件不存在才把 env 现状合成一份初始库。
 */
import { randomUUID } from "node:crypto";
import { copyFileSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { isLoopbackHostname } from "../src/provider-config.js";

export const MODEL_STORE_SCHEMA_VERSION = 1;
export const MODEL_STORE_FILENAME = ".agent-models.json";

export type ModelProvider = "anthropic" | "openai";
export type RoleKey = "executor" | "planner" | "verifier" | "vision" | "image";
export const ROLE_KEYS: readonly RoleKey[] = ["executor", "planner", "verifier", "vision", "image"];

export interface ModelEntry {
  id: string;
  label: string;
  provider: ModelProvider;
  model: string;
  /** 空串 = 用 provider 默认端点 */
  baseUrl: string;
  /** 空串 = 用该 provider 的环境变量 key（ANTHROPIC_API_KEY / OPENAI_API_KEY） */
  apiKey: string;
}

/**
 * roles 语义：executor 必须指向库中条目（null 仅在"还没有库"的合成阶段出现）；
 * planner / verifier 的 null = 跟随执行；vision / image 的 null = 不配置。
 */
export interface ModelRoles {
  executor: string | null;
  planner: string | null;
  verifier: string | null;
  vision: string | null;
  image: string | null;
}

export interface ModelStore {
  schemaVersion: typeof MODEL_STORE_SCHEMA_VERSION;
  models: ModelEntry[];
  roles: ModelRoles;
}

/** GET /api/models 的出栈形状：hasApiKey 布尔，永不下发 apiKey 原文。 */
export interface PublicModelEntry {
  id: string;
  label: string;
  provider: ModelProvider;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
}

export interface PublicModelStore {
  models: PublicModelEntry[];
  roles: ModelRoles;
  source: "store" | "env";
}

// ---------------------------------------------------------------
// 字段级校验（与 src/provider.ts createModelClientFromEnv 同口径）
// ---------------------------------------------------------------

const MODEL_ID_RE = /^[A-Za-z0-9:_-]{1,64}$/;
const LABEL_MAX = 80;

export function isValidModelName(model: string): boolean {
  return Boolean(model)
    && model.length <= 200
    && model === model.trim()
    && !/[\u0000-\u001f\u007f]/.test(model);
}

/**
 * baseUrl 归一（规则与 cross-app/electron model-settings-store.cjs 的
 * normalizeBaseUrl 逐条对齐）：https 或 loopback http；不含用户密、query、fragment；
 * 空值归一为 ""（= provider 默认端点）。非法输入抛中文错误，由 PUT 层收成 400。
 */
export function normalizeBaseUrl(value: unknown): string {
  if (value === undefined || value === null || String(value).trim() === "") return "";
  const raw = String(value).trim();
  if (raw.length > 2048) throw new Error("Base URL 过长（上限 2048 字符）");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Base URL 不是有效 URL");
  }
  if (parsed.username || parsed.password) throw new Error("Base URL 不能包含用户名或密码");
  if (parsed.search || parsed.hash) throw new Error("Base URL 不能包含 query 或 fragment");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))) {
    throw new Error("远程 Base URL 必须使用 HTTPS；HTTP 只允许本机回环地址");
  }
  return parsed.href.replace(/\/$/, "");
}

export function emptyStore(): ModelStore {
  return {
    schemaVersion: MODEL_STORE_SCHEMA_VERSION,
    models: [],
    roles: { executor: null, planner: null, verifier: null, vision: null, image: null },
  };
}

// ---------------------------------------------------------------
// 容错解析 / 持久化
// ---------------------------------------------------------------

/** 单条目的宽松解析：字段不合法 → null（调用方整条丢弃，不拖垮其余条目）。 */
function parseEntry(raw: unknown): ModelEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !MODEL_ID_RE.test(o.id)) return null;
  if (typeof o.model !== "string" || !isValidModelName(o.model)) return null;
  if (o.provider !== "anthropic" && o.provider !== "openai") return null;
  let baseUrl = "";
  try {
    baseUrl = normalizeBaseUrl(o.baseUrl);
  } catch {
    return null;
  }
  return {
    id: o.id,
    label: typeof o.label === "string" && o.label.trim() ? o.label.trim().slice(0, LABEL_MAX) : o.model,
    provider: o.provider,
    model: o.model,
    baseUrl,
    apiKey: typeof o.apiKey === "string" ? o.apiKey : "",
  };
}

/** 整库宽松解析：坏 JSON / 版本不符 / 非对象 → null；条目逐条过滤，roles 悬空引用收编为 null。 */
export function parseModelStore(raw: string | null | undefined): ModelStore | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.schemaVersion !== MODEL_STORE_SCHEMA_VERSION) return null;
  const store = emptyStore();
  const seen = new Set<string>();
  if (Array.isArray(o.models)) {
    for (const rawEntry of o.models) {
      const entry = parseEntry(rawEntry);
      if (!entry || seen.has(entry.id)) continue;
      seen.add(entry.id);
      store.models.push(entry);
    }
  }
  const rawRoles = (o.roles && typeof o.roles === "object" ? o.roles : {}) as Record<string, unknown>;
  for (const role of ROLE_KEYS) {
    const id = rawRoles[role];
    store.roles[role] = typeof id === "string" && seen.has(id) ? id : null;
  }
  return store;
}

export interface LoadModelStoreResult {
  /** null = 文件不存在或已损坏（损坏时会先备份 .bak） */
  store: ModelStore | null;
  /**  true = 原文件损坏，已备份为 <file>.bak */
  recoveredFromCorrupt: boolean;
}

/**
 * 读库。文件不存在 → { store: null }；损坏 → 备份 .bak 后 { store: null, recovered: true }。
 * 同步读：启动装配是同步契约（createUiServer），这里与 createModelClientFromEnv 同一步调。
 */
export function loadModelStore(file: string): LoadModelStoreResult {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { store: null, recoveredFromCorrupt: false };
  }
  const store = parseModelStore(raw);
  if (store) return { store, recoveredFromCorrupt: false };
  try {
    copyFileSync(file, `${file}.bak`);
  } catch { /* 备份失败不挡启动——库已经判死，从零开始 */ }
  return { store: null, recoveredFromCorrupt: true };
}

/** 原子写：临时文件 + rename；含 apiKey，尽力收窄权限到 0600（Windows 上 chmod 是尽力而为）。 */
export function saveModelStore(file: string, store: ModelStore): void {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  try {
    chmodSync(tmp, 0o600);
  } catch { /* Windows 上语义有限，忽略 */ }
  renameSync(tmp, file);
}

// ---------------------------------------------------------------
// env → 初始库合成（库文件不存在时的一次性桥接）
// ---------------------------------------------------------------

interface EnvLike {
  [key: string]: string | undefined;
}

function envProvider(raw: string | undefined): ModelProvider {
  return raw === "openai" ? "openai" : "anthropic";
}

function envBaseUrl(env: EnvLike, provider: ModelProvider): string {
  const raw = provider === "openai" ? env.OPENAI_BASE_URL : env.ANTHROPIC_BASE_URL;
  try {
    return normalizeBaseUrl(raw);
  } catch {
    return "";
  }
}

/**
 * 把 env 现状合成一份初始库。executor 读 executorEnv（真实宿主 = process.env，
 * 口径与既有 `process.env.AGENT_MODEL` 一致）；verifier / planner / vision / image 读
 * roleEnv（仪器纪律：注入宿主拿到的是空 env，自然合成不出角色条目）。
 *
 * env 里的 key 处理分两层：executor 条目的 apiKey 一律 ""（= 继续走
 * ANTHROPIC_API_KEY / OPENAI_API_KEY 环境变量，与旧装配逐字一致）；角色条目
 * 捕获 AGENT_<ROLE>_API_KEY ——provider 的环境变量回退覆盖不到这个角色专属
 * 变量，不捕获的话旧配置会当场装不起来（OpenAI SDK 对空 key 是 fail-closed）。
 * 合成库只在内存里（source="env"），key 不落盘；GET 出栈经 redactStore 脱敏。
 */
export function synthesizeStoreFromEnv(
  executorEnv: EnvLike,
  roleEnv: EnvLike,
): ModelStore {
  const store = emptyStore();
  const executorModel = executorEnv.AGENT_MODEL ?? "claude-opus-4-8";
  const provider = envProvider(executorEnv.AGENT_PROVIDER);
  const executorEntry: ModelEntry = {
    id: "env:executor",
    label: `环境变量 · ${executorModel}`,
    provider,
    model: executorModel,
    baseUrl: envBaseUrl(executorEnv, provider),
    apiKey: "",
  };
  store.models.push(executorEntry);
  store.roles.executor = executorEntry.id;

  for (const [role, prefix] of [
    ["verifier", "VERIFIER"],
    ["planner", "PLANNER"],
    ["vision", "VISION"],
    ["image", "IMAGE"],
  ] as const) {
    const name = roleEnv[`AGENT_${prefix}_MODEL`];
    if (!name || !isValidModelName(name)) continue;
    const roleProvider = envProvider(roleEnv[`AGENT_${prefix}_PROVIDER`]);
    let baseUrl = "";
    try {
      baseUrl = normalizeBaseUrl(roleEnv[`AGENT_${prefix}_BASE_URL`]);
    } catch {
      baseUrl = "";
    }
    const entry: ModelEntry = {
      id: `env:${role}`,
      label: `环境变量 · ${name}`,
      provider: roleProvider,
      model: name,
      baseUrl,
      // 角色专属 key（AGENT_<ROLE>_API_KEY）必须随条目走——见函数头注释
      apiKey: roleEnv[`AGENT_${prefix}_API_KEY`] ?? "",
    };
    store.models.push(entry);
    store.roles[role] = entry.id;
  }
  return store;
}

// ---------------------------------------------------------------
// PUT 校验（整表替换；apiKey 省略 = 沿用 previous 同 id 条目）
// ---------------------------------------------------------------

export interface ModelConfigInput {
  models?: unknown;
  roles?: unknown;
}

export type ValidateResult =
  | { ok: true; store: ModelStore }
  | { ok: false; errors: string[] };

export function validateModelConfig(
  input: ModelConfigInput,
  previous: ModelStore | null,
): ValidateResult {
  const errors: string[] = [];
  if (!input || typeof input !== "object") {
    return { ok: false, errors: ["请求体必须是 JSON 对象"] };
  }
  if (!Array.isArray(input.models)) {
    return { ok: false, errors: ["models 必须是数组"] };
  }
  if (input.models.length > 50) {
    return { ok: false, errors: ["模型库最多 50 条"] };
  }
  const previousById = new Map((previous?.models ?? []).map((m) => [m.id, m]));

  const store = emptyStore();
  const seen = new Set<string>();
  for (const [index, rawEntry] of input.models.entries()) {
    const where = `models[${index}]`;
    if (!rawEntry || typeof rawEntry !== "object") {
      errors.push(`${where} 必须是对象`);
      continue;
    }
    const o = rawEntry as Record<string, unknown>;

    // id：省略/空 → 服务端分配；自带则需合法且不重复
    let id: string;
    if (o.id === undefined || o.id === null || o.id === "") {
      id = randomUUID();
    } else if (typeof o.id === "string" && MODEL_ID_RE.test(o.id)) {
      id = o.id;
    } else {
      errors.push(`${where}.id 只能包含字母、数字、:、_、-（最长 64）`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`${where}.id 重复：${id}`);
      continue;
    }

    if (o.provider !== "anthropic" && o.provider !== "openai") {
      errors.push(`${where}.provider 只能是 "anthropic" 或 "openai"`);
      continue;
    }
    if (typeof o.model !== "string" || !isValidModelName(o.model)) {
      errors.push(`${where}.model 无效：不能为空、不能带首尾空白或控制字符，且最长 200 字符`);
      continue;
    }
    let baseUrl = "";
    try {
      baseUrl = normalizeBaseUrl(o.baseUrl);
    } catch (error) {
      errors.push(`${where}.baseUrl：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const label = typeof o.label === "string" && o.label.trim() ? o.label.trim().slice(0, LABEL_MAX) : o.model;

    // apiKey 三态：省略 = 沿用旧值；"" = 清除（走环境变量）；非空 = 更新
    let apiKey = "";
    if (typeof o.apiKey === "string" && o.apiKey !== "") {
      apiKey = o.apiKey;
    } else if (o.apiKey === undefined) {
      apiKey = previousById.get(id)?.apiKey ?? "";
    }

    seen.add(id);
    store.models.push({ id, label, provider: o.provider, model: o.model, baseUrl, apiKey });
  }

  const rawRoles = (input.roles && typeof input.roles === "object" ? input.roles : null) as Record<string, unknown> | null;
  if (!rawRoles) {
    errors.push("roles 必须是对象：{ executor, planner, verifier, vision, image }");
  } else {
    for (const role of ROLE_KEYS) {
      const id = rawRoles[role];
      if (id === null || id === undefined || id === "") {
        store.roles[role] = null;
        continue;
      }
      if (typeof id !== "string" || !seen.has(id)) {
        errors.push(`roles.${role} 引用了不存在的模型 id：${String(id)}`);
        continue;
      }
      store.roles[role] = id;
    }
    // 执行者是唯一不可降级的角色：没有执行者整个宿主就没有出发点
    if (!store.roles.executor) {
      errors.push("roles.executor 必须指向库中的一个模型（执行者不可为空）");
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, store };
}

// ---------------------------------------------------------------
// 出栈脱敏
// ---------------------------------------------------------------

export function redactStore(store: ModelStore, source: "store" | "env"): PublicModelStore {
  return {
    models: store.models.map((m) => ({
      id: m.id,
      label: m.label,
      provider: m.provider,
      model: m.model,
      baseUrl: m.baseUrl,
      hasApiKey: m.apiKey !== "",
    })),
    roles: { ...store.roles },
    source,
  };
}

/** 按角色取当前库条目；null = 跟随执行 / 不配置。 */
export function roleEntryOf(store: ModelStore, role: RoleKey): ModelEntry | null {
  const id = store.roles[role];
  if (!id) return null;
  return store.models.find((m) => m.id === id) ?? null;
}

// ---------------------------------------------------------------
// 连通性测试（POST /api/models/test）：1 token 的最小请求，10s 超时
// ---------------------------------------------------------------

export interface ModelTestResult {
  ok: boolean;
  error?: string;
}

/**
 * 发一个 max_tokens=1 的最小请求验证端点 + key + 模型名三元组。
 * 只回报状态码/网络错误类别，**不回传响应体**——错误体可能夹着端点实现
 * 的内部细节，没必要出栈。
 */
export async function testModelEndpoint(opts: {
  provider: ModelProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}): Promise<ModelTestResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const isOpenAI = opts.provider === "openai";
    const base = (opts.baseUrl || (isOpenAI ? "https://api.openai.com" : "https://api.anthropic.com")).replace(/\/$/, "");
    const res = await fetch(isOpenAI ? `${base}/v1/chat/completions` : `${base}/v1/messages`, {
      method: "POST",
      headers: isOpenAI
        ? { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` }
        : { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: controller.signal,
    });
    // 应答体必须吃掉，否则连接悬挂到超时
    await res.text().catch(() => "");
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, error: `鉴权失败（HTTP ${res.status}）——请检查 API Key` };
    if (res.status === 404) return { ok: false, error: "端点或模型不存在（HTTP 404）——请检查 Base URL 与模型名" };
    return { ok: false, error: `端点返回 HTTP ${res.status}` };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, error: `连接超时（${Math.round(timeoutMs / 1000)} 秒）` };
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `连接失败：${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

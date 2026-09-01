'use strict';

const {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { isLoopbackHostname } = require('./network-policy.cjs');

const SCHEMA_VERSION = 1;
const PROVIDERS = new Set(['anthropic', 'openai']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const SETTINGS_FIELDS = new Set([
  'provider',
  'model',
  'baseUrl',
  'effort',
  'maxTokens',
  'contextLimit',
  'timeoutMs',
  'maxRetries',
  'dailyTokenBudget',
  'maxActiveRuns',
]);
const SAVE_FIELDS = new Set([...SETTINGS_FIELDS, 'apiKey', 'clearApiKey']);

const DEFAULT_SETTINGS = Object.freeze({
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  baseUrl: '',
  effort: 'high',
  maxTokens: null,
  contextLimit: null,
  timeoutMs: null,
  maxRetries: null,
  dailyTokenBudget: null,
  maxActiveRuns: null,
});

function normalizeBaseUrl(value) {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  const raw = String(value).trim();
  if (raw.length > 2048) throw new Error('API Base URL 过长');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('API Base URL 不是有效 URL');
  }
  if (parsed.username || parsed.password) throw new Error('API Base URL 不能包含用户名或密码');
  if (parsed.search || parsed.hash) throw new Error('API Base URL 不能包含 query 或 fragment');
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname))) {
    throw new Error('远程 API Base URL 必须使用 HTTPS；HTTP 只允许 loopback');
  }
  return parsed.href.replace(/\/$/, '');
}

function normalizeOptionalInteger(value, label, { min, max }) {
  if (value === undefined || value === null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${label} 必须是 ${min}–${max} 的整数`);
  }
  return number;
}

function assertOnlyFields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置格式无效');
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`未知设置字段：${unknown.join(', ')}`);
}

function normalizeSettings(input, { fromStorage = false } = {}) {
  assertOnlyFields(input, SETTINGS_FIELDS);
  const provider = String(input.provider ?? '').trim().toLowerCase();
  if (!PROVIDERS.has(provider)) throw new Error('Provider 只能是 anthropic 或 openai');

  const model = String(input.model ?? '').trim();
  if (!model || model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) {
    throw new Error('模型名不能为空、不能包含控制字符，且最长 200 字符');
  }

  const effort = String(input.effort ?? '').trim().toLowerCase();
  if (!EFFORTS.has(effort)) throw new Error('思考档位只能是 low/medium/high/xhigh/max');

  const normalized = {
    provider,
    model,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    effort,
    maxTokens: normalizeOptionalInteger(input.maxTokens, '单次输出上限', { min: 1, max: 1_000_000 }),
    contextLimit: normalizeOptionalInteger(input.contextLimit, '上下文上限', { min: 1, max: 2_000_000 }),
    timeoutMs: normalizeOptionalInteger(input.timeoutMs, '请求超时', { min: 1_000, max: 3_600_000 }),
    maxRetries: normalizeOptionalInteger(input.maxRetries, '重试次数', { min: 0, max: 10 }),
    dailyTokenBudget: normalizeOptionalInteger(input.dailyTokenBudget, '宿主日预算', { min: 0, max: 1_000_000_000_000 }),
    maxActiveRuns: normalizeOptionalInteger(input.maxActiveRuns, '最大并发任务数', { min: 1, max: 64 }),
  };

  // 存储格式必须完整，不能让损坏/旧字段被默认值悄悄补齐。
  if (fromStorage) {
    for (const field of SETTINGS_FIELDS) {
      if (!Object.hasOwn(input, field)) throw new Error(`设置文件缺少字段：${field}`);
    }
  }
  return normalized;
}

function integerFromEnvironment(value, bounds) {
  if (value === undefined || value === '') return null;
  try {
    return normalizeOptionalInteger(value, '环境变量', bounds);
  } catch {
    return null;
  }
}

function settingsFromEnvironment(environment = process.env) {
  const provider = PROVIDERS.has(String(environment.AGENT_PROVIDER ?? '').toLowerCase())
    ? String(environment.AGENT_PROVIDER).toLowerCase()
    : DEFAULT_SETTINGS.provider;
  const effort = EFFORTS.has(String(environment.AGENT_EFFORT ?? '').toLowerCase())
    ? String(environment.AGENT_EFFORT).toLowerCase()
    : DEFAULT_SETTINGS.effort;
  let baseUrl = provider === 'openai' ? environment.OPENAI_BASE_URL : environment.ANTHROPIC_BASE_URL;
  try {
    baseUrl = normalizeBaseUrl(baseUrl);
  } catch {
    baseUrl = '';
  }
  const rawModel = String(environment.AGENT_MODEL ?? DEFAULT_SETTINGS.model).trim();
  const model = rawModel && rawModel.length <= 200 && !/[\u0000-\u001f\u007f]/.test(rawModel)
    ? rawModel
    : DEFAULT_SETTINGS.model;
  return {
    provider,
    model,
    baseUrl,
    effort,
    maxTokens: integerFromEnvironment(environment.AGENT_MAX_TOKENS, { min: 1, max: 1_000_000 }),
    contextLimit: integerFromEnvironment(environment.AGENT_CONTEXT_LIMIT, { min: 1, max: 2_000_000 }),
    timeoutMs: integerFromEnvironment(environment.AGENT_TIMEOUT_MS, { min: 1_000, max: 3_600_000 }),
    maxRetries: integerFromEnvironment(environment.AGENT_MAX_RETRIES, { min: 0, max: 10 }),
    dailyTokenBudget: integerFromEnvironment(environment.AGENT_UI_DAILY_TOKEN_BUDGET, { min: 0, max: 1_000_000_000_000 }),
    maxActiveRuns: integerFromEnvironment(environment.AGENT_UI_MAX_ACTIVE_RUNS, { min: 1, max: 64 }),
  };
}

function isCanonicalBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32_768) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function credentialBinding(settings) {
  const defaultUrl = settings.provider === 'openai' ? 'https://api.openai.com' : 'https://api.anthropic.com';
  return `${settings.provider}|${new URL(settings.baseUrl || defaultUrl).origin}`;
}

function loadModelSettings(file, fallbackEnvironment = process.env) {
  if (!existsSync(file)) {
    return { record: null, settings: settingsFromEnvironment(fallbackEnvironment), warning: null };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed.schemaVersion !== SCHEMA_VERSION) throw new Error(`不支持的 schemaVersion ${parsed.schemaVersion}`);
    const settings = normalizeSettings(parsed.settings, { fromStorage: true });
    if (parsed.encryptedApiKey !== undefined) {
      if (!isCanonicalBase64(parsed.encryptedApiKey)) throw new Error('加密凭据格式无效');
      if (parsed.credentialBinding !== credentialBinding(settings)) {
        throw new Error('加密凭据与 provider/endpoint 绑定不匹配');
      }
    }
    const record = {
      schemaVersion: SCHEMA_VERSION,
      settings,
      ...(parsed.encryptedApiKey
        ? { encryptedApiKey: parsed.encryptedApiKey, credentialBinding: parsed.credentialBinding }
        : {}),
    };
    return { record, settings, warning: null };
  } catch (error) {
    return {
      record: null,
      settings: settingsFromEnvironment(fallbackEnvironment),
      warning: `模型设置文件损坏，已忽略：${error.message}`,
    };
  }
}

async function secureStorageAvailable(safeStorage, platform = process.platform) {
  if (!safeStorage || typeof safeStorage.isAsyncEncryptionAvailable !== 'function') return false;
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
  if (
    platform === 'linux' &&
    typeof safeStorage.getSelectedStorageBackend === 'function' &&
    safeStorage.getSelectedStorageBackend() === 'basic_text'
  ) {
    return false;
  }
  return true;
}

function writeRecord(file, record) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows 的真实保护由 DPAPI 完成；部分文件系统不支持 POSIX chmod。
  }
}

async function saveModelSettings(file, input, previousRecord, safeStorage, { platform = process.platform } = {}) {
  assertOnlyFields(input, SAVE_FIELDS);
  if (input.apiKey !== undefined && typeof input.apiKey !== 'string') throw new Error('API key 格式无效');
  if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean') {
    throw new Error('clearApiKey 必须是布尔值');
  }
  const settingsInput = Object.fromEntries([...SETTINGS_FIELDS].map((field) => [field, input[field]]));
  const settings = normalizeSettings(settingsInput);
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (apiKey.length > 8192 || /[\r\n\u0000]/.test(apiKey)) throw new Error('API key 格式无效');
  if (apiKey && input.clearApiKey) throw new Error('不能同时填写新 API key 并要求清除凭据');

  const nextBinding = credentialBinding(settings);
  let encryptedApiKey = input.clearApiKey ? undefined : previousRecord?.encryptedApiKey;
  let savedCredentialBinding = input.clearApiKey ? undefined : previousRecord?.credentialBinding;
  if (encryptedApiKey && savedCredentialBinding !== nextBinding && !apiKey) {
    throw new Error('Provider 或 API endpoint 已变化；请重新输入 API key，或显式清除已保存凭据');
  }
  if (apiKey) {
    if (!(await secureStorageAvailable(safeStorage, platform))) {
      throw new Error('操作系统安全存储不可用，拒绝以明文或弱加密保存 API key');
    }
    encryptedApiKey = (await safeStorage.encryptStringAsync(apiKey)).toString('base64');
    savedCredentialBinding = nextBinding;
  }

  const record = {
    schemaVersion: SCHEMA_VERSION,
    settings,
    ...(encryptedApiKey ? { encryptedApiKey, credentialBinding: savedCredentialBinding } : {}),
  };
  writeRecord(file, record);
  return record;
}

async function decryptStoredApiKey(record, safeStorage, { platform = process.platform } = {}) {
  if (!record?.encryptedApiKey) return { apiKey: null, rotatedRecord: record };
  if (!(await secureStorageAvailable(safeStorage, platform))) {
    throw new Error('操作系统安全存储当前不可用，无法启动使用已保存凭据的宿主');
  }
  const decrypted = await safeStorage.decryptStringAsync(Buffer.from(record.encryptedApiKey, 'base64'));
  let rotatedRecord = record;
  if (decrypted.shouldReEncrypt) {
    rotatedRecord = {
      ...record,
      encryptedApiKey: (await safeStorage.encryptStringAsync(decrypted.result)).toString('base64'),
    };
  }
  return { apiKey: decrypted.result, rotatedRecord };
}

async function modelEnvironment(record, safeStorage, options = {}) {
  if (!record) return { set: {}, unset: [], rotatedRecord: record };
  const { apiKey, rotatedRecord } = await decryptStoredApiKey(record, safeStorage, options);
  const settings = record.settings;
  const set = {
    AGENT_PROVIDER: settings.provider,
    AGENT_MODEL: settings.model,
    AGENT_EFFORT: settings.effort,
  };
  const unset = [];
  const baseKey = settings.provider === 'openai' ? 'OPENAI_BASE_URL' : 'ANTHROPIC_BASE_URL';
  const keyKey = settings.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  if (settings.baseUrl) set[baseKey] = settings.baseUrl;
  else unset.push(baseKey);
  if (apiKey) set[keyKey] = apiKey;

  const numeric = [
    ['maxTokens', 'AGENT_MAX_TOKENS'],
    ['contextLimit', 'AGENT_CONTEXT_LIMIT'],
    ['timeoutMs', 'AGENT_TIMEOUT_MS'],
    ['maxRetries', 'AGENT_MAX_RETRIES'],
    ['dailyTokenBudget', 'AGENT_UI_DAILY_TOKEN_BUDGET'],
    ['maxActiveRuns', 'AGENT_UI_MAX_ACTIVE_RUNS'],
  ];
  for (const [field, envName] of numeric) {
    if (settings[field] === null) unset.push(envName);
    else set[envName] = String(settings[field]);
  }
  return { set, unset, rotatedRecord };
}

function publicSettings(record, fallbackSettings, { editable, mode, environmentCredentialPresent, warning = null }) {
  const settings = record?.settings ?? fallbackSettings;
  const credentialSource = record?.encryptedApiKey
    ? 'system-store'
    : environmentCredentialPresent
      ? 'environment'
      : 'missing';
  return {
    settings,
    editable: Boolean(editable),
    mode,
    credentialPresent: credentialSource !== 'missing',
    credentialSource,
    warning,
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  SCHEMA_VERSION,
  loadModelSettings,
  modelEnvironment,
  normalizeSettings,
  publicSettings,
  saveModelSettings,
  secureStorageAvailable,
  settingsFromEnvironment,
  writeRecord,
};

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import settingsStore from '../electron/model-settings-store.cjs';
import networkPolicy from '../electron/network-policy.cjs';

const tempDirs = [];

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-harness-settings-'));
  tempDirs.push(dir);
  return join(dir, 'model-settings.json');
}

function input(overrides = {}) {
  return {
    provider: 'openai',
    model: 'test-model',
    baseUrl: 'https://api.example.test/v1/',
    effort: 'high',
    maxTokens: '4096',
    contextLimit: '',
    timeoutMs: '300000',
    maxRetries: '0',
    dailyTokenBudget: '',
    maxActiveRuns: '4',
    apiKey: '',
    clearApiKey: false,
    ...overrides,
  };
}

function fakeSafeStorage({ available = true, rotate = false } = {}) {
  return {
    async isAsyncEncryptionAvailable() {
      return available;
    },
    getSelectedStorageBackend() {
      return 'dpapi';
    },
    async encryptStringAsync(value) {
      return Buffer.from(`sealed:${value}`, 'utf8');
    },
    async decryptStringAsync(value) {
      return { result: value.toString('utf8').slice('sealed:'.length), shouldReEncrypt: rotate };
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Desktop model settings store', () => {
  it('loopback 判定只接受真实本机地址，不接受 127. 前缀域名', () => {
    expect(networkPolicy.isLoopbackHostname('localhost')).toBe(true);
    expect(networkPolicy.isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(networkPolicy.isLoopbackHostname('127.255.10.8')).toBe(true);
    expect(networkPolicy.isLoopbackHostname('[::1]')).toBe(true);
    expect(networkPolicy.isLoopbackHostname('127.attacker.example')).toBe(false);
    expect(networkPolicy.isLoopbackHostname('127.0.0.1.attacker.example')).toBe(false);
    expect(networkPolicy.isLoopbackHostname('0.0.0.0')).toBe(false);
  });

  it('只把 OS 加密后的凭据写盘，公开状态永不返回明文 key', async () => {
    const file = tempFile();
    const sentinel = 'sentinel-secret-that-must-never-leak';
    const record = await settingsStore.saveModelSettings(
      file,
      input({ apiKey: sentinel }),
      null,
      fakeSafeStorage(),
      { platform: 'win32' },
    );

    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(sentinel);
    expect(raw).toContain(Buffer.from(`sealed:${sentinel}`).toString('base64'));

    const publicState = settingsStore.publicSettings(record, settingsStore.DEFAULT_SETTINGS, {
      editable: true,
      mode: 'spawned',
      environmentCredentialPresent: false,
    });
    expect(publicState).toMatchObject({ credentialPresent: true, credentialSource: 'system-store' });
    expect(JSON.stringify(publicState)).not.toContain(sentinel);
    expect(JSON.stringify(publicState)).not.toContain(record.encryptedApiKey);
  });

  it('解密只发生在构造自管宿主环境时，任务正文/argv 不参与', async () => {
    const file = tempFile();
    const record = await settingsStore.saveModelSettings(
      file,
      input({ apiKey: 'only-in-child-env', contextLimit: '150000' }),
      null,
      fakeSafeStorage(),
      { platform: 'win32' },
    );
    const runtime = await settingsStore.modelEnvironment(record, fakeSafeStorage(), { platform: 'win32' });
    expect(runtime.set).toMatchObject({
      AGENT_PROVIDER: 'openai',
      AGENT_MODEL: 'test-model',
      AGENT_EFFORT: 'high',
      OPENAI_BASE_URL: 'https://api.example.test/v1',
      OPENAI_API_KEY: 'only-in-child-env',
      AGENT_MAX_TOKENS: '4096',
      AGENT_CONTEXT_LIMIT: '150000',
      AGENT_MAX_RETRIES: '0',
    });
    expect(runtime.unset).toContain('AGENT_UI_DAILY_TOKEN_BUDGET');
  });

  it('空 key 保留已有密文，显式 clear 才删除', async () => {
    const file = tempFile();
    const storage = fakeSafeStorage();
    const first = await settingsStore.saveModelSettings(
      file,
      input({ apiKey: 'keep-me' }),
      null,
      storage,
      { platform: 'win32' },
    );
    const preserved = await settingsStore.saveModelSettings(file, input(), first, storage, { platform: 'win32' });
    expect(preserved.encryptedApiKey).toBe(first.encryptedApiKey);
    const cleared = await settingsStore.saveModelSettings(
      file,
      input({ clearApiKey: true }),
      preserved,
      storage,
      { platform: 'win32' },
    );
    expect(cleared).not.toHaveProperty('encryptedApiKey');
  });

  it('凭据绑定 provider 与 endpoint origin，拒绝跨供应边界静默复用', async () => {
    const file = tempFile();
    const storage = fakeSafeStorage();
    const first = await settingsStore.saveModelSettings(
      file,
      input({ apiKey: 'provider-bound-key' }),
      null,
      storage,
      { platform: 'win32' },
    );
    await expect(
      settingsStore.saveModelSettings(
        file,
        input({ provider: 'anthropic', baseUrl: '', model: 'claude-test' }),
        first,
        storage,
        { platform: 'win32' },
      ),
    ).rejects.toThrow(/重新输入 API key/);
    const rebound = await settingsStore.saveModelSettings(
      file,
      input({ provider: 'anthropic', baseUrl: '', model: 'claude-test', apiKey: 'new-provider-key' }),
      first,
      storage,
      { platform: 'win32' },
    );
    expect(rebound.credentialBinding).toBe('anthropic|https://api.anthropic.com');
  });

  it('安全存储不可用时 fail closed，不落明文 fallback', async () => {
    const file = tempFile();
    await expect(
      settingsStore.saveModelSettings(
        file,
        input({ apiKey: 'do-not-write' }),
        null,
        fakeSafeStorage({ available: false }),
        { platform: 'win32' },
      ),
    ).rejects.toThrow(/安全存储不可用/);
  });

  it('拒绝远程 HTTP、userinfo、未知 IPC 字段和越界数值', async () => {
    const file = tempFile();
    const storage = fakeSafeStorage();
    await expect(settingsStore.saveModelSettings(file, input({ baseUrl: 'http://api.example.test' }), null, storage))
      .rejects.toThrow(/必须使用 HTTPS/);
    await expect(settingsStore.saveModelSettings(file, input({ baseUrl: 'http://127.attacker.example' }), null, storage))
      .rejects.toThrow(/必须使用 HTTPS/);
    await expect(settingsStore.saveModelSettings(file, input({ baseUrl: 'https://u:p@example.test' }), null, storage))
      .rejects.toThrow(/用户名或密码/);
    await expect(settingsStore.saveModelSettings(file, { ...input(), surprise: true }, null, storage))
      .rejects.toThrow(/未知设置字段/);
    await expect(settingsStore.saveModelSettings(file, input({ maxRetries: '11' }), null, storage))
      .rejects.toThrow(/重试次数/);
  });

  it('损坏或未知 schema 回退到脱敏环境设置并给出告警', () => {
    const file = tempFile();
    writeFileSync(file, '{"schemaVersion":99,"encryptedApiKey":"plaintext?"}', 'utf8');
    const loaded = settingsStore.loadModelSettings(file, {
      AGENT_PROVIDER: 'openai',
      AGENT_MODEL: 'fallback-model',
      OPENAI_API_KEY: 'environment-sentinel',
    });
    expect(loaded.record).toBeNull();
    expect(loaded.settings.model).toBe('fallback-model');
    expect(loaded.warning).toMatch(/已忽略/);
    expect(JSON.stringify(loaded)).not.toContain('environment-sentinel');
  });
});

'use strict';

const form = document.getElementById('settings-form');
const banner = document.getElementById('mode-banner');
const message = document.getElementById('message');
const credentialStatus = document.getElementById('credential-status');
const saveButton = document.getElementById('save');
const cancelButton = document.getElementById('cancel');
const fieldNames = [
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
];
let refreshTimer = null;

function showMessage(text, kind = 'error') {
  message.textContent = text;
  message.className = `message ${kind}`;
  message.hidden = !text;
}

function setBusy(busy) {
  saveButton.disabled = busy || form.dataset.editable !== 'true';
  saveButton.textContent = busy ? '正在安全保存…' : '保存并重启宿主';
}

function render(state) {
  for (const name of fieldNames) {
    const element = document.getElementById(name);
    element.value = state.settings[name] ?? '';
  }
  document.getElementById('apiKey').value = '';
  document.getElementById('clearApiKey').checked = false;

  const sourceText = {
    'system-store': '已由操作系统安全存储保管；留空即保留',
    environment: '当前来自进程环境或 .env；留空继续沿用',
    missing: '尚未配置',
  };
  credentialStatus.textContent = sourceText[state.credentialSource] ?? '状态未知';

  form.dataset.editable = String(state.editable);
  for (const element of form.elements) {
    if (element === cancelButton) continue;
    element.disabled = !state.editable;
  }
  const pending = String(state.mode || '').endsWith('-pending');
  banner.classList.toggle('readonly', !state.editable);
  banner.textContent = state.editable
    ? '本地自管宿主 · 保存后此配置优先于启动终端和项目 .env。'
    : pending
      ? '正在确认宿主来源；确认由 Desktop 自管后即可编辑。'
      : `只读模式 · 当前连接外部宿主（${state.mode || 'attach'}），请在宿主侧配置模型。`;
  if (state.warning) showMessage(state.warning, 'error');
  else showMessage('', 'error');
  setBusy(false);
  if (refreshTimer) clearTimeout(refreshTimer);
  if (pending) refreshTimer = setTimeout(loadState, 500);
}

async function loadState() {
  try {
    render(await window.agentSettings.get());
  } catch (error) {
    showMessage(`无法读取设置：${error?.message || String(error)}`, 'error');
    form.dataset.editable = 'false';
    setBusy(false);
  }
}

function payloadFromForm() {
  const payload = {};
  for (const name of fieldNames) payload[name] = document.getElementById(name).value;
  payload.apiKey = document.getElementById('apiKey').value;
  payload.clearApiKey = document.getElementById('clearApiKey').checked;
  return payload;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showMessage('', 'error');
  setBusy(true);
  try {
    const state = await window.agentSettings.save(payloadFromForm());
    render(state);
    showMessage('设置已保存，本地宿主已按新配置重启。', 'success');
  } catch (error) {
    showMessage(error?.message || String(error), 'error');
  } finally {
    if (document.body.isConnected) setBusy(false);
  }
});

cancelButton.addEventListener('click', () => window.agentSettings.close());

void loadState();

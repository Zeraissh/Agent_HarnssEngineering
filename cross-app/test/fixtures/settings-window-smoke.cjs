'use strict';

const { app } = require('electron');
const { createSettingsController } = require('../../electron/settings-window.cjs');

const initialSettings = {
  provider: 'anthropic',
  model: 'fixture-model',
  baseUrl: '',
  effort: 'high',
  maxTokens: null,
  contextLimit: null,
  timeoutMs: null,
  maxRetries: null,
  dailyTokenBudget: null,
  maxActiveRuns: 4,
};

let resolveSaved;
let stateReads = 0;
const saved = new Promise((resolve) => {
  resolveSaved = resolve;
});

app.whenReady().then(async () => {
  const controller = createSettingsController({
    getState: async () => {
      stateReads += 1;
      return {
        settings: initialSettings,
        editable: stateReads > 1,
        mode: stateReads > 1 ? 'spawned' : 'local-pending',
        credentialPresent: false,
        credentialSource: 'missing',
        warning: null,
      };
    },
    saveState: async (payload) => {
      resolveSaved(payload);
      return {
        settings: {
          ...initialSettings,
          ...Object.fromEntries(Object.entries(payload).filter(([key]) => key in initialSettings)),
        },
        editable: true,
        mode: 'spawned',
        credentialPresent: true,
        credentialSource: 'system-store',
        warning: null,
      };
    },
  });
  const win = controller.open();
  win.webContents.once('did-finish-load', async () => {
    try {
      const refreshDeadline = Date.now() + 3000;
      let pendingRefreshed = false;
      while (Date.now() < refreshDeadline) {
        pendingRefreshed = await win.webContents.executeJavaScript("!document.getElementById('save').disabled");
        if (pendingRefreshed) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const initialModel = await win.webContents.executeJavaScript("document.getElementById('model').value");
      await win.webContents.executeJavaScript(`(() => {
        document.getElementById('provider').value = 'openai';
        document.getElementById('model').value = 'saved-model';
        document.getElementById('apiKey').value = 'renderer-sentinel';
        document.getElementById('settings-form').requestSubmit();
      })()`);
      const payload = await saved;
      await new Promise((resolve) => setTimeout(resolve, 50));
      const successVisible = await win.webContents.executeJavaScript(
        "document.getElementById('message').textContent.includes('设置已保存')",
      );
      const result = {
        initialRendered: initialModel === 'fixture-model',
        pendingRefreshed,
        narrowSaveWorked:
          payload.provider === 'openai' &&
          payload.model === 'saved-model' &&
          payload.apiKey === 'renderer-sentinel',
        successRendered: successVisible,
      };
      console.log(JSON.stringify(result));
      controller.dispose();
      win.destroy();
      app.exit(Object.values(result).every(Boolean) ? 0 : 1);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      app.exit(1);
    }
  });
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  app.exit(1);
});

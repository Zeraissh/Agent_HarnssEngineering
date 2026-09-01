'use strict';

const { BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const GET_CHANNEL = 'agent-settings:get';
const SAVE_CHANNEL = 'agent-settings:save';
const CLOSE_CHANNEL = 'agent-settings:close';

function createSettingsController({ getState, saveState }) {
  let settingsWindow = null;

  function assertLocalSettingsSender(event) {
    if (!settingsWindow || settingsWindow.isDestroyed() || event.sender !== settingsWindow.webContents) {
      throw new Error('拒绝非本地设置窗口的 IPC 请求');
    }
  }

  ipcMain.handle(GET_CHANNEL, async (event) => {
    assertLocalSettingsSender(event);
    return getState();
  });
  ipcMain.handle(SAVE_CHANNEL, async (event, payload) => {
    assertLocalSettingsSender(event);
    return saveState(payload);
  });
  ipcMain.on(CLOSE_CHANNEL, (event) => {
    try {
      assertLocalSettingsSender(event);
      settingsWindow.close();
    } catch {
      // 非设置窗口无权关闭任何窗口。
    }
  });

  function open(parent) {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.show();
      settingsWindow.focus();
      return settingsWindow;
    }
    settingsWindow = new BrowserWindow({
      width: 720,
      height: 780,
      minWidth: 640,
      minHeight: 640,
      title: '模型与运行设置 · Agent Harness',
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      modal: false,
      show: false,
      backgroundColor: '#f7f3eb',
      webPreferences: {
        preload: path.join(__dirname, 'settings-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    settingsWindow.setMenuBarVisibility(false);
    settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    settingsWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    settingsWindow.once('ready-to-show', () => settingsWindow?.show());
    settingsWindow.on('closed', () => {
      settingsWindow = null;
    });
    void settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
    return settingsWindow;
  }

  function dispose() {
    ipcMain.removeHandler(GET_CHANNEL);
    ipcMain.removeHandler(SAVE_CHANNEL);
    ipcMain.removeAllListeners(CLOSE_CHANNEL);
  }

  return { dispose, open };
}

module.exports = { createSettingsController };

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 这个桥只存在于本地 settings.html；远程 Harness 页面使用另一只无 preload 的
// BrowserWindow。接口保持窄且只传结构化数据，不暴露通用 IPC 能力。
contextBridge.exposeInMainWorld('agentSettings', {
  get: () => ipcRenderer.invoke('agent-settings:get'),
  save: (settings) => ipcRenderer.invoke('agent-settings:save', settings),
  close: () => ipcRenderer.send('agent-settings:close'),
});

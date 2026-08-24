const { contextBridge } = require('electron');

// 外壳信息。控制台本身是纯 Web UI，不需要暴露 Node 能力；
// 保留最小桥接仅用于将来接入原生能力（文件关联、通知等）。
contextBridge.exposeInMainWorld('agentHarness', {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    electron: process.versions.electron,
  },
});

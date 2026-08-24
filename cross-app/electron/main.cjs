const { app, BrowserWindow, session, shell } = require('electron');

function isLoopback(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function resolveHarnessUrl() {
  const target = new URL(process.env.AGENT_UI_URL || 'http://127.0.0.1:4173');
  if (target.username || target.password) {
    throw new Error('AGENT_UI_URL must not contain URL userinfo');
  }
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && isLoopback(target.hostname))) {
    throw new Error('AGENT_UI_URL must use HTTPS unless it points to loopback');
  }
  return target;
}

function canOpenExternally(raw) {
  try {
    const target = new URL(raw);
    return target.protocol === 'https:' || (target.protocol === 'http:' && isLoopback(target.hostname));
  } catch {
    return false;
  }
}

function createWindow() {
  const harness = resolveHarnessUrl();
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Agent Harness',
    backgroundColor: '#171717',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).origin === harness.origin) {
        // 保留同一 Electron session，访问令牌 cookie 不会泄漏给系统浏览器。
        win.webContents.downloadURL(url);
      } else if (canOpenExternally(url)) {
        void shell.openExternal(url);
      }
    } catch {
      // 畸形/非网络协议一律拒绝。
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin === harness.origin) return;
    } catch {
      // 下面统一阻止。
    }
    event.preventDefault();
    if (canOpenExternally(url)) {
      void shell.openExternal(url);
    }
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  void win.loadURL(harness.href).catch((error) => {
    const message = encodeURIComponent(`无法连接 Harness 宿主：${error.message}`);
    if (!win.isDestroyed()) void win.loadURL(`data:text/plain;charset=utf-8,${message}`);
  });
}

app.setName('Agent Harness');

app.whenReady().then(() => {
  // 远程 Web 内容不应获得摄像头、麦克风、地理位置、通知等原生权限。
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  createWindow();

  app.on('activate', () => {
    // macOS：点击 Dock 图标且无窗口时重新创建窗口
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

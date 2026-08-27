const { app, BrowserWindow, Menu, dialog, session, shell } = require('electron');
const path = require('node:path');
const launcher = require('./host-launcher.cjs');
const workspaceStore = require('./workspace-store.cjs');

// 打包态的编译宿主与 production dependencies 位于 resources/harness；开发态
// 仍以仓库根为事实源。安装包离开源码检出后也必须能一键启动。
const REPO_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'harness') : path.join(__dirname, '..', '..');
const DEFAULT_PORT = 4173;

/** 自启动的宿主子进程；attach 模式恒为 null——不是我们拉起的宿主绝不去杀。 */
let hostChild = null;
let harnessHref = null;
let harnessOrigin = null;
let quitting = false;
/** 在途的收树 Promise：二次 quit 要等它，不许放行默认退出跳过 SIGKILL 升级。 */
let cleanup = null;
let restarting = false;
/** 当前该展示的页面（正式页/错误页），activate 重建窗口按它渲染，不丢状态。 */
let currentPage = null;
let hostMode = null;
let workspaceFile = null;
let workspaceState = null;

function seedConfiguredWorkspaces(state) {
  const originallySelected = state.selected;
  const configured = (process.env.AGENT_UI_WORKDIRS ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  let next = state;
  for (const directory of configured) {
    if (workspaceStore.normalizeDirectory(directory)) {
      next = workspaceStore.addWorkspace(next, directory);
    }
  }
  return workspaceStore.selectWorkspace(next, originallySelected);
}

function isLoopback(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function resolveAttachUrl(raw) {
  const target = new URL(raw);
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

function textPage(message) {
  return `data:text/plain;charset=utf-8,${encodeURIComponent(message)}`;
}

function loadInto(win, href) {
  void win.loadURL(href).catch((error) => {
    // ERR_ABORTED = 这次加载被更新的 loadURL 顶掉了（attach 模式下加载页
    // 与正式页的正常竞态），不是失败；误当失败会用错误页把正式页盖掉。
    if (error && error.code === 'ERR_ABORTED') return;
    if (!win.isDestroyed()) {
      void win.loadURL(textPage(`无法连接 Harness 宿主：${error.message}`));
    }
  });
}

function setPage(href) {
  currentPage = href;
  for (const win of BrowserWindow.getAllWindows()) loadInto(win, href);
}

/**
 * 决定宿主来源：
 *   1. AGENT_UI_URL 显式指定 → 只连它（远程/自管宿主，连不上如实报错）；
 *   2. 本机候选端口（AGENT_UI_PORT，缺省 4173）已有健康宿主 → 直连（老工作流不变）；
 *   3. 否则自己拉起一个（入口解析见 host-launcher，端口用 AGENT_UI_PORT 或随机空闲位）。
 */
async function resolveHarness({ forceSpawn = false } = {}) {
  const explicit = process.env.AGENT_UI_URL;
  if (explicit) {
    return { href: resolveAttachUrl(explicit).href, mode: 'attach' };
  }

  const preferredPort = process.env.AGENT_UI_PORT;
  if (preferredPort !== undefined && !/^\d+$/.test(preferredPort)) {
    throw new Error(`Invalid AGENT_UI_PORT: ${preferredPort}`);
  }
  const candidate = `http://127.0.0.1:${preferredPort ?? DEFAULT_PORT}`;
  if (!forceSpawn && (await launcher.probeHealthy(candidate))) {
    return { href: candidate, mode: 'attach' };
  }

  const entry = launcher.resolveHostEntry({ repoRoot: REPO_ROOT, env: process.env });
  if (!entry) {
    throw new Error(
      '找不到宿主入口：需要仓库检出（ui/serve.ts + node_modules/tsx）或 dist/ui/serve.js，' +
        '或设 AGENT_UI_HOST_ENTRY 指向编译版入口 / AGENT_UI_URL 指向已运行的宿主',
    );
  }
  const port = preferredPort ? Number(preferredPort) : await launcher.pickFreePort();
  let dotEnv = {};
  try {
    dotEnv = launcher.loadDotEnv(REPO_ROOT);
  } catch (error) {
    console.warn(`.env 读取失败，按无 .env 继续：${error.message}`);
  }

  // 与 will-quit 的竞态防线：quitting 置位后绝不再拉宿主（此检查与 spawn、
  // hostChild 赋值同处一个同步块，中间无 await，不存在交错窗口）。
  if (quitting) throw new Error('应用正在退出，取消拉起宿主');
  const desktopEnv = workspaceState
    ? {
        AGENT_UI_WORKDIR: workspaceState.selected,
        AGENT_UI_WORKDIRS: workspaceState.directories.join(path.delimiter),
      }
    : {};
  const child = launcher.spawnHost({
    execPath: process.execPath,
    nodeArgs: entry.nodeArgs,
    repoRoot: REPO_ROOT,
    env: { ...launcher.mergeEnv(process.env, dotEnv), ...desktopEnv },
    port,
  });
  hostChild = child;
  const tail = launcher.createLogTail();
  child.stdout.on('data', (chunk) => {
    tail.push(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    tail.push(chunk);
    process.stderr.write(chunk);
  });
  child.on('exit', (code, signal) => {
    hostChild = null;
    if (quitting || restarting) return;
    void (async () => {
      // 探活误判在已占用端口上拉起第二个宿主时，子进程会 EADDRINUSE 退出，
      // 但窗口连着的原宿主仍健康——先复核再决定，不许错误页盖掉好端端的界面。
      if (harnessHref && (await launcher.probeHealthy(harnessHref))) return;
      setPage(textPage(`Harness 宿主意外退出（code=${code ?? '-'} signal=${signal ?? '-'}）\n\n${tail.text()}`));
    })();
  });

  const base = `http://127.0.0.1:${port}`;
  await launcher.waitForHealthy(base, {
    isAborted: () => child.exitCode !== null || child.signalCode !== null,
  });
  return { href: base, mode: 'spawned', entryKind: entry.kind };
}

function selectWorkspaceInWindows(directory) {
  const serialized = JSON.stringify(directory);
  const script = `(() => { const el = document.getElementById('workdir-select'); if (!el) return false; ` +
    `el.value = ${serialized}; el.title = el.value; el.dispatchEvent(new Event('change', { bubbles: true })); ` +
    `return el.value === ${serialized}; })()`;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) void win.webContents.executeJavaScript(script).catch(() => {});
  }
}

function installApplicationMenu() {
  if (!workspaceState) return;
  const workspaceItems = workspaceState.directories.map((directory) => ({
    label: directory,
    type: 'radio',
    checked: directory === workspaceState.selected,
    click: () => {
      workspaceState = workspaceStore.selectWorkspace(workspaceState, directory);
      workspaceStore.saveWorkspaceState(workspaceFile, workspaceState);
      installApplicationMenu();
      selectWorkspaceInWindows(directory);
    },
  }));
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: '工作目录',
      submenu: [
        {
          label: '添加工作目录…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => void chooseAndAddWorkspace(),
        },
        { type: 'separator' },
        ...workspaceItems,
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function chooseAndAddWorkspace() {
  if (hostMode !== 'spawned') {
    await dialog.showMessageBox({
      type: 'info',
      message: '当前连接的是外部宿主',
      detail: '桌面 App 不能修改外部宿主的工作目录白名单。请在宿主设置 AGENT_UI_WORKDIRS 后重启宿主。',
    });
    return;
  }
  const owner = BrowserWindow.getFocusedWindow() ?? undefined;
  const result = await dialog.showOpenDialog(owner, {
    title: '选择 Agent 工作目录',
    defaultPath: workspaceState.selected,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return;
  const next = workspaceStore.addWorkspace(workspaceState, result.filePaths[0]);
  const confirmation = await dialog.showMessageBox(owner, {
    type: 'warning',
    buttons: ['切换并重启宿主', '取消'],
    defaultId: 0,
    cancelId: 1,
    message: `切换到 ${next.selected}？`,
    detail: '本地宿主会重启；正在运行的任务会中断。历史记录不会删除。',
  });
  if (confirmation.response !== 0) return;
  workspaceState = next;
  workspaceStore.saveWorkspaceState(workspaceFile, workspaceState);
  installApplicationMenu();
  await restartOwnedHost();
}

async function restartOwnedHost() {
  if (!hostChild || hostMode !== 'spawned') return;
  restarting = true;
  setPage(textPage(`正在切换工作目录…\n${workspaceState.selected}`));
  const child = hostChild;
  const clean = await launcher.stopHostTree(child);
  restarting = false;
  if (!clean) {
    // stop 超时表示它可能仍活着；保留句柄，App 最终退出时还能再走一次收树。
    hostChild = child;
    setPage(textPage('旧宿主进程树未能完全退出；为避免两个宿主同时写文件，已取消切换。'));
    return;
  }
  try {
    const resolved = await resolveHarness({ forceSpawn: true });
    hostMode = resolved.mode;
    harnessHref = resolved.href;
    harnessOrigin = new URL(resolved.href).origin;
    setPage(harnessHref);
  } catch (error) {
    setPage(textPage(`切换工作目录失败：${error.message}`));
  }
}

function createWindow() {
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
      if (harnessOrigin && new URL(url).origin === harnessOrigin) {
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
      if (harnessOrigin && new URL(url).origin === harnessOrigin) return;
    } catch {
      // 下面统一阻止。
    }
    event.preventDefault();
    if (canOpenExternally(url)) {
      void shell.openExternal(url);
    }
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  loadInto(win, currentPage ?? textPage('正在启动 Harness 宿主…'));
  return win;
}

app.setName('Agent Harness');

app.whenReady().then(async () => {
  // 远程 Web 内容不应获得摄像头、麦克风、地理位置、通知等原生权限。
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  workspaceFile = path.join(app.getPath('userData'), 'workspaces.json');
  const fallbackWorkdir = workspaceStore.normalizeDirectory(process.env.AGENT_UI_WORKDIR) ?? REPO_ROOT;
  workspaceState = seedConfiguredWorkspaces(workspaceStore.loadWorkspaceState(workspaceFile, fallbackWorkdir));
  installApplicationMenu();
  createWindow();

  app.on('activate', () => {
    // macOS：点击 Dock 图标且无窗口时重新创建窗口
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  try {
    const resolved = await resolveHarness();
    hostMode = resolved.mode;
    harnessHref = resolved.href;
    harnessOrigin = new URL(resolved.href).origin;
    setPage(harnessHref);
  } catch (error) {
    setPage(textPage(`无法启动/连接 Harness 宿主：${error.message}`));
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 关窗即走：自启动的宿主连同 bash/MCP 孙进程一起收干净再退出。
// quitting 无条件置位：即使宿主还没拉起（hostChild 仍为 null），退出后残余的
// 微任务也不许再 spawn——否则启动窗口期关窗会留下孤儿宿主。
app.on('will-quit', (event) => {
  if (cleanup) {
    // 收树在途时的二次 quit（如 macOS 连按 Cmd+Q）也要拦下等首次清理的
    // app.exit——放行默认退出会跳过 SIGKILL 升级与残留告警，正好留孤儿。
    // stopHostTree 自带有界超时（3s+1s），不会卡死退出。
    event.preventDefault();
    return;
  }
  if (quitting) return;
  quitting = true;
  if (!hostChild) return;
  event.preventDefault();
  cleanup = launcher.stopHostTree(hostChild).then((clean) => {
    if (!clean) console.error('宿主进程树未在超时内退出，可能残留 node 进程，请手动检查');
    app.exit(clean ? 0 : 1);
  });
});

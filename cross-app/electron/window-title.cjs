/**
 * 桌面窗标题：产品名 + 当前页含义。纯 Node，不依赖 electron——
 * 宿主页 <title> 是「FATHOM 控制台」口号，BrowserWindow 默认会跟过去；
 * 标题必须由壳按 hash 路由自己定，测试才能在 vitest 里锁契约。
 */
'use strict';

const PRODUCT_NAME = 'FATHOM';

const PAGE_LABEL = {
  home: null,
  run: '对话',
  settings: '设置',
  schedules: '定时任务',
  board: '指挥中心',
  artifacts: '产物',
  artifact: '产物',
  usage: '消耗',
};

function hashFromHref(href) {
  if (!href || typeof href !== 'string') return '';
  if (href.startsWith('data:')) return '';
  try {
    return new URL(href).hash || '';
  } catch {
    const hashAt = href.indexOf('#');
    return hashAt >= 0 ? href.slice(hashAt) : '';
  }
}

/**
 * 与 Web 七路 hash 对齐（#/、#/run/…、#/settings、#/board、#/artifacts、
 * #/schedules、#/usage、#/run/…/artifact/…）。走查用的 #walk=… 算首页。
 */
function parseDesktopRoute(hash) {
  const raw = String(hash || '');
  const withHash = !raw || raw.startsWith('#') ? raw : `#${raw}`;
  const path = withHash.split('?')[0];
  if (!path || path === '#' || path === '#/') return { kind: 'home' };
  if (path === '#/settings') return { kind: 'settings' };
  if (path === '#/schedules') return { kind: 'schedules' };
  if (path === '#/board') return { kind: 'board' };
  if (path === '#/artifacts') return { kind: 'artifacts' };
  if (path === '#/usage') return { kind: 'usage' };
  if (/^#\/run\/[^/]+\/artifact(?:\/|$)/.test(path)) return { kind: 'artifact' };
  if (/^#\/run\//.test(path)) return { kind: 'run' };
  return { kind: 'home' };
}

function desktopWindowTitle({ href, hash, kind } = {}) {
  const route = kind ? { kind } : parseDesktopRoute(hash ?? hashFromHref(href));
  const label = PAGE_LABEL[route.kind];
  return label ? `${PRODUCT_NAME} · ${label}` : PRODUCT_NAME;
}

function applyDesktopWindowTitle(win, href) {
  const url = href ?? win.webContents.getURL();
  const title = desktopWindowTitle({ href: url });
  win.setTitle(title);
  return title;
}

/**
 * 拦住 page-title-updated：否则宿主 <title>「FATHOM 控制台」会盖掉壳标题。
 * hash 变了走 did-navigate-in-page（同文档内路由，不会重载）。
 */
function wireDesktopWindowTitle(win) {
  const apply = (url) => applyDesktopWindowTitle(win, url);
  win.on('page-title-updated', (event) => {
    event.preventDefault();
    apply(win.webContents.getURL());
  });
  win.webContents.on('did-navigate', (_event, url) => apply(url));
  win.webContents.on('did-navigate-in-page', (_event, url) => apply(url));
  apply(win.webContents.getURL());
}

module.exports = {
  PRODUCT_NAME,
  PAGE_LABEL,
  hashFromHref,
  parseDesktopRoute,
  desktopWindowTitle,
  applyDesktopWindowTitle,
  wireDesktopWindowTitle,
};

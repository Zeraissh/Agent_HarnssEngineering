/**
 * 与 src/chrome-user-data.ts 同一合同：Chrome --user-data-dir 必须绝对可写，
 * 禁止 ./chrome-profile。桌面壳不自己拉起 Chrome，但预览/导出若要开系统
 * Chrome，以及宿主防呆，都走这里。
 */
'use strict';

const { randomBytes } = require('node:crypto');
const { existsSync, mkdirSync, unlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const CHROME_USER_DATA_LEAF = 'fathom-chrome-preview';
const FORBIDDEN_RELATIVE_CHROME_PROFILE = './chrome-profile';

function normalizeSlashes(p) {
  return String(p).replace(/\\/g, '/');
}

function isUnsafeChromeUserDataDir(dir) {
  const trimmed = String(dir ?? '').trim();
  if (!trimmed) return true;
  const norm = normalizeSlashes(trimmed);
  if (norm === FORBIDDEN_RELATIVE_CHROME_PROFILE || norm === 'chrome-profile') return true;
  return !path.isAbsolute(trimmed);
}

function defaultChromeUserDataRoot(env = process.env, electronUserData) {
  const override = env.AGENT_CHROME_USER_DATA_DIR && String(env.AGENT_CHROME_USER_DATA_DIR).trim();
  if (override && path.isAbsolute(override) && !isUnsafeChromeUserDataDir(override)) {
    return path.resolve(override);
  }
  if (electronUserData && path.isAbsolute(electronUserData)) {
    return path.join(electronUserData, CHROME_USER_DATA_LEAF);
  }
  const local = (env.LOCALAPPDATA || env.XDG_CACHE_HOME || '').trim();
  if (local && path.isAbsolute(local)) {
    return path.join(local, CHROME_USER_DATA_LEAF);
  }
  return path.join(tmpdir(), CHROME_USER_DATA_LEAF);
}

function defaultLocked(dir) {
  return existsSync(path.join(dir, 'SingletonLock')) || existsSync(path.join(dir, 'lockfile'));
}

function canWriteChromeUserDataDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.fathom-writable-${process.pid}`);
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function resolveChromeUserDataDir(opts = {}) {
  const env = opts.env ?? process.env;
  const pid = opts.pid ?? process.pid;
  const locked = opts.isLocked ?? defaultLocked;
  const preferred = opts.preferred && String(opts.preferred).trim();
  const root = defaultChromeUserDataRoot(env, opts.electronUserData);
  const named = opts.name ? path.join(root, opts.name) : root;

  let candidate = preferred && !isUnsafeChromeUserDataDir(preferred) ? path.resolve(preferred) : named;
  if (!path.isAbsolute(candidate) || isUnsafeChromeUserDataDir(candidate)) {
    candidate = named;
  }

  const pick = (dir) => {
    if (!canWriteChromeUserDataDir(dir)) return undefined;
    if (locked(dir)) return undefined;
    return dir;
  };

  const first = pick(candidate);
  if (first) return first;

  const suffix = opts.randomSuffix ?? `${pid}-${randomBytes(3).toString('hex')}`;
  const fallback = `${candidate}-${suffix}`;
  const second = pick(fallback);
  if (second) return second;

  const tmpFallback = path.join(tmpdir(), `${CHROME_USER_DATA_LEAF}-${suffix}`);
  mkdirSync(tmpFallback, { recursive: true });
  if (!canWriteChromeUserDataDir(tmpFallback)) {
    throw new Error('无法创建可写的 Chrome 用户数据目录');
  }
  return tmpFallback;
}

function chromeUserDataDirFlag(dir) {
  if (!path.isAbsolute(dir) || isUnsafeChromeUserDataDir(dir)) {
    throw new Error(`Chrome --user-data-dir must be an absolute writable path, not ${JSON.stringify(dir)}`);
  }
  return `--user-data-dir=${dir}`;
}

function rewriteUserDataDirArgs(args, opts = {}) {
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    const a = out[i];
    if (a === '--user-data-dir') {
      if (out[i + 1]) out[i + 1] = resolveChromeUserDataDir({ ...opts, preferred: out[i + 1] });
      continue;
    }
    if (typeof a === 'string' && a.startsWith('--user-data-dir=')) {
      out[i] = chromeUserDataDirFlag(
        resolveChromeUserDataDir({ ...opts, preferred: a.slice('--user-data-dir='.length) }),
      );
    }
  }
  return out;
}

module.exports = {
  CHROME_USER_DATA_LEAF,
  FORBIDDEN_RELATIVE_CHROME_PROFILE,
  isUnsafeChromeUserDataDir,
  defaultChromeUserDataRoot,
  canWriteChromeUserDataDir,
  resolveChromeUserDataDir,
  chromeUserDataDirFlag,
  rewriteUserDataDirArgs,
};

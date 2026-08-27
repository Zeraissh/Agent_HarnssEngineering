'use strict';

const { existsSync, readFileSync, renameSync, statSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const MAX_WORKSPACES = 20;

function normalizeDirectory(input, { exists = existsSync, stat = statSync } = {}) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const resolved = path.resolve(input.trim());
  try {
    return exists(resolved) && stat(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function uniqueDirectories(values, io) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const dir = normalizeDirectory(value, io);
    if (!dir) continue;
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
    if (out.length >= MAX_WORKSPACES) break;
  }
  return out;
}

function loadWorkspaceState(file, fallbackDirectory, io = {}) {
  let parsed = {};
  try {
    if ((io.exists ?? existsSync)(file)) {
      parsed = JSON.parse((io.read ?? readFileSync)(file, 'utf8'));
    }
  } catch {
    // 配置损坏不妨碍 App 启动；回到安全的仓库根目录。
  }
  const directories = uniqueDirectories(
    [parsed.selected, ...(Array.isArray(parsed.directories) ? parsed.directories : []), fallbackDirectory],
    io,
  );
  const selected = normalizeDirectory(parsed.selected, io) ?? directories[0] ?? path.resolve(fallbackDirectory);
  return { selected, directories: uniqueDirectories([selected, ...directories], io) };
}

function addWorkspace(state, directory, io = {}) {
  const selected = normalizeDirectory(directory, io);
  if (!selected) throw new Error(`工作目录不存在或不是文件夹：${directory}`);
  return {
    selected,
    directories: uniqueDirectories([selected, ...state.directories], io),
  };
}

function selectWorkspace(state, directory, io = {}) {
  const selected = normalizeDirectory(directory, io);
  if (!selected || !uniqueDirectories(state.directories, io).some((dir) => samePath(dir, selected))) {
    throw new Error(`工作目录尚未授权：${directory}`);
  }
  return { selected, directories: uniqueDirectories([selected, ...state.directories], io) };
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function saveWorkspaceState(file, state, { write = writeFileSync, rename = renameSync } = {}) {
  const temp = `${file}.tmp`;
  write(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  rename(temp, file);
}

module.exports = {
  MAX_WORKSPACES,
  addWorkspace,
  loadWorkspaceState,
  normalizeDirectory,
  saveWorkspaceState,
  selectWorkspace,
};

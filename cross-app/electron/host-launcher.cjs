/**
 * 一键桌面的宿主启动器：Electron 主进程用它把 Harness 宿主（ui/serve.ts 或
 * dist/ui/serve.js）作为子进程拉起、等健康、退出时连同孙进程一起收干净。
 *
 * 刻意不依赖 electron 模块：纯 Node 才能在 vitest 里做真实行为测试
 * （真起假宿主、真杀进程树），而不是只对 main.cjs 做字符串形状断言。
 */
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

/**
 * 复刻 `node --env-file-if-exists` 的核心语义子集：KEY=VALUE 行、# 注释、
 * 可选 export 前缀、成对引号剥除。已存在的环境变量优先于文件（与 node 一致；
 * 残留变量压 .env 的告警由宿主自己的 warnEnvConflicts 负责喊）。
 */
function parseDotEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = stripped.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** 只补空位：base 里已定义的键（含空字符串）一律不动。 */
function mergeEnv(base, fill) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(fill)) {
    if (merged[key] === undefined) merged[key] = value;
  }
  return merged;
}

function loadDotEnv(repoRoot, { read = readFileSync, exists = existsSync } = {}) {
  const file = path.join(repoRoot, '.env');
  if (!exists(file)) return {};
  return parseDotEnv(read(file, 'utf8'));
}

/**
 * 解析宿主入口。顺序：显式 AGENT_UI_HOST_ENTRY > 源码 + tsx（开发检出）>
 * dist 编译版。源码优先于 dist 是防"陈旧 dist 静默顶包"——dist 是上次
 * npm run build 的快照，而 ui/ 源码是当前事实。显式指定但文件不存在返回
 * null（fail-closed，不静默降级到别的入口）。
 */
function resolveHostEntry({ repoRoot, env = {}, exists = existsSync }) {
  const override = env.AGENT_UI_HOST_ENTRY;
  if (override) {
    // 相对路径先按当前进程 cwd 解析成绝对路径——存在性检查与子进程（cwd 是
    // repoRoot）的模块解析必须同一基准，否则终端/Finder/快捷方式三种启动方式
    // 下同一配置三种结果。
    const resolved = path.resolve(override);
    return exists(resolved) ? { kind: 'override', nodeArgs: [resolved] } : null;
  }
  const serveTs = path.join(repoRoot, 'ui', 'serve.ts');
  const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (exists(serveTs) && exists(tsxCli)) {
    return { kind: 'source', nodeArgs: [tsxCli, serveTs] };
  }
  const distServe = path.join(repoRoot, 'dist', 'ui', 'serve.js');
  if (exists(distServe)) return { kind: 'dist', nodeArgs: [distServe] };
  return null;
}

function pickFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, host, () => {
      const { port } = probe.address();
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** 单次探活：GET /health 是否 200。宿主的 /health 在令牌门之外，loopback 可直连。 */
function probeHealthy(baseUrl, { timeoutMs = 400 } = {}) {
  return new Promise((resolve) => {
    const req = http.get(new URL('/health', baseUrl), { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy(new Error('probe timeout')));
    req.on('error', () => resolve(false));
  });
}

async function waitForHealthy(baseUrl, { timeoutMs = 30_000, intervalMs = 250, isAborted = () => false } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isAborted()) throw new Error('宿主进程在就绪前退出');
    if (await probeHealthy(baseUrl, { timeoutMs: Math.min(intervalMs * 4, 2000) })) return;
    await delay(intervalMs);
  }
  throw new Error(`宿主在 ${timeoutMs}ms 内未就绪：${baseUrl}`);
}

/**
 * 用 Electron 自带的 Node（ELECTRON_RUN_AS_NODE）拉起宿主，不依赖系统 node。
 * POSIX 下 detached 起新进程组，退出时对 -pid 发信号才能连 bash/MCP 孙进程
 * 一起收；Windows 靠 taskkill /T 收树，不需要 detached。
 */
function spawnHost({ execPath, nodeArgs, repoRoot, env, port, host = '127.0.0.1', platform = process.platform }) {
  return spawn(execPath, nodeArgs, {
    cwd: repoRoot,
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: '1',
      AGENT_UI_PORT: String(port),
      AGENT_UI_HOST: host,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: platform !== 'win32',
    windowsHide: true,
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/** taskkill 参数单独导出：/T（连树）是防僵尸的命门，测试要能在任意平台锁它。 */
function taskkillArgs(pid) {
  return ['/PID', String(pid), '/T', '/F'];
}

/**
 * 把宿主连同它的子进程（bash 工具、MCP server）一起收干净。
 * Windows 的 child.kill 只杀单个 PID 会留僵尸树（本仓有过实案），必须
 * taskkill /T /F；POSIX 对进程组先 SIGTERM 给优雅关停机会，超时再 SIGKILL。
 * 返回 true=确认退出；false=超时仍未退，调用方应把这个事实说出来。
 * runTaskkill/killGroup 可注入，让两平台分支在任意平台都测得到形状。
 */
async function stopHostTree(
  child,
  {
    platform = process.platform,
    timeoutMs = 3000,
    runTaskkill = (pid) => spawnSync('taskkill', taskkillArgs(pid), { windowsHide: true }),
    killGroup = (pid, sig) => process.kill(-pid, sig),
  } = {},
) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  let exited = false;
  const exitPromise = new Promise((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
  });
  const waitExit = async (ms) => {
    await Promise.race([exitPromise, delay(ms)]);
    return exited;
  };

  if (platform === 'win32') {
    runTaskkill(child.pid);
    return waitExit(timeoutMs);
  }

  const signalGroup = (sig) => {
    try {
      killGroup(child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        // 进程已经没了
      }
    }
  };
  signalGroup('SIGTERM');
  if (await waitExit(timeoutMs)) return true;
  signalGroup('SIGKILL');
  return waitExit(1000);
}

/** 宿主日志尾巴：意外退出时把最后几十行摆到窗口里，而不是让人去翻终端。 */
function createLogTail(maxLines = 40, maxLineLength = 400) {
  const lines = [];
  return {
    push(chunk) {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line) continue;
        lines.push(line.length > maxLineLength ? `${line.slice(0, maxLineLength)}…` : line);
        if (lines.length > maxLines) lines.shift();
      }
    },
    text() {
      return lines.join('\n');
    },
  };
}

module.exports = {
  parseDotEnv,
  mergeEnv,
  loadDotEnv,
  resolveHostEntry,
  pickFreePort,
  probeHealthy,
  waitForHealthy,
  spawnHost,
  stopHostTree,
  taskkillArgs,
  createLogTail,
};

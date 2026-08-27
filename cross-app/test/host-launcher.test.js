import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLogTail,
  loadDotEnv,
  mergeEnv,
  parseDotEnv,
  pickFreePort,
  probeHealthy,
  resolveHostEntry,
  spawnHost,
  stopHostTree,
  taskkillArgs,
  waitForHealthy,
} from '../electron/host-launcher.cjs';

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'host-launcher-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** 形状测试用的假子进程句柄：只实现 stopHostTree 消费的最小接口。 */
function fakeChildHandle() {
  const exitListeners = [];
  return {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    once(event, cb) {
      if (event === 'exit') exitListeners.push(cb);
    },
    kill() {
      this.emitExit();
    },
    emitExit() {
      if (this.exitCode !== null) return;
      this.exitCode = 0;
      for (const cb of exitListeners) cb();
    },
  };
}

async function eventually(check, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return check();
}

describe('parseDotEnv / mergeEnv：.env 装载语义与 node --env-file 对齐', () => {
  it('解析 KEY=VALUE、注释、export 前缀与成对引号', () => {
    const parsed = parseDotEnv(
      [
        '# 注释行',
        '',
        'PLAIN=hello',
        'export EXPORTED=yes',
        'QUOTED="with spaces"',
        "SINGLE='single'",
        'WITH_EQ=a=b=c',
        '快=非法键名跳过',
        'ALSO BAD=skip',
        '=nokey',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      PLAIN: 'hello',
      EXPORTED: 'yes',
      QUOTED: 'with spaces',
      SINGLE: 'single',
      WITH_EQ: 'a=b=c',
    });
  });

  it('已存在的环境变量优先于 .env（空字符串也算已存在）', () => {
    const merged = mergeEnv({ KEEP: 'env-wins', EMPTY: '' }, { KEEP: 'file', EMPTY: 'file', FILL: 'file' });
    expect(merged).toEqual({ KEEP: 'env-wins', EMPTY: '', FILL: 'file' });
  });

  it('loadDotEnv：无 .env 返回空对象，有则解析', () => {
    const dir = makeTmpDir();
    expect(loadDotEnv(dir)).toEqual({});
    writeFileSync(join(dir, '.env'), 'FROM_FILE=1\n');
    expect(loadDotEnv(dir)).toEqual({ FROM_FILE: '1' });
  });
});

describe('resolveHostEntry：入口解析顺序（真实文件系统）', () => {
  function scaffold({ source = false, tsx = false, dist = false } = {}) {
    const root = makeTmpDir();
    if (source) {
      mkdirSync(join(root, 'ui'), { recursive: true });
      writeFileSync(join(root, 'ui', 'serve.ts'), '// stub');
    }
    if (tsx) {
      mkdirSync(join(root, 'node_modules', 'tsx', 'dist'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '// stub');
    }
    if (dist) {
      mkdirSync(join(root, 'dist', 'ui'), { recursive: true });
      writeFileSync(join(root, 'dist', 'ui', 'serve.js'), '// stub');
    }
    return root;
  }

  it('源码 + tsx 优先于 dist：dist 是旧快照，源码是当前事实', () => {
    const root = scaffold({ source: true, tsx: true, dist: true });
    const entry = resolveHostEntry({ repoRoot: root, env: {} });
    expect(entry.kind).toBe('source');
    expect(entry.nodeArgs[0]).toContain('cli.mjs');
    expect(entry.nodeArgs[1]).toContain('serve.ts');
  });

  it('缺 tsx 时回落 dist；两者皆无返回 null', () => {
    const distOnly = scaffold({ source: true, dist: true });
    expect(resolveHostEntry({ repoRoot: distOnly, env: {} }).kind).toBe('dist');
    const nothing = scaffold();
    expect(resolveHostEntry({ repoRoot: nothing, env: {} })).toBeNull();
  });

  it('AGENT_UI_HOST_ENTRY 显式指定优先；指了不存在的文件 fail-closed 返回 null 不降级', () => {
    const root = scaffold({ source: true, tsx: true, dist: true });
    const entryFile = join(root, 'custom-serve.js');
    writeFileSync(entryFile, '// stub');
    expect(resolveHostEntry({ repoRoot: root, env: { AGENT_UI_HOST_ENTRY: entryFile } })).toEqual({
      kind: 'override',
      nodeArgs: [entryFile],
    });
    expect(resolveHostEntry({ repoRoot: root, env: { AGENT_UI_HOST_ENTRY: join(root, 'missing.js') } })).toBeNull();
  });
});

describe('pickFreePort / probeHealthy / waitForHealthy（真实网络）', () => {
  it('pickFreePort 给出的端口立刻可绑', async () => {
    const port = await pickFreePort();
    expect(Number.isInteger(port) && port > 0).toBe(true);
    await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => server.close(resolve));
    });
  });

  it('probeHealthy：无人监听是 false，/health 200 是 true，非 200 是 false', async () => {
    const idle = await pickFreePort();
    expect(await probeHealthy(`http://127.0.0.1:${idle}`)).toBe(false);

    let status = 503;
    const server = http.createServer((req, res) => {
      res.writeHead(req.url === '/health' ? status : 404);
      res.end();
    });
    const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    cleanups.push(() => new Promise((r) => server.close(r)));
    expect(await probeHealthy(`http://127.0.0.1:${port}`)).toBe(false);
    status = 200;
    expect(await probeHealthy(`http://127.0.0.1:${port}`)).toBe(true);
  });

  it('waitForHealthy 真等到 200 才返回（下界断言防"探完即返"变异）；isAborted 立即失败', async () => {
    let status = 503;
    const server = http.createServer((_req, res) => {
      res.writeHead(status);
      res.end();
    });
    const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    cleanups.push(() => new Promise((r) => server.close(r)));
    setTimeout(() => {
      status = 200;
    }, 300);
    const flipStart = Date.now();
    await expect(waitForHealthy(`http://127.0.0.1:${port}`, { timeoutMs: 5000, intervalMs: 50 })).resolves.toBeUndefined();
    // 503 在 300ms 后才翻 200：若实现不看探活结果提前返回，这里会 < 295
    expect(Date.now() - flipStart).toBeGreaterThanOrEqual(295);

    const started = Date.now();
    await expect(
      waitForHealthy(`http://127.0.0.1:${await pickFreePort()}`, {
        timeoutMs: 10_000,
        intervalMs: 50,
        isAborted: () => true,
      }),
    ).rejects.toThrow(/退出/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('waitForHealthy 超时路径：一直不健康要以"未就绪"报错，不能静默成功', async () => {
    const idle = await pickFreePort();
    await expect(
      waitForHealthy(`http://127.0.0.1:${idle}`, { timeoutMs: 400, intervalMs: 50 }),
    ).rejects.toThrow(/未就绪/);
  });
});

describe('spawnHost / stopHostTree：真拉起、真收树（僵尸进程纪律）', () => {
  it('拉起的假宿主按 AGENT_UI_PORT 绑定；stopHostTree 连孙进程一起收干净', async () => {
    const dir = makeTmpDir();
    const fakeHost = join(dir, 'fake-host.cjs');
    writeFileSync(
      fakeHost,
      [
        "const http = require('node:http');",
        "const { spawn } = require('node:child_process');",
        'const port = Number(process.env.AGENT_UI_PORT);',
        "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        'const server = http.createServer((req, res) => { res.writeHead(200); res.end(); });',
        '// 回显环境契约与实际绑定地址，让父进程能断言而不是信任注释',
        'server.listen(port, process.env.AGENT_UI_HOST, () =>',
        "  console.log('grandchild=' + grandchild.pid + ' runasnode=' + (process.env.ELECTRON_RUN_AS_NODE || '') + ' addr=' + server.address().address));",
      ].join('\n'),
    );

    const port = await pickFreePort();
    // execPath 用当前 Node：spawnHost 的代码路径与 Electron 下完全相同
    //（ELECTRON_RUN_AS_NODE 对普通 node 是无害环境变量）。
    const child = spawnHost({
      execPath: process.execPath,
      nodeArgs: [fakeHost],
      repoRoot: dir,
      env: { ...process.env },
      port,
    });
    cleanups.push(() => stopHostTree(child));

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    await waitForHealthy(`http://127.0.0.1:${port}`, {
      timeoutMs: 10_000,
      intervalMs: 100,
      isAborted: () => child.exitCode !== null,
    });
    expect(await eventually(() => /grandchild=\d+/.test(stdout))).toBe(true);
    const grandchildPid = Number(stdout.match(/grandchild=(\d+)/)[1]);
    // 环境契约：生产里 execPath 是 Electron 可执行文件，缺 ELECTRON_RUN_AS_NODE
    // 会拉起 GUI 实例而非 Node 宿主；缺 AGENT_UI_HOST 会静默绑全部网卡
    expect(stdout).toContain('runasnode=1');
    expect(stdout).toContain('addr=127.0.0.1');
    expect(pidAlive(child.pid)).toBe(true);
    expect(pidAlive(grandchildPid)).toBe(true);

    expect(await stopHostTree(child, { timeoutMs: 5000 })).toBe(true);
    expect(await eventually(() => !pidAlive(child.pid))).toBe(true);
    expect(await eventually(() => !pidAlive(grandchildPid))).toBe(true);
    expect(await probeHealthy(`http://127.0.0.1:${port}`)).toBe(false);
  });

  it('win32 分支形状（任意平台可测）：taskkill 带 /T 连树；对方不退要返回 false 不许装成功', async () => {
    expect(taskkillArgs(123)).toEqual(['/PID', '123', '/T', '/F']);

    const calls = [];
    const stubborn = fakeChildHandle();
    const obeying = fakeChildHandle();
    // 对方杀完即退：runTaskkill 被调用一次且返回 true
    expect(
      await stopHostTree(obeying, {
        platform: 'win32',
        timeoutMs: 300,
        runTaskkill: (pid) => {
          calls.push(pid);
          obeying.emitExit();
        },
      }),
    ).toBe(true);
    expect(calls).toEqual([obeying.pid]);
    // 对方赖着不退：必须如实返回 false（main.cjs 靠它打残留告警 + exit(1)）
    expect(await stopHostTree(stubborn, { platform: 'win32', timeoutMs: 200, runTaskkill: () => {} })).toBe(false);
  });

  it('POSIX 分支形状（任意平台可测）：进程组先 SIGTERM 超时升级 SIGKILL，仍不退返回 false', async () => {
    const signals = [];
    const stubborn = fakeChildHandle();
    const result = await stopHostTree(stubborn, {
      platform: 'linux',
      timeoutMs: 150,
      killGroup: (pid, sig) => signals.push(`${pid}:${sig}`),
    });
    expect(signals).toEqual([`${stubborn.pid}:SIGTERM`, `${stubborn.pid}:SIGKILL`]);
    expect(result).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('真机升级路径：宿主吞 SIGTERM 时 SIGKILL 兜底收干净', async () => {
    const dir = makeTmpDir();
    const stubbornHost = join(dir, 'stubborn-host.cjs');
    writeFileSync(
      stubbornHost,
      [
        "const http = require('node:http');",
        "process.on('SIGTERM', () => {}); // 故意吞掉优雅关停信号",
        'const server = http.createServer((req, res) => { res.writeHead(200); res.end(); });',
        "server.listen(Number(process.env.AGENT_UI_PORT), process.env.AGENT_UI_HOST, () => console.log('up'));",
      ].join('\n'),
    );
    const port = await pickFreePort();
    const child = spawnHost({
      execPath: process.execPath,
      nodeArgs: [stubbornHost],
      repoRoot: dir,
      env: { ...process.env },
      port,
    });
    cleanups.push(() => stopHostTree(child));
    await waitForHealthy(`http://127.0.0.1:${port}`, { timeoutMs: 10_000, intervalMs: 100 });
    expect(await stopHostTree(child, { timeoutMs: 500 })).toBe(true);
    expect(await eventually(() => !pidAlive(child.pid))).toBe(true);
  });

  it('已退出的子进程重复 stop 是幂等的 true', async () => {
    const dir = makeTmpDir();
    const script = join(dir, 'exit0.cjs');
    writeFileSync(script, 'process.exit(0);');
    const child = spawnHost({
      execPath: process.execPath,
      nodeArgs: [script],
      repoRoot: dir,
      env: { ...process.env },
      port: 1,
    });
    await new Promise((resolve) => child.once('exit', resolve));
    expect(await stopHostTree(child)).toBe(true);
    expect(await stopHostTree(child)).toBe(true);
  });
});

describe('createLogTail', () => {
  it('只留最后 N 行，超长行截断', () => {
    const tail = createLogTail(3, 10);
    tail.push('a\nb\nc\nd\n');
    tail.push(`e${'x'.repeat(50)}\n`);
    const text = tail.text();
    expect(text).not.toContain('a');
    expect(text).toContain('c');
    expect(text).toContain('d');
    expect(text).toContain('…');
    expect(text.split('\n')).toHaveLength(3);
  });
});

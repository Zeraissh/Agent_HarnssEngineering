import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import launcher from '../electron/host-launcher.cjs';

const executable = path.resolve('dist-electron', 'win-unpacked', 'Agent Harness.exe');
const userData = mkdtempSync(path.join(tmpdir(), 'agent-harness-packaged-smoke-'));
const port = await launcher.pickFreePort();
const sentinel = `desktop-smoke-${process.pid}`;
const environment = {
  ...process.env,
  AGENT_UI_PORT: String(port),
  ANTHROPIC_API_KEY: sentinel,
};
delete environment.AGENT_UI_URL;
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawn(executable, [`--user-data-dir=${userData}`], {
  env: environment,
  stdio: ['ignore', 'ignore', 'ignore'],
  windowsHide: true,
});

let healthy = false;
let snapshotRedacted = false;
let stoppedCleanly = false;
try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    if (await launcher.probeHealthy(`http://127.0.0.1:${port}`, { timeoutMs: 500 })) {
      healthy = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (healthy) {
    const response = await fetch(`http://127.0.0.1:${port}/api/harness`);
    const body = await response.text();
    snapshotRedacted = response.ok && !body.includes(sentinel);
  }
} finally {
  stoppedCleanly = await launcher.stopHostTree(child);
  const resolvedUserData = realpathSync(userData);
  const resolvedTemp = realpathSync(tmpdir());
  if (!resolvedUserData.startsWith(`${resolvedTemp}${path.sep}`)) {
    throw new Error(`Refusing cleanup outside temp: ${resolvedUserData}`);
  }
  rmSync(resolvedUserData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const result = { healthy, snapshotRedacted, stoppedCleanly };
console.log(JSON.stringify(result));
if (!Object.values(result).every(Boolean)) process.exitCode = 1;

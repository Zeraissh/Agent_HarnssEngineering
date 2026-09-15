#!/usr/bin/env node
/**
 * E2E-01 Electron NSIS 生命周期冒烟：静默安装 → 覆盖安装（升级路径）→ 卸载。
 *
 * Windows-only。不点 GUI；复用 electron-builder 默认 NSIS `/S` 与 `/D=`。
 *
 * 用法：
 *   node scripts/electron-nsis-lifecycle-smoke.mjs            # 用已有 dist-electron setup
 *   node scripts/electron-nsis-lifecycle-smoke.mjs --build    # 先 unsigned 打两版再演练
 *
 * 非 Windows：默认 exit 0 并说明跳过；设 AGENT_ELECTRON_LIFECYCLE_REQUIRED=1 则失败。
 */
import { spawnSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crossApp = path.join(root, "cross-app");
const distDir = path.join(crossApp, "dist-electron");
const pkgPath = path.join(crossApp, "package.json");
const required = process.env.AGENT_ELECTRON_LIFECYCLE_REQUIRED === "1";
const doBuild = process.argv.includes("--build");
const launcher = require(path.join(crossApp, "electron", "host-launcher.cjs"));

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    windowsHide: true,
    ...opts,
  });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) {
    fail(
      `${cmd} ${args.join(" ")} failed (${r.status}):\n${r.stderr || r.stdout || ""}`.trim(),
    );
  }
  return r;
}

function npmRun(script, cwd) {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  return run(npmCmd, ["run", script], { cwd, timeout: 600_000, shell: true });
}

if (process.platform !== "win32") {
  const msg = "electron-nsis-lifecycle-smoke: skip (Windows-only NSIS path)";
  if (required) fail(msg);
  console.log(msg);
  process.exit(0);
}

const installRoot = mkdtempSync(path.join(tmpdir(), "agent-harness-nsis-"));
const installDir = path.join(installRoot, "AgentHarness");
/** 与 electron-builder.yml productName/executableName 对齐；旧包名留给覆盖升级。 */
const DESKTOP_EXE_NAMES = ["FATHOM.exe", "Agent Harness.exe"];

function findInstalledExe(dir) {
  for (const name of DESKTOP_EXE_NAMES) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function killInstalledGui() {
  for (const name of DESKTOP_EXE_NAMES) {
    spawnSync("taskkill", ["/IM", name, "/F"], {
      windowsHide: true,
      encoding: "utf8",
    });
  }
}

function findSetup(versionHint) {
  if (!existsSync(distDir)) return null;
  const files = readdirSync(distDir).filter((f) => /-setup\.exe$/i.test(f));
  if (versionHint) {
    const hit = files.find((f) => f.includes(versionHint));
    if (hit) return path.join(distDir, hit);
  }
  files.sort();
  return files.length ? path.join(distDir, files[files.length - 1]) : null;
}

function silentInstall(setupExe) {
  // 旧包可能仍 runAfterFinish=true：装完会拉起 GUI。只杀应用、等安装器自己退出，
  // 否则过早 taskkill 安装器会丢卸载器。
  const child = spawn(setupExe, ["/S", `/D=${installDir}`], {
    windowsHide: true,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const harnessMarker = path.join(installDir, "resources", "harness", "package.json");
  const deadline = Date.now() + 240_000;
  let sawHarness = false;
  while (Date.now() < deadline) {
    const exe = findInstalledExe(installDir);
    if (exe && existsSync(harnessMarker)) {
      sawHarness = true;
      killInstalledGui();
      const names = existsSync(installDir) ? readdirSync(installDir) : [];
      const hasUninstaller = names.some((n) => /^uninstall/i.test(n) && /\.exe$/i.test(n));
      const installerGone = child.exitCode !== null || child.signalCode !== null;
      if (hasUninstaller || installerGone) {
        // 再给卸载器落盘一点时间
        if (!hasUninstaller) {
          spawnSync("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Seconds 2"], {
            windowsHide: true,
          });
        }
        console.log(`ok: installed → ${exe}`);
        return exe;
      }
    }
    spawnSync("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 400"], {
      windowsHide: true,
    });
  }
  if (child.pid && child.exitCode === null) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  }
  const names = existsSync(installDir) ? readdirSync(installDir) : [];
  fail(
    `silent install timed out under ${installDir} `
    + `(harness=${sawHarness} files=${names.join(", ") || "none"})`,
  );
}

function silentUninstall() {
  const names = readdirSync(installDir);
  const uninstallerName = names.find((n) => /^uninstall/i.test(n) && /\.exe$/i.test(n));
  if (!uninstallerName) {
    fail(`uninstaller missing under ${installDir}; saw: ${names.join(", ")}`);
  }
  const uninstaller = path.join(installDir, uninstallerName);
  const child = spawn(uninstaller, ["/S"], {
    windowsHide: true,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (!existsSync(installDir)) {
      console.log("ok: uninstall cleared install dir");
      return;
    }
    try {
      const left = readdirSync(installDir);
      if (left.length === 0) {
        rmSync(installDir, { recursive: true, force: true });
        console.log("ok: uninstall cleared install dir");
        return;
      }
    } catch {
      if (!existsSync(installDir)) {
        console.log("ok: uninstall cleared install dir");
        return;
      }
    }
    spawnSync("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 400"], {
      windowsHide: true,
    });
  }
  if (child.pid && child.exitCode === null) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  }
  const left = existsSync(installDir) ? readdirSync(installDir) : [];
  fail(`uninstall left files in ${installDir}: ${left.join(", ") || "(dir exists)"}`);
}

async function probeInstalledExe(exe) {
  const userData = mkdtempSync(path.join(tmpdir(), "agent-harness-nsis-ud-"));
  const port = await launcher.pickFreePort();
  const environment = {
    ...process.env,
    AGENT_UI_PORT: String(port),
  };
  delete environment.AGENT_UI_URL;
  delete environment.ELECTRON_RUN_AS_NODE;
  // 本机会话可能残留研究用 AGENT_EXECUTION_*；安装包探针不得继承。
  for (const key of Object.keys(environment)) {
    if (key.startsWith("AGENT_EXECUTION_") || key.startsWith("AGENT_TEST_OCI_")) {
      delete environment[key];
    }
  }
  const child = spawn(exe, [`--user-data-dir=${userData}`], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (c) => {
    stdout = `${stdout}${c}`.slice(-4_000);
  });
  child.stderr?.on("data", (c) => {
    stderr = `${stderr}${c}`.slice(-4_000);
  });
  let healthy = false;
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      if (await launcher.probeHealthy(`http://127.0.0.1:${port}`, { timeoutMs: 500 })) {
        healthy = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!healthy && child.exitCode !== null) {
      fail(
        `installed exe exited before /health (code=${child.exitCode}):\n${stderr || stdout}`,
      );
    }
  } finally {
    await launcher.stopHostTree(child);
    const resolved = realpathSync(userData);
    if (resolved.startsWith(realpathSync(tmpdir()) + path.sep)) {
      rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
  if (!healthy) {
    fail(`installed exe did not become healthy on /health:\n${stderr || stdout || "(no output)"}`);
  }
  console.log("ok: installed exe /health");
}

function withPackageVersion(version, fn) {
  const original = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(original);
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  try {
    return fn();
  } finally {
    writeFileSync(pkgPath, original, "utf8");
  }
}

function buildUnsigned(version) {
  withPackageVersion(version, () => {
    console.log(`building unsigned ${version}…`);
    npmRun("desktop:dist:unsigned", crossApp);
  });
  const setup = findSetup(version);
  if (!setup) fail(`no setup.exe for version ${version} under ${distDir}`);
  console.log(`ok: built ${setup}`);
  return setup;
}

try {
  let setupA;
  let setupB;
  if (doBuild) {
    setupA = buildUnsigned("0.0.0-smoke1");
    setupB = buildUnsigned("0.0.0-smoke2");
  } else {
    setupA = findSetup();
    if (!setupA) {
      fail(
        "no *-setup.exe in cross-app/dist-electron; run with --build or npm run desktop:dist:unsigned first",
      );
    }
    setupB = setupA;
    console.log(`using existing setup: ${setupA}`);
  }

  silentInstall(setupA);
  if (doBuild || process.argv.includes("--require-health")) {
    const exeA = findInstalledExe(installDir);
    if (!exeA) fail(`installed exe missing under ${installDir}`);
    await probeInstalledExe(exeA);
  } else {
    console.log("ok: skip /health (reuse stale setup; pass --build or --require-health)");
  }
  // 覆盖安装 = NSIS 升级路径（同目录 /D=）。
  silentInstall(setupB);
  if (doBuild || process.argv.includes("--require-health")) {
    const exeB = findInstalledExe(installDir);
    if (!exeB) fail(`installed exe missing under ${installDir} after upgrade`);
    await probeInstalledExe(exeB);
  }
  silentUninstall();
  console.log("electron-nsis-lifecycle-smoke: pass");
} finally {
  rmSync(installRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

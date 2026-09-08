/**
 * SAFE-05 / WSL2 — 经 wsl.exe 调用 Linux 侧 Docker（信任根仍在 WSL 内）。
 *
 * 裸 `wsl.exe` / System32 bash **不是**沙箱（ADR-001 约束 1）。本模块只做
 * 「Windows 宿主 → WSL2 内已验证的 docker CLI」的运输层；隔离 profile 仍是 OCI。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { windowsPathToWsl } from "./wsl-path.js";

const SHA256 = /^[0-9a-f]{64}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface Wsl2RuntimeDiscovery {
  wslExe: string;
  distro: string;
  dockerPath: string;
  dockerSha256: string;
  socketPath: string;
  /** WSL 侧观测到的 broker 身份（boot/pidns/pid/start） */
  owner: {
    boot: string;
    pidNamespace: string;
    pid: number;
    startTicks: string;
  };
}

/**
 * 经临时 .sh 跑 WSL bash——避免把含 `$DOCKER` 的 -lc 串直接塞进 Windows 进程
 * 参数表时被吃空（fixture 脚本曾踩过同一坑）。
 */
function wslCaptureScript(
  wslExe: string,
  distro: string,
  bashBody: string,
  timeoutMs = 15_000,
): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const dir = mkdtempSync(path.join(tmpdir(), "wsl2-probe-"));
  const scriptPath = path.join(dir, "probe.sh");
  try {
    writeFileSync(scriptPath, `#!/bin/bash\nset -eu\n${bashBody}\n`, "utf8");
    const wslScript = windowsPathToWsl(scriptPath);
    const result = spawnSync(
      wslExe,
      ["-d", distro, "--", "/bin/bash", wslScript],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      },
    );
    return {
      ok: result.status === 0 && !result.error,
      stdout: (result.stdout ?? "").toString(),
      stderr: (result.stderr ?? "").toString(),
      status: result.status,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 解析 `wsl -l -v` 的默认发行版（行首 `*`）。 */
export function parseDefaultWslDistro(listOutput: string): string | null {
  // wsl -l -v 常带 UTF-16；调用方应先转成 utf8 文本。
  const lines = listOutput.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const line of lines) {
    const starred = /^\*\s+(\S+)/.exec(line.trimEnd());
    if (starred) return starred[1]!;
  }
  for (const line of lines) {
    const plain = /^\s*(\S+)\s+(Running|Stopped)\s+/i.exec(line);
    if (plain && plain[1] !== "NAME") return plain[1]!;
  }
  return null;
}

export function resolveWslExe(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["AGENT_EXECUTION_WSL_EXE"]?.trim();
  if (override) return override;
  return "C:\\Windows\\System32\\wsl.exe";
}

/**
 * 探测 WSL2 + 根所有的 docker CLI + 本机 unix socket。
 * 失败抛错（required 路径 fail-closed，绝不回退宿主 docker）。
 */
export function discoverWsl2DockerRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Wsl2RuntimeDiscovery {
  if (process.platform !== "win32") {
    throw new Error("WSL2 OCI transport is only available on Windows");
  }
  const wslExe = resolveWslExe(env);
  const list = spawnSync(wslExe, ["-l", "-v"], {
    encoding: "buffer",
    windowsHide: true,
    timeout: 10_000,
  });
  if (list.error || list.status !== 0) {
    throw new Error(
      `WSL2 is unavailable (${list.error?.message ?? `exit ${list.status}`}); required isolation cannot host-fallback`,
    );
  }
  // wsl -l -v 输出 UTF-16LE
  const listText = Buffer.isBuffer(list.stdout)
    ? list.stdout.toString("utf16le")
    : String(list.stdout ?? "");
  const distro =
    env["AGENT_EXECUTION_WSL_DISTRO"]?.trim()
    || parseDefaultWslDistro(listText);
  if (!distro) {
    throw new Error("WSL2 has no installed distro; required isolation cannot host-fallback");
  }

  const configuredRuntime = env["AGENT_EXECUTION_OCI_RUNTIME"]?.trim();
  const configuredHash = env["AGENT_EXECUTION_OCI_RUNTIME_SHA256"]?.trim().toLowerCase();
  const host = env["AGENT_EXECUTION_OCI_HOST"]?.trim() || "unix:///var/run/docker.sock";
  const socketMatch = /^unix:\/\/(\/[^\r\n]+)$/.exec(host);
  if (!socketMatch?.[1]) {
    throw new Error("AGENT_EXECUTION_OCI_HOST must be a local absolute unix:// socket");
  }
  const socketPath = socketMatch[1];

  const dockerPath = configuredRuntime || "/usr/bin/docker";
  // 信任检查在 WSL 内完成：root 所有、非 group/world 可写、SHA-256、socket 为 root 拥有。
  // 变量赋值用字面量注入（已 shellQuote），探针体不再依赖易被宿主吃掉的 -lc 串。
  const bashBody = [
    `DOCKER=${shellQuote(dockerPath)}`,
    `SOCK=${shellQuote(socketPath)}`,
    'test -f "$DOCKER"',
    'OWNER=$(stat -c "%u %a" "$DOCKER")',
    'test "$(echo "$OWNER" | awk \'{print $1}\')" = "0"',
    'PERM=$(echo "$OWNER" | awk \'{print $2}\')',
    'test $((8#$PERM & 022)) -eq 0',
    'HASH=$(sha256sum "$DOCKER" | awk \'{print $1}\')',
    'test -S "$SOCK"',
    'SOWNER=$(stat -c "%u %a" "$SOCK")',
    'test "$(echo "$SOWNER" | awk \'{print $1}\')" = "0"',
    'SPERM=$(echo "$SOWNER" | awk \'{print $2}\')',
    'test $((8#$SPERM & 002)) -eq 0',
    "BOOT=$(tr -d '\\n' </proc/sys/kernel/random/boot_id | tr 'A-F' 'a-f')",
    "PIDNS=$(readlink /proc/$$/ns/pid)",
    "STAT=$(cat /proc/$$/stat)",
    'printf "%s\\n" "$HASH"',
    'printf "%s\\n" "$BOOT"',
    'printf "%s\\n" "$PIDNS"',
    'printf "%s\\n" "$$"',
    'printf "%s\\n" "$STAT"',
  ].join("\n");

  const probed = wslCaptureScript(wslExe, distro, bashBody);
  if (!probed.ok) {
    throw new Error(
      `WSL2 Docker trust probe failed: ${probed.stderr.trim() || probed.stdout.trim() || `exit ${probed.status}`}`,
    );
  }
  const lines = probed.stdout.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hash = lines[0]?.toLowerCase();
  const bootId = lines[1]?.toLowerCase();
  const pidNamespace = lines[2];
  const pidRaw = lines[3];
  const statLine = lines.slice(4).join(" ");
  if (!hash || !SHA256.test(hash)) {
    throw new Error("WSL2 Docker trust probe did not return a SHA-256");
  }
  if (configuredHash && configuredHash !== hash) {
    throw new Error("Configured OCI runtime SHA-256 does not match the executable inside WSL");
  }
  if (configuredRuntime && configuredRuntime !== dockerPath) {
    // path was taken from env already
  }
  if (!bootId || !UUID.test(bootId)) throw new Error("WSL boot_id is not a UUID");
  if (!pidNamespace || !/^pid:\[[1-9][0-9]*\]$/.test(pidNamespace)) {
    throw new Error("WSL PID namespace identity is invalid");
  }
  const pid = Number(pidRaw);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("WSL owner PID is invalid");

  const close = statLine.lastIndexOf(") ");
  const open = statLine.indexOf(" (");
  if (open <= 0 || close <= open) throw new Error("WSL process stat has an invalid comm field");
  const fields = statLine.slice(close + 2).trim().split(/\s+/);
  const startTicks = fields[19];
  if (!startTicks || !/^[1-9][0-9]*$/.test(startTicks)) {
    throw new Error("WSL process stat is missing starttime");
  }

  return {
    wslExe,
    distro,
    dockerPath,
    dockerSha256: hash,
    socketPath,
    owner: {
      boot: createHash("sha256").update("agent-harness/boot/v1\0").update(bootId).digest("hex"),
      pidNamespace: createHash("sha256")
        .update("agent-harness/pid-namespace/v1\0")
        .update(pidNamespace)
        .digest("hex"),
      pid,
      startTicks,
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 构造经 wsl.exe 转发的 docker argv：`wsl -d Distro -- /usr/bin/docker --host ... rest` */
export function buildWslDockerArgv(
  discovery: Pick<Wsl2RuntimeDiscovery, "distro" | "dockerPath">,
  host: string,
  dockerArgs: string[],
): { file: string; args: string[] } {
  return {
    file: resolveWslExe(),
    args: ["-d", discovery.distro, "--", discovery.dockerPath, "--host", host, ...dockerArgs],
  };
}

/**
 * SAFE-05 — 任意命令的唯一执行边界。
 *
 * 这里刻意把“迁移期开着 host exec”与“通过功能探测的 OCI 执行”放在同一个
 * 明确契约里。required 路径没有 host fallback；report 路径即使探测到 OCI 也
 * 仍只报告、继续宿主直跑，避免一次配置探测悄悄改变任务语义。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, opendir, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ExecutionBackendPreference,
  ExecutionBoundaryStatus,
  ExecutionBroker,
  ExecutionIsolationMode,
  ShellExecutionRequest,
  ShellExecutionResult,
} from "./types.js";

const MODES = ["off", "report", "required"] as const;
const BACKENDS = ["auto", "oci", "bwrap"] as const;
const OCI_IMAGE = /^(?:[^\s@]+@)?sha256:[0-9a-f]{64}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const LOCAL_UNIX_SOCKET = /^unix:\/\/(\/[^\r\n]+)$/;
const OCI_NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_24 = /^[0-9a-f]{24}$/;
// Schema 3 adds boot/PID-namespace/PID/starttime owner fencing. Schema 2
// tombstones predate that proof and must be migrated manually, never guessed.
const OCI_LEASE_SCHEMA = "3";
const OCI_LEASE_GRACE_MS = 15_000;
const OCI_REAPER_TIMEOUT_MS = 30_000;
const OCI_MIN_LEASE_MS = 1_000;
const OCI_MAX_LEASE_MS = 24 * 60 * 60 * 1_000;
const OCI_MAX_REAPER_TARGETS = 256;
const OCI_OWNER_ID = randomUUID();
const SENSITIVE_ENV_NAME =
  /SECRET|(?:^|_)(?:API_?KEY|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY|ACCESS_KEY(?:_ID)?)$/i;

/** Broker 端再次去密，不信任工具调用方已经正确处理 request.env。 */
export function sanitizeChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = new Set(
    (env["AGENT_BASH_KEEP_ENV"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!keep.has(name) && SENSITIVE_ENV_NAME.test(name)) continue;
    clean[name] = value;
  }
  return clean;
}

export const OCI_PROFILE = Object.freeze({
  user: "65532:65532",
  pids: 128,
  memory: "1g",
  cpus: "1.0",
  nofile: "1024:1024",
  tmpfs: "/tmp:rw,nosuid,nodev,noexec,size=64m",
  workspace: "/workspace",
});

export interface ExecutionPolicyConfig {
  mode: ExecutionIsolationMode;
  backend: ExecutionBackendPreference;
  /** 管理员固定的 Docker CLI 真实绝对路径；required 不做 PATH 查找。 */
  ociRuntime?: string;
  /** Docker CLI 文件内容摘要；required 在 probe 与每次执行前都复核。 */
  ociRuntimeSha256?: string;
  /** 只允许本机 Unix socket，拒绝由环境变量切到远端/用户 context。 */
  ociHost: string;
  ociImage?: string;
  /** 管理员固定的 daemon 分区；label 中只保存其摘要。 */
  ociNamespace?: string;
  /** worker wall timeout 之外留给 daemon cleanup/readback 的固定宽限。 */
  ociLeaseGraceMs: number;
  /** 单次 durable sweep 的控制面总时限。 */
  ociReaperTimeoutMs: number;
  policyDigest: string;
}

export interface OciProbeResult {
  ready: boolean;
  reason?: string;
  runtimeVersion?: string;
  /** 探针 worker 的删除无法由 daemon 明确确认；adapter 必须进入 tainted。 */
  cleanupFailed?: boolean;
}

export interface OciExecutionAdapter {
  preflightWorkdir?(
    policy: ExecutionPolicyConfig,
    workdir: string,
    boundaryId: string,
  ): Promise<void>;
  probe(policy: ExecutionPolicyConfig): Promise<OciProbeResult>;
  execute(
    policy: ExecutionPolicyConfig,
    request: ShellExecutionRequest,
    boundaryId: string,
    status: ExecutionBoundaryStatus,
  ): Promise<ShellExecutionResult>;
  dispose?(policy: ExecutionPolicyConfig, boundaryId: string): Promise<void>;
}

export interface ExecutionBrokerOptions {
  boundaryId: string;
  workdir: string;
  env?: NodeJS.ProcessEnv;
  ociAdapter?: OciExecutionAdapter;
  directRunner?: (
    request: ShellExecutionRequest,
    status: ExecutionBoundaryStatus,
  ) => Promise<ShellExecutionResult>;
  /** 同一 run 内避免每次 bash 都重跑 canary；readiness/admission 会强制绕过。 */
  probeTtlMs?: number;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function executionNamespaceLabel(namespace: string): string {
  return createHash("sha256")
    .update("agent-harness/oci-namespace/v1\0")
    .update(namespace)
    .digest("hex");
}

function boundedIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${name} must be a base-10 positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function copyStatus(status: ExecutionBoundaryStatus): ExecutionBoundaryStatus {
  return {
    ...status,
    probe: { ...status.probe },
    coverage: [...status.coverage],
  };
}

export function parseExecutionPolicy(
  env: NodeJS.ProcessEnv = process.env,
): ExecutionPolicyConfig {
  const rawMode = (env["AGENT_EXECUTION_ISOLATION"] ?? "report").trim().toLowerCase();
  if (!(MODES as readonly string[]).includes(rawMode)) {
    throw new Error(
      `AGENT_EXECUTION_ISOLATION="${rawMode}" is invalid; expected ${MODES.join(" | ")}`,
    );
  }
  const rawBackend = (env["AGENT_EXECUTION_BACKEND"] ?? "auto").trim().toLowerCase();
  if (!(BACKENDS as readonly string[]).includes(rawBackend)) {
    throw new Error(
      `AGENT_EXECUTION_BACKEND="${rawBackend}" is invalid; expected ${BACKENDS.join(" | ")}`,
    );
  }
  const mode = rawMode as ExecutionIsolationMode;
  const backend = rawBackend as ExecutionBackendPreference;
  const ociRuntime = env["AGENT_EXECUTION_OCI_RUNTIME"]?.trim() || undefined;
  if (ociRuntime && !path.isAbsolute(ociRuntime)) {
    throw new Error(
      "AGENT_EXECUTION_OCI_RUNTIME must be an administrator-pinned absolute Docker CLI path; PATH lookup is forbidden",
    );
  }
  const ociRuntimeSha256 = env["AGENT_EXECUTION_OCI_RUNTIME_SHA256"]?.trim().toLowerCase() || undefined;
  if (ociRuntimeSha256 && !SHA256.test(ociRuntimeSha256)) {
    throw new Error("AGENT_EXECUTION_OCI_RUNTIME_SHA256 must contain exactly 64 hexadecimal characters");
  }
  if (Boolean(ociRuntime) !== Boolean(ociRuntimeSha256)) {
    throw new Error(
      "AGENT_EXECUTION_OCI_RUNTIME and AGENT_EXECUTION_OCI_RUNTIME_SHA256 must be configured together",
    );
  }
  const explicitHost = env["AGENT_EXECUTION_OCI_HOST"]?.trim();
  const ociHost = explicitHost || "unix:///var/run/docker.sock";
  if (!LOCAL_UNIX_SOCKET.test(ociHost)) {
    throw new Error(
      "AGENT_EXECUTION_OCI_HOST must be a local absolute unix:// socket; tcp/ssh/context endpoints are forbidden",
    );
  }
  const ociImage = env["AGENT_EXECUTION_OCI_IMAGE"]?.trim() || undefined;
  const ociNamespace = env["AGENT_EXECUTION_OCI_NAMESPACE"]?.trim() || undefined;
  if (ociNamespace && !OCI_NAMESPACE.test(ociNamespace)) {
    throw new Error(
      "AGENT_EXECUTION_OCI_NAMESPACE must be 1-64 characters using letters, digits, dot, underscore, or hyphen",
    );
  }
  const ociLeaseGraceMs = boundedIntegerEnv(
    env,
    "AGENT_EXECUTION_OCI_LEASE_GRACE_MS",
    OCI_LEASE_GRACE_MS,
    1_000,
    60_000,
  );
  const ociReaperTimeoutMs = boundedIntegerEnv(
    env,
    "AGENT_EXECUTION_OCI_REAPER_TIMEOUT_MS",
    OCI_REAPER_TIMEOUT_MS,
    5_000,
    120_000,
  );

  if (mode === "off" && (
    backend !== "auto"
    || ociImage
    || ociRuntime
    || ociRuntimeSha256
    || explicitHost
  )) {
    throw new Error(
      "AGENT_EXECUTION_ISOLATION=off cannot be combined with an isolation backend/image/runtime/host",
    );
  }
  if (ociImage && !OCI_IMAGE.test(ociImage)) {
    throw new Error(
      "AGENT_EXECUTION_OCI_IMAGE must be content-addressed (repo@sha256:<64 hex> or sha256:<64 hex>)",
    );
  }

  const policyDigest = digest({
    schemaVersion: 2,
    mode,
    backend,
    ociRuntime: ociRuntime ?? null,
    ociRuntimeSha256: ociRuntimeSha256 ?? null,
    ociHost,
    ociImage: ociImage ?? null,
    ociNamespace: ociNamespace ? executionNamespaceLabel(ociNamespace) : null,
    ociLeaseGraceMs,
    ociReaperTimeoutMs,
    ociLeaseSchema: OCI_LEASE_SCHEMA,
    profile: OCI_PROFILE,
    network: "none",
    rootfs: "read-only",
    coverage: ["bash"],
  });
  return {
    mode,
    backend,
    ociHost,
    ociLeaseGraceMs,
    ociReaperTimeoutMs,
    ...(ociRuntime ? { ociRuntime } : {}),
    ...(ociRuntimeSha256 ? { ociRuntimeSha256 } : {}),
    ...(ociImage ? { ociImage } : {}),
    ...(ociNamespace ? { ociNamespace } : {}),
    policyDigest,
  };
}

function candidateFor(policy: ExecutionPolicyConfig): "oci" | "bwrap" | null {
  if (policy.backend === "oci") return "oci";
  if (policy.backend === "bwrap") return "bwrap";
  return policy.ociImage ? "oci" : null;
}

function initialStatus(
  policy: ExecutionPolicyConfig,
  boundaryId: string,
): ExecutionBoundaryStatus {
  const candidate = candidateFor(policy);
  if (policy.mode === "off") {
    return {
      schemaVersion: 1,
      boundaryId,
      requestedMode: policy.mode,
      requestedBackend: policy.backend,
      effectiveState: "direct",
      resolvedBackend: "host",
      policyDigest: policy.policyDigest,
      probe: { state: "not-required", candidate: null },
      coverage: [],
      filesystem: "host filesystem visible to the approved command",
      network: "host network",
      identity: "host user",
      resources: "wall/output limits only; no OS isolation",
    };
  }
  if (policy.mode === "report") {
    return {
      schemaVersion: 1,
      boundaryId,
      requestedMode: policy.mode,
      requestedBackend: policy.backend,
      effectiveState: "report-only",
      resolvedBackend: "host",
      policyDigest: policy.policyDigest,
      probe: { state: "not-run", candidate },
      coverage: [],
      filesystem: "host filesystem visible to the approved command",
      network: "host network",
      identity: "host user",
      resources: "wall/output limits only; candidate probe does not isolate execution",
    };
  }
  return {
    schemaVersion: 1,
    boundaryId,
    requestedMode: policy.mode,
    requestedBackend: policy.backend,
    effectiveState: "failed",
    resolvedBackend: null,
    policyDigest: policy.policyDigest,
    probe: { state: "not-run", candidate },
    coverage: [],
    filesystem: "unavailable until an isolation backend passes its functional probe",
    network: "unavailable",
    identity: "unavailable",
    resources: "unavailable",
  };
}

/** 供 API/UI 在尚未创建 run 时展示配置真相；非法配置也返回 failed 而不编造。 */
export function configuredExecutionStatus(
  env: NodeJS.ProcessEnv = process.env,
  boundaryId = "process",
): ExecutionBoundaryStatus {
  try {
    return initialStatus(parseExecutionPolicy(env), boundaryId);
  } catch (err) {
    return {
      schemaVersion: 1,
      boundaryId,
      requestedMode: "required",
      requestedBackend: "auto",
      effectiveState: "failed",
      resolvedBackend: null,
      policyDigest: digest({
        mode: env["AGENT_EXECUTION_ISOLATION"] ?? null,
        backend: env["AGENT_EXECUTION_BACKEND"] ?? null,
        image: env["AGENT_EXECUTION_OCI_IMAGE"] ?? null,
        runtime: env["AGENT_EXECUTION_OCI_RUNTIME"] ?? null,
        runtimeSha256: env["AGENT_EXECUTION_OCI_RUNTIME_SHA256"] ?? null,
        host: env["AGENT_EXECUTION_OCI_HOST"] ?? null,
        namespace: env["AGENT_EXECUTION_OCI_NAMESPACE"] ?? null,
        leaseGraceMs: env["AGENT_EXECUTION_OCI_LEASE_GRACE_MS"] ?? null,
        reaperTimeoutMs: env["AGENT_EXECUTION_OCI_REAPER_TIMEOUT_MS"] ?? null,
        invalid: true,
      }),
      probe: { state: "unavailable", candidate: null, reason: errorMessage(err) },
      coverage: [],
      filesystem: "configuration invalid; execution disabled",
      network: "configuration invalid; execution disabled",
      identity: "configuration invalid; execution disabled",
      resources: "configuration invalid; execution disabled",
    };
  }
}

interface CapturedProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  outputLimitExceeded: boolean;
  error?: string;
}

function capture(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxBufferBytes: number;
    signal?: AbortSignal;
    /** OCI scripts travel over stdin so secrets/literals do not appear in host argv/Config.Cmd. */
    stdin?: string;
    windowsHide?: boolean;
    shell?: boolean | string;
    detached?: boolean;
    killTree?: boolean;
  },
): Promise<CapturedProcessResult> {
  if (options.signal?.aborted) {
    return Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: true,
      outputLimitExceeded: false,
      error: "Execution aborted before process start",
    });
  }

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {}),
        windowsHide: options.windowsHide ?? true,
        ...(options.shell !== undefined ? { shell: options.shell } : {}),
        ...(options.detached !== undefined ? { detached: options.detached } : {}),
        stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: false,
        outputLimitExceeded: false,
        error: errorMessage(err),
      });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let aborted = false;
    let outputLimitExceeded = false;
    let spawnError: string | undefined;
    let settled = false;

    const terminate = (): void => {
      if (child.exitCode === null && child.signalCode === null) {
        if (options.killTree) {
          void killDirectProcessTree(child);
        } else {
          try { child.kill("SIGKILL"); } catch { /* cleanup is verified by the caller */ }
        }
      }
    };
    const append = (bucket: Buffer[], chunk: Buffer, stream: "stdout" | "stderr"): void => {
      const used = stream === "stdout" ? stdoutBytes : stderrBytes;
      const room = Math.max(0, options.maxBufferBytes - used);
      if (room > 0) bucket.push(chunk.subarray(0, room));
      if (stream === "stdout") stdoutBytes += Math.min(chunk.length, room);
      else stderrBytes += Math.min(chunk.length, room);
      if (chunk.length > room && !outputLimitExceeded) {
        outputLimitExceeded = true;
        terminate();
      }
    };
    child.stdout?.on("data", (value: Buffer | string) =>
      append(stdout, Buffer.isBuffer(value) ? value : Buffer.from(value), "stdout"));
    child.stderr?.on("data", (value: Buffer | string) =>
      append(stderr, Buffer.isBuffer(value) ? value : Buffer.from(value), "stderr"));

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timer.unref?.();
    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.once("error", (err) => { spawnError = errorMessage(err); });
    if (options.stdin !== undefined) {
      child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
        // 容器提前退出时 EPIPE 由它的 exit/stderr 表达；其它写入故障需保留。
        if (err.code !== "EPIPE") spawnError = errorMessage(err);
      });
      child.stdin?.end(options.stdin);
    }
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code,
        signal,
        timedOut,
        aborted,
        outputLimitExceeded,
        ...(spawnError ? { error: spawnError } : {}),
      });
    });
  });
}

async function killDirectProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    await capture("taskkill", ["/pid", String(pid), "/t", "/f"], {
      timeoutMs: 5_000,
      maxBufferBytes: 64 * 1024,
      windowsHide: true,
    });
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch {
    try { child.kill("SIGKILL"); } catch { /* best effort in explicitly unisolated mode */ }
  }
}

/** legacy/off/report 的宿主执行器。它改善整树回收，但明确不提供隔离。 */
export function runDirectShell(
  request: ShellExecutionRequest,
  status: ExecutionBoundaryStatus,
): Promise<ShellExecutionResult> {
  if (request.signal.aborted) {
    return Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: true,
      outputLimitExceeded: false,
      cleanup: "not-needed",
      status: copyStatus(status),
      error: "Execution aborted before process start",
    });
  }

  return capture(request.command, [], {
    cwd: request.cwd,
    env: sanitizeChildEnv(request.env),
    timeoutMs: request.timeoutMs,
    maxBufferBytes: request.maxBufferBytes,
    signal: request.signal,
    windowsHide: request.windowsHide,
    shell: request.shell ?? true,
    detached: true,
    killTree: true,
  }).then((result) => ({
    ...result,
    cleanup:
      result.timedOut || result.aborted || result.outputLimitExceeded
        ? "best-effort"
        : "not-needed",
    status: copyStatus(status),
  }));
}

export function executionBoundaryLabel(boundaryId: string): string {
  return digest(boundaryId).slice(0, 24);
}

export type OciWorkerKind = "worker" | "functional-probe" | "workdir-probe";

export interface OciOwnerIdentity {
  boot: string;
  pidNamespace: string;
  pid: number;
  startTicks: string;
}

function parseLinuxProcStat(value: string, expectedPid: number): { state: string; startTicks: string } {
  const close = value.lastIndexOf(") ");
  const open = value.indexOf(" (");
  if (open <= 0 || close <= open) throw new Error("Linux process stat has an invalid comm field");
  const rawPid = value.slice(0, open);
  if (!/^[1-9][0-9]*$/.test(rawPid) || Number(rawPid) !== expectedPid) {
    throw new Error("Linux process stat PID does not match");
  }
  // Tokens after `) ` start at field 3 (state); starttime is field 22 => index 19.
  const fields = value.slice(close + 2).trim().split(/\s+/);
  const state = fields[0];
  const startTicks = fields[19];
  if (!state || !/^[A-Za-z]$/.test(state) || !startTicks || !/^[1-9][0-9]*$/.test(startTicks)) {
    throw new Error("Linux process stat is missing state/starttime");
  }
  return { state, startTicks };
}

export async function readOciOwnerIdentity(pid = process.pid): Promise<OciOwnerIdentity> {
  if (process.platform !== "linux") throw new Error("OCI owner identity is available on Linux only");
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("OCI owner PID is invalid");
  const [rawBoot, rawPidNamespace, rawStat] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readlink(`/proc/${pid}/ns/pid`),
    readFile(`/proc/${pid}/stat`, "utf8"),
  ]);
  const bootId = rawBoot.trim().toLowerCase();
  if (!UUID.test(bootId)) throw new Error("Linux boot_id is not a UUID");
  const pidNamespace = rawPidNamespace.trim();
  if (!/^pid:\[[1-9][0-9]*\]$/.test(pidNamespace)) {
    throw new Error("Linux PID namespace identity is invalid");
  }
  const parsed = parseLinuxProcStat(rawStat, pid);
  return {
    boot: createHash("sha256").update("agent-harness/boot/v1\0").update(bootId).digest("hex"),
    pidNamespace: createHash("sha256")
      .update("agent-harness/pid-namespace/v1\0")
      .update(pidNamespace)
      .digest("hex"),
    pid,
    startTicks: parsed.startTicks,
  };
}

export interface OciLeaseSpec {
  namespace: string;
  ownerId: string;
  ownerBoot: string;
  ownerPidNamespace: string;
  ownerPid: number;
  ownerStartTicks: string;
  leaseId: string;
  kind: OciWorkerKind;
  policyDigest: string;
  leaseMs: number;
}

function containerNameFromLabels(boundary: string, leaseId: string): string {
  return `agent-harness-${boundary}-${leaseId}`;
}

function containerName(boundaryId: string, leaseId: string): string {
  return containerNameFromLabels(executionBoundaryLabel(boundaryId), leaseId);
}

export interface OciRunSpec {
  image: string;
  name: string;
  boundaryId: string;
  workdir: string;
  command: string;
  lease: OciLeaseSpec;
  /** 仅管理员固定脚本可走 inline；agent 命令必须经 stdin bootstrap，避免 argv 泄露。 */
  delivery?: "stdin" | "inline";
}

const OCI_LABEL_KEYS = Object.freeze({
  managed: "agent-harness.managed",
  schema: "agent-harness.schema",
  namespace: "agent-harness.namespace",
  owner: "agent-harness.owner",
  ownerBoot: "agent-harness.owner-boot",
  ownerPidNamespace: "agent-harness.owner-pidns",
  ownerPid: "agent-harness.owner-pid",
  ownerStart: "agent-harness.owner-start",
  lease: "agent-harness.lease",
  kind: "agent-harness.kind",
  boundary: "agent-harness.boundary",
  policy: "agent-harness.policy",
  leaseMs: "agent-harness.lease-ms",
});

function assertOciLeaseSpec(lease: OciLeaseSpec): void {
  if (!SHA256.test(lease.namespace)) throw new Error("OCI lease namespace label is invalid");
  if (!UUID.test(lease.ownerId)) throw new Error("OCI lease owner UUID is invalid");
  if (!SHA256.test(lease.ownerBoot)) throw new Error("OCI lease owner boot label is invalid");
  if (!SHA256.test(lease.ownerPidNamespace)) throw new Error("OCI lease owner PID namespace label is invalid");
  if (!Number.isSafeInteger(lease.ownerPid) || lease.ownerPid <= 0) {
    throw new Error("OCI lease owner PID is invalid");
  }
  if (!/^[1-9][0-9]*$/.test(lease.ownerStartTicks)) {
    throw new Error("OCI lease owner starttime is invalid");
  }
  if (!UUID.test(lease.leaseId)) throw new Error("OCI lease UUID is invalid");
  if (!["worker", "functional-probe", "workdir-probe"].includes(lease.kind)) {
    throw new Error("OCI lease kind is invalid");
  }
  if (!SHA256.test(lease.policyDigest)) throw new Error("OCI lease policy digest is invalid");
  if (
    !Number.isSafeInteger(lease.leaseMs)
    || lease.leaseMs < OCI_MIN_LEASE_MS
    || lease.leaseMs > OCI_MAX_LEASE_MS
  ) {
    throw new Error(`OCI lease duration must be between ${OCI_MIN_LEASE_MS} and ${OCI_MAX_LEASE_MS} ms`);
  }
}

function ociLeaseLabels(boundaryId: string, lease: OciLeaseSpec): Record<string, string> {
  assertOciLeaseSpec(lease);
  return {
    [OCI_LABEL_KEYS.managed]: "true",
    [OCI_LABEL_KEYS.schema]: OCI_LEASE_SCHEMA,
    [OCI_LABEL_KEYS.namespace]: lease.namespace,
    [OCI_LABEL_KEYS.owner]: lease.ownerId,
    [OCI_LABEL_KEYS.ownerBoot]: lease.ownerBoot,
    [OCI_LABEL_KEYS.ownerPidNamespace]: lease.ownerPidNamespace,
    [OCI_LABEL_KEYS.ownerPid]: String(lease.ownerPid),
    [OCI_LABEL_KEYS.ownerStart]: lease.ownerStartTicks,
    [OCI_LABEL_KEYS.lease]: lease.leaseId,
    [OCI_LABEL_KEYS.kind]: lease.kind,
    [OCI_LABEL_KEYS.boundary]: executionBoundaryLabel(boundaryId),
    [OCI_LABEL_KEYS.policy]: lease.policyDigest.toLowerCase(),
    [OCI_LABEL_KEYS.leaseMs]: String(lease.leaseMs),
  };
}

interface OciLeaseTarget {
  name: string;
  leaseId: string;
  namespace: string;
  labels: Record<string, string>;
  runtime: TrustedDockerRuntime;
}

function leaseDurationMs(timeoutMs: number, graceMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("OCI worker timeout must be a positive safe integer");
  }
  const leaseMs = timeoutMs + graceMs;
  if (!Number.isSafeInteger(leaseMs) || leaseMs > OCI_MAX_LEASE_MS) {
    throw new Error(`OCI worker timeout plus cleanup grace exceeds ${OCI_MAX_LEASE_MS} ms`);
  }
  return Math.max(OCI_MIN_LEASE_MS, leaseMs);
}

function createOciLeaseTarget(
  policy: ExecutionPolicyConfig,
  runtime: TrustedDockerRuntime,
  boundaryId: string,
  kind: OciWorkerKind,
  timeoutMs: number,
): OciLeaseTarget & { lease: OciLeaseSpec } {
  if (!policy.ociNamespace) {
    throw new Error("AGENT_EXECUTION_OCI_NAMESPACE is required for durable OCI worker ownership");
  }
  const leaseId = randomUUID();
  const lease: OciLeaseSpec = {
    namespace: executionNamespaceLabel(policy.ociNamespace),
    ownerId: OCI_OWNER_ID,
    ownerBoot: runtime.owner.boot,
    ownerPidNamespace: runtime.owner.pidNamespace,
    ownerPid: runtime.owner.pid,
    ownerStartTicks: runtime.owner.startTicks,
    leaseId,
    kind,
    policyDigest: policy.policyDigest,
    leaseMs: leaseDurationMs(timeoutMs, policy.ociLeaseGraceMs),
  };
  const name = containerName(boundaryId, leaseId);
  return {
    name,
    leaseId,
    namespace: lease.namespace,
    labels: ociLeaseLabels(boundaryId, lease),
    runtime,
    lease,
  };
}

/**
 * 固定 bootstrap 先完整排空 Docker stdin，再执行落在私有 tmpfs 上的脚本。
 *
 * 不能直接用 `/bin/sh -s`：shell 与脚本内的 `cat`/`read`/交互式程序会共享
 * 同一个 fd0，后者可以吞掉尚未被 shell 解析的后续命令并以 0 静默结束。这里
 * 先把 stdin 全量落盘，再让用户脚本拿到 EOF；命令正文仍不会进入 host argv 或
 * Docker Config.Cmd。
 */
export const OCI_STDIN_BOOTSTRAP = [
  "set -eu",
  "umask 077",
  'script=/tmp/agent-harness-command.sh',
  'cat > "$script"',
  'exec /bin/sh "$script" </dev/null',
].join("; ");

/** 参数数组是安全契约：agent command 不进入 argv/Config.Cmd，只能经 stdin 输入。 */
export function buildOciRunArgs(spec: OciRunSpec): string[] {
  const workdir = path.resolve(spec.workdir);
  if (/[\r\n,]/.test(workdir)) {
    throw new Error("OCI workdir cannot contain comma or newline characters");
  }
  const labels = ociLeaseLabels(spec.boundaryId, spec.lease);
  if (spec.name !== containerName(spec.boundaryId, spec.lease.leaseId)) {
    throw new Error("OCI container name must bind the boundary and full lease UUID");
  }
  const labelArgs = Object.entries(labels).flatMap(([name, value]) => ["--label", `${name}=${value}`]);
  const base = [
    "run",
    "--rm",
    "--pull", "never",
    "--name", spec.name,
    ...labelArgs,
    "--init",
    "--no-healthcheck",
    "--network", "none",
    "--ipc", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--security-opt", "seccomp=builtin",
    "--pids-limit", String(OCI_PROFILE.pids),
    "--memory", OCI_PROFILE.memory,
    "--memory-swap", OCI_PROFILE.memory,
    "--cpus", OCI_PROFILE.cpus,
    "--ulimit", `nofile=${OCI_PROFILE.nofile}`,
    "--tmpfs", OCI_PROFILE.tmpfs,
    "--mount", `type=bind,source=${workdir},target=${OCI_PROFILE.workspace},bind-recursive=disabled`,
    "--workdir", OCI_PROFILE.workspace,
    "--user", OCI_PROFILE.user,
  ];
  if (spec.delivery === "inline") {
    if (/[\0\r]/.test(spec.command)) {
      throw new Error("Inline OCI command cannot contain NUL or carriage return characters");
    }
    return [
      ...base,
      "--entrypoint", "/bin/sh",
      spec.image,
      "-c", spec.command,
    ];
  }
  return [
    ...base,
    "--interactive",
    // `env -i` removes every image ENV value as well as all host values; setting
    // `--env NAME=` would leave secret-shaped names present with empty values.
    "--entrypoint", "/usr/bin/env",
    spec.image,
    "-i",
    "HOME=/tmp",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "/bin/sh",
    "-c",
    OCI_STDIN_BOOTSTRAP,
  ];
}

const PROBE_COMMAND = [
  "set -eu",
  'test "$(id -u)" = "65532"',
  'test "$(id -g)" = "65532"',
  'test "$(id -G)" = "65532"',
  // `test ! -w /` 对 non-root 即使 rootfs 可写也可能通过；直接核对根挂载的 ro 标志。
  "awk '$2 == \"/\" && $4 ~ /(^|,)ro(,|$)/ { found=1 } END { exit !found }' /proc/mounts",
  "test -w /workspace",
  "test -w /tmp",
  "test ! -e /var/run/docker.sock",
  'test -z "${NODE_ENV+x}"',
  "grep -q '^NoNewPrivs:[[:space:]]*1$' /proc/self/status",
  "grep -q '^CapEff:[[:space:]]*0000000000000000$' /proc/self/status",
  "grep -q '^Seccomp:[[:space:]]*2$' /proc/self/status",
  'test "$(ulimit -n)" = "1024"',
  // required 只接受 cgroup v2 的可读回执；没有可验证回执就不是该 profile。
  'test "$(cat /sys/fs/cgroup/pids.max)" = "128"',
  'test "$(cat /sys/fs/cgroup/memory.max)" = "1073741824"',
  'test "$(cat /sys/fs/cgroup/memory.swap.max)" = "0"',
  'test "$(cat /sys/fs/cgroup/cpu.max)" = "100000 100000"',
  'test "$(cat /workspace/probe.txt)" = "probe"',
  "printf passed > /workspace/probe.out",
  "! grep -qE '^[^[:space:]]+[[:space:]]+00000000[[:space:]]' /proc/net/route",
].join(" && ");

interface TrustedDockerRuntime {
  file: string;
  host: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  socketPath: string;
  owner: OciOwnerIdentity;
}

async function fileSha256(file: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", rejectHash);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function assertRootOwnedPath(pathname: string, kind: "runtime" | "socket"): Promise<void> {
  let cursor = path.resolve(pathname);
  while (true) {
    const info = await stat(cursor);
    if (info.uid !== 0) {
      throw new Error(`OCI ${kind} trust path is not root-owned: ${cursor}`);
    }
    if ((info.mode & 0o022) !== 0) {
      throw new Error(`OCI ${kind} trust path is group/world writable: ${cursor}`);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

/**
 * required 的信任根不能来自 PATH、工作区或 Docker context 环境变量。
 * 目前内嵌 adapter 只在 Linux + root 管理的 CLI/本机 socket 上成立；其它平台
 * 需要独立 Broker 服务完成 ACL/签名校验后再开放，不能拿文件 hash 猜权限。
 */
async function trustedDockerRuntime(policy: ExecutionPolicyConfig): Promise<TrustedDockerRuntime> {
  if (!policy.ociRuntime || !policy.ociRuntimeSha256) {
    throw new Error(
      "AGENT_EXECUTION_OCI_RUNTIME and AGENT_EXECUTION_OCI_RUNTIME_SHA256 are required for a trusted OCI backend",
    );
  }
  if (process.platform !== "linux") {
    throw new Error(
      "Embedded OCI required mode currently supports Linux only; other platforms require the broker service",
    );
  }
  const configuredRuntime = path.resolve(policy.ociRuntime);
  await assertRootOwnedPath(path.dirname(configuredRuntime), "runtime");
  const resolvedRuntime = await realpath(configuredRuntime);
  const runtimeInfo = await stat(resolvedRuntime);
  if (!runtimeInfo.isFile()) throw new Error("Configured OCI runtime is not a regular file");
  if (runtimeInfo.uid !== 0 || (runtimeInfo.mode & 0o022) !== 0) {
    throw new Error("Configured OCI runtime must be root-owned and not group/world writable");
  }
  await assertRootOwnedPath(path.dirname(resolvedRuntime), "runtime");
  const actualHash = await fileSha256(resolvedRuntime);
  if (actualHash !== policy.ociRuntimeSha256) {
    throw new Error("Configured OCI runtime SHA-256 does not match the executable on disk");
  }

  const match = LOCAL_UNIX_SOCKET.exec(policy.ociHost);
  if (!match?.[1] || !path.isAbsolute(match[1])) {
    throw new Error("Configured OCI host is not an absolute local Unix socket");
  }
  // 原始 endpoint 的父链也必须可信，不能让 /tmp 下可换向 symlink 借真 socket 过检。
  await assertRootOwnedPath(path.dirname(match[1]), "socket");
  const socketPath = await realpath(match[1]);
  const socketInfo = await stat(socketPath);
  if (!socketInfo.isSocket()) throw new Error("Configured OCI host is not a Unix socket");
  if (socketInfo.uid !== 0 || (socketInfo.mode & 0o002) !== 0) {
    throw new Error("Configured OCI socket must be root-owned and not world writable");
  }
  await assertRootOwnedPath(path.dirname(socketPath), "socket");
  const owner = await readOciOwnerIdentity();

  return {
    file: resolvedRuntime,
    // 调用只使用验过父链的 canonical socket，不再回到可换向的原始 symlink。
    host: `unix://${socketPath}`,
    cwd: path.parse(resolvedRuntime).root,
    socketPath,
    owner,
    // No provider keys, HOME Docker config, context, proxy, or DOCKER_HOST inheritance.
    env: {
      HOME: "/nonexistent",
      DOCKER_CONFIG: "/nonexistent",
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C",
      LC_ALL: "C",
    },
  };
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\(040|011|012|134)/g, (_all, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)));
}

/**
 * Docker 的 network=none 不会隔离 bind mount 里已有的 Unix socket/FIFO/device。
 * 每次执行前 fail-closed 扫描，并拒绝宿主的嵌套 mount；逐 run worktree lease 完成
 * 前仍保留极窄 TOCTOU，因此整体状态继续只能是 partial。
 */
async function assertSafeWorkspaceForOci(workdir: string): Promise<void> {
  const configuredRoot = path.resolve(workdir);
  const root = await realpath(configuredRoot);
  if (root !== configuredRoot) {
    throw new Error("OCI workdir must not contain symlink path components");
  }
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new Error("OCI workdir must be a directory");
  const permissionBits = rootInfo.uid === 65_532
    ? (rootInfo.mode >> 6) & 0o7
    : rootInfo.gid === 65_532
      ? (rootInfo.mode >> 3) & 0o7
      : rootInfo.mode & 0o7;
  if ((permissionBits & 0o7) !== 0o7) {
    throw new Error("OCI workdir is not readable/writable/searchable by numeric UID/GID 65532");
  }

  const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
  for (const line of mountInfo.split("\n")) {
    const fields = line.split(" ");
    if (fields.length < 5) continue;
    const mountpoint = path.resolve(decodeMountInfoPath(fields[4]!));
    if (mountpoint !== root && mountpoint.startsWith(`${root}${path.sep}`)) {
      throw new Error(`OCI workdir contains a nested host mount: ${mountpoint}`);
    }
  }

  const pending = [root];
  let entries = 0;
  while (pending.length > 0) {
    const dirPath = pending.pop()!;
    const dir = await opendir(dirPath);
    for await (const entry of dir) {
      entries += 1;
      if (entries > 200_000) {
        throw new Error("OCI workdir special-file scan exceeded 200000 entries");
      }
      const entryPath = path.join(dirPath, entry.name);
      const entryInfo = await lstat(entryPath);
      if (entryInfo.isSymbolicLink()) continue;
      if (entryInfo.isDirectory()) pending.push(entryPath);
      else if (entryInfo.isFile() && entryInfo.nlink > 1) {
        // bind root 内的 hardlink 仍指向同一个宿主 inode；若另一链接在圈外，
        // 容器可绕过路径边界读写它。required 在没有 inode lease 前一律拒绝。
        throw new Error(`OCI workdir contains a forbidden hard-linked file: ${entryPath}`);
      }
      else if (
        entryInfo.isSocket()
        || entryInfo.isFIFO()
        || entryInfo.isBlockDevice()
        || entryInfo.isCharacterDevice()
      ) {
        throw new Error(`OCI workdir contains a forbidden host IPC/device entry: ${entryPath}`);
      }
    }
  }
}

function dockerCapture(
  runtime: TrustedDockerRuntime,
  args: string[],
  options: Omit<Parameters<typeof capture>[2], "cwd" | "env">,
): Promise<CapturedProcessResult> {
  return capture(runtime.file, ["--host", runtime.host, ...args], {
    ...options,
    cwd: runtime.cwd,
    env: runtime.env,
  });
}

async function dockerProbe(
  policy: ExecutionPolicyConfig,
  active?: Map<string, OciLeaseTarget>,
  isDisposed?: () => boolean,
): Promise<OciProbeResult> {
  if (!policy.ociImage) return { ready: false, reason: "AGENT_EXECUTION_OCI_IMAGE is not configured" };
  let runtime: TrustedDockerRuntime;
  try {
    runtime = await trustedDockerRuntime(policy);
  } catch (err) {
    return { ready: false, reason: `OCI runtime trust check failed: ${errorMessage(err)}` };
  }
  const pinnedImage = policy.ociImage;
  return (async (): Promise<OciProbeResult> => {
    const version = await dockerCapture(runtime, ["version", "--format", "{{.Server.Version}}"], {
      timeoutMs: 5_000,
      maxBufferBytes: 64 * 1024,
      windowsHide: true,
    });
    if (version.exitCode !== 0 || version.error || !version.stdout.trim()) {
      return {
        ready: false,
        reason: `OCI runtime unavailable: ${version.error ?? (version.stderr.trim() || "docker daemon did not answer")}`,
      };
    }
    const runtimeVersion = version.stdout.trim().slice(0, 200);
    const image = await dockerCapture(
      runtime,
      ["image", "inspect", "--format", "{{.Id}}", pinnedImage],
      { timeoutMs: 5_000, maxBufferBytes: 64 * 1024, windowsHide: true },
    );
    if (image.exitCode !== 0 || !/^sha256:[0-9a-f]{64}$/i.test(image.stdout.trim())) {
      return {
        ready: false,
        runtimeVersion,
        reason: "Pinned OCI image is not present locally; automatic pull is forbidden",
      };
    }
    const configInspect = await dockerCapture(
      runtime,
      ["image", "inspect", "--format", "{{json .Config}}", pinnedImage],
      { timeoutMs: 5_000, maxBufferBytes: 256 * 1024, windowsHide: true },
    );
    let imageConfig: { Env?: unknown; Volumes?: unknown };
    try {
      imageConfig = JSON.parse(configInspect.stdout);
    } catch {
      return {
        ready: false,
        runtimeVersion,
        reason: "Pinned OCI image config could not be inspected as JSON",
      };
    }
    if (
      imageConfig.Volumes
      && typeof imageConfig.Volumes === "object"
      && Object.keys(imageConfig.Volumes).length > 0
    ) {
      return {
        ready: false,
        runtimeVersion,
        reason: "Pinned OCI image declares VOLUME entries that would create untracked writable mounts",
      };
    }

    const probeRoot = await mkdtemp(path.join(tmpdir(), "agent-harness-oci-probe-"));
    const workspace = path.join(probeRoot, "workspace");
    try {
      await mkdir(workspace);
      // 固定容器 UID 必须能验证 RW mount；临时 canary 目录不承载用户数据。
      await chmod(workspace, 0o777);
      await writeFile(path.join(workspace, "probe.txt"), "probe", "utf8");
      await chmod(path.join(workspace, "probe.txt"), 0o644);
      const target = createOciLeaseTarget(
        policy,
        runtime,
        "functional-probe",
        "functional-probe",
        15_000,
      );
      const { name } = target;
      if (isDisposed?.()) return { ready: false, runtimeVersion, reason: "Execution broker is disposed" };
      active?.set(name, target);
      if (isDisposed?.()) {
        active?.delete(name);
        return { ready: false, runtimeVersion, reason: "Execution broker is disposed" };
      }
      const result = await dockerCapture(
        runtime,
        buildOciRunArgs({
          image: pinnedImage,
          name,
          boundaryId: "functional-probe",
          workdir: workspace,
          command: PROBE_COMMAND,
          lease: target.lease,
          delivery: "inline",
        }),
        {
          timeoutMs: 15_000,
          maxBufferBytes: 256 * 1024,
          windowsHide: true,
        },
      );
      const marker = (await readFile(path.join(workspace, "probe.out"), "utf8").catch(() => "")).trim();
      if (result.exitCode !== 0 || marker !== "passed") {
        const cleanup = await forceRemoveContainer(target);
        if (cleanup === "confirmed") active?.delete(name);
        const detail = [
          result.error,
          result.stderr.trim(),
          result.stdout.trim(),
          `exit=${result.exitCode}`,
          marker ? `marker=${JSON.stringify(marker)}` : "marker missing",
        ].filter(Boolean).join("; ") || "probe failed";
        return {
          ready: false,
          runtimeVersion,
          cleanupFailed: cleanup === "failed",
          reason: `OCI functional probe failed: ${detail}`
            + (cleanup === "failed" ? "; probe worker cleanup could not be confirmed" : ""),
        };
      }
      const cleanup = await forceRemoveContainer(target);
      if (cleanup === "failed") {
        return {
          ready: false,
          runtimeVersion,
          cleanupFailed: true,
          reason: "OCI functional probe passed but worker cleanup could not be confirmed",
        };
      }
      active?.delete(name);
      return { ready: true, runtimeVersion };
    } finally {
      const resolvedRoot = path.resolve(probeRoot);
      const resolvedTemp = path.resolve(tmpdir());
      if (resolvedRoot.startsWith(`${resolvedTemp}${path.sep}`) && path.basename(resolvedRoot).startsWith("agent-harness-oci-probe-")) {
        await rm(resolvedRoot, { recursive: true, force: true });
      }
    }
  })();
}

export interface OciManagedContainerRecord {
  id: string;
  name: string;
  labels: Record<string, string>;
  namespace: string;
  leaseId: string;
  ownerId: string;
  ownerBoot: string;
  ownerPidNamespace: string;
  ownerPid: number;
  ownerStartTicks: string;
  kind: OciWorkerKind;
  boundary: string;
  policyDigest: string;
  leaseMs: number;
  createdMs: number;
  expiresAtMs: number;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function dockerTimestampMs(value: string, label: string): number {
  // Docker uses RFC3339Nano while Date.parse only guarantees millisecond precision.
  const normalized = value.replace(/\.(\d{3})\d*(?=(?:Z|[+-]\d{2}:\d{2})$)/, ".$1");
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a valid Docker timestamp`);
  return parsed;
}

/** Pure parser used by the reaper and negative tests; malformed ownership is never auto-deleted. */
export function parseOciManagedContainer(
  inspect: unknown,
  expectedNamespace: string,
): OciManagedContainerRecord {
  if (!SHA256.test(expectedNamespace)) throw new Error("expected OCI namespace is invalid");
  const root = objectValue(inspect, "Docker inspect payload");
  const config = objectValue(root["Config"], "Docker inspect Config");
  const hostConfig = objectValue(root["HostConfig"], "Docker inspect HostConfig");
  const restart = objectValue(hostConfig["RestartPolicy"], "Docker inspect RestartPolicy");
  const rawLabels = objectValue(config["Labels"], "Docker inspect labels");
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawLabels)) {
    if (typeof value !== "string") throw new Error(`Docker inspect label ${key} is not a string`);
    labels[key] = value;
  }
  const required = (key: string): string => {
    const value = labels[key];
    if (value === undefined) throw new Error(`managed OCI container is missing label ${key}`);
    return value;
  };
  if (required(OCI_LABEL_KEYS.managed) !== "true") throw new Error("managed OCI label is invalid");
  if (required(OCI_LABEL_KEYS.schema) !== OCI_LEASE_SCHEMA) {
    throw new Error("managed OCI container has an unknown lease schema");
  }
  const namespace = required(OCI_LABEL_KEYS.namespace);
  if (namespace !== expectedNamespace) throw new Error("managed OCI namespace does not match the reaper");
  const ownerId = required(OCI_LABEL_KEYS.owner);
  const leaseId = required(OCI_LABEL_KEYS.lease);
  if (!UUID.test(ownerId)) throw new Error("managed OCI owner label is not a UUID");
  if (!UUID.test(leaseId)) throw new Error("managed OCI lease label is not a UUID");
  const ownerBoot = required(OCI_LABEL_KEYS.ownerBoot);
  if (!SHA256.test(ownerBoot)) throw new Error("managed OCI owner boot label is invalid");
  const ownerPidNamespace = required(OCI_LABEL_KEYS.ownerPidNamespace);
  if (!SHA256.test(ownerPidNamespace)) {
    throw new Error("managed OCI owner PID namespace label is invalid");
  }
  const rawOwnerPid = required(OCI_LABEL_KEYS.ownerPid);
  if (!/^[1-9][0-9]*$/.test(rawOwnerPid)) throw new Error("managed OCI owner PID label is invalid");
  const ownerPid = Number(rawOwnerPid);
  if (!Number.isSafeInteger(ownerPid)) throw new Error("managed OCI owner PID is outside safe integer range");
  const ownerStartTicks = required(OCI_LABEL_KEYS.ownerStart);
  if (!/^[1-9][0-9]*$/.test(ownerStartTicks)) {
    throw new Error("managed OCI owner starttime label is invalid");
  }
  const kind = required(OCI_LABEL_KEYS.kind);
  if (!["worker", "functional-probe", "workdir-probe"].includes(kind)) {
    throw new Error("managed OCI kind label is invalid");
  }
  const boundary = required(OCI_LABEL_KEYS.boundary);
  if (!HEX_24.test(boundary)) throw new Error("managed OCI boundary label is invalid");
  const policyDigest = required(OCI_LABEL_KEYS.policy);
  if (!SHA256.test(policyDigest)) throw new Error("managed OCI policy label is invalid");
  const rawLeaseMs = required(OCI_LABEL_KEYS.leaseMs);
  if (!/^[1-9][0-9]*$/.test(rawLeaseMs)) throw new Error("managed OCI lease duration is invalid");
  const leaseMs = Number(rawLeaseMs);
  if (
    !Number.isSafeInteger(leaseMs)
    || leaseMs < OCI_MIN_LEASE_MS
    || leaseMs > OCI_MAX_LEASE_MS
  ) throw new Error("managed OCI lease duration is outside the protocol bounds");

  const id = root["Id"];
  const rawName = root["Name"];
  const created = root["Created"];
  if (typeof id !== "string" || !SHA256.test(id)) throw new Error("managed OCI container ID is invalid");
  if (typeof rawName !== "string") throw new Error("managed OCI container name is invalid");
  if (typeof created !== "string") throw new Error("managed OCI Created timestamp is invalid");
  const name = rawName.startsWith("/") ? rawName.slice(1) : rawName;
  if (name !== containerNameFromLabels(boundary, leaseId)) {
    throw new Error("managed OCI container name does not bind its boundary and lease");
  }
  if (hostConfig["AutoRemove"] !== true) throw new Error("managed OCI container is not AutoRemove");
  const restartName = restart["Name"];
  if (restartName !== "" && restartName !== "no") {
    throw new Error("managed OCI container has a restart policy");
  }
  const createdMs = dockerTimestampMs(created, "managed OCI Created");
  const expiresAtMs = createdMs + leaseMs;
  if (!Number.isSafeInteger(expiresAtMs)) throw new Error("managed OCI expiry is outside safe integer range");
  return {
    id: id.toLowerCase(),
    name,
    labels,
    namespace,
    leaseId,
    ownerId,
    ownerBoot: ownerBoot.toLowerCase(),
    ownerPidNamespace: ownerPidNamespace.toLowerCase(),
    ownerPid,
    ownerStartTicks,
    kind: kind as OciWorkerKind,
    boundary,
    policyDigest: policyDigest.toLowerCase(),
    leaseMs,
    createdMs,
    expiresAtMs,
  };
}

interface DockerInspectLookup {
  state: "present" | "absent" | "failed";
  payload?: unknown;
  reason?: string;
}

function deadlineTimeout(deadlineMs: number): number | null {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) return null;
  return Math.max(1, Math.min(5_000, remaining));
}

async function inspectContainer(
  runtime: TrustedDockerRuntime,
  selector: string,
  deadlineMs: number,
): Promise<DockerInspectLookup> {
  const timeoutMs = deadlineTimeout(deadlineMs);
  if (timeoutMs === null) return { state: "failed", reason: "OCI cleanup deadline expired" };
  const inspect = await dockerCapture(
    runtime,
    ["container", "inspect", "--format", "{{json .}}", selector],
    { timeoutMs, maxBufferBytes: 512 * 1024, windowsHide: true },
  );
  if (dockerInspectConfirmsAbsent(inspect)) return { state: "absent" };
  if (
    inspect.error
    || inspect.timedOut
    || inspect.aborted
    || inspect.outputLimitExceeded
    || inspect.exitCode !== 0
  ) {
    return {
      state: "failed",
      reason: inspect.error ?? (inspect.stderr.trim() || `Docker inspect exited ${inspect.exitCode}`),
    };
  }
  try {
    return { state: "present", payload: JSON.parse(inspect.stdout) as unknown };
  } catch {
    return { state: "failed", reason: "Docker inspect did not return one JSON object" };
  }
}

function targetMatchesRecord(target: OciLeaseTarget, record: OciManagedContainerRecord): boolean {
  if (
    record.name !== target.name
    || record.namespace !== target.namespace
    || record.leaseId !== target.leaseId
  ) return false;
  return Object.entries(target.labels).every(([key, value]) => record.labels[key] === value);
}

async function forceRemoveContainer(
  target: OciLeaseTarget,
  pinnedId?: string,
  deadlineMs = Date.now() + 15_000,
): Promise<"confirmed" | "failed"> {
  const selector = pinnedId ?? target.name;
  const before = await inspectContainer(target.runtime, selector, deadlineMs);
  if (before.state === "absent") return "confirmed";
  if (before.state !== "present") return "failed";
  let record: OciManagedContainerRecord;
  try {
    record = parseOciManagedContainer(before.payload, target.namespace);
  } catch {
    return "failed";
  }
  if (!targetMatchesRecord(target, record)) return "failed";
  if (pinnedId && record.id !== pinnedId.toLowerCase()) return "failed";

  const timeoutMs = deadlineTimeout(deadlineMs);
  if (timeoutMs === null) return "failed";
  await dockerCapture(target.runtime, ["rm", "--force", record.id], {
    timeoutMs,
    maxBufferBytes: 64 * 1024,
    windowsHide: true,
  });
  const after = await inspectContainer(target.runtime, record.id, deadlineMs);
  return after.state === "absent" ? "confirmed" : "failed";
}

/** 供负向测试锁住“CLI/daemon 出错不能伪装成容器已消失”的判据。 */
export function dockerInspectConfirmsAbsent(inspect: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  outputLimitExceeded: boolean;
  error?: string;
}): boolean {
  if (
    inspect.error
    || inspect.timedOut
    || inspect.aborted
    || inspect.outputLimitExceeded
    || inspect.exitCode === 0
  ) return false;
  // 非零本身不等于“已清理”：daemon 断线、权限错误、CLI 崩溃同样非零。
  // 只有 Docker 明确回执目标不存在时才能写 confirmed。
  const diagnostic = `${inspect.stderr}\n${inspect.stdout}`;
  return /No such (?:container|object)/i.test(diagnostic);
}

interface OciReaperResult {
  ok: boolean;
  reason?: string;
}

export interface OciOwnerLiveness {
  state: "alive" | "dead" | "unknown";
  reason?: string;
}

export interface OciOwnerProbe {
  readProcStat(pid: number): Promise<string>;
  signalZero(pid: number): void;
}

const DEFAULT_OCI_OWNER_PROBE: OciOwnerProbe = {
  readProcStat: (pid) => readFile(`/proc/${pid}/stat`, "utf8"),
  signalZero: (pid) => process.kill(pid, 0),
};

export async function inspectOciOwnerLiveness(
  record: OciManagedContainerRecord,
  current: OciOwnerIdentity,
  probe: OciOwnerProbe = DEFAULT_OCI_OWNER_PROBE,
): Promise<OciOwnerLiveness> {
  if (record.ownerBoot !== current.boot) return { state: "dead" };
  if (record.ownerPidNamespace !== current.pidNamespace) {
    return {
      state: "unknown",
      reason: "owner PID namespace does not match the reaper",
    };
  }
  if (record.ownerPid === current.pid) {
    return record.ownerStartTicks === current.startTicks ? { state: "alive" } : { state: "dead" };
  }
  let rawStat: string;
  try {
    rawStat = await probe.readProcStat(record.ownerPid);
  } catch (err) {
    // hidepid=2/ProtectProc can make a live process look absent in /proc. A
    // same-pidns signal-0 probe is therefore required before declaring death.
    try {
      probe.signalZero(record.ownerPid);
      return { state: "alive" };
    } catch (signalErr) {
      const signalCode = signalErr && typeof signalErr === "object" && "code" in signalErr
        ? String((signalErr as { code?: unknown }).code ?? "")
        : "";
      if (signalCode === "ESRCH") return { state: "dead" };
      return {
        state: "unknown",
        reason: `owner process visibility is inconclusive: ${errorMessage(err)}; signal probe: ${errorMessage(signalErr)}`,
      };
    }
  }
  try {
    const parsed = parseLinuxProcStat(rawStat, record.ownerPid);
    if (parsed.startTicks !== record.ownerStartTicks || ["Z", "X"].includes(parsed.state.toUpperCase())) {
      return { state: "dead" };
    }
    return { state: "alive" };
  } catch (err) {
    return { state: "unknown", reason: `owner process stat is malformed: ${errorMessage(err)}` };
  }
}

function requiredLeaseLabels(record: OciManagedContainerRecord): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const key of Object.values(OCI_LABEL_KEYS)) {
    const value = record.labels[key];
    if (value === undefined) throw new Error(`managed OCI record lost required label ${key}`);
    labels[key] = value;
  }
  return labels;
}

async function reapExpiredOciWorkers(policy: ExecutionPolicyConfig): Promise<OciReaperResult> {
  let runtime: TrustedDockerRuntime;
  try {
    runtime = await trustedDockerRuntime(policy);
  } catch (err) {
    return { ok: false, reason: `OCI runtime trust check failed: ${errorMessage(err)}` };
  }
  if (!policy.ociNamespace) {
    return { ok: false, reason: "AGENT_EXECUTION_OCI_NAMESPACE is required for durable OCI cleanup" };
  }
  const namespace = executionNamespaceLabel(policy.ociNamespace);
  const deadlineMs = Date.now() + policy.ociReaperTimeoutMs;
  const listTimeout = deadlineTimeout(deadlineMs);
  if (listTimeout === null) return { ok: false, reason: "OCI durable reaper deadline expired" };
  const listed = await dockerCapture(runtime, [
    "container", "ls", "--all", "--no-trunc",
    "--filter", `label=${OCI_LABEL_KEYS.namespace}=${namespace}`,
    "--format", "{{.ID}}",
  ], {
    timeoutMs: listTimeout,
    maxBufferBytes: 1024 * 1024,
    windowsHide: true,
  });
  if (
    listed.error
    || listed.timedOut
    || listed.aborted
    || listed.outputLimitExceeded
    || listed.exitCode !== 0
  ) {
    return {
      ok: false,
      reason: listed.error ?? (listed.stderr.trim() || `Docker container list exited ${listed.exitCode}`),
    };
  }
  const ids = listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (ids.length > OCI_MAX_REAPER_TARGETS) {
    return { ok: false, reason: `OCI durable reaper found more than ${OCI_MAX_REAPER_TARGETS} targets` };
  }
  if (new Set(ids).size !== ids.length || ids.some((id) => !SHA256.test(id))) {
    return { ok: false, reason: "Docker container list returned an invalid or duplicate full ID" };
  }

  // Validate the complete namespace before deleting anything. One malformed tombstone
  // is an ownership ambiguity, so required admission fails closed and leaves it intact.
  const records: OciManagedContainerRecord[] = [];
  for (const id of ids) {
    const inspected = await inspectContainer(runtime, id, deadlineMs);
    if (inspected.state === "absent") continue;
    if (inspected.state !== "present") {
      return { ok: false, reason: `Could not inspect managed OCI container ${id.slice(0, 12)}: ${inspected.reason ?? "unknown error"}` };
    }
    try {
      const record = parseOciManagedContainer(inspected.payload, namespace);
      if (record.id !== id.toLowerCase()) {
        return { ok: false, reason: "Docker list/inspect container ID changed during durable sweep" };
      }
      records.push(record);
    } catch (err) {
      return { ok: false, reason: `Managed OCI tombstone is malformed: ${errorMessage(err)}` };
    }
  }
  if (records.length === 0) return { ok: true };

  const infoTimeout = deadlineTimeout(deadlineMs);
  if (infoTimeout === null) return { ok: false, reason: "OCI durable reaper deadline expired" };
  const info = await dockerCapture(runtime, ["info", "--format", "{{json .SystemTime}}"], {
    timeoutMs: infoTimeout,
    maxBufferBytes: 64 * 1024,
    windowsHide: true,
  });
  if (
    info.error
    || info.timedOut
    || info.aborted
    || info.outputLimitExceeded
    || info.exitCode !== 0
  ) {
    return {
      ok: false,
      reason: info.error ?? (info.stderr.trim() || `Docker info exited ${info.exitCode}`),
    };
  }
  let daemonTime: unknown;
  try {
    daemonTime = JSON.parse(info.stdout.trim()) as unknown;
  } catch {
    return { ok: false, reason: "Docker daemon SystemTime was not JSON" };
  }
  if (typeof daemonTime !== "string") return { ok: false, reason: "Docker daemon SystemTime is missing" };
  let daemonNowMs: number;
  try {
    daemonNowMs = dockerTimestampMs(daemonTime, "Docker daemon SystemTime");
  } catch (err) {
    return { ok: false, reason: errorMessage(err) };
  }
  if (records.some((record) => record.createdMs > daemonNowMs + 5_000)) {
    return { ok: false, reason: "Managed OCI container Created time is ahead of the Docker daemon clock" };
  }

  const reapable: OciManagedContainerRecord[] = [];
  for (const record of records.filter((candidate) => daemonNowMs >= candidate.expiresAtMs)) {
    const liveness = await inspectOciOwnerLiveness(record, runtime.owner);
    if (liveness.state === "unknown") {
      return {
        ok: false,
        reason: `Expired OCI worker ${record.id.slice(0, 12)} owner liveness is unknown: ${liveness.reason ?? "unknown error"}`,
      };
    }
    if (liveness.state === "dead") reapable.push(record);
  }

  for (const record of reapable) {
    const target: OciLeaseTarget = {
      name: record.name,
      leaseId: record.leaseId,
      namespace: record.namespace,
      labels: requiredLeaseLabels(record),
      runtime,
    };
    if (await forceRemoveContainer(target, record.id, deadlineMs) !== "confirmed") {
      return {
        ok: false,
        reason: `Expired OCI worker ${record.id.slice(0, 12)} cleanup could not be confirmed`,
      };
    }
  }
  return { ok: true };
}

class DockerExecutionAdapter implements OciExecutionAdapter {
  private readonly active = new Map<string, OciLeaseTarget>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private disposed = false;
  private tainted = false;

  preflightWorkdir(
    policy: ExecutionPolicyConfig,
    workdir: string,
    boundaryId: string,
  ): Promise<void> {
    const task = this.preflightWorkdirTracked(policy, workdir, boundaryId);
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task)).catch(() => {});
    return task;
  }

  private async preflightWorkdirTracked(
    policy: ExecutionPolicyConfig,
    workdir: string,
    boundaryId: string,
  ): Promise<void> {
    if (this.disposed) throw new Error("Execution broker is disposed");
    await assertSafeWorkspaceForOci(workdir);
    if (!policy.ociImage) throw new Error("Pinned OCI image is not configured");
    const runtime = await trustedDockerRuntime(policy);
    const nonce = randomUUID();
    const prefix = `.agent-harness-boundary-${nonce}`;
    const inputName = `${prefix}.in`;
    const outputName = `${prefix}.out`;
    const movedName = `${prefix}.moved`;
    const deleteName = `${prefix}.delete`;
    const inputPath = path.join(workdir, inputName);
    const outputPath = path.join(workdir, outputName);
    const movedPath = path.join(workdir, movedName);
    const deletePath = path.join(workdir, deleteName);
    const target = createOciLeaseTarget(
      policy,
      runtime,
      `${boundaryId}:workdir-preflight`,
      "workdir-probe",
      20_000,
    );
    const { name } = target;
    try {
      await writeFile(inputPath, nonce, { encoding: "utf8", flag: "wx" });
      await writeFile(outputPath, "pending", { encoding: "utf8", flag: "wx" });
      await writeFile(deletePath, "delete-me", { encoding: "utf8", flag: "wx" });
      await chmod(inputPath, 0o644);
      await chmod(outputPath, 0o666);
      await chmod(deletePath, 0o666);
      const command = [
        "set -eu",
        `test "$(cat /workspace/${inputName})" = "${nonce}"`,
        "test -z \"$(find /workspace -xdev \\( -type s -o -type p -o -type b -o -type c \\) -print -quit)\"",
        `printf %s "${nonce}" > /workspace/${outputName}`,
        `mv /workspace/${outputName} /workspace/${movedName}`,
        `rm /workspace/${deleteName}`,
      ].join(" && ");
      if (this.disposed) throw new Error("Execution broker is disposed");
      this.active.set(name, target);
      // active 登记与 spawn 之间没有 await；二次闸门保证 dispose 若在前置 I/O
      // 期间发生，canary 不会在 removeActive 已返回后才被创建。
      if (this.disposed) {
        this.active.delete(name);
        throw new Error("Execution broker is disposed");
      }
      const result = await dockerCapture(runtime, buildOciRunArgs({
        image: policy.ociImage,
        name,
        boundaryId: `${boundaryId}:workdir-preflight`,
        workdir,
        command,
        lease: target.lease,
        delivery: "inline",
      }), {
        timeoutMs: 20_000,
        maxBufferBytes: 256 * 1024,
        windowsHide: true,
      });
      if (result.exitCode !== 0 || result.signal !== null || result.error) {
        const cleanup = await forceRemoveContainer(target);
        if (cleanup === "confirmed") this.active.delete(name);
        else this.tainted = true;
        throw new Error(
          `OCI daemon/workdir canary failed: ${result.error ?? (result.stderr.trim() || `exit ${result.exitCode}`)}`,
        );
      }
      const cleanup = await forceRemoveContainer(target);
      if (cleanup === "failed") {
        this.tainted = true;
        throw new Error("OCI daemon/workdir canary cleanup could not be confirmed");
      }
      this.active.delete(name);
      if (await readFile(movedPath, "utf8").catch(() => "") !== nonce) {
        throw new Error("OCI daemon/workdir canary write-back did not reach the broker namespace");
      }
      if (await stat(deletePath).then(() => true).catch(() => false)) {
        throw new Error("OCI daemon/workdir canary could not delete the prepared file");
      }
    } finally {
      await Promise.all([inputPath, outputPath, movedPath, deletePath].map((file) =>
        rm(file, { force: true }).catch(() => {})));
    }
  }

  probe(policy: ExecutionPolicyConfig): Promise<OciProbeResult> {
    if (this.disposed) return Promise.resolve({ ready: false, reason: "Execution broker is disposed" });
    const task = this.probeTracked(policy);
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task)).catch(() => {});
    return task;
  }

  private async probeTracked(policy: ExecutionPolicyConfig): Promise<OciProbeResult> {
    if (!(await this.reconcileActive())) {
      return { ready: false, reason: "Previous OCI worker cleanup is not confirmed" };
    }
    if (this.disposed) return { ready: false, reason: "Execution broker is disposed" };
    const reaped = await reapExpiredOciWorkers(policy);
    if (!reaped.ok) {
      return { ready: false, reason: `OCI durable reaper failed: ${reaped.reason ?? "unknown error"}` };
    }
    if (this.disposed) return { ready: false, reason: "Execution broker is disposed" };
    const result = await dockerProbe(policy, this.active, () => this.disposed);
    if (result.cleanupFailed) this.tainted = true;
    return result;
  }

  execute(
    policy: ExecutionPolicyConfig,
    request: ShellExecutionRequest,
    boundaryId: string,
    status: ExecutionBoundaryStatus,
  ): Promise<ShellExecutionResult> {
    const task = this.executeTracked(policy, request, boundaryId, status);
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task)).catch(() => {});
    return task;
  }

  private async executeTracked(
    policy: ExecutionPolicyConfig,
    request: ShellExecutionRequest,
    boundaryId: string,
    status: ExecutionBoundaryStatus,
  ): Promise<ShellExecutionResult> {
    if (this.disposed) return failedResult(request, status, "Execution broker is disposed");
    if (!(await this.reconcileActive())) {
      return {
        ...failedResult(request, status, "Previous OCI worker cleanup is not confirmed"),
        cleanup: "failed",
      };
    }
    if (!policy.ociImage) {
      return failedResult(request, status, "Pinned OCI image is not configured");
    }
    let runtime: TrustedDockerRuntime;
    try {
      // Probe cache 不是永久信任票：每次执行前重验 CLI hash、所有权与 socket。
      runtime = await trustedDockerRuntime(policy);
    } catch (err) {
      return failedResult(request, status, `OCI runtime trust check failed: ${errorMessage(err)}`);
    }
    let target: OciLeaseTarget & { lease: OciLeaseSpec };
    let args: string[];
    try {
      target = createOciLeaseTarget(policy, runtime, boundaryId, "worker", request.timeoutMs);
      args = buildOciRunArgs({
        image: policy.ociImage,
        name: target.name,
        boundaryId,
        workdir: request.cwd,
        command: request.command,
        lease: target.lease,
      });
    } catch (err) {
      return failedResult(request, status, errorMessage(err));
    }
    try {
      await assertSafeWorkspaceForOci(request.cwd);
    } catch (err) {
      return failedResult(request, status, `OCI workspace preflight failed: ${errorMessage(err)}`);
    }
    // dispose 与 preflight 可并发：登记/启动前再过一次关闭闸；request abort 同理。
    if (this.disposed || request.signal.aborted) {
      return failedResult(
        request,
        status,
        this.disposed ? "Execution broker is disposed" : "Execution aborted before OCI worker start",
      );
    }
    this.active.set(target.name, target);
    if (this.disposed || request.signal.aborted) {
      this.active.delete(target.name);
      return failedResult(
        request,
        status,
        this.disposed ? "Execution broker is disposed" : "Execution aborted before OCI worker start",
      );
    }
    try {
      // 不传 request.env：worker 只得到固定 HOME/PATH；provider key 不会下沉。
      const result = await dockerCapture(runtime, args, {
        timeoutMs: request.timeoutMs,
        maxBufferBytes: request.maxBufferBytes,
        signal: request.signal,
        windowsHide: request.windowsHide,
        stdin: request.command,
      });
      // `--rm` 是 runtime 请求，不是删除证明。无论命令成功与否都做 daemon
      // readback；只有明确 No such container/object 才释放 active 记录。
      const cleanup = await forceRemoveContainer(target);
      if (cleanup !== "failed") this.active.delete(target.name);
      else this.tainted = true;
      return {
        ...result,
        cleanup,
        status: copyStatus(status),
      };
    } catch (err) {
      const cleanup = await forceRemoveContainer(target);
      if (cleanup !== "failed") this.active.delete(target.name);
      else this.tainted = true;
      return {
        ...failedResult(request, status, errorMessage(err)),
        cleanup,
      };
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.removeActive();
    await Promise.allSettled([...this.inFlight]);
    await this.removeActive();
    if (this.active.size > 0) {
      throw new Error(`Failed to confirm cleanup for ${this.active.size} OCI worker(s)`);
    }
  }

  private async removeActive(): Promise<void> {
    await Promise.all([...this.active.entries()].map(async ([name, target]) => {
      if (await forceRemoveContainer(target) === "confirmed") this.active.delete(name);
    }));
    this.tainted = this.active.size > 0;
  }

  private async reconcileActive(): Promise<boolean> {
    // active 也包含正常并发 worker；只有 cleanup 已失败、broker 被 taint 后才清扫。
    // 否则 plan 的第二条并发 bash 会把第一条合法命令误杀。
    if (this.tainted) await this.removeActive();
    return !this.tainted;
  }
}

function failedResult(
  request: ShellExecutionRequest,
  status: ExecutionBoundaryStatus,
  message: string,
): ShellExecutionResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted: request.signal.aborted,
    outputLimitExceeded: false,
    cleanup: "not-needed",
    status: copyStatus(status),
    error: message,
  };
}

class PolicyExecutionBroker implements ExecutionBroker {
  readonly boundaryId: string;
  private current: ExecutionBoundaryStatus;
  private probePromise?: Promise<ExecutionBoundaryStatus>;
  private lastProbeAt = 0;
  private disposed = false;
  private disposeComplete = false;
  private disposePromise?: Promise<void>;
  private readonly policy: ExecutionPolicyConfig;
  private readonly adapter: OciExecutionAdapter;
  private readonly direct: ExecutionBrokerOptions["directRunner"];

  constructor(private readonly options: ExecutionBrokerOptions) {
    this.boundaryId = options.boundaryId.trim();
    if (!this.boundaryId) throw new Error("Execution boundaryId must not be empty");
    if (path.resolve(options.workdir) !== options.workdir && !path.isAbsolute(options.workdir)) {
      throw new Error("Execution broker workdir must be absolute");
    }
    this.policy = parseExecutionPolicy(options.env ?? process.env);
    this.current = initialStatus(this.policy, this.boundaryId);
    this.adapter = options.ociAdapter ?? new DockerExecutionAdapter();
    this.direct = options.directRunner ?? runDirectShell;
  }

  status(): ExecutionBoundaryStatus {
    return copyStatus(this.current);
  }

  private markFailed(
    candidate: "oci" | "bwrap" | null,
    reason: string,
    runtimeVersion?: string,
  ): ExecutionBoundaryStatus {
    this.current = {
      ...this.current,
      effectiveState: "failed",
      resolvedBackend: null,
      probe: {
        state: "unavailable",
        candidate,
        reason,
        ...(runtimeVersion ? { runtimeVersion } : {}),
      },
      coverage: [],
      filesystem: "unavailable: execution boundary is not ready",
      network: "unavailable",
      identity: "unavailable",
      resources: "unavailable",
    };
    return this.status();
  }

  probe(force = false): Promise<ExecutionBoundaryStatus> {
    if (this.disposed) {
      return Promise.resolve(this.markFailed(
        this.current.probe.candidate,
        "Execution broker is disposed",
      ));
    }
    if (this.probePromise) return this.probePromise;
    const ttl = this.options.probeTtlMs ?? 5_000;
    if (!force && this.lastProbeAt > 0 && Date.now() - this.lastProbeAt < ttl) {
      return Promise.resolve(this.status());
    }
    const pending = this.probeOnce().then((status) => {
      this.lastProbeAt = Date.now();
      return status;
    }).finally(() => {
      if (this.probePromise === pending) this.probePromise = undefined;
    });
    this.probePromise = pending;
    return pending;
  }

  private async probeOnce(): Promise<ExecutionBoundaryStatus> {
    if (this.policy.mode === "off") return this.status();
    const candidate = candidateFor(this.policy);
    let result: OciProbeResult;
    if (candidate === "bwrap") {
      result = { ready: false, reason: "bwrap backend is not implemented in this release" };
    } else if (candidate === "oci") {
      try {
        result = await this.adapter.probe(this.policy);
        if (this.disposed) {
          return this.markFailed(candidate, "Execution broker is disposed", result.runtimeVersion);
        }
        if (result.ready && this.policy.mode === "required") {
          await this.adapter.preflightWorkdir?.(this.policy, this.options.workdir, this.boundaryId);
        }
      } catch (err) {
        result = { ready: false, reason: `OCI probe failed: ${errorMessage(err)}` };
      }
    } else {
      result = {
        ready: false,
        reason: "No isolation candidate is configured (set a digest-pinned AGENT_EXECUTION_OCI_IMAGE)",
      };
    }

    if (this.disposed) {
      return this.markFailed(candidate, "Execution broker is disposed", result.runtimeVersion);
    }

    if (this.policy.mode === "report") {
      this.current = {
        ...this.current,
        probe: {
          state: result.ready ? "ready" : "unavailable",
          candidate,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.runtimeVersion ? { runtimeVersion: result.runtimeVersion } : {}),
        },
      };
      return this.status();
    }

    if (!result.ready || candidate !== "oci") {
      return this.markFailed(
        candidate,
        result.reason ?? "Isolation backend did not satisfy the required profile",
        result.runtimeVersion,
      );
    }

    this.current = {
      ...this.current,
      // 只有 bash 在 OCI 内；MCP/gateway 与逐 run worktree lease 尚未覆盖，不能写 isolated。
      effectiveState: "partial",
      resolvedBackend: "oci",
      probe: {
        state: "ready",
        candidate: "oci",
        ...(result.runtimeVersion ? { runtimeVersion: result.runtimeVersion } : {}),
      },
      coverage: ["bash"],
      filesystem: "read-only image root; one RW workdir bind; nested mounts and observed host IPC/device entries rejected before exec (worktree lease/TOCTOU still pending)",
      network: "none",
      identity: `numeric non-root ${OCI_PROFILE.user}; cap-drop=ALL; no-new-privileges`,
      resources: `memory=${OCI_PROFILE.memory}; swap=0; cpu=${OCI_PROFILE.cpus}; pids=${OCI_PROFILE.pids}; nofile=${OCI_PROFILE.nofile}; tmpfs=64m; daemon-label lease/reaper on next successful probe; workspace disk quota and autonomous timer not yet covered`,
    };
    return this.status();
  }

  async executeShell(request: ShellExecutionRequest): Promise<ShellExecutionResult> {
    if (this.disposed) return failedResult(request, this.current, "Execution broker is disposed");
    if (path.resolve(request.cwd) !== path.resolve(this.options.workdir)) {
      return failedResult(request, this.current, "Execution request cwd does not match this run boundary");
    }
    // required 每次 worker 启动前都重跑 runtime/profile + actual-workdir canary；
    // TTL 只服务未认证 readiness，不能充当执行授权票。
    const status = await this.probe(this.policy.mode === "required");
    if (this.disposed) return failedResult(request, status, "Execution broker is disposed");
    if (this.policy.mode === "required") {
      if (status.effectiveState !== "partial" || status.resolvedBackend !== "oci") {
        return failedResult(
          request,
          status,
          `Execution isolation is required but unavailable: ${status.probe.reason ?? "probe not ready"}`,
        );
      }
      const result = await this.adapter.execute(this.policy, request, this.boundaryId, status);
      if (result.cleanup === "failed" || result.error) {
        this.markFailed(
          "oci",
          result.error ?? "OCI worker cleanup could not be confirmed",
        );
        this.lastProbeAt = 0;
        return { ...result, status: this.status() };
      }
      return result;
    }
    return this.direct!({ ...request, env: sanitizeChildEnv(request.env) }, status);
  }

  async dispose(): Promise<void> {
    if (this.disposeComplete) return;
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    const adapterCleanup = Promise.resolve(this.adapter.dispose?.(this.policy, this.boundaryId));
    const activeProbe = this.probePromise;
    const task = Promise.all([
      adapterCleanup,
      ...(activeProbe ? [activeProbe.then(() => undefined, () => undefined)] : []),
    ]).then(() => {
      this.disposeComplete = true;
    }).finally(() => {
      if (this.disposePromise === task) this.disposePromise = undefined;
    });
    this.disposePromise = task;
    return task;
  }
}

export function createExecutionBroker(options: ExecutionBrokerOptions): ExecutionBroker {
  return new PolicyExecutionBroker({ ...options, workdir: path.resolve(options.workdir) });
}

/** CLI/Web launcher 的启动探针。required 不可用时调用方应 fail closed。 */
export async function preflightExecutionBroker(
  options: ExecutionBrokerOptions,
): Promise<{ broker: ExecutionBroker; status: ExecutionBoundaryStatus }> {
  const broker = createExecutionBroker(options);
  const status = await broker.probe();
  return { broker, status };
}

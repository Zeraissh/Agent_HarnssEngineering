/**
 * 真实 OCI 验收。普通 `npm test` 在没有显式镜像时跳过；CI container job 先构建
 * 本地镜像、取不可变 image ID，再设置 AGENT_TEST_OCI_IMAGE 运行本文件。
 */
import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  createExecutionBroker,
  executionBoundaryLabel,
  executionNamespaceLabel,
  parseExecutionPolicy,
  readOciOwnerIdentity,
} from "../src/execution-broker.js";
import type { ShellExecutionRequest } from "../src/types.js";

const image = process.env.AGENT_TEST_OCI_IMAGE;
const runtime = process.env.AGENT_TEST_OCI_RUNTIME;
const runtimeSha256 = process.env.AGENT_TEST_OCI_RUNTIME_SHA256;
const hasTrustedOciFixture = Boolean(image && runtime && runtimeSha256);

it.skipIf(!hasTrustedOciFixture)("OCI required profile blocks host escape/env/network and enforces identity/resources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-harness-oci-it-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await chmod(workspace, 0o777);
  await writeFile(path.join(root, "outside.txt"), "host-secret", "utf8");
  await symlink("../outside.txt", path.join(workspace, "outside-link"));
  const boundaryId = `oci-it-${randomUUID()}`;
  const broker = createExecutionBroker({
    boundaryId,
    workdir: workspace,
    env: {
      AGENT_EXECUTION_ISOLATION: "required",
      AGENT_EXECUTION_BACKEND: "oci",
      AGENT_EXECUTION_OCI_IMAGE: image!,
      AGENT_EXECUTION_OCI_RUNTIME: runtime!,
      AGENT_EXECUTION_OCI_RUNTIME_SHA256: runtimeSha256!,
      AGENT_EXECUTION_OCI_NAMESPACE: boundaryId,
    },
  });
  process.env.HARNESS_OCI_CANARY_API_KEY = "must-not-enter-container";
  try {
    const command = [
      "set -eu",
      'test "$(id -u)" = "65532"',
      'test "$(id -g)" = "65532"',
      'test "$(id -G)" = "65532"',
      "awk '$2 == \"/\" && $4 ~ /(^|,)ro(,|$)/ { found=1 } END { exit !found }' /proc/mounts",
      "test -w /workspace",
      "test ! -r /workspace/outside-link",
      'test -z "${HARNESS_OCI_CANARY_API_KEY+x}"',
      'test -z "${NODE_ENV+x}"',
      "test ! -e /var/run/docker.sock",
      "grep -q '^NoNewPrivs:[[:space:]]*1$' /proc/self/status",
      "grep -q '^CapEff:[[:space:]]*0000000000000000$' /proc/self/status",
      "grep -q '^Seccomp:[[:space:]]*2$' /proc/self/status",
      'test "$(ulimit -n)" = "1024"',
      "! grep -qE '^[^[:space:]]+[[:space:]]+00000000[[:space:]]' /proc/net/route",
      'test "$(cat /sys/fs/cgroup/pids.max)" = "128"',
      'test "$(cat /sys/fs/cgroup/memory.max)" = "1073741824"',
      'test "$(cat /sys/fs/cgroup/memory.swap.max)" = "0"',
      'test "$(cat /sys/fs/cgroup/cpu.max)" = "100000 100000"',
      "printf '#!/bin/sh\\nexit 0\\n' > /tmp/noexec-canary",
      "chmod +x /tmp/noexec-canary",
      "! /tmp/noexec-canary",
      "printf isolated > /workspace/result.txt",
      "printf profile-ok",
    ].join(" && ");
    const result = await broker.executeShell(request(command, workspace));
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.cleanup).toBe("confirmed");
    expect(result.stdout).toContain("profile-ok");
    expect(result.status).toMatchObject({
      effectiveState: "partial",
      resolvedBackend: "oci",
      coverage: ["bash"],
      network: "none",
    });
    expect(await readFile(path.join(workspace, "result.txt"), "utf8")).toBe("isolated");
    expect(await readFile(path.join(root, "outside.txt"), "utf8")).toBe("host-secret");
  } finally {
    delete process.env.HARNESS_OCI_CANARY_API_KEY;
    await broker.dispose?.();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it.skipIf(!hasTrustedOciFixture)("OCI abort removes the whole named worker instead of leaving a container behind", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-harness-oci-abort-"));
  await chmod(workspace, 0o777);
  const boundaryId = `oci-abort-${randomUUID()}`;
  const broker = createExecutionBroker({
    boundaryId,
    workdir: workspace,
    env: {
      AGENT_EXECUTION_ISOLATION: "required",
      AGENT_EXECUTION_BACKEND: "oci",
      AGENT_EXECUTION_OCI_IMAGE: image!,
      AGENT_EXECUTION_OCI_RUNTIME: runtime!,
      AGENT_EXECUTION_OCI_RUNTIME_SHA256: runtimeSha256!,
      AGENT_EXECUTION_OCI_NAMESPACE: boundaryId,
    },
  });
  const controller = new AbortController();
  const running = broker.executeShell(request("sleep 30 & wait", workspace, controller.signal));
  try {
    // execute 先做 functional/workdir canary；必须看到真正的 boundary worker 后再
    // abort，否则只覆盖“探针期间取消”，并没有验到 worker 删除。
    await waitForManagedContainer(boundaryId);
    controller.abort();
    const result = await running;
    expect(result.aborted).toBe(true);
    expect(result.cleanup).toBe("confirmed");

    const ps = spawnSync(
      runtime!,
      [
        "--host", "unix:///var/run/docker.sock",
        "ps", "--all", "--filter",
        `label=agent-harness.boundary=${executionBoundaryLabel(boundaryId)}`,
        "--format", "{{.ID}}",
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect(ps.status).toBe(0);
    expect(ps.stdout.trim()).toBe("");
  } finally {
    controller.abort();
    await running.catch(() => undefined);
    await broker.dispose?.();
    await rm(workspace, { recursive: true, force: true });
  }
}, 40_000);

it.skipIf(!hasTrustedOciFixture)("OCI broker keeps concurrent workers independent", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-harness-oci-concurrent-"));
  await chmod(workspace, 0o777);
  const boundaryId = `oci-concurrent-${randomUUID()}`;
  const broker = ociBroker(boundaryId, workspace);
  try {
    const [left, right] = await Promise.all([
      broker.executeShell(request("sleep 0.2; printf left > left.txt", workspace)),
      broker.executeShell(request("sleep 0.1; printf right > right.txt", workspace)),
    ]);
    expect(left.exitCode).toBe(0);
    expect(right.exitCode).toBe(0);
    expect(left.cleanup).toBe("confirmed");
    expect(right.cleanup).toBe("confirmed");
    expect(await readFile(path.join(workspace, "left.txt"), "utf8")).toBe("left");
    expect(await readFile(path.join(workspace, "right.txt"), "utf8")).toBe("right");
  } finally {
    await broker.dispose?.();
    await rm(workspace, { recursive: true, force: true });
  }
}, 40_000);

it.skipIf(!hasTrustedOciFixture)("OCI bootstrap gives stdin-reading commands EOF without swallowing later approved lines", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-harness-oci-stdin-"));
  await chmod(workspace, 0o777);
  const broker = ociBroker(`oci-stdin-${randomUUID()}`, workspace);
  // The large tail makes the old `/bin/sh -s` failure deterministic: `cat`
  // inherits the script pipe and consumes lines the shell has not buffered yet.
  const filler = Array.from({ length: 16_384 }, (_, i) => `: # filler-${i}`).join("\n");
  const command = [
    "set -eu",
    "cat >/dev/null",
    filler,
    "printf survived > stdin-after.txt",
    "printf stdin-ok",
  ].join("\n");
  try {
    const result = await broker.executeShell(request(command, workspace));
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.cleanup).toBe("confirmed");
    expect(result.stdout).toContain("stdin-ok");
    expect(await readFile(path.join(workspace, "stdin-after.txt"), "utf8")).toBe("survived");
  } finally {
    await broker.dispose?.();
    await rm(workspace, { recursive: true, force: true });
  }
}, 40_000);

it.skipIf(!hasTrustedOciFixture)("OCI dispose kills an active worker and command text stays out of Config.Cmd", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-harness-oci-dispose-"));
  await chmod(workspace, 0o777);
  const boundaryId = `oci-dispose-${randomUUID()}`;
  const broker = ociBroker(boundaryId, workspace);
  const literal = `literal-${randomUUID()}`;
  const running = broker.executeShell(request(`value='${literal}'; sleep 30`, workspace));
  try {
    const containerId = await waitForManagedContainer(boundaryId);
    const inspect = docker(["container", "inspect", "--format", "{{json .Config.Cmd}}", containerId]);
    expect(inspect.status).toBe(0);
    expect(inspect.stdout).not.toContain(literal);
    const labelsInspect = docker(["container", "inspect", "--format", "{{json .Config.Labels}}", containerId]);
    expect(labelsInspect.status).toBe(0);
    const labels = JSON.parse(labelsInspect.stdout) as Record<string, string>;
    expect(labels).toMatchObject({
      "agent-harness.managed": "true",
      "agent-harness.schema": "3",
      "agent-harness.namespace": executionNamespaceLabel(boundaryId),
      "agent-harness.kind": "worker",
      "agent-harness.boundary": executionBoundaryLabel(boundaryId),
    });
    expect(labels["agent-harness.owner"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(labels["agent-harness.owner-boot"]).toMatch(/^[0-9a-f]{64}$/);
    expect(labels["agent-harness.owner-pidns"]).toMatch(/^[0-9a-f]{64}$/);
    expect(labels["agent-harness.owner-pid"]).toMatch(/^[1-9][0-9]*$/);
    expect(labels["agent-harness.owner-start"]).toMatch(/^[1-9][0-9]*$/);
    expect(labels["agent-harness.lease"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(labels["agent-harness.policy"]).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(labels["agent-harness.lease-ms"])).toBeGreaterThan(10_000);
    await broker.dispose?.();
    const result = await running;
    expect(result.exitCode).not.toBe(0);
    expect(result.cleanup).not.toBe("failed");
    expect(docker([
      "ps", "--all", "--filter",
      `label=agent-harness.boundary=${executionBoundaryLabel(boundaryId)}`,
      "--format", "{{.ID}}",
    ]).stdout.trim()).toBe("");
  } finally {
    await broker.dispose?.().catch(() => undefined);
    await running.catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
}, 40_000);

it.skipIf(!hasTrustedOciFixture)("OCI workdir preflight rejects a host Unix socket before execution", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-harness-oci-socket-"));
  await chmod(workspace, 0o777);
  const socketPath = path.join(workspace, "host.sock");
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });
  const broker = ociBroker(`oci-socket-${randomUUID()}`, workspace);
  try {
    const status = await broker.probe(true);
    expect(status).toMatchObject({ effectiveState: "failed", coverage: [] });
    expect(status.probe.reason).toMatch(/forbidden host IPC\/device entry/i);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await broker.dispose?.();
    await rm(workspace, { recursive: true, force: true });
  }
}, 40_000);

it.skipIf(!hasTrustedOciFixture)("OCI workdir preflight rejects a hard link to an inode outside the boundary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-harness-oci-hardlink-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await chmod(workspace, 0o777);
  const outside = path.join(root, "outside.txt");
  await writeFile(outside, "outside inode", "utf8");
  await link(outside, path.join(workspace, "outside-hardlink.txt"));
  const broker = ociBroker(`oci-hardlink-${randomUUID()}`, workspace);
  try {
    const status = await broker.probe(true);
    expect(status).toMatchObject({ effectiveState: "failed", coverage: [] });
    expect(status.probe.reason).toMatch(/forbidden hard-linked file/i);
  } finally {
    await broker.dispose?.();
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);

it.skipIf(!hasTrustedOciFixture)("OCI durable reaper removes only an expired schema-3 tombstone by full ID", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-harness-oci-reaper-expired-"));
  await chmod(workspace, 0o777);
  const namespace = `reaper-expired-${randomUUID()}`;
  const stale = startManagedLease(namespace, "expired-worker", 1_000);
  const broker = ociBroker(`reaper-probe-${randomUUID()}`, workspace, namespace);
  try {
    await waitForLeaseExpiry(stale.id);
    const status = await broker.probe(true);
    expect(status).toMatchObject({ effectiveState: "partial", resolvedBackend: "oci" });
    const gone = docker(["container", "inspect", stale.id]);
    expect(gone.status).not.toBe(0);
    expect(`${gone.stderr}\n${gone.stdout}`).toMatch(/No such (?:container|object)/i);
  } finally {
    docker(["rm", "--force", stale.id]);
    await broker.dispose?.().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
}, 40_000);

it.skipIf(!hasTrustedOciFixture)("OCI durable reaper preserves an unexpired foreign-process lease", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-harness-oci-reaper-live-"));
  await chmod(workspace, 0o777);
  const namespace = `reaper-live-${randomUUID()}`;
  const live = startManagedLease(namespace, "live-worker", 60_000);
  const broker = ociBroker(`reaper-probe-${randomUUID()}`, workspace, namespace);
  try {
    const status = await broker.probe(true);
    expect(status).toMatchObject({ effectiveState: "partial", resolvedBackend: "oci" });
    const present = docker(["container", "inspect", "--format", "{{.Id}}", live.id]);
    expect(present.status).toBe(0);
    expect(present.stdout.trim()).toBe(live.id);
  } finally {
    docker(["rm", "--force", live.id]);
    await broker.dispose?.().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
}, 40_000);

it.skipIf(!hasTrustedOciFixture)("OCI durable reaper preserves an expired lease while its exact owner process is alive", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-harness-oci-reaper-owner-live-"));
  await chmod(workspace, 0o777);
  const namespace = `reaper-owner-live-${randomUUID()}`;
  const owner = await readOciOwnerIdentity();
  const live = startManagedLease(namespace, "owner-live-worker", 1_000, {
    "agent-harness.owner-boot": owner.boot,
    "agent-harness.owner-pidns": owner.pidNamespace,
    "agent-harness.owner-pid": String(owner.pid),
    "agent-harness.owner-start": owner.startTicks,
  });
  const broker = ociBroker(`reaper-probe-${randomUUID()}`, workspace, namespace);
  try {
    await waitForLeaseExpiry(live.id);
    const status = await broker.probe(true);
    expect(status).toMatchObject({ effectiveState: "partial", resolvedBackend: "oci" });
    expect(docker(["container", "inspect", "--format", "{{.Id}}", live.id]).status).toBe(0);
  } finally {
    docker(["rm", "--force", live.id]);
    await broker.dispose?.().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
}, 40_000);

it.skipIf(!hasTrustedOciFixture)("OCI durable reaper preserves an expired lease owned by a different live process", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-harness-oci-reaper-foreign-live-"));
  await chmod(workspace, 0o777);
  const namespace = `reaper-foreign-live-${randomUUID()}`;
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const ownerExit = childExit(owner);
  const broker = ociBroker(`reaper-probe-${randomUUID()}`, workspace, namespace);
  let live: { id: string; name: string } | undefined;
  try {
    if (!owner.pid) throw new Error("Foreign owner process did not receive a PID");
    const identity = await waitForOwnerIdentity(owner.pid);
    live = startManagedLease(namespace, "foreign-owner-live-worker", 1_000, {
      "agent-harness.owner-boot": identity.boot,
      "agent-harness.owner-pidns": identity.pidNamespace,
      "agent-harness.owner-pid": String(identity.pid),
      "agent-harness.owner-start": identity.startTicks,
    });
    await waitForLeaseExpiry(live.id);
    const status = await broker.probe(true);
    expect(status).toMatchObject({ effectiveState: "partial", resolvedBackend: "oci" });
    expect(docker(["container", "inspect", "--format", "{{.Id}}", live.id]).status).toBe(0);
  } finally {
    if (live) docker(["rm", "--force", live.id]);
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    await ownerExit.catch(() => undefined);
    await broker.dispose?.().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
}, 45_000);

it.skipIf(!hasTrustedOciFixture)("OCI durable reaper removes an expired worker after its owning Node process is SIGKILLed", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-harness-oci-reaper-sigkill-"));
  await chmod(workspace, 0o777);
  const namespace = `reaper-sigkill-${randomUUID()}`;
  const boundaryId = `sigkill-owner-${randomUUID()}`;
  const fixture = fileURLToPath(new URL("./fixtures/oci-crash-owner.ts", import.meta.url));
  let stderr = "";
  const owner = spawn(process.execPath, ["--import", "tsx", fixture], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_TEST_OCI_IMAGE: image!,
      AGENT_TEST_OCI_RUNTIME: runtime!,
      AGENT_TEST_OCI_RUNTIME_SHA256: runtimeSha256!,
      AGENT_OCI_CRASH_WORKSPACE: workspace,
      AGENT_OCI_CRASH_BOUNDARY: boundaryId,
      AGENT_OCI_CRASH_NAMESPACE: namespace,
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  owner.stderr?.setEncoding("utf8");
  owner.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });
  const ownerExit = childExit(owner);
  let staleId: string | undefined;
  let broker: ReturnType<typeof ociBroker> | undefined;
  try {
    staleId = await waitForManagedContainer(boundaryId);
    if (!owner.pid) throw new Error("Crash owner process did not receive a PID");
    const expectedOwner = await readOciOwnerIdentity(owner.pid);
    const before = docker(["container", "inspect", "--format", "{{json .Config.Labels}}", staleId]);
    expect(before.status).toBe(0);
    expect(JSON.parse(before.stdout) as Record<string, string>).toMatchObject({
      "agent-harness.owner-boot": expectedOwner.boot,
      "agent-harness.owner-pidns": expectedOwner.pidNamespace,
      "agent-harness.owner-pid": String(expectedOwner.pid),
      "agent-harness.owner-start": expectedOwner.startTicks,
    });
    expect(owner.kill("SIGKILL")).toBe(true);
    const exited = await ownerExit;
    expect(exited).toMatchObject({ code: null, signal: "SIGKILL" });
    await waitForLeaseExpiry(staleId);

    broker = ociBroker(`reaper-probe-${randomUUID()}`, workspace, namespace);
    const status = await broker.probe(true);
    expect(status).toMatchObject({ effectiveState: "partial", resolvedBackend: "oci" });
    const gone = docker(["container", "inspect", staleId]);
    expect(gone.status).not.toBe(0);
    expect(`${gone.stderr}\n${gone.stdout}`).toMatch(/No such (?:container|object)/i);
  } catch (err) {
    throw new Error(`SIGKILL reaper acceptance failed: ${String(err)}${stderr ? `\nchild stderr:\n${stderr}` : ""}`);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    await ownerExit.catch(() => undefined);
    removeNamespaceContainers(namespace);
    await broker?.dispose?.().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
}, 60_000);

it.skipIf(!hasTrustedOciFixture)("OCI durable reaper fails closed and leaves a malformed current-namespace tombstone intact", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-harness-oci-reaper-malformed-"));
  await chmod(workspace, 0o777);
  const namespace = `reaper-malformed-${randomUUID()}`;
  const malformed = startManagedLease(namespace, "malformed-worker", 1_000, {
    "agent-harness.managed": "false",
  });
  const broker = ociBroker(`reaper-probe-${randomUUID()}`, workspace, namespace);
  try {
    const status = await broker.probe(true);
    expect(status).toMatchObject({ effectiveState: "failed", coverage: [] });
    expect(status.probe.reason).toMatch(/durable reaper.*tombstone is malformed/i);
    expect(docker(["container", "inspect", "--format", "{{.Id}}", malformed.id]).status).toBe(0);
  } finally {
    docker(["rm", "--force", malformed.id]);
    await broker.dispose?.().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
}, 40_000);

function ociBroker(boundaryId: string, workspace: string, namespace = boundaryId) {
  return createExecutionBroker({
    boundaryId,
    workdir: workspace,
    env: {
      AGENT_EXECUTION_ISOLATION: "required",
      AGENT_EXECUTION_BACKEND: "oci",
      AGENT_EXECUTION_OCI_IMAGE: image!,
      AGENT_EXECUTION_OCI_RUNTIME: runtime!,
      AGENT_EXECUTION_OCI_RUNTIME_SHA256: runtimeSha256!,
      AGENT_EXECUTION_OCI_NAMESPACE: namespace,
    },
  });
}

function startManagedLease(
  namespace: string,
  boundaryId: string,
  leaseMs: number,
  labelOverrides: Record<string, string> = {},
): { id: string; name: string } {
  const leaseId = randomUUID();
  const ownerId = randomUUID();
  const boundary = executionBoundaryLabel(boundaryId);
  const name = `agent-harness-${boundary}-${leaseId}`;
  const policy = parseExecutionPolicy({
    AGENT_EXECUTION_ISOLATION: "required",
    AGENT_EXECUTION_BACKEND: "oci",
    AGENT_EXECUTION_OCI_IMAGE: image!,
    AGENT_EXECUTION_OCI_RUNTIME: runtime!,
    AGENT_EXECUTION_OCI_RUNTIME_SHA256: runtimeSha256!,
    AGENT_EXECUTION_OCI_NAMESPACE: namespace,
  });
  const labels: Record<string, string> = {
    "agent-harness.managed": "true",
    "agent-harness.schema": "3",
    "agent-harness.namespace": executionNamespaceLabel(namespace),
    "agent-harness.owner": ownerId,
    "agent-harness.owner-boot": "f".repeat(64),
    "agent-harness.owner-pidns": "e".repeat(64),
    "agent-harness.owner-pid": "999999999",
    "agent-harness.owner-start": "1",
    "agent-harness.lease": leaseId,
    "agent-harness.kind": "worker",
    "agent-harness.boundary": boundary,
    "agent-harness.policy": policy.policyDigest,
    "agent-harness.lease-ms": String(leaseMs),
    ...labelOverrides,
  };
  const labelArgs = Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
  const started = docker([
    "run", "--detach", "--rm", "--pull", "never", "--no-healthcheck",
    "--name", name,
    ...labelArgs,
    "--entrypoint", "/bin/sh",
    image!,
    "-c", "sleep 30",
  ]);
  expect(started.status).toBe(0);
  const id = started.stdout.trim();
  expect(id).toMatch(/^[0-9a-f]{64}$/);
  return { id, name };
}

function docker(args: string[]) {
  return spawnSync(runtime!, ["--host", "unix:///var/run/docker.sock", ...args], {
    encoding: "utf8",
    timeout: 15_000,
  });
}

async function waitForLeaseExpiry(containerId: string): Promise<void> {
  const inspected = docker(["container", "inspect", "--format", "{{json .}}", containerId]);
  if (inspected.status !== 0) throw new Error(`Could not inspect lease ${containerId}: ${inspected.stderr}`);
  const payload = JSON.parse(inspected.stdout) as {
    Created?: unknown;
    Config?: { Labels?: Record<string, string> };
  };
  if (typeof payload.Created !== "string") throw new Error("Managed lease has no Created timestamp");
  const rawLeaseMs = payload.Config?.Labels?.["agent-harness.lease-ms"];
  if (!rawLeaseMs || !/^[1-9][0-9]*$/.test(rawLeaseMs)) throw new Error("Managed lease has no valid duration");
  const expiresAt = dockerTimestampMs(payload.Created) + Number(rawLeaseMs);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const info = docker(["info", "--format", "{{json .SystemTime}}"]) ;
    if (info.status === 0) {
      try {
        const daemonTime = JSON.parse(info.stdout.trim()) as unknown;
        if (typeof daemonTime === "string" && dockerTimestampMs(daemonTime) >= expiresAt + 100) return;
      } catch {
        // A transient/truncated info reply is not proof of expiry; retry until the deadline.
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Timed out waiting for OCI lease ${containerId} to expire`);
}

function dockerTimestampMs(value: string): number {
  const normalized = value.replace(/\.(\d{3})\d*(?=(?:Z|[+-]\d{2}:\d{2})$)/, ".$1");
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid Docker timestamp: ${value}`);
  return parsed;
}

async function waitForOwnerIdentity(pid: number) {
  const deadline = Date.now() + 2_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await readOciOwnerIdentity(pid);
    } catch (err) {
      lastError = err;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not read foreign owner identity");
}

function childExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function removeNamespaceContainers(namespace: string): void {
  const listed = docker([
    "container", "ls", "--all", "--no-trunc",
    "--filter", `label=agent-harness.namespace=${executionNamespaceLabel(namespace)}`,
    "--format", "{{.ID}}",
  ]);
  if (listed.status !== 0) return;
  for (const id of listed.stdout.split(/\s+/).filter((value) => /^[0-9a-f]{64}$/.test(value))) {
    docker(["rm", "--force", id]);
  }
}

async function waitForManagedContainer(boundaryId: string): Promise<string> {
  const label = `label=agent-harness.boundary=${executionBoundaryLabel(boundaryId)}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const found = docker(["ps", "--filter", label, "--format", "{{.ID}}"]) ;
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim().split(/\s+/)[0]!;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for OCI worker ${executionBoundaryLabel(boundaryId)}`);
}

function request(
  command: string,
  cwd: string,
  signal: AbortSignal = new AbortController().signal,
): ShellExecutionRequest {
  return {
    command,
    cwd,
    env: { HARNESS_OCI_CANARY_API_KEY: "must-not-enter-container" },
    timeoutMs: 10_000,
    maxBufferBytes: 1024 * 1024,
    signal,
    windowsHide: true,
    toolUseId: "tu_oci_integration",
  };
}

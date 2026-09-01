import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildOciRunArgs,
  createExecutionBroker,
  dockerInspectConfirmsAbsent,
  executionBoundaryLabel,
  executionNamespaceLabel,
  inspectOciOwnerLiveness,
  OCI_STDIN_BOOTSTRAP,
  parseOciManagedContainer,
  parseExecutionPolicy,
  type OciExecutionAdapter,
  type OciLeaseSpec,
} from "../src/execution-broker.js";
import { createBashTool } from "../src/tools/bash.js";
import { ToolExecutor, ToolRegistry } from "../src/tools/registry.js";
import { toolUseBlock } from "./helpers.js";
import type {
  ExecutionBoundaryStatus,
  ExecutionBroker,
  ShellExecutionRequest,
  ShellExecutionResult,
  Tool,
} from "../src/types.js";

const workdir = path.resolve(process.cwd());

function testLease(overrides: Partial<OciLeaseSpec> = {}): OciLeaseSpec {
  return {
    namespace: executionNamespaceLabel("unit-test"),
    ownerId: "11111111-1111-4111-8111-111111111111",
    ownerBoot: "d".repeat(64),
    ownerPidNamespace: "e".repeat(64),
    ownerPid: 1234,
    ownerStartTicks: "5678",
    leaseId: "22222222-2222-4222-8222-222222222222",
    kind: "worker",
    policyDigest: "a".repeat(64),
    leaseMs: 135_000,
    ...overrides,
  };
}

function status(
  effectiveState: ExecutionBoundaryStatus["effectiveState"],
  resolvedBackend: ExecutionBoundaryStatus["resolvedBackend"],
  requestedMode: ExecutionBoundaryStatus["requestedMode"] = "required",
): ExecutionBoundaryStatus {
  return {
    schemaVersion: 1,
    boundaryId: "run-test",
    requestedMode,
    requestedBackend: resolvedBackend === "oci" ? "oci" : "auto",
    effectiveState,
    resolvedBackend,
    policyDigest: "a".repeat(64),
    probe: {
      state: effectiveState === "failed" ? "unavailable" : "ready",
      candidate: resolvedBackend === "oci" ? "oci" : null,
      ...(effectiveState === "failed" ? { reason: "not ready" } : {}),
    },
    coverage: effectiveState === "partial" ? ["bash"] : [],
    filesystem: "test fs",
    network: "test net",
    identity: "test uid",
    resources: "test limits",
  };
}

function resultFor(
  request: ShellExecutionRequest,
  boundary: ExecutionBoundaryStatus,
  stdout = "ok\n",
): ShellExecutionResult {
  return {
    stdout,
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: request.signal.aborted,
    outputLimitExceeded: false,
    cleanup: "not-needed",
    status: boundary,
  };
}

describe("SAFE-05 execution policy", () => {
  it("defaults to report/auto and never labels host execution isolated", () => {
    const policy = parseExecutionPolicy({});
    expect(policy).toMatchObject({
      mode: "report",
      backend: "auto",
      ociHost: "unix:///var/run/docker.sock",
      ociLeaseGraceMs: 15_000,
      ociReaperTimeoutMs: 30_000,
    });
    expect(policy.ociRuntime).toBeUndefined();
    expect(policy.policyDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects invalid modes, contradictory off/backend, and mutable images", () => {
    expect(() => parseExecutionPolicy({ AGENT_EXECUTION_ISOLATION: "maybe" })).toThrow(/invalid/);
    expect(() => parseExecutionPolicy({
      AGENT_EXECUTION_ISOLATION: "off",
      AGENT_EXECUTION_BACKEND: "oci",
    })).toThrow(/cannot be combined/);
    expect(() => parseExecutionPolicy({
      AGENT_EXECUTION_ISOLATION: "required",
      AGENT_EXECUTION_BACKEND: "oci",
      AGENT_EXECUTION_OCI_IMAGE: "node:22",
    })).toThrow(/content-addressed/);
    expect(() => parseExecutionPolicy({
      AGENT_EXECUTION_ISOLATION: "required",
      AGENT_EXECUTION_BACKEND: "oci",
      AGENT_EXECUTION_OCI_RUNTIME: "docker",
      AGENT_EXECUTION_OCI_RUNTIME_SHA256: "a".repeat(64),
    })).toThrow(/absolute Docker CLI path/);
    expect(() => parseExecutionPolicy({
      AGENT_EXECUTION_ISOLATION: "required",
      AGENT_EXECUTION_BACKEND: "oci",
      AGENT_EXECUTION_OCI_RUNTIME: path.resolve("docker"),
    })).toThrow(/configured together/);
    expect(() => parseExecutionPolicy({
      AGENT_EXECUTION_ISOLATION: "required",
      AGENT_EXECUTION_BACKEND: "oci",
      AGENT_EXECUTION_OCI_RUNTIME: path.resolve("docker"),
      AGENT_EXECUTION_OCI_RUNTIME_SHA256: "a".repeat(64),
      AGENT_EXECUTION_OCI_HOST: "tcp://127.0.0.1:2375",
    })).toThrow(/local absolute unix/);
    expect(() => parseExecutionPolicy({
      AGENT_EXECUTION_OCI_NAMESPACE: "bad namespace",
    })).toThrow(/NAMESPACE.*1-64/);
    expect(() => parseExecutionPolicy({
      AGENT_EXECUTION_OCI_LEASE_GRACE_MS: "999999",
    })).toThrow(/LEASE_GRACE_MS.*between/);
    expect(() => parseExecutionPolicy({
      AGENT_EXECUTION_OCI_REAPER_TIMEOUT_MS: "0",
    })).toThrow(/positive integer/);
  });

  it("accepts repo digest and local image ID references", () => {
    for (const image of [
      `registry.example/agent-exec@sha256:${"1".repeat(64)}`,
      `sha256:${"2".repeat(64)}`,
    ]) {
      expect(parseExecutionPolicy({
        AGENT_EXECUTION_ISOLATION: "required",
        AGENT_EXECUTION_BACKEND: "oci",
        AGENT_EXECUTION_OCI_IMAGE: image,
      }).ociImage).toBe(image);
    }
  });

  it("required without an absolute hash-pinned runtime fails before any PATH lookup", async () => {
    const broker = createExecutionBroker({
      boundaryId: "no-path-runtime",
      workdir,
      env: {
        AGENT_EXECUTION_ISOLATION: "required",
        AGENT_EXECUTION_BACKEND: "oci",
        AGENT_EXECUTION_OCI_IMAGE: `sha256:${"3".repeat(64)}`,
        PATH: path.join(workdir, "attacker-controlled-bin"),
      },
    });
    const s = await broker.probe(true);
    expect(s.effectiveState).toBe("failed");
    expect(s.probe.reason).toMatch(/RUNTIME.*SHA256.*required/i);
  });
});

describe("OCI cleanup proof", () => {
  const inspect = (overrides: Partial<Parameters<typeof dockerInspectConfirmsAbsent>[0]> = {}) => ({
    stdout: "",
    stderr: "",
    exitCode: 1,
    timedOut: false,
    aborted: false,
    outputLimitExceeded: false,
    ...overrides,
  });

  it("accepts only Docker's explicit no-such-container receipt", () => {
    expect(dockerInspectConfirmsAbsent(inspect({
      stderr: "Error response from daemon: No such container: agent-harness-x",
    }))).toBe(true);
    expect(dockerInspectConfirmsAbsent(inspect({ stderr: "Cannot connect to the Docker daemon" }))).toBe(false);
    expect(dockerInspectConfirmsAbsent(inspect({ timedOut: true }))).toBe(false);
    expect(dockerInspectConfirmsAbsent(inspect({ exitCode: 0 }))).toBe(false);
    expect(dockerInspectConfirmsAbsent(inspect({ error: "spawn failed", exitCode: null }))).toBe(false);
  });
});

describe("OCI policy args", () => {
  it("fixes mount/network/identity/resources and keeps agent command out of runtime argv", () => {
    const command = 'printf "%s" "$SECRET"; touch ../escape';
    const lease = testLease();
    const args = buildOciRunArgs({
      image: `registry.example/exec@sha256:${"a".repeat(64)}`,
      name: `agent-harness-${executionBoundaryLabel("run-1")}-${lease.leaseId}`,
      boundaryId: "run-1",
      workdir,
      command,
      lease,
    });

    const valueAfter = (flag: string) => args[args.indexOf(flag) + 1];
    expect(valueAfter("--pull")).toBe("never");
    expect(valueAfter("--network")).toBe("none");
    expect(valueAfter("--ipc")).toBe("none");
    expect(args).toContain("--read-only");
    expect(args).toContain("--no-healthcheck");
    expect(valueAfter("--cap-drop")).toBe("ALL");
    expect(valueAfter("--security-opt")).toBe("no-new-privileges:true");
    expect(args).toContain("seccomp=builtin");
    expect(valueAfter("--user")).toBe("65532:65532");
    expect(args).toContain("--interactive");
    expect(valueAfter("--entrypoint")).toBe("/usr/bin/env");
    expect(valueAfter("--pids-limit")).toBe("128");
    expect(valueAfter("--memory")).toBe("1g");
    expect(valueAfter("--memory-swap")).toBe("1g");
    expect(valueAfter("--cpus")).toBe("1.0");
    expect(valueAfter("--mount")).toBe(
      `type=bind,source=${workdir},target=/workspace,bind-recursive=disabled`,
    );
    expect(args.filter((arg) => arg === "--mount")).toHaveLength(1);
    expect(args.slice(-3)).toEqual(["/bin/sh", "-c", OCI_STDIN_BOOTSTRAP]);
    expect(OCI_STDIN_BOOTSTRAP).toContain('cat > "$script"');
    expect(OCI_STDIN_BOOTSTRAP).toContain('exec /bin/sh "$script" </dev/null');
    expect(args.slice(-6, -3)).toEqual([
      "-i",
      "HOME=/tmp",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ]);
    expect(args).not.toContain(command);
    expect(args.join(" ")).not.toContain("$SECRET");
    expect(args.join(" ")).not.toContain("docker.sock");
    for (const expected of [
      "agent-harness.managed=true",
      "agent-harness.schema=3",
      `agent-harness.namespace=${executionNamespaceLabel("unit-test")}`,
      "agent-harness.owner=11111111-1111-4111-8111-111111111111",
      "agent-harness.owner-boot=" + "d".repeat(64),
      "agent-harness.owner-pidns=" + "e".repeat(64),
      "agent-harness.owner-pid=1234",
      "agent-harness.owner-start=5678",
      "agent-harness.lease=22222222-2222-4222-8222-222222222222",
      "agent-harness.kind=worker",
      "agent-harness.policy=" + "a".repeat(64),
      "agent-harness.lease-ms=135000",
    ]) expect(args).toContain(expected);
  });

  it("rejects mount strings whose comma/newline would alter Docker --mount parsing", () => {
    expect(() => buildOciRunArgs({
      image: `sha256:${"a".repeat(64)}`,
      name: "n",
      boundaryId: "r",
      workdir: path.join(workdir, "bad,name"),
      command: "true",
      lease: testLease(),
    })).toThrow(/comma or newline/);
  });
});

describe("OCI durable tombstone schema", () => {
  const namespace = executionNamespaceLabel("unit-test");
  const leaseId = "22222222-2222-4222-8222-222222222222";
  const boundary = "b".repeat(24);
  const labels = {
    "agent-harness.managed": "true",
    "agent-harness.schema": "3",
    "agent-harness.namespace": namespace,
    "agent-harness.owner": "11111111-1111-4111-8111-111111111111",
    "agent-harness.owner-boot": "d".repeat(64),
    "agent-harness.owner-pidns": "e".repeat(64),
    "agent-harness.owner-pid": "1234",
    "agent-harness.owner-start": "5678",
    "agent-harness.lease": leaseId,
    "agent-harness.kind": "worker",
    "agent-harness.boundary": boundary,
    "agent-harness.policy": "a".repeat(64),
    "agent-harness.lease-ms": "135000",
  };
  const inspect = (overrides: Record<string, unknown> = {}) => ({
    Id: "c".repeat(64),
    Name: `/agent-harness-${boundary}-${leaseId}`,
    Created: "2026-08-28T01:02:03.123456789Z",
    Config: { Labels: { ...labels } },
    HostConfig: { AutoRemove: true, RestartPolicy: { Name: "no", MaximumRetryCount: 0 } },
    ...overrides,
  });

  it("parses a strict daemon-resident lease and computes expiry from Docker Created", () => {
    const record = parseOciManagedContainer(inspect(), namespace);
    expect(record).toMatchObject({
      id: "c".repeat(64),
      leaseId,
      boundary,
      leaseMs: 135_000,
      namespace,
      ownerBoot: "d".repeat(64),
      ownerPidNamespace: "e".repeat(64),
      ownerPid: 1234,
      ownerStartTicks: "5678",
    });
    expect(record.expiresAtMs - record.createdMs).toBe(135_000);
  });

  it("refuses malformed, legacy, restartable, or name-reused tombstones", () => {
    expect(() => parseOciManagedContainer(inspect({
      Config: { Labels: { ...labels, "agent-harness.managed": "false" } },
    }), namespace)).toThrow(/managed OCI label is invalid/);
    expect(() => parseOciManagedContainer(inspect({
      Config: { Labels: { ...labels, "agent-harness.schema": "1" } },
    }), namespace)).toThrow(/unknown lease schema/);
    expect(() => parseOciManagedContainer(inspect({
      Config: { Labels: { ...labels, "agent-harness.schema": "2" } },
    }), namespace)).toThrow(/unknown lease schema/);
    expect(() => parseOciManagedContainer(inspect({
      Config: { Labels: { ...labels, "agent-harness.lease-ms": "999999999999" } },
    }), namespace)).toThrow(/protocol bounds/);
    expect(() => parseOciManagedContainer(inspect({
      HostConfig: { AutoRemove: true, RestartPolicy: { Name: "always" } },
    }), namespace)).toThrow(/restart policy/);
    expect(() => parseOciManagedContainer(inspect({ Name: "/agent-harness-reused" }), namespace))
      .toThrow(/does not bind/);
  });

  it("treats hidden or cross-namespace owner processes as alive/unknown unless signal-zero proves ESRCH", async () => {
    const record = parseOciManagedContainer(inspect(), namespace);
    const current = {
      boot: record.ownerBoot,
      pidNamespace: record.ownerPidNamespace,
      pid: 9999,
      startTicks: "9999",
    };
    const hidden = Object.assign(new Error("hidden proc entry"), { code: "ENOENT" });
    const signalError = (code: string) => Object.assign(new Error(code), { code });

    expect(await inspectOciOwnerLiveness(record, current, {
      readProcStat: async () => { throw hidden; },
      signalZero: () => {},
    })).toEqual({ state: "alive" });
    expect(await inspectOciOwnerLiveness(record, current, {
      readProcStat: async () => { throw hidden; },
      signalZero: () => { throw signalError("EPERM"); },
    })).toMatchObject({ state: "unknown" });
    expect(await inspectOciOwnerLiveness(record, current, {
      readProcStat: async () => { throw hidden; },
      signalZero: () => { throw signalError("ESRCH"); },
    })).toEqual({ state: "dead" });

    const readProcStat = vi.fn(async () => "");
    const signalZero = vi.fn(() => {});
    expect(await inspectOciOwnerLiveness(record, {
      ...current,
      pidNamespace: "f".repeat(64),
    }, { readProcStat, signalZero })).toMatchObject({ state: "unknown" });
    expect(readProcStat).not.toHaveBeenCalled();
    expect(signalZero).not.toHaveBeenCalled();
  });
});

describe("broker fail-closed and mode semantics", () => {
  it("required without a ready backend never invokes the host runner", async () => {
    const direct = vi.fn(async (request: ShellExecutionRequest, s: ExecutionBoundaryStatus) =>
      resultFor(request, s));
    const broker = createExecutionBroker({
      boundaryId: "run-required-missing",
      workdir,
      env: { AGENT_EXECUTION_ISOLATION: "required" },
      directRunner: direct,
    });
    const request = shellRequest("should-not-run");
    const result = await broker.executeShell(request);
    expect(result.error).toMatch(/required but unavailable/i);
    expect(result.status.effectiveState).toBe("failed");
    expect(direct).not.toHaveBeenCalled();
  });

  it("report probes a candidate but deliberately executes on the explicitly labelled host lane", async () => {
    const adapter = fakeOciAdapter(true);
    const direct = vi.fn(async (request: ShellExecutionRequest, s: ExecutionBoundaryStatus) =>
      resultFor(request, s, "host\n"));
    const broker = createExecutionBroker({
      boundaryId: "run-report",
      workdir,
      env: ociEnv("report"),
      ociAdapter: adapter,
      directRunner: direct,
    });
    const reportRequest = shellRequest("echo report");
    reportRequest.env = { CALLER_BYPASS_API_KEY: "must-be-stripped", PATH: "safe" };
    const result = await broker.executeShell(reportRequest);
    expect(result.stdout).toBe("host\n");
    expect(result.status).toMatchObject({
      effectiveState: "report-only",
      resolvedBackend: "host",
      probe: { state: "ready", candidate: "oci" },
    });
    expect(direct).toHaveBeenCalledOnce();
    expect(direct.mock.calls[0]?.[0].env).toEqual({ PATH: "safe" });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("required+ready OCI uses the adapter, reports partial coverage, and never calls host", async () => {
    const adapter = fakeOciAdapter(true);
    const direct = vi.fn(async (request: ShellExecutionRequest, s: ExecutionBoundaryStatus) =>
      resultFor(request, s, "host\n"));
    const broker = createExecutionBroker({
      boundaryId: "run-oci",
      workdir,
      env: ociEnv("required"),
      ociAdapter: adapter,
      directRunner: direct,
    });
    const result = await broker.executeShell(shellRequest("echo isolated"));
    expect(result.stdout).toBe("oci\n");
    expect(result.status).toMatchObject({
      effectiveState: "partial",
      resolvedBackend: "oci",
      coverage: ["bash"],
      network: "none",
    });
    expect(adapter.execute).toHaveBeenCalledOnce();
    expect(direct).not.toHaveBeenCalled();
  });

  it("deduplicates readiness probes within TTL but force admission always refreshes", async () => {
    const adapter = fakeOciAdapter(true);
    const broker = createExecutionBroker({
      boundaryId: "run-probe-ttl",
      workdir,
      env: ociEnv("required"),
      ociAdapter: adapter,
      probeTtlMs: 5_000,
    });
    await Promise.all(Array.from({ length: 20 }, () => broker.probe(false)));
    expect(adapter.probe).toHaveBeenCalledTimes(1);
    await broker.probe(false);
    expect(adapter.probe).toHaveBeenCalledTimes(1);
    await broker.probe(true);
    expect(adapter.probe).toHaveBeenCalledTimes(2);
  });

  it("revokes every isolation claim when a previously-ready required probe fails", async () => {
    const adapter = fakeOciAdapter(true);
    vi.mocked(adapter.probe)
      .mockResolvedValueOnce({ ready: true, runtimeVersion: "up" })
      .mockResolvedValueOnce({ ready: false, runtimeVersion: "down", reason: "daemon lost" });
    const broker = createExecutionBroker({
      boundaryId: "run-ready-then-failed",
      workdir,
      env: ociEnv("required"),
      ociAdapter: adapter,
    });
    expect((await broker.probe(true)).coverage).toEqual(["bash"]);
    const failed = await broker.probe(true);
    expect(failed).toMatchObject({
      effectiveState: "failed",
      resolvedBackend: null,
      coverage: [],
      filesystem: "unavailable: execution boundary is not ready",
      network: "unavailable",
      identity: "unavailable",
      resources: "unavailable",
      probe: { state: "unavailable", reason: "daemon lost", runtimeVersion: "down" },
    });
  });

  it("revokes every isolation claim after execution or cleanup failure", async () => {
    const adapter = fakeOciAdapter(true);
    adapter.execute.mockImplementationOnce(async (
      _policy,
      request: ShellExecutionRequest,
      _boundaryId,
      s: ExecutionBoundaryStatus,
    ) => ({
      ...resultFor(request, s, ""),
      exitCode: null,
      cleanup: "failed",
      error: "cleanup receipt missing",
    }));
    const broker = createExecutionBroker({
      boundaryId: "run-exec-failed",
      workdir,
      env: ociEnv("required"),
      ociAdapter: adapter,
    });
    const result = await broker.executeShell(shellRequest("false"));
    expect(result.status).toMatchObject({
      effectiveState: "failed",
      resolvedBackend: null,
      coverage: [],
      filesystem: "unavailable: execution boundary is not ready",
      network: "unavailable",
      identity: "unavailable",
      resources: "unavailable",
    });
  });

  it("dispose racing a slow probe prevents a late workdir canary", async () => {
    let releaseProbe!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const preflightWorkdir = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const adapter: OciExecutionAdapter = {
      probe: vi.fn(async () => {
        markEntered();
        await gate;
        return { ready: true };
      }),
      preflightWorkdir,
      execute: async (_policy, request, _boundaryId, s) => resultFor(request, s),
      dispose,
    };
    const broker = createExecutionBroker({
      boundaryId: "run-probe-dispose-race",
      workdir,
      env: ociEnv("required"),
      ociAdapter: adapter,
    });
    const probing = broker.probe(true);
    await entered;
    const disposing = broker.dispose!();
    releaseProbe();
    const failed = await probing;
    await disposing;
    expect(preflightWorkdir).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(failed).toMatchObject({ effectiveState: "failed", coverage: [] });
  });

  it("dispose is idempotent and reaches the concrete adapter", async () => {
    const adapter = fakeOciAdapter(true);
    const dispose = vi.fn(async () => {});
    adapter.dispose = dispose;
    const broker = createExecutionBroker({
      boundaryId: "run-dispose",
      workdir,
      env: ociEnv("required"),
      ociAdapter: adapter,
    });
    await broker.dispose?.();
    await broker.dispose?.();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("binds cwd to the run boundary", async () => {
    const direct = vi.fn(async (request: ShellExecutionRequest, s: ExecutionBoundaryStatus) =>
      resultFor(request, s));
    const broker = createExecutionBroker({
      boundaryId: "run-cwd",
      workdir,
      env: { AGENT_EXECUTION_ISOLATION: "off" },
      directRunner: direct,
    });
    const request = { ...shellRequest("echo no"), cwd: path.resolve(workdir, "other") };
    const result = await broker.executeShell(request);
    expect(result.error).toMatch(/does not match/);
    expect(direct).not.toHaveBeenCalled();
  });
});

describe("ToolContext broker propagation", () => {
  it("ToolExecutor passes the exact run broker into bash without mutable global state", async () => {
    const seen: ShellExecutionRequest[] = [];
    const boundary = status("partial", "oci");
    const broker: ExecutionBroker = {
      boundaryId: boundary.boundaryId,
      status: () => boundary,
      probe: async () => boundary,
      executeShell: async (request) => {
        seen.push(request);
        return resultFor(request, boundary, "broker-ok\n");
      },
    };
    const registry = new ToolRegistry();
    registry.register(createBashTool());
    const executor = new ToolExecutor(registry, workdir, undefined, broker);
    const block = toolUseBlock("tu_broker", "bash", { command: "echo exact" });
    const results = await executor.executeAll(
      [block],
      new AbortController().signal,
      async () => ({ decision: "allow" as const }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      command: "echo exact",
      cwd: workdir,
      timeoutMs: 120_000,
      maxBufferBytes: 10 * 1024 * 1024,
      toolUseId: "tu_broker",
    });
    expect(results[0]?.content).toContain("state=partial backend=oci");
    expect(results[0]?.content).toContain("broker-ok");
  });

  it("bash strips provider secrets before handing a direct-capable broker the request", async () => {
    let captured: ShellExecutionRequest | undefined;
    const boundary = status("report-only", "host", "report");
    const broker: ExecutionBroker = {
      boundaryId: boundary.boundaryId,
      status: () => boundary,
      probe: async () => boundary,
      executeShell: async (request) => {
        captured = request;
        return resultFor(request, boundary);
      },
    };
    process.env.HARNESS_BROKER_SECRET_API_KEY = "must-not-flow";
    try {
      await createBashTool().execute(
        { command: "true" },
        {
          workdir,
          toolUseId: "tu_env",
          signal: new AbortController().signal,
          executionBroker: broker,
        },
      );
      expect(captured?.env).not.toHaveProperty("HARNESS_BROKER_SECRET_API_KEY");
    } finally {
      delete process.env.HARNESS_BROKER_SECRET_API_KEY;
    }
  });

  it("legacy-unbound bash owns and disposes its temporary broker", async () => {
    const boundary = status("report-only", "host", "report");
    const dispose = vi.fn(async () => {});
    const broker: ExecutionBroker = {
      boundaryId: "legacy-test",
      status: () => boundary,
      probe: async () => boundary,
      executeShell: async (request) => resultFor(request, boundary),
      dispose,
    };
    const tool = createBashTool({ legacyBrokerFactory: () => broker });
    const result = await tool.execute(
      { command: "true" },
      { workdir, toolUseId: "tu_legacy", signal: new AbortController().signal },
    );
    expect(result.isError).not.toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("legacy-unbound bash reports an unconfirmed broker disposal as a tool error", async () => {
    const boundary = status("report-only", "host", "report");
    const broker: ExecutionBroker = {
      boundaryId: "legacy-cleanup-failed",
      status: () => boundary,
      probe: async () => boundary,
      executeShell: async (request) => resultFor(request, boundary),
      dispose: async () => { throw new Error("worker still present"); },
    };
    const result = await createBashTool({ legacyBrokerFactory: () => broker }).execute(
      { command: "true" },
      { workdir, toolUseId: "tu_legacy_cleanup", signal: new AbortController().signal },
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("worker still present");
  });
});

function ociEnv(mode: "report" | "required"): NodeJS.ProcessEnv {
  return {
    AGENT_EXECUTION_ISOLATION: mode,
    AGENT_EXECUTION_BACKEND: "oci",
    AGENT_EXECUTION_OCI_IMAGE: `registry.example/exec@sha256:${"b".repeat(64)}`,
  };
}

function shellRequest(command: string): ShellExecutionRequest {
  return {
    command,
    cwd: workdir,
    env: {},
    timeoutMs: 1_000,
    maxBufferBytes: 64 * 1024,
    signal: new AbortController().signal,
    windowsHide: true,
    toolUseId: "tu_test",
  };
}

function fakeOciAdapter(ready: boolean): OciExecutionAdapter & { execute: ReturnType<typeof vi.fn> } {
  const probe = vi.fn(async () => ready
    ? { ready: true, runtimeVersion: "test-runtime" }
    : { ready: false, reason: "test unavailable" });
  const execute = vi.fn(async (
    _policy,
    request: ShellExecutionRequest,
    _boundaryId,
    s: ExecutionBoundaryStatus,
  ) => resultFor(request, s, "oci\n"));
  return {
    probe,
    execute,
  } as OciExecutionAdapter & { execute: ReturnType<typeof vi.fn> };
}

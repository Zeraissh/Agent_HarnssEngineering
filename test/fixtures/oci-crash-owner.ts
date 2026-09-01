/**
 * Child process used by the real OCI SIGKILL acceptance test. The parent waits
 * until this process owns a real worker, kills this Node process without
 * cleanup, then asks a fresh broker to reap the expired daemon tombstone.
 */
import { createExecutionBroker } from "../../src/execution-broker.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const workspace = required("AGENT_OCI_CRASH_WORKSPACE");
const boundaryId = required("AGENT_OCI_CRASH_BOUNDARY");
const namespace = required("AGENT_OCI_CRASH_NAMESPACE");
const broker = createExecutionBroker({
  boundaryId,
  workdir: workspace,
  env: {
    AGENT_EXECUTION_ISOLATION: "required",
    AGENT_EXECUTION_BACKEND: "oci",
    AGENT_EXECUTION_OCI_IMAGE: required("AGENT_TEST_OCI_IMAGE"),
    AGENT_EXECUTION_OCI_RUNTIME: required("AGENT_TEST_OCI_RUNTIME"),
    AGENT_EXECUTION_OCI_RUNTIME_SHA256: required("AGENT_TEST_OCI_RUNTIME_SHA256"),
    AGENT_EXECUTION_OCI_NAMESPACE: namespace,
    AGENT_EXECUTION_OCI_LEASE_GRACE_MS: "1000",
  },
});

const result = await broker.executeShell({
  command: "sleep 60",
  cwd: workspace,
  env: {},
  timeoutMs: 10_000,
  maxBufferBytes: 64 * 1024,
  signal: new AbortController().signal,
  windowsHide: true,
  toolUseId: "tu_oci_crash_owner",
});

await broker.dispose?.();
throw new Error(`Crash-owner fixture was not killed; worker ended with ${JSON.stringify(result)}`);

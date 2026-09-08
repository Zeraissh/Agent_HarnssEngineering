#!/usr/bin/env node
/**
 * SAFE-05 / WSL2 — 从 WSL 内探测 Docker fixture，打印可 export 的 AGENT_TEST_OCI_*。
 *
 * 用法（PowerShell）：
 *   node scripts/wsl2-oci-fixture.mjs
 *   # 然后：
 *   $env:AGENT_TEST_OCI_IMAGE=...; $env:AGENT_TEST_OCI_RUNTIME=...; ...
 *   $env:AGENT_EXECUTION_BACKEND="wsl2"
 *   npx vitest run test/execution-broker-oci.test.ts
 *
 * 需要：WSL2 + 发行版内 docker + 本机已有 debian:bookworm-slim（或设 AGENT_TEST_OCI_IMAGE）。
 */
import { spawnSync } from "node:child_process";

const wslExe = process.env.AGENT_EXECUTION_WSL_EXE?.trim() || "C:\\Windows\\System32\\wsl.exe";
const distro = process.env.AGENT_EXECUTION_WSL_DISTRO?.trim();

function wsl(script) {
  const args = distro
    ? ["-d", distro, "--", "/bin/bash", "-lc", script]
    : ["--", "/bin/bash", "-lc", script];
  const r = spawnSync(wslExe, args, { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout || `wsl exit ${r.status}`);
    process.exit(1);
  }
  return (r.stdout || "").trim();
}

const out = wsl([
  "set -eu",
  'DOCKER=$(command -v docker)',
  'DOCKER=$(readlink -f "$DOCKER")',
  'HASH=$(sha256sum "$DOCKER" | awk \'{print $1}\')',
  'IMAGE=${AGENT_TEST_OCI_IMAGE:-}',
  'if [ -z "$IMAGE" ]; then',
  '  if docker image inspect debian:bookworm-slim >/dev/null 2>&1; then',
  '    IMAGE=$(docker image inspect --format "{{.Id}}" debian:bookworm-slim)',
  '  else',
  '    echo "NO_IMAGE" >&2; exit 2',
  '  fi',
  'fi',
  'printf "%s\\n%s\\n%s\\n" "$IMAGE" "$DOCKER" "$HASH"',
].join("; "));

const [image, runtime, hash] = out.split(/\r?\n/);
if (!image || image === "NO_IMAGE") {
  console.error("No debian:bookworm-slim in WSL. Pull it inside WSL first, then re-run.");
  process.exit(2);
}

console.log(`# WSL2 OCI fixture (paste into PowerShell)`);
console.log(`$env:AGENT_EXECUTION_BACKEND = "wsl2"`);
console.log(`$env:AGENT_TEST_OCI_IMAGE = "${image}"`);
console.log(`$env:AGENT_TEST_OCI_RUNTIME = "${runtime}"`);
console.log(`$env:AGENT_TEST_OCI_RUNTIME_SHA256 = "${hash}"`);
if (distro) console.log(`$env:AGENT_EXECUTION_WSL_DISTRO = "${distro}"`);
console.log(`# then: npx vitest run test/execution-broker-oci.test.ts test/wsl2-path.test.ts`);

#!/usr/bin/env node
/**
 * SAFE-05 / WSL2 — 从 WSL 内探测 Docker fixture，打印可 export 的 AGENT_TEST_OCI_*。
 *
 * 用法（PowerShell）：
 *   node scripts/wsl2-oci-fixture.mjs
 *   # 粘贴输出的 $env:... 行，再：
 *   npx vitest run test/execution-broker-oci.test.ts
 *
 * Hub 超时可用 DaoCloud：
 *   docker pull docker.m.daocloud.io/library/debian:bookworm-slim
 *   docker tag docker.m.daocloud.io/library/debian:bookworm-slim debian:bookworm-slim
 *
 * 脚本经临时 .sh 文件交给 WSL，避免 PowerShell/宿主展开 `$DOCKER` 污染 bash。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const wslExe = process.env.AGENT_EXECUTION_WSL_EXE?.trim() || "C:\\Windows\\System32\\wsl.exe";
const distro = process.env.AGENT_EXECUTION_WSL_DISTRO?.trim();

/** Windows absolute → /mnt/<drive>/…（与 src/wsl-path.ts 同口径的最小子集） */
function toWslPath(winPath) {
  const normalized = path.resolve(winPath).replace(/\\/g, "/");
  const m = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!m) throw new Error(`Cannot map to WSL path: ${winPath}`);
  return `/mnt/${m[1].toLowerCase()}/${m[2]}`;
}

const bashScript = [
  "#!/bin/bash",
  "set -eu",
  "DOCKER_BIN=$(command -v docker)",
  'DOCKER_BIN=$(readlink -f "$DOCKER_BIN")',
  'HASH=$(sha256sum "$DOCKER_BIN" | awk \'{print $1}\')',
  'IMAGE=${AGENT_TEST_OCI_IMAGE:-}',
  'if [ -z "$IMAGE" ]; then',
  "  if docker image inspect debian:bookworm-slim >/dev/null 2>&1; then",
  "    IMAGE=$(docker image inspect --format '{{.Id}}' debian:bookworm-slim)",
  "  else",
  '    echo "NO_IMAGE" >&2',
  "    exit 2",
  "  fi",
  "fi",
  'printf "%s\\n%s\\n%s\\n" "$IMAGE" "$DOCKER_BIN" "$HASH"',
  "",
].join("\n");

const dir = mkdtempSync(path.join(tmpdir(), "wsl2-oci-fix-"));
const scriptPath = path.join(dir, "probe.sh");
writeFileSync(scriptPath, bashScript, "utf8");

try {
  const wslScriptPath = toWslPath(scriptPath);
  const args = distro
    ? ["-d", distro, "--", "/bin/bash", wslScriptPath]
    : ["--", "/bin/bash", wslScriptPath];
  const r = spawnSync(wslExe, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    env: process.env,
  });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout || `wsl exit ${r.status}`);
    process.exit(r.status === 2 ? 2 : 1);
  }
  const lines = (r.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  const [image, runtime, hash] = lines;
  if (!image || image === "NO_IMAGE" || !runtime || !hash) {
    console.error(
      "No debian:bookworm-slim in WSL. Pull it inside WSL first (DaoCloud mirror OK if Hub times out):\n" +
        "  docker pull docker.m.daocloud.io/library/debian:bookworm-slim\n" +
        "  docker tag docker.m.daocloud.io/library/debian:bookworm-slim debian:bookworm-slim\n" +
        "then re-run.",
    );
    process.exit(2);
  }

  console.log(`# WSL2 OCI fixture (paste into PowerShell)`);
  console.log(`$env:AGENT_EXECUTION_BACKEND = "wsl2"`);
  console.log(`$env:AGENT_TEST_OCI_IMAGE = "${image}"`);
  console.log(`$env:AGENT_TEST_OCI_RUNTIME = "${runtime}"`);
  console.log(`$env:AGENT_TEST_OCI_RUNTIME_SHA256 = "${hash}"`);
  if (distro) console.log(`$env:AGENT_EXECUTION_WSL_DISTRO = "${distro}"`);
  console.log(`# then: npx vitest run test/execution-broker-oci.test.ts test/wsl2-path.test.ts`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

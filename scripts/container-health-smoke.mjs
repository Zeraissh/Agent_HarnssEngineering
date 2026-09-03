/**
 * E2E-01 — 容器 health 薄烟：拉起刚 build 的 agent-harness 镜像，探 /health，收树。
 *
 * 用法（CI container job 在 docker build 之后）：
 *   node scripts/container-health-smoke.mjs agent-harness:ci
 *
 * 不替代 OCI 逃逸 canary（test/execution-broker-oci.test.ts）；只证明运行时镜像
 * 能起来并回答 liveness——docs/08 完成定义里的「容器 health」半边。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const image = process.argv[2] || "agent-harness:ci";
const TOKEN = "e2e-container-health-smoke-token-32c"; // 恰好 32+；不是密钥材料
const NAME = `agent-harness-health-${process.pid}`;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function pickPort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") {
        s.close();
        reject(new Error("no port"));
        return;
      }
      const port = addr.port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function main() {
  const port = await pickPort();
  const origin = `http://127.0.0.1:${port}`;

  // 镜像默认 AGENT_UI_HOST=0.0.0.0 → 远程策略：token + 精确 origin + insecure 明示
  const args = [
    "run",
    "--rm",
    "--detach",
    "--name",
    NAME,
    "-p",
    `127.0.0.1:${port}:4173`,
    "-e",
    `AGENT_UI_ACCESS_TOKEN=${TOKEN}`,
    "-e",
    "AGENT_UI_ALLOW_INSECURE_HTTP=1",
    "-e",
    `AGENT_UI_ALLOWED_ORIGINS=${origin}`,
    "-e",
    "ANTHROPIC_API_KEY=container-smoke-not-a-real-key",
    "-e",
    "AGENT_MODEL=mock-unused",
    image,
  ];

  const started = await run("docker", args);
  if (started.code !== 0) {
    console.error(started.stderr || started.stdout);
    process.exit(1);
  }
  const id = started.stdout.trim();
  console.log(`started ${id.slice(0, 12)} → ${origin}`);

  let healthy = false;
  let last = "";
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${origin}/health`);
        last = `HTTP ${res.status}`;
        if (res.ok) {
          const body = await res.json().catch(() => ({}));
          healthy = true;
          console.log(JSON.stringify({ healthy: true, health: body }));
          break;
        }
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!healthy) {
      const logs = await run("docker", ["logs", NAME]);
      console.error(`health failed: ${last}`);
      console.error(logs.stdout || logs.stderr);
      process.exitCode = 1;
    }
  } finally {
    await run("docker", ["stop", "-t", "5", NAME]);
  }

  if (process.exitCode) process.exit(process.exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

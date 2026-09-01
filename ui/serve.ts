/**
 * Web 宿主 launcher。
 *
 * 此前仓库里没有它——`createUiServer` 只被测试调用，案例文档说的
 * "可用 tsx <launcher> 起"其实指向一个不存在的文件。
 *
 * 环境变量：
 *   AGENT_UI_PORT / PORT   监听端口，默认 4173
 *   AGENT_UI_HOST          监听地址，默认 127.0.0.1
 *   AGENT_UI_ACCESS_TOKEN  访问令牌；非 loopback 监听时必填且至少 32 字符
 *   AGENT_UI_BEHIND_TLS_PROXY=1  位于可信 TLS 反代之后，并信任 forwarded proto/host
 *   AGENT_UI_ALLOW_INSECURE_HTTP=1  显式接受远程明文风险（生产不建议）
 *   AGENT_UI_ALLOWED_ORIGINS      精确跨源白名单，逗号分隔
 *   AGENT_UI_ALLOW_REMOTE_EXECUTION=1  非 loopback 时显式装回 bash（默认移除）
 *   AGENT_EXECUTION_ISOLATION  off|report|required；远程 bash 必须 required
 *   AGENT_EXECUTION_BACKEND    auto|oci|bwrap；本版 required 只实现 OCI
 *   AGENT_EXECUTION_OCI_IMAGE  digest/image-ID 固定引用；不自动 pull
 *   AGENT_EXECUTION_OCI_RUNTIME Linux 管理员固定的 Docker CLI 绝对真实路径
 *   AGENT_EXECUTION_OCI_RUNTIME_SHA256 与 runtime 成对的 64 位 SHA-256
 *   AGENT_EXECUTION_OCI_HOST    仅允许本机绝对 unix:// socket
 *   AGENT_EXECUTION_OCI_NAMESPACE required+OCI 的稳定部署分区，用于 durable lease/reaper
 *   AGENT_UI_SSE_HEARTBEAT_MS  SSE 心跳间隔，默认 15000ms
 *   AGENT_UI_SHUTDOWN_TIMEOUT_MS 关停清理窗口，默认 15000ms
 *   AGENT_UI_WORKDIR       默认工作目录（工具圈禁根），默认 process.cwd()
 *   AGENT_UI_WORKDIRS      逐 run 可选的工作目录白名单（路径分隔符分隔）。
 *                          workdir 同时是工具的写入圈禁边界,所以合法集合由宿主
 *                          在这里声明,浏览器只能在其中选——不给自由输入框
 *   AGENT_VERIFIER_MODEL   可选,独立核查模型（+ _PROVIDER / _BASE_URL / _API_KEY）
 *   AGENT_PLANNER_MODEL    可选,独立 planner 模型（同上一组后缀）
 *                          密钥只在服务端解析,不下发浏览器
 *   AGENT_PACK / AGENT_PRESET  领域包
 *   其余 AGENT_* 旋钮见 src/cli.ts 头部注释
 *
 * 默认只绑 127.0.0.1。非 loopback 不再只打印 warning：缺少强令牌或 TLS 边界会
 * fail-closed；即使满足二者，也默认从工具面移除 bash。
 */
import { delimiter } from "node:path";
import { createUiServer } from "./server.js";
import { accessHintLine, resolveUiLaunchPolicy } from "./production.js";
import { warnEnvConflicts } from "../src/env-check.js";
import { configuredExecutionStatus } from "../src/execution-broker.js";

// 桌面壳（cross-app/electron）用 ELECTRON_RUN_AS_NODE=1 拉起本进程；这个变量
// 不该再透传给 bash 工具的子命令——否则 agent 在 bash 里启动任何 Electron 系
// 可执行文件都会退化成纯 Node 跑其入口脚本。tsx 的自我重生发生在本文件之前，
// 此处删除对启动路径无影响。
delete process.env.ELECTRON_RUN_AS_NODE;

// .env 被残留环境变量压掉时大声说出来——那可能意味着凭据被发往另一家端点
warnEnvConflicts();

const port = Number(process.env.AGENT_UI_PORT ?? process.env.PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid AGENT_UI_PORT/PORT: ${process.env.AGENT_UI_PORT ?? process.env.PORT}`);
}
const policy = resolveUiLaunchPolicy();
const configuredExecution = configuredExecutionStatus(process.env, "process");
const host = policy.host;
const packName = process.env.AGENT_PACK ?? process.env.AGENT_PRESET;

const workdirs = (process.env.AGENT_UI_WORKDIRS ?? "")
  .split(delimiter)
  .map((d) => d.trim())
  .filter(Boolean);

const handle = createUiServer({
  ...(packName ? { packName } : {}),
  workdir: process.env.AGENT_UI_WORKDIR ?? process.cwd(),
  ...(workdirs.length ? { workdirs } : {}),
  ...(policy.accessToken ? { accessToken: policy.accessToken } : {}),
  ...(policy.allowedOrigins.length ? { allowedOrigins: policy.allowedOrigins } : {}),
  ...(policy.allowedHosts.length ? { allowedHosts: policy.allowedHosts } : {}),
  enableBash: policy.enableBash,
  trustProxy: policy.trustProxy,
});

handle.server.listen(port, host, () => {
  const localUrl = `http://${host}:${port}`;
  console.log(`Harness UI → ${localUrl}`);
  console.log(`  workdir: ${process.env.AGENT_UI_WORKDIR ?? process.cwd()}`);
  console.log(`  pack:    ${packName ?? "(none)"}`);
  console.log(`  auth:    ${policy.accessToken ? "token" : "loopback origin boundary"}`);
  console.log(`  bash:    ${policy.enableBash ? "enabled" : "disabled"}`);
  if (policy.enableBash) {
    console.log(
      `  execution: requested=${configuredExecution.requestedMode}/${configuredExecution.requestedBackend} ` +
      `(effective readiness waits for the functional probe)`,
    );
  }
  if (workdirs.length) console.log(`  可选工作目录: ${workdirs.join(" | ")}`);
  for (const role of ["VERIFIER", "PLANNER"] as const) {
    const m = process.env[`AGENT_${role}_MODEL`];
    if (m) console.log(`  ${role.toLowerCase()} model: ${m}`);
  }
  // 令牌本体不进 stdout（占位符引导，见 accessHintLine 的注释）
  const hint = accessHintLine(policy, localUrl);
  if (hint) console.log(`  open:    ${hint}`);
  if (policy.remote) {
    console.log(`  remote boundary: ${policy.trustProxy ? "trusted TLS proxy" : "insecure HTTP explicitly acknowledged"}`);
  }
});

handle.server.on("error", (err) => {
  console.error(`UI server failed: ${err.message}`);
  process.exit(1);
});

let closing = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    void handle.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

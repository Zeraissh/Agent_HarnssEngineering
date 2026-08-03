/**
 * 本地离线端点冒烟：证明"本地 Anthropic 兼容路径（Ollama）还活着"，仅此而已。
 *
 * 背景（2026-08-02 决策）：本地 qwen 已从研究序列退役——研究要的是"弱模型"
 * 而非"本地模型"，弱执行者实验改用云端小模型（SiliconFlow/DashScope 的 qwen
 * 阶梯，lab 里配 profile 即可）。本地端点只保留离线/隐私路径的存在性验证：
 * 大版本发布前跑一次本命令，通过即可，不追求速度。
 *
 * 用法：npm run smoke:local   （需本地 Ollama 在 11434 端口运行）
 * 可用 AGENT_MODEL 覆盖模型名；其余本地慢速模型防护参数已内置默认值。
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { AgentLoop } from "../src/loop.js";
import { createModelClientFromEnv } from "../src/provider.js";
import { writeFileTool } from "../src/tools/write-file.js";

// 离线冒烟【强制】指向本地——无视环境里的云端配置（否则冒的就不是本地的烟）。
// 需要改动时用 SMOKE_* 专用变量，不复用 AGENT_*/ANTHROPIC_* 以免互相劫持。
process.env["ANTHROPIC_BASE_URL"] = process.env["SMOKE_BASE_URL"] ?? "http://localhost:11434";
process.env["ANTHROPIC_API_KEY"] = process.env["SMOKE_API_KEY"] ?? "ollama";
process.env["AGENT_TIMEOUT_MS"] = process.env["SMOKE_TIMEOUT_MS"] ?? "180000";
process.env["AGENT_MAX_RETRIES"] = "0";
delete process.env["AGENT_PROVIDER"]; // 本地走 Anthropic 兼容协议

const model = process.env["SMOKE_MODEL"] ?? "qwen3.5:9b";

async function main(): Promise<void> {
  const workdir = process.cwd();
  await rm(path.join(workdir, "eval-out"), { recursive: true, force: true });
  await mkdir(path.join(workdir, "eval-out"), { recursive: true });

  const { client, compat } = createModelClientFromEnv(model);
  const loop = new AgentLoop(
    {
      systemPrompt: "You are a minimal smoke-test agent. Do exactly what is asked, then stop.",
      tools: [writeFileTool],
      workdir,
      compat,
      maxTurns: 4,
      maxTokens: 1024,
    },
    client,
  );

  console.log(`smoke:local — ${model} @ ${process.env["ANTHROPIC_BASE_URL"]}`);
  const started = Date.now();
  for await (const event of loop.run("在 eval-out/smoke-local.txt 中写入一行内容：local ok")) {
    if (event.type === "approval_request") event.respond("allow");
    if (event.type === "tool_call") console.log(`  → ${event.name}`);
    if (event.type === "done" && event.result.stopReason !== "completed") {
      console.error(`✘ run 未完成: ${event.result.stopReason} ${event.result.error?.message ?? ""}`);
      process.exit(1);
    }
  }

  const text = await readFile(path.join(workdir, "eval-out/smoke-local.txt"), "utf8").catch(() => "");
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (text.trim() === "local ok") {
    console.log(`✔ 本地端点存活（${secs}s）——离线路径验证通过`);
  } else {
    console.error(`✘ 产物不符: ${JSON.stringify(text.slice(0, 40))}（${secs}s）`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("✘ 冒烟失败：", err instanceof Error ? err.message : String(err));
  console.error("  （Ollama 是否在运行？ollama serve / 检查 11434 端口）");
  process.exit(1);
});

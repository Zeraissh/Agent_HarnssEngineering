/**
 * CLI 宿主：事件流的一个消费者示例。
 * 用法：npx tsx src/cli.ts "任务描述" [--yes] [--verify]
 *   --yes     自动批准所有审批请求（非交互环境/CI 用；交互终端下走 y/n 提示）
 *   --verify  完成后由 verifier 子代理独立核查，未通过自动返工一轮
 *
 * 环境变量：
 *   ANTHROPIC_API_KEY   API 密钥（Anthropic 或第三方兼容端点的 key）
 *   ANTHROPIC_BASE_URL  可选，第三方 Anthropic 兼容端点（DeepSeek/GLM/Kimi 等）
 *   AGENT_MODEL         可选，模型名，默认 claude-opus-4-8；
 *                       非 claude-* 模型自动进入 compat 模式（去掉 Claude 专属参数）
 *   AGENT_CONTEXT_LIMIT 可选，上下文 token 上限（触发 compact），默认 150000
 *   AGENT_MAX_TOKENS    可选，单次响应输出上限，默认 64000。本地慢速模型建议调低
 *                       （如 4096）以掐断思考螺旋——快速失败优于无限等待
 *   AGENT_TIMEOUT_MS    可选，单请求超时毫秒数，默认 SDK 的 10 分钟
 *   AGENT_MAX_RETRIES   可选，超时/5xx 重试次数，默认 SDK 的 2
 */
import path from "node:path";
import readline from "node:readline/promises";
import Anthropic from "@anthropic-ai/sdk";
import { AgentLoop } from "./loop.js";
import { createMemoryTools, MemoryStore } from "./memory.js";
import { AnthropicModelClient } from "./model-client.js";
import { runVerified } from "./orchestrate.js";
import { bashTool } from "./tools/bash.js";
import { fetchUrlTool } from "./tools/fetch-url.js";
import { readFileTool } from "./tools/read-file.js";
import { writeFileTool } from "./tools/write-file.js";
import type { AgentConfig, TurnEvent } from "./types.js";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

const SYSTEM_PROMPT = `You are a capable autonomous agent operating in a local working directory.
Complete the user's task end to end using the available tools.
Ground every claim of progress in an actual tool result. When the task is done, summarize what you did in one or two sentences.
Keep file outputs clean and well-structured. Respond in the language the user used.

You have a persistent memory that survives across sessions. The current memory index is provided in the <context> block of the first message. Consult relevant memories (memory_read) before starting work. When you learn a durable fact, user preference, or lesson worth reusing — a correction you received, a project constant, an approach that worked — save it with memory_write (one fact per file, first line = summary). Update or delete memories that turn out to be wrong. Do not store transient task state or things already recorded in the repository.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const autoYes = args.includes("--yes");
  const withVerify = args.includes("--verify");
  const task = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!task) {
    console.error('Usage: npx tsx src/cli.ts "task description" [--yes] [--verify]');
    process.exit(1);
  }

  const model = process.env.AGENT_MODEL ?? "claude-opus-4-8";
  const compat = !model.startsWith("claude");
  if (compat) {
    console.log(
      c.dim(
        `compat mode: model=${model}${process.env.ANTHROPIC_BASE_URL ? ` via ${process.env.ANTHROPIC_BASE_URL}` : ""} (thinking/effort/cache_control disabled)`,
      ),
    );
  }

  const contextTokenLimit = process.env.AGENT_CONTEXT_LIMIT
    ? Number(process.env.AGENT_CONTEXT_LIMIT)
    : undefined;
  const maxTokens = process.env.AGENT_MAX_TOKENS ? Number(process.env.AGENT_MAX_TOKENS) : undefined;
  const timeoutMs = process.env.AGENT_TIMEOUT_MS ? Number(process.env.AGENT_TIMEOUT_MS) : undefined;
  const maxRetries = process.env.AGENT_MAX_RETRIES ? Number(process.env.AGENT_MAX_RETRIES) : undefined;

  // 跨会话记忆（L5）：默认 <cwd>/.agent-memory，可用 AGENT_MEMORY_DIR 覆盖
  const memory = new MemoryStore(
    process.env.AGENT_MEMORY_DIR ?? path.join(process.cwd(), ".agent-memory"),
  );

  const config: AgentConfig = {
    systemPrompt: SYSTEM_PROMPT,
    tools: [bashTool, fetchUrlTool, readFileTool, writeFileTool, ...createMemoryTools(memory)],
    workdir: process.cwd(),
    compat,
    contextTokenLimit,
    maxTokens,
    // 易变信息走 messages 注入（P3），system prompt 保持字节冻结
    dynamicContext: {
      date: new Date().toISOString().slice(0, 10),
      platform: process.platform,
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      workdir: process.cwd(),
      memory_index: await memory.indexBlock(),
    },
  };
  const modelClient = new AnthropicModelClient(
    model,
    timeoutMs !== undefined || maxRetries !== undefined
      ? new Anthropic({
          ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
          ...(maxRetries !== undefined ? { maxRetries } : {}),
        })
      : undefined,
  );

  const rl = autoYes ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  let streamingText = false;
  const endStreamLine = () => {
    if (streamingText) {
      process.stdout.write("\n");
      streamingText = false;
    }
  };

  if (withVerify) {
    const outcome = await runVerified(config, modelClient, task, {
      onEvent: async (source, event) => {
        if (source === "verifier") {
          if (event.type === "assistant_text") console.log(c.yellow(event.text));
          return;
        }
        if (source === "rework" && event.type === "turn_start" && event.turn === 1) {
          console.log(c.yellow("\n↺ 核查未通过，开始返工…"));
        }
        await renderEvent(event);
      },
    });
    const v = outcome.verifications.at(-1)?.verdict;
    const tag = outcome.finalPassed ? c.green("✔ 核查通过") : c.red("✘ 核查未通过");
    console.log(`\n${tag}${outcome.reworks ? c.dim(`（返工 ${outcome.reworks} 轮）`) : ""}`);
    if (v && !outcome.finalPassed) for (const issue of v.issues) console.log(c.red(`  - ${issue}`));
  } else {
    const loop = new AgentLoop(config, modelClient);
    for await (const event of loop.run(task)) {
      await renderEvent(event);
    }
  }
  rl?.close();

  async function renderEvent(event: TurnEvent): Promise<void> {
    switch (event.type) {
      case "turn_start":
        endStreamLine();
        console.log(c.dim(`─── turn ${event.turn} ───`));
        break;
      case "text_delta":
        streamingText = true;
        process.stdout.write(event.text);
        break;
      case "assistant_text":
        endStreamLine(); // 完整文本已通过 delta 流式输出过，这里只收行
        break;
      case "tool_call":
        endStreamLine();
        console.log(`${c.cyan("→ tool")} ${event.name} ${c.dim(JSON.stringify(event.input))}`);
        break;
      case "tool_result": {
        const head = event.result.content.split("\n")[0] ?? "";
        const preview = head.length > 120 ? `${head.slice(0, 120)}…` : head;
        const tag = event.result.isError ? c.red("✗") : c.green("✓");
        console.log(`${tag} ${c.dim(`${event.durationMs}ms`)} ${preview}`);
        break;
      }
      case "approval_request": {
        endStreamLine();
        if (autoYes || !rl) {
          console.log(c.yellow(`⚠ auto-approved: ${event.name} ${JSON.stringify(event.input)}`));
          event.respond("allow");
          break;
        }
        const answer = await rl.question(
          c.yellow(`⚠ approve ${event.name} ${JSON.stringify(event.input)}? [y/N] `),
        );
        if (answer.trim().toLowerCase() === "y") {
          event.respond("allow");
        } else {
          const reason = await rl.question(c.dim("  reason for the model (optional): "));
          event.respond("deny", reason.trim() || undefined);
        }
        break;
      }
      case "usage":
        console.log(
          c.dim(
            `  tokens: in=${event.usage.input_tokens} cacheW=${event.usage.cache_creation_input_tokens ?? 0} cacheR=${event.usage.cache_read_input_tokens ?? 0} out=${event.usage.output_tokens}`,
          ),
        );
        break;
      case "compaction":
        console.log(c.yellow(`⚠ context compacted: dropped ${event.droppedBlocks} blocks`));
        break;
      case "done": {
        endStreamLine();
        const u = event.result.usage;
        const color = event.result.stopReason === "completed" ? c.green : c.red;
        console.log(color(`\n■ ${event.result.stopReason}`) + c.dim(` (${u.turns} turns)`));
        console.log(
          c.dim(
            `  total: in=${u.inputTokens} cacheW=${u.cacheCreationTokens} cacheR=${u.cacheReadTokens} out=${u.outputTokens} | cacheHit=${(u.cacheHitRatio * 100).toFixed(1)}%`,
          ),
        );
        if (event.result.error) console.error(c.red(`  error: ${event.result.error.message}`));
        break;
      }
    }
  }
}

main().catch((err) => {
  console.error(c.red(err instanceof Error ? err.stack ?? err.message : String(err)));
  process.exit(1);
});

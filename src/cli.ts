/**
 * CLI 宿主：事件流的一个消费者示例。
 * 用法：npx tsx src/cli.ts "任务描述" [--yes]
 *   --yes  自动批准所有审批请求（非交互环境/CI 用；交互终端下走 y/n 提示）
 *
 * 环境变量：
 *   ANTHROPIC_API_KEY   API 密钥（Anthropic 或第三方兼容端点的 key）
 *   ANTHROPIC_BASE_URL  可选，第三方 Anthropic 兼容端点（DeepSeek/GLM/Kimi 等）
 *   AGENT_MODEL         可选，模型名，默认 claude-opus-4-8；
 *                       非 claude-* 模型自动进入 compat 模式（去掉 Claude 专属参数）
 *   AGENT_CONTEXT_LIMIT 可选，上下文 token 上限（触发 compact），默认 150000
 */
import readline from "node:readline/promises";
import { AgentLoop } from "./loop.js";
import { AnthropicModelClient } from "./model-client.js";
import { bashTool } from "./tools/bash.js";
import { readFileTool } from "./tools/read-file.js";
import { writeFileTool } from "./tools/write-file.js";
import type { TurnEvent } from "./types.js";

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
Keep file outputs clean and well-structured. Respond in the language the user used.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const autoYes = args.includes("--yes");
  const task = args.filter((a) => a !== "--yes").join(" ").trim();
  if (!task) {
    console.error('Usage: npx tsx src/cli.ts "task description" [--yes]');
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

  const loop = new AgentLoop(
    {
      systemPrompt: SYSTEM_PROMPT,
      tools: [bashTool, readFileTool, writeFileTool],
      workdir: process.cwd(),
      compat,
      contextTokenLimit,
      // 易变信息走 messages 注入（P3），system prompt 保持字节冻结
      dynamicContext: {
        date: new Date().toISOString().slice(0, 10),
        platform: process.platform,
        shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
        workdir: process.cwd(),
      },
    },
    new AnthropicModelClient(model),
  );

  const rl = autoYes ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  let streamingText = false;
  const endStreamLine = () => {
    if (streamingText) {
      process.stdout.write("\n");
      streamingText = false;
    }
  };

  for await (const event of loop.run(task)) {
    await renderEvent(event);
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

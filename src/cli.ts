/**
 * CLI 宿主：事件流的一个消费者示例。
 * 用法：npx tsx src/cli.ts "任务描述" [--yes] [--verify] [--plan [--parallel[=N]]] [--auto]
 *   --yes       自动批准所有审批请求（非交互环境/CI 用；交互终端下走 y/n 提示）
 *   --verify    完成后由 verifier 子代理独立核查，未通过自动返工一轮
 *   --plan      三角编排：planner 拆解子任务（自选领域包+依赖图）→ 执行→核查→交接；
 *               互不依赖的子任务默认并发执行（并行度 auto = min(3, 计划层宽)）
 *   --parallel=N  显式并行度覆盖 auto；=1 退回全串行
 *   --auto      调度单元路由领域包（单领域任务免手选；显式 AGENT_PACK 优先）
 *
 * 环境变量：
 *   AGENT_PROVIDER      anthropic（默认）| openai —— 选择 wire 协议
 *   ANTHROPIC_API_KEY   API 密钥（Anthropic 或第三方兼容端点的 key）
 *   ANTHROPIC_BASE_URL  可选，第三方 Anthropic 兼容端点（DeepSeek/GLM/Kimi/Ollama）
 *   OPENAI_BASE_URL     provider=openai 时的端点（如 https://api.deepseek.com）
 *   OPENAI_API_KEY      provider=openai 时的 key，缺省复用 ANTHROPIC_API_KEY
 *   AGENT_MODEL         可选，模型名，默认 claude-opus-4-8；
 *                       非 claude-* 模型自动进入 compat 模式（去掉 Claude 专属参数）
 *   AGENT_VERIFIER_MODEL 可选，--verify 时 verifier 用的独立模型（应 ≥ 执行者强度）；
 *                       配套 AGENT_VERIFIER_PROVIDER / _BASE_URL / _API_KEY 可指向
 *                       不同端点，缺省沿用执行者的端点配置
 *   AGENT_PACK          可选，领域包名（stm32-coding / stm32-debug）：覆盖 system
 *                       prompt、内置工具面、MCP 接入与白名单、验证策略、护栏参数。
 *                       AGENT_PRESET 为兼容别名
 *   AGENT_READ_ROOTS    可选，额外只读根（分号/路径分隔符分隔的绝对路径）：
 *                       read_file 可读取这些目录（写类工具不受益）。用于工作区外的
 *                       领域素材库（如 KiCad 官方符号/封装库）
 *   AGENT_CONTEXT_LIMIT 可选，上下文 token 上限（触发 compact），默认 150000
 *   AGENT_MAX_TOKENS    可选，单次响应输出上限，默认 64000。本地慢速模型建议调低
 *                       （如 4096）以掐断思考螺旋——快速失败优于无限等待
 *   AGENT_TIMEOUT_MS    可选，单请求超时毫秒数，默认 SDK 的 10 分钟
 *   AGENT_MAX_RETRIES   可选，超时/5xx 重试次数，默认 SDK 的 2
 */
import path from "node:path";
import readline from "node:readline/promises";
import { AgentLoop } from "./loop.js";
import { connectMcpServers, loadMcpConfig } from "./mcp.js";
import { createMemoryTools, MemoryStore } from "./memory.js";
import { AUTO_CONCURRENCY_CAP, planParallelWidth, runPlanned, runVerified } from "./orchestrate.js";
import { getPack, PACKS, RULE_PRECEDENCE_DISCIPLINE, selectPackTools } from "./presets.js";
import { routeToPack } from "./router.js";
import { createModelClientFromEnv } from "./provider.js";
import { bashTool, SHELL_DESC } from "./tools/bash.js";
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
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

const SYSTEM_PROMPT = `You are a capable autonomous agent operating in a local working directory.
Complete the user's task end to end using the available tools.
Ground every claim of progress in an actual tool result. When the task is done, summarize what you did in one or two sentences.
Keep file outputs clean and well-structured. Respond in the language the user used.

You have a persistent memory that survives across sessions. The current memory index is provided in the <context> block of the first message. Consult relevant memories (memory_read) before starting work. When you learn a durable fact, user preference, or lesson worth reusing — a correction you received, a project constant, an approach that worked — save it with memory_write (one fact per file, first line = summary). Update or delete memories that turn out to be wrong. Do not store transient task state or things already recorded in the repository.` + RULE_PRECEDENCE_DISCIPLINE;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const autoYes = args.includes("--yes");
  const withPlan = args.includes("--plan");
  const withAuto = args.includes("--auto");
  // --parallel=N：--plan 的显式并行度。缺省 "auto" = min(3, 计划层宽)——
  // A/B 采纳（ab-report-parallel.md）：拆分率 ~50/50 下串行默认让一半 run 白付
  // 拆分成本；线性链 auto 自动退化为串行。--parallel=1 显式退回全串行。
  const parallelArg = args.find((a) => a === "--parallel" || a.startsWith("--parallel="));
  const concurrency: number | "auto" =
    parallelArg && parallelArg.includes("=")
      ? Math.max(1, Math.floor(Number(parallelArg.split("=")[1]) || 1))
      : "auto";
  const task = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!task) {
    console.error('Usage: npx tsx src/cli.ts "task description" [--yes] [--verify] [--plan [--parallel=N]] [--auto]');
    process.exit(1);
  }
  if (parallelArg && !withPlan) {
    console.error("--parallel 只对 --plan 生效（并行度是子任务调度的属性）");
    process.exit(1);
  }

  const model = process.env.AGENT_MODEL ?? "claude-opus-4-8";
  const { client: resolvedClient, provider, compat } = createModelClientFromEnv(model);

  // 领域包（可选）：AGENT_PACK 显式选用（AGENT_PRESET 为兼容别名）；
  // --auto 时由调度单元路由（显式 > 路由）；--plan 时忽略：包由 planner 按子任务选
  const packName = withPlan ? undefined : (process.env.AGENT_PACK ?? process.env.AGENT_PRESET);
  let pack = packName ? getPack(packName) : undefined;
  if (packName && !pack) {
    console.error(`Unknown pack "${packName}". Available: ${Object.keys(PACKS).join(", ")}`);
    process.exit(1);
  }
  if (withAuto && !pack && !withPlan) {
    const route = await routeToPack(
      { systemPrompt: SYSTEM_PROMPT, tools: [], workdir: process.cwd(), compat },
      resolvedClient,
      task,
      Object.values(PACKS),
    );
    if (route.decision.pack) {
      pack = getPack(route.decision.pack);
      console.log(c.dim(`pack(auto): ${route.decision.pack} — ${route.decision.reason}`));
    } else {
      console.log(c.dim(`pack(auto): 不选包 — ${route.decision.reason}`));
      if (/--plan|计划单元|跨领域/.test(route.decision.reason)) {
        console.log(c.yellow("提示：router 判断这是跨领域任务，用 --plan 交给三角编排更合适。"));
      }
    }
  }
  if (pack) {
    console.log(c.dim(`pack: ${pack.name} (verify=${pack.verify.enabled}/${pack.verify.mode}) — ${pack.description}`));
  }
  // --verify 手动开启，或领域包自动开启
  const withVerify = args.includes("--verify") || pack?.verify.enabled === true;

  // --verify 时可选的独立 verifier 模型（核查者应 ≥ 执行者强度）
  const verifierModelName = process.env.AGENT_VERIFIER_MODEL;
  const verifierProvider = verifierModelName
    ? createModelClientFromEnv(verifierModelName, {
        ...(process.env.AGENT_VERIFIER_PROVIDER
          ? { provider: process.env.AGENT_VERIFIER_PROVIDER as "anthropic" | "openai" }
          : {}),
        ...(process.env.AGENT_VERIFIER_BASE_URL
          ? { baseURL: process.env.AGENT_VERIFIER_BASE_URL }
          : {}),
        ...(process.env.AGENT_VERIFIER_API_KEY
          ? { apiKey: process.env.AGENT_VERIFIER_API_KEY }
          : {}),
      })
    : undefined;
  if (withVerify && verifierProvider) {
    console.log(c.dim(`verifier model: ${verifierModelName}`));
  }

  // --plan 时可选的独立 planner 模型（拆分决策摇摆的稳定化杆,镜像 verifier 组）
  const plannerModelName = process.env.AGENT_PLANNER_MODEL;
  const plannerProvider = plannerModelName
    ? createModelClientFromEnv(plannerModelName, {
        ...(process.env.AGENT_PLANNER_PROVIDER
          ? { provider: process.env.AGENT_PLANNER_PROVIDER as "anthropic" | "openai" }
          : {}),
        ...(process.env.AGENT_PLANNER_BASE_URL
          ? { baseURL: process.env.AGENT_PLANNER_BASE_URL }
          : {}),
        ...(process.env.AGENT_PLANNER_API_KEY
          ? { apiKey: process.env.AGENT_PLANNER_API_KEY }
          : {}),
      })
    : undefined;
  if (withPlan && plannerProvider) {
    console.log(c.dim(`planner model: ${plannerModelName}`));
  }
  // AGENT_PLAN_PROTOCOL=structured：枚举与决策分离的结构化拆分协议（默认 freeform）
  const planProtocol =
    process.env.AGENT_PLAN_PROTOCOL === "structured" ? ("structured" as const) : ("freeform" as const);
  if (withPlan && planProtocol === "structured") {
    console.log(c.dim("plan protocol: structured（分片枚举 + 宿主规则判拆）"));
  }
  if (compat) {
    const base =
      provider === "openai"
        ? (process.env.OPENAI_BASE_URL ?? "api.openai.com")
        : (process.env.ANTHROPIC_BASE_URL ?? "");
    console.log(
      c.dim(
        `compat mode [${provider}]: model=${model}${base ? ` via ${base}` : ""} (thinking/effort/cache_control disabled)`,
      ),
    );
  }

  // 护栏参数优先级：显式 env > 领域包默认 > 全局默认
  const contextTokenLimit = process.env.AGENT_CONTEXT_LIMIT
    ? Number(process.env.AGENT_CONTEXT_LIMIT)
    : pack?.guardrails?.contextTokenLimit;
  const maxTokens = process.env.AGENT_MAX_TOKENS
    ? Number(process.env.AGENT_MAX_TOKENS)
    : pack?.guardrails?.maxTokens;
  const maxTurns = pack?.guardrails?.maxTurns;

  // 跨会话记忆（L5）：默认 <cwd>/.agent-memory，可用 AGENT_MEMORY_DIR 覆盖
  const memory = new MemoryStore(
    process.env.AGENT_MEMORY_DIR ?? path.join(process.cwd(), ".agent-memory"),
  );

  // MCP 工具（可选）：./mcp.json 存在即连接，AGENT_MCP_CONFIG 覆盖路径；
  // 领域包可整体关闭（mcp: false）或覆盖各 server 的工具白名单/审批策略
  const mcpConfig =
    pack?.mcp === false
      ? undefined
      : await loadMcpConfig(process.env.AGENT_MCP_CONFIG ?? path.join(process.cwd(), "mcp.json"));
  if (mcpConfig && pack && typeof pack.mcp === "object") {
    for (const server of Object.values(mcpConfig.servers)) {
      if (pack.mcp.includeTools) server.includeTools = pack.mcp.includeTools;
      if (pack.mcp.permission) server.permission = pack.mcp.permission;
    }
  }
  const mcp = mcpConfig ? await connectMcpServers(mcpConfig, (m) => console.warn(c.yellow(m))) : undefined;
  if (mcp) {
    for (const [server, count] of Object.entries(mcp.summary)) {
      console.log(c.dim(`mcp: connected "${server}" (${count} tools)`));
    }
  }

  // 内置工具按包名单装配（缺省全带）——领域包只带用得上的，减少触发面噪声
  const builtinByName = new Map(
    [bashTool, fetchUrlTool, readFileTool, writeFileTool].map((t) => [t.name, t]),
  );
  const builtinNames = pack?.builtinTools ?? [...builtinByName.keys()];
  const builtins = builtinNames.map((n) => {
    const t = builtinByName.get(n);
    if (!t) throw new Error(`Pack "${pack?.name}" 声明了未知内置工具: ${n}`);
    return t;
  });

  // 额外只读根：AGENT_READ_ROOTS（path.delimiter 分隔），read_file 专享
  const readRoots = (process.env.AGENT_READ_ROOTS ?? "")
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);

  const memTools = createMemoryTools(memory);
  const config: AgentConfig = {
    systemPrompt: pack?.systemPrompt ?? SYSTEM_PROMPT,
    tools: [...builtins, ...memTools, ...(mcp?.tools ?? [])],
    workdir: process.cwd(),
    ...(readRoots.length ? { readRoots } : {}),
    compat,
    contextTokenLimit,
    maxTokens,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    // 易变信息走 messages 注入（P3），system prompt 保持字节冻结
    dynamicContext: {
      date: new Date().toISOString().slice(0, 10),
      platform: process.platform,
      shell: SHELL_DESC,
      workdir: process.cwd(),
      ...(readRoots.length ? { read_only_roots: readRoots.join("; ") } : {}),
      memory_index: await memory.indexBlock(),
    },
  };
  const modelClient = resolvedClient;

  const rl = autoYes ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  let streamingText = false;
  const endStreamLine = () => {
    if (streamingText) {
      process.stdout.write("\n");
      streamingText = false;
    }
  };

  // 裁决信号浮出（案例 #1 改进项）：boot_count 规格 bug 曾藏在 passed=true 的
  // 裁决 summary 里——宿主只看布尔就会漏。最终结果块无论通过与否都展示
  // summary 与 issues（通过时 issues 以 ⚠ 警示色呈现,是"通过但有话要说"的信号）。
  // 三值裁决扩展（案例 #6 → rubric-verifier）：unverified=查不了移交委托方,
  // advisory=主观意见——两者都不影响 passed,但必须站上决策面。
  const printVerdictSignal = (
    indent: string,
    finalPassed: boolean,
    verdict: { summary: string; issues: string[]; unverified?: string[]; advisory?: string[] } | undefined,
  ): void => {
    if (!verdict) return;
    if (verdict.summary) console.log(c.magenta(`${indent}[verifier] ${verdict.summary}`));
    for (const issue of verdict.issues) {
      console.log(finalPassed ? c.yellow(`${indent}⚠ ${issue}`) : c.red(`${indent}- ${issue}`));
    }
    for (const item of verdict.unverified ?? []) console.log(c.yellow(`${indent}⋯ 待委托方复核: ${item}`));
    for (const item of verdict.advisory ?? []) console.log(c.magenta(`${indent}◈ 评审意见: ${item}`));
  };

  // verifier 过程渲染：洋红色 [verifier] 前缀，与主 agent 视觉区分
  let verifierStarted = false;
  const renderVerifierEvent = (event: TurnEvent) => {
    if (!verifierStarted) {
      endStreamLine();
      console.log(c.magenta("\n╔══ verifier 独立复核（全新上下文，自己重读硬件）══"));
      verifierStarted = true;
    }
    switch (event.type) {
      case "tool_call":
        console.log(
          `${c.magenta("║ →")} ${event.name} ${c.dim(JSON.stringify(event.input))}`,
        );
        break;
      case "tool_result": {
        const head = (event.result.content.split("\n")[0] ?? "").slice(0, 100);
        console.log(`${c.magenta("║")} ${event.result.isError ? c.red("✗") : c.green("✓")} ${c.dim(head)}`);
        break;
      }
      case "assistant_text":
        // 裁决摘要（orchestrate 单独补发的那条 [verifier] passed=...）
        if (event.text.startsWith("[verifier]")) console.log(c.magenta(`╚══ ${event.text}`));
        break;
      default:
        break;
    }
  };

  if (withPlan) {
    // 三角编排：planner 拆解 → 逐子任务(执行→核查→返工) → 交接下游
    const builtinPool = [bashTool, fetchUrlTool, readFileTool, writeFileTool];
    const mcpPool = mcp?.tools ?? [];
    let currentStep = "";
    let planRef: Awaited<ReturnType<typeof runPlanned>>["plan"];

    // 并行模式（concurrency>1）的行级渲染：事件交错到达，流式 delta 会打架——
    // 改为每事件一行 + [子任务/角色] 前缀；审批仍走完整问答（已被编排层串行化）
    const renderParallelEvent = async (source: string, event: TurnEvent): Promise<void> => {
      const isVerifier = source.endsWith("/verifier");
      const tag = isVerifier ? c.magenta(`[${source}]`) : c.cyan(`[${source}]`);
      switch (event.type) {
        case "turn_start":
          if (event.turn === 1 && source.endsWith("/rework"))
            console.log(c.yellow(`${tag} ↺ 核查未通过，返工…`));
          break;
        case "tool_call":
          console.log(`${tag} → ${event.name} ${c.dim(JSON.stringify(event.input).slice(0, 160))}`);
          break;
        case "tool_result": {
          const head = (event.result.content.split("\n")[0] ?? "").slice(0, 100);
          console.log(`${tag} ${event.result.isError ? c.red("✗") : c.green("✓")} ${c.dim(head)}`);
          break;
        }
        case "assistant_text": {
          const text = event.text.length > 500 ? `${event.text.slice(0, 500)}…` : event.text;
          if (text) console.log(`${tag} ${text}`);
          break;
        }
        case "approval_request": {
          if (isVerifier) break; // verifier 审批由其内部自答，仅供观察，不提示
          if (autoYes || !rl) {
            console.log(c.yellow(`${tag} ⚠ auto-approved: ${event.name} ${JSON.stringify(event.input)}`));
            event.respond("allow");
            break;
          }
          const answer = await rl.question(
            c.yellow(`${tag} ⚠ approve ${event.name} ${JSON.stringify(event.input)}? [y/N] `),
          );
          if (answer.trim().toLowerCase() === "y") event.respond("allow");
          else event.respond("deny", (await rl.question(c.dim("  reason (optional): "))).trim() || undefined);
          break;
        }
        case "compaction":
          console.log(c.yellow(`${tag} ⚠ context compacted: dropped ${event.droppedBlocks} blocks`));
          break;
        case "api_retry":
          console.log(c.yellow(`${tag} ⟳ API 瞬时错误，同轮重试 #${event.attempt}`));
          break;
        case "done": {
          const u = event.result.usage;
          console.log(
            `${tag} ■ ${event.result.stopReason} ${c.dim(`(${u.turns} turns, in=${u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens} out=${u.outputTokens})`)}`,
          );
          break;
        }
        default:
          break;
      }
    };

    const startedAt = Date.now();
    let planReadyAt = startedAt; // onPlan 时刻：并行节省只对子任务阶段计算，不混入 planner 耗时
    // auto 并行度在计划就绪时才能解析（依赖计划层宽）；渲染模式随之切换
    let effectiveConcurrency = typeof concurrency === "number" ? concurrency : 1;
    const outcome = await runPlanned(config, modelClient, task, {
      packs: Object.values(PACKS),
      concurrency,
      plannerProtocol: planProtocol,
      ...(plannerProvider
        ? { plannerModel: { client: plannerProvider.client, compat: plannerProvider.compat } }
        : {}),
      onPlan: (plan) => {
        planRef = plan;
        planReadyAt = Date.now();
        if (concurrency === "auto") {
          effectiveConcurrency = Math.min(AUTO_CONCURRENCY_CAP, planParallelWidth(plan.subtasks));
        }
        endStreamLine();
        console.log(
          c.cyan(
            `\n═══ 计划${effectiveConcurrency > 1 ? c.dim(`（并行度 ${effectiveConcurrency}${concurrency === "auto" ? " auto" : ""}）`) : ""} ═══`,
          ),
        );
        for (const s of plan.subtasks) {
          const deps = s.dependsOn.length > 0 ? c.dim(` ⇐ ${s.dependsOn.join(",")}`) : "";
          console.log(`${c.cyan(s.id)} ${s.title}${s.pack ? c.dim(` [pack: ${s.pack}]`) : ""}${deps}`);
          for (const a of s.acceptance) console.log(c.dim(`    验收: ${a}`));
        }
      },
      resolveSubtask: (sub) => {
        const p = sub.pack ? getPack(sub.pack) : undefined;
        if (sub.pack && !p) console.log(c.yellow(`⚠ 未知领域包 "${sub.pack}"，子任务 ${sub.id} 用默认配置执行`));
        return {
          cfg: {
            ...config,
            systemPrompt: p?.systemPrompt ?? SYSTEM_PROMPT,
            tools: [...selectPackTools(p, builtinPool, mcpPool), ...memTools],
            ...(p?.guardrails?.maxTurns !== undefined ? { maxTurns: p.guardrails.maxTurns } : {}),
            ...(p?.guardrails?.maxTokens !== undefined && !process.env.AGENT_MAX_TOKENS
              ? { maxTokens: p.guardrails.maxTokens }
              : {}),
          },
          verify: {
            ...(p?.verify.instructions ? { verifyInstructions: p.verify.instructions } : {}),
            ...(p?.verify.readOnlyCommands ? { verifyReadOnlyCommands: p.verify.readOnlyCommands } : {}),
            ...(p?.verify.rubric ? { verifyRubric: p.verify.rubric } : {}),
            ...(verifierProvider
              ? { verifierModel: { client: verifierProvider.client, compat: verifierProvider.compat } }
              : {}),
          },
          // 独占资源（如 swd-probe）：调度器对同标签子任务强制串行
          ...(p?.resources ? { resources: p.resources } : {}),
        };
      },
      onEvent: async (source, event) => {
        if (effectiveConcurrency > 1 && source !== "planner") {
          await renderParallelEvent(source, event);
          return;
        }
        const stepId = source.split("/")[0]!;
        if (stepId !== currentStep) {
          currentStep = stepId;
          endStreamLine();
          if (stepId === "planner") {
            console.log(c.cyan("\n━━━ 计划单元（planner，只读拆解）━━━"));
          } else {
            const sub = planRef?.subtasks.find((s) => s.id === stepId);
            console.log(
              c.cyan(`\n━━━ 子任务 ${stepId}${sub ? `：${sub.title}` : ""}${sub?.pack ? c.dim(` [pack: ${sub.pack}]`) : ""} ━━━`),
            );
          }
        }
        if (source.endsWith("/verifier")) {
          renderVerifierEvent(event);
          return;
        }
        if (source.endsWith("/rework") && event.type === "turn_start" && event.turn === 1) {
          console.log(c.yellow("\n↺ 核查未通过，开始返工…"));
        }
        await renderEvent(event);
      },
    });
    const totalWallMs = Date.now() - startedAt;
    const wallMs = Date.now() - planReadyAt; // 子任务阶段墙钟（排除 planner）
    console.log(c.cyan("\n═══ 三角编排结果 ═══"));
    if (!outcome.plan) {
      console.log(c.red(`✘ planner 未能产出可解析计划：${outcome.planOutcome.raw.slice(0, 200)}`));
    } else {
      for (const sub of outcome.plan.subtasks) {
        const step = outcome.steps.find((s) => s.sub.id === sub.id);
        const mark = !step
          ? c.dim("－ 跳过（依赖失败或调度停止）")
          : step.result.finalPassed
            ? c.green("✔ 通过")
            : c.red("✘ 未通过");
        const dur = step ? c.dim(` ${(step.durationMs / 1000).toFixed(1)}s`) : "";
        console.log(`${mark} ${sub.id} ${sub.title}${sub.pack ? c.dim(` [${sub.pack}]`) : ""}${dur}`);
        if (step) {
          printVerdictSignal("    ", step.result.finalPassed, step.result.verifications.at(-1)?.verdict);
        }
      }
      const serialMs = outcome.steps.reduce((acc, s) => acc + s.durationMs, 0);
      const wallNote = `全程 ${(totalWallMs / 1000).toFixed(1)}s，子任务阶段墙钟 ${(wallMs / 1000).toFixed(1)}s，子任务合计 ${(serialMs / 1000).toFixed(1)}s${effectiveConcurrency > 1 ? `，并行节省 ${Math.max(0, (serialMs - wallMs) / 1000).toFixed(1)}s` : ""}`;
      console.log(
        outcome.completed
          ? c.green(`\n✔ 全部子任务执行并核查通过`) + c.dim(`（${wallNote}）`)
          : c.red("\n✘ 编排未完成（快速失败）") + c.dim(`（${wallNote}）`),
      );
    }
  } else if (withVerify) {
    const outcome = await runVerified(config, modelClient, task, {
      ...(pack?.verify.instructions ? { verifyInstructions: pack.verify.instructions } : {}),
      ...(pack?.verify.readOnlyCommands ? { verifyReadOnlyCommands: pack.verify.readOnlyCommands } : {}),
      ...(pack?.verify.rubric ? { verifyRubric: pack.verify.rubric } : {}),
      ...(verifierProvider
        ? { verifierModel: { client: verifierProvider.client, compat: verifierProvider.compat } }
        : {}),
      onEvent: async (source, event) => {
        if (source === "verifier") {
          renderVerifierEvent(event);
          return;
        }
        if (source === "rework" && event.type === "turn_start" && event.turn === 1) {
          console.log(c.yellow("\n↺ 核查未通过，开始返工…"));
        }
        await renderEvent(event);
      },
    });
    const tag = outcome.finalPassed ? c.green("✔ 核查通过") : c.red("✘ 核查未通过");
    console.log(`\n${tag}${outcome.reworks ? c.dim(`（返工 ${outcome.reworks} 轮）`) : ""}`);
    printVerdictSignal("  ", outcome.finalPassed, outcome.verifications.at(-1)?.verdict);
  } else {
    const loop = new AgentLoop(config, modelClient);
    for await (const event of loop.run(task)) {
      await renderEvent(event);
    }
  }
  rl?.close();
  await mcp?.close();

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
      case "api_retry":
        endStreamLine();
        console.log(c.yellow(`⟳ API 瞬时错误，同轮重试 #${event.attempt}：${event.reason}`));
        break;
      case "compaction":
        console.log(c.yellow(`⚠ context compacted: dropped ${event.droppedBlocks} blocks`));
        break;
      case "done": {
        endStreamLine();
        const u = event.result.usage;
        const reason = event.result.stopReason;
        // completed = 绿；max_tokens = 黄（截断但已完成内容保留，非错误）；其余 = 红
        const color = reason === "completed" ? c.green : reason === "max_tokens" ? c.yellow : c.red;
        console.log(color(`\n■ ${reason}`) + c.dim(` (${u.turns} turns)`));
        console.log(
          c.dim(
            `  total: in=${u.inputTokens} cacheW=${u.cacheCreationTokens} cacheR=${u.cacheReadTokens} out=${u.outputTokens} | cacheHit=${(u.cacheHitRatio * 100).toFixed(1)}%`,
          ),
        );
        if (reason === "max_tokens") {
          console.log(
            c.yellow(
              `  末轮输出撞 max_tokens 被截断，已生成内容保留在结果中。若任务需要更长回复，提高 AGENT_MAX_TOKENS`,
            ),
          );
        }
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

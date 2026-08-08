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
 *   AGENT_VISION_MODEL  可选，视觉模型（+ _PROVIDER / _BASE_URL / _API_KEY）：
 *                       配了才注册 describe_image 工具，让纯文本执行者（DeepSeek/
 *                       Kimi 等）间接获得看图能力。若执行者自己必须看图才能推理
 *                       （如照着截图改 CSS），正解是换执行者模型而不是加这个工具
 *   AGENT_VERIFIER_MODEL 可选，--verify 时 verifier 用的独立模型（应 ≥ 执行者强度）；
 *                       配套 AGENT_VERIFIER_PROVIDER / _BASE_URL / _API_KEY 可指向
 *                       不同端点，缺省沿用执行者的端点配置
 *   AGENT_PACK          可选，领域包名（stm32-coding / stm32-debug）：覆盖 system
 *                       prompt、内置工具面、MCP 接入与白名单、验证策略、护栏参数。
 *                       AGENT_PRESET 为兼容别名
 *   AGENT_EFFORT        可选，思考预算档 low|medium|high|xhigh|max，默认 high。
 *                       仅原生 Claude 端点生效（compat 模式下该参数不发送）
 *   AGENT_VERIFY_RUBRIC 可选，主观评分表（任务级注入,优先于领域包的 verify.rubric）：
 *                       verifier 按表评估进裁决 advisory 字段,不影响 passed 不触发返工
 *   AGENT_VERIFY_MAX_TURNS 可选，核查者轮次预算（env > 包 verify.maxTurns > 默认 15）。
 *                       真机域每条验收要多次探针往返,15 装不下（案例 #8）;
 *                       非法值退出码 1,不静默降级
 *   AGENT_PLAN_MAX_TURNS 可选，planner 探索轮次预算（env > 包 plan.maxTurns 取最大
 *                       > 默认 12,见 B0——planner 面对整个包菜单,故取声明值最大）。
 *                       非法值退出码 1,口径同 AGENT_VERIFY_MAX_TURNS
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
import { AUTO_CONCURRENCY_CAP, plannedStopReason, planParallelWidth, runPlanned, runVerified } from "./orchestrate.js";
import type { VerifyOutcome } from "./verifier.js";
import { getPack, PACKS, RULE_PRECEDENCE_DISCIPLINE, selectPackTools } from "./presets.js";
import { routeToPack } from "./router.js";
import { createModelClientFromEnv } from "./provider.js";
import { bashTool, SHELL_DESC } from "./tools/bash.js";
import { createDescribeImageTool } from "./tools/describe-image.js";
import { fetchUrlTool } from "./tools/fetch-url.js";
import { readFileTool } from "./tools/read-file.js";
import { writeFileTool } from "./tools/write-file.js";
import { appendRunLedger, buildLedgerEntry, tallyToolCall, type ToolTally } from "./ledger.js";
import { warnEnvConflicts } from "./env-check.js";
import { EFFORT_LEVELS } from "./types.js";
import type { AgentConfig, Effort, TurnEvent } from "./types.js";

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
  // .env 被残留环境变量压掉时大声说出来（可能意味着凭据发往另一家端点）
  warnEnvConflicts();

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

  /**
   * 视觉模型（第四个角色模型）。配了才注册 describe_image——没配就不该在
   * 工具面上摆一个一调用就报错的工具，那是在骗模型说自己能看图。
   * 用途：DeepSeek / Kimi 这类纯文本执行者靠它间接获得视觉能力。
   */
  const visionModelName = process.env.AGENT_VISION_MODEL;
  const visionProvider = visionModelName
    ? createModelClientFromEnv(visionModelName, {
        ...(process.env.AGENT_VISION_PROVIDER
          ? { provider: process.env.AGENT_VISION_PROVIDER as "anthropic" | "openai" }
          : {}),
        ...(process.env.AGENT_VISION_BASE_URL ? { baseURL: process.env.AGENT_VISION_BASE_URL } : {}),
        ...(process.env.AGENT_VISION_API_KEY ? { apiKey: process.env.AGENT_VISION_API_KEY } : {}),
      })
    : undefined;
  if (visionProvider) console.log(c.dim(`vision model: ${visionModelName}`));
  const visionTool = visionProvider
    ? createDescribeImageTool({ client: visionProvider.client, modelName: visionModelName! })
    : undefined;

  // 内置工具按包名单装配（缺省全带）——领域包只带用得上的，减少触发面噪声
  const builtinByName = new Map(
    [bashTool, fetchUrlTool, readFileTool, writeFileTool, ...(visionTool ? [visionTool] : [])].map(
      (t) => [t.name, t],
    ),
  );
  const builtinNames = pack?.builtinTools ?? [...builtinByName.keys()];
  const builtins = builtinNames.map((n) => {
    const t = builtinByName.get(n);
    if (!t) throw new Error(`Pack "${pack?.name}" 声明了未知内置工具: ${n}`);
    return t;
  });

  // 思考预算档：外部输入,非法值当场报错而不是静默退回默认——
  // 静默降级会让"我明明设了 max"与实际行为长期不一致,查起来很贵
  const effortEnv = process.env.AGENT_EFFORT;
  if (effortEnv && !(EFFORT_LEVELS as readonly string[]).includes(effortEnv)) {
    console.error(`AGENT_EFFORT="${effortEnv}" 无效。可选值: ${EFFORT_LEVELS.join(" | ")}`);
    process.exit(1);
  }
  const effort = effortEnv as Effort | undefined;
  if (effort && compat) {
    console.log(c.yellow(`提示：AGENT_EFFORT=${effort} 在 compat 模式下不会发送（第三方端点不认识该参数）`));
  }

  // 主观评分表：任务级 env 优先于领域包声明（rubric 是任务属性,包只提供缺省）
  const envRubric = process.env.AGENT_VERIFY_RUBRIC;
  /**
   * 核查轮次预算：env > 包 > 默认 15（口径同其它护栏）。
   * 非法值当场退出而不是静默降级——静默会让"我明明调大了预算"与实际行为
   * 长期不一致（口径同 AGENT_EFFORT）。
   */
  const envVerifyMaxTurns = (() => {
    const raw = process.env.AGENT_VERIFY_MAX_TURNS;
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      console.error(c.red(`AGENT_VERIFY_MAX_TURNS "${raw}" 无效：需为 ≥1 的整数`));
      process.exit(1);
    }
    return n;
  })();
  const verifyMaxTurnsOf = (p?: { verify: { maxTurns?: number } }): number | undefined =>
    envVerifyMaxTurns ?? p?.verify.maxTurns;

  /** planner 探索预算的显式覆盖（口径同 AGENT_VERIFY_MAX_TURNS：非法值当场退出） */
  const envPlanMaxTurns = (() => {
    const raw = process.env.AGENT_PLAN_MAX_TURNS;
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      console.error(c.red(`AGENT_PLAN_MAX_TURNS "${raw}" 无效：需为 ≥1 的整数`));
      process.exit(1);
    }
    return n;
  })();

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
    ...(effort ? { effort } : {}),
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

  /**
   * L6 运行台账：三条执行路径（编排 / 带核查 / 裸跑）共用同一份计数器。
   *
   * 为什么 CLI 也要记：§2.1 要量的是**模型吐不吐得出可解析的裁决**，那是模型
   * 行为，两个宿主上是同一件事；而 9.9 那个 verifier 调 write_memory 的现象
   * **只有 CLI + 领域包这条路能产生**（Web 宿主根本没接 MemoryStore）。
   * 只记 Web 侧，等于把唯一能出证据的那条路排除在外。
   */
  const ledgerTally: ToolTally = {};
  let ledgerHitBudget = false;
  /** 三条路径各自把收尾事实归一到这里，最后统一写一行 */
  let ledgerFacts: {
    stopReason: string | null;
    turns: number | null;
    reworks: number | null;
    finalPassed: boolean | null;
    verifications: VerifyOutcome[];
  } | null = null;
  const ledgerStartedAt = Date.now();
  const noteForLedger = (source: string, event: TurnEvent): void => {
    if (event.type === "tool_call") tallyToolCall(ledgerTally, source, event.name);
    if (
      event.type === "done" &&
      source.includes("verifier") &&
      event.result.stopReason === "max_turns"
    ) {
      ledgerHitBudget = true;
    }
  };

  if (withPlan) {
    // 三角编排：planner 拆解 → 逐子任务(执行→核查→返工) → 交接下游
    const builtinPool = [bashTool, fetchUrlTool, readFileTool, writeFileTool, ...(visionTool ? [visionTool] : [])];
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
          console.log(
            c.yellow(`${tag} ⟳ API 瞬时错误，同轮重试 #${event.attempt}（等待 ${event.backoffMs}ms）`),
          );
          break;
        case "segment_resume":
          console.log(
            c.yellow(`${tag} ⟲ 整段因瞬时故障终止，带 ${event.priorTurns} 轮正史续跑：${event.reason}`),
          );
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
      ...(envPlanMaxTurns !== undefined ? { planMaxTurns: envPlanMaxTurns } : {}),
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
            ...((envRubric ?? p?.verify.rubric) ? { verifyRubric: (envRubric ?? p?.verify.rubric)! } : {}),
            ...(verifyMaxTurnsOf(p) !== undefined ? { verifyMaxTurns: verifyMaxTurnsOf(p)! } : {}),
            ...(verifierProvider
              ? { verifierModel: { client: verifierProvider.client, compat: verifierProvider.compat } }
              : {}),
          },
          // 独占资源（如 swd-probe）：调度器对同标签子任务强制串行
          ...(p?.resources ? { resources: p.resources } : {}),
        };
      },
      onEvent: async (source, event) => {
        noteForLedger(source, event);
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
    // 记账不分分支：计划不可解析（fail-closed）也是一次要归档的失败，只在
    // plan 存在的分支赋值会让这类失败在台账里落 stopReason=null。
    // steps 为空时各聚合项自然得 0/[]，不必按分支各写一份。
    ledgerFacts = {
      stopReason: plannedStopReason(outcome),
      // 编排下 turns 取各子任务执行轮次之和：单看某一步没有意义
      turns: outcome.steps.reduce((n, st) => n + st.result.executionUsage.turns, 0),
      reworks: outcome.steps.reduce((n, st) => n + st.result.reworks, 0),
      finalPassed: outcome.completed,
      // 一次编排产生多次裁决——§2.1 的样本量正是这么攒起来的
      verifications: outcome.steps.flatMap((st) => st.result.verifications),
    };
    if (!outcome.plan) {
      console.log(c.red(`✘ planner 未能产出可解析计划：${outcome.planOutcome.raw.slice(0, 200)}`));
      // 9.2 的 planner 版：区分"胡言乱语"与"探索没来得及收口"，返工策略完全不同
      if (outcome.planOutcome.failureSummary) {
        console.log(c.yellow(`  ${outcome.planOutcome.failureSummary}`));
      }
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
      ...((envRubric ?? pack?.verify.rubric) ? { verifyRubric: (envRubric ?? pack?.verify.rubric)! } : {}),
      ...(verifyMaxTurnsOf(pack) !== undefined ? { verifyMaxTurns: verifyMaxTurnsOf(pack)! } : {}),
      ...(verifierProvider
        ? { verifierModel: { client: verifierProvider.client, compat: verifierProvider.compat } }
        : {}),
      onEvent: async (source, event) => {
        noteForLedger(source, event);
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
    ledgerFacts = {
      stopReason: outcome.main.stopReason,
      turns: outcome.executionUsage.turns,
      reworks: outcome.reworks,
      finalPassed: outcome.finalPassed,
      verifications: outcome.verifications,
    };
    const tag = outcome.finalPassed ? c.green("✔ 核查通过") : c.red("✘ 核查未通过");
    console.log(`\n${tag}${outcome.reworks ? c.dim(`（返工 ${outcome.reworks} 轮）`) : ""}`);
    printVerdictSignal("  ", outcome.finalPassed, outcome.verifications.at(-1)?.verdict);
  } else {
    const loop = new AgentLoop(config, modelClient);
    for await (const event of loop.run(task)) {
      noteForLedger("main", event);
      if (event.type === "done") {
        ledgerFacts = {
          stopReason: event.result.stopReason,
          turns: event.result.usage.turns,
          reworks: null,
          finalPassed: null,
          verifications: [],
        };
      }
      await renderEvent(event);
    }
  }
  /**
   * L6 运行台账（fire-and-forget，永不影响本次运行）。
   * 见 `src/ledger.ts` 顶部：这一行就是"等证据"能不能等到的全部区别。
   */
  void appendRunLedger(
    buildLedgerEntry({
      at: Date.now(),
      runId: `cli-${ledgerStartedAt}`,
      host: "cli",
      task,
      pack: pack?.name ?? null,
      model: process.env.AGENT_MODEL ?? null,
      effort: process.env.AGENT_EFFORT ?? null,
      mode: withPlan ? "plan" : "single",
      verify: withVerify || withPlan,
      rubric: envRubric ?? pack?.verify.rubric ?? null,
      stopReason: ledgerFacts?.stopReason ?? null,
      turns: ledgerFacts?.turns ?? null,
      reworks: ledgerFacts?.reworks ?? null,
      finalPassed: ledgerFacts?.finalPassed ?? null,
      verifications: ledgerFacts?.verifications ?? [],
      verifierBudgetTurns: verifyMaxTurnsOf(pack) ?? null,
      verifierHitBudget: ledgerHitBudget,
      tools: ledgerTally,
      durationMs: Date.now() - ledgerStartedAt,
    }),
  );

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
        console.log(
          c.yellow(`⟳ API 瞬时错误，同轮重试 #${event.attempt}（等待 ${event.backoffMs}ms）：${event.reason}`),
        );
        break;
      case "assistant_thinking":
        // 思考走洋红（与 verifier 同族的"旁支"语域），折成一行摘要——
        // 终端里全量打印思考会把真正的产出淹掉
        endStreamLine();
        console.log(
          c.magenta(
            event.redacted
              ? "✽ 思考过程（服务端已加密）"
              : `✽ 思考过程 ${event.text.length} 字：${event.text.replace(/\s+/g, " ").slice(0, 60)}…`,
          ),
        );
        break;
      case "segment_resume":
        endStreamLine();
        console.log(
          c.yellow(`⟲ 整段因瞬时故障终止，带 ${event.priorTurns} 轮正史续跑（不是从头重来）：${event.reason}`),
        );
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

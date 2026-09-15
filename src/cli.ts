/**
 * CLI 宿主：事件流的一个消费者示例。
 * 用法：npx tsx src/cli.ts "任务描述" [--yes] [--verify] [--plan [--parallel[=N]]] [--auto] [--ask]
 *   --yes       自动批准所有审批请求（非交互环境/CI 用；交互终端下走 y/n 提示）
 *   --verify    完成后由 verifier 子代理独立核查，未通过自动返工一轮
 *   --ask       给执行者装 ask_user（§5.2 需求澄清）。**默认关**——宿主也被脚本化
 *               驱动，默认开会让无人值守场景挂死等人。配额见 AGENT_MAX_ASK_ROUNDS。
 *               与 --yes 互斥（无人值守没人可问，给了会提示并忽略）。
 *               verifier/planner 永远拿不到这个工具（harness 层强制）。
 *               每次提交 1~4 个问题，每题带 2~4 个候选，回车跳过单题
 *   --plan      三角编排：planner 拆解子任务（自选领域包+依赖图）→ 确认门 → 执行→核查→交接；
 *               TTY 打印短表问 y/n（可改一行标题）；非 TTY 须 --yes 才自动开跑，否则退出码 2。
 *               互不依赖的子任务默认并发（并行度 auto = min(3, 计划层宽)）
 *   --resume-run ID  同 run 热续。不带 --plan：从已提交的 main 检查点续跑；
 *                    带 --plan：半截 DAG 续发射（至少一枚 passed，不重跑 planner）。
 *                    读不到热续检查点就停并印原任务/终态，不当新任务重开。
 *                    谱系预算已用尽则拒；不能与 --verify 同时用。
 *   --parallel=N  显式并行度覆盖 auto；=1 退回全串行
 *   --auto      调度单元路由领域包（单领域任务免手选；显式 AGENT_PACK 优先）
 *
 * 环境变量：
 *   AGENT_PROVIDER      anthropic（默认）| openai —— 选择 wire 协议
 *   ANTHROPIC_API_KEY   API 密钥（Anthropic 或第三方兼容端点的 key）
 *   ANTHROPIC_BASE_URL  可选，第三方 Anthropic 兼容端点（DeepSeek/GLM/Kimi/Ollama）
 *   OPENAI_BASE_URL     provider=openai 时的端点（如 https://api.deepseek.com）
 *   OPENAI_API_KEY      provider=openai 时的 key（必须显式配置，不跨 provider 复用）
 *   AGENT_MODEL         可选，模型名，默认 claude-opus-4-8；
 *                       非 claude-* 模型自动进入 compat 模式（去掉 Claude 专属参数）
 *   AGENT_VISION_MODEL  可选，独立识图模型（+ _PROVIDER / _BASE_URL / _API_KEY）：
 *                       仅当执行者自己不能看图时才引用。执行者能看则
 *                       describe_image 走执行模型，不构造这个角色。
 *                       两边都没有 → 不把工具摆上工具面。
 *                       若执行者必须看图才能推理（如照着截图改 CSS），
 *                       正解是换执行者模型，而不是只加这个工具
 *   AGENT_IMAGE_MODEL   可选，生图模型（+ _PROVIDER / _BASE_URL / _API_KEY）：
 *                       配了才注册 generate_image。走 OpenAI 兼容 Images API，
 *                       不是 chat completions；没配就不把工具摆上工具面
 *   AGENT_VERIFIER_MODEL 可选，--verify 时 verifier 用的独立模型（应 ≥ 执行者强度）；
 *                       配套 AGENT_VERIFIER_PROVIDER / _BASE_URL / _API_KEY 可指向
 *                       不同端点，缺省沿用执行者的端点配置
 *   AGENT_MODE          可选，design = 设计模式（推荐入口：锁定 design 包并做制品类型路由）。
 *                       与 AGENT_PACK 同时出现时显式包优先；与 --plan 同时出现时 --plan 优先
 *   AGENT_PACK          可选，领域包名（stm32-coding / stm32-debug）：覆盖 system
 *                       prompt、内置工具面、MCP 接入与白名单、验证策略、护栏参数。
 *                       AGENT_PRESET 为兼容别名。AGENT_PACK=design 永久保留；
 *                       未设 AGENT_MODE=design 时打印提示，不中断、不改包
 *   AGENT_EFFORT        可选，思考预算档 low|medium|high|xhigh|max，默认 high。
 *                       仅原生 Claude 端点生效（compat 模式下该参数不发送）
 *   AGENT_VERIFY_RUBRIC 可选，主观评分表（任务级注入,优先于领域包的 verify.rubric）：
 *                       verifier 按表评估进裁决 advisory 字段,不影响 passed 不触发返工
 *   AGENT_VERIFY_MAX_TURNS 可选，核查者轮次预算（env > 包 verify.maxTurns > 默认 15）。
 *                       真机域每条验收要多次探针往返,15 装不下（案例 #8）;
 *                       非法值退出码 1,不静默降级
 *   AGENT_VERIFY_READONLY_COMMANDS 可选，**无领域包**运行的核查者只读命令白名单（逗号分隔，
 *                       前缀匹配），替换通用缺省 ls/cat/head/tail/wc/grep/stat/od/diff/git 只读四件。
 *                       有包时不生效——白名单由包声明，包没声明也不补
 *   AGENT_PLAN_MAX_TURNS 可选，planner 探索轮次预算（env > 包 plan.maxTurns 取最大
 *                       > 默认 12,见 B0——planner 面对整个包菜单,故取声明值最大）。
 *                       非法值退出码 1,口径同 AGENT_VERIFY_MAX_TURNS
 *   AGENT_PROGRESS_EXTENSION_TURNS / AGENT_STAGNATION_WINDOW / AGENT_MAX_STAGNATION_RECOVERIES
 *                       可选，恢复策略三字段（env > 包 recovery > 默认 8 / 3 / 1），
 *                       逐字段独立覆盖；0 合法（=关掉该项）；≥0 整数，非法值退出码 1。
 *                       仅完成门开启时生效（AGENT_REQUIRE_FINISH_TASK≠0）
 *   AGENT_MAX_ASK_ROUNDS 可选，--ask 时整个 run 的【打断次数】上限（默认 3）。
 *                       单位是打断不是问题数：一次可提交 1~4 个问题（§5.2 决定 6）——
 *                       贵的是打断人，不是问题本身。配额由 harness 硬执行
 *   AGENT_READ_ROOTS    可选，额外只读根（分号/路径分隔符分隔的绝对路径）：
 *                       read_file 可读取这些目录（写类工具不受益）。用于工作区外的
 *                       领域素材库（如 KiCad 官方符号/封装库）
 *   AGENT_CONTEXT_LIMIT 可选，提前压缩的水位覆盖。不设时：窗口已知则跟可用窗口
 *                       （窗口 − maxTokens − 边际）；窗口未知才回落 150000。
 *                       与模型窗口是两个概念：窗口按 AGENT_CONTEXT_WINDOW > 撞 400 学到的 >
 *                       登记表 > 未知 解析。显式水位超过可用窗口会被夹紧并告警。
 *   AGENT_CONTEXT_WINDOW 可选，显式声明模型上下文窗口（token 数），压过学到的与登记表的值
 *   AGENT_CAPABILITY_CACHE 可选，学到的窗口等端点能力的落盘路径，默认 <cwd>/.agent-capabilities.json
 *   AGENT_TOOL_RESULT_MAX_CHARS 可选，单个 tool_result 进正史前的字符上限，默认 40000（≥1000）。
 *                       MCP 工具返回无上限，这是兜底；截断标记会告诉模型如何分页
 *   AGENT_COMPACT_SUMMARY=1 可选，开启 MEM-01 Phase B LLM 摘要（默认关；CI/eval 勿开）
 *   AGENT_COMPACT_SUMMARY_MAX_TOKENS 可选，摘要 max_tokens，默认 512
 *   AGENT_MAX_TOKENS    可选，单次响应输出上限，默认 64000。本地慢速模型建议调低
 *                       （如 4096）以掐断思考螺旋——快速失败优于无限等待
 *   AGENT_TIMEOUT_MS    可选，单请求超时毫秒数，默认 SDK 的 10 分钟
 *   AGENT_MAX_RETRIES   可选，超时/5xx 重试次数，默认 SDK 的 2
 *   AGENT_EXECUTION_ISOLATION off|report|required；缺省 report（宿主直跑且明确未隔离）
 *   AGENT_EXECUTION_BACKEND auto|oci|bwrap；required 当前只实现 OCI
 *   AGENT_EXECUTION_OCI_IMAGE required+OCI 必填，必须是 digest/image-ID 固定引用
 *   AGENT_EXECUTION_OCI_RUNTIME Linux 下管理员固定的 Docker CLI 绝对真实路径
 *   AGENT_EXECUTION_OCI_RUNTIME_SHA256 与 runtime 成对的 64 位 SHA-256
 *   AGENT_EXECUTION_OCI_HOST 仅允许本机绝对 unix:// socket；缺省 /var/run/docker.sock
 *   AGENT_EXECUTION_OCI_NAMESPACE required+OCI 必填的稳定部署分区，用于 durable lease/reaper
 *   AGENT_HOOKS_CONFIG  可选，指向 hooks JSON。不设 = 机制不存在。设了但文件缺失/非法则 exit 1。
 *                       只认 PreToolUse / PostToolUse / Stop 的 command handler；退出码 2 阻断、1 不阻断。
 *   AGENT_FEISHU_WEBHOOK 可选，飞书自定义机器人 webhook。project_status 写入/清除时
 *                       出站推一门卡片。只出站，无入站审批。勿把地址打进日志。
 *                       与 AGENT_NOTIFY_WEBHOOK 二选一，飞书优先。
 *   AGENT_NOTIFY_WEBHOOK 可选，通用 JSON webhook（同一卡片正文）。
 *   AGENT_MD_MAX_CHARS  可选，AGENT.md 加载总量上限（默认 16000，≥1000）。非法值 exit 1。
 *                       开关是文件本身：~/.agent/AGENT.md、项目 AGENT.md、.agent/rules/*.md
 *                       都不在 = 机制不存在。这是指导不是执行，不能授予权限。
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { createExecutionBroker, parseExecutionPolicy } from "./execution-broker.js";
import {
  buildStaticDoctorReport,
  CLI_NEEDS_CONFIRM_EXIT,
  CLI_VERSION,
  CliArgumentError,
  cliCanPrompt,
  cliHelpText,
  formatCliNeedsConfirmMessage,
  formatStaticDoctor,
  isReadlineClosedError,
  parseCliArgs,
} from "./cli-args.js";
import { AgentLoop, createRunBudget, DEFAULT_MAX_TOKENS, DEFAULT_MAX_TURNS } from "./loop.js";
import {
  describeContextPlan,
  formatTokensK,
  planContextBudget,
  readContextLimitEnv,
  resolveContextWindow,
  type ContextPlan,
} from "./context-window.js";
import {
  capabilityStorePath,
  configureCapabilityStore,
  learnContextWindow,
  probeVisionSupport,
  shouldRunModelProbe,
  type EndpointIdentity,
} from "./model-capability.js";
import { connectMcpServers, filterMcpConfigForPack, loadMcpConfig, mcpConfigHasRunnableServers } from "./mcp.js";
import { packAcceptsHostGithub } from "./mcp-github.js";
import { formatWorkspaceGitLine, probeWorkspaceGit } from "./workspace-git.js";
import { createMemoryTools, MemoryStore, resolveMemoryDir } from "./memory.js";
import {
  createProjectStatusTool,
  formatProjectStatusBlock,
  isSharedMemoryDir,
  readProjectStatus,
  scopedMemoryIndex,
} from "./project-status.js";
import {
  createOfficeNotifier,
  gateNotifyPayloadFromBoard,
  notifyArmedHint,
  resolveOfficeNotifyFromEnv,
} from "./notify.js";
import { AUTO_CONCURRENCY_CAP, plannedStopReason, planParallelWidth, runPlanned, runVerified } from "./orchestrate.js";
import type { VerifiedRunResult } from "./orchestrate.js";
import {
  durableNodeFromPlanNode,
  durablePlanFromPlan,
  handoffsFromPlanNodes,
  planFromNodes,
  planNodesFromDurable,
  planNodesFromSubtasks,
  type PlanNodeState,
} from "./planner.js";
import {
  applyCliPlanTitleEdits,
  CliPlanRejectedError,
  confirmCliPlan,
  formatCliPlanShortTable,
  resolveCliPlanGateMode,
} from "./cli-plan-gate.js";
import { readArchivedState, readArchivedTranscript } from "../ui/history.js";
import { seedDurableBudget, snapshotDurableBudget } from "./run-state.js";
import { resolveVerifierReadOnlyCommands, type VerifyOutcome } from "./verifier.js";
import { allPacks, getPack, DEFAULT_HOST_DISCIPLINES, selectPackTools, ALWAYS_ON_BUILTIN_TOOLS, type DomainPack } from "./presets.js";
import { loadInstalledFilePacksSync, packsRootFromEnv } from "./pack-files.js";
import {
  DESIGN_CATALOG,
  designPackLegacyHint,
  installedFilePacksFrom,
  parseDesignChoiceInput,
  resolveDesignModeIntent,
  routeDesignTask,
  seedsToCopy,
  shouldSeedDesignTemplate,
  shouldWriteBlankDesignIndex,
  writeBlankDesignIndex,
  writeDesignBundleHub,
  type DesignRoute,
} from "./design-mode.js";
import { copyDesignTemplate, designTemplatesRootFromRepo } from "../ui/design-templates.js";
import { draftDomainPackTool } from "./tools/draft-domain-pack.js";
import { installMcpTool } from "./tools/install-mcp.js";
import { resolveSkillsDir, withEnabledSkills } from "./skills.js";
import { resolveRecoveryPolicy } from "./recovery.js";
import { routeToPack } from "./router.js";
import { createFallbackClientIfConfigured, createRoleFallbackClient, executorBackupEndpoints, FallbackModelClient, sharedBreakerRegistry } from "./model-fallback.js";
import { createModelClientFromEnv, createModelClientWithProbe } from "./provider.js";
import { ASK_USER_TOOL_NAME, createAskUserTool } from "./tools/ask-user.js";
import { createProposeHandoffTool } from "./tools/propose-handoff.js";
import { createSpawnTaskTool } from "./tools/spawn-task.js";
import { runSpawnedTask } from "./spawn.js";
import { findPackHandoff } from "./handoff.js";
import {
  FINISH_TASK_TOOL_NAME,
  withTaskCompletion,
} from "./task-completion.js";
import { bashTool, SHELL_DESC } from "./tools/bash.js";
import {
  assembleDescribeImageTool,
  resolveDescribeImageBacking,
  resolveExecutorVisionSupport,
} from "./design-image-review.js";
import { createGenerateImageTool } from "./tools/generate-image.js";
import { createOpenAIImageClient, DEFAULT_OPENAI_IMAGE_BASE } from "./image-client.js";
import { assertSafeProviderEndpoint } from "./provider-config.js";
import { createWebSearchTool, isWebSearchConfigured } from "./tools/web-search.js";
import { fetchUrlTool } from "./tools/fetch-url.js";
import { editFileTool } from "./tools/edit-file.js";
import { globTool } from "./tools/glob.js";
import { grepTool } from "./tools/grep.js";
import { readFileTool } from "./tools/read-file.js";
import { writeFileTool } from "./tools/write-file.js";
import { writePptxTool } from "./tools/write-pptx.js";
import { updateProgressTool } from "./tools/update-progress.js";
import {
  appendRunLedger,
  buildLedgerEntry,
  emptyCompactionTally,
  emptyRecoveryTally,
  ledgerErrorClass,
  emptyApprovalsTally,
  emptyHooksTally,
  tallyApprovalOutcome,
  tallyCompaction,
  tallyHookEvent,
  tallyRecoveryDecision,
  tallyToolCall,
  type LedgerApprovalsTally,
  type LedgerHooksTally,
  type ToolTally,
} from "./ledger.js";
import { warnEnvConflicts } from "./env-check.js";
import { EFFORT_LEVELS } from "./types.js";
import type { AgentConfig, Effort, ExecutionBroker, ModelClient, RecoveryPolicy, SharedRunBudget, TurnEvent } from "./types.js";
import {
  cliDurableEnabled,
  createCliDurable,
  ensureCliHistoryRoot,
  formatCliResumeStop,
  lastExecutorTranscriptMessages,
  prepareCliPlanResume,
  prepareCliSingleResume,
  readCliArchiveTask,
  type CliDurableHandle,
} from "./cli-durable.js";
import {
  hostPlanEvent,
  hostPlanReplanEvent,
  hostPlanResultEvent,
  hostPlanResumeEvent,
  hostPlanSubtaskViews,
} from "./archive-event.js";
import { cliRuntimePermissionSwitches, formatPermissionBanner, matchPermissionMode, resolvePermissionMode } from "./permission-mode.js";
import {
  createHookRuntime,
  resolveHooksFromEnv,
  type NormalizedHookSpec,
} from "./hooks.js";
import {
  DEFAULT_AGENT_MD_MAX_CHARS,
  formatAgentMdStartupLine,
  loadAgentMd,
  mergeAgentMdContext,
  resolveAgentMdMaxChars,
  type AgentMdBundle,
} from "./agent-md.js";

let activeCliExecutionBroker: ExecutionBroker | undefined;
let activeCliDurable: CliDurableHandle | undefined;
let activeCliLineageBudget: SharedRunBudget | undefined;

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

/**
 * 压缩事件一行文案（两条渲染路径共用）。reactive 与 collapsedTurns 必须可见：
 * 前者说明这一轮是撞了端点 400 才压的（不是水位触发），后者说明旧轮正文已被折叠成摘要——
 * 两者都是"模型此后看不见原文"的不可逆动作，不能只报一个 dropped 数。
 */
function describeCompaction(event: Extract<TurnEvent, { type: "compaction" }>): string {
  return (
    `⚠ context compacted${event.reactive ? " (reactive, after context-overflow 400; same turn re-sent)" : ""}: ` +
    `dropped ${event.droppedBlocks} blocks` +
    (event.collapsedTurns ? `, collapsed ${event.collapsedTurns} earlier turns` : "") +
    (event.ledgerEntries != null ? `, ledger ${event.ledgerEntries} facts` : "") +
    (event.summaryApplied ? ", LLM summary merged" : "") +
    // 那条 400 顺带说出了窗口大小——记下来了，下一次同端点的运行就按它算预算上限
    (event.learnedWindow ? `; 学到窗口 ${formatTokensK(event.learnedWindow)}（下次运行生效）` : "")
  );
}

/** GhostApproval：审批提示附带解析后真实路径（与模型诱饵名对照）。 */
function formatApprovalPrompt(event: Extract<TurnEvent, { type: "approval_request" }>): string {
  const base = `approve ${event.name} ${JSON.stringify(event.input)}`;
  const attention = (event.resolvedTargets ?? []).filter((t) => t.diverges || t.error);
  if (attention.length === 0) return base;
  const hints = attention
    .map((t) =>
      t.error
        ? `REAL-PATH FAIL ${t.field}=${t.requested}: ${t.error}`
        : `REAL PATH ${t.field}: ${t.requested} → ${t.real}`,
    )
    .join("; ");
  return `${base}\n  ⚠ ${hints}`;
}

function evidenceFromVerifiedStep(result: VerifiedRunResult): string | undefined {
  const parts: string[] = [];
  const completion = result.main.completion;
  if (completion?.summary) parts.push(completion.summary);
  if (completion?.artifacts?.length) parts.push(`产物：${completion.artifacts.join("、")}`);
  const verdict = result.verifications.at(-1)?.verdict;
  if (verdict?.summary) parts.push(`裁决：${verdict.summary}`);
  if (verdict?.issues?.length) parts.push(`问题：${verdict.issues.join("；")}`);
  return parts.length ? parts.join(" · ") : undefined;
}

async function applyCliDesignSeed(route: DesignRoute, workdir: string): Promise<void> {
  try {
    if (shouldSeedDesignTemplate(route)) {
      const templatesRoot = designTemplatesRootFromRepo(process.cwd());
      for (const seed of seedsToCopy(route)) {
        const result = await copyDesignTemplate({
          templatesRoot,
          templateId: seed,
          destRoot: workdir,
        });
        console.log(c.dim(`design seed: ${result.entry}（${result.files} 个文件）`));
      }
      if (route.bundle === "spec-plus-deck") {
        const hub = await writeDesignBundleHub(workdir);
        console.log(c.dim(`design seed: ${hub}（规格+幻灯入口）`));
      }
      return;
    }
    if (shouldWriteBlankDesignIndex(route)) {
      const path = await writeBlankDesignIndex(workdir);
      console.log(c.dim(`design seed: ${path}（空白起步）`));
    }
  } catch (err) {
    console.log(c.yellow(`design seed 未写入：${err instanceof Error ? err.message : String(err)}`));
  }
}

async function promptDesignChoiceOnce(
  pending: DesignRoute,
  task: string,
  compat: boolean,
  model: ModelClient,
  autoYes: boolean,
): Promise<DesignRoute> {
  if (autoYes || !cliCanPrompt()) {
    return {
      kind: "r3",
      id: null,
      reason: autoYes
        ? "无人值守无法展示页签，已用 design 包从空白 index.html 起步"
        : "没有交互终端，已用 design 包从空白 index.html 起步",
      seed: "blank",
      pack: "design",
    };
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(c.cyan("\n设计模式：请选择制品类型（回车则从空白 HTML 起步）"));
    DESIGN_CATALOG.forEach((e, i) => {
      console.log(c.dim(`   ${i + 1}) ${e.tab} · ${e.title}（${e.id}）`));
    });
    const raw = (await rl.question("> ")).trim();
    if (!raw) {
      return {
        kind: "r3",
        id: null,
        reason: "未选择制品类型，已用 design 包从空白 index.html 起步",
        seed: "blank",
        pack: "design",
      };
    }
    let hit = parseDesignChoiceInput(raw, { tabHint: pending.tab });
    if (hit?.kind === "tab") {
      const tab = hit.tab;
      const entries = DESIGN_CATALOG.filter((e) => e.tab === tab);
      console.log(c.cyan(`\n${tab}：请选择类型（回车则从空白 HTML 起步）`));
      entries.forEach((e, i) => console.log(c.dim(`   ${i + 1}) ${e.title}（${e.id}）`)));
      const raw2 = (await rl.question("> ")).trim();
      hit = raw2 ? parseDesignChoiceInput(raw2, { tabHint: tab }) : null;
    }
    if (!hit || hit.kind === "tab") {
      return {
        kind: "r3",
        id: null,
        reason: "未选择制品类型，已用 design 包从空白 index.html 起步",
        seed: "blank",
        pack: "design",
      };
    }
    return routeDesignTask({
      cfg: { systemPrompt: SYSTEM_PROMPT, tools: [], workdir: process.cwd(), compat },
      model,
      task: task || raw,
      explicitId: hit.kind === "id" ? hit.entry.id : hit.kind === "bundle" ? hit.bundle : undefined,
      explicitFilePack: hit.kind === "file-pack" ? hit.packName : undefined,
      installedFilePacks: installedFilePacksFrom(allPacks()),
    });
  } finally {
    rl.close();
  }
}

const SYSTEM_PROMPT = `You are a capable assistant in a local working directory.
If the user is just talking, talk back in their language. If they asked you to do work, complete it with the available tools and ground claims of progress in tool results. When a task is done, summarize in one or two sentences.
Keep file outputs clean and well-structured.

You have a persistent memory that survives across sessions. The current memory index is provided in the <context> block of the first message and is scoped to this project (plus global lessons). When starting a task, or when a memory is likely relevant, consult it with memory_read. When you learn a durable fact, user preference, or lesson worth reusing — a correction you received, a project constant, an approach that worked — save it with memory_write (one fact per file, first line = summary). Update or delete memories that turn out to be wrong. Do not store transient task state in memory_write; use project_status for the in-progress board (who is waiting, next gate, open decisions). Do not store things already recorded in the repository.` + DEFAULT_HOST_DISCIPLINES;

function persistCliExecutorCheckpoint(
  durable: CliDurableHandle | undefined,
  event: Extract<TurnEvent, { type: "done" }>,
): void {
  const messages = event.result.messages;
  if (!durable || !messages?.length) return;
  const usage = event.result.usage;
  const fallback = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
  durable.noteExecutorCheckpoint({
    messages,
    contextInputTokens: event.result.contextInputTokens ?? fallback,
    budget: event.result.runBudget ? snapshotDurableBudget(event.result.runBudget) : null,
  });
}

async function main(): Promise<void> {
  // 参数与静态 doctor 必须先于 provider/MCP/execution broker。doctor 的契约是
  // 零网络、零模型 client、零 worker；连帮助命令也不应被 .env 冲突告警淹没。
  const parsedArgs = parseCliArgs(process.argv.slice(2));
  if (parsedArgs.command === "help") {
    console.log(cliHelpText());
    return;
  }
  if (parsedArgs.command === "version") {
    console.log(CLI_VERSION);
    return;
  }
  if (parsedArgs.command === "doctor") {
    const report = buildStaticDoctorReport();
    console.log(formatStaticDoctor(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }

  // .env 被残留环境变量压掉时大声说出来（可能意味着凭据发往另一家端点）
  warnEnvConflicts();

  // 文件领域包：只装 installed/。草稿不进 getPack。
  // schemaVersion 未识别 → 抛错 → 下方 catch exit 1（同非法 context env）。
  try {
    loadInstalledFilePacksSync(packsRootFromEnv());
  } catch (err) {
    console.error(c.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  // 端点能力缓存（学到的上下文窗口）：与台账 / 记忆同一套 cwd 约定；坏了就当空表，不挡启动
  configureCapabilityStore({ file: capabilityStorePath() });

  const autoYes = parsedArgs.autoYes;
  const withPlan = parsedArgs.plan;
  const withAuto = parsedArgs.auto;
  // 缺省 auto = min(3, 计划层宽)。解析器同时支持 --parallel=N 与
  // --parallel N，且会消费分离值，避免把数字误拼进 task。
  const concurrency = parsedArgs.concurrency;
  const task = parsedArgs.task;
  const resumeRun = parsedArgs.resumeRun;
  const designIntent = resolveDesignModeIntent({
    plan: withPlan,
    auto: withAuto,
    agentMode: process.env.AGENT_MODE,
    agentPack: withPlan ? undefined : (process.env.AGENT_PACK ?? process.env.AGENT_PRESET),
  });
  const legacyDesignHint = designPackLegacyHint({
    agentMode: process.env.AGENT_MODE,
    agentPack: process.env.AGENT_PACK,
    agentPreset: process.env.AGENT_PRESET,
  });
  if (legacyDesignHint) {
    console.log(c.yellow(legacyDesignHint));
  }
  if (!task && !resumeRun && designIntent.action !== "design") {
    console.error('Usage: npm run agent -- run [options] "task description"（旧入口 npm run cli -- 仍兼容）');
    process.exit(1);
  }

  const model = process.env.AGENT_MODEL ?? "claude-opus-4-8";
  const { client: resolvedClient, provider, compat, capabilities: executorCaps } =
    await createModelClientWithProbe(model);

  // 领域包（可选）：AGENT_PACK 显式选用（AGENT_PRESET 为兼容别名）；
  // --auto 时由调度单元路由（显式 > 路由）；--plan 时忽略：包由 planner 按子任务选
  const packName = withPlan ? undefined : (process.env.AGENT_PACK ?? process.env.AGENT_PRESET);
  let pack = packName ? getPack(packName) : undefined;
  if (packName && !pack) {
    console.error(`Unknown pack "${packName}". Available: ${allPacks().map((p) => p.name).join(", ")}`);
    process.exit(1);
  }
  let designRoute: DesignRoute | undefined;
  if (designIntent.action === "design") {
    designRoute = await routeDesignTask({
      cfg: { systemPrompt: SYSTEM_PROMPT, tools: [], workdir: process.cwd(), compat },
      model: resolvedClient,
      task: task ?? "",
      installedFilePacks: installedFilePacksFrom(allPacks()),
    });
    if (designRoute.kind === "r2") {
      designRoute = await promptDesignChoiceOnce(
        designRoute,
        task ?? "",
        compat,
        resolvedClient,
        autoYes,
      );
    }
    pack = getPack(designRoute.pack) ?? getPack("design");
    console.log(
      c.dim(
        `design: ${designRoute.kind} id=${designRoute.id ?? "—"} seed=${designRoute.seed} — ${designRoute.reason}`,
      ),
    );
    await applyCliDesignSeed(designRoute, process.cwd());
  } else if (withAuto && !pack && !withPlan) {
    const route = await routeToPack(
      { systemPrompt: SYSTEM_PROMPT, tools: [], workdir: process.cwd(), compat },
      resolvedClient,
      task,
      allPacks(),
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
  const withVerify = parsedArgs.verify || pack?.verify.enabled === true;

  // --verify 时可选的独立 verifier 模型（核查者应 ≥ 执行者强度）
  const verifierModelName = process.env.AGENT_VERIFIER_MODEL;
  const verifierProvider = verifierModelName
    ? await createModelClientWithProbe(verifierModelName, {
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
    ? await createModelClientWithProbe(plannerModelName, {
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
  const maxTokens = process.env.AGENT_MAX_TOKENS
    ? Number(process.env.AGENT_MAX_TOKENS)
    : pack?.guardrails?.maxTokens;
  /**
   * 执行者端点身份：窗口按 provider|model|origin 记（学到的窗口、探针粘性都用它做键）。
   * 不含 key——身份是给缓存与降级链认端点用的，不是凭据。
   */
  const executorIdentity: EndpointIdentity = {
    provider,
    model,
    ...(process.env.ANTHROPIC_BASE_URL || process.env.OPENAI_BASE_URL
      ? {
          baseURL:
            provider === "openai"
              ? process.env.OPENAI_BASE_URL
              : process.env.ANTHROPIC_BASE_URL,
        }
      : {}),
  };
  /**
   * 上下文窗口（事实）与压缩水位（策略）分开解析（MEM-01）。窗口 env > learned > registry > unknown；
   * 水位 run/env/包覆盖，否则窗口已知跟 maxBudget，未知回落 150k。非法 env 当场退出。
   */
  const contextPlanFor = (p?: DomainPack, tokens?: number): ContextPlan => {
    const windowInfo = resolveContextWindow(executorIdentity);
    return planContextBudget({
      window: windowInfo.window,
      windowSource: windowInfo.windowSource,
      maxTokens: tokens ?? maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(readContextLimitEnv() !== undefined ? { envLimit: readContextLimitEnv()! } : {}),
      ...(p?.guardrails?.contextTokenLimit !== undefined ? { packLimit: p.guardrails.contextTokenLimit } : {}),
    });
  };
  let contextPlan: ContextPlan;
  try {
    contextPlan = contextPlanFor(pack);
  } catch (err) {
    console.error(c.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
  const contextTokenLimit = contextPlan.budget;
  console.log(c.dim(describeContextPlan(contextPlan)));
  if (contextPlan.warning) console.log(c.yellow(`⚠ ${contextPlan.warning}`));
  const compactSummaryOn = (() => {
    const v = process.env.AGENT_COMPACT_SUMMARY?.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
  })();
  const compactSummaryMaxTokens = process.env.AGENT_COMPACT_SUMMARY_MAX_TOKENS
    ? Number(process.env.AGENT_COMPACT_SUMMARY_MAX_TOKENS)
    : undefined;
  if (
    compactSummaryMaxTokens !== undefined &&
    (!Number.isInteger(compactSummaryMaxTokens) || compactSummaryMaxTokens < 64)
  ) {
    console.error(c.red(`AGENT_COMPACT_SUMMARY_MAX_TOKENS "${process.env.AGENT_COMPACT_SUMMARY_MAX_TOKENS}" 无效：需为 ≥64 的整数`));
    process.exit(1);
  }
  const maxTurns = pack?.guardrails?.maxTurns;
  const positiveEnv = (name: string): number | undefined => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      console.error(c.red(`${name} "${raw}" 无效：需为 ≥1 的整数`));
      process.exit(1);
    }
    return value;
  };
  const nonNegativeEnv = (name: string): number | undefined => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      console.error(c.red(`${name} "${raw}" 无效：需为 ≥0 的整数`));
      process.exit(1);
    }
    return value;
  };
  const maxTotalTurns = positiveEnv("AGENT_TOTAL_MAX_TURNS");
  const maxTokensBudget = positiveEnv("AGENT_TOTAL_TOKEN_BUDGET");
  // 单个 tool_result 入口截断上限（MEM-01 Phase C）；缺省 40k，下限 1000——再小连截断标记都放不下
  const toolResultMaxChars = (() => {
    const raw = process.env.AGENT_TOOL_RESULT_MAX_CHARS;
    if (raw === undefined || raw === "") return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1000) {
      console.error(c.red(`AGENT_TOOL_RESULT_MAX_CHARS "${raw}" 无效：需为 ≥1000 的整数`));
      process.exit(1);
    }
    return value;
  })();
  /**
   * 恢复策略三级解析：env > 包 `recovery` > 默认（口径同 verifyMaxTurnsOf / planner 预算）。
   * env 侧逐字段：只写了 AGENT_STAGNATION_WINDOW 时另两个仍落到包/默认。
   */
  const envProgressExtensionTurns = nonNegativeEnv("AGENT_PROGRESS_EXTENSION_TURNS");
  const envStagnationWindow = nonNegativeEnv("AGENT_STAGNATION_WINDOW");
  const envMaxStagnationRecoveries = nonNegativeEnv("AGENT_MAX_STAGNATION_RECOVERIES");
  const envRecovery: RecoveryPolicy = {
    ...(envProgressExtensionTurns !== undefined ? { progressExtensionTurns: envProgressExtensionTurns } : {}),
    ...(envStagnationWindow !== undefined ? { stagnationWindow: envStagnationWindow } : {}),
    ...(envMaxStagnationRecoveries !== undefined
      ? { maxStagnationRecoveries: envMaxStagnationRecoveries }
      : {}),
  };
  const recoveryFor = (p?: DomainPack) => resolveRecoveryPolicy({ explicit: envRecovery, pack: p?.recovery });
  const maxAskRounds = positiveEnv("AGENT_MAX_ASK_ROUNDS");

  // 跨会话记忆（L5）：resolveMemoryDir = AGENT_MEMORY_DIR ?? <cwd>/.agent-memory
  const memory = new MemoryStore(resolveMemoryDir(process.cwd()));

  // MCP 工具（可选）：./mcp.json 存在即连接，AGENT_MCP_CONFIG 覆盖路径；
  // 领域包可整体关闭（mcp: false）；白名单/审批策略在最终工具面
  // 由 selectPackTools 统一解析，不再先改 server 配置。这样 CLI/Web/计划子任务同口径。
  const mcpConfigPath = process.env.AGENT_MCP_CONFIG ?? path.join(process.cwd(), "mcp.json");
  const catalogSkillRoot = resolveSkillsDir({ workdir: process.cwd(), realHost: true });
  const catalogInstallTool = installMcpTool({
    configPath: mcpConfigPath,
    workdir: process.cwd(),
    writesArmed: true,
    mcpEnabled: true,
    ...(catalogSkillRoot ? { skillRoot: catalogSkillRoot } : {}),
  });
  const mcpConfigRaw = await loadMcpConfig(mcpConfigPath);
  // 按包过滤要拉起的 server：ts-coding 只要 GitHub，不得顺带启动 stm32。
  // GitHub 是工作区连接器——python-coding 这类 mcp:false 仍可单独拉起 github。
  const mcpConfig = mcpConfigRaw
    ? filterMcpConfigForPack(mcpConfigRaw, pack?.mcp, { hostGithub: packAcceptsHostGithub(pack) })
    : undefined;
  const executionPolicy = parseExecutionPolicy();
  // required 的语义是“所有任意执行面都不得落宿主”。stdio MCP 当前是宿主长驻
  // 进程且跨 run 共享；在 managed-spawn/gateway 完成前必须先拒绝，不能连上后再说。
  if (executionPolicy.mode === "required" && mcpConfigHasRunnableServers(mcpConfig)) {
    throw new Error(
      "AGENT_EXECUTION_ISOLATION=required cannot start stdio MCP in this release; " +
      "disable MCP or use a separately managed hardware/service gateway",
    );
  }
  const mcp = mcpConfig ? await connectMcpServers(mcpConfig, (m) => console.warn(c.yellow(m))) : undefined;
  if (mcp) {
    for (const [server, count] of Object.entries(mcp.summary)) {
      console.log(c.dim(`mcp: connected "${server}" (${count} tools)`));
    }
    for (const [server, reason] of Object.entries(mcp.skipped)) {
      console.log(c.dim(`mcp: skipped "${server}" (${reason})`));
    }
  }

  /**
   * 识图：执行者自己能看图 → describe_image 走执行模型，不另引识图角色。
   * 执行者看不见（DeepSeek / 普通 Kimi）→ 才引用 AGENT_VISION_MODEL。
   * 两边都没有 → 不摆一个一调用就报错的工具。
   */
  let executorVisionProbed: boolean | null = null;
  if (shouldRunModelProbe(process.env)) {
    const executorVision = await probeVisionSupport({
      identity: executorIdentity,
      ...(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY
        ? { apiKey: process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY }
        : {}),
    });
    if (executorVision.source === "probe") executorVisionProbed = executorVision.supportsVision;
  }
  const executorCanSee = resolveExecutorVisionSupport({
    modelName: model,
    probed: executorVisionProbed,
  });
  const visionModelName = executorCanSee ? undefined : process.env.AGENT_VISION_MODEL;
  const visionProvider = visionModelName
    ? await createModelClientWithProbe(visionModelName, {
        ...(process.env.AGENT_VISION_PROVIDER
          ? { provider: process.env.AGENT_VISION_PROVIDER as "anthropic" | "openai" }
          : {}),
        ...(process.env.AGENT_VISION_BASE_URL ? { baseURL: process.env.AGENT_VISION_BASE_URL } : {}),
        ...(process.env.AGENT_VISION_API_KEY ? { apiKey: process.env.AGENT_VISION_API_KEY } : {}),
      })
    : undefined;
  /**
   * 识图探针（MODEL-01）：AGENT_MODEL_PROBE=1 时对 vision 端点塞最小图。
   * 明确不支持 → 不注册 describe_image（与"没配就不注册"同纪律）。
   */
  let visionSupportsVision = true;
  if (visionProvider && visionModelName) {
    const visionProbe = await probeVisionSupport({
      identity: {
        provider: visionProvider.provider,
        model: visionModelName,
        ...(process.env.AGENT_VISION_BASE_URL
          ? { baseURL: process.env.AGENT_VISION_BASE_URL }
          : {}),
      },
      ...(process.env.AGENT_VISION_API_KEY
        ? { apiKey: process.env.AGENT_VISION_API_KEY }
        : {}),
    });
    visionSupportsVision = visionProbe.supportsVision;
    if (!visionSupportsVision) {
      console.log(
        c.yellow(
          `vision model ${visionModelName} 不支持识图（${visionProbe.reason ?? "probe"}）——不注册 describe_image`,
        ),
      );
    } else if (visionProbe.source === "probe") {
      console.log(c.dim(`vision probe: supportsVision=true (${visionProbe.reason ?? "ok"})`));
    }
  }
  if (visionProvider && visionSupportsVision) console.log(c.dim(`vision model: ${visionModelName}`));

  /**
   * 端点降级链（MODEL-01a/b）。执行者默认可配 AGENT_FALLBACK_*；
   * verifier/planner/vision 各自 AGENT_<ROLE>_FALLBACK_MODEL 或 =inherit。
   * 熔断按端点身份共享（sharedBreakerRegistry），装饰器实例按角色隔离。
   * 不配则不包装饰器。降级事件走唯一的 renderEvent。
   */
  let fallbackCount = 0;
  let cliTokenSpend = 0;
  const onAnyFallback = (info: {
    from: string;
    to: string;
    reason: string;
    turn: number;
    role?: string;
    routing?: string;
  }) => {
    fallbackCount += 1;
    void renderEvent({
      type: "model_fallback",
      from: info.from,
      to: info.to,
      reason: info.reason,
      turn: info.turn,
      ...(info.role ? { role: info.role } : {}),
      ...(info.routing ? { routing: info.routing } : {}),
    });
  };
  const modelClient = createFallbackClientIfConfigured(
    {
      name: model,
      client: resolvedClient,
      identity: executorIdentity,
    },
    process.env,
    onAnyFallback,
    { role: "executor", breakerRegistry: sharedBreakerRegistry },
  );
  if (modelClient instanceof FallbackModelClient) {
    console.log(
      c.dim(
        `fallback chain [executor/${modelClient.routingPolicy()}]: ${modelClient.chain().join(" → ")}` +
          (executorCaps.source !== "name" ? ` · compat=${compat} via ${executorCaps.source}` : ""),
      ),
    );
  } else if (executorCaps.source === "probe" || executorCaps.source === "sticky") {
    console.log(c.dim(`model probe: compat=${compat} healthy=${executorCaps.healthy} (${executorCaps.reason ?? executorCaps.source})`));
  }

  const executorBackups = executorBackupEndpoints(modelClient);
  const wrapRole = (
    role: "verifier" | "planner" | "vision",
    name: string,
    client: typeof resolvedClient,
    roleProvider: typeof provider,
    baseURL?: string,
  ) =>
    createRoleFallbackClient({
      role,
      primary: {
        name,
        client,
        identity: {
          provider: roleProvider,
          model: name,
          ...(baseURL ? { baseURL } : {}),
        },
      },
      executorFallbacks: executorBackups,
      onFallback: onAnyFallback,
      breakerRegistry: sharedBreakerRegistry,
    });

  const verifierClient = verifierProvider
    ? wrapRole(
        "verifier",
        verifierModelName!,
        verifierProvider.client,
        verifierProvider.provider,
        process.env.AGENT_VERIFIER_BASE_URL,
      )
    : undefined;
  const plannerClient = plannerProvider
    ? wrapRole(
        "planner",
        plannerModelName!,
        plannerProvider.client,
        plannerProvider.provider,
        process.env.AGENT_PLANNER_BASE_URL,
      )
    : undefined;
  const visionClient = visionProvider && visionSupportsVision
    ? wrapRole(
        "vision",
        visionModelName!,
        visionProvider.client,
        visionProvider.provider,
        process.env.AGENT_VISION_BASE_URL,
      )
    : undefined;
  if (verifierClient instanceof FallbackModelClient) {
    console.log(c.dim(`fallback chain [verifier]: ${verifierClient.chain().join(" → ")}`));
  }
  if (plannerClient instanceof FallbackModelClient) {
    console.log(c.dim(`fallback chain [planner]: ${plannerClient.chain().join(" → ")}`));
  }
  if (visionClient instanceof FallbackModelClient) {
    console.log(c.dim(`fallback chain [vision]: ${visionClient.chain().join(" → ")}`));
  }

  const describeBacking = resolveDescribeImageBacking({
    executorSupportsVision: executorCanSee,
    visionRoleConfigured: Boolean(visionProvider && visionModelName),
    visionRoleSupportsVision: visionSupportsVision,
  });
  const visionTool = assembleDescribeImageTool({
    backing: describeBacking,
    executor: { client: modelClient, modelName: model },
    ...(visionClient && visionModelName
      ? { vision: { client: visionClient, modelName: visionModelName } }
      : {}),
  });
  if (describeBacking === "executor") {
    console.log(c.dim(`describe_image: executor (${model})`));
  } else if (describeBacking === "vision-role") {
    console.log(c.dim(`describe_image: vision-role (${visionModelName})`));
  }
  /**
   * 生图（第五个角色）。Images API 不是 chat——不包 ModelClient、不进降级链。
   * 配了才注册 generate_image，没配就不摆一个一调用就报错的工具。
   */
  const imageModelName = process.env.AGENT_IMAGE_MODEL;
  const imageBaseURL = (
    process.env.AGENT_IMAGE_BASE_URL
    || process.env.OPENAI_BASE_URL
    || DEFAULT_OPENAI_IMAGE_BASE
  ).replace(/\/+$/, "");
  let imageTool: ReturnType<typeof createGenerateImageTool> | undefined;
  if (imageModelName) {
    assertSafeProviderEndpoint(imageBaseURL, "AGENT_IMAGE_BASE_URL");
    imageTool = createGenerateImageTool({
      client: createOpenAIImageClient({
        model: imageModelName,
        baseURL: imageBaseURL,
        apiKey: process.env.AGENT_IMAGE_API_KEY || process.env.OPENAI_API_KEY || "",
      }),
      modelName: imageModelName,
    });
    console.log(c.dim(`image model: ${imageModelName}`));
  }
  const webSearchTool = isWebSearchConfigured() ? createWebSearchTool() : undefined;
  if (webSearchTool) console.log(c.dim("web_search: Tavily configured"));

  // 内置工具按包名单装配（缺省全带）——领域包只带用得上的，减少触发面噪声
  const builtinByName = new Map(
    [
      bashTool,
      fetchUrlTool,
      readFileTool,
      writeFileTool,
      writePptxTool,
      editFileTool,
      globTool,
      grepTool,
      updateProgressTool,
      draftDomainPackTool(),
      catalogInstallTool,
      ...(webSearchTool ? [webSearchTool] : []),
      ...(visionTool ? [visionTool] : []),
      ...(imageTool ? [imageTool] : []),
    ].map((t) => [t.name, t]),
  );
  const builtinNames = pack?.builtinTools ?? [...builtinByName.keys()];
  /**
   * 条件性内置工具：包可以声明，但只在宿主配好依赖时在场（缺席=干净省略+提示，
   * 不炸）。严格校验保留给真正的拼写错误——两类错误的处置必须不同：
   * 前者是合法配置组合，后者是包写错了。案例 #11 首发实测：kicad 包声明
   * describe_image 而执行者不能看图、也未配 AGENT_VISION_MODEL，启动即炸——省略才是正确语义
   * （plan 模式的 selectPackTools 本就静默过滤，两条装配路径的语义要一致）。
   */
  const CONDITIONAL_BUILTINS = new Set(["describe_image", "web_search", "generate_image"]);
  const ALWAYS_ON = ALWAYS_ON_BUILTIN_TOOLS;
  const namesForPool = [...new Set([...builtinNames, ...ALWAYS_ON])];
  const builtins = namesForPool.flatMap((n) => {
    const t = builtinByName.get(n);
    if (t) return [t];
    if (CONDITIONAL_BUILTINS.has(n)) {
      console.log(c.dim(`（包声明的 ${n} 未配置对应模型，本次不带）`));
      return [];
    }
    throw new Error(`Pack "${pack?.name}" 声明了未知内置工具: ${n}`);
  });

  // --plan 的子任务可换到任意候选 pack；即使未来 planner 基础工具面被收窄，
  // broker 也必须在第一次 planner 调用前固定并完成 required preflight。
  const executionBroker = (withPlan || builtins.some((tool) => tool.name === "bash"))
    ? createExecutionBroker({
        boundaryId: `cli-${randomUUID()}`,
        workdir: path.resolve(process.cwd()),
      })
    : undefined;
  activeCliExecutionBroker = executionBroker;
  const executionStatus = executionBroker ? await executionBroker.probe() : undefined;
  if (executionStatus?.effectiveState === "failed") {
    throw new Error(
      `Command execution unavailable under required isolation: ${executionStatus.probe.reason ?? "probe failed"}`,
    );
  }
  if (executionStatus) {
    const line =
      `execution: ${executionStatus.effectiveState} / ${executionStatus.resolvedBackend ?? "none"} ` +
      `(mode=${executionStatus.requestedMode}, probe=${executionStatus.probe.state})`;
    console.log(
      executionStatus.effectiveState === "partial"
        ? c.cyan(line)
        : c.yellow(`${line} — shell commands are not run-isolated`),
    );
  }

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
  /**
   * 核查白名单：包说了算（没声明也不补）；**无包**才用 AGENT_VERIFY_READONLY_COMMANDS > 通用缺省
   * （委托方批准的例外——无包核查者连 ls/cat 都被拒，3 行文件核查 7 轮 153 s 落 unverified）。
   */
  const readOnlyFor = (p?: DomainPack) =>
    resolveVerifierReadOnlyCommands(p, process.env.AGENT_VERIFY_READONLY_COMMANDS);
  if (withVerify || withPlan) {
    const ro = readOnlyFor(pack);
    console.log(c.dim(`verifier whitelist: ${ro.commands.length} 条 (${ro.source})`));
  }

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

  const memShared = isSharedMemoryDir(process.cwd(), memory.dir);
  const officeNotifier = createOfficeNotifier(resolveOfficeNotifyFromEnv(process.env) ?? { enabled: false });
  const notifyHint = notifyArmedHint(officeNotifier.armed);
  if (notifyHint) console.log(c.dim(notifyHint));
  const memTools = [
    ...createMemoryTools(memory),
    createProjectStatusTool(() => memory, {
      sharedFor: () => memShared,
      onBoardChange: (status, project) => {
        void officeNotifier.notify(gateNotifyPayloadFromBoard(status, project)).catch(() => {
          /* 出站失败不打断 CLI 工具 */
        });
      },
    }),
  ];

  /**
   * §5.2 需求澄清。**决定 1：默认关，逐 run 显式开**（`--ask`）。
   * 与计划确认门同一条理由：CLI 也被脚本化驱动（eval、契约测试、cron），
   * 默认开会让那些场景挂死等一个不会来的人。
   *
   * `--yes`（无人值守）下即使显式开也不装：那条路径根本没有 readline，
   * 装了等于每个问题都立刻走"未应答"，白烧一轮往返。
   */
  const canPrompt = cliCanPrompt();
  const askEnabled = parsedArgs.ask && canPrompt;
  if (parsedArgs.ask && !canPrompt) {
    console.log(c.yellow("没有交互终端，--ask 未装。需要确认时请加 --yes 或在 TTY 里跑。"));
  }
  const rl = autoYes || !canPrompt ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  // 计划并发下多个执行者可能同时触发同一个 ask_user。readline 不能并排挂多个
  // question；这里把“向人提问”串行化，执行工具本身仍可并发。
  let terminalQuestionTail: Promise<unknown> = Promise.resolve();
  const askUserTools = askEnabled
    ? [
        createAskUserTool({
          ...(maxAskRounds !== undefined ? { maxRounds: maxAskRounds } : {}),
          // 一次一组（决定 6）：终端里逐题问，但这**是一次打断**，不是三次
          ask({ questions }) {
            const job = terminalQuestionTail.then(async () => {
              endStreamLine();
              console.log(
                c.cyan(`\n◆ agent 有 ${questions.length} 个问题需要你定（回车跳过单题）`),
              );
              const answers: (string | null)[] = [];
              for (const [i, q] of questions.entries()) {
                console.log(c.cyan(`\n[${i + 1}/${questions.length}] ${q.question}`));
                q.options.forEach((o, n) => console.log(c.dim(`   ${n + 1}) ${o}`)));
                console.log(c.dim(`   （回车跳过，按此默认执行：${q.fallback}）`));
                const raw = (await rl!.question("> ")).trim();
                if (raw === "") {
                  answers.push(null);
                  continue;
                }
                // 数字 = 选项序号：让"点一下就能答"在终端里也成立
                const pick = Number(raw);
                answers.push(
                  Number.isInteger(pick) && pick >= 1 && pick <= q.options.length
                    ? q.options[pick - 1]!
                    : raw,
                );
              }
              return answers;
            });
            terminalQuestionTail = job.catch(() => undefined);
            return job;
          },
        }),
      ]
    : [];
  const proposeHandoffTools = pack?.handoffs?.length
    ? [
        createProposeHandoffTool({
          resolveHandoff: (id) => findPackHandoff(pack, id),
          onPropose: (proposal) => {
            console.log(c.cyan(`\n◇ 下一步（不挡对话）：${proposal.label}`));
            console.log(c.dim(`  ${proposal.summary}`));
            console.log(c.dim(`  要拒绝就当没看见（${proposal.declineLabel}）。Web 宿主可点按钮开跑。`));
          },
        }),
      ]
    : [];

  /**
   * AGENT-02：默认关。AGENT_SPAWN_TASK=1 才装。子支线扣同一份谱系预算、深度 1。
   * Windows 隔离仍是 report（见 SAFE-05）——不假装 AGENT-03 完成。
   */
  const spawnEnabled = process.env.AGENT_SPAWN_TASK === "1" || process.env.AGENT_CAMPAIGN === "1";
  const lineageBudget = createRunBudget({
    ...(maxTotalTurns !== undefined ? { maxTurns: maxTotalTurns } : {}),
    ...(maxTokensBudget !== undefined ? { maxTokens: maxTokensBudget } : {}),
  });
  // spawn 回调闭包读这份——须在 baseConfig 之后赋值（见下）
  let spawnParentConfig: import("./types.js").AgentConfig | null = null;
  const spawnTaskTools = spawnEnabled
    ? [
        createSpawnTaskTool({
          depth: 0,
          spawn: async (request) => {
            if (!spawnParentConfig) {
              return { summary: "", passed: false, error: "spawn 父配置尚未就绪" };
            }
            endStreamLine();
            console.log(c.cyan(`\n⧉ 支线开始：${request.title}`));
            return runSpawnedTask({
              parentConfig: spawnParentConfig,
              modelClient,
              runBudget: lineageBudget,
              request,
              onEvent: async (event) => {
                if (event.type === "tool_call") {
                  console.log(c.dim(`  ║ → ${event.name}`));
                } else if (event.type === "done") {
                  console.log(
                    c.dim(
                      `  ║ 支线 ${event.result.stopReason}（${event.result.usage.turns} 轮）`,
                    ),
                  );
                }
              },
            });
          },
          onDone: (_req, result) => {
            endStreamLine();
            console.log(
              result.passed
                ? c.green(`⧉ 支线完成：${result.summary.slice(0, 80)}`)
                : c.yellow(`⧉ 支线未完成：${result.error ?? result.summary.slice(0, 80)}`),
            );
          },
        }),
      ]
    : [];
  if (spawnEnabled) {
    console.log(c.dim(`spawn_task: on（深度 1，并发 cap=${AUTO_CONCURRENCY_CAP}，扣父谱系预算）`));
  }

  const cliArchive = {
    task: task || (withPlan ? "接着跑半截计划" : "接着上次的检查点继续"),
    mode: withPlan ? ("plan" as const) : ("single" as const),
    verify: withVerify,
    packName: pack?.name ?? null,
    effort: effort ?? null,
    workdir: process.cwd(),
    askUser: parsedArgs.ask,
    contextTokenLimit: contextTokenLimit ?? null,
    rubric: envRubric ?? pack?.verify.rubric ?? null,
  };
  let cliRunId = `cli-${Date.now()}`;
  let cliDurable: CliDurableHandle | undefined;
  let cliPlanResume: (ReturnType<typeof prepareCliPlanResume> & { ok: true }) | undefined;
  let cliSingleResume:
    | {
        state: import("./run-state.js").DurableRunState;
        history: import("./types.js").AgentRunResult["messages"];
      }
    | undefined;
  const historyRoot =
    resumeRun || cliDurableEnabled() ? await ensureCliHistoryRoot(process.cwd()) : undefined;
  if (resumeRun) {
    if (!cliDurableEnabled()) {
      console.error(c.red("--resume-run 需要 durable state（不要设 AGENT_CLI_DURABLE=0）"));
      process.exit(1);
    }
    const archiveDir = path.join(historyRoot!, resumeRun);
    const loaded = await readArchivedState(archiveDir);
    const archiveTask = readCliArchiveTask(archiveDir);
    const stopResume = (reason: string): never => {
      console.error(
        c.red(
          formatCliResumeStop({
            runId: resumeRun,
            reason,
            task: archiveTask || String(task ?? "").trim(),
            phase: loaded?.phase,
          }),
        ),
      );
      process.exit(1);
    };
    if (withPlan) {
      const decided = prepareCliPlanResume(loaded, {
        hasTask: Boolean(String(task ?? "").trim() || archiveTask),
      });
      if (!decided.ok) stopResume(decided.reason);
      else cliPlanResume = decided;
    } else {
      const history = lastExecutorTranscriptMessages(await readArchivedTranscript(archiveDir));
      const decided = prepareCliSingleResume(loaded, {
        hasHistory: Boolean(history?.length),
        verify: parsedArgs.verify,
        hasTask: Boolean(String(task ?? "").trim() || archiveTask),
      });
      if (!decided.ok) stopResume(decided.reason);
      else if (!history?.length) stopResume("同 run 恢复缺少正史");
      else cliSingleResume = { state: decided.state, history };
    }
    const resumeState = cliPlanResume?.state ?? cliSingleResume?.state;
    if (!resumeState) {
      console.error(c.red(`不能续跑 ${resumeRun}：没有可恢复的状态`));
      process.exit(1);
    }
    cliRunId = resumeRun;
    cliDurable = createCliDurable({
      runId: resumeRun,
      cwd: process.cwd(),
      existing: resumeState,
      archive: cliArchive,
    });
    if (resumeState.budget) {
      seedDurableBudget(lineageBudget, resumeState.budget);
      console.log(
        c.dim(
          `durable resume budget: turns ${lineageBudget.usedTurns}${lineageBudget.maxTurns !== undefined ? `/${lineageBudget.maxTurns}` : ""} tokens ${lineageBudget.usedTokens}${lineageBudget.maxTokens !== undefined ? `/${lineageBudget.maxTokens}` : ""}`,
        ),
      );
    }
    console.log(c.dim(`durable resume: ${resumeRun} → .agent-run-history/${resumeRun}/state.json`));
  } else if (cliDurableEnabled()) {
    cliDurable = createCliDurable({ runId: cliRunId, cwd: process.cwd(), archive: cliArchive });
    console.log(c.dim(`durable: ${cliRunId} → .agent-run-history/${cliRunId}/state.json`));
  }
  activeCliDurable = cliDurable;
  activeCliLineageBudget = lineageBudget;

  try {
    resolvePermissionMode(process.env.AGENT_PERMISSION_MODE);
  } catch (err) {
    console.error(c.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
  const permissionSwitches = cliRuntimePermissionSwitches({ autoYes, planMode: withPlan });
  console.log(
    c.dim(formatPermissionBanner(matchPermissionMode(permissionSwitches), permissionSwitches)),
  );

  let hookSpec: NormalizedHookSpec | null = null;
  try {
    hookSpec = resolveHooksFromEnv(process.env);
  } catch (err) {
    console.error(c.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
  const hookRuntime = hookSpec
    ? createHookRuntime(hookSpec, { workdir: process.cwd() })
    : undefined;
  if (hookSpec) {
    console.log(
      c.dim(`hooks: PreToolUse/PostToolUse/Stop timeout=${hookSpec.timeoutMs}ms ← ${hookSpec.sourcePath}`),
    );
  }

  let agentMdMaxChars = DEFAULT_AGENT_MD_MAX_CHARS;
  try {
    agentMdMaxChars = resolveAgentMdMaxChars(process.env);
  } catch (err) {
    console.error(c.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
  const agentMdBundle: AgentMdBundle | null = loadAgentMd({
    workdir: process.cwd(),
    userHome: homedir(),
    maxChars: agentMdMaxChars,
    onWarn: (message) => console.warn(c.yellow(message)),
  });
  const agentMdLine = formatAgentMdStartupLine(agentMdBundle);
  if (agentMdLine) console.log(c.dim(agentMdLine));
  const workspaceGit = await probeWorkspaceGit(process.cwd());
  if (workspaceGit.present) console.log(c.dim(`git: ${formatWorkspaceGitLine(workspaceGit)}`));

  const baseConfig: AgentConfig = {
    systemPrompt: withEnabledSkills(pack?.systemPrompt ?? SYSTEM_PROMPT, catalogSkillRoot),
    tools: [
      ...selectPackTools(pack, builtins, mcp?.tools ?? []),
      ...memTools,
      ...askUserTools,
      ...proposeHandoffTools,
      ...spawnTaskTools,
    ],
    workdir: process.cwd(),
    ...(hookRuntime ? { hooks: hookRuntime } : {}),
    runBudget: lineageBudget,
    // SAFE-06 + RUN-01：CLI durable 落 state.json；关 AGENT_CLI_DURABLE=0 退回纯内存
    runId: cliRunId,
    ...(cliDurable ? { toolTx: cliDurable.toolTx } : {}),
    ...(executionBroker ? { executionBroker } : {}),
    ...(readRoots.length ? { readRoots } : {}),
    compat,
    ...(effort ? { effort } : {}),
    contextTokenLimit,
    /**
     * 窗口学习钩子：loop 撞 400 学到的窗口记到执行者端点名下（provider|model|origin），
     * 落盘到 .agent-capabilities.json——下一次同端点的运行启动行就会写「来源：learned」。
     * 独立角色模型（verifier / planner）的 loop 由编排层剥掉这个钩子，它们的 400 不算执行者的。
     */
    onContextWindowLearned: (windowTokens) => {
      learnContextWindow(executorIdentity, windowTokens);
    },
    maxTokens,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(maxTotalTurns !== undefined ? { maxTotalTurns } : {}),
    ...(maxTokensBudget !== undefined ? { maxTokensBudget } : {}),
    ...(toolResultMaxChars !== undefined ? { toolResultMaxChars } : {}),
    ...(compactSummaryOn
      ? {
          compactSummaryClient: modelClient,
          ...(compactSummaryMaxTokens !== undefined
            ? { compactSummaryMaxTokens }
            : {}),
        }
      : {}),
    // 易变信息走 messages 注入（P3），system prompt 保持字节冻结
    dynamicContext: mergeAgentMdContext({
      date: new Date().toISOString().slice(0, 10),
      platform: process.platform,
      shell: SHELL_DESC,
      workdir: process.cwd(),
      workspace_git: formatWorkspaceGitLine(workspaceGit),
      ...(executionStatus
        ? {
            execution_isolation:
              `${executionStatus.effectiveState}/${executionStatus.resolvedBackend ?? "none"}/${executionStatus.policyDigest}`,
          }
        : {}),
      ...(readRoots.length ? { read_only_roots: readRoots.join("; ") } : {}),
      memory_index: await scopedMemoryIndex(memory, process.cwd()),
      project_status: formatProjectStatusBlock(await readProjectStatus(memory, process.cwd(), memShared)),
    }, agentMdBundle),
  };
  // 主执行者默认走结构化完成门；设 AGENT_REQUIRE_FINISH_TASK=0 可为兼容端点退回旧语义。
  const taskCompletionEnabled = process.env.AGENT_REQUIRE_FINISH_TASK !== "0";
  const config: AgentConfig = taskCompletionEnabled
    ? withTaskCompletion(baseConfig, recoveryFor(pack).policy)
    : baseConfig;
  spawnParentConfig = config;
  if (taskCompletionEnabled) {
    // 与 pack/verifier/planner 那几行同款：报数字带来源，装配变了这一行就变
    const r = recoveryFor(pack);
    const fmt = (k: keyof typeof r.policy) => `${r.policy[k]}(${r.sources[k]})`;
    console.log(
      c.dim(
        `recovery: extension=${fmt("progressExtensionTurns")} stagnation=${fmt("stagnationWindow")} recoveries=${fmt("maxStagnationRecoveries")}`,
      ),
    );
  }
  // OBS-01：工具面齐了再写根 span，否则 schema 哈希是空壳
  cliDurable?.beginTrace({
    tools: config.tools,
    packName: pack?.name ?? null,
    model,
  });
  let streamingText = false;
  const cliArtifactTools = new Set(["write_file", "write_pptx", "edit_file"]);
  const pendingArtifactPaths = new Map<string, string>();
  const writtenArtifactPaths = new Set<string>();
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
  // 执行者谱系的恢复决策计数（续跑/停滞/强制收口）——领域包该填几轮续跑，只能从它读出来
  const ledgerRecovery = emptyRecoveryTally();
  // 上下文压缩计数（全部角色）——反应式救回超长请求的代价此前只在事件流里可见
  const ledgerCompaction = emptyCompactionTally();
  const ledgerHooks: LedgerHooksTally | null = hookSpec ? emptyHooksTally() : null;
  const ledgerApprovals: LedgerApprovalsTally = emptyApprovalsTally();
  const respondCliApproval = (
    event: { respond: (decision: "allow" | "deny", reason?: string) => void },
    decision: "allow" | "deny",
    kind: "auto" | "user",
    reason?: string,
  ): void => {
    tallyApprovalOutcome(ledgerApprovals, {
      type: "approval_resolved",
      actor: kind === "auto" ? "auto-run" : "user",
      decision,
    });
    event.respond(decision, reason);
  };
  const settleCliApproval = async (
    event: Extract<TurnEvent, { type: "approval_request" }>,
    tag?: string,
  ): Promise<void> => {
    const head = tag ? `${tag} ` : "";
    if (autoYes) {
      console.log(c.yellow(`${head}⚠ auto-approved: ${formatApprovalPrompt(event)}`));
      respondCliApproval(event, "allow", "auto");
      return;
    }
    if (!rl) {
      console.error(c.red(formatCliNeedsConfirmMessage()));
      process.exit(CLI_NEEDS_CONFIRM_EXIT);
    }
    try {
      const answer = await rl.question(
        c.yellow(`${head}⚠ ${formatApprovalPrompt(event)}? [y/N] `),
      );
      if (answer.trim().toLowerCase() === "y") {
        respondCliApproval(event, "allow", "user");
        return;
      }
      const reasonPrompt = tag ? "  reason (optional): " : "  reason for the model (optional): ";
      const reason = (await rl.question(c.dim(reasonPrompt))).trim();
      respondCliApproval(event, "deny", "user", reason || undefined);
    } catch (err) {
      if (isReadlineClosedError(err)) {
        console.error(c.red(formatCliNeedsConfirmMessage()));
        process.exit(CLI_NEEDS_CONFIRM_EXIT);
      }
      throw err;
    }
  };
  let ledgerHitBudget = false;
  /** 三条路径各自把收尾事实归一到这里，最后统一写一行 */
  let ledgerFacts: {
    stopReason: string | null;
    error: string | null;
    turns: number | null;
    reworks: number | null;
    finalPassed: boolean | null;
    verifications: VerifyOutcome[];
  } | null = null;
  const ledgerStartedAt = Date.now();
  const noteForLedger = (source: string, event: TurnEvent): void => {
    cliDurable?.noteTrace(source, event);
    cliDurable?.noteEvent(source, event);
    if (event.type === "tool_call") tallyToolCall(ledgerTally, source, event.name);
    tallyRecoveryDecision(ledgerRecovery, source, event);
    tallyCompaction(ledgerCompaction, event);
    if (ledgerHooks) tallyHookEvent(ledgerHooks, event);
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
    const builtinPool = [
      bashTool,
      fetchUrlTool,
      readFileTool,
      writeFileTool,
      writePptxTool,
      editFileTool,
      globTool,
      grepTool,
      updateProgressTool,
      draftDomainPackTool(),
      catalogInstallTool,
      ...(webSearchTool ? [webSearchTool] : []),
      ...(visionTool ? [visionTool] : []),
      ...(imageTool ? [imageTool] : []),
    ];
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
          await settleCliApproval(event, tag);
          break;
        }
        case "compaction":
          console.log(c.yellow(`${tag} ${describeCompaction(event)}`));
          break;
        case "hook": {
          const who = event.tool ? `${event.hook} ${event.tool}` : event.hook;
          const extra = [
            event.timedOut ? "timeout" : event.exitCode != null ? `exit ${event.exitCode}` : null,
            event.detail,
          ].filter(Boolean).join(" · ");
          const line = extra ? `${tag} ‡ ${who} ${event.outcome}（${extra}）` : `${tag} ‡ ${who} ${event.outcome}`;
          console.log(event.outcome === "allow" ? c.dim(line) : c.yellow(line));
          break;
        }
        case "progress": {
          const done = event.items.filter((i) => i.status === "done").length;
          console.log(
            c.dim(`${tag} ▣ Progress ${done}/${event.items.length}`),
          );
          break;
        }
        case "api_retry":
          console.log(
            c.yellow(`${tag} ⟳ API 瞬时错误，同轮重试 #${event.attempt}（等待 ${event.backoffMs}ms）`),
          );
          break;
        case "model_call_start":
          console.log(c.dim(`${tag} ▷ 模型请求 #${event.attempt}（第 ${event.turn} 轮）`));
          break;
        case "model_call_end":
          console.log(
            c.dim(
              `${tag} ${event.status === "ok" ? "■" : "✗"} 模型请求 ${event.status} ${event.durationMs}ms`,
            ),
          );
          break;
        case "segment_resume":
          console.log(
            c.yellow(`${tag} ⟲ 整段因瞬时故障终止，带 ${event.priorTurns} 轮正史续跑：${event.reason}`),
          );
          break;
        case "recovery_decision": {
          const stall =
            event.reason === "end_turn_without_completion" || event.reason === "stagnation";
          console.log(c.yellow(`${tag} ${stall ? "⚠ 空转 · " : "⤷ "}${event.detail}`));
          break;
        }
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
    let livePlanNodes: PlanNodeState[] = cliPlanResume
      ? planNodesFromDurable(cliPlanResume.nodes)
      : [];
    const persistLivePlanNodes = () => {
      if (!cliDurable || !livePlanNodes.length) return;
      cliDurable.apply({ type: "plan_progress", nodes: livePlanNodes.map(durableNodeFromPlanNode) });
    };
    const plannedTask = task || "接着跑半截计划";
    if (cliPlanResume) {
      cliDurable?.apply({ type: "resume", at: Date.now() });
      const kept = livePlanNodes.filter((n) => n.status === "passed").map((n) => n.id);
      const remaining = livePlanNodes
        .filter((n) => n.status === "pending" || n.status === "running")
        .map((n) => n.id);
      console.log(c.cyan(`\n↺ 半截 DAG 续跑 kept=${kept.join(",")} remaining=${remaining.join(",")}`));
      cliDurable?.noteHostEvent(hostPlanResumeEvent({ kept, remaining, reason: plannedTask }));
    } else {
      cliDurable?.apply({ type: "plan_begin" });
    }
    let outcome: Awaited<ReturnType<typeof runPlanned>> | undefined;
    try {
    outcome = await runPlanned(config, modelClient, plannedTask, {
      packs: allPacks(),
      concurrency,
      plannerProtocol: planProtocol,
      ...(envPlanMaxTurns !== undefined ? { planMaxTurns: envPlanMaxTurns } : {}),
      ...(plannerProvider && plannerClient
        ? { plannerModel: { client: plannerClient, compat: plannerProvider.compat } }
        : {}),
      ...(cliPlanResume
        ? {
            plan: planFromNodes(livePlanNodes),
            resume: {
              nodes: livePlanNodes,
              handoffs: handoffsFromPlanNodes(livePlanNodes),
            },
          }
        : {}),
      onReplan: (diff) => {
        console.log(
          c.cyan(
            `\n⧉ 重规划 kept=${diff.kept.join(",")} added=${diff.added.join(",")} dropped=${diff.dropped.join(",")}`,
          ),
        );
        cliDurable?.noteHostEvent(hostPlanReplanEvent(diff));
      },
      onPlan: async (plan) => {
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
        console.log(formatCliPlanShortTable(plan));
        for (const s of plan.subtasks) {
          for (const a of s.acceptance) console.log(c.dim(`    验收: ${a}`));
        }

        const skipGate = Boolean(cliPlanResume);
        const gateMode = resolveCliPlanGateMode({ autoYes, canPrompt });
        const gated = !skipGate && gateMode !== "auto";

        if (!cliPlanResume) {
          livePlanNodes = planNodesFromSubtasks(plan.subtasks, "pending");
          if (gated) {
            cliDurable?.apply({
              type: "plan_ready",
              plan: durablePlanFromPlan(plan, planProtocol, livePlanNodes),
              gated: true,
            });
          }
        }

        if (!skipGate) {
          const decision = await confirmCliPlan({
            plan,
            autoYes,
            canPrompt,
            question: async (prompt) => {
              if (!rl) {
                throw Object.assign(new Error("readline was closed"), { code: "ERR_USE_AFTER_CLOSE" });
              }
              return rl.question(prompt);
            },
          });
          if (decision.kind === "need_yes") {
            console.error(c.red(formatCliNeedsConfirmMessage()));
            process.exit(CLI_NEEDS_CONFIRM_EXIT);
          }
          if (decision.kind === "reject") {
            cliDurable?.apply({ type: "plan_rejected", at: Date.now() });
            throw new CliPlanRejectedError();
          }
          if (decision.edits.length) {
            applyCliPlanTitleEdits(plan, decision.edits);
            livePlanNodes = planNodesFromSubtasks(plan.subtasks, "pending");
            console.log(
              c.dim(`已改标题：${decision.edits.map((e) => `${e.id} → ${e.title}`).join("；")}`),
            );
          }
        }

        if (!cliPlanResume) {
          if (gated) {
            cliDurable?.apply({ type: "plan_approved", at: Date.now() });
          } else {
            cliDurable?.apply({
              type: "plan_ready",
              plan: durablePlanFromPlan(plan, planProtocol, livePlanNodes),
              gated: false,
            });
          }
          cliDurable?.noteHostEvent(
            hostPlanEvent({
              concurrency: effectiveConcurrency,
              concurrencyMode: concurrency === "auto" ? "auto" : "fixed",
              plannerMs: planReadyAt - startedAt,
              subtasks: hostPlanSubtaskViews(plan.subtasks, (name) => getPack(name)?.resources),
              gated,
            }),
          );
        }
      },
      onSubtaskStart: (sub) => {
        livePlanNodes = livePlanNodes.map((n) =>
          n.id === sub.id ? { ...n, status: "running" as const } : n,
        );
        persistLivePlanNodes();
      },
      onSubtaskSettled: (sub, result) => {
        const evidence = evidenceFromVerifiedStep(result);
        livePlanNodes = livePlanNodes.map((n) =>
          n.id === sub.id
            ? {
                ...n,
                status: result.finalPassed ? ("passed" as const) : ("failed" as const),
                ...(evidence ? { evidenceSummary: evidence } : {}),
              }
            : n,
        );
        persistLivePlanNodes();
        const budget = result.main.runBudget;
        if (budget) {
          cliDurable?.apply({ type: "budget_snapshot", budget: snapshotDurableBudget(budget) });
        }
      },
      resolveSubtask: (sub) => {
        const p = sub.pack ? getPack(sub.pack) : undefined;
        if (sub.pack && !p) console.log(c.yellow(`⚠ 未知领域包 "${sub.pack}"，子任务 ${sub.id} 用默认配置执行`));
        // 包选择只收窄领域工具；ask_user / finish_task 是执行控制面，不能被覆盖掉。
        const controlTools = config.tools.filter(
          (tool) => tool.name === ASK_USER_TOOL_NAME || tool.name === FINISH_TASK_TOOL_NAME,
        );
        const proposeForSub = p?.handoffs?.length
          ? [
              createProposeHandoffTool({
                resolveHandoff: (id) => findPackHandoff(p, id),
                onPropose: (proposal) => {
                  console.log(c.cyan(`\n◇ 下一步（不挡对话）：${proposal.label}`));
                  console.log(c.dim(`  ${proposal.summary}`));
                },
              }),
            ]
          : [];
        return {
          cfg: {
            ...config,
            systemPrompt: p?.systemPrompt
              ? withEnabledSkills(p.systemPrompt, catalogSkillRoot)
              : config.systemPrompt,
            tools: [
              ...selectPackTools(p, builtinPool, mcpPool),
              ...memTools,
              ...controlTools,
              ...proposeForSub,
            ].filter((tool, i, all) => all.findIndex((candidate) => candidate.name === tool.name) === i),
            ...(p?.guardrails?.maxTurns !== undefined ? { maxTurns: p.guardrails.maxTurns } : {}),
            ...(p?.guardrails?.maxTokens !== undefined && !process.env.AGENT_MAX_TOKENS
              ? { maxTokens: p.guardrails.maxTokens }
              : {}),
            // 子任务的包可能改 maxTokens / 声明自己的预算——预算上限随之重算（窗口不变）
            contextTokenLimit: contextPlanFor(
              p,
              p?.guardrails?.maxTokens !== undefined && !process.env.AGENT_MAX_TOKENS
                ? p.guardrails.maxTokens
                : undefined,
            ).budget,
            // 逐子任务按各自的包取恢复策略（与核查预算同款：s1(coding) 与 s2(debug)
            // 的"进展续跑该给几轮"可以不同）；完成门关着时不装
            ...(config.requireTerminalTool ? { recovery: recoveryFor(p).policy } : {}),
          },
          verify: {
            ...(p?.verify.instructions ? { verifyInstructions: p.verify.instructions } : {}),
            // 无包子任务同样拿通用缺省（"无包"是按子任务算的，planner 漏写 pack 的子任务就是无包）
            ...(readOnlyFor(p).commands.length ? { verifyReadOnlyCommands: readOnlyFor(p).commands } : {}),
            ...((envRubric ?? p?.verify.rubric) ? { verifyRubric: (envRubric ?? p?.verify.rubric)! } : {}),
            ...(verifyMaxTurnsOf(p) !== undefined ? { verifyMaxTurns: verifyMaxTurnsOf(p)! } : {}),
            ...(verifierProvider
              ? { verifierModel: { client: verifierClient!, compat: verifierProvider.compat } }
              : {}),
          },
          // 独占资源（如 swd-probe）：调度器对同标签子任务强制串行
          ...(p?.resources ? { resources: p.resources } : {}),
        };
      },
      onEvent: async (source, event) => {
        noteForLedger(source, event);
        /**
         * planner 的审批不进宿主应答路径：它的只读契约由 drainPlannerEvents
         * 自答 deny 执行。此前 --yes 会在这里抢答 allow（onEvent 先于 drain 的
         * switch 运行，respond 先到先得）——planner 的 bash 全被放行执行，
         * 只读纪律被打穿。这是"宿主审批抢答"的第三次现身：eval 宿主打穿
         * verifier（已修：只放行 main/rework）、本处打穿 planner。
         * verifier 靠下面的 isVerifier 分支挡住，planner 在这里挡。
         */
        if (source === "planner" && event.type === "approval_request") return;
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
          } else if (stepId === "clarifier") {
            console.log(c.cyan("\n━━━ 需求澄清门（planner 开始前）━━━"));
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
    } catch (err) {
      if (err instanceof CliPlanRejectedError) {
        console.log(c.yellow(`\n${err.message}`));
        ledgerFacts = {
          stopReason: "plan_rejected",
          error: null,
          turns: 0,
          reworks: 0,
          finalPassed: false,
          verifications: [],
        };
        process.exitCode = err.exitCode;
      } else {
        throw err;
      }
    }
    if (!outcome) {
      // 确认门否决：档案已写 plan_rejected（closed），不要再 markFailed 盖成 error
    } else {
    const finishedAt = Date.now();
    const totalWallMs = finishedAt - startedAt;
    const wallMs = finishedAt - planReadyAt; // 子任务阶段墙钟（排除 planner）
    cliDurable?.noteHostEvent(hostPlanResultEvent(outcome, { startedAt, planReadyAt, finishedAt }));
    console.log(c.cyan("\n═══ 三角编排结果 ═══"));
    // 记账不分分支：计划不可解析（fail-closed）也是一次要归档的失败，只在
    // plan 存在的分支赋值会让这类失败在台账里落 stopReason=null。
    // steps 为空时各聚合项自然得 0/[]，不必按分支各写一份。
    ledgerFacts = {
      stopReason: plannedStopReason(outcome),
      error: (() => {
        const reason = plannedStopReason(outcome);
        if (reason !== "error") return null;
        const failed = outcome.steps.find((st) => st.result.main.stopReason === "error");
        if (failed?.result.main.error) return ledgerErrorClass(failed.result.main.error);
        return ledgerErrorClass(outcome.planOutcome.failureSummary ?? "plan_failed");
      })(),
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
    if (outcome.completed) cliDurable?.markCompleted();
    else cliDurable?.markFailed();
    }
  } else if (cliSingleResume) {
    const loop = new AgentLoop(config, modelClient);
    const feedback = task || "接着上次的检查点继续";
    cliDurable?.apply({ type: "resume", at: Date.now() });
    console.log(c.cyan("\n↺ 同 run 热恢复：从最后提交的 main 检查点续跑（不恢复 active grant）"));
    try {
      for await (const event of loop.runContinuation(cliSingleResume.history, feedback)) {
        noteForLedger("main", event);
        if (event.type === "done") {
          persistCliExecutorCheckpoint(cliDurable, event);
          ledgerFacts = {
            stopReason: event.result.stopReason,
            error:
              event.result.stopReason === "error" && event.result.error
                ? ledgerErrorClass(event.result.error)
                : event.result.stopReason === "error"
                  ? ledgerErrorClass("error")
                  : null,
            turns: event.result.usage.turns,
            reworks: null,
            finalPassed: null,
            verifications: [],
          };
          if (event.result.stopReason === "error" || event.result.stopReason === "aborted") {
            cliDurable?.markInterrupted();
          } else {
            cliDurable?.markCompleted();
          }
        }
        await renderEvent(event);
      }
    } catch (err) {
      cliDurable?.markFailed();
      throw err;
    }
  } else if (withVerify) {
    const outcome = await runVerified(config, modelClient, task, {
      ...(pack?.verify.instructions ? { verifyInstructions: pack.verify.instructions } : {}),
      ...(readOnlyFor(pack).commands.length ? { verifyReadOnlyCommands: readOnlyFor(pack).commands } : {}),
      ...((envRubric ?? pack?.verify.rubric) ? { verifyRubric: (envRubric ?? pack?.verify.rubric)! } : {}),
      ...(verifyMaxTurnsOf(pack) !== undefined ? { verifyMaxTurns: verifyMaxTurnsOf(pack)! } : {}),
      ...(verifierProvider
        ? { verifierModel: { client: verifierClient!, compat: verifierProvider.compat } }
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
      error:
        outcome.main.stopReason === "error" && outcome.main.error
          ? ledgerErrorClass(outcome.main.error)
          : outcome.main.stopReason === "error"
            ? ledgerErrorClass("error")
            : null,
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
    try {
      for await (const event of loop.run(task)) {
        noteForLedger("main", event);
        if (event.type === "done") {
          persistCliExecutorCheckpoint(cliDurable, event);
          ledgerFacts = {
            stopReason: event.result.stopReason,
            error:
              event.result.stopReason === "error" && event.result.error
                ? ledgerErrorClass(event.result.error)
                : event.result.stopReason === "error"
                  ? ledgerErrorClass("error")
                  : null,
            turns: event.result.usage.turns,
            reworks: null,
            finalPassed: null,
            verifications: [],
          };
          if (event.result.stopReason === "error" || event.result.stopReason === "aborted") {
            cliDurable?.markInterrupted();
          } else {
            cliDurable?.markCompleted();
          }
        }
        await renderEvent(event);
      }
    } catch (err) {
      cliDurable?.markFailed();
      throw err;
    }
  }
  /**
   * L6 运行台账（fire-and-forget，永不影响本次运行）。
   * 见 `src/ledger.ts` 顶部：这一行就是"等证据"能不能等到的全部区别。
   */
  void appendRunLedger(
    buildLedgerEntry({
      at: Date.now(),
      runId: cliRunId,
      host: "cli",
      task,
      pack: pack?.name ?? null,
      model: process.env.AGENT_MODEL ?? null,
      effort: process.env.AGENT_EFFORT ?? null,
      mode: withPlan ? "plan" : "single",
      verify: withVerify || withPlan,
      rubric: envRubric ?? pack?.verify.rubric ?? null,
      stopReason: ledgerFacts?.stopReason ?? null,
      error: ledgerFacts?.error ?? null,
      turns: ledgerFacts?.turns ?? null,
      reworks: ledgerFacts?.reworks ?? null,
      finalPassed: ledgerFacts?.finalPassed ?? null,
      verifications: ledgerFacts?.verifications ?? [],
      verifierBudgetTurns: verifyMaxTurnsOf(pack) ?? null,
      verifierHitBudget: ledgerHitBudget,
      fallbackChain: modelClient instanceof FallbackModelClient ? modelClient.chain() : null,
      fallbacks: fallbackCount,
      tools: ledgerTally,
      durationMs: Date.now() - ledgerStartedAt,
      // 分母与策略快照：plan 模式 turns 是各子任务之和，对不上单个护栏，记 null
      maxTurns: withPlan ? null : (config.maxTurns ?? DEFAULT_MAX_TURNS),
      recoveryPolicy: taskCompletionEnabled ? recoveryFor(pack).policy : null,
      recovery: ledgerRecovery,
      compaction: ledgerCompaction,
      hooks: ledgerHooks,
      agentMd: agentMdBundle
        ? { files: agentMdBundle.files.length, chars: agentMdBundle.chars, truncated: agentMdBundle.truncated }
        : null,
      // 档位跟实际开关走，不跟 AGENT_PERMISSION_MODE 标签：CLI --plan 有确认门，
      // 无 --yes 时对得上 plan 预设；--plan --yes 是自定义，不许把标签抄进台账。
      permissionMode: matchPermissionMode(permissionSwitches),
      approvals: ledgerApprovals,
      // 窗口 / 预算各带来源：事后才能回答"这次运行的压缩阈值到底是谁定的、离窗口多远"
      context: {
        window: contextPlan.window,
        windowSource: contextPlan.windowSource,
        budget: contextPlan.budget,
        budgetSource: contextPlan.budgetSource,
      },
    }),
  );

  rl?.close();
  await executionBroker?.dispose?.();
  activeCliExecutionBroker = undefined;
  activeCliDurable = undefined;
  activeCliLineageBudget = undefined;
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
        if (cliArtifactTools.has(event.name) && event.input && typeof event.input === "object") {
          const rec = event.input as Record<string, unknown>;
          const path = String(rec.path ?? rec.file_path ?? "").trim();
          if (path) pendingArtifactPaths.set(event.toolUseId, path);
        }
        break;
      case "tool_prepared":
        endStreamLine();
        console.log(
          c.dim(`⬡ prepared ${event.name} ${event.idempotencyKey.slice(0, 24)}…`),
        );
        break;
      case "tool_running":
        console.log(c.dim(`⬡ running ${event.name}`));
        break;
      case "tool_committed":
        console.log(
          c.dim(
            `⬡ committed ${event.name}${event.skipped ? " (skipped duplicate)" : ""}`,
          ),
        );
        break;
      case "tool_failed":
        console.log(c.yellow(`⬡ failed ${event.name}: ${event.reason}`));
        break;
      case "tool_aborted":
        console.log(c.yellow(`⬡ aborted ${event.name}`));
        break;
      case "mid_tool_replay": {
        endStreamLine();
        const summary = event.items
          .map((item) => `${item.action}:${item.name}`)
          .join(" · ");
        console.log(c.yellow(`↻ mid-tool 重放：${summary || "（空）"}`));
        break;
      }
      case "tool_result": {
        const head = event.result.content.split("\n")[0] ?? "";
        const preview = head.length > 120 ? `${head.slice(0, 120)}…` : head;
        const tag = event.result.isError ? c.red("✗") : c.green("✓");
        console.log(`${tag} ${c.dim(`${event.durationMs}ms`)} ${preview}`);
        if (!event.result.isError) {
          const path = pendingArtifactPaths.get(event.toolUseId);
          if (path) writtenArtifactPaths.add(path);
        }
        break;
      }
      case "approval_request": {
        endStreamLine();
        await settleCliApproval(event);
        break;
      }
      case "usage": {
        const turnTokens =
          Number(event.usage.input_tokens ?? 0) +
          Number(event.usage.output_tokens ?? 0) +
          Number(event.usage.cache_creation_input_tokens ?? 0);
        cliTokenSpend += turnTokens;
        console.log(
          c.dim(
            `  tokens: in=${event.usage.input_tokens} cacheW=${event.usage.cache_creation_input_tokens ?? 0} cacheR=${event.usage.cache_read_input_tokens ?? 0} out=${event.usage.output_tokens}`,
          ),
        );
        const turnCap = config.maxTurns;
        const tokenCap = config.maxTokensBudget ?? maxTokensBudget;
        const nearTurns = Boolean(turnCap && event.turn / turnCap >= 0.8);
        const nearTokens = Boolean(tokenCap && cliTokenSpend / tokenCap >= 0.8);
        const expensiveFloor = tokenCap ? Math.max(32_000, tokenCap * 0.2) : 32_000;
        const turnExpensive = turnTokens >= expensiveFloor;
        if (nearTurns || nearTokens || turnExpensive) {
          const bits = [
            nearTurns ? `轮次 ${event.turn}/${turnCap}` : null,
            nearTokens ? `token 已用约 ${cliTokenSpend}/${tokenCap}` : null,
            turnExpensive ? `本轮已经很贵（约 ${turnTokens}）` : null,
          ].filter(Boolean);
          console.log(c.yellow(`⚠ 成本预警：${bits.join(" · ")}。还没用尽，但下一轮会继续烧。`));
        }
        break;
      }
      case "progress": {
        const done = event.items.filter((i) => i.status === "done").length;
        console.log(c.dim(`  ▣ Progress ${done}/${event.items.length}`));
        break;
      }
      case "api_retry":
        endStreamLine();
        console.log(
          c.yellow(`⟳ API 瞬时错误，同轮重试 #${event.attempt}（等待 ${event.backoffMs}ms）：${event.reason}`),
        );
        break;
      case "model_call_start":
        endStreamLine();
        console.log(c.dim(`▷ 模型请求 #${event.attempt}（第 ${event.turn} 轮）`));
        break;
      case "model_call_end":
        endStreamLine();
        console.log(
          c.dim(
            `${event.status === "ok" ? "■" : "✗"} 模型请求 ${event.status} ${event.durationMs}ms`,
          ),
        );
        break;
      case "model_fallback":
        // ⇄ 与 ⟳(同轮重试) / ⟲(整段续跑) 分开：那两个换的是时机，这个换的是端点
        endStreamLine();
        console.log(
          c.yellow(
            `⇄ 端点降级${event.role && event.role !== "executor" ? `[${event.role}]` : ""}：${event.from} → ${event.to}（第 ${event.turn} 次调用）：${event.reason}`,
          ),
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
      case "recovery_decision": {
        endStreamLine();
        const stall =
          event.reason === "end_turn_without_completion" || event.reason === "stagnation";
        console.log(c.yellow(`${stall ? "⚠ 空转 · " : "⤷ 恢复决策："}${event.detail}`));
        break;
      }
      case "compaction":
        endStreamLine();
        console.log(c.yellow(describeCompaction(event)));
        break;
      case "hook": {
        endStreamLine();
        const who = event.tool ? `${event.hook} ${event.tool}` : event.hook;
        const extra = [
          event.timedOut ? "timeout" : event.exitCode != null ? `exit ${event.exitCode}` : null,
          event.detail,
        ].filter(Boolean).join(" · ");
        const line = extra ? `‡ ${who} ${event.outcome}（${extra}）` : `‡ ${who} ${event.outcome}`;
        console.log(event.outcome === "allow" ? c.dim(line) : c.yellow(line));
        break;
      }
      case "done": {
        endStreamLine();
        const u = event.result.usage;
        const reason = event.result.stopReason;
        // completed=绿；partial/max_tokens/aborted=黄；blocked/incomplete/stalled 与其它失败=红
        const color =
          reason === "completed"
            ? c.green
            : reason === "partial" || reason === "max_tokens" || reason === "aborted"
              ? c.yellow
              : c.red;
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
        if (reason === "incomplete" && writtenArtifactPaths.size > 0) {
          console.log(c.yellow(`  已写 ${writtenArtifactPaths.size} 个文件，未签字`));
        }
        if (event.result.completion) {
          const completion = event.result.completion;
          console.log(c.dim(`  ${completion.status}: ${completion.summary}`));
          for (const blocker of completion.blockers) console.log(c.yellow(`  blocker: ${blocker}`));
        }
        if (event.result.error) console.error(c.red(`  error: ${event.result.error.message}`));
        break;
      }
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (activeCliLineageBudget) {
      activeCliDurable?.apply({
        type: "budget_snapshot",
        budget: snapshotDurableBudget(activeCliLineageBudget),
      });
    }
    activeCliDurable?.markInterrupted();
    const cleanup = activeCliExecutionBroker?.dispose?.();
    if (!cleanup) {
      process.exit(signal === "SIGINT" ? 130 : 143);
      return;
    }
    void cleanup.then(
      () => process.exit(signal === "SIGINT" ? 130 : 143),
      (err: unknown) => {
        console.error(c.red(`Execution cleanup failed during ${signal}: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      },
    );
  });
}

main().catch(async (err) => {
  await activeCliExecutionBroker?.dispose?.().catch(() => {});
  if (err instanceof CliArgumentError) {
    console.error(c.red(err.message));
    console.error(c.dim("使用 --help 查看用法。"));
    process.exit(err.exitCode);
  }
  if (err instanceof CliPlanRejectedError) {
    console.error(c.yellow(err.message));
    process.exit(err.exitCode);
  }
  console.error(c.red(err instanceof Error ? err.stack ?? err.message : String(err)));
  process.exit(1);
});

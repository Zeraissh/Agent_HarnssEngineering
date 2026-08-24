/**
 * 计划前需求澄清门。
 *
 * planner 不应该一边猜技术选型/范围，一边把猜测固化成依赖图。这个角色只做一件
 * 事：若 `ask_user` 在场，先判断是否存在“猜错就要重做”的高代价岔路；需要时把
 * 正交问题一次问完，最后用结构化工具交付 planner 唯一可见的精炼任务。
 */
import { AgentLoop, createRunBudget } from "./loop.js";
import { withoutTaskCompletion } from "./task-completion.js";
import { ASK_USER_TOOL_NAME } from "./tools/ask-user.js";
import type {
  AgentConfig,
  AggregateUsage,
  ModelClient,
  TerminalResolution,
  Tool,
  TurnEvent,
} from "./types.js";

export const REQUIREMENTS_TOOL_NAME = "submit_requirements";
export const DEFAULT_CLARIFIER_MAX_TURNS = 4;

export interface ClarificationOutcome {
  task: string;
  acceptance: string[];
  assumptions: string[];
  asked: boolean;
  /** true 只表示宿主没提供 ask_user，澄清角色根本没有运行 */
  skipped: boolean;
  usage: AggregateUsage;
  stopReason: string | null;
}

const ZERO_USAGE: AggregateUsage = {
  inputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  turns: 0,
  cacheHitRatio: 0,
};

function strings(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") return undefined;
    out.push(item.trim());
  }
  return out;
}

export function requirementsFromObject(
  input: unknown,
): Pick<ClarificationOutcome, "task" | "acceptance" | "assumptions"> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const task = typeof raw.task === "string" ? raw.task.trim() : "";
  const acceptance = strings(raw.acceptance);
  const assumptions = strings(raw.assumptions);
  if (!task || !acceptance || !assumptions) return undefined;
  return { task, acceptance, assumptions };
}

export function createRequirementsTool(): Tool {
  return {
    name: REQUIREMENTS_TOOL_NAME,
    description:
      "提交澄清后的完整任务书并结束需求澄清。若没有高代价歧义，直接原样提交任务；" +
      "若调用过 ask_user，把答复合并进 task，并把未获答复而采用的默认写入 assumptions。",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "planner 可直接使用的自足任务书；不得只写相对指代或答案片段",
        },
        acceptance: {
          type: "array",
          items: { type: "string" },
          description: "已经明确的可验收结果；没有则 []",
        },
        assumptions: {
          type: "array",
          items: { type: "string" },
          description: "用户未回答时采用的关键默认；没有则 []",
        },
      },
      required: ["task", "acceptance", "assumptions"],
    },
    permission: "auto",
    parallelSafe: false,
    execute(input) {
      return Promise.resolve(
        requirementsFromObject(input)
          ? { content: "精炼任务已记录。" }
          : {
              content: "任务书无效：task 必须非空，acceptance/assumptions 必须是字符串数组。",
              isError: true,
            },
      );
    },
  };
}

function buildClarifierPrompt(task: string): string {
  return `你是执行前的需求澄清门。你的输出不会直接交付给委托方，而会成为 planner 的唯一任务输入。

<original_task>
${task}
</original_task>

只处理两类高代价未知：
1. 多种合理解释会产生实质不同的交付物，猜错就必须返工（技术选型、UI 风格、交付深度、验收口径）；
2. 只有委托方知道、靠代码与工具无法查到的事实。

若存在这些未知，调用 ${ASK_USER_TOOL_NAME}，把本轮所有正交问题一次提交；拿到答复后调用 ${REQUIREMENTS_TOOL_NAME}。
若不存在，不要为了显得谨慎而提问，直接调用 ${REQUIREMENTS_TOOL_NAME} 原样提交任务。
不得用普通文本收尾。`;
}

export async function runClarificationGate(
  cfg: AgentConfig,
  model: ModelClient,
  task: string,
  onEvent?: (event: TurnEvent) => void | Promise<void>,
  opts: { maxTurns?: number; signal?: AbortSignal } = {},
): Promise<ClarificationOutcome> {
  const ask = cfg.tools.find((tool) => tool.name === ASK_USER_TOOL_NAME);
  if (!ask) {
    return {
      task,
      acceptance: [],
      assumptions: [],
      asked: false,
      skipped: true,
      usage: { ...ZERO_USAGE },
      stopReason: null,
    };
  }

  const maxTurns = opts.maxTurns ?? DEFAULT_CLARIFIER_MAX_TURNS;
  const base = withoutTaskCompletion(cfg);
  const gateCfg: AgentConfig = {
    ...base,
    systemPrompt:
      "You are a requirements clarification gate. Ask only high-cost questions and always submit a structured refined task.",
    tools: [ask, createRequirementsTool()],
    maxTurns,
    // 澄清角色有自己的小预算，不消耗执行者 continuation 的共享预算。
    runBudget: createRunBudget({
      maxTurns: maxTurns + 1,
      ...(cfg.maxTokensBudget !== undefined ? { maxTokens: cfg.maxTokensBudget } : {}),
    }),
    terminalTool: REQUIREMENTS_TOOL_NAME,
    requireTerminalTool: true,
    terminalReminder:
      `不要用普通文本收尾。需要委托方决定就调用 ${ASK_USER_TOOL_NAME}；` +
      `否则立即调用 ${REQUIREMENTS_TOOL_NAME}。`,
    resolveTerminal: (input): TerminalResolution | undefined =>
      requirementsFromObject(input) ? { stopReason: "completed" } : undefined,
    recovery: { progressExtensionTurns: 0, stagnationWindow: 0, maxStagnationRecoveries: 0 },
  };

  let terminalInput: unknown;
  let asked = false;
  let usage: AggregateUsage = { ...ZERO_USAGE };
  let stopReason: string | null = null;
  for await (const event of new AgentLoop(gateCfg, model).run(buildClarifierPrompt(task), opts.signal)) {
    await onEvent?.(event);
    if (event.type === "tool_call") {
      if (event.name === ASK_USER_TOOL_NAME) asked = true;
      if (event.name === REQUIREMENTS_TOOL_NAME) terminalInput = event.input;
    } else if (event.type === "done") {
      usage = event.result.usage;
      stopReason = event.result.stopReason;
    }
  }

  const refined = requirementsFromObject(terminalInput);
  return {
    ...(refined ?? { task, acceptance: [], assumptions: ["澄清门未能提交合法任务书，沿用原任务"] }),
    asked,
    skipped: false,
    usage,
    stopReason,
  };
}

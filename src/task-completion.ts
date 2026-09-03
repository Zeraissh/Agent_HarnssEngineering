/**
 * 主执行者的结构化完成门。
 *
 * `end_turn` 只是 wire 层的“这次生成结束”，不是业务层的“任务完成”。把两者
 * 直接画等号会产生最危险的一类假成功：模型用文字问一句“你在哪个城市？”后
 * 收笔，宿主却把运行标绿。本模块给主执行者一个显式的完成动作，并把
 * completed / partial / blocked 三态保真带回宿主。
 */
import {
  DEFAULT_MAX_STAGNATION_RECOVERIES,
  DEFAULT_PROGRESS_EXTENSION_TURNS,
  DEFAULT_STAGNATION_WINDOW,
} from "./recovery.js";
import type { AgentConfig, TaskCompletion, Tool } from "./types.js";

export const FINISH_TASK_TOOL_NAME = "finish_task";
// 缺省值的唯一事实源在 src/recovery.ts（与三级解析 resolveRecoveryPolicy 同处）；
// 这里保留同名导出，旧调用方与测试不必改 import
export { DEFAULT_MAX_STAGNATION_RECOVERIES, DEFAULT_PROGRESS_EXTENSION_TURNS, DEFAULT_STAGNATION_WINDOW };

export const FINISH_TASK_REMINDER =
  `你刚才结束了本轮输出，但还没有通过 ${FINISH_TASK_TOOL_NAME} 声明任务状态。` +
  "如果缺少只有委托方知道的事实且 ask_user 可用，请立即调用 ask_user；" +
  `否则继续完成剩余工作，或调用 ${FINISH_TASK_TOOL_NAME} 如实提交 completed / partial / blocked。` +
  "不要只用文字说“完成了”或只留下一个问题。";

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") return undefined;
    out.push(item.trim());
  }
  return out;
}

/** 工具 schema 与兼容端点都不能替代运行时语义校验。 */
export function taskCompletionFromObject(input: unknown): TaskCompletion | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const status = raw.status;
  if (status !== "completed" && status !== "partial" && status !== "blocked") return undefined;
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (!summary) return undefined;

  const artifacts = stringArray(raw.artifacts);
  const verification = stringArray(raw.verification);
  const assumptions = stringArray(raw.assumptions);
  const blockers = stringArray(raw.blockers);
  if (!artifacts || !verification || !assumptions || !blockers) return undefined;
  // “完成但仍有 blocker”是自相矛盾；partial/blocked 没列未完成项又无法让委托方接手。
  if (status === "completed" && blockers.length > 0) return undefined;
  if ((status === "partial" || status === "blocked") && blockers.length === 0) return undefined;

  return { status, summary, artifacts, verification, assumptions, blockers };
}

export function createFinishTaskTool(): Tool {
  return {
    name: FINISH_TASK_TOOL_NAME,
    description:
      "提交本次任务的最终状态并结束执行。只有调用此工具才算业务层收尾：" +
      "completed=全部完成并已给出验证证据；partial=交付了可用部分但仍有未完成项；" +
      "blocked=因明确外部条件无法继续。若缺少只有委托方知道的事实且 ask_user 可用，" +
      "应先调用 ask_user，不能把一个可以提问解决的问题直接伪装成完成。",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["completed", "partial", "blocked"],
          description: "任务真实状态，不得把 partial/blocked 写成 completed",
        },
        summary: { type: "string", description: "一句自足的交付结论" },
        artifacts: {
          type: "array",
          items: { type: "string" },
          description: "本轮实际创建或修改的产物；没有则 []",
        },
        verification: {
          type: "array",
          items: { type: "string" },
          description: "实际运行过的验证及结果；没有则 []，不得编造",
        },
        assumptions: {
          type: "array",
          items: { type: "string" },
          description: "因未获答复而采用的关键假设；没有则 []",
        },
        blockers: {
          type: "array",
          items: { type: "string" },
          description: "未完成项或外部阻塞；completed 必须 []，partial/blocked 必须非空",
        },
      },
      required: ["status", "summary", "artifacts", "verification", "assumptions", "blockers"],
    },
    permission: "auto",
    parallelSafe: false,
    execute(input) {
      const completion = taskCompletionFromObject(input);
      return Promise.resolve(
        completion
          ? { content: `任务状态已记录：${completion.status}` }
          : {
              content:
                "完成声明无效：status/summary 与五个数组字段必须合法；completed 不得有 blockers，partial/blocked 必须列出 blockers。",
              isError: true,
            },
      );
    },
  };
}

export interface TaskCompletionOptions {
  progressExtensionTurns?: number;
  stagnationWindow?: number;
  maxStagnationRecoveries?: number;
}

/** 给主执行配置装上完成门；重复调用幂等，不会注册两个同名工具。 */
export function withTaskCompletion(
  cfg: AgentConfig,
  opts: TaskCompletionOptions = {},
): AgentConfig {
  return {
    ...cfg,
    tools: [...cfg.tools.filter((t) => t.name !== FINISH_TASK_TOOL_NAME), createFinishTaskTool()],
    terminalTool: FINISH_TASK_TOOL_NAME,
    requireTerminalTool: true,
    terminalReminder: FINISH_TASK_REMINDER,
    resolveTerminal: (input) => {
      const completion = taskCompletionFromObject(input);
      return completion
        ? { stopReason: completion.status, completion }
        : undefined;
    },
    recovery: {
      progressExtensionTurns:
        opts.progressExtensionTurns ?? DEFAULT_PROGRESS_EXTENSION_TURNS,
      stagnationWindow: opts.stagnationWindow ?? DEFAULT_STAGNATION_WINDOW,
      maxStagnationRecoveries:
        opts.maxStagnationRecoveries ?? DEFAULT_MAX_STAGNATION_RECOVERIES,
    },
  };
}

/** planner / verifier / router 是独立角色，不能继承主执行者的完成门。 */
export function withoutTaskCompletion(cfg: AgentConfig): AgentConfig {
  const {
    resolveTerminal: _resolveTerminal,
    requireTerminalTool: _requireTerminalTool,
    terminalReminder: _terminalReminder,
    recovery: _recovery,
    ...rest
  } = cfg;
  return {
    ...rest,
    tools: rest.tools.filter((t) => t.name !== FINISH_TASK_TOOL_NAME),
    ...(rest.terminalTool === FINISH_TASK_TOOL_NAME ? { terminalTool: undefined } : {}),
  };
}

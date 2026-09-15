/**
 * AGENT-02 最小切片：`spawn_task`——执行途中开一条独立调查支线。
 *
 * 判据（docs/09 §4.5）：
 * - 回摘要不回正史（父上下文只加结论 + 产物引用）
 * - 预算从父执行谱系扣（SharedRunBudget）
 * - 深度默认 1（子代理不得再 spawn）
 * - verifier / planner 永远没有这把工具
 * - 默认 AGENT_SPAWN_TASK=0
 */
import type { Tool } from "../types.js";

export const SPAWN_TASK_TOOL_NAME = "spawn_task";

export function withoutSpawnTask<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((t) => t.name !== SPAWN_TASK_TOOL_NAME);
}

export interface SpawnTaskRequest {
  title: string;
  description: string;
  acceptance: string[];
}

export interface SpawnTaskResult {
  summary: string;
  artifacts?: string[];
  passed: boolean;
  error?: string;
  /** 子支线用了多少轮（观测用） */
  turns?: number;
  /** 战役 / AGENT_CAMPAIGN=1 时真开的子 StoredRun */
  runId?: string;
}

export interface SpawnTaskOptions {
  /**
   * 宿主实现：跑一条子 AgentLoop（共享父 runBudget），只把摘要交回。
   * 深度已在工具层拦过——回调里不必再 spawn。
   */
  spawn: (request: SpawnTaskRequest) => Promise<SpawnTaskResult>;
  /** 当前嵌套深度（根执行者 = 0）。≥ maxDepth 时工具拒绝。 */
  depth?: number;
  /** 默认 1：子代理不得再 spawn */
  maxDepth?: number;
  /** 可选：发射前/后通知宿主（Web 合成 spawn_start / spawn_done） */
  onStart?: (request: SpawnTaskRequest) => void;
  onDone?: (request: SpawnTaskRequest, result: SpawnTaskResult) => void;
}

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
}

export function createSpawnTaskTool(opts: SpawnTaskOptions): Tool {
  const maxDepth = opts.maxDepth ?? 1;
  const depth = opts.depth ?? 0;
  return {
    name: SPAWN_TASK_TOOL_NAME,
    description:
      "开一条独立的调查/执行支线：子代理有自己的会话正史，只把结论与产物路径交回本对话。" +
      "适合『途中才发现需要另开一条线』，不要用它替代多轮对话。" +
      "子支线消耗本 run 的执行预算；默认深度 1（子支线不能再 spawn）。" +
      "核查者与规划者没有这把工具。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "支线短标题（界面/日志用）" },
        description: {
          type: "string",
          description: "自包含任务书：子代理只能看到这段，看不到父会话正史",
        },
        acceptance: {
          type: "array",
          items: { type: "string" },
          description: "可选验收清单；有则子代理应据此收口",
        },
      },
      required: ["title", "description"],
    },
    permission: "ask",
    parallelSafe: false,
    async execute(input) {
      if (depth >= maxDepth) {
        return {
          content:
            `spawn 深度已达上限（${maxDepth}）。子支线不得再 spawn——把结论交回父对话，或拆成多轮。`,
          isError: true,
        };
      }
      const title = asNonEmptyString((input as { title?: unknown })?.title);
      const description = asNonEmptyString((input as { description?: unknown })?.description);
      const acceptance = asStringList((input as { acceptance?: unknown })?.acceptance);
      if (!title) return { content: "title 不能为空。", isError: true };
      if (!description) return { content: "description 必须是自包含任务书。", isError: true };

      const request: SpawnTaskRequest = { title, description, acceptance };
      opts.onStart?.(request);
      let result: SpawnTaskResult;
      try {
        result = await opts.spawn(request);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = { summary: "", passed: false, error: message };
        opts.onDone?.(request, result);
        return { content: `支线失败：${message}`, isError: true };
      }
      opts.onDone?.(request, result);
      const runLine = result.runId ? `\nrunId：${result.runId}` : "";
      if (!result.passed) {
        return {
          content:
            `支线未完成${result.error ? `：${result.error}` : ""}。` +
            (result.summary ? `\n已有摘要：${result.summary}` : "") +
            runLine,
          isError: true,
        };
      }
      const arts =
        result.artifacts?.length ? `\n产物：${result.artifacts.join("、")}` : "";
      return {
        content:
          `【支线结论 · ${title}】\n${result.summary || "（无文字摘要）"}${arts}${runLine}` +
          (result.turns !== undefined ? `\n（支线用了 ${result.turns} 轮）` : ""),
      };
    },
  };
}

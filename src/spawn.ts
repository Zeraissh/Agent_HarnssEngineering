/**
 * AGENT-02：spawn_task 子支线跑法。
 *
 * 与 propose_handoff 不同——那是「新人闸 run」；这里是同谱系扣预算的调查支线。
 * 父上下文只应看到 SpawnTaskResult（结论 + 产物路径），子正史由宿主自行归档。
 */
import { AgentLoop } from "./loop.js";
import { AUTO_CONCURRENCY_CAP } from "./orchestrate.js";
import { withoutSpawnTask } from "./tools/spawn-task.js";
import type {
  AgentConfig,
  AgentRunResult,
  ModelClient,
  SharedRunBudget,
  TurnEvent,
} from "./types.js";
import type { SpawnTaskRequest, SpawnTaskResult } from "./tools/spawn-task.js";

export { AUTO_CONCURRENCY_CAP as SPAWN_CONCURRENCY_CAP };

let activeSpawns = 0;
const spawnWaiters: Array<() => void> = [];

async function withSpawnSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (activeSpawns >= AUTO_CONCURRENCY_CAP) {
    await new Promise<void>((resolve) => spawnWaiters.push(resolve));
  }
  activeSpawns += 1;
  try {
    return await fn();
  } finally {
    activeSpawns -= 1;
    const next = spawnWaiters.shift();
    next?.();
  }
}

/** 测试可重置并发闸（不导出到生产宿主） */
export function __resetSpawnSlotsForTest(): void {
  activeSpawns = 0;
  spawnWaiters.length = 0;
}

export interface RunSpawnedTaskOptions {
  /** 父配置的浅拷贝基底（workdir / broker / 护栏等） */
  parentConfig: AgentConfig;
  modelClient: ModelClient;
  /** 父谱系活预算——必须是同一引用 */
  runBudget: SharedRunBudget;
  request: SpawnTaskRequest;
  signal?: AbortSignal;
  /** 子事件旁路（宿主可记进 .agent-run-history，不回灌父正史） */
  onEvent?: (event: TurnEvent) => void | Promise<void>;
  /** 覆盖子 runId；缺省由宿主拼 parentId-spawn-… */
  childRunId?: string;
}

function lastAssistantText(result: AgentRunResult): string {
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const msg = result.messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") return content.trim();
    if (!Array.isArray(content)) continue;
    const texts = content
      .filter((b): b is { type: "text"; text: string } =>
        !!b && typeof b === "object" && (b as { type?: string }).type === "text"
      )
      .map((b) => b.text);
    const joined = texts.join("\n").trim();
    if (joined) return joined;
  }
  return "";
}

/**
 * 跑一条子 AgentLoop：剥掉 spawn_task、共享父预算、回摘要。
 */
export async function runSpawnedTask(opts: RunSpawnedTaskOptions): Promise<SpawnTaskResult> {
  return withSpawnSlot(async () => {
    const acceptanceBlock = opts.request.acceptance.length
      ? `\n\n验收：\n${opts.request.acceptance.map((a) => `- ${a}`).join("\n")}`
      : "";
    const task =
      `【支线 · ${opts.request.title}】\n${opts.request.description}${acceptanceBlock}\n\n` +
      "完成后用终结工具交付；你看不到父会话正史，请把结论写自洽。";

    const childCfg: AgentConfig = {
      ...opts.parentConfig,
      tools: withoutSpawnTask(opts.parentConfig.tools),
      runBudget: opts.runBudget,
      ...(opts.childRunId ? { runId: opts.childRunId } : {}),
      // 子支线不要继承父的 steering / toolTx 控制器引用（另开内存事务即可）
      steering: undefined,
      toolTx: undefined,
    };

    const loop = new AgentLoop(childCfg, opts.modelClient);
    let done: AgentRunResult | undefined;
    for await (const event of loop.run(task, opts.signal)) {
      await opts.onEvent?.(event);
      if (event.type === "done") done = event.result;
    }
    if (!done) {
      return { summary: "", passed: false, error: "子支线未产生 done 事件" };
    }
    if (done.stopReason === "aborted") {
      return {
        summary: lastAssistantText(done) || done.completion?.summary || "",
        artifacts: done.completion?.artifacts,
        passed: false,
        error: "已中止",
        turns: done.usage.turns,
      };
    }
    if (done.stopReason === "error") {
      return {
        summary: lastAssistantText(done) || "",
        artifacts: done.completion?.artifacts,
        passed: false,
        error: done.error?.message ?? "error",
        turns: done.usage.turns,
      };
    }
    const summary =
      done.completion?.summary?.trim()
      || lastAssistantText(done)
      || `支线结束（${done.stopReason}）`;
    const ok =
      done.stopReason === "completed"
      || done.stopReason === "partial"
      || (done.completion?.status === "completed" || done.completion?.status === "partial");
    return {
      summary,
      ...(done.completion?.artifacts?.length
        ? { artifacts: done.completion.artifacts }
        : {}),
      passed: Boolean(ok),
      ...(ok ? {} : { error: `stopReason=${done.stopReason}` }),
      turns: done.usage.turns,
    };
  });
}

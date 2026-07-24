/**
 * L4 — 编排：主 agent 执行 → verifier 核查 → 未通过则带着问题清单返工。
 * 主 loop 与 verifier 共用 systemPrompt/tools（缓存前缀一致），上下文互相隔离。
 */
import { AgentLoop } from "./loop.js";
import { runVerifier, type VerifyOutcome } from "./verifier.js";
import type { AgentConfig, AgentRunResult, ModelClient, TurnEvent } from "./types.js";

export interface VerifiedRunOptions {
  /** 核查未通过时的最大返工轮数。默认 1 */
  maxReworks?: number;
  /**
   * 事件旁路：所有主/返工 run 的事件都转发给宿主（含 approval_request——审批
   * 仍是宿主的事）。verifier 的事件也转发，但其 approval 已在内部 deny，仅供观察。
   */
  onEvent?: (source: "main" | "rework" | "verifier", event: TurnEvent) => void | Promise<void>;
}

export interface VerifiedRunResult {
  /** 最后一次执行 run 的结果（可能是返工后的） */
  main: AgentRunResult;
  /** 每轮核查的裁决（按时间顺序） */
  verifications: VerifyOutcome[];
  reworks: number;
  /** 最终裁决：最后一次核查是否通过 */
  finalPassed: boolean;
}

export async function runVerified(
  cfg: AgentConfig,
  model: ModelClient,
  task: string,
  opts: VerifiedRunOptions = {},
): Promise<VerifiedRunResult> {
  const maxReworks = opts.maxReworks ?? 1;
  const verifications: VerifyOutcome[] = [];

  let input = task;
  let main: AgentRunResult | undefined;
  let reworks = 0;

  for (let round = 0; ; round++) {
    const source = round === 0 ? "main" : "rework";
    main = await drain(new AgentLoop(cfg, model), input, (e) => opts.onEvent?.(source, e));

    // 执行本身失败（护栏/宿主错误）就不必核查了
    if (main.stopReason !== "completed") {
      return { main, verifications, reworks, finalPassed: false };
    }

    const outcome = await runVerifierWithEvents(cfg, model, task, main, opts);
    verifications.push(outcome);

    if (outcome.verdict.passed) {
      return { main, verifications, reworks, finalPassed: true };
    }
    if (round >= maxReworks) {
      return { main, verifications, reworks, finalPassed: false };
    }

    reworks += 1;
    input = `${task}

【返工】上一轮产出经独立核查未通过。核查结论：${outcome.verdict.summary}
待修复问题：
${outcome.verdict.issues.map((s, i) => `${i + 1}. ${s}`).join("\n")}

请核实并修复上述问题，然后重新交付。`;
  }
}

async function drain(
  loop: AgentLoop,
  input: string,
  onEvent: (e: TurnEvent) => void | Promise<void>,
): Promise<AgentRunResult> {
  let result: AgentRunResult | undefined;
  for await (const event of loop.run(input)) {
    await onEvent(event);
    if (event.type === "done") result = event.result;
  }
  return result!;
}

async function runVerifierWithEvents(
  cfg: AgentConfig,
  model: ModelClient,
  task: string,
  main: AgentRunResult,
  opts: VerifiedRunOptions,
): Promise<VerifyOutcome> {
  const executorReport = lastAssistantText(main) || "(执行者没有留下文字报告)";
  // verifier 的事件流由其内部 loop 产生；这里无法逐个转发（runVerifier 封装了消费），
  // 简化为只上报裁决 —— v0.5 若需要 verifier 过程可视化，再把 onEvent 下沉进 runVerifier。
  const outcome = await runVerifier(cfg, model, { task, executorReport });
  await opts.onEvent?.("verifier", {
    type: "assistant_text",
    text: `[verifier] passed=${outcome.verdict.passed} ${outcome.verdict.summary}`,
  });
  return outcome;
}

function lastAssistantText(result: AgentRunResult): string {
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const m = result.messages[i]!;
    if (m.role !== "assistant" || typeof m.content === "string") {
      if (m.role === "assistant" && typeof m.content === "string") return m.content;
      continue;
    }
    const text = m.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text) return text;
  }
  return "";
}

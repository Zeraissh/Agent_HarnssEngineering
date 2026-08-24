/**
 * 目标级恢复路由。
 *
 * 模型只报告事实（stop_reason、工具调用）；“要不要续、续来干什么、何时必须
 * 收口”由宿主确定性决定。这样 inherit 与加轮次都不再是全局偏好，而是针对
 * 具体失效形态的动作。
 */
import type { RecoveryPolicy } from "./types.js";

export type RecoveryTrigger =
  | "end_turn_without_completion"
  | "max_tokens_without_completion"
  | "max_turns"
  | "stagnation";

export type RecoveryAction =
  | "request_completion"
  | "continue_with_context"
  | "change_strategy"
  | "force_completion";

export interface RecoveryInput {
  trigger: RecoveryTrigger;
  policy?: RecoveryPolicy;
  hasProgress?: boolean;
  extensionUsed?: boolean;
  completionReminderUsed?: boolean;
  stagnationRecoveries?: number;
}

export interface RecoveryDecision {
  action: RecoveryAction;
  extraTurns?: number;
  detail: string;
}

export function decideRecovery(input: RecoveryInput): RecoveryDecision {
  switch (input.trigger) {
    case "end_turn_without_completion":
      return input.completionReminderUsed
        ? {
            action: "force_completion",
            detail: "模型再次 end_turn 仍未声明任务状态，下一轮只允许结构化收口。",
          }
        : {
            action: "request_completion",
            detail: "wire 层 end_turn 不等于任务完成；先给一次提问或继续工作的机会。",
          };

    case "max_tokens_without_completion":
      return {
        action: "force_completion",
        detail: "正文已撞单次输出上限，保留已有内容并用短工具调用提交真实状态。",
      };

    case "max_turns": {
      const extra = Math.max(0, Math.floor(input.policy?.progressExtensionTurns ?? 0));
      if (input.hasProgress && !input.extensionUsed && extra > 0) {
        return {
          action: "continue_with_context",
          extraTurns: extra,
          detail: `末段仍在产生新证据，同上下文追加 ${extra} 轮；不重做已完成步骤。`,
        };
      }
      return {
        action: "force_completion",
        detail: input.hasProgress
          ? "短续跑额度已用完，必须如实提交 completed / partial / blocked。"
          : "没有可证明的新进展，继续加轮次只会放大空转；转入结构化收口。",
      };
    }

    case "stagnation": {
      const used = input.stagnationRecoveries ?? 0;
      const max = Math.max(0, Math.floor(input.policy?.maxStagnationRecoveries ?? 0));
      return used < max
        ? {
            action: "change_strategy",
            detail: "连续得到相同观察；停止重复调用，改用不同工具/路径，缺委托方事实则 ask_user。",
          }
        : {
            action: "force_completion",
            detail: "换策略后仍重复相同观察；停止烧轮次并如实提交 partial / blocked。",
          };
    }
  }
}

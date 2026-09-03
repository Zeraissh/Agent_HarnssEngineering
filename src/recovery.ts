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

/**
 * 恢复策略的缺省值（完成门开启时生效）。
 *
 * 三个数此前散落在 `task-completion.ts`，且只有前两个能被 env 覆盖、领域包一个
 * 都覆盖不了——与 9.1（核查预算）/ B0（planner 预算）修之前的形态相同：
 * "一个常数走天下"。8 / 3 / 1 是按软件域顺手定的，没有实测背书。
 */
export const DEFAULT_PROGRESS_EXTENSION_TURNS = 8;
export const DEFAULT_STAGNATION_WINDOW = 3;
export const DEFAULT_MAX_STAGNATION_RECOVERIES = 1;

export const DEFAULT_RECOVERY_POLICY: Required<RecoveryPolicy> = {
  progressExtensionTurns: DEFAULT_PROGRESS_EXTENSION_TURNS,
  stagnationWindow: DEFAULT_STAGNATION_WINDOW,
  maxStagnationRecoveries: DEFAULT_MAX_STAGNATION_RECOVERIES,
};

export type RecoveryPolicyField = keyof Required<RecoveryPolicy>;
export const RECOVERY_POLICY_FIELDS: readonly RecoveryPolicyField[] = [
  "progressExtensionTurns",
  "stagnationWindow",
  "maxStagnationRecoveries",
];

/** 每个字段的取值来源——报数字必须带来源，否则无从判断"这是不是我要的值" */
export type RecoveryPolicySource = "env" | "pack" | "default";

export interface ResolvedRecoveryPolicy {
  policy: Required<RecoveryPolicy>;
  sources: Record<RecoveryPolicyField, RecoveryPolicySource>;
}

/**
 * 恢复策略三级解析：显式（宿主从 env 传入）> 领域包 `recovery` > 默认，
 * **逐字段**独立取值——env 只覆盖它写了的那一个，其余仍落到包/默认。
 * 同构 verifier 的 9.1 与 planner 的 B0；与它们一样，0 是合法的显式值
 * （`progressExtensionTurns: 0` = 关掉续跑），不能被 `||` 抹成"未设置"。
 *
 * 负数/非整数在这里夹到 ≥0 的整数：env 解析由宿主先校验并退出，这里兜的是
 * 包声明写错——护栏参数写成 2.5 或 -1 不该让 loop 里的 Math.floor 各自解释。
 */
export function resolveRecoveryPolicy(input: {
  explicit?: RecoveryPolicy;
  pack?: RecoveryPolicy;
}): ResolvedRecoveryPolicy {
  const policy = { ...DEFAULT_RECOVERY_POLICY };
  const sources: Record<RecoveryPolicyField, RecoveryPolicySource> = {
    progressExtensionTurns: "default",
    stagnationWindow: "default",
    maxStagnationRecoveries: "default",
  };
  for (const field of RECOVERY_POLICY_FIELDS) {
    const fromEnv = input.explicit?.[field];
    const fromPack = input.pack?.[field];
    if (fromEnv !== undefined) {
      policy[field] = clampCount(fromEnv);
      sources[field] = "env";
    } else if (fromPack !== undefined) {
      policy[field] = clampCount(fromPack);
      sources[field] = "pack";
    }
  }
  return { policy, sources };
}

function clampCount(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
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

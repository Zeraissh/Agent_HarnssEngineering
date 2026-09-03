/**
 * 恢复策略三级解析（env > 包 recovery > 默认）——9.1 / B0 的第三个同构件。
 *
 * 此前 `AgentConfig.recovery` 只能由宿主从 env 装配，领域包一个字段都覆盖不了，
 * 且第三个字段（maxStagnationRecoveries）连 env 都没有。这里锁的是解析器本身；
 * 宿主接线（CLI / Web run_config / /api/harness）另有各自的锁。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_STAGNATION_RECOVERIES,
  DEFAULT_PROGRESS_EXTENSION_TURNS,
  DEFAULT_RECOVERY_POLICY,
  DEFAULT_STAGNATION_WINDOW,
  RECOVERY_POLICY_FIELDS,
  decideRecovery,
  resolveRecoveryPolicy,
} from "../src/recovery.js";
import * as taskCompletion from "../src/task-completion.js";
import { PACKS } from "../src/presets.js";

describe("resolveRecoveryPolicy —— 三级解析", () => {
  it("什么都不传 → 全默认，三字段来源都是 default", () => {
    const r = resolveRecoveryPolicy({});
    expect(r.policy).toEqual(DEFAULT_RECOVERY_POLICY);
    expect(r.policy).toEqual({
      progressExtensionTurns: DEFAULT_PROGRESS_EXTENSION_TURNS,
      stagnationWindow: DEFAULT_STAGNATION_WINDOW,
      maxStagnationRecoveries: DEFAULT_MAX_STAGNATION_RECOVERIES,
    });
    expect(r.sources).toEqual({
      progressExtensionTurns: "default",
      stagnationWindow: "default",
      maxStagnationRecoveries: "default",
    });
  });

  it("包声明覆盖默认，且只覆盖它写了的字段（逐字段独立）", () => {
    const r = resolveRecoveryPolicy({ pack: { progressExtensionTurns: 20 } });
    expect(r.policy.progressExtensionTurns).toBe(20);
    expect(r.sources.progressExtensionTurns).toBe("pack");
    // 包没写的两个字段仍是默认——不能因为包声明了一个就把另两个清零
    expect(r.policy.stagnationWindow).toBe(DEFAULT_STAGNATION_WINDOW);
    expect(r.sources.stagnationWindow).toBe("default");
    expect(r.policy.maxStagnationRecoveries).toBe(DEFAULT_MAX_STAGNATION_RECOVERIES);
    expect(r.sources.maxStagnationRecoveries).toBe("default");
  });

  it("env 压过包，包压过默认——同一次解析里三种来源可以并存", () => {
    const r = resolveRecoveryPolicy({
      explicit: { stagnationWindow: 5 },
      pack: { progressExtensionTurns: 20, stagnationWindow: 2 },
    });
    expect(r.policy).toEqual({
      progressExtensionTurns: 20,
      stagnationWindow: 5,
      maxStagnationRecoveries: DEFAULT_MAX_STAGNATION_RECOVERIES,
    });
    expect(r.sources).toEqual({
      progressExtensionTurns: "pack",
      stagnationWindow: "env",
      maxStagnationRecoveries: "default",
    });
  });

  it("0 是合法的显式值（= 关掉该项），不得被当成未设置而落回默认", () => {
    const viaEnv = resolveRecoveryPolicy({ explicit: { progressExtensionTurns: 0 }, pack: { progressExtensionTurns: 20 } });
    expect(viaEnv.policy.progressExtensionTurns).toBe(0);
    expect(viaEnv.sources.progressExtensionTurns).toBe("env");
    const viaPack = resolveRecoveryPolicy({ pack: { maxStagnationRecoveries: 0 } });
    expect(viaPack.policy.maxStagnationRecoveries).toBe(0);
    expect(viaPack.sources.maxStagnationRecoveries).toBe("pack");
  });

  it("包声明写错形状（负数 / 小数 / NaN）夹到 ≥0 整数，不让 loop 各自解释", () => {
    const r = resolveRecoveryPolicy({
      pack: { progressExtensionTurns: -3, stagnationWindow: 2.9, maxStagnationRecoveries: Number.NaN },
    });
    expect(r.policy).toEqual({ progressExtensionTurns: 0, stagnationWindow: 2, maxStagnationRecoveries: 0 });
  });

  it("解析结果直接可喂 decideRecovery：包把续跑设为 0 → max_turns 时不再续跑", () => {
    const off = resolveRecoveryPolicy({ pack: { progressExtensionTurns: 0 } }).policy;
    expect(decideRecovery({ trigger: "max_turns", policy: off, hasProgress: true }).action).toBe("force_completion");
    const on = resolveRecoveryPolicy({ pack: { progressExtensionTurns: 4 } }).policy;
    const d = decideRecovery({ trigger: "max_turns", policy: on, hasProgress: true });
    expect(d.action).toBe("continue_with_context");
    expect(d.extraTurns).toBe(4);
  });

  it("字段清单与 RecoveryPolicy 类型同步（加字段先加这里，宿主投影跟着枚举走）", () => {
    expect([...RECOVERY_POLICY_FIELDS].sort()).toEqual(
      ["maxStagnationRecoveries", "progressExtensionTurns", "stagnationWindow"].sort(),
    );
    expect(Object.keys(DEFAULT_RECOVERY_POLICY).sort()).toEqual([...RECOVERY_POLICY_FIELDS].sort());
  });

  it("task-completion 的同名缺省常量与 recovery.ts 同源（旧 import 路径不漂移）", () => {
    expect(taskCompletion.DEFAULT_PROGRESS_EXTENSION_TURNS).toBe(DEFAULT_PROGRESS_EXTENSION_TURNS);
    expect(taskCompletion.DEFAULT_STAGNATION_WINDOW).toBe(DEFAULT_STAGNATION_WINDOW);
    expect(taskCompletion.DEFAULT_MAX_STAGNATION_RECOVERIES).toBe(DEFAULT_MAX_STAGNATION_RECOVERIES);
  });
});

describe("领域包的 recovery 声明（机制先行，数字等实测）", () => {
  it("声明了 recovery 的包：续跑额度不得高于自身执行者护栏（不等式锁）", () => {
    for (const pack of Object.values(PACKS)) {
      const extra = pack.recovery?.progressExtensionTurns;
      const ceiling = pack.guardrails?.maxTurns;
      if (extra === undefined || ceiling === undefined) continue;
      expect(extra, `${pack.name}: 续跑 ${extra} 轮不该超过护栏 ${ceiling}`).toBeLessThanOrEqual(ceiling);
    }
  });

  it("包声明的每个字段都是 ≥0 的整数（护栏参数不许写成 2.5 或 -1）", () => {
    for (const pack of Object.values(PACKS)) {
      for (const field of RECOVERY_POLICY_FIELDS) {
        const v = pack.recovery?.[field];
        if (v === undefined) continue;
        expect(Number.isInteger(v) && v >= 0, `${pack.name}.recovery.${field}=${v}`).toBe(true);
      }
    }
  });
});

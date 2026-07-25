/**
 * A/B 实验臂（arm）：把同一套 eval 用例放到不同的 harness 配置下跑，量化每个特性的收益。
 * 每个 arm = 一个对 base 配置的变换 + 运行模式（单跑 / 带 verifier 核查+返工）。
 */
import type { AgentConfig, Tool } from "../src/types.js";

export interface Arm {
  name: string;
  /** 报告里的一句话说明这个 arm 在测什么 */
  hypothesis: string;
  mode: "single" | "verified";
  configure(base: AgentConfig): AgentConfig;
}

/**
 * 把工具描述"精简"成只说做什么、不说何时调用——用来检验
 * "工具描述写清 When to call 能提高触发准确率" 这一 harness 设计主张。
 * 做法：砍掉描述里第二句起的内容（通常是 "Call this when…" 触发条件），只留第一句。
 */
export function stripWhenToCall(tools: Tool[]): Tool[] {
  return tools.map((t) => {
    const firstSentence = t.description.split(/(?<=[.。])\s/)[0] ?? t.description;
    return { ...t, description: firstSentence };
  });
}

export const ARMS: Arm[] = [
  {
    name: "baseline",
    hypothesis: "基准：当前工具描述 + 单跑，不做核查",
    mode: "single",
    configure: (base) => base,
  },
  {
    name: "verified",
    hypothesis: "加 verifier 独立核查 + 最多 1 轮返工，能否提升最终成功率",
    mode: "verified",
    configure: (base) => base,
  },
  {
    name: "bare-tools",
    hypothesis: "工具描述砍掉 When-to-call 后，成功率/轮数是否变差",
    mode: "single",
    configure: (base) => ({ ...base, tools: stripWhenToCall(base.tools) }),
  },
];

export function getArms(filter?: string[]): Arm[] {
  if (!filter || filter.length === 0) return ARMS;
  return ARMS.filter((a) => filter.includes(a.name));
}

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
  /** verified 模式的附加配置（实验变量） */
  verify?: {
    /** 附加核查指令，如保守裁决协议 */
    instructions?: string;
    /** true = 用 AB_VERIFIER_MODEL 指定的（更强）模型当 verifier；未设该 env 时此臂被跳过 */
    strongModel?: boolean;
  };
}

/**
 * 保守裁决协议：针对"弱 verifier 净负"的主因——假阴性裁决触发破坏性返工。
 * 三条对策：failed 必须带证据、数值不一致先怀疑自己、字节级检查用工具不用肉眼。
 */
export const STRICT_VERIFY_INSTRUCTIONS = `裁决纪律（保守核查协议）：
1. 只有拿到【具体证据】才允许判 failed——期望值与实际值都必须是你亲自用工具重新获取的，且两者确实不一致。"我怀疑/可能/风格不佳"都不构成问题；拿不出证据一律判 passed。
2. 数值/计数类声明：亲自重新推导，优先用与执行者不同的方法（grep -c、wc -l、脚本各算一遍）。你的结果与产出不一致时，先假设是你自己数错了，换一种方法再算一遍，两次都不一致才可判 failed。
3. 字节级格式要求（如"末尾不能有换行"）：禁止肉眼判断，必须用 od -c 或等价命令查看文件末尾的实际字节再下结论。
4. issues 每条必须写明三件事：期望什么、实际是什么、你用哪条命令得到的。写不全就不要列。`;

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
  {
    name: "verified-strict",
    hypothesis: "保守裁决协议（failed 必须带证据 + 字节级用工具查）能否消掉假阴性返工、保住真救回",
    mode: "verified",
    configure: (base) => base,
    verify: { instructions: STRICT_VERIFY_INSTRUCTIONS },
  },
  {
    name: "verified-strong",
    hypothesis: "强 verifier 核查弱执行者（AB_VERIFIER_MODEL），假阴性是否消失、救回是否稳定",
    mode: "verified",
    configure: (base) => base,
    verify: { strongModel: true },
  },
];

export function getArms(filter?: string[]): Arm[] {
  if (!filter || filter.length === 0) return ARMS;
  return ARMS.filter((a) => filter.includes(a.name));
}

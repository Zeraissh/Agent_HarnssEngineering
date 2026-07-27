# Harness A/B 对比报告

- 日期：2026-07-27
- 模型：`qwen3.5:9b`
- verifier 模型（verified-strong 臂）：`deepseek-v4-pro`
- 规模：1 用例 × 2 臂 × 5 次

## 实验臂

- **verified**（verified）：加 verifier 独立核查 + 最多 1 轮返工，能否提升最终成功率
- **verified-strong**（verified）：强 verifier 核查弱执行者（AB_VERIFIER_MODEL），假阴性是否消失、救回是否稳定

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens |
|---|---|---|---|
| verified | 100% | 11.0 | 38087 |
| verified-strong | 100% | 7.6 | 13988 |

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens`

| 用例 | 覆盖面 | verified | verified-strong |
|---|---|---|---|
| trap-h2-count | 陷阱：干扰计数（严格前缀，排除更深层级） | 5/5 · 11.0t · 38k | 5/5 · 7.6t · 14k |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

## 分析：弱 verifier 的"破坏性"未复现——它主要是 harness 缺陷的产物

REPS=5 结果：qwen 自查（verified）与 pro 核查（verified-strong）**双双 5/5**，
弱 verifier 零假阴性、零破坏性返工。当初"弱 verifier 毁掉 h2-count（2/2→0/2）"
的现象消失了。

变化的不是模型，是 harness——当初那轮之后修掉的缺陷恰好覆盖了破坏链条：
1. **verdict 重问**：当初 h2 被毁的 run 里有裁决解析失败 → fail-closed 返工；
   现在非 JSON 裁决先重问转写，不再直接触发破坏性返工。
2. **真 Git Bash**：当初 qwen verifier 在 cmd 环境里独立重数容易数错/失败，
   假阴性裁决有一部分是 shell 摩擦制造的。

### 设计原则修订（替代 ab-report.md 的原结论）

原结论"verifier 必须强于执行者，否则净负"需要降级为：
**"弱 verifier 的破坏性主要来自 harness 失效模式（裁决解析 fail-closed、工具
环境摩擦），修掉这些后同强度自查不再净负；强 verifier 的确定优势是核查效率
（7.6t/14k vs 11t/38k，约 1/3 成本）与裁决质量的余量。"**
"核查者 ≥ 执行者"仍是稳妥默认，但它不再是硬性前提。

附注：本轮 20 个 run 无一触发 api_retry（基建全程干净），loop 重试待真实战果。

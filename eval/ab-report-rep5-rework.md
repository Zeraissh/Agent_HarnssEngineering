# Harness A/B 对比报告

- 日期：2026-07-27
- 模型：`deepseek-v4-flash`
- verifier 模型（verified-strong 臂）：`deepseek-v4-pro`
- 规模：1 用例 × 2 臂 × 5 次

## 实验臂

- **rework-fresh-t8**（verified）：紧预算（maxTurns=8）下 fresh 返工：max_turns 后核查产物并全新重跑的成功率/成本
- **rework-inherit-t8**（verified）：紧预算（maxTurns=8）下 inherit 返工：继承正史续跑能否用更少 token 达到更高成功率

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens |
|---|---|---|---|
| rework-fresh-t8 | 80% | 28.2 | 116552 |
| rework-inherit-t8 | 40% | 22.2 | 137578 |

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens`

| 用例 | 覆盖面 | rework-fresh-t8 | rework-inherit-t8 |
|---|---|---|---|
| hard-import-list | 高难：多约束组合（扫描+过滤+去重+排序+精确格式+字节纪律） | 4/5 · 28.2t · 117k | 2/5 · 22.2t · 138k |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

## 分析：inherit>fresh 未复现——被 verifier 预算耦合缺陷淹没

REPS=5 结果 fresh 4/5 > inherit 2/5，与 REPS=2 轮（inherit 2/2 > fresh 1/2）方向
相反。合并 7 次：fresh 5/7 vs inherit 4/7——**无显著差异，此前"inherit 更优"的
信号是小样本噪声**。默认 reworkMode 维持 "fresh" 不变的决定被证明是对的。

但逐 run 裁决暴露了真正的问题——本轮实验被一个 harness 缺陷污染：

1. **verifier 预算耦合**（本轮最大发现）：t8 臂把执行者 maxTurns 压到 8 时，
   runVerifier 的 min(cfg.maxTurns, 15) 让核查预算也缩到 8。import-list 的字节级
   核查 8 轮跑不完 → 最终消息是空/半截引言 → fail-closed 假 F 淹没信号
   （fresh rep2 产物正确却被 FF）。已修：核查预算固定 15，与执行者解耦。
2. **重问机制会编造裁决**：inherit rep3 的裁决 summary 是核查引言却 passed=true
   ——重问把"无结论的引言"转写成了幻觉通过（产物实际是错的）。已修：重问提示
   加硬规则，原文无明确判定时必须输出 passed=false。

### 结论

- inherit vs fresh：**悬置**。需在 verifier 预算解耦修复后重测才有干净数据。
- 方法学教训（本日第三次验证）：**排在"执行者能力"和"返工策略"之前的，
  永远是 harness 自身缺陷**——先排除管线噪声，再谈策略优劣。

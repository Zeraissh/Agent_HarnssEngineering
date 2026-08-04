# Harness A/B 对比报告

- 日期：2026-08-04
- 模型：`deepseek-v4-flash`
- planner 模型（planned-strong-plan 臂）：`kimi-k3`
- 规模：1 用例 × 1 臂 × 5 次

## 实验臂

- **planned-strong-plan**（planned）：强 planner（AB_PLANNER_MODEL）+ 原执行者：拆分摇摆（flash 5/9）能否稳定;图合法率、汇总收口句遵从一并观测。concurrency=3 与 planned-par3 同口径

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens | 平均墙钟 |
|---|---|---|---|---|
| planned-strong-plan | 100% | 26.8 | 110286 | 274s |

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens · 平均墙钟 s`（并行臂看墙钟——token 不省，省的是时间）

| 用例 | 覆盖面 | planned-strong-plan |
|---|---|---|
| par-fanout | 并行：三个互不重叠分片统计 + 依赖全部分片的汇总（fan-out + 汇聚形状） | 5/5 · 26.8t · 110k · 274s |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

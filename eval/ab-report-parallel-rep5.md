# Harness A/B 对比报告

- 日期：2026-08-03
- 模型：`deepseek-v4-flash`
- 规模：1 用例 × 1 臂 × 5 次

## 实验臂

- **planned-par3**（planned）：并行编排（concurrency=3）：fan-out 任务上墙钟能否逼近关键路径（对照 planned 串行的全序和）；token 预期持平（并行不省 token）

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens | 平均墙钟 |
|---|---|---|---|---|
| planned-par3 | 100% | 42.4 | 179697 | 190s |

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens · 平均墙钟 s`（并行臂看墙钟——token 不省，省的是时间）

| 用例 | 覆盖面 | planned-par3 |
|---|---|---|
| par-fanout | 并行：三个互不重叠分片统计 + 依赖全部分片的汇总（fan-out + 汇聚形状） | 5/5 · 42.4t · 180k · 190s |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

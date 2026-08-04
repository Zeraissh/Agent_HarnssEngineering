# Harness A/B 对比报告

- 日期：2026-08-04
- 模型：`deepseek-v4-flash`
- 规模：1 用例 × 1 臂 × 5 次

## 实验臂

- **planned-struct-par3**（planned）：结构化拆分协议（枚举与决策分离,宿主规则判拆）：拆分摇摆（freeform flash 5/9、kimi 2/5）能否稳定;枚举本身的稳定性（分片数方差）是新观测点。concurrency=3 同口径

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens | 平均墙钟 |
|---|---|---|---|---|
| planned-struct-par3 | 100% | 43.0 | 144598 | 150s |

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens · 平均墙钟 s`（并行臂看墙钟——token 不省，省的是时间）

| 用例 | 覆盖面 | planned-struct-par3 |
|---|---|---|
| par-fanout | 并行：三个互不重叠分片统计 + 依赖全部分片的汇总（fan-out + 汇聚形状） | 5/5 · 43.0t · 145k · 150s |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

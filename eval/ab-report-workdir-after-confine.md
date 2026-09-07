# Harness A/B 对比报告

- 日期：2026-09-04
- 模型：`deepseek-v4-flash`
- 规模：1 用例 × 1 臂 × 3 次

## 实验臂

- **baseline**（single）：基准：当前工具描述 + 单跑，不做核查

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens | 平均墙钟 |
|---|---|---|---|---|
| baseline | 100% | 3.3 | 12516 | 12s |

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens · 平均墙钟 s`（并行臂看墙钟——token 不省，省的是时间）

| 用例 | 覆盖面 | baseline |
|---|---|---|
| ho-workdir-escape-denied | held-out: 工作目录外写入必须失败且旁路产物 | 3/3 · 3.3t · 13k · 12s |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

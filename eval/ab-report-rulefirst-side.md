# Harness A/B 对比报告

- 日期：2026-08-01
- 模型：`deepseek-v4-flash`
- 规模：4 用例 × 1 臂 × 2 次

## 实验臂

- **rule-first**（single）：成文口径优先纪律能否把 letter-vs-spirit 遵从率从 ~50% 拉满（对照 baseline）

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens |
|---|---|---|---|
| rule-first | 100% | 5.5 | 25901 |

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens`

| 用例 | 覆盖面 | rule-first |
|---|---|---|
| multi-read-brief | 多文件读取 + 综合输出 | 2/2 · 3.0t · 13k |
| hard-unused-deps | 高难：跨文件依赖分析（子路径导入的前缀匹配陷阱） | 2/2 · 7.5t · 38k |
| hard-chain | 高难：跨文件依赖链（计数结果作为另一文件的行号索引） | 2/2 · 5.0t · 11k |
| xhard-script-imports | 极难：多源聚合（scripts 入口 × 各自的相对依赖计数 × 排序格式） | 2/2 · 6.5t · 41k |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

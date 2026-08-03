# Harness A/B 对比报告

- 日期：2026-08-03
- 模型：`deepseek-v4-flash`
- 规模：1 用例 × 3 臂 × 3 次

## 实验臂

- **fixed-serial**（planned）：注入参考拆解（跳过 planner）+ 串行调度：调度器对照组——子任务墙钟的全序和基线
- **fixed-par3**（planned）：注入参考拆解（跳过 planner）+ concurrency=3：同一 DAG 下并行调度的净墙钟收益（与 fixed-serial 唯一变量=并行度）
- **fixed-par6**（planned）：concurrency=6：收益曲线上限点——6 独立分片下 par6 应 ≈ max(分片)+汇总,par3 应 ≈ 两波次;并发 6 执行者+核查者是否触发端点限流/干扰

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens | 平均墙钟 |
|---|---|---|---|---|
| fixed-serial | 100% | 56.0 | 116802 | 210s |
| fixed-par3 | 100% | 54.3 | 110897 | 93s |
| fixed-par6 | 100% | 55.3 | 116314 | 79s |

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens · 平均墙钟 s`（并行臂看墙钟——token 不省，省的是时间）

| 用例 | 覆盖面 | fixed-serial | fixed-par3 | fixed-par6 |
|---|---|---|---|---|
| par-fanout6 | 并行：六分片 + 汇总——收益曲线（par1/par3/par6 下排队行为与墙钟） | 3/3 · 56.0t · 117k · 210s | 3/3 · 54.3t · 111k · 93s | 3/3 · 55.3t · 116k · 79s |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

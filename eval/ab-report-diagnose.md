# Harness A/B 对比报告

- 日期：2026-07-25
- 模型：`deepseek-v4-flash`
- 规模：1 用例 × 2 臂 × 2 次

## 实验臂

- **prompt-hint**（single）：批量命令策略提示能否救活轮次预算耗尽型失败（对照 baseline 的 max_turns 全灭）
- **budget-30**（single）：maxTurns 15→30：轮次预算是不是 import-list 失败的约束本身（对照 prompt-hint 无效）

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens |
|---|---|---|---|
| prompt-hint | 0% | 15.0 | 65857 |
| budget-30 | 50% | 18.0 | 97419 |

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens`

| 用例 | 覆盖面 | prompt-hint | budget-30 |
|---|---|---|---|
| hard-import-list | 高难：多约束组合（扫描+过滤+去重+排序+精确格式+字节纪律） | 0/2 · 15.0t · 66k | 1/2 · 18.0t · 97k |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

## 结论（transcript 回放）

- 四个 run 全部第 1 轮就上批量 grep/sed 管道——prompt-hint 的"策略缺失"假设证伪。
- 轮次烧在 cmd.exe 对 bash 语法的引号/转义崩溃后的环境考古（uname、where、
  /bin/sh、python 逃生），budget-30 只是给了熬过考古期的余量（1/2）。
- budget-30 rep2"完成但答错"：flash 语义化收集把多行 import 的 stdio.js 算入，
  违反任务成文规则（"以 import 开头的行"）——指令精确性陷阱，判定成立。
- 根因修复与定量对照见 ab-report-bash.md（63%→88%，tokens −40%）。

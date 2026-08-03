# Harness A/B 对比报告

- 日期：2026-08-03
- 模型：`deepseek-v4-flash`
- 规模：2 用例 × 3 臂 × 3 次

## 实验臂

- **baseline**（single）：基准：当前工具描述 + 单跑，不做核查
- **planned**（planned）：三角编排（planner 切分,每子任务全新预算）能否缓解预算×规模张力——对照纯加预算的 budget-30
- **budget-30**（single）：maxTurns 15→30：轮次预算是不是 import-list 失败的约束本身（对照 prompt-hint 无效）

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens |
|---|---|---|---|
| baseline | 100% | 8.0 | 34615 |
| planned | 100% | 34.2 | 404976 |
| budget-30 | 83% | 7.2 | 27970 |

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens`

| 用例 | 覆盖面 | baseline | planned | budget-30 |
|---|---|---|---|---|
| hard-import-list | 高难：多约束组合（扫描+过滤+去重+排序+精确格式+字节纪律） | 3/3 · 6.7t · 25k | 3/3 · 42.7t · 643k | 3/3 · 6.0t · 17k |
| scale-audit | 规模：60 模块依赖图的传递闭包（只查直接依赖会漏一半以上） | 3/3 · 9.3t · 44k | 3/3 · 25.7t · 167k | 2/3 · 8.3t · 39k |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

## 分析：预算轴没绑住 + planned 臂的价值边界划清

### 结果矩阵

| 臂 | import-list | scale-audit | 平均 tokens（两案） |
|---|---|---|---|
| baseline (t15) | 3/3 · 6.7t | 3/3 · 9.3t | 25k / 44k |
| budget-30 (t30) | 3/3 · 6.0t | 2/3 · 8.3t | 17k / 39k |
| planned | 3/3 · **42.7t** | 3/3 · **25.7t** | **643k / 167k** |

### 发现一：预算张力被 rule-precedence 纪律【顺带】解除了

本轮 baseline 6/6，import-list 只用 6-8 轮（历史 10-15 轮）。回看 transcript 时代
数据：当年烧穿预算的 run 大量轮次花在"多行 import 算不算"的规则纠结上——
**"预算×规模张力"的相当一部分其实是规则歧义churn 的转嫁**。纪律条款采纳后，
t15 对这两个用例不再紧张。budget-30 的 1 次失败（9 轮即写不出文件，非耗尽，
stopReason=completed 却没产物）是普通执行失误，与预算无关。
**至此最后一条区分轴对 flash 档也趋于关闭。**

### 发现二：planned 在单领域任务上是纯开销（4-25×）

成功率与 baseline 持平（6/6 vs 6/6），token 却是 4-25 倍（import-list 单 run 最高
1018k），两个 run 还出现 verifier 假阴性引发的返工空转（v:FP）。
**三角编排的价值边界由此划清：跨领域交接、真正的长管线（子任务各需完整预算）、
需要独立核查的高风险变更——而不是单领域单产物任务。** router 的
"单领域→直接跑,跨领域→--plan"分流规则已经隐含了这条边界,现在有了数据背书。

### 附带修复（本轮抓到的第二、三个 bug）

1. **审批抢答打穿 verifier 只读**：respond 先到先得,eval 宿主对一切来源 allow
   把 verifier 内部 deny 变成空操作——此前所有 verified 臂的只读约束实际失守
   （行为日志未见实际写操作,但设计失守记录在案）。已修：只放行 main/rework。
2. **vitest 误收 fixture 测试**：eval/fixtures 里的 node:test 文件被 vitest 收进
   npm test 且以失败文件退出非零——被 grep 管道掩盖了数轮。已修：vitest.config.ts
   限定 include。教训：**管道会吃掉退出码,验证命令别用 grep 收尾**。

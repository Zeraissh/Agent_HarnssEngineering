# Harness A/B 对比报告

- 日期：2026-08-01
- 模型：`deepseek-v4-flash`
- 规模：2 用例 × 2 臂 × 5 次

## 实验臂

- **baseline**（single）：基准：当前工具描述 + 单跑，不做核查
- **rule-first**（single）：成文口径优先纪律能否把 letter-vs-spirit 遵从率从 ~50% 拉满（对照 baseline）

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens |
|---|---|---|---|
| baseline | 70% | 8.0 | 34805 |
| rule-first | 100% | 7.0 | 30645 |

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens`

| 用例 | 覆盖面 | baseline | rule-first |
|---|---|---|---|
| hard-import-list | 高难：多约束组合（扫描+过滤+去重+排序+精确格式+字节纪律） | 3/5 · 8.6t · 27k | 5/5 · 6.6t · 27k |
| xhard-export-chain | 极难：长依赖链（入口 → 本地依赖集 → 逐文件统计 → 聚合） | 4/5 · 7.4t · 42k | 5/5 · 7.4t · 35k |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

## 分析：本项目迄今信噪比最干净的一次 A/B——假设成立，已采纳

### 结果

| 用例 | baseline | rule-first |
|---|---|---|
| hard-import-list | 3/5 | **5/5**（平均轮数 8.6→6.6） |
| xhard-export-chain | 4/5 | **5/5** |
| 合计 | 7/10 | **10/10** |

### 证据质量

- **失败模式 100% 命中目标**：baseline 全部 3 次失败均为 letter-vs-spirit
  （transcript 实锤：import-list 两次都写了含 stdio.js 的 10 项清单；
  export-chain 24=12+12 计入 types.js 续行），零基建/格式噪声混入。
- **纪律降低成本**：baseline 失败 run 花大量轮数纠结"多行 import 算不算"
  （专门 grep `import type {` 侦查）；rule-first 直接按字面执行，不内耗。
- **副作用检查 8/8 干净**（ab-report-rulefirst-side.md）：三个无冲突精确任务 +
  一个软性语义任务（multi-read-brief）全过——条款以"任务给出成文口径"为触发
  条件，作用面收敛，未见过度死板化。

### 采纳（2026-07-31 起生效）

RULE_PRECEDENCE_DISCIPLINE 进入 src/presets.ts，附着于：CLI 默认 system prompt、
两个领域包 prompt、eval 的 baseline system prompt。**此后所有报告的 baseline
含此纪律，与更早报告横向比较时注意时代分界。** rule-first 臂保留为历史复现
（现与 baseline 等价）。

### 与 prompt-hint 的对照（为什么这次提示词有效而上次无效）

prompt-hint 试图用提示改变【工具策略】——但策略不是瓶颈（环境才是），故无效且
有副作用。rule-first 用提示改变【规则遵从优先级】——失败模式恰好是"模型在两种
合理解释间摇摆"，一句话把摇摆钉死，故高效且无副作用。
**提示词是弱杠杆，但打在决策歧义点上就是够用的杠杆；打在能力/环境缺口上则无效。**

# Harness A/B 对比报告

- 日期：2026-07-25
- 模型：`deepseek-v4-flash`
- 规模：4 用例 × 1 臂 × 2 次

## 实验臂

- **baseline**（single）：基准：当前工具描述 + 单跑，不做核查

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens |
|---|---|---|---|
| baseline | 88% | 8.1 | 28295 |

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens`

| 用例 | 覆盖面 | baseline |
|---|---|---|
| hard-unused-deps | 高难：跨文件依赖分析（子路径导入的前缀匹配陷阱） | 2/2 · 5.5t · 15k |
| hard-import-list | 高难：多约束组合（扫描+过滤+去重+排序+精确格式+字节纪律） | 1/2 · 13.5t · 49k |
| hard-substring-count | 高难：工具语义（grep -c 数行 vs 子串出现总次数） | 2/2 · 7.5t · 25k |
| hard-chain | 高难：跨文件依赖链（计数结果作为另一文件的行号索引） | 2/2 · 6.0t · 24k |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

## 分析：shell 错配税的定量测量（本日最大发现）

本报告与 ab-report-hard.md 的 baseline 是同模型、同用例、同 REPS 的唯一变量对照——
**bash 工具的运行时从 cmd.exe 换成了真正的 Git Bash**（src/tools/bash.ts 自动探测）。

| 指标 | cmd 时代 | bash 时代 | 变化 |
|---|---|---|---|
| 成功率 | 5/8 (63%) | **7/8 (88%)** | +25pp |
| 平均轮数 | 11.0 | 8.1 | −26% |
| 平均 tokens | 47.3k | 28.3k | **−40%** |
| import-list | 0/2（全 max_turns） | 1/2 | 复活 |

diagnose 轮的 transcript 已定位机制：模型看到工具名叫 bash 就写 bash 管道（策略
本身完全正确，prompt-hint 臂因此证伪），cmd 的引号转义让管道崩掉，每个 shell
重度任务固定烧 5-10 轮做环境考古（uname / where cmd / /bin/sh 探测 / python 逃生）。

**Harness 结论（写入 docs 候选）：工具运行时的质量是模型表现的地板。名字与运行时
错配时，名字的暗示力大于描述里的免责声明——修环境一分钱不花，效果超过任何
提示词工程（prompt-hint 臂 0 收益）和事后核查（verifier 对 max_turns 无能为力）。**

### 其余观察

- import-list rep1 仍 max_turns（文件未创建，71k tokens）：多约束+字节纪律的
  组合对 flash 仍有真实难度，非环境问题；该用例保留了区分度。
- rep2 通过的答案是 8 项——含 bash.ts 本次修复新增的 node:fs（checker 动态
  重算 ground truth，经受住了源码变化）；且未把多行 import 的 stdio.js 算进去，
  即成文规则（"以 import 开头的行"）压过了语义直觉——指令精确性陷阱按预期工作。
- 评分策略本轮起改为纯产物制：无论 stopReason 一律查产物，
  stopReason 作为过程元数据留档（ab-log.jsonl）。

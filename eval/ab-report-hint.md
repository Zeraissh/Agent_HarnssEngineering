# Harness A/B 对比报告

- 日期：2026-07-25
- 模型：`deepseek-v4-flash`
- 规模：4 用例 × 1 臂 × 2 次

## 实验臂

- **prompt-hint**（single）：批量命令策略提示能否救活轮次预算耗尽型失败（对照 baseline 的 max_turns 全灭）

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens |
|---|---|---|---|
| prompt-hint | 63% | 10.4 | 48843 |

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens`

| 用例 | 覆盖面 | prompt-hint |
|---|---|---|
| hard-unused-deps | 高难：跨文件依赖分析（子路径导入的前缀匹配陷阱） | 2/2 · 7.0t · 24k |
| hard-import-list | 高难：多约束组合（扫描+过滤+去重+排序+精确格式+字节纪律） | 0/2 · 15.0t · 49k |
| hard-substring-count | 高难：工具语义（grep -c 数行 vs 子串出现总次数） | 1/2 · 10.0t · 36k |
| hard-chain | 高难：跨文件依赖链（计数结果作为另一文件的行号索引） | 2/2 · 9.5t · 87k |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

## 结论：假设证伪，但证伪过程找到了真凶

prompt-hint 对目标用例（import-list）0 收益（0/2 → 0/2），且有副作用
（substring-count 2/2 → 1/2，chain 单 run token 爆到 163k——"批量命令优先"
诱导命令行体操与大输出灌入上下文）。transcript 回放（diagnose 轮）显示模型
本来就会第一轮上批量管道：**策略不是瓶颈，cmd.exe 冒充 bash 才是**。
后续：bash 工具改用真 Git Bash 后 baseline 直接 63%→88%，见 ab-report-bash.md。
教训：提示词是弱杠杆，环境是强杠杆；先修环境，再谈提示。

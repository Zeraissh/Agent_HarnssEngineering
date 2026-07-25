# Harness A/B 对比报告

- 日期：2026-07-25
- 模型：`deepseek-v4-flash`
- 规模：11 用例 × 2 臂 × 1 次

## 实验臂

- **baseline**（single）：基准：当前工具描述 + 单跑，不做核查
- **verified**（verified）：加 verifier 独立核查 + 最多 1 轮返工，能否提升最终成功率

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens |
|---|---|---|---|
| baseline | 100% | 4.8 | 11849 |
| verified | 100% | 8.5 | 25467 |

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens`

| 用例 | 覆盖面 | baseline | verified |
|---|---|---|---|
| write-basic | write_file 基本路径 | 1/1 · 4.0t · 4k | 1/1 · 5.0t · 4k |
| read-extract | read_file + 信息抽取 | 1/1 · 4.0t · 8k | 1/1 · 6.0t · 12k |
| bash-count | bash 工具 + 数值准确性 | 1/1 · 5.0t · 5k | 1/1 · 9.0t · 12k |
| multi-read-brief | 多文件读取 + 综合输出 | 1/1 · 3.0t · 13k | 1/1 · 7.0t · 35k |
| error-recovery | 工具错误恢复（is_error 回填后改道） | 1/1 · 3.0t · 3k | 1/1 · 6.0t · 7k |
| sum-numbers | 多步：生成数据 → 计算 → 写结果（算术准确性） | 1/1 · 6.0t · 7k | 1/1 · 9.0t · 12k |
| json-field | 结构化抽取（读 JSON 取字段） | 1/1 · 4.0t · 4k | 1/1 · 6.0t · 7k |
| filter-lines | 精确过滤（数符合特定前缀的行） | 1/1 · 8.0t · 50k | 1/1 · 15.0t · 89k |
| combine-titles | 多文件合成（各取标题拼装，格式约束） | 1/1 · 3.0t · 13k | 1/1 · 5.0t · 21k |
| sort-filenames | 列举 + 排序（确定性输出） | 1/1 · 5.0t · 6k | 1/1 · 11.0t · 15k |
| count-interfaces | 代码自省（精确统计源码结构） | 1/1 · 8.0t · 19k | 1/1 · 14.0t · 67k |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

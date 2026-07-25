# Harness A/B 对比报告

- 日期：2026-07-25
- 模型：`deepseek-v4-pro`
- 规模：11 用例 × 3 臂 × 1 次

## 实验臂

- **baseline**（single）：基准：当前工具描述 + 单跑，不做核查
- **verified**（verified）：加 verifier 独立核查 + 最多 1 轮返工，能否提升最终成功率
- **bare-tools**（single）：工具描述砍掉 When-to-call 后，成功率/轮数是否变差

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens |
|---|---|---|---|
| baseline | 100% | 5.5 | 15009 |
| verified | 100% | 9.5 | 22707 |
| bare-tools | 100% | 5.6 | 17975 |

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens`

| 用例 | 覆盖面 | baseline | verified | bare-tools |
|---|---|---|---|---|
| write-basic | write_file 基本路径 | 1/1 · 4.0t · 3k | 1/1 · 4.0t · 3k | 1/1 · 3.0t · 2k |
| read-extract | read_file + 信息抽取 | 1/1 · 3.0t · 5k | 1/1 · 5.0t · 9k | 1/1 · 3.0t · 5k |
| bash-count | bash 工具 + 数值准确性 | 1/1 · 5.0t · 5k | 1/1 · 11.0t · 14k | 1/1 · 9.0t · 16k |
| multi-read-brief | 多文件读取 + 综合输出 | 1/1 · 3.0t · 13k | 1/1 · 5.0t · 21k | 1/1 · 4.0t · 19k |
| error-recovery | 工具错误恢复（is_error 回填后改道） | 1/1 · 3.0t · 3k | 1/1 · 7.0t · 9k | 1/1 · 3.0t · 2k |
| sum-numbers | 多步：生成数据 → 计算 → 写结果（算术准确性） | 1/1 · 6.0t · 7k | 1/1 · 12.0t · 15k | 1/1 · 6.0t · 6k |
| json-field | 结构化抽取（读 JSON 取字段） | 1/1 · 6.0t · 7k | 1/1 · 9.0t · 11k | 1/1 · 5.0t · 5k |
| filter-lines | 精确过滤（数符合特定前缀的行） | 1/1 · 10.0t · 76k | 1/1 · 11.0t · 52k | 1/1 · 8.0t · 34k |
| combine-titles | 多文件合成（各取标题拼装，格式约束） | 1/1 · 3.0t · 12k | 1/1 · 10.0t · 54k | 1/1 · 6.0t · 30k |
| sort-filenames | 列举 + 排序（确定性输出） | 1/1 · 10.0t · 13k | 1/1 · 15.0t · 22k | 1/1 · 7.0t · 60k |
| count-interfaces | 代码自省（精确统计源码结构） | 1/1 · 8.0t · 19k | 1/1 · 15.0t · 39k | 1/1 · 8.0t · 18k |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

## 结论与方法学反思

**1. 三臂全部 100% 通过——本套用例对 deepseek-v4-pro 太简单，无法在"成功率"维度上区分。**
verifier 的价值是"抓住并修正错误"，而 baseline 根本不出错时，核查就无从体现收益。这不是 verifier 没用，而是这套 eval 缺乏足够难度让 baseline 失败。

**2. verified 是实打实的成本税，而这套用例里它零回报。**
汇总：baseline 5.5 轮 / 15k tok → verified 9.5 轮 / 22.7k tok（**+73% 轮数、+51% tokens**），成功率却一样是 100%。
推论：**"永远开 verifier" 是错的**——应按场景选择性开启（高风险/难以回滚的产出、或预期 baseline 会失败的任务）。在简单任务上它纯属浪费。这正好印证了设计原则里"验证是为不确定的产出兜底"，而非无条件套用。

**3. bare-tools（砍掉"何时调用"）方向性地更贵（汇总 +20% tokens），但单次跑噪声大。**
个别格子 bare-tools 反而更省（如 filter-lines），单次 token 数不可靠。要坐实"When-to-call 提高效率"需多次重复取均值（AB_REPS>1）降噪。

**4. 方法学结论（这轮最大的收获）：**
- **用例难度需校准**：要测出 verifier 的真实价值，必须有让 baseline 稳定失败 ~30–60% 的更难用例（verifier+返工才有救回空间）。
- **需要多次重复**：单次 run 的 token/轮数噪声很大，汇总成功率有意义但成本对比要 reps≥3。
- **换更弱的模型**：同套用例在弱模型（deepseek-v4-flash / qwen3.5:9b）上 baseline 会更多失败，verifier 的救回价值才会显现——这是让 verifier 收益可见的最直接实验。

一句话：A/B 框架本身跑通了，但要得出"verifier 值不值"的定论，下一步是**加难用例 + 多次重复 + 弱模型对照**。负结果也是结果——它告诉我们"在够强的模型 + 够简单的任务上，verifier 是纯成本"，这本身就是有用的工程判断。

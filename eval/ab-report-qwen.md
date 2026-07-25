# Harness A/B 对比报告

- 日期：2026-07-25
- 模型：`qwen3.5:9b`
- 规模：5 用例 × 2 臂 × 1 次

## 实验臂

- **baseline**（single）：基准：当前工具描述 + 单跑，不做核查
- **verified**（verified）：加 verifier 独立核查 + 最多 1 轮返工，能否提升最终成功率

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens |
|---|---|---|---|
| baseline | 60% | 4.8 | 18335 |
| verified | 40% | 9.8 | 36703 |

> ⚠️ **数据质量警告**：本轮后 4 格（sort-filenames×2、count-interfaces×2）显示 `0轮/0token`——这是
> 262k 上下文内存压力下 Ollama 临时失灵导致的**基础设施失败**（模型调用未成功，非任务做错），
> 应作**无效数据**剔除。汇总成功率被这 4 格压低，不代表真实能力。
>
> **有效数据点**（3 格 × 2 臂）：sum-numbers(1/1,1/1)、filter-lines(1/1,1/1)、combine-titles(**baseline 1/1，verified 0/1**)。
> 唯一真实信号：combine-titles 上 verified(9轮/55k) 比 baseline 差——弱模型上 verifier 可能因假阴性裁决触发
> 破坏性返工。单样本，仅供后续用更干净的实验（32k 上下文的稳定 qwen + 多次重复）验证。

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens`

| 用例 | 覆盖面 | baseline | verified |
|---|---|---|---|
| sum-numbers | 多步：生成数据 → 计算 → 写结果（算术准确性） | 1/1 · 9.0t · 15k | 1/1 · 25.0t · 42k |
| filter-lines | 精确过滤（数符合特定前缀的行） | 1/1 · 11.0t · 58k | 1/1 · 15.0t · 87k |
| combine-titles | 多文件合成（各取标题拼装，格式约束） | 1/1 · 4.0t · 18k | 0/1 · 9.0t · 55k |
| sort-filenames | 列举 + 排序（确定性输出） | 0/1 · 0.0t · 0k | 0/1 · 0.0t · 0k |
| count-interfaces | 代码自省（精确统计源码结构） | 0/1 · 0.0t · 0k | 0/1 · 0.0t · 0k |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

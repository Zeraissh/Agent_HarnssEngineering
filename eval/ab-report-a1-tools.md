# Harness A/B 对比报告

- 日期：2026-09-03
- 模型：`deepseek-v4-flash`
- 规模：25 用例 × 1 臂 × 3 次

## 实验臂

- **baseline**（single）：基准：当前工具描述 + 单跑，不做核查

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens | 平均墙钟 |
|---|---|---|---|---|
| baseline | 96% | 3.7 | 13011 | 7s |

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens · 平均墙钟 s`（并行臂看墙钟——token 不省，省的是时间）

| 用例 | 覆盖面 | baseline |
|---|---|---|
| ho-write-marker | held-out: 单文件精确写入 | 3/3 · 3.3t · 9k · 6s |
| ho-write-two-files | held-out: 双文件写入 | 3/3 · 2.7t · 6k · 4s |
| ho-append-lines | held-out: 多行确定性内容 | 3/3 · 3.0t · 7k · 4s |
| ho-arith-product | held-out: 生成数据后求积 | 3/3 · 2.7t · 6k · 4s |
| ho-arith-mean | held-out: 均值（整数截断口径写死） | 3/3 · 3.3t · 8k · 5s |
| ho-pkg-name | held-out: package.json name 字段 | 3/3 · 4.0t · 13k · 5s |
| ho-pkg-license | held-out: package.json 可选字段缺省口径 | 3/3 · 4.0t · 14k · 6s |
| ho-tsconfig-module | held-out: tsconfig 字段抽取 | 3/3 · 3.3t · 8k · 4s |
| ho-count-md | held-out: bash/工具统计 docs 下 md | 3/3 · 4.0t · 14k · 7s |
| ho-filter-h2 | held-out: 精确前缀过滤（README h2） | 3/3 · 5.0t · 46k · 9s |
| ho-count-test-files | held-out: test/ 下 .test.ts 计数 | 3/3 · 4.3t · 16k · 7s |
| ho-multi-title | held-out: 两文档标题合成 | 3/3 · 3.7t · 30k · 7s |
| ho-sort-eval-scripts | held-out: 列举+排序 | 3/3 · 4.0t · 11k · 7s |
| ho-missing-fallback | held-out: 读失败后条件分支 | 3/3 · 3.3t · 8k · 5s |
| ho-partial-then-fix | held-out: 先错后对（覆盖写） | 3/3 · 4.0t · 9k · 6s |
| ho-workdir-escape-denied | held-out: 工作目录外写入必须失败且旁路产物 | 0/3 · 5.0t · 25k · 18s |
| ho-literal-newline | held-out: 成文口径（末尾换行） | 3/3 · 2.7t · 6k · 4s |
| ho-only-digits | held-out: 输出纪律（禁止解释文字） | 3/3 · 3.7t · 13k · 13s |
| ho-mcp-absent-bypass | held-out: 缺 MCP 工具时旁路完成 | 3/3 · 2.0t · 4k · 3s |
| ho-conditional-size | held-out: 按文件是否存在分支 | 3/3 · 3.3t · 8k · 4s |
| ho-engines-node | held-out: engines.node 抽取 | 3/3 · 4.3t · 13k · 6s |
| ho-scripts-test | held-out: scripts.test 命令抽取 | 3/3 · 3.7t · 13k · 7s |
| ho-docs-file-exists | held-out: 存在性探测 | 3/3 · 3.0t · 7k · 4s |
| ho-line-count-env-example | held-out: 行数口径（split 非空末行） | 3/3 · 5.7t · 17k · 12s |
| ho-private-flag | held-out: boolean JSON 字段 | 3/3 · 4.3t · 13k · 6s |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

# Harness A/B 对比报告

- 日期：2026-07-27
- 模型：`deepseek-v4-flash`
- verifier 模型（verified-strong 臂）：`deepseek-v4-pro`
- 规模：1 用例 × 2 臂 × 5 次

## 实验臂

- **rework-fresh-t8**（verified）：紧预算（maxTurns=8）下 fresh 返工：max_turns 后核查产物并全新重跑的成功率/成本
- **rework-inherit-t8**（verified）：紧预算（maxTurns=8）下 inherit 返工：继承正史续跑能否用更少 token 达到更高成功率

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens |
|---|---|---|---|
| rework-fresh-t8 | 60% | 29.0 | 140235 |
| rework-inherit-t8 | 60% | 26.8 | 137347 |

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens`

| 用例 | 覆盖面 | rework-fresh-t8 | rework-inherit-t8 |
|---|---|---|---|
| hard-import-list | 高难：多约束组合（扫描+过滤+去重+排序+精确格式+字节纪律） | 3/5 · 29.0t · 140k | 3/5 · 26.8t · 137k |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

## 分析：干净环境下平局——inherit vs fresh 这条线关闭

verifier 预算解耦 + 重问防编造后的首批干净数据：**fresh 3/5 = inherit 3/5**。
三轮合并（REPS 2+5+5）：fresh 8/12 vs inherit 7/12——无差异。

### 修复的验收（这批数据可信的理由）

- 裁决几乎全部是带证据的实质判定（"164 字节，无末尾换行"、"9 个唯一标识符"、
  "多行 import 续行不以 import 开头"——verifier 甚至正确引用了任务的成文规则）；
- 上一批的引言式假裁决与幻觉 passed=true 消失；仅存 1 例"(空输出)"，fail-closed
  正确兜住且未编造；
- F 裁决全部对应真实问题（文件未创建 / 多算了续行模块），不再是预算噪声。

### 结论（定稿）

**返工模式在本负载下无显著差异。默认保持 fresh（实现更简单、无上下文膨胀风险
——inherit 的失败 run 上下文重喂放大到 221k/300k tokens）。**
inherit 保留为选项：直觉上它应在"侦查成本高、问题清单精确"的场景占优，
但证明这一点需要专门构造这类负载，优先级让位于更有区分度的用例套件。

### 元观察

fresh rep4/rep5 的裁决序列 F(文件缺失)→P 显示 verifier→rework 闭环在干净
环境下如设计工作：真问题、真返工、真修复。管线本身已可信，剩下的瓶颈
回到了用例设计（对 flash 只有 import-list 有区分度）。

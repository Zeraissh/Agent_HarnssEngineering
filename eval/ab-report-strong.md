# Harness A/B 对比报告

- 日期：2026-07-25
- 模型：`qwen3.5:9b`
- verifier 模型（verified-strong 臂）：`deepseek-v4-pro`
- 规模：4 用例 × 2 臂 × 2 次

## 实验臂

- **baseline**（single）：基准：当前工具描述 + 单跑，不做核查
- **verified-strong**（verified）：强 verifier 核查弱执行者（AB_VERIFIER_MODEL），假阴性是否消失、救回是否稳定

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens |
|---|---|---|---|
| baseline | 100% | 6.4 | 16334 |
| verified-strong | 88% | 13.6 | 40805 |

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens`

| 用例 | 覆盖面 | baseline | verified-strong |
|---|---|---|---|
| trap-inclusive-range | 陷阱：栅栏错（含两端的区间计数） | 2/2 · 5.0t · 22k | 2/2 · 17.5t · 75k |
| trap-no-newline | 陷阱：严格格式（无末尾换行、无多余字符） | 2/2 · 7.5t · 11k | 1/2 · 7.0t · 14k |
| trap-h2-count | 陷阱：干扰计数（严格前缀，排除更深层级） | 2/2 · 8.0t · 27k | 2/2 · 18.0t · 55k |
| trap-conditional | 陷阱：多分支条件（奇偶 → 不同产出） | 2/2 · 5.0t · 6k | 2/2 · 12.0t · 19k |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

## 分析（对照 eval/ab-log.jsonl 逐 run 裁决）

### 前情：本轮之前发生了什么

1. 首轮 strong 实验（qwen 执行 + pro 核查）被两个僵尸 strict 进程污染（Windows TaskStop
   杀不干净 node 子进程树），数据作废。
2. 排查污染时发现 **两个陷阱用例的 ground truth 有行数口径歧义**（checker 用
   `split("\n")` 口径，与 `wc -l` 口径差 1）：trap-no-newline 冤判所有按 wc -l 答对且
   字节格式完美的 run；trap-conditional 的奇偶直接反转，无解。已修复（no-newline 两种
   口径都接受，conditional 任务文本明确 wc -l 口径）。**因此旧报告（ab-report.md）里
   这两个用例的全部数据、以及"字节级错误 verifier 抓不到"的结论作废。**

### 本轮四个发现

**1. 修好 ground truth 后，qwen baseline 8/8（100%）。** 上轮 baseline 50% 的"惨状"
大部分是 checker 口径 bug 制造的假象 + 小样本方差，不是模型能力问题。教训置顶：
**eval 判定器本身是 harness 验证链条的一环，它出 bug 时所有下游结论都是噪声。**

**2. 强 verifier 展示了真实救回，且有硬证据。** trap-inclusive-range 两个 verified run
里，执行者初版都写了 `"11"  \r\n`（带引号+尾随空格），checker 会判 NaN 失败；
deepseek-v4-pro verifier 用 hex dump 抓出确切字节（`22 31 31 22 20 20 0d 0a`），
裁决 failed，返工后变成纯 `11` 通过。这是"核查→定位→返工→修复"的完整闭环，
裁决里带着独立获取的证据——正是保守裁决协议要求的形态。

**3. 强 verifier 无破坏性假阴性。** 所有执行者本来正确的 run（h2-count、conditional、
no-newline rep2），pro 的实质裁决全部 passed，没有出现弱 verifier 那种"把对的改错"。
弱 verifier 毁掉 h2-count（2/2→0/2）的对照仍然有效（该用例 ground truth 无歧义）。
"verifier 必须 ≥ 执行者强度"原则的正反两面证据齐了。

**4. 新失效模式：裁决 JSON 解析失败 → fail-closed 空转返工。** 两个 run 里 pro 的
最终消息不是纯 JSON（一次带说明文字、一次空输出），parseVerdict fail-closed 判不通过，
触发了对正确/已修产物的多余返工（未造成破坏，但 inclusive-range rep2 烧到 21 轮
115k tokens）。改进方向：verdict 解析失败时先重问一次"只输出 JSON"，而非直接返工。

### 结论怎么读

verified-strong 88% vs baseline 100% 的表面差距全部来自一次 Ollama 基础设施错误
（stopReason=error，0 turns 0 tokens，非能力问题）。刨去后两臂同为 100%，但 verified
臂在过程中真实拦下了 2 次会失败的产出——本轮 baseline 恰好没犯同样的错，是方差
使然。强核查的价值在"执行者会犯错的世界"里才显现，代价是 ~2.5× tokens。

### 遗留问题

- trap 用例对修复后的判定标准已经问不倒 qwen3.5:9b——需要更难的陷阱（多约束组合、
  长链条依赖、跨文件一致性）才能继续区分 harness 配置的贡献。
- verdict JSON 解析鲁棒性（见发现 4）。
- REPS=2 仍是小样本；关键对照（弱 verifier 毁 h2 vs 强 verifier 保 h2）值得 REPS≥5 复现。

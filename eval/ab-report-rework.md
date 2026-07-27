# Harness A/B 对比报告

- 日期：2026-07-25
- 模型：`deepseek-v4-flash`
- verifier 模型（verified-strong 臂）：`deepseek-v4-pro`
- 规模：4 用例 × 2 臂 × 2 次

## 实验臂

- **rework-fresh-t8**（verified）：紧预算（maxTurns=8）下 fresh 返工：max_turns 后核查产物并全新重跑的成功率/成本
- **rework-inherit-t8**（verified）：紧预算（maxTurns=8）下 inherit 返工：继承正史续跑能否用更少 token 达到更高成功率

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens |
|---|---|---|---|
| rework-fresh-t8 | 88% | 15.1 | 58994 |
| rework-inherit-t8 | 100% | 14.3 | 67549 |

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens`

| 用例 | 覆盖面 | rework-fresh-t8 | rework-inherit-t8 |
|---|---|---|---|
| hard-unused-deps | 高难：跨文件依赖分析（子路径导入的前缀匹配陷阱） | 2/2 · 12.5t · 64k | 2/2 · 12.5t · 99k |
| hard-import-list | 高难：多约束组合（扫描+过滤+去重+排序+精确格式+字节纪律） | 1/2 · 24.5t · 78k | 2/2 · 22.0t · 80k |
| hard-substring-count | 高难：工具语义（grep -c 数行 vs 子串出现总次数） | 2/2 · 12.0t · 47k | 2/2 · 12.0t · 46k |
| hard-chain | 高难：跨文件依赖链（计数结果作为另一文件的行号索引） | 2/2 · 11.5t · 46k | 2/2 · 10.5t · 45k |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

## 分析（对照 eval/ab-log.jsonl 逐 run 裁决序列）

设计：maxTurns 压到 8 逼出预算耗尽，强 verifier（pro）核查后触发返工——
fresh 从零重跑 vs inherit 继承正史续跑。执行者 flash。

### 结果：inherit 8/8 > fresh 7/8，机制差异在裁决序列里

决定性的格还是 import-list（唯一持续有难度的用例）：

| run | 裁决序列 | 结果 | 读法 |
|---|---|---|---|
| fresh rep1 | F → F | ✗ 32t/119k | 返工从零重做，**重蹈同样的覆辙** |
| inherit rep2 | F → P | ✓ 29t/118k | 返工带着已有探索，**修掉了被点名的问题** |

这正是两种模式的本质差异：fresh 返工只拿到问题清单的文字，重新踩一遍所有侦查
路径（且大概率再犯同款错误）；inherit 返工的模型能看到自己上一轮的工具输出和
被否的产物，修复是增量的。

### 连带收益：max_turns→照常核查 的新编排策略立了功

本轮 16 个 run 里 6 个以 stopReason=max_turns 结束却最终 PASS——verifier 核查
发现产物其实已就绪（裁决 P，无需返工）。旧编排会把这 6 个全部判死。
"纯产物哲学"从 eval 评分层贯通到了编排层。

### 成本

两臂 token 总量相近（fresh 236k vs inherit 270k，后者被一个 165k 的离群 run
拉高——unused-deps rep2，13 轮大输出灌上下文所致，与返工模式无关）。
在真正触发返工的 run 上（import-list），inherit 用相近成本换来了更高成功率。

### 结论与遗留

- 方向明确：**返工场景 inherit 优于 fresh**——但 REPS=2、真返工事件仅 3 起，
  代码默认值暂保持 "fresh"，待 REPS≥5 复现后再翻转。
- executionUsage 修正后成本才可信（旧版漏计被否掉的主 run——此前所有 verified
  臂的 token 数都被低估，横向比较时注意）。

> ⚠️ **勘误（REPS=5 复现批，见 ab-report-rep5-rework.md）**：本报告"inherit 8/8 >
> fresh 7/8"未能复现（REPS=5 反向：fresh 4/5 > inherit 2/5，合并无显著差异），
> 且该批实验被 verifier 预算耦合缺陷污染。inherit vs fresh 结论**悬置**，默认
> reworkMode 维持 fresh。

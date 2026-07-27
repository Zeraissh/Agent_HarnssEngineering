# Harness A/B 对比报告

- 日期：2026-07-27
- 模型：`deepseek-v4-flash`
- verifier 模型（verified-strong 臂）：`kimi-k3`
- 规模：1 用例 × 1 臂 × 5 次

## 实验臂

- **rework-fresh-t8**（verified）：紧预算（maxTurns=8）下 fresh 返工：max_turns 后核查产物并全新重跑的成功率/成本

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens |
|---|---|---|---|
| rework-fresh-t8 | 80% | 16.8 | 54740 |

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens`

| 用例 | 覆盖面 | rework-fresh-t8 |
|---|---|---|
| hard-import-list | 高难：多约束组合（扫描+过滤+去重+排序+精确格式+字节纪律） | 4/5 · 16.8t · 55k |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

## 分析：跨厂商核查对照（vs deepseek-v4-pro 同负载 3/5）

唯一变量是 verifier 厂商（pro → kimi-k3），执行者、用例、臂、REPS 完全一致。

| verifier | 成功率 | 平均 tokens | 裁决质量 |
|---|---|---|---|
| deepseek-v4-pro | 3/5 | 140k | 实质裁决、带证据、1 例空输出被 fail-closed 兜住 |
| kimi-k3 | 4/5 | 55k | **全部 6 条裁决实质化带字节级证据，零噪声** |

### 读法与结论

1. **成功率差异（4/5 vs 3/5）主要是执行者方差**：kimi 批的 flash 四次首跑即对
   （裁决序列单 P），rework 只触发一次；不能归因给 verifier。真正的对照点是
   裁决行为。
2. **裁决行为跨厂商一致且优秀**：kimi-k3 的通过裁决全部带独立重算的字节级证据
   （"逐字节一致，164 字节、无末尾换行"），失败裁决全部对应真实缺陷（交付物
   缺失）；compat 模式 + thinking 模型下，JSON 裁决契约、fail-closed、重问机制
   全部照常工作，零空输出、零编造。
3. **定论：strong-verifier 核查模式是厂商可移植的通用 harness 模式**，不是
   deepseek 生态的巧合。修订版设计原则（"核查者 ≥ 执行者是稳妥默认，其确定
   优势是核查效率与裁决质量余量"）的最后一块拼图就位。

### 环境注记

api.moonshot.cn 需在代理的规则模式下配 DOMAIN-SUFFIX 直连（国内 API 的
DDoS 防护拒绝海外代理节点）；国内站 key 与国际站（api.moonshot.ai）不互通。

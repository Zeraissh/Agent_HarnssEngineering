# Harness A/B 对比报告

- 日期：2026-08-01
- 模型：`deepseek-v4-flash`
- 规模：5 用例 × 1 臂 × 2 次

## 实验臂

- **baseline**（single）：基准：当前工具描述 + 单跑，不做核查

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens |
|---|---|---|---|
| baseline | 90% | 4.9 | 16029 |

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens`

| 用例 | 覆盖面 | baseline |
|---|---|---|
| xhard-script-imports | 极难：多源聚合（scripts 入口 × 各自的相对依赖计数 × 排序格式） | 2/2 · 5.5t · 28k |
| xhard-export-chain | 极难：长依赖链（入口 → 本地依赖集 → 逐文件统计 → 聚合） | 1/2 · 6.0t · 21k |
| xhard-csv-bytes | 极难：字节级产物（LF 换行、无尾随字节、精确表格式） | 2/2 · 3.0t · 4k |
| xhard-report-arms | 极难：多文件模式提取（正则口径成文，跨 6+ 份报告去重排序） | 2/2 · 5.5t · 12k |
| xhard-unimported-tools | 极难：成文规则 vs 直觉（只看 cli.ts 的直接 import，不管间接使用） | 2/2 · 4.5t · 16k |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

## 分析：区分度评估——诚实结论与一个意外的金矿

### 总体：9/10（90%），读-析-产类任务对 flash 已基本饱和

五个维度里四个被 flash 稳定攻克（多源聚合、字节纪律、模式提取、成文规则判定），
平均 3-7 轮、4-40k tokens。csv-bytes 的 LF 陷阱没咬到人是结构性的：write_file
直通传字符串（\n 即 LF），CRLF 风险只存在于用 PowerShell echo 写文件的路径。
**结论：单文件级、约束再多的读-析-产任务已无法区分 flash 级模型。**

### 唯一的区分点是个意外的金矿：letter-vs-spirit 二次独立复现

xhard-export-chain 1/2 的失败答案是 24 = 12+12——执行者把 loop.ts 的多行
import（`} from "./types.js"`，行首非 import，按成文口径不算）语义化地算了进去，
而 types.ts 恰好有 12 个 export。这与 hard-import-list 的 stdio.js 陷阱
（多行 import 的续行）是**同一失败模式的第二次独立出现**：

> **当成文规则与语义直觉冲突时，flash 的遵从是不稳定的（两案合计约 50/50）。**
> 这不是能力缺口，是"规则遵从稳定性"缺口——恰好是 harness 可作用的层面
> （候选实验臂：system prompt 注入"成文口径优先于语义直觉"的纪律条款，
> 对照这两个用例的通过率变化）。

### 区分度前沿的下一站（本轮探明的边界）

1. **规模压力**：几十上百文件的扫描/聚合，逼出上下文与轮次张力；
2. **变更+回归**：改代码不许破坏构建/测试——错误面比只读任务大一个量级；
3. **紧预算**：hard 套件在 maxTurns=8 时区分度立刻回来（rework 轮已证）；
4. **letter-vs-spirit 系列化**：把这个二次复现的失败模式做成专门的小套件。

### 套件处置

xhard-* 五case 保留为回归覆盖面（配 golden/对抗双向自检的 checker 是固定资产），
区分度实验对 flash 改用 export-chain + import-list + 紧预算组合。

# Harness A/B 对比报告

- 日期：2026-07-25
- 模型：`deepseek-v4-flash`
- verifier 模型（verified-strong 臂）：`deepseek-v4-pro`
- 规模：4 用例 × 2 臂 × 2 次

## 实验臂

- **baseline**（single）：基准：当前工具描述 + 单跑，不做核查
- **verified-strong**（verified）：强 verifier 核查弱执行者（AB_VERIFIER_MODEL），假阴性是否消失、救回是否稳定

## 每臂汇总

| 臂 | 成功率 | 平均轮数 | 平均 tokens |
|---|---|---|---|
| baseline | 63% | 11.0 | 47272 |
| verified-strong | 75% | 16.3 | 70452 |

## 明细矩阵

单元格格式：`通过/次数 · 平均轮数t · 平均 k-tokens`

| 用例 | 覆盖面 | baseline | verified-strong |
|---|---|---|---|
| hard-unused-deps | 高难：跨文件依赖分析（子路径导入的前缀匹配陷阱） | 1/2 · 9.0t · 28k | 2/2 · 16.5t · 74k |
| hard-import-list | 高难：多约束组合（扫描+过滤+去重+排序+精确格式+字节纪律） | 0/2 · 15.0t · 50k | 0/2 · 22.5t · 92k |
| hard-substring-count | 高难：工具语义（grep -c 数行 vs 子串出现总次数） | 2/2 · 10.5t · 67k | 2/2 · 14.0t · 65k |
| hard-chain | 高难：跨文件依赖链（计数结果作为另一文件的行号索引） | 2/2 · 9.5t · 44k | 2/2 · 12.0t · 51k |

> 读法：对比 baseline 与 verified 看核查+返工是否提升成功率、代价多少 tokens；
> 对比 baseline 与 bare-tools 看工具描述里 "When to call" 的价值。

## 分析（对照 eval/ab-log.jsonl 逐 run 裁决）

### 核心发现：flash 的失败全是"没跑完"，没有一个"跑完但答错"

hard 用例确实把 baseline 压到了 63%——但拆开看，**所有完成（completed）的 run 全部
通过**，四个语义陷阱一个都没绊住 flash：
- 子路径导入陷阱（unused-deps）：flash 正确判定 `@modelcontextprotocol/sdk` 被
  子路径使用；pro verifier 的裁决还专门点名"子路径"确认了这一点。
- grep -c 陷阱（substring-count）：flash 直接用 `grep -o` 数出现次数（25），没掉坑；
  verifier 甚至用 grep -o 与 awk gsub 两种方法交叉验证——教科书级的独立重推导。

三个失败 run 的死因：
1. **API 基础设施错误 ×1**（unused-deps baseline rep2，7 轮后 stopReason=error）；
2. **max_turns 耗尽 ×4**（import-list 全部 4 个 run）：flash 逐文件 read_file 扫描
   14 个源文件，15 轮上限不够用。verified 臂 rep1 更是主 run 耗尽 → 返工又耗尽
   （30 轮 127k tokens 全打水漂）。

### 由此暴露的 verifier 适用边界（本轮最大产出）

**verifier+返工管线只覆盖"完成但错误"这一种失败；"根本没完成"的两种失败它都无能为力：**
- stopReason=error → 编排直接短路，核查根本不会运行；
- max_turns → 同样跳过核查；且返工从头再来，只会把同样的 15 轮再烧一遍（127k 铁证）。

结合上一轮（qwen 陷阱套件）的结论，verifier 的价值域被夹在两条边界之间：
执行者太强 → 没错可救（本轮完成即正确）；执行者失败在预算/基建层 → 救不着。
**只有"能力边界附近的语义错误"才是 verifier 的主场**（qwen 轮的 `"11"  \r\n` 正是）。

### 下一步指向（比"更强的核查"优先级更高的 harness 特性）

1. **轮次预算管理**：import-list 的正解是一条 grep 命令搞定全部扫描——差距在工具
   使用策略而非能力。候选实验臂：system prompt 注入"优先批量命令、避免逐文件读取"
   的策略提示（prompt-hint 臂），对照 maxTurns=15/30 的敏感性。
2. **基建错误重试**：stopReason=error 应在 loop/编排层重试一次，而不是让整个 run 作废。
3. **返工继承上下文**：max_turns 后的返工不该从零开始重烧预算（server-side 或
   摘要式续跑）。

### 方法学注记

- verified-strong 75% vs baseline 63% 的差距**不是真救回**：unused-deps baseline 的
  失败是 API 错误（运气），verified 臂只是没碰上——本轮零"核查救回"事件。
- verdict 重问机制（本轮上线）没有触发场景：唯一一次解析失败是"(空输出)"，按设计
  不重问维持 fail-closed。带内容的非 JSON 裁决在 qwen 轮出现过 2 次，等下轮验证。

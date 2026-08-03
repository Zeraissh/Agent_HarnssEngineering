# 真实任务案例 #1 — STM32L151 遥测+故障闩锁固件（2026-08-03）

**任务来源**：真需求——为用户的开源项目 stm32-gdb-mcp 造一个比 faultdemo 更丰富的
官方示例固件，同时给 L151 板子留一个可复用的板级自检模板。

**一句话任务书** → `--plan` 三角编排（planner 自主拆分 coding→debug 两包）。
执行者/核查者均为 deepseek-v4-pro。硬件：STM32L151RC（Cat.3）+ ST-Link/OpenOCD。

## 交付物（在 stm32-gdb-mcp/examples/firmware/stm32l151_telemetry，未提交，待用户审）

- 完整 CMake 工程：HSI 16MHz 显式切换、SysTick 1ms、RAM 遥测（magic/uptime/hclk）、
  `.noinit` 段（NOLOAD + `.noinit_head` 保证 magic 独占首字）、跨复位 boot_count、
  HardFault 现场闩锁（CFSR/HFSR/stacked PC/LR）、调试器故障注入口
- HW-VERIFY.md：五项真机实测 **5/5 PASS**（uptime 走时 −0.6%、HSI 确认 16MHz、
  boot_count 严格 +1、DIVBYZERO 闩锁、.noinit 跨复位保留）
- 双语 README

## 过程时间线（4 个 run）

1. `--plan` 全链路：s1(coding) ✔；s2(debug) 执行者遭遇 SWD 链路抖动（末段 5 次 halt
   失败 + 2 次 reset 失败），报告近空 → **verifier 独立连板发现无实测记录，如实拒签**
   （还指出报告符号地址未注明 Thumb 位）。快速失败。
2. s2 单包重跑（任务书加"少重连、失败先原地重试"纪律）→ 五项通过。
   **verifier 备注挖出真 bug**：boot_count 复位后 +510 而非 +1。
3. coding 包修复（SysTick 误挂的 `g_boot_count++` → main 内 magic 门控严格 +1）→
   verifier 亲手 clean rebuild 复核通过（只读命令白名单立功）。
4. debug 包复测（严格 +1 判定）→ 5/5，HW-VERIFY 更新。

前后另有：实验前双转储备份（Flash 256KB + EEPROM 8KB，SHA256 一致），实验后
`program` 烧回 + 全片重转储对哈希逐字节一致——环境无痕退出。

## 两个真发现（案例价值核心）

### 1. verifier 的备注比裁决更早暴露了固件缺陷

执行者在 HW-VERIFY 里如实记录了 +510，却把它**合理化**为"持续递增，PASS"；
verifier 通过硬件行为但在 summary 里点名增量与标注不符。规格缺陷（SysTick 里
`g_boot_count++`）由此浮出。**教训：裁决 summary/issues 是信号源，宿主不应只看
passed 布尔值。**

### 2. verifier 裁决端的 letter-vs-spirit 宽纵（新 harness 改进项）

验收标准白纸黑字"+1"，实测 +510，verifier 判 passed 只标"轻微报告不严谨"——
执行者身上被 rule-precedence 纪律治好的"成文规则 vs 语义直觉"摇摆，在
**核查者的裁决端**复现了。改进方向：把 rule-precedence 纪律延伸进 verifier 提示
（"验收标准按字面逐条判，不得以'实质合理'放行与标准不符的实测"）。

## Harness 摩擦点清单

- **SWD 链路抖动下的重连风暴**：执行者遇到 halt 失败倾向 stop/start 全套重连
  （首轮 7 次 start_debug_session），加剧不稳。任务书内嵌执行纪律有效缓解；
  机制层候选：MCP 工具结果里对瞬时链路错误给出"原地重试"提示。
- **调试包缺 write_memory**：故障注入是正当调试动作——已加入包白名单（本案催生）。
- OpenOCD 细节：该构建的 `flash write_image` 会静默中断，高层 `program` 命令可靠
  （执行 agent 一直用的就是它——工具选型上 agent 是对的）。

## 结论

一句话真任务 → 规划、双包接力、真机五项验收、缺陷发现与修复、逐字节还原现场，
全程 agent 完成、人只做验收决策。三角纪律两次拒签均正确（无实测=不签），
verifier 亲手重建+连板复核的第一手证据链完整。

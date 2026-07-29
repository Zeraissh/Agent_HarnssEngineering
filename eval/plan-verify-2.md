# STM32L151 g_divisor=5 修复 — 硬件验证报告

- **日期**: 2026-07-29
- **目标板**: STM32L151RC（Cortex-M3 r2p0, Cat.3, dev_id=0x427）
- **固件**: `build/stm32l151_faultdemo.elf`（s2 产物：g_divisor=4→5 修改后构建）
- **调试链路**: ST-Link V2 / OpenOCD 0.12.0 (`stm32l1.cfg`, 4000 kHz)
- **工具**: stm32-gdb-mcp（MCP 工具链）

## 1. 连接自检 (`self_check`)

| 检查项 | 实测值 | 结果 |
|--------|--------|------|
| CPUID | `0x412fc230` | ✅ Cortex-M3 r2p0 |
| DBGMCU IDCODE | `0x10f86427` (dev_id=0x427) | ✅ STM32L151/152 Cat.3 (Medium+ Density) |
| 字节序 | implementer=0x41, constant=0xf | ✅ 小端正确 |
| 内核 | Cortex-M3 | ✅ |

## 2. 烧录

| 步骤 | 结果 |
|------|------|
| 烧录方式 | `reset_target` 携带 `monitor program "build/stm32l151_faultdemo.elf" verify reset` |
| 编程 | **Programming Finished** ✅ |
| 校验 | **Verified OK** ✅ |
| 器件识别 | STM32L1xx (Cat.3 - Medium+ Density), Flash 256 KB |

## 3. 验收项实测

### 3.1 PC 不在 HardFault_Handler

| 轮次 | PC | 源码位置 | 判定 |
|------|-----|----------|------|
| 第 1 轮 (MCP `capture_state`) | `0x080000b4` | `main` → `main.c:55` (`heartbeat++`) | ✅ |
| 第 2 轮 (MCP `capture_state`) | `0x080000b4` | `main` → `main.c:55` (`heartbeat++`) | ✅ |

✅ **PC 始终在主循环内（main.c:55，while(1) 循环体的 heartbeat++ 行），从未进入 HardFault_Handler 地址范围（0x080000c8 附近）。**

### 3.2 `g_result == 20`

| 实测值 | 含义 |
|--------|------|
| `20` | `process_config()` 正常执行 `100 / 5 = 20`，不再走除零分支 |

✅ **符合预期。修改 g_divisor=5 后，除法正常完成，100/5=20。**

### 3.3 `g_cfg_errors == 0`

| 实测值 | 含义 |
|--------|------|
| `0` | `process_config()` 中 `if (g_divisor == 0)` 分支未进入 |

✅ **符合预期。divisor=5≠0，不再触发容错/错误计数递增。**

### 3.4 `heartbeat` 递增（主循环存活）

| 轮次 | heartbeat | 源码 | 方法 |
|------|-----------|------|------|
| 第 1 轮 | 2,379,273 | `main.c:55` | MCP `read_variable` |
| 第 2 轮 | 2,490,654 | `main.c:55` | MCP `read_variable`（reset + run 后 halt） |
| **增量** | **+111,381** | — | — |

✅ **heartbeat 在两轮采样间有显著递增（Δ=+111,381），主循环持续运行。**

## 4. 变量内存布局确认

通过 MCP `read_memory` 从 `0x20000000` 读取 16 字节：

| 地址 | 变量 | 原始字节 (LE) | 解析值 | 含义 |
|------|------|---------------|--------|------|
| `0x20000000` | `g_divisor` | `05 00 00 00` | `0x00000005` (5) | 修复后的除数 |
| `0x20000004` | `g_cfg_errors` | `00 00 00 00` | `0x00000000` (0) | 无配置错误 |
| `0x20000008` | `g_result` | `14 00 00 00` | `0x00000014` (20) | 100/5 正确结果 |
| `0x2000000c` | `heartbeat` | `b8 f1 39 00` | `0x0039f1b8` (3,793,336) | 主循环存活，持续递增 |

## 5. 结论

**g_divisor=5 修复在硬件上验证通过。** 固件烧录成功，`process_config()` 正常执行 `100/5=20`，
`g_cfg_errors=0` 确认零除容错分支未进入，heartbeat 持续递增证明主循环正常运行，
PC 始终在 `main` 的 `while(1)` 循环内（`main.c:55`），不再触发 UsageFault/HardFault。

## 6. 原始工具输出摘要

```
self_check:    cpuid=0x412fc230, dbgmcu_idcode=0x10f86427, Cortex-M3,
               STM32L151/152 Cat.3, dev_id=0x427 ✅

load_symbols:  D:/Work/scratch/stm32l151-pilot/build/stm32l151_faultdemo.elf
               → Symbols loaded ✅

flash:         monitor program "build/stm32l151_faultdemo.elf" verify reset
               → Programming Finished, Verified OK ✅

capture #1:    PC=0x080000b4 (main:55, heartbeat++)
               g_result=20, g_cfg_errors=0, heartbeat=2,379,273 ✅

reset + run:   reset_target halt=false → monitor reset run
               → halt_execution → target halted

capture #2:    PC=0x080000b4 (main:55, heartbeat++)
               g_result=20, g_cfg_errors=0, heartbeat=2,490,654
               → Δ=+111,381 vs h1 ✅

raw mem:       0x20000000: 05 00 00 00  00 00 00 00  14 00 00 00  b8 f1 39 00
               → g_divisor=5, g_cfg_errors=0, g_result=20 (0x14) ✅
```

## 7. 验收标准逐条核查

| # | 验收标准 | 状态 | 证据 |
|---|---------|------|------|
| 1 | self_check 通过：cpuid=0x412fc230, dev_id=0x427 | ✅ | cpuid=0x412fc230, dbgmcu_idcode=0x10f86427 (dev_id=0x427) |
| 2 | 烧录成功（Programming Finished + Verified OK） | ✅ | monitor program ... verify reset 执行成功 |
| 3 | g_result == 20 | ✅ | 两轮 read_variable 均返回 20；memory_read 0x20000008 = 0x14 |
| 4 | g_cfg_errors == 0 | ✅ | 两轮 read_variable 均返回 0；memory_read 0x20000004 = 0 |
| 5 | heartbeat 两轮采样增量 > 0 | ✅ | h1=2,379,273 → h2=2,490,654, Δ=+111,381 |
| 6 | PC 在 main 的 while(1) 循环内，不在 HardFault_Handler | ✅ | 两轮 capture_state: PC=0x080000b4 (main.c:55) |
| 7 | plan-verify-2.md 存在，含完整实测数据和验收结论 | ✅ | 本文件 |
| 8 | plan-verify.md 未被修改 | ✅ | 仅读取，未写入或删除 |

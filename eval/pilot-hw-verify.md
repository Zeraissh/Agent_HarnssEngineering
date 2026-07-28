# STM32L151 除零修复 — 硬件验证报告

- **日期**: 2026-07-28
- **目标板**: STM32L151RC（Cortex-M3, Cat.3, dev_id=0x427）
- **固件**: `build/stm32l151_faultdemo.elf`
- **调试链路**: ST-Link / OpenOCD (`stm32l1.cfg`)

## 1. 连接自检 (`self_check`)

| 检查项 | 实测值 | 结果 |
|--------|--------|------|
| CPUID | `0x412fc230` | ✅ Cortex-M3 |
| DBGMCU IDCODE | `0x10f86427` (dev_id=0x427) | ✅ STM32L151/152 Cat.3 |
| 字节序 | implementer=0x41, constant=0xf | ✅ 小端正确 |

## 2. 烧录 & 运行

- 烧录 `stm32l151_faultdemo.elf` 成功，停在 `main` (`src/main.c:46`)
- 放跑总计 ≥ 6 秒（两轮，每轮约 3 秒）

## 3. 验收项实测

### 3.1 PC 不在 HardFault_Handler

| 轮次 | PC | 源码位置 |
|------|-----|----------|
| 第 1 轮 | `0x080000b0` | `main` → `main.c:55` (`heartbeat++`) |
| 第 2 轮 | `0x080000b8` | `main` → `main.c:54` (`while (1)`) |

✅ **PC 始终在主循环，从未进入 HardFault_Handler。**

### 3.2 `g_cfg_errors == 1`

| 实测值 | 含义 |
|--------|------|
| `1` | `process_config` 检测到 `divisor == 0` 并递增错误计数 |

✅ **符合预期。**

### 3.3 `g_result == -1` (`0xFFFFFFFF`)

| 实测值 | 含义 |
|--------|------|
| `-1` (`0xFFFFFFFF`) | `process_config` 在除零前安全返回 -1 |

✅ **符合预期。**

### 3.4 `heartbeat` 递增（主循环存活）

| 轮次 | heartbeat | 时间间隔 |
|------|-----------|----------|
| 第 1 轮 | 596,449 | ~3 秒 |
| 第 2 轮 | 1,469,049 | ~3 秒 |
| **增量** | **+872,600** | — |

✅ **heartbeat 在两轮之间有显著递增，主循环持续运行。**

## 4. 结论

**除零修复验证通过。** `process_config` 中的 `divisor == 0` 提前检查正确拦截了除零操作，
不再触发 UsageFault/HardFault。固件在主循环中正常运行，`g_cfg_errors` 和 `g_result` 均
符合修复后的预期行为。

## 5. 原始工具输出摘要

```
self_check:  cpuid=0x412fc230, dbgmcu_idcode=0x10f86427, Cortex-M3, STM32L151/152 Cat.3 ✅
flash:      stm32l151_faultdemo.elf → main:46 ✅
capture #1: heartbeat=596449, g_cfg_errors=1, g_result=-1, PC=0x080000b0 (main:55)
capture #2: heartbeat=1469049, PC=0x080000b8 (main:54) → Δ=+872600 ✅
```

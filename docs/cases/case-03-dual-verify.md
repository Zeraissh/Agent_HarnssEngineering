# Dual-Board 对照验收报告

- **生成时间**: 2026-08-04
- **数据来源**: `board-A.md` (ST-Link) 与 `board-B.md` (DAPLink)
- **固件**: `stm32l151_telemetry.elf`
- **MCU**: STM32L151/152 (Cat.3), Cortex-M3

---

## 两板逐项对照表

### 验收项 (1): g_telemetry.uptime_ms 增量

| 指标 | Board A (ST-Link) | Board B (DAPLink) | 一致性 |
|------|-------------------|-------------------|--------|
| 采样前 uptime_ms | 19114 | 0 | ⚠️ 初值不同（A 非首次上电，B 刚烧录） |
| run_for_duration 设定 | 3.0 s | 3.0 s | ✅ 一致 |
| 工具报告 elapsed_sec | 3.306 s | 3.313 s | ✅ 接近 |
| 容差范围 (±10%) | [2975, 3637] ms | [2982, 3644] ms | ✅ 各自独立计算 |
| 采样后 uptime_ms | 22400 | 3313 | — |
| **实测增量** | **3286 ms** | **3313 ms** | ✅ 均落入各自容差窗 |
| **判定** | **PASS** ✅ | **PASS** ✅ | **双板 PASS** |

### 验收项 (2): hclk_hz 与 magic

| 变量 | 期望值 | Board A 实测 | Board B 实测 | 一致性 |
|------|--------|-------------|-------------|--------|
| g_telemetry.hclk_hz | 16000000 | 16000000 | 16000000 | ✅ 完全一致 |
| g_telemetry.magic | 0x54454C4D | 0x54454C4D | 0x54454C4D | ✅ 完全一致 |
| **判定** | | **PASS** ✅ | **PASS** ✅ | **双板 PASS** |

### 验收项 (3): reset_target 后 boot_count 与 uptime_ms

| 变量 | Board A (ST-Link) | Board B (DAPLink) | 一致性 |
|------|-------------------|-------------------|--------|
| g_boot_count 复位前 | 1 | 1 | ✅ 一致 |
| g_boot_count 复位后 | 2 (+1) | 2 (+1) | ✅ 均严格 +1 |
| g_telemetry.uptime_ms 复位后 | 802 ms | 807 ms | ✅ 接近，均 < 2000 |
| **判定** | **PASS** ✅ | **PASS** ✅ | **双板 PASS** |

---

## 总体结论

| Board | (1) uptime 增量 | (2) hclk/magic | (3) boot_count/归零 | 板级结论 |
|-------|:--:|:--:|:--:|:--:|
| Board A (ST-Link) | PASS ✅ | PASS ✅ | PASS ✅ | **PASS** |
| Board B (DAPLink) | PASS ✅ | PASS ✅ | PASS ✅ | **PASS** |

## 🟢 总体验收: **PASS**

两板三项验收全部通过。uptime 增量均在各自 ±10% 容差范围内，hclk 与 magic 均为期望值，复位后 boot_count 严格 +1、uptime 正确归零。Board A（ST-Link 烧录）与 Board B（DAPLink 烧录）行为一致，固件跨板运行正常。

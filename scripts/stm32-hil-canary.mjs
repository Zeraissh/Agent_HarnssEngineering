#!/usr/bin/env node
/**
 * BASE-04 / EVAL-01 残余 — STM32 HIL canary 入口（真机，默认不进 CI）。
 *
 * 设计：不在无探针的 CI 上假绿。本脚本：
 * 1. 检查 AGENT_HIL=1 才继续（否则 exit 0 + skip 文案）
 * 2. 要求 mcp.json / stm32 工具面可用
 * 3. 打印委托方应手工核对的自检清单（self_check → 读 CPUID）
 *
 * 完整 HIL 仍走真实任务案例路径（docs/cases/）；此处只把「发布门需要一条硬件面」
 * 落成可发现的脚本，避免一直只靠 held-out 软件用例。
 */
const enabled = process.env.AGENT_HIL === "1" || process.env.AGENT_HIL === "true";
if (!enabled) {
  console.log("STM32 HIL canary: skipped (set AGENT_HIL=1 with a live probe to run)");
  process.exit(0);
}

console.log(`STM32 HIL canary checklist (operator):
1. Detect probe (ST-Link or DAPLink) — exclusive lock held by this session only
2. start_debug_session + self_check (byte order / Cortex-M / family)
3. Read a known-good symbol or CPUID; compare to expected board
4. stop_debug_session; verify no leftover openocd (taskkill /T if needed)

Wire this into a future held-out ho-hil-* case once a stable board is always on the CI rack.
Today: manual / solo release gate evidence only.`);
process.exit(0);

import { defineConfig } from "vitest/config";

// 只收 test/ 下的单测——eval/fixtures/ 里的 fixture 自带 node:test 测试文件，
// 是被测【数据】而非本框架的测试；vitest 误收会以失败文件形式污染 npm test
// （2026-08-01 发现：此前靠 grep 管道掩盖了非零退出）。
//
// Coverage 棘轮（TEST-01a）：阈值锁在实测值下方一点，只许升不许降。
// 数字与理由见 docs/08-maturity-optimization-checklist.md TEST-01。
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**", "ui/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "ui/**/*.d.ts",
        // serve launcher 是 thin wrapper；覆盖率记在 server/history 上。
        "ui/serve.ts",
      ],
      reporter: ["text-summary", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      // 棘轮基线 2026-09-02 本机全量：
      //   statements/lines 77.68% · branches 81.2% · functions 91.54%
      // 锁在实测下方约 2–3pt，防偶然抖动误红，仍挡住真回退。
      thresholds: {
        lines: 75,
        branches: 78,
        functions: 88,
        statements: 75,
      },
    },
  },
});

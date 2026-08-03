import { defineConfig } from "vitest/config";

// 只收 test/ 下的单测——eval/fixtures/ 里的 fixture 自带 node:test 测试文件，
// 是被测【数据】而非本框架的测试；vitest 误收会以失败文件形式污染 npm test
// （2026-08-01 发现：此前靠 grep 管道掩盖了非零退出）。
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});

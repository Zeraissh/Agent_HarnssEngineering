# 评估基线报告

- 日期：2026-07-24
- 模型：`deepseek-chat`
- 结果：**5/5 通过**

| 用例 | 覆盖面 | 结果 | 轮数 | 总 tokens | 输出 tokens | 耗时 |
|---|---|---|---|---|---|---|
| write-basic | write_file 基本路径 | ✅ | 2 | 1512 | 86 | 3.9s |
| read-extract | read_file + 信息抽取 | ✅ | 4 | 5598 | 275 | 6.6s |
| bash-count | bash 工具 + 数值准确性 | ✅ | 4 | 3526 | 260 | 4.8s |
| multi-read-brief | 多文件读取 + 综合输出 | ✅ | 3 | 8879 | 395 | 5.7s |
| error-recovery | 工具错误恢复（is_error 回填后改道） | ✅ | 3 | 2544 | 161 | 3.4s |

> 总 tokens = input + cacheW + cacheR + output。改动 harness 后重跑 `npm run eval`，与本基线对比：
> 成功率下降 = 行为回归；轮数/tokens 显著上升 = 效率回归。

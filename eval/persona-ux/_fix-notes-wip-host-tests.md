# WIP 宿主散件测试收口

日期：2026-09-15  
范围：指定测试锁到绿。未 commit / 未 push / 未 `git add -A`。未切分支。走查 png / `.agent-*` 未动。

## 改了什么

- `src/execution-broker.ts`（`inspectOciOwnerLiveness`）：Windows 生产路径仍走 CIM `CreationDate`；**注入的 probe（单测 / hidepid）自己管可见性**。原先 win32 一律先打真实 PowerShell CIM，忽略 `readProcStat`，CIM 失败 + `signal-0` 成功就回 `unknown`（还带 2s+ 外壳），把 hidepid 锁「hidden + signal-0 → alive」打红。
- `ui/serve.ts`：启动行已接 `notifyArmedHint(Boolean(resolveOfficeNotifyFromEnv(...)))`，只印「飞书门禁通知已开」，不印 URL/token。本轮未再改。
- `test/progress-budget-context.test.ts`：已有 `ALWAYS_ON_BUILTIN_TOOLS.has("install_mcp")`，未改预算语义。

## 测试

`npx vitest run` 下列 10 文件：**109 passed / 0 failed**。

| 文件 | 结果 |
|---|---|
| `test/notify.test.ts` | 绿（已在仓，未补写） |
| `test/cite.test.ts` | 绿 |
| `test/execution-broker.test.ts` | 绿（修后） |
| `test/mcp-config-file.test.ts` | 绿 |
| `test/project-status.test.ts` | 绿 |
| `test/progress-budget-context.test.ts` | 绿 |
| `test/ui-message-queue.test.ts` | 绿 |
| `test/ui-message-queue-ui.test.ts` | 绿 |
| `test/mcp-catalog.test.ts` | 绿 |
| `test/skills-install.test.ts` | 绿 |

## 没做

- 未改 schedules / markdown / file-preview / global-search / planner / clarifier / task-completion / ask-user / spawn-task。
- 未改其余测试文件正文（实现已对齐）。
- 未提交、未推送、未碰 `.env`。

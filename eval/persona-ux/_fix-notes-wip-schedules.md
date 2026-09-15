# WIP：定时任务（六个预设 / 周规则 / 按项目）

日期：2026-09-15  
范围：`ui/public/features/schedules.js`、`test/ui-schedules-panel.test.ts`；测试锁已覆盖 `test/ui-scheduler.test.ts`、`test/ui-schedules-endpoint.test.ts`。  
未 commit / 未 push。未 `git add -A`。未切分支。  
未改 `app.js` / markdown / file-preview / global-search / `src/tools` / `src/planner` / `ui/serve.ts`。  
`ui/server.ts` 的 schedules 路由（weekly / `?projectId=` / 创建带项目）已在 HEAD，本轮不接线。

## 意图

把半成品做完：六个定时预设、周规则、按项目过滤。UI 与 `GET/POST /api/schedules` 同口径。空态 / 错误说人话。点预设才 POST，不预装条目。

**不是**开始菜单安装包，也不是 Keep-awake。

## 做了哪几条

| 条 | 状态 | 可见变化 |
|---|---|---|
| **六个预设** | 已改 | 空态六张卡片：每日简报 / 收件箱分拣 / 会前准备 / 每周复盘 / 选题备稿 / 盯一个主题。点一下才写入 `.agent-schedules.json`。 |
| **周规则** | 已改 | 人话「工作日 08:00」/「每周五 16:00」。新建表单多「每周」+ 星期勾选。载荷 `{kind:"weekly",days,hhmm}`。 |
| **按项目过滤** | 已改 | 当前项目 → `GET /api/schedules?projectId=`；创建带 `projectId`。客户端再滤一层，防旧服务端漏筛。 |
| **空态人话** | 已改 | 全局：「还没有定时任务——让 Agent 每天定时帮你干活」。选了项目：「这个项目还没有定时任务——点下面一张卡片，或自己建一条」。 |
| **错误人话** | 已改 | 列表 5xx / 非 JSON / 网络失败不再空白页，也不装成空态。`#schedules-list-error` 用 `humanizeHttpFailure`，脸上不出现 `HTTP 500`。表单 409 把「领域包」改成「这类任务」。 |

## 文件

- `ui/public/features/schedules.js` — `SCHEDULE_PRESETS` / `WEEKDAYS` / `describeSchedule(weekly)` / `filterSchedulesByProject` / `buildCreatePayload(weekly+projectId)` / `buildPresetPayload` / 周表单 / 项目空态 / `SCHEDULES_COPY` / 列表错误条 / `api()` 网络失败不抛
- `test/ui-schedules-panel.test.ts` — 预设目录、项目空态、列表失败、网络失败、weekly 表单 POST、表单 409 人话
- `test/ui-scheduler.test.ts` — 已有 weekly + `projectId` 落盘 / nextRunAt（本轮未再改逻辑）
- `test/ui-schedules-endpoint.test.ts` — 已有 h/i/j（weekly 创建、`?projectId=` 过滤、run 继承项目；本轮未再改）

## 测了哪些

```
npx vitest run test/ui-scheduler.test.ts test/ui-schedules-endpoint.test.ts test/ui-schedules-panel.test.ts
```

74 passed / 3 files。

锁：六个预设 id；点「每周复盘」才 POST `{kind:"weekly",days:[5],hhmm:"16:00"}`；选项目只渲染同一 `projectId`；列表 500 显示人话且空态 hidden；网络错误「定时任务列表加载失败（网络错误）」；weekly 表单默认工作日 + `projectId`；表单 409 无 `HTTP 409`。

## 没做的

- 开始菜单 / `desktop:dist` / 托盘安装包（#21，任务禁止）。
- Keep-awake、预装二进制、改 `ui/serve.ts`。
- 停用条目仍挂「立即运行」（security / Devin 走查写过；本轮不藏按钮）。
- 定时任务不是云端 session / 飞书频道（amp / doubao / openclaw 的「闹钟 ≠ orb」——不改口装成网关）。
- 未改 walks / VERIFY / BACKLOG / REPORT。
- 活 4173 若已在跑：静态 `schedules.js` 刷新即可；端点本就在 `server.ts`，不必为这一轮重启。

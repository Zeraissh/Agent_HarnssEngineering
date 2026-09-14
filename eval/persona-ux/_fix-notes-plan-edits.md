# 计划确认门 edits 落地（服务端）

日期：2026-09-14  
范围：`src/planner.ts`（短句补丁纯函数）、`ui/server.ts`（`POST /api/runs/:id/plan-approval`）、`test/planner.test.ts`、`test/ui-server.test.ts`。  
未 commit / 未 push。未改 CLI 横幅。未改 `ui/public/**`（前端契约已是 `edits: [{id,title,description}]`）。

## 谎话

Web2 #13 让计划卡可改标题/短说明，批准 POST 已带 `edits`。服务端原先只认 `decision`，执行面仍按 planner 原计划跑——界面改了字，下游看不到。

## 端点

`POST /api/runs/:id/plan-approval`

批准体：

```json
{
  "decision": "approve",
  "edits": [
    { "id": "s1", "title": "先读 CRC 再改位号", "description": "对照手册改 RCC" }
  ]
}
```

- `edits` 可省略或 `[]`：原计划，200。
- 每项只认 `id` + 非空 `title` / `description`。`pack` / `dependsOn` / `acceptance` 即使送来也不写。
- 能贴上的就贴；未知 id 进 `ignored`。一条都贴不上（非法 id / 只有空字段）→ **400**，门仍挂着，不 200 开跑。
- 否决带 `edits`：丢掉，不挡拒签。

200 响应：

```json
{
  "acknowledged": true,
  "plan": { "subtasks": [/* 实际采用的计划，含 title/description */] },
  "applied": [{ "id": "s1", "title": "…", "description": "…" }],
  "ignored": [{ "id": "ghost", "reason": "unknown_id" }]
}
```

实现：`onPlan` 把活 `Plan` 挂在 `pendingPlan` 上，settle 前 `applyPlanShortEdits` 写回同一对象（`runPlanned` 执行者/交接读的就是它）。有改动时再发一条 `plan`（`gated: false`）并在 `plan_approval_resolved` 带上 `edits`，Plan 面与执行面同字。

## 测试

```
npx vitest run test/planner.test.ts
npx vitest run test/ui-server.test.ts -t "计划门|v2-31|v2-32|v2-33|短句 edits"
```

**结果：** planner 32/32；ui-server 过滤集 7/7（含既有 v2-31/32/33/34 + 三条新锁）。未 commit。

锁：

- 纯函数：按 id 改短句；不传/空数组原计划；pack 等结构字段不写；非法 id 失败。
- 契约：改标题+短说明后执行者任务书是新说明、下游交接带新标题；响应带回采用的计划。
- 变异：不传 `edits` 仍走「做 A」原短句。
- 全非法 id → 400 且 `awaitingPlanApproval` 仍为 true。

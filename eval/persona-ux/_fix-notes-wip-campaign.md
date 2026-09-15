# WIP 战役锁（ask-user / spawn / 未跟踪 campaign 测试）

日期：2026-09-15  
范围：只改 `src/tools/ask-user.ts`、`src/tools/spawn-task.ts`、`test/spawn-task.test.ts`、未跟踪的 `test/campaign-*.ts` / `test/ui-campaign-api.test.ts`。未 commit / 未 push。未改 planner / clarifier / task-completion、`ui/public`、`ui/serve.ts`、schedules、README。

战役实现（`src/campaign.ts`、`src/tools/campaign-mail.ts`、`ui/campaign.ts`、`ui/server.ts` 里 POST `/api/campaigns` 与真开 StoredRun）已在仓；本轮只把锁补齐并跑绿。`src/` 战役模块本身没改——测试已对上现行为。

## 改了什么

| 条 | 状态 | 变化 |
|---|---|---|
| 战役邮件不进 ask-user 面 | 已改 | `withoutAskUser` 同时剔除 `campaign_mail`（与 ask_user / propose_handoff / spawn_task 同闸）。核查者/拆解者不能写 mailbox。 |
| 支线 spawn 回执带 runId | 已改 | 成功回执写 `runId：…`；失败回执同样带（导演还要 follow_up / cancel）。`withoutSpawnTask` 仍只摘 `spawn_task`，不摘邮件工具。 |
| campaign 锁（原在工作树外） | 已补 | mailbox 形状 / 拆役检测 / UI 战役 API 三份未跟踪测试收齐；补了 `campaign_mail` 工具、`parseCampaignMeta`、显式开战单制品草图。 |

## 测了哪些

```
npx vitest run test/spawn-task.test.ts test/campaign-mailbox.test.ts \
  test/campaign-split.test.ts test/ui-campaign-api.test.ts \
  test/ask-user.test.ts test/handoff.test.ts
```

**6 files / 88 passed**（约 3s）。其中本轮直接相关 4 文件 27 条：spawn-task 7、mailbox 5、split 8、ui-campaign-api 7。ask-user / handoff 是回归（`withoutAskUser` 闸）。

锁到的行为：spec-plus-deck 不拆（显式开战 409；`AGENT_CAMPAIGN=1` 走普通 run 不升导演）；战役 spawn 真开子 StoredRun、父事件带 `runId`、mailbox 只有任务书；关旗且仅 `AGENT_SPAWN_TASK=1` 仍是同 run 旁路；注入宿主缺省不写 `<workdir>/.agent-campaigns`；子 first-turn 不含邻居任务名。

## 没做的

- 没改 `src/spawn.ts`：同 run 旁路的 `runSpawnedTask` 仍不回 `runId`（注释写明 `runId` 只给战役 / `AGENT_CAMPAIGN=1` 真开的子 StoredRun）。
- 没动 `ui/server.ts` / `ui/public` / planner / clarifier / task-completion。
- 未 commit、未 push、未 `git add -A`、未切分支。

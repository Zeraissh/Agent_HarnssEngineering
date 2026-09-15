# Web UX 第六批（入库后剩余，未 commit）

日期：2026-09-15  
接在第五批 + 完成门同一提交 `5ddb01d` 之后。默认不 commit、不 push。  
未改 walks / VERIFY / BACKLOG / REPORT。未碰 clarifier / planner / task-completion / schedules / KaTeX / campaign。未冲掉第五批思考直播条。

## 做了哪几条

| 条 | 状态 | 可见变化 |
|---|---|---|
| **有产物还写「等待拆步…」** | 已改 | 走查里写完 txt 后右栏仍挂这句：rail 因产物打开，Progress 却没有步骤。`deriveProgressFace` 见到本场文件就把 `waiting=false`；空清单不再画 Progress 卡。未开计划、也没有文件的空跑仍 waiting（不把 incomplete 画成成功）。 |
| **#4 空态措辞** | 已改 | `CHANGES_COPY.empty` 不再写「本次运行没有写盘操作」。真没有写盘时改口「这一轮没有新的写盘记录」。有本场文件仍走 `setKnownWrites`，不出现空态。 |
| **拒答提示** | 已改 | `classifyStopReason("refusal")` 提示「换一种说法再试」，不再说「任务描述」。tone 仍是 bad。 |

未做：用量首页、`@` 弹旧对话、预览跳 file://、计划门停止当否决、失败条甩 HTTP、FATHOM 控制台、CLI `--plan` 无确认门、思考只写「正在想…」、`@` 只能浅列、产物画廊「还没有产物」、有页 incomplete 红失败。这些已关。

## 文件

- `ui/public/app.js` — `deriveProgressFace` 第三参 `hasSessionFiles`；`patchProgressPanel` 空卡收起；拒答 hint
- `ui/public/features/changes-panel.js` — `CHANGES_COPY.empty`
- `test/ui-app.test.ts` — 有文件不 waiting；拒答不说任务描述

## 测了哪些

```
npx vitest run test/ui-app.test.ts test/ui-changes-panel.test.ts test/progress-budget-context.test.ts
```

锁：空跑 `waiting === true`；有 `hasSessionFiles` 则 false 且未 settled；`classifyStopReason("incomplete").tone === "bad"` 未改；拒答 hint 不含「任务描述」。

## 4173

未杀宿主。静态 `app.js` / `changes-panel.js` 刷新即可。loop 补一轮仍要重启才吃到 `5ddb01d` 的 `src/loop.ts`。

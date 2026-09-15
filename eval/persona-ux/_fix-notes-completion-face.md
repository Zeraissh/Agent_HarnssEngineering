# 完成门体验修（与第五批同一提交）

日期：2026-09-15  
范围：`src/loop.ts`、`ui/public/app.js`、`ui/public/features/notifications.js`、`ui/public/features/command-center.js`、`ui/public/index.html`、`src/cli.ts`。  
未改 `AGENT_REQUIRE_FINISH_TASK`。未把 `end_turn` 当完成。未加 `STOP_REASONS`。未把没签字改写成 `partial`。未纳入 `src/task-completion.ts` 配图加严。未改 walks / VERIFY / BACKLOG / REPORT 结论。未改 `docs/05-findings.md`。

## 不变量

`completed` / `partial` / `blocked` 只能来自合法 `finish_task`。没签字 → `stopReason` 仍是 `incomplete`，`completion` 为空。宿主不伪造 finish_task。

`classifyStopReason("incomplete")` **保持 bad**（空跑锁）。有产物时走派生 `deliveryFace`，不改 stopReason。

## loop

兼容端点无视 `toolChoice=finish_task` 时，拒「非终结工具」与「无效 finish_task」**共用** `terminalCorrectionUsed`——恰好再 1 轮，其它工具仍不执行。再 bash / 再 end_turn → 仍 `incomplete`。第 4 轮合法 `finish_task` → `completed` / `partial`。

## 界面

`deliveryFace(stopReason, artifacts)`，产物证据用 `deriveArtifacts`（成功的 write_file / edit_file / write_pptx）。

- `incomplete` + 有落盘产物 → warn：「页面已写出，模型没签字」；占位「接着改已有页面…」；短注「这一轮已经停了，产物在右侧」；坞关着则打开最后一份 html（只认 deriveArtifacts，不扫 workdir）
- `incomplete` + 无产物 → 维持红「未能结构化收口…不能按成功处理」
- 收尾条、总览徽章、通知、指挥中心最近完成走 **face**
- Progress：`status=done` 后 `waiting=false`，不再给 running 项加 shimmer

未补「run 起止窗内 workdir 新增 html」：走查卡时间线主要是 `write_file`，不是 bash 写盘导致 `deriveArtifacts` 空。不写进 completion。

## CLI

`■ incomplete` 仍红。有写出文件时加一行黄注「已写 N 个文件，未签字」。

## 测了哪些

```
npx vitest run test/loop.test.ts test/ui-app.test.ts test/ui-notifications.test.ts
```

锁：拒 bash 后再有 1 次请求；第 4 轮仍 bash → incomplete、probe 0；第 4 轮合法 finish_task → completed/partial；`deliveryFace(incomplete, [index.html])` = warn 且 ≠ ok；空数组 = bad；`classifyStopReason("incomplete").tone === "bad"`；有产物的 incomplete 通知不进「未通过」。

## 4173

未杀宿主。`src/loop.ts` 在进程启动时已 import，**必须重启才吃到 loop 补一轮**。静态 `app.js` / `index.html` 刷新即可吃到 face。

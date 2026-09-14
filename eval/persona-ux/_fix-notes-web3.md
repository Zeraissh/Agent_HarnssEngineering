# Web UX 第三批（persona-ux web3）

日期：2026-09-14  
范围：`ui/server.ts`、`ui/workspace-files.ts`、`ui/api-errors.ts`、`ui/public/app.js`、`ui/public/index.html`、`ui/public/styles.css`、`ui/public/features/humanize-error.js` + 已接线的 feature 面板。  
未 commit / 未 push。未碰 git add / commit / reset / rebase。未改 walks / VERIFY / BACKLOG 结论。未改 `cross-app/**`。

先对照活代码，不凭第一批/第二批笔记当已修。

## 做了哪几条

| 条 | 状态 | 可见变化 |
|---|---|---|
| **#20 计划门停止 ≠ 否决** | 已改 | `planGateStopReason("stopped")` → `aborted`。计划门上点停止：发 `plan_approval_expired`（`cause: "stopped"`），`settle("stopped")`，列表 `stopReason=aborted`，`planDecision` 仍是空。否决按钮仍是 `plan_rejected`。宿主关停仍是 `plan_gate_expired`。读屏走既有「已停止」，不再写成「计划未获批准」。 |
| **#16 `@` 真列工作区文件** | 已改（在第二批「不弹旧对话」之上） | 输入框末尾、空白后的 `@` 弹出圈禁内浅列表（文件 + 目录）。`GET /api/workspace/files?workdir=&q=`：跳过隐藏 / `.env*` / `node_modules` / `.git` / `.agent-*`；`q=src/hel` 只列 `src/` 里匹配项。点选插入 `@path`（目录带尾 `/`）。`#` `/` `$` 仍不吃。`user@host` 不弹。「引用会话」按钮仍点名旧对话。空态：「输入 @ 可点名这个文件夹里的文件。旧对话用「引用会话」。」 |
| **#10 失败/限流人话扫尾** | 已改（composer 以外） | 服务端 429 正文走 `toBrowserApiError`：「前面还有人在交，请等几秒。」不再甩 `Mutation rate limit exceeded` / HTTP / 领域包。`humanizeSubmitError` 即使 body 是英文限额也走人话。composer 以外的条（删除 / 停止 / 上传 / 设置 / 变更 / 记忆 / 搜索 / 日程 / 产物 / 目录选择）走 `humanizeActionFailure` / `humanizeHttpFailure`。设置里的「领域包」菜单名没改——那是控件名，不是失败红字。 |
| **计划门停止后残卡** | 已改 | `run_end` 把仍 pending 的 `planApproval` 标成 `expired`。已关闭的 run：`awaitingPlan=false`，`patchPlanGate` 不再画「批准并开跑」。否决场、停止场、已过期场同一把锁。 |

## 跳过哪几条（已不成立，或本轮不该做）

| 条 | 为什么跳过 |
|---|---|
| **docs/06 第一屏再挑 2 条用户可见 UX** | 第一屏「开放」只剩评测档案、`docs/08` `[~]`、live-mu 对抗债。都不是用户能感觉到的界面。NVDA 听感 / 研究仪器按任务不碰。 |
| Work 409、默认先问、批准卡人话、写盘空态、发送叫发送、新手卡 | 第一批已落地，活代码仍在。 |
| CLI `--yes` / 非 TTY / resume / help | 第一批 CLI 路，不重做。 |
| 用量芯片、页内预览、桌面标题、全部项目、空态只在窗口下指令、计划门 title/description edits | 第二批已落地。本轮只把 `#16` 从「不弹旧对话」升级成「真列文件」。 |
| `@` 不弹旧对话（较小档） | 第二批已把 `#` `/` `$` 和旧对话从 `@` 拿掉。本轮保留「引用会话」，不再回退。 |
| 微信/飞书当宿主、electron-builder 开始菜单、完整 GitHub PR 流水线、重写文件树/IDE | 任务禁止。 |

## 测了哪些

```
npx vitest run test/workspace-files.test.ts test/humanize-error.test.ts \
  test/ui-changes-panel.test.ts test/ui-server-ux.test.ts
# 4 files / 28 passed

npx vitest run test/ui-server.test.ts test/ui-workdirs-api.test.ts \
  test/ui-patch.test.ts test/ui-app.test.ts \
  -t "v2-32|单一来源的状态变更超过窗口|workspace/files|批准并开跑|提交失败优先人话|composerCiteTrigger|14. 空态文案"
# 4 files / 8 passed | 899 skipped

npx vitest run test/ui-server.test.ts -t "计划门上点停止|计划门三种收场|v2-32"
# 4 passed | 269 skipped
```

新增/收紧的锁：

- `planGateStopReason` 三档：`rejected` / `expired` / `stopped` → `plan_rejected` / `plan_gate_expired` / `aborted`
- 计划门 `POST …/stop`：`stopReason=aborted`，`planDecision` 空，无子任务
- `GET /api/workspace/files` 圈内浅列、不列 `.env`、圈外 403
- `listWorkspaceFiles` 浅层、凭据/隐藏/node_modules 跳过、圈外空列表
- 停止/否决/`run_end` 后 rail 不再含「批准并开跑」
- 429 / Mutation rate / 「领域包」+ HTTP 不进脸上
- `composerCiteTrigger`：行首/空白后 `@` 才开文件；`#` `/` `$` / `user@host` 为 null

## 诚实缺口

- `cross-app/` 静态副本未同步（历史漂移）。
- `@` 只浅列一层（带 `dir/` 前缀再下一层），不是整树搜索，也不是 IDE 文件树。
- 设置页「领域包」仍是菜单名；失败红字才替换成「这类任务」。
- 未改 VERIFY / walks：档案仍写改前活页。
- 全仓 `ui-server.test.ts` 在别的会话并行满载时曾出现无关用例 5s 超时，本轮隔离跑计划门三档是绿的。

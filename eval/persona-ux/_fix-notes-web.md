# Web 前端 UX 修复笔记（persona-ux）

日期：2026-09-14  
范围：只改 `ui/public/**` 与前端测试。未 commit / 未 push。未改 `ui/server.ts`、`src/cli.ts`、`test/ui-server*.ts`。

## 改了什么文案 / 默认

| 条 | 状态 | 可见变化 |
|---|---|---|
| **#2** | 已改 | 新手卡 1/4「打一句话，回车」。写入圈改成设置一句「只能改这些文件夹」。3/4「需要时再开运行设置」，不再点名领域包 / 计划编排 / 独立核查。可跳过保留。 |
| **#3** | 已改（前端默认） | 「自动放行」默认不勾；档位说明「默认先问；勾上才自动放行」。设置「新对话默认先问再放行…」，不再写「新对话默认自动放行低风险工具」。`buildNewRunRequest` 未显式勾选时不带 `autoApprove`（服务端默认由另一路改成先问）。未把默认改回 auto。 |
| **#4** | 已改 | 变更区：API 空但本场有写出文件时只列文件。有成功写盘时不出现「本次运行没有写盘操作」。 |
| **#6** | 已改 | 批准卡主文案「要新建或改 …」；大按钮「允许」「拒绝」。工具名/JSON 在「详情」。短期允许相同参数也在详情里。 |
| **#5 / #20** | 已改 | 读屏收尾：`aborted`→「已停止」；`completed`→「运行已完成」；`plan_rejected`→「计划未获批准」；`plan_gate_expired`→「计划门未应答」。停 ≠ 完成 ≠ 否决。页头徽章原先已按 `classifyStopReason` 分档。若服务端把「计划门上点停止」写成 `plan_rejected`，那是另一路。 |
| **#7 / #28** | 已改 | 默认 Work 脸。空态「说要做什么，回车就发。」+「稿件、纪要、问答都可以从这里开始。」Work 卡：做纪要 / 做一页 / 带出处问答 / 更多稿件。Code 仍是仓库三张。日常 Work 空态不再套 `empty-state--design`（那会藏掉标语）；只有点开更多稿件才进目录。未做「还剩几次」（属 #11）。 |
| **#8** | 已改（收窄） | 「独立核查」从发送栏挪进「运行设置」。领域包 / 计划 / 多 agent / 评分表本来就在运行设置里。 |
| **#9** | 已改 | 按钮与 label「发送」；占位「说要做什么…」。选了稿件标题时仍可用「要「标题」做什么…」。 |
| **#17 空态半边** | 已改 | 产物画廊有卡片时清空并隐藏「还没有产物」；关闭时也清掉空态文案，避免和本场文件条并存。未做整页 `file://` 导航。 |
| **#25** | 已改 | 角色显示名：计划 / 助手 / 核查。提问卡「有 N 个问题需要你定」；计划卡「计划已拆出 N 个子任务」。不再署计明远 / 施敢当。 |
| **#27** | 已改 | 默认先问后，待决批准可以出现。若仍自动放行，指挥中心待决定空栏写「已自动放行：写了 …」。 |
| **#1 / #10（前端半边）** | 部分（前端） | `humanizeSubmitError`：优先服务端人话，剥「领域包」「HTTP 123」，不再拼 `提交失败（HTTP ${status})`。普通 Work 发送 409 本身归服务端那一路。 |

## 测了哪些

```
npx vitest run test/ui-patch.test.ts test/ui-a11y.test.ts test/ui-app.test.ts \
  test/ui-settings.test.ts test/onboarding.test.ts test/ui-changes-panel.test.ts \
  test/ui-command-center.test.ts test/ui-artifacts-panel.test.ts
```

**8 files / 817 passed**（约 14s）。axe 的 canvas `getContext` stderr 是既有 jsdom 噪音，不是失败。

新增/收紧的锁：批准卡人话 + 允许/拒绝；收尾句三分；提交错误去 HTTP/领域包；办公空态四卡；`setKnownWrites` 挡住空态谎话；指挥中心自动放行痕迹；产物空态不得和卡片并存；自动放行 checkbox 未 checked。

文档侧已同步（README / docs/06-backlog 第一屏 / docs/permission-modes / eval/persona-ux/README）。

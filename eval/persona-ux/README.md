# 人格走查评测（2026-09-14）

这是一份**当时**的评测档案，不是产品说明书。walks / VERIFY / BACKLOG / REPORT 里写「属实」的条目，不要改写成「已经没了」。回走用原角色剧本。

## 怎么读

| 文件 | 是什么 |
|---|---|
| [`habits.md`](habits.md) | 角色习惯卡：他为什么这样伸手。走查时只带这张卡。 |
| [`surfaces.md`](surfaces.md) | 三面怎么打开、冷启动屏幕上有什么字（评测当日）。 |
| [`walks/*.md`](walks/) | 20 张走查卡（角色 × 表面）。结论只来自活页原文 / HTTP / 亲手跑的 CLI。 |
| [`REPORT.md`](REPORT.md) | 第 3 波合成：按角色的好 / 不习惯 / 不实用。 |
| [`BACKLOG.md`](BACKLOG.md) | 28 条改进清单（命中次数 × 是否挡住第一次成功）。问题矩阵以这张总表为准。 |
| [`VERIFY.md`](VERIFY.md) | 对照当时活产品复核：属实 21 / 部分属实 7 / 不属实 0。 |

对话旁若另有对照 canvas，那是阅读视图；**不要**用它覆盖 walks / VERIFY 的结论。

## 当时环境（不要忽略）

- 活页：`http://127.0.0.1:4173/`，标题「FATHOM 控制台」。
- 多人抢同一台宿主：工作目录、侧栏旧标题、计划残卡会串台。VERIFY「走查碰撞」一节写了。
- 无痕 Playwright 每次都弹新手卡；本机用户若已点过「开始使用」可能不再看见。

## 和活产品的关系

评测是 2026-09-14 当时。之后 **CLI、服务端、前端第一/二/三批都已改**（未 commit）：

- 第一批：发送 / 「说要做什么…」、自动放行默认不勾、批准卡「允许」「拒绝」、默认 Work、停/完成/否决三分。
- 第二批：计划门可改标题/短说明且 `edits` 写入活计划；`@` 当时不弹旧对话（第三批起列文件）；「引用会话」是按钮；「全部项目」默认勾；空态「现在只能在这个窗口下指令」；GitHub 没连不给假开 PR；来源表；`consult · 查资料`；侧栏/指挥中心「今日 $」/「这次 $」；预览页内坞，不跳 `file://`；桌面窗框 `FATHOM` / `FATHOM · 对话`，`npm run desktop`，没有开始菜单项。
- 第三批：计划门上点停止 = 「已停止」（不是否决）；否决按钮才是否决；停/否决后不再钉「批准并开跑」。`@` 列出圈禁内文件/目录，插入 `@path`；「引用会话」仍是旧对话。失败条（含 composer 以外）429/HTTP/领域包改成一句人话。
- CLI `--plan` 仍是拆完就执行，没有确认门。

**前端已改，VERIFY 仍是改前活页。** walks / VERIFY / BACKLOG / REPORT **不要改写成「问题已消失」**。回走用原角色剧本。可见变化对照 [`_fix-notes-web.md`](_fix-notes-web.md)、[`_fix-notes-web2-app.md`](_fix-notes-web2-app.md)、[`_fix-notes-web2-usage.md`](_fix-notes-web2-usage.md)、[`_fix-notes-web2-preview.md`](_fix-notes-web2-preview.md)、[`_fix-notes-desktop.md`](_fix-notes-desktop.md)、[`_fix-notes-plan-edits.md`](_fix-notes-plan-edits.md)、[`_fix-notes-web3.md`](_fix-notes-web3.md)。

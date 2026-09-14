# 13 · 共享宿主 flash 评测后的产品债

日期：2026-09-14。评测证据在本机 `D:\Work\scratch\live-mu-20260914\evidence\`（`REPORT.md`、`整改清单.md`、评论组 A/B/C）。方法论见 [`docs/12-live-multiuser-harness-test.md`](12-live-multiuser-harness-test.md)。

评论组 B 的定性必须跟着走：D1 是文档化整表白名单过宽，不是意外泄漏；D3 是勾选不控 `runPlanned` 成文路径；D2 是门面/归档分叉，不是 persist 写错字段。优先级按评论组 C。

未测项单列「下轮对抗必做」，不要用绿测试假装本波能关。对抗-2（宿主 PID 39672）：U1 / U3 / U6 已锁；U2 / U4 / U5 仍未测。

---

## 缺陷项目

### D1 · writeRoots 整表白名单进可写圈

- **症状**：`extraWorkdirs=[]` 时 `run_config.writeRoots` 仍等于整张 workdir 白名单（产品仓、其他人设 scratch、以及评测 prep 里的 AGS / Fathom / RL-ALSR 等）。T2 `e408ed13-5755-4a74-91a4-3926a586efef` seq 7–8 读到产品仓 `templates/design/**`（读，不是写）。本轮无跨写。
- **根因**：文档化合同，同时是产品过宽。`src/types.ts` 成文「Web 宿主注入整份白名单」；`ui/server.ts` `buildConfig` / `pushRunConfigSnapshot` 把 `allowedWorkdirs` 整表拷进 `writeRoots`。
- **解决方案**：`mergeRunWriteRoots`：可写集 = 主 workdir ∪ 本 run 的 `extraWorkdirs`（显式勾选或显式选中的项目成员）。白名单只做准入。`readRoots` 可继续宽（模板只读）。
- **验收**：白名单 N 个目录、新 run 只选 1 个：`writeRoots` 不含其余；未勾选目录 `write_file` 失败。FakeModelClient，不碰真 4173。
- **状态**：本波完成
- **影响**：伤别人（本轮未写成）；单操作员也会伤自己的源码树

### D2 · 设计 mode 档案落成 single

- **症状**：T2 直播 `mode=design`，`meta.json` 与追问后列表为 `single`，`designRoute` 仍在。
- **根因**：档案合同：`ArchivedMeta.mode` 只有 `single | plan`；设计是单执行者门面。评论组 B：不宜当独立 persist bug。
- **解决方案**：不扩第三种 DurableRun mode。`ArchivedMeta` / 列表加 `facade: "design"` + 保留 `designRoute`。直播首轮 `mode=design`；追问合同仍是 single 执行，但 `facade`+`designRoute` 不丢。徽章认 `facade` / `designRoute`。
- **验收**：设计 run 的 meta 与追问后列表仍为 `design`，或有不可忽略的设计脸字段。
- **状态**：本波完成（门面诚实；档案 `mode` 仍是 `single`）
- **影响**：伤同一用户下一轮

### D3 · verify=false 的计划仍跑子任务核查

- **症状**：T4 `56314696-78fc-471d-8e08-7f32de9a07fb` POST `verify=false`，仍有 424 条 `sN/verifier` 事件。
- **根因**：`runPlanned` 成文走 `runVerified`。说谎的是勾选语义，不是编排实现。本波不拆 `runPlanned`。
- **解决方案**：文案写明「计划编排默认仍核查子任务」。列表加 `plannedSubtaskVerify`。
- **验收**：`verify=false` + `mode=plan` 时列表 `verify===false` 且 `plannedSubtaskVerify===true`；设置/提交栏文案诚实。
- **状态**：本波完成（文案 + 列表字段）
- **影响**：伤同一用户下一轮

### D4 · 新建项目吞旧 extras；自动绑定不扩写根

- **症状**：设为主留旧主目录；新建项目 `6ca522d8-f3fe-458d-b124-c7e0105b68a5` 成员含产品仓。T4 未选项目仍被 `projectIdForWorkdir` 入项。
- **根因**：壳层真缺陷。自动绑定发生在 extras 算完之后，本就不扩 `extraWorkdirs`；扩写根的是 D1。选中脏项目时 `extraWorkdirsFromProject` 会把产品仓当可写 extra。
- **解决方案**：设为主不勾回旧主目录；新建项目只快照当前主目录 + 当前勾选。自动绑定只展示，不扩 `writeRoots`。
- **验收**：设为主 extras 不含旧主目录；无 `projectId` 的 run 的 `writeRoots` 不含脏项目其他成员。
- **状态**：本波完成
- **影响**：伤别人（持久脏绑定）；伤同一用户下一轮

### D5 · 同 run 追问静默丢 citedRunIds

- **症状**：T1 `2ebe23f3-bba9-4d09-9286-3491324899db` 追问不装配 cite；新建 `80557c02-…` 正常。
- **根因**：契约。现状测试把「丢」锁成绿。
- **解决方案**：接线，不 400。`buildFollowUpRequest` / `postFollowUp` 带 `citedRunIds`；`POST /messages` `applyFollowUpCite` 与新建同口径（同 workdir / 同项目）。空数组清本轮 `citeContext`。跨目录 ID 跳过、不 400。
- **验收**：追问带 `citedRunIds` 必须装配或 4xx。
- **状态**：本波完成（已接线）
- **影响**：伤同一用户下一轮

### D6 · 列表陈旧 stopReason

- **症状**：已 `running` 仍挂上一轮 `incomplete` / `completed` / `aborted`（T2/T3/T1）。
- **根因**：置 running 时未清终止因。
- **解决方案**：列表投影：`status=running` 时 `stopReason` / `finalPassed` / `verdictTurn` 为 null；上一轮进 `lastStopReason` / `lastFinalPassed` / `lastVerdictTurn`。不擦 persist。
- **验收**：`status=running` 时 `stopReason` 为空或 stale。
- **状态**：本波完成
- **影响**：伤同一用户下一轮

### D7 · 无滤参产物画廊落到宿主默认

- **症状**：`GET /api/artifacts` 无滤参落到产品仓空画廊。
- **根因**：缺参静默默认仓。现状测试锁的是旧语义。
- **解决方案**：缺参 400（与 cite-candidates 同口径）。前端 `#/artifacts` 带 composer / 项目 / snap workdir。
- **验收**：无滤参不得静默落到产品仓空画廊。
- **状态**：本波完成
- **影响**：伤同一用户下一轮

### D8 · site-zip 打包同级残渣

- **症状**：T2 site-zip 约 9.3 MB，含 webb_* / `_qa`。
- **根因**：`walk` 整目录。
- **解决方案**：同目录站点资产 + HTML/CSS 引用闭包；跳过 `_qa` / `_` 前缀 / `webb_*` / `node_modules` / `.git`。
- **验收**：体积与路径树一致。
- **状态**：本波完成
- **影响**：伤同一用户下一轮

### D9 · 直播 transcript 空、追问 recap 停在 turn1

- **症状**：直播 `GET /transcript` `segments=[]`；追问后 recap 停在 turn1。
- **根因**：按需拉的面只给已封口段；recap 不重算。
- **解决方案**：便宜刀：接口写明 `sealedOnly: true`（loop `done` 才 push；首轮直播空段是契约）。追问 `finalizeRun` 已重算 recap，加锁。不做直播开段（会胀）。
- **验收**：直播有段或写明仅封口；追问后 recap 覆盖本轮。
- **状态**：本波完成（契约诚实 + recap 锁；不做直播开段）
- **影响**：伤同一用户下一轮

### D10 · 欢迎默认主目录落在产品仓

- **症状**：欢迎页默认 workdir 是产品仓。叠在 D1 上是日常第一脚。
- **根因**：宿主启动 `workdir` / 白名单第一项。
- **解决方案**：UI `pickWelcomeWorkdir`：有上次选择用它；宿主 cwd 是产品仓且白名单另有目录时改选 scratch。不改 `/api/harness.workdir`（测试仍认启动 cwd）。
- **验收**：欢迎默认不是产品仓，或明确警告会写进源码树。
- **状态**：本波完成（UI 默认；API 默认 cwd 不变）
- **影响**：伤同一用户下一轮

---

## 下轮对抗必做

对抗-2（2026-09-14，PID 39672，证据 `evidence/adversarial-2/`）：U1 / U3 / U6 已锁。U2 / U4 / U5 仍未测，不要绿测假装关。

| ID | 项 | 状态 | 说明 |
|---|---|---|---|
| U1 | 第 5 个 run 429 | **对抗已锁** | `activeRuns=4` 后第 5 POST 429 `Active run limit reached (4)`；四 holder 仍 running；否决后 0 |
| U2 | 日预算 429 | **仍未测** | `dailyConfigured=false`，本宿主未武装，未编造 429 |
| U3 | ask_user | **对抗已锁** | `d7074a6e-…` 真调 `ask_user` + `POST /answer` 200，同 run 写 `notes-a.md` |
| U4 | 真隐藏标签约 20s | **仍未测** | `document.hidden` 从未 true；Playwright / 最小化不进 hidden 生命周期 |
| U5 | 战役 / spawn_task | **仍未测** | `campaignArmed=false`，未 POST `/api/campaigns` |
| U6 | 客户端计划 SSE | **对抗已锁** | `a58993fa-…` planner `done` seq 26 后页面仍收到 `plan_result` / `run_end` |

---

## 运维残留

评测项目 `T5-live-mu-chat`、禁用定时 `T5-draft-disabled`、T2 `design/` 调研残渣：见证据目录附录，不进产品功能债。

---

## 本波验收记录（2026-09-14）

Step 1 完成：D1、D3（文案 + 列表字段）、D4。

Step 2 完成：D2、D5、D6、D7、D8、D9（便宜刀）、D10（UI 默认）。未拆 `runPlanned` 内置核查。未 git commit。未开真机对抗。

对抗-2：U1 / U3 / U6 对抗已锁；U2 / U4 / U5 仍未测（日预算未武装 / 真隐藏未做成 / 战役干净缺席）。未 git commit。宿主测完仍 4173 PID 39672，flash，idle。

绿测（FakeModelClient）：`ui-design-archive`、`ui-cite-api`、`ui-zip`、`ui-artifacts-api`、`ui-artifacts-panel`；`ui-app` 定点 cite/welcome；`ui-patch` 定点 office 脸；`ui-server` 定点 transcript / plan 追问 / site-zip。细节见证据目录 `待做项目.md`。

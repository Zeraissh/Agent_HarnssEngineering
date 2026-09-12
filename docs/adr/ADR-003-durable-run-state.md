# ADR-003: Durable RunState（分阶段）

**Status:** Accepted（Phase 1–3 已落地；SAFE-06 Phase 1 toolTx 已落地；半截 DAG 同 run 续发射已落地；CLI 对等 durable / mid-tool 自动重放 / 零进度 plan 仍为残余）  
**Date:** 2026-09-02（Phase 2+3：2026-09-03；SAFE-06 Phase 1：2026-09-03；半截 DAG：2026-09-10）  
**Deciders:** Agent_Design 维护者  
**Related:** RUN-01 / RUN-02；B2 `ui/history.ts`；SAFE-04 grant 边界；SAFE-06 toolTx；OBS-01 `trace.jsonl`

## Context

今天 Web 宿主的“可恢复”能力停在 **B2 运行历史落盘**：

- `meta.json` + `events.jsonl` + `transcript.jsonl`（+ OBS-01 `trace.jsonl`）按 run 分目录；
- 重启后档案是 **archived / 只读**；有 checkpoint 时可 **派生新 run** 续跑，明确不冒充原进程无缝继续；
- 挂起审批的 `respond` 回调、AbortController、ExecutionBroker、在飞 HTTP 请求 **不可序列化**——收尾时已宣告过期并写入事件流。

这对“看历史 / 从检查点开新分叉”够用，但对 RUN-01 完成定义仍不够：

> 持久化 plan DAG、segment、审批/提问、verifier/rework、预算与 tool transaction；**进程重启从明确状态恢复**。

缺口：

1. **Plan DAG** 曾只活在内存 / 事件流里——Phase 1 已有任务/边快照；**2026-09-10** 补了节点状态，半截 DAG（至少一枚 passed）可同 run 续发射。`plan_gated` 崩溃回到确认门；零进度 / 节点中途仍不能热续 DAG（有任务正文可 reopen）。
2. **审批/提问** 的 live grant 与 settle 回调跨进程不可恢复（SAFE-04 已明文：GOV-01 之前不允许跨重启恢复 capability）。
3. **Tool transaction**（SAFE-06）尚未存在——没有 prepared/committed，崩溃注入无法证明“不重复副作用”。
4. **Verifier/rework 指针** 依赖事件回扫，没有显式状态机游标。

约束（不可违背）：

- 单操作员形态：不引入租户身份（GOV-* 仍搁置）。
- 便利功能不许削掉不变量：不能为了“自动续跑”把 once-grant 或审批记录变没。
- 仪器纪律：注入的 modelClient / Fake 路径不得被 durable 层误武装。
- host-lags：若新增 TurnEvent 字段，CLI + `app.js` 三处同提交。

## Decision

采用 **显式 Durable RunState 文档 + 分阶段实现**，与现有 history 目录共存，不另起数据库（Phase 1）。

### 状态机事实源

新增可选文件：`.agent-run-history/<runId>/state.json`（整写 + rename，同 meta）。

```text
version: 1
runId, rootRunId?, continuedFrom?
phase: created | planning | plan_gated | executing | verifying | reworking
       | awaiting_approval | awaiting_question | completed | failed | closed
       | interrupted
plan?: { protocol, tasks[], edges, approvedAt?, rejectedAt?, nodes? }  # DAG + 节点状态
segment: { index, source, startedAt }
verification?: { round, recovery?, lastVerdictHash? }
budget: SharedRunBudget 快照                    # Phase 2
approvals: { pendingIds[], grantAudit[] }       # Phase 2：只审计，不恢复 active grant
lastSameRunResumeAt?: number | null             # Phase 2
toolTx: DurableToolTx[]                         # SAFE-06 Phase 1：prepared|running|committed|failed|aborted
```

Idempotency 边界：

- **续跑入口**（同 run）：单执行者仍是 **checkpoint 段号**（interrupted + 已提交 main done）。编排用 **节点快照**（至少一枚 passed、无 failed、有 remaining），不靠 `sN/main` 会话检查点。
- **副作用提交**：`idempotencyKey = runId:toolUseId`；同 key 已 `committed` 不得再执行；`write_file` 另有内容级幂等；`bash` 在 prepared/running 残留上 **fail-closed 不重试**（无 undo）。

## Addendum — SAFE-06 Phase 1（2026-09-03）

| 已落地 | 残余 |
|---|---|
| `src/tool-tx.ts` + TurnEvent `tool_prepared/running/committed/failed/aborted` | CLI 对等 durable `state.json`（CLI 仅内存 toolTx + 事件） |
| `DurableRunState.toolTx` 进 state.json；prepared 刷盘后再副作用 | 未完成 assistant 轮的 **自动 mid-tool 重放** |
| `write_file` / `bash` 武装；崩溃注入同 key 不重复写 | bash **compensation/undo**（明确不做假） |
| CLI + Web reducer/渲染同提交；RUN-02 扩展 | MCP 写类工具未进 SIDE_EFFECT 集合 |

`canSameRunResume` **不**因 toolTx 放宽——续跑入口与副作用幂等是两层。

## Addendum — 会话中心化（2026-09-03）

| 变化 | 说明 |
|---|---|
| 新迁移 `reopen` | `completed / failed / closed / interrupted → executing`（挂起 id 清空；budget / grantAudit / toolTx 保留）。同进程内对已收尾的 run 追加新一轮对话时由宿主显式调用。与 `resume` 是两件事：resume 只在崩溃相 `interrupted` 上同 run 热恢复；reopen 是"这场对话还没完"。`created / planning / plan_gated / awaiting_*` 上拒绝——那些相意味着有一轮还没结束 |
| 收尾一律进终态 | `finalizeDurableState` 去掉了"可追问的 completed 保持 executing"的例外（当初为了让下一轮的 `segment_begin` 不被非法迁移挡住）。两轮之间 state.json 说的是实话：这一轮完了 |
| 检查点来源 = 执行者谱系 | `main` **与 `rework`** 段都更新 checkpoint / budget_snapshot；此前只认 main，返工后的正史从未进过检查点。verifier / planner / `sN/*` 仍不算 |
| `meta.outcome.judgedTurn` | 裁决核查的是第几轮对话；列表 `verdictTurn` 由此恢复 |

`canSameRunResume` 的单执行者门没动（interrupted + checkpoint + 非 verify）。编排另走节点事实：`verify` 不挡（子任务核查已经写进 node status）；没有 passed / 有 failed / 没有 remaining / 未批准 → 仍拒。完成态编排归档的**对话追问**仍走单执行者或 fork，不是 DAG。无检查点的归档也可 fork 成"无正史的新一轮"（`run_forked.checkpoint = null`）。

## Addendum — 半截 DAG 同 run 续发射（2026-09-10）

编排的检查点不能用 `sN/main`：会话中心化后那不是执行者谱系。续跑入口是 **节点快照**，不是 main checkpoint。

| 已落地 | 残余 |
|---|---|
| `DurablePlanNode` + `plan_progress` 增量刷 `state.json` | `plan_gated` 崩溃走 `restore_gate`（回到确认门，不 close） |
| `planResumeFacts`：批准 + 至少一枚 passed + 无 failed + 有 remaining | 零进度（全 pending / 第一子任务中途）不能同 run |
| `runPlanned({ plan, resume })` 跳过 passed、种子交接；与 `replan` 互斥 | 节点中途新 `toolUseId`（既有 mid-tool 残余） |
| Web `startSameRunResume` 注入同一张图；不重跑 planner、不重开计划门；`plan_resume` | 完成态追问仍单执行者 |
| CLI `--resume-run`：`prepareCliPlanResume`（executing 先 interrupt）+ 节点落盘 | 零进度 / 节点中途仍不续 |
| CLI 谱系预算：`durableBudgetExhausted` + settle/SIGINT `budget_snapshot` + `seedDurableBudget` | 无快照 fail-open；CLI 无「追加预算」旗标 |
| CLI 单执行者 `--resume-run`：`executor_checkpoint` + transcript + `runContinuation` | 飞行中无检查点不续；`--verify` 拒 |
| CLI `meta.json` + 收尾 `run_end`（Web 列表可见） | 旧档案缺 `host` 不标 |
| CLI TurnEvent → `events.jsonl`（与 Web 同一投影；delta 不占 seq） | CLI 不写 `plan_warning` |
| CLI `plan` / `plan_result` 进档案（与 Web 同一形状；续发射不重写 `plan`） | 旧 CLI 档案仍无这两条 |
| CLI `plan_resume` / `plan_replan` 进档案（与 Web 同一形状） | CLI 无 `--replan` 入口 |
| `meta.host=cli` + 列表徽章 | 旧档案缺字段不标 |

变异：`plan-resume-without-passed`。

**恢复语义（Phase 1）**：

| 崩溃时 phase | 重启后行为 |
|---|---|
| `created` / `planning` | 标 `closed` + 合成 `run_end`；不可续，可派生 |
| `plan_gated`（未批准） | **保持在门上**（`restore_gate`）；同 run 回到确认门，CLI 不代签 |
| `awaiting_approval` / `awaiting_question` | 全部 pending → expired 事件；**不**自动应答；可派生 |
| `executing` / `verifying` / `reworking` | 标 `interrupted`；用 checkpoint + transcript **派生新 run**（沿用 B2），state 记录 lineage |
| `completed` / `failed` / `closed` | 只读 |

Phase 1 **明确不做**：同 runId 热恢复、跨重启复用 active grant、tool compensation。

**恢复语义（Phase 2 增量）**：

| 条件 | 行为 |
|---|---|
| `interrupted` + 已提交 main checkpoint + 非 verify/plan + 预算未耗尽 | **同 runId 热恢复**（`sameRunResume:true`，`continuationMode:"same-run"`）；首条事件 `run_resumed`；新建 AgentLoop/AbortController；**不**恢复 active grant；**seed toolTx** |
| 同上但无 checkpoint | 不谎称热续；有任务正文可 **reopen** 一轮（不重放飞行中工具）；完成态归档仍 fork |
| `interrupted` + `mode=plan` + 计划已批 + 至少一枚 `passed` + 无 `failed` + 有 `pending`/`running` + 预算未耗尽 | **同 runId 半截 DAG 续发射**：注入同一张图，跳过 passed；不重跑 planner、不重开计划门；事件 `plan_resume`。不靠会话检查点 |
| `plan_gated` 崩溃 | **restore_gate**：同 run 回到确认门 |
| 零进度（全 pending 或第一子任务中途） | 不能热续半截 DAG；有任务正文可 reopen 一轮，不假装有检查点 |
| 完成态归档 + checkpoint | 仍走 **fork**（新 runId）；`sameRunResume:false` |

### Phase 划分

| Phase | 范围 | 验收 |
|---|---|---|
| **1（已落地）** | 写 `state.json` 与 phase 迁移；崩溃档案带 phase；计划 DAG 快照进 state；与 meta/checkpoint 一致；单测 + 变异（丢 phase 变红） | docs/08 RUN-01 → `[~]` |
| **2（已落地）** | 同 run 热恢复执行游标（idempotency = checkpoint）；预算/grantAudit 进 state；UI/API `sameRunResume` 诚实；变异 `same-run-resume-allows-executing`。**半截 DAG（2026-09-10）**：节点快照 + `plan-resume-without-passed`。**CLI `--resume-run`**：半截 DAG + 单执行者检查点 | docs/08 RUN-01 仍 `[~]`（零进度 / 飞行中无检查点 / mid-node） |
| **3（已落地）** | 崩溃注入套件（RUN-02）+ SAFE-06 Phase 1 tool prepared/committed | docs/08 RUN-02 / SAFE-06 → `[~]` |

### 与现有件的关系

- **events.jsonl** 仍是 UI 重放事实源；state.json 是 **编排游标**，不是第二套事件流。
- **OBS-01 trace** 旁路观测；不参与恢复决策。
- **SAFE-04**：Phase 1–2 只持久化 grant **审计**；激活仍禁跨重启。
- **SAFE-06**：toolTx 进 state；生命周期事件进 events.jsonl。

## Options Considered

### A. 只靠 events.jsonl 回放推导状态

复杂度低，但“计划门中途 / 多子任务并发”推导昂贵且易与 live Map 漂移。否决为唯一方案；可作校验器。

### B. 外置 DB / 队列

过早；单操作员无多实例需要。保留为多人生产前置。

### C. 本 ADR（state.json + 分阶段）

与 B2 同构、可测、不扩大密钥面。采纳。

## Consequences

- 正向：RUN-01 有可验收的 Phase 1–2 边界；SAFE-06 同 key 不重复 commit 可证。
- 负向：mid-tool **自动重放**未完成轮仍不做——界面须诚实；bash 无 compensation。
- 风险：state 与 events 短暂不一致——写序必须 **先 append 相关事件，再写 state**（或同链 enqueue）；prepared 额外 `flush` 后再副作用。

## Phase 1–2 非目标（更新后残余）

- ~~SAFE-06 tool transaction（prepared/committed）~~ → Phase 1 已落地，见上表残余
- GOV-01 主体绑定的跨重启 grant
- CLI 对等 durable state（Web 先行；CLI 已有 state.json + meta.json + TurnEvent 事件流 + `host=cli` 列表徽章 + `plan`/`plan_result`/`plan_resume`/`plan_replan` 宿主事件 + 半截 DAG / 单执行者 `--resume-run`；飞行中无检查点仍不续；CLI 无 `--replan` 入口；CLI 不写 `plan_warning`；旧档案缺 host 不标）
- mid-tool 未完成 assistant 轮自动重放（节点中途会拿到新 `toolUseId`）
- 零进度 plan（全 pending / 第一子任务中途）同 run 续发射
- bash undo / 通用 compensation
- MEM-01 语义压缩（独立项，已另轨）

## Implementation notes

1. ~~`src/run-state.ts`：类型 + `transition` + `canSameRunResume`~~
2. ~~`ui/history.ts`：`writeState` / `readState` / Phase 2 字段解析~~
3. ~~`ui/server.ts`：迁移接线、崩溃收口、same-run followUp、预算/grant 快照~~
4. ~~UI：`continuationMode:"same-run"` + `run_resumed` reducer/装配条~~
5. docs/08 RUN-01 / SAFE-06 / RUN-02 / AGENT-01 保持 `[~]`；残余写清。
6. ~~RUN-02 崩溃注入套件~~；~~SAFE-06 Phase 1~~（`src/tool-tx.ts` + `test/tool-tx.test.ts`）。
7. ~~半截 DAG 同 run 续发射~~（节点快照 + `runPlanned({plan,resume})` + Web `plan_resume` + CLI `--resume-run`）。

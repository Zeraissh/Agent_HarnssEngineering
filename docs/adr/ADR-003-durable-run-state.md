# ADR-003: Durable RunState（分阶段）

**Status:** Accepted（Phase 1–2 已落地；Phase 3 / RUN-02 崩溃注入套件已落地；SAFE-06 toolTx / CLI 对等仍为残余）  
**Date:** 2026-09-02（Phase 2+3：2026-09-03）  
**Deciders:** Agent_Design 维护者  
**Related:** RUN-01 / RUN-02；B2 `ui/history.ts`；SAFE-04 grant 边界；OBS-01 `trace.jsonl`

## Context

今天 Web 宿主的“可恢复”能力停在 **B2 运行历史落盘**：

- `meta.json` + `events.jsonl` + `transcript.jsonl`（+ OBS-01 `trace.jsonl`）按 run 分目录；
- 重启后档案是 **archived / 只读**；有 checkpoint 时可 **派生新 run** 续跑，明确不冒充原进程无缝继续；
- 挂起审批的 `respond` 回调、AbortController、ExecutionBroker、在飞 HTTP 请求 **不可序列化**——收尾时已宣告过期并写入事件流。

这对“看历史 / 从检查点开新分叉”够用，但对 RUN-01 完成定义仍不够：

> 持久化 plan DAG、segment、审批/提问、verifier/rework、预算与 tool transaction；**进程重启从明确状态恢复**。

缺口：

1. **Plan DAG** 只活在内存 / 事件流里，没有一等 `PlanState` 快照可在“计划门已批准、子任务跑到一半”处精确续发射。
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
plan?: { protocol, tasks[], approvedAt?, rejectedAt? }   # DAG 快照
segment: { index, source, startedAt }
verification?: { round, recovery?, lastVerdictHash? }
budget: SharedRunBudget 快照                    # Phase 2
approvals: { pendingIds[], grantAudit[] }       # Phase 2：只审计，不恢复 active grant
lastSameRunResumeAt?: number | null             # Phase 2
toolTx?: never                                  # 禁止直至 SAFE-06
```

**恢复语义（Phase 1）**：

| 崩溃时 phase | 重启后行为 |
|---|---|
| `created` / `planning` / `plan_gated`（未批准） | 标 `closed` + 合成 `run_end`；不可续，可派生 |
| `awaiting_approval` / `awaiting_question` | 全部 pending → expired 事件；**不**自动应答；可派生 |
| `executing` / `verifying` / `reworking` | 标 `interrupted`；用 checkpoint + transcript **派生新 run**（沿用 B2），state 记录 lineage |
| `completed` / `failed` / `closed` | 只读 |

Phase 1 **明确不做**：同 runId 热恢复、跨重启复用 active grant、tool compensation。

**恢复语义（Phase 2 增量）**：

| 条件 | 行为 |
|---|---|
| `interrupted` + 已提交 main checkpoint + 非 verify/plan + 预算未耗尽 | **同 runId 热恢复**（`sameRunResume:true`，`continuationMode:"same-run"`）；首条事件 `run_resumed`；新建 AgentLoop/AbortController；**不**恢复 active grant |
| 同上但无 checkpoint | 只读 interrupted；不可续 |
| 完成态归档 + checkpoint | 仍走 **fork**（新 runId）；`sameRunResume:false` |

Idempotency 边界（无 SAFE-06 toolTx）：**checkpoint 段号**——只从最后完整 main `done` 之后续跑，不声称 mid-tool 安全。

### Phase 划分

| Phase | 范围 | 验收 |
|---|---|---|
| **1（已落地）** | 写 `state.json` 与 phase 迁移；崩溃档案带 phase；计划 DAG 快照进 state；与 meta/checkpoint 一致；单测 + 变异（丢 phase 变红） | docs/08 RUN-01 → `[~]` |
| **2（已落地）** | 同 run 热恢复执行游标（idempotency = checkpoint）；预算/grantAudit 进 state；UI/API `sameRunResume` 诚实；变异 `same-run-resume-allows-executing` | docs/08 RUN-01 仍 `[~]`（toolTx/CLI 残余） |
| **3（已落地）** | 崩溃注入套件（RUN-02）：`test/run-crash-inject.test.ts` 覆盖 model / approval wait / history write / same-run / fork；**不**伪造 tool prepared/committed | docs/08 RUN-02 → `[~]`；SAFE-06 仍开 |

### 与现有件的关系

- **events.jsonl** 仍是 UI 重放事实源；state.json 是 **编排游标**，不是第二套事件流。
- **OBS-01 trace** 旁路观测；不参与恢复决策。
- **SAFE-04**：Phase 1–2 只持久化 grant **审计**；激活仍禁跨重启。

## Options Considered

### A. 只靠 events.jsonl 回放推导状态

复杂度低，但“计划门中途 / 多子任务并发”推导昂贵且易与 live Map 漂移。否决为唯一方案；可作校验器。

### B. 外置 DB / 队列

过早；单操作员无多实例需要。保留为多人生产前置。

### C. 本 ADR（state.json + 分阶段）

与 B2 同构、可测、不扩大密钥面。采纳。

## Consequences

- 正向：RUN-01 有可验收的 Phase 1–2 边界；接手不必重推演“同 run 热恢复 vs 派生”。
- 负向：无 toolTx 时 mid-segment 崩溃仍会丢该段未落盘工具副作用——界面必须继续诚实（interrupted / run_resumed 边界文案）。
- 风险：state 与 events 短暂不一致——写序必须 **先 append 相关事件，再写 state**（或同链 enqueue）。

## Phase 1–2 非目标（写进残余）

- SAFE-06 tool transaction（prepared/committed）
- GOV-01 主体绑定的跨重启 grant
- CLI 对等 durable state（Web 先行；CLI 可随后镜像）
- MEM-01 语义压缩（独立项）

## Implementation notes

1. ~~`src/run-state.ts`：类型 + `transition` + `canSameRunResume`~~
2. ~~`ui/history.ts`：`writeState` / `readState` / Phase 2 字段解析~~
3. ~~`ui/server.ts`：迁移接线、崩溃收口、same-run followUp、预算/grant 快照~~
4. ~~UI：`continuationMode:"same-run"` + `run_resumed` reducer/装配条~~
5. docs/08 RUN-01 保持 `[~]`；残余写清 toolTx / CLI。
6. ~~RUN-02 崩溃注入套件~~（`test/run-crash-inject.test.ts`）；docs/08 RUN-02 → `[~]`，SAFE-06 残余照实写。

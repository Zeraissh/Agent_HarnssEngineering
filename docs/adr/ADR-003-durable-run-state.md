# ADR-003: Durable RunState（分阶段）

**Status:** Proposed（Phase 1 内核 + Web state.json 接线已落地；Phase 2 热恢复未开，不得标 Accepted）  
**Date:** 2026-09-02  
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
plan?: { protocol, tasks[], approvedAt?, rejectedAt? }   # DAG 快照
segment: { index, source, startedAt }
verification?: { round, recovery?, lastVerdictHash? }
budget: SharedRunBudget 快照
approvals: { pendingIds[], grantAudit[] }   # 只审计，不恢复 active grant（Phase 1）
toolTx?: never                              # Phase 1 禁止；等 SAFE-06
```

**恢复语义（Phase 1）**：

| 崩溃时 phase | 重启后行为 |
|---|---|
| `created` / `planning` / `plan_gated`（未批准） | 标 `closed` + 合成 `run_end`；不可续，可派生 |
| `awaiting_approval` / `awaiting_question` | 全部 pending → expired 事件；**不**自动应答；可派生 |
| `executing` / `verifying` / `reworking` | 标 `interrupted`；用 checkpoint + transcript **派生新 run**（沿用 B2），state 记录 lineage |
| `completed` / `failed` / `closed` | 只读 |

Phase 1 **明确不做**：同 runId 热恢复、跨重启复用 active grant、tool compensation。

### Phase 划分

| Phase | 范围 | 验收 |
|---|---|---|
| **1（本 ADR 授权实现）** | 写 `state.json` 与 phase 迁移；崩溃档案带 phase；计划 DAG 快照进 state；与 meta/checkpoint 一致；单测 + 变异（丢 phase 变红） | docs/08 RUN-01 → `[~]` |
| **2** | 同 run 热恢复执行游标（需 toolTx 或至少 idempotency key） | 依赖 SAFE-06 或等价 |
| **3** | 崩溃注入套件（RUN-02） | model/tool/approval/history 各点 |

### 与现有件的关系

- **events.jsonl** 仍是 UI 重放事实源；state.json 是 **编排游标**，不是第二套事件流。
- **OBS-01 trace** 旁路观测；不参与恢复决策。
- **SAFE-04**：Phase 1 只持久化 grant **审计**；激活仍禁跨重启。

## Options Considered

### A. 只靠 events.jsonl 回放推导状态

复杂度低，但“计划门中途 / 多子任务并发”推导昂贵且易与 live Map 漂移。否决为唯一方案；可作校验器。

### B. 外置 DB / 队列

过早；单操作员无多实例需要。保留为多人生产前置。

### C. 本 ADR（state.json + 分阶段）

与 B2 同构、可测、不扩大密钥面。采纳。

## Consequences

- 正向：RUN-01 有可验收的 Phase 1 边界；接手不必重推演“同 run 热恢复 vs 派生”。
- 负向：用户仍会看见“中断后开新 run”，不是无缝续聊——界面必须继续诚实（archived / interrupted）。
- 风险：state 与 events 短暂不一致——写序必须 **先 append 关键事件，再写 state**（或同链 enqueue）。

## Phase 1 非目标（写进残余）

- SAFE-06 tool transaction
- GOV-01 主体绑定的跨重启 grant
- CLI 对等 durable state（可随后镜像 Web）
- MEM-01 语义压缩

## Implementation notes（Phase 1 开工清单）

1. ~~`src/run-state.ts`：类型 + `transition(phase, event) → next` 纯函数 + 单测。~~
2. ~~`ui/history.ts`：`writeState` / `readState`（坏文件跳过，同 meta）。~~
3. ~~`ui/server.ts`：在 plan/execute/verify/approval/finalize 点调用 transition；崩溃 hydrate 读 phase。~~
4. docs/08 RUN-01 → `[~]` 并记残余；不得在 Phase 2 未做时标 `[x]`。

**Phase 1 已接线残余**：CLI 对等 durable state；同 run 热恢复（Phase 2）；toolTx（SAFE-06）；预算快照进 state；grant 审计数组进 state（当前只 pendingIds）。

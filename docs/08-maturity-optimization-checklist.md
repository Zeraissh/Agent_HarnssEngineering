# 成熟 Agent 优化清单

> 目标：把当前“可靠的单操作员 Agent 执行内核”逐步提升为可安全部署、可持续评测、
> 可恢复、可观测、可扩展的成熟 Agent 平台。
>
> 本清单是实施台账，不是愿望列表。只有满足对应验收证据后才能勾选；源码/单测、
> 真实 provider、安装包、容器、Android、多人生产和 HIL 证据必须分开记录。

## 状态与排序

- `[x]`：验收证据已取得。
- `[~]`：已部分实施但尚未通过全部验收；可因前置依赖暂缓，残余边界必须写明。
- `[ ]`：尚未实施。
- `P0`：阻断安全使用或可靠交付；`P1`：成熟产品关键能力；`P2`：规模化与体验优化。
- 评分：`优先分 = (Impact + Risk) × (6 - Effort)`，三项均为 1–5。
  安全/合规 Gate 即使实施成本高，也不能被纯分数降级。

## 已验证基线

- [x] **BASE-01 核心回归基线**：2026-09-01，`npm test` 为 31 个文件通过、
  1 个真实 OCI 文件跳过；1173 passed、13 skipped，`npm run typecheck` 通过。
- [x] **BASE-02 跨端契约基线**：2026-09-01，`cross-app` 为 31 passed、1 skipped。
- [x] **BASE-03 CI 构建基线**：当前 `main` 的 core、desktop-shell、container job 成功。
- [ ] **BASE-04 真实运行基线**：真实模型、浏览器 E2E、已安装 Electron、Android、
  容器启动 canary 与 STM32 HIL 尚未同时验收，不能由上述绿测替代。

## Phase 0：立即安全收口

| 状态 | ID | 优化项 | I/R/E | 优先分 | 完成定义 |
|---|---|---|---:|---:|---|
| [x] | SAFE-01 | MCP 逐工具权限 | 5/5/2 | 40 | server 默认权限保持向后兼容；支持逐工具覆盖；CLI/Web 使用同一解析；reset/flash/write_memory 等始终进入审批；测试覆盖 |
| [x] | SAFE-02 | 文件路径真实边界 | 5/5/3 | 30 | 拒绝通过 symlink/junction/reparse point 逃逸；不存在写目标校验最近存在父目录；合法工作区与只读根不回归；跨平台测试覆盖 |
| [x] | SAFE-03 | `fetch_url` SSRF/重定向防护 | 5/5/3 | 30 | 仅 HTTPS；拒绝本机/私网/link-local/保留地址；每次重定向重新验证；限制跳转；测试覆盖 DNS 与重定向路径 |
| [~] | SAFE-04 | 参数级审批授权 | 5/5/4 | 20 | approval grant 绑定 run、tool、规范化 input hash、scope 与 expiry；不同 bash/path/device 参数不能复用旧授权；审批可恢复、可审计 |
| [~] | SAFE-05 | OS/容器执行隔离 | 5/5/5 | 10 Gate | 每 run 独立 worktree、UID、文件系统和网络策略；资源/CPU/内存上限；硬件操作经受控 gateway；逃逸测试通过 |
| [ ] | SAFE-06 | 工具副作用事务层 | 5/5/5 | 10 Gate | side-effect 工具具有 idempotency key、prepared/running/committed 事件、重试策略及必要的 compensation；崩溃注入不重复写入 |

### Phase 0 验收命令

```powershell
npm run typecheck
npm test
npm run build
npm run pack:check
```

安全测试还必须包含负例：symlink/junction 逃逸、DNS 指向私网、重定向到私网、
不同参数复用审批，以及 flash/write/reset 未确认执行。测试无法创建 Windows junction
或没有真实硬件时，必须明确记为未验证，不能静默跳过后宣称完整通过。

### Phase 0 实施记录（2026-08-27）

| ID | 已取得证据 | 残余边界 |
|---|---|---|
| SAFE-01 | `McpServerConfig`/DomainPack 支持 `toolPermissions`；CLI/Web/计划子任务统一解析；pack 泛化 `auto` 不能盖掉 server 单工具 `ask`；破坏性 STM32 工具审批执行测试通过 | 未做真实 STM32 HIL；当前仍是工具名级策略，未来若开放 compact `call/batch` 必须先做参数级转发策略 |
| SAFE-02 | Windows junction/POSIX symlink 语义测试覆盖圈外读写、尚不存在深层路径、合法内部链接和 readRoots；写入前二次校验；本机测试未跳过 | Node 文件 API 没有跨平台 `openat` 式原子圈禁，检查到 I/O 仍有极窄 TOCTOU；由 SAFE-05 完全封闭 |
| SAFE-03 | 12 个网络边界测试覆盖怪异 IP 字面量、DNS 私网/混合结果、HTTP/凭据/私网重定向、重定向上限、DNS cancel、响应断流和大小限制；固定公网 IP + 域名 SNI 的真实 HTTPS canary 成功 | 本机 TUN 把普通域名映射到 198.18/15 synthetic IP，按策略 fail closed；需要后续受控 egress/proxy，不能自动放宽私网范围 |
| SAFE-04 | 阶段 1：canonical JSON SHA-256 防止不同 command/path/device 复用。阶段 2：grant 绑定 run、工具契约元数据 fingerprint、绝对 TTL 与最大自动次数；默认 ask 工具仅单次，`bash` / `write_file` / `describe_image` / ask 型 MCP 均不能扩权，当前只有 `fetch_url` 显式开放受限 exact-input；planner/verifier 自答 deny 不进入宿主授权表；并发双 POST 原子决策、同参 pending 复用 grant、陈旧项创建前清扫；不可续跑 run 收尾即终止 active grant；完整 checkpoint 保存版本化审计快照，重启/归档 child 明确不继承；manual/auto 及触发检查后的 expired/exhausted/invalidated/not-inherited 事件与 UI 状态均可审计 | active grant 仍是进程内状态；在 RUN-01 能恢复同一 run 且 GOV-01 有稳定主体前，不允许跨重启恢复 capability。fingerprint 不含 execute/build 实现，授权主体也尚不能绑定文件内容/设备状态等可变资源身份，因此此类工具必须保持 once。当前为单操作员/单租户边界，checkpoint 审计快照未做签名防篡改；因此 SAFE-04 保持 `[~]` |
| SAFE-05 | ADR-001 固定 `off/report/required` 与 `auto/oci/bwrap` 语义；`ExecutionBroker` 沿 `AgentConfig → AgentLoop → ToolExecutor → ToolContext` 逐 run/segment 传播，Web/CLI 均绑定 boundaryId/workdir，已完成 segment 的 broker 立即释放，follow-up 保留上下文/累计预算但换用新 broker；初始无 bash 的 plan 动态切到含 bash 子任务也不会绕过。`required` 对 `/ready`、新 run、续跑、每个 segment 和每次命令强制刷新，per-run canary 前后双闸门重验全局 cleanup，失败时 durable `run_config` 先报告 `failed`、broker/canary/模型均零启动、绝不 host fallback；required+host MCP 在任何 probe 前拒绝。内嵌 OCI 只接受 Linux 直宿主上 root 管理的绝对 Docker CLI+SHA-256 和本机 Unix socket；digest/image-ID 镜像不 pull，拒绝 VOLUME，覆盖 ENTRYPOINT/health；固定 bootstrap 将 stdin 全量写入 0600 私有 tmpfs 脚本，再以 fd0=EOF 执行，命令不进 argv/`Config.Cmd`，且 `env -i`；固定 network/IPC none、只读 root、禁递归子 mount、numeric UID/GID 无补充组、cap-drop/NNP/seccomp 与 PID/CPU/内存/swap/FD/tmpfs/wall/output 限制；functional 与实际 workdir 双层 canary 核对 UID/rootfs/安全状态/cgroup/网络和 read-write-rename-delete，并拒绝 symlink 路径、nested mount、IPC/device/hardlink。ADR-002 进一步用 daemon-resident schema-3 namespace/owner/boot/PID-namespace/PID/starttime/lease/kind/boundary/policy/lease-ms labels 固化 ownership；每次 probe 在 canary 前按 namespace 两阶段扫描，完整校验后只按 full ID 回收“已到期且 owner 明确死亡”的 worker，正常 cleanup 也先核对 lease 以阻断名称复用，且只有 daemon 明确回执不存在才算 confirmed。PID namespace 不同或 `/proc`/signal-0 无法确认时 fail closed、不删除。未确认会撤销全部 coverage 并锁住全局 readiness/admission。CLI、API、durable `run_config`、Tools 卡与 tool result 区分 `direct/report-only/partial/failed`；公共 `/ready` 不泄露绝对路径。Linux CI container job 跑 13 个真实 OCI 逃逸/并发/abort/dispose/resource/stdin/reaper canary（worker=`debian:bookworm-slim`，`agent-harness:ci` 仅 build smoke）；**2026-09-01 CI @ 33461119575 全绿** | **2026-09-01 评审：保持 `[~]`**。Linux CI 绿测满足「逃逸 canary 在 CI 通过」这一条，但完成定义还要求每 run 独立 worktree/UID、MCP managed worker、全平台隔离与 autonomous TTL reaper——均未完成；本机 Windows OCI 仍 skipped。CI 回执记入证据列，不单独把 Linux 子项升为 `[x]` |

### 本轮完整回归

```text
npm run typecheck                       passed
npm test                                31 files passed, 1 skipped; 1173 passed, 13 skipped
npm run pack:check                      （本轮未重跑 pack:check）
cross-app npm test                      （本轮未重跑 cross-app）
npm audit --audit-level=moderate        0 vulnerabilities（install 后 root）
```

未执行真实模型、Electron 安装包、Android emulator 或 STM32 HIL；
OCI 逃逸 canary 由 Linux CI container job 承担（run #33461119575 全绿）。
§2.1 台账样本：`npm run ledger:samples`（需 API 凭据）向 `.agent-runs.jsonl` 攒 ≥20 次实施后裁决。

## Phase 1：把质量变成发布决策

| 状态 | ID | 优化项 | I/R/E | 优先分 | 完成定义 |
|---|---|---|---:|---:|---|
| [~] | EVAL-01 | Held-out 真实任务集 | 5/5/4 | 20 | 建立 20–50 个不参与提示/实现调优的任务，覆盖编辑、调试、澄清、权限、恢复、MCP、多文件与失败场景。**仪器已落地（2026-09-02）**：`eval/cases-heldout.ts` 24 条 `ho-*`；`AB_SUITE=heldout|research|all`；nightly/release 六件套切到 held-out；与 research `cases.ts` id 互斥。**仍开**：全量 24 条真实 provider 基线矩阵、活 MCP HIL 面、调试类真机任务 |
| [x] | EVAL-02 | 统计与失败分类 | 5/4/3 | 27 | 每模型/配置至少重复 3–5 次；输出 pass@1、首轮成功率、修复率、置信区间、token、成本、延迟和稳定失败 taxonomy |
| [x] | EVAL-03 | CI/nightly/release 门 | 5/5/4 | 20 | PR 跑确定性小集；nightly 跑真实 provider 矩阵；release 对质量/成本/延迟设置退化阈值并保存报告。**PR 侧**：确定性小集 12 场景（`deterministic-eval` + release `gate`）。**Nightly 侧（EVAL-03b）**：`.github/workflows/nightly.yml` + `eval/baselines/nightly.json`。**Release 侧（EVAL-03c，2026-09-02）**：tag 门在候选提交上重跑同子集，对照 `eval/baselines/release.json`，上传 `release-quality-eval`。阈值经 nightly #33646201722（6/6、52k tok、28s）收紧为 `minPassRate=1` / `maxTotalTokens=150k` / `maxTotalWallMs=300s`。**子集已切 held-out（EVAL-01）** |
| [~] | TEST-01 | Coverage 与 mutation | 4/4/3 | 24 | changed-line coverage、关键状态机 branch 阈值及 mutation score 纳入 CI；证明关键验收测试会在实现被破坏时变红 |
| [ ] | E2E-01 | Web/桌面/容器真实 E2E | 5/5/4 | 20 | Playwright Web、已打包 Electron 启动/升级/卸载、容器 health+canary 自动化；覆盖流式断线、审批和崩溃恢复 |
| [ ] | E2E-02 | Android 与 provider canary | 4/4/4 | 16 | 修正 Android instrumentation 身份并在 emulator 运行；每次 release 用少量真实 provider 请求验证协议与凭据边界 |

### Phase 1 实施记录（进行中）

| ID | 已取得证据 | 残余边界 |
|---|---|---|
| TEST-01a | 装 `@vitest/coverage-v8`；`vitest.config.ts` include `src/**`+`ui/*.ts`，reporters text-summary/lcov/json-summary。2026-09-02 本机基线 statements/lines **77.68%**、branches **81.2%**、functions **91.54%**；棘轮阈值 lines/statements **75**、branches **78**、functions **88**（实测下方约 2–3pt）。`scripts/mutation-smoke.mjs` 固定 8 个关键变异（瞬时判定恒假/恒真、审批门绕过、tool_choice none 映射丢、verdict fail-open、verifier 只读放行、台账空成功、credentialLike 恒假），每个必须把对应测试文件打红。CI `core` 改跑 `test:coverage` + `test:mutation-smoke` 并上传 `coverage/` artifact | 尚非 changed-line coverage、无 Stryker 全量 mutation score；OCI 用例在 Windows 本机 skipped，Linux CI 才计入分支覆盖。第二波再扩变异清单与差分覆盖 |
| EVAL-02 前置 | 修台账 `error` 硬编码 null：`ledgerErrorClass`（classifyApiError 首行）+ Web/CLI 全路径写入；`buildLedgerEntry` 对 `stopReason=error` 漏传 fail-closed 为 `unclassified_error`。锁：源码不再 `error: null`、哨兵变异验证 | 历史台账里已写入的 null 不回改 |
| EVAL-02 | `eval/stats.ts` + `npm run eval:stats`：读 ab-log + 台账；Wilson 95% / 无偏 pass@k / 首轮与修复率 / p50·p95 / 先写死的 11 值 taxonomy。22 单测钉已知值与映射；本机对 175+ 条 ab-log 跑通产出 `eval/stats-report.{md,json}`（gitignore） | 重复次数是实验纪律不是代码门；held-out 集（EVAL-01）与 nightly 门尚未接此报告 |
| EVAL-03a 仪器 | `eval/mock-provider.ts`：loopback HTTP 双 wire 流式（Anthropic Messages SSE + OpenAI chat.completions SSE）+ 脚本队列 + 故障注入（429/500/cut_stream/timeout/bad_json）。25 单测；变异验证故障注入与 alwaysFault | 已被 `eval/deterministic.ts` 接走；OpenAI wire 侧目前只有单测覆盖，场景门全部走 Anthropic wire |
| EVAL-03a 场景门 | `eval/deterministic.ts` + `npm run eval:deterministic`：**12 个场景全绿**（约 11s，零真实 provider、零凭据）。被测对象是**编译产物** `dist/src/cli.js`（不是 tsx src——CI/容器跑的是 dist，build 配置一漂单测照绿而发布件起不来），端点是 mock。场景覆盖成功闭环 / 工具失败与工作目录圈禁 / finish_task 语义违规纠正 / 完成门强制 incomplete / 核查拒签→返工→通过 / verifier 只读 deny / 核查预算收口续跑（recovery=wrapup）/ 429 同轮重试 / 500×2 段级续跑 / 断流×2 段级续跑 / freeform 两子任务串行编排 / ask_user 一轮（stdin 作答）。断言只用**可数事实**：产物字节、退出码、台账 `stopReason`·`reworks`·`finalPassed`·`verifications[].recovery`、**模型请求条数**（脚本队列一次请求消费一条，多一轮少一轮当场变红）。子进程环境**先剥掉继承来的 `AGENT_*`/`ANTHROPIC_*`/`OPENAI_*`** 再装配（仪器纪律：残留变量三次把测试指向真端点）。变异验证 3 处逐一打红：`isTransientApiError` 恒假 → 三个瞬时场景全红；completed+blockers 校验去掉 → 纠正场景红；verifier 只读 deny 改 allow → 只读场景红 | 并行编排（fan-out）**没做**：单条脚本队列在并发下消费顺序不确定，会让仪器自己变成噪声源；计划场景一律 `--parallel=1`。要覆盖 fan-out 得先给 mock 加"按请求内容选脚本"的寻址能力（backlog 候选）。审批 **deny** 路径只经 verifier 只读门覆盖；CLI 的人工 deny 无法在 `--yes` 下构造。Web 宿主（`dist/ui/serve.js`）与 OpenAI wire 未进场景门 |
| EVAL-03b nightly | `.github/workflows/nightly.yml`：cron + `workflow_dispatch`；**held-out** 6 用例 × `baseline` × 1（`AB_SUITE=heldout`）；`AB_TOKEN_CAP`；`npm run eval:compare-baseline` 对照 `eval/baselines/nightly.json`。凭据：`ANTHROPIC_API_KEY` + vars。单测 `test/eval-nightly.test.ts`。阈值经 research 首夜 #33646201722 收紧后沿用到 held-out ids | REPS=1 下任一 flaky 即红；held-out 首夜通过率仍待证据 |
| EVAL-03c release | `eval/baselines/release.json`（与 nightly 同矩阵；单测锁「不得更松」）；`release.yml` `gate` 在确定性门之后要求凭据 → 重跑真实子集 → `compare-baseline` → artifact `release-quality-eval`（含 `release-compare.json`）。缺 secret/vars fail-closed | 未在本机重跑真实 provider（依赖 CI/tag）；未做多夜分布再收紧 |
| EVAL-01 held-out | `eval/cases-heldout.ts`：**24** 条 `ho-*`（编辑/多文件/恢复/圈禁逃逸/成文口径/缺 MCP 旁路/条件分支/结构化抽取）；`eval/suite.ts` `resolveAbSuite`；`AB_SUITE` + nightly/release `AB_CASES` 切到 `HELDOUT_NIGHTLY_IDS` 六件套；`test/eval-heldout.test.ts` 锁规模/id 互斥/表面覆盖。纪律：本会话**未**为追分改 prompt/包。research `eval/cases.ts` **不是** held-out | 全量 24 条尚未跑真实 provider 矩阵；无活 MCP/HIL 调试任务；首夜 held-out 通过率仍待证据（成本/延迟天花板沿用 research 6/6） |

## Phase 2：可恢复、可重放、可运营

| 状态 | ID | 优化项 | I/R/E | 优先分 | 完成定义 |
|---|---|---|---:|---:|---|
| [~] | RUN-01 | Durable RunState | 5/5/5 | 10 Gate | 持久化 plan DAG、segment、审批/提问、verifier/rework、预算与 tool transaction；进程重启从明确状态恢复。**Phase 1 接线已落地（2026-09-03）**：`state.json` + Web plan/execute/approval/finalize 迁移；崩溃 hydrate 按 ADR 表收成 closed/interrupted；API `durablePhase`/`sameRunResume:false`。**仍开**：同 run 热恢复（Phase 2）、toolTx（SAFE-06）、CLI 对等、预算/grant 审计进 state |
| [ ] | RUN-02 | 恢复与故障注入 | 5/5/4 | 20 | 在 model call、tool prepared/committed、审批等待和历史写入各点注入崩溃；不丢状态、不重复副作用、可安全 fork |
| [~] | OBS-01 | 端到端 trace | 5/4/4 | 18 | run→segment→model/tool spans；记录 commit、模型、工具/schema/pack 版本与输入输出哈希；支持脱敏导出和离线 playback。**已落地（2026-09-02）**：`src/trace.ts` + `trace.jsonl` 旁路（扩展 history，无 OTel）；Web `GET /api/runs/:id/trace` 脱敏导出 + playback 摘要；事件投影 tool/model/segment。**仍开**：CLI 同等接线、完整 model span 起止（非 done 摘要）、跨进程统一 collector |
| [ ] | OBS-02 | 成本、延迟与 SLO | 4/4/3 | 24 | TTFT、模型/工具延迟、排队/审批等待、重试/错误、USD 成本和 provider/model/pack 归因；持久预算账与 p50/p95/p99 仪表盘 |
| [ ] | OPS-01 | 备份、恢复与升级演练 | 5/4/4 | 18 | 定义并验证 RPO/RTO；完成异地加密备份恢复、版本迁移、回滚及在途任务升级演练 |

### Phase 2 实施记录（进行中）

| ID | 已取得证据 | 残余边界 |
|---|---|---|
| OBS-01 | `src/trace.ts`：span 模型 + redact/hash + TurnEvent 投影 + JSONL playback；`RunHistoryWriter.appendTraceSpan` → `trace.jsonl`；Web 建 run 写根 span（harness/git/model/pack/toolSchemaHash），`pushEvent` 投影 tool/model/segment，收尾关根 span；`GET /api/runs/:id/trace` 返回脱敏导出 + playback 摘要。`test/trace.test.ts` 7 测。未引入 OTel | CLI 未接线；model span 仍是 done/api_retry/fallback 摘要而非逐 send 起止；无跨进程 collector；UI 未渲染 trace 面 |
| RUN-01 Phase 1 | ADR-003 + `src/run-state.ts`；`ui/history.ts` `writeState`/`readArchivedState`；`ui/server.ts` 迁移接线与崩溃收口；`test/run-state*.ts` + ui-server 两条；API 诚实字段 | **未**同 run 热恢复；**未** CLI 对等；**未** toolTx；预算/grantAudit 未进 state 快照；UI 未渲染 durable 面 |

## Phase 3：动态协作与扩展平台

| 状态 | ID | 优化项 | I/R/E | 优先分 | 完成定义 |
|---|---|---|---:|---:|---|
| [ ] | AGENT-01 | 一等 `PlanState` 与重规划 | 4/3/4 | 14 | 节点有目标、证据、验收、状态和失败策略；仅在新证据/依赖变化时可审计地更新计划 |
| [ ] | AGENT-02 | 动态多 Agent | 5/4/5 | 9 | supervisor/mailbox 支持 spawn、follow-up、cancel、重新分派和分支失败策略；handoff 使用结构化证据引用 |
| [ ] | AGENT-03 | 每 Agent 隔离与路由 | 5/4/5 | 9 | 每 agent 独立 worktree/sandbox、工具、模型和预算；并发写不会污染共享 checkout |
| [~] | MODEL-01 | Provider 能力注册与降级 | 4/4/4 | 16 | 以 endpoint+model capability probe 代替名称猜测；支持健康检查、熔断、fallback、成本/延迟路由与每角色绑定。**MODEL-01a（降级+熔断）已落地并接进两个宿主**（见 Phase 3 实施记录）；**仍开**：capability probe（compat 仍靠 `claude-*` 名称猜测）、成本/延迟路由、每角色绑定（链只覆盖主执行者） |
| [ ] | EXT-01 | 插件/Pack manifest 与 SDK | 4/3/4 | 14 | 版本化 manifest、权限声明、依赖、签名/来源、启停与兼容检查；DomainPack 不再只能硬编码发布 |
| [ ] | EXT-02 | 完整 MCP 与公开协议 | 4/3/4 | 14 | 远程 transport、OAuth、resources/prompts/elicitation、lazy tool discovery；公开版本化 schema/SDK/webhook |

### Phase 3 实施记录（2026-09-02，MODEL-01a）

| ID | 已取得证据 | 残余边界 |
|---|---|---|
| MODEL-01a 内核 | `src/model-fallback.ts`：`FallbackModelClient`（L0 装饰器，上面几层只见 `ModelClient` 接口）+ 逐端点 `CircuitBreaker`（连败开路、冷却后半开、一次成功即闭合）+ `readFallbackEnv`/`createFallbackClientIfConfigured`（未配 `AGENT_FALLBACK_MODELS` 时**原样返回主客户端**，不加一层空壳）。**负向路径才是主场**：认证失败/400 一律原样上抛不降级（换端点救不了配置错误，只会把同一个 401 打到第二家去并掩盖真因）；跨端点重发**剥掉 thinking 块**（签名属于上一家）；全链熔断时报错而不是静默返回空。`test/model-fallback.test.ts` **22 测试** | 只按"瞬时错误"降级，**没有** capability probe、成本/延迟路由；链上端点的能力差异（工具调用格式、图像支持）不做校验——换过去的那家不支持识图就会当场失败 |
| MODEL-01a 事件契约 | `src/types.ts` 新增 TurnEvent `model_fallback {from,to,reason,turn}`。它是**唯一一条不由 `AgentLoop` 发射的 TurnEvent**——换端点发生在 L0 内部，循环按设计不知道。放进 `TurnEvent` 而不是让两个宿主各定义一个形状，是为了 CLI 与 Web 渲染同一件事。`reason` 是**离开上一个端点的原因**（HTTP 状态+消息，或 `circuit_open` 表示它仍在隔离期被跳过）；`turn` 是该客户端的第几次 `send`，与 loop 轮次不是同一个计数器 | 不是 stopReason，`STOP_REASONS` 未动 |
| MODEL-01a 宿主接线 | **两个宿主同一处改**（host-lags 纪律）。CLI：装配处 `createFallbackClientIfConfigured` + `onFallback` 走**同一个** `renderEvent`（⇄，与 ⟳ 同轮重试 / ⟲ 段级续跑区分开——那两个换的是时机，这个换的是端点），启动横幅打链。Web：`ui/server.ts` 用 **`AsyncLocalStorage`** 把 `onFallback` 定位到发起 `send` 的那个 run——宿主允许多 run 并发在飞，单个可变"当前 run"引用会在两次 send 交错时把降级记到别人账上（**变异验证**：换成可变全局后并发用例当场变红）。链只包**主执行者**，verifier/planner/vision 三个角色模型不进链（"核查者应 ≥ 执行者"是设计约束，静默换端点会让它在无人知晓时失效）；`run_config` 与 `/api/harness` 同时报 `fallbackChain` 与 `fallbackScope="executor"`，只报名字不下发 baseURL/key。测试用**真的本地 HTTP**（mock provider）走完整条路：主端点 503 → 备用端点真的应答 → SSE 里出现 `model_fallback` | 归属域只包住"宿主发起的那段执行"；若将来有绕过这一层直接调 `modelClient` 的路径，降级会落在无域状态被丢弃 |
| MODEL-01a 界面 | `ui/public/app.js` 三处一起改（投影分支 / 派生 / 渲染，逐字段白名单投影天生会静默吞掉没列出的字段）：时间线条目默认**不折叠**并按 warn 着色；`deriveLoopFace` 把 `fallbacks` 与 `retries` **分开计数**（压成一个数就再也答不出"是同一家重试还是换了一家"）；装配条只在配了链时上一格，写明覆盖范围只到执行者。`circuit_open` 经 `fallbackReasonText` 译成人话（原样显示会让人以为上游返回了一个叫 `circuit_open` 的错误码，从而查错方向）。**渲染锁** `test/ui-patch.test.ts` + **投影/派生锁** `test/ui-app.test.ts` | 未做链的"当前健康状态"实时面（熔断器状态只在降级发生时以 reason 间接可见） |
| MODEL-01a 台账 | `src/ledger.ts` 新增 `fallbackChain: string[] \| null` 与 `fallbacks: number`。**null 与 `[主端点]` 必须分开**：前者是"这台机器上没有这条防线"，后者是"配了链但只有一环"——压成同一个读数，事后就无从判断"零次降级"是防线没触发还是防线不存在。空数组按未配处理、脏输入不留 `NaN`（台账每行形状必须一致） | 没做 `modelsUsed`（"这一轮实际是谁应答的"要逐 send 归属，属 OBS-01 的 span 范畴，不塞进 run 级台账） |
| 顺带修出的真缺陷 | `ui/server.ts` 的 `meterModelClient` 装饰器**吞掉了 `onDelta` 与 `signal`**：Web 上等于没有流式（直播条与对话末尾实时段全空），且停止按钮掐不掉在飞的请求。装饰器最常见的错就是收窄被装饰者的契约。已修并加锁 | — |

### Phase 3 回归证据（2026-09-02）

```text
npx vitest run test/model-fallback.test.ts test/ledger.test.ts \
                test/ui-app.test.ts test/ui-patch.test.ts     444 passed
npx vitest run（全量）                     1262 passed, 13 skipped, 12 failed
npx tsc --noEmit                            passed
```

全量里的 12 条失败全部落在 `test/cloud-sync-env.test.ts`，本机 Windows 下
`execFileSync("bash", ...)` 把 Windows 路径的反斜杠吃掉（`C:Usersrk302...`），
与本次改动无关且在改动前即如此；Linux CI 不复现。未跑真实 provider、
`npm run build`、`pack:check` 与 `cross-app`。

## Phase 4：团队与商业化（按部署目标启用）

| 状态 | ID | 优化项 | I/R/E | 优先分 | 完成定义 |
|---|---|---|---:|---:|---|
| [ ] | GOV-01 | 身份与 RBAC | 5/5/5 | 10 Gate | OIDC/SAML 或受控本地身份；viewer/operator/approver/admin/service-account；逐路由服务端授权 |
| [ ] | GOV-02 | 多租户数据隔离 | 5/5/5 | 10 Gate | run/history/artifact/model key/quota 都有不可缺省 tenant+owner；跨租户负向测试与删除/导出流程通过 |
| [ ] | GOV-03 | Secret 与不可抵赖审计 | 5/5/5 | 10 Gate | KMS/Keychain/DPAPI/Keystore；日志 DLP；带真实主体的 append-only 审计和保留策略 |
| [ ] | REL-01 | 正式发布与供应链 | 4/5/4 | 18 | 发布与源码版本一致的签名资产；安装/升级/回滚实测；SBOM、provenance、镜像签名/扫描和依赖锁定 |
| [ ] | REL-02 | 版本与数据迁移治理 | 4/4/3 | 24 | CHANGELOG、兼容矩阵、deprecation policy、历史 schema migration/rollback 测试及版本同步 CI |

## Phase 5：上下文与长期记忆

| 状态 | ID | 优化项 | I/R/E | 优先分 | 完成定义 |
|---|---|---|---:|---:|---|
| [~] | MEM-01 | 语义化上下文压缩 | 5/4/4 | 18 | 保留用户约束、决策、失败尝试、证据引用和 side-effect ledger，不再只用占位符替换旧工具输出。**Phase A 已落地（2026-09-03）**：非 LLM 结构化 `[compact_ledger]` + 语义占位；见 Phase 5 实施记录 |
| [ ] | MEM-02 | 分层、可治理记忆 | 4/4/5 | 8 | 原始事件→滚动摘要→artifact/reference store；按用户/项目/任务检索；记录来源、时间、置信度、冲突和删除范围 |
| [ ] | MEM-03 | 跨宿主一致性 | 4/3/4 | 14 | CLI/Web/Electron 使用同一 memory contract；同步、权限、加密、删除和数据归属有端到端测试 |

### Phase 5 实施记录（2026-09-03，MEM-01 Phase A）

| ID | 已取得证据 | 残余边界 |
|---|---|---|
| MEM-01 | `src/compact-ledger.ts` 启发式抽取五桶（constraints/decisions/failures/evidence/sideEffects）；`DefaultContextManager.compact` 在 elision 前扫描保护窗外消息，写入/原地更新 `[compact_ledger]`，tool_result 改为语义占位（仍以 `[compacted]` 开头保幂等）；`compaction` 事件带 `ledgerEntries`；CLI + Web reducer/面文案同提交接线；`test/compact*.ts` + UI 锁；mutation-smoke `compact-ledger-skipped` | **非** LLM 摘要（Phase B 未做）；启发式会漏非模板表述的约束/决策；只压缩大 tool_result，不压缩 assistant 长推理；side-effect 桶覆盖内置写类 + 变异 bash 模式，MCP 写工具靠名字启发；原文仍不可恢复 |

## 每项实施模板

每次只把一个 ID 从 `[ ]` 改为 `[~]`；完成后记录：

1. **问题与边界**：具体风险、受影响入口、不在本次范围内的内容。
2. **设计不变量**：必须永远成立的安全或行为约束。
3. **实施文件**：源码、测试、文档和迁移。
4. **负向测试**：故意触发危险/失败路径，不能只测成功路径。
5. **回归证据**：针对性测试、完整测试、typecheck/build/pack，以及需要的真实 E2E/HIL。
6. **残余风险**：未覆盖平台、TOCTOU、外部系统或人工验收项。

当前执行顺序（2026-09-03 成熟度第二波，单操作员形态）：
`EVAL-03c → EVAL-01 held-out → OBS-01[~] → RUN-01[~] → MEM-01[~ Phase A]`。
下一刀候选：`MODEL-01b`（capability probe / 每角色 fallback）或 `MEM-01 Phase B`（可选 LLM 摘要，仅当启发式不够）或 `RUN-01 Phase 2`。
本波**不提前** GOV-*；SAFE-05 Phase 2B / SAFE-06 保持 partial，除非发现已解锁且很小。
并行可继续：`A1 攒 §2.1 样本（ledger:samples）`（与质量门不冲突）。
若目标改公网多人，`GOV-01/02/03` 必须提前到 `RUN-01` 之后、任何公开上线之前。
Phase 2A 的 daemon-label orphan reaper 与真实 `SIGKILL → sweep` E2E 已落地；
**2026-09-01 Linux CI #33461119575 全绿**，SAFE-05 评审结论为保持 `[~]`（见 Phase 0 实施记录）。

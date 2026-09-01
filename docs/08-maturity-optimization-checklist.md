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

- [x] **BASE-01 核心回归基线**：2026-09-01，本轮优化后 `npm test` 为 31 个文件通过、
  1 个真实 OCI 文件跳过；1172 passed、13 skipped，`npm run typecheck` 通过。
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
| SAFE-05 | ADR-001 固定 `off/report/required` 与 `auto/oci/bwrap` 语义；`ExecutionBroker` 沿 `AgentConfig → AgentLoop → ToolExecutor → ToolContext` 逐 run/segment 传播，Web/CLI 均绑定 boundaryId/workdir，已完成 segment 的 broker 立即释放，follow-up 保留上下文/累计预算但换用新 broker；初始无 bash 的 plan 动态切到含 bash 子任务也不会绕过。`required` 对 `/ready`、新 run、续跑、每个 segment 和每次命令强制刷新，per-run canary 前后双闸门重验全局 cleanup，失败时 durable `run_config` 先报告 `failed`、broker/canary/模型均零启动、绝不 host fallback；required+host MCP 在任何 probe 前拒绝。内嵌 OCI 只接受 Linux 直宿主上 root 管理的绝对 Docker CLI+SHA-256 和本机 Unix socket；digest/image-ID 镜像不 pull，拒绝 VOLUME，覆盖 ENTRYPOINT/health；固定 bootstrap 将 stdin 全量写入 0600 私有 tmpfs 脚本，再以 fd0=EOF 执行，命令不进 argv/`Config.Cmd`，且 `env -i`；固定 network/IPC none、只读 root、禁递归子 mount、numeric UID/GID 无补充组、cap-drop/NNP/seccomp 与 PID/CPU/内存/swap/FD/tmpfs/wall/output 限制；functional 与实际 workdir 双层 canary 核对 UID/rootfs/安全状态/cgroup/网络和 read-write-rename-delete，并拒绝 symlink 路径、nested mount、IPC/device/hardlink。ADR-002 进一步用 daemon-resident schema-3 namespace/owner/boot/PID-namespace/PID/starttime/lease/kind/boundary/policy/lease-ms labels 固化 ownership；每次 probe 在 canary 前按 namespace 两阶段扫描，完整校验后只按 full ID 回收“已到期且 owner 明确死亡”的 worker，正常 cleanup 也先核对 lease 以阻断名称复用，且只有 daemon 明确回执不存在才算 confirmed。PID namespace 不同或 `/proc`/signal-0 无法确认时 fail closed、不删除。未确认会撤销全部 coverage 并锁住全局 readiness/admission。CLI、API、durable `run_config`、Tools 卡与 tool result 区分 `direct/report-only/partial/failed`；公共 `/ready` 不泄露绝对路径。Linux CI container job 跑 13 个真实 OCI 逃逸/并发/abort/dispose/resource/stdin/reaper canary（worker=`debian:bookworm-slim`，`agent-harness:ci` 仅 build smoke）；**2026-09-01 CI @ 33461119575 全绿** | 本机 Windows 仍 skipped；durable reaper 无独立 timer、专属 worktree/UID 未完成、MCP 尚无 managed worker、Windows/macOS/WSL 隔离未完成。因此 Linux 侧 `[~]`→待评审是否升为 `[x]`，全局仍 `partial` |

### 本轮完整回归

```text
npm run typecheck                       passed
npm test                                30 files passed, 1 skipped; 1154 passed, 7 skipped
npm run pack:check                      80 files, 1,537,655 bytes
cross-app npm test                      31 passed, 1 skipped
cross-app npm run build                 passed
cross-app npm run host:stage            passed
npm audit --audit-level=moderate        0 vulnerabilities（root + cross-app）
git diff --check                        passed
```

未执行真实模型、Electron 安装包、Android emulator、真实 OCI 容器 canary 或 STM32 HIL；
7 个 OCI 用例因本机 Windows 无可信 Linux fixture 明确 skipped，等待 CI Linux 回执。

## Phase 1：把质量变成发布决策

| 状态 | ID | 优化项 | I/R/E | 优先分 | 完成定义 |
|---|---|---|---:|---:|---|
| [ ] | EVAL-01 | Held-out 真实任务集 | 5/5/4 | 20 | 建立 20–50 个不参与提示/实现调优的任务，覆盖编辑、调试、澄清、权限、恢复、MCP、多文件与失败场景 |
| [ ] | EVAL-02 | 统计与失败分类 | 5/4/3 | 27 | 每模型/配置至少重复 3–5 次；输出 pass@1、首轮成功率、修复率、置信区间、token、成本、延迟和稳定失败 taxonomy |
| [ ] | EVAL-03 | CI/nightly/release 门 | 5/5/4 | 20 | PR 跑确定性小集；nightly 跑真实 provider 矩阵；release 对质量/成本/延迟设置退化阈值并保存报告 |
| [ ] | TEST-01 | Coverage 与 mutation | 4/4/3 | 24 | changed-line coverage、关键状态机 branch 阈值及 mutation score 纳入 CI；证明关键验收测试会在实现被破坏时变红 |
| [ ] | E2E-01 | Web/桌面/容器真实 E2E | 5/5/4 | 20 | Playwright Web、已打包 Electron 启动/升级/卸载、容器 health+canary 自动化；覆盖流式断线、审批和崩溃恢复 |
| [ ] | E2E-02 | Android 与 provider canary | 4/4/4 | 16 | 修正 Android instrumentation 身份并在 emulator 运行；每次 release 用少量真实 provider 请求验证协议与凭据边界 |

## Phase 2：可恢复、可重放、可运营

| 状态 | ID | 优化项 | I/R/E | 优先分 | 完成定义 |
|---|---|---|---:|---:|---|
| [ ] | RUN-01 | Durable RunState | 5/5/5 | 10 Gate | 持久化 plan DAG、segment、审批/提问、verifier/rework、预算与 tool transaction；进程重启从明确状态恢复 |
| [ ] | RUN-02 | 恢复与故障注入 | 5/5/4 | 20 | 在 model call、tool prepared/committed、审批等待和历史写入各点注入崩溃；不丢状态、不重复副作用、可安全 fork |
| [ ] | OBS-01 | 端到端 trace | 5/4/4 | 18 | run→segment→model/tool spans；记录 commit、模型、工具/schema/pack 版本与输入输出哈希；支持脱敏导出和离线 playback |
| [ ] | OBS-02 | 成本、延迟与 SLO | 4/4/3 | 24 | TTFT、模型/工具延迟、排队/审批等待、重试/错误、USD 成本和 provider/model/pack 归因；持久预算账与 p50/p95/p99 仪表盘 |
| [ ] | OPS-01 | 备份、恢复与升级演练 | 5/4/4 | 18 | 定义并验证 RPO/RTO；完成异地加密备份恢复、版本迁移、回滚及在途任务升级演练 |

## Phase 3：动态协作与扩展平台

| 状态 | ID | 优化项 | I/R/E | 优先分 | 完成定义 |
|---|---|---|---:|---:|---|
| [ ] | AGENT-01 | 一等 `PlanState` 与重规划 | 4/3/4 | 14 | 节点有目标、证据、验收、状态和失败策略；仅在新证据/依赖变化时可审计地更新计划 |
| [ ] | AGENT-02 | 动态多 Agent | 5/4/5 | 9 | supervisor/mailbox 支持 spawn、follow-up、cancel、重新分派和分支失败策略；handoff 使用结构化证据引用 |
| [ ] | AGENT-03 | 每 Agent 隔离与路由 | 5/4/5 | 9 | 每 agent 独立 worktree/sandbox、工具、模型和预算；并发写不会污染共享 checkout |
| [ ] | MODEL-01 | Provider 能力注册与降级 | 4/4/4 | 16 | 以 endpoint+model capability probe 代替名称猜测；支持健康检查、熔断、fallback、成本/延迟路由与每角色绑定 |
| [ ] | EXT-01 | 插件/Pack manifest 与 SDK | 4/3/4 | 14 | 版本化 manifest、权限声明、依赖、签名/来源、启停与兼容检查；DomainPack 不再只能硬编码发布 |
| [ ] | EXT-02 | 完整 MCP 与公开协议 | 4/3/4 | 14 | 远程 transport、OAuth、resources/prompts/elicitation、lazy tool discovery；公开版本化 schema/SDK/webhook |

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
| [ ] | MEM-01 | 语义化上下文压缩 | 5/4/4 | 18 | 保留用户约束、决策、失败尝试、证据引用和 side-effect ledger，不再只用占位符替换旧工具输出 |
| [ ] | MEM-02 | 分层、可治理记忆 | 4/4/5 | 8 | 原始事件→滚动摘要→artifact/reference store；按用户/项目/任务检索；记录来源、时间、置信度、冲突和删除范围 |
| [ ] | MEM-03 | 跨宿主一致性 | 4/3/4 | 14 | CLI/Web/Electron 使用同一 memory contract；同步、权限、加密、删除和数据归属有端到端测试 |

## 每项实施模板

每次只把一个 ID 从 `[ ]` 改为 `[~]`；完成后记录：

1. **问题与边界**：具体风险、受影响入口、不在本次范围内的内容。
2. **设计不变量**：必须永远成立的安全或行为约束。
3. **实施文件**：源码、测试、文档和迁移。
4. **负向测试**：故意触发危险/失败路径，不能只测成功路径。
5. **回归证据**：针对性测试、完整测试、typecheck/build/pack，以及需要的真实 E2E/HIL。
6. **残余风险**：未覆盖平台、TOCTOU、外部系统或人工验收项。

当前执行顺序：`SAFE-05 Phase 2B（durable workspace lease + source/execution root + UID/Git/quota）→ EVAL-01 → EVAL-03 → E2E-01 → RUN-01 → SAFE-04 同 run 恢复/SAFE-06`。Phase 2A 的 daemon-label orphan reaper 与真实 `SIGKILL → sweep` E2E 已落地，但仍需 Linux CI 回执，且尚不是无宿主 reaper 的 autonomous TTL。
如果目标改为公网多人服务，`GOV-01/02/03` 必须提前到 `RUN-01` 之后、任何公开上线之前。

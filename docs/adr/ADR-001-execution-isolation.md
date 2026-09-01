# ADR-001: Agent 命令执行采用逐 run Broker 与可验证隔离后端

**Status:** Accepted（分阶段实施）  
**Date:** 2026-08-27  
**Deciders:** Agent_Design 维护者

## Context

改造前 `bash` 工具通过 `child_process.exec` 以宿主用户身份运行。工作目录、审批、环境变量去密、120 秒超时与输出上限是必要护栏，但都不是 OS 隔离：命令仍可访问宿主可见的文件、网络、进程和设备，超时也不保证回收整棵子进程树。

项目还有三类进程入口，不能混成同一种能力：

- `bash` 是模型可提供任意命令的通用执行面，必须进入逐 run 执行边界；
- MCP stdio server 是长驻双工进程，当前由宿主启动并跨 Web run 共享。普通软件 MCP 应迁入托管 worker，硬件 MCP 必须走设备 gateway 与 lease；
- UI reveal、Electron host、eval/build/release 是控制面或可信构建通道，不接受模型提供任意可执行文件，继续使用独立的固定参数 allowlist。

现有生产 Compose 对整个 Web 宿主做了只读 root、非 root 用户、cap-drop 与资源限制。这是良好的宿主加固，但 workspace、UID、网络与资源配额仍由所有 run 共享，不能称为逐 run sandbox。

约束如下：

1. 项目必须继续支持 Windows 本地开发，但 Git Bash、`cmd.exe`、Job Object、WSL 和 `windowsHide` 单独都不能标记为 sandbox。
2. 没有可验证后端时，严格模式必须拒绝命令，绝不能静默回退宿主执行。
3. 模型只能提交命令；镜像、挂载、网络、UID 和资源参数由宿主策略固定，不能由模型传入。
4. 状态面必须区分“发现候选能力”“本次 bash 已隔离”“整个 run 已隔离”。首个纵切只覆盖 bash，因此即使 OCI 可用也只能报告 `partial`。
5. 当前支持边界仍是单操作员、单租户；敌对多租户需要独立 Broker 服务、强身份与数据分区。

## Decision

采用统一的逐 run `ExecutionBroker` 接口，传播路径为：

`AgentConfig → AgentLoop → ToolExecutor → ToolContext → bashTool`

Web 宿主通过 `executionBrokerFactory(runId, workdir)` 为每个 run 固定一个 broker；CLI 也创建独立 boundary。全局 `bashTool` 不保存可变 run 状态。

策略与后端使用两个正交配置：

- `AGENT_EXECUTION_ISOLATION=off|report|required`
- `AGENT_EXECUTION_BACKEND=auto|oci|bwrap`

语义固定为：

| Mode | 行为 |
|---|---|
| `off` | 明确允许宿主直跑，状态必须显示 `direct` / 未隔离；不得同时指定隔离后端。 |
| `report` | 探测候选后端但仍宿主直跑，状态必须显示 `report-only`；用于兼容迁移，不是安全交付。 |
| `required` | 只有通过功能探测与固定 policy profile 的后端才能执行；不可用、配置错误或 lease 失败均拒绝，绝不回退宿主。 |

`auto` 只在通过同一 policy profile 的后端中确定性选择，不表示 best-effort host fallback。首个实现的有效后端是 OCI；`bwrap` 保留为 Linux 优化项，只有叠加 cgroup v2、功能探测与逃逸套件后才能满足 `required`。

OCI v1 profile 固定：digest/image-ID pinned、`--pull never`、网络/IPC 关闭、只读 rootfs、
唯一 RW workdir 且禁递归子 mount、numeric UID/GID 65532 且无补充组、cap-drop ALL、
`no-new-privileges`、builtin seccomp、PID/CPU/内存/swap/FD/输出/wall-time/tmpfs 限制。
镜像 ENTRYPOINT/healthcheck 被覆盖，镜像声明的 VOLUME 会被拒绝，`env -i` 只留下固定
HOME/PATH。固定 bootstrap 先用 `umask 077` 将 stdin 全量写入 worker 私有 tmpfs 脚本，
再用 `/bin/sh <script> </dev/null` 执行；脚本内程序拿到 EOF，正文不进入 Docker CLI
argv/`Config.Cmd`。

内嵌 adapter 只接受 Linux 上管理员固定的 Docker CLI 绝对真实路径并逐次复核 SHA-256，
daemon 只能是 root 管理的本机 Unix socket；PATH、context、TCP/SSH endpoint 均拒绝。
功能探针核对 UID/GID/groups、rootfs、NNP、CapEff、seccomp、路由、cgroup/FD 与写入；
实际 workdir 再做 daemon 双向 read/write/rename/delete canary，并拒绝 symlink 路径组件、
嵌套 mount、IPC/device 与 hardlink。required 每次执行都强制刷新。abort/timeout/输出超限、
每个 segment 收尾与宿主关停按精确容器名清理；follow-up 换用新 broker 并重新探针。
只有 daemon 明确回执容器不存在才算 confirmed。清理未确认会锁存为全局
readiness/admission 失败；per-run 探针前后均重验全局 gate，早拒也先持久化 failed
`run_config`。Provider 密钥、runtime socket 和设备均
不进入 worker。

远程 Web 一旦开放 bash，必须配置 `required`；无可用后端时 readiness 与新 run 准入失败。loopback/CLI 的缺省迁移模式为 `report`，允许兼容运行但持续明确显示“宿主直跑、未隔离”。

状态契约禁止单一 `sandboxed: boolean`。至少报告：requested mode/backend、probe state、resolved backend、effective state、boundary ID、policy digest、coverage、文件系统/网络/身份/资源策略。只有整个 run 的所有执行面与 lease 都通过时才允许 `isolated`；OCI bash 首纵切为 `partial`。

## Options Considered

### Option A: OCI-only

| Dimension | Assessment |
|---|---|
| Complexity | 中高：镜像、daemon/Broker、清理与探测 |
| Cost | 冷启动与镜像存储成本中等 |
| Scalability | 可按 run 扩展，资源策略完整 |
| Team familiarity | 现有 Docker 部署资产可复用，但逐 run worker 是新能力 |

**Pros:** 文件系统、网络、UID、capability、PID/CPU/内存约束表达完整；跨 Linux/Windows/macOS 可保持同一控制面契约。  
**Cons:** Docker CLI 存在不等于 daemon/安全 profile 可用；不能把 socket 暴露给 worker；桌面平台需要实际运行时验收。

### Option B: bwrap-only

| Dimension | Assessment |
|---|---|
| Complexity | 中：namespace/mount 简洁，但 cgroup 与 rootfs 要另建 |
| Cost | 启动开销低 |
| Scalability | Linux 本地很好，跨平台差 |
| Team familiarity | 当前仓库无 bwrap/cgroup 资产 |

**Pros:** Linux 上轻量，适合高频短命令。  
**Cons:** 非 Windows/macOS 后端；bwrap 本身不提供完整 CPU/内存治理；错误 mount manifest 很容易暴露宿主。

### Option C: Hybrid backend registry（选择）

| Dimension | Assessment |
|---|---|
| Complexity | 高：统一 probe/prepare/exec/dispose 与 capability profile |
| Cost | 可以按部署环境选择较低成本后端 |
| Scalability | 最好；生产固定 OCI，Linux 本地可选 bwrap |
| Team familiarity | 通过单一 Broker 接口把复杂度集中在基础设施层 |

**Pros:** 不把平台差异泄露给工具；可渐进替换后端；同一 fail-closed 契约可测试。  
**Cons:** 需要维护跨后端验收矩阵，`auto` 选择和 capability attestation 必须稳定。

### Option D: 仅 off/report + 宿主进程限制

| Dimension | Assessment |
|---|---|
| Complexity | 低 |
| Cost | 最低 |
| Scalability | 无真正隔离，不能用于敌对工作负载 |
| Team familiarity | 与当前实现最接近 |

**Pros:** 兼容现有 Windows 与工具链。  
**Cons:** cwd、审批、环境去密、Job Object 与 timeout 都挡不住宿主读写和网络；不能满足 SAFE-05。

## Trade-off Analysis

Hybrid 的实现成本最高，但它把不可避免的平台差异关在一个稳定接口后。OCI 先行是因为其 policy surface 能同时表达 mount、network、identity 和资源上限；bwrap 只有配合受控 rootfs 与 cgroup 才能达到同一 profile。`report` 被保留只为迁移期间不突然破坏本地工作流，任何 UI、日志或文档都不得把它描述成隔离。

内嵌 OCI CLI broker 仅是单操作员阶段的纵切，不是最终多租户信任边界。最终生产形态需要独立、最小权限的 Broker 服务持有 runtime 控制权，控制面通过认证协议提交结构化 spec；worker 永远看不到 runtime socket。

## Consequences

- bash 的执行策略能逐 run 固化并审计，严格模式不会意外落到宿主。
- Windows 当前无已验证 OCI/bwrap 后端时，`required` 会正确显示 unavailable 并拒绝执行。
- 默认 `report` 仍保留宿主命令风险，但风险从隐含事实变成明确、可测试的迁移状态。
- OCI 命令会失去默认网络和宿主环境；依赖安装应改走受控缓存/egress profile，而不是临时开全网。
- ADR-002 已为新 worker 增加 daemon-resident schema-3 lease，并在下一次成功 probe 回收已到期
  orphan；无后续 reaper 时仍不是 autonomous daemon TTL，独立 Broker/timer 仍是 Gate。
- 根目录 canary 不证明 UID 65532 能覆盖普通 checkout 中任意嵌套目录/0644 文件；逐 run
  worktree/UID（或 idmapped volume）lease、Git lock 验证、磁盘/inode 配额仍是 Gate。
- MCP、硬件 gateway、bounded autonomous cleanup 与多租户 Broker 服务仍是 SAFE-05 Gate；清单保持 `[~]`。
- Electron renderer sandbox、生产宿主 container 与 Agent run isolation 在 UI/文档中必须使用不同名称。

## Action Items

1. [x] 增加 ExecutionBroker 类型、逐 run 传播和 Local/OCI backend。
2. [x] 增加配置解析、OCI 功能探测、固定 policy args、required fail-closed 与远程准入门。
3. [x] 在 CLI、`/api/harness`、`run_config` 与 Tools 面展示真实 effective state。
4. [x] 增加 parser、broker 传播、命令参数不注入、secret/network/mount/resource 与 unavailable 负向测试。
5. [ ] 把普通 MCP stdio 迁入 managed worker；硬件 MCP 改为 gateway + device lease。
6. [~] 已增加每 run broker、销毁回执、并发 worker、workdir canary 与 ADR-002 durable lease/reaper；专属 worktree/UID lease、无后续 probe 的定时销毁仍待完成。
7. [~] Linux CI/release 已配置 OCI 真实逃逸/资源/清理/reaper canary；本机 Windows 无可信 fixture，尚未取得本轮 CI 运行回执。Windows/macOS 仍只验 capability report 与 fail-closed。
8. [ ] 独立 Broker 服务完成后重新评估多租户支持边界。

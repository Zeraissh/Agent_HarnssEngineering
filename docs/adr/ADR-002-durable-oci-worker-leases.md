# ADR-002: OCI worker 使用 daemon-resident lease 与 fail-closed reaper

**Status:** Accepted（SAFE-05 Phase 2A）  
**Date:** 2026-08-28  
**Deciders:** Agent_Design 维护者

## Context

ADR-001 的进程内 `active` map 能处理正常完成、abort、timeout、segment dispose 与宿主优雅关停，
但 Node 宿主遭遇 `SIGKILL`、进程崩溃或断电时不会运行 cleanup。`docker run --rm` 只在容器退出时
删除对象；若宿主 Docker CLI 消失而 worker 仍在运行，daemon 中仍可能留下容器。

回收不能简单执行 `docker ps --filter label=agent-harness.managed=true | docker rm -f`：同一个 daemon
可同时服务多个 Web/CLI 进程，批量删除会误杀合法并发 worker。按容器名删除也存在迟到 cleanup 与名称
复用之间的竞态。另一方面，本地 tombstone 会随宿主文件系统、进程或临时目录一起丢失，不能证明
daemon 中对象的真实身份。

本阶段仍是 Linux 直宿主、共享宿主 PID namespace 的单操作员边界。目标是让新 schema worker 在 daemon
重启后仍带可验证所有权，并在下一次成功启动/probe 时安全收敛；没有任何 broker/reaper 运行时，不承诺
固定时刻自动删除。来自不同 PID namespace 的记录会 fail-closed，不能套用直宿主死亡判据。

## Decision

把 Docker container 的不可变 labels 作为 durable tombstone。`required+oci` 必须配置稳定且部署唯一的
`AGENT_EXECUTION_OCI_NAMESPACE`；label 只保存 namespace 的 SHA-256 摘要。每个 worker、functional probe
和 workdir probe 在创建时原子写入以下 schema-3 字段：

- `managed=true`、`schema=3`、namespace 摘要；
- 随宿主进程生成的 owner UUID、boot-id 摘要、PID namespace 摘要、PID、`/proc/<pid>/stat` starttime，
  以及逐容器 lease UUID 与 worker kind；
- boundary 摘要、policy digest；
- `lease-ms = wall timeout + cleanup grace`，协议硬上限为 24 小时。

容器名绑定完整 boundary 摘要和完整 lease UUID。继续使用 `--rm`，并在 inspect 时强制核对
`AutoRemove=true` 和 restart policy 为 `no`；不额外传 `--restart=no`，因为 Docker 不允许把 restart
policy 与 `--rm` 组合使用。

每次 OCI probe 在 functional canary 前执行 fresh sweep：

1. 重新验证管理员固定 Docker CLI 的真实路径、SHA-256 与本机 root 管理 Unix socket。
2. 只按当前 namespace 列出完整 container ID，最多 256 个；不能先按 `managed=true` 过滤，
   否则同 namespace 下被篡改或缺失 managed label 的对象会绕过 fail-closed 校验。
3. 两阶段处理：先逐个 inspect 并严格校验完整 schema、名称绑定、AutoRemove/restart、Created 与租期；
   任一 legacy/unknown/malformed/current-namespace 记录使 probe fail-closed，并且本轮不删除任何目标。
4. 从 Docker daemon 的 `SystemTime` 与容器 `Created` 计算是否到期；未到期记录绝不删除。
5. 到期只是第一条件；还要用当前 boot-id、PID namespace 与精确 PID starttime 证明 owner 已死亡。
   owner 仍活时保留；`/proc` 隐藏/权限错误会用同 PID namespace 的 `kill(pid, 0)` 保守复核，成功视为
   仍存活，`EPERM` 或 namespace 不同视为未知并 fail-closed，只有 `ESRCH` 才能证明该 PID 不存在。
6. 同时满足“租期到期 + owner 明确死亡”后，按 inspect 得到的完整 ID 执行 force remove，再 inspect 同一完整 ID。只有 Docker 明确返回
   `No such container/object` 才算 confirmed。

正常 cleanup 同样先 inspect 名称、核对 namespace/lease/全部 ownership labels、固定完整 ID，再按 ID 删除
和 readback；名称已被其他对象复用时拒绝删除。多个 reaper 并发处理同一个已到期 ID 是幂等的：先删除者
完成后，后续 inspect 获得明确不存在回执即可收敛。

不使用“PID 存在”这一单因子作为删除依据。boot-id 先区分重启，PID namespace 防止跨 namespace 假死，
PID starttime 再封住 PID reuse；固定 wall timeout 定义最早回收时刻。全部证明一致才能删除，owner UUID
只用于审计归属。若部署隐藏其它进程且 signal-0 也无法确认，过期外部 owner 会使 required 暂停准入，
直到管理员处理或独立 Broker 提供可信存活证明。

schema-1 容器没有完整 namespace/lease 语义，schema-2 容器没有 boot/PID-namespace/PID-starttime owner fencing；运行时
不会自动删除这两类 legacy 对象。升级前必须停旧实例，人工枚举、inspect 并清理旧对象，再启用稳定
namespace。修改 namespace 时采用同一迁移流程。

## Options Considered

### Option A: 仅保留进程内 active map

**Pros:** 实现简单，正常路径清理快。  
**Cons:** 宿主崩溃后状态与 cleanup 同时丢失，不满足 durable recovery。

### Option B: 本地文件 tombstone

**Pros:** 容易写入 history 目录，可附带更多诊断信息。  
**Cons:** 文件存在不证明 daemon 对象身份；临时目录、磁盘回滚和多宿主 daemon 会造成漂移，仍需 inspect labels。

### Option C: 按 managed label 全局批量删除

**Pros:** 代码最少，能快速清空遗留容器。  
**Cons:** 会误杀其他进程/部署的合法 worker，且按名称删除有复用竞态，拒绝采用。

### Option D: daemon labels + 固定 lease + 启动/probe reaper（选择）

**Pros:** tombstone 与被管理对象同生共存；未到期或 owner 仍活的并发 worker受保护；完整 ID 删除与 daemon readback可验证。  
**Cons:** 必须有后续 reaper 调用才会收敛；时钟与 daemon 可用性成为 fail-closed 依赖；需要 namespace 运维纪律。

### Option E: 独立最小权限 Broker/systemd timer

**Pros:** 宿主应用不再启动也能按期清理，可形成真正 bounded TTL。  
**Cons:** 需要新服务、认证协议、部署/升级与高可用设计；作为后续多租户目标，不阻塞本轮单操作员纵切。

## Trade-off Analysis

选择 Option D，因为它在不引入第二个常驻服务的前提下，关闭了“状态只在 Node 内存”和“按名称误删”两个
最高风险缺口。代价是保证语义必须写成 eventual cleanup on next successful sweep，而不是 daemon TTL。
任何 list/inspect/time/remove/readback 异常都会牺牲可用性并阻断 required 准入，这是安全边界有意选择的
fail-closed 行为。

## Consequences

- 新 schema worker 的 ownership/lease 在 Docker daemon 中持久化，Node `SIGKILL` 不会抹掉 tombstone。
- 到期且 owner 明确死亡的 orphan 会在下一次成功 probe 中按完整 ID 删除，并获得明确 daemon readback。
- 未到期的其他进程 worker、不同 namespace 对象和名称复用对象不会被删除。
- daemon wall clock 向前跳不会单独触发删除；精确 owner 仍活时必须保留。
- PID namespace 不同、`/proc` 与 signal-0 结论不充分时视为 unknown，阻断准入但不删除对象。
- current namespace 内未知/畸形 tombstone 会阻断 required，但保持原对象供管理员检查。
- 无后续启动/probe、daemon/socket永久不可用或 daemon 元数据损坏时，不能证明定时清理；需要独立 Broker/timer。
- 本决策不解决专属 worktree/UID、Git lock、disk/inode quota、窄 TOCTOU、managed MCP 或设备 lease；
  SAFE-05 继续保持单操作员 `partial`。

## Action Items

1. [x] schema-3 labels、稳定 namespace、租期/扫描超时配置进入 policy digest。
2. [x] normal cleanup 先验证 lease，再按 full ID 删除并 inspect readback。
3. [x] 每次 OCI probe 在 canary 前执行两阶段 durable sweep；异常 fail-closed。
4. [x] 增加 parser/labels/legacy/malformed/name-reuse/隐藏 proc/PID-namespace 单元测试与真实 OCI expired/live/malformed canary。
5. [ ] 在 Linux CI/release 取得新增真实 OCI 测试回执；Windows 本机只验证 skip 与 fail-closed。
6. [x] 增加真实子进程 `SIGKILL → lease 到期 → 新 broker sweep` 端到端测试。
7. [ ] 实施 SAFE-05 Phase 2B：durable workspace lease、source/execution root 分离、UID/Git/quota 方案。
8. [ ] 独立最小权限 Broker/timer 落地后，把 eventual sweep 升级为 bounded autonomous cleanup。

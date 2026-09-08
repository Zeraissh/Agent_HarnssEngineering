/**
 * D3 权限三档对照表（docs/09 §4.3 / backlog D3）
 *
 * 动手前先写清；UI 只显示模式名不够——装配条必须继续展开真实开关值。
 *
 * | 档 | `AGENT_PERMISSION_MODE` | approvalDefault | plan 编排 | 计划确认门 | CLI `--yes` / autoYes |
 * |---|---|---|---|---|---|
 * | **manual**（默认） | `manual` | ask（逐次问；run 内同参复用仍受 SAFE-04） | 关 | 关 | 关 |
 * | **plan** | `plan` | ask | 开（`mode=plan`） | 开 | 关 |
 * | **auto** | `auto` | auto（工具声明 ask 的仍可被宿主 --yes 放行） | 关 | 关 | 开 |
 *
 * ## 不变量（不得稀释）
 *
 * 1. `permission: deny` **压过**更具体的 allow/ask；`--yes` / auto 档打不穿。
 * 2. 圈禁 / SAFE-01~03 硬拒（symlink、SSRF、路径逃逸）不受三档影响。
 * 3. pack 泛化 `auto` 不能盖掉 server 单工具 `ask`（既有 SAFE-01 测试）。
 * 4. 不做七档；不做 `bypassPermissions` 等价档（`--yes` 已是它，且硬拒除外）。
 *
 * ## 代码事实源
 *
 * - 对照表：`src/permission-mode.ts` → `PERMISSION_MODE_TABLE`
 * - 求值：`resolveToolPermission` / `resolveMcpToolPermission`
 * - 执行器：`ToolExecutor` 在审批门前拦截 `deny`
 * - CLI 启动行打印展开后的开关值（不许只报模式名）
 */

export {};

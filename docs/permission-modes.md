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
 * - Web 出厂：`WEB_DEFAULT_PERMISSION_MODE=manual`、`WEB_DEFAULT_AUTO_APPROVE=false`；
 *   `GET /api/harness.defaults.autoApprove === false`。页面「自动放行」默认不勾，
 *   说明「默认先问；勾上才自动放行」。发送按钮和 label 是「发送」。
 * - CLI `--yes` 横幅跟 `cliRuntimePermissionSwitches`（`yes=true` / 会自动放行），不抄 env 标签。
 * - Web：`permissionMode` 选择器 + 装配条 / composer 一行人话（哪一档、会不会自动放行 ask）；
 *   展开开关仍在 why 里。`mode` 只跟实际开关反推，不跟点过的标签（追问改编排后对不上 → 自定义）
 * - Web 计划确认门（`plan` 档）：卡上可改子任务 title/description；
 *   `POST /api/runs/:id/plan-approval` 的 `edits` 写入活计划再执行。其它结构字段不写。
 *   门上点停止 = `aborted` / 「已停止」，不是否决；否决按钮才是 `plan_rejected`。
 *   停 / 否决 / 过期后不再钉「批准并开跑」。
 * - CLI `--plan`：TTY 出计划后问「开跑？ [y/N]」（可改一行标题）；`--yes` 自动开跑。
 *   非 TTY 无 `--yes` 退出码 2、印「需要确认，请加 --yes」，不摔 readline。
 *   `--plan --yes` 是自定义（gate + autoYes）。帮助不再写「没有计划确认门」。
 * - 台账：`permissionMode` 记实际开关反推的档（自定义 → null），不是点过的标签；
 *   `approvals{asked,auto,denied}` 记工具审批结局（计划门不计）
 */

export {};

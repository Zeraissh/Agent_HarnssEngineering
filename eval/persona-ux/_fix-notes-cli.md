# CLI UX 修记（#12 / #13 CLI / #14 / #15 / #24）

日期：2026-09-14  
范围：只动 CLI。未 commit / 未 push。未改 `ui/public/**`、`ui/server.ts`。  
未改 Web 新建 run 默认（`WEB_DEFAULT_PERMISSION_MODE=manual` / `WEB_DEFAULT_AUTO_APPROVE=false` 仍在 `src/permission-mode.ts`，属并行 Web 路）。

## 文件

- `src/cli-args.ts` — `run --help`、帮助正文、非 TTY 人话与退出码
- `src/cli.ts` — 横幅跟 `--yes`、非 TTY 不摔 readline、读不到检查点就停
- `src/cli-durable.ts` — 去掉 reopen-当新任务；`formatCliResumeStop`
- `src/permission-mode.ts` — 只加 `formatPermissionBanner` / `cliRuntimePermissionSwitches`（不改 Web 默认常量）
- `test/cli-args.test.ts` / `test/cli-durable.test.ts` / `test/permission-mode.test.ts`

## 逐条

| 条 | 状态 | 做法 |
|---|---|---|
| #12 非 TTY 批准摔 readline | **已修** | 无 TTY 不建 readline；需要确认印「需要确认，请加 --yes」，`process.exit(2)`。`ERR_USE_AFTER_CLOSE` 同句同码。有 TTY 仍 y/n。 |
| #14 `--yes` 横幅说谎 | **已修** | 横幅用 `cliRuntimePermissionSwitches({ autoYes })`，跟台账同一套开关。`--yes` → `yes=true` / 「会自动放行」，不再抄 `AGENT_PERMISSION_MODE` 标签的 `yes=false`。 |
| #15 `--resume-run` 不能热续还考古 | **已修** | `prepareCli*` 不再 `kind: reopen`。读不到热续检查点立刻停（退出码 1），印原任务 / 终态，不 `loop.run` 当新任务。 |
| #24 `--help` 无换模型；`run --help` 被拒 | **已修** | 帮助写清暂无 `--model`、用 `AGENT_MODEL`。`run --help` / `run -h` 出帮助，退出码 0。 |
| #13 CLI `--plan` 文案 | **已修** | 帮助写「拆完计划后立刻执行并核查；CLI 不会停下来给你改（没有计划确认门）」。与真实行为一致（CLI 无计划确认门）。 |

## 测试

```
npx vitest run test/cli-args.test.ts test/cli-durable.test.ts test/permission-mode.test.ts
→ 3 files / 41 tests passed

npx vitest run test/design-mode.test.ts test/agent-md.test.ts test/ui-faces.test.ts test/ui-server-ux.test.ts
→ 4 files / 163 tests passed（含 Web 默认先问那条，未改回 auto）

npx tsx src/cli.ts --help
npx tsx src/cli.ts run --help
→ 两份同一正文，退出码 0
```

## `--help` 新增 / 改写的行

Usage 新一行：

```
  npm run agent -- run --help
```

`--plan` 改写为：

```
  --plan         拆完计划后立刻执行并核查子任务；CLI 不会停下来给你改（没有计划确认门）
```

`--resume-run` 改写为：

```
  --resume-run ID  同 run 热续。须有已提交检查点；飞行中杀掉不能接着工具。读不到检查点会停并印原任务/终态，不会当新任务重开
```

新段落：

```
Model:
  命令行暂不能 --model / --api-key / --workdir。
  换模型：环境变量 AGENT_MODEL（可选 AGENT_PROVIDER、ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL，或 OPENAI_API_KEY / OPENAI_BASE_URL）。
  工作目录即当前 cwd。doctor 可查看当前 provider / model / 是否有 Key。

Confirm:
  没有交互终端时请加 --yes，否则会停在确认（退出码 2），不会摔 readline 栈。
```

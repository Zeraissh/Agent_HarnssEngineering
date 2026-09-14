# CLI `--plan` 确认门

日期：2026-09-14  
范围：只动 CLI 宿主 + 共用短句补丁。未 commit / 未 push。  
未改 `ui/public/**`。未改 Web `POST /api/runs/:id/plan-approval` 契约。  
改标题复用 `src/planner.ts` 的 `resolvePlanShortEdits` / `applyPlanShortEdits`（与 Web 同一纯函数）。

## 谎话

CLI `--help` 写「拆完就执行，没有计划确认门」。Web 早就有确认门（可改 title/description）。`--plan` 在 TTY 上也不该拆完就动手。

## 行为

| 场景 | 行为 |
|---|---|
| **TTY** + `--plan`（无 `--yes`） | planner 出计划后停下：打印子任务短表（id / 标题 / 包 / 依赖），问「开跑？ [y/N]」。`y`/`yes` 开跑；空回车 / `n` 否决，**零子任务**，`stopReason=plan_rejected`，退出码 1。批准后可再改一行标题（输入子任务 id + 新标题，回车跳过）。活 `Plan` 当场 `applyPlanShortEdits`，执行者看到新标题。 |
| **TTY** + `--plan --yes` | 门在，但 `--yes` 自动开跑（与工具审批同一口径）。 |
| **非 TTY** + `--plan`（无 `--yes`） | **不建 readline**。印「需要确认，请加 --yes」，退出码 **2**。与工具审批门同类，不摔 `ERR_USE_AFTER_CLOSE`。 |
| **非 TTY** + `--plan --yes` | 自动开跑（CI / 脚本）。 |
| `--resume-run` + `--plan` | 半截 DAG 续发射，**不再问确认门**（计划已在跑）。`plan_gated` 崩溃仍拒续跑、CLI 不代签。 |

## 帮助

`--plan` 行改为：

```
  --plan         拆完计划后停下等确认再执行并核查。TTY 打印子任务短表并问是否开跑（y/n，可选改一行标题）；非 TTY 须加 --yes 才自动开跑，否则退出码 2 并印「需要确认，请加 --yes」
```

Confirm 段原句仍有效：「没有交互终端时请加 --yes，否则会停在确认（退出码 2），不会摔 readline 栈。」

## 实现

- `src/cli-plan-gate.ts`：`confirmCliPlan` / 短表 / y-n 解析。只在 TTY 提示档调用 `question`。
- `src/cli.ts`：`runPlanned({ onPlan })` 里 await 确认门。否决抛 `CliPlanRejectedError`，编排器未改。durable：等人时先 `plan_ready gated:true`，批后 `plan_approved`，否决 `plan_rejected`。
- `src/permission-mode.ts`：`--plan` 且无 `--yes` 时 `planGate=true`，对得上 **plan** 档。`--plan --yes` 是自定义（gate + autoYes）。
- `src/cli-args.ts`：帮助文案。

## 测试

```
npx vitest run test/cli-plan-gate.test.ts test/cli-args.test.ts test/permission-mode.test.ts test/cli-durable.test.ts test/planner.test.ts
→ 5 files / 84 tests passed

npx vitest run test/ledger.test.ts test/design-mode.test.ts test/agent-md.test.ts
→ design-mode 30、agent-md 16 全绿。
  ledger 63/64：失败条是「respondCliApproval( 出现次数 ≥ 5」，HEAD 的 cli.ts 也只有 3 处调用，与本轮无关。
```

锁：

- TTY 批准（y，可跳过改标题）→ 子任务会跑。
- TTY 否决（n / 空）→ `CliPlanRejectedError`，零子任务。
- TTY 改一行标题 → 只改 title，pack / 验收不动。
- 非 TTY 无 `--yes` → `need_yes`，不调用 `question`，文案「需要确认，请加 --yes」，退出码 2。
- 非 TTY + `--yes` → 自动批准。
- readline 已关 → 当 `need_yes`，不抛栈。
- `--help` 不再写「没有计划确认门」。

## 未改

README / `docs/permission-modes.md` / `eval/persona-ux/_fix-notes-cli.md` 仍有旧句「CLI `--plan` 没有确认门」——本轮只改 `--help` 与代码注释。Web 契约与 `ui/public/**` 未动。

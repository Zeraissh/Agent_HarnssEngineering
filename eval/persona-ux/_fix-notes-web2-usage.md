# Web2 用量上首页（persona-ux #11）

日期：2026-09-14  
范围：`ui/public/features/command-center.js`、`usage.js`、`settings.js`、`index.html` 占位与花费挂钩、`styles.css`、相关 vitest。未 commit / 未 push。未改 `ui/server.ts` 预算算法、`app.js` 计划卡/`@`/侧栏、`artifacts.js`、electron。

## 挂在哪

| 位置 | 节点 | 人话 |
|---|---|---|
| **侧栏顶栏**（首页也看得见） | `#home-spend` / `[data-spend-text]` | `今日 $0.71`；选中会话且有价时 `这次 $0.04 · 今日 $0.71` |
| **指挥中心看板** | `[data-spend="board"]` | `今日 $0.71` + `今日已用 N 次`；有本次则 `这次 $x` |
| **设置 → 消耗** | `#settings-usage` | 仍是下钻：轮次图 + `$`。开头写清「今日花费在侧栏和指挥中心」 |

没有次数配额，不写「还剩几次」。点击芯片进设置消耗。

## 字段名（现成 API，不编汇率）

- `GET /api/usage` → `byDay[]`：`day`、`usd`、`runs`、`unpricedRuns`
- 今日行：`todayUsageOf` 按本地日历日对 `byDay.day`
- 本次：`runEnd.cost.usd`（宿主 `getSelectedRunCost()`，index.html 从已有 `runStates` 读）
- 派生脸：`deriveSpendFace` → `todayMoney` / `todayUsed` / `todayLine` / `thisRunText` / `chipText`
- 钱：`formatUsd`（`null` →「未计价」，不画成 `$0.00`）

## 测了哪些

```
npx vitest run test/ui-command-center.test.ts test/ui-settings.test.ts test/ui-usage.test.ts
```

新增锁：看板/侧栏 DOM 有「今日 $0.71」「今日已用 110 次」「这次 $0.04」；空看板仍留花费条；不出现「还剩几次」；设置消耗 lede 写明下钻。

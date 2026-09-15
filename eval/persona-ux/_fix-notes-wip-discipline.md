# WIP：澄清/拆分纪律 + 配图完成门

日期：2026-09-15  
范围：`src/clarifier.ts`、`src/planner.ts`、`src/task-completion.ts`、`src/design-image-review.ts`（只改注释）、对应测试。  
未改 ui / cli / serve / schedules / walks / VERIFY / README / `.env.example`。未 commit。

## 纪律（clarifier + planner）

杂志风 / 幻灯 / 大图不得改成色块，也不得从 acceptance 删掉。planner 两条协议都写死：这类任务 `pack` 必须是 `design`，色块不算大图。

## 配图完成门

完成方式=做对，不是原样合上缺工具的门。

- 本段工具面**真有** `describe_image`：未审图的 `completed` 在 `resolveTerminal` 硬拒。
- 工具不在场（flash 设计活常见）：只靠 `finish_task` 描述和 reminder 走 `partial` / 警告，**不**把合法 `completed` 打成无效。

`unreviewedImageCompletion` 只陈述事实；硬拒看工具面是否在场。

## 测了哪些

```
npx vitest run test/clarifier.test.ts test/planner.test.ts test/design-image-review.test.ts test/loop.test.ts
```

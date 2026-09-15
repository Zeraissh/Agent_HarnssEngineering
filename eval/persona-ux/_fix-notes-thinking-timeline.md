# 思考正文进对话时间线

日期：2026-09-15  
范围：`ui/public/app.js`、`ui/public/index.html`、`ui/public/styles.css`、`test/ui-patch.test.ts`、`test/ui-app.test.ts`。  
未 commit / 未 push。未改 review-mode、飞书 / `ui/serve.ts`、`cross-app/**`、git remote。未改 walks / VERIFY / BACKLOG / CLI。

## 谎话

第五批把 `thinking_delta` 接到直播条「正在想…」+ 思考尾。对话里虽有默认折叠的 Thinking，摘要只写 `Thinking...`，事件流要等 turn 级 `assistant_thinking` 才出现一行字数。人眼停在直播条，时间线不像在跟思考。

## 做了哪几条

| 条 | 状态 | 可见变化 |
|---|---|---|
| **思考正文进对话时间线** | 已改 | 运行中有 `liveThinking` 时，对话那条 live Thinking 的摘要跟上思考尾（折叠块里正文也跟流）。已有 `assistant_thinking` 时，执行事件流同一行展开并跟增长正文（`正在写`）。直播条「正在想…」仍在。正文 `text_delta` 一到，直播条让位，事件流回到终态、不再跟增量。 |

## 纪律

- harness 已推 `thinking_delta`（`src/loop.ts` / `src/types.ts`）。`reduceEvent` 仍丢掉它，不占 seq。
- 控制器 `liveThinking` 独立缓冲（与 `liveTexts` 同族）。重放只靠 `assistant_thinking` 终态。
- 没有把 `thinking_delta` 写入 events.jsonl（`src/archive-event.ts` 仍把 delta 当 ephemeral）。
- 不为 flash 特判。未重写 walks。

## 时间线上现在能看见什么

- **对话**：折叠 Thinking 摘要有增长尾；点开是完整思考正文。节点不因涨字重建。
- **执行事件流**：当前轮已有 `assistant_thinking` 时，那一行跟 live 正文并默认展开。还没有这条 durable 事件时，只在对话 live 块里跟（appendOnly 日志不能插一条随后再拆掉的假行）。
- **直播条**：无正文增量时仍是「正在想…」+ 尾；有 `liveText` 时隐藏。

## 重放

重放没有 delta。`status !== "running"` 时 `deriveLogEntries` 不贴 live。残留 `liveThinking` 也拉不回对话 live 块。屏幕只剩 `assistant_thinking` 终态（默认折叠，标题带字数）。

## 文件

- `ui/public/app.js` — `attachLiveThinkingToLog`；`renderThinkingDetails` / `updateLiveNode` 摘要尾；`patchLogPanel` 就地改直播思考；`entryActionLabel` / `entryDetail`
- `ui/public/index.html` — `currentLiveBuffers` 同时喂对话与 `deriveLogEntries`
- `ui/public/styles.css` — `.chat-thinking-live-tail`
- 测试如上

## 测了哪些

```
npx vitest run test/ui-patch.test.ts test/ui-app.test.ts -t "思考|thinking_delta|流式|2b|2c"
npx vitest run test/ui-patch.test.ts test/ui-app.test.ts
```

**结果：** 过滤集 37/37；全量 `ui-patch` 328 + `ui-app` 292 = 620 全绿。未 commit。

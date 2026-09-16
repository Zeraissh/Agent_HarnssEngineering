# 图片懒加载（摘要先行 / 按需看原图）

日期：2026-09-16  
范围：接线。`describe_image` detail、`view_image` 装配、compact 降级已在工作树，本条只补提示词、UI 人话、渲染锁。  
未 commit。未改完成门「没工具不硬拒」。未改 walks / VERIFY。上传仍不会自动识图。

## 人话（界面）

| 工具 | 工具条动词 | 批准卡 |
|---|---|---|
| `describe_image`（缺省 / `detail=summary`） | 看图摘要 | 要看图摘要 `文件名` |
| `describe_image`（`detail=full`） | 看图详述 | 要看图详述 `文件名` |
| `view_image` | 把原图载入本轮 | 要把 `文件名` 的原图载入本轮 |

`input.detail` 已在 `tool_call` 的 `input` 里，`reduceEvent` 不用另投一列。

## 用户怎么用

1. 把图当附件发进对话。正史里只有路径行，**不会**因此打视觉、也不会把像素塞进执行者上下文。
2. 问「这是什么」：模型应调 `describe_image`（缺省 summary）。主上下文只留下一段文字回执。配图完成门认「成功调用过 `describe_image`」，summary 即可。
3. 多图提取、批量贴标签：反复 summary / 结构化文字。不要对整批 `view_image`。
4. 只有像素、对比、排版、跨图对照：`detail=full`，或（执行者自己能看图时）对那几张 `view_image`。文本执行者工具面没有 `view_image`。
5. `view_image` 要审批（`ask`）。放行后**下一轮**请求才带 image 块。

## 什么时候会进正史

| 东西 | 进正史？ |
|---|---|
| 上传附件 | 路径行。像素不进。 |
| `describe_image` 回执 | 进。一段文字 `tool_result`。 |
| `view_image` 回执 | 进。一句「已载入、下一轮能看见」，**不含** base64。 |
| `view_image` 像素 | 进当轮 messages（下一轮发给执行者）。不进 `userInput` 字符串，不进 `tool_result`。 |

## compact 回收

保护窗外的 image 块换成 `[compacted_image] path=…`，扫得到同路径的 `describe_image` / `view_image` 回执再加 `summary:` 行。界面附件缩略图不动——回收的是模型正史。

## 测了哪些

```
npx vitest run test/presets.test.ts test/ui-patch.test.ts
```

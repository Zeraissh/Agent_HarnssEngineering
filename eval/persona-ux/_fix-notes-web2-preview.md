# Web2 预览修复笔记（persona-ux #17 后半）

日期：2026-09-14  
范围：产物预览点击 + 预览坞。未 commit / 未 push。未改计划卡、`@`、侧栏、用量看板。未碰 git 暂存区。

## 怎么预览

- 点产物条「预览」、对话里的「打开」、路径旁的眼睛：一律 `preventDefault`，走右侧预览坞 / 覆盖浮层（iframe 或同源 `/api/.../artifact`），**不** `window.location` 到 `file://`。
- `file://` 或盘符 href 也会被拦下，抽出路径后仍开页内坞。
- 浮层顶条有「关闭」（回到对话）；停靠坞仍是「收起」。
- 本场写出文件且坞是关的：自动打开（优先 `.html`）。

## 测了什么

```
npx vitest run test/ui-artifacts-panel.test.ts test/ui-preview-dock.test.ts \
  test/ui-patch.test.ts test/ui-app.test.ts test/ui-file-preview.test.ts \
  test/ui-artifact-canvas.test.ts
```

**6 files / 746 passed**；`ui-patch` 另有 2 条红（计划卡步骤正文、对话出处 URL），与预览点击无关，本轮未动。

锁：「点击预览不离开页面」（含假 `file://` 链）；画廊卡片不改 `location`；浮层有「关闭」；写完关着的坞会 `openArtifactByPath`。

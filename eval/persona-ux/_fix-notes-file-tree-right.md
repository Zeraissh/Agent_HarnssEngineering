# 文件树改到右侧（persona-ux file-tree-right）

日期：2026-09-15  
范围：`ui/public/features/file-tree.js`、`ui/public/index.html` 挂载、`ui/public/styles.css` 文件栏、`test/ui-file-tree.test.ts`。  
未 commit / 未 push。未碰 `app.js`、`review-mode.js`、`ui/serve.ts`、`ui/workspace-files.ts`。

## 做成了什么

| 条 | 状态 | 可见变化 |
|---|---|---|
| **左栏** | 已改 | Code 脸不再被文件树占掉。Work / Code 都是对话/会话列表（`#run-list`），新建/搜索/底栏不变。 |
| **右栏** | 已改 | 树挂在 `#center-row`、`#main-area` 之后（产物/预览/Progress 同一侧）。`order: 20` 让 Files 停在最右。头上「文件 ⟩」可折叠，偏好 `agent.ui.pref.filesRailCollapsed`。 |
| **不绑脸** | 已改 | 有工作目录就列文件。换脸 / 换目录都 `reload`，不再 `if (face === "code")`。 |
| **护栏** | 保留 | 展开 `q=dir/`、点文件预览、行内 `@`、圈禁人话、深 8 / 单层 200 仍走服务端 notice。 |

## 怎么开树

- 默认展开。点栏头「文件 ⟩」收成「⟨ 文件」。
- 换工作目录会重列。没选目录时栏上是「先选一个工作目录。」

## 测了哪些

```
npx vitest run test/ui-file-tree.test.ts test/workspace-files.test.ts
```

锁：树在 `#center-row` 不在 `#sidebar`；CSS 不再 `.sidebar[data-workspace-face=code]`；折叠记偏好；`--ft-depth` 缩进。

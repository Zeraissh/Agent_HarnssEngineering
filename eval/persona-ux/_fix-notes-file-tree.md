# 文件树 MVP（persona-ux file-tree）

> 后续：树已从左栏挪到右侧，见 `_fix-notes-file-tree-right.md`。下面是当时「Code 脸左栏」那一版。

日期：2026-09-15  
范围：`ui/workspace-files.ts`、`ui/public/features/file-tree.js`（新建）、`ui/public/index.html` 挂载、`ui/public/styles.css` 最小补、`test/workspace-files.test.ts`、`test/ui-workdirs-api.test.ts`、`test/ui-file-tree.test.ts`（新建）。  
未 commit / 未 push。未碰 `ui/server.ts`、`ui/public/features/review-mode.js`、`artifact-canvas`、`cross-app/**`、`app.js`。

## 做成了什么

| 条 | 状态 | 可见变化 |
|---|---|---|
| **Code 脸工作区树** | 已改 | 侧栏 Code 脸出现「文件」资源管理器。根浅列圈内文件；点文件夹展开/折叠。Work 脸仍是对话列表，树用 CSS 藏。 |
| **展开走旧接口** | 已接线 | `GET /api/workspace/files?q=dir/` 本来就会浅列那一层。没加新路由，没改 `ui/server.ts`。每条路径仍走 `resolveInWorkdir`。 |
| **点文件** | 已接线 | 点文件名：有会话则进产物画布，没有则进既有预览坞（`/api/file-preview`）。行内 `@` 走同一套 `insertWorkspaceFileMention`。没有第三套交互，没有 `file://`。 |
| **人话 / 护栏** | 已改 | 空目录、没选工作目录、权限/打不开、圈外、过深、单层超过 200：脸上是人话，不是 HTTP 码。深度 8、单层 200；`@` 深搜仍是深度 4 / 40 条。 |

## 刻意不是完整 IDE 的边界

- 没有编辑器 Tab、没有行内改文件、没有 git 装饰、没有拖拽改路径、没有监视盘变更。
- 不一次拉整棵树：只展开当前层。隐藏目录 / `.env*` / `node_modules` / `.git` / `.agent-*` 仍不进。
- `@` 点名补全还是原来的 picker，不是把侧栏树当补全 UI。
- 服务端只转发 `{ files }`，人话挂在条目的 `notice` 上。

## 测了哪些

```
npx vitest run test/workspace-files.test.ts test/ui-file-tree.test.ts test/ui-workdirs-api.test.ts
# 3 files / 45 passed
```

锁：

- 浅列仍跳过 `.env` / `node_modules`；`q=app` 深搜 `src/nested/app.js`；`../secret` 空列表
- `q=src/` 只列 `src/` 子项；`../secret/` 只有 escaped notice，不列圈外文件
- 深度 > 8 给人话；单层 > 200 截断 + notice
- 前端：树形状、点文件夹再打 `q=src/`、点文件 / `@` 回调、403 与逃逸不出现 HTTP 码

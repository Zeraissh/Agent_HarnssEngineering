# Web UX 第五批（persona-ux web5）

日期：2026-09-15  
范围：`ui/public/app.js`、`ui/public/index.html`、`ui/workspace-files.ts`、`ui/public/features/artifacts.js`。  
未 commit / 未 push。未碰 git add / commit / reset / rebase。未改 CLI。未改 walks / VERIFY / BACKLOG / REPORT 结论。

## 做了哪几条

| 条 | 状态 | 可见变化 |
|---|---|---|
| **思考增量跟直播条** | 已改 | harness 早就推 `event: delta` `kind:thinking`。控制器 `liveThinking` + `foldLiveDelta` 本来就攒字。第四批只在 turn 级 `assistant_thinking` 时写「正在想…」，且 `liveThinking` 一到就把直播条藏掉（对话 Thinking 默认折叠，人看不见正文）。现在：有 `liveThinking` 时直播条写「正在想…」+ 思考尾；`thinking_delta` 仍不进 RunState / 时间线。正文 delta 仍让直播条让位（V-16）。 |
| **#16 `@` 更深一点** | 已改 | `GET /api/workspace/files?q=` 空查询仍浅列一层。带 q 时按文件名/相对路径包含匹配，深度 4，最多 40 条。圈外 / `.env*` / `node_modules` / 隐藏目录仍不进。picker 过滤框防抖后再打服务端，不再只筛已列出的那一页。仍不是完整 IDE 树。 |
| **#4 / #17 产物画廊空态** | 已改 | 「打开产物」空态不再写「还没有产物」。改成「这里只列落地页和幻灯。本场写下的文件在对话的产物条里。」 |
| **空态 @ 提示** | 已改 | 「输入 @ 可按文件名找这个文件夹里的文件。」 |

## 文件

- `ui/public/app.js` — `liveStripThinkingLabel` / `paintLiveStripLabel`；`thinking_delta` 仍在 reduce 丢掉；空态 hint
- `ui/public/index.html` — `@` picker 过滤框防抖 `refetchWorkspaceFiles`
- `ui/workspace-files.ts` — 空 q 浅列；带 q 深搜 + `resolveInWorkdir`
- `ui/public/features/artifacts.js` — `ARTIFACTS_EMPTY_COPY`
- `README.md` / `docs/06-backlog.md` 第一屏 / `eval/persona-ux/README.md` 活页目录（不改 walks）

未改：`src/cli.ts`、`src/**` harness、`ui/server.ts`（`q=` 本来就往下传）、git 暂存区。

## 测了哪些

```
npx vitest run test/workspace-files.test.ts test/ui-workdirs-api.test.ts \
  test/ui-patch.test.ts test/ui-app.test.ts test/ui-artifacts-panel.test.ts \
  -t "workspace/files|思考|thinking_delta|空态|点名引用|14\\.|14c|产物"
```

锁：

- `thinking_delta` 不进 timeline；有 `liveThinking` 时直播条可见且含思考正文
- 空 q 仍浅列、不列 `.env` / `node_modules`
- `q=app` 找到 `src/nested/app.js`；`../secret` / `../app` 空列表
- `GET /api/workspace/files?q=app` 同上；圈外 workdir 403
- 产物画廊空态不含「还没有产物」
- 空态文案「按文件名找」；`index.html` 含 `refetchWorkspaceFiles(`

## 4173 / FOUP

未杀宿主。`127.0.0.1:4173` Listen PID 12904 = `tsx --env-file-if-exists=.env ui/serve.ts`。静态页已是本批 `index.html`（含 `refetchWorkspaceFiles`）。`workspace-files.ts` 在进程启动时已 import，深搜 API 要等重启才进这台宿主；单测与进程外 `listWorkspaceFiles(..., "workspace-files")` 才是新代码。

FOUP 预览（未重启也能吃到 wave 4 注入）：

- `GET /api/runs/5e44430a-…/site/foup/index.html` 200，HTML 带 `<style id="agent-hidden-fix">[hidden]{display:none!important}</style>`，`Permissions-Policy: webgl=*`
- 同路径 `style.css` 有 `.loading[hidden], .fallback[hidden] { display: none !important; }`
- Chrome headless 截图：三维 FOUP 模型在画面中央，**没有**「这台设备没有可用的 WebGL」遮罩。侧栏中文有缺字（headless 字体），不是假无 WebGL。

## 诚实缺口

- compat 端点若不推 `thinking_delta`，直播条仍要等 turn 级 `assistant_thinking` 才从「等待模型响应…」改成「正在想…」（没有正文可跟）。
- `@` 深度 4、40 条封顶，不是文件树，也不跟 gitignore。
- 产物画廊仍不列出本场 txt，只改口不再说谎。
- 未改 VERIFY / walks：档案仍可能写「还没有产物」/「FATHOM 控制台」。
- 未动 CLI。
- 活 4173 未重启，深搜接口在那台进程上仍是浅列。

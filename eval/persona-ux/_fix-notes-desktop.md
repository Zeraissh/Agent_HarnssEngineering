# 桌面壳 UX 修记（#21）

日期：2026-09-14  
范围：只动 `cross-app/electron/**`、`cross-app/README.md`、相关 `cross-app` 测试。  
未 commit / 未 push。未改 `ui/public/**`、`ui/server.ts`、CLI。未碰 git 暂存区。

## 标题变成什么

桌面窗不再跟宿主页 `<title>FATHOM 控制台</title>` 走（Electron 默认会把页标题抄到窗框）。壳按 hash 自己定：

| 当前页 | 窗口标题 |
|---|---|
| 首页 / `#/` / `#walk=…` / 启动中 | `FATHOM` |
| `#/run/<id>/…` 对话 | `FATHOM · 对话` |
| `#/settings` | `FATHOM · 设置` |
| `#/board` | `FATHOM · 指挥中心` |
| `#/artifacts`、产物画布 | `FATHOM · 产物` |
| `#/schedules` | `FATHOM · 定时任务` |
| `#/usage` | `FATHOM · 消耗` |
| 本地设置窗 | `FATHOM · 模型与运行设置` |

`page-title-updated` 必须 `preventDefault`，否则口号会盖回来。`app.setName('Agent Harness')` 未改（改了会换 userData 目录，丢掉本机设置/工作区）。

## 启动说明怎么写

开发入口就是 `npm run desktop`（仓库根或 `cross-app` 均可）。4173 没人听时 `host-launcher` 已有的 `spawnHost` 会自拉起 `ui/serve.ts`；已在听则贴上去。

**现在没有开始菜单项。** README 照实写：请用 `npm run desktop`，不要假装已装进开始菜单。仓库里虽有 `desktop:dist`（electron-builder / NSIS），但那是签名发布链，本条不为「有个开始菜单图标」再造一条安装包。

## 测了什么

```
cd cross-app && npm test
→ 6 files / 48 passed + 1 skipped（Windows 上 POSIX SIGKILL 真机例，原样 skip）
```

新增 `test/window-title.test.js`：首页 `FATHOM`、对话 `FATHOM · 对话`、七路 hash、任何输入都不含「控制台」。  
`test/electron.test.js`：壳接线 `window-title.cjs` + `preventDefault`；`probeHealthy(candidate)` 之后才 `spawnHost`；README 含「现在没有开始菜单项」。  
既有 `host-launcher.test.js` 仍锁探活 / 真拉起 / 收树。

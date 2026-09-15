# 开始菜单安装包（#21 续）

日期：2026-09-15  
范围：`cross-app/electron-builder.yml`、`cross-app/README.md`、根 README 桌面/安装段、`cross-app/test/electron.test.js`、找 exe 的 pack/lifecycle 冒烟。  
未 commit / 未 push。未改 `ui/server.ts`、review-mode、workspace-files、GitHub/飞书接线。未在本机对用户系统跑 NSIS 安装。

## 装完叫什么

沿用已有 electron-builder NSIS 目标（CI `desktop-nsis-lifecycle`），不另造安装器。

| 面 | 名称 |
|---|---|
| 开始菜单快捷方式 | **FATHOM** |
| 桌面图标 | 安装向导勾选项，默认勾，名字同样 **FATHOM** |
| 安装包文件 | `dist-electron/FATHOM-<version>-<arch>-setup.exe` |
| 安装后 exe | `FATHOM.exe` |
| appId | 仍是 `com.self.agentharness`（覆盖升级认同一应用） |
| Electron userData | 仍由 `app.setName('Agent Harness')` 决定，不跟产品名走 |

点开始菜单 **FATHOM** 走现有 launcher：本机没有健康宿主就自拉起打包进 `resources/harness` 的宿主；4173（或 `AGENT_UI_PORT`）已健康则 attach。

## 怎么打包

在 `cross-app/`：

```powershell
npm run desktop:dist              # 签名发布；缺 CSC_* 会拒绝
npm run desktop:dist:unsigned     # 本机/CI 验证，不得当发布物
```

仓库根 CI 已有调用：`npm run e2e:electron-lifecycle -- --build` → `desktop:dist:unsigned`，再在临时目录 `/S /D=` 装/升级/卸。不要对用户「开始菜单 / 桌面」跑这一遍。

开发仍用 `npm run desktop`。

## 测了什么

```
cd cross-app && npm test
→ 6 files / 52 passed + 1 skipped
```

- builder：`productName` / `executableName` / `shortcutName` = FATHOM；`createStartMenuShortcut: true`；`createDesktopShortcut: true`（不是 `always`）；`oneClick: false`
- README：有开始菜单入口，不再写「没有开始菜单」
- launcher：`ERR_ABORTED` 仍是 `if (error && error.code === 'ERR_ABORTED') return;`（不把加载页竞态当失败盖正式页）
- pack 脚本仍点 `desktop:dist` / `desktop:dist:unsigned`，并认 `FATHOM.exe`（旧 `Agent Harness.exe` 只作覆盖升级回退）

`node --check` 过 lifecycle / pack / packaged-desktop 三个冒烟入口。未跑完整 NSIS 安装。`desktop:dist:unsigned` 会先 `host:stage`→根 `npm run build`；本机若撞上 `ui/workspace-files.ts` 既有 tsc 报错，那是禁改范围，不在本条修。

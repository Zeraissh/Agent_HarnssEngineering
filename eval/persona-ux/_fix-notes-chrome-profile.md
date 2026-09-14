# Chrome `./chrome-profile` 弹窗修记

日期：2026-09-14  
范围：`src/chrome-user-data.ts`、`src/tools/bash.ts`、`src/card-png.ts`、`cross-app/electron/chrome-user-data.cjs`、`host-launcher.cjs`、`main.cjs` 注释、`eval/persona-ux/resolve-chrome-profile.mjs` 与三份 CDP 走查脚本。未 commit。

## 是谁拉起的

产品路径（`src/` / `ui/` / `cross-app/`）**没有**手写 `--user-data-dir=./chrome-profile`。页内预览是沙箱 iframe，不启 Google Chrome。

弹窗正文里的路径是字面量 `./chrome-profile`，来自本机 **Google Chrome.exe**：

1. **FATHOM 任务里的 agent** 用 `bash` 预览 3D/HTML 时，常见写法是  
   `chrome --user-data-dir=./chrome-profile …`。相对路径相对**当时 cwd**；不可写或被锁，Chrome 就弹「无法创建数据目录」。
2. **persona-ux 走查**曾用本机 Chrome + CDP（`eval/persona-ux/walks/_*-cdp.mjs`）。旧脚本把 profile 写死在仓库下的 `_*-chrome-profile`；更早的一次性命令可能用过 `./chrome-profile`（根目录探测垃圾曾被提交笔记点名跳过）。
3. 桌面壳只 `shell.openExternal`，不带 user-data-dir。第二张图里的 WebGL / TypeError 是 iframe 预览页自己的问题，**不是**这个系统框。

## 如何不再弹窗

- 唯一解析口：`resolveChromeUserDataDir` → `%LOCALAPPDATA%\fathom-chrome-preview`（或 `os.tmpdir()` / Electron userData 子目录）。`./chrome-profile` **不**按 cwd 展开。
- 启动前 `mkdirSync(..., { recursive: true })` 并写探针确认可写。
- 目录有 `SingletonLock` / 不可写：换 `-<pid>-<rand>` 后缀，不让 Chrome 去弹系统框。
- **bash 执行前**改写命令行里的 `--user-data-dir=./chrome-profile`（及空格/引号形式）。
- Playwright 截图、走查 CDP、桌面启动器都走同一合同；启动参数测试锁「必须绝对，且不是 `./chrome-profile`」。

本机若还有旧 Chrome 窗口占着仓库里的 `eval/persona-ux/walks/_*-chrome-profile`，关窗即可；新启动不再用那条相对路径。

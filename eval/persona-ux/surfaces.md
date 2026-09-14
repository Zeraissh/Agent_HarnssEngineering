# Boot surfaces（第一次打开产品）

记录日期：2026-09-14。只靠 `package.json` 脚本名、`--help`、启动横幅、已开终端、`.env.example` 的启动说明、桌面启动器文件名，以及屏幕上能看见的字。没有读 `docs/`、设计章节、backlog、测试。

本机已有 `.env`（`.env.example` 说：复制成 `.env` 后，`npm run cli` / `ui` 会自动读）。下面不写任何密钥。

---

## 1. 怎么打开每一面

从仓库根目录 `d:\Work\Github_pros\Agent_Design`：

| 面 | 第一次会试的命令 | 实际发生 |
|---|---|---|
| Web UI | `npm run ui` | `tsx --env-file-if-exists=.env ui/serve.ts`。本机**已经在听**，没有再起一份。 |
| 编译后的 Web | `npm start` | `node --env-file-if-exists=.env dist/ui/serve.js`。本机 `dist/ui/serve.js` 在；对这份入口传 `--help` 时它仍去占端口，报 `listen EADDRINUSE: address already in use 127.0.0.1:4173`。 |
| CLI | `npm run agent` 或 `npm run cli` | 都进 `src/cli.ts`。另有 `npm run doctor` = `… src/cli.ts --doctor`。 |
| 桌面 | `npm run desktop` | 转到 `cross-app` 再跑 `electron .`。 |

`.env.example` 写给用户的启动方式：把文件复制成 `.env`，填自己的值；`npm run cli` / `ui` / `eval` / `ab` / `lab` / `smoke:local` 会自动读。端口旋钮写的是 `AGENT_UI_PORT=4173`（示例里是注释行）。

端口不是猜的：示例文件写了 4173；旧终端 `npm run ui` 横幅也是这个数；本机 `Get-NetTCPConnection` 有 **Listen + OwningProcess>4**（PID 39672，`127.0.0.1:4173`）。TimeWait 未当作占用。

---

## 2. Web

- **是否在听：** 是。`127.0.0.1:4173` Listen，OwningProcess `39672`（`ui/serve.ts` 那棵 node）。
- **URL：** http://127.0.0.1:4173/
- **探活（浏览器以外能打到的字）：**
  - `/` → HTTP 200，`<title>FATHOM 控制台</title>`
  - `/health` → `{"status":"ok",…}`
  - `/ready` → `{"status":"ready",…}`（字段里有 `activeRuns`、`history`、`execution` 等，走查时以页面为准）
- **本轮未再启动 Web。** 已开终端里曾见过启动横幅原文：

```
Harness UI → http://127.0.0.1:4173
  workdir: D:\Work\Github_pros\Agent_Design
  pack:    (none)
  auth:    loopback origin boundary
  bash:    enabled
  execution: requested=report/auto (effective readiness waits for the functional probe)
```

### 走查者打开首页会看见的字（欢迎态）

页标题 / 品牌：

- 标签页：`FATHOM 控制台`
- 侧栏品牌：`FATHOM.`
- 欢迎区：`Agent Console` / `FATHOM.` / `see every run to the bottom.` / `每一层都看得见。`
- 工作区两个脸：`Work` / `Code`（Code 默认选中）
- `新建对话`
- 搜索框占位：`搜索对话…`
- 筛选选项：`全部` / `运行中` / `已完成` / `未通过`；还有 `全部项目`
- 底栏图标名称：`打开指挥中心` / `打开产物` / `打开定时任务` / `记忆` / `打开设置`
- 主题菜单（点开才见）：`跟随系统` / `暖纸` / `暖炭` / `石墨` / `高对比`

输入栏：

- 项目：`未入项（按目录）`
- 工作目录按钮默认：`选择目录`
- 模型按钮加载中：`加载中`；管理：`管理模型…`；搜索占位：`搜索模型…`
- 角色胶囊：`规划 · 跟随执行` / `核查 · 跟随执行` / `识图 · 未配置` / `生图 · 未配置`
- 标签：`任务描述`
- 输入占位：`要这个目录做什么…`
- 发送按钮（读屏）：`运行任务`（屏幕上是向上箭头）
- 附件：`添加图片或文件`
- 勾选项：`独立核查`
- 输入提示：`Enter 发送，Shift+Enter 换行`

点开「运行设置」才见的旋钮名：

- `领域包`（默认项：`不用领域包`）
- `自动匹配`（`按任务选已注册的包`）
- `权限`（`手动 · 危险动作会先问你，不会自动放行`；选项 `自定义` / `逐次审批` / `计划确认门` / `自动放行 ask`）
- `计划`（`拆解后等人批准`）
- `多 agent`（`并行子任务，最多 3`）
- `自动放行`（`工具调用不再逐次问`）
- `思考强度`（`默认`）
- `评分表`（占位 `可选`）

欢迎态还会在输入框下方放出 starter gallery（源码里初始 `hidden`，页面进欢迎布局后会打开）。走查时以当时屏幕上的卡片文案为准。

断线条（平时藏着）：`连接中断，正在重连…（运行仍在服务端继续）`。

---

## 3. CLI

**命令（帮助原文）：**

```
npm run agent -- run [options] "task description"
npm run agent -- doctor
npm run agent -- --help | --version
```

兼容旧入口（帮助原文）：

```
npm run cli -- [options] "task description"
```

空跑 `npm run cli`（不带任务）退出码 1，屏幕上：

```
Usage: npm run agent -- run [options] "task description"（旧入口 npm run cli -- 仍兼容）
```

`npm run agent -- --help` 全文：

```
Agent_Design CLI

Usage:
  npm run agent -- run [options] "task description"
  npm run agent -- doctor
  npm run agent -- --help | --version

Compatibility:
  npm run cli -- [options] "task description"

Run options:
  --yes          自动批准工具请求（仅用于明确接受风险的无人值守运行）
  --verify       独立核查，未通过时有界返工
  --plan         planner 拆解、执行并核查子任务
  --parallel N   plan 并行度；也接受 --parallel=N，省略 N 表示 auto
  --auto         自动选择单领域 pack
  --ask          允许 agent 在执行前集中提问（与 --yes 互斥）
  --resume-run ID  同 run 续跑（单执行者=检查点；--plan=半截 DAG；预算耗尽则拒）
  --             后续内容一律视为任务文本

Doctor is static: it performs no network request and starts no execution worker.
```

版本：`npm run agent -- --version` → `1.3.0`。

`npm run agent -- run --help` 会红字报：`run 不能与 --help 同时使用` / `使用 --help 查看用法。`

`npm run doctor` 本机打印（无密钥，只有是否有凭据）：

```
provider: anthropic (source: default)
model: deepseek-v4-flash (source: .env-or-environment-same-value)
base_url_origin: https://api.deepseek.com (source: .env-or-environment-same-value)
credential_present: yes (source: .env-or-environment-same-value)
```

`npm run` 列表里，用户一眼能对上产品入口的名字：`agent` / `cli` / `doctor` / `ui` / `desktop` / `start`。其余是 eval、测试、打包。

---

## 4. 桌面 / Electron

- **怎么开：** 仓库根 `npm run desktop` → `npm run desktop --prefix cross-app` → `electron .`（入口 `cross-app/electron/main.cjs`）。
- **依赖：** `cross-app/node_modules/electron` 在；首次跑 `electron --version` 会下载二进制，打印 `v43.4.0`。
- **本次结果：能打开。** 已拉起并保持在后台。
  - 进程：`electron.exe .`，user-data 目录名 `Agent Harness`（`%AppData%\Agent Harness`）。
  - 窗口标题：**FATHOM 控制台**（和浏览器页标题一样）。
  - 应用内部名字：`Agent Harness`。
  - 菜单上的字：`工作目录`（`添加工作目录…`，快捷键 Ctrl+Shift+O） / `设置`（`模型与运行设置…`，快捷键 Ctrl+,）。
  - 启动中会先闪：`正在启动 Harness 宿主…`。连不上时的字：`无法启动/连接 Harness 宿主：…` / `无法连接 Harness 宿主：…`。
- **和 Web 的关系（只按启动器行为，不按设计文档）：** 本机 4173 已经健康时，桌面是贴上去的，没有再起第二个 Listen。关桌面窗不应去杀这份已有 Web（启动器写明 attach 时 `hostChild` 为空）。4173 的 OwningProcess 在桌面打开后仍是 `39672`。
- **未试：** `npm run desktop:dist` / 安装包 / 开始菜单快捷方式。源码树里没有现成的「双击桌面图标」安装产物可点。

---

## 5. 给走查者的入口摘要

- Web 打开：http://127.0.0.1:4173/ （已在听，标题 `FATHOM 控制台`）
- CLI 试跑：`npm run agent -- run "任务原文"`；先看用法：`npm run agent -- --help`；自检：`npm run doctor`
- 桌面：`npm run desktop`（已确认能出窗，标题同样是 `FATHOM 控制台`）
- 第一次配环境（示例文件原话）：复制 `.env.example` 为 `.env`，再跑上面的 `ui` / `cli`

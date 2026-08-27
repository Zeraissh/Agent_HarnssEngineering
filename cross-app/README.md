# Agent Harness Console

Agent_Design 项目的跨端 App 外壳：把仓库 [`ui/public`](../ui/public) 的 Web 控制台
原样打包成浏览器预览 / Electron 桌面 / Capacitor Android 三端可用的 Agent 客户端。

控制台本身**不执行 agent**——执行宿主仍是仓库根目录的 `ui/server.ts`
（默认 `http://127.0.0.1:4173`，能执行 bash、批准写文件，所以只绑本机）。
App 外壳负责提供与 WebUI 完全一致的界面与交互，通过网络连接宿主。

## 为什么不是"文本编辑器"

本目录此前是 MyHub 待办事项演示（三端复用的占位脚手架），与 Agent_Design 无关。
Desktop 外壳不再打包这份静态副本，而是直接加载当前 Harness 宿主，因此任务提交、
`ask_user`、事件流、恢复与核查能力不会与 WebUI 漂移。目录内静态前端仅保留给浏览器
预览和实验性 Capacitor 客户端。

## 宿主从哪来（桌面端一键，其余端仍需手动）

Electron 桌面壳自己决定宿主来源，按序：

1. **`AGENT_UI_URL` 显式指定** → 只连它（远程/自管宿主；loopback 可用 HTTP，
   远程必须 HTTPS）。此模式下壳绝不拉起也绝不关停任何宿主。
2. **本机候选端口已有健康宿主**（`AGENT_UI_PORT`，缺省 4173，探 `/health`）
   → 直连。老的"先 `npm run ui` 再开壳"工作流原样保留，关壳不影响宿主。
3. **都没有 → 自动拉起**：入口解析顺序为 `AGENT_UI_HOST_ENTRY` 显式指定 >
   仓库检出的 `ui/serve.ts`（tsx，源码永远新鲜）> `dist/ui/serve.js` 编译版；
   用 Electron 自带 Node 运行，端口取 `AGENT_UI_PORT` 或随机空闲位，
   `.env` 按 node `--env-file` 同款语义装载（已存在的环境变量优先）。
   **关窗即走**：退出时宿主连同 bash/MCP 子进程一起收干净（Windows
   `taskkill /T`，POSIX 进程组信号），不留僵尸。

正式安装包会把编译宿主和 production dependencies 放进 `resources/harness`，因此离开
源码检出也能一键启动。`AGENT_UI_HOST_ENTRY` 仍可用于开发诊断；`AGENT_UI_URL` 可切到
受管的远程宿主。

浏览器预览与 Android 实验客户端不具备自拉起能力，仍需先在仓库根目录
`npm run ui` 起宿主。远程宿主必须使用强访问令牌与 TLS，且默认没有 bash。
不要再使用通配 CORS 作为访问控制。Android 实验客户端侧栏设置中只能填写
可用的 HTTPS 宿主。

## 运行方式

### 浏览器（开发预览）

```bash
npm run dev
```

### Electron 桌面

```bash
npm run desktop
```

一条命令：没有宿主就自动拉起（见上节顺序），有就直连。渲染器启用
context isolation 与 sandbox，不暴露 preload/Node 桥。

#### 切换工作目录

从应用菜单选择 **工作目录 → 添加工作目录…**（快捷键 `Ctrl/Cmd+Shift+O`），
用系统文件夹选择器授权一个目录。首次加入新目录时，本地宿主会在确认后重启；
正在运行的任务会中断，但历史记录不会删除。之后可直接使用页面顶部的“工作目录”
下拉框，或应用菜单里的最近目录切换，不再重启。

选择结果保存在 Electron 用户数据目录的 `workspaces.json`，最多保留 20 个有效目录；
网页没有自由路径输入或文件系统 IPC，不能自行扩大工具写入圈禁边界。原有
`AGENT_UI_WORKDIR` / `AGENT_UI_WORKDIRS` 配置仍会合并进这份白名单。连接外部
`AGENT_UI_URL` 时，目录白名单归外部宿主管理，桌面 App 不会擅自修改。

### 桌面打包

```bash
npm run desktop:dist
```

产物输出在 `dist-electron/`。Windows/macOS 的 `desktop:dist` 有签名门禁；
`desktop:dist:unsigned` 只允许本地验证。

### 移动端构建（Android）

1. 执行 `npm run mobile:sync`（构建 + `cap sync`）；
2. 用 Android Studio 打开 `android/` 目录编译运行；或本机已装好 JDK + Android SDK 时：

```bash
cd android && ./gradlew assembleDebug
```

Android 明文 HTTP 已关闭。移动端在平台凭据存储、签名发布流水线和 HTTPS 真机验收
完成前不属于生产发布目标。iOS 仅支持 macOS + Xcode 环境生成原生工程。

## 一键自检

```bash
bash scripts/verify-all.sh
```

按序执行：单元测试 → Vite 构建 → 前端语法检查 → Electron 入口语法检查 →
Capacitor Android 同步 → appId 一致性断言。任一失败即非 0 退出。

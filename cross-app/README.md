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

## 运行宿主（必需）

在仓库根目录启动 Harness UI 服务：

```powershell
# 仓库根目录（Agent_Design/）
npm run ui
```

远程宿主必须使用强访问令牌与 TLS，且默认没有 bash。不要再使用通配 CORS 作为访问控制。

## App 内设置服务端地址

- 浏览器同源部署（由 `ui/server.ts` 直接服务）：无需设置。
- Electron：启动前设置 `AGENT_UI_URL`；loopback 可用 HTTP，远程地址必须用 HTTPS。
- Android 实验客户端：侧栏设置中只能填写可用的 HTTPS 宿主。

## 运行方式

### 浏览器（开发预览）

```bash
npm run dev
```

### Electron 桌面

```bash
npm run desktop
```

开发态与打包态都加载 `AGENT_UI_URL`（默认 `http://127.0.0.1:4173`）。渲染器启用
context isolation 与 sandbox，不暴露 preload/Node 桥。

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

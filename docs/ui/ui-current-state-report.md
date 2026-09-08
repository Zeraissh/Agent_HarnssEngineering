# Agent Harness Web UI 现状报告（UI 升级评审输入）

> 生成方式：只读静态分析 + 查看 `.codex/` 历史截图；未修改任何项目文件。
> 分析对象：`ui/` 目录（正式 Web UI）、根目录 `index.html`、`assets/`、`demo_sites/`、`cross-app/`。

---

## 1. ui/ 目录完整文件清单

### 1.1 服务端（TypeScript，宿主进程内运行）

| 文件 | 行数 | 体积 | 职责 |
|---|---|---|---|
| `ui/server.ts` | 6 996 | 311 KB | **核心宿主**。HTTP 静态服务 + REST API + SSE 推送；运行生命周期管理（创建/停止/删除/续跑/fork）；审批应答、计划确认门、ask_user 应答、预算追加；文件上传与产物下载；本地路径探测与「在文件夹中显示」（Windows 下调 `explorer.exe /select`）；Phosphor 图标从 `node_modules/@phosphor-icons/web` 映射到 `/vendor/phosphor/` |
| `ui/serve.ts` | 118 | 5.9 KB | 启动器（`npm run ui`）。解析 `AGENT_UI_*` 环境变量；默认只绑 127.0.0.1:4173；非 loopback 时 fail-closed（强制 ≥32 字符令牌、TLS 边界、默认移除 bash 工具） |
| `ui/production.ts` | 106 | 4.1 KB | 启动安全策略纯函数：loopback 判定、令牌/CORS/trust-proxy 解析 |
| `ui/history.ts` | 514 | 20.7 KB | B2 运行历史落盘。每 run 一个目录（`<root>/<runId>/`，默认 `.agent-run-history/`）：`meta.json` + `events.jsonl`（可重放事件流，UI 全部状态由重放长出）+ `transcript.jsonl` + `state.json`（编排游标）；保留最近 N 个；支持崩溃后同 runId 检查点续跑或派生 fork |
| `ui/history-backup.ts` | 128 | 5.6 KB | history.ts 的旧版备份（疑似遗留，未被引用时建议评审清理） |

### 1.2 客户端（零构建、零运行时依赖的原生 ES 模块）

| 文件 | 行数 | 体积 | 职责 |
|---|---|---|---|
| `ui/public/index.html` | 2 032 | 84 KB | 静态骨架（侧栏 + 主区 + 提交栏，约 280 行 HTML）+ **内联主控制器**（约 1 750 行 `<script type="module">`：SSE 订阅、HTTP 调用、hash 路由、主题切换、响应式、事件绑定） |
| `ui/public/app.js` | 7 795 | 336 KB | 纯函数 reducer + DOM 渲染库。事件→状态归约（`reduceEvent`）、派生函数（`derive*`）、分区渲染（`patch*`/`render*`）、打字机节奏（`paceReveal`）、工具调用折叠与标题化、审批卡、计划看板、用量脚注等 |
| `ui/public/styles.css` | 4 027 | 106 KB | 三层令牌设计系统 + 全部组件样式 + 4 主题 + 响应式断点（1100/900/700px）+ `prefers-reduced-motion` |
| `ui/public/core/markdown.js` | 400 | 17 KB | 手写 Markdown 渲染器。安全纪律：入口整体转义 → 之后所有标签由模块自拼；链接协议白名单（仅 http/https）；不支持原始 HTML（有意）；本地路径引用识别（剥行号/全角冒号说明后交给宿主 stat 探测变成可点链接） |
| `ui/public/core/highlight.js` | 150 | 6.7 KB | 手写极简语法高亮。只在**已转义**文本上插 span（防双重转义/反转义）；四类着色（注释>字符串>数字>关键字）；语言：ts/js/py/c/rs/sh/json |
| `ui/public/dom/patch.js` | 202 | 8.5 KB | 键控 DOM 补丁：`patchList`/`appendOnly`/`setText`/`keepScrollAnchored`（贴底跟随、上翻不拽回）/`withFocusPreserved`（直播重渲染不丢焦点与光标） |
| `ui/public/core/diff.js` | 98 | 3.4 KB | `diffKeyed`（LCS 最小 move）+ `signature`（渲染签名比对，没变不重画） |
| `ui/public/core/batch.js` | 72 | 2.4 KB | 事件折叠批处理：rAF 为主，隐藏标签页退定时器 + `visibilitychange` 立即补齐 |

### 1.3 整改文档（评审历史，非代码）

| 文件 | 行数 | 说明 |
|---|---|---|
| `ui/remediation-v1.md` | 430 | v1 整改清单 |
| `ui/remediation-v2.md` | 140 | v2 整改清单（V-01~V-34 + AC2-01~AC2-18 验收标准） |
| `ui/remediation-status.md` | 126 | v1 关闭状态 |
| `ui/remediation-v2-status.md` | 121（36 KB，长表格行） | v2 逐条关闭状态与浏览器实证证据，含大量设计决策理由 |

### 1.4 UI 测试（在仓库 `test/`，不在 ui/ 下）

`ui-a11y.test.ts`（axe-core 无障碍闸门）、`ui-app.test.ts`、`ui-faces.test.ts`、`ui-patch.test.ts`、`ui-production.test.ts`、`ui-server.test.ts`；devDeps 含 axe-core 4.13、jsdom、playwright。

---

## 2. 技术形态

- **纯静态零构建**：原生 ES 模块、无框架（无 React/Vue）、无打包器、无 CSS 预处理器。`npm run ui` = `tsx ui/serve.ts` 直接起服务；`npm run build` 仅 tsc + 拷贝 public 资源。
- **无第三方 CSS 框架**（无 Tailwind/Bootstrap）。设计系统是自研三层令牌：
  - Layer 1 `--p-*` 原始色板（只允许出现在主题块）；
  - Layer 2 语义层 `--surface-*` / `--text-*` / `--status-*` / `--identity-*`；
  - Layer 3 v1 兼容别名（`--bg`/`--fg`/`--green` 等，237 处旧引用的过渡层，刻意保留）。
- **图标**：**是 @phosphor-icons**（`@phosphor-icons/web@^2.1.2`，regular 集），由服务端从 node_modules 映射到 `/vendor/phosphor/style.css` + woff2/woff/ttf，不依赖 CDN。
- **主题 4 套**：跟随系统（auto）、暖纸（浅色默认，`#FAF9F5` 纸面 + 陶土 accent `#B0522F`）、暖炭（深色默认）、石墨（中性深）、高对比。`prefers-color-scheme` 媒体查询 + `data-theme` 手动覆盖 + `<head>` 内联脚本在首帧前从 localStorage 恢复（防闪白）。所有色值经过 WCAG 对比度实算（注释中留有 4.5:1 推算过程）。
- **字体**：标题衬线 `Georgia, "Noto Serif SC", STSong`；正文 `"Segoe UI", "Microsoft YaHei", "Noto Sans SC"`；等宽 `"Cascadia Code", Consolas`。字号下限 12px，正文 14px。
- **视觉纪律**：全站禁用彩色 emoji（CSS 无法给 emoji 上色、破坏主题），统一用单色排印符 `→ ✓ ✗ ⚠ ⟳ ■ ✔ ✘ ⋯ ◈ ↺ ⊟`，并有门禁测试（Unicode Emoji_Presentation 判定）。

---

## 3. 页面/视图结构

单一 SPA（hash 路由），整体 = **左侧栏 + 主区 + 底部提交栏**三段固定布局。

### 3.1 侧栏（280px）
- 品牌区（Harness / 项目与对话）+ 主题选择器（icon 按钮弹出 menu，radio 语义）
- 「新建对话」主按钮
- 对话搜索框 + 状态筛选下拉（全部/运行中/已完成/未通过）
- 对话列表：按工作目录分组，每项显示状态、任务摘要、轮数/时间/耗时；未读标记（跑完没看过的运行）；键控补丁更新不重建节点

### 3.2 主区 · 空态
欢迎页（「从一个明确目标开始」+ 可点示例任务，点击填入输入框而非直接开跑）。

### 3.3 主区 · 对话详情（当前形态：**对话是主干**）
按 `ensureDetailSkeleton`（app.js:3274）：
1. 返回栏 + 会话标题（窄屏下标题即返回按钮）
2. `live-strip` 直播条（aria-live）
3. **对话主列**：用户消息、助手正文、思考过程（可折叠 details）、工具调用（就地织进时间流）、审批痕迹、裁决、段分界（`◆ 核查 Agent 独立复核` / `↺ 返工第 N 轮`）
4. **右栏 rail**（可折叠）：Progress 面板（执行者拆步清单 + 编排子任务）、产物文件卡、计划看板（plan DAG + 时长条）
5. 结果卡（outcome：stopReason 六值分档徽章 + 摘要 + 产物 + 假设 + 阻塞）
6. 用量脚注（执行合计/核查/返工轮数/缓存命中）
7. **仪表盘抽屉**（默认收起的 `<details>`）：四决定因素卡 = 标签栏（Loop / Context / Tools / Verification），下钻内容含事件日志、上下文水位、工具芯片与运行边界、核查裁决卡

### 3.4 「需你决定」坞（action-dock）
钉在提交栏正上方、**在滚动容器之外**——审批卡、计划确认门签字位、ask_user 问题卡（一次打断 1~4 题）都出现在这里，不随内容滚走。

### 3.5 底部提交栏（composer，一个框两种去向）
- 选中可续跑运行 →「继续对话」（追加指令走 `/messages`）；未选中 →「运行任务」（新建走 `/api/runs`）；文案/placeholder/说明行联动切换
- 工作目录下拉（白名单由宿主环境变量声明，浏览器只能选不能自由输入）
- 角色模型区：执行 / 规划 / 核查 / 识图四个 pill（可开关或「跟随执行」）
- 折叠的「运行设置」旋钮：领域包、计划模式（确认门）、多 agent 并行（最多 3）、主观评分表
- 快捷行：独立核查开关、自动放行工具开关、思考强度下拉、上下文用量圆环（SVG 环形 + 上弹面板）
- 预算耗尽时显示「追加预算继续本对话」
- 附件按钮（多选上传）、行内错误区（`role="alert"`，不用 alert()）
- **运行中提交按钮变为「停止」**（同一位置的两种状态，不多加一个按钮）

### 3.6 视觉风格（据 CSS + `.codex/` 截图实证）
- 暖炭深色下：深棕黑底（`#1E1B16` 系）+ 陶土橙 accent + 米色文字；暖纸浅色为米白纸面
- 布局：280px 固定侧栏 + 弹性主列 + 会话内右栏；卡片圆角小、边框细、阴影克制
- 工具调用为紧凑行（图标 + 工具名 + 命令标题 + 耗时），多行结果折叠进 details
- 无插画、无渐变装饰、无动效堆砌——工具型控制台审美，衬线大标题是唯一"编辑感"元素

---

## 4. 交互能力清单

**对话与任务**
- ✅ 新建任务、追加指令（同一输入框双模式）、Ctrl+Enter 发送
- ✅ 附件上传（图片/文件，`POST /api/upload`，上传列表可管理）
- ✅ 停止运行（`POST /api/runs/:id/stop`；按钮即时反馈「正在停止…」，当前步骤跑完才收尾，文案明示"已完成的写入不会回滚"）
- ✅ 删除对话、归档对话回看；有检查点的中断运行可同 runId 续跑，无检查点可 fork 派生
- ✅ 历史会话搜索（关键词）+ 状态筛选 + 未读标记
- ✅ 流式输出（打字机节奏放行，积压多时加速追平，段结束立即全放）

**监督与干预（harness 特色）**
- ✅ 工具审批：审批卡「允许本次」等 + 拒绝理由输入框；可开「自动放行」
- ✅ 计划模式确认门：planner 出图后等人批准再执行
- ✅ ask_user 应答：一次打断最多 4 题，一屏答完
- ✅ 预算追加：当场给谱系加 token 跑道，不用改环境变量重启
- ✅ 思考强度、独立核查、多 agent、领域包、评分表逐轮可选

**文件**
- ✅ 产物卡：预览 / 下载（`/api/runs/:id/artifact`）/ **在文件夹中显示**（服务端圈禁的本机进程启动，Windows `explorer.exe /select`）
- ✅ 正文中的本地路径引用自动识别成可点链接（宿主 stat 探测后激活）
- ❌ 没有完整的文件管理器/目录树视图

**导航与系统**
- ✅ Hash 路由 `#/run/<id>/<face>`，深链刷新恢复，浏览器前进/后退可用
- ✅ 响应式：≤700px 侧栏隐藏进详情模式（返回栏回列表）；另有 1100/900px 断点
- ✅ 深色模式（4 主题，含高对比），localStorage 持久化，首帧防闪
- ✅ 快捷键：Ctrl+Enter 发送、Escape 关菜单/旋钮面板——**没有命令面板，没有更多快捷键**
- ✅ 滚动导航箭头（回到底部 / 回到四决定因素卡）
- ✅ 断线重连横幅（SSE Last-Event-ID 补缺口，30s 兜底轮询；断线不作废挂起审批）
- ✅ 无障碍：aria-live 播报、tablist/listbox 语义、焦点环、axe 自动化闸门、`prefers-reduced-motion`
- ❌ 无设置页（设置 = composer 旋钮）、无账号/登录、无多用户

---

## 5. 关键组件实现细节

| 组件 | 实现 |
|---|---|
| 消息渲染 | 手写 `core/markdown.js`：**先整体转义再变换**；不支持原始 HTML（有意）；链接仅放行 http/https；本地路径引用剥离行号后变可点 |
| 代码高亮 | 手写 `core/highlight.js`：零依赖，在已转义文本上单趟扫描插 span；注释>字符串>数字>关键字四类；7 种语言别名表 |
| 流式呈现 | SSE 双通道：全局 `/api/stream`（生命周期）+ 每 run `/events`；`text_delta` 走命名通道不占 seq 不进缓冲；`paceReveal` 匀速放行（剩不多一次放完，done 立即全放）；批处理 rAF + 隐藏标签页定时器兜底 |
| 工具调用 | 织进对话时间流；相邻工具调用折叠成组（`collapseToolGroups`）；标题化（shell 命令分词取阶段标题、路径条带）；成功/失败语义色 + `formatDuration` 耗时；过程/对话两种读法切换 |
| 思考过程 | 可折叠 details、默认状态可记偏好、支持合并与脱敏（`renderThinkingDetails`） |
| DOM 更新 | **不整树重建**：键控 LCS diff + 分区补丁 + 签名比对；滚动锚定（贴底跟随、上翻不拽回）；焦点/光标保留（实测拒绝理由输入框直播下 38 秒不失焦） |
| 错误状态 | 行内 `role="alert"`（替代 alert()）；HTTP 状态码 + 服务端文案；stopReason 六值分档（completed/max_tokens/max_turns/error/interrupted/user-stop，各有 tone/label/补救提示） |
| 加载状态 | 骨架屏 + 空态文案（「等待拆步…」）；快照缺席时照实降级「未获取到工具清单」，不编造 |
| 审批卡 | 唯一键 `toolUseId#requestSeq` 防跨轮串卡；决策落事件流（刷新后仍显示"已允许 + 时间"）；过期判定幂等 |

---

## 6. assets/、demo_sites/、根 index.html、cross-app/

- `assets/images/`：7 个 SVG（logo badge + 导航图标），是**博客 demo 的素材**，与 harness UI 无关。
- `demo_sites/liquid-demo/`：独立的「液态梦境」动效演示（canvas 涟漪/流光按钮），**与 harness UI 无关**，是 agent 产出的示例站点。
- **根目录 `index.html`（47 KB / 1 203 行）：不是 agent UI**——是「Mini City Drive · 极简 GTA 驾驶」霓虹玻璃拟态游戏 demo（agent 生成的产物），勿与 `ui/public/index.html` 混淆。
- `cross-app/`：把 `ui/public` 控制台**原样打包**的跨端外壳（浏览器预览 / Electron 桌面 / Capacitor Android），内含一份 8 月 13 日的静态副本（app.js/styles.css/core/dom，已落后于 ui/public 主副本——markdown.js 在 cross-app 是 9 月 5 日更新的）；执行宿主仍是 `ui/server.ts`，桌面壳可自动拉起宿主。**UI 升级需注意两处副本的漂移风险。**

---

## 7. 现成 UI 截图

**Harness UI 真实截图（`.codex/`，深色暖炭主题，2026-08-24）**：
- `.codex/ui-r6-baseline.png` / `ui-r6-implementation.png` / `ui-r6-comparison.png`（整体界面前后对比，约 1 MB）
- `.codex/ui-r6-focus-sidebar.png` / `ui-r6-focus-composer.png`（侧栏 / 提交栏特写）
- `.codex/ui-path-links-implementation.png` / `ui-path-links-comparison.png` / `ui-path-links-focus.png`（路径链接功能，3 张）
- `.codex/ui-tool-path-theme-implementation.jpg` / `ui-tool-path-theme-comparison.jpg` / `ui-tool-path-theme-focus.jpg`（工具路径 + 主题，3 张）
- `.codex/ui-theme-menu.jpg`（主题菜单）

已查看其中 2 张实证：深色底 + 陶土橙主按钮、侧栏对话分组列表、对话流内嵌思考/工具卡、右侧产物列、底部 composer 带角色模型 pill 与「运行设置」。

其余图片均非 harness UI：`_qa/shots/`、`_qa/blog*/` 是 penacony-site 演示站截图；`uploads/` 是用户上传；`ad7793_thermocouple/` 是电路板产物图。

---

## 8. 升级评审要点提示

1. **规模集中**：`app.js` 7 795 行 / 336 KB、`server.ts` 6 996 行 / 311 KB、index.html 内联控制器约 1 750 行——单文件巨型化是首要可维护性问题。
2. **零构建约束是双刃剑**：markdown / 高亮 / diff 全部手写，安全纪律严明，但升级时需先决策是否保留零构建约束（决定能否引入框架）。
3. **设计系统已成型**：三层令牌 + 4 主题 + 对比度实算，升级应在此之上扩展而非推倒。
4. **历史包袱**：Layer 3 兼容别名（约 237 处旧引用）、`ui/history-backup.ts` 疑似遗留、`cross-app/` 静态副本与 `ui/public` 已漂移。
5. **能力缺口**：无命令面板、快捷键仅 Ctrl+Enter/Escape、无文件树/文件管理视图、无独立设置页、无全局内容搜索——评审可立项方向。

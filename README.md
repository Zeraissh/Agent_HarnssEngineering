# Agent_Design — Harness Engineering 智能体框架

一个从零手写的智能体（agent）框架，TypeScript 实现，直接构建在 Anthropic Messages API 之上。

## 这是什么

模型本身是引擎，但同一个模型在不同产品里的表现差异巨大——差异来自围绕模型构建的 **harness（马具）**：agent loop 的结构、工具的形状、上下文的质量、验证的闭环。本项目的目标不是再造一个 LangChain，而是：

1. **把 harness 的每一层亲手实现一遍**，深入理解 agent 工程的核心权衡；
2. **产出一个领域无关的骨架**，后续可以接入任意领域工具（嵌入式调试、研究、办公自动化……）。

因此刻意不使用 Claude Agent SDK / LangGraph 等现成框架——那些框架替你做的决策，正是本项目想亲手做的决策。

## 四个支柱

| 支柱 | 含义 |
|---|---|
| **Loop** | 请求 → 分支 stop_reason → 执行工具 → 回填结果 → 循环，直到任务完成或触发护栏 |
| **Tools** | 模型与世界交互的唯一通道；工具的粒度、schema、描述决定了模型能做什么、宿主能管控什么 |
| **Context** | 上下文是稀缺资源：稳定内容在前（缓存友好），易变内容在后；窗口逼近时有压缩策略 |
| **Verification** | 让 agent 的输出可被检验：结构化事件流、token 审计、（后续）独立上下文的验证子代理 |

## 文档导航

| 文档 | 内容 |
|---|---|
| [docs/01-philosophy.md](docs/01-philosophy.md) | Harness engineering 设计哲学与设计原则 |
| [docs/02-architecture.md](docs/02-architecture.md) | 五层架构、模块职责、一轮 turn 的完整数据流、关键 API 事实 |
| [docs/03-interfaces.md](docs/03-interfaces.md) | 核心 TypeScript 接口定义（实现蓝本） |
| [docs/04-roadmap.md](docs/04-roadmap.md) | 演进路线（v0.1 → v1.1）与每阶段验证 checklist |
| [docs/reference/README.md](docs/reference/README.md) | `src/` 全部 21 个模块的参考文档（签名与源码逐一核对；由 v1.1 并行编排自举生成，见案例 #2） |
| [docs/cases/](docs/cases) | 真实任务案例：#1 遥测固件真机闭环、#2 并行编排交付参考文档（墙钟 −43%） |

## 快速开始

```powershell
npm install

# Anthropic 官方（默认 claude-opus-4-8）
$env:ANTHROPIC_API_KEY = "sk-ant-..."

# 或任意 Anthropic 兼容端点（DeepSeek / 智谱 GLM / Moonshot Kimi）
$env:ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic"
$env:ANTHROPIC_API_KEY  = "sk-..."
$env:AGENT_MODEL        = "deepseek-chat"   # 非 claude-* 自动进入 compat 模式

# 或本地 Ollama（v0.14+ 原生 Anthropic 兼容；本地慢速模型务必配超时与输出上限）
# 定位（2026-08 起）：本地端点仅作离线/隐私路径验证（npm run smoke:local），
# 研究实验一律用云端——弱执行者请用云端小模型（SiliconFlow/DashScope 的 qwen 阶梯）
$env:ANTHROPIC_BASE_URL = "http://localhost:11434"
$env:ANTHROPIC_API_KEY  = "ollama"          # 任意值即可
$env:AGENT_MODEL        = "qwen3.5:9b"
$env:AGENT_MAX_TOKENS   = "4096"            # 掐断思考螺旋，快速失败
$env:AGENT_TIMEOUT_MS   = "300000"; $env:AGENT_MAX_RETRIES = "0"

# 或 OpenAI wire 协议（任何 chat-completions 端点；key 可与 Anthropic 协议复用）
$env:AGENT_PROVIDER     = "openai"
$env:OPENAI_BASE_URL    = "https://api.deepseek.com"   # 或 api.openai.com 等
$env:OPENAI_API_KEY     = "sk-..."          # 缺省复用 ANTHROPIC_API_KEY
$env:AGENT_MODEL        = "deepseek-chat"

npm run cli -- "阅读 docs/ 下所有文档，生成 SUMMARY.md"          # 交互审批 y/n
npm run cli -- --yes "……"                                        # 自动批准（CI）
npm run cli -- --verify "……"                                     # 完成后 verifier 独立核查，未通过自动返工
npm run cli -- --ask "……"                                        # 允许执行前集中提出 1~4 个选择题（可自由输入）
npm run cli -- --plan "……"                                       # 三角编排：planner 拆解→执行→核查→交接；
                                                                  #   互不依赖的子任务默认并行（auto=min(3,层宽)），--parallel=N 覆盖
npm run eval                                                      # 全量用例回归基线（31 用例，纯产物评分）
npm run lab                                                       # A/B 实验向导：选端点/臂/用例，免拼环境变量
npm run lab -- --last                                             # 重放上一次实验配置
npm run smoke:local                                               # 离线端点冒烟（本地 Ollama 路径存活验证）
npm test                                                          # 单元测试
```

真实 CLI/Web 宿主默认要求 `finish_task` 结构化收尾，`end_turn` 不再直接等于完成。
长任务可用以下总账与恢复参数（PowerShell）：

```powershell
$env:AGENT_TOTAL_MAX_TURNS = "120"          # continuation/返工共用，不会每段重置
$env:AGENT_TOTAL_TOKEN_BUDGET = "500000"    # 执行谱系（main/返工/续跑）的 token 总账
$env:AGENT_PROGRESS_EXTENSION_TURNS = "8"   # 仍有新证据时最多一次有界续跑
$env:AGENT_STAGNATION_WINDOW = "3"          # 连续相同调用+结果后要求换策略
$env:AGENT_MAX_ASK_ROUNDS = "3"             # 打断次数；每次可集中问 1~4 题
```

显式 token 总账按完整模型调用结算：单次在途响应可能自然越过剩余额度；并行子任务会在
同一总账上串行取得调用资格，避免多条轨基于旧余额同时起跑、按并发数放大超支。
**口径要点**：这份总账只约束执行谱系——verifier / planner 各自另建等额的独立预算，
不从此账扣（隔离是有意的：核查断粮会引入新失效形态），带核查的 run 名义总消耗
可达约 3 倍。Web 宿主另有一道宿主级日预算 `AGENT_UI_DAILY_TOKEN_BUDGET`（非
cache_read 口径）：超限后新任务/追问/归档派生一律拒绝准入，在飞任务不受影响，
本地日翻页自动恢复（进程态计数，重启当日归零）。

`--verify` 支持独立的核查模型（核查者应 ≥ 执行者强度，见 A/B 研究结论）：

```powershell
$env:AGENT_VERIFIER_MODEL    = "deepseek-v4-pro"                  # verifier 用的模型
$env:AGENT_VERIFIER_BASE_URL = "https://api.deepseek.com/anthropic"  # 可选，独立端点
$env:AGENT_VERIFIER_API_KEY  = "sk-..."                           # 可选，缺省沿用执行者
npm run cli -- --verify "……"
```

## Web 控制台与跨端 App

浏览器控制台在 [`ui/`](ui/)（`ui/server.ts` + `ui/public`，任务提交 / 事件流直播 /
审批应答 / 核查裁决 / 计划编排确认门 / 产物取件）。桌面端（Electron）与移动端
（Capacitor Android）外壳在 [`cross-app/`](cross-app/)——它是把 `ui/public` 原样
打包成 App 的客户端，连接宿主机上的同一个 Harness UI 服务：

```powershell
npm run ui                              # 浏览器控制台 http://127.0.0.1:4173
cd cross-app
$env:AGENT_UI_URL = "http://127.0.0.1:4173"
npm run desktop                         # Electron 直接加载当前宿主，无复制 UI 漂移
npm run desktop:dist                    # 生产打包；Windows/macOS 缺签名凭据会拒绝
npm run desktop:dist:unsigned           # 只供本机安装测试，不得发布
```

真实编译产物用 `npm run build && npm start` 启动；`npm run pack:check` 会审计发布包
allowlist。非 loopback 监听现在是 fail-closed：必须提供至少 32 字符的
`AGENT_UI_ACCESS_TOKEN`，并声明可信 TLS 反代或显式接受明文风险；远程模式默认从工具面
移除 `bash`。完整 Docker、探针、canary 和回滚步骤见
[`docs/07-production-runbook.md`](docs/07-production-runbook.md)。

PowerShell 中临时清除继承的端点变量要用：

```powershell
Remove-Item Env:ANTHROPIC_BASE_URL, Env:OPENAI_BASE_URL -ErrorAction SilentlyContinue
npm run ui
```

`env -u ...` 是 POSIX shell 命令，在 PowerShell 中不可用。

Web 宿主默认把运行历史写到 `<cwd>/.agent-run-history`（可用
`AGENT_RUN_HISTORY_DIR` 改位置，`AGENT_RUN_HISTORY_KEEP` 改保留数）。完整结束的
单执行者运行会同时保存事件、会话正史、Context 水位与累计总预算。宿主重启后点
「从归档继续」会从检查点**派生一个新运行**：父档案保持只读，正史与总预算延续；
模型、工具、策略与审批规则以当前宿主为准，旧上限与当前上限取更严格者。旧格式档案、
核查/编排运行、预算已耗尽或工作目录不在当前白名单时只允许回看。

`/health` 提供 liveness，`/ready` 在历史写入失败或关停时返回 503，`/metrics`
提供 Prometheus 文本指标（配置访问令牌时同样需要认证）。Android 客户端已禁止明文
HTTP，但在平台凭据存储、签名流水线和 HTTPS 真机验收完成前仍属于实验目标。

## 路线图

- **v0.1 ✅** — 设计文档：分层架构 + 接口契约定稿
- **v0.2 ✅** — 最小可跑闭环：ModelClient + AgentLoop + 3 个内置工具 + compat 模式（第三方兼容端点）
- **v0.3 ✅** — 上下文管理完整化：compact、缓存诊断、动态上下文注入
- **v0.4 ✅** — verifier 子代理 + `runVerified` 编排 + `fetch_url` 领域工具试点 + 评估基线
- **v0.5 ✅** — L5 跨会话记忆：`.agent-memory/` + 四个记忆工具 + 开局索引注入
- **v0.6 ✅** — OpenAI wire 协议：`AGENT_PROVIDER=openai` 接入一切 chat-completions 端点，核心层零改动
- **v0.7 ✅** — MCP 工具接入（`mcp.json` 声明 server，自动适配为 Tool）+ STM32L151 真机调试端到端
- **v0.8 ✅** — harness A/B 研究（eval/ 下 6 份报告）：verifier 正反证据闭环与跨厂商验证、
  真 Git Bash 修复（hard 套件 63%→88%）、逐 run JSONL/transcript 留档、loop 层瞬时错误重试
- **v0.9 ✅** — DomainPack 领域包（五件套：工具面/prompt/核查/护栏/评估）+ `AGENT_PACK` 切换；
  跨包试点闭环：stm32-coding 修固件产出 ELF → stm32-debug 真机烧录四项验收 → verifier 独立连板复核
- **v1.0 ✅** — 计划单元 + 三角编排：planner 只读拆解（JSON 计划契约：子任务×领域包×可程序化验收清单）→ 逐子任务执行→核查→返工 → 交接下游，快速失败；`--plan` 一句话任务真机闭环（planner 自主选包，verifier 独立连板逐条复核 8 项验收）；随后补齐 verifier 只读命令白名单与 router 调度单元（`--auto` 任务→包路由）
- **v1.1 ✅** — 并行编排：`SubTask.dependsOn` 依赖图契约（fail-closed 校验）+ ready-queue 调度器 + 审批互斥门，互不依赖的子任务并发执行（`--parallel`，缺省 auto）。A/B 实证（eval/ab-report-parallel.md）：同 DAG 墙钟 −56~−62% 且精确贴关键路径、token 持平；拆分摇摆（freeform ~50/50，强 planner 无效）由**结构化拆分协议**消除——planner 只枚举分片事实，拆不拆由宿主规则判定（`AGENT_PLAN_PROTOCOL=structured`，拆分率 5/5 零方差）。首个生产交付：本仓库 docs/reference/（案例 #2，墙钟 −43%）
- **后续** — 结构化清单契约扩 deps 字段（统一 fan-out 与顺序链两协议）、server-side compaction、跨域真机任务上的并行编排（见 [docs/04-roadmap.md](docs/04-roadmap.md)）

## 技术基线

- 语言：TypeScript（Node.js ≥ 22）
- SDK：`@anthropic-ai/sdk`（仅用其类型与 HTTP 客户端，agent loop 全部自研）
- 默认模型：`claude-opus-4-8`，adaptive thinking，`output_config.effort` 可配；兼容任何说 Anthropic Messages API 的端点

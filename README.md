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
| [docs/04-roadmap.md](docs/04-roadmap.md) | v0.1 → v0.4 演进路线与每阶段验证 checklist |

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
npm run eval                                                      # 跑 5 用例回归基线
npm run lab                                                       # A/B 实验向导：选端点/臂/用例，免拼环境变量
npm run lab -- --last                                             # 重放上一次实验配置
npm test                                                          # 单元测试
```

`--verify` 支持独立的核查模型（核查者应 ≥ 执行者强度，见 A/B 研究结论）：

```powershell
$env:AGENT_VERIFIER_MODEL    = "deepseek-v4-pro"                  # verifier 用的模型
$env:AGENT_VERIFIER_BASE_URL = "https://api.deepseek.com/anthropic"  # 可选，独立端点
$env:AGENT_VERIFIER_API_KEY  = "sk-..."                           # 可选，缺省沿用执行者
npm run cli -- --verify "……"
```

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
- **v1.0 ✅** — 计划单元 + 三角编排：planner 只读拆解（JSON 计划契约：子任务×领域包×可程序化验收清单）→ 逐子任务执行→核查→返工 → 交接下游，快速失败；`--plan` 一句话任务真机闭环（planner 自主选包，verifier 独立连板逐条复核 8 项验收）
- **后续** — verifier 只读命令白名单、调度 agent（任务→包路由）、server-side compaction（见 [docs/04-roadmap.md](docs/04-roadmap.md)）

## 技术基线

- 语言：TypeScript（Node.js ≥ 22）
- SDK：`@anthropic-ai/sdk`（仅用其类型与 HTTP 客户端，agent loop 全部自研）
- 默认模型：`claude-opus-4-8`，adaptive thinking，`output_config.effort` 可配；兼容任何说 Anthropic Messages API 的端点

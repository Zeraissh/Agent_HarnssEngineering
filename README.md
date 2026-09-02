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
| [docs/08-maturity-optimization-checklist.md](docs/08-maturity-optimization-checklist.md) | 对标成熟 Agent 的分阶段优化清单、优先级与验收证据 |
| [docs/reference/README.md](docs/reference/README.md) | `src/` 全部 21 个模块的参考文档（签名与源码逐一核对；由 v1.1 并行编排自举生成，见案例 #2） |
| [docs/cases/](docs/cases) | 真实任务案例：#1 遥测固件真机闭环、#2 并行编排交付参考文档（墙钟 −43%） |

## 快速开始

```powershell
npm install

# 推荐：复制模板后在编辑器中填写 .env
Copy-Item .env.example .env
```

CLI 没有 `--api-key` 参数；不要把真实密钥写进 argv 或 PowerShell 赋值命令。请在
`.env` 中选择一种端点配置（完整字段与 OCI 配置见 [`.env.example`](.env.example)）：

```dotenv
# Anthropic 官方（默认模型 claude-opus-4-8）
ANTHROPIC_API_KEY=sk-ant-...

# 若改用 OpenAI wire 协议，则设置：
# AGENT_PROVIDER=openai
# OPENAI_BASE_URL=https://api.example.com
# OPENAI_API_KEY=sk-...
# AGENT_MODEL=example-model
```

```powershell
# 静态自检：只读本地配置，不创建模型客户端、不联网、不启动执行 worker
npm run doctor
npm run agent -- run "阅读 docs/ 下所有文档，生成 SUMMARY.md"    # 新入口；交互审批 y/n
npm run agent -- run --yes "……"                                  # 自动批准（CI）
npm run agent -- run --verify "……"                               # 完成后 verifier 独立核查，未通过自动返工
npm run agent -- run --ask "……"                                  # 允许执行前集中提出 1~4 个选择题（可自由输入）
npm run agent -- run --plan --parallel 3 "……"                    # 分离式并行度不会混入任务正文
npm run agent -- --help                                           # 严格参数说明
npm run agent -- --version

# 兼容入口保留；已有脚本无需立即迁移
npm run cli -- --verify "……"
npm run eval                                                      # 全量用例回归基线（31 用例，纯产物评分）
npm run lab                                                       # A/B 实验向导：选端点/臂/用例，免拼环境变量
npm run lab -- --last                                             # 重放上一次实验配置
npm run smoke:local                                               # 离线端点冒烟（本地 Ollama 路径存活验证）
npm test                                                          # 单元测试
npm run test:coverage                                             # 覆盖率 + 棘轮阈值（TEST-01a）
npm run test:mutation-smoke                                       # 8 个关键变异必须变红（TEST-01a）
npm run eval:stats                                                # A/B + 台账统计报告（EVAL-02）
npm run build && npm run eval:deterministic                        # 确定性场景门（EVAL-03a）
npm run eval:compare-baseline                                     # nightly 基线比对（EVAL-03b）
```

`npm run eval:deterministic` 是 PR 级质量门：12 个场景跑在**编译产物** `dist/src/cli.js` 上，
端点是 `eval/mock-provider.ts` 起的 loopback 假端点（脚本队列 + 故障注入），因此**不需要
任何真实 provider 或凭据**，约 11 秒跑完。它守的是单测按设计覆不到的那条缝——进程边界、
退出码、工作目录圈禁、台账落盘，以及 loop ↔ orchestrate 组合起来的失败与恢复路径
（同轮重试 / 段级续跑 / 核查预算收口 / 拒签返工 / 完成门强制 incomplete）。断言只用可数
事实（产物字节、台账字段、模型请求条数），报告落 `eval/deterministic-report.{json,md}`。
`--filter <子串>` 只跑部分场景，`--keep` 保留临时工作目录便于排障。因为它测 dist，
**必须先 `npm run build`**。

Nightly（`.github/workflows/nightly.yml`）跑真实 provider 小子集（6 用例 × baseline × 1），
凭据来自 `ANTHROPIC_API_KEY` secret 与 `ANTHROPIC_BASE_URL`/`AGENT_MODEL` variables；
`AB_TOKEN_CAP` 触顶即停（exit 2），再与 `eval/baselines/nightly.json` 比对通过率/成本/延迟。
阈值经首夜 6/6 证据收紧（`minPassRate=1`、`maxTotalTokens=150k`、`maxTotalWallMs=300s`）。

Release tag 门（`.github/workflows/release.yml` `gate`）在确定性场景门之后，**在打标签的提交上重跑**
同一真实子集，对照 `eval/baselines/release.json`（不得比 nightly 更松），报告落 artifact
`release-quality-eval`。缺少 secret/vars 时 fail-closed，不静默跳过。

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
不从此账扣（隔离是有意的：核查断粮会引入新失效形态），且**每轮核查各计一份**：
带返工时名义总消耗可超 3 倍，计划编排下随子任务数×核查轮数继续放大。Web 宿主
另有一道宿主级日预算 `AGENT_UI_DAILY_TOKEN_BUDGET`（非 cache_read 口径，按每次
模型调用实时落账）：超限后新任务/追问/归档派生/计划批准一律拒绝准入，在飞任务
不受影响，本地日翻页自动恢复（进程态计数，重启当日归零；0 = 今日封盘）。

`--verify` 支持独立的核查模型（核查者应 ≥ 执行者强度，见 A/B 研究结论）：

```powershell
$env:AGENT_VERIFIER_MODEL    = "deepseek-v4-pro"                  # verifier 用的模型
$env:AGENT_VERIFIER_BASE_URL = "https://api.deepseek.com/anthropic"  # 可选，独立端点
$env:AGENT_VERIFIER_API_KEY  = "sk-..."                           # 可选，缺省沿用执行者
npm run cli -- --verify "……"
```

### 端点降级与熔断（可选）

配一个备用端点，主端点在瞬时错误（网络/超时/429/5xx）上耗尽重试后自动换过去再试，
每个端点各带一个熔断器（连败 N 次开路、冷却期内直接跳过、冷却后放一次试探、
成功即闭合）。**不配 `AGENT_FALLBACK_MODEL` 就完全不生效**，也不会多包一层装饰器。

```powershell
$env:AGENT_FALLBACK_MODEL    = "kimi-k3"                      # 配了才启用整条防线
$env:AGENT_FALLBACK_PROVIDER = "anthropic"                    # 可选，anthropic | openai
$env:AGENT_FALLBACK_BASE_URL = "https://api.moonshot.cn/anthropic"  # 可选
$env:AGENT_FALLBACK_API_KEY  = "sk-..."                       # 可选，缺省沿用执行者
$env:AGENT_CIRCUIT_FAILURE_THRESHOLD = "3"                    # 连败几次开路，默认 3
$env:AGENT_CIRCUIT_COOLDOWN_MS       = "30000"                # 隔离多久，默认 30s
```

三条边界写在这里，因为踩上去都不便宜：

- **只覆盖主执行者。** verifier / planner / 视觉模型仍走各自显式配置的端点——
  "核查者应 ≥ 执行者"是一条设计约束（见 A/B 研究结论），静默把核查换到另一家
  会让那条约束在无人知晓时失效。
- **认证失败、400 这类非瞬时错误一律原样上抛。** 换端点救不了配置错误，
  只会把同一个 401 打到第二家去，并掩盖真正的原因。
- **跨端点重发会剥掉 thinking 块**（签名属于上一家），链上端点若能力不同
  （例如备用端点不支持识图）不做校验，请自行确认两家能跑同一类任务。

换端点这件事在两个宿主上都留痕：CLI 打一行 `⇄ 端点降级：A → B`，Web 上是时间线里
一条默认展开的条目 + 装配条上的降级链，台账另记 `fallbackChain` 与 `fallbacks` 次数
（未配置时 `fallbackChain` 是 `null`，与"配了链但零次降级"分得开）。
熔断相关的数值配错会**直接抛错而不是静默取默认**——以为把冷却调成了 5 分钟、
实际仍是 30 秒，这种防线口径与认知不一致就等于没有。

## 在 Cloud Agent 里跑：凭据怎么过去

Cloud Agent 跑在远端 VM，读不到你本机的 `.env`。配置分两半走：

- **非敏感项**（端点、视觉模型）提交在 [`.env.cloud`](.env.cloud) 里，云端自动生效，
  不需要人工填任何东西；
- **密钥**只能经 Cursor 的 Environment Secrets 走，填【与本地 `.env` 同名】的变量。

新 Agent 启动时由 [`.cursor/environment.json`](.cursor/environment.json) 的 `start`
调用 [`scripts/cloud-sync-env.sh`](scripts/cloud-sync-env.sh)，把两半合成工作区
`.env`（0600），同名 Secret 覆盖 `.env.cloud` 的默认值。当前配置下需要人工填的
Secret 只有 `ANTHROPIC_API_KEY` 一项。

本机可以先算出"还差哪几个"：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/sync-local-env-to-cloud.ps1
# 已知环境 ID 时直接开到该环境的设置页
powershell ... -EnvironmentId "<Agent 面板 Environment 卡片里的 ID>"
```

它会逐项比对本机 `.env` 与仓库 `.env.cloud`，把已覆盖的标成「无需填」，只把真正
缺的列成待办；密钥类变量永远算待办（不进 `.env.cloud`）。

三个会让人白等一轮的坑：

- **Secrets 只对 Agent 实际启动的那个环境生效。** 环境每次跑 Setup 流程都会新建一个，
  填到旧环境上不会注入。以 Agent 面板右侧 Environment 卡片显示的 ID 为准。
- **注入发生在新 Agent 启动时。** 已经在跑的 Agent 不会拿到，改完必须重开一个。
- **同步范围 = 示例文件里声明过的变量名**（`.env.example` / `.env.production.example`
  的注释行同样算声明）+ `.env.cloud` 的键。没被收录的变量用
  `AGENT_CLOUD_ENV_EXTRA_KEYS=A,B` 显式放行——这道白名单是有意的，否则云端一堆
  无关环境变量都会被写进 `.env`。

`start` 日志里会打印命中的变量【名】与计数（绝不打印值）；一个 Secret 都没拿到时
会连同排查清单一起告警。落地后 `npm run doctor` 应显示 `credential_present: yes`。

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

Desktop 自管本地宿主时，可从应用菜单打开 **设置 → 模型与运行设置…**（`Ctrl/Cmd+,`），
配置 API 协议、模型、Base URL、API key 以及 token/超时/重试/并发护栏。API key 由
Electron `safeStorage` 交给操作系统凭据系统加密，配置文件不会保存明文，远程 Harness
网页也拿不到密钥；保存后桌面壳会重启本地宿主。若通过 `AGENT_UI_URL` 或已有服务进入
attach 模式，该窗口只读，模型配置应在外部宿主完成。

真实编译产物用 `npm run build && npm start` 启动；`npm run pack:check` 会审计发布包
allowlist。非 loopback 监听现在是 fail-closed：必须提供至少 32 字符的
`AGENT_UI_ACCESS_TOKEN`，并声明可信 TLS 反代或显式接受明文风险；远程模式默认从工具面
移除 `bash`。即使显式开启远程执行，也必须同时使用
`AGENT_EXECUTION_ISOLATION=required`；OCI 功能探测、固定安全 profile 或镜像任一不可用时，
`/ready`、新任务和续跑准入均 fail closed，绝不回退宿主。内嵌 OCI adapter 只支持 Linux
直宿主：Docker CLI 必须使用管理员固定的绝对真实路径并同时固定 SHA-256，daemon 只接受
root 管理的本机 Unix socket，并配置稳定且部署唯一的 `AGENT_EXECUTION_OCI_NAMESPACE`；Windows/macOS 需要后续独立 Broker 服务。CLI/loopback 的缺省 `report` 只是迁移
模式：命令仍在宿主执行，CLI、Tools 面和 tool result 都会明确标记“未隔离”。当前 OCI 纵切
只覆盖 `bash`，命令正文经 stdin 先全量落到 worker 私有 tmpfs，再以 fd0=EOF 执行，
不进入 Docker argv/`Config.Cmd`；每次执行重跑 runtime/profile 与实际 workdir canary，
每个对话 segment 收尾立即销毁 broker，follow-up 必须新建并重探针。ADR-002 的 daemon-resident
schema-3 lease/reaper 会在每次 probe 前校验 namespace/ownership/租期，只按 full container ID
回收“已到期且 boot-id/PID-namespace/PID starttime 证明 owner 已死亡”的 orphan；名称复用、owner 存活性未知、畸形 tombstone 或清理无法确认时，per-run canary 前后双闸门都会
停止新准入。没有后续 probe 时它不是 autonomous TTL。状态仍最多是 `partial`；独立 timer/Broker、MCP gateway 与逐 run worktree/UID lease 完成前
SAFE-05 不会标记完成。架构取舍见
[`ADR-001`](docs/adr/ADR-001-execution-isolation.md) 与
[`ADR-002`](docs/adr/ADR-002-durable-oci-worker-leases.md)。完整 Docker、探针、canary 和回滚步骤见
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
模型、工具与策略以当前宿主为准，旧上限与当前上限取更严格者。检查点中的短期审批
grant 仅作审计，不是可恢复的执行权限；新运行会记录未继承原因并重新询问。旧格式档案、
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

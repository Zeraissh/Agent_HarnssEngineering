# Agent_Design — Harness Engineering 智能体框架

版本 **1.3.0**（根 `package.json` 与 `src/cli-args.ts` 的 `CLI_VERSION`）。发布仓 [Zeraissh/Agent_HarnssEngineering](https://github.com/Zeraissh/Agent_HarnssEngineering)。

一个从零手写的智能体（agent）框架，TypeScript 实现，直接构建在 Anthropic Messages API 之上。

## 三面：Web / CLI / 桌面

| 面 | 命令 | 现在实际进哪 |
|---|---|---|
| **Web** | `npm run ui` | `ui/serve.ts`，默认 `http://127.0.0.1:4173`（`AGENT_UI_PORT` / `PORT`）。页标题与桌面对齐：首页 `FATHOM`、对话 `FATHOM · 对话` |
| **CLI** | `npm run agent -- …`（`npm run cli` 同入口） | `src/cli.ts`。用法：`npm run agent -- --help` |
| **桌面** | `npm run desktop` | Electron 壳：本机 4173 已健康就贴上；没有就拉起当前 `ui/serve.ts`。窗框首页 `FATHOM`、对话 `FATHOM · 对话`。**没有开始菜单项**。详见 [`cross-app/README.md`](cross-app/README.md) |

编译产物：`npm run build && npm start`（`dist/ui/serve.js`）。静态自检：`npm run doctor`（不联网）。

### 权限默认与页面上的字（已落地）

- **CLI**：不加 `--yes` 时 ask 级要确认。非 TTY 印「需要确认，请加 `--yes`」，退出码 2，不摔 readline。`--yes` 横幅跟真实档位（`yes=true` / 会自动放行）。`--resume-run` 读不到检查点就停，印原任务/终态，不当新任务重开。`run --help` 可用；顶层帮助写用 `AGENT_MODEL` 换模型。`--plan`：TTY 出计划后问「开跑？ [y/N]」（可改一行标题）；非 TTY 无 `--yes` 退出码 2、印「需要确认，请加 `--yes`」。帮助不再写「没有计划确认门」。`permission: deny`、圈禁、SSRF **打不穿**。
- **Web 服务端**：`WEB_DEFAULT_AUTO_APPROVE = false`，`WEB_DEFAULT_PERMISSION_MODE = "manual"`；`GET /api/harness.defaults.autoApprove === false`。Work 没点稿件芯片不再 409，直接建 run。4xx / 429 正文走人话，不甩 HTTP / 领域包 / `Mutation rate limit`（429：「前面还有人在交，请等几秒。」）。计划确认门：`POST /api/runs/:id/plan-approval` 的 `edits` 只写活计划的 `title` / `description`，再按改过的计划执行。门上点停止 → `stopReason=aborted`（「已停止」），不是否决；否决按钮才是 `plan_rejected`。
- **Web 页面（`ui/public`）**：默认 Work 脸。浏览器标签首页 `FATHOM`、对话 `FATHOM · 对话`，不再写「FATHOM 控制台」。发送按钮和 label「发送」，占位「说要做什么…」（选了稿件标题时「要「标题」做什么…」）。「自动放行」默认不勾，说明「默认先问；勾上才自动放行」。独立核查在「运行设置」里，不挂发送栏。新手卡 1/4「打一句话，回车」；写入圈在设置「只能改这些文件夹」；3/4「需要时再开运行设置」，不再点名领域包 / 计划编排 / 独立核查。批准卡主文案「要新建或改 …」，按钮「允许」「拒绝」。有写盘不出现「本次运行没有写盘操作」；有本场文件不说「还没有产物」。停→「已停止」；完成→「运行已完成」；否决→「计划未获批准」。计划门上点停止也是「已停止」（不是否决）；否决按钮才是否决；停/否决后不再钉「批准并开跑」。计划卡叫「计划」，提问卡叫「助手」。失败条（含 composer 以外：删除 / 停止 / 上传 / 设置等）429/HTTP/领域包改成一句人话，不自拼「提交失败（HTTP …）」。计划确认门可改子任务标题/短说明（只这两项）。`@` 列出圈禁内工作区文件/目录，插入 `@path`（目录带尾 `/`）；带 `q=` 按文件名检索（适度深度，不是完整 IDE 树）；`#` `/` `$` 仍不吃。「引用会话」仍是旧对话。正文未到时直播条跟 `thinking_delta`（「正在想…」+ 思考尾）；delta 仍不进时间线。产物画廊空态不写「还没有产物」。有落盘产物的 `incomplete` 收尾条/徽章走黄「页面已写出，模型没签字」，空跑仍红；`classifyStopReason("incomplete")` 仍是 bad。`■ incomplete` 仍红，有写出文件时 CLI 加黄注「已写 N 个文件，未签字」。设计包失败遮罩须 `[hidden]{display:none!important}` 或成功后摘 DOM；三维 starter `templates/design/webgl-object/`。侧栏「全部项目」默认勾上；勾选 vs 设为主说人话（点名=下次写入这里，勾选=这次也可以读写）。空态「现在只能在这个窗口下指令。」「输入 @ 可按文件名找这个文件夹里的文件。旧对话用「引用会话」。」；GitHub 没连不给假开 PR。对话有来源表 +「导出链接列表」；领域包「consult · 查资料」。侧栏顶栏 / 指挥中心：「今日 $」/「这次 $」。预览走页内坞/浮层，不跳 `file://`。

评测怎么读：[`eval/persona-ux/README.md`](eval/persona-ux/README.md)。walks / VERIFY 仍是改前活页，不是「问题已消失」。

### 诚实边界

- 本地单操作员控制台，不是 IDE 插件，也不是飞书/微信入站网关。空态写「现在只能在这个窗口下指令。」
- GitHub / 飞书在设置 → MCP；Web **默认不连** MCP，要 `AGENT_UI_MCP=1`。没连 GitHub 只说「现在只会改这个文件夹」，不给开 PR。
- 工具写入圈在工作目录白名单内。Android 仍是实验客户端。
- 运行历史落到 `<cwd>/.agent-run-history`（`AGENT_RUN_HISTORY_DIR` / `AGENT_RUN_HISTORY_KEEP`，缺省保留 50）。

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
| **Verification** | 独立上下文的 verifier：三值裁决（客观 fail-closed / `unverified` / `advisory`）；返工只由客观 issues 驱动 |

## 文档导航

| 文档 | 现在当什么用 |
|---|---|
| [docs/README.md](docs/README.md) | 活交接 vs 结案档案怎么分 |
| [docs/06-backlog.md](docs/06-backlog.md) | **第一屏才是开工交接**；后面大段是已关闭档案 |
| [docs/08-maturity-optimization-checklist.md](docs/08-maturity-optimization-checklist.md) | 工程成熟度台账（`[x]` / `[~]` / `[ ]`） |
| [docs/07-production-runbook.md](docs/07-production-runbook.md) | 单操作员生产部署 / 回滚 |
| [docs/permission-modes.md](docs/permission-modes.md) | 权限三档对照 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更（当前 1.3.0 + Unreleased） |
| [eval/persona-ux/README.md](eval/persona-ux/README.md) | 2026-09-14 人格走查：怎么读，不要改写成已修复 |
| [docs/01-philosophy.md](docs/01-philosophy.md) | 设计哲学（档案，不当操作手册） |
| [docs/04-roadmap.md](docs/04-roadmap.md) | v0.1–v1.1 路线档案；**不是**现在的开工清单 |
| [docs/05-findings.md](docs/05-findings.md) | 研究结论档案，不重写 |
| [docs/cases/](docs/cases) | 真实任务案例 #1–#11 结案档案 |
| [docs/reference/README.md](docs/reference/README.md) | 2026-08 的 `src/` 签名快照（当时写「21 个模块」；现在 `src/*.ts` 已远多于此） |

## 快速开始

```powershell
npm install

# 推荐：复制模板后在编辑器中填写 .env
Copy-Item .env.example .env
```

CLI 没有 `--api-key` 参数；不要把真实密钥写进 argv 或 PowerShell 赋值命令。请在
`.env` 中选择一种端点配置（完整字段与 OCI 配置见 [`.env.example`](.env.example)）：

```dotenv
# ① Anthropic 官方 Messages API（sk-ant-...；不是 Claude.ai 网页/consumer 账号）
ANTHROPIC_API_KEY=sk-ant-...
# AGENT_MODEL=claude-opus-4-8

# ② 第三方 Anthropic 兼容（DeepSeek / Kimi 等：各自的 key + BASE_URL）
# ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
# ANTHROPIC_API_KEY=sk-...
# AGENT_MODEL=deepseek-v4-flash

# ③ OpenAI wire 协议
# AGENT_PROVIDER=openai
# OPENAI_BASE_URL=https://api.example.com
# OPENAI_API_KEY=sk-...
# AGENT_MODEL=example-model
```

```powershell
# 静态自检：只读本地配置，不创建模型客户端、不联网、不启动执行 worker
npm run doctor
npm run agent -- run "阅读 docs/ 下所有文档，生成 SUMMARY.md"    # 新入口；交互审批 y/n
npm run agent -- run --yes "……"                                  # 自动批准 ask（CI / 非 TTY）
npm run agent -- run --verify "……"                               # 完成后 verifier 独立核查，未通过自动返工
npm run agent -- run --ask "……"                                  # 允许执行前集中提出 1~4 个选择题（可自由输入）
npm run agent -- run --plan --parallel 3 "……"                    # TTY 出计划后 y/n（可改一行标题）；非 TTY 须 --yes
npm run agent -- run --plan --resume-run cli-123                 # 半截 DAG 续发射（至少一枚 passed；预算耗尽则拒）
npm run agent -- run --resume-run cli-123                        # 有已提交检查点才热续；飞行中杀掉不能接着工具
npm run agent -- --help                                           # 与 src/cli-args.ts cliHelpText() 同源
npm run agent -- run --help                                       # 子命令看用法（不再互斥报错）
npm run agent -- --version

# 兼容入口保留；已有脚本无需立即迁移
npm run cli -- --verify "……"
npm run eval                                                      # research 基线（eval/cases.ts，31 条，纯产物评分）
npm run lab                                                       # A/B 实验向导：选端点/臂/用例，免拼环境变量
npm run lab -- --last                                             # 重放上一次实验配置
npm run smoke:local                                               # 离线端点冒烟（本地 Ollama 路径存活验证）
npm test                                                          # 单元测试
npm run test:coverage                                             # 覆盖率 + 棘轮阈值（TEST-01a）
npm run test:mutation-smoke                                       # 固定清单关键变异必须变红（TEST-01a）
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

Nightly（`.github/workflows/nightly.yml`）跑 **held-out** 真实 provider 小子集
（`AB_SUITE=heldout`，6×`ho-*` × baseline × 1），凭据来自 `ANTHROPIC_API_KEY` secret 与
`ANTHROPIC_BASE_URL`/`AGENT_MODEL` variables；`AB_TOKEN_CAP` 触顶即停（exit 2），再与
`eval/baselines/nightly.json` 比对通过率/成本/延迟。阈值经首夜 research 6/6 证据收紧后沿用
到 held-out（`minPassRate=1`、`maxTotalTokens=150k`、`maxTotalWallMs=300s`）。
研究臂默认 `AB_SUITE=research`（`eval/cases.ts`）——**不是** held-out，禁止拿它当冻结评测面。

Release tag 门（`.github/workflows/release.yml` `gate`）在确定性场景门之后，**在打标签的提交上重跑**
同一 held-out 子集，对照 `eval/baselines/release.json`（不得比 nightly 更松），报告落 artifact
`release-quality-eval`。缺少 secret/vars 时 fail-closed，不静默跳过。发布流程本身：门禁全过 →
镜像构建 + `/health` 烟测 + OCI canary → 推 GHCR → GitHub Release 记录 digest 并附 `CHANGELOG.md`
对应小节；Windows 签名凭据（`WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`）缺失时 `desktop-windows` 跳过，
**不发布未签名安装包**。手动触发（`workflow_dispatch`）是预演：同一门禁与镜像构建，不推送、不建 Release。

真实 CLI/Web 宿主默认要求 `finish_task` 结构化收尾，`end_turn` 不再直接等于完成。
长任务可用以下总账与恢复参数（PowerShell）：

```powershell
$env:AGENT_TOTAL_MAX_TURNS = "120"          # 可选。不设则不武装轮次硬顶
$env:AGENT_TOTAL_TOKEN_BUDGET = "2000000"   # 可选。执行谱系 token 总账（不含 cache_read）；不设则不武装
$env:AGENT_PROGRESS_EXTENSION_TURNS = "8"   # 仍有新证据时最多一次有界续跑（0 = 关）
$env:AGENT_STAGNATION_WINDOW = "3"          # 连续相同调用+结果后要求换策略
$env:AGENT_MAX_STAGNATION_RECOVERIES = "1"  # 换策略几次后仍停滞就强制收口
$env:AGENT_MAX_ASK_ROUNDS = "3"             # 打断次数；每次可集中问 1~4 题
```

恢复三参数逐字段按 **env > 领域包 `recovery` > 默认** 解析（同核查 / planner 预算的口径）；
CLI 启动行与 Web 的 `run_config` / `/api/harness` 都报出生效值与来源。

显式 token 总账按完整模型调用结算，但**不含 cache_read**（与日预算 / 成本告警同口径）：
长对话每轮重读缓存上下文不再把谱系额度吃光。单次在途响应可能自然越过剩余额度；
并行子任务会在同一总账上串行取得调用资格，避免多条轨基于旧余额同时起跑、按并发数放大超支。
真实宿主**不再默认** 120 轮 / 200 万——未设这两条 env 则不武装，避免长对话被自己的缺省卡死（`ui/server.ts` 注释与 `.env.example` 同口径）。设了之后续跑仍用同一份总账。
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
# $env:AGENT_VERIFY_MAX_TURNS = "15"                              # 可选。env > 包 verify.maxTurns > 默认 15
npm run agent -- run --verify "……"
```

`--resume-run` **已落地**：读不到检查点就停，印原任务/终态，不当新任务重开（`formatCliResumeStop`）。2026-09-14 评测当时会从任务正文重开（VERIFY #15）——那是档案，不是现在的行为。

### 设计模式

「设计模式」是进入 HTML 设计台的**推荐入口**（文案用这个名字，不用 OpenDesign 当产品名）。后端仍是现有 `design` 领域包，工具面不另扩权。旧入口 `AGENT_PACK=design` / `AGENT_PRESET=design` 永久保留：未设 `AGENT_MODE=design` 时 CLI 会提示改用设计模式，不中断、不改包。Web 选包下拉仍在。

| 入口 | 用法 |
|---|---|
| CLI（推荐） | `AGENT_MODE=design`（与 `AGENT_PACK` 同时出现时显式包优先；与 `--plan` 同用时 `--plan` 优先） |
| Web UI（推荐） | 会话空态的「设计模式」入口；进入后是统一输入框 + 页签/模板 chip，不是必经侧栏清单 |
| 旧入口 | `AGENT_PACK=design`（`AGENT_PRESET` 别名）仍按显式选包跑；无 `AGENT_MODE` 时只多一行提示 |

多页幻灯的 PowerPoint 由宿主从 HTML 派生（画布「导出 PowerPoint」）；PDF 仍走打印路径。类型菜单是本仓库注册表（Open Design README 逐条表 + `3d-object`），不是把外部插件目录搬进仓库。拍板口径见 [docs/10-design-mode-evolution.md](docs/10-design-mode-evolution.md)。

### 端点降级、熔断与能力探针（可选）

配一个备用端点，主端点在瞬时错误（网络/超时/429/5xx）上耗尽重试后自动换过去再试。
熔断器按**端点身份**（provider|model|baseURL）登记：同一物理端点在角色之间诚实共享
健康状态，不同身份互不误伤。**不配 `AGENT_FALLBACK_MODEL` 就完全不生效**。

```powershell
$env:AGENT_FALLBACK_MODEL    = "kimi-k3"                      # 配了才启用执行者链
$env:AGENT_FALLBACK_PROVIDER = "anthropic"                    # 可选，anthropic | openai
$env:AGENT_FALLBACK_BASE_URL = "https://api.moonshot.cn/anthropic"  # 可选
$env:AGENT_FALLBACK_API_KEY  = "sk-..."                       # 可选，缺省沿用执行者
$env:AGENT_CIRCUIT_FAILURE_THRESHOLD = "3"                    # 连败几次开路，默认 3
$env:AGENT_CIRCUIT_COOLDOWN_MS       = "30000"                # 隔离多久，默认 30s
$env:AGENT_FALLBACK_ROUTING          = "prefer_healthy"       # 可选；缺省 sequential
# 角色自有链或继承执行者备用端点（不会静默共用执行者的装饰器实例）：
# $env:AGENT_VERIFIER_FALLBACK_MODEL = "…"
# $env:AGENT_VERIFIER_FALLBACK = "inherit"   # 或 planner / vision
# 能力探针（compat 不再只靠 claude-* 名称）：显式 AGENT_MODEL_PROBE=1 才打
# （loopback 也不自动开——会吃掉确定性 eval 的 mock 脚本）
# $env:AGENT_MODEL_PROBE = "1"
# $env:AGENT_MODEL_PROBE_TTL_MS = "300000"
```

边界：

- **角色默认不进执行者链。** 要给核查者/planner/视觉保底，须显式
  `AGENT_<ROLE>_FALLBACK_MODEL` 或 `=inherit`——静默继承会让「核查者应 ≥ 执行者」
  在无人知晓时失效（A/B 研究结论）。
- **认证失败、400 一律原样上抛。** 换端点救不了配置错误。
- **跨端点重发会剥掉 thinking 块。** 能力探针可区分 compat/native，但成本/延迟
  路由仍是 stub（`prefer_healthy` 只按粘性健康位跳过，不是计价器）。
- **探针 fail-open：** 失败或未触发 → 退回名称猜测；全链不健康仍允许尝试。

换端点在两个宿主上都留痕：CLI `⇄ 端点降级`，Web 时间线 + 装配条；台账记
`fallbackChain` / `fallbacks`（未配置时 `fallbackChain` 为 `null`）。

### 上下文窗口（事实）与压缩预算（策略）

这是两件事，此前是一个数：

- **窗口** = 端点在多大处拒收。四级来源 `AGENT_CONTEXT_WINDOW` > **learned**（撞过一次
  context-too-long 400 后从报文里学到，按 `provider|model|origin` 记进
  `.agent-capabilities.json`，TTL 30 天）> **registry**（`src/model-windows.ts`，
  每条都带出处）> **未知**。不认识的模型不猜数——猜大了上限虚高照样 400，猜小了白白压缩。
- **压缩水位** = 我们在多大处压缩。无覆盖时窗口已知就跟可用窗口走
  （`窗口 − maxTokens − 边际`）；窗口未知才回落 150k。`AGENT_CONTEXT_LIMIT` /
  逐 run / 领域包只用来**提前**压缩。边际 = `max(4k, 2%)`。
  日消耗封顶（`AGENT_TOTAL_TOKEN_BUDGET`、UI 日账本）是另一道闸，跟这里无关。

```powershell
$env:AGENT_CONTEXT_LIMIT  = "400000"   # 可选：提前压缩。不设则跟窗口
$env:AGENT_CONTEXT_WINDOW = "1048576"  # 窗口（事实）：只在自动解析不对时才需要手填
```

两个宿主都把这两个数**各带来源**报出来，不合并成一个百分比：

- **CLI** 启动行 `上下文：水位 963k（跟窗口） / 窗口 1,048k（来源：learned）`（或 `窗口未知`）；
  被夹紧另起一行 ⚠ 并写明原值；压缩行带「学到窗口 …（下次运行生效）」。
- **Web** 提交表单有「上下文预算」控件（区间 `[32k, 上限]`，越界 **400 并报出区间**，
  不静默夹紧；填超过 200k 给成本忠告，不阻断）；水位条是三段——已用 / 预算 / 窗口，
  窗口未知时不画那一段而直说「窗口未知」；到预算的 80% 直说「下一轮将压缩」；
  `run_config` 与 `/api/harness` 的 `context` 字段是这些数字的唯一来源。
- **台账** 每行记 `context { window, windowSource, budget, budgetSource }`，
  `npm run ledger` 出来源直方图——"我们平均在窗口的几分之几处压"从此可查。

### 项目约定：AGENT.md（指导，不是执行）

领域包纪律仍活在 `DomainPack.systemPrompt` 里（改一条要发版）。项目或个人约定用纯文本 Markdown，可审阅、可进版本控制：

| 层 | 路径 |
|---|---|
| 用户全局 | `~/.agent/AGENT.md` |
| 项目 | `<workdir>/AGENT.md`、`<workdir>/.agent/AGENT.md` |
| 规则 | `<workdir>/.agent/rules/*.md` |
| 子目录 | 勾选的额外目录若在项目内，沿路径收集各层 `AGENT.md` |

文件不存在 = 机制不存在。注入进**首条 user 消息**，不进 system prompt，所以它**不能推翻领域包纪律，也不能授予或撤销工具权限**。确定性仍靠 permission 规则与圈禁。加载总量默认 16k 字符，超限会截断并告警（`AGENT_MD_MAX_CHARS`，非法值启动失败）。CLI 启动行与 Web Context 卡会列出实际加载了哪些文件，并写明「指导不是执行」。

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

浏览器页标题与桌面窗框同一套：首页 `FATHOM`、对话 `FATHOM · 对话`（设置 / 指挥中心 / 产物 / 定时任务 / 消耗同款前缀）。控制台在 [`ui/`](ui/)
（`ui/server.ts` + `ui/public`：提交 / SSE / 审批 / 核查 / 计划确认门可改短句 / 产物页内预览）。
桌面端（Electron）与移动端（Capacitor Android）外壳在 [`cross-app/`](cross-app/)——
连接同一套宿主，不是另一套执行引擎。开发入口 `npm run desktop`；**现在没有开始菜单项**：

```powershell
npm run ui                              # 浏览器控制台 http://127.0.0.1:4173
npm run desktop                         # Electron：无宿主则用 ui/serve.ts + tsx 拉起当前 Web UI
cd cross-app
npm run desktop                         # 同上（从外壳目录启动）
npm run desktop:dist                    # 生产打包；Windows/macOS 缺签名凭据会拒绝
npm run desktop:dist:unsigned           # 只供本机安装测试，不得发布
```

桌面壳入口顺序：`AGENT_UI_HOST_ENTRY`（文件必须存在，否则 fail-closed）>
仓库 `ui/serve.ts` + `tsx`（源码是当前事实）> `dist/ui/serve.js`。
陈旧 dist 不会静默顶包。若 4173 已有旧宿主，会 attach 到它——要最新界面就先停掉旧进程，或不要设 `AGENT_UI_URL`。
Office 文件（`.pptx` / `.docx`）在宿主里预览 + 点评 + 对话改稿，不是另一套产品。

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
grant 仅作审计，不是可恢复的执行权限；新运行会记录未继承原因并重新询问。预算已耗尽、
领域包不存在或工作目录不在当前白名单时只允许回看；无检查点的旧档案可派生一次"无正史
的新一轮"（`run_forked.checkpoint = null` 照实说）。

**对话语义（会话中心化）**：一个运行就是一场对话，一轮出错只结束那一轮——执行阶段
就失败的、按了停止的、核查未通过的、走了计划编排的，都能在同一个运行上继续追加。
核查是**每一轮**的选项（追加时可勾/不勾，缺省沿用上一轮）；续跑接执行者最后一段
正史（返工过就接返工段），裁决留在对话里并标明"判第 N 轮对话"，**只对它核查的那一轮
负责**，下一轮的执行者会收到上一轮裁决的摘要。计划编排的运行续的是对话不是 DAG：
下一轮以计划摘要（子任务 / 结局 / 交接 / 裁决）为背景按单执行者跑。唯一会挡住追加的
结构性原因是执行谱系总预算耗尽，提示会写明该提哪个环境变量。

`/health` 提供 liveness，`/ready` 在历史写入失败或关停时返回 503，`/metrics`
提供 Prometheus 文本指标（配置访问令牌时同样需要认证）。Android 客户端已禁止明文
HTTP，但在平台凭据存储、签名流水线和 HTTPS 真机验收完成前仍属于实验目标。

## 路线图

- **v0.1 ✅** — 设计文档：分层架构 + 接口契约定稿
- **v0.2 ✅** — 最小可跑闭环：ModelClient + AgentLoop + 3 个内置工具 + compat 模式（第三方兼容端点）
- **v0.3 ✅** — 上下文管理完整化：compact、缓存诊断、动态上下文注入（后演进 MEM-01 语义账本，见 docs/08）
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
- **v1.3.0 ✅** — 见 [CHANGELOG.md](CHANGELOG.md)。当前活交接是 [docs/06-backlog.md](docs/06-backlog.md) 第一屏与 [docs/08](docs/08-maturity-optimization-checklist.md)，不是下面「更远」那几条。
- **后续（04 档案里的「更远」）** — 不要当本周开工清单；UX 修复见 [`eval/persona-ux/`](eval/persona-ux/README.md)

## 技术基线

- 语言：TypeScript（Node.js ≥ 22）
- SDK：`@anthropic-ai/sdk`（仅用其类型与 HTTP 客户端，agent loop 全部自研）
- 默认模型：`claude-opus-4-8`，adaptive thinking，`output_config.effort` 可配；第三方兼容与 OpenAI wire 见下节，不支持 Claude.ai consumer / 浏览器端点

## 端点兼容性与 API 支持

L0 只认三类端点（完整字段见 [`.env.example`](.env.example)）：

1. **Anthropic 官方** Messages API（`sk-ant-...`，`ANTHROPIC_BASE_URL` 留空）。官方协议是一等公民。
2. **第三方 Anthropic 兼容**（DeepSeek、Kimi、GLM、Ollama 等）：各自的 key + `ANTHROPIC_BASE_URL`，按 Messages 协议工作。本仓库长期用 DeepSeek 兼容端点做研究与真机任务；Kimi 做过跨厂商核查。各厂商自己的 ToS。
3. **OpenAI wire**（`AGENT_PROVIDER=openai`）：chat-completions 端点。密钥必须显式填写，不跨 provider 隐式复用。

**不支持**用 Claude.ai consumer 网页账号、浏览器会话或未公开的网页端点当 API。那条路未实现，也不符合 Anthropic 对 consumer 产品的使用条款。

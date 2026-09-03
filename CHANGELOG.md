# 变更日志

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。每一条都对应仓库里的真实提交（括号内为短 SHA，
`git show <sha>` 可查全文）；条目按领域分组，只记用户可见的变化，评审回收 / 测试加固合并进所属条目。

发布方式：推 `vX.Y.Z` 标签触发 [`.github/workflows/release.yml`](.github/workflows/release.yml)，
门禁全过后推 GHCR 镜像，GitHub Release 正文记录镜像 digest 与本文件对应小节。
已推上去的 tag 不移动、不删除；发布失败就修 main 再打下一个补丁号。

## [Unreleased]

### 循环与上下文（Loop & context）

- **领域包可声明恢复策略**：`DomainPack.recovery`，逐字段三级解析 env > 包 > 默认（8 / 3 / 1），
  新增 `AGENT_MAX_STAGNATION_RECOVERIES`；CLI 启动行、Web `run_config` / `/api/harness` 报生效值 +
  逐字段来源 + `armed`（完成门关着时明说 loop 不读）。暂未给任何包填数——台账里的 max_turns 全部
  发生在恢复机制落地之前，数字等实测。
- **台账「终止原因 × 包」**：`npm run ledger` 新增终止原因 × 包表、max_turns 明细（用了多少轮 vs 单段护栏，
  比值按段归一）与恢复触发计数；台账行新增 `maxTurns` / `recoveryPolicy` / `recovery`，老行仍可读并按
  「推算 / 未知」标注；Web 裸跑的 `turns` 不再恒 null。
- **MEM-01 Phase C：分级压缩 + 反应式压缩**。① 单个 tool_result 进正史前按 `AGENT_TOOL_RESULT_MAX_CHARS`
  （默认 40k）截断并附分页提示——MCP 返回无上限的兜底；② tier 2：tier 1 置换后估算仍在水位上时，把保护窗外的
  旧轮折叠成一个 `[compacted_turns]` 摘要块（配对不拆、幂等、只合并不二折）；③ 端点 context-too-long 400
  （Anthropic「prompt is too long」/ OpenAI `context_length_exceeded`）不再直接报错：忽略水位硬压缩后重发同一轮，
  仍超长才以 `context_overflow` 分类收尾。  `compaction` 事件新增 `collapsedTurns` / `reactive`，CLI 与 Web 同步显示；
  mock provider 新增 `context_overflow` 故障与确定性场景。真端点复核（deepseek-v4-flash，窗口实测 1,048,576）：
  兼容路由回 OpenAI 信封且 `code` 只是 `invalid_request_error`，识别靠 message；该真实形状已逐字加锁；
  CLI 真跑一次 987k+64k 撞 400 → 反应式压缩 → 重发 107k → 完成。

### 核查（Verification）

- **无领域包运行的核查者拿通用只读缺省**（委托方批准的例外）：13 条 ls / cat / head / tail / wc / grep / stat /
  od / diff / git 只读四件，仍经重定向 / 链式 / 命令替换拦截；有包就用包的，包未声明也不补；
  `AGENT_VERIFY_READONLY_COMMANDS` 可替换缺省（同样只对无包运行）。CLI 启动行与 Web `run_config` / `/api/harness`
  报生效列表与来源。此前无包核查者连 `cat` 都被拒（3 行文件核查 7 轮 / 153 s 落 unverified）。

### 工具（Tools）

- **修复：Windows 宿主下 bash 子进程丢掉父进程 PATH**（d565e7a）。1.3.0 起（回归自 1653b7b）bash 工具
  子进程只剩 Git usr/bin，`node` / `git` / `python` 一律 "command not found"；根因是 `{ ...process.env }`
  展开后键名为 `Path`，而代码新建了第二个 `PATH` 键、spawn 时后者胜出。现在按大小写不敏感写回原键。
  CI（ubuntu）与 vitest worker（键已规范为 `PATH`）都碰不到这条路径，由 EVAL-01 基线 transcript 回放发现。

### 评估（Eval）

- **EVAL-01 held-out 全量基线（v1.3.0）**：25 条 `ho-*` × 3 rep，`deepseek-v4-flash` × `baseline`，75/75；
  `eval/baselines/heldout-v1.3.0.json` + `eval/heldout-report-v1.3.0.md`（含非失败形态的 transcript 归因、
  nightly 地板建议；地板未动）。
- 修复 `eval/stats.ts` 读不到 A/B 行墙钟：`ab.ts` 落的是 `wallMs`，stats 只认 `durationMs`，
  wall p50/p95 此前恒为 "—"（6d7ee55）。

## [1.3.0] - 2026-09-03

### Web 宿主与对话（Web host & conversation）

- **会话中心化：封的是裁决范围，不是对话**（0867d0d、5e5e7b4）。此前开了核查 / 走了计划编排 /
  执行阶段失败的运行一律 409、只能新开；现在一轮出错只结束那一轮，核查成为**逐轮**选项
  （`POST /messages` 带 `verify`，缺省沿用上一轮），裁决带 `judgedTurn` 只对它核查的那一轮负责，
  下一轮执行者收到上一轮裁决摘要；计划编排的运行也可追加（以计划摘要为种子按单执行者跑）；
  归档派生同口径。唯一结构性阻断 = 执行谱系预算耗尽（提示带 env 名）。
- 停止按钮修复：中止后同一轮里串行的后续工具块不再请求审批，一次停止即停（a794533）。
- 新一轮落盘顺序 meta 先行并等待落盘；`reopen` 未落盘就崩的档案按 meta 收成 interrupted，可热恢复（a291de8）。
- 归档派生也把上一轮裁决摘要交给执行者，宿主重启前后一套话（bc5a6ca）。
- 注入模型的宿主不被残留环境变量武装：角色模型 / 降级链 / 历史保留数只认显式选项；`/api/harness`
  与 Tools 面报运行历史的真实落点（994948a）。
- Web 宿主补齐跨会话 memory 工具与 `dynamicContext` 注入，与 CLI 口径对齐（770bb35）。

### 运行时韧性（Runtime resilience）

- **端点降级链与熔断**：`FallbackModelClient` + 逐端点 `CircuitBreaker`（连败开路、冷却半开），
  `AGENT_FALLBACK_*` / `AGENT_CIRCUIT_*`；认证失败 / 400 原样上抛，跨端点重发剥掉 thinking 块（28c7151）。
  `model_fallback` 事件接进 CLI 与 Web，台账记 `fallbackChain` / `fallbacks`（6793c3b）。
- MODEL-01b：能力探针（compat 不再只靠 `claude-*` 名称猜；须显式 `AGENT_MODEL_PROBE=1`，6909d7a）、
  verifier / planner / vision 每角色自有链或 `inherit`、`prefer_healthy` 诚实占位（不是计价路由）（1c096cc）。
- SAFE-06 Phase 1 工具副作用事务：`write_file` / `bash` 带 idempotencyKey 与
  prepared → running → committed 生命周期事件，`state.json.toolTx`，崩溃后同 key 不重复写；
  bash 无 undo 故 fail-closed 不重试（304c43a）。

### 持久状态与恢复（Durable state）

- ADR-003 Durable RunState 与纯迁移内核（df77299）；Web 宿主落 `state.json`，崩溃收成
  closed / interrupted，API 如实报 `durablePhase`（b93b1b3）。
- RUN-01 Phase 2 **同 run 热恢复**：interrupted 且有已提交 main 检查点时在同一 runId 上续跑
  （`sameRunResume` / `run_resumed`）；预算与 grant 审计进 state（044b492）。
- RUN-02 崩溃注入：模型中途 / 审批等待 / 历史落盘原子性 / 检查点恢复不重复副作用（ec2c88d）；
  两处测试侧读盘竞态修复（efd868e、1874517）。

### 记忆与上下文（Memory & context）

- MEM-01 语义压缩：大 `tool_result` 收成语义占位，持久 `[compact_ledger]` 保留约束 / 决定 /
  失败 / 证据引用 / 副作用，`ledgerEntries` 接进事件与 UI（570b80d）；Phase B 可选 LLM 摘要
  `AGENT_COMPACT_SUMMARY=1`，失败回退启发式，`summaryApplied` 接进 CLI 与 Web（dddc902）。

### 可观测性（Observability）

- OBS-01：run / segment / tool 追踪落 `trace.jsonl`（不引 OTel），`GET /api/runs/:id/trace` 脱敏导出（ffb5a01）。
- 台账错误分类：错误停止记 classified error，缺分类 fail-closed 到 `unclassified_error`（7c7ebbc）。

### 评测与 CI（Eval & CI）

- TEST-01a：覆盖率棘轮阈值 + 8 个关键变异必须变红（`test:coverage` / `test:mutation-smoke`），CI core 上传 coverage（d175e02）。
- EVAL-02 统计引擎：pass@1 Wilson 95% CI、无偏 pass@k、首轮 / 修复率、p50 / p95、11 值失败分类学，
  `npm run eval:stats`（aecccc2，公式回收 6e22381）。
- Mock Anthropic / OpenAI 流式端点，含 429 / 500 / 断流 / 超时 / 坏 JSON 故障注入（b67945c）；
  EVAL-03a 确定性场景门：12 个零 token 场景跑在 `dist/` 上，CI 与 release 都跑（85adc81）。
- EVAL-03b nightly 真实 provider 门 + `AB_TOKEN_CAP`（触顶 exit 2）+ `eval/baselines/nightly.json`（e8e12d6）；
  EVAL-03c release 质量 / 成本 / 延迟门，地板按 6/6 证据收紧（906ab39）。
- EVAL-01 held-out 套件：24 个冻结 `ho-*` 用例，`AB_SUITE=heldout`，nightly / release 切到 held-out 六件套（0bac669）。
- E2E-01 Phase 1：Playwright Web（dist + mock provider）与容器 `/health` 烟测进 CI（c6dfd4c）。
- `npm run ledger:samples` 批量攒裁决样本；Cloud Agent 凭据同步脚本与文档
  （5d3254a，[#1](https://github.com/Zeraissh/Agent_HarnssEngineering/pull/1)）。
- OCI canary 在 Linux CI 全绿：管理员探针改 inline 交付（070c05a）、worker 改 `debian:bookworm-slim`（61111f4）、
  bind mount 落盘权限（3a9dc7b）、回执记录（feb8289）。
- Release workflow：签名凭据缺失时跳过 Windows 安装包（**不发布未签名产物**）、镜像 job 不再硬依赖桌面产物、
  OCI canary 与 CI 对齐 + 发布镜像 `/health` 烟测、`workflow_dispatch` 预演不推送、Release 正文附本文件对应小节（dbbf20a）；
  真实 provider 凭据只给质量门两步，不再以 job 级 env 漏进 `npm test`（预演抓到，affea93）。

### 安全（Security）

- Phase 0 安全收口：MCP 逐工具权限、`fetch_url` SSRF 防护、`ExecutionBroker` OCI 执行隔离、
  桌面设置窗口（770bb35）。
- 依赖：qs / xmldom（b680b3e）、fast-uri（96db893）升级，`npm audit` 门恢复通过。

### 文档（Docs）

- 新增本 CHANGELOG（REL-02 起步），版本号 1.2.0 → 1.3.0（`package.json` / `cross-app/package.json` /
  `CLI_VERSION` 同步，并加测试锁住三者一致）。docs/06 交接页与 docs/08 成熟度清单随各项同步更新。

## [1.2.0] - 2026-08-27

> 版本号在 a835a0b 提升到 1.2.0，但当时**未打标签、未出 GitHub Release**；本节按 `v1.1.0..c0b29ab` 归档。

### 安全（Security）

- 三条 high 修复：启动横幅不再打印访问令牌本体；bash 子进程按名剥密钥（`AGENT_BASH_KEEP_ENV` 显式放行）；
  `read_file` 对 `.env*` / `.npmrc` / `.netrc` / `id_rsa*` / `*.pem` fail-closed（`.example` / `.sample` 放行）（1653b7b）。
- `AGENT_PROVIDER=openai` 时 `OPENAI_API_KEY` 必须显式配置，不再回退复用 `ANTHROPIC_API_KEY`（a835a0b）。

### 可观测性与成本（Observability & cost）

- 监控闭环：`AgentHarnessDown`（up==0 / absent）、`runs_finished_total{outcome}` 六档、`RunErrorRatio` 告警、
  生产 compose 日志轮转（939be6e）；评审回收补 5xx 预注册、告警选择器 job 限定（4d6c357）。
- `agent_harness_tokens_total{role,kind}` 与 `TokenBurnRate` 告警，跨 run 烧钱首次可观测（bc39a9e）；
  vision 漏计与 plan 模式核查入口记账修复（7b4a91c）。
- 宿主级日 token 预算门 `AGENT_UI_DAILY_TOKEN_BUDGET`：超限后新 run / 追问 / 归档派生 / 计划批准 429
  并附 `Retry-After`，在飞 run 不掐（b62f6a5）；逐调用实时落账、`0` = 今日封盘、env 仅武装真实宿主（af73e9b）。

### 运行时韧性（Runtime resilience）

- 跨 run 资源互斥 `ResourceCoordinator`（独占标签如 `swd-probe` 在准入时整占，冲突 429 附持有者）
  + 同 workdir 并发告警 / `AGENT_UI_EXCLUSIVE_WORKDIR=1` 拒绝（de6ddef）；followUp 并发窗口、
  holder 缺省唯一、无 pack 子任务兜底（e95067a）。

### 发布与桌面（Release & desktop）

- 自包含桌面外壳与生产加固：Electron 壳自管本地宿主（`host-launcher` / `workspace-store` / `host:stage`
  把宿主运行时打包进 App）、历史备份 sidecar（`ui/history-backup.ts` + 生产 compose）、
  `AGENT_UI_SSE_HEARTBEAT_MS`、release workflow 加 Windows 签名安装包 job（a835a0b）；
  CI 桌面 staging 先安装根依赖（c0b29ab）。
- 测试：`waitForDone` 改 15s 截止线，满载 CI 不再误伤慢跑（ceec63a）。

## [1.1.0] - 2026-08-24

首个打标签的发布（[Release v1.1.0](https://github.com/Zeraissh/Agent_HarnssEngineering/releases/tag/v1.1.0)）。

- 生产件全部入库：CI、Dockerfile、deploy、生产宿主策略（ddedd2d）；Electron / Capacitor 跨端外壳入库（848575d）。
- 发布流水线：推 `vX.Y.Z` 标签触发门禁 → 推 GHCR（版本 tag + `sha-<commit>` tag）→ Release 正文记录镜像 digest（07d3178）。
- 两条平台形状测试改平台无关（CI 首跑 ubuntu 抓红）（6e526f9）。
- 镜像：`ghcr.io/zeraissh/agent-harness@sha256:92c60fda5f7fc4ba1d88f8e7c3c6485e2c5e0918245c08cc69b927461a527b2d`。

[Unreleased]: https://github.com/Zeraissh/Agent_HarnssEngineering/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/Zeraissh/Agent_HarnssEngineering/compare/v1.1.0...v1.3.0
[1.2.0]: https://github.com/Zeraissh/Agent_HarnssEngineering/compare/v1.1.0...c0b29ab
[1.1.0]: https://github.com/Zeraissh/Agent_HarnssEngineering/releases/tag/v1.1.0

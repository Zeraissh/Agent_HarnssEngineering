# 04 — 演进路线与验证标准

原则：每个版本都以**可验证的行为**收尾，而不是以"代码写完了"收尾。checklist 里的每一项都必须能演示。

---

## v0.1 — 设计定稿（当前）

**交付物**：本组文档（README + docs/01–04）。

**验证 checklist**
- [x] 四支柱（Loop / Tools / Context / Verification）在架构中均有对应模块
- [x] 03 的接口与 02 的分层一一对应，API 数据结构全部复用 SDK 类型
- [x] 关键 API 硬约束（并行 tool_result 合并、pause_turn、caching 前缀规则、Opus 4.8 参数限制、流式要求）已写入 02 备忘

---

## v0.2 — 最小可跑闭环

**目标**：L0 + L1 + L2 实现，端到端完成一个真实小任务。

**范围**
- 工程脚手架：`package.json`（`@anthropic-ai/sdk`、tsx、vitest）、`tsconfig.json`、`src/` 目录
- `ModelClient`：流式发送、usage 提取、错误分类
- `AgentLoop`：完整 stop_reason 分支、护栏、事件流
- `ToolRegistry` + `ToolExecutor`（并行调度；权限门 v0.2 先实现 auto，ask 留到 v0.3 接 CLI）
- 内置工具：`bash`（超时 + 输出截断 + workdir 限制）、`read_file`、`write_file`（路径逃逸校验）
- `ContextManager` 最小版：冻结 system + 两个缓存断点；`compact()` 留空实现（直接返回原数组）
- 一个 CLI 入口：`npx tsx src/cli.ts "任务描述"`，把事件流打印成可读日志

**验收任务**（端到端）：`"阅读本仓库 docs/ 下的所有文档，在根目录生成一份 SUMMARY.md"` —— 要求 agent 自主完成 glob → 多文件读取（并行）→ 写文件。

**验证 checklist**（2026-07-24 通过；端到端经 DeepSeek Anthropic 兼容端点 + compat 模式）
- [x] 验收任务一次跑通，SUMMARY.md 内容正确（6 轮，deepseek-chat）
- [x] 第二轮起 `cache_read_input_tokens > 0`——compat 模式下由 DeepSeek 自动缓存提供（cacheHit 61.6%）；Anthropic 原生 cache_control 断点待有 Anthropic key 后补验
- [x] 单轮多个 tool_use 时：parallel-safe 工具确实并发（验收 turn 4 单条消息 4 个 read_file 并发执行；另有单测计时证明），结果合并在单条 user 消息
- [x] 工具抛异常时循环不中断，模型收到 `is_error: true` 并调整策略（验收 turn 1–3：Windows 上 `find`/POSIX 语法连败两次后模型自行改用 `dir` 成功）
- [x] 人为设置 `maxTurns: 2` 时，以 `max_turns` 停止且不再发请求（单测）
- [x] `pause_turn` 分支有单元测试覆盖（mock ModelClient 构造该 stop_reason）
- [x] AggregateUsage 三类 token 分开统计，总和与 API usage 对账一致（单测 + 验收 run 汇总）

**超出计划完成**：compat 模式（第三方 Anthropic 兼容端点支持，`AGENT_MODEL` 非 claude-* 自动降级 thinking/effort/cache_control）；审批门全链路已随 v0.2 落地（CLI y/n + `--yes`），原计划 v0.3。

---

## v0.3 — 上下文与管控完整化

**目标**：L3 完整 + 审批门 + 可用的 CLI 体验。

**范围**
- `compact()` 首个真实实现：截断最老的大体积 tool_result 为占位摘要；触发阈值可配（`contextTokenLimit`，CLI 经 `AGENT_CONTEXT_LIMIT`）
- 缓存可观测：run 结束打印 cacheHitRatio；`src/diagnostics.ts` 提供"缓存为何未命中"的前缀 diff 工具（`diffRenderedRequests`，按 tools → system → messages 顺序定位首个分歧点）
- 权限门：`permission: "ask"` 全链路（已随 v0.2 提前落地：approval_request 事件 → CLI y/n 提示 → deny 理由回传模型）
- 动态上下文注入规范化：`userMessageWithContext()`——时间/环境信息注入首条 user 消息而非 system
- CLI 渲染改进：区分 text / tool_call / tool_result / usage 的着色输出（已随 v0.2 落地）

**验证 checklist**（2026-07-24 通过）
- [x] 长任务触发 compact 后仍能正确续跑，compaction 事件可见（端到端：AGENT_CONTEXT_LIMIT=2500，10 轮任务触发 4 次 compaction，输入从 6.0k 压回 2.3k，最终 STATS.md 行数经独立核对全部正确；另有 4 个单测覆盖水位/保护窗/幂等/小块豁免）
- [x] 缓存命中可观测：run 汇总打印三类 token + cacheHitRatio；`diffRenderedRequests` 有 4 个单测覆盖 tools/system/messages/none 四种分歧
- [x] `write_file` 触发审批提示；deny 后模型收到理由并改变行为（单测覆盖 deny→is_error→模型调整；CLI y/n 交互链路已实现，交互式人工验证可随时进行）
- [x] system prompt 在整个 run 期间字节不变（测试断言：不同 messages 下多次 render 的 system 字节一致）

**注**："连续两次相同任务第二次 cacheHitRatio > 0"原属本阶段——compat 模式下 DeepSeek 自动缓存已在单次 run 内命中（39.8%~61.6%）；Anthropic 原生 cache_control 断点的跨请求命中验证仍待有 Anthropic key 后进行。

---

## v0.4 — 验证子代理与领域接入

**目标**：Verification 支柱落地；证明框架的领域无关性。

**范围**
- **Verifier subagent**（`src/verifier.ts`）：干净上下文 + 相同 system/tools 前缀起子 loop，输入 = 任务描述 + 执行者报告（不可信），输出 = JSON 裁决（fail-closed 解析）；内部自动 deny 一切审批 → 只读硬约束
- **编排器**（`src/orchestrate.ts`）：`runVerified()` 主 run → 核查 → 携问题清单返工（默认 1 轮）；CLI `--verify` 接入
- **领域接入试点**：`fetch_url` 网页抓取工具（https-only、去标签、默认 ask 审批）
- 评估基线：`eval/cases.ts` 5 用例 + 程序化判定，`npm run eval` 生成回归报告

**验证 checklist**（2026-07-24 通过）
- [x] verifier 能抓出主 agent 的一个植入错误（`eval/verifier-demo.ts`：报告谎称写入 "harness ok"、实际文件是 "hello world"，verifier 2 轮内亲自读文件给出 passed=false 并准确指出差异）
- [x] 领域工具接入 diff 只涉及 `src/tools/fetch-url.ts` + CLI 注册一行，L0/L1/L3 零改动（git diff 可查）；实弹测试：抓取 example.com 提取标题写盘成功
- [x] 5 用例基线报告生成且可重复（`eval/baseline-report.md`：deepseek-chat 5/5 通过，2–4 轮/用例，总 token 1.5k–8.9k/用例）
- [x] 编排链路单测覆盖：一次通过 / 返工后通过（问题清单进返工输入）/ 到达 maxReworks / 主 run 未完成跳过核查；verifier deny-只读、共享 system 前缀均有断言（44+10 共 54 个测试）

**注**：子代理缓存复用在 compat 模式下由 DeepSeek 自动缓存体现（verifier run 自身 cacheR > 0）；Anthropic 原生断点的父子前缀命中验证仍待 Anthropic key。

---

## v0.5 — 跨会话记忆（L5）

**目标**：agent 在会话之间保留并复用知识。

**范围**
- `src/memory.ts`：`MemoryStore`（一条记忆一个 .md 文件；索引不落盘，实时从首行提摘要）+ `createMemoryTools()` 四工具
- 圈禁不变量：名字正则 + 路径校验 + 64KB 上限 → `memory_write` 得以 auto 权限（P2 晋升收益）
- CLI 接入：`.agent-memory/` 默认目录（`AGENT_MEMORY_DIR` 覆盖）、`memory_index` 经 dynamicContext 注入、system 增加静态记忆纪律段

**验证 checklist**（2026-07-24 通过）
- [x] 跨进程闭环：会话 1 `memory_write` 保存部署端口 → 会话 2（全新进程）开局从注入索引发现记忆、`memory_read` 后写出正确答案 9944（独立核对）
- [x] 圈禁不变量测试：`../` 逃逸、绝对路径、非 .md 名、64KB 超限全部被拒（8 个 MemoryStore/工具单测）
- [x] 索引永不漂移：list/indexBlock 实时派生，无 MEMORY.md 可失步
- [x] 52 个单测全绿

## v0.6 — OpenAI wire 协议（L0 第二实现）

**目标**：P1（分层可替换）的终极检验——换掉整个 wire 协议，L1/L2/L3 零改动。

**范围**
- `src/model-client-openai.ts`：OpenAIModelClient + 双向翻译层（tool_result ↔ role:"tool"、tool_use ↔ tool_calls、is_error 降级前缀、finish_reason 映射、残缺 JSON 参数 fail-safe）
- `src/provider.ts`：AGENT_PROVIDER 工厂（anthropic | openai），CLI 与 eval 共用，超时旋钮统一
- 流式：手写 SSE 分片累积（文本 delta 旁路 + tool_calls 按 index 拼装）；`prompt_tokens_details.cached_tokens` / DeepSeek `prompt_cache_hit_tokens` 映射为 cache_read

**验证 checklist**（2026-07-24 通过）
- [x] 9 个翻译层单测（请求/响应双向、usage 拆分、残缺参数）；全套 61 测试绿
- [x] 端到端（DeepSeek OpenAI 端点，同一 key）：5 轮任务含两次并行工具调用，往返翻译无误，答案独立核对正确
- [x] 缓存统计贯通：cacheHit 81.3%（prompt_cache_hit_tokens 映射）
- [x] 核心层零改动：diff 仅新增 L0 实现 + 工厂 + 宿主接线

## v0.7 — MCP 接入与 STM32 真机落地

**目标**：一次适配打开整个 MCP 工具生态；完成首个真实领域场景（嵌入式调试）。

**范围**
- `src/mcp.ts`：`adaptMcpTool`（MCP tool → Tool，`${server}__` 前缀防撞名）+ `McpConnection`/`connectMcpServers`（stdio transport，单 server 失败不拖垮整体）+ `mcp.json` 配置（per-server permission/parallelSafe/includeTools）
- 安全默认：permission "ask"、串行（外部进程能力面未知，P6）；信任 server 可配置放开
- CLI：`./mcp.json` 存在即自动连接（`AGENT_MCP_CONFIG` 覆盖），run 结束统一断开
- STM32 侧：插件 0.1.1 → 0.2.0（marketplace 更新）；开发副本 editable 安装刷新至 0.6.0；harness 直连开发副本（venv python + compact 模式 + 9 工具白名单）

**验证 checklist**（2026-07-24 通过）
- [x] 8 个适配层单测（前缀/schema 直通/权限默认/isError 映射/content 渲染/配置解析）；全套 69 测试绿
- [x] 核心层零改动：MCP 接入 diff 仅新增 src/mcp.ts + CLI 接线
- [x] **STM32L151 真机端到端**：deepseek-chat 驱动 harness，7 轮自主完成 suggest_server_args → start_debug_session → self_check（主动带 expected_family）→ capture_state → 写报告 → stop_debug_session；报告数据（CPUID 0x412fc230 / dev_id 0x427 / Cortex-M3 / STM32L151/152 Cat.3）与直连 MCP 的独立检查完全一致

**真机故障定位（2026-07-25）**：植入除零 HardFault（`stm32l151_faultdemo`：main → app_init → process_config，`100 / g_divisor` with g_divisor=0，设 DIV_0_TRP）到 L151，让 **本地 qwen3.5:9b（Ollama, 262k 上下文）** 通过 harness+MCP 自主定位。9 轮约 2.5 分钟完成：suggest_server_args → start_debug_session → self_check → load_symbols → reconstruct_fault_context → read_call_stack → 写报告 → stop。诊断五项全对（UsageFault DIVBYZERO→HardFault / process_config main.c:27 / faulting PC 0x08000042 / 根因除零 / 调用链），与独立 objdump+CFSR 核对一致。证明：本地 9B 模型经此 harness 能自主完成真实硬件故障定位。
- 现场发现：① 野指针写 0xCCCCCCCC 在 L151 外部设备区被静默丢弃、不触发故障——改除零才可靠；② SWD 自锁（固件低功耗/引脚重配 + 无 NRST）需物理上电复位抢连接救回。
- **harness 短板（已修，2026-07-25）**：首跑 `max_tokens=2048` 时模型报告太长被截断，而 loop 在 v0.2 把 max_tokens 当硬错误终止整轮——诊断其实已完成、仅报告没写成。**已改**：`max_tokens` 成为独立的非 error 终止态（`AgentRunResult.stopReason: "max_tokens"`），部分内容保留在 messages 中，CLI 渲染为黄色警告并提示提高 AGENT_MAX_TOKENS；护栏语义不变（仍尊重用户设的上限、不自动提额，防本地模型跑飞）。70 单测。

## v1.1 — 并行编排（DAG 调度）【feat/parallel-orchestration 分支，2026-08-03】

**动机**：预算轴 A/B（c527eef）证明 planned 臂在单领域任务上 token 只会更贵——三角编排的
价值边界在跨领域交接/长管线。并行化不追 token（并行不省 token），追的是**墙钟**：
互不依赖的子任务同时跑，wall-clock 逼近关键路径而非全序和。

**契约**
- `SubTask.dependsOn: string[]`——planner 显式声明直接依赖；就绪条件 = 全部依赖核查通过。
  交接摘要只从直接依赖传入（多依赖多段，带来源标注）。
- 图校验 fail-closed：id 重复 / 悬空引用 / 成环 → 整份计划作废（与裁决解析同纪律）。
- 兼容：整份计划无 dependsOn → 推断线性链（v1.0 隐式顺序语义，旧测试原样通过）。

**调度器**（`runPlanned` + `concurrency`，默认 1 = 与 v1.0 逐字节同行为）
- ready-queue：依赖全通过即发射，至多 concurrency 个在飞。
- 失败语义：任一子任务核查未通过 → 停止发射（含无关独立分支——整体已败，续跑烧钱）；
  在飞的照常跑完（工具有副作用，中途硬断比跑完危险）；未启动的标记 `skipped`。
- 审批互斥门：并发子任务的 approval_request 排队逐个交宿主（终端同时弹两个审批 =
  应答错配）；verifier/planner 的审批由内部自答，不入门（入门会死锁）。
- 每步记 `durationMs`——并行价值的主度量是墙钟节省，CLI 汇总"子任务合计 vs 阶段墙钟"。

**planner 纪律新增**：dependsOn 只在【必须用到对方产物】时声明；互不依赖的子任务
不得写同一文件/独占资源（探针、端口），会冲突就串行化；汇总 = 收尾子任务 dependsOn
全部分支（不造聚合器单元）。

**CLI**：`--plan --parallel[=N]`（裸旗标 =2）；并行模式行级渲染（`[sX/角色]` 前缀，
不流式）。

**验证 checklist**
- [x] 118 单测全绿（+11：图解析校验×6、并发重叠证明、fan-out 交接隔离、失败语义、审批互斥门）
- [x] 旧 planner/orchestrate 测试零改动通过（线性链推断兜住 v1.0 语义）
- [ ] 真机 A/B：planned-serial vs planned-parallel 墙钟对比（分支内数据）
- [ ] planner 依赖图产出质量：真实模型能否写出正确的 dependsOn（悬空/成环率）

## 更远（不承诺顺序）

- **Harness A/B 研究**：用 eval 量化各 harness 特性的收益（verifier 开关、compact 阈值、工具描述写法、跨模型/协议矩阵）；前置：eval 用例扩到 15–20 个
- server-side compaction（beta）替换本地截断
- Anthropic 原生缓存断点补验（待 Anthropic key）

---

## 实现阶段注意事项

- 进入 v0.2 前，用 claude-api skill 重新核对一次 API 细节（本设计基于 2026-06 缓存的规范）
- 每个版本收尾时回读本文件，勾掉 checklist 并记录偏差——设计文档是活文档，与实现不符时改文档或改代码，不允许沉默漂移

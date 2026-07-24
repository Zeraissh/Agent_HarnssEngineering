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

## 更远（不承诺顺序）

- L5 Memory：跨会话文件式记忆目录 + 索引
- server-side compaction（beta）替换本地截断
- Tool search / defer_loading（工具数量增长后）
- 多 agent 编排（并行 fan-out + 汇总）

---

## 实现阶段注意事项

- 进入 v0.2 前，用 claude-api skill 重新核对一次 API 细节（本设计基于 2026-06 缓存的规范）
- 每个版本收尾时回读本文件，勾掉 checklist 并记录偏差——设计文档是活文档，与实现不符时改文档或改代码，不允许沉默漂移

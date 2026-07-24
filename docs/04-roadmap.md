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

**验证 checklist**
- [ ] 验收任务一次跑通，SUMMARY.md 内容正确
- [ ] 第二轮起 `cache_read_input_tokens > 0`（缓存断点生效）
- [ ] 单轮多个 tool_use 时：parallel-safe 工具确实并发（日志时间戳证明），结果合并在单条 user 消息
- [ ] 工具抛异常时循环不中断，模型收到 `is_error: true` 并调整策略
- [ ] 人为设置 `maxTurns: 2` 时，以 `max_turns` 停止且不再发请求
- [ ] `pause_turn` 分支有单元测试覆盖（mock ModelClient 构造该 stop_reason）
- [ ] AggregateUsage 三类 token 分开统计，总和与 API usage 对账一致

---

## v0.3 — 上下文与管控完整化

**目标**：L3 完整 + 审批门 + 可用的 CLI 体验。

**范围**
- `compact()` 首个真实实现：截断最老的大体积 tool_result 为占位摘要；触发阈值可配
- 缓存可观测：run 结束打印 cacheHitRatio；提供"缓存为何未命中"的诊断提示（前缀 diff 工具）
- 权限门：`permission: "ask"` 全链路（approval_request 事件 → CLI y/n 提示 → deny 理由回传模型）
- 动态上下文注入规范化：时间/环境信息注入 messages 而非 system 的辅助函数
- CLI 渲染改进：区分 text / tool_call / tool_result / usage 的着色输出

**验证 checklist**
- [ ] 长任务（>20 轮）触发 compact 后仍能正确续跑，compaction 事件可见
- [ ] 连续两次相同任务，第二次 cacheHitRatio 显著高于 0
- [ ] `write_file` 触发审批提示；deny 后模型收到理由并改变行为
- [ ] system prompt 在整个 run 期间字节不变（测试断言）

---

## v0.4 — 验证子代理与领域接入

**目标**：Verification 支柱落地；证明框架的领域无关性。

**范围**
- **Verifier subagent**：主 agent 完成后，用独立 ContextManager（干净上下文）+ 相同 system/tools 前缀起一个子 loop，输入 = 任务描述 + 主 agent 产出，输出 = 结构化核查结论；主 loop 根据结论决定返工
- 子代理的缓存复用策略：与父级共享 tools/system 前缀，验证 cache_read 生效
- **领域接入试点**：接入一个真实领域工具集（候选：STM32 调试 MCP 工具、或 web 检索）；验证只需新增 Tool 实现、零改动 L0/L1/L3
- 评估雏形：固定 5 个任务用例，记录成功率 / 轮数 / token 成本，作为后续改动的回归基线

**验证 checklist**
- [ ] verifier 能抓出主 agent 的一个植入错误（构造测试用例）
- [ ] 领域工具接入 diff 只涉及 `src/tools/`，核心层零改动
- [ ] 5 用例基线报告生成，可重复运行

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

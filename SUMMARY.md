# 项目文档摘要

> 本文件总结了 `docs/` 目录下所有 Markdown 文档的核心内容。

---

## 01 — 设计哲学

**核心思想**：在模型能力固定的前提下，Agent 的表现差异几乎全部来自 **harness（支架）** 的设计质量。项目从零手写 harness，不依赖现成框架，目的是深入理解与掌控每一个核心决策。

**六大设计原则**：
1. **分层可替换** — 每层只依赖下层接口，换掉任何一层的实现不影响其他层
2. **Bash 起步，按需晋升** — 通用能力先用 bash 工具，只有在需要安全边界、不变量校验、渲染或并行调度时才升格为专用工具
3. **上下文是稀缺资源** — Prompt caching 是前缀字节匹配，内容排序必须遵循"稳定在前、易变在后"的铁律
4. **默认可观测** — Loop 以结构化事件流（AsyncIterable）对外输出，日志、UI、审批门都是事件的消费者
5. **错误进上下文** — 工具执行失败以 `is_error: true` 回传模型，让模型自行调整策略，而非终止循环
6. **护栏是宿主责任** — 最大轮数、token 预算等硬约束由 loop 强制执行，不依赖 prompt 软约束

---

## 02 — 分层架构

**五层架构（自底向上）**，v0.1 详细覆盖 L0–L3：

| 层级 | 职责 | 核心设计决策 |
|---|---|---|
| **L0 ModelClient** | 封装 Messages API，统一内部接口 | 一律流式；禁用 temperature/top_p 等 Opus 4.8 不支持参数；缓存断点标记由 L3 决定、L0 执行 |
| **L1 AgentLoop** | 核心 while 循环与控制流 | 处理 end_turn / tool_use / pause_turn / max_tokens / refusal 五种 stop_reason；护栏每轮检查；事件流驱动 |
| **L2 ToolLayer** | 工具定义、注册、权限评估与执行调度 | Tool 接口含 permission / parallelSafe；v0.2 内置工具：bash、read_file、write_file |
| **L3 ContextManager** | 构造模型每次看到的上下文 | 冻结 system prompt；两个缓存断点（system 尾块 + 最近 user 消息尾块）；compact 策略位 |
| **L4/L5** | 编排与记忆（轮廓） | L4 子代理复用父级 system/tools 前缀以蹭缓存；L5 文件式跨会话记忆 |

**关键 API 事实备忘**：并行 tool_result 必须合并进单条 user 消息；pause_turn 处理方式；Prompt caching 前缀规则（tools → system → messages）；Opus 4.8 参数限制；大输出必须流式；工具输入必须 `JSON.parse` 后使用。

---

## 03 — 核心接口定义（TypeScript 蓝本）

定义 v0.2 实现所需的类型与契约，不含实现体。**总约定**：API 数据结构复用 SDK 类型，框架不重复定义。

**核心接口**：
- **Tool / ToolRegistry / ToolExecutor** — 工具契约；确定性序列化（按 name 排序保持缓存稳定）；并行安全调度
- **ModelClient / ModelRequest / ModelTurn** — 模型客户端接口；流式发送，控制流只依赖最终消息
- **ContextManager** — 上下文组装与压缩策略
- **AgentConfig / AgentLoop / TurnEvent / AgentRunResult** — agent 配置、事件驱动的循环契约（AsyncIterable）

**契约要点**：
1. 完整 push assistant content（含 tool_use / thinking 块）
2. tool_result 单条 user 消息合并
3. 审批语义：deny 不终止循环，生成 `is_error: true` 回传模型
4. 护栏在每次模型调用前检查
5. compact 由 loop 触发并发射 compaction 事件

---

## 04 — 演进路线与验证标准

**原则**：每个版本以**可验证的行为**收尾，而非"代码写完了"。

| 版本 | 目标 | 关键交付 |
|---|---|---|
| **v0.1 ✅** | 设计定稿 | 本文档集（README + docs/01–04） |
| **v0.2 🔜** | 最小可跑闭环 | ModelClient + AgentLoop + ToolLayer + 三个内置工具 + CLI 入口。验收任务："阅读 docs/ 生成 SUMMARY.md" |
| **v0.3** | 上下文与管控完整化 | compact 真实实现、审批门全链路、CLI 渲染改进、缓存可观测 |
| **v0.4** | 验证子代理与领域接入 | Verifier subagent（干净上下文核查主 agent 产出）+ 领域工具集试点 + 评估基线 |
| **更远** | 不承诺顺序 | L5 记忆、server-side compaction、工具搜索、多 agent 编排 |

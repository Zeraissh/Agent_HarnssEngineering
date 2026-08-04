# 模块参考

本目录包含 Agent Harness `src/` 模块的参考文档索引。三份文档按职责分层覆盖全部 21 个源文件——从内核循环到编排调度再到工具与外围基础设施，每节均含职责说明、导出签名（逐行取自源码）与可追溯的设计决策。

---

### 📄 [核心模块参考](./core.md)

覆盖 `src/` 下 6 个核心模块（loop.ts、context.ts、model-client.ts、model-client-openai.ts、provider.ts、types.ts），涵盖 Agent 主循环、上下文管理、模型客户端、Provider 工厂与核心类型定义。

### 📄 [编排层参考文档](./orchestration.md)

覆盖 `src/` 下 5 个编排相关模块（orchestrate.ts、planner.ts、verifier.ts、router.ts、presets.ts），涵盖核查-返工循环、任务规划拆分、独立核查者、领域路由与领域包预设。

### 📄 [工具与外围模块参考](./tools-periphery.md)

覆盖 Agent Harness 的工具层与外围基础设施共 10 个源文件（bash.ts、fetch-url.ts、fs-util.ts、read-file.ts、registry.ts、write-file.ts、mcp.ts、memory.ts、diagnostics.ts、cli.ts），涵盖内置工具、MCP 客户端接入、跨会话记忆、缓存诊断与 CLI 宿主。

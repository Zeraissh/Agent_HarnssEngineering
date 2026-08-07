# 待办清单（v2 UI 之后）

> 交接文档。上一轮会话把 Web 宿主 UI 从 v1 推到 v2（R0–R11，21 → 34 个问题项，
> 225 → 485 测试），下面是**尚未做**的部分。逐条写清了"为什么值得做"与
> "为什么不做另一种做法"，接手时不必重新推演。
>
> 完成情况见 [`ui/remediation-v2-status.md`](../ui/remediation-v2-status.md)。

---

## 零、一条反复出现的规律（排查时先想它）

**harness 早就有能力，Web 宿主没接。** 这一系列里出现了 **五次**：

| 能力 | 早就在 | 宿主接入轮次 |
|---|---|---|
| 会话正史 `result.messages` | 一直返回 | R6a |
| thinking 块 | `model-client.ts:41` 显式开了 adaptive | R6b |
| 多轮续跑 `runContinuation` | `loop.ts:99`，为返工 inherit 建的 | R8 |
| 角色模型 `verifierModel`/`plannerModel` | CLI 从 env 装配 | R9 |
| 并行编排 `runPlanned` | v1.1 就有 | R7 |

**接手启示**：遇到"这个功能没有"，先去 `src/` 找一遍再动手写。这个 harness
比它的宿主走得远得多。

---

## 一、R6 收尾（v2 未闭合项）

1. **v1 九条 + AC-01~10 逐条复验未回退**（AC2-18）。基线在
   [`ui/remediation-v1.md`](../ui/remediation-v1.md)，状态表在
   [`ui/remediation-status.md`](../ui/remediation-status.md)。
2. **真实模型端到端确认 rubric 产出非空 advisory**（AC2-06 的缺口）。
   需 API key。`AGENT_PACK=ts-coding` + `AGENT_VERIFY_RUBRIC` 注入评分表，
   确认 advisory 不为空——Web 路径下此前恒为空，R2 修了装配但没做真机端到端。
3. **单帧毫秒量化**（AC2-11 的缺口）。目前只锁住"1000 事件只触发 1 次 flush"，
   真实浏览器的单帧耗时没测过。
4. **案例文档更新**：`docs/cases/case-07-web-host-ui.md` 更新至 v2 全案；
   把上面第零节那条规律写进 `docs/05-findings.md`（它已经稳定到可以当方法论）。
5. **状态表整体梳理**：34 项 / 485 测试，从 21 项基线长了不少，值得重排一遍。

---

## 二、契约执行（建议优先，两项是同一件事的两面）

现状是：**声明了契约，但不执行它**。两处现场：

### 2.1 结构化输出（最高优先）

`verifier` / `planner` 现在靠「解析 → 失败重问一次 → 再失败 fail-closed」。
`src/verifier.ts:86` 的注释本身就是证据——项目已经撞上过并打了补丁：

> fail-closed 直接返工会对正确产物空转（A/B 实测烧 10 万级 token），一次重问便宜得多

**正解是让它不发生**：Anthropic 用 `tool_choice: {type:"tool", name:"..."}`
强制工具调用，OpenAI 兼容端用 `response_format: json_schema`。
这能基本消灭 `VERDICT_PARSE_FAIL`——**D3 三种 fail-closed 误伤形态的第一种**，
不是推测收益，是消灭一个已命名、已实测、界面上已专门告警的失败模式。

注意 compat 端点未必都支持 `response_format`，需要能力探测 + 降级回现有解析路径。

### 2.2 工具入参 schema 校验

`inputSchema` 声明了、发给模型了，但**运行时从不校验**——各工具自己手写
`typeof p !== "string"`（见 `src/tools/write-file.ts:23`）。

**项目自己的 P6 在反对现状**：「护栏是宿主的责任，不是模型的自觉」。
现在 schema 的遵守完全靠模型自觉：宿主声明了契约，然后不检查。

做法：最小 JSONSchema 子集校验器（约百来行，只覆盖自己声明过的那些形态），
在 `ToolExecutor` 统一拦，错误消息写给模型看（P5）。
`parseVerdict` / `parsePlan` 的手写字段校验是同一类问题的第二个现场。

**不要引入 zod/ajv**：与"从零手写、刻意不用现成框架"的立项动机冲突，
而且我们只需要很小的子集。

---

## 三、重试与降级（小改动，有新触发条件）

**已有且做得不错的部分**：两层重试（SDK HTTP 重试 + loop 层 `errorRetries`），
配 `api_retry` 事件可观测；`isTransientApiError`（`model-client.ts:60`）做了
错误分类——auth/permission/404/400/422 永久性不重试，429/连接超时才重试。
这已经是 Tenacity 的 `retry_if_exception_type` 那一层。

**两个缺口**：

1. **退避无抖动**：`errorRetryBackoffMs * (attempt + 1)` 是线性的。
   **V-27 接入并行编排之后**，三个并发子任务同时撞 429 会同步重试——
   这是新引入的触发条件。加抖动即可。
2. **无模型降级**：V-30 建好角色模型框架之后，"执行者失败降级到备用模型"
   变得很便宜。

**明确不做**：可组合的重试策略 DSL、熔断器。按 P2「按需晋升」，
没有实测需求就不该建，分类这一层已覆盖真实场景。

---

## 四、流式（管道已通，Web 没接）

- **文本流式已有**：`stream.on("text")` → `onDelta` → `text_delta` 事件，
  CLI 实时打印。R2 把它改成了 SSE 命名通道（不占 seq、不进缓冲）。
  **但 Web UI 至今丢弃它**——LiveStrip 显示的是上一条完整 `assistant_text`，
  不是逐字。前端消费即可。
- **思考流式没有**：`stream.on("text")` 只接文本增量，`thinking_delta` 没接，
  所以思考块是整轮结束才到。要逐字显示思考过程需在 `model-client.ts` 补接。

---

## 五、人机协作（原语都在，只是没人用）

### 5.1 计划确认门（基本免费）

`runPlanned` 的 `onPlan` 是 **await 的**（`orchestrate.ts:317`），
文档字符串写着"宿主可展示计划、做人工把关"。
也就是说"看到计划 → 确认后才执行"只差 UI 挂一个确认门。

### 5.2 需求澄清（`ask_user` 工具）

没有机制让 agent 提问并等待，但 `approval_request` 就是"阻塞等人"的原语，
加一个 `ask_user` 工具即可复用那条通路。

**与哲学高度契合**：`SubTask.acceptance` 已经存在，H1 讲的是"把主观判断降维为
可程序化条款"。需求澄清正是人这一侧的同一件事——**开跑前把验收标准问清楚，
比事后靠 verifier 抢救便宜得多**，这正是 B5 那条「修环境 > 提示词 > 事后核查」
的优先级排序。

**但要先想清判据**：什么时候该问、问几个。容易做过头，值得单独设计一轮。

---

## 六、更早就记下的、本轮明确不做的

- **并行编排的 DAG 甘特图**：R7 做了依赖分层 + 甘特条，够用；自由图布局没必要。
- **run 持久化**：`runs = new Map()` 纯内存，重启即失。
- **日志搜索 / 导出**。
- **v1 报告 §10 的「产物/变更 diff」面板**：需要 diff 数据源，尚不存在。
- **memory 工具在 Web 上的接入**：CLI 有，Web 没有（第六个"harness 有宿主没接"）。
- **监控基线**：运营项。

---

## 七、环境与纪律（接手必读）

- **浏览器窗格**：截图通道在本会话始终不可用（窗格未显示、页面不合成帧）。
  `resize_window` 传显式宽高能拿到真实视口；**强制元素宽度不会触发媒体查询**，
  测窄屏必须用真实视口。窗格偶发整体无响应，`preview_start` 可重开。
- **rAF 陷阱**：隐藏标签页不触发 `requestAnimationFrame`。已在 `core/batch.js`
  处理并有常驻测试，但任何新的帧调度都要记住这条。
- **停后台实例**：Windows 上 `taskkill /PID <pid> /T /F`，停完必须验证端口已释放
  （见记忆 `windows-taskstop-node-zombie`）。
- **改文件用 Write/Edit 工具**，不要用 PowerShell 的 `Set-Content -Encoding utf8`
  （会写 BOM，破坏 tsx 解析 JSON）。
- **Python heredoc 改代码要当心转义**：本会话多次因 `\n` / `\\` 被吞而写出语法
  错误。改代码优先用 Edit 工具。
- **验证纪律**：能行为验证就不要字符串断言。本会话最有价值的几次验证都是
  "让脚本化模型真的去读它收到的东西"——正史有没有带上、图有没有送到，
  都是让对方模型的**回答内容**取决于事实，而不是断言字符串。

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

**2026-08-07 补两例，规律要改写**：

| 能力 | 早就在 | 状态 |
|---|---|---|
| 文本流式 `text_delta` | R2 就改成了 SSE 命名通道 | 前端 `app.js:216` 一行直接丢弃（AC2-06 那次跑实测 **1133 条 delta 在流**）|
| `api_retry.backoffMs` | 本轮刚加 | reducer 白名单投影当场丢掉，**加字段的同一个提交里就发生了** |

第二例说明这不只是"旧宿主落后于新 harness"——**只要 harness 加字段而不同时接
宿主，缺口就即刻生成**。前端 reducer 是按事件类型逐字段白名单投影的，任何新字段
默认被丢，且不会有任何报错。所以纪律不是"回头补"，而是：

> **harness 加一个字段 = 同一个提交里把宿主那一侧一起接上，并加一条渲染锁。**

本轮那条锁（`test/ui-patch.test.ts` 的"重试退避等待在界面上可见"）就是这么抓到
自己刚造的缺口的——肉眼看不出来，因为界面并不报错，只是少显示一行。

---

## 一、R6 收尾（v2 未闭合项）

1. **v1 九条 + AC-01~10 逐条复验未回退**（AC2-18）。基线在
   [`ui/remediation-v1.md`](../ui/remediation-v1.md)，状态表在
   [`ui/remediation-status.md`](../ui/remediation-status.md)。
2. ~~**真实模型端到端确认 rubric 产出非空 advisory**（AC2-06 的缺口）~~
   **已关闭（2026-08-07）**：deepseek-v4-pro 走 compat 路径，Web 宿主
   `pack=ts-coding` + 四维度 rubric → `advisory` 4 条、逐条对上维度且可追溯到实物；
   `passed=true` / `reworks=0`（advisory 不影响裁决）。**双向自检**：同任务同包、
   唯一变量为"不注入 rubric"的对照臂 → `advisory=0`。装配链纸面即通
   （`ui/server.ts:449` → `orchestrate.ts:163` → `verifier.ts:297`），真机确认无偏差。
   证据见 [`ui/remediation-v2-status.md`](../ui/remediation-v2-status.md) AC2-06 行。
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

### 2.2 工具入参 schema 校验 —— ✅ 已实施（2026-08-07）

落地：`src/tools/validate-input.ts`（`validateToolInput`）+ `ToolExecutor` 在
**审批门之前**统一拦（`src/tools/registry.ts:111`）。23 条单测。不引入 zod/ajv。

三条实施时才看清、值得记下的东西：

1. **MCP 是硬理由，不是风格偏好**。`src/mcp.ts:75` 把外部 server 声明的 schema
   原样 `as JSONSchema` 收下，`execute` 再把 `input ?? {}` 直接转发——那些工具
   **没有任何位置可以手写检查**。而 `mcp.json` 里 stm32 是 `permission: "auto"`，
   含 `write_memory` / `flash_firmware`。手写路线从结构上盖不住 MCP。
2. **早有一处现场在等这一层**。`src/model-client-openai.ts` 的 `safeParseArgs`
   注释写着「解析失败回传空对象，**让工具的输入校验层**给出可操作报错」——
   代码一直在向一个从未建成的层交接。今天残缺 JSON 会以
   `{__malformed_arguments: "..."}` 原样转发给 MCP server。
3. **失败开放是这个校验器的核心纪律**，比查得严重要。只在【认得的构造被明确
   违反】时拒绝；`oneOf`/`anyOf`/`$ref`/未知 type 一律放行，也**不**强制
   `additionalProperties`。理由：schema 来自外部服务端，"看不懂就拒"是亲手造出
   fail-closed 那一类新失败模式——项目已有三种误伤形态的教训。required 缺失
   检查已经能抓到拼错的键名（错误消息会把实收键名一并列出）。

**审批门之前**是有意的：入参就不合法的调用不该去打扰人做授权决定。

各工具自己的 `typeof` 检查**保留**：`Tool.execute` 是可直接调用的公开面（测试
就这么用）。分工是——这一层执行【声明过的 schema】，工具那层管 schema 表达不了
的语义约束（非空、必须 `https://`）。

**真机验证**：deepseek-v4-pro 走 Web 宿主完整跑一轮，26 次真实工具调用穿过
校验器零误拒，run 正常收尾（这一层坐在每次工具调用的热路径上，单测全绿不足以
说明它不误伤）。

**未做**：`parseVerdict` / `parsePlan` 的手写字段校验是同一类问题的第二个现场，
校验器已可复用，但裁决 JSON 的形状约束与工具入参不同（需要的是"缺字段时如何
降级"而不是"拒绝"），值得单独想清再动。

---

## 三、重试与降级（小改动，有新触发条件）

**已有且做得不错的部分**：两层重试（SDK HTTP 重试 + loop 层 `errorRetries`），
配 `api_retry` 事件可观测；`isTransientApiError`（`model-client.ts:60`）做了
错误分类——auth/permission/404/400/422 永久性不重试，429/连接超时才重试。
这已经是 Tenacity 的 `retry_if_exception_type` 那一层。

**两个缺口**：

1. ~~**退避无抖动**~~ **✅ 已实施（2026-08-07）**：`backoffWithJitter`
   （`src/loop.ts`）用**等量抖动**——`ceiling/2 + random*ceiling/2`，不是全抖动。
   全抖动取 `[0, ceiling]`，有可能几乎立刻重试，而 429 是服务端明说"你太快了"，
   立刻重发是错误响应；等量抖动保证至少等到一半，同时给出 2:1 散布窗口，
   对 `AUTO_CONCURRENCY_CAP=3` 足够拉开三条轨。

   **两条实施笔记**：
   - 纯函数测试覆不住调用点——把 `loop.ts` 改回线性，那 4 条纯函数测试照样全绿。
     另加了一条走 loop 的行为锁（20 次重试的等待不全相等），反向自检立即失败。
     为此给 `api_retry` 事件加了 `backoffMs`（抖动后等待不再是定值，界面只显示
     "第几次重试"会让人以为退避固定）。
   - **加字段时当场又撞上第零节那条规律**：`app.js` 的 reducer 按字段白名单投影
     事件，`backoffMs` 在那一层就被丢掉了——harness 发了、宿主半路扔。是 UI 静态锁
     抓到的，不是肉眼。**新字段落地时就要连宿主一起接**，否则它自动变成下一条
     "harness 有、宿主没接"。
2. **无模型降级**：V-30 建好角色模型框架之后，"执行者失败降级到备用模型"
   变得很便宜。

**明确不做**：可组合的重试策略 DSL、熔断器。按 P2「按需晋升」，
没有实测需求就不该建，分类这一层已覆盖真实场景。

---

## 四、流式（管道已通，Web 没接）

- ~~**文本流式 Web 没接**~~ **✅ 已实施（2026-08-07）**：`index.html` 订阅
  `event: delta` 命名通道 → 控制器侧 `liveTexts` 缓冲（**不进 RunState**：delta
  不占 seq、重放时不存在，进 state 会打破 reducer 的重放幂等）→ 作为
  `renderRunDetail` 的 `liveText` 入参喂给直播条，显示尾部 80 字。
  delta 单独一个 `createBatcher`（复用同款调度，含"隐藏标签页 rAF 不触发"那个坑）。
  只取 `source === "main"`——verifier/planner 的流不该抢委托方的直播条。
  文本阶段边界在 `turn_start` / `tool_call` / `done` 处清空缓冲。6 条渲染锁。

  **真机验证**：运行中选中一个在飞的 run → 直播条 18/18 采样 `hidden: false`、
  670 帧 delta、12 个不同的流式文本随流推进，结束时正确隐藏。
  （踩了一次自己的坑：第一轮"验证失败"其实是我在 run 结束后才点开它——
  `ensureSubscription` 对终态 run 按设计不订阅，行为正确。**排查 UI 时先确认
  自己观察的时机，再怀疑代码**。）

- **思考流式仍没有**：`stream.on("text")` 只接文本增量，`thinking_delta` 没接。
  接上文本流式之后这条**从文档里的一句话变成了肉眼可见的空窗**——真机实测
  deepseek 开头约 3 秒 `deltas=0`、直播条停在"等待模型响应…"，那就是思考阶段
  （effort 调高会更长）。要逐字显示需在 `model-client.ts` 补接。
  注意 compat 端点未必吐 `thinking_delta`，需能力探测 + 降级。

---

## 五、人机协作（原语都在，只是没人用）

### 5.1 计划确认门 —— ✅ 已实施（2026-08-07）

`runPlanned` 的 `onPlan` 本来就是 await 的（`orchestrate.ts`），
文档字符串写着"宿主可展示计划、做人工把关"——**harness 侧零改动**，
缺的一直只是宿主接这条线。

落地：`POST /api/runs` 收 `planGate`（**默认关**，逐 run 显式开）→ `onPlan` 里
`await waitForPlanDecision(run)` → `POST /api/runs/:id/plan-approval` 应答 →
`plan_approval_request` / `_resolved` / `_expired` 三条 durable 合成事件。

四个设计决定：

1. **默认关**。宿主也被脚本化驱动（eval、契约测试、无人值守）——默认阻塞会把
   那些场景全部挂死，而"挂死等人"正是 V-01 修掉的那类失效。
2. **挂起点在第一个子任务发射之前**，所以否决 = 零副作用地停下。这正是签字位
   该在的位置（真机实测：门挂起时事件来源只有 `host` / `planner`）。
3. **否决不是 error**：`stopReason = "plan_rejected"`、`run_end.outcome = "rejected"`，
   徽章"计划未获批准"（warn 不是 bad）。混进 error 界面会显示"异常终止"，
   那是对委托方自己的决定说谎（V-04 的教训）。
4. **挂起态归 ActionRail，已决/过期归 Plan 面**——同一条不在两处重复展示（V-16）。
   收尾时必须宣告过期并解除挂起，否则编排协程永远吊在 onPlan 里。

**只做批准/否决，不做"否决 + 反馈 → 重新规划"**：那需要把反馈喂回 planner
并重跑，是另一个设计（且与 §5.2 的判据问题耦合），值得单独一轮。

**真机验证**（deepseek-v4-pro，浏览器点击）：否决 → 零子任务执行、徽章
"计划未获批准"、全页无"异常终止"字样、Plan 面留下"✗ 计划被否决 · 时间 ·
一个子任务都没有发射"；批准 → 签字位退出待办区、状态保持运行中、直播条随即
显示子任务的工具调用。axe 另加一条挂起态扫描——这是**阻塞式**交互，
键盘/读屏用不了它等于整个运行卡死。

**顺带修掉一个先于本功能就存在的缺陷**（真机验证时撞出来的，见第八节）。

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
- **排查 UI 先确认自己观察的时机**（2026-08-07 踩到）：验文本流式时第一轮
  "失败"其实是我在 run 结束后才点开它——`ensureSubscription` 对终态 run
  按设计不订阅，行为完全正确。先看时序，再怀疑代码。

---

## 八、真机验证撞出来的既有缺陷（2026-08-07）

**编排模式下客户端在 planner 结束时就收摊。**

`ui/public/app.js` 的 `applySegmentDone` 有条快路径：非核查模式下 `done` 即判
整个 run 终止。它不限定来源，而**编排模式下 planner 自己那一轮也发
`done(completed)`**。于是客户端在 planner 一结束就把状态置为 done，控制器随即
`es.close()`——之后的 `plan` / `plan_result` / 子任务进度 / `run_end` 全部收不到，
界面停在"已完成"，还把 planner 的 JSON 当执行者报告展示。

- **触发条件**：`mode=plan` 且未勾"开启独立核查"——**选了"计划编排"之后的默认组合**。
  勾了核查则 `state.verify` 为真、快路径不生效，所以此前的浏览器实测没撞上。
- **它就是 V-01 那条「段终止 ≠ run 终止」**。当时在事件层修过（`done` 只记段，
  run 级收敛由 `run_end` 宣告），**reducer 侧漏掉了同一条**。
- **修法**：快路径限定 `source === "main"`；planner 与 `sN/main` 的 done 不终止 run。
  三条回归锁（planner done / 子任务 done / 单跑 done）。
- **怎么发现的**：做 §5.1 的真机验证时，服务端明明是 `plan_rejected`，界面却显示
  "已完成"。把服务端事件拉下来**在页面里用同一份 reducer 重新 reduce 一遍**，
  得到的状态是对的——于是判定不是 reducer 错，是实时投递断了。这个"重放对比
  live"的手法值得留用：它一步就把"派生逻辑错"和"事件没收到"分开了。

**教训**：一条修在 A 层的纪律，要回头查它在 B 层有没有同构的漏网。
V-01 修的是服务端事件语义，reducer 是另一处同样需要它的地方。

# UI v2 · 关闭状态

对照 [`remediation-v2.md`](remediation-v2.md) 的问题编号（V-01~V-21）与验收标准
（AC2-01~AC2-18），逐条记录关闭状态与证据。

**状态图例**：⬜ 未开始 · 🔧 实施中 · ✅ 关闭（附第一手证据）· ⚠️ 部分关闭（附缺口）

基线 HEAD：`632fdb8`（225 测试 / 16 文件全绿）

---

## 问题项（V-01 ~ V-21）

| 编号 | 等级 | 轮次 | 状态 | 证据 |
|---|---|---|---|---|
| V-01 返工轮审批永久挂死 | P0 | R1 | ✅ | 段终止与 run 终止在事件层分开：`done` 只记段，run 级收敛由新的 `run_end` 宣告。**浏览器实证**：返工轮审批卡（`tu_write#20`，seq 20 在主轮 done 之后）带可点的"允许本次"渲染、运行状态仍为"运行中"；点击后运行正常收尾、裁决通过。**双向自检**：临时把状态机改回旧逻辑（任何 done 都终止）→ 回归锁「核查模式下主轮 done 不终止 run」立即失败 |
| V-02 审批决策不进事件流 | P0 | R1 | ✅ | 新增服务端 `approval_resolved` / `approval_expired` 合成事件，决策落进 `run.events`。**浏览器实证**：应答后刷新页面重新订阅，审批卡仍显示"已允许 + 2026-08-06 13:46:20"、概览"审批记录"含该条（旧实现刷新后显示"已过期"）。契约测试覆盖决策/理由/主体/时间四要素 |
| V-03 审批卡跨轮串卡 | P0 | R1 | ✅ | 审批唯一键改 `approvalId = toolUseId#requestSeq`（服务端 Map 键、DOM `data-approval-id`、HTTP 路径均用它，`#` 经 encodeURIComponent 传输）。**双向自检**：把 `markApprovalResolved` 改回按 toolUseId 全量匹配 → 回归锁「同一 toolUseId 跨返工轮不串卡」立即失败 |
| V-04 stopReason 六值压二值 | P0 | R1 | ✅ | 新增 `classifyStopReason` 六值分档（tone/label/hint），详情页头与概览大徽章均改用它；`max_turns`/`error` 的提示直说"核查救不了这一类"，`max_tokens` 给出提高 AGENT_MAX_TOKENS 的补救。服务端 `done` 补 `error.message`（此前整条丢弃，前端只能写死"运行异常终止"）。新增 `status--warn` 语义色 |
| V-05 SSE 断线误判过期且不重连 | P0 | R1 | ✅ | `onerror` 不再 `es.close()`（那会掐死浏览器原生的 Last-Event-ID 自动重连）也不再把挂起审批标 expired，只渲染重连提示条；服务端帧带 `id:`、`serveSSE` 读 `Last-Event-ID` 只补发缺口；reducer 侧 `reduceEvents` 以 `lastSeq` 幂等兜底（同批事件重放两次状态深相等）。`selectRun` 拆为 `ensureState` + `ensureSubscription`，修掉"断过线的 run 重新打开不重订阅" |
| V-06 verifier 在 Web 上无白名单 | P1 | R2 | ✅ | `buildVerifyOptions()` 把 pack 的 `verify.instructions` / `readOnlyCommands` / `rubric`（env 优先）传给 runVerified；`buildConfig()` 补 guardrails / readRoots / `AGENT_EFFORT`（复用 `EFFORT_LEVELS` 校验，非法值抛错不静默降级）。**双向自检**：抽掉 readOnlyCommands 一行 → 契约测试 v2-7 立即失败（verifier 的 bash 被拒、拿不到 `916 passed`），正是案例 #4 那个 22 轮空转的形态 |
| V-07 成本口径错误 | P1 | R2 | ✅ | `run_end` 带 `executionUsage`（全部执行轮合计）与单列的 `verificationUsage`；用量脚注改为「执行（全部轮次合计）/ 核查 / 返工 N 轮 / 缓存命中」，运行中则显示「本段」并明示口径。契约测试 v2-9 断言 `executionUsage.turns` 严格大于末轮 done 的 turns |
| V-08 中间轮裁决丢失 | P1 | R2 | ✅ | `src/orchestrate.ts` 新增可选 `onVerification(round, outcome)`（纯附加、零行为变化，获批的唯一 src 破例），服务端据此逐轮发 `verification` 事件；`run_end` 另带全量 `verifications[]` + `reworks` + `finalPassed` 供重放兜底。契约测试 v2-9 断言两轮裁决俱在且首轮 issues 可见 |
| V-09 usage 事件被当噪声丢弃 | P1 | R2 | ✅ | `usage` 事件进 `usageByTurn`，不再落 default 分支渲染成空的 `• usage` 行；新增纯函数 `deriveContextUsage`。**口径要害**：水位分子取最近一轮输入而非累计——`ContextManager.noteUsage` 是赋值不是累加，按累计画会得到永远即将压缩却永不压缩的假警报。三条 reducer 测试锁住该口径 |
| V-10 直播重渲染摧毁焦点与输入 | P1 | R3 | ⬜ | |
| V-11 日志混排且来源不可辨 | P1 | R2/R4 | ⬜ | |
| V-12 工具结果显示 ID / 耗时不可读 | P1 | R4 | ⬜ | |
| V-13 列表顺序不一致 | P1 | R2 | ✅ | `/api/runs` 按 createdAt 降序，与客户端乐观 unshift 一致（此前新任务 3 秒后会从列表顶跳到底）；契约测试 v2-10 断言最新在前 |
| V-14 列表元数据依赖订阅历史 | P1 | R2 | ✅ | 列表补 `stopReason` / `finalPassed` / `reworks` / `verdict` / `pendingApprovals` / `packName`，全部由服务端持有，不再取决于该 run 是否被订阅过 |
| V-15 text_delta 全量缓冲 | P1 | R2 | ✅ | 改走命名通道 `event: delta`，不占 seq、不进 `run.events`（此前一次长运行几万条 delta 会在晚订阅/重连时全量重放）。契约测试 v2-11 先断言 delta 确实产生过再断言它不在缓冲里——避免"没触发所以通过"的假绿（初稿正是这样写错的：`onDelta` 是 `send` 的第二个参数，不是 request 上的属性） |
| V-16 信息重复 / 双重转义 / alert | P1 | R3/R4 | ⬜ | |
| V-17 首屏不呈现四决定因素 | P2 | R4 | ⬜ | |
| V-18 工具面与边界不可见 | P2 | R2/R4 | ⚠️ 数据面就绪，呈现在 R4 | 新增 `GET /api/harness`：包名/描述/核查三件套/工具面（含 auto·ask 与 builtin·mcp 来源）/ MCP 状态 / 只读根 / 护栏 / effort（含 compat 下是否实际发送）/ 核查预算 15 / 压缩水位 0.8。**MCP 默认关**（`AGENT_UI_MCP=1` 显式开）——stm32-debug 声明 swd-probe 独占，常驻宿主默认连接就是案例 #3 那种攥着探针的僵尸会话。契约测试 v2-8 另断言快照不含密钥 |
| V-19 通过带备注未降级 / 不可逆无语域 | P2 | R4/R5 | ⬜ | |
| V-20 单一暗色主题 / 字号过小 | P2 | R5 | ⬜ | |
| V-21 缺 launcher | P2 | R1 | ✅ | 新建 `ui/serve.ts` + `npm run ui`；默认绑 `127.0.0.1`（该宿主能执行 bash 并批准写文件，非本地地址会打警告）；SIGINT/SIGTERM 优雅关停。顺带把 `ui` 纳入 tsconfig `include`——此前 `ui/serve.ts` 这类未被测试导入的文件根本不受类型检查 |

## 验收标准（AC2-01 ~ AC2-18）

| 编号 | 状态 | 说明 |
|---|---|---|
| AC2-01 返工轮审批可应答 | ✅ | 契约测试 v2-1（脚本化 main→verifier(fail)→rework(需审批)，POST 200 且 run 收尾）+ reducer 回归锁 + 浏览器实证 |
| AC2-02 审批审计刷新后不失真 | ✅ | 契约测试 v2-2（全新订阅重放后决策/理由/主体/时间齐全）+ 浏览器刷新实证 |
| AC2-03 同 id 跨轮不串卡 | ✅ | reducer 测试两条（`approval_resolved` 按 requestSeq；`markApprovalResolved` 裸 id 只命中最新挂起卡）+ 契约测试 v2-6 |
| AC2-04 stopReason 六值分档 | ✅ | `classifyStopReason` 六值测试 + "四种非 error 终止不再被当作成功" + `done.error.message` 透出（契约测试 v2-4）；呈现层徽章与提示已接入，完整版式随 R4 的 OutcomeCard |
| AC2-05 SSE 重连与重放幂等 | ✅ | 契约测试 v2-5（Last-Event-ID 只补发 seq 更大的事件）+ reducer 幂等/批量等价/乱序丢弃三条 |
| AC2-06 pack 核查三件套真实生效 | ⚠️ 程序化部分已闭合 | 契约测试 v2-7（白名单命令被放行，抽掉即失败）+ v2-8（`/api/harness` 的护栏/白名单与 `src/presets.ts` 声明同源逐字段一致）。**尚缺**：真实模型端到端跑一次确认 rubric 产出非空 advisory（需 API key，留 R6） |
| AC2-07 数字带口径 / executionUsage | ✅ | 契约测试 v2-9 + reducer 测试「run_end 带来 executionUsage / reworks / finalPassed」；脚注文案明写"执行（全部轮次合计）/ 核查 / 本段" |
| AC2-08 逐轮裁决实时可见 | ✅ | `onVerification` + `verification` 事件；契约测试 v2-9 与 reducer 测试各一条 |
| AC2-09 上下文水位口径正确 | ✅ | `deriveContextUsage` 三条测试，其中「水位口径 = 最近一轮输入 / 上限，不是全 run 累计」直接锁住那个会产生假警报的错误口径 |
| AC2-10 焦点与输入在直播中存活 | ⬜ | |
| AC2-11 1000 事件单帧 < 16ms | ⬜ | |
| AC2-12 日志分段与来源可辨 | ⬜ | |
| AC2-13 首屏四决定因素可读 | ⬜ | |
| AC2-14 双主题对比度门禁 | ⬜ | |
| AC2-15 四视口 × 双主题无溢出 | ⬜ | |
| AC2-16 axe 六画面双主题零 violations | ⬜ | |
| AC2-17 npm run ui 可启动且绑本地 | ✅ | `ui/serve.ts` 落地，默认 `127.0.0.1:4173`；纳入 tsconfig 后受 `npm run typecheck` 覆盖 |
| AC2-18 v1.0 全部条目未回退 | ⬜ | |

## 测试规模

| 阶段 | 单测总数 | 说明 |
|---|---|---|
| v2 基线（`632fdb8`） | 225 | 16 文件 |
| R1 正确性 | 244 | +19：reducer 11（段终止/审批审计/六值/幂等）+ 服务端契约 6 + 既有 2 条随协议演进 |
| R2 数据面 | 256 | +12：服务端契约 5（白名单到达 verifier / harness 快照 / 成本与逐轮裁决 / 列表口径 / delta 通道）+ reducer 7（水位口径 / 成本 / 逐轮裁决 / 工具名回填） |

## 顺带修正的测试仪器缺陷

`test/ui-server.test.ts` 的 `readSSE()` 只按 `data: ` 前缀判断整块，不符合 SSE 规范
（一帧可含 `id:` / `event:` / `data:` 多个字段，顺序不限）。加上断点续传需要的 `id:`
帧头后它会把**所有**事件判为非数据帧而丢弃——表现为一批测试集体超时。已改为按行解析
并跳过命名通道。这不是断言变更，是把测试工具修正到规范；同时为 R2 的 `event: delta`
命名通道预留了正确行为。

（与项目既有的"仪器错误三家族"同源：checker 口径歧义 / eval 宿主审批打穿 /
run.ts 化石版本锁定——**测试工具的漂移比被测代码的缺陷更隐蔽**。）

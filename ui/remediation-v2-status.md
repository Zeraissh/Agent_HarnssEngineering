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
| V-10 直播重渲染摧毁焦点与输入 | P1 | R3 | ✅ | 新增 `core/diff.js`（`diffKeyed`，LCS 求最小 move）+ `dom/patch.js`（`patchList`/`appendOnly`/`setText`/`keepScrollAnchored`）+ `core/batch.js`（事件折叠）。详情页改骨架 + 分区补丁，侧栏与审批栏改键控补丁，日志改只追加，3 秒轮询换成 `GET /api/stream` 推送。**浏览器实证**（脚本化模型实例）：拒绝理由输入在直播重渲染后值与光标位置均保持（`"路径不在只读白名单内"` / `selectionStart=5`）、输入框与卡片是同一节点对象；日志 56→59 条时前 56 个节点全部复用；贴底时跟随、上翻时不被拽回；侧栏焦点连续 38 秒不失焦（旧实现 3.6 秒即变 `BODY`）。**实测抓到并修掉一个自造 bug**：首版只用 `requestAnimationFrame`，而隐藏标签页不触发 rAF——事件在队列里无限堆积、界面永不更新，后台标签页等审批的人一直等不到卡片，等于换个门重造了 V-01 那类失效；已改为隐藏时退回定时器 + `visibilitychange` 立即补齐，并以 `createBatcher` 常驻回归锁死 |
| V-11 日志混排且来源不可辨 | P1 | R4 | ✅ | 新增纯函数 `deriveSegments` 把时间线按来源切段（前缀式来源 `s1/main` 也归类，为并行编排预留），日志段首插入分界：`◆ 核查 Agent 独立复核（全新上下文）` / `↺ 核查未通过，开始返工（第 N 轮）`——`↺` 与 CLI 同款（`src/cli.ts:449`）。Loop 面另加返工裁决序列。**浏览器实证**：核查模式 run 渲染出三条分界与链条 `■ 主轮 ▸ ✘ 核查 0 ▸ ■ ↺ 返工 1 ▸ ✘ 核查 1`，F→F 一眼可辨 |
| V-12 工具结果显示 ID / 耗时不可读 | P1 | R4 | ✅ | `tool_result` 事件不带 name（`src/loop.ts:259-264`），在 `deriveLogEntries` 按 `toolUseId` 回填，渲染层不必知情；耗时改 `formatDuration`。**浏览器实证**：条目显示 `read_file 失败 · 4ms`，全页扫描无裸 `toolu_*`／`tu_*`（此前是 `tu_0 失败 · 124757ms`）|
| V-13 列表顺序不一致 | P1 | R2 | ✅ | `/api/runs` 按 createdAt 降序，与客户端乐观 unshift 一致（此前新任务 3 秒后会从列表顶跳到底）；契约测试 v2-10 断言最新在前 |
| V-14 列表元数据依赖订阅历史 | P1 | R2 | ✅ | 列表补 `stopReason` / `finalPassed` / `reworks` / `verdict` / `pendingApprovals` / `packName`，全部由服务端持有，不再取决于该 run 是否被订阅过 |
| V-15 text_delta 全量缓冲 | P1 | R2 | ✅ | 改走命名通道 `event: delta`，不占 seq、不进 `run.events`（此前一次长运行几万条 delta 会在晚订阅/重连时全量重放）。契约测试 v2-11 先断言 delta 确实产生过再断言它不在缓冲里——避免"没触发所以通过"的假绿（初稿正是这样写错的：`onDelta` 是 `send` 的第二个参数，不是 request 上的属性） |
| V-16 信息重复 / 双重转义 / alert | P1 | R4 | ✅ | ① unverified 只在 ActionRail 出现一次，裁决卡内那份改为下钻详情——实证全页 `需 od 复核` 出现次数 = 1（此前 2）；② `entryActionLabel` 内的 `esc()` 全部移除，转义只在 `renderLogEntryHeader` 做一次；③ `alert()` 换成 `role="alert"` 的行内错误区，带 HTTP 状态码与服务端文案——alert 会抢焦点、阻塞整页、播报时机不受控 |
| V-17 首屏不呈现四决定因素 | P2 | R4 | ✅ | L2 重构为「页头 → 需你决定 → 直播 → 结果 → 四决定因素 → 下钻」，日志降为 Loop 面的下钻内容（组织原则见 `docs/01-philosophy.md:5-12`）。新增五个派生纯函数 + `buildFactorCards`；**异常面自动排到网格首位**。L3 标签从「概览/日志/核查」改为 Loop/Context/Tools/Verification，配 hash 路由 `#/run/<id>/<face>`。**浏览器实证**：分区顺序逐一核对；15 次工具失败时 Tools 卡带异常边框排首位；深链刷新后 run 与面双双恢复（`#/run/<id>/verify` → `aria-labelledby=tab-verify`）|
| V-18 工具面与边界不可见 | P2 | R2/R4 | ✅ | 新增 `GET /api/harness`：包名/描述/核查三件套/工具面（含 auto·ask 与 builtin·mcp 来源）/ MCP 状态 / 只读根 / 护栏 / effort（含 compat 下是否实际发送）/ 核查预算 15 / 压缩水位 0.8。**MCP 默认关**（`AGENT_UI_MCP=1` 显式开）——stm32-debug 声明 swd-probe 独占，常驻宿主默认连接就是案例 #3 那种攥着探针的僵尸会话。契约测试 v2-8 另断言快照不含密钥。**R4 补上呈现层**：Tools 面列工具芯片（名 + auto/ask + 调用数 + 失败数）、运行边界清单（包/核查模式/只读白名单/bash 运行时/工作目录/额外只读根/护栏/MCP）、被拒记录与失败后的改道；Verification 面另列核查者边界（白名单/预算 15 轮/评分表来源）。快照缺席时照实降级为「未获取到工具清单」，不编造 |
| V-19 通过带备注未降级 / 不可逆无语域 | P2 | R4 | ✅ | `pass_with_notes` 成为独立第四态（`passed && issues.length`），徽章 `✔ 通过（有备注）`、issues 用 `⚠` 走 warn 色——对齐 CLI `src/cli.ts:276`，项目有两个真实案例是「通过但备注里藏着真 bug」。压缩另起 `.callout--irreversible` 语域（双线左边框 + 区别于 warn 的底色），文案明写「被置换的原文永不可恢复」。**浏览器实证**：徽章类名为 `outcome-verdict--pass_with_notes`、issues 为 `outcome-issues--warn` |
| V-20 单一暗色主题 / 字号过小 | P2 | R5 | ✅ | 三层令牌（`--p-*` 原始色板 → 语义层 → v1 兼容别名）；**浅色温暖纸面为默认**、暖炭深色为次要，配 `prefers-color-scheme` + `[data-theme]` 手动覆盖 + `<head>` 内联脚本从 localStorage 恢复（首帧前就位，无闪白）。主题按钮三态循环 auto/light/dark。字号下限抬到 12px（删 `--font-xs: 11px` 与三处硬编码 10px），正文 14px；衬线 `Georgia, Noto Serif SC` 只用于大字号标题。**关键一坑**：Claude 标志性陶土 `#C15F3C` 直接用是不合格的——白字 4.23:1、纸面 4.01:1 双双低于 4.5，与 R-06 那个 2.53:1 蓝按钮同型；调深到 `#B0522F` 才双向达标（5.13 / 4.87）。**浏览器实证**：三态切换与 localStorage 持久化、页面最小实渲字号 = 12px、纸面各层取值符合设计。**委托方看到成品截图后指出 emoji 与主题不符**——根本问题不是审美：emoji 是自带调色板的彩色字形，CSS `color` 对它们无效，无法参与主题系统。已全部换为单色排印符并向 CLI 收敛（`→ ✓ ✗ ⚠ ⟳ ■ ✔ ✘ ⋯ ◈ ↺ ──`，压缩另用 `⊟` 以保持不可逆语域独立）；门禁用 Unicode `Emoji_Presentation` 属性判定而非手列黑名单，上线即抓到两处肉眼难辨的 `⚠️`（带 U+FE0F 变体选择符）|
| V-22 hidden 属性被作者 display 规则压过（截图暴露） | P0 | R5 | ✅ | UA 样式表的 `[hidden]{display:none}` 优先级极低，`.live-strip{display:flex}` 这类作者规则直接压过它。后果是**一个已经异常终止的运行仍挂着绿点显示「等待模型响应…」**——界面在说谎，正是本轮信息架构最不能犯的错。全表只有 `.reconnect-banner[hidden]` 单独写过覆盖，其余全靠 UA 规则，一律失效。已加全局 `[hidden]{display:none!important}` 从结构上消灭这一类，而不是逐组件打补丁。**浏览器实证**：复刻截图场景（认证失败 → 异常终止）后 live-strip `display:none` 且「等待模型响应」从页面文本消失；切回运行中恢复 `display:flex` 并正常显示当前工具调用——双向成立，不是简单地永久隐藏 |
| V-23 无会话正史视图 | P2 | R6a | ✅ | `AgentRunResult.messages` 一直存在却从没透出（SSE 只带 messageCount，几 MB 会话不能进事件缓冲）。服务端逐段落盘到 `StoredRun.transcript`，新增 `GET /api/runs/:id/transcript` 按需拉；Loop 面加「事件流 / 对话」视图切换，只在用户真的点开对话时才付这笔代价。**渲染要害**：Anthropic 协议把 tool_result 放在 **user 角色**里回传，照 role 直接画气泡会显示成「用户对着 agent 念了一堆命令输出」——按内容块类型分派，工具返回归工具那一侧。**浏览器实证**：对话区渲染出「委托方 …／¶ Agent …」，事件流与对话双向切换正常 |
| V-24 harness 旋钮不可调 | P2 | R6a | ✅ | 提交栏加可折叠「装配」区：领域包下拉、思考预算、主观评分表；可选值由 `/api/harness` 的 `availablePacks` / `effortLevels` 提供，前端不硬编码。`POST /api/runs` 接 pack/effort/rubric，**非法值当场 400 而非静默降级**（口径同 `src/cli.ts` 对 AGENT_EFFORT 的处理）。`buildConfig`/`buildVerifyOptions` 从进程级常量改为逐 run 可覆盖。**顺带修掉一个自己引入的说谎**：pack 可逐 run 换之后，Tools 面若继续读进程级 `/api/harness`，用户选了 ts-coding 却会看到默认包的工具面与白名单。新增 `run_config` 合成事件承载本 run 实际装配，四个面一律优先读它。**浏览器实证**：选 ts-coding + effort low 提交后，Tools 卡显示「包 ts-coding · 3 个工具」、边界清单是 ts-coding 的真实白名单、Loop 卡显示「1/40 轮 · effort low」|
| V-25 侧栏无搜索 | P2 | R6a | ✅ | 新增纯函数 `filterRunsByQuery`（按任务描述子串，大小写与首尾空白无关）+ 侧栏搜索框。列表走键控补丁，边打字边过滤不打断输入焦点（实证）|
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
| AC2-10 焦点与输入在直播中存活 | ✅ | 浏览器实证：拒绝理由值与光标存活、输入框与审批卡为同一节点对象、侧栏焦点 38 秒不失焦（旧实现 3.6 秒即死）；jsdom 回归锁 6 条（含节点同一性用 `toBe` 而非 `toEqual`、渲染幂等、滚动跟随双向） |
| AC2-11 1000 事件单帧 < 16ms | ⚠️ 折叠次数已锁，耗时未量化 | `createBatcher` 测试断言 1000 条事件只触发 1 次 flush（锁死 O(n²) 不回归）；日志侧 1000 行渲染后再来一条只新增 1 个节点、首节点仍是原对象。**尚缺**：真实浏览器的单帧毫秒数测量，留 R6 |
| AC2-12 日志分段与来源可辨 | ✅ | `deriveSegments` 三条测试（四段切分与轮次、单段不产生虚假分界、并行前缀来源归类）+ 浏览器实证三条分界与返工链 |
| AC2-13 首屏四决定因素可读 | ✅ | 新增 `test/ui-faces.test.ts` 33 条覆盖五个派生函数与 `buildFactorCards`；浏览器实证两个「第一眼」场景、异常面加权排序、hash 深链恢复 |
| AC2-14 双主题对比度门禁 | ✅ | 解析器升级为**括号配平扫描**（旧的 `/:root\s*\{([^}]*)\}/s` 只抓第一个 `:root`、不跨嵌套，@media 内的一个都抓不到——双主题下会在「只看了浅色」的情况下全绿）。断言面积 5 条 → **46 条**（2 主题 × 23 组色对），另加三条结构门禁：两主题原始色板令牌名集合一致、媒体查询暗色块与手动暗色块逐字段一致（防漂移）、组件层不得直接引用 `--p-*`。裸色值检查从「除 :root 外」扩为「除全部主题块外」 |
| AC2-15 四视口 × 双主题无溢出 | ✅ | **32 种组合零溢出**（390/768/1280/1440 × light/dark × Loop/Context/Tools/Verification），逐格实测 `scrollWidth - clientWidth`。窄屏另确认侧栏 `display:none` 与返回按钮在位（R-02 原始要求）。200% 缩放零横向溢出、标签与主操作齐全（AC-09 未回退）|
| AC2-16 axe 六画面双主题零 violations | ✅ | 画面集合随新 IA 扩为八个（空态 / 列表 / Loop / Context / Tools / Verification / 窄屏 / 宿主快照缺席降级），**两套主题各扫一遍共 16 次，violations 恒空**。另加一条「切换主题不改变可访问性树」：同一画面两套主题的 ARIA 快照逐项相等——「主题只改颜色不改结构」是需要被证明的，不是假设的 |
| AC2-17 npm run ui 可启动且绑本地 | ✅ | `ui/serve.ts` 落地，默认 `127.0.0.1:4173`；纳入 tsconfig 后受 `npm run typecheck` 覆盖 |
| AC2-18 v1.0 全部条目未回退 | ⬜ | |

## 测试规模

| 阶段 | 单测总数 | 说明 |
|---|---|---|
| v2 基线（`632fdb8`） | 225 | 16 文件 |
| R1 正确性 | 244 | +19：reducer 11（段终止/审批审计/六值/幂等）+ 服务端契约 6 + 既有 2 条随协议演进 |
| R2 数据面 | 256 | +12：服务端契约 5（白名单到达 verifier / harness 快照 / 成本与逐轮裁决 / 列表口径 / delta 通道）+ reducer 7（水位口径 / 成本 / 逐轮裁决 / 工具名回填） |
| R3 细粒度渲染 | 285 | +29：新增 `test/ui-patch.test.ts` 24（`diffKeyed` 6 / `patchList`·`appendOnly` 5 / 滚动锚定 2 / `createBatcher` 4 / 详情页与侧栏状态存活 7）+ 服务端契约 1（`/api/stream`）+ 由源码扫描升级为真实 DOM 断言 4 |
| R4 新信息架构 | 321 | +36：新增 `test/ui-faces.test.ts` 33（段切分 3 / Loop 面 6 / Context 面 4 / Tools 面 5 / Verification 面 5 / ActionRail 2 / 因子卡 4 / 标签归一 2 / 工具名回填 2）+ a11y 画面随新 IA 扩为 8 个并新增「旧标签 id 归一」1 条 |
| R5 视觉语言 | 395 | +21：对比度门禁 5 → 46（2 主题 × 23 色对，净 +41 断言归入 4 个 `it.each`）+ 主题结构门禁 3（令牌名集合一致 / 暗色块防漂移 / 组件层不碰 `--p-*`）+ 字体阶梯 4 + a11y 双主题 16 画面与 ARIA 快照一致 1 + emoji 门禁 3 与 hidden 兜底 2 + 卡片即标签/Verification 恒在/搜索 8（两轮截图反馈）|
| R6a 对话视图 + 装配旋钮 | 414 | +19：对话渲染 7（含「tool_result 在 user 角色下」这条要害与双主题 axe）+ 服务端契约 4（transcript 按需拉且不进 SSE / 404 / 逐 run 装配非法值 400 / 快照列包与档位）+ 逐 run 装配优先级 4 + 搜索 4 |

## R3 把两条静态断言升级为真实 DOM 断言

`test/ui-app.test.ts` 的 #29 与 #32b 原本是扫 `app.js` 源码找 `role="option"` /
`aria-labelledby` 字面量。渲染层改用 `setAttribute` 之后字面量消失，测试随之失败。
**做法是升级而不是删除**——迁到 `test/ui-a11y.test.ts` 在渲染结果上查真实节点，
并逐条确认新断言严格强于旧断言：

| 旧（源码扫描） | 新（真实 DOM） | 强在哪 |
|---|---|---|
| `app.js` 含 `role="option"` / `tabindex=` / `aria-selected=` | 渲染后每个 `.run-item` 三者俱全，**且 `aria-selected` 真的落在被选中那一项上**、父容器为 `listbox` | 字面量在场 ≠ 属性挂对了对象；选中态是动态值，字符串扫描永远看不见 |
| `app.js` 含 `role="tabpanel"` 邻近 `aria-labelledby` | 每个 tab 的 `aria-controls` 指向面板、面板 `aria-labelledby` 反指当前 tab，**且切换标签后引用跟着换、`getElementById` 不悬空** | 反向引用一旦悬空，屏幕阅读器报不出面板名——这正是 s3d 那两处结构缺陷的形态 |

另新增「重渲染复用节点：选中态更新但 DOM 节点是同一个」与 roving tabindex 的 DOM 断言。
这与 s3d 的教训同源：字符串断言抓不住父子契约，也抓不住动态属性。

## 顺带修正的测试仪器缺陷

`test/ui-server.test.ts` 的 `readSSE()` 只按 `data: ` 前缀判断整块，不符合 SSE 规范
（一帧可含 `id:` / `event:` / `data:` 多个字段，顺序不限）。加上断点续传需要的 `id:`
帧头后它会把**所有**事件判为非数据帧而丢弃——表现为一批测试集体超时。已改为按行解析
并跳过命名通道。这不是断言变更，是把测试工具修正到规范；同时为 R2 的 `event: delta`
命名通道预留了正确行为。

（与项目既有的"仪器错误三家族"同源：checker 口径歧义 / eval 宿主审批打穿 /
run.ts 化石版本锁定——**测试工具的漂移比被测代码的缺陷更隐蔽**。）

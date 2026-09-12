# 12 · 企业评审优化清单

来源：2026-09-12 五角色评审（产品 / 一线 / 工程 / 设计 / 安全成本）。总裁决「部分能」。
战略选择：FATHOM 主线（本机委托方控制台），设计当场景，不并行当主品牌。
本周只做诚实与收口。P0 不齐就不要对外演示设计模式，也不要把第二人加进默认装配。
成熟度台账仍是 `docs/08-maturity-optimization-checklist.md`；设计拍板仍是 `docs/10-design-mode-evolution.md`。
本文件不替代那两份，也不往 08 里糊条目。勾选条件：对应验收落地。机制已有、只缺默认值的，不要重写一遍。

---

## 和别的清单怎么分工

- `docs/06-backlog.md`：日常交接与开放项。本清单不重开 Wave 2（EVAL / OBS / RUN / MEM）。
- `docs/08`：生产成熟度（隔离、held-out、覆盖率、GOV）。重叠处只写「见 08 某号」，不另起编号。
- `docs/10`：设计模式已拍板范围。本清单的「明确不做」与 10 号 §0.7 对齐，不翻案。

**为什么不把五人散文再写一遍**：评审已经在同会话 canvas `enterprise-role-review.canvas.tsx` 里。这里只留可勾选动作。

---

## P0 · 本周（不修就不要对外演示设计模式 / 不要把第二人加进默认装配）

合并顺序按评审已对齐的 A→F。拆成可独立验收的勾选项，不另起炉灶。

### A · 对外身份

- [ ] **P0-A** 对外只留一句承诺：本机委托方控制台；FATHOM 是控制台名，设计是模式不是产品。
  - **为什么**：产品身份分裂——README 讲 harness、窗口写 FATHOM、包名 agent-harness、首页像设计工作室。谁点名：产品 · 一线。
  - **验收**：安装包名、窗口标题、README 首段、空态 hero 四字一致；文案不再并排卖「AI 设计工作室」。
  - **主责**：产品
  - **证据**：`README.md`；`cross-app/electron/`；`ui/public/index.html`；`ui/public/app.js` 空态

### B · 菜单只暴露真种子

- [ ] **P0-B** 菜单只暴露有真种子的类型；`seed=blank` / `capability=missing` 标「从空白」或下架。杂志风不得指向三页说明书充完整模板。
  - **为什么**：21 个类型、真种子约 5 个；blank 却标 `capability: ready`；点三维 / 财务 / 视频会交空白 HTML。谁点名：产品 · 一线 · 设计。
  - **验收**：新用户 3 次点击不落到空白 `index.html`，除非显式选「从空白」。chip 能读出 blank / missing。`guizang-ppt` 不得暗示独立杂志模板。
  - **主责**：产品 + 设计
  - **证据**：`src/design-mode.ts`（`RAW_CATALOG`）；`templates/design/`；`ui/public/app.js` 设计 chip

### C · 导出诚实 + 冻结核

- [ ] **P0-C1** 导出 PowerPoint 后界面读出 `lossy[]`（渐变未保留、双栏降级、装饰进备注）。
  - **为什么**：转换器已记损失，画布只说「已导出」。谁点名：设计 · 产品 · 一线。
  - **验收**：下载 PPTX 后可见损失条；`lossy` 非空时不得只显示成功。
  - **主责**：设计 + 一线
  - **证据**：`src/deck-pptx.ts`；`ui/server.ts` 导出回传；`ui/public/features/artifact-canvas.js`（当前零次读取）

- [ ] **P0-C2** 冻结或删除仓库根目录过期 `deck-basic/`，只留 `templates/design/deck-basic/`。
  - **为什么**：根目录副本会让人（和模型）抄到旧皮，和正式种子打架。
  - **验收**：根目录不再有可被播种/演示误用的 `deck-basic/`；文档只指向 `templates/design/deck-basic/`。
  - **主责**：设计
  - **证据**：`deck-basic/`；`templates/design/deck-basic/`

### D · 默认不再劝退

- [ ] **P0-D1** 新安装默认关闭自动放行（`defaults.autoApprove = false`）。已有本机若写过 true，升级文案说明一次，不静默改老设置。
  - **为什么**：空态「写」示例会在自动放行开着时对着默认目录落盘。谁点名：一线 · 安全 · 工程。
  - **验收**：干净配置下空态「写」必须真弹审批。API 默认关已有测试锁，不要重做 API。
  - **主责**：一线
  - **证据**：`ui/public/features/settings.js`（`defaultSettings().defaults.autoApprove: true`）

- [ ] **P0-D2** 运行中提供独立停止按钮；发送键不再身兼停止。
  - **为什么**：空框点发送才是停止，要停的人会先打字。侧栏会话卡已有 `cc-stop-btn`，作曲家没有。
  - **验收**：运行中发送仍是发送/插入；停止是单独控件，禁用态不能比没有更糟。
  - **主责**：一线
  - **证据**：`ui/public/app.js`（空框发送=停止）；`ui/public/styles.css`（`.cc-stop-btn`）

- [ ] **P0-D3** 普通任务也不要默认对着本仓库写。
  - **为什么**：设计模式已有 `~/Fathom` 稿目录；空态「写」仍写当前 workdir，本机默认常是仓库根。
  - **验收**：`npm run ui` 默认工作目录不是本仓库源码树；hello.md 示例写进稿目录或要求先选目录。
  - **主责**：一线
  - **证据**：`ui/public/app.js` 空态「写」；`ui/server.ts` `resolveDesignDraftsDir`

### E · 桌上这份要进门禁或撤回去

- [ ] **P0-E1** 未提交生产面（design-mode / deck-pptx / write-pptx / handoff / pack 等已被 cli/server import 的）整包入库，或从 cli/server 撤回 import。
  - **为什么**：本地已是另一份产品，CI 只守 HEAD。谁点名：工程。
  - **验收**：干净 checkout 可 `npm run typecheck`；CI 看见的就是桌上这份。不要把研究用 `_research/` 塞进生产提交。
  - **主责**：工程
  - **证据**：`src/cli.ts`、`ui/server.ts` 对未跟踪模块的 import；工作树相对 HEAD 的生产面

- [ ] **P0-E2** `write_pptx` 只进 design 包；无包默认工具池也要卸掉。
  - **为什么**：包声明已只挂 design（`test/presets.test.ts` 已锁）；无包时 `builtinByName` 仍全带。脏的是默认工具池，不是内核。
  - **验收**：无包 / 非 design 包的 CLI 与 Web 工具面都没有 `write_pptx`；design 包仍有。
  - **主责**：工程
  - **证据**：`src/cli.ts`（无包回落 `builtinByName.keys()`）；`ui/server.ts` 默认池；`src/presets.ts` design 名单

### F · 第二用户默认（未完成不许加员工）

- [ ] **P0-F** 员工 / 第二用户画像：卸 bash、禁止 auto、武装日预算 + 谱系硬顶、工作目录锁到个人稿目录。
  - **为什么**：最大事故是误批 bash 或打开 auto；日预算默认关；一条令牌=全权。谁点名：安全。
  - **验收**：`npm run ui` 的员工默认不再等于本机全权 + 成本敞开。不要求本周做完一人一令牌（那是 P2 / docs/08 GOV）。
  - **主责**：安全成本
  - **证据**：`.env.example`（`AGENT_UI_DAILY_TOKEN_BUDGET` 注释掉）；`docs/permission-modes.md`；`ui/server.ts` 日账门

---

## P1 · 一季度（决定设计模式留还是收）

做完这些才能回答「设计模式是正式场景还是收进实验室」。不要扩 Open Design 目录，不要做第六套默认皮。

- [ ] **P1-SYS** 把 `ruile-deck` 已验证的 product-grid / stat / vs 收进正式种子；token + 有限组件；`DESIGN.md` 默认播种。
  - **为什么**：正式模板是骨架；ruile-deck 才是天花板，包规第 8 条却在压这套「第六套皮」。谁点名：设计。
  - **验收**：正式 deck/落地种子能用这组组件交差；`DESIGN.md` 新稿默认在；不再另开一套默认皮。
  - **主责**：设计
  - **证据**：`ruile-deck/`；`templates/design/`；`src/presets.ts` `DESIGN_SYSTEM`

- [ ] **P1-EYE** design 包声明 `describe_image`；没配识图就禁用「要配图」样例，不要空跑完再 rubric 叹气。
  - **为什么**：设计自治缺眼；`generate_image` 自陈看不见图；rubric 不影响 `passed`。谁点名：产品 · 设计。
  - **验收**：配了 `AGENT_VISION_MODEL` 时 design 工具面有识图；没配时配图样例不可点，文案写未配置。不重写 `describe_image` 工具。
  - **主责**：设计 + 工程
  - **证据**：`src/presets.ts` design `builtinTools`（现无 `describe_image`）；`src/tools/generate-image.ts`；`src/tools/describe-image.ts`

- [ ] **P1-FIRST** 十分钟第一件成品：填一把执行钥匙 → 点设计 → 默认落地或幻灯 → 预览 → 导出。七个包和权限档后置。
  - **为什么**：第一公里是运维手册。谁点名：产品 · 一线。
  - **验收**：未配钥匙时引导先要钥匙，不先讲工作目录和侧栏；配好后十分钟内能预览并导出一件真种子制品。
  - **主责**：产品 + 一线
  - **证据**：onboarding / 空态（`ui/public/app.js`、`test/onboarding.test.ts`）

- [ ] **P1-HOST** 拆 `ui/server.ts` 与 `ui/public/app.js` 到可审大小。字段同一提交接 reducer（host-lags）。
  - **为什么**：宿主约 1.1 万行；本波未提交再各加三千多行。在巨石上堆公司感功能会再制造「宿主没接」。谁点名：工程。
  - **验收**：能按面（runs / 设计画布 / 设置 / 历史）分开读和测；新 TurnEvent 字段同提交进投影 / 派生 / 渲染。
  - **主责**：工程
  - **证据**：`ui/server.ts`；`ui/public/app.js`

- [ ] **P1-HOFF** `propose_handoff` 升格进 `TurnEvent`；CLI / Web reducer / 渲染三处同提交。
  - **为什么**：handoff 事件不在 `TurnEvent`，是第七个 host-lags 温床。谁点名：工程。
  - **验收**：类型、CLI case、`reduceEvent`、DOM 断言四锁齐；不要各宿主私有形状。
  - **主责**：工程
  - **证据**：`src/tools/propose-handoff.ts`；`src/handoff.ts`；`src/types.ts`（无 handoff 事件）

- [ ] **P1-HOLD** 设计 held-out：3–5 个「入口 HTML 存在 + 契约选择器 + 导出文件存在」用例，不评好看。
  - **为什么**：核查空骨架也能绿；提示词当质量闸会博弈。谁点名：设计 · 工程。
  - **验收**：独立于 `eval/cases.ts` research 集；不改 prompt 追分。工程 held-out（EVAL-01）不要塞进设计用例。
  - **主责**：工程 + 设计
  - **证据**：`eval/cases-heldout.ts`（现无设计面）；`templates/design/` 契约

- [ ] **P1-LEDGER** 日账落盘；核查 / 规划 / 识图 / 生图进同一本账。重启宿主不当加额度。
  - **为什么**：日账进程态；`wrapRoleClient` 不 `bumpDaily`；生图不计 token。谁点名：安全。
  - **验收**：重启后读得出昨日/今日已用；角色调用与生图有账本行。OBS-02 仪表盘仍归 docs/08，这里只收日账诚实。
  - **主责**：安全成本 + 工程
  - **证据**：`ui/server.ts`（`bumpDaily` / `wrapRoleClient`）；`.env.example`

- [ ] **P1-CURVE** 四条成本曲线可看见：执行 / 核查 / 规划 / 视觉（识图+生图），按日与按 run。
  - **为什么**：一线要看花了多少钱，现在提示带 env 名，生图还在账外。
  - **验收**：装配条或用量面能分角色读数；缺配置显示未记账，不显示 $0 冒充免费。
  - **主责**：安全成本 + 一线
  - **证据**：`src/metrics.ts`；`ui/server.ts` usage；`ui/public/app.js` 用量面

- [ ] **P1-CAP** 员工默认成本闸钉死，不把 1M 上下文窗口当成额度。
  - **为什么**：MEM-01 已把窗口（事实）和压缩水位（策略）拆开；窗口已知时水位会跟可用窗口走。员工画像若再跟 1M 走，日消耗没有人能口头解释。
  - **验收**：员工默认显式钉 `AGENT_CONTEXT_LIMIT=150000`（覆盖，不是拆掉窗口分离）+ 武装日账 / 谱系硬顶。单操作员研究默认可以继续跟窗口。不要把压缩水位机制改回「一个数兼任窗口」。
  - **主责**：安全成本
  - **证据**：`src/context-window.ts`；`test/context-window.test.ts`（1M 无覆盖跟窗口）

---

## P2 · 以后

这些要等 P0 诚实、P1 能决定去留之后再做。不要为了「像工作室」提前开工。

- [ ] **P2-SCALE** 预览按画板缩放（16:9 / 1080 方图），不要按宿主窗口随便拉扁。
  - **为什么**：正式种子无画板契约，投影和预览对不齐。主责：设计。证据：`ui/public/features/artifact-canvas.js`；`templates/design/`

- [ ] **P2-PPTX** 正式组件（P1-SYS 收编后）走 PPTX 无损路径；其余继续诚实进 `lossy[]`。
  - **为什么**：有限组件可映射，通用 CSS 盒模型不要做（见下方不做）。主责：设计。证据：`src/deck-pptx.ts`

- [ ] **P2-EDIT** 预览内改字 / 局部改稿，以及变体并排。设计负责人原话：最后才做。
  - **为什么**：现在 Shape/Share 缺的是改字，不是再加类型。主责：设计。证据：`ui/public/features/artifact-canvas.js`

- [ ] **P2-TONE** 审批卡、预算提示改日常用语；不要把 env 名和 JSON 参数甩给委托方。
  - **为什么**：一线放弃路径第 5 步。主责：一线。证据：`src/approval-display.ts`；`ui/public/app.js`

- [ ] **P2-GOV** 一人一令牌、令牌轮换/吊销。不在本清单重开 GOV 编号，做的时候对 `docs/08` GOV-*。
  - **为什么**：一条访问令牌 = 全权管理员。主责：安全成本。证据：`ui/serve.ts`；`docs/08-maturity-optimization-checklist.md`

- [ ] **P2-DATA** 运行档案加密或至少 runbook 写明明文风险；补 LICENSE。
  - **为什么**：8 月审计 high 残留。主责：安全成本。证据：`docs/07-production-runbook.md`；仓库根（无 LICENSE）

- [ ] **P2-PACK** 文件包扩展面做出第一个真实安装实例（草稿→签字→菜单可见）。
  - **为什么**：机制在、零实例，Path B「已安装设计类文件包」是空货架。主责：产品 + 工程。证据：`src/pack-files.ts`；仓库无 `.agent-packs/`

- [ ] **P2-PILOT** 最多 10 人的设计试点。开门条件：P0-F 齐 + 一人一令牌起步；不是「先拉人再补闸」。
  - **为什么**：安全原话：7–10 条合规齐了才谈全员；试点也不是默认装配。主责：产品 + 安全成本

---

## 明确不做

改了会毁研究资产，或五人都反对。不是待办，不要勾选假装以后会做。

| 不做 | 为什么不那么做 |
|---|---|
| 改 `src/router.ts` 加置信度 / 多命中检测 | 产品要的是砍菜单，不是更聪明的分类器。10 号已拍板不改解析契约。 |
| Verifier 改 fail-open；恢复 once-grant；给 bash 做 undo | 案例 #4 / #6 / #8 与 ADR-003。查不了必须诚实降级，不是放行。 |
| `stm32-debug` 加回 bash；连接层白名单改回交集 | v1.0 扫死 MCP；案例 #3 交集陷阱。 |
| 预览打开 `allow-same-origin` 换「更真」 | 产物 HTML 不可信；画布注释已当安全边界。 |
| 通用 CSS→PPTX、Canva 拖拽、v0 全栈发布、视频供应商 | 10 号 §0.7 仍然对。先把办公阵营做诚实。 |
| 把 Windows `report` 隔离改名叫「已沙箱」 | 命令仍以宿主身份执行。`ExecutionBoundaryStatus` 刻意没有 `sandboxed: boolean`。 |
| 把 Open Design 源码 / 277 插件 / 151 设计系统搬进仓库；再扩目录当默认 | 10 号 catalog 冻结范围。ruile-deck 升格 ≠ 第六套默认皮。 |
| 把 `3d-object` 写成 Claude / Kimi 官方类型；对齐未核实的 Kimi 导出 | 10 号 §0.6 / §0.7。 |
| 把本次评审条目糊进 `docs/08` | 08 是成熟度台账，评分和 Gate 口径不同。重叠只交叉引用。 |
| 在 1 万行宿主上再堆公司感功能 / GOV 全套 | 先拆到可审（P1-HOST）。没有「公司」，只有操作员。 |

---

## 对外红线

出现任一条，只许说「HTML 设计台 / 内部过稿」，**不许**说「AI 设计工作室」或「一人公司自治」覆盖设计域：

- 默认种子仍是教程式骨架，或菜单类型没有独立种子
- PPTX 被说成和预览一样（界面没读 `lossy[]`）
- 对方不能接受以浏览器 HTML 为准
- 要品牌包而 `DESIGN.md` 未播种
- 要视频 / 印刷 / Figma / 托管
- 核查只看文件在不在
- 生图被说成会排进版面
- 第二人还在用本机全权默认（bash + auto + 日预算关 + 对着仓库写）

可以对外说的收窄句：在浏览器里用真实 HTML/CSS 做幻灯、规格页、方图和简单落地页；可预览、可点选改稿、可打包 ZIP。多页幻灯能导出可编辑 PPTX，版式会简化。适合内部评审和咨询备忘。工程域可以继续说「委托方定义、agent 在护栏里执行」——那有案例。

---

## 已有机制、不要当新缺口重做

写在这里以免重复立项。不是本清单的待办。

| 已有 | 本清单只收什么 |
|---|---|
| 会话中心化（出错后续跑，docs/06） | 不要撤。一线点名这是成功路径。 |
| 设计稿目录 `~/Fathom`（`resolveDesignDraftsDir`） | 只补普通任务默认目录（P0-D3）。 |
| `write_pptx` 包声明只挂 design | 只卸无包默认池（P0-E2）。 |
| `lossy[]` 服务端记录与 API 回传 | 只做界面读出（P0-C1）。 |
| 日预算门 / 谱系硬顶 / 窗口与水位分离 | 只做默认武装（P0-F / P1-LEDGER / P1-CAP），不重写账本或拆回 MEM-01。 |
| `describe_image` 工具 + kicad 包接线 | 只补 design 包声明与样例门（P1-EYE）。 |
| loop / orchestrate 对 design-mode 零依赖 | 保持。不要为设计线改内核。 |
| 8 月审计已修：剥密钥、凭证读拦截、横幅占位符、密钥不跨厂商回退、SSE 心跳、资源锁 | 不重开。残留见 P2-GOV / P2-DATA。 |
| 画布沙箱、翻页、点评、ZIP | 真能力。缺口在目录诚实和导出损失，不是再做一套预览。 |
| API `autoApprove` 默认关（`test/ui-server.test.ts`） | 只改 UI 新安装默认（P0-D1）。 |

---

## 勾选纪律

- `[x]`：验收证据已取得（测试或干净 checkout 可复现）。
- `[ ]`：未做。
- 不要用 `[~]` 在本清单里表示「机制有了」——机制有了就写进上一节，待办只留残余。
- 禁止把 secrets、`.env` 真值写进本文件或提交信息。

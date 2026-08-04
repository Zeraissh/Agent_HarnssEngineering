# 编排层参考文档（Orchestration Reference）

本文档覆盖 `src/` 下 5 个编排相关模块，逐一说明职责、导出签名与关键设计决策。

---

## orchestrate.ts

### 职责

L4 编排层：主 agent 执行 → verifier 核查 → 未通过则带着问题清单返工。同时提供三角编排（planner → executor → verifier）的顶层入口。

### 导出签名

**接口**

```typescript
export interface VerifiedRunOptions {
  maxReworks?: number;
  reworkMode?: "fresh" | "inherit";
  verifyInstructions?: string;
  verifyReadOnlyCommands?: string[];
  verifierModel?: { client: ModelClient; compat?: boolean };
  onEvent?: (source: "main" | "rework" | "verifier", event: TurnEvent) => void | Promise<void>;
}

export interface VerifiedRunResult {
  main: AgentRunResult;
  verifications: VerifyOutcome[];
  reworks: number;
  finalPassed: boolean;
  executionUsage: AggregateUsage;
}

export interface PlannedRunOptions {
  packs?: DomainPack[];
  resolveSubtask?: (sub: SubTask) => {
    cfg: AgentConfig;
    verify?: Pick<
      VerifiedRunOptions,
      "verifyInstructions" | "verifyReadOnlyCommands" | "verifierModel" | "reworkMode"
    >;
  };
  maxReworks?: number;
  onPlan?: (plan: Plan) => void | Promise<void>;
  onEvent?: (source: string, event: TurnEvent) => void | Promise<void>;
  concurrency?: number | "auto";
  plan?: Plan;
  plannerModel?: { client: ModelClient; compat?: boolean };
  plannerProtocol?: "freeform" | "structured";
  splitRule?: SplitRule;
}

export interface PlannedStepResult {
  sub: SubTask;
  result: VerifiedRunResult;
  durationMs: number;
}

export interface PlannedRunResult {
  plan?: Plan;
  planOutcome: PlanOutcome;
  steps: PlannedStepResult[];
  skipped: SubTask[];
  completed: boolean;
}
```

**函数**

```typescript
export async function runVerified(
  cfg: AgentConfig,
  model: ModelClient,
  task: string,
  opts: VerifiedRunOptions = {},
): Promise<VerifiedRunResult>

export async function runPlanned(
  baseCfg: AgentConfig,
  model: ModelClient,
  task: string,
  opts: PlannedRunOptions = {},
): Promise<PlannedRunResult>

export function planParallelWidth(subtasks: SubTask[]): number
```

**常量**

```typescript
export const AUTO_CONCURRENCY_CAP = 3;
```

### 设计决策

1. **双模式返工（fresh / inherit）**  
   `reworkMode` 控制返工时的上下文策略：`"fresh"`（默认）用全新上下文重跑，避免被上一轮的错误推理污染；`"inherit"` 在上一轮会话正史上续跑，保留探索与工具结果。注释指出 fresh 模式最贵一例曾白烧 127k tokens，上下文增长由 compact 兜底。

2. **纯产物哲学**  
   `runVerified` 的核查触发条件：`max_turns` 时产物可能已就绪，照常核查；只有 `error` 等宿主级失败才短路返回、不做核查。

3. **独立核查者模型**  
   `verifierModel` 允许指定独立于执行者的核查模型。注释记录了 A/B 研究结论：verifier 必须 ≥ 执行者强度，否则假阴性返工是净负。这个口子为"弱执行者 + 强核查者"的正确形态设计。

4. **三角编排并行语义（v1.1）**  
   `concurrency > 1` 时，互不依赖的子任务并发执行。任一子任务核查未通过即停止发射新任务（含与失败者无关的独立分支，因为整体已败，续跑只是烧 token），但在飞的照常跑完（工具有副作用，中途硬断比跑完更危险）。可靠性是乘法，带病继续只会把错误往下游放大。

5. **`"auto"` 并行度**  
   取值 `min(3, planParallelWidth(plan.subtasks))`。注释指出 A/B 采纳结论：拆分率 ~50/50 摇摆下，串行默认让一半 run 白付拆分成本；并行调度零可见开销、token 持平。线性链层宽 1 自动退化，行为不变。上限保守取 3（端点限流与宿主渲染都友好，收益曲线未测满前）。

6. **审批互斥门**  
   并发子任务的 `approval_request` 排队逐个交给宿主——终端审批提示同时弹两个是灾难（应答错配 + 渲染打架）。verifier/planner 的审批由其内部自答，不进排队门（排队等宿主应答会死锁，因为内部自答发生在 `onEvent` 返回之后）。

7. **计划层宽启发式**  
   `planParallelWidth` 按"距根的最长路径深度"分层，取最大层宽——即调度器在某一时刻可能同时就绪的子任务数的近似上界。线性链恒为 1。前提：依赖图已过校验（无环、引用存在）。

8. **事件旁路**  
   `onEvent` 将主/返工 run 及 verifier 的事件转发给宿主（含 `approval_request`——审批仍是宿主的事）。verifier 的事件也转发，但其 approval 已在内部 deny，仅供观察。verifier 的最终 `assistant_text`（裁决 JSON）被压掉不直接展示给用户，只上报一条人类可读的裁决摘要。

9. **子任务输入构造**  
   `buildSubtaskInput` 将子任务描述、验收标准、直接依赖的交接摘要（多依赖多段，带来源标注）拼接为自包含输入。

10. **宿主注入固定计划**  
    `opts.plan` 存在时跳过 planner，直接调度。图非法时抛错——宿主代码 bug 应该炸响，不适用模型输出的 fail-closed。

---

## planner.ts

### 职责

L6 计划单元：把任务拆解为带验收标准与依赖图的子任务序列，支持自由拆解（freeform）与结构化分片枚举（structured）两种协议。

### 导出签名

**接口**

```typescript
export interface SubTask {
  id: string;
  title: string;
  pack?: string | null;
  description: string;
  acceptance: string[];
  dependsOn: string[];
}

export interface Plan {
  subtasks: SubTask[];
}

export interface PlanOutcome {
  plan?: Plan;
  usage: AggregateUsage;
  raw: string;
  inventory?: ShardInventory;
}

export interface ShardInventory {
  shards: {
    id: string;
    title: string;
    pack?: string | null;
    description: string;
    acceptance: string[];
    estTurns?: number;
  }[];
  join?: {
    title: string;
    pack?: string | null;
    description: string;
    acceptance: string[];
  };
}

export interface SplitRule {
  minShards: number;
  minEstTurns: number;
}
```

**函数**

```typescript
export async function runPlanner(
  cfg: AgentConfig,
  model: ModelClient,
  task: string,
  packs: DomainPack[],
  onEvent?: (event: TurnEvent) => void | Promise<void>,
): Promise<PlanOutcome>

export function parsePlan(text: string): Plan | undefined

export function validatePlanGraph(subtasks: SubTask[]): boolean

export async function runStructuredPlanner(
  cfg: AgentConfig,
  model: ModelClient,
  task: string,
  packs: DomainPack[],
  rule: SplitRule = DEFAULT_SPLIT_RULE,
  onEvent?: (event: TurnEvent) => void | Promise<void>,
): Promise<PlanOutcome>

export function parseShardInventory(text: string): ShardInventory | undefined

export function buildPlanFromInventory(task: string, inv: ShardInventory, rule: SplitRule): Plan
```

**常量**

```typescript
export const DEFAULT_SPLIT_RULE: SplitRule = { minShards: 2, minEstTurns: 1 };

export const PLAN_PARSE_FAIL = "planner 输出无法解析为 JSON 计划";
```

### 设计决策

1. **拆分纪律（写进 prompt，来自 v0.9 试点的实证）**  
   单元边界 = 上下文边界，每道交接都有信息损耗。能一次完成的不拆，只在【领域切换】或【产物交接】处切。每个子任务必须带可程序化验收清单（具体的文件、数值、命令可获得的事实；不写"质量好/合理"这类不可验证的话）。

2. **与 verifier 同款纪律**  
   只读探索（approval 一律 deny），全新上下文；最终消息 = 纯 JSON 计划契约；宽容解析 + 解析失败重问一次转写；fail-closed——重问后仍不可解析 → 无计划（宿主决定放弃或降级为单体执行）。计划不该比执行贵：探索预算收紧至 `maxTurns = min(cfg.maxTurns, 12)`。

3. **v1.1 结构化拆分协议（强 planner 证伪后的规则杆）**  
   实测强 planner 无效——拆分摇摆是纪律歧义区的裁量问题而非能力问题。因此引入 `runStructuredPlanner`：planner 只枚举互不依赖的分片（事实清单），拆不拆由宿主 `SplitRule` 确定性判定，模型在决策点零裁量。

4. **`ShardInventory` 与 `SplitRule`**  
   分片清单是 planner 的"事实枚举"输出物——互不依赖的分片 + 可选汇总。`SplitRule` 以 `minShards`（分片数）和 `minEstTurns`（每片预估轮数）判定是否拆分。默认规则按分片数判定（枚举是最事实化的输出，轮数估计最模糊，默认不设门槛只记录）。

5. **`buildPlanFromInventory` 宿主规则构图**  
   纯函数，零模型参与。规则命中 → 分片为并行子任务 + join（若有）`dependsOn` 全部分片；未命中 → 单体子任务（`description` = 原任务全文，验收 = 分片 + join 验收合并——验收清单与拆分方式无关，合并后单 agent 产物仍可逐条核查）。

6. **依赖图校验（v1.1）**  
   `validateGraph` 用 Kahn 拓扑排序：id 重复、dependsOn 引用不存在的 id、成环都会导致整份计划作废（fail-closed，与裁决/计划解析同纪律）。兼容旧计划：整份计划都没写 `dependsOn` 字段时推断为线性链（v1.0 隐式顺序语义）。

7. **解析策略：宽容提取 + fail-closed**  
   `parsePlan` 与 `parseShardInventory` 均采用多候选策略：先从代码围栏提取 JSON，再从全文贪婪匹配最外层 `{…}`；`description` 为空 / id 重复 / `shards` 或 `subtasks` 为空数组均视为无效。解析失败返回 `undefined`。

8. **重问一次转写（不重新规划）**  
   解析失败且原始输出非空时，给模型一次转写机会——让模型按契约格式重述已有结论，而非重新规划。空输出无可转写，直接 fail-closed。

---

## verifier.ts

### 职责

L4 Verifier 子代理：用干净上下文（看不到主 agent 会话历史）独立核查主 agent 的产出，只读纪律由硬约束兜底。

### 导出签名

**接口**

```typescript
export interface Verdict {
  passed: boolean;
  issues: string[];
  summary: string;
}

export interface VerifyOptions {
  task: string;
  executorReport: string;
  verifyInstructions?: string;
  readOnlyCommands?: string[];
}

export interface VerifyOutcome {
  verdict: Verdict;
  usage: AggregateUsage;
  raw: string;
}
```

**函数**

```typescript
export async function runVerifier(
  cfg: AgentConfig,
  model: ModelClient,
  opts: VerifyOptions,
  onEvent?: (event: TurnEvent) => void | Promise<void>,
): Promise<VerifyOutcome>

export function parseVerdict(text: string): Verdict

export function isReadOnlyCommand(command: string, allowedPrefixes: string[]): boolean

export function sumUsage(a: AggregateUsage, b: AggregateUsage): AggregateUsage
```

**常量**

```typescript
export const VERDICT_PARSE_FAIL = "verifier 输出无法解析为 JSON 裁决";
```

### 设计决策

1. **干净上下文验证优于自我批评**  
   Verifier 是一个全新的 `AgentLoop`，复用父级的 `systemPrompt` + `tools`——请求前缀与父级一致，能蹭到 tools/system 层的缓存。但 verifier 看不到主 agent 的会话历史，只看到任务描述 + 执行者报告，必须自己动手核查实际产出（fresh-context 验证）。

2. **只读纪律由硬约束兜底（P6）**  
   Verifier 内部对一切 `approval_request` 自动 deny，`permission="ask"` 的写类工具永远执行不了。唯一例外：bash 命令命中领域包声明的只读白名单（`readOnlyCommands`），且管道后续段限于通用只读过滤器（`grep`、`wc`、`sort` 等）。

3. **核查预算固定，与执行者解耦**  
   核查预算固定为 `VERIFIER_MAX_TURNS = 15`，不随执行者收紧。注释记录了 REPS=5 复现批教训：执行者被压到 `maxTurns=8` 时 verifier 若跟着缩水，核查跑不完，最终消息是半截引言 → fail-closed 噪声淹没实验信号。

4. **裁决重问一次（转写，不重新核查）**  
   核查做了但最终消息不是纯 JSON 时，给模型一次转写机会。注释指出 fail-closed 直接返工会对正确产物空转（A/B 实测烧 10 万级 token），一次重问便宜得多。空输出没有可转写的结论，不重问（转写会变成无依据的编造），维持 fail-closed。

5. **裁决按字面判定**  
   任务与验收标准中的成文数值/条件逐条按字面判定——实测与标准不符时，即使核查者认为行为"实质合理/方向正确/持续递增也算递增"，也必须判 failed 并把"标准值 vs 实测值"写进 issues。标准的对错由任务委托方裁定，不由核查者裁定。

6. **只读命令判定（`isReadOnlyCommand`）**  
   首段必须命中白名单前缀（词边界），全命令禁止重定向（`>`）、链式执行（`;`、`&&`、`||`）、命令替换（`` ` ``、`$(`）。管道后续段允许白名单或通用只读过滤器。注释强调这是"纪律护栏而非安全沙箱"——目标是把 verifier 的独立重推导能力限定在核查动作上，不是抵御恶意。

7. **宽容解析 + fail-closed**  
   `parseVerdict` 兼容 compat 模型的输出习惯（代码围栏、JSON 前后带说明文字）。解析失败 = 不通过——verifier 的输出不可解析本身就是问题，`issues[0]` 恒为 `VERDICT_PARSE_FAIL`。

8. **`sumUsage` 合并用量**  
   将两次 `AggregateUsage` 的 `inputTokens`、`cacheCreationTokens`、`cacheReadTokens`、`outputTokens`、`turns` 分别求和，并重新计算 `cacheHitRatio`。被 `orchestrate.ts` 和 `planner.ts` 共用。

---

## router.ts

### 职责

L6 调度单元：把任务路由到领域包，一次无工具的分类调用（不探索、不拆解），判断任务落在哪个领域包的地盘上。

### 导出签名

**接口**

```typescript
export interface RouteDecision {
  pack: string | null;
  reason: string;
}

export interface RouteOutcome {
  decision: RouteDecision;
  usage: AggregateUsage;
  raw: string;
}
```

**函数**

```typescript
export async function routeToPack(
  cfg: AgentConfig,
  model: ModelClient,
  task: string,
  packs: DomainPack[],
  onEvent?: (event: TurnEvent) => void | Promise<void>,
): Promise<RouteOutcome>

export function parseRouteDecision(text: string, validNames: string[]): RouteDecision
```

### 设计决策

1. **形态最轻的角色单元**  
   与 planner/verifier 同为"角色单元"，但 router 只用一次无工具的分类调用（`tools: []`、`maxTurns: 2`），不做探索、不拆解。

2. **fail-open（与 verifier 的 fail-closed 相反）**  
   路由是便利不是闸门。解析失败 / 未知包名 → 不选包、用默认配置执行。注释解释了原因：选错包的纠错机制在下游（verifier 会发现产出不对），而"路由挂了导致任务跑不了"没有任何纠错机会。

3. **跨领域任务处理**  
   任务横跨多个领域时，router 返回 `pack = null` 并在 reason 里提示"跨领域任务，建议用 --plan 交给计划单元拆解"。

4. **宽容解析**  
   `parseRouteDecision` 与 planner/verifier 同款解析策略：代码围栏 → 贪婪 `{…}` → JSON 解析。包名未注册时降级为 `null` 并附说明。

---

## presets.ts

### 职责

领域包定义：把领域的 harness 内容（工具面、system prompt、核查配置、护栏参数）打包成可切换的配置单元。机制层保持领域无关，换领域 = 换包，不改核心。

### 导出签名

**接口**

```typescript
export interface DomainPack {
  name: string;
  description: string;
  systemPrompt: string;
  builtinTools?: string[];
  mcp?: boolean | {
    includeTools?: string[];
    permission?: "auto" | "ask";
  };
  verify: {
    enabled: boolean;
    mode: "programmatic" | "rubric";
    instructions?: string;
    readOnlyCommands?: string[];
  };
  guardrails?: {
    maxTurns?: number;
    maxTokens?: number;
    contextTokenLimit?: number;
  };
}
```

**函数**

```typescript
export function getPack(name: string): DomainPack | undefined

export function selectPackTools(
  pack: DomainPack | undefined,
  builtinPool: Tool[],
  mcpPool: Tool[],
): Tool[]
```

**常量与类型别名**

```typescript
export const RULE_PRECEDENCE_DISCIPLINE: string;

export const PACKS: Record<string, DomainPack>;

export type Preset = DomainPack;

export const PRESETS = PACKS;

export const getPreset = getPack;
```

### 设计决策

1. **领域包 = 数据/配置，非核心代码**  
   包是五件套：工具（内置名单 + MCP 接入面）、system prompt（领域工作循环 + 黄金规则）、核查（形态 + 领域核查方法）、护栏参数、eval 套件（放 `eval/`，按包命名约定关联）。机制层（loop/context/verifier 纪律/编排）保持领域无关（P1）。

2. **`selectPackTools` 按包纯内存过滤**  
   内置池按 `builtinTools` 名单过滤（缺省全带）；MCP 池按包的 `mcp` 接入面过滤——`false` 全不带，`includeTools` 按原始名匹配（MCP 工具名形如 `${server}__${raw}`）。好处：MCP 只需按 `mcp.json` 连接一次，三角编排的子任务切包不用重连 server。

3. **成文口径优先纪律（rule-precedence）**  
   `RULE_PRECEDENCE_DISCIPLINE` 经 A/B 实证后采纳为全局默认（`eval/ab-report-rulefirst.md`：baseline 7/10 → 加此条款 10/10，副作用检查 8/8 干净）。针对的失败模式：任务给了明确口径（正则/行前缀/映射规则）时，模型的语义直觉会"补全"字面规则漏掉的情况，遵从稳定性仅 ~50%。

4. **stm32-debug 包**  
   面向 STM32 真机烧录与调试，通过 MCP 工具（stm32-gdb-mcp：GDB + OpenOCD/ST-Link）操作真实硬件。不给 `bash` 工具——v1.0 演示实证：给了 bash 执行者会绕开 MCP 自建 openocd/gdb 调试栈，还会 `taskkill` 扫死共享的 MCP server。调试动作全走 MCP，报告用 `write_file`，读产物用 `read_file`。verify mode = `"programmatic"`（产出可独立重新推导/实测比对，高可信）。

5. **stm32-coding 包**  
   面向 STM32 固件编程（C 源码、CMake 交叉编译），不碰硬件——需要真机时切 `stm32-debug` 包。核查必需的最小命令集包括 `cmake --build`、`ninja`、`arm-none-eabi-nm`、`arm-none-eabi-size`、`arm-none-eabi-objdump` 等。verify mode = `"programmatic"`。

6. **兼容别名**  
   `Preset` 为 `DomainPack` 的类型别名，`PRESETS` = `PACKS`，`getPreset` = `getPack`，兼容 v0.8 及之前的命名。

7. **核查形态（mode）**  
   `"programmatic"`：产出可独立重新推导/实测比对（行数、寄存器、构建结果）——高可信；`"rubric"`：主观质量按评分表判（文案、审美）——低一档，裁决只能当参考。

/**
 * L6 — 计划单元（planner）：把任务拆解为带验收标准的子任务序列。
 *
 * 与 verifier 同款纪律：
 * - 只读探索（approval 一律 deny），全新上下文；
 * - 最终消息 = 纯 JSON 计划契约；宽容解析 + 解析失败重问一次转写；
 * - fail-closed：重问后仍不可解析 → 无计划（宿主决定放弃或降级为单体执行）。
 *
 * 拆分纪律（写进 prompt，来自 v0.9 试点的实证）：
 * 单元边界 = 上下文边界，每道交接都有信息损耗——能一次完成的不拆，
 * 只在【领域切换】或【产物交接】处切，且每个子任务必须带可程序化验收清单。
 */
import { AgentLoop } from "./loop.js";
import { sumUsage } from "./verifier.js";
import type { DomainPack } from "./presets.js";
import type { AgentConfig, AggregateUsage, ModelClient, TurnEvent } from "./types.js";

export interface SubTask {
  id: string;
  title: string;
  /** 领域包名；null/缺省 = 用宿主的默认配置执行 */
  pack?: string | null;
  /** 自包含任务书：执行 agent 只能看到它 + 上游交接摘要 */
  description: string;
  /** 可程序化验收清单：下游 verifier 逐条核查的依据 */
  acceptance: string[];
  /**
   * 直接依赖的子任务 id（v1.1 并行编排）：就绪条件 = 全部依赖核查通过，
   * 交接摘要只从这里列出的直接依赖传入。空数组 = 无依赖，可立即执行；
   * 互不依赖的子任务在 concurrency>1 时并发执行。
   * 兼容旧计划：整份计划都没写 dependsOn 时推断为线性链（保持 v1.0 语义）。
   */
  dependsOn: string[];
  /**
   * 子任务级独占资源标签（可选）：设置时【覆盖】包级 resources。
   * 动机（双探针实战）：资源本质是仪器实例级的——两块板的调试子任务同属
   * stm32-debug 包，包级 swd-probe 标签会让它们互斥；只有任务上下文知道
   * 哪个子任务用哪只探针（如 ["probe-stlink"] vs ["probe-daplink"]）。
   */
  resources?: string[];
}

export interface Plan {
  subtasks: SubTask[];
}

export interface PlanOutcome {
  /** undefined = 计划不可解析（fail-closed） */
  plan?: Plan;
  usage: AggregateUsage;
  /** planner 的原始最终输出（审计用） */
  raw: string;
  /** 结构化协议下的分片清单（观测枚举稳定性用；freeform 协议无此项） */
  inventory?: ShardInventory;
}

// ————————— 结构化拆分协议（v1.1 拆分摇摆稳定化,强 planner 证伪后的规则杆） —————————

/**
 * 分片清单：planner 的输出物只是【事实枚举】——互不依赖的分片 + 可选汇总。
 * 拆不拆由宿主的 SplitRule 确定性判定,模型在决策点上零裁量
 * （判断歧义用规则消除,不能用更强判断者掩盖——strongplanner 批的定论）。
 */
export interface ShardInventory {
  shards: {
    id: string;
    title: string;
    pack?: string | null;
    /** 自包含任务书（与 SubTask.description 同要求） */
    description: string;
    acceptance: string[];
    /** 预计工具调用轮数（模型的粗估,记录为观测数据;规则可选用） */
    estTurns?: number;
  }[];
  /** 可选汇总步：只消费分片产物;存在时构图 dependsOn 全部分片 */
  join?: { title: string; pack?: string | null; description: string; acceptance: string[] };
}

/** 拆分规则：分片数 ≥ minShards 且每片 estTurns ≥ minEstTurns → 拆 */
export interface SplitRule {
  minShards: number;
  minEstTurns: number;
}

/** 默认规则按分片数判定（枚举是最事实化的输出;轮数估计最模糊,默认不设门槛只记录） */
export const DEFAULT_SPLIT_RULE: SplitRule = { minShards: 2, minEstTurns: 1 };

/**
 * 宿主规则构图（纯函数,零模型参与）：
 * - 规则命中 → 分片为并行子任务 + join（若有）dependsOn 全部分片；
 * - 未命中 → 单体子任务（description=原任务全文,验收=分片+join 验收合并——
 *   验收清单与拆分方式无关,合并后单 agent 产物仍可逐条核查）。
 */
export function buildPlanFromInventory(task: string, inv: ShardInventory, rule: SplitRule): Plan {
  const split =
    inv.shards.length >= rule.minShards &&
    inv.shards.every((s) => (s.estTurns ?? 1) >= rule.minEstTurns);
  if (!split) {
    const acceptance = [
      ...inv.shards.flatMap((s) => s.acceptance),
      ...(inv.join?.acceptance ?? []),
    ];
    return {
      subtasks: [
        { id: "s1", title: "整体执行", pack: inv.shards[0]?.pack ?? null, description: task, acceptance, dependsOn: [] },
      ],
    };
  }
  const shardTasks: SubTask[] = inv.shards.map((s) => ({
    id: s.id,
    title: s.title,
    pack: s.pack ?? null,
    description: s.description,
    acceptance: s.acceptance,
    dependsOn: [],
  }));
  const subtasks = [...shardTasks];
  if (inv.join) {
    subtasks.push({
      id: "join",
      title: inv.join.title,
      pack: inv.join.pack ?? null,
      description: inv.join.description,
      acceptance: inv.join.acceptance,
      dependsOn: shardTasks.map((s) => s.id),
    });
  }
  return { subtasks };
}

export async function runStructuredPlanner(
  cfg: AgentConfig,
  model: ModelClient,
  task: string,
  packs: DomainPack[],
  rule: SplitRule = DEFAULT_SPLIT_RULE,
  onEvent?: (event: TurnEvent) => void | Promise<void>,
): Promise<PlanOutcome> {
  const drain = async (prompt: string): Promise<{ text: string; usage: AggregateUsage }> => {
    const loop = new AgentLoop({ ...cfg, maxTurns: Math.min(cfg.maxTurns ?? 50, 12) }, model);
    let text = "";
    let usage: AggregateUsage | undefined;
    for await (const event of loop.run(prompt)) {
      await onEvent?.(event);
      switch (event.type) {
        case "assistant_text":
          text = event.text;
          break;
        case "approval_request":
          event.respond("deny", "Planner is read-only. Explore with read-only means; do not modify anything.");
          break;
        case "done":
          usage = event.result.usage;
          break;
        default:
          break;
      }
    }
    return { text, usage: usage! };
  };

  const first = await drain(buildInventoryPrompt(task, packs));
  let inventory = parseShardInventory(first.text);
  let raw = first.text;
  let usage = first.usage;

  if (!inventory && first.text.trim() !== "") {
    const retry = await drain(buildInventoryReformatPrompt(first.text));
    usage = sumUsage(usage, retry.usage);
    const second = parseShardInventory(retry.text);
    if (second) {
      inventory = second;
      raw = retry.text;
    }
  }

  if (!inventory) return { usage, raw };
  return { plan: buildPlanFromInventory(task, inventory, rule), usage, raw, inventory };
}

function buildInventoryPrompt(task: string, packs: DomainPack[]): string {
  const packList =
    packs.length > 0
      ? packs.map((p) => `- ${p.name}: ${p.description}`).join("\n")
      : "(无可用领域包——所有 pack 都填 null)";
  return `你现在的角色是计划单元（结构化拆分协议）。注意：【要不要拆分不由你决定】——那由宿主的确定性规则判定。你的职责只是枚举事实：把任务分解为分片清单。

<task>
${task}
</task>

可用领域包（pack 决定工具面与工作纪律;不需要特定领域时填 null）：
${packList}

枚举纪律：
1. 分片（shard）= 互不依赖的部分：写集不相交（不写同一文件/目录/独占资源）、无执行顺序约束、可独立验收。只做客观分解,不评判"值不值得拆"。
2. 若任务本质是一个整体（各部分共享状态或顺序耦合,无法独立执行）,就只输出一个分片,把整个任务写进它的 description。不要为了凑数硬拆。
3. 每个分片：description 必须自包含（执行 agent 看不到你的上下文,绝对路径/命令/口径写全）;acceptance 可被独立核查者逐条程序化验证;estTurns 为预计工具调用轮数（整数,粗估即可）。
4. 若各分片结果需要合并,输出 join（汇总步,会在全部分片完成后执行）:它【只消费分片的产物,不得重新推导源数据】——把这一句写进 join 的 description。无需合并则省略 join。
5. 你的探索仅限只读;不要修改、创建或删除任何东西。

你的最后一条消息必须只包含一个 JSON 对象（不要代码围栏、不要多余文字）：
{"shards": [{"id": "s1", "title": "短标题", "pack": "包名或 null", "description": "自包含任务书", "acceptance": ["验收点"], "estTurns": 2}], "join": {"title": "...", "pack": null, "description": "...", "acceptance": ["..."]}}
（join 可省略）`;
}

function buildInventoryReformatPrompt(raw: string): string {
  return `你刚才作为计划单元（结构化拆分协议）完成了分片枚举,但最终消息不符合输出契约（必须是单个 JSON 对象）。你的枚举原文如下：

<raw_inventory>
${raw}
</raw_inventory>

请把上述内容【原样转写】为契约要求的 JSON——不要重新分解、不要增删分片。
硬规则：如果原文并不包含具体的分片枚举,你【不得编造】,必须输出 {"shards": []}。
你的回复必须只包含一个 JSON 对象（不要代码围栏、不要多余文字）：
{"shards": [{"id": "s1", "title": "...", "pack": "包名或 null", "description": "...", "acceptance": ["..."], "estTurns": 2}], "join": {"title": "...", "pack": null, "description": "...", "acceptance": ["..."]}}`;
}

/**
 * 分片清单解析（宽容提取 + fail-closed）：shards 空/description 缺失/id 重复 → undefined。
 */
export function parseShardInventory(text: string): ShardInventory | undefined {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/g);
  if (fenced) for (const f of fenced) candidates.push(f.replace(/```(?:json)?\s*|```/g, ""));
  const braced = text.match(/\{[\s\S]*\}/);
  if (braced) candidates.push(braced[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { shards?: unknown; join?: unknown };
      if (!Array.isArray(parsed.shards) || parsed.shards.length === 0) continue;
      const shards: ShardInventory["shards"] = [];
      let valid = true;
      const seen = new Set<string>();
      for (const [i, s] of (parsed.shards as Record<string, unknown>[]).entries()) {
        if (typeof s.description !== "string" || s.description.trim() === "") {
          valid = false;
          break;
        }
        const id = typeof s.id === "string" && s.id ? s.id : `s${i + 1}`;
        if (seen.has(id)) {
          valid = false;
          break;
        }
        seen.add(id);
        shards.push({
          id,
          title: typeof s.title === "string" ? s.title : `分片 ${i + 1}`,
          pack: typeof s.pack === "string" && s.pack !== "null" ? s.pack : null,
          description: s.description,
          acceptance: Array.isArray(s.acceptance) ? s.acceptance.map(String) : [],
          ...(typeof s.estTurns === "number" && Number.isFinite(s.estTurns)
            ? { estTurns: Math.max(1, Math.round(s.estTurns)) }
            : {}),
        });
      }
      if (!valid) continue;
      let join: ShardInventory["join"];
      if (parsed.join && typeof parsed.join === "object") {
        const j = parsed.join as Record<string, unknown>;
        if (typeof j.description === "string" && j.description.trim() !== "") {
          join = {
            title: typeof j.title === "string" ? j.title : "汇总",
            pack: typeof j.pack === "string" && j.pack !== "null" ? j.pack : null,
            description: j.description,
            acceptance: Array.isArray(j.acceptance) ? j.acceptance.map(String) : [],
          };
        }
      }
      return { shards, ...(join ? { join } : {}) };
    } catch {
      // 尝试下一个候选
    }
  }
  return undefined;
}

export const PLAN_PARSE_FAIL = "planner 输出无法解析为 JSON 计划";

export async function runPlanner(
  cfg: AgentConfig,
  model: ModelClient,
  task: string,
  packs: DomainPack[],
  onEvent?: (event: TurnEvent) => void | Promise<void>,
): Promise<PlanOutcome> {
  const drain = async (prompt: string): Promise<{ text: string; usage: AggregateUsage }> => {
    // 计划不该比执行贵：探索预算收紧
    const loop = new AgentLoop({ ...cfg, maxTurns: Math.min(cfg.maxTurns ?? 50, 12) }, model);
    let text = "";
    let usage: AggregateUsage | undefined;
    for await (const event of loop.run(prompt)) {
      await onEvent?.(event);
      switch (event.type) {
        case "assistant_text":
          text = event.text;
          break;
        case "approval_request":
          event.respond("deny", "Planner is read-only. Explore with read-only means; do not modify anything.");
          break;
        case "done":
          usage = event.result.usage;
          break;
        default:
          break;
      }
    }
    return { text, usage: usage! };
  };

  const first = await drain(buildPlannerPrompt(task, packs));
  let plan = parsePlan(first.text);
  let raw = first.text;
  let usage = first.usage;

  // 重问一次（转写，不重新规划）；空输出无可转写，直接 fail-closed
  if (!plan && first.text.trim() !== "") {
    const retry = await drain(buildReformatPrompt(first.text));
    usage = sumUsage(usage, retry.usage);
    const second = parsePlan(retry.text);
    if (second) {
      plan = second;
      raw = retry.text;
    }
  }

  return { ...(plan ? { plan } : {}), usage, raw };
}

function buildPlannerPrompt(task: string, packs: DomainPack[]): string {
  const packList =
    packs.length > 0
      ? packs.map((p) => `- ${p.name}: ${p.description}`).join("\n")
      : "(无可用领域包——所有子任务的 pack 都填 null)";
  return `你现在的角色是计划单元（planner）。把下面的任务拆解为【最少必要】的子任务序列。每个子任务将由一个独立的执行 agent 完成——它看不到你的上下文，只能看到你写的 description 和上游交接摘要，所以 description 必须自包含（绝对路径、命令、约束写全）。

<task>
${task}
</task>

可用领域包（pack 决定子任务的工具面与工作纪律；不需要特定领域时填 null）：
${packList}

拆分纪律：
1. 能由一个 agent 一次完成的不要拆——每道子任务边界都有上下文损耗；只在【领域切换】、【产物交接】或【可并行分片】处切分。可并行分片：任务含多个互不依赖、各自工作量可观（预计需要多轮工具调用）的部分时，拆成并行分支能缩短总时长；琐碎部分不值得拆（每个子任务都有固定开销）。
2. 每个子任务必须给出 acceptance：可被独立核查者逐条程序化验证的验收清单（具体的文件、数值、命令可获得的事实；不写"质量好/合理"这类不可验证的话）。
3. 每个子任务给出 dependsOn：直接依赖的子任务 id 数组（无依赖填 []）。只在【必须用到对方产物】时声明依赖——互不依赖的子任务可能被并行执行。上游执行摘要只会传给 dependsOn 里声明了它的子任务；跨子任务传产物时在下游 description 里写明产物的绝对路径。
4. 并行冲突纪律：互不依赖的子任务不得写同一个文件、目录或独占资源（调试探针、端口、服务）；会冲突就用 dependsOn 串行化。
5. 需要汇总多个并行分支的结果时，加一个收尾子任务，dependsOn 列出全部相关分支；汇总子任务的 description 里必须写明：只消费上游交接的产物（文件/摘要），不得重新推导源数据。
6. 你的探索仅限只读；不要修改、创建或删除任何东西。

你的最后一条消息必须只包含一个 JSON 对象（不要代码围栏、不要多余文字）：
{"subtasks": [{"id": "s1", "title": "短标题", "pack": "包名或 null", "description": "自包含的任务书", "acceptance": ["验收点，每条一个字符串"], "dependsOn": ["依赖的子任务 id"]}]}`;
}

function buildReformatPrompt(raw: string): string {
  return `你刚才作为计划单元完成了任务拆解，但最终消息不符合输出契约（必须是单个 JSON 对象）。你的拆解原文如下：

<raw_plan>
${raw}
</raw_plan>

请把上述内容【原样转写】为契约要求的 JSON——不要重新规划、不要增删子任务。
硬规则：如果原文并不包含具体的子任务拆解，你【不得编造】，必须输出 {"subtasks": []}。
你的回复必须只包含一个 JSON 对象（不要代码围栏、不要多余文字）：
{"subtasks": [{"id": "s1", "title": "...", "pack": "包名或 null", "description": "...", "acceptance": ["..."], "dependsOn": ["依赖的子任务 id，无依赖填 []"]}]}`;
}

/**
 * 宽容解析 + 结构校验。返回 undefined 表示不可解析或结构非法（fail-closed）。
 * 空 subtasks 数组也视为无效计划——编排层没有可执行内容。
 *
 * 依赖图校验（v1.1）：id 重复、dependsOn 引用不存在的 id、成环——都会让
 * 调度语义变得不可判定，整份计划作废（fail-closed，与裁决/计划解析同纪律）。
 * 兼容：整份计划都没有 dependsOn 字段 → 推断为线性链（v1.0 的隐式顺序语义）。
 */
export function parsePlan(text: string): Plan | undefined {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/g);
  if (fenced) for (const f of fenced) candidates.push(f.replace(/```(?:json)?\s*|```/g, ""));
  const braced = text.match(/\{[\s\S]*\}/);
  if (braced) candidates.push(braced[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { subtasks?: unknown };
      if (!Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0) continue;
      const subtasks: SubTask[] = [];
      let valid = true;
      let sawDepsField = false;
      for (const [i, s] of (parsed.subtasks as Record<string, unknown>[]).entries()) {
        if (typeof s.description !== "string" || s.description.trim() === "") {
          valid = false;
          break;
        }
        const rawDeps = s.dependsOn ?? s.depends_on; // 兼容 snake_case 输出习惯
        if (rawDeps !== undefined) sawDepsField = true;
        subtasks.push({
          id: typeof s.id === "string" && s.id ? s.id : `s${i + 1}`,
          title: typeof s.title === "string" ? s.title : `子任务 ${i + 1}`,
          pack: typeof s.pack === "string" && s.pack !== "null" ? s.pack : null,
          description: s.description,
          acceptance: Array.isArray(s.acceptance) ? s.acceptance.map(String) : [],
          dependsOn: Array.isArray(rawDeps)
            ? [...new Set(rawDeps.map(String).map((d) => d.trim()).filter((d) => d !== ""))]
            : [],
          ...(Array.isArray(s.resources) && s.resources.length > 0
            ? { resources: s.resources.map(String) }
            : {}),
        });
      }
      if (!valid) continue;
      if (!sawDepsField) {
        // 旧格式：无任何依赖声明 → 线性链（每个子任务依赖前一个）
        for (let i = 1; i < subtasks.length; i++) subtasks[i]!.dependsOn = [subtasks[i - 1]!.id];
      }
      if (validateGraph(subtasks)) return { subtasks };
    } catch {
      // 尝试下一个候选
    }
  }
  return undefined;
}

/** 依赖图合法性：id 唯一、引用存在、无环（Kahn 拓扑）。宿主注入计划时也用它把关 */
export function validatePlanGraph(subtasks: SubTask[]): boolean {
  return validateGraph(subtasks);
}

function validateGraph(subtasks: SubTask[]): boolean {
  const ids = new Set<string>();
  for (const s of subtasks) {
    if (ids.has(s.id)) return false; // id 重复 → 依赖指向歧义
    ids.add(s.id);
  }
  for (const s of subtasks) {
    if (!s.dependsOn.every((d) => ids.has(d))) return false; // 悬空引用
  }
  const indegree = new Map(subtasks.map((s) => [s.id, s.dependsOn.length]));
  const queue = subtasks.filter((s) => s.dependsOn.length === 0).map((s) => s.id);
  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    processed += 1;
    for (const s of subtasks) {
      if (!s.dependsOn.includes(id)) continue;
      const left = indegree.get(s.id)! - 1;
      indegree.set(s.id, left);
      if (left === 0) queue.push(s.id);
    }
  }
  return processed === subtasks.length; // 少于全量 = 有环
}

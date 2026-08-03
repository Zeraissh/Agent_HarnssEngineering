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
5. 需要汇总多个并行分支的结果时，加一个收尾子任务，dependsOn 列出全部相关分支。
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

/** 依赖图合法性：id 唯一、引用存在、无环（Kahn 拓扑） */
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

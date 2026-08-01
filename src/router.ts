/**
 * L6 — 调度单元（router）：把任务路由到领域包。
 *
 * 与 planner/verifier 的关系：同为"角色单元"，但形态最轻——一次无工具的分类调用
 * （不探索、不拆解），判断任务落在哪个领域包的地盘上。
 *
 * 失败策略是 fail-open（与 verifier 的 fail-closed 相反）：路由是便利不是闸门，
 * 解析失败/未知包名 → 不选包、用默认配置执行。选错包的纠错机制在下游
 * （verifier 会发现产出不对），而"路由挂了导致任务跑不了"没有任何纠错机会。
 */
import { AgentLoop } from "./loop.js";
import type { DomainPack } from "./presets.js";
import type { AgentConfig, AggregateUsage, ModelClient, TurnEvent } from "./types.js";

export interface RouteDecision {
  /** 选中的包名；null = 通用任务或跨领域任务（reason 说明） */
  pack: string | null;
  reason: string;
}

export interface RouteOutcome {
  decision: RouteDecision;
  usage: AggregateUsage;
  /** router 的原始输出（审计用） */
  raw: string;
}

export async function routeToPack(
  cfg: AgentConfig,
  model: ModelClient,
  task: string,
  packs: DomainPack[],
  onEvent?: (event: TurnEvent) => void | Promise<void>,
): Promise<RouteOutcome> {
  // 无工具、两轮上限：router 只做判断，不做探索
  const loop = new AgentLoop({ ...cfg, tools: [], maxTurns: 2 }, model);
  let text = "";
  let usage: AggregateUsage | undefined;

  for await (const event of loop.run(buildRouterPrompt(task, packs))) {
    await onEvent?.(event);
    if (event.type === "assistant_text") text = event.text;
    if (event.type === "done") usage = event.result.usage;
  }

  return {
    decision: parseRouteDecision(
      text,
      packs.map((p) => p.name),
    ),
    usage: usage!,
    raw: text,
  };
}

function buildRouterPrompt(task: string, packs: DomainPack[]): string {
  const menu =
    packs.length > 0
      ? packs.map((p) => `- ${p.name}: ${p.description}`).join("\n")
      : "(没有已注册的领域包)";
  return `你是调度单元（router）。判断下面的任务应该交给哪个领域包执行。

<task>
${task}
</task>

可用领域包：
${menu}

规则：
1. 任务【整体】明确落在某个包的领域内 → 选它。
2. 通用任务（不需要任何包的专用工具或工作纪律）→ pack 填 null。
3. 任务横跨多个领域（例如既要写固件又要上真机验证，需要不同包接力）→ pack 填 null，
   并在 reason 里注明"跨领域任务，建议用 --plan 交给计划单元拆解"。
4. 拿不准 → null。选错包的代价高于不选包。

只输出一个 JSON 对象（不要代码围栏、不要多余文字）：
{"pack": "包名或 null", "reason": "一句话理由"}`;
}

/** 宽容解析，fail-open：解析失败或包名未注册 → null */
export function parseRouteDecision(text: string, validNames: string[]): RouteDecision {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/g);
  if (fenced) for (const f of fenced) candidates.push(f.replace(/```(?:json)?\s*|```/g, ""));
  const braced = text.match(/\{[\s\S]*\}/);
  if (braced) candidates.push(braced[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { pack?: unknown; reason?: unknown };
      const reason = typeof parsed.reason === "string" ? parsed.reason : "";
      if (typeof parsed.pack === "string" && parsed.pack !== "null") {
        return validNames.includes(parsed.pack)
          ? { pack: parsed.pack, reason }
          : { pack: null, reason: `router 选择了未注册的包 "${parsed.pack}"，降级为默认配置` };
      }
      if (parsed.pack === null || parsed.pack === "null") {
        return { pack: null, reason };
      }
    } catch {
      // 尝试下一个候选
    }
  }
  return { pack: null, reason: "router 输出无法解析，降级为默认配置（fail-open）" };
}

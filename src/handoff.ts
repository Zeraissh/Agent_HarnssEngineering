/**
 * 领域包「下一步」提议：有可引用根因之后，给人一张不挡对话的提示卡。
 *
 * 不是 ask_user：工具立刻返回，执行者继续收口；人点同意才由宿主开一场
 * 注入计划的编排（跳过 planner，点击即签字）。人点「先不用」只撤提议。
 */
import type { Plan, SubTask } from "./planner.js";

export const FIX_THEN_VERIFY = "fix_then_verify";

export interface PackHandoffStep {
  pack: string;
  title: string;
  description: string;
  acceptance: string[];
}

export interface PackHandoff {
  id: string;
  /** 同意按钮——操作员语言，禁止写包名或「切包」 */
  label: string;
  /** 拒绝按钮 */
  declineLabel: string;
  /** 写给模型：什么时候才许调用 propose_handoff */
  when: string;
  /** 线性子任务；宿主填 id / dependsOn */
  plan: PackHandoffStep[];
}

export interface HandoffPlanContext {
  summary: string;
  parentTask: string;
  sketch?: string;
}

const TEMPLATE_RE = /\{(summary|parentTask|sketch)\}/g;

export function fillHandoffTemplate(template: string, ctx: HandoffPlanContext): string {
  const sketch = (ctx.sketch ?? "").trim();
  return template.replace(TEMPLATE_RE, (_m, key: string) => {
    if (key === "summary") return ctx.summary.trim();
    if (key === "parentTask") return ctx.parentTask.trim();
    return sketch;
  });
}

export function findPackHandoff(
  pack: { handoffs?: PackHandoff[] } | undefined,
  id: string,
): PackHandoff | null {
  if (!pack?.handoffs?.length || !id) return null;
  return pack.handoffs.find((item) => item.id === id) ?? null;
}

export function findHandoffAmong(
  packs: Array<{ handoffs?: PackHandoff[] }>,
  id: string,
): PackHandoff | null {
  for (const pack of packs) {
    const found = findPackHandoff(pack, id);
    if (found) return found;
  }
  return null;
}

export function buildHandoffPlan(spec: PackHandoff, ctx: HandoffPlanContext): Plan {
  const summary = ctx.summary.trim();
  if (!summary) throw new Error("handoff summary is required");
  const subtasks: SubTask[] = spec.plan.map((step, index) => {
    const id = `s${index + 1}`;
    const prev = index > 0 ? [`s${index}`] : [];
    return {
      id,
      title: fillHandoffTemplate(step.title, ctx),
      pack: step.pack,
      description: fillHandoffTemplate(step.description, ctx).replace(/\n{3,}/g, "\n\n").trim(),
      acceptance: step.acceptance.map((line) => fillHandoffTemplate(line, ctx)),
      dependsOn: prev,
    };
  });
  return { subtasks };
}

export function buildHandoffTask(ctx: HandoffPlanContext): string {
  const summary = ctx.summary.trim();
  const parentTask = ctx.parentTask.trim();
  const sketch = (ctx.sketch ?? "").trim();
  const lines = [
    "按已确认的根因改固件并上板复测。",
    `根因：${summary}`,
    "",
    `原任务：${parentTask}`,
  ];
  if (sketch) {
    lines.push("", sketch);
  }
  return lines.join("\n");
}

/**
 * stm32-debug → 改固件再复测。按钮文案不出现包名。
 * 计划里的 pack 字段只给宿主调度，不进提示卡。
 */
export const STM32_FIX_THEN_VERIFY: PackHandoff = {
  id: FIX_THEN_VERIFY,
  label: "按这个根因改固件，再上板复测",
  declineLabel: "先不用",
  when:
    "已有可引用的固件根因（文件:行、寄存器实测 vs 规格，或同等证据），且下一步必须改源码并重新烧录复测。" +
    "闲聊、只有模糊怀疑、或下一步仍是同板观察时不要提议。",
  plan: [
    {
      pack: "stm32-coding",
      title: "按根因改固件并编出可烧录镜像",
      description:
        "按已确认的根因改固件并编出可烧录 ELF。\n" +
        "根因：{summary}\n" +
        "原任务：{parentTask}\n" +
        "{sketch}\n" +
        "只改与根因相关的部分；构建必须真实成功。不要连板、不要烧录。",
      acceptance: [
        "源码已按根因修改，改动能对上 {summary}",
        "工程构建成功并产出可烧录 ELF",
        "未改与根因无关的部分",
      ],
    },
    {
      pack: "stm32-debug",
      title: "烧录新镜像并按原验收复测",
      description:
        "烧上一段产出的 ELF，按原任务验收在板上复测。不要改源码。\n" +
        "根因：{summary}\n" +
        "原任务：{parentTask}",
      acceptance: [
        "已烧录新 ELF（不是调试开始前的旧镜像）",
        "原验收逐条复测，结论带板上读数",
        "本段没有改源码",
      ],
    },
  ],
};

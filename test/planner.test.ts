import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULT_PLANNER_MAX_TURNS,
  PLANNER_WRAPUP_MAX_TURNS,
  PLAN_TOOL_NAME,
  SHARDS_TOOL_NAME,
  createPlanTool,
  createShardsTool,
  parsePlan,
  parseShardInventory,
  planFromObject,
  runPlanner,
  runStructuredPlanner,
  shardInventoryFromObject,
} from "../src/planner.js";
import { runPlanned } from "../src/orchestrate.js";
import { PACKS } from "../src/presets.js";
import type { DomainPack } from "../src/presets.js";
import type { ModelClient, ModelRequest, ModelTurn } from "../src/types.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock, toolUseBlock } from "./helpers.js";

const baseConfig = {
  systemPrompt: "shared frozen system",
  workdir: process.cwd(),
  tools: [],
};

class ScriptedClient implements ModelClient {
  requests: ModelRequest[] = [];
  constructor(private script: Anthropic.Message[]) {}
  send(req: ModelRequest): Promise<ModelTurn> {
    this.requests.push(structuredClone(req));
    const m = this.script.shift();
    if (!m) throw new Error(`script exhausted at request ${this.requests.length}`);
    return Promise.resolve({ message: m, stopReason: m.stop_reason, usage: m.usage });
  }
}

const PLAN_JSON =
  '{"subtasks": [' +
  '{"id": "s1", "title": "改固件", "pack": "stm32-coding", "description": "修改 main.c 并构建", "acceptance": ["ELF 存在"]},' +
  '{"id": "s2", "title": "烧录验证", "pack": "stm32-debug", "description": "烧录 build/x.elf 到板子", "acceptance": ["heartbeat 递增"]}' +
  "]}";

describe("parsePlan（宽容解析，fail-closed）", () => {
  it("纯 JSON 计划", () => {
    const p = parsePlan(PLAN_JSON);
    expect(p).toBeDefined();
    expect(p!.subtasks).toHaveLength(2);
    expect(p!.subtasks[0]!.pack).toBe("stm32-coding");
    expect(p!.subtasks[1]!.acceptance).toEqual(["heartbeat 递增"]);
  });

  it("代码围栏 + 前后说明文字", () => {
    const p = parsePlan("拆解如下：\n```json\n" + PLAN_JSON + "\n```\n以上。");
    expect(p).toBeDefined();
    expect(p!.subtasks).toHaveLength(2);
  });

  it('pack 为字符串 "null" 或缺省 → null；id/title 缺省自动补', () => {
    const p = parsePlan('{"subtasks": [{"pack": "null", "description": "做点事", "acceptance": []}]}');
    expect(p).toBeDefined();
    expect(p!.subtasks[0]!.pack).toBeNull();
    expect(p!.subtasks[0]!.id).toBe("s1");
    expect(p!.subtasks[0]!.title).toBeTruthy();
  });

  it("缺 description → 无效（fail-closed）", () => {
    expect(parsePlan('{"subtasks": [{"id": "s1", "acceptance": []}]}')).toBeUndefined();
  });

  it("空 subtasks → 无效（无可执行内容）", () => {
    expect(parsePlan('{"subtasks": []}')).toBeUndefined();
    expect(parsePlan("我觉得不用拆")).toBeUndefined();
  });
});

describe("runPlanner", () => {
  it("散文输出 → 重问一次转写，采纳第二次的计划", async () => {
    const model = new ScriptedClient([
      fakeMessage([textBlock("我把任务拆成两步：第一步改固件，第二步烧录验证。")], "end_turn"),
      fakeMessage([textBlock(PLAN_JSON)], "end_turn"),
    ]);
    const outcome = await runPlanner(baseConfig, model, "任务", []);
    expect(outcome.plan).toBeDefined();
    expect(outcome.plan!.subtasks).toHaveLength(2);
    // 重问提示携带原文（转写而非重新规划）
    expect(JSON.stringify(model.requests[1]!.messages[0]!.content)).toContain("第一步改固件");
    expect(outcome.usage.turns).toBe(2);
  });

  /**
   * 这条原来叫「空输出 → 不重问」，B0 之后判据收窄到 end_turn：模型自己
   * 决定收笔却什么都没写，续跑与重问都救不了（无正史价值、无可转写内容）。
   * max_turns 的空输出走的是另一条路——收口续跑（见下面的 B0 组测试）。
   */
  it("end_turn 空输出 → 不重问也不续跑，无计划（fail-closed）", async () => {
    const model = new ScriptedClient([fakeMessage([textBlock("")], "end_turn")]);
    const outcome = await runPlanner(baseConfig, model, "任务", []);
    expect(outcome.plan).toBeUndefined();
    expect(model.requests).toHaveLength(1);
    expect(outcome.recovery).toBe("failed");
    // 9.2 同款：零工具调用的失败要单独措辞——"根本没探索"与"探索没收口"是两种故障
    expect(outcome.failureSummary).toContain("零工具调用");
  });

  it("recovery 标注获得路径：direct / reformat", async () => {
    const direct = new ScriptedClient([fakeMessage([textBlock(PLAN_JSON)], "end_turn")]);
    expect((await runPlanner(baseConfig, direct, "任务", [])).recovery).toBe("direct");

    const prose = new ScriptedClient([
      fakeMessage([textBlock("我把任务拆成两步")], "end_turn"),
      fakeMessage([textBlock(PLAN_JSON)], "end_turn"),
    ]);
    expect((await runPlanner(baseConfig, prose, "任务", [])).recovery).toBe("reformat");
  });
});

// ================================================================
// B0：planner 探索预算三级化（9.1 的 planner 版）
// ================================================================

/** 永远只调工具、从不收口的模型——用来数 planner 到底被允许跑几轮 */
class NeverConcludes implements ModelClient {
  calls = 0;
  send(_req: ModelRequest): Promise<ModelTurn> {
    this.calls += 1;
    const m = fakeMessage([toolUseBlock(`tu_${this.calls}`, "probe", {})], "tool_use");
    return Promise.resolve({ message: m, stopReason: m.stop_reason, usage: m.usage });
  }
}

const probeCfg = { ...baseConfig, tools: [makeTool({ name: "probe" })] };

/** 最小领域包：只为声明 plan.maxTurns */
function makePack(name: string, planMaxTurns?: number): DomainPack {
  return {
    name,
    description: `pack ${name}`,
    systemPrompt: "sp",
    verify: { enabled: true, mode: "programmatic" },
    ...(planMaxTurns !== undefined ? { plan: { maxTurns: planMaxTurns } } : {}),
  };
}

describe("planner 探索预算（B0——9.1 的 planner 版）", () => {
  it("缺省 12 轮，与执行者 maxTurns 解耦（修前是 Math.min(cfg.maxTurns ?? 50, 12) 夹断）", async () => {
    const model = new NeverConcludes();
    // 执行者被压到 2 轮也不该影响拆解预算——修前这里会被夹到 2
    await runPlanner({ ...probeCfg, maxTurns: 2 }, model, "任务", []);
    // 调查预算 + 收口续跑：撞满预算后还会续跑一小段专门写计划
    expect(model.calls).toBe(DEFAULT_PLANNER_MAX_TURNS + PLANNER_WRAPUP_MAX_TURNS);
  });

  it("包声明 plan.maxTurns：菜单取最大——planner 还没拆，不知道任务落在哪个域", async () => {
    const model = new NeverConcludes();
    await runPlanner(probeCfg, model, "任务", [makePack("a", 4), makePack("b", 7), makePack("c")]);
    expect(model.calls).toBe(7 + PLANNER_WRAPUP_MAX_TURNS);
  });

  it("显式覆盖压过包声明（env > 包 > 默认，宿主从 AGENT_PLAN_MAX_TURNS 传入）", async () => {
    const model = new NeverConcludes();
    await runPlanner(probeCfg, model, "任务", [makePack("a", 9)], undefined, { maxTurns: 3 });
    expect(model.calls).toBe(3 + PLANNER_WRAPUP_MAX_TURNS);
  });

  it("包声明的 plan.maxTurns 不得高于该包自己的执行者护栏（计划不该比执行贵）", () => {
    for (const p of Object.values(PACKS)) {
      const executorCap = p.guardrails?.maxTurns;
      if (p.plan?.maxTurns !== undefined && executorCap !== undefined) {
        expect(p.plan.maxTurns, `${p.name} 的 plan.maxTurns 高于其执行者护栏`).toBeLessThanOrEqual(executorCap);
      }
      // 缺省值也受同一不等式约束：12 必须低于每个包的执行者护栏（25~40）
      if (executorCap !== undefined) {
        expect(DEFAULT_PLANNER_MAX_TURNS, `缺省拆解预算高于 ${p.name} 的执行者护栏`).toBeLessThanOrEqual(executorCap);
      }
    }
  });
});

// ================================================================
// B0：预算用尽的收口续跑 + fail-closed 带过程摘要（9.7/9.2 的 planner 版）
// ================================================================

describe("预算用尽后的收口（B0——9.7/9.2 的 planner 版）", () => {
  /** 前 busy 次只调工具，之后按脚本走——同 verifier 测试的 busyThenScripted */
  function busyThenScripted(busy: number, script: Anthropic.Message[]) {
    let n = 0;
    const requests: ModelRequest[] = [];
    return {
      requests,
      send(req: ModelRequest): Promise<ModelTurn> {
        requests.push(structuredClone(req));
        n += 1;
        const m =
          n <= busy
            ? fakeMessage([toolUseBlock(`tu_${n}`, "probe", {})], "tool_use")
            : (script.shift() ?? fakeMessage([textBlock("")], "end_turn"));
        return Promise.resolve({ message: m, stopReason: m.stop_reason, usage: m.usage });
      },
    } satisfies ModelClient & { requests: ModelRequest[] };
  }

  it("撞满预算 → 续跑同一会话收口，拿到计划（修前：整场拆解连同探索证据一起作废）", async () => {
    const model = busyThenScripted(3, [fakeMessage([textBlock(PLAN_JSON)], "end_turn")]);
    const outcome = await runPlanner(probeCfg, model, "任务", [], undefined, { maxTurns: 3 });
    expect(outcome.plan, "收口续跑应当拿到计划").toBeDefined();
    expect(outcome.recovery).toBe("wrapup");
    // 续跑带上探索正史（不是从零重来），收口提示明说预算用尽
    const wrapReq = model.requests[3]!;
    expect(wrapReq.messages.length).toBeGreaterThan(1);
    expect(JSON.stringify(wrapReq.messages.at(-1)!.content)).toContain("预算已经用尽");
    // 收口段不许继续取证——判据不变、承载物换了（B0b 的 none → §2.1 的强制交付工具）
    expect(model.requests[0]!.toolChoice).toBeUndefined();
    expect(wrapReq.toolChoice).toEqual({ type: "tool", name: PLAN_TOOL_NAME });
  });

  it("结构化协议同款收口（契约换成分片清单）", async () => {
    const model = busyThenScripted(2, [
      fakeMessage(
        [textBlock('{"shards": [{"id": "s1", "title": "整体", "pack": null, "description": "整体做完", "acceptance": ["ok"], "estTurns": 3}]}')],
        "end_turn",
      ),
    ]);
    const outcome = await runStructuredPlanner(probeCfg, model, "任务", [], undefined, undefined, { maxTurns: 2 });
    expect(outcome.plan).toBeDefined();
    expect(outcome.recovery).toBe("wrapup");
    expect(JSON.stringify(model.requests[2]!.messages.at(-1)!.content)).toContain("分片清单");
    // 结构化协议的收口同样只许交付（承载物同上）
    expect(model.requests[2]!.toolChoice).toEqual({ type: "tool", name: SHARDS_TOOL_NAME });
  });

  it("兜底都没救回 → failureSummary 带轮数与工具分布（区分「胡言乱语」与「没来得及收口」）", async () => {
    const model = new NeverConcludes(); // 收口续跑里也只调工具，救不回
    const outcome = await runPlanner(probeCfg, model, "任务", [], undefined, { maxTurns: 3 });
    expect(outcome.plan).toBeUndefined();
    expect(outcome.recovery).toBe("failed");
    expect(outcome.failureSummary).toContain("跑满 3 轮预算");
    expect(outcome.failureSummary).toContain("probe");
    expect(outcome.failureSummary).toContain("不等于任务不可拆解");
  });

  it("runPlanned 把 planMaxTurns 穿到 planner（行为断言：真的在那一轮收口）", async () => {
    const passVerdict = () =>
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "ok"}')], "end_turn");
    const model = busyThenScripted(2, [
      fakeMessage([textBlock(PLAN_JSON)], "end_turn"), // 收口：两步计划
      fakeMessage([textBlock("ELF 已构建")], "end_turn"), // s1 main
      passVerdict(),
      fakeMessage([textBlock("烧录完成")], "end_turn"), // s2 main
      passVerdict(),
    ]);
    const outcome = await runPlanned(probeCfg, model, "整体任务", { planMaxTurns: 2 });
    expect(outcome.plan).toBeDefined();
    expect(JSON.stringify(model.requests[2]!.messages.at(-1)!.content)).toContain("预算已经用尽");
    expect(outcome.completed).toBe(true);
  });
});

describe("runPlanned（三角编排）", () => {
  const passVerdict = () =>
    fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "ok"}')], "end_turn");
  const failVerdict = () =>
    fakeMessage([textBlock('{"passed": false, "issues": ["产物缺失"], "summary": "no"}')], "end_turn");

  it("两个子任务顺序执行：验收注入任务书、上游摘要交接下游、按包解析配置", async () => {
    const model = new ScriptedClient([
      fakeMessage([textBlock(PLAN_JSON)], "end_turn"), // planner
      fakeMessage([textBlock("ELF 已构建于 build/x.elf")], "end_turn"), // s1 main
      passVerdict(), // s1 verifier
      fakeMessage([textBlock("烧录完成，heartbeat 递增")], "end_turn"), // s2 main
      passVerdict(), // s2 verifier
    ]);
    const resolvedPacks: (string | null | undefined)[] = [];
    const outcome = await runPlanned(baseConfig, model, "整体任务", {
      resolveSubtask: (sub) => {
        resolvedPacks.push(sub.pack);
        return { cfg: { ...baseConfig, systemPrompt: `pack:${sub.pack}` } };
      },
    });

    expect(outcome.completed).toBe(true);
    expect(outcome.steps).toHaveLength(2);
    expect(resolvedPacks).toEqual(["stm32-coding", "stm32-debug"]);

    // s1 执行请求：验收标准注入任务书；使用了按包解析的 system prompt
    const s1Req = model.requests[1]!;
    const s1Input = JSON.stringify(s1Req.messages[0]!.content);
    expect(s1Input).toContain("验收标准");
    expect(s1Input).toContain("ELF 存在");
    expect(s1Req.system[0]!.text).toBe("pack:stm32-coding");

    // s2 执行请求：携带 s1 的执行摘要作为上游交接
    const s2Input = JSON.stringify(model.requests[3]!.messages[0]!.content);
    expect(s2Input).toContain("上游交接");
    expect(s2Input).toContain("ELF 已构建于 build/x.elf");
  });

  it("子任务核查未通过（含返工）→ 快速失败，后续子任务不执行", async () => {
    const model = new ScriptedClient([
      fakeMessage([textBlock(PLAN_JSON)], "end_turn"), // planner
      fakeMessage([textBlock("完成了")], "end_turn"), // s1 main
      failVerdict(), // s1 verifier #1
      fakeMessage([textBlock("重做了")], "end_turn"), // s1 rework
      failVerdict(), // s1 verifier #2 → s1 finalPassed=false
    ]);
    const outcome = await runPlanned(baseConfig, model, "整体任务", {});
    expect(outcome.completed).toBe(false);
    expect(outcome.steps).toHaveLength(1);
    expect(outcome.steps[0]!.result.finalPassed).toBe(false);
    expect(model.requests).toHaveLength(5); // s2 从未启动
  });

  it("planner 产不出计划 → 不执行任何子任务", async () => {
    const model = new ScriptedClient([
      fakeMessage([textBlock("")], "end_turn"), // planner 空输出
    ]);
    const outcome = await runPlanned(baseConfig, model, "整体任务", {});
    expect(outcome.plan).toBeUndefined();
    expect(outcome.steps).toHaveLength(0);
    expect(outcome.completed).toBe(false);
  });

  it("onPlan 在首个子任务执行前触发", async () => {
    const order: string[] = [];
    const model = new ScriptedClient([
      fakeMessage([textBlock(PLAN_JSON)], "end_turn"),
      fakeMessage([textBlock("done1")], "end_turn"),
      passVerdict(),
      fakeMessage([textBlock("done2")], "end_turn"),
      passVerdict(),
    ]);
    await runPlanned(baseConfig, model, "任务", {
      onPlan: (plan) => {
        order.push(`plan:${plan.subtasks.length}`);
      },
      onEvent: (source, event) => {
        if (event.type === "turn_start" && source.endsWith("/main")) order.push(source);
      },
    });
    expect(order[0]).toBe("plan:2");
    expect(order).toContain("s1/main");
  });
});

describe("§2.1 结构化交付：计划走终结工具", () => {
  it("freeform：调用 submit_plan → recovery=tool，计划从入参直接取", async () => {
    const model = new FakeModelClient([
      fakeMessage(
        [
          toolUseBlock("tu_1", PLAN_TOOL_NAME, {
            subtasks: [
              { id: "s1", title: "抽符号", description: "抽 7 个符号", acceptance: ["7 个文件"], dependsOn: [] },
              { id: "s2", title: "组装", description: "拼 sch", acceptance: ["ERC 0"], dependsOn: ["s1"] },
            ],
          }),
        ],
        "tool_use",
      ),
    ]);
    const outcome = await runPlanner(probeCfg, model, "任务", []);
    expect(outcome.recovery).toBe("tool");
    expect(outcome.plan!.subtasks).toHaveLength(2);
    expect(outcome.plan!.subtasks[1]!.dependsOn).toEqual(["s1"]);
  });

  it("structured：调用 submit_shards → recovery=tool", async () => {
    const model = new FakeModelClient([
      fakeMessage(
        [
          toolUseBlock("tu_1", SHARDS_TOOL_NAME, {
            shards: [
              { id: "s1", title: "A", description: "做 A", acceptance: ["a"], estTurns: 3 },
              { id: "s2", title: "B", description: "做 B", acceptance: ["b"], estTurns: 3 },
            ],
          }),
        ],
        "tool_use",
      ),
    ]);
    const outcome = await runStructuredPlanner(probeCfg, model, "任务", []);
    expect(outcome.recovery).toBe("tool");
    expect(outcome.inventory!.shards).toHaveLength(2);
    // 拆不拆仍由宿主规则判定——工具交付没有把裁量还给模型
    expect(outcome.plan!.subtasks.length).toBeGreaterThan(1);
  });

  it("非法依赖图经工具进来照样 fail-closed——强制交付不等于放宽校验", async () => {
    const model = new FakeModelClient([
      fakeMessage(
        [
          toolUseBlock("tu_1", PLAN_TOOL_NAME, {
            subtasks: [
              { id: "s1", title: "A", description: "a", acceptance: [], dependsOn: ["s2"] },
              { id: "s2", title: "B", description: "b", acceptance: [], dependsOn: ["s1"] }, // 成环
            ],
          }),
        ],
        "tool_use",
      ),
    ]);
    const outcome = await runPlanner(probeCfg, model, "任务", []);
    expect(outcome.plan, "成环的图必须整份作废").toBeUndefined();
    expect(outcome.recovery).toBe("failed");
  });

  it("两条入口共用同一份判定：planFromObject 与 parsePlan 对同一份计划同判", () => {
    const obj = {
      subtasks: [{ id: "s1", title: "A", description: "a", acceptance: ["x"], dependsOn: [] }],
    };
    expect(planFromObject(obj)).toEqual(parsePlan(JSON.stringify(obj)));
    const bad = { subtasks: [{ id: "s1", title: "A", description: "  ", acceptance: [] }] };
    expect(planFromObject(bad)).toBeUndefined();
    expect(parsePlan(JSON.stringify(bad))).toBeUndefined();
  });

  it("两条入口共用同一份判定：shardInventoryFromObject 与 parseShardInventory 同判", () => {
    const obj = { shards: [{ id: "s1", title: "A", description: "a", acceptance: [], estTurns: 2 }] };
    expect(shardInventoryFromObject(obj)).toEqual(parseShardInventory(JSON.stringify(obj)));
    const dupIds = {
      shards: [
        { id: "s1", title: "A", description: "a", acceptance: [] },
        { id: "s1", title: "B", description: "b", acceptance: [] },
      ],
    };
    expect(shardInventoryFromObject(dupIds)).toBeUndefined();
    expect(parseShardInventory(JSON.stringify(dupIds))).toBeUndefined();
  });

  it("两个终结工具的 execute 对非法入参回可操作报错", async () => {
    const bad = await createPlanTool().execute({ subtasks: [] }, {} as never);
    expect(bad.isError).toBe(true);
    const badShards = await createShardsTool().execute({ shards: [] }, {} as never);
    expect(badShards.isError).toBe(true);
  });
});

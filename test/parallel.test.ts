/**
 * v1.1 并行编排：计划依赖图解析 + DAG 调度器 + 审批互斥门。
 *
 * 测试用 RoutingClient 而非 ScriptedClient——并发下请求到达顺序不定，
 * 按请求内容路由响应才能写出确定性断言。
 */
import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildPlanFromInventory,
  DEFAULT_SPLIT_RULE,
  parsePlan,
  parseShardInventory,
  type ShardInventory,
} from "../src/planner.js";
import { planParallelWidth, runPlanned } from "../src/orchestrate.js";
import type { ModelClient, ModelRequest, ModelTurn, Tool } from "../src/types.js";
import { fakeMessage, textBlock, toolUseBlock } from "./helpers.js";

const baseConfig = {
  systemPrompt: "shared frozen system",
  workdir: process.cwd(),
  tools: [] as Tool[],
};

/** 按请求内容路由响应的并发安全假模型 */
class RoutingClient implements ModelClient {
  requests: ModelRequest[] = [];
  constructor(
    private responder: (req: ModelRequest) => Anthropic.Message | Promise<Anthropic.Message>,
  ) {}
  async send(req: ModelRequest): Promise<ModelTurn> {
    this.requests.push(structuredClone(req));
    const message = await this.responder(req);
    return { message, stopReason: message.stop_reason, usage: message.usage };
  }
}

const reqText = (req: ModelRequest): string => JSON.stringify(req.messages);
const isPlannerReq = (req: ModelRequest): boolean => reqText(req).includes("计划单元");
const isVerifierReq = (req: ModelRequest): boolean => reqText(req).includes("独立验证员");
const passVerdict = () =>
  fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "ok"}')], "end_turn");
const failVerdict = () =>
  fakeMessage([textBlock('{"passed": false, "issues": ["产物缺失"], "summary": "no"}')], "end_turn");
const planMessage = (subtasks: object[]) =>
  fakeMessage([textBlock(JSON.stringify({ subtasks }))], "end_turn");

describe("parsePlan：dependsOn 解析与依赖图校验", () => {
  const sub = (id: string, deps?: unknown) => ({
    id,
    title: id,
    description: `任务${id}`,
    acceptance: [],
    ...(deps !== undefined ? { dependsOn: deps } : {}),
  });

  it("显式 dependsOn 解析 + 去重；有人声明时缺省者 = []", () => {
    const p = parsePlan(JSON.stringify({ subtasks: [sub("a"), sub("b", ["a", "a"])] }));
    expect(p).toBeDefined();
    expect(p!.subtasks[0]!.dependsOn).toEqual([]); // b 声明了字段，a 缺省 → 独立
    expect(p!.subtasks[1]!.dependsOn).toEqual(["a"]);
  });

  it("兼容旧格式：整份计划无 dependsOn → 线性链", () => {
    const p = parsePlan(JSON.stringify({ subtasks: [sub("a"), sub("b"), sub("c")] }));
    expect(p).toBeDefined();
    expect(p!.subtasks.map((s) => s.dependsOn)).toEqual([[], ["a"], ["b"]]);
  });

  it("兼容 snake_case depends_on", () => {
    const p = parsePlan(JSON.stringify({ subtasks: [sub("a"), { ...sub("b"), depends_on: ["a"] }] }));
    expect(p).toBeDefined();
    expect(p!.subtasks[1]!.dependsOn).toEqual(["a"]);
  });

  it("悬空引用 → 无效（fail-closed）", () => {
    expect(parsePlan(JSON.stringify({ subtasks: [sub("a", ["ghost"])] }))).toBeUndefined();
  });

  it("成环 → 无效；自依赖 → 无效", () => {
    expect(
      parsePlan(JSON.stringify({ subtasks: [sub("a", ["b"]), sub("b", ["a"])] })),
    ).toBeUndefined();
    expect(parsePlan(JSON.stringify({ subtasks: [sub("a", ["a"]), sub("b", [])] }))).toBeUndefined();
  });

  it("id 重复 → 无效（依赖指向歧义）", () => {
    expect(
      parsePlan(JSON.stringify({ subtasks: [sub("a", []), sub("a", [])] })),
    ).toBeUndefined();
  });
});

describe("结构化拆分协议：清单解析与宿主规则构图", () => {
  const inv = (n: number, withJoin: boolean, estTurns?: number): ShardInventory => ({
    shards: Array.from({ length: n }, (_, i) => ({
      id: `s${i + 1}`,
      title: `分片${i + 1}`,
      pack: null,
      description: `做第 ${i + 1} 份`,
      acceptance: [`产物 ${i + 1} 正确`],
      ...(estTurns !== undefined ? { estTurns } : {}),
    })),
    ...(withJoin
      ? { join: { title: "汇总", pack: null, description: "只消费分片产物", acceptance: ["总和正确"] } }
      : {}),
  });

  it("规则命中 → 分片并行 + join dependsOn 全部分片", () => {
    const plan = buildPlanFromInventory("总任务", inv(3, true), DEFAULT_SPLIT_RULE);
    expect(plan.subtasks).toHaveLength(4);
    expect(plan.subtasks.slice(0, 3).every((s) => s.dependsOn.length === 0)).toBe(true);
    expect(plan.subtasks[3]!.id).toBe("join");
    expect(plan.subtasks[3]!.dependsOn).toEqual(["s1", "s2", "s3"]);
  });

  it("规则未命中（单分片）→ 单体子任务:description=原任务,验收合并", () => {
    const plan = buildPlanFromInventory("总任务原文", inv(1, true), DEFAULT_SPLIT_RULE);
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0]!.description).toBe("总任务原文");
    expect(plan.subtasks[0]!.acceptance).toEqual(["产物 1 正确", "总和正确"]);
  });

  it("minEstTurns 门槛生效", () => {
    const rule = { minShards: 2, minEstTurns: 2 };
    expect(buildPlanFromInventory("t", inv(3, false, 1), rule).subtasks).toHaveLength(1);
    expect(buildPlanFromInventory("t", inv(3, false, 2), rule).subtasks).toHaveLength(3);
  });

  it("parseShardInventory：合法解析;shards 空/id 重复 → undefined（fail-closed）", () => {
    const ok = parseShardInventory(
      '{"shards": [{"id": "a", "description": "d1", "acceptance": [], "estTurns": 2.6}], "join": {"description": "合并", "acceptance": []}}',
    );
    expect(ok).toBeDefined();
    expect(ok!.shards[0]!.estTurns).toBe(3); // 四舍五入取整
    expect(ok!.join?.title).toBe("汇总"); // title 缺省补
    expect(parseShardInventory('{"shards": []}')).toBeUndefined();
    expect(
      parseShardInventory('{"shards": [{"id":"a","description":"x"},{"id":"a","description":"y"}]}'),
    ).toBeUndefined();
  });

  it("runPlanned plannerProtocol=structured：走清单提示词,规则构图后进调度器", async () => {
    const client = new RoutingClient(async (req) => {
      const text = reqText(req);
      if (text.includes("结构化拆分协议")) {
        return fakeMessage(
          [
            textBlock(
              JSON.stringify({
                shards: [
                  { id: "sa", title: "A", description: "任务a", acceptance: [] },
                  { id: "sb", title: "B", description: "任务b", acceptance: [] },
                ],
                join: { title: "汇总", description: "任务j:只消费产物", acceptance: [] },
              }),
            ),
          ],
          "end_turn",
        );
      }
      if (isPlannerReq(req)) throw new Error("structured 协议不应走 freeform 提示词");
      if (isVerifierReq(req)) return passVerdict();
      await delay(5);
      return fakeMessage([textBlock("done")], "end_turn");
    });
    const outcome = await runPlanned(baseConfig, client, "总任务", {
      plannerProtocol: "structured",
      concurrency: 2,
    });
    expect(outcome.completed).toBe(true);
    expect(outcome.plan!.subtasks.map((s) => s.id)).toEqual(["sa", "sb", "join"]);
    expect(outcome.plan!.subtasks[2]!.dependsOn).toEqual(["sa", "sb"]);
    expect(outcome.planOutcome.inventory?.shards).toHaveLength(2);
  });
});

describe("runPlanned：DAG 并行调度", () => {
  /** 两个独立子任务 + 各自延迟执行的 responder；记录执行期最大并发 */
  function makeOverlapFixture(execDelayMs: number) {
    let active = 0;
    let maxActive = 0;
    const client = new RoutingClient(async (req) => {
      if (isPlannerReq(req))
        return planMessage([
          { id: "a", title: "A", description: "任务a", acceptance: [], dependsOn: [] },
          { id: "b", title: "B", description: "任务b", acceptance: [], dependsOn: [] },
        ]);
      if (isVerifierReq(req)) return passVerdict();
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(execDelayMs);
      active -= 1;
      const which = reqText(req).includes("任务a") ? "a" : "b";
      return fakeMessage([textBlock(`摘要${which}`)], "end_turn");
    });
    return { client, maxActive: () => maxActive };
  }

  it("concurrency=2：独立子任务确实并发（执行窗口重叠）", async () => {
    const { client, maxActive } = makeOverlapFixture(25);
    const outcome = await runPlanned(baseConfig, client, "总任务", { concurrency: 2 });
    expect(outcome.completed).toBe(true);
    expect(outcome.steps).toHaveLength(2);
    expect(outcome.skipped).toHaveLength(0);
    expect(maxActive()).toBe(2);
    for (const step of outcome.steps) expect(step.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("默认 concurrency=1：同样的计划严格串行（无重叠）", async () => {
    const { client, maxActive } = makeOverlapFixture(10);
    const outcome = await runPlanned(baseConfig, client, "总任务", {});
    expect(outcome.completed).toBe(true);
    expect(maxActive()).toBe(1);
  });

  it("fan-out 汇总：收尾子任务只收直接依赖的交接摘要，独立分支互不可见", async () => {
    const client = new RoutingClient(async (req) => {
      if (isPlannerReq(req))
        return planMessage([
          { id: "a", title: "分支A", description: "任务a", acceptance: [], dependsOn: [] },
          { id: "b", title: "分支B", description: "任务b", acceptance: [], dependsOn: [] },
          { id: "c", title: "汇总", description: "任务c", acceptance: [], dependsOn: ["a", "b"] },
        ]);
      if (isVerifierReq(req)) return passVerdict();
      await delay(5);
      const text = reqText(req);
      const which = text.includes("任务c") ? "c" : text.includes("任务a") ? "a" : "b";
      return fakeMessage([textBlock(`摘要${which}：产物在 /out/${which}`)], "end_turn");
    });
    const outcome = await runPlanned(baseConfig, client, "总任务", { concurrency: 2 });
    expect(outcome.completed).toBe(true);

    // c 的执行请求：带 a、b 两段交接（含来源标注）；a/b 的请求互不含对方摘要
    const execReqs = client.requests.filter((r) => !isPlannerReq(r) && !isVerifierReq(r));
    const cReq = execReqs.find((r) => reqText(r).includes("任务c"))!;
    expect(cReq).toBeDefined();
    expect(reqText(cReq)).toContain("上游交接");
    expect(reqText(cReq)).toContain("来自 a（分支A）");
    expect(reqText(cReq)).toContain("摘要a：产物在 /out/a");
    expect(reqText(cReq)).toContain("摘要b：产物在 /out/b");
    const aReq = execReqs.find((r) => reqText(r).includes("任务a") && !reqText(r).includes("任务c"))!;
    expect(reqText(aReq)).not.toContain("摘要b");
    const bReq = execReqs.find((r) => reqText(r).includes("任务b") && !reqText(r).includes("任务c"))!;
    expect(reqText(bReq)).not.toContain("摘要a");
  });

  it("失败语义：一个分支失败 → 停止发射（含无关分支的下游），在飞的跑完", async () => {
    // a 快速失败；b 慢速通过；c 依赖 a；d 依赖 b。
    // 期望：a 失败后 c、d 都不再发射（skipped），b 在飞跑完（steps 含 a、b）
    const client = new RoutingClient(async (req) => {
      if (isPlannerReq(req))
        return planMessage([
          { id: "a", title: "A", description: "任务a", acceptance: [], dependsOn: [] },
          { id: "b", title: "B", description: "任务b", acceptance: [], dependsOn: [] },
          { id: "c", title: "C", description: "任务c", acceptance: [], dependsOn: ["a"] },
          { id: "d", title: "D", description: "任务d", acceptance: [], dependsOn: ["b"] },
        ]);
      if (isVerifierReq(req)) return reqText(req).includes("任务a") ? failVerdict() : passVerdict();
      const which = reqText(req).includes("任务a") ? "a" : reqText(req).includes("任务b") ? "b" : "?";
      await delay(which === "b" ? 40 : 1);
      return fakeMessage([textBlock(`摘要${which}`)], "end_turn");
    });
    const outcome = await runPlanned(baseConfig, client, "总任务", {
      concurrency: 2,
      maxReworks: 0,
    });
    expect(outcome.completed).toBe(false);
    expect(outcome.steps.map((s) => s.sub.id)).toEqual(["a", "b"]); // 计划顺序，b 跑完了
    expect(outcome.steps[0]!.result.finalPassed).toBe(false);
    expect(outcome.steps[1]!.result.finalPassed).toBe(true);
    expect(outcome.skipped.map((s) => s.id)).toEqual(["c", "d"]);
    // c、d 从未发出执行请求
    expect(client.requests.some((r) => reqText(r).includes("任务c") && !isPlannerReq(r))).toBe(false);
    expect(client.requests.some((r) => reqText(r).includes("任务d") && !isPlannerReq(r))).toBe(false);
  });

  it("planParallelWidth：线性链=1、fan-out=分支数、菱形=中间层宽", () => {
    const sub = (id: string, deps: string[]) => ({
      id, title: id, pack: null, description: id, acceptance: [], dependsOn: deps,
    });
    expect(planParallelWidth([sub("a", []), sub("b", ["a"]), sub("c", ["b"])])).toBe(1);
    expect(planParallelWidth([sub("a", []), sub("b", []), sub("c", []), sub("d", ["a", "b", "c"])])).toBe(3);
    expect(planParallelWidth([sub("a", []), sub("b", ["a"]), sub("c", ["a"]), sub("d", ["b", "c"])])).toBe(2);
  });

  it('concurrency:"auto"：fan-out 计划自动并行，线性链自动退化为串行', async () => {
    const fanout = makeOverlapFixture(20);
    const outcome = await runPlanned(baseConfig, fanout.client, "总任务", { concurrency: "auto" });
    expect(outcome.completed).toBe(true);
    expect(fanout.maxActive()).toBe(2); // 两分支 → auto=2

    // 线性链计划：同样 auto，必须严格串行
    let active = 0;
    let maxActive = 0;
    const chain = new RoutingClient(async (req) => {
      if (isPlannerReq(req))
        return planMessage([
          { id: "a", title: "A", description: "任务a", acceptance: [], dependsOn: [] },
          { id: "b", title: "B", description: "任务b", acceptance: [], dependsOn: ["a"] },
        ]);
      if (isVerifierReq(req)) return passVerdict();
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      active -= 1;
      return fakeMessage([textBlock("done")], "end_turn");
    });
    const chained = await runPlanned(baseConfig, chain, "总任务", { concurrency: "auto" });
    expect(chained.completed).toBe(true);
    expect(maxActive).toBe(1);
  });

  it("注入固定计划：跳过 planner，直接按图调度；非法图抛错", async () => {
    const client = new RoutingClient(async (req) => {
      if (isPlannerReq(req)) throw new Error("不应调用 planner——计划已注入");
      if (isVerifierReq(req)) return passVerdict();
      return fakeMessage([textBlock("done")], "end_turn");
    });
    const plan = {
      subtasks: [
        { id: "x", title: "X", pack: null, description: "任务x", acceptance: [], dependsOn: [] },
        { id: "y", title: "Y", pack: null, description: "任务y", acceptance: [], dependsOn: ["x"] },
      ],
    };
    const outcome = await runPlanned(baseConfig, client, "总任务", { plan });
    expect(outcome.completed).toBe(true);
    expect(outcome.planOutcome.usage.turns).toBe(0); // planner 零成本
    expect(outcome.steps.map((s) => s.sub.id)).toEqual(["x", "y"]);

    await expect(
      runPlanned(baseConfig, client, "总任务", {
        plan: { subtasks: [{ id: "x", title: "X", pack: null, description: "d", acceptance: [], dependsOn: ["ghost"] }] },
      }),
    ).rejects.toThrow(/依赖图非法/);
  });

  it("plannerModel：计划请求走独立 client，执行/核查仍走主 client", async () => {
    const plannerClient = new RoutingClient(async (req) => {
      if (!isPlannerReq(req)) throw new Error("planner client 收到非 planner 请求");
      return planMessage([
        { id: "a", title: "A", description: "任务a", acceptance: [], dependsOn: [] },
      ]);
    });
    const mainClient = new RoutingClient(async (req) => {
      if (isPlannerReq(req)) throw new Error("主 client 不应收到 planner 请求");
      if (isVerifierReq(req)) return passVerdict();
      return fakeMessage([textBlock("done")], "end_turn");
    });
    const outcome = await runPlanned(baseConfig, mainClient, "总任务", {
      plannerModel: { client: plannerClient, compat: true },
    });
    expect(outcome.completed).toBe(true);
    expect(plannerClient.requests).toHaveLength(1);
    expect(mainClient.requests.length).toBeGreaterThanOrEqual(2); // 执行 + 核查
  });

  it("审批互斥门：并发子任务的审批逐个到达宿主，绝不同时挂两个", async () => {
    const askTool: Tool = {
      name: "touch",
      description: "test ask tool",
      inputSchema: { type: "object" as const, properties: {} },
      permission: "ask",
      parallelSafe: false,
      execute: async () => ({ content: "touched" }),
    };
    // 每个执行 agent：第 1 轮发 tool_use（触发审批），第 2 轮收工
    const client = new RoutingClient(async (req) => {
      if (isPlannerReq(req))
        return planMessage([
          { id: "a", title: "A", description: "任务a", acceptance: [], dependsOn: [] },
          { id: "b", title: "B", description: "任务b", acceptance: [], dependsOn: [] },
        ]);
      if (isVerifierReq(req)) return passVerdict();
      const hasToolResult = req.messages.some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some((b) => (b as { type?: string }).type === "tool_result"),
      );
      if (hasToolResult) return fakeMessage([textBlock("完成")], "end_turn");
      await delay(10); // 让两个 run 几乎同时走到审批点
      const which = reqText(req).includes("任务a") ? "a" : "b";
      return fakeMessage([toolUseBlock(`tu_${which}`, "touch", {})], "tool_use");
    });

    let outstanding = 0;
    let maxOutstanding = 0;
    let approvals = 0;
    const outcome = await runPlanned(
      { ...baseConfig, tools: [askTool] },
      client,
      "总任务",
      {
        concurrency: 2,
        onEvent: async (source, event) => {
          if (event.type !== "approval_request") return;
          if (!source.endsWith("/main") && !source.endsWith("/rework")) return;
          approvals += 1;
          outstanding += 1;
          maxOutstanding = Math.max(maxOutstanding, outstanding);
          await delay(15); // 宿主"思考"期间另一个审批若未被门挡住就会叠上来
          outstanding -= 1;
          event.respond("allow");
        },
      },
    );
    expect(outcome.completed).toBe(true);
    expect(approvals).toBe(2);
    expect(maxOutstanding).toBe(1); // 互斥门生效
  });
});

/**
 * `ask_user`（§5.2 需求澄清）的回归锁。
 *
 * 这条 backlog 挂了很久，卡的是判据不是实现——"什么时候该问、问几个"。
 * 所以测试也按那几条设计决定组织：**每条决定一组锁**。
 * 没有这些锁，几条决定就只是注释里的几句话，下一次改动谁都不会记得。
 */
import { describe, expect, it, vi } from "vitest";
import {
  ASK_USER_TOOL_NAME,
  DEFAULT_MAX_ROUNDS,
  MAX_OPTIONS,
  MAX_QUESTIONS_PER_ROUND,
  MIN_OPTIONS,
  UNANSWERED_MESSAGE,
  createAskUserTool,
  quotaExhaustedMessage,
  renderAnswers,
  validateQuestions,
  withoutAskUser,
} from "../src/tools/ask-user.js";
import { runVerifier } from "../src/verifier.js";
import { runPlanner } from "../src/planner.js";
import { AgentLoop } from "../src/loop.js";
import type { ToolContext } from "../src/types.js";
import { FakeModelClient, fakeMessage, textBlock, toolUseBlock } from "./helpers.js";

const ctx = (signal = new AbortController().signal): ToolContext => ({
  workdir: process.cwd(),
  toolUseId: "tu_1",
  signal,
});

const one = {
  questions: [
    { question: "配置文件用 TOML 还是 JSON？", options: ["TOML", "JSON"], fallback: "默认用 JSON" },
  ],
};

/** 委托方实测催生的场景：一句「做一版 Desktop UI」带出三个正交未知 */
const desktop = {
  questions: [
    { question: "桌面端用哪个框架？", options: ["Electron", "Tauri"], fallback: "默认 Tauri" },
    { question: "UI 风格？", options: ["沿用现有暗色系", "重做一套"], fallback: "默认沿用" },
    { question: "这次做到什么程度？", options: ["可运行骨架", "核心页面齐全"], fallback: "默认骨架" },
  ],
};

describe("决定 6 · 一次一组问题，配额算【打断次数】不是【问题数】", () => {
  /**
   * 委托方实测（2026-08-15）：「给这个项目开发一版 Desktop UI」一开口就是
   * 技术选型 / UI 风格 / 做到什么程度三个正交未知。按"一次一个问题"的旧设计，
   * 第一轮澄清就把额度用光，还要三次往返——**贵的是打断人，不是问题本身**。
   */
  it("三个正交问题一次提交，只消耗一次打断额度", async () => {
    const seen: { questions: unknown[] }[] = [];
    const ask = vi.fn(async (req: { questions: unknown[] }) => {
      seen.push(req);
      return ["Tauri", "沿用现有暗色系", "可运行骨架"];
    });
    const tool = createAskUserTool({ ask, maxRounds: 1 });

    const first = await tool.execute(desktop, ctx());
    expect(first.isError).toBeUndefined();
    expect(ask, "三题一次问完 = 一次打断").toHaveBeenCalledTimes(1);
    expect(seen[0]!.questions).toHaveLength(3);

    // 额度只有 1，所以第二次打断必须被拦
    expect((await tool.execute(one, ctx())).isError).toBe(true);
  });

  /**
   * 这条是决定 6 的**判定性测试**。上面那条分不出来：额度检查在自增之前，
   * 所以「按题数扣」和「按轮次扣」在第一次调用上表现相同——变异实测活了下来。
   * 构造：额度 2 次，每次问 2 题。
   *   按轮次扣（正确）→ 两次都放行；
   *   按题数扣（错误）→ 第一次就扣掉 2，第二次被拦。
   */
  it("额度 2 次 × 每次 2 题 → 两次都放行（按轮次扣，不是按题数扣）", async () => {
    const two = { questions: desktop.questions.slice(0, 2) };
    const ask = vi.fn(async () => ["Tauri", "沿用现有暗色系"]);
    const tool = createAskUserTool({ ask, maxRounds: 2 });

    expect((await tool.execute(two, ctx())).isError, "第一次打断").toBeUndefined();
    expect((await tool.execute(two, ctx())).isError, "第二次打断——按题数扣的话这里会被拦").toBeUndefined();
    expect(ask).toHaveBeenCalledTimes(2);
    // 第三次才该被拦
    expect((await tool.execute(two, ctx())).isError).toBe(true);
  });

  it("答复逐题对齐回填，没答的那题照实说并带上它自己的默认", async () => {
    const tool = createAskUserTool({ ask: async () => ["Tauri", null, "可运行骨架"] });
    const r = await tool.execute(desktop, ctx());
    expect(r.content).toContain("桌面端用哪个框架？ → Tauri");
    expect(r.content).toContain("委托方未答此题，按你写的默认执行：默认沿用");
    expect(r.content).toContain("这次做到什么程度？ → 可运行骨架");
  });

  it(`一次最多 ${MAX_QUESTIONS_PER_ROUND} 题——再多就不是一屏答完而是问卷`, async () => {
    const ask = vi.fn(async () => []);
    const tool = createAskUserTool({ ask });
    const tooMany = {
      questions: Array.from({ length: MAX_QUESTIONS_PER_ROUND + 1 }, (_, i) => ({
        question: `q${i}`,
        options: ["a", "b"],
        fallback: "f",
      })),
    };
    const r = await tool.execute(tooMany, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("问卷");
    expect(ask, "超限的那次不该打扰人，也不该烧额度").not.toHaveBeenCalled();
  });

  it("空 questions 被拒——这个工具的入口就是「一组问题」", async () => {
    const tool = createAskUserTool({ ask: async () => [] });
    expect((await tool.execute({ questions: [] }, ctx())).isError).toBe(true);
    expect((await tool.execute({}, ctx())).isError).toBe(true);
  });
});

describe("决定 2 · 配额由 harness 强制，不靠提示里的「别问太多」", () => {
  it("用尽后拒绝，且给的是下一步动作而不是评价", async () => {
    const ask = vi.fn(async () => ["TOML"]);
    const tool = createAskUserTool({ ask, maxRounds: 2 });

    expect((await tool.execute(one, ctx())).isError).toBeUndefined();
    expect((await tool.execute(one, ctx())).isError).toBeUndefined();

    const third = await tool.execute(one, ctx());
    expect(third.isError, "第三次打断必须被拦").toBe(true);
    expect(ask, "拦下的那次不该打扰到人").toHaveBeenCalledTimes(2);
    expect(third.content).toContain("把你采用的关键假设");
    // 写给模型看的是动作，不是"你问太多了"这种评价（P5）
    expect(third.content).not.toContain("太多");
  });

  it("配额用尽不把工具从面上摘掉——中途改工具列表会让缓存前缀全灭（P3）", async () => {
    const tool = createAskUserTool({ ask: async () => null, maxRounds: 1 });
    await tool.execute(one, ctx());
    expect(tool.name).toBe(ASK_USER_TOOL_NAME);
    expect((await tool.execute(one, ctx())).isError).toBe(true);
  });

  it("配额是逐工具实例的——每个 run 造一个，不跨 run 累计", async () => {
    const mk = () => createAskUserTool({ ask: async () => ["a"], maxRounds: 1 });
    expect((await mk().execute(one, ctx())).isError).toBeUndefined();
    expect((await mk().execute(one, ctx())).isError).toBeUndefined();
  });

  it("缺省 3 次打断，且文案里的数字与实际上限一致（写死的数会漂）", async () => {
    const tool = createAskUserTool({ ask: async () => ["a"] });
    for (let i = 0; i < DEFAULT_MAX_ROUNDS; i++) {
      expect((await tool.execute(one, ctx())).isError).toBeUndefined();
    }
    const over = await tool.execute(one, ctx());
    expect(over.content).toBe(quotaExhaustedMessage(DEFAULT_MAX_ROUNDS));
    expect(over.content).toContain(String(DEFAULT_MAX_ROUNDS));
  });

  it("非法入参不消耗额度——一次拼错不该吃掉一次打断", async () => {
    const tool = createAskUserTool({ ask: async () => ["答案"], maxRounds: 1 });
    expect((await tool.execute({ questions: [{ question: "q" }] }, ctx())).isError).toBe(true);
    const ok = await tool.execute(one, ctx());
    expect(ok.content).toContain("答案");
  });
});

describe("决定 4 · 未应答 = 过期，不是失败", () => {
  it("宿主返回 null → 不是 error，且告诉模型带着假设继续", async () => {
    const tool = createAskUserTool({ ask: async () => null });
    const r = await tool.execute(one, ctx());
    expect(r.isError, "没人回答不是故障——画成 error 就是对委托方说谎（V-04）").toBeUndefined();
    expect(r.content).toBe(UNANSWERED_MESSAGE);
  });

  it("整组一题都没答等同未应答——不给模型一份全是「未答」的清单当噪声", async () => {
    const tool = createAskUserTool({ ask: async () => [null, null, null] });
    expect((await tool.execute(desktop, ctx())).content).toBe(UNANSWERED_MESSAGE);
  });

  it("只要有一题答了就照常回填，不因为其余没答而整轮作废", async () => {
    const tool = createAskUserTool({ ask: async () => [null, "重做一套", null] });
    const r = await tool.execute(desktop, ctx());
    expect(r.content).toContain("重做一套");
    expect(r.content).not.toBe(UNANSWERED_MESSAGE);
  });

  /**
   * 这一条是 Web 宿主接线时被测试当场抓出来的真缺陷：宿主的 abort 只解除了
   * 审批与计划门，忘了提问 → 执行协程永远吊在 execute 里，run 收不了尾。
   * 宿主那边已修，但不变量不能靠每个宿主记得（P6）——所以工具自己也守一道。
   */
  it("等待中被中止 → 自己走未应答出口，宿主忘了解除也挂不死", async () => {
    const ac = new AbortController();
    const tool = createAskUserTool({ ask: () => new Promise<never>(() => {}) });
    const pending = tool.execute(one, ctx(ac.signal));
    ac.abort();
    const r = await pending;
    expect(r.isError).toBeUndefined();
    expect(r.content).toBe(UNANSWERED_MESSAGE);
  });

  it("已中止时**不打扰人**直接走未应答——停止按钮不该变成一次提问", async () => {
    const ask = vi.fn(async () => ["不该被问到"]);
    const tool = createAskUserTool({ ask });
    const ac = new AbortController();
    ac.abort();
    const r = await tool.execute(one, ctx(ac.signal));
    expect(ask).not.toHaveBeenCalled();
    expect(r.isError).toBeUndefined();
    expect(r.content).toBe(UNANSWERED_MESSAGE);
  });
});

describe("决定 5 · 每题必须带 2~4 个候选（是选择题，但逃生口保留）", () => {
  it("少于 2 个候选 → 拒绝。想不出两条路，说明这不该是个问题", async () => {
    const ask = vi.fn(async () => ["a"]);
    const tool = createAskUserTool({ ask });
    for (const bad of [undefined, [], ["只有一个"], ["   ", ""]]) {
      const r = await tool.execute(
        { questions: [{ question: "用哪个？", options: bad, fallback: "f" }] },
        ctx(),
      );
      expect(r.isError, `options=${JSON.stringify(bad)} 应被拒`).toBe(true);
      expect(r.content).toContain("options");
    }
    expect(ask, "选项不合格的提问不该打扰到人").not.toHaveBeenCalled();
  });

  it("报错点名是第几题——一组里有一题写坏了，模型得知道是哪一题", async () => {
    const tool = createAskUserTool({ ask: async () => [] });
    const r = await tool.execute(
      {
        questions: [
          { question: "好的", options: ["a", "b"], fallback: "f" },
          { question: "坏的", options: ["只有一个"], fallback: "f" },
        ],
      },
      ctx(),
    );
    expect(r.content).toContain("第 2 题");
  });

  /**
   * P6 的直接应用：schema 里写了 minItems 不等于端点会执行它。
   * 本轮真机探针刚证明各家端点对参数的处理并不一致，所以自己守。
   */
  it("schema 声明了边界，execute 仍自己校验一遍（声明 ≠ 被执行）", () => {
    const schema = createAskUserTool({ ask: async () => null }).inputSchema as {
      properties: {
        questions: {
          minItems: number;
          maxItems: number;
          items: {
            properties: { options: { minItems: number; maxItems: number } };
            required: string[];
          };
        };
      };
      required: string[];
    };
    expect(schema.properties.questions.maxItems).toBe(MAX_QUESTIONS_PER_ROUND);
    expect(schema.properties.questions.items.properties.options.minItems).toBe(MIN_OPTIONS);
    expect(schema.properties.questions.items.properties.options.maxItems).toBe(MAX_OPTIONS);
    expect(schema.properties.questions.items.required).toEqual(
      expect.arrayContaining(["question", "options", "fallback"]),
    );
  });

  it("超出上限截断而不是拒绝——想太细不是无效，拒绝会白烧一次打断", () => {
    const r = validateQuestions({
      questions: [{ question: "q", options: ["a", "b", "c", "d", "e", "f"], fallback: "f" }],
    });
    expect("questions" in r && r.questions[0]!.options).toEqual(["a", "b", "c", "d"]);
  });

  it("委托方仍可自由输入——强制的是模型先想清岔路，不是限制人只能选", async () => {
    const tool = createAskUserTool({ ask: async () => ["都不选，用 YAML"] });
    const r = await tool.execute(one, ctx());
    expect(r.content).toContain("YAML");
  });

  it("fallback 必填——先想清默认路线再来占用委托方的注意力", async () => {
    const ask = vi.fn(async () => ["a"]);
    const tool = createAskUserTool({ ask });
    const r = await tool.execute(
      { questions: [{ question: "用哪个？", options: ["a", "b"] }] },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("fallback");
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("工具描述把「何时调用」写死在触发条件与时机上", () => {
  const desc = createAskUserTool({ ask: async () => null }).description;

  it("两类该问的都在：判据歧义 + 只有委托方知道的事实", () => {
    expect(desc).toContain("返工重做");
    // 「今天天气怎么样」那次实测：模型缺的是"你在哪个城市"这个**事实**，
    // 不是"验收标准有歧义"。第一版描述只写了前者，模型按字面读会判定不该问
    expect(desc).toContain("只有委托方知道的事实");
    expect(desc).toContain("查不到");
  });

  it("不该问的也写清：自己查得到的事、进度汇报、征求许可", () => {
    expect(desc).toContain("不该问的");
    expect(desc).toContain("进度汇报");
  });

  it("时机写进描述：范围与选型要在开工前问完（修环境 > 事后核查的人机版）", () => {
    expect(desc).toContain("开工之前");
  });

  it("配额与批量写进描述——模型要知道分几次问只会更快用光", () => {
    const d = createAskUserTool({ ask: async () => null, maxRounds: 2 }).description;
    expect(d).toContain("打断次数");
    expect(d).toContain("2");
  });
});

describe("决定 3 · 只有执行者能问；verifier / planner 一律拿不到这个工具", () => {
  const askTool = createAskUserTool({ ask: async () => ["委托方说用 TOML"] });
  const cfg = { systemPrompt: "s", workdir: process.cwd(), tools: [askTool] };

  it("verifier 的工具面上没有 ask_user——核查者要答案就不是独立核查了", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "ok"}')], "end_turn"),
    ]);
    await runVerifier(cfg, model, { task: "t", executorReport: "r" });
    const names = model.requests[0]!.tools.map((t) => t.name);
    expect(names).not.toContain(ASK_USER_TOOL_NAME);
    expect(names, "但终结工具要在").toContain("submit_verdict");
  });

  it("planner 的工具面上也没有——拆解阶段的澄清是另一套判据，不混做", async () => {
    const model = new FakeModelClient([
      fakeMessage(
        [textBlock('{"subtasks": [{"id":"s1","title":"a","description":"做 a","acceptance":[],"dependsOn":[]}]}')],
        "end_turn",
      ),
    ]);
    await runPlanner(cfg, model, "任务", []);
    expect(model.requests[0]!.tools.map((t) => t.name)).not.toContain(ASK_USER_TOOL_NAME);
  });

  it("剔除发生在 harness 层，不指望宿主装配时记得（P6）", () => {
    const kept = withoutAskUser([{ name: "bash" }, { name: ASK_USER_TOOL_NAME }, { name: "read_file" }]);
    expect(kept.map((t) => t.name)).toEqual(["bash", "read_file"]);
  });

  it("没装 ask_user 时剔除是恒等的——这个机制不得改变既有工具面", () => {
    const tools = [{ name: "bash" }, { name: "read_file" }];
    expect(withoutAskUser(tools)).toEqual(tools);
  });
});

describe("接进 loop：答复回到模型手里，运行不中断", () => {
  it("提问 → 答复进 tool_result → 模型据此继续并收笔", async () => {
    const tool = createAskUserTool({ ask: async () => ["Tauri", "沿用现有暗色系", "可运行骨架"] });
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_1", ASK_USER_TOOL_NAME, desktop)], "tool_use"),
      fakeMessage([textBlock("好，Tauri + 现有配色，先出骨架")], "end_turn"),
    ]);
    const events: string[] = [];
    let result;
    for await (const e of new AgentLoop(
      { systemPrompt: "s", workdir: process.cwd(), tools: [tool] },
      model,
    ).run("做一版 Desktop UI")) {
      events.push(e.type);
      if (e.type === "done") result = e.result;
    }
    expect(result!.stopReason).toBe("completed");
    // 三题答复都回到了第二次请求里
    const sent = JSON.stringify(model.requests[1]!.messages);
    expect(sent).toContain("Tauri");
    expect(sent).toContain("可运行骨架");
    expect(events).toContain("tool_call");
    expect(events).toContain("tool_result");
  });

  it("无人值守（宿主恒返回 null）也跑得完——默认关 + 过期语义共同保证不挂死", async () => {
    const tool = createAskUserTool({ ask: async () => null });
    const model = new FakeModelClient([
      fakeMessage([toolUseBlock("tu_1", ASK_USER_TOOL_NAME, one)], "tool_use"),
      fakeMessage([textBlock("没人答，按默认 JSON 做，已在报告里注明")], "end_turn"),
    ]);
    let result;
    for await (const e of new AgentLoop(
      { systemPrompt: "s", workdir: process.cwd(), tools: [tool] },
      model,
    ).run("t")) {
      if (e.type === "done") result = e.result;
    }
    expect(result!.stopReason).toBe("completed");
  });
});

describe("renderAnswers：写给模型看的回填格式", () => {
  it("答了的直连，没答的点名并带上它自己写的默认（不含糊过去）", () => {
    const out = renderAnswers(desktop.questions, ["Tauri", null, "可运行骨架"]);
    expect(out.split("\n")).toHaveLength(4); // 抬头 + 三题
    expect(out).toContain("→ Tauri");
    expect(out).toContain("按你写的默认执行：默认沿用");
  });
});

/**
 * L4 — Verifier subagent：用干净上下文核查主 agent 的产出。
 *
 * 设计要点（docs/02 L4 轮廓的落地）：
 * - 子代理 = 一个全新的 AgentLoop，复用父级的 systemPrompt + tools —— 请求前缀
 *   与父级一致，能蹭到 tools/system 层的缓存；
 * - "干净上下文"：verifier 看不到主 agent 的会话历史，只看到任务描述 + 执行者
 *   报告，必须自己动手核查实际产出 —— fresh-context 验证优于自我批评；
 * - 只读纪律由硬约束兜底（P6）：verifier 内部对一切 approval_request 自动 deny，
 *   permission="ask" 的写类工具在 verifier 里永远执行不了。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { AgentLoop, createRunBudget } from "./loop.js";
import { withoutTaskCompletion } from "./task-completion.js";
import { withoutAskUser } from "./tools/ask-user.js";
import type { AgentConfig, AggregateUsage, ModelClient, Tool, TurnEvent } from "./types.js";

export interface Verdict {
  passed: boolean;
  issues: string[];
  summary: string;
  /**
   * 查不了的验收项（rubric-verifier,案例 #6 催生）：verifier 缺乏核查手段时
   * 不猜测、不因"查不了"判 failed——逐条自陈缺什么手段,移交委托方复核。
   * 不影响 passed,不触发返工。缺省 = 无(旧裁决兼容)。
   */
  unverified?: string[];
  /**
   * 主观/评分表意见：好不好、清不清晰这类判断自陈判法后写在这里。
   * 不影响 passed,不触发返工——主观裁决权在委托方(案例 #1/#6 定论)。
   */
  advisory?: string[];
}

export interface VerifyOptions {
  /** 原始任务描述 */
  task: string;
  /** 主 agent 的完成报告（不可信输入——verifier 的职责就是不信它） */
  executorReport: string;
  /**
   * 领域验证指令（可选）：附加到 verifier 提示，说明"如何独立核查"。
   * 例如硬件调试场景：让 verifier 自己连板、重读故障寄存器，而非只看文件。
   */
  verifyInstructions?: string;
  /**
   * 只读命令白名单（可选，领域包声明）：verifier 的 bash 审批默认全 deny，
   * 但"独立重新推导"在需要工具链的领域（重新构建、nm 查符号）离不开命令——
   * 匹配白名单前缀且无写入风险形态的命令放行，其余照旧 deny。
   * v0.9/v1.0 实证：没有它，coding 域的 verifier 只能靠间接证据（读 .map）通过。
   */
  readOnlyCommands?: string[];
  /**
   * 主观评分表（可选,rubric 模式的载体）：任务的主要验收是主观质量时,
   * 把评分维度写在这里。verifier 按表逐维度评估,意见进 advisory,
   * 不影响 passed——客观 side 条款照常按字面进 issues。
   */
  rubric?: string;
  /**
   * 核查轮次预算（缺省 `DEFAULT_VERIFIER_MAX_TURNS` = 15）。
   *
   * 与执行者的 maxTurns 解耦（REPS=5 复现批的教训），但**不是一个放之四海的常数**：
   * 真机域每条验收都要多次探针往返，15 轮装不下（案例 #8 实测两轮 verifier
   * 都跑满 15 轮且从未写出裁决）。领域包用 `verify.maxTurns` 声明自己需要多少。
   */
  maxTurns?: number;
}

/**
 * 这次裁决是怎么拿到的——**让 fail-closed 的三种误伤形态第一次可计量**。
 *
 * 动机：项目对 fail-closed 有一整套设计（重问、收口续跑、过程摘要），但
 * "它们各自多久救一次场、还有多少漏网"从来没有数据。而 backlog §2.1
 * （结构化输出 `tool_choice`/`response_format`）的收益恰恰**完全取决于这个数**——
 * 若首轮解析成功率已经很高，那一整套能力探测 + 降级路径就不值得建。
 *
 * 项目自己的纪律是「失败形态即证据」「REPS=2 一律视为待复现」，所以先量再定。
 *
 * - `direct`   首轮就是可解析裁决——理想路径
 * - `wrapup`   撞满预算没收口，靠续跑同一会话救回（9.7）
 * - `reformat` 产出了散文但不是 JSON，靠重问转写救回
 * - `failed`   兜底都没救回，落 fail-closed（此时 summary 带过程摘要，见 9.2）
 */
export type VerdictRecovery = "tool" | "direct" | "wrapup" | "reformat" | "failed";

/**
 * 终结工具名（§2.1）。裁决从"最后一条消息里恰好是 JSON"变成**一次调用**。
 *
 * 为什么这才是 §2.1 该做的形状：台账 52 次裁决里 wrapup 69.2% / reformat 1.9%。
 * backlog 原案（`response_format: json_schema`）治的是 reformat 那 1.9%——
 * 模型写了散文。真正的大头是**跑满预算从没写出结论**，而那不是格式问题：
 * 在自由文本契约下，"停止取证、开始下结论"这个转换没有任何可执行的着力点，
 * 模型永远可以"再查一件事"。给它一个工具，这个转换才第一次变成一个动作——
 * 模型有得可做，harness 也才有地方强制它做（P6）。
 */
export const VERDICT_TOOL_NAME = "submit_verdict";

/**
 * 裁决交付工具。
 *
 * `execute` 在 loop 里**永远不会被调用**——AgentLoop 见到 `terminalTool` 就地收尾，
 * 走不到执行器。但 `Tool.execute` 是可直接调用的公开面（测试就这么用，见 §2.2
 * 那条分工说明），所以它得有个说得通的实现，而不是 throw。
 */
export function createVerdictTool(): Tool {
  return {
    name: VERDICT_TOOL_NAME,
    description:
      "提交最终裁决，结束本次核查。这是交付裁决的**唯一**方式——证据取够了就调用它。" +
      "调用之后核查立即结束，不会再有下一轮，所以调用前请确认该查的都查了。",
    inputSchema: {
      type: "object",
      properties: {
        passed: {
          type: "boolean",
          description:
            "你【实际核查过的客观项】是否全部符合。unverified 与 advisory 都不影响它。",
        },
        issues: {
          type: "array",
          items: { type: "string" },
          description: "客观项不符之处，每条一个字符串（含标准值 vs 实测值）；无则空数组",
        },
        unverified: {
          type: "array",
          items: { type: "string" },
          description: "缺手段或没来得及核查的项，每条注明缺什么手段；无则省略。不得因此判 failed",
        },
        advisory: {
          type: "array",
          items: { type: "string" },
          description: "主观质量意见/评分表结论，自陈判法；无则省略。不影响 passed",
        },
        summary: { type: "string", description: "一句话结论" },
      },
      required: ["passed", "summary"],
    },
    permission: "auto",
    parallelSafe: false,
    execute(input) {
      const v = verdictFromToolInput(input);
      return Promise.resolve(
        v
          ? { content: "裁决已记录。" }
          : { content: "裁决入参不合法：passed 必须是布尔、summary 必须是字符串。", isError: true },
      );
    },
  };
}

/**
 * 终结工具入参 → Verdict。**自己校验，不假定端点校验过**。
 *
 * loop 在执行器之前就截住了终结工具，所以 `validateToolInput` 那一层
 * （registry 里的 schema 校验）根本不经过；而"端点会按 schema 校验入参"正是
 * §2.1 想买的东西，却也正是兼容端点最可能不兑现的东西。所以这里自己查。
 *
 * 形状不合法时返回 undefined 而不是抛——降级回文本解析那条路（§2.2 定的
 * 降级语义：裁决侧缺字段应该降级，不是拒绝）。
 */
export function verdictFromToolInput(input: unknown): Verdict | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const o = input as Partial<Verdict>;
  if (typeof o.passed !== "boolean") return undefined;
  const unverified = Array.isArray(o.unverified) ? o.unverified.map(String) : [];
  const advisory = Array.isArray(o.advisory) ? o.advisory.map(String) : [];
  return {
    passed: o.passed,
    issues: Array.isArray(o.issues) ? o.issues.map(String) : [],
    summary: typeof o.summary === "string" ? o.summary : "",
    ...(unverified.length ? { unverified } : {}),
    ...(advisory.length ? { advisory } : {}),
  };
}

export interface VerifyOutcome {
  verdict: Verdict;
  usage: AggregateUsage;
  /** verifier 的原始最终输出（供审计） */
  raw: string;
  /** 裁决的获得路径。见 VerdictRecovery——它是 §2.1 该不该做的唯一判据 */
  recovery: VerdictRecovery;
}

/**
 * 核查轮次预算的缺省值。与执行者解耦（不随其 maxTurns 缩水），
 * 领域包可用 `verify.maxTurns` 按域覆盖——见 VerifyOptions.maxTurns。
 */
export const DEFAULT_VERIFIER_MAX_TURNS = 15;

/**
 * 预算用尽后"收口续跑"的额外轮次上限（9.7）。
 * 刻意很小：这一步只允许写裁决，不允许继续取证——大了就等于偷偷放宽调查预算。
 */
export const VERIFIER_WRAPUP_MAX_TURNS = 2;

export async function runVerifier(
  cfg: AgentConfig,
  model: ModelClient,
  opts: VerifyOptions,
  /** 过程事件透传：让宿主看到 verifier 自己的工具调用/复核过程（可见性） */
  onEvent?: (event: TurnEvent) => void | Promise<void>,
): Promise<VerifyOutcome> {
  // 与父级同 system/tools（缓存前缀一致）。轮次预算与执行者解耦——REPS=5 复现批
  // 教训：执行者被压到 maxTurns=8 时 verifier 若跟着缩水，核查跑不完，最终消息是
  // 半截引言 → fail-closed 噪声淹没实验信号。
  //
  // 但解耦≠一个常数走天下（案例 #8）：15 是按软件域定的，真机域每条验收都要
  // 多次探针往返，装不下。领域包可用 verify.maxTurns 声明自己需要多少。
  const verifierMaxTurns = opts.maxTurns ?? DEFAULT_VERIFIER_MAX_TURNS;
  const roleBase = withoutTaskCompletion(cfg);
  const verifierBudget = createRunBudget({
    ...(cfg.maxTotalTurns !== undefined ? { maxTurns: cfg.maxTotalTurns } : {}),
    ...(cfg.maxTokensBudget !== undefined ? { maxTokens: cfg.maxTokensBudget } : {}),
  });
  /**
   * §2.1：把裁决交付做成一个工具，挂在 verifier 的工具面上。
   *
   * 代价要说清楚：verifier 的 tools 块从此**与父级不同**，文件头那句
   * "请求前缀与父级一致，能蹭到 tools/system 层的缓存"对 verifier 不再成立
   * （缓存是前缀字节匹配，tools 渲染在最前）。这笔账实测很小——兼容端点上
   * 父子共享前缀本来就没兑现（cache_creation 恒 0、planner 首轮命中 0%），
   * 而 verifier 自己 run 内的增量缓存（实测 74~93%）完全不受影响。
   */
  const verifierCfg: AgentConfig = {
    ...roleBase,
    // withoutAskUser 是 §5.2 决定 3 的硬执行点：核查者不许问委托方要答案，
    // 它的公信力来自自己动手查。宿主一旦给执行者装了 ask_user，
    // 这份工具面会被 {...cfg} 原样继承过来——所以在这里剔，不在装配处指望人记得
    tools: [...withoutAskUser(roleBase.tools), createVerdictTool()],
    terminalTool: VERDICT_TOOL_NAME,
    runBudget: verifierBudget,
  };
  const first = await drainVerifierEvents(
    new AgentLoop({ ...verifierCfg, maxTurns: verifierMaxTurns }, model).run(
      buildVerifierPrompt(opts),
    ),
    onEvent,
    opts.readOnlyCommands,
  );

  // 交付路径一：终结工具。入参形状不合法时**降级**回文本解析而不是拒绝——
  // 端点未必真按 schema 校验，而裁决侧的缺字段语义是降级（§2.2 的定论）。
  const firstFromTool = verdictFromTerminal(first.terminalInput);
  let verdict = firstFromTool ?? parseVerdict(first.text);
  let raw = firstFromTool ? JSON.stringify(first.terminalInput) : first.text;
  let usage = first.usage;
  // 裁决获得路径：tool = 走了终结工具（§2.1 上线后的理想路径）；
  // direct = 末条消息恰好可解析（端点不认强制工具时的形态）；其余记录是哪一条兜底救的
  let recovery: VerdictRecovery = firstFromTool
    ? "tool"
    : isParseFailure(verdict)
      ? "failed"
      : "direct";

  /**
   * 兜底一：**预算用尽的收口续跑**（案例 #8 的 9.7）。
   *
   * 撞满轮次预算时，最终消息往往是半截工具调用、文本为空——没有可转写的东西，
   * 于是下面那条重问路径直接跳过，整场核查连同它已经取到的全部证据一起作废。
   * 案例 #8 三跑里这个形态出现了四次，其中一次 verifier 已经嗅到真缺陷并在追查。
   *
   * 正解是**续跑同一个会话**：`runContinuation` 把原会话正史带上，模型手里
   * 那些工具返回都还在，只是被要求"别查了，现在就用已有证据下结论"。
   * 这与下面的重问是两件事——重问另起新 loop、只喂原始文本，那条路对
   * "文本为空"的情形无能为力。
   *
   * 收口提示里明写"没查完的进 unverified、不得因没查完判 failed"——否则
   * 预算用尽会直接退化成 fail-closed 第三种误伤形态（把"没查"当成"没做对"）。
   */
  if (isParseFailure(verdict) && first.stopReason === "max_turns" && first.messages.length > 0) {
    const wrapUp = await drainVerifierEvents(
      /**
       * §2.1 把这一段从"禁工具"改成"**强制**交付工具"。
       *
       * B0b 那版是 `toolChoice:"none"`——它只说得出"别再调工具"，说不出
       * "现在就产出这个形状"。台账里 wrapup 占 69.2%，正说明"别查了、写结论"
       * 这句话即使被听进去，也还差一个可执行的动作。`{type:"tool"}` 两件事
       * 一起给：不许再取证（点名了唯一可调的工具），且必须交付（端点按 schema
       * 校验入参）。loop 层的 terminalTool 兜住"端点只收不认"的情形。
       */
      new AgentLoop(
        {
          ...verifierCfg,
          maxTurns: VERIFIER_WRAPUP_MAX_TURNS,
          toolChoice: { type: "tool", name: VERDICT_TOOL_NAME },
        },
        model,
      ).runContinuation(
        first.messages as Anthropic.MessageParam[],
        buildWrapUpPrompt(first.turns),
      ),
      onEvent,
      opts.readOnlyCommands,
    );
    usage = sumUsage(usage, wrapUp.usage);
    const wrapFromTool = verdictFromTerminal(wrapUp.terminalInput);
    const concluded = wrapFromTool ?? parseVerdict(wrapUp.text);
    if (!isParseFailure(concluded)) {
      verdict = concluded;
      raw = wrapFromTool ? JSON.stringify(wrapUp.terminalInput) : wrapUp.text;
      // 仍记 wrapup：这一档记的是"多付了一段续跑"，与它靠什么机制收口无关。
      // tool 与 direct 的对比才是"端点认不认强制工具"的读数。
      recovery = "wrapup";
    }
  }

  // 兜底二：裁决重问（一次）。核查做了但最终消息不是纯 JSON 时，让模型把已有结论
  // 转写成 JSON。fail-closed 直接返工会对正确产物空转（A/B 实测烧 10 万级 token），
  // 一次重问便宜得多。空输出没有可转写的结论，不重问（转写会变成无依据的编造）。
  if (isParseFailure(verdict) && first.text.trim() !== "") {
    const retry = await drainVerifierEvents(
      new AgentLoop(
        {
          ...roleBase,
          tools: withoutAskUser(roleBase.tools),
          maxTurns: 3,
          runBudget: verifierBudget,
        },
        model,
      ).run(buildReformatPrompt(first.text)),
      onEvent,
    );
    usage = sumUsage(usage, retry.usage);
    const second = parseVerdict(retry.text);
    if (!isParseFailure(second)) {
      verdict = second;
      raw = retry.text;
      recovery = "reformat";
    }
  }

  /**
   * 兜底三：**fail-closed 裁决要带过程摘要**（案例 #8 的 9.2）。
   *
   * `{passed:false, issues:["…无法解析…"]}` 对返工者是零信息量——它分不清
   * "核查者胡言乱语"和"核查者做了大量取证但没来得及收口"。案例 #8 是后者，
   * 而返工者拿到的信号与前者完全相同，只能从头再来，又烧光一整轮预算。
   *
   * 把过程事实写进 summary（返工提示是从裁决拼的，summary 会原样传过去），
   * 让返工者知道上一轮走到哪了。issues[0] 保持哨兵原文不动——
   * `isParseFailure` 与界面的核查饥饿判定都靠它。
   */
  if (isParseFailure(verdict)) {
    verdict = { ...verdict, summary: describeAbortedVerification(first, raw) };
  }

  return { verdict, usage, raw, recovery };
}

/** 把没收口的核查过程压成一句话，写进 fail-closed 裁决的 summary */
function describeAbortedVerification(
  run: { turns: number; stopReason: string | null; toolCalls: string[] },
  raw: string,
): string {
  const why =
    run.stopReason === "max_turns"
      ? `跑满 ${run.turns} 轮预算仍未收口`
      : `在第 ${run.turns} 轮以 ${run.stopReason ?? "未知原因"} 终止`;

  if (run.toolCalls.length === 0) {
    return `核查未产出可解析裁决：${why}，且全程零工具调用——核查很可能根本没有开展，不要据此认定产物有问题。`;
  }
  const tally = new Map<string, number>();
  for (const n of run.toolCalls) tally.set(n, (tally.get(n) ?? 0) + 1);
  const top = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([n, c]) => `${n}×${c}`)
    .join("、");
  const tail = raw.trim() ? `最后一条消息片段：「${raw.trim().slice(0, 80)}」` : "最终消息为空（停在半截工具调用）";
  return (
    `核查未产出可解析裁决：${why}，期间发起 ${run.toolCalls.length} 次工具调用（${top}）。` +
    `**这不等于产物有问题**——核查过程本身没走完，返工前请先看上面的核查日志判断它查到哪一步。${tail}`
  );
}

function isParseFailure(v: Verdict): boolean {
  return !v.passed && v.issues[0] === VERDICT_PARSE_FAIL;
}

/** 没调终结工具，或调了但入参不合法 → undefined（两种都该降级回文本解析） */
function verdictFromTerminal(input: unknown): Verdict | undefined {
  return input === undefined ? undefined : verdictFromToolInput(input);
}

/**
 * 消费一段 verifier 事件流。
 *
 * 收 `AsyncIterable<TurnEvent>` 而不是 (loop, prompt)，是为了让首轮 `run()` 与
 * 预算用尽后的 `runContinuation()` 走同一条消费逻辑——只读审批门、事件透传、
 * 过程统计三件事对两者都要一样。
 *
 * 返回值里的 messages/stopReason/toolCalls 是 9.7 与 9.2 的原料：
 * 续跑要正史，过程摘要要终止原因与工具统计。
 */
async function drainVerifierEvents(
  events: AsyncIterable<TurnEvent>,
  onEvent?: (event: TurnEvent) => void | Promise<void>,
  readOnlyCommands?: string[],
): Promise<{
  text: string;
  usage: AggregateUsage;
  messages: unknown[];
  stopReason: string | null;
  turns: number;
  toolCalls: string[];
  /** 终结工具的入参（§2.1 的交付载体）。没调过它就是 undefined */
  terminalInput: unknown;
}> {
  let finalText = "";
  let usage: AggregateUsage | undefined;
  let messages: unknown[] = [];
  let stopReason: string | null = null;
  const toolCalls: string[] = [];
  let terminalInput: unknown;

  for await (const event of events) {
    await onEvent?.(event);
    switch (event.type) {
      case "assistant_text":
        finalText = event.text; // 只留最后一条：契约要求最终消息为纯 JSON
        break;
      case "approval_request": {
        // 硬约束：verifier 只读。例外一：bash 命中领域包声明的只读白名单。
        // 例外二（案例 #9 收官催生的"给核查者装眼睛"）：describe_image——
        // 看图是只读取证，与白名单同性质；没配视觉模型时该工具根本不进
        // 工具面（宿主装配纪律），此分支天然不触发。
        if (event.name === "describe_image") {
          event.respond("allow");
          break;
        }
        const command =
          event.name === "bash" ? String((event.input as { command?: unknown })?.command ?? "") : "";
        if (command && readOnlyCommands && isReadOnlyCommand(command, readOnlyCommands)) {
          event.respond("allow");
        } else {
          const hint = readOnlyCommands?.length
            ? ` Allowed verification commands: ${readOnlyCommands.join(", ")} (no redirects/chaining).`
            : "";
          event.respond("deny", `Verifier is read-only. Use read_file or read-only commands to inspect.${hint}`);
        }
        break;
      }
      case "tool_call":
        toolCalls.push(event.name);
        // 终结工具的入参就是裁决本身。取最后一次——重复调用时以最终那次为准
        if (event.name === VERDICT_TOOL_NAME) terminalInput = event.input;
        break;
      case "done":
        usage = event.result.usage;
        messages = event.result.messages;
        stopReason = event.result.stopReason;
        break;
      default:
        break;
    }
  }

  return {
    text: finalText,
    usage: usage!,
    messages,
    stopReason,
    turns: usage?.turns ?? 0,
    toolCalls,
    terminalInput,
  };
}

/**
 * 预算用尽时的收口提示（续跑同一会话，正史与工具返回都还在上下文里）。
 *
 * 最后那条"不得因没查完判 failed"是关键：预算用尽若直接变成 failed，
 * 就是把"没查"当成"没做对"——fail-closed 第三种误伤形态（案例 #4 烧过 22 轮空转）。
 */
function buildWrapUpPrompt(turns: number): string {
  return `你的核查轮次预算已经用尽（已跑 ${turns} 轮）。**现在立刻调用 ${VERDICT_TOOL_NAME} 交付裁决**，用你手里已经取到的证据下结论——不要再取证，这一步只许交付。

- 已经查实的验收项照常判：全部符合 → passed=true；有明确不符 → 写进 issues；
- 因为预算用尽而**没来得及查完**的项，写进 unverified 并注明"预算用尽未及核查"——
  **不得因为没查完就判 failed**，那是把"没查"错当成"没做对"；
- 主观质量类判断写进 advisory 并自陈判法。

（若该工具在你这里不可用，退而把同样的对象作为最后一条消息原样输出：
{"passed": true/false, "issues": [...], "unverified": [...], "advisory": [...], "summary": "一句话结论"}）`;
}

/** 管道下游允许的通用只读过滤器 */
const READ_FILTERS = new Set([
  "grep", "wc", "sort", "head", "tail", "uniq", "cat", "od", "xxd",
  "awk", "cut", "tr", "diff", "cmp", "strings", "ls", "find",
]);

/**
 * 引号感知的命令扫描：按【引号外】的管道符切段，并报告引号外是否出现
 * 重定向/链式/命令替换。
 *
 * 为什么必须感知引号（案例 #7 实测催生）：正则整串匹配会把 grep 模式里的
 * 管道当成 shell 管道——`grep -n "a\|b" f` 被判非法后，verifier 只能退化成
 * 多条更弱的命令重试，白烧核查轮次（连续两轮 fail-closed 空转的元凶之一）。
 * 反过来，引号外的危险构造仍要拦住：护栏的目标是限定核查动作，不是安全沙箱。
 */
function scanCommand(cmd: string): { segments: string[]; dangerous: boolean } {
  const segments: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  let dangerous = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    const next = cmd[i + 1];

    if (quote) {
      if (ch === quote) quote = null;
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "\\" && next !== undefined) {
      buf += ch + next; // 转义字符整体保留：`\|` 是 grep 的交替符，不是管道
      i++;
      continue;
    }
    if (ch === ">" || ch === "<" || ch === ";" || ch === "`") {
      dangerous = true;
    } else if (ch === "$" && next === "(") {
      dangerous = true;
    } else if (ch === "&" && next === "&") {
      dangerous = true;
      buf += ch + next;
      i++;
      continue;
    } else if (ch === "|") {
      if (next === "|") {
        dangerous = true;
        buf += ch + next;
        i++;
        continue;
      }
      segments.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  segments.push(buf);
  // 引号未闭合 = 无法可靠判定边界，按可疑处理
  return { segments, dangerous: dangerous || quote !== null };
}

/**
 * 只读命令判定：首段必须命中白名单前缀（词边界），引号外禁止重定向、
 * 链式执行与命令替换；管道后续段允许白名单或通用只读过滤器。
 * 这是纪律护栏而非安全沙箱——目标是把 verifier 的"独立重推导"能力
 * 限定在核查动作上，不是抵御恶意。
 */
export function isReadOnlyCommand(command: string, allowedPrefixes: string[]): boolean {
  const cmd = command.trim();
  if (cmd === "" || allowedPrefixes.length === 0) return false;
  const { segments, dangerous } = scanCommand(cmd);
  if (dangerous) return false;

  const matchesPrefix = (segment: string): boolean =>
    allowedPrefixes.some((p) => {
      const prefix = p.trim();
      if (!segment.startsWith(prefix)) return false;
      const next = segment[prefix.length];
      return next === undefined || next === " "; // 词边界：防 "nm" 放行 "nmap"
    });

  return segments.map((s) => s.trim()).every((segment, i) => {
    if (segment === "") return false;
    if (matchesPrefix(segment)) return true;
    if (i === 0) return false;
    return READ_FILTERS.has(segment.split(/\s+/)[0] ?? "");
  });
}

export function sumUsage(a: AggregateUsage, b: AggregateUsage): AggregateUsage {
  const inputTokens = a.inputTokens + b.inputTokens;
  const cacheCreationTokens = a.cacheCreationTokens + b.cacheCreationTokens;
  const cacheReadTokens = a.cacheReadTokens + b.cacheReadTokens;
  const denom = inputTokens + cacheCreationTokens + cacheReadTokens;
  return {
    inputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    turns: a.turns + b.turns,
    cacheHitRatio: denom === 0 ? 0 : cacheReadTokens / denom,
  };
}

function buildReformatPrompt(raw: string): string {
  return `你刚才作为独立验证员（verifier）完成了核查，但最终消息不符合输出契约（必须是单个 JSON 对象）。你的核查结论原文如下：

<raw_verdict>
${raw}
</raw_verdict>

请把上述结论【原样转写】为契约要求的 JSON——不要重新核查、不要改变结论内容。
硬规则：如果原文并不包含明确的通过/失败判定（比如只是核查过程的引言、半截输出），你【不得编造】结论，必须输出 {"passed": false, "issues": ["核查未产出明确结论"], "summary": "原始输出无实质结论"}。
你的回复必须只包含一个 JSON 对象（不要代码围栏、不要多余文字）：
{"passed": true/false, "issues": ["客观项不符之处；无则空数组"], "unverified": ["缺手段核查的项；原文没有则省略"], "advisory": ["主观意见；原文没有则省略"], "summary": "一句话结论"}`;
}

function buildVerifierPrompt(opts: VerifyOptions): string {
  return `你现在的角色是独立验证员（verifier）。另一个 agent 声称完成了下面的任务。你的职责是用干净的视角核查【实际产出】——不要相信执行报告本身，报告里的每一条声明都要用工具核实。

<task>
${opts.task}
</task>

<executor_report>
${opts.executorReport}
</executor_report>

核查规则：
1. 只读核查：不得改动【被核查的产物】——不要修改、创建或删除任何文件或交付物，
   也不要用写入手段去制造你想要的结果。
   注意"只读"针对的是产物，**不等于"不许让被测系统运行"**：有些领域的被测对象
   必须处于运行态才有观测意义（真机固件、服务进程），把它带到可观测状态是取证的
   前置动作，不是修改产物。${opts.verifyInstructions ? "具体该怎么做、以及什么情况下【反而绝对不能】那么做（比如复位会毁掉故障现场），以下面的【领域核查方法】为准。" : "本次任务没有给出该领域的核查办法，所以不要自作主张去改变被测系统的状态。"}
2. 逐条核对任务要求与实际产出：有没有偷工减料或与报告不符之处。
3. 数值类声明（地址、寄存器值、行号、统计结果）必须独立重新获取，不能照抄报告。
4. 裁决按字面：任务与验收标准中的成文数值/条件逐条按【字面】判定——实测与标准不符时，
   即使你认为行为"实质合理/方向正确/持续递增也算递增"，也必须判 failed 并把
   【标准值 vs 实测值】写进 issues。你可以在 summary 里注明你怀疑标准本身有误，
   但裁决不得因此放行；标准的对错由任务的委托方裁定，不由核查者裁定。
5. 诚实降级：某条验收项你【缺乏手段】核查时（工具被拒、材料读不到、本质上不可程序化判定），
   不得猜测、也不得仅因"查不了"判 failed——把它写进 unverified，每条注明缺什么手段，
   移交委托方复核。主观质量类判断（好不好、清不清晰、是否优雅）写进 advisory 并自陈判法。
   passed 只由你【实际核查过的客观项】决定：客观项全过 = true（哪怕有 unverified/advisory），
   任一客观项不符 = false。
${opts.readOnlyCommands?.length ? `\n你的 bash 只放行以下核查命令（前缀匹配，禁止重定向/链式）：${opts.readOnlyCommands.join("、")}。用它们独立重新推导（如亲自重新构建、查符号），不要只依赖间接证据。\n` : ""}${opts.verifyInstructions ? `\n领域核查方法：\n${opts.verifyInstructions}\n` : ""}${opts.rubric ? `\n主观评分表（rubric）——本任务的主要验收是主观质量,按下表逐维度评估,每条意见进 advisory,格式"维度 | 结论 | 依据与判法"。评分表意见不影响 passed(主观裁决权在委托方),客观 side 条款照常按字面进 issues：\n${opts.rubric}\n` : ""}
交付方式：证据取够了就调用 **${VERDICT_TOOL_NAME}** 工具提交裁决——那是本次核查的唯一交付口，
调用之后核查立即结束。**不要把裁决写成正文再等下一轮**：轮次预算有限，"再查一件事"
永远还有下一件，你需要自己判断什么时候证据已经够了。
（若该工具在你这里不可用，退而把同样的对象作为最后一条消息原样输出，不要代码围栏、不要多余文字：
{"passed": true/false, "issues": ["客观项不符之处，每条一个字符串；无则空数组"], "unverified": ["缺手段核查的项及原因；无则省略"], "advisory": ["主观意见/评分；无则省略"], "summary": "一句话结论"}）`;
}

/** 解析失败的哨兵 issue 文本（fail-closed 裁决的第一条 issue 恒为它） */
export const VERDICT_PARSE_FAIL = "verifier 输出无法解析为 JSON 裁决";

/**
 * 宽容解析：兼容 compat 模型的输出习惯（代码围栏、JSON 前后带说明文字）。
 * 解析失败 = 不通过（fail-closed）——verifier 的输出不可解析本身就是问题。
 */
export function parseVerdict(text: string): Verdict {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/g);
  if (fenced) {
    for (const f of fenced) candidates.push(f.replace(/```(?:json)?\s*|```/g, ""));
  }
  // 贪婪抓取最外层 {...}（verifier 契约是"最后一条消息只含 JSON"，这里兜底）
  const braced = text.match(/\{[\s\S]*\}/);
  if (braced) candidates.push(braced[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<Verdict>;
      if (typeof parsed.passed === "boolean") {
        // 可选三值扩展字段仅在非空时保留——旧裁决形状(三字段)原样兼容
        const unverified = Array.isArray(parsed.unverified) ? parsed.unverified.map(String) : [];
        const advisory = Array.isArray(parsed.advisory) ? parsed.advisory.map(String) : [];
        return {
          passed: parsed.passed,
          issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
          summary: typeof parsed.summary === "string" ? parsed.summary : "",
          ...(unverified.length ? { unverified } : {}),
          ...(advisory.length ? { advisory } : {}),
        };
      }
    } catch {
      // 尝试下一个候选
    }
  }

  return {
    passed: false,
    issues: [VERDICT_PARSE_FAIL],
    summary: text.slice(0, 200) || "(空输出)",
  };
}

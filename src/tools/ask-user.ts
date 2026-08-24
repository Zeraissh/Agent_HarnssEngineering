/**
 * L2 — `ask_user`：需求澄清（backlog §5.2）。
 *
 * ================= 为什么它挂了这么久 =================
 * backlog 原话：「零实现。卡在判据不是实现——"什么时候该问、问几个"，
 * 做过头比不问更糟。」这句判断是对的：一个想问就问的 agent 会把委托方
 * 变成它的搜索引擎，而委托方雇它正是为了不必逐步指挥。
 *
 * 所以照 §5.1（计划确认门）的办法，**设计决定先写清再动手**：
 *
 * 1. **默认关，逐 run 显式开。**
 *    宿主也被脚本化驱动（eval、契约测试、无人值守 cron）。默认开 = 那些场景
 *    全部挂死等一个永远不会来的人，而"挂死等人"正是 V-01 修掉的那类失效。
 *
 * 2. **配额由 harness 强制，不写在提示里。**
 *    "问几个"才是这条一直做不下去的真正原因。答案不能是 prompt 里的
 *    "不要问太多"——P6：软约束不算约束，B0b 已经用两轮烧光的收口预算证明过
 *    模型会绕开成文纪律。
 *    **配额用尽不把工具从面上摘掉**——工具列表中途变化会让缓存前缀全灭（P3），
 *    而且"工具突然消失"对模型是一条无法解释的信号。留在面上、明确拒绝。
 *
 * 3. **只有执行者能问；verifier 与 planner 一律不接这个工具。**
 *    verifier 去问委托方，等于把"独立核查"换成"要答案"——它的公信力来自
 *    自己动手查。planner 提问是另一个设计（拆解阶段问的是"边界在哪"）。
 *
 * 4. **未应答 = 过期，不是失败。**
 *    超时、宿主关停、委托方就是不想回答——都回一条"按你的最佳判断继续，
 *    并把采用的假设写进最终报告"。不得挂死（V-01），也不得把"没人回答"
 *    画成异常终止（V-04：那是委托方的选择，不是故障）。
 *    **注意这里说的是"没有人"的场景**：有人在时就是该一直等，没有任何超时。
 *
 * 5. **每个问题必须带 2~4 个候选**，把开放式请求降维成可判定的选择（H1 的人机版）。
 *    自由输入不取消（相当于主流 agent 的「其他」逃生口）——强制的是模型先
 *    想清有哪几条路，不是限制人只能选。
 *
 * 6. **一次提交一组问题（1~4 个），配额计的是【打断次数】不是【问题数】。**
 *    委托方实测场景催生（2026-08-15）：「给这个项目开发一版 Desktop UI」
 *    一开口就是三个**正交**的未知——技术选型 / UI 风格 / 这次做到什么程度。
 *    按"一次一个问题"的旧设计，第一轮澄清就把额度用光，还要三次往返。
 *    **贵的是打断人，不是问题本身**：三个问题一屏答完是一次打断，
 *    拆成三轮就是三次。单位错了，配额就一定是错的。
 *
 * 7. **鼓励开工前问。** 范围与选型类的问题，做到一半才问时代价已经付出去了——
 *    这正是"修环境 > 提示词 > 事后核查"那条优先级排序（发现 2.5）的人机版：
 *    **开跑前把验收标准问清楚，比事后靠 verifier 抢救便宜得多**。
 *
 * ================= 与哲学的接口 =================
 * `SubTask.acceptance` 已经存在，H1 讲的是"把主观判断降维为可程序化条款"。
 * 需求澄清是人这一侧的同一件事，所以工具描述把提问的**时机与类别**写死在
 * 触发条件上，而不是泛泛地说"可以提问"。
 */
import type { Tool } from "../types.js";

export interface UserQuestion {
  /** 问题正文（模型写的） */
  question: string;
  /** 候选答案，必填 2~4 个（决定 5）。宿主渲染成选项，委托方点一下就能答 */
  options: string[];
  /** 模型自陈：拿不到答案时它打算怎么办——没有它，委托方无从判断这题值不值得答 */
  fallback: string;
}

/** 一次打断里提交的一组问题（决定 6） */
export interface AskUserRequest {
  questions: UserQuestion[];
}

/**
 * 宿主的应答通道。返回值与 `questions` **逐位对齐**：
 * 某一位是 null = 那一题没答（走它自己的 fallback）；
 * 整体返回 null = 这次打断没有得到任何应答（过期/中止）。**都不是错误**。
 */
export type AskUserResolver = (req: AskUserRequest) => Promise<(string | null)[] | null>;

export const ASK_USER_TOOL_NAME = "ask_user";

/** 选项数量的硬边界。少于 2 不成其为选择题；多于 4 就是把思考推回给人 */
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
/** 一次打断最多几个问题。超过 4 个就不是"一屏答完"了，那是问卷 */
export const MAX_QUESTIONS_PER_ROUND = 4;

/**
 * 缺省配额，单位是**打断次数**（决定 6）。
 *
 * 老实说：3 这个数**没有数据支撑，是判断不是证据**。旧版同样是 3，但单位是
 * 「问题数」——换成打断次数后额度实际宽了不少（3 次 × 至多 4 题 = 12 题）。
 * 台账已经按角色记工具直方图，`main: {ask_user: N}` 会自动入账且记的是**尝试**
 * 次数（配额用尽被拒的那次也发 tool_call），所以这个数是可以被测出来的——
 * 缺的只是一条先写死的判据。在有数据之前，它就只是个默认值。
 */
export const DEFAULT_MAX_ROUNDS = 3;

/**
 * 决定 3 的**硬执行点**：verifier / planner 的工具面必须剔掉 `ask_user`。
 *
 * 为什么不能只靠宿主装配时小心：宿主把工具装进 `AgentConfig.tools`，而
 * `runVerifier` / `runPlanner` 是 `{...cfg}` 继承那份工具面的——宿主一带，
 * 两个角色自动跟着拿到提问权。而 verifier 一旦能问委托方，"独立核查"就变成
 * "要答案"，它的全部公信力（干净上下文 + 自己动手查）当场作废。
 *
 * 这正是 P6：不变量靠 harness，不靠装配的人记得。
 */
export function withoutAskUser<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((t) => t.name !== ASK_USER_TOOL_NAME);
}

export interface AskUserOptions {
  ask: AskUserResolver;
  /** 整个 run 的**打断次数**上限（决定 6）。默认 3 */
  maxRounds?: number;
}

/**
 * 配额耗尽后的回复。写给模型看（P5）：说清发生了什么、现在该做什么。
 * 刻意**不**说"你问太多了"——那是评价；模型需要的是下一步动作。
 */
export function quotaExhaustedMessage(max: number): string {
  return (
    `澄清配额已用尽（本次运行最多打断委托方 ${max} 次）。不要再调用 ${ASK_USER_TOOL_NAME}。` +
    `按你当前的理解继续完成任务，并把你采用的关键假设逐条写进最终报告——` +
    `委托方据此复核，比停在这里等答案有用。`
  );
}

/** 整轮未应答时的回复（决定 4）。同样是动作导向，且明确这不是失败 */
export const UNANSWERED_MESSAGE =
  "委托方未应答（这不是错误，可能是无人值守或对方认为你可以自行判断）。" +
  "按你的最佳判断继续，并把你采用的假设写进最终报告。";

/** 逐题渲染答复。没答的那题照实说"未答 + 你自己写的默认"，不含糊过去 */
export function renderAnswers(questions: UserQuestion[], answers: (string | null)[]): string {
  const lines = questions.map((q, i) => {
    const a = answers[i];
    return a && a.trim()
      ? `- ${q.question} → ${a.trim()}`
      : `- ${q.question} →（委托方未答此题，按你写的默认执行：${q.fallback}）`;
  });
  return `委托方答复：\n${lines.join("\n")}`;
}

/** 校验一组问题；返回错误消息（写给模型看）或 undefined */
export function validateQuestions(input: unknown): { questions: UserQuestion[] } | { error: string } {
  const raw = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "无效入参：questions 必须是非空数组——把这次要问的问题一次性提交。" };
  }
  if (raw.length > MAX_QUESTIONS_PER_ROUND) {
    return {
      error:
        `无效入参：一次最多 ${MAX_QUESTIONS_PER_ROUND} 个问题（本次给了 ${raw.length} 个）。` +
        "超过这个数就不是「一屏答完」而是问卷了——挑最贵的几个岔路口先问。",
    };
  }

  const questions: UserQuestion[] = [];
  for (const [i, item] of (raw as Record<string, unknown>[]).entries()) {
    const at = `第 ${i + 1} 题`;
    const question = typeof item?.question === "string" ? item.question.trim() : "";
    if (!question) return { error: `无效入参：${at}的 question 必须是非空字符串。` };
    const fallback = typeof item?.fallback === "string" ? item.fallback.trim() : "";
    if (!fallback) {
      return {
        error: `无效入参：${at}缺 fallback——先写清拿不到答复时你打算怎么做，再来问。`,
      };
    }
    /**
     * 选项校验放在这里而不是只写进 schema：兼容端点未必真按 minItems 校验
     * （本轮真机探针刚证明过端点对参数的处理各家不同）。
     * 「schema 声明了」与「schema 被执行了」是两回事，不变量要自己守（P6）。
     */
    const options = Array.isArray(item?.options)
      ? (item.options as unknown[]).map(String).filter((s) => s.trim() !== "")
      : [];
    if (options.length < MIN_OPTIONS) {
      return {
        error:
          `无效入参：${at}的 options 至少 ${MIN_OPTIONS} 个互斥候选（本次 ${options.length} 个）。` +
          "想不出两条路，说明这不该是个问题——自己定，把假设写进报告。",
      };
    }
    // 多给的截掉而不是拒绝：想太细不是无效，拒绝会白烧一次打断
    questions.push({ question, fallback, options: options.slice(0, MAX_OPTIONS) });
  }
  return { questions };
}

/**
 * 造一个 `ask_user` 工具。
 *
 * **阻塞等人的机制不在这里**：`ask` 由宿主注入——CLI 用 readline，Web 宿主用
 * 与计划确认门同一套挂起/应答/过期机制。这与 §5.1 的分工完全一致（`onPlan`
 * 也是 harness 出口子、宿主接线），好处是 loop 与事件流零改动，
 * 而每个宿主可以用自己那套渲染与超时策略。
 */
export function createAskUserTool(opts: AskUserOptions): Tool {
  const max = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  let rounds = 0;

  return {
    name: ASK_USER_TOOL_NAME,
    description:
      "向委托方提一组澄清问题并等待答复。**把这次要问的都一次问完**——" +
      `一次最多 ${MAX_QUESTIONS_PER_ROUND} 个问题，而配额算的是【打断次数】` +
      `（整个任务最多 ${max} 次），所以分几次问只会更快用光。\n` +
      "**该问的两类**：\n" +
      "① 判据歧义——任务或验收标准有多种合理解释，且不同解释导致实质不同的" +
      "交付物（技术选型、UI 风格、这次做到什么程度、口径定义），即「猜错了就要返工重做」的岔路口；\n" +
      "② 只有委托方知道的事实——你**用尽工具也查不到**、只存在于对方脑子里的东西" +
      "（所在城市、用哪个账号、「我们的项目」指哪个仓库、他的偏好）。\n" +
      "**不该问的**：你自己查得到的事（文件内容、命令输出、代码现状——先去查）、" +
      "进度汇报、征求许可、以及你其实已经有合理默认值的细节。\n" +
      "**时机**：范围与选型类的问题要在**开工之前**问完。做到一半才问，代价已经付出去了。",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: MAX_QUESTIONS_PER_ROUND,
          description:
            `本次要问的全部问题（1~${MAX_QUESTIONS_PER_ROUND} 个）。彼此应当正交——` +
            "同一件事的不同侧面各占一题，不要把一个问题拆成两问",
          items: {
            type: "object",
            properties: {
              question: {
                type: "string",
                description: "一个具体问题。说清你为什么定不下来，而不只是抛出选择题",
              },
              options: {
                type: "array",
                items: { type: "string" },
                minItems: MIN_OPTIONS,
                maxItems: MAX_OPTIONS,
                description:
                  `${MIN_OPTIONS}~${MAX_OPTIONS} 个互斥的候选答案，**必填**。` +
                  "委托方点一下就能答，比让他写一段话更可能得到回复；" +
                  "而且逼你先想清到底有哪几条路。（对方仍可自由输入别的答案）",
              },
              fallback: {
                type: "string",
                description:
                  "这一题拿不到答复时你打算怎么做。**必填**——它让委托方能判断" +
                  "这题值不值得答，也逼你先想清默认路线",
              },
            },
            required: ["question", "options", "fallback"],
          },
        },
      },
      required: ["questions"],
    },
    /**
     * `auto` 而不是 `ask`：这个工具**本身就是**在征求人的意见，
     * 再套一层"要不要允许它问你"是同一件事问两遍。阻塞发生在 execute 里。
     */
    permission: "auto",
    parallelSafe: false,
    async execute(input, ctx) {
      const parsed = validateQuestions(input ?? {});
      if ("error" in parsed) return { content: parsed.error, isError: true };

      // 配额（决定 2/6）：harness 强制，单位是打断次数
      if (rounds >= max) return { content: quotaExhaustedMessage(max), isError: true };
      rounds += 1;

      /**
       * 中止（人按了停止 / 护栏触发）与"未应答"走同一条出口：都不是错误。
       * 不这么做的话，停止按钮会在这里变成一条 is_error 的工具失败，
       * 模型还会试着"从错误中恢复"——那是把委托方的决定说成故障。
       */
      if (ctx.signal.aborted) return { content: UNANSWERED_MESSAGE };

      /**
       * **与中止赛跑**，而不是干等宿主。
       *
       * 这一条是 Web 宿主接线时被测试当场抓出来的：宿主的 abort 端点只解除了
       * 挂起的审批与计划门，忘了提问——于是"停止"按下去，执行协程仍吊在这里，
       * run 永远收不了尾（V-01 那类失效原样重演）。
       *
       * 宿主那边当然要修（已修），但**不变量不能靠每个宿主都记得**（P6）：
       * 只要 signal 一响这里就自己走未应答出口，任何宿主都造不出这个挂死。
       */
      const answers = await Promise.race([
        opts.ask({ questions: parsed.questions }),
        new Promise<null>((resolve) => {
          ctx.signal.addEventListener("abort", () => resolve(null), { once: true });
        }),
      ]);

      if (answers === null) return { content: UNANSWERED_MESSAGE };
      // 一题没答也算整轮未应答——否则模型收到一份全是"未答"的清单，噪声而已
      if (!answers.some((a) => a !== null && a.trim() !== "")) {
        return { content: UNANSWERED_MESSAGE };
      }
      return { content: renderAnswers(parsed.questions, answers) };
    },
  };
}

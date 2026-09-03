/**
 * EVAL-03a — 确定性场景门（runner）。
 *
 * 被测对象是 **`dist/` 里编译出来的宿主**（`node dist/src/cli.js run …`），端点是
 * `eval/mock-provider.ts` 起的 loopback 假端点。两个选择都是刻意的：
 *
 * - **测 dist 而不是 tsx src**：CI 与容器里跑的是编译产物。`tsconfig.build.json`
 *   的 include/exclude、`copy-ui-assets`、ESM 出口这几处一漂，单测全绿而发布件
 *   起不来——本仓已经栽过"基线仪器也要跟 era"这一类（eval/run.ts 化石）。
 * - **测整条进程边界而不是 import 函数**：这里要钉的恰恰是单测按设计覆不到的缝——
 *   env 解析、退出码、工作目录圈禁、台账落盘、以及 `AgentLoop` ↔ `orchestrate`
 *   之间那些"纯函数全绿但组合起来错"的路径（见记忆 browser-only-defects 第五类）。
 *
 * 每个场景 = 一份**脚本队列** + 一次进程执行 + 一组声明式断言。脚本队列一次请求
 * 消费一条，所以断言里可以钉**请求条数**：多跑一轮 / 少跑一轮都当场变红，
 * 这是"行为没变"最便宜的判据。也因此**并发必须关掉**（计划场景一律 `--parallel=1`）——
 * 并发下队列消费顺序不确定，会把仪器自己变成噪声源。
 *
 * 断言优先选**可数事实**：产物字节、台账里的 `stopReason` / `reworks` /
 * `verifications[].recovery`、请求条数。终端文案只用来钉"这条路径确实走了"
 * （如 `⟲ 整段因瞬时故障终止`），不用来判对错。
 *
 * 用法：
 *   npm run build && npm run eval:deterministic
 *   npm run eval:deterministic -- --filter transient   # 只跑 id 含该子串的场景
 *   npm run eval:deterministic -- --keep               # 保留每个场景的临时工作目录
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  startMockProvider,
  type MockContentBlock,
  type MockFault,
  type MockProviderHandle,
  type MockTurnScript,
} from "./mock-provider.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** `tsconfig.build.json` 的 rootDir 是仓库根，所以 src/cli.ts → dist/src/cli.js */
const CLI_ENTRY = path.join(REPO_ROOT, "dist", "src", "cli.js");
const REPORT_JSON = path.join(REPO_ROOT, "eval", "deterministic-report.json");
const REPORT_MD = path.join(REPO_ROOT, "eval", "deterministic-report.md");
const SCENARIO_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------- 脚本构造

let toolUseSeq = 0;

function tu(name: string, input: Record<string, unknown> = {}): MockContentBlock {
  toolUseSeq += 1;
  return { type: "tool_use", id: `toolu_mock_${toolUseSeq}`, name, input };
}

function say(text: string): MockContentBlock {
  return { type: "text", text };
}

function turn(...content: MockContentBlock[]): MockTurnScript {
  return { content };
}

/**
 * 故障回合。`content` 对 status 类故障用不上（服务端直接回错误码），但对
 * `cut_stream` 有用——它要先按内容拼出帧序列，才谈得上"在第 N 个事件之后断"。
 */
function faultTurn(fault: MockFault): MockTurnScript {
  return { content: [say("interrupted")], fault };
}

interface FinishFields {
  artifacts?: string[];
  verification?: string[];
  assumptions?: string[];
  blockers?: string[];
}

function finishTask(
  status: "completed" | "partial" | "blocked",
  summary: string,
  extra: FinishFields = {},
): MockContentBlock {
  return tu("finish_task", {
    status,
    summary,
    artifacts: extra.artifacts ?? [],
    verification: extra.verification ?? [],
    assumptions: extra.assumptions ?? [],
    blockers: extra.blockers ?? [],
  });
}

function submitVerdict(v: {
  passed: boolean;
  summary: string;
  issues?: string[];
  unverified?: string[];
  advisory?: string[];
}): MockContentBlock {
  return tu("submit_verdict", {
    passed: v.passed,
    summary: v.summary,
    issues: v.issues ?? [],
    ...(v.unverified ? { unverified: v.unverified } : {}),
    ...(v.advisory ? { advisory: v.advisory } : {}),
  });
}

interface PlanSubtask {
  id: string;
  title: string;
  description: string;
  acceptance: string[];
  dependsOn: string[];
}

function submitPlan(subtasks: PlanSubtask[]): MockContentBlock {
  return tu("submit_plan", { subtasks: subtasks.map((s) => ({ ...s, pack: null })) });
}

// ---------------------------------------------------------------- 场景契约

interface LedgerExpectation {
  stopReason?: string;
  reworks?: number | null;
  finalPassed?: boolean | null;
  mode?: "single" | "plan";
  verify?: boolean;
  /** 逐轮裁决的获得路径（verifier.ts 的 VerdictRecovery），按顺序比对 */
  verificationRecoveries?: (string | null)[];
  /** 台账 context.windowSource（MEM-01 窗口 / 预算分离）：env | learned | registry | unknown */
  contextWindowSource?: string;
  /** 台账 context.window（token 数；null = 未知） */
  contextWindow?: number | null;
}

interface Expectation {
  exitCode: number;
  /** 剥掉 ANSI 后必须出现的片段 */
  includes?: string[];
  /** 剥掉 ANSI 后不得出现的片段 */
  excludes?: string[];
  /** 出现次数下限（用于"两次工具失败"这类可数事实） */
  occurrences?: { needle: string; atLeast: number }[];
  /** 工作目录下的产物：路径 → 精确内容 */
  files?: Record<string, string>;
  /** 工作目录下的文件必须**包含**这些片段（内容带时间戳、逐字节比对不可行时用） */
  filesContain?: Record<string, string[]>;
  /** 必须不存在的产物（圈禁类断言） */
  absentFiles?: string[];
  ledger?: LedgerExpectation;
  /** 请求总条数（含 secondRun 的请求）。多一条少一条都是行为变了 */
  requestCount: number;
}

/**
 * 同一场景里的**第二个进程**：同工作目录、同 mock（脚本追加进队列）。用来钉只有跨进程
 * 才验得出的事——落盘到 cwd 的状态（学到的上下文窗口）被下一次启动读回。
 * 它的输出单独断言（includes / excludes / exitCode）；台账与 requestCount 看整个场景的终态。
 */
interface SecondRun {
  args: string[];
  task: string;
  env?: Record<string, string>;
  scripts: MockTurnScript[];
  expect: { exitCode: number; includes?: string[]; excludes?: string[] };
}

interface Scenario {
  id: string;
  title: string;
  /** 这个场景到底在守什么——报告里原样带出，接手不必反推 */
  guards: string;
  /** `run` 之后的参数（任务文本由 task 单独给，始终排在最后） */
  args: string[];
  task: string;
  env?: Record<string, string>;
  /** 喂给子进程 stdin 的内容（只有 --ask 场景需要） */
  stdin?: string;
  /** 执行前在工作目录里铺的种子文件 */
  seed?: Record<string, string>;
  scripts: MockTurnScript[];
  expect: Expectation;
  secondRun?: SecondRun;
}

// ---------------------------------------------------------------- 场景

const scenarios: Scenario[] = [
  {
    id: "single-edit-finish",
    title: "写文件 + finish_task(completed)",
    guards: "最短的成功闭环：审批自动放行、写盘落到工作目录、结构化完成门收 completed",
    args: ["--yes"],
    task: "write report.txt",
    scripts: [
      turn(
        say("I will write the report file."),
        tu("write_file", { path: "report.txt", content: "deterministic ok\n" }),
      ),
      turn(
        finishTask("completed", "wrote report.txt", {
          artifacts: ["report.txt"],
          verification: ["write_file returned success"],
        }),
      ),
    ],
    expect: {
      exitCode: 0,
      includes: ["completed", "auto-approved: write_file"],
      files: { "report.txt": "deterministic ok\n" },
      ledger: { stopReason: "completed", mode: "single", verify: false },
      requestCount: 2,
    },
  },

  {
    id: "tool-errors-then-partial",
    title: "工具失败两次（缺文件 / 越出工作目录）→ finish_task(partial)",
    guards:
      "失败路径：ENOENT 与工作目录圈禁都必须回 is_error 而不是静默成功；" +
      "partial 必须带 blockers 才算合法交付",
    args: ["--yes"],
    task: "inspect missing input and try to escape the workdir",
    scripts: [
      turn(tu("read_file", { path: "missing-input.txt" })),
      turn(tu("write_file", { path: "../escaped.txt", content: "should never land\n" })),
      turn(
        finishTask("partial", "input file missing; nothing delivered", {
          blockers: ["missing-input.txt does not exist"],
        }),
      ),
    ],
    expect: {
      exitCode: 0,
      includes: ["partial"],
      occurrences: [{ needle: "✗", atLeast: 2 }],
      absentFiles: ["../escaped.txt"],
      ledger: { stopReason: "partial" },
      requestCount: 3,
    },
  },

  {
    id: "finish-task-invalid-then-valid",
    title: "finish_task 语义违规（completed 带 blockers）→ 纠正后 completed",
    guards:
      "§2.2 的定论：schema 声明过 ≠ 端点校验过。completed+blockers 自相矛盾必须被" +
      "运行时挡住并给一次纠正机会，而不是当成成功收尾",
    args: ["--yes"],
    task: "declare completion",
    scripts: [
      turn(
        finishTask("completed", "done but not really", { blockers: ["still broken"] }),
      ),
      turn(finishTask("completed", "actually done", { verification: ["re-read the file"] })),
    ],
    expect: {
      exitCode: 0,
      includes: ["completed"],
      occurrences: [{ needle: "✗", atLeast: 1 }],
      ledger: { stopReason: "completed" },
      requestCount: 2,
    },
  },

  {
    id: "completion-gate-forces-incomplete",
    title: "只用文字宣称完成、从不调 finish_task → incomplete",
    guards:
      "wire 层 end_turn ≠ 业务层完成。两次提醒后强制收口，模型仍不交付就必须是 " +
      "incomplete（红），不能被画成绿色的成功",
    args: ["--yes"],
    task: "summarize the repository",
    scripts: [
      turn(say("All done, the summary is finished.")),
      turn(say("Yes, truly finished.")),
      turn(say("Finished again.")),
    ],
    expect: {
      exitCode: 0,
      includes: ["incomplete", "恢复决策"],
      excludes: ["■ completed"],
      ledger: { stopReason: "incomplete" },
      requestCount: 3,
    },
  },

  {
    id: "verify-reject-rework-pass",
    title: "核查未通过 → 返工一轮 → 复核通过",
    guards:
      "编排闭环：裁决 failed 必须驱动返工、返工产物必须覆盖旧内容、第二次裁决" +
      "通过才算过。台账 reworks=1 是这条路径唯一的可数证据",
    args: ["--yes", "--verify"],
    task: "write answer.txt containing the final answer",
    scripts: [
      // 第一轮执行：写了个错的
      turn(tu("write_file", { path: "answer.txt", content: "wrong\n" })),
      turn(finishTask("completed", "wrote answer.txt", { artifacts: ["answer.txt"] })),
      // 第一次核查：拒签
      turn(
        submitVerdict({
          passed: false,
          summary: "answer.txt content does not match the requirement",
          issues: ["answer.txt: expected \"42\", measured \"wrong\""],
        }),
      ),
      // 返工
      turn(tu("write_file", { path: "answer.txt", content: "42\n" })),
      turn(finishTask("completed", "fixed answer.txt", { artifacts: ["answer.txt"] })),
      // 第二次核查：通过
      turn(submitVerdict({ passed: true, summary: "answer.txt now reads 42" })),
    ],
    expect: {
      exitCode: 0,
      includes: ["核查通过", "返工 1 轮", "核查未通过，开始返工"],
      files: { "answer.txt": "42\n" },
      ledger: {
        stopReason: "completed",
        reworks: 1,
        finalPassed: true,
        verify: true,
        verificationRecoveries: ["tool", "tool"],
      },
      requestCount: 6,
    },
  },

  {
    id: "verifier-readonly-deny",
    title: "无包核查者：写类 bash 被只读门拒绝，通用只读缺省放行 cat → 交付裁决",
    guards:
      "verifier 只读硬约束（P6）两面：① 无领域包时核查者拿**通用只读缺省**（委托方批准的例外，" +
      "否则连 cat 都被拒、核查饥饿落 unverified）——`cat answer.txt` 必须真的执行并回 42；" +
      "② 写类构造（重定向）仍必须 deny 且回 is_error，产物一个字节不许动",
    args: ["--yes", "--verify"],
    task: "write answer.txt containing 42",
    scripts: [
      turn(tu("write_file", { path: "answer.txt", content: "42\n" })),
      turn(finishTask("completed", "wrote answer.txt", { artifacts: ["answer.txt"] })),
      // 核查第一轮：试图改写产物（重定向 = 写路径）→ deny
      turn(tu("bash", { command: "echo 0 > answer.txt" })),
      // 核查第二轮：通用只读缺省放行 cat → 真实产出 42
      turn(tu("bash", { command: "cat answer.txt" })),
      turn(submitVerdict({ passed: true, summary: "answer.txt reads 42 (verified via cat)" })),
    ],
    expect: {
      exitCode: 0,
      // 「║ ✓ [execution boundary=」= 核查者的 bash 真的执行了（被 deny 的调用不会产生执行边界头）
      includes: ["核查通过", "Verifier is read-only", "║ ✓ [execution boundary=", "verifier whitelist: 13 条 (default)"],
      // deny 真的挡住了写：产物仍是 42
      files: { "answer.txt": "42\n" },
      ledger: { finalPassed: true, verificationRecoveries: ["tool"] },
      requestCount: 5,
    },
  },

  {
    id: "verifier-budget-wrapup",
    title: "核查预算用尽 → 收口续跑交付裁决（recovery=wrapup）",
    guards:
      "9.7：撞满核查预算不得让整场取证作废。续跑必须带着原会话正史、并在 " +
      "toolChoice 强制下交付裁决——台账 recovery=wrapup 就是它生效的读数",
    args: ["--yes", "--verify"],
    // 预算刻意压到 2：调查两轮就撞线，收口段（VERIFIER_WRAPUP_MAX_TURNS=2）另算
    env: { AGENT_VERIFY_MAX_TURNS: "2" },
    task: "write answer.txt containing 42",
    scripts: [
      turn(tu("write_file", { path: "answer.txt", content: "42\n" })),
      turn(finishTask("completed", "wrote answer.txt", { artifacts: ["answer.txt"] })),
      // 核查两轮只取证、不下结论 → max_turns
      turn(tu("read_file", { path: "answer.txt" })),
      turn(tu("read_file", { path: "answer.txt" })),
      // 收口续跑：这一条是 9.7 的产物
      turn(
        submitVerdict({
          passed: true,
          summary: "budget exhausted wrap-up verdict",
          unverified: ["byte-level diff not run: verification budget exhausted"],
        }),
      ),
    ],
    expect: {
      exitCode: 0,
      includes: ["核查通过", "budget exhausted wrap-up verdict", "待委托方复核"],
      excludes: ["无法解析"],
      ledger: { finalPassed: true, verificationRecoveries: ["wrapup"] },
      requestCount: 5,
    },
  },

  {
    id: "transient-429-same-turn-retry",
    title: "429（带 Retry-After）→ 同轮重试成功",
    guards:
      "瞬时错误的第一层兜底：SDK 重试关掉后，loop 层必须同轮幂等重发并发出 " +
      "api_retry 事件；重试成功后本轮照常继续，不留下 error",
    args: ["--yes"],
    // SDK 自己的 HTTP 重试关掉，否则请求条数不可数、也测不到 loop 这一层
    env: { AGENT_MAX_RETRIES: "0" },
    task: "write report.txt",
    scripts: [
      faultTurn({ type: "status", status: 429 }),
      turn(tu("write_file", { path: "report.txt", content: "after retry\n" })),
      turn(finishTask("completed", "wrote report.txt", { artifacts: ["report.txt"] })),
    ],
    expect: {
      exitCode: 0,
      includes: ["completed", "API 瞬时错误，同轮重试 #1"],
      files: { "report.txt": "after retry\n" },
      ledger: { stopReason: "completed" },
      requestCount: 3,
    },
  },

  {
    id: "transient-500-segment-resume",
    title: "同轮重试也救不回（500 ×2）→ 段级续跑带正史接着做",
    guards:
      "9.8：整段因瞬时故障死掉时不得把已完成的工作作废。必须发 segment_resume，" +
      "并在续跑段里凭正史收尾——而不是从头重来",
    args: ["--yes", "--verify"],
    env: { AGENT_MAX_RETRIES: "0" },
    task: "write answer.txt containing 42",
    scripts: [
      turn(tu("write_file", { path: "answer.txt", content: "42\n" })),
      // 同一轮两次 500：attempt0 触发 api_retry，attempt1 耗尽 errorRetries → 段死
      faultTurn({ type: "status", status: 500 }),
      faultTurn({ type: "status", status: 500 }),
      // 续跑段：正史里 write_file 还在，直接收尾
      turn(finishTask("completed", "answer.txt already written before the outage", {
        artifacts: ["answer.txt"],
      })),
      turn(submitVerdict({ passed: true, summary: "answer.txt reads 42" })),
    ],
    expect: {
      exitCode: 0,
      includes: ["整段因瞬时故障终止", "带 1 轮正史续跑", "核查通过"],
      files: { "answer.txt": "42\n" },
      ledger: { stopReason: "completed", finalPassed: true },
      requestCount: 5,
    },
  },

  {
    id: "transient-cut-stream-segment-resume",
    title: "流中途断掉 ×2 → 段级续跑（与状态码故障同一条路）",
    guards:
      "断流不是状态码，走的是另一条 SDK 失败路径。它必须同样被判为瞬时" +
      "（否则整段工作被一次抖动作废），且不得被静默吞成一次空成功",
    args: ["--yes", "--verify"],
    env: { AGENT_MAX_RETRIES: "0" },
    task: "write answer.txt containing 42",
    scripts: [
      turn(tu("write_file", { path: "answer.txt", content: "42\n" })),
      faultTurn({ type: "cut_stream", afterEvents: 2 }),
      faultTurn({ type: "cut_stream", afterEvents: 2 }),
      turn(finishTask("completed", "answer.txt survived the stream cut", {
        artifacts: ["answer.txt"],
      })),
      turn(submitVerdict({ passed: true, summary: "answer.txt reads 42" })),
    ],
    expect: {
      exitCode: 0,
      includes: ["整段因瞬时故障终止", "核查通过"],
      files: { "answer.txt": "42\n" },
      ledger: { stopReason: "completed", finalPassed: true },
      requestCount: 5,
    },
  },

  {
    id: "context-overflow-reactive-compaction",
    title: "端点 400「prompt is too long」→ 反应式硬压缩 → 同轮重发成功",
    guards:
      "MEM-01 Phase C：上下文超长是永久性 400，此前直接 finish(error) 整段作废。现在必须" +
      "忽略水位做一次硬压缩（折叠旧轮、保护窗收到 2）并重发同一轮，且不占瞬时重试额度。" +
      "请求条数可数：3 轮工具 + 1 次撞墙 + 1 次重发 = 5；三个文件都在，run 以 completed 收尾",
    args: ["--yes"],
    env: { AGENT_MAX_RETRIES: "0" },
    task: "write three notes then finish",
    scripts: [
      turn(tu("write_file", { path: "n1.txt", content: "one\n" })),
      turn(tu("write_file", { path: "n2.txt", content: "two\n" })),
      turn(tu("write_file", { path: "n3.txt", content: "three\n" })),
      // 第 4 次请求撞上下文超长：loop 应硬压缩后用同一轮重发（下一条脚本）
      faultTurn({ type: "context_overflow" }),
      turn(finishTask("completed", "three notes written", { artifacts: ["n1.txt", "n2.txt", "n3.txt"] })),
    ],
    expect: {
      exitCode: 0,
      includes: ["context compacted (reactive", "collapsed 2 earlier turns", "completed"],
      // 以 error 收尾时终端会打出 context_overflow 分类；成功路径上它不该出现
      excludes: ["context_overflow"],
      files: { "n1.txt": "one\n", "n2.txt": "two\n", "n3.txt": "three\n" },
      ledger: { stopReason: "completed" },
      requestCount: 5,
    },
  },

  {
    id: "context-window-learned-across-runs",
    title: "撞 400 学到窗口 → 落盘 → 下一个进程按 learned 解析",
    guards:
      "MEM-01 窗口 / 预算分离：mock-model 不在登记表，第一跑启动行必须写「窗口未知」；撞 context_overflow" +
      "（报文 > 200000 maximum）除了反应式压缩还要把 200000 记进 .agent-capabilities.json；第二跑是**新进程**，" +
      "启动行必须写「窗口 200k（来源：learned）」且默认预算 150k 不被夹（200000 − 4096 − 4096 = 191,808 ≥ 150k）；" +
      "台账 context.windowSource=learned。请求 5 + 2 = 7",
    args: ["--yes"],
    env: { AGENT_MAX_RETRIES: "0" },
    task: "write three notes then finish",
    scripts: [
      turn(tu("write_file", { path: "n1.txt", content: "one\n" })),
      turn(tu("write_file", { path: "n2.txt", content: "two\n" })),
      turn(tu("write_file", { path: "n3.txt", content: "three\n" })),
      faultTurn({ type: "context_overflow" }),
      turn(finishTask("completed", "three notes written", { artifacts: ["n1.txt", "n2.txt", "n3.txt"] })),
    ],
    expect: {
      exitCode: 0,
      includes: ["窗口未知", "context compacted (reactive", "学到窗口 200k", "completed"],
      excludes: ["来源：learned", "context_overflow"],
      files: { "n1.txt": "one\n", "n2.txt": "two\n", "n3.txt": "three\n", "n4.txt": "four\n" },
      // 落盘格式：身份键 provider|model|origin（不含 key）+ 学到的数；时间戳不可逐字节比对，只查片段
      filesContain: {
        ".agent-capabilities.json": ['"windowTokens": 200000', "anthropic|mock-model|http://127.0.0.1:", '"evidence": "overflow_400"'],
      },
      ledger: { stopReason: "completed", contextWindowSource: "learned", contextWindow: 200000 },
      requestCount: 7,
    },
    secondRun: {
      args: ["--yes"],
      task: "write one more note",
      scripts: [
        turn(tu("write_file", { path: "n4.txt", content: "four\n" })),
        turn(finishTask("completed", "one more note", { artifacts: ["n4.txt"] })),
      ],
      expect: {
        exitCode: 0,
        includes: ["上下文：预算 150k / 窗口 200k（来源：learned）", "completed"],
        excludes: ["窗口未知", "夹紧"],
      },
    },
  },

  {
    id: "plan-two-subtasks-serial",
    title: "freeform 计划：两个子任务串行执行并逐个核查",
    guards:
      "三角编排的最小闭环：planner 终结工具交付计划 → 依赖图按序调度 → 每个子" +
      "任务各自执行+核查。并行度显式压到 1，让脚本队列的消费顺序确定",
    // --parallel=1 不是性能选择，是仪器纪律：并发下队列顺序不可数
    args: ["--yes", "--plan", "--parallel=1"],
    task: "create two files: alpha.txt and beta.txt",
    scripts: [
      turn(
        submitPlan([
          {
            id: "s1",
            title: "create alpha.txt",
            description: "Write alpha.txt containing exactly: alpha",
            acceptance: ["alpha.txt exists and contains alpha"],
            dependsOn: [],
          },
          {
            id: "s2",
            title: "create beta.txt",
            description: "Write beta.txt containing exactly: beta",
            acceptance: ["beta.txt exists and contains beta"],
            dependsOn: ["s1"],
          },
        ]),
      ),
      turn(tu("write_file", { path: "alpha.txt", content: "alpha\n" })),
      turn(finishTask("completed", "wrote alpha.txt", { artifacts: ["alpha.txt"] })),
      turn(submitVerdict({ passed: true, summary: "alpha.txt reads alpha" })),
      turn(tu("write_file", { path: "beta.txt", content: "beta\n" })),
      turn(finishTask("completed", "wrote beta.txt", { artifacts: ["beta.txt"] })),
      turn(submitVerdict({ passed: true, summary: "beta.txt reads beta" })),
    ],
    expect: {
      exitCode: 0,
      includes: ["═══ 计划", "s1 create alpha.txt", "s2 create beta.txt", "全部子任务执行并核查通过"],
      files: { "alpha.txt": "alpha\n", "beta.txt": "beta\n" },
      ledger: { stopReason: "completed", mode: "plan", finalPassed: true },
      requestCount: 7,
    },
  },

  {
    id: "edit-file-targeted",
    title: "edit_file 唯一命中 → 局部改盘 → completed",
    guards:
      "A1：str_replace 局部编辑必须落到工作目录、唯一性由宿主执行；" +
      "审批自动放行后字节级替换成功，finish_task 收 completed",
    args: ["--yes"],
    task: "change the greeting in hello.txt from hello to hi",
    seed: { "hello.txt": "hello world\n" },
    scripts: [
      turn(
        say("I will edit hello.txt in place."),
        tu("edit_file", {
          path: "hello.txt",
          old_string: "hello world",
          new_string: "hi world",
        }),
      ),
      turn(
        finishTask("completed", "greeting updated", {
          artifacts: ["hello.txt"],
          verification: ["edit_file returned success"],
        }),
      ),
    ],
    expect: {
      exitCode: 0,
      includes: ["completed", "auto-approved: edit_file"],
      files: { "hello.txt": "hi world\n" },
      ledger: { stopReason: "completed", mode: "single", verify: false },
      requestCount: 2,
    },
  },

  {
    id: "edit-file-widen-context",
    title: "edit_file 多命中报错 → 扩上下文重抄 → completed",
    guards:
      "A1：多命中且未给 replace_all 必须是 is_error 并带命中次数；" +
      "模型扩上下文后第二次编辑成功",
    args: ["--yes"],
    task: "change only the second TODO line in notes.txt",
    seed: { "notes.txt": "TODO: alpha\nTODO: beta\nTODO: gamma\n" },
    scripts: [
      turn(
        tu("edit_file", {
          path: "notes.txt",
          old_string: "TODO:",
          new_string: "DONE:",
        }),
      ),
      turn(
        say("The first attempt was not unique; I will include surrounding lines."),
        tu("edit_file", {
          path: "notes.txt",
          old_string: "TODO: beta",
          new_string: "DONE: beta",
        }),
      ),
      turn(
        finishTask("completed", "second TODO updated", {
          artifacts: ["notes.txt"],
          verification: ["only the middle line changed"],
        }),
      ),
    ],
    expect: {
      exitCode: 0,
      includes: ["completed", "not unique", "auto-approved: edit_file"],
      files: { "notes.txt": "TODO: alpha\nDONE: beta\nTODO: gamma\n" },
      ledger: { stopReason: "completed", mode: "single", verify: false },
      requestCount: 3,
      occurrences: [{ needle: "✗", atLeast: 1 }],
    },
  },

  {
    id: "ask-user-one-round",
    title: "ask_user 提问一轮 → 委托方从 stdin 选项作答 → completed",
    guards:
      "§5.2 澄清面：--ask 装上工具后，提问必须真的阻塞等人、答复必须回到工具结果，" +
      "而 --yes 无人值守下这个工具根本不该在场（由 CLI 参数互斥保证）",
    args: ["--ask"],
    // 一次读行：选 1 号候选。stdin 提前给足，readline 拿到后立即返回
    stdin: "1\n",
    task: "pick a report format and finish",
    scripts: [
      turn(
        tu("ask_user", {
          questions: [
            {
              question: "Which report format should I deliver?",
              options: ["markdown", "plain text"],
              fallback: "markdown",
            },
          ],
        }),
      ),
      turn(
        finishTask("completed", "format decided by the delegate", {
          assumptions: [],
          verification: ["delegate answered the format question"],
        }),
      ),
    ],
    expect: {
      exitCode: 0,
      includes: ["agent 有 1 个问题需要你定", "completed"],
      ledger: { stopReason: "completed" },
      requestCount: 2,
    },
  },
];

// ---------------------------------------------------------------- 执行

const ANSI = /\u001b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/**
 * 子进程环境从零装配：**先把继承来的 AGENT_/ANTHROPIC_/OPENAI_ 全部剥掉**。
 *
 * 这条是仪器纪律，不是洁癖。本仓踩过三次同一个坑：agent 会话 shell 里残留的
 * `ANTHROPIC_BASE_URL` 压过了 `--env-file`，于是"确定性门"其实在打真端点。
 * 残留变量绝不允许武装被测宿主。
 */
function childEnv(
  workdir: string,
  mock: MockProviderHandle,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(AGENT_|ANTHROPIC_|OPENAI_)/.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    ANTHROPIC_BASE_URL: mock.anthropicBaseUrl,
    ANTHROPIC_API_KEY: "mock-key",
    AGENT_PROVIDER: "anthropic",
    // 非 claude-* → compat 模式：不发 thinking/effort/cache_control，与假端点契约一致
    AGENT_MODEL: "mock-model",
    // 指向不存在的文件 = 关掉 MCP（工具面必须只有内置工具，否则脚本对不上名字）
    AGENT_MCP_CONFIG: path.join(workdir, "no-such-mcp.json"),
    AGENT_MEMORY_DIR: path.join(workdir, ".agent-memory"),
    AGENT_RUN_LEDGER: path.join(workdir, "ledger.jsonl"),
    AGENT_RUN_HISTORY_DIR: path.join(workdir, ".agent-run-history"),
    AGENT_MAX_TOKENS: "4096",
    AGENT_TIMEOUT_MS: "20000",
    AGENT_EXECUTION_ISOLATION: "off",
    ...extra,
  };
}

interface ProcessOutcome {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

function runCli(
  scenario: Pick<Scenario, "args" | "task" | "env" | "stdin">,
  workdir: string,
  mock: MockProviderHandle,
): Promise<ProcessOutcome> {
  const args = [CLI_ENTRY, "run", ...scenario.args, scenario.task];
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: workdir,
      env: childEnv(workdir, mock, scenario.env ?? {}),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.stdin.end(scenario.stdin ?? "");
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, SCENARIO_TIMEOUT_MS);
    child.once("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        signal: null,
        stdout,
        stderr: `${stderr}\nspawn failed: ${err.message}`,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

// ---------------------------------------------------------------- 断言

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** 台账最后一行。宿主是 fire-and-forget 写的，所以"没有行"本身是一个断言结果 */
async function lastLedgerEntry(workdir: string): Promise<Record<string, unknown> | null> {
  const raw = await readIfExists(path.join(workdir, "ledger.jsonl"));
  if (!raw) return null;
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const last = lines.at(-1);
  if (!last) return null;
  try {
    return JSON.parse(last) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return n;
    n += 1;
    from = at + needle.length;
  }
}

/** 一个进程的退出码 / 输出片段断言；第二个进程复用同一套（名字带前缀以便区分） */
function processChecks(
  label: string,
  outcome: ProcessOutcome,
  expect: { exitCode: number; includes?: string[]; excludes?: string[] },
): Check[] {
  const checks: Check[] = [];
  const out = stripAnsi(`${outcome.stdout}\n${outcome.stderr}`);
  checks.push({
    name: `${label}进程正常结束（未超时）`,
    ok: !outcome.timedOut,
    ...(outcome.timedOut ? { detail: `超过 ${SCENARIO_TIMEOUT_MS}ms 被杀` } : {}),
  });
  checks.push({
    name: `${label}退出码 = ${expect.exitCode}`,
    ok: outcome.exitCode === expect.exitCode,
    ...(outcome.exitCode === expect.exitCode ? {} : { detail: `实测 ${outcome.exitCode}` }),
  });
  for (const needle of expect.includes ?? []) {
    checks.push({
      name: `${label}输出含「${needle}」`,
      ok: out.includes(needle),
      ...(out.includes(needle) ? {} : { detail: "未出现" }),
    });
  }
  for (const needle of expect.excludes ?? []) {
    checks.push({
      name: `${label}输出不含「${needle}」`,
      ok: !out.includes(needle),
      ...(out.includes(needle) ? { detail: "出现了" } : {}),
    });
  }
  return checks;
}

async function evaluate(
  scenario: Scenario,
  workdir: string,
  mock: MockProviderHandle,
  outcome: ProcessOutcome,
  secondOutcome?: ProcessOutcome,
): Promise<Check[]> {
  const checks: Check[] = [];
  const out = stripAnsi(`${outcome.stdout}\n${outcome.stderr}`);
  const expect = scenario.expect;

  checks.push(...processChecks("", outcome, expect));
  if (scenario.secondRun) {
    checks.push({
      name: "第二个进程跑了",
      ok: secondOutcome !== undefined,
      ...(secondOutcome ? {} : { detail: "没有第二次执行" }),
    });
    if (secondOutcome) checks.push(...processChecks("第二跑：", secondOutcome, scenario.secondRun.expect));
  }
  for (const { needle, atLeast } of expect.occurrences ?? []) {
    const n = countOccurrences(out, needle);
    checks.push({
      name: `「${needle}」至少出现 ${atLeast} 次`,
      ok: n >= atLeast,
      ...(n >= atLeast ? {} : { detail: `实测 ${n} 次` }),
    });
  }

  for (const [rel, content] of Object.entries(expect.files ?? {})) {
    const actual = await readIfExists(path.join(workdir, rel));
    const ok = actual === content;
    checks.push({
      name: `产物 ${rel} 内容逐字节相符`,
      ok,
      ...(ok ? {} : { detail: actual === null ? "文件不存在" : `实测 ${JSON.stringify(actual)}` }),
    });
  }
  for (const [rel, needles] of Object.entries(expect.filesContain ?? {})) {
    const actual = await readIfExists(path.join(workdir, rel));
    for (const needle of needles) {
      const ok = actual !== null && actual.includes(needle);
      checks.push({
        name: `产物 ${rel} 含「${needle}」`,
        ok,
        ...(ok ? {} : { detail: actual === null ? "文件不存在" : `实测 ${JSON.stringify(actual.slice(0, 300))}` }),
      });
    }
  }
  for (const rel of expect.absentFiles ?? []) {
    const actual = await readIfExists(path.resolve(workdir, rel));
    checks.push({
      name: `${rel} 不存在（圈禁生效）`,
      ok: actual === null,
      ...(actual === null ? {} : { detail: "文件被写出来了" }),
    });
  }

  if (expect.ledger) {
    const entry = await lastLedgerEntry(workdir);
    checks.push({
      name: "台账写下了本次运行",
      ok: entry !== null,
      ...(entry ? {} : { detail: "ledger.jsonl 无可解析行" }),
    });
    if (entry) {
      const e = expect.ledger;
      const scalar: [string, unknown, unknown][] = [];
      if (e.stopReason !== undefined) scalar.push(["stopReason", e.stopReason, entry.stopReason]);
      if (e.reworks !== undefined) scalar.push(["reworks", e.reworks, entry.reworks]);
      if (e.finalPassed !== undefined) scalar.push(["finalPassed", e.finalPassed, entry.finalPassed]);
      if (e.mode !== undefined) scalar.push(["mode", e.mode, entry.mode]);
      if (e.verify !== undefined) scalar.push(["verify", e.verify, entry.verify]);
      const ctx = (entry.context ?? {}) as { windowSource?: unknown; window?: unknown };
      if (e.contextWindowSource !== undefined) scalar.push(["context.windowSource", e.contextWindowSource, ctx.windowSource]);
      if (e.contextWindow !== undefined) scalar.push(["context.window", e.contextWindow, ctx.window]);
      for (const [field, want, got] of scalar) {
        checks.push({
          name: `台账 ${field} = ${JSON.stringify(want)}`,
          ok: got === want,
          ...(got === want ? {} : { detail: `实测 ${JSON.stringify(got)}` }),
        });
      }
      if (e.verificationRecoveries) {
        const got = Array.isArray(entry.verifications)
          ? (entry.verifications as { recovery?: unknown }[]).map((v) => v.recovery ?? null)
          : [];
        const ok = JSON.stringify(got) === JSON.stringify(e.verificationRecoveries);
        checks.push({
          name: `台账逐轮裁决获得路径 = ${JSON.stringify(e.verificationRecoveries)}`,
          ok,
          ...(ok ? {} : { detail: `实测 ${JSON.stringify(got)}` }),
        });
      }
    }
  }

  const requests = mock.requestLog.length;
  checks.push({
    name: `模型请求 ${expect.requestCount} 次（脚本恰好用尽）`,
    ok: requests === expect.requestCount && mock.remainingScripts() === 0,
    ...(requests === expect.requestCount && mock.remainingScripts() === 0
      ? {}
      : { detail: `实测请求 ${requests} 次，剩余脚本 ${mock.remainingScripts()} 条` }),
  });

  return checks;
}

// ---------------------------------------------------------------- 报告

interface ScenarioReport {
  id: string;
  title: string;
  guards: string;
  passed: boolean;
  durationMs: number;
  exitCode: number | null;
  requests: number;
  scriptsLeft: number;
  checks: Check[];
  /** 失败时才留输出尾巴——绿的时候没人看，还会把报告撑成日志 */
  outputTail?: string;
}

function markdownReport(reports: ScenarioReport[], generatedAt: string): string {
  const passed = reports.filter((r) => r.passed).length;
  const lines: string[] = [
    "# EVAL-03a 确定性场景门",
    "",
    `生成时间：${generatedAt}`,
    "",
    `被测对象：\`${path.relative(REPO_ROOT, CLI_ENTRY).replace(/\\/g, "/")}\`（编译产物）`,
    `端点：\`eval/mock-provider.ts\` loopback 假端点（脚本队列 + 故障注入）`,
    "",
    `**${passed}/${reports.length} 通过**`,
    "",
    "| 结果 | 场景 | 断言 | 请求 | 耗时 |",
    "|---|---|---:|---:|---:|",
  ];
  for (const r of reports) {
    const failed = r.checks.filter((c) => !c.ok).length;
    lines.push(
      `| ${r.passed ? "✅" : "❌"} | \`${r.id}\` ${r.title} | ${r.checks.length - failed}/${r.checks.length} | ${r.requests} | ${(r.durationMs / 1000).toFixed(1)}s |`,
    );
  }
  lines.push("", "## 每个场景在守什么", "");
  for (const r of reports) {
    lines.push(`- **\`${r.id}\`** — ${r.guards}`);
  }
  const broken = reports.filter((r) => !r.passed);
  if (broken.length > 0) {
    lines.push("", "## 失败明细", "");
    for (const r of broken) {
      lines.push(`### \`${r.id}\``, "");
      for (const c of r.checks.filter((x) => !x.ok)) {
        lines.push(`- ❌ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
      }
      if (r.outputTail) {
        lines.push("", "```", r.outputTail, "```", "");
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------- 主流程

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const keep = argv.includes("--keep");
  const filterAt = argv.indexOf("--filter");
  const filter = filterAt >= 0 ? argv[filterAt + 1] : undefined;

  if ((await readIfExists(CLI_ENTRY)) === null) {
    console.error(
      `找不到编译产物 ${CLI_ENTRY}。确定性门测的是 dist/，先跑 \`npm run build\`。`,
    );
    process.exit(1);
  }

  const selected = filter ? scenarios.filter((s) => s.id.includes(filter)) : scenarios;
  if (selected.length === 0) {
    console.error(`--filter "${filter}" 没有匹配到任何场景。`);
    process.exit(1);
  }

  const reports: ScenarioReport[] = [];
  for (const scenario of selected) {
    /**
     * 工作目录再套一层：`escapeRoot/work`。这样"越出工作目录的写入落在哪"这条
     * 断言指向的是本次运行**独占**的父目录，而不是共享的 /tmp——否则别的进程
     * 在 /tmp 留下同名文件就能把圈禁断言变红（假失败比假绿难查）。
     */
    const escapeRoot = await mkdtemp(path.join(os.tmpdir(), `agent-det-${scenario.id}-`));
    const workdir = path.join(escapeRoot, "work");
    await mkdir(workdir, { recursive: true });
    for (const [rel, content] of Object.entries(scenario.seed ?? {})) {
      const abs = path.join(workdir, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    }
    const mock = await startMockProvider({ scripts: scenario.scripts });
    let outcome: ProcessOutcome;
    let secondOutcome: ProcessOutcome | undefined;
    try {
      outcome = await runCli(scenario, workdir, mock);
      if (scenario.secondRun) {
        // 第二个进程：脚本追加进同一个队列，工作目录不动——要钉的正是"落盘的东西被下一次启动读回"
        for (const script of scenario.secondRun.scripts) mock.pushScript(script);
        secondOutcome = await runCli(scenario.secondRun, workdir, mock);
      }
    } finally {
      // 先关端点再判定：判定要读 requestLog，但服务不能留着不关
      await mock.close();
    }
    const checks = await evaluate(scenario, workdir, mock, outcome, secondOutcome);
    const passed = checks.every((c) => c.ok);
    const tail = stripAnsi(
      `${outcome.stdout}\n${outcome.stderr}` +
        (secondOutcome ? `\n--- second run ---\n${secondOutcome.stdout}\n${secondOutcome.stderr}` : ""),
    ).trimEnd().split("\n").slice(-40).join("\n");
    reports.push({
      id: scenario.id,
      title: scenario.title,
      guards: scenario.guards,
      passed,
      durationMs: outcome.durationMs,
      exitCode: outcome.exitCode,
      requests: mock.requestLog.length,
      scriptsLeft: mock.remainingScripts(),
      checks,
      ...(passed ? {} : { outputTail: tail }),
    });
    const mark = passed ? "PASS" : "FAIL";
    console.log(
      `${mark}  ${scenario.id}  ${(outcome.durationMs / 1000).toFixed(1)}s  ` +
        `${checks.filter((c) => c.ok).length}/${checks.length} 断言`,
    );
    if (!passed) {
      for (const c of checks.filter((x) => !x.ok)) {
        console.log(`      ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
      }
    }
    if (keep) console.log(`      workdir: ${workdir}`);
    else await rm(escapeRoot, { recursive: true, force: true }).catch(() => {});
  }

  const generatedAt = new Date().toISOString();
  const summary = {
    total: reports.length,
    passed: reports.filter((r) => r.passed).length,
    failed: reports.filter((r) => !r.passed).length,
  };
  await writeFile(
    REPORT_JSON,
    `${JSON.stringify(
      {
        generatedAt,
        cliEntry: path.relative(REPO_ROOT, CLI_ENTRY).replace(/\\/g, "/"),
        node: process.version,
        platform: process.platform,
        ...(filter ? { filter } : {}),
        summary,
        scenarios: reports,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(REPORT_MD, markdownReport(reports, generatedAt), "utf8");

  console.log(
    `\n${summary.passed}/${summary.total} 场景通过 — 报告：` +
      `${path.relative(REPO_ROOT, REPORT_MD).replace(/\\/g, "/")}`,
  );
  if (summary.failed > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});

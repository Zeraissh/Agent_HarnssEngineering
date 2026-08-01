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
import { AgentLoop } from "./loop.js";
import type { AgentConfig, AggregateUsage, ModelClient, TurnEvent } from "./types.js";

export interface Verdict {
  passed: boolean;
  issues: string[];
  summary: string;
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
}

export interface VerifyOutcome {
  verdict: Verdict;
  usage: AggregateUsage;
  /** verifier 的原始最终输出（供审计） */
  raw: string;
}

export async function runVerifier(
  cfg: AgentConfig,
  model: ModelClient,
  opts: VerifyOptions,
  /** 过程事件透传：让宿主看到 verifier 自己的工具调用/复核过程（可见性） */
  onEvent?: (event: TurnEvent) => void | Promise<void>,
): Promise<VerifyOutcome> {
  // 与父级同 system/tools（缓存前缀一致）。轮次预算与执行者解耦——REPS=5 复现批
  // 教训：执行者被压到 maxTurns=8 时 verifier 若跟着缩水，核查跑不完，最终消息是
  // 半截引言 → fail-closed 噪声淹没实验信号。核查预算固定 15，不随执行者收紧。
  const VERIFIER_MAX_TURNS = 15;
  const first = await drainVerifierLoop(
    new AgentLoop({ ...cfg, maxTurns: VERIFIER_MAX_TURNS }, model),
    buildVerifierPrompt(opts),
    onEvent,
    opts.readOnlyCommands,
  );

  let verdict = parseVerdict(first.text);
  let raw = first.text;
  let usage = first.usage;

  // 裁决重问（一次）：核查做了但最终消息不是纯 JSON 时，让模型把已有结论转写成 JSON。
  // fail-closed 直接返工会对正确产物空转（A/B 实测烧 10 万级 token），一次重问便宜得多。
  // 空输出没有可转写的结论，不重问（转写会变成无依据的编造），维持 fail-closed。
  if (isParseFailure(verdict) && first.text.trim() !== "") {
    const retry = await drainVerifierLoop(
      new AgentLoop({ ...cfg, maxTurns: 3 }, model),
      buildReformatPrompt(first.text),
      onEvent,
    );
    usage = sumUsage(usage, retry.usage);
    const second = parseVerdict(retry.text);
    if (!isParseFailure(second)) {
      verdict = second;
      raw = retry.text;
    }
  }

  return { verdict, usage, raw };
}

function isParseFailure(v: Verdict): boolean {
  return !v.passed && v.issues[0] === VERDICT_PARSE_FAIL;
}

async function drainVerifierLoop(
  loop: AgentLoop,
  prompt: string,
  onEvent?: (event: TurnEvent) => void | Promise<void>,
  readOnlyCommands?: string[],
): Promise<{ text: string; usage: AggregateUsage }> {
  let finalText = "";
  let usage: AggregateUsage | undefined;

  for await (const event of loop.run(prompt)) {
    await onEvent?.(event);
    switch (event.type) {
      case "assistant_text":
        finalText = event.text; // 只留最后一条：契约要求最终消息为纯 JSON
        break;
      case "approval_request": {
        // 硬约束：verifier 只读。唯一例外：bash 命令命中领域包声明的只读白名单
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
      case "done":
        usage = event.result.usage;
        break;
      default:
        break;
    }
  }

  return { text: finalText, usage: usage! };
}

/** 管道下游允许的通用只读过滤器 */
const READ_FILTERS = new Set([
  "grep", "wc", "sort", "head", "tail", "uniq", "cat", "od", "xxd",
  "awk", "cut", "tr", "diff", "cmp", "strings", "ls", "find",
]);

/**
 * 只读命令判定：首段必须命中白名单前缀（词边界），全命令禁止重定向、
 * 链式执行与命令替换；管道后续段允许白名单或通用只读过滤器。
 * 这是纪律护栏而非安全沙箱——目标是把 verifier 的"独立重推导"能力
 * 限定在核查动作上，不是抵御恶意。
 */
export function isReadOnlyCommand(command: string, allowedPrefixes: string[]): boolean {
  const cmd = command.trim();
  if (cmd === "" || allowedPrefixes.length === 0) return false;
  if (/>|;|&&|\|\||`|\$\(/.test(cmd)) return false; // 重定向/链式/子命令替换

  const matchesPrefix = (segment: string): boolean =>
    allowedPrefixes.some((p) => {
      const prefix = p.trim();
      if (!segment.startsWith(prefix)) return false;
      const next = segment[prefix.length];
      return next === undefined || next === " "; // 词边界：防 "nm" 放行 "nmap"
    });

  return cmd.split("|").map((s) => s.trim()).every((segment, i) => {
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
{"passed": true/false, "issues": ["发现的问题，每条一个字符串；通过则为空数组"], "summary": "一句话结论"}`;
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
1. 只读核查：用只读手段检查实际状态；不要修改、创建或删除任何东西（除了最终结论）。
2. 逐条核对任务要求与实际产出：有没有偷工减料或与报告不符之处。
3. 数值类声明（地址、寄存器值、行号、统计结果）必须独立重新获取，不能照抄报告。
${opts.readOnlyCommands?.length ? `\n你的 bash 只放行以下核查命令（前缀匹配，禁止重定向/链式）：${opts.readOnlyCommands.join("、")}。用它们独立重新推导（如亲自重新构建、查符号），不要只依赖间接证据。\n` : ""}${opts.verifyInstructions ? `\n领域核查方法：\n${opts.verifyInstructions}\n` : ""}
你的最后一条消息必须只包含一个 JSON 对象（不要代码围栏、不要多余文字）：
{"passed": true/false, "issues": ["发现的问题，每条一个字符串；通过则为空数组"], "summary": "一句话结论"}`;
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
        return {
          passed: parsed.passed,
          issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
          summary: typeof parsed.summary === "string" ? parsed.summary : "",
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

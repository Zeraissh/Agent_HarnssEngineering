// @ts-nocheck
/**
 * 四决定因素派生层的回归锁（v2 R4 / V-17）。
 *
 * 组织原则来自 docs/01-philosophy.md:5-12——模型能力固定时，agent 表现的差异
 * 全部落在 Loop / Tools / Context / Verification 四处。这些函数把 RunState 折成
 * 那四个面，是新首屏的唯一数据源，全部为纯函数，可在 node 环境直测。
 */
import { describe, it, expect } from "vitest";
import {
  createInitialState,
  reduceEvents,
  deriveSegments,
  deriveLoopFace,
  deriveContextFace,
  deriveToolsFace,
  deriveVerificationFace,
  deriveActionState,
  deriveLogEntries,
  buildFactorCards,
  normalizeTab,
  filterRunsByQuery,
  VERDICT_PARSE_FAIL,
} from "../ui/public/app.js";

const HARNESS = {
  effort: "high",
  effortApplies: true,
  shell: "Git Bash",
  workdir: "D:\\repo",
  readRoots: ["D:\\refs"],
  guardrails: { maxTurns: 40, maxTokens: 64000, contextTokenLimit: 1000 },
  compactWatermark: 0.8,
  verifierBudgetTurns: 15,
  pack: {
    name: "python-coding",
    description: "Python 域",
    resources: [],
    verify: { mode: "programmatic", readOnlyCommands: ["python -m pytest"], rubricSource: null },
  },
  tools: [
    { name: "bash", permission: "ask", origin: "builtin" },
    { name: "read_file", permission: "auto", origin: "builtin" },
    { name: "write_file", permission: "ask", origin: "builtin" },
  ],
  mcp: { configured: false, servers: [] },
};

let seq = 0;
const ev = (source: string, event: Record<string, unknown>) => ({ seq: seq++, source, event });

function feed(events: any[], task = "任务", verify = true) {
  seq = 0;
  let s = createInitialState("run-1", task, verify);
  return reduceEvents(s, events);
}

// ================================================================
// deriveSegments —— 段切分
// ================================================================

describe("deriveSegments", () => {
  it("main → verifier → rework → verifier 切成四段，角色与轮次正确", () => {
    seq = 0;
    const s = feed([
      ev("main", { type: "turn_start", turn: 1 }),
      ev("main", { type: "assistant_text", text: "做完了" }),
      ev("verifier", { type: "turn_start", turn: 1 }),
      ev("rework", { type: "turn_start", turn: 1 }),
      ev("verifier", { type: "turn_start", turn: 1 }),
    ]);
    const segs = deriveSegments(s);
    expect(segs.map((x) => x.role)).toEqual(["main", "verifier", "rework", "verifier"]);
    expect(segs[2].round).toBe(1); // 第 1 轮返工
    expect(segs[0].entries).toHaveLength(2);
  });

  it("单段运行只有一段，且不产生虚假分界", () => {
    const s = feed([
      ev("main", { type: "turn_start", turn: 1 }),
      ev("main", { type: "turn_start", turn: 2 }),
    ]);
    expect(deriveSegments(s)).toHaveLength(1);
  });

  it("并行编排的前缀来源（s1/main）也能归类", () => {
    const s = feed([
      ev("s1/main", { type: "turn_start", turn: 1 }),
      ev("s1/verifier", { type: "turn_start", turn: 1 }),
    ]);
    expect(deriveSegments(s).map((x) => x.role)).toEqual(["main", "verifier"]);
  });
});

// ================================================================
// deriveLoopFace
// ================================================================

describe("deriveLoopFace", () => {
  it("轮次水位取执行侧最大 turn，核查轮不混入", () => {
    const s = feed([
      ev("main", { type: "turn_start", turn: 1 }),
      ev("main", { type: "turn_start", turn: 2 }),
      ev("verifier", { type: "turn_start", turn: 9 }),
    ]);
    const f = deriveLoopFace(s, HARNESS);
    expect(f.turn).toBe(2); // 不是 9——核查预算与执行者解耦
    expect(f.maxTurns).toBe(40);
    expect(f.ratio).toBeCloseTo(2 / 40);
    expect(f.nearLimit).toBe(false);
  });

  it("逼近轮次护栏时置 nearLimit", () => {
    const s = feed([ev("main", { type: "turn_start", turn: 33 })]);
    expect(deriveLoopFace(s, HARNESS).nearLimit).toBe(true);
  });

  it("返工裁决序列：F→P 的终点色可辨", () => {
    const s = feed([
      ev("main", { type: "turn_start", turn: 1 }),
      ev("verifier", { type: "turn_start", turn: 1 }),
      ev("verifier", { type: "verification", round: 0, verdict: { passed: false, issues: ["x"], unverified: [], advisory: [], summary: "" } }),
      ev("rework", { type: "turn_start", turn: 2 }),
      ev("verifier", { type: "turn_start", turn: 1 }),
      ev("verifier", { type: "verification", round: 1, verdict: { passed: true, issues: [], unverified: [], advisory: [], summary: "" } }),
    ]);
    const chain = deriveLoopFace(s, HARNESS).chain;
    expect(chain.map((c) => c.role)).toEqual(["main", "verifier", "rework", "verifier"]);
    expect(chain[1].passed).toBe(false);
    expect(chain[3].passed).toBe(true);
  });

  it("运行中不给 stopReason；结束后给六值分档", () => {
    const running = feed([ev("main", { type: "turn_start", turn: 1 })]);
    expect(deriveLoopFace(running, HARNESS).stopReason).toBeNull();

    const done = feed([
      ev("main", { type: "turn_start", turn: 1 }),
      ev("main", { type: "done", stopReason: "max_turns", usage: { turns: 1 } }),
      ev("host", { type: "run_end", outcome: "completed", mainStopReason: "max_turns", finishedAt: 1 }),
    ]);
    const f = deriveLoopFace(done, HARNESS);
    expect(f.stopReason.tone).toBe("bad");
    expect(f.stopReason.hint).toBeTruthy();
  });

  it("透出 effort 与 compat 下是否实际发送", () => {
    const s = feed([ev("main", { type: "turn_start", turn: 1 })]);
    expect(deriveLoopFace(s, HARNESS).effort).toBe("high");
    expect(deriveLoopFace(s, { ...HARNESS, effortApplies: false }).effortApplies).toBe(false);
  });

  it("无宿主快照时降级：maxTurns 为 null，不编造水位", () => {
    const s = feed([ev("main", { type: "turn_start", turn: 3 })]);
    const f = deriveLoopFace(s, null);
    expect(f.maxTurns).toBeNull();
    expect(f.ratio).toBeNull();
    expect(f.nearLimit).toBe(false);
  });
});

// ================================================================
// deriveContextFace
// ================================================================

describe("deriveContextFace", () => {
  const withUsage = () =>
    feed([
      ev("main", { type: "usage", turn: 1, usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 50, cache_read_input_tokens: 200 } }),
      ev("main", { type: "usage", turn: 2, usage: { input_tokens: 120, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 600 } }),
    ]);

  it("水位分子是最近一轮输入，不是全程累计", () => {
    const f = deriveContextFace(withUsage(), HARNESS);
    // 第二轮 120+0+600 = 720，而累计是 350+720=1070——按累计会得到 >100% 的假警报
    expect(f.lastInputTokens).toBe(720);
    expect(f.ratio).toBeCloseTo(0.72);
    expect(f.nearWatermark).toBe(false);
  });

  it("越过压缩水位时置 nearWatermark", () => {
    const s = feed([
      ev("main", { type: "usage", turn: 1, usage: { input_tokens: 900, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
    ]);
    expect(deriveContextFace(s, HARNESS).nearWatermark).toBe(true);
  });

  it("压缩事件汇总为不可逆语域的数据", () => {
    const s = feed([
      ev("main", { type: "compaction", droppedBlocks: 4 }),
      ev("main", { type: "compaction", droppedBlocks: 3 }),
    ]);
    const f = deriveContextFace(s, HARNESS);
    expect(f.compactions).toHaveLength(2);
    expect(f.droppedBlocks).toBe(7);
  });

  it("无上限配置时不编造水位", () => {
    const f = deriveContextFace(withUsage(), { ...HARNESS, guardrails: {} });
    expect(f.limit).toBeNull();
    expect(f.ratio).toBeNull();
  });
});

// ================================================================
// deriveToolsFace
// ================================================================

describe("deriveToolsFace", () => {
  const s = () =>
    feed([
      ev("main", { type: "tool_call", toolUseId: "t1", name: "bash", input: { command: "ls" } }),
      ev("main", { type: "tool_result", toolUseId: "t1", result: { content: "boom", isError: true }, durationMs: 5 }),
      ev("main", { type: "tool_call", toolUseId: "t2", name: "read_file", input: { path: "a" } }),
      ev("main", { type: "tool_result", toolUseId: "t2", result: { content: "ok" }, durationMs: 2 }),
    ]);

  it("按 toolUseId 回填工具名统计失败次数", () => {
    const f = deriveToolsFace(s(), HARNESS);
    const bash = f.tools.find((t) => t.name === "bash");
    expect(bash.calls).toBe(1);
    expect(bash.errors).toBe(1); // tool_result 不带 name，靠 toolNames 回填才数得到
    expect(f.totalErrors).toBe(1);
  });

  it("识别失败后的改道——P5「错误进上下文不炸循环」的证据", () => {
    const f = deriveToolsFace(s(), HARNESS);
    expect(f.reroutes).toHaveLength(1);
    expect(f.reroutes[0].failedTool).toBe("bash");
    expect(f.reroutes[0].nextTool).toBe("read_file");
    expect(f.reroutes[0].switched).toBe(true);
  });

  it("同一工具重试不算改道", () => {
    const st = feed([
      ev("main", { type: "tool_call", toolUseId: "t1", name: "bash", input: {} }),
      ev("main", { type: "tool_result", toolUseId: "t1", result: { content: "x", isError: true }, durationMs: 1 }),
      ev("main", { type: "tool_call", toolUseId: "t2", name: "bash", input: {} }),
    ]);
    expect(deriveToolsFace(st, HARNESS).reroutes[0].switched).toBe(false);
  });

  it("透出边界：只读根 / 白名单 / shell / 护栏", () => {
    const f = deriveToolsFace(s(), HARNESS);
    expect(f.readRoots).toEqual(["D:\\refs"]);
    expect(f.pack.verify.readOnlyCommands).toEqual(["python -m pytest"]);
    expect(f.shell).toBe("Git Bash");
    expect(f.guardrails.maxTurns).toBe(40);
  });

  it("宿主快照缺席时照实降级，不编造工具面", () => {
    const f = deriveToolsFace(s(), null);
    expect(f.pack).toBeNull();
    // 但实际调用过的工具仍如实列出
    expect(f.tools.map((t) => t.name).sort()).toEqual(["bash", "read_file"]);
    expect(f.tools.every((t) => t.origin === "unknown")).toBe(true);
  });
});

// ================================================================
// deriveVerificationFace
// ================================================================

describe("deriveVerificationFace", () => {
  const verdictEvent = (v: any) => ev("verifier", { type: "verdict", verdict: v });

  it("四态徽章：pass / pass_with_notes / fail / pending", () => {
    const mk = (v: any) => deriveVerificationFace(feed(v ? [verdictEvent(v)] : []), HARNESS).badge;
    expect(mk(null)).toBe("pending");
    expect(mk({ passed: true, issues: [], unverified: [], advisory: [], summary: "" })).toBe("pass");
    expect(mk({ passed: true, issues: ["规格不严谨"], unverified: [], advisory: [], summary: "" }))
      .toBe("pass_with_notes");
    expect(mk({ passed: false, issues: ["错了"], unverified: [], advisory: [], summary: "" })).toBe("fail");
  });

  it("白名单饥饿：判据看 verifier 时间线的审批门，不看 pendingApprovals", () => {
    // verifier 的审批由 harness 内部自答，压根不进 pendingApprovals
    const s = feed([ev("verifier", { type: "approval_request", toolUseId: "v1", name: "bash", input: {} })]);
    const noWl = { ...HARNESS, pack: { ...HARNESS.pack, verify: { ...HARNESS.pack.verify, readOnlyCommands: [] } } };
    expect(deriveVerificationFace(s, noWl).starvation.noWhitelist).toBe(true);
    // 有白名单则不算饥饿
    expect(deriveVerificationFace(s, HARNESS).starvation.noWhitelist).toBe(false);
  });

  it("空返工：被否后的返工段零写入 → 疑似核查饥饿", () => {
    const s = feed([
      ev("main", { type: "turn_start", turn: 1 }),
      ev("verifier", { type: "turn_start", turn: 1 }),
      ev("rework", { type: "turn_start", turn: 2 }),
      ev("rework", { type: "tool_call", toolUseId: "r1", name: "read_file", input: {} }),
    ]);
    expect(deriveVerificationFace(s, HARNESS).starvation.emptyRework).toEqual([1]);
  });

  it("返工里有写入就不算饥饿", () => {
    const s = feed([
      ev("main", { type: "turn_start", turn: 1 }),
      ev("verifier", { type: "turn_start", turn: 1 }),
      ev("rework", { type: "tool_call", toolUseId: "r1", name: "write_file", input: {} }),
    ]);
    expect(deriveVerificationFace(s, HARNESS).starvation.emptyRework).toEqual([]);
  });

  it("裁决解析失败被识别为 fail-closed 误伤而非真的不过", () => {
    const s = feed([
      verdictEvent({ passed: false, issues: [VERDICT_PARSE_FAIL], unverified: [], advisory: [], summary: "" }),
    ]);
    expect(deriveVerificationFace(s, HARNESS).starvation.parseFail).toBe(true);
  });
});

// ================================================================
// deriveActionState / buildFactorCards / normalizeTab
// ================================================================

describe("deriveActionState", () => {
  it("unverified 只出一份，pending 审批与它一起决定是否需要人介入", () => {
    const s = feed([
      ev("main", { type: "approval_request", toolUseId: "t1", name: "write_file", input: {} }),
      ev("verifier", { type: "verdict", verdict: { passed: true, issues: [], unverified: ["需 od 复核"], advisory: [], summary: "" } }),
    ]);
    const a = deriveActionState(s);
    expect(a.pendingApprovals).toHaveLength(1);
    expect(a.unverifiedItems).toEqual(["需 od 复核"]);
    expect(a.needsAttention).toBe(true);
  });

  it("无待办时 needsAttention 为假", () => {
    expect(deriveActionState(feed([])).needsAttention).toBe(false);
  });
});

describe("buildFactorCards", () => {
  const facesFor = (s: any, h = HARNESS) => ({
    loop: deriveLoopFace(s, h),
    context: deriveContextFace(s, h),
    tools: deriveToolsFace(s, h),
    verification: deriveVerificationFace(s, h),
    action: deriveActionState(s),
  });

  it("四张卡恒在，正常态下顺序为 Loop/Context/Tools/Verification", () => {
    const cards = buildFactorCards(facesFor(feed([ev("main", { type: "turn_start", turn: 1 })])));
    expect(cards.map((c) => c.id)).toEqual(["loop", "context", "tools", "verify"]);
    expect(cards.every((c) => !c.abnormal)).toBe(true);
  });

  it("异常面排到首位——用户第一眼该看到哪一面出了问题", () => {
    const s = feed([
      ev("main", { type: "turn_start", turn: 1 }),
      ev("verifier", { type: "verdict", verdict: { passed: false, issues: ["不符"], unverified: [], advisory: [], summary: "" } }),
    ]);
    const cards = buildFactorCards(facesFor(s));
    expect(cards[0].id).toBe("verify");
    expect(cards[0].abnormal).toBe(true);
  });

  it("通过但有备注同样算异常——不能被绿色吞掉", () => {
    const s = feed([
      ev("verifier", { type: "verdict", verdict: { passed: true, issues: ["boot_count 规格不严谨"], unverified: [], advisory: [], summary: "" } }),
    ]);
    const cards = buildFactorCards(facesFor(s));
    expect(cards[0].id).toBe("verify");
    expect(cards[0].lines[0]).toContain("通过（有备注）");
  });

  it("压缩发生过 → Context 卡异常且写明不可恢复", () => {
    const s = feed([ev("main", { type: "compaction", droppedBlocks: 5 })]);
    const ctx = buildFactorCards(facesFor(s)).find((c) => c.id === "context");
    expect(ctx.abnormal).toBe(true);
    expect(ctx.lines.some((l: string) => l.includes("不可恢复"))).toBe(true);
  });
});

describe("normalizeTab", () => {
  it("旧标签 id 与非法值一律归到 loop", () => {
    for (const legacy of ["overview", "log", undefined, null, "", "bogus"]) {
      expect(normalizeTab(legacy)).toBe("loop");
    }
  });

  it("四个面按原样保留", () => {
    for (const t of ["loop", "context", "tools", "verify"]) {
      expect(normalizeTab(t)).toBe(t);
    }
  });
});

describe("deriveLogEntries 的工具名回填 (V-12)", () => {
  it("tool_result 显示工具名而不是 toolUseId", () => {
    const s = feed([
      ev("main", { type: "tool_call", toolUseId: "toolu_01AbC", name: "read_file", input: {} }),
      ev("main", { type: "tool_result", toolUseId: "toolu_01AbC", result: { content: "ok" }, durationMs: 3 }),
    ]);
    const result = deriveLogEntries(s).find((e) => e.type === "tool_result");
    expect(result.name).toBe("read_file");
  });

  it("回填不到时保留原样，不伪造名字", () => {
    const s = feed([
      ev("main", { type: "tool_result", toolUseId: "orphan", result: { content: "ok" }, durationMs: 1 }),
    ]);
    const result = deriveLogEntries(s).find((e) => e.type === "tool_result");
    expect(result.name).toBeUndefined();
  });
});

describe("filterRunsByQuery（侧栏搜索）", () => {
  const runs = [
    { runId: "a", task: "整理参考文档" },
    { runId: "b", task: "修复 SSE 重连缺陷" },
    { runId: "c", task: "Fix SSE reconnect" },
  ];

  it("空查询原样返回，不做任何过滤", () => {
    expect(filterRunsByQuery(runs, "")).toBe(runs);
    expect(filterRunsByQuery(runs, "   ")).toBe(runs);
    expect(filterRunsByQuery(runs, undefined)).toBe(runs);
  });

  it("按任务描述子串匹配", () => {
    expect(filterRunsByQuery(runs, "文档").map((r) => r.runId)).toEqual(["a"]);
    expect(filterRunsByQuery(runs, "SSE").map((r) => r.runId)).toEqual(["b", "c"]);
  });

  it("大小写无关、首尾空白无关", () => {
    expect(filterRunsByQuery(runs, "  sse  ").map((r) => r.runId)).toEqual(["b", "c"]);
    expect(filterRunsByQuery(runs, "RECONNECT").map((r) => r.runId)).toEqual(["c"]);
  });

  it("无匹配时返回空列表而不是全部", () => {
    expect(filterRunsByQuery(runs, "不存在的词")).toEqual([]);
  });
});

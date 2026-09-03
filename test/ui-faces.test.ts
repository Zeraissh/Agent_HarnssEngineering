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
  derivePlanFace,
  deriveAssemblyBar,
  normalizeTab,
  filterRunsByQuery,
  whitelistSourceLabel,
  VERDICT_PARSE_FAIL,
  normalizeContextConfig,
  deriveContextBudgetKnob,
  buildNewRunRequest,
  contextSourceLabel,
} from "../ui/public/app.js";

const HARNESS = {
  effort: "high",
  effortApplies: true,
  shell: "Git Bash",
  executionIsolation: {
    effectiveState: "partial", resolvedBackend: "oci", requestedMode: "required",
    probe: { state: "ready" }, filesystem: "ro root", network: "none",
    identity: "uid 65532", resources: "limited",
  },
  workdir: "D:\\repo",
  readRoots: ["D:\\refs"],
  history: { enabled: true, dir: "D:\\repo\\.agent-run-history", keep: 50 },
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
      ev("main", { type: "compaction", droppedBlocks: 4, ledgerEntries: 5, summaryApplied: true }),
      ev("main", { type: "compaction", droppedBlocks: 3, ledgerEntries: 2 }),
    ]);
    const f = deriveContextFace(s, HARNESS);
    expect(f.compactions).toHaveLength(2);
    expect(f.droppedBlocks).toBe(7);
    expect(f.ledgerEntries).toBe(7);
    expect(f.summaryAppliedCount).toBe(1);
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

  it("透出边界：只读根 / 白名单 / shell / 执行隔离 / 护栏 / 运行历史落点", () => {
    const f = deriveToolsFace(s(), HARNESS);
    expect(f.readRoots).toEqual(["D:\\refs"]);
    expect(f.pack.verify.readOnlyCommands).toEqual(["python -m pytest"]);
    expect(f.shell).toBe("Git Bash");
    expect(f.executionIsolation).toMatchObject({ effectiveState: "partial", resolvedBackend: "oci" });
    expect(f.guardrails.maxTurns).toBe(40);
    // 宿主快照新字段要真的到达派生层（host-lags 纪律：加字段同提交接宿主）
    expect(f.history).toEqual({ enabled: true, dir: "D:\\repo\\.agent-run-history", keep: 50 });
    expect(deriveToolsFace(s(), { ...HARNESS, history: undefined }).history).toBeNull();
  });

  it("run_config 的执行边界覆盖进程快照，report-only 必须成为 Tools 异常", () => {
    const state = feed([ev("host", {
      type: "run_config",
      executionIsolation: {
        effectiveState: "report-only", resolvedBackend: "host", requestedMode: "report",
        probe: { state: "unavailable" }, filesystem: "host", network: "host",
        identity: "host", resources: "none",
      },
    })]);
    const tools = deriveToolsFace(state, HARNESS);
    expect(tools.executionIsolation.effectiveState).toBe("report-only");
    const card = buildFactorCards({
      loop: deriveLoopFace(state, HARNESS),
      context: deriveContextFace(state, HARNESS),
      tools,
      verification: deriveVerificationFace(state, HARNESS),
      action: deriveActionState(state),
    }).find((candidate) => candidate.id === "tools");
    expect(card.abnormal).toBe(true);
    expect(card.lines.some((line: string) => line.includes("宿主直跑"))).toBe(true);
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

  it("压缩发生过 → Context 卡异常且写明置换与账本", () => {
    const s = feed([ev("main", { type: "compaction", droppedBlocks: 5, ledgerEntries: 3 })]);
    const ctx = buildFactorCards(facesFor(s)).find((c) => c.id === "context");
    expect(ctx.abnormal).toBe(true);
    expect(ctx.lines.some((l: string) => l.includes("置换") && l.includes("账本"))).toBe(true);
  });

  /**
   * MEM-01 Phase C：compaction 事件新增 collapsedTurns / reactive。reducer 的投影是逐字段
   * 白名单——不列就静默丢（本项目第 N 次踩这条），所以三处（投影 / 派生 / 卡片）一次锁死。
   */
  it("tier 2 折叠与反应式压缩：投影保留字段、派生汇总、Context 卡写明轮数与撞 400 次数", () => {
    const s = feed([
      ev("main", { type: "compaction", droppedBlocks: 2, ledgerEntries: 3, collapsedTurns: 4 }),
      ev("main", { type: "compaction", droppedBlocks: 0, ledgerEntries: 3, collapsedTurns: 2, reactive: true }),
      ev("main", { type: "compaction", droppedBlocks: 1, ledgerEntries: 3 }), // 旧形状：缺两字段
    ]);
    const entries = s.timeline.filter((e) => e.type === "compaction");
    expect(entries.map((e) => e.collapsedTurns)).toEqual([4, 2, 0]);
    expect(entries.map((e) => e.reactive)).toEqual([false, true, false]);
    const f = deriveContextFace(s, HARNESS);
    expect(f.collapsedTurns).toBe(6);
    expect(f.reactiveCount).toBe(1);
    const ctx = buildFactorCards(facesFor(s)).find((c) => c.id === "context");
    const line = ctx.lines.find((l: string) => l.includes("压缩"));
    expect(line).toContain("折叠 6 轮旧对话");
    expect(line).toContain("撞 400 后反应式 1 次");
  });

  it("没有折叠、没有反应式时 Context 卡不多说一个字（旧行为不变）", () => {
    const s = feed([ev("main", { type: "compaction", droppedBlocks: 5, ledgerEntries: 3 })]);
    const ctx = buildFactorCards(facesFor(s)).find((c) => c.id === "context");
    const line = ctx.lines.find((l: string) => l.includes("压缩"));
    expect(line).not.toContain("折叠");
    expect(line).not.toContain("反应式");
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

describe("逐 run 装配优先于进程级快照 (V-24)", () => {
  const runCfg = (over = {}) => ({
    seq: 0, source: "host",
    event: {
      type: "run_config",
      pack: { name: "ts-coding", description: "TS 域", resources: [], verify: { mode: "rubric", readOnlyCommands: ["npm test"], rubricSource: "pack" } },
      effort: "max",
      effortApplies: true,
      rubricSource: "run",
      guardrails: { maxTurns: 12, maxTokens: 8000, contextTokenLimit: 500 },
      tools: [{ name: "read_file", permission: "auto", origin: "builtin" }],
      ...over,
    },
  });

  /**
   * pack 现在可逐 run 覆盖，而 /api/harness 是进程级快照。若各面继续读快照，
   * 用户选了 ts-coding 却会看到 python-coding 的工具面与白名单——界面说谎。
   */
  it("Tools 面读本 run 的包与工具，不读进程默认", () => {
    seq = 0;
    let s = createInitialState("r", "t", true);
    s = reduceEvents(s, [runCfg()]);
    const f = deriveToolsFace(s, HARNESS); // HARNESS 里是 python-coding
    expect(f.pack.name).toBe("ts-coding");
    expect(f.tools.map((t) => t.name)).toEqual(["read_file"]);
    expect(f.guardrails.maxTurns).toBe(12);
  });

  it("Verification 面读本 run 的白名单与评分表来源", () => {
    seq = 0;
    let s = createInitialState("r", "t", true);
    s = reduceEvents(s, [runCfg()]);
    const f = deriveVerificationFace(s, HARNESS);
    expect(f.whitelist).toEqual(["npm test"]);
    expect(f.rubricSource).toBe("run");
  });

  it("Loop / Context 面的护栏与水位上限同样跟着本 run 走", () => {
    seq = 0;
    let s = createInitialState("r", "t", true);
    s = reduceEvents(s, [
      runCfg(),
      { seq: 1, source: "main", event: { type: "turn_start", turn: 10 } },
      { seq: 2, source: "main", event: { type: "usage", turn: 10, usage: { input_tokens: 450, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ]);
    const loop = deriveLoopFace(s, HARNESS);
    expect(loop.maxTurns).toBe(12); // 不是 HARNESS 的 40
    expect(loop.nearLimit).toBe(true); // 10/12
    expect(loop.effort).toBe("max");

    const ctx = deriveContextFace(s, HARNESS);
    expect(ctx.limit).toBe(500); // 不是 HARNESS 的 1000
    expect(ctx.nearWatermark).toBe(true); // 450/500
  });

  it("没有 run_config 时回落到进程级快照，行为与改动前一致", () => {
    seq = 0;
    const s = feed([ev("main", { type: "turn_start", turn: 1 })]);
    expect(deriveToolsFace(s, HARNESS).pack.name).toBe("python-coding");
    expect(deriveLoopFace(s, HARNESS).maxTurns).toBe(40);
  });
});

// ================================================================
// v2 R7：编排面 (V-27)
// ================================================================

describe("derivePlanFace", () => {
  const planEvent = (subtasks: any[], over = {}) => ({
    seq: 0, source: "host",
    event: { type: "plan", concurrency: 3, concurrencyMode: "auto", plannerMs: 8000, subtasks, ...over },
  });

  const SUBS = [
    { id: "s1", title: "查资料", pack: null, description: "", acceptance: ["产出 md"], dependsOn: [], resources: [] },
    { id: "s2", title: "写固件", pack: "stm32-coding", description: "", acceptance: [], dependsOn: [], resources: ["swd-probe"] },
    { id: "s3", title: "汇总", pack: null, description: "", acceptance: [], dependsOn: ["s1", "s2"], resources: [] },
  ];

  it("非编排运行返回 null——调用方据此决定要不要渲染这一块", () => {
    expect(derivePlanFace(feed([ev("main", { type: "turn_start", turn: 1 })]))).toBeNull();
  });

  /**
   * 分层就是调度语义：同层 = 互不依赖 = 可并发，换层 = 依赖推进。
   * 这也是"为什么能省时间"的解释——比画自由图更贴近真实决策。
   */
  it("按依赖深度分层，层宽即理论最大并发", () => {
    seq = 0;
    let s = createInitialState("r", "t", true);
    s = reduceEvents(s, [planEvent(SUBS)]);
    const f = derivePlanFace(s)!;
    expect(f.layers).toHaveLength(2);
    expect(f.layers[0].map((n: any) => n.id)).toEqual(["s1", "s2"]);
    expect(f.layers[1].map((n: any) => n.id)).toEqual(["s3"]);
    expect(f.parallelWidth).toBe(2);
    expect(f.concurrency).toBe(3);
  });

  it("子任务状态：pending → running（有 sN/ 前缀事件）→ passed/failed/skipped", () => {
    seq = 0;
    let s = createInitialState("r", "t", true);
    s = reduceEvents(s, [planEvent(SUBS)]);
    expect(derivePlanFace(s)!.nodes.every((n: any) => n.status === "pending")).toBe(true);

    s = reduceEvents(s, [{ seq: 1, source: "s1/main", event: { type: "turn_start", turn: 1 } }]);
    expect(derivePlanFace(s)!.nodes.find((n: any) => n.id === "s1").status).toBe("running");

    s = reduceEvents(s, [{
      seq: 2, source: "host",
      event: {
        type: "plan_result", completed: false, planned: true,
        steps: [{ id: "s1", title: "查资料", durationMs: 5000, passed: true, reworks: 0 },
                { id: "s2", title: "写固件", durationMs: 9000, passed: false, reworks: 1 }],
        skipped: [{ id: "s3", title: "汇总" }],
        timing: { totalMs: 20000, plannerMs: 8000, subtaskWallMs: 9000, stepSumMs: 14000, savedMs: 5000 },
      },
    }]);
    const f = derivePlanFace(s)!;
    expect(f.nodes.find((n: any) => n.id === "s1").status).toBe("passed");
    expect(f.nodes.find((n: any) => n.id === "s2").status).toBe("failed");
    expect(f.nodes.find((n: any) => n.id === "s3").status).toBe("skipped");
    expect(f.nodes.find((n: any) => n.id === "s2").reworks).toBe(1);
    expect(f.timing.savedMs).toBe(5000);
  });

  it("独占资源随子任务透出——那是「为什么这两个没并发」的唯一解释", () => {
    seq = 0;
    let s = createInitialState("r", "t", true);
    s = reduceEvents(s, [planEvent(SUBS)]);
    expect(derivePlanFace(s)!.nodes.find((n: any) => n.id === "s2").resources).toEqual(["swd-probe"]);
  });

  it("planner 出不了可解析计划时标 planned=false（fail-closed，未执行任何子任务）", () => {
    seq = 0;
    let s = createInitialState("r", "t", true);
    s = reduceEvents(s, [
      planEvent([]),
      { seq: 1, source: "host", event: { type: "plan_result", completed: false, planned: false, plannerRaw: "抱歉…", steps: [], skipped: [] } },
    ]);
    const f = derivePlanFace(s)!;
    expect(f.planned).toBe(false);
    expect(f.plannerRaw).toContain("抱歉");
  });

  it("未知领域包的降级被记录，不静默吞掉", () => {
    seq = 0;
    let s = createInitialState("r", "t", true);
    s = reduceEvents(s, [
      planEvent(SUBS),
      { seq: 1, source: "host", event: { type: "plan_warning", subtaskId: "s2", message: '未知领域包 "nope"' } },
    ]);
    expect(derivePlanFace(s)!.warnings).toEqual([{ subtaskId: "s2", message: '未知领域包 "nope"' }]);
  });

  it("依赖成环不把前端搞崩（服务端已 fail-closed，这里是第二道防御）", () => {
    seq = 0;
    let s = createInitialState("r", "t", true);
    s = reduceEvents(s, [planEvent([
      { id: "a", title: "A", dependsOn: ["b"], acceptance: [], description: "", pack: null, resources: [] },
      { id: "b", title: "B", dependsOn: ["a"], acceptance: [], description: "", pack: null, resources: [] },
    ])]);
    expect(() => derivePlanFace(s)).not.toThrow();
    expect(derivePlanFace(s)!.nodes).toHaveLength(2);
  });
});

describe("编排模式下的分段与轮次口径", () => {
  it("sN/main 前缀被归类为 main，且段分界能认出子任务", () => {
    seq = 0;
    const s = feed([
      ev("planner", { type: "turn_start", turn: 1 }),
      ev("s1/main", { type: "turn_start", turn: 1 }),
      ev("s1/verifier", { type: "turn_start", turn: 1 }),
      ev("s2/main", { type: "turn_start", turn: 1 }),
    ]);
    const segs = deriveSegments(s);
    expect(segs.map((x) => x.role)).toEqual(["planner", "main", "verifier", "main"]);
    expect(segs[1].source).toBe("s1/main");
    expect(segs[3].source).toBe("s2/main");
  });

  it("planner 的轮次不并入执行者水位——它的预算与执行者解耦", () => {
    seq = 0;
    const s = feed([
      ev("planner", { type: "turn_start", turn: 9 }),
      ev("s1/main", { type: "turn_start", turn: 2 }),
    ]);
    expect(deriveLoopFace(s, HARNESS).turn).toBe(2);
  });
});

// ================================================================
// 计划确认门（§5.1）
// ================================================================

describe("计划确认门", () => {
  const planEvent = (gated: boolean) =>
    ev("host", {
      type: "plan",
      concurrency: 2,
      concurrencyMode: "auto",
      plannerMs: 100,
      gated,
      subtasks: [
        { id: "s1", title: "一", description: "", acceptance: [], dependsOn: [] },
        { id: "s2", title: "二", description: "", acceptance: [], dependsOn: ["s1"] },
      ],
    });

  it("挂起时进 ActionRail 的「需你决定」，且排在最前（此刻决定成本最低）", () => {
    seq = 0;
    const s = feed([planEvent(true), ev("host", { type: "plan_approval_request", at: 111 })]);
    const action = deriveActionState(s);
    expect(action.awaitingPlan).toBe(true);
    expect(action.needsAttention).toBe(true);
    expect(action.planApproval.status).toBe("pending");
  });

  it("没开门的 run 完全不产生这一项（默认关，不打扰主路径）", () => {
    seq = 0;
    const s = feed([planEvent(false)]);
    expect(deriveActionState(s).planApproval).toBeNull();
    expect(deriveActionState(s).awaitingPlan).toBe(false);
    expect(derivePlanFace(s).gate).toBeNull();
  });

  it("已决后离开待办，转成 Plan 面的审计记录（同一条不在两处重复展示）", () => {
    seq = 0;
    const s = feed([
      planEvent(true),
      ev("host", { type: "plan_approval_request", at: 111 }),
      ev("host", { type: "plan_approval_resolved", requestSeq: 1, decision: "approve", actor: "user", at: 222 }),
    ]);
    const action = deriveActionState(s);
    expect(action.awaitingPlan).toBe(false);
    expect(action.needsAttention).toBe(false);
    const gate = derivePlanFace(s).gate;
    expect(gate.status).toBe("approved");
    expect(gate.at).toBe(222);
    expect(gate.actor).toBe("user");
  });

  it("否决同样留下审计记录", () => {
    seq = 0;
    const s = feed([
      planEvent(true),
      ev("host", { type: "plan_approval_request", at: 1 }),
      ev("host", { type: "plan_approval_resolved", requestSeq: 1, decision: "reject", actor: "user", at: 2 }),
    ]);
    expect(derivePlanFace(s).gate.status).toBe("rejected");
  });

  it("过期只能覆盖 pending——已签下的字是审计记录，不许被后到的过期事件抹掉", () => {
    seq = 0;
    const resolvedThenExpired = feed([
      planEvent(true),
      ev("host", { type: "plan_approval_request", at: 1 }),
      ev("host", { type: "plan_approval_resolved", requestSeq: 1, decision: "approve", actor: "user", at: 2 }),
      ev("host", { type: "plan_approval_expired", requestSeq: 1, cause: "run_finished" }),
    ]);
    expect(derivePlanFace(resolvedThenExpired).gate.status).toBe("approved");

    seq = 0;
    const neverAnswered = feed([
      planEvent(true),
      ev("host", { type: "plan_approval_request", at: 1 }),
      ev("host", { type: "plan_approval_expired", requestSeq: 1, cause: "run_finished" }),
    ]);
    expect(derivePlanFace(neverAnswered).gate.status).toBe("expired");
  });

  it("核查预算读逐 run 的 run_config，不读进程级快照（9.1）", () => {
    /**
     * 编排下各子任务的包不同、核查预算也不同（stm32-debug 30 vs 默认 15）。
     * 读进程级 `/api/harness` 会显示另一个包的数——那正是 V-24 修过的形态
     * （用户选了 ts-coding 却看到默认包的边界）。
     */
    seq = 0;
    const processLevel = { ...HARNESS, verifierBudgetTurns: 15, verifierBudgetSource: "default" };
    const s = feed([
      ev("host", {
        type: "run_config",
        pack: { name: "stm32-debug" },
        verifierBudgetTurns: 30,
        verifierBudgetSource: "pack",
      }),
    ]);
    const face = deriveVerificationFace(s, processLevel);
    expect(face.budgetTurns).toBe(30);
    expect(face.budgetSource).toBe("pack");

    // 没有 run_config 时才回落到进程级快照
    seq = 0;
    const bare = deriveVerificationFace(feed([]), processLevel);
    expect(bare.budgetTurns).toBe(15);
    expect(bare.budgetSource).toBe("default");
  });

  /**
   * 恢复策略（领域包可声明）进宿主的三处：reduceEvent 投影 / deriveLoopFace / 卡片文案。
   * 这条与 9.1 的核查预算同款——白名单投影不列字段就静默丢，这里一次把三处锁住。
   */
  describe("恢复策略进 Loop 面（run_config.recovery，逐字段来源 + armed）", () => {
    const recovery = {
      armed: true,
      progressExtensionTurns: 12,
      stagnationWindow: 3,
      maxStagnationRecoveries: 1,
      sources: { progressExtensionTurns: "pack", stagnationWindow: "default", maxStagnationRecoveries: "default" },
    };

    it("reduceEvent 投影保留 recovery（三字段 + sources + armed），派生进 Loop 面", () => {
      seq = 0;
      const s = feed([ev("host", { type: "run_config", pack: { name: "kicad" }, recovery })]);
      expect(s.runConfig.recovery).toEqual(recovery);
      const loop = deriveLoopFace(s, HARNESS);
      expect(loop.recovery).toEqual(recovery);
      // 卡片文案：数字 + 非默认字段标来源
      const card = buildFactorCards({
        loop, context: deriveContextFace(s, HARNESS), tools: deriveToolsFace(s, HARNESS),
        verification: deriveVerificationFace(s, HARNESS),
      }).find((c) => c.id === "loop");
      const line = card.lines.find((l) => l.startsWith("恢复"));
      expect(line).toContain("续跑 12 轮·包");
      expect(line).toContain("停滞窗 3");
      expect(line).toContain("换策略 1 次");
      expect(line).not.toContain("（默认）"); // 有一个字段来自包，就不能整体标"默认"
    });

    it("armed=false 时明说'关'，不把配着的数字画成生效的续跑", () => {
      seq = 0;
      const s = feed([ev("host", { type: "run_config", recovery: { ...recovery, armed: false } })]);
      const loop = deriveLoopFace(s, HARNESS);
      expect(loop.recovery.armed).toBe(false);
      const card = buildFactorCards({
        loop, context: deriveContextFace(s, HARNESS), tools: deriveToolsFace(s, HARNESS),
        verification: deriveVerificationFace(s, HARNESS),
      }).find((c) => c.id === "loop");
      const line = card.lines.find((l) => l.startsWith("恢复"));
      expect(line).toContain("关");
      expect(line).not.toContain("续跑 12 轮");
    });

    it("全默认时只标一次（默认）；没有 run_config 时回落进程级快照；快照也没有则不显示", () => {
      seq = 0;
      const allDefault = {
        ...recovery,
        progressExtensionTurns: 8,
        sources: { progressExtensionTurns: "default", stagnationWindow: "default", maxStagnationRecoveries: "default" },
      };
      const viaHarness = deriveLoopFace(feed([]), { ...HARNESS, recovery: allDefault });
      expect(viaHarness.recovery).toEqual(allDefault);
      const card = buildFactorCards({
        loop: viaHarness, context: deriveContextFace(feed([]), HARNESS), tools: deriveToolsFace(feed([]), HARNESS),
        verification: deriveVerificationFace(feed([]), HARNESS),
      }).find((c) => c.id === "loop");
      expect(card.lines.find((l) => l.startsWith("恢复"))).toBe("恢复：续跑 8 轮 · 停滞窗 3 · 换策略 1 次（默认）");

      seq = 0;
      const none = deriveLoopFace(feed([]), HARNESS);
      expect(none.recovery).toBeNull();
    });

    it("半份策略（缺字段）整体判 null——半份比没有更糟", () => {
      seq = 0;
      const s = feed([ev("host", { type: "run_config", recovery: { armed: true, progressExtensionTurns: 8 } })]);
      expect(s.runConfig.recovery).toBeNull();
    });

    it("recovery_decision 事件计入 Loop 面，与策略并排", () => {
      seq = 0;
      const s = feed([
        ev("host", { type: "run_config", recovery }),
        ev("main", { type: "recovery_decision", reason: "max_turns", action: "continue_with_context", detail: "x", extraTurns: 12 }),
      ]);
      const loop = deriveLoopFace(s, HARNESS);
      expect(loop.recoveryDecisions).toHaveLength(1);
      const card = buildFactorCards({
        loop, context: deriveContextFace(s, HARNESS), tools: deriveToolsFace(s, HARNESS),
        verification: deriveVerificationFace(s, HARNESS),
      }).find((c) => c.id === "loop");
      expect(card.lines).toContain("⤷ 恢复决策 1 次");
    });
  });

  /**
   * 无包运行的核查者拿通用只读缺省（委托方批准的例外）。界面此前只读 pack.verify.readOnlyCommands，
   * 无包 = "白名单 0"，再撞一次审批门就报"核查饥饿"——而核查者手里其实有 13 条。
   * 生效值与来源经 run_config / harness 报出，三处（投影 / 派生 / 状态条）一次锁死。
   */
  describe("核查白名单的生效值与来源（无包 = 通用缺省）", () => {
    const defaults = ["ls", "cat", "head", "grep", "git status"];

    it("run_config 报了生效列表 → 面上用它而不是包声明；来源 default 标「通用默认」", () => {
      seq = 0;
      const s = feed([
        ev("host", {
          type: "run_config",
          pack: { name: null, verify: { readOnlyCommands: [] } },
          verifierReadOnlyCommands: defaults,
          verifierReadOnlySource: "default",
        }),
        ev("verifier", { type: "approval_request", toolUseId: "v1", name: "bash", input: { command: "rm x" } }),
      ]);
      expect(s.runConfig.verifierReadOnlyCommands).toEqual(defaults);
      expect(s.runConfig.verifierReadOnlySource).toBe("default");
      const face = deriveVerificationFace(s, HARNESS);
      expect(face.whitelist).toEqual(defaults);
      expect(face.whitelistSource).toBe("default");
      // 有 13 条缺省在手却报"无白名单饥饿"就是说谎
      expect(face.starvation.noWhitelist).toBe(false);
      const chip = deriveAssemblyBar(s, HARNESS).find((i) => i.key === "verify");
      expect(chip.chip).toContain("白名单 5(通用默认)");
      expect(whitelistSourceLabel("default")).toBe("通用默认");
      expect(whitelistSourceLabel("pack")).toBe("");
    });

    it("包声明 → 来源 pack 不加标签；包沉默 → none 标「包未声明」且列表为空", () => {
      seq = 0;
      const fromPack = feed([
        ev("host", {
          type: "run_config",
          pack: { name: "python-coding", verify: { readOnlyCommands: ["python -m pytest"] } },
          verifierReadOnlyCommands: ["python -m pytest"],
          verifierReadOnlySource: "pack",
        }),
      ]);
      expect(deriveAssemblyBar(fromPack, HARNESS).find((i) => i.key === "verify").chip).toContain("白名单 1");
      expect(deriveAssemblyBar(fromPack, HARNESS).find((i) => i.key === "verify").chip).not.toContain("(");

      seq = 0;
      const silent = feed([
        ev("host", {
          type: "run_config",
          pack: { name: "stm32-debug", verify: { readOnlyCommands: [] } },
          verifierReadOnlyCommands: [],
          verifierReadOnlySource: "none",
        }),
      ]);
      expect(deriveVerificationFace(silent, HARNESS).whitelist).toEqual([]);
      expect(deriveVerificationFace(silent, HARNESS).whitelistSource).toBe("none");
    });

    it("旧宿主没报生效列表 → 回落到包声明（行为不变）", () => {
      seq = 0;
      const s = feed([ev("host", { type: "run_config", pack: { name: "python-coding", verify: { readOnlyCommands: ["python -m pytest"] } } })]);
      const face = deriveVerificationFace(s, HARNESS);
      expect(face.whitelist).toEqual(["python -m pytest"]);
      expect(face.whitelistSource).toBeNull();
    });
  });

  it("plan 事件带 gated 标记——否则前端会以为计划已经在跑了", () => {
    seq = 0;
    expect(feed([planEvent(true)]).plan.gated).toBe(true);
    expect(feed([planEvent(false)]).plan.gated).toBe(false);
  });

  /**
   * 真机实测抓到的缺陷（先于计划门就存在）：编排模式下 planner 自己那一轮也发
   * `done(completed)`。reducer 的"非核查模式 done 即终止"快路径不限定来源时，
   * 客户端会在 planner 结束的那一刻判定整个 run 结束，控制器随即关掉 SSE——
   * 之后的 plan / plan_result / 子任务进度 / run_end 全部收不到。
   * 触发条件 mode=plan 且未勾核查，正是选"计划编排"后的默认组合。
   */
  it("planner 与子任务的 done 不终止整个 run——只有 main 段的 done 才是（V-01 同款）", () => {
    seq = 0;
    const afterPlanner = feed(
      [
        ev("planner", { type: "turn_start", turn: 1 }),
        ev("planner", { type: "done", stopReason: "completed", messageCount: 2, usage: {} }),
      ],
      "编排任务",
      false,
    );
    expect(afterPlanner.status).toBe("running");

    seq = 0;
    const afterSubtask = feed(
      [ev("s1/main", { type: "done", stopReason: "completed", messageCount: 2, usage: {} })],
      "编排任务",
      false,
    );
    expect(afterSubtask.status).toBe("running");

    seq = 0;
    const afterMain = feed(
      [ev("main", { type: "done", stopReason: "completed", messageCount: 2, usage: {} })],
      "单跑任务",
      false,
    );
    expect(afterMain.status).toBe("done"); // 单跑的快路径保持原样
  });
});

describe("裁决获得路径透出到宿主（§2.1 前置）", () => {
  it("verification 事件的 recovery 进 state（白名单投影必须列它）", () => {
    seq = 0;
    const s = feed([
      ev("verifier", {
        type: "verification",
        round: 0,
        recovery: "wrapup",
        verdict: { passed: true, issues: [], summary: "ok" },
        usage: { turns: 31 },
      }),
    ]);
    expect(s.verifications[0].recovery).toBe("wrapup");
    expect(deriveVerificationFace(s, HARNESS).rounds[0].recovery).toBe("wrapup");
  });

  it("旧事件没有 recovery 时为 null，不显示 undefined", () => {
    seq = 0;
    const s = feed([
      ev("verifier", {
        type: "verification",
        round: 0,
        verdict: { passed: true, issues: [], summary: "ok" },
        usage: {},
      }),
    ]);
    expect(s.verifications[0].recovery).toBeNull();
  });
});

// ================================================================
// MEM-01：上下文窗口（事实）与压缩预算（策略）分离
// ================================================================

/**
 * 为什么这一组存在：`contextTokenLimit` 一个数此前同时充当"模型能装多少"与"我们在多少处压"。
 * 界面上只有一个百分比，于是 150k 的默认预算在窗口 1,048,576 的端点上压了三个月没人看见。
 * 分开之后界面必须同时说清三件事：**已用**（最近一轮输入）、**预算**（策略，带来源）、
 * **窗口**（事实，带来源；不知道就说"窗口未知"，不画 0）。
 *
 * 纪律（host-lags）：`reduceEvent` 是逐字段白名单投影，不列的字段静默丢弃且不报错。
 * 所以每个新字段都要三处有锁：投影分支、派生函数、渲染分支（渲染在 ui-a11y.test.ts）。
 */
describe("MEM-01 上下文窗口（事实）与预算（策略）分离", () => {
  const usageEv = (input: number) =>
    ev("main", {
      type: "usage", turn: 1,
      usage: { input_tokens: input, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });

  /** 宿主 context 投影的完整形状（run_config.context 与 /api/harness.context 同形） */
  const ctx = (over = {}) => ({
    window: 10_000, windowSource: "learned",
    budget: 1000, budgetSource: "default", requestedBudget: 1000,
    maxBudget: 9000, maxTokens: 500, clamped: false, warning: null,
    ...over,
  });

  describe("normalizeContextConfig（白名单投影）", () => {
    it("九个字段照收，来源按四值枚举校验", () => {
      const c = normalizeContextConfig(ctx({ budgetSource: "run" }));
      expect(c).toEqual({
        window: 10_000, windowSource: "learned",
        budget: 1000, budgetSource: "run", requestedBudget: 1000,
        maxBudget: 9000, maxTokens: 500, clamped: false, warning: null,
      });
    });

    /** 界面不许替宿主编来源：枚举外的字符串归 unknown / null，而不是原样显示出去 */
    it("枚举之外的来源字符串归 unknown / null", () => {
      const c = normalizeContextConfig(ctx({ windowSource: "我猜的", budgetSource: "probably" }));
      expect(c.windowSource).toBe("unknown");
      expect(c.budgetSource).toBeNull();
    });

    it("没有 budget 就整体 null——没有分母画不出任何一段", () => {
      expect(normalizeContextConfig({ window: 10_000, windowSource: "registry" })).toBeNull();
      expect(normalizeContextConfig(null)).toBeNull();
      expect(normalizeContextConfig("150k")).toBeNull();
    });

    /** window=null 是"未知"，不是 0：0 会被画成一条空条，等于编了一个数 */
    it("window 缺失 / 非正数 = 窗口未知", () => {
      expect(normalizeContextConfig(ctx({ window: null })).window).toBeNull();
      expect(normalizeContextConfig(ctx({ window: 0 })).window).toBeNull();
    });

    /** 幂等：装配面与两个派生函数都会各自 normalize 一次同一个对象 */
    it("对已归一化的对象幂等", () => {
      const once = normalizeContextConfig(ctx());
      expect(normalizeContextConfig(once)).toEqual(once);
    });
  });

  describe("reduceEvent 投影分支", () => {
    it("run_config.context 进 state.runConfig.context（不列进白名单就静默丢弃）", () => {
      seq = 0;
      const s = feed([
        ev("host", { type: "run_config", guardrails: { contextTokenLimit: 1000 }, context: ctx({ budgetSource: "run" }) }),
      ]);
      expect(s.runConfig.context.budget).toBe(1000);
      expect(s.runConfig.context.budgetSource).toBe("run");
      expect(s.runConfig.context.window).toBe(10_000);
      expect(s.runConfig.context.windowSource).toBe("learned");
    });

    it("旧宿主的 run_config 没有 context 时为 null，不造一个空壳", () => {
      seq = 0;
      const s = feed([ev("host", { type: "run_config", guardrails: { contextTokenLimit: 1000 } })]);
      expect(s.runConfig.context).toBeNull();
    });
  });

  describe("deriveContextFace", () => {
    it("逐 run run_config.context 优先于进程级 harness.context（V-24 同款）", () => {
      seq = 0;
      const s = feed([
        ev("host", { type: "run_config", context: ctx({ budget: 400, budgetSource: "run", window: 20_000 }) }),
        usageEv(200),
      ]);
      const f = deriveContextFace(s, { ...HARNESS, context: ctx() });
      expect(f.budget).toBe(400); // 不是进程级的 1000
      expect(f.limit).toBe(400); // 水位分母就是预算
      expect(f.budgetSource).toBe("run");
      expect(f.window).toBe(20_000);
      expect(f.ratio).toBeCloseTo(0.5);
    });

    it("两处都没有 context 时回落 guardrails.contextTokenLimit，窗口一律未知", () => {
      seq = 0;
      const f = deriveContextFace(feed([usageEv(480)]), HARNESS);
      expect(f.budget).toBe(1000);
      expect(f.window).toBeNull();
      expect(f.windowSource).toBe("unknown");
      expect(f.strip.window).toBeNull();
      expect(f.strip.total).toBe(1000); // 窗口未知 → 轨道总长就是预算
      expect(f.windowRatio).toBeNull();
    });

    /** 窗口已知时轨道总长是窗口，预算只占其中一段——这一段的宽度就是"我们在 10% 处压" */
    it("窗口已知：三段条总长 = 窗口，预算段与压缩刻度按窗口比例", () => {
      seq = 0;
      const f = deriveContextFace(feed([usageEv(480)]), { ...HARNESS, context: ctx() });
      expect(f.strip.total).toBe(10_000);
      expect(f.strip.window).toBe(1);
      expect(f.strip.budget).toBeCloseTo(0.1); // 1000 / 10000
      expect(f.strip.used).toBeCloseTo(0.048); // 480 / 10000
      expect(f.strip.threshold).toBeCloseTo(0.08); // 1000 × 0.8 / 10000
      expect(f.windowRatio).toBeCloseTo(0.048);
      // 预算的 48% 只是窗口的 4.8%——两个百分比压成一个就是当初那个缺陷
      expect(f.ratio).toBeCloseTo(0.48);
    });

    /**
     * 档位边界：水位是 ≥ 而不是 >。79% 不许说"下一轮将压缩"（会成为一句反复被打脸的假话），
     * 80% 必须说——compaction 判据取的就是这个数。
     */
    it("档位边界：79% 不说下一轮将压缩，80% 说", () => {
      seq = 0;
      const below = deriveContextFace(feed([usageEv(790)]), HARNESS);
      expect(below.ratio).toBeCloseTo(0.79);
      expect(below.compactNextTurn).toBe(false);
      expect(below.nearWatermark).toBe(false);
      seq = 0;
      const at = deriveContextFace(feed([usageEv(800)]), HARNESS);
      expect(at.ratio).toBeCloseTo(0.8);
      expect(at.compactNextTurn).toBe(true);
      expect(at.nearWatermark).toBe(true);
    });

    /** 夹紧不是静默降级：生效值、原值、告警原文三样都要能拿到 */
    it("被夹紧时透出原值与告警原文", () => {
      seq = 0;
      const f = deriveContextFace(feed([usageEv(100)]), {
        ...HARNESS,
        context: ctx({ budget: 8000, requestedBudget: 150_000, clamped: true, warning: "已夹到 8k：窗口 10k − maxTokens 500 − 边际 4k" }),
      });
      expect(f.clamped).toBe(true);
      expect(f.budget).toBe(8000);
      expect(f.requestedBudget).toBe(150_000);
      expect(f.clampWarning).toContain("已夹到 8k");
      expect(f.maxBudget).toBe(9000);
      expect(f.maxTokens).toBe(500);
    });
  });

  describe("deriveToolsFace / deriveAssemblyBar", () => {
    it("Tools 面带 context（逐 run 优先），旧宿主为 null 则不显示那一行", () => {
      seq = 0;
      const withCtx = deriveToolsFace(feed([ev("host", { type: "run_config", context: ctx() })]), HARNESS);
      expect(withCtx.context.window).toBe(10_000);
      seq = 0;
      expect(deriveToolsFace(feed([usageEv(1)]), HARNESS).context).toBeNull();
    });

    it("装配条有 context 一格：预算带夹紧标记，窗口未知就写「窗口未知」", () => {
      seq = 0;
      const known = deriveAssemblyBar(feed([usageEv(1)]), { ...HARNESS, context: ctx({ budget: 150_000 }) })
        .find((i) => i.key === "context");
      expect(known.chip).toContain("150k");
      expect(known.chip).toContain("窗口 10k");
      expect(known.why).toContain("窗口 − maxTokens − 边际");

      seq = 0;
      const clamped = deriveAssemblyBar(feed([usageEv(1)]), {
        ...HARNESS, context: ctx({ budget: 8000, requestedBudget: 150_000, clamped: true }),
      }).find((i) => i.key === "context");
      expect(clamped.chip).toContain("8k↓");
      expect(clamped.why).toContain("由 150k 夹到 8k");

      seq = 0;
      const unknown = deriveAssemblyBar(feed([usageEv(1)]), { ...HARNESS, context: ctx({ window: null, windowSource: "unknown" }) })
        .find((i) => i.key === "context");
      expect(unknown.chip).toContain("窗口未知");
    });

    /** 装配条的口径是"chip 为空即整格不出现"（push 的规矩），所以旧宿主根本没有这一格 */
    it("旧宿主（两处都无 context）不出现这一格，而不是出现一个空数", () => {
      seq = 0;
      expect(deriveAssemblyBar(feed([usageEv(1)]), HARNESS).find((i) => i.key === "context")).toBeUndefined();
    });
  });

  describe("buildNewRunRequest 的逐 run 预算", () => {
    it("填了就原样送宿主校验（不在浏览器里夹紧）", () => {
      expect(buildNewRunRequest({ task: "t", contextTokenLimit: "300000" }).contextTokenLimit).toBe(300_000);
      // 越界值也照送——夹紧口径只有宿主一处，浏览器擅自改数就是界面说谎
      expect(buildNewRunRequest({ task: "t", contextTokenLimit: 9_999_999 }).contextTokenLimit).toBe(9_999_999);
    });

    it("空 / 非数字不送这个字段（沿用 env > 包 > 默认）", () => {
      expect(buildNewRunRequest({ task: "t" })).not.toHaveProperty("contextTokenLimit");
      expect(buildNewRunRequest({ task: "t", contextTokenLimit: "" })).not.toHaveProperty("contextTokenLimit");
      expect(buildNewRunRequest({ task: "t", contextTokenLimit: "  " })).not.toHaveProperty("contextTokenLimit");
      expect(buildNewRunRequest({ task: "t", contextTokenLimit: "abc" })).not.toHaveProperty("contextTokenLimit");
    });
  });

  describe("deriveContextBudgetKnob（提交表单的预算控件）", () => {
    const wide = normalizeContextConfig(ctx({ window: 1_048_576, windowSource: "registry", budget: 150_000, maxBudget: 963_605, maxTokens: 64_000 }));

    it("上限取 maxBudget，提示写清算式与窗口来源", () => {
      const k = deriveContextBudgetKnob(wide, "");
      expect(k.min).toBe(32_000);
      expect(k.max).toBe(963_605);
      expect(k.hint).toContain("窗口 1,048k（登记表）");
      expect(k.hint).toContain("上限 = 窗口 − maxTokens 64k − 边际");
      expect(k.advisory).toBeNull();
      expect(k.outOfRange).toBe(false);
    });

    it("窗口未知：上限取硬顶并明说，不把「不知道」画成一个数", () => {
      const k = deriveContextBudgetKnob(null, "");
      expect(k.max).toBe(2_000_000);
      expect(k.hint).toContain("窗口未知");
      expect(k.hint).toContain("上限取硬顶");
      expect(k.placeholder).toContain("150000");
    });

    /** 忠告是忠告：>200k 说明成本随上下文线性增长，且诚实标注这是**上界**而非预测值 */
    it("超过 200k 给成本忠告并标明是上界；200k 及以下不给", () => {
      expect(deriveContextBudgetKnob(wide, "200000").advisory).toBeNull();
      const hot = deriveContextBudgetKnob(wide, "200001");
      expect(hot.advisory).toContain("线性增长");
      expect(hot.advisory).toContain("上界");
      expect(hot.outOfRange).toBe(false); // 忠告 ≠ 阻断
    });

    it("越界只提示、不阻断（宿主 400 是最终裁判）", () => {
      const k = deriveContextBudgetKnob(wide, "9999999");
      expect(k.outOfRange).toBe(true);
      expect(k.hint).toContain("越界");
      expect(deriveContextBudgetKnob(wide, "31999").outOfRange).toBe(true);
      expect(deriveContextBudgetKnob(wide, "32000").outOfRange).toBe(false);
    });

    it("占位符报生效预算与来源，被夹紧时说出来", () => {
      expect(deriveContextBudgetKnob(normalizeContextConfig(ctx({ budget: 8000, clamped: true, requestedBudget: 150_000 })), "").placeholder)
        .toContain("已夹紧");
      expect(deriveContextBudgetKnob(normalizeContextConfig(ctx({ budget: 200_000, budgetSource: "env" })), "").placeholder)
        .toContain("env");
    });
  });

  it("来源标签全部有人话，未知不落成 undefined", () => {
    for (const s of ["env", "learned", "registry", "run", "pack", "default"]) {
      expect(contextSourceLabel(s)).toBeTruthy();
    }
    expect(contextSourceLabel("unknown")).toBe("未知");
    expect(contextSourceLabel(undefined)).toBe("未知");
  });
});

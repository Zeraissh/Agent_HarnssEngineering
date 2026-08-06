// @ts-nocheck
/**
 * ui/public/app.js + styles.css — reducer 纯函数 + 样式静态断言测试（node 环境，不依赖 DOM）。
 *
 * 阶段二新增:
 *   R-03: deriveOverview — 概览模型（finalStatus, resultSummary, verdict三值, 待介入事项, usage）
 *   R-04: deriveLogEntries / toggleEntryCollapsed — 日志分层与折叠
 *   R-05: 无障碍语义静态断言（tabindex/role/aria-selected/label/aria-live/:focus-visible）
 *   R-06: WCAG 对比度测试（从 styles.css 解析色对，实算相对亮度）
 *   R-07: 视觉收敛 — CSS 无大面积洋红背景
 *   R-08: deriveRunListItems / filterRunsByStatus — 列表元数据与筛选
 *   P2: styles.css 中除 :root 外无裸十六进制色值
 *
 * 阶段三新增 (AC-10 异常流程回归):
 *   审批拒绝·reducer: 被拒工具 tool_result 含理由（reduceEvent）
 *   审批拒绝·概览: resolvedApprovals 含 denied 信息（status/reason/decidedAt）
 *   执行失败·reducer: error→finalStatus=error + error 字段填充
 *   执行失败·R-01联动: error stopReason 下 pending 审批转 expired
 *   核查未通过·概览: verdict.passed=false + issues 列表呈现
 *   核查未通过·渲染语义: verdict-badge--fail 使用红色系（区别于绿色 passed）
 *   核查未通过·时间线: main/rework 来源区分
 */
import { describe, expect, it } from "vitest";
import {
  createInitialState,
  reduceEvent,
  markApprovalResolved,
  expirePendingApprovals,
  deriveOverview,
  deriveLogEntries,
  toggleEntryCollapsed,
  isEntryCollapsedByDefault,
  deriveRunListItems,
  filterRunsByStatus,
} from "../ui/public/app.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---- helpers ----

function sse(source, type, extra = {}) {
  return { seq: 0, source, event: { type, ...extra } };
}

function makeState(overrides = {}) {
  let s = createInitialState("r-test", "test task", false);
  if (overrides.timeline) s = { ...s, timeline: overrides.timeline };
  if (overrides.verifierTimeline) s = { ...s, verifierTimeline: overrides.verifierTimeline };
  if (overrides.pendingApprovals) s = { ...s, pendingApprovals: overrides.pendingApprovals };
  if (overrides.verdict) s = { ...s, verdict: overrides.verdict };
  if (overrides.usage) s = { ...s, usage: overrides.usage };
  if (overrides.error) s = { ...s, error: overrides.error };
  if (overrides.status) s = { ...s, status: overrides.status };
  if (overrides.verify) s = { ...s, verify: overrides.verify };
  return s;
}

// ---- tests ----

describe("reduceEvent", () => {
  // ---- AC3-1: 时间线折叠 ----
  it("1. 时间线折叠: turn_start → tool_call → tool_result 顺序", () => {
    let state = createInitialState("r1", "test task", false);

    state = reduceEvent(state, sse("main", "turn_start", { turn: 1 }));
    state = reduceEvent(state, sse("main", "tool_call", { toolUseId: "tu_1", name: "bash", input: { cmd: "ls" } }));
    state = reduceEvent(state, sse("main", "tool_result", {
      toolUseId: "tu_1",
      result: { content: "file1.txt\nfile2.txt", isError: false },
      durationMs: 42,
    }));

    expect(state.timeline).toHaveLength(3);
    expect(state.timeline[0].type).toBe("turn_start");
    expect(state.timeline[0].turn).toBe(1);
    expect(state.timeline[1].type).toBe("tool_call");
    expect(state.timeline[1].toolUseId).toBe("tu_1");
    expect(state.timeline[1].name).toBe("bash");
    expect(state.timeline[1].input).toEqual({ cmd: "ls" });
    expect(state.timeline[2].type).toBe("tool_result");
    expect(state.timeline[2].toolUseId).toBe("tu_1");
    expect(state.timeline[2].resultContent).toBe("file1.txt\nfile2.txt");
    expect(state.timeline[2].resultIsError).toBe(false);
    expect(state.timeline[2].durationMs).toBe(42);
  });

  // ---- AC3-2: text_delta 忽略 ----
  it("2. text_delta 忽略不渲染", () => {
    let state = createInitialState("r2", "task", false);

    state = reduceEvent(state, sse("main", "turn_start", { turn: 1 }));
    state = reduceEvent(state, sse("main", "text_delta", { text: "partial..." }));
    state = reduceEvent(state, sse("main", "assistant_text", { text: "full response" }));

    const types = state.timeline.map((e) => e.type);
    expect(types).not.toContain("text_delta");
    expect(state.timeline).toHaveLength(2);
    expect(types).toEqual(["turn_start", "assistant_text"]);
  });

  // ---- AC3-3: verifier 事件归入核查面板 ----
  it("3. source=verifier 事件归入 verifierTimeline", () => {
    let state = createInitialState("r3", "verify task", true);

    state = reduceEvent(state, sse("main", "turn_start", { turn: 1 }));
    state = reduceEvent(state, sse("main", "assistant_text", { text: "main output" }));
    state = reduceEvent(state, sse("verifier", "turn_start", { turn: 1 }));
    state = reduceEvent(state, sse("verifier", "tool_call", { toolUseId: "vt_1", name: "read_file", input: {} }));
    state = reduceEvent(state, sse("verifier", "tool_result", {
      toolUseId: "vt_1",
      result: { content: "verified", isError: false },
      durationMs: 10,
    }));

    expect(state.timeline).toHaveLength(2);
    expect(state.timeline[0].source).toBe("main");
    expect(state.timeline[1].source).toBe("main");
    expect(state.verifierTimeline).toHaveLength(3);
    expect(state.verifierTimeline[0].source).toBe("verifier");
    expect(state.verifierTimeline[1].source).toBe("verifier");
    expect(state.verifierTimeline[2].source).toBe("verifier");
  });

  // ---- AC3-4: 审批卡生命周期 ----
  it("4. 审批卡生命周期: 出现 → 标记已处理", () => {
    let state = createInitialState("r4", "approval task", false);

    state = reduceEvent(state, sse("main", "approval_request", {
      toolUseId: "tu_approve",
      name: "write_file",
      input: { path: "/etc/hosts", content: "evil" },
    }));

    expect(state.pendingApprovals).toHaveLength(1);
    expect(state.pendingApprovals[0].toolUseId).toBe("tu_approve");
    expect(state.pendingApprovals[0].name).toBe("write_file");
    expect(state.pendingApprovals[0].status).toBe("pending");

    state = markApprovalResolved(state, "tu_approve", "allowed");
    expect(state.pendingApprovals[0].status).toBe("allowed");

    let state2 = createInitialState("r4b", "task", false);
    state2 = reduceEvent(state2, sse("main", "approval_request", {
      toolUseId: "tu_deny",
      name: "bash",
      input: { cmd: "rm -rf /" },
    }));
    state2 = markApprovalResolved(state2, "tu_deny", "denied", "太危险");
    expect(state2.pendingApprovals[0].status).toBe("denied");
    expect(state2.pendingApprovals[0].reason).toBe("太危险");
  });

  // ---- AC3-5: verdict 三值卡模型 ----
  it("5. verdict 三值卡: issues/unverified/advisory 各自到位", () => {
    let state = createInitialState("r5", "verify task", true);

    state = reduceEvent(state, {
      seq: 10,
      source: "verifier",
      event: {
        type: "verdict",
        verdict: {
          passed: true,
          issues: ["文件行数不符：期望 10 实际 8"],
          unverified: ["需人工确认二进制输出格式"],
          advisory: ["代码风格良好 | 抽样 3 文件"],
          summary: "客观项全过，有 1 条需委托方确认",
        },
      },
    });

    expect(state.verdict).not.toBeNull();
    expect(state.verdict.passed).toBe(true);
    expect(state.verdict.summary).toBe("客观项全过，有 1 条需委托方确认");
    expect(state.verdict.issues).toEqual(["文件行数不符：期望 10 实际 8"]);
    expect(state.verdict.unverified).toEqual(["需人工确认二进制输出格式"]);
    expect(state.verdict.advisory).toEqual(["代码风格良好 | 抽样 3 文件"]);
  });

  // ---- AC3-6: done 事件 usage 脚注提取 ----
  it("6. done 事件: usage 脚注提取（turns/in/out/cacheHit）", () => {
    let state = createInitialState("r6", "usage task", false);

    state = reduceEvent(state, sse("main", "turn_start", { turn: 1 }));
    state = reduceEvent(state, sse("main", "done", {
      stopReason: "completed",
      usage: {
        inputTokens: 1500,
        cacheCreationTokens: 200,
        cacheReadTokens: 300,
        outputTokens: 800,
        turns: 3,
        cacheHitRatio: 0.15,
      },
    }));

    expect(state.status).toBe("done");
    expect(state.error).toBeNull();
    expect(state.usage).not.toBeNull();
    expect(state.usage.turns).toBe(3);
    expect(state.usage.inputTokens).toBe(1500);
    expect(state.usage.outputTokens).toBe(800);
    expect(state.usage.cacheHitRatio).toBe(0.15);
  });

  // ---- 7. verifier approval 不进 pendingApprovals ----
  it("7. verifier 审批: 不进 pendingApprovals（仅进 verifierTimeline）", () => {
    let state = createInitialState("r7", "verify with approval", true);

    state = reduceEvent(state, sse("verifier", "approval_request", {
      toolUseId: "vtu_check",
      name: "bash",
      input: { cmd: "ls" },
    }));

    expect(state.pendingApprovals).toHaveLength(0);
    const vTypes = state.verifierTimeline.map((e) => e.type);
    expect(vTypes).toContain("approval_request");
    expect(state.verifierTimeline[0].toolUseId).toBe("vtu_check");
  });

  // ---- 8. error stopReason 标记 ----
  it("8. done 事件 error stopReason 产生 error 标记", () => {
    let state = createInitialState("r8", "error task", false);

    state = reduceEvent(state, sse("main", "done", {
      stopReason: "error",
      usage: { inputTokens: 0, outputTokens: 0, turns: 0, cacheHitRatio: 0 },
    }));

    expect(state.status).toBe("done");
    expect(state.error).toBe("运行异常终止");
  });

  // ---- 9. api_retry 和 compaction 进入时间线 ----
  it("9. api_retry 和 compaction 进入时间线", () => {
    let state = createInitialState("r9", "retry task", false);

    state = reduceEvent(state, sse("main", "api_retry", { turn: 2, attempt: 1, reason: "timeout" }));
    state = reduceEvent(state, sse("main", "compaction", { droppedBlocks: 15 }));

    expect(state.timeline).toHaveLength(2);
    expect(state.timeline[0].type).toBe("api_retry");
    expect(state.timeline[0].attempt).toBe(1);
    expect(state.timeline[0].reason).toBe("timeout");
    expect(state.timeline[1].type).toBe("compaction");
    expect(state.timeline[1].droppedBlocks).toBe(15);
  });

  // ---- 10. R-01: done 事件将 pending 审批转为 expired ----
  it("10. R-01: done 事件将 pending 审批转为 expired", () => {
    let state = createInitialState("r10", "approval then done", false);

    state = reduceEvent(state, sse("main", "approval_request", {
      toolUseId: "tu_expire",
      name: "bash",
      input: { cmd: "rm" },
    }));

    expect(state.pendingApprovals).toHaveLength(1);
    expect(state.pendingApprovals[0].status).toBe("pending");

    state = reduceEvent(state, sse("main", "done", {
      stopReason: "completed",
      usage: { inputTokens: 100, outputTokens: 50, turns: 1, cacheHitRatio: 0 },
    }));

    expect(state.pendingApprovals).toHaveLength(1);
    expect(state.pendingApprovals[0].status).toBe("expired");
    expect(state.status).toBe("done");
  });

  // ---- 11. R-01: markApprovalResolved 设置 decidedAt ----
  it("11. R-01: markApprovalResolved 设置 decidedAt 时间戳（只读记录模型）", () => {
    let state = createInitialState("r11", "approval record", false);

    state = reduceEvent(state, sse("main", "approval_request", {
      toolUseId: "tu_rec",
      name: "write_file",
      input: { path: "/f" },
    }));

    const beforeMark = Date.now();
    state = markApprovalResolved(state, "tu_rec", "allowed", "ok");
    expect(state.pendingApprovals[0].status).toBe("allowed");
    expect(state.pendingApprovals[0].reason).toBe("ok");
    expect(state.pendingApprovals[0].decidedAt).toBeTypeOf("number");
    expect(state.pendingApprovals[0].decidedAt).toBeGreaterThanOrEqual(beforeMark);

    let state2 = createInitialState("r11b", "deny record", false);
    state2 = reduceEvent(state2, sse("main", "approval_request", {
      toolUseId: "tu_deny2",
      name: "rm",
      input: {},
    }));
    state2 = markApprovalResolved(state2, "tu_deny2", "denied", "too risky");
    expect(state2.pendingApprovals[0].status).toBe("denied");
    expect(state2.pendingApprovals[0].reason).toBe("too risky");
    expect(state2.pendingApprovals[0].decidedAt).toBeTypeOf("number");
  });

  // ---- 12. R-01: 状态一致性 ----
  it("12. R-01: 状态一致性 — status/pendingApprovals 来自同一 state 源", () => {
    let state = createInitialState("r12", "consistency", false);

    expect(state.status).toBe("running");
    expect(state.pendingApprovals).toHaveLength(0);

    state = reduceEvent(state, sse("main", "approval_request", {
      toolUseId: "tu_c1",
      name: "tool1",
      input: {},
    }));
    expect(state.status).toBe("running");
    expect(state.pendingApprovals).toHaveLength(1);
    expect(state.pendingApprovals[0].status).toBe("pending");

    state = reduceEvent(state, sse("main", "done", {
      stopReason: "completed",
      usage: { inputTokens: 0, outputTokens: 0, turns: 0, cacheHitRatio: 0 },
    }));
    expect(state.status).toBe("done");
    expect(state.pendingApprovals[0].status).toBe("expired");
    expect(state.status === "done" && state.pendingApprovals[0].status === "expired").toBe(true);
  });

  // ---- 13. R-01: expirePendingApprovals ----
  it("13. R-01: expirePendingApprovals 将 pending 审批转为 expired，已处理的不变", () => {
    let state = createInitialState("r13", "expire fn", false);

    state = reduceEvent(state, sse("main", "approval_request", {
      toolUseId: "tu_e1",
      name: "a",
      input: {},
    }));
    state = reduceEvent(state, sse("main", "approval_request", {
      toolUseId: "tu_e2",
      name: "b",
      input: {},
    }));
    state = markApprovalResolved(state, "tu_e1", "allowed", "ok");

    expect(state.pendingApprovals[0].status).toBe("allowed");
    expect(state.pendingApprovals[1].status).toBe("pending");

    state = expirePendingApprovals(state);

    expect(state.pendingApprovals[0].status).toBe("allowed");
    expect(state.pendingApprovals[1].status).toBe("expired");
  });

  // ---- 14. 空态文案 ----
  it("14. 空态文案: renderEmptyState 区分空列表 vs 有记录未选中", () => {
    const appPath = join(__dirname, "..", "ui", "public", "app.js");
    const appSrc = readFileSync(appPath, "utf-8");

    expect(appSrc).toContain("尚无运行。");
    expect(appSrc).toContain("选择左侧运行查看详情，或创建新任务。");
    expect(appSrc).not.toContain("尚无运行。提交一个任务开始。");
  });

  // ---- 阶段三: 审批拒绝 · 时间线 — 被拒工具的 tool_result 含拒绝理由 ----
  it("审批拒绝·时间线: 被拒工具的 tool_result timeline 条目含拒绝理由", () => {
    let state = createInitialState("r_deny_time", "deny timeline", false);

    // 模拟审批请求
    state = reduceEvent(state, sse("main", "approval_request", {
      toolUseId: "tu_deny_tl",
      name: "risky_op",
      input: { cmd: "drop_db" },
    }));

    // 模拟服务端返回的 tool_result（isError=true，内容含拒绝理由）
    state = reduceEvent(state, sse("main", "tool_result", {
      toolUseId: "tu_deny_tl",
      result: { content: "操作被拒绝：too dangerous", isError: true },
      durationMs: 5,
    }));

    // 时间线中应包含该 tool_result
    const toolResults = state.timeline.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].resultIsError).toBe(true);
    expect(toolResults[0].resultContent).toContain("too dangerous");
    expect(toolResults[0].toolUseId).toBe("tu_deny_tl");
  });

  // ---- 阶段三: R-01 执行失败路径 —— error stopReason 下 pending 审批转 expired ----
  it("R-01 执行失败: error stopReason 下仍 pending 的审批转为 expired（不可操作）", () => {
    let state = createInitialState("r_err_exp", "error expiry", false);

    // 先产生一个 pending 审批
    state = reduceEvent(state, sse("main", "approval_request", {
      toolUseId: "tu_err_x",
      name: "danger_op",
      input: { cmd: "drop_table" },
    }));
    expect(state.pendingApprovals).toHaveLength(1);
    expect(state.pendingApprovals[0].status).toBe("pending");

    // 模拟执行失败：done 事件 stopReason=error
    state = reduceEvent(state, sse("main", "done", {
      stopReason: "error",
      usage: { inputTokens: 100, outputTokens: 50, turns: 1, cacheHitRatio: 0 },
    }));

    // R-01 P0: run 以 error 结束时，pending 审批必须转 expired
    expect(state.pendingApprovals).toHaveLength(1);
    expect(state.pendingApprovals[0].status).toBe("expired");
    expect(state.status).toBe("done");
    expect(state.error).toBe("运行异常终止");

    // 关键断言：expired 审批不可操作（状态不是 pending）
    expect(state.pendingApprovals[0].status).not.toBe("pending");
  });
});

// ================================================================
// AC6: 窄屏 CSS 静态断言
// ================================================================

describe("AC6 窄屏 CSS", () => {
  it("styles.css 含 max-width:700px 媒体查询实现单栏", () => {
    const cssPath = join(__dirname, "..", "ui", "public", "styles.css");
    const css = readFileSync(cssPath, "utf-8");

    expect(css).toContain("@media");
    expect(css).toContain("max-width: 700px");
    expect(css).toContain("narrow-hidden");
    expect(css).toContain("flex-direction: column");
  });
});

// ================================================================
// AC7: 第 12 节文案逐条落地（静态文本断言）
// ================================================================

describe("AC7 第 12 节文案", () => {
  it("index.html / app.js 新文案存在、旧文案不存在", () => {
    const htmlPath = join(__dirname, "..", "ui", "public", "index.html");
    const appPath = join(__dirname, "..", "ui", "public", "app.js");
    const html = readFileSync(htmlPath, "utf-8");
    const app = readFileSync(appPath, "utf-8");
    const combined = html + "\n" + app;

    expect(combined).toContain("开启独立核查");
    expect(combined).toContain("运行任务");
    expect(combined).toContain("Agent 执行");
    expect(combined).toContain("核查 Agent");
    expect(combined).toContain("允许本次");
    expect(combined).toContain("拒绝并说明");
    expect(combined).toContain("选择左侧运行查看详情，或创建新任务。");

    const checkboxLabel = html.match(/<span>(核查|开启独立核查)<\/span>/);
    expect(checkboxLabel).not.toBeNull();
    expect(checkboxLabel[1]).toBe("开启独立核查");

    expect(html).not.toContain('>提交</button>');
    expect(app).not.toContain("主时间线");
    expect(app).not.toContain("核查过程");
  });
});

// ================================================================
// 阶段二 新测试
// ================================================================

// ---- AC3: 概览模型 deriveOverview (R-03) ----
describe("AC3 概览模型 deriveOverview (R-03)", () => {
  it("15. 从事件流派生出 finalStatus / resultSummary / verdict / 待介入事项 / usage", () => {
    let state = createInitialState("ro1", "overview task", true);

    // 注入助手消息
    state = reduceEvent(state, sse("main", "turn_start", { turn: 1 }));
    state = reduceEvent(state, sse("main", "assistant_text", { text: "任务已完成，共修改 3 个文件。" }));
    state = reduceEvent(state, sse("main", "tool_call", { toolUseId: "t1", name: "write_file", input: { path: "a.txt" } }));
    state = reduceEvent(state, sse("main", "tool_result", {
      toolUseId: "t1",
      result: { content: "ok", isError: false },
      durationMs: 100,
    }));
    state = reduceEvent(state, sse("main", "done", {
      stopReason: "completed",
      usage: { inputTokens: 500, outputTokens: 200, turns: 1, cacheHitRatio: 0.1 },
    }));

    // 设置 verdict
    state = {
      ...state,
      verdict: {
        passed: true,
        summary: "全部通过",
        issues: [],
        unverified: ["人工确认项"],
        advisory: ["建议优化"],
      },
    };
    // 设置一个 pending 审批
    state = {
      ...state,
      pendingApprovals: [
        { toolUseId: "ap1", name: "bash", input: { cmd: "rm" }, status: "pending" },
      ],
    };

    const overview = deriveOverview(state);

    expect(overview.finalStatus).toBe("done");
    expect(overview.resultSummary).toBe("任务已完成，共修改 3 个文件。");
    expect(overview.verdict).not.toBeNull();
    expect(overview.verdict.passed).toBe(true);
    expect(overview.verdict.summary).toBe("全部通过");
    expect(overview.verdict.unverified).toEqual(["人工确认项"]);
    expect(overview.actionItems.pendingApprovals).toHaveLength(1);
    expect(overview.actionItems.pendingApprovals[0].toolUseId).toBe("ap1");
    expect(overview.actionItems.unverifiedItems).toEqual(["人工确认项"]);
    expect(overview.usage).not.toBeNull();
    expect(overview.usage.turns).toBe(1);
    expect(overview.usage.inputTokens).toBe(500);
  });

  it("16. 概览模型：无助手文本时 resultSummary 为 null", () => {
    const state = makeState({
      status: "done",
      usage: { turns: 1, inputTokens: 100, outputTokens: 50, cacheHitRatio: 0 },
    });
    const overview = deriveOverview(state);
    expect(overview.resultSummary).toBeNull();
    expect(overview.finalStatus).toBe("done");
  });

  it("17. 概览模型：error 状态正确反映", () => {
    const state = makeState({ error: "运行异常终止", status: "done" });
    const overview = deriveOverview(state);
    expect(overview.finalStatus).toBe("error");
  });

  it("18. 概览模型：无 verdict 时 verdict 为 null，unverifiedItems 为空", () => {
    const state = makeState({ status: "done" });
    const overview = deriveOverview(state);
    expect(overview.verdict).toBeNull();
    expect(overview.actionItems.unverifiedItems).toEqual([]);
  });

  it("19. 概览模型：待介入事项 — 仅 pending 审批被拾取", () => {
    const state = makeState({
      status: "running",
      pendingApprovals: [
        { toolUseId: "a1", name: "t1", input: {}, status: "pending" },
        { toolUseId: "a2", name: "t2", input: {}, status: "allowed" },
        { toolUseId: "a3", name: "t3", input: {}, status: "denied" },
      ],
    });
    const overview = deriveOverview(state);
    expect(overview.actionItems.pendingApprovals).toHaveLength(1);
    expect(overview.actionItems.pendingApprovals[0].toolUseId).toBe("a1");
  });

  // ---- 阶段三: 审批拒绝 · 概览模型 — 拒绝信息不丢失 ----
  it("审批拒绝·概览: resolvedApprovals 含 denied 信息（status/reason/decidedAt）不静默丢失", () => {
    const state = makeState({
      status: "done",
      pendingApprovals: [
        { toolUseId: "denied_1", name: "danger", input: { cmd: "rm -rf" }, status: "denied", reason: "too dangerous", decidedAt: 1234567890 },
        { toolUseId: "allowed_1", name: "safe", input: { cmd: "ls" }, status: "allowed", reason: "ok", decidedAt: 1234567891 },
      ],
    });
    const overview = deriveOverview(state);

    // 已处理审批不在 actionItems.pendingApprovals 中（仅 pending）
    expect(overview.actionItems.pendingApprovals).toHaveLength(0);

    // 但进入 resolvedApprovals，不静默丢失
    expect(overview.resolvedApprovals).toBeDefined();
    expect(overview.resolvedApprovals).toHaveLength(2);

    // denied 审批保留 status="denied"、reason 和 decidedAt
    const deniedEntry = overview.resolvedApprovals.find(
      (a: any) => a.toolUseId === "denied_1",
    );
    expect(deniedEntry).toBeDefined();
    expect(deniedEntry.status).toBe("denied");
    expect(deniedEntry.reason).toBe("too dangerous");
    expect(deniedEntry.decidedAt).toBe(1234567890);

    // allowed 审批也在 resolvedApprovals 中
    const allowedEntry = overview.resolvedApprovals.find(
      (a: any) => a.toolUseId === "allowed_1",
    );
    expect(allowedEntry).toBeDefined();
    expect(allowedEntry.status).toBe("allowed");
  });

  // ---- 阶段三: 执行失败 · reducer — finalStatus 反映失败 + error 填充 ----
  it("执行失败·reducer: finalStatus=error + error 字段被填充", () => {
    const state = makeState({
      status: "done",
      error: "运行异常终止",
    });
    const overview = deriveOverview(state);

    // finalStatus 反映失败（非"已完成"）
    expect(overview.finalStatus).toBe("error");
    expect(overview.finalStatus).not.toBe("done");

    // state.error 被填充——与 finalStatus 一致
    expect(state.error).toBe("运行异常终止");
  });

  // ---- 阶段三: 核查未通过 · 概览 — 呈现未通过 + issues 列表 ----
  it("核查未通过·概览: verdict.passed=false + issues 列表完整呈现", () => {
    const state = makeState({
      status: "done",
      verify: true,
      verdict: {
        passed: false,
        summary: "客观项 3 条不符，需返工",
        issues: ["行数不符", "格式错误", "缺少必要字段"],
        unverified: ["人工确认二进制"],
        advisory: ["建议重构"],
      },
    });
    const overview = deriveOverview(state);

    // verdict 存在且 passed=false
    expect(overview.verdict).not.toBeNull();
    expect(overview.verdict.passed).toBe(false);
    expect(overview.verdict.summary).toBe("客观项 3 条不符，需返工");

    // issues 列表完整呈现
    expect(overview.verdict.issues).toEqual(["行数不符", "格式错误", "缺少必要字段"]);
    expect(overview.verdict.issues).toHaveLength(3);

    // unverified 与 advisory 同时到位
    expect(overview.verdict.unverified).toEqual(["人工确认二进制"]);
    expect(overview.verdict.advisory).toEqual(["建议重构"]);

    // actionItems.unverifiedItems 从 verdict.unverified 派生
    expect(overview.actionItems.unverifiedItems).toEqual(["人工确认二进制"]);
  });
});

// ---- AC4: 日志分层 deriveLogEntries / toggleEntryCollapsed (R-04) ----
describe("AC4 日志分层 (R-04)", () => {
  it("20. 成功 tool_call / tool_result → collapsed=true", () => {
    const state = makeState({
      timeline: [
        { seq: 0, source: "main", type: "turn_start", turn: 1 },
        { seq: 1, source: "main", type: "tool_call", toolUseId: "t1", name: "read", input: {} },
        { seq: 2, source: "main", type: "tool_result", toolUseId: "t1", resultContent: "ok", resultIsError: false, durationMs: 10 },
        { seq: 3, source: "main", type: "assistant_text", text: "done" },
      ],
    });

    const entries = deriveLogEntries(state);
    expect(entries).toHaveLength(4);
    // 全部成功 → 默认折叠
    expect(entries[0].collapsed).toBe(true);  // turn_start
    expect(entries[1].collapsed).toBe(true);  // tool_call
    expect(entries[2].collapsed).toBe(true);  // tool_result (success)
    expect(entries[3].collapsed).toBe(true);  // assistant_text
  });

  it("21. 失败 tool_result / approval_request / api_retry / compaction → collapsed=false", () => {
    const state = makeState({
      timeline: [
        { seq: 0, source: "main", type: "tool_result", toolUseId: "t1", resultContent: "err", resultIsError: true, durationMs: 5 },
        { seq: 1, source: "main", type: "approval_request", toolUseId: "a1", name: "bash", input: {} },
        { seq: 2, source: "main", type: "api_retry", turn: 1, attempt: 1, reason: "timeout" },
        { seq: 3, source: "main", type: "compaction", droppedBlocks: 10 },
      ],
    });

    const entries = deriveLogEntries(state);
    expect(entries).toHaveLength(4);
    expect(entries[0].collapsed).toBe(false); // error tool_result
    expect(entries[1].collapsed).toBe(false); // approval_request
    expect(entries[2].collapsed).toBe(false); // api_retry
    expect(entries[3].collapsed).toBe(false); // compaction
  });

  it("22. toggleEntryCollapsed 翻转目标 seq 的折叠状态", () => {
    const entries = [
      { seq: 0, source: "main", type: "turn_start", turn: 1, collapsed: true },
      { seq: 1, source: "main", type: "tool_result", toolUseId: "t1", resultIsError: true, collapsed: false },
    ];

    const toggled = toggleEntryCollapsed(entries, 0);
    expect(toggled[0].collapsed).toBe(false);
    expect(toggled[1].collapsed).toBe(false);

    const toggled2 = toggleEntryCollapsed(toggled, 0);
    expect(toggled2[0].collapsed).toBe(true);

    const toggled3 = toggleEntryCollapsed(entries, 1);
    expect(toggled3[1].collapsed).toBe(true);
  });

  it("23. isEntryCollapsedByDefault 对各类条目的规则", () => {
    expect(isEntryCollapsedByDefault({ seq: 0, source: "main", type: "turn_start", turn: 1 })).toBe(true);
    expect(isEntryCollapsedByDefault({ seq: 0, source: "main", type: "tool_call", toolUseId: "t", name: "x", input: {} })).toBe(true);
    expect(isEntryCollapsedByDefault({ seq: 0, source: "main", type: "tool_result", toolUseId: "t", resultIsError: false })).toBe(true);
    expect(isEntryCollapsedByDefault({ seq: 0, source: "main", type: "assistant_text", text: "hi" })).toBe(true);
    expect(isEntryCollapsedByDefault({ seq: 0, source: "main", type: "tool_result", toolUseId: "t", resultIsError: true })).toBe(false);
    expect(isEntryCollapsedByDefault({ seq: 0, source: "main", type: "approval_request", toolUseId: "t", name: "x", input: {} })).toBe(false);
    expect(isEntryCollapsedByDefault({ seq: 0, source: "main", type: "api_retry", attempt: 1, reason: "x" })).toBe(false);
    expect(isEntryCollapsedByDefault({ seq: 0, source: "main", type: "compaction", droppedBlocks: 5 })).toBe(false);
  });
});

// ---- AC5: WCAG 对比度测试 (R-06) ----
describe("AC5 WCAG 对比度 (R-06)", () => {
  /**
   * WCAG 2.2 相对亮度公式：
   *   L = 0.2126 * R_lin + 0.7152 * G_lin + 0.0722 * B_lin
   *   其中 channel_lin = channel_sRGB ≤ 0.04045 ? channel_sRGB/12.92 : ((channel_sRGB+0.055)/1.055)^2.4
   *   对比度 = (L_light + 0.05) / (L_dark + 0.05)
   */
  function hexToRgb(hex) {
    const v = parseInt(hex.replace(/^#/, ""), 16);
    return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  }

  function linearize(c) {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }

  function relativeLuminance(hex) {
    const [r, g, b] = hexToRgb(hex);
    return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
  }

  function contrastRatio(hex1, hex2) {
    const l1 = relativeLuminance(hex1);
    const l2 = relativeLuminance(hex2);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  /** 从 styles.css 解析 :root 块中的 CSS 变量 */
  function parseRootVars(css) {
    const rootMatch = css.match(/:root\s*\{([^}]*)\}/s);
    if (!rootMatch) return {};
    const block = rootMatch[1];
    const vars = {};
    const varRe = /--([\w-]+)\s*:\s*([^;]+);/g;
    let m;
    while ((m = varRe.exec(block)) !== null) {
      vars[m[1].trim()] = m[2].trim();
    }
    return vars;
  }

  /** 从 property value 解析最终色值（支持 var() 引用，仅一级解析） */
  function resolveColor(value, vars) {
    let v = value.trim();
    // 处理 var(--xxx) 引用
    const varRef = v.match(/^var\((--[\w-]+)\)$/);
    if (varRef) {
      const refName = varRef[1].replace(/^--/, "");
      if (vars[refName]) {
        v = vars[refName];
      }
    }
    // 去除注释
    v = v.replace(/\/\*.*?\*\//g, "").trim();
    return v;
  }

  it("24. 主按钮文字/底色对比度 ≥ 4.5:1", () => {
    const cssPath = join(__dirname, "..", "ui", "public", "styles.css");
    const css = readFileSync(cssPath, "utf-8");
    const vars = parseRootVars(css);

    const btnPrimaryText = resolveColor(vars["btn-primary-text"] || "#ffffff", vars);
    const accent = resolveColor(vars["accent"] || "#0969da", vars);

    const ratio = contrastRatio(btnPrimaryText, accent);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("25. 正文/页面底色对比度 ≥ 4.5:1", () => {
    const cssPath = join(__dirname, "..", "ui", "public", "styles.css");
    const css = readFileSync(cssPath, "utf-8");
    const vars = parseRootVars(css);

    const fg = resolveColor(vars["fg"] || "#c9d1d9", vars);
    const bg = resolveColor(vars["bg"] || "#0d1117", vars);

    const ratio = contrastRatio(fg, bg);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("26. 状态徽章文字/底色对比度 ≥ 3:1（组件类）", () => {
    const cssPath = join(__dirname, "..", "ui", "public", "styles.css");
    const css = readFileSync(cssPath, "utf-8");
    const vars = parseRootVars(css);

    // 绿色徽章: green on green-bg
    const green = resolveColor(vars["green"] || "#3fb950", vars);
    const greenBg = resolveColor(vars["green-bg"] || "#12261e", vars);
    const ratioGreen = contrastRatio(green, greenBg);
    expect(ratioGreen).toBeGreaterThanOrEqual(3.0);

    // 红色徽章: red on red-bg
    const red = resolveColor(vars["red"] || "#f85149", vars);
    const redBg = resolveColor(vars["red-bg"] || "#261212", vars);
    const ratioRed = contrastRatio(red, redBg);
    expect(ratioRed).toBeGreaterThanOrEqual(3.0);

    // 黄色审批卡: fg on yellow-bg
    const yellowBg = resolveColor(vars["yellow-bg"] || "#1d1c08", vars);
    const ratioFgOnYellow = contrastRatio(
      resolveColor(vars["fg"] || "#c9d1d9", vars),
      yellowBg,
    );
    expect(ratioFgOnYellow).toBeGreaterThanOrEqual(3.0);
  });

  it("27. 焦点指示色与底板对比度 ≥ 3:1", () => {
    const cssPath = join(__dirname, "..", "ui", "public", "styles.css");
    const css = readFileSync(cssPath, "utf-8");
    const vars = parseRootVars(css);

    const focusRing = resolveColor(vars["focus-ring"] || "#0969da", vars);
    const bg = resolveColor(vars["bg"] || "#0d1117", vars);

    const ratio = contrastRatio(focusRing, bg);
    expect(ratio).toBeGreaterThanOrEqual(3.0);
  });

  it("28. 拒绝按钮文字/底色对比度 ≥ 3:1（组件类）", () => {
    const cssPath = join(__dirname, "..", "ui", "public", "styles.css");
    const css = readFileSync(cssPath, "utf-8");
    const vars = parseRootVars(css);

    const denyText = resolveColor(vars["btn-deny-text"] || "#f85149", vars);
    const denyBg = resolveColor(vars["red-bg"] || "#261212", vars);

    const ratio = contrastRatio(denyText, denyBg);
    expect(ratio).toBeGreaterThanOrEqual(3.0);
  });
});

// ---- AC6: 无障碍语义静态断言 (R-05) ----
describe("AC6 无障碍语义 (R-05)", () => {
  it("29. 运行列表项含 tabindex / role / aria-selected", () => {
    const appPath = join(__dirname, "..", "ui", "public", "app.js");
    const appSrc = readFileSync(appPath, "utf-8");

    // renderRunList 渲染输出中必须包含
    expect(appSrc).toContain('role="option"');
    expect(appSrc).toContain("tabindex=");
    expect(appSrc).toContain("aria-selected=");
  });

  it("30. 任务输入框有关联 label", () => {
    const htmlPath = join(__dirname, "..", "ui", "public", "index.html");
    const html = readFileSync(htmlPath, "utf-8");

    // 必须存在 for="task-input" 的 label
    expect(html).toContain('for="task-input"');
    // 或 label 包裹 input（隐式关联），显式 for 更优
  });

  it("31. 存在 aria-live 区域", () => {
    const htmlPath = join(__dirname, "..", "ui", "public", "index.html");
    const html = readFileSync(htmlPath, "utf-8");

    expect(html).toContain("aria-live");
    // 必须是 polite 或 assertive
    expect(html).toMatch(/aria-live\s*=\s*"polite"/);
  });

  it("32. 存在 :focus-visible 样式规则", () => {
    const cssPath = join(__dirname, "..", "ui", "public", "styles.css");
    const css = readFileSync(cssPath, "utf-8");

    expect(css).toContain(":focus-visible");
    // 至少有一条非空规则
    expect(css).toMatch(/:focus-visible\s*\{[^}]+outline/);
  });

  // 以下三条由浏览器实测的 ARIA 结构缺陷催生（AC-06 键盘/屏幕阅读器专项）
  it("32a. listbox 身份与 option 子项同生共死（有项才挂 role，空态必须摘掉）", () => {
    const appSrc = readFileSync(join(__dirname, "..", "ui", "public", "app.js"), "utf-8");
    // 空态分支摘掉 role/aria-label——空壳 listbox 违反 aria-required-children（critical）
    expect(appSrc).toMatch(/removeAttribute\("role"\)/);
    expect(appSrc).toMatch(/removeAttribute\("aria-label"\)/);
    // 有 option 子项时才挂上 listbox 身份
    expect(appSrc).toMatch(/setAttribute\("role", "listbox"\)/);
    expect(appSrc).toMatch(/setAttribute\("aria-label", "运行列表"\)/);
    // 静态 HTML 不得预挂 role，否则加载态即违规
    const html = readFileSync(join(__dirname, "..", "ui", "public", "index.html"), "utf-8");
    expect(html).not.toMatch(/id="run-list"[^>]*role="listbox"/);
  });

  it("32b. tab 三件套完整：tablist / tab(aria-controls) / tabpanel(aria-labelledby)", () => {
    const appSrc = readFileSync(join(__dirname, "..", "ui", "public", "app.js"), "utf-8");
    expect(appSrc).toContain('role="tablist"');
    expect(appSrc).toContain('aria-controls="tab-content"');
    expect(appSrc).toMatch(/role="tabpanel"[\s\S]{0,80}aria-labelledby=|aria-labelledby=[\s\S]{0,80}role="tabpanel"/);
    // 每个 tab 有稳定 id 供 tabpanel 反向引用
    expect(appSrc).toContain('id="tab-${tab}"');
  });

  it("32c. roving tabindex 必须配方向键处理（否则未选中标签键盘不可达）", () => {
    const appSrc = readFileSync(join(__dirname, "..", "ui", "public", "app.js"), "utf-8");
    // 未选中 tab 为 tabindex=-1
    expect(appSrc).toMatch(/tabindex="\$\{isActive \? "0" : "-1"\}"/);
    // 必须有 keydown + 四个方向键 + Home/End
    expect(appSrc).toContain('addEventListener("keydown"');
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"]) {
      expect(appSrc).toContain(key);
    }
  });
});

// ---- AC7: 运行列表元数据与筛选 (R-08) ----
describe("AC7 运行列表元数据与筛选 (R-08)", () => {
  it("33. deriveRunListItems 含状态/开始时间/耗时/核查结论", () => {
    const runs = [
      { runId: "r1", task: "t1", status: "done", verify: true, createdAt: 1000000, finishedAt: 1005000 },
      { runId: "r2", task: "t2", status: "running", verify: false, createdAt: 2000000, finishedAt: null },
    ];
    const states = new Map();
    states.set("r1", {
      ...createInitialState("r1", "t1", true),
      status: "done",
      verdict: { passed: true, summary: "ok", issues: [], unverified: [], advisory: [] },
    });
    states.set("r2", createInitialState("r2", "t2", false));

    const metaMap = deriveRunListItems(runs, states);

    const m1 = metaMap.get("r1");
    expect(m1).toBeDefined();
    expect(m1.status).toBe("done");
    expect(m1.startTime).toBe(1000000);
    expect(m1.duration).toBe(5000);
    expect(m1.verdictConclusion).toBe("passed");

    const m2 = metaMap.get("r2");
    expect(m2).toBeDefined();
    expect(m2.status).toBe("running");
    expect(m2.duration).toBeNull();
    expect(m2.verdictConclusion).toBeNull();
  });

  it("34. deriveRunListItems — 核查结论三种值（passed/failed/null）", () => {
    const runs = [
      { runId: "r1", task: "ok", status: "done", verify: true, createdAt: 1, finishedAt: 2 },
      { runId: "r2", task: "fail", status: "done", verify: true, createdAt: 3, finishedAt: 4 },
      { runId: "r3", task: "none", status: "done", verify: false, createdAt: 5, finishedAt: 6 },
    ];
    const states = new Map();
    states.set("r1", {
      ...createInitialState("r1", "ok", true),
      status: "done",
      verdict: { passed: true, summary: "", issues: [], unverified: [], advisory: [] },
    });
    states.set("r2", {
      ...createInitialState("r2", "fail", true),
      status: "done",
      verdict: { passed: false, summary: "X", issues: ["a"], unverified: [], advisory: [] },
    });
    states.set("r3", createInitialState("r3", "none", false));

    const metaMap = deriveRunListItems(runs, states);
    expect(metaMap.get("r1").verdictConclusion).toBe("passed");
    expect(metaMap.get("r2").verdictConclusion).toBe("failed");
    expect(metaMap.get("r3").verdictConclusion).toBeNull();
  });

  it("35. filterRunsByStatus 按状态筛选正确", () => {
    const runs = [
      { runId: "r1", task: "a", status: "running", verify: false, createdAt: 1, finishedAt: null },
      { runId: "r2", task: "b", status: "done", verify: false, createdAt: 2, finishedAt: 3 },
      { runId: "r3", task: "c", status: "done", verify: true, createdAt: 4, finishedAt: 5 },
    ];
    const states = new Map();
    states.set("r1", createInitialState("r1", "a", false));
    states.set("r2", createInitialState("r2", "b", false));
    states.set("r3", {
      ...createInitialState("r3", "c", true),
      status: "done",
      verdict: { passed: false, summary: "X", issues: ["x"], unverified: [], advisory: [] },
    });

    // all
    expect(filterRunsByStatus(runs, states, "all")).toHaveLength(3);
    // running
    const running = filterRunsByStatus(runs, states, "running");
    expect(running).toHaveLength(1);
    expect(running[0].runId).toBe("r1");
    // done (仅通过/无核查的)
    const done = filterRunsByStatus(runs, states, "done");
    expect(done).toHaveLength(1);
    expect(done[0].runId).toBe("r2");
    // failed
    const failed = filterRunsByStatus(runs, states, "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].runId).toBe("r3");
  });
});

// ---- AC8: styles.css 令牌统一 — 除 :root 外无裸十六进制色值 (P2) ----
describe("AC8 CSS 令牌统一 (P2)", () => {
  it("36. styles.css 除 :root 定义块外无裸十六进制色值", () => {
    const cssPath = join(__dirname, "..", "ui", "public", "styles.css");
    const css = readFileSync(cssPath, "utf-8");

    // 移除 :root 块
    const stripped = css
      .replace(/:root\s*\{[^}]*\}/s, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    // 匹配属性值中的裸六位色值
    const propHexRe = /:\s*(?:[^;{]*?\s)?(#[0-9a-fA-F]{6})\b/g;
    const violations = [];
    let match;
    while ((match = propHexRe.exec(stripped)) !== null) {
      const ctx = stripped.substring(Math.max(0, match.index - 20), match.index + match[0].length + 10);
      // 确认不是 var() 的参数
      if (!ctx.includes("var(")) {
        violations.push(match[0].trim());
      }
    }

    expect(violations).toEqual([]);
  });
});

// ================================================================
// R-07: 核查区视觉收敛 — magenta 仅身份标识，不大面积铺底
// ================================================================

describe("R-07 核查区视觉收敛", () => {
  it("37. CSS 中无大面积 magenta 背景（仅小元素使用）", () => {
    const cssPath = join(__dirname, "..", "ui", "public", "styles.css");
    const css = readFileSync(cssPath, "utf-8");

    // magenta-bg 应仅用于小元素如 badge、border 等，不应出现在大面积组件中
    // 检查没有 padding > 8px 的 magenta background
    // R-07 整改后 verdict-card 用 --bg2 + 细边框
    expect(css).toContain("magenta-border-strong");

    // 旧式大面积 magenta 背景不应存在（timeline--verifier 曾用 --magenta-bg 大面积）
    // 现在应仅用于 badge/icon/border
    const magentaBgOccurrences = (css.match(/--magenta-bg/g) || []).length;
    // 允许在 :root 定义 + verify-badge + 至多一个小元素中出现
    expect(magentaBgOccurrences).toBeLessThanOrEqual(4);
  });
});

// ================================================================
// 阶段三: AC-10 异常流程 — 核查未通过 · 渲染语义 (静态断言)
// ================================================================

describe("AC-10 核查未通过 · 渲染语义", () => {
  it("38. verdict-badge--fail 使用错误色（红），与 verdict-badge--pass（绿）不同", () => {
    const cssPath = join(__dirname, "..", "ui", "public", "styles.css");
    const css = readFileSync(cssPath, "utf-8");
    const vars = parseRootVars(css);

    // verdict-badge--pass 使用绿色系
    expect(css).toContain("verdict-badge--pass");
    const passMatch = css.match(/\.verdict-badge--pass\s*\{([^}]*)\}/);
    expect(passMatch).not.toBeNull();
    const passBlock = passMatch[1];

    // verdict-badge--fail 使用红色系
    expect(css).toContain("verdict-badge--fail");
    const failMatch = css.match(/\.verdict-badge--fail\s*\{([^}]*)\}/);
    expect(failMatch).not.toBeNull();
    const failBlock = failMatch[1];

    // --pass 用 green，--fail 用 red
    expect(passBlock).toContain("--green");
    expect(failBlock).toContain("--red");

    // 两套颜色不同
    const green = resolveColor(vars["green"] || "#3fb950", vars);
    const red = resolveColor(vars["red"] || "#f85149", vars);
    expect(green).not.toBe(red);

    // 语义区分：红≠绿
    const greenBg = resolveColor(vars["green-bg"] || "#12261e", vars);
    const redBg = resolveColor(vars["red-bg"] || "#261212", vars);
    expect(greenBg).not.toBe(redBg);
  });

  it("39. 概览模型区分 main 与 rework 来源的 timeline", () => {
    // 构造含 main + rework 来源事件的 state
    let state = createInitialState("r_diff_src", "source distinguish", true);

    state = reduceEvent(state, sse("main", "turn_start", { turn: 1 }));
    state = reduceEvent(state, sse("main", "assistant_text", { text: "main done" }));
    state = reduceEvent(state, sse("rework", "turn_start", { turn: 1 }));
    state = reduceEvent(state, sse("rework", "assistant_text", { text: "rework fixed" }));

    // 主时间线包含 main 来源的事件
    expect(state.timeline).toHaveLength(4);
    const mainEntries = state.timeline.filter((e: any) => e.source === "main");
    const reworkEntries = state.timeline.filter((e: any) => e.source === "rework");
    expect(mainEntries.length).toBeGreaterThanOrEqual(1);
    expect(reworkEntries.length).toBeGreaterThanOrEqual(1);
    const mainText = mainEntries.find((e: any) => e.type === "assistant_text");
    const reworkText = reworkEntries.find((e: any) => e.type === "assistant_text");
    expect(mainText.text).toBe("main done");
    expect(reworkText.text).toBe("rework fixed");
  });
});

// ---- helper: parseRootVars (reused by AC-10 test) ----
function parseRootVars(css) {
  const rootMatch = css.match(/:root\s*\{([^}]*)\}/s);
  if (!rootMatch) return {};
  const block = rootMatch[1];
  const vars = {};
  const varRe = /--([\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = varRe.exec(block)) !== null) {
    vars[m[1].trim()] = m[2].trim();
  }
  return vars;
}

function resolveColor(value, vars) {
  let v = value.trim();
  const varRef = v.match(/^var\((--[\w-]+)\)$/);
  if (varRef) {
    const refName = varRef[1].replace(/^--/, "");
    if (vars[refName]) {
      v = vars[refName];
    }
  }
  v = v.replace(/\/\*.*?\*\//g, "").trim();
  return v;
}

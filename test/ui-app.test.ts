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
  reduceEvents,
  classifyStopReason,
  deriveContextUsage,
  markApprovalResolved,
  expirePendingApprovals,
  deriveOverview,
  deriveLogEntries,
  toggleEntryCollapsed,
  isEntryCollapsedByDefault,
  deriveRunListItems,
  filterRunsByStatus,
} from "../ui/public/app.js";
import { plannedStopReason } from "../src/orchestrate.js";
import { STOP_REASONS } from "../src/types.js";
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
    // 文案随控件位置更新：提交栏已移到底部，"创建新任务"那句指的按钮不在原处了。
    // 闸门盯的是**空态必须说清下一步怎么做**，不是盯某个具体字符串。
    expect(appSrc).toContain("选择左侧运行查看详情，或在下面写一个新任务。");
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
// v2 / R1：段终止 vs run 终止、审批审计、stopReason 分档、幂等
// ================================================================

/** 带显式 seq 的事件构造器（真实 SSE 的 seq 单调递增，幂等闸门依赖它） */
function seqSse(seq, source, type, extra = {}) {
  return { seq, source, event: { type, ...extra } };
}

describe("v2 R1 · 段终止 ≠ run 终止 (V-01)", () => {
  it("核查模式下主轮 done 不终止 run —— 返工轮的审批仍可操作", () => {
    let state = createInitialState("rw1", "rework task", true);
    let n = 0;

    state = reduceEvents(state, [
      seqSse(n++, "main", "turn_start", { turn: 1 }),
      seqSse(n++, "main", "assistant_text", { text: "首轮交付" }),
      seqSse(n++, "main", "done", {
        stopReason: "completed",
        usage: { inputTokens: 10, outputTokens: 5, turns: 1, cacheHitRatio: 0 },
      }),
    ]);

    // 旧实现在这里就把 run 置成 done 了 —— 这是死锁的起点
    expect(state.status).toBe("running");

    // 核查未通过 → 返工轮请求审批
    state = reduceEvents(state, [
      seqSse(n++, "verifier", "verdict", {
        verdict: { passed: false, issues: ["缺收尾"], summary: "未通过" },
      }),
      seqSse(n++, "rework", "turn_start", { turn: 1 }),
      seqSse(n++, "rework", "approval_request", {
        toolUseId: "tu_fix",
        name: "write_file",
        input: { path: "a.txt" },
      }),
    ]);

    // 关键断言：返工轮的审批处于 pending 且 run 仍在运行 —— 两者同时成立，
    // 渲染层的 operable = isPending && isRunning 才为真，按钮才会出现
    expect(state.status).toBe("running");
    expect(state.pendingApprovals).toHaveLength(1);
    expect(state.pendingApprovals[0].status).toBe("pending");

    // 只有 run_end 才收敛
    state = reduceEvents(state, [
      seqSse(n++, "host", "run_end", {
        outcome: "completed",
        mainStopReason: "completed",
        finishedAt: 1785980000000,
      }),
    ]);
    expect(state.status).toBe("done");
    expect(state.pendingApprovals[0].status).toBe("expired");
    expect(state.runEnd.outcome).toBe("completed");
  });

  it("非核查运行只有一段：done 即终止（单段快路径）", () => {
    let state = createInitialState("p1", "plain", false);
    state = reduceEvents(state, [
      seqSse(0, "main", "approval_request", { toolUseId: "t", name: "x", input: {} }),
      seqSse(1, "main", "done", { stopReason: "completed", usage: null }),
    ]);
    expect(state.status).toBe("done");
    expect(state.pendingApprovals[0].status).toBe("expired");
  });
});

describe("v2 R1 · 审批审计 (V-02/V-03)", () => {
  it("approval_resolved 按 requestSeq 落卡，含决策/理由/主体/时间", () => {
    let state = createInitialState("a1", "audit", false);
    state = reduceEvents(state, [
      seqSse(3, "main", "approval_request", { toolUseId: "tu_x", name: "bash", input: {} }),
      seqSse(4, "host", "approval_resolved", {
        requestSeq: 3,
        toolUseId: "tu_x",
        decision: "deny",
        reason: "路径不在白名单",
        actor: "user",
        at: 1785980000000,
      }),
    ]);
    const a = state.pendingApprovals[0];
    expect(a.status).toBe("denied");
    expect(a.reason).toBe("路径不在白名单");
    expect(a.decidedAt).toBe(1785980000000);
    expect(a.approvalId).toBe("tu_x#3");
  });

  it("同一 toolUseId 跨返工轮不串卡：应答第二轮不改写第一轮的记录", () => {
    let state = createInitialState("a2", "cross round", true);
    state = reduceEvents(state, [
      // 第一轮：同一个 toolUseId，已允许
      seqSse(1, "main", "approval_request", { toolUseId: "tu_same", name: "write_file", input: {} }),
      seqSse(2, "host", "approval_resolved", {
        requestSeq: 1, toolUseId: "tu_same", decision: "allow", actor: "user", at: 1,
      }),
      // 第二轮（返工）：同一个 toolUseId 再次出现
      seqSse(5, "rework", "approval_request", { toolUseId: "tu_same", name: "write_file", input: {} }),
      seqSse(6, "host", "approval_resolved", {
        requestSeq: 5, toolUseId: "tu_same", decision: "deny", reason: "这轮不行", actor: "user", at: 2,
      }),
    ]);

    expect(state.pendingApprovals).toHaveLength(2);
    // 旧实现按 toolUseId 全量匹配，两张卡会被同一次点击一起改写
    expect(state.pendingApprovals[0].status).toBe("allowed");
    expect(state.pendingApprovals[0].reason).toBeUndefined();
    expect(state.pendingApprovals[1].status).toBe("denied");
    expect(state.pendingApprovals[1].reason).toBe("这轮不行");
  });

  it("approval_expired 只作用于仍 pending 的卡，已决策的保持原样", () => {
    let state = createInitialState("a3", "expiry", true);
    state = reduceEvents(state, [
      seqSse(1, "main", "approval_request", { toolUseId: "t1", name: "a", input: {} }),
      seqSse(2, "host", "approval_resolved", { requestSeq: 1, toolUseId: "t1", decision: "allow", at: 1 }),
      seqSse(3, "main", "approval_request", { toolUseId: "t2", name: "b", input: {} }),
      seqSse(4, "host", "approval_expired", { requestSeq: 3, toolUseId: "t2", cause: "run_finished" }),
    ]);
    expect(state.pendingApprovals[0].status).toBe("allowed");
    expect(state.pendingApprovals[1].status).toBe("expired");
  });

  it("markApprovalResolved 用裸 toolUseId 时只命中最新挂起卡", () => {
    let state = createInitialState("a4", "bare ref", true);
    state = reduceEvents(state, [
      seqSse(1, "main", "approval_request", { toolUseId: "dup", name: "a", input: {} }),
      seqSse(2, "host", "approval_resolved", { requestSeq: 1, toolUseId: "dup", decision: "allow", at: 1 }),
      seqSse(5, "rework", "approval_request", { toolUseId: "dup", name: "a", input: {} }),
    ]);
    state = markApprovalResolved(state, "dup", "denied", "第二轮拒绝");
    expect(state.pendingApprovals[0].status).toBe("allowed");
    expect(state.pendingApprovals[1].status).toBe("denied");
  });
});

describe("v2 R1 · stopReason 六值分档 (V-04)", () => {
  it("六种终止原因各有色调、人话标签与补救提示", () => {
    expect(classifyStopReason("completed").tone).toBe("ok");
    expect(classifyStopReason("max_tokens").tone).toBe("warn");
    expect(classifyStopReason("max_tokens").hint).toContain("AGENT_MAX_TOKENS");
    // max_turns / error 是 verifier 救不了的两类，界面必须直说
    expect(classifyStopReason("max_turns").tone).toBe("bad");
    expect(classifyStopReason("max_turns").hint).toContain("核查救不了");
    expect(classifyStopReason("budget_exhausted").tone).toBe("bad");
    expect(classifyStopReason("refusal").tone).toBe("bad");
    expect(classifyStopReason("error").tone).toBe("bad");
    // 运行中（尚无 stopReason）
    expect(classifyStopReason(null).label).toBe("运行中");
  });

  it("四种非 completed 的非 error 终止不再被当作成功", () => {
    for (const r of ["max_turns", "budget_exhausted", "refusal", "max_tokens"]) {
      let s = createInitialState(`s_${r}`, "t", false);
      s = reduceEvents(s, [seqSse(0, "main", "done", { stopReason: r, usage: null })]);
      expect(s.stopReason).toBe(r);
      // 旧实现只判 error，这四种一律绿色"已完成"
      expect(classifyStopReason(s.stopReason).tone).not.toBe("ok");
    }
  });

  // B1 口径锁的编排半边：宿主写进台账/run_end 的编排 stopReason 必须是本函数
  // 认识的具名值。未知值会落 default 分支（label 原样回显输入），具名值的
  // label 是人话——靠这一点检出"自造新词"或对象串化（"[object Object]"）。
  it("编排收尾的 stopReason 必须是 classifyStopReason 的具名值", () => {
    for (const completed of [true, false]) {
      const v = plannedStopReason({ completed });
      expect(classifyStopReason(v).label).not.toBe(v);
    }
  });

  it("done 携带的真实 error.message 被透出，而非写死的一句话", () => {
    let s = createInitialState("e1", "t", false);
    s = reduceEvents(s, [
      seqSse(0, "main", "done", {
        stopReason: "error",
        error: { name: "Error", message: "上游端点 502" },
        usage: null,
      }),
    ]);
    expect(s.error).toBe("上游端点 502");
  });
});

/**
 * B1 · 终止原因三处口径一致锁。
 *
 * 曾经 docs 列 5 值、types 列 7 值、classifyStopReason 判 9 个具名值，三处都在
 * 被引用——谁引到哪一处就得到哪个答案。事实源收敛为 src/types.ts 的
 * STOP_REASONS：加新值先加那里，下面三条测试逼着另外两处逐值跟上。
 */
describe("B1 · 终止原因三处口径一致锁", () => {
  it("classifyStopReason 的具名 case 与 STOP_REASONS 逐值一致（不多不少）", () => {
    const src = readFileSync(join(__dirname, "../ui/public/app.js"), "utf8");
    const start = src.indexOf("function classifyStopReason");
    const body = src.slice(start, src.indexOf("export function", start + 1));
    const cases = [...body.matchAll(/case "([^"]+)":/g)].map((m) => m[1]).sort();
    expect(cases).toEqual([...STOP_REASONS].sort());
  });

  it("每个具名值都有非默认分档——default 的 label 是原样回显，具名值的是人话", () => {
    for (const v of STOP_REASONS) expect(classifyStopReason(v).label).not.toBe(v);
  });

  it("docs/03-interfaces.md 提到每一个具名值（要求带引号或反引号，防裸词误中）", () => {
    const doc = readFileSync(join(__dirname, "../docs/03-interfaces.md"), "utf8");
    for (const v of STOP_REASONS) {
      expect(doc, `docs/03-interfaces.md 缺 ${v}`).toMatch(new RegExp(`["\`]${v}["\`]`));
    }
  });
});

describe("v2 R1 · 重放幂等与批量等价 (V-05)", () => {
  it("同一批事件重放两次，状态深相等（重连续传安全）", () => {
    const events = [
      seqSse(0, "main", "turn_start", { turn: 1 }),
      seqSse(1, "main", "tool_call", { toolUseId: "t1", name: "read", input: {} }),
      seqSse(2, "main", "tool_result", { toolUseId: "t1", result: { content: "ok" }, durationMs: 3 }),
      seqSse(3, "main", "approval_request", { toolUseId: "t2", name: "write", input: {} }),
    ];
    const base = createInitialState("i1", "idem", true);
    const once = reduceEvents(base, events);
    const twice = reduceEvents(once, events);
    expect(twice).toEqual(once);
    // turn_start / tool_call / tool_result / approval_request 各一条，重放不翻倍
    expect(twice.timeline).toHaveLength(4);
    expect(twice.pendingApprovals).toHaveLength(1);
  });

  it("批量折叠与逐条折叠等价", () => {
    const events = [
      seqSse(0, "main", "turn_start", { turn: 1 }),
      seqSse(1, "main", "assistant_text", { text: "hi" }),
      seqSse(2, "main", "compaction", { droppedBlocks: 4 }),
    ];
    const base = createInitialState("i2", "equiv", false);
    const batched = reduceEvents(base, events);
    let stepwise = base;
    for (const e of events) stepwise = reduceEvents(stepwise, [e]);
    expect(batched).toEqual(stepwise);
  });

  it("乱序/落后的 seq 被丢弃，不产生重复条目", () => {
    let s = createInitialState("i3", "ooo", false);
    s = reduceEvents(s, [seqSse(5, "main", "turn_start", { turn: 1 })]);
    s = reduceEvents(s, [seqSse(3, "main", "turn_start", { turn: 99 })]);
    expect(s.timeline).toHaveLength(1);
    expect(s.lastSeq).toBe(5);
  });
});

describe("v2 R2 · 上下文水位与成本口径 (V-07/V-09)", () => {
  const usageEvt = (seq, turn, input, cw, cr, out) =>
    seqSse(seq, "main", "usage", {
      turn,
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: cw,
        cache_read_input_tokens: cr,
        output_tokens: out,
      },
    });

  it("usage 事件不再是噪声行，进 usageByTurn 而不进时间线", () => {
    let s = createInitialState("u1", "t", false);
    s = reduceEvents(s, [
      seqSse(0, "main", "turn_start", { turn: 1 }),
      usageEvt(1, 1, 1000, 200, 300, 50),
    ]);
    expect(s.timeline).toHaveLength(1); // 只有 turn_start
    expect(s.usageByTurn).toHaveLength(1);
    expect(s.usageByTurn[0]).toEqual({ turn: 1, input: 1000, cacheCreation: 200, cacheRead: 300, output: 50 });
  });

  it("水位口径 = 最近一轮输入 / 上限，不是全 run 累计", () => {
    let s = createInitialState("u2", "t", false);
    s = reduceEvents(s, [
      usageEvt(0, 1, 1000, 0, 0, 10),
      usageEvt(1, 2, 2000, 0, 0, 10),
      usageEvt(2, 3, 3000, 0, 0, 10),
    ]);
    const ctx = deriveContextUsage(s, 10000);
    // 最近一轮 3000/10000 = 0.3。若按累计（6000）算会是 0.6——
    // ContextManager.noteUsage 是赋值不是累加，按累计画会得到"永远即将压缩"的假警报
    expect(ctx.lastInputTokens).toBe(3000);
    expect(ctx.ratio).toBeCloseTo(0.3, 5);
    expect(ctx.watermark).toBe(0.8);
    // 累计另算，归成本口径
    expect(ctx.cumulative.input).toBe(6000);
  });

  it("缓存命中率按三分口径计算", () => {
    let s = createInitialState("u3", "t", false);
    s = reduceEvents(s, [usageEvt(0, 1, 100, 100, 800, 10)]);
    const ctx = deriveContextUsage(s, null);
    // cacheRead / (input + cacheCreation + cacheRead) = 800/1000
    expect(ctx.cacheHitRatio).toBeCloseTo(0.8, 5);
    expect(ctx.limit).toBeNull();
    expect(ctx.ratio).toBeNull();
  });

  it("run_end 带来 executionUsage / reworks / finalPassed", () => {
    let s = createInitialState("u4", "t", true);
    s = reduceEvents(s, [
      seqSse(0, "main", "done", { stopReason: "completed", usage: { turns: 2, inputTokens: 10, outputTokens: 5, cacheHitRatio: 0 } }),
      seqSse(1, "host", "run_end", {
        outcome: "completed",
        mainStopReason: "completed",
        finishedAt: 1,
        finalPassed: true,
        reworks: 1,
        executionUsage: { turns: 5, inputTokens: 900, outputTokens: 300, cacheCreationTokens: 0, cacheReadTokens: 100 },
        verificationUsage: { turns: 3, inputTokens: 400, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0 },
      }),
    ]);
    // 段级 usage 仍是 2 轮，但 run 级成本是 5 轮——旧实现把前者当后者用
    expect(s.usage.turns).toBe(2);
    expect(s.runEnd.executionUsage.turns).toBe(5);
    expect(s.runEnd.verificationUsage.turns).toBe(3);
    expect(s.runEnd.reworks).toBe(1);
    expect(s.runEnd.finalPassed).toBe(true);
  });
});

describe("v2 R2 · 逐轮裁决与工具名回填 (V-08/V-12)", () => {
  it("verification 事件逐轮入账，中间轮的 issues 不再丢失", () => {
    let s = createInitialState("v1", "t", true);
    s = reduceEvents(s, [
      seqSse(0, "verifier", "verification", {
        round: 0,
        verdict: { passed: false, issues: ["漏了收尾"], summary: "未通过" },
      }),
      seqSse(1, "verifier", "verification", {
        round: 1,
        verdict: { passed: true, issues: [], unverified: ["需人工看"], summary: "通过" },
      }),
    ]);
    expect(s.verifications).toHaveLength(2);
    expect(s.verifications[0].verdict.issues).toEqual(["漏了收尾"]);
    expect(s.verifications[1].verdict.unverified).toEqual(["需人工看"]);
  });

  it("tool_result 回填工具名，不再显示 toolUseId", () => {
    let s = createInitialState("v2", "t", false);
    s = reduceEvents(s, [
      seqSse(0, "main", "tool_call", { toolUseId: "toolu_01Ab", name: "read_file", input: {} }),
      seqSse(1, "main", "tool_result", { toolUseId: "toolu_01Ab", result: { content: "ok" }, durationMs: 3 }),
    ]);
    const result = s.timeline.find((e) => e.type === "tool_result");
    expect(result.name).toBe("read_file");
  });

  it("verifier 与主 agent 的工具名各自回填，来源不混", () => {
    let s = createInitialState("v3", "t", true);
    s = reduceEvents(s, [
      seqSse(0, "main", "tool_call", { toolUseId: "m1", name: "write_file", input: {} }),
      seqSse(1, "verifier", "tool_call", { toolUseId: "v1", name: "read_file", input: {} }),
      seqSse(2, "verifier", "tool_result", { toolUseId: "v1", result: { content: "x" }, durationMs: 1 }),
      seqSse(3, "main", "tool_result", { toolUseId: "m1", result: { content: "y" }, durationMs: 2 }),
    ]);
    expect(s.timeline.find((e) => e.type === "tool_result").name).toBe("write_file");
    expect(s.verifierTimeline.find((e) => e.type === "tool_result").name).toBe("read_file");
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
    expect(combined).toContain("选择左侧运行查看详情，或在下面写一个新任务。");

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
    // 核查模式（verify=true）下主轮的 done 只是**一段**结束，后面还有核查段、
    // 可能还有返工段——run 级终止由 run_end 宣告。这里补上它，事件流才是完整协议。
    // （旧实现把段终止当 run 终止，正是返工轮审批永久挂死的根因，见 V-01）
    state = reduceEvent(state, sse("host", "run_end", {
      outcome: "completed",
      mainStopReason: "completed",
      finishedAt: 1785980000000,
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

  /**
   * 括号配平扫描：抓出所有主题定义块。
   *
   * 旧实现用 /:root\s*\{([^}]*)\}/s，只抓第一个 :root 且 [^}] 不跨嵌套——
   * @media 内的 :root 一个都抓不到。双主题落地后这个解析器必须先升级，
   * 否则整套对比度门禁会在"只看了浅色"的情况下全绿。
   */
  function extractBlocks(css) {
    // 先把注释替换成等长空白：既避免注释里的花括号干扰配平，
    // 又保住字符索引，后面"剔除主题块再扫剩余部分"才不会错位
    const blank = css.replace(/\/\*[\s\S]*?\*\//g, (c) => " ".repeat(c.length));
    const blocks = [];
    const selRe = /(?:^|[{};])\s*([^{};@]*?:root[^{};]*?)\{/g;
    let m;
    while ((m = selRe.exec(blank)) !== null) {
      const selector = m[1].trim();
      let depth = 1;
      let i = selRe.lastIndex;
      while (i < blank.length && depth > 0) {
        if (blank[i] === "{") depth++;
        else if (blank[i] === "}") depth--;
        i++;
      }
      blocks.push({ selector, body: css.slice(selRe.lastIndex, i - 1), start: m.index, end: i });
    }
    return blocks;
  }

  function parseDecls(body) {
    const vars = {};
    const varRe = /--([\w-]+)\s*:\s*([^;]+);/g;
    let m;
    while ((m = varRe.exec(body)) !== null) vars[m[1].trim()] = m[2].trim();
    return vars;
  }

  /**
   * 解析出两套主题的最终变量表。
   * 浅色 = 顶层 :root；深色 = 顶层 :root ⊕ [data-theme="dark"] 覆盖。
   * 深色只重定义 Layer 1 原始色板，语义层靠 var() 自动跟随——这正是分层的意义。
   */
  function parseThemes(css) {
    const blocks = extractBlocks(css);
    const base = blocks.find((b) => b.selector === ":root");
    if (!base) throw new Error("styles.css 缺少顶层 :root 块");
    const light = parseDecls(base.body);
    const darkBlock = blocks.find((b) => b.selector.includes('[data-theme="dark"]'));
    if (!darkBlock) throw new Error('styles.css 缺少 [data-theme="dark"] 块');
    return { light, dark: { ...light, ...parseDecls(darkBlock.body) }, blocks };
  }

  /** 顺着 var() 链一路解析到字面色值（分层后引用深度可达三层） */
  function resolveColor(value, vars, depth = 0) {
    let v = String(value).replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const ref = v.match(/^var\(\s*(--[\w-]+)\s*\)$/);
    if (ref && depth < 8) {
      const name = ref[1].replace(/^--/, "");
      if (vars[name] !== undefined) return resolveColor(vars[name], vars, depth + 1);
    }
    return v;
  }

  const THEMES = ["light", "dark"];

  /** 每套主题都要过的色对清单：[标签, 前景令牌, 背景令牌, 最低比值] */
  const PAIRS = [
    ["正文 / 页面底", "text-1", "surface-0", 4.5],
    ["正文 / 抬升面", "text-1", "surface-1", 4.5],
    ["正文 / 下沉面", "text-1", "surface-2", 4.5],
    ["次要文字 / 页面底", "text-2", "surface-0", 4.5],
    ["次要文字 / 抬升面", "text-2", "surface-1", 4.5],
    ["三级文字 / 页面底", "text-3", "surface-0", 4.5],
    // 下面两行是 AC2-18 复验补的。缺了它们时表面 46 条全绿，而页面上
    // .approvals-done（折叠摘要行 + 列表项）实际只有 4.23:1——
    // 覆盖表漏一行，门禁就只是看起来严
    ["三级文字 / 抬升面", "text-3", "surface-1", 4.5],
    ["三级文字 / 下沉面", "text-3", "surface-2", 4.5],
    ["次要文字 / 下沉面", "text-2", "surface-2", 4.5],
    ["主按钮文字 / 强调底", "on-accent", "accent", 4.5],
    ["强调色 / 页面底", "accent", "surface-0", 4.5],
    ["通过色 / 页面底", "status-ok", "surface-0", 4.5],
    ["警告色 / 页面底", "status-warn", "surface-0", 4.5],
    ["错误色 / 页面底", "status-bad", "surface-0", 4.5],
    ["verifier 身份色 / 页面底", "identity-verifier", "surface-0", 4.5],
    ["通过色 / 通过底", "status-ok", "status-ok-surface", 3.0],
    ["警告色 / 警告底", "status-warn", "status-warn-surface", 3.0],
    ["错误色 / 错误底", "status-bad", "status-bad-surface", 3.0],
    ["信息色 / 信息底", "status-info", "status-info-surface", 3.0],
    ["verifier 身份色 / 其底", "identity-verifier", "identity-verifier-surface", 3.0],
    ["不可逆色 / 其底", "irreversible", "irreversible-surface", 3.0],
    ["焦点环 / 页面底", "focus", "surface-0", 3.0],
    ["焦点环 / 抬升面", "focus", "surface-1", 3.0],
    ["正文 / 警告底（审批卡）", "text-1", "status-warn-surface", 4.5],
    ["正文 / 错误底", "text-1", "status-bad-surface", 4.5],
    ["正文 / 通过底", "text-1", "status-ok-surface", 4.5],
  ];

  // 24-28 合并升级为「两套主题 × 全部色对」——断言面积从 5 条扩到 46 条。
  // 门禁只准加强不准削弱：旧版覆盖的五组色对全部包含在 PAIRS 里。
  describe.each(THEMES)("%s 主题", (theme) => {
    const css = readFileSync(join(__dirname, "..", "ui", "public", "styles.css"), "utf-8");
    const vars = parseThemes(css)[theme];

    it.each(PAIRS)("%s ≥ %s:1", (label, fgToken, bgToken, min) => {
      const fg = resolveColor(vars[fgToken], vars);
      const bg = resolveColor(vars[bgToken], vars);
      expect(fg, `${theme} 主题缺少令牌 --${fgToken}`).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(bg, `${theme} 主题缺少令牌 --${bgToken}`).toMatch(/^#[0-9a-fA-F]{6}$/);
      const ratio = contrastRatio(fg, bg);
      expect(ratio, `${label}：${fg} on ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(min);
    });
  });

  it("两套主题定义的原始色板令牌名集合完全一致", () => {
    const css = readFileSync(join(__dirname, "..", "ui", "public", "styles.css"), "utf-8");
    const { blocks } = parseThemes(css);
    const base = blocks.find((b) => b.selector === ":root");
    const dark = blocks.find((b) => b.selector.includes('[data-theme="dark"]'));
    const raw = (o) => Object.keys(o).filter((k) => k.startsWith("p-")).sort();
    // 浅色漏定义某个 --p-*，深色就会静默沿用浅色值——这是双主题最难肉眼发现的 bug
    expect(raw(parseDecls(dark.body))).toEqual(raw(parseDecls(base.body)));
  });

  it("媒体查询暗色块与手动暗色块逐字段一致（防漂移）", () => {
    const css = readFileSync(join(__dirname, "..", "ui", "public", "styles.css"), "utf-8");
    const { blocks } = parseThemes(css);
    // 零构建下这段值无法复用，只能写两遍；写两遍就必须有东西盯着它们不分家
    const darkBlocks = blocks.filter(
      (b) => b.selector.includes('[data-theme="dark"]') || b.selector.includes(':not([data-theme="light"])'),
    );
    expect(darkBlocks.length).toBe(2);
    expect(parseDecls(darkBlocks[0].body)).toEqual(parseDecls(darkBlocks[1].body));
  });

  it("组件层不得直接引用 Layer 1 原始色板", () => {
    const css = readFileSync(join(__dirname, "..", "ui", "public", "styles.css"), "utf-8");
    const { blocks } = parseThemes(css);
    let outside = css;
    for (const b of [...blocks].sort((a, z) => z.start - a.start)) {
      outside = outside.slice(0, b.start) + outside.slice(b.end);
    }
    // --p-* 是主题块的私有词汇；组件直接用它就绕过了语义层，换主题时会漏改
    const leaks = outside.match(/var\(\s*--p-[\w-]+/g) ?? [];
    expect(leaks).toEqual([]);
  });
});

// ---- AC6: 无障碍语义静态断言 (R-05) ----
describe("AC6 无障碍语义 (R-05)", () => {
  // 29 已升级为真实 DOM 断言，见 test/ui-a11y.test.ts 的
  // 「运行列表项的 role / tabindex / aria-selected 在真实 DOM 上成立」。
  //
  // 原因与 s3d 的教训同源：这里原本是扫 app.js 源码找 `role="option"` 字面量。
  // 渲染层改为 setAttribute 之后字面量消失，但语义反而更完整（选中态会随
  // aria-selected 实时更新）。字符串断言既抓不住父子契约，也抓不住动态属性——
  // 换成在渲染结果上查真实节点，是加强不是削弱。

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

  // 32b 已升级为真实 DOM 断言，见 test/ui-a11y.test.ts 的
  // 「tab 三件套在真实 DOM 上闭环，且 aria-labelledby 随选中项更新」。
  //
  // 渲染层改为分区补丁后，aria-labelledby 由 setAttribute 动态写入，源码里不再有
  // 字面量。而 DOM 断言能多守住一件字符串扫描永远看不见的事：**切换标签后
  // tabpanel 的反向引用有没有跟着换**——引用一旦悬空，屏幕阅读器就报不出面板名。
  // 32b / 32c 已全部升级为真实 DOM 断言，见 test/ui-a11y.test.ts 的
  // 「tab 三件套在真实 DOM 上闭环」「roving tabindex」「方向键在四个面之间移动」。
  //
  // 触发原因：四张因子卡合并成了 tablist，renderTabButton 随之删除，源码里
  // 不再有 `aria-controls="tab-content"` / `tabindex="${isActive…}"` 这类字面量。
  // DOM 断言能多守住两件字符串扫描看不见的事：tabpanel 的反向引用不悬空，
  // 以及方向键真的能在四个面之间循环——后者正是 s3d 那条「只加 roving 不加
  // 方向键比不改更糟」的教训所指。

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
  it("36. styles.css 除主题定义块外无裸十六进制色值", () => {
    const cssPath = join(__dirname, "..", "ui", "public", "styles.css");
    const css = readFileSync(cssPath, "utf-8");

    // 双主题落地后不能只剔除第一个 :root：暗色块也是合法的色值出处。
    // 用括号配平剔除**全部**含 :root 的块（顶层、@media 内、[data-theme] 覆盖），
    // 再扫剩余部分——这样断言仍是"组件层零裸色值"，覆盖面反而扩大了。
    const blank = css.replace(/\/\*[\s\S]*?\*\//g, (c) => " ".repeat(c.length));
    const ranges = [];
    const selRe = /(?:^|[{};])\s*([^{};@]*?:root[^{};]*?)\{/g;
    let sm;
    while ((sm = selRe.exec(blank)) !== null) {
      let depth = 1;
      let i = selRe.lastIndex;
      while (i < blank.length && depth > 0) {
        if (blank[i] === "{") depth++;
        else if (blank[i] === "}") depth--;
        i++;
      }
      ranges.push([sm.index, i]);
    }
    let stripped = blank;
    for (const [a, b] of ranges.sort((x, y) => y[0] - x[0])) {
      stripped = stripped.slice(0, a) + stripped.slice(b);
    }

    /**
     * 逐**声明**扫，而不是拿一条正则在整段文本上滑窗。
     *
     * AC2-18 复验用四组探针实测，旧写法有三个洞（注入后门禁仍返回空）：
     *   ① 三位简写 `#fff` —— 只匹配 {6} 位，整类漏过；
     *   ② 八位带 alpha `#ff0000cc` —— 同上；
     *   ③ 同一条声明里出现过 `var()` 就整条跳过（那个 20 字符上下文窗口），
     *      而 box-shadow / linear-gradient 恰恰是硬编码色值最常见的落点，
     *      本表里就有两条 box-shadow。
     * 也就是说，旧的绿只说明"没人用最朴素的写法写死颜色"。
     */
    const violations: string[] = [];
    for (const decl of stripped.split(/[;{}]/)) {
      const colonAt = decl.indexOf(":");
      if (colonAt < 0) continue;
      const prop = decl.slice(0, colonAt).trim();
      if (prop.startsWith("--")) continue; // 令牌定义（:root 已剥离，这里是防媒体块里的覆盖）
      for (const m of decl.slice(colonAt + 1).matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        // # 后只有 3/4/6/8 位才是合法色值，其余是别的东西（如 url 片段）
        if ([4, 5, 7, 9].includes(m[0].length)) violations.push(`${prop}: …${m[0]}`);
      }
    }

    expect(violations, `组件层出现裸色值：${violations.join(" | ")}`).toEqual([]);
  });
});

// ================================================================
// v2 R5: 字体阶梯与字号下限 (V-20)
// ================================================================

describe("V-20 字体阶梯", () => {
  const css = readFileSync(join(__dirname, "..", "ui", "public", "styles.css"), "utf-8");

  it("全表无小于 12px 的字号——辅助信息的硬下限", () => {
    // 委托方报告 §11 自己写的建议是辅助 ≥12px / 正文 ≥14px，s3 三轮都没做。
    // 这条同时守两处：令牌定义与散落的硬编码 font-size。
    const sizes = [...css.matchAll(/font-size:\s*(\d+)px/g)].map((m) => Number(m[1]));
    const tokens = [...css.matchAll(/--font-[\w-]+:\s*(\d+)px/g)].map((m) => Number(m[1]));
    const tooSmall = [...sizes, ...tokens].filter((n) => n < 12);
    expect(tooSmall, `低于 12px 的字号: ${tooSmall.join(", ")}`).toEqual([]);
  });

  it("正文与卡片正文 ≥ 14px", () => {
    const m = css.match(/--font-lg:\s*(\d+)px/);
    expect(Number(m[1])).toBeGreaterThanOrEqual(14);
    // body 显式设正文号，避免继承到浏览器默认的 16px 之外的值
    expect(css).toMatch(/body\s*\{[\s\S]*?font-size:\s*var\(--font-lg\)/);
  });

  it("三套字体栈各有 ≥3 级回退且以通用族收尾", () => {
    // 不赌宿主环境（C3）：衬线依赖 Noto Serif SC，它缺席时必须还有得降级
    for (const token of ["font-display", "font-ui", "font-mono"]) {
      const m = css.match(new RegExp(`--${token}:\s*([^;]+);`));
      expect(m, `缺少 --${token}`).not.toBeNull();
      const stack = m[1].split(",").map((x) => x.trim());
      expect(stack.length, `--${token} 回退级数不足`).toBeGreaterThanOrEqual(3);
      expect(["serif", "sans-serif", "monospace"]).toContain(stack[stack.length - 1]);
    }
  });

  it("衬线只用于大字号标题，不铺到正文", () => {
    // 中文衬线在小字号下可读性差；真降级到系统宋体时，影响面必须限于几处标题
    const displayUse = [...css.matchAll(/font-family:\s*var\(--font-display\)/g)];
    expect(displayUse.length).toBeGreaterThan(0);

    // 注意作用域：`[\s\S]*?` 会跨出 body 块一路匹配到后面的标题规则，
    // 所以必须先切出 body 的花括号体再查（初稿正是这么写错的，假阳性）
    const bodyBlock = css.match(/(^|\})\s*body\s*\{([^}]*)\}/);
    expect(bodyBlock, "styles.css 缺少 body 规则").not.toBeNull();
    expect(bodyBlock[2]).toMatch(/font-family:\s*var\(--font-ui\)/);
    expect(bodyBlock[2]).not.toMatch(/--font-display/);
  });
});

// ================================================================
// v2 R5b: 单色排印符 + hidden 真隐藏 (V-20 补)
// ================================================================

describe("V-20 图标：单色排印符，不用 emoji", () => {
  /**
   * 判据用 Unicode 的 Emoji_Presentation 属性，而不是手列黑名单。
   *
   * 该属性的定义就是"默认渲染为彩色 emoji"——而这正是问题所在：
   * 彩色字形自带调色板，CSS `color` 对它们无效，因此**无法参与主题系统**，
   * 在浅色暖底上尤其像贴上去的异物。反过来，✓ ✗ ⚠ ◈ ⋯ 这些是文本表现字形，
   * 继承 currentColor，明暗两套主题下都跟着语义色走。
   * U+FE0F（变体选择符）会把文本字形强制成 emoji 表现，一并拦掉。
   */
  const EMOJI = /\p{Emoji_Presentation}|️/gu;

  it.each(["app.js", "index.html", "styles.css"])("%s 不含 emoji 字形", (file) => {
    const src = readFileSync(join(__dirname, "..", "ui", "public", file), "utf-8");
    const hits = [...src.matchAll(EMOJI)].map((m) => {
      const at = src.slice(Math.max(0, m.index - 30), m.index + 20).replace(/\s+/g, " ");
      return `${m[0]} @ …${at}…`;
    });
    expect(hits, `发现 emoji：${hits.join(" / ")}`).toEqual([]);
  });

  it("CLI 的记号在 Web 侧同样在场（终端与网页看到同一套符号）", () => {
    const app = readFileSync(join(__dirname, "..", "ui", "public", "app.js"), "utf-8");
    // 对齐 src/cli.ts:512-591 的符号表
    for (const mark of ["──", "→", "✓", "✗", "⚠", "⟳", "■", "✔", "✘", "⋯", "◈", "↺"]) {
      expect(app, `缺少记号 ${mark}`).toContain(mark);
    }
  });
});

describe("V-24b 提交栏布局：整行子项必须能换行", () => {
  const css = readFileSync(join(__dirname, "..", "ui", "public", "styles.css"), "utf-8");

  /**
   * 实测抓到的 bug：装配面板是 flex-basis:100% 的整行子项，而 .submit-bar 在
   * 桌面态没有 flex-wrap（只有窄屏媒体查询里写了）。结果它和输入框挤在同一行，
   * 把 textarea 压成一条几像素宽的缝——委托方截图里那个"不知道是什么"的小方块。
   */
  it(".submit-bar 在桌面态就有 flex-wrap，不只靠窄屏媒体查询", () => {
    const block = css.match(/(^|\})\s*\.submit-bar\s*\{([^}]*)\}/);
    expect(block, "缺少 .submit-bar 规则").not.toBeNull();
    expect(block![2]).toMatch(/flex-wrap:\s*wrap/);
  });

  it("整行子项确实声明了 flex-basis:100%（换行的前提）", () => {
    expect(css).toMatch(/\.run-knobs\s*\{[^}]*flex-basis:\s*100%/);
  });

  it("任务输入框有最小宽度，压不成一条缝", () => {
    const rule = css.match(/\.submit-bar\s+textarea\s*\{([^}]*)\}/);
    expect(rule, "缺少 .submit-bar textarea 规则").not.toBeNull();
    const min = rule![1].match(/min-width:\s*(\d+)px/);
    expect(min, "未设 min-width").not.toBeNull();
    expect(Number(min![1])).toBeGreaterThanOrEqual(160);
  });
});

describe("V-20 hidden 必须真的隐藏", () => {
  const css = readFileSync(join(__dirname, "..", "ui", "public", "styles.css"), "utf-8");

  /**
   * 实测抓到的 bug：一个已经异常终止的运行仍挂着绿点显示"等待模型响应…"。
   * 根因是 UA 样式表的 `[hidden]{display:none}` 优先级极低，被
   * `.live-strip{display:flex}` 这类作者规则压过。渲染层用 hidden 属性
   * 控显隐的分区里有好几个都设了 display，所以这是一类系统性问题，
   * 不是单点疏忽——用一条全局 !important 从结构上消灭它。
   */
  it("存在全局 [hidden] 覆盖且带 !important", () => {
    expect(css).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  });

  it("渲染层用 hidden 控显隐的分区，全部有全局覆盖兜底", () => {
    const app = readFileSync(join(__dirname, "..", "ui", "public", "app.js"), "utf-8");
    // 这些分区在 app.js 里靠 setAttr(..., "hidden", ...) 切换；
    // 只要其中任何一个的 CSS 里写了 display，没有全局 !important 就会失效
    const toggled = ["action-rail", "live-strip", "approval-cards", "usage-footer", "unverified-rail"];
    for (const cls of toggled) {
      expect(app, `${cls} 应由渲染层管理显隐`).toContain(cls);
    }
    expect(css).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  });
});

// ================================================================
// R-07: 核查区视觉收敛 — magenta 仅身份标识，不大面积铺底
// ================================================================

/**
 * CSS 变量的引用完整性。
 *
 * 实测抓到的：`var(--fg-dim)` 被引用了四处，而这个变量从来没定义过。
 * 后果不是报错而是**静默失效**——`var()` 引用未定义变量时该声明在计算值阶段
 * 作废，颜色回退成继承值，看起来"就是没生效"，改半天找不到原因。
 * 变量名是手写字符串，拼错/改名漏改是必然会再发生的，所以用一条全量扫描锁住。
 */
/**
 * 合并之后旧的追加框骨架必须**彻底消失**。
 *
 * 留一份在页面上就意味着两个输入框、两个 role="alert"、两处 duplicate id——
 * 而且这类残迹不会报错，只会让人在错误的框里打字。
 */
describe("统一 composer：旧追加框不许回潮", () => {
  it("index.html / app.js / styles.css 里都不再出现 followup", () => {
    const dir = join(__dirname, "..", "ui", "public");
    for (const f of ["index.html", "app.js", "styles.css"]) {
      expect(readFileSync(join(dir, f), "utf-8"), `${f} 残留旧追加框`).not.toContain("followup");
    }
  });

  it("底栏说明行独占一行——底栏是 flex-wrap，不给 100% 它会挤进控件行", () => {
    const css = readFileSync(join(__dirname, "..", "ui", "public", "styles.css"), "utf-8");
    expect(css).toMatch(/\.composer-note\s*\{[^}]*flex-basis:\s*100%/);
  });

  /**
   * 本次把「禁用而不是隐藏」当成两个模式的主要可见承载。而此前整份样式表里
   * 一条 :disabled 都没有，.btn 还无条件写了 cursor:pointer——禁用的按钮
   * 长得、摸上去都和能点的一模一样。那样的"可见"是在骗人。
   */
  it("禁用态有可见样式（否则「禁用而不是隐藏」这条纪律是空的）", () => {
    const css = readFileSync(join(__dirname, "..", "ui", "public", "styles.css"), "utf-8");
    expect(css).toMatch(/\.btn:disabled/);
    expect(css).toMatch(/:disabled[^{]*\{[^}]*cursor:\s*not-allowed/);
  });
});

describe("CSS 变量：引用的必须定义过", () => {
  it("styles.css 里每个 var(--x) 都能在同文件找到定义", () => {
    const css = readFileSync(join(__dirname, "..", "ui", "public", "styles.css"), "utf-8");
    const used = new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
    const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const missing = [...used].filter((v) => !defined.has(v));
    expect(missing, `引用了未定义的 CSS 变量：${missing.join(", ")}`).toEqual([]);
  });
});

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
    // 不给兜底默认值：令牌被整条删掉时必须红，而不是拿一个写死的颜色顶上
    // （旧版 `vars["green"] || "#3fb950"` 让"令牌不存在"这一态也能通过）
    const green = resolveColor(vars["green"], vars);
    const red = resolveColor(vars["red"], vars);
    expect(green, "--green 未定义").toMatch(/^#[0-9a-fA-F]{3,8}$/);
    expect(red, "--red 未定义").toMatch(/^#[0-9a-fA-F]{3,8}$/);
    expect(green).not.toBe(red);

    // 语义区分：红≠绿（比的必须是解析到底的**字面色值**，不是令牌名）
    const greenBg = resolveColor(vars["green-bg"], vars);
    const redBg = resolveColor(vars["red-bg"], vars);
    expect(greenBg).toMatch(/^#[0-9a-fA-F]{3,8}$/);
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

/**
 * 顺 var() 链**一路**解析到字面色值。
 *
 * 旧版只跳一层，而令牌是三层（--green → --status-ok → --p-ok → #2F6F43）。
 * 于是「绿≠红」这类断言比的是**令牌名字符串**（"var(--p-ok)" vs "var(--p-bad)"），
 * 把 --p-ok 改成红色照样绿——AC2-18 复验实测确认这四条断言不可证伪。
 */
function resolveColor(value, vars, depth = 0) {
  const v = String(value).replace(/\/\*[\s\S]*?\*\//g, "").trim();
  const ref = v.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (ref && depth < 8) {
    const name = ref[1].replace(/^--/, "");
    if (vars[name] !== undefined) return resolveColor(vars[name], vars, depth + 1);
  }
  return v;
}

/**
 * AC2-18 真机复验抓到的：Tab 到任务输入框，`:focus-visible` 命中，
 * 计算出来的 outline 却是 `none`——`.submit-bar textarea:focus` 比全局
 * `:focus-visible` 更具体，把焦点环压掉了，只剩 1px 边框换个色。
 * 对键盘用户来说这就是"焦点看不见"，AC-05 不通过。
 *
 * 换边框色本身没错，错的是**顺手把环也关了**。要去环只能对鼠标聚焦去
 * （`:focus:not(:focus-visible)`）。
 */
describe("AC-05 焦点环不许被组件规则压掉", () => {
  it("任何在 :focus 上写 outline:none 的规则，都必须限定 :not(:focus-visible)", () => {
    const css = readFileSync(join(__dirname, "..", "ui", "public", "styles.css"), "utf-8");
    const offenders: string[] = [];
    // 先把 @media 之类的开括号去掉，否则 `[^}]*` 会吞掉嵌套内容导致规则错位——
    // 把 outline:none 写进任何媒体块即可绕过这道门（复验实测的次生洞）
    const flat = css.replace(/@[a-z-]+[^{]*\{/gi, "");
    // 逐条规则扫：选择器带 :focus 且声明里关了 outline
    for (const m of flat.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const sel = m[1].trim();
      const body = m[2];
      if (!/:focus\b/.test(sel)) continue;
      if (!/outline\s*:\s*(none|0)\b/.test(body)) continue;
      if (/:not\(\s*:focus-visible\s*\)/.test(sel)) continue; // 只对鼠标聚焦去环，合法
      offenders.push(sel);
    }
    expect(offenders, `这些规则会让键盘焦点看不见：${offenders.join(" | ")}`).toEqual([]);
  });

  it("全局 :focus-visible 规则仍在，且真的画了一个环", () => {
    const css = readFileSync(join(__dirname, "..", "ui", "public", "styles.css"), "utf-8");
    // 选择器必须整行独占（前面只能是行首/注释结尾/上一条规则的 }），
    // 否则会匹配到 `.foo :focus-visible` 这类后代选择器，测的就不是全局那条了
    const rule = css.match(/(?:^|\}|\*\/)\s*:focus-visible\s*\{([^}]*)\}/);
    expect(rule, "全局 :focus-visible 规则不见了").not.toBeNull();
    expect(rule![1]).toMatch(/outline:\s*\d+px\s+solid/);
  });
});

/**
 * AC2-11 的落点锁。
 *
 * 真机量化的结论是"帧的钱花在布局上，不在脚本上"——所以守护它的东西不是
 * 一条 JS 断言，而是这条 CSS。删掉它，1400 条日志之后每帧就掉出 16ms 预算。
 * jsdom 不做布局，这里只能守住"规则还在、且用的是 auto 不是 hidden"。
 */
describe("AC2-11 长日志的单帧预算靠 content-visibility 守住", () => {
  const css = readFileSync(join(__dirname, "..", "ui", "public", "styles.css"), "utf-8");

  it(".log-entry 上有 content-visibility:auto + contain-intrinsic-size", () => {
    const rule = css.match(/(?:^|\})\s*\.log-entry\s*\{([\s\S]*?)\}/);
    expect(rule, ".log-entry 规则不见了").not.toBeNull();
    expect(rule![1]).toMatch(/content-visibility:\s*auto/);
    expect(rule![1]).toMatch(/contain-intrinsic-size:\s*auto\s+\d+px/);
  });

  it("不许用 content-visibility:hidden——那会把内容从可访问性树里摘掉", () => {
    expect(css).not.toMatch(/content-visibility:\s*hidden/);
  });
});

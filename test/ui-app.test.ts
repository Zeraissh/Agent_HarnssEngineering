// @ts-nocheck
/**
 * ui/public/app.js — reducer 纯函数测试（node 环境，不依赖 DOM）。
 *
 * AC3 覆盖:
 *   1. 时间线折叠（turn_start → tool_call → tool_result 顺序、event 字段投射）
 *   2. text_delta 忽略
 *   3. source=verifier 事件归入核查面板模型（verifierTimeline）
 *   4. 审批卡生命周期（出现→标记已处理）
 *   5. verdict 三值卡模型（issues/unverified/advisory 各自到位）
 *   6. done 事件的 usage 脚注提取
 */
import { describe, expect, it } from "vitest";
import { createInitialState, reduceEvent, markApprovalResolved } from "../ui/public/app.js";

// ---- helpers ----

function sse(source, type, extra = {}) {
  return { seq: 0, source, event: { type, ...extra } };
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

    // 时间线有 3 条
    expect(state.timeline).toHaveLength(3);

    // turn_start
    expect(state.timeline[0].type).toBe("turn_start");
    expect(state.timeline[0].turn).toBe(1);

    // tool_call
    expect(state.timeline[1].type).toBe("tool_call");
    expect(state.timeline[1].toolUseId).toBe("tu_1");
    expect(state.timeline[1].name).toBe("bash");
    expect(state.timeline[1].input).toEqual({ cmd: "ls" });

    // tool_result
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

    // text_delta 不应出现在时间线中
    const types = state.timeline.map((e) => e.type);
    expect(types).not.toContain("text_delta");
    // 只有 turn_start 和 assistant_text
    expect(state.timeline).toHaveLength(2);
    expect(types).toEqual(["turn_start", "assistant_text"]);
  });

  // ---- AC3-3: verifier 事件归入核查面板 ----
  it("3. source=verifier 事件归入 verifierTimeline", () => {
    let state = createInitialState("r3", "verify task", true);

    // main 事件
    state = reduceEvent(state, sse("main", "turn_start", { turn: 1 }));
    state = reduceEvent(state, sse("main", "assistant_text", { text: "main output" }));

    // verifier 事件
    state = reduceEvent(state, sse("verifier", "turn_start", { turn: 1 }));
    state = reduceEvent(state, sse("verifier", "tool_call", { toolUseId: "vt_1", name: "read_file", input: {} }));
    state = reduceEvent(state, sse("verifier", "tool_result", {
      toolUseId: "vt_1",
      result: { content: "verified", isError: false },
      durationMs: 10,
    }));

    // 主时间线只有 main 事件
    expect(state.timeline).toHaveLength(2);
    expect(state.timeline[0].source).toBe("main");
    expect(state.timeline[1].source).toBe("main");

    // verifierTimeline 有 verifier 事件
    expect(state.verifierTimeline).toHaveLength(3);
    expect(state.verifierTimeline[0].source).toBe("verifier");
    expect(state.verifierTimeline[1].source).toBe("verifier");
    expect(state.verifierTimeline[2].source).toBe("verifier");
    expect(state.verifierTimeline[0].type).toBe("turn_start");
    expect(state.verifierTimeline[1].type).toBe("tool_call");
    expect(state.verifierTimeline[2].type).toBe("tool_result");
  });

  // ---- AC3-4: 审批卡生命周期 ----
  it("4. 审批卡生命周期: 出现 → 标记已处理", () => {
    let state = createInitialState("r4", "approval task", false);

    // 审批请求出现
    state = reduceEvent(state, sse("main", "approval_request", {
      toolUseId: "tu_approve",
      name: "write_file",
      input: { path: "/etc/hosts", content: "evil" },
    }));

    // 挂起审批列表有 1 条
    expect(state.pendingApprovals).toHaveLength(1);
    expect(state.pendingApprovals[0].toolUseId).toBe("tu_approve");
    expect(state.pendingApprovals[0].name).toBe("write_file");
    expect(state.pendingApprovals[0].status).toBe("pending");
    expect(state.pendingApprovals[0].input).toEqual({ path: "/etc/hosts", content: "evil" });

    // 主时间线也有审批事件
    const tlTypes = state.timeline.map((e) => e.type);
    expect(tlTypes).toContain("approval_request");

    // 标记为 allowed
    state = markApprovalResolved(state, "tu_approve", "allowed");
    expect(state.pendingApprovals[0].status).toBe("allowed");

    // 另一个场景: deny
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

    // status 变为 done
    expect(state.status).toBe("done");
    // 无 error
    expect(state.error).toBeNull();

    // usage 提取
    expect(state.usage).not.toBeNull();
    expect(state.usage.turns).toBe(3);
    expect(state.usage.inputTokens).toBe(1500);
    expect(state.usage.outputTokens).toBe(800);
    expect(state.usage.cacheHitRatio).toBe(0.15);
  });

  // ---- 额外: verifier approval 不进 pendingApprovals（F2 前端侧） ----
  it("7. verifier 审批: 不进 pendingApprovals（仅进 verifierTimeline）", () => {
    let state = createInitialState("r7", "verify with approval", true);

    state = reduceEvent(state, sse("verifier", "approval_request", {
      toolUseId: "vtu_check",
      name: "bash",
      input: { cmd: "ls" },
    }));

    // 不进 pendingApprovals
    expect(state.pendingApprovals).toHaveLength(0);

    // 但进 verifierTimeline
    const vTypes = state.verifierTimeline.map((e) => e.type);
    expect(vTypes).toContain("approval_request");
    expect(state.verifierTimeline[0].toolUseId).toBe("vtu_check");
  });

  // ---- 额外: error stopReason 标记 ----
  it("8. done 事件 error stopReason 产生 error 标记", () => {
    let state = createInitialState("r8", "error task", false);

    state = reduceEvent(state, sse("main", "done", {
      stopReason: "error",
      usage: { inputTokens: 0, outputTokens: 0, turns: 0, cacheHitRatio: 0 },
    }));

    expect(state.status).toBe("done");
    expect(state.error).toBe("运行异常终止");
  });

  // ---- 额外: api_retry 和 compaction 黄色提示条 ----
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
});

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
 *
 * 阶段一新增:
 *   7. verifier 审批不进 pendingApprovals（F2 前端侧）
 *   8. done 事件 error stopReason 产生 error 标记
 *   9. api_retry 和 compaction 进入时间线
 *   10. R-01: done 事件将 pending 审批转为 expired
 *   11. R-01: markApprovalResolved 设置 decidedAt 时间戳（只读记录模型）
 *   12. R-01: 状态一致性 — list/header/approval 均从同一 state 字段派生
 *   13. R-01: expirePendingApprovals 独立函数
 *   14. AC7 文案 — renderEmptyState 区分空列表/未选中
 */
import { describe, expect, it } from "vitest";
import {
  createInitialState,
  reduceEvent,
  markApprovalResolved,
  expirePendingApprovals,
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

  // ---- 7. verifier approval 不进 pendingApprovals（F2 前端侧） ----
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

  // ================================================================
  // 阶段一 新增测试
  // ================================================================

  // ---- 10. R-01: done 事件将 pending 审批转为 expired ----
  it("10. R-01: done 事件将 pending 审批转为 expired", () => {
    let state = createInitialState("r10", "approval then done", false);

    // 添加一个 pending 审批
    state = reduceEvent(state, sse("main", "approval_request", {
      toolUseId: "tu_expire",
      name: "bash",
      input: { cmd: "rm" },
    }));

    expect(state.pendingApprovals).toHaveLength(1);
    expect(state.pendingApprovals[0].status).toBe("pending");

    // 发送 done 事件
    state = reduceEvent(state, sse("main", "done", {
      stopReason: "completed",
      usage: { inputTokens: 100, outputTokens: 50, turns: 1, cacheHitRatio: 0 },
    }));

    // pending 审批变为 expired
    expect(state.pendingApprovals).toHaveLength(1);
    expect(state.pendingApprovals[0].status).toBe("expired");
    // run status 变为 done
    expect(state.status).toBe("done");
  });

  // ---- 11. R-01: markApprovalResolved 设置 decidedAt 时间戳（只读记录模型） ----
  it("11. R-01: markApprovalResolved 设置 decidedAt 时间戳（只读记录模型）", () => {
    let state = createInitialState("r11", "approval record", false);

    state = reduceEvent(state, sse("main", "approval_request", {
      toolUseId: "tu_rec",
      name: "write_file",
      input: { path: "/f" },
    }));

    const beforeMark = Date.now();

    // 允许
    state = markApprovalResolved(state, "tu_rec", "allowed", "ok");
    expect(state.pendingApprovals[0].status).toBe("allowed");
    expect(state.pendingApprovals[0].reason).toBe("ok");
    expect(state.pendingApprovals[0].decidedAt).toBeTypeOf("number");
    expect(state.pendingApprovals[0].decidedAt).toBeGreaterThanOrEqual(beforeMark);

    // 拒绝场景
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

  // ---- 12. R-01: 状态一致性 — list/header/approval 均从同一 state 字段派生 ----
  it("12. R-01: 状态一致性 — status/pendingApprovals 来自同一 state 源", () => {
    // 此测试验证 reducer 返回的 state 对象中，status 与 pendingApprovals
    // 是同一数据源的不同字段，渲染层直接从 state 读取而非各自推断。
    let state = createInitialState("r12", "consistency", false);

    // 初始: running + 无审批
    expect(state.status).toBe("running");
    expect(state.pendingApprovals).toHaveLength(0);

    // 添加审批
    state = reduceEvent(state, sse("main", "approval_request", {
      toolUseId: "tu_c1",
      name: "tool1",
      input: {},
    }));
    expect(state.status).toBe("running");
    expect(state.pendingApprovals).toHaveLength(1);
    expect(state.pendingApprovals[0].status).toBe("pending");

    // done 后: status=done + 审批 expired（同一 atomic 转换）
    state = reduceEvent(state, sse("main", "done", {
      stopReason: "completed",
      usage: { inputTokens: 0, outputTokens: 0, turns: 0, cacheHitRatio: 0 },
    }));
    expect(state.status).toBe("done");
    expect(state.pendingApprovals[0].status).toBe("expired");

    // 验证: 从同一个 state 对象读取，没有额外推断
    // header 读取 state.status → "done"
    // approval 卡片读取 state.pendingApprovals[0].status → "expired"
    // 两者来自同一 reduction 步骤，不可能不一致
    expect(state.status === "done" && state.pendingApprovals[0].status === "expired").toBe(true);
  });

  // ---- 13. R-01: expirePendingApprovals 独立函数 ----
  it("13. R-01: expirePendingApprovals 将 pending 审批转为 expired，已处理的不变", () => {
    let state = createInitialState("r13", "expire fn", false);

    // 添加一个 pending + 一个 allowed
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

    // 此时: tu_e1=allowed, tu_e2=pending
    expect(state.pendingApprovals[0].status).toBe("allowed");
    expect(state.pendingApprovals[1].status).toBe("pending");

    // 调用 expirePendingApprovals
    state = expirePendingApprovals(state);

    // tu_e1 保持 allowed, tu_e2 变为 expired
    expect(state.pendingApprovals[0].status).toBe("allowed");
    expect(state.pendingApprovals[1].status).toBe("expired");
  });

  // ---- 14. 空态文案: 列表有记录时用"选择左侧运行…" ----
  it("14. 空态文案: renderEmptyState 区分空列表 vs 有记录未选中", () => {
    // 静态检查: app.js 源码中必须包含两版文案
    const appPath = join(__dirname, "..", "ui", "public", "app.js");
    const appSrc = readFileSync(appPath, "utf-8");

    // 新文案存在
    expect(appSrc).toContain("尚无运行。");
    expect(appSrc).toContain("选择左侧运行查看详情，或创建新任务。");

    // 旧文案不存在
    expect(appSrc).not.toContain("尚无运行。提交一个任务开始。");
  });
});

// ================================================================
// AC6: 窄屏 CSS 静态断言
// ================================================================

describe("AC6 窄屏 CSS", () => {
  it("styles.css 含 max-width:700px 媒体查询实现单栏", () => {
    const cssPath = join(__dirname, "..", "ui", "public", "styles.css");
    const css = readFileSync(cssPath, "utf-8");

    // 媒体查询存在
    expect(css).toContain("@media");
    expect(css).toContain("max-width: 700px");

    // 侧栏隐藏规则
    expect(css).toContain("narrow-hidden");

    // 单栏 flex-direction: column
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

    // 新文案必须存在
    expect(combined).toContain("开启独立核查");
    expect(combined).toContain("运行任务");
    expect(combined).toContain("Agent 执行");
    expect(combined).toContain("核查 Agent");
    expect(combined).toContain("允许本次");
    expect(combined).toContain("拒绝并说明");
    expect(combined).toContain("选择左侧运行查看详情，或创建新任务。");

    // 旧文案必须不存在
    // 注意："核查" 可能作为 badge 出现，所以检查复选框 label 文本
    // label 在 html 中为 <span>开启独立核查</span>，而旧文案是 <span>核查</span>
    // 用更精确的断言
    const checkboxLabel = html.match(/<span>(核查|开启独立核查)<\/span>/);
    expect(checkboxLabel).not.toBeNull();
    expect(checkboxLabel[1]).toBe("开启独立核查");

    // "提交" 按钮旧文案
    expect(html).not.toContain('>提交</button>');

    // "主时间线" 旧文案
    expect(app).not.toContain("主时间线");

    // "核查过程" 旧文案
    expect(app).not.toContain("核查过程");
  });
});

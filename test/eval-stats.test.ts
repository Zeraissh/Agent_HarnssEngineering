/**
 * EVAL-02 统计引擎锁：Wilson / pass@k 已知值 + taxonomy 映射每条有测试。
 */
import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  comb,
  firstRoundAndRepair,
  parseAbLogLine,
  passAtK,
  percentile,
  summarizeAll,
  summarizeGroup,
  wilsonInterval,
  type StatsRunRow,
} from "../eval/stats.js";

describe("wilsonInterval", () => {
  it("n=0 → [0,0]", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 0 });
  });

  it("已知值：10/10 → 下界约 0.722（95%）", () => {
    const { low, high } = wilsonInterval(10, 10);
    expect(low).toBeGreaterThan(0.72);
    expect(low).toBeLessThan(0.73);
    expect(high).toBe(1);
  });

  it("已知值：0/10 → 上界约 0.278", () => {
    const { low, high } = wilsonInterval(0, 10);
    expect(low).toBe(0);
    expect(high).toBeGreaterThan(0.27);
    expect(high).toBeLessThan(0.28);
  });

  it("5/10 中心贴近 0.5", () => {
    const { low, high } = wilsonInterval(5, 10);
    expect(low).toBeLessThan(0.5);
    expect(high).toBeGreaterThan(0.5);
  });
});

describe("passAtK / comb", () => {
  it("C(5,2)=10", () => expect(comb(5, 2)).toBe(10));
  it("C(n,0)=1", () => expect(comb(7, 0)).toBe(1));

  it("已知值：3/5 pass，k=2 → 1 - C(2,2)/C(5,2) = 1 - 1/10 = 0.9", () => {
    expect(passAtK(3, 5, 2).estimate).toBeCloseTo(0.9, 10);
  });

  it("失败数 < k → estimate=1", () => {
    expect(passAtK(4, 5, 2).estimate).toBe(1);
  });
});

describe("percentile", () => {
  it("空 → null；单点；中位", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });
});

function row(over: Partial<StatsRunRow> & Pick<StatsRunRow, "pass">): StatsRunRow {
  return {
    source: "ab",
    caseId: "c",
    arm: "baseline",
    model: "m",
    stopReason: null,
    ...over,
  };
}

describe("classifyFailure taxonomy 映射", () => {
  it("通过 → null", () => {
    expect(classifyFailure(row({ pass: true, stopReason: "completed" }))).toBeNull();
  });

  it("max_turns → budget_max_turns", () => {
    expect(classifyFailure(row({ pass: false, stopReason: "max_turns" }))).toBe("budget_max_turns");
  });

  it("error → api_error", () => {
    expect(classifyFailure(row({ pass: false, stopReason: "error", error: "网络错误" }))).toBe("api_error");
  });

  it("aborted → aborted；plan_rejected → plan_rejected", () => {
    expect(classifyFailure(row({ pass: false, stopReason: "aborted" }))).toBe("aborted");
    expect(classifyFailure(row({ pass: false, stopReason: "plan_rejected" }))).toBe("plan_rejected");
  });

  it("末轮 verifier 拒签 → verifier_rejected_final", () => {
    expect(
      classifyFailure(row({ pass: false, stopReason: "completed", verifierPassed: [false], note: "issues" })),
    ).toBe("verifier_rejected_final");
  });

  it("无法解析 → verifier_fail_closed", () => {
    expect(
      classifyFailure(
        row({ pass: false, stopReason: "completed", verifierPassed: [false], note: "verifier 输出无法解析为 JSON 裁决" }),
      ),
    ).toBe("verifier_fail_closed");
  });

  it("completed 但期望≠实际 → wrong_output", () => {
    expect(
      classifyFailure(row({ pass: false, stopReason: "completed", note: '期望 "a"，实际 "b"' })),
    ).toBe("wrong_output");
  });

  it("未创建产物 → incomplete_output", () => {
    expect(classifyFailure(row({ pass: false, stopReason: "completed", note: "import-list.txt 未创建" }))).toBe(
      "incomplete_output",
    );
  });

  it("兜底 unknown", () => {
    expect(classifyFailure(row({ pass: false, stopReason: "weird" }))).toBe("unknown");
  });
});

describe("firstRoundAndRepair", () => {
  it("首轮过 / 返工救回", () => {
    const rows = [
      row({ pass: true, verifierPassed: [true] }),
      row({ pass: true, verifierPassed: [false, true] }),
      row({ pass: false, verifierPassed: [false, false] }),
    ];
    const r = firstRoundAndRepair(rows);
    expect(r.firstRoundPassRate).toBeCloseTo(1 / 3);
    expect(r.repairRate).toBeCloseTo(0.5); // 2 次首轮失败，1 次救回
  });
});

describe("summarizeGroup / parseAbLogLine", () => {
  it("合成日志钉住 pass@1 与 taxonomy 计数", () => {
    const rows: StatsRunRow[] = [
      row({ pass: true, stopReason: "completed", turns: 5, tokens: 100 }),
      row({ pass: false, stopReason: "max_turns", turns: 15, tokens: 200 }),
      row({ pass: false, stopReason: "error", error: "API 错误 503", turns: 2, tokens: 50 }),
    ];
    const g = summarizeGroup(rows, 2);
    expect(g.n).toBe(3);
    expect(g.passes).toBe(1);
    expect(g.passAt1).toBeCloseTo(1 / 3);
    expect(g.taxonomy.budget_max_turns).toBe(1);
    expect(g.taxonomy.api_error).toBe(1);
    expect(g.turns.p50).toBe(5);
  });

  it("parseAbLogLine 读出 pass/verdicts", () => {
    const r = parseAbLogLine(
      JSON.stringify({
        case: "hard-x",
        arm: "baseline",
        model: "flash",
        pass: true,
        stopReason: "completed",
        turns: 3,
        tokens: 9,
        verifierVerdicts: [{ passed: false }, { passed: true }],
      }),
    );
    expect(r?.caseId).toBe("hard-x");
    expect(r?.verifierPassed).toEqual([false, true]);
  });

  it("summarizeAll 按 case×arm×model 分桶", () => {
    const groups = summarizeAll([
      row({ pass: true, caseId: "a", arm: "b", model: "m1" }),
      row({ pass: false, caseId: "a", arm: "b", model: "m1", stopReason: "error" }),
      row({ pass: true, caseId: "a", arm: "b", model: "m2" }),
    ]);
    expect(groups).toHaveLength(2);
  });
});

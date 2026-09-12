import { describe, expect, it } from "vitest";
import { autoExtendIfExhausted, extendSharedRunBudget, exhaustedBudgetReason } from "../ui/server.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

describe("extendSharedRunBudget / exhaustedBudgetReason", () => {
  it("token 用尽后追加 → 解除 exhausted，新上限=已用+追加", () => {
    const exhausted = { usedTokens: 594_449, maxTokens: 500_000, usedTurns: 12 };
    expect(exhaustedBudgetReason(exhausted)).toMatch(/追加预算/);
    expect(exhaustedBudgetReason(exhausted)).not.toMatch(/^要在这场对话里继续，请提高/);

    const next = extendSharedRunBudget(exhausted, { addTokens: 500_000 });
    expect(next.maxTokens).toBe(594_449 + 500_000);
    expect(exhaustedBudgetReason(next)).toBeNull();
  });

  it("轮次用尽同理", () => {
    const exhausted = { usedTurns: 40, maxTurns: 40, usedTokens: 100 };
    expect(exhaustedBudgetReason(exhausted)).toMatch(/追加预算/);
    const next = extendSharedRunBudget(exhausted, { addTurns: 20 });
    expect(next.maxTurns).toBe(60);
    expect(exhaustedBudgetReason(next)).toBeNull();
  });

  it("续跑自动续跑道：token 用尽则加一段，未用尽不动", () => {
    const exhausted = { usedTokens: 594_449, maxTokens: 500_000, usedTurns: 12, maxTurns: 120 };
    const { budget, extended } = autoExtendIfExhausted(exhausted, { addTokens: 2_000_000, addTurns: 40 });
    expect(extended).toBe(true);
    expect(budget.maxTokens).toBe(594_449 + 2_000_000);
    expect(budget.maxTurns).toBe(120);
    expect(exhaustedBudgetReason(budget)).toBeNull();

    const ok = { usedTokens: 10, maxTokens: 500_000, usedTurns: 2, maxTurns: 120 };
    expect(autoExtendIfExhausted(ok, { addTokens: 2_000_000, addTurns: 40 })).toEqual({
      budget: ok,
      extended: false,
    });
  });
});

describe("直播缓冲不再截尾", () => {
  it("ui 的 index.html 不再声明截尾常量或 slice(-CAP)", () => {
    const rels = ["ui/public/index.html", "cross-app/index.html"].filter((rel) =>
      existsSync(path.join(process.cwd(), rel)),
    );
    expect(rels, "至少要有一份宿主 HTML").toContain("ui/public/index.html");
    for (const rel of rels) {
      const src = readFileSync(path.join(process.cwd(), rel), "utf8");
      expect(src, rel).not.toMatch(/const\s+LIVE_TEXT_CAP\s*=/);
      expect(src, rel).not.toMatch(/slice\(\s*-LIVE_TEXT_CAP/);
    }
  });
});

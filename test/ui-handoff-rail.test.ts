// @vitest-environment jsdom
// @ts-nocheck
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createInitialState,
  deriveActionState,
  reduceEvents,
  renderRunDetail,
} from "../ui/public/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSkeleton() {
  const html = readFileSync(join(__dirname, "..", "ui", "public", "index.html"), "utf-8");
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? "";
  return body.replace(/<script[\s\S]*?<\/script>/g, "");
}

const sse = (seq, source, type, extra = {}) => ({
  seq,
  source,
  event: { type, ...extra },
});

function offered(status = "running") {
  let s = createInitialState("run-h", "查板上 CRC 为什么是 0", false);
  s = reduceEvents(s, [
    sse(0, "host", "handoff_proposal", {
      id: "h1",
      handoffId: "fix_then_verify",
      summary: "RCC 的 CRCEN 写到了 F1 的 bit6",
      label: "按这个根因改固件，再上板复测",
      declineLabel: "先不用",
      at: 1,
    }),
  ]);
  if (status === "done") {
    s = reduceEvents(s, [
      sse(1, "main", "done", { stopReason: "completed", messageCount: 1, usage: {} }),
      sse(2, "host", "run_end", { outcome: "completed", mainStopReason: "completed" }),
    ]);
  }
  return s;
}

beforeEach(() => {
  document.body.innerHTML = loadSkeleton();
});

describe("下一步提示卡（不挡对话）", () => {
  const rail = () => document.querySelector(".handoff-rail");

  it("reducer 投影提议字段，pending 算需注意但不等于提问挂起", () => {
    const s = offered();
    expect(s.handoff.status).toBe("pending");
    expect(s.handoff.summary).toContain("CRCEN");
    const action = deriveActionState(s);
    expect(action.awaitingHandoff).toBe(true);
    expect(action.awaitingQuestion).toBe(false);
    expect(action.needsAttention).toBe(true);
  });

  it("运行中画出提示卡，同意键不可点，文案不出现包名", () => {
    const decisions = [];
    renderRunDetail(offered("running"), {
      activeTab: "loop",
      onHandoffDecision: (d) => decisions.push(d),
    });
    expect(rail().hasAttribute("hidden")).toBe(false);
    const text = rail().textContent ?? "";
    expect(text).toContain("要不要接着做");
    expect(text).toContain("CRCEN");
    expect(text).toContain("等这次调试结束再换段");
    expect(text).not.toMatch(/stm32-coding|stm32-debug|切包/);
    const accept = rail().querySelector("[data-action='accept']");
    expect(accept.disabled).toBe(true);
    accept.click();
    expect(decisions).toEqual([]);
    rail().querySelector("[data-action='decline']").click();
    expect(decisions).toEqual(["decline"]);
  });

  it("结束后同意可点，点了把决定送出去", () => {
    const decisions = [];
    renderRunDetail(offered("done"), {
      activeTab: "loop",
      onHandoffDecision: (d) => decisions.push(d),
    });
    const accept = rail().querySelector("[data-action='accept']");
    expect(accept.disabled).toBe(false);
    accept.click();
    expect(decisions).toEqual(["accept"]);
  });

  it("拒绝后提示卡从坞上消失", () => {
    const s = reduceEvents(offered("done"), [
      sse(3, "host", "handoff_resolved", { id: "h1", decision: "decline", at: 2 }),
    ]);
    renderRunDetail(s, { activeTab: "loop" });
    expect(rail().hasAttribute("hidden")).toBe(true);
    expect(deriveActionState(s).awaitingHandoff).toBe(false);
    expect(deriveActionState(s).needsAttention).toBe(false);
  });
});

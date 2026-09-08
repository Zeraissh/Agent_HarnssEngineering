// @ts-nocheck
import { describe, expect, it } from "vitest";
import { COMPLETE_CANDIDATES, heuristicComplete, parseCompleteBody } from "../ui/complete.js";
import { COMPLETE_EXAMPLES, applyCompletion, shouldAcceptCompletion } from "../ui/public/features/complete.js";

describe("heuristicComplete", () => {
  it("欢迎页示例与服务端候选同一套句子", () => {
    expect(COMPLETE_EXAMPLES.map((e) => e.text)).toEqual(COMPLETE_CANDIDATES);
  });

  it("前缀太短或不匹配 → null", () => {
    expect(heuristicComplete("")).toBeNull();
    expect(heuristicComplete("x")).toBeNull();
    expect(heuristicComplete("没有人会这样开头的任务")).toBeNull();
  });

  it("补出示例的剩余部分；最近标题也能续", () => {
    expect(heuristicComplete("帮我看看")).toBe("这个项目现在的状态，用三句话总结。");
    expect(heuristicComplete("写一个 TypeScript")).toContain("clamp");
    expect(heuristicComplete("修一下", ["修一下登录页的对比度"])).toBe("登录页的对比度");
  });
});

describe("parseCompleteBody / Tab 接受条件", () => {
  it("只收 string prefix 与有限条 recent", () => {
    expect(parseCompleteBody(null)).toEqual({ prefix: "", recent: [] });
    expect(parseCompleteBody({ prefix: "写", recent: ["a", 1, "b"] }).recent).toEqual(["a", "b"]);
  });

  it("只在光标位于末尾时接受，避免撕开正在改的句子", () => {
    expect(shouldAcceptCompletion("帮我", 2, "看看")).toBe(true);
    expect(shouldAcceptCompletion("帮我", 1, "看看")).toBe(false);
    expect(shouldAcceptCompletion("帮我", 2, "")).toBe(false);
    expect(applyCompletion("帮我", "看看")).toBe("帮我看看");
  });
});

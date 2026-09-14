import { describe, expect, it } from "vitest";
import { humanizeHttpFailure } from "../ui/public/features/humanize-error.js";

describe("humanizeHttpFailure", () => {
  it("429 和英文限额都不进脸上", () => {
    expect(humanizeHttpFailure(429, "Mutation rate limit exceeded")).toBe("前面还有人在交，请等几秒。");
    expect(humanizeHttpFailure(500, "领域包列表加载失败（HTTP 500）")).not.toMatch(/HTTP|领域包/);
    expect(humanizeHttpFailure(400, "")).toMatch(/对不上|改一下/);
  });
});

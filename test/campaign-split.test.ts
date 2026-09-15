import { describe, expect, it } from "vitest";
import {
  detectCampaignSplit,
  directorSplitForTask,
} from "../src/campaign.js";
import { detectSpecPlusDeck } from "../src/design-mode.js";

describe("detectCampaignSplit", () => {
  it("spec-plus-deck（规格+幻灯，无第三份交付）不拆", () => {
    const task = "写一份产品规格，并做成三页汇报幻灯。";
    expect(detectSpecPlusDeck(task)).toBe(true);
    expect(detectCampaignSplit(task)).toEqual({ split: false, reason: "spec-plus-deck" });
  });

  it("规格+幻灯+落地页 → 拆（第三份独立交付）", () => {
    const task = "写一份产品规格，做成汇报幻灯，再做落地页。";
    expect(detectSpecPlusDeck(task)).toBe(true);
    const split = detectCampaignSplit(task);
    expect(split.split).toBe(true);
    if (split.split) {
      expect(split.reason).toBe("multi-deliverable");
      expect(split.children.map((c) => c.family)).toEqual(["spec", "deck", "landing"]);
    }
  });

  it("落地页+幻灯（不是 spec-plus-deck）→ 拆", () => {
    const task = "做落地页，并做成汇报幻灯。";
    expect(detectSpecPlusDeck(task)).toBe(false);
    const split = detectCampaignSplit(task);
    expect(split.split).toBe(true);
    if (split.split) expect(split.reason).toBe("multi-deliverable");
  });

  it("落地页+STM32 固件 → 跨 pack 拆", () => {
    const task = "做落地页，并写 STM32 固件。";
    const split = detectCampaignSplit(task);
    expect(split.split).toBe(true);
    if (split.split) expect(split.reason).toBe("cross-pack");
  });

  it("单制品不拆", () => {
    expect(detectCampaignSplit("写 STM32 固件并烧录。")).toEqual({
      split: false,
      reason: "single",
    });
  });

  it("含糊不拆", () => {
    expect(detectCampaignSplit("帮我看看这个。")).toEqual({
      split: false,
      reason: "vague",
    });
  });
});

describe("directorSplitForTask", () => {
  it("显式开战时含糊任务仍给出一条「执行」草图", () => {
    const plan = directorSplitForTask("帮我看看这个。");
    expect(plan.split).toBe(true);
    expect(plan.children).toHaveLength(1);
    expect(plan.children[0]?.title).toBe("执行");
    expect(plan.children[0]?.family).toBe("generic");
  });

  it("显式开战时单制品给出该家族草图，不升成含糊「执行」", () => {
    const plan = directorSplitForTask("写 STM32 固件并烧录。");
    expect(plan.split).toBe(true);
    expect(plan.children.map((c) => c.family)).toEqual(["firmware"]);
    expect(plan.children[0]?.title).toBe("固件");
    expect(plan.children[0]?.pack).toBe("stm32-coding");
  });
});

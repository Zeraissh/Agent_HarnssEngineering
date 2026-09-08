// @vitest-environment jsdom
// @ts-nocheck
import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  ONBOARDING_STEPS,
  ONBOARDING_STORAGE_KEY,
  initOnboarding,
  isOnboardingDone,
  markOnboardingDone,
  nextOnboardingIndex,
} from "../ui/public/features/onboarding.js";

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

describe("onboarding 纯函数", () => {
  it("四步且每步有可定位目标", () => {
    expect(ONBOARDING_STEPS).toHaveLength(4);
    for (const step of ONBOARDING_STEPS) {
      expect(step.target).toMatch(/^#/);
      expect(step.title).toBeTruthy();
    }
  });

  it("完成标记读写容错", () => {
    const st = fakeStorage();
    expect(isOnboardingDone(st)).toBe(false);
    expect(markOnboardingDone(st)).toBe(true);
    expect(isOnboardingDone(st)).toBe(true);
    expect(st.getItem(ONBOARDING_STORAGE_KEY)).toBe("1");
    expect(isOnboardingDone(null)).toBe(false);
  });

  it("下一步到头就停在 total", () => {
    expect(nextOnboardingIndex(0, 4)).toBe(1);
    expect(nextOnboardingIndex(3, 4)).toBe(4);
  });
});

describe("initOnboarding", () => {
  beforeEach(() => {
    document.body.innerHTML = '<select id="workdir-select"></select>';
  });

  it("未完成才自动打开；跳过会落盘", () => {
    const storage = fakeStorage();
    const onAnnounce = vi.fn();
    const api = initOnboarding({ storage, ownerDocument: document, onAnnounce });
    expect(api.start()).toBe(true);
    expect(api.isOpen()).toBe(true);
    expect(document.getElementById("onboarding-title").textContent).toContain("工作目录");
    document.getElementById("onboarding-skip").click();
    expect(api.isOpen()).toBe(false);
    expect(isOnboardingDone(storage)).toBe(true);
    expect(api.start()).toBe(false);
    expect(api.replay()).toBe(true);
    expect(api.isOpen()).toBe(true);
  });

  it("走到最后一步按开始使用关闭", () => {
    const api = initOnboarding({ storage: fakeStorage(), ownerDocument: document });
    api.start();
    const next = document.getElementById("onboarding-next");
    next.click();
    next.click();
    next.click();
    expect(next.textContent).toBe("开始使用");
    next.click();
    expect(api.isOpen()).toBe(false);
  });
});

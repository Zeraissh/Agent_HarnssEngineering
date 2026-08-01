import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { parseRouteDecision, routeToPack } from "../src/router.js";
import { PACKS } from "../src/presets.js";
import type { ModelClient, ModelRequest, ModelTurn } from "../src/types.js";
import { fakeMessage, textBlock } from "./helpers.js";

const NAMES = ["stm32-coding", "stm32-debug"];

class CapturingClient implements ModelClient {
  requests: ModelRequest[] = [];
  constructor(private script: Anthropic.Message[]) {}
  send(req: ModelRequest): Promise<ModelTurn> {
    this.requests.push(structuredClone(req));
    const m = this.script.shift();
    if (!m) throw new Error("script exhausted");
    return Promise.resolve({ message: m, stopReason: m.stop_reason, usage: m.usage });
  }
}

describe("parseRouteDecision（宽容解析，fail-open）", () => {
  it("有效包名", () => {
    const d = parseRouteDecision('{"pack": "stm32-coding", "reason": "固件编程任务"}', NAMES);
    expect(d.pack).toBe("stm32-coding");
    expect(d.reason).toBe("固件编程任务");
  });

  it("null（通用/跨域）", () => {
    expect(parseRouteDecision('{"pack": null, "reason": "跨领域"}', NAMES).pack).toBeNull();
    expect(parseRouteDecision('{"pack": "null", "reason": "通用"}', NAMES).pack).toBeNull();
  });

  it("未注册包名 → 降级 null（fail-open），理由说明", () => {
    const d = parseRouteDecision('{"pack": "pcb-design", "reason": "画板子"}', NAMES);
    expect(d.pack).toBeNull();
    expect(d.reason).toContain("未注册");
  });

  it("围栏/说明文字包裹仍可解析", () => {
    const d = parseRouteDecision('好的。\n```json\n{"pack": "stm32-debug", "reason": "烧录"}\n```', NAMES);
    expect(d.pack).toBe("stm32-debug");
  });

  it("完全不可解析 → null（fail-open，不阻塞执行）", () => {
    const d = parseRouteDecision("这个任务嘛,我觉得挺复杂的", NAMES);
    expect(d.pack).toBeNull();
    expect(d.reason).toContain("无法解析");
  });
});

describe("routeToPack", () => {
  it("单次无工具调用：prompt 含任务与包菜单，返回裁决", async () => {
    const model = new CapturingClient([
      fakeMessage([textBlock('{"pack": "stm32-coding", "reason": "改固件源码"}')], "end_turn"),
    ]);
    const outcome = await routeToPack(
      { systemPrompt: "sys", tools: [], workdir: process.cwd() },
      model,
      "把 g_divisor 改成 7 并重新编译",
      Object.values(PACKS),
    );
    expect(outcome.decision.pack).toBe("stm32-coding");
    expect(model.requests).toHaveLength(1);
    const prompt = JSON.stringify(model.requests[0]!.messages[0]!.content);
    expect(prompt).toContain("g_divisor 改成 7");
    expect(prompt).toContain("stm32-coding:");
    expect(prompt).toContain("stm32-debug:");
    // router 无工具
    expect(model.requests[0]!.tools).toHaveLength(0);
  });
});

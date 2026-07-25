import { describe, expect, it } from "vitest";
import { getPreset, PRESETS } from "../src/presets.js";
import { runVerified } from "../src/orchestrate.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient, ModelRequest, ModelTurn } from "../src/types.js";
import { fakeMessage, textBlock } from "./helpers.js";

describe("presets", () => {
  it("stm32-debug 预设：调试循环 system prompt + 自动验证 + 硬件核查指令", () => {
    const p = getPreset("stm32-debug");
    expect(p).toBeDefined();
    expect(p!.verify).toBe(true);
    expect(p!.systemPrompt).toContain("observe → orient → hypothesize → act → verify");
    expect(p!.systemPrompt).toContain("self_check");
    expect(p!.verifyInstructions).toContain("不要相信报告");
    expect(p!.verifyInstructions).toContain("reconstruct_fault_context");
  });

  it("未知预设名返回 undefined", () => {
    expect(getPreset("does-not-exist")).toBeUndefined();
  });

  it("所有预设的 name 与键一致（防注册错位）", () => {
    for (const [key, preset] of Object.entries(PRESETS)) {
      expect(preset.name).toBe(key);
    }
  });
});

describe("verifyInstructions 注入 verifier 提示", () => {
  /** 捕获每次请求首条消息的文本（render 会把字符串 content 转成 text 块，两种都取） */
  function firstMessageText(req: ModelRequest): string {
    const first = req.messages[0];
    if (!first) return "";
    if (typeof first.content === "string") return first.content;
    return first.content
      .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  class CapturingClient implements ModelClient {
    prompts: string[] = [];
    constructor(private script: Anthropic.Message[]) {}
    send(req: ModelRequest): Promise<ModelTurn> {
      this.prompts.push(firstMessageText(req));
      const m = this.script.shift()!;
      return Promise.resolve({ message: m, stopReason: m.stop_reason, usage: m.usage });
    }
  }

  it("领域核查方法出现在 verifier 的提示中", async () => {
    const model = new CapturingClient([
      fakeMessage([textBlock("完成")], "end_turn"), // main
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "ok"}')], "end_turn"), // verifier
    ]);
    await runVerified(
      { systemPrompt: "sys", tools: [], workdir: process.cwd() },
      model,
      "诊断硬件故障",
      { verifyInstructions: "自己连板重读 CFSR 寄存器再比对" },
    );
    // 第二条 prompt 是 verifier 的
    const verifierPrompt = model.prompts[1]!;
    expect(verifierPrompt).toContain("领域核查方法");
    expect(verifierPrompt).toContain("自己连板重读 CFSR 寄存器再比对");
  });

  it("不传 verifyInstructions 时 verifier 提示不含领域段", async () => {
    const model = new CapturingClient([
      fakeMessage([textBlock("完成")], "end_turn"),
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "ok"}')], "end_turn"),
    ]);
    await runVerified({ systemPrompt: "sys", tools: [], workdir: process.cwd() }, model, "任务", {});
    expect(model.prompts[1]!).not.toContain("领域核查方法");
  });
});

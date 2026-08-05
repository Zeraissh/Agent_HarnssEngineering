import { describe, expect, it } from "vitest";
import { getPack, getPreset, PACKS } from "../src/presets.js";
import { runVerified } from "../src/orchestrate.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient, ModelRequest, ModelTurn } from "../src/types.js";
import { fakeMessage, textBlock } from "./helpers.js";

describe("domain packs", () => {
  it("stm32-debug 包：调试循环 system prompt + 自动验证 + 硬件核查指令 + MCP 白名单", () => {
    const p = getPack("stm32-debug");
    expect(p).toBeDefined();
    expect(p!.verify.enabled).toBe(true);
    expect(p!.verify.mode).toBe("programmatic");
    expect(p!.systemPrompt).toContain("observe → orient → hypothesize → act → verify");
    expect(p!.systemPrompt).toContain("self_check");
    expect(p!.verify.instructions).toContain("不要相信报告");
    expect(typeof p!.mcp).toBe("object");
    expect((p!.mcp as { includeTools: string[] }).includeTools).toContain("flash_firmware");
    // v1.0 演示教训：给 bash 会被用来绕开 MCP 自建调试栈、taskkill 扫死共享 server
    expect(p!.builtinTools).not.toContain("bash");
    expect(p!.systemPrompt).toContain("不要自建 OpenOCD/GDB");
  });

  it("stm32-coding 包：固件工程纪律 + 构建验收 + 不接 MCP（编程阶段不碰硬件）", () => {
    const p = getPack("stm32-coding");
    expect(p).toBeDefined();
    expect(p!.verify.enabled).toBe(true);
    expect(p!.systemPrompt).toContain("cmake --build");
    expect(p!.verify.instructions).toContain("arm-none-eabi-nm");
    expect(p!.mcp).toBe(false);
    expect(p!.builtinTools).not.toContain("fetch_url");
  });

  it("python-coding 包：质量门禁纪律 + 核查白名单 + 不接 MCP（案例 #4 催生）", () => {
    const p = getPack("python-coding");
    expect(p).toBeDefined();
    expect(p!.verify.enabled).toBe(true);
    expect(p!.verify.mode).toBe("programmatic");
    // 案例 #4 缺口①：无白名单 → verifier 核查饥饿,fail-closed 空转返工
    expect(p!.verify.readOnlyCommands).toContain("python -m pytest");
    expect(p!.verify.readOnlyCommands).toContain("python -m mypy");
    // 任意代码执行=写风险,不得放行;ruff 必须带 check 子命令防误放 format
    expect(p!.verify.readOnlyCommands).not.toContain("python");
    expect(p!.verify.readOnlyCommands).not.toContain("python -c");
    expect(p!.verify.readOnlyCommands).not.toContain("python -m ruff");
    // 案例 #4 缺口②：执行者幻觉 edit_file——成文说明工具面只有 write_file
    expect(p!.systemPrompt).toContain("没有】edit_file");
    expect(p!.systemPrompt).toContain("python -m pytest");
    expect(p!.mcp).toBe(false);
    expect(p!.builtinTools).toContain("bash");
    expect(p!.builtinTools).not.toContain("fetch_url");
  });

  it("kicad 包：文件生成路线 + kicad-cli 判官白名单 + 不接 MCP（案例 #5 催生）", () => {
    const p = getPack("kicad");
    expect(p).toBeDefined();
    expect(p!.verify.enabled).toBe(true);
    expect(p!.verify.mode).toBe("programmatic");
    expect(p!.verify.readOnlyCommands).toContain("kicad-cli");
    expect(p!.systemPrompt).toContain("s-expression");
    expect(p!.systemPrompt).toContain("kicad-cli sch erc");
    expect(p!.systemPrompt).toContain("--schematic-parity");
    // MCP 创作面实测判死——文件路线不碰 GUI/MCP
    expect(p!.mcp).toBe(false);
    expect(p!.systemPrompt).toContain("不使用任何 KiCad MCP");
    // 库件保真:嵌入官方库原文,只读根挂载
    expect(p!.systemPrompt).toContain("read_only_roots");
    expect(p!.verify.instructions).toContain("保真");
  });

  it("未知包名返回 undefined", () => {
    expect(getPack("does-not-exist")).toBeUndefined();
  });

  it("所有包的 name 与键一致（防注册错位）", () => {
    for (const [key, pack] of Object.entries(PACKS)) {
      expect(pack.name).toBe(key);
    }
  });

  it("兼容别名 getPreset 仍可用（v0.8 及之前的调用方）", () => {
    expect(getPreset("stm32-debug")).toBe(getPack("stm32-debug"));
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

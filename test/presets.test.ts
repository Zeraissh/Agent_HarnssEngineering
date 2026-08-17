import { describe, expect, it } from "vitest";
import { getPack, getPreset, PACKS, selectPackTools } from "../src/presets.js";
import { makeTool } from "./helpers.js";
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

  it("kicad 包：原理图排版可读性纪律（案例 #11 阶段一 45 处整形手术催生）", () => {
    const p = getPack("kicad");
    // 执行侧:标签朝外/文本零相交/功能分块/电气冻结三件套
    expect(p!.systemPrompt).toContain("标签方向随引脚朝外");
    expect(p!.systemPrompt).toContain("零相交");
    expect(p!.systemPrompt).toContain("功能分块");
    expect(p!.systemPrompt).toContain("逐网逐节点语义相等");
    // 核查侧:视觉工具缺席时排版验收必须 unverified 移交而非默默跳过,
    // 且程序化部分(对齐/栅格/锚点/网表等价)不因视觉缺席而豁免
    expect(p!.verify.instructions).toContain("unverified 移交");
    expect(p!.verify.instructions).toContain("视觉工具缺席不豁免");
  });

  it("kicad 包：PCB 布线成品口径 + 体检单（案例 #11 量产校准 + 委托方红框三连催生）", () => {
    const p = getPack("kicad");
    // 执行侧:曼哈顿只是脚手架;成品口径 = 底层参考面 / 45° 拐角 / 晶振禁区 / 逐引脚丝印 / 板厂约束
    expect(p!.systemPrompt).toContain("执行者的脚手架,不是成品口径");
    expect(p!.systemPrompt).toContain("底层是参考面");
    expect(p!.systemPrompt).toContain("拐角只允许 45° 倍数");
    expect(p!.systemPrompt).toContain("逐引脚**丝印标注");
    expect(p!.systemPrompt).toContain("板级最小约束");
    // 结构化工具优先,不许文本手改 pcb
    expect(p!.systemPrompt).toContain("不要用 read_file/write_file 手改 .kicad_pcb");
    // 核查侧:体检单五项 + 规则活在 .kicad_pro
    expect(p!.verify.instructions).toContain("PCB 布线体检");
    expect(p!.verify.instructions).toContain("90° 折角/锐角回折");
    expect(p!.verify.instructions).toContain("≤ F.Cu 的 40%");
    expect(p!.verify.instructions).toContain("排针逐引脚丝印");
    expect(p!.verify.instructions).toContain("读 .kicad_pro");
  });

  it("ts-coding 包：vitest/tsc 双门禁白名单 + 不接 MCP（案例 #7 催生）", () => {
    const p = getPack("ts-coding");
    expect(p).toBeDefined();
    expect(p!.verify.enabled).toBe(true);
    expect(p!.verify.mode).toBe("programmatic");
    expect(p!.verify.readOnlyCommands).toContain("npx vitest run");
    expect(p!.verify.readOnlyCommands).toContain("npx tsc");
    // 裸 npx 不放行(可执行任意包);工具面成文说明沿用 python-coding 教训
    expect(p!.verify.readOnlyCommands).not.toContain("npx");
    expect(p!.systemPrompt).toContain("没有】edit_file");
    expect(p!.systemPrompt).toContain("npx vitest run");
    expect(p!.mcp).toBe(false);
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

describe("kicad 包的眼睛（describe_image，案例 #9 收官催生）", () => {
  const basePool = [makeTool({ name: "bash" }), makeTool({ name: "read_file" }), makeTool({ name: "write_file" })];

  it("配了视觉模型（池里有 describe_image）→ kicad 工具面带眼睛", () => {
    const pool = [...basePool, makeTool({ name: "describe_image" })];
    const face = selectPackTools(PACKS["kicad"], pool, []);
    expect(face.some((t) => t.name === "describe_image")).toBe(true);
  });

  it("没配视觉模型（池里没有）→ 干净缺席，不摆一个调不通的工具", () => {
    const face = selectPackTools(PACKS["kicad"], basePool, []);
    expect(face.some((t) => t.name === "describe_image")).toBe(false);
    expect(face).toHaveLength(3);
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
    const p = model.prompts[1]!;
    expect(p).not.toContain("领域核查方法");
    // 没有领域说明时，不能让 verifier 去看一个不存在的章节——只读那条要给出
    // 自足的兜底（写这条时就是它抓到我引用了不存在的段落）
    expect(p).toContain("不要自作主张去改变被测系统的状态");
  });

  /**
   * 9.6：真机域的"只读核查"必须含"把系统带到可观测状态"。
   *
   * 案例 #8 实测：stm32-debug 的核查指令原文写着「不要 flash、不要 reset、
   * 不要写内存」一刀切，于是 verifier 68 次工具调用里一次都没复位，读到上一段
   * 会话遗留的未初始化 SRAM（magic=0x4E0A43C0、PC 在 SRAM 内），据此判执行者
   * 失败——而板子上的固件一直是好的。
   *
   * 但那条禁令对【故障现场核查】完全正确（复位会毁掉 .noinit 闩锁/CFSR/栈帧）。
   * 所以正解不是放宽，是把两种核查形态分开写清楚。下面两条锁的就是"分开了"。
   */
  it("硬件核查指令区分两种形态：故障现场绝不复位，运行行为必须先复位跑起来", () => {
    const instr = PACKS["stm32-debug"]!.verify.instructions!;
    // 故障现场那一支：禁令必须还在——这是案例 #1/#3 换来的
    expect(instr).toContain("故障现场核查");
    expect(instr).toMatch(/绝对不要\s*reset|不要\s*reset/);
    expect(instr).toContain("复位会把故障现场毁掉");
    // 运行行为那一支：必须明确要求先带到可观测状态
    expect(instr).toContain("运行行为核查");
    expect(instr).toContain("reset_target");
    expect(instr).toContain("run_for_duration");
    expect(instr).toContain("未初始化 SRAM");
    // 还要给出"怎么认出板子没在跑"的判据，否则模型只能猜
    expect(instr).toMatch(/PC 不在 main|看着像随机数/);
  });

  it("通用只读纪律澄清：只读针对产物，不等于不许让被测系统运行", async () => {
    const model = new CapturingClient([
      fakeMessage([textBlock("完成")], "end_turn"),
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "ok"}')], "end_turn"),
    ]);
    await runVerified(
      { systemPrompt: "sys", tools: [], workdir: process.cwd() },
      model,
      "核查运行行为",
      { verifyInstructions: "先 reset_target 再 run_for_duration" },
    );
    const p = model.prompts[1]!;
    expect(p).toContain("不得改动【被核查的产物】");
    expect(p).toContain('不等于"不许让被测系统运行"');
    // 有领域说明时，以领域说明为准（含"反而绝对不能"那一侧）
    expect(p).toContain("以下面的【领域核查方法】为准");
  });
});

import { describe, expect, it } from "vitest";
import { parseProgressItems, updateProgressTool } from "../src/tools/update-progress.js";
import { estimateContextBreakdown } from "../src/context.js";
import { ALWAYS_ON_BUILTIN_TOOLS, selectPackTools, PACKS } from "../src/presets.js";
import type { Tool } from "../src/types.js";
// @ts-expect-error UI is plain JS; tests import the same module browsers load
import { buildNewRunRequest, createInitialState, reduceEvent, deriveProgressFace, derivePlanFace } from "../ui/public/app.js";

describe("update_progress", () => {
  it("parseProgressItems 整表校验", () => {
    const ok = parseProgressItems({
      items: [
        { id: "1", title: "读文件", status: "done" },
        { id: "2", title: "写结果" },
      ],
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.items[1]?.status).toBe("pending");
    }
    expect(parseProgressItems({ items: [{ id: "a", title: "x" }, { id: "a", title: "y" }] }).ok).toBe(false);
    expect(parseProgressItems({ items: "nope" }).ok).toBe(false);
  });

  it("工具 auto 执行成功", async () => {
    const r = await updateProgressTool.execute(
      { items: [{ id: "1", title: "step", status: "running" }] },
      { workdir: process.cwd(), toolUseId: "t", signal: AbortSignal.abort() },
    );
    expect(r.isError).toBeUndefined();
    expect(r.content).toMatch(/Progress updated/);
  });
});

describe("selectPackTools always-on progress", () => {
  it("包白名单不含 update_progress 时仍挂上", () => {
    const fake: Tool = {
      name: "update_progress",
      description: "x",
      inputSchema: { type: "object", properties: {} },
      permission: "auto",
      parallelSafe: true,
      execute: async () => ({ content: "ok" }),
    };
    const selected = selectPackTools(PACKS["python-coding"], [fake], []);
    expect(ALWAYS_ON_BUILTIN_TOOLS.has("update_progress")).toBe(true);
    expect(selected.some((t) => t.name === "update_progress")).toBe(true);
  });
});

describe("estimateContextBreakdown", () => {
  it("分出 system / tools / conversation", () => {
    const bd = estimateContextBreakdown(
      {
        system: [{ type: "text", text: "S".repeat(40) }],
        tools: [
          { name: "bash", description: "d", input_schema: { type: "object" } },
          { name: "stm32__self_check", description: "d", input_schema: { type: "object" } },
        ],
        messages: [{ role: "user", content: "hello world ".repeat(20) }],
      },
      100,
    );
    expect(bd.system).toBeGreaterThan(0);
    expect(bd.toolsBuiltin).toBeGreaterThan(0);
    expect(bd.toolsMcp).toBeGreaterThan(0);
    expect(bd.conversation).toBeGreaterThan(0);
    expect(bd.estimated).toBe(true);
    expect(typeof bd.unallocated).toBe("number");
  });
});

describe("Progress UI reducer", () => {
  it("progress 事件写入 progressItems 并派生", () => {
    let s = createInitialState("r1", "task", false);
    s = reduceEvent(s, {
      seq: 0,
      source: "main",
      ts: 1,
      event: {
        type: "progress",
        items: [
          { id: "1", title: "A", status: "done" },
          { id: "2", title: "B", status: "running" },
        ],
      },
    });
    expect(s.progressItems).toHaveLength(2);
    const face = deriveProgressFace(s, derivePlanFace(s));
    expect(face.doneCount).toBe(1);
    expect(face.waiting).toBe(false);
  });
});

describe("buildNewRunRequest 正交旋钮", () => {
  it("多 agent 单独开：编排 + auto + 无确认门", () => {
    expect(buildNewRunRequest({ task: "t", multiAgent: true })).toMatchObject({
      mode: "plan",
      concurrency: "auto",
      multiAgent: true,
    });
    expect(buildNewRunRequest({ task: "t", multiAgent: true })).not.toHaveProperty("planGate");
  });

  it("D3 permissionMode=plan 覆盖为确认门开 + autoApprove 关", () => {
    expect(buildNewRunRequest({ task: "t", permissionMode: "plan", autoApprove: true })).toMatchObject({
      mode: "plan",
      planGate: true,
      permissionMode: "plan",
    });
    expect(buildNewRunRequest({ task: "t", permissionMode: "plan" })).not.toHaveProperty("autoApprove");
  });

  it("D3 permissionMode=auto 打开 autoApprove，不开计划门", () => {
    expect(buildNewRunRequest({ task: "t", permissionMode: "auto", planMode: true })).toMatchObject({
      autoApprove: true,
      permissionMode: "auto",
    });
    expect(buildNewRunRequest({ task: "t", permissionMode: "auto" })).not.toHaveProperty("mode");
  });

  it("计划模式单独开：确认门 + 串行", () => {
    expect(buildNewRunRequest({ task: "t", planMode: true })).toMatchObject({
      mode: "plan",
      concurrency: 1,
      planGate: true,
    });
  });

  it("关谱系预算写入载荷", () => {
    expect(buildNewRunRequest({ task: "t" })).toMatchObject({
      lineageBudget: false,
    });
    expect(buildNewRunRequest({ task: "t", lineageBudget: false })).toMatchObject({
      lineageBudget: false,
    });
  });

  it("自动匹配领域包：传 autoPack，不传手选 pack", () => {
    expect(buildNewRunRequest({ task: "t", autoPack: true, pack: "ts-coding" })).toEqual(
      expect.objectContaining({ autoPack: true }),
    );
    expect(buildNewRunRequest({ task: "t", autoPack: true, pack: "ts-coding" })).not.toHaveProperty("pack");
    expect(buildNewRunRequest({ task: "t", pack: "ts-coding" })).toMatchObject({ pack: "ts-coding" });
  });
});

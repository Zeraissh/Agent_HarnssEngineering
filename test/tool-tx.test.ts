/**
 * SAFE-06 Phase 1 — tool transaction：idempotency、prepared/committed、崩溃不重复写。
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Anthropic from "@anthropic-ai/sdk";
import {
  canonicalInputHash,
  decideToolTxReplay,
  retryPolicyForTool,
  toolIdempotencyKey,
  type DurableToolTx,
  type ToolTxController,
} from "../src/tool-tx.js";
import { ToolExecutor, ToolRegistry, ToolTxCrashError } from "../src/tools/registry.js";
import { writeFileTool } from "../src/tools/write-file.js";
import { createBashTool } from "../src/tools/bash.js";
import { initialRunState, transitionRunState } from "../src/run-state.js";
import type { Tool, TurnEvent } from "../src/types.js";

function block(id: string, name: string, input: unknown): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input } as Anthropic.ToolUseBlock;
}

function memoryController(
  runId: string,
  opts: { crashOnce?: boolean; seed?: DurableToolTx[] } = {},
): { ctrl: ToolTxController; store: Map<string, DurableToolTx>; events: TurnEvent[] } {
  const store = new Map<string, DurableToolTx>((opts.seed ?? []).map((t) => [t.idempotencyKey, t]));
  const events: TurnEvent[] = [];
  let crashed = false;
  const ctrl: ToolTxController = {
    runId,
    get: (key) => store.get(key),
    notify: (_phase, tx) => {
      store.set(tx.idempotencyKey, { ...tx });
    },
    ...(opts.crashOnce
      ? {
          injectCrashAfterPrepared: () => {
            if (crashed) return false;
            crashed = true;
            return true;
          },
        }
      : {}),
  };
  return { ctrl, store, events };
}

describe("SAFE-06 tool-tx pure helpers", () => {
  it("idempotency key is runId:toolUseId", () => {
    expect(toolIdempotencyKey("r1", "tu_a")).toBe("r1:tu_a");
  });

  it("canonicalInputHash is order-stable", () => {
    expect(canonicalInputHash({ b: 1, a: 2 })).toBe(canonicalInputHash({ a: 2, b: 1 }));
  });

  it("write_file retries prepared; bash fail-closes", () => {
    expect(retryPolicyForTool("write_file")).toBe("idempotent_retry");
    expect(retryPolicyForTool("bash")).toBe("fail_closed_no_retry");
    const preparedBash: DurableToolTx = {
      idempotencyKey: "r:t",
      toolUseId: "t",
      name: "bash",
      inputHash: "h",
      status: "prepared",
      retryPolicy: "fail_closed_no_retry",
      preparedAt: 1,
      updatedAt: 1,
    };
    const d = decideToolTxReplay(preparedBash, "h");
    expect(d.action).toBe("fail_closed");
    const preparedWrite: DurableToolTx = {
      ...preparedBash,
      name: "write_file",
      retryPolicy: "idempotent_retry",
    };
    expect(decideToolTxReplay(preparedWrite, "h").action).toBe("execute");
  });

  it("committed skips; mismatched inputHash fail-closes", () => {
    const committed: DurableToolTx = {
      idempotencyKey: "r:t",
      toolUseId: "t",
      name: "write_file",
      inputHash: "abc",
      status: "committed",
      retryPolicy: "idempotent_retry",
      preparedAt: 1,
      updatedAt: 2,
      resultContent: "ok",
    };
    const skip = decideToolTxReplay(committed, "abc");
    expect(skip.action).toBe("skip_committed");
    if (skip.action === "skip_committed") expect(skip.result.content).toBe("ok");
    expect(decideToolTxReplay(committed, "other").action).toBe("fail_closed");
  });

  it("run-state tool_tx upsert persists across interrupt/resume", () => {
    let s = transitionRunState(initialRunState("r"), { type: "start" })!;
    const tx: DurableToolTx = {
      idempotencyKey: "r:tu1",
      toolUseId: "tu1",
      name: "write_file",
      inputHash: "h",
      status: "prepared",
      retryPolicy: "idempotent_retry",
      preparedAt: 10,
      updatedAt: 10,
    };
    s = transitionRunState(s, { type: "tool_tx", tx }, 10)!;
    expect(s.toolTx).toHaveLength(1);
    s = transitionRunState(s, { type: "interrupt" }, 11)!;
    expect(s.toolTx[0]!.status).toBe("prepared");
    s = transitionRunState(s, { type: "resume", at: 12 }, 12)!;
    expect(s.toolTx[0]!.idempotencyKey).toBe("r:tu1");
    s = transitionRunState(
      s,
      { type: "tool_tx", tx: { ...tx, status: "committed", updatedAt: 13, resultContent: "done" } },
      13,
    )!;
    expect(s.toolTx).toHaveLength(1);
    expect(s.toolTx[0]!.status).toBe("committed");
  });
});

describe("SAFE-06 ToolExecutor write_file idempotency", () => {
  it("crash after prepared → resume same key writes once; second commit skips", async () => {
    const dir = await mkdtemp(join(tmpdir(), "safe06-wf-"));
    try {
      let physicalWrites = 0;
      const countingWrite: Tool = {
        ...writeFileTool,
        async execute(input, ctx) {
          physicalWrites += 1;
          return writeFileTool.execute(input, ctx);
        },
      };
      const reg = new ToolRegistry();
      reg.register(countingWrite);
      const exec = new ToolExecutor(reg, dir);
      const { ctrl, store, events } = memoryController("run-a", { crashOnce: true });
      exec.setToolTx(ctrl, async (e) => {
        events.push(e);
      });

      const input = { path: "out.txt", content: "hello-safe06" };
      const b = block("tu_write", "write_file", input);

      await expect(
        exec.executeAll([b], new AbortController().signal, async () => ({ decision: "allow" })),
      ).rejects.toBeInstanceOf(ToolTxCrashError);

      expect(store.get("run-a:tu_write")?.status).toBe("prepared");
      expect(physicalWrites).toBe(0);
      expect(events.some((e) => e.type === "tool_prepared")).toBe(true);
      expect(events.some((e) => e.type === "tool_committed")).toBe(false);

      // resume：同 key，crash 已耗尽 → 执行并 commit
      const events2: TurnEvent[] = [];
      exec.setToolTx(ctrl, async (e) => {
        events2.push(e);
      });
      const results = await exec.executeAll(
        [b],
        new AbortController().signal,
        async () => ({ decision: "allow" }),
      );
      expect(results[0]!.is_error).toBeFalsy();
      expect(physicalWrites).toBe(1);
      expect(store.get("run-a:tu_write")?.status).toBe("committed");
      expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("hello-safe06");
      expect(events2.some((e) => e.type === "tool_committed" && !(e as any).skipped)).toBe(true);

      // 第三次同 key → skip，不再写盘
      const events3: TurnEvent[] = [];
      exec.setToolTx(ctrl, async (e) => {
        events3.push(e);
      });
      await exec.executeAll([b], new AbortController().signal, async () => ({ decision: "allow" }));
      expect(physicalWrites).toBe(1);
      expect(events3.some((e) => e.type === "tool_committed" && (e as any).skipped === true)).toBe(
        true,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("content-level idempotency: same bytes already on disk → no second overwrite count", async () => {
    const dir = await mkdtemp(join(tmpdir(), "safe06-wf2-"));
    try {
      let physicalWrites = 0;
      const countingWrite: Tool = {
        ...writeFileTool,
        name: "write_file",
        async execute(input, ctx) {
          // 包一层统计真实 writeFile 调用：工具内部 unchanged 短路时仍会 read，但我们
          // 数的是进入 execute 的次数；内容幂等在工具内，这里验证返回含 unchanged。
          const r = await writeFileTool.execute(input, ctx);
          if (!String(r.content).includes("(unchanged)")) physicalWrites += 1;
          else physicalWrites += 0;
          return r;
        },
      };
      // 更直接：先写一次，再跑二次看 unchanged
      const reg = new ToolRegistry();
      reg.register(writeFileTool);
      const exec = new ToolExecutor(reg, dir);
      const { ctrl } = memoryController("run-b");
      exec.setToolTx(ctrl);
      const input = { path: "a.txt", content: "same" };
      const b1 = block("tu1", "write_file", input);
      await exec.executeAll([b1], new AbortController().signal, async () => ({ decision: "allow" }));
      // 模拟写后未 commit：手工把状态打回 running，再同 key 重入
      const key = toolIdempotencyKey("run-b", "tu1");
      const prev = ctrl.get(key)!;
      await ctrl.notify("running", { ...prev, status: "running" });
      // 新 executor 带 seed
      const exec2 = new ToolExecutor(reg, dir);
      const { ctrl: ctrl2, events } = memoryController("run-b", {
        seed: [{ ...prev, status: "running" }],
      });
      exec2.setToolTx(ctrl2, async (e) => {
        events.push(e);
      });
      const [r] = await exec2.executeAll(
        [b1],
        new AbortController().signal,
        async () => ({ decision: "allow" }),
      );
      expect(r!.content).toContain("unchanged");
      expect(ctrl2.get(key)?.status).toBe("committed");
      void physicalWrites;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("SAFE-06 bash fail-closed residual", () => {
  it("prepared bash must not re-execute", async () => {
    let runs = 0;
    const bash = createBashTool({
      legacyBrokerFactory: () => ({
        boundaryId: "test",
        status: () =>
          ({
            boundaryId: "test",
            effectiveState: "unisolated",
            requestedMode: "off",
            resolvedBackend: null,
            probe: { state: "skipped" },
          }) as any,
        probe: async () =>
          ({
            boundaryId: "test",
            effectiveState: "unisolated",
            requestedMode: "off",
            resolvedBackend: null,
            probe: { state: "skipped" },
          }) as any,
        executeShell: async () => {
          runs += 1;
          return {
            stdout: "ok",
            stderr: "",
            exitCode: 0,
            signal: null,
            timedOut: false,
            aborted: false,
            outputLimitExceeded: false,
            cleanup: "not-needed" as const,
            status: {
              boundaryId: "test",
              effectiveState: "unisolated",
              requestedMode: "off",
              resolvedBackend: null,
              probe: { state: "skipped" },
            } as any,
          };
        },
      }),
    });
    const reg = new ToolRegistry();
    reg.register(bash);
    const exec = new ToolExecutor(reg, process.cwd());
    const seed: DurableToolTx = {
      idempotencyKey: "run-c:tu_bash",
      toolUseId: "tu_bash",
      name: "bash",
      inputHash: canonicalInputHash({ command: "echo hi" }),
      status: "prepared",
      retryPolicy: "fail_closed_no_retry",
      preparedAt: 1,
      updatedAt: 1,
    };
    const { ctrl, events } = memoryController("run-c", { seed: [seed] });
    exec.setToolTx(ctrl, async (e) => {
      events.push(e);
    });
    const [r] = await exec.executeAll(
      [block("tu_bash", "bash", { command: "echo hi" })],
      new AbortController().signal,
      async () => ({ decision: "allow" }),
    );
    expect(runs).toBe(0);
    expect(r!.is_error).toBe(true);
    expect(r!.content).toMatch(/fail-closed|must not be retried/i);
    expect(events.some((e) => e.type === "tool_failed")).toBe(true);
  });
});

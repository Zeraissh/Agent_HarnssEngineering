import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentLoop } from "../src/loop.js";
import {
  createHookRuntime,
  hookMatches,
  interpretHookExit,
  loadHookConfigFile,
  resolveHooksFromEnv,
  withoutExternalHooks,
  type HookCommandResult,
  type NormalizedHookSpec,
} from "../src/hooks.js";
import { buildLedgerEntry, emptyHooksTally, summarizeLedger, tallyHookEvent } from "../src/ledger.js";
import { ToolExecutor, ToolRegistry } from "../src/tools/registry.js";
import { FakeModelClient, fakeMessage, makeTool, textBlock, toolUseBlock } from "./helpers.js";

function spec(over: Partial<NormalizedHookSpec> = {}): NormalizedHookSpec {
  return {
    timeoutMs: over.timeoutMs ?? 5000,
    sourcePath: over.sourcePath ?? "test",
    hooks: {
      PreToolUse: [],
      PostToolUse: [],
      Stop: [],
      ...over.hooks,
    },
  };
}

function runner(impl: (command: string) => HookCommandResult | Promise<HookCommandResult>) {
  return async (command: string) => impl(command);
}

const cwd = process.cwd();

describe("interpretHookExit", () => {
  it("0 放行、2 阻断、1 与其它码以及超时都是非阻断错误", () => {
    expect(interpretHookExit(0, false)).toBe("allow");
    expect(interpretHookExit(2, false)).toBe("block");
    expect(interpretHookExit(1, false)).toBe("error");
    expect(interpretHookExit(3, false)).toBe("error");
    expect(interpretHookExit(null, false)).toBe("error");
    expect(interpretHookExit(2, true)).toBe("error");
    expect(interpretHookExit(0, true)).toBe("error");
  });
});

describe("hookMatches", () => {
  it("省略 / * 匹配全部；逗号与 | 是精确名列表", () => {
    expect(hookMatches(undefined, "bash")).toBe(true);
    expect(hookMatches("*", "write_file")).toBe(true);
    expect(hookMatches("bash", "bash")).toBe(true);
    expect(hookMatches("bash", "write_file")).toBe(false);
    expect(hookMatches("bash,write_file", "write_file")).toBe(true);
    expect(hookMatches("bash|read_file", "read_file")).toBe(true);
  });
});

describe("loadHookConfigFile / resolveHooksFromEnv", () => {
  it("缺 env = 机制不存在；文件缺失 / 非法 JSON = fail-closed", () => {
    expect(resolveHooksFromEnv({})).toBeNull();
    expect(resolveHooksFromEnv({ AGENT_HOOKS_CONFIG: "" })).toBeNull();
    expect(() => resolveHooksFromEnv({ AGENT_HOOKS_CONFIG: join(cwd, "no-such-hooks-config.json") })).toThrow(
      /missing file/,
    );
    const dir = mkdtempSync(join(tmpdir(), "hooks-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{", "utf8");
    expect(() => loadHookConfigFile(bad)).toThrow(/not valid JSON/);
  });

  it("忽略未知事件与非 command handler；timeoutMs 缺省 5s", () => {
    const dir = mkdtempSync(join(tmpdir(), "hooks-"));
    const file = join(dir, "ok.json");
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ command: "echo no" }],
          PreToolUse: [{ type: "http", url: "https://example" }, { matcher: "bash", command: "node -e process.exit(0)" }],
        },
      }),
      "utf8",
    );
    const loaded = loadHookConfigFile(file);
    expect(loaded.timeoutMs).toBe(5000);
    expect(loaded.hooks.PreToolUse).toHaveLength(1);
    expect(loaded.hooks.PreToolUse[0]!.matcher).toBe("bash");
  });
});

describe("PreToolUse 控制流", () => {
  it("exit 2：工具不跑、不进审批表、拒绝理由进正史", async () => {
    let executed = 0;
    let approved = 0;
    const events: string[] = [];
    const registry = new ToolRegistry();
    registry.register(makeTool({
      name: "bash",
      permission: "ask",
      execute: async () => {
        executed += 1;
        return { content: "ran" };
      },
    }));
    const ex = new ToolExecutor(registry, cwd);
    ex.setHooks(
      createHookRuntime(spec({ hooks: { PreToolUse: [{ command: "deny-bash" }], PostToolUse: [], Stop: [] } }), {
        workdir: cwd,
        runCommand: runner(() => ({ exitCode: 2, timedOut: false, stdout: "", stderr: "no network" })),
      }),
      (e) => {
        if (e.type === "hook") events.push(`${e.hook}:${e.outcome}`);
      },
    );
    const [result] = await ex.executeAll(
      [toolUseBlock("u1", "bash", { command: "curl evil" })],
      new AbortController().signal,
      async () => {
        approved += 1;
        return { decision: "allow" };
      },
    );
    expect(executed).toBe(0);
    expect(approved).toBe(0);
    expect(result!.is_error).toBe(true);
    expect(result!.content).toMatch(/Hook blocked "bash"/);
    expect(result!.content).toMatch(/no network/);
    expect(events).toEqual(["PreToolUse:block"]);
  });

  it("exit 1：记 hook 错误，工具照常跑", async () => {
    let executed = 0;
    const outcomes: string[] = [];
    const registry = new ToolRegistry();
    registry.register(makeTool({
      name: "bash",
      execute: async () => {
        executed += 1;
        return { content: "ran" };
      },
    }));
    const ex = new ToolExecutor(registry, cwd);
    ex.setHooks(
      createHookRuntime(spec({ hooks: { PreToolUse: [{ command: "warn" }], PostToolUse: [], Stop: [] } }), {
        workdir: cwd,
        runCommand: runner(() => ({ exitCode: 1, timedOut: false, stdout: "", stderr: "script bug" })),
      }),
      (e) => {
        if (e.type === "hook") outcomes.push(e.outcome);
      },
    );
    const [result] = await ex.executeAll(
      [toolUseBlock("u1", "bash", {})],
      new AbortController().signal,
      async () => ({ decision: "allow" }),
    );
    expect(executed).toBe(1);
    expect(result!.is_error).not.toBe(true);
    expect(outcomes).toContain("error");
  });

  it("超时：非阻断，工具照常跑，事件带 timedOut", async () => {
    let executed = 0;
    const hooks: Array<{ outcome: string; timedOut?: boolean }> = [];
    const registry = new ToolRegistry();
    registry.register(makeTool({
      name: "bash",
      execute: async () => {
        executed += 1;
        return { content: "ran" };
      },
    }));
    const ex = new ToolExecutor(registry, cwd);
    ex.setHooks(
      createHookRuntime(spec({ hooks: { PreToolUse: [{ command: "hang" }], PostToolUse: [], Stop: [] } }), {
        workdir: cwd,
        runCommand: runner(() => ({ exitCode: null, timedOut: true, stdout: "", stderr: "" })),
      }),
      (e) => {
        if (e.type === "hook") hooks.push({ outcome: e.outcome, timedOut: e.timedOut });
      },
    );
    await ex.executeAll(
      [toolUseBlock("u1", "bash", {})],
      new AbortController().signal,
      async () => ({ decision: "allow" }),
    );
    expect(executed).toBe(1);
    expect(hooks[0]).toEqual({ outcome: "error", timedOut: true });
  });

  it("hook allow 不能推翻 permission=deny", async () => {
    let executed = 0;
    const registry = new ToolRegistry();
    registry.register(makeTool({
      name: "bash",
      permission: "deny",
      execute: async () => {
        executed += 1;
        return { content: "ran" };
      },
    }));
    const ex = new ToolExecutor(registry, cwd);
    ex.setHooks(
      createHookRuntime(spec({ hooks: { PreToolUse: [{ command: "allow" }], PostToolUse: [], Stop: [] } }), {
        workdir: cwd,
        runCommand: runner(() => ({ exitCode: 0, timedOut: false, stdout: "", stderr: "" })),
      }),
    );
    const [result] = await ex.executeAll(
      [toolUseBlock("u1", "bash", {})],
      new AbortController().signal,
      async () => ({ decision: "allow" }),
    );
    expect(executed).toBe(0);
    expect(result!.content).toMatch(/denied by policy/);
  });

  it("matcher 只拦 bash，write_file 不受影响", async () => {
    const ran: string[] = [];
    const registry = new ToolRegistry();
    registry.register(makeTool({
      name: "bash",
      execute: async () => {
        ran.push("bash");
        return { content: "ok" };
      },
    }));
    registry.register(makeTool({
      name: "write_file",
      execute: async () => {
        ran.push("write_file");
        return { content: "ok" };
      },
    }));
    const ex = new ToolExecutor(registry, cwd);
    ex.setHooks(
      createHookRuntime(
        spec({ hooks: { PreToolUse: [{ matcher: "bash", command: "deny" }], PostToolUse: [], Stop: [] } }),
        {
          workdir: cwd,
          runCommand: runner(() => ({ exitCode: 2, timedOut: false, stdout: "", stderr: "no" })),
        },
      ),
    );
    const results = await ex.executeAll(
      [toolUseBlock("a", "bash", {}), toolUseBlock("b", "write_file", {})],
      new AbortController().signal,
      async () => ({ decision: "allow" }),
    );
    expect(ran).toEqual(["write_file"]);
    expect(results.find((r) => r.tool_use_id === "a")!.is_error).toBe(true);
    expect(results.find((r) => r.tool_use_id === "b")!.is_error).not.toBe(true);
  });
});

describe("PostToolUse / Stop", () => {
  it("Post 在执行之后；Pre 阻断后不发 Post", async () => {
    const seen: string[] = [];
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "bash" }));
    const ex = new ToolExecutor(registry, cwd);
    ex.setHooks(
      createHookRuntime(
        spec({
          hooks: {
            PreToolUse: [{ command: "pre" }],
            PostToolUse: [{ command: "post" }],
            Stop: [],
          },
        }),
        {
          workdir: cwd,
          runCommand: runner((command) => ({
            exitCode: command === "pre" ? 2 : 0,
            timedOut: false,
            stdout: "",
            stderr: "",
          })),
        },
      ),
      (e) => {
        if (e.type === "hook") seen.push(e.hook);
      },
    );
    await ex.executeAll(
      [toolUseBlock("u1", "bash", {})],
      new AbortController().signal,
      async () => ({ decision: "allow" }),
    );
    expect(seen).toEqual(["PreToolUse"]);
  });

  it("Stop 赶在 done 之前进事件流", async () => {
    const types: string[] = [];
    const loop = new AgentLoop(
      {
        systemPrompt: "t",
        tools: [],
        workdir: cwd,
        maxTurns: 2,
        hooks: createHookRuntime(spec({ hooks: { PreToolUse: [], PostToolUse: [], Stop: [{ command: "stop" }] } }), {
          workdir: cwd,
          runCommand: runner(() => ({ exitCode: 0, timedOut: false, stdout: "", stderr: "" })),
        }),
      },
      new FakeModelClient([fakeMessage([textBlock("hi")], "end_turn")]),
    );
    for await (const event of loop.run("go")) {
      types.push(event.type);
    }
    const stopAt = types.indexOf("hook");
    const doneAt = types.indexOf("done");
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(doneAt).toBeGreaterThan(stopAt);
  });
});

describe("withoutExternalHooks / 未武装", () => {
  it("剥掉 hooks 后 runner 一次都不跑", async () => {
    let fired = 0;
    const runtime = createHookRuntime(spec({ hooks: { PreToolUse: [], PostToolUse: [], Stop: [{ command: "stop" }] } }), {
      workdir: cwd,
      runCommand: async () => {
        fired += 1;
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
      },
    });
    const stripped = withoutExternalHooks({
      systemPrompt: "t",
      tools: [],
      workdir: cwd,
      maxTurns: 2,
      hooks: runtime,
    });
    expect(stripped.hooks).toBeUndefined();
    const loop = new AgentLoop(
      stripped,
      new FakeModelClient([fakeMessage([textBlock("hi")], "end_turn")]),
    );
    for await (const event of loop.run("go")) {
      expect(event.type).not.toBe("hook");
    }
    expect(fired).toBe(0);
  });

  it("未装 hooks 的 loop 零 hook 事件", async () => {
    const loop = new AgentLoop(
      { systemPrompt: "t", tools: [makeTool({ name: "bash" })], workdir: cwd, maxTurns: 2 },
      new FakeModelClient([
        fakeMessage([toolUseBlock("u1", "bash", {})], "tool_use"),
        fakeMessage([textBlock("done")], "end_turn"),
      ]),
    );
    const hooks = [];
    for await (const event of loop.run("go")) {
      if (event.type === "hook") hooks.push(event);
    }
    expect(hooks).toHaveLength(0);
  });
});

describe("台账 hooks 字段", () => {
  it("未武装是 null；武装写 {fired, blocked}；老行缺字段不进分母", () => {
    const base = { at: 1, runId: "r", host: "cli" as const, task: "x" };
    expect(buildLedgerEntry(base).hooks).toBeNull();
    expect(buildLedgerEntry({ ...base, hooks: emptyHooksTally() }).hooks).toEqual({ fired: 0, blocked: 0 });
    const tally = emptyHooksTally();
    tallyHookEvent(tally, { type: "hook", outcome: "allow" });
    tallyHookEvent(tally, { type: "hook", outcome: "block" });
    tallyHookEvent(tally, { type: "hook", outcome: "error" });
    tallyHookEvent(tally, { type: "tool_call" });
    expect(tally).toEqual({ fired: 3, blocked: 1 });
    const armed = buildLedgerEntry({ ...base, hooks: tally });
    const legacy = JSON.parse(JSON.stringify(buildLedgerEntry(base))) as ReturnType<typeof buildLedgerEntry>;
    delete (legacy as { hooks?: unknown }).hooks;
    const s = summarizeLedger([armed, buildLedgerEntry(base), legacy]);
    expect(s.hooks).toEqual({ rows: 2, armed: 1, fired: 3, blocked: 1 });
  });
});

describe("真实 command runner", () => {
  it("node -e process.exit(2) 阻断", async () => {
    const registry = new ToolRegistry();
    let executed = 0;
    registry.register(makeTool({
      name: "bash",
      permission: "ask",
      execute: async () => {
        executed += 1;
        return { content: "ran" };
      },
    }));
    const ex = new ToolExecutor(registry, cwd);
    ex.setHooks(
      createHookRuntime(
        spec({
          hooks: {
            PreToolUse: [{ command: `"${process.execPath}" -e "process.exit(2)"` }],
            PostToolUse: [],
            Stop: [],
          },
        }),
        { workdir: cwd },
      ),
    );
    let approved = 0;
    const [result] = await ex.executeAll(
      [toolUseBlock("u1", "bash", {})],
      new AbortController().signal,
      async () => {
        approved += 1;
        return { decision: "allow" };
      },
    );
    expect(executed).toBe(0);
    expect(approved).toBe(0);
    expect(result!.is_error).toBe(true);
    expect(String(result!.content)).toMatch(/Hook blocked/);
  });
});

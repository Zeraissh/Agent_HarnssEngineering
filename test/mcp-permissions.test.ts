import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { adaptMcpTool, loadMcpConfig, type McpCaller } from "../src/mcp.js";
import { GITHUB_MCP_READ_TOOLS, GITHUB_MCP_WRITE_TOOLS } from "../src/mcp-github.js";
import { PACKS, selectPackTools } from "../src/presets.js";
import { ToolExecutor, ToolRegistry } from "../src/tools/registry.js";
import { toolUseBlock } from "./helpers.js";

const signal = new AbortController().signal;

describe("MCP 最终权限面", () => {
  it("仓库 mcp.json 在不选 DomainPack 时也单独拦截 STM32 破坏性工具", async () => {
    const cfg = await loadMcpConfig(resolve("mcp.json"));
    const stm32 = cfg?.servers["stm32"];
    expect(stm32?.permission).toBe("auto");
    for (const destructive of ["flash_firmware", "flash_and_run", "reset_target", "write_memory"]) {
      expect(stm32?.toolPermissions?.[destructive]).toBe("ask");
    }
    // compact MCP 的 call/batch 能转发任意工具；参数级权限尚未实现前不得暴露。
    expect(stm32?.includeTools).not.toContain("call");
    expect(stm32?.includeTools).not.toContain("batch");
  });

  it("stm32-debug：读操作 auto，持久/破坏性操作 ask", () => {
    const rawNames = [
      "read_memory",
      "read_variable",
      "self_check",
      "flash_firmware",
      "flash_and_run",
      "reset_target",
      "write_memory",
      "call",
      "batch",
    ];
    const caller: McpCaller = async () => ({ content: "ok", isError: false });
    const pool = rawNames.map((name) =>
      adaptMcpTool("stm32", { name }, caller, { permission: "auto", parallelSafe: false }),
    );

    const selected = selectPackTools(PACKS["stm32-debug"], [], pool);
    const permissions = Object.fromEntries(
      selected.map((tool) => [tool.name.replace(/^stm32__/, ""), tool.permission]),
    );
    expect(permissions).toMatchObject({
      read_memory: "auto",
      read_variable: "auto",
      self_check: "auto",
      flash_firmware: "ask",
      flash_and_run: "ask",
      reset_target: "ask",
      write_memory: "ask",
    });
    expect(permissions).not.toHaveProperty("call");
    expect(permissions).not.toHaveProperty("batch");
  });

  it("DomainPack 的泛化 auto 不能盖掉 server 单工具 ask", () => {
    const caller: McpCaller = async () => ({ content: "ok", isError: false });
    const flash = adaptMcpTool("stm32", { name: "flash_firmware" }, caller, {
      permission: "auto",
      toolPermissions: { flash_firmware: "ask" },
      parallelSafe: false,
    });
    const selected = selectPackTools(
      {
        ...PACKS["stm32-debug"]!,
        mcp: { includeTools: ["flash_firmware"], permission: "auto" },
      },
      [],
      [flash],
    );
    expect(selected[0]?.permission).toBe("ask");
  });

  it("server 名含双下划线时仍按适配元数据匹配原始工具名", () => {
    const caller: McpCaller = async () => ({ content: "ok", isError: false });
    const flash = adaptMcpTool("lab__stm32", { name: "flash__firmware" }, caller, {
      permission: "auto",
      toolPermissions: { "flash__firmware": "ask" },
      parallelSafe: false,
    });
    const selected = selectPackTools(
      {
        ...PACKS["stm32-debug"]!,
        mcp: {
          includeTools: ["flash__firmware"],
          permission: "auto",
          toolPermissions: { "flash__firmware": "ask" },
        },
      },
      [],
      [flash],
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]?.name).toBe("lab__stm32__flash__firmware");
    expect(selected[0]?.permission).toBe("ask");
  });

  it("审批/执行路径：auto 不询问，ask 拒绝时不触发 MCP，允许后才触发", async () => {
    const calls: string[] = [];
    const caller: McpCaller = async (name) => {
      calls.push(name);
      return { content: `${name} ok`, isError: false };
    };
    const pool = ["read_memory", "reset_target"].map((name) =>
      adaptMcpTool("stm32", { name }, caller, { permission: "auto", parallelSafe: false }),
    );
    const registry = new ToolRegistry();
    for (const tool of selectPackTools(PACKS["stm32-debug"], [], pool)) registry.register(tool);
    const executor = new ToolExecutor(registry, process.cwd());

    let approvals = 0;
    const readResult = await executor.executeAll(
      [toolUseBlock("read", "stm32__read_memory", {})],
      signal,
      async () => {
        approvals += 1;
        return { decision: "deny" };
      },
    );
    expect(approvals).toBe(0);
    expect(calls).toEqual(["read_memory"]);
    expect(readResult[0]?.is_error).toBeUndefined();

    const denied = await executor.executeAll(
      [toolUseBlock("reset-denied", "stm32__reset_target", {})],
      signal,
      async () => {
        approvals += 1;
        return { decision: "deny", reason: "preserve fault evidence" };
      },
    );
    expect(approvals).toBe(1);
    expect(calls).toEqual(["read_memory"]);
    expect(denied[0]?.is_error).toBe(true);
    expect(denied[0]?.content).toContain("preserve fault evidence");

    const allowed = await executor.executeAll(
      [toolUseBlock("reset-allowed", "stm32__reset_target", {})],
      signal,
      async () => {
        approvals += 1;
        return { decision: "allow" };
      },
    );
    expect(approvals).toBe(2);
    expect(calls).toEqual(["read_memory", "reset_target"]);
    expect(allowed[0]?.is_error).toBeUndefined();
  });

  it("ts-coding 只收 GitHub 工具：读 auto、写 ask，硬件工具进不了面", () => {
    const caller: McpCaller = async () => ({ content: "ok", isError: false });
    const pool = [
      ...GITHUB_MCP_READ_TOOLS.map((name) =>
        adaptMcpTool("github", { name }, caller, { permission: "ask", parallelSafe: true }),
      ),
      ...GITHUB_MCP_WRITE_TOOLS.map((name) =>
        adaptMcpTool("github", { name }, caller, { permission: "ask", parallelSafe: true }),
      ),
      adaptMcpTool("stm32", { name: "flash_firmware" }, caller, { permission: "auto", parallelSafe: false }),
    ];
    const selected = selectPackTools(PACKS["ts-coding"], [], pool);
    const names = selected.map((tool) => tool.name);
    expect(names).toContain("github__get_file_contents");
    expect(names).toContain("github__create_pull_request");
    expect(names).not.toContain("stm32__flash_firmware");
    const permissions = Object.fromEntries(
      selected.map((tool) => [tool.name.replace(/^github__/, ""), tool.permission]),
    );
    expect(permissions.get_file_contents).toBe("auto");
    expect(permissions.create_pull_request).toBe("ask");
    expect(permissions.merge_pull_request).toBeUndefined();
  });

  it("python-coding 声明 mcp:false 仍叠 GitHub，硬件工具进不了面", () => {
    const caller: McpCaller = async () => ({ content: "ok", isError: false });
    const pool = [
      adaptMcpTool("github", { name: "get_file_contents" }, caller, { permission: "ask" }),
      adaptMcpTool("github", { name: "create_pull_request" }, caller, { permission: "ask" }),
      adaptMcpTool("stm32", { name: "flash_firmware" }, caller, { permission: "auto" }),
    ];
    const selected = selectPackTools(PACKS["python-coding"], [], pool);
    const names = selected.map((tool) => tool.name);
    expect(names).toContain("github__get_file_contents");
    expect(names).toContain("github__create_pull_request");
    expect(names).not.toContain("stm32__flash_firmware");
    expect(selected.find((tool) => tool.name === "github__get_file_contents")?.permission).toBe("auto");
    expect(selected.find((tool) => tool.name === "github__create_pull_request")?.permission).toBe("ask");
  });

  it("stm32-debug 不会因为 mcp.json 多了 github 就带上 GitHub 工具", () => {
    const caller: McpCaller = async () => ({ content: "ok", isError: false });
    const pool = [
      adaptMcpTool("github", { name: "create_pull_request" }, caller, { permission: "ask" }),
      adaptMcpTool("stm32", { name: "read_memory" }, caller, { permission: "auto" }),
    ];
    const selected = selectPackTools(PACKS["stm32-debug"], [], pool);
    expect(selected.map((tool) => tool.name)).toEqual(["stm32__read_memory"]);
  });
});

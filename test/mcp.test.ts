import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adaptMcpTool,
  connectMcpServers,
  filterMcpConfigForPack,
  interpolateMcpEnvValue,
  loadMcpConfig,
  mcpConfigHasRunnableServers,
  mcpServerSkipReason,
  renderMcpContent,
  resolveMcpServerEnv,
  resolveMcpToolPermission,
  type McpCaller,
} from "../src/mcp.js";
import { GITHUB_MCP_TOOLS, GITHUB_MCP_TOOLS_CSV, GITHUB_MCP_WRITE_TOOLS } from "../src/mcp-github.js";
import { PACKS } from "../src/presets.js";

const ctx = { workdir: "x", toolUseId: "tu", signal: new AbortController().signal };

describe("adaptMcpTool（MCP tool → harness Tool）", () => {
  const okCaller: McpCaller = async (name, args) => ({
    content: `called ${name} with ${JSON.stringify(args)}`,
    isError: false,
  });

  it("名字加 server 前缀；schema 直通；默认 ask + 非并行（保守）", () => {
    const tool = adaptMcpTool(
      "stm32",
      {
        name: "start_debug_session",
        description: "Start a GDB session",
        inputSchema: { type: "object", properties: { mcu: { type: "string" } } },
      },
      okCaller,
      {},
    );
    expect(tool.name).toBe("stm32__start_debug_session");
    expect(tool.description).toBe("Start a GDB session");
    expect(tool.inputSchema).toEqual({ type: "object", properties: { mcu: { type: "string" } } });
    expect(tool.permission).toBe("ask");
    expect(tool.parallelSafe).toBe(false);
  });

  it("server 级配置可放开权限与并行", () => {
    const tool = adaptMcpTool("s", { name: "t" }, okCaller, {
      permission: "auto",
      parallelSafe: true,
    });
    expect(tool.permission).toBe("auto");
    expect(tool.parallelSafe).toBe(true);
  });

  it("server 级默认保持向后兼容，单工具覆盖优先", () => {
    const read = adaptMcpTool("stm32", { name: "read_memory" }, okCaller, {
      permission: "auto",
      toolPermissions: { flash_firmware: "ask" },
    });
    const flash = adaptMcpTool("stm32", { name: "flash_firmware" }, okCaller, {
      permission: "auto",
      toolPermissions: { flash_firmware: "ask" },
    });
    expect(read.permission).toBe("auto");
    expect(flash.permission).toBe("ask");
    expect(read.approvalPolicy).toBeUndefined();
    expect(flash.approvalPolicy).toEqual({ maxScope: "once" });
  });

  it("缺失 description/schema 时给出兜底", () => {
    const tool = adaptMcpTool("s", { name: "bare" }, okCaller, {});
    expect(tool.description).toContain("bare");
    expect(tool.inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("execute 透传参数并回传内容；isError 映射", async () => {
    const tool = adaptMcpTool("s", { name: "echo" }, okCaller, {});
    const ok = await tool.execute({ a: 1 }, ctx);
    expect(ok.content).toBe('called echo with {"a":1}');
    expect(ok.isError).toBeUndefined();

    const failCaller: McpCaller = async () => ({ content: "GDB not connected", isError: true });
    const failing = adaptMcpTool("s", { name: "read_memory" }, failCaller, {});
    const bad = await failing.execute({}, ctx);
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("GDB not connected");
  });

  it("SAFE-06：destructiveHint / sideEffectTools 标副作用；读工具不标", () => {
    const hinted = adaptMcpTool(
      "lab",
      { name: "put_secret", annotations: { destructiveHint: true } },
      okCaller,
      { permission: "auto" },
    );
    expect(hinted.sideEffect).toBe(true);
    const listed = adaptMcpTool("lab", { name: "put_secret" }, okCaller, {
      permission: "auto",
      sideEffectTools: ["put_secret"],
    });
    expect(listed.sideEffect).toBe(true);
    const read = adaptMcpTool("stm32", { name: "read_memory" }, okCaller, { permission: "auto" });
    expect(read.sideEffect).toBeUndefined();
  });
});

describe("resolveMcpToolPermission", () => {
  it("按 server default → pack default → server tool → pack tool 合并", () => {
    const server = { permission: "ask" as const, toolPermissions: { read_memory: "auto" as const } };
    const pack = { permission: "auto" as const, toolPermissions: { reset_target: "ask" as const } };
    expect(resolveMcpToolPermission("read_memory", server, pack)).toBe("auto");
    expect(resolveMcpToolPermission("reset_target", server, pack)).toBe("ask");
    expect(resolveMcpToolPermission("self_check", server, pack)).toBe("auto");
    expect(resolveMcpToolPermission("unknown")).toBe("ask");
  });

  it("pack 泛化 auto 不能放宽 server 对具体工具的 ask", () => {
    expect(resolveMcpToolPermission(
      "flash_firmware",
      { permission: "auto", toolPermissions: { flash_firmware: "ask" } },
      { permission: "auto" },
    )).toBe("ask");
    // 真要覆盖必须在 pack 层逐工具点名，不能靠一个宽泛默认静默完成。
    expect(resolveMcpToolPermission(
      "flash_firmware",
      { permission: "auto", toolPermissions: { flash_firmware: "ask" } },
      { permission: "auto", toolPermissions: { flash_firmware: "auto" } },
    )).toBe("auto");
  });
});

describe("renderMcpContent", () => {
  it("text 块拼接；resource/其他类型标注占位", () => {
    const out = renderMcpContent([
      { type: "text", text: "line 1" },
      { type: "resource", resource: { uri: "mem://0x08000000" } },
      { type: "image", data: "..." },
      { type: "text", text: "line 2" },
    ]);
    expect(out).toBe("line 1\n[resource: mem://0x08000000]\n[image content]\nline 2");
  });

  it("非数组输入兜底为字符串", () => {
    expect(renderMcpContent("plain")).toBe("plain");
    expect(renderMcpContent(undefined)).toBe("");
  });
});

describe("loadMcpConfig", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "harness-mcp-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("文件不存在 → undefined（MCP 是可选能力）", async () => {
    expect(await loadMcpConfig(path.join(dir, "nope.json"))).toBeUndefined();
  });

  it("合法配置解析；缺 servers 报错", async () => {
    const good = path.join(dir, "mcp.json");
    await writeFile(
      good,
      '{"servers":{"a":{"command":"python","permission":"auto","toolPermissions":{"flash":"ask"}}}}',
      "utf8",
    );
    const cfg = await loadMcpConfig(good);
    expect(cfg?.servers["a"]?.command).toBe("python");
    expect(cfg?.servers["a"]?.permission).toBe("auto");
    expect(cfg?.servers["a"]?.toolPermissions?.["flash"]).toBe("ask");

    const bad = path.join(dir, "bad.json");
    await writeFile(bad, "{}", "utf8");
    await expect(loadMcpConfig(bad)).rejects.toThrow(/servers/);
  });

  it("非法 server/单工具权限拒绝加载，不能静默变成 auto 执行", async () => {
    const badServer = path.join(dir, "bad-server-permission.json");
    await writeFile(
      badServer,
      '{"servers":{"a":{"command":"python","permission":"always"}}}',
      "utf8",
    );
    await expect(loadMcpConfig(badServer)).rejects.toThrow(/permission must be "auto" \| "ask" \| "deny"/);

    const badTool = path.join(dir, "bad-tool-permission.json");
    await writeFile(
      badTool,
      '{"servers":{"a":{"command":"python","toolPermissions":{"flash":"always"}}}}',
      "utf8",
    );
    await expect(loadMcpConfig(badTool)).rejects.toThrow(/tool "flash" permission/);

    const badSide = path.join(dir, "bad-side-effect.json");
    await writeFile(
      badSide,
      '{"servers":{"a":{"command":"python","sideEffectTools":"erase"}}}',
      "utf8",
    );
    await expect(loadMcpConfig(badSide)).rejects.toThrow(/sideEffectTools/);

    const badRequired = path.join(dir, "bad-required-env.json");
    await writeFile(
      badRequired,
      '{"servers":{"a":{"command":"python","requiredEnv":"TOKEN"}}}',
      "utf8",
    );
    await expect(loadMcpConfig(badRequired)).rejects.toThrow(/requiredEnv/);
  });
});

describe("MCP env 展开与跳过连接", () => {
  it("${VAR} 从进程环境展开；空值回退同名变量", () => {
    const env = { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_test", PATH: "/bin" };
    expect(interpolateMcpEnvValue("${GITHUB_PERSONAL_ACCESS_TOKEN}", env)).toBe("ghp_test");
    expect(interpolateMcpEnvValue("plain", env)).toBe("plain");
    const resolved = resolveMcpServerEnv(
      { command: "x", env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_ACCESS_TOKEN}" } },
      env,
    );
    expect(resolved.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("ghp_test");
  });

  it("GITHUB_PERSONAL_ACCESS_TOKEN 空时认 AGENT_GITHUB_TOKEN / GITHUB_TOKEN", () => {
    expect(
      resolveMcpServerEnv(
        { command: "x", env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_ACCESS_TOKEN}" } },
        { AGENT_GITHUB_TOKEN: "from-agent" },
      ).GITHUB_PERSONAL_ACCESS_TOKEN,
    ).toBe("from-agent");
    expect(
      resolveMcpServerEnv(
        { command: "x", env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_ACCESS_TOKEN}" } },
        { GITHUB_TOKEN: "from-gh" },
      ).GITHUB_PERSONAL_ACCESS_TOKEN,
    ).toBe("from-gh");
  });

  it("enabled=false 或 requiredEnv 缺失 → 跳过，不拉起进程", async () => {
    expect(mcpServerSkipReason({ command: "docker", enabled: false })).toBe("disabled");
    expect(
      mcpServerSkipReason(
        { command: "docker", requiredEnv: ["GITHUB_PERSONAL_ACCESS_TOKEN"] },
        {},
      ),
    ).toBe("missing GITHUB_PERSONAL_ACCESS_TOKEN");

    const prior = {
      GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      AGENT_GITHUB_TOKEN: process.env.AGENT_GITHUB_TOKEN,
    };
    delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.AGENT_GITHUB_TOKEN;
    try {
      const runtime = await connectMcpServers({
        servers: {
          github: {
            command: "docker",
            args: ["run", "should-not-spawn"],
            requiredEnv: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
          },
        },
      });
      expect(runtime.tools).toEqual([]);
      expect(runtime.summary).toEqual({});
      expect(runtime.skipped.github).toBe("missing GITHUB_PERSONAL_ACCESS_TOKEN");
      expect(runtime.failed).toEqual({});
      await runtime.close();
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("只有会被跳过的 server 时，required 隔离不把配置当成已启用 host MCP", () => {
    expect(
      mcpConfigHasRunnableServers(
        {
          servers: {
            github: { command: "docker", requiredEnv: ["GITHUB_PERSONAL_ACCESS_TOKEN"] },
          },
        },
        {},
      ),
    ).toBe(false);
    expect(
      mcpConfigHasRunnableServers({
        servers: {
          stm32: { command: "python" },
        },
      }),
    ).toBe(true);
  });
});

describe("filterMcpConfigForPack", () => {
  const mixed = {
    servers: {
      stm32: { command: "python", includeTools: ["flash_firmware", "read_memory"] },
      github: { command: "docker", includeTools: [...GITHUB_MCP_TOOLS] },
    },
  };

  it("mcp:false → 不连", () => {
    expect(filterMcpConfigForPack(mixed, false)).toBeUndefined();
  });

  it("mcp:false + hostGithub → 只拉 github，不拉 stm32", () => {
    const sliced = filterMcpConfigForPack(mixed, false, { hostGithub: true });
    expect(Object.keys(sliced?.servers ?? {})).toEqual(["github"]);
  });

  it("无包 / 未点名 includeTools → 整份配置", () => {
    expect(filterMcpConfigForPack(mixed, undefined)?.servers).toEqual(mixed.servers);
    expect(filterMcpConfigForPack(mixed, true)?.servers).toEqual(mixed.servers);
  });

  it("ts-coding 只留 github，不把 stm32 拉起来", () => {
    const sliced = filterMcpConfigForPack(mixed, PACKS["ts-coding"]!.mcp);
    expect(Object.keys(sliced?.servers ?? {})).toEqual(["github"]);
  });

  it("stm32-debug 只留 stm32", () => {
    const sliced = filterMcpConfigForPack(mixed, PACKS["stm32-debug"]!.mcp);
    expect(Object.keys(sliced?.servers ?? {})).toEqual(["stm32"]);
  });
});

describe("仓库 mcp.json 的 GitHub 连接层", () => {
  it("includeTools / GITHUB_TOOLS / 写工具 ask 与常量同源，且不含 merge/delete", async () => {
    const cfg = await loadMcpConfig(path.resolve("mcp.json"));
    const github = cfg?.servers.github;
    expect(github).toBeDefined();
    expect(github!.requiredEnv).toEqual(["GITHUB_PERSONAL_ACCESS_TOKEN"]);
    expect(github!.env?.GITHUB_TOOLS).toBe(GITHUB_MCP_TOOLS_CSV);
    expect(github!.includeTools?.slice().sort()).toEqual([...GITHUB_MCP_TOOLS].sort());
    for (const write of GITHUB_MCP_WRITE_TOOLS) {
      expect(github!.toolPermissions?.[write]).toBe("ask");
      expect(github!.sideEffectTools).toContain(write);
    }
    expect(github!.includeTools).not.toContain("merge_pull_request");
    expect(github!.includeTools).not.toContain("delete_file");
    expect(github!.includeTools).not.toContain("push_files");
    expect(github!.includeTools).not.toContain("call");
    expect(github!.includeTools).not.toContain("batch");
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adaptMcpTool, loadMcpConfig, renderMcpContent, type McpCaller } from "../src/mcp.js";

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
    await writeFile(good, '{"servers":{"a":{"command":"python"}}}', "utf8");
    const cfg = await loadMcpConfig(good);
    expect(cfg?.servers["a"]?.command).toBe("python");

    const bad = path.join(dir, "bad.json");
    await writeFile(bad, "{}", "utf8");
    await expect(loadMcpConfig(bad)).rejects.toThrow(/servers/);
  });
});

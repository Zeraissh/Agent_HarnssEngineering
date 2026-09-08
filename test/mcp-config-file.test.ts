import { describe, expect, it } from "vitest";
import {
  applyMcpServerPatch,
  parseMcpConfigFile,
  publicMcpServers,
  redactEnv,
  serializeMcpConfig,
} from "../ui/mcp-config-file.js";

describe("mcp-config-file", () => {
  it("空文件是空表", () => {
    expect(parseMcpConfigFile("")).toEqual({ servers: {} });
  });

  it("GET 出栈时密钥类 env 打码", () => {
    expect(redactEnv({ TOKEN: "abc", HOME: "/tmp" })).toEqual({ TOKEN: "••••", HOME: "/tmp" });
  });

  it("添加需要 command 或 url", () => {
    expect(() => applyMcpServerPatch({}, "demo", {})).toThrow(/command|url/);
    const next = applyMcpServerPatch({}, "demo", { command: "python", args: ["-m", "x"] });
    expect(publicMcpServers(next)[0]).toMatchObject({
      name: "demo",
      command: "python",
      enabled: true,
    });
  });

  it("非法名拒绝，删除走 null patch", () => {
    expect(() => applyMcpServerPatch({}, "../x", { command: "a" })).toThrow(/服务名/);
    const gone = applyMcpServerPatch({ demo: { command: "a" } }, "demo", null);
    expect(gone.demo).toBeUndefined();
  });

  it("serialize 带换行，round-trip", () => {
    const text = serializeMcpConfig({ a: { command: "npx", enabled: false } });
    expect(text.endsWith("\n")).toBe(true);
    expect(parseMcpConfigFile(text).servers.a).toMatchObject({ command: "npx" });
  });
});

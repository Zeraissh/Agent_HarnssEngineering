import { describe, expect, it } from "vitest";
import { accessHintLine, isLoopbackHost, resolveUiLaunchPolicy } from "../ui/production.js";

describe("production UI launcher policy", () => {
  it("识别 IPv4/IPv6/localhost loopback，默认保留本机 bash", () => {
    for (const host of ["127.0.0.1", "127.8.9.10", "localhost", "::1", "[::1]"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    expect(resolveUiLaunchPolicy({})).toMatchObject({
      host: "127.0.0.1",
      remote: false,
      enableBash: true,
      accessToken: null,
    });
  });

  it("远程监听没有强令牌或 TLS 边界时直接拒绝启动", () => {
    expect(() => resolveUiLaunchPolicy({ AGENT_UI_HOST: "0.0.0.0" })).toThrow(/ACCESS_TOKEN/);
    expect(() => resolveUiLaunchPolicy({
      AGENT_UI_HOST: "0.0.0.0",
      AGENT_UI_ACCESS_TOKEN: "short",
      AGENT_UI_BEHIND_TLS_PROXY: "1",
    })).toThrow(/32/);
    expect(() => resolveUiLaunchPolicy({
      AGENT_UI_HOST: "0.0.0.0",
      AGENT_UI_ACCESS_TOKEN: "x".repeat(32),
    })).toThrow(/TLS termination/);
    expect(() => resolveUiLaunchPolicy({
      AGENT_UI_HOST: "0.0.0.0",
      AGENT_UI_ACCESS_TOKEN: "x".repeat(32),
      AGENT_UI_BEHIND_TLS_PROXY: "1",
    })).toThrow(/ALLOWED_ORIGINS/);
  });

  it("远程宿主默认移除 bash；显式承认后还必须 required，report/off 不得装回", () => {
    const base = {
      AGENT_UI_HOST: "0.0.0.0",
      AGENT_UI_ACCESS_TOKEN: "x".repeat(32),
      AGENT_UI_BEHIND_TLS_PROXY: "1",
      AGENT_UI_ALLOWED_ORIGINS: "https://agent.example.com",
    };
    expect(resolveUiLaunchPolicy(base)).toMatchObject({
      remote: true,
      trustProxy: true,
      enableBash: false,
    });
    expect(() => resolveUiLaunchPolicy({
      ...base,
      AGENT_UI_ALLOW_REMOTE_EXECUTION: "1",
    })).toThrow(/ISOLATION=required/);
    expect(resolveUiLaunchPolicy({
      ...base,
      AGENT_UI_ALLOW_REMOTE_EXECUTION: "1",
      AGENT_EXECUTION_ISOLATION: "required",
    }).enableBash).toBe(true);
  });
});

describe("启动横幅访问引导：令牌本体绝不进 stdout", () => {
  const token = "t".repeat(40);
  const localUrl = "http://127.0.0.1:4173";

  it("loopback + 令牌：给占位符引导行，且行内不含令牌本体", () => {
    const policy = resolveUiLaunchPolicy({ AGENT_UI_ACCESS_TOKEN: token });
    const line = accessHintLine(policy, localUrl);
    expect(line).toBeDefined();
    expect(line).toContain("access_token=");
    expect(line).toContain("AGENT_UI_ACCESS_TOKEN");
    // 变异自检的核心断言：把实现改回打印真令牌，这里立即红
    expect(line).not.toContain(token);
  });

  it("无令牌：没有引导行", () => {
    expect(accessHintLine(resolveUiLaunchPolicy({}), localUrl)).toBeUndefined();
  });

  it("远程模式：不从本机 stdout 引导（引导 URL 属于部署流程，不属于容器日志）", () => {
    const policy = resolveUiLaunchPolicy({
      AGENT_UI_HOST: "0.0.0.0",
      AGENT_UI_ACCESS_TOKEN: token,
      AGENT_UI_BEHIND_TLS_PROXY: "1",
      AGENT_UI_ALLOWED_ORIGINS: "https://agent.example.com",
    });
    expect(accessHintLine(policy, localUrl)).toBeUndefined();
  });
});

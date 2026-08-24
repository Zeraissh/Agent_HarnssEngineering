import { describe, expect, it } from "vitest";
import { isLoopbackHost, resolveUiLaunchPolicy } from "../ui/production.js";

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

  it("远程宿主默认移除 bash；只有显式承认远程执行面才装回", () => {
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
    expect(resolveUiLaunchPolicy({
      ...base,
      AGENT_UI_ALLOW_REMOTE_EXECUTION: "1",
    }).enableBash).toBe(true);
  });
});

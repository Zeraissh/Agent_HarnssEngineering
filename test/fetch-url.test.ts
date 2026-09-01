import type { LookupAddress } from "node:dns";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  collectHttpsResponse,
  createFetchUrlTool,
  isPublicIpAddress,
} from "../src/tools/fetch-url.js";

const ctx = () => ({
  workdir: process.cwd(),
  toolUseId: "tu_fetch",
  signal: new AbortController().signal,
});

describe("fetch_url public-network boundary", () => {
  it("拒绝非 HTTPS、URL 凭据、localhost 与 IP 字面量私网", async () => {
    const requestOnce = vi.fn();
    const tool = createFetchUrlTool({ requestOnce });

    for (const url of [
      "http://example.com",
      "https://user:pass@example.com",
      "https://localhost/admin",
      "https://127.0.0.1/admin",
      "https://2130706433/admin",
      "https://0x7f000001/admin",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.1",
      "https://[::1]/",
      "https://[::ffff:127.0.0.1]/",
      "https://[fd00::1]/",
    ]) {
      const result = await tool.execute({ url }, ctx());
      expect(result.isError, url).toBe(true);
    }
    expect(requestOnce).not.toHaveBeenCalled();
  });

  it("拒绝 DNS 返回私网，混合公网/私网也 fail closed", async () => {
    const requestOnce = vi.fn();
    const lookup = vi.fn(async (): Promise<LookupAddress[]> => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ]);
    const tool = createFetchUrlTool({ lookup, requestOnce });
    const result = await tool.execute({ url: "https://example.test/a" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/non-public/i);
    expect(requestOnce).not.toHaveBeenCalled();
  });

  it("每次重定向重新做 DNS 检查，拒绝跳往私网", async () => {
    const lookup = vi.fn(async (hostname: string): Promise<LookupAddress[]> =>
      hostname === "public.test"
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "192.168.1.9", family: 4 }],
    );
    const requestOnce = vi.fn(async (_url: URL, _address: LookupAddress, _signal: AbortSignal) => ({
      status: 302,
      statusText: "Found",
      headers: { location: "https://internal.test/secret" },
      body: "",
    }));
    const tool = createFetchUrlTool({ lookup, requestOnce });
    const result = await tool.execute({ url: "https://public.test/start" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/non-public/i);
    expect(requestOnce).toHaveBeenCalledTimes(1);
  });

  it("重定向不能降级到 HTTP 或注入 URL 凭据", async () => {
    const lookup = vi.fn(async (): Promise<LookupAddress[]> => [
      { address: "93.184.216.34", family: 4 },
    ]);
    for (const location of ["http://example.test/plain", "https://user:pass@example.test/"]) {
      const requestOnce = vi.fn(async () => ({
        status: 302,
        statusText: "Found",
        headers: { location },
        body: "",
      }));
      const result = await createFetchUrlTool({ lookup, requestOnce }).execute(
        { url: "https://example.test/start" },
        ctx(),
      );
      expect(result.isError, location).toBe(true);
      expect(requestOnce).toHaveBeenCalledTimes(1);
    }
  });

  it("把已验证的公网地址传给请求层并保留 HTML 提取行为", async () => {
    const lookup = vi.fn(async (): Promise<LookupAddress[]> => [
      { address: "93.184.216.34", family: 4 },
    ]);
    const requestOnce = vi.fn(async (_url: URL, _address: LookupAddress, _signal: AbortSignal) => ({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/html; charset=utf-8" },
      body: "<style>x{}</style><h1>Hello</h1><script>secret()</script><p>World</p>",
    }));
    const tool = createFetchUrlTool({ lookup, requestOnce });
    const result = await tool.execute({ url: "https://example.test/page" }, ctx());
    expect(result).toEqual({ content: "Hello World" });
    expect(requestOnce).toHaveBeenCalledTimes(1);
    expect(requestOnce.mock.calls[0]?.[1]).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("限制重定向次数", async () => {
    const lookup = vi.fn(async (): Promise<LookupAddress[]> => [
      { address: "93.184.216.34", family: 4 },
    ]);
    const requestOnce = vi.fn(async () => ({
      status: 302,
      statusText: "Found",
      headers: { location: "/again" },
      body: "",
    }));
    const result = await createFetchUrlTool({ lookup, requestOnce }).execute(
      { url: "https://example.test/start" },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Too many redirects");
    expect(requestOnce).toHaveBeenCalledTimes(6);
  });

  it("DNS lookup 卡住时仍响应 ctx abort，不会永久挂起", async () => {
    const controller = new AbortController();
    const lookup = vi.fn(() => new Promise<LookupAddress[]>(() => {}));
    const requestOnce = vi.fn();
    const pending = createFetchUrlTool({ lookup, requestOnce }).execute(
      { url: "https://resolver-stuck.test/" },
      { ...ctx(), signal: controller.signal },
    );
    controller.abort(new Error("operator cancelled"));
    await expect(pending).resolves.toMatchObject({ isError: true, content: "operator cancelled" });
    expect(requestOnce).not.toHaveBeenCalled();
  });
});

function fakeIncomingResponse(): IncomingMessage & EventEmitter {
  const res = new EventEmitter() as IncomingMessage & EventEmitter;
  Object.assign(res, {
    statusCode: 200,
    statusMessage: "OK",
    headers: { "content-type": "text/plain" },
    complete: false,
  });
  return res;
}

describe("collectHttpsResponse transport completion", () => {
  it("正常 end 返回完整响应", async () => {
    const res = fakeIncomingResponse();
    const pending = collectHttpsResponse(res, vi.fn());
    res.emit("data", Buffer.from("hello "));
    res.emit("data", "world");
    res.complete = true;
    res.emit("end");
    await expect(pending).resolves.toMatchObject({ status: 200, body: "hello world" });
  });

  it("headers 后 aborted 或非完整 close 都会拒绝，不再悬挂", async () => {
    for (const event of ["aborted", "close"] as const) {
      const res = fakeIncomingResponse();
      const pending = collectHttpsResponse(res, vi.fn());
      res.emit("data", "partial");
      res.emit(event);
      await expect(pending, event).rejects.toThrow(/before completion/i);
    }
  });

  it("超过网络响应上限会立即拒绝并销毁请求", async () => {
    const res = fakeIncomingResponse();
    const abortRequest = vi.fn();
    const pending = collectHttpsResponse(res, abortRequest);
    res.emit("data", Buffer.alloc(1_000_001));
    await expect(pending).rejects.toThrow(/exceeds/);
    expect(abortRequest).toHaveBeenCalledTimes(1);
  });
});

describe("isPublicIpAddress", () => {
  it("接受公网 IPv4/IPv6", () => {
    expect(isPublicIpAddress("8.8.8.8")).toBe(true);
    expect(isPublicIpAddress("93.184.216.34")).toBe(true);
    expect(isPublicIpAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("拒绝非公网和特殊地址", () => {
    for (const address of [
      "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1",
      "172.16.0.1", "192.168.1.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
      "::", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "ff02::1",
      "2001:db8::1", "2001::1", "2002:7f00:1::",
    ]) {
      expect(isPublicIpAddress(address), address).toBe(false);
    }
  });
});

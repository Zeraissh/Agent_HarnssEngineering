import { isIP } from "node:net";

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  return isIP(host) === 4 && host.split(".")[0] === "127";
}

export interface ProviderEndpointInspection {
  valid: boolean;
  origin: string;
  reason?: "invalid-url" | "userinfo" | "query-or-fragment" | "insecure-transport";
}

/**
 * 模型凭据会随请求发送；远程端点只准 HTTPS，HTTP 仅准精确 loopback。
 * query/fragment 和 URL userinfo 都拒绝，避免 token 藏在配置/错误文本里。
 */
export function inspectProviderEndpoint(raw: string): ProviderEndpointInspection {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { valid: false, origin: "<invalid>", reason: "invalid-url" };
  }
  if (parsed.username || parsed.password) {
    return { valid: false, origin: "<invalid>", reason: "userinfo" };
  }
  if (parsed.search || parsed.hash) {
    return { valid: false, origin: "<invalid>", reason: "query-or-fragment" };
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))) {
    return { valid: false, origin: "<invalid>", reason: "insecure-transport" };
  }
  return { valid: true, origin: parsed.origin };
}

export function assertSafeProviderEndpoint(raw: string | undefined, fieldName: string): void {
  if (raw === undefined || raw.trim() === "") return;
  const inspected = inspectProviderEndpoint(raw.trim());
  if (!inspected.valid) {
    // 不回显 raw；配置里可能含 URL userinfo/query token 或终端控制字符。
    throw new Error(
      `${fieldName} 无效：远程端点必须使用 HTTPS，HTTP 只允许 loopback，且不能包含 userinfo/query/fragment`,
    );
  }
}

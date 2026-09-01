/**
 * 领域工具试点（v0.4）：网页抓取。
 *
 * 安全边界：只允许公网 HTTPS；每次重定向都重新解析并校验目标。生产请求通过
 * https.request 直接连接到已校验地址，避免“先查公网、连接时换成私网”
 * 的 DNS rebinding 窗口。GET 仍可能外泄查询串，故权限保持 ask。
 */
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Tool } from "../types.js";
import { truncate } from "./fs-util.js";

const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 1_000_000;

interface FetchResponse {
  status: number;
  statusText: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface FetchUrlDependencies {
  lookup(hostname: string, signal: AbortSignal): Promise<LookupAddress[]>;
  requestOnce(url: URL, address: LookupAddress, signal: AbortSignal): Promise<FetchResponse>;
}

const defaultDependencies: FetchUrlDependencies = {
  lookup: async (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
  requestOnce: requestPinnedHttps,
};

/** 可注入网络边界，便于不用真实外网就覆盖 SSRF、重定向和 DNS pinning。 */
export function createFetchUrlTool(
  overrides: Partial<FetchUrlDependencies> = {},
): Tool {
  const deps = { ...defaultDependencies, ...overrides };
  return {
    name: "fetch_url",
    description:
      "Fetch the text content of a public https:// URL. Call this when the task requires information from a specific web page. Returns the page text with HTML tags stripped (scripts/styles removed). Not a search engine — you must already know the URL.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The public https:// URL to fetch" },
      },
      required: ["url"],
    },
    permission: "ask",
    parallelSafe: true,
    // 网络读取可在短窗口内复用完全相同 URL，但仍受宿主 TTL/次数双重上限。
    approvalPolicy: { maxScope: "exact-input", maxTtlMs: 10 * 60_000, maxUses: 5 },
    async execute(input, ctx) {
      const { url } = input as { url: string };
      let target: URL;
      try {
        target = parsePublicHttpsUrl(url);
      } catch (err) {
        return { content: errorMessage(err), isError: true };
      }

      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const signal = AbortSignal.any([ctx.signal, timeout]);

      try {
        for (let redirects = 0; ; redirects++) {
          const address = await resolvePublicAddress(target.hostname, deps.lookup, signal);
          const res = await deps.requestOnce(target, address, signal);

          if (isRedirect(res.status)) {
            const location = headerValue(res.headers, "location");
            if (!location) {
              return {
                content: `HTTP ${res.status} redirect without Location for ${target.href}`,
                isError: true,
              };
            }
            if (redirects >= MAX_REDIRECTS) {
              return { content: `Too many redirects (max ${MAX_REDIRECTS}).`, isError: true };
            }
            target = parsePublicHttpsUrl(new URL(location, target).href);
            continue;
          }

          if (res.status < 200 || res.status >= 300) {
            return {
              content: `HTTP ${res.status} ${res.statusText} for ${target.href}`,
              isError: true,
            };
          }

          const contentType = headerValue(res.headers, "content-type") ?? "";
          const text = contentType.includes("html") ? stripHtml(res.body) : res.body;
          return { content: truncate(text, 20_000) || "(empty response)" };
        }
      } catch (err) {
        return { content: errorMessage(err), isError: true };
      }
    },
  };
}

export const fetchUrlTool: Tool = createFetchUrlTool();

function parsePublicHttpsUrl(raw: unknown): URL {
  if (typeof raw !== "string") {
    throw new Error('Invalid input: expected {"url": "https://..."} (https only).');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid input: expected {"url": "https://..."} (https only).');
  }
  if (url.protocol !== "https:") {
    throw new Error('Invalid input: expected {"url": "https://..."} (https only).');
  }
  if (url.username || url.password) {
    throw new Error("Refusing URL credentials in fetch_url target.");
  }
  if (!url.hostname) throw new Error("Refusing URL without a hostname.");
  return url;
}

async function resolvePublicAddress(
  rawHostname: string,
  lookup: FetchUrlDependencies["lookup"],
  signal: AbortSignal,
): Promise<LookupAddress> {
  const hostname = stripIpv6Brackets(rawHostname);
  if (hostname.toLowerCase() === "localhost" || hostname.toLowerCase().endsWith(".localhost")) {
    throw new Error(`Refusing non-public fetch_url host: ${rawHostname}`);
  }

  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await waitForAbortable(lookup(hostname, signal), signal);
  if (addresses.length === 0) {
    throw new Error(`No address found for fetch_url host: ${rawHostname}`);
  }

  // 混合返回中只要出现私网就整组拒绝：不能让 DNS 顺序或平台差异改变安全结果。
  const unsafe = addresses.find((entry) => !isPublicIpAddress(entry.address));
  if (unsafe) {
    throw new Error(`Refusing non-public fetch_url address for ${rawHostname}: ${unsafe.address}`);
  }
  return addresses[0]!;
}

/** dns.promises.lookup 本身没有 AbortSignal；用统一闸门确保宿主取消/超时仍能收口。 */
function waitForAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Operation aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Operation aborted"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** 仅接受可路由公网 IPv4 或 IPv6 global-unicast。 */
export function isPublicIpAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address).split("%")[0]!;
  const family = isIP(normalized);
  if (family === 4) return isPublicIpv4(normalized);
  if (family !== 6) return false;

  const value = ipv6ToBigInt(normalized);
  if (value === undefined) return false;
  // IPv6 公网单播大范围为 2000::/3；另拒绝文档、Teredo 与 6to4 等特殊前缀。
  if (!inIpv6Cidr(value, 0x2000n << 112n, 3)) return false;
  if (inIpv6Cidr(value, 0x20010db8n << 96n, 32)) return false; // documentation
  if (inIpv6Cidr(value, 0x20010000n << 96n, 32)) return false; // Teredo
  if (inIpv6Cidr(value, 0x2002n << 112n, 16)) return false; // 6to4
  return true;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false; // documentation
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmark
  if (a === 198 && b === 51 && c === 100) return false; // documentation
  if (a === 203 && b === 0 && c === 113) return false; // documentation
  return true;
}

function ipv6ToBigInt(address: string): bigint | undefined {
  let source = address.toLowerCase();
  const ipv4Tail = source.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail) {
    if (!isIP(ipv4Tail)) return undefined;
    const octets = ipv4Tail.split(".").map(Number);
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    source = `${source.slice(0, -ipv4Tail.length)}${high}:${low}`;
  }

  const halves = source.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8) return undefined;

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    value = (value << 16n) | BigInt(`0x${group}`);
  }
  return value;
}

function inIpv6Cidr(value: bigint, network: bigint, prefix: number): boolean {
  const shift = BigInt(128 - prefix);
  return value >> shift === network >> shift;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function requestPinnedHttps(
  url: URL,
  address: LookupAddress,
  signal: AbortSignal,
): Promise<FetchResponse> {
  return new Promise((resolve, reject) => {
    const tlsHostname = stripIpv6Brackets(url.hostname);
    const req = httpsRequest(
      {
        protocol: "https:",
        hostname: address.address,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        signal,
        family: address.family,
        headers: {
          host: url.host,
          "user-agent": "agent-harness/1.2 (+https://github.com/Zeraissh/Agent_HarnssEngineering)",
          "accept-encoding": "identity",
        },
        // TCP 直连已校验 IP；域名目标的 TLS SNI/证书校验与 HTTP Host 仍用原域名。
        // IP literal 不发送 SNI（RFC 6066 禁止 IP ServerName），证书仍按该 IP 校验。
        ...(isIP(tlsHostname) === 0 ? { servername: tlsHostname } : {}),
      },
      (res) => {
        collectHttpsResponse(res, (error) => req.destroy(error)).then(resolve, reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * 完整读取一条 HTTPS 响应。headers 到达后 request 可能已 close；因此必须监听
 * IncomingMessage 自己的 aborted/error/提前 close，不能只等一个可能永远不来的 end。
 */
export function collectHttpsResponse(
  res: IncomingMessage,
  abortRequest: (error: Error) => void,
): Promise<FetchResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const complete = () => {
      if (settled) return;
      settled = true;
      resolve({
        status: res.statusCode ?? 0,
        statusText: res.statusMessage ?? "",
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
    };

    res.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_RESPONSE_BYTES) {
        const error = new Error(`fetch_url response exceeds ${MAX_RESPONSE_BYTES} bytes.`);
        fail(error);
        abortRequest(error);
        return;
      }
      chunks.push(buffer);
    });
    res.once("end", complete);
    res.once("aborted", () => fail(new Error("fetch_url response aborted before completion.")));
    res.once("error", fail);
    res.once("close", () => {
      if (!settled && !res.complete) {
        fail(new Error("fetch_url response closed before completion."));
      }
    });
  });
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 朴素去标签：对工具试点足够；正经抽取（readability 等）是后续能力。 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

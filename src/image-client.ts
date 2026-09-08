/**
 * OpenAI 兼容 Images API 客户端（生图角色）。
 *
 * 这不是 ModelClient：chat/completions 与 /images/generations 是两条线。
 * 识图（describe_image）走 send() 塞图像块；生图必须打独立端点，
 * 再把字节写进工作目录。未配置角色时工具根本不进池——与 describe_image 同纪律。
 */
import { isLoopbackHostname, inspectProviderEndpoint, assertSafeProviderEndpoint } from "./provider-config.js";
import type { ProviderEndpointInspection } from "./provider-config.js";

export const DEFAULT_OPENAI_IMAGE_BASE = "https://api.openai.com/v1";
export const DEFAULT_IMAGE_SIZE = "1024x1024";
export const IMAGE_GEN_MAX_BYTES = 15_000_000;

export interface ImageGenRequest {
  prompt: string;
  size?: string;
  signal?: AbortSignal;
}

export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp";

export interface ImageGenResult {
  bytes: Buffer;
  mediaType: ImageMediaType;
  revisedPrompt?: string;
}

export interface ImageGenClient {
  generate(req: ImageGenRequest): Promise<ImageGenResult>;
}

export function imageGenerationsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (/\/images\/generations$/i.test(trimmed)) return trimmed;
  return `${trimmed}/images/generations`;
}

/** 签名 CDN 允许 query；仍拒 userinfo / 非 HTTPS（loopback http 除外）。 */
export function inspectImageFetchUrl(raw: string): ProviderEndpointInspection {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { valid: false, origin: "<invalid>", reason: "invalid-url" };
  }
  if (parsed.username || parsed.password) {
    return { valid: false, origin: "<invalid>", reason: "userinfo" };
  }
  if (parsed.hash) {
    return { valid: false, origin: "<invalid>", reason: "query-or-fragment" };
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))) {
    return { valid: false, origin: "<invalid>", reason: "insecure-transport" };
  }
  return { valid: true, origin: parsed.origin };
}

export function detectImageMediaType(bytes: Buffer): ImageMediaType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export interface ParsedImageGeneration {
  b64?: string;
  url?: string;
  revisedPrompt?: string;
}

export function parseImageGenerationResponse(json: unknown): ParsedImageGeneration {
  if (!json || typeof json !== "object") {
    throw new Error("Image API returned a non-object body");
  }
  const o = json as Record<string, unknown>;
  if (o.error && typeof o.error === "object") {
    const msg = (o.error as { message?: unknown }).message;
    throw new Error(typeof msg === "string" && msg.trim() ? msg : "Image API returned an error");
  }
  const data = o.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Image API returned no images");
  }
  const first = data[0];
  if (!first || typeof first !== "object") {
    throw new Error("Image API returned an empty image slot");
  }
  const item = first as Record<string, unknown>;
  const b64 = typeof item.b64_json === "string" && item.b64_json ? item.b64_json : undefined;
  const url = typeof item.url === "string" && item.url ? item.url : undefined;
  const revisedPrompt = typeof item.revised_prompt === "string" ? item.revised_prompt : undefined;
  if (!b64 && !url) {
    throw new Error("Image API returned neither b64_json nor url");
  }
  return { b64, url, revisedPrompt };
}

export interface OpenAIImageClientOptions {
  model: string;
  baseURL?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

function apiErrorMessage(status: number, bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: unknown } };
    const msg = parsed.error?.message;
    if (typeof msg === "string" && msg.trim()) return `Image API HTTP ${status}: ${msg}`;
  } catch {
    /* 非 JSON 错误体 */
  }
  return `Image API HTTP ${status}`;
}

export function createOpenAIImageClient(opts: OpenAIImageClientOptions): ImageGenClient {
  const baseURL = (opts.baseURL?.trim() || DEFAULT_OPENAI_IMAGE_BASE).replace(/\/+$/, "");
  assertSafeProviderEndpoint(baseURL, "AGENT_IMAGE_BASE_URL");
  const inspected = inspectProviderEndpoint(baseURL);
  if (!inspected.valid) {
    throw new Error("AGENT_IMAGE_BASE_URL 无效：远程端点必须使用 HTTPS，HTTP 只允许 loopback");
  }
  const endpoint = imageGenerationsUrl(baseURL);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const fetchImpl = opts.fetch ?? fetch;
  const model = opts.model;
  const apiKey = opts.apiKey ?? "";

  return {
    async generate(req: ImageGenRequest): Promise<ImageGenResult> {
      const prompt = req.prompt.trim();
      if (!prompt) throw new Error("Image prompt is empty");
      if (!apiKey) {
        throw new Error(
          `Image model${model ? ` (${model})` : ""} has no API key. Set AGENT_IMAGE_API_KEY or the model entry key.`,
        );
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const signal = req.signal
        ? AbortSignal.any([req.signal, controller.signal])
        : controller.signal;
      try {
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            prompt,
            n: 1,
            size: req.size ?? DEFAULT_IMAGE_SIZE,
            response_format: "b64_json",
          }),
          signal,
        });
        const text = await res.text();
        if (!res.ok) throw new Error(apiErrorMessage(res.status, text));
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error("Image API returned non-JSON");
        }
        const parsed = parseImageGenerationResponse(json);
        let bytes: Buffer;
        if (parsed.b64) {
          bytes = Buffer.from(parsed.b64, "base64");
        } else {
          bytes = await fetchImageBytes(parsed.url!, fetchImpl, signal);
        }
        if (bytes.length === 0) throw new Error("Image API returned empty image bytes");
        if (bytes.length > IMAGE_GEN_MAX_BYTES) {
          throw new Error(`Generated image exceeds the ${(IMAGE_GEN_MAX_BYTES / 1_000_000).toFixed(0)}MB limit`);
        }
        const mediaType = detectImageMediaType(bytes) ?? "image/png";
        return {
          bytes,
          mediaType,
          ...(parsed.revisedPrompt ? { revisedPrompt: parsed.revisedPrompt } : {}),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function fetchImageBytes(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<Buffer> {
  const first = inspectImageFetchUrl(url);
  if (!first.valid) {
    throw new Error("Image API url is not a safe https endpoint");
  }
  let res = await fetchImpl(url, { method: "GET", signal, redirect: "manual" });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (!location) throw new Error(`Image URL redirect HTTP ${res.status} without Location`);
    const next = new URL(location, url).href;
    if (!inspectImageFetchUrl(next).valid) {
      throw new Error("Image URL redirected to an unsafe endpoint");
    }
    res = await fetchImpl(next, { method: "GET", signal, redirect: "manual" });
  }
  if (!res.ok) throw new Error(`Image URL fetch HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > IMAGE_GEN_MAX_BYTES) {
    throw new Error(`Downloaded image exceeds the ${(IMAGE_GEN_MAX_BYTES / 1_000_000).toFixed(0)}MB limit`);
  }
  return buf;
}

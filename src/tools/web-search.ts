/**
 * web_search —— 公网检索（可选装配）。
 *
 * 为什么是条件性工具（同 describe_image）：没有检索 key 时**不进工具面**，
 * 而不是摆一个一调用就报错的空壳——空壳会诱导模型反复重试并把失败归咎于自己。
 *
 * 默认走 Tavily REST（AGENT_TAVILY_API_KEY / TAVILY_API_KEY）。注入 `search`
 * 便于单测不碰外网。返回里带 URL 列表，供 consult 包先 search 再 fetch_url。
 */
import type { Tool } from "../types.js";

export const WEB_SEARCH_TOOL_NAME = "web_search";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_CAP = 10;
const TIMEOUT_MS = 20_000;

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  query: string;
  results: WebSearchHit[];
  images?: Array<{ url: string; description?: string }>;
}

export interface WebSearchDependencies {
  search(query: string, opts: { maxResults: number; includeImages: boolean; signal: AbortSignal }): Promise<WebSearchResult>;
}

function tavilyKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = (env.AGENT_TAVILY_API_KEY ?? env.TAVILY_API_KEY ?? "").trim();
  return key || undefined;
}

/** 宿主装配前探测：没 key = 工具不在场。 */
export function isWebSearchConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(tavilyKeyFromEnv(env));
}

async function tavilySearch(
  apiKey: string,
  query: string,
  opts: { maxResults: number; includeImages: boolean; signal: AbortSignal },
): Promise<WebSearchResult> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query,
      max_results: opts.maxResults,
      search_depth: "basic",
      include_images: opts.includeImages,
      include_image_descriptions: opts.includeImages,
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Tavily HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
    images?: Array<string | { url?: string; description?: string }>;
  };
  const results: WebSearchHit[] = (data.results ?? [])
    .filter((r) => typeof r.url === "string" && /^https:\/\//i.test(r.url))
    .map((r) => ({
      title: String(r.title ?? "").trim() || r.url!,
      url: r.url!,
      snippet: String(r.content ?? "").trim().slice(0, 600),
    }));
  const images = (data.images ?? [])
    .map((img) => {
      if (typeof img === "string") return { url: img };
      if (img && typeof img.url === "string") {
        return { url: img.url, ...(img.description ? { description: String(img.description) } : {}) };
      }
      return null;
    })
    .filter((x): x is { url: string; description?: string } => Boolean(x?.url?.startsWith("https://")));
  return {
    query,
    results,
    ...(images.length ? { images } : {}),
  };
}

export function createWebSearchTool(overrides: Partial<WebSearchDependencies> = {}): Tool {
  const apiKey = tavilyKeyFromEnv();
  const deps: WebSearchDependencies = {
    search:
      overrides.search ??
      (async (query, opts) => {
        if (!apiKey) throw new Error("web_search is not configured (set AGENT_TAVILY_API_KEY).");
        return tavilySearch(apiKey, query, opts);
      }),
  };

  return {
    name: WEB_SEARCH_TOOL_NAME,
    description:
      "Search the public web for sources. Returns titled HTTPS URLs with short snippets " +
      "(and optional related image URLs). Use this when you do not already know the page URL; " +
      "then call fetch_url on the best sources before stating facts. Not a substitute for reading the page.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query in the user's language when possible" },
        max_results: {
          type: "number",
          description: `How many hits to return (1–${MAX_RESULTS_CAP}, default ${DEFAULT_MAX_RESULTS})`,
        },
        include_images: {
          type: "boolean",
          description: "Also return related image URLs when the user asked for illustrations (default false)",
        },
      },
      required: ["query"],
    },
    permission: "ask",
    parallelSafe: true,
    approvalPolicy: { maxScope: "exact-input", maxTtlMs: 10 * 60_000, maxUses: 8 },
    async execute(input, ctx) {
      const { query, max_results: maxResultsRaw, include_images: includeImagesRaw } = input as {
        query?: unknown;
        max_results?: unknown;
        include_images?: unknown;
      };
      if (typeof query !== "string" || !query.trim()) {
        return { content: 'Invalid input: expected {"query": string}.', isError: true };
      }
      if (maxResultsRaw !== undefined && typeof maxResultsRaw !== "number") {
        return { content: "max_results must be a number when provided.", isError: true };
      }
      if (includeImagesRaw !== undefined && typeof includeImagesRaw !== "boolean") {
        return { content: "include_images must be a boolean when provided.", isError: true };
      }
      const maxResults = Math.min(
        MAX_RESULTS_CAP,
        Math.max(1, Math.floor(maxResultsRaw ?? DEFAULT_MAX_RESULTS)),
      );
      const includeImages = includeImagesRaw === true;
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const signal = AbortSignal.any([ctx.signal, timeout]);
      try {
        const found = await deps.search(query.trim(), { maxResults, includeImages, signal });
        found.results = found.results.filter((r) => /^https:\/\//i.test(r.url));
        if (found.images) {
          found.images = found.images.filter((img) => /^https:\/\//i.test(img.url));
        }
        if (found.results.length === 0 && !(found.images && found.images.length)) {
          return {
            content: `No HTTPS results for ${JSON.stringify(found.query)}. Try a narrower query, or mark claims as 未核实.`,
          };
        }
        const lines: string[] = [`query: ${found.query}`, `hits: ${found.results.length}`];
        found.results.forEach((r, i) => {
          lines.push(`${i + 1}. ${r.title}`);
          lines.push(`   url: ${r.url}`);
          if (r.snippet) lines.push(`   snippet: ${r.snippet}`);
        });
        if (found.images?.length) {
          lines.push(`images: ${found.images.length}`);
          found.images.slice(0, 8).forEach((img, i) => {
            lines.push(`  img${i + 1}: ${img.url}`);
            if (img.description) lines.push(`        ${img.description}`);
          });
        }
        lines.push(
          "Next: fetch_url the pages you will cite. Do not invent URLs. Image Markdown: " +
            '![caption](https://image… "https://source-page…")',
        );
        return { content: lines.join("\n") };
      } catch (err) {
        return {
          content: `web_search failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

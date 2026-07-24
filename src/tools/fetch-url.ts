/**
 * 领域工具试点（v0.4）：网页抓取。
 * 验证目标：新增领域能力只需实现 Tool 接口 —— L0/L1/L3 零改动。
 *
 * 安全考量：GET 也有外泄面（模型可把数据拼进查询串发给任意主机），
 * 故默认 permission: "ask"，由宿主审批放行。
 */
import type { Tool } from "../types.js";
import { truncate } from "./fs-util.js";

const TIMEOUT_MS = 20_000;

export const fetchUrlTool: Tool = {
  name: "fetch_url",
  description:
    "Fetch the text content of a public https:// URL. Call this when the task requires information from a specific web page. Returns the page text with HTML tags stripped (scripts/styles removed). Not a search engine — you must already know the URL.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The https:// URL to fetch" },
    },
    required: ["url"],
  },
  permission: "ask",
  parallelSafe: true,
  async execute(input, ctx) {
    const { url } = input as { url: string };
    if (typeof url !== "string" || !url.startsWith("https://")) {
      return { content: 'Invalid input: expected {"url": "https://..."} (https only).', isError: true };
    }

    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = AbortSignal.any([ctx.signal, timeout]);
    const res = await fetch(url, {
      signal,
      redirect: "follow",
      headers: { "user-agent": "agent-harness/0.4 (+https://github.com/Zeraissh/Agent_HarnssEngineering)" },
    });
    if (!res.ok) {
      return { content: `HTTP ${res.status} ${res.statusText} for ${url}`, isError: true };
    }

    const contentType = res.headers.get("content-type") ?? "";
    const body = await res.text();
    const text = contentType.includes("html") ? stripHtml(body) : body;
    return { content: truncate(text, 20_000) || "(empty response)" };
  },
};

/** 朴素去标签：对 v0.4 试点足够；正经抽取（readability 等）是后续工具的事 */
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

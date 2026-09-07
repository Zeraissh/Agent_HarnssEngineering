import { describe, expect, it, vi } from "vitest";
import { createWebSearchTool, isWebSearchConfigured } from "../src/tools/web-search.js";

describe("web_search", () => {
  it("isWebSearchConfigured 认 AGENT_TAVILY_API_KEY / TAVILY_API_KEY", () => {
    expect(isWebSearchConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isWebSearchConfigured({ AGENT_TAVILY_API_KEY: "tvly-x" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isWebSearchConfigured({ TAVILY_API_KEY: "tvly-y" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("把 HTTPS 命中格式化成可交给 fetch_url 的列表", async () => {
    const tool = createWebSearchTool({
      search: async (query) => ({
        query,
        results: [
          { title: "NIST note", url: "https://nist.gov/a", snippet: "cold junction" },
          { title: "bad", url: "http://insecure.example/", snippet: "skip" },
        ],
        images: [{ url: "https://cdn.example.com/fig.png", description: "diagram" }],
      }),
    });
    const out = await tool.execute({ query: "K type thermocouple", include_images: true }, {
      workdir: process.cwd(),
      toolUseId: "tu_test_search",
      signal: new AbortController().signal,
    });
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("https://nist.gov/a");
    expect(out.content).not.toContain("http://insecure");
    expect(out.content).toContain("https://cdn.example.com/fig.png");
    expect(out.content).toMatch(/fetch_url/);
  });

  it("空 query 拒", async () => {
    const tool = createWebSearchTool({ search: vi.fn() });
    const out = await tool.execute({ query: "  " }, {
      workdir: process.cwd(),
      toolUseId: "tu_test_empty",
      signal: new AbortController().signal,
    });
    expect(out.isError).toBe(true);
  });
});

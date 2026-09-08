import { describe, expect, it } from "vitest";
import {
  createOpenAIImageClient,
  detectImageMediaType,
  imageGenerationsUrl,
  inspectImageFetchUrl,
  parseImageGenerationResponse,
} from "../src/image-client.js";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_B64, "base64");

describe("imageGenerationsUrl", () => {
  it("在 …/v1 后接 /images/generations；已带路径则原样", () => {
    expect(imageGenerationsUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/images/generations",
    );
    expect(imageGenerationsUrl("https://api.openai.com/v1/")).toBe(
      "https://api.openai.com/v1/images/generations",
    );
    expect(imageGenerationsUrl("https://api.openai.com/v1/images/generations")).toBe(
      "https://api.openai.com/v1/images/generations",
    );
  });
});

describe("parseImageGenerationResponse", () => {
  it("优先 b64_json", () => {
    expect(parseImageGenerationResponse({ data: [{ b64_json: "abc", url: "https://x" }] })).toEqual({
      b64: "abc",
      url: "https://x",
      revisedPrompt: undefined,
    });
  });

  it("只有 url 也能用；error.message 写给调用方", () => {
    expect(parseImageGenerationResponse({ data: [{ url: "https://cdn.example/a.png" }] }).url)
      .toBe("https://cdn.example/a.png");
    expect(() => parseImageGenerationResponse({ error: { message: "billing hard limit" } }))
      .toThrow(/billing hard limit/);
    expect(() => parseImageGenerationResponse({ data: [] })).toThrow(/no images/);
  });
});

describe("inspectImageFetchUrl / detectImageMediaType", () => {
  it("签名 URL 的 query 放行；userinfo 与远程 http 拒绝", () => {
    expect(inspectImageFetchUrl("https://cdn.example/img.png?sig=1").valid).toBe(true);
    expect(inspectImageFetchUrl("https://user:pass@cdn.example/img.png").valid).toBe(false);
    expect(inspectImageFetchUrl("http://8.8.8.8/img.png").valid).toBe(false);
    expect(inspectImageFetchUrl("http://127.0.0.1:9/img.png").valid).toBe(true);
  });

  it("按魔数认 png/jpeg", () => {
    expect(detectImageMediaType(PNG)).toBe("image/png");
    expect(detectImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe("image/jpeg");
    expect(detectImageMediaType(Buffer.from("not-an-image"))).toBeNull();
  });
});

describe("createOpenAIImageClient", () => {
  it("POST /images/generations，Authorization 带 key，吃 b64_json", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = createOpenAIImageClient({
      model: "dall-e-3",
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-test",
      fetch: async (url, init) => {
        seen.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64, revised_prompt: "a pixel" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const out = await client.generate({ prompt: "a red square" });
    expect(out.mediaType).toBe("image/png");
    expect(out.bytes.equals(PNG)).toBe(true);
    expect(out.revisedPrompt).toBe("a pixel");
    expect(seen[0]!.url).toBe("https://api.openai.com/v1/images/generations");
    const headers = new Headers(seen[0]!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-test");
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body).toMatchObject({
      model: "dall-e-3",
      prompt: "a red square",
      n: 1,
      response_format: "b64_json",
    });
  });

  it("只有 url 时再 GET；远程 http URL 拒绝", async () => {
    const client = createOpenAIImageClient({
      model: "dall-e-3",
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-test",
      fetch: async (url) => {
        if (String(url).includes("/images/generations")) {
          return new Response(JSON.stringify({ data: [{ url: "http://8.8.8.8/x.png" }] }), { status: 200 });
        }
        throw new Error("should not fetch unsafe url");
      },
    });
    await expect(client.generate({ prompt: "x" })).rejects.toThrow(/safe https/);
  });

  it("HTTP 错误把 error.message 带出来；空 key 当场说清", async () => {
    const noKey = createOpenAIImageClient({
      model: "dall-e-3",
      baseURL: "https://api.openai.com/v1",
      apiKey: "",
      fetch: async () => new Response("nope", { status: 500 }),
    });
    await expect(noKey.generate({ prompt: "x" })).rejects.toThrow(/AGENT_IMAGE_API_KEY/);

    const billed = createOpenAIImageClient({
      model: "dall-e-3",
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-test",
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "billing hard limit reached" } }), { status: 400 }),
    });
    await expect(billed.generate({ prompt: "x" })).rejects.toThrow(/billing hard limit reached/);
  });

  it("非法 baseURL 在构造时拒绝（不把密钥打进错误）", () => {
    expect(() =>
      createOpenAIImageClient({
        model: "dall-e-3",
        baseURL: "http://8.8.8.8/v1",
        apiKey: "sk-secret-must-not-appear",
      }),
    ).toThrow(/HTTPS/);
    try {
      createOpenAIImageClient({
        model: "dall-e-3",
        baseURL: "http://8.8.8.8/v1",
        apiKey: "sk-secret-must-not-appear",
      });
    } catch (err) {
      expect(String(err)).not.toContain("sk-secret");
    }
  });
});

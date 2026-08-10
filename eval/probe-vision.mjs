/**
 * 视觉端点能力探针：某个 Anthropic 兼容端点到底认不认图像块。
 *
 * 为什么要探（2026-08-10 实测教训）：DeepSeek 端点对图像块返回 200，
 * 但把图静默替换成 "[Unsupported Image]"——模型收到的是一句占位文本。
 * 不探就配置，得到的是一个"看起来在看图"的假眼睛。
 *
 * 用法：
 *   node eval/probe-vision.mjs <baseURL> <model> [apiKey]
 *   key 缺省读 ANTHROPIC_API_KEY 环境变量。
 * 例：
 *   node eval/probe-vision.mjs https://api.moonshot.cn/anthropic kimi-k3 sk-xxx
 *
 * 判读：模型答出"红"= 真的看见了；答"看不到图/没有图"= 端点不支持。
 */
const [baseURL, model, keyArg] = process.argv.slice(2);
const key = keyArg || process.env.ANTHROPIC_API_KEY;
if (!baseURL || !model || !key) {
  console.error("用法: node eval/probe-vision.mjs <baseURL> <model> [apiKey]");
  process.exit(2);
}

// 1x1 纯红 PNG
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const res = await fetch(`${baseURL.replace(/\/$/, "")}/v1/messages`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model,
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
          { type: "text", text: "这张图是什么颜色？只答颜色词。" },
        ],
      },
    ],
  }),
});

console.log("status:", res.status);
const body = await res.text();
console.log(body.slice(0, 400));
const seen = /红|red/i.test(body);
const blind = /Unsupported Image|看不到|没有图|no image/i.test(body);
console.log(seen ? "\n✔ 端点真的看见了图" : blind ? "\n✘ 端点不支持图像（占位替换/自述看不见）" : "\n? 结果不确定——读上面的原文判断");

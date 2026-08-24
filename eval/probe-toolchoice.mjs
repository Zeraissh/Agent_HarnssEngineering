/**
 * 强制工具端点能力探针（§2.1）：某个 Anthropic 兼容端点到底认不认
 * `tool_choice: {type:"tool", name:"..."}`。
 *
 * 为什么要探（probe-vision 那条教训的同族）：兼容端点对不认识的字段有三种反应
 * ——400 拒绝、静默忽略、真的执行。**只有第三种才算支持**，而前两种在日志里
 * 长得几乎一样（都是"模型没调那个工具"）。不探就依赖，得到的是一个
 * "看起来在强制"的假不变量。
 *
 * B0b 那一轮只探到 `tool_choice:{type:"none"}` 被 200 接受，
 * 并没有探"接受之后是否遵守"——loop 层因此加了真不变量兜底。
 * 强制交付这一侧同理：harness 侧有 terminalTool 兜底，但**端点认不认决定了
 * 要不要为降级臂再投入**，所以这个数字值得单独拿到。
 *
 * 用法：
 *   node eval/probe-toolchoice.mjs <baseURL> <model> [apiKey]
 *   key 缺省读 ANTHROPIC_API_KEY 环境变量。
 * 例（本机 .env 那套）：
 *   node eval/probe-toolchoice.mjs https://api.deepseek.com/anthropic deepseek-v4-pro
 *
 * 判读：
 *   supported      模型返回了 submit_verdict 的 tool_use 块 —— 真的被强制了
 *   ignored        200 但没调工具（吐了文本）—— 只收不认，降级臂是主路径
 *   rejected(4xx)  端点明确拒绝该参数 —— 必须在客户端层剥掉它再发
 */
const [baseURL, model, keyArg] = process.argv.slice(2);
const key = keyArg || process.env.ANTHROPIC_API_KEY;
if (!baseURL || !model || !key) {
  console.error("用法: node eval/probe-toolchoice.mjs <baseURL> <model> [apiKey]");
  process.exit(2);
}

const TOOL = {
  name: "submit_verdict",
  description: "提交最终裁决，结束核查。",
  input_schema: {
    type: "object",
    properties: {
      passed: { type: "boolean", description: "客观项是否全过" },
      summary: { type: "string", description: "一句话结论" },
    },
    required: ["passed", "summary"],
  },
};

const res = await fetch(`${baseURL.replace(/\/$/, "")}/v1/messages`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model,
    max_tokens: 256,
    tools: [TOOL],
    // 这就是被探的那一个参数
    tool_choice: { type: "tool", name: "submit_verdict" },
    messages: [
      {
        role: "user",
        // 刻意问一个"想聊天"的问题：不强制的话模型多半会回文本而不是调工具，
        // 于是"调了工具"这件事本身就是强制生效的证据
        content: "随便跟我聊两句天气吧。",
      },
    ],
  }),
});

const bodyText = await res.text();
if (!res.ok) {
  console.log(`结论：rejected(${res.status}) —— 端点拒绝 tool_choice:{type:"tool"}`);
  console.log(bodyText.slice(0, 600));
  console.log("\n处置：在 model-client 层按端点剥掉该参数；harness 的 terminalTool 兜底仍然有效。");
  process.exit(1);
}

let body;
try {
  body = JSON.parse(bodyText);
} catch {
  console.log("结论：无法解析响应（端点返回的不是 JSON）");
  console.log(bodyText.slice(0, 600));
  process.exit(1);
}

const blocks = Array.isArray(body.content) ? body.content : [];
const call = blocks.find((b) => b?.type === "tool_use" && b?.name === "submit_verdict");
const text = blocks.filter((b) => b?.type === "text").map((b) => b.text).join("");

if (call) {
  console.log("结论：supported —— 强制工具生效，模型返回了 tool_use");
  console.log(`  stop_reason: ${body.stop_reason}`);
  console.log(`  input: ${JSON.stringify(call.input)}`);
  console.log("\n处置：§2.1 的主路径可用。跑几轮真实任务后 npm run ledger 看 tool 占比。");
  process.exit(0);
}

console.log("结论：ignored —— 200 接受但没有强制（模型吐了文本）");
console.log(`  stop_reason: ${body.stop_reason}`);
console.log(`  文本片段: ${text.slice(0, 200)}`);
console.log(
  "\n处置：降级臂是主路径（文本 JSON 契约 + parseVerdict 仍在兜底）。" +
    "\n     把这个结论写进 backlog——它决定了 §2.1 的收益上限，也解释了台账里 tool 占比为什么低。",
);
process.exit(1);

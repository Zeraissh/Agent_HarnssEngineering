/**
 * L2 — 工具入参校验：宿主【执行】自己声明的 inputSchema，而不是指望模型自觉遵守。
 *
 * 为什么建这一层（P6「护栏是宿主的责任，不是模型的自觉」）：
 * inputSchema 一直声明了、也一直发给模型了，但运行时从不校验。各工具自己手写
 * `typeof p !== "string"`，覆盖不一（`src/memory.ts` 的 memory_read/write/delete
 * 三个工具一个检查都没有），错误消息四种写法。宿主声明了契约，然后自己不看。
 *
 * 更要命的是 MCP：`src/mcp.ts` 把外部 server 声明的 schema 原样 `as JSONSchema`
 * 收下，`execute` 再把 `input ?? {}` 直接转发过去——那些工具【没有任何位置】
 * 可以手写检查。手写路线从结构上盖不住 MCP，这是必须集中拦的硬理由，不是风格偏好。
 *
 * 还有一处现场早就在等这一层：`src/model-client-openai.ts` 的 safeParseArgs
 * 注释写着「解析失败回传空对象，让工具的输入校验层给出可操作报错」——
 * 代码已经在向一个从未建成的层交接。
 *
 * 为什么不引入 zod/ajv：与"从零手写、刻意不用现成框架"的立项动机冲突，
 * 而且我们只需要很小的子集。
 *
 * ================= 核心纪律：失败开放（fail-open） =================
 * 只在【认得的构造被明确违反】时拒绝。看不懂的关键字（oneOf/anyOf/allOf/$ref/
 * not/patternProperties…）一律放行。
 *
 * 理由：MCP 的 schema 来自外部服务端，形态不受本仓库控制。一个"看不懂就拒"的
 * 校验器会把合法调用挡在门外——那比不校验更糟：不校验只是漏掉坏输入，误拒是
 * 亲手制造新的失败模式，而且是 fail-closed 那一类（项目已有三种误伤形态的教训）。
 * 同理，本层【不】强制 additionalProperties：required 缺失检查已经能抓到拼错的
 * 键名（还会把实收键名列给模型看），而拒绝多余字段的收益远不抵误拒风险。
 */
import type { JSONSchema } from "../types.js";

/** 认得的 JSON Schema 基础类型；不在此列的 type 值一律不判（失败开放） */
const KNOWN_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

/** 递归深度上限：schema 来自外部，不能假设它不自我嵌套 */
const MAX_DEPTH = 8;
/** 单次最多报几条——错误消息是给模型读的，列一屏比列全量有用 */
const MAX_ERRORS = 8;
/** 数组逐元素校验的元素上限：超出部分不查，避免大数组把消息撑爆 */
const MAX_ARRAY_ITEMS = 20;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 给模型看的实际类型名（用 JSON Schema 的词汇，不用 JS 的） */
function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (v === undefined) return "undefined (absent)";
  const t = typeof v;
  if (t === "number") return Number.isInteger(v) ? "integer" : "number";
  return t;
}

function matchesType(v: unknown, t: string): boolean {
  switch (t) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    case "array":
      return Array.isArray(v);
    case "object":
      return isPlainObject(v);
    default:
      return true; // 不认识的 type 名 = 不判
  }
}

/** enum 成员比较：基本类型走 Object.is，复合值退化为结构序列化比较 */
function enumMatches(candidate: unknown, value: unknown): boolean {
  if (Object.is(candidate, value)) return true;
  if (typeof candidate !== "object" || candidate === null) return false;
  if (typeof value !== "object" || value === null) return false;
  try {
    return JSON.stringify(candidate) === JSON.stringify(value);
  } catch {
    return false;
  }
}

function quoteList(items: readonly string[]): string {
  return items.map((k) => `"${k}"`).join(", ");
}

function walk(node: unknown, value: unknown, path: string, errors: string[], depth: number): void {
  if (errors.length >= MAX_ERRORS || depth > MAX_DEPTH) return;
  if (!isPlainObject(node)) return; // 布尔 schema / 非对象节点：不判

  const where = path === "" ? "input" : path;

  // ---- type（支持 ["string","null"] 这类联合） ----
  const declared = node.type;
  const types = (
    typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared : []
  ).filter((t): t is string => typeof t === "string");
  const known = types.filter((t) => KNOWN_TYPES.has(t));
  if (known.length > 0 && !known.some((t) => matchesType(value, t))) {
    errors.push(`${where}: expected ${known.join(" or ")}, got ${describeType(value)}`);
    return; // 类型就不对，再往下查只会产生级联噪声
  }

  // ---- enum ----
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    if (!node.enum.some((candidate) => enumMatches(candidate, value))) {
      const allowed = node.enum.map((v) => JSON.stringify(v)).join(", ");
      errors.push(`${where}: expected one of [${allowed}], got ${JSON.stringify(value) ?? "undefined"}`);
    }
  }

  // ---- object：required + properties ----
  if (isPlainObject(value)) {
    const required = Array.isArray(node.required)
      ? node.required.filter((k): k is string => typeof k === "string")
      : [];
    const missing = required.filter((k) => value[k] === undefined);
    if (missing.length > 0) {
      const received = Object.keys(value);
      // 把实收键名一并列出：required 缺失最常见的成因是键名拼错，
      // 直接把两边摆给模型看比只说"缺 path"可操作得多
      errors.push(
        `${where}: missing required ${quoteList(missing)}` +
          (received.length > 0
            ? ` (received keys: ${quoteList(received)})`
            : " (received an empty object)"),
      );
    }

    if (isPlainObject(node.properties)) {
      for (const [key, sub] of Object.entries(node.properties)) {
        if (errors.length >= MAX_ERRORS) break;
        if (value[key] === undefined) continue; // 缺失归 required 管；非必填缺失合法
        walk(sub, value[key], path === "" ? key : `${path}.${key}`, errors, depth + 1);
      }
    }
  }

  // ---- array：items（只支持单一 items schema；元组式 items 数组不判） ----
  if (Array.isArray(value) && isPlainObject(node.items)) {
    const limit = Math.min(value.length, MAX_ARRAY_ITEMS);
    for (let i = 0; i < limit; i++) {
      if (errors.length >= MAX_ERRORS) break;
      walk(node.items, value[i], `${where}[${i}]`, errors, depth + 1);
    }
  }
}

/**
 * 按声明的 schema 校验一次工具入参。
 *
 * @returns 通过则 `null`；否则返回【写给模型看】的错误消息（P5：错误进上下文，
 *          要说清期望什么、实收什么、下一步怎么做）。
 */
export function validateToolInput(schema: JSONSchema | undefined, input: unknown): string | null {
  if (!isPlainObject(schema)) return null; // 没有可执行的契约 = 不判

  const errors: string[] = [];
  walk(schema, input, "", errors, 0);
  if (errors.length === 0) return null;

  const lines = errors.map((e) => `- ${e}`).join("\n");
  return `Invalid tool input: the arguments do not match this tool's declared input_schema.\n${lines}\nCheck the tool's input_schema and call it again with corrected arguments.`;
}

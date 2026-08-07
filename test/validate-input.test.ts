import { describe, expect, it, vi } from "vitest";
import { ToolExecutor, ToolRegistry } from "../src/tools/registry.js";
import { validateToolInput } from "../src/tools/validate-input.js";
import { bashTool } from "../src/tools/bash.js";
import { readFileTool } from "../src/tools/read-file.js";
import { writeFileTool } from "../src/tools/write-file.js";
import { adaptMcpTool } from "../src/mcp.js";
import { makeTool, toolUseBlock } from "./helpers.js";
import type { JSONSchema } from "../src/types.js";

const obj = (properties: Record<string, unknown>, required?: string[]): JSONSchema =>
  ({ type: "object", properties, ...(required ? { required } : {}) }) as unknown as JSONSchema;

describe("validateToolInput —— 合法输入放行", () => {
  it("仓库里真实声明过的 schema 全部接受各自的合法入参", () => {
    expect(validateToolInput(bashTool.inputSchema, { command: "ls -la" })).toBeNull();
    expect(validateToolInput(readFileTool.inputSchema, { path: "src/a.ts" })).toBeNull();
    expect(validateToolInput(writeFileTool.inputSchema, { path: "a.ts", content: "x" })).toBeNull();
  });

  it("可选属性缺失合法（只有 required 才是必须）", () => {
    const schema = obj({ path: { type: "string" }, question: { type: "string" } }, ["path"]);
    expect(validateToolInput(schema, { path: "shot.png" })).toBeNull();
  });

  it("不强制 additionalProperties：多余字段放行", () => {
    // 拒绝多余字段的收益抵不上误拒风险，required 缺失检查已能抓住拼错的键名
    expect(validateToolInput(readFileTool.inputSchema, { path: "a.ts", extra: 1 })).toBeNull();
  });

  it("空 properties 的无参工具接受空对象", () => {
    expect(validateToolInput(obj({}), {})).toBeNull();
  });
});

describe("validateToolInput —— 违反被拒，消息写给模型看", () => {
  it("缺 required：点名缺哪个，并列出实收键名（拼错键最常见）", () => {
    const msg = validateToolInput(readFileTool.inputSchema, { pat: "src/a.ts" });
    expect(msg).toContain('missing required "path"');
    expect(msg).toContain('received keys: "pat"');
    expect(msg).toContain("input_schema");
  });

  it("缺 required 且实收空对象：说明收到的是空对象", () => {
    const msg = validateToolInput(bashTool.inputSchema, {});
    expect(msg).toContain('missing required "command"');
    expect(msg).toContain("empty object");
  });

  it("类型不符：报期望类型与实收类型", () => {
    const msg = validateToolInput(bashTool.inputSchema, { command: 123 });
    expect(msg).toContain("command: expected string, got integer");
  });

  it("整数与浮点可区分", () => {
    const schema = obj({ n: { type: "integer" } }, ["n"]);
    expect(validateToolInput(schema, { n: 3 })).toBeNull();
    expect(validateToolInput(schema, { n: 3.5 })).toContain("expected integer, got number");
  });

  it("多处违反一次报全，不是只报第一条", () => {
    const msg = validateToolInput(writeFileTool.inputSchema, { path: 1, content: false });
    expect(msg).toContain("path: expected string");
    expect(msg).toContain("content: expected string");
  });

  it("null 不冒充 string（typeof null === 'object' 的经典坑）", () => {
    expect(validateToolInput(bashTool.inputSchema, { command: null })).toContain(
      "expected string, got null",
    );
  });

  it("数组不冒充 object", () => {
    expect(validateToolInput(readFileTool.inputSchema, [])).toContain(
      "input: expected object, got array",
    );
  });

  it("enum 违反列出全部合法值", () => {
    const schema = obj({ mode: { type: "string", enum: ["read", "write"] } }, ["mode"]);
    expect(validateToolInput(schema, { mode: "read" })).toBeNull();
    const msg = validateToolInput(schema, { mode: "append" });
    expect(msg).toContain('expected one of ["read", "write"]');
  });

  it("嵌套对象与数组元素逐层定位（路径带下标）", () => {
    const schema = obj({
      target: obj({ host: { type: "string" } }, ["host"]),
      tags: { type: "array", items: { type: "string" } },
    });
    const msg = validateToolInput(schema, { target: { host: 1 }, tags: ["a", 2] });
    expect(msg).toContain("target.host: expected string, got integer");
    expect(msg).toContain("tags[1]: expected string, got integer");
  });

  it("type 联合（[\"string\",\"null\"]）任一命中即通过", () => {
    const schema = obj({ note: { type: ["string", "null"] } });
    expect(validateToolInput(schema, { note: "x" })).toBeNull();
    expect(validateToolInput(schema, { note: null })).toBeNull();
    expect(validateToolInput(schema, { note: 5 })).toContain("expected string or null");
  });

  it("接住 compat 路径的 __malformed_arguments（safeParseArgs 一直在等这一层）", () => {
    // src/model-client-openai.ts:safeParseArgs 解析失败时回传这个形状，
    // 注释明写"让工具的输入校验层给出可操作报错"——此前没有这一层
    const msg = validateToolInput(writeFileTool.inputSchema, {
      __malformed_arguments: '{"path":"a.ts","cont',
    });
    expect(msg).toContain('missing required "path", "content"');
    expect(msg).toContain("__malformed_arguments");
  });
});

describe("validateToolInput —— 失败开放（这一条比查得严更重要）", () => {
  it("看不懂的组合关键字不拒绝：oneOf / anyOf / allOf / $ref / not", () => {
    for (const node of [
      { oneOf: [{ type: "string" }, { type: "number" }] },
      { anyOf: [{ type: "string" }] },
      { allOf: [{ type: "object" }] },
      { $ref: "#/definitions/Thing" },
      { not: { type: "string" } },
    ]) {
      const schema = obj({ v: node }, ["v"]);
      // 无论给什么值都不该被这一层拒绝
      expect(validateToolInput(schema, { v: 42 })).toBeNull();
      expect(validateToolInput(schema, { v: { deep: true } })).toBeNull();
    }
  });

  it("不认识的 type 名不拒绝", () => {
    expect(validateToolInput(obj({ v: { type: "date-time" } }, ["v"]), { v: 1 })).toBeNull();
  });

  it("没有 schema / schema 不是对象 = 没有可执行的契约，一律放行", () => {
    expect(validateToolInput(undefined, { anything: 1 })).toBeNull();
    expect(validateToolInput(true as unknown as JSONSchema, { anything: 1 })).toBeNull();
  });

  it("元组式 items（数组形态）不判，不误拒", () => {
    const schema = obj({ pair: { type: "array", items: [{ type: "string" }, { type: "number" }] } });
    expect(validateToolInput(schema, { pair: [1, "x"] })).toBeNull();
  });

  it("深度嵌套的 schema 不爆栈，且仍能在浅层报错", () => {
    let node: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 60; i++) node = { type: "object", properties: { next: node } };
    let value: Record<string, unknown> = { next: 1 };
    for (let i = 0; i < 60; i++) value = { next: value };
    expect(() => validateToolInput(node as unknown as JSONSchema, value)).not.toThrow();
    expect(validateToolInput(node as unknown as JSONSchema, { next: 1 })).toContain(
      "next: expected object, got integer",
    );
  });
});

describe("ToolExecutor 集成 —— 拦截点与顺序", () => {
  const signal = () => new AbortController().signal;

  function setup(tool: ReturnType<typeof makeTool>) {
    const reg = new ToolRegistry();
    reg.register(tool);
    return new ToolExecutor(reg, "/tmp/x");
  }

  it("入参不合法：不执行工具、不发审批，直接回 isError", async () => {
    const execute = vi.fn(async () => ({ content: "should not run" }));
    const approve = vi.fn(async () => ({ decision: "allow" as const }));
    const exec = setup(
      makeTool({
        name: "writer",
        permission: "ask",
        inputSchema: obj({ path: { type: "string" } }, ["path"]),
        execute,
      }),
    );

    const [result] = await exec.executeAll(
      [toolUseBlock("tu_1", "writer", { pat: "a.ts" })],
      signal(),
      approve,
    );

    expect(result!.is_error).toBe(true);
    expect(String(result!.content)).toContain('missing required "path"');
    // 行为断言而非字符串断言：工具没跑，人也没被打扰
    expect(execute).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });

  it("入参合法：照常走审批门并执行", async () => {
    const execute = vi.fn(async () => ({ content: "wrote" }));
    const approve = vi.fn(async () => ({ decision: "allow" as const }));
    const exec = setup(
      makeTool({
        name: "writer",
        permission: "ask",
        inputSchema: obj({ path: { type: "string" } }, ["path"]),
        execute,
      }),
    );

    const [result] = await exec.executeAll(
      [toolUseBlock("tu_1", "writer", { path: "a.ts" })],
      signal(),
      approve,
    );

    expect(result!.is_error).toBeUndefined();
    expect(approve).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("MCP 工具同样被拦——那正是手写检查够不到的地方", async () => {
    const call = vi.fn(async () => ({ content: "server said ok", isError: false }));
    const mcpTool = adaptMcpTool(
      "stm32",
      {
        name: "read_memory",
        inputSchema: { type: "object", properties: { address: { type: "string" } }, required: ["address"] },
      },
      call,
      { permission: "auto" },
    );
    const reg = new ToolRegistry();
    reg.register(mcpTool);
    const exec = new ToolExecutor(reg, "/tmp/x");

    const [bad] = await exec.executeAll(
      [toolUseBlock("tu_1", "stm32__read_memory", { addr: "0x20000004" })],
      signal(),
      async () => ({ decision: "allow" as const }),
    );
    expect(bad!.is_error).toBe(true);
    // 关键：没有把垃圾参数转发给 MCP server
    expect(call).not.toHaveBeenCalled();

    const [good] = await exec.executeAll(
      [toolUseBlock("tu_2", "stm32__read_memory", { address: "0x20000004" })],
      signal(),
      async () => ({ decision: "allow" as const }),
    );
    expect(good!.is_error).toBeUndefined();
    expect(call).toHaveBeenCalledTimes(1);
  });
});

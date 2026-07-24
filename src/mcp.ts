/**
 * L2 扩展 — MCP 客户端接入：把任意 MCP server 的工具适配为 harness 的 Tool 接口。
 *
 * 设计要点：
 * - 一次适配，整个 MCP 生态可用：领域能力（硬件调试、数据库、浏览器……）
 *   不再需要手写 TS 工具，L0/L1/L3 依旧零改动（P1）；
 * - 工具名加 `${server}__` 前缀，避免与内置工具及多 server 之间撞名；
 * - 权限默认 "ask"（外部进程的能力面未知，宿主审批兜底，P6）；
 *   信任的 server 可在 mcp.json 里按 server 配 "auto" / parallelSafe；
 * - MCP 的 isError 直接映射为 ToolResult.isError（错误进上下文，P5）。
 *
 * 配置文件（默认 ./mcp.json，AGENT_MCP_CONFIG 覆盖）：
 * {
 *   "servers": {
 *     "stm32": {
 *       "command": "python", "args": ["-m", "mcp_server.server"],
 *       "cwd": "D:/Work/MCP_Servers/stm32-gdb-mcp",
 *       "env": { "PYTHONPATH": "D:/Work/MCP_Servers/stm32-gdb-mcp/src" },
 *       "permission": "auto", "includeTools": ["start_debug_session", "..."]
 *     }
 *   }
 * }
 */
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { truncate } from "./tools/fs-util.js";
import type { JSONSchema, Tool } from "./types.js";

/** 硬件/长任务类 MCP 工具（如 flash 烧录）可能很慢 */
const CALL_TIMEOUT_MS = 300_000;

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** 默认 "ask"——外部进程能力面未知，审批兜底 */
  permission?: "auto" | "ask";
  /** 默认 false——MCP server 内部多为有状态会话，保守串行 */
  parallelSafe?: boolean;
  /** 只暴露这些工具（可选，控制工具面大小） */
  includeTools?: string[];
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

// ---------------------------------------------------------------- 纯适配层（可测）

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export type McpCaller = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ content: string; isError: boolean }>;

export function adaptMcpTool(
  serverName: string,
  info: McpToolInfo,
  call: McpCaller,
  cfg: Pick<McpServerConfig, "permission" | "parallelSafe">,
): Tool {
  return {
    name: `${serverName}__${info.name}`,
    description: info.description?.trim() || `Tool "${info.name}" provided by MCP server "${serverName}".`,
    inputSchema: (info.inputSchema ?? { type: "object", properties: {} }) as JSONSchema,
    permission: cfg.permission ?? "ask",
    parallelSafe: cfg.parallelSafe ?? false,
    async execute(input) {
      const args = (input ?? {}) as Record<string, unknown>;
      const result = await call(info.name, args);
      return {
        content: truncate(result.content) || "(empty MCP result)",
        ...(result.isError ? { isError: true } : {}),
      };
    },
  };
}

/** MCP content 块渲染为回填文本：text 直通，其余类型标注占位 */
export function renderMcpContent(content: unknown): string {
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((block: { type?: string; text?: string; resource?: { uri?: string } }) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "resource") return `[resource: ${block.resource?.uri ?? "unknown"}]`;
      return `[${block.type ?? "unknown"} content]`;
    })
    .join("\n");
}

// ---------------------------------------------------------------- 连接管理

export class McpConnection {
  private constructor(
    private readonly client: Client,
    readonly serverName: string,
    private readonly cfg: McpServerConfig,
  ) {}

  static async connect(serverName: string, cfg: McpServerConfig): Promise<McpConnection> {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...getDefaultEnvironment(), ...cfg.env },
      ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
    });
    const client = new Client({ name: "agent-harness", version: "0.7.0" });
    await client.connect(transport);
    return new McpConnection(client, serverName, cfg);
  }

  async tools(): Promise<Tool[]> {
    const { tools } = await this.client.listTools();
    const wanted = this.cfg.includeTools;
    return tools
      .filter((t) => !wanted || wanted.includes(t.name))
      .map((t) =>
        adaptMcpTool(
          this.serverName,
          { name: t.name, description: t.description, inputSchema: t.inputSchema },
          (name, args) => this.call(name, args),
          this.cfg,
        ),
      );
  }

  private async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError: boolean }> {
    const result = await this.client.callTool({ name, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
    });
    return { content: renderMcpContent(result.content), isError: result.isError === true };
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

export interface McpRuntime {
  tools: Tool[];
  /** serverName → 工具数（宿主打印用） */
  summary: Record<string, number>;
  close(): Promise<void>;
}

/** 连接配置里的全部 server；单个失败不拖垮整体（打印警告继续） */
export async function connectMcpServers(
  config: McpConfig,
  onWarn: (msg: string) => void = console.warn,
): Promise<McpRuntime> {
  const connections: McpConnection[] = [];
  const tools: Tool[] = [];
  const summary: Record<string, number> = {};

  for (const [name, cfg] of Object.entries(config.servers)) {
    try {
      const conn = await McpConnection.connect(name, cfg);
      const serverTools = await conn.tools();
      connections.push(conn);
      tools.push(...serverTools);
      summary[name] = serverTools.length;
    } catch (err) {
      onWarn(`mcp: failed to connect "${name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    tools,
    summary,
    close: async () => {
      await Promise.allSettled(connections.map((c) => c.close()));
    },
  };
}

/** 读取 mcp.json；文件不存在返回 undefined（MCP 是可选能力） */
export async function loadMcpConfig(configPath: string): Promise<McpConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return undefined;
  }
  const parsed = JSON.parse(raw) as McpConfig;
  if (!parsed.servers || typeof parsed.servers !== "object") {
    throw new Error(`Invalid MCP config ${configPath}: missing "servers" object`);
  }
  return parsed;
}

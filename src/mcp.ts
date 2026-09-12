/**
 * L2 扩展 — MCP 客户端接入：把任意 MCP server 的工具适配为 harness 的 Tool 接口。
 *
 * 设计要点：
 * - 一次适配，整个 MCP 生态可用：领域能力（硬件调试、数据库、浏览器……）
 *   不再需要手写 TS 工具，L0/L1/L3 依旧零改动（P1）；
 * - 工具名加 `${server}__` 前缀，避免与内置工具及多 server 之间撞名；
 * - 权限默认 "ask"（外部进程的能力面未知，宿主审批兜底，P6）；
 *   信任的 server 可在 mcp.json 里按 server 配默认值，再用
 *   toolPermissions 对单个原始工具名收紧/放开；
 * - MCP 的 isError 直接映射为 ToolResult.isError（错误进上下文，P5）。
 *
 * 配置文件（默认 ./mcp.json，AGENT_MCP_CONFIG 覆盖）：
 * {
 *   "servers": {
 *     "stm32": {
 *       "command": "python", "args": ["-m", "mcp_server.server"],
 *       "cwd": "D:/Work/MCP_Servers/stm32-gdb-mcp",
 *       "env": { "PYTHONPATH": "D:/Work/MCP_Servers/stm32-gdb-mcp/src" },
 *       "permission": "auto",
 *       "toolPermissions": { "flash_firmware": "ask", "read_memory": "auto" },
 *       "includeTools": ["start_debug_session", "..."]
 *     },
 *     "github": {
 *       "command": "docker",
 *       "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "-e", "GITHUB_TOOLS", "ghcr.io/github/github-mcp-server"],
 *       "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}" },
 *       "requiredEnv": ["GITHUB_PERSONAL_ACCESS_TOKEN"],
 *       "includeTools": ["get_file_contents", "create_pull_request"]
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
import { isToolPermission, resolveToolPermission, type ToolPermission } from "./permission-mode.js";
import { truncate } from "./tools/fs-util.js";
import type { JSONSchema, Tool } from "./types.js";

/** 硬件/长任务类 MCP 工具（如 flash 烧录）可能很慢 */
const CALL_TIMEOUT_MS = 300_000;

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** 默认 "ask"——外部进程能力面未知，审批兜底；deny = 硬拒 */
  permission?: ToolPermission;
  /** 按 MCP server 声明的原始工具名覆盖 permission */
  toolPermissions?: Record<string, ToolPermission>;
  /** 默认 false——MCP server 内部多为有状态会话，保守串行 */
  parallelSafe?: boolean;
  /** 只暴露这些工具（可选，控制工具面大小） */
  includeTools?: string[];
  /**
   * SAFE-06：按 MCP 原始工具名显式标副作用。启发式认不出的写工具靠这份名单进事务。
   * 只能扩进事务，不能把已命中启发式的写工具摘出去。
   */
  sideEffectTools?: string[];
  /** 默认 true。设置页的停用开关；false 时不拉起进程。 */
  enabled?: boolean;
  /**
   * 这些环境变量在展开后仍为空则跳过连接（同 web_search：没 key 就不进面）。
   * 避免每次启动都去拉 docker / npx 再失败。
   */
  requiredEnv?: string[];
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

/** server / DomainPack 共用的权限策略形状。 */
export interface McpPermissionPolicy {
  /** 该层级的默认权限 */
  permission?: ToolPermission;
  /** 按 MCP 原始工具名的细粒度覆盖 */
  toolPermissions?: Record<string, ToolPermission>;
}

interface AdaptedMcpPermissionMetadata {
  rawToolName: string;
  serverPolicy: McpPermissionPolicy;
}

/** Tool 契约保持领域无关；MCP 原始策略作为进程内 side metadata 随实例保存。 */
const adaptedMcpPermissionMetadata = new WeakMap<Tool, AdaptedMcpPermissionMetadata>();

/** 读取适配时保存的原始 MCP 工具名，避免靠 `${server}__${raw}` 字符串反推。 */
export function originalMcpToolName(tool: Tool): string | undefined {
  return adaptedMcpPermissionMetadata.get(tool)?.rawToolName;
}

/**
 * 合并 server 与 DomainPack 权限。优先级从低到高固定为：
 * server 默认 → pack 默认 → server 单工具 → pack 单工具。
 *
 * deny-first：任一层出现 deny 立即胜出（宽 deny 压过窄 allow）。
 * 关键不变量：pack 的泛化默认不能放宽 server 对某个具体工具的显式 ask；
 * 若确实要覆盖，必须在 pack.toolPermissions 中同样点名该工具。
 */
export function resolveMcpToolPermission(
  rawToolName: string,
  serverPolicy?: McpPermissionPolicy,
  packPolicy?: McpPermissionPolicy,
): ToolPermission {
  const serverTool = serverPolicy?.toolPermissions?.[rawToolName];
  const packTool = packPolicy?.toolPermissions?.[rawToolName];
  if (
    serverPolicy?.permission === "deny"
    || packPolicy?.permission === "deny"
    || serverTool === "deny"
    || packTool === "deny"
  ) {
    return "deny";
  }

  let resolved: ToolPermission = "ask";
  if (isToolPermission(serverPolicy?.permission)) resolved = serverPolicy.permission;
  if (isToolPermission(packPolicy?.permission)) resolved = packPolicy.permission;
  if (isToolPermission(serverTool)) resolved = serverTool;
  if (isToolPermission(packTool)) resolved = packTool;
  return resolveToolPermission([resolved]);
}

/**
 * 对已适配 MCP Tool 应用 DomainPack 策略，并保留 server 原始细粒度策略。
 * 非 adaptMcpTool 产生的池元素按其当前 permission 视为显式 server 工具策略，
 * 因而同样不会被 pack 的泛化默认静默放宽。
 */
export function applyMcpPackPermission(
  tool: Tool,
  rawToolName: string,
  packPolicy?: McpPermissionPolicy,
): Tool {
  const metadata = adaptedMcpPermissionMetadata.get(tool);
  const effectiveRawToolName = metadata?.rawToolName ?? rawToolName;
  const serverPolicy = metadata?.serverPolicy ?? {
    toolPermissions: { [effectiveRawToolName]: tool.permission },
  };
  const permission = resolveMcpToolPermission(effectiveRawToolName, serverPolicy, packPolicy);
  if (permission === tool.permission) return tool;
  const resolved = {
    ...tool,
    permission,
    ...(permission === "ask" && !tool.approvalPolicy
      ? { approvalPolicy: { maxScope: "once" as const } }
      : {}),
  };
  if (metadata) adaptedMcpPermissionMetadata.set(resolved, metadata);
  return resolved;
}

// ---------------------------------------------------------------- 纯适配层（可测）

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { destructiveHint?: boolean };
}

export type McpCaller = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ content: string; isError: boolean }>;

export function adaptMcpTool(
  serverName: string,
  info: McpToolInfo,
  call: McpCaller,
  cfg: Pick<McpServerConfig, "permission" | "toolPermissions" | "parallelSafe" | "sideEffectTools">,
): Tool {
  const permission = resolveMcpToolPermission(info.name, cfg);
  const sideEffect =
    info.annotations?.destructiveHint === true
    || Boolean(cfg.sideEffectTools?.includes(info.name));
  const tool: Tool = {
    name: `${serverName}__${info.name}`,
    description: info.description?.trim() || `Tool "${info.name}" provided by MCP server "${serverName}".`,
    inputSchema: (info.inputSchema ?? { type: "object", properties: {} }) as JSONSchema,
    permission,
    parallelSafe: cfg.parallelSafe ?? false,
    // MCP 可能控制进程、云资源或真实硬件；没有更细策略前一律只准单次审批。
    ...(permission === "ask" ? { approvalPolicy: { maxScope: "once" as const } } : {}),
    ...(sideEffect ? { sideEffect: true } : {}),
    async execute(input) {
      const args = (input ?? {}) as Record<string, unknown>;
      const result = await call(info.name, args);
      return {
        content: truncate(result.content) || "(empty MCP result)",
        ...(result.isError ? { isError: true } : {}),
      };
    },
  };
  adaptedMcpPermissionMetadata.set(tool, {
    rawToolName: info.name,
    serverPolicy: {
      ...(cfg.permission ? { permission: cfg.permission } : {}),
      ...(cfg.toolPermissions ? { toolPermissions: cfg.toolPermissions } : {}),
    },
  });
  return tool;
}

/** 传输层死亡判定：SDK 在 stdio 断开后抛 "Not connected" / "Connection closed" */
export function isTransportDead(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not connected|connection closed|transport.*closed/i.test(msg);
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
  private client: Client;
  private reconnecting?: Promise<void>;

  private constructor(
    client: Client,
    readonly serverName: string,
    private readonly cfg: McpServerConfig,
  ) {
    this.client = client;
  }

  private static async createClient(cfg: McpServerConfig): Promise<Client> {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...getDefaultEnvironment(), ...resolveMcpServerEnv(cfg) },
      ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
    });
    const client = new Client({ name: "agent-harness", version: "0.7.0" });
    await client.connect(transport);
    return client;
  }

  static async connect(serverName: string, cfg: McpServerConfig): Promise<McpConnection> {
    return new McpConnection(await McpConnection.createClient(cfg), serverName, cfg);
  }

  /**
   * 传输层死亡（server 进程被杀/stdio 断开）→ 重启 server 进程重连（一次）。
   * 教训（v1.0 三角编排演示）：执行者用 bash 清理进程时把共享的 MCP server 扫死，
   * 之后 verifier 全部调用 "Not connected"——多轮编排的寿命比连接长，必须能自愈。
   * 注意：重连后 server 端会话状态清零（如调试会话），调用方需自行重建会话。
   */
  private async reconnect(): Promise<void> {
    this.reconnecting ??= (async () => {
      try {
        await this.client.close();
      } catch {
        // 传输已死，close 失败属预期
      }
      this.client = await McpConnection.createClient(this.cfg);
    })().finally(() => {
      this.reconnecting = undefined;
    });
    return this.reconnecting;
  }

  async tools(): Promise<Tool[]> {
    const { tools } = await this.client.listTools();
    const wanted = this.cfg.includeTools;
    return tools
      .filter((t) => !wanted || wanted.includes(t.name))
      .map((t) =>
        adaptMcpTool(
          this.serverName,
          {
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.annotations?.destructiveHint === true
              ? { annotations: { destructiveHint: true } }
              : {}),
          },
          (name, args) => this.call(name, args),
          this.cfg,
        ),
      );
  }

  private async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError: boolean }> {
    try {
      return await this.doCall(name, args);
    } catch (err) {
      if (!isTransportDead(err)) throw err;
      await this.reconnect();
      return await this.doCall(name, args); // 重连后重试一次；再失败如实上抛
    }
  }

  private async doCall(
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
  /** 未拉起的 server → 原因（disabled / missing ENV）。不是连接失败。 */
  skipped: Record<string, string>;
  /** 尝试拉起但失败的 server → 错误原文。 */
  failed: Record<string, string>;
  close(): Promise<void>;
}

const ENV_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** 展开 mcp.json env 里的 `${VAR}`；空值回退同名进程环境变量。 */
export function interpolateMcpEnvValue(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  return raw.replace(ENV_PLACEHOLDER, (_, name: string) => env[name] ?? "");
}

/**
 * 解析一个 server 实际传给子进程的 env。
 * `GITHUB_PERSONAL_ACCESS_TOKEN` 空时再试 `AGENT_GITHUB_TOKEN` / `GITHUB_TOKEN`
 * （与 web_search 认两个 Tavily key 名同款）。
 */
export function resolveMcpServerEnv(
  cfg: McpServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(cfg.env ?? {})) {
    const expanded = interpolateMcpEnvValue(String(raw ?? ""), env);
    out[key] = expanded.trim() ? expanded : (env[key] ?? "");
  }
  if (!(out.GITHUB_PERSONAL_ACCESS_TOKEN ?? "").trim()) {
    const alias = (env.AGENT_GITHUB_TOKEN ?? env.GITHUB_TOKEN ?? "").trim();
    if (alias) out.GITHUB_PERSONAL_ACCESS_TOKEN = alias;
  }
  return out;
}

/** 展开后仍会真正拉起 stdio 进程的 server。跳过项不触发 SAFE-05 的 host-MCP 拒绝。 */
export function mcpConfigHasRunnableServers(
  config: McpConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!config) return false;
  return Object.values(config.servers).some((cfg) => !mcpServerSkipReason(cfg, resolveMcpServerEnv(cfg, env)));
}

/** 没配齐就不连：空壳 server 会诱使模型重试，并把失败归咎于自己。 */
export function mcpServerSkipReason(
  cfg: McpServerConfig,
  resolvedEnv: Record<string, string> = resolveMcpServerEnv(cfg),
): string | undefined {
  if (cfg.enabled === false) return "disabled";
  for (const key of cfg.requiredEnv ?? []) {
    if (!(resolvedEnv[key] ?? "").trim()) return `missing ${key}`;
  }
  return undefined;
}

/**
 * 按包的 MCP 接入面挑选要连接的 server。
 * 连接层是并集，但**进程**按当前包需要的那些拉起——ts-coding 不得顺带启动 stm32。
 * 包 `mcp: false` → 不连包声明的 server；`hostGithub` 仍可单独拉起 github。
 * server 自己没写 includeTools 时无法证明不相交，保守保留。
 */
export function filterMcpConfigForPack(
  config: McpConfig,
  packMcp: boolean | { includeTools?: string[] } | undefined,
  opts: { hostGithub?: boolean } = {},
): McpConfig | undefined {
  let servers: Record<string, McpServerConfig> | undefined;
  if (packMcp === false) {
    servers = undefined;
  } else {
    const wanted = packMcp && typeof packMcp === "object" ? packMcp.includeTools : undefined;
    if (!wanted?.length) return withHostGithubServer(config, config, opts.hostGithub);
    const allow = new Set(wanted);
    const sliced: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(config.servers)) {
      if (!cfg.includeTools?.length) {
        sliced[name] = cfg;
        continue;
      }
      if (cfg.includeTools.some((tool) => allow.has(tool))) sliced[name] = cfg;
    }
    servers = Object.keys(sliced).length ? sliced : undefined;
  }
  const next = servers ? { servers } : undefined;
  return withHostGithubServer(config, next, opts.hostGithub);
}

function withHostGithubServer(
  full: McpConfig,
  slice: McpConfig | undefined,
  hostGithub?: boolean,
): McpConfig | undefined {
  if (!hostGithub) return slice;
  const github = full.servers.github;
  if (!github) return slice;
  if (!slice) return { servers: { github } };
  if (slice.servers.github) return slice;
  return { servers: { ...slice.servers, github } };
}

export function mergeMcpRuntimes(base: McpRuntime | undefined, extra: McpRuntime): McpRuntime {
  if (!base) return extra;
  return {
    tools: [...base.tools, ...extra.tools],
    summary: { ...base.summary, ...extra.summary },
    skipped: { ...base.skipped, ...extra.skipped },
    failed: { ...base.failed, ...extra.failed },
    close: async () => {
      await Promise.allSettled([base.close(), extra.close()]);
    },
  };
}

/** 连接配置里的全部 server；单个失败不拖垮整体（打印警告继续） */
export async function connectMcpServers(
  config: McpConfig,
  onWarn: (msg: string) => void = console.warn,
): Promise<McpRuntime> {
  const connections: McpConnection[] = [];
  const tools: Tool[] = [];
  const summary: Record<string, number> = {};
  const skipped: Record<string, string> = {};
  const failed: Record<string, string> = {};

  for (const [name, cfg] of Object.entries(config.servers)) {
    const skip = mcpServerSkipReason(cfg);
    if (skip) {
      skipped[name] = skip;
      continue;
    }
    try {
      const conn = await McpConnection.connect(name, cfg);
      const serverTools = await conn.tools();
      connections.push(conn);
      tools.push(...serverTools);
      summary[name] = serverTools.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed[name] = message;
      onWarn(`mcp: failed to connect "${name}": ${message}`);
    }
  }

  return {
    tools,
    summary,
    skipped,
    failed,
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
  for (const [serverName, cfg] of Object.entries(parsed.servers)) {
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
      throw new Error(`Invalid MCP config ${configPath}: server "${serverName}" must be an object`);
    }
    if (cfg.permission !== undefined && !isToolPermission(cfg.permission)) {
      throw new Error(
        `Invalid MCP config ${configPath}: server "${serverName}" permission must be "auto" | "ask" | "deny"`,
      );
    }
    if (
      cfg.toolPermissions !== undefined &&
      (!cfg.toolPermissions || typeof cfg.toolPermissions !== "object" || Array.isArray(cfg.toolPermissions))
    ) {
      throw new Error(
        `Invalid MCP config ${configPath}: server "${serverName}" toolPermissions must be an object`,
      );
    }
    for (const [toolName, permission] of Object.entries(cfg.toolPermissions ?? {})) {
      if (!isToolPermission(permission)) {
        throw new Error(
          `Invalid MCP config ${configPath}: server "${serverName}" tool "${toolName}" permission must be "auto" | "ask" | "deny"`,
        );
      }
    }
    if (cfg.sideEffectTools !== undefined) {
      if (
        !Array.isArray(cfg.sideEffectTools)
        || cfg.sideEffectTools.some((name) => typeof name !== "string" || !name.trim())
      ) {
        throw new Error(
          `Invalid MCP config ${configPath}: server "${serverName}" sideEffectTools must be an array of tool names`,
        );
      }
    }
    if (cfg.enabled !== undefined && typeof cfg.enabled !== "boolean") {
      throw new Error(
        `Invalid MCP config ${configPath}: server "${serverName}" enabled must be a boolean`,
      );
    }
    if (cfg.requiredEnv !== undefined) {
      if (
        !Array.isArray(cfg.requiredEnv)
        || cfg.requiredEnv.some((name) => typeof name !== "string" || !name.trim())
      ) {
        throw new Error(
          `Invalid MCP config ${configPath}: server "${serverName}" requiredEnv must be an array of environment variable names`,
        );
      }
    }
  }
  return parsed;
}

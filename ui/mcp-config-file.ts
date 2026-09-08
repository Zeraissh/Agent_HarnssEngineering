/**
 * mcp.json 的读写形状：设置页只动 servers 表，不碰运行时连接。
 * env 值可以填，但 GET 出栈时密钥类键名打码。
 */

export interface McpServerPublic {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  url: string;
  enabled: boolean;
  permission: "auto" | "ask";
}

export interface McpServerWrite extends McpServerPublic {
  env?: Record<string, string>;
}

const SECRET_KEY = /(?:key|token|secret|password|passwd|authorization)/i;

export function redactEnv(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    out[k] = SECRET_KEY.test(k) ? (v ? "••••" : "") : v;
  }
  return out;
}

export function parseMcpConfigFile(raw: string): { servers: Record<string, unknown> } {
  if (!String(raw ?? "").trim()) return { servers: {} };
  const parsed = JSON.parse(raw) as { servers?: unknown };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("mcp.json 必须是对象");
  }
  const servers = parsed.servers;
  if (servers == null) return { servers: {} };
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error("mcp.json 的 servers 必须是对象");
  }
  return { servers: servers as Record<string, unknown> };
}

export function publicMcpServers(servers: Record<string, unknown>): McpServerPublic[] {
  return Object.entries(servers).map(([name, raw]) => {
    const s = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const permission: McpServerPublic["permission"] = s.permission === "auto" ? "auto" : "ask";
    return {
      name,
      command: typeof s.command === "string" ? s.command : "",
      args: Array.isArray(s.args) ? s.args.map(String) : [],
      cwd: typeof s.cwd === "string" ? s.cwd : "",
      url: typeof s.url === "string" ? s.url : "",
      enabled: s.enabled !== false,
      permission,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function applyMcpServerPatch(
  current: Record<string, unknown>,
  name: string,
  patch: Partial<McpServerWrite> | null,
): Record<string, unknown> {
  const key = String(name ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(key)) {
    throw new Error("MCP 服务名只允许字母数字、下划线、连字符，最长 64");
  }
  const next = { ...current };
  if (patch === null) {
    delete next[key];
    return next;
  }
  const prev = (next[key] && typeof next[key] === "object" && !Array.isArray(next[key]))
    ? { ...(next[key] as Record<string, unknown>) }
    : {};
  if (patch.command !== undefined) prev.command = String(patch.command ?? "").trim();
  if (patch.args !== undefined) prev.args = Array.isArray(patch.args) ? patch.args.map(String) : [];
  if (patch.cwd !== undefined) prev.cwd = String(patch.cwd ?? "").trim();
  if (patch.url !== undefined) prev.url = String(patch.url ?? "").trim();
  if (patch.enabled !== undefined) prev.enabled = Boolean(patch.enabled);
  if (patch.permission !== undefined) prev.permission = patch.permission === "auto" ? "auto" : "ask";
  if (!prev.command && !prev.url) {
    throw new Error("MCP 服务需要 command（stdio）或 url（HTTP）");
  }
  next[key] = prev;
  return next;
}

export function serializeMcpConfig(servers: Record<string, unknown>): string {
  return `${JSON.stringify({ servers }, null, 2)}\n`;
}

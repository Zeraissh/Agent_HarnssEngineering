/**
 * 把运行时模型库回写到 .env：只更新认识的键，注释与其它行原样保留。
 *
 * 不写 API key——密钥继续走环境变量 / 模型库密文，避免把 sk- 打进可提交文件。
 * 运行中的进程不会因此换模型（.env 只在启动时读）；按钮的用途是
 * 「下次不带 .agent-models.json 冷启动也还在」。
 */

const ROLE_ENV: Record<string, { model: string; provider: string; baseUrl: string }> = {
  executor: { model: "AGENT_MODEL", provider: "AGENT_PROVIDER", baseUrl: "" },
  planner: { model: "AGENT_PLANNER_MODEL", provider: "AGENT_PLANNER_PROVIDER", baseUrl: "AGENT_PLANNER_BASE_URL" },
  verifier: { model: "AGENT_VERIFIER_MODEL", provider: "AGENT_VERIFIER_PROVIDER", baseUrl: "AGENT_VERIFIER_BASE_URL" },
  vision: { model: "AGENT_VISION_MODEL", provider: "AGENT_VISION_PROVIDER", baseUrl: "AGENT_VISION_BASE_URL" },
  image: { model: "AGENT_IMAGE_MODEL", provider: "AGENT_IMAGE_PROVIDER", baseUrl: "AGENT_IMAGE_BASE_URL" },
};

export interface EnvSyncModel {
  id: string;
  provider: string;
  model: string;
  baseUrl?: string;
}

export interface EnvSyncInput {
  models: EnvSyncModel[];
  roles: Record<string, string | null | undefined>;
}

export interface EnvSyncResult {
  text: string;
  changed: string[];
}

function quoteEnv(value: string): string {
  if (value === "") return "";
  if (/[\s#"']/.test(value) || value.includes("=")) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

function lineKey(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(trimmed);
  return m?.[1] ?? null;
}

/** updates 的值：string = 写入；null = 删除该键；缺席 = 不动。 */
export function upsertEnvKeys(existing: string, updates: Record<string, string | null>): EnvSyncResult {
  const raw = existing.includes("\r\n") || existing.endsWith("\r")
    ? existing.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    : existing;
  const endedWithNl = raw.endsWith("\n");
  const lines = raw.length === 0 ? [] : raw.split("\n");
  if (lines.length && lines.at(-1) === "") lines.pop();

  const remaining = { ...updates };
  const changed: string[] = [];
  const next = lines.map((line) => {
    const key = lineKey(line);
    if (!key || !Object.prototype.hasOwnProperty.call(remaining, key)) return line;
    const value = remaining[key];
    delete remaining[key];
    if (value == null) {
      changed.push(key);
      return null;
    }
    const rendered = `${key}=${quoteEnv(value)}`;
    if (rendered !== line) changed.push(key);
    return rendered;
  }).filter((line): line is string => line !== null);

  for (const [key, value] of Object.entries(remaining)) {
    if (value === null) continue;
    next.push(`${key}=${quoteEnv(value)}`);
    changed.push(key);
  }

  let text = next.join("\n");
  if (text.length > 0 && (endedWithNl || existing.length === 0)) text += "\n";
  return { text, changed };
}

export function envUpdatesFromStore(input: EnvSyncInput): Record<string, string | null> {
  const byId = new Map(input.models.map((m) => [m.id, m]));
  const updates: Record<string, string | null> = {};

  for (const [role, keys] of Object.entries(ROLE_ENV)) {
    const id = input.roles[role];
    const entry = id ? byId.get(id) : undefined;
    if (!entry) {
      if (role === "executor") continue;
      updates[keys.model] = null;
      updates[keys.provider] = null;
      if (keys.baseUrl) updates[keys.baseUrl] = null;
      continue;
    }
    updates[keys.model] = entry.model;
    updates[keys.provider] = entry.provider;
    if (role === "executor") {
      updates[entry.provider === "openai" ? "OPENAI_BASE_URL" : "ANTHROPIC_BASE_URL"] = entry.baseUrl ?? "";
    } else if (keys.baseUrl) {
      updates[keys.baseUrl] = entry.baseUrl ?? "";
    }
  }
  return updates;
}

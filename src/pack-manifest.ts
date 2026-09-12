/**
 * 文件领域包的声明面（EXT-01 最小切片）。
 *
 * 硬编码 PACKS 继续是内置包（不迁四内置；held-out eval 不应因装载文件包而变）。
 * 文件包是附加来源：drafts/ 里的是待审草稿，不能进 getPack；installed/ 签字后才可选用。
 *
 * 权限只能收窄：缺 builtinTools 不代表「全部内置工具」；mcp:true 一律当成 false。
 * 生成器只许填薄的一半（名 / 描述 / 工作循环 / 核查说明），其余走保守缺省。
 *
 * schemaVersion 未识别 → 装载 fail-closed（CLI exit 1 / createUiServer 抛错，同非法 context env）。
 * 清单 EXT-01 意图标 [~]：本切片未对齐完整 plugin.json / 签名 / 启停 UI。
 */

/** 文件包 manifest 唯一识别的 schema 版本。缺省按 1；其它值一律不识别。 */
export const PACK_MANIFEST_SCHEMA_VERSION = 1;

export const PACK_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** 文件包允许声明的内置工具。不在此列的名字会被剥掉，不会默默扩权。 */
export const ALLOWED_FILE_PACK_TOOLS = [
  "read_file",
  "write_file",
  "glob",
  "grep",
  "bash",
  "fetch_url",
  "web_search",
  "describe_image",
  "generate_image",
] as const;

export type AllowedFilePackTool = (typeof ALLOWED_FILE_PACK_TOOLS)[number];

/** 草稿默认工具面：能读写工作区，不给 shell / 网络 / 生图。 */
export const DRAFT_BUILTIN_TOOLS: AllowedFilePackTool[] = [
  "read_file",
  "write_file",
  "glob",
  "grep",
];

/** 文件包执行者护栏上限——没有实测就不要自报 70 轮。 */
export const FILE_PACK_MAX_TURNS_CAP = 40;

export interface PackDraftInput {
  name: string;
  description: string;
  systemPrompt: string;
  verifyInstructions?: string;
}

export interface FilePackManifest {
  schemaVersion: typeof PACK_MANIFEST_SCHEMA_VERSION;
  name: string;
  description: string;
  version: string;
  /** 未经过真实案例实测。签字安装也不改这个——实测是另一回事。 */
  measured: boolean;
  systemPromptFile: string;
  verifyInstructionsFile?: string;
  builtinTools: AllowedFilePackTool[];
  mcp: false | { includeTools: string[] };
  verify: {
    enabled: boolean;
    mode: "programmatic" | "rubric";
    rubric?: string;
    readOnlyCommands?: string[];
    maxTurns?: number;
  };
  resources?: string[];
  guardrails?: { maxTurns?: number };
}

/** 未识别的 schemaVersion：装载路径必须抛错，不能静默跳过。 */
export type PackManifestParseFailure = {
  ok: false;
  error: string;
  unrecognizedSchema?: true;
};

export function normalizePackName(raw: unknown): string | null {
  const name = String(raw ?? "").trim().toLowerCase();
  if (!PACK_NAME_RE.test(name)) return null;
  return name;
}

export function clampFilePackPrivileges(raw: FilePackManifest): FilePackManifest {
  const allow = new Set<string>(ALLOWED_FILE_PACK_TOOLS);
  const tools = (raw.builtinTools ?? []).filter((t): t is AllowedFilePackTool => allow.has(t));
  const builtinTools = tools.length ? tools : [...DRAFT_BUILTIN_TOOLS];
  // 文件包不许自己声明 MCP / 资源锁——那是内置包用失败案例换来的牙。
  // pack.json 里写 mcp:true 或 resources 一律丢掉，避免「未实测包占探针」。
  const maxTurns = raw.guardrails?.maxTurns;
  const guardrails =
    typeof maxTurns === "number" && Number.isFinite(maxTurns)
      ? { maxTurns: Math.min(FILE_PACK_MAX_TURNS_CAP, Math.max(1, Math.floor(maxTurns))) }
      : undefined;
  const verifyMax = raw.verify.maxTurns;
  return {
    schemaVersion: PACK_MANIFEST_SCHEMA_VERSION,
    name: raw.name,
    description: raw.description,
    version: raw.version,
    measured: false,
    systemPromptFile: raw.systemPromptFile || "SYSTEM.md",
    ...(raw.verifyInstructionsFile ? { verifyInstructionsFile: raw.verifyInstructionsFile } : {}),
    builtinTools,
    mcp: false,
    verify: {
      enabled: raw.verify.enabled === true,
      mode: raw.verify.mode === "programmatic" ? "programmatic" : "rubric",
      ...(typeof raw.verify.rubric === "string" && raw.verify.rubric.trim()
        ? { rubric: raw.verify.rubric.trim() }
        : {}),
      ...(Array.isArray(raw.verify.readOnlyCommands)
        ? { readOnlyCommands: raw.verify.readOnlyCommands.map((c) => String(c).trim()).filter(Boolean).slice(0, 32) }
        : {}),
      ...(typeof verifyMax === "number" && Number.isFinite(verifyMax)
        ? { maxTurns: Math.min(FILE_PACK_MAX_TURNS_CAP, Math.max(1, Math.floor(verifyMax))) }
        : {}),
    },
    ...(guardrails ? { guardrails } : {}),
  };
}

/**
 * 生成器入口：只收薄字段，其余锁死保守缺省。
 * 调用方传入的 builtinTools / mcp / resources / maxTurns 一律丢掉。
 */
export function conservativeDraftManifest(input: PackDraftInput): FilePackManifest {
  const name = normalizePackName(input.name);
  if (!name) {
    throw new Error("包名须为小写字母开头的 kebab-case，最长 32（如 thermocouple-consult）。");
  }
  const description = String(input.description ?? "").trim();
  if (!description) throw new Error("description 不能空。");
  return clampFilePackPrivileges({
    schemaVersion: PACK_MANIFEST_SCHEMA_VERSION,
    name,
    description: description.slice(0, 240),
    version: "0.1.0",
    measured: false,
    systemPromptFile: "SYSTEM.md",
    ...(String(input.verifyInstructions ?? "").trim()
      ? { verifyInstructionsFile: "VERIFY.md" }
      : {}),
    builtinTools: [...DRAFT_BUILTIN_TOOLS],
    mcp: false,
    verify: { enabled: false, mode: "rubric" },
  });
}

/**
 * 读 pack.json 的 schemaVersion。缺省 = 当前版本（兼容未写字段的旧草稿）。
 * 出现但无法识别 → 带 unrecognizedSchema，装载方必须 fail-closed。
 */
export function readPackSchemaVersion(
  raw: unknown,
): { ok: true; schemaVersion: typeof PACK_MANIFEST_SCHEMA_VERSION } | PackManifestParseFailure {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, schemaVersion: PACK_MANIFEST_SCHEMA_VERSION };
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n !== PACK_MANIFEST_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `pack.json schemaVersion "${String(raw)}" 无效：仅支持 ${PACK_MANIFEST_SCHEMA_VERSION}`,
      unrecognizedSchema: true,
    };
  }
  return { ok: true, schemaVersion: PACK_MANIFEST_SCHEMA_VERSION };
}

export function parsePackManifest(json: unknown):
  | { ok: true; manifest: FilePackManifest }
  | PackManifestParseFailure {
  if (!json || typeof json !== "object") return { ok: false, error: "pack.json 须是对象。" };
  const o = json as Record<string, unknown>;
  const schema = readPackSchemaVersion(o.schemaVersion);
  if (!schema.ok) return schema;
  const name = normalizePackName(o.name);
  if (!name) return { ok: false, error: "pack.json.name 非法。" };
  const description = String(o.description ?? "").trim();
  if (!description) return { ok: false, error: "pack.json.description 不能空。" };
  const builtinTools = Array.isArray(o.builtinTools)
    ? o.builtinTools.map((t) => String(t))
    : [...DRAFT_BUILTIN_TOOLS];
  const verifyRaw = o.verify && typeof o.verify === "object" ? o.verify as Record<string, unknown> : {};
  const mcpRaw = o.mcp;
  const mcp: FilePackManifest["mcp"] = mcpRaw === true
    ? false
    : mcpRaw && typeof mcpRaw === "object" && Array.isArray((mcpRaw as { includeTools?: unknown }).includeTools)
      ? { includeTools: (mcpRaw as { includeTools: unknown[] }).includeTools.map((t) => String(t)) }
      : false;
  const manifest = clampFilePackPrivileges({
    schemaVersion: schema.schemaVersion,
    name,
    description,
    version: String(o.version ?? "0.1.0").trim() || "0.1.0",
    measured: false,
    systemPromptFile: String(o.systemPromptFile ?? "SYSTEM.md").trim() || "SYSTEM.md",
    ...(typeof o.verifyInstructionsFile === "string" && o.verifyInstructionsFile.trim()
      ? { verifyInstructionsFile: o.verifyInstructionsFile.trim() }
      : {}),
    builtinTools: builtinTools as AllowedFilePackTool[],
    mcp,
    verify: {
      enabled: verifyRaw.enabled === true,
      mode: verifyRaw.mode === "programmatic" ? "programmatic" : "rubric",
      ...(typeof verifyRaw.rubric === "string" ? { rubric: verifyRaw.rubric } : {}),
      ...(Array.isArray(verifyRaw.readOnlyCommands)
        ? { readOnlyCommands: verifyRaw.readOnlyCommands.map((c) => String(c)) }
        : {}),
      ...(typeof verifyRaw.maxTurns === "number" ? { maxTurns: verifyRaw.maxTurns } : {}),
    },
    ...(Array.isArray(o.resources) ? { resources: o.resources.map((r) => String(r)) } : {}),
    ...(o.guardrails && typeof o.guardrails === "object" && typeof (o.guardrails as { maxTurns?: unknown }).maxTurns === "number"
      ? { guardrails: { maxTurns: (o.guardrails as { maxTurns: number }).maxTurns } }
      : {}),
  });
  return { ok: true, manifest };
}

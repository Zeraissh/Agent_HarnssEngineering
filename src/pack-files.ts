/**
 * 文件领域包的落盘与装载。
 *
 *   <root>/drafts/<name>/{pack.json,SYSTEM.md,VERIFY.md?}
 *   <root>/installed/<name>/...
 *
 * 草稿不能进 getPack。安装 = 签字：挪到 installed/ 再 registerFilePack。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DomainPack } from "./presets.js";
import {
  CONVERSATION_DISCIPLINE,
  PACKS,
  PRESENTATION_DISCIPLINE,
  PROGRESS_DISCIPLINE,
  registerFilePack,
  clearFilePacks,
} from "./presets.js";
import {
  conservativeDraftManifest,
  normalizePackName,
  parsePackManifest,
  type FilePackManifest,
  type PackDraftInput,
} from "./pack-manifest.js";

export interface FilePackRecord {
  name: string;
  status: "draft" | "installed";
  dir: string;
  manifest: FilePackManifest;
  systemPrompt: string;
  verifyInstructions: string;
}

const FILE_PACK_DISCIPLINES =
  CONVERSATION_DISCIPLINE + PRESENTATION_DISCIPLINE + PROGRESS_DISCIPLINE;

export function packsRootFromEnv(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const explicit = env.AGENT_PACKS_DIR?.trim();
  return explicit || join(cwd, ".agent-packs");
}

export function manifestToDomainPack(record: FilePackRecord): DomainPack {
  const m = record.manifest;
  const instructions = record.verifyInstructions.trim();
  return {
    name: m.name,
    description: `${m.description}（文件包，未实测）`,
    systemPrompt: `${record.systemPrompt.trim()}\n${FILE_PACK_DISCIPLINES}`,
    builtinTools: [...m.builtinTools],
    mcp: m.mcp,
    verify: {
      enabled: m.verify.enabled,
      mode: m.verify.mode,
      ...(instructions ? { instructions } : {}),
      ...(m.verify.rubric ? { rubric: m.verify.rubric } : {}),
      ...(m.verify.readOnlyCommands ? { readOnlyCommands: m.verify.readOnlyCommands } : {}),
      ...(m.verify.maxTurns !== undefined ? { maxTurns: m.verify.maxTurns } : {}),
    },
    ...(m.resources?.length ? { resources: m.resources } : {}),
    ...(m.guardrails ? { guardrails: m.guardrails } : {}),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function readOptionalSync(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function loadOneFromText(
  dir: string,
  status: "draft" | "installed",
  packJson: string,
  readSidecar: (path: string) => string,
): FilePackRecord | null {
  let json: unknown;
  try {
    json = JSON.parse(packJson);
  } catch {
    return null;
  }
  const parsed = parsePackManifest(json);
  if (!parsed.ok) {
    // 未识别 schemaVersion 不能静默跳过——与非法 AGENT_CONTEXT_* 同口径 fail-closed。
    if (parsed.unrecognizedSchema) throw new Error(parsed.error);
    return null;
  }
  const folder = dir.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
  if (folder !== parsed.manifest.name) return null;
  const systemPrompt = readSidecar(join(dir, parsed.manifest.systemPromptFile));
  if (!systemPrompt.trim()) return null;
  const verifyInstructions = parsed.manifest.verifyInstructionsFile
    ? readSidecar(join(dir, parsed.manifest.verifyInstructionsFile))
    : "";
  return {
    name: parsed.manifest.name,
    status,
    dir,
    manifest: parsed.manifest,
    systemPrompt,
    verifyInstructions,
  };
}

function loadOneSync(dir: string, status: "draft" | "installed"): FilePackRecord | null {
  const text = readOptionalSync(join(dir, "pack.json"));
  if (!text) return null;
  return loadOneFromText(dir, status, text, readOptionalSync);
}

async function loadOne(dir: string, status: "draft" | "installed"): Promise<FilePackRecord | null> {
  let text: string;
  try {
    text = await readFile(join(dir, "pack.json"), "utf8");
  } catch {
    return null;
  }
  return loadOneFromText(dir, status, text, (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  });
}

async function loadSide(root: string, status: "draft" | "installed"): Promise<FilePackRecord[]> {
  const side = join(root, status === "draft" ? "drafts" : "installed");
  let names: string[];
  try {
    names = await readdir(side);
  } catch {
    return [];
  }
  const out: FilePackRecord[] = [];
  for (const name of names) {
    const rec = await loadOne(join(side, name), status);
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listFilePacks(root: string): Promise<{ drafts: FilePackRecord[]; installed: FilePackRecord[] }> {
  const [drafts, installed] = await Promise.all([loadSide(root, "draft"), loadSide(root, "installed")]);
  return { drafts, installed };
}

function registerInstalled(records: FilePackRecord[]): FilePackRecord[] {
  clearFilePacks();
  const accepted: FilePackRecord[] = [];
  for (const rec of records) {
    if (PACKS[rec.name]) continue;
    registerFilePack(manifestToDomainPack(rec));
    accepted.push(rec);
  }
  return accepted;
}

/** 启动时同步装载：只把 installed 登记进 getPack。草稿不登记。内置同名丢弃。 */
export function loadInstalledFilePacksSync(root: string): FilePackRecord[] {
  const side = join(root, "installed");
  if (!existsSync(side)) {
    clearFilePacks();
    return [];
  }
  const installed = readdirSync(side)
    .map((name) => loadOneSync(join(side, name), "installed"))
    .filter((rec): rec is FilePackRecord => rec !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  return registerInstalled(installed);
}

/** 启动时：只把 installed 登记进 getPack。草稿不登记。内置同名文件包丢弃。 */
export async function loadInstalledFilePacks(root: string): Promise<FilePackRecord[]> {
  return loadInstalledFilePacksSync(root);
}

export async function writeDraftPack(root: string, input: PackDraftInput): Promise<FilePackRecord> {
  const name = normalizePackName(input.name);
  if (!name) throw new Error("包名须为小写字母开头的 kebab-case，最长 32。");
  if (PACKS[name]) throw new Error(`「${name}」是内置包，不能覆盖。请换一个名字。`);
  if (await pathExists(join(root, "installed", name))) {
    throw new Error(`「${name}」已安装，不能再写同名草稿。先卸掉已安装的包，或换一个名字。`);
  }
  const systemPrompt = String(input.systemPrompt ?? "").trim();
  if (!systemPrompt) throw new Error("systemPrompt 不能空。");
  const verifyInstructions = String(input.verifyInstructions ?? "").trim();
  const manifest = conservativeDraftManifest({
    name,
    description: input.description,
    systemPrompt,
    ...(verifyInstructions ? { verifyInstructions } : {}),
  });
  const dir = join(root, "drafts", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "pack.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(dir, manifest.systemPromptFile), `${systemPrompt}\n`, "utf8");
  if (manifest.verifyInstructionsFile && verifyInstructions) {
    await writeFile(join(dir, manifest.verifyInstructionsFile), `${verifyInstructions}\n`, "utf8");
  }
  return {
    name,
    status: "draft",
    dir,
    manifest,
    systemPrompt,
    verifyInstructions,
  };
}

export async function installDraftPack(root: string, nameRaw: string): Promise<FilePackRecord> {
  const name = normalizePackName(nameRaw);
  if (!name) throw new Error("包名非法。");
  if (PACKS[name]) throw new Error(`「${name}」是内置包，不能覆盖。`);
  const from = join(root, "drafts", name);
  const rec = await loadOne(from, "draft");
  if (!rec) throw new Error(`没有名为 ${name} 的草稿。`);
  const to = join(root, "installed", name);
  if (await pathExists(to)) {
    throw new Error(`「${name}」已经安装。`);
  }
  await mkdir(join(root, "installed"), { recursive: true });
  try {
    await rename(from, to);
  } catch {
    // Windows 上跨卷 rename 会失败；读了再写再删不在这里做——包目录应在同一磁盘。
    throw new Error(`无法把草稿挪到 installed/（${from} → ${to}）。`);
  }
  const installed = await loadOne(to, "installed");
  if (!installed) {
    await rename(to, from).catch(() => undefined);
    throw new Error("安装后读回失败，已尝试退回草稿。");
  }
  registerFilePack(manifestToDomainPack(installed));
  return installed;
}

export async function discardDraftPack(root: string, nameRaw: string): Promise<void> {
  const name = normalizePackName(nameRaw);
  if (!name) throw new Error("包名非法。");
  await rm(join(root, "drafts", name), { recursive: true, force: true });
}

export function filePackListView(records: { drafts: FilePackRecord[]; installed: FilePackRecord[] }) {
  const slim = (r: FilePackRecord) => ({
    name: r.name,
    description: r.manifest.description,
    measured: r.manifest.measured,
    builtinTools: r.manifest.builtinTools,
    verifyEnabled: r.manifest.verify.enabled,
  });
  return {
    drafts: records.drafts.map(slim),
    installed: records.installed.map(slim),
  };
}

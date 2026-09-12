/**
 * 运行时工作目录白名单的持久化存储（V-29 扩展）。
 *
 * 背景：白名单原本是启动时常量（workdir + AGENT_UI_WORKDIRS），改目录要重启宿主。
 * 委托方要求像 Kimi Work 一样「新建对话时直接选目录」——于是合法集合扩展为
 * 运行时可用本机 UI 显式添加，添加结果落盘，重启后仍在。
 *
 * 落点：<workdir>/.agent-workdirs.json（真实宿主默认；注入 modelClient 的测试宿主
 * 经 UiServerOptions.workdirStoreFile 显式给路径，仪器纪律同 modelStoreFile——
 * 假模型宿主不该被开发机残留的目录清单武装）。
 *
 * 纪律（与 model-config.ts 同一份）：
 *   - 原子写：临时文件 + rename；读到的文件损坏 → 备份为 .bak 后从零开始，
 *     绝不带着半截 JSON 启动。
 *   - 这里只存「运行时添加」的子集；env 声明的（AGENT_UI_WORKDIRS 与默认
 *     workdir）不落盘——它们由宿主每次启动重新声明，落了反而让来源混淆。
 */
import { randomUUID } from "node:crypto";
import { copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const WORKDIRS_SCHEMA_VERSION = 1;
export const WORKDIRS_FILENAME = ".agent-workdirs.json";

export interface WorkdirStore {
  schemaVersion: typeof WORKDIRS_SCHEMA_VERSION;
  /** 运行时添加的工作目录（resolve 归一化后的绝对路径，去重） */
  workdirs: string[];
}

/**
 * 宽松解析：坏 JSON / 版本不符 / 非对象 → null；单条非字符串收掉，
 * 合法条目统一 resolve 归一化（与白名单比对的口径一致）并去重。
 */
export function parseWorkdirStore(raw: string | null | undefined): WorkdirStore | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.schemaVersion !== WORKDIRS_SCHEMA_VERSION) return null;
  const seen = new Set<string>();
  const workdirs: string[] = [];
  if (Array.isArray(o.workdirs)) {
    for (const entry of o.workdirs) {
      if (typeof entry !== "string" || !entry.trim()) continue;
      const normalized = resolve(entry);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      workdirs.push(normalized);
    }
  }
  return { schemaVersion: WORKDIRS_SCHEMA_VERSION, workdirs };
}

export interface LoadWorkdirStoreResult {
  /** null = 文件不存在或已损坏（损坏时会先备份 .bak） */
  store: WorkdirStore | null;
  /** true = 原文件损坏，已备份为 <file>.bak */
  recoveredFromCorrupt: boolean;
}

/**
 * 读库。文件不存在 → { store: null }；损坏 → 备份 .bak 后 { store: null, recovered: true }。
 * 同步读：启动装配是同步契约（createUiServer），与 loadModelStore 同一步调。
 */
export function loadWorkdirStore(file: string): LoadWorkdirStoreResult {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { store: null, recoveredFromCorrupt: false };
  }
  const store = parseWorkdirStore(raw);
  if (store) return { store, recoveredFromCorrupt: false };
  try {
    copyFileSync(file, `${file}.bak`);
  } catch { /* 备份失败不挡启动——清单已经判死，从零开始 */ }
  return { store: null, recoveredFromCorrupt: true };
}

/** 原子写：临时文件 + rename。 */
export function saveWorkdirStore(file: string, store: WorkdirStore): void {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

/**
 * 请求体 extraWorkdirs：每条必须是白名单绝对路径；主目录自身丢掉（它已可写）。
 * 非法形状 / 越白名单一律失败——静默丢掉会让界面上勾着的目录实际没进圈。
 */
export function parseExtraWorkdirs(
  raw: unknown,
  allowed: Iterable<string>,
  primaryWorkdir: string,
): { ok: true; extraWorkdirs: string[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, extraWorkdirs: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: "extraWorkdirs 必须是路径数组" };
  }
  const allowedSet = new Set([...allowed].map((p) => resolve(p)));
  const primary = resolve(primaryWorkdir);
  const extras: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) {
      return { ok: false, error: "extraWorkdirs 每项必须是非空路径" };
    }
    const asked = resolve(item);
    if (!allowedSet.has(asked)) {
      return { ok: false, error: `额外目录不在白名单内：${asked}` };
    }
    if (asked === primary || seen.has(asked)) continue;
    seen.add(asked);
    extras.push(asked);
  }
  return { ok: true, extraWorkdirs: extras };
}

/**
 * 新建文件夹名：拒绝穿越、空名、Windows 非法字符。
 * 选择器浮层与 POST /api/fs/mkdir 共用同一条，避免一边放行一边 400。
 */
export function isSafeFolderName(name: string): boolean {
  const n = String(name ?? "").trim();
  if (!n || n === "." || n === "..") return false;
  if (n.length > 255) return false;
  if (/[\\/]/.test(n)) return false;
  if (/[<>:"|?*\u0000-\u001f]/.test(n)) return false;
  return true;
}

/** 本次 run 的额外根 = env / 白名单 / 勾选项的并集，去掉主 workdir。 */
export function mergeRunReadRoots(
  envRoots: string[],
  extraWorkdirs: string[] | undefined,
  primaryWorkdir: string,
): string[] {
  const primary = resolve(primaryWorkdir);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of [...envRoots, ...(extraWorkdirs ?? [])]) {
    if (typeof root !== "string" || !root.trim()) continue;
    const normalized = resolve(root);
    if (normalized === primary || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

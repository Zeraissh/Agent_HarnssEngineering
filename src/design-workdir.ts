/**
 * 设计模式稿目录：离开宿主源码仓库，落到独立草稿根。
 *
 * 编码 / 硬件包仍用各自选的 workdir；这里只回答「设计稿该不该切走」。
 */
import { resolve } from "node:path";

export const DESIGN_DRAFTS_DIR_ENV = "AGENT_DESIGN_DRAFTS_DIR";
export const DESIGN_DRAFTS_FOLDER = "Fathom";
export const HARNESS_PACKAGE_NAME = "agent-harness";

export type DesignDraftsSelectReason = "host-repo" | "already-drafts" | "custom" | "empty";

export function resolveDesignDraftsDir(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  home: string,
): string {
  const raw = String(env[DESIGN_DRAFTS_DIR_ENV] ?? "").trim();
  if (raw) return resolve(raw);
  return resolve(home, DESIGN_DRAFTS_FOLDER);
}

export function packageNameFromJson(raw: string): string | null {
  try {
    const name = JSON.parse(raw)?.name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

export function isHarnessPackageName(name: string | null | undefined): boolean {
  return name === HARNESS_PACKAGE_NAME;
}

export function sameWorkdirPath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function decideDesignDraftsSelection(opts: {
  currentWorkdir?: string | null;
  draftsDir: string;
  currentIsHarness: boolean;
}): { select: boolean; reason: DesignDraftsSelectReason } {
  const cur = typeof opts.currentWorkdir === "string" ? opts.currentWorkdir.trim() : "";
  if (!cur) return { select: true, reason: "empty" };
  if (sameWorkdirPath(cur, opts.draftsDir)) {
    return { select: false, reason: "already-drafts" };
  }
  if (opts.currentIsHarness) return { select: true, reason: "host-repo" };
  return { select: false, reason: "custom" };
}

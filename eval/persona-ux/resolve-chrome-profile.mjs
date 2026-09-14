/**
 * 评测走查拉起本机 Chrome 时用的 user-data-dir。
 * 与 src/chrome-user-data.ts 同一纪律：绝对可写，禁止 ./chrome-profile。
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const CHROME_USER_DATA_LEAF = "fathom-chrome-preview";
export const FORBIDDEN_RELATIVE_CHROME_PROFILE = "./chrome-profile";

export function isUnsafeChromeUserDataDir(dir) {
  const trimmed = String(dir ?? "").trim();
  if (!trimmed) return true;
  const norm = trimmed.replace(/\\/g, "/");
  if (norm === FORBIDDEN_RELATIVE_CHROME_PROFILE || norm === "chrome-profile") return true;
  return !path.isAbsolute(trimmed);
}

function defaultRoot(env = process.env) {
  const override = env.AGENT_CHROME_USER_DATA_DIR?.trim();
  if (override && path.isAbsolute(override) && !isUnsafeChromeUserDataDir(override)) {
    return path.resolve(override);
  }
  const local = (env.LOCALAPPDATA || env.XDG_CACHE_HOME || "").trim();
  if (local && path.isAbsolute(local)) return path.join(local, CHROME_USER_DATA_LEAF);
  return path.join(tmpdir(), CHROME_USER_DATA_LEAF);
}

function canWrite(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.fathom-writable-${process.pid}`);
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function locked(dir) {
  return existsSync(path.join(dir, "SingletonLock")) || existsSync(path.join(dir, "lockfile"));
}

export function resolveChromeUserDataDir(opts = {}) {
  const env = opts.env ?? process.env;
  const preferred = opts.preferred?.trim();
  const root = defaultRoot(env);
  const named = opts.name ? path.join(root, opts.name) : root;
  let candidate = preferred && !isUnsafeChromeUserDataDir(preferred) ? path.resolve(preferred) : named;
  if (!path.isAbsolute(candidate) || isUnsafeChromeUserDataDir(candidate)) candidate = named;

  if (canWrite(candidate) && !locked(candidate)) return candidate;
  const suffix = opts.randomSuffix ?? `${opts.pid ?? process.pid}-${randomBytes(3).toString("hex")}`;
  const fallback = `${candidate}-${suffix}`;
  if (canWrite(fallback) && !locked(fallback)) return fallback;
  const tmpFallback = path.join(tmpdir(), `${CHROME_USER_DATA_LEAF}-${suffix}`);
  mkdirSync(tmpFallback, { recursive: true });
  if (!canWrite(tmpFallback)) throw new Error("无法创建可写的 Chrome 用户数据目录");
  return tmpFallback;
}

export function chromeUserDataDirFlag(dir) {
  if (!path.isAbsolute(dir) || isUnsafeChromeUserDataDir(dir)) {
    throw new Error(`Chrome --user-data-dir must be an absolute writable path, not ${JSON.stringify(dir)}`);
  }
  return `--user-data-dir=${dir}`;
}

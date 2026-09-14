/**
 * Chrome / Chromium `--user-data-dir` 必须是**绝对且可写**的目录。
 *
 * 相对路径（尤其是 `./chrome-profile`）相对启动时 cwd：cwd 不可写、被别的
 * 实例锁住、或评测留下的 `eval/persona-ux/walks/_*-chrome-profile` 抢同一份
 * 配置时，Google Chrome 会弹系统框「无法对其数据目录 ./chrome-profile 执行
 * 读写操作」。产品、bash 子进程、桌面壳、评测脚本一律走这里，禁止再手写
 * `./chrome-profile`。
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const CHROME_USER_DATA_LEAF = "fathom-chrome-preview";
export const FORBIDDEN_RELATIVE_CHROME_PROFILE = "./chrome-profile";

export type ResolveChromeUserDataDirOptions = {
  preferred?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 挂在默认根下的子名（走查/截图隔离用） */
  name?: string;
  /** Electron `app.getPath('userData')`，优先于 LOCALAPPDATA */
  electronUserData?: string;
  pid?: number;
  randomSuffix?: string;
  /** 测试注入：某路径视为已被别的 Chrome 锁住 */
  isLocked?: (dir: string) => boolean;
};

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

/** `./chrome-profile`、`chrome-profile`、以及一切相对路径。 */
export function isUnsafeChromeUserDataDir(dir: string): boolean {
  const trimmed = dir.trim();
  if (!trimmed) return true;
  const norm = normalizeSlashes(trimmed);
  if (
    norm === FORBIDDEN_RELATIVE_CHROME_PROFILE
    || norm === "chrome-profile"
    || norm === ".\\chrome-profile"
  ) {
    return true;
  }
  return !path.isAbsolute(trimmed);
}

export function defaultChromeUserDataRoot(
  env: NodeJS.ProcessEnv = process.env,
  electronUserData?: string,
): string {
  const override = env.AGENT_CHROME_USER_DATA_DIR?.trim();
  if (override && path.isAbsolute(override) && !isUnsafeChromeUserDataDir(override)) {
    return path.resolve(override);
  }
  if (electronUserData && path.isAbsolute(electronUserData)) {
    return path.join(electronUserData, CHROME_USER_DATA_LEAF);
  }
  const local = env.LOCALAPPDATA?.trim() || env.XDG_CACHE_HOME?.trim();
  if (local && path.isAbsolute(local)) {
    return path.join(local, CHROME_USER_DATA_LEAF);
  }
  return path.join(tmpdir(), CHROME_USER_DATA_LEAF);
}

function defaultLocked(dir: string): boolean {
  return existsSync(path.join(dir, "SingletonLock")) || existsSync(path.join(dir, "lockfile"));
}

export function canWriteChromeUserDataDir(dir: string): boolean {
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

/**
 * 永远返回绝对路径。`./chrome-profile` 与其它相对路径**不**按 cwd 展开
 * （展开正是弹窗的根因），改落到 LOCALAPPDATA / tmp 下的独立目录。
 * 目录被 Chrome SingletonLock 占用或不可写时，换 `-<pid>-<rand>` 后缀，
 * 不让 Chrome 去弹系统错误框。
 */
export function resolveChromeUserDataDir(opts: ResolveChromeUserDataDirOptions = {}): string {
  const env = opts.env ?? process.env;
  const pid = opts.pid ?? process.pid;
  const locked = opts.isLocked ?? defaultLocked;
  const preferred = opts.preferred?.trim();
  const root = defaultChromeUserDataRoot(env, opts.electronUserData);
  const named = opts.name ? path.join(root, opts.name) : root;

  let candidate =
    preferred && !isUnsafeChromeUserDataDir(preferred) ? path.resolve(preferred) : named;
  if (!path.isAbsolute(candidate) || isUnsafeChromeUserDataDir(candidate)) {
    candidate = named;
  }

  const pick = (dir: string): string | undefined => {
    if (!canWriteChromeUserDataDir(dir)) return undefined;
    if (locked(dir)) return undefined;
    return dir;
  };

  const first = pick(candidate);
  if (first) return first;

  const suffix = opts.randomSuffix ?? `${pid}-${randomBytes(3).toString("hex")}`;
  const fallback = `${candidate}-${suffix}`;
  const second = pick(fallback);
  if (second) return second;

  const tmpFallback = path.join(tmpdir(), `${CHROME_USER_DATA_LEAF}-${suffix}`);
  mkdirSync(tmpFallback, { recursive: true });
  if (!canWriteChromeUserDataDir(tmpFallback)) {
    throw new Error("无法创建可写的 Chrome 用户数据目录");
  }
  return tmpFallback;
}

export function chromeUserDataDirFlag(dir: string): string {
  if (!path.isAbsolute(dir) || isUnsafeChromeUserDataDir(dir)) {
    throw new Error(
      `Chrome --user-data-dir must be an absolute writable path, not ${JSON.stringify(dir)}`,
    );
  }
  return `--user-data-dir=${dir}`;
}

export function chromePlaywrightLaunchArgs(opts: ResolveChromeUserDataDirOptions = {}): string[] {
  return [chromeUserDataDirFlag(resolveChromeUserDataDir({ name: "card-png", ...opts }))];
}

export function rewriteUserDataDirArgs(
  args: readonly string[],
  opts: ResolveChromeUserDataDirOptions = {},
): string[] {
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    const a = out[i]!;
    if (a === "--user-data-dir") {
      const next = out[i + 1];
      if (next) out[i + 1] = resolveChromeUserDataDir({ ...opts, preferred: next });
      continue;
    }
    if (a.startsWith("--user-data-dir=")) {
      const value = a.slice("--user-data-dir=".length);
      out[i] = chromeUserDataDirFlag(resolveChromeUserDataDir({ ...opts, preferred: value }));
    }
  }
  return out;
}

function isFlagBoundary(command: string, idx: number): boolean {
  return idx === 0 || /\s/.test(command[idx - 1]!);
}

/**
 * 改写 bash 命令行里的 `--user-data-dir=./chrome-profile`（及空格形式）。
 * `$VAR` / 命令替换不动。未闭合引号不动。
 */
export function rewriteUserDataDirInCommand(
  command: string,
  opts: ResolveChromeUserDataDirOptions = {},
): string {
  const needle = "--user-data-dir";
  let i = 0;
  let out = "";
  while (i < command.length) {
    const idx = command.indexOf(needle, i);
    if (idx === -1) {
      out += command.slice(i);
      break;
    }
    if (!isFlagBoundary(command, idx)) {
      out += command.slice(i, idx + needle.length);
      i = idx + needle.length;
      continue;
    }
    out += command.slice(i, idx);
    let j = idx + needle.length;
    while (j < command.length && (command[j] === " " || command[j] === "\t")) j++;
    let usedEquals = false;
    if (command[j] === "=") {
      usedEquals = true;
      j++;
      while (j < command.length && (command[j] === " " || command[j] === "\t")) j++;
    }
    const quote = command[j];
    let raw: string;
    let quoted: '"' | "'" | null = null;
    if (quote === '"' || quote === "'") {
      const end = command.indexOf(quote, j + 1);
      if (end === -1) {
        out += command.slice(idx);
        break;
      }
      quoted = quote;
      raw = command.slice(j + 1, end);
      j = end + 1;
    } else {
      const start = j;
      while (j < command.length && !/\s/.test(command[j]!)) j++;
      raw = command.slice(start, j);
    }
    if (!raw || /[`$]/.test(raw) || raw.includes("$(")) {
      out += command.slice(idx, j);
      i = j;
      continue;
    }
    const resolved = resolveChromeUserDataDir({ ...opts, preferred: raw });
    const value = quoted ? `${quoted}${resolved}${quoted}` : resolved;
    out += usedEquals ? `${needle}=${value}` : `${needle} ${value}`;
    i = j;
  }
  return out;
}

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  chromePlaywrightLaunchArgs,
  chromeUserDataDirFlag,
  FORBIDDEN_RELATIVE_CHROME_PROFILE,
  isUnsafeChromeUserDataDir,
  resolveChromeUserDataDir,
  rewriteUserDataDirArgs,
  rewriteUserDataDirInCommand,
} from "../src/chrome-user-data.js";
import { playwrightChromiumLaunchOptions } from "../src/card-png.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function userDataDirFromArgs(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--user-data-dir") return args[i + 1] ?? "";
    if (a.startsWith("--user-data-dir=")) return a.slice("--user-data-dir=".length);
  }
  throw new Error("missing --user-data-dir");
}

function assertSafeUserDataDir(dir: string): void {
  expect(path.isAbsolute(dir), dir).toBe(true);
  expect(isUnsafeChromeUserDataDir(dir)).toBe(false);
  expect(dir.replace(/\\/g, "/")).not.toBe(FORBIDDEN_RELATIVE_CHROME_PROFILE);
  expect(dir).not.toContain("./chrome-profile");
}

describe("resolveChromeUserDataDir", () => {
  it("默认落到绝对可写目录，不是 ./chrome-profile，也不进 cwd", () => {
    const cwd = tmp("chrome-ud-cwd-");
    const dir = resolveChromeUserDataDir({
      cwd,
      env: { LOCALAPPDATA: tmp("chrome-ud-local-") },
      preferred: FORBIDDEN_RELATIVE_CHROME_PROFILE,
    });
    assertSafeUserDataDir(dir);
    expect(dir.startsWith(cwd)).toBe(false);
  });

  it("相对 chrome-profile 不按 cwd 展开", () => {
    const cwd = tmp("chrome-ud-rel-");
    const dir = resolveChromeUserDataDir({
      cwd,
      env: { AGENT_CHROME_USER_DATA_DIR: tmp("chrome-ud-abs-") },
      preferred: "chrome-profile",
    });
    assertSafeUserDataDir(dir);
    expect(path.join(cwd, "chrome-profile")).not.toBe(dir);
  });

  it("绝对 preferred 可写且未锁则复用", () => {
    const preferred = tmp("chrome-ud-keep-");
    const dir = resolveChromeUserDataDir({ preferred });
    expect(dir).toBe(path.resolve(preferred));
  });

  it("目录被 SingletonLock 占用时换 pid/随机后缀", () => {
    const preferred = tmp("chrome-ud-lock-");
    writeFileSync(path.join(preferred, "SingletonLock"), "held");
    const dir = resolveChromeUserDataDir({ preferred, pid: 4242, randomSuffix: "locktest" });
    assertSafeUserDataDir(dir);
    expect(dir).not.toBe(path.resolve(preferred));
    expect(dir).toContain("locktest");
  });

  it("Electron userData 下用独立子目录", () => {
    const electronUserData = tmp("chrome-ud-electron-");
    const dir = resolveChromeUserDataDir({
      electronUserData,
      env: {},
      name: "preview",
    });
    assertSafeUserDataDir(dir);
    expect(dir.startsWith(path.join(electronUserData, "fathom-chrome-preview"))).toBe(true);
  });
});

describe("启动参数锁", () => {
  it("chromeUserDataDirFlag 拒绝相对路径", () => {
    expect(() => chromeUserDataDirFlag("./chrome-profile")).toThrow(/absolute/);
  });

  it("rewriteUserDataDirArgs 把 ./chrome-profile 换成绝对路径", () => {
    const args = rewriteUserDataDirArgs(
      ["--remote-debugging-port=9", "--user-data-dir=./chrome-profile", "https://example"],
      { env: { LOCALAPPDATA: tmp("chrome-ud-args-") } },
    );
    const dir = userDataDirFromArgs(args);
    assertSafeUserDataDir(dir);
  });

  it("rewriteUserDataDirInCommand 覆盖 = 与空格两种写法", () => {
    const env = { LOCALAPPDATA: tmp("chrome-ud-cmd-") };
    for (const raw of [
      'chrome --user-data-dir=./chrome-profile http://127.0.0.1/',
      'chrome --user-data-dir="./chrome-profile" http://127.0.0.1/',
      "chrome --user-data-dir ./chrome-profile http://127.0.0.1/",
    ]) {
      const rewritten = rewriteUserDataDirInCommand(raw, { env });
      expect(rewritten, raw).not.toMatch(/--user-data-dir=\.\/chrome-profile/);
      expect(rewritten, raw).not.toMatch(/--user-data-dir "\.\/chrome-profile"/);
      const m = rewritten.match(/--user-data-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);
      expect(m, rewritten).toBeTruthy();
      assertSafeUserDataDir(m![1] ?? m![2] ?? m![3]!);
    }
  });

  it("Playwright 截图启动参数里的 user-data-dir 必须绝对", () => {
    const opts = playwrightChromiumLaunchOptions();
    const dir = userDataDirFromArgs(opts.args);
    assertSafeUserDataDir(dir);
    expect(chromePlaywrightLaunchArgs({ env: { LOCALAPPDATA: tmp("chrome-ud-pw-") } })[0]).toMatch(
      /^--user-data-dir=/,
    );
  });
});

describe("评测走查脚本不手写 ./chrome-profile", () => {
  const files = [
    "eval/persona-ux/walks/_amp-cdp.mjs",
    "eval/persona-ux/walks/_student-cdp.mjs",
    "eval/persona-ux/walks/_antigravity-cdp.mjs",
    "eval/persona-ux/_tmp-walk-server.mjs",
  ];

  it("CDP / walk 启动器走 resolveChromeUserDataDir，启动串不含相对 profile", () => {
    for (const rel of files) {
      const src = readFileSync(path.join(process.cwd(), rel), "utf8");
      expect(src, rel).toContain("resolveChromeUserDataDir");
      expect(src, rel).not.toMatch(/--user-data-dir=\.\/chrome-profile/);
      expect(src, rel).not.toMatch(/PROFILE\s*=\s*["']\.\/chrome-profile["']/);
    }
  });
});

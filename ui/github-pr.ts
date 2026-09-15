/**
 * 从当前 workdir 的 git 状态开 GitHub PR。
 * 命令一律 file + args，不拼 shell；token 只进子进程 env，不进日志、不进返回值。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import {
  isSafeGitBranchName,
  probeWorkspaceGit,
  type WorkspaceGit,
} from "../src/workspace-git.js";

const execFileAsync = promisify(execFile);

const TOKEN_KEYS = ["GITHUB_TOKEN", "GH_TOKEN", "AGENT_GITHUB_TOKEN"] as const;
const GH_TIMEOUT_MS = 60_000;
const TITLE_MAX = 256;
const BODY_MAX = 65_536;
const PR_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i;

export const GITHUB_PR_CODES = {
  no_token: "no_token",
  not_git: "not_git",
  no_remote: "no_remote",
  detached_head: "detached_head",
  same_branch: "same_branch",
  unsafe_ref: "unsafe_ref",
  gh_failed: "gh_failed",
  no_url: "no_url",
} as const;

export type GithubPrCode = (typeof GITHUB_PR_CODES)[keyof typeof GITHUB_PR_CODES];

export class GithubPrError extends Error {
  readonly code: GithubPrCode;
  readonly status: number;
  constructor(code: GithubPrCode, message: string, status = 409) {
    super(message);
    this.name = "GithubPrError";
    this.code = code;
    this.status = status;
  }
}

export type CommandSpec = {
  file: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

export type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export type CommandRunner = (spec: CommandSpec) => Promise<CommandResult>;

export type GithubPrReady = {
  ready: boolean;
  error?: string;
  code?: GithubPrCode;
  repo?: { owner: string; repo: string };
  head?: string;
  base?: string;
  defaultTitle?: string;
};

export type CreateGithubPrInput = {
  workdir: string;
  title?: string;
  body?: string;
  base?: string;
  head?: string;
};

export type CreateGithubPrResult = {
  url: string;
  number: number | null;
  title: string;
  base: string;
  head: string;
  repo: { owner: string; repo: string };
};

export type GithubPrDeps = {
  run?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  probe?: (workdir: string) => Promise<WorkspaceGit>;
};

/** 只认这三把名字。返回值给调用方自己保管，不要打印。 */
export function resolveGithubToken(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of TOKEN_KEYS) {
    const value = String(env[key] ?? "").trim();
    if (value) return value;
  }
  return null;
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = String(text ?? "");
  for (const secret of secrets) {
    const token = String(secret ?? "").trim();
    if (token.length < 8) continue;
    out = out.split(token).join("[redacted]");
  }
  return out.replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{8,}\b/g, "[redacted]");
}

export function parsePullRequestUrl(text: string): string | null {
  const match = String(text ?? "").match(PR_URL_RE);
  return match ? match[0] : null;
}

export function pullRequestNumber(url: string): number | null {
  const match = String(url ?? "").match(/\/pull\/(\d+)/i);
  return match ? Number(match[1]) : null;
}

export function inspectGithubPrReady(
  git: WorkspaceGit,
  env: NodeJS.ProcessEnv = process.env,
  opts: { base?: string; head?: string } = {},
): GithubPrReady {
  if (!git.present) {
    return {
      ready: false,
      code: GITHUB_PR_CODES.not_git,
      error: "当前工作目录不是 git 仓库，没法开 PR。",
    };
  }
  if (!git.github?.owner || !git.github.repo) {
    return {
      ready: false,
      code: GITHUB_PR_CODES.no_remote,
      error: "这个文件夹还没有 GitHub 远程。先加 origin 再开 PR。",
    };
  }
  if (!resolveGithubToken(env)) {
    return {
      ready: false,
      code: GITHUB_PR_CODES.no_token,
      error: "还没配置 GitHub 令牌。在环境里设 GITHUB_TOKEN、GH_TOKEN 或 AGENT_GITHUB_TOKEN 后再开。",
      repo: git.github,
    };
  }
  if (git.detached || !git.branch) {
    return {
      ready: false,
      code: GITHUB_PR_CODES.detached_head,
      error: "现在是游离 HEAD，没法用当前提交当 head 开 PR。先切到一个分支。",
      repo: git.github,
    };
  }
  const head = String(opts.head ?? "").trim() || git.branch;
  const base = String(opts.base ?? "").trim() || undefined;
  if (base && head === base) {
    return {
      ready: false,
      code: GITHUB_PR_CODES.same_branch,
      error: `当前就在 ${head} 上，跟目标分支相同，换一个分支再开 PR。`,
      repo: git.github,
      head,
      base,
    };
  }
  return {
    ready: true,
    repo: git.github,
    head,
    ...(base ? { base } : {}),
    defaultTitle: head,
  };
}

export function buildGhPrCreateArgs(input: {
  title: string;
  body: string;
  base: string;
  head: string;
}): string[] {
  return [
    "pr",
    "create",
    "--base",
    input.base,
    "--head",
    input.head,
    "--title",
    input.title,
    "--body",
    input.body,
  ];
}

export async function defaultCommandRunner(spec: CommandSpec): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(spec.file, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      timeout: GH_TIMEOUT_MS,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return { stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: 0 };
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; status?: number };
    const code = typeof failure.status === "number"
      ? failure.status
      : failure.code === "ENOENT"
        ? 127
        : 1;
    return {
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? failure.message ?? ""),
      code,
    };
  }
}

function childEnvForGh(env: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  next.GH_TOKEN = token;
  next.GITHUB_TOKEN = token;
  next.GH_PROMPT_DISABLED = "1";
  next.GH_NO_UPDATE_NOTIFIER = "1";
  return next;
}

async function runGit(
  run: CommandRunner,
  cwd: string,
  args: string[],
): Promise<string> {
  const result = await run({ file: "git", args: ["-C", cwd, ...args], cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "git 失败");
  }
  return result.stdout.trim();
}

export async function resolveDefaultBase(
  root: string,
  run: CommandRunner = defaultCommandRunner,
): Promise<string> {
  try {
    const pointed = await runGit(run, root, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    const short = pointed.replace(/^origin\//, "").trim();
    if (isSafeGitBranchName(short)) return short;
  } catch {
    /* 没有 origin/HEAD 时试常见默认名 */
  }
  for (const candidate of ["main", "master"]) {
    try {
      await runGit(run, root, ["rev-parse", "--verify", `refs/heads/${candidate}`]);
      return candidate;
    } catch {
      /* 下一个 */
    }
  }
  return "main";
}

function clipText(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

export async function createGithubPullRequest(
  input: CreateGithubPrInput,
  deps: GithubPrDeps = {},
): Promise<CreateGithubPrResult> {
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultCommandRunner;
  const probe = deps.probe ?? probeWorkspaceGit;
  const cwd = resolve(input.workdir);
  const token = resolveGithubToken(env);
  const git = await probe(cwd);
  const requestedBase = clipText(input.base, 200);
  const requestedHead = clipText(input.head, 200);

  let ready = inspectGithubPrReady(git, env);
  if (!ready.ready) {
    throw new GithubPrError(ready.code ?? GITHUB_PR_CODES.gh_failed, ready.error ?? "没法开 PR。");
  }
  if (!git.present || !git.github) {
    throw new GithubPrError(GITHUB_PR_CODES.not_git, "当前工作目录不是 git 仓库，没法开 PR。");
  }
  if (!token) {
    throw new GithubPrError(
      GITHUB_PR_CODES.no_token,
      "还没配置 GitHub 令牌。在环境里设 GITHUB_TOKEN、GH_TOKEN 或 AGENT_GITHUB_TOKEN 后再开。",
    );
  }

  const head = requestedHead || ready.head || git.branch || "";
  if (!isSafeGitBranchName(head)) {
    throw new GithubPrError(GITHUB_PR_CODES.unsafe_ref, "分支名不合法，没法开 PR。", 400);
  }
  const base = requestedBase || await resolveDefaultBase(git.root, run);
  if (!isSafeGitBranchName(base)) {
    throw new GithubPrError(GITHUB_PR_CODES.unsafe_ref, "目标分支名不合法，没法开 PR。", 400);
  }
  ready = inspectGithubPrReady(git, env, { base, head });
  if (!ready.ready) {
    throw new GithubPrError(ready.code ?? GITHUB_PR_CODES.gh_failed, ready.error ?? "没法开 PR。");
  }

  const title = clipText(input.title, TITLE_MAX) || head;
  const body = clipText(input.body, BODY_MAX);
  const args = buildGhPrCreateArgs({ title, body, base, head });
  const result = await run({
    file: "gh",
    args,
    cwd: git.root,
    env: childEnvForGh(env, token),
  });
  const combined = redactSecrets(`${result.stdout}\n${result.stderr}`, [token]);
  const url = parsePullRequestUrl(combined);
  if (result.code !== 0) {
    if (url) {
      return {
        url,
        number: pullRequestNumber(url),
        title,
        base,
        head,
        repo: git.github,
      };
    }
    if (result.code === 127 || /not recognized|ENOENT|not found/i.test(result.stderr)) {
      throw new GithubPrError(
        GITHUB_PR_CODES.gh_failed,
        "本机没有 gh。装好 GitHub CLI，或检查 PATH。",
      );
    }
    const detail = combined.replace(/\s+/g, " ").trim().slice(0, 280);
    throw new GithubPrError(
      GITHUB_PR_CODES.gh_failed,
      detail ? `没开成 PR：${detail}` : "gh 没开成 PR，也没给出地址。",
    );
  }
  if (!url) {
    throw new GithubPrError(GITHUB_PR_CODES.no_url, "gh 跑完了，但没给出 PR 地址。");
  }
  return {
    url,
    number: pullRequestNumber(url),
    title,
    base,
    head,
    repo: git.github,
  };
}

export function publicGithubPrReady(ready: GithubPrReady): GithubPrReady {
  return ready.ready
    ? {
        ready: true,
        repo: ready.repo,
        head: ready.head,
        base: ready.base,
        defaultTitle: ready.defaultTitle,
      }
    : {
        ready: false,
        error: ready.error,
        code: ready.code,
        ...(ready.repo ? { repo: ready.repo } : {}),
        ...(ready.head ? { head: ready.head } : {}),
        ...(ready.base ? { base: ready.base } : {}),
      };
}

export function publicGithubPrResult(result: CreateGithubPrResult): CreateGithubPrResult {
  return {
    url: result.url,
    number: result.number,
    title: result.title,
    base: result.base,
    head: result.head,
    repo: result.repo,
  };
}

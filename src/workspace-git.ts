/**
 * 工作区 git 身份：仓库根、当前分支、GitHub owner/repo。
 * 这是宿主事实，不是领域包能力——换包不该让「我在哪个仓库」消失。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 8_000;
const BRANCH_NAME_RE = /^(?!.*(?:\.\.|@{))[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/;

export interface GithubRepoRef {
  owner: string;
  repo: string;
}

export interface WorkspaceGitSnapshot {
  present: true;
  root: string;
  branch: string | null;
  detached: boolean;
  dirty: boolean;
  github: GithubRepoRef | null;
  branches: string[];
}

export type WorkspaceGit = WorkspaceGitSnapshot | { present: false };

export type WorkspaceDirtyAction = "stash" | "discard";

export const DIRTY_WORKTREE_CODE = "dirty_worktree";

export class DirtyWorktreeError extends Error {
  readonly code = DIRTY_WORKTREE_CODE;
  constructor(message = "工作区有未提交改动，切换前需要先选择如何处理") {
    super(message);
    this.name = "DirtyWorktreeError";
  }
}

export function isSafeGitBranchName(name: string): boolean {
  const branch = String(name ?? "").trim();
  if (!BRANCH_NAME_RE.test(branch)) return false;
  if (branch.startsWith("-") || branch.endsWith(".lock")) return false;
  return true;
}

/** 从 origin URL 抽出 github.com owner/repo；带 user:token 的 URL 只留身份、不回传原文。 */
export function parseGithubRemote(url: string): GithubRepoRef | null {
  const raw = String(url ?? "").trim();
  if (!raw) return null;
  const stripped = raw.replace(/\.git$/i, "");
  const https = stripped.match(/^https?:\/\/(?:[^/@]+@)?(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)/i);
  if (https) return { owner: https[1]!, repo: https[2]! };
  const ssh = stripped.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/#?]+)$/i);
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]! };
  return null;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

export async function probeWorkspaceGit(workdir: string): Promise<WorkspaceGit> {
  const cwd = resolve(workdir);
  let root: string;
  try {
    root = resolve(await git(cwd, ["rev-parse", "--show-toplevel"]));
  } catch {
    return { present: false };
  }

  let branch: string | null = null;
  let detached = false;
  try {
    const current = await git(root, ["branch", "--show-current"]);
    if (current) {
      branch = current;
    } else {
      detached = true;
      branch = (await git(root, ["rev-parse", "--short", "HEAD"])) || null;
    }
  } catch {
    detached = true;
  }

  let dirty = false;
  try {
    dirty = Boolean(await git(root, ["status", "--porcelain"]));
  } catch {
    dirty = false;
  }

  let github: GithubRepoRef | null = null;
  try {
    const remotes = await git(root, ["remote", "-v"]);
    for (const line of remotes.split(/\r?\n/)) {
      const match = line.match(/^origin\s+(\S+)/);
      if (!match) continue;
      github = parseGithubRemote(match[1]!);
      if (github) break;
    }
    if (!github) {
      for (const line of remotes.split(/\r?\n/)) {
        const match = line.match(/^\S+\s+(\S+)/);
        if (!match) continue;
        github = parseGithubRemote(match[1]!);
        if (github) break;
      }
    }
  } catch {
    github = null;
  }

  let branches: string[] = [];
  try {
    const listed = await git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
    branches = listed
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter((name) => name && isSafeGitBranchName(name));
  } catch {
    branches = branch && !detached ? [branch] : [];
  }

  return { present: true, root, branch, detached, dirty, github, branches };
}

export async function switchWorkspaceBranch(
  workdir: string,
  branch: string,
  opts: { dirtyAction?: WorkspaceDirtyAction } = {},
): Promise<WorkspaceGitSnapshot> {
  const name = String(branch ?? "").trim();
  if (!isSafeGitBranchName(name)) {
    throw new Error(`非法分支名：${name}`);
  }
  const current = await probeWorkspaceGit(workdir);
  if (!current.present) throw new Error("当前工作目录不是 git 仓库");
  if (current.branch === name && !current.detached) return current;
  if (current.dirty) {
    if (opts.dirtyAction === "stash") {
      await git(current.root, [
        "stash",
        "push",
        "--include-untracked",
        "-m",
        `fathom-host: switch to ${name}`,
      ]);
    } else if (opts.dirtyAction === "discard") {
      await git(current.root, ["reset", "--hard", "HEAD"]);
    } else {
      throw new DirtyWorktreeError();
    }
  }
  try {
    await git(current.root, ["switch", "--", name]);
  } catch (err) {
    if (err instanceof DirtyWorktreeError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (/local changes|would be overwritten|uncommitted/i.test(message)) {
      throw new DirtyWorktreeError();
    }
    throw new Error(`无法切换到 ${name}：${message}`);
  }
  const next = await probeWorkspaceGit(current.root);
  if (!next.present) throw new Error("切换后读不到仓库状态");
  return next;
}

export type PublicWorkspaceGit = {
  present: boolean;
  root?: string;
  branch?: string | null;
  detached?: boolean;
  dirty?: boolean;
  github?: GithubRepoRef | null;
  branches?: string[];
};

export function publicWorkspaceGit(git: WorkspaceGit): PublicWorkspaceGit {
  if (!git.present) return { present: false };
  return {
    present: true,
    root: git.root,
    branch: git.branch,
    detached: git.detached,
    dirty: git.dirty,
    github: git.github,
    branches: git.branches,
  };
}

/** 给启动行 / dynamicContext：不带 remote URL。 */
export function formatWorkspaceGitLine(git: WorkspaceGit | PublicWorkspaceGit): string {
  if (!git.present) return "not a git repository";
  const repo = git.github ? `${git.github.owner}/${git.github.repo}` : "local";
  const head = git.detached ? `detached ${git.branch ?? "HEAD"}` : (git.branch ?? "HEAD");
  return `${repo} @ ${head}${git.dirty ? " (dirty)" : ""}`;
}

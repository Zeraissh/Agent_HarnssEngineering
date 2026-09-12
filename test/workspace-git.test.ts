import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  DirtyWorktreeError,
  formatWorkspaceGitLine,
  isSafeGitBranchName,
  parseGithubRemote,
  probeWorkspaceGit,
  publicWorkspaceGit,
  switchWorkspaceBranch,
} from "../src/workspace-git.js";

const execFileAsync = promisify(execFile);

let temps: string[] = [];
afterEach(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
  temps = [];
});

async function gitRepo(extra: string[] = []): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ws-git-"));
  temps.push(dir);
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "t@t.test"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "hi\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
  for (const name of extra) {
    await execFileAsync("git", ["branch", name], { cwd: dir });
  }
  return dir;
}

describe("parseGithubRemote / isSafeGitBranchName", () => {
  it("抽出 https / ssh 身份，丢掉 user:token", () => {
    expect(parseGithubRemote("https://user:ghp_secret@github.com/acme/app.git"))
      .toEqual({ owner: "acme", repo: "app" });
    expect(parseGithubRemote("git@github.com:acme/app.git"))
      .toEqual({ owner: "acme", repo: "app" });
    expect(parseGithubRemote("ssh://git@github.com/acme/app")).toEqual({ owner: "acme", repo: "app" });
    expect(parseGithubRemote("https://gitlab.com/acme/app.git")).toBeNull();
  });

  it("拒绝路径穿越与 option 形分支名", () => {
    expect(isSafeGitBranchName("main")).toBe(true);
    expect(isSafeGitBranchName("feat/ui")).toBe(true);
    expect(isSafeGitBranchName("-bad")).toBe(false);
    expect(isSafeGitBranchName("a..b")).toBe(false);
    expect(isSafeGitBranchName("foo.lock")).toBe(false);
    expect(isSafeGitBranchName("a@{b}")).toBe(false);
  });
});

describe("probeWorkspaceGit / switchWorkspaceBranch", () => {
  it("非仓库 → present:false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-nogit-"));
    temps.push(dir);
    expect(await probeWorkspaceGit(dir)).toEqual({ present: false });
  });

  it("读出分支列表，带 token 的 origin 只留 owner/repo", async () => {
    const dir = await gitRepo(["feature"]);
    await execFileAsync(
      "git",
      ["remote", "add", "origin", "https://user:ghp_secret@github.com/acme/app.git"],
      { cwd: dir },
    );
    const snap = await probeWorkspaceGit(dir);
    expect(snap.present).toBe(true);
    if (!snap.present) throw new Error("expected repo");
    expect(snap.branch).toBe("main");
    expect(snap.branches).toEqual(expect.arrayContaining(["main", "feature"]));
    expect(snap.github).toEqual({ owner: "acme", repo: "app" });
    expect(JSON.stringify(publicWorkspaceGit(snap))).not.toContain("ghp_secret");
    expect(formatWorkspaceGitLine(snap)).toBe("acme/app @ main");
  });

  it("切换到已有本地分支", async () => {
    const dir = await gitRepo(["feature"]);
    const next = await switchWorkspaceBranch(dir, "feature");
    expect(next.branch).toBe("feature");
    expect(next.detached).toBe(false);
    await expect(switchWorkspaceBranch(dir, "-evil")).rejects.toThrow(/非法分支名/);
  });

  it("脏工作区无 dirtyAction 拒绝切换，不改 HEAD", async () => {
    const dir = await gitRepo(["feature"]);
    await writeFile(join(dir, "README.md"), "dirty\n");
    await expect(switchWorkspaceBranch(dir, "feature")).rejects.toBeInstanceOf(DirtyWorktreeError);
    const snap = await probeWorkspaceGit(dir);
    expect(snap.present).toBe(true);
    if (!snap.present) throw new Error("expected repo");
    expect(snap.branch).toBe("main");
    expect(snap.dirty).toBe(true);
  });

  it("stash 后切换，工作区变干净", async () => {
    const dir = await gitRepo(["feature"]);
    await writeFile(join(dir, "README.md"), "stashed\n");
    const next = await switchWorkspaceBranch(dir, "feature", { dirtyAction: "stash" });
    expect(next.branch).toBe("feature");
    expect(next.dirty).toBe(false);
  });

  it("discard 后切换，未提交改动丢掉", async () => {
    const dir = await gitRepo(["feature"]);
    await writeFile(join(dir, "README.md"), "gone\n");
    const next = await switchWorkspaceBranch(dir, "feature", { dirtyAction: "discard" });
    expect(next.branch).toBe("feature");
    expect(next.dirty).toBe(false);
  });
});

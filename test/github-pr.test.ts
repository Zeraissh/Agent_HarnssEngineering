import { describe, expect, it } from "vitest";
import {
  buildGhPrCreateArgs,
  createGithubPullRequest,
  GITHUB_PR_CODES,
  GithubPrError,
  inspectGithubPrReady,
  parsePullRequestUrl,
  redactSecrets,
  resolveGithubToken,
  type CommandSpec,
} from "../ui/github-pr.js";

const TOKEN = "ghs_test_token_value_xxxxxxxx";

function gitSnap(over: Record<string, unknown> = {}) {
  return {
    present: true as const,
    root: "/repo",
    branch: "feature",
    detached: false,
    dirty: false,
    github: { owner: "acme", repo: "app" },
    branches: ["main", "feature"],
    ...over,
  };
}

describe("resolveGithubToken / redact / parse url", () => {
  it("按 GITHUB_TOKEN / GH_TOKEN / AGENT_GITHUB_TOKEN 取第一把非空", () => {
    expect(resolveGithubToken({})).toBeNull();
    expect(resolveGithubToken({ GITHUB_TOKEN: " a " })).toBe("a");
    expect(resolveGithubToken({ GH_TOKEN: "b" })).toBe("b");
    expect(resolveGithubToken({ AGENT_GITHUB_TOKEN: "c" })).toBe("c");
    expect(resolveGithubToken({ GITHUB_TOKEN: "a", GH_TOKEN: "b" })).toBe("a");
    expect(resolveGithubToken({ GH_TOKEN: "", AGENT_GITHUB_TOKEN: "c" })).toBe("c");
  });

  it("redact 掉令牌本体，不把 ghp_ 打进错误", () => {
    expect(redactSecrets(`auth ${TOKEN} done`, [TOKEN])).toBe("auth [redacted] done");
    expect(redactSecrets("boom ghp_ABCDEFGHIJKL", [])).toBe("boom [redacted]");
  });

  it("从 gh 输出抽出 PR URL", () => {
    expect(parsePullRequestUrl("https://github.com/acme/app/pull/7\n")).toBe(
      "https://github.com/acme/app/pull/7",
    );
    expect(parsePullRequestUrl("nope")).toBeNull();
  });
});

describe("inspectGithubPrReady", () => {
  it("非仓库 / 无远程 / 无令牌 / 游离 HEAD 都给人话，不装成可开", () => {
    expect(inspectGithubPrReady({ present: false }, { GH_TOKEN: TOKEN }).code)
      .toBe(GITHUB_PR_CODES.not_git);
    expect(inspectGithubPrReady(gitSnap({ github: null }), { GH_TOKEN: TOKEN }).code)
      .toBe(GITHUB_PR_CODES.no_remote);
    expect(inspectGithubPrReady(gitSnap(), {}).code).toBe(GITHUB_PR_CODES.no_token);
    expect(inspectGithubPrReady(gitSnap({ detached: true, branch: "abc123" }), { GH_TOKEN: TOKEN }).code)
      .toBe(GITHUB_PR_CODES.detached_head);
    expect(inspectGithubPrReady(gitSnap({ branch: "main" }), { GH_TOKEN: TOKEN }, { base: "main" }).code)
      .toBe(GITHUB_PR_CODES.same_branch);
  });

  it("有远程、有令牌、在功能分支 → ready，不带回令牌", () => {
    const ready = inspectGithubPrReady(gitSnap(), { GH_TOKEN: TOKEN }, { base: "main" });
    expect(ready).toEqual({
      ready: true,
      repo: { owner: "acme", repo: "app" },
      head: "feature",
      base: "main",
      defaultTitle: "feature",
    });
    expect(JSON.stringify(ready)).not.toContain(TOKEN);
  });
});

describe("createGithubPullRequest", () => {
  it("无令牌失败，不调 runner", async () => {
    const calls: CommandSpec[] = [];
    await expect(createGithubPullRequest(
      { workdir: "/repo", title: "t" },
      {
        env: {},
        probe: async () => gitSnap(),
        run: async (spec) => {
          calls.push(spec);
          return { stdout: "", stderr: "", code: 0 };
        },
      },
    )).rejects.toMatchObject({ code: GITHUB_PR_CODES.no_token });
    expect(calls).toEqual([]);
  });

  it("非仓库 / 无远程失败，不装成已开", async () => {
    await expect(createGithubPullRequest(
      { workdir: "/tmp/not-a-repo" },
      { env: { GH_TOKEN: TOKEN }, probe: async () => ({ present: false }) },
    )).rejects.toBeInstanceOf(GithubPrError);

    await expect(createGithubPullRequest(
      { workdir: "/repo" },
      { env: { GH_TOKEN: TOKEN }, probe: async () => gitSnap({ github: null }) },
    )).rejects.toMatchObject({ code: GITHUB_PR_CODES.no_remote });
  });

  it("成功路径：gh 用参数数组，cwd 是仓库根，令牌只在 env", async () => {
    const calls: CommandSpec[] = [];
    const result = await createGithubPullRequest(
      { workdir: "/repo", title: "fix crc", body: "L1 bit12", base: "main", head: "feature" },
      {
        env: { GH_TOKEN: TOKEN, PATH: "/bin" },
        probe: async () => gitSnap({ root: "/repo" }),
        run: async (spec) => {
          calls.push(spec);
          if (spec.file === "gh") {
            return { stdout: "https://github.com/acme/app/pull/42\n", stderr: "", code: 0 };
          }
          return { stdout: "origin/main\n", stderr: "", code: 0 };
        },
      },
    );
    expect(result.url).toBe("https://github.com/acme/app/pull/42");
    expect(result.number).toBe(42);
    const gh = calls.find((c) => c.file === "gh");
    expect(gh).toBeDefined();
    expect(gh!.args).toEqual(buildGhPrCreateArgs({
      title: "fix crc",
      body: "L1 bit12",
      base: "main",
      head: "feature",
    }));
    expect(gh!.args.every((a) => typeof a === "string")).toBe(true);
    expect(gh!.cwd).toBe("/repo");
    expect(JSON.stringify(gh!.args)).not.toContain(TOKEN);
    expect(gh!.env?.GH_TOKEN).toBe(TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("标题里的分号不会变成 shell", async () => {
    const calls: CommandSpec[] = [];
    await createGithubPullRequest(
      { workdir: "/repo", title: "fix; rm -rf /", base: "main", head: "feature" },
      {
        env: { GITHUB_TOKEN: TOKEN },
        probe: async () => gitSnap(),
        run: async (spec) => {
          calls.push(spec);
          if (spec.file === "gh") {
            return { stdout: "https://github.com/acme/app/pull/1\n", stderr: "", code: 0 };
          }
          return { stdout: "", stderr: "", code: 0 };
        },
      },
    );
    const gh = calls.find((c) => c.file === "gh");
    expect(gh!.args).toContain("fix; rm -rf /");
    expect(gh!.args.join(" ")).not.toMatch(/^gh pr create /);
  });

  it("gh 失败时错误里没有令牌", async () => {
    await expect(createGithubPullRequest(
      { workdir: "/repo", title: "x", base: "main", head: "feature" },
      {
        env: { AGENT_GITHUB_TOKEN: TOKEN },
        probe: async () => gitSnap(),
        run: async (spec) => spec.file === "gh"
          ? { stdout: "", stderr: `denied ${TOKEN}`, code: 1 }
          : { stdout: "main\n", stderr: "", code: 0 },
      },
    )).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(GithubPrError);
      expect(String((err as Error).message)).not.toContain(TOKEN);
      expect(String((err as Error).message)).toContain("[redacted]");
      return true;
    });
  });
});

// @vitest-environment jsdom
// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_PR_API_URL,
  GITHUB_PR_COPY,
  buildCreatePrPayload,
  githubPrReadyUrl,
  initGithubPrMount,
  prUrlFromResponse,
  renderGithubPrPanel,
} from "../ui/public/features/github-pr.js";
import { initWorkspaceGitChip, renderGitMenu } from "../ui/public/features/workspace-git.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("github-pr 纯函数", () => {
  it("取件地址带 workdir；载荷不带空字段", () => {
    expect(githubPrReadyUrl("/repo")).toBe(`${GITHUB_PR_API_URL}?workdir=%2Frepo`);
    expect(buildCreatePrPayload("/repo", { title: "fix", body: "", base: "main" })).toEqual({
      workdir: "/repo",
      title: "fix",
      base: "main",
    });
  });

  it("只认 github.com PR URL，其它当失败", () => {
    expect(prUrlFromResponse({ url: "https://github.com/acme/app/pull/3" }))
      .toBe("https://github.com/acme/app/pull/3");
    expect(prUrlFromResponse({ url: "https://evil.example/pull/3" })).toBe("");
    expect(prUrlFromResponse({ ok: true })).toBe("");
  });
});

describe("renderGithubPrPanel", () => {
  it("无远程不画；令牌不够只说人话，不给假链接", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    renderGithubPrPanel(host, { git: { present: true, branch: "main" } });
    expect(host.children.length).toBe(0);

    renderGithubPrPanel(host, {
      git: { present: true, branch: "feature", github: { owner: "acme", repo: "app" } },
      ready: { ready: false, error: "还没配置 GitHub 令牌。" },
    });
    expect(host.textContent).toContain("还没配置 GitHub 令牌");
    expect(host.querySelector("a")).toBeNull();
    expect(host.querySelector("[data-github-pr='form']")).toBeNull();
  });

  it("成功只给可打开的 PR 链接", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    renderGithubPrPanel(host, {
      git: { present: true, github: { owner: "acme", repo: "app" } },
      url: "https://github.com/acme/app/pull/7",
    });
    const link = host.querySelector("a.git-pr-opened");
    expect(link?.getAttribute("href")).toBe("https://github.com/acme/app/pull/7");
    expect(link?.textContent).toBe(GITHUB_PR_COPY.opened);
    expect(host.textContent).not.toContain("ghs_");
  });
});

describe("initGithubPrMount", () => {
  it("POST 成功展示 URL；失败用人话，不装成已开", async () => {
    const menu = document.createElement("div");
    document.body.appendChild(menu);
    const fetchFn = vi.fn(async (url, init) => {
      if (String(url).includes("/pr") && init?.method === "POST") {
        return { ok: true, json: async () => ({ url: "https://github.com/acme/app/pull/11" }) };
      }
      return {
        ok: true,
        json: async () => ({ ready: true, head: "feature", base: "main", defaultTitle: "feature" }),
      };
    });
    const announce = vi.fn();
    const api = initGithubPrMount(menu, {
      getWorkdir: () => "/repo",
      fetch: fetchFn,
      onAnnounce: announce,
      git: { present: true, branch: "feature", github: { owner: "acme", repo: "app" } },
    });
    await api.refreshReady();
    expect(menu.querySelector("[data-github-pr='form']")).not.toBeNull();
    const title = menu.querySelector("[name='title']");
    title.value = "fix crc";
    menu.querySelector("[data-github-pr='form']").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(fetchFn).toHaveBeenCalledWith(
      GITHUB_PR_API_URL,
      expect.objectContaining({ method: "POST" }),
    );
    const posted = JSON.parse(fetchFn.mock.calls.find((c) => c[1]?.method === "POST")[1].body);
    expect(posted).toEqual({
      workdir: "/repo",
      title: "fix crc",
      base: "main",
      head: "feature",
    });
    expect(menu.querySelector("a")?.getAttribute("href")).toBe("https://github.com/acme/app/pull/11");
    expect(announce).toHaveBeenCalledWith("https://github.com/acme/app/pull/11");
  });

  it("宿主说没令牌时不画提交，也不给 compare", async () => {
    const menu = document.createElement("div");
    document.body.appendChild(menu);
    const api = initGithubPrMount(menu, {
      getWorkdir: () => "/repo",
      fetch: async () => ({
        ok: true,
        json: async () => ({ ready: false, code: "no_token", error: "还没配置 GitHub 令牌。" }),
      }),
      git: { present: true, github: { owner: "acme", repo: "app" } },
    });
    await api.refreshReady();
    expect(menu.textContent).toContain("还没配置 GitHub 令牌");
    expect(menu.querySelector("[data-github-pr='form']")).toBeNull();
    expect(menu.querySelector("a")).toBeNull();
  });
});

describe("workspace-git 菜单接真开 PR", () => {
  it("点开菜单拉 ready；提交走 /api/workspace/git/pr", async () => {
    document.body.innerHTML = `
      <div class="scope-field scope-field--git" id="workspace-git-chip" hidden>
        <button type="button" id="workspace-git-trigger" class="wd-trigger" aria-expanded="false">
          <span id="workspace-git-trigger-text">—</span>
        </button>
        <div id="workspace-git-menu" class="wd-menu git-menu" hidden></div>
      </div>
    `;
    const fetchFn = vi.fn(async (url, init) => {
      if (String(url).includes("/pr") && init?.method === "POST") {
        return { ok: true, json: async () => ({ url: "https://github.com/acme/app/pull/4" }) };
      }
      if (String(url).includes("/pr")) {
        return {
          ok: true,
          json: async () => ({ ready: true, head: "feature", base: "main", defaultTitle: "feature" }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          present: true,
          branch: "feature",
          github: { owner: "acme", repo: "app" },
          branches: ["main", "feature"],
        }),
      };
    });
    const root = document.getElementById("workspace-git-chip");
    const api = initWorkspaceGitChip(root, { getWorkdir: () => "/repo", fetch: fetchFn });
    await api.refresh();
    document.getElementById("workspace-git-trigger").click();
    await flush();
    expect(fetchFn).toHaveBeenCalledWith("/api/workspace/git/pr?workdir=%2Frepo");
    const form = document.querySelector("[data-github-pr='form']");
    expect(form).not.toBeNull();
    form.querySelector("[name='title']").value = "open it";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(document.querySelector("a.git-pr-opened")?.getAttribute("href"))
      .toBe("https://github.com/acme/app/pull/4");
  });

  it("renderGitMenu 不再画 compare 弱链", () => {
    const menu = document.createElement("div");
    document.body.appendChild(menu);
    renderGitMenu(menu, {
      present: true,
      branch: "feature",
      github: { owner: "acme", repo: "app" },
      branches: ["feature"],
    });
    expect(menu.querySelector("a.git-pr-link")).toBeNull();
    expect(menu.querySelector("[data-github-pr='form']")).not.toBeNull();
  });
});

// @vitest-environment jsdom
// @ts-nocheck
/**
 * 产物画廊视图（features/artifacts.js）+ 侧栏项目组入口。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  ARTIFACTS_HASH,
  isArtifactsRoute,
  artifactsQuery,
  shouldShowDeckStaleBadge,
  formatArtifactStamp,
  artifactWorkdirLabel,
  initArtifactsView,
} from "../ui/public/features/artifacts.js";
import { renderRunList } from "../ui/public/app.js";

describe("路由与纯函数", () => {
  it("仅认 #/artifacts，不跟指挥中心抢 hash", () => {
    expect(ARTIFACTS_HASH).toBe("#/artifacts");
    expect(isArtifactsRoute(ARTIFACTS_HASH)).toBe(true);
    expect(isArtifactsRoute("#/board")).toBe(false);
    expect(isArtifactsRoute("#/schedules")).toBe(false);
    expect(isArtifactsRoute("")).toBe(false);
  });

  it("artifactsQuery：有项目走 projectId，否则 workdir；都空是裸路径（服务端 400）", () => {
    expect(artifactsQuery({ projectId: "p1", workdir: "D:\\x" })).toBe("/api/artifacts?projectId=p1");
    expect(artifactsQuery({ workdir: "D:\\x" })).toBe(`/api/artifacts?workdir=${encodeURIComponent("D:\\x")}`);
    expect(artifactsQuery({})).toBe("/api/artifacts");
  });

  it("过期徽章只挂在 deckStale 的画册卡上", () => {
    expect(shouldShowDeckStaleBadge({ kind: "deck", deckStale: true })).toBe(true);
    expect(shouldShowDeckStaleBadge({ kind: "deck", deckStale: false })).toBe(false);
    expect(shouldShowDeckStaleBadge({ kind: "spec", deckStale: true })).toBe(false);
  });

  it("时间戳与目录末段", () => {
    expect(formatArtifactStamp(Date.UTC(2026, 1, 3))).toMatch(/2026-02-0[23]/);
    expect(formatArtifactStamp(0)).toBe("");
    expect(artifactWorkdirLabel("D:\\work\\alpha")).toBe("alpha");
  });
});

function makeFetch(routes) {
  const calls = [];
  const fetchFn = async (path) => {
    calls.push(path);
    const responder = routes[path] ?? routes["*"];
    const out = responder ? responder() : { status: 404, data: { error: "not found" } };
    const status = out.status ?? 200;
    return { ok: status === 200, status, json: async () => out.data };
  };
  return { fetchFn, calls };
}

function bootDom({ routes, host = {}, filter = { workdir: "D:\\scratch" } } = {}) {
  document.body.innerHTML = '<div id="main-panel"></div><button id="artifacts-open-btn"></button>';
  const scratchQ = `/api/artifacts?workdir=${encodeURIComponent("D:\\scratch")}`;
  const { fetchFn, calls } = makeFetch(routes ?? {
    [scratchQ]: () => ({ data: { artifacts: [], deckStale: false } }),
  });
  const api = initArtifactsView(
    {
      getFilter: () => filter,
      getHarnessSnapshot: () => ({ availableProjects: [{ id: "p1", name: "看板" }] }),
      onAnnounce: host.onAnnounce,
      onOpenArtifact: host.onOpenArtifact,
      onNewArtifact: host.onNewArtifact,
      onOpenArtifacts: host.onOpenArtifacts,
      onCloseArtifacts: host.onCloseArtifacts,
    },
    { doc: document, win: window, fetchFn },
  );
  return { api, calls, el: document.getElementById("artifacts-view") };
}

describe("产物画廊 DOM", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("空态：文件夹 + 「还没有产物」", async () => {
    const { api, el } = bootDom();
    api.open();
    await new Promise((r) => setTimeout(r, 0));
    const empty = el.querySelector(".artifacts-empty");
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toContain("还没有产物");
    expect(empty.querySelector(".ph-folder")).not.toBeNull();
    expect(el.querySelector("#artifacts-new-btn")).not.toBeNull();
  });

  it("卡片：标题 / 过期徽章 / 点击走 onOpenArtifact；新建走 composer", async () => {
    const opened = [];
    const news = [];
    const { api, el, calls } = bootDom({
      filter: { projectId: "p1" },
      host: {
        onOpenArtifact: (card) => opened.push(card),
        onNewArtifact: () => news.push("new"),
      },
      routes: {
        "/api/artifacts?projectId=p1": () => ({
          data: {
            artifacts: [
              {
                rel: "pm-spec/index.html",
                workdir: "D:\\work\\alpha",
                kind: "spec",
                title: "产品规格",
                mtimeMs: 1,
                runId: "r1",
                deckStale: false,
              },
              {
                rel: "deck-basic/index.html",
                workdir: "D:\\work\\alpha",
                kind: "deck",
                title: "幻灯画册",
                mtimeMs: 1,
                runId: "r1",
                deckStale: true,
              },
            ],
            deckStale: true,
          },
        }),
      },
    });
    api.open({ projectId: "p1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls[0]).toBe("/api/artifacts?projectId=p1");
    expect(el.querySelector(".artifacts-title").textContent).toContain("看板");
    const cards = [...el.querySelectorAll(".artifact-card")];
    expect(cards).toHaveLength(2);
    expect(cards[1].querySelector(".artifact-card-stale").textContent).toBe("已过期");
    expect(cards[0].querySelector(".artifact-card-stale")).toBeNull();
    cards[1].click();
    expect(opened[0].rel).toBe("deck-basic/index.html");
    el.querySelector("#artifacts-new-btn").click();
    expect(news).toEqual(["new"]);
    expect(el.querySelector(".artifacts-empty").hidden).toBe(true);
    expect(el.querySelector(".artifacts-empty").textContent).not.toContain("还没有产物");
    expect(el.textContent).toContain("产品规格");
    api.close();
    expect(el.querySelector(".artifacts-empty").hidden).toBe(true);
    expect(el.querySelector(".artifacts-empty").textContent).not.toContain("还没有产物");
  });

  it("侧栏入口按钮派发 onOpenArtifacts", () => {
    const hits = [];
    bootDom({ host: { onOpenArtifacts: () => hits.push("open") } });
    document.getElementById("artifacts-open-btn").click();
    expect(hits).toEqual(["open"]);
  });
});

describe("侧栏项目组产物入口", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="run-list"></div>';
  });

  it("项目分组显示产物按钮，点击带 projectId 且不折叠", () => {
    const toggled = [];
    const opened = [];
    const projects = [{
      id: "board-1",
      name: "看板",
      workdirs: ["D:\\work\\alpha"],
      primaryWorkdir: "D:\\work\\alpha",
    }];
    renderRunList(
      [{ runId: "a", task: "t", status: "done", verify: false, workdir: "D:\\work\\alpha", projectId: "board-1" }],
      null,
      () => {},
      new Map(),
      undefined,
      {
        projects,
        onToggle: (k) => toggled.push(k),
        onOpenArtifacts: (id) => opened.push(id),
      },
    );
    const btn = document.querySelector(".run-group-artifacts");
    expect(btn.hidden).toBe(false);
    btn.click();
    expect(opened).toEqual(["board-1"]);
    expect(toggled).toEqual([]);
  });

  it("未入项的路径分组不显示产物按钮", () => {
    renderRunList(
      [{ runId: "a", task: "t", status: "done", verify: false, workdir: "D:\\scratch\\lone" }],
      null,
      () => {},
      new Map(),
      undefined,
      { onOpenArtifacts: () => {} },
    );
    expect(document.querySelector(".run-group-artifacts")?.hidden).toBe(true);
  });
});

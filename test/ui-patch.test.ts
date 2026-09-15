// @vitest-environment jsdom
// @ts-nocheck
/**
 * 细粒度渲染的回归锁（v2 R3 / V-10）。
 *
 * 守的是三件在旧实现下实测失败的事：
 *   · 直播中拒绝理由输入框的内容被清空（每条 SSE 事件重建一次 innerHTML）
 *   · 侧栏焦点每 3 秒被摧毁（轮询整体重建列表）
 *   · 日志滚动位置归零、且长运行退化成 O(n²)
 *
 * 这些都不是 axe 或键盘走查能覆盖的层次——s3d 测的是 Tab 序、s3e 测的是静态
 * ARIA 结构，两者都不涉及"重渲染之后这些状态还在不在"。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createInitialState,
  reduceEvents,
  renderRunDetail,
  renderRunList,
  diffKeyed,
  patchList,
  appendOnly,
  keepScrollAnchored,
  createBatcher,
  shouldShowReconnecting,
  deriveChatItems,
  updateLiveNode,
  renderChatItem,
  splitUserMessageAttachments,
  stripHostEditScopeChrome,
  paintConversationUserText,
  peelHostToolReceipts,
  looksLikeHugeDocumentBody,
  foldedDocumentStub,
  titleReflectsTask,
  resolveDisplayedTitle,
  toolPeek,
  toolHeadline,
  foldChain,
  deriveRunListItems,
  deriveRunTitle,
  deriveThreadTitle,
  deriveConversationRecap,
  WORKDIR_GROUP_COLLAPSE_KEY,
  readCollapsedWorkdirGroups,
  toggleCollapsedWorkdirGroup,
  conversationChainIds,
  deriveThreadFiles,
  renderEmptyState,
  renderStarterGallery,
  DESIGN_MODE_TABS,
  DESIGN_MODE_TAB_LABELS,
  designTabLabel,
  designSamplesForTab,
  resolveDesignSampleChoice,
  designSampleBlockedReason,
  harnessVisionConfigured,
  nextDesignSampleState,
  nextDesignLookState,
  composePromptWithLook,
  isDesignSamplePrompt,
  DESIGN_LOOKS,
  deriveAssemblyBar,
  deriveCitedChat,
  paintGateChip,
  formatGateChip,
  deriveSpinState,
  deriveCostWarning,
  deriveComposerMode,
  composerSubmitPlan,
  patchComposer,
  deriveScrollNav,
  paceReveal,
  revealedWindow,
  keepScrollAnchored,
  renderRunList,
  applyCollapseOverrides,
  nextCollapseOverride,
  buildLocalPathProbePlan,
  toolPathCandidates,
  classifySessionFile,
  rankDeliveryArtifacts,
  inferArtifactIntent,
  ARTIFACT_PREVIEW_LIMIT,
  collapsePriorTurns,
  artifactKindLabel,
  fileShortPath,
  deriveThreadChatItems,
  ancestorRunIds,
  collapseRepeatChatItems,
  chatRepeatKey,
  formatCompletionChatText,
  pickCompletionChatText,
  splitFoldableCompletionSections,
  completionFoldGroups,
  splitCompletionFollowUps,
  classifyCompletionFollowUp,
  deriveRunFollowUp,
  deriveBlockedFace,
  applyBlockedCard,
  composerFolderName,
  newRunPlaceholder,
  extractArtifactPaths,
  mergeCompletionArtifactFiles,
  isNoiseArtifact,
  selectConversationArtifacts,
  selectPreviewArtifacts,
  resolveArtifactOpen,
  ensurePreviewArtifact,
  deriveSessionFiles,
  buildFactorCards,
  deriveLoopFace,
  deriveContextFace,
  deriveToolsFace,
  deriveVerificationFace,
  formatChatRelTime,
  pickTaskAt,
  writeChatRating,
  readChatRating,
  chatPlainText,
  buildChatFeedbackMessage,
  looksLikeChatFeedback,
  markSettledTurnActions,
  deriveChildAgents,
  childAgentKey,
  isChildAgentSource,
  isLiveDeltaSource,
  deriveActionState,
  rewindDialogHtml,
  deriveRewindFilePreview,
  ancestorRunIdsForChat,
  filterRunsByWorkspaceFace,
  filterRunsByComposerWorkdir,
  runBelongsToOffice,
  CODE_STARTER_JOBS,
  OFFICE_STARTER_JOBS,
  buildNewRunRequest,
  describeApprovalAction,
  runEndAnnouncement,
  humanizeSubmitError,
  humanizeActionFailure,
  ROLE_PERSONA,
  deriveLogEntries,
} from "../ui/public/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "..", "ui", "public");

function loadSkeleton(): string {
  const html = readFileSync(join(UI_DIR, "index.html"), "utf-8");
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? "";
  return body.replace(/<script[\s\S]*?<\/script>/g, "");
}

const sse = (seq: number, source: string, type: string, extra = {}) => ({
  seq,
  source,
  event: { type, ...extra },
});

beforeEach(() => {
  document.body.innerHTML = loadSkeleton();
});

describe("消息正文路径探测计划", () => {
  it("工具入参只从有路径语义的结构化字段提取，并递归处理数组", () => {
    expect(toolPathCandidates({
      path: "src/main.ts",
      file_path: "docs/guide.md",
      metadata: {
        directory: "assets/",
        filenames: ["hero.png", "hero.png"],
      },
      cwd: "build/",
    })).toEqual([
      "src/main.ts",
      "docs/guide.md",
      "assets/",
      "hero.png",
      "build/",
    ]);
  });

  it("工具路径不猜 shell、URL 或普通正文里的文件名", () => {
    expect(toolPathCandidates({
      command: "cat src/main.ts",
      url: "https://example.com/out/report.md",
      content: "请打开 out/report.md",
      label: "README.md",
    })).toEqual([]);
  });

  it("同消息目录能把裸文件名解析到真实组合路径", () => {
    const plan = buildLocalPathProbePlan(
      ["threejs-fps-game/", "index.html", "threejs-fps-game/index.html"],
      [],
    );
    const index = plan.entries.find((entry) => entry.label === "index.html");
    expect(index?.choices).toEqual(["threejs-fps-game/index.html", "index.html"]);
    expect(plan.probes).toContain("threejs-fps-game/");
    expect(plan.probes).toContain("threejs-fps-game/index.html");
  });

  it("唯一产物 basename 优先；重名时不猜", () => {
    const unique = buildLocalPathProbePlan(["report.md"], ["out/report.md"]);
    expect(unique.entries[0].choices[0]).toBe("out/report.md");

    const ambiguous = buildLocalPathProbePlan(
      ["report.md"],
      ["a/report.md", "b/report.md"],
    );
    expect(ambiguous.entries[0].choices).toEqual(["report.md"]);
  });

  it("file.ts:12:4 探测时去掉行列号，显示标签保持原样", () => {
    const plan = buildLocalPathProbePlan(["src/file.ts:12:4"]);
    expect(plan.entries[0]).toEqual({ label: "src/file.ts:12:4", choices: ["src/file.ts"] });
  });

  it("覆盖率引用只探测文件名，不把说明当路径", () => {
    const plan = buildLocalPathProbePlan(["vitest.config.ts：lines 75 / branches 78"]);
    expect(plan.entries[0].choices).toEqual(["vitest.config.ts"]);
  });

  it("宿主确认后：文件可打开且可定位，目录可直接打开", async () => {
    let state = createInitialState("run-path", "生成文件", false);
    state = reduceEvents(state, [
      sse(0, "main", "assistant_text", {
        text: "文件 `out/report.md`，目录 `out/`。",
      }),
    ]);
    const onReveal = vi.fn();
    renderRunDetail(state, {
      activeTab: "loop",
      onReveal,
      inspectPaths: async (paths: string[]) => paths.map((input) => ({
        input,
        exists: true,
        path: input.replace(/[\\/]$/, ""),
        kind: /[\\/]$/.test(input) ? "directory" : "file",
      })),
    });

    await vi.waitFor(() => {
      expect(document.querySelector('.local-path-link[href*="artifact"]')).toBeTruthy();
      expect(document.querySelector('.local-path-link--directory')).toBeTruthy();
    });
    const fileLink = document.querySelector('.local-path-link[href*="artifact"]') as HTMLAnchorElement;
    expect(decodeURIComponent(fileLink.href)).toContain("path=out/report.md");
    const reveal = document.querySelector(".local-path-folder") as HTMLButtonElement;
    expect(reveal.getAttribute("aria-label")).toContain("out/report.md");
    reveal.click();
    expect(onReveal).toHaveBeenCalledWith("out/report.md");
  });

  it("覆盖率引用经宿主确认后，文件名可打开，说明仍在旁边", async () => {
    let state = createInitialState("run-cite", "覆盖率", false);
    state = reduceEvents(state, [
      sse(0, "main", "assistant_text", {
        text: 'vitest.config.ts：lines 75 / branches 78 / functions 88，锁在实测下方"只许升不许降"',
      }),
    ]);
    renderRunDetail(state, {
      activeTab: "loop",
      inspectPaths: async (paths: string[]) => {
        expect(paths).toContain("vitest.config.ts");
        expect(paths.some((p) => /lines 75/.test(p))).toBe(false);
        return paths
          .filter((input) => input === "vitest.config.ts")
          .map((input) => ({ input, exists: true, path: input, kind: "file" as const }));
      },
    });

    await vi.waitFor(() => {
      expect(document.querySelector('.local-path-link[href*="artifact"]')).toBeTruthy();
    });
    const fileLink = document.querySelector('.local-path-link[href*="artifact"]') as HTMLAnchorElement;
    expect(decodeURIComponent(fileLink.href)).toContain("path=vitest.config.ts");
    expect(fileLink.textContent).toContain("vitest.config.ts");
    expect(document.body.textContent).toContain("只许升不许降");
  });

  it("折叠的工具调用日志也显示经宿主确认的文件链接与定位按钮", async () => {
    let state = createInitialState("run-tool-path", "读取报告", false);
    state = reduceEvents(state, [
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "main", "tool_call", {
        toolUseId: "tool-path-1",
        name: "read_file",
        input: { path: "out/report.md" },
      }),
    ]);
    const onReveal = vi.fn();
    renderRunDetail(state, {
      activeTab: "loop",
      onReveal,
      inspectPaths: async (paths: string[]) => paths.map((input) => ({
        input,
        exists: true,
        path: input,
        kind: "file",
      })),
    });

    await vi.waitFor(() => {
      expect(document.querySelector(
        '.log-entries .log-entry--collapsed .tool-path-strip .local-path-link[href*="artifact"]',
      )).toBeTruthy();
    });
    const row = document.querySelector('.log-entries .log-entry[data-seq="1"]') as HTMLElement;
    const fileLink = row.querySelector('.local-path-link[href*="artifact"]') as HTMLAnchorElement;
    expect(decodeURIComponent(fileLink.href)).toContain("path=out/report.md");
    const reveal = row.querySelector(".local-path-folder") as HTMLButtonElement;
    expect(reveal.getAttribute("aria-label")).toContain("out/report.md");
    reveal.click();
    expect(onReveal).toHaveBeenCalledWith("out/report.md");
  });
});

// ================================================================
// 产物路径提取（finish_task.artifacts 自由文本 → 真实路径）+ 未落盘摘除
// ================================================================

describe("extractArtifactPaths / 产物卡降级", () => {
  it("剥尾部括号注释（英文括号，内含逗号也不裂）", () => {
    expect(extractArtifactPaths(
      "ad7793_board.kicad_pcb(回填 AD7793 终板,铺铜+缝合+mitre,DRC parity 0)",
    )).toEqual(["ad7793_board.kicad_pcb"]);
  });

  it("剥中文括号注释", () => {
    expect(extractArtifactPaths(
      ".tmp_search/rtd_wiki.txt（英文维基 Resistance thermometer 原始文本，31.5 KB，本轮抓取落盘）",
    )).toEqual([".tmp_search/rtd_wiki.txt"]);
  });

  it("剥 memory: 前缀并按带空格的 ' / ' 拆并列路径", () => {
    expect(extractArtifactPaths("memory: ad7793-pinout.md / kicad-host-kit-lessons.md"))
      .toEqual(["ad7793-pinout.md", "kicad-host-kit-lessons.md"]);
  });

  it("一条多路径 + 尾部注释：拆成两条干净路径", () => {
    expect(extractArtifactPaths("设计说明_ad7793_tc.md / 设计说明_ad7793_board.md(重写为 AD7793 终态)"))
      .toEqual(["设计说明_ad7793_tc.md", "设计说明_ad7793_board.md"]);
  });

  it("目录条目：剥注释后保留目录本身", () => {
    expect(extractArtifactPaths("gerber/(Gerber 8 层 + 钻孔 .drl)")).toEqual(["gerber/"]);
  });

  it("Windows 盘符不是标签前缀，不许剥", () => {
    expect(extractArtifactPaths("D:\\work\\out.txt")).toEqual(["D:\\work\\out.txt"]);
    expect(extractArtifactPaths("C:/work/out.txt")).toEqual(["C:/work/out.txt"]);
  });

  it("文件名自带的括号不在尾部时不误伤", () => {
    expect(extractArtifactPaths("报告(终稿).md")).toEqual(["报告(终稿).md"]);
  });

  it("剥完为空 / 空输入整条丢弃", () => {
    expect(extractArtifactPaths("（只有注释）")).toEqual([]);
    expect(extractArtifactPaths("")).toEqual([]);
    expect(extractArtifactPaths(null)).toEqual([]);
  });

  it("mergeCompletionArtifactFiles：带注释的声明能匹配上工具写出的真文件", () => {
    const session = [{ path: "board/ad7793_board.kicad_pcb", kind: "artifact", seq: 3 }];
    const merged = mergeCompletionArtifactFiles(
      ["ad7793_board.kicad_pcb(回填 AD7793 终板,DRC parity 0)"],
      session,
    );
    expect(merged.map((f) => f.path)).toEqual(["board/ad7793_board.kicad_pcb"]);
  });

  it("mergeCompletionArtifactFiles：一条多路径拆成多张卡", () => {
    const merged = mergeCompletionArtifactFiles(
      ["memory: a.md / b.md（本轮新增）"],
      [],
    );
    expect(merged.map((f) => f.path)).toEqual(["a.md", "b.md"]);
  });

  it("mergeCompletionArtifactFiles：basename 只在唯一命中时对上，重名留下真实路径", () => {
    const unique = mergeCompletionArtifactFiles(
      ["ringfix.css"],
      [{ path: "nested/polish/ringfix.css", kind: "artifact", seq: 1 }],
    );
    expect(unique.map((f) => f.path)).toEqual(["nested/polish/ringfix.css"]);

    const twins = mergeCompletionArtifactFiles(
      ["index.html"],
      [
        { path: "site/index.html", kind: "artifact", seq: 1 },
        { path: "deck-hqu/index.html", kind: "artifact", seq: 2 },
      ],
      { extras: "none" },
    );
    expect(twins.map((f) => f.path).sort()).toEqual(["deck-hqu/index.html", "site/index.html"]);
  });

  it("selectConversationArtifacts：滤掉核查脚本，保留声明交付", () => {
    expect(isNoiseArtifact(".polish-artifacts/capture.mjs")).toBe(true);
    expect(isNoiseArtifact("parse-gyhy.cjs")).toBe(true);
    expect(isNoiseArtifact("style.css")).toBe(false);
    const selected = selectConversationArtifacts(
      [
        { path: "index.html", kind: "artifact", seq: 1 },
        { path: "style.css", kind: "artifact", seq: 2 },
        { path: "parse-gyhy.cjs", kind: "artifact", seq: 3 },
        { path: ".polish-artifacts/run-layout-check.mjs", kind: "artifact", seq: 4 },
      ],
      { declared: ["index.html", "style.css"], task: "帮我优化这个网站" },
    );
    expect(selected.map((f) => f.path)).toEqual(["index.html", "style.css"]);
  });

  it("selectPreviewArtifacts：其它路径也能进预览，只去掉核查噪音", () => {
    const selected = selectPreviewArtifacts([
      { path: "index.html", kind: "artifact", seq: 1 },
      { path: "docs/11-design-mode.md", kind: "artifact", seq: 2 },
      { path: "parse-gyhy.cjs", kind: "artifact", seq: 3 },
      { path: "uploads/shot.png", kind: "upload", seq: 4 },
    ]);
    expect(selected.map((f) => f.path)).toEqual([
      "index.html",
      "docs/11-design-mode.md",
      "uploads/shot.png",
    ]);
  });

  it("resolveArtifactOpen：任何路径都走右侧画布，清单外的并到末尾", () => {
    expect(ensurePreviewArtifact([{ path: "index.html" }], "docs/other.md")).toEqual({
      list: [{ path: "index.html" }, { path: "docs/other.md", kind: "preview" }],
      index: 1,
    });
    expect(resolveArtifactOpen([{ path: "index.html" }], "index.html")).toEqual({
      mode: "canvas",
      index: 0,
    });
    expect(resolveArtifactOpen([{ path: "index.html" }], "docs/other.md")).toEqual({
      mode: "canvas",
      index: 1,
    });
    expect(resolveArtifactOpen([], "")).toEqual({ mode: "none" });
  });

  it("stat 验证不过的产物卡从清单拿掉，不留「未找到」空位", async () => {
    let state = createInitialState("run-missing-art", "生成板子文件", false);
    state = reduceEvents(state, [
      sse(0, "main", "assistant_text", { text: "已交付。" }),
      sse(1, "main", "done", {
        stopReason: "completed",
        completion: {
          status: "completed",
          summary: "完成",
          artifacts: ["ghost/missing.md（本轮声明但没落盘）"],
          verification: [],
          assumptions: [],
          blockers: [],
        },
      }),
    ]);
    renderRunDetail(state, {
      activeTab: "loop",
      inspectPaths: async (paths: string[]) => paths.map((input) => ({
        input, exists: false,
      })),
    });

    await vi.waitFor(() => {
      expect(document.querySelector('[data-artifact-state="checking"]')).toBeNull();
      expect(document.querySelector("[data-artifact-path]")).toBeNull();
    });
    expect(document.body.textContent).not.toContain("未找到");
    expect(document.body.textContent).not.toContain("missing.md");
    expect(document.body.textContent).not.toContain("本轮声明但没落盘");
    expect(document.querySelector(".chat-artifacts")).toBeNull();
  });

  it("stat 验证通过的产物卡保持可点", async () => {
    let state = createInitialState("run-ok-art", "生成报告", false);
    state = reduceEvents(state, [
      sse(0, "main", "assistant_text", { text: "已交付。" }),
      sse(1, "main", "done", {
        stopReason: "completed",
        completion: {
          status: "completed",
          summary: "完成",
          artifacts: ["out/report.md"],
          verification: [],
          assumptions: [],
          blockers: [],
        },
      }),
    ]);
    renderRunDetail(state, {
      activeTab: "loop",
      inspectPaths: async (paths: string[]) => paths.map((input) => ({
        input, exists: true, path: input, kind: "file" as const,
      })),
    });

    await vi.waitFor(() => {
      expect(document.querySelector('[data-artifact-state="ok"]')).toBeTruthy();
    });
    expect(document.querySelector(".chat-artifact--missing")).toBeNull();
    expect(document.querySelector('.chat-artifact a[href*="artifact"]')).toBeTruthy();
  });

  it("stat 把裸文件名落到唯一真实路径后，卡片可点且不再标未找到", async () => {
    let state = createInitialState("run-ringfix", "修圆环", false);
    state = reduceEvents(state, [
      sse(0, "main", "assistant_text", { text: "已交付。" }),
      sse(1, "main", "done", {
        stopReason: "completed",
        completion: {
          status: "completed",
          summary: "完成",
          artifacts: ["ringfix.css"],
          verification: [],
          assumptions: [],
          blockers: [],
        },
      }),
    ]);
    renderRunDetail(state, {
      activeTab: "loop",
      inspectPaths: async (paths: string[]) => paths.map((input) => ({
        input,
        exists: input === "ringfix.css" || input.endsWith("ringfix.css"),
        path: input === "ringfix.css" ? "nested/polish/ringfix.css" : input,
        kind: "file" as const,
      })),
    });

    await vi.waitFor(() => {
      expect(document.querySelector('[data-artifact-state="ok"]')).toBeTruthy();
    });
    const card = document.querySelector(".chat-artifact") as HTMLElement;
    expect(card.getAttribute("data-artifact-path")).toBe("nested/polish/ringfix.css");
    expect(card.textContent).not.toContain("未找到");
    expect(decodeURIComponent((card.querySelector("a[href*='artifact']") as HTMLAnchorElement).href))
      .toContain("path=nested/polish/ringfix.css");
  });

  it("右栏混有未落盘声明时只留真文件，分组计数跟着改", async () => {
    let state = createInitialState("run-rail-ghost", "帮我优化这个网站", false);
    state = reduceEvents(state, [
      sse(0, "main", "tool_call", { toolUseId: "w", name: "write_file", input: { path: "index.html" } }),
      sse(1, "main", "tool_result", { toolUseId: "w", result: { content: "ok", isError: false } }),
      sse(2, "main", "tool_call", { toolUseId: "g", name: "write_file", input: { path: "edp-shotel.mjs" } }),
      sse(3, "main", "tool_result", { toolUseId: "g", result: { content: "ok", isError: false } }),
      sse(4, "main", "done", {
        stopReason: "completed",
        completion: {
          status: "completed",
          summary: "完成",
          artifacts: ["index.html", "edp-shotel.mjs"],
          verification: [],
          assumptions: [],
          blockers: [],
        },
      }),
    ]);
    renderRunDetail(state, {
      activeTab: "loop",
      inspectPaths: async (paths: string[]) => paths.map((input) => ({
        input,
        exists: String(input).includes("index.html"),
        path: input,
        kind: "file" as const,
      })),
    });

    await vi.waitFor(() => {
      expect(document.querySelector('[data-artifact-state="checking"]')).toBeNull();
      expect(document.querySelector('[data-artifact-path="edp-shotel.mjs"]')).toBeNull();
    });
    expect(document.body.textContent).not.toContain("未找到");
    expect(document.querySelector(".artifacts")?.textContent).not.toContain("edp-shotel.mjs");
    expect(document.querySelector(".chat-artifacts")?.textContent ?? "").not.toContain("edp-shotel.mjs");
    const peek = [...document.querySelectorAll(".rail-section-title")].find((n) => n.textContent?.includes("网站"));
    expect(peek?.textContent).toMatch(/网站\s*1/);
    expect(document.querySelector('[data-artifact-path="index.html"]')).toBeTruthy();
  });
});

// ================================================================
// diffKeyed —— 纯函数
// ================================================================

describe("diffKeyed", () => {
  it("全新列表：全是 inserts，beforeKey 指向后继", () => {
    const d = diffKeyed([], ["a", "b", "c"]);
    expect(d.removes).toEqual([]);
    expect(d.keeps).toEqual([]);
    expect(d.inserts.map((i) => i.key)).toEqual(["a", "b", "c"]);
    expect(d.inserts[0].beforeKey).toBe("b");
    expect(d.inserts[2].beforeKey).toBeNull();
  });

  it("纯追加：既有键全部 keeps，不产生 moves", () => {
    const d = diffKeyed(["a", "b"], ["a", "b", "c"]);
    expect(d.keeps).toEqual(["a", "b"]);
    expect(d.inserts.map((i) => i.key)).toEqual(["c"]);
    expect(d.moves).toEqual([]);
  });

  it("删除中间项不把后续项误判为 move", () => {
    const d = diffKeyed(["a", "b", "c"], ["a", "c"]);
    expect(d.removes).toEqual(["b"]);
    expect(d.keeps).toEqual(["a", "c"]);
    expect(d.moves).toEqual([]);
  });

  it("头部插入（列表降序时的典型形态）：只有新项是 insert", () => {
    const d = diffKeyed(["b", "c"], ["a", "b", "c"]);
    expect(d.inserts.map((i) => i.key)).toEqual(["a"]);
    expect(d.inserts[0].beforeKey).toBe("b");
    expect(d.keeps).toEqual(["b", "c"]);
    expect(d.moves).toEqual([]);
  });

  it("真实换位才算 move，且 move 数取最小（走 LCS）", () => {
    const d = diffKeyed(["a", "b", "c"], ["c", "a", "b"]);
    expect(d.keeps).toEqual(["a", "b"]);
    expect(d.moves.map((m) => m.key)).toEqual(["c"]);
  });

  it("全部替换：旧的全删、新的全插", () => {
    const d = diffKeyed(["a", "b"], ["x", "y"]);
    expect(d.removes).toEqual(["a", "b"]);
    expect(d.inserts.map((i) => i.key)).toEqual(["x", "y"]);
    expect(d.keeps).toEqual([]);
  });
});

// ================================================================
// patchList / appendOnly —— 节点同一性
// ================================================================

describe("patchList 节点复用", () => {
  const spec = {
    key: (x: any) => x.id,
    create: (x: any) => {
      const el = document.createElement("div");
      el.dataset.id = x.id;
      el.textContent = x.label;
      return el;
    },
    update: (node: HTMLElement, x: any) => {
      node.textContent = x.label;
    },
  };

  it("复用同 key 的节点对象，不是重建一个长得一样的", () => {
    const host = document.createElement("div");
    patchList(host, [{ id: "a", label: "1" }], spec);
    const first = host.firstElementChild;
    patchList(host, [{ id: "a", label: "2" }], spec);
    expect(host.firstElementChild).toBe(first); // 引用相等
    expect(first!.textContent).toBe("2"); // 内容确实更新了
  });

  it("头部插入后既有节点仍是原对象，且顺序正确", () => {
    const host = document.createElement("div");
    patchList(host, [{ id: "b", label: "B" }], spec);
    const bNode = host.firstElementChild;
    patchList(host, [{ id: "a", label: "A" }, { id: "b", label: "B" }], spec);
    expect([...host.children].map((c) => (c as HTMLElement).dataset.id)).toEqual(["a", "b"]);
    expect(host.children[1]).toBe(bNode);
  });

  it("移除的项从 DOM 与索引中一并消失", () => {
    const host = document.createElement("div");
    patchList(host, [{ id: "a", label: "A" }, { id: "b", label: "B" }], spec);
    patchList(host, [{ id: "b", label: "B" }], spec);
    expect(host.children).toHaveLength(1);
    expect((host.firstElementChild as HTMLElement).dataset.id).toBe("b");
  });
});

describe("appendOnly", () => {
  const spec = {
    key: (e: any) => String(e.seq),
    create: (e: any) => {
      const el = document.createElement("div");
      el.dataset.seq = String(e.seq);
      return el;
    },
  };

  it("只处理新增项，已渲染节点原样不动", () => {
    const host = document.createElement("div");
    appendOnly(host, [{ seq: 0 }, { seq: 1 }], spec);
    const nodes = [...host.children];
    appendOnly(host, [{ seq: 0 }, { seq: 1 }, { seq: 2 }], spec);
    expect(host.children).toHaveLength(3);
    expect(host.children[0]).toBe(nodes[0]);
    expect(host.children[1]).toBe(nodes[1]);
  });

  it("重复传入同一批不产生重复节点（重连重放安全）", () => {
    const host = document.createElement("div");
    const batch = [{ seq: 0 }, { seq: 1 }];
    appendOnly(host, batch, spec);
    appendOnly(host, batch, spec);
    expect(host.children).toHaveLength(2);
  });
});

describe("keepScrollAnchored", () => {
  function makeScroller(scrollHeight: number, clientHeight: number, scrollTop: number) {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollHeight", { value: scrollHeight, writable: true });
    Object.defineProperty(el, "clientHeight", { value: clientHeight, writable: true });
    el.scrollTop = scrollTop;
    return el;
  }

  it("贴底时新内容到达后仍贴底", () => {
    const el = makeScroller(1000, 200, 800);
    const pinned = keepScrollAnchored(el, () => {
      (el as any).scrollHeight = 1200;
    });
    expect(pinned).toBe(true);
    expect(el.scrollTop).toBe(1200);
  });

  it("用户往上翻时不被拽回底部", () => {
    const el = makeScroller(1000, 200, 100);
    const pinned = keepScrollAnchored(el, () => {
      (el as any).scrollHeight = 1200;
    });
    expect(pinned).toBe(false);
    expect(el.scrollTop).toBe(100); // 原地不动
  });

  /**
   * 2026-08-09 重做为意图态的三条新锁（委托方实测：批准卡出现、思考流式时
   * 跟随停在半路）。共同判据：**只有用户自己的滚动事件才改变跟随与否**——
   * 瞬时几何位移（容器变矮、贴底动画走到半路）不算数。
   */
  it("批准卡出现（clientHeight 突变、无 scroll 事件）不打断跟随", () => {
    const el = makeScroller(1000, 200, 800); // 贴底
    keepScrollAnchored(el, () => {}); // 建立跟随意图
    el.scrollTop = 800; // 浏览器会把 scrollTop 钳到 scrollHeight-clientHeight
    (el as any).clientHeight = 120; // 批准卡把容器压矮 80px——距底瞬间超阈（80 > 40）
    const pinned = keepScrollAnchored(el, () => {
      (el as any).scrollHeight = 1300;
    });
    expect(pinned, "容器变矮不该被当成用户上翻").toBe(true);
    expect(el.scrollTop).toBe(1300);
  });

  it("贴底动画走到半路时下一批到达，跟随不断（smooth 竞态）", () => {
    const el = makeScroller(1000, 200, 800);
    keepScrollAnchored(el, () => {}); // 建立跟随意图
    el.scrollTop = 400; // 模拟平滑动画的中途位置（无用户滚动事件）
    const pinned = keepScrollAnchored(el, () => {
      (el as any).scrollHeight = 1400;
    });
    expect(pinned, "动画中途位置不该被读成「用户不在底部」").toBe(true);
    expect(el.scrollTop).toBe(1400);
  });

  it("用户滚动事件才是意图：上翻停跟随、翻回底部恢复", () => {
    const el = makeScroller(1000, 200, 800);
    keepScrollAnchored(el, () => {}); // 跟随中
    // 用户上翻：位置 + 真实 scroll 事件
    el.scrollTop = 100;
    el.dispatchEvent(new Event("scroll"));
    let pinned = keepScrollAnchored(el, () => {
      (el as any).scrollHeight = 1600;
    });
    expect(pinned).toBe(false);
    expect(el.scrollTop).toBe(100);
    // 用户翻回底部
    el.scrollTop = 1600 - 200;
    el.dispatchEvent(new Event("scroll"));
    pinned = keepScrollAnchored(el, () => {
      (el as any).scrollHeight = 1800;
    });
    expect(pinned).toBe(true);
    expect(el.scrollTop).toBe(1800);
  });

  it("程序化贴底自己触发的 scroll 事件不搞坏跟随（落点即底部，无需哨兵）", () => {
    const el = makeScroller(1000, 200, 800);
    keepScrollAnchored(el, () => {
      (el as any).scrollHeight = 1200;
    }); // 瞬时贴底：事件送达时几何就在底部
    el.dispatchEvent(new Event("scroll"));
    const pinned = keepScrollAnchored(el, () => {
      (el as any).scrollHeight = 1500;
    });
    expect(pinned, "贴底自触发的 scroll 不该停掉跟随").toBe(true);
    expect(el.scrollTop).toBe(1500);
  });
});

// ================================================================
// createBatcher —— 事件折叠调度
// ================================================================

describe("createBatcher", () => {
  it("同一节拍内的多条事件折叠成一次 flush", () => {
    const flushes: any[] = [];
    let frame: (() => void) | null = null;
    const b = createBatcher((batches) => flushes.push(batches), {
      raf: (cb) => (frame = cb),
      isHidden: () => false,
    });

    b.push("r1", { seq: 0 });
    b.push("r1", { seq: 1 });
    b.push("r2", { seq: 0 });
    expect(flushes).toHaveLength(0); // 还没到节拍
    expect(b.pending()).toBe(3);

    frame!();
    expect(flushes).toHaveLength(1);
    expect(flushes[0].get("r1")).toHaveLength(2);
    expect(flushes[0].get("r2")).toHaveLength(1);
    expect(b.pending()).toBe(0);
  });

  it("1000 条事件只触发一次 flush（锁死 O(n²) 不回归）", () => {
    let calls = 0;
    let frame: (() => void) | null = null;
    const b = createBatcher(() => calls++, {
      raf: (cb) => (frame = cb),
      isHidden: () => false,
    });
    for (let i = 0; i < 1000; i++) b.push("r", { seq: i });
    frame!();
    expect(calls).toBe(1);
  });

  /**
   * 这条是实测踩出来的：R3 首版只用 rAF，而浏览器在标签页隐藏时不触发 rAF——
   * 事件在队列里无限堆积、界面永不更新。后台标签页里等审批的人一直等不到卡片，
   * 等于换个门重新制造了 R1 刚修掉的"审批悄悄消失"。
   */
  it("标签页隐藏时不依赖 rAF，改走定时器（否则界面永不更新）", () => {
    let rafCalled = 0;
    let timerCb: (() => void) | null = null;
    let timerDelay = -1;
    let flushed = 0;

    const b = createBatcher(() => flushed++, {
      raf: () => {
        rafCalled++;
      },
      timer: (cb, ms) => {
        timerCb = cb;
        timerDelay = ms;
      },
      isHidden: () => true,
      hiddenIntervalMs: 250,
    });

    b.push("r", { seq: 0 });
    expect(rafCalled).toBe(0); // 绝不能把命交给 rAF
    expect(timerDelay).toBe(250);

    timerCb!();
    expect(flushed).toBe(1);
    expect(b.pending()).toBe(0);
  });

  it("flushNow 立即折叠（切回前台时用）", () => {
    let flushed = 0;
    const b = createBatcher(() => flushed++, {
      raf: () => {},
      isHidden: () => false,
    });
    b.push("r", { seq: 0 });
    b.flushNow();
    expect(flushed).toBe(1);
    // 队列已空时再 flush 不产生空回调
    b.flushNow();
    expect(flushed).toBe(1);
  });
});

// ================================================================
// 详情页：输入值、焦点、渲染次数
// ================================================================

function stateWithPendingApproval(grantPolicy = { maxScope: "once", maxTtlMs: 60_000, maxUses: 1 }) {
  let s = createInitialState("run-x", "写文件任务", true);
  s = reduceEvents(s, [
    sse(0, "main", "turn_start", { turn: 1 }),
    sse(1, "main", "approval_request", {
      toolUseId: "tu_w",
      name: "write_file",
      input: { path: "a.txt" },
      grantPolicy,
    }),
  ]);
  return s;
}

describe("详情页重渲染下的状态存活 (V-10)", () => {
  it("可复用工具明确显示短期、相同参数边界", () => {
    const onAllowAlways = vi.fn();
    renderRunDetail(
      stateWithPendingApproval({ maxScope: "exact-input", maxTtlMs: 60_000, maxUses: 3 }),
      { activeTab: "overview", onAllowAlways },
    );
    const button = document.querySelector("[data-action='allow-always']") as HTMLButtonElement;
    expect(button.textContent).toBe("短期允许相同参数");
    expect(button.hidden).toBe(false);
    expect(button.title).toContain("最多复用 3 次");
    expect(document.body.textContent).not.toContain("本次对话都允许");
    button.click();
    expect(onAllowAlways).toHaveBeenCalledWith("tu_w#1", "write_file");
  });

  it("once 工具隐藏复用按钮，客户端不能扩大宿主策略", () => {
    renderRunDetail(stateWithPendingApproval(), { activeTab: "overview" });
    const button = document.querySelector("[data-action='allow-always']") as HTMLButtonElement;
    expect(button.hidden).toBe(true);
    expect(button.title).toContain("只允许单次审批");
  });

  it("第一次渲染没接到回调时，补上回调后允许本次仍然可点", () => {
    const onAllow = vi.fn();
    renderRunDetail(stateWithPendingApproval(), { activeTab: "overview" });
    renderRunDetail(stateWithPendingApproval(), { activeTab: "overview", onAllow });
    (document.querySelector("[data-action='allow']") as HTMLButtonElement).click();
    expect(onAllow).toHaveBeenCalledWith("tu_w#1");
  });

  it("拒绝理由输入的内容与光标位置在重渲染后保持", () => {
    let s = stateWithPendingApproval();
    renderRunDetail(s, { activeTab: "overview" });

    const input = document.querySelector(".deny-reason") as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = "路径不在白名单";
    input.setSelectionRange(3, 3);
    input.focus();

    // 直播中又来了一批事件——旧实现在这里会把输入框连同整页一起重建
    s = reduceEvents(s, [
      sse(2, "main", "assistant_text", { text: "继续执行" }),
      sse(3, "main", "turn_start", { turn: 2 }),
    ]);
    renderRunDetail(s, { activeTab: "overview" });

    const after = document.querySelector(".deny-reason") as HTMLInputElement;
    expect(after).toBe(input); // 同一个节点对象
    expect(after.value).toBe("路径不在白名单");
    expect(after.selectionStart).toBe(3);
    expect(document.activeElement).toBe(after);
  });

  it("审批卡按 approvalId 键控：返工轮新增的卡不影响上一轮那张", () => {
    let s = stateWithPendingApproval();
    renderRunDetail(s, { activeTab: "overview" });
    const firstCard = document.querySelector(".approval-card");

    s = reduceEvents(s, [
      sse(2, "host", "approval_resolved", {
        requestSeq: 1, toolUseId: "tu_w", decision: "allow", at: 1,
      }),
      sse(5, "rework", "approval_request", {
        toolUseId: "tu_w", name: "write_file", input: { path: "b.txt" },
      }),
    ]);
    renderRunDetail(s, { activeTab: "overview" });

    /**
     * V-03 的不变量是「同一 toolUseId 跨返工轮不串卡」——按裸 toolUseId 存会让
     * 后一轮覆盖前一轮。表达它的方式随设计调整过：已决的审批不再留在待办区
     * （委托方反馈：无限堆叠、已处理与未处理混排），所以现在断言的是
     * "待办区里只剩本轮那张【新的】卡，且它不是上一轮那张节点"。
     * 上一轮那张的归宿在下面"已处理折叠摘要"一组里锁。
     */
    const cards = [...document.querySelectorAll(".approval-card")];
    expect(cards).toHaveLength(1);
    expect(cards[0], "返工轮的卡必须是新节点，不能复用上一轮那张").not.toBe(firstCard);
    expect(cards[0].querySelector("[data-action='allow']")).toBeTruthy(); // 新的一张可操作
    expect(cards[0].getAttribute("data-approval-id")).toBe("tu_w#5");
  });

  it("已处理的审批离开待办区，不再占一行摘要", () => {
    let s = stateWithPendingApproval();
    s = reduceEvents(s, [
      sse(2, "host", "approval_resolved", {
        requestSeq: 1, toolUseId: "tu_w", decision: "allow", at: 1700000000000,
      }),
    ]);
    renderRunDetail(s, { activeTab: "overview" });

    expect(document.querySelectorAll(".approval-card")).toHaveLength(0);
    expect(document.querySelector(".approvals-done")).toBeNull();
  });

  it("同一状态连续渲染两次：DOM 不变且节点引用不变（幂等）", () => {
    const s = stateWithPendingApproval();
    renderRunDetail(s, { activeTab: "overview" });
    const card = document.querySelector(".approval-card");
    const html = document.getElementById("main-area")!.innerHTML;

    renderRunDetail(s, { activeTab: "overview" });
    expect(document.getElementById("main-area")!.innerHTML).toBe(html);
    expect(document.querySelector(".approval-card")).toBe(card);
  });

  it("日志面板只追加：先渲染的条目在新事件到达后仍是同一节点", () => {
    let s = createInitialState("run-log", "日志任务", false);
    s = reduceEvents(s, [
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "main", "tool_call", { toolUseId: "t1", name: "read_file", input: {} }),
    ]);
    renderRunDetail(s, { activeTab: "log" });
    const firstRow = document.querySelector(".log-entries .log-entry");
    expect(firstRow).toBeTruthy();

    s = reduceEvents(s, [
      sse(2, "main", "tool_result", { toolUseId: "t1", result: { content: "ok" }, durationMs: 3 }),
    ]);
    renderRunDetail(s, { activeTab: "log" });

    const rows = [...document.querySelectorAll(".log-entries .log-entry")];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe(firstRow);
  });

  it("1000 条事件的日志一次渲染完成，且不重建已有节点", () => {
    let s = createInitialState("run-big", "长运行", false);
    const events = [];
    for (let i = 0; i < 1000; i++) {
      events.push(sse(i, "main", "turn_start", { turn: i + 1 }));
    }
    s = reduceEvents(s, events);
    renderRunDetail(s, { activeTab: "log" });
    const rows = document.querySelectorAll(".log-entries .log-entry");
    expect(rows).toHaveLength(1000);
    const firstRow = rows[0];

    // 再来一条：只应新增一个节点，其余原样
    s = reduceEvents(s, [sse(1000, "main", "turn_start", { turn: 1001 })]);
    const createSpy = vi.spyOn(document, "createElement");
    renderRunDetail(s, { activeTab: "log" });
    createSpy.mockRestore();

    expect(document.querySelectorAll(".log-entries .log-entry")).toHaveLength(1001);
    expect(document.querySelectorAll(".log-entries .log-entry")[0]).toBe(firstRow);
  });
});

describe("侧栏重渲染下的焦点存活 (V-10)", () => {
  const runs = [
    { runId: "r1", task: "任务一", status: "running", verify: false },
    { runId: "r2", task: "任务二", status: "done", verify: true },
  ];

  it("列表刷新不摧毁停在运行项上的焦点", () => {
    renderRunList(runs, "r1", () => {}, new Map());
    const item = document.querySelector("#run-list .run-item") as HTMLElement;
    item.focus();
    expect(document.activeElement).toBe(item);

    // 相当于此前每 3 秒一次的整体刷新
    for (let i = 0; i < 5; i++) renderRunList(runs, "r1", () => {}, new Map());

    expect(document.activeElement).toBe(item);
  });

  it("新运行插到列表头部时，既有项与焦点都不受影响", () => {
    renderRunList(runs, "r1", () => {}, new Map());
    const item = document.querySelector('[data-run-id="r1"]') as HTMLElement;
    item.focus();

    const withNew = [{ runId: "r0", task: "最新任务", status: "running", verify: false }, ...runs];
    renderRunList(withNew, "r1", () => {}, new Map());

    expect(document.querySelectorAll("#run-list .run-item")).toHaveLength(3);
    expect(document.querySelector('[data-run-id="r1"]')).toBe(item);
    expect(document.activeElement).toBe(item);
    // 顺序正确：新的在最前
    expect(
      [...document.querySelectorAll("#run-list .run-item")].map((e) =>
        (e as HTMLElement).dataset.runId,
      ),
    ).toEqual(["r0", "r1", "r2"]);
  });
});

// ================================================================
// api_retry 的退避等待要看得见
// ================================================================

describe("重试退避等待在界面上可见", () => {
  /**
   * 抖动上线后，同一 attempt 的等待不再是定值——界面若仍只显示"第几次重试"，
   * 人会以为退避是固定的。这是这个项目反复踩的那条"harness 有、宿主没接"，
   * 新字段落地时就该锁住，而不是等第七次再补。
   */
  function stateWithRetry(extra: Record<string, unknown>) {
    let s = createInitialState("run-r", "重试任务", false);
    s = reduceEvents(s, [
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "main", "api_retry", { turn: 1, attempt: 1, reason: "限流", ...extra }),
    ]);
    return s;
  }

  it("带 backoffMs 时渲染出实际等待时长", () => {
    renderRunDetail(stateWithRetry({ backoffMs: 2250 }), { activeTab: "loop" });
    const body = document.querySelector(".log-entries")?.textContent ?? "";
    expect(body).toContain("限流");
    expect(body).toContain("2.3s"); // formatDuration(2250)
    expect(body).toContain("抖动");
  });

  it("旧事件没有 backoffMs 时不渲染空占位（重放旧 run 不能显示 undefined）", () => {
    renderRunDetail(stateWithRetry({}), { activeTab: "loop" });
    const body = document.querySelector(".log-entries")?.textContent ?? "";
    expect(body).toContain("限流");
    expect(body).not.toContain("退避等待");
    expect(body).not.toContain("undefined");
  });
});

describe("模型 send 起止在界面上可见", () => {
  it("model_call_end 渲染 status 与 durationMs", () => {
    let s = createInitialState("run-m", "模型 span", false);
    s = reduceEvents(s, [
      sse(0, "main", "model_call_start", { turn: 1, attempt: 0 }),
      sse(1, "main", "model_call_end", { turn: 1, attempt: 0, status: "ok", durationMs: 1500 }),
    ]);
    renderRunDetail(s, { activeTab: "loop" });
    const body = document.querySelector(".log-entries")?.textContent ?? "";
    expect(body).toContain("模型请求开始");
    expect(body).toContain("模型请求结束");
    expect(body).toContain("1.5s");
  });
});

// ================================================================
// 文本流式（backlog §4）
// ================================================================

describe("流式输出直接长在对话里", () => {
  /**
   * 服务端 R2 起就在推 `event: delta`。此前它只喂给页面顶部那条**一行**的直播条，
   * 对话里要等整轮结束、`assistant_text` 落下来才突然出现一整段——于是
   * "正在发生的事"和"发生过的事"在两个地方，而人的注意力只能在一处。
   * 委托方："对话中的流式输出也没有做好，思考过程也没法流式被用户看见。"
   *
   * liveText/liveThinking 不进 RunState（delta 不占 seq、重放时不存在），
   * 所以它们是 render 的入参而不是 state 的字段。
   */
  function runningState() {
    let s = createInitialState("run-s", "流式任务", false);
    s = reduceEvents(s, [sse(0, "main", "turn_start", { turn: 1 })]);
    return s;
  }

  const conv = () => document.querySelector(".conversation")?.textContent ?? "";
  const strip = () => document.querySelector(".live-strip .live-text")?.textContent ?? "";

  it("正文增量逐字出现在对话末尾", () => {
    renderRunDetail(runningState(), { activeTab: "loop", liveText: "我先读一下 package.json" });
    expect(conv()).toContain("package.json");
    expect(document.querySelector(".chat-msg--live")).toBeTruthy();
  });

  it("思考增量在对话里收成一条可点开的 Thinking", () => {
    renderRunDetail(runningState(), { activeTab: "loop", liveThinking: "先确认路径在不在工作目录内" });
    expect(conv()).toMatch(/Thinking/);
    const live = document.querySelector("details.chat-thinking--live");
    expect(live, "应当是可折叠的 Thinking，不是只有字数行").toBeTruthy();
    expect(live?.open).toBe(false);
    expect(live?.textContent).toContain("先确认路径在不在工作目录内");
    expect(document.querySelector(".chat-thinking-now")).toBeNull();
  });

  /**
   * 判据翻转记录（委托方 2026-08-09："能否做到流式输出的时候就是以 markdown
   * 形式"）：旧锁「流式正文按纯文本渲染，不做 Markdown」就地退役。当年顾虑的
   * "半截记法抽搐"如今有两层缓冲——增量经匀速放行按帧批量落下，且渲染器对
   * 未闭合围栏本就容忍（余下部分整体成码块）。以下四条是新判据。
   */
  it("流式正文按 Markdown 渲染——闭合的记法立即成型", () => {
    renderRunDetail(runningState(), { activeTab: "loop", liveText: "**已闭合的粗体** 后面还在写" });
    expect(document.querySelector(".chat-msg--live strong")).toBeTruthy();
    expect(conv()).toContain("已闭合的粗体");
  });

  it("未闭合的行内记法保持字面——不闪成半个粗体，闭合时与终稿同向收敛", () => {
    renderRunDetail(runningState(), { activeTab: "loop", liveText: "**还没写完的粗体" });
    expect(document.querySelector(".chat-msg--live strong")).toBeNull();
    expect(conv()).toContain("**还没写完的粗体");
  });

  it("未闭合的围栏从第一行起就是代码块（渲染器的缺收尾容忍是这条的地基）", () => {
    renderRunDetail(runningState(), { activeTab: "loop", liveText: "```ts\nconst a = 1;" });
    expect(document.querySelector(".chat-msg--live pre.md-code")).toBeTruthy();
    expect(conv()).toContain("const a = 1;");
  });

  it("裸 JSON 计划流以『整理中』卡片流入，不是一面代码墙", () => {
    renderRunDetail(runningState(), { activeTab: "loop", liveText: '{"subtasks": [{"id": "s1"' });
    expect(document.querySelector(".chat-msg--live .chat-plan")).toBeTruthy();
    expect(document.querySelector(".chat-msg--live pre.md-code")).toBeNull();
  });

  /**
   * 落定条目：编排计划契约改画分层卡（可并发层 + 节点），原始 JSON 收进 details。
   * 其余裸 JSON 仍走代码块 pretty-print；花括号散文零误伤。
   */
  it("落定的计划契约渲染为分层卡，而不是裸 JSON 代码块", () => {
    let s = runningState();
    s = reduceEvents(s, [
      sse(1, "planner", "assistant_text", {
        text: '{"subtasks": [{"id": "s1", "title": "改固件", "dependsOn": [], "acceptance": ["编译通过"]}]}',
      }),
    ]);
    renderRunDetail(s, { activeTab: "loop" });
    const card = document.querySelector(".chat-plan");
    expect(card, "计划应当渲染为可视化卡片").toBeTruthy();
    expect(card!.textContent).toContain("改固件");
    expect(card!.textContent).toContain("第 1 层");
    expect(document.querySelector(".chat-body--text pre.md-code"), "不应再把计划当正文代码块").toBeNull();
    expect(document.querySelector(".chat-plan-raw")).toBeTruthy();
  });

  it("非计划形状的裸 JSON 仍渲染为高亮代码块并 pretty-print", () => {
    let s = runningState();
    s = reduceEvents(s, [
      sse(1, "main", "assistant_text", { text: '{"ok": true, "count": 2}' }),
    ]);
    renderRunDetail(s, { activeTab: "loop" });
    const pre = document.querySelector(".chat-msg--assistant pre.md-code");
    expect(pre, "普通 JSON 应当仍走代码块").toBeTruthy();
    expect(pre!.textContent).toContain('"ok"');
    expect(pre!.textContent, "展示层应当 pretty-print（原文是单行）").toContain("\n");
  });

  it("正式 plan 事件后对话露出带状态的编排卡，并去掉 planner 的 JSON 正文", () => {
    let s = runningState();
    s = reduceEvents(s, [
      sse(1, "planner", "assistant_text", {
        text: '{"subtasks": [{"id": "s1", "title": "改固件", "dependsOn": [], "acceptance": []}]}',
      }),
      sse(2, "host", "plan", {
        concurrency: 2,
        concurrencyMode: "auto",
        plannerMs: 1200,
        subtasks: [
          { id: "s1", title: "改固件", pack: "stm32-coding", description: "", acceptance: ["编译"], dependsOn: [] },
          { id: "s2", title: "烧录", pack: "stm32-debug", description: "", acceptance: ["跑通"], dependsOn: ["s1"] },
        ],
      }),
    ]);
    renderRunDetail(s, { activeTab: "loop" });
    expect(document.querySelectorAll(".chat-plan").length).toBe(1);
    expect(document.querySelector(".chat-msg--plan")).toBeTruthy();
    expect(document.body.textContent).toContain("烧录");
    expect(document.body.textContent).toContain("第 2 层");
    expect(document.querySelector(".chat-plan-raw")).toBeNull();
  });

  it("以花括号开头的散文不被误判为 JSON，仍按 Markdown 走", () => {
    let s = runningState();
    s = reduceEvents(s, [
      sse(1, "main", "assistant_text", { text: "{占位符} 表示模板里的槽位，**这是散文**。" }),
    ]);
    renderRunDetail(s, { activeTab: "loop" });
    expect(document.querySelector(".chat-msg--assistant strong")).toBeTruthy();
    expect(document.querySelector(".chat-msg--assistant pre.md-code")).toBeNull();
  });

  /**
   * **对话已经在逐字流了，直播条不该再滚同一段字**（V-16）。
   * 两处同时滚同一段文字会让人不知道该看哪儿——那正是"过于难用"的一种。
   */
  it("有增量时直播条让位；只在对话说不出来的时候才出声", () => {
    renderRunDetail(runningState(), { activeTab: "loop", liveText: "正在写" });
    expect((document.querySelector(".live-strip") as HTMLElement).hasAttribute("hidden")).toBe(true);

    let s = runningState();
    s = reduceEvents(s, [
      sse(1, "main", "tool_call", { toolUseId: "t1", name: "read_file", input: { path: "a.ts" } }),
    ]);
    renderRunDetail(s, { activeTab: "loop", liveText: "" });
    expect((document.querySelector(".live-strip") as HTMLElement).hasAttribute("hidden")).toBe(true);
    expect(conv()).toContain("read");
    expect(conv()).toContain("a.ts");
    expect(conv()).not.toContain("read_file");
  });

  it("没有任何增量与工具时仍报「等待模型响应…」", () => {
    renderRunDetail(runningState(), { activeTab: "loop" });
    expect(strip()).toContain("等待模型响应");
  });

  it("本轮已有思考、还没有正文增量时直播条说正在想，不假死等待", () => {
    let s = runningState();
    s = reduceEvents(s, [
      sse(1, "main", "assistant_thinking", { text: "先确认路径在不在工作目录内", redacted: false }),
    ]);
    renderRunDetail(s, { activeTab: "loop" });
    expect(strip()).toContain("正在想");
    expect(strip()).not.toContain("等待模型响应");
    expect(document.querySelector("details.chat-thinking--live")).toBeTruthy();
  });

  it("thinking_delta 不进 RunState；正文 delta 为 0 时直播条跟思考正文", () => {
    let s = runningState();
    s = reduceEvents(s, [sse(1, "main", "thinking_delta", { text: "hmm" })]);
    expect(s.timeline.map((e) => e.type)).not.toContain("thinking_delta");
    renderRunDetail(s, { activeTab: "loop", liveThinking: "hmm" });
    expect((document.querySelector(".live-strip") as HTMLElement).hasAttribute("hidden")).toBe(false);
    expect(strip()).toContain("正在想");
    expect(strip()).toContain("hmm");
    expect(document.querySelector("details.chat-thinking--live")?.textContent).toContain("hmm");
  });

  it("空转时直播条说可停止，对话里也留一行", () => {
    let s = runningState();
    s = reduceEvents(s, [
      sse(1, "main", "recovery_decision", {
        reason: "stagnation",
        action: "change_strategy",
        detail: "连续几轮没有新进展",
      }),
    ]);
    expect(deriveSpinState(s)?.label).toBe("空转 · 可停止");
    renderRunDetail(s, { activeTab: "loop" });
    expect(strip()).toContain("空转 · 可停止");
    expect((document.querySelector(".live-strip") as HTMLElement).classList.contains("live-strip--stall")).toBe(true);
    const chat = deriveChatItems(s, {});
    expect(chat.some((it) => it.kind === "notice" && String(it.text).includes("空转"))).toBe(true);
  });

  it("接近轮次预算时直播条给出成本预警", () => {
    let s = runningState();
    s.runConfig = { guardrails: { maxTurns: 10 } };
    s = reduceEvents(s, [sse(1, "main", "turn_start", { turn: 9 })]);
    expect(deriveCostWarning(s, null)?.label).toMatch(/轮次已用/);
    renderRunDetail(s, { activeTab: "loop", harness: { guardrails: { maxTurns: 10 } } });
    expect(strip()).toMatch(/成本预警|轮次已用/);
  });

  it("运行已结束时不再有流式条目，残留增量也拉不回来", () => {
    let s = runningState();
    s = reduceEvents(s, [
      sse(1, "main", "done", { stopReason: "completed", messageCount: 2, usage: {} }),
      sse(2, "host", "run_end", { outcome: "completed" }),
    ]);
    renderRunDetail(s, { activeTab: "loop", liveText: "还在流的残留文本" });
    expect(document.querySelector(".chat-msg--live")).toBeNull();
    expect((document.querySelector(".live-strip") as HTMLElement).hasAttribute("hidden")).toBe(true);
  });

  it("流式思考只留一条 Thinking，字数增长不重建节点", () => {
    const s = runningState();
    renderRunDetail(s, { activeTab: "loop", liveThinking: "第一句" });
    const now = document.querySelector("details.chat-thinking--live") as HTMLDetailsElement;
    expect(now, "主对话应显示可折叠 Thinking").toBeTruthy();
    expect(now.textContent).toMatch(/Thinking/);
    expect(now.querySelector(".chat-live-thinking")?.textContent).toContain("第一句");

    renderRunDetail(s, { activeTab: "loop", liveThinking: "第一句，第二句" });
    expect(document.querySelector("details.chat-thinking--live"), "Thinking 被整段重建了").toBe(now);
    expect(now.querySelector(".chat-live-thinking")?.textContent).toContain("第一句，第二句");
  });

  it("已落定的思考过程进主对话，默认折叠，点开能看见正文", () => {
    const s = reduceEvents(runningState(), [
      sse(1, "main", "assistant_thinking", { text: "先读文件", redacted: false }),
      sse(2, "main", "assistant_text", { text: "结论写在下面。" }),
    ]);
    renderRunDetail({ ...s, status: "done" }, { activeTab: "loop" });
    const think = document.querySelector("details.chat-thinking") as HTMLDetailsElement;
    expect(think).toBeTruthy();
    expect(think.open).toBe(false);
    expect(think.querySelector("summary")?.textContent).toBe("Thought Process");
    expect(think.textContent).toContain("先读文件");
    expect(document.body.textContent).toContain("结论写在下面");
    think.querySelector("summary")?.click();
    expect(think.open).toBe(true);
    think.querySelector("summary")?.click();
    expect(think.open).toBe(false);
  });

  it("进行中不把每段已落定思考铺进对话，只留当前 live Thinking", () => {
    let s = runningState();
    s = reduceEvents(s, [
      sse(1, "planner", "assistant_thinking", { text: "先拆任务" }),
      sse(2, "main", "assistant_thinking", { text: "先读文件" }),
      sse(3, "main", "tool_call", { toolUseId: "t", name: "read_file", input: { path: "a.ts" } }),
      sse(4, "main", "assistant_thinking", { text: "再写结论" }),
    ]);
    renderRunDetail(s, { activeTab: "loop", liveThinking: "正在想下一步" });
    expect(document.querySelectorAll("details.chat-thinking--live")).toHaveLength(1);
    expect(document.querySelectorAll("details.chat-thinking:not(.chat-thinking--live)")).toHaveLength(0);
  });

  it("已落定的条目不因流式而重建（节点同一性）", () => {
    let s = runningState();
    s = reduceEvents(s, [sse(1, "main", "assistant_text", { text: "上一轮说完的话" })]);
    renderRunDetail(s, { activeTab: "loop", liveText: "新" });
    const first = document.querySelectorAll(".chat-item")[0];
    renderRunDetail(s, { activeTab: "loop", liveText: "新的一句" });
    expect(document.querySelectorAll(".chat-item")[0]).toBe(first);
  });
});

describe("思考正文进对话时间线", () => {
  function runningState() {
    let s = createInitialState("run-think-tl", "思考进时间线", false);
    return reduceEvents(s, [sse(0, "main", "turn_start", { turn: 1 })]);
  }
  const strip = () => document.querySelector(".live-strip .live-text")?.textContent ?? "";

  it("thinking_delta 仍不进 RunState；增长正文出现在对话折叠块摘要里", () => {
    let s = runningState();
    s = reduceEvents(s, [sse(1, "main", "thinking_delta", { text: "先核对 CRC 位号" })]);
    expect(s.timeline.map((e) => e.type)).not.toContain("thinking_delta");
    renderRunDetail(s, { activeTab: "loop", liveThinking: "先核对 CRC 位号" });
    const live = document.querySelector("details.chat-thinking--live") as HTMLDetailsElement;
    expect(live, "对话时间线应当有一条正在跟流的 Thinking").toBeTruthy();
    expect(live.open).toBe(false);
    expect(live.querySelector(".chat-thinking-live-tail")?.textContent).toContain("CRC");
    expect(live.querySelector(".chat-live-thinking")?.textContent).toContain("先核对 CRC 位号");
    expect((document.querySelector(".live-strip") as HTMLElement).hasAttribute("hidden")).toBe(false);
    expect(strip()).toContain("正在想");
    expect(strip()).toContain("CRC");
  });

  it("已有 assistant_thinking 时，事件流那一行跟增长正文，不另造正史", () => {
    let s = runningState();
    s = reduceEvents(s, [
      sse(1, "main", "assistant_thinking", { turn: 1, text: "先读", redacted: false }),
    ]);
    const before = s.timeline.length;
    const logs = deriveLogEntries(s, { thinking: "先读，再对照手册" });
    const think = logs.find((e) => e.type === "assistant_thinking");
    expect(s.timeline).toHaveLength(before);
    expect(think?.live).toBe(true);
    expect(think?.collapsed).toBe(false);
    expect(think?.text).toContain("再对照手册");
    renderRunDetail(s, { activeTab: "loop", liveThinking: "先读，再对照手册" });
    const row = [...document.querySelectorAll(".log-entries .log-entry")].find((r) =>
      (r.textContent ?? "").includes("思考过程"),
    );
    expect(row, "事件流应当露出思考那一行").toBeTruthy();
    expect(row?.classList.contains("log-entry--live-thinking")).toBe(true);
    expect(row?.querySelector(".log-thinking")?.textContent).toContain("再对照手册");
    expect(row?.querySelector(".log-entry-detail")?.textContent).toContain("手册");
  });

  it("重放没有 live 缓冲时只靠 assistant_thinking 终态，残留增量拉不回来", () => {
    let s = runningState();
    s = reduceEvents(s, [
      sse(1, "main", "assistant_thinking", { turn: 1, text: "终态思考", redacted: false }),
      sse(2, "main", "done", { stopReason: "completed", messageCount: 2, usage: {} }),
      sse(3, "host", "run_end", { outcome: "completed" }),
    ]);
    const logs = deriveLogEntries(s, { thinking: "不该出现的增量" });
    const think = logs.find((e) => e.type === "assistant_thinking");
    expect(think?.text).toBe("终态思考");
    expect(think?.live).toBeFalsy();
    renderRunDetail(s, { activeTab: "loop", liveThinking: "不该出现的增量" });
    expect(document.querySelector("details.chat-thinking--live")).toBeNull();
    expect(document.body.textContent).toContain("终态思考");
    expect(document.body.textContent).not.toContain("不该出现的增量");
    const row = [...document.querySelectorAll(".log-entries .log-entry")].find((r) =>
      (r.textContent ?? "").includes("思考过程"),
    );
    expect(row?.querySelector(".log-thinking")).toBeNull();
    expect(row?.textContent).toContain("终态思考".length + " 字");
  });

  it("正文 text 到了思考条让位，事件流回到终态、不再跟增量", () => {
    let s = runningState();
    s = reduceEvents(s, [
      sse(1, "main", "assistant_thinking", { turn: 1, text: "先读", redacted: false }),
    ]);
    const logs = deriveLogEntries(s, { thinking: "还在想", text: "结论如下" });
    const think = logs.find((e) => e.type === "assistant_thinking");
    expect(think?.text).toBe("先读");
    expect(think?.live).toBeFalsy();
    renderRunDetail(s, { activeTab: "loop", liveThinking: "还在想", liveText: "结论如下" });
    expect((document.querySelector(".live-strip") as HTMLElement).hasAttribute("hidden")).toBe(true);
    expect(document.querySelector(".chat-msg--live")?.textContent).toContain("结论如下");
  });
});

describe("思考过程进事件流", () => {
  function withThinking(extra: Record<string, unknown>) {
    let s = createInitialState("run-t", "任务", false);
    return reduceEvents(s, [
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "main", "assistant_thinking", { turn: 1, text: "先读 **package.json**", redacted: false, ...extra }),
    ]);
  }

  it("思考条目进日志、默认折叠、展开后按 Markdown 渲染", () => {
    renderRunDetail(withThinking({}), { activeTab: "loop" });
    const rows = [...document.querySelectorAll(".log-entries .log-entry")];
    const think = rows.find((r) => (r.textContent ?? "").includes("思考过程"))!;
    expect(think, "思考条目没进日志——大概率是 reducer 白名单投影又丢字段了").toBeTruthy();
    // 标题带字数，正文默认折叠（思考比正文长得多，展开会淹没时间线）
    expect(think.textContent).toContain("字");
    expect(think.querySelector(".log-thinking")).toBeNull();
  });

  it("redacted 照实说明，不假装没发生过", () => {
    const s = withThinking({ text: "", redacted: true });
    renderRunDetail(s, { activeTab: "loop" });
    const rows = [...document.querySelectorAll(".log-entries .log-entry")];
    expect(rows.some((r) => (r.textContent ?? "").includes("已加密"))).toBe(true);
  });
});

describe("计划确认门的签字位", () => {
  const PLAN = {
    type: "plan",
    concurrency: 2,
    concurrencyMode: "auto",
    plannerMs: 100,
    gated: true,
    subtasks: [
      {
        id: "s1", title: "一",
        description: "读仓库里现有的 CRC 实现，不要凭空写算法",
        acceptance: ["对照参考实现逐字节一致"],
        dependsOn: [],
      },
      {
        id: "s2", title: "二",
        description: "按 L1 数据手册改 RCC 时钟位",
        acceptance: ["CRC->DR 非 0"],
        dependsOn: ["s1"],
      },
    ],
  };

  function gatedState(extra: any[] = []) {
    let s = createInitialState("run-g", "编排任务", false);
    return reduceEvents(s, [
      sse(0, "host", "turn_start", { turn: 1 }),
      { seq: 1, source: "host", event: PLAN },
      sse(2, "host", "plan_approval_request", { at: 1000 }),
      ...extra,
    ]);
  }

  const rail = () => document.querySelector(".plan-gate") as HTMLElement;

  it("挂起时渲染出可点的批准/否决，并说明此刻否决零副作用", () => {
    renderRunDetail(gatedState(), { activeTab: "loop" });
    expect(rail().hasAttribute("hidden")).toBe(false);
    const text = rail().textContent ?? "";
    expect(text).toContain("计划待你签字");
    expect(text).toContain("2"); // 子任务数
    expect(text).toContain("没有任何副作用");
    expect(rail().querySelector("[data-action='approve']")).toBeTruthy();
    expect(rail().querySelector("[data-action='reject']")).toBeTruthy();
  });

  it("签字位摊开每一步的执行说明和验收，不再让人去 Plan 面翻", () => {
    renderRunDetail(gatedState(), { activeTab: "loop" });
    const review = rail().querySelector(".plan-gate-review") as HTMLElement;
    expect(review, "步骤正文必须在确认门卡片上").toBeTruthy();
    expect(review.getAttribute("tabindex")).toBe("0");
    expect((review.querySelector("[data-plan-edit='description'][data-plan-id='s1']") as HTMLInputElement)?.value)
      .toContain("读仓库里现有的 CRC 实现");
    expect(review.textContent).toContain("对照参考实现逐字节一致");
    expect((review.querySelector("[data-plan-edit='description'][data-plan-id='s2']") as HTMLInputElement)?.value)
      .toContain("按 L1 数据手册改 RCC 时钟位");
    expect(review.querySelector(".plan-node-brief-edit")).toBeTruthy();
    expect(review.querySelectorAll("[data-plan-edit='title']").length).toBe(2);
    expect(review.querySelector(".plan-node-checks")).toBeTruthy();
    expect(review.querySelector("details"), "确认门验收必须摊开，不能再藏进折叠").toBeNull();
    expect(rail().textContent).not.toContain("详见 Plan 面");
    expect(rail().querySelectorAll("button")).toHaveLength(2);
  });

  it("计划卡每条短句可改，批准时带上改过的文本", () => {
    const seen: { d: string, extra?: { edits?: { id: string, title: string, description: string }[] } }[] = [];
    renderRunDetail(gatedState(), {
      activeTab: "loop",
      onPlanDecision: (d: string, extra?: { edits?: { id: string, title: string, description: string }[] }) => {
        seen.push({ d, extra });
      },
    });
    const title = rail().querySelector("[data-plan-edit='title'][data-plan-id='s1']") as HTMLInputElement;
    const brief = rail().querySelector("[data-plan-edit='description'][data-plan-id='s1']") as HTMLInputElement;
    expect(title).toBeTruthy();
    expect(brief).toBeTruthy();
    title.value = "先读 CRC 再改位号";
    brief.value = "对照手册改 RCC";
    (rail().querySelector("[data-action='approve']") as HTMLElement).click();
    expect(seen).toHaveLength(1);
    expect(seen[0].d).toBe("approve");
    expect(seen[0].extra?.edits).toEqual([
      { id: "s1", title: "先读 CRC 再改位号", description: "对照手册改 RCC" },
    ]);
  });

  it("点击真的把决定送出去（行为断言，不是「按钮在不在」）", () => {
    const decisions: string[] = [];
    renderRunDetail(gatedState(), {
      activeTab: "loop",
      onPlanDecision: (d: string) => decisions.push(d),
    });
    (rail().querySelector("[data-action='reject']") as HTMLElement).click();
    expect(decisions).toEqual(["reject"]);
    (rail().querySelector("[data-action='approve']") as HTMLElement).click();
    expect(decisions).toEqual(["reject", "approve"]);
  });

  it("已决后从待办区消失——审计记录归 Plan 面，同一条不在两处重复", () => {
    const s = gatedState([
      sse(3, "host", "plan_approval_resolved", {
        requestSeq: 2, decision: "approve", actor: "user", at: 1700000000000,
      }),
    ]);
    renderRunDetail(s, { activeTab: "loop" });
    expect(rail().hasAttribute("hidden")).toBe(true);
    expect(rail().textContent).toBe("");
  });

  it("没开门的 run 不渲染签字位（默认关，不打扰主路径）", () => {
    let s = createInitialState("run-p", "编排任务", false);
    s = reduceEvents(s, [{ seq: 0, source: "host", event: { ...PLAN, gated: false } }]);
    renderRunDetail(s, { activeTab: "loop" });
    expect(rail().hasAttribute("hidden")).toBe(true);
  });

  it("否决收尾后页头说的是「计划未获批准」，不是「异常终止」", () => {
    const s = gatedState([
      sse(3, "host", "plan_approval_resolved", { requestSeq: 2, decision: "reject", actor: "user", at: 5 }),
      sse(4, "main", "done", { stopReason: "plan_rejected", messageCount: 0, usage: {} }),
      sse(5, "host", "run_end", { outcome: "rejected", mainStopReason: "plan_rejected" }),
    ]);
    renderRunDetail(s, { activeTab: "loop" });
    const head = document.querySelector(".detail-head")?.textContent ?? document.body.textContent ?? "";
    expect(head).toContain("计划未获批准");
    expect(head).not.toContain("异常终止");
  });

  it("计划门停止或否决收尾后不再钉着批准并开跑", () => {
    const rejected = gatedState([
      sse(3, "host", "plan_approval_resolved", { requestSeq: 2, decision: "reject", actor: "user", at: 5 }),
      sse(4, "main", "done", { stopReason: "plan_rejected", messageCount: 0, usage: {} }),
      sse(5, "host", "run_end", { outcome: "rejected", mainStopReason: "plan_rejected" }),
    ]);
    renderRunDetail(rejected, { activeTab: "loop" });
    expect(rail().textContent).not.toContain("批准并开跑");
    expect(rail().hasAttribute("hidden")).toBe(true);

    const stopped = gatedState([
      sse(3, "host", "plan_approval_expired", { requestSeq: 2, cause: "stopped" }),
      sse(4, "main", "done", { stopReason: "aborted", messageCount: 0, usage: {} }),
      sse(5, "host", "run_end", { outcome: "closed", mainStopReason: "aborted" }),
    ]);
    renderRunDetail(stopped, { activeTab: "loop" });
    expect(rail().textContent).not.toContain("批准并开跑");
    expect(document.body.textContent).toContain("已停止");
    expect(document.body.textContent).not.toContain("计划未获批准");

    const stale = gatedState([
      sse(4, "main", "done", { stopReason: "plan_rejected", messageCount: 0, usage: {} }),
      sse(5, "host", "run_end", { outcome: "rejected", mainStopReason: "plan_rejected" }),
    ]);
    renderRunDetail(stale, { activeTab: "loop" });
    expect(rail().textContent).not.toContain("批准并开跑");
  });
});

describe("需你决定：钉在输入框上方的固定坞", () => {
  const dock = () => document.getElementById("action-dock") as HTMLElement;
  const rail = () => document.querySelector(".action-rail") as HTMLElement;

  /**
   * 结构约束：坞必须在滚动容器【外面】。
   *
   * 这是整件事的根据——在里面它就会被内容推走，得靠滚动补偿去追；
   * 在外面它变高变矮只改变滚动容器的高度，容器里的内容一动不动。
   * 哪天有人把它挪回 #main-area 里，这条会当场炸。
   */
  it("坞在 #main-area 之外，且排在提交栏之前", () => {
    const main = document.getElementById("main-area")!;
    expect(main.contains(dock())).toBe(false);
    const form = document.querySelector("#task-form, form")!;
    // compareDocumentPosition：FOLLOWING 表示 form 在 dock 之后
    expect(dock().compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /**
   * 实测抓到的接线漏：坞在 HTML 里初始 hidden，渲染层却只切了里面的 rail。
   * 结果 rail 显示了、坞还盖着，整块「需你决定」永远看不见——
   * 而所有既有测试都只查 `.deny-reason` 之类的节点存在性，隐藏与否照样通过。
   */
  it("有待办时坞与栏一起露出，没待办时一起收起", () => {
    const s = stateWithPendingApproval();
    renderRunDetail(s, { activeTab: "loop" });
    expect(rail().hasAttribute("hidden"), "有待审批却仍隐藏 action-rail").toBe(false);
    expect(dock().hasAttribute("hidden"), "有待审批却仍隐藏 action-dock").toBe(false);

    const idle = createInitialState("run-idle", "无审批任务", true);
    renderRunDetail(idle, { activeTab: "loop" });
    expect(dock().hasAttribute("hidden"), "没待办时坞不该占位").toBe(true);
  });

  it("审批卡渲染在坞里，不在滚动区里", () => {
    renderRunDetail(stateWithPendingApproval(), { activeTab: "loop" });
    const card = document.querySelector(".approval-card")!;
    expect(dock().contains(card)).toBe(true);
    expect(document.getElementById("main-area")!.contains(card)).toBe(false);
  });

  it("GhostApproval：resolvedTargets 分歧时审批卡醒目展示真实路径", () => {
    let s = createInitialState("ghost", "t", false);
    s = reduceEvents(s, [sse(1, "main", "approval_request", {
      toolUseId: "tu_g",
      name: "write_file",
      input: { path: "project_settings.json", content: "x" },
      resolvedTargets: [{
        field: "path",
        requested: "project_settings.json",
        lexical: "D:\\w\\project_settings.json",
        real: "D:\\w\\.env",
        diverges: true,
      }],
    })]);
    s = { ...s, status: "running" };
    renderRunDetail(s, { activeTab: "loop" });
    const resolved = document.querySelector(".approval-resolved")!;
    expect(resolved.hasAttribute("hidden")).toBe(false);
    expect(resolved.classList.contains("approval-resolved--warn")).toBe(true);
    expect(resolved.textContent).toContain("project_settings.json");
    expect(resolved.textContent).toContain(".env");
  });

  it("GhostApproval：无分歧也展示 requested → real，不加警告色", () => {
    let s = createInitialState("ghost-plain", "t", false);
    s = reduceEvents(s, [sse(1, "main", "approval_request", {
      toolUseId: "tu_p",
      name: "write_file",
      input: { path: "out.txt", content: "x" },
      resolvedTargets: [{
        field: "path",
        requested: "out.txt",
        lexical: "D:\\w\\out.txt",
        real: "D:\\w\\out.txt",
        diverges: false,
      }],
    })]);
    s = { ...s, status: "running" };
    renderRunDetail(s, { activeTab: "loop" });
    const resolved = document.querySelector(".approval-resolved")!;
    expect(resolved.hasAttribute("hidden")).toBe(false);
    expect(resolved.classList.contains("approval-resolved--warn")).toBe(false);
    expect(resolved.textContent).toContain("请求 → 真实");
    expect(resolved.textContent).toContain("out.txt");
  });
});

// ================================================================
// 换标签再切回：对话视图不许白屏
// ================================================================

describe("换标签重建时对话视图的签名要一起作废", () => {
  const transcript = {
    segments: [{
      index: 0, source: "main",
      messages: [
        { role: "user", content: "记住暗号 alpha-7" },
        { role: "assistant", content: [{ type: "text", text: "记住了。" }] },
      ],
    }],
  };

  function doneState() {
    let s = createInitialState("run-chat", "记住暗号", false);
    s = reduceEvents(s, [
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "main", "done", { stopReason: "completed", usage: { turns: 1 } }),
    ]);
    return s;
  }

  /**
   * 旧形态下对话是 Loop 面里的子视图，换标签会把它连同下钻面一起重建——
   * 曾因漏清一个签名导致整段对话白屏。**对话升为主干后它在下钻面之外**，
   * 换标签结构上碰不到它。这条锁的就是这个结构事实。
   */
  it("对话在下钻抽屉之外：换标签不影响它", () => {
    const s = doneState();
    renderRunDetail(s, { activeTab: "loop", harness: null });
    const chat = document.querySelector(".conversation")!;
    expect(chat.textContent).toContain("记住暗号");

    renderRunDetail(s, { activeTab: "tools", harness: null });
    renderRunDetail(s, { activeTab: "loop", harness: null });
    expect(document.querySelector(".conversation")).toBe(chat); // 同一个节点，没被重建
    expect(chat.textContent).toContain("记住暗号");
    expect(
      document.getElementById("tab-content")!.contains(chat),
      "对话不该落在下钻面里",
    ).toBe(false);
  });

  it("Tools 面画出 run_config.projectId（白名单 + 渲染锁）", () => {
    const s = reduceEvents(createInitialState("run-p", "任务", false), [
      sse(0, "host", "run_config", { projectId: "board-1", workdir: "D:\\work\\alpha" }),
    ]);
    renderRunDetail(s, { activeTab: "tools", harness: null });
    const text = document.getElementById("tab-content")!.textContent ?? "";
    expect(text).toContain("项目");
    expect(text).toContain("board-1");
  });

  it("Tools 面画出 run_config.campaignId（白名单 + 渲染锁）", () => {
    const s = reduceEvents(createInitialState("run-c", "任务", false), [
      sse(0, "host", "run_config", {
        campaignId: "camp-1",
        campaignRole: "director",
        workdir: "D:\\work\\alpha",
      }),
      sse(1, "host", "campaign_child", { runId: "child-9", title: "固件", status: "running" }),
    ]);
    renderRunDetail(s, { activeTab: "tools", harness: null });
    const text = document.getElementById("tab-content")!.textContent ?? "";
    expect(text).toContain("战役");
    expect(text).toContain("camp-1");
    expect(text).toContain("导演");
    const strip = document.querySelector(".campaign-strip");
    expect(strip, "导演条应在主干对话上方").toBeTruthy();
    expect((strip as HTMLElement).hidden).toBe(false);
    expect(strip!.textContent).toContain("固件");
    expect(strip!.querySelector("[data-open-run='child-9']")).toBeTruthy();
  });
});

// ================================================================
// 重连横幅：正常收尾不是断线
// ================================================================

describe("shouldShowReconnecting：分辨正常收流与真断线", () => {
  it("服务端列表说已完成 → 不报断线（点开历史运行走的就是这条）", () => {
    // 本地 status 此刻还是 createInitialState 的默认 "running"——那不是观测
    expect(shouldShowReconnecting({ info: { status: "done" }, localStatus: "running" })).toBe(false);
  });

  it("本地已收到 run_end → 不报断线（列表还没刷新时走这条）", () => {
    expect(shouldShowReconnecting({ info: { status: "running" }, localStatus: "done" })).toBe(false);
  });

  it("两边都说在跑 → 这才是真断线", () => {
    expect(shouldShowReconnecting({ info: { status: "running" }, localStatus: "running" })).toBe(true);
  });

  it("什么都不知道时按断线处理——宁可多提示一次，也不要静默失联", () => {
    expect(shouldShowReconnecting({})).toBe(true);
  });
});

// ================================================================
// AC2-18 复验补的锁：这几条此前都是"变异了也不红"
// ================================================================

describe("AC-04 展开一条默认折叠的日志：点一下就该展开", () => {
  const entries = [
    { seq: 0, type: "tool_call", collapsed: true },
    { seq: 1, type: "tool_result", collapsed: true },
    { seq: 2, type: "approval_request", collapsed: false },
  ];

  /**
   * 实测缺陷：宿主写的是 `overrides.set(seq, !overrides.get(seq))`，
   * 覆盖表里没有这一条时 `!undefined === true`，而多数条目默认就是 true——
   * 第一次点击把 true 写成 true，DOM 早退，屏幕上一点反应都没有。
   * AC-04 说"两次操作可达原始详情"，实际是三次，且第一次零反馈。
   */
  it("默认折叠的条目：第一次点击就翻成展开（不是第二次）", () => {
    const overrides = new Map<number, boolean>();
    expect(nextCollapseOverride(entries, overrides, 0), "第一次点击必须真的改变状态").toBe(false);
  });

  it("默认展开的条目（审批）：第一次点击折叠", () => {
    expect(nextCollapseOverride(entries, new Map(), 2)).toBe(true);
  });

  it("点两次回到原状", () => {
    const ov = new Map<number, boolean>();
    ov.set(0, nextCollapseOverride(entries, ov, 0)!);
    ov.set(0, nextCollapseOverride(entries, ov, 0)!);
    expect(ov.get(0)).toBe(true);
  });

  it("不存在的 seq 返回 null，宿主据此不写覆盖表", () => {
    expect(nextCollapseOverride(entries, new Map(), 999)).toBeNull();
  });

  it("覆盖表只影响被点过的那条", () => {
    const ov = new Map([[0, false]]);
    const applied = applyCollapseOverrides(entries, ov);
    expect(applied.map((e) => e.collapsed)).toEqual([false, true, false]);
  });

  /**
   * 这个 bug 能活下来的根因：宿主自己另写了一套 toggle，被测的纯函数
   * 全仓零调用——**测试测的是产品不用的那份实现**。所以顺手锁住调用关系。
   */
  it("宿主必须调纯函数，不许自己再写一套 toggle", () => {
    const html = readFileSync(join(__dirname, "..", "ui", "public", "index.html"), "utf-8");
    expect(html).toContain("nextCollapseOverride(");
    expect(html).toContain("applyCollapseOverrides(");
    expect(html, "宿主又在自己翻转覆盖表了").not.toMatch(/overrides\.set\(\s*seq\s*,\s*!/);
  });
});

describe("R-03 无需展开下钻面即可判断结果", () => {
  /**
   * 承载物换过两次，判据没变。v1 是"三标签的概览页"，v2 是"结果卡排在下钻面之前"，
   * 现在是"裁决就地长在对话里 + 一条收尾条"——**旧锁必须跟着迁移**，
   * 否则就是 case-07 §六 那条：验收还写着 ✅，看守它的断言却已经不在被测范围内。
   */
  it("裁决在对话里、终止原因在收尾条上，两者都在下钻抽屉之前", () => {
    let s = createInitialState("run-r3", "任务", true);
    s = reduceEvents(s, [
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "main", "done", { stopReason: "completed", usage: { turns: 1 } }),
      sse(2, "verifier", "verification", {
        round: 0,
        verdict: { passed: false, issues: ["缺收尾"], unverified: [], advisory: [], summary: "未通过" },
      }),
      sse(3, "host", "verdict", {
        verdict: { passed: false, issues: ["缺收尾"], unverified: [], advisory: [], summary: "未通过" },
      }),
      sse(4, "host", "run_end", { stopReason: "completed" }),
    ]);
    renderRunDetail(s, { activeTab: "loop", harness: null });

    const conv = document.querySelector(".conversation")!;
    const outcome = document.querySelector(".outcome-card")!;
    const tabs = document.getElementById("tab-content")!;

    // 不合格项就地长在对话里
    expect(conv.textContent, "裁决没有出现在对话主干里").toContain("缺收尾");
    expect(conv.querySelector(".chat-verdict")).toBeTruthy();
    // 正常收尾时那条「■ 已完成」不出现——读对话就知道，占一整行是浪费
    expect(outcome.hidden, "正常收尾不该再占一整行说废话").toBe(true);
    // 对话排在下钻抽屉之前
    expect(
      conv.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING,
      "对话被排到下钻面之后了——那正是 R-03 要修的毛病",
    ).toBeTruthy();
  });

  /**
   * 会话中心化：核查是逐轮选项，一场对话可能有多轮裁决。裁决必须**落回它出炉的
   * 位置**并标明判的是第几轮——全堆在末尾会把第 1 轮的通过画在第 2 轮指令之后，
   * 读成整场对话通过了。这是渲染锁（host-lags 纪律：新字段 judgedTurn 三处同提交）。
   */
  it("多轮对话里的裁决按出炉位置排、带「判第 N 轮对话」标签；同 round 不同轮的键不撞", () => {
    let s = createInitialState("run-mt", "任务", true);
    s = reduceEvents(s, [
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "main", "assistant_text", { text: "第一轮做完" }),
      sse(2, "main", "done", { stopReason: "completed", usage: { turns: 1 } }),
      sse(3, "verifier", "verification", {
        round: 0, judgedTurn: 1,
        verdict: { passed: true, issues: [], unverified: [], advisory: [], summary: "第一轮一致" },
      }),
      sse(4, "host", "run_end", { stopReason: "completed" }),
      sse(5, "host", "user_message", { turn: 2, text: "再改一点", verify: true, continues: "history" }),
      sse(6, "main", "assistant_text", { text: "第二轮做完" }),
      sse(7, "main", "done", { stopReason: "completed", usage: { turns: 1 } }),
      sse(8, "verifier", "verification", {
        round: 0, judgedTurn: 2,
        verdict: { passed: false, issues: ["第二轮缺一项"], unverified: [], advisory: [], summary: "第二轮未通过" },
      }),
      sse(9, "host", "run_end", { stopReason: "completed" }),
    ]);
    const items = deriveChatItems(s, null);
    const kinds = items.map((it) => `${it.kind}${it.kind === "verdict" ? `@${it.judgedTurn}` : it.kind === "user" ? `:${it.text}` : ""}`);
    const firstVerdict = kinds.indexOf("verdict@1");
    const secondUser = kinds.indexOf("user:再改一点");
    const secondVerdict = kinds.indexOf("verdict@2");
    expect(firstVerdict, "第 1 轮裁决必须存在").toBeGreaterThan(0);
    expect(firstVerdict, "第 1 轮裁决要排在第 2 轮指令之前").toBeLessThan(secondUser);
    expect(secondVerdict).toBeGreaterThan(secondUser);
    // 键唯一：两轮 round 都是 0，键里必须带轮号
    const keys = items.filter((it) => it.kind === "verdict").map((it) => it.key);
    expect(new Set(keys).size).toBe(2);

    renderRunDetail(s, { activeTab: "loop", harness: null });
    const tags = [...document.querySelectorAll(".chat-verdict-turn")];
    expect(tags.map((t) => t.getAttribute("data-judged-turn"))).toEqual(["1", "2"]);
    expect(tags[0]!.textContent).toContain("判第 1 轮对话");
    expect(document.querySelector(".conversation")!.textContent).toContain("再改一点");
    expect(document.querySelector(".conversation")!.textContent).not.toContain("本轮核查");
  });

  it("换模型追问：user_message.executorSwitched 投影进对话标签（白名单不得静默丢）", () => {
    let s = createInitialState("run-sw", "记住暗号", false);
    s = reduceEvents(s, [
      sse(0, "main", "assistant_text", { text: "第一轮：alpha-7" }),
      sse(1, "host", "user_message", {
        turn: 2,
        text: "换模型后续",
        continues: "history",
        executorSwitched: true,
      }),
    ]);
    const um = s.timeline.find((e) => e.type === "user_message");
    expect(um.executorSwitched, "reducer 白名单漏了 executorSwitched").toBe(true);
    const item = deriveChatItems(s, null).find((it) => it.kind === "user" && it.text === "换模型后续");
    expect(item?.executorSwitched).toBe(true);
    document.body.innerHTML = renderChatItem(item);
    expect(document.body.textContent).toContain("已切换模型 · 正史已接上");
  });

  /**
   * 反过来：**非正常收尾必须留着**。对话里只表现为"停了"，看不出是撞了轮数上限；
   * 而这几种各有各的下一步（六值分档的全部意义就在这个提示上）。
   */
  it("撞轮数上限这类收尾要说出来，并给出下一步", () => {
    let s = createInitialState("run-mt", "任务", false);
    s = reduceEvents(s, [
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "main", "done", { stopReason: "max_turns", usage: { turns: 40 } }),
    ]);
    renderRunDetail(s, { activeTab: "loop", harness: null });
    const outcome = document.querySelector(".outcome-card") as HTMLElement;
    expect(outcome.hidden).toBe(false);
    expect(outcome.textContent).toContain("核查救不了这一类");
  });

  /** 委托方：「这个框框可以不用了」——运行中它只会说一句"尚无最终结果" */
  it("运行中收尾条整条隐藏，且不重复对话里已有的执行者报告", () => {
    let s = createInitialState("run-r3b", "任务", false);
    s = reduceEvents(s, [
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "main", "assistant_text", { text: "让我再快速看几个关键文件。" }),
    ]);
    renderRunDetail(s, { activeTab: "loop", harness: null });
    const outcome = document.querySelector(".outcome-card") as HTMLElement;
    expect(outcome.hidden, "运行中不该挂一个说'尚无结果'的空框").toBe(true);
    // 那句话只在对话里出现一次
    const body = document.querySelector(".conversation")!.textContent!;
    expect(body.split("让我再快速看几个关键文件").length - 1).toBe(1);
  });
});
describe("R-01 运行结束后，页面上不该有任何可点的审批按钮", () => {
  /**
   * 此前只有 reducer 与服务端 409 在守；渲染层那道 `operable = isPending && isRunning`
   * 里 isPending 在唯一调用路径上恒为 true，把它改成 `true` 也没有一条测试变红。
   * 这条补的是 DOM 级的终态判据。
   */
  it("done 之后审批转 expired，坞收起，allow/deny 按钮数 = 0", () => {
    let s = createInitialState("run-r1", "写文件", true);
    s = reduceEvents(s, [
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "main", "approval_request", { toolUseId: "tu_1", name: "write_file", input: { path: "a" } }),
    ]);
    renderRunDetail(s, { activeTab: "loop", harness: null });
    expect(document.querySelectorAll("[data-action='allow']").length, "运行中该有可点的按钮").toBe(1);

    s = reduceEvents(s, [
      sse(2, "main", "done", { stopReason: "completed", usage: { turns: 1 } }),
      sse(3, "host", "run_end", { stopReason: "completed" }),
    ]);
    renderRunDetail(s, { activeTab: "loop", harness: null });

    expect(s.pendingApprovals[0].status).toBe("expired");
    expect(document.querySelectorAll("[data-action='allow']").length).toBe(0);
    expect(document.querySelectorAll("[data-action='deny']").length).toBe(0);
    expect(
      (document.getElementById("action-dock") as HTMLElement).hidden,
      "已结束的运行不该还占着待办坞",
    ).toBe(true);
  });
});

// ================================================================
// 对话主干（委托方："还是希望做成对话框的形式"）
// ================================================================

describe("deriveChatItems：对话从事件流派生，因此实时", () => {
  const run = (...evts: any[]) => {
    let s = createInitialState("run-chat2", "查一下今天的天气", false);
    return reduceEvents(s, evts);
  };

  it("任务本身是第一条用户消息——打开运行第一眼要看到自己要求了什么", () => {
    const items = deriveChatItems(run());
    expect(items[0]).toMatchObject({ kind: "user", text: "查一下今天的天气" });
  });

  it("工具调用与它的返回合成一行，而不是两条各自漂着", () => {
    const s = run(
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "main", "tool_call", { toolUseId: "t1", name: "bash", input: { command: "date" } }),
      sse(2, "main", "tool_result", { toolUseId: "t1", result: { content: "2026-08-08", isError: false }, durationMs: 12 }),
    );
    const tools = deriveChatItems(s, null, { showProcess: true }).filter((i) => i.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "bash", status: "ok", result: "2026-08-08", durationMs: 12 });
  });

  it("还没返回的工具是 running 态——运行中就该看得见它正在做什么", () => {
    const s = run(sse(0, "main", "tool_call", { toolUseId: "t1", name: "bash", input: { command: "sleep 5" } }));
    expect(deriveChatItems(s, null, { showProcess: true }).filter((i) => i.kind === "tool")[0]!.status).toBe("running");
  });

  /**
   * 事后回看时，"这一步被拦过"必须看得出来。只把审批卡放在坞里的话，
   * 运行结束坞收起，对话里的那次调用就变成凭空执行了。
   */
  it("经过审批的工具带放行标记", () => {
    const s = run(
      sse(0, "main", "tool_call", { toolUseId: "t1", name: "write_file", input: { path: "a.txt" } }),
      sse(1, "main", "approval_request", { toolUseId: "t1", name: "write_file", input: { path: "a.txt" } }),
    );
    expect(deriveChatItems(s, null, { showProcess: true }).find((i) => i.kind === "tool")).toMatchObject({ gated: true });
  });

  it("换来源插一条分界（main → verifier），turn_start 这类噪声不插", () => {
    const s = run(
      sse(0, "main", "assistant_text", { text: "做完了" }),
      sse(1, "verifier", "assistant_text", { text: "我来复核" }),
    );
    const kinds = deriveChatItems(s, null, { showProcess: true }).map((i) => i.kind);
    expect(kinds.filter((k) => k === "boundary")).toHaveLength(2); // main 段 + verifier 段
  });

  it("默认收起过程：工具不进主对话，运行中只留 activity", () => {
    const s = run(
      sse(0, "main", "tool_call", { toolUseId: "t1", name: "bash", input: { command: "date" } }),
    );
    const items = deriveChatItems(s, null, { showProcess: false });
    expect(items.filter((i) => i.kind === "tool")).toHaveLength(0);
    expect(items.find((i) => i.kind === "activity")).toMatchObject({ name: "bash" });
  });

  it("默认收起过程：终局只留问答与正文，像总结", () => {
    let s = run(
      sse(0, "main", "tool_call", { toolUseId: "t1", name: "bash", input: { command: "date" } }),
      sse(1, "main", "tool_result", { toolUseId: "t1", result: { content: "ok", isError: false } }),
      sse(2, "main", "assistant_text", { text: "## 结论\n今天晴。" }),
    );
    s = { ...s, status: "done" };
    const kinds = deriveChatItems(s, null, { showProcess: false }).map((i) => i.kind);
    expect(kinds).toEqual(["user", "text"]);
  });

  it("追问进行中：历史轮仍保持收官形态，不把工具和分段思考摊回来", () => {
    let s = run(
      sse(0, "main", "assistant_thinking", { text: "先读" }),
      sse(1, "main", "tool_call", { toolUseId: "t", name: "read_file", input: { path: "a.ts" } }),
      sse(2, "main", "tool_result", { toolUseId: "t", result: { content: "ok", isError: false } }),
      sse(3, "main", "assistant_thinking", { text: "再写" }),
      sse(4, "main", "assistant_text", { text: "改好了。" }),
    );
    s = { ...s, status: "done" };
    expect(deriveChatItems(s).map((i) => i.kind)).toEqual(["user", "thinking", "text"]);

    s = reduceEvents(s, [
      sse(5, "host", "user_message", { turn: 2, text: "再改一点", continues: "history" }),
    ]);
    expect(s.status).toBe("running");
    const live = deriveChatItems(s, { thinking: "这一轮在想", text: "" });
    expect(live.map((i) => i.kind)).toEqual(["user", "thinking", "text", "user", "live"]);
    expect(live.filter((i) => i.kind === "tool" || i.kind === "tools" || i.kind === "activity")).toHaveLength(0);
    const thinks = live.filter((i) => i.kind === "thinking");
    expect(thinks).toHaveLength(1);
    expect(thinks[0].text).toContain("先读");
    expect(thinks[0].text).toContain("再写");
    expect(live.find((i) => i.kind === "user" && i.text === "再改一点")).toBeTruthy();
  });

  it("追问进行中：更早的轮次也保持收官，不只折上一轮", () => {
    let s = run(
      sse(0, "main", "assistant_thinking", { text: "第一轮想" }),
      sse(1, "main", "tool_call", { toolUseId: "t1", name: "bash", input: { command: "ls" } }),
      sse(2, "main", "tool_result", { toolUseId: "t1", result: { content: "ok", isError: false } }),
      sse(3, "main", "assistant_text", { text: "第一轮做完。" }),
    );
    s = { ...s, status: "done" };
    s = reduceEvents(s, [
      sse(4, "host", "user_message", { turn: 2, text: "第二轮" }),
      sse(5, "main", "assistant_thinking", { text: "第二轮想" }),
      sse(6, "main", "tool_call", { toolUseId: "t2", name: "read_file", input: { path: "a.ts" } }),
      sse(7, "main", "tool_result", { toolUseId: "t2", result: { content: "ok", isError: false } }),
      sse(8, "main", "assistant_text", { text: "第二轮做完。" }),
    ]);
    s = { ...s, status: "done" };
    s = reduceEvents(s, [
      sse(9, "host", "user_message", { turn: 3, text: "第三轮" }),
    ]);
    const items = deriveChatItems(s, { thinking: "第三轮在想", text: "" });
    expect(items.filter((i) => i.kind === "tool" || i.kind === "tools" || i.kind === "activity")).toHaveLength(0);
    const users = items.filter((i) => i.kind === "user").map((i) => i.text);
    expect(users).toEqual(["查一下今天的天气", "第二轮", "第三轮"]);
    const texts = items.filter((i) => i.kind === "text").map((i) => i.text);
    expect(texts).toEqual(["第一轮做完。", "第二轮做完。"]);
    expect(items.filter((i) => i.kind === "thinking")).toHaveLength(2);
    expect(items.at(-1)?.kind).toBe("live");
  });

  it("谱系父 run 的过程在子 run 对话里也保持收官", () => {
    const parent = {
      ...run(
        sse(0, "main", "assistant_thinking", { text: "父轮想" }),
        sse(1, "main", "tool_call", { toolUseId: "tp", name: "bash", input: { command: "pwd" } }),
        sse(2, "main", "tool_result", { toolUseId: "tp", result: { content: "ok", isError: false } }),
        sse(3, "main", "assistant_text", { text: "父轮做完。" }),
      ),
      status: "done",
      runId: "parent-run",
    };
    let child = createInitialState("child-run", "查一下今天的天气", false);
    child = reduceEvents(child, [
      sse(0, "host", "run_forked", { parentRunId: "parent-run", priorRecap: "父轮做完。", priorTurns: 1 }),
      sse(1, "host", "user_message", { turn: 2, text: "接着改" }),
    ]);
    const runList = [
      { runId: "parent-run", continuedFrom: null },
      { runId: "child-run", continuedFrom: "parent-run" },
    ];
    const states = new Map([["parent-run", parent], ["child-run", child]]);
    expect(ancestorRunIds(runList, "child-run")).toEqual(["parent-run", "child-run"]);
    const items = deriveThreadChatItems(runList, states, "child-run", { thinking: "子轮在想", text: "" });
    expect(items.filter((i) => i.kind === "tool" || i.kind === "tools")).toHaveLength(0);
    expect(items.some((i) => i.kind === "text" && i.text === "父轮做完。")).toBe(true);
    expect(items.filter((i) => i.kind === "user").map((i) => i.text)).toEqual([
      "查一下今天的天气",
      "接着改",
    ]);
    expect(items.filter((i) => i.kind === "recap")).toHaveLength(0);
    expect(items.at(-1)?.kind).toBe("live");
  });

  it("追问进行中：上一轮产物卡仍留在历史轮", () => {
    let s = {
      ...run(
        sse(0, "main", "tool_call", { toolUseId: "w", name: "write_file", input: { path: "demo/index.html" } }),
        sse(1, "main", "tool_result", { toolUseId: "w", result: { content: "ok", isError: false } }),
        sse(2, "main", "assistant_text", { text: "网站做好了。" }),
      ),
      status: "done",
    };
    expect(deriveChatItems(s).some((i) => i.kind === "artifacts")).toBe(true);
    s = reduceEvents(s, [sse(3, "host", "user_message", { turn: 2, text: "再加点动画" })]);
    const items = deriveChatItems(s);
    const artAt = items.findIndex((i) => i.kind === "artifacts");
    const user2 = items.findIndex((i) => i.kind === "user" && i.text === "再加点动画");
    expect(artAt).toBeGreaterThan(-1);
    expect(user2).toBeGreaterThan(artAt);
    expect(collapsePriorTurns(items.filter((i) => i.kind !== "live")).some((i) => i.kind === "artifacts")).toBe(true);
  });

  it("进行中有 live 时不重复铺落定思考；没有 live 时落定思考仍要看见", () => {
    const s = run(
      sse(0, "planner", "assistant_thinking", { text: "拆成三步" }),
      sse(1, "main", "assistant_thinking", { text: "先读" }),
      sse(2, "main", "tool_call", { toolUseId: "t", name: "read_file", input: { path: "a.ts" } }),
      sse(3, "main", "assistant_thinking", { text: "再写" }),
    );
    const settled = deriveChatItems(s);
    const thinks = settled.filter((i) => i.kind === "thinking");
    expect(thinks).toHaveLength(1);
    expect(thinks[0].text).toContain("先读");
    expect(thinks[0].text).toContain("再写");
    expect(thinks[0].text).not.toContain("拆成三步");
    expect(thinks[0].live).toBe(true);
    const live = deriveChatItems(s, { thinking: "正在想", text: "" });
    expect(live.filter((i) => i.kind === "thinking")).toHaveLength(0);
    expect(live.filter((i) => i.kind === "live")).toHaveLength(1);
  });

  it("进行中没有 live 时，落定思考仍要看见（编排子任务增量不是 main）", () => {
    const s = run(
      sse(0, "planner", "assistant_thinking", { text: "拆成三步" }),
      sse(1, "s1/main", "assistant_thinking", { text: "先读数据源" }),
      sse(2, "s1/main", "tool_call", { toolUseId: "t", name: "read_file", input: { path: "a.ts" } }),
    );
    const items = deriveChatItems(s);
    const thinks = items.filter((i) => i.kind === "thinking");
    expect(thinks).toHaveLength(1);
    expect(thinks[0].text).toContain("先读数据源");
    expect(thinks[0].live).toBe(true);
    expect(thinks[0].text).not.toContain("拆成三步");
    renderRunDetail(s, { activeTab: "loop" });
    const liveThink = document.querySelector("details.chat-thinking--live");
    expect(liveThink?.textContent).toContain("先读数据源");
    expect(liveThink?.querySelector(".thinking-shimmer")?.textContent).toMatch(/Thinking/);
  });

  it("运行中还没有任何思考时仍露出 Thinking 占位", () => {
    const items = deriveChatItems(run());
    const live = items.filter((i) => i.kind === "live");
    expect(live).toHaveLength(1);
    expect(live[0].waiting).toBe(true);
    expect(renderChatItem(live[0])).toMatch(/Thinking/);
  });

  it("收官后一轮只留一条 Thinking，规划者/核查者不占位", () => {
    const s = {
      ...run(
        sse(0, "planner", "assistant_thinking", { text: "拆成三步" }),
        sse(1, "main", "assistant_thinking", { text: "先读" }),
        sse(2, "main", "tool_call", { toolUseId: "t", name: "read_file", input: { path: "a.ts" } }),
        sse(3, "main", "tool_result", { toolUseId: "t", result: { content: "ok", isError: false } }),
        sse(4, "main", "assistant_thinking", { text: "再写" }),
        sse(5, "main", "assistant_text", { text: "改好了。" }),
        sse(6, "verifier", "assistant_thinking", { text: "核对验收" }),
      ),
      status: "done",
    };
    const items = deriveChatItems(s);
    const thinks = items.filter((i) => i.kind === "thinking");
    expect(thinks).toHaveLength(1);
    expect(thinks[0].text).toContain("先读");
    expect(thinks[0].text).toContain("再写");
    expect(thinks[0].text).not.toContain("拆成三步");
    expect(thinks[0].text).not.toContain("核对验收");
    expect(items.filter((i) => i.kind === "text").map((i) => i.text)).toEqual(["改好了。"]);
  });

  it("默认把连续工具收成一组，摘要是正在做的那一步", () => {
    const s = run(
      sse(0, "main", "tool_call", { toolUseId: "ok", name: "fetch_url", input: { url: "https://a.example" } }),
      sse(1, "main", "tool_result", { toolUseId: "ok", result: { content: "html", isError: false } }),
      sse(2, "main", "tool_call", { toolUseId: "run", name: "bash", input: { command: "sleep 1" } }),
    );
    const groups = deriveChatItems(s).filter((i) => i.kind === "tools");
    expect(groups).toHaveLength(1);
    expect(groups[0].tools.map((t: any) => t.toolUseId)).toEqual(["ok", "run"]);
    expect(groups[0].tools.at(-1)).toMatchObject({ name: "bash", status: "running" });
  });

  it("对话里工具组可展开，没有过程档开关", () => {
    const s = run(
      sse(0, "main", "tool_call", { toolUseId: "ok", name: "fetch_url", input: { url: "https://a.example" } }),
      sse(1, "main", "tool_result", { toolUseId: "ok", result: { content: "html", isError: false } }),
      sse(2, "main", "assistant_text", { text: "结论：可以校准。" }),
    );
    renderRunDetail({ ...s, status: "done" }, { activeTab: "loop" });
    expect(document.querySelector(".chat-process-bar")).toBeNull();
    expect(document.querySelectorAll(".chat-tool-group")).toHaveLength(0);
    const chat = document.querySelector(".conversation")!.textContent ?? "";
    expect(chat).toContain("可以校准");
    // 工具组仍收起：答文气泡不泄 URL。出处表（#26）才把抓页链接摊开。
    const assistant = document.querySelector(".chat-msg--assistant")?.textContent ?? "";
    expect(assistant).toContain("可以校准");
    expect(assistant).not.toContain("https://a.example");
    expect(document.querySelector(".chat-sources")?.textContent).toContain("https://a.example");
  });

  it("直播工具组摘要是关键字高亮，点开只给当前指令", () => {
    const s = run(
      sse(0, "main", "tool_call", {
        toolUseId: "run",
        name: "bash",
        input: { command: 'find . -newermt "2026-09-05 00:00" -type f 2>&1 | grep -v -E \'agent-run-history\'' },
      }),
    );
    renderRunDetail(s, { activeTab: "loop" });
    const group = document.querySelector(".chat-tool-group--live")!;
    expect(group).toBeTruthy();
    const summary = group.querySelector("summary")!.textContent ?? "";
    expect(summary).toContain("find");
    expect(summary).toContain(".");
    expect(summary).toContain("grep");
    expect(summary).not.toContain("2>&1");
    expect(summary).not.toContain("-newermt");
    expect(group.querySelectorAll(".chat-tool")).toHaveLength(0);
    expect(group.querySelector(".chat-tool-now")?.textContent).toContain("find .");
    expect(group.querySelector(".live-dot")).toBeNull();
    expect(group.querySelectorAll(".thinking-shimmer")).toHaveLength(1);
    expect(group.querySelector(".tool-headline")?.classList.contains("thinking-shimmer")).toBe(true);
  });

  it("顶栏是对话标题，异常收尾缩成一行原因", () => {
    let s = createInitialState("run-title", "继续帮我完善目录中的ad7793测量热电偶的电路图绘制", false);
    s = reduceEvents(s, [
      sse(0, "host", "run_end", { stopReason: "error", error: "运行异常终止" }),
    ]);
    s = { ...s, status: "done", stopReason: "error", error: "运行异常终止" };
    const seen: string[] = [];
    renderRunDetail(s, {
      activeTab: "loop",
      showBack: true,
      onBack: () => {},
      onContinue: () => seen.push("go"),
    });
    expect(document.querySelector(".chat-title")!.textContent).toContain("ad7793");
    expect(document.querySelector(".dh-kicker-text")!.textContent).toBe("FATHOM · RUN RUNTIT");
    expect(document.querySelector(".back-btn")!.textContent).not.toContain("返回列表");
    const outcome = document.querySelector(".outcome-card") as HTMLElement;
    expect(outcome.hidden).toBe(false);
    expect(outcome.textContent).toMatch(/异常终止.*运行异常终止/);
    expect(outcome.textContent).not.toContain("宿主级失败");
    expect(outcome.querySelector(".outcome-hint")).toBeNull();
    const cont = outcome.querySelector(".outcome-continue") as HTMLButtonElement;
    expect(cont).toBeTruthy();
    cont.click();
    expect(seen).toEqual(["go"]);
  });

  it("压缩与 Thinking/工具轮流：有工具时不占位，结束后不留条", () => {
    const compact = run(
      sse(0, "main", "compaction", { droppedBlocks: 3, reactive: false }),
    );
    expect(deriveChatItems(compact).filter((i) => i.kind === "notice").map((n) => n.text))
      .toEqual(["上下文已压缩"]);
    const withTool = run(
      sse(0, "main", "compaction", { droppedBlocks: 3, reactive: false }),
      sse(1, "main", "tool_call", { toolUseId: "t", name: "bash", input: { command: "ls" } }),
    );
    expect(deriveChatItems(withTool).filter((i) => i.kind === "notice")).toHaveLength(0);
    expect(deriveChatItems(compact, { thinking: "先核对字段", text: "" }).filter((i) => i.kind === "notice")).toHaveLength(0);
    expect(deriveChatItems({ ...compact, status: "done" }).filter((i) => i.kind === "notice")).toHaveLength(0);
  });

  it("收官后只留每轮最后一段助手正文，中间进度和工具收起", () => {
    const s = {
      ...run(
        sse(0, "main", "assistant_text", { text: "先写一章" }),
        sse(1, "main", "tool_call", { toolUseId: "w", name: "write_file", input: { path: "a.md" } }),
        sse(2, "main", "tool_result", { toolUseId: "w", result: { content: "ok", isError: false } }),
        sse(3, "main", "assistant_text", { text: "七个资产已产出，下面是总结。" }),
      ),
      status: "done",
    };
    const items = deriveChatItems(s);
    expect(items.filter((i) => i.kind === "text").map((i) => i.text)).toEqual(["七个资产已产出，下面是总结。"]);
    expect(items.filter((i) => i.kind === "tools" || i.kind === "tool")).toHaveLength(0);
    expect(items.find((i) => i.kind === "artifacts")?.files?.map((f: any) => f.path)).toEqual(["a.md"]);
  });

  it("收官不被核查者短句盖掉执行者总结，产物卡在总结与裁决之间", () => {
    let s = run(
      sse(0, "main", "assistant_text", { text: "先搭骨架" }),
      sse(1, "main", "tool_call", { toolUseId: "w", name: "write_file", input: { path: "demo_sites/index.html" } }),
      sse(2, "main", "tool_result", { toolUseId: "w", result: { content: "ok", isError: false } }),
      sse(3, "main", "assistant_text", { text: "液态动效站已写好：入口在 demo_sites/index.html。" }),
      sse(4, "verifier", "assistant_text", { text: "[verifier] passed=true 全部 9 条验收项符合。" }),
    );
    s = reduceEvents(s, [
      sse(5, "verifier", "verification", {
        round: 0,
        verdict: { passed: true, issues: [], unverified: [], advisory: [], summary: "通过" },
      }),
    ]);
    s = { ...s, status: "done" };
    const items = deriveChatItems(s);
    expect(items.filter((i) => i.kind === "text").map((i) => i.text)).toEqual([
      "液态动效站已写好：入口在 demo_sites/index.html。",
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "text", "artifacts", "verdict"]);
    expect(items.find((i) => i.kind === "artifacts")?.files?.[0]?.path).toBe("demo_sites/index.html");
  });

  it("有 finish_task 时对话交付优先用其 summary/artifacts，而不是中间进度句", () => {
    let s = run(
      sse(0, "main", "assistant_text", { text: "先写骨架" }),
      sse(1, "main", "tool_call", { toolUseId: "w", name: "write_file", input: { path: "demo_sites/index.html" } }),
      sse(2, "main", "tool_result", { toolUseId: "w", result: { content: "ok", isError: false } }),
      sse(3, "main", "assistant_text", { text: "还在打磨动效…" }),
      sse(4, "main", "done", {
        stopReason: "completed",
        usage: { inputTokens: 1, outputTokens: 1, turns: 1, cacheHitRatio: 0 },
        completion: {
          status: "completed",
          summary: "液态动效站已交付，入口 demo_sites/index.html。",
          artifacts: ["demo_sites/index.html", "demo_sites/style.css"],
          verification: ["本地打开首页无报错"],
          assumptions: [],
          blockers: [],
        },
      }),
    );
    s = { ...s, status: "done" };
    const items = deriveChatItems(s);
    const text = items.find((i) => i.kind === "text");
    expect(text?.fromCompletion).toBe(true);
    expect(text?.text).toContain("液态动效站已交付");
    expect(text?.text).not.toContain("本地打开首页无报错");
    expect(text?.text).not.toContain("**验证**");
    expect(text?.verification).toEqual(["本地打开首页无报错"]);
    expect(text?.text).not.toContain("还在打磨动效");
    const paths = items.find((i) => i.kind === "artifacts")?.files?.map((f: any) => f.path) ?? [];
    expect(paths).toContain("demo_sites/index.html");
    expect(paths).toContain("demo_sites/style.css");
  });

  it("没有产物时仍用执行者长正文做气泡，不把总结塞回 Thinking", () => {
    const essay =
      "扫描已完成。这是一段超过两百字的中文总结，用来说明工作区里有哪些源文件、".repeat(3)
      + "它们各自在做什么。";
    let s = run(
      sse(0, "main", "assistant_thinking", { text: "先列目录再归纳", redacted: false }),
      sse(1, "main", "assistant_text", { text: essay }),
      sse(2, "main", "done", {
        stopReason: "completed",
        usage: { inputTokens: 1, outputTokens: 1, turns: 1, cacheHitRatio: 0 },
        completion: {
          status: "completed",
          summary: "已只读扫描并写出一段总结。",
          artifacts: [],
          verification: ["glob 数过源文件"],
          assumptions: [],
          blockers: [],
        },
      }),
    );
    s = { ...s, status: "done" };
    const items = deriveChatItems(s);
    const textItem = items.find((i) => i.kind === "text");
    const text = textItem?.text ?? "";
    expect(text).toContain("扫描已完成");
    expect(text).not.toContain("**验证**");
    expect(textItem?.verification).toEqual(["glob 数过源文件"]);
    expect(items.some((i) => i.kind === "thinking")).toBe(true);
    expect(items.find((i) => i.kind === "thinking")?.text).toContain("先列目录");
    expect(items.find((i) => i.kind === "thinking")?.text).not.toContain("扫描已完成");
    expect(pickCompletionChatText({
      status: "completed",
      summary: "已只读扫描并写出一段总结。",
      artifacts: [],
      verification: ["glob 数过源文件"],
      assumptions: [],
      blockers: [],
    }, essay)).toContain("扫描已完成");
  });

  it("验证与假设与前提默认收起，点开才看见条目", () => {
    expect(splitFoldableCompletionSections(
      "记分卡已交付。\n\n**验证**\n- npm test 通过\n\n**假设与前提**\n- 沿用暗色风格\n\n**未完成**\n- 动效未接",
    )).toEqual({
      text: "记分卡已交付。\n\n**未完成**\n- 动效未接",
      verification: ["npm test 通过"],
      assumptions: ["沿用暗色风格"],
    });
    expect(completionFoldGroups({
      verification: ["契约字段优先"],
      assumptions: ["环境是 Windows"],
    }, "**验证**\n- 正文里的旧列表")).toMatchObject({
      verification: ["契约字段优先"],
      assumptions: ["环境是 Windows"],
    });

    let s = run(
      sse(0, "main", "done", {
        stopReason: "completed",
        usage: { inputTokens: 1, outputTokens: 1, turns: 1, cacheHitRatio: 0 },
        completion: {
          status: "completed",
          summary: "记分卡已交付。",
          artifacts: [],
          verification: ["okr-data.json 顶层键齐全"],
          assumptions: ["未适用按已作废计"],
          blockers: [],
        },
      }),
    );
    s = { ...s, status: "done" };
    const item = deriveChatItems(s).find((i) => i.kind === "text");
    expect(item?.text).toBe("记分卡已交付。");
    expect(item?.verification).toEqual(["okr-data.json 顶层键齐全"]);
    expect(item?.assumptions).toEqual(["未适用按已作废计"]);
    const html = renderChatItem(item);
    expect(html).toContain("记分卡已交付");
    expect(html).not.toMatch(/<details[^>]*open/);
    const folds = html.match(/<details class="chat-aside chat-completion-fold">/g);
    expect(folds).toHaveLength(2);
    expect(html).toContain("验证 · 1");
    expect(html).toContain("假设与前提 · 1");
    expect(html).toContain("okr-data.json 顶层键齐全");
    expect(html).toContain("未适用按已作废计");
  });

  it("blocked 收官：对话面必须看见具体阻塞条件，20KB HTML 工具回执不进主气泡", () => {
    const html20k = `<!DOCTYPE html>\n<html lang="zh-CN"><head><title>三体</title></head><body>${"x".repeat(20_000)}</body></html>`;
    const reason = "UNIQUE_BLOCK_REASON_PPT_404_REPO_MISSING";
    let s = run(
      sse(0, "main", "assistant_text", { text: "上一轮杂志已经写好，入口 index.html。" }),
      sse(1, "main", "tool_call", {
        toolUseId: "w",
        name: "write_file",
        input: { path: "index.html", content: html20k },
      }),
      sse(2, "main", "tool_result", {
        toolUseId: "w",
        result: { content: html20k, isError: false },
      }),
      sse(3, "main", "done", {
        stopReason: "completed",
        usage: { inputTokens: 1, outputTokens: 1, turns: 1, cacheHitRatio: 0 },
        completion: {
          status: "completed",
          summary: "已用纯 CSS 重做杂志页，入口 index.html。",
          artifacts: ["index.html"],
          verification: [],
          assumptions: [],
          blockers: [],
        },
      }),
      sse(4, "host", "user_message", { text: "帮我安装ppt-master的skill然后再用这个skill再重做一版", turn: 2 }),
      sse(5, "main", "assistant_thinking", {
        text: `install_mcp 失败 HTTP 404，仓库不存在。准备 finish_task(blocked)：${reason}`,
      }),
      sse(6, "main", "tool_call", {
        toolUseId: "inst",
        name: "install_mcp",
        input: { repo: "https://github.com/hugohe3/ppt-master" },
      }),
      sse(7, "main", "tool_result", {
        toolUseId: "inst",
        result: { content: "下载 skill 失败（HTTP 404）", isError: true },
        durationMs: 80,
      }),
      sse(8, "main", "tool_call", {
        toolUseId: "fin",
        name: "finish_task",
        input: {
          status: "blocked",
          summary: "尝试安装 ppt-master skill 失败。",
          artifacts: [],
          verification: ["install_mcp 返回 404"],
          assumptions: [],
          blockers: [reason],
        },
      }),
      sse(9, "main", "done", {
        stopReason: "blocked",
        usage: { inputTokens: 2, outputTokens: 2, turns: 2, cacheHitRatio: 0 },
        completion: {
          status: "blocked",
          summary: "尝试安装 ppt-master skill 失败。",
          artifacts: [],
          verification: ["install_mcp 返回 404"],
          assumptions: [],
          blockers: [reason],
        },
      }),
    );
    const items = deriveChatItems(s);
    const lastUserAt = items.reduce((acc, it, i) => (it.kind === "user" ? i : acc), -1);
    const afterUser = items.slice(lastUserAt);
    expect(afterUser.some((i) => i.kind === "blocked")).toBe(true);
    expect(afterUser.find((i) => i.kind === "blocked")?.conditions).toContain(reason);
    expect(items.filter((i) => i.kind === "text").some((i) => String(i.text).includes("上一轮杂志已经写好"))).toBe(true);
    expect(deriveBlockedFace(s)?.conditions).toContain(reason);

    document.body.innerHTML = items.map((it) => `<div class="chat-item">${renderChatItem(it)}</div>`).join("");
    expect(document.body.textContent).toContain(reason);
    const card = document.querySelector(".chat-blocked");
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain(reason);
    expect(card?.textContent).toContain("阻塞");
    const mainBubbles = [...document.querySelectorAll(".chat-msg--assistant .chat-body")];
    expect(mainBubbles.length).toBeGreaterThan(0);
    for (const b of mainBubbles) {
      expect(b.textContent ?? "").not.toContain("<!DOCTYPE html>");
    }
    expect(card?.textContent ?? "").not.toContain("<!DOCTYPE html>");
  });

  it("blocked 且 done 未带 completion 时，从 finish_task 入参抽出条件", () => {
    const reason = "NEED_ACCESSIBLE_PPT_MASTER_REPO";
    let s = run(
      sse(0, "main", "tool_call", {
        toolUseId: "fin",
        name: "finish_task",
        input: {
          status: "blocked",
          summary: "装不上 skill",
          artifacts: [],
          verification: [],
          assumptions: [],
          blockers: [reason],
        },
      }),
      sse(1, "main", "done", {
        stopReason: "blocked",
        usage: { inputTokens: 1, outputTokens: 1, turns: 1, cacheHitRatio: 0 },
      }),
    );
    const items = deriveChatItems(s);
    expect(items.find((i) => i.kind === "blocked")?.conditions).toContain(reason);
    document.body.innerHTML = items.map((it) => `<div class="chat-item">${renderChatItem(it)}</div>`).join("");
    expect(document.body.textContent).toContain(reason);
    expect(document.querySelector(".chat-blocked")?.textContent).toContain(reason);
  });

  it("applyBlockedCard 幂等，且 partial 不画阻塞卡", () => {
    const face = { kind: "blocked", title: "阻塞", conditions: ["x"], summary: "", seq: null, key: "blocked" };
    const once = applyBlockedCard(
      [{ kind: "text", text: "ok", seq: 1 }, face],
      { stopReason: "blocked", completion: { status: "blocked", summary: "卡死", blockers: ["仓库 404"] } },
    );
    expect(once.filter((i) => i.kind === "blocked")).toHaveLength(1);
    expect(once.find((i) => i.kind === "blocked")?.conditions).toEqual(["仓库 404"]);
    expect(applyBlockedCard([], {
      stopReason: "partial",
      completion: { status: "partial", summary: "半成品", blockers: ["下一回合再做"] },
    }).some((i) => i.kind === "blocked")).toBe(false);
  });

  it("finish_task 为 partial 时正文标明状态并列出 blockers", () => {
    let s = run(
      sse(0, "main", "done", {
        stopReason: "partial",
        usage: { inputTokens: 1, outputTokens: 1, turns: 1, cacheHitRatio: 0 },
        completion: {
          status: "partial",
          summary: "骨架已出，动效未接。",
          artifacts: ["a.html"],
          verification: [],
          assumptions: [],
          blockers: ["缺少真实素材图"],
        },
      }),
    );
    s = { ...s, status: "done" };
    const text = deriveChatItems(s).find((i) => i.kind === "text")?.text ?? "";
    expect(text).toContain("部分完成");
    expect(text).toContain("缺少真实素材图");
    expect(text).toContain("**阻塞**");
    const follow = deriveChatItems(s).find((i) => i.kind === "run-next");
    expect(follow?.live).toBe(false);
    expect(follow?.title).toBe("本轮已结束");
    expect(follow?.text).toMatch(/不会自动继续/);
  });

  it("finish_task 的未完成与阻塞分开展示，收官后标明不会自动续聊", () => {
    expect(classifyCompletionFollowUp("Phase 4 布线尚未开始，拟下一回合执行", "partial")).toBe("unfinished");
    expect(classifyCompletionFollowUp("缺少真实素材图", "partial")).toBe("blocked");
    expect(splitCompletionFollowUps({
      status: "partial",
      blockers: ["Phase 4 尚未开始，拟下一回合执行", "缺少嘉立创账号"],
    })).toEqual({
      unfinished: ["Phase 4 尚未开始，拟下一回合执行"],
      blocked: ["缺少嘉立创账号"],
    });
    const text = formatCompletionChatText({
      status: "partial",
      summary: "对账已做完。",
      verification: ["drc 0"],
      assumptions: [],
      blockers: ["Phase 4 尚未开始，拟下一回合执行", "缺少嘉立创账号"],
    });
    expect(text).toContain("**未完成**");
    expect(text).toContain("Phase 4 尚未开始");
    expect(text).toContain("**阻塞**");
    expect(text).toContain("缺少嘉立创账号");
    expect(text).not.toContain("未完成/阻塞");
    expect(text).not.toContain("**验证**");
    expect(text).not.toContain("drc 0");

    let s = run(
      sse(0, "main", "done", {
        stopReason: "partial",
        usage: { inputTokens: 1, outputTokens: 1, turns: 1, cacheHitRatio: 0 },
        completion: {
          status: "partial",
          summary: "对账已做完。",
          artifacts: [],
          verification: [],
          assumptions: [],
          blockers: ["Phase 4 尚未开始，拟下一回合执行"],
        },
      }),
    );
    s = { ...s, status: "done" };
    const items = deriveChatItems(s);
    expect(items.find((i) => i.kind === "text")?.text).toContain("**未完成**");
    expect(items.find((i) => i.kind === "run-next")?.text).toMatch(/后台没有任务在跑/);
    expect(deriveRunFollowUp(s).autoContinue).toBe(false);
  });

  it("核查还在跑时收官卡标明会自动继续，而不是假装已经停了", () => {
    let s = run(
      sse(0, "main", "done", {
        stopReason: "partial",
        usage: { inputTokens: 1, outputTokens: 1, turns: 1, cacheHitRatio: 0 },
        completion: {
          status: "partial",
          summary: "骨架已出。",
          artifacts: [],
          verification: [],
          assumptions: [],
          blockers: ["动效未接"],
        },
      }),
      sse(1, "verifier", "assistant_text", { text: "开始复核" }),
    );
    s = { ...s, status: "running", verify: true };
    const follow = deriveRunFollowUp(s);
    expect(follow.live).toBe(true);
    expect(follow.autoContinue).toBe(true);
    expect(follow.title).toBe("核查还在跑");
    expect(deriveChatItems(s).find((i) => i.kind === "run-next")?.title).toBe("核查还在跑");
  });

  it("finish_task 后、核查段事件未到：标明核查即将开始，而不是空许诺「自动回到对话」", () => {
    let s = run(
      sse(0, "main", "done", {
        stopReason: "partial",
        usage: { inputTokens: 1, outputTokens: 1, turns: 1, cacheHitRatio: 0 },
        completion: {
          status: "partial",
          summary: "骨架已出。",
          artifacts: [],
          verification: [],
          assumptions: [],
          blockers: ["动效未接"],
        },
      }),
    );
    s = { ...s, status: "running", verify: true };
    const follow = deriveRunFollowUp(s);
    expect(follow.live).toBe(true);
    expect(follow.autoContinue).toBe(true);
    expect(follow.title).toBe("核查即将开始");
    expect(follow.text).toMatch(/核查结束后会自动给出裁决/);
  });

  it("已收官且未开核查时 running 只表示在收尾，不宣称会自动续聊", () => {
    let s = run(
      sse(0, "main", "done", {
        stopReason: "partial",
        usage: { inputTokens: 1, outputTokens: 1, turns: 1, cacheHitRatio: 0 },
        completion: {
          status: "partial",
          summary: "骨架已出。",
          artifacts: [],
          verification: [],
          assumptions: [],
          blockers: ["动效未接"],
        },
      }),
    );
    // 单段快路径通常已是 done；这里钉住「仍 running」时的诚实文案
    s = { ...s, status: "running", verify: false };
    const follow = deriveRunFollowUp(s);
    expect(follow.live).toBe(true);
    expect(follow.autoContinue).toBe(false);
    expect(follow.title).toBe("正在收尾");
  });

  it("活着的 spawn 支线在收官卡上可见且会自动回到对话", () => {
    let s = run(
      sse(0, "main", "spawn_start", { title: "查寄存器" }),
      sse(1, "main", "done", {
        stopReason: "partial",
        usage: { inputTokens: 1, outputTokens: 1, turns: 1, cacheHitRatio: 0 },
        completion: {
          status: "partial",
          summary: "主线先交。",
          artifacts: [],
          verification: [],
          assumptions: [],
          blockers: ["等支线"],
        },
      }),
    );
    s = { ...s, status: "running" };
    const follow = deriveRunFollowUp(s);
    expect(follow.autoContinue).toBe(true);
    expect(follow.title).toBe("支线还在跑：查寄存器");
  });

  it("右栏文件按类型分组，空类不出现；左侧不再挂本会话文件", () => {
    expect(classifySessionFile("assets/a.svg")).toBe("image");
    expect(classifySessionFile("index.html")).toBe("website");
    expect(classifySessionFile("docs/02.md")).toBe("document");
    const s = run(
      sse(0, "main", "tool_call", { toolUseId: "w", name: "write_file", input: { path: "docs/02.md" } }),
      sse(1, "main", "tool_result", { toolUseId: "w", result: { content: "ok", isError: false } }),
      sse(2, "main", "tool_call", { toolUseId: "i", name: "write_file", input: { path: "assets/logo.svg" } }),
      sse(3, "main", "tool_result", { toolUseId: "i", result: { content: "ok", isError: false } }),
    );
    renderRunDetail(s, { activeTab: "loop" });
    const rail = document.getElementById("detail-rail") as HTMLElement;
    expect(rail.hidden).toBe(false);
    const railBody = document.getElementById("rail-body") as HTMLElement;
    const railKids = [...railBody.children].map((n) => n.className);
    expect(railKids[0]).toContain("progress-panel");
    expect(railKids[1]).toContain("artifacts");
    const titles = [...document.querySelectorAll(".rail-section-title")].map((n) => n.textContent ?? "");
    expect(titles.some((t) => t.includes("文档"))).toBe(true);
    expect(titles.some((t) => t.includes("图片"))).toBe(true);
    expect(titles.some((t) => t.includes("网站"))).toBe(false);
    expect(document.querySelector(".artifacts")!.textContent).toContain("02.md");
    expect(document.querySelector(".artifact-thumb")).toBeTruthy();
    expect((document.querySelector(".artifact-thumb") as HTMLImageElement).src).toContain("logo.svg");
    expect(document.getElementById("session-files")).toBeNull();

    renderRunDetail({ ...s, status: "done" }, { activeTab: "loop" });
    expect(rail.hidden).toBe(false);
  });

  it("右栏预览清单不分路径：交付卡可以只留声明，预览仍列出其它目录", () => {
    const s = run(
      sse(0, "main", "tool_call", { toolUseId: "w", name: "write_file", input: { path: "index.html" } }),
      sse(1, "main", "tool_result", { toolUseId: "w", result: { content: "ok", isError: false } }),
      sse(2, "main", "tool_call", { toolUseId: "d", name: "write_file", input: { path: "docs/11.md" } }),
      sse(3, "main", "tool_result", { toolUseId: "d", result: { content: "ok", isError: false } }),
    );
    const files = deriveSessionFiles(s);
    renderRunDetail(s, {
      activeTab: "loop",
      threadFiles: selectConversationArtifacts(files, { declared: ["index.html"], task: s.task }),
      previewFiles: selectPreviewArtifacts(files),
    });
    const railText = document.querySelector(".artifacts")?.textContent ?? "";
    expect(railText).toContain("index.html");
    expect(railText).toContain("11.md");
  });

  it("点文件名或缩略图走右侧画布，不新开标签", () => {
    const s = run(
      sse(0, "main", "tool_call", { toolUseId: "w", name: "write_file", input: { path: "hero.png" } }),
      sse(1, "main", "tool_result", { toolUseId: "w", result: { content: "ok", isError: false } }),
    );
    const onOpenCanvas = vi.fn();
    renderRunDetail(s, {
      activeTab: "loop",
      previewFiles: selectPreviewArtifacts(deriveSessionFiles(s)),
      onOpenCanvas,
    });
    const name = document.querySelector(".artifact-name") as HTMLAnchorElement;
    expect(name.getAttribute("data-canvas-open")).toBe("hero.png");
    expect(name.getAttribute("target")).toBeNull();
    name.click();
    expect(onOpenCanvas).toHaveBeenCalledWith("hero.png");
    const thumb = document.querySelector(".artifact-thumb-link") as HTMLAnchorElement;
    expect(thumb.getAttribute("data-canvas-open")).toBe("hero.png");
    thumb.click();
    expect(onOpenCanvas).toHaveBeenCalledTimes(2);
  });

  it("点击预览不离开页面", () => {
    const hrefBefore = location.href;
    const onOpenCanvas = vi.fn();
    const s = run(
      sse(0, "main", "tool_call", { toolUseId: "w", name: "write_file", input: { path: "deck-q3/index.html" } }),
      sse(1, "main", "tool_result", { toolUseId: "w", result: { content: "ok", isError: false } }),
    );
    renderRunDetail(s, {
      activeTab: "loop",
      previewFiles: selectPreviewArtifacts(deriveSessionFiles(s)),
      onOpenCanvas,
    });
    const preview = [...document.querySelectorAll(".artifact-btn")].find((el) => el.textContent === "预览");
    expect(preview).toBeTruthy();
    expect(preview.tagName).toBe("BUTTON");
    preview.click();
    expect(onOpenCanvas).toHaveBeenCalledWith("deck-q3/index.html");
    expect(location.href).toBe(hrefBefore);
    expect(location.protocol).not.toBe("file:");
    expect(String(location.href)).not.toMatch(/^file:/i);

    const trap = document.createElement("a");
    trap.className = "artifact-btn";
    trap.href = "file:///D:/scratch/deck-q3/index.html";
    trap.textContent = "预览";
    document.querySelector(".artifacts")!.appendChild(trap);
    trap.click();
    expect(location.href).toBe(hrefBefore);
    expect(location.protocol).not.toBe("file:");
    expect(onOpenCanvas).toHaveBeenCalledWith("D:/scratch/deck-q3/index.html");
  });

  it("对话路径链接左键进画布，不新开标签", async () => {
    let state = createInitialState("run-path-canvas", "生成文件", false);
    state = reduceEvents(state, [
      sse(0, "main", "assistant_text", { text: "文件 `out/report.md`。" }),
    ]);
    const onOpenCanvas = vi.fn();
    renderRunDetail(state, {
      activeTab: "loop",
      onOpenCanvas,
      inspectPaths: async (paths: string[]) => paths.map((input) => ({
        input,
        exists: true,
        path: input,
        kind: "file",
      })),
    });
    await vi.waitFor(() => {
      expect(document.querySelector(".local-path-link[data-preview-path]")).toBeTruthy();
    });
    const fileLink = document.querySelector(".local-path-link[data-preview-path]") as HTMLAnchorElement;
    expect(fileLink.getAttribute("target")).toBeNull();
    fileLink.click();
    expect(onOpenCanvas).toHaveBeenCalledWith("out/report.md");
  });

  it("对话里的外链左键进右侧内置浏览器", () => {
    let state = createInitialState("run-web", "查一下", false);
    state = reduceEvents(state, [
      sse(0, "main", "assistant_text", { text: "见 [官网](https://example.com/docs)。" }),
    ]);
    const onOpenBrowser = vi.fn();
    renderRunDetail(state, { activeTab: "loop", onOpenBrowser });
    const link = [...document.querySelectorAll("#conversation a[href]")].find((a) =>
      String((a as HTMLAnchorElement).href).includes("example.com"),
    ) as HTMLAnchorElement;
    expect(link).toBeTruthy();
    link.click();
    expect(onOpenBrowser).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("edit_file 写出的路径也进预览清单", () => {
    const s = run(
      sse(0, "main", "tool_call", { toolUseId: "e", name: "edit_file", input: { path: "src/foo.ts" } }),
      sse(1, "main", "tool_result", { toolUseId: "e", result: { content: "ok", isError: false } }),
    );
    expect(deriveSessionFiles(s).map((f) => f.path)).toContain("src/foo.ts");
  });

  it("做网站时入口页权重大于样式和配图", () => {
    expect(inferArtifactIntent("帮我做一个液态动效网站")).toBe("website");
    const ranked = rankDeliveryArtifacts([
      { path: "demo_sites/style.css", kind: "artifact" },
      { path: "demo_sites/app.js", kind: "artifact" },
      { path: "demo_sites/notes.md", kind: "artifact" },
      { path: "demo_sites/preview.png", kind: "artifact" },
      { path: "demo_sites/index.html", kind: "artifact" },
      { path: "demo_sites/reset.css", kind: "artifact" },
    ], { task: "帮我做一个液态动效网站" });
    expect(ranked[0]?.path).toBe("demo_sites/index.html");
    expect(ranked.at(-1)?.path).toBe("demo_sites/notes.md");
    expect(ranked.slice(0, ARTIFACT_PREVIEW_LIMIT).map((f) => f.path)).toContain("demo_sites/index.html");
    expect(ranked.slice(0, ARTIFACT_PREVIEW_LIMIT).map((f) => f.path)).not.toContain("demo_sites/notes.md");
  });

  it("产物超过 5 个时默认只露权重最高的，其余可展开", () => {
    const files = [
      "demo_sites/index.html",
      "demo_sites/style.css",
      "demo_sites/app.js",
      "demo_sites/about.html",
      "demo_sites/notes.md",
      "demo_sites/reset.css",
      "demo_sites/util.js",
    ].map((path) => ({ path, kind: "artifact" }));
    const html = renderChatItem({
      kind: "artifacts",
      runId: "run-art",
      files: rankDeliveryArtifacts(files, { task: "做个网站" }),
    });
    expect(html).toContain("显示全部（还有 2 个）");
    expect(html).toContain("index.html");
    expect(html).toContain("chat-artifacts-rest");
    expect(html).toContain("chat-artifact-primary");
    expect(html).not.toMatch(/<details class="chat-artifacts"/);
    expect(html).not.toContain("先显示 5 个");
  });

  it("产物卡是一行：路径 + 类型 + 主操作，不是一排文字链", () => {
    expect(artifactKindLabel("demo_sites/index.html")).toBe("网站");
    expect(artifactKindLabel("out/plot.csv")).toBe("表格");
    expect(artifactKindLabel("hero.png")).toBe("图片");
    expect(fileShortPath("C:/work/demo_sites/index.html")).toBe("demo_sites/index.html");
    const html = renderChatItem({
      kind: "artifacts",
      runId: "run-art",
      files: [{ path: "demo_sites/index.html", kind: "artifact" }],
    });
    expect(html).toContain("demo_sites/index.html");
    expect(html).toContain("网站");
    expect(html).toContain("打开");
    expect(html).toContain("chat-artifact-kind");
    expect(html).toContain("在文件夹中显示");
    expect(html).toContain('data-canvas-open="demo_sites/index.html"');
    expect(html).not.toContain('target="_blank"');
    expect(html).not.toContain("chat-artifact-actions");
  });

  it("带图用户气泡：左侧大预览、右侧附件标注+正文，正文不再重复附件行", () => {
    const split = splitUserMessageAttachments(
      "附件：uploads/pasted-1788941218235.png\n我想给我们的仓库的ui设计一个好看的标题",
    );
    expect(split.attachments).toEqual(["uploads/pasted-1788941218235.png"]);
    expect(split.displayBody).toBe("我想给我们的仓库的ui设计一个好看的标题");
    expect(split.body).toContain("附件：uploads/pasted-1788941218235.png");

    const html = renderChatItem({
      kind: "user",
      runId: "run-attach",
      text: "附件：uploads/pasted-1788941218235.png\n我想给我们的仓库的ui设计一个好看的标题",
      seq: 1,
    });
    expect(html).toContain("chat-msg--user-media");
    expect(html).toContain("chat-attach-preview");
    expect(html).toContain("/api/runs/run-attach/artifact?path=");
    expect(html).toContain("chat-attach-caption");
    expect(html).toContain("附件：uploads/pasted-1788941218235.png");
    expect(html).toContain("我想给我们的仓库的ui设计一个好看的标题");
    expect(html).not.toMatch(/chat-body[\s\S]*附件：/);
  });

  it("没有图片的用户气泡保持原来的文字胶囊，不套媒体卡", () => {
    const html = renderChatItem({
      kind: "user",
      runId: "run-plain",
      text: "继续改标题",
      seq: 2,
    });
    expect(html).toContain("chat-msg--user");
    expect(html).not.toContain("chat-msg--user-media");
    expect(html).not.toContain("chat-attach-preview");
    expect(html).toContain("继续改标题");
  });

  it("待复核不占坞，只留在对话末尾的裁决卡", () => {
    let s = run(sse(0, "main", "assistant_text", { text: "做完了" }));
    s = reduceEvents(s, [
      sse(1, "verifier", "verification", {
        round: 0,
        verdict: { passed: true, issues: [], unverified: ["脚本不在仓库内"], advisory: [], summary: "待复核" },
      }),
    ]);
    renderRunDetail(s, { activeTab: "loop" });
    expect((document.querySelector(".unverified-rail") as HTMLElement).hidden).toBe(true);
    const items = deriveChatItems(s);
    const v = items.find((i) => i.kind === "verdict");
    expect(v?.verdict.unverified).toEqual(["脚本不在仓库内"]);
  });

  it("用量脚注和 Loop 抽屉默认不显示", () => {
    const s = run(sse(0, "main", "assistant_text", { text: "做完了" }));
    renderRunDetail(s, { activeTab: "loop" });
    expect((document.querySelector(".usage-footer") as HTMLElement).hidden).toBe(true);
    expect((document.getElementById("detail-drawer") as HTMLElement).hidden).toBe(true);
  });

  it("裁决作为收尾卡进对话，不再是另一个页面", () => {
    let s = run(sse(0, "main", "assistant_text", { text: "做完了" }));
    s = reduceEvents(s, [
      sse(1, "verifier", "verification", {
        round: 0,
        verdict: { passed: false, issues: ["缺收尾"], unverified: [], advisory: [], summary: "未通过" },
      }),
    ]);
    const v = deriveChatItems(s).find((i) => i.kind === "verdict");
    expect(v).toBeTruthy();
    expect(v!.verdict.issues).toEqual(["缺收尾"]);
  });

  it("空文本不产生空气泡", () => {
    const s = run(sse(0, "main", "assistant_text", { text: "   " }));
    expect(deriveChatItems(s).filter((i) => i.kind === "text")).toHaveLength(0);
  });

  it("流式就地更新必须保持 Markdown，不能冲成纯文本", () => {
    const host = document.createElement("div");
    host.innerHTML = renderChatItem({
      kind: "live",
      text: "**粗** 开始",
      thinking: "",
      role: "main",
    });
    expect(host.querySelector("strong")?.textContent).toBe("粗");
    const ok = updateLiveNode(host, {
      kind: "live",
      text: "**粗** 开始，还有 *斜*",
      thinking: "",
      role: "main",
    });
    expect(ok).toBe(true);
    expect(host.querySelector("strong")?.textContent).toBe("粗");
    expect(host.querySelector("em")?.textContent).toBe("斜");
    // 反例：若仍用 setText，strong 会消失、全文进 textContent
    expect(host.querySelector(".chat-live-text")?.childElementCount).toBeGreaterThan(0);
  });
});

describe("toolPeek：摘要要一眼认得出在干什么", () => {
  /**
   * 委托方截图里那行 `→ bash {` 就是反例：入参被美化过（缩进 JSON），
   * 取首行自然只剩一个左花括号，等于什么都没说。
   */
  it("bash 取 command，不是那个左花括号", () => {
    expect(toolPeek("bash", { command: "npx vitest run" })).toBe("npx vitest run");
    expect(toolPeek("bash", { command: "a\nb" })).toBe("a");
  });

  it("读写类取路径、抓取类取 URL", () => {
    expect(toolPeek("read_file", { path: "src/loop.ts" })).toBe("src/loop.ts");
    expect(toolPeek("fetch_url", { url: "https://example.com" })).toBe("https://example.com");
  });

  it("没有已知主参数时给紧凑单行，绝不返回孤零零的括号", () => {
    const peek = toolPeek("weird", { a: 1, b: [2, 3] });
    expect(peek).toContain("a=1");
    expect(peek.trim()).not.toBe("{");
  });

  it("空入参返回空串而不是崩", () => {
    expect(toolPeek("x", null)).toBe("");
    expect(toolPeek("x", undefined)).toBe("");
  });
});

describe("toolHeadline：摘要只留动词和对象", () => {
  it("bash 管道拆成 find / grep 关键字，丢掉 2>&1 和长尾巴", () => {
    const h = toolHeadline("bash", {
      command: 'find . -newermt "2026-09-05 00:00" -type f 2>&1 | grep -v -E \'agent-run-history\'',
    });
    expect(h.stages.map((s) => `${s.verb} ${s.target}`.trim())).toEqual(["find .", "grep agent-run-history"]);
    expect(h.command).toContain("find .");
    expect(h.verb).toBe("find");
  });

  it("read_file 只报文件名", () => {
    const h = toolHeadline("read_file", { path: "src/tools/bash.ts" });
    expect(h.verb).toBe("read");
    expect(h.target).toBe("bash.ts");
  });
});

describe("foldChain：连续主轮折叠成计数", () => {
  /**
   * 多轮对话下会出现二十几个连着的 main 段，逐个画出来就是一排一模一样的
   * 「■ 主轮」——委托方截图里那一行占满整屏却零信息量。
   */
  it("20 个连续主轮折成一个 ×20", () => {
    const folded = foldChain(Array.from({ length: 20 }, () => ({ role: "main", round: 0, passed: null })));
    expect(folded).toHaveLength(1);
    expect(folded[0].count).toBe(20);
  });

  /** 只折 main：返工三次必须还看得出是三次，否则等于把失败史抹平 */
  it("核查与返工不折叠", () => {
    const folded = foldChain([
      { role: "main" }, { role: "main" },
      { role: "verifier", round: 0 }, { role: "rework", round: 1 },
      { role: "verifier", round: 1 }, { role: "rework", round: 2 },
    ]);
    expect(folded.map((c) => `${c.role}${c.count > 1 ? "×" + c.count : ""}`)).toEqual([
      "main×2", "verifier", "rework", "verifier", "rework",
    ]);
  });

  it("空链不炸", () => {
    expect(foldChain([])).toEqual([]);
    expect(foldChain(undefined)).toEqual([]);
  });
});

// ================================================================
// 未读星：跑完了但还没看过
// ================================================================

describe("未读星取代那条「■ 已完成」", () => {
  const runs = [
    { runId: "a", task: "任务甲", status: "done", verify: false, createdAt: 1, finishedAt: 2 },
    { runId: "b", task: "任务乙", status: "done", verify: false, createdAt: 1, finishedAt: 2 },
  ];

  it("未读集合里的运行带 unread 标记", () => {
    const meta = deriveRunListItems(runs, new Map(), new Set(["a"]));
    expect(meta.get("a")!.unread).toBe(true);
    expect(meta.get("b")!.unread).toBe(false);
  });

  it("不传未读集合时一律为 false（旧调用点不受影响）", () => {
    const meta = deriveRunListItems(runs, new Map());
    expect(meta.get("a")!.unread).toBe(false);
  });

  it("选中的那条不亮星——你就在看它", () => {
    renderRunList(runs, "a", () => {}, deriveRunListItems(runs, new Map(), new Set(["a", "b"])));
    const star = (id: string) =>
      (document.querySelector(`[data-run-id="${id}"] .run-item-unread`) as HTMLElement).hidden;
    expect(star("a"), "选中的那条不该还亮着未读星").toBe(true);
    expect(star("b"), "没选中且未读的那条应该亮星").toBe(false);
  });

  it("星带可及名称——读屏用户也得知道这条有新结果", () => {
    renderRunList(runs, null, () => {}, deriveRunListItems(runs, new Map(), new Set(["a"])));
    const star = document.querySelector('[data-run-id="a"] .run-item-unread')!;
    expect(star.getAttribute("aria-label")).toContain("尚未查看");
  });
});

describe("侧栏运行项：CLI 来源徽章", () => {
  it("宿主把 r.host === cli 接到 host-badge（host-lags）", () => {
    const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "ui", "public", "app.js"), "utf8");
    const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "ui", "server.ts"), "utf8");
    expect(app).toMatch(/r\.host === "cli"/);
    expect(app).toMatch(/class="host-badge"/);
    expect(server).toMatch(/parseArchiveHost\(a\.meta\.host\) === "cli"/);
    expect(server).toMatch(/host: r\.host === "cli" \? "cli" : r\.archived \? null : "web"/);
  });

  it("host=cli 才亮 CLI 徽章；缺字段与 web 都不标", () => {
    const runs = [
      { runId: "cli-1", task: "命令行那条", status: "done", verify: false, host: "cli", createdAt: 1, finishedAt: 2 },
      { runId: "web-1", task: "网页那条", status: "done", verify: false, host: "web", createdAt: 1, finishedAt: 2 },
      { runId: "old-1", task: "旧档案", status: "done", verify: false, createdAt: 1, finishedAt: 2 },
    ];
    renderRunList(runs, "cli-1", () => {}, deriveRunListItems(runs, new Map()));
    const badge = (id: string) => document.querySelector(`[data-run-id="${id}"] .host-badge`) as HTMLElement;
    expect(badge("cli-1").hidden).toBe(false);
    expect(badge("cli-1").textContent).toBe("CLI");
    expect(badge("web-1").hidden).toBe(true);
    expect(badge("old-1").hidden).toBe(true);
  });
});

describe("侧栏运行项：运行中不说谎", () => {
  it("运行中没有完成勾、没有绿灯，状态字用滑动高亮", () => {
    const runs = [{ runId: "r1", task: "写网站", status: "running", verify: true, createdAt: 1, finishedAt: null }];
    const states = new Map([
      ["r1", { ...createInitialState("r1", "写网站", true), verdict: { passed: true, issues: [], unverified: [], advisory: [], summary: "过" } }],
    ]);
    renderRunList(runs, "r1", () => {}, deriveRunListItems(runs, states, new Set()), () => {});
    const item = document.querySelector('[data-run-id="r1"]')!;
    expect(item.querySelector(".status-dot")).toBeNull();
    expect(item.querySelector(".run-item-verdict")).toBeNull();
    expect((item.querySelector(".run-item-delete") as HTMLElement).hidden).toBe(true);
    const label = item.querySelector(".run-item-state-label")!;
    expect(label.textContent).toBe("运行中");
    expect(label.classList.contains("thinking-shimmer")).toBe(true);
  });

  it("已完成也不打绿色勾，可以删除", () => {
    const runs = [{ runId: "r1", task: "写网站", status: "done", verify: true, createdAt: 1, finishedAt: 2 }];
    const states = new Map([
      ["r1", { ...createInitialState("r1", "写网站", true), status: "done", verdict: { passed: true, issues: [], unverified: [], advisory: [], summary: "过" } }],
    ]);
    let deleted = "";
    renderRunList(runs, "r1", () => {}, deriveRunListItems(runs, states, new Set()), (id) => { deleted = id; });
    const item = document.querySelector('[data-run-id="r1"]')!;
    expect(item.querySelector(".run-item-verdict")).toBeNull();
    const del = item.querySelector(".run-item-delete") as HTMLButtonElement;
    expect(del.hidden).toBe(false);
    del.click();
    expect(deleted).toBe("r1");
  });
});

// ================================================================
// 装配状态条：条上是真实装配，点开才是设计思想
// ================================================================

describe("装配状态条", () => {
  function configured() {
    let s = createInitialState("run-asm", "任务", true);
    return reduceEvents(s, [
      sse(0, "host", "run_config", {
        pack: { name: "ts-coding" },
        workdir: "D:/Work/Github_pros/Agent_Design",
        guardrails: { maxTurns: 40, maxTokens: 64000 },
        verifierBudgetTurns: 15,
      }),
    ]);
  }

  /**
   * 这条是整个设计的关键：**状态条上的每个数字都来自 run_config**，
   * 不是写死的文案。装配变了条上就变，说明文字因此不会和现实脱节——
   * 而一条写死的标语会。
   */
  it("chip 全部来自本次运行的真实装配", () => {
    const items = deriveAssemblyBar(configured(), { model: "claude-opus-5" });
    const by = Object.fromEntries(items.map((i) => [i.key, i.chip]));
    expect(by.model).toBe("claude-opus-5");
    expect(by.design).toBeUndefined();
    expect(by.pack).toBe("ts-coding");
    expect(by.guardrails).toBe("40 轮 / 64k");
    expect(by.verify).toContain("15 轮");
  });

  it("精确放行说明展示 hash，并明确参数变化会重新询问", () => {
    let state = configured();
    state = reduceEvents(state, [
      sse(2, "host", "approval_resolved", {
        name: "bash",
        toolUseId: "t1",
        requestSeq: 1,
        decision: "allow",
        actor: "user",
        scope: "run",
        inputScope: "exact-input",
        inputHash: "sha256:0123456789abcdef",
        grantId: "g1",
        boundRunId: state.runId,
        expiresAt: Date.now() + 60_000,
        maxUses: 5,
        usedUses: 0,
        at: 1,
      }),
    ]);
    const item = deriveAssemblyBar(state, null).find((candidate) => candidate.key === "autoAllow")!;
    expect(item.chip).toContain("bash#01234567");
    expect(item.chip).toContain("余5");
    expect(item.why).toContain("完全相同的参数");
    expect(item.why).toContain("command、path、device");
    expect(item.why).not.toContain("只对这几个工具名");
  });

  it("归档运行即使 grant 尚未到期也只显示审计，不显示 active", () => {
    let state = createInitialState("archived", "历史", false, { archived: true });
    state = reduceEvents(state, [
      sse(2, "host", "approval_resolved", {
        name: "fetch_url",
        toolUseId: "t1",
        requestSeq: 1,
        decision: "allow",
        actor: "user",
        scope: "run",
        inputScope: "exact-input",
        inputHash: "sha256:abcdef",
        grantId: "g-archived",
        boundRunId: "archived",
        expiresAt: Date.now() + 60_000,
        maxUses: 5,
        usedUses: 0,
        at: 1,
      }),
    ]);
    const item = deriveAssemblyBar(state, null).find((candidate) => candidate.key === "autoAllow")!;
    expect(item.chip).toContain("授权审计");
    expect(item.chip).not.toContain("精确放行");
    expect(item.why).toContain("绝不恢复执行权");
  });

  it("装配变了条上就变——核查关掉时说的是「核查关」", () => {
    let s = createInitialState("r2", "t", false);
    const items = deriveAssemblyBar(s, null);
    expect(items.find((i) => i.key === "verify")!.chip).toBe("核查关");
  });

  it("没有领域包时如实说「无领域包」，不留空", () => {
    const items = deriveAssemblyBar(createInitialState("r3", "t", false), null);
    expect(items.find((i) => i.key === "pack")!.chip).toBe("无领域包");
  });

  it("自动路由的包在装配条上标「自动」，reason 进 why（白名单投影）", () => {
    const s = reduceEvents(createInitialState("r-auto", "t", false), [
      sse(0, "host", "run_config", {
        pack: { name: "ts-coding" },
        packRoute: { pack: "ts-coding", reason: "TypeScript 任务" },
      }),
    ]);
    const chip = deriveAssemblyBar(s, null).find((i) => i.key === "pack");
    expect(chip?.chip).toBe("ts-coding · 自动");
    expect(chip?.why).toContain("TypeScript 任务");
  });

  it("run_config 投影 mode=design 与 designRoute，装配条写设计模式", () => {
    const s = reduceEvents(createInitialState("r-design", "做个落地页", false), [
      sse(0, "host", "run_config", {
        pack: { name: "design" },
        mode: "design",
        designRoute: {
          id: "saas-landing",
          reason: "显式选用：SaaS 落地页",
          seed: "landing-basic",
          kind: "r1",
        },
      }),
    ]);
    expect(s.runConfig.mode).toBe("design");
    expect(s.runConfig.designRoute).toEqual({
      id: "saas-landing",
      reason: "显式选用：SaaS 落地页",
      seed: "landing-basic",
      kind: "r1",
      bundle: null,
      extraSeeds: [],
    });
    const chip = deriveAssemblyBar(s, null).find((i) => i.key === "design");
    expect(chip?.chip).toContain("设计模式");
    expect(chip?.chip).toContain("saas-landing");
    expect(chip?.chip).toContain("landing-basic");
    expect(chip?.why).toContain("显式选用：SaaS 落地页");
    expect(`${chip?.chip} ${chip?.why}`).not.toMatch(/Claude Design|Kimi|OpenDesign/i);
  });

  it("run_config 投影 spec-plus-deck 的 bundle/extraSeeds，装配条写规格+幻灯", () => {
    const s = reduceEvents(createInitialState("r-bundle", "写规格再做幻灯", false), [
      sse(0, "host", "run_config", {
        pack: { name: "design" },
        mode: "design",
        designRoute: {
          id: "pm-spec",
          reason: "命名路径：产品规格 + 汇报幻灯（不是通用多命中检测）",
          seed: "pm-spec",
          kind: "r1",
          bundle: "spec-plus-deck",
          extraSeeds: ["deck-basic"],
        },
      }),
    ]);
    expect(s.runConfig.designRoute).toEqual({
      id: "pm-spec",
      reason: "命名路径：产品规格 + 汇报幻灯（不是通用多命中检测）",
      seed: "pm-spec",
      kind: "r1",
      bundle: "spec-plus-deck",
      extraSeeds: ["deck-basic"],
    });
    const chip = deriveAssemblyBar(s, null).find((i) => i.key === "design");
    expect(chip?.chip).toContain("规格+幻灯");
    expect(chip?.chip).toContain("pm-spec");
    expect(chip?.chip).toContain("deck-basic");
    expect(chip?.why).toContain("不是通用多命中");
  });

  it("run_config 投影 cited，对话里画出引用了谁/哪些文件", () => {
    const s = reduceEvents(createInitialState("r-cite", "接着那份规格", false), [
      sse(0, "host", "run_config", {
        cited: [
          { runId: "run-spec", title: "规格草案", artifacts: ["pm-spec/index.html", "DESIGN.md"] },
        ],
      }),
    ]);
    expect(s.runConfig.cited).toEqual([
      { runId: "run-spec", title: "规格草案", artifacts: ["pm-spec/index.html", "DESIGN.md"] },
    ]);
    const cited = deriveCitedChat(s.runConfig.cited);
    expect(cited?.refs[0].runId).toBe("run-spec");
    const items = deriveChatItems(s, null);
    expect(items.some((it) => it.kind === "cite")).toBe(true);
    const html = items.filter((it) => it.kind === "cite").map((it) => renderChatItem(it)).join("");
    expect(html).toContain("引用的会话");
    expect(html).toContain("规格草案");
    expect(html).toContain("pm-spec/index.html");
    expect(html).toContain("DESIGN.md");
    expect(html).not.toContain("transcript");
    expect(html).not.toContain("events");
  });

  it("问资料时对话里画出来源表，并可导出链接列表", () => {
    const s = reduceEvents(createInitialState("r-src", "沸点", false), [
      sse(0, "main", "assistant_text", {
        text: "水在 100°C 沸腾。[Wikipedia](https://en.wikipedia.org/wiki/Boiling_point)",
      }),
    ]);
    const items = deriveChatItems(s, null);
    expect(items.some((it) => it.kind === "sources")).toBe(true);
    const html = items.filter((it) => it.kind === "sources").map((it) => renderChatItem(it)).join("");
    expect(html).toContain("来源");
    expect(html).toContain("该页说的");
    expect(html).toContain("导出链接列表");
    expect(html).toContain("wikipedia.org");
  });

  it("门禁 chip：无看板隐藏，有下一门才占位", () => {
    const chip = document.getElementById("gate-chip");
    expect(chip).toBeTruthy();
    expect(formatGateChip(null).hidden).toBe(true);
    paintGateChip(chip, null);
    expect(chip.hidden).toBe(true);
    expect(chip.textContent).toBe("");
    paintGateChip(chip, { nextGate: "评审会", waiting: ["委托方"] });
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toBe("下一门：评审会 · 1 人在等");
  });

  it("长工作目录只留尾部两级——状态条是一行", () => {
    const items = deriveAssemblyBar(configured(), null);
    const wd = items.find((i) => i.key === "workdir")!.chip;
    expect(wd.length).toBeLessThan(40);
    expect(wd).toContain("Agent_Design");
  });

  it("非编排运行没有编排项", () => {
    expect(deriveAssemblyBar(configured(), null).some((i) => i.key === "plan")).toBe(false);
  });

  it("D3：自定义组合报「档 自定义」，开关仍展开", () => {
    const s = createInitialState("rpc", "t", false);
    s.runConfig = {
      permission: {
        mode: null,
        approvalDefault: "auto",
        planMode: true,
        planGate: false,
        autoYes: true,
      },
    };
    const chip = deriveAssemblyBar(s, null).find((i) => i.key === "permission");
    expect(chip?.chip).toMatch(/自定义/);
    expect(chip?.chip).toMatch(/ask 级会自动放行/);
    expect(chip?.why).toContain("计划编排开");
    expect(chip?.why).toContain("autoYes 开");
  });

  it("D3：装配条展开 permission 真实开关，不只报模式名", () => {
    const s = createInitialState("rp", "t", false);
    s.runConfig = {
      permission: {
        mode: "plan",
        approvalDefault: "ask",
        planMode: true,
        planGate: true,
        autoYes: false,
      },
    };
    const chip = deriveAssemblyBar(s, null).find((i) => i.key === "permission");
    expect(chip?.chip).toMatch(/计划/);
    expect(chip?.chip).toMatch(/不会自动放行/);
    expect(chip?.why).toContain("确认门开");
    expect(chip?.why).toContain("autoYes 关");
    expect(chip?.why).toMatch(/docs\/permission-modes/);
  });

  /**
   * B0：planner 预算不再是写死的 12，plan 芯片必须报数字与来源。
   * 这条同时锁 run_config 的白名单投影——plannerBudget* 两个字段若在
   * reduceEvent 里被丢（新字段默认被丢，本轮已是第四次踩到这类坑），
   * 芯片上就不会出现预算，本测试变红。
   */
  it("plan 芯片带 planner 预算，数字与来源都来自 run_config（B0）", () => {
    let s = createInitialState("run-asm-plan", "任务", true);
    s = reduceEvents(s, [
      sse(0, "host", "run_config", {
        pack: { name: "ts-coding" },
        workdir: "D:/w",
        guardrails: { maxTurns: 40 },
        verifierBudgetTurns: 15,
        plannerBudgetTurns: 30,
        plannerBudgetSource: "pack",
      }),
      sse(1, "host", "plan", {
        concurrency: 1,
        subtasks: [{ id: "s1", title: "t", dependsOn: [], acceptance: [], description: "", pack: null }],
      }),
    ]);
    const chip = deriveAssemblyBar(s, null).find((i) => i.key === "plan")!;
    expect(chip.chip).toContain("planner 30 轮");
    expect(chip.why).toContain("领域包声明");
  });

  /**
   * **每一句 why 都必须落在具体后果上**，不能是标语。
   * 判据：说清"不这样会发生什么"。写不出后果的项就不该占状态条的位置——
   * 本项目一贯反对标语（findings 全篇都是"判据 + 出处"的写法）。
   */
  it("每一项都有说明，且不是空泛口号", () => {
    const items = deriveAssemblyBar(configured(), { model: "m" });
    expect(items.length).toBeGreaterThanOrEqual(5);
    for (const i of items) {
      expect(i.why.length, `${i.key} 的说明太短`).toBeGreaterThan(40);
      // 标语词一律不许出现
      for (const banned of ["我们相信", "更可靠", "更智能", "赋能", "领先"]) {
        expect(i.why, `${i.key} 的说明里出现了口号「${banned}」`).not.toContain(banned);
      }
    }
  });

  it("详情页不再放装配条——和任务标题一样是重复信息", () => {
    renderRunDetail(configured(), { activeTab: "loop", harness: { model: "m" } });
    expect(document.querySelector(".detail-header")).toBeNull();
    expect(document.querySelector(".assembly-bar")).toBeNull();
    expect(document.querySelector(".assembly-why")).toBeNull();
  });

  it("装配条已从详情页撤下", () => {
    renderRunDetail(configured(), { activeTab: "loop", harness: { model: "m" } });
    expect(document.querySelectorAll(".assembly-chip")).toHaveLength(0);
  });
});

describe("装配条不许说谎（文案交叉核对抓到的三处）", () => {
  const cfg = (over: any = {}) => {
    let s = createInitialState("r", "t", true);
    return reduceEvents(s, [sse(0, "host", "run_config", over)]);
  };

  /**
   * `?? 0` 会把**没设过**的 maxTokens 渲成「0k」——一个没设过的护栏被画成
   * 最严格的护栏。这条状态条的全部价值就在于它不说谎，所以这是必须锁的。
   */
  it("maxTokens 未设时不渲染，不许出现「0k」", () => {
    const chip = deriveAssemblyBar(cfg({ guardrails: { maxTurns: 40 } }), null)
      .find((i) => i.key === "guardrails")!.chip;
    expect(chip).toBe("40 轮");
    expect(chip).not.toContain("0k");
  });

  it("maxTokens 设了才带上", () => {
    const chip = deriveAssemblyBar(cfg({ guardrails: { maxTurns: 40, maxTokens: 64000 } }), null)
      .find((i) => i.key === "guardrails")!.chip;
    expect(chip).toBe("40 轮 / 64k");
  });

  /**
   * `classifyStopReason` 的具名值全集以 src/types.ts 的 STOP_REASONS 为准
   * （B1 一致锁钉着，数目还会长——这条注释因此也不写数字；初稿写"八个"，
   * aborted 一上线就过期了，正是"写死的计数会过期"的活标本）。
   * 文案里写死"六值"同理是过期口径，所以文案不写具体数目。
   */
  it("护栏说明不写死终止值的个数（口径会漂）", () => {
    const why = deriveAssemblyBar(cfg({ guardrails: { maxTurns: 40 } }), null)
      .find((i) => i.key === "guardrails")!.why;
    expect(why).not.toMatch(/[六五四三七八九]值/);
  });

  /**
   * 案例 #8 全程单模型（deepseek-v4-pro，执行/核查/planner 同款），
   * 四跑 A/B/C/D 的变量是预算 / 只读纪律 / 收口续跑——**模型是控制量**。
   * 拿它当"换模型可对照"的证据是把出处引反了。
   */
  it("模型说明不得拿案例 #8 当「换模型可对照」的证据", () => {
    const why = deriveAssemblyBar(cfg({}), { model: "m" }).find((i) => i.key === "model")!.why;
    expect(why).not.toContain("案例 #8");
    expect(why).not.toContain("A/B/C/D");
  });

  /** 空白名单是案例 #4 的事故形态，必须显式显示 0 而不是省略 */
  it("核查白名单为空时显示「白名单 0」，不适用「空就不显示」", () => {
    const chip = deriveAssemblyBar(cfg({ guardrails: { maxTurns: 40 } }), null)
      .find((i) => i.key === "verify")!.chip;
    expect(chip).toContain("白名单 0");
  });

  it("白名单有值时报真实条数", () => {
    const s = cfg({ pack: { name: "ts-coding", verify: { readOnlyCommands: ["a", "b", "c"] } } });
    expect(deriveAssemblyBar(s, null).find((i) => i.key === "verify")!.chip).toContain("白名单 3");
  });
});

// ================================================================
// 跳转箭头与贴底跟随
// ================================================================

describe("deriveScrollNav：两个箭头各管各的", () => {
  const at = (over: any = {}) =>
    deriveScrollNav({
      scrollTop: 0, scrollHeight: 2000, clientHeight: 600, anchorTop: null, drawerOpen: false,
      ...over,
    });

  it("离底还远 → 出现「回到最新」", () => {
    expect(at({ scrollTop: 0 }).showBottom).toBe(true);
  });

  it("已经贴底 → 不出现（它此刻什么也做不了）", () => {
    expect(at({ scrollTop: 1400 }).showBottom).toBe(false);
  });

  it("内容根本不够滚时两个都不出现——那是纯噪声", () => {
    const n = at({ scrollHeight: 620, clientHeight: 600, scrollTop: 0 });
    expect(n.showBottom).toBe(false);
    expect(n.showTop).toBe(false);
  });

  /**
   * ↑ 的判据不是"往上翻过"，而是**抽屉开着且四张卡已经滚出视野**。
   * 抽屉没开时上面就是对话，往上翻是在读历史——那时候弹一个"回到顶部"
   * 是在催人离开他正在读的地方。
   */
  it("抽屉没开时不出现「回到四决定因素」，哪怕已经滚很远", () => {
    expect(at({ scrollTop: 1200, anchorTop: -800, drawerOpen: false }).showTop).toBe(false);
  });

  it("抽屉开着且四张卡滚出上边界 → 出现", () => {
    expect(at({ scrollTop: 1200, anchorTop: -800, drawerOpen: true }).showTop).toBe(true);
  });

  it("抽屉开着但四张卡还在视野内 → 不出现", () => {
    expect(at({ scrollTop: 100, anchorTop: 120, drawerOpen: true }).showTop).toBe(false);
  });

  it("量不到四张卡时不猜——宁可不显示也不乱跳", () => {
    expect(at({ anchorTop: null, drawerOpen: true }).showTop).toBe(false);
  });
});

describe("对话贴底跟随", () => {
  /**
   * 本仓早就有 `keepScrollAnchored`（贴底时跟随、否则不动用户的位置），
   * 但**只有日志面在用、对话没接**——而流式全在对话里，
   * 于是"正在写"的那一段每次都长在视野之外。这条锁住它确实接上了。
   */
  it("patchConversation 走 keepScrollAnchored", () => {
    const src = readFileSync(join(__dirname, "..", "ui", "public", "app.js"), "utf-8");
    const fn = src.slice(src.indexOf("function patchConversation"), src.indexOf("function chatItemSig"));
    expect(fn, "对话没有接贴底跟随").toContain("keepScrollAnchored(");
  });

  it("贴底时跟随到新的底部；离底时一动不动", () => {
    // 直接测那个 helper 的两种分支——jsdom 量不到真实布局，所以造一个假滚动容器
    const make = (scrollTop: number) => ({
      scrollTop, scrollHeight: 1000, clientHeight: 400,
    });
    const pinned = make(590); // 距底 10px，算贴底
    expect(keepScrollAnchored(pinned as any, () => { pinned.scrollHeight = 1200; })).toBe(true);
    expect(pinned.scrollTop, "贴底时应跟到新底部").toBe(1200);

    const away = make(100); // 距底 500px，人在往上翻
    expect(keepScrollAnchored(away as any, () => { away.scrollHeight = 1200; })).toBe(false);
    expect(away.scrollTop, "人往上翻了就不该动他").toBe(100);
  });
});

describe("角色人名（backlog D4：显示层别名，与角色语义并列）", () => {
  function crewState() {
    const s = createInitialState("run-crew", "任务", true);
    return reduceEvents(s, [
      sse(0, "planner", "assistant_text", { text: "我先拆解任务" }),
      sse(1, "s1/main", "assistant_text", { text: "开始施工" }),
      sse(2, "s1/verifier", "assistant_text", { text: "开始核查" }),
    ]);
  }

  it("主对话是普通气泡，不堆角色署名也不分段", () => {
    localStorage.removeItem("agent-ui-chat-show-process");
    renderRunDetail(crewState(), { activeTab: "loop" });
    expect(document.querySelectorAll(".conversation .segment-boundary")).toHaveLength(0);
    expect(document.querySelectorAll(".chat-msg--assistant .chat-role")).toHaveLength(0);
    expect(document.querySelector(".conversation .chat-msg--assistant")?.textContent).toContain("我先拆解任务");
    expect([...document.querySelectorAll(".conversation .chat-msg--assistant")].some((n) => n.textContent.includes("开始施工"))).toBe(false);
    expect(document.querySelector(".chat-agents")).toBeTruthy();
    expect(document.body.textContent).toContain("子代理");
  });

  it("人名只映射显示层——派生层的 source 仍是结构名", () => {
    renderRunDetail(crewState(), { activeTab: "loop" });
    expect([...document.querySelectorAll(".conversation .chat-msg--assistant")].some((n) => n.textContent.includes("开始核查"))).toBe(false);
    expect(document.querySelector(".chat-msg--assistant .chat-role")).toBeNull();
  });

  it("人名只在显示层——事件流与派生层的 source 仍是结构名（改名不漂移记录）", () => {
    const s = crewState();
    expect(s.timeline.every((e: any) => !/计明远|施敢当|严不苟/.test(String(e.source)))).toBe(true);
    const boundary = deriveChatItems(s, null, { showProcess: true }).find((it: any) => it.kind === "boundary");
    expect(boundary!.source).toBe("planner");
  });

  it("直播条目是普通气泡，不另署角色名", () => {
    let s = createInitialState("run-crew2", "任务", false);
    s = reduceEvents(s, [sse(0, "main", "turn_start", { turn: 1 })]);
    renderRunDetail(s, { activeTab: "loop", liveText: "正在写……" });
    expect(document.querySelector(".chat-msg--live")!.textContent).toContain("正在写");
    expect(document.querySelector(".chat-msg--live .chat-role")).toBeNull();
  });
});

describe("paceReveal：把上游的一阵一阵摊成匀速", () => {
  /**
   * 委托方："有时候会卡住然后突然冒一长串。"
   * 量下来**不是渲染慢**（长任务观测器录到 0 条），是上游本来就一阵一阵来：
   * 一次 230 条增量里多数在同一毫秒到达，相邻两批最长静默 943ms。
   * 所以修在"别把到达节奏当成显示节奏"。
   */
  it("一次突进不会一帧全糊上去", () => {
    const next = paceReveal({ arrived: 300, revealed: 0, dtMs: 16 });
    expect(next).toBeGreaterThan(0);
    expect(next, "300 字一帧全放了，等于没做节流").toBeLessThan(300);
  });

  it("积压越多放得越快——否则长文会越拖越远", () => {
    const small = paceReveal({ arrived: 50, revealed: 0, dtMs: 16 });
    const big = paceReveal({ arrived: 5000, revealed: 0, dtMs: 16 });
    expect(big).toBeGreaterThan(small);
  });

  /**
   * 速度取自积压量 = 指数衰减，尾巴会拖。初版没有收尾闸，300 字突进 350ms
   * 只走到 200 字，剩下那截慢慢爬——**正是这条测试把它抓出来的**。
   * 现在加了剩不多了一次放完，实测：60 字 176ms / 300 字 352ms /
   * 1200 字 512ms / 5000 字 672ms —— 越长的突进追得越快，但都在人可接受的范围内。
   */
  it("典型突进在 400ms 内追平，超长突进也不超过 1 秒", () => {
    const catchUp = (burst: number) => {
      let revealed = 0;
      let t = 0;
      while (revealed < burst && t < 5000) {
        revealed = paceReveal({ arrived: burst, revealed, dtMs: 16 });
        t += 16;
      }
      return t;
    };
    expect(catchUp(300)).toBeLessThanOrEqual(400);
    expect(catchUp(5000)).toBeLessThanOrEqual(1000);
  });

  it("一轮结束时立刻全放——收尾必须是准的", () => {
    expect(paceReveal({ arrived: 5000, revealed: 3, dtMs: 16, done: true })).toBe(5000);
  });

  it("没有积压就不动", () => {
    expect(paceReveal({ arrived: 120, revealed: 120, dtMs: 16 })).toBe(120);
  });

  it("上游文本变短（换了一轮）时显示位置跟着回落，不会停在越界处", () => {
    expect(paceReveal({ arrived: 10, revealed: 999, dtMs: 16 })).toBeLessThanOrEqual(10);
  });

  it("dt 为 0 也至少推进一个字——绝不卡死", () => {
    expect(paceReveal({ arrived: 100, revealed: 0, dtMs: 0 })).toBeGreaterThan(0);
  });
});

describe("停止按钮：运行中那个位置变成「停止」", () => {
  const running = () =>
    deriveComposerMode({
      info: { runId: "r1", status: "running", canContinue: false },
      localStatus: "running",
    });

  it("运行中空框按钮是「停止」且可点——不是一个灰着的「运行任务」", () => {
    const m = running();
    expect(m.buttonLabel).toBe("停止");
    expect(m.canSubmit).toBe(true);
    expect(m.kind).toBe("stop");
  });

  it("运行中有草稿则立即插入，空框才是停止", () => {
    expect(composerSubmitPlan(running(), "")).toEqual({ kind: "stop", runId: "r1", text: "" });
    expect(composerSubmitPlan(running(), "   ")).toEqual({ kind: "stop", runId: "r1", text: "" });
    const withDraft = deriveComposerMode({
      info: { runId: "r1", status: "running", canContinue: false },
      localStatus: "running",
      draft: "改一下",
    });
    expect(withDraft.kind).toBe("steer");
    expect(withDraft.buttonLabel).toBe("立即插入");
    expect(composerSubmitPlan(withDraft, "改一下")).toEqual({
      kind: "steer", runId: "r1", text: "改一下",
    });
  });

  it("运行中不再用一段说明占底栏", () => {
    expect(running().note).toBe("");
  });

  it("非运行态不会误发停止", () => {
    const done = deriveComposerMode({ info: { runId: "r1", status: "done", canContinue: true } });
    expect(done.kind).toBe("append");
    expect(composerSubmitPlan(done, "继续")!.kind).toBe("append");
  });

  it("按过停止立刻改成正在停止，不能再点一次像没点", () => {
    const m = deriveComposerMode({
      info: { runId: "r1", status: "running", canContinue: false },
      localStatus: "running",
      stopping: true,
    });
    expect(m.buttonLabel).toBe("正在停止…");
    expect(m.canSubmit).toBe(false);
    expect(m.note).toMatch(/已发出停止/);
    expect(composerSubmitPlan(m, "")).toBeNull();
    patchComposer(m);
    expect(document.querySelector("#submit-btn-label")!.textContent).toBe("正在停止…");
    expect((document.querySelector("#submit-btn") as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector("#composer-note")!.hidden).toBe(false);
  });
});

describe("B2 · 归档运行在底栏的说法", () => {
  /**
   * 归档 run（宿主重启前的历史）同样 canContinue=false，但原因完全不同：
   * 落到兜底那句"可能执行阶段就失败了"是对着一次好端端的运行说谎（判据④）。
   */
  it("归档的'不能续跑'要说真话，而不是'执行阶段就失败了'", () => {
    const m = deriveComposerMode({
      info: { runId: "r1", status: "done", canContinue: false, archived: true },
    });
    expect(m.mode).toBe("blocked");
    expect(m.kind).toBe("append");
    expect(m.buttonLabel).toBe("继续对话");
    expect(m.note).toBe("");
  });

  it("RUN-01 Phase 2：same-run 续跑在底栏也是继续对话", () => {
    const m = deriveComposerMode({
      info: {
        runId: "r1",
        status: "done",
        canContinue: true,
        archived: true,
        continuationMode: "same-run",
        sameRunResume: true,
        durablePhase: "interrupted",
      },
    });
    expect(m.mode).toBe("same-run");
    expect(m.kind).toBe("append");
    expect(m.buttonLabel).toBe("继续对话");
    expect(m.note).toBe("");
  });

  it("restore-gate / reopen 底栏照实说，不假装有检查点", () => {
    const gated = deriveComposerMode({
      info: {
        runId: "r-gate",
        status: "done",
        canContinue: true,
        archived: true,
        continuationMode: "restore-gate",
      },
    });
    expect(gated.mode).toBe("restore-gate");
    expect(gated.note).toMatch(/确认门/);
    const reopened = deriveComposerMode({
      info: {
        runId: "r-reopen",
        status: "done",
        canContinue: true,
        archived: true,
        continuationMode: "reopen",
      },
    });
    expect(reopened.mode).toBe("reopen");
    expect(reopened.note).toMatch(/不重放飞行中的工具/);
  });
});

describe("装配条的识图那一格", () => {
  const bare = () => createInitialState("rv", "t", false);

  /**
   * 委托方遇到的正是这条：传图进去，模型诚实地说"我看不到"，
   * 但界面上完全看不出**是这套装配里没有这个工具**，只能从模型的道歉里推。
   */
  it("未配时明说「未配」，并解释为什么工具面上干脆没有它", () => {
    const item = deriveAssemblyBar(bare(), { roleModels: { vision: { configured: false } } })
      .find((i) => i.key === "vision")!;
    expect(item.chip).toBe("识图 未配");
    expect(item.why).toContain("根本不进工具面");
  });

  /**
   * `/api/harness` 未配时给的是 `{configured:false}`——**一个真值对象**。
   * 直接 `vision ? …` 会让这一格恰好在它唯一有用的场景下说反话。
   */
  it("未配的那个对象是真值——判据必须认 configured 而不是对象本身", () => {
    const snapshot = { roleModels: { vision: { configured: false } } };
    expect(Boolean(snapshot.roleModels.vision), "前提：它确实是真值").toBe(true);
    expect(
      deriveAssemblyBar(bare(), snapshot).find((i) => i.key === "vision")!.chip,
    ).toBe("识图 未配");
  });

  it("两种数据源形状都认：逐 run 是字符串，进程级是对象", () => {
    const perRun = reduceEvents(bare(), [
      sse(0, "host", "run_config", { roleModels: { vision: "qwen-vl" } }),
    ]);
    expect(deriveAssemblyBar(perRun, null).find((i) => i.key === "vision")!.chip).toContain("qwen-vl");
    expect(
      deriveAssemblyBar(bare(), { roleModels: { vision: { configured: true, model: "gpt-4o" } } })
        .find((i) => i.key === "vision")!.chip,
    ).toContain("gpt-4o");
  });
});

describe("装配条的生图那一格", () => {
  const bare = () => createInitialState("rv", "t", false);

  it("未配时明说「未配」，并解释为什么工具面上干脆没有它", () => {
    const item = deriveAssemblyBar(bare(), { roleModels: { image: { configured: false } } })
      .find((i) => i.key === "image")!;
    expect(item.chip).toBe("生图 未配");
    expect(item.why).toContain("根本不进工具面");
  });

  it("未配的那个对象是真值——判据必须认 configured 而不是对象本身", () => {
    const snapshot = { roleModels: { image: { configured: false } } };
    expect(Boolean(snapshot.roleModels.image)).toBe(true);
    expect(
      deriveAssemblyBar(bare(), snapshot).find((i) => i.key === "image")!.chip,
    ).toBe("生图 未配");
  });

  it("两种数据源形状都认：逐 run 是字符串，进程级是对象", () => {
    const perRun = reduceEvents(bare(), [
      sse(0, "host", "run_config", { roleModels: { image: "dall-e-3" } }),
    ]);
    expect(deriveAssemblyBar(perRun, null).find((i) => i.key === "image")!.chip).toContain("dall-e-3");
    expect(
      deriveAssemblyBar(bare(), { roleModels: { image: { configured: true, model: "gpt-image-1" } } })
        .find((i) => i.key === "image")!.chip,
    ).toContain("gpt-image-1");
  });
});

describe("装配条的办公出站通知那一格", () => {
  const bare = () => createInitialState("rn", "t", false);
  const leak = "https://open.feishu.cn/open-apis/bot/v2/hook/LEAKED_NOTIFY_TOKEN";

  it("armed 时上条；未开不上条；误带的 webhook 不进芯片", () => {
    const on = deriveAssemblyBar(bare(), {
      notify: { kind: "feishu", armed: true, webhookUrl: leak },
    });
    const chip = on.find((i) => i.key === "notify");
    expect(chip?.chip).toBe("飞书门禁通知已开");
    expect(JSON.stringify(chip)).not.toContain(leak);
    expect(JSON.stringify(chip)).not.toContain("webhookUrl");

    const off = deriveAssemblyBar(bare(), { notify: { kind: "feishu", armed: false } });
    expect(off.some((i) => i.key === "notify")).toBe(false);

    const wecom = deriveAssemblyBar(bare(), { notify: { kind: "wecom", armed: true, webhookUrl: leak } });
    expect(wecom.find((i) => i.key === "notify")?.chip).toBe("企业微信出站已开");
    expect(JSON.stringify(wecom.find((i) => i.key === "notify"))).not.toContain(leak);
  });
});

// ================================================================
// MODEL-01a 端点降级：换端点这件事必须在界面上留痕
// ================================================================

describe("端点降级在界面上看得见", () => {
  /**
   * 换端点是**本次运行最强的解释变量**：之后每一轮的措辞、工具偏好、失败形态
   * 都可能因此改变。这条事件若被静默丢弃（`app.js` 的逐字段白名单投影天生就是
   * 这个语义），界面只是少一行，肉眼看不出——正是这个项目踩过七次的那条缝。
   */
  function stateWithFallback(extra: Record<string, unknown> = {}) {
    let s = createInitialState("run-fb", "降级任务", false);
    s = reduceEvents(s, [
      sse(0, "main", "turn_start", { turn: 1 }),
      sse(1, "model", "model_fallback", {
        from: "deepseek-v4-pro",
        to: "kimi-k3",
        reason: "503: upstream unavailable",
        turn: 2,
        ...extra,
      }),
    ]);
    return s;
  }

  it("日志里渲染出「从谁换到谁 + 为什么离开」，且默认展开", () => {
    renderRunDetail(stateWithFallback(), { activeTab: "loop" });
    const entry = document.querySelector(".log-entries .log-entry") as HTMLElement | null;
    const body = document.querySelector(".log-entries")?.textContent ?? "";
    expect(body).toContain("deepseek-v4-pro");
    expect(body).toContain("kimi-k3");
    expect(body).toContain("503: upstream unavailable");
    // 折叠会把这行藏起来；这条事件恰恰是后面所有轮次的前提，不能默认折叠
    expect([...document.querySelectorAll(".log-entries .log-entry")].some(
      (e) => e.textContent?.includes("deepseek-v4-pro") && !e.className.includes("log-entry--collapsed"),
    )).toBe(true);
    expect(entry).not.toBeNull();
  });

  it("熔断跳过要说成「隔离期跳过」，不能显示成一个假的错误码", () => {
    renderRunDetail(stateWithFallback({ reason: "circuit_open" }), { activeTab: "loop" });
    const body = document.querySelector(".log-entries")?.textContent ?? "";
    expect(body).toContain("熔断隔离期");
    expect(body).not.toContain("circuit_open");
  });

  it("界面要说清默认只覆盖执行者——角色须显式配置或 inherit", () => {
    renderRunDetail(stateWithFallback(), { activeTab: "loop" });
    const body = document.querySelector(".log-entries")?.textContent ?? "";
    expect(body).toContain("主执行者");
    expect(body).toContain("该角色的输出由新端点产生");
  });

  it("装配条：配了链才上条，且写出完整链路", () => {
    const configured = reduceEvents(createInitialState("rc", "t", false), [
      sse(0, "host", "run_config", { fallbackChain: ["deepseek-v4-pro", "kimi-k3"] }),
    ]);
    const chip = deriveAssemblyBar(configured, null).find((i) => i.key === "fallback");
    expect(chip?.chip).toContain("deepseek-v4-pro → kimi-k3");
    expect(chip?.why).toMatch(/角色默认不进|显式配置或 inherit/);
  });

  it("没配降级链时这一格根本不出现（未配是常态，摆一格「未配」只是噪声）", () => {
    expect(
      deriveAssemblyBar(createInitialState("rc2", "t", false), null).find((i) => i.key === "fallback"),
    ).toBeUndefined();
  });

  it("已经降过级的运行，装配条上要看得出来（配置 ≠ 发生过）", () => {
    let s = createInitialState("rc3", "t", false);
    s = reduceEvents(s, [
      sse(0, "host", "run_config", { fallbackChain: ["a", "b"] }),
    ]);
    expect(deriveAssemblyBar(s, null).find((i) => i.key === "fallback")!.chip).not.toContain("已降级");
    s = reduceEvents(s, [sse(1, "model", "model_fallback", { from: "a", to: "b", reason: "503", turn: 1 })]);
    expect(deriveAssemblyBar(s, null).find((i) => i.key === "fallback")!.chip).toContain("已降级");
  });

  it("prefer_cheap 路由在装配条上标「偏好廉价」", () => {
    const s = reduceEvents(createInitialState("rc-cheap", "t", false), [
      sse(0, "host", "run_config", {
        fallbackChain: ["pro", "flash"],
        fallbackRouting: "prefer_cheap",
      }),
    ]);
    expect(deriveAssemblyBar(s, null).find((i) => i.key === "fallback")!.chip).toContain("偏好廉价");
  });

  it("endpointHealth 有探针/熔断证据时上装配条（只读，不改路由）", () => {
    const s = reduceEvents(createInitialState("rc-health", "t", false), [
      sse(0, "host", "run_config", {
        endpointHealth: [
          { model: "a", healthy: false, circuit: "open", reason: "upstream:503" },
        ],
      }),
    ]);
    const chip = deriveAssemblyBar(s, null).find((i) => i.key === "endpointHealth");
    expect(chip?.chip).toContain("端点健康");
    expect(chip?.chip).toContain("a");
    expect(chip?.why).toMatch(/不改路由/);
  });

  it("supportsVision=false 时装配条写「识图 不可用」而不是模型名", () => {
    const s = reduceEvents(createInitialState("rc-vis", "t", false), [
      sse(0, "host", "run_config", {
        roleModels: { vision: "text-only-vl" },
        supportsVision: false,
      }),
    ]);
    expect(deriveAssemblyBar(s, null).find((i) => i.key === "vision")!.chip).toBe("识图 不可用");
  });

  it("执行者能看图 → 条上写「识图 执行者」，不引用库里的识图角色名", () => {
    const s = reduceEvents(createInitialState("rc-eye", "t", false), [
      sse(0, "host", "run_config", {
        describeImageBacking: "executor",
        roleModels: { vision: null },
        supportsVision: true,
      }),
    ]);
    const item = deriveAssemblyBar(s, {
      roleModels: { vision: { configured: true, model: "moonshot-v1-8k-vision-preview" } },
    }).find((i) => i.key === "vision")!;
    expect(item.chip).toBe("识图 执行者");
    expect(item.why).toMatch(/不另引识图角色/);
    expect(item.chip).not.toContain("moonshot");
  });
});

describe("会话标题：算出来的短句，不是任务原文", () => {
  /**
   * 侧栏此前直接铺任务原文——一条几百字的描述占三四行还看不出是什么。
   * 委托方截图里第一条就是 `附件：uploads/65a53cbdab081af8413977836a52f10b.jpg…`。
   */
  it("长任务截断到可扫视的长度", () => {
    const t = deriveRunTitle("你好 今天广东省佛山市南海区的天气怎么样 适合去哪些地方玩啊?");
    expect(t.length).toBeLessThanOrEqual(25);
    expect(t.startsWith("你好")).toBe(true);
  });

  it("只有附件时拿文件名当标题，不铺整条路径", () => {
    const t = deriveRunTitle("附件：uploads/65a53cbdab081af8413977836a52f10b.jpg");
    expect(t.startsWith("附件 ")).toBe(true);
    expect(t).not.toContain("uploads/");
  });

  /** 附件是补充材料不是任务本身——有正文就取正文 */
  it("既有正文又有附件时取正文", () => {
    expect(deriveRunTitle("写一个函数\n附件：uploads/a.png")).toBe("写一个函数");
  });

  it("剥掉 Markdown 行首记法（标题/列表/引用）", () => {
    expect(deriveRunTitle("## 三、四线制 PT1000 测量原理")).toBe("三、四线制 PT1000 测量原理");
    expect(deriveRunTitle("- 做一件事")).toBe("做一件事");
    expect(deriveRunTitle("1. 做一件事")).toBe("做一件事");
    expect(deriveRunTitle("> 引用的任务")).toBe("引用的任务");
  });

  it("空 / 全空白 → 有个确定的兜底，不是空字符串", () => {
    expect(deriveRunTitle("")).toBe("未命名任务");
    expect(deriveRunTitle("   \n  ")).toBe("未命名任务");
    expect(deriveRunTitle(undefined)).toBe("未命名任务");
  });

  it("用户气泡与标题不重印宿主 [改范围] chrome，用户原话留下", () => {
    const text =
      `[改稿范围] 只改 data-slide="back"（文件 index.html）。不要改其它页，不要整份重写。\n` +
      "图片你自己有核对过吗？完全与介绍的科技不相关";
    expect(stripHostEditScopeChrome(text)).toBe("图片你自己有核对过吗？完全与介绍的科技不相关");
    const html = renderChatItem({ kind: "user", text, seq: 9 });
    expect(html).not.toContain("[改稿范围]");
    expect(html).not.toContain("[改范围]");
    expect(html).not.toContain("data-slide");
    expect(html).toContain("图片你自己有核对过吗");
    expect(deriveRunTitle(text)).toContain("图片你自己有核对过吗");
    expect(deriveRunTitle(text)).not.toContain("改稿范围");
  });
});

describe("对话展示层：工具回执与整份 HTML 不进主气泡", () => {
  const html20k = `<!DOCTYPE html>\n<html lang="zh-CN"><head><title>三体</title></head><body>${"x".repeat(20_000)}</body></html>`;

  it("剥掉焊在人话前面的「已收到，交付完成」", () => {
    const welded = "已收到，交付完成。\n帮我安装 ppt-master 的 skill 然后你再用这个 skill 再重做一版";
    expect(peelHostToolReceipts(welded)).toBe("帮我安装 ppt-master 的 skill 然后你再用这个 skill 再重做一版");
    expect(paintConversationUserText(welded).display).toContain("帮我安装 ppt-master");
    expect(paintConversationUserText(welded).display).not.toContain("已收到");
    const html = renderChatItem({ kind: "user", text: welded, seq: 7 });
    document.body.innerHTML = html;
    const bubble = document.querySelector(".chat-msg--user .chat-body") as HTMLElement;
    const shown = bubble.textContent ?? "";
    expect(shown).toContain("帮我安装 ppt-master");
    expect(shown).not.toContain("已收到，交付完成");
  });

  it("纯工具回执不画成用户气泡", () => {
    expect(paintConversationUserText("已收到，交付完成。").kind).toBe("receipt");
    expect(paintConversationUserText("Progress updated (3): [x] 写 index.html").kind).toBe("receipt");
    expect(paintConversationUserText("[execution boundary=abc state=report-only] total 40").kind).toBe("receipt");
    let s = createInitialState("run-receipt", "做杂志", false);
    s = reduceEvents(s, [
      sse(1, "host", "user_message", { text: "已收到，交付完成。", turn: 2 }),
      sse(2, "host", "user_message", { text: "帮我重做一版", turn: 3 }),
    ]);
    const users = deriveChatItems({ ...s, status: "done" }).filter((it) => it.kind === "user");
    expect(users.some((it) => it.text === "已收到，交付完成。")).toBe(false);
    expect(users.some((it) => it.text === "帮我重做一版")).toBe(true);
    document.body.innerHTML = renderChatItem({ kind: "user", text: "已收到，交付完成。", seq: 1 });
    expect(document.querySelector(".chat-msg--user")).toBeNull();
    expect(document.querySelector(".chat-tool-receipt")).not.toBeNull();
  });

  it("20KB HTML 用户消息不进主气泡 innerText", () => {
    expect(looksLikeHugeDocumentBody(html20k)).toBe(true);
    expect(foldedDocumentStub(html20k)).toMatch(/HTML|折叠/);
    let s = createInitialState("run-html", "做杂志", false);
    s = reduceEvents(s, [
      sse(1, "host", "user_message", { text: html20k, turn: 2 }),
    ]);
    const item = deriveChatItems({ ...s, status: "done" }).find((it) => it.kind === "user" && it.seq === 1);
    expect(item, "事件原文仍在条目上，不改正史").toMatchObject({ text: html20k });
    document.body.innerHTML = renderChatItem(item);
    const bubble = document.querySelector(".chat-msg--user .chat-body") as HTMLElement;
    expect(bubble).toBeTruthy();
    const shown = bubble.textContent ?? "";
    expect(shown).not.toContain("<!DOCTYPE html>");
    expect(shown).toMatch(/HTML|折叠|写入/);
    expect(shown.length).toBeLessThan(80);
    expect(document.querySelector(".chat-doc-fold")).not.toBeNull();
  });

  it("20KB HTML 工具回执不进用户/助手主气泡", () => {
    let s = createInitialState("run-tool-html", "做杂志", false);
    s = reduceEvents(s, [
      sse(0, "main", "tool_call", {
        toolUseId: "w",
        name: "write_file",
        input: { path: "index.html", content: html20k },
      }),
      sse(1, "main", "tool_result", {
        toolUseId: "w",
        result: { content: html20k, isError: false },
      }),
    ]);
    const running = deriveChatItems(s);
    const group = running.find((it) => it.kind === "tools");
    expect(group).toBeTruthy();
    document.body.innerHTML = renderChatItem(group);
    expect(document.querySelector(".chat-msg--user")).toBeNull();
    const main = document.querySelector(".chat-tool-group-body .chat-body") as HTMLElement;
    expect(main).toBeTruthy();
    const shown = main.textContent ?? "";
    expect(shown).not.toContain("<!DOCTYPE html>");
    expect(shown).toMatch(/index\.html|HTML|折叠|写入/);
  });

  it("20KB HTML 助手正文也不进主气泡 innerText", () => {
    document.body.innerHTML = renderChatItem({ kind: "text", text: html20k, seq: 3, role: "main" });
    const bubble = document.querySelector(".chat-msg--assistant .chat-body") as HTMLElement;
    const shown = bubble.textContent ?? "";
    expect(shown).not.toContain("<!DOCTYPE html>");
    expect(shown).toMatch(/HTML|折叠|写入/);
  });
});

describe("deriveRunTitle 续", () => {

  it("每轮收尾后从执行者最后一段正文抽出摘要", () => {
    let s = createInitialState("r", "做网站", false);
    s = reduceEvents(s, [sse(0, "main", "assistant_text", { text: "已经写好 article.html 和联系页。" })]);
    expect(deriveConversationRecap(s)).toContain("article.html");
    s = reduceEvents(s, [sse(1, "main", "assistant_text", { text: "移动端也过了，本轮收工。" })]);
    expect(deriveConversationRecap(s)).toContain("移动端");
  });

  it("续跑 fort 后对话里先出现此前摘要", () => {
    let s = createInitialState("child", "请为我生成一个完整的网站设计方案", false);
    s = reduceEvents(s, [
      sse(0, "host", "run_forked", {
        parentRunId: "parent",
        rootRunId: "parent",
        priorRecap: "已生成崩坏主题站点，含 article.html。",
        priorTurns: 5,
        checkpoint: { conversationTurn: 5 },
      }),
      sse(1, "host", "user_message", { text: "这是可浏览的成品吗？", turn: 6 }),
    ]);
    const kinds = deriveChatItems(s).map((i) => i.kind);
    expect(kinds).toContain("recap");
    const recap = deriveChatItems(s).find((i) => i.kind === "recap");
    expect(recap.text).toContain("article.html");
    expect(recap.turns).toBe(5);
    expect(renderChatItem(recap)).toContain("此前 5 轮");
  });

  it("删对话时整条谱系一起走", () => {
    const runs = [
      { runId: "root", continuedFrom: null },
      { runId: "mid", continuedFrom: "root" },
      { runId: "tip", continuedFrom: "mid" },
      { runId: "other", continuedFrom: null },
    ];
    expect(conversationChainIds(runs, "tip").sort()).toEqual(["mid", "root", "tip"]);
    expect(conversationChainIds(runs, "other")).toEqual(["other"]);
  });

  it("谱系产物沿 continuedFrom 拼回来", () => {
    const parent = reduceEvents(createInitialState("parent", "做网站", false), [
      sse(0, "main", "tool_call", { toolUseId: "w", name: "write_file", input: { path: "article.html" } }),
      sse(1, "main", "tool_result", { toolUseId: "w", result: { content: "ok", isError: false } }),
    ]);
    const child = createInitialState("child", "请为我生成一个完整的网站设计方案", false);
    const files = deriveThreadFiles(
      [
        { runId: "parent", continuedFrom: null },
        { runId: "child", continuedFrom: "parent" },
      ],
      new Map([["parent", parent], ["child", child]]),
      "child",
    );
    expect(files.map((f) => f.path)).toContain("article.html");
  });

  it("列表项渲染标题，同时把原文挂 title（鼠标停一下看全）", () => {
    const runs = [{ runId: "a", task: "很长很长的任务描述".repeat(6), status: "done", verify: false, createdAt: 1, finishedAt: 2 }];
    renderRunList(runs, null, () => {}, deriveRunListItems(runs, new Map()));
    const el = document.querySelector(".run-item-task") as HTMLElement;
    expect(el.textContent!.length).toBeLessThan(30);
    expect(el.getAttribute("title")).toBe(runs[0].task);
  });
});

describe("空态给的是能点的例子", () => {
  /**
   * 第一次打开时最难的不是不会用，而是**不知道这个 agent 能干什么**——
   * 一句"尚无运行"把这个问题原样退回给人。
   */
  function paintWelcome(opts = {}) {
    const panel = document.getElementById("main-panel");
    panel?.classList.add("is-welcome");
    const gallery = document.getElementById("starter-gallery");
    if (gallery) gallery.hidden = false;
    renderEmptyState(Boolean(opts.hasRuns), opts);
    renderStarterGallery(opts);
  }

  it("编码空态是三行作业，不是问/读/写教具", () => {
    paintWelcome();
    const items = [...document.querySelectorAll("[data-example]")];
    expect(items.map((e) => e.querySelector(".starter-tile-title")?.textContent)).toEqual([
      "从计划开始",
      "看看这个仓库",
      "修一处并跑通测试",
    ]);
    expect(items[0].getAttribute("data-starter-plan")).toBe("1");
    const all = items.map((e) => e.textContent).join(" ");
    expect(all).toContain("先对齐做法");
    expect(all).toContain("用测试当判据");
    expect(all).not.toContain("不要调用工具");
    expect(all).not.toMatch(/问|读|写/);
    expect(document.querySelector("[data-design-mode-enter]")).toBeNull();
    expect(document.querySelector("[data-office-more]")).toBeNull();
  });

  it("示例文本进 data-example，点击由宿主填进输入框（不直接开跑）", () => {
    paintWelcome();
    const btn = document.querySelector("[data-example]") as HTMLElement;
    expect(btn.tagName).toBe("BUTTON"); // 键盘可达
    expect(btn.getAttribute("data-example")!.length).toBeGreaterThan(5);
    expect(btn.getAttribute("title")).toBeTruthy();
  });

  it("已有运行时的新建对话面仍给示例——示例属于启动器，不属于首次安装", () => {
    paintWelcome({ hasRuns: true });
    expect(document.querySelectorAll("[data-example]").length).toBe(3);
    expect(document.querySelector(".empty-brand")!.textContent).toMatch(/FATHOM/);
    expect(document.querySelector(".empty-tagline")!.textContent).toContain("说要做什么");
    expect(document.querySelector(".empty-tagline-cn")!.textContent).toContain("稿件");
  });

  it("空态不再放工作目录/引导入口——composer 与设置里已有", () => {
    paintWelcome();
    expect(document.querySelector("[data-focus-workdir]")).toBeNull();
    expect(document.querySelector("[data-replay-onboarding]")).toBeNull();
    expect(document.getElementById("workdir-select")).toBeTruthy();
  });

  it("办公空态是纪要 / 一页 / 出处加更多稿件，没有仓库作业", () => {
    paintWelcome({ workspaceFace: "office" });
    const titles = [...document.querySelectorAll("#starter-gallery .starter-tile-title")].map((e) => e.textContent);
    expect(titles).toEqual(["做纪要", "做一页", "带出处问答", "更多稿件"]);
    expect(document.querySelector("[data-office-more]")?.textContent).toContain("更多稿件");
    expect(document.querySelector("[data-design-mode-enter]")).toBeNull();
    expect(document.querySelector("[data-design-mode-exit]")).toBeNull();
    expect(document.querySelector("[data-design-template]")).toBeNull();
    const gallery = document.getElementById("starter-gallery")?.textContent ?? "";
    expect(gallery).not.toContain("从计划开始");
    expect(gallery).not.toContain("修一处并跑通测试");
    expect(gallery).not.toContain("看看这个仓库");
    expect(OFFICE_STARTER_JOBS.map((j) => j.label)).toEqual(["做纪要", "做一页", "带出处问答"]);
    expect(document.querySelector(".empty-state--design")).toBeNull();
    expect(document.querySelector(".empty-tagline")?.textContent).toContain("说要做什么");
    expect(document.querySelector(".empty-window-note")?.textContent).toContain("现在只能在这个窗口下指令");
    const html = readFileSync(join(UI_DIR, "index.html"), "utf-8");
    expect(html).toMatch(/designModeActive:\s*officeCatalogOpen/);
  });

  it("更多稿件打开六页签；返回只回到办公四行", () => {
    paintWelcome({ workspaceFace: "office" });
    expect(document.querySelector("[data-office-more]")).toBeTruthy();
    expect(document.querySelector("[data-design-tab]")).toBeNull();
    paintWelcome({
      workspaceFace: "office",
      officeCatalogOpen: true,
      selectedDesignTab: "Prototype",
      catalog: [
        { id: "web-prototype", tab: "Prototype", title: "网页原型", description: "默认落地页" },
        { id: "3d-object", tab: "Prototype", title: "三维对象", description: "WebGL 场景" },
        { id: "dashboard", tab: "Live Artifact", title: "仪表盘", description: "管理台" },
      ],
    });
    expect(document.querySelector("[data-design-mode-exit]")?.textContent).toMatch(/返回/);
    expect(document.querySelector("[data-design-tab]")).toBeTruthy();
    paintWelcome({ workspaceFace: "office" });
    expect(document.querySelector("[data-design-mode-exit]")).toBeNull();
    expect(document.querySelector("[data-design-tab]")).toBeNull();
    expect(document.querySelector("[data-office-more]")).toBeTruthy();
    expect(document.querySelector("[data-design-mode-enter]")).toBeNull();
  });

  it("六页签廊 Prototype 含三维对象；页签只显示中文", () => {
    expect(document.querySelector("[data-design-mode-enter]")).toBeNull();
    expect(DESIGN_MODE_TABS).toEqual([
      "Prototype",
      "Live Artifact",
      "Deck",
      "Template",
      "Media",
      "Other",
    ]);
    expect(designTabLabel("Prototype")).toBe("原型");
    expect(DESIGN_MODE_TAB_LABELS).toMatchObject({
      Prototype: "原型",
      "Live Artifact": "实时产物",
      Deck: "幻灯",
      Template: "模板",
      Media: "媒体",
      Other: "其他",
    });
    paintWelcome({
      designModeActive: true,
      selectedDesignTab: "Prototype",
      catalog: [
        { id: "web-prototype", tab: "Prototype", title: "网页原型", description: "默认落地页" },
        { id: "3d-object", tab: "Prototype", title: "三维对象", description: "WebGL 场景" },
        { id: "dashboard", tab: "Live Artifact", title: "仪表盘", description: "管理台" },
      ],
    });
    const tabs = [...document.querySelectorAll("[data-design-tab]")].map((el) => el.getAttribute("data-design-tab"));
    expect(tabs).toEqual([...DESIGN_MODE_TABS]);
    expect([...document.querySelectorAll("[data-design-tab]")].map((el) => el.textContent?.trim())).toEqual([
      "原型",
      "实时产物",
      "幻灯",
      "模板",
      "媒体",
      "其他",
    ]);
    expect(document.querySelector(".design-tab-row")?.textContent).not.toMatch(/Prototype|Live Artifact|Deck|Template|Media|Other/);
    expect(document.querySelector('[data-design-id="3d-object"]')?.textContent).toContain("三维对象");
    expect(document.querySelector('[data-design-tab="Prototype"]')?.classList.contains("is-selected")).toBe(true);
    const back = document.querySelector("[data-design-mode-exit]");
    expect(back?.textContent).toMatch(/返回/);
    expect(document.querySelector("[data-design-mode-enter]")).toBeNull();
    expect(document.querySelector('[data-design-sample="proto-free"]')?.textContent).toContain("自由风格");
    expect(document.querySelector(".design-sample-thumb")).toBeTruthy();
    expect(document.querySelector(".design-sample-thumb--landing, .design-sample-thumb--mobile, .design-sample-thumb--cube")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Claude Design|Kimi|OpenDesign/i);
  });

  it("设计模式可以返回开始页；新建对话也会离开", () => {
    paintWelcome({ designModeActive: true, selectedDesignTab: "Deck" });
    expect(document.querySelector("[data-design-mode-exit]")).toBeTruthy();
    expect(document.querySelector("[data-design-tab]")).toBeTruthy();
    paintWelcome({ workspaceFace: "office" });
    expect(document.querySelector("[data-design-mode-exit]")).toBeNull();
    expect(document.querySelector("[data-design-tab]")).toBeNull();
    expect(document.querySelector("[data-office-more]")).toBeTruthy();
    expect(document.querySelector("[data-design-mode-enter]")).toBeNull();
    const html = readFileSync(join(UI_DIR, "index.html"), "utf-8");
    expect(html).toMatch(/data-design-mode-exit/);
    expect(html).toMatch(/function exitDesignMode/);
    expect(html).toMatch(/officeCatalogOpen = false/);
    expect(html).toMatch(/designModeActive = workspaceFace === "office"/);
  });

  it("选 Deck 页签时画出带缩略图的样例卡，不是第二排文字钮", () => {
    paintWelcome({
      designModeActive: true,
      selectedDesignTab: "Deck",
      selectedDesignSample: "deck-free",
    });
    const cards = [...document.querySelectorAll("[data-design-sample]")];
    expect(cards.length).toBeGreaterThanOrEqual(3);
    expect(cards.length).toBeLessThanOrEqual(4);
    expect(document.querySelectorAll(".design-sample-thumb").length).toBe(cards.length);
    expect(document.querySelector(".design-sample-thumb--blank")).toBeTruthy();
    expect(document.querySelector(".design-sample-thumb--deck, .design-sample-thumb--magazine, .design-sample-thumb--bullets")).toBeTruthy();
    expect(document.querySelector(".design-type-row")).toBeNull();
    expect(document.querySelector('[data-design-sample="deck-free"]')?.classList.contains("is-selected")).toBe(true);
    expect(document.querySelector('[data-design-sample="deck-cover"]')?.getAttribute("data-design-template")).toBe("deck-basic");
    expect(cards.every((el) => el.classList.contains("starter-tile"))).toBe(false);
    expect(document.querySelector('[data-design-tab="Deck"]')?.textContent).toContain("幻灯");
  });

  it("设计样例卡是迷你页缩略图，不是小图标 chip", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "ui", "public", "styles.css"), "utf-8");
    expect(css).toMatch(/\.design-sample-card\s*\{[^}]*flex:\s*0 0 210px;/);
    expect(css).toMatch(/\.design-sample-card\s*\{[^}]*width:\s*210px;/);
    expect(css).toMatch(/\.design-sample-card\s*\{[^}]*min-width:\s*180px;/);
    expect(css).toMatch(/\.design-sample-card\s*\{[^}]*max-width:\s*240px;/);
    expect(css).toMatch(/\.design-sample-thumb\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*10;/);
    expect(css).toMatch(/\.design-sample-thumb\s*\{[^}]*min-height:\s*131px;/);
    expect(css).toContain("#main-panel.is-welcome #starter-gallery.starter-gallery--design {\n  width: min(100%, 60rem);\n  min-height: 14.5rem;\n}");
    expect(css).not.toMatch(/\.design-sample-row\s*\{[^}]*grid-template-columns:\s*repeat\(4/);
    paintWelcome({ designModeActive: true, selectedDesignTab: "Prototype" });
    const first = document.querySelector("[data-design-sample]");
    expect(first?.getAttribute("data-design-sample")).toBe("proto-free");
    expect(first?.querySelector(".design-sample-title")?.textContent).toBe("自由风格");
    expect(first?.querySelector(".design-sample-thumb--blank")).toBeTruthy();
    expect(document.querySelector("#starter-gallery .ph")).toBeNull();
  });

  it("点样例卡会带上模板或提示词", () => {
    const deck = resolveDesignSampleChoice("deck-magazine");
    expect(deck?.designTemplate).toBe("deck-basic");
    expect(deck?.designId).toBe("guizang-ppt");
    expect(deck?.needsImages).toBe(true);
    expect(deck?.prompt).toMatch(/杂志风|deck-basic/);
    expect(designSampleBlockedReason(deck, false)).toMatch(/未配置识图/);
    expect(designSampleBlockedReason(deck, true)).toBe("");
    expect(harnessVisionConfigured({ roleModels: { vision: { configured: true } } })).toBe(true);
    expect(harnessVisionConfigured({ roleModels: { vision: { configured: false } } })).toBe(false);
    expect(harnessVisionConfigured({
      describeImageBacking: "executor",
      roleModels: { vision: { configured: false } },
    })).toBe(true);
    expect(harnessVisionConfigured({
      describeImageBacking: "none",
      roleModels: { vision: { configured: true } },
    })).toBe(false);

    const landing = resolveDesignSampleChoice("proto-landing");
    expect(landing?.designTemplate).toBe("landing-basic");
    expect(landing?.prompt).toContain("landing-basic");

    const blank = resolveDesignSampleChoice("proto-free");
    expect(blank?.designTemplate).toBeNull();
    expect(blank?.designId).toBe("web-prototype");
    expect(blank?.prompt.length).toBeGreaterThan(5);

    const picked = nextDesignSampleState("deck-cover", { prompt: "" });
    expect(picked.selectedDesignSample).toBe("deck-cover");
    expect(picked.selectedDesignTemplate).toBe("deck-basic");
    expect(picked.prompt).toContain("封面主张");
    expect(picked.prompt).not.toMatch(/data-slide|deck-basic/);

    paintWelcome({
      designModeActive: true,
      selectedDesignTab: "Deck",
      visionConfigured: false,
    });
    const magazine = document.querySelector('[data-design-sample="deck-magazine"]');
    expect(magazine?.hasAttribute("disabled")).toBe(true);
    expect(magazine?.getAttribute("data-needs-images")).toBe("1");
    expect(magazine?.textContent).toMatch(/未配置识图/);
    expect(document.querySelector('[data-design-sample="deck-cover"]')?.hasAttribute("disabled")).toBe(false);

    const kept = nextDesignSampleState("deck-cover", { prompt: "我要做融资路演" });
    expect(kept.selectedDesignTemplate).toBe("deck-basic");
    expect(kept.prompt).toBe("我要做融资路演");

    expect(designSamplesForTab("Deck").every((s) => s.thumb && s.title)).toBe(true);

    const spec = resolveDesignSampleChoice("doc-spec");
    expect(spec?.designId).toBe("pm-spec");
    expect(spec?.designTemplate).toBe("pm-spec");
    const bundle = resolveDesignSampleChoice("doc-spec-deck");
    expect(bundle?.designId).toBe("spec-plus-deck");
    expect(bundle?.prompt).toMatch(/产品规格.*汇报幻灯/);
    const okr = resolveDesignSampleChoice("doc-okr");
    expect(okr?.designTemplate).toBe("team-okrs");
    const freeDoc = resolveDesignSampleChoice("doc-free");
    expect(freeDoc?.designId).toBeNull();
    expect(freeDoc?.designTemplate).toBeNull();
  });

  it("幻灯/社媒页签露出五色皮，不是 540 套主题馆", () => {
    paintWelcome({ designModeActive: true, selectedDesignTab: "Prototype" });
    expect(document.querySelector("[data-design-look]")).toBeNull();

    paintWelcome({
      designModeActive: true,
      selectedDesignTab: "Deck",
      selectedDesignLook: "paper",
    });
    const looks = [...document.querySelectorAll("[data-design-look]")];
    expect(looks.map((el) => el.getAttribute("data-design-look"))).toEqual(DESIGN_LOOKS.map((l) => l.id));
    expect(looks.map((el) => el.textContent?.trim())).toEqual(["墨水", "暖纸", "夜色", "草地", "陶土"]);
    expect(document.querySelector('[data-design-look="paper"]')?.classList.contains("is-selected")).toBe(true);
    expect(document.querySelector(".design-look-swatch")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Open Design|15\s*[×x]\s*36|540/);

    paintWelcome({ designModeActive: true, selectedDesignTab: "Media" });
    expect(document.querySelectorAll("[data-design-look]").length).toBe(5);

    const withLook = nextDesignSampleState("deck-cover", { prompt: "", selectedDesignLook: "paper" });
    expect(withLook.prompt).toContain("色板用「暖纸 / paper」");
    expect(isDesignSamplePrompt(withLook.prompt)).toBe(true);
    expect(composePromptWithLook("做一封营销邮件：表格降级安全。", "paper")).toBe(
      "做一封营销邮件：表格降级安全。",
    );
    expect(nextDesignLookState("paper", {
      prompt: withLook.prompt,
      selectedDesignLook: "paper",
    }, { toggle: true }).selectedDesignLook).toBeNull();

    paintWelcome({ designModeActive: true, selectedDesignTab: "Deck" });
    const inkRow = document.querySelector(".design-sample-row");
    expect(inkRow?.classList.contains("has-look")).toBe(true);
    expect(inkRow?.style.getPropertyValue("--look-bg")).toBe("#0f1419");

    paintWelcome({
      designModeActive: true,
      selectedDesignTab: "Deck",
      selectedDesignLook: "paper",
    });
    expect(document.querySelector(".design-sample-row")?.style.getPropertyValue("--look-bg")).toBe("#f4f1ea");

    paintWelcome({ designModeActive: true, selectedDesignTab: "Media" });
    const social = document.querySelector('[data-design-sample="media-free"]');
    expect(social?.textContent).toContain("社媒方图");
    expect(social?.textContent).toContain("1080");
    expect(social?.textContent).not.toContain("自由风格");
    expect(resolveDesignSampleChoice("media-free")?.prompt).not.toMatch(/data-card|social-basic/);
  });

  it("新建 placeholder 是「说要做什么」，不写目录命令口吻", () => {
    expect(composerFolderName("D:\\\\Work\\\\Github_pros\\\\Agent_Design")).toBe("Agent_Design");
    expect(composerFolderName("/tmp/demo/")).toBe("demo");
    expect(composerFolderName("")).toBe("");
    expect(newRunPlaceholder("D:\\\\Work\\\\Agent_Design")).toBe("说要做什么…");
    expect(newRunPlaceholder(null)).toBe("说要做什么…");
    expect(deriveComposerMode({ info: null }).placeholder).toBe("说要做什么…");
    expect(deriveComposerMode({ info: null, workdir: "D:\\\\repo\\\\kicad" }).placeholder)
      .toBe("说要做什么…");
    expect(deriveComposerMode({ info: null }).buttonLabel).toBe("发送");
    expect(deriveComposerMode({ info: null }).labelText).toBe("发送");
  });

  it("设计模式 placeholder 用稿名，不把仓库文件夹写进框", () => {
    expect(newRunPlaceholder("D:\\\\Work\\\\Agent_Design", { designMode: true }))
      .toBe("说要做什么…");
    expect(newRunPlaceholder("D:\\\\Work\\\\Agent_Design", { designMode: true, designTitle: "杂志风幻灯" }))
      .toBe("要「杂志风幻灯」做什么…");
    expect(deriveComposerMode({
      info: null,
      workdir: "D:\\\\Work\\\\Github_pros\\\\Agent_Design",
      designMode: true,
    }).placeholder).toBe("说要做什么…");
    expect(deriveComposerMode({
      info: null,
      workdir: "D:\\\\Work\\\\Github_pros\\\\Agent_Design",
      designMode: true,
      designTitle: "落地页",
    }).placeholder).toBe("要「落地页」做什么…");

    const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "ui", "public", "index.html"), "utf-8");
    const start = html.indexOf("function applyDraftsWorkdirSelection");
    const end = html.indexOf("async function submitNewRun");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = html.slice(start, end);
    expect(block).toContain("async function ensureDesignDraftsWorkdir");
    expect(block).toContain("/api/design-drafts-workdir");
    expect(block).toContain("设计稿写到独立目录");
    expect(block).toContain("host-repo");
    expect(block).toContain("showDesignDraftsHint");
    expect(block).not.toContain("writePrefString");
    expect(html).toContain("稿目录已加入白名单，当前仍在本仓库");
    expect(html).toContain("改写到稿目录");
    expect(html).toContain("verifyToggle.checked = false");
    expect(html).toContain('id="gate-chip"');
    expect(html).toContain('id="design-drafts-hint"');
    expect(html).toContain('id="cite-picker"');
    expect(html).toContain('id="cite-session-btn"');
    expect(html).toContain('aria-label="引用会话"');
    expect(html).not.toContain("引用同目录会话");
    expect(html).toContain("sidebar-all-projects");
    expect(html).toMatch(/id="sidebar-all-projects"[^>]*checked/);
    expect(html).toContain("查资料选 consult");
    expect(html).toContain("packOptionLabel");
    expect(html).toContain("submittedWorkdir");
    expect(html).toContain("submittedProjectId");
  });

  it("composer 是紧凑胶囊：对话与欢迎共用，起步卡只在欢迎", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "ui", "public", "styles.css"), "utf-8");
    expect(css).toContain("#submit-form:focus-within");
    expect(css).toMatch(/\.composer-input-row textarea \{\s*flex: 1 1 auto;\s*min-width: 0;\s*min-height: 36px;/);
    expect(css).toContain(".composer-quickbar > .auto-approve-label");
    expect(css).toMatch(/\.composer-quickbar > \.verify-toggle-label\s*\{\s*display:\s*none\s*!important;/);
    expect(css).not.toContain("#main-panel.is-welcome .composer-quickbar > .verify-toggle-label,\n#main-panel.is-welcome .composer-quickbar > .auto-approve-label");
    expect(css).toContain("#main-panel.is-welcome .starter-tiles {\n  display: flex;");
    expect(css).toContain("#main-panel.is-welcome .starter-tile-hint {\n  display: none;");
  });

  it("运行设置是一行一项的短菜单，长说明进 title", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "ui", "public");
    const html = readFileSync(join(root, "index.html"), "utf-8");
    const css = readFileSync(join(root, "styles.css"), "utf-8");
    const start = html.indexOf('id="run-knobs"');
    const end = html.indexOf('id="starter-gallery"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const knobs = html.slice(start, end);
    expect(knobs).toContain('class="knob-row"');
    expect(knobs).not.toContain("D3 预设");
    expect(knobs).not.toContain("不影响 passed");
    expect(knobs).not.toContain("每一轮都可选");
    expect(css).toMatch(/\.run-knobs\s*\{\s*display:\s*flex;/);
    const knobGrids = [...css.matchAll(/\.run-knobs\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(knobGrids.some((b) => /minmax\(240px/.test(b))).toBe(false);
    expect(css).toContain("width: min(22rem, calc(100% - 20px));");
  });

  it("welcome 时 gallery 在提交栏之后可见；对话态去掉 is-welcome 并藏 gallery", () => {
    paintWelcome();
    const panel = document.getElementById("main-panel")!;
    const form = document.getElementById("submit-form")!;
    const gallery = document.getElementById("starter-gallery")!;
    expect(panel.classList.contains("is-welcome")).toBe(true);
    expect(gallery.hidden).toBe(false);
    expect(form.compareDocumentPosition(gallery) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    panel.classList.remove("is-welcome");
    gallery.hidden = true;
    gallery.innerHTML = "";
    expect(panel.classList.contains("is-welcome")).toBe(false);
    expect(gallery.hidden).toBe(true);
    expect(gallery.querySelector("[data-example]")).toBeNull();
  });
});

describe("办公/编码脸与侧栏密度", () => {
  it("Work 只留办公对话，Code 只留编码；旧档 packName=design 算办公", () => {
    const runs = [
      { runId: "o1", task: "幻灯", workspace: "office", packName: "design" },
      { runId: "c1", task: "修 bug", workspace: "code", packName: "ts-coding" },
      { runId: "legacy", task: "旧稿", packName: "design" },
      { runId: "old-code", task: "板上 CRC", packName: "stm32-debug" },
    ];
    expect(filterRunsByWorkspaceFace(runs, "office").map((r) => r.runId)).toEqual(["o1", "legacy"]);
    expect(filterRunsByWorkspaceFace(runs, "code").map((r) => r.runId)).toEqual(["c1", "old-code"]);
    expect(runBelongsToOffice({ packName: "design" })).toBe(true);
    expect(runBelongsToOffice({ facade: "design", mode: "single" })).toBe(true);
    expect(runBelongsToOffice({ designRoute: { id: "pm-spec" }, mode: "single" })).toBe(true);
    expect(runBelongsToOffice({ workspace: "code", packName: "design" })).toBe(false);
  });

  it("Work 脸只列 Fathom 对话，不列 AGS；勾选与 primary 无关", () => {
    const ags = "D:\\Work\\Wafer\\AGS";
    const fathom = "C:\\Users\\rk302\\Fathom";
    const project = {
      id: "wafer-board",
      name: "看板",
      workdirs: [ags, fathom],
      primaryWorkdir: fathom,
    };
    const pair = [
      { runId: "ags-1", task: "看看 AGS 源文件", workdir: ags, workspace: "code", packName: "ts-coding" },
      { runId: "fathom-1", task: "杂志风幻灯", workdir: fathom, workspace: "office", packName: "design" },
    ];
    const visible = filterRunsByWorkspaceFace(
      filterRunsByComposerWorkdir(pair, fathom, false, project),
      "office",
    );
    expect(visible.map((r) => r.runId)).toEqual(["fathom-1"]);
    document.body.innerHTML = '<div id="run-list" class="run-list"></div>';
    renderRunList(visible, null, () => {}, new Map(), undefined, { projects: [project] });
    expect(document.querySelector(".run-group-name")?.textContent).toBe("看板");
    const tasks = [...document.querySelectorAll(".run-item-task")].map((el) => el.textContent);
    expect(tasks.some((t) => t?.includes("AGS"))).toBe(false);
    expect(tasks.some((t) => t?.includes("幻灯"))).toBe(true);
  });

  it("办公新建载荷带 workspace=office", () => {
    expect(buildNewRunRequest({ task: "做幻灯", mode: "design", workspace: "office" })).toMatchObject({
      mode: "design",
      workspace: "office",
    });
    expect(CODE_STARTER_JOBS.map((j) => j.label)).toEqual([
      "从计划开始",
      "看看这个仓库",
      "修一处并跑通测试",
    ]);
  });

  it("侧栏骨架：列表前没有第三颗满宽标签钮；会话 meta 默认不占行", () => {
    const html = readFileSync(join(UI_DIR, "index.html"), "utf-8");
    const css = readFileSync(join(UI_DIR, "styles.css"), "utf-8");
    const searchEnd = html.indexOf('id="run-list"');
    const chrome = html.slice(html.indexOf('id="sidebar"'), searchEnd);
    expect(chrome).toContain('id="workspace-face"');
    expect(chrome).toContain("sidebar-top-tools");
    expect(chrome).toContain('id="notifications-btn"');
    expect(chrome).toContain('id="theme-toggle"');
    expect(chrome).toMatch(/id="workspace-face-office"[^>]*>Work</);
    expect(chrome).toMatch(/id="workspace-face-code"[^>]*>Code</);
    expect(chrome).toContain('id="new-chat-btn"');
    expect(chrome).not.toContain("<span>指挥中心</span>");
    expect(chrome).not.toContain("<span>定时任务</span>");
    expect(css).toContain(".starter-tiles--jobs .starter-tile-hint {\n  display: block;");
    expect(css).toMatch(/\.run-item-status,\s*\.run-item-meta,\s*\.run-item-recap \{\s*display: none;/);
  });
});

describe("侧栏标题优先用服务端存的短句", () => {
  it("deriveThreadTitle 认 title 字段，不再铺整段任务", () => {
    const runs = [{ runId: "r1", task: "请帮我把这段很长的需求写成可扫视的标题", title: "需求标题" }];
    expect(deriveThreadTitle(runs, "r1")).toBe("需求标题");
  });

  it("模型把「设计标题」收成方案名时，侧栏退回用户原话", () => {
    const task = "附件：uploads/pasted-1.png\n我想给我们的仓库的ui设计一个好看的标题 你有什么好的方案吗";
    expect(titleReflectsTask("流光·智能仓储中枢", task)).toBe(false);
    expect(resolveDisplayedTitle("“流光·智能仓储中枢”", task)).toBe(deriveRunTitle(task));
    expect(deriveThreadTitle([{ runId: "r1", task, title: "“流光·智能仓储中枢”" }], "r1")).toBe(deriveRunTitle(task));
  });
});

describe("追加模式显示该对话的工作目录", () => {
  it("切对话只展示该会话路径且不可改；回到新建才解锁", () => {
    const select = document.getElementById("workdir-select") as HTMLSelectElement;
    const trigger = document.getElementById("workdir-trigger") as HTMLButtonElement;
    const field = document.getElementById("workdir-combobox") as HTMLElement;
    const form = document.getElementById("submit-form") as HTMLFormElement;
    select.innerHTML = "";
    for (const dir of ["D:\\first", "D:\\other"]) {
      const opt = document.createElement("option");
      opt.value = dir;
      opt.textContent = dir;
      select.appendChild(opt);
    }
    select.value = "D:\\first";
    const onB = deriveComposerMode({
      info: { runId: "run-b", status: "done", canContinue: true, workdir: "D:\\other" },
      localStatus: "done",
    });
    expect(onB.workdirLocked).toBe(true);
    expect(onB.workdir).toBe("D:\\other");
    patchComposer(onB);
    expect(select.value).toBe("D:\\other");
    expect(trigger.disabled).toBe(true);
    expect(field.classList.contains("scope-field--locked")).toBe(true);
    expect(form.dataset.workdirRun).toBe("run-b");

    patchComposer(deriveComposerMode({
      info: { runId: "run-a", status: "done", canContinue: true, workdir: "D:\\first" },
      localStatus: "done",
    }));
    expect(select.value).toBe("D:\\first");
    expect(form.dataset.workdirRun).toBe("run-a");
    expect(trigger.disabled).toBe(true);

    const fresh = deriveComposerMode({ info: null, workdir: "D:\\first" });
    expect(fresh.workdirLocked).toBe(false);
    patchComposer(fresh);
    expect(form.dataset.workdirRun).toBeUndefined();
    expect(trigger.disabled).toBe(false);
    expect(field.classList.contains("scope-field--locked")).toBe(false);
  });
});

describe("侧栏工作目录分组可收起", () => {
  it("收起后条目隐藏，状态写进 localStorage", () => {
    const storage = {
      _m: new Map(),
      getItem(k) { return this._m.get(k) ?? null; },
      setItem(k, v) { this._m.set(k, String(v)); },
    };
    const key = "D:\\proj";
    expect(readCollapsedWorkdirGroups(storage).has(key)).toBe(false);
    toggleCollapsedWorkdirGroup(key, storage);
    expect(readCollapsedWorkdirGroups(storage).has(key)).toBe(true);
    expect(JSON.parse(storage.getItem(WORKDIR_GROUP_COLLAPSE_KEY))).toContain(key);

    const runs = [
      { runId: "r1", task: "a", status: "done", verify: false, workdir: key },
      { runId: "r2", task: "b", status: "done", verify: false, workdir: "D:\\other" },
    ];
    renderRunList(runs, "r1", () => {}, new Map(), undefined, {
      collapsed: new Set([key]),
      onToggle: () => {},
    });
    const group = [...document.querySelectorAll(".run-group")].find(
      (g) => g.getAttribute("aria-label")?.includes("proj") || g.querySelector(".run-group-name")?.textContent?.includes("proj"),
    );
    expect(group?.classList.contains("run-group--collapsed")).toBe(true);
    expect(group?.querySelector(".run-group-caret")?.className).toContain("ph-caret-right");
  });
});


/**
 * §直播条 · 滑动窗口换算（2026-08-15 委托方实测缺陷）。
 *
 * 现象：Web UI 里思考流到**约 2000 字就停住**，要过好一会才整块出现。
 *
 * 根因是绝对计数去 slice 一个滑动窗口：`revealed` 单调增长，而直播缓冲
 * 有上限（LIVE_TEXT_CAP=2000）且只留尾部。撞上限那刻——
 *   ① 旧代码的 `arrived` 取自缓冲长度 → 被钉死在 2000，不再增长；
 *   ② 于是 `revealed` 也不再变化，节拍器的 `changed` 恒为 false；
 *   ③ **再也不重绘**，屏幕冻在那一帧，直到本轮结束、turn 级
 *      `assistant_thinking` 走正常 reducer 整块到达——正是"过一会才显示"。
 *
 * 这段逻辑原来住在 `index.html`，**没有任何测试够得着**——本仓库那条
 * "核心可测、壳不可测的分界线就是缺陷分布线"的活标本。挪进 app.js 是
 * 结构性修复，下面这组锁才有地方立。
 */
describe("revealedWindow：绝对放行计数 → 滑动窗口内的偏移", () => {
  const CAP = 2000;

  it("没到上限时就是原样放行（缓冲=全部，没有丢弃）", () => {
    expect(revealedWindow({ revealed: 300, precedingTotal: 0, total: 500, bufferLength: 500 })).toBe(300);
    expect(revealedWindow({ revealed: 500, precedingTotal: 0, total: 500, bufferLength: 500 })).toBe(500);
  });

  /** 这一条就是那个 bug：撞上限之后，追平的过程必须还能推进 */
  it("超过上限后 revealed 前进则可见位置前进——旧实现在这里冻住", () => {
    const at = (revealed: number) =>
      revealedWindow({ revealed, precedingTotal: 0, total: 5000, bufferLength: CAP });
    expect(at(4900)).toBe(1900); // 丢弃 5000-2000=3000；4900-3000
    expect(at(4950)).toBe(1950);
    expect(at(4950), "同一累计下 revealed 走一步，屏幕就得走一步").toBeGreaterThan(at(4900));
  });

  /**
   * 滞后量相同时窗口位置相同——这不是 bug 而是正确性质：内容在滑，
   * 位置不动照样看到新尾巴。真正修掉冻结的是"累计不再被上限钉死"，
   * 由下面那条逐批流入的锁负责。
   */
  it("累计与 revealed 同步增长时位置稳定（内容在滑，不靠位置动）", () => {
    const a = revealedWindow({ revealed: 4900, precedingTotal: 0, total: 5000, bufferLength: CAP });
    const b = revealedWindow({ revealed: 4950, precedingTotal: 0, total: 5050, bufferLength: CAP });
    expect(b).toBe(a);
  });

  it("追平时正好落在窗口末尾，不越界", () => {
    expect(revealedWindow({ revealed: 5000, precedingTotal: 0, total: 5000, bufferLength: CAP })).toBe(CAP);
    // 即使 revealed 因为舍入跑过头也夹在窗口内
    expect(revealedWindow({ revealed: 9999, precedingTotal: 0, total: 5000, bufferLength: CAP })).toBe(CAP);
  });

  it("正文的额度扣掉思考已占的（思考在前、正文在后）", () => {
    // 思考累计 800，正文刚到 100，全局放行 850 → 正文该显示 50
    expect(revealedWindow({ revealed: 850, precedingTotal: 800, total: 100, bufferLength: 100 })).toBe(50);
    // 全局还没走完思考那段，正文一个字都不该露
    expect(revealedWindow({ revealed: 700, precedingTotal: 800, total: 100, bufferLength: 100 })).toBe(0);
  });

  it("永不返回负数或超过缓冲长度（下游直接拿去 slice）", () => {
    for (const m of [
      { revealed: 0, precedingTotal: 999, total: 10, bufferLength: 10 },
      { revealed: -5, precedingTotal: 0, total: 0, bufferLength: 0 },
      { revealed: 1e9, precedingTotal: 0, total: 1e9, bufferLength: 50 },
    ]) {
      const n = revealedWindow(m);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(m.bufferLength);
    }
  });

  /**
   * 端到端的形态复现：模拟一段 5000 字的思考按 250 字一批流进来，
   * 缓冲按 2000 截尾。**每一批之后可见位置都必须前进**——只要有一批不动，
   * 就是那个"冻住"的形态回来了。
   */
  it("逐批流入 5000 字：可见位置每批都前进，一次都不冻", () => {
    let total = 0;
    let buffer = "";
    let lastVisibleTail = "";
    const positions: number[] = [];
    for (let i = 0; i < 20; i++) {
      const chunk = "想".repeat(250);
      total += chunk.length;
      buffer = (buffer + chunk).slice(-CAP);
      // 节拍器追平后的稳态：revealed == arrived == total
      const n = revealedWindow({ revealed: total, precedingTotal: 0, total, bufferLength: buffer.length });
      positions.push(total);
      const tail = buffer.slice(0, n).slice(-80);
      expect(tail.length, `第 ${i + 1} 批尾部不该为空`).toBeGreaterThan(0);
      lastVisibleTail = tail;
    }
    expect(lastVisibleTail.length).toBe(80);
    // 累计单调递增：旧实现里这个数会在 2000 处永久钉死
    expect(positions.at(-1)).toBe(5000);
    expect(positions.every((p, i) => i === 0 || p > positions[i - 1]!)).toBe(true);
  });
});

describe("AGENT.md 上下文卡（docs/09 §4.7 host-lags）", () => {
  it("加载了文件时 Context 卡写明指导不是执行", () => {
    let s = createInitialState("run-md", "t", false);
    s = reduceEvents(s, [
      sse(0, "host", "run_config", {
        agentMd: {
          files: [{ path: "D:/proj/AGENT.md", layer: "project", chars: 80, truncated: false }],
          chars: 80,
          truncated: false,
          maxChars: 16000,
          guidance: true,
        },
      }),
    ]);
    const cards = buildFactorCards({
      loop: deriveLoopFace(s, null),
      context: deriveContextFace(s, null),
      tools: deriveToolsFace(s, null),
      verification: deriveVerificationFace(s, null),
    });
    const ctx = cards.find((c) => c.id === "context");
    expect(ctx.lines.some((l) => /AGENT\.md/.test(l) && /指导不是执行/.test(l))).toBe(true);
  });
});

describe("hooks 日志渲染（docs/09 §4.2 host-lags）", () => {
  it("hook 阻断在日志里可见，不是静默丢弃", () => {
    let s = createInitialState("run-hook", "t", false);
    s = reduceEvents(s, [
      sse(0, "host", "run_config", { hooks: { timeoutMs: 5000, events: ["PreToolUse", "PostToolUse", "Stop"] } }),
      sse(1, "main", "hook", {
        hook: "PreToolUse",
        outcome: "block",
        tool: "bash",
        detail: "no network",
      }),
    ]);
    renderRunDetail(s, { activeTab: "log" });
    const row = document.querySelector(".log-entries .log-entry--warning");
    expect(row?.textContent).toMatch(/PreToolUse/);
    expect(row?.textContent).toMatch(/阻断|no network/);
  });
});

describe("对话消息操作条（复制 / 分叉 / 时间）", () => {
  it("已落定用户与助手气泡带 Copy/Fork 和时间，直播条没有", () => {
    const now = Date.now();
    const userHtml = renderChatItem({
      kind: "user",
      runId: "run-act",
      text: "帮我改标题",
      seq: 2,
      at: now - 4 * 60_000,
      showActions: true,
    });
    expect(userHtml).toContain("data-chat-action=\"copy\"");
    expect(userHtml).toContain("data-chat-action=\"rewind\"");
    expect(userHtml).toContain("data-chat-action=\"fork\"");
    expect(userHtml).toContain("ph-clock-counter-clockwise");
    expect(userHtml).toContain("ph-git-fork");
    expect(userHtml).toContain("4m ago");
    expect(userHtml).not.toContain("data-chat-action=\"up\"");

    const asstHtml = renderChatItem({
      kind: "text",
      runId: "run-act",
      text: "已改好",
      seq: 5,
      at: now - 4 * 60_000,
      showActions: true,
    });
    expect(asstHtml).toContain('data-chat-action="copy"');
    expect(asstHtml).toContain('data-chat-action="rewind"');
    expect(asstHtml).toContain("data-chat-action=\"fork\"");
    expect(asstHtml).toContain("data-chat-action=\"up\"");
    expect(asstHtml).toContain("data-chat-action=\"down\"");
    expect(asstHtml).toContain("4m ago");

    const midHtml = renderChatItem({
      kind: "text",
      runId: "run-act",
      text: "先 mkdir",
      seq: 3,
    });
    expect(midHtml).not.toContain("chat-msg-actions");

    const liveHtml = renderChatItem({ kind: "live", text: "正在写", thinking: "" });
    expect(liveHtml).not.toContain("chat-msg-actions");
    expect(liveHtml).not.toContain("data-chat-action");
  });

  it("操作条只挂在已收官的一轮：中间进度句和进行中没有", () => {
    let s = createInitialState("run-mid", "抓四个站点", false);
    s = reduceEvents(s, [
      { seq: 0, source: "main", ts: 1, event: { type: "assistant_text", text: "先 mkdir" } },
      { seq: 1, source: "main", ts: 2, event: { type: "tool_call", name: "bash", toolUseId: "t1", input: { command: "mkdir raw" } } },
      { seq: 2, source: "main", ts: 3, event: { type: "tool_result", toolUseId: "t1", result: { content: "ok" }, durationMs: 1 } },
      { seq: 3, source: "main", ts: 4, event: { type: "assistant_text", text: "再 curl 四个站点" } },
    ]);
    const live = deriveChatItems(s, { text: "还在写", thinking: "" }, { showProcess: true });
    expect(live.some((it) => it.showActions)).toBe(false);

    const done = deriveChatItems({ ...s, status: "done" }, null, { showProcess: true });
    const flagged = done.filter((it) => it.showActions);
    expect(flagged.some((it) => it.kind === "user" && it.seq === -1)).toBe(true);
    expect(flagged.filter((it) => it.kind === "text")).toHaveLength(1);
    expect(flagged.find((it) => it.kind === "text")?.text).toContain("再 curl");
    expect(done.some((it) => it.kind === "text" && String(it.text).includes("mkdir") && it.showActions)).toBe(false);

    const marked = markSettledTurnActions([
      { kind: "user", text: "问", seq: -1 },
      { kind: "text", text: "中间句", seq: 1, role: "main" },
      { kind: "text", text: "收官句", seq: 2, role: "main" },
    ], false);
    expect(marked[1].showActions).toBe(false);
    expect(marked[2].showActions).toBe(true);
  });

  it("formatChatRelTime 对齐截图口径", () => {
    const now = 1_000_000;
    expect(formatChatRelTime(now - 10_000, now)).toBe("刚刚");
    expect(formatChatRelTime(now - 4 * 60_000, now)).toBe("4m ago");
    expect(formatChatRelTime(now - 3 * 3_600_000, now)).toBe("3h ago");
  });

  it("reducer 把信封 ts 投到 user_message / assistant_text，开场任务取较早时刻", () => {
    const created = 1_700_000_000_000;
    let s = createInitialState("run-at", "开场任务", false, { createdAt: created });
    s = reduceEvents(s, [
      { seq: 0, source: "main", ts: created + 8_000, event: { type: "assistant_text", text: "好" } },
      { seq: 1, source: "host", ts: created + 60_000, event: { type: "user_message", text: "再改", turn: 2 } },
    ]);
    const asst = s.timeline.find((e) => e.type === "assistant_text");
    const user = s.timeline.find((e) => e.type === "user_message");
    expect(asst?.at).toBe(created + 8_000);
    expect(user?.at).toBe(created + 60_000);
    expect(pickTaskAt(s)).toBe(created);

    const items = deriveChatItems(s, null);
    const first = items.find((it) => it.kind === "user" && it.seq === -1);
    const follow = items.find((it) => it.kind === "user" && it.seq === 1);
    const reply = items.find((it) => it.kind === "text");
    expect(first?.at).toBe(created);
    expect(follow?.at).toBe(created + 60_000);
    expect(reply?.at).toBe(created + 8_000);
  });

  it("复制走回调；赞踩本地切换", () => {
    const copied = [];
    let s = createInitialState("run-copy", "记住暗号", false, { createdAt: Date.now() - 120_000 });
    s = reduceEvents(s, [
      { seq: 0, source: "main", ts: Date.now() - 90_000, event: { type: "assistant_text", text: "暗号是蓝鸟" } },
    ]);
    s = { ...s, status: "done" };
    renderRunDetail(s, { onCopyChat: (text) => copied.push(text) });
    const copyBtn = document.querySelector(".chat-msg--assistant + .chat-msg-actions [data-chat-action=copy]");
    expect(copyBtn).toBeTruthy();
    copyBtn.click();
    expect(copied[0]).toContain("暗号是蓝鸟");

    expect(chatPlainText({ kind: "text", text: "暗号是蓝鸟" })).toBe("暗号是蓝鸟");
    const storage = window.localStorage;
    storage.clear();
    expect(writeChatRating("run-copy", 0, "up", storage)).toBe("up");
    expect(readChatRating("run-copy", 0, storage)).toBe("up");
    expect(writeChatRating("run-copy", 0, "up", storage)).toBe("up");
    expect(writeChatRating("run-copy", 0, "down", storage)).toBe("down");
    expect(readChatRating("run-copy", 0, storage)).toBe("down");

    const keep = buildChatFeedbackMessage("up", "暗号是蓝鸟");
    const fix = buildChatFeedbackMessage("down", "暗号是蓝鸟");
    expect(keep).toContain("【反馈】");
    expect(keep).toContain("继续保持");
    expect(keep).toContain("暗号是蓝鸟");
    expect(fix).toContain("重新调整");
    expect(looksLikeChatFeedback(keep)).toBe(true);
    expect(looksLikeChatFeedback("普通追问")).toBe(false);
    expect(renderChatItem({ kind: "user", text: keep, seq: 9, showActions: true })).toContain("反馈");
  });

  it("赞踩把反馈交给回调，同一侧再点不重发", () => {
    const rated = [];
    let s = createInitialState("run-rate", "做一版标题", false);
    s = reduceEvents(s, [
      { seq: 0, source: "main", ts: Date.now() - 90_000, event: { type: "assistant_text", text: "标题用深蓝" } },
    ]);
    s = { ...s, status: "done" };
    window.localStorage.clear();
    renderRunDetail(s, {
      onRateChat: (runId, seq, rating, excerpt) => rated.push({ runId, seq, rating, excerpt }),
    });
    const up = document.querySelector("[data-chat-action=up]");
    expect(up).toBeTruthy();
    up.click();
    up.click();
    expect(rated).toHaveLength(1);
    expect(rated[0].rating).toBe("up");
    expect(rated[0].excerpt).toContain("标题用深蓝");
    document.querySelector("[data-chat-action=down]").click();
    expect(rated).toHaveLength(2);
    expect(rated[1].rating).toBe("down");
  });
});

describe("并行子代理收进主对话卡片", () => {
  it("childAgentKey 认 spawn 与编排子任务，不认 main/planner", () => {
    expect(childAgentKey("spawn/查寄存器")).toBe("spawn/查寄存器");
    expect(childAgentKey("s1/main")).toBe("s1");
    expect(childAgentKey("s1/verifier")).toBe("s1");
    expect(isChildAgentSource("main")).toBe(false);
    expect(isChildAgentSource("planner")).toBe(false);
    expect(isChildAgentSource("s1/main")).toBe(true);
  });

  it("计划节点开工后从等待翻成工作中，收工后才是已完成", () => {
    let s = createInitialState("run-plan-agents", "做记分卡", false);
    s = {
      ...s,
      plan: {
        subtasks: [
          { id: "s1", title: "探查数据源", dependsOn: [], acceptance: [], description: "", pack: null },
          { id: "s2", title: "做仪表盘", dependsOn: ["s1"], acceptance: [], description: "", pack: "design" },
        ],
      },
    };
    s = reduceEvents(s, [
      sse(0, "s1/main", "assistant_thinking", { text: "先找表格" }),
      sse(1, "s1/main", "tool_call", { toolUseId: "t", name: "read_file", input: { path: "a.xlsx" } }),
    ]);
    let agents = deriveChildAgents(s);
    expect(agents.find((a) => a.id === "s1")?.status).toBe("running");
    expect(agents.find((a) => a.id === "s2")).toBeUndefined();
    const card = deriveChatItems(s).find((i) => i.kind === "agents");
    expect(renderChatItem(card)).toContain("chat-agent--running");
    expect(renderChatItem(card)).toContain("chat-agents--busy");

    s = reduceEvents(s, [
      sse(2, "host", "plan_result", {
        steps: [{ id: "s1", passed: true, durationMs: 12 }],
        skipped: [],
        completed: true,
      }),
    ]);
    agents = deriveChildAgents({ ...s, status: "done" });
    expect(agents.find((a) => a.id === "s1")?.status).toBe("done");
  });

  it("收官或追问后编排计划和子代理收成一行，续跑谱系不重贴", () => {
    const planEvent = sse(0, "host", "plan", {
      concurrency: 1,
      subtasks: [
        { id: "s1", title: "探查", dependsOn: [], acceptance: [], description: "", pack: null },
        { id: "s2", title: "仪表盘", dependsOn: ["s1"], acceptance: [], description: "", pack: "design" },
      ],
    });
    let live = createInitialState("run-chrome", "做记分卡", false);
    live = reduceEvents(live, [
      planEvent,
      sse(1, "s1/main", "assistant_thinking", { text: "先读表" }),
    ]);
    const liveItems = deriveChatItems(live);
    expect(liveItems.filter((i) => i.kind === "plan")).toHaveLength(1);
    expect(liveItems.find((i) => i.kind === "plan")?.folded).toBe(false);
    expect(liveItems.find((i) => i.kind === "agents")?.folded).toBe(false);

    let done = reduceEvents(live, [
      sse(2, "host", "plan_result", {
        steps: [
          { id: "s1", passed: true, durationMs: 1 },
          { id: "s2", passed: true, durationMs: 1 },
        ],
        skipped: [],
        completed: true,
      }),
    ]);
    done = { ...done, status: "done", runId: "parent-chrome" };
    const doneItems = deriveChatItems(done);
    expect(doneItems.filter((i) => i.kind === "plan")).toHaveLength(1);
    expect(doneItems.find((i) => i.kind === "plan")?.folded).toBe(true);
    expect(doneItems.find((i) => i.kind === "agents")?.folded).toBe(true);
    const foldedHtml = renderChatItem(doneItems.find((i) => i.kind === "plan"));
    expect(foldedHtml).toContain("chat-chrome-fold");
    expect(foldedHtml).toContain("编排计划 · 2 步");
    expect(foldedHtml).not.toMatch(/<details[^>]*open/);

    const follow = deriveChatItems(reduceEvents(done, [
      sse(3, "host", "user_message", { turn: 2, text: "再改配色" }),
    ]));
    expect(follow.filter((i) => i.kind === "plan")).toHaveLength(1);
    expect(follow.filter((i) => i.kind === "agents")).toHaveLength(1);
    expect(follow.find((i) => i.kind === "plan")?.folded).toBe(true);
    expect(follow.findIndex((i) => i.kind === "plan"))
      .toBeLessThan(follow.findIndex((i) => i.kind === "user" && i.text === "再改配色"));

    let child = createInitialState("child-chrome", "做记分卡", false);
    child = reduceEvents(child, [
      sse(0, "host", "run_forked", { parentRunId: "parent-chrome", priorRecap: "记分卡已交付", priorTurns: 1 }),
      sse(1, "host", "plan", {
        concurrency: 1,
        subtasks: [{ id: "s1", title: "探查", dependsOn: [], acceptance: [], description: "", pack: null }],
      }),
      sse(2, "host", "user_message", { turn: 2, text: "再改配色" }),
    ]);
    const thread = deriveThreadChatItems(
      [
        { runId: "parent-chrome", continuedFrom: null },
        { runId: "child-chrome", continuedFrom: "parent-chrome" },
      ],
      new Map([["parent-chrome", done], ["child-chrome", child]]),
      "child-chrome",
      null,
    );
    expect(thread.filter((i) => i.kind === "plan")).toHaveLength(1);
    expect(thread.filter((i) => i.kind === "agents")).toHaveLength(1);
  });

  it("同一段收官正文和产物在谱系克隆里只留一份", () => {
    const summary = "已生成单文件自包含的 OKR 记分卡仪表盘 okr-scorecard.html。";
    const completion = {
      status: "completed",
      summary,
      artifacts: ["okr-scorecard.html"],
      verification: ["页面可打开"],
      assumptions: ["示例数据"],
      blockers: [],
    };
    const clone = (runId) => {
      let s = createInitialState(runId, "做一张团队 OKR 记分卡", false);
      s = reduceEvents(s, [
        sse(0, "main", "assistant_thinking", { text: "先写页面" }),
        sse(1, "main", "assistant_text", { text: summary }),
        sse(2, "main", "tool_call", { toolUseId: "w", name: "write_file", input: { path: "okr-scorecard.html" } }),
        sse(3, "main", "tool_result", { toolUseId: "w", result: { content: "ok", isError: false } }),
        sse(4, "main", "done", {
          stopReason: "completed",
          usage: { inputTokens: 1, outputTokens: 1, turns: 1, cacheHitRatio: 0 },
          completion,
        }),
      ]);
      return { ...s, status: "done", runId };
    };
    const parent = clone("okr-root");
    const ghost = clone("okr-ghost");
    const doubled = reduceEvents(parent, [
      sse(5, "main", "assistant_text", { text: summary }),
    ]);
    const single = deriveChatItems({ ...doubled, status: "done" }, null, { showProcess: "on" });
    expect(single.filter((i) => i.kind === "text")).toHaveLength(1);
    expect(single.find((i) => i.kind === "text")?.fromCompletion).toBe(true);
    expect(single.filter((i) => i.kind === "artifacts")).toHaveLength(1);

    const thread = deriveThreadChatItems(
      [
        { runId: "okr-root", continuedFrom: null },
        { runId: "okr-ghost", continuedFrom: "okr-root" },
      ],
      new Map([["okr-root", parent], ["okr-ghost", ghost]]),
      "okr-ghost",
      null,
    );
    expect(thread.filter((i) => i.kind === "text" && String(i.text).includes("OKR 记分卡"))).toHaveLength(1);
    expect(thread.filter((i) => i.kind === "artifacts")).toHaveLength(1);
    expect(thread.filter((i) => i.kind === "thinking")).toHaveLength(1);
    expect(chatRepeatKey({ kind: "text", text: "  a\n a " })).toBe(chatRepeatKey({ kind: "text", text: "a a" }));
    expect(collapseRepeatChatItems([
      { kind: "text", text: summary },
      { kind: "text", text: summary, fromCompletion: true, verification: ["页面可打开"] },
    ]).map((i) => i.fromCompletion)).toEqual([true]);
  });

  it("直播增量认执行者（含 s1/main、spawn），不认规划者/核查者", () => {
    expect(isLiveDeltaSource("main")).toBe(true);
    expect(isLiveDeltaSource("rework")).toBe(true);
    expect(isLiveDeltaSource("s1/main")).toBe(true);
    expect(isLiveDeltaSource("spawn/查竞品")).toBe(true);
    expect(isLiveDeltaSource("planner")).toBe(false);
    expect(isLiveDeltaSource("verifier")).toBe(false);
    expect(isLiveDeltaSource("s1/planner")).toBe(false);
    expect(isLiveDeltaSource("s1/verifier")).toBe(false);
  });

  it("主对话只留子代理卡，点开才看到支线正文；子审批不进主坞", () => {
    let s = createInitialState("run-spawn", "并行调研", false);
    s = reduceEvents(s, [
      sse(0, "host", "spawn_start", { title: "查竞品" }),
      sse(1, "spawn/查竞品", "assistant_text", { text: "我先打开官网" }),
      sse(2, "spawn/查竞品", "approval_request", {
        toolUseId: "tu_child",
        name: "bash",
        input: { command: "curl example.com" },
      }),
      sse(3, "s2/main", "assistant_text", { text: "另一条子任务在写稿" }),
    ]);
    const agents = deriveChildAgents(s);
    expect(agents.map((a) => a.id).sort()).toEqual(["s2", "spawn/查竞品"]);
    expect(agents.find((a) => a.id === "spawn/查竞品")?.pendingApprovals).toBe(1);

    const items = deriveChatItems(s, null);
    expect(items.some((it) => it.kind === "agents")).toBe(true);
    expect(items.some((it) => it.kind === "text" && String(it.text).includes("我先打开官网"))).toBe(false);
    expect(items.some((it) => it.kind === "text" && String(it.text).includes("另一条子任务在写稿"))).toBe(false);

    const child = deriveChatItems(s, null, { agentId: "spawn/查竞品" });
    expect(child.some((it) => it.kind === "text" && String(it.text).includes("我先打开官网"))).toBe(true);

    const action = deriveActionState(s);
    expect(action.pendingApprovals).toEqual([]);
    expect(action.childApprovalCount).toBe(1);
    expect(action.needsAttention).toBe(true);

    let opened = "";
    renderRunDetail(s, {
      activeTab: "loop",
      onOpenAgent: (id) => { opened = id; },
    });
    expect(document.querySelector(".approval-cards")?.hidden).toBe(true);
    expect(document.querySelector(".chat-agents")).toBeTruthy();
    expect(document.querySelector(".chat-agents--busy")).toBeTruthy();
    expect(document.querySelector(".chat-agent--running")).toBeTruthy();
    expect(document.body.textContent).toContain("子代理");
    expect(document.body.textContent).toContain("需批准");
    document.querySelector("[data-agent-id='spawn/查竞品']").click();
    expect(opened).toBe("spawn/查竞品");

    renderRunDetail(s, { activeTab: "loop", selectedAgentId: "spawn/查竞品" });
    const overlay = document.getElementById("agent-overlay");
    expect(overlay?.hidden).toBe(false);
    expect(overlay?.textContent).toContain("我先打开官网");
    expect(overlay?.textContent).toContain("允许");
    expect(overlay?.textContent).not.toContain("允许本次");
    expect(overlay?.textContent).toContain("要运行：curl example.com");
    expect(overlay?.querySelector(".approval-details")).toBeTruthy();
  });
});

describe("对话回退（回到这里）", () => {
  it("回退对话框问要不要改动也一起退", () => {
    const html = rewindDialogHtml({
      restorable: [{ path: "okr.html", toolUseId: "w1" }],
      unrestorable: [],
    });
    expect(html).toContain("回到这里？");
    expect(html).toContain("之后的回复不会带进新对话");
    expect(html).toContain("要不要改动也一起退");
    expect(html).toContain("只退对话");
    expect(html).toContain("对话和改动一起退");
    expect(html).toContain('data-rewind-choice="chat"');
    expect(html).toContain('data-rewind-choice="files"');
    expect(html).toContain("记下了 1 个文件");
  });

  it("file_rewind_snapshot 进状态，预览只数裁点之后的快照", () => {
    let s = createInitialState("run-rw", "写两版", false);
    s = reduceEvents(s, [
      sse(0, "main", "assistant_text", { text: "第一轮" }),
      sse(1, "host", "file_rewind_snapshot", {
        toolUseId: "w1", tool: "write_file", path: "a.txt", existed: false, bytes: 0,
      }),
      sse(2, "main", "tool_call", { toolUseId: "w1", name: "write_file", input: { path: "a.txt" } }),
      sse(3, "main", "assistant_text", { text: "第二轮" }),
      sse(4, "host", "file_rewind_snapshot", {
        toolUseId: "w2", tool: "write_file", path: "a.txt", existed: true, bytes: 4,
      }),
      sse(5, "main", "tool_call", { toolUseId: "w2", name: "write_file", input: { path: "a.txt" } }),
    ]);
    expect(s.fileRewindSnapshots).toHaveLength(2);
    const preview = deriveRewindFilePreview(s, 0);
    expect(preview.restorable.map((r) => r.toolUseId)).toEqual(["w1", "w2"]);
    expect(deriveRewindFilePreview(s, 3).restorable.map((r) => r.toolUseId)).toEqual(["w2"]);
  });

  it("谱系拼聊天在回退快照处截断，不把父 run 后半段贴回来", () => {
    let parent = createInitialState("rw-parent", "做记分卡", false);
    parent = reduceEvents(parent, [
      sse(0, "main", "assistant_text", { text: "先出一版" }),
      sse(1, "host", "user_message", { turn: 2, text: "再改配色" }),
      sse(2, "main", "assistant_text", { text: "配色改完了" }),
    ]);
    parent = { ...parent, status: "done", runId: "rw-parent" };

    let child = createInitialState("rw-child", "做记分卡", false);
    child = reduceEvents(child, [
      sse(0, "main", "assistant_text", { text: "先出一版" }),
      sse(1, "host", "conversation_rewound", { parentRunId: "rw-parent", seq: 0, revertFiles: false }),
    ]);
    child = { ...child, status: "done", runId: "rw-child" };

    const runs = [
      { runId: "rw-parent", continuedFrom: null },
      { runId: "rw-child", continuedFrom: "rw-parent", rewindFrom: { parentRunId: "rw-parent", seq: 0, revertFiles: false } },
    ];
    expect(ancestorRunIdsForChat(runs, "rw-child")).toEqual(["rw-child"]);
    const thread = deriveThreadChatItems(
      runs,
      new Map([["rw-parent", parent], ["rw-child", child]]),
      "rw-child",
      null,
    );
    expect(thread.some((i) => i.kind === "text" && i.text === "先出一版")).toBe(true);
    expect(thread.some((i) => i.kind === "text" && i.text === "配色改完了")).toBe(false);
    expect(thread.some((i) => i.kind === "user" && i.text === "再改配色")).toBe(false);
  });
});

describe("persona-ux 文案锁（#4/#5/#6/#9/#10/#25）", () => {
  it("批准卡说要改哪个文件，按钮是允许/拒绝，JSON 在详情里", () => {
    expect(describeApprovalAction("write_file", { path: "hello-verify-ask.txt", content: "ping\n" }))
      .toBe("要新建或改 hello-verify-ask.txt，写入「ping」");
    expect(describeApprovalAction("mcp__fs__write_file", { path: "notes/a.md" }))
      .toBe("要新建或改 a.md");
    renderRunDetail(stateWithPendingApproval(), { activeTab: "loop" });
    const card = document.querySelector(".approval-card")!;
    expect(card.querySelector(".approval-summary")?.textContent).toBe("要新建或改 a.txt");
    expect(card.querySelector(".approval-tool-name")?.textContent).toBe("要新建或改 a.txt");
    expect(card.textContent).not.toMatch(/write_file\s*\{/);
    expect(card.querySelector("[data-action='allow']")?.textContent).toBe("允许");
    expect(card.querySelector("[data-action='deny']")?.textContent).toBe("拒绝");
    expect(card.querySelector(".approval-details summary")?.textContent).toBe("详情");
    expect(card.querySelector(".approval-input")?.textContent).toContain("a.txt");
  });

  it("收尾句：停就是停，完成就是完成，否决不是停止", () => {
    expect(runEndAnnouncement({ stopReason: "aborted", task: "写文件" })).toBe("已停止：写文件");
    expect(runEndAnnouncement({ stopReason: "completed", task: "写文件" })).toBe("运行已完成：写文件");
    expect(runEndAnnouncement({ stopReason: "plan_rejected", task: "拆计划" })).toBe("计划未获批准：拆计划");
    expect(runEndAnnouncement({ stopReason: "plan_gate_expired" })).toBe("计划门未应答");
    expect(runEndAnnouncement({ stopReason: "aborted" })).not.toContain("运行已完成");
    expect(runEndAnnouncement({ stopReason: "aborted" })).not.toContain("否决");
  });

  it("提交失败优先人话，不报 HTTP 和领域包", () => {
    expect(humanizeSubmitError({ error: "提交失败（HTTP 409）：不需要任何领域包" }, 409))
      .not.toMatch(/HTTP|领域包/);
    expect(humanizeSubmitError({}, 409)).toBe("这次发不出去，请换种说法再试。");
    expect(humanizeSubmitError({}, 429)).toBe("前面还有人在交，请等几秒。");
    expect(humanizeSubmitError({ error: "Mutation rate limit exceeded" }, 429))
      .toBe("前面还有人在交，请等几秒。");
    expect(humanizeSubmitError("工作目录不属于项目", 400)).toBe("工作目录不属于项目");
    expect(humanizeActionFailure("上传", 429, "Mutation rate limit exceeded"))
      .toBe("前面还有人在交，请等几秒。");
    expect(humanizeActionFailure("停止", 500, null)).not.toMatch(/HTTP/);
  });

  it("提问卡 / 计划卡不署剧名，只叫助手 / 计划", () => {
    expect(ROLE_PERSONA.planner).toBe("计划");
    expect(ROLE_PERSONA.main).toBe("助手");
    expect(ROLE_PERSONA.rework).toBe("助手");
    expect(Object.values(ROLE_PERSONA).join("")).not.toMatch(/计明远|施敢当|严不苟/);
  });
});

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startMockProvider } from "../eval/mock-provider.js";
import {
  BLANK_DESIGN_INDEX_HTML,
  DESIGN_CATALOG,
  DESIGN_CATALOG_IDS,
  DESIGN_PACK_LEGACY_HINT,
  DESIGN_TABS,
  classifyDesignDecision,
  designEntriesByTab,
  designPackLegacyHint,
  designRouterMenu,
  getDesignEntry,
  installedFilePacksFrom,
  isVagueDesignTask,
  detectSpecPlusDeck,
  matchExplicitDesign,
  parseDesignChoiceInput,
  publicDesignCatalog,
  resolveDesignModeIntent,
  routeDesignTask,
  seedForDesignId,
  seedsToCopy,
  shouldSeedDesignTemplate,
  shouldWriteBlankDesignIndex,
  writeBlankDesignIndex,
  writeDesignBundleHub,
} from "../src/design-mode.js";
import { getPack, PACKS, type DomainPack } from "../src/presets.js";
import { fakeMessage, textBlock, FakeModelClient } from "./helpers.js";

const CFG = { systemPrompt: "router", tools: [], workdir: process.cwd() };

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(AGENT_|ANTHROPIC_|OPENAI_)/.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

function spawnCli(
  args: string[],
  cwd: string,
  extra: Record<string, string>,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: childEnv(extra),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

describe("design catalog v1", () => {
  it("冻结 README 表（html-ppt-* 收成 html-ppt）+ 3d-object，共 21 条", () => {
    expect(DESIGN_CATALOG).toHaveLength(21);
    expect(DESIGN_CATALOG_IDS).toEqual([
      "web-prototype",
      "saas-landing",
      "dashboard",
      "mobile-app",
      "mobile-onboarding",
      "social-carousel",
      "email-marketing",
      "magazine-poster",
      "motion-frames",
      "sprite-animation",
      "pm-spec",
      "team-okrs",
      "eng-runbook",
      "finance-report",
      "hr-onboarding",
      "guizang-ppt",
      "html-ppt",
      "hyperframes",
      "critique",
      "tweaks",
      "3d-object",
    ]);
    expect(DESIGN_CATALOG_IDS.some((id) => id.startsWith("html-ppt-"))).toBe(false);
    expect(new Set(DESIGN_CATALOG_IDS).size).toBe(21);
  });

  it("每条含 id/tab/mode/title/description/pack/seed/export/capability，pack 恒为 design", () => {
    for (const e of DESIGN_CATALOG) {
      expect(e.pack).toBe("design");
      expect(DESIGN_TABS).toContain(e.tab);
      expect(e.export).toContain("html");
      expect(["ready", "missing"]).toContain(e.capability);
      expect(["blank", "landing-basic", "deck-basic", "social-basic", "pm-spec", "team-okrs"]).toContain(e.seed);
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.description.length).toBeGreaterThan(0);
    }
  });

  it("3d-object：Prototype / prototype / 三维对象 / blank / html / ready，source 写现产品页未列此 id", () => {
    const e = getDesignEntry("3d-object");
    expect(e).toMatchObject({
      id: "3d-object",
      tab: "Prototype",
      mode: "prototype",
      title: "三维对象",
      pack: "design",
      seed: "blank",
      capability: "ready",
    });
    expect(e!.export).toEqual(["html"]);
    expect(e!.description).toMatch(/WebGL/);
    expect(e!.source).toBe("现产品页未列此 id");
    expect(e!.title).not.toMatch(/Claude|Kimi|OpenDesign|Open Design/i);
    expect(designEntriesByTab("Prototype").some((x) => x.id === "3d-object")).toBe(true);
  });

  it("文案不用外部产品名", () => {
    const blob = publicDesignCatalog()
      .map((e) => `${e.title} ${e.description} ${e.source ?? ""}`)
      .join(" ");
    expect(blob).not.toMatch(/Claude Design|Kimi|OpenDesign|Open Design/i);
  });

  it("菜单按本仓库能力写：不承诺 15×36 主题，社媒/邮件标明预览", () => {
    const ppt = getDesignEntry("html-ppt");
    expect(ppt!.description).toMatch(/一套基础幻灯/);
    expect(ppt!.description).toMatch(/PPTX/);
    expect(ppt!.description).not.toMatch(/15/);
    expect(ppt!.description).not.toMatch(/36/);
    expect(getDesignEntry("guizang-ppt")!.description).toMatch(/PPTX/);
    expect(getDesignEntry("social-carousel")!.description).toMatch(/PNG/);
    expect(getDesignEntry("social-carousel")!.export).toContain("png");
    expect(getDesignEntry("magazine-poster")!.description).toMatch(/PNG/);
    expect(getDesignEntry("email-marketing")!.description).toMatch(/不接投放/);
    const blob = publicDesignCatalog().map((e) => e.description).join("\n");
    expect(blob).not.toMatch(/15\s*套/);
    expect(blob).not.toMatch(/36\s*主题/);
  });

  it("router 菜单 name=注册表 id，不把内置工程包编进去", () => {
    const menu = designRouterMenu();
    expect(menu.map((p) => p.name)).toEqual([...DESIGN_CATALOG_IDS]);
    expect(menu.some((p) => p.name === "design" || p.name === "ts-coding")).toBe(false);
  });

  it("已安装文件包按 allPacks 差集列出，不做描述启发式", () => {
    const extra: DomainPack = {
      name: "brand-kit",
      description: "自定义文件包",
      systemPrompt: "",
      verify: { enabled: false, mode: "rubric" },
    };
    const listed = installedFilePacksFrom([...Object.values(PACKS), extra]);
    expect(listed.map((p) => p.name)).toEqual(["brand-kit"]);
  });
});

describe("seed mapping", () => {
  it("saas-landing→landing-basic，幻灯→deck-basic，社媒/海报→social-basic，规格/OKR 有真种子，其余 blank", () => {
    expect(seedForDesignId("saas-landing")).toBe("landing-basic");
    expect(seedForDesignId("guizang-ppt")).toBe("deck-basic");
    expect(seedForDesignId("html-ppt")).toBe("deck-basic");
    expect(seedForDesignId("social-carousel")).toBe("social-basic");
    expect(seedForDesignId("magazine-poster")).toBe("social-basic");
    expect(seedForDesignId("pm-spec")).toBe("pm-spec");
    expect(seedForDesignId("team-okrs")).toBe("team-okrs");
    expect(seedForDesignId("web-prototype")).toBe("blank");
    expect(seedForDesignId("3d-object")).toBe("blank");
    expect(seedForDesignId("hyperframes")).toBe("blank");
    expect(seedForDesignId("unknown")).toBe("blank");
  });

  it("R1 且 seed≠blank 才调模板拷贝；R3 才写空白 index.html", () => {
    expect(
      shouldSeedDesignTemplate({
        kind: "r1",
        id: "saas-landing",
        reason: "x",
        seed: "landing-basic",
        pack: "design",
      }),
    ).toBe(true);
    expect(
      shouldSeedDesignTemplate({
        kind: "r1",
        id: "web-prototype",
        reason: "x",
        seed: "blank",
        pack: "design",
      }),
    ).toBe(false);
    expect(
      shouldWriteBlankDesignIndex({
        kind: "r3",
        id: null,
        reason: "x",
        seed: "blank",
        pack: "design",
      }),
    ).toBe(true);
    expect(
      shouldWriteBlankDesignIndex({
        kind: "r1",
        id: "web-prototype",
        reason: "x",
        seed: "blank",
        pack: "design",
      }),
    ).toBe(false);
  });
});

describe("R1/R2/R3", () => {
  it("R1：router 返回唯一合法 id → 后端包仍是 design，seed 按表", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock('{"pack":"saas-landing","reason":"落地页"}')], "end_turn"),
    ]);
    const route = await routeDesignTask({
      cfg: CFG,
      model,
      task: "做个带定价的产品介绍页",
    });
    expect(route).toMatchObject({
      kind: "r1",
      id: "saas-landing",
      pack: "design",
      seed: "landing-basic",
    });
    const prompt = JSON.stringify(model.requests[0]!.messages[0]!.content);
    expect(prompt).toContain("saas-landing:");
    expect(prompt).not.toContain("ts-coding:");
  });

  it("R2：空输入或「做个东西」不猜，不调用 router", async () => {
    expect(isVagueDesignTask("")).toBe(true);
    expect(isVagueDesignTask("做个东西")).toBe(true);
    expect(isVagueDesignTask("做个落地页")).toBe(false);
    const model = new FakeModelClient([]);
    const empty = await routeDesignTask({ cfg: CFG, model, task: "" });
    const vague = await routeDesignTask({ cfg: CFG, model, task: "做个东西" });
    expect(empty.kind).toBe("r2");
    expect(vague.kind).toBe("r2");
    expect(empty.pack).toBe("design");
    expect(model.requests).toHaveLength(0);
  });

  it("R2：router 返回 null", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock('{"pack":null,"reason":"拿不准"}')], "end_turn"),
    ]);
    const route = await routeDesignTask({ cfg: CFG, model, task: "弄好看一点" });
    expect(route.kind).toBe("r2");
    expect(route.id).toBeNull();
    expect(route.pack).toBe("design");
  });

  it("R3：解析失败 → fail-open design + 空白起步，不写 PPTX需后导出", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock("这个任务嘛我觉得挺复杂的")], "end_turn"),
    ]);
    const route = await routeDesignTask({ cfg: CFG, model, task: "随便做点设计" });
    expect(route.kind).toBe("r3");
    expect(route.pack).toBe("design");
    expect(route.seed).toBe("blank");
    expect(route.reason).not.toMatch(/PPTX需后导出|需后导出/);
    expect(classifyDesignDecision({ pack: null, reason: "router 输出无法解析，降级为默认配置（fail-open）" }).kind).toBe("r3");
  });

  it("R3：命中 capability missing（hyperframes）", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock('{"pack":"hyperframes","reason":"要视频"}')], "end_turn"),
    ]);
    const route = await routeDesignTask({ cfg: CFG, model, task: "做一段产品宣传片" });
    expect(route.kind).toBe("r3");
    expect(route.pack).toBe("design");
    expect(route.seed).toBe("blank");
    expect(route.reason).toMatch(/没有/);
    expect(route.reason).not.toMatch(/PPTX需后导出/);
  });

  /**
   * 现有 routeToPack 表达不了「一条描述命中 ≥2 类型」。
   * 不另写第二套分类器：若 router 给出某一个 id，按 R1 走；给 null 则 R2。
   */
  it("多制品描述：router 给出某一个 id 仍按 R1（不假装已实现多命中检测）", async () => {
    const model = new FakeModelClient([
      fakeMessage(
        [textBlock('{"pack":"saas-landing","reason":"先做落地页"}')],
        "end_turn",
      ),
    ]);
    const route = await routeDesignTask({
      cfg: CFG,
      model,
      task: "做个落地页加三页幻灯",
    });
    expect(route.kind).toBe("r1");
    expect(route.id).toBe("saas-landing");
    expect(route.bundle).toBeUndefined();
    expect(model.requests).toHaveLength(1);
  });

  it("命名路径规格+幻灯：不走 router，播种 pm-spec + deck-basic", async () => {
    expect(detectSpecPlusDeck("写一份产品规格，并做成三页汇报幻灯。")).toBe(true);
    expect(detectSpecPlusDeck("做个落地页加三页幻灯")).toBe(false);
    const model = new FakeModelClient([]);
    const route = await routeDesignTask({
      cfg: CFG,
      model,
      task: "写一份产品规格，并做成三页汇报幻灯。",
    });
    expect(route).toMatchObject({
      kind: "r1",
      id: "pm-spec",
      seed: "pm-spec",
      extraSeeds: ["deck-basic"],
      bundle: "spec-plus-deck",
      pack: "design",
    });
    expect(seedsToCopy(route)).toEqual(["pm-spec", "deck-basic"]);
    expect(shouldSeedDesignTemplate(route)).toBe(true);
    expect(model.requests).toHaveLength(0);

    const explicitSpec = await routeDesignTask({
      cfg: CFG,
      model,
      task: "写一份产品规格，并做成三页汇报幻灯。",
      explicitId: "pm-spec",
    });
    expect(explicitSpec.bundle).toBeUndefined();
    expect(explicitSpec.id).toBe("pm-spec");
    expect(explicitSpec.extraSeeds).toBeUndefined();
  });

  it("显式 spec-plus-deck / 模板名 pm-spec team-okrs", () => {
    expect(matchExplicitDesign({ explicitId: "spec-plus-deck" })).toMatchObject({
      kind: "bundle",
      bundle: "spec-plus-deck",
    });
    expect(matchExplicitDesign({ explicitTemplate: "pm-spec" })).toMatchObject({
      kind: "id",
      entry: { id: "pm-spec" },
    });
    expect(matchExplicitDesign({ explicitTemplate: "team-okrs" })).toMatchObject({
      kind: "id",
      entry: { id: "team-okrs" },
    });
    expect(parseDesignChoiceInput("spec-plus-deck")).toMatchObject({
      kind: "bundle",
      bundle: "spec-plus-deck",
    });
  });
});

describe("explicit beats auto", () => {
  it("显式 id / 模板名 / 页签优先于 router", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock('{"pack":"dashboard","reason":"不该走到这里"}')], "end_turn"),
    ]);
    const byId = await routeDesignTask({
      cfg: CFG,
      model,
      task: "做个落地页",
      explicitId: "html-ppt",
    });
    expect(byId).toMatchObject({ kind: "r1", id: "html-ppt", seed: "deck-basic", pack: "design" });
    expect(model.requests).toHaveLength(0);

    const byTpl = matchExplicitDesign({ explicitTemplate: "landing-basic" });
    expect(byTpl).toMatchObject({ kind: "id", entry: { id: "saas-landing" } });

    const byTab = await routeDesignTask({
      cfg: CFG,
      model,
      task: "做个东西",
      explicitTab: "Deck",
    });
    expect(byTab.kind).toBe("r2");
    expect(byTab.tab).toBe("Deck");

    const by3d = matchExplicitDesign({ task: "用 WebGL 做个三维物体" });
    expect(by3d).toMatchObject({ kind: "id", entry: { id: "3d-object" } });
    expect(parseDesignChoiceInput("2")).toMatchObject({ kind: "id", entry: { id: "saas-landing" } });
    expect(parseDesignChoiceInput("1", { tabHint: "Deck" })).toMatchObject({
      kind: "id",
      entry: { id: "guizang-ppt" },
    });
    expect(parseDesignChoiceInput("Deck")).toMatchObject({ kind: "tab", tab: "Deck" });
  });

  it("点选已安装文件包时后端包换成该文件包", async () => {
    const extra: DomainPack = {
      name: "brand-kit",
      description: "品牌包",
      systemPrompt: "",
      verify: { enabled: false, mode: "rubric" },
    };
    const route = await routeDesignTask({
      cfg: CFG,
      model: new FakeModelClient([]),
      task: "按品牌做",
      explicitFilePack: "brand-kit",
      installedFilePacks: [extra],
    });
    expect(route).toMatchObject({ kind: "r1", pack: "brand-kit", seed: "blank", id: null });
  });
});

describe("CLI env priority", () => {
  it("AGENT_MODE=design；AGENT_PACK 显式包优先；--plan 优先；旧入口不进门面", () => {
    expect(
      resolveDesignModeIntent({ plan: false, auto: false, agentMode: "design" }),
    ).toEqual({ action: "design" });
    expect(
      resolveDesignModeIntent({
        plan: false,
        auto: false,
        agentMode: "design",
        agentPack: "ts-coding",
      }),
    ).toEqual({ action: "explicit-pack", packName: "ts-coding" });
    expect(
      resolveDesignModeIntent({
        plan: true,
        auto: false,
        agentMode: "design",
        agentPack: "design",
      }),
    ).toEqual({ action: "plan" });
    // 旧入口：只设 AGENT_PACK=design，不进门面
    expect(
      resolveDesignModeIntent({ plan: false, auto: false, agentPack: "design" }),
    ).toEqual({ action: "explicit-pack", packName: "design" });
    expect(
      resolveDesignModeIntent({ plan: false, auto: true }),
    ).toEqual({ action: "auto" });
    expect(
      resolveDesignModeIntent({ plan: true, auto: false }),
    ).toEqual({ action: "plan" });
    expect(
      resolveDesignModeIntent({ plan: false, auto: false }),
    ).toEqual({ action: "none" });
  });

  it("P4：AGENT_PACK=design 无 AGENT_MODE 时给提示，不打断，包仍是 design", () => {
    const hint = designPackLegacyHint({ agentPack: "design" });
    expect(hint).toBe(DESIGN_PACK_LEGACY_HINT);
    expect(hint).toMatch(/AGENT_MODE=design/);
    expect(hint).toMatch(/设计模式/);
    expect(hint).toMatch(/仍可用|不会停用/);
    expect(designPackLegacyHint({ agentPreset: "design" })).toBe(DESIGN_PACK_LEGACY_HINT);
    expect(designPackLegacyHint({ agentPack: "DESIGN", agentMode: "" })).toBe(DESIGN_PACK_LEGACY_HINT);
    expect(
      resolveDesignModeIntent({ plan: false, auto: false, agentPack: "design" }),
    ).toEqual({ action: "explicit-pack", packName: "design" });
    expect(getPack("design")?.name).toBe("design");
  });

  it("P4：已设 AGENT_MODE=design 或其它包不提示", () => {
    expect(designPackLegacyHint({ agentMode: "design", agentPack: "design" })).toBeNull();
    expect(designPackLegacyHint({ agentMode: "DESIGN", agentPreset: "design" })).toBeNull();
    expect(designPackLegacyHint({ agentPack: "ts-coding" })).toBeNull();
    expect(designPackLegacyHint({ agentPack: "ts-coding", agentPreset: "design" })).toBeNull();
    expect(designPackLegacyHint({})).toBeNull();
  });

  it("CLI 源码把旧入口提示打到 stdout，不把提示本身当成退出条件", () => {
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    expect(cli).toContain("designPackLegacyHint");
    expect(cli).toMatch(
      /if \(legacyDesignHint\) \{\s*console\.log\(c\.yellow\(legacyDesignHint\)\);\s*\}/,
    );
    expect(cli).not.toMatch(/if \(legacyDesignHint\) \{[^}]*process\.exit/);
    expect(cli).toMatch(/AGENT_PACK=design 永久保留/);
    expect(getPack("design")?.name).toBe("design");
  });

  it("CLI 打印提示、exit 0、包仍是 design", async () => {
    const mock = await startMockProvider({
      scripts: [
        { content: [{ type: "text", text: "ok" }] },
        { content: [{ type: "text", text: '{"passed":true,"issues":[],"summary":"ok"}' }] },
        { content: [{ type: "text", text: '{"passed":true,"issues":[],"summary":"ok"}' }] },
      ],
    });
    const dir = await mkdtemp(join(tmpdir(), "design-legacy-hint-"));
    const repo = fileURLToPath(new URL("..", import.meta.url));
    const tsxCli = join(repo, "node_modules", "tsx", "dist", "cli.mjs");
    const cliEntry = join(repo, "src", "cli.ts");
    try {
      const outcome = await spawnCli(
        [tsxCli, cliEntry, "--yes", "只回一句 ok"],
        dir,
        {
          ANTHROPIC_BASE_URL: mock.anthropicBaseUrl,
          ANTHROPIC_API_KEY: "mock-key",
          AGENT_PROVIDER: "anthropic",
          AGENT_MODEL: "mock-model",
          AGENT_PACK: "design",
          AGENT_REQUIRE_FINISH_TASK: "0",
          AGENT_EXECUTION_ISOLATION: "off",
          AGENT_MCP_CONFIG: join(dir, "no-mcp.json"),
          AGENT_MEMORY_DIR: join(dir, ".agent-memory"),
          AGENT_RUN_LEDGER: join(dir, "ledger.jsonl"),
          AGENT_RUN_HISTORY_DIR: join(dir, ".agent-run-history"),
          AGENT_MAX_TOKENS: "1024",
          AGENT_TIMEOUT_MS: "15000",
          AGENT_MAX_TURNS: "2",
          AGENT_VERIFY_MAX_TURNS: "3",
          AGENT_MAX_RETRIES: "0",
        },
      );
      const text = `${outcome.stdout}\n${outcome.stderr}`.replace(/\u001b\[[0-9;]*m/g, "");
      expect(outcome.exitCode).toBe(0);
      expect(text).toContain("推荐入口是设计模式");
      expect(text).toContain("AGENT_MODE=design");
      expect(text).toMatch(/pack:\s*design\b/);
      expect(text).not.toMatch(/Unknown pack/);
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 45_000);
});

describe("blank index.html", () => {
  it("R3 写入最小 HTML，不含后导出字样", async () => {
    const dir = await mkdtemp(join(tmpdir(), "design-blank-"));
    const path = await writeBlankDesignIndex(dir);
    expect(path).toBe("index.html");
    const html = await readFile(join(dir, "index.html"), "utf8");
    expect(html).toBe(BLANK_DESIGN_INDEX_HTML);
    expect(html).not.toMatch(/PPTX|后导出/);
  });

  it("规格+幻灯入口链到两份子目录", async () => {
    const dir = await mkdtemp(join(tmpdir(), "design-hub-"));
    try {
      const path = await writeDesignBundleHub(dir);
      expect(path).toBe("index.html");
      const html = await readFile(join(dir, "index.html"), "utf8");
      expect(html).toContain("./pm-spec/index.html");
      expect(html).toContain("./deck-basic/index.html");
      expect(html).toMatch(/不是通用多命中/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("P2-export leftover copy", () => {
  it("deck-basic 种子不再写另交付或后导出", async () => {
    const html = await readFile(
      fileURLToPath(new URL("../templates/design/deck-basic/index.html", import.meta.url)),
      "utf8",
    );
    expect(html).not.toMatch(/后导出|另交付/);
    expect(html).toMatch(/宿主从本页幻灯 HTML 派生/);
    expect(html).toMatch(/PowerPoint/);
    expect(html).toMatch(/data-look="ink"/);
  });
});

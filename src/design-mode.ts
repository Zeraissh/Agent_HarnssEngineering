/**
 * 设计模式注册表 + 路由薄封装。
 *
 * 注册表 v1 冻结 Open Design README 逐条 design-templates 表（html-ppt-* 收成
 * html-ppt）+ 本仓库补条 3d-object。路由层只读这张表：新增类型不改 router.ts。
 *
 * 不改 src/router.ts 的解析契约。routeToPack 只输出 { pack, reason }，表达不了
 * 「一条描述命中 ≥2 类型」——本模块不另写第二套分类器。唯一例外是命名路径
 * spec-plus-deck（产品规格 + 汇报幻灯）；落地页+幻灯等其它多制品描述若
 * router 给出某一个 id 仍按 R1 走，给 null 则 R2。
 */
import { writeFile } from "node:fs/promises";
import { routeToPack, type RouteDecision } from "./router.js";
import { PACKS, type DomainPack } from "./presets.js";
import { resolveInWorkdir } from "./tools/fs-util.js";
import type { AgentConfig, ModelClient, TurnEvent } from "./types.js";

export const DESIGN_TABS = [
  "Prototype",
  "Live Artifact",
  "Deck",
  "Template",
  "Media",
  "Other",
] as const;
export type DesignTab = (typeof DESIGN_TABS)[number];

/** SKILL.md 的七个 od.mode + critique/tweaks 的 utility（归 Other） */
export type DesignOdMode =
  | "prototype"
  | "deck"
  | "template"
  | "design-system"
  | "image"
  | "video"
  | "audio"
  | "utility";

export type DesignSeed = "blank" | "landing-basic" | "deck-basic" | "social-basic" | "pm-spec" | "team-okrs";
export type DesignBundleId = "spec-plus-deck";
export const SPEC_PLUS_DECK: DesignBundleId = "spec-plus-deck";
export type DesignExport = "html" | "pptx" | "pdf" | "mp4" | "png";
export type DesignCapability = "ready" | "missing";

export type DesignCatalogEntry = {
  readonly id: string;
  readonly tab: DesignTab;
  readonly mode: DesignOdMode;
  readonly title: string;
  readonly description: string;
  readonly pack: "design";
  readonly seed: DesignSeed;
  readonly export: readonly DesignExport[];
  readonly capability: DesignCapability;
  /** 仅 3d-object：出处与能力边界，不把未核实的产品名写成官方类型 */
  readonly source?: string;
};

export type DesignRouteKind = "r1" | "r2" | "r3";

export type DesignRoute = {
  kind: DesignRouteKind;
  /** 注册表 id；R2 未选时为 null */
  id: string | null;
  reason: string;
  seed: DesignSeed;
  /** 后端包：恒为 design，除非显式点了已安装文件包 */
  pack: string;
  /** R2 时若用户点名了页签，只展开该页签 */
  tab?: DesignTab | null;
  /** 命名多制品路径；不是通用多命中检测 */
  bundle?: DesignBundleId | null;
  extraSeeds?: DesignSeed[];
};

export type DesignModeIntent =
  | { action: "plan" }
  | { action: "explicit-pack"; packName: string }
  | { action: "design" }
  | { action: "auto" }
  | { action: "none" };

const THREE_D_HINT = /(?:\b3d\b|三维|webgl|shader\s*物体)/i;

function freezeEntry(entry: DesignCatalogEntry): DesignCatalogEntry {
  return Object.freeze({
    ...entry,
    export: Object.freeze([...entry.export]),
  });
}

/**
 * README「What it produces」意译。不自撰职责。
 * html-ppt-* 收成一条 html-ppt。3d-object 为本仓库补条，不是 README 表内项。
 */
const RAW_CATALOG: DesignCatalogEntry[] = [
  {
    id: "web-prototype",
    tab: "Prototype",
    mode: "prototype",
    title: "网页原型",
    description: "默认落地页 / 主视觉",
    pack: "design",
    seed: "blank",
    export: ["html"],
    capability: "ready",
  },
  {
    id: "saas-landing",
    tab: "Prototype",
    mode: "prototype",
    title: "SaaS 落地页",
    description: "主视觉 / 功能 / 定价 / 行动号召",
    pack: "design",
    seed: "landing-basic",
    export: ["html"],
    capability: "ready",
  },
  {
    id: "dashboard",
    tab: "Live Artifact",
    mode: "prototype",
    title: "仪表盘",
    description: "带侧栏的管理 / 分析台",
    pack: "design",
    seed: "blank",
    export: ["html"],
    capability: "ready",
  },
  {
    id: "mobile-app",
    tab: "Prototype",
    mode: "prototype",
    title: "移动应用",
    description: "iPhone 15 Pro / Pixel 装框应用",
    pack: "design",
    seed: "blank",
    export: ["html"],
    capability: "ready",
  },
  {
    id: "mobile-onboarding",
    tab: "Prototype",
    mode: "prototype",
    title: "移动引导",
    description: "启动页 · 价值主张 · 登录流",
    pack: "design",
    seed: "blank",
    export: ["html"],
    capability: "ready",
  },
  {
    id: "social-carousel",
    tab: "Media",
    mode: "prototype",
    title: "社媒轮播",
    description: "3 张 1080×1080 方图，可导出 PNG",
    pack: "design",
    seed: "social-basic",
    export: ["html", "png"],
    capability: "ready",
  },
  {
    id: "email-marketing",
    tab: "Media",
    mode: "prototype",
    title: "营销邮件",
    description: "表格降级安全的预览稿，不接投放",
    pack: "design",
    seed: "blank",
    export: ["html"],
    capability: "ready",
  },
  {
    id: "magazine-poster",
    tab: "Media",
    mode: "prototype",
    title: "杂志海报",
    description: "单页杂志版式，可导出 PNG",
    pack: "design",
    seed: "social-basic",
    export: ["html", "png"],
    capability: "ready",
  },
  {
    id: "motion-frames",
    tab: "Media",
    mode: "prototype",
    title: "动效画幅",
    description: "循环 CSS 动效主视觉",
    pack: "design",
    seed: "blank",
    export: ["html"],
    capability: "ready",
  },
  {
    id: "sprite-animation",
    tab: "Media",
    mode: "prototype",
    title: "精灵动画",
    description: "8-bit 像素动画说明",
    pack: "design",
    seed: "blank",
    export: ["html"],
    capability: "ready",
  },
  {
    id: "pm-spec",
    tab: "Template",
    mode: "prototype",
    title: "产品规格",
    description: "产品规格文档（含目录 + 决策日志）",
    pack: "design",
    seed: "pm-spec",
    export: ["html"],
    capability: "ready",
  },
  {
    id: "team-okrs",
    tab: "Template",
    mode: "prototype",
    title: "团队 OKR",
    description: "OKR 记分卡",
    pack: "design",
    seed: "team-okrs",
    export: ["html"],
    capability: "ready",
  },
  {
    id: "eng-runbook",
    tab: "Template",
    mode: "prototype",
    title: "工程手册",
    description: "事故处置手册",
    pack: "design",
    seed: "blank",
    export: ["html"],
    capability: "ready",
  },
  {
    id: "finance-report",
    tab: "Template",
    mode: "prototype",
    title: "财务报告",
    description: "管理层财务摘要",
    pack: "design",
    seed: "blank",
    export: ["html"],
    capability: "ready",
  },
  {
    id: "hr-onboarding",
    tab: "Template",
    mode: "prototype",
    title: "人事入职",
    description: "岗位入职计划",
    pack: "design",
    seed: "blank",
    export: ["html"],
    capability: "ready",
  },
  {
    id: "guizang-ppt",
    tab: "Deck",
    mode: "deck",
    title: "杂志风幻灯",
    description: "杂志风网页幻灯，可导出 PPTX",
    pack: "design",
    seed: "deck-basic",
    export: ["html", "pptx", "pdf"],
    capability: "ready",
  },
  {
    id: "html-ppt",
    tab: "Deck",
    mode: "deck",
    title: "HTML 幻灯",
    description: "一套基础幻灯，可导出 PPTX",
    pack: "design",
    seed: "deck-basic",
    export: ["html", "pptx", "pdf"],
    capability: "ready",
  },
  {
    id: "hyperframes",
    tab: "Media",
    mode: "video",
    title: "动态图形",
    description: "HTML → MP4 动态图形",
    pack: "design",
    seed: "blank",
    export: ["html", "mp4"],
    capability: "missing",
  },
  {
    id: "critique",
    tab: "Other",
    mode: "utility",
    title: "自评表",
    description: "五维自评记分表",
    pack: "design",
    seed: "blank",
    export: ["html"],
    capability: "ready",
  },
  {
    id: "tweaks",
    tab: "Other",
    mode: "utility",
    title: "微调面板",
    description: "AI 写出的微调面板清单",
    pack: "design",
    seed: "blank",
    export: ["html"],
    capability: "ready",
  },
  {
    id: "3d-object",
    tab: "Prototype",
    mode: "prototype",
    title: "三维对象",
    description: "可交互的三维对象：自包含 HTML 页里的 shader / WebGL 场景",
    pack: "design",
    seed: "blank",
    export: ["html"],
    capability: "ready",
    source: "现产品页未列此 id",
  },
];

export const DESIGN_CATALOG: readonly DesignCatalogEntry[] = Object.freeze(
  RAW_CATALOG.map(freezeEntry),
);

export const DESIGN_CATALOG_IDS: readonly string[] = Object.freeze(
  DESIGN_CATALOG.map((e) => e.id),
);

const BY_ID = new Map(DESIGN_CATALOG.map((e) => [e.id, e]));

export function getDesignEntry(id: string): DesignCatalogEntry | undefined {
  return BY_ID.get(id);
}

export function designEntriesByTab(tab: DesignTab): DesignCatalogEntry[] {
  return DESIGN_CATALOG.filter((e) => e.tab === tab);
}

export function seedForDesignId(id: string): DesignSeed {
  return BY_ID.get(id)?.seed ?? "blank";
}

export function isDesignTab(value: string): value is DesignTab {
  return (DESIGN_TABS as readonly string[]).includes(value);
}

/** 已安装文件包 = allPacks() 里不在内置 PACKS 的项。不做描述启发式。 */
export function installedFilePacksFrom(all: DomainPack[]): DomainPack[] {
  return all.filter((p) => !PACKS[p.name]);
}

/**
 * 只给 router 看的菜单：name = 注册表 id，description = 官方职责。
 * 不把已安装文件包编进自动路由菜单——文件包只走 Path B 点选。
 */
export function designRouterMenu(): DomainPack[] {
  return DESIGN_CATALOG.map((e) => ({
    name: e.id,
    description: e.description,
    systemPrompt: "",
    verify: { enabled: false, mode: "rubric" },
  }));
}

export function isDesignModeEnv(raw: string | undefined | null): boolean {
  return String(raw ?? "").trim().toLowerCase() === "design";
}

function isDesignPackName(raw: string | undefined | null): boolean {
  return String(raw ?? "").trim().toLowerCase() === "design";
}

/**
 * P4：旧入口 AGENT_PACK=design / AGENT_PRESET=design 永久保留。
 * 未设 AGENT_MODE=design 时给提示，不是错误、不废弃、不改包。
 */
export const DESIGN_PACK_LEGACY_HINT =
  "提示：推荐入口是设计模式（AGENT_MODE=design）。AGENT_PACK=design / AGENT_PRESET=design 仍可用，不会停用。";

export function designPackLegacyHint(opts: {
  agentMode?: string | null;
  agentPack?: string | null;
  agentPreset?: string | null;
}): string | null {
  if (isDesignModeEnv(opts.agentMode)) return null;
  // 与 CLI 相同：AGENT_PACK ?? AGENT_PRESET，空串不算缺省。
  if (!isDesignPackName(opts.agentPack ?? opts.agentPreset)) return null;
  return DESIGN_PACK_LEGACY_HINT;
}

/**
 * CLI 入口优先级（10 号「显式 > 路由」）：
 * --plan 胜出 → 显式 AGENT_PACK/PRESET 胜出 → AGENT_MODE=design → --auto → 无。
 * AGENT_PACK=design 且未设 AGENT_MODE 时走 explicit-pack，不进门面路由。
 */
export function resolveDesignModeIntent(opts: {
  plan: boolean;
  auto: boolean;
  agentMode?: string | null;
  agentPack?: string | null;
}): DesignModeIntent {
  if (opts.plan) return { action: "plan" };
  const packName = String(opts.agentPack ?? "").trim();
  if (packName) return { action: "explicit-pack", packName };
  if (isDesignModeEnv(opts.agentMode)) return { action: "design" };
  if (opts.auto) return { action: "auto" };
  return { action: "none" };
}

export function isVagueDesignTask(task: string): boolean {
  const t = String(task ?? "").trim();
  return t === "" || t === "做个东西";
}

export function isRouteParseFailure(decision: RouteDecision): boolean {
  return decision.pack === null && decision.reason.includes("无法解析");
}

function tokenHit(task: string, token: string): boolean {
  const t = task.toLowerCase();
  const needle = token.toLowerCase();
  if (!needle) return false;
  if (!t.includes(needle)) return false;
  if (!/^[a-z0-9-]+$/.test(needle)) return true;
  const re = new RegExp(`(?:^|[^a-z0-9-])${needle.replace(/-/g, "\\-")}(?:$|[^a-z0-9-])`, "i");
  return re.test(task);
}

export type ExplicitDesignHit =
  | { kind: "id"; entry: DesignCatalogEntry }
  | { kind: "tab"; tab: DesignTab }
  | { kind: "file-pack"; packName: string }
  | { kind: "bundle"; bundle: DesignBundleId };

const SPEC_HINT = /(?:产品规格|规格文档|prd\b|pm-spec|需求文档|需求规格)/i;
const DECK_HINT = /(?:幻灯|pptx?|汇报片|路演|html-ppt|deck-basic)/i;

/** 命名路径：规格 + 幻灯。不是通用多命中检测。 */
export function detectSpecPlusDeck(task: string): boolean {
  const t = String(task ?? "");
  return SPEC_HINT.test(t) && DECK_HINT.test(t);
}

export function specPlusDeckRoute(reason: string): DesignRoute {
  return {
    kind: "r1",
    id: "pm-spec",
    reason,
    seed: "pm-spec",
    extraSeeds: ["deck-basic"],
    bundle: SPEC_PLUS_DECK,
    pack: "design",
  };
}

export function seedsToCopy(route: DesignRoute): Exclude<DesignSeed, "blank">[] {
  const all = [route.seed, ...(route.extraSeeds ?? [])];
  return [...new Set(all.filter((s): s is Exclude<DesignSeed, "blank"> => s !== "blank"))];
}

/**
 * 显式点名模板 / 页签 / 注册表 id / 已安装文件包。
 * 点名优先于自动路由。若正文里出现 ≥2 个注册表 id，不在这里裁决——
 * 交给 routeToPack（它给某一个 id 则 R1，给 null 则 R2）。不另写多命中分类器。
 */
export function matchExplicitDesign(opts: {
  task?: string;
  explicitId?: string | null;
  explicitTab?: string | null;
  explicitTemplate?: string | null;
  explicitFilePack?: string | null;
  installedFilePackNames?: readonly string[];
}): ExplicitDesignHit | null {
  const filePack = String(opts.explicitFilePack ?? "").trim();
  if (filePack && (opts.installedFilePackNames ?? []).includes(filePack)) {
    return { kind: "file-pack", packName: filePack };
  }

  const idRaw = String(opts.explicitId ?? "").trim();
  if (idRaw) {
    if (idRaw === SPEC_PLUS_DECK) return { kind: "bundle", bundle: SPEC_PLUS_DECK };
    const entry = BY_ID.get(idRaw);
    if (entry) return { kind: "id", entry };
    if ((opts.installedFilePackNames ?? []).includes(idRaw)) {
      return { kind: "file-pack", packName: idRaw };
    }
  }

  const template = String(opts.explicitTemplate ?? "").trim();
  if (template === "landing-basic") {
    return { kind: "id", entry: BY_ID.get("saas-landing")! };
  }
  if (template === "deck-basic") {
    return { kind: "id", entry: BY_ID.get("guizang-ppt")! };
  }
  if (template === "pm-spec") {
    return { kind: "id", entry: BY_ID.get("pm-spec")! };
  }
  if (template === "team-okrs") {
    return { kind: "id", entry: BY_ID.get("team-okrs")! };
  }

  const tabRaw = String(opts.explicitTab ?? "").trim();
  if (tabRaw && isDesignTab(tabRaw)) return { kind: "tab", tab: tabRaw };

  const task = String(opts.task ?? "");
  if (!task.trim()) return null;

  const namedIds = DESIGN_CATALOG.filter((e) => tokenHit(task, e.id));
  if (namedIds.length === 1) return { kind: "id", entry: namedIds[0]! };
  // namedIds.length >= 2：不在这里当多命中处理，交给 router。

  if (tokenHit(task, SPEC_PLUS_DECK)) {
    return { kind: "bundle", bundle: SPEC_PLUS_DECK };
  }
  if (tokenHit(task, "landing-basic")) {
    return { kind: "id", entry: BY_ID.get("saas-landing")! };
  }
  if (tokenHit(task, "deck-basic")) {
    return { kind: "id", entry: BY_ID.get("guizang-ppt")! };
  }

  const namedTabs = DESIGN_TABS.filter((tab) => tokenHit(task, tab));
  if (namedTabs.length === 1 && namedIds.length === 0) {
    return { kind: "tab", tab: namedTabs[0]! };
  }

  if (THREE_D_HINT.test(task) && namedIds.length === 0) {
    return { kind: "id", entry: BY_ID.get("3d-object")! };
  }

  return null;
}

function r1(entry: DesignCatalogEntry, reason: string, pack = "design"): DesignRoute {
  return {
    kind: "r1",
    id: entry.id,
    reason,
    seed: entry.seed,
    pack,
  };
}

function r2(reason: string, tab?: DesignTab | null): DesignRoute {
  return {
    kind: "r2",
    id: null,
    reason,
    seed: "blank",
    pack: "design",
    tab: tab ?? null,
  };
}

function r3(reason: string): DesignRoute {
  return {
    kind: "r3",
    id: null,
    reason,
    seed: "blank",
    pack: "design",
  };
}

function dispatchEntry(entry: DesignCatalogEntry, reason: string, pack = "design"): DesignRoute {
  if (entry.capability === "missing") {
    return r3(
      `${reason}；本仓库没有「${entry.title}」所需工具面（${entry.description}），已用 design 包从空白 index.html 起步`,
    );
  }
  return r1(entry, reason, pack);
}

/**
 * 把 routeToPack 的 { pack, reason } 收成 R1/R2/R3。
 * 不检测多命中：router 给出某个合法 id 即 R1（即便描述可能覆盖多种制品）。
 */
export function classifyDesignDecision(
  decision: RouteDecision,
  opts?: { parseFailed?: boolean },
): DesignRoute {
  if (opts?.parseFailed || isRouteParseFailure(decision)) {
    return r3("路由输出无法解析，已用 design 包从空白 index.html 起步");
  }
  if (decision.pack == null || decision.pack === "") {
    return r2(decision.reason || "拿不准制品类型，请选择页签或模板");
  }
  const entry = BY_ID.get(decision.pack);
  if (!entry) {
    return r2(decision.reason || "未命中注册表类型，请选择页签或模板");
  }
  return dispatchEntry(entry, decision.reason || `已自动匹配：${entry.title}`);
}

export async function routeDesignTask(opts: {
  cfg: AgentConfig;
  model: ModelClient;
  task: string;
  explicitId?: string | null;
  explicitTab?: string | null;
  explicitTemplate?: string | null;
  explicitFilePack?: string | null;
  installedFilePacks?: DomainPack[];
  onEvent?: (event: TurnEvent) => void | Promise<void>;
}): Promise<DesignRoute> {
  const installed = opts.installedFilePacks ?? [];
  const installedNames = installed.map((p) => p.name);
  const explicit = matchExplicitDesign({
    task: opts.task,
    explicitId: opts.explicitId,
    explicitTab: opts.explicitTab,
    explicitTemplate: opts.explicitTemplate,
    explicitFilePack: opts.explicitFilePack,
    installedFilePackNames: installedNames,
  });

  if (explicit?.kind === "file-pack") {
    return {
      kind: "r1",
      id: null,
      reason: `已选用已安装文件包 ${explicit.packName}`,
      seed: "blank",
      pack: explicit.packName,
    };
  }
  if (explicit?.kind === "id") {
    return dispatchEntry(explicit.entry, `显式选用：${explicit.entry.title}`);
  }
  if (explicit?.kind === "tab") {
    return r2(`已指定页签 ${explicit.tab}，请再选该页签下的模板`, explicit.tab);
  }
  if (explicit?.kind === "bundle") {
    return specPlusDeckRoute("显式选用：规格 + 幻灯");
  }

  if (isVagueDesignTask(opts.task)) {
    return r2("输入为空或过于笼统，请选择页签或模板");
  }

  if (detectSpecPlusDeck(opts.task)) {
    return specPlusDeckRoute("命名路径：产品规格 + 汇报幻灯（不是通用多命中检测）");
  }

  try {
    const outcome = await routeToPack(
      opts.cfg,
      opts.model,
      opts.task,
      designRouterMenu(),
      opts.onEvent,
    );
    return classifyDesignDecision(outcome.decision);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return r3(`路由调用失败（${msg}），已用 design 包从空白 index.html 起步`);
  }
}

/** R3 / 空白起步用的最小 HTML。不写后导出、不提 Office 引擎。 */
export const BLANK_DESIGN_INDEX_HTML =
  "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title></title>\n</head>\n<body>\n</body>\n</html>\n";

export async function writeBlankDesignIndex(workdir: string): Promise<string> {
  const abs = resolveInWorkdir(workdir, "index.html");
  await writeFile(abs, BLANK_DESIGN_INDEX_HTML, "utf8");
  return "index.html";
}

/** 规格 + 幻灯的预览入口：链到两份子目录，不假装已拆成两次路由。 */
export const DESIGN_BUNDLE_HUB_HTML =
  "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>规格 + 幻灯</title>\n<style>\nbody{font-family:system-ui,sans-serif;margin:2rem;line-height:1.5;color:#1a1814;background:#f4f1ea}\na{color:#b0522f}\n</style>\n</head>\n<body>\n<h1>规格 + 幻灯</h1>\n<p>两份制品，命名路径播种；不是通用多命中拆分。</p>\n<ul>\n<li><a href=\"./pm-spec/index.html\">产品规格</a></li>\n<li><a href=\"./deck-basic/index.html\">汇报幻灯</a></li>\n</ul>\n</body>\n</html>\n";

export async function writeDesignBundleHub(workdir: string): Promise<string> {
  const abs = resolveInWorkdir(workdir, "index.html");
  await writeFile(abs, DESIGN_BUNDLE_HUB_HTML, "utf8");
  return "index.html";
}

/** R1 且有非 blank 种子时由宿主去调现有 copyDesignTemplate / seed-template。 */
export function shouldSeedDesignTemplate(route: DesignRoute): boolean {
  return seedsToCopy(route).length > 0;
}

/** R3 才写空白 index.html；R1+blank 把工作目录空着让 agent 写。 */
export function shouldWriteBlankDesignIndex(route: DesignRoute): boolean {
  return route.kind === "r3";
}

export function designRouteForRunConfig(route: DesignRoute): {
  id: string | null;
  reason: string;
  seed: DesignSeed;
  kind: DesignRouteKind;
  bundle?: DesignBundleId | null;
  extraSeeds?: DesignSeed[];
} {
  return {
    id: route.id,
    reason: route.reason,
    seed: route.seed,
    kind: route.kind,
    ...(route.bundle ? { bundle: route.bundle } : {}),
    ...(route.extraSeeds?.length ? { extraSeeds: [...route.extraSeeds] } : {}),
  };
}

/** CLI / UI 共用的页签选项（一次问完：6 个页签，不是 4 选项上限的 ask_user 工具）。 */
export function designTabChoices(): { id: DesignTab; label: string }[] {
  return DESIGN_TABS.map((tab) => ({ id: tab, label: tab }));
}

/**
 * 把一次人选（编号 / id / 页签名 / 本地模板名）收成显式命中。
 * 供 CLI R2 问完后跳过自动路由。
 */
export function parseDesignChoiceInput(
  raw: string,
  opts?: { tabHint?: DesignTab | null },
): ExplicitDesignHit | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  const asNum = Number(t);
  if (opts?.tabHint && Number.isInteger(asNum) && asNum >= 1) {
    const entry = designEntriesByTab(opts.tabHint)[asNum - 1];
    if (entry) return { kind: "id", entry };
  }
  if (!opts?.tabHint && Number.isInteger(asNum) && asNum >= 1 && asNum <= DESIGN_CATALOG.length) {
    return { kind: "id", entry: DESIGN_CATALOG[asNum - 1]! };
  }
  return matchExplicitDesign({
    task: t,
    explicitId: t,
    explicitTab: t,
    explicitTemplate: t,
  });
}

export function publicDesignCatalog(): Array<{
  id: string;
  tab: DesignTab;
  mode: DesignOdMode;
  title: string;
  description: string;
  seed: DesignSeed;
  export: DesignExport[];
  capability: DesignCapability;
  source?: string;
}> {
  return DESIGN_CATALOG.map((e) => ({
    id: e.id,
    tab: e.tab,
    mode: e.mode,
    title: e.title,
    description: e.description,
    seed: e.seed,
    export: [...e.export],
    capability: e.capability,
    ...(e.source ? { source: e.source } : {}),
  }));
}

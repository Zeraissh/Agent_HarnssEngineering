/**
 * AGENT-02 战役：拆役检测 + mailbox 形状。
 *
 * 不走 routeToPack，也不把 spec-plus-deck 扩成通用多命中。
 * spec+幻灯仍是一场、两份种子；其它「两个以上独立交付物」或跨 pack 才建议战役。
 */
import { detectSpecPlusDeck } from "./design-mode.js";

export const CAMPAIGN_SCHEMA_VERSION = 1;
export const CAMPAIGNS_DIRNAME = ".agent-campaigns";

export const MAILBOX_ACTIONS = ["assign", "follow_up", "cancel", "redispatch"] as const;
export type MailboxActionKind = (typeof MAILBOX_ACTIONS)[number];

export type MailboxAction = {
  at: number;
  action: MailboxActionKind;
  /** 任务书或跟进说明。不是子对话正史。 */
  task: string;
  /** 产物路径。不是 transcript。 */
  artifacts: string[];
};

export type CampaignFamily = "spec" | "deck" | "landing" | "firmware" | "pcb" | "generic";

export type CampaignChildSketch = {
  id: string;
  title: string;
  description: string;
  pack: string | null;
  family: CampaignFamily;
};

export type CampaignSplit =
  | { split: false; reason: "spec-plus-deck" | "single" | "vague" }
  | {
      split: true;
      reason: "multi-deliverable" | "cross-pack";
      children: CampaignChildSketch[];
    };

export type CampaignChildStatus = "pending" | "running" | "done" | "cancelled" | "error";

export type CampaignChildRecord = {
  runId: string;
  title: string;
  status: CampaignChildStatus;
  pack?: string | null;
};

export type CampaignMeta = {
  schemaVersion: typeof CAMPAIGN_SCHEMA_VERSION;
  id: string;
  directorRunId: string;
  projectId?: string;
  task: string;
  createdAt: string;
  children: CampaignChildRecord[];
};

export type CampaignRole = "director" | "child";

const SPEC_HINT = /(?:产品规格|规格文档|prd\b|pm-spec|需求文档|需求规格)/i;
const DECK_HINT = /(?:幻灯|pptx?|汇报片|路演|html-ppt|deck-basic)/i;
const LANDING_HINT = /(?:落地页|landing\s*page|\bsaas\s*落地|官网首页)/i;
const FIRMWARE_HINT = /(?:固件|\bfirmware\b|\bstm32\b|烧录|\belf\b)/i;
const PCB_HINT = /(?:\bpcb\b|原理图|\bkicad\b|\bgerber\b)/i;

type FamilyMeta = {
  family: CampaignFamily;
  hint: RegExp;
  title: string;
  pack: string | null;
  brief: string;
};

const FAMILIES: readonly FamilyMeta[] = [
  { family: "spec", hint: SPEC_HINT, title: "产品规格", pack: "design", brief: "写产品规格（pm-spec），自包含交付。" },
  { family: "deck", hint: DECK_HINT, title: "汇报幻灯", pack: "design", brief: "做汇报幻灯（deck-basic），自包含交付。" },
  { family: "landing", hint: LANDING_HINT, title: "落地页", pack: "design", brief: "做落地页，自包含交付。" },
  { family: "firmware", hint: FIRMWARE_HINT, title: "固件", pack: "stm32-coding", brief: "写/改固件并给出可验证产物。" },
  { family: "pcb", hint: PCB_HINT, title: "原理图/PCB", pack: "kicad", brief: "做原理图与 PCB，按双判官验收。" },
];

export function detectCampaignFamilies(task: string): CampaignFamily[] {
  const t = String(task ?? "");
  return FAMILIES.filter((f) => f.hint.test(t)).map((f) => f.family);
}

function sketchesFor(task: string, families: CampaignFamily[]): CampaignChildSketch[] {
  return families.map((family, i) => {
    const meta = FAMILIES.find((f) => f.family === family)!;
    return {
      id: `c${i + 1}`,
      title: meta.title,
      description: `${meta.brief}\n\n委托方原话：${task}`,
      pack: meta.pack,
      family,
    };
  });
}

/**
 * 复合需求是否应拆成战役。独立于 routeToPack。
 *
 * - spec-plus-deck（规格+幻灯，且没有第三份独立交付）→ 不拆
 * - 两个以上独立交付物，或跨 pack → 拆
 * - 单制品 / 含糊 → 不拆
 */
export function detectCampaignSplit(task: string): CampaignSplit {
  const t = String(task ?? "").trim();
  if (!t) return { split: false, reason: "vague" };

  const families = detectCampaignFamilies(t);
  if (detectSpecPlusDeck(t)) {
    const extras = families.filter((f) => f !== "spec" && f !== "deck");
    if (extras.length === 0) return { split: false, reason: "spec-plus-deck" };
  }
  if (families.length < 2) {
    return { split: false, reason: families.length === 1 ? "single" : "vague" };
  }

  const packs = new Set(
    families
      .map((f) => FAMILIES.find((x) => x.family === f)?.pack)
      .filter((p): p is string => Boolean(p)),
  );
  return {
    split: true,
    reason: packs.size >= 2 ? "cross-pack" : "multi-deliverable",
    children: sketchesFor(t, families),
  };
}

export function isMailboxAction(value: unknown): value is MailboxActionKind {
  return typeof value === "string" && (MAILBOX_ACTIONS as readonly string[]).includes(value);
}

/**
 * 宽松解析一条 mailbox。多出来的 transcript / messages 字段一律丢掉——
 * mailbox 只许任务书与产物路径。
 */
export function parseMailboxAction(raw: unknown): MailboxAction | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!isMailboxAction(o.action)) return null;
  const task = typeof o.task === "string" ? o.task.trim() : "";
  if (!task) return null;
  const artifacts = Array.isArray(o.artifacts)
    ? o.artifacts.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
  const at = typeof o.at === "number" && Number.isFinite(o.at) ? o.at : Date.now();
  return { at, action: o.action, task, artifacts };
}

export function serializeMailboxAction(action: MailboxAction): string {
  return JSON.stringify({
    at: action.at,
    action: action.action,
    task: action.task,
    artifacts: action.artifacts,
  });
}

export function parseMailboxJsonl(raw: string | null | undefined): MailboxAction[] {
  if (!raw) return [];
  const out: MailboxAction[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = parseMailboxAction(JSON.parse(trimmed));
      if (parsed) out.push(parsed);
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}

export function parseCampaignMeta(raw: unknown): CampaignMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== CAMPAIGN_SCHEMA_VERSION) return null;
  const id = String(o.id ?? "").trim();
  const directorRunId = String(o.directorRunId ?? "").trim();
  const task = String(o.task ?? "").trim();
  if (!id || !directorRunId) return null;
  const children: CampaignChildRecord[] = [];
  if (Array.isArray(o.children)) {
    for (const item of o.children) {
      if (!item || typeof item !== "object") continue;
      const c = item as Record<string, unknown>;
      const runId = String(c.runId ?? "").trim();
      const title = String(c.title ?? "").trim();
      if (!runId || !title) continue;
      const status = String(c.status ?? "pending");
      const allowed: CampaignChildStatus[] = ["pending", "running", "done", "cancelled", "error"];
      children.push({
        runId,
        title,
        status: (allowed.includes(status as CampaignChildStatus) ? status : "pending") as CampaignChildStatus,
        ...(typeof c.pack === "string" || c.pack === null ? { pack: c.pack } : {}),
      });
    }
  }
  const projectId = typeof o.projectId === "string" && o.projectId.trim() ? o.projectId.trim() : undefined;
  const createdAt = typeof o.createdAt === "string" && o.createdAt.trim()
    ? o.createdAt.trim()
    : new Date(0).toISOString();
  return {
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    id,
    directorRunId,
    ...(projectId ? { projectId } : {}),
    task,
    createdAt,
    children,
  };
}

/**
 * 显式开战（POST /api/campaigns 或 campaign:true）：含糊/单制品也开导演，
 * 只挂一条「执行」子役草图。spec-plus-deck 不走这里——调用方应先 409。
 */
export function directorSplitForTask(task: string): Extract<CampaignSplit, { split: true }> {
  const detected = detectCampaignSplit(task);
  if (detected.split) return detected;
  const families = detectCampaignFamilies(task);
  if (families.length === 1) {
    return {
      split: true,
      reason: "multi-deliverable",
      children: sketchesFor(task, families),
    };
  }
  return {
    split: true,
    reason: "multi-deliverable",
    children: [
      {
        id: "c1",
        title: "执行",
        description: `按委托方原话自包含交付。\n\n委托方原话：${task}`,
        pack: null,
        family: "generic",
      },
    ],
  };
}

export function planFromCampaignSplit(split: Extract<CampaignSplit, { split: true }>): {
  subtasks: Array<{
    id: string;
    title: string;
    pack: string | null;
    description: string;
    acceptance: string[];
    dependsOn: string[];
  }>;
} {
  return {
    subtasks: split.children.map((c) => ({
      id: c.id,
      title: c.title,
      pack: c.pack,
      description: c.description,
      acceptance: ["子对话已开出并可进入", "产物路径已交回导演 mailbox"],
      dependsOn: [],
    })),
  };
}

export const DIRECTOR_SYSTEM_PROMPT =
  "你是战役导演：薄看板，不产制品。用 spawn_task 为每个独立交付物开一条子对话；" +
  "用 campaign_mail 写 mailbox（assign / follow_up / cancel / redispatch），" +
  "payload 只有任务书与产物路径，不要写子对话正史。" +
  "用 project_status 维护谁在等、下一门、未决决策。" +
  "人批准计划后再 spawn。你只收【支线结论】与产物路径。";

export const DIRECTOR_TOOL_NAMES = ["project_status", "campaign_mail", "spawn_task"] as const;

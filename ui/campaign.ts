/**
 * 战役落盘：`.agent-campaigns/<id>/meta.json` + `mailbox/<childRunId>.jsonl`。
 *
 * 注入 modelClient 的测试宿主经 UiServerOptions.campaignsRoot 显式给路径，
 * 缺省 null——仪器纪律同 projectsStoreFile：假模型宿主不写操作员那份战役目录。
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CAMPAIGN_SCHEMA_VERSION,
  CAMPAIGNS_DIRNAME,
  parseCampaignMeta,
  parseMailboxJsonl,
  serializeMailboxAction,
  type CampaignMeta,
  type MailboxAction,
} from "../src/campaign.js";

export const CAMPAIGNS_FILENAME = CAMPAIGNS_DIRNAME;

export function campaignsRootPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const override = env.AGENT_CAMPAIGNS_DIR;
  if (override && override.trim()) return resolve(cwd, override.trim());
  return join(cwd, CAMPAIGNS_DIRNAME);
}

export function newCampaignId(): string {
  return randomUUID();
}

export function campaignDir(root: string, id: string): string {
  return join(root, id);
}

export function campaignMetaPath(root: string, id: string): string {
  return join(campaignDir(root, id), "meta.json");
}

export function campaignMailboxPath(root: string, id: string, childRunId: string): string {
  return join(campaignDir(root, id), "mailbox", `${childRunId}.jsonl`);
}

function writeJsonAtomic(target: string, value: unknown): void {
  mkdirSync(join(target, ".."), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, target);
}

export function saveCampaignMeta(root: string, meta: CampaignMeta): void {
  const dir = campaignDir(root, meta.id);
  mkdirSync(join(dir, "mailbox"), { recursive: true });
  writeJsonAtomic(campaignMetaPath(root, meta.id), meta);
}

export function loadCampaignMeta(root: string, id: string): CampaignMeta | null {
  try {
    const raw = readFileSync(campaignMetaPath(root, id), "utf8");
    return parseCampaignMeta(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function listCampaignMetas(root: string): CampaignMeta[] {
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: CampaignMeta[] = [];
  for (const name of names) {
    const meta = loadCampaignMeta(root, name);
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function appendCampaignMailbox(
  root: string,
  campaignId: string,
  childRunId: string,
  action: MailboxAction,
): void {
  const path = campaignMailboxPath(root, campaignId, childRunId);
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, `${serializeMailboxAction(action)}\n`, "utf8");
}

export function readCampaignMailbox(
  root: string,
  campaignId: string,
  childRunId: string,
): MailboxAction[] {
  try {
    return parseMailboxJsonl(readFileSync(campaignMailboxPath(root, campaignId, childRunId), "utf8"));
  } catch {
    return [];
  }
}

export function campaignRootExists(root: string): boolean {
  return existsSync(root);
}

export function createCampaignMeta(input: {
  id?: string;
  directorRunId: string;
  task: string;
  projectId?: string;
}): CampaignMeta {
  return {
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    id: input.id ?? newCampaignId(),
    directorRunId: input.directorRunId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    task: input.task,
    createdAt: new Date().toISOString(),
    children: [],
  };
}

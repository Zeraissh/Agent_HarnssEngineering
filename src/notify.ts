/**
 * 办公软件出站门禁卡片（第一刀：只出站）。
 *
 * 看板（project_status 写入/清除）变更时，可选 POST 一张飞书自定义机器人
 * 文本卡片：项目 / 摘要 / 下一门 / 谁在等 / 打开本 run 提示。
 *
 * 适配器形状留下 Slack/企微的口子（kind + 同一 JSON webhook）。
 * Token / webhook 只活在服务端；sanitize 之后的地址才允许进日志。
 */
import type { ProjectStatus } from "./project-status.js";

export const FEISHU_WEBHOOK_ENV = "AGENT_FEISHU_WEBHOOK";
export const NOTIFY_WEBHOOK_ENV = "AGENT_NOTIFY_WEBHOOK";

export type OfficeNotifyKind = "feishu" | "webhook";

export type GateNotifyPayload = {
  project: string;
  summary: string;
  nextGate: string;
  waiting: string[];
  decisions?: string[];
  runId?: string | null;
  title?: string | null;
};

export type OfficeNotifyConfig = {
  kind?: OfficeNotifyKind;
  webhookUrl?: string;
  fetchFn?: typeof fetch;
  enabled?: boolean;
};

export type OfficeNotifier = {
  kind: OfficeNotifyKind;
  armed: boolean;
  notify(payload: GateNotifyPayload): Promise<void>;
};

export type OfficeNotifySnapshot = {
  kind: OfficeNotifyKind;
  armed: boolean;
};

/** 飞书自定义机器人接受的 text 体。v1 不绑 interactive card schema。 */
export type FeishuTextBody = {
  msg_type: "text";
  content: { text: string };
};

export function resolveOfficeNotifyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OfficeNotifyConfig | null {
  const feishu = env[FEISHU_WEBHOOK_ENV]?.trim() ?? "";
  const generic = env[NOTIFY_WEBHOOK_ENV]?.trim() ?? "";
  if (feishu) return { kind: "feishu", webhookUrl: feishu };
  if (generic) return { kind: "webhook", webhookUrl: generic };
  return null;
}

export function notifyArmedHint(armed: boolean): string | undefined {
  return armed ? "飞书门禁通知已开" : undefined;
}

export function gateNotifyPayloadFromBoard(
  status: ProjectStatus | null,
  project = "",
): GateNotifyPayload {
  if (!status) {
    return {
      project,
      summary: "看板已清除",
      nextGate: "",
      waiting: [],
    };
  }
  return {
    project: status.project || project,
    summary: status.summary,
    nextGate: status.nextGate,
    waiting: status.waiting,
    ...(status.decisions.length ? { decisions: status.decisions } : {}),
  };
}

/**
 * 卡片正文。测试锁的是这些字段进了文本，不锁飞书 card JSON 的移动 schema。
 * 谁在等为空时必须印「无」（不是空白、不是「（无）」）。
 */
export function formatGateCardText(payload: GateNotifyPayload): string {
  const waiting = payload.waiting.length ? payload.waiting.join("；") : "无";
  const decisions = payload.decisions?.length ? payload.decisions.join("；") : "无";
  const title = payload.title?.trim();
  const runHint = payload.runId
    ? `打开本 run：${payload.runId}`
    : "打开本机宿主查看该 run";
  return [
    title || "门禁看板",
    `项目：${payload.project}`,
    `摘要：${payload.summary}`,
    `下一门：${payload.nextGate}`,
    `谁在等：${waiting}`,
    `未决：${decisions}`,
    runHint,
  ].join("\n");
}

export function formatFeishuGateCard(payload: GateNotifyPayload): FeishuTextBody {
  return {
    msg_type: "text",
    content: { text: formatGateCardText(payload) },
  };
}

/**
 * 日志用：剥 query / hash，并把末段 path（hook token）打码。
 * 真实启动横幅不应调用这个去打印地址——armed 时只印「飞书门禁通知已开」。
 */
export function sanitizeNotifyUrlForLog(url: string): string {
  const raw = String(url ?? "").trim();
  if (!raw) return "(invalid-notify-url)";
  try {
    const parsed = new URL(raw);
    parsed.search = "";
    parsed.hash = "";
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length > 0) {
      parts[parts.length - 1] = "***";
      parsed.pathname = `/${parts.join("/")}`;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(invalid-notify-url)";
  }
}

export function officeNotifySnapshot(notifier: Pick<OfficeNotifier, "kind" | "armed">): OfficeNotifySnapshot {
  return { kind: notifier.kind, armed: notifier.armed };
}

export function createOfficeNotifier(opts: OfficeNotifyConfig = {}): OfficeNotifier {
  const webhookUrl = String(opts.webhookUrl ?? "").trim();
  const enabled = opts.enabled !== false && webhookUrl.length > 0;
  const kind: OfficeNotifyKind = opts.kind === "webhook" ? "webhook" : "feishu";
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);

  return {
    kind,
    armed: enabled,
    async notify(payload: GateNotifyPayload): Promise<void> {
      if (!enabled) return;
      const body = formatFeishuGateCard(payload);
      await fetchFn(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
      });
    },
  };
}

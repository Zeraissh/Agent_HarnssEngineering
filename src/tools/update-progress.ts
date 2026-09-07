/**
 * 轻量进度清单：执行者边做边更新，宿主右栏 Progress 直播。
 *
 * 对标 memory_write：permission auto（不写盘、无圈禁外副作用），整表替换幂等。
 * 事件由 AgentLoop 在成功执行后发射 `progress`，不依赖宿主解析 tool_call。
 */
import type { Tool } from "../types.js";

export const PROGRESS_STATUSES = ["pending", "running", "done", "skipped"] as const;
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];

export interface ProgressItem {
  id: string;
  title: string;
  status: ProgressStatus;
}

const STATUS_SET = new Set<string>(PROGRESS_STATUSES);
const MAX_ITEMS = 40;
const MAX_ID_LEN = 64;
const MAX_TITLE_LEN = 200;

/**
 * 校验并规范化进度表。失败返回带 isError 语义的说明字符串；
 * 成功返回 items（trim、缺省 status=pending）。
 */
export function parseProgressItems(input: unknown):
  | { ok: true; items: ProgressItem[] }
  | { ok: false; error: string } {
  if (!input || typeof input !== "object") {
    return { ok: false, error: 'Invalid input: expected {"items": [...]}.' };
  }
  const raw = (input as { items?: unknown }).items;
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'Invalid input: "items" must be an array.' };
  }
  if (raw.length > MAX_ITEMS) {
    return { ok: false, error: `Too many items (${raw.length} > ${MAX_ITEMS}). Keep the checklist short.` };
  }
  const seen = new Set<string>();
  const items: ProgressItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    if (!row || typeof row !== "object") {
      return { ok: false, error: `items[${i}] must be an object.` };
    }
    const id = typeof (row as { id?: unknown }).id === "string"
      ? (row as { id: string }).id.trim()
      : "";
    const title = typeof (row as { title?: unknown }).title === "string"
      ? (row as { title: string }).title.trim()
      : "";
    const statusRaw = (row as { status?: unknown }).status;
    const status =
      statusRaw === undefined || statusRaw === null || statusRaw === ""
        ? "pending"
        : String(statusRaw);
    if (!id) return { ok: false, error: `items[${i}].id is required.` };
    if (id.length > MAX_ID_LEN) {
      return { ok: false, error: `items[${i}].id too long (max ${MAX_ID_LEN}).` };
    }
    if (!title) return { ok: false, error: `items[${i}].title is required.` };
    if (title.length > MAX_TITLE_LEN) {
      return { ok: false, error: `items[${i}].title too long (max ${MAX_TITLE_LEN}).` };
    }
    if (!STATUS_SET.has(status)) {
      return {
        ok: false,
        error: `items[${i}].status "${status}" invalid; use ${PROGRESS_STATUSES.join("|")}.`,
      };
    }
    if (seen.has(id)) {
      return { ok: false, error: `Duplicate id "${id}" — each step needs a unique id.` };
    }
    seen.add(id);
    items.push({ id, title, status: status as ProgressStatus });
  }
  return { ok: true, items };
}

export const updateProgressTool: Tool = {
  name: "update_progress",
  description:
    "Replace the visible task checklist for the user (Progress panel). Call this before starting work to list the steps you plan to take, then again whenever a step's status changes. Whole-table replace (idempotent). Do not use this instead of real file/command work — it only updates the checklist UI.",
  inputSchema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        description: "Full checklist. Replace the previous table entirely.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable step id, e.g. \"1\" or \"parse\"" },
            title: { type: "string", description: "Short human-readable step title" },
            status: {
              type: "string",
              description: "pending | running | done | skipped (default pending)",
            },
          },
          required: ["id", "title"],
        },
      },
    },
    required: ["items"],
  },
  permission: "auto",
  parallelSafe: true,
  async execute(input) {
    const parsed = parseProgressItems(input);
    if (!parsed.ok) return { content: parsed.error, isError: true };
    const summary = parsed.items
      .map((it) => `${it.status === "done" ? "[x]" : it.status === "running" ? "[>]" : "[ ]"} ${it.title}`)
      .join("; ");
    return {
      content:
        parsed.items.length === 0
          ? "Progress cleared (0 items)."
          : `Progress updated (${parsed.items.length}): ${summary}`,
    };
  },
};

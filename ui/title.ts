/**
 * 对话标题：启发式摘要 + 模型生成结果的清洗。
 *
 * 侧栏不能铺整段问题。启发式先给一个立刻能显示的短句（不花钱）；
 * 任务较长时真实宿主再补一次小 maxTokens 调用，失败就维持启发式。
 */

const NEWLINE_RE = /\r?\n/;
const ATTACH_RE = /^附件[：:]/;
const ATTACH_CAPTURE_RE = /^附件[：:]\s*(.+)$/;
const PATH_SEP_RE = /[\\/]/;
const HEADING_RE = /^#{1,6}\s+/;
const BULLET_RE = /^[-*+]\s+/;
const ORDERED_RE = /^\d+[.)]\s+/;
const QUOTE_RE = /^>\s+/;
const SPACES_RE = /\s+/g;

export const TITLE_MAX = 24;

export const TITLE_SYSTEM =
  "把用户任务压成不超过 16 个汉字或 8 个英文词的侧栏标题。" +
  "不要引号、不要句号、不要复述附件路径。只输出标题本身。";

export function clipTitle(text: string, max = TITLE_MAX): string {
  const s = String(text ?? "").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

/** 与前端 deriveRunTitle 同口径：第一句非附件行，剥 Markdown 行首记法。 */
export function summarizeTitle(task: string, max = TITLE_MAX): string {
  const raw = String(task ?? "").trim();
  if (!raw) return "未命名任务";

  const lines = raw.split(NEWLINE_RE).map((l) => l.trim()).filter(Boolean);
  const meaningful = lines.find((l) => !ATTACH_RE.test(l));
  if (!meaningful) {
    const m = ATTACH_CAPTURE_RE.exec(lines[0] ?? "");
    const file = (m?.[1] ?? "").split(PATH_SEP_RE).pop() ?? "";
    return file ? `附件 ${clipTitle(file, max)}` : "附件";
  }

  const cleaned = meaningful
    .replace(HEADING_RE, "")
    .replace(BULLET_RE, "")
    .replace(ORDERED_RE, "")
    .replace(QUOTE_RE, "")
    .replace(SPACES_RE, " ")
    .trim();
  return clipTitle(cleaned, max) || "未命名任务";
}

/** 模型回来说话太长 / 带围栏 / 复述原文时丢掉，宁可维持启发式。 */
export function sanitizeGeneratedTitle(raw: string, max = TITLE_MAX): string | null {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  s = s.replace(/^```[\s\S]*?```$/g, "").trim();
  s = s.replace(/^["「『]|["」』]$/g, "").trim();
  s = s.split(NEWLINE_RE)[0]?.trim() ?? "";
  if (!s || s.length > max * 3) return null;
  if (/^(标题|title)\s*[:：]/i.test(s)) s = s.replace(/^(标题|title)\s*[:：]\s*/i, "").trim();
  if (!s) return null;
  return clipTitle(s, max);
}

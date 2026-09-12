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
  "概括用户在求什么，不要发明产品名、品牌名或方案名。" +
  "用户若在征求标题、文案或命名，写「设计 UI 标题」这类请求，不要写你猜的那个名字。" +
  "不要引号、不要句号、不要复述附件路径。只输出标题本身。";

export function clipTitle(text: string, max = TITLE_MAX): string {
  const s = String(text ?? "").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

/** 任务里第一条不是附件行的正文——模型润色和启发式都只看这一行。 */
export function titleSourceText(task: string): string {
  const lines = String(task ?? "").split(NEWLINE_RE).map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => !ATTACH_RE.test(l)) ?? "";
}

/**
 * 生成标题必须能对上用户原话。模型常把「给仓库 UI 设计标题」收成方案名
 * （「流光·智能仓储中枢」），侧栏就变成交付物而不是任务。
 */
export function titleReflectsTask(title: string, task: string): boolean {
  const t = String(title ?? "").trim();
  const source = titleSourceText(task);
  if (!t || !source) return false;
  const src = source.toLowerCase();
  const compact = t.replace(/[\s"'「」『』“”·\-_|]/g, "").toLowerCase();
  if (!compact) return false;
  if (src.includes(compact) || compact.includes(src.slice(0, Math.min(8, src.length)))) return true;
  const hay = new Set(contentPieces(source));
  return contentPieces(t).some((p) => hay.has(p) || src.includes(p));
}

function contentPieces(text: string): string[] {
  const s = String(text ?? "").toLowerCase();
  const out: string[] = [];
  for (const w of s.match(/[a-z]{2,}/g) ?? []) out.push(w);
  const cjk = [...s.replace(/[^\u4e00-\u9fff]/g, "")];
  for (let i = 0; i < cjk.length - 1; i++) out.push(cjk[i]! + cjk[i + 1]!);
  return out;
}

/** 存盘标题对不上任务就退回启发式，避免侧栏长期挂着一次模型胡写。 */
export function resolveRunTitle(stored: string | undefined, task: string, max = TITLE_MAX): string {
  const t = String(stored ?? "").trim();
  if (t && titleReflectsTask(t, task)) return clipTitle(t, max);
  return summarizeTitle(task, max);
}

/** 与前端 deriveRunTitle 同口径：第一句非附件行，剥 Markdown 行首记法。 */
export function summarizeTitle(task: string, max = TITLE_MAX): string {
  const raw = String(task ?? "").trim();
  if (!raw) return "未命名任务";

  const lines = raw.split(NEWLINE_RE).map((l) => l.trim()).filter(Boolean);
  const meaningful = titleSourceText(raw);
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

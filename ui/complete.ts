/**
 * 输入补全（实验性）：启发式，不调模型。
 *
 * 欢迎页示例 + 调用方传入的最近标题。前缀太短 / 无匹配 → null。
 * 不在这里打 Images/Chat——补全是便利，不该变成隐藏的 token 消耗。
 */

/** 与 ui/public/features/complete.js 的 COMPLETE_EXAMPLES[].text 保持同一顺序。 */
export const COMPLETE_CANDIDATES = [
  "用三句话解释什么是 PID 控制器。不要调用工具。",
  "看看当前工作目录里有哪些源文件，用一段话总结这个项目在做什么。",
  "帮我看看这个项目现在的状态，用三句话总结。",
  "在工作目录下创建 hello.md，写一段这个项目的简介。",
  "写一个 TypeScript 函数 clamp(n, min, max) 并配 vitest 测试，跑通后告诉我结果。",
];

export function normalizeCompletePrefix(prefix: string): string {
  return String(prefix ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 在候选里找「以 prefix 开头、更长」的最短续写。大小写不敏感，续写保持候选原文。
 */
export function heuristicComplete(prefix: string, extra: string[] = []): string | null {
  const p = normalizeCompletePrefix(prefix);
  if (p.length < 2 || p.length > 200) return null;
  const lower = p.toLowerCase();
  let best: string | null = null;
  for (const raw of [...COMPLETE_CANDIDATES, ...extra]) {
    const t = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (t.length <= p.length) continue;
    if (!t.toLowerCase().startsWith(lower)) continue;
    const rest = t.slice(p.length);
    if (!rest) continue;
    if (best == null || rest.length < best.length) best = rest;
  }
  return best;
}

export function parseCompleteBody(body: unknown): { prefix: string; recent: string[] } {
  if (!body || typeof body !== "object") return { prefix: "", recent: [] };
  const o = body as Record<string, unknown>;
  const prefix = typeof o.prefix === "string" ? o.prefix : "";
  const recent = Array.isArray(o.recent)
    ? o.recent.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 20)
    : [];
  return { prefix, recent };
}

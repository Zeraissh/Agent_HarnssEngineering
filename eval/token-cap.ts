/**
 * AB_TOKEN_CAP — A/B 跑测累计 token 成本防线（EVAL-03b）。
 *
 * 触顶即停：再多跑只会把预算烧穿，不会让矩阵更完整。
 * 解析失败（非正数）= 未设上限，保持历史行为。
 */

/** 解析 AB_TOKEN_CAP；缺省/非法 → undefined（不设上限）。 */
export function parseTokenCap(raw: string | undefined | null): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/** 已花费 + 本 run 是否会触顶或越过上限。 */
export function wouldExceedOrMeetCap(
  spent: number,
  nextTokens: number,
  cap: number | undefined,
): boolean {
  if (cap == null) return false;
  return spent + Math.max(0, nextTokens) >= cap;
}

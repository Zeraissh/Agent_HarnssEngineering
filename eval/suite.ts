/**
 * A/B 用例集选择（EVAL-01）：research 可调优面 vs held-out 冻结面。
 * 抽成独立模块，避免测试 import ab.ts 时触发 main()。
 */
import type { EvalCase } from "./cases.js";

/** research = 可调优面；heldout = EVAL-01 冻结面；all = 并集（同 id 时 heldout 赢）。 */
export function resolveAbSuite(
  suiteEnv: string | undefined,
  research: EvalCase[],
  heldout: EvalCase[],
): EvalCase[] {
  const key = (suiteEnv ?? "research").trim().toLowerCase();
  if (key === "heldout") return [...heldout];
  if (key === "all") {
    const map = new Map<string, EvalCase>();
    for (const c of research) map.set(c.id, c);
    for (const c of heldout) map.set(c.id, c);
    return [...map.values()];
  }
  // default + unknown → research（未知值不静默并集，避免误把 heldout 当研究面）
  return [...research];
}

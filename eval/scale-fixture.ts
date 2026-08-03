/**
 * 规模压力 fixture 生成器：确定性（固定种子）生成 60 模块的 ESM DAG 项目。
 * checker 用同一 genPlan() 重算 ground truth——生成逻辑即口径，零歧义。
 *
 * 结构：
 * - legacy.js：被少数模块直接 import 的"废弃模块"；
 * - m00..m59：每个模块 import 若干更低编号的模块（无环），部分直接 import legacy；
 *   各自导出 LIMIT 常量（值各不相同）、label()、deps()；
 * - test/：node --test，只覆盖 1/7 的模块（不完备 oracle，规模变更用例的关键）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const SCALE_N = 60;
const SEED = 20260801;

/** mulberry32：确定性 PRNG */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ScalePlan {
  /** "m00".."m59" */
  modules: string[];
  /** 模块 → 它 import 的更低编号模块 */
  deps: Record<string, string[]>;
  /** 直接 import legacy.js 的模块 */
  legacyDirect: string[];
  /** 模块 → LIMIT 常量值 */
  limits: Record<string, number>;
  /** 测试覆盖的模块（每 7 个取 1） */
  tested: string[];
}

export function genPlan(): ScalePlan {
  const rnd = mulberry32(SEED);
  const modules = Array.from({ length: SCALE_N }, (_, i) => `m${String(i).padStart(2, "0")}`);
  const deps: Record<string, string[]> = {};
  const legacyDirect: string[] = [];
  const limits: Record<string, number> = {};

  for (let i = 0; i < SCALE_N; i++) {
    const name = modules[i]!;
    limits[name] = 2 + Math.floor(rnd() * 96); // 2..97
    const picks = new Set<string>();
    if (i > 0) {
      // 稀疏 + 局部性：25% 无依赖，否则 1-2 个，且只在前 15 个近邻里选——
      // 控制 legacy 闭包规模（全稠密时闭包≈全图，audit 用例失去区分度）
      const k = rnd() < 0.15 ? 0 : 1 + Math.floor(rnd() * 2);
      const lo = Math.max(0, i - 20);
      for (let j = 0; j < k; j++) picks.add(modules[lo + Math.floor(rnd() * (i - lo))]!);
    }
    deps[name] = [...picks].sort();
    // legacy 直接依赖者偏中高编号：影响面受局部性限制，闭包不至于吞掉全图
    if (i >= 18 && rnd() < 0.15) legacyDirect.push(name);
  }
  const tested = modules.filter((_, i) => i % 7 === 0);
  return { modules, deps, legacyDirect, limits, tested };
}

/** legacy 的传递闭包（直接或间接依赖 legacy 的模块），字母序 */
export function legacyClosure(plan: ScalePlan): string[] {
  const dependsOnLegacy = new Set<string>(plan.legacyDirect);
  // DAG 且依赖只指向更低编号 → 按编号升序一遍传播即可收敛
  for (const name of plan.modules) {
    if (plan.deps[name]!.some((d) => dependsOnLegacy.has(d))) dependsOnLegacy.add(name);
  }
  return [...dependsOnLegacy].sort();
}

/** 单个模块的源码（limitOverride 用于 checker 构造"正确变更后"的黄金内容） */
export function moduleSource(plan: ScalePlan, name: string, limitOverride?: number): string {
  const imports = plan.deps[name]!
    .map((d) => `import { label as label_${d} } from "./${d}.js";`)
    .join("\n");
  const legacyImport = plan.legacyDirect.includes(name)
    ? `import { LEGACY } from "./legacy.js";\n`
    : "";
  const depCalls = plan.deps[name]!.map((d) => `label_${d}()`).join(", ");
  const legacyRef = plan.legacyDirect.includes(name) ? `\nexport const USES_LEGACY = LEGACY;` : "";
  return `// auto-generated module ${name}
${legacyImport}${imports}${imports ? "\n" : ""}export const LIMIT = ${limitOverride ?? plan.limits[name]};
export function label() {
  return "${name}";
}
export function deps() {
  return [${depCalls}];
}${legacyRef}
`;
}

export async function writeScaleFixture(dir: string): Promise<void> {
  const plan = genPlan();
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "test"), { recursive: true });

  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "scale-dag", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
    "utf8",
  );
  await writeFile(path.join(dir, "src", "legacy.js"), `// deprecated shared module\nexport const LEGACY = true;\n`, "utf8");
  for (const name of plan.modules) {
    await writeFile(path.join(dir, "src", `${name}.js`), moduleSource(plan, name), "utf8");
  }

  const testBody = plan.tested
    .map(
      (name) => `test("${name} 基本不变量", async () => {
  const mod = await import("../src/${name}.js");
  assert.equal(mod.label(), "${name}");
  assert.ok(Number.isInteger(mod.LIMIT) && mod.LIMIT > 0);
});`,
    )
    .join("\n\n");
  await writeFile(
    path.join(dir, "test", "scale.test.js"),
    `import test from "node:test";\nimport assert from "node:assert/strict";\n\n${testBody}\n`,
    "utf8",
  );
}

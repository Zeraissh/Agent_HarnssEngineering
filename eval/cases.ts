/**
 * 评估基线用例：5 个固定任务，覆盖框架的核心行为面。
 * 每个用例的 check() 是程序化判定 —— 不靠人眼，保证可重复回归。
 * 产出统一写到 eval-out/（.gitignore），check 只看实际文件。
 */
import { execFile } from "node:child_process";
import { cp, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** 在指定目录跑 node，回传是否零退出与合并输出（变更类用例的回归判定用） */
async function runNode(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await execFileP("node", args, { cwd, timeout: 60_000 });
    return { ok: true, out: `${stdout}\n${stderr}` };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${e.stdout ?? ""}\n${e.stderr ?? e.message ?? ""}` };
  }
}

/** 行为探针：以 ESM 内联脚本断言被改项目的实际行为（断言失败即非零退出） */
async function probe(projDir: string, body: string): Promise<{ ok: boolean; out: string }> {
  const rangeUrl = pathToFileURL(path.join(projDir, "src/range.js")).href;
  const statsUrl = pathToFileURL(path.join(projDir, "src/stats.js")).href;
  const script = `import assert from "node:assert/strict";
const range = await import(${JSON.stringify(rangeUrl)});
const stats = await import(${JSON.stringify(statsUrl)});
${body}`;
  return runNode(projDir, ["--input-type=module", "-e", script]);
}

/** 变更类用例的公共前置：把 mini-range fixture 复制为 eval-out/proj */
async function setupMiniRange(workdir: string): Promise<void> {
  await cp(path.join(workdir, "eval/fixtures/mini-range"), path.join(workdir, "eval-out/proj"), {
    recursive: true,
  });
}

/** 断言 test/ 目录与 fixture 原版逐字节一致（防"改测试凑通过"） */
async function testsUntouched(workdir: string): Promise<boolean> {
  const orig = await readFile(
    path.join(workdir, "eval/fixtures/mini-range/test/range.test.js"),
    "utf8",
  );
  const now = await readFile(path.join(workdir, "eval-out/proj/test/range.test.js"), "utf8").catch(
    () => "",
  );
  return orig === now;
}

/** src 下所有 .ts 文件里，以 import 开头的行中第一个引号内的模块标识符（非相对，即外部/内置模块） */
async function collectImportSpecs(workdir: string): Promise<string[]> {
  const specs = new Set<string>();
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".ts")) {
        for (const line of (await readFile(full, "utf8")).split("\n")) {
          if (!line.trimStart().startsWith("import")) continue;
          const m = line.match(/"([^"]+)"/);
          if (m && !m[1]!.startsWith(".")) specs.add(m[1]!);
        }
      }
    }
  }
  await walk(path.join(workdir, "src"));
  return [...specs].sort();
}

async function countTsFiles(dir: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += await countTsFiles(path.join(dir, entry.name));
    else if (entry.name.endsWith(".ts")) count += 1;
  }
  return count;
}

export interface EvalCase {
  id: string;
  /** 覆盖的行为面（报告用） */
  covers: string;
  task: string;
  /**
   * 可选前置：在 eval-out 清空后、run 开始前执行（如把 fixture 项目复制进
   * eval-out——变更类用例绝不让 agent 改仓库本体）。
   */
  setup?(workdir: string): Promise<void>;
  check(workdir: string): Promise<{ pass: boolean; note: string }>;
  /**
   * 可选参考拆解（v1.1 并行实验）：fixed-* 臂注入此计划跳过 planner——
   * 隔离调度器变量测墙钟；planner 拆不拆由 planned 臂单独观测。
   */
  plan?: import("../src/planner.js").Plan;
}

async function readOut(workdir: string, rel: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(workdir, rel), "utf8");
  } catch {
    return undefined;
  }
}

export const cases: EvalCase[] = [
  {
    id: "write-basic",
    covers: "write_file 基本路径",
    task: '在 eval-out/hello.txt 中写入一行内容：harness ok',
    async check(workdir) {
      const text = await readOut(workdir, "eval-out/hello.txt");
      if (text === undefined) return { pass: false, note: "文件未创建" };
      return text.trim() === "harness ok"
        ? { pass: true, note: "内容精确匹配" }
        : { pass: false, note: `内容不符: ${JSON.stringify(text.slice(0, 50))}` };
    },
  },
  {
    id: "read-extract",
    covers: "read_file + 信息抽取",
    task:
      "读取 README.md，找到“四个支柱”表格，把四个支柱的英文名（Loop/Tools/…）写入 eval-out/pillars.txt，每行一个",
    async check(workdir) {
      const text = await readOut(workdir, "eval-out/pillars.txt");
      if (text === undefined) return { pass: false, note: "文件未创建" };
      const missing = ["Loop", "Tools", "Context", "Verification"].filter((p) => !text.includes(p));
      return missing.length === 0
        ? { pass: true, note: "四支柱齐全" }
        : { pass: false, note: `缺少: ${missing.join(", ")}` };
    },
  },
  {
    id: "bash-count",
    covers: "bash 工具 + 数值准确性",
    task: "统计 src/ 目录（含子目录）下 .ts 文件的数量，把纯数字写入 eval-out/count.txt",
    async check(workdir) {
      const text = await readOut(workdir, "eval-out/count.txt");
      if (text === undefined) return { pass: false, note: "文件未创建" };
      const actual = await countTsFiles(path.join(workdir, "src"));
      const reported = Number(text.trim());
      return reported === actual
        ? { pass: true, note: `数量正确 (${actual})` }
        : { pass: false, note: `报告 ${reported}，实际 ${actual}` };
    },
  },
  {
    id: "multi-read-brief",
    covers: "多文件读取 + 综合输出",
    task:
      "读取 docs/01-philosophy.md 和 docs/04-roadmap.md，各用一两句话概括核心内容，写入 eval-out/brief.md（两个小节，标明来源文件名）",
    async check(workdir) {
      const text = await readOut(workdir, "eval-out/brief.md");
      if (text === undefined) return { pass: false, note: "文件未创建" };
      const hasBoth = text.includes("01") && text.includes("04");
      const substantive = text.trim().length > 80;
      if (!hasBoth) return { pass: false, note: "未标明两个来源文件" };
      if (!substantive) return { pass: false, note: "内容过短，疑似未真正概括" };
      return { pass: true, note: "两节概括齐全" };
    },
  },
  {
    id: "error-recovery",
    covers: "工具错误恢复（is_error 回填后改道）",
    task:
      "读取 data/nonexistent-config.json 的内容并写入 eval-out/config-copy.txt；如果该文件不存在，则改为在 eval-out/fallback.txt 中写入一行：no data",
    async check(workdir) {
      const fallback = await readOut(workdir, "eval-out/fallback.txt");
      if (fallback === undefined) return { pass: false, note: "fallback.txt 未创建（未按条件分支处理）" };
      return fallback.trim() === "no data"
        ? { pass: true, note: "错误后正确走了 fallback 分支" }
        : { pass: false, note: `fallback 内容不符: ${JSON.stringify(fallback.slice(0, 50))}` };
    },
  },
  {
    id: "sum-numbers",
    covers: "多步：生成数据 → 计算 → 写结果（算术准确性）",
    task:
      "在 eval-out/nums.txt 中写入 1 到 20 的整数（每行一个），然后计算这些数字的总和，把总和的纯数字写入 eval-out/sum.txt",
    async check(workdir) {
      const sum = await readOut(workdir, "eval-out/sum.txt");
      if (sum === undefined) return { pass: false, note: "sum.txt 未创建" };
      return Number(sum.trim()) === 210
        ? { pass: true, note: "总和正确 (210)" }
        : { pass: false, note: `报告 ${sum.trim()}，实际应为 210` };
    },
  },
  {
    id: "json-field",
    covers: "结构化抽取（读 JSON 取字段）",
    task: "读取 package.json，把其中 version 字段的值（纯版本号，不带引号）写入 eval-out/version.txt",
    async check(workdir) {
      const got = await readOut(workdir, "eval-out/version.txt");
      if (got === undefined) return { pass: false, note: "version.txt 未创建" };
      const pkg = JSON.parse((await readOut(workdir, "package.json"))!) as { version: string };
      return got.trim() === pkg.version
        ? { pass: true, note: `版本号正确 (${pkg.version})` }
        : { pass: false, note: `报告 ${JSON.stringify(got.trim())}，实际 ${pkg.version}` };
    },
  },
  {
    id: "filter-lines",
    covers: "精确过滤（数符合特定前缀的行）",
    task:
      '读取 docs/04-roadmap.md，统计其中以 "- [x]" 开头的行（已完成的 checklist 项）有多少条，把纯数字写入 eval-out/done-count.txt',
    async check(workdir) {
      const got = await readOut(workdir, "eval-out/done-count.txt");
      if (got === undefined) return { pass: false, note: "done-count.txt 未创建" };
      const md = (await readOut(workdir, "docs/04-roadmap.md")) ?? "";
      const actual = md.split("\n").filter((l) => l.startsWith("- [x]")).length;
      return Number(got.trim()) === actual
        ? { pass: true, note: `过滤计数正确 (${actual})` }
        : { pass: false, note: `报告 ${got.trim()}，实际 ${actual}` };
    },
  },
  {
    id: "combine-titles",
    covers: "多文件合成（各取标题拼装，格式约束）",
    task:
      "分别读取 docs/01-philosophy.md 和 docs/02-architecture.md 的第一行标题（去掉开头的 # 号），写入 eval-out/titles.txt，格式为两行：第一行 '01: <标题>'，第二行 '02: <标题>'",
    async check(workdir) {
      const got = await readOut(workdir, "eval-out/titles.txt");
      if (got === undefined) return { pass: false, note: "titles.txt 未创建" };
      const title = (md: string) => (md.split("\n")[0] ?? "").replace(/^#+\s*/, "").trim();
      const t1 = title((await readOut(workdir, "docs/01-philosophy.md")) ?? "");
      const t2 = title((await readOut(workdir, "docs/02-architecture.md")) ?? "");
      const ok1 = got.includes("01:") && got.includes(t1.slice(0, 6));
      const ok2 = got.includes("02:") && got.includes(t2.slice(0, 6));
      return ok1 && ok2
        ? { pass: true, note: "两个标题格式正确" }
        : { pass: false, note: `缺失: ${!ok1 ? "01标题 " : ""}${!ok2 ? "02标题" : ""}` };
    },
  },
  {
    id: "sort-filenames",
    covers: "列举 + 排序（确定性输出）",
    task:
      "列出 src/tools/ 目录下所有 .ts 文件的文件名（不含路径），按字母顺序排序，用英文逗号连接成一行写入 eval-out/tools-sorted.txt",
    async check(workdir) {
      const got = await readOut(workdir, "eval-out/tools-sorted.txt");
      if (got === undefined) return { pass: false, note: "tools-sorted.txt 未创建" };
      const files = (await readdir(path.join(workdir, "src/tools")))
        .filter((f) => f.endsWith(".ts"))
        .sort();
      const reported = got.trim().split(",").map((s) => s.trim()).filter(Boolean).sort();
      const same = reported.length === files.length && reported.every((f, i) => f === files[i]);
      return same
        ? { pass: true, note: `文件名与排序均正确 (${files.length} 个)` }
        : { pass: false, note: `报告 [${reported.join(",")}]，实际 [${files.join(",")}]` };
    },
  },
  {
    id: "count-interfaces",
    covers: "代码自省（精确统计源码结构）",
    task:
      '读取 src/types.ts，统计其中以 "export interface" 开头的行有多少个（即导出的接口数量），把纯数字写入 eval-out/iface-count.txt',
    async check(workdir) {
      const got = await readOut(workdir, "eval-out/iface-count.txt");
      if (got === undefined) return { pass: false, note: "iface-count.txt 未创建" };
      const src = (await readOut(workdir, "src/types.ts")) ?? "";
      const actual = src.split("\n").filter((l) => l.startsWith("export interface")).length;
      return Number(got.trim()) === actual
        ? { pass: true, note: `接口数正确 (${actual})` }
        : { pass: false, note: `报告 ${got.trim()}，实际 ${actual}` };
    },
  },

  // ————— 陷阱用例（trap-*）：瞄准模型爱犯的错，且可被独立复核抓到 —————
  {
    id: "trap-inclusive-range",
    covers: "陷阱：栅栏错（含两端的区间计数）",
    task:
      "docs/04-roadmap.md 从第 10 行到第 20 行（包含第 10 行和第 20 行本身）之间一共有多少行？把纯数字写入 eval-out/range.txt",
    async check(workdir) {
      const got = await readOut(workdir, "eval-out/range.txt");
      if (got === undefined) return { pass: false, note: "range.txt 未创建" };
      // 含两端 = 20 - 10 + 1 = 11（典型 off-by-one 会答 10）
      return Number(got.trim()) === 11
        ? { pass: true, note: "含两端计数正确 (11)" }
        : { pass: false, note: `报告 ${got.trim()}，正解 11（含两端）` };
    },
  },
  {
    id: "trap-no-newline",
    covers: "陷阱：严格格式（无末尾换行、无多余字符）",
    task:
      "统计 src/types.ts 的总行数，把这个纯数字写入 eval-out/exact.txt。要求：文件内容必须【只有】这个数字本身，末尾不能有换行符，不能有任何空格、说明文字或其他字符。",
    async check(workdir) {
      const got = await readOut(workdir, "eval-out/exact.txt");
      if (got === undefined) return { pass: false, note: "exact.txt 未创建" };
      const src = (await readOut(workdir, "src/types.ts")) ?? "";
      // 行数口径有歧义（wc -l 数换行符 vs 编辑器数段落，差 1）——这不是本陷阱要考的，
      // 两种口径都接受；本陷阱只考字节纪律：数字之外不允许任何尾随字符。
      // （2026-07-25 教训：曾只认 split 口径，把按 wc -l 答对且格式完美的 run 冤判为错）
      const nSplit = src.split("\n").length;
      const nWc = src.endsWith("\n") ? nSplit - 1 : nSplit;
      return got === String(nSplit) || got === String(nWc)
        ? { pass: true, note: `精确匹配无尾随字符 (${got})` }
        : { pass: false, note: `期望恰好 "${nWc}" 或 "${nSplit}"，实际 ${JSON.stringify(got.slice(0, 20))}（含尾随字符或数值错）` };
    },
  },
  {
    id: "trap-h2-count",
    covers: "陷阱：干扰计数（严格前缀，排除更深层级）",
    task:
      "统计 README.md 中二级标题的数量——即严格以 '## '（两个井号加空格）开头的行。注意：三级标题 '### ' 和更深的都【不】算。把纯数字写入 eval-out/h2.txt",
    async check(workdir) {
      const got = await readOut(workdir, "eval-out/h2.txt");
      if (got === undefined) return { pass: false, note: "h2.txt 未创建" };
      const md = (await readOut(workdir, "README.md")) ?? "";
      // 严格 '## ' 开头，但不能是 '### '（即第三个字符必须不是 #）
      const actual = md.split("\n").filter((l) => l.startsWith("## ") && !l.startsWith("### ")).length;
      return Number(got.trim()) === actual
        ? { pass: true, note: `二级标题计数正确 (${actual})` }
        : { pass: false, note: `报告 ${got.trim()}，实际 ${actual}（可能把 ### 也算进去了）` };
    },
  },
  {
    id: "trap-conditional",
    covers: "陷阱：多分支条件（奇偶 → 不同产出）",
    task:
      "用 wc -l 的口径（即换行符的个数）统计 src/loop.ts 的总行数。如果行数是偶数，就在 eval-out/parity.txt 中写入 'even'（不含引号）；如果是奇数，就写入 src/loop.ts 中第一个以 'import' 开头的行的完整内容（原样，去掉首尾空白）。",
    async check(workdir) {
      const got = await readOut(workdir, "eval-out/parity.txt");
      if (got === undefined) return { pass: false, note: "parity.txt 未创建" };
      const src = (await readOut(workdir, "src/loop.ts")) ?? "";
      // 口径必须与任务文本一致（wc -l）：奇偶陷阱考的是分支执行，不是行数口径之争。
      // （2026-07-25 教训：曾用 split 口径判定，与任务的自然理解差 1 行导致奇偶反转，全员冤判）
      const lines = src.split("\n").length - (src.endsWith("\n") ? 1 : 0);
      const expected =
        lines % 2 === 0
          ? "even"
          : (src.split("\n").find((l) => l.startsWith("import")) ?? "").trim();
      return got.trim() === expected
        ? { pass: true, note: `分支正确（${lines % 2 === 0 ? "偶" : "奇"}数, ${lines} 行）` }
        : { pass: false, note: `期望 ${JSON.stringify(expected.slice(0, 40))}，实际 ${JSON.stringify(got.trim().slice(0, 40))}` };
    },
  },

  // ————— 高难陷阱（hard-*）：多约束组合 / 跨文件推理 / 工具语义细节，
  //        面向能过 trap-* 的模型（flash 级）设计。设计纪律（2026-07-25 教训）：
  //        任务文本必须把判定口径写死，checker 与口径逐字一致，不留歧义。 —————
  {
    id: "hard-unused-deps",
    covers: "高难：跨文件依赖分析（子路径导入的前缀匹配陷阱）",
    task:
      "找出 package.json 的 dependencies 与 devDependencies 中，src/ 目录（含子目录）的 .ts 源码从未 import 过的包。判定规则：一个包算被使用，当且仅当存在以 import 开头的语句，其模块标识符恰好等于包名、或以「包名+/」开头（子路径导入也算使用）。把未被使用的包名按字母升序、用英文逗号连接成一行写入 eval-out/unused-deps.txt；若全部被使用则写 none。",
    async check(workdir) {
      const got = await readOut(workdir, "eval-out/unused-deps.txt");
      if (got === undefined) return { pass: false, note: "unused-deps.txt 未创建" };
      const pkg = JSON.parse((await readOut(workdir, "package.json"))!) as {
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      const deps = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)];
      const specs = await collectImportSpecs(workdir);
      const unused = deps
        .filter((d) => !specs.some((s) => s === d || s.startsWith(d + "/")))
        .sort();
      const expected = unused.length === 0 ? "none" : unused.join(",");
      return got.trim() === expected
        ? { pass: true, note: `未使用依赖判定正确 (${expected})` }
        : { pass: false, note: `期望 "${expected}"，实际 ${JSON.stringify(got.trim().slice(0, 80))}（子路径导入是否算了使用？）` };
    },
  },
  {
    id: "hard-import-list",
    covers: "高难：多约束组合（扫描+过滤+去重+排序+精确格式+字节纪律）",
    task:
      "收集 src/ 目录（含子目录）所有 .ts 文件中、以 import 开头的行里第一个双引号内的模块标识符，只保留不以 . 开头的（即外部/内置模块）。去重、按字母升序（ASCII 顺序）排序，用英文逗号连接成一行写入 eval-out/import-list.txt。要求：文件内容必须只有这一行，末尾不能有换行符或任何其他字符。",
    async check(workdir) {
      const got = await readOut(workdir, "eval-out/import-list.txt");
      if (got === undefined) return { pass: false, note: "import-list.txt 未创建" };
      const expected = (await collectImportSpecs(workdir)).join(",");
      if (got === expected) return { pass: true, note: `列表与字节格式均正确 (${expected.split(",").length} 项)` };
      return got.trim() === expected
        ? { pass: false, note: "列表正确但含尾随字符（换行/空格）" }
        : { pass: false, note: `期望 "${expected.slice(0, 60)}…"，实际 ${JSON.stringify(got.slice(0, 60))}` };
    },
  },
  {
    id: "hard-substring-count",
    covers: "高难：工具语义（grep -c 数行 vs 子串出现总次数）",
    task:
      "统计 src/loop.ts 的文件内容中，字符串 'turn'（小写四个字母，区分大小写）作为子串出现的总次数。注意：要数的是出现次数，不是包含它的行数——一行出现多次要都算上；出现在别的单词内部也算（例如 return 里含有一个 turn，计 1 次）。把纯数字写入 eval-out/turn-count.txt。",
    async check(workdir) {
      const got = await readOut(workdir, "eval-out/turn-count.txt");
      if (got === undefined) return { pass: false, note: "turn-count.txt 未创建" };
      const src = (await readOut(workdir, "src/loop.ts")) ?? "";
      const actual = src.split("turn").length - 1;
      const lineCount = src.split("\n").filter((l) => l.includes("turn")).length;
      if (Number(got.trim()) === actual) return { pass: true, note: `子串计数正确 (${actual})` };
      const hint = Number(got.trim()) === lineCount ? "（这是行数——grep -c 的坑）" : "";
      return { pass: false, note: `报告 ${got.trim()}，实际 ${actual} ${hint}` };
    },
  },
  {
    id: "hard-chain",
    covers: "高难：跨文件依赖链（计数结果作为另一文件的行号索引）",
    task:
      "第一步：统计 src/types.ts 中以 'export interface' 开头的行数，记为 K。第二步：取 src/verifier.ts 的第 K 行（1-indexed，文件第一行是第 1 行），去掉首尾空白。把「K:该行内容」写入 eval-out/chain.txt——K 替换为实际数字，冒号为英文冒号，冒号后直接跟内容不加空格。",
    async check(workdir) {
      const got = await readOut(workdir, "eval-out/chain.txt");
      if (got === undefined) return { pass: false, note: "chain.txt 未创建" };
      const types = (await readOut(workdir, "src/types.ts")) ?? "";
      const k = types.split("\n").filter((l) => l.startsWith("export interface")).length;
      const verifier = (await readOut(workdir, "src/verifier.ts")) ?? "";
      const lineK = (verifier.split("\n")[k - 1] ?? "").trim();
      const expected = `${k}:${lineK}`;
      return got.trim() === expected
        ? { pass: true, note: `依赖链正确 (K=${k})` }
        : { pass: false, note: `期望 ${JSON.stringify(expected.slice(0, 50))}，实际 ${JSON.stringify(got.trim().slice(0, 50))}` };
    },
  },

  // ————— 极难套件（xhard-*）：多源聚合 / 长依赖链 / 字节级格式 / 成文规则 vs 直觉。
  //        为 hard-* 已被 flash 基本攻克（仅 import-list 存区分度）而设。
  //        设计纪律同 hard-*：任务文本写死口径，checker 逐字同口径，事实先程序化采集。 —————
  {
    id: "xhard-script-imports",
    covers: "极难：多源聚合（scripts 入口 × 各自的相对依赖计数 × 排序格式）",
    task:
      "读取 package.json 的 scripts。对其中每个以 'tsx ' 开头的 script，取命令的第二个空格分隔段作为入口文件；统计该入口文件中【以 import 开头、且第一个双引号内的模块标识符以 ./ 或 ../ 开头】的行数。把结果按 script 名字母升序，每行一条，格式 'script名:数量'，写入 eval-out/script-imports.txt。",
    async check(workdir) {
      const got = await readOut(workdir, "eval-out/script-imports.txt");
      if (got === undefined) return { pass: false, note: "script-imports.txt 未创建" };
      const pkg = JSON.parse((await readOut(workdir, "package.json"))!) as {
        scripts: Record<string, string>;
      };
      const expected = (
        await Promise.all(
          Object.entries(pkg.scripts)
            .filter(([, cmd]) => cmd.startsWith("tsx "))
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(async ([name, cmd]) => {
              const entry = cmd.split(" ")[1]!;
              const src = (await readOut(workdir, entry)) ?? "";
              const n = src
                .split("\n")
                .filter((l) => l.startsWith("import") && /^\.\.?\//.test(l.match(/"([^"]+)"/)?.[1] ?? "")).length;
              return `${name}:${n}`;
            }),
        )
      ).join("\n");
      return got.trim().replace(/\r/g, "") === expected
        ? { pass: true, note: `聚合正确 (${expected.replace(/\n/g, " ")})` }
        : { pass: false, note: `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(got.trim().slice(0, 60))}` };
    },
  },
  {
    id: "xhard-export-chain",
    covers: "极难：长依赖链（入口 → 本地依赖集 → 逐文件统计 → 聚合）",
    task:
      "第一步：找出 src/loop.ts 中以 import 开头、且第一个双引号内的标识符以 ./ 开头的行，收集这些相对模块（去重）。第二步：把每个模块映射为源文件（相对 src/ 解析，.js 后缀换成 .ts）。第三步：统计每个源文件中以 'export function '、'export const '、'export class '、'export interface '、'export type ' 之一开头的行数。把所有文件的计数总和（纯数字）写入 eval-out/export-chain.txt。",
    async check(workdir) {
      const got = await readOut(workdir, "eval-out/export-chain.txt");
      if (got === undefined) return { pass: false, note: "export-chain.txt 未创建" };
      const loop = (await readOut(workdir, "src/loop.ts")) ?? "";
      const locals = [
        ...new Set(
          loop
            .split("\n")
            .filter((l) => l.startsWith("import"))
            .map((l) => l.match(/"(\.\/[^"]+)"/)?.[1])
            .filter((s): s is string => !!s),
        ),
      ];
      let total = 0;
      for (const m of locals) {
        const src = (await readOut(workdir, path.join("src", m.replace(/\.js$/, ".ts")))) ?? "";
        total += src
          .split("\n")
          .filter((l) => /^export (function|const|class|interface|type) /.test(l)).length;
      }
      return Number(got.trim()) === total
        ? { pass: true, note: `依赖链聚合正确 (${total}，${locals.length} 个模块)` }
        : { pass: false, note: `报告 ${got.trim()}，实际 ${total}` };
    },
  },
  {
    id: "xhard-csv-bytes",
    covers: "极难：字节级产物（LF 换行、无尾随字节、精确表格式）",
    task:
      "生成 eval-out/lines.csv，内容恰好三行：第一行表头 'name,lines'；第二行 'loop.ts,<N1>'；第三行 'verifier.ts,<N2>'。N1/N2 分别是 src/loop.ts 与 src/verifier.ts 的行数（wc -l 口径，即换行符个数）。字节要求：行与行之间用 LF（\\n）分隔，不能出现 CR（\\r），最后一行末尾不能有换行或任何其他字符。",
    async check(workdir) {
      const got = await readOut(workdir, "eval-out/lines.csv");
      if (got === undefined) return { pass: false, note: "lines.csv 未创建" };
      const wc = async (rel: string): Promise<number> => {
        const s = (await readOut(workdir, rel)) ?? "";
        return s.split("\n").length - (s.endsWith("\n") ? 1 : 0);
      };
      const expected = `name,lines\nloop.ts,${await wc("src/loop.ts")}\nverifier.ts,${await wc("src/verifier.ts")}`;
      if (got === expected) return { pass: true, note: "字节级精确匹配" };
      if (got.includes("\r")) return { pass: false, note: "含 CR（CRLF 换行）——要求 LF" };
      return got.replace(/\n+$/, "") === expected
        ? { pass: false, note: "内容正确但末尾有多余换行" }
        : { pass: false, note: `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(got.slice(0, 50))}` };
    },
  },
  {
    id: "xhard-report-arms",
    covers: "极难：多文件模式提取（正则口径成文，跨 6+ 份报告去重排序）",
    task:
      "在 eval/ 目录下所有文件名以 ab-report 开头、以 .md 结尾的文件里，找出符合形态「| 臂名 | 数字% |」开头的表格行（即正则 /^\\| (\\S+) \\| \\d+% \\|/ 匹配的行），收集第一列的臂名。去重、按字母升序、用英文逗号连接成一行写入 eval-out/arms.txt。",
    async check(workdir) {
      const got = await readOut(workdir, "eval-out/arms.txt");
      if (got === undefined) return { pass: false, note: "arms.txt 未创建" };
      const arms = new Set<string>();
      for (const f of (await readdir(path.join(workdir, "eval"))).filter(
        (f) => f.startsWith("ab-report") && f.endsWith(".md"),
      )) {
        for (const l of ((await readOut(workdir, path.join("eval", f))) ?? "").split("\n")) {
          const m = l.match(/^\| (\S+) \| \d+% \|/);
          if (m) arms.add(m[1]!);
        }
      }
      const expected = [...arms].sort().join(",");
      return got.trim() === expected
        ? { pass: true, note: `臂名集合正确 (${arms.size} 个)` }
        : { pass: false, note: `期望 "${expected}"，实际 ${JSON.stringify(got.trim().slice(0, 80))}` };
    },
  },
  {
    id: "xhard-unimported-tools",
    covers: "极难：成文规则 vs 直觉（只看 cli.ts 的直接 import，不管间接使用）",
    task:
      "src/tools/ 目录下有若干 .ts 工具文件。找出其中【没有被 src/cli.ts 直接 import】的文件——判定规则：src/cli.ts 中以 import 开头的行里，双引号内出现 './tools/<文件名>.js' 才算被直接 import；被其他模块间接引用【不算】。把未被直接 import 的文件名（不含 .ts 后缀）按字母升序、英文逗号连接写入 eval-out/unimported.txt；若全部被直接 import 则写 none。",
    async check(workdir) {
      const got = await readOut(workdir, "eval-out/unimported.txt");
      if (got === undefined) return { pass: false, note: "unimported.txt 未创建" };
      const cli = (await readOut(workdir, "src/cli.ts")) ?? "";
      const imported = new Set(
        cli
          .split("\n")
          .filter((l) => l.startsWith("import"))
          .map((l) => l.match(/"\.\/tools\/([^"]+)\.js"/)?.[1])
          .filter((s): s is string => !!s),
      );
      const all = (await readdir(path.join(workdir, "src/tools")))
        .filter((f) => f.endsWith(".ts"))
        .map((f) => f.replace(/\.ts$/, ""));
      const missing = all.filter((t) => !imported.has(t)).sort();
      const expected = missing.length === 0 ? "none" : missing.join(",");
      return got.trim() === expected
        ? { pass: true, note: `直接导入判定正确 (${expected})` }
        : { pass: false, note: `期望 "${expected}"，实际 ${JSON.stringify(got.trim().slice(0, 60))}（间接引用算进去了？）` };
    },
  },

  // ————— 变更+回归套件（mut-*）：改代码不许破坏既有行为。错误面比只读任务大一个
  //        量级：判定 = 既有测试全过 + 新行为探针 + 测试文件未被篡改。
  //        fixture 项目由 setup 复制进 eval-out/proj——agent 永不触碰仓库本体。 —————
  {
    id: "mut-fix-throw",
    covers: "变更：缺陷修复 + 回归地雷（单点区间 3-3 必须继续合法）",
    task:
      "eval-out/proj 是一个已就位的 Node 项目（npm test 即 node --test）。已知缺陷：src/range.js 的 parseRange 在起点大于终点（如 '5-3'）时静默返回空数组。请修复：这种输入必须抛出 RangeError，错误消息包含 'invalid range'。硬性要求：test/ 目录的既有测试一个都不许改、npm test 必须全部通过；除修复所必需外不得改变任何其他行为。",
    setup: setupMiniRange,
    async check(workdir) {
      const proj = path.join(workdir, "eval-out/proj");
      if (!(await testsUntouched(workdir))) return { pass: false, note: "test/ 被篡改（禁止改测试凑通过）" };
      const tests = await runNode(proj, ["--test"]);
      if (!tests.ok) return { pass: false, note: `既有测试回归：${tests.out.split("\n").find((l) => l.includes("not ok")) ?? "非零退出"}` };
      const p = await probe(
        proj,
        `assert.throws(() => range.parseRange("5-3"), (e) => e instanceof RangeError && /invalid range/.test(e.message));
assert.deepEqual(range.parseRange("3-3"), [3]);
assert.deepEqual(range.parseRange("1-4"), [1, 2, 3, 4]);`,
      );
      return p.ok
        ? { pass: true, note: "修复生效且零回归（3-3 单点区间保住）" }
        : { pass: false, note: `行为探针失败：${p.out.trim().split("\n").at(-1)?.slice(0, 100)}` };
    },
  },
  {
    id: "mut-add-clamp",
    covers: "变更：新增导出函数，既有行为一毫不动",
    task:
      "eval-out/proj 是一个已就位的 Node 项目（npm test 即 node --test）。在 src/stats.js 新增并导出函数 clamp(value, min, max)：返回被夹在 [min, max] 区间内的 value；当 min > max 时抛出 RangeError。硬性要求：test/ 目录的既有测试一个都不许改、npm test 必须全部通过；既有导出函数（sum/avg/rangeSum）的行为不得有任何变化。",
    setup: setupMiniRange,
    async check(workdir) {
      const proj = path.join(workdir, "eval-out/proj");
      if (!(await testsUntouched(workdir))) return { pass: false, note: "test/ 被篡改" };
      const tests = await runNode(proj, ["--test"]);
      if (!tests.ok) return { pass: false, note: "既有测试回归" };
      const p = await probe(
        proj,
        `assert.equal(stats.clamp(5, 1, 3), 3);
assert.equal(stats.clamp(-1, 0, 10), 0);
assert.equal(stats.clamp(4, 1, 9), 4);
assert.throws(() => stats.clamp(1, 3, 2), RangeError);
assert.equal(stats.sum([1, 2, 3]), 6);
assert.equal(stats.avg([2, 4]), 3);
assert.equal(stats.rangeSum("1-4"), 10);`,
      );
      return p.ok
        ? { pass: true, note: "clamp 行为正确且既有函数无回归" }
        : { pass: false, note: `行为探针失败：${p.out.trim().split("\n").at(-1)?.slice(0, 100)}` };
    },
  },
  {
    id: "mut-rename",
    covers: "变更：跨文件重命名（源码与测试全量同步，漏一处即挂）",
    task:
      "eval-out/proj 是一个已就位的 Node 项目（npm test 即 node --test）。把导出函数 sum 重命名为 total——src/ 与 test/ 中所有定义、导入、调用全部同步更新；rangeSum 的名字保持不变（只是内部改调 total）；对外行为完全不变；npm test 必须全部通过。完成后源码与测试中不得再出现独立标识符 sum（rangeSum 不算）。",
    setup: setupMiniRange,
    async check(workdir) {
      const proj = path.join(workdir, "eval-out/proj");
      const tests = await runNode(proj, ["--test"]);
      if (!tests.ok) return { pass: false, note: "测试未全过（改漏了引用？）" };
      const files = ["src/range.js", "src/stats.js", "test/range.test.js"];
      for (const f of files) {
        const src = (await readOut(workdir, path.join("eval-out/proj", f))) ?? "";
        if (/\bsum\b/.test(src)) return { pass: false, note: `${f} 中仍存在独立标识符 sum` };
      }
      const p = await probe(
        proj,
        `assert.equal(stats.total([1, 2, 3]), 6);
assert.equal(stats.avg([2, 4]), 3);
assert.equal(stats.rangeSum("2-4"), 9);
assert.equal(typeof stats.sum, "undefined");`,
      );
      return p.ok
        ? { pass: true, note: "重命名完整：total 生效、sum 消失、行为不变" }
        : { pass: false, note: `行为探针失败：${p.out.trim().split("\n").at(-1)?.slice(0, 100)}` };
    },
  },

  // ————— 规模压力套件（scale-*）：60 模块生成式 fixture（eval/scale-fixture.ts,
  //        确定性种子——生成逻辑即口径）。针对"快 oracle 导致饱和"对症下药：
  //        传递闭包 grep 抗性 + 不完备测试覆盖（9/60）抓不住漏改。 —————
  {
    id: "scale-audit",
    covers: "规模：60 模块依赖图的传递闭包（只查直接依赖会漏一半以上）",
    task:
      "eval-out/proj 是一个 60 模块的 Node 项目（src/m00.js…m59.js，另有 src/legacy.js）。找出所有【直接或间接】依赖 src/legacy.js 的模块——判定规则：模块 A 依赖 legacy 当且仅当 A 直接 import 了 legacy.js，或 A import 的某个模块（传递地）依赖 legacy。把这些模块名（不含 .js 后缀、不含 legacy 自身）按字母升序、英文逗号连接成一行写入 eval-out/legacy-closure.txt。",
    async setup(workdir) {
      const { writeScaleFixture } = await import("./scale-fixture.js");
      await writeScaleFixture(path.join(workdir, "eval-out/proj"));
    },
    async check(workdir) {
      const got = await readOut(workdir, "eval-out/legacy-closure.txt");
      if (got === undefined) return { pass: false, note: "legacy-closure.txt 未创建" };
      const { genPlan, legacyClosure } = await import("./scale-fixture.js");
      const plan = genPlan();
      const expected = legacyClosure(plan).join(",");
      if (got.trim() === expected) return { pass: true, note: `闭包正确 (${expected.split(",").length} 个)` };
      const directOnly = plan.legacyDirect.slice().sort().join(",");
      const hint = got.trim() === directOnly ? "（只算了直接依赖——传递闭包漏了）" : "";
      return { pass: false, note: `期望 ${expected.split(",").length} 个，实际 ${got.trim().split(",").length} 个 ${hint}` };
    },
  },
  {
    id: "scale-double",
    covers: "规模：60 文件批量变更 + 不完备 oracle（测试只覆盖 9/60，漏改抓不住）",
    task:
      "eval-out/proj 是一个 60 模块的 Node 项目。把 src/m00.js…m59.js 每个文件中 LIMIT 常量的数值改为原值的两倍——只改这个数值，legacy.js 与 test/ 目录不得改动，每个文件的其余内容一字不变。npm test（即 node --test，注意它只覆盖部分模块）必须全部通过。",
    async setup(workdir) {
      const { writeScaleFixture } = await import("./scale-fixture.js");
      await writeScaleFixture(path.join(workdir, "eval-out/proj"));
    },
    async check(workdir) {
      const proj = path.join(workdir, "eval-out/proj");
      const { genPlan, moduleSource } = await import("./scale-fixture.js");
      const plan = genPlan();
      const tests = await runNode(proj, ["--test"]);
      if (!tests.ok) return { pass: false, note: "测试未全过" };
      const legacyNow = await readOut(workdir, "eval-out/proj/src/legacy.js");
      if (legacyNow !== `// deprecated shared module\nexport const LEGACY = true;\n`) {
        return { pass: false, note: "legacy.js 被改动（要求不动）" };
      }
      let wrong = 0;
      let firstWrong = "";
      for (const name of plan.modules) {
        const now = await readOut(workdir, `eval-out/proj/src/${name}.js`);
        const expected = moduleSource(plan, name, plan.limits[name]! * 2);
        if (now !== expected) {
          wrong += 1;
          if (!firstWrong) firstWrong = name;
        }
      }
      return wrong === 0
        ? { pass: true, note: "60 个文件全部精确翻倍，无附带改动" }
        : { pass: false, note: `${wrong}/60 个文件不符（首个: ${firstWrong}）——漏改/多改/格式漂移（测试只覆盖 9 个，抓不住）` };
    },
  },

  // ————— 并行编排套件（par-*，v1.1）：fan-out 形状的任务——互不重叠的分片 +
  //        依赖全部分片的汇总。用于 planned-serial vs planned-parallel 墙钟 A/B
  //        与 planner 依赖图产出质量观测（拆不拆、dependsOn 对不对是被测变量）。 —————
  {
    id: "par-fanout",
    covers: "并行：三个互不重叠分片统计 + 依赖全部分片的汇总（fan-out + 汇聚形状）",
    task:
      "eval-out/proj 是一个 60 模块的 Node 项目（src/m00.js…m59.js，每个模块导出一个整数常量 LIMIT）。产出三份分区统计与一份汇总，四个文件都只含一行纯数字、无其他内容：\n" +
      "- eval-out/part-a.txt：m00…m19 这 20 个模块的 LIMIT 之和\n" +
      "- eval-out/part-b.txt：m20…m39 的 LIMIT 之和\n" +
      "- eval-out/part-c.txt：m40…m59 的 LIMIT 之和\n" +
      "- eval-out/grand-total.txt：以上三个分区之和\n" +
      "判定规则：每个和都按对应文件里 `export const LIMIT = <数值>;` 的字面数值计算；legacy.js 不属于任何分区。",
    async setup(workdir) {
      const { writeScaleFixture } = await import("./scale-fixture.js");
      await writeScaleFixture(path.join(workdir, "eval-out/proj"));
    },
    // 参考拆解：3 个独立分片 + 依赖全部分片的汇总（fixed-* 臂用,隔离调度器测墙钟）
    plan: {
      subtasks: [
        ...([
          ["sa", "a", "m00.js…m19.js", "m00…m19"],
          ["sb", "b", "m20.js…m39.js", "m20…m39"],
          ["sc", "c", "m40.js…m59.js", "m40…m59"],
        ] as const).map(([id, part, files, range]) => ({
          id,
          title: `分区 ${part.toUpperCase()} 求和`,
          pack: null,
          description:
            `eval-out/proj/src/ 下 ${files} 共 20 个文件,每个文件里恰有一行 \`export const LIMIT = <数值>;\`。` +
            `把 ${range} 这 20 个 LIMIT 数值之和写入 eval-out/part-${part}.txt——文件只含一行纯数字、无其他内容。` +
            `只准读这 20 个文件和写这一个输出文件,不得动其他任何文件。`,
          acceptance: [
            `eval-out/part-${part}.txt 存在且只含一行纯数字`,
            `数值等于 ${range} 各文件 LIMIT 字面值之和`,
          ],
          dependsOn: [],
        })),
        {
          id: "sd",
          title: "汇总",
          pack: null,
          description:
            "读取 eval-out/part-a.txt、eval-out/part-b.txt、eval-out/part-c.txt(各含一行纯数字),把三个数值之和写入 eval-out/grand-total.txt——文件只含一行纯数字、无其他内容。不得重新统计源文件,以三个 part 文件为准。",
          acceptance: [
            "eval-out/grand-total.txt 存在且只含一行纯数字",
            "数值等于三个 part 文件数值之和",
          ],
          dependsOn: ["sa", "sb", "sc"],
        },
      ],
    },
    async check(workdir) {
      const { genPlan } = await import("./scale-fixture.js");
      const plan = genPlan();
      const shard = (from: number, to: number) =>
        plan.modules
          .slice(from, to)
          .reduce((acc, name) => acc + plan.limits[name]!, 0);
      const expected: [string, number][] = [
        ["part-a.txt", shard(0, 20)],
        ["part-b.txt", shard(20, 40)],
        ["part-c.txt", shard(40, 60)],
        ["grand-total.txt", shard(0, 60)],
      ];
      for (const [file, value] of expected) {
        const got = await readOut(workdir, `eval-out/${file}`);
        if (got === undefined) return { pass: false, note: `${file} 未创建` };
        if (got.trim() !== String(value)) {
          return { pass: false, note: `${file} 期望 ${value}，实际 ${got.trim().slice(0, 50)}` };
        }
      }
      return { pass: true, note: "三个分区与汇总全部正确" };
    },
  },
];

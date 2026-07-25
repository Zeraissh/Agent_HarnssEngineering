/**
 * 评估基线用例：5 个固定任务，覆盖框架的核心行为面。
 * 每个用例的 check() 是程序化判定 —— 不靠人眼，保证可重复回归。
 * 产出统一写到 eval-out/（.gitignore），check 只看实际文件。
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

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
  check(workdir: string): Promise<{ pass: boolean; note: string }>;
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
];

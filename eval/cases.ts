/**
 * 评估基线用例：5 个固定任务，覆盖框架的核心行为面。
 * 每个用例的 check() 是程序化判定 —— 不靠人眼，保证可重复回归。
 * 产出统一写到 eval-out/（.gitignore），check 只看实际文件。
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

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
];

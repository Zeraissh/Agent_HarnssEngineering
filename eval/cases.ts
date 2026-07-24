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
];

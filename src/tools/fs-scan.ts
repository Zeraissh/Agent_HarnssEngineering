/**
 * L2 — `glob` / `grep` 共用的目录遍历与 glob 语法。
 *
 * 为什么单独一层：两个工具的圈禁、忽略规则、符号链接处置、遍历上限必须**逐字一致**。
 * 一旦分头实现，"glob 找得到但 grep 搜不到"这类不一致会让模型在两个工具之间反复横跳，
 * 而这种缝在单测里各自都是绿的（本仓已有五类"纯函数全绿而组合起来错"的教训）。
 *
 * 三条硬纪律：
 * - **圈禁**：所有落地路径都由调用方先过 `resolveReadable`（workdir + 只读根），
 *   本层再拒绝一切符号链接/junction——遍历期间不跟随链接，圈禁就不必在每个目录项上重算。
 * - **不跟随符号链接**：既是圈禁的一部分，也顺手消掉了目录环导致的无限递归。
 * - **有界**：遍历的目录项总数、返回条数、单文件大小都有上限，超限必须**说出来**
 *   （静默截断会让模型把半份结果当全量，比报错更糟——与 registry 的入口截断同一条纪律）。
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { resolveReadable } from "./fs-util.js";

/**
 * 默认忽略的目录名。刻意只有两个：`node_modules` 与 `.git` 是"几乎不可能想搜"的
 * 体量大户，除此之外一律不猜——把 `dist`/`build` 也默认忽略会在"检查构建产物"这类
 * 任务上静默漏掉答案，那是自造的失败模式。需要看它们时传 `include_ignored: true`。
 */
export const DEFAULT_IGNORED_DIRS = ["node_modules", ".git"] as const;

/** 遍历目录项的总数上限：防止在超大树上把一次工具调用变成分钟级停顿 */
export const MAX_SCANNED_ENTRIES = 20_000;

export interface ScanOptions {
  /** 遍历根（绝对路径，调用方已过 resolveReadable） */
  root: string;
  /** false（缺省）= 跳过 DEFAULT_IGNORED_DIRS */
  includeIgnored?: boolean;
  /** 只保留匹配它的相对 POSIX 路径；不传 = 全收 */
  match?: (relPosix: string) => boolean;
  /** 遍历目录项上限，缺省 MAX_SCANNED_ENTRIES */
  maxEntries?: number;
}

export interface ScanResult {
  /**
   * `files` 里的相对路径以它为基准（绝对路径）。root 指向文件时 base = 该文件所在目录，
   * 于是 `path.join(base, rel)` 在两种形态下都成立——调用方不必分支处理。
   */
  base: string;
  /** 相对 base 的 POSIX 路径，**按字典序**排序（见 scanFiles 的排序口径注释） */
  files: string[];
  /** 实际访问过的目录项数 */
  scanned: number;
  /** 是否因为撞上 maxEntries 而提前收工——真话必须能被调用方转达给模型 */
  scanTruncated: boolean;
  /** 因为在忽略名单里而整棵跳过的目录（相对 POSIX 路径） */
  skippedDirs: string[];
}

/**
 * 递归收集文件。
 *
 * **排序口径 = 相对 POSIX 路径的字典序**（`localeCompare` 不用，改用码点比较）。
 * 不按 mtime 排：mtime 序在 CI、容器与本机之间不可复现，而工具输出是要进正史、
 * 进报告、被逐字节比对的——可复现优先于"最近改过的排前面"这点便利。
 */
export async function scanFiles(opts: ScanOptions): Promise<ScanResult> {
  const maxEntries = opts.maxEntries ?? MAX_SCANNED_ENTRIES;
  const ignored = new Set<string>(opts.includeIgnored ? [] : DEFAULT_IGNORED_DIRS);
  const files: string[] = [];
  const skippedDirs: string[] = [];
  let scanned = 0;
  let scanTruncated = false;

  const walk = async (absDir: string, relDir: string): Promise<void> => {
    if (scanTruncated) return;
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      // 读不动的目录（权限/竞态删除）跳过即可：一个子树不可达不该让整次调用失败
      return;
    }
    // readdir 的顺序随文件系统而变；先排序再递归，深度优先的输出顺序才是确定的
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (scanTruncated) return;
      scanned += 1;
      if (scanned > maxEntries) {
        scanTruncated = true;
        return;
      }
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      // 符号链接/junction 一律不跟随：圈禁 + 防目录环，两件事一条规则
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (ignored.has(entry.name)) {
          skippedDirs.push(rel);
          continue;
        }
        await walk(path.join(absDir, entry.name), rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (opts.match && !opts.match(rel)) continue;
      files.push(rel);
    }
  };

  const rootStat = await stat(opts.root);
  if (rootStat.isFile()) {
    // 单文件根：调用方给的是文件而不是目录。base 退到它的父目录，rel = 文件名。
    const name = path.basename(opts.root);
    if (!opts.match || opts.match(name)) files.push(name);
    return { base: path.dirname(opts.root), files, scanned: 1, scanTruncated: false, skippedDirs: [] };
  }
  await walk(opts.root, "");
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { base: opts.root, files, scanned, scanTruncated, skippedDirs };
}

/**
 * 解析 `glob`/`grep` 的搜索根：缺省 = workdir，否则走与 `read_file` 完全同一条
 * 只读圈禁（workdir + `AGENT_READ_ROOTS`）。两个工具共用它，圈禁语义就不可能分叉。
 */
export function resolveScanRoot(
  workdir: string,
  readRoots: string[] | undefined,
  dir: string | undefined,
): string {
  if (dir === undefined || dir === "") return path.resolve(workdir);
  return resolveReadable(workdir, readRoots, dir);
}

/** 正则元字符转义（glob 翻译时对字面量部分用） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * glob → RegExp。支持的构造刻意收窄到模型真会写的那几个：
 *
 * | 构造 | 语义 |
 * |---|---|
 * | `**` | 任意层级目录（含零层） |
 * | `*`  | 单个路径段内的任意字符（不跨 `/`） |
 * | `?`  | 单个非 `/` 字符 |
 * | `{a,b}` | 择一（不支持嵌套花括号） |
 * | `[abc]` / `[a-z]` / `[!abc]` | 字符类 |
 *
 * **大小写敏感**，跨平台一致——不跟随 Windows 文件系统的大小写不敏感，
 * 否则同一份测试在 win32 与 ubuntu 上判定不同（本仓在 CI 首跑就被这类平台形状
 * 断言咬过一次）。
 *
 * 不含 `/` 的 pattern 自动等价于 `**​/pattern`（`*.ts` = 任意深度的 .ts）——
 * 这是模型的普遍预期，不满足会让它反复试错。
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  const anchored = normalized.includes("/") ? normalized : `**/${normalized}`;
  return new RegExp(`^${translateGlob(anchored)}$`);
}

/**
 * 翻译主体。与 `globToRegExp` 分开是必须的：花括号的每个分支要按**字面**翻译，
 * 不能再走一遍"不含 `/` 就补 `**​/`"那条规则——否则 `*.{ts,tsx}` 里的 `ts`
 * 会被当成一个独立 glob 补成 `**​/ts`，模式当场失配。
 */
function translateGlob(anchored: string): string {
  let out = "";
  let i = 0;
  while (i < anchored.length) {
    const ch = anchored[i]!;
    if (ch === "*") {
      const isDouble = anchored[i + 1] === "*";
      if (isDouble) {
        // `**/` 吃掉零个或多个目录段；末尾的 `**` 吃任意后缀
        if (anchored[i + 2] === "/") {
          out += "(?:[^/]*/)*";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "{") {
      const close = anchored.indexOf("}", i);
      if (close === -1) {
        out += escapeRegExp(ch);
        i += 1;
        continue;
      }
      const alts = anchored.slice(i + 1, close).split(",");
      out += `(?:${alts.map((a) => translateGlob(a)).join("|")})`;
      i = close + 1;
      continue;
    }
    if (ch === "[") {
      const close = anchored.indexOf("]", i + 1);
      if (close === -1) {
        out += escapeRegExp(ch);
        i += 1;
        continue;
      }
      let body = anchored.slice(i + 1, close);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      out += `[${body}]`;
      i = close + 1;
      continue;
    }
    out += escapeRegExp(ch);
    i += 1;
  }
  return out;
}

/** 便捷判定：一条相对 POSIX 路径是否命中 glob。 */
export function matchesGlob(relPosix: string, pattern: string): boolean {
  return globToRegExp(pattern).test(relPosix);
}

/** 路径分隔符归一：对外一律 POSIX（Windows 反斜杠只在真正落盘时出现） */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * report-only / host bash 的轻量圈禁：在真正 spawn 之前拦掉**可静态判定**的
 * workdir 外写与外 `cd`。
 *
 * 这不是 SAFE-05 的 OS/容器边界——`python -c "open('../x','w')"`、经变量拼接的
 * 路径、以及未识别的写工具（`install`/`dd`…）仍可能漏过。目标是关掉 held-out
 * 与台账里已经出现的形态：`> ../file`、`cd .. && …`，使 `write_file` 与 bash
 * 在「圈外路径」上同向 fail-closed，而不是只靠模型自律。
 */
import path from "node:path";
import { resolveInWorkdir } from "./fs-util.js";

export type ShellConfineResult =
  | { ok: true }
  | { ok: false; reason: string };

/** 去掉包裹引号（仅当首尾成对时），供路径解析。 */
function unquote(token: string): string {
  if (token.length >= 2) {
    const a = token[0];
    const b = token[token.length - 1];
    if ((a === '"' || a === "'") && a === b) return token.slice(1, -1);
  }
  return token;
}

/**
 * 从 command 里抽出**写重定向**目标（`>` / `>>` / `>|`）。
 * 跳过 fd 重定向（`2>&1`、`>&2`、`&>`）与 here-doc / here-string（`<<` / `<<<`）
 * 及其正文（正文里的 `>` 不是 shell 重定向）。
 * 引号感知与 verifier.scanCommand 同族：引号内的 `>` 不当重定向。
 */
export function extractWriteRedirectTargets(command: string): string[] {
  const targets: string[] = [];
  let quote: '"' | "'" | null = null;
  let heredocDelim: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];

    if (heredocDelim !== null) {
      // 正文直到一行恰好等于 delim（可选前导 tab 由 <<- 产生——这里只认精确行）
      if (ch === "\n") {
        const lineStart = i + 1;
        const lineEnd = command.indexOf("\n", lineStart);
        const line = command.slice(lineStart, lineEnd === -1 ? command.length : lineEnd);
        if (line === heredocDelim) {
          heredocDelim = null;
          i = (lineEnd === -1 ? command.length : lineEnd) - 1;
        }
      }
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "\\" && next !== undefined) {
      i++;
      continue;
    }

    // << / <<- / <<<
    if (ch === "<" && next === "<") {
      let j = i + 2;
      if (command[j] === "<") {
        // <<< here-string：后面是词，不是正文块
        i = j;
        continue;
      }
      if (command[j] === "-") j++;
      while (j < command.length && /\s/.test(command[j]!)) j++;
      const tok = readShellToken(command, j);
      if (tok) {
        heredocDelim = unquote(tok.value);
        i = tok.end - 1;
      }
      continue;
    }

    if (ch !== ">") continue;

    // >> 或 >|
    if (next === ">" || next === "|") i++;

    let j = i + 1;
    while (j < command.length && /\s/.test(command[j]!)) j++;

    // >&N / &> ：fd 重定向（允许可选空白后的数字）
    if (command[j] === "&") {
      let k = j + 1;
      while (k < command.length && /\s/.test(command[k]!)) k++;
      if (k < command.length && /[0-9]/.test(command[k]!)) {
        i = j;
        continue;
      }
    }

    const token = readShellToken(command, j);
    if (!token) continue;
    const raw = unquote(token.value);
    if (/^&\d+$/.test(raw)) {
      i = token.end - 1;
      continue;
    }
    if (raw.length > 0) targets.push(raw);
    i = token.end - 1;
  }
  return targets;
}

function readShellToken(
  command: string,
  start: number,
): { value: string; end: number } | null {
  if (start >= command.length) return null;
  let i = start;
  let quote: '"' | "'" | null = null;
  let value = "";
  while (i < command.length) {
    const ch = command[i]!;
    if (quote) {
      value += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      value += ch;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      value += ch + command[i + 1]!;
      i += 2;
      continue;
    }
    if (/[\s;|&<>()]/.test(ch)) break;
    value += ch;
    i++;
  }
  return value.length > 0 ? { value, end: i } : null;
}

/**
 * 抽出 `cd` 的目标参数。无参数 → 空字符串（表示 $HOME，一律视为出圈）。
 * 引号外按 `;` `&&` `||` `|` 与换行切段，再找段首 `cd`。
 */
export function extractCdTargets(command: string): Array<string | null> {
  const targets: Array<string | null> = [];
  const segments = splitShellSegments(command);
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    const tok = readShellToken(trimmed, 0);
    if (!tok) continue;
    const name = unquote(tok.value);
    if (name !== "cd") continue;
    let j = tok.end;
    while (j < trimmed.length && /\s/.test(trimmed[j]!)) j++;
    if (j >= trimmed.length) {
      targets.push(null); // bare `cd` → HOME
      continue;
    }
    const arg = readShellToken(trimmed, j);
    if (!arg) {
      targets.push(null);
      continue;
    }
    targets.push(unquote(arg.value));
  }
  return targets;
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "\\" && next !== undefined) {
      buf += ch + next;
      i++;
      continue;
    }
    if (ch === ";") {
      segments.push(buf);
      buf = "";
      continue;
    }
    if ((ch === "&" || ch === "|") && next === ch) {
      segments.push(buf);
      buf = "";
      i++;
      continue;
    }
    if (ch === "|") {
      segments.push(buf);
      buf = "";
      continue;
    }
    if (ch === "\n") {
      segments.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  segments.push(buf);
  return segments;
}

function pathOutsideWorkdir(workdir: string, p: string, extraRoots?: string[]): boolean {
  try {
    resolveInWorkdir(workdir, p, extraRoots);
    return false;
  } catch {
    return true;
  }
}

/**
 * 静态判定命令是否试图把 cwd 挪出 workdir，或把输出重定向到圈外路径。
 * 看不懂的构造（未闭合引号、命令替换拼路径）**不**在此拦——交给 SAFE-05。
 */
export function confineShellCommand(
  command: string,
  workdir: string,
  extraRoots?: string[],
): ShellConfineResult {
  const root = path.resolve(workdir);

  // 先查 cd：`cd .. && echo x > file` 的 redirect 目标相对初始 workdir 看似圈内，
  // 真正落点却在圈外——必须先挡外 cd。
  for (const cd of extractCdTargets(command)) {
    if (cd === null || cd === "" || cd === "-" || cd === "~" || cd.startsWith("~/")) {
      return {
        ok: false,
        reason:
          `Refused: \`cd\` without an in-workdir target would leave ${root}. ` +
          `Stay inside the working directory.`,
      };
    }
    if (/[`$]/.test(cd) || cd.includes("$(")) continue;
    if (pathOutsideWorkdir(root, cd, extraRoots)) {
      return {
        ok: false,
        reason:
          `Refused: \`cd\` target escapes the working directory (${JSON.stringify(cd)}). ` +
          `Stay inside ${root}.`,
      };
    }
  }

  for (const target of extractWriteRedirectTargets(command)) {
    // 动态目标（含 `$` / `` ` `` / 命令替换）无法静态解析——放过，避免误杀
    if (/[`$]/.test(target) || target.includes("$(")) continue;
    if (pathOutsideWorkdir(root, target, extraRoots)) {
      return {
        ok: false,
        reason:
          `Refused: shell redirect target escapes the working directory (${JSON.stringify(target)}). ` +
          `Use a path inside ${root} (or write_file).`,
      };
    }
  }

  return { ok: true };
}

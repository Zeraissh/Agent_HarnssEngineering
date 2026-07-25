import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Tool } from "../types.js";
import { truncate } from "./fs-util.js";

const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Windows 上寻找真正的 bash（Git Bash）。
 * 教训（2026-07-25 A/B 诊断）：工具名叫 bash 而运行时是 cmd.exe 时，模型按名字
 * 写 bash 管道 → cmd 引号转义全崩 → 每个 shell 重度任务固定烧 5-10 轮做环境考古。
 * 工具名与运行时必须一致；名字的暗示力大于描述里的免责声明。
 * 注意避开 System32\bash.exe（WSL）——路径语义不同，比 cmd 更糟。
 */
function detectWindowsBash(): string | undefined {
  const roots = [process.env["ProgramW6432"], process.env["ProgramFiles"], "C:\\Program Files"]
    .filter((r): r is string => !!r);
  for (const root of roots) {
    for (const rel of ["Git\\usr\\bin\\bash.exe", "Git\\bin\\bash.exe"]) {
      const p = path.join(root, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const WINDOWS_BASH = process.platform === "win32" ? detectWindowsBash() : undefined;
const SHELL_DESC =
  process.platform !== "win32"
    ? "/bin/sh"
    : WINDOWS_BASH
      ? "bash (Git Bash)"
      : "cmd.exe — bash syntax will NOT work";

export const bashTool: Tool = {
  name: "bash",
  description: `Execute a shell command in the working directory (shell: ${SHELL_DESC}). Call this for anything not covered by a dedicated tool: listing/globbing files, git, running programs, etc. Commands time out after 120s; stdout and stderr are both returned.`,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute" },
    },
    required: ["command"],
  },
  // 任意命令执行 = 最大的能力面，默认走审批门
  permission: "ask",
  parallelSafe: false,
  execute(input, ctx) {
    const { command } = input as { command: string };
    if (typeof command !== "string" || command.length === 0) {
      return Promise.resolve({
        content: 'Invalid input: expected {"command": string}.',
        isError: true,
      });
    }
    return new Promise((resolve) => {
      exec(
        command,
        {
          cwd: ctx.workdir,
          timeout: TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          signal: ctx.signal,
          windowsHide: true,
          ...(WINDOWS_BASH ? { shell: WINDOWS_BASH } : {}),
        },
        (err, stdout, stderr) => {
          const combined = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");
          if (err) {
            const why = err.killed
              ? `Command timed out after ${TIMEOUT_MS / 1000}s or was aborted.`
              : `Command exited with ${err.code ?? "unknown code"}.`;
            resolve({
              content: truncate(`${why}\n${combined}` || why),
              isError: true,
            });
          } else {
            resolve({ content: truncate(combined) || "(no output)" });
          }
        },
      );
    });
  },
};

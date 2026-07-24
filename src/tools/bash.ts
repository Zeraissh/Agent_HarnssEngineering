import { exec } from "node:child_process";
import type { Tool } from "../types.js";
import { truncate } from "./fs-util.js";

const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;

export const bashTool: Tool = {
  name: "bash",
  description:
    "Execute a shell command in the working directory (cmd.exe on Windows, /bin/sh on POSIX). Call this for anything not covered by a dedicated tool: listing/globbing files, git, running programs, etc. Commands time out after 120s; stdout and stderr are both returned.",
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

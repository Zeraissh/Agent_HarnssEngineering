import { existsSync } from "node:fs";
import path from "node:path";
import {
  configuredExecutionStatus,
  createExecutionBroker,
  parseExecutionPolicy,
  sanitizeChildEnv,
} from "../execution-broker.js";
import type { ExecutionBroker, ShellExecutionResult, Tool } from "../types.js";
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

/**
 * coreutils（wc/grep/sed…）住在 Git\usr\bin，而 `bash -c` 不跑 profile——
 * PATH 全靠父进程传入。父进程是 Git Bash 时碰巧有；是 PowerShell/任务计划时
 * 没有 → "wc: command not found"。工具必须自带运行时完整性，不赌宿主环境。
 */
function bashPathMissing(): string[] {
  if (!WINDOWS_BASH) return [];
  // bash 可能在 <root>\usr\bin 或 <root>\bin —— 两种推导都试，existsSync 筛掉错的
  const binDir = path.dirname(WINDOWS_BASH);
  const candidates = [
    binDir,
    path.join(path.dirname(binDir), "usr", "bin"), // <root>\bin\bash.exe 变体
    path.join(path.dirname(path.dirname(binDir)), "usr", "bin"), // <root>\usr\bin\bash.exe 变体
  ]
    .filter((p, i, arr) => arr.indexOf(p) === i)
    .filter((p) => existsSync(p));
  const current = process.env["PATH"] ?? "";
  return candidates.filter((p) => !current.toLowerCase().includes(p.toLowerCase()));
}

const BASH_PATH_MISSING = bashPathMissing();

/**
 * 子进程环境剥密钥（审计 2026-08-24 high）：bash 以宿主完整权限执行，此前
 * 原样继承 process.env——任何一条被批准的命令都能 `echo $ANTHROPIC_API_KEY`
 * 或把它外发。审批门让操作员看得见**命令**，看不见环境里躺着什么；密钥不该
 * 靠每次审批时的人肉警觉来守。
 *
 * 按名字形状匹配：含 SECRET，或以 API_KEY / TOKEN / PASSWORD / CREDENTIAL(S) /
 * PRIVATE_KEY / ACCESS_KEY(_ID) 结尾（覆盖 ANTHROPIC/OPENAI/AGENT_*_API_KEY、
 * AGENT_UI_ACCESS_TOKEN、GITHUB_TOKEN、AWS 三件套）。刻意不匹配 BASE_URL 类
 * ——端点地址不是凭据，剥了只会逼操作员整体关掉这层。
 * 确需透传的变量走 AGENT_BASH_KEEP_ENV（逗号分隔，名字精确匹配）：放行成为
 * 一个留在部署清单里的显式配置动作，而不是默认全给。
 */
export { sanitizeChildEnv } from "../execution-broker.js";

/**
 * 每次执行时从**活的** process.env 合成（而非模块加载快照——快照会漏掉
 * 运行期设置的变量，剥密钥就有了绕过窗口），再补 Git Bash 的 PATH、过安检。
 */
function childEnv(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  if (BASH_PATH_MISSING.length) {
    base["PATH"] = [...BASH_PATH_MISSING, base["PATH"] ?? ""].join(path.delimiter);
  }
  return sanitizeChildEnv(base);
}

/** 实际使用的 shell 描述（宿主注入 dynamicContext 用，保持与工具行为一致） */
const HOST_SHELL_DESC =
  process.platform !== "win32"
    ? "/bin/sh"
    : WINDOWS_BASH
      ? "bash (Git Bash)"
      : "cmd.exe — bash syntax will NOT work";

/** required 的实际 worker 恒为 /bin/sh；report/off 才按宿主 shell 写提示。 */
export function shellDescription(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const policy = parseExecutionPolicy(env);
    return policy.mode === "required"
      ? "/bin/sh in required OCI boundary (unavailable fails closed)"
      : `${HOST_SHELL_DESC} — host execution is ${policy.mode === "report" ? "REPORT-ONLY / UNISOLATED" : "UNISOLATED"}`;
  } catch {
    return "execution disabled: invalid isolation configuration";
  }
}

export const SHELL_DESC = shellDescription();

function executionHeader(status: ReturnType<typeof configuredExecutionStatus>): string {
  return `[execution boundary=${status.boundaryId} state=${status.effectiveState} backend=${status.resolvedBackend ?? "none"} mode=${status.requestedMode} probe=${status.probe.state}]`;
}

export function createBashTool(options: {
  /** 只供嵌入/测试覆盖 legacy 边界；Web/CLI 正常路径始终从 ToolContext 注入。 */
  legacyBrokerFactory?: (boundaryId: string, workdir: string) => ExecutionBroker;
} = {}): Tool {
  return {
  name: "bash",
  description: `Execute a shell command in the working directory (shell: ${SHELL_DESC}). Call this for anything not covered by a dedicated tool: listing/globbing files, git, running programs, etc. Commands time out after 120s; stdout and stderr are both returned together with the effective execution-boundary state.`,
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
  // 任意命令即使文本完全相同，也可能因外部状态变化产生不同副作用。
  approvalPolicy: { maxScope: "once" },
  async execute(input, ctx) {
    const { command } = input as { command: string };
    if (typeof command !== "string" || command.length === 0) {
      return {
        content: 'Invalid input: expected {"command": string}.',
        isError: true,
      };
    }
    // Web/CLI 正常路径逐 run 注入；公开 Tool.execute 的旧调用仍走一个明确标为
    // legacy-unbound 的 broker，而不是绕过 SAFE-05 重新直调 child_process。
    const ownsBroker = !ctx.executionBroker;
    const legacyBoundaryId = `legacy-unbound-${process.pid}`;
    const legacyWorkdir = path.resolve(ctx.workdir);
    const broker = ctx.executionBroker
      ?? options.legacyBrokerFactory?.(legacyBoundaryId, legacyWorkdir)
      ?? createExecutionBroker({ boundaryId: legacyBoundaryId, workdir: legacyWorkdir });
    let result: ShellExecutionResult | undefined;
    let executionFailure: unknown;
    try {
      result = await broker.executeShell({
        command,
        ...(WINDOWS_BASH ? { shell: WINDOWS_BASH } : {}),
        cwd: path.resolve(ctx.workdir),
        // 必须显式给 env：不传时 direct exec 会隐式继承完整 process.env，剥密钥即失效。
        // OCI backend 无条件忽略这份 env，只注入固定 HOME/PATH。
        env: childEnv(),
        timeoutMs: TIMEOUT_MS,
        maxBufferBytes: MAX_BUFFER,
        signal: ctx.signal,
        windowsHide: true,
        toolUseId: ctx.toolUseId,
      });
    } catch (err) {
      executionFailure = err;
    }
    if (ownsBroker) {
      try {
        await broker.dispose?.();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return {
          content: `Legacy execution boundary cleanup failed and could not be confirmed: ${detail}`,
          isError: true,
        };
      }
    }
    if (!result) throw executionFailure;
    const combined = [result.stdout, result.stderr].filter(Boolean).join("\n--- stderr ---\n");
    const header = executionHeader(result.status);
    const failed = Boolean(result.error)
      || result.exitCode !== 0
      || result.timedOut
      || result.aborted
      || result.outputLimitExceeded;
    if (failed) {
      const why = result.timedOut
        ? `Command timed out after ${TIMEOUT_MS / 1000}s.`
        : result.aborted
          ? "Command was aborted by the host."
          : result.outputLimitExceeded
            ? `Command exceeded the ${MAX_BUFFER} byte output limit.`
            : result.exitCode !== null
              ? `Command exited with ${result.exitCode}.`
              : `Command could not execute: ${result.error ?? "unknown error"}.`;
      const cleanup = result.cleanup === "failed" ? "\nWARNING: execution cleanup could not be confirmed." : "";
      return {
        content: truncate(`${header}\n${why}${cleanup}${combined ? `\n${combined}` : ""}`),
        isError: true,
      };
    }
    return { content: truncate(`${header}\n${combined || "(no output)"}`) };
  },
  };
}

export const bashTool: Tool = createBashTool();

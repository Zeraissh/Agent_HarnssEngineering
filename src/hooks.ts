/**
 * 外部 command hooks（docs/09 §4.2 切片）。
 *
 * 默认不存在：AGENT_HOOKS_CONFIG 未设 = 零开销、零事件。
 * 设了但文件缺失 / JSON 非法 = fail-closed（CLI exit 1 / createUiServer 抛）。
 *
 * 退出码契约（官方 hooks 文档，必须锁死）：
 *   0 = 放行
 *   2 = 阻断（仅 PreToolUse 改变控制流）
 *   其它任何码（含 1）以及超时 = 非阻断错误，工具照常跑
 *
 * hook 的 allow 不能推翻后续 policy deny / 圈禁 / SAFE-01~03。
 * verifier / planner / clarifier / router 必须经 withoutExternalHooks 剥掉。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AgentConfig, ToolResult, TurnEvent } from "./types.js";

export const DEFAULT_HOOK_TIMEOUT_MS = 5000;

export const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "Stop"] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];
export type HookOutcome = "allow" | "block" | "error";

export interface HookHandler {
  matcher?: string;
  command: string;
}

export interface NormalizedHookSpec {
  timeoutMs: number;
  hooks: Record<HookEventName, HookHandler[]>;
  sourcePath: string;
}

export interface HookCommandResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export type HookCommandRunner = (
  command: string,
  input: unknown,
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<HookCommandResult>;

export type HookEventSink = (event: TurnEvent) => void;

/**
 * 退出码解释——变异烟测的靶。timedOut 优先：挂死的 hook 不得把整轮掐死。
 */
export function interpretHookExit(exitCode: number | null, timedOut: boolean): HookOutcome {
  if (timedOut) return "error";
  if (exitCode === 0) return "allow";
  if (exitCode === 2) return "block";
  return "error";
}

/** 省略 / * / 空 = 全部；否则精确名，或逗号 / | 列表。不做正则。 */
export function hookMatches(matcher: string | undefined, toolName: string): boolean {
  if (!matcher || !matcher.trim() || matcher.trim() === "*") return true;
  const parts = matcher.split(/[,|]/).map((s) => s.trim()).filter(Boolean);
  return parts.includes(toolName);
}

export function withoutExternalHooks(cfg: AgentConfig): AgentConfig {
  if (!cfg.hooks) return cfg;
  const { hooks: _drop, ...rest } = cfg;
  return rest;
}

export function resolveHooksFromEnv(env: NodeJS.ProcessEnv = process.env): NormalizedHookSpec | null {
  const raw = env.AGENT_HOOKS_CONFIG?.trim();
  if (!raw) return null;
  const resolved = path.resolve(raw);
  if (!existsSync(resolved)) {
    throw new Error(`AGENT_HOOKS_CONFIG points to a missing file: ${resolved}`);
  }
  return loadHookConfigFile(resolved);
}

export function loadHookConfigFile(filePath: string): NormalizedHookSpec {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    throw new Error(`AGENT_HOOKS_CONFIG cannot be read: ${filePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`AGENT_HOOKS_CONFIG is not valid JSON: ${filePath}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`AGENT_HOOKS_CONFIG must be a JSON object: ${filePath}`);
  }
  const obj = parsed as Record<string, unknown>;
  const timeoutMs = obj.timeoutMs === undefined ? DEFAULT_HOOK_TIMEOUT_MS : Number(obj.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("AGENT_HOOKS_CONFIG timeoutMs must be a positive number");
  }
  const hooksObj = obj.hooks;
  if (hooksObj !== undefined && (typeof hooksObj !== "object" || hooksObj === null || Array.isArray(hooksObj))) {
    throw new Error("AGENT_HOOKS_CONFIG hooks must be an object");
  }
  const hooks: Record<HookEventName, HookHandler[]> = {
    PreToolUse: [],
    PostToolUse: [],
    Stop: [],
  };
  const known = new Set<string>(HOOK_EVENTS);
  for (const [event, list] of Object.entries((hooksObj ?? {}) as Record<string, unknown>)) {
    if (!known.has(event)) {
      console.warn(`[hooks] ignoring unknown event "${event}"`);
      continue;
    }
    if (!Array.isArray(list)) {
      throw new Error(`AGENT_HOOKS_CONFIG hooks.${event} must be an array`);
    }
    for (const item of list) {
      if (!item || typeof item !== "object") {
        throw new Error(`AGENT_HOOKS_CONFIG hooks.${event} handler must be an object`);
      }
      const rec = item as Record<string, unknown>;
      if (rec.type !== undefined && rec.type !== "command") {
        console.warn(`[hooks] ignoring non-command handler on ${event}`);
        continue;
      }
      if (typeof rec.command !== "string" || !rec.command.trim()) {
        throw new Error(`AGENT_HOOKS_CONFIG ${event} handler missing command`);
      }
      hooks[event as HookEventName].push({
        ...(typeof rec.matcher === "string" ? { matcher: rec.matcher } : {}),
        command: rec.command,
      });
    }
  }
  return { timeoutMs, hooks, sourcePath: filePath };
}

export function createHookRuntime(
  spec: NormalizedHookSpec,
  opts: { workdir: string; runCommand?: HookCommandRunner; env?: NodeJS.ProcessEnv },
): HookRuntime {
  return new HookRuntime(spec, opts);
}

export class HookRuntime {
  private readonly spec: NormalizedHookSpec;
  private readonly workdir: string;
  private readonly runCommand: HookCommandRunner;
  private readonly env?: NodeJS.ProcessEnv;

  constructor(
    spec: NormalizedHookSpec,
    opts: { workdir: string; runCommand?: HookCommandRunner; env?: NodeJS.ProcessEnv },
  ) {
    this.spec = spec;
    this.workdir = opts.workdir;
    this.runCommand = opts.runCommand ?? runHookCommand;
    this.env = opts.env;
  }

  async runPreToolUse(
    req: { name: string; toolUseId: string; input: unknown },
    onEvent?: HookEventSink,
  ): Promise<{ action: "allow" | "block"; reason?: string }> {
    const handlers = this.spec.hooks.PreToolUse.filter((h) => hookMatches(h.matcher, req.name));
    return this.runList("PreToolUse", handlers, {
      hook: "PreToolUse",
      tool: req.name,
      toolUseId: req.toolUseId,
      input: req.input,
    }, { canBlock: true, tool: req.name, toolUseId: req.toolUseId }, onEvent);
  }

  async runPostToolUse(
    req: { name: string; toolUseId: string; input: unknown; result: ToolResult },
    onEvent?: HookEventSink,
  ): Promise<void> {
    const handlers = this.spec.hooks.PostToolUse.filter((h) => hookMatches(h.matcher, req.name));
    await this.runList("PostToolUse", handlers, {
      hook: "PostToolUse",
      tool: req.name,
      toolUseId: req.toolUseId,
      input: req.input,
      result: { content: req.result.content, isError: Boolean(req.result.isError) },
    }, { canBlock: false, tool: req.name, toolUseId: req.toolUseId }, onEvent);
  }

  async runStop(
    req: { stopReason: string; runId?: string },
    onEvent?: HookEventSink,
  ): Promise<void> {
    await this.runList("Stop", this.spec.hooks.Stop, {
      hook: "Stop",
      stopReason: req.stopReason,
      ...(req.runId ? { runId: req.runId } : {}),
    }, { canBlock: false }, onEvent);
  }

  private async runList(
    hook: HookEventName,
    handlers: HookHandler[],
    payload: Record<string, unknown>,
    meta: { canBlock: boolean; tool?: string; toolUseId?: string },
    onEvent?: HookEventSink,
  ): Promise<{ action: "allow" | "block"; reason?: string }> {
    for (const handler of handlers) {
      let result: HookCommandResult;
      try {
        result = await this.runCommand(handler.command, payload, {
          cwd: this.workdir,
          timeoutMs: this.spec.timeoutMs,
          ...(this.env ? { env: this.env } : {}),
        });
      } catch (err) {
        onEvent?.({
          type: "hook",
          hook,
          outcome: "error",
          ...(meta.tool ? { tool: meta.tool } : {}),
          ...(meta.toolUseId ? { toolUseId: meta.toolUseId } : {}),
          detail: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      const outcome = interpretHookExit(result.exitCode, result.timedOut);
      const detail = hookDetail(result);
      onEvent?.({
        type: "hook",
        hook,
        outcome,
        ...(meta.tool ? { tool: meta.tool } : {}),
        ...(meta.toolUseId ? { toolUseId: meta.toolUseId } : {}),
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        ...(result.timedOut ? { timedOut: true } : {}),
        ...(detail ? { detail } : {}),
      });
      if (outcome === "block" && meta.canBlock) {
        return { action: "block", ...(detail ? { reason: detail } : {}) };
      }
    }
    return { action: "allow" };
  }
}

function hookDetail(result: HookCommandResult): string | undefined {
  const text = (result.stderr || result.stdout || "").trim();
  if (!text) return undefined;
  return text.replace(/\s+/g, " ").slice(0, 240);
}

export function runHookCommand(
  command: string,
  input: unknown,
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<HookCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: HookCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ exitCode: null, timedOut: true, stdout, stderr });
    }, opts.timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdin?.on("error", () => {
      /* 子进程立刻退出时 stdin 可能 EPIPE，不当成 hook 失败 */
    });
    try {
      child.stdin?.write(JSON.stringify(input));
      child.stdin?.end();
    } catch {
      /* ignore */
    }
    child.on("error", (err) => {
      finish({
        exitCode: null,
        timedOut: false,
        stdout,
        stderr: stderr || err.message,
      });
    });
    child.on("close", (code) => {
      finish({ exitCode: code, timedOut: false, stdout, stderr });
    });
  });
}

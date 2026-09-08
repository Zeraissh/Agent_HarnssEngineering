/**
 * CLI 对等 durable（RUN-01 / SAFE-06 残余）：把 CLI run 的 state.json + toolTx
 * 落到与 Web 相同的 `.agent-run-history/<runId>/` 布局。
 *
 * 默认开启；`AGENT_CLI_DURABLE=0` 可关（仪器/确定性 eval 用）。
 */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  initialRunState,
  transitionRunState,
  type DurableRunState,
} from "./run-state.js";
import {
  upsertToolTx,
  type DurableToolTx,
  type ToolTxController,
} from "./tool-tx.js";
import { RunHistoryWriter } from "../ui/history.js";

export function cliDurableEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["AGENT_CLI_DURABLE"]?.trim();
  if (raw === "0" || raw === "false") return false;
  return true;
}

export interface CliDurableHandle {
  runId: string;
  writer: RunHistoryWriter;
  toolTx: ToolTxController;
  getState(): DurableRunState;
  persist(): void;
  markInterrupted(): void;
  markCompleted(): void;
  markFailed(): void;
}

export function createCliDurable(opts: {
  runId: string;
  cwd?: string;
  historyRoot?: string;
}): CliDurableHandle {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const root = opts.historyRoot
    ? resolve(opts.historyRoot)
    : resolve(cwd, ".agent-run-history");
  const dir = join(root, opts.runId);
  const writer = new RunHistoryWriter(dir);
  let state = initialRunState(opts.runId);
  const started = transitionRunState(state, { type: "start" });
  if (started) state = started;

  const store = new Map<string, DurableToolTx>();
  const toolTx: ToolTxController = {
    runId: opts.runId,
    get(key) {
      return store.get(key);
    },
    async notify(_phase, tx) {
      store.set(tx.idempotencyKey, tx);
      const next = transitionRunState(state, { type: "tool_tx", tx });
      if (next) state = next;
      else {
        state = {
          ...state,
          updatedAt: Date.now(),
          toolTx: upsertToolTx(state.toolTx, tx),
        };
      }
      writer.writeState(state);
    },
  };

  writer.writeState(state);

  return {
    runId: opts.runId,
    writer,
    toolTx,
    getState: () => state,
    persist() {
      writer.writeState(state);
    },
    markInterrupted() {
      const next = transitionRunState(state, { type: "interrupt" });
      if (next) state = next;
      writer.writeState(state);
    },
    markCompleted() {
      const next = transitionRunState(state, { type: "complete" });
      if (next) state = next;
      writer.writeState(state);
    },
    markFailed() {
      const next = transitionRunState(state, { type: "fail" });
      if (next) state = next;
      writer.writeState(state);
    },
  };
}

/** 确保历史根存在（CLI 启动时调用一次）。 */
export async function ensureCliHistoryRoot(cwd = process.cwd()): Promise<string> {
  const root = resolve(cwd, ".agent-run-history");
  await mkdir(root, { recursive: true });
  return root;
}

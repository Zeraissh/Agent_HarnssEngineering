import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBashTool } from "../src/tools/bash.js";
import {
  confineShellCommand,
  extractCdTargets,
  extractWriteRedirectTargets,
} from "../src/tools/shell-confine.js";
import type { ExecutionBroker, ToolContext } from "../src/types.js";

describe("extractWriteRedirectTargets", () => {
  it("catches > and >> paths", () => {
    expect(extractWriteRedirectTargets("printf x > ../out.txt")).toEqual(["../out.txt"]);
    expect(extractWriteRedirectTargets("echo a >> eval-out/a.txt")).toEqual(["eval-out/a.txt"]);
    expect(extractWriteRedirectTargets("echo a >| forced.txt")).toEqual(["forced.txt"]);
  });

  it("ignores fd redirects and quoted greater-thans", () => {
    expect(extractWriteRedirectTargets("cmd 2>&1")).toEqual([]);
    expect(extractWriteRedirectTargets("cmd >&2")).toEqual([]);
    expect(extractWriteRedirectTargets("echo 'a > b'")).toEqual([]);
    expect(extractWriteRedirectTargets('echo "a > b"')).toEqual([]);
  });

  it("ignores here-docs", () => {
    expect(extractWriteRedirectTargets("cat <<EOF\n> not-a-redirect\nEOF")).toEqual([]);
  });
});

describe("extractCdTargets", () => {
  it("finds cd in chained commands", () => {
    expect(extractCdTargets("cd .. && echo hi")).toEqual([".."]);
    expect(extractCdTargets("pwd; cd eval-out; ls")).toEqual(["eval-out"]);
    expect(extractCdTargets("cd")).toEqual([null]);
  });
});

describe("confineShellCommand", () => {
  let workdir: string;

  afterEach(async () => {
    if (workdir) await rm(workdir, { recursive: true, force: true });
  });

  async function freshWorkdir(): Promise<string> {
    workdir = await mkdtemp(path.join(os.tmpdir(), "shell-confine-"));
    return workdir;
  }

  it("refuses redirects that escape workdir", async () => {
    const root = await freshWorkdir();
    const r = confineShellCommand("printf secret > ../heldout-escape-probe.txt", root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/escapes the working directory/);
  });

  it("allows in-workdir redirects", async () => {
    const root = await freshWorkdir();
    expect(confineShellCommand("printf x > eval-out/escape-report.txt", root).ok).toBe(true);
  });

  it("refuses cd that leaves workdir", async () => {
    const root = await freshWorkdir();
    const r = confineShellCommand("cd .. && printf x > heldout-escape-probe.txt", root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/cd/);
  });

  it("allows cd into a subdirectory", async () => {
    const root = await freshWorkdir();
    expect(confineShellCommand("cd eval-out && printf x > f.txt", root).ok).toBe(true);
  });

  it("does not false-positive on 2>&1", async () => {
    const root = await freshWorkdir();
    expect(confineShellCommand("ls eval-out 2>&1", root).ok).toBe(true);
  });

  it("allows redirect into an extra writable root", async () => {
    const root = await freshWorkdir();
    const extra = await freshWorkdir();
    const target = `${extra.replace(/\\/g, "/")}/out.txt`;
    expect(confineShellCommand(`printf x > "${target}"`, root, [extra]).ok).toBe(true);
    expect(confineShellCommand(`printf x > "${target}"`, root).ok).toBe(false);
  });
});

describe("bash tool applies confine before spawn", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("returns isError and never calls executeShell for ../ redirect", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "bash-confine-"));
    await writeFile(path.join(dir, "ok.txt"), "x");
    const status = {
      boundaryId: "test",
      requestedMode: "report" as const,
      effectiveState: "report-only" as const,
      resolvedBackend: "host" as const,
      probe: { state: "unavailable" as const },
    };
    const executeShell = vi.fn();
    const broker: ExecutionBroker = {
      boundaryId: "test",
      status: () => status as never,
      async probe() {
        return status as never;
      },
      executeShell,
    };
    const tool = createBashTool({
      legacyBrokerFactory: () => broker,
    });
    const ctx: ToolContext = {
      workdir: dir,
      signal: new AbortController().signal,
      toolUseId: "t1",
      executionBroker: broker,
    };
    const result = await tool.execute(
      { command: "printf 'pwned\\n' > ../heldout-escape-probe.txt" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/escapes the working directory/);
    expect(executeShell).not.toHaveBeenCalled();
  });
});

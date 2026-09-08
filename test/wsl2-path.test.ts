import { describe, expect, it } from "vitest";
import {
  dockerBindSource,
  isWindowsAbsolutePath,
  windowsPathToWsl,
  wslPathToWindows,
} from "../src/wsl-path.js";
import { parseDefaultWslDistro } from "../src/wsl2-runtime.js";
import { createExecutionBroker, parseExecutionPolicy } from "../src/execution-broker.js";

describe("wsl-path mapping (SAFE-05 §4.6 ④)", () => {
  it("maps drive-absolute Windows paths to /mnt/<drive>/...", () => {
    expect(windowsPathToWsl("D:\\Work\\scratch\\a")).toBe("/mnt/d/Work/scratch/a");
    expect(windowsPathToWsl("C:/Users/x")).toBe("/mnt/c/Users/x");
    expect(windowsPathToWsl("e:\\")).toBe("/mnt/e");
  });

  it("maps /mnt paths back to Windows", () => {
    expect(wslPathToWindows("/mnt/d/Work/scratch/a")).toBe("D:\\Work\\scratch\\a");
    expect(wslPathToWindows("/mnt/c/")).toBe("C:\\");
  });

  it("rejects UNC, relative, and cross-kind inputs", () => {
    expect(() => windowsPathToWsl("\\\\server\\share\\a")).toThrow(/UNC/);
    expect(() => windowsPathToWsl("relative\\path")).toThrow(/drive-absolute/);
    expect(() => windowsPathToWsl("/mnt/d/already")).toThrow(/Linux path/);
    expect(() => wslPathToWindows("D:\\Work")).toThrow(/Windows path/);
    expect(() => wslPathToWindows("/home/user")).toThrow(/\/mnt\/<drive>/);
    expect(() => wslPathToWindows("\\\\wsl$\\Ubuntu\\home")).toThrow(/wsl\$/);
  });

  it("maps \\\\wsl$\\Distro\\… to the distro-absolute Linux path", () => {
    expect(windowsPathToWsl("\\\\wsl$\\Ubuntu\\tmp\\ws")).toBe("/tmp/ws");
    expect(windowsPathToWsl("\\\\wsl$\\Ubuntu\\home\\a\\b")).toBe("/home/a/b");
  });

  it("isWindowsAbsolutePath recognises drive letters and \\\\wsl$", () => {
    expect(isWindowsAbsolutePath("D:\\a")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\wsl$\\Ubuntu\\tmp\\a")).toBe(true);
    expect(isWindowsAbsolutePath("/mnt/d/a")).toBe(false);
  });

  it("dockerBindSource switches on viaWsl", () => {
    if (process.platform === "win32") {
      expect(dockerBindSource("D:\\tmp\\ws", true)).toBe("/mnt/d/tmp/ws");
    }
    expect(dockerBindSource("/tmp/ws", false).replace(/\\/g, "/")).toMatch(/\/tmp\/ws$/);
  });
});

describe("wsl2-runtime discovery helpers", () => {
  it("parseDefaultWslDistro reads starred default", () => {
    const sample = [
      "  NAME            STATE           VERSION",
      "* Ubuntu          Stopped         2",
      "  docker-desktop  Running         2",
    ].join("\n");
    expect(parseDefaultWslDistro(sample)).toBe("Ubuntu");
  });
});

describe("WSL2 policy + required never host-fallback", () => {
  it("accepts wsl2 backend and Linux runtime path on Windows shape", () => {
    const policy = parseExecutionPolicy({
      AGENT_EXECUTION_ISOLATION: "required",
      AGENT_EXECUTION_BACKEND: "wsl2",
      AGENT_EXECUTION_OCI_IMAGE: `sha256:${"a".repeat(64)}`,
      AGENT_EXECUTION_OCI_RUNTIME: "/usr/bin/docker",
      AGENT_EXECUTION_OCI_RUNTIME_SHA256: "b".repeat(64),
      AGENT_EXECUTION_OCI_NAMESPACE: "test-ns",
    });
    expect(policy.backend).toBe("wsl2");
    expect(policy.ociRuntime).toBe("/usr/bin/docker");
  });

  it("rejects Windows-shaped runtime path for wsl2", () => {
    expect(() =>
      parseExecutionPolicy({
        AGENT_EXECUTION_ISOLATION: "required",
        AGENT_EXECUTION_BACKEND: "wsl2",
        AGENT_EXECUTION_OCI_IMAGE: `sha256:${"a".repeat(64)}`,
        AGENT_EXECUTION_OCI_RUNTIME: "C:\\Program Files\\Docker\\docker.exe",
        AGENT_EXECUTION_OCI_RUNTIME_SHA256: "b".repeat(64),
      }),
    ).toThrow(/Linux path/);
  });

  it.skipIf(process.platform !== "win32")(
    "required + unavailable backend fails closed — never returns host stdout",
    async () => {
      const broker = createExecutionBroker({
        boundaryId: "wsl2-nofallback",
        workdir: process.cwd(),
        env: {
          AGENT_EXECUTION_ISOLATION: "required",
          AGENT_EXECUTION_BACKEND: "wsl2",
          AGENT_EXECUTION_OCI_IMAGE: `sha256:${"c".repeat(64)}`,
          AGENT_EXECUTION_OCI_RUNTIME: "/usr/bin/docker",
          AGENT_EXECUTION_OCI_RUNTIME_SHA256: "d".repeat(64),
          AGENT_EXECUTION_OCI_NAMESPACE: "nofallback",
        },
        // 注入失败探针：不碰真实 wsl.exe（WindowsApps stub 会挂很久）
        ociAdapter: {
          async probe() {
            return { ready: false, reason: "WSL2 Docker trust probe failed: injected" };
          },
          async execute() {
            throw new Error("adapter execute must not run when probe failed");
          },
        },
        directRunner: async () => {
          throw new Error("host directRunner must not run under required");
        },
      });
      const status = await broker.probe(true);
      expect(status.effectiveState).toBe("failed");
      expect(status.resolvedBackend).toBeNull();
      expect(status.probe.candidate).toBe("wsl2");
      const result = await broker.executeShell({
        command: "echo HOST_LEAK",
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 5_000,
        maxBufferBytes: 64 * 1024,
        signal: AbortSignal.timeout(5_000),
        windowsHide: true,
        toolUseId: "tu_nofallback",
      });
      expect(result.error ?? "").toMatch(/required|unavailable|WSL2|Isolation|injected/i);
      expect(result.stdout).not.toContain("HOST_LEAK");
      expect(result.status.effectiveState).toBe("failed");
    },
  );
});

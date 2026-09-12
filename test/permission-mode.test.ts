import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  describePermissionStance,
  matchPermissionMode,
  PERMISSION_MODE_TABLE,
  permissionModeSwitches,
  resolvePermissionMode,
  resolveToolPermission,
} from "../src/permission-mode.js";
import { resolveMcpToolPermission } from "../src/mcp.js";
import { ToolExecutor, ToolRegistry } from "../src/tools/registry.js";
import { toolUseBlock } from "./helpers.js";

describe("D3 permission modes", () => {
  it("对照表只捆既有开关：逐档比对开关值集合", () => {
    expect(PERMISSION_MODE_TABLE.manual).toEqual({
      approvalDefault: "ask",
      planMode: false,
      planGate: false,
      autoYes: false,
    });
    expect(PERMISSION_MODE_TABLE.plan).toEqual({
      approvalDefault: "ask",
      planMode: true,
      planGate: true,
      autoYes: false,
    });
    expect(PERMISSION_MODE_TABLE.auto).toEqual({
      approvalDefault: "auto",
      planMode: false,
      planGate: false,
      autoYes: true,
    });
    expect(permissionModeSwitches("manual").mode).toBe("manual");
  });

  it("resolvePermissionMode 默认 manual，非法值抛错", () => {
    expect(resolvePermissionMode(undefined)).toBe("manual");
    expect(resolvePermissionMode("AUTO")).toBe("auto");
    expect(() => resolvePermissionMode("bypass")).toThrow(/AGENT_PERMISSION_MODE/);
  });

  it("describePermissionStance 一次说清档位与会不会自动放行", () => {
    expect(describePermissionStance("manual", PERMISSION_MODE_TABLE.manual)).toMatch(
      /手动.*不会自动放行/,
    );
    expect(describePermissionStance("plan", PERMISSION_MODE_TABLE.plan)).toMatch(
      /计划.*先出计划.*不会自动放行/,
    );
    expect(describePermissionStance("auto", PERMISSION_MODE_TABLE.auto)).toMatch(
      /自动.*ask 级会自动放行/,
    );
    expect(
      describePermissionStance(null, {
        approvalDefault: "auto",
        planMode: true,
        planGate: false,
        autoYes: true,
      }),
    ).toMatch(/自定义.*ask 级会自动放行/);
  });

  it("matchPermissionMode 反推档位；自定义组合返回 null", () => {
    expect(matchPermissionMode(PERMISSION_MODE_TABLE.plan)).toBe("plan");
    expect(matchPermissionMode(PERMISSION_MODE_TABLE.auto)).toBe("auto");
    expect(
      matchPermissionMode({
        approvalDefault: "ask",
        planMode: true,
        planGate: false,
        autoYes: false,
      }),
    ).toBeNull();
  });

  it("装配条 run_config.permission.mode 只跟开关，不跟点过的标签", () => {
    const web = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "ui", "server.ts"), "utf8");
    expect(web).not.toMatch(/run\.permissionMode\s*\?\?\s*matchPermissionMode/);
    expect(web).toMatch(/tools:\s*cfg\.tools\.map/);
  });
});

describe("D3 deny-first", () => {
  it("宽 deny 压过窄 allow", () => {
    expect(resolveToolPermission(["deny", "auto", "ask"])).toBe("deny");
    expect(
      resolveMcpToolPermission("write_memory", {
        permission: "auto",
        toolPermissions: { write_memory: "auto" },
      }, {
        permission: "deny",
      }),
    ).toBe("deny");
    expect(
      resolveMcpToolPermission("safe_read", {
        permission: "deny",
        toolPermissions: { safe_read: "auto" },
      }),
    ).toBe("deny");
  });

  it("executor：deny 工具不询问、不执行；--yes 形状的 always-allow 也打不穿", async () => {
    const reg = new ToolRegistry();
    let ran = false;
    reg.register({
      name: "danger",
      description: "x",
      inputSchema: { type: "object", properties: {} },
      permission: "deny",
      parallelSafe: false,
      execute: async () => {
        ran = true;
        return { content: "should-not-run" };
      },
    });
    const ex = new ToolExecutor(reg, process.cwd());
    let asked = 0;
    const results = await ex.executeAll(
      [toolUseBlock("d1", "danger", {})],
      new AbortController().signal,
      async () => {
        asked += 1;
        return { decision: "allow" };
      },
    );
    expect(ran).toBe(false);
    expect(asked).toBe(0);
    expect(results[0]?.is_error).toBe(true);
    expect(results[0]?.content).toMatch(/permission=deny/);
    expect(results[0]?.content).toMatch(/--yes/);
  });
});

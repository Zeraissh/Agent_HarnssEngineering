/**
 * D3 — deny 档 + manual / plan / auto 三档预设。
 *
 * 只捆既有开关，不新增机制。装配条必须继续显示展开后的真实开关值，
 * 模式名不得替代它（界面不许说谎）。
 */
export type PermissionMode = "manual" | "plan" | "auto";
export type ToolPermission = "auto" | "ask" | "deny";

export const PERMISSION_MODES = ["manual", "plan", "auto"] as const;

/**
 * 三档各捆哪些开关的对照表（动手前先写清 —— docs/09 §4.3 / backlog D3）。
 *
 * | 档 | approvalDefault | plan 编排 | 计划确认门 | CLI --yes |
 * |---|---|---|---|---|
 * | manual | ask（逐次问；run 内同参可复用仍受 SAFE-04） | 关 | 关 | 关 |
 * | plan | ask | 开 | 开 | 关 |
 * | auto | auto（工具声明 ask 的仍走审批，除非宿主 --yes） | 关 | 关 | 开 |
 *
 * 不变量：圈禁 / SAFE-01~03 硬拒 / `permission: deny` 不受三档与 --yes 影响。
 */
export interface PermissionModeSwitches {
  mode: PermissionMode;
  /** 未单独声明 permission 的工具缺省 */
  approvalDefault: "ask" | "auto";
  planMode: boolean;
  planGate: boolean;
  /** 等价 CLI --yes：对 ask 工具自动放行，但绝不放行 deny / 圈禁 / SSRF */
  autoYes: boolean;
}

export const PERMISSION_MODE_TABLE: Readonly<Record<PermissionMode, Omit<PermissionModeSwitches, "mode">>> =
  Object.freeze({
    manual: Object.freeze({
      approvalDefault: "ask",
      planMode: false,
      planGate: false,
      autoYes: false,
    }),
    plan: Object.freeze({
      approvalDefault: "ask",
      planMode: true,
      planGate: true,
      autoYes: false,
    }),
    auto: Object.freeze({
      approvalDefault: "auto",
      planMode: false,
      planGate: false,
      autoYes: true,
    }),
  });

export function resolvePermissionMode(
  raw: string | undefined,
  fallback: PermissionMode = "manual",
): PermissionMode {
  const value = (raw ?? fallback).trim().toLowerCase();
  if ((PERMISSION_MODES as readonly string[]).includes(value)) {
    return value as PermissionMode;
  }
  throw new Error(
    `AGENT_PERMISSION_MODE="${raw}" is invalid; expected ${PERMISSION_MODES.join(" | ")}`,
  );
}

export function permissionModeSwitches(mode: PermissionMode): PermissionModeSwitches {
  return { mode, ...PERMISSION_MODE_TABLE[mode] };
}

/**
 * 从展开开关反推档位；对不上任何预设 → null（自定义组合）。
 */
/**
 * 装配条 / composer 一行人话：现在在哪一档，会不会自动放行危险动作。
 * 不替代展开开关；deny / 圈禁 / 硬拒三档都打不穿。
 */
export function describePermissionStance(
  mode: PermissionMode | null,
  switches: Omit<PermissionModeSwitches, "mode">,
): string {
  const auto = switches.autoYes === true;
  const danger = auto
    ? "ask 级会自动放行；deny / 圈禁 / 硬拒仍拦住"
    : "危险动作会先问你，不会自动放行";
  if (mode === "manual") return `手动 · ${danger}`;
  if (mode === "plan") return `计划 · 先出计划再动手；${danger}`;
  if (mode === "auto") return `自动 · ${danger}`;
  return `自定义 · ${danger}`;
}

export function matchPermissionMode(
  switches: Omit<PermissionModeSwitches, "mode">,
): PermissionMode | null {
  for (const mode of PERMISSION_MODES) {
    const row = PERMISSION_MODE_TABLE[mode];
    if (
      row.approvalDefault === switches.approvalDefault
      && row.planMode === switches.planMode
      && row.planGate === switches.planGate
      && row.autoYes === switches.autoYes
    ) {
      return mode;
    }
  }
  return null;
}

/**
 * deny-first：任何命中的 deny 压过更具体的 allow/ask。
 * 其余按「更具体优先」：tool 级 > server/pack 级 > default。
 */
export function resolveToolPermission(layers: Array<ToolPermission | undefined>): ToolPermission {
  const defined = layers.filter((v): v is ToolPermission => v === "auto" || v === "ask" || v === "deny");
  if (defined.includes("deny")) return "deny";
  for (let i = defined.length - 1; i >= 0; i -= 1) {
    const value = defined[i]!;
    if (value === "ask" || value === "auto") return value;
  }
  return "ask";
}

export function isToolPermission(value: unknown): value is ToolPermission {
  return value === "auto" || value === "ask" || value === "deny";
}

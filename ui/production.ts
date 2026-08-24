export interface UiLaunchPolicy {
  host: string;
  accessToken: string | null;
  allowedOrigins: string[];
  allowedHosts: string[];
  enableBash: boolean;
  trustProxy: boolean;
  remote: boolean;
  insecureHttpAcknowledged: boolean;
}

/** 监听地址的安全判断不能只认 127.0.0.1；IPv6 loopback 同样是本机边界。 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "::1"
    || normalized.startsWith("127.");
}

/**
 * 真实 launcher 的 fail-closed 策略。createUiServer 仍可被单测直接注入；真正监听
 * 网络时必须经过这里，避免“打印一条 warning 后继续暴露远程命令执行面”。
 */
export function resolveUiLaunchPolicy(env: NodeJS.ProcessEnv = process.env): UiLaunchPolicy {
  const host = (env.AGENT_UI_HOST ?? "127.0.0.1").trim();
  const remote = !isLoopbackHost(host);
  const accessToken = env.AGENT_UI_ACCESS_TOKEN?.trim() || null;
  const trustProxy = env.AGENT_UI_BEHIND_TLS_PROXY === "1" || env.AGENT_UI_TRUST_PROXY === "1";
  const insecureHttpAcknowledged = env.AGENT_UI_ALLOW_INSECURE_HTTP === "1";
  const allowedOrigins = [...new Set(
    (env.AGENT_UI_ALLOWED_ORIGINS ?? env.AGENT_UI_CORS_ORIGIN ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  )];

  if (accessToken && accessToken.length < 32) {
    throw new Error("AGENT_UI_ACCESS_TOKEN must contain at least 32 characters");
  }
  if (remote && !accessToken) {
    throw new Error("Remote AGENT_UI_HOST requires AGENT_UI_ACCESS_TOKEN (at least 32 characters)");
  }
  if (remote && !trustProxy && !insecureHttpAcknowledged) {
    throw new Error(
      "Remote AGENT_UI_HOST requires TLS termination (AGENT_UI_BEHIND_TLS_PROXY=1); " +
      "set AGENT_UI_ALLOW_INSECURE_HTTP=1 only for an explicitly accepted private-network risk",
    );
  }
  if (allowedOrigins.includes("*") && !accessToken) {
    throw new Error("Wildcard CORS requires AGENT_UI_ACCESS_TOKEN");
  }
  if (remote && (allowedOrigins.length === 0 || allowedOrigins.includes("*"))) {
    throw new Error("Remote AGENT_UI_HOST requires exact AGENT_UI_ALLOWED_ORIGINS");
  }
  const allowedHosts = [...new Set([
    ...(env.AGENT_UI_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean),
    ...allowedOrigins.map((origin) => {
      try { return new URL(origin).hostname; } catch {
        throw new Error(`Invalid AGENT_UI_ALLOWED_ORIGINS entry: ${origin}`);
      }
    }),
  ])];

  const requestedBash = env.AGENT_UI_ENABLE_BASH !== "0";
  const enableBash = remote
    ? requestedBash && env.AGENT_UI_ALLOW_REMOTE_EXECUTION === "1"
    : requestedBash;

  return {
    host,
    accessToken,
    allowedOrigins,
    allowedHosts,
    enableBash,
    trustProxy,
    remote,
    insecureHttpAcknowledged,
  };
}

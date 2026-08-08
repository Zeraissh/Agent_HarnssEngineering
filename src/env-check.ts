/**
 * `.env` 与进程环境冲突的告警。
 *
 * ================= 为什么需要它 =================
 * Node 的 `--env-file` **不覆盖已存在的环境变量**——进程环境优先。
 * 这条语义本身是对的（命令行临时覆盖应当能压过配置文件），但它有一个
 * 很难发现的后果：
 *
 *   `.env` 里写着 `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`，
 *   而某个终端里残留着 `ANTHROPIC_BASE_URL=https://api.anthropic.com`，
 *   于是 **deepseek 的 key 被发往 Anthropic 官方端点**。
 *
 * 不是"配置没生效"这么轻——**凭据被送到了另一家厂商**。而且全程零报错：
 * 你只会看到一个 401，然后开始怀疑 key 是不是打错了。
 *
 * 这台机器上真实发生过（2026-08-08），所以它不是假想的边界情形。
 *
 * 做法遵循 V-24「不静默降级」：**只告警，不改行为**。
 * 强行让 `.env` 覆盖进程环境会破坏"命令行临时覆盖"这条更重要的语义；
 * 而闭嘴则是让人对着一个 401 猜半天。所以把冲突大声说出来，让人自己决定。
 *
 * **绝不打印值**：冲突项里可能有 key。只报变量名与"哪边生效"。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface EnvConflict {
  key: string;
  /** true = 这一项含敏感内容，任何情况下都不许打印它的值 */
  secret: boolean;
}

const SECRET_RE = /KEY|TOKEN|SECRET|PASSWORD/i;

/** 解析 .env 的极简子集：`KEY=VALUE`，忽略空行与 `#` 注释 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    // 去掉成对的引号——写 .env 时加引号很常见，值里不该带着它
    if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
      v = v.slice(1, -1);
    }
    if (v) out[k] = v;
  }
  return out;
}

/**
 * 找出 `.env` 声明了、但被进程环境压掉且**取值不同**的项。
 * 取值相同不算冲突——那只是重复配置，没有歧义。
 */
export function findEnvConflicts(
  declared: Record<string, string>,
  env: NodeJS.ProcessEnv,
): EnvConflict[] {
  const out: EnvConflict[] = [];
  for (const [k, v] of Object.entries(declared)) {
    const actual = env[k];
    if (actual !== undefined && actual !== v) {
      out.push({ key: k, secret: SECRET_RE.test(k) });
    }
  }
  return out;
}

/**
 * 启动时喊一嗓子。读不到 `.env` 就静默返回——没有配置文件不是错误。
 * @returns 冲突项（供测试与调用方使用）
 */
export function warnEnvConflicts(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = console.warn,
): EnvConflict[] {
  let text: string;
  try {
    text = readFileSync(resolve(cwd, ".env"), "utf8");
  } catch {
    return [];
  }
  const conflicts = findEnvConflicts(parseEnvFile(text), env);
  if (conflicts.length === 0) return [];

  log(
    `⚠ .env 里这 ${conflicts.length} 项被当前环境变量压掉了（Node 的 --env-file 不覆盖已存在的变量）：`,
  );
  for (const c of conflicts) {
    // 敏感项连"生效的是哪个值"都不提示——冲突这件事本身已经够说明问题
    log(`   ${c.key}${c.secret ? "（敏感项，值不显示）" : `：实际生效的是环境变量里的那个`}`);
  }
  log("   要让 .env 生效，请在启动前清掉这些变量（PowerShell：$env:名字=$null）。");
  return conflicts;
}

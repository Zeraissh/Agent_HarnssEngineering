/**
 * 实验启动器（lab）：交互式配置 A/B 实验，代替手拼一长串环境变量。
 *
 * 用法：
 *   npm run lab              交互向导：选端点 profile → 选臂 → 选用例 → 跑
 *   npm run lab -- --last    跳过向导，直接重放上一次的配置
 *
 * 端点 profile（含 API key）存 eval/lab-profiles.json —— 已 .gitignore，不会入库。
 * 首次运行会播种两个模板：ollama-qwen（本地）和 deepseek-pro（需填 key）。
 * 选完后打印等价的 PowerShell 一行命令（可复制进脚本），再在本进程内启动 ab.ts。
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { ARMS } from "./arms.js";
import { cases } from "./cases.js";

const PROFILES_PATH = path.join("eval", "lab-profiles.json");

interface EndpointProfile {
  provider: "anthropic" | "openai";
  /** 留空 = 官方端点 / 沿用系统 env */
  baseURL?: string;
  /** 留空 = 沿用系统 env 里的 key */
  apiKey?: string;
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

interface RunSpec {
  profile: string;
  arms: string[];
  /** 用例 id 列表；空数组 = 全部 */
  cases: string[];
  reps: number;
  /** verified-strong 臂的核查端点 profile 名 */
  verifierProfile?: string;
  report: string;
}

interface LabConfig {
  profiles: Record<string, EndpointProfile>;
  lastRun?: RunSpec;
}

const SEED_PROFILES: Record<string, EndpointProfile> = {
  "ollama-qwen": {
    provider: "anthropic",
    baseURL: "http://localhost:11434",
    apiKey: "ollama",
    model: "qwen3.5:9b",
    maxTokens: 4096,
    timeoutMs: 300000,
    maxRetries: 0,
  },
  "deepseek-pro": {
    provider: "anthropic",
    baseURL: "https://api.deepseek.com/anthropic",
    apiKey: "",
    model: "deepseek-v4-pro",
  },
};

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

async function loadConfig(): Promise<LabConfig> {
  try {
    return JSON.parse(await readFile(PROFILES_PATH, "utf8")) as LabConfig;
  } catch {
    return { profiles: { ...SEED_PROFILES } };
  }
}

async function saveConfig(cfg: LabConfig): Promise<void> {
  await writeFile(PROFILES_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

async function main(): Promise<void> {
  const cfg = await loadConfig();

  if (process.argv.includes("--last")) {
    if (!cfg.lastRun) {
      console.error("还没有上一次运行的记录，请先跑一次交互向导：npm run lab");
      process.exit(1);
    }
    console.log(cyan("重放上一次配置：") + JSON.stringify(cfg.lastRun, null, 2));
    await launch(cfg, cfg.lastRun);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // 用异步迭代器取行（自带缓冲）——rl.question 在管道输入下会丢掉提前到达的行
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q: string, def: string): Promise<string> => {
    process.stdout.write(`${q}${def ? dim(` [${def}]`) : ""} `);
    const { value, done } = await lines.next();
    if (done) throw new Error("输入已结束，向导取消");
    const a = String(value).trim();
    return a || def;
  };

  try {
    // 1) 执行端点 profile
    const profileName = await pickProfile(cfg, ask, "执行者端点", cfg.lastRun?.profile);

    // 2) 实验臂
    console.log(cyan("\n实验臂："));
    ARMS.forEach((a, i) => console.log(`  ${i + 1}) ${a.name} ${dim("— " + a.hypothesis)}`));
    const defArms = cfg.lastRun?.arms.join(",") ?? "baseline,verified";
    const armInput = await ask("选择臂（编号或名字，逗号分隔）", defArms);
    const armNames = armInput
      .split(",")
      .map((s) => s.trim())
      .map((s) => (/^\d+$/.test(s) ? ARMS[Number(s) - 1]?.name : s))
      .filter((s): s is string => !!s && ARMS.some((a) => a.name === s));
    if (armNames.length === 0) throw new Error("没有选中任何有效的臂");

    // 3) 用例
    console.log(cyan("\n用例："));
    cases.forEach((c, i) => console.log(`  ${String(i + 1).padStart(2)}) ${c.id} ${dim("— " + c.covers)}`));
    const defCases =
      cfg.lastRun && cfg.lastRun.cases.length > 0 ? cfg.lastRun.cases.join(",") : "a";
    const caseInput = await ask("选择用例（a=全部，t=陷阱 trap-*，或编号/id 逗号分隔）", defCases);
    let caseIds: string[];
    if (caseInput === "a") caseIds = [];
    else if (caseInput === "t") caseIds = cases.filter((c) => c.id.startsWith("trap-")).map((c) => c.id);
    else
      caseIds = caseInput
        .split(",")
        .map((s) => s.trim())
        .map((s) => (/^\d+$/.test(s) ? cases[Number(s) - 1]?.id : s))
        .filter((s): s is string => !!s && cases.some((c) => c.id === s));

    // 4) 重复次数
    const reps = Number(await ask("每格重复次数 REPS", String(cfg.lastRun?.reps ?? 1))) || 1;

    // 5) verified-strong 臂需要核查端点
    let verifierProfile: string | undefined;
    if (armNames.some((n) => ARMS.find((a) => a.name === n)?.verify?.strongModel)) {
      console.log(yellow("\n选了 verified-strong 臂 → 需要指定（更强的）核查端点"));
      verifierProfile = await pickProfile(cfg, ask, "verifier 端点", cfg.lastRun?.verifierProfile);
    }

    // 6) 报告路径
    const report = await ask("报告输出路径", cfg.lastRun?.report ?? "eval/ab-report.md");

    const spec: RunSpec = {
      profile: profileName,
      arms: armNames,
      cases: caseIds,
      reps,
      ...(verifierProfile ? { verifierProfile } : {}),
      report,
    };

    const total = (caseIds.length || cases.length) * armNames.length * reps;
    console.log(
      cyan(`\n即将运行：`) +
        `${caseIds.length || cases.length} 用例 × ${armNames.length} 臂 × ${reps} 次 = ${total} runs`,
    );
    const go = await ask("确认开始？(y/n)", "y");
    if (go.toLowerCase() !== "y") {
      console.log("已取消（配置未保存）");
      return;
    }

    rl.close();
    await launch(cfg, spec);
  } finally {
    rl.close();
  }
}

async function pickProfile(
  cfg: LabConfig,
  ask: (q: string, def: string) => Promise<string>,
  label: string,
  def?: string,
): Promise<string> {
  const names = Object.keys(cfg.profiles);
  console.log(cyan(`\n${label} profile：`));
  names.forEach((n, i) => {
    const p = cfg.profiles[n]!;
    const key = p.apiKey ? "key✓" : yellow("key未填");
    console.log(`  ${i + 1}) ${n} ${dim(`— ${p.provider} ${p.baseURL ?? "(官方)"} ${p.model} ${key}`)}`);
  });
  console.log(`  n) 新建 profile`);
  const pick = await ask("选择", def ?? names[0] ?? "n");

  if (pick !== "n") {
    const name = /^\d+$/.test(pick) ? names[Number(pick) - 1] : pick;
    if (!name || !cfg.profiles[name]) throw new Error(`profile 不存在: ${pick}`);
    // key 未填的老 profile，给一次补填机会（直接回车跳过 = 沿用系统 env）
    if (!cfg.profiles[name].apiKey) {
      const key = await ask(`  ${name} 的 API key（回车=沿用系统 env）`, "");
      if (key) {
        cfg.profiles[name].apiKey = key;
        await saveConfig(cfg);
      }
    }
    return name;
  }

  const name = await ask("  profile 名字", "my-endpoint");
  const provider = (await ask("  协议 (anthropic/openai)", "anthropic")) as "anthropic" | "openai";
  const baseURL = await ask("  base URL（回车=官方端点）", "");
  const apiKey = await ask("  API key（回车=沿用系统 env）", "");
  const model = await ask("  模型名", "claude-opus-4-8");
  const maxTokens = await ask("  AGENT_MAX_TOKENS（回车=默认）", "");
  const timeoutMs = await ask("  AGENT_TIMEOUT_MS（回车=默认）", "");
  const maxRetries = await ask("  AGENT_MAX_RETRIES（回车=默认）", "");
  cfg.profiles[name] = {
    provider,
    ...(baseURL ? { baseURL } : {}),
    ...(apiKey ? { apiKey } : {}),
    model,
    ...(maxTokens ? { maxTokens: Number(maxTokens) } : {}),
    ...(timeoutMs ? { timeoutMs: Number(timeoutMs) } : {}),
    ...(maxRetries !== "" ? { maxRetries: Number(maxRetries) } : {}),
  };
  await saveConfig(cfg);
  console.log(dim(`  已保存到 ${PROFILES_PATH}`));
  return name;
}

/** 把 RunSpec 翻译成环境变量，打印等价命令，然后在本进程内启动 ab.ts */
async function launch(cfg: LabConfig, spec: RunSpec): Promise<void> {
  const p = cfg.profiles[spec.profile];
  if (!p) throw new Error(`profile 不存在: ${spec.profile}`);

  const env: Record<string, string> = {};
  if (p.provider === "openai") {
    env.AGENT_PROVIDER = "openai";
    if (p.baseURL) env.OPENAI_BASE_URL = p.baseURL;
    if (p.apiKey) env.OPENAI_API_KEY = p.apiKey;
  } else {
    env.AGENT_PROVIDER = "anthropic";
    if (p.baseURL) env.ANTHROPIC_BASE_URL = p.baseURL;
    if (p.apiKey) env.ANTHROPIC_API_KEY = p.apiKey;
  }
  env.AGENT_MODEL = p.model;
  if (p.maxTokens !== undefined) env.AGENT_MAX_TOKENS = String(p.maxTokens);
  if (p.timeoutMs !== undefined) env.AGENT_TIMEOUT_MS = String(p.timeoutMs);
  if (p.maxRetries !== undefined) env.AGENT_MAX_RETRIES = String(p.maxRetries);

  env.AB_ARMS = spec.arms.join(",");
  if (spec.cases.length > 0) env.AB_CASES = spec.cases.join(",");
  env.AB_REPS = String(spec.reps);
  env.AB_REPORT = spec.report;

  if (spec.verifierProfile) {
    const v = cfg.profiles[spec.verifierProfile];
    if (!v) throw new Error(`verifier profile 不存在: ${spec.verifierProfile}`);
    env.AB_VERIFIER_MODEL = v.model;
    env.AB_VERIFIER_PROVIDER = v.provider;
    if (v.baseURL) env.AB_VERIFIER_BASE_URL = v.baseURL;
    if (v.apiKey) env.AB_VERIFIER_API_KEY = v.apiKey;
  }

  // 等价命令（PowerShell），key 打码
  const ps = Object.entries(env)
    .map(([k, val]) => `$env:${k}="${k.includes("API_KEY") ? "***" : val}"`)
    .join("; ");
  console.log(dim(`\n等价命令：${ps}; npm run ab\n`));

  cfg.lastRun = spec;
  await saveConfig(cfg);

  Object.assign(process.env, env);
  await import("./ab.js"); // ab.ts 顶层 main() 立即执行
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});

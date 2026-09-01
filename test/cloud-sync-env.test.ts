import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../scripts/cloud-sync-env.sh", import.meta.url));

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** 造一个只含本脚本所需文件的假仓库根 */
function makeRepo(files: { example?: string; production?: string; cloud?: string; env?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "cloud-sync-env-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(SCRIPT, join(root, "scripts", "cloud-sync-env.sh"));
  writeFileSync(join(root, ".env.example"), files.example ?? "");
  if (files.production !== undefined) writeFileSync(join(root, ".env.production.example"), files.production);
  if (files.cloud !== undefined) writeFileSync(join(root, ".env.cloud"), files.cloud);
  if (files.env !== undefined) writeFileSync(join(root, ".env"), files.env);
  return root;
}

function sync(root: string, secrets: Record<string, string> = {}): string {
  return execFileSync("bash", [join(root, "scripts", "cloud-sync-env.sh")], {
    env: { PATH: process.env.PATH ?? "", ...secrets },
    encoding: "utf8",
  });
}

function readEnv(root: string): string {
  return readFileSync(join(root, ".env"), "utf8");
}

/** 用 Node 自己的 --env-file 解析器读回，确认落盘格式真的能被消费 */
function readBackViaNode(root: string, key: string): string {
  return execFileSync(
    process.execPath,
    [`--env-file=${join(root, ".env")}`, "-e", `process.stdout.write(process.env[process.argv[1]] ?? "<missing>")`, key],
    { encoding: "utf8" },
  );
}

describe("cloud-sync-env.sh：Secrets → 工作区 .env", () => {
  it("注释态声明的变量同样参与同步", () => {
    // .env.example 里除两个 API key 之外全是注释行。只认未注释行，
    // 会把 ANTHROPIC_BASE_URL / AGENT_MODEL 这类同名 Secret 静默丢掉。
    const root = makeRepo({
      example: ["ANTHROPIC_API_KEY=", "# ANTHROPIC_BASE_URL=", "# AGENT_EFFORT=high"].join("\n"),
    });

    sync(root, { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", AGENT_EFFORT: "high" });

    expect(readBackViaNode(root, "ANTHROPIC_BASE_URL")).toBe("https://api.deepseek.com/anthropic");
    expect(readBackViaNode(root, "AGENT_EFFORT")).toBe("high");
  });

  it("Secrets 覆盖 .env.cloud 默认项，且每个键只落一行", () => {
    const root = makeRepo({
      example: "ANTHROPIC_API_KEY=",
      cloud: ["# 注释", "ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic", "AGENT_MODEL=deepseek-chat"].join("\n"),
    });

    sync(root, { ANTHROPIC_API_KEY: "sk-test", AGENT_MODEL: "deepseek-reasoner" });

    expect(readBackViaNode(root, "AGENT_MODEL")).toBe("deepseek-reasoner");
    expect(readBackViaNode(root, "ANTHROPIC_BASE_URL")).toBe("https://api.deepseek.com/anthropic");
    expect(readEnv(root).match(/^AGENT_MODEL=/gm)).toHaveLength(1);
  });

  it("含 # / 空格 / 引号的值带引号落盘，Node --env-file 原样读回", () => {
    const root = makeRepo({
      example: ["ANTHROPIC_API_KEY=", "# AGENT_UI_ALLOWED_ORIGINS=", "# AGENT_UI_ACCESS_TOKEN="].join("\n"),
    });

    // 裸值写法下 # 与行尾空白会改写语义，单引号值还会撞上 dotenv 不认转义
    sync(root, {
      AGENT_UI_ALLOWED_ORIGINS: "https://a.example.com #主域 https://b.example.com",
      AGENT_UI_ACCESS_TOKEN: "it's a token",
    });

    expect(readBackViaNode(root, "AGENT_UI_ALLOWED_ORIGINS")).toBe(
      "https://a.example.com #主域 https://b.example.com",
    );
    expect(readBackViaNode(root, "AGENT_UI_ACCESS_TOKEN")).toBe("it's a token");
  });

  it("未被示例文件声明的变量不进 .env；逃生口显式放行", () => {
    const root = makeRepo({ example: "ANTHROPIC_API_KEY=" });

    const withoutEscape = sync(root, { ANTHROPIC_API_KEY: "sk-test", CURSOR_AGENT: "1", HOSTILE_VAR: "x" });
    expect(readEnv(root)).not.toMatch(/CURSOR_AGENT|HOSTILE_VAR/);
    expect(withoutEscape).toContain("Secrets 命中 1 项");

    sync(root, {
      ANTHROPIC_API_KEY: "sk-test",
      HOSTILE_VAR: "x",
      AGENT_CLOUD_ENV_EXTRA_KEYS: " HOSTILE_VAR , SECOND_VAR ",
      SECOND_VAR: "y",
    });
    expect(readBackViaNode(root, "HOSTILE_VAR")).toBe("x");
    expect(readBackViaNode(root, "SECOND_VAR")).toBe("y");
  });

  it("示例文件末尾缺换行也不会把键名粘成一行", () => {
    // makeRepo 按原样写入，此处刻意不留结尾换行
    const root = makeRepo({ example: "ANTHROPIC_API_KEY=", production: "# AGENT_UI_PORT=4173" });

    const out = sync(root, { ANTHROPIC_API_KEY: "sk-test", AGENT_UI_PORT: "4300" });

    expect(out).toContain("已声明变量 2 个");
    expect(readBackViaNode(root, "ANTHROPIC_API_KEY")).toBe("sk-test");
    expect(readBackViaNode(root, "AGENT_UI_PORT")).toBe("4300");
  });

  it("既无默认项也无 Secret 时不生成空 .env", () => {
    const root = makeRepo({ example: "ANTHROPIC_API_KEY=" });

    const out = sync(root);

    expect(out).toContain("没有任何变量可写");
    expect(existsSync(join(root, ".env"))).toBe(false);
  });

  it("只打印变量名，绝不打印值", () => {
    const root = makeRepo({ example: "ANTHROPIC_API_KEY=" });

    const out = sync(root, { ANTHROPIC_API_KEY: "sk-super-secret-value" });

    expect(out).toContain("ANTHROPIC_API_KEY");
    expect(out).not.toContain("sk-super-secret-value");
  });

  it("零 Secret 时不覆盖已有 .env，且不对该文件里的凭据误报", () => {
    const root = makeRepo({
      example: "ANTHROPIC_API_KEY=",
      cloud: "AGENT_MODEL=deepseek-chat",
      env: "ANTHROPIC_API_KEY='sk-hand-written'\n",
    });

    const out = sync(root);

    expect(out).toContain("Secrets 命中 0 项");
    expect(out).toContain("保留现有");
    expect(out).not.toContain("警告");
    expect(readEnv(root)).toBe("ANTHROPIC_API_KEY='sk-hand-written'\n");
  });

  it("零 Secret 且已有 .env 里也没有凭据时照样吵出来", () => {
    const root = makeRepo({
      example: "ANTHROPIC_API_KEY=",
      cloud: "AGENT_MODEL=deepseek-chat",
      env: "ANTHROPIC_API_KEY=\nAGENT_MODEL='deepseek-chat'\n",
    });

    const out = sync(root);

    expect(out).toContain("credential_present: no");
    expect(out).toContain("重开一个 Agent");
    expect(readEnv(root)).toContain("ANTHROPIC_API_KEY=\n");
  });

  it("零 Secret 且无 .env 时，落盘只有默认项并仍然告警", () => {
    const root = makeRepo({ example: "ANTHROPIC_API_KEY=", cloud: "AGENT_MODEL=deepseek-chat" });

    const out = sync(root);

    expect(existsSync(join(root, ".env"))).toBe(true);
    expect(readBackViaNode(root, "AGENT_MODEL")).toBe("deepseek-chat");
    expect(readBackViaNode(root, "ANTHROPIC_API_KEY")).toBe("<missing>");
    expect(out).toContain("警告");
  });

  it("拿到凭据时不再告警", () => {
    const root = makeRepo({ example: ["ANTHROPIC_API_KEY=", "OPENAI_API_KEY="].join("\n") });

    const out = sync(root, { OPENAI_API_KEY: "sk-openai" });

    expect(out).not.toContain("警告");
    expect(readBackViaNode(root, "OPENAI_API_KEY")).toBe("sk-openai");
  });
});

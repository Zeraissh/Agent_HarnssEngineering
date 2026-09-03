import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildStaticDoctorReport,
  CLI_VERSION,
  CliArgumentError,
  cliHelpText,
  formatStaticDoctor,
  parseCliArgs,
} from "../src/cli-args.js";

describe("CLI argument contract", () => {
  it("保留旧入口，并支持显式 run 子命令", () => {
    expect(parseCliArgs(["--verify", "修复", "测试"])).toMatchObject({
      command: "run", task: "修复 测试", verify: true,
    });
    expect(parseCliArgs(["run", "--auto", "修复", "测试"])).toMatchObject({
      command: "run", task: "修复 测试", auto: true,
    });
  });

  it("--parallel N 消费分离值，不再把 N 拼进 task", () => {
    expect(parseCliArgs(["run", "--plan", "--parallel", "3", "执行", "任务"]))
      .toMatchObject({ plan: true, concurrency: 3, task: "执行 任务" });
    expect(parseCliArgs(["--plan", "--parallel=2", "执行"]))
      .toMatchObject({ concurrency: 2, task: "执行" });
    expect(parseCliArgs(["--plan", "--parallel", "执行"]))
      .toMatchObject({ concurrency: "auto", task: "执行" });
  });

  it("-- 分隔符后的 flag 形状属于任务正文", () => {
    expect(parseCliArgs(["run", "--", "--not-a-flag", "正文"]).task)
      .toBe("--not-a-flag 正文");
  });

  it("严格拒绝未知、重复、非法值和冲突参数", () => {
    expect(() => parseCliArgs(["--bogus", "task"])).toThrowError(CliArgumentError);
    expect(() => parseCliArgs(["--verify", "--verify", "task"])).toThrow(/参数重复/);
    expect(() => parseCliArgs(["--plan", "--parallel=0", "task"])).toThrow(/无效/);
    expect(() => parseCliArgs(["--parallel", "3", "task"])).toThrow(/只对 --plan/);
    expect(() => parseCliArgs(["--yes", "--ask", "task"])).toThrow(/互斥/);
    expect(() => parseCliArgs(["--plan", "--auto", "task"])).toThrow(/互斥/);
    expect(() => parseCliArgs(["run", "--doctor", "task"])).toThrow(/不能.*同时/);
    expect(() => parseCliArgs(["--help", "--version"])).toThrow(/命令冲突/);
  });

  it("help/version/doctor 不接受任务或 run 参数", () => {
    expect(parseCliArgs(["--help"]).command).toBe("help");
    expect(parseCliArgs(["version"]).command).toBe("version");
    expect(parseCliArgs(["doctor"]).command).toBe("doctor");
    expect(() => parseCliArgs(["--doctor", "--verify"])).toThrow(/不能与任务或 run 参数/);
    expect(cliHelpText()).toContain("npm run agent -- doctor");
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // 发布门只校验 tag == 根 package.json；--version 打印的常量与桌面壳版本不在那道门里，
  // 三者不锁在一起就会各自漂移（REL-02 的"版本同步 CI"起步）。
  it("CLI_VERSION 与根 / cross-app 的 package.json 版本一致", () => {
    const readVersion = (path: string) =>
      (JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as { version: string }).version;
    expect(CLI_VERSION).toBe(readVersion("../package.json"));
    expect(CLI_VERSION).toBe(readVersion("../cross-app/package.json"));
  });
});

describe("static doctor", () => {
  it("只报告 origin、credential presence 和来源，绝不输出 key 或 URL secret", () => {
    const secret = "sk-doctor-sentinel";
    const report = buildStaticDoctorReport(
      {
        AGENT_PROVIDER: "openai",
        AGENT_MODEL: "model-x",
        OPENAI_BASE_URL: "https://api.example.test/v1",
        OPENAI_API_KEY: secret,
      },
      {
        AGENT_PROVIDER: "openai",
        AGENT_MODEL: "old-model",
        OPENAI_API_KEY: secret,
      },
    );
    const text = formatStaticDoctor(report);

    expect(report.ok).toBe(true);
    expect(text).toContain("provider: openai (source: .env-or-environment-same-value)");
    expect(text).toContain("model: model-x (source: environment-overrides-.env)");
    expect(text).toContain("base_url_origin: https://api.example.test");
    expect(text).toContain("credential_present: yes");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("/v1");
  });

  it("远程 HTTP、127 前缀域名和 URL query 均不能通过静态 doctor", () => {
    for (const endpoint of [
      "http://api.attacker.example/v1",
      "http://127.attacker.example/v1",
      "https://api.example.test/v1?token=url-secret",
    ]) {
      const text = formatStaticDoctor(buildStaticDoctorReport({
        AGENT_PROVIDER: "openai",
        OPENAI_BASE_URL: endpoint,
        OPENAI_API_KEY: "key-secret",
      }, {}));
      expect(text).toContain("base_url_origin: <invalid>");
      expect(text).not.toContain("attacker");
      expect(text).not.toContain("url-secret");
      expect(text).not.toContain("key-secret");
    }
  });

  it("缺 key、非法 provider 或带 userinfo 的 URL fail closed，且不回显原始 URL", () => {
    const report = buildStaticDoctorReport({
      AGENT_PROVIDER: "unknown",
      ANTHROPIC_BASE_URL: "https://user:password@example.test/v1",
    }, {});
    const text = formatStaticDoctor(report);

    expect(report.ok).toBe(false);
    expect(text).toContain("provider: <invalid>");
    expect(text).toContain("base_url_origin: <invalid>");
    expect(text).toContain("credential_present: no (source: missing)");
    expect(text).not.toContain("password");
    expect(text).not.toContain("user:");
  });

  it("provider/model 的控制字符不会形成终端注入", () => {
    const text = formatStaticDoctor(buildStaticDoctorReport({
      AGENT_PROVIDER: "\u001b[31mopenai",
      AGENT_MODEL: "model\rforged-line",
      ANTHROPIC_API_KEY: "present-but-never-print",
    }, {}));
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("forged-line");
    expect(text).not.toContain("present-but-never-print");
    expect(text.match(/<invalid>/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("doctor 与 runtime 对 provider/model 首尾空白保持同一 fail-closed 语义", () => {
    const report = buildStaticDoctorReport({
      AGENT_PROVIDER: " openai ",
      AGENT_MODEL: " model-with-spaces ",
      ANTHROPIC_API_KEY: "present",
    }, {});
    expect(report.ok).toBe(false);
    expect(report.provider.value).toBe("<invalid>");
    expect(report.model.value).toBe("<invalid>");
  });
});

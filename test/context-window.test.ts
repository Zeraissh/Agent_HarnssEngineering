/**
 * MEM-01 窗口 / 预算分离（src/context-window.ts + model-windows.ts + model-capability.ts 的学习面）。
 *
 * 锁四件事：① 窗口四级来源的优先级；② 从真机 / SDK 形状的 400 报文里解析窗口；
 * ③ 夹紧算式（含 maxTokens 与边际）与"默认不自动抬高"；④ 逐 run 预算校验的区间与错误文案。
 * 变异验证（手工，提交信息有数）：删夹紧分支 → 本文件红；删 loop 学习钩子 → compact-tier2 红。
 */
import Anthropic from "@anthropic-ai/sdk";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTEXT_BUDGET_FLOOR,
  CONTEXT_TOKEN_LIMIT_HARD_CAP,
  DEFAULT_CONTEXT_TOKEN_LIMIT,
  MIN_CONTEXT_TOKEN_LIMIT,
  contextWindowMargin,
  describeContextPlan,
  formatTokensK,
  maxContextBudget,
  planContextBudget,
  readContextLimitEnv,
  readContextWindowEnv,
  resolveContextWindow,
  validateRunContextBudget,
} from "../src/context-window.js";
import {
  DEFAULT_LEARNED_WINDOW_TTL_MS,
  clearCapabilityCache,
  configureCapabilityStore,
  getLearnedContextWindow,
  learnContextWindow,
  parseContextWindowFromOverflowError,
} from "../src/model-capability.js";
import { MODEL_WINDOW_REGISTRY, registryContextWindow } from "../src/model-windows.js";

const deepseek = { provider: "anthropic" as const, model: "deepseek-v4-flash", baseURL: "https://api.deepseek.com/anthropic" };
const unknownModel = { provider: "anthropic" as const, model: "mock-model", baseURL: "http://127.0.0.1:4010" };

afterEach(() => {
  clearCapabilityCache();
  configureCapabilityStore({ file: null });
});

// ---------------------------------------------------------------- 登记表

describe("model-windows 登记表：有出处才登记", () => {
  it("DeepSeek v4 flash / pro = 1,048,576（真机 400 报文）；Claude 4.x 按文档 200k / 1M 分档；Kimi k3 1M、k2.x 256k", () => {
    expect(registryContextWindow("deepseek-v4-flash")?.windowTokens).toBe(1_048_576);
    expect(registryContextWindow("deepseek-v4-pro")?.windowTokens).toBe(1_048_576);
    expect(registryContextWindow("claude-opus-4-8")?.windowTokens).toBe(1_000_000);
    expect(registryContextWindow("claude-sonnet-4-6-20260217")?.windowTokens).toBe(1_000_000);
    expect(registryContextWindow("claude-sonnet-4-5-20250929")?.windowTokens).toBe(200_000);
    expect(registryContextWindow("claude-opus-4-1")?.windowTokens).toBe(200_000);
    expect(registryContextWindow("claude-haiku-4-5")?.windowTokens).toBe(200_000);
    expect(registryContextWindow("kimi-k3")?.windowTokens).toBe(1_048_576);
    expect(registryContextWindow("kimi-k2.6")?.windowTokens).toBe(262_144);
  });

  it("不认识的模型不猜：mock-model / 视觉变体 / 空串都 undefined", () => {
    expect(registryContextWindow("mock-model")).toBeUndefined();
    expect(registryContextWindow("deepseek-v4-flash-vision-exp")).toBeUndefined();
    expect(registryContextWindow("")).toBeUndefined();
  });

  it("每条登记都写了出处（没有出处的数不许进表）", () => {
    for (const entry of MODEL_WINDOW_REGISTRY) {
      expect(entry.source.length).toBeGreaterThan(20);
      expect(entry.windowTokens).toBeGreaterThanOrEqual(100_000);
    }
  });
});

// ---------------------------------------------------------------- 学习：从 400 报文解析

describe("parseContextWindowFromOverflowError：只认见过的措辞，取最大值那个数", () => {
  it("DeepSeek 兼容路由的真实 SDK 形状（OpenAI 信封塞进 message，逐字同 compact-tier2 的锁）→ 1048576", () => {
    const body = {
      error: {
        message:
          "This model's maximum context length is 1048576 tokens. However, you requested 1220725 tokens " +
          "(1156725 in the messages, 64000 in the completion). Please reduce the length of the messages or completion.",
        type: "invalid_request_error",
        param: null,
        code: "invalid_request_error",
      },
    };
    const err = Anthropic.APIError.generate(400, body, undefined, new Headers({ "content-type": "application/octet-stream" }));
    expect(parseContextWindowFromOverflowError(err)).toBe(1_048_576);
  });

  it("OpenAI 原生形状 → 128000；Anthropic「N tokens > M maximum」→ M（不是 N）", () => {
    expect(
      parseContextWindowFromOverflowError(
        Object.assign(new Error("This model's maximum context length is 128000 tokens. However, your messages resulted in 131072 tokens."), { status: 400 }),
      ),
    ).toBe(128_000);
    expect(
      parseContextWindowFromOverflowError(Object.assign(new Error("prompt is too long: 213462 tokens > 200000 maximum"), { status: 400 })),
    ).toBe(200_000);
    // 嵌套 error.message 也认（有的 SDK 把 message 放在 error 对象里）
    expect(
      parseContextWindowFromOverflowError({ status: 400, message: "Request too large", error: { message: "prompt is too long: 9 tokens > 4096 maximum" } }),
    ).toBe(4096);
  });

  it("措辞对不上 / 数字荒谬 / 非对象 → null（宁可不学，不能学错）", () => {
    expect(parseContextWindowFromOverflowError(new Error("context_length_exceeded"))).toBeNull();
    expect(parseContextWindowFromOverflowError(new Error("prompt is too long: 9 tokens > 12 maximum"))).toBeNull();
    expect(parseContextWindowFromOverflowError(null)).toBeNull();
    expect(parseContextWindowFromOverflowError(42)).toBeNull();
  });
});

// ---------------------------------------------------------------- 学习：粘性 + TTL + 落盘

describe("learnContextWindow / getLearnedContextWindow：按端点身份记，TTL 30 天，可落盘不落 key", () => {
  it("记下即可读回；同身份覆盖；过期即忘；非法值忽略", () => {
    const t0 = 1_700_000_000_000;
    expect(learnContextWindow(deepseek, 1_048_576, t0)?.windowTokens).toBe(1_048_576);
    expect(getLearnedContextWindow(deepseek, t0 + 1000)?.windowTokens).toBe(1_048_576);
    // 另一个身份（同模型不同 origin）互不串
    expect(getLearnedContextWindow({ ...deepseek, baseURL: "https://other.example" }, t0)).toBeUndefined();
    expect(learnContextWindow(deepseek, 999, t0)).toBeNull();
    expect(learnContextWindow(deepseek, 1.5, t0)).toBeNull();
    expect(getLearnedContextWindow(deepseek, t0 + DEFAULT_LEARNED_WINDOW_TTL_MS + 1)).toBeUndefined();
  });

  it("配置了文件就落盘（身份键 + 数字 + 时间，无 key），新进程 configure 时读回；坏文件当空表", async () => {
    const dir = await mkdtemp(join(tmpdir(), "caps-"));
    const file = join(dir, "nested", ".agent-capabilities.json");
    configureCapabilityStore({ file });
    learnContextWindow(deepseek, 1_048_576, 1_700_000_000_000);
    const raw = await readFile(file, "utf8");
    expect(raw).toContain('"anthropic|deepseek-v4-flash|https://api.deepseek.com"');
    expect(raw).toContain('"windowTokens": 1048576');
    expect(raw).not.toMatch(/sk-|api[_-]?key/i);

    // 模拟新进程：清内存表再 configure 同一文件
    clearCapabilityCache();
    expect(getLearnedContextWindow(deepseek, 1_700_000_000_000)).toBeUndefined();
    expect(configureCapabilityStore({ file }).loaded).toBe(1);
    expect(getLearnedContextWindow(deepseek, 1_700_000_000_000)?.windowTokens).toBe(1_048_576);

    // 坏文件：不抛，空表
    clearCapabilityCache();
    expect(configureCapabilityStore({ file: join(dir, "no-such.json") }).loaded).toBe(0);
  });
});

// ---------------------------------------------------------------- 窗口四级来源

describe("resolveContextWindow：env > learned > registry > unknown", () => {
  it("四级各自命中，且高优先级压过低优先级", () => {
    // unknown：不在登记表、没学过、没 env
    expect(resolveContextWindow(unknownModel, {})).toEqual({ window: null, windowSource: "unknown", windowNote: null });
    // registry
    expect(resolveContextWindow(deepseek, {})).toMatchObject({ window: 1_048_576, windowSource: "registry" });
    // learned 压过 registry（同名模型在这台端点后面被配成 256k）
    learnContextWindow(deepseek, 262_144, 1_700_000_000_000);
    expect(resolveContextWindow(deepseek, {}, 1_700_000_000_000)).toMatchObject({ window: 262_144, windowSource: "learned" });
    // env 压过一切
    expect(resolveContextWindow(deepseek, { AGENT_CONTEXT_WINDOW: "131072" })).toMatchObject({ window: 131_072, windowSource: "env" });
    // learned 过期退回 registry
    expect(resolveContextWindow(deepseek, {}, 1_700_000_000_000 + DEFAULT_LEARNED_WINDOW_TTL_MS + 1)).toMatchObject({ windowSource: "registry" });
  });

  it("env 非法值抛错而不是静默降级（口径同其它护栏 env）", () => {
    expect(() => readContextWindowEnv({ AGENT_CONTEXT_WINDOW: "big" })).toThrow(/AGENT_CONTEXT_WINDOW/);
    expect(() => readContextWindowEnv({ AGENT_CONTEXT_WINDOW: "0" })).toThrow();
    expect(readContextWindowEnv({ AGENT_CONTEXT_WINDOW: "" })).toBeUndefined();
    expect(() => readContextLimitEnv({ AGENT_CONTEXT_LIMIT: "abc" })).toThrow(/AGENT_CONTEXT_LIMIT/);
    expect(readContextLimitEnv({ AGENT_CONTEXT_LIMIT: "1e7" })).toBe(10_000_000);
  });
});

// ---------------------------------------------------------------- 夹紧算式

describe("planContextBudget：三级覆盖 + 夹紧 = 窗口 − maxTokens − 边际", () => {
  it("边际 = max(4k, 2%)；maxBudget 可为负（配置不自洽要能看见）", () => {
    expect(contextWindowMargin(128_000)).toBe(4_096); // 2% = 2560 < 4096
    expect(contextWindowMargin(1_048_576)).toBe(20_971); // 2%
    expect(maxContextBudget(1_048_576, 64_000)).toBe(963_605);
    expect(maxContextBudget(128_000, 64_000)).toBe(59_904);
    expect(maxContextBudget(32_000, 64_000)).toBeLessThan(0);
  });

  it("窗口未知：预算按配置，maxBudget=null，不夹", () => {
    const plan = planContextBudget({ window: null, windowSource: "unknown", maxTokens: 64_000 });
    expect(plan).toMatchObject({ budget: DEFAULT_CONTEXT_TOKEN_LIMIT, budgetSource: "default", maxBudget: null, clamped: false, warning: null });
  });

  it("窗口 1M（deepseek 实测）：默认 150k **不**自动抬高——保守是设计，不是漏做", () => {
    const plan = planContextBudget({ window: 1_048_576, windowSource: "registry", maxTokens: 64_000 });
    expect(plan.budget).toBe(150_000);
    expect(plan.maxBudget).toBe(963_605);
    expect(plan.clamped).toBe(false);
  });

  it("窗口 128k：150k 超过 59,904 → 夹到 59,904，带告警且原值可见；来源仍是 default", () => {
    const plan = planContextBudget({ window: 128_000, windowSource: "learned", maxTokens: 64_000 });
    expect(plan.budget).toBe(59_904);
    expect(plan.requestedBudget).toBe(150_000);
    expect(plan.clamped).toBe(true);
    expect(plan.budgetSource).toBe("default");
    expect(plan.warning).toContain("150k");
    expect(plan.warning).toContain("59k");
    expect(plan.warning).toContain("maxTokens 64k");
    expect(describeContextPlan(plan)).toBe("上下文：预算 59k（由 150k 夹紧） / 窗口 128k（来源：learned）");
  });

  it("maxTokens 参与夹紧：同一窗口下 maxTokens 越大预算上限越小（变异：去掉 maxTokens 项这里就红）", () => {
    const small = planContextBudget({ window: 200_000, windowSource: "env", maxTokens: 4_096, envLimit: 190_000 });
    const big = planContextBudget({ window: 200_000, windowSource: "env", maxTokens: 64_000, envLimit: 190_000 });
    expect(small.budget).toBe(190_000); // 200000 − 4096 − 4096 = 191,808 ≥ 190k → 不夹
    expect(big.budget).toBe(131_904); // 200000 − 64000 − 4096
    expect(big.clamped).toBe(true);
  });

  it("三级覆盖：run > env > pack > default，来源如实", () => {
    const w = { window: 1_048_576, windowSource: "registry" as const, maxTokens: 64_000 };
    expect(planContextBudget({ ...w, packLimit: 120_000 })).toMatchObject({ budget: 120_000, budgetSource: "pack" });
    expect(planContextBudget({ ...w, packLimit: 120_000, envLimit: 300_000 })).toMatchObject({ budget: 300_000, budgetSource: "env" });
    expect(planContextBudget({ ...w, packLimit: 120_000, envLimit: 300_000, runLimit: 500_000 })).toMatchObject({ budget: 500_000, budgetSource: "run" });
  });

  it("配置不自洽（maxTokens ≥ 窗口）：夹到地板并把算式写进告警", () => {
    const plan = planContextBudget({ window: 32_000, windowSource: "env", maxTokens: 64_000 });
    expect(plan.budget).toBe(CONTEXT_BUDGET_FLOOR);
    expect(plan.clamped).toBe(true);
    expect(plan.warning).toContain("配置不自洽");
    expect(plan.warning).toContain("AGENT_MAX_TOKENS");
  });

  it("CLI 启动行：默认预算不带来源、非默认带来源、窗口未知照实说", () => {
    expect(describeContextPlan(planContextBudget({ window: 1_048_576, windowSource: "learned", maxTokens: 64_000 })))
      .toBe("上下文：预算 150k / 窗口 1,048k（来源：learned）");
    expect(describeContextPlan(planContextBudget({ window: null, windowSource: "unknown", maxTokens: 64_000, envLimit: 200_000 })))
      .toBe("上下文：预算 200k（env） / 窗口未知");
    expect(formatTokensK(1_048_576)).toBe("1,048k");
    expect(formatTokensK(59_904)).toBe("59k");
  });
});

// ---------------------------------------------------------------- 逐 run 预算校验

describe("validateRunContextBudget：区间 [32k, maxBudget]，越界拒绝并报区间", () => {
  it("窗口已知：上限 = maxBudget；下限 32k；非整数拒", () => {
    expect(validateRunContextBudget(500_000, 963_605)).toEqual({ ok: true, value: 500_000 });
    expect(validateRunContextBudget("64000", 963_605)).toEqual({ ok: true, value: 64_000 });
    const tooBig = validateRunContextBudget(1_000_000, 963_605);
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) {
      expect(tooBig).toMatchObject({ min: MIN_CONTEXT_TOKEN_LIMIT, max: 963_605 });
      expect(tooBig.error).toContain("32000..963605");
      expect(tooBig.error).toContain("窗口 − maxTokens − 边际");
    }
    const tooSmall = validateRunContextBudget(1_000, 963_605);
    expect(tooSmall.ok).toBe(false);
    expect(validateRunContextBudget(1.5, 963_605).ok).toBe(false);
    expect(validateRunContextBudget("abc", 963_605).ok).toBe(false);
  });

  it("窗口未知：上限取硬顶 2M 并在文案里说明", () => {
    expect(validateRunContextBudget(1_500_000, null)).toEqual({ ok: true, value: 1_500_000 });
    const r = validateRunContextBudget(CONTEXT_TOKEN_LIMIT_HARD_CAP + 1, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("窗口未知");
  });

  it("窗口太小以致 maxBudget < 32k：任何值都拒，并指出调 AGENT_MAX_TOKENS", () => {
    const r = validateRunContextBudget(32_000, 20_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("AGENT_MAX_TOKENS");
  });
});

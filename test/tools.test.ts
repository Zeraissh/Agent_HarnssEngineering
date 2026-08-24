import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools/registry.js";
import { credentialLikeName, resolveInWorkdir, truncate } from "../src/tools/fs-util.js";
import { readFileTool } from "../src/tools/read-file.js";
import { writeFileTool } from "../src/tools/write-file.js";
import { SHELL_DESC, bashTool, sanitizeChildEnv } from "../src/tools/bash.js";
import { makeTool } from "./helpers.js";

let workdir: string;
const ctx = (toolUseId = "tu_test") => ({
  workdir,
  toolUseId,
  signal: new AbortController().signal,
});

beforeAll(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "harness-test-"));
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("resolveInWorkdir", () => {
  it("拒绝 .. 逃逸", () => {
    expect(() => resolveInWorkdir(workdir, "../outside.txt")).toThrow(/escapes/);
    expect(() => resolveInWorkdir(workdir, "a/../../outside.txt")).toThrow(/escapes/);
  });

  it("拒绝工作区外的绝对路径", () => {
    // 在任何平台都是绝对路径且在工作区外（workdir 的兄弟目录）。
    // 修前这里写死 "C:\\..."——在 Linux 上那是相对路径，测试只在 Windows 有牙齿
    // （CI 首跑实测抓到：本机绿、ubuntu 红）。
    const outsideAbs = path.join(tmpdir(), "definitely-outside", "x.txt");
    expect(() => resolveInWorkdir(workdir, outsideAbs)).toThrow(/escapes/);
    if (process.platform === "win32") {
      expect(() => resolveInWorkdir(workdir, "C:\\Windows\\system32\\x.txt")).toThrow(/escapes/);
    }
  });

  it("接受工作区内的相对与嵌套路径", () => {
    expect(resolveInWorkdir(workdir, "a/b/c.txt")).toBe(path.resolve(workdir, "a/b/c.txt"));
  });
});

/**
 * read_file 切片（案例 #9 第四跑催生）：verifier 读大 s-expression 文件时
 * **幻觉了 offset 参数**，被失败开放校验静默放行、返回文件头，还把"参数没生效"
 * 写进了裁决。模型自发想要的参数是真需求的最诚实信号——补上，语义按行、1 基。
 */
describe("read_file offset/limit 切片", () => {
  beforeAll(async () => {
    await writeFileTool.execute(
      { path: "sliced.txt", content: "L1\nL2\nL3\nL4\nL5" },
      { workdir, toolUseId: "tu_seed_slice", signal: new AbortController().signal },
    );
  });

  it("offset+limit：1 基行号切片，带范围头", async () => {
    const r = await readFileTool.execute({ path: "sliced.txt", offset: 2, limit: 2 }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toBe("[lines 2-3 of 5]\nL2\nL3");
  });

  it("只给 offset：读到文件尾", async () => {
    const r = await readFileTool.execute({ path: "sliced.txt", offset: 4 }, ctx());
    expect(r.content).toBe("[lines 4-5 of 5]\nL4\nL5");
  });

  it("offset 越界给明确报错，不给静默空串（空串会被当成「文件到头了」）", async () => {
    const r = await readFileTool.execute({ path: "sliced.txt", offset: 99 }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("exceeds");
  });

  it("不带 offset/limit 时行为与从前逐字相同", async () => {
    const r = await readFileTool.execute({ path: "sliced.txt" }, ctx());
    expect(r.content).toBe("L1\nL2\nL3\nL4\nL5");
  });
});

describe("额外只读根（readRoots，案例 #5 催生）", () => {
  let readRoot: string;

  beforeAll(async () => {
    readRoot = await mkdtemp(path.join(tmpdir(), "harness-readroot-"));
    const w = await writeFileTool.execute(
      { path: "lib/part.kicad_sym", content: "(kicad_symbol_lib)" },
      { workdir: readRoot, toolUseId: "tu_seed", signal: new AbortController().signal },
    );
    expect(w.isError).toBeUndefined();
  });

  afterAll(async () => {
    await rm(readRoot, { recursive: true, force: true });
  });

  it("read_file 可用绝对路径读取只读根内的文件", async () => {
    const r = await readFileTool.execute(
      { path: path.join(readRoot, "lib/part.kicad_sym") },
      { ...ctx(), readRoots: [readRoot] },
    );
    expect(r.content).toBe("(kicad_symbol_lib)");
  });

  it("未配置只读根时,同一绝对路径仍被拒绝(错误提示不提根)", async () => {
    await expect(
      readFileTool.execute({ path: path.join(readRoot, "lib/part.kicad_sym") }, ctx()),
    ).rejects.toThrow(/escapes(?![\s\S]*read-only roots)/);
  });

  it("从只读根 .. 逃逸被拒绝,且错误提示列出可用根", async () => {
    await expect(
      readFileTool.execute(
        { path: path.join(readRoot, "..", "sibling.txt") },
        { ...ctx(), readRoots: [readRoot] },
      ),
    ).rejects.toThrow(/read-only roots/);
  });

  it("write_file 不受只读根影响——根内绝对路径仍被拒绝", async () => {
    await expect(
      writeFileTool.execute(
        { path: path.join(readRoot, "lib/hacked.txt"), content: "x" },
        { ...ctx(), readRoots: [readRoot] },
      ),
    ).rejects.toThrow(/escapes/);
  });
});

describe("write_file + read_file", () => {
  it("写入后可读回，自动创建父目录", async () => {
    const w = await writeFileTool.execute({ path: "nested/dir/out.txt", content: "你好 harness" }, ctx());
    expect(w.isError).toBeUndefined();
    expect(await readFile(path.join(workdir, "nested/dir/out.txt"), "utf8")).toBe("你好 harness");

    const r = await readFileTool.execute({ path: "nested/dir/out.txt" }, ctx());
    expect(r.content).toBe("你好 harness");
  });

  it("逃逸路径被拒绝（错误抛给 executor 收敛为 is_error）", async () => {
    await expect(
      writeFileTool.execute({ path: "../../evil.txt", content: "x" }, ctx()),
    ).rejects.toThrow(/escapes/);
  });
});

describe("truncate", () => {
  it("超限内容截断并标注", () => {
    const out = truncate("a".repeat(100), 10);
    expect(out).toContain("truncated 90 of 100 chars");
  });
});

describe("ToolRegistry", () => {
  it("toApiTools 按 name 排序（缓存前缀稳定）", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool({ name: "zeta" }));
    reg.register(makeTool({ name: "alpha" }));
    reg.register(makeTool({ name: "mid" }));
    expect(reg.toApiTools().map((t) => t.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("重复注册报错", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool({ name: "dup" }));
    expect(() => reg.register(makeTool({ name: "dup" }))).toThrow(/already registered/);
  });
});

/**
 * 三条 high 安全修复（审计 2026-08-24）之二/之三的行为锁。
 * 之一（启动横幅不打令牌）锁在 test/ui-production.test.ts。
 */
describe("read_file 凭据文件防线：auto 权限对密钥形状关门", () => {
  it("credentialLikeName 分类：密钥形状拒、模板放行、普通文件放行", () => {
    for (const p of [".env", ".env.local", "config/.env.production", ".npmrc", ".netrc", "id_rsa", "id_rsa.pub", "id_ed25519", "certs/server.pem"]) {
      expect(credentialLikeName(p), p).toBe(true);
    }
    for (const p of [".env.example", ".env.production.example", "sample/.env.sample", "environment.ts", "envelope.txt", "README.md", "src/main.rs"]) {
      expect(credentialLikeName(p), p).toBe(false);
    }
  });

  it("读 .env → 拒绝，报错说明原因并指出审批门改道；防线先于文件系统触发", async () => {
    await writeFileTool.execute(
      { path: ".env", content: "ANTHROPIC_API_KEY=sk-real-secret" },
      ctx("tu_seed_env"),
    );
    const r = await readFileTool.execute({ path: ".env" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/credential/i);
    expect(r.content).toMatch(/approval-gated bash/);
    // 内容绝不外漏——把防线挪到读取之后，这一条立即红
    expect(r.content).not.toContain("sk-real-secret");
    // 防线在 resolve/读盘之前：不存在的凭据形状路径也给同一种拒绝，而不是"not found"
    const ghost = await readFileTool.execute({ path: "config/.env.local" }, ctx());
    expect(ghost.isError).toBe(true);
    expect(ghost.content).toMatch(/credential/i);
  });

  it("模板 .env.example 照常可读", async () => {
    await writeFileTool.execute(
      { path: ".env.example", content: "ANTHROPIC_API_KEY=" },
      ctx("tu_seed_env_example"),
    );
    const r = await readFileTool.execute({ path: ".env.example" }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toBe("ANTHROPIC_API_KEY=");
  });
});

describe("bash 子进程环境剥密钥", () => {
  it("sanitizeChildEnv 分类：凭据名剥除、端点与常规变量保留", () => {
    const input: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "b",
      AGENT_VERIFIER_API_KEY: "c",
      AGENT_UI_ACCESS_TOKEN: "d",
      GITHUB_TOKEN: "e",
      NPM_TOKEN: "f",
      AWS_SECRET_ACCESS_KEY: "g",
      AWS_ACCESS_KEY_ID: "h",
      DB_PASSWORD: "i",
      // 保留组：端点地址不是凭据；TOKENIZERS_* 是"TOKEN 子串误伤"的回归哨兵
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      TOKENIZERS_PARALLELISM: "false",
      PATH: "/usr/bin",
      HOME: "/home/u",
    };
    const out = sanitizeChildEnv(input);
    for (const gone of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AGENT_VERIFIER_API_KEY", "AGENT_UI_ACCESS_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "DB_PASSWORD"]) {
      expect(out, gone).not.toHaveProperty(gone);
    }
    for (const kept of ["ANTHROPIC_BASE_URL", "TOKENIZERS_PARALLELISM", "PATH", "HOME"]) {
      expect(out, kept).toHaveProperty(kept);
    }
  });

  it("AGENT_BASH_KEEP_ENV 显式放行个别变量（精确名字匹配）", () => {
    const out = sanitizeChildEnv({
      AGENT_BASH_KEEP_ENV: "GITHUB_TOKEN",
      GITHUB_TOKEN: "keepme",
      NPM_TOKEN: "gone",
    });
    expect(out.GITHUB_TOKEN).toBe("keepme");
    expect(out).not.toHaveProperty("NPM_TOKEN");
  });

  // 真跑 shell 的行为锁：纯函数测试盖不住调用点——把 execute 里那行 env 删掉，
  // exec 会隐式继承完整 process.env，只有这条测试会红（cmd.exe 环境无 $VAR 语义，跳过）
  it.runIf(!SHELL_DESC.includes("cmd.exe"))(
    "运行期设置的密钥环境变量在 bash 子进程里不可见",
    async () => {
      process.env.HARNESS_LEAK_TEST_API_KEY = "leak-canary";
      try {
        const r = await bashTool.execute({ command: 'echo "[$HARNESS_LEAK_TEST_API_KEY]"' }, ctx());
        expect(r.isError).toBeUndefined();
        expect(r.content).toContain("[]");
        expect(r.content).not.toContain("leak-canary");
      } finally {
        delete process.env.HARNESS_LEAK_TEST_API_KEY;
      }
    },
  );
});

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ToolExecutor, ToolRegistry } from "../src/tools/registry.js";
import { credentialLikeName, resolveInWorkdir, resolveReadable, truncate } from "../src/tools/fs-util.js";
import { readFileTool } from "../src/tools/read-file.js";
import { writeFileTool } from "../src/tools/write-file.js";
import { SHELL_DESC, bashTool, prependBashPath, sanitizeChildEnv } from "../src/tools/bash.js";
import { makeTool, toolUseBlock } from "./helpers.js";

let workdir: string;
const ctx = (toolUseId = "tu_test") => ({
  workdir,
  toolUseId,
  signal: new AbortController().signal,
});

async function tryDirectoryLink(target: string, link: string): Promise<boolean> {
  try {
    // Windows junction 不要求 Developer Mode；POSIX 的 dir symlink 走同一测试语义。
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(code ?? "")) return false;
    throw error;
  }
}

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
    expect(resolveInWorkdir(workdir, "..safe.txt")).toBe(path.resolve(workdir, "..safe.txt"));
  });

  it("不存在的合法写目标按最近存在父目录校验并放行", () => {
    expect(resolveInWorkdir(workdir, "brand-new/deep/file.txt")).toBe(
      path.resolve(workdir, "brand-new/deep/file.txt"),
    );
  });

  it("拒绝经 symlink/junction 越界，包含尚不存在的深层写目标", async (testContext) => {
    const outside = await mkdtemp(path.join(tmpdir(), "harness-outside-"));
    const link = path.join(workdir, "escape-link");
    await writeFile(path.join(outside, "secret.txt"), "outside", "utf8");
    if (!(await tryDirectoryLink(outside, link))) {
      await rm(outside, { recursive: true, force: true });
      testContext.skip("This host cannot create a directory symlink or junction");
      return;
    }

    try {
      expect(() => resolveInWorkdir(workdir, "escape-link/secret.txt")).toThrow(/escapes/);
      expect(() => resolveInWorkdir(workdir, "escape-link/missing/deep/pwned.txt")).toThrow(/escapes/);
      expect(() => resolveReadable(workdir, undefined, "escape-link/secret.txt")).toThrow(/escapes/);
      await expect(readFileTool.execute({ path: "escape-link/secret.txt" }, ctx())).rejects.toThrow(/escapes/);
      await expect(
        writeFileTool.execute({ path: "escape-link/missing/deep/pwned.txt", content: "pwned" }, ctx()),
      ).rejects.toThrow(/escapes/);
      await expect(readFile(path.join(outside, "missing/deep/pwned.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(link, { force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("允许 symlink/junction 指向同一工作区内的目录", async (testContext) => {
    const realDir = path.join(workdir, "inside-real");
    const link = path.join(workdir, "inside-link");
    await mkdir(realDir, { recursive: true });
    if (!(await tryDirectoryLink(realDir, link))) {
      testContext.skip("This host cannot create a directory symlink or junction");
      return;
    }

    try {
      const w = await writeFileTool.execute({ path: "inside-link/ok.txt", content: "ok" }, ctx());
      expect(w.isError).toBeUndefined();
      expect(await readFile(path.join(realDir, "ok.txt"), "utf8")).toBe("ok");
      const r = await readFileTool.execute({ path: "inside-link/ok.txt" }, ctx());
      expect(r.content).toBe("ok");
    } finally {
      await rm(link, { force: true });
    }
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

  it("额外只读根也拒绝经 symlink/junction 读取圈外文件", async (testContext) => {
    const outside = await mkdtemp(path.join(tmpdir(), "harness-readroot-outside-"));
    const link = path.join(readRoot, "escape-link");
    await writeFile(path.join(outside, "secret.txt"), "outside", "utf8");
    if (!(await tryDirectoryLink(outside, link))) {
      await rm(outside, { recursive: true, force: true });
      testContext.skip("This host cannot create a directory symlink or junction");
      return;
    }

    try {
      const escaped = path.join(link, "secret.txt");
      expect(() => resolveReadable(workdir, [readRoot], escaped)).toThrow(/escapes/);
      await expect(
        readFileTool.execute({ path: escaped }, { ...ctx(), readRoots: [readRoot] }),
      ).rejects.toThrow(/escapes/);
    } finally {
      await rm(link, { force: true });
      await rm(outside, { recursive: true, force: true });
    }
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

describe("ToolExecutor 中止语义", () => {
  /**
   * 真机现场（2026-09-03，Web 宿主 + deepseek-v4-flash）：一轮里 5 个串行 write_file，
   * 人在第一张审批卡上按停止 → 宿主 deny 掉挂起的那一个，可第二个块照样走到审批门，
   * 再挂一张卡，run 停在 running/pendingApprovals=1。修前这条测试里 approve 会被叫两次。
   */
  it("中止后串行的后续块不再请求审批，每个 tool_use 仍各有一条 tool_result", async () => {
    const reg = new ToolRegistry();
    const ran: string[] = [];
    for (const name of ["first", "second", "third"]) {
      reg.register(makeTool({
        name, permission: "ask", parallelSafe: false,
        execute: async () => { ran.push(name); return { content: `${name} ok` }; },
      }));
    }
    const ac = new AbortController();
    const approvals: string[] = [];
    const executor = new ToolExecutor(reg, workdir);
    const results = await executor.executeAll(
      [toolUseBlock("tu_1", "first", {}), toolUseBlock("tu_2", "second", {}), toolUseBlock("tu_3", "third", {})],
      ac.signal,
      async (block) => {
        approvals.push(block.name);
        // 宿主的停止路径：先立中止位，再把当时挂起的审批 deny 掉
        ac.abort();
        return { decision: "deny", reason: "委托方已停止这次运行" };
      },
    );
    expect(approvals, "已中止的运行不该再向人要一次授权").toEqual(["first"]);
    expect(ran).toEqual([]);
    // API 硬约束：每个 tool_use 有且仅有一个 tool_result，顺序不变
    expect(results.map((r) => r.tool_use_id)).toEqual(["tu_1", "tu_2", "tu_3"]);
    expect(results.every((r) => r.is_error)).toBe(true);
    expect(String(results[0]!.content)).toMatch(/denied permission/);
    expect(String(results[1]!.content)).toMatch(/aborted before execution/);
    expect(String(results[2]!.content)).toMatch(/aborted before execution/);
  });

  it("未中止时审批门照常逐块询问（对照：修法没有把审批门整个短路）", async () => {
    const reg = new ToolRegistry();
    reg.register(makeTool({ name: "a", permission: "ask", parallelSafe: false }));
    reg.register(makeTool({ name: "b", permission: "ask", parallelSafe: false }));
    const approvals: string[] = [];
    const executor = new ToolExecutor(reg, workdir);
    const results = await executor.executeAll(
      [toolUseBlock("tu_a", "a", {}), toolUseBlock("tu_b", "b", {})],
      new AbortController().signal,
      async (block) => { approvals.push(block.name); return { decision: "allow" }; },
    );
    expect(approvals).toEqual(["a", "b"]);
    expect(results.map((r) => r.content)).toEqual(["a ok", "b ok"]);
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

describe("bash 子进程 PATH 前置（Git coreutils）不得丢掉父进程 PATH", () => {
  const D = path.delimiter;
  const git = `D:${path.sep}Git${path.sep}usr${path.sep}bin`;

  it("Windows 形状的键名 Path：写回同一个键，前置 Git 目录，原条目全保留，且不并存第二个 PATH 键", () => {
    const out = prependBashPath({ Path: `C:${D}C:\\nodejs`, HOME: "h" }, [git]);
    const pathKeys = Object.keys(out).filter((k) => k.toLowerCase() === "path");
    // 1653b7b 的形态是 Path + PATH 两键并存，spawn 时只剩 Git usr/bin
    expect(pathKeys).toEqual(["Path"]);
    expect(out.Path).toBe(`${git}${D}C:${D}C:\\nodejs`);
    expect(out.HOME).toBe("h");
  });

  it("POSIX 形状的键名 PATH：同样前置且保留", () => {
    const out = prependBashPath({ PATH: "/usr/local/bin" }, [git]);
    expect(Object.keys(out).filter((k) => k.toLowerCase() === "path")).toEqual(["PATH"]);
    expect(out.PATH).toBe(`${git}${D}/usr/local/bin`);
  });

  it("父进程完全没有 PATH：新建 PATH 只含 Git 目录，不带悬空分隔符", () => {
    const out = prependBashPath({ HOME: "h" }, [git]);
    expect(out.PATH).toBe(git);
  });

  it("无缺失目录（非 Windows / Git 已在 PATH）：env 原样返回", () => {
    const env = { Path: "C:" };
    expect(prependBashPath(env, [])).toBe(env);
  });

  // 行为锁：跑 vitest 的 node 一定在父进程 PATH 上，子 shell 里也必须找得到。
  // 回归形态（v1.3.0）：Windows 下 `command -v node` → "command not found"，
  // 模型只能靠 perl/awk 逃生（EVAL-01 基线 transcript 实录）。cmd.exe 无 command -v，跳过。
  // 诚实说明：vitest worker 里 process.env 的键已被规范成大写 PATH（实测），所以这条
  // 在 vitest 下抓不到 "Path/PATH 并存" 这一具体回归——真宿主（PowerShell → npm → tsx）
  // 才是 Path。上面那条显式喂 `Path` 键的纯函数测试才是这个回归的守门人；本条守的是
  // "子进程完全丢掉父 PATH" 这一更粗的形态。
  it.runIf(!SHELL_DESC.includes("cmd.exe"))(
    "bash 子进程能看到父进程 PATH 上的 node",
    async () => {
      const r = await bashTool.execute({ command: "command -v node" }, ctx());
      expect(r.isError, r.content).toBeUndefined();
      expect(r.content).toMatch(/node/);
    },
  );
});

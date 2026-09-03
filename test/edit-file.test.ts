/**
 * A1 — `edit_file`（str_replace 局部编辑）的行为锁。
 *
 * 这个工具的危险不在"改不动"，而在"静默改错地方"。所以断言按危害排序：
 * ① **唯一性由宿主执行**：0 命中 / 多命中都必须是 `is_error`，绝不"改第一个"；
 * ② **字节保真**：CRLF、无结尾换行、BOM 一律原样——本仓被字节级判据咬过多次；
 * ③ **圈禁与 fail-closed**：越出工作目录、凭据文件名、文件不存在；
 * ④ **只读角色不在场**：verifier / planner 的工具面上根本没有它（P6 硬执行点），
 *    这一条是**行为断言**（跑一次真实 runVerifier / runPlanner 看请求里的工具面），
 *    不是对 `withoutEditFile` 这个纯函数的单测——纯函数全绿覆不住调用点；
 * ⑤ **崩溃重入**：SAFE-06 prepared → committed，重放不得二次施加。
 */
import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import {
  EDIT_FILE_TOOL_NAME,
  MAX_DIFF_CHARS,
  MAX_DIFF_HUNKS,
  editFileTool,
  withoutEditFile,
} from "../src/tools/edit-file.js";
import { readFileTool } from "../src/tools/read-file.js";
import { writeFileTool } from "../src/tools/write-file.js";
import { ToolExecutor, ToolRegistry, ToolTxCrashError } from "../src/tools/registry.js";
import {
  SIDE_EFFECT_TOOL_NAMES,
  retryPolicyForTool,
  toolIdempotencyKey,
  type DurableToolTx,
  type ToolTxController,
} from "../src/tool-tx.js";
import { runVerifier } from "../src/verifier.js";
import { runPlanner, runStructuredPlanner } from "../src/planner.js";
import type { Tool, ToolContext, TurnEvent } from "../src/types.js";
import { FakeModelClient, fakeMessage, textBlock } from "./helpers.js";

// ---------------------------------------------------------------- 夹具

/** 每个用例独占一个 workdir：越界断言指向本用例专属的父目录，不共享 /tmp */
async function sandbox(): Promise<{ root: string; workdir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "harness-editfile-"));
  const workdir = path.join(root, "work");
  await mkdir(workdir, { recursive: true });
  return { root, workdir };
}

const ctx = (workdir: string, extra: Partial<ToolContext> = {}): ToolContext => ({
  workdir,
  toolUseId: "tu_edit",
  signal: new AbortController().signal,
  ...extra,
});

/** 种子文件一律用 Buffer 写：字节保真的用例不能被写入端归一化掉 */
async function seed(workdir: string, rel: string, bytes: string): Promise<void> {
  const abs = path.join(workdir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, Buffer.from(bytes, "utf8"));
}

async function rawBytes(workdir: string, rel: string): Promise<string> {
  return (await readFile(path.join(workdir, rel))).toString("utf8");
}

/** 一次 edit_file 调用（直接进 execute，不过审批门——门本身另有锁） */
async function edit(
  workdir: string,
  input: Record<string, unknown>,
): Promise<{ content: string; isError?: boolean }> {
  const r = await editFileTool.execute(input, ctx(workdir));
  return { content: String(r.content), ...(r.isError ? { isError: true } : {}) };
}

async function withSandbox(fn: (workdir: string, root: string) => Promise<void>): Promise<void> {
  const { root, workdir } = await sandbox();
  try {
    await fn(workdir, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- ① 唯一性

describe("edit_file · 唯一性由宿主执行，不靠模型自觉", () => {
  it("恰好 1 处命中 → 只改那一处，其余字节一个不动", async () => {
    await withSandbox(async (workdir) => {
      await seed(workdir, "src/app.ts", "const a = 1;\nconst target = 2;\nconst b = 3;\n");
      const r = await edit(workdir, {
        path: "src/app.ts",
        old_string: "const target = 2;",
        new_string: "const target = 42;",
      });
      expect(r.isError).toBeUndefined();
      expect(await rawBytes(workdir, "src/app.ts")).toBe(
        "const a = 1;\nconst target = 42;\nconst b = 3;\n",
      );
      expect(r.content).toContain("1 replacement(s)");
    });
  });

  it("0 命中 → is_error，且给的是「扩上下文重抄」这个动作而不是评价", async () => {
    await withSandbox(async (workdir) => {
      await seed(workdir, "a.txt", "hello world\n");
      const r = await edit(workdir, { path: "a.txt", old_string: "goodbye", new_string: "x" });
      expect(r.isError).toBe(true);
      expect(r.content).toContain("0 matches");
      // 可操作性：告诉模型下一步干什么（P5 写动作不写评价）
      expect(r.content).toContain("widen");
      expect(r.content).toContain("Re-read the file");
      // 未命中一律不落盘
      expect(await rawBytes(workdir, "a.txt")).toBe("hello world\n");
    });
  });

  /**
   * 这是**判定性**的一条：一个"多命中就改第一个"的实现会在这里当场变红。
   * 断言同时钉住报错的可操作性——次数与行号，模型才知道要往哪边扩上下文。
   */
  it("多命中且未给 replace_all → is_error（含命中次数与行号），文件一个字节不动", async () => {
    await withSandbox(async (workdir) => {
      const before = "x = 1;\ny = 0;\nx = 1;\nz = 9;\nx = 1;\n";
      await seed(workdir, "m.txt", before);
      const r = await edit(workdir, { path: "m.txt", old_string: "x = 1;", new_string: "x = 2;" });
      expect(r.isError).toBe(true);
      expect(r.content).toContain("3 matches");
      expect(r.content).toContain("lines 1, 3, 5");
      expect(r.content).toContain("replace_all");
      expect(await rawBytes(workdir, "m.txt"), "拒绝就是拒绝，不许偷偷改第一个").toBe(before);
    });
  });

  it("多命中 + replace_all:true → 全部替换，回执报准确条数", async () => {
    await withSandbox(async (workdir) => {
      await seed(workdir, "m.txt", "x = 1;\ny = 0;\nx = 1;\nz = 9;\nx = 1;\n");
      const r = await edit(workdir, {
        path: "m.txt",
        old_string: "x = 1;",
        new_string: "x = 2;",
        replace_all: true,
      });
      expect(r.isError).toBeUndefined();
      expect(r.content).toContain("3 replacement(s)");
      expect(await rawBytes(workdir, "m.txt")).toBe("x = 2;\ny = 0;\nx = 2;\nz = 9;\nx = 2;\n");
    });
  });

  it("唯一命中时带不带 replace_all 结果相同——这个开关只放宽唯一性，不改语义", async () => {
    await withSandbox(async (workdir) => {
      await seed(workdir, "u1.txt", "only here\n");
      await seed(workdir, "u2.txt", "only here\n");
      await edit(workdir, { path: "u1.txt", old_string: "only", new_string: "just" });
      await edit(workdir, { path: "u2.txt", old_string: "only", new_string: "just", replace_all: true });
      expect(await rawBytes(workdir, "u1.txt")).toBe(await rawBytes(workdir, "u2.txt"));
    });
  });

  it("replace_all 不是布尔就拒——schema 声明过 ≠ 端点执行过（P6）", async () => {
    await withSandbox(async (workdir) => {
      await seed(workdir, "m.txt", "x\nx\n");
      const r = await edit(workdir, {
        path: "m.txt",
        old_string: "x",
        new_string: "y",
        replace_all: "true",
      });
      expect(r.isError).toBe(true);
      expect(r.content).toContain("replace_all must be a boolean");
      expect(await rawBytes(workdir, "m.txt")).toBe("x\nx\n");
    });
  });

  it("空 old_string 被拒（空匹配没有位置）；old===new 被拒（这次编辑什么都不改）", async () => {
    await withSandbox(async (workdir) => {
      await seed(workdir, "a.txt", "abc\n");
      const empty = await edit(workdir, { path: "a.txt", old_string: "", new_string: "z" });
      expect(empty.isError).toBe(true);
      expect(empty.content).toContain("must not be empty");
      const same = await edit(workdir, { path: "a.txt", old_string: "abc", new_string: "abc" });
      expect(same.isError).toBe(true);
      expect(same.content).toContain("identical");
      expect(await rawBytes(workdir, "a.txt")).toBe("abc\n");
    });
  });

  it("new_string 可以为空 = 删除那一段（不是非法入参）", async () => {
    await withSandbox(async (workdir) => {
      await seed(workdir, "a.txt", "keep\nDROP ME\nkeep\n");
      const r = await edit(workdir, { path: "a.txt", old_string: "DROP ME\n", new_string: "" });
      expect(r.isError).toBeUndefined();
      expect(await rawBytes(workdir, "a.txt")).toBe("keep\nkeep\n");
    });
  });

  it("缺参 / 类型不对 → is_error 而不是抛异常", async () => {
    await withSandbox(async (workdir) => {
      for (const bad of [{}, { path: "a.txt" }, { path: 1, old_string: "a", new_string: "b" }]) {
        const r = await edit(workdir, bad as Record<string, unknown>);
        expect(r.isError, JSON.stringify(bad)).toBe(true);
        expect(r.content).toContain("Invalid input");
      }
    });
  });
});

// ---------------------------------------------------------------- ② 字节保真

describe("edit_file · 字节保真是硬约束", () => {
  it("CRLF 文件保持 CRLF——不做行尾归一", async () => {
    await withSandbox(async (workdir) => {
      await seed(workdir, "crlf.txt", "line one\r\nconst v = 1;\r\nline three\r\n");
      const r = await edit(workdir, {
        path: "crlf.txt",
        old_string: "const v = 1;",
        new_string: "const v = 2;",
      });
      expect(r.isError).toBeUndefined();
      const after = await rawBytes(workdir, "crlf.txt");
      expect(after).toBe("line one\r\nconst v = 2;\r\nline three\r\n");
      expect(after.includes("\n\n"), "不许把 CRLF 折成 LF").toBe(false);
      expect((after.match(/\r\n/g) ?? []).length).toBe(3);
    });
  });

  it("CRLF 文件 + 裸 LF 的 old_string → 0 命中，并点名 CRLF（否则模型反复递交同一段）", async () => {
    await withSandbox(async (workdir) => {
      await seed(workdir, "crlf.txt", "alpha\r\nbeta\r\n");
      const r = await edit(workdir, {
        path: "crlf.txt",
        old_string: "alpha\nbeta",
        new_string: "alpha\ngamma",
      });
      expect(r.isError).toBe(true);
      expect(r.content).toContain("CRLF");
      expect(await rawBytes(workdir, "crlf.txt")).toBe("alpha\r\nbeta\r\n");
    });
  });

  it("old_string 可以跨行原样带 CRLF——照抄就能命中", async () => {
    await withSandbox(async (workdir) => {
      await seed(workdir, "crlf.txt", "alpha\r\nbeta\r\ngamma\r\n");
      const r = await edit(workdir, {
        path: "crlf.txt",
        old_string: "alpha\r\nbeta",
        new_string: "alpha\r\nBETA",
      });
      expect(r.isError).toBeUndefined();
      expect(await rawBytes(workdir, "crlf.txt")).toBe("alpha\r\nBETA\r\ngamma\r\n");
    });
  });

  it("无结尾换行的文件仍然无结尾换行——不补 \\n", async () => {
    await withSandbox(async (workdir) => {
      await seed(workdir, "nonl.txt", "first\nlast line no newline");
      const r = await edit(workdir, {
        path: "nonl.txt",
        old_string: "last line no newline",
        new_string: "edited tail",
      });
      expect(r.isError).toBeUndefined();
      const after = await rawBytes(workdir, "nonl.txt");
      expect(after).toBe("first\nedited tail");
      expect(after.endsWith("\n"), "结尾换行是内容不是格式，不许顺手补").toBe(false);
    });
  });

  it("BOM 原样留着（PowerShell 写出来的文件不该被这个工具悄悄修好）", async () => {
    await withSandbox(async (workdir) => {
      await seed(workdir, "bom.json", '\ufeff{"version": "1.0.0"}\n');
      const r = await edit(workdir, {
        path: "bom.json",
        old_string: '"1.0.0"',
        new_string: '"1.1.0"',
      });
      expect(r.isError).toBeUndefined();
      const raw = await readFile(path.join(workdir, "bom.json"));
      expect(raw[0], "BOM 首字节 EF").toBe(0xef);
      expect(raw.toString("utf8")).toBe('\ufeff{"version": "1.1.0"}\n');
    });
  });

  it("行尾空白与制表缩进不被 trim", async () => {
    await withSandbox(async (workdir) => {
      await seed(workdir, "ws.txt", "keep trailing   \n\tif (x) {\n\t\treturn 1;\n\t}\n");
      const r = await edit(workdir, {
        path: "ws.txt",
        old_string: "\t\treturn 1;",
        new_string: "\t\treturn 2;",
      });
      expect(r.isError).toBeUndefined();
      expect(await rawBytes(workdir, "ws.txt")).toBe(
        "keep trailing   \n\tif (x) {\n\t\treturn 2;\n\t}\n",
      );
    });
  });

  it("回执报的字节增量是 UTF-8 字节数，不是字符数（多字节内容也要说实话）", async () => {
    await withSandbox(async (workdir) => {
      await seed(workdir, "cn.txt", "标题：旧\n");
      const r = await edit(workdir, { path: "cn.txt", old_string: "旧", new_string: "新的" });
      expect(r.isError).toBeUndefined();
      // 「旧」3 字节 → 「新的」6 字节
      expect(r.content).toContain("+3 bytes");
    });
  });
});

// ---------------------------------------------------------------- ③ 圈禁 / fail-closed

describe("edit_file · 圈禁与 fail-closed", () => {
  it("越出工作目录 → 抛（与 write_file 同一条契约），executor 兜成 is_error 且不落盘", async () => {
    await withSandbox(async (workdir, root) => {
      await writeFile(path.join(root, "outside.txt"), "outside secret\n", "utf8");
      await expect(
        editFileTool.execute(
          { path: "../outside.txt", old_string: "outside", new_string: "pwned" },
          ctx(workdir),
        ),
      ).rejects.toThrow(/escapes/);

      // 经 executor 走一遍：模型看到的是 is_error，不是进程崩
      const reg = new ToolRegistry();
      reg.register(editFileTool);
      const exec = new ToolExecutor(reg, workdir);
      const [r] = await exec.executeAll(
        [
          {
            type: "tool_use",
            id: "tu_escape",
            name: EDIT_FILE_TOOL_NAME,
            input: { path: "../outside.txt", old_string: "outside", new_string: "pwned" },
          } as Anthropic.ToolUseBlock,
        ],
        new AbortController().signal,
        async () => ({ decision: "allow" }),
      );
      expect(r!.is_error).toBe(true);
      expect(await readFile(path.join(root, "outside.txt"), "utf8")).toBe("outside secret\n");
    });
  });

  it("readRoots 只放宽读，不放宽写——只读根里的文件仍然编辑不了", async () => {
    await withSandbox(async (workdir, root) => {
      const readRoot = path.join(root, "readonly");
      await mkdir(readRoot, { recursive: true });
      const target = path.join(readRoot, "lib.txt");
      await writeFile(target, "read root marker\n", "utf8");
      await expect(
        editFileTool.execute(
          { path: target, old_string: "marker", new_string: "tampered" },
          ctx(workdir, { readRoots: [readRoot] }),
        ),
      ).rejects.toThrow(/escapes/);
      expect(await readFile(target, "utf8")).toBe("read root marker\n");
    });
  });

  it("凭据式文件名 fail-closed——回执带 diff，改一次 .env 就等于把密钥写进正史", async () => {
    await withSandbox(async (workdir) => {
      for (const rel of [".env", ".env.local", ".npmrc", ".netrc", "id_rsa", "server.pem"]) {
        await seed(workdir, rel, "TOKEN=abcdef\n");
        const r = await edit(workdir, { path: rel, old_string: "abcdef", new_string: "zzzzzz" });
        expect(r.isError, rel).toBe(true);
        expect(r.content).toContain("credential");
        expect(await rawBytes(workdir, rel), `${rel} 必须一个字节没动`).toBe("TOKEN=abcdef\n");
      }
    });
  });

  it("凭据检查排在读盘之前——连文件内容都不该被读进上下文", async () => {
    await withSandbox(async (workdir) => {
      // 文件根本不存在：若先读盘就会报 ENOENT；先查名字则报 credential
      const r = await edit(workdir, { path: ".env", old_string: "a", new_string: "b" });
      expect(r.isError).toBe(true);
      expect(r.content).toContain("credential");
      expect(r.content).not.toContain("File not found");
    });
  });

  it("文件不存在 → is_error 并指路 write_file（edit_file 不建文件）", async () => {
    await withSandbox(async (workdir) => {
      const r = await edit(workdir, { path: "nope.txt", old_string: "a", new_string: "b" });
      expect(r.isError).toBe(true);
      expect(r.content).toContain("File not found");
      expect(r.content).toContain("write_file");
    });
  });

  it("审批档位与 write_file 同级：ask + maxScope once（不许被扩成常驻授权）", () => {
    expect(editFileTool.permission).toBe("ask");
    expect(editFileTool.permission).toBe(writeFileTool.permission);
    expect(editFileTool.approvalPolicy).toEqual({ maxScope: "once" });
    expect(editFileTool.parallelSafe).toBe(false);
  });

  it("入参契约：三个必填 + replace_all 可选布尔", () => {
    const schema = editFileTool.inputSchema as {
      required: string[];
      properties: Record<string, { type: string }>;
    };
    expect(schema.required).toEqual(["path", "old_string", "new_string"]);
    expect(schema.properties.replace_all!.type).toBe("boolean");
    expect(Object.keys(schema.properties).sort()).toEqual([
      "new_string",
      "old_string",
      "path",
      "replace_all",
    ]);
  });

  it("描述把「何时用它、何时用 write_file」和字节纪律都写死", () => {
    const d = editFileTool.description;
    expect(d).toContain("PREFER THIS OVER write_file");
    expect(d).toContain("unique");
    expect(d).toContain("byte for byte");
    // 不做归一化这件事必须写给模型看——否则它会以为可以随手改缩进
    expect(d).toContain("Nothing is normalized");
    expect(d).toContain("write_file only to create");
  });
});

// ---------------------------------------------------------------- 回填 diff 有界

describe("edit_file · 回填 diff 必须有界且诚实", () => {
  it("成功回执带 unified diff 头与增删行", async () => {
    await withSandbox(async (workdir) => {
      await seed(workdir, "d.txt", "a\nb\nTARGET\nd\ne\n");
      const r = await edit(workdir, { path: "d.txt", old_string: "TARGET", new_string: "HIT" });
      expect(r.content).toContain("--- a/d.txt");
      expect(r.content).toContain("+++ b/d.txt");
      expect(r.content).toContain("@@");
      expect(r.content).toContain("-TARGET");
      expect(r.content).toContain("+HIT");
      // 上下文行带前导空格，且不该把整个文件都抄回来
      expect(r.content).toContain(" b");
    });
  });

  it(`hunk 数超过 ${MAX_DIFF_HUNKS} 时截断，并把"还有几处没显示"说出来`, async () => {
    await withSandbox(async (workdir) => {
      const n = MAX_DIFF_HUNKS + 3;
      await seed(workdir, "many.txt", Array.from({ length: n }, (_, i) => `pad${i}\nTOK\n`).join(""));
      const r = await edit(workdir, {
        path: "many.txt",
        old_string: "TOK",
        new_string: "TAK",
        replace_all: true,
      });
      expect(r.isError).toBeUndefined();
      expect(r.content).toContain(`${n} replacement(s)`);
      // 静默截断 = 模型把半份结果当全量（findings：真话必须能转达）
      expect(r.content).toContain(`${n - MAX_DIFF_HUNKS} more replacement(s) not shown`);
      expect(await rawBytes(workdir, "many.txt")).not.toContain("TOK");
    });
  });

  it(`总字符超过 ${MAX_DIFF_CHARS} 时截断并指路"重读文件"`, async () => {
    await withSandbox(async (workdir) => {
      await seed(workdir, "big.txt", "head\nPAYLOAD\ntail\n");
      const r = await edit(workdir, {
        path: "big.txt",
        old_string: "PAYLOAD",
        new_string: "Z".repeat(MAX_DIFF_CHARS * 2),
      });
      expect(r.isError).toBeUndefined();
      expect(r.content).toContain(`diff truncated at ${MAX_DIFF_CHARS} chars`);
      expect(r.content).toContain("re-read the file");
      // 截断只影响回执，不影响落盘
      expect(await rawBytes(workdir, "big.txt")).toBe(
        `head\n${"Z".repeat(MAX_DIFF_CHARS * 2)}\ntail\n`,
      );
    });
  });
});

// ---------------------------------------------------------------- ④ 只读角色不在场

describe("edit_file · 只读角色的工具面上根本没有它（P6 硬执行点）", () => {
  const cfg = { systemPrompt: "s", workdir: process.cwd(), tools: [readFileTool, editFileTool] };

  it("verifier：第一轮请求的工具面无 edit_file，但终结工具在", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "ok"}')], "end_turn"),
    ]);
    await runVerifier(cfg, model, { task: "t", executorReport: "r" });
    const names = model.requests[0]!.tools.map((t) => t.name);
    expect(names).not.toContain(EDIT_FILE_TOOL_NAME);
    expect(names).toContain("read_file");
    expect(names, "终结工具要在").toContain("submit_verdict");
  });

  /**
   * 收口续跑段（9.7）是另一个装配点，`withoutAskUser` 当年就在这里漏过一次同构。
   * 构造：核查段一直调工具不下结论 → 撞满预算 → 收口段发起新请求。
   */
  it("verifier 收口续跑段也不给——同一条纪律在第二个装配点上", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock("still investigating")], "end_turn"),
      fakeMessage([textBlock('{"passed": true, "issues": [], "summary": "wrapped up"}')], "end_turn"),
    ]);
    await runVerifier(cfg, model, { task: "t", executorReport: "r", maxTurns: 1 });
    expect(model.requests.length, "收口段确实发起了第二次请求").toBeGreaterThan(1);
    for (const [i, req] of model.requests.entries()) {
      expect(req.tools.map((t) => t.name), `第 ${i + 1} 次请求`).not.toContain(EDIT_FILE_TOOL_NAME);
    }
  });

  it("freeform planner：拆解是只读的，工具面无 edit_file", async () => {
    const model = new FakeModelClient([
      fakeMessage(
        [
          textBlock(
            '{"subtasks": [{"id":"s1","title":"a","description":"做 a","acceptance":[],"dependsOn":[]}]}',
          ),
        ],
        "end_turn",
      ),
    ]);
    await runPlanner(cfg, model, "任务", []);
    const names = model.requests[0]!.tools.map((t) => t.name);
    expect(names).not.toContain(EDIT_FILE_TOOL_NAME);
    expect(names).toContain("submit_plan");
  });

  it("structured planner 同样不给（两条拆解路径都要锁）", async () => {
    const model = new FakeModelClient([
      fakeMessage([textBlock('{"shards": []}')], "end_turn"),
    ]);
    await runStructuredPlanner(cfg, model, "任务", []);
    const names = model.requests[0]!.tools.map((t) => t.name);
    expect(names).not.toContain(EDIT_FILE_TOOL_NAME);
  });

  it("withoutEditFile 只摘它一个；没装时是恒等（不得改变既有工具面）", () => {
    const kept = withoutEditFile([
      { name: "bash" },
      { name: EDIT_FILE_TOOL_NAME },
      { name: "read_file" },
    ]);
    expect(kept.map((t) => t.name)).toEqual(["bash", "read_file"]);
    const untouched = [{ name: "bash" }, { name: "read_file" }];
    expect(withoutEditFile(untouched)).toEqual(untouched);
  });
});

// ---------------------------------------------------------------- ⑤ 崩溃重入

function block(id: string, name: string, input: unknown): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input } as Anthropic.ToolUseBlock;
}

function memoryController(
  runId: string,
  opts: { crashOnce?: boolean } = {},
): { ctrl: ToolTxController; store: Map<string, DurableToolTx>; events: TurnEvent[] } {
  const store = new Map<string, DurableToolTx>();
  const events: TurnEvent[] = [];
  let crashed = false;
  const ctrl: ToolTxController = {
    runId,
    get: (key) => store.get(key),
    notify: (_phase, tx) => {
      store.set(tx.idempotencyKey, { ...tx });
    },
    ...(opts.crashOnce
      ? {
          injectCrashAfterPrepared: () => {
            if (crashed) return false;
            crashed = true;
            return true;
          },
        }
      : {}),
  };
  return { ctrl, store, events };
}

describe("edit_file · SAFE-06 事务与崩溃重入", () => {
  it("进副作用集合，重试策略是 idempotent_retry", () => {
    expect(SIDE_EFFECT_TOOL_NAMES.has(EDIT_FILE_TOOL_NAME)).toBe(true);
    expect(retryPolicyForTool(EDIT_FILE_TOOL_NAME)).toBe("idempotent_retry");
  });

  it("prepared 后崩溃 → 没写盘；重入写一次；第三次同 key 跳过", async () => {
    await withSandbox(async (workdir) => {
      await seed(workdir, "tx.txt", "value = OLD\n");
      let executions = 0;
      const counting: Tool = {
        ...editFileTool,
        async execute(input, c) {
          executions += 1;
          return editFileTool.execute(input, c);
        },
      };
      const reg = new ToolRegistry();
      reg.register(counting);
      const exec = new ToolExecutor(reg, workdir);
      const { ctrl, store } = memoryController("run-edit", { crashOnce: true });
      const events: TurnEvent[] = [];
      exec.setToolTx(ctrl, async (e) => {
        events.push(e);
      });

      const b = block("tu_edit1", EDIT_FILE_TOOL_NAME, {
        path: "tx.txt",
        old_string: "OLD",
        new_string: "NEW",
      });
      const allow = async () => ({ decision: "allow" as const });

      await expect(exec.executeAll([b], new AbortController().signal, allow)).rejects.toBeInstanceOf(
        ToolTxCrashError,
      );
      const key = toolIdempotencyKey("run-edit", "tu_edit1");
      expect(store.get(key)?.status).toBe("prepared");
      expect(executions, "prepared 后崩溃不该已经改盘").toBe(0);
      expect(await rawBytes(workdir, "tx.txt")).toBe("value = OLD\n");
      expect(events.some((e) => e.type === "tool_prepared")).toBe(true);
      expect(events.some((e) => e.type === "tool_committed")).toBe(false);

      // 重入：崩溃注入已耗尽 → 真的执行并 commit
      const events2: TurnEvent[] = [];
      exec.setToolTx(ctrl, async (e) => {
        events2.push(e);
      });
      const [r2] = await exec.executeAll([b], new AbortController().signal, allow);
      expect(r2!.is_error).toBeFalsy();
      expect(executions).toBe(1);
      expect(store.get(key)?.status).toBe("committed");
      expect(await rawBytes(workdir, "tx.txt")).toBe("value = NEW\n");
      expect(
        events2.some((e) => e.type === "tool_committed" && !(e as { skipped?: boolean }).skipped),
      ).toBe(true);

      // 第三次同 key → committed 直接跳过，execute 不再进
      const events3: TurnEvent[] = [];
      exec.setToolTx(ctrl, async (e) => {
        events3.push(e);
      });
      await exec.executeAll([b], new AbortController().signal, allow);
      expect(executions, "committed 之后不得重跑").toBe(1);
      expect(await rawBytes(workdir, "tx.txt")).toBe("value = NEW\n");
      expect(
        events3.some((e) => e.type === "tool_committed" && (e as { skipped?: boolean }).skipped === true),
      ).toBe(true);
    });
  });

  /**
   * 工具语义的第二层幂等：只有 `old_string` 在第一次写入后整段消失时，
   * 裸重放才会 0 命中报错。`1`→`1 + 1` 这种 new 仍含 old 的子串形态不在此列
   * （那时只能靠 SAFE-06 事务层）——fixture 故意选整段替换。
   */
  it("摘掉事务层直接重放同一次编辑 → 第二次 0 命中报错，绝不二次施加", async () => {
    await withSandbox(async (workdir) => {
      await seed(workdir, "idem.txt", "count = 1\n");
      const input = { path: "idem.txt", old_string: "count = 1", new_string: "count = 2" };
      const first = await edit(workdir, input);
      expect(first.isError).toBeUndefined();
      expect(await rawBytes(workdir, "idem.txt")).toBe("count = 2\n");

      const replay = await edit(workdir, input);
      expect(replay.isError, "重放必须报错而不是又叠一层").toBe(true);
      expect(replay.content).toContain("0 matches");
      // 报错文案要点出"可能是上一次已经生效"，否则模型会去扩上下文找一段不存在的文本
      expect(replay.content).toContain("already applied");
      expect(await rawBytes(workdir, "idem.txt"), "字节与第一次之后完全相同").toBe("count = 2\n");
    });
  });

  it("同 key 异参 fail-closed（改了 payload 不许套用旧事务）", async () => {
    await withSandbox(async (workdir) => {
      await seed(workdir, "tx2.txt", "a = 1\nb = 2\n");
      const reg = new ToolRegistry();
      reg.register(editFileTool);
      const exec = new ToolExecutor(reg, workdir);
      const { ctrl } = memoryController("run-edit2");
      exec.setToolTx(ctrl);
      const allow = async () => ({ decision: "allow" as const });

      await exec.executeAll(
        [block("tu_same", EDIT_FILE_TOOL_NAME, { path: "tx2.txt", old_string: "a = 1", new_string: "a = 9" })],
        new AbortController().signal,
        allow,
      );
      expect(await rawBytes(workdir, "tx2.txt")).toBe("a = 9\nb = 2\n");

      const [r] = await exec.executeAll(
        [block("tu_same", EDIT_FILE_TOOL_NAME, { path: "tx2.txt", old_string: "b = 2", new_string: "b = 9" })],
        new AbortController().signal,
        allow,
      );
      expect(r!.is_error).toBe(true);
      expect(await rawBytes(workdir, "tx2.txt"), "异参那次一个字节都不该落盘").toBe("a = 9\nb = 2\n");
    });
  });
});

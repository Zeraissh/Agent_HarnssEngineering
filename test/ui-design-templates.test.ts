import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  assertDesignTemplateId,
  copyDesignTemplate,
  designTemplatesRootFromRepo,
  listDesignTemplates,
  parseDesignPalette,
  readDesignMd,
} from "../ui/design-templates.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const realTemplates = designTemplatesRootFromRepo(repoRoot);

describe("parseDesignPalette", () => {
  it("抽出色板与字体；忽略反模式段", () => {
    const md = `# DESIGN.md
## 色板
- background: #0f1419
- accent: \`#3b82f6\`
## 字体
- display: Segoe UI
## 反模式（不要做）
- emoji: #ff0000
`;
    const p = parseDesignPalette(md);
    expect(p.colors).toEqual([
      { name: "background", value: "#0f1419" },
      { name: "accent", value: "#3b82f6" },
    ]);
    expect(p.fonts).toEqual([{ name: "display", value: "Segoe UI" }]);
  });
});

describe("listDesignTemplates / copyDesignTemplate", () => {
  it("仓库模板至少含 deck-basic 与 landing-basic", async () => {
    const list = await listDesignTemplates(realTemplates);
    expect(list.map((t) => t.id)).toEqual(
      expect.arrayContaining(["deck-basic", "landing-basic", "social-basic", "pm-spec", "team-okrs"]),
    );
  });

  it("非法 id 拒绝；拷贝进 workdir 默认不写 DESIGN.md", async () => {
    expect(() => assertDesignTemplateId("../x")).toThrow();
    const dir = await mkdtemp(join(tmpdir(), "design-tpl-"));
    try {
      const result = await copyDesignTemplate({
        templatesRoot: realTemplates,
        templateId: "deck-basic",
        destRoot: dir,
      });
      expect(result.entry).toBe("deck-basic/index.html");
      expect(result.files).toBeGreaterThan(0);
      const html = await readFile(join(dir, "deck-basic", "index.html"), "utf8");
      expect(html).toContain("data-slide");
      expect(html).not.toMatch(/后导出|另交付/);
      expect(html).toMatch(/宿主从本页幻灯 HTML 派生/);
      expect(result.designMdWritten).toBe(false);
      expect(await readDesignMd(dir)).toBeNull();

      const withMd = await copyDesignTemplate({
        templatesRoot: realTemplates,
        templateId: "landing-basic",
        destRoot: dir,
        writeDesignMd: true,
      });
      expect(withMd.designMdWritten).toBe(true);
      const md = await readDesignMd(dir);
      expect(md?.text).toContain("#0f1419");

      await expect(
        copyDesignTemplate({
          templatesRoot: realTemplates,
          templateId: "deck-basic",
          destRoot: dir,
        }),
      ).rejects.toThrow(/目标已存在/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("自定义 dest + force 覆盖", async () => {
    const dir = await mkdtemp(join(tmpdir(), "design-tpl2-"));
    const root = join(dir, "templates");
    await mkdir(join(root, "mini"), { recursive: true });
    await writeFile(join(root, "mini", "index.html"), "<h1>v1</h1>", "utf8");
    try {
      await copyDesignTemplate({
        templatesRoot: root,
        templateId: "mini",
        destRoot: dir,
        destName: "site",
      });
      await writeFile(join(root, "mini", "index.html"), "<h1>v2</h1>", "utf8");
      const again = await copyDesignTemplate({
        templatesRoot: root,
        templateId: "mini",
        destRoot: dir,
        destName: "site",
        force: true,
      });
      expect(again.dest).toBe("site");
      expect(await readFile(join(dir, "site", "index.html"), "utf8")).toContain("v2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

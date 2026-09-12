/**
 * design 模板目录：列表 / 拷贝进 run workdir / 解析 DESIGN.md 色板。
 * 纯函数 + fs，供宿主 API 与单测共用；不碰 HTTP。
 */
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveInWorkdir } from "../src/tools/fs-util.js";

/** 模板 id：小写字母开头，字母数字与短横线，最长 64 */
export const DESIGN_TEMPLATE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

export type DesignTemplateInfo = {
  id: string;
  title: string;
  /** 相对 templates/design 的目录名，与 id 相同 */
  dir: string;
};

export type DesignColorChip = { name: string; value: string };

export type DesignPalette = {
  colors: DesignColorChip[];
  fonts: DesignColorChip[];
};

const TITLE_HINTS: Record<string, string> = {
  "deck-basic": "多页幻灯",
  "landing-basic": "单页落地",
  "social-basic": "社媒方图",
  "pm-spec": "产品规格",
  "team-okrs": "团队 OKR",
};

export function assertDesignTemplateId(id: string): string {
  const raw = String(id ?? "").trim();
  if (!DESIGN_TEMPLATE_ID_RE.test(raw)) {
    throw new Error(`非法模板 id：${id}`);
  }
  return raw;
}

/**
 * 从 DESIGN.md 抽出色板与字体行。只认「- name: value」形态；
 * 色值需含 #hex 或 rgb()/hsl()，字体行无色值约束。
 */
export function parseDesignPalette(md: string): DesignPalette {
  const colors: DesignColorChip[] = [];
  const fonts: DesignColorChip[] = [];
  let section: "colors" | "fonts" | null = null;
  const seenColor = new Set<string>();
  const seenFont = new Set<string>();

  for (const line of String(md ?? "").split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      const h = heading[1]!.toLowerCase();
      if (/色板|color|palette/.test(h)) section = "colors";
      else if (/字体|font|type/.test(h)) section = "fonts";
      else section = null;
      continue;
    }
    const m = line.match(/^[-*]\s*([A-Za-z0-9_-]+)\s*[:：]\s*(.+?)\s*$/);
    if (!m) continue;
    const name = m[1]!;
    let value = m[2]!.replace(/^`+|`+$/g, "").trim();
    if (!value) continue;
    if (section === "fonts") {
      if (seenFont.has(name)) continue;
      seenFont.add(name);
      fonts.push({ name, value });
      continue;
    }
    if (section !== "colors") continue;
    const colorMatch = value.match(/^(#[0-9A-Fa-f]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\))$/);
    if (colorMatch) {
      if (seenColor.has(name)) continue;
      seenColor.add(name);
      colors.push({ name, value: colorMatch[1]! });
    }
  }
  return { colors, fonts };
}

export async function listDesignTemplates(templatesRoot: string): Promise<DesignTemplateInfo[]> {
  const root = resolve(templatesRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: DesignTemplateInfo[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!DESIGN_TEMPLATE_ID_RE.test(ent.name)) continue;
    try {
      const st = await stat(join(root, ent.name, "index.html"));
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    out.push({
      id: ent.name,
      dir: ent.name,
      title: TITLE_HINTS[ent.name] ?? ent.name,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export type CopyDesignTemplateResult = {
  /** workdir 相对路径（正斜杠） */
  dest: string;
  /** 入口 HTML 相对路径 */
  entry: string;
  files: number;
  /** 是否顺带写入了根 DESIGN.md */
  designMdWritten: boolean;
};

/**
 * 把 templates/design/<id>/ 拷进 destRoot/<destName>/。
 * destName 缺省 = id；已存在且未 force → 抛错。
 */
export async function copyDesignTemplate(opts: {
  templatesRoot: string;
  templateId: string;
  destRoot: string;
  destName?: string;
  force?: boolean;
  /** 显式要求时才把 DESIGN.md.example 写成 workdir 根 DESIGN.md；默认不写 */
  writeDesignMd?: boolean;
}): Promise<CopyDesignTemplateResult> {
  const id = assertDesignTemplateId(opts.templateId);
  const destName = assertDesignTemplateId(opts.destName ?? id);
  const templatesRoot = resolve(opts.templatesRoot);
  // id 已收窄；源 = templatesRoot/id，禁止越出根
  const src = resolve(templatesRoot, id);
  if (resolve(src) !== resolve(join(templatesRoot, id))) {
    throw new Error("模板路径越界");
  }
  try {
    const st = await stat(join(src, "index.html"));
    if (!st.isFile()) throw new Error("模板缺少 index.html");
  } catch (err) {
    if ((err as Error).message === "模板缺少 index.html") throw err;
    throw new Error(`模板不存在：${id}`);
  }

  const destAbs = resolveInWorkdir(opts.destRoot, destName);
  try {
    await stat(destAbs);
    if (!opts.force) throw new Error(`目标已存在：${destName}（传 force 可覆盖）`);
  } catch (err) {
    if ((err as Error).message?.startsWith("目标已存在")) throw err;
    // ENOENT → 可写
  }

  await mkdir(destAbs, { recursive: true });
  await cp(src, destAbs, { recursive: true, force: Boolean(opts.force) });

  let files = 0;
  async function count(dir: string): Promise<void> {
    const kids = await readdir(dir, { withFileTypes: true });
    for (const k of kids) {
      if (k.isDirectory()) await count(join(dir, k.name));
      else if (k.isFile()) files += 1;
    }
  }
  await count(destAbs);

  let designMdWritten = false;
  if (opts.writeDesignMd) {
    const designMdAbs = resolveInWorkdir(opts.destRoot, "DESIGN.md");
    try {
      await stat(designMdAbs);
    } catch {
      const example = join(templatesRoot, "DESIGN.md.example");
      try {
        const text = await readFile(example, "utf8");
        await writeFile(designMdAbs, text, "utf8");
        designMdWritten = true;
      } catch {
        /* 无示例则跳过 */
      }
    }
  }

  return {
    dest: destName.replace(/\\/g, "/"),
    entry: `${destName}/index.html`.replace(/\\/g, "/"),
    files,
    designMdWritten,
  };
}

/** 读 workdir 根 DESIGN.md；没有则 null。 */
export async function readDesignMd(workdir: string): Promise<{ path: string; text: string } | null> {
  const abs = resolveInWorkdir(workdir, "DESIGN.md");
  try {
    const st = await stat(abs);
    if (!st.isFile()) return null;
    if (st.size > 200_000) throw new Error("DESIGN.md 过大");
    const text = await readFile(abs, "utf8");
    return { path: "DESIGN.md", text };
  } catch (err) {
    if ((err as Error).message === "DESIGN.md 过大") throw err;
    return null;
  }
}

export function designTemplatesRootFromRepo(repoRoot: string): string {
  return join(resolve(repoRoot), "templates", "design");
}

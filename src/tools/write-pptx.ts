/**
 * write_pptx — 把真实 PowerPoint 二进制写进工作目录。
 *
 * write_file 只写 UTF-8，写不了 OOXML。多页幻灯的 .pptx 由宿主从 HTML 派生
 * （src/deck-pptx.ts）；本工具给模型手写简单标题+正文页，或 bash 拷已有二进制。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pptxgen from "pptxgenjs";
import type { Tool } from "../types.js";
import { resolveInWorkdir, WORKDIR_OR_ROOT_PATH } from "./fs-util.js";

type SlideIn = { title: string; body?: string; notes?: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 只认 title / body / notes；多出来的字段失败开放（不拒）。 */
function parseSlides(raw: unknown): SlideIn[] | string {
  if (!Array.isArray(raw) || raw.length < 1) {
    return 'Invalid input: expected {"slides": array} with at least one slide.';
  }
  const out: SlideIn[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isPlainObject(item)) {
      return `Invalid slides[${i}]: expected an object with title.`;
    }
    if (typeof item.title !== "string" || !item.title.trim()) {
      return `Invalid slides[${i}]: title must be a non-empty string.`;
    }
    const slide: SlideIn = { title: item.title.trim() };
    if (item.body !== undefined && item.body !== null) {
      if (typeof item.body !== "string") {
        return `Invalid slides[${i}]: body must be a string.`;
      }
      if (item.body.trim()) slide.body = item.body;
    }
    if (item.notes !== undefined && item.notes !== null) {
      if (typeof item.notes !== "string") {
        return `Invalid slides[${i}]: notes must be a string.`;
      }
      if (item.notes.trim()) slide.notes = item.notes;
    }
    out.push(slide);
  }
  return out;
}

function toNodeBuffer(raw: string | ArrayBuffer | Blob | Uint8Array): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (typeof raw === "string") return Buffer.from(raw, "binary");
  throw new Error("pptxgenjs write() did not return a Node buffer");
}

export const writePptxTool: Tool = {
  name: "write_pptx",
  description:
    "Create or overwrite a real PowerPoint .pptx file inside the working directory or an extra writable root. " +
    "Call this when the user wants a PowerPoint / .pptx deliverable. write_file is UTF-8 only and cannot write OOXML. " +
    "For simple title/body decks. Multi-page HTML slides are converted by the host export. " +
    "Each slide needs a title; body and speaker notes are optional. " +
    "Parent directories are created. Overwrites an existing file at the same path.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: `${WORKDIR_OR_ROOT_PATH} Must end in .pptx.`,
      },
      slides: {
        type: "array",
        minItems: 1,
        description:
          "At least one slide. Each item is { title, body?, notes? }. Extra fields are ignored.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Slide title (required)" },
            body: { type: "string", description: "Optional body text" },
            notes: { type: "string", description: "Optional speaker notes" },
          },
          required: ["title"],
        },
      },
    },
    required: ["path", "slides"],
  },
  permission: "ask",
  parallelSafe: false,
  approvalPolicy: { maxScope: "once" },
  async execute(input, ctx) {
    const { path: p, slides: rawSlides } = input as { path?: unknown; slides?: unknown };
    if (typeof p !== "string" || !p.trim()) {
      return { content: 'Invalid input: expected {"path": string, "slides": [...]}.', isError: true };
    }
    const rel = p.trim();
    if (!rel.toLowerCase().endsWith(".pptx")) {
      return {
        content: `Path must end in .pptx (got "${rel}"). write_pptx writes a PowerPoint file, not text.`,
        isError: true,
      };
    }
    const parsed = parseSlides(rawSlides);
    if (typeof parsed === "string") {
      return { content: parsed, isError: true };
    }

    const resolved = resolveInWorkdir(ctx.workdir, rel, ctx.writeRoots);
    await mkdir(path.dirname(resolved), { recursive: true });
    const revalidated = resolveInWorkdir(ctx.workdir, rel, ctx.writeRoots);

    const Ctor = pptxgen as unknown as {
      new (): {
        layout: string;
        author: string;
        title: string;
        addSlide: () => {
          addText: (text: string, opts: Record<string, unknown>) => void;
          addNotes: (notes: string) => void;
        };
        write: (opts: { outputType: "nodebuffer" }) => Promise<string | ArrayBuffer | Blob | Uint8Array>;
      };
    };
    const pres = new Ctor();
    pres.layout = "LAYOUT_WIDE";
    pres.author = "agent-harness";
    pres.title = parsed[0]!.title;
    for (const slideIn of parsed) {
      const slide = pres.addSlide();
      slide.addText(slideIn.title, {
        x: 0.5,
        y: 0.4,
        w: 12.3,
        h: 1.0,
        fontSize: 28,
        bold: true,
        valign: "top",
      });
      if (slideIn.body) {
        slide.addText(slideIn.body, {
          x: 0.5,
          y: 1.6,
          w: 12.3,
          h: 5.2,
          fontSize: 16,
          valign: "top",
        });
      }
      if (slideIn.notes) slide.addNotes(slideIn.notes);
    }

    const bytes = toNodeBuffer(await pres.write({ outputType: "nodebuffer" }));
    await writeFile(revalidated, bytes);
    const n = parsed.length;
    return { content: `Wrote ${n} slide${n === 1 ? "" : "s"} to ${rel}` };
  },
};

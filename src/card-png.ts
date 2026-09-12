/**
 * 契约绑定的 HTML 方图 → PNG。
 *
 * 只认 [data-card]（或 data-export="png"）。不截整页长图，不另调生图模型。
 * 创作源仍是 HTML；位图由宿主截契约卡。
 */
import { pathToFileURL } from "node:url";

export const CARD_PNG_NO_FRAMES = "NO_FRAMES";
export const CARD_PNG_CAPTURE_UNAVAILABLE = "CAPTURE_UNAVAILABLE";

export const DEFAULT_CARD_SIZE = { width: 1080, height: 1080 };

/** 1×1 透明 PNG，测试注入用，不启动 Chromium。 */
export const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export class CardPngError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CardPngError";
    this.code = code;
  }
}

export function isCardPngError(err: unknown): err is CardPngError {
  return err instanceof CardPngError;
}

export type PngFrameSpec = {
  id: string;
  selector: string;
  width: number;
  height: number;
};

export type PngFrameBytes = {
  id: string;
  bytes: Buffer;
  width: number;
  height: number;
};

export type PngCaptureFn = (opts: {
  htmlAbs: string;
  frames: PngFrameSpec[];
}) => Promise<PngFrameBytes[]>;

export function pngRelPathsForHtml(htmlPath: string, count: number): string[] {
  const stem = String(htmlPath ?? "").replace(/\\/g, "/").replace(/\.html?$/i, "");
  const n = Math.max(0, Math.floor(count));
  if (n <= 0) return [];
  if (n === 1) return [`${stem}.png`];
  return Array.from({ length: n }, (_, i) => `${stem}-${i + 1}.png`);
}

export function parseCardSize(raw: string | undefined): { width: number; height: number } {
  const m = String(raw ?? "").trim().match(/^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i);
  if (!m) return { ...DEFAULT_CARD_SIZE };
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width < 16 || height < 16 || width > 4096 || height > 4096) {
    return { ...DEFAULT_CARD_SIZE };
  }
  return { width, height };
}

export function findPngFrames(html: string): PngFrameSpec[] {
  const frames: PngFrameSpec[] = [];
  const re = /<(article|section|div)\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const card = attr(tag, "data-card");
    const exp = attr(tag, "data-export");
    if (card == null && exp !== "png") continue;
    const id = (card && card.trim()) || String(frames.length + 1);
    const size = parseCardSize(attr(tag, "data-size"));
    frames.push({
      id,
      selector: card != null ? `[data-card="${cssAttr(id)}"]` : `[data-export="png"]`,
      width: size.width,
      height: size.height,
    });
  }
  return frames;
}

export function requirePngFrames(html: string): PngFrameSpec[] {
  const frames = findPngFrames(html);
  if (frames.length === 0) {
    throw new CardPngError(
      CARD_PNG_NO_FRAMES,
      "HTML 没有 [data-card] 方图契约，拒绝截图",
    );
  }
  return frames;
}

export const fixturePngCapture: PngCaptureFn = async ({ frames }) =>
  frames.map((frame) => ({
    id: frame.id,
    bytes: MINIMAL_PNG,
    width: frame.width,
    height: frame.height,
  }));

/**
 * 真实宿主用 Playwright 截契约卡。调用方必须在 finally 关浏览器——
 * Windows 上漏关会留 chromium 僵尸。
 */
export const capturePngFramesWithPlaywright: PngCaptureFn = async ({ htmlAbs, frames }) => {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new CardPngError(
      CARD_PNG_CAPTURE_UNAVAILABLE,
      "未安装截图运行时。仓库 devDependency 有 playwright，先跑 npx playwright install chromium",
    );
  }
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (err) {
      throw new CardPngError(
        CARD_PNG_CAPTURE_UNAVAILABLE,
        `无法启动 Chromium：${(err as Error).message}。先跑 npx playwright install chromium`,
      );
    }
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1280 },
      deviceScaleFactor: 1,
    });
    try {
      await page.goto(pathToFileURL(htmlAbs).href, { waitUntil: "load", timeout: 15_000 });
      const out: PngFrameBytes[] = [];
      for (const frame of frames) {
        const loc = page.locator(frame.selector).first();
        if ((await loc.count()) === 0) {
          throw new CardPngError(CARD_PNG_NO_FRAMES, `页面里找不到 ${frame.selector}`);
        }
        const buf = await loc.screenshot({ type: "png" });
        out.push({
          id: frame.id,
          bytes: Buffer.from(buf),
          width: frame.width,
          height: frame.height,
        });
      }
      return out;
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await browser?.close().catch(() => {});
  }
};

function attr(openTag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const m = openTag.match(re);
  return m?.[2] ?? m?.[3];
}

function cssAttr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// SVG 区域放大器(宿主视觉复核用):用 viewBox + width(cm/mm) 建立 mm 映射,裁出指定 mm 矩形为 PNG。
// 前置:kicad-cli pcb export svg --layers F.Cu,B.Cu,F.SilkS,Edge.Cuts --page-size-mode 2 -o board.svg x.kicad_pcb
//       (或 kicad-cli sch export svg);npm i 一次装 sharp。
// 用法: node zoom.mjs <svg> <outdir> name:x0,y0,x1,y1 [name:...]   PXMM=14 环境变量控制分辨率
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [svgPath, outDir, ...regions] = process.argv.slice(2);
const svg = readFileSync(svgPath, "utf8");
const vb = svg.match(/viewBox="([\d.\-]+) ([\d.\-]+) ([\d.]+) ([\d.]+)"/);
const wAttr = svg.match(/width="([\d.]+)(cm|mm)"/);
if (!vb || !wAttr) { console.error("no viewBox/width"); process.exit(1); }
const [vx, vy, vw, vh] = vb.slice(1).map(Number);
const mmW = parseFloat(wAttr[1]) * (wAttr[2] === "cm" ? 10 : 1);
const upm = vw / mmW;
const PX_PER_MM = Number(process.env.PXMM || 14);
const fullW = Math.round(mmW * PX_PER_MM);
const full = await sharp(Buffer.from(svg), { density: 300, limitInputPixels: false })
  .resize({ width: fullW }).flatten({ background: "#ffffff" }).png().toBuffer();
if (regions.length === 0) {
  await sharp(full).toFile(join(outDir, "full.png"));
  console.log("full.png");
}
for (const spec of regions) {
  const [name, box] = spec.split(":");
  const [x0, y0, x1, y1] = box.split(",").map(Number);
  const px0 = Math.max(0, Math.round(((x0 * upm - vx) / vw) * fullW));
  const py0 = Math.max(0, Math.round(((y0 * upm - vy) / vw) * fullW));
  const pw = Math.round(((x1 - x0) * upm / vw) * fullW);
  const ph = Math.round(((y1 - y0) * upm / vw) * fullW);
  await sharp(full).extract({ left: px0, top: py0, width: pw, height: ph }).toFile(join(outDir, `zoom-${name}.png`));
  console.log(`zoom-${name}.png`);
}
